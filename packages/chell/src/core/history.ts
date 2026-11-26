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
 * in the reader's own recall alike; a line too broken to read word by word
 * that mentions a secret is not kept at all.
 *
 * Privacy is established before a byte is written: the file is opened,
 * looked at, and written through that same open file only when it is a
 * regular file of this user's that nobody else can read. When that cannot
 * be had, nothing is written.
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

/** Commands on which `-p` is the password, and a bare `user:password@host` an identity. */
const PASSWORD_VERBS: ReadonlyArray<string> = ['connect', 'chell', 'calypso'];

/** Where a history is kept, and whether its folder is the shell's own to keep private. */
export interface HistoryPlace {
  /** The history file. */
  readonly file: string;
  /** True for the shell's own state folder; false for a file the operator placed, whose folder is theirs. */
  readonly ownFolder: boolean;
}

/**
 * Where the history is kept.
 *
 * `$XDG_STATE_HOME/chell/history` when that variable is an absolute path,
 * else `~/.local/state/chell/history`. A relative `XDG_STATE_HOME` is not
 * a place of the operator's own: it would put the history in whatever
 * folder the shell was started in, so it is passed over. A history file
 * the operator configured by an absolute path is theirs to place and is
 * kept there. The old default, a `.chell_history` relative to wherever
 * the shell was started, is not: such a file in a checkout is neither
 * read nor written nor removed.
 *
 * @param configured - The configured history file.
 * @param env - The environment.
 * @returns The history file and whose its folder is.
 */
export function historyFile_resolve(configured: string, env: NodeJS.ProcessEnv = process.env): HistoryPlace {
  if (configured !== LEGACY_HISTORY_NAME && path.isAbsolute(configured)) return { file: configured, ownFolder: false };
  const given: string | undefined = env['XDG_STATE_HOME'];
  const state: string = given !== undefined && path.isAbsolute(given) ? given : path.join(os.homedir(), '.local', 'state');
  return { file: path.join(state, 'chell', 'history'), ownFolder: true };
}

/** One piece of a line: a word, or an operator that ends a command. */
interface LinePiece {
  /** `word`, or `op` for `;`, `|`, `||`, `&&`, `&`. */
  readonly kind: 'word' | 'op';
  /** Where it starts in the line. */
  readonly start: number;
  /** One past where it ends. */
  readonly end: number;
  /** The word with its quoting and escapes read, as the shell would hand it on. */
  readonly value: string;
}

/**
 * Reads a line into shell words: quotes (single, and double with its
 * escapes), a backslash before any character outside quotes, quoted
 * pieces joined to what touches them (`'it''s'`, `a\ b`), and the
 * operators that end a command.
 *
 * @param line - The line as typed.
 * @returns The pieces in order, or null when a quote is left open.
 */
function line_scan(line: string): LinePiece[] | null {
  const pieces: LinePiece[] = [];
  let at: number = 0;
  while (at < line.length) {
    const char: string = line[at] as string;
    if (/\s/.test(char)) { at++; continue; }
    const two: string = line.slice(at, at + 2);
    if (two === '&&' || two === '||') { pieces.push({ kind: 'op', start: at, end: at + 2, value: two }); at += 2; continue; }
    if (char === ';' || char === '|' || char === '&') { pieces.push({ kind: 'op', start: at, end: at + 1, value: char }); at++; continue; }
    const start: number = at;
    let value: string = '';
    while (at < line.length) {
      const here: string = line[at] as string;
      if (/\s/.test(here) || here === ';' || here === '|' || here === '&') break;
      if (here === '\\') {
        if (at + 1 >= line.length) { at++; break; }
        value += line[at + 1];
        at += 2;
      } else if (here === "'") {
        const close: number = line.indexOf("'", at + 1);
        if (close === -1) return null;
        value += line.slice(at + 1, close);
        at = close + 1;
      } else if (here === '"') {
        let inner: number = at + 1;
        let closed: boolean = false;
        while (inner < line.length) {
          const quoted: string = line[inner] as string;
          if (quoted === '\\' && inner + 1 < line.length) { value += line[inner + 1]; inner += 2; continue; }
          if (quoted === '"') { closed = true; break; }
          value += quoted;
          inner++;
        }
        if (!closed) return null;
        at = inner + 1;
      } else {
        value += here;
        at++;
      }
    }
    pieces.push({ kind: 'word', start, end: at, value });
  }
  return pieces;
}

