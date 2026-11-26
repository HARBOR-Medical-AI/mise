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
 * (`@npmcli/arborist`): the copy inside the npm that runs this script,
 * which is the one that npm's `audit` reads the tree with, so that which
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
 * - a package that is installed and wanted in production, and that the
 *   audit would leave out, is a fault: reached by a required edge, or as
 *   an optional dependency that is installed. Only an optional peer the
 *   lockfile carries for development alone is passed over: it is not
 *   shipped, and is no part of the graph;
 * - a workspace's peer that the workspace also lists for development has,
 *   in npm's tree, only the development edge, at the development range.
 *   What is published is the peer: it is judged here at the peer's range,
 *   and its only copy being development's is a fault;
 * - a registry package with no version recorded cannot be looked up by
 *   the audit, and is a fault though npm sees nothing wrong with the edge;
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
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * Loads npm's tree library, and the `semver` it uses, from the npm that is
 * running this: `npm run` says where it lives (`npm_execpath`), and its
 * own copy of `@npmcli/arborist` is the one its `audit` reads the tree
 * with. Run without npm (`node scripts/audit-coverage.mjs`), the copy
 * among this repository's dev dependencies is used, pinned to the version
 * the repository's npm (`packageManager`) carries.
 *
 * @returns {{ Arborist: new (options: { path: string }) => { loadVirtual(): Promise<any> }, semver: any, from: string }} The library, its semver, and which copy it is.
 */
function arborist_load() {
  const execPath = process.env.npm_execpath ?? '';
  const candidates = [];
  if (execPath !== '') candidates.push(join(dirname(dirname(execPath)), 'node_modules', '@npmcli', 'arborist', 'package.json'));
  candidates.push(createRequire(import.meta.url).resolve('@npmcli/arborist/package.json'));
  for (const manifest of candidates) {
    if (!existsSync(manifest)) continue;
    const load = createRequire(manifest);
    // npm's own judgement of whether what is installed is what a spec asks for (a range, a tag, a tarball
    // address, a git ref, an alias): the function its edges use. Not part of the library's public face, so
    // its absence is allowed for, and said where it matters.
    let specValid = null;
    try { specValid = load(join(dirname(manifest), 'lib', 'dep-valid.js')); } catch { specValid = null; }
    return { Arborist: load(dirname(manifest)), semver: load('semver'), specValid, from: `@npmcli/arborist ${JSON.parse(readFileSync(manifest, 'utf8')).version}${manifest === candidates[0] && execPath !== '' ? ', the running npm\'s own' : ', this repository\'s dev dependency'}` };
  }
  throw new Error('npm\'s tree library (@npmcli/arborist) was not found');
}
const { Arborist, semver, specValid, from: arboristFrom } = arborist_load();

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

/** The root's overrides: what the operator said a dependency resolves to, whatever its dependents ask. */
const overrides = existsSync(join(root, 'package.json')) ? (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).overrides ?? {}) : {};

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

/** The words for each kind of production edge. */
const KIND_WORDS = { prod: 'a', optional: 'an optional', peer: 'a peer', peerOptional: 'an optional peer' };

/**
 * What a spec asks for when it is read by hand: an alias's package and range, or a range.
 *
 * @param {string} spec - The spec as written (`^1.0.0`, `npm:other@^1`, `npm:other`, a tag, a file).
 * @returns {{ alias: string | null, range: string | null }} The package an alias names, and the range when the spec has one that is a version range.
 */
function spec_read(spec) {
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(spec ?? '');
  const range = alias === null ? spec : (alias[2] ?? '*');
  return { alias: alias === null ? null : alias[1], range: semver.validRange(range) === null ? null : range };
}

/**
 * The production declarations a workspace publishes, one per name: what those who install it are given.
 *
 * @param {Record<string, unknown>} manifest - The workspace's `package.json`.
 * @returns {Map<string, { type: string, spec: string }>} Name to kind and spec. A name in several fields is what npm installs it as: optional before required, a dependency before a peer.
 */
