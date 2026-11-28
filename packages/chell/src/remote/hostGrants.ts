/**
 * @file What each line this chell sent may have run here, and the spending of it.
 *
 * A daemon this chell is attached to asks it to run host commands, pipeline segments and editors. Each is run
 * only against a grant read from a line this chell sent on this connection (`lineHostOperations_read`), named by
 * the id this chell gave that line, while the line is in flight: a grant is spent before anything runs and the
 * rest retire with the line (its result, its error, a cancel from here, or the connection's close). A request with
 * no line, for a line not running here, or for something the line did not ask for runs nothing.
 *
 * Key components:
 * - HostGrantBook: the grants by line, opened, taken and retired.
 * - HostAsk: what a request asks to run.
 *
 * Typical usage:
 * ```ts
 * book.line_open(id, await lineHostOperations_read(line));
 * const refusal: string | null = book.grant_take(id, { kind: 'shell', command: 'ls -la' });
 * ```
 *
 * Dependencies: brasa's `LineHostOperations` (type only).
 *
 * @module
 */

import { posix } from 'node:path';

import type { LineHostOperations } from '@fnndsc/brasa';

/** A request to run a host command. */
interface ShellAsk {
  /** A host command. */
  kind: 'shell';
  /** The command, as asked. */
  command: string;
}

/** A request to run a pipeline segment or a delegated host line. */
interface PipeAsk {
  /** A pipeline segment. */
  kind: 'pipe';
  /** The segment, as asked. */
  command: string;
}

/** A request to open an editor on a file. */
interface EditAsk {
  /** An edit. */
  kind: 'edit';
  /** The file the daemon names, if any. */
  path: string | undefined;
}

/** What a daemon's request asks this machine to run. */
export type HostAsk = ShellAsk | PipeAsk | EditAsk;

/** One line's grants, as they are spent. */
interface LineGrants {
  /** Host commands not yet run. */
  shells: string[];
  /** Pipeline lines, in the engine's order. */
  pipes: readonly string[];
  /** How far the pipeline lines have been taken: a line before this one is spent or passed over. */
  pipeAt: number;
  /** Files to edit, by base name, not yet opened. */
  edits: string[];
}

/**
 * What a request asks, in words.
 *
 * @param ask - The request.
 * @returns The words.
 */
function ask_say(ask: HostAsk): string {
  if (ask.kind === 'shell') return `the host command ${JSON.stringify(ask.command)}`;
  if (ask.kind === 'pipe') return `the pipeline segment ${JSON.stringify(ask.command)}`;
  return `an editor on ${ask.path === undefined ? 'an unnamed file' : JSON.stringify(ask.path)}`;
}

/**
 * The grants of the lines this chell has in flight on one connection.
 *
 * @example
 * ```ts
 * const book: HostGrantBook = new HostGrantBook();
 * ```
 */
export class HostGrantBook {
  /** The grants by this chell's id for the line. */
  private readonly lines: Map<string, LineGrants> = new Map();

  /**
   * Opens a line's grants, before the line is sent.
   *
   * @param lineId - This chell's id for the line.
   * @param granted - What the line may ask for.
   *
   * @example
   * ```ts
   * book.line_open('3', { shells: ['ls -la'], pipes: [], edits: [] });
   * ```
   */
  public line_open(lineId: string, granted: LineHostOperations): void {
    this.lines.set(lineId, { shells: [...granted.shells], pipes: [...granted.pipes], pipeAt: 0, edits: [...granted.edits] });
  }

  /**
   * Retires a line's grants: its result or error came, or it was cancelled from here.
   *
   * @param lineId - This chell's id for the line.
   *
   * @example
   * ```ts
   * book.line_close('3');
   * ```
   */
  public line_close(lineId: string): void {
    this.lines.delete(lineId);
  }

  /**
   * Retires every line's grants: the connection closed.
   *
   * @example
   * ```ts
   * book.all_close();
   * ```
   */
  public all_close(): void {
    this.lines.clear();
  }

  /**
   * Spends the grant a request needs, or says why it runs nothing. Spent at once, before the caller runs anything,
   * so a second request for the same grant finds it gone.
   *
   * @param lineId - The line the daemon says is asking, by this chell's id; absent from an older daemon.
   * @param ask - What it asks to run.
   * @returns Null when granted (and spent), else the refusal.
   *
   * @example
   * ```ts
   * if (book.grant_take('3', { kind: 'shell', command: 'ls -la' }) === null) run();
   * ```
   */
  public grant_take(lineId: string | undefined, ask: HostAsk): string | null {
    const asked: string = `refused: the session asked this machine to run ${ask_say(ask)}`;
    if (lineId === undefined) {
      return `${asked} and did not say which line asked for it, so it cannot be told from a request no line made; nothing ran. The session's daemon is older than this chell: upgrade the daemon`;
    }
    const grants: LineGrants | undefined = this.lines.get(lineId);
    if (grants === undefined) return `${asked} for a line that is not running here; nothing ran`;
    return grant_spend(grants, ask) ? null : `${asked}, which the line sent from here did not ask for; nothing ran`;
  }
}

/**
 * Spends one grant of a line for a request, when it holds one.
 *
 * @param grants - The line's grants.
 * @param ask - The request.
 * @returns True when one was spent.
 */
function grant_spend(grants: LineGrants, ask: HostAsk): boolean {
  if (ask.kind === 'shell') {
    const at: number = grants.shells.indexOf(ask.command);
    if (at < 0) return false;
    grants.shells.splice(at, 1);
    return true;
  }
  if (ask.kind === 'pipe') {
    // In the engine's order: a segment it passed over (a builtin that did not delegate) cannot be asked for later.
    const at: number = grants.pipes.indexOf(ask.command, grants.pipeAt);
    if (at < 0) return false;
    grants.pipeAt = at + 1;
    return true;
  }
  if (ask.path === undefined) return false;
  const at: number = grants.edits.indexOf(posix.basename(ask.path));
  if (at < 0) return false;
  grants.edits.splice(at, 1);
  return true;
}
