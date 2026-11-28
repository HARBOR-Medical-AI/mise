/**
 * @file The engine's contract with the place it runs: where its output goes
 * (`OutputSink`) and what it may ask of whoever drives it (`Surface`).
 *
 * The engine writes output to a sink and asks a surface for what only a
 * surface can give — a hidden prompt, a local editor, a host shell, a file
 * delivered to the operator's machine. A terminal, a session daemon and a
 * test each provide their own; these interfaces are what all of them meet.
 * Types only, like the rest of menu; the implementations live with the
 * engine and the hosts.
 *
 * Served as the subpath `@fnndsc/menu/surface` rather than from the package
 * root, so a browser bundle that imports menu never meets Node's `Buffer`.
 *
 * @module
 */
import type { FileDeliverRequest, FileDeliverResult, PromptKind, PromptPath, ProgressEvent } from './messages.js';

/**
 * What interaction an attached surface can provide.
 *
 * @property hiddenInput - The surface can read a line without echoing it
 *   (password entry).
 * @property localEdit - The surface can open content in a local editor and
 *   return the edited result.
 * @property tty - The surface is an interactive terminal (as opposed to a
 *   pipe, a script, or a headless host).
 * @property color - The surface renders ANSI colour. A colour terminal and a
 *   browser console both do; a bare pipe or a file does not. A command that
 *   can render richly with colour and plainly without it — an image thumbnail
 *   as ANSI half-blocks or an ASCII ramp — reads this to choose, and the
 *   plain rendering is always the floor.
 * @property pipeSegments - The surface can run a pipeline's non-first
 *   segments (`... | grep foo`) through its own tools. Nothing ever spawns on
 *   a daemon host: the local CLI runs segments in-process, a remote CLI runs
 *   them on the client machine, and a browser surface lacks the capability
 *   and fails such pipelines with a clear message.
 * @property shellCommands - The surface can run a `!`-prefixed host-shell
 *   command on its own machine. A daemon delegates this capability to the
 *   command's originating surface and never launches the process itself.
 * @property fileDelivery - The surface can put a file where its operator can
 *   reach it. What that means is the surface's business — a path on the local
 *   CLI's disk, a path on a remote CLI's client machine, a saved file in a
 *   browser — but never the daemon host's disk.
 * @property engineFilesystem - The surface's operator sits at the same
 *   filesystem the engine runs on, so a path the engine resolves is a path
 *   they can open. True only for an in-process local shell. When false, a
 *   builtin that would write to disk must deliver through the surface instead,
 *   because the engine's disk is somebody else's machine.
 * @property localFilesystem - The surface can put many files into a directory
 *   structure of its own. True for any shell, remote included; false for a
 *   browser, which has no directory to fill and can only accept files one at a
 *   time. It answers a different question from `engineFilesystem`: not *whose*
 *   disk, but whether there is one at all.
 * @property tasks - The engine may start long jobs that change things beyond
 *   its host (a cloud's resources, and its bill): the `tasks` tier, declared
 *   only by a daemon whose operator granted it at launch. Absent means no.
 */
export interface SurfaceCapabilities {
  hiddenInput: boolean;
  localEdit: boolean;
  tty: boolean;
  color: boolean;
  pipeSegments: boolean;
  shellCommands: boolean;
  fileDelivery: boolean;
  engineFilesystem: boolean;
  localFilesystem: boolean;
  /**
   * The engine may start programs on its own host (docker, a host shell's program) for this surface: true for an
   * in-process local shell, and for a daemon only when its operator granted the `shell` tier. Computed by the host
   * from its own policy; nothing a surface declares on attach raises it. Absent means no.
   */
  engineProcesses?: boolean;
  tasks?: boolean;
}

/**
 * A request to prompt the user for a line of input.
 *
 * `wants` is what the question is asking FOR, so a surface can choose the
 * instrument that answers it — a browser to walk for a location, a masked
 * field for a secret, two capsules for a yes/no — rather than reading the
 * wording and guessing. A terminal ignores all of it and reads a line,
 * which is why every field beyond `message` is optional.
 *
 * @property message - The prompt text to display.
 * @property hidden - When true, the entered text is not echoed; requires the
 *   `hiddenInput` capability. Kept beside `wants` because it is what an
 *   older surface reads.
 * @property wants - The kind of value that answers this.
 * @property path - Where browsing starts and what to compose, for a `path`.
 * @property commit - The word the committing control should read.
 */
export interface PromptRequest {
  message: string;
  hidden?: boolean;
  wants?: PromptKind;
  path?: PromptPath;
  commit?: string;
  /** What the question is for, as a name a surface may know (`stratus.vm.build`). */
  purpose?: string;
  /** What it is about, by name (`vm`, `account`). */
  subject?: Record<string, string>;
}

/**
 * Content handed to a surface's local editor.
 *
 * @property content - The text to open in the editor.
 * @property extension - Optional filename extension (e.g. `.txt`, `.json`) so
 *   the editor can apply the right syntax mode.
 */
export interface LocalEditRequest {
  content: string;
  extension?: string;
  /** The file being edited; an editor that stays open saves back to it. */
  path?: string;
  /** The file as the line typed it, quoting removed. */
  named?: string;
}

/**
 * The outcome of a local edit.
 *
 * @property content - The content after editing.
 * @property changed - Whether the content differs from what was opened.
 */
