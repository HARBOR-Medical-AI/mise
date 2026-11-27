/**
 * @file The attach token: generation, discovery file, and constant-time
 * comparison.
 *
 * The daemon's attach perimeter is the proven local-daemon model: a random
 * token generated at startup, required in every attach handshake, compared in
 * constant time. The token is printed and written to a user-readable file so
 * a same-user surface can discover it without it crossing an untrusted
 * channel. Remote access is an operator concern (an SSH tunnel or TLS proxy
 * in front, with the token still gating attach inside it).
 *
 * @module
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/**
 * Generates a fresh attach token: 256 bits of randomness, hex-encoded.
 *
 * @returns The token string.
 */
export function token_generate(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Writes the token to a file readable only by the current user (mode 0600),
 * for same-user discovery.
 *
 * @param token - The token to write.
 * @param path - The destination file path.
 */
export function token_writeFile(token: string, path: string): void {
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
}

/**
 * The environment variable a daemon hands its attach token to a surface it
 * starts in, and the surface reads it from. Never an argument: a command
 * line is world-readable on the host (`ps`), an environment is its
 * process's user's alone.
 */
export const ATTACH_TOKEN_ENV: string = 'CHELL_ATTACH_TOKEN';

/** How a token is written into lines a daemon prints. */
export interface TokenWords {
  /** For a line that states the token. */
  readonly token: string;
  /** For the end of a web address: `?token=…`, or nothing. */
  readonly query: string;
  /** For a command line: `--token …`. */
  readonly flag: string;
  /** What to add after a web address that was printed without its token; empty when it carries it. */
  readonly aside: string;
}

/**
 * The words a printed line uses for a token: the token itself where the
 * output is a terminal somebody is reading, and where it is kept, never the
 * token, where the output is anything else.
 *
 * A daemon's banner is the one place its operator reads the token off the
 * screen. The same lines sent to a file or a pipe (`> daemon.log`, a
 * service's journal) are a credential in a log. There the lines name the
 * berth's own record, which holds the token at mode 0600.
 *
 * @param token - The attach token.
 * @param terminal - Whether the output is a terminal.
 * @param kept - The path of the record that holds the token.
 * @returns The words.
 *
 * @example
 * ```ts
 * const words: TokenWords = tokenWords_say(token, process.stdout.isTTY === true, berth_path(identity));
 * console.log(`token: ${words.token}`);
 * ```
 */
export function tokenWords_say(token: string, terminal: boolean, kept: string): TokenWords {
  if (terminal) return { token, query: `?token=${token}`, flag: `--token ${token}`, aside: '' };
  return {
    token: `not printed, since this output is not a terminal; it is kept in ${kept}`,
    query: '',
    flag: `--token <the token kept in ${kept}>`,
    aside: ` (its token is kept in ${kept})`,
  };
}

/**
 * The lines that say how to attach to one berth.
 *
 * @param identity - The berth's identity.
 * @param url - Its wire address.
 * @param token - Its token.
 * @param terminal - Whether the lines go to a terminal.
 * @param kept - The record this berth was read from.
 * @returns The identity line, the ARGUS line and the attach line, uncoloured.
 */
export function berthLines_say(identity: string, url: string, token: string, terminal: boolean, kept: string): [string, string, string] {
  const words: TokenWords = tokenWords_say(token, terminal, kept);
  return [identity, `  ARGUS:   ${url.replace(/^ws/, 'http')}/${words.query}${words.aside}`, `  attach:  chell --remote --attach ${url} ${words.flag}`];
}

/**
 * Compares a provided token against the expected one in constant time, so a
 * mismatch reveals nothing through timing. Unequal lengths fail fast (and are
 * not themselves secret).
 *
 * @param expected - The daemon's token.
 * @param provided - The token a surface presented at attach.
 * @returns True when the tokens match exactly.
 */
export function token_matches(expected: string, provided: string): boolean {
  const expectedBytes: Buffer = Buffer.from(expected, 'utf-8');
  const providedBytes: Buffer = Buffer.from(provided, 'utf-8');
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}
