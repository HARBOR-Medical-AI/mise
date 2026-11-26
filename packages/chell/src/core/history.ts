/**
 * @file The shell's history: where it is kept, who may read it, and what a
 * line may not carry into it.
 *
 * A history is everything its operator typed. It is kept in one private
 * place of theirs, a file only they can read in a folder only they can
 * enter, and never in whatever folder the shell happened to be started in,
 * where it would be left behind in a checkout or a shared directory. A line
 * that carries a secret (a password or a token given as an option, a
 * password in a `user:password@host`, a token in an attach address) is
 * kept with the secret's place marked and the secret gone, in the file and
 * in the reader's own recall alike.
 *
 * @module
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The name a history had when it was written into the folder the shell started in. */
export const LEGACY_HISTORY_NAME: string = '.chell_history';

/** What stands where a secret was. */
export const REDACTED: string = '***';

/** A history file: its owner reads and writes it, nobody else anything. */
const HISTORY_FILE_MODE: number = 0o600;

/** A history's folder: its owner alone may enter it. */
const HISTORY_FOLDER_MODE: number = 0o700;

/** The permission bits of anybody but the owner. */
const OTHERS_MASK: number = 0o077;

/** Options whose value is a secret, wherever they appear on a line. */
const SECRET_OPTIONS: ReadonlyArray<string> = ['--password', '--adminPassword', '--token', '--auth-token'];

/** Commands on which `-p` is the password. */
const PASSWORD_LETTER_VERBS: ReadonlyArray<string> = ['connect', 'chell', 'calypso'];

/**
 * Where the history is kept.
 *
 * `$XDG_STATE_HOME/chell/history`, else `~/.local/state/chell/history`. A
 * history file the operator configured by an absolute path is theirs to
 * place and is kept there. The old default, a `.chell_history` relative to
 * wherever the shell was started, is not: such a file in a checkout is
 * neither read nor written nor removed.
 *
 * @param configured - The configured history file.
 * @param env - The environment.
 * @returns The absolute path of the history file.
 */
export function historyFile_resolve(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  if (configured !== LEGACY_HISTORY_NAME && path.isAbsolute(configured)) return configured;
  const state: string = env['XDG_STATE_HOME'] !== undefined && env['XDG_STATE_HOME'] !== '' ? env['XDG_STATE_HOME'] : path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'chell', 'history');
}

/**
 * One shell word's value, with a secret after it replaced: the value may be
 * bare, or in single or double quotes.
 */
const VALUE: string = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)`;

/**
 * A line as the history keeps it: every secret's place marked, the secret gone.
 *
 * - `--password x`, `--password=x`, `--password "x y"`, and the same for
 *   `--adminPassword`, `--token` and `--auth-token`;
 * - `-p x` on `connect`, `chell` and `calypso` (elsewhere `-p` is not a password);
 * - the password of `user:password@` in an address (`scheme://user:password@host`, `user:password@scheme://host`);
 * - the `token=` of an address.
 *
 * @param line - The line as typed.
 * @returns The line to keep.
 *
 * @example
 * ```ts
 * historyLine_redact('connect --user rudolph --password "my secret" https://cube/api/v1/'); // 'connect --user rudolph --password *** https://cube/api/v1/'
 * ```
 */
export function historyLine_redact(line: string): string {
  let kept: string = line;
  for (const option of SECRET_OPTIONS) {
    kept = kept.replace(new RegExp(String.raw`(^|\s)(${option})(=|\s+)${VALUE}`, 'g'), (_whole: string, lead: string, name: string, join: string): string => `${lead}${name}${join}${REDACTED}`);
  }
  const verb: string = (kept.trim().replace(/^!\s*/, '').split(/\s+/)[0] ?? '').split('/').pop() ?? '';
  if (PASSWORD_LETTER_VERBS.includes(verb)) {
    kept = kept.replace(new RegExp(String.raw`(\s)-p(=|\s+)${VALUE}`, 'g'), (_whole: string, lead: string, join: string): string => `${lead}-p${join}${REDACTED}`);
  }
  // user:password@ inside an address: after `scheme://`, or before one (`user:password@https://…`, as connect takes it).
  // A colon and an at sign elsewhere (`12:30@noon`) are not a password.
  kept = kept.replace(/(:\/\/[^\s:@/'"]+):([^\s@/'"]+)@/g, (_whole: string, user: string): string => `${user}:${REDACTED}@`);
  kept = kept.replace(/((?:^|[\s'"=])[^\s:@/'"]+):([^\s@/'"]+)@(?=[a-z][a-z0-9+.-]*:\/\/)/gi, (_whole: string, user: string): string => `${user}:${REDACTED}@`);
  kept = kept.replace(/([?&]token=)[^&\s'"]+/g, (_whole: string, lead: string): string => `${lead}${REDACTED}`);
  return kept;
}

/**
 * Makes the history file, when it is there, and its folder their owner's
 * alone if either is looser. A history written before it was private is
 * made so the next time a shell starts.
 *
 * @param file - The history file.
 */
export function history_tighten(file: string): void {
  try {
    const folder: string = path.dirname(file);
    if (fs.existsSync(folder) && (fs.statSync(folder).mode & OTHERS_MASK) !== 0) fs.chmodSync(folder, HISTORY_FOLDER_MODE);
    if (fs.existsSync(file) && (fs.statSync(file).mode & OTHERS_MASK) !== 0) fs.chmodSync(file, HISTORY_FILE_MODE);
  } catch {
    // A history that cannot be tightened is still not written looser by this shell.
  }
}

/**
 * Appends one line to the history, private from its first byte: the folder
 * is made at 0700 and the file at 0600.
 *
 * @param file - The history file.
 * @param line - The line, already redacted.
 */
export async function history_appendPrivate(file: string, line: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: HISTORY_FOLDER_MODE });
  await fs.promises.appendFile(file, `${line}\n`, { mode: HISTORY_FILE_MODE });
}
