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
 *   no baseline file. A base that cannot be found fails.
 *
 * That last rule holds in every mode, since each of them judges or writes
 * ceilings. Run via `npm run lint`. `--only <workspace>` lints one
 * workspace and judges only it, its ceilings against the base's among the
 * rest. `--lower` lowers ceilings to what was found, writes nothing if the
 * tree does not pass, and writes no ceiling above the base's.
 * `--bootstrap` writes a first baseline only where there has never been
 * one: none in the working tree and none at the base. A baseline is
 * written whole or not at all. `--root <folder>` lints another tree.
 *
 * When a rule rises, its findings on the lines the change added or
 * changed are printed, all of them: the new one is there. Only when none
 * is on such a line are others shown, and those may be cut short.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// ---- The base: the commit this change starts from, and the ceilings as they stood there. Found before
// anything is judged or written, and needed in every mode: a ceiling may be written here only if it is no
// higher than the base's, and a first baseline only where the base had none.
/** The base commit; null when it could not be resolved (a fault, already said). */
let base = null;
/** The ceilings at the base; null when the base's tree has no baseline file (the one case with nothing to compare). */
let atBase = null;
try {
  base = base_resolve(process.env, root);
  const text = fileAtCommit_read(base.sha, BASELINE_FILE, root);
  if (text !== null) atBase = baseline_read(text, `${BASELINE_FILE} at the base (${base.sha.slice(0, 8)})`);
} catch (error) {
  base = null;
  faults.push(`the ceilings could not be compared with the base's: ${error.message}`);
}
const baseSaid = base === null ? '' : ` (base: ${base.how}, ${base.sha.slice(0, 8)})`;

/**
 * Writes the baseline whole or not at all: to a file beside it, then moved into its place.
 *
 * @param {Record<string, Record<string, number>>} next - The ceilings to write.
 */
function baseline_put(next) {
  const beside = `${baselinePath}.writing`;
  writeFileSync(beside, baseline_write(next));
  renameSync(beside, baselinePath);
}

