/**
 * @file The check that no secret is on a command line, held to two trees
 * kept beside it: one where every form of the fault stands, each to be
 * found at its own line, and one of lines that look like the fault and are
 * not, none of which may be found.
 *
 * Run via `npm run test:argv`.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const check = join(here, 'argv-secrets.mjs');

/** Runs the check over a tree. */
function tree_check(tree) {
  const ran = spawnSync(process.execPath, [check, join(here, 'fixtures', 'argv-secrets', tree)], { encoding: 'utf8' });
  return { status: ran.status, found: ran.stderr.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim()).sort() };
}

/** Every fault in the tree of faults, by file and line. */
const EXPECTED = [
  '.github/workflows/e2e.yml:5: -p is given a variable on a command line',
  '.github/workflows/e2e.yml:6: --token is given a variable on a command line',
  'apps/y/src/admin.ts:1: --adminPassword is given its value in an argument list',
  'packages/x/exemplars/joined.ts:2: --password is joined to its value in one argument',
  'packages/x/exemplars/joined.ts:3: --token is joined to its value in one argument',
  'packages/x/exemplars/joined.ts:5: --auth-token is given its value in an argument list',
  'packages/x/src/manyLines.ts:7: --token is given its value in an argument list',
  'packages/x/src/oneLine.ts:2: --token is given its value in an argument list',
  'packages/x/src/oneLine.ts:3: -p is given its value in an argument list',
  'packages/x/src/oneLine.ts:5: -p is given its value in an argument list',
  'scripts/run.sh:3: -p is given a variable on a command line',
  'scripts/run.sh:4: --token is given a variable on a command line',
  'scripts/run.sh:5: -p is given a variable on a command line',
  'scripts/run.sh:9: --password is given a variable on a command line',
  'scripts/tool.mjs:3: -p is given its value in an argument list',
].sort();

let failed = 0;
const bad = tree_check('bad');
if (bad.status !== 1) { console.log(`FAIL  the tree of faults ended ${bad.status}, not 1`); failed++; }
for (const line of EXPECTED) if (!bad.found.includes(line)) { console.log(`FAIL  not found: ${line}`); failed++; }
for (const line of bad.found) if (!EXPECTED.includes(line)) { console.log(`FAIL  found, and not a fault that was planted: ${line}`); failed++; }
if (failed === 0) console.log(`ok    ${EXPECTED.length} faults found, each at its own line`);

const good = tree_check('good');
if (good.status !== 0 || good.found.length > 0) { console.log(`FAIL  the harmless tree ended ${good.status}: ${good.found.join('; ')}`); failed++; }
else console.log('ok    nothing found in the harmless tree');

console.log(failed === 0 ? 'argv-secrets: the check finds what it should and nothing else' : `argv-secrets test: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
