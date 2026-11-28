/**
 * @file The remote engine: a `BrasaEngine` backed by a daemon over the wire.
 *
 * This is the transport swap that lets the same REPL drive either an in-process
 * engine or a CALYPSO daemon. It implements the engine interface by sending
 * `execute` / `complete` messages over a WebSocket and awaiting the correlated
 * `result` / completion replies, validating every message against calypso's
 * wire contract at the boundary. Session-bus broadcasts (another surface's
 * activity) are delivered to an optional callback so the host can render them.
 *
 * @module
 */
import { WebSocket } from 'ws';
import chalk from 'chalk';
import { serverMessage_parse, CONTRACT_VERSION, RequestBroker, type ServerMessage } from '@fnndsc/calypso';
import type { CommandEnvelope } from '@fnndsc/cumin';
import type { BrasaEngine, CompletionResult } from '@fnndsc/brasa';
import { SERVER_MESSAGE_TYPES, type ClosingCause, type FileDeliverRequest, type FileDeliverResult } from '@fnndsc/menu';
import { builtinCommand_has, coreCommand_has, deliveryIntents_read, lineHostOperations_read, sourceIntents_settle, envelope_deliver, sink_get, sink_set, surface_set, type EngineRuns, type WordRoute, type LineHostOperations, type OutputSink, type Surface } from '@fnndsc/brasa';
import type { LocalEditResult } from '@fnndsc/menu/surface';
import { HeldOutput } from './heldOutput.js';
import { HostConsent, type ConsentAsk } from './hostConsent.js';
import { HostDesk, type HostDeskOptions } from './hostDesk.js';
import { promptFromContext_render } from '../core/prompt/session.js';
import { output_above } from '../core/lineDiscipline.js';
import { terminalId_parse } from '../core/terminalId.js';
import { HostPtyRelay, hostPtyTerminal_describe, type HostPtyDeclared, type HostPtyOutgoing, type HostPtyTerminal } from './hostPty.js';
import { TerminalOwner } from './terminalOwner.js';

/** Options for connecting a remote engine. */
export interface RemoteEngineOptions {
  /** The daemon WebSocket URL, e.g. `ws://127.0.0.1:4300`. */
  url: string;
  /** The attach token; empty when a door holds it and the headers carry the cookie instead. */
  token: string;
  /** Headers to send on the upgrade — a door's session cookie. */
  headers?: Record<string, string>;
  /** Called with each session-bus broadcast from another surface. */
  onSession?: (surface: string, envelope: CommandEnvelope) => void;
  /** The daemon says whether its own code on disk still matches what it runs. */
  onStale?: (stale: boolean) => void;
  /** Answers a prompt the daemon raised during a command (password, confirmation). */
  onPrompt?: (message: string, hidden: boolean, signal?: AbortSignal) => Promise<string>;
  /** Runs a pipeline segment on this machine and returns its output. */
  onPipe?: (command: string, input: Buffer) => Promise<Buffer>;
  /** Runs a host-shell command on this machine and returns its exit code. */
  onShell?: (command: string) => Promise<number>;
  /** Opens content in this machine's editor and returns the edited result. */
  onEdit?: (content: string, extension: string | undefined) => Promise<{ content: string; changed: boolean }>;
  onDeliver?: (request: FileDeliverRequest) => Promise<FileDeliverResult>;
  /**
   * Puts a question to the person on this chell's terminal: what the session asks beyond what a line asked for.
   * Absent where there is no terminal, and nothing is asked.
   */
  consentAsk?: ConsentAsk;
  /** `--allow-host-requests`: the session may run anything it asks on this machine until it disconnects. */
  allowHostRequests?: boolean;
  /**
   * This chell's terminal, when it has one: declared on attach, so a `!` the
   * daemon runs under host control gets a pty of its own drawn here.
   */
  terminal?: HostPtyTerminal;
  /** Called when the connection closes unexpectedly. */
  onClose?: () => void;
  /** Told why, when the daemon says it is going away before it does. */
  onClosing?: (cause: ClosingCause) => void;
}

