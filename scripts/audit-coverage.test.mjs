/**
 * @file The audit coverage check, held to small repositories kept beside
 * it: ones whose lockfile describes what is shipped, and one for each way
 * it can fail to.
 *
 * Each case names a fixture under `scripts/fixtures/audit-coverage/`, the
 * status the check must end with, the faults it must give (each by words
 * it must contain; exactly that many), and, where it matters, the
 * production tree it must list for `packages/a`.
 *
 * Run via `npm run test:audit-coverage`.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const check = join(here, 'audit-coverage.mjs');

const RECORD_LACKS_F = `packages/a's package.json has f: "^1.0.0" in dependencies and the lockfile's record of packages/a does not`;
const BASE_TREE = ['b@1.2.0', 'c@2.1.0'];

/** @type {Array<{ name: string, faults?: string[], tree?: string[], note?: string }>} */
const CASES = [
  { name: 'good', tree: BASE_TREE },
  // What is missing, or is not what was asked for.
  { name: 'missing-dependency', faults: ['b@^1.0.0 (a dependency of packages/a) is not in the root lockfile'] },
  { name: 'incompatible-version', faults: ['b@^1.0.0 (a dependency of packages/a) is resolved outside the range asked: b@2.0.0 at node_modules/b'] },
  { name: 'prerelease-for-a-plain-range', faults: ['b@^1.0.0 (a dependency of packages/a) is resolved outside the range asked: b@1.3.0-beta.1'] },
  { name: 'missing-peer', faults: ['c@^2.0.0 (a peer dependency of node_modules/b) is not in the root lockfile'] },
  // Where a peer stands. Only inside its dependent, or inside it with another copy above: npm resolves the
  // nearest, and a peer may not be local to a package that is not at the top.
  { name: 'peer-only-inside-its-dependent', faults: ['c@^2.0.0 (a peer dependency of node_modules/b) is a peer installed inside its dependent, not at or above it where a peer must be: c@2.1.0 at node_modules/b/node_modules/c'] },
  { name: 'peer-two-copies', faults: ['c@^2.0.0 (a peer dependency of node_modules/b) is a peer installed inside its dependent'] },
  // A workspace is at the top: npm allows its own peer to stand inside it.
  { name: 'workspace-local-peer', tree: [...BASE_TREE, 'p@1.0.0'] },
  // A package that both depends on a name and names it as a peer loads its own copy.
  { name: 'peer-that-is-also-a-dependency', tree: BASE_TREE },
  // What the audit leaves out. Development-only on a required edge: a fault.
  { name: 'dev-only-peer', faults: ['c@2.1.0 at node_modules/c, c@^2.0.0 (a peer dependency of node_modules/b), is taken for development-only, so the audit leaves it out'] },
  // Development-or-optional is kept under --omit=dev: it and its child are part of the graph.
  { name: 'dev-or-optional-peer', tree: [...BASE_TREE, 'k@1.0.0'] },
  // An installed optional dependency is walked, and so is a required child on that optional branch.
  { name: 'optional-branch-with-a-required-child', tree: [...BASE_TREE, 'd@1.0.0', 'h@1.0.0'] },
  // An installed optional dependency is shipped: one the audit leaves out is a fault.
  { name: 'installed-optional-dev-only', faults: ['d@1.0.0 at node_modules/d, d@^1.0.0 (an optional dependency of packages/a), is taken for development-only, so the audit leaves it out'] },
  // An optional peer carried only for development is not shipped: no part of the graph, not a fault.
  { name: 'optional-peer-development-only', tree: BASE_TREE },
  // A workspace's peer that it also lists for development: npm keeps only the development edge for the
  // name. What is published is the peer, at the peer's range.
  { name: 'workspace-peer-also-for-development', tree: [...BASE_TREE, 'p@1.2.0'] },
  { name: 'workspace-peer-only-copy-development-only', faults: ['p@1.2.0 at node_modules/p, p@^1.0.0 (a peer dependency of packages/a, which also lists it for development as ^1.0.0), is taken for development-only, so the audit leaves it out'] },
  { name: 'workspace-peer-development-range-incompatible', faults: ['p@^1.0.0 (a peer dependency of packages/a, which also lists it for development as ^2.0.0) is resolved outside the range asked: p@2.0.0 at node_modules/p'] },
  // npm sees nothing wrong with "*" resolved to an entry with no version; the audit has nothing to look up.
  { name: 'registry-package-without-a-version', faults: ['b at node_modules/b has no version in the root lockfile, so the audit cannot look it up'] },
  // An optional peer installed out of range: passed, walked, and said.
  { name: 'optional-peer-out-of-range', tree: [...BASE_TREE, 'e@8.0.0'], note: 'e@^9.0.0 (an optional peer dependency of node_modules/b) is resolved outside the range asked: e@8.0.0 at node_modules/e' },
  // The root's overrides, by the dependency's name and by its dependent's.
  // An alias puts another package in the name's place: it is listed as what the audit looks up.
  { name: 'override-honoured', tree: ['empty@1.0.0 (installed as b)'] },
  { name: 'override-not-met', faults: ['b@npm:empty@1.0.0 (a dependency of packages/a) is to be empty and the lockfile has other@1.0.0 at node_modules/b'] },
  { name: 'override-alias-without-a-range-honoured', tree: ['empty@1.0.0 (installed as b)'] },
  { name: 'override-alias-without-a-range-not-met', faults: ['b@npm:empty (a dependency of packages/a) is to be empty and the lockfile has other@1.0.0 at node_modules/b'] },
  { name: 'parent-scoped-override-honoured', tree: ['b@1.2.0', 'c@3.0.0'] },
  { name: 'parent-scoped-override-not-met', faults: ['c@3.0.0 (a peer dependency of node_modules/b) is resolved outside the range asked: c@2.1.0 at node_modules/c'] },
  // The lockfile's record of a workspace against the workspace's own manifest.
  { name: 'stale-workspace-version', faults: ['the lockfile records packages/a as 0.9.0, and its package.json says 1.0.0'] },
  { name: 'manifest-ahead-of-lock', faults: [RECORD_LACKS_F, 'f@^1.0.0 (a dependency of packages/a) is not in the root lockfile'] },
  // The package is installed, for a sibling, where node would find it: the record still lacks the edge.
  { name: 'new-dependency-hoisted-for-a-sibling', faults: [RECORD_LACKS_F] },
  { name: 'record-states-another-range', faults: [`packages/a's package.json has b: "^1.0.0" in dependencies and the lockfile's record of packages/a has "^1.1.0"`] },
  // A name declared as a dependency and as a peer: each declaration is compared, though one edge is walked.
  { name: 'stale-peer-declaration', faults: [`packages/a's package.json has c: "^2.1.0" in peerDependencies and the lockfile's record of packages/a has "^2.0.0"`] },
  { name: 'stale-peer-optional-flag', faults: [`packages/a's package.json has c: {"optional":true} in peerDependenciesMeta and the lockfile's record of packages/a does not`] },
  { name: 'nothing-published', faults: ['no published workspace was found'] },
];

