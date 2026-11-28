/**
 * @file What a session asks this machine to run, checked and run here.
 *
 * A daemon this chell is attached to asks it to run host commands, pipeline segments and its editor, to write
 * files, and to hand its terminal to a program. Each runs here only against what the line this chell sent asked
 * for (its grants, `hostGrants.ts`; its deliveries, brasa's delivery reader), or with the person's word where no
 * grant covers it (`hostConsent.ts`). Whatever the grant or the word, the checks that keep this machine whole stay:
 * a request id is answered once, a file is written only to a place resolved here and once per line, the terminal
 * is handed over only when it is free, and everything a line may do ends with the line.
 *
 * Key components:
 * - HostDesk: the lines in flight, and the runners for each kind of request.
 *
 * Typical usage:
 * ```ts
 * desk.line_open(id, line, operations, intents);
 * void desk.shell_run(shellId, command, lineId);
 * ```
 *
 * Dependencies: brasa (delivery match), the grant book, the consent, the delivery placement, the pty relay.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { deliveryIntent_matches, deliverySource_matches, type DeliveredFile, type DeliveryIntent, type LineHostOperations } from '@fnndsc/brasa';
import type { FileDeliverRequest, FileDeliverResult } from '@fnndsc/menu';
import type { LocalEditResult } from '@fnndsc/menu/surface';
import chalk from 'chalk';

import { consentText_quote, type ConsentKind, type HostConsent } from './hostConsent.js';
import { HostGrantBook, type HostAsk } from './hostGrants.js';
import type { HostPtyRelay } from './hostPty.js';
import type { TerminalOwner } from './terminalOwner.js';
import { deliveryPlacement_resolve, type DeliveryPlacement, type PlacedDelivery } from '../core/deliveryPlace.js';

/**
 * What the desk runs requests with, and how it answers.
 *
 * @example
 * ```ts
 * const desk: HostDesk = new HostDesk({ message_send, consent, hostPty: null, owner, connection_fail, notice_show });
 * ```
 */
export interface HostDeskOptions {
  /** Sends a message to the daemon. */
  message_send: (message: Record<string, unknown>) => void;
  /** The person's word for what no grant covers. */
  consent: HostConsent;
  /** The relay that hands this terminal to a program on the daemon's pty, when this chell is in a terminal. */
  hostPty: HostPtyRelay | null;
  /** Who holds this chell's terminal: a question, a host command, the editor, a handed-over program, a prompt. */
  owner: TerminalOwner;
  /** Ends the connection: the session asked more than this chell will remember. */
  connection_fail: (reason: string) => void;
  /** Shows a note to the person, never over an open question. */
  notice_show: (text: string) => void;
  /** Runs a pipeline segment here. */
  segment_run?: (command: string, input: Buffer) => Promise<Buffer>;
  /** Runs a host command here. */
  shellCommand_run?: (command: string) => Promise<number>;
  /** Opens this machine's editor. */
  editor_open?: (content: string, extension: string | undefined) => Promise<LocalEditResult>;
  /** Writes a delivered file here. */
  file_deliver?: (request: FileDeliverRequest) => Promise<FileDeliverResult>;
}

/** Why a delivery was refused, and whether the person may be asked instead. */
interface DeliveryRefusal {
  /** The refusal. */
  reason: string;
  /** True when the only thing missing is the line's own word for it (it may be put to the person). */
  askable: boolean;
}

/**
 * The lines this chell has in flight on one connection, and the runners for what their session asks.
 *
 * @example
 * ```ts
 * const desk: HostDesk = new HostDesk({ message_send, consent, hostPty, owner, connection_fail, notice_show });
 * ```
 */
export class HostDesk {
  /** Each line's grants. */
  private readonly grants: HostGrantBook = new HostGrantBook();
  /** What each line asked to have delivered here, by its id. */
  private readonly intents: Map<string, DeliveryIntent[]> = new Map();
  /** The places each line has had written here. */
  private readonly written: Map<string, Set<string>> = new Map();
  /** The program each line's terminal is handed to. */
  private readonly ptyByLine: Map<string, string> = new Map();
  /** Request ids already answered on this connection, each by a fixed-size digest: each is answered once. */
  private readonly answered: Set<string> = new Set();
  /** Programs asked to be handed the terminal and not yet handed it (received, held, or awaiting an answer). */
  private readonly ptyPending: Set<string> = new Set();
  /** Of those, the ones that ended before they were handed it: never handed it. */
  private readonly ptyEnded: Set<string> = new Set();
  /** The hand-back of the terminal for each program it is handed to. */
  private readonly ptyRelease: Map<string, () => void> = new Map();

