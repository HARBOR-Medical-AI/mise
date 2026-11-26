/**
 * @file REPL Logic.
 *
 * The CLI host around the chell engine: a readline loop that reads lines,
 * hands them to the engine, and owns the terminal-facing concerns (prompt,
 * history, output sink, interactive questions).
 *
 * @module
 */
import * as readline from 'readline';
import * as fs from 'fs';
import chalk from 'chalk';
import { session } from '@fnndsc/brasa';
import { settings } from '../config/settings.js';
import { history_appendPrivate, history_readPrivate, historyFile_resolve, historyLine_redact, recall_accept } from './history.js';
import { sessionPrompt_render } from './prompt/session.js';
import { surface_set } from '@fnndsc/brasa';
import { cliSurface_create, type BytesFetch } from './cliSurface.js';
import { sink_set, StdoutSink } from '@fnndsc/brasa';
import { TerminalProgressRenderer } from './progressRenderer.js';
import { surfaceLine_executeSafely } from './surfaceDispatch.js';
import { game_play, gameShow_find, gameTerminal_is, type GameShow } from './gamePlayer.js';
import { promptGuard_create, type PromptGuard } from './promptGuard.js';
import { interrupt_set, lineRedraw_set, question_isOpen, terminalState_mark, typeahead_clear, typeahead_push, typeahead_take } from './lineDiscipline.js';
import type { BrasaEngine, CompletionResult } from '@fnndsc/brasa';

/**
 * Handles the Read-Eval-Print Loop (REPL) interaction.
 */
/**
 * Options for the REPL host.
 *
 * @property promptText - A prompt to display instead of the locally-rendered
 *   themed prompt: a fixed string, or a provider called on each redraw. The
 *   remote client passes a provider that returns the latest prompt string the
 *   daemon pushed, so a remote surface shows the same themed prompt as a local
 *   session.
 */
export interface ReplOptions {
  promptText?: string | (() => string);
  /**
   * How this session's surface obtains a file's bytes when asked to deliver
   * one. Defaults to reading through the in-process engine, which is right for
   * a local shell; a remote client passes a fetch against its daemon, because
   * its engine is on another machine.
   */
  bytesFetch?: BytesFetch;
}

/**
 * Handles the Read-Eval-Print Loop (REPL) interaction.
 */

/** How long after a raw Ctrl-C readline's own SIGINT is taken as the same press. */
const RAW_INTERRUPT_WINDOW_MS: number = 200;
export class REPL {
  private rl: readline.Interface;
  private engine: BrasaEngine;
  private isOpen: boolean = true;
  /** Whether a command is in flight: lines typed meanwhile wait (lineDiscipline.ts). */
  private busy: boolean = false;
  /** When the raw watcher last stopped a command on Ctrl-C. */
  private rawInterruptAt: number = 0;
  /** True once the history could not be shown private: it is then neither read nor written for the session. */
  private historyUnkept: boolean = false;
  /** Draws progress for the command in flight; cleared when it ends. */
  private readonly progressRenderer: TerminalProgressRenderer = new TerminalProgressRenderer();
  private lastCommandDurationMs: number = 0;
  private lastExitCode: number = 0;
  private promptText: string | (() => string) | undefined;
  private readonly bytesFetch: BytesFetch | undefined;
  /**
   * Keeps a stray write — another surface's output pushed by the daemon, a
   * warm-up settling late — from landing across the idle prompt. Engaged
   * once the prompt is drawn, released before a command's output starts.
   */
  private readonly guard: PromptGuard<NodeJS.WriteStream>;

  /**
   * Initializes the REPL interface around an engine.
   *
   * @param engine - The engine that executes lines and answers completions.
   * @param options - Optional host settings (e.g. a fixed prompt string).
   */
  constructor(engine: BrasaEngine, options?: ReplOptions) {
    this.engine = engine;
    this.promptText = options?.promptText;
    this.bytesFetch = options?.bytesFetch;
    this.guard = promptGuard_create(process.stdout, (): void => {
      try {
        this.rl.prompt(true);
      } catch {
        // Interface might be closed.
      }
    });
    this.rl = readline.createInterface({
      input: process.stdin,
      // readline draws through the guard's own output, so the prompt's paint
      // is never taken for a stray line.
      output: this.guard.output,
      terminal: process.stdout.isTTY === true,
      prompt: '> ',
      completer: (line: string, callback: (err: Error | null, result: [string[], string]) => void): void => {
        this.engine.line_complete(line)
          .then((result: CompletionResult) => callback(null, [result.candidates, result.prefix]))
          // Deliberate absorption, adjudicated 2026-08: a completion failure
          // degrades to no candidates; surfacing it would corrupt the
          // readline display mid-keystroke.
          .catch(() => callback(null, [[], line]));
      },
    });
  }

