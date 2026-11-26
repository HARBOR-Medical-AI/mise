/**
 * @file The universe laid out once, by the session, for every surface.
 *
 * A surface draws the universe from where each node stands; finding where
 * costs a settle that grows with the space (a minute for 26,000 spheres on
 * a laptop, longer on a phone). The session pays it once per identity: when
 * the index is whole it lays out each layout the surfaces offer, in a worker
 * thread, from the same graph and the same engine input a browser would
 * build, and keeps the places beside the index checkpoint. A surface that
 * asks meanwhile reads how far it has come.
 *
 * A layout already kept is not laid out again; DATA, whose hubs are the
 * data facts, waits for the facts sweep to settle and is laid out afresh.
 *
 * @module
 */
import { Worker } from 'node:worker_threads';
import { procLayout_get, procLayout_set, type ProcLayoutPosition } from '@fnndsc/cumin';
import { errorStack } from '@fnndsc/fond';
import { procDataFacts_settled } from '@fnndsc/salsa';
import {
  UNIVERSE_LAYOUTS,
  universeEngine_resolve,
  universeKey_derive,
  universeLayoutGraph_build,
  universeReach_derive,
  type LandedFeed,
  type UniverseGraph,
  type UniverseLayout,
} from '@fnndsc/menu';
import { layoutInput_build, PHYSICS_DEFAULT, type LayoutNode, type PhysicsTerms, type Positions } from '@fnndsc/orrery/layout';

/**
 * The fewest nodes a galaxy the session lays out holds. A browser settles a
 * smaller galaxy on the page as one molecule — another settle, other places
 * — and does it in a moment; SPOKES, CLUMPS and the rest always settle by
 * their engine, at any size.
 */
export const SESSION_GALAXY_NODES_MIN: number = 240;

/** How far a layout under way has come. */
export interface LayoutUnderWay {
  nodes: number;
  fraction: number;
}

/** Layouts under way, by name. */
const underWay: Map<string, LayoutUnderWay> = new Map();
/** Whether a warm pass runs: one at a time. */
let warming: boolean = false;

/**
 * How far the session has come laying a layout out.
 *
 * @param name - The layout.
 * @returns Its progress, or null when it is not being laid out.
 */
export function universeLayout_underWay(name: string): LayoutUnderWay | null {
  return underWay.get(name) ?? null;
}

/**
 * The engines' input for a layout, as a browser's scene builds it: the
 * layout's graph over every feed, sized by jobs, gravity on, the reach
 * bounded while the space is small.
 *
 * @param layout - The layout.
 * @param feeds - Every landed feed.
 * @returns The graph, its engine input, and the terms of the settle.
 */
export function universeLayoutInput_build(layout: UniverseLayout, feeds: ReadonlyArray<LandedFeed>): { graph: UniverseGraph; nodes: LayoutNode[]; physics: PhysicsTerms } {
  const graph: UniverseGraph = universeLayoutGraph_build(layout, feeds, 'jobs');
  const nodes: LayoutNode[] = layoutInput_build(graph.nodes, (node): string | null => universeKey_derive(node.id));
  const reach: number | undefined = universeReach_derive(graph.nodes.length);
  const physics: PhysicsTerms = { ...PHYSICS_DEFAULT, gravity: true, ...(reach === undefined ? {} : { reach }) };
  return { graph, nodes, physics };
}

/**
 * Runs one engine in a worker thread.
 *
 * @param engine - The engine's name.
 * @param nodes - Its input.
 * @param physics - The terms of the settle.
 * @param progress - Told how far it has come, 0..1.
 * @param workerAt - The worker's file, when it is not the session's own (a check hands in a worker that misbehaves).
 * @returns Every node's place.
 * @throws {Error} When the worker cannot be started, the engine fails, or the worker ends before it answers.
 *
 * @example
 * ```ts
 * const places: Positions = await layout_runInWorker('force', nodes, PHYSICS_DEFAULT, (): void => undefined);
 * ```
 */
