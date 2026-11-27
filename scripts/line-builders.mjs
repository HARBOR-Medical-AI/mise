#!/usr/bin/env node
/**
 * A line a surface hands to the shell is built from values through the
 * quoting functions of `@fnndsc/menu`, never by hand.
 *
 * This reads `apps/argus/src` for a template literal given straight to one
 * of the calls that run a line (`line_run`, `line_execute`, `verbLine_run`,
 * `command_run`, `command_show`, `verb_send`, `session_run`,
 * `lineVisible_run`, `ask`) and checks each `${…}` in it:
 *
 * - written by hand between quotes (`"${x}"`, `'${x}'`): a fault, always.
 *   Double quotes do not hold `$NAME`, and neither kind escapes its own
 *   quote.
 * - a whole word of the line (`rm ${x}`, `--where ${x}`, `key=${x}`): a
 *   fault unless it is one of the writers (`arg_quote`, `word_write`,
 *   `path_quote`, `path_write`, `home_path`, `scriptWord_write`), or is
 *   named in `scripts/line-grammar.json` as grammar that is meant: a
 *   number, a word from a closed set, a name held to a grammar elsewhere.
 * - part of a word (`feed_${id}`, `%${n}`): grammar by construction.
 *
 * What it cannot see: a line assembled in a variable or a model and run
 * later. Those are held by the tests of the builders themselves.
 *
 * A site named in the grammar file that is no longer there fails too, so
 * the list cannot outlive what it lists.
 *
 * Usage: node scripts/line-builders.mjs [--root <dir>] [--grammar <file>]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The calls that run a line. */
const RUNNERS = ['line_run', 'line_execute', 'verbLine_run', 'command_run', 'command_show', 'verb_send', 'session_run', 'lineVisible_run', 'ask'];

/** The functions that write a value into a line. */
const WRITERS = ['arg_quote', 'word_write', 'path_quote', 'path_write', 'home_path', 'scriptWord_write'];

/**
 * Lists the TypeScript sources under a folder.
 *
 * @param {string} dir - The folder.
 * @returns {string[]} The files.
 */