  /**
   * @param options - How requests are run and answered.
   */
  constructor(private readonly options: HostDeskOptions) {}

  /**
   * Opens a line, immediately before it is sent: its grants, its deliveries, and its text for its questions.
   *
   * @param lineId - This chell's id for the line.
   * @param text - The line as sent.
   * @param operations - What it may ask to have run here.
   * @param intents - What it asks to have delivered here.
   *
   * @example
   * ```ts
   * desk.line_open('3', '!ls', { shells: ['ls'], pipes: [], edits: [] }, []);
   * ```
   */
  public line_open(lineId: string, text: string, operations: LineHostOperations, intents: DeliveryIntent[]): void {
    this.grants.line_open(lineId, operations);
    this.intents.set(lineId, intents);
    this.options.consent.line_open(lineId, text);
  }

  /**
   * Retires everything a line may have done here, at once, and gives the terminal back if it was handed over;
   * without a line, every line's (the connection is closing).
   *
   * @param lineId - The line, or none for all.
   *
   * @example
   * ```ts
   * desk.line_retire('3');
   * ```
   */
  public line_retire(lineId?: string): void {
    const lines: string[] = lineId !== undefined ? [lineId] : [...new Set([...this.intents.keys(), ...this.ptyByLine.keys()])];
    if (lineId === undefined) {
      this.grants.all_close();
      this.options.consent.all_close();
      // No hand-over waits any more: one still in flight finds nothing pending and is refused.
      this.ptyPending.clear();
      this.ptyEnded.clear();
    }
    for (const one of lines) {
      this.intents.delete(one);
      this.written.delete(one);
      this.grants.line_close(one);
      this.options.consent.line_close(one);
      const ptyId: string | undefined = this.ptyByLine.get(one);
      this.ptyByLine.delete(one);
      if (ptyId !== undefined) {
        this.options.hostPty?.exit(ptyId);
        this.pty_end(ptyId);
      }
    }
  }

  /**
   * Runs a pipeline segment the session asked for, against the line's grant or the person's word.
   *
   * @param pipeId - The request's id.
   * @param command - The segment.
   * @param input - Its input, base64.
   * @param lineId - The line the session says asks.
   *
   * @example
   * ```ts
   * void desk.pipe_run('p1', 'tr a b', 'YWJj', '3');
   * ```
   */
  public async pipe_run(pipeId: string, command: string, input: string, lineId: string | undefined): Promise<void> {
    try {
      this.id_take('pipe', pipeId);
      const line: string = await this.host_allow(lineId, { kind: 'pipe', command }, 'pipe', `run the pipeline segment ${text_quote(command)} on this machine`);
      this.line_require(line);
      if (!this.options.segment_run) throw new Error('this surface cannot run pipeline segments');
      const output: Buffer = await this.options.segment_run(command, Buffer.from(input, 'base64'));
      this.options.message_send({ type: 'pipeResult', pipeId, output: output.toString('base64') });
    } catch (error: unknown) {
      this.options.message_send({ type: 'pipeError', pipeId, reason: reason_read(error) });
    }
  }

  /**
   * Runs a host command the session asked for, against the line's grant or the person's word.
   *
   * @param shellId - The request's id.
   * @param command - The command, without the `!`.
   * @param lineId - The line the session says asks.
   *
   * @example
   * ```ts
   * void desk.shell_run('s1', 'ls -la', '3');
   * ```
   */
  public async shell_run(shellId: string, command: string, lineId: string | undefined): Promise<void> {
    try {
      this.id_take('shell', shellId);
      const line: string = await this.host_allow(lineId, { kind: 'shell', command }, 'shell', `run the host command ${text_quote(command)} on this machine`);
      if (!this.options.shellCommand_run) throw new Error('this surface cannot run shell commands');
      const command_run: (command: string) => Promise<number> = this.options.shellCommand_run;
      // The command has the terminal to itself, after any question open on it; the line is rechecked once it has.
      const exitCode: number = await this.terminal_run('shell', line, (): Promise<number> => command_run(command));
      this.options.message_send({ type: 'shellResult', shellId, exitCode });
    } catch (error: unknown) {
      this.options.message_send({ type: 'shellError', shellId, reason: reason_read(error) });
    }
  }

