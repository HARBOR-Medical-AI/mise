/**
 * @file The audit coverage check, held to small repositories kept beside
 * it: one whose lockfile describes what is shipped, and one for each way
 * it can fail to.
 *
 * Run via `npm run test:audit-coverage`.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const check = join(here, 'audit-coverage.mjs');

/** Each fixture, whether it passes, and what its one fault must say. */
const CASES = [
  ['good', 0, null],
  ['missing-dependency', 1, 'b@^1.0.0, a dependency of packages/a, is not in the root lockfile'],
  ['incompatible-version', 1, 'packages/a asks for b@^1.0.0 (a dependency) and the lockfile resolves it to b@2.0.0'],
  ['missing-peer', 1, 'c@^2.0.0, a peer dependency of node_modules/b, is not in the root lockfile'],
  ['dev-only-peer', 1, 'c@2.1.0 (at node_modules/c, a peer dependency of node_modules/b) is marked development-only'],
  ['dev-or-optional-peer', 1, 'c@2.1.0 (at node_modules/c, a required peer dependency of node_modules/b) is marked development-or-optional'],
  ['stale-workspace-version', 1, 'the lockfile records packages/a as 0.9.0, and its package.json says 1.0.0'],
  // Two faults from one cause: the record lacks the edge, and the package is not installed.
  ['manifest-ahead-of-lock', 1, "packages/a's package.json declares f@^1.0.0 (a dependency) and the lockfile's record of packages/a does not have it", 2],
  // The package is installed, for a sibling, where node would find it: the record still lacks the edge.
  ['new-dependency-hoisted-for-a-sibling', 1, "packages/a's package.json declares f@^1.0.0 (a dependency) and the lockfile's record of packages/a does not have it"],
  ['record-states-another-range', 1, "packages/a's package.json declares b@^1.0.0 (a dependency) and the lockfile's record of packages/a has b@^1.1.0 (a dependency)"],
  ['parent-scoped-override-honoured', 0, null],
  ['parent-scoped-override-not-met', 1, 'node_modules/b asks for c@^2.0.0, overridden at the root to 3.0.0, (a peer dependency) and the lockfile resolves it to c@2.1.0'],
  ['peer-only-inside-its-dependent', 1, 'c@^2.0.0, a peer dependency of node_modules/b, is installed only inside node_modules/b, not at or above it'],
  ['prerelease-for-a-plain-range', 1, 'packages/a asks for b@^1.0.0 (a dependency) and the lockfile resolves it to b@1.3.0-beta.1'],
  ['optional-peer-development-only', 0, null],
  ['peer-that-is-also-a-dependency', 0, null],
  ['installed-optional-dev-only', 1, 'd@1.0.0 (at node_modules/d, a optional dependency of packages/a) is marked development-only'],
  ['override-honoured', 0, null],
  ['override-not-met', 1, 'overridden at the root to empty@1.0.0, (a dependency) and the lockfile resolves it to other@1.0.0'],
  ['optional-peer-out-of-range', 0, null],
  ['nothing-published', 1, 'no published workspace was found'],
];

let failed = 0;
for (const [name, status, words, count = 1] of CASES) {
  const ran = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', name)], { encoding: 'utf8' });
  const faults = ran.stderr.split('\n').filter((line) => line.startsWith('  '));
  const ok = ran.status === status && (words === null ? faults.length === 0 : faults.length === count && faults.some((fault) => fault.includes(words)));
  if (!ok) { failed++; console.log(`FAIL  ${name}: ended ${ran.status} (wanted ${status}) saying ${JSON.stringify(faults)}${words === null ? '' : `; wanted ${count} fault(s), one with "${words}"`}`); }
}
// An optional peer installed out of range passes, and is said: the summary does not call it in range.
const noted = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'optional-peer-out-of-range')], { encoding: 'utf8' });
if (noted.status !== 0 || !noted.stdout.includes('note: an optional peer is installed outside the range asked: node_modules/b asks for e@^9.0.0 (an optional peer dependency) and the lockfile resolves it to e@8.0.0') || !noted.stdout.includes('1 optional peer(s) installed out of range')) { failed++; console.log(`FAIL  an out-of-range optional peer is not said: ${noted.stdout}`); }
// One carried only for development is no part of the graph: neither it nor what it needs is listed.
const devPeer = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'optional-peer-development-only'), '--list', 'packages/a'], { encoding: 'utf8' });
if (devPeer.status !== 0 || devPeer.stdout.trim() !== 'b@1.2.0\nc@2.1.0') { failed++; console.log(`FAIL  a development-only optional peer was walked: ${JSON.stringify(devPeer.stdout)} ${devPeer.stderr}`); }
// A package that depends on what it also names as a peer is listed with its own copy.
const ownCopy = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'peer-that-is-also-a-dependency'), '--list', 'packages/a'], { encoding: 'utf8' });
if (ownCopy.status !== 0 || ownCopy.stdout.trim() !== 'b@1.2.0\nc@2.1.0') { failed++; console.log(`FAIL  a peer that is also a dependency: ${JSON.stringify(ownCopy.stdout)} ${ownCopy.stderr}`); }
// The listing says what is wrong with a walk too, and fails with it.
const listed = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'incompatible-version'), '--list', 'packages/a'], { encoding: 'utf8' });
if (listed.status !== 1 || !listed.stdout.includes('b@2.0.0') || !listed.stderr.includes('fault: packages/a: packages/a asks for b@^1.0.0')) { failed++; console.log(`FAIL  --list of a faulty walk: ended ${listed.status} saying ${listed.stdout} ${listed.stderr}`); }
const listedGood = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'good'), '--list', '@x/a'], { encoding: 'utf8' });
if (listedGood.status !== 0 || listedGood.stdout.trim() !== 'b@1.2.0\nc@2.1.0') { failed++; console.log(`FAIL  --list of a good walk: ended ${listedGood.status} saying ${JSON.stringify(listedGood.stdout)}`); }

console.log(failed === 0 ? `audit-coverage: ${CASES.length} repositories judged as they should be, and the listing carries its faults` : `audit-coverage test: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
