/**
 * @file The indwelling console: a DOM terminal in the ARGUS prototype's
 * tradition.
 *
 * Not a character-grid emulator: the console is a styled document, exactly
 * as the original ARGUS prototype built it. A native `<input>` carries the
 * command line (free cursor movement, selection, IME), an HTML transcript
 * carries the session's rendered stream (ANSI converted to styled spans by
 * `ansi.ts`), and a Powerlevel10k-style segment bar renders the prompt
 * context the daemon pushes. Line history, tab completion (through the
 * wire's `complete` request), and typeahead queueing are native here, the
 * things a grid emulator made hard.
 *
 * @module
 */
import { ansi_renderHtml, html_escape } from './ansi.js';
import { type ProcPromptState, type PromptContext, type WireEnvelope } from '@fnndsc/menu';
import { promptBar_render, type SegmentColor } from './promptBar.js';
import type { ExecuteOutcome, OutputChannel } from '../calypso/client.js';

/** A completion answer from the wire: candidates and the prefix they complete. */
export interface CompletionAnswer {
  candidates: string[];
  prefix: string;
}

/**
 * The prompt segment palette, mirroring chell's Powerlevel10k theme
 * (`packages/chell/src/core/prompt/palette.ts`) so the browser console and
 * the CLI surface read as one family. Duplicated by value because argus may
 * not import the execution stack.
 */
const SEGMENT_PALETTE: Record<
  'pacs' | 'host' | 'user' | 'dir' | 'physical' | 'duration' | 'status' | 'time',
  SegmentColor
> = {
  pacs: { bg: '#875FFF', fg: '#FFFFFF' },
  host: { bg: '#00AFFF', fg: '#001018' },
  user: { bg: '#00D787', fg: '#00140C' },
  dir: { bg: '#FFD75F', fg: '#201800' },
  physical: { bg: '#FF5F5F', fg: '#1B0000' },
  duration: { bg: '#FF8700', fg: '#201000' },
  status: { bg: '#FF005F', fg: '#FFFFFF' },
  time: { bg: '#5F5F87', fg: '#FFFFFF' },
};

/**
 * Presentation for each process-index state, mirroring chell's p10k theme:
 * cold indexing on the duration orange, cached reconciliation on the time
 * violet, failure on the status red.
 */
const PROC_STATE_SEGMENTS: Record<ProcPromptState, { icon: string; label: string; color: SegmentColor }> = {
  cold: { icon: '\uf2dc', label: 'proc cold', color: { bg: '#FF8700', fg: '#201000' } },
  cached: { icon: '\uf021', label: 'proc cached, refreshing', color: { bg: '#5F5F87', fg: '#FFFFFF' } },
  failed: { icon: '\uf071', label: 'proc failed', color: { bg: '#FF005F', fg: '#FFFFFF' } },
};

/**
 * Powerline separator and Font Awesome glyphs, from the bundled Nerd Font.
 *
 * Written as `\u` escapes rather than literal characters: these live in the
 * Private Use Area, and a literal copy is one careless re-encoding away from
 * becoming an empty string — which renders as a prompt with no separators and
 * no icons, exactly as if the font had failed to load. The values match
 * chell's p10k theme (`packages/chell/src/core/prompt/theme_p10k.ts`) so the
 * two surfaces read as one family.
 */
const GLYPHS = {
  powerline: '\ue0b0',
  cube: '\uf1b2',
  database: '\uf1c0',
  user: '\uf007',
  folder: '\uf07c',
  microscope: '\uf610',
  bolt: '\uf0e7',
  error: '\uf057',
  cloud: '\uf0c2',
  globe: '\uf0ac',
  sitemap: '\uf0e8',
} as const;

/** How many submitted lines the arrow-key history retains. */
const HISTORY_LIMIT: number = 200;


/**
 * What kind of value a question wants, as the console renders it.
 *
 * Mirrors the wire's own kinds; a surface that meets one it does not know
 * has already had it degraded to `text` by the contract, so this is the
 * complete set.
 */
export type AskKind = 'text' | 'secret' | 'confirm' | 'path';

/**
 * A question put to the operator.
 *
 * @property message - The question's own words.
 * @property kind - What kind of value answers it.
 * @property suggest - A value to offer, for a kind that has one.
 */
