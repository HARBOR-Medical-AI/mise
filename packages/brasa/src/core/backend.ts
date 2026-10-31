/**
 * @file The backend descriptor: everything a session needs that the core does
 * not know.
 *
 * The engine runs over exactly one backend (docs/backend-neutral.adoc). The
 * core asks it to prepare its own state, where the session's home is, and
 * where the working directory was left, what the prompt shows and what the
 * daemon heartbeats, which `${name}` references it answers and what kinds of
 * row its listings number. ChRIS is one backend
 * (`chris/backend.ts`), installed by the package entry; a host may install
 * another before the engine boots.
 *
 * @module
 */
import type { JobSource } from './runner.js';
import type { PromptContext, CubeTelemetry, JobsStateTelemetry, CommandEnvelope, WatchState, Task } from '@fnndsc/menu';
import type { ReferenceValue } from '../lib/parser.js';
import type { ListingLook, VFSDispatcher } from '@fnndsc/fond';
import type { ListingItem } from '@fnndsc/menu';

/**
 * Who a session is and where: the input a host keys the session by (calypso's
 * berth name is `user@where`, normalised).
 *
 * A disconnected session still has one, so it stays discoverable; each
 * backend names its own (`where` naming the backend), so two backends'
 * disconnected sessions never share a name.
 */
export interface SessionIdentity {
  /** The user, exactly as the backend knows them. */
  readonly user: string;
  /** Where the session lives: a server URL, or a name for no server. */
  readonly where: string;
  /** Whether the session is connected to `where`. */
  readonly connected: boolean;
}

/** What a backend tells the core about the session it serves. */
export interface BackendSession {
  /** Prepares the backend's own state (configuration, stored credentials) before the session starts. */
  init(): Promise<void>;
  /** Who the session is, connected or not. */
  identity_get(): Promise<SessionIdentity>;
  /** The session's user as the backend last knew them, or null when it knows none. */
  user_get(): Promise<string | null>;
  /** The session's home: where it begins before it has a working directory of its own. */
  home_get(): Promise<string>;
  /** The working directory the identity left, or null when it has none stored. */
  cwd_load(): Promise<string | null>;
  /** Stores the working directory for the identity. */
  cwd_save(path: string): Promise<void>;
}

/** What the core knows about the previous command, for the prompt. */
export interface PromptLastCommand {
  lastExitCode?: number;
  lastCommandDurationMs?: number;
}

/**
 * What a daemon heartbeats about the backend's own state, in the wire's
 * telemetry shape: the index counts, the server's pace, the work in flight.
 */
export interface BackendTelemetry {
  jobs: number;
  feeds: number;
  cube?: CubeTelemetry;
  state?: JobsStateTelemetry;
}

/** A name the session answers for in `${name}`, and the dotted names under it. */
export interface ReferenceSource {
  /** The name (`feed`); a dotted name under it (`feed.x`) is asked of it too. */
  readonly name: string;
  /**
   * What a name refers to now: its value, null when the session has none
   * yet, or undefined when it is a dotted name this source does not answer
   * (the manifest's parameters and the environment are asked next).
   */
  readonly resolve: (name: string) => Promise<ReferenceValue | undefined>;
  /**
   * The verbs whose line may change what it answers, so a dry run leaves it
   * as written past one of them. Unset, any line may.
   */
  readonly changedBy?: ReadonlyArray<string>;
}

/** What a claim's subject answered: the value, or why it could not say. */
export interface ExpectReading {
  /** The value read, as text; null when it could not be read. */
  readonly got: string | null;
  /** Why it could not be read, or why the claim cannot be made. */
  readonly refusal?: string;
}

/** One `expect` claim, as its subject is asked it. */
export interface ExpectAsk {
  /** Which one, for a subject that names one (`feed 4599`); absent for one that does not (`gather`). */
  readonly target?: string;
  /** What about it (`status`, `count`). */
  readonly property: string;
  /** The words a property takes before the comparison (`tags PatientID`: `['PatientID']`). */
  readonly words: ReadonlyArray<string>;
  /** A glob narrowing a count (`--matching`). */
  readonly matching?: string;
  /** Look beneath, not only in (`--deep`). */
  readonly deep: boolean;
}

/**
 * Something `expect` can make claims about. The core answers `path` (`exists`,
 * `count`); a backend registers its own world (ChRIS: `gather`, `feed`, `run`,
 * and `tags` on `path`; stratus: `cluster`). Two subjects of one name are one
 * subject whose properties are both of theirs: each answers its own.
 */
export interface ExpectSubject {
  /** The word a claim begins with. */
  readonly name: string;
  /** Whether a claim names one (`feed 4599 status`) or the subject is one thing (`gather size`). */
  readonly named: boolean;
  /** The properties it answers, each with how many words it takes before the comparison. */
  readonly properties: Readonly<Record<string, number>>;
  /** Reads one property; asked only for a property it lists. */
  readonly read: (ask: ExpectAsk) => Promise<ExpectReading>;
}

