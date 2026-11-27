/**
 * @file Runs a workspace's jest suite with coverage, and holds the result
 * to the workspace's coverage floors when the whole suite was run.
 *
 * Every argument is jest's: `npm test -- --runInBand`, `npm test -- -t
 * "one case"` and `npm test -- tests/unit/one.test.ts` reach jest as they
 * are written, and none of them reaches the ratchet. The floors are for
 * the whole suite, so they are checked only when nothing narrowed the run:
 * a run of some of the tests covers less, and proves nothing about a fall.
 *
 * Run from the workspace's folder, by its `test` script.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Jest options that leave the suite whole, and take no value. */
const WHOLE = new Set(['--coverage', '--runInBand', '-i', '--ci', '--silent', '--verbose', '--colors', '--no-colors', '--forceExit', '--detectOpenHandles', '--no-cache']);

/**
 * Says whether a set of jest arguments leaves the whole suite to be run.
 *
 * @param {string[]} args - The arguments handed to jest.
 * @returns {boolean} True when every one is an option known to narrow nothing.
 */
export function suite_isWhole(args) {
  return args.every((arg) => WHOLE.has(arg));
}

/** Runs jest, then the ratchet when the suite was whole; the exit status is the first that failed. */
function main() {
  const args = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const workspace = relative(root, process.cwd());
  const options = '--experimental-vm-modules --disable-warning=ExperimentalWarning';
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, options].filter(Boolean).join(' ') };
  const jest = spawnSync('npx', ['jest', '--coverage', ...args.filter((arg) => arg !== '--coverage')], { stdio: 'inherit', env });
  if (jest.status !== 0) process.exit(jest.status ?? 1);
  if (!suite_isWhole(args)) {
    console.log(`coverage-ratchet: not checked: the run was narrowed (${args.join(' ')}), and the floors are for the whole suite.`);
    return;
  }
  const ratchet = spawnSync('node', [resolve(root, 'scripts/coverage-ratchet.mjs'), '--require', workspace], { stdio: 'inherit' });
  process.exit(ratchet.status ?? 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
