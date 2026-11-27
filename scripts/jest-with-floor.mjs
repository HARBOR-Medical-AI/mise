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
 * A whole run writes its report to a folder of its own, made empty for it.
 * If jest leaves a summary there, the floors are judged from that very
 * file, and it is then published, whole, as the suite's report
 * (`coverage/`); if jest leaves none, the run fails, whatever report stood
 * before. A run of its own writes elsewhere (`coverage-partial/`, or where
 * it says), is not judged, and may not write to the suite's folder: where
 * it will write is asked of jest itself (`jest-config`) before it starts,
 * and a run that would write there is not run.
 *
 * What this adds to jest's arguments goes before them, so that an
 * end-of-options mark (`--`) among them leaves it an option.
 *
 * Run from the workspace's folder, by its `test` script.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
 * @param {string} runDir - A folder of this run's own, for a whole run's report.
 * @returns {{ whole: boolean, why: string, jestArgs: string[] }} Whether the run is the whole suite, why not when it is not, and what jest is run with.
 */
export function run_plan(read, args, workspaceDir, runDir) {
  const named = Array.isArray(read._) ? read._.map(String) : [];
  const given = Object.keys(read).filter((key) => key !== '_' && key !== '$0');
  const other = given.filter((key) => !HOW.has(key) || ((key === 'coverage' || key === 'collectCoverage') && read[key] === false));
  // What is added goes first: after a `--` it would be read as a test's name.
  if (named.length === 0 && other.length === 0) {
    return {
      whole: true, why: '',
      jestArgs: ['--coverage', `--coverageDirectory=${runDir}`, '--coverageReporters=json-summary', '--coverageReporters=text-summary', ...args.filter((arg) => arg !== '--coverage')],
    };
  }
  const why = named.length > 0 ? `it names tests (${named.join(' ')})` : `it gives ${other.map((key) => `--${key}`).join(', ')}`;
  const own = typeof read.coverageDirectory === 'string';
  const without = args.filter((arg) => arg !== '--coverage');
  return { whole: false, why, jestArgs: own ? ['--coverage', ...without] : ['--coverage', `--coverageDirectory=${resolve(workspaceDir, PARTIAL_DIR)}`, ...without] };
}

/**
 * Where jest will write a run's coverage: asked of jest's own reading of
 * its arguments and its config (`jest-config`), so the folder is the one
 * jest will use, whatever config, root or spelling the run gives.
 *
 * @param {string[]} jestArgs - The arguments jest is to be run with.
 * @param {string} workspaceDir - The workspace's folder.
 * @returns {Promise<string>} The folder, absolute.
 */
export async function coverageDir_effective(jestArgs, workspaceDir) {
  const { buildArgv } = await import('jest-cli');
  const { readConfigs } = await import('jest-config');
  const read = await buildArgv(jestArgs);
  // The projects jest will run, as jest picks them: those named, or the workspace itself.
  const projects = Array.isArray(read.projects) && read.projects.length > 0 ? read.projects.map((project) => resolve(workspaceDir, String(project))) : [workspaceDir];
  const { globalConfig } = await readConfigs(read, projects);
  return path_physical(resolve(globalConfig.coverageDirectory));
}

/**
 * A path as it is on disk, links followed: two spellings of one folder
 * (through a workspace's link in `node_modules`, say) come out the same. A
 * folder that is not there yet is placed under the nearest one that is.
 *
 * @param {string} path - The path, absolute.
 * @returns {string} The physical path.
 */
export function path_physical(path) {
  const missing = [];
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) {
    missing.unshift(basename(at));
    at = dirname(at);
  }
  return join(realpathSync(at), ...missing);
}

/**
 * Publishes a whole run's report as the suite's: the summary the run left
 * in its own folder is copied to the suite's folder.
 *
 * @param {string} runDir - The run's own folder.
 * @param {string} suiteDir - The suite's folder.
 * @returns {boolean} False when the run left no summary: nothing is published, and whatever stood in the suite's folder is not this run's.
 */
export function report_publish(runDir, suiteDir) {
  const from = join(runDir, 'coverage-summary.json');
  if (!existsSync(from)) return false;
  mkdirSync(suiteDir, { recursive: true });
  // Whole or not at all: copied beside its place and moved into it, so a reader never finds half a report.
  const beside = join(suiteDir, `coverage-summary.json.${process.pid}.new`);
  copyFileSync(from, beside);
  renameSync(beside, join(suiteDir, 'coverage-summary.json'));
  return true;
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
  // A folder of this run's own, new and empty: what is found in it afterwards, this run wrote.
  const runDir = mkdtempSync(join(tmpdir(), 'jest-with-floor-'));
  let status = 1;
  try {
    status = await run_judge(read, args, root, workspaceDir, workspace, runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  process.exit(status);
}

/**
 * Runs jest as planned and judges a whole run from the report it wrote.
 *
 * @param {Record<string, unknown>} read - The arguments as jest reads them.
 * @param {string[]} args - The arguments as written.
 * @param {string} root - The repository.
 * @param {string} workspaceDir - The workspace's folder.
 * @param {string} workspace - The workspace, from the repository's root.
 * @param {string} runDir - This run's own folder.
 * @returns {Promise<number>} The exit status.
 */
async function run_judge(read, args, root, workspaceDir, workspace, runDir) {
  const plan = run_plan(read, args, workspaceDir, runDir);
  const suiteDir = resolve(workspaceDir, SUITE_DIR);
  if (!plan.whole) {
    // Settled before jest starts, by where jest itself will write: a run that is not the whole suite and
    // would write to the suite's folder is not run. Nothing is put back afterwards, so nothing another run
    // publishes meanwhile is undone.
    let where;
    try {
      where = await coverageDir_effective(plan.jestArgs, workspaceDir);
    } catch (error) {
      console.error(String(error?.message ?? error));
      return 1;
    }
    if (where === path_physical(suiteDir)) {
      console.error(`jest-with-floor: a run that is not the whole suite may not write to the suite's folder (${SUITE_DIR}/): ${plan.why}, and jest would write its coverage there. Give it another --coverageDirectory, or none.`);
      return 2;
    }
  }
  const options = '--experimental-vm-modules --disable-warning=ExperimentalWarning';
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, options].filter(Boolean).join(' ') };
  // The jest that is run: the workspace's own, or (for this script's own test) one named to stand in for it.
  const command = process.env.JEST_WITH_FLOOR_JEST ?? 'npx';
  const first = process.env.JEST_WITH_FLOOR_JEST === undefined ? ['jest'] : [];
  const jest = spawnSync(command, [...first, ...plan.jestArgs], { stdio: 'inherit', env });
  if (jest.status !== 0) return jest.status ?? 1;
  if (!plan.whole) {
    console.log(`coverage-ratchet: not checked: this was a run of its own (${plan.why}), and the floors are for the whole suite over its own sources. The suite's report (${SUITE_DIR}/) is left as it was.`);
    return 0;
  }
  const own = join(runDir, 'coverage-summary.json');
  if (!existsSync(own)) {
    console.error(`coverage-ratchet: jest ended well and wrote no coverage summary. Nothing is judged, and the report that stood in ${SUITE_DIR}/ is not this run's.`);
    return 1;
  }
  // Judged from the summary this run wrote, in its own folder: another run finishing meanwhile changes
  // nothing of this one's verdict. Then published as the suite's, whole, for whoever reads it next.
  const ratchet = spawnSync('node', [resolve(root, 'scripts/coverage-ratchet.mjs'), '--require', workspace, '--summary', `${workspace}=${own}`], { stdio: 'inherit' });
  report_publish(runDir, suiteDir);
  return ratchet.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