  /**
   * Opens this machine's editor on the session's content for the file the line named, against the line's grant
   * or the person's word. The editor's suffix is read here from that name.
   *
   * @param editId - The request's id.
   * @param content - The content.
   * @param named - The file as the line typed it, as the session says.
   * @param lineId - The line the session says asks.
   *
   * @example
   * ```ts
   * void desk.edit_run('e1', 'text', 'notes.txt', '3');
   * ```
   */
  public async edit_run(editId: string, content: string, named: string | undefined, lineId: string | undefined): Promise<void> {
    try {
      this.id_take('edit', editId);
      // A request that names no file cannot be described, so it is not put to the person.
      if (named === undefined) throw new Error('refused: the session asked to open an editor here on a file it did not name; nothing ran');
      const line: string = await this.host_allow(lineId, { kind: 'edit', named }, 'edit', `open this machine's editor on ${text_quote(named)}`);
      if (!this.options.editor_open) throw new Error('this surface cannot edit');
      const editor_run: (content: string, extension: string | undefined) => Promise<LocalEditResult> = this.options.editor_open;
      const result: LocalEditResult = await this.terminal_run('edit', line, (): Promise<LocalEditResult> => editor_run(content, editSuffix_read(named)));
      this.options.message_send({ type: 'editResult', editId, content: result.content, changed: result.changed });
    } catch (error: unknown) {
      this.options.message_send({ type: 'editError', editId, reason: reason_read(error) });
    }
  }

  /**
   * Writes a delivered file here: against what the line asked to have delivered, or the person's word; always to a
   * place resolved here, reserved before anything is fetched, once per line.
   *
   * @param deliverId - The request's id.
   * @param lineId - The line the session says asks.
   * @param request - What to deliver and where.
   *
   * @example
   * ```ts
   * void desk.deliver_run('d1', '3', { path: '/home/me/a.txt', filename: 'a.txt', destination: './out' });
   * ```
   */
  public async deliver_run(deliverId: string, lineId: string | undefined, request: FileDeliverRequest): Promise<void> {
    try {
      this.id_take('deliver', deliverId);
      if (!this.options.file_deliver) throw new Error('this surface cannot receive a file');
      // Placed here, or refused, before anything else: a name with no place inside its folder never runs.
      const placement: DeliveryPlacement = deliveryPlacement_resolve(request.destination, request.filename);
      const place: string = placement.place;
      const refused: DeliveryRefusal | null = this.delivery_check(lineId, request);
      // `l` for a delivery covers one folder here and files from inside one source; a file not inside the source it
      // names is offered for this once only.
      const scope: string | null = deliveryScope_read(placement, request);
      const line: string | undefined = refused === null
        ? lineId
        : await this.consent_require(lineId, refused.reason, refused.askable, 'deliver', `write the file ${text_quote(request.filename)} from the session's ${text_quote(request.path)} (its source ${text_quote(request.source ?? 'not named')}${scope === null ? ', which it is not inside' : ''}) to ${text_quote(place)} on this machine`, scope ?? undefined, scope === null);
      if (line === undefined) throw new Error(refused?.reason ?? 'refused: no line');
      this.line_require(line);
      this.place_reserve(line, place, request.filename);
      const placed: PlacedDelivery = { ...request, place };
      const result: FileDeliverResult = await this.options.file_deliver(placed);
      this.options.message_send({ type: 'deliverResult', deliverId, location: result.location, bytes: result.bytes });
    } catch (error: unknown) {
      this.options.message_send({ type: 'deliverError', deliverId, reason: reason_read(error) });
    }
  }

