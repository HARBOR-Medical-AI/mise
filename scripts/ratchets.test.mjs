/**
 * @file The ratchets, held to trees and histories made for the purpose.
 *
 * - The cast ratchet over small trees: at its ceilings it passes; a new
 *   cast in an app fails; a cast removed fails until the ceiling is
 *   lowered; a workspace with no ceiling has a ceiling of zero; a tree
 *   with no source is not a pass; a ceiling that is not a count is refused.
 * - The base a ratchet's ceilings are compared with, for each way a check
 *   is run, in a repository made here: it resolves, or the check fails;
 *   the one case with nothing to compare is a base whose tree has no
 *   baseline file. The ratchet itself is run there against a ceiling
 *   raised beside its count, a base file with a ceiling that is not a
 *   count, and a base file without the section.
 * - The test and seam lints, by their own commands: `npm run lint:tests`
 *   and `npm run lint:seam` are run, as `package.json` writes them, in a
 *   tree made here with a violation planted under each folder the command
 *   is meant to reach, in `apps/` and `packages/`, `test` and `tests`.
 *
 * Run via `npm run test:ratchets`. Everything it makes is under one folder
 * per run, in the runner's temporary folder (`RUNNER_TEMP`, which a CI
 * runner clears) or the system's, and is left there: this test deletes
 * nothing. The folder is named in its last line.
 *
 * @module
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base_name, base_resolve, ceilings_compare, ceilings_read, fileAtCommit_read } from './lib/ratchetBase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
/** The one folder this run makes things in. */
const run = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'ratchets-test-'));
let made = 0;
/** A new folder under the run's own. */
const folder_make = (name) => { const path = join(run, `${String(made++).padStart(2, '0')}-${name}`); mkdirSync(path); return path; };
let failed = 0;