/**
 * The daemon-reported stack identity from the attach handshake: its installed
 * chell and calypso versions plus the short build hash. Absent on daemons that
 * predate the field.
 *
 * @property chell - The daemon's installed chell version.
 * @property calypso - The daemon's installed calypso version.
 * @property build - The daemon's short build hash.
 */
export interface DaemonStack {
  chell: string;
  calypso: string;
  build: string;
  brasa?: string;
  chili?: string;
  salsa?: string;
  cumin?: string;
}

/**
 * A `BrasaEngine` implementation that drives a remote daemon.
 */
export class RemoteEngine implements BrasaEngine {
  private readonly ws: WebSocket;
  // The same correlation lifecycle the daemon uses for its surface-delegated
  // requests; here it correlates this client's execute/complete requests and
  // rejects them if the daemon connection closes first.
  private readonly requests: RequestBroker<unknown> = new RequestBroker<unknown>('r', 'daemon disconnected before replying');
  /** Message types from a newer daemon, each noted once then skipped. */
  private readonly unknownTypesSeen: Set<string> = new Set<string>();
  private readonly onSession: ((surface: string, envelope: CommandEnvelope) => void) | undefined;
  private readonly onPrompt: ((message: string, hidden: boolean, signal?: AbortSignal) => Promise<string>) | undefined;
  private readonly onPipe: ((command: string, input: Buffer) => Promise<Buffer>) | undefined;
  private readonly onShell: ((command: string) => Promise<number>) | undefined;
  private readonly onEdit: ((content: string, extension: string | undefined) => Promise<{ content: string; changed: boolean }>) | undefined;
  private readonly onDeliver: ((request: FileDeliverRequest) => Promise<FileDeliverResult>) | undefined;
  /** What the session asks this machine to run, checked against each line and the person's word (`hostDesk.ts`). */
  private readonly desk: HostDesk;
  /** The person's word for what no grant covers. */
  private readonly consent: HostConsent;
  /** What the session says, and this chell would note, while a question is put to the person. */
  private readonly hold: HeldOutput;
  /** Who holds this chell's terminal: a question, a command, the editor, a handed-over program, a prompt. */
  private readonly owner: TerminalOwner = new TerminalOwner();
  private readonly onClosing: ((cause: ClosingCause) => void) | undefined;
  private readonly onStale: ((stale: boolean) => void) | undefined;
  /** Hands this terminal to a program on the daemon's pty, when this chell is in one. */
  private readonly hostPty: HostPtyRelay | null;
  /** Whether the daemon said, at attach, that its code on disk had moved. */
  public daemonStale: boolean = false;
  private latestPrompt: string = '';
  private stackReport: DaemonStack | undefined;
  private backendId: string | undefined;
  /** Calypso's declared host-control tiers (empty when off). */
  public hostControl: string[] = [];
  /** Which words the session's engine runs itself, as it said at attach; null from a daemon that did not say. */
  private engineRuns: EngineRuns = null;
  /** Whether the connection has closed: a line read after it is not sent. */
  private closed: boolean = false;
  /** Aborted when the connection closes: withdraws the session's own questions. */
  private readonly connectionGone: AbortController = new AbortController();
  /** The session folder this chell last showed (the pushed prompt context); a relative download source binds under it. */
  private sessionCwd: string | null = null;
  /** Lines being read before they are sent, and those cancelled meanwhile (never sent). */
  private readonly preparing: Set<string> = new Set<string>();
  private readonly cancelledUnsent: Set<string> = new Set<string>();
  /** Lines are read and sent in the order they were asked for. */
  private sendOrder: Promise<void> = Promise.resolve();
  private nextId: number = 0;
  private activeExecuteId: string | undefined;
  /** Exit statuses the daemon sent with results, by request id, until the request reads them. */
  private readonly resultExits: Map<string, number> = new Map();
  /** The exit status of the last line run, until it is taken. */
  private lastExit: number = 0;
  private readonly liveEnvelopeChannels: Map<string, Set<'data' | 'err'>> = new Map<string, Set<'data' | 'err'>>();
  /**
   * The sink each running line was sent from. A line's live output arrives
   * on the socket's own callbacks, outside the caller's async context, so it
   * is routed to the sink active when the line was sent: a caller that
   * scoped a sink around a line (a quiet greeting, a capture) keeps it.
   */
  private readonly requestSinks: Map<string, OutputSink> = new Map<string, OutputSink>();