export interface AskRequest {
  message: string;
  kind: AskKind;
  suggest?: string;
  /** Whether the input line takes focus; false when the question also stands on a pane, whose field has it. */
  focus?: boolean;
}

/**
 * The ARGUS console: transcript, prompt bar, and input line in one screen.
 *
 * @example
 * ```
 * const terminal = new ArgusTerminal(container, submit_handle, complete_ask);
 * terminal.promptContext_set(context);
 * terminal.prompt_draw();
 * ```
 */
/** A terminal console standing in for the transcript: what the transcript hands it. */
export interface ConsoleDelegate {
  /** A line of this surface's own (an echo, a note, output, a result) for the terminal. */
  note: (text: string) => void;
  /** A line put on the terminal's prompt, unrun. */
  offer: (line: string) => void;
  /** The keyboard. */
  focus: () => void;
  /** The pane changed size. */
  fit: () => void;
}

export class ArgusTerminal {
  private readonly output: HTMLElement;

  /** Empties the transcript (`clear`): its record goes, the prompt stays. */
  public clear(): void {
    this.output.replaceChildren();
  }
  /** The splash's greeting column, once a splash is written. */
  private splashGreeting: HTMLDivElement | null = null;
  /** Live progress rows, between the transcript and the prompt. */
  private readonly progressRegion: HTMLElement;
  private readonly promptBar: HTMLElement;
  private readonly inputGlyph: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly submit: (line: string) => Promise<void>;
  private readonly complete: (prefix: string) => Promise<CompletionAnswer>;
  private promptContext: PromptContext | null = null;
  private busy: boolean = true;
  /** The terminal console standing in for this transcript, or null while the transcript is the console. */
  private delegate: ConsoleDelegate | null = null;
  /** The unfinished line the mirror holds until it closes. */
  private mirrorPending: string = '';
  /** The element the console lives in; it wears `data-busy` while a command runs. */
  private readonly container: HTMLElement;
  /**
   * The question the session is waiting on, if any.
   *
   * While one is open the input answers it rather than running commands:
   * an operator asked for a password should not have it dispatched as a
   * line, and a queued line should not jump ahead of the answer.
   */
  private pendingAsk: { settle: (answer: string | null) => void; kind: AskKind } | null = null;
  private readonly queuedLines: string[] = [];
  /**
   * Whether a question is standing somewhere on the surface.
   *
   * A question occupies the PROMPT, not the session. While one was open
   * the console stayed busy, so every verb that lowers to a visible line
   * queued behind an answer that had not been given — the errand's own
   * MKDIR could never run, since the question it served was what blocked
   * it, and the browser's MKDIR read as dead while its listing kept
   * refreshing on the silent channel. A verb the operator pressed goes
   * around the question instead: echoed as always, dispatched at once.
   */
  private questionOpen: boolean = false;
  private readonly history: string[] = [];
  private historyIndex: number = 0;
  private streamBlock: HTMLElement | null = null;
  /** The trailing element holding the not-yet-completed stream line. */
  private streamPendingElement: HTMLElement | null = null;
  /** Raw text of the current stream line, rewound by `\r` and cleared by `\n`. */
  private streamPendingText: string = '';
  /** The channel that opened the current stream line, for its styling. */
  private streamPendingChannel: OutputChannel = 'data';

  /**
   * Builds the console into a container and wires its input events.
   *
   * @param container - The DOM element the console renders into.
   * @param submit - Handles one submitted line; the console queues further
   *   lines until the returned promise settles.
   * @param complete - Answers a tab-completion request for a line prefix.
   */
  constructor(
    container: HTMLElement,
    submit: (line: string) => Promise<void>,
    complete: (prefix: string) => Promise<CompletionAnswer>,
  ) {
    this.submit = submit;
    this.complete = complete;
    this.container = container;
    container.innerHTML = `
      <div class="argus-screen">
        <div class="argus-output"></div>
        <div class="argus-progress"></div>
        <div class="argus-prompt-bar"></div>
        <div class="argus-input-line">
          <span class="argus-input-glyph">❯</span>
          <input type="text" autocomplete="off" spellcheck="false" aria-label="console input" />
        </div>
      </div>`;
    this.output = element_query(container, '.argus-output');
    this.progressRegion = element_query(container, '.argus-progress');
    this.promptBar = element_query(container, '.argus-prompt-bar');
    this.inputGlyph = element_query(container, '.argus-input-glyph');
    this.input = element_query(container, 'input') as HTMLInputElement;
    this.busy_set(true);

    container.addEventListener('click', (): void => this.input.focus());
    this.input.addEventListener('keydown', (event: KeyboardEvent): void => this.key_handle(event));
  }

