/**
 * @file The lint ratchet: each workspace's ESLint findings, rule by rule,
 * may only fall.
 *
 * The rules are the TypeScript style guide's (`eslint.config.mjs`, the
 * guide's own file with its `files` pointed at this tree). The tree was
 * written before they were enforced, so a first run finds many; this does
 * not ask for them to be cleared. It counts what ESLint finds in each
 * workspace's sources (`packages/<name>/src`, `apps/<name>/src`) per rule
 * and compares each count with its committed ceiling in
 * `scripts/eslint-baseline.json`:
 *
 * - a count above its ceiling fails, and the findings of that rule in
 *   that workspace are printed (a rule or workspace with no ceiling has
 *   a ceiling of zero);
 * - a count below its ceiling fails too, asking for the ceiling to be
 *   lowered in the same change (`--lower` does exactly that, and raises
 *   nothing), so an improvement cannot be spent later;
 * - a file ESLint cannot read fails; a workspace whose sources yield no
 *   file to ESLint fails, so a pattern that stops matching is not taken
 *   for a clean tree;
 * - the ceilings themselves cannot rise: they are compared with the same
 *   file as it stood at the change's base (`scripts/lib/ratchetBase.mjs`
 *   says which commit that is), and one higher here than there fails.
 *   There is nothing to compare in one case only, the base's tree having
 *   no baseline file.
 *
 * Run via `npm run lint`. `--bootstrap` writes the baseline from what is
 * found, and only when there is none. `--root <folder>` lints another
 * tree (the check's own test). `--only <workspace>` lints one workspace
 * and judges only it.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { base_resolve, fileAtCommit_read } from './lib/ratchetBase.mjs';
import { baseline_read, baseline_write, ceilings_lower, ceilings_risen, counts_judge, DIRECTIVE_RULE } from './lib/eslintCounts.mjs';

/** The baseline file, from the repository's root. */
const BASELINE_FILE = 'scripts/eslint-baseline.json';

/** The most findings printed for one rule in one workspace that rose. */
const SHOWN = 15;

const args = process.argv.slice(2);
/** Takes a flag out of the arguments. */
function flag_take(name) {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}
/** Takes an option and its value out of the arguments. */
function option_take(name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  return args.splice(at, 2)[1];
}
const root = resolve(option_take('--root') ?? fileURLToPath(new URL('..', import.meta.url)));
const only = option_take('--only');
const bootstrap = flag_take('--bootstrap');
const lower = flag_take('--lower');
const baselinePath = join(root, BASELINE_FILE);

/**
 * The workspaces with sources: every folder under `packages/` and `apps/` that has a `src`.
 *
 * @returns {string[]} Their folders, from the root, in order.
 */
function workspaces_list() {
  const found = [];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, group, entry.name, 'src'))) found.push(`${group}/${entry.name}`);
    }
  }
  return found.sort();
}

const started = Date.now();
const workspaces = workspaces_list().filter((workspace) => only === undefined || workspace === only);
const faults = [];
if (workspaces.length === 0) faults.push(only === undefined ? `no workspace with a src folder under ${root}: nothing was linted` : `no workspace ${only} with a src folder`);

const eslint = new ESLint({ cwd: root, concurrency: 'auto', errorOnUnmatchedPattern: false });
/** Counts per workspace and rule. */
const counts = {};
/** Findings per workspace and rule, as `file:line:column message`. */
const findings = {};
let files = 0;
for (const workspace of workspaces) {
  const results = await eslint.lintFiles([`${workspace}/src/**/*.ts`]);
  // A workspace whose sources gave ESLint nothing has not been checked.
  if (results.length === 0) faults.push(`${workspace}: its sources yielded no file to ESLint: the workspace was not linted`);
  files += results.length;
  for (const result of results) {
    const file = relative(root, result.filePath);
    for (const message of result.messages) {
      if (message.fatal === true) {
        faults.push(`${file}:${message.line ?? 0}: ESLint could not read it: ${message.message}`);
        continue;
      }
      // A message with no rule is a comment that disables a rule nothing broke; with the config's own
      // warning about a file it does not cover it is a fault of the patterns, said as one.
      if (message.ruleId === null && !/disable directive/i.test(message.message)) {
        faults.push(`${file}: ${message.message}`);
        continue;
      }
      const rule = message.ruleId ?? DIRECTIVE_RULE;
      counts[workspace] ??= {};
      counts[workspace][rule] = (counts[workspace][rule] ?? 0) + 1;
      ((findings[workspace] ??= {})[rule] ??= []).push(`${file}:${message.line}:${message.column} ${message.message.split('\n')[0]}`);
    }
  }
}
const total = Object.values(counts).reduce((sum, rules) => sum + Object.values(rules).reduce((inner, count) => inner + count, 0), 0);
const seconds = Math.round((Date.now() - started) / 1000);

