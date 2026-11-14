/**
 * @file The engine seam the daemon hosts.
 *
 * The daemon is deliberately engine-agnostic: it accepts anything shaped like
 * a hosted engine rather than importing chell directly. This keeps calypso's
 * dependencies to cumin and the wire libraries, and — because chell will
 * import calypso's wire contract for its remote client — avoids a package
 * cycle. chell's `ChellEngine` structurally satisfies this interface, so the
 * launcher (in chell) creates a real engine and hands it to the daemon.
 *
 * @module
 */
import type { CommandEnvelope } from '@fnndsc/cumin';
import type { Regard, WatchState, AmbientEvent } from '@fnndsc/menu';
import type { OutputSink, Surface } from '@fnndsc/menu/surface';

/**
 * A completion answer: the candidates and the prefix they complete.
 *
 * @property candidates - The matching completion candidates.
 * @property prefix - The input prefix the candidates complete.
 */
export interface CompletionResult {
  candidates: string[];
  prefix: string;
}

/**
 * The engine the daemon drives. Matches chell's `ChellEngine` structurally,
 * so a real chell engine is assignable to it without calypso depending on
 * chell.
 */
export interface HostedEngine {
  /**
   * Executes one input line, yielding one envelope per executed command.
   *
   * @param line - The raw input line.
   * @param options - The surface the line came from (what it lists is that
   *   surface's answer), the daemon's name for the line, which its STOP
   *   names, and who hears the line's exit status when it ends.
   * @returns The envelopes of the executed commands, in order.
   */
  line_execute(line: string, options?: { origin?: string; id?: string; ended?: (code: number) => void }): Promise<CommandEnvelope[]>;

  /**
   * Requests cancellation of a running command when it supports it.
   *
   * @param id - The line, as the daemon named it.
   * @returns True when the command accepted the request.
   */
  line_cancel?(id?: string): boolean;
  /** Aborts a running command, cancellable or not (STOP). */
  line_abort?(id?: string): boolean;
  /** Whether the caller runs inside a stopped command. */
  command_stopped?(): boolean;

  /**
   * What a line holds of the session while it runs: the pieces it changes
   * (none for a read), or 'all'. Lines holding nothing in common run side
   * by side; an engine that cannot say runs every line alone.
   *
   * @param line - The line.
   * @returns Its pieces, or 'all'.
   */
  line_holds?(line: string): string[] | 'all';

  /**
   * The joblets running now (`line &`), for the heartbeat: what a restart
   * would end.
   *
   * @returns Them, by number.
   */
  joblets_running?(): Array<{ number: number; line: string; waiting: boolean }>;

  /**
   * Computes completion candidates for a partial input line.
   *
   * @param linePrefix - The input line up to the cursor.
   * @returns The matching candidates and the prefix they complete.
   */
  line_complete(linePrefix: string): Promise<CompletionResult>;

  /**
   * Reads one ChRIS file's raw bytes, resolved against the session's
   * working directory. When the engine provides it, the daemon exposes a
   * token-gated `/vfs` HTTP route so browser surfaces can render file
   * content natively (images in a panel) instead of through the terminal
   * stream.
   *
   * @param filePath - The file's path (absolute or cwd-relative).
   * @returns The file's bytes.
   */
  file_read?(filePath: string): Promise<Buffer>;

  /**
   * Opens one file's bytes as a stream. The seam behind `GET /vfs` when the
   * engine has it: a download is served as it arrives, with its length when
   * known, and never held whole in the daemon.
   *
   * @param filePath - The file's path (absolute or cwd-relative).
   * @returns The stream and its size when known.
   */
  file_stream?(filePath: string): Promise<{ stream: NodeJS.ReadableStream; size?: number }>;

  /**
   * Writes bytes to one ChRIS path. The seam behind `POST /vfs`, which is
   * how a surface with no reach into a filesystem (a browser) delivers a
   * file the operator picked.
   *
   * @param filePath - The destination path.
   * @param bytes - The content to write.
   */
  file_write?(filePath: string, bytes: Buffer): Promise<void>;

  /**
   * Notes a regard write relayed from a surface, retaining it as session
   * truth engine-side. Optional: a daemon still retains and rebroadcasts
   * regard on the wire without it.
   *
   * @param regard - The indicated address with its provenance.
   */
  regard_note?(regard: Regard): void;

  /**
   * Returns the engine's retained regard, or null before the first
   * indication.
   *
   * @returns The retained regard, or null.
   */
  regard_get?(): Regard | null;

  /**
   * Forgets what a surface left behind (its last answer), when it has gone.
   *
   * @param origin - The surface's id.
   */
  origin_forget?(origin: string): void;

  /**
   * Opens or closes a liveness watch on a subject for one owner. Optional:
   * a daemon whose engine lacks it refuses `watch` messages.
   *
   * @param subject - The subject address (`/proc/jobs/feed_N`).
   * @param owner - Who holds the watch (a surface id).
   * @param on - True to watch, false to release.
   * @returns The subject's watch state, or null when not watchable.
   */
  watch_set?(subject: string, owner: string, on: boolean): WatchState | null;

  /**
   * Releases every watch one owner holds (its surface detached).
   *
   * @param owner - The owner whose watches end.
   */
  watch_release?(owner: string): void;

  /**
   * Subscribes to events the engine originates on its own, which the daemon
   * relays to every surface off the scrollback.
   *
   * @param listener - Receives each ambient event.
   * @returns Function that unsubscribes.
   */
  ambient_listen?(listener: (event: AmbientEvent) => void): () => void;

  /**
   * Installs where the engine's output goes from now on: a daemon's sink
   * relays it to every attached surface, a terminal's writes it to stdout.
   *
   * @param sink - The sink.
   */
  sink_install?(sink: OutputSink): void;

  /**
   * Installs who the engine asks for what only a surface can give: a hidden
   * prompt, a local editor, a host shell, a delivered file.
   *
   * @param surface - The surface.
   */
  surface_install?(surface: Surface): void;
}