  /**
   * The element live progress rows render into.
   *
   * @returns The console's progress region.
   */
  public progressRegion_get(): HTMLElement {
    return this.progressRegion;
  }

  /** Scrolls the transcript to its end (called after drawer resizes too). */
  public size_fit(): void {
    if (this.delegate !== null) this.delegate.fit();
    this.output.scrollTop = this.output.scrollHeight;
  }

  /** Focuses the input so keystrokes land in the session. */
  public focus_take(): void {
    if (this.delegate !== null) {
      this.delegate.focus();
      return;
    }
    this.input.focus();
  }

  /**
   * Stores the freshest prompt context pushed by the daemon.
   *
   * @param context - The engine-known prompt facts.
   */
  public promptContext_set(context: PromptContext): void {
    this.promptContext = context;
    // An idle console repaints immediately: warm-up pushes arrive between
    // commands, and the percentage should climb without an Enter press. A
    // busy console leaves the bar to prompt_draw, which owns the unlock.
    if (!this.busy) {
      this.promptBar.innerHTML = this.promptSegments_render();
    }
  }

  /**
   * Whether a command is running, declared on the console's element as
   * `data-busy` so the state can be seen and waited on from outside: a
   * line typed while busy queues behind the prompt, and nothing on the
   * surface said so (#919).
   *
   * @param on - True from a line's submit until its prompt returns.
   */
  private busy_set(on: boolean): void {
    this.busy = on;
    this.container.dataset['busy'] = on ? 'true' : 'false';
  }

  /**
   * Redraws the prompt bar from the stored context, unlocks input, and
   * drains any typeahead-queued line.
   */
  public prompt_draw(): void {
    this.stream_close();
    this.promptBar.innerHTML = this.promptSegments_render();
    const exitOk: boolean = (this.promptContext?.lastExitCode ?? 0) === 0;
    this.inputGlyph.style.color = exitOk ? '#00D787' : '#FF005F';
    this.busy_set(false);
    const queued: string | undefined = this.queuedLines.shift();
    if (queued !== undefined) {
      this.line_run(queued);
    }
    this.size_fit();
  }

  /**
   * Writes greeting lines above the first prompt.
   *
   * @param lines - The lines to write (may carry ANSI color).
   */
  public banner_write(lines: string[]): void {
    for (const line of lines) {
      this.block_append('argus-banner-line', ansi_renderHtml(line));
    }
  }

  /**
   * Writes the splash: the brain at rest, small, with room beside it for
   * the session's greeting. One block, two columns, sized to fit the
   * console's few visible rows — a brain written as twenty-five transcript
   * lines scrolled itself out of sight before the greeting arrived, which
   * made a splash nobody saw.
   *
   * @param brainLines - The art's lines (ANSI colour).
   */
  public splash_write(brainLines: string[]): void {
    const splash: HTMLDivElement = document.createElement('div');
    splash.className = 'argus-line argus-splash';
    const brain: HTMLPreElement = document.createElement('pre');
    brain.className = 'argus-splash-brain';
    brain.innerHTML = brainLines.map((line: string): string => ansi_renderHtml(line)).join('\n');
    const greeting: HTMLDivElement = document.createElement('div');
    greeting.className = 'argus-splash-greeting';
    splash.append(brain, greeting);
    this.output.appendChild(splash);
    this.splashGreeting = greeting;
  }

  /**
   * Writes the session's greeting beside the brain. The prompt is its own
   * bar under the transcript, so a greeting that arrives a moment after
   * the splash still lands where it belongs; without a splash it is
   * written as banner lines.
   *
   * @param lines - The greeting's lines.
   */
  public greeting_write(lines: string[]): void {
    const column: HTMLDivElement | null = this.splashGreeting;
    if (column === null) {
      for (const line of lines) this.block_append('argus-banner-line argus-greeting-line', ansi_renderHtml(line));
    } else {
      for (const line of lines) {
        const block: HTMLDivElement = document.createElement('div');
        block.className = 'argus-greeting-line';
        block.innerHTML = ansi_renderHtml(line);
        column.appendChild(block);
      }
    }
    this.size_fit();
  }

