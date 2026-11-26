/**
 * @file The root audit covers what every published workspace ships.
 *
 * `npm audit --omit=dev` at the root reads the root lockfile and leaves
 * out what npm takes for development-only. That is an audit of a
 * published workspace's production dependencies only if the lockfile
 * really describes them. This fails unless it does, in two parts.
 *
 * What the lockfile says of a workspace is what the workspace says of
 * itself. The lockfile's record of each workspace is compared with the
 * workspace's own `package.json`: the version, and each of
 * `dependencies`, `optionalDependencies`, `peerDependencies` and
 * `peerDependenciesMeta`, name for name and value for value, as they are
 * written (a name declared twice, as a dependency and as a peer, is
 * compared twice). A dependency added to a manifest and not yet to the
 * lockfile is a fault even when a sibling's copy of that package happens
 * to be installed where node would find it.
 *
 * And the graph the lockfile describes holds together, by npm's own
 * reading of it. The lockfile is loaded with npm's tree library
 * (`@npmcli/arborist`, the one `npm audit` itself uses), so that which
 * copy of a package an edge resolves to, whether it satisfies its range
 * or the root's `overrides`, where a peer may stand, and what
 * `--omit=dev` leaves out are npm's answers and not a second opinion.
 * From each published workspace the production edges are followed
 * (everything but development dependencies):
 *
 * - an edge npm calls broken (missing, out of range, a peer in the wrong
 *   place) is a fault, unless it is optional and merely absent; and where
 *   an override puts another package in a dependency's place, the package
 *   found must be that one by name, which npm itself does not ask;
 * - a package reached by a required edge that the audit would leave out
 *   is a fault; one reached only by an optional edge and left out is not
 *   shipped, and is no part of the graph;
 * - an optional peer that is installed but outside the range asked is not
 *   a fault (its dependent does without it; what is installed is walked
 *   as what it is), but it is not "in range" either: each is printed as a
 *   note, and the summary counts them.
 *
 * A workspace is published when its `package.json` is not `private`. Run
 * via `npm run lint:audit-coverage`. `--list <workspace>` prints that
 * workspace's production tree as `name@version` lines, then its notes and
 * faults, and exits 1 if there are faults. The repository to read may be
 * given with `--root <folder>`, as the check's own test does.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Arborist from '@npmcli/arborist';

const args = process.argv.slice(2);
/** Takes an option and its value out of the arguments. */
function option_take(name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  return args.splice(at, 2)[1];
}
const root = resolve(option_take('--root') ?? fileURLToPath(new URL('..', import.meta.url)));
const listed = option_take('--list');

const lockFile = join(root, 'package-lock.json');
if (!existsSync(lockFile)) {
  console.error(`audit-coverage: no package-lock.json at ${root}: nothing can be shown to be covered`);
  process.exit(1);
}
const records = JSON.parse(readFileSync(lockFile, 'utf8')).packages ?? {};

/** What `npm audit --omit=dev` omits. */
const OMIT = new Set(['dev']);

/**
 * Every workspace folder with its manifest as it is on disk.
 *
 * @returns {Map<string, Record<string, unknown>>} Folder (from the root) to manifest.
 */
function workspaces_read() {
  const found = new Map();
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const file = join(root, group, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) found.set(`${group}/${entry.name}`, JSON.parse(readFileSync(file, 'utf8')));
    }
  }
  return found;
}

const workspaces = workspaces_read();

/** The fields of a manifest that say what a package needs in production, each compared as written. */
const DECLARATIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];

/**
 * What is wrong with the lockfile's record of a workspace, against the workspace's own manifest.
 *
 * @param {string} dir - The workspace's folder.
 * @returns {string[]} A line per disagreement: the version, and each entry of each production field that one has and the other lacks or states otherwise.
 */
function record_compare(dir) {
  const manifest = workspaces.get(dir);
  const record = records[dir];
  if (manifest === undefined) return [];
  if (record === undefined) return [`${dir} is not in the root lockfile`];
  const faults = [];
  if (record.version !== manifest.version) faults.push(`the lockfile records ${dir} as ${record.version}, and its package.json says ${manifest.version}: the lockfile was left behind by a version bump (make lockfile)`);
  for (const field of DECLARATIONS) {
    const declared = manifest[field] ?? {};
    const recorded = record[field] ?? {};
    for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)])) {
      const [here, there] = [JSON.stringify(declared[name]), JSON.stringify(recorded[name])];
      if (here === there) continue;
      if (there === undefined) faults.push(`${dir}'s package.json has ${name}: ${here} in ${field} and the lockfile's record of ${dir} does not: the lockfile was not regenerated after the manifest changed (make lockfile)`);
      else if (here === undefined) faults.push(`the lockfile's record of ${dir} has ${name}: ${there} in ${field}, which ${dir}'s package.json no longer has (make lockfile)`);
      else faults.push(`${dir}'s package.json has ${name}: ${here} in ${field} and the lockfile's record of ${dir} has ${there} (make lockfile)`);
    }
  }
  return faults;
}

/** The tree the lockfile describes, as npm reads it. */
const tree = await new Arborist({ path: root }).loadVirtual();