export function layout_runInWorker(engine: string, nodes: LayoutNode[], physics: PhysicsTerms, progress: (fraction: number) => void, workerAt?: URL): Promise<Positions> {
  return new Promise<Positions>((resolve: (positions: Positions) => void, reject: (error: Error) => void): void => {
    const worker: Worker = workerAt === undefined ? new Worker(new URL('../universe/layoutWorker.js', import.meta.url)) : new Worker(workerAt);
    let answered: boolean = false;
    const finish = (): void => { answered = true; void worker.terminate(); };
    worker.on('message', (message: { type: string; fraction?: number; positions?: Positions; reason?: string }): void => {
      if (message.type === 'progress') progress(message.fraction ?? 0);
      else if (message.type === 'done') { finish(); resolve(message.positions ?? {}); }
      else { finish(); reject(new Error(message.reason ?? 'the layout failed')); }
    });
    worker.on('error', (error: Error): void => { finish(); reject(error); });
    // A worker that ends without a word, cleanly or not, has not laid
    // anything out: without this the caller waits for ever, and the
    // layouts after this one are never tried.
    worker.on('exit', (code: number): void => {
      if (!answered) reject(new Error(`the layout worker ended (exit ${code}) before it answered`));
    });
    worker.postMessage({ engine, nodes, physics });
  });
}

/**
 * Lays one layout out and keeps it.
 *
 * @param layout - The layout.
 * @param feeds - Every landed feed.
 * @param run - How an engine runs (a worker thread; a test hands its own).
 * @returns Whether it was laid out.
 */
export async function universeLayout_lay(
  layout: UniverseLayout,
  feeds: ReadonlyArray<LandedFeed>,
  run: typeof layout_runInWorker = layout_runInWorker,
): Promise<boolean> {
  const { nodes, physics } = universeLayoutInput_build(layout, feeds);
  if (nodes.length === 0 || (layout === 'galaxy' && nodes.length < SESSION_GALAXY_NODES_MIN)) return false;
  underWay.set(layout, { nodes: nodes.length, fraction: 0 });
  try {
    const positions: Positions = await run(universeEngine_resolve(layout), nodes, physics, (fraction: number): void => {
      underWay.set(layout, { nodes: nodes.length, fraction });
    });
    const kept: Record<string, ProcLayoutPosition> = {};
    for (const [id, at] of Object.entries(positions)) {
      if (!at.every((v: number): boolean => Number.isFinite(v))) continue;
      kept[id] = [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100, Math.round(at[2] * 100) / 100];
    }
    await procLayout_set(layout, kept);
    return true;
  } finally {
    underWay.delete(layout);
  }
}

/**
 * Says that the session could not lay a layout out.
 *
 * It is a warning and not a failure of the session: a surface settles what
 * the session could not. But it is said, since a session that never lays
 * anything out (its worker not found, say) otherwise looks like one with
 * nothing to lay out.
 *
 * @param layout - The layout.
 * @param error - What the attempt threw.
 */
function layoutFailure_note(layout: UniverseLayout, error: unknown): void {
  const reason: string = error instanceof Error ? error.message : String(error);
  errorStack.stack_push('warning', `the ${layout} layout could not be laid out by the session: ${reason}`);
}

/**
 * Lays out, once, every layout the session does not keep yet — DATA last,
 * after the facts sweep settles, and afresh, since its hubs are the facts.
 * One pass at a time; a failed layout is left for surfaces to settle.
 *
 * @param feeds - Every landed feed, when asked.
 * @param run - How an engine runs (a worker thread; a test hands its own).
 * @returns How many layouts were laid out.
 */
export async function universeLayouts_warm(feeds: () => ReadonlyArray<LandedFeed>, run: typeof layout_runInWorker = layout_runInWorker): Promise<number> {
  if (warming) return 0;
  warming = true;
  let laid: number = 0;
  try {
    for (const layout of UNIVERSE_LAYOUTS.filter((l: UniverseLayout): boolean => l !== 'data')) {
      if (await procLayout_get(layout) !== null) continue;
      try {
        if (await universeLayout_lay(layout, feeds(), run)) laid += 1;
      } catch (error: unknown) {
        layoutFailure_note(layout, error);
      }
    }
    await procDataFacts_settled();
    try {
      if (await universeLayout_lay('data', feeds(), run)) laid += 1;
    } catch (error: unknown) {
      layoutFailure_note('data', error);
    }
  } finally {
    warming = false;
  }
  return laid;
}