  /**
   * Writes one live output chunk from the executing command.
   *
   * A chunk is not a line. Progress output redraws itself by returning to
   * column zero with `\r` and rewriting, so the stream is kept as completed
   * lines plus one pending line: `\n` completes the pending line, `\r`
   * discards it, and anything else extends it. Without this a spinner's
   * every frame would append, turning one redrawing line into thousands.
   *
   * @param channel - The producing channel; status renders dimmed.
   * @param chunk - The text chunk.
   */
  public output_write(channel: OutputChannel, chunk: string): void {
    // A status line (a spinner, a phase) is the transcript's live readout,
    // not part of the record a terminal console keeps.
    if (channel !== 'status') this.mirror_emit(chunk);
    this.stream_ensure();
    let rest: string = chunk;
    while (rest.length > 0) {
      const breakAt: number = rest.search(/[\r\n]/);
      if (breakAt === -1) {
        this.pending_extend(channel, rest);
        break;
      }
      this.pending_extend(channel, rest.slice(0, breakAt));
      // A `\r\n` pair is one line ending, not a rewind followed by a blank
      // line; only a lone `\r` means the line is about to be rewritten.
      const isCrLf: boolean = rest[breakAt] === '\r' && rest[breakAt + 1] === '\n';
      if (rest[breakAt] === '\n' || isCrLf) {
        this.pending_commit();
      } else {
        this.streamPendingText = '';
      }
      rest = rest.slice(breakAt + (isCrLf ? 2 : 1));
    }
    this.pending_paint();
    this.size_fit();
  }

  /**
   * Extends the pending line, adopting the channel when the line is new.
   *
   * @param channel - The producing channel.
   * @param text - The text to append (free of line breaks).
   */
  private pending_extend(channel: OutputChannel, text: string): void {
    if (this.streamPendingText.length === 0) {
      this.streamPendingChannel = channel;
    }
    this.streamPendingText += text;
  }

  /** Moves the pending line into the committed transcript above it. */
  private pending_commit(): void {
    this.streamPendingElement?.insertAdjacentHTML('beforebegin', `${this.pending_render()}\n`);
    this.streamPendingText = '';
  }

  /** Repaints the pending line in place. */
  private pending_paint(): void {
    if (this.streamPendingElement !== null) {
      this.streamPendingElement.innerHTML = this.pending_render();
    }
  }

  /**
   * Renders the pending line's text with its channel's styling.
   *
   * @returns The pending line's HTML, empty when the line is empty.
   */
  private pending_render(): string {
    if (this.streamPendingText.length === 0) {
      return '';
    }
    const html: string = ansi_renderHtml(this.streamPendingText);
    return this.streamPendingChannel === 'status' ? `<span class="dim">${html}</span>` : html;
  }

  /**
   * Renders one executed line's final envelopes, suppressing channels whose
   * output already streamed live so nothing prints twice.
   *
   * @param outcome - The envelopes and the channels that streamed live.
   */
  public outcome_write(outcome: ExecuteOutcome): void {
    // A result starts on a line of its own, after whatever streamed.
    this.mirror_flush();
    for (const envelope of outcome.envelopes) {
      if (!outcome.liveChannels.has('data') && envelope.rendered.length > 0) {
        this.block_append('argus-result', ansi_renderHtml(envelope.rendered));
        this.mirror_emit(envelope.rendered);
      }
      const renderedErr: string = envelope.renderedErr ?? '';
      if (!outcome.liveChannels.has('err') && renderedErr.length > 0) {
        this.block_append('argus-result error', ansi_renderHtml(renderedErr));
        this.mirror_emit(`\u001b[31m${renderedErr.replace(/\n$/, '')}\u001b[0m\n`);
      }
    }
    this.mirror_flush();
  }