let failed = 0;
/** Records a failure. */
function fail_say(words) { failed++; console.log(`FAIL  ${words}`); }

for (const one of CASES) {
  const root = join(here, 'fixtures', 'audit-coverage', one.name);
  const wanted = one.faults ?? [];
  const ran = spawnSync(process.execPath, [check, '--root', root], { encoding: 'utf8' });
  const faults = ran.stderr.split('\n').filter((line) => line.startsWith('  '));
  const status = wanted.length === 0 ? 0 : 1;
  if (ran.status !== status || faults.length !== wanted.length || !wanted.every((words) => faults.some((fault) => fault.includes(words)))) {
    fail_say(`${one.name}: ended ${ran.status} (wanted ${status}) with faults ${JSON.stringify(faults)}; wanted exactly ${JSON.stringify(wanted)}${ran.status > 1 || faults.length === 0 ? ` | ${ran.stderr.slice(0, 300)}` : ''}`);
  }
  if (one.note !== undefined && !(ran.stdout.includes(`note: an optional peer is installed outside the range asked: ${one.note}`) && ran.stdout.includes('1 optional peer(s) installed out of range'))) {
    fail_say(`${one.name}: the out-of-range optional peer is not said, or the summary does not count it: ${ran.stdout}`);
  }
  if (one.note === undefined && ran.stdout.includes('note:')) fail_say(`${one.name}: a note nobody expected: ${ran.stdout}`);
  if (one.tree !== undefined) {
    const listed = spawnSync(process.execPath, [check, '--root', root, '--list', 'packages/a'], { encoding: 'utf8' });
    const tree = listed.stdout.trim().split('\n').filter((line) => line !== '');
    if (listed.status !== 0 || JSON.stringify(tree) !== JSON.stringify([...one.tree].sort())) fail_say(`${one.name}: listed ${JSON.stringify(tree)} (ended ${listed.status}); wanted ${JSON.stringify([...one.tree].sort())}`);
  }
}
// The listing says what is wrong with a walk too, and fails with it.
const listed = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'incompatible-version'), '--list', '@x/a'], { encoding: 'utf8' });
if (listed.status !== 1 || !listed.stdout.includes('b@2.0.0') || !listed.stderr.includes('fault: packages/a: b@^1.0.0 (a dependency of packages/a) is resolved outside the range asked')) fail_say(`--list of a faulty walk: ended ${listed.status} saying ${listed.stdout} ${listed.stderr}`);

// Run by npm, the check reads the tree with that npm's own library, which is what its audit reads it with.
if (process.env.npm_execpath !== undefined) {
  const bundled = JSON.parse(readFileSync(join(dirname(dirname(process.env.npm_execpath)), 'node_modules', '@npmcli', 'arborist', 'package.json'), 'utf8')).version;
  const said = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'good')], { encoding: 'utf8' });
  if (!said.stdout.includes(`Read with @npmcli/arborist ${bundled}, the running npm's own`)) fail_say(`run by npm, the check did not read with npm's own library (${bundled}): ${said.stdout}`);
}
// Run without npm, it says it used the repository's copy.
const direct = spawnSync(process.execPath, [check, '--root', join(here, 'fixtures', 'audit-coverage', 'good')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
if (!direct.stdout.includes("this repository's dev dependency")) fail_say(`run without npm, the check does not say which library it read with: ${direct.stdout}`);

console.log(failed === 0 ? `audit-coverage: ${CASES.length} repositories judged as they should be, and the listing carries its faults` : `audit-coverage test: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
