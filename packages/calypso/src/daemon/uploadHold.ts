/**
 * @file How many bytes of uploads a daemon holds at once.
 *
 * A posted file is held in memory until the store has it. One request is
 * capped, but any number may arrive together, so the daemon keeps a count
 * of the bytes it holds for uploads in flight and refuses one that would
 * take the count past a ceiling. The refusal says to come back: nothing
 * was wrong with the file.
 *
 * A request that states its length reserves that many bytes before one is
 * read and is filled in place, so it is held once. A request that states
 * none is gathered in pieces and joined, which holds it twice for a
 * moment, and is counted twice for that reason.
 *
 * @module
 */
import type { IncomingMessage } from 'node:http';

/** The ceiling when none is set: bytes of uploads held at once. */
export const UPLOAD_HELD_DEFAULT: number = 512 * 1024 * 1024;

/** How long a refused upload is told to wait, in seconds. */
export const UPLOAD_RETRY_SECONDS: number = 5;

/**
 * Reads the ceiling from the environment (`CALYPSO_UPLOAD_HELD`, bytes).
 *
 * @param env - The environment.
 * @returns The ceiling; the default when the variable is unset or is not a positive whole number.
 */
export function uploadCeiling_read(env: NodeJS.ProcessEnv): number {
  const text: string | undefined = env['CALYPSO_UPLOAD_HELD'];
  if (text === undefined || !/^[0-9]+$/.test(text)) return UPLOAD_HELD_DEFAULT;
  const ceiling: number = Number(text);
  return Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : UPLOAD_HELD_DEFAULT;
}

/** The count of bytes held for uploads in flight, under a ceiling. */
export class UploadHold {
  private heldNow: number = 0;

  /**
   * @param ceiling - The most bytes held at once.
   */
  constructor(public readonly ceiling: number) {}

  /** The bytes held now. */
  get held(): number {
    return this.heldNow;
  }

  /**
   * Reserves bytes, when they fit under the ceiling.
   *
   * @param bytes - How many.
   * @returns Whether they were reserved.
   */
  reserve(bytes: number): boolean {
    if (this.heldNow + bytes > this.ceiling) return false;
    this.heldNow += bytes;
    return true;
  }

  /**
   * Gives bytes back.
   *
   * @param bytes - How many.
   */
  release(bytes: number): void {
    this.heldNow = Math.max(0, this.heldNow - bytes);
  }
}

/** An upload's body, held, with the way to give its bytes back. */
export interface UploadTaken {
  /** The body, whole. */
  readonly bytes: Buffer;
  /** Gives the reservation back. Safe to call more than once; it releases once. */
  readonly release: () => void;
}

/** Why an upload's body was not taken. */
export interface UploadRefusal {
  /** The HTTP status to answer with. */
  readonly status: number;
  /** The line to answer with. */
  readonly message: string;
  /** Seconds after which the same upload may be tried again, when the refusal is for room. */
  readonly retryAfter?: number;
}

/**
 * Reads the length a request states.
 *
 * @param request - The request.
 * @returns The length; null when none is stated; a refusal when what is stated is no length.
 */
function lengthStated_read(request: IncomingMessage): number | null | UploadRefusal {
  const header: string | undefined = request.headers['content-length'];
  if (header === undefined) return null;
  if (!/^[0-9]+$/.test(header)) return { status: 400, message: 'the stated length is not a length' };
  const length: number = Number(header);
  return Number.isSafeInteger(length) ? length : { status: 400, message: 'the stated length is not a length' };
}

/**
 * Takes one upload's body under the ceiling.
 *
 * Nothing is allocated before the stated length has been checked against
 * the request's own limit and reserved. A body longer or shorter than it
 * stated is refused. Whatever was reserved for a body that is refused, or
 * whose reading fails, is given back before this returns; a body that is
 * taken keeps its reservation until the caller calls `release`.
 *
 * @param request - The request whose body is the file.
 * @param hold - The daemon's count of bytes held.
 * @param limit - The most bytes one request may carry.
 * @returns The body and its release, or why it was not taken.
 */
export async function upload_take(request: IncomingMessage, hold: UploadHold, limit: number): Promise<UploadTaken | { refusal: UploadRefusal }> {
  const tooLarge: UploadRefusal = { status: 413, message: `file too large: this route takes at most ${limit} bytes` };
  const noRoom: UploadRefusal = { status: 503, message: `the session is holding as many uploaded bytes as it may (${hold.ceiling}): try again shortly`, retryAfter: UPLOAD_RETRY_SECONDS };
  const stated: number | null | UploadRefusal = lengthStated_read(request);
  if (stated !== null && typeof stated !== 'number') return { refusal: stated };
  if (stated !== null && stated > limit) return { refusal: tooLarge };

  let reserved: number = 0;
  const give = (): void => { hold.release(reserved); reserved = 0; };
  if (stated !== null) {
    if (!hold.reserve(stated)) return { refusal: noRoom };
    reserved = stated;
  }
  const whole: Buffer | null = stated !== null ? Buffer.allocUnsafe(stated) : null;
  const pieces: Buffer[] = [];
  let received: number = 0;
  let refusal: UploadRefusal | null = null;
  try {
    for await (const chunk of request) {
      const part: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (whole !== null) {
        if (received + part.length > whole.length) { refusal = { status: 400, message: 'the body is longer than its stated length' }; break; }
        part.copy(whole, received);
      } else {
        if (received + part.length > limit) { refusal = tooLarge; break; }
        // Held twice while it is joined: once in its pieces, once in the whole.
        if (!hold.reserve(2 * part.length)) { refusal = noRoom; break; }
        reserved += 2 * part.length;
        pieces.push(part);
      }
      received += part.length;
    }
  } catch {
    refusal = { status: 400, message: 'could not read the request body' };
  }
  if (refusal === null && whole !== null && received !== whole.length) {
    refusal = { status: 400, message: 'the body is shorter than its stated length' };
  }
  if (refusal !== null) {
    give();
    return { refusal };
  }
  return { bytes: whole ?? Buffer.concat(pieces, received), release: give };
}