  /**
   * @param ws - An open, already-attached socket to the daemon.
   * @param options - The callbacks for session broadcasts and prompts.
   */
  private constructor(ws: WebSocket, options: RemoteEngineOptions) {
    this.ws = ws;
    this.onSession = options.onSession;
    this.onPrompt = options.onPrompt;
    this.onPipe = options.onPipe;
    this.onShell = options.onShell;
    this.onEdit = options.onEdit;
    this.onDeliver = options.onDeliver;
    this.onClosing = options.onClosing;
    this.onStale = options.onStale;
    this.hostPty = hostPtyTerminal_describe(options.terminal) !== undefined
      ? new HostPtyRelay(options.terminal as HostPtyTerminal, (message: HostPtyOutgoing): void => { this.ws.send(JSON.stringify(message)); })
      : null;
    this.consent = new HostConsent(options.consentAsk ?? null, options.allowHostRequests ?? false, this.owner);
    // What the session said while a question was open is shown once it is answered, in order.
    this.hold = new HeldOutput({
      question_isOpen: (): boolean => this.consent.question_isOpen(),
      message_handle: (payload: Buffer): void => { this.message_handle(payload); },
      overflow_answer: (raw: unknown): boolean => this.overflow_answer(raw),
    });
    this.consent.idle_set((): void => { this.hold.items_flush(); });
    this.desk = new HostDesk({
      message_send: (message: Record<string, unknown>): void => { this.ws.send(JSON.stringify(message)); },
      consent: this.consent,
      hostPty: this.hostPty,
      owner: this.owner,
      connection_fail: (reason: string): void => {
        this.notice_show(chalk.red(`[!] ${reason}: closing the connection`));
        this.close();
      },
      notice_show: (text: string): void => { this.notice_show(text); },
      ...handlers_compose(options),
    });
  }

  /**
   * Whether this session may run anything it asks on this machine until it disconnects (`--allow-host-requests`,
   * or `allow all` answered).
   *
   * @returns True when it may.
   *
   * @example
   * ```ts
   * if (remote.hostRequests_allAllowed()) say('this session may run anything it asks here');
   * ```
   */
  public hostRequests_allAllowed(): boolean {
    return this.consent.all_isAllowed();
  }

  /**
   * Answers a message that cannot wait past the hold's bound: the session's question is refused, a hand-over
   * refused, a program's end taken now; anything else may be dropped.
   *
   * @param raw - The parsed message.
   * @returns True when it was answered; false when it may be dropped.
   */
  private overflow_answer(raw: unknown): boolean {
    const held: object = typeof raw === 'object' && raw !== null ? raw : {};
    const type: unknown = Reflect.get(held, 'type');
    const promptId: unknown = Reflect.get(held, 'promptId');
    const ptyId: unknown = Reflect.get(held, 'ptyId');
    if (type === 'prompt' && typeof promptId === 'string') {
      this.ws.send(JSON.stringify({ type: 'promptError', promptId, reason: 'this terminal is answering another question' }));
    } else if (type === 'hostPtyStart' && typeof ptyId === 'string') {
      this.desk.pty_forget(ptyId);
      this.ws.send(JSON.stringify({ type: 'hostPtyRefuse', ptyId, reason: 'refused: this terminal is answering another question; nothing was handed over' }));
    } else if (type === 'hostPtyExit' && typeof ptyId === 'string') {
      this.hostPty?.exit(ptyId);
      this.desk.pty_end(ptyId);
    } else {
      return false;
    }
    return true;
  }

