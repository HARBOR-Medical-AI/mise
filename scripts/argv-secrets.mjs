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
 * secret option followed by its value:
 *
 * - in source (`packages/<pkg>/src`, `apps/<app>/src`, `packages/<pkg>/exemplars`): an array of
 *   arguments holding `'--password'`, `'--token'`, `'--auth-token'`,
 *   `'--adminPassword'` or `'-p'` with a value after it, the value being
 *   anything but another option's name (a list of option names is not a
 *   command line);
 * - in `scripts/` shell files and `.github/workflows`: one of the long
 *   options, or `-p` on a line that runs chell, calypso, stratus or porter,
 *   followed by a variable.
 *
 * A hard check with no baseline: the count is zero and stays zero. Run via
 * `npm run lint:argv`; the path to check from may be given as the first
 * argument (used by its own test).
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The options whose value is a secret. */
const SECRET = String.raw`--password|--token|--auth-token|--adminPassword|-p`;

/** In source: a secret option as an element of a list, then an element that is not itself an option's name. */
const SOURCE_PATTERN = new RegExp(String.raw`['"\`](${SECRET})['"\`]\s*,\s*(?!['"\`]-)(?![\]\)])\S`, 'g');

/** In shell and workflows: a long secret option followed by a variable. */
const SHELL_LONG = /(?:^|\s)(--password|--token|--auth-token|--adminPassword)[ =]["']?\$/;

/** In shell and workflows: `-p <variable>` on a line that runs one of this project's programs. */
const SHELL_SHORT = /(?:^|\s)-p[ =]["']?\$/;

/** What marks a line as running one of this project's programs. */
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
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
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

const root = resolve(process.argv[2] ?? '.');
const findings = [];

for (const folder of [...workspaceFolders_list(root, 'src'), ...workspaceFolders_list(root, 'exemplars')]) {
  for (const file of files_collect(folder, /\.(ts|tsx|mts|mjs|js)$/, [])) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, at) => {
      // A comment may speak of the options; a line of code may not put one before its value.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      SOURCE_PATTERN.lastIndex = 0;
      const found = SOURCE_PATTERN.exec(line);
      if (found !== null) findings.push(`${relative(root, file)}:${at + 1}: ${found[1]} is given its value in an argument list`);
    });
  }
}

const shellFiles = [...files_collect(join(root, 'scripts'), /\.(sh|bash)$/, []), ...files_collect(join(root, '.github', 'workflows'), /\.ya?ml$/, [])];
for (const file of shellFiles) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, at) => {
    if (/^\s*#/.test(line)) return;
    const long = SHELL_LONG.exec(line);
    if (long !== null) findings.push(`${relative(root, file)}:${at + 1}: ${long[1]} is given a variable on a command line`);
    else if (OUR_PROGRAM.test(line) && SHELL_SHORT.test(line)) findings.push(`${relative(root, file)}:${at + 1}: -p is given a variable on a command line`);
  });
}

if (findings.length > 0) {
  console.error(`argv-secrets: ${findings.length} secret(s) on a command line:`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('A secret goes in the one process\'s environment, on its standard input, or in a private file named by the argument.');
  process.exit(1);
}
console.log('argv-secrets: no secret is given on a command line.');
