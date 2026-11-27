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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const { args_read, coverage_judge, floor_derive, floors_compare, floors_read, summary_read, uncovered_list } = await import('./coverage-ratchet.mjs');
  const { jestArgs_build, suite_isWhole, PARTIAL_DIR } = await import('./jest-with-floor.mjs');
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
  expect_that('the whole suite is the whole suite with options that only say how to run', suite_isWhole([]) && suite_isWhole(['--coverage']) && suite_isWhole(['--runInBand', '--coverage'])
    && suite_isWhole(['--maxWorkers=2']) && suite_isWhole(['--maxWorkers', '2']) && suite_isWhole(['--testTimeout=10000', '-w', '4', '--ci']) && suite_isWhole(['--some-flag-of-a-later-jest']));
  expect_that('a path, a pattern or a selecting option selects among the tests', !suite_isWhole(['tests/unit/one.test.ts']) && !suite_isWhole(['-t', 'one case']) && !suite_isWhole(['--testPathPattern=image'])
    && !suite_isWhole(['--onlyChanged']) && !suite_isWhole(['--maxWorkers=2', 'image']) && !suite_isWhole(['--shard=1/3']) && !suite_isWhole(['--collectCoverageFrom=src/app/*.ts']));
  expect_that('a whole run writes the suite\'s report; a run that selects writes its own, elsewhere', JSON.stringify(jestArgs_build(['--maxWorkers=2'])) === '["--coverage","--maxWorkers=2"]'
    && JSON.stringify(jestArgs_build(['--coverage', 'tests/unit/one.test.ts'])) === `["--coverage","tests/unit/one.test.ts","--coverageDirectory=${PARTIAL_DIR}"]`);
  threw = '';
  try { floors_read('{"casts":{}}', 'a file'); } catch (error) { threw = error.message; }
  expect_that('a baseline without the section has no floors, which is not the same as none to hold', threw.includes('no "coverage" section'), threw);
  threw = '';
  try { summary_read('{"total":{"lines":{"pct":"Unknown"}}}', 'a summary'); } catch (error) { threw = error.message; }
  expect_that('a summary without its totals is refused', threw.includes('has no lines total'), threw);
  const judged = coverage_judge('apps/argus', floors, at);
  expect_that('at its floors nothing is at fault', judged.falls.length === 0 && judged.rises.length === 0);
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

console.log(failed === 0 ? `ratchets: the cast ratchet, the coverage ratchet, the base it is compared with, and the reach of the test and seam lints all hold (made in ${run})` : `ratchets test: ${failed} failed (made in ${run})`);
process.exit(failed === 0 ? 0 : 1);