  /**
   * Renders an envelope another surface produced, tagged with its origin.
   *
   * @param surface - The originating surface's bus id.
   * @param envelope - The broadcast envelope.
   */
  public session_write(surface: string, envelope: WireEnvelope): void {
    if (envelope.rendered.length === 0) {
      return;
    }
    this.block_append('dim', `[surface ${html_escape(surface.slice(0, 6))}]`);
    this.block_append('argus-result', ansi_renderHtml(envelope.rendered));
    this.size_fit();
  }

  /**
   * Mirrors what this surface writes into a terminal console as well: its
   * echoes, notes, the output it streams and the results it renders, a line
   * at a time (another surface's echo is the terminal's own to print). The
   * terminal also takes the keyboard, the fit and an offered line.
   *
   * @param delegate - The terminal console, or null when the transcript is the console again.
   */
  public delegate_set(delegate: ConsoleDelegate | null): void {
    this.mirror_flush();
    this.delegate = delegate;
  }

  /**
   * Mirrors text, sending each complete line as it closes. A line rewritten
   * in place (`\r`) is mirrored as it stood last.
   *
   * @param text - What was written.
   */
  private mirror_emit(text: string): void {
    if (this.delegate === null) return;
    this.mirrorPending += text;
    const cut: number = this.mirrorPending.lastIndexOf('\n');
    if (cut < 0) return;
    const lines: string = this.mirrorPending.slice(0, cut).split('\n').map((line: string): string => line.slice(line.lastIndexOf('\r') + 1)).join('\n');
    this.mirrorPending = this.mirrorPending.slice(cut + 1);
    this.delegate.note(`${lines}\n`);
  }

  /** Mirrors whatever is left of an unfinished line. */
  private mirror_flush(): void {
    if (this.delegate === null || this.mirrorPending === '') return;
    const line: string = this.mirrorPending.slice(this.mirrorPending.lastIndexOf('\r') + 1);
    this.mirrorPending = '';
    if (line !== '') this.delegate.note(`${line}\n`);
  }

  /**
   * Mirrors a command line as the terminal would show one this surface ran.
   *
   * @param line - The line.
   */
  private mirrorEcho_emit(line: string): void {
    if (this.delegate === null) return;
    this.mirror_flush();
    this.delegate.note(`\u001b[36m❯\u001b[0m ${line}\n`);
  }

  /**
   * Writes one line of the surface's own reporting into the transcript.
   *
   * A gesture the surface performs itself — delivering a file the operator
   * picked — still owes the transcript an account of what it did. It is not
   * a command line, so it is not echoed as one; it is what the surface has
   * to say for itself.
   *
   * @param text - The line to write.
   */
  public line_note(text: string): void {
    this.block_append('argus-result', html_escape(text));
    this.mirror_emit(`${text}\n`);
    this.size_fit();
  }

  /**
   * Echoes a command line into the transcript without running it.
   *
   * A pane that runs a big action of its own — a PACS query, a retrieve —
   * should leave the same mark in the console a typed command would, so the
   * transcript is the whole story of the session and not only of what was
   * typed. Unlike {@link line_run} this neither submits nor touches the
   * busy state: the pane runs the command its own way (often silently, so a
   * long retrieve does not lock the prompt), and this is only the echo.
   *
   * @param line - The command line to show.
   * @param remembered - Whether the line also joins the console's history,
   *   as a line run through {@link line_run} does: a button's act the
   *   operator may want back with the up arrow (a PULL).
   */
  public line_echo(line: string, remembered: boolean = false): void {
    // The line's own answer starts beneath it, not in the block an earlier line streamed into.
    this.stream_close();
    this.block_append('argus-echo', `<span class="prompt-glyph">❯</span> <span class="user-input">${html_escape(line)}</span>`);
    this.mirrorEcho_emit(line);
    if (remembered) this.history_push(line);
    this.size_fit();
  }

  /**
   * Runs a line as if the operator had typed it: echoed into the
   * transcript, then submitted. While a command is executing the line is
   * queued and runs when the prompt returns, so lowered gestures and
   * typeahead never disappear.
   *
   * @param line - The command line to run.
   */
  /**
   * Puts a line in the input, unrun, with the caret at its end.
   *
   * What a surface does when it knows most of a command but not all of it —
   * a launcher block offering `pacs query PatientID:` rather than a dead
   * "nothing asked yet". The operator finishes it and presses return, so
   * nothing is issued in their name.
   *
   * @param line - The line to offer.
   */
  public line_offer(line: string): void {
    if (this.delegate !== null) {
      this.delegate.offer(line);
      return;
    }
    this.input.value = line;
    this.focus_take();
    this.input.setSelectionRange(line.length, line.length);
  }

