/**
 * The session's layout worker starts from the built package and lays a graph out.
 *
 * The unit tests hand `universeLayout_lay` their own runner, so nothing in
 * them starts the worker thread, and a build that leaves the worker's file
 * out, or a path to it that is wrong, passes them all. This runs the default
 * runner from `dist`, on three nodes, and exits 1 unless a place comes back
 * for a node it names within the time allowed.
 *
 * Run after the build: `npm run test:layout-worker --workspace @fnndsc/brasa`.
 */
import { layoutEngines_list, PHYSICS_DEFAULT } from '@fnndsc/orrery/layout';

const { layout_runInWorker } = await import('../dist/chris/universeLayout.js');

/** How long the worker has: three nodes settle in well under a second. */
const ALLOWED_MS = 30_000;

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

let timer;
const late = new Promise((_resolve, reject) => {
  timer = setTimeout(() => reject(new Error(`no answer from the worker in ${ALLOWED_MS} ms`)), ALLOWED_MS);
});
try {
  const positions = await Promise.race([layout_runInWorker(engine, nodes, PHYSICS_DEFAULT, () => undefined), late]);
  const place = positions.leaf;
  if (!Array.isArray(place) || place.length !== 3 || !place.every((value) => Number.isFinite(value))) {
    throw new Error(`the worker answered no place for the node "leaf": ${JSON.stringify(positions)}`);
  }
  console.log(`layout-worker: the built worker laid out 3 nodes with ${engine}; "leaf" is at ${JSON.stringify(place)}.`);
} catch (error) {
  console.error(`layout-worker: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