  /**
   * Starts the REPL loop, executing each input line through the engine.
   */
  async start(): Promise<void> {
    // The REPL is the host that owns the interaction channels: command output
    // reaches the terminal through the sink it installs, and interactive
    // prompts run through the surface it installs — both backed by the REPL's
    // single readline interface, so builtins never assume a terminal exists.
    sink_set(new StdoutSink(this.progressRenderer));
    surface_set(cliSurface_create(this.rl, this.bytesFetch));

    await this.history_load();
    await this.prompt_update();
    // Output arriving on its own (another surface's command) redraws what the
    // operator is typing into: the prompt at rest, or an open question. While
    // a command prints and asks nothing, there is nothing to redraw.
    lineRedraw_set((): void => {
      if (this.busy && !question_isOpen()) return;
      try {
        this.rl.prompt(true);
      } catch {
        // The interface has closed.
      }
    });

    this.rl.on('line', (line: string): void => {
      // readline has already kept the line as typed: its recall takes the kept form now, as the line is
      // accepted, whether it runs at once, waits behind a running command, or is thrown away unrun.
      recall_accept(Reflect.get(this.rl, 'history'), line);
      void this.line_receive(line);
    });

    // While a command runs, Ctrl-C is read from the raw bytes, ahead of
    // readline's key decoder: a host program's output can make the terminal
    // answer queries into this input, and a half-read reply would swallow
    // the interrupt. The command is stopped (the daemon abandons one that
    // does not end); readline's own SIGINT then has nothing left to do.
    process.stdin.prependListener('data', (chunk: Buffer | string): void => {
      if (!this.busy || question_isOpen() || !chunk.toString().includes('\u0003')) return;
      this.rawInterruptAt = Date.now();
      interrupt_set(true);
      typeahead_clear();
      this.engine.line_cancel?.();
    });

    this.rl.on('SIGINT', () => {
      // The raw watcher above already stopped the running command.
      if (Date.now() - this.rawInterruptAt < RAW_INTERRUPT_WINDOW_MS) return;
      // A cancellable foreground command (currently recursive scans) gets the
      // interrupt first. Otherwise Ctrl+C retains readline's usual behavior:
      // clear an unfinished input line and redraw the prompt. Either way,
      // what was typed ahead is forgotten, as a terminal's interrupt does.
      typeahead_clear();
      // A question open takes its own interrupt: it is abandoned (cliSurface.ts).
      if (question_isOpen()) return;
      this.guard.write('\n');
      if (this.engine.line_cancel?.()) {
        return;
      }
      readline.clearLine(process.stdout, 0);
      this.prompt_update();
    });

    this.rl.on('close', () => {
      this.isOpen = false;
      this.guard.release();
      console.log(chalk.cyan('Exiting ChELL. Goodbye!'));
      process.exit(0);
    });
  }

  /**
   * Takes a typed line. While a command is in flight the line waits, in
   * order (lineDiscipline.ts): a question takes it as an answer, or it runs
   * once the command finishes, as a terminal hands typed-ahead input to
   * whatever reads next.
   *
   * @param line - The line typed.
   */
  private async line_receive(line: string): Promise<void> {
    if (this.busy) {
      typeahead_push(line);
      return;
    }
    this.busy = true;
    try {
      let next: string | undefined = line;
      while (next !== undefined) {
        if (!(await this.line_run(next))) return;
        next = typeahead_take();
      }
    } finally {
      this.busy = false;
    }
    if (this.isOpen) {
      await this.prompt_update();
    }
  }

