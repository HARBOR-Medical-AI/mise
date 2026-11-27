/**
 * The session's layout worker starts from the built package and lays a graph out.
 *
 * The unit tests hand `universeLayout_lay` their own runner, so nothing in
 * them starts the worker thread, and a build that leaves the worker's file
 * out, or a path to it that is wrong, passes them all. This runs the default
 * runner from `dist`, on three nodes, and exits 1 unless a place comes back
 * for a node it names within the time allowed. At the deadline the process
 * is ended: a worker that is alive and says nothing would otherwise keep it
 * running.
 *
 * Run after the build: `npm run test:layout-worker --workspace @fnndsc/brasa`.
 */
import { layoutEngines_list, PHYSICS_DEFAULT } from '@fnndsc/orrery/layout';

import { pathToFileURL } from 'node:url';

const { layout_runInWorker } = await import('../dist/chris/universeLayout.js');

/**
 * One option's value from the command line.
 *
 * @param {string} name - The option, as written (`--worker`).
 * @returns {string | undefined} The word after it.
 */
function option_read(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** How long the worker has: three nodes settle in well under a second. `--allowed-ms` shortens it for this check's own test. */
const ALLOWED_MS = Number(option_read('--allowed-ms') ?? 30_000);

/** The worker to start: the built package's own, unless `--worker` names another (this check's own test hands in one that misbehaves). */
const workerAt = option_read('--worker') === undefined ? undefined : pathToFileURL(option_read('--worker'));

const nodes = [
  { id: 'root', parents: [], radius: 1, group: null },
  { id: 'child', parents: ['root'], radius: 1, group: null },
  { id: 'leaf', parents: ['child'], radius: 1, group: null },
];
const engine = layoutEngines_list()[0]?.id;
if (engine === undefined) {
  console.error('layout-worker: no layout engine is registered');
  process.exit(1);
}

/**
 * Says why the check failed and ends the process.
 *
 * The process is ended, not left to drain: a worker that is alive and
 * silent keeps Node running, and a check that never ends is not a failure
 * anybody sees.
 *
 * @param {string} reason - Why.
 */
function check_fail(reason) {
  console.error(`layout-worker: ${reason}`);
  process.exit(1);
}

const deadline = setTimeout(() => check_fail(`no answer from the worker in ${ALLOWED_MS} ms`), ALLOWED_MS);
try {
  const positions = await layout_runInWorker(engine, nodes, PHYSICS_DEFAULT, () => undefined, workerAt);
  clearTimeout(deadline);
  const place = positions.leaf;
  if (!Array.isArray(place) || place.length !== 3 || !place.every((value) => Number.isFinite(value))) {
    check_fail(`the worker answered no place for the node "leaf": ${JSON.stringify(positions)}`);
  }
  console.log(`layout-worker: the built worker laid out 3 nodes with ${engine}; "leaf" is at ${JSON.stringify(place)}.`);
} catch (error) {
  check_fail(error instanceof Error ? error.message : String(error));
}