  /**
   * Says whether a question is standing, wherever it is being asked.
   *
   * @param open - True while the operator owes an answer.
   */
  public question_set(open: boolean): void {
    this.questionOpen = open;
    if (!open) return;
  }

  public line_run(line: string): void {
    if (this.busy && !this.questionOpen) {
      this.queuedLines.push(line);
      return;
    }
    if (this.questionOpen) {
      // Around the question, not behind it. `busy` is left alone: it
      // belongs to whatever asked, and the queue it guards drains when
      // that command finishes.
      this.history_push(line);
      this.block_append('argus-echo', `<span class="prompt-glyph">❯</span> <span class="user-input">${html_escape(line)}</span>`);
      this.mirrorEcho_emit(line);
      this.size_fit();
      void this.submit(line);
      return;
    }
    this.busy_set(true);
    this.history_push(line);
    this.block_append('argus-echo', `<span class="prompt-glyph">❯</span> <span class="user-input">${html_escape(line)}</span>`);
    this.mirrorEcho_emit(line);
    this.size_fit();
    void this.submit(line);
  }


  /**
   * Puts a question to the operator in the console.
   *
   * The console is where the session speaks, so it is where the session's
   * questions belong — and where the scrollback keeps them, so an operator
   * can look back at what was asked. A `secret` is masked and never enters
   * the transcript; a `confirm` gets two capsules beside the question,
   * because a control that reads as what it does beats a letter to type.
   *
   * @param request - The question and what it wants.
   * @returns The answer, or null when the operator abandoned it.
   */
  /**
   * Abandons the open question, wherever the operator happened to be looking.
   *
   * A question's Escape used to be bound to the input line alone, so an
   * operator who pressed a row's verb — leaving focus on the row — and then
   * changed their mind pressed Escape into nothing. The question stayed
   * open, the command that raised it waited on an answer that could no
   * longer be given, and the lane counted the minutes. A question owns
   * Escape wherever focus is; abandoning is an answer, and the command is
   * told.
   *
   * @returns Whether there was a question to abandon.
   */
  public ask_abandon(): boolean {
    const ask = this.pendingAsk;
    if (ask === null) return false;
    ask.settle(null);
    return true;
  }

  /** @returns Whether a question is open and waiting for an answer. */
  public ask_isOpen(): boolean {
    return this.pendingAsk !== null;
  }

  public ask_open(request: AskRequest): Promise<string | null> {
    if (this.pendingAsk !== null) {
      // One at a time. The daemon refuses a second question already; this
      // guard is for a surface that finds itself asked anyway.
      return Promise.resolve(null);
    }
    const kind: AskKind = request.kind;
    this.block_append('argus-ask', `<span class="ask-glyph">?</span> ${html_escape(request.message)}`);
    const asked: HTMLElement = this.output.lastElementChild as HTMLElement;

    return new Promise((resolve: (answer: string | null) => void): void => {
      const settle = (answer: string | null): void => {
        if (this.pendingAsk === null) return;
        this.pendingAsk = null;
        this.questionOpen = false;
        this.input.type = 'text';
        this.input.value = '';
        this.inputGlyph.textContent = '❯';
        asked.classList.add('argus-ask-answered');
        // A secret never enters the transcript, not even as a length.
        const said: string = answer === null
          ? 'abandoned'
          : (kind === 'secret' ? '••••••' : answer);
        asked.insertAdjacentHTML('beforeend', ` <span class="ask-answer">${html_escape(said)}</span>`);
        this.askAnswered_mirror(request.message, said);
        this.size_fit();
        resolve(answer);
      };
      this.pendingAsk = { settle, kind };
      this.questionOpen = true;
      this.inputGlyph.textContent = '?';
      if (kind === 'secret') this.input.type = 'password';
      if ((kind === 'path' || kind === 'text') && request.suggest !== undefined) this.input.value = request.suggest;
      if (kind === 'confirm') {
        // The capsules are the instrument; typing y or n still works, since
        // a hand already on the keys should not have to reach for a mouse.
        const yes: HTMLButtonElement = document.createElement('button');
        yes.className = 'ask-capsule';
        yes.textContent = 'YES';
        yes.addEventListener('click', (): void => settle('y'));
        const no: HTMLButtonElement = document.createElement('button');
        no.className = 'ask-capsule ask-capsule-no';
        no.textContent = 'NO';
        no.addEventListener('click', (): void => settle('n'));
        asked.append(' ', yes, ' ', no);
      }
      if (request.focus !== false) this.input.focus();
      this.size_fit();
    });
  }