/** Whether a line that cannot be read word by word still shows the mark of a secret. */
const SECRET_MARK: RegExp = /--password|--adminPassword|--token|--auth-token|(^|\s)-p(\s|=|$)|:[^\s@/]+@|[?&]token=/;

/** `scheme://user:password@…` at the start of a word. */
const SCHEME_FIRST: RegExp = /^([a-z][a-z0-9+.-]*:\/\/[^:@/]+):([^@]+)@(.+)$/i;

/** `user:password@scheme://…`, as `connect` takes an identity. */
const USER_FIRST: RegExp = /^([^:@/]+):([^@]+)@([a-z][a-z0-9+.-]*:\/\/.+)$/i;

/** A bare `user:password@host`. */
const BARE: RegExp = /^([^:@/\s]+):([^@\s]+)@([^@\s]+)$/;

/**
 * A line as the history keeps it: every secret's place marked, the whole
 * secret gone, whatever quoting it was typed in.
 *
 * The line is read as shell words, so a secret is the whole word after its
 * option, joined quotes and escaped spaces included:
 *
 * - `--password x`, `--password=x`, `--password "x y"`, `--password 'it''s'`,
 *   and the same for `--adminPassword`, `--token` and `--auth-token`;
 * - `-p x` (and `-p=x`) in a command whose verb is `connect`, `chell` or
 *   `calypso`, wherever on the line that command stands (`cd /x; connect -p x`);
 *   elsewhere `-p` is not a password;
 * - the password of `scheme://user:password@host` and of
 *   `user:password@scheme://host` in any word, and of a bare
 *   `user:password@host` in a `connect`, `chell` or `calypso` command;
 * - the `token=` of an address.
 *
 * A line with a quote left open cannot be read that way. If it shows any
 * mark of a secret it is not kept; otherwise it is kept as typed.
 *
 * @param line - The line as typed.
 * @returns The line to keep, or null for one that must not be kept at all.
 *
 * @example
 * ```ts
 * historyLine_redact('connect --user rudolph --password "my secret" https://cube/api/v1/'); // 'connect --user rudolph --password *** https://cube/api/v1/'
 * ```
 */
export function historyLine_redact(line: string): string | null {
  const pieces: LinePiece[] | null = line_scan(line);
  if (pieces === null) return SECRET_MARK.test(line) ? null : line;
  /** Replacements, each a span of the line and what stands there instead. */
  const swaps: Array<{ start: number; end: number; text: string }> = [];
  let verb: string | null = null;
  for (let at: number = 0; at < pieces.length; at++) {
    const piece: LinePiece = pieces[at] as LinePiece;
    if (piece.kind === 'op') { verb = null; continue; }
    const first: boolean = verb === null;
    if (verb === null) verb = (piece.value.replace(/^!/, '').split('/').pop() ?? '');
    const passwordVerb: boolean = PASSWORD_VERBS.includes(verb);
    const next: LinePiece | undefined = pieces[at + 1];
    const takesNext: boolean = SECRET_OPTIONS.includes(piece.value) || (passwordVerb && piece.value === '-p');
    if (takesNext) {
      if (next !== undefined && next.kind === 'word') { swaps.push({ start: next.start, end: next.end, text: REDACTED }); at++; }
      continue;
    }
    const inline: string | undefined = [...SECRET_OPTIONS, ...(passwordVerb ? ['-p'] : [])].find((option: string): boolean => piece.value.startsWith(`${option}=`));
    if (inline !== undefined) {
      swaps.push({ start: piece.start, end: piece.end, text: `${inline}=${REDACTED}` });
      continue;
    }
    if (first) continue;
    const address: RegExpExecArray | null = SCHEME_FIRST.exec(piece.value) ?? USER_FIRST.exec(piece.value) ?? (passwordVerb ? BARE.exec(piece.value) : null);
    let kept: string = address !== null ? `${address[1]}:${REDACTED}@${address[3]}` : piece.value;
    kept = kept.replace(/([?&]token=)[^&]+/g, (_whole: string, lead: string): string => `${lead}${REDACTED}`);
    if (kept !== piece.value) swaps.push({ start: piece.start, end: piece.end, text: kept });
  }
  let out: string = line;
  for (const swap of swaps.reverse()) out = `${out.slice(0, swap.start)}${swap.text}${out.slice(swap.end)}`;
  return out;
}

