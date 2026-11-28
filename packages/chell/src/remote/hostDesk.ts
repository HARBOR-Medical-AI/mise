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

import { deliveryIntent_matches, deliverySource_matches, type DeliveredFile, type DeliveryIntent, type LineHostOperations } from '@fnndsc/brasa';
import type { FileDeliverRequest, FileDeliverResult } from '@fnndsc/menu';
import type { LocalEditResult } from '@fnndsc/menu/surface';
import chalk from 'chalk';

import { consentText_escape, type ConsentKind, type HostConsent } from './hostConsent.js';
import { HostGrantBook, type HostAsk } from './hostGrants.js';
import type { HostPtyRelay } from './hostPty.js';
import { deliveryPlace_resolve, type PlacedDelivery } from '../core/deliveryPlace.js';

/**
 * What the desk runs requests with, and how it answers.
 *
 * @example
 * ```ts
 * const desk: HostDesk = new HostDesk({ message_send, consent, hostPty: null, terminal_isBusy: () => false });
 * ```
 */
export interface HostDeskOptions {
  /** Sends a message to the daemon. */
  message_send: (message: Record<string, unknown>) => void;
  /** The person's word for what no grant covers. */
  consent: HostConsent;
  /** The relay that hands this terminal to a program on the daemon's pty, when this chell is in a terminal. */
  hostPty: HostPtyRelay | null;
  /** Whether another reader holds the terminal (a daemon's question is open): then nothing is put to the person. */
  terminal_isBusy: () => boolean;
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
 * const desk: HostDesk = new HostDesk({ message_send, consent, hostPty, terminal_isBusy: () => false });
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
  /** Request ids already answered on this connection: each is answered once. */
  private readonly answered: Set<string> = new Set();

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
    }
    for (const one of lines) {
      this.intents.delete(one);
      this.written.delete(one);
      this.grants.line_close(one);
      this.options.consent.line_close(one);
      const ptyId: string | undefined = this.ptyByLine.get(one);
      this.ptyByLine.delete(one);
      if (ptyId !== undefined) this.options.hostPty?.exit(ptyId);
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
      await this.host_allow(lineId, { kind: 'pipe', command }, 'pipe', `run the pipeline segment ${text_quote(command)} on this machine`);
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
      await this.host_allow(lineId, { kind: 'shell', command }, 'shell', `run the host command ${text_quote(command)} on this machine`);
      if (!this.options.shellCommand_run) throw new Error('this surface cannot run shell commands');
      const exitCode: number = await this.options.shellCommand_run(command);
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
      await this.host_allow(lineId, { kind: 'edit', named }, 'edit', `open this machine's editor on ${named === undefined ? 'an unnamed file' : text_quote(named)}`);
      if (!this.options.editor_open) throw new Error('this surface cannot edit');
      const result: LocalEditResult = await this.options.editor_open(content, editSuffix_read(named));
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
      const place: string = deliveryPlace_resolve(request.destination, request.filename);
      const refused: DeliveryRefusal | null = this.delivery_check(lineId, request);
      if (refused !== null) await this.consent_require(lineId, refused.reason, refused.askable, 'deliver', `write the file ${text_quote(request.filename)} from the session's ${text_quote(request.path)} to ${text_quote(place)} on this machine`);
      this.place_reserve(lineId, place, request.filename);
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
      if (this.options.hostPty === null) throw new Error('refused: this chell has no terminal to hand over; nothing was handed over');
      if (command === undefined) throw new Error('refused: the session asked to hand this terminal to a program it did not name; nothing was handed over');
      // Granted, the terminal is handed over at once (the program's first output follows straight after);
      // only a request no grant covers waits for the person.
      const refusal: string | null = this.grants.grant_take(lineId, { kind: 'shell', command });
      if (refusal !== null) {
        const askable: boolean = lineId !== undefined ? this.grants.line_has(lineId) : this.grants.lines_count() === 1;
        await this.consent_require(lineId, refusal, askable, 'pty', `hand this terminal to the program ${text_quote(command)}, which runs on the session's machine and receives every key typed here until it ends`);
      }
      if (lineId === undefined || !this.intents.has(lineId)) throw new Error('refused: the line has ended; nothing was handed over');
      this.ptyByLine.set(lineId, ptyId);
      this.options.hostPty.start(ptyId);
    } catch (error: unknown) {
      const reason: string = reason_read(error);
      console.error(chalk.red(`[!] ${reason}`));
      this.options.message_send({ type: 'hostPtyRefuse', ptyId, reason });
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
    const key: string = `${kind}:${id}`;
    if (this.answered.has(key)) throw new Error(`refused: the session sent request ${text_quote(id)} again; nothing ran`);
    this.answered.add(key);
  }

  /**
   * Allows a host request by the line's grant (spent at once) or, where only the grant is missing, by the
   * person's word.
   *
   * @param lineId - The line the session says asks.
   * @param ask - The request, for the grant.
   * @param kind - Its kind, for the question.
   * @param action - What would happen, in words.
   * @throws {Error} When neither allows it.
   */
  private async host_allow(lineId: string | undefined, ask: HostAsk, kind: ConsentKind, action: string): Promise<void> {
    const refusal: string | null = this.grants.grant_take(lineId, ask);
    if (refusal === null) return;
    const askable: boolean = lineId !== undefined ? this.grants.line_has(lineId) : this.grants.lines_count() === 1;
    await this.consent_require(lineId, refusal, askable, kind, action);
  }

  /**
   * Puts a request to the person where it may be put, and refuses it unless they allow it.
   *
   * @param lineId - The line the session says asks.
   * @param refusal - Why it is refused without their word.
   * @param askable - Whether it may be put to them at all (a line of this chell is pending, or a legacy request with one).
   * @param kind - Its kind.
   * @param action - What would happen, in words.
   * @throws {Error} With the refusal, when not allowed.
   */
  private async consent_require(lineId: string | undefined, refusal: string, askable: boolean, kind: ConsentKind, action: string): Promise<void> {
    if (!askable || this.options.terminal_isBusy()) throw new Error(refusal);
    const verified: boolean = lineId !== undefined && this.grants.line_has(lineId);
    const allowed: boolean = await this.options.consent.request_decide({ lineId, verified, kind, action });
    // Rechecked after the answer: a line that ended meanwhile asks for nothing.
    if (!allowed || (verified && !this.grants.line_has(lineId ?? ''))) throw new Error(refusal);
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
      return { reason: `refused: ${asked} and did not say which line asked for it, so it cannot be told from a delivery that is late or was never asked for; nothing was written. The session's daemon is older than this chell: upgrade the daemon`, askable: this.grants.lines_count() === 1 };
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
  private place_reserve(lineId: string | undefined, place: string, filename: string): void {
    const key: string = lineId ?? '';
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
  return JSON.stringify(consentText_escape(text));
}

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
