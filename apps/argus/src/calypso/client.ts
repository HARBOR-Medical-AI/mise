/**
 * @file The browser CALYPSO client: attach, execute, and session events.
 *
 * A thin surface over the published wire contract. The client attaches to a
 * CALYPSO daemon over the browser's native WebSocket, declares no local
 * capabilities (this surface cannot run shell commands, collect hidden
 * input, execute pipeline segments, or open an editor), and exposes the
 * session as typed callbacks. Capability requests the daemon raises anyway
 * are answered with the matching error reply so the engine fails the request
 * cleanly instead of hanging the session.
 *
 * Boundary rule: this module imports only `@fnndsc/menu` — the
 * published contract — and its own routes; never the execution stack.
 *
 * @module
 */
import { vfsUrl_build } from './routes.js';
import type { ClosingCause } from '@fnndsc/menu';
import type { SurfaceSeen } from '../app/restart.js';
import { type LaneTelemetry, type CubeTelemetry, type JobsStateTelemetry,
  CONTRACT_VERSION,
  serverMessage_parse,
  promptKind_derive,
  type ServerMessage,
  type PromptContext,
  type PromptKind,
  type PromptPath,
  type ProgressMessage,
  type Regard,
  type WireEnvelope,
  type WatchState,
} from '@fnndsc/menu';


/**
 * A question on its way to whatever will answer it.
 *
 * The client does not choose the instrument — it carries what the session
 * asked for and lets the surface decide whether that is a line in the
 * console or a browser to walk.
 *
 * @property message - The question's own words.
 * @property kind - What kind of value answers it.
 * @property suggest - A value to offer, when the question suggested one.
 * @property path - Where browsing starts and what to compose, for a location.
 * @property commit - The word the committing control should read.
 */
export interface SurfaceAsk {
  message: string;
  kind: PromptKind;
  suggest?: string;
  path?: PromptPath;
  commit?: string;
}

/** The surface tag the daemon puts on session-bus envelopes it originates itself. */
const DAEMON_SURFACE: string = 'daemon';

/** The output channels a command can stream on. */
export type OutputChannel = 'data' | 'err' | 'status';

/** Re-exported so console modules need not know the protocol package's shape. */
export type { ProgressMessage };

/**
 * The stack identity a daemon reports in its attach ack.
 *
 * @property chell - The daemon's installed chell version.
 * @property calypso - The daemon's installed calypso version.
 * @property build - The daemon's short build hash.
 * @property surface - The page the daemon started beside, when it says.
 */
export interface StackInfo {
  chell: string;
  calypso: string;
  build: string;
  surface?: { git: string; built: string };
  brasa?: string;
  chili?: string;
  salsa?: string;
  cumin?: string;
}

/**
 * The facts of a successful attach.
 *
 * @property session - The shared session id all surfaces attach to.
 * @property protocolVersion - The daemon's contract version.
 * @property stack - The daemon's installed versions, when reported.
 */
export interface AttachInfo {
  session: string;
  /** The daemon's declared host-control tiers (empty or absent when off). */
  hostControl?: string[];
  /** Whether this session can be raised to MANAGE with the person's password (`elevate`). */
  elevation?: boolean;
  protocolVersion: number;
  stack?: StackInfo;
  /** Whether the daemon's own code on disk has moved on; absent from older daemons. */
  stale?: boolean;
  /** This surface's own id on the daemon; absent from older daemons. */
  surface?: string;
  /** The session's backend id; absent from older daemons, which are all ChRIS. */
  backend?: string;
  /** Whether the daemon offers terminals (a console that is a terminal); absent from older daemons, which do not. */
  terminals?: boolean;
}

/**
 * The backend a session runs over, as a surface reads it: the daemon's word,
 * or ChRIS when the daemon is older than the word.
 *
 * @param attach - The attach answer.
 * @returns The backend id.
 */
