/**
 * @file The lint ratchet, held to cases of its judging and to a small tree
 * it is run over.
 *
 * - The judging (`scripts/lib/eslintCounts.mjs`): counts against ceilings
 *   both ways, ceilings against the base's, lowering that raises nothing,
 *   and a baseline that is not counts refused.
 * - The ratchet itself, run as CI runs it, over a tree made here with the
 *   repository's own `eslint.config.mjs`: a first baseline; at its
 *   ceilings it passes; a violation put in on purpose fails, naming the
 *   rule, the file and the line; a violation taken out fails until the
 *   ceiling is lowered, and `--lower` lowers it and raises nothing; a
 *   file ESLint cannot read fails; a workspace whose sources give ESLint
 *   no file fails; no baseline fails; a second `--bootstrap` is refused;
 *   and a ceiling raised beside its count fails against the base.
 *
 * Run via `npm run test:lint`. What it makes is under one folder per run
 * in the runner's temporary folder (`RUNNER_TEMP`) or the system's, named
 * in its last line, and is left there: this test deletes nothing.
 *
 * @module
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseline_read, baseline_write, ceilings_lower, ceilings_risen, counts_judge } from './lib/eslintCounts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
let failed = 0;

/** Says how one expectation went. */
function expect_that(what, ok, detail = '') {
  if (ok) return;
  failed++;
  console.log(`FAIL  ${what}${detail === '' ? '' : `: ${String(detail).slice(0, 700)}`}`);
}

/** Writes a file, making its folders. */
function file_put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Whether a call throws, and with what words. */
function thrown_read(act) {
  try { act(); return null; } catch (error) { return String(error.message); }
}

// ---- The judging.
const judged = counts_judge(
  { 'packages/a': { 'no-empty': 3, 'new-rule': 1 }, 'apps/new': { complexity: 2 } },
  { 'packages/a': { 'no-empty': 2, 'gone-rule': 4 }, 'packages/b': { 'max-depth': 1 } },
);
expect_that('a count above its ceiling, a rule with no ceiling and a workspace with none all rise', JSON.stringify(judged.risen.map((one) => `${one.workspace} ${one.rule} ${one.count}>${one.ceiling}`)) === JSON.stringify(['apps/new complexity 2>0', 'packages/a new-rule 1>0', 'packages/a no-empty 3>2']), JSON.stringify(judged.risen));
expect_that('a rule and a workspace no longer found fall', JSON.stringify(judged.fallen.map((one) => `${one.workspace} ${one.rule} ${one.count}<${one.ceiling}`)) === JSON.stringify(['packages/a gone-rule 0<4', 'packages/b max-depth 0<1']), JSON.stringify(judged.fallen));
const level = counts_judge({ 'packages/a': { 'no-empty': 2 } }, { 'packages/a': { 'no-empty': 2 } });
expect_that('counts at their ceilings neither rise nor fall', level.risen.length === 0 && level.fallen.length === 0);
expect_that('a ceiling raised, and one for a rule the base did not have, rose', ceilings_risen({ 'packages/a': { 'no-empty': 3, fresh: 1 } }, { 'packages/a': { 'no-empty': 2 } }).length === 2);
expect_that('ceilings equal or lower than the base\'s did not rise', ceilings_risen({ 'packages/a': { 'no-empty': 1 } }, { 'packages/a': { 'no-empty': 2, other: 5 } }).length === 0);
expect_that('lowering takes the lower of count and ceiling, drops what reached zero, and adds nothing',
  JSON.stringify(ceilings_lower({ 'packages/a': { 'no-empty': 1, risen: 9, unlisted: 4 } }, { 'packages/a': { 'no-empty': 2, risen: 3, gone: 5 } })) === JSON.stringify({ 'packages/a': { 'no-empty': 1, risen: 3 } }));
