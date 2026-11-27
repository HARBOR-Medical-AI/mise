/**
 * @file Runs a workspace's jest suite with coverage, and holds the result
 * to the workspace's coverage floors when the whole suite was run.
 *
 * Every argument is jest's: `npm test -- --runInBand`, `npm test -- -t
 * "one case"` and `npm test -- tests/unit/one.test.ts` reach jest as they
 * are written, and none of them reaches the ratchet.
 *
 * The floors are for the whole suite, measured over the workspace's own
 * sources. Whether a run is that is read from jest's own reading of the
 * arguments (`jest-cli`'s `buildArgv`), so every spelling jest takes is
 * taken the same way here: a run is whole when it names no test, and every
 * option it gives is one known only to say how to run (`--runInBand`,
 * `--maxWorkers=2`, `--testTimeout=10000`). Anything else (a selector, a
 * change of what coverage is collected from or where and how it is
 * reported, an option not known here) makes it a run of its own.
 *
 * A whole run writes the suite's report (`coverage/`), and the floors are
 * judged from that report only if this run wrote it. A run of its own
 * writes elsewhere (`coverage-partial/`, or where it says), is not judged,
 * and may not write over the suite's report.
 *
 * Run from the workspace's folder, by its `test` script.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Jest's options, by the names jest gives them once read, that say how to run and nothing about what. */
const HOW = new Set([
  'coverage', 'collectCoverage', 'runInBand', 'i', 'maxWorkers', 'w', 'ci', 'silent', 'verbose', 'colors', 'color', 'forceExit', 'detectOpenHandles',
  'openHandlesTimeout', 'cache', 'testTimeout', 'bail', 'b', 'seed', 'showSeed', 'randomize', 'logHeapUsage', 'workerIdleMemoryLimit', 'workerThreads',
  'maxConcurrency', 'useStderr', 'noStackTrace', 'errorOnDeprecated', 'debug', 'expand', 'e', 'notify', 'passWithNoTests', 'detectLeaks', 'testFailureExitCode',
]);

/** Where the whole suite's report is written, and where a run of its own writes by default, from the workspace's folder. */
export const SUITE_DIR = 'coverage';
export const PARTIAL_DIR = 'coverage-partial';

/**
 * What to do with a run, from jest's own reading of its arguments.
 *
 * @param {Record<string, unknown>} read - The arguments as `buildArgv` read them.
 * @param {string[]} args - The arguments as they were written.
 * @param {string} workspaceDir - The workspace's folder.
 * @returns {{ whole: boolean, why: string, jestArgs: string[], refused: string | null }} Whether the run is the whole suite, why not when it is not, what jest is run with, and a refusal when the run would write over the suite's report.
 */
export function run_plan(read, args, workspaceDir) {
  const named = Array.isArray(read._) ? read._.map(String) : [];
  const given = Object.keys(read).filter((key) => key !== '_' && key !== '$0');
  const other = given.filter((key) => !HOW.has(key) || ((key === 'coverage' || key === 'collectCoverage') && read[key] === false));
  if (named.length === 0 && other.length === 0) {
    return {
      whole: true, why: '', refused: null,
      jestArgs: [...args, '--coverage', `--coverageDirectory=${resolve(workspaceDir, SUITE_DIR)}`, '--coverageReporters=json-summary', '--coverageReporters=text-summary'],
    };
  }
  const why = named.length > 0 ? `it names tests (${named.join(' ')})` : `it gives ${other.map((key) => `--${key}`).join(', ')}`;
  const own = typeof read.coverageDirectory === 'string' ? read.coverageDirectory : null;
  if (own !== null && resolve(workspaceDir, own) === resolve(workspaceDir, SUITE_DIR)) {
    return { whole: false, why, jestArgs: [], refused: `a run that is not the whole suite may not write the suite's report (${SUITE_DIR}/): ${why}. Give it another --coverageDirectory, or none.` };
  }
  const without = args.filter((arg) => arg !== '--coverage');
  return { whole: false, why, refused: null, jestArgs: own !== null ? ['--coverage', ...without] : ['--coverage', ...without, `--coverageDirectory=${PARTIAL_DIR}`] };
}

/**
 * Says whether a report was written by the run that has just ended.
 *
 * @param {string} path - The report.
 * @param {number} began - When the run began, in milliseconds.
 * @returns {boolean} True when the file is there and was written since.
 */
export function summary_isFresh(path, began) {
  try {
    return statSync(path).mtimeMs >= began;
  } catch {
    return false;
  }
}

/** Runs jest, then the ratchet when the suite was whole; the exit status is the first that failed. */
async function main() {
  const args = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const workspaceDir = process.cwd();
  const workspace = relative(root, workspaceDir);
  const { buildArgv } = await import('jest-cli');
  let read;
  try {
    read = await buildArgv(args);
  } catch (error) {
    // Jest does not take these arguments (an option it does not know, or one it has replaced): it says so
    // itself, in its own words, and nothing is run or judged.
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
  const plan = run_plan(read, args, workspaceDir);
  if (plan.refused !== null) {
    console.error(`jest-with-floor: ${plan.refused}`);
    process.exit(2);
  }
  const options = '--experimental-vm-modules --disable-warning=ExperimentalWarning';
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, options].filter(Boolean).join(' ') };
  // A whole second of slack: some filesystems keep times to the second.
  const began = Date.now() - 1000;
  const jest = spawnSync('npx', ['jest', ...plan.jestArgs], { stdio: 'inherit', env });
  if (jest.status !== 0) process.exit(jest.status ?? 1);
  if (!plan.whole) {
    console.log(`coverage-ratchet: not checked: this was a run of its own (${plan.why}), and the floors are for the whole suite over its own sources. The suite's report (${SUITE_DIR}/) is left as it was.`);
    return;
  }
  const summary = resolve(workspaceDir, SUITE_DIR, 'coverage-summary.json');
  if (!summary_isFresh(summary, began)) {
    console.error(`coverage-ratchet: this run wrote no report at ${SUITE_DIR}/coverage-summary.json, and an older one is not judged in its place.`);
    process.exit(1);
  }
  const ratchet = spawnSync('node', [resolve(root, 'scripts/coverage-ratchet.mjs'), '--require', workspace], { stdio: 'inherit' });
  process.exit(ratchet.status ?? 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