export function attachBackend_get(attach: AttachInfo): string {
  return attach.backend ?? 'chris';
}

/**
 * One executed line's complete outcome.
 *
 * @property envelopes - The final envelope per command in the line.
 * @property liveChannels - Channels that already streamed this command's
 *   output live; a renderer suppresses the envelope's rendered text for those
 *   channels to avoid printing the output twice.
 */
export interface ExecuteOutcome {
  envelopes: WireEnvelope[];
  liveChannels: Set<'data' | 'err'>;
}

/**
 * A file the session asked this surface to edit.
 *
 * @property path - The file, where the editor's saves go; absent only when the
 *   command editing it could not name one.
 * @property content - The file's text as the command read it.
 * @property extension - The filename extension, for the field's syntax mode.
 */
export interface SurfaceEdit {
  path?: string;
  content: string;
  extension?: string;
}

/**
 * Callbacks through which the client delivers session activity.
 *
 * @property output_receive - A live output chunk from this surface's own
 *   executing command.
 * @property promptline_receive - The refreshed prompt context, pushed on
 *   attach and after every command.
 * @property session_receive - A session-bus envelope produced by another
 *   surface attached to the same session.
 * @property envelope_observe - Every envelope this surface sees, own results
 *   and bus broadcasts alike; instruments (panels) subscribe here.
 * @property close_handle - The socket closed.
 */
export interface ClientHandlers {
  output_receive?: (channel: OutputChannel, chunk: string) => void;
  progress_receive?: (message: ProgressMessage) => void;
  /**
   * A typed event from this surface's own executing command: its kind names
   * what the data is (`games.trek.state`); the host shows the kinds it knows.
   */
  event_receive?: (id: string, kind: string, data: unknown) => void;
  promptline_receive?: (context: PromptContext) => void;
  /**
   * A question the session is waiting on. The handler answers it, or
   * resolves null to abandon it.
   */
  ask_receive?: (request: SurfaceAsk) => Promise<string | null>;
  /**
   * The session asked this surface to edit a file. The handler opens the
   * editor pane and returns at once; true means it opened. The command that
   * asked is answered then, never when the operator saves: each save runs as
   * its own command line.
   */
  edit_receive?: (request: SurfaceEdit) => boolean;
  telemetry_receive?: (index: { jobs: number; feeds: number }, extra?: { lane?: LaneTelemetry; cube?: CubeTelemetry; state?: JobsStateTelemetry; surfaces?: SurfaceSeen[] }) => void;
  /** The daemon is going away, and says why. */
  closing_receive?: (cause: ClosingCause) => void;
  session_receive?: (surface: string, envelope: WireEnvelope, terminal?: string) => void;
  envelope_observe?: (envelope: WireEnvelope) => void;
  /** The session's retained regard, pushed on any surface's write and on attach. */
  regard_receive?: (regard: Regard) => void;
  /**
   * An envelope the daemon itself originated (a watched feed's refreshed
   * model): state, not something an operator did — it never reaches the
   * transcript, and it refreshes rather than pins.
   */
  ambient_receive?: (envelope: WireEnvelope) => void;
  /** A watched subject's liveness changed: live, settled, or stale. */
  watched_receive?: (subject: string, state: WatchState) => void;
  /** The daemon's own code on disk changed (or changed back) since it started. */
  stale_receive?: (stale: boolean) => void;
  /**
   * A line typed in a chell whose subject this surface claims: run it in the
   * surface's own language. Resolves with the text to print, or rejects when
   * the line is not the surface's after all.
   */
  surfaceLine_receive?: (line: string, terminal: string | undefined) => Promise<{ rendered: string; status: 'ok' | 'error' }>;
  /** A terminal opened: its id and the output to draw first, or why none could be. */
  terminalOpened_receive?: (terminalId: string, replay: string, refused: string | undefined) => void;
  /** A terminal's program wrote. */
  terminalData_receive?: (terminalId: string, data: string) => void;
  /** A terminal's program exited. */
  terminalExit_receive?: (terminalId: string, code: number) => void;
  /**
   * Which listing the session's numbers currently count.
   *
   * A row can be named by the number beside it (`gather add @2,3`), and a
   * surface lights the index pills on the listing those numbers reach —
   * pills on any other listing would be numbers nothing would answer to.
   */
  numbered_receive?: (numbering: { id: number; source: string; rows: number; handles: Array<{ kind: string; ordinal: number; address: string }> }) => void;
  close_handle?: () => void;
}

