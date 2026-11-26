/**
 * @file A secret is never on a command line.
 *
 * A process's arguments are shown to every user of its host (`ps`, `/proc`),
 * and a workflow's to anything on the runner. A password or a token given
 * as an argument is therefore told to all of them. It goes in the
 * environment of the one process, on its standard input, or in a private
 * file whose name is the argument.
 *
 * This reads the places a command line is put together and fails on a
 * secret option given its value:
 *
 * - in code (`packages/<pkg>/src`, `apps/<app>/src`, `packages/<pkg>/exemplars`,
 *   and the JavaScript under `scripts/`): `'--password'`, `'--token'`,
 *   `'--auth-token'`, `'--adminPassword'` or `'-p'` as an element of a list
 *   with a value after it, however the list is laid out over lines, the
 *   value being anything but another option's name (a list of option
 *   names is not a command line), and `-p` not counting in the list of a
 *   program named just before it to which `-p` is no password (`mkdir`,
 *   `cp`, `ssh` and the like); and one of the long options joined to
 *   its value in one string (`'--token=' + t`, a template with
 *   `--token=${t}`);
 * - in shell (`scripts/*.sh`, `.github/workflows`): one of the long
 *   options followed by, or joined with `=` to, a variable; and `-p`
 *   followed by a variable in a command that runs chell, calypso, stratus
 *   or porter. A command continued over lines with a backslash is read as
 *   the one command it is.
 *
 * A hard check with no baseline: the count is zero and stays zero. Run via
 * `npm run lint:argv`; the path to check from may be given as the first
 * argument, as `scripts/argv-secrets.test.mjs` does with its fixtures.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The options whose value is a secret. */
const LONG = String.raw`--password|--token|--auth-token|--adminPassword`;

/** In code: a secret option as an element of a list, then an element that is not itself an option's name, across any white space. */
const CODE_LIST = new RegExp(String.raw`(['"\`])(${LONG}|-p)\1\s*,\s*(?!['"\`]-)(?![\]\)])\S`, 'g');

/** In code: a long secret option joined to a value inside one string, by a template or by concatenation. */
const CODE_JOINED = new RegExp(String.raw`(?:\`[^\`]*?(${LONG})=\$\{|(['"])(${LONG})=\2\s*\+)`, 'g');

/** Programs whose `-p` is no password, as named in code shortly before an argument list. */
const OTHER_P = /['"`](mkdir|cp|install|ssh|scp|rsync|sftp)['"`]/;

/** In shell: a long secret option followed by, or joined to, a variable. */
const SHELL_LONG = new RegExp(String.raw`(?:^|\s)(${LONG})[ =]["']?\$`, 'g');

/** In shell: `-p <variable>`. */
const SHELL_SHORT = /(?:^|\s)-p[ =]["']?\$/;

/** What marks a shell command as running one of this project's programs. */
const OUR_PROGRAM = /\b(chell|calypso|stratus|porter)\b|dist\/index\.js/;

/**
 * Recursively collects files under a directory whose names match.
 *
 * @param {string} dir - Directory to walk.
 * @param {RegExp} names - Which file names to take.
 * @param {string[]} out - Accumulator for matched file paths.
 * @returns {string[]} The accumulator.
 */
function files_collect(dir, names, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'fixtures') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files_collect(full, names, out);
    else if (names.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The folders of one kind under each workspace: `packages/<pkg>/<leaf>` and `apps/<app>/<leaf>`.
 *
 * @param {string} root - The repository's root.
 * @param {string} leaf - `src` or `exemplars`.
 * @returns {string[]} The folders that exist.
 */
function workspaceFolders_list(root, leaf) {
  const found = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, leaf))) found.push(join(base, entry.name, leaf));
    }
  }
  return found;
}

/**
 * Code with its comments blanked, every character kept in its place so a
 * position in the result is the same position in the file: a comment may
 * speak of the options, and what it says is not a command line.
 *
 * @param {string} text - The file's text.
 * @returns {string} The text with comment bodies replaced by spaces, line breaks kept.
 */
function comments_blank(text) {
  let out = '';
  let at = 0;
  let quote = null;
  while (at < text.length) {
    const here = text[at];
    const two = text.slice(at, at + 2);
    if (quote !== null) {
      out += here;
      if (here === '\\') { out += text[at + 1] ?? ''; at += 2; continue; }
      if (here === quote) quote = null;
      at++;
    } else if (here === '"' || here === "'" || here === '`') {
      quote = here; out += here; at++;
    } else if (two === '//') {
      while (at < text.length && text[at] !== '\n') { out += ' '; at++; }
    } else if (two === '/*') {
      const end = text.indexOf('*/', at + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; at < stop; at++) out += text[at] === '\n' ? '\n' : ' ';
    } else {
      out += here; at++;
    }
  }
  return out;
}

/** The line (from 1) a position in a text falls on. */
const line_of = (text, position) => text.slice(0, position).split('\n').length;

const root = resolve(process.argv[2] ?? '.');
const findings = [];

const codeFiles = [
  ...[...workspaceFolders_list(root, 'src'), ...workspaceFolders_list(root, 'exemplars')].flatMap((folder) => files_collect(folder, /\.(ts|tsx|mts|mjs|cjs|js)$/, [])),
  ...files_collect(join(root, 'scripts'), /\.(mjs|cjs|js|ts)$/, []),
];
for (const file of codeFiles) {
  // This file names the options in order to look for them.
  if (resolve(file) === resolve(new URL(import.meta.url).pathname)) continue;
  const text = comments_blank(readFileSync(file, 'utf8'));
  for (const found of text.matchAll(CODE_LIST)) {
    // `-p` is a password only to this project's programs. In the argument list of a program named just before
    // it, to which `-p` means something else (make parents, keep times, a port), it is that.
    if (found[2] === '-p' && OTHER_P.test(text.slice(Math.max(0, found.index - 160), found.index))) continue;
    findings.push(`${relative(root, file)}:${line_of(text, found.index)}: ${found[2]} is given its value in an argument list`);
  }
  for (const found of text.matchAll(CODE_JOINED)) {
    findings.push(`${relative(root, file)}:${line_of(text, found.index)}: ${found[1] ?? found[3]} is joined to its value in one argument`);
  }
}

const shellFiles = [...files_collect(join(root, 'scripts'), /\.(sh|bash)$/, []), ...files_collect(join(root, '.github', 'workflows'), /\.ya?ml$/, [])];
for (const file of shellFiles) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // A command continued with a backslash is one command: its lines are read together, and reported at its first.
  for (let at = 0; at < lines.length; at++) {
    const first = at;
    let command = lines[at];
    while (/\\\s*$/.test(command) && at + 1 < lines.length) {
      command = `${command.replace(/\\\s*$/, ' ')}${lines[at + 1]}`;
      at++;
    }
    if (/^\s*#/.test(command)) continue;
    const long = [...command.matchAll(SHELL_LONG)];
    for (const found of long) findings.push(`${relative(root, file)}:${first + 1}: ${found[1]} is given a variable on a command line`);
    if (long.length === 0 && OUR_PROGRAM.test(command) && SHELL_SHORT.test(command)) findings.push(`${relative(root, file)}:${first + 1}: -p is given a variable on a command line`);
  }
}

if (findings.length > 0) {
  console.error(`argv-secrets: ${findings.length} secret(s) on a command line:`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('A secret goes in the one process\'s environment, on its standard input, or in a private file named by the argument.');
  process.exit(1);
}
console.log('argv-secrets: no secret is given on a command line.');
