/**
 * @file Worker paths — a worker's file is where its `new Worker` says it is.
 *
 * `new Worker(new URL('./x.js', import.meta.url))` names a file beside the
 * built module, and nothing checks the name until the worker is started at
 * run time. A unit test hands in its own runner, so a wrong path passes
 * every test and fails only in a running session, quietly. This check reads
 * each such construction in the sources and requires the source file it
 * names to exist: `./x.js` beside `a/b.ts` must be `a/x.ts` (or `a/x.js`),
 * and a `.ts` path is taken as written.
 *
 * A hard check with no baseline. Run via `npm run lint:workers`; the path
 * to check from may be given as the first argument (used by its own test).
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Matches `new Worker(new URL('<relative path>', import.meta.url)`. */
const WORKER_PATTERN = /new\s+Worker\(\s*new\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Recursively collects .ts and .tsx source files under a directory.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} out - Accumulator for matched file paths.
 * @returns {string[]} The accumulator.
 */
function sourceFiles_collect(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles_collect(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * The source files a worker path may stand for.
 *
 * @param {string} from - The file holding the construction.
 * @param {string} named - The relative path it names.
 * @returns {string[]} Candidate source paths; one must exist.
 */
function workerSources_derive(from, named) {
  const target = resolve(dirname(from), named);
  return target.endsWith('.js') ? [`${target.slice(0, -3)}.ts`, target] : [target];
}

/**
 * Every worker construction under a root whose file is not there.
 *
 * @param {string} root - The repository root to check.
 * @returns {{ found: number, missing: string[] }} How many were read, and those that name no file.
 */
function workerPaths_check(root) {
  const files = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) sourceFiles_collect(join(base, entry.name, 'src'), files);
    }
  }
  let found = 0;
  const missing = [];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf-8').matchAll(WORKER_PATTERN)) {
      found += 1;
      if (!workerSources_derive(file, match[1]).some((candidate) => existsSync(candidate))) {
        missing.push(`${file}: new Worker names ${match[1]}, and no such source file is there`);
      }
    }
  }
  return { found, missing };
}

const { found, missing } = workerPaths_check(process.argv[2] ?? process.cwd());
if (missing.length > 0) {
  for (const line of missing) console.error(line);
  console.error(`worker-paths: ${missing.length} of ${found} worker(s) name a file that is not there.`);
  process.exit(1);
}
console.log(`worker-paths: ${found} worker(s), each names a source file that is there.`);