/** A pending execute request awaiting its correlated result. */
interface PendingExecute {
  resolve: (outcome: ExecuteOutcome) => void;
  reject: (error: Error) => void;
  liveChannels: Set<'data' | 'err'>;
  /** When false, the result's envelopes skip the global observe broadcast:
   * the issuing pane consumes them alone (the claim rule). */
  observed: boolean;
}

/** A completion reply: the candidates and the prefix they complete. */
export interface CompleteOutcome {
  candidates: string[];
  prefix: string;
}

/** A pending completion request awaiting its correlated reply. */
interface PendingComplete {
  resolve: (outcome: CompleteOutcome) => void;
  reject: (error: Error) => void;
}

/**
 * A browser surface attached to one CALYPSO session.
 *
 * @example
 * ```
 * const client = await ArgusClient.session_attach('ws://127.0.0.1:9000', token, handlers);
 * const outcome = await client.line_execute('ls');
 * ```
 */
export class ArgusClient {
  private readonly socket: WebSocket;
  private readonly handlers: ClientHandlers;
  /** The attach token, reused to authorise byte-route fetches. */
  private readonly token: string;
  private readonly pending: Map<string, PendingExecute> = new Map();
  private readonly pendingCompletions: Map<string, PendingComplete> = new Map();
  /** The surface's one elevation on its way, answered by `elevated`. */
  private elevatePending: ((answer: { granted: boolean; reason?: string }) => void) | null = null;
  /** Requests whose live output must not reach the transcript. */
  private readonly silentIds: Set<string> = new Set();
  private nextId: number = 0;
  /** Whether what this surface runs is mirrored into a terminal console (mirror_set). */
  private mirroring: boolean = false;

  private constructor(socket: WebSocket, handlers: ClientHandlers, token: string) {
    this.socket = socket;
    this.handlers = handlers;
    this.token = token;
    this.socket.onmessage = (event: MessageEvent): void => this.message_handle(String(event.data));
    this.socket.onclose = (): void => this.handlers.close_handle?.();
  }

