/**
 * @file The root audit covers what every published workspace ships.
 *
 * `npm audit --omit=dev` at the root reads the root lockfile and leaves
 * out what the lockfile marks as development-only. That is an audit of a
 * published workspace's production dependencies only if all of them, with
 * everything they pull in, are in that lockfile and none is marked
 * development-only there. This walks each published workspace's
 * production tree through the root lockfile, the way node resolves it
 * (nearest `node_modules` first), and fails on a dependency that is not in
 * the lockfile or that the audit would leave out.
 *
 * A workspace is published when its `package.json` is not `private`. Run
 * via `npm run lint:audit-coverage`; `--list <workspace>` prints that
 * workspace's production tree as `name@version` lines.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const entries = lock.packages ?? {};

/**
 * The published workspaces: folder and manifest.
 *
 * @returns {Array<{ dir: string, manifest: Record<string, unknown> }>} One per workspace that is not private.
 */
function published_list() {
  const found = [];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const file = join(root, group, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (manifest.private !== true) found.push({ dir: `${group}/${entry.name}`, manifest });
    }
  }
  return found;
}

/**
 * Finds a dependency's entry in the lockfile as node would find the package: in the nearest `node_modules` going up.
 *
 * @param {string} from - The lockfile path of the package that asks ('' for the root).
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
    at = cut === -1 ? '' : at.slice(0, cut);
  }
}

/**
 * Walks one workspace's production tree.
 *
 * @param {string} dir - The workspace's folder.
 * @returns {{ tree: Map<string, string>, faults: string[] }} Every package reached (lockfile path to `name@version`), and what is wrong.
 */
function tree_walk(dir) {
  const tree = new Map();
  const faults = [];
  const queue = [{ path: dir, via: dir }];
  while (queue.length > 0) {
    const { path, via } = queue.shift();
    const entry = entries[path];
    if (entry === undefined) { faults.push(`${via}: ${path} is not in the root lockfile`); continue; }
    for (const [kind, optional] of [['dependencies', false], ['optionalDependencies', true]]) {
      for (const name of Object.keys(entry[kind] ?? {})) {
        const found = dependency_find(path, name);
        if (found === null) {
          // A platform's optional package the lockfile does not carry is not installed anywhere it is not carried.
          if (!optional) faults.push(`${dir}: ${name} (needed by ${path}) is not in the root lockfile`);
          continue;
        }
        if (tree.has(found)) continue;
        const reached = entries[found] ?? {};
        tree.set(found, `${reached.name ?? name}@${reached.version ?? '?'}`);
        if (reached.dev === true) faults.push(`${dir}: ${name}@${reached.version} (at ${found}) is marked development-only in the root lockfile, so the audit leaves it out`);
        queue.push({ path: found, via: `${dir} > ${name}` });
      }
    }
  }
  return { tree, faults };
}

const workspaces = published_list();
if (process.argv[2] === '--list') {
  const asked = workspaces.find((one) => one.dir === process.argv[3] || one.manifest.name === process.argv[3]);
  if (asked === undefined) { console.error(`no published workspace ${process.argv[3]}`); process.exit(2); }
  console.log([...new Set(tree_walk(asked.dir).tree.values())].sort().join('\n'));
  process.exit(0);
}

const faults = [];
let reached = 0;
for (const { dir } of workspaces) {
  const walked = tree_walk(dir);
  faults.push(...walked.faults);
  reached += walked.tree.size;
}
if (workspaces.length === 0) faults.push('no published workspace was found: the walk covered nothing');
if (faults.length > 0) {
  console.error(`audit-coverage: the root audit does not cover ${faults.length} production dependency(ies):`);
  for (const fault of faults) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`audit-coverage: the root lockfile holds the production tree of all ${workspaces.length} published workspaces (${reached} package placements), none marked development-only.`);