expect_that('a baseline is written with workspaces and rules in order, zeros left out', baseline_write({ b: { z: 1, a: 2, none: 0 }, a: { r: 1 }, empty: { none: 0 } }) === '{\n  "a": {\n    "r": 1\n  },\n  "b": {\n    "a": 2,\n    "z": 1\n  }\n}\n');
for (const [what, text, words] of [
  ['a ceiling written as text', '{"packages/a":{"no-empty":"2"}}', 'is "2"'],
  ['a ceiling of zero', '{"packages/a":{"no-empty":0}}', 'is 0'],
  ['a negative ceiling', '{"packages/a":{"no-empty":-1}}', 'is -1'],
  ['a ceiling with a fraction', '{"packages/a":{"no-empty":1.5}}', 'is 1.5'],
  ['a workspace that is a number', '{"packages/a":3}', 'is not a map of rules'],
  ['a baseline that is a list', '[]', 'is not a map of workspaces'],
  ['a baseline that is not JSON', '{', 'is not JSON'],
]) {
  expect_that(`${what} is refused`, (thrown_read(() => baseline_read(text, 'x')) ?? '').includes(words), thrown_read(() => baseline_read(text, 'x')));
}

// ---- The ratchet over a tree made here.
const run = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'lint-ratchet-test-'));
const tree = join(run, 'tree');
mkdirSync(join(tree, 'scripts', 'lib'), { recursive: true });
for (const file of ['eslint-ratchet.mjs', 'lib/eslintCounts.mjs', 'lib/ratchetBase.mjs']) copyFileSync(join(here, file), join(tree, 'scripts', file));
copyFileSync(join(repo, 'eslint.config.mjs'), join(tree, 'eslint.config.mjs'));
// The repository's own installed tools, so ESLint, its plugins and TypeScript are the ones the repository uses.
symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'dir');
file_put(join(tree, 'package.json'), JSON.stringify({ name: 'lint-ratchet-test-tree', private: true, type: 'module', scripts: { lint: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.lint } }));
file_put(join(tree, '.gitignore'), 'node_modules\n');
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }, include: ['src'] });
file_put(join(tree, 'packages/alpha/tsconfig.json'), TSCONFIG);
file_put(join(tree, 'apps/beta/tsconfig.json'), TSCONFIG);
/** A source file with a known set of findings: an empty block among them. */
const SOURCE = 'export function tally(values: number[]): number {\n  let sum: number = 0;\n  for (const value of values) { sum += value; }\n  try { sum += 1; } catch { }\n  return sum;\n}\n';
file_put(join(tree, 'packages/alpha/src/tally.ts'), SOURCE);
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);

const git = (...args) => execFileSync('git', args, { cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q', '-b', 'main');
for (const [key, value] of [['user.email', 'ratchet@example.invalid'], ['user.name', 'ratchet'], ['commit.gpgsign', 'false']]) git('config', key, value);
const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
const noBaseline = commit('a tree with no baseline');

/** Runs the ratchet in the tree, as `npm run lint` does, with a base named. */
function ratchet_run(base, ...flags) {
  const ran = spawnSync('npm', ['run', '-s', 'lint', '--', ...flags], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, RATCHET_BASE: base } });
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
}
const BASELINE = join(tree, 'scripts/eslint-baseline.json');

const none = ratchet_run(noBaseline);
expect_that('with no baseline the ratchet fails, saying so', none.status === 1 && none.said.includes('does not exist: there are no ceilings'), none.said);
const first = ratchet_run(noBaseline, '--bootstrap');
expect_that('--bootstrap writes the first baseline', first.status === 0 && first.said.includes('wrote scripts/eslint-baseline.json'), first.said);
const written = JSON.parse(readFileSync(BASELINE, 'utf8'));
expect_that('the baseline counts the empty block in each workspace', written['packages/alpha']?.['no-empty'] === 1 && written['apps/beta']?.['no-empty'] === 1, JSON.stringify(written));
const again = ratchet_run(noBaseline, '--bootstrap');
expect_that('a second --bootstrap is refused', again.status === 1 && again.said.includes('a baseline is written once'), again.said);
const atCeilings = ratchet_run(noBaseline);
expect_that('at its ceilings the tree passes (and against a base with no baseline file there is nothing to compare)', atCeilings.status === 0 && atCeilings.said.includes('each rule in each workspace at its ceiling'), atCeilings.said);
const withBaseline = commit('the first baseline');