  /**
   * Hands this terminal to the program the session runs on its own pty for a line: against the line's `!` grant
   * or the person's word, and only when there is a terminal and nothing else holds it; else the session is told no
   * and stops the program, and the terminal stays this chell's.
   *
   * @param ptyId - The program's id.
   * @param lineId - The line the session says asks.
   * @param command - The program's command.
   *
   * @example
   * ```ts
   * void desk.hostPty_start('p1', '3', 'nvim notes.txt');
   * ```
   */
  public async hostPty_start(ptyId: string, lineId: string | undefined, command: string | undefined): Promise<void> {
    try {
      this.id_take('pty', ptyId);
      if (this.ptyEnded.delete(ptyId)) throw new Error('refused: the program ended before it was handed the terminal; nothing was handed over');
      if (this.options.hostPty === null) throw new Error('refused: this chell has no terminal to hand over; nothing was handed over');
      if (command === undefined) throw new Error('refused: the session asked to hand this terminal to a program it did not name; nothing was handed over');
      // Granted, the terminal is handed over at once (the program's first output follows straight after);
      // only a request no grant covers waits for the person.
      const refusal: string | null = this.grants.grant_take(lineId, { kind: 'shell', command });
      this.ptyPending.add(ptyId);
      const line: string | undefined = refusal === null
        ? lineId
        : await this.consent_require(lineId, refusal, this.line_effective(lineId) !== undefined, 'pty', `hand this terminal to the program ${text_quote(command)}, which runs on the session's machine and receives every key typed here until it ends`);
      if (line === undefined) throw new Error(refusal ?? 'refused: no line');
      // A program that ended while its hand-over waited is not handed the terminal.
      if (this.ptyEnded.delete(ptyId) || !this.ptyPending.delete(ptyId)) throw new Error('refused: the program ended before it was handed the terminal; nothing was handed over');
      // The terminal is handed over only when it is free (after any question or command holding it), and stays the
      // program's until it ends or its line does.
      const terminal_release: (() => void) | null = this.options.owner.terminal_tryTake('pty');
      if (terminal_release === null) throw new Error('refused: this terminal is held (a question, a command or another program has it); nothing was handed over');
      if (!this.grants.line_has(line)) {
        terminal_release();
        throw new Error('refused: the line has ended; nothing was handed over');
      }
      this.ptyRelease.set(ptyId, terminal_release);
      this.ptyByLine.set(line, ptyId);
      this.options.hostPty.start(ptyId);
    } catch (error: unknown) {
      const reason: string = reason_read(error);
      this.ptyPending.delete(ptyId);
      this.options.notice_show(chalk.red(`[!] ${reason}`));
      this.options.message_send({ type: 'hostPtyRefuse', ptyId, reason });
    } finally {
      this.ptyEnded.delete(ptyId);
    }
  }

  /**
   * Refuses a request id already answered on this connection.
   *
   * @param kind - The request's kind.
   * @param id - Its id.
   * @throws {Error} When it was answered before.
   */
  private id_take(kind: string, id: string): void {
    // A digest, so what is remembered is bounded by count alone, whatever length an id the session sends.
    const key: string = createHash('sha256').update(`${kind}:${id}`).digest('base64');
    if (this.answered.has(key)) throw new Error(`refused: the session sent request ${text_quote(id)} again; nothing ran`);
    // Remembered for the connection, and bounded: a session that asks more than this is not served further.
    if (this.answered.size >= ANSWERED_MAX) {
      this.options.connection_fail(`the session sent more than ${String(ANSWERED_MAX)} requests on one connection`);
      throw new Error('refused: the session has asked more than this chell answers on one connection; reconnect');
    }
    this.answered.add(key);
  }

  /**
   * A program the session asks to hand the terminal to has been received (perhaps held behind a question): its end,
   * if it comes first, cancels the hand-over.
   *
   * @param ptyId - The program's id.
   *
   * @example
   * ```ts
   * desk.pty_announce('p1');
   * ```
   */
  public pty_announce(ptyId: string): void {
    this.ptyPending.add(ptyId);
  }

  /**
   * A received hand-over that will not be processed (refused at the hold's bound): forgotten.
   *
   * @param ptyId - The program's id.
   *
   * @example
   * ```ts
   * desk.pty_forget('p1');
   * ```
   */
  public pty_forget(ptyId: string): void {
    this.ptyPending.delete(ptyId);
    this.ptyEnded.delete(ptyId);
  }

  /**
   * The terminal is free again: the program it was handed to has ended.
   *
   * @param ptyId - The program's id.
   *
   * @example
   * ```ts
   * desk.pty_end('p1');
   * ```
   */
  public pty_end(ptyId: string): void {
    // Received and not yet handed over: it never will be.
    if (this.ptyPending.delete(ptyId)) this.ptyEnded.add(ptyId);
    this.ptyRelease.get(ptyId)?.();
    this.ptyRelease.delete(ptyId);
  }

