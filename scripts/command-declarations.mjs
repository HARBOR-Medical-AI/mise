/**
 * @file Declaration check — every command is declared in one record, in
 * every package and app that registers commands.
 *
 * A command declares itself with `command_declare`
 * (packages/brasa/src/core/commandDeclaration.ts): its name, grammar, kinds,
 * handler, holds and help in one record, registered through a group's
 * `declarations`. The registry answers a name only from a declaration, and
 * the words the shell answers before it (`sudo`, `exit`, `!`, `clear`,
 * `prompt`) have only a page, declared in `core/shellWords.ts`.
 *
 * This holds that shape in the source, a hard check at zero, over every
 * TypeScript source under packages/*\/src and apps/*\/src:
 * - every command group (`…: CommandGroup = { … }`, a function returning
 *   `CommandGroup`, or an object handed straight to `commands_register`)
 *   holds nothing but `declarations` and `shellWords`;
 * - no module keeps a record binding names to handlers of raw words or to
 *   pages of their own beside a declaration;
 * - the registry's `CommandGroup` takes no such record.
 * The runtime side, that every name the engine answers has a declaration
 * behind it, is packages/brasa/tests/helpCategories.test.ts (brasa's own
 * and the ChRIS backend's) and packages/stratus/tests/declarations.test.ts
 * (stratus's).
 *
 * Enforces "One declaration per command" in docs/principles.adoc. Run via
 * `npm run lint:commands`.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/** The registry, whose `CommandGroup` says what a group may hold. */
const registryPath = join(root, 'packages/brasa/src/core/commandRegistry.ts');

/** What a group may hold. */
const GROUP_KEYS = new Set(['declarations', 'shellWords']);

/** The records that once bound a name beside a declaration. */
const RETIRED_RECORDS = [
  /:\s*Record<string,\s*EnvelopeHandler>\s*=\s*\{/,
  /:\s*Record<string,\s*CommandHandler>\s*=\s*\{/,
  /:\s*Record<string,\s*CommandHelp>\s*=\s*\{/,
  /:\s*Record<string,\s*readonly SessionPiece\[\]>\s*=\s*\{/,
];

/**
 * Every TypeScript source under a folder, tests and builds left out.
 *
 * @param {string} folder - The folder.
 * @returns {string[]} The files.
 */
function sources_list(folder) {
  const found = [];
  for (const entry of readdirSync(folder)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) found.push(...sources_list(path));
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/**
 * The `src` folders of every package and app.
 *
 * @returns {string[]} The folders.
 */
function sourceRoots_list() {
  const roots = [];
  for (const parent of ['packages', 'apps']) {
    let names = [];
    try { names = readdirSync(join(root, parent)); } catch { continue; }
    for (const name of names) {
      const src = join(root, parent, name, 'src');
      try { if (statSync(src).isDirectory()) roots.push(src); } catch { /* no src */ }
    }
  }
  return roots;
}

/**
 * The text of a brace-balanced block starting at an opening brace.
 *
 * @param {string} text - The source.
 * @param {number} open - Where the `{` stands.
 * @returns {string} The block's inside.
 */
function block_read(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '{') depth++;
    else if (text[at] === '}' && --depth === 0) return text.slice(open + 1, at);
  }
  return text.slice(open + 1);
}

/**
 * The top-level keys of an object literal's inside.
 *
 * @param {string} inside - The literal between its braces.
 * @returns {string[]} The keys (a shorthand property, or `key:`), spreads as `...`.
 */
function topKeys_read(inside) {
  const keys = [];
  let depth = 0;
  let piece = '';
  const flush = () => {
    const word = piece.trim();
    if (word !== '') keys.push(word.startsWith('...') ? '...' : (word.match(/^['"]?([\w$]+)['"]?\s*(?::|$)/)?.[1] ?? word));
    piece = '';
  };
  for (const char of inside) {
    if ('{[('.includes(char)) depth++;
    if ('}])'.includes(char)) depth--;
    if (char === ',' && depth === 0) { flush(); continue; }
    piece += char;
  }
  flush();
  return keys;
}

/**
 * The object literals a source makes as command groups.
 *
 * @param {string} text - The source.
 * @returns {Array<{ where: number, inside: string }>} Each group's inside, and where it starts.
 */
function groups_find(text) {
  const groups = [];
  const literal = /(?::\s*CommandGroup\s*=\s*|commands_register\(\s*)\{/g;
  for (const match of text.matchAll(literal)) {
    const open = match.index + match[0].length - 1;
    groups.push({ where: match.index, inside: block_read(text, open) });
  }
  // A function returning a group: the object it returns.
  const made = /\)\s*:\s*CommandGroup\s*\{/g;
  for (const match of text.matchAll(made)) {
    const body = block_read(text, match.index + match[0].length - 1);
    for (const returned of body.matchAll(/return\s*\{/g)) {
      groups.push({ where: match.index, inside: block_read(body, returned.index + returned[0].length - 1) });
    }
  }
  return groups;
}

/**
 * The line a position stands on, for a problem's place.
 *
 * @param {string} text - The source.
 * @param {number} at - The position.
 * @returns {number} The line, from 1.
 */
function line_at(text, at) {
  return text.slice(0, at).split('\n').length;
}

const problems = [];
let groupCount = 0;
let callers = 0;
for (const folder of sourceRoots_list()) {
  for (const path of sources_list(folder)) {
    const text = readFileSync(path, 'utf8');
    // Comments name these words in examples; only code counts.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
    const where = relative(root, path);
    if (/commands_register\(/.test(code) && !where.endsWith('core/commandRegistry.ts')) callers++;
    // The registry keeps its own records of what declarations register; no group binds them.
    for (const record of where.endsWith('core/commandRegistry.ts') ? [] : RETIRED_RECORDS) {
      const found = code.match(record);
      if (found !== null) problems.push(`${where}:${line_at(code, found.index)}: binds names outside a declaration (${found[0].trim()})`);
    }
    for (const group of groups_find(code)) {
      groupCount++;
      for (const key of topKeys_read(group.inside)) {
        if (!GROUP_KEYS.has(key)) problems.push(`${where}:${line_at(code, group.where)}: a command group holds '${key}', which is not a declaration`);
      }
    }
  }
}

const registry = readFileSync(registryPath, 'utf8');
const groupType = registry.match(/export interface CommandGroup \{([\s\S]*?)\n\}/);
if (groupType === null) {
  problems.push(`${relative(root, registryPath)}: could not locate CommandGroup — has the source moved?`);
} else {
  for (const field of ['envelope', 'plain', 'help', 'holds']) {
    if (new RegExp(`^\\s*${field}\\?:`, 'm').test(groupType[1])) problems.push(`${relative(root, registryPath)}: CommandGroup takes '${field}', a name bound outside a declaration`);
  }
}

if (groupCount === 0) problems.push('found no command group anywhere — has the source moved?');

if (problems.length > 0) {
  console.error('command-declarations: a command must be declared in one record (command_declare, core/commandDeclaration.ts)');
  console.error('and registered through its group\'s declarations. See "One declaration per command" in docs/principles.adoc.');
  console.error(problems.map((problem) => `  ${problem}`).join('\n'));
  process.exit(1);
}

console.log(`command-declarations: ${groupCount} command groups in ${callers} registering modules across packages/ and apps/, each binding names only through declarations and shell words.`);