/** A node's place in the lockfile, for the words. */
const place_of = (node) => (node.location === '' ? 'the root' : node.location);

/** What npm calls a broken edge, in words. */
const BROKEN = {
  MISSING: 'is not in the root lockfile',
  INVALID: 'is resolved outside the range asked',
  'PEER LOCAL': 'is a peer installed inside its dependent, not at or above it where a peer must be',
  DETACHED: 'has no dependent in the tree',
};

/**
 * Walks one workspace's production graph.
 *
 * @param {string} dir - The workspace's folder.
 * @returns {{ tree: Map<string, string>, faults: string[], notes: string[] }} Every package reached (lockfile path to `name@version`), what is wrong, and what is worth saying that is not a fault.
 */
function tree_walk(dir) {
  const reached = new Map();
  const faults = new Set(record_compare(dir));
  const notes = new Set();
  const start = [...tree.fsChildren].find((node) => node.location === dir);
  if (start === undefined) {
    faults.add(`${dir} is not a workspace of the root lockfile`);
    return { tree: reached, faults: [...faults], notes: [] };
  }
  const queue = [start];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const node = queue.shift();
    for (const edge of node.edgesOut.values()) {
      if (edge.type === 'dev') continue;
      const optional = edge.type === 'optional' || edge.type === 'peerOptional';
      const asked = `${edge.name}@${edge.spec} (${edge.type === 'peerOptional' ? 'an optional peer' : edge.type === 'peer' ? 'a peer' : edge.type === 'optional' ? 'an optional' : 'a'} dependency of ${place_of(node)})`;
      const target = edge.to === null || edge.to === undefined ? null : (edge.to.isLink ? edge.to.target : edge.to);
      // Left out by the audit and reached only optionally: not shipped with its dependent, and no part of
      // this graph, whatever else is true of it.
      if (target !== null && optional && target.shouldOmit(OMIT)) continue;
      // An override that puts another package in a dependency's place (`npm:other@range`) is held to that
      // package by name: npm itself judges such an edge by the version alone.
      const alias = /^npm:(.+)@[^@]*$/.exec(edge.spec ?? '');
      if (target !== null && alias !== null && target.packageName !== alias[1]) {
        faults.add(`${dir}: ${asked} is to be ${alias[1]} and the lockfile has ${target.packageName}@${target.version} at ${place_of(target)}`);
      }
      if (edge.error !== null && edge.error !== undefined) {
        const found = target === null ? '' : `: ${target.name}@${target.version} at ${place_of(target)}`;
        if (edge.error === 'MISSING' && optional) continue;
        const said = `${dir}: ${asked} ${BROKEN[edge.error] ?? `is broken (${edge.error})`}${found}`;
        // An optional peer that is installed but out of range: its dependent does without it. Said, not failed.
        if (edge.type === 'peerOptional' && edge.error === 'INVALID') notes.add(said);
        else faults.add(said);
      }
      if (target === null) continue;
      if (target.shouldOmit(OMIT)) {
        // Left out by the audit. Reached only optionally, it is not shipped; required, the audit misses it.
        if (!optional) faults.add(`${dir}: ${target.name}@${target.version} at ${place_of(target)}, ${asked}, is taken for development-only, so the audit leaves it out`);
        continue;
      }
      // A workspace reached from another is held to its own record as well.
      if (workspaces.has(target.location)) for (const fault of record_compare(target.location)) faults.add(fault);
      reached.set(target.location, `${target.name}@${workspaces.get(target.location)?.version ?? target.version}`);
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return { tree: reached, faults: [...faults], notes: [...notes] };
}

const published = [...workspaces].filter(([, manifest]) => manifest.private !== true).map(([dir]) => dir).sort();

if (listed !== undefined) {
  const dir = published.find((one) => one === listed || workspaces.get(one)?.name === listed);
  if (dir === undefined) { console.error(`audit-coverage: no published workspace ${listed}`); process.exit(2); }
  const walked = tree_walk(dir);
  console.log([...new Set(walked.tree.values())].sort().join('\n'));
  for (const note of walked.notes) console.error(`note: ${note}`);
  for (const fault of walked.faults) console.error(`fault: ${fault}`);
  process.exit(walked.faults.length === 0 ? 0 : 1);
}

const faults = new Set();
const notes = new Set();
let placements = 0;
for (const dir of published) {
  const walked = tree_walk(dir);
  for (const fault of walked.faults) faults.add(fault);
  // The same out-of-range peer is reached from many workspaces: said once, by what it is.
  for (const note of walked.notes) notes.add(note.slice(note.indexOf(': ') + 2));
  placements += walked.tree.size;
}
if (published.length === 0) faults.add('no published workspace was found: the walk covered nothing');
for (const note of notes) console.log(`note: an optional peer is installed outside the range asked: ${note}`);
if (faults.size > 0) {
  console.error(`audit-coverage: the root lockfile does not describe what is shipped; ${faults.size} fault(s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`audit-coverage: the root lockfile holds the production graph of all ${published.length} published workspaces (${placements} package placements): every record agrees with its manifest, every required edge holds by npm's reading, nothing required is left out by the audit${notes.size === 0 ? '' : `; ${notes.size} optional peer(s) installed out of range, noted above`}.`);
