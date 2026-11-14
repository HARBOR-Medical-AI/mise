/**
 * @file The CALYPSO daemon: a WebSocket host over one engine, with a session
 * bus.
 *
 * The daemon binds the loopback interface only and hosts a single hosted
 * engine. A surface attaches with the contract version and the attach token
 * (compared in constant time); once attached it drives the engine with
 * `execute` and `complete` messages and receives `result` and completion
 * replies. Command execution is serialized per connection — shell semantics,
 * and what keeps each command's error boundary correct.
 *
 * All attached surfaces share one session. A **session bus** broadcasts every
 * result envelope to the *other* attached surfaces (tagged with the surface
 * that produced it), so a command issued in one surface is immediately
 * visible in the rest. A bounded **scrollback** ring buffer of recent
 * envelopes is replayed to an attaching surface so it does not join blind;
 * scrollback is presentation, not truth — a daemon restart loses it, which is
 * correct, and the durable record is an opt-in transcript materialized to
 * CUBE.
 *
 * CUBE credentials never cross the wire: the engine the daemon hosts holds its
 * own CUBE session, established by the launcher exactly as the CLI does;
 * surfaces authenticate to the daemon, not to CUBE.
 *
 * @module
 */
import type { ElevationDoor } from './elevation.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { HostedEngine, CompletionResult } from './engine.js';
import { staticRequest_handle, contentDisposition_format, contentType_derive } from './static.js';
import { token_matches } from './token.js';
import { RequestBroker } from './broker.js';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import { clientMessage_parse, attach_parse } from '@fnndsc/menu';
import type { ServerMessage, executeMessageSchema, completeRequestSchema, cancelMessageSchema, stopMessageSchema, ProgressEvent, PromptContext, PromptKind, PromptPath, FileDeliverRequest, Regard, WatchState, AmbientEvent, ClosingCause } from '@fnndsc/menu';
import type { z } from 'zod';
import type { Terminals, TerminalViewer } from './terminals.js';
import { Lane, LOCKS_ALL, type Hold, type LockSet } from './lane.js';
import { claim_match, claimCandidates_list, type SurfaceClaim } from './claims.js';
import { DownloadLedger, downloadId_valid, type DownloadReport, type OpenedFile } from './downloads.js';
import { byteStream_normalise, errorFacts_read, vfsBreak_format } from './vfsBreak.js';

/**
 * The largest file `POST /vfs` will take, in bytes.
 *
 * A cap rather than a stream to the store: the route exists so an operator
 * can put a document, a manifest or an image into the folder they are
 * looking at, and a surface able to post unbounded bytes to a loopback port
 * is a surface able to fill the machine.
 */
const VFS_POST_LIMIT: number = 256 * 1024 * 1024;
import type { CommandEnvelope } from '@fnndsc/cumin';

/**
 * The hosting process's stack identity, sent to surfaces in the attach ack.
 * Injected by the host (which resolves it from brasa) rather than resolved
 * here, keeping the transport server free of engine dependencies.
 *
 * @property chell - The daemon's installed chell version.
 * @property calypso - The daemon's installed calypso version.
 * @property build - The daemon's short build hash.
 * @property surface - The web bundle's build stamp as it stood when the
 *   daemon started, when the bundle carries one.
 */
export interface DaemonStackInfo {
  chell: string;
  calypso: string;
  build: string;
  surface?: { git: string; built: string };
  brasa?: string;
  chili?: string;
  salsa?: string;
  cumin?: string;
}

type ExecuteMessage = z.infer<typeof executeMessageSchema>;
type CompleteRequest = z.infer<typeof completeRequestSchema>;
type CancelMessage = z.infer<typeof cancelMessageSchema>;
type StopMessage = z.infer<typeof stopMessageSchema>;

/** How long a stopped command has to end before the session abandons it. */
export const STOP_GRACE_MS: number = 3000;

/** How long a STOP pressed while its command waits still applies when the command starts. */
export const STOP_PENDING_MS: number = 10000;

/** An attached surface: its socket, bus id, and locally executable capabilities. */
interface Surface {
  socket: WebSocket;
  id: string;
  capabilities: {
    shellCommands: boolean;
    hiddenInput: boolean;
    fileDelivery: boolean;
    localFilesystem: boolean;
    color: boolean;
    /** The subjects its own language answers for (claims.ts). */
    claims: SurfaceClaim[];
    /** The terminal it draws, when it is a terminal's chell. */
    terminal?: string;
    /** Raised to MANAGE with the person's password (`elevate`): its lines may start tasks, as the daemon's own `tasks` tier would let them. */
    tasksGranted: boolean;
  };
}

/** One scrollback entry: an envelope and the surface that produced it. */
interface SessionEntry {
  surface: string;
  envelope: CommandEnvelope;
}

/**
 * Where a delivered file landed, returned by {@link CalypsoDaemon.deliver_current}.
 *
 * @property location - The surface's honest account of the destination.
 * @property bytes - How many bytes it delivered.
 */
export interface DeliverOutcome {
  location: string;
  bytes: number;
}

/** The result of a surface's local edit, returned by {@link CalypsoDaemon.edit_current}. */
export interface EditOutcome {
  content: string;
  changed: boolean;
  /** The surface opened an editor that stays open; its saves are lines of their own. */
  opened?: boolean;
}

/** The default number of envelopes retained for scrollback replay. */
/** The surface tag on session-bus envelopes the daemon itself originates. */
export const DAEMON_SURFACE: string = 'daemon';

const SCROLLBACK_DEFAULT: number = 200;

/**
 * Options for creating a daemon.
 *
 * @property engine - The engine to host.
 * @property token - The attach token a surface must present.
 * @property port - The port to bind; 0 (default) picks an ephemeral port.
 * @property host - The interface to bind; loopback (`127.0.0.1`) by default.
 * @property scrollbackSize - How many recent envelopes to retain for replay
 *   to an attaching surface; defaults to 200.
 * @property promptProvider - Supplies the current session's prompt context,
 *   which the daemon pushes to surfaces after each command and on attach; each
 *   surface renders it with its own theme. The daemon passes the last executed
 *   command's measured facts so the context can carry them. Omitted when a
 *   host does not push a prompt (e.g. tests).
 * @property webRoot - A directory of static files (the built web surface) the
 *   daemon's HTTP side serves alongside the WebSocket contract. Omitted, plain
 *   HTTP requests receive 404 and only the WebSocket upgrade is answered.
 */
/** The last executed command's measured facts, for the prompt context. */
export interface PromptLastCommand {
  durationMs: number;
  exitCode: number;
}

/** What the daemon's telemetry provider snapshots once a second. */
export interface TelemetrySnapshot {
  jobs: number;
  feeds: number;
  cube?: { msPerPage: number; samples: number };
  state?: { running: number; runningFeeds: number; scheduled: number; errored: number; erroredFeeds: number };
}

/**
 * One running line: whose it is, what it holds of the session, and how it
 * is stopped. Output, progress and questions are routed by it.
 */
interface CommandSlot {
  /** The daemon's own name for the line, which the engine's STOP names. */
  key: string;
  origin: Surface;
  id: string;
  /**
   * Whether the line is surface-internal. A pane's silent refresh must
   * never interrupt the operator with a question it invented, so an ask
   * raised under one is refused rather than shown.
   */
  instrument: boolean;
  line: string;
  startedAt: number;
  /** What it holds of the session while it works. */
  want: LockSet;
  /** Its hold, or null while it waits on a person. */
  hold: Hold | null;
  /** Whether it waits aside on a task, where its surface's STOP still reaches it. */
  asideStoppable: boolean;
  /** Abandons it: the session stops waiting for it. */
  abandon: (() => void) | null;
}

/**
 * Whether a surface is a browser: it speaks a language of its own (claims)
 * and runs no shell.
 *
 * @param surface - The surface.
 * @returns True for a browser.
 */
function surface_isBrowser(surface: Surface): boolean {
  return !surface.capabilities.shellCommands && surface.capabilities.claims.length > 0;
}


export interface DaemonOptions {
  engine: HostedEngine;
  token: string;
  port?: number;
  host?: string;
  scrollbackSize?: number;
  promptProvider?: (last?: PromptLastCommand) => PromptContext | Promise<PromptContext>;
  /**
   * Supplies the live process-index counts for the once-a-second telemetry
   * heartbeat. Omitted, no heartbeat is sent (e.g. tests).
   */
  telemetryProvider?: () => TelemetrySnapshot;
  /** The hosting process's versions and build hash, reported on attach. */
  stack?: DaemonStackInfo;
  /** The session's backend id, reported on attach so a surface draws its composition. */
  backend?: string;
  webRoot?: string;
  /** The host-control tiers this daemon declares (empty or absent when off). */
  hostControl?: string[];
  /** The door a surface can be raised at with the person's password (`elevate`); absent, a session stays as it was started. */
  elevation?: ElevationDoor;
  /**
   * Reads the daemon's own code on disk again; called on each attach, so a
   * surface arriving after an upgrade learns at once. The host answers
   * through `stale_set`. Omitted, the daemon never calls itself stale.
   */
  codeCheck?: () => void;
  /**
   * Where the daemon writes an operational line of its own (a file whose
   * bytes stopped coming from CUBE); standard error by default.
   */
  log?: (line: string) => void;
}

/**
 * A question on its way to a surface.
 *
 * The daemon does not interpret any of it — it relays what the engine asked
 * and hands back what the surface answered — but it carries the kind so a
 * graphical surface can choose an instrument rather than reading the
 * wording and guessing.
 *
 * @property message - The question's own words.
 * @property hidden - No-echo entry; requires the `hiddenInput` capability.
 * @property wants - What kind of value answers it.
 * @property path - Where browsing starts and what to compose, for a location.
 * @property commit - The word the committing control should read.
 */
