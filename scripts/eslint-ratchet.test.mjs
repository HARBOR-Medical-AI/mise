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
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
const raisedText = JSON.parse(readFileSync(BASELINE, 'utf8'));
const pristine = readFileSync(BASELINE, 'utf8');
const plantedCounts = ratchet_run(withBaseline).said;
void plantedCounts;
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
void raisedText;
const raised = ratchet_run(withBaseline);
expect_that('a ceiling raised beside its count fails against the base', raised.status === 1 && raised.said.includes('apps/beta: the ceiling of no-empty is 2 here and was 1 at the base'), raised.said);
const unnamed = spawnSync('npm', ['run', '-s', 'lint'], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: '0'.repeat(40) } });
expect_that('a base that cannot be named fails the ratchet', unnamed.status === 1 && `${unnamed.stdout}${unnamed.stderr}`.includes('could not be compared'), `${unnamed.stdout}${unnamed.stderr}`);
writeFileSync(BASELINE, pristine);
file_put(join(tree, 'apps/beta/src/tally.ts'), SOURCE);

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