  /**
   * Connects to a daemon, performs the attach handshake, and returns a ready
   * remote engine.
   *
   * @param options - The daemon URL, attach token, and callbacks.
   * @returns The connected remote engine.
   * @throws {Error} When the connection fails or the attach is refused.
   */
  public static connect(options: RemoteEngineOptions): Promise<RemoteEngine> {
    return new Promise((resolve: (engine: RemoteEngine) => void, reject: (err: Error) => void) => {
      const ws: WebSocket = new WebSocket(options.url, options.headers !== undefined ? { headers: options.headers } : {});

      ws.once('error', (err: Error) => reject(err));

      ws.once('open', () => {
        const tty: HostPtyDeclared | undefined = hostPtyTerminal_describe(options.terminal);
        ws.send(JSON.stringify({
          type: 'attach',
          protocolVersion: CONTRACT_VERSION,
          token: options.token,
          capabilities: {
            shellCommands: options.onShell !== undefined,
            hiddenInput: options.onPrompt !== undefined,
            fileDelivery: options.onDeliver !== undefined,
            // chalk answers for the client terminal this shell writes to.
            color: chalk.level > 0,
            // A shell has a disk and directories wherever it runs, so a folder
            // it asks for arrives as a folder rather than an archive of one.
            localFilesystem: options.onDeliver !== undefined,
            // A browser's terminal names itself, so the daemon knows whose
            // console this chell is (the daemon sets CHELL_TERMINAL).
            ...(terminalId_parse(process.env['CHELL_TERMINAL']) !== null ? { terminal: terminalId_parse(process.env['CHELL_TERMINAL']) as string } : {}),
            // A terminal of its own: a `!` the daemon runs gets a pty drawn here.
            ...(tty !== undefined ? { tty } : {}),
          },
        }));
        ws.once('message', (data: Buffer) => {
          const parsed = serverMessage_parse(safeJson_parse(data.toString()));
          if (!parsed.ok || parsed.value === undefined) {
            reject(new Error(`attach failed: ${parsed.error ?? 'invalid response'}`));
            ws.close();
            return;
          }
          const message: ServerMessage = parsed.value;
          if (message.type === 'error') {
            reject(new Error(`attach refused: ${message.reason}`));
            ws.close();
            return;
          }
          if (message.type !== 'attached') {
            reject(new Error(`unexpected attach response: ${message.type}`));
            ws.close();
            return;
          }
          const engine: RemoteEngine = new RemoteEngine(ws, options);
          engine.stackReport = message.stack;
          engine.daemonStale = message.stale === true;
          engine.hostControl = message.hostControl ?? [];
          engine.backendId = message.backend;
          engine.engineRuns = engineRoute_compose(message.backend, message.engineCommands);
          ws.on('message', (payload: Buffer) => engine.message_handle(payload));
          // A closed connection's lines ask for nothing more here, and the terminal is this chell's again.
          ws.on('close', (): void => { engine.line_retire(); });
          if (options.onClose) {
            ws.on('close', () => options.onClose?.());
          }
          resolve(engine);
        });
      });
    });
  }

  /** @inheritdoc */
  public async line_execute(line: string): Promise<CommandEnvelope[]> {
    const id: string = String(this.nextId++);
    // The line is this chell's from now: a cancel while it is read stops it before it is sent.
    this.activeExecuteId = id;
    this.preparing.add(id);
    // What the line asks to have run here, read from the line itself (by the session's own words) before the
    // daemon sees it: a request is run only against this, once. Lines are read and sent in order.
    const reading: Promise<LineHostOperations> = this.sendOrder.then((): Promise<LineHostOperations> => lineHostOperations_read(line, this.engineRuns));
    this.sendOrder = reading.then((): void => undefined, (): void => undefined);
    let operations: LineHostOperations;
    try {
      operations = await reading;
    } finally {
      this.preparing.delete(id);
    }
    if (this.closed) throw new Error('the session closed before the line was sent');
    if (this.cancelledUnsent.delete(id)) {
      if (this.activeExecuteId === id) this.activeExecuteId = undefined;
      return [];
    }
    this.activeExecuteId = id;
    this.requestSinks.set(id, sink_get());
    // What this line asks to have written here (its sources settled against the session folder shown now): a
    // delivery is honoured only against this. Registered with its grants immediately before the line is sent.
    this.desk.line_open(id, line, operations, sourceIntents_settle(deliveryIntents_read(line, this.backendId), this.sessionCwd));
    let envelopes: CommandEnvelope[];
    try {
      envelopes = await this.request<CommandEnvelope[]>('execute', { line }, id);
    } catch (error: unknown) {
      // Retired at once; the failure is shown once no question is open, never over one.
      this.line_settle(id);
      await this.consent.idle_wait();
      throw error;
    }
    // A daemon that names no status leaves the envelopes to say it.
    this.lastExit = this.resultExits.get(id) ?? (envelopes.some((envelope: CommandEnvelope): boolean => envelope.status === 'error') ? 1 : 0);
    const liveChannels: Set<'data' | 'err'> | undefined = this.liveEnvelopeChannels.get(id);
    this.liveEnvelopeChannels.delete(id);
    this.line_settle(id);
    // The line is retired at once; what it said is shown once no question is open, never over one.
    await this.consent.idle_wait();
    // Deliver to the active sink exactly as the in-process engine delivers
    // live, so the REPL host renders remote output without any change.
    for (const envelope of envelopes) {
      envelope_deliver(liveChannels ? {
        ...envelope,
        rendered: liveChannels.has('data') ? '' : envelope.rendered,
        renderedErr: liveChannels.has('err') ? undefined : envelope.renderedErr,
      } : envelope);
    }
    return envelopes;
  }

