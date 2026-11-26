/**
 * @file Cast ratchet: each workspace's `as unknown as` count may only fall.
 *
 * Counts occurrences of `as unknown as` in the sources of every workspace
 * (`packages/<name>/src` and `apps/<name>/src`, test files excluded) and
 * compares each workspace's count with its committed ceiling, the `casts`
 * section of `scripts/ratchet-baseline.json`. A workspace not named there
 * has a ceiling of zero. A count above its ceiling is a regression and
 * fails. A count below it fails too, with the instruction to lower the
 * ceiling in the same change, so the ratchet clicks down and an
 * improvement in one workspace cannot be spent in another.
 *
 * The ceilings themselves cannot rise: they are compared with the same
 * section as it stood at the change's base (`scripts/lib/ratchetBase.mjs`
 * says which commit that is), and one higher here than there fails.
 *
 * The adapter seam (packages/cumin/src/chrisapi/adapter.ts) is the only
 * module licensed to hold such casts long-term; everything else burns down
 * on-touch. Run via `npm run lint:casts`. The tree to read and the
 * baseline file may be given as the first two arguments, as the check's
 * own test does.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { base_resolve, ceilings_compare, fileAtCommit_read } from './lib/ratchetBase.mjs';

const PATTERN = /as unknown as/g;

/** The baseline file, from the repository's root. */
const BASELINE_FILE = 'scripts/ratchet-baseline.json';

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
    if (entry.isDirectory()) {
      sourceFiles_collect(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const baselinePath = resolve(process.argv[3] ?? join(root, BASELINE_FILE));
const ceilings = JSON.parse(readFileSync(baselinePath, 'utf8')).casts ?? {};

const counts = {};
const hits = {};
let workspaces = 0;
let files = 0;
for (const group of ['packages', 'apps']) {
  if (!existsSync(join(root, group))) continue;
  for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    const src = join(root, group, entry.name, 'src');
    if (!entry.isDirectory() || !existsSync(src)) continue;
    const workspace = `${group}/${entry.name}`;
    const sources = sourceFiles_collect(src, []);
    workspaces++;
    files += sources.length;
    for (const file of sources) {
      const count = (readFileSync(file, 'utf8').match(PATTERN) ?? []).length;
      if (count === 0) continue;
      counts[workspace] = (counts[workspace] ?? 0) + count;
      (hits[workspace] ??= []).push(`    ${count}  ${file.slice(root.length + 1)}`);
    }
  }
}

const faults = [];
// A walk that read nothing has checked nothing.
if (files === 0) faults.push(`no source file was found under ${root}: nothing was counted`);
for (const workspace of new Set([...Object.keys(counts), ...Object.keys(ceilings)])) {
  const count = counts[workspace] ?? 0;
  const ceiling = ceilings[workspace] ?? 0;
  if (count > ceiling) {
    faults.push(`${workspace}: ${count} 'as unknown as' casts, its ceiling is ${ceiling}. A cast against the chrisapi boundary belongs in cumin/src/chrisapi/adapter.ts (the licensed seam) or behind the typed contract, not at a call site.\n${(hits[workspace] ?? []).join('\n')}`);
  } else if (count < ceiling) {
    faults.push(`${workspace}: the count fell to ${count} (ceiling ${ceiling}) — good. Lower "${workspace}" to ${count} in ${BASELINE_FILE} as part of this change${count === 0 ? ' (or remove the line)' : ''}, so the improvement locks in.`);
  }
}

// The ceilings against the base's. Only when the baseline read is the repository's own (the test gives its own).
if (process.argv[3] === undefined) {
  try {
    const base = base_resolve(process.env, root);
    const text = fileAtCommit_read(base.sha, BASELINE_FILE, root);
    if (text !== null) faults.push(...ceilings_compare(ceilings, JSON.parse(text).casts, 'casts').map((line) => `${line} (base: ${base.how}, ${base.sha.slice(0, 8)})`));
  } catch (error) {
    faults.push(`the ceilings could not be compared with the base's: ${error.message}`);
  }
}

if (faults.length > 0) {
  console.error(`cast-ratchet: ${faults.length} fault(s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
const total = Object.values(counts).reduce((sum, one) => sum + one, 0);
console.log(`cast-ratchet: ${total} casts over ${workspaces} workspaces (${files} files), each at its ceiling: ${Object.entries(counts).map(([workspace, count]) => `${workspace} ${count}`).join(', ')}.`);