  /**
   * The line a request is bound to: the one it names when that is running here, else (a request that names none,
   * from an older daemon) the sole line running, else none.
   *
   * @param lineId - The line the session names.
   * @returns The running line, or undefined.
   */
  private line_effective(lineId: string | undefined): string | undefined {
    if (lineId !== undefined) return this.grants.line_has(lineId) ? lineId : undefined;
    return this.grants.lines_count() === 1 ? this.grants.line_sole() : undefined;
  }

  /**
   * Refuses to go on when a request's line has ended (checked immediately before anything runs).
   *
   * @param line - The line.
   * @throws {Error} When it is no longer running.
   */
  private line_require(line: string): void {
    if (!this.grants.line_has(line)) throw new Error('refused: the line that asked has ended; nothing ran');
  }

  /**
   * Runs something that needs the terminal: after whoever holds it, with the line rechecked once it is had.
   *
   * @param who - What runs.
   * @param line - Its line.
   * @param run - The run.
   * @returns What the run gives.
   */
  private async terminal_run<T>(who: 'shell' | 'edit', line: string, run: () => Promise<T>): Promise<T> {
    const terminal_release: () => void = await this.options.owner.terminal_take(who);
    try {
      this.line_require(line);
      return await run();
    } finally {
      terminal_release();
    }
  }

  /**
   * Allows a host request by the line's grant (spent at once) or, where only the grant is missing, by the
   * person's word.
   *
   * @param lineId - The line the session says asks.
   * @param ask - The request, for the grant.
   * @param kind - Its kind, for the question.
   * @param action - What would happen, in words.
   * @returns The running line it is bound to.
   * @throws {Error} When neither allows it.
   */
  private async host_allow(lineId: string | undefined, ask: HostAsk, kind: ConsentKind, action: string): Promise<string> {
    const refusal: string | null = this.grants.grant_take(lineId, ask);
    if (refusal === null && lineId !== undefined) return lineId;
    return await this.consent_require(lineId, refusal ?? 'refused', this.line_effective(lineId) !== undefined, kind, action);
  }

  /**
   * Puts a request to the person where it may be put, and refuses it unless they allow it.
   *
   * @param lineId - The line the session says asks.
   * @param refusal - Why it is refused without their word.
   * @param askable - Whether it may be put to them at all (a line of this chell is pending, or a legacy request with one).
   * @param kind - Its kind.
   * @param action - What would happen, in words.
   * @param scope - What `l` for it covers besides its kind (a delivery's folder here and source).
   * @param onceOnly - Only `y` is offered (what `l` would cover cannot be bound).
   * @returns The running line it is bound to.
   * @throws {Error} With the refusal, when not allowed.
   */
  private async consent_require(lineId: string | undefined, refusal: string, askable: boolean, kind: ConsentKind, action: string, scope?: string, onceOnly?: boolean): Promise<string> {
    const line: string | undefined = this.line_effective(lineId);
    if (!askable || line === undefined) throw new Error(refusal);
    const verified: boolean = lineId !== undefined;
    const allowed: boolean = await this.options.consent.request_decide({ lineId: line, verified, kind, action, ...(scope !== undefined ? { scope } : {}), ...(onceOnly === true ? { onceOnly } : {}) });
    // Rechecked after the answer: a line that ended meanwhile asks for nothing.
    if (!allowed || !this.grants.line_has(line)) throw new Error(refusal);
    return line;
  }