  /**
   * Opens a WebSocket to a daemon and performs the attach handshake.
   *
   * @param url - The daemon's WebSocket URL (`ws://127.0.0.1:<port>`).
   * @param token - The daemon's attach token.
   * @param handlers - Session activity callbacks.
   * @returns The attached client and the attach facts.
   * @throws {Error} When the socket fails, the token is refused, or the
   *   daemon replies with anything but an attach ack.
   */
  public static session_attach(
    url: string,
    token: string,
    handlers: ClientHandlers,
  ): Promise<{ client: ArgusClient; attach: AttachInfo }> {
    return new Promise((resolve, reject) => {
      const socket: WebSocket = new WebSocket(url);
      socket.onerror = (): void => reject(new Error(`cannot reach the daemon at ${url}`));
      socket.onopen = (): void => {
        socket.send(
          JSON.stringify({
            type: 'attach',
            protocolVersion: CONTRACT_VERSION,
            token,
            capabilities: {
              shellCommands: false,
              // The DOM console renders ANSI, so a thumbnail can arrive as
              // colour half-blocks rather than an ASCII ramp.
              color: true,
              // A masked field in a browser is as private as a terminal's
              // no-echo line: the console asks, nothing is echoed, and the
              // answer never enters the transcript. Declaring false here is
              // what made `sudo` dead-end in this surface.
              hiddenInput: true,
              // A browser can save a file but has no directory to fill, so a
              // folder must be archived into one file before it can arrive.
              fileDelivery: true,
              localFilesystem: false,
            },
          }),
        );
      };
      socket.onmessage = (event: MessageEvent): void => {
        const message: ServerMessage | null = message_parse(String(event.data));
        if (!message) {
          reject(new Error('invalid attach response'));
          socket.close();
          return;
        }
        if (message.type === 'error') {
          reject(new Error(message.reason));
          socket.close();
          return;
        }
        if (message.type !== 'attached') {
          reject(new Error(`unexpected attach response: ${message.type}`));
          socket.close();
          return;
        }
        const client: ArgusClient = new ArgusClient(socket, handlers, token);
        resolve({
          client,
          attach: {
            session: message.session,
            protocolVersion: message.protocolVersion,
            ...(message.stack !== undefined ? { stack: message.stack } : {}),
            ...(message.hostControl !== undefined ? { hostControl: message.hostControl } : {}),
            ...(message.elevation !== undefined ? { elevation: message.elevation } : {}),
            ...(message.stale !== undefined ? { stale: message.stale } : {}),
            ...(message.terminals !== undefined ? { terminals: message.terminals } : {}),
            ...(message.surface !== undefined ? { surface: message.surface } : {}),
            ...(message.backend !== undefined ? { backend: message.backend } : {}),
          },
        });
      };
    });
  }