export interface PromptRelay {
  message: string;
  hidden: boolean;
  wants?: PromptKind;
  path?: PromptPath;
  commit?: string;
}

/**
 * A WebSocket daemon hosting one engine for attached surfaces, with a session
 * bus broadcasting activity across them.
 */
export class CalypsoDaemon {
  private readonly engine: HostedEngine;
  private readonly token: string;
  private readonly port: number;
  private readonly host: string;
  private readonly scrollbackSize: number;
  private readonly promptProvider:
    | ((last?: PromptLastCommand) => PromptContext | Promise<PromptContext>)
    | undefined;
  /** The last executed command's measured facts, sticky across pushes. */
  private lastCommand: PromptLastCommand | undefined;
  private readonly telemetryProvider: (() => TelemetrySnapshot) | undefined;
  private telemetryTimer: NodeJS.Timeout | null = null;
  /** The index counts at the last heartbeat, to detect movement. */
  private telemetryLastIndex: { jobs: number; feeds: number } | null = null;
  /** Whether the last pushed prompt context carried active warm-up. */
  private promptWarmupActive: boolean = false;
  private readonly stack: DaemonStackInfo | undefined;
  private readonly backend: string | undefined;
  /** Whether the daemon's own code on disk has moved on since it started. */
  private stale: boolean = false;
  /** The terminals this daemon offers, or null when it offers none (no pty here). */
  private terminals: Terminals | null = null;
  private readonly codeCheck: (() => void) | undefined;
  /** Where the daemon's own operational lines go. */
  private readonly log: (line: string) => void;
  private readonly hostControl: string[];
  private readonly elevation: ElevationDoor | undefined;
  /** The one session all surfaces share; returned in each attach ack. */
  private readonly sessionId: string = randomBytes(8).toString('hex');
  private readonly surfaces: Set<Surface> = new Set<Surface>();
  private readonly scrollback: SessionEntry[] = [];

  /** The number of currently attached surfaces (console-face telemetry). */
  public surfaces_count(): number {
    return this.surfaces.size;
  }

  /** Whether a foreground command is executing right now. */
  public busy_get(): boolean {
    return [...this.running].some((slot: CommandSlot): boolean => slot.hold !== null);
  }

  private readonly webRoot: string | undefined;
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  /**
   * Execution takes turns across the whole session (lane.ts): one command
   * works at a time, so a prompt raised mid-command has one unambiguous
   * surface to ask, the one holding the lane. A command waiting on a person
   * gives the lane up until the answer comes (`person_await`).
   */
  private readonly lane: Lane = new Lane();
  /** The questions open now, by the surface asked: what, and since when. */
  private readonly questionsOpen: Map<Surface, { message: string; at: number }> = new Map();
  /** The session's retained regard: the last indication from any surface. */
  private regard: Regard | null = null;
  /** Unsubscribes from the engine's ambient events; null until started. */
  private ambientStop: (() => void) | null = null;
  /**
   * The line the code runs inside: several may run at once, so each keeps
   * its own slot, and whatever it raises (output, a question, a pipe
   * segment) goes to its own surface.
   */
  private readonly slotScope: AsyncLocalStorage<CommandSlot> = new AsyncLocalStorage<CommandSlot>();
  /** The lines running now, waiting aside or not, in the order they started. */
  private readonly running: Set<CommandSlot> = new Set();
  /** Names each line for the engine. */
  private lineCount: number = 0;
  /** Surfaces whose STOP found their command still waiting its turn, and when. */
  private readonly stopPending: Map<Surface, number> = new Map();

  /** The surface of the line the code runs inside, or null outside any. */
  private get currentOrigin(): Surface | null {
    return this.slotScope.getStore()?.origin ?? null;
  }

  /** The surface's id for the line the code runs inside, or null outside any. */
  private get currentId(): string | null {
    return this.slotScope.getStore()?.id ?? null;
  }

  /** Whether the line the code runs inside is surface-internal. */
  private get currentInstrument(): boolean {
    return this.slotScope.getStore()?.instrument === true;
  }
  // One RequestBroker per surface-delegated request kind. The broker owns the
  // whole correlation lifecycle uniformly: id generation, close-guard,
  // origin-validated settles, listener cleanup. See broker.ts.
  private readonly prompts: RequestBroker<string> = new RequestBroker<string>('p', 'surface disconnected before answering');
  private readonly pipes: RequestBroker<Buffer> = new RequestBroker<Buffer>('x', 'surface disconnected before returning pipe output');
  private readonly shells: RequestBroker<number> = new RequestBroker<number>('h', 'surface disconnected before returning the shell result');
  /** The downloads this daemon is serving, for their progress (downloads.ts). */
  private readonly downloads: DownloadLedger = new DownloadLedger();
  private readonly edits: RequestBroker<EditOutcome> = new RequestBroker<EditOutcome>('e', 'surface disconnected before returning the edit');
  /** Lines run by a surface's own language, by the surface that claims them. */
  private readonly surfaceLines: RequestBroker<{ rendered: string; status: 'ok' | 'error' }> = new RequestBroker<{ rendered: string; status: 'ok' | 'error' }>('l', 'the surface that answers for this line went away before answering');
  /** Each surface's terminal viewer: which terminals it draws. */
  private readonly viewerOf: Map<Surface, TerminalViewer> = new Map();
  /** The browser that last did something: the one a claimed line goes to when no terminal of its own typed it. */
  private browserActive: Surface | null = null;
  /** Subjects a surface claimed whole this session, so a line in one is refused by name when none is attached. */
  private readonly claimedSeen: Set<string> = new Set();
  private readonly deliveries: RequestBroker<DeliverOutcome> = new RequestBroker<DeliverOutcome>('d', 'surface disconnected before the file was delivered');

  /**
   * @param options - The engine to host, the attach token, the bind address,
   *   and the scrollback size.
   */
  constructor(options: DaemonOptions) {
    this.engine = options.engine;
    this.token = options.token;
    this.port = options.port ?? 0;
    this.host = options.host ?? '127.0.0.1';
    this.scrollbackSize = options.scrollbackSize ?? SCROLLBACK_DEFAULT;
    this.promptProvider = options.promptProvider;
    this.telemetryProvider = options.telemetryProvider;
    this.stack = options.stack;
    this.backend = options.backend;
    this.webRoot = options.webRoot;
    this.hostControl = options.hostControl ?? [];
    this.elevation = options.elevation;
    this.codeCheck = options.codeCheck;
    this.log = options.log ?? ((line: string): void => { console.error(line); });
  }

  /**
   * Offers terminals: a surface's console as a chell under a pty
   * (terminals.ts). Set once the daemon knows its own address.
   *
   * @param terminals - The terminals, or null to offer none.
   */
  public terminals_set(terminals: Terminals | null): void {
    this.terminals = terminals;
  }

  /**
   * Records whether the daemon's own code still matches its disk, and tells
   * every attached surface when that changes.
   *
   * @param stale - True when the code on disk is not the code this process runs.
   */
  public stale_set(stale: boolean): void {
    if (stale === this.stale) return;
    this.stale = stale;
    for (const surface of this.surfaces) this.send(surface.socket, { type: 'stale', stale });
  }

  /**
   * Starts the telemetry heartbeat: once a second, the live index counts go
   * to every attached surface. Idle wires stay quiet — no surfaces, no send.
   */
  private telemetry_start(): void {
    if (this.telemetryProvider === undefined || this.telemetryTimer !== null) {
      return;
    }
    const provider: () => TelemetrySnapshot = this.telemetryProvider;
    this.telemetryTimer = setInterval((): void => {
      if (this.surfaces.size === 0) {
        return;
      }
      const snapshot = provider();
      const index: { jobs: number; feeds: number } = { jobs: snapshot.jobs, feeds: snapshot.feeds };
      // The lane rides the heartbeat: which command holds it, for how long,
      // and how many wait behind it. A surface reads it as a gauge.
      const working: CommandSlot | undefined = [...this.running].find((slot: CommandSlot): boolean => slot.hold !== null && !slot.instrument);
      const lane = {
        running: working !== undefined
          ? { line: working.line, sinceMs: Math.round(performance.now() - working.startedAt), surface: working.origin.id }
          : null,
        waiting: this.lane.waiting,
        // Questions open: each one's command has stepped out of the lane.
        questions: [...this.questionsOpen].map(([surface, open]) => ({ surface: surface.id, message: open.message, sinceMs: Math.round(performance.now() - open.at) })),
        // The joblets running: a restart asked from any surface says it ends them.
        joblets: this.engine.joblets_running?.() ?? [],
      };
      // Who else is here: a restart asked from one surface names the rest.
      // A surface that runs host shells is a terminal; one that does not, a browser.
      const surfaces = [...this.surfaces].map((each: Surface) => ({ id: each.id, kind: each.capabilities.shellCommands ? 'chell' as const : 'browser' as const }));
      for (const surface of this.surfaces) {
        this.send(surface.socket, {
          type: 'telemetry', index, lane, surfaces,
          ...(snapshot.cube !== undefined ? { cube: snapshot.cube } : {}),
          ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
        });
      }
      // Warm-up is a prompt-context change no command announces: the counts
      // climb while every surface sits idle. While the index moves — or the
      // last pushed context still showed active warm-up (its settling is a
      // change the counts alone cannot signal) — refresh the promptline too.
      //
      // And while a foreground command runs. A feed's topology walk (a first
      // visit, `proc refresh`) reports its progress into the prompt context
      // page by page, but adds its instances to the index only once the walk
      // is done — so the counts stand still for the whole minute the operator
      // most needs the JOBS readout to say what is happening. The command's
      // own promptline comes only when it ends. Pushing on every tick while a
      // command is executing is what lets the walk be annunciated on a quiet
      // daemon, and not only when a background sweep happens to be moving
      // the counts at the same time.
      const moved: boolean =
        this.telemetryLastIndex === null ||
        index.jobs !== this.telemetryLastIndex.jobs ||
        index.feeds !== this.telemetryLastIndex.feeds;
      this.telemetryLastIndex = index;
      if (moved || this.promptWarmupActive || this.busy_get()) {
        void this.promptline_push();
      }
    }, 1000);
    // The heartbeat must not hold the process open on its own.
    this.telemetryTimer.unref();
  }

