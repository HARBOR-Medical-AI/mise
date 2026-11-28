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
import { deliveryIntent_matches, deliveryIntents_read, lineHostOperations_read, envelope_deliver, sink_get, sink_set, surface_set, type DeliveryIntent, type OutputSink, type Surface } from '@fnndsc/brasa';
import { promptFromContext_render } from '../core/prompt/session.js';
import { HostGrantBook } from './hostGrants.js';
import { output_above } from '../core/lineDiscipline.js';
import { terminalId_parse } from '../core/terminalId.js';
import { HostPtyRelay, hostPtyTerminal_describe, type HostPtyDeclared, type HostPtyOutgoing, type HostPtyTerminal } from './hostPty.js';

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
  onPrompt?: (message: string, hidden: boolean) => Promise<string>;
  /** Runs a pipeline segment on this machine and returns its output. */
  onPipe?: (command: string, input: Buffer) => Promise<Buffer>;
  /** Runs a host-shell command on this machine and returns its exit code. */
  onShell?: (command: string) => Promise<number>;
  /** Opens content in this machine's editor and returns the edited result. */
  onEdit?: (content: string, extension: string | undefined) => Promise<{ content: string; changed: boolean }>;
  onDeliver?: (request: FileDeliverRequest) => Promise<FileDeliverResult>;
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
  private readonly onPrompt: ((message: string, hidden: boolean) => Promise<string>) | undefined;
  private readonly onPipe: ((command: string, input: Buffer) => Promise<Buffer>) | undefined;
  private readonly onShell: ((command: string) => Promise<number>) | undefined;
  private readonly onEdit: ((content: string, extension: string | undefined) => Promise<{ content: string; changed: boolean }>) | undefined;
  private readonly onDeliver: ((request: FileDeliverRequest) => Promise<FileDeliverResult>) | undefined;
  /** What each line in flight asked to have delivered here, by its request id. */
  private readonly deliveryIntents: Map<string, DeliveryIntent[]> = new Map<string, DeliveryIntent[]>();
  /** What each line in flight asked to have run here (host commands, pipeline segments, edits), by its request id. */
  private readonly hostGrants: HostGrantBook = new HostGrantBook();
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
          ws.on('message', (payload: Buffer) => engine.message_handle(payload));
          // A closed connection's lines ask for nothing more here.
          ws.on('close', (): void => { engine.hostGrants.all_close(); });
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
    this.activeExecuteId = id;
    this.requestSinks.set(id, sink_get());
    // What this line asks to have written here, read from the line itself
    // before the daemon sees it: a delivery is honoured only against this.
    this.deliveryIntents.set(id, deliveryIntents_read(line, this.backendId));
    try {
      // And what it asks to have run here, read the same way: a request is run only against this, once.
      this.hostGrants.line_open(id, await lineHostOperations_read(line));
      const envelopes: CommandEnvelope[] = await this.request<CommandEnvelope[]>('execute', { line }, id);
      // A daemon that names no status leaves the envelopes to say it.
      this.lastExit = this.resultExits.get(id) ?? (envelopes.some((envelope: CommandEnvelope): boolean => envelope.status === 'error') ? 1 : 0);
      const liveChannels: Set<'data' | 'err'> | undefined = this.liveEnvelopeChannels.get(id);
      this.liveEnvelopeChannels.delete(id);
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
    } finally {
      if (this.activeExecuteId === id) this.activeExecuteId = undefined;
      this.requestSinks.delete(id);
      this.deliveryIntents.delete(id);
      this.hostGrants.line_close(id);
      this.resultExits.delete(id);
    }
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
    // A cancelled line asks for nothing more here, whatever the daemon still sends.
    this.hostGrants.line_close(this.activeExecuteId);
    this.ws.send(JSON.stringify({ type: 'cancel', id: this.activeExecuteId }));
    return true;
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
          console.error(chalk.dim(
            `[i] The daemon sends '${unknownType}' messages this chell predates; ignoring them.`,
          ));
        }
        return;
      }
      // A malformed message is real protocol drift; dropping it silently
      // would leave any correlated pending request hanging unexplained.
      console.error(chalk.yellow(`[!] Ignoring invalid message from calypso: ${parsed.ok ? 'empty payload' : (parsed.error ?? 'unparseable')}`));
      return;
    }
    const message: ServerMessage = parsed.value;
    switch (message.type) {
      case 'result':
        if (message.exitCode !== undefined) this.resultExits.set(message.id, message.exitCode);
        // The line is over the moment its result is read: what it asked to have
        // delivered is forgotten here, before anything that waits on it runs, so
        // a delivery read straight after the result finds nothing to match.
        this.deliveryIntents.delete(message.id);
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
        void this.pipe_run(message.pipeId, message.command, message.input, message.lineId);
        break;
      case 'shell':
        void this.shell_run(message.shellId, message.command, message.lineId);
        break;
      case 'edit':
        void this.edit_run(message.editId, message.content, message.extension, message.lineId, message.path);
        break;
      case 'deliver':
        void this.deliver_run(message.deliverId, message.id, {
          path: message.path,
          filename: message.filename,
          ...(message.destination !== undefined ? { destination: message.destination } : {}),
          ...(message.size !== undefined ? { size: message.size } : {}),
          ...(message.contentType !== undefined ? { contentType: message.contentType } : {}),
        });
        break;
      case 'closing':
        this.onClosing?.(message.cause);
        break;
      case 'hostPtyStart':
        this.hostPty?.start(message.ptyId);
        break;
      case 'hostPtyData':
        this.hostPty?.data(message.ptyId, message.data);
        break;
      case 'hostPtyExit':
        this.hostPty?.exit(message.ptyId);
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
          this.deliveryIntents.delete(message.id);
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
      const answer: string = await this.onPrompt(message, hidden);
      this.ws.send(JSON.stringify({ type: 'promptAnswer', promptId, answer }));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.ws.send(JSON.stringify({ type: 'promptError', promptId, reason }));
    }
  }

  /**
   * Runs a pipeline segment the daemon asked for on this machine and returns
   * its output. Data crosses the wire base64-encoded. With no pipe handler,
   * returns the input unchanged so the pipeline does not hang.
   *
   * @param pipeId - The pipe correlation id.
   * @param command - The segment command line.
   * @param input - The base64-encoded input bytes.
   * @param lineId - The line the daemon says is asking, by this chell's id.
   */
  private async pipe_run(pipeId: string, command: string, input: string, lineId: string | undefined): Promise<void> {
    const inputBytes: Buffer = Buffer.from(input, 'base64');
    try {
      // Spent before anything runs: a segment the line sent from here did not ask for runs nothing.
      const refusal: string | null = this.hostGrants.grant_take(lineId, { kind: 'pipe', command });
      if (refusal !== null) throw new Error(refusal);
      if (!this.onPipe) {
        // Passing input through unchanged would silently turn the segment
        // into a no-op; an inability to run it is a failure.
        throw new Error('this surface cannot run pipeline segments');
      }
      const output: Buffer = await this.onPipe(command, inputBytes);
      this.ws.send(JSON.stringify({ type: 'pipeResult', pipeId, output: output.toString('base64') }));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.ws.send(JSON.stringify({ type: 'pipeError', pipeId, reason }));
    }
  }

  /**
   * Runs a host-shell command the daemon delegated to this surface and returns
   * only its exit status; the process owns this surface's terminal directly.
   *
   * @param shellId - Correlation id for the shell request.
   * @param command - The shell command without the leading `!`.
   * @param lineId - The line the daemon says is asking, by this chell's id.
   */
  private async shell_run(shellId: string, command: string, lineId: string | undefined): Promise<void> {
    try {
      const refusal: string | null = this.hostGrants.grant_take(lineId, { kind: 'shell', command });
      if (refusal !== null) throw new Error(refusal);
      if (!this.onShell) {
        throw new Error('this surface cannot run shell commands');
      }
      const exitCode: number = await this.onShell(command);
      this.ws.send(JSON.stringify({ type: 'shellResult', shellId, exitCode }));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.ws.send(JSON.stringify({ type: 'shellError', shellId, reason }));
    }
  }

  /**
   * Opens content in this machine's editor (the daemon asked for it) and
   * returns the edited result. With no edit handler, returns the content
   * unchanged so the command does not hang.
   *
   * @param editId - The edit correlation id.
   * @param content - The content to edit.
   * @param extension - An optional filename extension.
   * @param lineId - The line the daemon says is asking, by this chell's id.
   * @param path - The file the daemon names.
   */
  private async edit_run(editId: string, content: string, extension: string | undefined, lineId: string | undefined, path: string | undefined): Promise<void> {
    try {
      const refusal: string | null = this.hostGrants.grant_take(lineId, { kind: 'edit', path });
      if (refusal !== null) throw new Error(refusal);
      if (!this.onEdit) {
        // Returning the content unchanged would report a successful edit that
        // never happened; an inability to edit is a failure.
        throw new Error('this surface cannot edit');
      }
      const result: { content: string; changed: boolean } = await this.onEdit(content, extension);
      this.ws.send(JSON.stringify({ type: 'editResult', editId, content: result.content, changed: result.changed }));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.ws.send(JSON.stringify({ type: 'editError', editId, reason }));
    }
  }

  /**
   * Refuses a delivery this client did not ask for.
   *
   * The daemon names where on this machine a file is to be written. That is
   * honoured only against one line: the line the daemon says is asking, by
   * the id this client gave it, while that line is still in flight here;
   * and only when the place named is the destination that line's own
   * delivering command gave (`deliveryIntents_read`). Another line running
   * beside it lends it nothing. A source path, a word of another command, a
   * delivery after its line has ended, a destination written as a
   * reference, or one the daemon made up are all refused, by name.
   *
   * A daemon that does not say which line is asking is refused: without the
   * line, a delivery that is late cannot be told from one that was asked for.
   * The refusal says the daemon is the older of the two.
   *
   * @param executeId - This client's id for the asking line, as the daemon gave it.
   * @param request - The delivery the daemon asked for.
   * @throws {Error} When that line is not in flight, or did not ask for a delivery to that place.
   */
  private delivery_require(executeId: string | undefined, request: FileDeliverRequest): void {
    const where: string = request.destination !== undefined && request.destination.length > 0 ? JSON.stringify(request.destination) : 'the working directory';
    const asked: string = `the session asked to write ${JSON.stringify(request.filename)} to ${where}`;
    if (executeId === undefined) {
      throw new Error(`refused: ${asked} and did not say which line asked for it, so it cannot be told from a delivery that is late or was never asked for; nothing was written. The session's daemon is older than this chell: upgrade the daemon`);
    }
    const intents: DeliveryIntent[] | undefined = this.deliveryIntents.get(executeId);
    if (intents === undefined) throw new Error(`refused: ${asked} for a line that is not running here; nothing was written`);
    if (intents.length === 0) throw new Error(`refused: ${asked}, and the line sent from here asks for no file; nothing was written`);
    if (deliveryIntent_matches(intents, request.destination)) return;
    const unbound: DeliveryIntent | undefined = intents.find((intent: DeliveryIntent): boolean => intent.unbound !== undefined);
    if (unbound !== undefined) throw new Error(`refused: ${asked}, and the line sent from here cannot say where: ${unbound.unbound}; nothing was written`);
    const named: string = intents.map((intent: DeliveryIntent): string => (intent.destination === null ? 'the working directory' : JSON.stringify(intent.destination))).join(', ');
    throw new Error(`refused: ${asked}, and the line sent from here named ${named}; nothing was written`);
  }

  /**
   * Places a file on this client's machine at the daemon's request.
   *
   * @param deliverId - The delivery correlation id.
   * @param executeId - This client's id for the line the daemon says is asking; absent from an older daemon, whose delivery is refused.
   * @param request - What to deliver and where the operator asked for it.
   */
  private async deliver_run(deliverId: string, executeId: string | undefined, request: FileDeliverRequest): Promise<void> {
    try {
      if (!this.onDeliver) {
        // Reporting success for a file nobody received would be worse than
        // failing: the operator would go looking for it.
        throw new Error('this surface cannot receive a file');
      }
      this.delivery_require(executeId, request);
      const result: FileDeliverResult = await this.onDeliver(request);
      this.ws.send(JSON.stringify({
        type: 'deliverResult', deliverId, location: result.location, bytes: result.bytes,
      }));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.ws.send(JSON.stringify({ type: 'deliverError', deliverId, reason }));
    }
  }

  /**
   * Renders a streamed output chunk to the local sink on its channel.
   *
   * @param channel - The sink channel the chunk belongs to.
   * @param chunk - The streamed text.
   */
  /** The sink a line's output goes to: the one it was sent from, else the active one. */
  private sink_resolve(id: string | undefined): OutputSink {
    return (id !== undefined ? this.requestSinks.get(id) : undefined) ?? sink_get();
  }

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
    return this.latestPrompt;
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