  /**
   * Executes one input line through the session.
   *
   * @param line - The command line as the operator typed it.
   * @param options - `silent` swallows the live output (a pane draws the
   *   answer); `operator` marks a silent command as the operator's own act
   *   (a button press that changes state), so it is not instrument traffic
   *   and may ask the operator a question; `observe: false` keeps the
   *   envelopes from the observers; `signal`, aborted while the line runs,
   *   asks the daemon to cancel this one line (the session stops it, or
   *   abandons it when it does not end), and the promise settles with what
   *   the daemon then answers.
   * @returns The line's envelopes and which channels already streamed live.
   * @throws {Error} When the daemon reports an execution error.
   */
  public line_execute(
    line: string,
    options?: { silent?: boolean; observe?: boolean; operator?: boolean; signal?: AbortSignal },
  ): Promise<ExecuteOutcome> {
    const id: string = `argus-${this.nextId++}`;
    options?.signal?.addEventListener('abort', (): void => this.line_cancel(id), { once: true });
    if (options?.silent === true) {
      // A silent command feeds instruments (the files panel, a viewer), not
      // the transcript: its live output is swallowed on arrival.
      this.silentIds.add(id);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        liveChannels: new Set<'data' | 'err'>(),
        observed: options?.observe !== false,
      });
      // Silent commands are instrument traffic: the daemon keeps them off
      // the session bus and out of scrollback.
      this.socket.send(
        JSON.stringify({
          type: 'execute',
          id,
          line,
          // A state-changing act the operator pressed for is theirs, never
          // instrument traffic: the daemon lets it ask them a question.
          ...(options?.silent === true && options.operator !== true ? { instrument: true } : {}),
          // A terminal console shows what this surface runs as notes of its
          // own, so the session's echo of it skips that terminal.
          ...(this.mirroring && options?.silent !== true ? { mirrored: true } : {}),
        }),
      );
    });
  }

  /**
   * Cancels one line this surface sent, while it runs: the wire's `cancel`,
   * which reaches that line alone and nothing else the session is doing.
   *
   * @param id - The line's id.
   */
  private line_cancel(id: string): void {
    if (!this.pending.has(id)) return;
    this.socket.send(JSON.stringify({ type: 'cancel', id }));
  }

  /**
   * Says whether this surface mirrors what it runs into a terminal console.
   *
   * @param on - True while the console is a terminal.
   */
  public mirror_set(on: boolean): void {
    this.mirroring = on;
  }

  /**
   * Opens a terminal (or reopens the one named), the size of the viewer.
   *
   * @param cols - Its width in cells.
   * @param rows - Its height in cells.
   * @param terminalId - The terminal to reattach, when this page had one.
   */
  public terminal_open(cols: number, rows: number, terminalId?: string): void {
    this.socket.send(JSON.stringify({ type: 'terminalOpen', cols, rows, ...(terminalId === undefined ? {} : { terminalId }) }));
  }

  /**
   * Types into a terminal.
   *
   * @param terminalId - The terminal.
   * @param data - The keystrokes, as the emulator encodes them.
   */
  public terminal_input(terminalId: string, data: string): void {
    this.socket.send(JSON.stringify({ type: 'terminalInput', terminalId, data }));
  }

  /**
   * Tells a terminal its new size.
   *
   * @param terminalId - The terminal.
   * @param cols - Its width in cells.
   * @param rows - Its height in cells.
   */
  public terminal_resize(terminalId: string, cols: number, rows: number): void {
    this.socket.send(JSON.stringify({ type: 'terminalResize', terminalId, cols, rows }));
  }

  /**
   * Requests completion candidates for a partial input line.
   *
   * @param prefix - The input line up to the cursor.
   * @returns The candidates and the prefix they complete.
   * @throws {Error} When the daemon reports an error for the request.
   */
  public line_complete(prefix: string): Promise<CompleteOutcome> {
    const id: string = `argus-c-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pendingCompletions.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ type: 'complete', id, prefix }));
    });
  }

  /**
   * Hands a terminal's messages to the console that draws it.
   *
   * @param message - A terminal message.
   */
  private terminalMessage_handle(message: Extract<ServerMessage, { type: 'terminalOpened' | 'terminalData' | 'terminalExit' }>): void {
    if (message.type === 'terminalOpened') this.handlers.terminalOpened_receive?.(message.terminalId, message.replay, message.refused);
    else if (message.type === 'terminalData') this.handlers.terminalData_receive?.(message.terminalId, message.data);
    else this.handlers.terminalExit_receive?.(message.terminalId, message.code);
  }

  /**
   * Runs a line routed here in this surface's own language and answers the
   * daemon with the text, or with why it could not.
   *
   * @param lineId - The request's correlation id.
   * @param line - The line typed in a chell.
   * @param terminal - The terminal it was typed in, when it was this surface's.
   */
  private surfaceLine_handle(lineId: string, line: string, terminal: string | undefined): void {
    const run = this.handlers.surfaceLine_receive;
    if (run === undefined) {
      this.socket.send(JSON.stringify({ type: 'surfaceLineError', lineId, reason: 'this surface runs no lines of its own' }));
      return;
    }
    run(line, terminal).then(
      (answer: { rendered: string; status: 'ok' | 'error' }): void => { this.socket.send(JSON.stringify({ type: 'surfaceLineResult', lineId, rendered: answer.rendered, status: answer.status })); },
      (error: unknown): void => { this.socket.send(JSON.stringify({ type: 'surfaceLineError', lineId, reason: error instanceof Error ? error.message : String(error) })); },
    );
  }

  /**
   * Declares the subjects this surface's own language answers for, so a line
   * in one typed in any chell is routed here.
   *
   * @param claims - The subjects, with the verbs claimed from a shared one.
   */
  public claims_send(claims: ReadonlyArray<{ subject: string; verbs?: string[] }>): void {
    this.socket.send(JSON.stringify({ type: 'surfaceClaims', claims }));
  }

  /**
   * Sends a note for this surface's consoles: their chell prints it above the
   * line being typed.
   *
   * @param text - The note.
   */
  public note_send(text: string): void {
    this.socket.send(JSON.stringify({ type: 'note', text }));
  }

  /**
   * The operator's STOP: ends the command running for this page (its own, or
   * one typed in its terminal), whatever it is; one that does not end when
   * asked is abandoned by the daemon and the session is free again.
   */
  public stop_send(): void {
    this.socket.send(JSON.stringify({ type: 'stop' }));
  }

  /**
   * Asks the daemon to raise this surface to MANAGE with the person's
   * password, checked at the door the session was started with (D14). The
   * password crosses once and is kept nowhere.
   *
   * @param password - What the person typed.
   * @returns Whether it was granted, and why not when it was not.
   */
  /**
   * The daemon's answer to `elevate`, handed to the one ask on its way.
   *
   * @param message - Granted, or why not.
   */
  private elevated_handle(message: { granted: boolean; reason?: string }): void {
    const waiting = this.elevatePending;
    this.elevatePending = null;
    waiting?.({ granted: message.granted, ...(message.reason === undefined ? {} : { reason: message.reason }) });
  }

  public elevate(password: string): Promise<{ granted: boolean; reason?: string }> {
    return new Promise((resolve: (answer: { granted: boolean; reason?: string }) => void): void => {
      this.elevatePending = resolve;
      this.socket.send(JSON.stringify({ type: 'elevate', password }));
    });
  }

  /**
   * Shares the operator's regard with the session: the daemon keeps the
   * truth and rebroadcasts to every surface.
   *
   * @param regard - The indicated address with its provenance.
   */
  public regard_send(regard: Regard): void {
    this.socket.send(JSON.stringify({ type: 'regard', regard }));
  }

  /**
   * Opens this surface's watch on a subject: the session keeps it live
   * while the watch is held, and reports its state with `watched`.
   *
   * @param subject - The subject address (`/proc/jobs/feed_N`).
   */
  public watch_send(subject: string): void {
    this.socket.send(JSON.stringify({ type: 'watch', subject }));
  }

  /**
   * Releases this surface's watch on a subject.
   *
   * @param subject - The subject address.
   */
  public unwatch_send(subject: string): void {
    this.socket.send(JSON.stringify({ type: 'unwatch', subject }));
  }

  /** Closes the WebSocket. */
  public connection_close(): void {
    this.socket.close();
  }

  /**
   * Routes one daemon message: correlated results and output to their pending
   * command, session traffic to the handlers, and capability requests to
   * their refusal replies.
   *
   * @param payload - The raw message text.
   */
  private message_handle(payload: string): void {
    const message: ServerMessage | null = message_parse(payload);
    // A tally of the wire, by message type, with what the contract refused: the smoke suite's only sight of the socket.
    wire_tally(message?.type ?? `refused:${payloadType_parse(payload)}`);
    if (!message) {
      return;
    }
    switch (message.type) {
      case 'result': {
        this.silentIds.delete(message.id);
        const request: PendingExecute | undefined = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id);
          request.resolve({ envelopes: message.envelopes, liveChannels: request.liveChannels });
        }
        // A pane-claimed request (observe: false) resolves to its issuer
        // alone; everything else feeds the shared instruments.
        if (request === undefined || request.observed) {
          for (const envelope of message.envelopes) {
            this.handlers.envelope_observe?.(envelope);
          }
        }
        break;
      }
      case 'complete': {
        const request: PendingComplete | undefined = this.pendingCompletions.get(message.id);
        if (request) {
          this.pendingCompletions.delete(message.id);
          request.resolve({ candidates: message.candidates, prefix: message.prefix });
        }
        break;
      }
      case 'output': {
        if (message.channel === 'data' || message.channel === 'err') {
          this.pending.get(message.id)?.liveChannels.add(message.channel);
        }
        if (!this.silentIds.has(message.id)) {
          this.handlers.output_receive?.(message.channel, message.chunk);
        }
        break;
      }
      case 'progress': {
        this.handlers.progress_receive?.(message);
        break;
      }
      case 'event': {
        this.handlers.event_receive?.(message.id, message.kind, message.data);
        break;
      }
      case 'session': {
        if (message.surface === DAEMON_SURFACE) {
          this.handlers.ambient_receive?.(message.envelope);
          break;
        }
        this.handlers.session_receive?.(message.surface, message.envelope, message.terminal);
        this.handlers.envelope_observe?.(message.envelope);
        break;
      }
      case 'watched': {
        this.handlers.watched_receive?.(message.subject, message.state);
        break;
      }
      case 'stale': this.handlers.stale_receive?.(message.stale); break;
      case 'elevated': this.elevated_handle(message); break;
      case 'surfaceLine': this.surfaceLine_handle(message.lineId, message.line, message.terminal); break;
      case 'terminalOpened': case 'terminalData': case 'terminalExit': this.terminalMessage_handle(message); break;
      case 'closing': this.handlers.closing_receive?.(message.cause); break;
      case 'numbered': {
        this.handlers.numbered_receive?.({
          id: message.id,
          source: message.source,
          rows: message.rows,
          handles: message.handles,
        });
        break;
      }
      case 'promptline': this.handlers.promptline_receive?.(message.context); break;
      case 'telemetry': this.handlers.telemetry_receive?.(message.index, { lane: message.lane, cube: message.cube, state: message.state, surfaces: message.surfaces }); break;
      case 'regard': this.handlers.regard_receive?.(message.regard); break;
      case 'error': {
        if (message.id !== undefined) {
          const request: PendingExecute | undefined = this.pending.get(message.id);
          if (request) {
            this.pending.delete(message.id);
            request.reject(new Error(message.reason));
          }
          const completion: PendingComplete | undefined = this.pendingCompletions.get(message.id);
          if (completion) {
            this.pendingCompletions.delete(message.id);
            completion.reject(new Error(message.reason));
          }
        }
        break;
      }
      // A question the session put to this surface. Everything else the
      // engine may delegate is still refused in its own vocabulary, so it
      // fails cleanly rather than hanging.
      case 'prompt': {
        const ask = this.handlers.ask_receive;
        if (ask === undefined) {
          this.reply_send({ type: 'promptError', promptId: message.promptId, reason: 'this surface has no way to ask' });
          break;
        }
        const promptId: string = message.promptId;
        void ask({
          message: message.message,
          kind: promptKind_derive(message),
          ...(message.path?.suggest === undefined ? {} : { suggest: message.path.suggest }),
          ...(message.path === undefined ? {} : { path: message.path }),
          ...(message.commit === undefined ? {} : { commit: message.commit }),
        }).then((answer: string | null): void => {
          if (answer === null) {
            // Abandoning is an answer: the command is told, and says what
            // it did not do.
            this.reply_send({ type: 'promptError', promptId, reason: 'the operator abandoned the question' });
            return;
          }
          this.reply_send({ type: 'promptAnswer', promptId, answer });
        }).catch((error: unknown): void => {
          const reason: string = error instanceof Error ? error.message : 'the question could not be answered';
          this.reply_send({ type: 'promptError', promptId, reason });
        });
        break;
      }
      case 'pipe': {
        this.reply_send({ type: 'pipeError', pipeId: message.pipeId, reason: 'the argus surface cannot run pipeline segments' });
        break;
      }
      case 'shell': {
        this.reply_send({ type: 'shellError', shellId: message.shellId, reason: 'the argus surface cannot run shell commands' });
        break;
      }
      // An edit opens a pane that stays open, so the command is answered at
      // once that it opened; the operator's saves are lines of their own.
      case 'edit': {
        this.edit_run(message);
        break;
      }
      // File delivery is the one capability a browser has and a terminal
      // fakes: it hands the file to the download manager, where the person
      // sitting in front of it can find it.
      case 'deliver': {
        void this.deliver_run(message);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Hands a file the session asked to edit to the host's editor pane.
   *
   * The command waiting on it is answered as soon as the pane opens: the
   * content comes back unchanged with `opened`, so the kernel saves nothing.
   * A host with no editor, or one that could not open, refuses in words.
   *
   * @param message - The edit request from the daemon.
   */
  private edit_run(message: { editId: string; content: string; extension?: string; path?: string }): void {
    const open: ((request: SurfaceEdit) => boolean) | undefined = this.handlers.edit_receive;
    let opened: boolean = false;
    let reason: string = 'the argus surface cannot open an editor';
    if (open !== undefined) {
      try {
        opened = open({
          content: message.content,
          ...(message.path === undefined ? {} : { path: message.path }),
          ...(message.extension === undefined ? {} : { extension: message.extension }),
        });
        reason = 'the editor pane did not open';
      } catch (error: unknown) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (opened) {
      this.reply_send({ type: 'editResult', editId: message.editId, content: message.content, changed: false, opened: true });
      return;
    }
    this.reply_send({ type: 'editError', editId: message.editId, reason });
  }

  /**
   * Saves a delivered file through the browser.
   *
   * The bytes come from the daemon's token-gated byte route rather than the
   * session bus, so a large file does not cross a channel meant for session
   * state — and the browser streams it the way it streams any download.
   *
   * @param message - The delivery request from the daemon.
   */
  private async deliver_run(message: {
    deliverId: string;
    path: string;
    filename: string;
  }): Promise<void> {
    try {
      const url: string = vfsUrl_build(message.path, this.token);
      const response: Response = await fetch(url);
      if (!response.ok) {
        throw new Error(`calypso refused to serve this file (HTTP ${response.status})`);
      }
      const blob: Blob = await response.blob();
      const objectUrl: string = URL.createObjectURL(blob);
      const anchor: HTMLAnchorElement = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = message.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoking immediately can cancel a download the browser has not yet
      // started reading, so the handle is released on the next turn.
      setTimeout((): void => URL.revokeObjectURL(objectUrl), 0);
      this.reply_send({
        type: 'deliverResult',
        deliverId: message.deliverId,
        location: message.filename,
        bytes: blob.size,
      });
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.reply_send({ type: 'deliverError', deliverId: message.deliverId, reason });
    }
  }

  /**
   * Sends one reply message to the daemon.
   *
   * @param reply - The message object to serialize.
   */
  private reply_send(reply: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(reply));
  }
}

/**
 * Parses and validates one daemon payload against the wire contract.
 *
 * @param payload - The raw message text.
 * @returns The typed message, or null when the payload is not a valid
 *   contract message.
 */
/** How many messages of each type this page has heard, and how many the contract refused, by their claimed type. */
const WIRE_TALLY: Record<string, number> = {};
// a page has a window; the client's unit tests run without one
if (typeof window !== 'undefined') (window as unknown as { __argusWire?: Record<string, number> }).__argusWire = WIRE_TALLY;

/**
 * Counts one message on the wire.
 *
 * @param type - The message's type, or `refused:<type>` for one the contract did not accept.
 */
function wire_tally(type: string): void {
  WIRE_TALLY[type] = (WIRE_TALLY[type] ?? 0) + 1;
}

/**
 * The type a payload claims, read without the contract, for the tally of refused messages.
 *
 * @param payload - The raw message text.
 * @returns The claimed type, or `?` when the text is not even JSON with one.
 */
function payloadType_parse(payload: string): string {
  try {
    const type: unknown = (JSON.parse(payload) as { type?: unknown }).type;
    return typeof type === 'string' ? type : '?';
  } catch {
    return '?';
  }
}

function message_parse(payload: string): ServerMessage | null {
  try {
    const parsed = serverMessage_parse(JSON.parse(payload));
    return parsed.ok && parsed.value !== undefined ? parsed.value : null;
  } catch {
    return null;
  }
}