  /**
   * Answers the open question from elsewhere — the pane it also stands on —
   * so the transcript records the answer and the input line is free again.
   *
   * @param answer - The answer, or null when it was abandoned.
   * @returns Whether a question was open.
   */
  public ask_settle(answer: string | null): boolean {
    const ask = this.pendingAsk;
    if (ask === null) return false;
    ask.settle(answer);
    return true;
  }


  /**
   * States a question in the transcript without taking the input line.
   *
   * Some questions are answered by an instrument elsewhere — a browser to
   * walk for a location — but the console still says what was asked, so
   * the scrollback holds the whole exchange rather than half of it.
   *
   * @param message - The question's own words.
   * @returns A function that records how it was answered.
   */
  public ask_note(message: string): (answer: string | null) => void {
    this.block_append('argus-ask', `<span class="ask-glyph">?</span> ${html_escape(message)}`);
    const asked: HTMLElement = this.output.lastElementChild as HTMLElement;
    this.size_fit();
    return (answer: string | null): void => {
      asked.classList.add('argus-ask-answered');
      asked.insertAdjacentHTML(
        'beforeend',
        ` <span class="ask-answer">${html_escape(answer ?? 'abandoned')}</span>`,
      );
      this.askAnswered_mirror(message, answer ?? 'abandoned');
      this.size_fit();
    };
  }

  /**
   * Records an answered question in the terminal standing in for this
   * transcript, so its scrollback keeps the whole exchange (a pressed verb's
   * question stands on its pane, not in the terminal).
   *
   * @param message - The question.
   * @param said - The answer as the transcript records it (a secret masked).
   */
  private askAnswered_mirror(message: string, said: string): void {
    if (this.delegate === null) return;
    this.mirror_flush();
    this.delegate.note(`\u001b[33m?\u001b[0m ${message.trim()} \u001b[36m${said}\u001b[0m\n`);
  }

  /**
   * Routes a key while a question is open.
   *
   * @param event - The keyboard event.
   * @returns True when the key belonged to the question.
   */
  private askKey_handle(event: KeyboardEvent): boolean {
    const ask = this.pendingAsk;
    if (ask === null) return false;
    if (event.key === 'Enter') {
      event.preventDefault();
      ask.settle(this.input.value);
      return true;
    }
    if (event.key === 'Escape') {
      // Abandoning is an answer of its own: the command that asked is told,
      // and reports what it did not do.
      event.preventDefault();
      event.stopPropagation();
      ask.settle(null);
      return true;
    }
    return true;
  }