/** A kind of row a listing numbers, as an index writes it: `@SER3` is the third series. */
export interface AnswerKindLook {
  /** Three capital letters. */
  readonly code: string;
  /** The kind in words, for a refusal: `a series`. */
  readonly word: string;
  /** An index of it, for the refusal that teaches the syntax (`@SER3`); a kind without one is not shown there. */
  readonly example?: string;
  /**
   * The kind stands for other rows (a study for its series, a patient for
   * theirs): a whole listing handed on (a pipe, `${listing}`) gives its
   * other rows, never these, so nothing is taken twice.
   */
  readonly group?: boolean;
}

/** The kinds a verb can be handed by index, beyond those the core declares for it. */
export interface VerbTakes {
  readonly verb: string;
  readonly kinds: ReadonlyArray<string>;
}

/**
 * What a backend does with a command word the registry does not answer.
 *
 * The core runs a line in one of two ways: directly, its output going to
 * the surface, or captured, its output feeding a pipe or a redirect. Each
 * asks the backend at fixed points, so a backend's words are found where
 * they always were.
 */
export interface BackendFallback {
  /**
   * A word the backend runs ahead of the registry on a direct line, and
   * after the registry's envelope commands on a captured one (ChRIS: a
   * plugin named with its version). Null when the word is not one.
   */
  readonly claim?: (command: string, args: string[]) => Promise<CommandEnvelope | null>;
  /**
   * A word nothing else answered. The envelope it returns has been
   * delivered; null means the backend does not know the word either, and
   * the core says `command not found`.
   */
  readonly unknown?: (command: string, args: string[], captured: boolean) => Promise<CommandEnvelope | null>;
  /** Help for a word the registry has no page for, or null to let the core say it has none. */
  readonly help?: (command: string) => Promise<string | null>;
}

/** A listing cache: listings kept for a while, each saying whether it is still current. */
export interface ListingCache {
  /** A kept listing and whether it is current, or null when none is kept. */
  cache_get<T = unknown>(path: string): { data: T; fresh: boolean } | null;
  /** Keeps a listing; with `since`, only when nothing invalidated its folder after that stamp. */
  cache_set<T = unknown>(path: string, data: T, options?: { since?: number }): void;
  /** A stamp to take before fetching a listing, handed back to `cache_set` as `since`. */
  stamp_take?(): number;
  /** Forgets one folder's listing: something in it changed. */
  cache_invalidate?(path: string): void;
  /** Forgets a folder's listing and every one beneath it: the folder went. */
  cache_invalidateTree?(path: string): void;
}

/** What entering a folder outside the mounts came to, for `cd`. */
export interface FolderEntry {
  /** The working directory to stand in, or null when the path is not a folder one can. */
  readonly cwd: string | null;
  /** What `cd` shows on its way (a debugging trace). */
  readonly rendered: string;
  /** What `cd` says when it cannot, in full; empty to let the core say `No such file or directory`. */
  readonly renderedErr: string;
}

/**
 * One file's bytes as a stream, for a surface that must not wait for (or
 * hold) the whole file: a 3.7 GB DICOM goes to the browser as it arrives.
 *
 * @property stream - The bytes.
 * @property size - The length in bytes, when the store gave one.
 */
export interface FileByteStream {
  readonly stream: NodeJS.ReadableStream;
  readonly size?: number;
}

/** The backend's filesystem, as the core's listings, globbing and completion read it. */
export interface BackendFilesystem {
  /** Every path goes through it: the backend's mounts and its fallback. The core adds its own mounts. */
  readonly dispatcher: VFSDispatcher;
  /** Where listings are kept between reads; absent, every listing is read afresh. */
  readonly cache?: ListingCache;
  /** Whether a path's listing may be kept (ChRIS: not under `/proc`, which keeps its own); absent, every path may. */
  readonly cache_holds?: (path: string) => boolean;
  /** What a long listing's rows carry beyond the listing (ChRIS: a feed's tags). */
  readonly longRows_annotate?: (items: ListingItem[]) => Promise<ListingItem[]>;
  /**
   * The folders whose links the last walk could not read, taken (and so
   * cleared): a listing that fails says the path was walked as written.
   */
  readonly unreadLinks_take?: () => Promise<string[]>;
  /** A folder as the filesystem holds it, links followed, for globbing beneath it; absent, the path as given. */
  readonly path_physical?: (path: string) => Promise<string>;
  /** Paths that are always folders, entered without asking (beside the mounts and the folders above them). */
  readonly structural?: ReadonlyArray<string>;
  /**
   * Enters a folder outside the mounts (`cd`): whether it is one, and where
   * the session then stands. Absent, a path that lists is a folder.
   */
  readonly folder_enter?: (logicalPath: string, pathArg: string) => Promise<FolderEntry>;
  /** The title a path segment shows under `pwd --title` (ChRIS: a feed's name), or null for none. */
  readonly segment_title?: (segment: string) => Promise<string | null>;
}