  /**
   * A line has its answer (or its failure): it is no longer this chell's active line, and it is retired at once.
   *
   * @param id - The line.
   */
  private line_settle(id: string): void {
    if (this.activeExecuteId === id) this.activeExecuteId = undefined;
    this.requestSinks.delete(id);
    this.line_retire(id);
    this.resultExits.delete(id);
  }

  /**
   * Whether the connection has closed (read afresh: it closes while a question waits).
   *
   * @returns True once it has.
   */
  private connection_isGone(): boolean {
    return this.connectionGone.signal.aborted;
  }

  /**
   * Shows a note to the person, never over an open question (after it, within the same bound), never once closed.
   *
   * @param text - The note.
   */
  private notice_show(text: string): void {
    this.hold.notice_show(text);
  }


  /**
   * The exit status of the last line this surface ran on the daemon, as
   * `$?` holds it there, and forgets it: a line run on this machine instead
   * (a surface command) then reads 0, not an earlier line's status.
   *
   * @returns The status; 0 when no line has run since it was last taken.
   */
  public exitCode_take(): number {
    const code: number = this.lastExit;
    this.lastExit = 0;
    return code;
  }

  /** @inheritdoc */
  public line_cancel(): boolean {
    if (this.activeExecuteId === undefined) return false;
    // Still being read: it is never sent.
    if (this.preparing.has(this.activeExecuteId)) {
      this.cancelledUnsent.add(this.activeExecuteId);
      return true;
    }
    // A cancelled line asks for nothing more here, whatever the daemon still sends.
    this.line_retire(this.activeExecuteId);
    this.ws.send(JSON.stringify({ type: 'cancel', id: this.activeExecuteId }));
    return true;
  }

  /**
   * Retires everything a line may have done here, at once: its grants, its deliveries, and the terminal if it was
   * handed to the line's program. Without a line, every line's (the connection closed).
   *
   * @param lineId - The line, or none for all.
   */
  private line_retire(lineId?: string): void {
    if (lineId === undefined) {
      this.closed = true;
      // The session's own questions, waiting or open, are withdrawn: no answer goes to a closed connection.
      this.connectionGone.abort();
      // What the session said before it went is not replayed after.
      this.hold.hold_close();
    }
    this.desk.line_retire(lineId);
  }

  /**
   * Installs this process's sink: a remote engine's output is delivered here,
   * through the local sink, as the in-process engine's is.
   *
   * @param sink - The sink.
   */
  public sink_install(sink: OutputSink): void {
    sink_set(sink);
  }

  /**
   * Installs this process's surface, which answers what the daemon delegates
   * back to this terminal (prompts, pipes, the shell, edits, deliveries).
   *
   * @param surface - The surface.
   */
  public surface_install(surface: Surface): void {
    surface_set(surface);
  }