  /**
   * Routes input-line keys: a question first, then Enter submits or queues,
   * arrows walk history, Tab asks the wire for completion.
   *
   * @param event - The keyboard event.
   */
  private key_handle(event: KeyboardEvent): void {
    // A question outranks everything: while one is open the line answers it
    // rather than running, so a password is never dispatched as a command.
    if (this.askKey_handle(event)) return;
    if (event.key === 'Enter') {
      const line: string = this.input.value;
      this.input.value = '';
      if (line.trim().length > 0) {
        this.line_run(line);
      } else if (!this.busy) {
        this.block_append('argus-echo', '<span class="prompt-glyph">❯</span>');
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (this.historyIndex > 0) {
        this.historyIndex -= 1;
        this.input.value = this.history[this.historyIndex] ?? '';
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (this.historyIndex < this.history.length) {
        this.historyIndex += 1;
        this.input.value = this.history[this.historyIndex] ?? '';
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      void this.completion_apply();
    }
  }

  /**
   * Asks the wire for completions of the current input and applies the
   * answer: a single candidate completes in place; several are listed in
   * the transcript, prototype-style.
   */
  private async completion_apply(): Promise<void> {
    const line: string = this.input.value;
    if (line.length === 0) {
      return;
    }
    let answer: CompletionAnswer;
    try {
      answer = await this.complete(line);
    } catch {
      return;
    }
    if (answer.candidates.length === 1) {
      const sole: string = answer.candidates[0] ?? '';
      this.input.value = line.slice(0, line.length - answer.prefix.length) + sole;
      return;
    }
    if (answer.candidates.length > 1) {
      // Readline manners: grow the input to the candidates' longest common
      // prefix first, then show the remaining choices.
      const common: string = commonPrefix_find(answer.candidates);
      if (common.length > answer.prefix.length) {
        this.input.value = line.slice(0, line.length - answer.prefix.length) + common;
      }
      this.block_append('dim', html_escape(answer.candidates.join('  ')));
      this.size_fit();
    }
  }

  /**
   * Records a line in the arrow-key history, bounded and deduplicated
   * against the immediately previous entry.
   *
   * @param line - The submitted line.
   */
  private history_push(line: string): void {
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > HISTORY_LIMIT) {
        this.history.shift();
      }
    }
    this.historyIndex = this.history.length;
  }

  /**
   * Appends one block to the transcript.
   *
   * @param className - The block's CSS class(es).
   * @param html - The block's inner HTML (already escaped/converted).
   */
  private block_append(className: string, html: string): void {
    const block: HTMLDivElement = document.createElement('div');
    block.className = `argus-line ${className}`;
    block.innerHTML = html;
    this.output.appendChild(block);
  }

  /**
   * Returns the open live-stream block for the executing command, creating
   * it on first use.
   *
   * @returns The stream block element.
   */
  private stream_ensure(): HTMLElement {
    if (this.streamBlock === null) {
      const block: HTMLDivElement = document.createElement('div');
      block.className = 'argus-line argus-stream';
      const pending: HTMLSpanElement = document.createElement('span');
      pending.className = 'argus-stream-pending';
      block.appendChild(pending);
      this.output.appendChild(block);
      this.streamBlock = block;
      this.streamPendingElement = pending;
      this.streamPendingText = '';
      this.streamPendingChannel = 'data';
    }
    return this.streamBlock;
  }

  /**
   * Closes the live-stream block at the end of a command.
   *
   * A command may end mid-line — a spinner's last frame carries no newline —
   * so the pending line is committed rather than dropped, unless the spinner
   * already erased it, in which case there is nothing to keep.
   */
  private stream_close(): void {
    if (this.streamPendingText.length > 0) {
      this.pending_commit();
    }
    this.streamPendingElement?.remove();
    this.streamPendingElement = null;
    this.streamPendingText = '';
    this.streamBlock = null;
  }

  /**
   * Renders the Powerlevel10k segment bar from the stored context
   * (`promptBar.ts`), with this terminal's glyphs and palette.
   *
   * @returns The prompt bar's inner HTML.
   */
  private promptSegments_render(): string {
    return promptBar_render(this.promptContext, { glyphs: GLYPHS, palette: SEGMENT_PALETTE, procStates: PROC_STATE_SEGMENTS });
  }
}

/**
 * Queries a required child element.
 *
 * @param root - The element to query within.
 * @param selector - The CSS selector.
 * @returns The matched element.
 * @throws {Error} When nothing matches.
 */
function element_query(root: HTMLElement, selector: string): HTMLElement {
  const element: HTMLElement | null = root.querySelector(selector);
  if (element === null) {
    throw new Error(`console structure is missing '${selector}'`);
  }
  return element;
}

/**
 * Finds the longest prefix shared by every candidate.
 *
 * @param candidates - The completion candidates (at least one).
 * @returns The longest common prefix, possibly empty.
 */
function commonPrefix_find(candidates: string[]): string {
  let common: string = candidates[0] ?? '';
  for (const candidate of candidates) {
    let length: number = 0;
    while (
      length < common.length &&
      length < candidate.length &&
      common[length] === candidate[length]
    ) {
      length++;
    }
    common = common.slice(0, length);
    if (common.length === 0) {
      break;
    }
  }
  return common;
}

