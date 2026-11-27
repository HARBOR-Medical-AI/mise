/**
 * @file Runs a workspace's jest suite with coverage, and holds the result
 * to the workspace's coverage floors when the whole suite was run.
 *
 * Every argument is jest's: `npm test -- --runInBand`, `npm test -- -t
 * "one case"` and `npm test -- tests/unit/one.test.ts` reach jest as they
 * are written, and none of them reaches the ratchet.
 *
 * The floors are for the whole suite. A run is the whole suite unless
 * something selects among its tests: a path or pattern given as an
 * argument, or one of jest's selecting options (a name filter, changed
 * files only, a shard). Options that only say how to run (`--runInBand`,
 * `--maxWorkers=2`, `--testTimeout=10000`) select nothing, and the floors
 * are checked. A run that selects writes its coverage to a folder of its
 * own (`coverage-partial`), so the whole suite's report, which the ratchet
 * and `--raise` read, is never written over by part of it.
 *
 * Run from the workspace's folder, by its `test` script.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Jest's options that select among the tests, by name (each also in its `--name=value` form). */
const SELECTING = new Set([
  '-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns', '--testPathIgnorePatterns', '--runTestsByPath',
  '-o', '--onlyChanged', '--changedSince', '--changedFilesWithAncestor', '--lastCommit', '--findRelatedTests',
  '-f', '--onlyFailures', '--shard', '--selectProjects', '--ignoreProjects', '--testMatch', '--testRegex', '--roots', '--rootDir',
  '--watch', '--watchAll', '--listTests', '--showConfig', '--collectCoverageFrom', '--coverage=false', '--no-coverage', '--passWithNoTests',
]);

/** Jest's options that take a value as the next argument and select nothing. */
const VALUED = new Set(['--maxWorkers', '-w', '--testTimeout', '--reporters', '--config', '-c', '--cacheDirectory', '--seed', '--workerIdleMemoryLimit', '--maxConcurrency', '--bail', '-b', '--coverageReporters', '--coverageProvider', '--outputFile']);

/**
 * Says whether a set of jest arguments leaves the whole suite to be run.
 *
 * @param {string[]} args - The arguments handed to jest.
 * @returns {boolean} False when an argument selects among the tests: a bare path or pattern, or a selecting option.
 */
export function suite_isWhole(args) {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    const name = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (SELECTING.has(arg) || SELECTING.has(name)) return false;
    // Anything that is not an option is a path or a pattern.
    if (!arg.startsWith('-')) return false;
    // An option written with its value apart: the value is not a path.
    if (VALUED.has(arg) && args[at + 1] !== undefined && !args[at + 1].startsWith('-')) at++;
  }
  return true;
}

/** Where a run that selects among the tests writes its coverage, from the workspace's folder. */
export const PARTIAL_DIR = 'coverage-partial';

/**
 * The arguments jest is run with.
 *
 * @param {string[]} args - What was handed to the script.
 * @returns {string[]} Those, with coverage on, and for a run that selects, its own folder for the report.
 */
export function jestArgs_build(args) {
  const own = ['--coverage', ...args.filter((arg) => arg !== '--coverage')];
  return suite_isWhole(args) ? own : [...own, `--coverageDirectory=${PARTIAL_DIR}`];
}

/** Runs jest, then the ratchet when the suite was whole; the exit status is the first that failed. */
function main() {
  const args = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const workspace = relative(root, process.cwd());
  const options = '--experimental-vm-modules --disable-warning=ExperimentalWarning';
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, options].filter(Boolean).join(' ') };
  const jest = spawnSync('npx', ['jest', ...jestArgs_build(args)], { stdio: 'inherit', env });
  if (jest.status !== 0) process.exit(jest.status ?? 1);
  if (!suite_isWhole(args)) {
    console.log(`coverage-ratchet: not checked: the run selected among the tests (${args.join(' ')}), and the floors are for the whole suite. Its report is in ${PARTIAL_DIR}/; the whole suite's is left as it was.`);
    return;
  }
  const ratchet = spawnSync('node', [resolve(root, 'scripts/coverage-ratchet.mjs'), '--require', workspace], { stdio: 'inherit' });
  process.exit(ratchet.status ?? 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