  /** @inheritdoc */
  public line_complete(linePrefix: string): Promise<CompletionResult> {
    return this.request<CompletionResult>('complete', { prefix: linePrefix });
  }

  /**
   * Sends a correlated request and returns a promise for its reply.
   *
   * @param type - The request message type.
   * @param fields - The message fields besides `type` and `id`.
   * @returns The reply payload.
   */
  private request<T>(type: 'execute' | 'complete', fields: Record<string, string>, requestId?: string): Promise<T> {
    const id: string = requestId ?? String(this.nextId++);
    return this.requests.openWithId(id, this.ws, (correlationId: string): void => {
      this.ws.send(JSON.stringify({ type, id: correlationId, ...fields }));
    }) as Promise<T>;
  }

  /**
   * Dispatches a message from the daemon: correlated replies resolve their
   * pending request, session broadcasts reach the callback, and uncorrelated
   * errors are surfaced.
   *
   * @param payload - The raw message bytes.
   */
  private message_handle(payload: Buffer): void {
    const raw: unknown = safeJson_parse(payload.toString());
    // A hand-over received is registered before it may be held, so the program's end, which is never held, cancels it.
    const announced: unknown = typeof raw === 'object' && raw !== null && Reflect.get(raw, 'type') === 'hostPtyStart' ? Reflect.get(raw, 'ptyId') : undefined;
    if (typeof announced === 'string') this.desk.pty_announce(announced);
    // While a question is put to the person, the terminal is the question's: what the session says waits, except
    // a line's end (which answers its questions) and its requests (which wait their own turn).
    if (this.hold.message_take(payload, raw)) return;
    const parsed = serverMessage_parse(raw);
    if (!parsed.ok || parsed.value === undefined) {
      // A well-formed message of a type this client does not know is a
      // newer daemon speaking a wider vocabulary — the open-world rule says
      // skip it, and say so once per type rather than once per second.
      const rawType: string | undefined =
        typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string'
          ? (raw as { type: string }).type
          : undefined;
      const unknownType: string | undefined =
        rawType !== undefined && !SERVER_MESSAGE_TYPES.has(rawType) ? rawType : undefined;
      if (unknownType !== undefined) {
        if (!this.unknownTypesSeen.has(unknownType)) {
          this.unknownTypesSeen.add(unknownType);
          this.notice_show(chalk.dim(`[i] The daemon sends '${unknownType}' messages this chell predates; ignoring them.`));
        }
        return;
      }
      // A malformed message is real protocol drift; dropping it silently
      // would leave any correlated pending request hanging unexplained.
      this.notice_show(chalk.yellow(`[!] Ignoring invalid message from calypso: ${parsed.ok ? 'empty payload' : (parsed.error ?? 'unparseable')}`));
      return;
    }
    const message: ServerMessage = parsed.value;
    switch (message.type) {
      case 'result':
        if (message.exitCode !== undefined) this.resultExits.set(message.id, message.exitCode);
        // The line is over the moment its result is read: everything it asked to
        // have done here is forgotten, before anything that waits on it runs, so
        // a request read straight after the result finds nothing to match.
        this.line_retire(message.id);
        this.requests.settle(this.ws, message.id, message.envelopes);
        break;
      case 'complete':
        this.requests.settle(this.ws, message.id, { candidates: message.candidates, prefix: message.prefix });
        break;
      case 'session':
        // The wire envelope is a CommandEnvelope; calypso's schema infers the
        // model payload as optional-unknown, a zod nicety the runtime shape
        // does not reflect. Narrow at this single boundary.
        if (this.onSession) this.onSession(message.surface, message.envelope as CommandEnvelope);
        break;
      case 'prompt':
        void this.prompt_answer(message.promptId, message.message, message.hidden);
        break;
      case 'promptline':
        // Render the daemon's context with this surface's own theme, so a
        // remote prompt looks the way the local operator configured it.
        this.latestPrompt = promptFromContext_render(message.context);
        // The folder the person sees the session in: a relative download source of their next line is under it.
        this.sessionCwd = message.context.cwd.startsWith('/') ? message.context.cwd : null;
        break;
      case 'progress':
        {
          const { type: _type, id: _id, ...event } = message;
          this.sink_resolve(_id).progress_write(event);
        }
        break;
      case 'event':
        sink_get().event_write?.(message.kind, message.data);
        break;
      case 'output':
        if (message.channel === 'data' || message.channel === 'err') {
          const channels: Set<'data' | 'err'> = this.liveEnvelopeChannels.get(message.id) ?? new Set<'data' | 'err'>();
          channels.add(message.channel);
          this.liveEnvelopeChannels.set(message.id, channels);
        }
        this.output_render(message.channel, message.chunk, message.id);
        break;
      case 'pipe':
        void this.desk.pipe_run(message.pipeId, message.command, message.input, message.lineId);
        break;
      case 'shell':
        void this.desk.shell_run(message.shellId, message.command, message.lineId);
        break;
      case 'edit':
        void this.desk.edit_run(message.editId, message.content, message.named, message.lineId);
        break;
      case 'deliver':
        void this.desk.deliver_run(message.deliverId, message.id, {
          path: message.path,
          filename: message.filename,
          ...(message.destination !== undefined ? { destination: message.destination } : {}),
          ...(message.size !== undefined ? { size: message.size } : {}),
          ...(message.contentType !== undefined ? { contentType: message.contentType } : {}),
          ...(message.source !== undefined ? { source: message.source } : {}),
        });
        break;
      case 'closing':
        this.onClosing?.(message.cause);
        break;
      case 'hostPtyStart':
        void this.desk.hostPty_start(message.ptyId, message.lineId, message.command);
        break;
      case 'hostPtyData':
        this.hostPty?.data(message.ptyId, message.data);
        break;
      case 'hostPtyExit':
        this.hostPty?.exit(message.ptyId);
        this.desk.pty_end(message.ptyId);
        break;
      case 'consoleNote':
        // A note from the browser this console belongs to: above the line
        // being typed, which is then drawn again.
        output_above(message.text.endsWith('\n') ? message.text : `${message.text}\n`);
        break;
      case 'stale':
        this.daemonStale = message.stale;
        this.onStale?.(message.stale);
        break;
      case 'error':
        if (message.id !== undefined) {
          // As at a result: an ended line asks for nothing more.
          this.line_retire(message.id);
          this.requests.fail(this.ws, message.id, message.reason);
        }
        break;
      default:
        break;
    }
  }

