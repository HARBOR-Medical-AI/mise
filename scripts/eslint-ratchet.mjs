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
 * When a rule rises, every finding of that rule in that workspace is
 * printed, by file and line, none left out: those on lines the change
 * added or changed first, since the new one is likeliest there, then the
 * rest, since a change can make a finding on a line nobody touched.
 *
 * One run at a time writes the baseline: `--lower` and `--bootstrap`
 * claim it before they read it, and a run that finds it claimed writes
 * nothing and says so. A claim is never taken over: one left by a run
 * that was killed is a person's to remove.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { base_resolve, fileAtCommit_read } from './lib/ratchetBase.mjs';
import { baseline_read, baseline_write, ceilings_lower, ceilings_risen, counts_judge, DIRECTIVE_RULE } from './lib/eslintCounts.mjs';

/** The baseline file, from the repository's root. */
const BASELINE_FILE = 'scripts/eslint-baseline.json';

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
/** Findings per workspace and rule: the file (from the root), the line, the column and the message's first line. */
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
      ((findings[workspace] ??= {})[rule] ??= []).push({ file, line: message.line, column: message.column, message: message.message.split('\n')[0] });
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
  // A scratch file of this process's own: no other writer's is ever moved into place by this one.
  const beside = `${baselinePath}.writing.${process.pid}`;
  writeFileSync(beside, baseline_write(next));
  renameSync(beside, baselinePath);
}

/**
 * Claims the baseline for writing, for the rest of this process: one writer at a time reads it, works out
 * what to write and writes it, so two runs lowering different workspaces cannot each write over the other's
 * change.
 *
 * The claim is a file beside the baseline that holds the claimant's process id. It is made whole or not at
 * all: written under a name of this process's own, then linked to the claim's name, which fails if the
 * claim is there. So a claim is never seen empty or half-written, and there is no moment in which two runs
 * each believe they made it. A claim that is there is never taken over, by anyone: a run that finds one
 * writes nothing. If its holder is still running, it says to run again; if not (a run that was killed), it
 * says so and names the file to remove, which is a person's to do after looking. The claim is let go when
 * this process ends, and only if it is still this process's.
 *
 * @returns {string | null} Null when the claim is this process's; otherwise why not.
 */
function writer_claim() {
  const claim = `${baselinePath}.lock`;
  const mine = `${claim}.${process.pid}`;
  try {
    writeFileSync(mine, String(process.pid));
    try {
      linkSync(mine, claim);
    } finally {
      unlinkSync(mine);
    }
  } catch (error) {
    if (error.code !== 'EEXIST') return `the baseline could not be claimed for writing: ${error.message}`;
    let said = '';
    try { said = readFileSync(claim, 'utf8').trim(); } catch { /* gone again already: the next run will find it free */ }
    const holder = /^[0-9]+$/.test(said) ? Number(said) : null;
    let running = false;
    if (holder !== null) { try { process.kill(holder, 0); running = true; } catch (probe) { running = probe.code === 'EPERM'; } }
    if (running) return `another run is writing ${BASELINE_FILE} (process ${holder}): nothing was written by this one; run it again`;
    return `${BASELINE_FILE}.lock is there and nothing was written: it was left by a run that is no longer running${holder === null ? '' : ` (process ${holder})`}. Look that no ratchet is running, remove that file, and run again`;
  }
  process.on('exit', () => {
    // Let go only of a claim that is still this process's.
    try { if (readFileSync(claim, 'utf8').trim() === String(process.pid)) unlinkSync(claim); } catch { /* already gone */ }
  });
  return null;
}
// A mode that writes claims the baseline before it reads it: what it merges into is then what it writes over.
if (bootstrap || lower) {
  const refused = writer_claim();
  if (refused !== null) {
    console.error(`eslint-ratchet: ${refused}`);
    process.exit(1);
  }
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
 * The lines this change added or changed in the files it touched, so that a rule that rose can be shown
 * with its likeliest new findings first. Each file is asked about by itself, so no path is ever read out
 * of git's printing of one.
 *
 * @returns {Map<string, { all: boolean, lines: Set<number> }> | null} For each file that differs from the base, its added and changed lines (`all` for a file git does not track yet); null when the base is not known.
 */
function changed_read() {
  if (base === null) return null;
  const run = (gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  const changed = new Map();
  try {
    for (const path of run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) if (path !== '') changed.set(path, { all: true, lines: new Set() });
    for (const path of run(['diff', '--name-only', '-z', '--diff-filter=d', base.sha, '--']).split('\0')) {
      if (path === '' || changed.has(path)) continue;
      const lines = new Set();
      // No context lines: each hunk's header names exactly the lines that are new in this tree.
      for (const line of run(['diff', '--unified=0', '--no-color', '--no-ext-diff', base.sha, '--', path]).split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk === null) continue;
        const first = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let at = first; at < first + count; at++) lines.add(at);
      }
      changed.set(path, { all: false, lines });
    }
  } catch {
    return null;
  }
  return changed;
}
const changed = risen.length === 0 ? null : changed_read();
for (const one of risen) {
  const found = findings[one.workspace]?.[one.rule] ?? [];
  // A finding on a line this change added or changed is the likeliest new one, and comes first. It is not
  // the only place a new one can be (a type changed here can make a finding on a line nobody touched), so
  // every finding of the rule in the workspace is printed, none left out: the new one is in the list.
  const onChanged = [];
  const others = [];
  for (const finding of found) {
    const lines = changed?.get(finding.file);
    if (lines !== undefined && (lines.all || lines.lines.has(finding.line))) onChanged.push(finding);
    else others.push(finding);
  }
  const list = (some) => some.map((finding) => `      ${finding.file}:${finding.line}:${finding.column} ${finding.message}`).join('\n');
  const parts = [];
  if (onChanged.length > 0) parts.push(`On lines this change added or changed (${onChanged.length}):\n${list(onChanged)}`);
  if (others.length > 0) parts.push(`${onChanged.length > 0 ? 'The rest' : changed === null ? 'The base is not known, so none can be put first. All' : 'None is on a line this change added or changed. All'} of that rule's findings there (${others.length}):\n${list(others)}`);
  faults.push(`${one.workspace}: ${one.count} findings of ${one.rule}, its ceiling is ${one.ceiling}. ${parts.join('\n    ')}`);
}
for (const one of fallen) {
  faults.push(`${one.workspace}: ${one.rule} fell to ${one.count} (ceiling ${one.ceiling}) — good. Lower it in ${BASELINE_FILE} as part of this change (npm run lint -- --lower), so the improvement locks in.`);
}

if (faults.length > 0) {
  console.error(`eslint-ratchet: ${faults.length} fault(s) (${files} files, ${seconds} s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  // The status is set and the process left to end by itself: an exit called here can end it before a long
  // report has gone down a pipe, and the end of the report is where the last finding is.
  process.exitCode = 1;
} else {
  console.log(`eslint-ratchet: ${total} findings over ${workspaces.length} workspace(s) (${files} files, ${seconds} s), each rule in each workspace at its ceiling.`);
}