  /**
   * Starts listening.
   *
   * The daemon owns an explicit HTTP server: WebSocket upgrades carry the
   * session contract, and plain requests serve the configured web root (404
   * when none is configured), so one loopback port carries both the wire and
   * the web surface that speaks it.
   *
   * @returns The bound port (useful when an ephemeral port was requested).
   */
  public start(): Promise<number> {
    return new Promise((resolve: (port: number) => void, reject: (err: Error) => void) => {
      const httpServer: Server = createServer(
        (request: IncomingMessage, response: ServerResponse) => {
          const requestPath: string = (request.url ?? '/').split('?')[0] ?? '/';
          if (requestPath === '/vfs') {
            // A file route that throws is answered and said, never left to end the session.
            this.vfs_serve(request, response).catch((error: unknown): void => {
              this.log(`[!] vfs: ${request.url?.split('?')[0] ?? '/vfs'}: ${errorFacts_read(error).message}`);
              if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                response.end(`the session could not serve that file: ${errorFacts_read(error).message}`);
              } else {
                response.destroy();
              }
            });
            return;
          }
          if (requestPath === '/backend') {
            this.backend_serve(request, response);
            return;
          }
          if (requestPath === '/joblets') {
            this.joblets_serve(request, response);
            return;
          }
          if (this.webRoot !== undefined) {
            staticRequest_handle(this.webRoot, request, response);
            return;
          }
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not found');
        },
      );
      const wss: WebSocketServer = new WebSocketServer({ server: httpServer });
      wss.on('connection', (socket: WebSocket, request: IncomingMessage) => this.connection_handle(socket, request));
      httpServer.on('error', reject);
      httpServer.listen(this.port, this.host, () => {
        resolve((httpServer.address() as AddressInfo).port);
      });
      this.wss = wss;
      this.httpServer = httpServer;
      this.telemetry_start();
      this.ambientStop = this.engine.ambient_listen?.((event: AmbientEvent): void => this.ambient_relay(event)) ?? null;
    });
  }

  /**
   * Stops listening and closes all connections.
   *
   * @returns A promise resolving when the server has closed.
   */
  public stop(): Promise<void> {
    // A terminal's chell is a child of this process: it goes with it.
    this.terminals?.stop();
    if (this.telemetryTimer !== null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    if (this.ambientStop !== null) {
      this.ambientStop();
      this.ambientStop = null;
    }
    return new Promise((resolve: () => void) => {
      if (!this.wss || !this.httpServer) {
        resolve();
        return;
      }
      for (const client of this.wss.clients) {
        client.terminate();
      }
      const httpServer: Server = this.httpServer;
      this.wss.close(() => {
        httpServer.close(() => resolve());
      });
      this.wss = null;
      this.httpServer = null;
    });
  }

  /**
   * Says which backend the session runs over, before a surface builds:
   * `{"backend": "chris"}`. A surface chooses its composition from it, and
   * the attach answer says the same once it attaches. The attach token gates
   * it as it gates `/vfs` (a wrong one is not found).
   *
   * @param request - The incoming HTTP request.
   * @param response - The response to write.
   */
  private backend_serve(request: IncomingMessage, response: ServerResponse): void {
    const query: URLSearchParams = new URL(request.url ?? '/', 'http://localhost').searchParams;
    if (!token_matches(this.token, query.get('token') ?? '')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ backend: this.backend ?? null }));
  }

  /**
   * Says which joblets run now (`line &`): `{"joblets": [{number, line,
   * waiting}]}`. A host about to restart the session (porter, for a new
   * release) asks first, since a restart ends them (#1273). Gated by the
   * attach token, as `/backend` is.
   *
   * @param request - The incoming HTTP request.
   * @param response - The response to write.
   */
  private joblets_serve(request: IncomingMessage, response: ServerResponse): void {
    const query: URLSearchParams = new URL(request.url ?? '/', 'http://localhost').searchParams;
    if (!token_matches(this.token, query.get('token') ?? '')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ joblets: this.engine.joblets_running?.() ?? [] }));
  }

  /**
   * Serves one ChRIS file's bytes over HTTP: `GET /vfs?path=...&token=...`.
   *
   * The route exists so browser surfaces can render file content natively
   * (an image in a panel) instead of through the terminal stream. It is
   * gated by the same attach token as the wire (compared in constant time)
   * and requires the hosted engine to provide `file_read`; refusals and
   * failures answer 404 so the response does not confirm what exists.
   *
   * With `download=1` the same bytes come down as an attachment named for
   * the file, which is how a browser is told to save rather than show: a
   * surface's DOWNLOAD is this URL behind an anchor, so a file reaches the
   * operator's disk the way every other download does.
   *
   * @param request - The incoming HTTP request.
   * @param response - The response to write.
   */
  private async vfs_serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, message: string): void => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(message);
    };
    const query: URLSearchParams = new URL(request.url ?? '/', 'http://localhost').searchParams;
    if (!token_matches(this.token, query.get('token') ?? '')) {
      refuse(404, 'not found');
      return;
    }
    if (request.method === 'POST') {
      await this.vfs_receive(request, response, query, refuse);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      refuse(405, 'method not allowed');
      return;
    }
    // A download's progress, and its stop: the surface asks by its own id.
    const asked: string | null = query.get('progress') ?? query.get('cancel');
    if (asked !== null) {
      const id: string | null = downloadId_valid(asked) ? asked : null;
      if (id !== null && query.has('cancel')) this.downloads.cancel(id);
      const report: DownloadReport | null = id === null ? null : this.downloads.report(id);
      response.writeHead(report === null ? 404 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(report ?? { reason: 'no such download' }));
      return;
    }
    const filePath: string | null = query.get('path');
    const read = this.engine.file_read?.bind(this.engine);
    if (filePath === null || filePath.length === 0 || read === undefined) {
      refuse(404, 'not found');
      return;
    }
    const open = this.engine.file_stream?.bind(this.engine);
    // A download's probe asks by HEAD: the file's headers, its bytes held.
    if (open !== undefined && (request.method === 'GET' || (request.method === 'HEAD' && query.get('probe') === '1'))) {
      await this.vfs_stream(open, filePath, query, response, refuse);
      return;
    }
    try {
      const bytes: Buffer = await read(filePath);
      const headers: Record<string, string | number> = {
        'content-type': contentType_derive(filePath),
        'content-length': bytes.length,
      };
      if (query.get('download') === '1') {
        headers['content-disposition'] = contentDisposition_format(filePath);
      }
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error: unknown) {
      // The kernel says why it refused (status and a line); the route
      // passes both on. It used to answer 404 for everything, and a
      // surface could only say REFUSED.
      const named: { status?: unknown; reason?: unknown } = error as { status?: unknown; reason?: unknown };
      if (typeof named.status === 'number' && typeof named.reason === 'string') {
        refuse(named.status, named.reason);
        return;
      }
      refuse(404, 'not found');
    }
  }

  /**
   * Serves one file's bytes as they arrive: the length in the header when
   * the store gave one (so a browser draws its own progress), the body
   * piped, nothing held whole. A 3.7 GB DICOM used to be read into one
   * buffer behind a 30 s deadline and answered 404. A failure to open the
   * file answers with the kernel's status and reason. The status waits for
   * CUBE's first byte, so a file whose bytes never start is a 502 that says
   * why. A break after bytes have gone cuts the socket, which the porter and
   * the browser see as a body that stopped rather than a short file. Either
   * break is one line in the daemon's log (vfsBreak.ts): the path, the bytes
   * sent of the size CUBE stated, the time taken and the cause.
   *
   * @param open - The engine's stream seam.
   * @param filePath - The file asked for.
   * @param query - The request's query (`download=1` names an attachment).
   * @param response - The response to write.
   * @param refuse - Answers a refusal before any byte is sent.
   *
   * A download with an id (`dl`) is counted for its progress; its probe
   * (HEAD, `probe=1`) opens the file and answers the headers alone, holding the
   * stream for the save that follows (downloads.ts).
   */
  private async vfs_stream(
    open: (filePath: string) => Promise<OpenedFile>,
    filePath: string,
    query: URLSearchParams,
    response: ServerResponse,
    refuse: (status: number, message: string) => void,
  ): Promise<void> {
    const startedAt: number = Date.now();
    const dl: string | null = downloadId_valid(query.get('dl')) ? query.get('dl') : null;
    const probe: boolean = dl !== null && query.get('probe') === '1';
    // The browser's save takes the file its probe opened, when one is held.
    // A cancelled download stays cancelled: its save is refused, not begun again.
    if (dl !== null && this.downloads.cancelled(dl)) {
      refuse(410, 'cancelled');
      return;
    }
    let opened: OpenedFile | null = dl !== null && !probe ? this.downloads.claim(dl) : null;
    if (opened === null) {
      if (dl !== null) this.downloads.begin(dl, filePath);
      try {
        opened = await open(filePath);
      } catch (error: unknown) {
        const named: { status?: unknown; reason?: unknown } = error as { status?: unknown; reason?: unknown };
        const known: boolean = typeof named.status === 'number' && typeof named.reason === 'string';
        if (dl !== null) this.downloads.fail(dl, known ? String(named.reason) : 'not found');
        if (known) refuse(named.status as number, named.reason as string);
        else refuse(404, 'not found');
        return;
      }
    }
    const headers: Record<string, string | number> = { 'content-type': contentType_derive(filePath) };
    if (opened.size !== undefined) headers['content-length'] = opened.size;
    if (query.get('download') === '1') headers['content-disposition'] = contentDisposition_format(filePath);
    if (probe && dl !== null) {
      // The probe's answer is the file's headers; the bytes wait for the save.
      if (!this.downloads.park(dl, opened)) {
        refuse(410, 'cancelled');
        return;
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }
    let stream: AsyncIterable<unknown> & NodeJS.ReadableStream;
    try {
      stream = await byteStream_normalise(opened.stream);
    } catch (error: unknown) {
      const { message } = errorFacts_read(error);
      this.log(`[!] vfs: ${filePath}: ${message}`);
      if (dl !== null) this.downloads.fail(dl, message);
      refuse(500, message);
      return;
    }
    const statedBytes: number | undefined = opened.size;
    let browserLeft: boolean = false;
    // The browser left (a cancelled download): stop pulling from CUBE.
    response.on('close', (): void => {
      if (response.writableFinished) return;
      browserLeft = true;
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    });
    const chunks: AsyncIterator<unknown> = stream[Symbol.asyncIterator]();
    let sentBytes: number = 0;
    const break_log = (error: unknown): void => {
      if (browserLeft) return;
      this.log(vfsBreak_format({ path: filePath, sentBytes, statedBytes, elapsedMs: Date.now() - startedAt, ...errorFacts_read(error) }));
    };
    // The status waits for CUBE's first byte: a file that never starts is
    // still a refusal with its reason, not a 200 cut off before its body.
    let first: IteratorResult<unknown>;
    try {
      first = await chunks.next();
    } catch (error: unknown) {
      break_log(error);
      const { message } = errorFacts_read(error);
      if (dl !== null) this.downloads.fail(dl, `the file did not arrive from CUBE: ${message}`);
      if (!browserLeft) refuse(502, `the file did not arrive from CUBE: ${message}`);
      return;
    }
    response.writeHead(200, headers);
    const rest = async function* (): AsyncGenerator<Buffer> {
      let step: IteratorResult<unknown> = first;
      while (step.done !== true) {
        const chunk: Buffer = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value as Uint8Array);
        sentBytes += chunk.length;
        yield chunk;
        step = await chunks.next();
      }
    };
    try {
      const { pipeline } = await import('node:stream/promises');
      if (dl !== null) await pipeline(rest, this.downloads.counter(dl, response), response);
      else await pipeline(rest, response);
    } catch (error: unknown) {
      break_log(error);
      // The status is sent and cannot change: the socket is cut, so the
      // porter and the browser see a body that stopped, never a whole short file.
      if (dl !== null) this.downloads.fail(dl, `the file stopped arriving from CUBE: ${errorFacts_read(error).message}`);
      response.destroy();
    }
  }

  /**
   * Takes one file's bytes from a surface: `POST /vfs?path=...&token=...`.
   *
   * A browser cannot reach the machine the daemon runs on, so `upload` is
   * not a verb it can speak: the bytes travel here and the ENGINE puts them
   * in the store, which keeps the write on the kernel's own path rather
   * than letting a surface talk to CUBE.
   *
   * Gated by the same attach token as the read, and capped: a surface that
   * can post unbounded bytes to a loopback port is a surface that can fill
   * the machine.
   *
   * @param request - The incoming request, whose body is the file.
   * @param response - The response to write.
   * @param query - The parsed query string (path and token).
   * @param refuse - How this route says no.
   */
  private async vfs_receive(
    request: IncomingMessage,
    response: ServerResponse,
    query: URLSearchParams,
    refuse: (status: number, message: string) => void,
  ): Promise<void> {
    const filePath: string | null = query.get('path');
    const write = this.engine.file_write?.bind(this.engine);
    if (filePath === null || filePath.length === 0 || write === undefined) {
      refuse(404, 'not found');
      return;
    }
    const chunks: Buffer[] = [];
    let received: number = 0;
    let refused: boolean = false;
    try {
      for await (const chunk of request) {
        const part: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        received += part.length;
        if (received > VFS_POST_LIMIT) {
          refused = true;
          break;
        }
        chunks.push(part);
      }
    } catch {
      refuse(400, 'could not read the request body');
      return;
    }
    if (refused) {
      refuse(413, `file too large: this route takes at most ${VFS_POST_LIMIT} bytes`);
      return;
    }
    try {
      await write(filePath, Buffer.concat(chunks));
    } catch (error: unknown) {
      refuse(502, error instanceof Error ? error.message : 'the store refused the write');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ path: filePath, bytes: received }));
  }

  /**
   * Handles one surface connection: an attach handshake, then serialized
   * command dispatch, with the surface removed from the bus on close.
   *
   * @param socket - The connected surface.
   */
  private connection_handle(socket: WebSocket, request?: IncomingMessage): void {
    let surface: Surface | null = null;
    // This socket as a terminal's viewer: output and exits go back down it.
    const viewer: TerminalViewer = {
      data: (terminalId: string, data: string): void => this.send(socket, { type: 'terminalData', terminalId, data }),
      exit: (terminalId: string, code: number): void => this.send(socket, { type: 'terminalExit', terminalId, code }),
      owner: (): unknown => surface,
    };
    // A front that holds the token for a browser — the porter — puts it on
    // the upgrade URL it proxies, the way `/vfs?token=` already travels; the
    // page then attaches with an empty token and is judged by the URL's.
    const urlToken: string = new URL(request?.url ?? '/', 'http://localhost').searchParams.get('token') ?? '';

    socket.on('message', (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : String(err);
        this.send(socket, { type: 'error', reason: `malformed JSON: ${message}` });
        return;
      }

      if (!surface) {
        surface = this.attach_handle(socket, parsed, urlToken);
        if (surface !== null) this.viewerOf.set(surface, viewer);
        return;
      }

      const message = clientMessage_parse(parsed);
      if (!message.ok || message.value === undefined) {
        this.send(socket, { type: 'error', reason: message.error ?? 'invalid message' });
        return;
      }
      const value = message.value;
      const attached: Surface = surface;
      if (value.type === 'execute') {
        if (surface_isBrowser(attached)) this.browserActive = attached;
        // A line in a surface's own language is that surface's to run: it never
        // reaches the engine, and needs no turn on the lane (the session is not
        // touched by it).
        const claimant: Surface | 'absent' | null = value.instrument === true ? null : this.claimant_find(attached, value.line);
        if (claimant !== null) {
          void this.surfaceLine_run(attached, value, claimant);
          return;
        }
        // One lane for every surface: commands take turns, and a command
        // waiting on a person stands aside (person_await), so a pane's own
        // reads, or another surface's command, run while a question is open.
        void this.line_run(attached, value);
      } else if (value.type === 'cancel') {
        this.cancel_run(attached, value);
      } else if (value.type === 'stop') {
        this.stop_run(attached, value);
      } else if (value.type === 'elevate') {
        void this.elevate_run(attached, value);
      } else if (value.type === 'complete') {
        void this.complete_run(socket, value);
      } else if (value.type === 'promptAnswer') {
        this.prompts.settle(socket, value.promptId, value.answer);
      } else if (value.type === 'promptError') {
        this.prompts.fail(socket, value.promptId, value.reason);
      } else if (value.type === 'pipeResult') {
        this.pipes.settle(socket, value.pipeId, Buffer.from(value.output, 'base64'));
      } else if (value.type === 'pipeError') {
        this.pipes.fail(socket, value.pipeId, value.reason);
      } else if (value.type === 'shellResult') {
        this.shells.settle(socket, value.shellId, value.exitCode);
      } else if (value.type === 'shellError') {
        this.shells.fail(socket, value.shellId, value.reason);
      } else if (value.type === 'editResult') {
        this.edits.settle(socket, value.editId, {
          content: value.content,
          changed: value.changed,
          ...(value.opened === undefined ? {} : { opened: value.opened }),
        });
      } else if (value.type === 'editError') {
        this.edits.fail(socket, value.editId, value.reason);
      } else if (value.type === 'deliverResult') {
        this.deliveries.settle(socket, value.deliverId, { location: value.location, bytes: value.bytes });
      } else if (value.type === 'deliverError') {
        this.deliveries.fail(socket, value.deliverId, value.reason);
      } else if (value.type === 'regard') {
        this.regard_receive(value.regard);
      } else if (value.type === 'watch' || value.type === 'unwatch') {
        this.watch_receive(attached, value.subject, value.type === 'watch');
      } else if (value.type === 'terminalOpen') {
        if (this.terminals === null) {
          this.send(socket, { type: 'terminalOpened', terminalId: '', replay: '', refused: 'this daemon offers no terminals (node-pty is not built here)' });
        } else {
          const opened = this.terminals.open(viewer, value.cols, value.rows, value.terminalId);
          this.send(socket, { type: 'terminalOpened', terminalId: opened.terminalId, replay: opened.replay });
        }
      } else if (value.type === 'terminalInput') {
        this.terminals?.input(viewer, value.terminalId, value.data);
      } else if (value.type === 'terminalResize') {
        this.terminals?.resize(viewer, value.terminalId, value.cols, value.rows);
      } else if (value.type === 'terminalClose') {
        this.terminals?.close(viewer, value.terminalId);
      } else if (value.type === 'surfaceLineResult') {
        this.surfaceLines.settle(socket, value.lineId, { rendered: value.rendered, status: value.status });
      } else if (value.type === 'surfaceLineError') {
        this.surfaceLines.fail(socket, value.lineId, value.reason);
      } else if (value.type === 'note') {
        this.note_relay(viewer, value.text);
      } else if (value.type === 'surfaceClaims') {
        attached.capabilities.claims = value.claims;
        for (const claim of value.claims) if (claim.verbs === undefined) this.claimedSeen.add(claim.subject.toLowerCase());
      } else {
        this.send(socket, { type: 'error', reason: 'already attached' });
      }
    });

    socket.on('close', () => {
      // Its terminals keep running, unwatched, for a reattach.
      this.terminals?.detach(viewer);
      // A shell that goes away hangs up on its command, as a terminal's
      // SIGHUP does: one still running is stopped, or nothing could stop it.
      // A browser is not a shell (it reloads and reattaches), and its
      // command runs on (a chell declares a filesystem; a browser does not).
      if (surface && (surface.capabilities.localFilesystem || surface.capabilities.terminal !== undefined)) {
        for (const slot of this.running) if (slot.origin === surface && slot.hold !== null) this.command_stop(slot);
      }
      if (surface) {
        this.surfaces.delete(surface);
        this.viewerOf.delete(surface);
        if (this.browserActive === surface) this.browserActive = null;
        // A detached surface holds no watches: whatever it kept live is
        // released, and a subject nobody else watches stops being sampled.
        this.engine.watch_release?.(surface.id);
        this.engine.origin_forget?.(surface.id);
      }
    });
  }

  /**
   * Whether the running command was typed in a browser's terminal.
   *
   * @returns True for a terminal's chell.
   */
  public current_isTerminal(): boolean {
    return this.currentOrigin?.capabilities.terminal !== undefined;
  }

  /**
   * The surface that acts for the running command: the one that issued it,
   * except a browser's terminal, whose chell runs on this daemon's host. A
   * shell, a pipe segment, an editor or a delivered file asked of a
   * terminal's chell would happen on the daemon host (a browser handed a
   * host shell, a download written to the host's disk), so they go to the
   * browser that owns the terminal, which does them its own way or refuses
   * by name. Its questions stay with the chell, answered in the terminal.
   *
   * @returns The acting surface, or null when no command runs or the
   *   terminal's browser has gone.
   */
  private surfaceActing(): Surface | null {
    const origin: Surface | null = this.currentOrigin;
    if (origin === null || origin.capabilities.terminal === undefined) return origin;
    const owner: unknown = this.terminals?.viewer_get(origin.capabilities.terminal)?.owner?.();
    return owner !== null && owner !== undefined && this.surfaces.has(owner as Surface) ? owner as Surface : null;
  }

  /**
   * The surface that runs a line in its own language: the browser whose
   * terminal typed it, else the browser that last did something, else any
   * that claims the subject. 'absent' when the subject is a surface's but no
   * surface that claims it is attached; null when the session owns the line.
   * A browser's own line is never another's: what it did not claim itself
   * the session runs, so a line typed in one browser never opens on another.
   *
   * @param origin - The surface the line came from.
   * @param line - The line.
   * @returns The claimant, 'absent', or null.
   */
  private claimant_find(origin: Surface, line: string): Surface | 'absent' | null {
    const claiming = (surface: Surface | null | undefined): surface is Surface =>
      surface !== null && surface !== undefined && surface !== origin && this.surfaces.has(surface) && claim_match(surface.capabilities.claims, line) !== null;
    const owner: unknown = origin.capabilities.terminal === undefined ? null : this.terminals?.viewer_get(origin.capabilities.terminal)?.owner?.();
    if (claiming(owner as Surface | null)) return owner as Surface;
    if (surface_isBrowser(origin)) return null;
    if (claiming(this.browserActive)) return this.browserActive;
    const any: Surface | undefined = [...this.surfaces].find((surface: Surface): boolean => claiming(surface));
    if (any !== undefined) return any;
    // A subject a surface claimed whole is no command of the session's: with
    // no such surface attached, the line is refused by name, not run.
    const subject: string = (line.trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (this.claimedSeen.has(subject) && claim_match([{ subject }], line) !== null) return 'absent';
    return null;
  }

  /**
   * Runs a line in a surface's own language, and answers the surface that
   * typed it with what the language said.
   *
   * @param origin - The surface that typed the line.
   * @param message - The execute request.
   * @param claimant - The surface that runs it, or 'absent'.
   */
  private async surfaceLine_run(origin: Surface, message: ExecuteMessage, claimant: Surface | 'absent'): Promise<void> {
    const subject: string = (message.line.trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (claimant === 'absent') {
      this.send(origin.socket, { type: 'result', id: message.id, envelopes: [{ status: 'error', rendered: '', renderedErr: `${subject}: an ARGUS word; no ARGUS is attached to this session\n` }] });
      return;
    }
    try {
      const answer = await this.surfaceLines.open(claimant.socket, (lineId: string): void => {
        this.send(claimant.socket, { type: 'surfaceLine', lineId, line: message.line, ...(origin.capabilities.terminal !== undefined ? { terminal: origin.capabilities.terminal } : {}) });
      });
      const rendered: string = answer.rendered === '' || answer.rendered.endsWith('\n') ? answer.rendered : `${answer.rendered}\n`;
      this.send(origin.socket, { type: 'result', id: message.id, envelopes: [answer.status === 'ok' ? { status: 'ok', rendered } : { status: 'error', rendered: '', renderedErr: rendered }] });
    } catch (err: unknown) {
      const reason: string = err instanceof Error ? err.message : String(err);
      this.send(origin.socket, { type: 'result', id: message.id, envelopes: [{ status: 'error', rendered: '', renderedErr: `${subject}: ${reason}\n` }] });
    }
  }

  /**
   * The terminals a surface draws.
   *
   * @param surface - The surface.
   * @returns Their ids; none for a surface that draws no terminal.
   */
  private terminalsOf(surface: Surface): string[] {
    const viewer: TerminalViewer | undefined = this.viewerOf.get(surface);
    return viewer === undefined ? [] : this.terminals?.ids_list(viewer) ?? [];
  }

  /**
   * Carries a browser's note to its consoles: the chell of every terminal it
   * draws prints it above the line being typed.
   *
   * @param viewer - The browser's terminal viewer.
   * @param text - The note.
   */
  private note_relay(viewer: TerminalViewer, text: string): void {
    const owned: string[] = this.terminals?.ids_list(viewer) ?? [];
    if (owned.length === 0) return;
    for (const surface of this.surfaces) {
      if (surface.capabilities.terminal !== undefined && owned.includes(surface.capabilities.terminal)) {
        this.send(surface.socket, { type: 'consoleNote', text });
      }
    }
  }

  /**
   * Relays a cancellation request only to the surface's own foreground command.
   *
   * @param origin - Surface asking to cancel a command.
   * @param message - Correlated command identifier to cancel.
   * @returns Nothing. The running command reports its normal final envelope.
   */
  private cancel_run(origin: Surface, message: CancelMessage): void {
    const slot: CommandSlot | undefined = [...this.running].find((each: CommandSlot): boolean => each.origin === origin && each.id === message.id && each.hold !== null);
    if (slot === undefined) {
      this.send(origin.socket, { type: 'error', reason: 'cancel: no matching foreground command' });
      return;
    }
    // Ctrl-C is a stop: the command is asked to end, and abandoned if it does not.
    this.command_stop(slot);
  }

  /**
   * The operator's STOP: ends the command running for this surface, its own
   * or one typed in a terminal it owns, whatever the command is.
   *
   * @param origin - The surface pressing STOP.
   * @param _message - The request.
   */
  private stop_run(origin: Surface, _message: StopMessage): void {
    // A surface's silent housekeeping is not what the operator stops. A line
    // whose surface has gone is anyone's to stop: nobody else can.
    const stoppable = (slot: CommandSlot): boolean =>
      !slot.instrument && (this.stopper_resolve(slot.origin) === origin || !this.surfaces.has(slot.origin));
    const working: CommandSlot[] = [...this.running].filter((slot: CommandSlot): boolean => slot.hold !== null && stoppable(slot));
    if (working.length > 0) {
      for (const slot of working) this.command_stop(slot);
      return;
    }
    // Its command may be waiting aside on a task: stopped where it waits,
    // its own surface's first, else one whose surface has gone.
    const asides: CommandSlot[] = [...this.running].filter((slot: CommandSlot): boolean => slot.hold === null && slot.asideStoppable && stoppable(slot));
    const aside: CommandSlot | undefined = asides.find((slot: CommandSlot): boolean => this.stopper_resolve(slot.origin) === origin) ?? asides[0];
    if (aside !== undefined) {
      this.engine.line_abort?.(aside.key);
      return;
    }
    // Its command may be waiting its turn behind someone else's: it is
    // stopped the moment it starts, without running.
    if (this.lane.waiting > 0) {
      this.stopPending.set(origin, Date.now());
      return;
    }
    this.send(origin.socket, { type: 'error', reason: 'stop: nothing of yours is running' });
  }

  /**
   * Raises a surface to MANAGE: its password checked at the door, the
   * `tasks` tier is granted to it (and so to the terminals it owns, whose
   * lines act as its own) for as long as it is attached. A daemon started
   * with no door says so; a wrong password is refused by name.
   *
   * @param origin - The surface asking.
   * @param message - Its password.
   */
  private async elevate_run(origin: Surface, message: { password: string }): Promise<void> {
    if (this.elevation === undefined) {
      this.send(origin.socket, { type: 'elevated', granted: false, reason: 'this session cannot be raised: it was started without a door to ask (its tier is the one it was started with)' });
      return;
    }
    const owner: Surface = this.stopper_resolve(origin);
    if (owner.capabilities.tasksGranted) {
      this.send(origin.socket, { type: 'elevated', granted: true });
      return;
    }
    const right: boolean = await this.elevation.verify(message.password).catch((): boolean => false);
    if (!right) {
      this.send(origin.socket, { type: 'elevated', granted: false, reason: `not ${this.elevation.user}'s password; nothing changed` });
      return;
    }
    owner.capabilities.tasksGranted = true;
    this.send(origin.socket, { type: 'elevated', granted: true });
  }

  /**
   * Who may stop a surface's command: the surface itself, or, for a
   * terminal's chell, the browser that owns the terminal.
   *
   * @param surface - The surface that issued the command.
   * @returns The surface whose STOP reaches it.
   */
  private stopper_resolve(surface: Surface): Surface {
    const owner: unknown = surface.capabilities.terminal === undefined ? null : this.terminals?.viewer_get(surface.capabilities.terminal)?.owner?.();
    return owner !== null && owner !== undefined && this.surfaces.has(owner as Surface) ? owner as Surface : surface;
  }

  /**
   * Stops the running command: its signal is aborted (a command that checks
   * it ends, a host process it started is killed), and one still running
   * after {@link STOP_GRACE_MS} is abandoned, so the session is free again
   * whatever the command was waiting on.
   */
  private command_stop(slot: CommandSlot): void {
    this.engine.line_abort?.(slot.key) ?? this.engine.line_cancel?.(slot.key);
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      if (this.running.has(slot)) slot.abandon?.();
    }, STOP_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Validates an attach handshake: contract version, then constant-time
   * token check. On success the surface is acknowledged, registered on the
   * bus, and replayed the scrollback so it does not join blind; on failure it
   * is told why and disconnected.
   *
   * @param socket - The connecting surface.
   * @param raw - The first message received.
   * @param urlToken - A token that rode the upgrade URL, or the empty string.
   * @returns The registered surface, or null when the attach was refused.
   */
  private attach_handle(socket: WebSocket, raw: unknown, urlToken: string = ''): Surface | null {
    const attach = attach_parse(raw);
    if (!attach.ok || attach.value === undefined) {
      this.send(socket, { type: 'error', reason: attach.error ?? 'invalid attach' });
      socket.close();
      return null;
    }
    const presented: string = attach.value.token.length > 0 ? attach.value.token : urlToken;
    if (!token_matches(this.token, presented)) {
      this.send(socket, { type: 'error', reason: 'invalid token' });
      socket.close();
      return null;
    }
    // Each connection is a distinct surface (its own bus tag); all attach to
    // the one shared session returned in the ack.
    const surface: Surface = {
      socket,
      id: randomBytes(8).toString('hex'),
      capabilities: {
        shellCommands: attach.value.capabilities?.shellCommands ?? false,
        hiddenInput: attach.value.capabilities?.hiddenInput ?? false,
        fileDelivery: attach.value.capabilities?.fileDelivery ?? false,
        localFilesystem: attach.value.capabilities?.localFilesystem ?? false,
        color: attach.value.capabilities?.color ?? false,
        claims: attach.value.capabilities?.claims ?? [],
        ...(attach.value.capabilities?.terminal !== undefined ? { terminal: attach.value.capabilities.terminal } : {}),
        tasksGranted: false,
      },
    };
    this.surfaces.add(surface);
    for (const claim of surface.capabilities.claims) if (claim.verbs === undefined) this.claimedSeen.add(claim.subject.toLowerCase());
    this.send(socket, {
      type: 'attached',
      session: this.sessionId,
      // This surface's own id, so it can find itself among the heartbeat's surfaces.
      surface: surface.id,
      protocolVersion: CONTRACT_VERSION,
      ...(this.stack !== undefined ? { stack: this.stack } : {}),
      ...(this.backend !== undefined ? { backend: this.backend } : {}),
      // Declared state, present from the first frame: a surface's lamp and a
      // remote shell's banner read it, never infer it.
      hostControl: this.hostControl,
      // Whether this session can be raised to MANAGE with the person's password.
      elevation: this.elevation !== undefined,
      // Whether this process still runs the code on its disk; a surface
      // says CALYPSO DAEMON OUT OF DATE only on this, never on its own
      // build alone (an ARGUS-only release changes no daemon code).
      stale: this.stale,
      terminals: this.terminals !== null,
    });
    this.codeCheck?.();
    this.scrollback_replay(socket);
    // The newcomer shows the right prompt immediately, before any command.
    void this.promptline_push(surface);
    // Regard is a retained cell: a late attacher receives the current value
    // rather than waiting for the operator's next indication.
    const retained: Regard | null = this.regard ?? this.engine.regard_get?.() ?? null;
    if (retained !== null) {
      this.send(socket, { type: 'regard', regard: retained });
    }
    return surface;
  }

  /**
   * Opens or closes a surface's watch on a subject and answers with the
   * subject's state. A daemon whose engine cannot watch says so rather than
   * leaving the surface waiting for liveness that will never come.
   *
   * @param origin - The surface asking.
   * @param subject - The subject address.
   * @param on - True to watch, false to release.
   */
  private watch_receive(origin: Surface, subject: string, on: boolean): void {
    if (this.engine.watch_set === undefined) {
      this.send(origin.socket, { type: 'error', reason: 'this session cannot watch subjects' });
      return;
    }
    const state: WatchState | null = this.engine.watch_set(subject, origin.id, on);
    if (state === null) {
      this.send(origin.socket, { type: 'error', reason: `not a watchable subject: ${subject}` });
      return;
    }
    this.send(origin.socket, { type: 'watched', subject, state });
  }

  /**
   * Relays an engine-originated event to every surface: a sampler's refreshed
   * model rides the session bus tagged with the daemon as its surface (off
   * the scrollback — it is state, not something the operator did), a
   * watch state change goes out as its own message, and a numbering goes
   * only to the surface whose line listed.
   *
   * @param event - The ambient event.
   */
  private ambient_relay(event: AmbientEvent): void {
    for (const surface of this.surfaces) {
      if (event.kind === 'envelope') {
        // An envelope for one surface (a joblet's notice) goes to it while it
        // is attached, and to everyone once it has gone.
        const mine: boolean = event.origin === undefined
          || ![...this.surfaces].some((each: Surface): boolean => this.stopper_resolve(each).id === event.origin)
          || this.stopper_resolve(surface).id === event.origin;
        if (mine) this.send(surface.socket, { type: 'session', surface: DAEMON_SURFACE, envelope: event.envelope });
      } else if (event.kind === 'progress') {
        // A joblet's progress is its own surface's, live: nobody else's views follow it.
        if (this.stopper_resolve(surface).id === event.origin) this.send(surface.socket, { type: 'progress', id: event.id, ...event.progress });
      } else if (event.kind === 'watched') {
        this.send(surface.socket, { type: 'watched', subject: event.subject, state: event.state });
      } else if (this.stopper_resolve(surface).id === event.origin) {
        // A numbering is the listing surface's own: another surface's `@3`
        // still counts the rows it read (#1273).
        this.send(surface.socket, { type: 'numbered', id: event.id, source: event.source, rows: event.rows, handles: event.handles });
      }
    }
  }

  /**
   * Retains a regard write (last write wins), mirrors it into the engine as
   * session truth, and rebroadcasts it to every attached surface — the
   * writer included, so all surfaces converge on the same retained value.
   *
   * @param regard - The indicated address with its provenance.
   */
  private regard_receive(regard: Regard): void {
    this.regard = regard;
    this.engine.regard_note?.(regard);
    for (const surface of this.surfaces) {
      this.send(surface.socket, { type: 'regard', regard });
    }
  }

  /**
   * Renders the current prompt (when the host supplies a provider) and pushes
   * it to a surface, or to all surfaces when none is given. Called after each
   * command — the context may have changed — and on attach.
   *
   * @param target - The surface to push to; omitted to push to all.
   */
  private async promptline_push(target?: Surface): Promise<void> {
    if (!this.promptProvider) {
      return;
    }
    const provided: PromptContext = await this.promptProvider(this.lastCommand);
    // The session's open questions are the daemon's to count, not the backend's.
    const context: PromptContext = this.questionsOpen.size > 0 ? { ...provided, questions: this.questionsOpen.size } : provided;
    this.promptWarmupActive = context.procWarmup !== undefined;
    if (target) {
      this.send(target.socket, { type: 'promptline', context });
      return;
    }
    for (const surface of this.surfaces) {
      this.send(surface.socket, { type: 'promptline', context });
    }
  }

  /**
   * Replays the retained scrollback to a freshly attached surface as session
   * events, so it arrives seeing recent activity rather than blank.
   *
   * @param socket - The surface to replay to.
   */
  private scrollback_replay(socket: WebSocket): void {
    for (const entry of this.scrollback) {
      this.send(socket, { type: 'session', surface: entry.surface, envelope: entry.envelope });
    }
  }

  /**
   * Records an envelope in scrollback (trimming to the retention bound) and
   * broadcasts it to every attached surface except the one that produced it,
   * which already received it as the correlated `result`.
   *
   * @param origin - The surface that produced the envelope.
   * @param envelope - The envelope to publish.
   */
  private bus_publish(origin: Surface, envelope: CommandEnvelope, mirrored: boolean = false): void {
    this.scrollback.push({ surface: origin.id, envelope });
    if (this.scrollback.length > this.scrollbackSize) {
      this.scrollback.splice(0, this.scrollback.length - this.scrollbackSize);
    }
    // A browser that mirrors a command into its own consoles has shown it
    // there already: their chells are skipped, every other surface hears it.
    const shown: string[] = mirrored ? this.terminalsOf(origin) : [];
    for (const surface of this.surfaces) {
      if (surface.capabilities.terminal !== undefined && shown.includes(surface.capabilities.terminal)) continue;
      if (surface !== origin) {
        this.send(surface.socket, { type: 'session', surface: origin.id, envelope, ...(origin.capabilities.terminal !== undefined ? { terminal: origin.capabilities.terminal } : {}) });
      }
    }
  }

  /**
   * What a line holds while it runs, as the engine reads it off the line: a
   * read runs beside anything, and lines changing the same piece of the
   * session take turns (#1273).
   *
   * @param line - The line.
   * @returns What it holds.
   */
  private lineWant_get(line: string): LockSet {
    let held: string[] | 'all' = 'all';
    try {
      held = this.engine.line_holds?.(line) ?? 'all';
    } catch {
      // A line the engine cannot read runs alone, as every line once did.
    }
    return held === 'all' ? LOCKS_ALL : new Set(held);
  }

  /**
   * Runs one line in its turn: it waits until nothing running holds what it
   * changes, then runs in a slot of its own.
   *
   * @param origin - The surface that submitted the request.
   * @param message - The execute request.
   */
  private async line_run(origin: Surface, message: ExecuteMessage): Promise<void> {
    this.lineCount += 1;
    const slot: CommandSlot = {
      key: `line-${this.lineCount}`,
      origin,
      id: message.id,
      instrument: message.instrument === true,
      line: message.line,
      startedAt: performance.now(),
      want: this.lineWant_get(message.line),
      hold: null,
      asideStoppable: false,
      abandon: null,
    };
    slot.hold = await this.lane.acquire(slot.want);
    slot.startedAt = performance.now();
    this.running.add(slot);
    try {
      // The command runs inside its own slot, so whatever the engine raises
      // (a prompt, output, a pipe segment) reaches the surface that
      // submitted it, whatever else runs meanwhile.
      await this.slotScope.run(slot, (): Promise<void> => this.execute_run(slot, message));
    } finally {
      this.running.delete(slot);
      if (slot.hold !== null) this.lane.release(slot.hold);
      slot.hold = null;
    }
  }

  /**
   * Runs one execute request: replies to the requester with the result, and
   * publishes each envelope to the session bus.
   *
   * @param slot - The line's slot, holding its turn.
   * @param message - The execute request.
   */
  private async execute_run(slot: CommandSlot, message: ExecuteMessage): Promise<void> {
    const origin: Surface = slot.origin;
    let envelopes: CommandEnvelope[] | undefined;
    let failureReason: string | undefined;
    const startedAt: number = slot.startedAt;
    {
      // A STOP pressed while this command waited its turn ends it unrun.
      const stopper: Surface = this.stopper_resolve(origin);
      const pendingAt: number | undefined = message.instrument === true ? undefined : this.stopPending.get(stopper);
      if (pendingAt !== undefined) this.stopPending.delete(stopper);
      if (pendingAt !== undefined && Date.now() - pendingAt < STOP_PENDING_MS) {
        envelopes = [{ status: 'error', rendered: '', renderedErr: `stopped: \`${message.line}\` was stopped before it ran\n` }];
      } else try {
        // A stopped command that does not end is abandoned: the session
        // stops waiting, and whatever it does later is no one's.
        const abandoned: Promise<CommandEnvelope[]> = new Promise((resolve: (value: CommandEnvelope[]) => void): void => {
          slot.abandon = (): void => resolve([{ status: 'error', rendered: '', renderedErr: `stopped: \`${message.line}\` did not end when asked and was abandoned\n` }]);
        });
        // The line counts against its surface's own last answer: a terminal
        // a surface shows is that surface (#1273).
        envelopes = await Promise.race([this.engine.line_execute(message.line, { origin: stopper.id, id: slot.key }), abandoned]);
      } catch (err: unknown) {
        failureReason = err instanceof Error ? err.message : String(err);
      } finally {
        slot.abandon = null;
      }
      this.lastCommand = {
        durationMs: Math.round(performance.now() - startedAt),
        exitCode:
          failureReason !== undefined ||
          (envelopes?.some((envelope): boolean => envelope.status === 'error') ?? false)
            ? 1
            : 0,
      };
      // A remote REPL draws its next prompt as soon as `result` resolves the
      // command. Push the refreshed context first so that prompt cannot lag
      // one command behind state changes such as `cd`.
      await this.promptline_push();
      if (envelopes !== undefined) {
        this.send(origin.socket, { type: 'result', id: message.id, envelopes });
        // Instrument traffic (a panel's silent refresh, an ambient cycler)
        // is surface-internal: it never enters the session bus or the
        // scrollback, so siblings and reattach replays carry only what the
        // operator actually did.
        if (message.instrument !== true) {
          for (const envelope of envelopes) {
            this.bus_publish(origin, envelope, message.mirrored === true);
          }
        }
      } else {
        this.send(origin.socket, {
          type: 'error',
          id: message.id,
          reason: failureReason ?? 'engine execution failed',
        });
      }
    }
  }

  /**
   * Takes a hold for work no line of a surface runs (a joblet): it waits in
   * the same lane as every line, and runs beside the lines it shares
   * nothing with (#1273).
   *
   * @param holds - What the work changes, or 'all'.
   * @returns Gives the hold back; a second call does nothing.
   */
  public async hold_take(holds: string[] | 'all'): Promise<() => void> {
    const hold: Hold = await this.lane.acquire(holds === 'all' ? LOCKS_ALL : new Set(holds));
    let given: boolean = false;
    return (): void => {
      if (given) return;
      given = true;
      this.lane.release(hold);
    };
  }

  /**
   * Waits on a person without holding the session: the request is sent and
   * what the line holds given up, so other lines run; when the person
   * answers, the line queues for its turn again.
   *
   * @param ask - Sends the request (under the asking command's slot) and
   *   resolves with the person's answer.
   * @returns The answer.
   */
  private async person_await<T>(ask: () => Promise<T>, stoppable: boolean = false): Promise<T> {
    const answered: Promise<T> = ask();
    const mine: CommandSlot | undefined = this.slotScope.getStore();
    if (mine === undefined || mine.hold === null) return await answered;
    // What the line holds is given up while it waits, and its slot stays
    // its own: the engine keeps its per-line state (its exit code, a pipe's
    // untaken input, its cancellation) per line, so nothing is handed over.
    // A line waiting aside on a task stays the operator's to stop, and
    // stays so while it waits for its turn again behind another's line: a
    // STOP in that moment would otherwise find nothing of theirs running.
    mine.asideStoppable = stoppable && !mine.instrument;
    this.lane.release(mine.hold);
    mine.hold = null;
    try {
      return await answered;
    } finally {
      mine.hold = await this.lane.acquire(mine.want);
      mine.asideStoppable = false;
    }
  }


  /**
   * Waits aside: the running command steps out of the lane while it waits
   * on something that is not the session's work (a task's next line), so
   * other lines run meanwhile, and takes its turn again before going on.
   * Its surface's STOP still reaches it.
   *
   * @param waiting - What it waits on.
   * @returns What that resolved with.
   */
  public aside_current<T>(waiting: Promise<T>): Promise<T> {
    if (this.currentOrigin === null) return waiting;
    return this.person_await((): Promise<T> => waiting, true);
  }

  /**
   * Raises a prompt on the surface running the current command, returning its
   * answer. The host installs an engine-side input broker that calls this; the
   * engine therefore prompts through the wire without knowing the transport.
   *
   * @param message - The prompt text to show.
   * @param hidden - Whether to request no-echo entry (a password).
   * @returns The surface's answer.
   * @throws {Error} When no command is executing, the surface cannot securely
   *   collect a requested hidden answer, or the surface disconnects before
   *   answering.
   */
  public prompt_current(request: PromptRelay): Promise<string> {
    // A stopped command may not ask anyone anything.
    if (this.engine.command_stopped?.() === true) return Promise.reject(new Error('the command was stopped'));
    const origin: Surface | null = this.currentOrigin;
    if (!origin) {
      return Promise.reject(new Error('no active command to prompt for'));
    }
    if (this.currentInstrument) {
      // A surface's own housekeeping asked the operator a question. It is
      // refused here rather than shown, because the operator did not issue
      // the command that raised it and cannot be expected to answer for it.
      return Promise.reject(new Error('an instrument command cannot ask the operator a question'));
    }
    if (request.hidden && !origin.capabilities.hiddenInput) {
      return Promise.reject(new Error('this surface cannot securely collect hidden input'));
    }
    if (this.prompts.pending_has(origin.socket)) {
      // One question at a time. Queuing them invisibly hands an operator a
      // question whose command they have forgotten issuing.
      return Promise.reject(new Error('another question is already open on this surface'));
    }
    // An open question is the session's to show: every surface's prompt
    // context counts it, and `who` says who asked what.
    this.questionsOpen.set(origin, { message: request.message, at: performance.now() });
    void this.promptline_push();
    const settled = (): void => {
      this.questionsOpen.delete(origin);
      void this.promptline_push();
    };
    return this.person_await((): Promise<string> => this.prompts.open(origin.socket, (promptId: string): void => {
      this.send(origin.socket, {
        type: 'prompt',
        promptId,
        message: request.message,
        hidden: request.hidden,
        ...(request.wants === undefined ? {} : { wants: request.wants }),
        ...(request.path === undefined ? {} : { path: request.path }),
        ...(request.commit === undefined ? {} : { commit: request.commit }),
      });
    }).finally(settled));
  }

  /**
   * Streams structured progress from the executing command to its origin
   * surface. Progress is live-only; when no command is active or the surface is
   * gone, the event is dropped.
   *
   * @param event - The structured progress facts.
   * @returns True when the event was sent to a surface.
   */
  public progress_current(event: ProgressEvent): boolean {
    const origin: Surface | null = this.currentOrigin;
    const id: string | null = this.currentId;
    if (!origin || !id || origin.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.send(origin.socket, { type: 'progress', id, ...event });
    return true;
  }

  /**
   * Sends a typed event from the executing command to its origin surface.
   * Like output, an event is live only: when no command is active or the
   * origin surface is gone, it is dropped.
   *
   * @param kind - What the data is (`games.trek.state`).
   * @param data - The event, shaped by its kind.
   * @returns True when the event was sent to a surface.
   */
  public event_current(kind: string, data: unknown): boolean {
    if (this.engine.command_stopped?.() === true) return false;
    const origin: Surface | null = this.currentOrigin;
    const id: string | null = this.currentId;
    if (!origin || !id || origin.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.send(origin.socket, { type: 'event', id, kind, data });
    return true;
  }

  /**
   * Streams an opaque live output chunk from the executing command to its
   * origin surface. Output is live telemetry, distinct from final envelopes;
   * when no command is active or the origin surface is gone, it is dropped.
   *
   * @param channel - The output channel that produced the chunk.
   * @param chunk - The text chunk to forward.
   * @returns True when the chunk was sent to a surface.
   */
  public output_current(channel: 'data' | 'err' | 'status', chunk: string): boolean {
    // An abandoned command's late output belongs to no one.
    if (this.engine.command_stopped?.() === true) return false;
    const origin: Surface | null = this.currentOrigin;
    const id: string | null = this.currentId;
    if (!origin || !id || origin.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.send(origin.socket, { type: 'output', id, channel, chunk });
    return true;
  }

  /**
   * Runs a pipeline segment on the surface running the current command,
   * returning its output. The host installs a `pipeSegment` on its engine-side
   * surface that calls this, so a pipeline's segments run on the client and
   * never on the daemon host. Data crosses the wire base64-encoded.
   *
   * @param command - The segment command line.
   * @param input - The bytes to feed the segment.
   * @returns The segment's output bytes.
   * @throws {Error} When no command is executing or the surface disconnects.
   */
  public pipe_current(command: string, input: Buffer): Promise<Buffer> {
    const origin: Surface | null = this.surfaceActing();
    if (!origin) {
      return Promise.reject(new Error('no active command to run a pipe segment for'));
    }
    return this.pipes.open(origin.socket, (pipeId: string): void => {
      this.send(origin.socket, { type: 'pipe', pipeId, command, input: input.toString('base64') });
    });
  }

  /**
   * Runs a host-shell command on the surface running the current command.
   * The daemon never spawns the process itself.
   *
   * @param command - The shell command without the leading `!`.
   * @returns The surface process exit code.
   * @throws {Error} When no command is executing or the surface disconnects.
   */
  public shell_current(command: string, toIssuer: boolean = false): Promise<number> {
    // Under host control a terminal's own chell runs it, in its pty: it is
    // on this host already, and a full-screen program gets a terminal.
    const origin: Surface | null = toIssuer ? this.currentOrigin : this.surfaceActing();
    if (!origin) {
      return Promise.reject(new Error('no active command to run a shell command for'));
    }
    if (!origin.capabilities.shellCommands) {
      return Promise.reject(new Error('this surface has no shell, and the daemon was not started with --host-control'));
    }
    return this.shells.open(origin.socket, (shellId: string): void => {
      this.send(origin.socket, { type: 'shell', shellId, command });
    });
  }

  /**
   * Opens content in the editor of the surface running the current command
   * and returns the edited result. The host installs a `localEdit` on its
   * engine-side surface that calls this, so `edit` opens the operator's own
   * editor and never one on the daemon host.
   *
   * @param content - The content to edit.
   * @param extension - An optional filename extension for syntax mode.
   * @param path - The file being edited, for an editor that stays open and
   *   saves back to it (a browser's editor pane).
   * @returns The edited content and whether it changed, or that an editor
   *   which stays open took it.
   * @throws {Error} When no command is executing or the surface disconnects.
   */
  public edit_current(content: string, extension: string | undefined, path?: string): Promise<EditOutcome> {
    const origin: Surface | null = this.surfaceActing();
    if (!origin) {
      return Promise.reject(new Error('no active command to edit for'));
    }
    // Someone is editing: the session is free meanwhile.
    return this.person_await((): Promise<EditOutcome> => this.edits.open(origin.socket, (editId: string): void => {
      this.send(origin.socket, { type: 'edit', editId, content, extension, ...(path === undefined ? {} : { path }) });
    }));
  }

  /**
   * Reports what the surface running the current command can do on its own
   * machine. A daemon has no capabilities of its own to offer: every one it
   * presents belongs to whichever surface asked.
   *
   * @returns The executing surface's declared capabilities; nothing when no
   *   command is running.
   */
  /**
   * The surfaces attached now, each named a terminal or a browser, the one
   * running the current command marked: what `who` answers.
   *
   * @returns The surfaces, in attach order.
   */
  public surfaces_list(): Array<{ id: string; kind: 'chell' | 'browser'; you: boolean; asking?: string }> {
    return [...this.surfaces].map((each: Surface) => ({
      id: each.id,
      kind: each.capabilities.shellCommands ? 'chell' as const : 'browser' as const,
      you: each === this.currentOrigin,
      ...(this.questionsOpen.has(each) ? { asking: (this.questionsOpen.get(each) as { message: string }).message } : {}),
    }));
  }

  public capabilities_current(): { fileDelivery: boolean; localFilesystem: boolean; color: boolean; pipeSegments: boolean; tasks: boolean } | null {
    const origin: Surface | null = this.surfaceActing();
    return origin ? {
      fileDelivery: origin.capabilities.fileDelivery,
      localFilesystem: origin.capabilities.localFilesystem,
      // Raised with the person's password: a terminal's lines act as its owning browser's.
      tasks: origin.capabilities.tasksGranted,
      // A surface that runs shell commands (a chell) runs pipe segments too.
      pipeSegments: origin.capabilities.shellCommands,
      color: this.currentOrigin?.capabilities.color ?? origin.capabilities.color,
    } : null;
  }

  /**
   * Asks the surface running the current command to place a file where its
   * operator can reach it. The host installs a `fileDeliver` on its engine-side
   * surface that calls this, so `download` writes to the operator's machine and
   * never to the daemon host's disk.
   *
   * Only the request crosses here. The surface fetches the bytes itself from
   * `/vfs`, which is the same token-gated route a browser already uses to
   * render a file natively.
   *
   * @param request - What to deliver and where the operator asked for it.
   * @returns Where the file landed and how large it was.
   * @throws {Error} When no command is executing or the surface disconnects.
   */
  public deliver_current(request: FileDeliverRequest): Promise<DeliverOutcome> {
    const origin: Surface | null = this.surfaceActing();
    if (!origin) {
      return Promise.reject(new Error('no active command to deliver a file for'));
    }
    if (!origin.capabilities.fileDelivery) {
      return Promise.reject(new Error('this surface cannot receive a file'));
    }
    return this.deliveries.open(origin.socket, (deliverId: string): void => {
      this.send(origin.socket, {
        type: 'deliver',
        deliverId,
        path: request.path,
        filename: request.filename,
        ...(request.destination !== undefined ? { destination: request.destination } : {}),
        ...(request.size !== undefined ? { size: request.size } : {}),
        ...(request.contentType !== undefined ? { contentType: request.contentType } : {}),
      });
    });
  }

  /**
   * Runs one completion request and sends its reply, or an error. Completion
   * is a read and is not broadcast.
   *
   * @param socket - The surface to reply to.
   * @param message - The completion request.
   */
  private async complete_run(socket: WebSocket, message: CompleteRequest): Promise<void> {
    try {
      const result: CompletionResult = await this.engine.line_complete(message.prefix);
      // The surfaces' own subjects and claimed verbs complete like any command.
      const claims: SurfaceClaim[] = [...this.surfaces].flatMap((each: Surface): SurfaceClaim[] => each.capabilities.claims);
      const offered: string[] = claimCandidates_list(claims, message.prefix).filter((word: string): boolean => !result.candidates.includes(word));
      this.send(socket, {
        type: 'complete',
        id: message.id,
        prefix: result.prefix,
        candidates: [...result.candidates, ...offered],
      });
    } catch (err: unknown) {
      const reason: string = err instanceof Error ? err.message : String(err);
      this.send(socket, { type: 'error', id: message.id, reason });
    }
  }

  /**
   * Sends a message to a surface if the socket is still open.
   *
   * @param socket - The destination surface.
   * @param message - The message to send.
   */
  /**
   * Tells every attached surface the daemon is going away, and why; resolves
   * once each message has left (or a short wait has passed), so the process
   * can exit after it rather than before.
   *
   * @param cause - Why: a door restart, an administrator's end, or a plain stop.
   * @param waitMs - The longest it waits for the sends to leave.
   */
  public closing_announce(cause: ClosingCause, waitMs: number = 500): Promise<void> {
    const sends: Array<Promise<void>> = [];
    for (const surface of this.surfaces) {
      if (surface.socket.readyState !== WebSocket.OPEN) continue;
      sends.push(new Promise<void>((resolve: () => void): void => {
        surface.socket.send(JSON.stringify({ type: 'closing', cause }), (): void => resolve());
      }));
    }
    return Promise.race([
      Promise.all(sends).then((): void => undefined),
      new Promise<void>((resolve: () => void): void => { setTimeout(resolve, waitMs).unref(); }),
    ]);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
