/**
 * @file The debris check, held to lists of paths and to a real repository.
 *
 * - Given a list: each kind of debris is found, paths that only look like
 *   one are not, and an empty list is not a pass.
 * - Asked of git itself, in a repository made here whose folders have
 *   letters outside ASCII (which git, printing for people, would quote and
 *   escape): the debris under them is found by its true path.
 *
 * Run via `npm run test:debris`. The repository is made under the
 * runner's temporary folder (`RUNNER_TEMP`, which a CI runner clears) or
 * the system's, and is left there: this test deletes nothing.
 *
 * @module
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const check = join(dirname(fileURLToPath(import.meta.url)), 'tracked-debris.mjs');

/** The paths a run of the check reported, sorted. */
function found_read(stderr) {
  return stderr.split('\n').filter((line) => line.startsWith('  ') && line.includes(': ')).map((line) => line.trim().split(': ')[0]).sort();
}

/** Runs the check over a list of paths given as its tracked files, as `git ls-files -z` would write them. */
function list_check(paths) {
  const ran = spawnSync(process.execPath, [check, '--stdin'], { input: paths.map((path) => `${path}\0`).join(''), encoding: 'utf8' });
  return { status: ran.status, found: found_read(ran.stderr) };
}

const DEBRIS = ['cwd.txt', 'packages/chell/cwd.txt', 'packages/trek/coverage/lcov.info', 'apps/porter/coverage/lcov-report/index.html', 'packages/chili/package.json.backup', 'packages/cumin/package-lock.json', 'apps/argus/package-lock.json', 'docs/a name\nwith a line break/cwd.txt'];
const CLEAN = ['package-lock.json', 'package.json', 'packages/orrery/src/types/census.ts', 'packages/cumin/src/coverageReport.ts', 'docs/cwd.txt.adoc', 'packages/chell/src/backup.ts', 'scripts/coverage-floor.mjs', 'scripts/fixtures/audit-coverage/good/package-lock.json', 'packages/brasa/tests/fixtures/coverage/report.json'];

let failed = 0;
const mixed = list_check([...DEBRIS, ...CLEAN]);
if (mixed.status !== 1) { console.log(`FAIL  a list with debris ended ${mixed.status}, not 1`); failed++; }
// A path with a line break in it is reported over two lines; what matters is that each kind was counted.
if (mixed.found.length < DEBRIS.length - 1 || !DEBRIS.slice(0, 7).every((path) => mixed.found.includes(path))) { console.log(`FAIL  found ${JSON.stringify(mixed.found)}, wanted all of ${JSON.stringify(DEBRIS)}`); failed++; }
const clean = list_check(CLEAN);
if (clean.status !== 0) { console.log(`FAIL  a clean list ended ${clean.status}: ${clean.found.join(', ')}`); failed++; }
const empty = list_check([]);
if (empty.status !== 1) { console.log(`FAIL  an empty list ended ${empty.status}: a check of nothing must not pass`); failed++; }

// Asked of git itself: a repository whose folder names git would quote.
const repo = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'debris-check-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
const planted = ['päckages/ünïcode/cwd.txt', 'données/coverage/lcov.info', 'с пробелом/package-lock.json'];
const harmless = ['päckages/ünïcode/source.ts', 'package-lock.json'];
for (const path of [...planted, ...harmless]) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), 'x\n');
}
// Added in spite of any ignore rule of the person running this: what is tracked is what is asked about.
git('add', '-f', '--', ...planted, ...harmless);
const quoted = git('ls-files');
if (!quoted.includes('\\')) { console.log('FAIL  git did not quote these names when printing for people: the case this test is for is not being made'); failed++; }
const asked = spawnSync(process.execPath, [check], { cwd: repo, encoding: 'utf8' });
const reported = found_read(asked.stderr);
if (asked.status !== 1 || JSON.stringify(reported) !== JSON.stringify([...planted].sort())) { console.log(`FAIL  in a real repository: ended ${asked.status}, found ${JSON.stringify(reported)}, wanted exactly ${JSON.stringify([...planted].sort())}`); failed++; }

console.log(failed === 0 ? `tracked-debris: finds every kind planted in a list, nothing among ${CLEAN.length} look-alikes, refuses an empty list, and finds ${planted.length} under folders git would quote (${repo})` : `tracked-debris test: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