if (bootstrap) {
  // A first baseline is written where there has never been one: not in the working tree, and not at the
  // base. A baseline that was deleted is not a reason to count afresh.
  const refusals = [];
  if (only !== undefined) refusals.push('a baseline is of every workspace, not one');
  if (existsSync(baselinePath)) refusals.push(`${BASELINE_FILE} exists: a baseline is written once; after that it only falls (--lower)`);
  if (atBase !== null) refusals.push(`the base has a ${BASELINE_FILE}${baseSaid}: there are ceilings already; restore that file and lower it`);
  refusals.push(...faults);
  if (refusals.length > 0) {
    console.error(`eslint-ratchet: no baseline written: ${refusals.join('; ')}`);
    process.exit(1);
  }
  baseline_put(counts);
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
// One workspace asked for: only its ceilings are judged, against its counts and against the base's.
const judgedCeilings = only === undefined ? ceilings : (ceilings[only] === undefined ? {} : { [only]: ceilings[only] });
const { risen, fallen } = counts_judge(counts, judgedCeilings);
// The committed ceilings against the base's, in every mode: one higher here than there is a fault.
if (atBase !== null) faults.push(...ceilings_risen(judgedCeilings, atBase).map((line) => `${line}${baseSaid}`));

if (lower) {
  if (faults.length > 0 || risen.length > 0) {
    console.error('eslint-ratchet: nothing lowered: the tree does not pass as it is (run without --lower to see why).');
    process.exit(1);
  }
  let next;
  if (only === undefined) {
    next = ceilings_lower(counts, ceilings);
  } else {
    // One workspace: its ceilings are replaced by what lowering leaves of them, which is nothing at all
    // when its last finding is gone; every other workspace's stay as they were.
    const loweredOnly = ceilings_lower(counts, judgedCeilings)[only];
    next = { ...ceilings };
    if (loweredOnly === undefined) delete next[only]; else next[only] = loweredOnly;
  }
  // What is about to be written is held to the base as well: lowering never puts a ceiling above the base's.
  const over = atBase === null ? [] : ceilings_risen(only === undefined ? next : (next[only] === undefined ? {} : { [only]: next[only] }), atBase);
  if (over.length > 0) {
    console.error(`eslint-ratchet: nothing lowered: ${over.join('; ')}${baseSaid}`);
    process.exit(1);
  }
  baseline_put(next);
  console.log(`eslint-ratchet: lowered ${fallen.length} ceiling(s) in ${BASELINE_FILE}; none raised.`);
  process.exit(0);
}

/**
 * The lines this change added or changed, per file, so that a rule that rose can be shown where it rose.
 *
 * @returns {Map<string, { all: boolean, lines: Set<number> }> | null} For each file that differs from the base, its added and changed lines (`all` for a file the base did not have); null when the base is not known.
 */
function changed_read() {
  if (base === null) return null;
  const run = (gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  const changed = new Map();
  try {
    for (const path of run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) if (path !== '') changed.set(path, { all: true, lines: new Set() });
    // No context lines: each hunk's header names exactly the lines that are new in this tree.
    let file = null;
    for (const line of run(['diff', '--unified=0', '--no-color', '--no-ext-diff', base.sha, '--']).split('\n')) {
      if (line.startsWith('+++ ')) {
        file = line === '+++ /dev/null' ? null : line.slice(line.indexOf('/') + 1);
        if (file !== null && !changed.has(file)) changed.set(file, { all: false, lines: new Set() });
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk === null || file === null) continue;
      const first = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let at = first; at < first + count; at++) changed.get(file).lines.add(at);
    }
  } catch {
    return null;
  }
  return changed;
}
const changed = risen.length === 0 ? null : changed_read();
for (const one of risen) {
  const found = findings[one.workspace]?.[one.rule] ?? [];
  // Where each finding stands: on a line this change added or changed, elsewhere in a file it touched, or
  // in a file it did not touch. The first kind is where the new one is, and is never cut short.
  const onChanged = [];
  const inTouched = [];
  const elsewhere = [];
  for (const line of found) {
    const [file, lineNumber] = line.split(':');
    const lines = changed?.get(file);
    if (lines === undefined) elsewhere.push(line);
    else if (lines.all || lines.lines.has(Number(lineNumber))) onChanged.push(line);
    else inTouched.push(line);
  }
  const list = (lines, cap) => `${lines.slice(0, cap).map((line) => `      ${line}`).join('\n')}${lines.length > cap ? `\n      … and ${lines.length - cap} more` : ''}`;
  let shown;
  if (onChanged.length > 0) shown = `On lines this change added or changed, all ${onChanged.length} of that rule's findings:\n${list(onChanged, Infinity)}`;
  else if (changed === null) shown = `The base is not known, so the new one cannot be picked out. All ${found.length} of that rule's findings there:\n${list(found, Infinity)}`;
  else shown = `None is on a line this change added or changed (a change elsewhere made one, a type that moved for instance). In the files it touched (${inTouched.length}), then the rest (${elsewhere.length}):\n${list([...inTouched, ...elsewhere], SHOWN)}`;
  faults.push(`${one.workspace}: ${one.count} findings of ${one.rule}, its ceiling is ${one.ceiling}. ${shown}`);
}
for (const one of fallen) {
  faults.push(`${one.workspace}: ${one.rule} fell to ${one.count} (ceiling ${one.ceiling}) — good. Lower it in ${BASELINE_FILE} as part of this change (npm run lint -- --lower), so the improvement locks in.`);
}

if (faults.length > 0) {
  console.error(`eslint-ratchet: ${faults.length} fault(s) (${files} files, ${seconds} s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`eslint-ratchet: ${total} findings over ${workspaces.length} workspace(s) (${files} files, ${seconds} s), each rule in each workspace at its ceiling.`);
