/**
 * @file The ratchets, held to trees and histories made for the purpose.
 *
 * - The cast ratchet over small trees: at its ceilings it passes; a new
 *   cast in an app fails; a cast removed fails until the ceiling is
 *   lowered; a workspace with no ceiling has a ceiling of zero; a tree
 *   with no source is not a pass.
 * - The base a ratchet's ceilings are compared with, for each way a check
 *   is run, in a repository made here: it resolves, or the check fails;
 *   the one case with nothing to compare is a base whose tree has no
 *   baseline file.
 * - The test and seam lints: each reaches `apps/` as well as `packages/`,
 *   by its config and by the command in `package.json` alike, and each
 *   fails on a violation in an app's file.
 *
 * Run via `npm run test:ratchets`. It makes its trees under the system's
 * temporary folder and leaves them there.
 *
 * @module
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base_name, base_resolve, ceilings_compare, fileAtCommit_read } from './lib/ratchetBase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
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
/** Makes a tree: workspace to number of casts; and its baseline. Returns the ratchet's outcome over it. */
function casts_check(tree, ceilings) {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-casts-'));
  for (const [workspace, count] of Object.entries(tree)) file_put(join(root, workspace, 'src', 'a.ts'), CAST.repeat(count) || 'export {};\n');
  file_put(join(root, 'baseline.json'), JSON.stringify({ casts: ceilings }));
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

// ---- The base, in a repository made here.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const work = mkdtempSync(join(tmpdir(), 'ratchet-base-'));
const origin = join(work, 'origin.git');
const clone = join(work, 'clone');
git(work, 'init', '-q', '--bare', '-b', 'main', origin);
git(work, 'clone', '-q', origin, clone);
for (const [key, value] of [['user.email', 'ratchet@example.invalid'], ['user.name', 'ratchet'], ['commit.gpgsign', 'false']]) git(clone, 'config', key, value);
const commit = (message) => { git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', message); return git(clone, 'rev-parse', 'HEAD'); };
file_put(join(clone, 'readme'), 'one\n');
const bare = commit('no baseline yet');
file_put(join(clone, 'scripts/ratchet-baseline.json'), JSON.stringify({ casts: { 'packages/cumin': 2 } }));
const withBaseline = commit('a baseline');
git(clone, 'push', '-q', 'origin', 'main');
git(clone, 'checkout', '-q', '-b', 'work');
file_put(join(clone, 'readme'), 'two\n');
const tip = commit('work');
git(clone, 'push', '-q', 'origin', 'work');

expect_that('a pull request: the merge base with its base ref', base_resolve({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' }, clone).sha === withBaseline);
expect_that('a pull request with no base ref fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'pull_request' }, clone)) ?? '').includes('no GITHUB_BASE_REF'));
expect_that('a pull request whose base ref is not here fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'nosuch' }, clone)) ?? '').includes('does not resolve to a commit that is here'));
expect_that('a push: the before commit', base_resolve({ GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: bare }, clone).sha === bare);
expect_that('a push whose before is all zeros fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: '0'.repeat(40) }, clone)) ?? '').includes('the base cannot be named'));
expect_that('a push with no before fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'push' }, clone)) ?? '').includes('the base cannot be named'));
expect_that('a push whose before commit is not here fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: 'a'.repeat(40) }, clone)) ?? '').includes('does not resolve to a commit that is here'));
expect_that('a manual run on main: the commit before', base_name({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main' }, clone).ref === 'HEAD~1');
expect_that('a manual run elsewhere: the merge base with main', base_resolve({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'work' }, clone).sha === withBaseline);
expect_that('a manual run with a base given: that one', base_resolve({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', RATCHET_BASE: bare }, clone).sha === bare);
expect_that('a base given that is not here fails', (thrown_read(() => base_resolve({ RATCHET_BASE: 'nosuch-ref' }, clone)) ?? '').includes('does not resolve'));
expect_that('on a desk: the merge base with origin/main', base_resolve({}, clone).sha === withBaseline && tip !== withBaseline);
expect_that('an event with no base defined fails', (thrown_read(() => base_resolve({ GITHUB_EVENT_NAME: 'schedule' }, clone)) ?? '').includes('no base is defined'));
// The one case with nothing to compare: the base resolved, and its tree has no baseline file.
expect_that('a base whose tree has no baseline file: nothing to compare', fileAtCommit_read(bare, 'scripts/ratchet-baseline.json', clone) === null);
expect_that('a base whose tree has it: read', JSON.parse(fileAtCommit_read(withBaseline, 'scripts/ratchet-baseline.json', clone) ?? '{}').casts['packages/cumin'] === 2);
expect_that('a commit that is not here is an error, not "no file"', thrown_read(() => fileAtCommit_read('a'.repeat(40), 'scripts/ratchet-baseline.json', clone)) !== null);

// ---- Ceilings against the base's.
expect_that('a ceiling raised beside its count fails', ceilings_compare({ 'packages/cumin': 3 }, { 'packages/cumin': 2 }, 'casts').length === 1);
expect_that('a ceiling for a workspace the base did not name rose from zero', ceilings_compare({ 'packages/cumin': 2, 'apps/new': 1 }, { 'packages/cumin': 2 }, 'casts').length === 1);
expect_that('ceilings equal or lower pass', ceilings_compare({ 'packages/cumin': 1 }, { 'packages/cumin': 2, 'apps/argus': 5 }, 'casts').length === 0);
expect_that('a section the base did not have is new: nothing to compare', ceilings_compare({ 'packages/cumin': 9 }, undefined, 'casts').length === 0);
// The ratchet itself, run in that repository with the ceiling raised beside a new cast: the base says no.
file_put(join(clone, 'packages/cumin/src/a.ts'), CAST.repeat(3));
file_put(join(clone, 'scripts/ratchet-baseline.json'), JSON.stringify({ casts: { 'packages/cumin': 3 } }));
mkdirSync(join(clone, 'scripts/lib'), { recursive: true });
for (const file of ['cast-ratchet.mjs', 'lib/ratchetBase.mjs']) writeFileSync(join(clone, 'scripts', file), readFileSync(join(here, file)));
const raised = spawnSync(process.execPath, [join(clone, 'scripts/cast-ratchet.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' } });
expect_that('raising the number beside the violation fails against the base', raised.status === 1 && raised.stderr.includes('packages/cumin is 3 here and was 2 at the base'), `${raised.stdout}${raised.stderr}`);
const unresolved = spawnSync(process.execPath, [join(clone, 'scripts/cast-ratchet.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'push', RATCHET_BEFORE: '0'.repeat(40) } });
expect_that('a base that cannot be named fails the ratchet', unresolved.status === 1 && unresolved.stderr.includes('could not be compared'), `${unresolved.stdout}${unresolved.stderr}`);

// ---- The test and seam lints reach apps, by config and by command alike, and bite there.
const { ESLint } = await import('eslint');
const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;
const reach = [
  { script: 'lint:tests', config: 'eslint.tests.config.mjs', roots: ['packages/*/tests/**/*.{ts,js}', 'apps/*/tests/**/*.{ts,js}'], file: 'apps/porter/tests/unit/planted.test.ts', text: "test('nothing is expected', () => { const a = 1; void a; });\n", rule: 'jest/expect-expect' },
  { script: 'lint:seam', config: 'eslint.seam.config.mjs', roots: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'], file: 'apps/argus/src/planted.ts', text: "import Client from '@fnndsc/chrisapi';\nexport const client = Client;\n", rule: 'no-restricted-imports' },
];
for (const one of reach) {
  const configText = readFileSync(join(repo, one.config), 'utf8');
  for (const glob of one.roots) {
    expect_that(`${one.script}'s command names ${glob}`, scripts[one.script].includes(`\\"${glob}\\"`) || scripts[one.script].includes(`"${glob}"`), scripts[one.script]);
    expect_that(`${one.config} takes ${glob}`, configText.includes(`'${glob}'`));
  }
  const eslint = new ESLint({ cwd: repo, overrideConfigFile: join(repo, one.config) });
  const [result] = await eslint.lintText(one.text, { filePath: join(repo, one.file) });
  expect_that(`${one.script} fails on a violation in ${one.file}`, result !== undefined && result.messages.some((message) => message.ruleId === one.rule && message.severity === 2), JSON.stringify(result?.messages ?? 'not linted'));
  const [inPackage] = await eslint.lintText(one.text, { filePath: join(repo, one.file.replace(/^apps\/[a-z]+/, 'packages/brasa')) });
  expect_that(`${one.script} still fails on the same in a package`, inPackage !== undefined && inPackage.messages.some((message) => message.ruleId === one.rule && message.severity === 2));
}

console.log(failed === 0 ? 'ratchets: the cast ratchet, the base it is compared with, and the reach of the test and seam lints all hold' : `ratchets test: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
