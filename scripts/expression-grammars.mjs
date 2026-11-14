/**
 * @file Expression-grammar ratchet — the commands that parse their own words
 * may only fall in number.
 *
 * A declared command's line is parsed against its grammar
 * (packages/brasa/src/core/commandParse.ts): GNU options, operands by kind.
 * A command whose arguments form an expression language (`find`) declares
 * `grammar: 'expression'` instead and keeps its own parser and completion:
 * the engine hands it words, and help, completion and the tool schema learn
 * nothing of its arguments. That is the exception, so its count is held.
 *
 * This counts `grammar: 'expression'` in the package sources, comments and
 * the declaration type itself left out. More than the baseline fails; fewer
 * also fails, with the instruction to lower the baseline in the same change.
 *
 * Enforces "One declaration per command" in docs/principles.adoc. Run via
 * `npm run lint:expressions`.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Commands that declare an expression grammar. Lower it whenever it drops.
 * `echo` (a dash-word past the front is a word) and `command` (its words are
 * the host program's line, options and all) take their words as they come,
 * and so do `whatif` (its words are a plugin's or Pipeline's whole line),
 * `calc` (an arithmetic expression: `calc -3+4`), `morse` (Morse code is
 * dashes: `morse -d -.-. ---`) and `find` (tests, operators and parentheses:
 * `-name x -o ! -type d`, an expression POSIX gives it, not options).
 */
const BASELINE = 6;

/** A declaration's grammar given as an expression language. */
const PATTERN = /(?<!readonly )\bgrammar:\s*'expression'/g;

/** A line that is a comment, whose words declare nothing. */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;

/**
 * Recursively collects .ts source files under a directory, skipping tests.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} out - Accumulator for matched file paths.
 * @returns {string[]} The accumulator.
 */
function sourceFiles_collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles_collect(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const packagesDir = new URL('../packages', import.meta.url).pathname;
const hits = [];
for (const pkg of readdirSync(packagesDir)) {
  let files;
  try {
    files = sourceFiles_collect(join(packagesDir, pkg, 'src'), []);
  } catch {
    continue; // a package without a src folder
  }
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (COMMENT_LINE.test(line)) return;
      for (const _match of line.matchAll(PATTERN)) hits.push(`  ${relative(packagesDir, file)}:${index + 1}`);
    });
  }
}
const total = hits.length;

if (total > BASELINE) {
  console.error(`expression-grammars: ${total} commands declare an expression grammar, baseline is ${BASELINE}.`);
  console.error('A command declares its options and operands, which the engine parses, completes');
  console.error('and describes. An expression language of its own is the exception: lower it');
  console.error('elsewhere, or raise this baseline in a change that says why.');
  console.error(hits.join('\n'));
  process.exit(1);
}

if (total < BASELINE) {
  console.error(`expression-grammars: count fell to ${total} (baseline ${BASELINE}) — good.`);
  console.error(`Lower BASELINE to ${total} in scripts/expression-grammars.mjs as part of this`);
  console.error('change so the improvement locks in.');
  process.exit(1);
}

console.log(`expression-grammars: ${total} commands with an expression grammar, at baseline.`);