/**
 * Puts a line just read into the reader's recall as the history keeps it.
 *
 * readline keeps every line it reads the moment it reads it, and hands it
 * on afterwards. The line as typed goes on to be run; what stays in recall
 * for the up arrow is its kept form, or nothing for a line that is not
 * kept. Done as each line is accepted, so a line typed ahead of a running
 * command is clean in recall before it ever runs, and stays so if it is
 * thrown away unrun.
 *
 * @param recall - readline's own list, newest first.
 * @param line - The line as typed.
 */
export function recall_accept(recall: unknown, line: string): void {
  if (!Array.isArray(recall) || recall[0] !== line) return;
  const kept: string | null = historyLine_redact(line);
  if (kept === null) recall.shift();
  else recall[0] = kept;
}

/** Why a history could not be made, or shown to be, private. */
export class HistoryPrivacyError extends Error {}

/**
 * Makes the shell's own history folder, private, and shows that it is.
 *
 * @param folder - The folder.
 * @throws {HistoryPrivacyError} When it is not this user's, or cannot be made theirs alone.
 */
async function ownFolder_secure(folder: string): Promise<void> {
  await fs.promises.mkdir(folder, { recursive: true, mode: HISTORY_FOLDER_MODE });
  let stat: fs.Stats = await fs.promises.stat(folder);
  if ((stat.mode & OTHERS_MASK) !== 0) {
    await fs.promises.chmod(folder, HISTORY_FOLDER_MODE);
    stat = await fs.promises.stat(folder);
  }
  if (!stat.isDirectory() || (stat.mode & OTHERS_MASK) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new HistoryPrivacyError(`${folder} is not a folder of this user's alone`);
  }
}

/**
 * Opens the history file and shows, through that open file, that it is a
 * regular file of this user's that nobody else can read, making it so
 * first if it was looser. A link is not followed.
 *
 * @param place - Where the history is kept.
 * @param flags - How to open it.
 * @returns The open file.
 * @throws {HistoryPrivacyError} When privacy cannot be shown; nothing has been written.
 */
async function history_open(place: HistoryPlace, flags: number): Promise<fs.promises.FileHandle> {
  if (place.ownFolder) await ownFolder_secure(path.dirname(place.file));
  const handle: fs.promises.FileHandle = await fs.promises.open(place.file, flags | fs.constants.O_NOFOLLOW, HISTORY_FILE_MODE);
  try {
    let stat: fs.Stats = await handle.stat();
    if (stat.isFile() && (stat.mode & OTHERS_MASK) !== 0) {
      await handle.chmod(HISTORY_FILE_MODE);
      stat = await handle.stat();
    }
    if (!stat.isFile() || (stat.mode & OTHERS_MASK) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new HistoryPrivacyError(`${place.file} is not a file of this user's alone`);
    }
    return handle;
  } catch (error: unknown) {
    await handle.close();
    throw error instanceof HistoryPrivacyError ? error : new HistoryPrivacyError(`${place.file} could not be made private: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the history, every line as the history keeps it: a file written
 * before lines were redacted is redacted as it is read, and a line that
 * must not be kept is dropped.
 *
 * @param place - Where the history is kept.
 * @returns The lines, oldest first; none when there is no history yet.
 * @throws {HistoryPrivacyError} When the file is there and cannot be shown private; it is not read.
 */
export async function history_readPrivate(place: HistoryPlace): Promise<string[]> {
  if (!fs.existsSync(place.file)) return [];
  const handle: fs.promises.FileHandle = await history_open(place, fs.constants.O_RDONLY);
  try {
    const content: string = await handle.readFile('utf-8');
    return content.split('\n').filter((line: string): boolean => line.trim() !== '')
      .map((line: string): string | null => historyLine_redact(line)).filter((line: string | null): line is string => line !== null);
  } finally {
    await handle.close();
  }
}

/**
 * Appends one line to the history, through a file shown private before the
 * line is written.
 *
 * @param place - Where the history is kept.
 * @param line - The line, already redacted.
 * @throws {HistoryPrivacyError} When privacy cannot be shown; the line is not written.
 */
export async function history_appendPrivate(place: HistoryPlace, line: string): Promise<void> {
  const handle: fs.promises.FileHandle = await history_open(place, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
  try {
    await handle.appendFile(`${line}\n`);
  } finally {
    await handle.close();
  }
}
