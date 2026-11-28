/**
 * @file The CLI host's surface: interaction backed by readline and the local
 * terminal.
 *
 * This is the concrete {@link Surface} the command-line host installs. It
 * declares the full local capability set (hidden input, local editing, and a
 * tty when stdout is one) and backs prompting with readline. Two flavors of
 * prompt exist so the single-readline discipline is preserved: when the REPL
 * is running it passes its own persistent interface, and hidden input is read
 * by suppressing that interface's echo rather than opening a second one on the
 * same stdin; outside the REPL (execute and script modes) a one-shot interface
 * is created per prompt, matching the shell's historical fallback exactly.
 *
 * @module
 */
import * as readline from 'readline';
import chalk from 'chalk';
import { Writable } from 'stream';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'child_process';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Surface, SurfaceCapabilities, PromptRequest, LocalEditRequest, LocalEditResult } from '@fnndsc/brasa';
import { segment_pipeThrough, file_read, privateTemp_write, suffix_safe, type PrivateTemp } from '@fnndsc/brasa';
import { promptKind_derive, type FileDeliverRequest, type FileDeliverResult, type PromptKind } from '@fnndsc/menu';
import { deliveryPlace_resolve, type PlacedDelivery } from './deliveryPlace.js';
import { interrupt_pending, question_openSet, terminalState_mark, typeahead_clear, typeahead_take } from './lineDiscipline.js';

/**
 * The purpose a question carries when it asks the person whether a session may run something on this machine: it
 * is answered only by a line typed after it is shown, never by typed-ahead input.
 */
export const CONSENT_PURPOSE: string = 'chell.consent';

/**
 * What a typed line means, given what an empty one stands for.
 *
 * Enter takes the offer: a terminal that shows a default and then ignores
 * it has shown a decoration rather than an answer.
 *
 * @param said - What the operator typed.
 * @param fallback - The answer an empty line stands for.
 * @returns The answer to give the kernel.
 */
export function promptAnswer_take(said: string, fallback: string): string {
  const given: string = said.trim();
  return given === '' ? fallback : given;
}

/**
 * How a typed question reads on a terminal, and what an empty answer means.
 *
 * A terminal has one instrument — a line — so a location ask cannot borrow
 * a browser the way a graphical surface does. It offers its composed
 * default in brackets instead, and Enter takes the offer: the answer a
 * terminal commits is then the same answer an errand would have, without
 * either surface knowing about the other. A yes/no says which letters it
 * takes and defaults to nothing, because there is no safe guess.
 *
 * @param request - The question as the kernel asked it.
 * @returns The line to print, and the answer an empty line stands for.
 */
export function promptLine_render(request: PromptRequest): { message: string; fallback: string } {
  const kind: PromptKind = promptKind_derive(request);
  if (kind === 'confirm') {
    return { message: `${request.message}(y/n) `, fallback: '' };
  }
  if (kind !== 'path') {
    return { message: request.message, fallback: '' };
  }
  // The anchor says where to LOOK; the suggestion says what to OFFER. A
  // question with nowhere to browse but nothing to propose gets no default,
  // because the alternative is offering the anchor itself — which for a
  // move is the folder the file is already in, and Enter would then move
  // it onto itself.
  const suggest: string | undefined = request.path?.suggest;
  if (suggest === undefined) return { message: request.message, fallback: '' };
  const anchor: string | undefined = request.path?.anchor;
  const composed: string = anchor === undefined
    ? suggest
    : `${anchor.replace(/\/$/, '')}/${suggest}`;
  return { message: `${request.message}[${composed}] `, fallback: composed };
}

/**
 * Prompts on a persistent readline interface (the REPL's), suppressing echo
 * for hidden input by intercepting the interface's own output hook. This
 * keeps a single readline interface on stdin — no raw mode, no second
 * interface, no keystrokes leaking back to the command loop.
 *
 * @param rl - The REPL's readline interface.
 * @param request - The prompt message and whether to hide input.
 * @returns The entered line, trimmed.
 */
