/**
 * @file The root audit covers what every published workspace ships.
 *
 * `npm audit --omit=dev` at the root reads the root lockfile and leaves
 * out what the lockfile marks as development-only. That is an audit of a
 * published workspace's production dependencies only if the lockfile
 * really describes them. This walks each published workspace's production
 * graph and fails unless every part of it holds:
 *
 * - The lockfile's record of a workspace says what the workspace's own
 *   `package.json` says: the same version, and the same production
 *   declarations (`dependencies`, `optionalDependencies`,
 *   `peerDependencies` and which of those are optional), name for name
 *   and range for range. A dependency added to a manifest and not yet to
 *   the lockfile is a fault even when a sibling's copy of that package
 *   happens to be installed where node would find it.
 * - The edges of a workspace are read from its `package.json` on disk
 *   (what is published); those of an installed package from the
 *   lockfile's record of it. Three kinds: dependencies, optional
 *   dependencies, peer dependencies.
 * - A dependency resolves as node resolves it (the nearest `node_modules`
 *   going up; a workspace link followed to its folder). A peer is looked
 *   for from the folder its dependent stands in, upward: at or above the
 *   dependent, never inside it. A required edge that resolves to nothing
 *   is a fault. An optional dependency or an optional peer that the
 *   lockfile does not carry is not installed, and is passed over; one it
 *   does carry is walked like any other.
 * - What a required edge resolves to satisfies its range, by npm's own
 *   matching (a prerelease satisfies only a range that names one), or the
 *   root's `overrides` for it where the operator set one: by the
 *   dependency's name, or by its dependent's name and then its own. An
 *   override that puts another package in its place is held to that
 *   package and version.
 * - Nothing reached is marked development-only (`dev`), or
 *   development-or-optional (`devOptional`) when it was reached by a
 *   required edge: the audit would leave it out.
 *
 * A name a package both depends on and names as a peer is its dependency:
 * that edge speaks for it. An optional peer the lockfile carries only for
 * development is not shipped, and is no part of the graph.
 *
 * An optional peer that is installed but outside the range its dependent
 * named is not a fault (the dependent does without it, and what is
 * installed is walked and audited as what it is), but it is not "in
 * range" either: each is printed as a note, and the summary counts them.
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

/** The marker that parts a package's folder from the folder it is installed in. */
const NESTED = '/node_modules/';

/**
 * The folder a lockfile path is installed in: what stands above it.
 *
 * @param {string} path - A lockfile path.
 * @returns {string} The path of the package (or workspace) whose `node_modules` holds it; '' for the root's, and for a workspace.
 */
function holder_of(path) {
  const cut = path.lastIndexOf(NESTED);
  if (cut !== -1) return path.slice(0, cut);
  return '';
}

/**
 * Finds a package's entry in the lockfile as node would find the package: in the nearest `node_modules` going up.
 *
 * @param {string} from - The lockfile path whose `node_modules` is looked in first.
 * @param {string} name - The package's name.
 * @returns {string | null} The lockfile path of what it resolves to, a link followed; null when it is not there.
 */
function dependency_find(from, name) {
  let at = from;
  for (;;) {
    const candidate = at === '' ? `node_modules/${name}` : `${at}/node_modules/${name}`;
    const entry = entries[candidate];
    if (entry !== undefined) return entry.link === true ? entry.resolved : candidate;
    if (at === '') return null;
    at = holder_of(at);
  }
}

/**
 * The name a lockfile path is installed under.
 *
 * @param {string} path - A lockfile path.
 * @returns {string | undefined} A workspace's own name; else the name in its `node_modules` folder, which is what its dependents ask for (a registry entry usually records no name of its own).
 */
function name_of(path) {
  const manifest = workspaces.get(path);
  if (manifest !== undefined) return manifest.name;
  const cut = path.lastIndexOf(NESTED);
  if (cut !== -1) return path.slice(cut + NESTED.length);
  return path.startsWith('node_modules/') ? path.slice('node_modules/'.length) : entries[path]?.name;
}