/** Says how one expectation went. */
function expect_that(what, ok, detail = '') {
  if (ok) return;
  failed++;
  console.log(`FAIL  ${what}${detail === '' ? '' : `: ${detail}`}`);
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

// ---- The cast ratchet over trees.
const CAST = 'const a = b as unknown as C;\n';
/** Makes a tree (workspace to number of casts) and its baseline, and returns the ratchet's outcome over it. */
function casts_check(tree, baseline) {
  const root = folder_make('casts');
  for (const [workspace, count] of Object.entries(tree)) file_put(join(root, workspace, 'src', 'a.ts'), CAST.repeat(count) || 'export {};\n');
  file_put(join(root, 'baseline.json'), typeof baseline === 'string' ? baseline : JSON.stringify({ casts: baseline }));
  const ran = spawnSync(process.execPath, [join(here, 'cast-ratchet.mjs'), root, join(root, 'baseline.json')], { encoding: 'utf8' });
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
}
const atCeiling = casts_check({ 'packages/cumin': 2, 'apps/argus': 3, 'apps/porter': 0 }, { 'packages/cumin': 2, 'apps/argus': 3 });
expect_that('casts at their ceilings pass', atCeiling.status === 0, atCeiling.said);
const risen = casts_check({ 'packages/cumin': 2, 'apps/porter': 1 }, { 'packages/cumin': 2 });
expect_that('a new cast in an app with no ceiling fails, by name', risen.status === 1 && risen.said.includes("apps/porter: 1 'as unknown as' casts, its ceiling is 0") && risen.said.includes('apps/porter/src/a.ts'), risen.said);
const traded = casts_check({ 'packages/cumin': 1, 'apps/argus': 4 }, { 'packages/cumin': 2, 'apps/argus': 3 });
expect_that('a fall in one workspace does not pay for a rise in another', traded.status === 1 && traded.said.includes('apps/argus: 4') && traded.said.includes('packages/cumin: the count fell to 1'), traded.said);
const fallen = casts_check({ 'packages/cumin': 1 }, { 'packages/cumin': 2 });
expect_that('a fall fails until the ceiling is lowered', fallen.status === 1 && fallen.said.includes('Lower "packages/cumin" to 1'), fallen.said);
const empty = casts_check({}, {});
expect_that('a tree with no source is not a pass', empty.status === 1 && empty.said.includes('nothing was counted'), empty.said);
// A ceiling that is not a count compares as neither above nor below: it is refused, not passed.
for (const [what, baseline, words] of [
  ['a ceiling written as text', { 'packages/cumin': '2' }, 'the ceiling of packages/cumin in "casts" is "2"'],
  ['a ceiling of null', { 'packages/cumin': null }, 'is null'],
  ['a negative ceiling', { 'packages/cumin': -1 }, 'is -1'],
  ['a ceiling with a fraction', { 'packages/cumin': 2.5 }, 'is 2.5'],
  ['a baseline with no casts section', '{"other":{}}', 'has no "casts" section'],
  ['a casts section that is a list', '{"casts":[2]}', 'is not a map'],
  ['a baseline that is not JSON', '{casts', 'is not JSON'],
]) {
  const refused = casts_check({ 'packages/cumin': 2 }, baseline);
  expect_that(`${what} is refused`, refused.status === 1 && refused.said.includes(words), refused.said);
}
expect_that('ceilings are read as they are when they are counts', JSON.stringify(ceilings_read('{"casts":{"a":0,"b":7}}', 'casts', 'x')) === '{"a":0,"b":7}');

// ---- The base, in a repository made here.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const work = folder_make('base');
const origin = join(work, 'origin.git');
const clone = join(work, 'clone');
git(work, 'init', '-q', '--bare', '-b', 'main', origin);
git(work, 'clone', '-q', origin, clone);
for (const [key, value] of [['user.email', 'ratchet@example.invalid'], ['user.name', 'ratchet'], ['commit.gpgsign', 'false']]) git(clone, 'config', key, value);
const commit = (message) => { git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', message); return git(clone, 'rev-parse', 'HEAD'); };
const BASELINE = 'scripts/ratchet-baseline.json';
file_put(join(clone, 'readme'), 'one\n');
const bare = commit('no baseline yet');
file_put(join(clone, BASELINE), JSON.stringify({ casts: { 'packages/cumin': 2 } }));
const withBaseline = commit('a baseline');
file_put(join(clone, BASELINE), JSON.stringify({ casts: { 'packages/cumin': '2' } }));
const malformed = commit('a baseline whose ceiling is text');
file_put(join(clone, BASELINE), JSON.stringify({ other: {} }));
const sectionless = commit('a baseline without the section');
file_put(join(clone, BASELINE), JSON.stringify({ casts: { 'packages/cumin': 2 } }));
const restored = commit('the baseline again');
git(clone, 'push', '-q', 'origin', 'main');
git(clone, 'checkout', '-q', '-b', 'work');
file_put(join(clone, 'readme'), 'two\n');
const tip = commit('work');
git(clone, 'push', '-q', 'origin', 'work');

expect_that('a pull request: the merge base with its base ref', base_resolve({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' }, clone).sha === restored);
expect_that('a pull request with no base ref fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'pull_request' }, clone)) ?? '').includes('no GITHUB_BASE_REF'));
expect_that('a pull request whose base ref is not here fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'nosuch' }, clone)) ?? '').includes('does not resolve to a commit that is here'));
expect_that('a push: the before commit', base_resolve({ GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: bare }, clone).sha === bare);
expect_that('a push whose before is all zeros fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: '0'.repeat(40) }, clone)) ?? '').includes('the base cannot be named'));
expect_that('a push with no before fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'push' }, clone)) ?? '').includes('the base cannot be named'));
expect_that('a push whose before commit is not here fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: 'a'.repeat(40) }, clone)) ?? '').includes('does not resolve to a commit that is here'));
expect_that('a manual run on main: the commit before', base_name({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main' }, clone).ref === 'HEAD~1');
expect_that('a manual run elsewhere: the merge base with main', base_resolve({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'work' }, clone).sha === restored);
expect_that('a manual run with a base given: that one', base_resolve({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', RATCHET_BASE: bare }, clone).sha === bare);
expect_that('a base given that is not here fails', (thrown_read(() => base_resolve({ RATCHET_BASE: 'nosuch-ref' }, clone)) ?? '').includes('does not resolve'));
expect_that('on a desk: the merge base with origin/main', base_resolve({}, clone).sha === restored && tip !== restored);
expect_that('an event with no base defined fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'schedule' }, clone)) ?? '').includes('no base is defined'));
// The one case with nothing to compare: the base resolved, and its tree has no baseline file.
expect_that('a base whose tree has no baseline file: nothing to compare', fileAtCommit_read(bare, BASELINE, clone) === null);
expect_that('a base whose tree has it: read', JSON.parse(fileAtCommit_read(withBaseline, BASELINE, clone) ?? '{}').casts['packages/cumin'] === 2);
expect_that('a commit that is not here is an error, not "no file"', thrown_read(() => fileAtCommit_read('a'.repeat(40), BASELINE, clone)) !== null);

// ---- Ceilings against the base's.
expect_that('a ceiling raised beside its count fails', ceilings_compare({ 'packages/cumin': 3 }, { 'packages/cumin': 2 }, 'casts').length === 1);
expect_that('a ceiling for a workspace the base did not name rose from zero', ceilings_compare({ 'packages/cumin': 2, 'apps/new': 1 }, { 'packages/cumin': 2 }, 'casts').length === 1);
expect_that('ceilings equal or lower pass', ceilings_compare({ 'packages/cumin': 1 }, { 'packages/cumin': 2, 'apps/argus': 5 }, 'casts').length === 0);

// ---- The ratchet itself, run in that repository, against each base.
mkdirSync(join(clone, 'scripts/lib'), { recursive: true });
for (const file of ['cast-ratchet.mjs', 'lib/ratchetBase.mjs']) copyFileSync(join(here, file), join(clone, 'scripts', file));
/** Runs the repository's own ratchet with a tree of so many casts in cumin, a ceiling, and a base. */
function ratchet_run(casts, ceiling, base) {
  file_put(join(clone, 'packages/cumin/src/a.ts'), CAST.repeat(casts));
  file_put(join(clone, BASELINE), JSON.stringify({ casts: { 'packages/cumin': ceiling } }));
  const ran = spawnSync(process.execPath, [join(clone, 'scripts/cast-ratchet.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, ...base } });
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
}
const level = ratchet_run(2, 2, { RATCHET_BASE: withBaseline });
expect_that('at the base\'s ceiling the ratchet passes', level.status === 0, level.said);
const raised = ratchet_run(3, 3, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' });
expect_that('raising the number beside the violation fails against the base', raised.status === 1 && raised.said.includes('packages/cumin is 3 here and was 2 at the base'), raised.said);
const fresh = ratchet_run(3, 3, { RATCHET_BASE: bare });
expect_that('against a base with no baseline file there is nothing to compare, and only then', fresh.status === 0, fresh.said);
const againstMalformed = ratchet_run(2, 2, { RATCHET_BASE: malformed });
expect_that('a base whose ceiling is not a count fails the ratchet', againstMalformed.status === 1 && againstMalformed.said.includes('the ceiling of packages/cumin in "casts" is "2"') && againstMalformed.said.includes('at the base'), againstMalformed.said);
const againstSectionless = ratchet_run(2, 2, { RATCHET_BASE: sectionless });
expect_that('a base whose file lacks the section fails the ratchet: it is not a fresh start', againstSectionless.status === 1 && againstSectionless.said.includes('has no "casts" section'), againstSectionless.said);
const unresolved = ratchet_run(2, 2, { GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: '0'.repeat(40) });
expect_that('a base that cannot be named fails the ratchet', unresolved.status === 1 && unresolved.said.includes('could not be compared'), unresolved.said);

// ---- The test and seam lints, by their own commands, in a tree with a violation under each folder they reach.
const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;
const NO_EXPECT = "test('nothing is expected', () => { const a = 1; void a; });\n";
const SEAM = "import Client from '@fnndsc/chrisapi';\nexport const client = Client;\n";
const CLEAN_TEST = "test('one is one', () => { expect(1).toBe(1); });\n";
const lints = [
  { script: 'lint:tests', config: 'eslint.tests.config.mjs', rule: 'jest/expect-expect', text: NO_EXPECT, clean: CLEAN_TEST,
    planted: ['packages/alpha/tests/planted.test.ts', 'packages/alpha/test/planted.test.js', 'apps/beta/tests/unit/planted.test.ts', 'apps/beta/test/planted.test.js'] },
  { script: 'lint:seam', config: 'eslint.seam.config.mjs', rule: 'no-restricted-imports', text: SEAM, clean: 'export const one = 1;\n',
    planted: ['packages/alpha/src/planted.ts', 'apps/beta/src/deep/planted.ts'] },
];
for (const lint of lints) {
  /** Makes a tree with the config, the command, and the given files; runs the npm command there. */
  const lint_run = (files) => {
    const tree = folder_make(lint.script.replace(':', '-'));
    copyFileSync(join(repo, lint.config), join(tree, lint.config));
    file_put(join(tree, 'package.json'), JSON.stringify({ name: 'ratchets-test-tree', private: true, type: 'module', scripts: { [lint.script]: scripts[lint.script] } }));
    // The repository's own installed tools, so the command finds eslint and its plugins as it does there.
    symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'dir');
    for (const [path, text] of files) file_put(join(tree, path), text);
    const ran = spawnSync('npm', ['run', '-s', lint.script], { cwd: tree, encoding: 'utf8' });
    return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
  };
  // Every folder holds a clean file, so each pattern of the command matches something.
  const cleanFiles = lint.planted.map((path) => [path.replace('planted', 'clean'), lint.clean]);
  const clean = lint_run(cleanFiles);
  expect_that(`npm run ${lint.script} passes a tree with nothing wrong`, clean.status === 0, clean.said);
  for (const path of lint.planted) {
    const one = lint_run([...cleanFiles, [path, lint.text]]);
    expect_that(`npm run ${lint.script} fails on a violation in ${path}`, one.status !== 0 && one.said.includes(path) && one.said.includes(lint.rule), one.said.slice(0, 400));
  }
}

// The coverage ratchet, over trees made here: a summary as jest writes it, and floors beside it.
{
  const { args_read, coverage_judge, floor_derive, floors_compare, floors_read, measure_place, summary_read, uncovered_list } = await import('./coverage-ratchet.mjs');
  const { coverageDir_effective, path_physical, report_publish, run_plan, PARTIAL_DIR, SUITE_DIR } = await import('./jest-with-floor.mjs');
  const { buildArgv } = await import('jest-cli');
  /** A tree with one workspace's coverage summary and a baseline file; runs the ratchet over it. */
  const coverage_run = (summary, floors, extra = []) => {
    const tree = folder_make('coverage');
    if (summary !== null) file_put(join(tree, 'apps/argus/coverage/coverage-summary.json'), typeof summary === 'string' ? summary : JSON.stringify(summary));
    file_put(join(tree, 'baseline.json'), JSON.stringify({ casts: {}, coverage: floors === null ? {} : { 'apps/argus': floors } }));
    const before = readFileSync(join(tree, 'baseline.json'), 'utf8');
    const ran = spawnSync('node', [join(here, 'coverage-ratchet.mjs'), '--root', tree, '--baseline', join(tree, 'baseline.json'), ...extra], { encoding: 'utf8' });
    const after = readFileSync(join(tree, 'baseline.json'), 'utf8');
    return { status: ran.status, said: `${ran.stdout}${ran.stderr}`, baseline: JSON.parse(after), untouched: before === after, tree };
  };
  /** A summary with these totals and, beside them, these files' line counts. */
  const summary_make = (totals, files = {}) => ({
    total: Object.fromEntries(Object.entries(totals).map(([measure, pct]) => [measure, { total: 1000, covered: Math.round(pct * 10), pct }])),
    ...files,
  });
  const at = { lines: 60.92, statements: 58.83, branches: 50.72, functions: 55.66 };
  const floors = { lines: 60.9, statements: 58.8, branches: 50.7, functions: 55.6 };
  expect_that('a floor is a measure to one decimal, rounded down', floor_derive(68.99) === 68.9 && floor_derive(66.4) === 66.4 && floor_derive(100) === 100 && floor_derive(0.09) === 0);
  const held = coverage_run(summary_make(at), floors);
  expect_that('coverage at its floors passes', held.status === 0 && held.said.includes('at or above their floors'), held.said);
  const fell = coverage_run(summary_make({ ...at, branches: 50.69 }), floors);
  expect_that('a fall below a floor fails, and names the measure', fell.status !== 0 && fell.said.includes('branches coverage is 50.69%, below its floor of 50.7%'), fell.said);
  const rose = coverage_run(summary_make({ ...at, lines: 70.25 }), floors);
  expect_that('a rise fails until the floor is raised, and says what to raise it to', rose.status !== 0 && rose.said.includes('lines coverage rose to 70.25%') && rose.said.includes('Raise the floor to 70.2'), rose.said);
  const raised = coverage_run(summary_make({ ...at, lines: 70.25 }), floors, ['--raise']);
  expect_that('--raise raises the floor that rose and no other', raised.status === 0 && raised.baseline.coverage['apps/argus'].lines === 70.2 && raised.baseline.coverage['apps/argus'].branches === 50.7 && JSON.stringify(raised.baseline.casts) === '{}', JSON.stringify(raised.baseline));
  const refused = coverage_run(summary_make({ ...at, branches: 40 }), floors, ['--raise']);
  expect_that('--raise lowers nothing: a tree below a floor is refused and the baseline is not touched', refused.status !== 0 && refused.untouched, refused.said);
  const garbled = coverage_run('{ this is not json', floors, ['--raise']);
  expect_that('--raise over a summary that cannot be read writes nothing and fails', garbled.status !== 0 && garbled.untouched && garbled.said.includes('is not JSON'), garbled.said);
  const beyond = coverage_run(summary_make({ ...at, lines: 140 }), floors, ['--raise']);
  expect_that('a measure that is not a percentage is refused, and never written as a floor', beyond.status !== 0 && beyond.untouched && beyond.said.includes('lines total is not a percentage (140)'), beyond.said);
  const absent = coverage_run(null, floors);
  expect_that('a workspace with no summary is not a pass', absent.status !== 0 && absent.said.includes('no coverage summary'), absent.said);
  const absentRaise = coverage_run(null, floors, ['--raise']);
  expect_that('--raise with no summary writes nothing and fails', absentRaise.status !== 0 && absentRaise.untouched, absentRaise.said);
  const bad = coverage_run(summary_make(at), { ...floors, lines: 'high' });
  expect_that('a floor that is not a percentage is refused', bad.status !== 0 && bad.said.includes('lines floor of apps/argus is not a percentage'), bad.said);
  // A workspace the caller requires: an empty section is not "nothing to hold".
  const empty = coverage_run(summary_make(at), null);
  expect_that('with nothing required, a section that names no workspace has nothing to judge', empty.status === 0 && empty.said.includes('0 workspace(s)'), empty.said);
  const required = coverage_run(summary_make(at), null, ['--require', 'apps/argus']);
  expect_that('a required workspace with no floors fails, whatever the base', required.status !== 0 && required.said.includes('apps/argus: it has no coverage floors'), required.said);
  const requiredHeld = coverage_run(summary_make(at), floors, ['--require', 'apps/argus']);
  expect_that('a required workspace with floors is judged as any other', requiredHeld.status === 0, requiredHeld.said);
  // What is jest's is not the ratchet's: an argument it does not know is refused, not read as a tree.
  const stray = spawnSync('node', [join(here, 'coverage-ratchet.mjs'), '--coverage'], { encoding: 'utf8' });
  expect_that('an argument that is not the check\'s own is refused', stray.status === 2 && `${stray.stderr}`.includes('unknown argument "--coverage"'), `${stray.stdout}${stray.stderr}`);
  let threw = '';
  try { args_read(['tests/unit/one.test.ts']); } catch (error) { threw = error.message; }
  expect_that('a test\'s path is not read as the tree', threw.includes('unknown argument'), threw);
  // Whole or a run of its own, from jest's own reading of the arguments: every spelling jest takes is taken the same way.
  const plan_of = async (args) => run_plan(await buildArgv(args), args, '/w/apps/argus', '/tmp/run-own');
  for (const args of [[], ['--coverage'], ['--runInBand', '--coverage'], ['--maxWorkers=2'], ['--maxWorkers', '2'], ['--max-workers=2'], ['-w', '4', '--ci', '--testTimeout=10000'], ['--test-timeout', '10000'], ['--passWithNoTests']]) {
    const plan = await plan_of(args);
    expect_that(`the whole suite is run and judged with ${JSON.stringify(args)}`, plan.whole && plan.jestArgs[1] === '--coverageDirectory=/tmp/run-own' && plan.jestArgs.includes('--coverageReporters=json-summary') && !plan.jestArgs.some((arg) => arg.includes(`/${SUITE_DIR}`)), JSON.stringify(plan));
  }
  for (const args of [['tests/unit/one.test.ts'], ['-t', 'one case'], ['--testNamePattern=one'], ['--test-name-pattern=one'], ['--testPathPatterns=image'], ['--test-path-patterns', 'image'], ['--onlyChanged'], ['-o'], ['--maxWorkers=2', 'image'], ['--shard=1/3'],
    ['--collectCoverageFrom=src/app/*.ts'], ['--coveragePathIgnorePatterns=src/features/image'], ['--coverageReporters=text'], ['--coverageDirectory=elsewhere'], ['--coverage=false'], ['--no-coverage'], ['--rootDir=/tmp']]) {
    const plan = await plan_of(args);
    const elsewhere = plan.jestArgs[1] === `--coverageDirectory=/w/apps/argus/${PARTIAL_DIR}` || args.some((arg) => arg.startsWith('--coverageDirectory'));
    expect_that(`a run of its own is not judged and does not write the suite's report with ${JSON.stringify(args)}`, !plan.whole && elsewhere && !plan.jestArgs.some((arg) => arg.endsWith(`/${SUITE_DIR}`)), JSON.stringify(plan));
  }
  {
    // After an end-of-options mark everything is a test's name: what the runner adds is before it, and stays an option.
    const marked = await plan_of(['--', 'tests/unit/imageStop.test.ts']);
    const reread = await buildArgv(marked.jestArgs);
    expect_that('with `--` among the arguments, the runner\'s own folder is still read by jest as the folder', !marked.whole && reread.coverageDirectory === `/w/apps/argus/${PARTIAL_DIR}` && JSON.stringify(reread._) === '["tests/unit/imageStop.test.ts"]', JSON.stringify(reread));
  }
  {
    // Two whole runs at once, one above the floors and one below: each is judged from the summary it wrote, whatever the shared file says.
    const tree = folder_make('coverage-two-runs');
    const good = join(tree, 'run-a/coverage-summary.json');
    const poor = join(tree, 'run-b/coverage-summary.json');
    file_put(good, JSON.stringify(summary_make(at)));
    file_put(poor, JSON.stringify(summary_make({ ...at, lines: 10 })));
    file_put(join(tree, 'baseline.json'), JSON.stringify({ coverage: { 'apps/argus': floors } }));
    const judge = (own, shared) => {
      // What stands in the shared folder is the other run's.
      file_put(join(tree, 'apps/argus/coverage/coverage-summary.json'), readFileSync(shared, 'utf8'));
      const ran = spawnSync('node', [join(here, 'coverage-ratchet.mjs'), '--root', tree, '--baseline', join(tree, 'baseline.json'), '--require', 'apps/argus', '--summary', `apps/argus=${own}`], { encoding: 'utf8' });
      return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
    };
    const passing = judge(good, poor);
    const falling = judge(poor, good);
    expect_that('a run above its floors passes though a failing report stands in the shared folder', passing.status === 0, passing.said);
    expect_that('a run below its floors fails though a passing report stands in the shared folder', falling.status !== 0 && falling.said.includes('lines coverage is 10%'), falling.said);
    let threw = '';
    try { args_read(['--summary', 'apps/argus']); } catch (error) { threw = error.message; }
    expect_that('--summary wants a workspace and a file', threw.includes('--summary wants <workspace>=<file>'), threw);
  }
  for (const args of [['--testPathPattern=image'], ['--some-flag-jest-does-not-know']]) {
    let refusedByJest = '';
    try { await buildArgv(args); } catch (error) { refusedByJest = String(error?.message ?? error); }
    expect_that(`arguments jest itself refuses are refused by jest, not read here: ${JSON.stringify(args)}`, refusedByJest !== '', refusedByJest.slice(0, 120));
  }
  {
    // A whole run's report is what the run left in its own folder: none there, none published, whatever stood before.
    const own = folder_make('coverage-run-own');
    const suite = folder_make('coverage-suite');
    file_put(join(suite, 'coverage-summary.json'), '{"an older report":true}');
    expect_that('a run that left no summary publishes nothing, and the report that stood is untouched', report_publish(own, suite) === false && readFileSync(join(suite, 'coverage-summary.json'), 'utf8') === '{"an older report":true}');
    file_put(join(own, 'coverage-summary.json'), '{"this run":true}');
    expect_that('a run that left one publishes it as the suite\'s', report_publish(own, suite) === true && readFileSync(join(suite, 'coverage-summary.json'), 'utf8') === '{"this run":true}');
  }
  threw = '';
  try { floors_read('{"casts":{}}', 'a file'); } catch (error) { threw = error.message; }
  expect_that('a baseline without the section has no floors, which is not the same as none to hold', threw.includes('no "coverage" section'), threw);
  threw = '';
  try { summary_read('{"total":{"lines":{"pct":"Unknown"}}}', 'a summary'); } catch (error) { threw = error.message; }
  expect_that('a summary without its totals is refused', threw.includes('has no lines total'), threw);
  const judged = coverage_judge('apps/argus', floors, at);
  expect_that('at its floors nothing is at fault', judged.falls.length === 0 && judged.rises.length === 0);
  // A workspace whose measure moves with the machine: the floor is the reference its gate measured, with
  // an allowance either side. The figures are argus's own: what CI measured and what a developer's machine did.
  const allowance = { below: 0.3, above: 0.7 };
  const reference = { lines: 60.8, statements: 58.7, branches: 50.4, functions: 55.5, allowance };
  const ciSaw = { lines: 60.81, statements: 58.71, branches: 50.48, functions: 55.57 };
  const deskSaw = [at, { lines: 60.92, statements: 58.84, branches: 50.78, functions: 55.69 }];
  const quiet = [ciSaw, ...deskSaw].map((saw) => coverage_run(summary_make(saw), reference));
  expect_that('what the gate measured and what a desk measured both pass against the gate\'s reference, and neither asks for a raise', quiet.every((run) => run.status === 0 && run.said.includes('at or above their floors')), quiet.map((run) => run.said).join(' | '));
  const kinds = (pcts) => pcts.map((pct) => measure_place(50.4, allowance, pct).kind).join(',');
  expect_that('below the reference: the allowance passes to its last tenth, and one tenth more falls', kinds([50.1, 50.19, 50.09, 50.0]) === 'pass,pass,fall,fall' && measure_place(50.4, allowance, 50.09).least === 50.1, kinds([50.1, 50.19, 50.09, 50.0]));
  expect_that('above the reference: the allowance passes to its last tenth, and one tenth more is a rise to the measure less the allowance below', kinds([51.1, 51.19, 51.2]) === 'pass,pass,rise' && measure_place(50.4, allowance, 51.2).to === 50.9, JSON.stringify(measure_place(50.4, allowance, 51.2)));
  expect_that('without an allowance a floor is exact: under it falls, a tenth over it rises to the measure', measure_place(50.7, undefined, 50.69).kind === 'fall' && measure_place(50.7, undefined, 50.79).kind === 'pass' && measure_place(50.7, undefined, 50.8).to === 50.8);
  const under = coverage_run(summary_make({ ...ciSaw, branches: 50.09 }), reference);
  expect_that('a fall past the allowance fails, and says the least that passes', under.status !== 0 && under.said.includes('branches coverage is 50.09%, below its floor of 50.1% (reference 50.4%, less the 0.3 allowed for the machine)'), under.said);
  const gained = { ...ciSaw, branches: 53.27 };
  const asksRaise = coverage_run(summary_make(gained), reference);
  expect_that('a rise past the allowance fails until raised, and says what to', asksRaise.status !== 0 && asksRaise.said.includes('branches coverage rose to 53.27%') && asksRaise.said.includes('Raise the floor to 52.9'), asksRaise.said);
  const lifted = coverage_run(summary_make(gained), reference, ['--raise']);
  const liftedFloors = lifted.baseline.coverage['apps/argus'];
  expect_that('--raise writes that rise and nothing else: the other references and the allowance are as they were', lifted.status === 0 && JSON.stringify(liftedFloors) === JSON.stringify({ ...reference, branches: 52.9 }), JSON.stringify(liftedFloors));
  const recheck = coverage_run(summary_make(gained), liftedFloors);
  const slower = coverage_run(summary_make({ ...gained, branches: 53.03 }), liftedFloors);
  expect_that('after the raise the same measure passes with nothing more to raise, and so does one taken a quarter point lower', recheck.status === 0 && slower.status === 0, `${recheck.said} | ${slower.said}`);
  const noRaise = coverage_run(summary_make(deskSaw[1]), reference, ['--raise']);
  expect_that('--raise within the allowance raises nothing', noRaise.status === 0 && JSON.stringify(noRaise.baseline.coverage['apps/argus']) === JSON.stringify(reference), JSON.stringify(noRaise.baseline));
  threw = '';
  try { floors_read(JSON.stringify({ coverage: { 'apps/argus': { ...floors, allowance: { below: 0.3 } } } }), 'a baseline'); } catch (error) { threw = error.message; }
  // The allowance is part of the floor: with the reference unchanged, widening it below lowers what passes,
  // and widening it above puts off a raise. Against the base neither may widen; a new workspace sets its own.
  const widerBelow = floors_compare({ 'apps/argus': { ...reference, allowance: { below: 0.8, above: 0.7 } } }, { 'apps/argus': reference });
  const widerAbove = floors_compare({ 'apps/argus': { ...reference, allowance: { below: 0.3, above: 1.5 } } }, { 'apps/argus': reference });
  const fromNone = floors_compare({ 'apps/argus': reference }, { 'apps/argus': floors });
  const narrower = floors_compare({ 'apps/argus': { ...reference, allowance: { below: 0.1, above: 0.7 } }, 'apps/new': reference }, { 'apps/argus': reference });
  expect_that('an allowance widened below against the base fails, the reference unchanged', widerBelow.length === 1 && widerBelow[0].includes('allowance below was widened from 0.3 to 0.8'), widerBelow.join('; '));
  expect_that('an allowance widened above against the base fails, the reference unchanged', widerAbove.length === 1 && widerAbove[0].includes('allowance above was widened from 0.7 to 1.5'), widerAbove.join('; '));
  expect_that('a workspace the base held with no allowance may not gain one: none is an allowance of nothing', fromNone.filter((line) => line.includes('allowance')).length === 2, fromNone.join('; '));
  expect_that('an allowance narrowed passes, and a workspace new to the base sets its own', narrower.length === 0, narrower.join('; '));
  threw = '';
  try { floors_read(JSON.stringify({ coverage: { 'apps/argus': { ...reference, allowance: { below: 0.3, above: 0.1 } } } }), 'a baseline'); } catch (error) { threw = error.message; }
  expect_that('an allowance with more below than above is refused: its raise would not raise', threw.includes('allows more below (0.3) than above (0.1)'), threw);
  threw = '';
  try { floors_read(JSON.stringify({ coverage: { 'apps/argus': { ...reference, branches: 50.44 } } }), 'a baseline'); } catch (error) { threw = error.message; }
  expect_that('a reference with an allowance is written to one decimal', threw.includes('must be written to one decimal (50.44)'), threw);
  // Every raise the rule can ask for raises, and the same measure then passes: over each allowance that
  // may be written, and each measure a tenth apart.
  let unsettled = '';
  for (const below of [0, 0.1, 0.3]) for (const above of [below, below + 0.4, 1]) for (let tenth = 480; tenth <= 530; tenth++) {
    const placed = measure_place(50.4, { below, above }, tenth / 10 + 0.05);
    if (placed.kind !== 'rise') continue;
    if (!(placed.to > 50.4) || measure_place(placed.to, { below, above }, tenth / 10 + 0.05).kind !== 'pass') unsettled = `${below}/${above} at ${tenth / 10}: to ${placed.to}`;
  }
  expect_that('every raise asked for is higher than the floor it replaces, and the same measure then passes', unsettled === '', unsettled);
  // Without an allowance nothing is rounded before the comparison, as before there were allowances.
  const exact = { ...floors, branches: 50.04 };
  const justUnder = coverage_run(summary_make({ ...at, branches: 50.02 }), exact);
  const justOver = coverage_run(summary_make({ ...at, branches: 50.05 }), exact);
  expect_that('with no allowance a floor written to hundredths holds to hundredths: 50.02 falls under 50.04, 50.05 passes', justUnder.status !== 0 && justUnder.said.includes('branches coverage is 50.02%, below its floor of 50.04%') && justOver.status === 0, `${justUnder.said} | ${justOver.said}`);
  threw = '';
  try { floors_read(JSON.stringify({ coverage: { 'apps/argus': { ...floors, allowance: { below: 0.3 } } } }), 'a baseline'); } catch (error) { threw = error.message; }
  expect_that('an allowance must say both sides', threw.includes('allowance above of apps/argus is not a number of points'), threw);
  // The files no test reaches are named when coverage falls.
  const withFiles = summary_make({ ...at, lines: 55 }, {
    '/tree/apps/argus/src/tested.ts': { lines: { total: 10, covered: 10, pct: 100 } },
    '/tree/apps/argus/src/orphan.ts': { lines: { total: 12, covered: 0, pct: 0 } },
    '/tree/apps/argus/src/types.ts': { lines: { total: 0, covered: 0, pct: 100 } },
  });
  expect_that('the files in which no line is covered are listed, and a file with no lines is not one', JSON.stringify(uncovered_list(JSON.stringify(withFiles), '/tree/apps/argus')) === '["src/orphan.ts"]');
  // The floors against the base: they may rise, and may not fall or be dropped.
  const base = { 'apps/argus': floors };
  expect_that('floors equal to or above the base hold', floors_compare({ 'apps/argus': { ...floors, lines: 70 }, 'apps/porter': floors }, base).length === 0);
  const lowered = floors_compare({ 'apps/argus': { ...floors, functions: 50 } }, base);
  expect_that('a floor lowered against the base fails', lowered.length === 1 && lowered[0].includes('functions floor was lowered from 55.6 to 50'), lowered.join('; '));
  const dropped = floors_compare({}, base);
  expect_that('a workspace whose floors were removed fails', dropped.length === 1 && dropped[0].includes('were removed'), dropped.join('; '));

  // The runner itself, in a repository made here: jest, then the ratchet, by the script as a workspace's `test` runs it.
  {
    const made = folder_make('coverage-runner');
    const git = (...args) => execFileSync('git', args, { cwd: made, encoding: 'utf8' }).trim();
    symlinkSync(join(repo, 'node_modules'), join(made, 'node_modules'), 'dir');
    mkdirSync(join(made, 'scripts/lib'), { recursive: true });
    for (const file of ['jest-with-floor.mjs', 'coverage-ratchet.mjs', 'lib/ratchetBase.mjs']) copyFileSync(join(here, file), join(made, 'scripts', file));
    file_put(join(made, 'package.json'), JSON.stringify({ name: 'coverage-runner-tree', private: true }));
    file_put(join(made, '.gitignore'), 'node_modules\ncoverage/\ncoverage-partial/\nelsewhere/\n');
    file_put(join(made, 'apps/argus/jest.config.cjs'), `module.exports = { testEnvironment: 'node', roots: ['<rootDir>/tests', '<rootDir>/src'], collectCoverageFrom: ['src/**/*.js'], coverageProvider: 'babel', coverageReporters: ['json-summary', 'text-summary'], transform: {} };\n`);
    file_put(join(made, 'apps/argus/src/kept.js'), 'module.exports = { twice: (n) => n * 2 };\n');
    file_put(join(made, 'apps/argus/src/other.js'), 'module.exports = { thrice: (n) => n * 3 };\n');
    file_put(join(made, 'apps/argus/tests/kept.test.js'), "const { twice } = require('../src/kept.js');\ntest('twice', () => { expect(twice(2)).toBe(4); });\n");
    file_put(join(made, 'apps/argus/tests/other.test.js'), "const { thrice } = require('../src/other.js');\ntest('thrice', () => { expect(thrice(2)).toBe(6); });\n");
    file_put(join(made, 'scripts/ratchet-baseline.json'), JSON.stringify({ coverage: { 'apps/argus': { lines: 100, statements: 100, branches: 100, functions: 100 } } }));
    git('init', '-q');
    git('config', 'user.email', 'ratchets@test');
    git('config', 'user.name', 'ratchets test');
    git('add', '.');
    git('commit', '-q', '-m', 'a workspace with floors');
    const sha = git('rev-parse', 'HEAD');
    const runner = (...args) => {
      const ran = spawnSync('node', [join(made, 'scripts/jest-with-floor.mjs'), ...args], { cwd: join(made, 'apps/argus'), encoding: 'utf8', env: { ...process.env, RATCHET_BASE: sha, CI: '' } });
      return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
    };
    const summaryPath = join(made, 'apps/argus/coverage/coverage-summary.json');
    const whole = runner();
    expect_that('the runner runs the whole suite and the floors hold', whole.status === 0 && whole.said.includes('at or above their floors'), whole.said.slice(-500));
    const limited = runner('--maxWorkers=2');
    expect_that('a worker limit leaves the suite whole: the floors are judged', limited.status === 0 && limited.said.includes('at or above their floors'), limited.said.slice(-500));
    const full = readFileSync(summaryPath, 'utf8');
    // A filtered run, in jest's dashed spelling: it covers half the sources.
    const filtered = runner('--test-name-pattern=twice');
    expect_that('a filtered run is not judged, and says so', filtered.status === 0 && filtered.said.includes('not checked') && !filtered.said.includes('at or above'), filtered.said.slice(-500));
    expect_that('and it leaves the suite\'s report as it was, writing its own beside it', readFileSync(summaryPath, 'utf8') === full && JSON.parse(readFileSync(join(made, 'apps/argus/coverage-partial/coverage-summary.json'), 'utf8')).total.functions.pct < 100);
    // A run that reports as text only, or somewhere else, writes no report of the suite's: the old one is not judged for it.
    const textOnly = runner('--coverageReporters=text');
    expect_that('a run that writes no JSON report is not passed on an older one', textOnly.status === 0 && textOnly.said.includes('not checked') && !textOnly.said.includes('at or above') && readFileSync(summaryPath, 'utf8') === full, textOnly.said.slice(-500));
    const moved = runner('--coverageDirectory=elsewhere');
    expect_that('nor is a run that writes its report somewhere else', moved.status === 0 && moved.said.includes('not checked') && !moved.said.includes('at or above') && readFileSync(summaryPath, 'utf8') === full, moved.said.slice(-500));
    // The end-of-options form, and the folder spelt as jest's own placeholder: the suite's report is untouched by both.
    const marked = runner('--', 'tests/kept.test.js');
    expect_that('a run that names a test after `--` is not judged and leaves the suite\'s report byte-for-byte', marked.status === 0 && marked.said.includes('not checked') && readFileSync(summaryPath, 'utf8') === full, marked.said.slice(-500));
    const placed = runner('-t', 'twice', '--coverageDirectory=<rootDir>/coverage');
    expect_that('a filtered run pointed at the suite\'s folder by <rootDir> is refused', placed.status === 2 && readFileSync(summaryPath, 'utf8') === full, placed.said.slice(-400));
    // A jest that ends well and writes no summary: the run fails, though a passing report was written just before.
    file_put(join(made, 'silent-jest.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(made, 'silent-jest.sh'), 0o755);
    file_put(summaryPath, full);
    const silentRan = spawnSync('node', [join(made, 'scripts/jest-with-floor.mjs')], { cwd: join(made, 'apps/argus'), encoding: 'utf8', env: { ...process.env, RATCHET_BASE: sha, JEST_WITH_FLOOR_JEST: join(made, 'silent-jest.sh') } });
    const silentSaid = `${silentRan.stdout}${silentRan.stderr}`;
    expect_that('a jest that ends well and writes no summary fails the run, though a passing report was written a moment before', silentRan.status === 1 && silentSaid.includes('wrote no coverage summary') && !silentSaid.includes('at or above') && readFileSync(summaryPath, 'utf8') === full, silentSaid.slice(-400));
    // A config whose root is the tests folder, and a folder given relative to it: by the workspace it reads as
    // somewhere else, and jest writes it to the suite's folder. The report is put back, and the run fails.
    file_put(join(made, 'apps/argus/tests/jest.rooted.cjs'), `module.exports = { rootDir: __dirname, testEnvironment: 'node', roots: ['<rootDir>', '<rootDir>/../src'], collectCoverageFrom: ['../src/**/*.js'], coverageProvider: 'babel', coverageReporters: ['json-summary'], transform: {} };\n`);
    file_put(summaryPath, full);
    const rooted = runner('--config', 'tests/jest.rooted.cjs', '-t', 'twice', '--coverageDirectory=../coverage');
    expect_that('a partial run that would land on the suite\'s folder through its config\'s root is refused before jest runs, and the full summary is byte-for-byte', rooted.status === 2 && rooted.said.includes('jest would write its coverage there') && readFileSync(summaryPath, 'utf8') === full, rooted.said.slice(-500));
    // Where jest will write is asked of jest: the same folder, by every road to it.
    const argusDir = join(made, 'apps/argus');
    expect_that('the effective folder is jest\'s own answer', (await coverageDir_effective(['--coverage', '-t', 'twice', '--coverageDirectory=<rootDir>/coverage'], argusDir)) === path_physical(join(argusDir, 'coverage'))
      && (await coverageDir_effective(['--coverage', '--config', join(argusDir, 'tests/jest.rooted.cjs'), '-t', 'twice', '--coverageDirectory=../coverage'], argusDir)) === path_physical(join(argusDir, 'coverage'))
      && (await coverageDir_effective(['--coverage', `--coverageDirectory=${join(argusDir, 'coverage-partial')}`, '--', 'tests/kept.test.js'], argusDir)) === path_physical(join(argusDir, 'coverage-partial')));
    // By a link, and by a project named from elsewhere: the same folder on disk, and refused the same.
    mkdirSync(join(made, 'links'), { recursive: true });
    symlinkSync(argusDir, join(made, 'links/argus'), 'dir');
    expect_that('a path through a link is the folder it leads to', path_physical(join(made, 'links/argus/coverage')) === path_physical(join(argusDir, 'coverage')) && path_physical(join(made, 'links/argus/not-there-yet/deeper')) === join(path_physical(argusDir), 'not-there-yet/deeper'));
    file_put(summaryPath, full);
    const linked = runner('-t', 'twice', '--coverageDirectory=../../links/argus/coverage');
    expect_that('a filtered run aimed at the suite\'s folder through a link is refused before jest runs, and the full summary is byte-for-byte', linked.status === 2 && linked.said.includes('jest would write its coverage there') && readFileSync(summaryPath, 'utf8') === full, linked.said.slice(-400));
    file_put(join(made, 'jest.config.cjs'), `module.exports = { testEnvironment: 'node', roots: ['<rootDir>/apps/argus/tests', '<rootDir>/apps/argus/src'], collectCoverageFrom: ['apps/argus/src/**/*.js'], coverageProvider: 'babel', coverageReporters: ['json-summary'], transform: {} };\n`);
    const projected = runner('--projects', '../..', '-t', 'twice', '--coverageDirectory=apps/argus/coverage');
    expect_that('a filtered run that names the repository as its project and the suite\'s folder from there is refused before jest runs, and the full summary is byte-for-byte', projected.status === 2 && projected.said.includes('jest would write its coverage there') && readFileSync(summaryPath, 'utf8') === full, projected.said.slice(-400));
    // A filtered run held while a whole run publishes: the filtered run ends well and the new full report stands,
    // whether or not there was a report when the filtered run began.
    for (const startsWith of ['a report', 'no report']) {
      const { rmSync } = await import('node:fs');
      if (startsWith === 'no report') rmSync(summaryPath, { force: true }); else file_put(summaryPath, '{"an older full report":true}');
      file_put(join(made, 'slow-jest.sh'), `#!/bin/sh\n# A filtered jest that takes its time: the whole run publishes while it is under way.\nsleep 1\nexit 0\n`);
      chmodSync(join(made, 'slow-jest.sh'), 0o755);
      const { spawn } = await import('node:child_process');
      const filteredRun = spawn('node', [join(made, 'scripts/jest-with-floor.mjs'), '-t', 'twice'], { cwd: argusDir, env: { ...process.env, RATCHET_BASE: sha, JEST_WITH_FLOOR_JEST: join(made, 'slow-jest.sh') }, stdio: 'ignore' });
      const filteredDone = new Promise((resolve) => { filteredRun.on('exit', (code) => resolve(code)); });
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      // Meanwhile a whole run publishes a new full report.
      file_put(summaryPath, full);
      const code = await filteredDone;
      expect_that(`a filtered run under way while a whole run publishes ends well and leaves the new full report, having begun with ${startsWith}`, code === 0 && readFileSync(summaryPath, 'utf8') === full, String(code));
    }
    file_put(summaryPath, full);
    const over = runner('-t', 'twice', '--coverageDirectory=coverage');
    expect_that('a filtered run pointed at the suite\'s report is refused before jest runs', over.status === 2 && over.said.includes('may not write to the suite\'s folder') && readFileSync(summaryPath, 'utf8') === full, over.said.slice(-400));
    // With a test taken away the whole run falls below its floors, and fails.
    file_put(join(made, 'apps/argus/tests/other.test.js'), "test('nothing of the other', () => { expect(1).toBe(1); });\n");
    const fallen = runner();
    expect_that('a whole run below its floors fails, naming the file no test reaches', fallen.status !== 0 && fallen.said.includes('below its floor of 100%') && fallen.said.includes('src/other.js'), fallen.said.slice(-600));
  }

  // The floors against a base in git, in a repository made here, with the tree named by --root: the
  // comparison is decided by which baseline file is read, not by how the tree was named.
  {
    const made = folder_make('coverage-base');
    const git = (...args) => execFileSync('git', args, { cwd: made, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'ratchets@test');
    git('config', 'user.name', 'ratchets test');
    const high = { lines: 60, statements: 60, branches: 60, functions: 60 };
    file_put(join(made, 'scripts/ratchet-baseline.json'), JSON.stringify({ coverage: { 'apps/argus': high } }));
    git('add', '.');
    git('commit', '-q', '-m', 'floors');
    const baseSha = git('rev-parse', 'HEAD');
    // The working file's floors are lowered beside a measure that fell.
    const low = { lines: 50, statements: 50, branches: 50, functions: 50 };
    const lowText = JSON.stringify({ coverage: { 'apps/argus': low } });
    file_put(join(made, 'scripts/ratchet-baseline.json'), lowText);
    file_put(join(made, 'apps/argus/coverage/coverage-summary.json'), JSON.stringify(summary_make({ lines: 55.5, statements: 55.5, branches: 55.5, functions: 55.5 })));
    const cli = (extra) => {
      const ran = spawnSync('node', [join(here, 'coverage-ratchet.mjs'), '--root', made, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH, RATCHET_BASE: baseSha } });
      return { status: ran.status, said: `${ran.stdout}${ran.stderr}`, text: readFileSync(join(made, 'scripts/ratchet-baseline.json'), 'utf8') };
    };
    const checked = cli([]);
    expect_that('with --root naming a checkout, floors lowered against its base fail the check', checked.status !== 0 && checked.said.includes('lines floor was lowered from 60 to 50'), checked.said);
    const raisedThere = cli(['--raise']);
    expect_that('and --raise fails too when what it would write is still below the base, leaving the file as it was', raisedThere.status !== 0 && raisedThere.text === lowText && raisedThere.said.includes('lowered from 60 to 55.5'), raisedThere.said);
    file_put(join(made, 'apps/argus/coverage/coverage-summary.json'), JSON.stringify(summary_make({ lines: 61.2, statements: 60, branches: 60, functions: 60 })));
    const recovered = cli(['--raise']);
    expect_that('a measure back at or above the base is raised to', recovered.status === 0 && JSON.parse(recovered.text).coverage['apps/argus'].lines === 61.2 && JSON.parse(recovered.text).coverage['apps/argus'].branches === 60, recovered.said);
  }

  // Argus's own jest config, over a tree made here: a source file no test imports is found and counted.
  // (Take `src` out of its roots and this goes red: the file is then never seen.)
  {
    const made = folder_make('coverage-argus-config');
    symlinkSync(join(repo, 'node_modules'), join(made, 'node_modules'), 'dir');
    file_put(join(made, 'package.json'), JSON.stringify({ name: 'coverage-argus-config-tree', private: true, type: 'module' }));
    file_put(join(made, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, esModuleInterop: true, isolatedModules: true } }));
    file_put(join(made, 'src/kept.ts'), 'export function twice(n: number): number {\n  return n * 2;\n}\n');
    file_put(join(made, 'src/orphan.ts'), 'export function thrice(n: number): number {\n  const three: number = 3;\n  return n * three;\n}\n');
    file_put(join(made, 'tests/unit/kept.test.ts'), "import { twice } from '../../src/kept.js';\n\ntest('twice', () => { expect(twice(2)).toBe(4); });\n");
    const ran = spawnSync(join(repo, 'node_modules/.bin/jest'), ['--config', join(repo, 'apps/argus/jest.config.cjs'), '--rootDir', made, '--coverage', '--coverageDirectory', join(made, 'coverage'), '--silent'],
      { cwd: made, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules --disable-warning=ExperimentalWarning' } });
    let listed = [];
    let bare = [];
    try {
      const text = readFileSync(join(made, 'coverage/coverage-summary.json'), 'utf8');
      listed = Object.keys(JSON.parse(text)).filter((file) => file !== 'total').map((file) => file.slice(made.length + 1)).sort();
      bare = uncovered_list(text, made);
    } catch { /* said below */ }
    expect_that('under argus\'s own jest config a source no test imports is in the report, with no line covered', ran.status === 0 && JSON.stringify(listed) === '["src/kept.ts","src/orphan.ts"]' && JSON.stringify(bare) === '["src/orphan.ts"]', `${JSON.stringify(listed)} ${ran.stdout}${ran.stderr}`.slice(0, 600));
  }

  // With jest itself: a file that loses its only test stays in the measure, at nothing, and is named.
  const tree = folder_make('coverage-jest');
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'dir');
  file_put(join(tree, 'package.json'), JSON.stringify({ name: 'coverage-jest-tree', private: true }));
  file_put(join(tree, 'apps/argus/jest.config.cjs'), `module.exports = { testEnvironment: 'node', roots: ['<rootDir>/tests', '<rootDir>/src'], collectCoverageFrom: ['src/**/*.js'], coverageProvider: 'babel', coverageReporters: ['json-summary'], transform: {} };\n`);
  file_put(join(tree, 'apps/argus/src/kept.js'), 'module.exports = { twice: (n) => n * 2 };\n');
  file_put(join(tree, 'apps/argus/src/orphan.js'), 'module.exports = { thrice: (n) => {\n  const three = 3;\n  return n * three;\n} };\n');
  file_put(join(tree, 'apps/argus/tests/kept.test.js'), "const { twice } = require('../src/kept.js');\ntest('twice', () => { expect(twice(2)).toBe(4); });\n");
  const orphanTest = join(tree, 'apps/argus/tests/orphan.test.js');
  file_put(orphanTest, "const { thrice } = require('../src/orphan.js');\ntest('thrice', () => { expect(thrice(2)).toBe(6); });\n");
  file_put(join(tree, 'baseline.json'), JSON.stringify({ coverage: { 'apps/argus': { lines: 0, statements: 0, branches: 0, functions: 0 } } }));
  const jest_run = () => spawnSync(join(repo, 'node_modules/.bin/jest'), ['--coverage', '--silent'], { cwd: join(tree, 'apps/argus'), encoding: 'utf8' });
  const ratchet_here = (extra = []) => {
    const ran = spawnSync('node', [join(here, 'coverage-ratchet.mjs'), '--root', tree, '--baseline', join(tree, 'baseline.json'), '--require', 'apps/argus', ...extra], { encoding: 'utf8' });
    return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
  };
  const both = jest_run();
  expect_that('jest runs the made tree with both tests', both.status === 0, `${both.stdout}${both.stderr}`.slice(0, 400));
  const set = ratchet_here(['--raise']);
  expect_that('with both files tested the floors are set from what jest measured', set.status === 0 && JSON.parse(readFileSync(join(tree, 'baseline.json'), 'utf8')).coverage['apps/argus'].lines === 100, set.said);
  // The test of one file is taken away (written over with one that reaches nothing of it).
  file_put(orphanTest, "test('nothing of the orphan', () => { expect(1).toBe(1); });\n");
  const one = jest_run();
  const summaryNow = readFileSync(join(tree, 'apps/argus/coverage/coverage-summary.json'), 'utf8');
  expect_that('a file that lost its only test is still in jest\'s summary, with no line covered', one.status === 0 && Object.keys(JSON.parse(summaryNow)).some((file) => file.endsWith('src/orphan.js')) && uncovered_list(summaryNow, join(tree, 'apps/argus')).includes('src/orphan.js'), summaryNow.slice(0, 300));
  const caught = ratchet_here();
  expect_that('and the ratchet fails, naming the measure and the file', caught.status !== 0 && caught.said.includes('lines coverage is') && caught.said.includes('below its floor of 100%') && caught.said.includes('src/orphan.js'), caught.said);
  // The test comes back: the floors hold again.
  file_put(orphanTest, "const { thrice } = require('../src/orphan.js');\ntest('thrice', () => { expect(thrice(2)).toBe(6); });\n");
  const again = jest_run();
  const back = ratchet_here();
  expect_that('with the test back the floors hold', again.status === 0 && back.status === 0, back.said);
}

// --- the line-builder lint: a value in a line is written by a quoting function ---
{
  const { lines_check, part_judge, template_read } = await import('./line-builders.mjs');
  const tree = join(run, 'lines');
  const source = join(tree, 'apps/argus/src/app/site.ts');
  const checked = (text, grammar = {}) => { file_put(source, text); return lines_check(tree, grammar); };
  const clean = checked("context.terminal.line_run(`cd ${path_quote(place)}`);\nclient.line_execute(`setfattr -n tag -v ${arg_quote(tag)} feed_${id}`, { silent: true });\nvoid verb_send(`gather add ${paths.map(arg_quote).join(' ')}`);\nhooks.verbLine_run(id, `kill %${n}`);\n");
  expect_that('a line whose values are written by the quoting functions passes: a call, a list mapped through one, and parts of a word', clean.length === 0, clean.join(' | '));
  const double = checked('context.terminal.line_run(`cd "${place}"`);\n');
  const single = checked("context.terminal.line_run(`touch --withContents '${text}' x`);\n");
  expect_that('a value between quotes written by hand fails, double or single', double.length === 1 && double[0].includes('site.ts:1') && double[0].includes('between quotes written by hand') && single.length === 1 && single[0].includes('${text}'), [...double, ...single].join(' | '));
  const bare = checked('lead();\nhooks.verbLine_run(id, `rm ${path}`);\nvoid client.line_execute(`proc jump --where ${asked}`, { silent: true });\nthis.hooks.ask(`play --text=${text}`);\n');
  expect_that('a bare value that is a whole word of a line fails, after a space or an equals sign, and names its line', bare.length === 3 && bare[0].includes('site.ts:2') && bare[0].includes('${path}') && bare[1].includes('${asked}') && bare[2].includes('${text}'), bare.join(' | '));
  const named = checked('this.hooks.ask(`vm cost ${name}`);\n', { 'apps/argus/src/app/site.ts': ['name'] });
  expect_that('a whole word named as grammar that is meant passes', named.length === 0, named.join(' | '));
  const stale = checked('this.hooks.ask(`vm cost ${word_write(name)}`);\n', { 'apps/argus/src/app/site.ts': ['name'] });
  expect_that('a name in the grammar list that no line holds any more fails: the list cannot outlive what it lists', stale.length === 1 && stale[0].includes('names ${name}') && stale[0].includes('remove it'), stale.join(' | '));
  const branched = checked("await this.hooks.ask(family === '' ? 'capacity' : `capacity ${family}`);\nclient.line_execute(wide ? `vm status ${word_write(name)}` : `vm \"${name}\"`, { silent: true, note: `said ${anything}` });\n");
  expect_that('a line chosen by a condition is checked in both branches, and an options object after it is not a line', branched.length === 2 && branched[0].includes('site.ts:1') && branched[0].includes('${family}') && branched[1].includes('site.ts:2') && branched[1].includes('between quotes written by hand'), branched.join(' | '));
  const nested = template_read('`a ${f(`b ${c}`)} d ${e}`', 0);
  expect_that('a template inside an interpolation is read through, and each interpolation knows what stands on either side', nested !== null && nested.parts.length === 2 && nested.parts[0].expr === 'f(`b ${c}`)' && nested.parts[0].before === 'a ' && nested.parts[0].after === ' d ' && nested.parts[1].expr === 'e' && nested.parts[1].after === '', JSON.stringify(nested));
  expect_that('an interpolation is judged by what stands around it', part_judge({ expr: 'x', before: 'feed_', after: '' }) === 'part' && part_judge({ expr: 'x', before: 'rm ', after: '' }) === 'whole' && part_judge({ expr: 'x', before: 'cd "', after: '"' }) === 'quoted' && part_judge({ expr: 'path_write(x)', before: 'ls ', after: '' }) === 'written');
  const real = spawnSync('node', [join(here, 'line-builders.mjs')], { encoding: 'utf8' });
  expect_that('the repository as it stands passes the line-builder lint', real.status === 0, `${real.stdout}${real.stderr}`.slice(-400));
}

// --- the chili ratchet, and the packed entry points ---
{
  const { chili_count, chili_judge, chiliRefs_read } = await import('./chili-ratchet.mjs');
  const { entries_check, exportTargets_list, pinned_check, PINNED } = await import('./pack-entries.mjs');
  const tree = join(run, 'chili');
  file_put(join(tree, 'packages/brasa/src/a.ts'), "import { x } from '@fnndsc/chili/utils/cli.js';\nimport type { Y } from '@fnndsc/chili/models/feed.js';\nconst z = await import('@fnndsc/chili/run.js');\n");
  file_put(join(tree, 'packages/brasa/src/b.ts'), "export { q } from '@fnndsc/chili';\n// a comment naming @fnndsc/chili is not an import\n");
  file_put(join(tree, 'packages/brasa/scripts/words.mjs'), "import { run } from '@fnndsc/chili/run.js';\n");
  file_put(join(tree, 'packages/chili/src/own.ts'), "import { self } from '@fnndsc/chili/x.js';\n");
  file_put(join(tree, 'packages/calypso/src/clean.ts'), "const names = ['@fnndsc/chili'];\n// import { old } from '@fnndsc/chili/old.js';\n/* const gone = require('@fnndsc/chili/gone.js');\n   import('@fnndsc/chili/run.js'); */\n");
  file_put(join(tree, 'packages/brasa/src/c.ts'), "const lazy = require('@fnndsc/chili/screen/screen.js');\n  // import { was } from '@fnndsc/chili/was.js';\n");
  const counted = chili_count(tree);
  expect_that('brasa\'s imports of chili are counted, typed, dynamic and re-exported alike, in its sources and its scripts; chili\'s own and a mere mention are not', counted.files === 4 && counted.sites === 6 && counted.outside.length === 0, JSON.stringify(counted));
  expect_that('a commented import, a trailing comment that shows one, a string that holds one and a doc example are no references', chiliRefs_read("// import a from '@fnndsc/chili';\n/* require('@fnndsc/chili') */\nconst n = 1; // import x from '@fnndsc/chili/x.js'\nconst shown = \"import { y } from '@fnndsc/chili/y.js'\";\nconst tpl = `require('@fnndsc/chili')`;\n/** @example import z from '@fnndsc/chili/z.js' */\nexport const one = 1;\n").length === 0);
  expect_that('an import, a type import, a re-export, a dynamic import and a require are each one', chiliRefs_read("import a from '@fnndsc/chili';\nimport type { B } from '@fnndsc/chili/b.js';\nexport { c } from '@fnndsc/chili/c.js';\nconst d = await import('@fnndsc/chili/d.js');\nconst e = require('@fnndsc/chili/e.js');\nimport f from '@fnndsc/chilix';\n").length === 5);
  file_put(join(tree, 'packages/brasa/scripts/old.cjs'), "const lazy = require('@fnndsc/chili/run.js'); // and not: require('@fnndsc/chili/never.js')\n");
  const withCjs = chili_count(tree);
  // A tree of its own (this test deletes nothing): a hand-written declaration file that type-imports chili.
  const declared = join(run, 'chili-declared');
  file_put(join(declared, 'packages/menu/src/shim.d.ts'), "import type { Listing } from '@fnndsc/chili/models/listing.js';\ndeclare module 'x' { export const l: Listing; }\n");
  file_put(join(declared, 'packages/menu/dist/built.d.ts'), "import type { Listing } from '@fnndsc/chili/models/listing.js';\n");
  const typed = chili_count(declared);
  expect_that('a hand-written declaration file under another workspace\'s src that type-imports chili fails by file; a built one in dist is not read', typed.outside.length === 1 && typed.outside[0] === 'packages/menu/src/shim.d.ts', JSON.stringify(typed.outside));
  expect_that('a .cjs script with a literal require counts as one', withCjs.files === counted.files + 1 && withCjs.sites === counted.sites + 1, JSON.stringify(withCjs));
  expect_that('at the baseline the ratchet passes', chili_judge(withCjs, { files: 5, sites: 7 }).faults.length === 0);
  const more = chili_judge({ ...withCjs, sites: 8 }, { files: 5, sites: 7 }).faults;
  expect_that('one more import in brasa fails', more.length === 1 && more[0].includes('8 imports of @fnndsc/chili, its baseline is 7'), more.join(' | '));
  const fewer = chili_judge({ files: 2, sites: 4, outside: [] }, { files: 5, sites: 7 }).faults;
  expect_that('fewer fails until the baseline is lowered, and says how', fewer.length === 1 && fewer[0].includes('fell to 2 file(s), 4 import(s)') && fewer[0].includes('--lower'), fewer.join(' | '));
  file_put(join(tree, 'packages/calypso/src/reach.ts'), "import { table_render } from '@fnndsc/chili/screen/screen.js';\n");
  file_put(join(tree, 'packages/chell/scripts/bundle.mjs'), "import { run } from '@fnndsc/chili/run.js';\n");
  const reached = chili_judge(chili_count(tree), { files: 5, sites: 7 }).faults;
  expect_that('an import of chili from another workspace fails outright, naming the file: in its sources, and in its scripts', reached.length === 2 && reached.some((line) => line.includes('packages/calypso/src/reach.ts imports @fnndsc/chili')) && reached.some((line) => line.includes('packages/chell/scripts/bundle.mjs imports @fnndsc/chili')), reached.join(' | '));
  // Against the base, in the fixture repository: a baseline raised beside the import it admits fails.
  /** Runs the chili ratchet over the fixture repository with so many imports in brasa, a baseline, and a base. */
  const chili_run = (imports, baseline, base, args = []) => {
    file_put(join(clone, 'packages/brasa/src/uses.ts'), "import { a } from '@fnndsc/chili/a.js';\n".repeat(imports));
    file_put(join(clone, BASELINE), JSON.stringify({ casts: { 'packages/cumin': 2 }, chili: baseline }));
    // The repository's own script, pointed at the fixture (it reads sources with the compiler, which the fixture does not hold).
    const ran = spawnSync(process.execPath, [join(here, 'chili-ratchet.mjs'), '--root', clone, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...base } });
    return { status: ran.status, said: `${ran.stdout}${ran.stderr}`, kept: JSON.parse(readFileSync(join(clone, BASELINE), 'utf8')).chili };
  };
  const first = chili_run(2, { files: 1, sites: 2 }, { RATCHET_BASE: withBaseline });
  expect_that('a base from before the chili ratchet has nothing to compare with: the first baseline stands', first.status === 0, first.said);
  // A later commit, here on the working branch, is the base from then on: its baseline has a chili section.
  file_put(join(clone, BASELINE), JSON.stringify({ casts: { 'packages/cumin': 2 }, chili: { files: 1, sites: 2 } }));
  const chiliBase = commit('a baseline with a chili section');
  const level2 = chili_run(2, { files: 1, sites: 2 }, { RATCHET_BASE: chiliBase });
  expect_that('at the base\'s chili baseline the ratchet passes', level2.status === 0, level2.said);
  const admitted = chili_run(3, { files: 1, sites: 3 }, { RATCHET_BASE: chiliBase });
  expect_that('an import added with the baseline raised to admit it fails against the base', admitted.status === 1 && admitted.said.includes('chili: sites is 3 here and was 2 at the base'), admitted.said);
  const lowered = chili_run(1, { files: 1, sites: 2 }, { RATCHET_BASE: chiliBase }, ['--lower']);
  expect_that('--lower writes the lower count and passes against the base', lowered.status === 0 && lowered.kept.sites === 1 && lowered.kept.files === 1, lowered.said);
  const sneaked = chili_run(3, { files: 1, sites: 3 }, { RATCHET_BASE: chiliBase }, ['--lower']);
  expect_that('--lower over a baseline raised against the base writes nothing and fails', sneaked.status === 1 && sneaked.kept.sites === 3 && sneaked.said.includes('nothing lowered'), sneaked.said);
  const realChili = spawnSync('node', [join(here, 'chili-ratchet.mjs')], { encoding: 'utf8' });
  expect_that('the repository as it stands passes the chili ratchet', realChili.status === 0, `${realChili.stdout}${realChili.stderr}`.slice(-300));
  // The packed entry points.
  const manifest = { name: '@x/tool', main: 'dist/index.js', types: 'dist/index.d.ts', bin: { tool: 'dist/cli.js' }, exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' }, './utils': './dist/utils.js', './*': './dist/*', './package.json': './package.json' } };
  const whole = ['package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/utils.js'];
  expect_that('an exports map is read through to every target', exportTargets_list(manifest.exports).join(',') === './dist/index.js,./dist/index.d.ts,./dist/utils.js,./dist/*,./package.json');
  expect_that('a package that holds every entry point passes, a global install in its README included', entries_check(manifest, whole, 'npm install -g @x/tool').length === 0, entries_check(manifest, whole, '').join(' | '));
  const lost = entries_check(manifest, whole.filter((path) => path !== 'dist/cli.js' && path !== 'dist/utils.js'), '');
  expect_that('a bin or an exports target that is not in the package fails, each by name', lost.length === 2 && lost[0].includes('bin tool names dist/cli.js') && lost[1].includes('exports names dist/utils.js'), lost.join(' | '));
  const empty = entries_check({ name: '@x/tool', exports: { './*': './dist/*' } }, ['package.json'], '');
  expect_that('a pattern that points into a folder the package does not hold fails', empty.length === 1 && empty[0].includes('points into dist/'), empty.join(' | '));
  // What chili is pinned to: its documented command, its root and utilities, and not the retired modules.
  const chili = { name: '@fnndsc/chili', main: 'dist/index.js', bin: { chili: 'dist/index.js' }, exports: { '.': './dist/index.js', './utils': './dist/utils.js', './*': './dist/*' } };
  const chiliFiles = ['package.json', 'dist/index.js', 'dist/utils.js', 'dist/run.js'];
  const pin = PINNED['packages/chili'];
  expect_that('chili as it is published holds its pins', pinned_check(chili, chiliFiles, pin).length === 0, pinned_check(chili, chiliFiles, pin).join(' | '));
  const renamed = pinned_check({ ...chili, bin: { chilli: 'dist/index.js' } }, chiliFiles, pin);
  expect_that('its command renamed to another name that still resolves fails: the documented name is kept', renamed.length === 1 && renamed[0].includes('its command chili is gone from bin'), renamed.join(' | '));
  const dropped = pinned_check({ ...chili, exports: { '.': './dist/index.js', './*': './dist/*' } }, chiliFiles, pin);
  expect_that('its explicit ./utils export dropped fails, though the pattern would still reach the file', dropped.length === 1 && dropped[0].includes('its export ./utils is gone'), dropped.join(' | '));
  const stale = pinned_check(chili, [...chiliFiles, 'dist/lfs/lfs.js', 'dist/commands/pipeline/run.js'], pin);
  expect_that('a retired module in what would be published fails, each by name', stale.length === 2 && stale[0].includes('dist/lfs/lfs.js') && stale[1].includes('dist/commands/pipeline/run.js'), stale.join(' | '));
  const binless = entries_check({ name: '@x/lib', main: 'dist/index.js' }, ['dist/index.js'], 'Install it: `npm install -g @x/lib`');
  expect_that('a README that says to install globally a package with no bin fails', binless.length === 1 && binless[0].includes('no bin to run'), binless.join(' | '));
}

// --- the host gate ---
{
  const { effects_find, gate_judge, gate_parse } = await import('./host-gate.mjs');
  const tree = join(run, 'host-gate');
  file_put(join(tree, 'packages/brasa/package.json'), JSON.stringify({ name: '@fnndsc/brasa', exports: { '.': './dist/index.js' } }));
  file_put(join(tree, 'packages/brasa/src/direct.ts'), "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n");
  file_put(join(tree, 'packages/brasa/src/spawn.ts'), "const { spawn } = require('child_process');\nexport const b = spawn;\n");
  file_put(join(tree, 'packages/brasa/src/lazy.ts'), "export const c = async () => (await import('fs/promises')).readFile;\n");
  file_put(join(tree, 'packages/brasa/src/adapter.ts'), "export { readFile } from 'node:fs';\nexport const harmless = 1;\n");
  file_put(join(tree, 'packages/brasa/src/viaAdapter.ts'), "import { readFile } from './adapter.js';\nexport const d = readFile;\n");
  file_put(join(tree, 'packages/brasa/src/harmless.ts'), "import { harmless } from './adapter.js';\nexport const e = harmless;\n");
  file_put(join(tree, 'packages/brasa/src/rebind.ts'), "import * as cp from 'node:child_process';\nexport { cp };\n");
  file_put(join(tree, 'packages/brasa/src/viaRebind.ts'), "import { cp } from './rebind.js';\nexport const f = cp;\n");
  file_put(join(tree, 'packages/brasa/src/comment.ts'), "// import fs from 'fs';\nconst words = \"require('child_process')\";\nexport const g = words;\n");
  file_put(join(tree, 'packages/fond/package.json'), JSON.stringify({ name: '@fnndsc/fond', exports: { '.': './dist/index.js', './sub': './dist/sub.js' } }));
  file_put(join(tree, 'packages/fond/src/index.ts'), "export * from './sub.js';\nexport const safe = 1;\n");
  file_put(join(tree, 'packages/fond/src/sub.ts'), "export { writeFile } from 'fs';\n");
  file_put(join(tree, 'packages/brasa/src/byName.ts'), "import { writeFile } from '@fnndsc/fond';\nexport const h = writeFile;\n");
  file_put(join(tree, 'packages/brasa/src/bySubpath.ts'), "import { writeFile } from '@fnndsc/fond/sub';\nexport const i = writeFile;\n");
  file_put(join(tree, 'packages/brasa/src/byNameSafe.ts'), "import { safe } from '@fnndsc/fond';\nexport const j = safe;\n");
  const found = effects_find(tree, ['packages/brasa', 'packages/fond']);
  const of = (file) => [...(found.get(`packages/brasa/src/${file}`) ?? [])].sort().join('+');
  expect_that('an effect is found by a static import, a require and a dynamic import, by node\'s prefixed and bare names alike', of('direct.ts') === 'fs' && of('spawn.ts') === 'child_process' && of('lazy.ts') === 'fs', JSON.stringify([...found]));
  expect_that('a consumer of a module that re-exports an effect\'s binding has the effect; one taking only a harmless sibling export has none', of('viaAdapter.ts') === 'fs' && of('harmless.ts') === '', JSON.stringify([...found]));
  expect_that('a module that exports an imported effect binding of its own carries it to its consumers', of('viaRebind.ts') === 'child_process' && of('rebind.ts') === 'child_process', JSON.stringify([...found]));
  expect_that('a re-export followed through a workspace package name and its exported subpath carries the effect; a harmless export of the same package does not', of('byName.ts') === 'fs' && of('bySubpath.ts') === 'fs' && of('byNameSafe.ts') === '', JSON.stringify([...found]));
  expect_that('a comment or a string that shows an import is none', of('comment.ts') === '', JSON.stringify([...found]));
  const reason = 'asks hostDisk_refusal before any read';
  const listed = { files: Object.fromEntries([...found].map(([file, effects]) => [file, Object.fromEntries([...effects].map((effect) => [effect, reason]))])), pins: [{ file: 'packages/brasa/src/direct.ts', text: 'readFileSync', why: 'the gate' }] };
  const read = (file) => { try { return readFileSync(join(tree, file), 'utf8'); } catch { return null; } };
  expect_that('every effect listed with its reason, and its pins held: the gate passes', gate_judge(found, listed, listed, read).length === 0, gate_judge(found, listed, listed, read).join(' | '));
  const gained = gate_judge(new Map([...found, ['packages/brasa/src/direct.ts', new Set(['fs', 'child_process'])]]), listed, listed, read);
  expect_that('a file listed for the disk that gains programs fails, though it is on the list', gained.length === 1 && gained[0].includes('direct.ts imports child_process'), gained.join(' | '));
  const stale = gate_judge(new Map([...found].filter(([file]) => !file.endsWith('lazy.ts'))), listed, listed, read);
  expect_that('an entry for an effect the file no longer imports fails: the list does not rot', stale.length === 1 && stale[0].includes('lazy.ts for fs, which it no longer imports'), stale.join(' | '));
  const unpinned = gate_judge(found, { ...listed, pins: [{ file: 'packages/brasa/src/direct.ts', text: "hostDisk_refusal('x')", why: 'the gate' }] }, null, read);
  expect_that('a pin whose gate call a file no longer holds fails', unpinned.length === 1 && unpinned[0].includes("no longer holds its gate `hostDisk_refusal('x')`"), unpinned.join(' | '));
  const smaller = { files: Object.fromEntries(Object.entries(listed.files).filter(([file]) => !file.endsWith('spawn.ts'))), pins: listed.pins };
  const grown = gate_judge(found, listed, smaller, read);
  expect_that('an entry the base did not have fails: the list grows only by its own review', grown.length === 1 && grown[0].includes('gains packages/brasa/src/spawn.ts for child_process'), grown.join(' | '));
  const dropped = gate_judge(found, { ...listed, pins: [] }, listed, read);
  expect_that('a pin the base had and the change dropped fails', dropped.length === 1 && dropped[0].includes('drops the pin on packages/brasa/src/direct.ts'), dropped.join(' | '));
  let refused = '';
  try { gate_parse(JSON.stringify({ files: { 'a.ts': { fs: 'ok' } }, pins: [] }), 'the list'); } catch (error) { refused = error.message; }
  expect_that('an entry with no reason worth the name is refused', refused.includes('gives no reason'), refused);
  const realGate = spawnSync('node', [join(here, 'host-gate.mjs')], { encoding: 'utf8' });
  expect_that('the repository as it stands passes the host gate', realGate.status === 0, `${realGate.stdout}${realGate.stderr}`.slice(-400));
}

console.log(failed === 0 ? `ratchets: the cast ratchet, the coverage ratchet, the base it is compared with, the line-builder lint, the chili ratchet, the host gate, the packed entry points, and the reach of the test and seam lints all hold (made in ${run})` : `ratchets test: ${failed} failed (made in ${run})`);
process.exit(failed === 0 ? 0 : 1);