function sources_list(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sources_list(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/**
 * Reads a template literal that begins at a backtick.
 *
 * @param {string} text - The source.
 * @param {number} start - Where the opening backtick stands.
 * @returns {{ parts: Array<{ expr: string, before: string, after: string }>, end: number } | null} Its interpolations, each with the text before and after it; null when it does not close.
 */
export function template_read(text, start) {
  const parts = [];
  let literal = '';
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') { literal += text.slice(at, at + 2); at += 2; continue; }
    if (char === '`') {
      if (parts.length > 0) parts[parts.length - 1].after = literal;
      return { parts, end: at };
    }
    if (char === '$' && text[at + 1] === '{') {
      let depth = 1;
      let close = at + 2;
      while (close < text.length && depth > 0) {
        if (text[close] === '`') { const inner = template_read(text, close); if (inner === null) return null; close = inner.end + 1; continue; }
        if (text[close] === '{') depth++;
        else if (text[close] === '}') depth--;
        close++;
      }
      if (parts.length > 0) parts[parts.length - 1].after = literal;
      parts.push({ expr: text.slice(at + 2, close - 1).trim(), before: literal, after: '' });
      literal = '';
      at = close;
      continue;
    }
    literal += char;
    at++;
  }
  return null;
}

/**
 * Finds the templates among a call's arguments, at any depth short of a
 * nested function's body: from just after the call's opening parenthesis to
 * the parenthesis that closes it.
 *
 * @param {string} text - The source.
 * @param {number} start - Just after the call's `(`.
 * @returns {Array<{ tick: number, read: { parts: Array<{ expr: string, before: string, after: string }>, end: number } }>} Each template, with where it begins.
 */
export function templates_find(text, start) {
  const found = [];
  let depth = 1;
  let at = start;
  while (at < text.length && depth > 0) {
    const char = text[at];
    if (char === '`') {
      const read = template_read(text, at);
      if (read === null) break;
      found.push({ tick: at, read });
      at = read.end + 1;
      continue;
    }
    if (char === '\'' || char === '"') {
      at++;
      while (at < text.length && text[at] !== char) at += text[at] === '\\' ? 2 : 1;
    } else if (char === '(' || char === '[') {
      depth++;
    } else if (char === ')' || char === ']') {
      depth--;
    } else if (char === '{' || (char === '=' && text[at + 1] === '>')) {
      // An object of options, or a function given as an argument: not the line.
      break;
    }
    at++;
  }
  return found;
}

/**
 * Judges one interpolation of a line.
 *
 * @param {{ expr: string, before: string, after: string }} part - The interpolation and the text around it.
 * @returns {'written' | 'part' | 'quoted' | 'whole'} How it stands in the line.
 */
export function part_judge(part) {
  const lead = part.before.slice(-1);
  const trail = part.after.slice(0, 1);
  if ((lead === '"' || lead === '\'') && trail === lead) return 'quoted';
  // A writer's call, or a list each of whose members a writer wrote.
  if (WRITERS.some((writer) => part.expr.startsWith(`${writer}(`) || part.expr.includes(`.map(${writer})`))) return 'written';
  // A whole word: the line's start, a space, or what introduces a value before it; a space or the end after it.
  const opens = lead === '' || /[\s=:]/.test(lead);
  const closes = trail === '' || /\s/.test(trail);
  return opens && closes ? 'whole' : 'part';
}

/**
 * Checks the sources of a root.
 *
 * @param {string} root - The repository.
 * @param {Record<string, string[]>} grammar - The meant-grammar expressions, by file.
 * @returns {string[]} One line per fault.
 */
export function lines_check(root, grammar) {
  const faults = [];
  const seen = new Set();
  const call = new RegExp(`\\b(?:${RUNNERS.join('|')})\\(`, 'g');
  const dir = join(root, 'apps/argus/src');
  for (const file of existsSync(dir) ? sources_list(dir) : []) {
    const text = readFileSync(file, 'utf8');
    const name = relative(root, file);
    for (const match of text.matchAll(call)) {
      // Every template among the call's arguments: the line itself, and each branch of a line chosen by a condition.
      for (const { tick, read } of templates_find(text, match.index + match[0].length)) {
        const line = text.slice(0, tick).split('\n').length;
        for (const part of read.parts) {
          const how = part_judge(part);
          if (how === 'quoted') faults.push(`${name}:${line}  \${${part.expr}} stands between quotes written by hand: write it with arg_quote, path_quote or word_write`);
          if (how !== 'whole') continue;
          const key = `${name}\t${part.expr}`;
          if ((grammar[name] ?? []).includes(part.expr)) seen.add(key);
          else faults.push(`${name}:${line}  \${${part.expr}} is a whole word of a line and is written by none of ${WRITERS.join(', ')}: quote it, or name it in scripts/line-grammar.json if it is grammar that is meant`);
        }
      }
    }
  }
  for (const [name, exprs] of Object.entries(grammar)) {
    for (const expr of exprs) {
      if (!seen.has(`${name}\t${expr}`)) faults.push(`${name}: scripts/line-grammar.json names \${${expr}}, which no line there holds as a whole word any more: remove it`);
    }
  }
  return faults;
}

/** Runs the check; the exit status is whether it passed. */
function main() {
  const argv = process.argv.slice(2);
  const value_of = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const root = resolve(value_of('--root') ?? fileURLToPath(new URL('..', import.meta.url)));
  const grammarPath = resolve(value_of('--grammar') ?? join(root, 'scripts/line-grammar.json'));
  let grammar;
  try { grammar = JSON.parse(readFileSync(grammarPath, 'utf8')); } catch (error) { console.error(`line-builders: ${grammarPath} cannot be read: ${error.message}`); process.exit(2); }
  const faults = lines_check(root, grammar);
  if (faults.length > 0) {
    console.error(`line-builders: ${faults.length} fault(s):`);
    for (const fault of faults) console.error(`  ${fault}`);
    process.exit(1);
  }
  const named = Object.values(grammar).reduce((sum, exprs) => sum + exprs.length, 0);
  console.log(`line-builders: every value a line in apps/argus/src is built from is written by a quoting function, or is one of ${named} named piece(s) of grammar.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