/**
 * The production declarations of a manifest or of a lockfile record, as one comparable list.
 *
 * @param {Record<string, unknown>} source - A `package.json`, or a lockfile's record of a package.
 * @returns {Array<{ name: string, range: string, kind: string, optional: boolean }>} Each edge: what is asked for, in what range, of what kind, and whether its absence is allowed.
 */
function declarations_read(source) {
  const edges = [];
  for (const [name, range] of Object.entries(source.dependencies ?? {})) edges.push({ name, range, kind: 'dependency', optional: false });
  for (const [name, range] of Object.entries(source.optionalDependencies ?? {})) edges.push({ name, range, kind: 'optional dependency', optional: true });
  for (const [name, range] of Object.entries(source.peerDependencies ?? {})) {
    edges.push({ name, range, kind: 'peer dependency', optional: source.peerDependenciesMeta?.[name]?.optional === true });
  }
  // A name in both `dependencies` and `optionalDependencies` is optional (npm's rule): keep the optional one.
  // A name a package both depends on and names as a peer is installed as its dependency, and that is the
  // copy it loads: the dependency edge speaks for it.
  const optionals = new Set(edges.filter((edge) => edge.kind === 'optional dependency').map((edge) => edge.name));
  const owned = new Set(edges.filter((edge) => edge.kind !== 'peer dependency').map((edge) => edge.name));
  return edges.filter((edge) => !(edge.kind === 'dependency' && optionals.has(edge.name)) && !(edge.kind === 'peer dependency' && owned.has(edge.name)));
}

/**
 * The production edges out of one package: a workspace speaks for itself, from its own manifest; an installed package as the lockfile records it.
 *
 * @param {string} path - Its lockfile path.
 * @returns {Array<{ name: string, range: string, kind: string, optional: boolean }>} Its edges.
 */
function edges_read(path) {
  return declarations_read(workspaces.get(path) ?? entries[path] ?? {});
}

/**
 * What is wrong with the lockfile's record of a workspace, against the workspace's own manifest.
 *
 * @param {string} dir - The workspace's folder.
 * @returns {string[]} A line per disagreement: the version, and each production declaration that one has and the other lacks or states otherwise.
 */
function record_compare(dir) {
  const manifest = workspaces.get(dir);
  const record = entries[dir];
  if (manifest === undefined) return [];
  if (record === undefined) return [`${dir} is not in the root lockfile`];
  const faults = [];
  if (record.version !== manifest.version) faults.push(`the lockfile records ${dir} as ${record.version}, and its package.json says ${manifest.version}: the lockfile was left behind by a version bump (make lockfile)`);
  const spell = (edge) => `${edge.name}@${edge.range} (${edge.optional && edge.kind === 'peer dependency' ? 'an optional ' : 'a '}${edge.kind})`;
  const declared = new Map(declarations_read(manifest).map((edge) => [edge.name, spell(edge)]));
  const recorded = new Map(declarations_read(record).map((edge) => [edge.name, spell(edge)]));
  for (const [name, said] of declared) {
    if (!recorded.has(name)) faults.push(`${dir}'s package.json declares ${said} and the lockfile's record of ${dir} does not have it: the lockfile was not regenerated after the manifest changed (make lockfile)`);
    else if (recorded.get(name) !== said) faults.push(`${dir}'s package.json declares ${said} and the lockfile's record of ${dir} has ${recorded.get(name)} (make lockfile)`);
  }
  for (const [name, said] of recorded) {
    if (!declared.has(name)) faults.push(`the lockfile's record of ${dir} has ${said}, which ${dir}'s package.json no longer declares (make lockfile)`);
  }
  return faults;
}

/** The root's overrides: what the operator said a dependency resolves to, whatever its dependents ask. */
const overrides = existsSync(join(root, 'package.json')) ? (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).overrides ?? {}) : {};

/**
 * The root's override for an edge, if there is one.
 *
 * @param {string | undefined} parent - The name the package that asks is installed under.
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
 * The version a lockfile path stands for: a workspace's is its manifest's.
 *
 * @param {string} path - The lockfile path.
 * @returns {string | undefined} The version.
 */