  /**
   * Runs one line as a command.
   *
   * @param line - The line.
   * @returns False when the line ended the shell (`exit`).
   */
  private async line_run(line: string): Promise<boolean> {
    // The line is the command's now; its output flows raw.
    this.guard.release();
    // Marked once the guard is down: anything written while the prompt is
    // painted is a stray line to the guard, which paints the prompt again.
    terminalState_mark('busy');
    await this.history_append(line);

    // `exit` quits this shell, never the engine. Closing readline runs the
    // 'close' handler (goodbye, then process exit). Crucially, for a remote
    // surface this detaches the client and leaves the daemon — and its other
    // surfaces — running; forwarding `exit` to the engine would instead reach
    // dispatch's process.exit on the daemon and tear every surface down.
    if (line.trim().split(/\s+/)[0] === 'exit') {
      this.rl.close();
      return false;
    }

    const startMs: number = Date.now();
    process.exitCode = 0;
    interrupt_set(false);
    const envelopes = await surfaceLine_executeSafely(this.engine, line);
    // A showpiece or a game the kernel named plays here, on this terminal.
    const show: GameShow | null = gameShow_find(envelopes);
    if (show !== null && gameTerminal_is()) await game_play(show);
    // Progress is telemetry about a running command, so nothing may outlive
    // the command. A builtin that throws between announcing work and closing
    // it would otherwise leave an indicator running against nothing.
    this.progressRenderer.clear();
    this.lastCommandDurationMs = Date.now() - startMs;
    this.lastExitCode = (process.exitCode as number | undefined) ?? 0;
    return true;
  }

  /**
   * Updates and redisplays the prompt based on current session state.
   */
  async prompt_update(): Promise<void> {
    if (!this.isOpen) return;

    // An injected prompt (the remote client) skips local context rendering:
    // the session lives in the daemon, not this process. It may be a fixed
    // string or a provider returning the latest daemon-pushed prompt.
    if (this.promptText !== undefined) {
      const text: string = typeof this.promptText === 'function' ? this.promptText() : this.promptText;
      this.rl.setPrompt(text);
      try {
        // Marked before the prompt is painted, so the guard never sees it.
      if (!this.busy) terminalState_mark('idle');
      this.rl.prompt();
      } catch (e: unknown) {
        // Interface might be closed
      }
      this.guard.engage();
      return;
    }

    const rendered: string = await sessionPrompt_render({
      lastExitCode: this.lastExitCode,
      lastCommandDurationMs: this.lastCommandDurationMs,
    });
    this.rl.setPrompt(rendered);
    try {
      // Marked before the prompt is painted, so the guard never sees it.
      if (!this.busy) terminalState_mark('idle');
      this.rl.prompt();
    } catch (e: unknown) {
      // Interface might be closed
    }
    this.guard.engage();
  }

  /**
   * Loads the history into the reader's recall, each line as the history
   * keeps it. A history that cannot be shown private is not read, and the
   * operator is told once why it is not kept.
   */
  private async history_load(): Promise<void> {
    try {
      const lines: string[] = await history_readPrivate(historyFile_resolve(settings.config.historyFile));
      // `history` is a runtime readline property its typings do not declare.
      Reflect.set(this.rl, 'history', lines.reverse().slice(0, settings.config.historySize));
    } catch (error: unknown) {
      this.historyUnkept_say(error);
    }
  }

  /**
   * Appends a line to the history file, as the history keeps it. A line
   * that must not be kept is not written; a history that cannot be shown
   * private is not written to.
   *
   * @param line - The line as typed.
   */
  private async history_append(line: string): Promise<void> {
    if (!line.trim() || this.historyUnkept) return;
    const kept: string | null = historyLine_redact(line);
    if (kept === null) return;
    try {
      await history_appendPrivate(historyFile_resolve(settings.config.historyFile), kept);
    } catch (error: unknown) {
      this.historyUnkept_say(error);
    }
  }

  /**
   * Says, once, that the history is not being kept and why, and stops trying.
   *
   * @param error - What stood in the way.
   */
  private historyUnkept_say(error: unknown): void {
    if (this.historyUnkept) return;
    this.historyUnkept = true;
    process.stderr.write(`${chalk.yellow(`chell: this session's history is not kept: ${error instanceof Error ? error.message : String(error)}`)}\n`);
  }
}
