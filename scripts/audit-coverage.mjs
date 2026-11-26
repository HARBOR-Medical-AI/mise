/**
 * @file The root audit covers what every published workspace ships.
 *
 * `npm audit --omit=dev` at the root reads the root lockfile and leaves
 * out what the lockfile marks as development-only. That is an audit of a
 * published workspace's production dependencies only if the lockfile
 * really describes them. This walks each published workspace's production
 * graph and fails unless every edge of it holds:
 *
 * - The edges of a workspace are read from its own `package.json` on disk
 *   (what is published), not from the lockfile's copy of it: its
 *   `dependencies`, its `optionalDependencies`, and its `peerDependencies`
 *   that are not marked optional. The edges of an installed package are
 *   the same three kinds as the lockfile records them for it.
 * - Each edge resolves as node resolves it (the nearest `node_modules`
 *   going up; a workspace link followed to its folder). A required edge
 *   that resolves to nothing is a fault. An optional dependency or an
 *   optional peer that the lockfile does not carry is not installed, and
 *   is passed over; one it does carry is walked like any other.
 * - What it resolves to satisfies the range the edge asked for, or the
 *   root's `overrides` for it where the operator set one (an override
 *   that puts another package in its place is held to that package and
 *   version). An optional peer that is present but out of range is passed:
 *   its dependent does without it, and it is walked as what it is. For a
 *   workspace that is the version in the workspace's own `package.json`,
 *   which must also be the version the lockfile records for it: a
 *   lockfile left behind by a version bump is a fault of its own.
 * - Nothing reached is marked development-only (`dev`), or
 *   development-or-optional (`devOptional`) when it was reached by a
 *   required edge: the audit would leave it out.
 *
 * A workspace is published when its `package.json` is not `private`. Run
 * via `npm run lint:audit-coverage`. `--list <workspace>` prints that
 * workspace's production tree as `name@version` lines, then its faults,
 * and exits 1 if there are any. The repository to read may be given with
 * `--root <folder>`, as the check's own test does with its fixtures.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

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
const entries = JSON.parse(readFileSync(lockFile, 'utf8')).packages ?? {};

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

/**
 * Finds a dependency's entry in the lockfile as node would find the package: in the nearest `node_modules` going up.
 *
 * @param {string} from - The lockfile path of the package that asks.
 * @param {string} name - The dependency's name.
 * @returns {string | null} The lockfile path of what it resolves to, a link followed; null when it is not there.
 */
function dependency_find(from, name) {
  let at = from;
  for (;;) {
    const candidate = at === '' ? `node_modules/${name}` : `${at}/node_modules/${name}`;
    const entry = entries[candidate];
    if (entry !== undefined) return entry.link === true ? entry.resolved : candidate;
    if (at === '') return null;
    const cut = at.lastIndexOf('/node_modules/');
    // A workspace's own folder has the root's node_modules above it.
    at = cut === -1 ? '' : at.slice(0, cut);
  }
}

/** The root's overrides: what the operator said a dependency resolves to, whatever its dependents ask. */
const overrides = existsSync(join(root, 'package.json')) ? (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).overrides ?? {}) : {};

/**
 * The root's override for an edge, if there is one.
 *
 * @param {string | undefined} parent - The name of the package that asks.
 * @param {string} name - The dependency asked for.
 * @returns {{ name: string | undefined, range: string, overridden: true } | null} What it must resolve to: a range, and a name when the override puts another package in its place (`npm:other@range`).
 */
function override_find(parent, name) {
  const scoped = parent !== undefined && typeof overrides[parent] === 'object' && overrides[parent] !== null ? overrides[parent][name] : undefined;
  const top = typeof overrides[name] === 'object' && overrides[name] !== null ? overrides[name]['.'] : overrides[name];
  const spec = typeof scoped === 'string' ? scoped : typeof top === 'string' ? top : undefined;
  if (spec === undefined) return null;
  if (!spec.startsWith('npm:')) return { name: undefined, range: spec, overridden: true };
  const cut = spec.lastIndexOf('@');
  return cut <= 4 ? { name: spec.slice(4), range: '*', overridden: true } : { name: spec.slice(4, cut), range: spec.slice(cut + 1), overridden: true };
}

/**
 * The production edges out of one package.
 *
 * @param {string} path - Its lockfile path.
 * @returns {Array<{ name: string, range: string, kind: string, optional: boolean }>} Each edge: what is asked for, in what range, and whether its absence is allowed.
 */
function edges_read(path) {
  // A workspace speaks for itself, from its own manifest; an installed package as the lockfile records it.
  const source = workspaces.get(path) ?? entries[path] ?? {};
  const edges = [];
  for (const [name, range] of Object.entries(source.dependencies ?? {})) edges.push({ name, range, kind: 'dependency', optional: false });
  for (const [name, range] of Object.entries(source.optionalDependencies ?? {})) edges.push({ name, range, kind: 'optional dependency', optional: true });
  for (const [name, range] of Object.entries(source.peerDependencies ?? {})) {
    edges.push({ name, range, kind: 'peer dependency', optional: source.peerDependenciesMeta?.[name]?.optional === true });
  }
  // A name in both `dependencies` and `optionalDependencies` is optional (npm's rule): keep the optional one.
  const optionals = new Set(edges.filter((edge) => edge.kind === 'optional dependency').map((edge) => edge.name));
  return edges.filter((edge) => !(edge.kind === 'dependency' && optionals.has(edge.name)));
}

