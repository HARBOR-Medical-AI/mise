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
 * Type-only and dynamic imports and a literal `require` count: each is
 * still a reason chili cannot be removed. Every workspace's sources and
 * scripts are read (`.ts`, `.js`, `.mjs`, `.cjs` and their kin) as the
 * compiler reads them, so a comment or a string that shows an import is
 * not one. The
 * baseline itself is held to the change's base (`scripts/lib/ratchetBase.mjs`):
 * a change that adds an import and raises the baseline to admit it fails.
 *
 * Usage: node scripts/chili-ratchet.mjs [--root <dir>] [--lower]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { base_resolve, ceilings_compare, ceilings_read, fileAtCommit_read } from './lib/ratchetBase.mjs';

/** The baseline file, from the repository's root. */
const BASELINE_FILE = 'scripts/ratchet-baseline.json';

/** A module specifier that is chili, with or without a subpath. */
const CHILI_MODULE = /^@fnndsc\/chili(?:\/|$)/;

/** The sources read: TypeScript and JavaScript, modules and scripts. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

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
    else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/**
 * The references to chili a source makes, read as the compiler reads them
 * (`ts.preProcessFile`): `import` and `export … from`, a type-only import,
 * a dynamic `import()` and a `require()` of a literal. A comment, a string
 * that merely holds such a line, and an example in a doc block are not
 * references.
 *
 * @param {string} text - The source.
 * @returns {string[]} Each chili specifier it references, once per reference.
 */
export function chiliRefs_read(text) {
  return ts.preProcessFile(text, true, true).importedFiles.map((imported) => imported.fileName).filter((name) => CHILI_MODULE.test(name));
}

/**
 * Compares the baseline as it would stand with the same section at the
 * change's base: neither count may be higher here. A base whose baseline
 * file has no chili section is from before this ratchet, and holds nothing
 * to compare with.
 *
 * @param {{ files: number, sites: number }} here - The baseline in this change.
 * @param {string} root - The repository.
 * @returns {string[]} One line per count raised against the base.
 * @throws {Error} When the base cannot be resolved or its file cannot be read.
 */
export function chiliBase_compare(here, root) {
  const base = base_resolve(process.env, root);
  const text = fileAtCommit_read(base.sha, BASELINE_FILE, root);
  if (text === null || JSON.parse(text).chili === undefined) return [];
  const atBase = ceilings_read(text, 'chili', `${BASELINE_FILE} at the base (${base.sha.slice(0, 8)})`);
  return ceilings_compare(here, atBase, 'chili').map((line) => `${line} (base: ${base.how}, ${base.sha.slice(0, 8)})`);
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
      // Its sources and its scripts: what ships and what builds it.
      for (const file of [...sources_list(join(root, workspace, 'src')), ...sources_list(join(root, workspace, 'scripts'))]) {
        const found = chiliRefs_read(readFileSync(file, 'utf8'));
        if (found.length === 0) continue;
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
  const baselinePath = join(root, BASELINE_FILE);
  const kept = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baseline = kept.chili;
  if (baseline === undefined || typeof baseline.files !== 'number' || typeof baseline.sites !== 'number') { console.error(`chili-ratchet: ${BASELINE_FILE} has no "chili" section of files and sites`); process.exit(2); }
  const now = chili_count(root);
  const lowering = argv.includes('--lower');
  // The baseline as it would stand: as committed, or (for --lower) lowered to what was counted.
  const next = lowering ? { files: Math.min(baseline.files, now.files), sites: Math.min(baseline.sites, now.sites) } : baseline;
  const faults = chili_judge(now, baseline).faults.filter((fault) => !(lowering && fault.includes('— good')));
  // Against the base: a baseline raised in the same change as the import it admits is no baseline.
  try { faults.push(...chiliBase_compare(next, root)); } catch (error) { faults.push(`the baseline could not be compared with the base's: ${error.message}`); }
  if (faults.length > 0) {
    console.error(`chili-ratchet: ${faults.length} fault(s):`);
    for (const line of faults) console.error(`  ${line}`);
    if (lowering) console.error('chili-ratchet: nothing lowered: the tree does not pass as it is.');
    process.exit(1);
  }
  if (lowering) {
    kept.chili = next;
    writeFileSync(baselinePath, `${JSON.stringify(kept, null, 2)}\n`);
    console.log(`chili-ratchet: the baseline is ${next.files} file(s), ${next.sites} import(s); none raised.`);
    return;
  }
  console.log(`chili-ratchet: ${KEEPER} imports @fnndsc/chili from ${now.files} file(s), ${now.sites} import(s), at its baseline and no higher than the base's; no other workspace imports it.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