// A violation put in on purpose.
file_put(join(tree, 'apps/beta/src/tally.ts'), `${SOURCE}export function second(): void {\n  try { tally([]); } catch { }\n}\n`);
const planted = ratchet_run(withBaseline);
expect_that('a violation put in on purpose fails, naming the rule, the workspace, the file and the line',
  planted.status === 1 && planted.said.includes('apps/beta: 2 findings of no-empty, its ceiling is 1') && planted.said.includes('apps/beta/src/tally.ts:8:'), planted.said);
// The ceiling raised beside it: the tree is at its ceilings again, and the base says no.
const pristine = readFileSync(BASELINE, 'utf8');
// Every count the planted function added is taken into the baseline by hand, as someone hiding it would.
const hidden = spawnSync(process.execPath, ['-e', `
  import('${join(tree, 'scripts/lib/eslintCounts.mjs')}').then(async ({ baseline_write }) => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: ${JSON.stringify(tree)} });
    const counts = {};
    for (const workspace of ['packages/alpha', 'apps/beta']) for (const result of await eslint.lintFiles([workspace + '/src/**/*.ts'])) for (const message of result.messages) { (counts[workspace] ??= {})[message.ruleId] = (counts[workspace][message.ruleId] ?? 0) + 1; }
    process.stdout.write(baseline_write(counts));
  });`], { cwd: tree, encoding: 'utf8' });
writeFileSync(BASELINE, hidden.stdout);
const raised = ratchet_run(withBaseline);
expect_that('a ceiling raised beside its count fails against the base', raised.status === 1 && raised.said.includes('apps/beta: the ceiling of no-empty is 2 here and was 1 at the base'), raised.said);
const unnamed = spawnSync('npm', ['run', '-s', 'lint'], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: '0'.repeat(40) } });
expect_that('a base that cannot be named fails the ratchet', unnamed.status === 1 && `${unnamed.stdout}${unnamed.stderr}`.includes('could not be compared'), `${unnamed.stdout}${unnamed.stderr}`);
// The same, asked of one workspace alone, and then with --lower: the base rule holds in every mode, and a
// refusal leaves the baseline as it was.
const raisedBaseline = readFileSync(BASELINE, 'utf8');
const raisedOnly = ratchet_run(withBaseline, '--only', 'apps/beta');
expect_that('a count and ceiling raised together fail under --only too', raisedOnly.status === 1 && raisedOnly.said.includes('apps/beta: the ceiling of no-empty is 2 here and was 1 at the base'), raisedOnly.said);
for (const flags of [['--lower'], ['--only', 'apps/beta', '--lower']]) {
  const raisedLower = ratchet_run(withBaseline, ...flags);
  expect_that(`a count and ceiling raised together: ${flags.join(' ')} lowers nothing and leaves the baseline as it was`, raisedLower.status === 1 && raisedLower.said.includes('nothing lowered') && readFileSync(BASELINE, 'utf8') === raisedBaseline, raisedLower.said);
}
writeFileSync(BASELINE, pristine);
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);

// A baseline is written for the first time only where there has never been one. Deleted from the working
// tree while the base has it, or with a base that cannot be found: no --bootstrap.
renameSync(BASELINE, `${BASELINE}.aside`);
const reboot = ratchet_run(withBaseline, '--bootstrap');
expect_that('--bootstrap is refused when the base has a baseline, and writes nothing', reboot.status === 1 && reboot.said.includes('the base has a scripts/eslint-baseline.json') && !existsSync(BASELINE), reboot.said);
const lostBase = spawnSync('npm', ['run', '-s', 'lint', '--', '--bootstrap'], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, RATCHET_BASE: 'no-such-ref' } });
expect_that('--bootstrap is refused when the base cannot be found, and writes nothing', lostBase.status === 1 && `${lostBase.stdout}${lostBase.stderr}`.includes('could not be compared') && !existsSync(BASELINE), `${lostBase.stdout}${lostBase.stderr}`);
renameSync(`${BASELINE}.aside`, BASELINE);
const lostBaseLower = spawnSync('npm', ['run', '-s', 'lint', '--', '--lower'], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, RATCHET_BASE: 'no-such-ref' } });
expect_that('--lower with a base that cannot be found lowers nothing', lostBaseLower.status === 1 && readFileSync(BASELINE, 'utf8') === pristine, `${lostBaseLower.stdout}${lostBaseLower.stderr}`);