/**
 * The version a lockfile path stands for, and what is wrong with the record of it.
 *
 * @param {string} path - The lockfile path.
 * @returns {{ name: string | undefined, version: string | undefined, fault: string | null }} A workspace's version is its manifest's.
 */
function version_read(path) {
  const entry = entries[path] ?? {};
  const manifest = workspaces.get(path);
  if (manifest === undefined) return { name: entry.name, version: entry.version, fault: null };
  const fault = entry.version === manifest.version ? null : `the lockfile records ${path} as ${entry.version}, and its package.json says ${manifest.version}: the lockfile was left behind by a version bump (make lockfile)`;
  return { name: manifest.name, version: manifest.version, fault };
}

/**
 * Walks one workspace's production graph.
 *
 * @param {string} dir - The workspace's folder.
 * @returns {{ tree: Map<string, string>, faults: string[] }} Every package reached (lockfile path to `name@version`), and what is wrong.
 */
function tree_walk(dir) {
  const tree = new Map();
  const faults = new Set();
  if (entries[dir] === undefined) faults.add(`${dir} is not in the root lockfile`);
  const own = version_read(dir);
  if (own.fault !== null) faults.add(own.fault);
  const queue = [dir];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const path = queue.shift();
    for (const edge of edges_read(path)) {
      const found = dependency_find(path, edge.name);
      if (found === null || entries[found] === undefined) {
        if (!edge.optional) faults.add(`${dir}: ${edge.name}@${edge.range}, a ${edge.kind} of ${path}, is not in the root lockfile`);
        continue;
      }
      const reached = version_read(found);
      if (reached.fault !== null) faults.add(reached.fault);
      const label = `${reached.name ?? edge.name}@${reached.version ?? '?'}`;
      // What the edge must resolve to: the root's override for it when there is one (that is the operator's
      // word over the package's), else the range it asked for. A range that is a version range is held to;
      // a tag, a file or a git address is not one. An optional peer that is present but out of range is not
      // a fault here: the package does without it, and what is present is walked and audited all the same.
      const wanted = override_find(version_read(path).name, edge.name) ?? { name: undefined, range: edge.range, overridden: false };
      const presentOptionalPeer = edge.kind === 'peer dependency' && edge.optional;
      const nameOk = wanted.name === undefined || entries[found].name === wanted.name;
      const rangeOk = semver.validRange(wanted.range) === null || (reached.version !== undefined && semver.satisfies(reached.version, wanted.range, { includePrerelease: true }));
      if (!presentOptionalPeer && (!nameOk || !rangeOk)) {
        const asked = wanted.overridden ? `${edge.name}@${edge.range}, overridden at the root to ${wanted.name === undefined ? '' : `${wanted.name}@`}${wanted.range},` : `${edge.name}@${edge.range}`;
        faults.add(`${dir}: ${path} asks for ${asked} (a ${edge.kind}) and the lockfile resolves it to ${label} at ${found}`);
      }
      const flags = entries[found];
      if (flags.dev === true) faults.add(`${dir}: ${label} (at ${found}, a ${edge.kind} of ${path}) is marked development-only in the root lockfile, so the audit leaves it out`);
      else if (flags.devOptional === true && !edge.optional) faults.add(`${dir}: ${label} (at ${found}, a required ${edge.kind} of ${path}) is marked development-or-optional in the root lockfile, so the audit may leave it out`);
      tree.set(found, label);
      if (seen.has(found)) continue;
      seen.add(found);
      queue.push(found);
    }
  }
  return { tree, faults: [...faults] };
}

const published = [...workspaces].filter(([, manifest]) => manifest.private !== true).map(([dir]) => dir).sort();

if (listed !== undefined) {
  const dir = published.find((one) => one === listed || workspaces.get(one)?.name === listed);
  if (dir === undefined) { console.error(`audit-coverage: no published workspace ${listed}`); process.exit(2); }
  const walked = tree_walk(dir);
  console.log([...new Set(walked.tree.values())].sort().join('\n'));
  for (const fault of walked.faults) console.error(`fault: ${fault}`);
  process.exit(walked.faults.length === 0 ? 0 : 1);
}

const faults = new Set();
let reached = 0;
for (const dir of published) {
  const walked = tree_walk(dir);
  for (const fault of walked.faults) faults.add(fault);
  reached += walked.tree.size;
}
if (published.length === 0) faults.add('no published workspace was found: the walk covered nothing');
if (faults.size > 0) {
  console.error(`audit-coverage: the root lockfile does not describe what is shipped; ${faults.size} fault(s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`audit-coverage: the root lockfile holds the production graph of all ${published.length} published workspaces (${reached} package placements): every edge resolved, in range, and none marked development-only.`);
