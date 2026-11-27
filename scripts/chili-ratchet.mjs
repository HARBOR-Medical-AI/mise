#!/usr/bin/env node
/**
 * @file The chili ratchet: what still reaches into `@fnndsc/chili` may only
 * shrink, and nothing new may start.
 *
 * chili is being retired (docs/backend-neutral.adoc, #214): its logic goes
 * to salsa, its verbs to brasa's builtins, its rendering to the surfaces.
 * Until that is done, brasa still imports it. This counts brasa's source
 * files that import chili, and the imports themselves, against the
 * committed baseline (`scripts/ratchet-baseline.json`, section `chili`):
 * more than the baseline fails; fewer fails too, with the instruction to
 * lower the baseline in the same change, so a port cannot quietly be undone.
 * An import of chili from any other workspace's sources fails outright:
 * brasa is the only way in.
 *
 * Type-only and dynamic imports count: each is still a reason chili cannot
 * be removed.
 *
 * Usage: node scripts/chili-ratchet.mjs [--root <dir>] [--lower]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An import, re-export or dynamic import naming chili, with or without a subpath. */
const CHILI_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"]@fnndsc\/chili(?:\/[^'"]*)?['"]/g;

/** The one workspace that may import chili, and whose imports are counted. */
const KEEPER = 'packages/brasa';

/**
 * Lists the TypeScript and module sources under a folder.
 *
 * @param {string} dir - The folder.
 * @returns {string[]} The files; none when the folder is not there.
 */
function sources_list(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...sources_list(path)); }
    else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/**
 * Counts the imports of chili under a root.
 *
 * @param {string} root - The repository.
 * @returns {{ files: number, sites: number, outside: string[] }} brasa's files that import chili, its imports in all, and each file of another workspace that imports it.
 */
export function chili_count(root) {
  let files = 0;
  let sites = 0;
  const outside = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || `${group}/${entry.name}` === 'packages/chili') continue;
      const workspace = `${group}/${entry.name}`;
      for (const file of [...sources_list(join(root, workspace, 'src')), ...(workspace === KEEPER ? sources_list(join(root, workspace, 'scripts')) : [])]) {
        const found = readFileSync(file, 'utf8').match(CHILI_IMPORT);
        if (found === null) continue;
        if (workspace === KEEPER) { files++; sites += found.length; }
        else outside.push(relative(root, file));
      }
    }
  }
  return { files, sites, outside };
}

/**
 * Judges a count against the baseline.
 *
 * @param {{ files: number, sites: number, outside: string[] }} now - What was counted.
 * @param {{ files: number, sites: number }} baseline - The committed baseline.
 * @returns {{ faults: string[], fell: boolean }} A line per fault, and whether the count fell below the baseline.
 */
export function chili_judge(now, baseline) {
  const faults = [];
  for (const file of now.outside) faults.push(`${file} imports @fnndsc/chili: only ${KEEPER} may, until it too stops. Use salsa, a brasa builtin, or the surface's own renderer.`);
  let fell = false;
  for (const measure of ['files', 'sites']) {
    if (now[measure] > baseline[measure]) faults.push(`${KEEPER} has ${now[measure]} ${measure === 'files' ? 'files importing' : 'imports of'} @fnndsc/chili, its baseline is ${baseline[measure]}: chili is being retired, and takes no new callers.`);
    else if (now[measure] < baseline[measure]) fell = true;
  }
  if (fell && faults.length === 0) faults.push(`${KEEPER}'s use of @fnndsc/chili fell to ${now.files} file(s), ${now.sites} import(s) (baseline ${baseline.files}, ${baseline.sites}) — good. Lower it in scripts/ratchet-baseline.json as part of this change (npm run lint:chili -- --lower), so the port is kept.`);
  return { faults, fell };
}

/** Runs the check; the exit status is whether it passed. */
function main() {
  const argv = process.argv.slice(2);
  const root = resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : fileURLToPath(new URL('..', import.meta.url)));
  const baselinePath = join(root, 'scripts/ratchet-baseline.json');
  const kept = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baseline = kept.chili;
  if (baseline === undefined || typeof baseline.files !== 'number' || typeof baseline.sites !== 'number') { console.error('chili-ratchet: scripts/ratchet-baseline.json has no "chili" section of files and sites'); process.exit(2); }
  const now = chili_count(root);
  if (argv.includes('--lower')) {
    const stops = chili_judge(now, baseline).faults.filter((fault) => !fault.includes('— good'));
    if (stops.length > 0) { for (const line of stops) console.error(`  ${line}`); console.error('chili-ratchet: nothing lowered: the tree does not pass as it is.'); process.exit(1); }
    kept.chili = { files: Math.min(baseline.files, now.files), sites: Math.min(baseline.sites, now.sites) };
    writeFileSync(baselinePath, `${JSON.stringify(kept, null, 2)}\n`);
    console.log(`chili-ratchet: the baseline is ${kept.chili.files} file(s), ${kept.chili.sites} import(s); none raised.`);
    return;
  }
  const { faults } = chili_judge(now, baseline);
  if (faults.length > 0) {
    console.error(`chili-ratchet: ${faults.length} fault(s):`);
    for (const line of faults) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`chili-ratchet: ${KEEPER} imports @fnndsc/chili from ${now.files} file(s), ${now.sites} import(s), at its baseline; no other workspace imports it.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
