#!/usr/bin/env node
/**
 * @file A published package's entry points are in what it publishes.
 *
 * For each published workspace this asks npm what the package would hold
 * (`npm pack --dry-run --json`: the same file list a release packs) and
 * checks that every way in that its manifest names leads to a file in it:
 * `main`, `types`, each `bin`, and each explicit target under `exports` (a
 * pattern such as `./*` is checked to have at least one file under the
 * folder it points into). A README that tells its reader to install the
 * package globally must belong to a package with a `bin` to run.
 *
 * Run after a build (the entry points are built files). A workspace with no
 * `dist` yet fails here by name, which is the point: it would publish empty.
 *
 * Usage: node scripts/pack-entries.mjs [<workspace> ...]   (default: every published workspace)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a package must go on offering, and must no longer hold, by name: an
 * entry point a README documents is kept under its own name (renaming a bin
 * to another valid file would otherwise pass), and a module that was
 * retired stays out of what is published.
 */
export const PINNED = {
  // chili is deprecated and kept as it is published: the command its README installs, its root and its
  // utilities; and without the two modules retired with stage 5 of the audit fixes (#1541).
  'packages/chili': { bins: ['chili'], exports: ['.', './utils'], absent: ['dist/lfs/lfs.js', 'dist/commands/pipeline/run.js'] },
};

/**
 * Checks a manifest and its packed files against what is pinned for it.
 *
 * @param {Record<string, unknown>} manifest - The package's manifest.
 * @param {string[]} packed - The paths npm would pack.
 * @param {{ bins: string[], exports: string[], absent: string[] }} pinned - What is pinned.
 * @returns {string[]} One line per pin that does not hold.
 */
export function pinned_check(manifest, packed, pinned) {
  const faults = [];
  const held = new Set(packed.map((path) => posix.normalize(path)));
  const bins = typeof manifest.bin === 'string' ? { [String(manifest.name)]: manifest.bin } : manifest.bin ?? {};
  for (const name of pinned.bins) {
    if (bins[name] === undefined) faults.push(`its command ${name} is gone from bin: it is documented and kept`);
    else if (!held.has(posix.normalize(String(bins[name])))) faults.push(`its command ${name} names ${bins[name]}, which is not in the package`);
  }
  const exported = manifest.exports !== null && typeof manifest.exports === 'object' ? manifest.exports : {};
  for (const key of pinned.exports) {
    const targets = exportTargets_list(exported[key]);
    if (targets.length === 0) faults.push(`its export ${key} is gone: it is kept`);
    for (const target of targets) if (!held.has(posix.normalize(target))) faults.push(`its export ${key} names ${posix.normalize(target)}, which is not in the package`);
  }
  for (const path of pinned.absent) if (held.has(posix.normalize(path))) faults.push(`it would publish ${path}, which was retired (a stale build folder: build it clean)`);
  return faults;
}

/**
 * Lists the published workspaces of a root.
 *
 * @param {string} root - The repository.
 * @returns {string[]} Their folders (`packages/chili`).
 */
function published_list(root) {
  const found = [];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const file = join(root, group, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).private !== true) found.push(`${group}/${entry.name}`);
    }
  }
  return found.sort();
}

/**
 * The targets a manifest's `exports` names, flattened.
 *
 * @param {unknown} exported - The `exports` field, or a part of it.
 * @returns {string[]} Every path it leads to.
 */
export function exportTargets_list(exported) {
  if (typeof exported === 'string') return [exported];
  if (exported === null || typeof exported !== 'object') return [];
  return Object.values(exported).flatMap(exportTargets_list);
}

/**
 * Checks one manifest against the files its package would hold.
 *
 * @param {Record<string, unknown>} manifest - The package's manifest.
 * @param {string[]} packed - The paths npm would pack, relative to the package.
 * @param {string} readme - The package's README text, or ''.
 * @returns {string[]} One line per entry point that leads nowhere.
 */
export function entries_check(manifest, packed, readme) {
  const held = new Set(packed.map((path) => posix.normalize(path)));
  const faults = [];
  const named = (what, target) => {
    const path = posix.normalize(String(target));
    if (path.includes('*')) {
      // A pattern: the folder it points into must hold something.
      const folder = path.slice(0, path.indexOf('*'));
      if (![...held].some((file) => file.startsWith(folder))) faults.push(`${what} points into ${folder}, which holds nothing in the package`);
    } else if (!held.has(path)) {
      faults.push(`${what} names ${path}, which is not in the package`);
    }
  };
  if (manifest.main !== undefined) named('main', manifest.main);
  if (manifest.types !== undefined) named('types', manifest.types);
  const bins = typeof manifest.bin === 'string' ? { [String(manifest.name)]: manifest.bin } : manifest.bin ?? {};
  for (const [name, target] of Object.entries(bins)) named(`bin ${name}`, target);
  for (const target of exportTargets_list(manifest.exports)) named('exports', target);
  if (/npm (?:install|i) (?:-g|--global)\b/.test(readme) && Object.keys(bins).length === 0) faults.push('its README says to install it globally, and it has no bin to run');
  return faults;
}

/** Runs the check; the exit status is whether it passed. */
function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const asked = process.argv.slice(2);
  const workspaces = asked.length > 0 ? asked : published_list(root);
  if (workspaces.length === 0) { console.error('pack-entries: no published workspace found'); process.exit(1); }
  const faults = [];
  for (const workspace of workspaces) {
    const dir = join(root, workspace);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    let packed;
    try {
      // --ignore-scripts: what is checked is the tree as built, never a build run from here.
      const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      packed = JSON.parse(out)[0].files.map((file) => file.path);
    } catch (error) {
      faults.push(`${workspace}: npm could not say what it would pack: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`);
      continue;
    }
    const readmePath = join(dir, 'README.md');
    for (const fault of entries_check(manifest, packed, existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '')) faults.push(`${workspace} (${manifest.name}): ${fault}`);
    if (PINNED[workspace] !== undefined) for (const fault of pinned_check(manifest, packed, PINNED[workspace])) faults.push(`${workspace} (${manifest.name}): ${fault}`);
  }
  if (faults.length > 0) {
    console.error(`pack-entries: ${faults.length} fault(s):`);
    for (const fault of faults) console.error(`  ${fault}`);
    process.exit(1);
  }
  console.log(`pack-entries: ${workspaces.length} published package(s): every main, types, bin and exports target is a file the package holds.`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