  /**
   * Why a delivery is not what its line asked for, and whether the person may be asked instead.
   *
   * @param lineId - The line the session says asks.
   * @param request - The delivery.
   * @returns Null when the line asked for it; else the refusal.
   */
  private delivery_check(lineId: string | undefined, request: FileDeliverRequest): DeliveryRefusal | null {
    const where: string = request.destination !== undefined && request.destination.length > 0 ? JSON.stringify(request.destination) : 'the working directory';
    const asked: string = `the session asked to write ${JSON.stringify(request.filename)} to ${where}`;
    if (lineId === undefined) {
      return { reason: `refused: ${asked} and did not say which line asked for it, so it cannot be told from a delivery that is late or was never asked for; nothing was written. The session's daemon is older than this chell: upgrade the daemon`, askable: this.line_effective(undefined) !== undefined };
    }
    const intents: DeliveryIntent[] | undefined = this.intents.get(lineId);
    if (intents === undefined) return { reason: `refused: ${asked} for a line that is not running here; nothing was written`, askable: false };
    if (intents.length === 0) return { reason: `refused: ${asked}, and the line sent from here asks for no file; nothing was written`, askable: true };
    const bound: DeliveryIntent[] = intents.filter((intent: DeliveryIntent): boolean => deliveryIntent_matches([intent], request.destination));
    if (bound.length === 0) {
      const unbound: DeliveryIntent | undefined = intents.find((intent: DeliveryIntent): boolean => intent.unbound !== undefined);
      if (unbound !== undefined) return { reason: `refused: ${asked}, and the line sent from here cannot say where: ${unbound.unbound ?? ''}; nothing was written`, askable: true };
      const named: string = intents.map((intent: DeliveryIntent): string => (intent.destination === null ? 'the working directory' : JSON.stringify(intent.destination))).join(', ');
      return { reason: `refused: ${asked}, and the line sent from here named ${named}; nothing was written`, askable: true };
    }
    const file: DeliveredFile = { path: request.path, filename: request.filename, source: request.source };
    if (bound.some((intent: DeliveryIntent): boolean => intent.sources === undefined || deliverySource_matches(intent.sources, file))) return null;
    return { reason: `refused: ${asked}, from ${JSON.stringify(request.path)}, which no source the line sent from here names; nothing was written`, askable: true };
  }

  /**
   * Reserves a place on this machine for one line's file: once per line, whatever allowed it.
   *
   * @param lineId - The line.
   * @param place - The place, resolved here.
   * @param filename - The file's name, for the words.
   * @throws {Error} When the line has written that place already.
   */
  private place_reserve(lineId: string, place: string, filename: string): void {
    const key: string = lineId;
    const written: Set<string> = this.written.get(key) ?? new Set<string>();
    if (written.has(place)) throw new Error(`refused: the session asked to write ${JSON.stringify(filename)} to ${JSON.stringify(place)}, which this line has written already; nothing was written`);
    written.add(place);
    this.written.set(key, written);
  }
}

/**
 * Untrusted text quoted for a question or a refusal, every control and direction character made visible.
 *
 * @param text - The text.
 * @returns It, quoted.
 */
function text_quote(text: string): string {
  return consentText_quote(text);
}

/** The most request ids one connection is answered for. */
const ANSWERED_MAX: number = 100_000;

/**
 * The words of what was thrown.
 *
 * @param error - What was thrown.
 * @returns Its message.
 */
function reason_read(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The suffix the local editor's copy is given: the operand's own extension, read here, never the session's word.
 *
 * @param named - The file as the line typed it.
 * @returns Its extension, or `.txt`.
 */
function editSuffix_read(named: string | undefined): string {
  const base: string = named === undefined ? '' : (named.split('/').pop() ?? '');
  const dot: number = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '.txt';
}

/**
 * What `l` for a delivery covers: where it goes here (a file the destination names, by its exact path; else the
 * folder files are placed in by name) and the source it comes from, when the file is that source or is at its name
 * inside it (as brasa shapes it); else null (it is offered once only).
 *
 * @param placement - Where it goes, resolved here.
 * @param request - The delivery.
 * @returns The scope, or null.
 */
function deliveryScope_read(placement: DeliveryPlacement, request: FileDeliverRequest): string | null {
  if (request.source === undefined || request.source.length === 0) return null;
  const parts: string[] = request.filename.split('/');
  if (request.filename.length === 0 || parts.some((part: string): boolean => part === '' || part === '.' || part === '..')) return null;
  const normalised: string = path.posix.normalize(request.source);
  const root: string = normalised === '/' ? '/' : normalised.replace(/\/+$/, '');
  const from: string = path.posix.normalize(request.path);
  const inside: boolean = (from === root && path.posix.basename(root) === request.filename) || from === `${root === '/' ? '' : root}/${request.filename}`;
  if (!inside) return null;
  const here: string = placement.folder === null ? `file\u0000${placement.place}` : `folder\u0000${placement.folder}`;
  return `${here}\u0000${root}`;
}