function persistentPrompt_ask(rl: readline.Interface, request: PromptRequest): Promise<string> {
  if (!request.hidden) {
    const shown: { message: string; fallback: string } = promptLine_render(request);
    // A line typed while the command ran is this question's answer, as a
    // terminal hands typed-ahead input to whatever reads next. A secret is
    // never answered that way: it is typed when it is asked for. Nor is the
    // person's word for what a session may run here: only a line typed after
    // the question is shown answers it, and what was typed ahead is dropped.
    if (request.purpose === CONSENT_PURPOSE) {
      typeahead_clear();
    } else {
      const ahead: string | undefined = typeahead_take();
      if (ahead !== undefined) {
        process.stdout.write(`${shown.message}${ahead}\n`);
        return Promise.resolve(promptAnswer_take(ahead, shown.fallback));
      }
    }
    question_openSet(true);
    terminalState_mark('asking');
    return new Promise((resolve: (answer: string) => void, reject: (error: Error) => void) => {
      // Ctrl-C at a question abandons it, as Esc does in the transcript: the
      // command that asked is told, and ends, rather than waiting on a line
      // nobody will type.
      const abandon: AbortController = new AbortController();
      const onInterrupt = (): void => {
        question_openSet(false);
        terminalState_mark('busy');
        process.stdout.write('\n');
        abandon.abort();
        reject(new Error('the operator abandoned the question'));
      };
      rl.once('SIGINT', onInterrupt);
      // Withdrawn by whoever asked (its line ended): the question goes, and so does its answer.
      const question_withdraw = (): void => {
        rl.off('SIGINT', onInterrupt);
        question_openSet(false);
        terminalState_mark('busy');
        process.stdout.write('\n');
        abandon.abort();
        reject(new Error('the question was withdrawn'));
      };
      if (request.signal?.aborted === true) {
        question_withdraw();
        return;
      }
      request.signal?.addEventListener('abort', question_withdraw, { once: true });
      rl.question(shown.message, { signal: abandon.signal }, (answer: string) => {
        request.signal?.removeEventListener('abort', question_withdraw);
        rl.off('SIGINT', onInterrupt);
        question_openSet(false);
        terminalState_mark('busy');
        resolve(promptAnswer_take(answer, shown.fallback));
      });
    });
  }

  // `_writeToOutput` is readline's internal echo hook, absent from its
  // typings; replacing it is the supported folk technique for hidden input.
  const originalWrite: unknown = Reflect.get(rl, '_writeToOutput');
  Reflect.set(rl, '_writeToOutput', (_str: string): void => { /* suppress echo */ });

  terminalState_mark('asking');
  return new Promise((resolve: (answer: string) => void) => {
    rl.question('', (answer: string) => {
      Reflect.set(rl, '_writeToOutput', originalWrite);
      // readline keeps every line it reads for recall, a hidden one included:
      // a secret is taken out again, so the up arrow never brings it back.
      const recall: unknown = Reflect.get(rl, 'history');
      if (answer !== '' && Array.isArray(recall) && recall[0] === answer) recall.shift();
      terminalState_mark('busy');
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    // readline redraws when question() activates. Print the label afterward so
    // that redraw cannot immediately erase the password prompt.
    process.stdout.write(request.message);
  });
}

/** Why a question asked on an input that has ended fails. */
export const INPUT_ENDED_REASON: string = 'no input to answer the question: standard input is closed';

/**
 * Whether an input stream has ended, so nothing more can be read from it.
 *
 * @param input - The stream.
 * @returns True once it has ended or been destroyed.
 */
function input_ended(input: NodeJS.ReadableStream): boolean {
  const stream: { readableEnded?: boolean; destroyed?: boolean } = input as { readableEnded?: boolean; destroyed?: boolean };
  return stream.readableEnded === true || stream.destroyed === true;
}

/**
 * Asks one question on a readline interface made for it, and fails, rather
 * than waits, when the input ends before a line is typed: an attached
 * surface run with its input closed (`docker exec` without `-i`, a pipe that
 * ran dry) has no one to answer, and the command that asked is told so.
 *
 * @param rl - The interface, made for this one question.
 * @param message - The line to print.
 * @param done - What to do with the line typed, before it is resolved.
 * @returns The line typed.
 */
function oneShotLine_read(rl: readline.Interface, message: string, done: () => void): Promise<string> {
  return new Promise((resolve: (answer: string) => void, reject: (error: Error) => void) => {
    let answered: boolean = false;
    rl.once('close', (): void => {
      if (answered) return;
      // The question's line ends here, so what the command says next starts on a line of its own.
      process.stdout.write('\n');
      reject(new Error(INPUT_ENDED_REASON));
    });
    rl.question(message, (answer: string): void => {
      answered = true;
      done();
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompts on a one-shot readline interface created for this call, used
 * outside the REPL (execute and script modes). Hidden input is read through
 * a muted output stream so the entry is not echoed. An input that has
 * ended, or ends before a line is typed, fails the question.
 *
 * @param request - The prompt message and whether to hide input.
 * @param input - Where the answer is read; the process's standard input by default.
 * @returns The entered line, trimmed.
 * @throws {Error} When the input has ended, or ends before a line is typed.
 */
export async function oneShotPrompt_ask(request: PromptRequest, input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  if (input_ended(input)) {
    process.stdout.write(`${request.message}\n`);
    throw new Error(INPUT_ENDED_REASON);
  }
  if (!request.hidden) {
    const shown: { message: string; fallback: string } = promptLine_render(request);
    const rl: readline.Interface = readline.createInterface({ input, output: process.stdout });
    // Withdrawn by whoever asked: the interface closes and the question fails.
    request.signal?.addEventListener('abort', (): void => { rl.close(); }, { once: true });
    const answer: string = await oneShotLine_read(rl, shown.message, (): void => undefined);
    return promptAnswer_take(answer, shown.fallback);
  }

  const muted: Writable = new Writable({
    write(_chunk: unknown, _encoding: unknown, callback: () => void): void {
      callback();
    },
  });
  const rl: readline.Interface = readline.createInterface({ input, output: muted, terminal: true });
  process.stdout.write(request.message);
  const secret: string = await oneShotLine_read(rl, '', (): void => { process.stdout.write('\n'); });
  return secret.trim();
}

/**
 * Opens content in the local `$EDITOR` and returns the edited result. Writes
 * the content to a temp file, launches the editor against it, reads it back,
 * and removes the temp file — the whole editor lifecycle is the surface's
 * business, so builtins never touch a process or a terminal.
 *
 * @param request - The content to edit and an optional extension.
 * @returns The edited content and whether it changed.
 * @throws {Error} When the editor fails to launch.
 */
function localEdit_run(request: LocalEditRequest): Promise<LocalEditResult> {
  // The copy the editor opens is in a folder of its own only this account can open (0700), created anew and 0600;
  // a suffix the daemon asks for is kept only when it is a plain one, so the name cannot leave that folder.
  const temp: PrivateTemp = privateTemp_write('chell-edit-', `edit${suffix_safe(request.extension, '.txt')}`, request.content);
  const tmpPath: string = temp.path;
  try {
    const editor: string = process.env.EDITOR || process.env.VISUAL || 'vi';
    const spawn: SpawnSyncReturns<Buffer> = spawnSync(editor, [tmpPath], { stdio: 'inherit' });
    if (spawn.error) {
      throw new Error(`failed to launch '${editor}': ${spawn.error.message}`);
    }
    const edited: string = readFileSync(tmpPath, 'utf8');
    return Promise.resolve({ content: edited, changed: edited !== request.content });
  } finally {
    temp.folder_remove();
  }
}

/**
 * Runs a host-shell command on this CLI machine with direct terminal access.
 *
 * @param command - The shell command without the leading `!`.
 * @returns The child process exit code.
 */
function shellCommand_run(command: string): Promise<number> {
  // Ctrl-C pressed before the daemon asked for this shell: the command was
  // stopped, so its shell is not started.
  if (interrupt_pending()) return Promise.resolve(130);
  return new Promise((resolve: (exitCode: number) => void, reject: (error: Error) => void) => {
    // The child owns the terminal while it runs: whoever reads keys here
    // (readline, the interrupt watcher) is set aside and the terminal left
    // cooked, so a full-screen program (vi, less, top) gets its keys and
    // Ctrl-C reaches it as a signal. This shell ignores that signal meanwhile.
    const input: NodeJS.ReadStream = process.stdin;
    const keyed: Array<(...args: unknown[]) => void> = input.listeners('keypress') as Array<(...args: unknown[]) => void>;
    const fed: Array<(...args: unknown[]) => void> = input.listeners('data') as Array<(...args: unknown[]) => void>;
    const wasRaw: boolean = input.isTTY === true && input.isRaw === true;
    input.removeAllListeners('keypress');
    input.removeAllListeners('data');
    input.pause();
    if (input.isTTY === true) input.setRawMode(false);
    const ignore = (): void => undefined;
    process.on('SIGINT', ignore);
    const settle = (): void => {
      process.off('SIGINT', ignore);
      if (input.isTTY === true) input.setRawMode(wasRaw);
      for (const listener of fed) input.on('data', listener);
      for (const listener of keyed) input.on('keypress', listener);
      input.resume();
    };
    const child: ChildProcess = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', (error: Error): void => { settle(); reject(error); });
    child.once('close', (code: number | null): void => { settle(); resolve(code ?? 1); });
  });
}

/**
 * How a surface obtains the bytes of a file it has been asked to deliver.
 *
 * @param path - The path in the session's namespace.
 * @returns The file's bytes.
 */
export type BytesFetch = (path: string) => Promise<Buffer>;


/**
 * Writes a delivered file to this machine's disk.
 *
 * The destination is resolved here, on the surface's machine, which is the
 * whole point: the engine may be hosted anywhere, and a daemon must never
 * write to its own disk on an operator's behalf.
 *
 * @param request - What to deliver and where the operator asked for it.
 * @param bytes_fetch - How to obtain the file's bytes.
 * @returns The absolute path written and the byte count.
 * @throws {Error} When the name is refused, the bytes cannot be read or the write fails.
 */
async function fileDeliver_run(
  request: FileDeliverRequest,
  bytes_fetch: BytesFetch,
): Promise<FileDeliverResult> {
  // The place a remote engine reserved for this file is the one written; otherwise resolved here, the same way.
  const target: string = (request as PlacedDelivery).place ?? deliveryPlace_resolve(request.destination, request.filename);
  const bytes: Buffer = await bytes_fetch(request.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return { location: target, bytes: bytes.length };
}

/**
 * Creates the CLI host's surface.
 *
 * @param rl - The REPL's persistent readline interface, when running
 *   interactively. Omitted in execute and script modes, where each prompt
 *   uses a one-shot interface.
 * @param bytes_fetch - How this surface obtains a file's bytes. The default
 *   reads through the in-process engine, which is right for a local shell; a
 *   remote client supplies a fetch against its daemon's byte route, because
 *   its engine is on another machine.
 * @returns A surface backed by the local terminal.
 */
export function cliSurface_create(
  rl?: readline.Interface,
  bytes_fetch: BytesFetch | undefined = file_read,
): Surface {
  // A local shell hosts the engine in its own process (no byte fetch of its own, or the plain file read).
  const ownMachine: boolean = bytes_fetch === undefined || bytes_fetch === file_read;
  const capabilities: SurfaceCapabilities = {
    hiddenInput: true,
    localEdit: true,
    tty: !!process.stdout.isTTY,
    // chalk answers for the terminal it is writing to: >0 is some colour.
    color: chalk.level > 0,
    pipeSegments: true,
    shellCommands: true,
    fileDelivery: true,
    // A local shell hosts the engine in its own process, so a path the engine
    // resolves is a path the operator can open. A remote client supplies a
    // byte fetch precisely because that is not true for it.
    engineFilesystem: ownMachine,
    // The same holds for programs: a local shell starts them on its operator's own machine.
    engineProcesses: ownMachine,
    // Remote or not, a shell has a disk and directories. Asked for a folder it
    // should get a folder, not an archive of one.
    localFilesystem: true,
  };

  return {
    capabilities,
    prompt(request: PromptRequest): Promise<string> {
      return rl ? persistentPrompt_ask(rl, request) : oneShotPrompt_ask(request);
    },
    pipeSegment(command: string, input: Buffer): Promise<Buffer> {
      // The local CLI runs pipe segments in-process, exactly as before.
      return segment_pipeThrough(command, input);
    },
    shellCommand(command: string): Promise<number> {
      return shellCommand_run(command);
    },
    localEdit(request: LocalEditRequest): Promise<LocalEditResult> {
      return localEdit_run(request);
    },
    fileDeliver(request: FileDeliverRequest): Promise<FileDeliverResult> {
      return fileDeliver_run(request, bytes_fetch ?? file_read);
    },
  };
}
