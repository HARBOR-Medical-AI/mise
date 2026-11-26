/**
 * @file The debris check, held to a list of paths: each kind of debris is
 * found, and paths that only look like one are not.
 *
 * Run via `npm run test:debris`.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const check = join(dirname(fileURLToPath(import.meta.url)), 'tracked-debris.mjs');

/** Runs the check over a list of paths given as its tracked files. */
function list_check(paths) {
  const ran = spawnSync(process.execPath, [check, '--stdin'], { input: paths.join('\n'), encoding: 'utf8' });
  return { status: ran.status, found: ran.stderr.split('\n').filter((line) => line.startsWith('  ') && line.includes(': ')).map((line) => line.trim().split(': ')[0]).sort() };
}

const DEBRIS = ['cwd.txt', 'packages/chell/cwd.txt', 'packages/trek/coverage/lcov.info', 'apps/porter/coverage/lcov-report/index.html', 'packages/chili/package.json.backup', 'packages/cumin/package-lock.json', 'apps/argus/package-lock.json'];
const CLEAN = ['package-lock.json', 'package.json', 'packages/orrery/src/types/census.ts', 'packages/cumin/src/coverageReport.ts', 'docs/cwd.txt.adoc', 'packages/chell/src/backup.ts', 'scripts/coverage-floor.mjs'];

let failed = 0;
const mixed = list_check([...DEBRIS, ...CLEAN]);
if (mixed.status !== 1) { console.log(`FAIL  a list with debris ended ${mixed.status}, not 1`); failed++; }
if (JSON.stringify(mixed.found) !== JSON.stringify([...DEBRIS].sort())) { console.log(`FAIL  found ${JSON.stringify(mixed.found)}, wanted exactly ${JSON.stringify([...DEBRIS].sort())}`); failed++; }
const clean = list_check(CLEAN);
if (clean.status !== 0) { console.log(`FAIL  a clean list ended ${clean.status}: ${clean.found.join(', ')}`); failed++; }
const empty = list_check([]);
if (empty.status !== 1) { console.log(`FAIL  an empty list ended ${empty.status}: a check of nothing must not pass`); failed++; }
console.log(failed === 0 ? `tracked-debris: finds all ${DEBRIS.length} kinds planted, nothing among ${CLEAN.length} look-alikes, and refuses an empty list` : `tracked-debris test: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