function version_of(path) {
  return workspaces.get(path)?.version ?? entries[path]?.version;
}

/**
 * Walks one workspace's production graph.
 *
 * @param {string} dir - The workspace's folder.
 * @returns {{ tree: Map<string, string>, faults: string[], notes: string[] }} Every package reached (lockfile path to `name@version`), what is wrong, and what is worth saying that is not a fault.
 */
function tree_walk(dir) {
  const tree = new Map();
  const faults = new Set(record_compare(dir));
  const notes = new Set();
  const queue = [dir];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const path = queue.shift();
    for (const edge of edges_read(path)) {
      const peer = edge.kind === 'peer dependency';
      // A peer is provided by whoever holds its dependent: looked for from there upward, never inside the dependent.
      const found = dependency_find(peer ? holder_of(path) : path, edge.name);
      if (found === null || entries[found] === undefined) {
        if (edge.optional) continue;
        const inside = peer && entries[`${path}/node_modules/${edge.name}`] !== undefined;
        faults.add(inside
          ? `${dir}: ${edge.name}@${edge.range}, a peer dependency of ${path}, is installed only inside ${path}, not at or above it where a peer must be`
          : `${dir}: ${edge.name}@${edge.range}, a ${edge.kind} of ${path}, is not in the root lockfile`);
        continue;
      }
      // An optional peer that the lockfile carries only for development is not shipped with the dependent: a
      // production install does not have it, the dependent does without it, and it is no part of this graph.
      if (peer && edge.optional && (entries[found].dev === true || entries[found].devOptional === true)) continue;
      // A workspace reached from another is held to its own record as well.
      for (const fault of record_compare(found)) faults.add(fault);
      const version = version_of(found);
      const label = `${workspaces.get(found)?.name ?? entries[found].name ?? edge.name}@${version ?? '?'}`;
      // What the edge must resolve to: the root's override for it when there is one (that is the operator's
      // word over the package's), else the range it asked for. A range that is a version range is held to,
      // by npm's own matching; a tag, a file or a git address is not one.
      const wanted = override_find(name_of(path), edge.name) ?? { name: undefined, range: edge.range, overridden: false };
      const nameOk = wanted.name === undefined || entries[found].name === wanted.name;
      const rangeOk = semver.validRange(wanted.range) === null || (version !== undefined && semver.satisfies(version, wanted.range));
      if (!nameOk || !rangeOk) {
        const asked = wanted.overridden ? `${edge.name}@${edge.range}, overridden at the root to ${wanted.name === undefined ? '' : `${wanted.name}@`}${wanted.range},` : `${edge.name}@${edge.range}`;
        const said = `${dir}: ${path} asks for ${asked} (${edge.optional && peer ? 'an optional ' : 'a '}${edge.kind}) and the lockfile resolves it to ${label} at ${found}`;
        // An optional peer that is installed but out of range: its dependent does without it. Said, not failed.
        if (peer && edge.optional) notes.add(said);
        else faults.add(said);
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
  return { tree, faults: [...faults], notes: [...notes] };
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
let reached = 0;
for (const dir of published) {
  const walked = tree_walk(dir);
  for (const fault of walked.faults) faults.add(fault);
  // The same out-of-range peer is reached from many workspaces: said once, by what it is.
  for (const note of walked.notes) notes.add(note.slice(note.indexOf(': ') + 2));
  reached += walked.tree.size;
}
if (published.length === 0) faults.add('no published workspace was found: the walk covered nothing');
for (const note of notes) console.log(`note: an optional peer is installed outside the range asked: ${note}`);
if (faults.size > 0) {
  console.error(`audit-coverage: the root lockfile does not describe what is shipped; ${faults.size} fault(s):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`audit-coverage: the root lockfile holds the production graph of all ${published.length} published workspaces (${reached} package placements): every record agrees with its manifest, every required edge resolved and in range, none marked development-only${notes.size === 0 ? '' : `; ${notes.size} optional peer(s) installed out of range, noted above`}.`);