/** What a backend adds to completion. */
export interface BackendCompletion {
  /** Command words beyond the registry's (ChRIS: its plugins). */
  readonly commandWords?: () => Promise<string[]>;
  /** The `--option` words for a line, or null when the line is not one the backend completes. */
  readonly options?: (args: string[], word: string) => Promise<string[] | null>;
  /** Whether a command word of the backend's takes paths as its arguments (ChRIS: a `/bin` entry, whose operand is a path, #1305). */
  readonly pathArguments?: (command: string) => Promise<boolean>;
  /** Names completed at `/` even when the root's listing lacks them; absent, the core's `usr`. */
  readonly rootWords?: ReadonlyArray<string>;
}

/**
 * Where a backend's long-running steps come from: one kind of task (ChRIS:
 * its plugin instances; an infrastructure backend: its install steps).
 */
export interface TaskSource {
  /** Its name, and its folder: `/proc/<id>`. */
  readonly id: string;
  /** What an operator reads it as. */
  readonly label: string;
  /**
   * The backend mounts `/proc/<id>` itself (ChRIS's `/proc/jobs`, a tree of
   * feeds and instances); otherwise the core mounts each task as a folder of
   * its fields.
   */
  readonly mounted?: boolean;
  /** Its tasks, now. */
  list(): Promise<Task[]>;
  /** One task's log, whole; absent, its `logTail` is its log. */
  log?(id: string): Promise<string | null>;
}

/** Administrator credentials, collected by the core from the surface. */
export interface ElevationCredentials {
  username: string;
  password: string;
}

/** One backend, as the core sees it. */
export interface Backend {
  /** Stable id naming the backend. */
  readonly id: string;
  /** The session it serves. */
  readonly session: BackendSession;
  /** The session facts a prompt shows, in the wire's prompt context. */
  readonly prompt?: (last?: PromptLastCommand) => Promise<PromptContext>;
  /** The daemon's heartbeat about the backend's state; read often, so it is cheap. */
  readonly telemetry?: () => BackendTelemetry;
  /** The `${name}` references it answers, beside the core's `cwd`. */
  readonly references?: ReadonlyArray<ReferenceSource>;
  /** The kinds of row its listings number; they lead the core's (`FIL`, `DIR`) wherever kinds are listed. */
  readonly answerKinds?: ReadonlyArray<AnswerKindLook>;
  /** The kinds its verbs take by index, and those it adds to the core's verbs. */
  readonly verbTakes?: ReadonlyArray<VerbTakes>;
  /** What `expect` can make claims about in this backend's world, beside the core's `path`. */
  readonly expectSubjects?: ReadonlyArray<ExpectSubject>;
  /** What it does with words the registry does not answer. */
  readonly fallback?: BackendFallback;
  /** Runs one command with administrator rights (`sudo`); absent, `sudo` is refused. */
  readonly elevate?: (credentials: ElevationCredentials, run: () => Promise<CommandEnvelope>) => Promise<CommandEnvelope>;
  /** Watches a subject a surface named (ChRIS: a feed's jobs), on behalf of an owner. */
  readonly watch?: {
    readonly set: (subject: string, owner: string, on: boolean) => WatchState | null;
    readonly release: (owner: string) => void;
  };
  /** Reads and writes one file's bytes for a surface, at a path the session resolves. */
  readonly files?: {
    readonly read: (path: string) => Promise<Buffer>;
    readonly write: (path: string, bytes: Buffer) => Promise<void>;
    /** Opens one file's bytes as a stream, never read whole; absent, a surface is served `read`'s buffer. */
    readonly stream?: (path: string) => Promise<FileByteStream>;
  };
  /** The long jobs it hands the core's runner, by kind (core/runner.ts); each is mounted under `/proc` as a task source. */
  readonly jobs?: ReadonlyArray<JobSource>;
  /** Its long-running steps, by kind; the core mounts those that bring no mount of their own under `/proc`. */
  readonly tasks?: ReadonlyArray<TaskSource>;
  /** Its filesystem; absent, the session has only the core's own mounts. */
  readonly vfs?: BackendFilesystem;
  /** What it adds to completion. */
  readonly completion?: BackendCompletion;
  /** How its listings show: the kinds it lists beside the core's, and how a name is coloured. */
  readonly listingLook?: ListingLook;
  /** Whether the backend is debugging (error messages keep their function stamp), or null before it can say. */
  readonly debug_get?: () => boolean | null;
  /** Turns the backend's debugging on or off. */
  readonly debug_set?: (on: boolean) => void;
}

let installed: Backend | null = null;

/**
 * Installs the session's backend. The last install wins; a host installs
 * before the engine boots.
 *
 * @param backend - The backend the session runs over.
 */
export function backend_install(backend: Backend): void {
  installed = backend;
}

/**
 * The installed backend, or null before one is installed: for a reader that
 * has an answer without one (the core's own references and kinds).
 *
 * @returns The backend, or null.
 */
export function backendInstalled_get(): Backend | null {
  return installed;
}

/**
 * The installed backend.
 *
 * @returns The backend the session runs over.
 * @throws Error when no backend is installed: the session cannot run without one.
 */
export function backend_get(): Backend {
  if (installed === null) {
    throw new Error('brasa: no backend installed; install one with backend_install before the engine boots');
  }
  return installed;
}