if (bootstrap) {
  if (existsSync(baselinePath)) {
    console.error(`eslint-ratchet: ${BASELINE_FILE} exists: a baseline is written once; after that it only falls (--lower)`);
    process.exit(1);
  }
  if (faults.length > 0 || only !== undefined) {
    console.error(`eslint-ratchet: no baseline written: ${only !== undefined ? 'a baseline is of every workspace, not one' : faults.join('; ')}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, baseline_write(counts));
  console.log(`eslint-ratchet: wrote ${BASELINE_FILE}: ${total} findings over ${workspaces.length} workspaces (${files} files, ${seconds} s).`);
  process.exit(0);
}

let ceilings = {};
if (!existsSync(baselinePath)) {
  faults.push(`${BASELINE_FILE} does not exist: there are no ceilings to hold the tree to (--bootstrap writes the first)`);
} else {
  try {
    ceilings = baseline_read(readFileSync(baselinePath, 'utf8'), BASELINE_FILE);
  } catch (error) {
    faults.push(error.message);
  }
}
// One workspace asked for: only its ceilings are judged.
const judgedCeilings = only === undefined ? ceilings : (ceilings[only] === undefined ? {} : { [only]: ceilings[only] });
const { risen, fallen } = counts_judge(counts, judgedCeilings);

if (lower) {
  if (faults.length > 0 || risen.length > 0) {
    console.error('eslint-ratchet: nothing lowered: the tree does not pass as it is (run without --lower to see why).');
    process.exit(1);
  }
  const next = only === undefined ? ceilings_lower(counts, ceilings) : { ...ceilings, ...ceilings_lower(counts, judgedCeilings) };
  if (only !== undefined && next[only] === undefined) delete next[only];
  writeFileSync(baselinePath, baseline_write(next));
  console.log(`eslint-ratchet: lowered ${fallen.length} ceiling(s) in ${BASELINE_FILE}; none raised.`);
  process.exit(0);
}

/**
 * The files this change touched, so that a rule that rose can be shown where it most likely rose: every
 * file that differs from the base, and every file git does not track yet.
 *
 * @returns {Set<string> | null} Their paths from the root; null when the base cannot be found (then nothing is singled out).
 */
function touched_read() {
  try {
    const base = base_resolve(process.env, root);
    const run = (gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter((path) => path !== '');
    return new Set([...run(['diff', '--name-only', '-z', base.sha]), ...run(['ls-files', '--others', '--exclude-standard', '-z'])]);
  } catch {
    return null;
  }
}
const touched = risen.length === 0 ? null : touched_read();
for (const one of risen) {
  const found = findings[one.workspace]?.[one.rule] ?? [];
  // Findings in the files this change touched come first: the new one is among those.
  const mine = touched === null ? [] : found.filter((line) => touched.has(line.slice(0, line.indexOf(':'))));
  const shown = mine.length > 0 ? mine : found;
  const lead = mine.length > 0 ? `That rule's findings in the files this change touched (${mine.length} of ${found.length})` : `All of that rule's findings there (the new one is among them)`;
  faults.push(`${one.workspace}: ${one.count} findings of ${one.rule}, its ceiling is ${one.ceiling}. ${lead}:\n${shown.slice(0, SHOWN).map((line) => `      ${line}`).join('\n')}${shown.length > SHOWN ? `\n      … and ${shown.length - SHOWN} more` : ''}`);
}
for (const one of fallen) {
  faults.push(`${one.workspace}: ${one.rule} fell to ${one.count} (ceiling ${one.ceiling}) — good. Lower it in ${BASELINE_FILE} as part of this change (npm run lint -- --lower), so the improvement locks in.`);
}

// The ceilings against the base's: only for the repository's own baseline, whole.
if (existsSync(baselinePath) && only === undefined) {
  try {
    const base = base_resolve(process.env, root);
    const text = fileAtCommit_read(base.sha, BASELINE_FILE, root);
    // Nothing to compare with in one case only: the base's tree has no baseline file.
    if (text !== null) {
      const atBase = baseline_read(text, `${BASELINE_FILE} at the base (${base.sha.slice(0, 8)})`);
      faults.push(...ceilings_risen(ceilings, atBase).map((line) => `${line} (base: ${base.how}, ${base.sha.slice(0, 8)})`));
    }
  } catch (error) {
    faults.push(`the ceilings could not be compared with the base's: ${error.message}`);
  }
}

if (faults.length > 0) {
  console.error(`eslint-ratchet: ${faults.length} fault(s) (${files} files, ${seconds} s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`eslint-ratchet: ${total} findings over ${workspaces.length} workspace(s) (${files} files, ${seconds} s), each rule in each workspace at its ceiling.`);