export interface LocalEditResult {
  content: string;
  changed: boolean;
  /**
   * The surface opened an editor that stays open (a browser pane) instead of
   * returning the edited text. The command has nothing to save: every save
   * made in that editor runs as its own command line.
   */
  opened?: boolean;
}

/** Another surface on the same session, as the host sees it. */
export interface SurfacePeer {
  /** The host's name for it. */
  id: string;
  /** A terminal or a browser. */
  kind: 'chell' | 'browser';
  /** Whether it is the surface running the current command. */
  you: boolean;
  /** The question it has open, waiting for an answer; absent when none. */
  asking?: string;
}

export interface Surface {
  /** What this surface can do; read by builtins before they interact. */
  readonly capabilities: SurfaceCapabilities;

  /**
   * The surfaces attached to this session, when the host knows of more than
   * itself (a daemon does; a local shell is alone). Absent means unknown.
   */
  peers?(): SurfacePeer[];

  /**
   * Prompts for a line of input.
   *
   * @param request - The prompt message and whether to hide the input.
   * @returns The entered line, trimmed.
   * @throws {CapabilityError} When hidden input is requested but the surface
   *   lacks the `hiddenInput` capability, or the surface cannot prompt.
   */
  prompt(request: PromptRequest): Promise<string>;

  /**
   * Runs one pipeline segment against an input, returning its output. Where
   * this runs is the surface's business — in-process for the local CLI, on
   * the client machine for a remote CLI — but never on a daemon host.
   *
   * @param command - The segment command line (e.g. `grep foo`).
   * @param input - The bytes to feed the segment on stdin.
   * @param signal - Aborted when the operator cancels the command; a surface
   *   that started a process kills it.
   * @returns The segment's stdout.
   * @throws {CapabilityError} When the surface lacks the `pipeSegments`
   *   capability.
   */
  pipeSegment(command: string, input: Buffer, signal?: AbortSignal): Promise<Buffer>;

  /**
   * Runs one host-shell command on the surface machine.
   *
   * @param command - The shell command without the leading `!`.
   * @param signal - Aborted when the operator cancels the command; a surface
   *   that started a process kills it.
   * @returns The process exit code.
   * @throws {CapabilityError} When the surface lacks `shellCommands`.
   */
  shellCommand(command: string, signal?: AbortSignal): Promise<number>;

  /**
   * Opens content in the surface's local editor and returns the result. The
   * editor mechanics are the surface's business — a temp file and `$EDITOR`
   * for the local CLI, the client's editor for a remote CLI, an editor
   * component in a browser.
   *
   * @param request - The content to edit and an optional extension.
   * @returns The edited content and whether it changed.
   * @throws {CapabilityError} When the surface lacks the `localEdit`
   *   capability.
   */
  localEdit(request: LocalEditRequest): Promise<LocalEditResult>;

  /**
   * Places one file where this surface's operator can reach it.
   *
   * The mechanics are the surface's: a write to the resolved path for the
   * local CLI, a write on the client machine for a remote CLI, a saved file
   * for a browser. A daemon never writes to its own disk on a surface's
   * behalf, for the same reason it never spawns a shell there.
   *
   * @param request - What to deliver and where the operator asked for it.
   * @returns Where it landed and how large it was.
   * @throws {CapabilityError} When the surface lacks `fileDelivery`.
   */
  fileDeliver(request: FileDeliverRequest): Promise<FileDeliverResult>;

  /**
   * Waits without holding the session: the command steps out of its turn
   * while the wait lasts, so other lines run (a pane's reads among them),
   * and takes its turn again before going on. Waiting is not working. A
   * host that runs one command at a time and nothing else has no need of
   * it; the command then simply waits.
   *
   * @param waiting - What the command waits on (a task's next line).
   * @returns What it resolved with.
   */
  aside?<T>(waiting: Promise<T>): Promise<T>;

  /**
   * Takes a hold on the session for work outside any line the host ran (a
   * joblet): it waits until nothing running holds what the work changes,
   * as a line does, and gives it back when released. A host that runs one
   * line at a time and nothing else has no need of it.
   *
   * @param holds - The pieces the work changes, or 'all'.
   * @returns Gives the hold back.
   */
  hold?(holds: string[] | 'all'): Promise<() => void>;
}

/**
 * Destination for command output, installed by the host.
 */
export interface OutputSink {
  /**
   * Writes command output (the data channel).
   *
   * @param chunk - Printable text (ANSI permitted) or raw bytes.
   */
  data_write(chunk: string | Buffer): void;

  /**
   * Writes error-stream output (the err channel).
   *
   * @param chunk - Printable text (ANSI permitted) or raw bytes.
   */
  err_write(chunk: string | Buffer): void;

  /**
   * Writes an ephemeral status line (the status channel).
   *
   * @param text - Transient text; consumers may overwrite or drop it.
   */
  status_write(text: string): void;

  progress_write(event: ProgressEvent): void;

  /**
   * Sends a typed event to the command's origin surface, while the command
   * runs.
   *
   * The kind names what the data is (`games.trek.state`); a surface shows
   * the kinds it knows and drops the rest. Optional: a sink that predates
   * events, or has nowhere to send one, leaves it out, and a command sends
   * with `sink.event_write?.(kind, data)`.
   *
   * @param kind - What the data is.
   * @param data - The event, shaped by its kind; it must survive JSON.
   */
  event_write?(kind: string, data: unknown): void;
}