  /**
   * Answers a prompt the daemon raised: asks the local surface and sends the
   * answer back. With no prompt handler, answers empty so the command does not
   * hang.
   *
   * @param promptId - The prompt correlation id.
   * @param message - The prompt text.
   * @param hidden - Whether the entry should be hidden (a password).
   */
  private async prompt_answer(promptId: string, message: string, hidden: boolean): Promise<void> {
    try {
      if (!this.onPrompt) {
        // A silent empty answer would let the command proceed on fabricated
        // input; an inability to prompt is a failure and reports as one.
        throw new Error('this surface cannot prompt');
      }
      // The session's own question holds the terminal, after whoever holds it: nothing is asked over it, and a
      // connection that closes meanwhile withdraws it, waiting or open.
      const gone: AbortSignal = this.connectionGone.signal;
      const terminal_release: () => void = await this.owner.terminal_take('prompt', gone);
      let answer: string;
      try {
        answer = await this.onPrompt(message, hidden, gone);
      } finally {
        terminal_release();
      }
      if (this.connection_isGone()) return;
      this.ws.send(JSON.stringify({ type: 'promptAnswer', promptId, answer }));
    } catch (error: unknown) {
      if (this.connection_isGone()) return;
      const reason: string = error instanceof Error ? error.message : String(error);
      this.ws.send(JSON.stringify({ type: 'promptError', promptId, reason }));
    }
  }

  /**
   * The sink a line's output goes to: the one it was sent from, else the active one.
   *
   * @param id - The line, when known.
   * @returns The sink.
   */
  private sink_resolve(id: string | undefined): OutputSink {
    return (id !== undefined ? this.requestSinks.get(id) : undefined) ?? sink_get();
  }