// A new finding at the end of a file that already has many of the same rule: it is shown, by its line.
const NOISY = `${SOURCE}${Array.from({ length: 20 }, (_unused, at) => `export function noisy${at}(): void {\n  try { tally([]); } catch { }\n}\n`).join('')}`;
file_put(join(tree, 'apps/beta/src/tally.ts'), NOISY);
const noisyCounts = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { ESLint } from 'eslint';
  import { baseline_write } from ${JSON.stringify(join(tree, 'scripts/lib/eslintCounts.mjs'))};
  const eslint = new ESLint({ cwd: ${JSON.stringify(tree)} });
  const counts = {};
  for (const workspace of ['packages/alpha', 'apps/beta']) for (const result of await eslint.lintFiles([workspace + '/src/**/*.ts'])) for (const message of result.messages) { (counts[workspace] ??= {})[message.ruleId] = (counts[workspace][message.ruleId] ?? 0) + 1; }
  process.stdout.write(baseline_write(counts));`], { cwd: tree, encoding: 'utf8' });
writeFileSync(BASELINE, noisyCounts.stdout);
const noisyBase = commit('a file with twenty-one empty blocks, and its ceilings');
const lastLine = NOISY.split('\n').length + 1;
file_put(join(tree, 'apps/beta/src/tally.ts'), `${NOISY}export function latest(): void {\n  try { tally([]); } catch { }\n}\n`);
const buried = ratchet_run(noisyBase);
const emptyBlocks = buried.said.split('\n').filter((line) => line.includes('apps/beta/src/tally.ts:') && line.includes('Empty block statement'));
expect_that('a new finding after twenty existing ones of its rule is put first, by its line',
  buried.status === 1 && buried.said.includes('apps/beta: 22 findings of no-empty, its ceiling is 21. On lines this change added or changed (1):') && emptyBlocks[0]?.includes(`apps/beta/src/tally.ts:${lastLine}:`),
  buried.said);
// And every finding of the rule is listed, none cut off: a new one need not be on a changed line (a type that
// moved elsewhere can make one), so the twenty-one on lines nobody touched are all there, the last included.
expect_that('every finding of a rising rule is listed, those on unchanged lines past the fifteenth included',
  emptyBlocks.length === 22 && buried.said.includes("The rest of that rule's findings there (21):") && emptyBlocks.some((line) => line.includes(`apps/beta/src/tally.ts:${lastLine - 3}:`)) && !buried.said.includes('more'),
  `${emptyBlocks.length} listed; ${buried.said.slice(0, 500)}`);
// Back to the small tree and its baseline, committed, for the cases below.
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);
writeFileSync(BASELINE, pristine);
const restored = commit('the small tree again');

// Two runs lowering different workspaces at once: both reductions are in the baseline at the end. One may be
// told the other is writing and write nothing; run again, it lowers.
const CLEAN = SOURCE.replace('  try { sum += 1; } catch { }\n', '  sum += 1;\n');
file_put(join(tree, 'packages/alpha/src/tally.ts'), CLEAN);
file_put(join(tree, 'apps/beta/src/tally.ts'), CLEAN);
/** Starts a run without waiting for it. */
const ratchet_start = (...flags) => new Promise((resolve) => {
  const child = spawn('npm', ['run', '-s', 'lint', '--', ...flags], { cwd: tree, env: { PATH: process.env.PATH, HOME: process.env.HOME, RATCHET_BASE: restored } });
  let said = '';
  child.stdout.on('data', (chunk) => { said += chunk; });
  child.stderr.on('data', (chunk) => { said += chunk; });
  child.on('close', (status) => resolve({ status, said, flags }));
});
for (let round = 0; round < 3; round++) {
  writeFileSync(BASELINE, pristine);
  const together = await Promise.all([ratchet_start('--only', 'packages/alpha', '--lower'), ratchet_start('--only', 'apps/beta', '--lower')]);
  for (const one of together) {
    if (one.status === 0) continue;
    // The only refusal allowed: the other was writing. Run again, it must lower.
    expect_that(`round ${round}: a lowering that did not write says another run was writing`, one.said.includes('another run is writing scripts/eslint-baseline.json'), one.said);
    const retried = await ratchet_start(...one.flags);
    expect_that(`round ${round}: the refused lowering, run again, lowers`, retried.status === 0, retried.said);
  }
  const both = JSON.parse(readFileSync(BASELINE, 'utf8'));
  expect_that(`round ${round}: two workspaces lowered at once: both reductions survive`, both['packages/alpha']?.['no-empty'] === undefined && both['apps/beta']?.['no-empty'] === undefined && JSON.stringify(both) !== pristine.trim(), JSON.stringify(both));
  expect_that(`round ${round}: nothing is left behind beside the baseline`, readdirSync(join(tree, 'scripts')).filter((name) => name.startsWith('eslint-baseline.json.')).length === 0, readdirSync(join(tree, 'scripts')).join(' '));
}
// A claim that is there is never taken over. Whatever it holds (nothing yet, a process that is gone, one
// that is here), a writer that finds it writes nothing, and the claim and the baseline are as they were.
writeFileSync(BASELINE, pristine);
const CLAIM = `${BASELINE}.lock`;
const claims = [
  ['an empty claim, as one being made would look to a careless reader', '', 'was left by a run that is no longer running. Look that no ratchet is running, remove that file'],
  ['a claim left by a run that is gone', '2147483646', 'was left by a run that is no longer running (process 2147483646)'],
  ['a claim held by a run that is here', String(process.pid), `another run is writing scripts/eslint-baseline.json (process ${process.pid})`],
];
for (const [what, holds, words] of claims) {
  // Held open by this process for as long as the other runs, as a claimant's would be.
  const handle = openSync(CLAIM, 'w');
  writeSync(handle, holds);
  const refused = await ratchet_start('--only', 'packages/alpha', '--lower');
  const claimAfter = readFileSync(CLAIM, 'utf8');
  closeSync(handle);
  expect_that(`${what} stops a writer, which writes nothing and leaves the claim alone`,
    refused.status === 1 && refused.said.includes(words) && claimAfter === holds && readFileSync(BASELINE, 'utf8') === pristine && existsSync(CLAIM),
    `${refused.said} | claim after: ${JSON.stringify(claimAfter)}`);
  renameSync(CLAIM, `${CLAIM}.aside-${claims.findIndex((one) => one[0] === what)}`);
}
// With the claim out of the way the same run lowers, and lets its own claim go.
const freed = await ratchet_start('--only', 'packages/alpha', '--lower');
expect_that('with no claim in the way the writer lowers, and its own claim is gone when it ends', freed.status === 0 && !existsSync(CLAIM), freed.said);

// A long report is delivered whole down a pipe, to its last finding, with the failing status.
const MANY = 4000;
// The small tree as it was, so that the only faults are rules that rose.
file_put(join(tree, 'packages/alpha/src/tally.ts'), SOURCE);
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);
file_put(join(tree, 'apps/beta/src/many.ts'), Array.from({ length: MANY }, (_unused, at) => `export function many${at}(): void {\n  try { void ${at}; } catch { }\n}\n`).join(''));
writeFileSync(BASELINE, pristine);
const long = await ratchet_start();
const lastFinding = `apps/beta/src/many.ts:${MANY * 3 - 1}:`;
expect_that('a report of thousands of findings reaches the reader whole: its last finding is there, and the status is 1',
  long.status === 1 && long.said.length > 300000 && long.said.includes(lastFinding) && /apps\/beta\/src\/(many|tally)\.ts:\d+:\d+ /.test(long.said.trimEnd().split('\n').pop() ?? '') && !long.said.includes('each rule in each workspace at its ceiling'),
  `status ${long.status}, ${long.said.length} bytes, last line: ${long.said.trimEnd().split('\n').pop()?.slice(0, 160)}`);
// A file with every rule switched off for it stays in its place: it adds no finding to the cases below.
file_put(join(tree, 'apps/beta/src/many.ts'), '/* eslint-disable */\nexport const none = 0;\n');
// Back to the small tree and its baseline for the cases below.
file_put(join(tree, 'packages/alpha/src/tally.ts'), SOURCE);
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);
writeFileSync(BASELINE, pristine);

// A violation taken out.
file_put(join(tree, 'packages/alpha/src/tally.ts'), SOURCE.replace('  try { sum += 1; } catch { }\n', '  sum += 1;\n'));
const improved = ratchet_run(withBaseline);
expect_that('a violation taken out fails until the ceiling is lowered', improved.status === 1 && improved.said.includes('packages/alpha: no-empty fell to 0 (ceiling 1)') && improved.said.includes('--lower'), improved.said);
const lowered = ratchet_run(withBaseline, '--lower');
const after = JSON.parse(readFileSync(BASELINE, 'utf8'));
expect_that('--lower lowers that ceiling and raises nothing', lowered.status === 0 && after['packages/alpha']?.['no-empty'] === undefined && after['apps/beta']['no-empty'] === 1 && ceilings_risen(after, JSON.parse(pristine)).length === 0, `${lowered.said} ${JSON.stringify(after)}`);
const afterLowering = ratchet_run(withBaseline);
expect_that('after lowering the tree passes', afterLowering.status === 0, afterLowering.said);
// --lower on a tree that does not pass changes nothing.
file_put(join(tree, 'apps/beta/src/tally.ts'), `${SOURCE}export function second(): void {\n  try { tally([]); } catch { }\n}\n`);
const refusedLower = ratchet_run(withBaseline, '--lower');
expect_that('--lower on a tree with a count above its ceiling lowers nothing', refusedLower.status === 1 && readFileSync(BASELINE, 'utf8') === baseline_write(after), refusedLower.said);
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);

// One workspace lowered alone, down to nothing: its entry goes, and the other workspace's ceilings stay.
const beforeOnly = JSON.parse(readFileSync(BASELINE, 'utf8'));
// A file with every rule switched off for it: a workspace with a source and not one finding.
file_put(join(tree, 'apps/beta/src/tally.ts'), '/* eslint-disable */\nexport const nothing = 0;\n');
const onlyFallen = ratchet_run(withBaseline, '--only', 'apps/beta');
expect_that('one workspace emptied of findings fails until lowered', onlyFallen.status === 1 && onlyFallen.said.includes('apps/beta:') && onlyFallen.said.includes('fell to 0'), onlyFallen.said);
const onlyLowered = ratchet_run(withBaseline, '--only', 'apps/beta', '--lower');
const afterOnly = JSON.parse(readFileSync(BASELINE, 'utf8'));
expect_that('--only <workspace> --lower down to nothing removes that workspace and leaves the others',
  onlyLowered.status === 0 && afterOnly['apps/beta'] === undefined && JSON.stringify(afterOnly['packages/alpha']) === JSON.stringify(beforeOnly['packages/alpha']) && Object.keys(beforeOnly).includes('apps/beta'),
  `${onlyLowered.said} before ${JSON.stringify(Object.keys(beforeOnly))} after ${JSON.stringify(Object.keys(afterOnly))}`);
const onlyAfter = ratchet_run(withBaseline, '--only', 'apps/beta');
expect_that('after that the workspace passes, alone and with the rest', onlyAfter.status === 0 && ratchet_run(withBaseline).status === 0, onlyAfter.said);
// The workspace as it was, findings and ceilings, for the cases below.
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);
writeFileSync(BASELINE, baseline_write(beforeOnly));

// A file ESLint cannot read.
file_put(join(tree, 'apps/beta/src/broken.ts'), 'export const = ;\n');
const broken = ratchet_run(withBaseline);
expect_that('a file ESLint cannot read fails', broken.status === 1 && broken.said.includes('apps/beta/src/broken.ts') && broken.said.includes('ESLint could not read it'), broken.said);
file_put(join(tree, 'apps/beta/src/broken.ts'), 'export {};\n');
git('add', '-A');

// A workspace whose sources give ESLint no file.
file_put(join(tree, 'packages/gamma/src/readme.txt'), 'no source here\n');
const emptyWorkspace = ratchet_run(withBaseline);
expect_that('a workspace whose sources yield no file to ESLint fails', emptyWorkspace.status === 1 && emptyWorkspace.said.includes('packages/gamma: its sources yielded no file to ESLint'), emptyWorkspace.said);

console.log(failed === 0 ? `lint ratchet: its judging, and the ratchet over a made tree, hold (made in ${run})` : `lint ratchet test: ${failed} failed (made in ${run})`);
process.exit(failed === 0 ? 0 : 1);