function published_read(manifest) {
  const declared = new Map();
  for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) declared.set(name, { type: manifest.peerDependenciesMeta?.[name]?.optional === true ? 'peerOptional' : 'peer', spec });
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) declared.set(name, { type: 'prod', spec });
  for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) declared.set(name, { type: 'optional', spec });
  return declared;
}

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
  /** Takes a package into the graph: says what it is, and walks on from it. */
  const node_take = (target) => {
    // What the audit looks a package up by: its own name and version. Under an alias that is not the name it
    // is installed as; both are said.
    const identity = `${target.packageName ?? target.name}@${workspaces.get(target.location)?.version ?? target.version}`;
    const aliased = !workspaces.has(target.location) && typeof target.packageName === 'string' && target.packageName !== target.name;
    reached.set(target.location, aliased ? `${identity} (installed as ${target.name})` : identity);
    // A workspace reached from another is held to its own record as well.
    if (workspaces.has(target.location)) for (const fault of record_compare(target.location)) faults.add(fault);
    // A package from a registry is audited by its version; with none recorded the audit passes over it.
    else if (typeof target.version !== 'string' || target.version === '') faults.add(`${dir}: ${target.name} at ${place_of(target)} has no version in the root lockfile, so the audit cannot look it up`);
    if (seen.has(target)) return;
    seen.add(target);
    queue.push(target);
  };
  /**
   * Judges one production edge and, if what it leads to is shipped, takes that into the graph.
   *
   * @param {object} node - The package the edge leaves.
   * @param {{ name: string, type: string, spec: string, also?: string }} asks - What is asked: the name, the kind, the spec, and the development spec that shadows it, if one does.
   * @param {object | null} target - What it resolves to, a link followed; null for nothing.
   * @param {string | null} error - What is wrong with the edge: npm's word for it, or one worked out here for an edge npm does not keep.
   */
  const edge_judge = (node, asks, target, error) => {
    const optional = asks.type === 'optional' || asks.type === 'peerOptional';
    const asked = `${asks.name}@${asks.spec} (${KIND_WORDS[asks.type]} dependency of ${place_of(node)}${asks.also === undefined ? '' : `, which also lists it for development as ${asks.also}`})`;
    if (target === null) {
      // Absent. An optional one is simply not installed; a required one is missing.
      if (!optional) faults.add(`${dir}: ${asked} ${BROKEN.MISSING}`);
      return;
    }
    // An optional peer the lockfile carries only for development is not shipped with its dependent: a
    // production install does not have it, and it is no part of this graph. (An optional dependency that
    // is installed is another matter: it is shipped, and one left out by the audit is a fault, below.)
    if (asks.type === 'peerOptional' && target.shouldOmit(OMIT)) return;
    // An override or a declaration that puts another package in a name's place (`npm:other`,
    // `npm:other@range`) is held to that package by name: npm itself judges such an edge by version alone.
    const { alias } = spec_read(asks.spec);
    if (alias !== null && target.packageName !== alias) {
      faults.add(`${dir}: ${asked} is to be ${alias} and the lockfile has ${target.packageName}@${target.version} at ${place_of(target)}`);
    }
    if (error !== null && error !== undefined && error !== 'MISSING') {
      const said = `${dir}: ${asked} ${BROKEN[error] ?? `is broken (${error})`}: ${target.name}@${target.version} at ${place_of(target)}`;
      // An optional peer that is installed but out of range: its dependent does without it. Said, not failed.
      if (asks.type === 'peerOptional' && error === 'INVALID') notes.add(said);
      else faults.add(said);
    }
    if (target.shouldOmit(OMIT)) {
      // Installed, wanted in production (an optional dependency that is installed is shipped), and left
      // out by the audit.
      faults.add(`${dir}: ${target.name}@${target.version} at ${place_of(target)}, ${asked}, is taken for development-only, so the audit leaves it out`);
      return;
    }
    node_take(target);
  };
  /** What an edge of npm's leads to, a link followed. */
  const target_of = (edge) => (edge === undefined || edge.to === null || edge.to === undefined ? null : (edge.to.isLink ? edge.to.target : edge.to));
  while (queue.length > 0) {
    const node = queue.shift();
    // A name a workspace publishes (as a dependency, an optional one, or a peer) and also lists for
    // development has, in npm's tree, one edge: the development one, at the development spec. What is
    // published is the other declaration. Each such name is judged here as what is published, by hand:
    // the same checks, with the range read by semver since npm has no edge to ask.
    const own = workspaces.get(node.location);
    const shadowed = new Set();
    if (own !== undefined) {
      for (const [name, declared] of published_read(own)) {
        const edge = node.edgesOut.get(name);
        if (edge !== undefined && edge.type !== 'dev') continue;
        shadowed.add(name);
        const target = target_of(edge);
        // What must be matched: the root's override for the name when there is one (by the name alone, or
        // under this workspace's name), else the spec the workspace declares.
        const scoped = typeof overrides[own.name] === 'object' && overrides[own.name] !== null ? overrides[own.name][name] : undefined;
        const top = typeof overrides[name] === 'object' && overrides[name] !== null ? overrides[name]['.'] : overrides[name];
        const spec = typeof scoped === 'string' ? scoped : typeof top === 'string' ? top : declared.spec;
        let error = null;
        if (target !== null) {
          if (specValid !== null) {
            // npm's own answer, for any kind of spec.
            if (!specValid(target, spec, null, node)) error = 'INVALID';
          } else {
            // Without npm's function only a version range can be judged here; anything else is not
            // passed on trust.
            const { range } = spec_read(spec);
            if (range === null) faults.add(`${dir}: ${name}@${spec}, which ${place_of(node)} publishes and also lists for development, cannot be checked against ${target.name}@${target.version} at ${place_of(target)}: the spec is not a version range and npm's own check was not found`);
            else if (!semver.satisfies(target.version ?? '', range)) error = 'INVALID';
          }
        }
        edge_judge(node, { name, type: declared.type, spec, ...(edge === undefined ? {} : { also: edge.spec }) }, target, error);
      }
    }
    for (const edge of node.edgesOut.values()) {
      if (edge.type === 'dev' || shadowed.has(edge.name)) continue;
      edge_judge(node, { name: edge.name, type: edge.type, spec: edge.spec }, target_of(edge), edge.error ?? null);
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
console.log(`audit-coverage: the root lockfile holds the production graph of all ${published.length} published workspaces (${placements} package placements): every record agrees with its manifest, every required edge holds by npm's reading, nothing shipped is left out by the audit${notes.size === 0 ? '' : `; ${notes.size} optional peer(s) installed out of range, noted above`}. Read with ${arboristFrom}.`);