  /**
   * Renders a streamed output chunk to the local sink on its channel.
   *
   * @param channel - The sink channel the chunk belongs to.
   * @param chunk - The streamed text.
   * @param id - The line it belongs to, when known.
   */
  private output_render(channel: 'data' | 'err' | 'status', chunk: string, id?: string): void {
    const sink: OutputSink = this.sink_resolve(id);
    if (channel === 'data') {
      sink.data_write(chunk);
    } else if (channel === 'err') {
      sink.err_write(chunk);
    } else {
      sink.status_write(chunk);
    }
  }

  /**
   * The latest themed prompt string the daemon pushed, or empty before the
   * first push.
   *
   * @returns The current prompt string.
   */
  public promptLine(): string {
    // Said where the person looks, every line: this session may run anything it asks here.
    return this.consent.all_isAllowed() ? `${chalk.red('[host: all allowed] ')}${this.latestPrompt}` : this.latestPrompt;
  }

  /**
   * The stack identity the daemon reported in its attach handshake.
   *
   * @returns The daemon's versions and build hash, or undefined when the
   *   daemon predates the field.
   */
  public daemonStack(): DaemonStack | undefined {
    return this.stackReport;
  }

  /**
   * The backend the daemon's session runs over, from its attach answer.
   *
   * @returns The backend id (`chris`, `stratus`, `null`), or undefined when
   *   the daemon predates the field.
   */
  public backend_get(): string | undefined {
    return this.backendId;
  }

  /**
   * Closes the connection.
   */
  public close(): void {
    // Everything the connection's lines may do here ends as the close begins, not when the socket says so.
    this.line_retire();
    this.ws.close();
  }
}

/**
 * Parses JSON, returning `undefined` on failure so callers can validate the
 * result rather than catch.
 *
 * @param text - The JSON text.
 * @returns The parsed value, or undefined when the text is not valid JSON.
 */
function safeJson_parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The runners a desk is given: this chell's own handlers, each only when it has one. */
type DeskHandlers = Pick<HostDeskOptions, 'segment_run' | 'shellCommand_run' | 'editor_open' | 'file_deliver'>;

/**
 * The desk's runners from this chell's own handlers.
 *
 * @param options - The engine's options.
 * @returns The runners it has.
 */
function handlers_compose(options: RemoteEngineOptions): DeskHandlers {
  const pipe_run = options.onPipe;
  const shell_run = options.onShell;
  const edit_run = options.onEdit;
  const file_put = options.onDeliver;
  return {
    ...(pipe_run !== undefined ? { segment_run: (command: string, input: Buffer): Promise<Buffer> => pipe_run(command, input) } : {}),
    ...(shell_run !== undefined ? { shellCommand_run: (command: string): Promise<number> => shell_run(command) } : {}),
    ...(edit_run !== undefined ? { editor_open: (content: string, extension: string | undefined): Promise<LocalEditResult> => edit_run(content, extension) } : {}),
    ...(file_put !== undefined ? { file_deliver: (request: FileDeliverRequest): Promise<FileDeliverResult> => file_put(request) } : {}),
  };
}

/**
 * Where the session's engine runs each word, as far as this chell can know it: both this chell's catalogue for the
 * attached backend and the session's list must agree. This chell holds the core's catalogue and the ChRIS
 * backend's; for any other backend a word outside the core is not known here, and a pipeline with it is put to the
 * person rather than granted. A session that lists nothing grants no pipeline.
 *
 * @param backend - The attached session's backend.
 * @param listed - The words the session says its engine runs.
 * @returns The routing, or null.
 */
function engineRoute_compose(backend: string | undefined, listed: readonly string[] | undefined): EngineRuns {
  if (listed === undefined) return null;
  const words: Set<string> = new Set<string>(listed);
  const catalogued: boolean = backend === 'chris';
  return (word: string): WordRoute => {
    const local: boolean = catalogued ? builtinCommand_has(word) : coreCommand_has(word);
    const said: boolean = words.has(word);
    if (local && said) return 'engine';
    if (!local && !said && catalogued) return 'host';
    // Disagreeing, or outside the core of a backend whose catalogue is not here.
    return 'unknown';
  };
}
