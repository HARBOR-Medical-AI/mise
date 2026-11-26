/**
 * @file The universe laid out by the session: the engine input a browser's
 * scene would build (same graph, radii, molecules, terms), a small galaxy
 * left to the browser, progress while under way, places kept rounded, and
 * DATA laid out last, after the facts sweep settles.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const kept: Map<string, Record<string, [number, number, number]>> = new Map();
let factsSettled: () => void = () => undefined;
const order: string[] = [];

cuminMock_install(() => ({
  procLayout_get: async (name: string) => (kept.has(name) ? { name, positions: kept.get(name), writtenAt: 'then' } : null),
  procLayout_set: async (name: string, positions: Record<string, [number, number, number]>) => { kept.set(name, positions); order.push(name); return { name, positions, writtenAt: 'now' }; },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  procDataFacts_settled: () => new Promise<number>((resolve) => { factsSettled = () => resolve(1); }),
}));

const { universeLayoutInput_build, universeLayout_lay, universeLayout_underWay, universeLayouts_warm, SESSION_GALAXY_NODES_MIN } = await import('../src/chris/universeLayout.js');

/** A feed: a chain of groups. */
const feed = (id: number, plugins: string[], created: string = '2026-01-01T00:00:00Z') => ({
  id, title: `f${id}`, jobs: plugins.length, status: 'finishedSuccessfully', chain: plugins, createdAt: created,
  groups: plugins.map((plugin, i) => ({ plugin, count: i + 1, errored: 0, status: 'finishedSuccessfully', parent: i === 0 ? null : i - 1 })),
});
const lab = (n: number) => Array.from({ length: n }, (_v, i) => feed(i + 1, i % 2 ? ['pl-dircopy', 'pl-civet'] : ['pl-dircopy', 'pl-dcm2niix', 'pl-mri']));

beforeEach(() => { kept.clear(); order.length = 0; });

describe('the engine input', () => {
  it('is the scene\'s: every feed sized by jobs, molecules by feed, anchors in none, gravity on, reach by size', () => {
    const small = universeLayoutInput_build('galaxy', lab(4));
    expect(small.physics).toMatchObject({ charge: true, link: true, collide: true, gravity: true, reach: 12 });
    expect(small.nodes.find((n) => n.id === 'feed:1:0')?.group).toBe('feed:1');
    expect(small.nodes.find((n) => n.id.startsWith('shape:'))?.group).toBeNull();
    const crowd = universeLayoutInput_build('galaxy', lab(200));
    expect(crowd.physics.reach).toBeUndefined();
    const stars = universeLayoutInput_build('constellations', lab(4));
    expect(stars.nodes.some((n) => n.attrs?.['kind'] === 'star')).toBe(true);
  });
});

describe('laying a layout out', () => {
  it('leaves a small galaxy to the browser, and lays any other layout out at any size', async () => {
    const run = jest.fn(async () => ({}));
    expect(await universeLayout_lay('galaxy', lab(3), run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(await universeLayout_lay('spokes', lab(3), run)).toBe(true);
    expect(run).toHaveBeenCalledWith('spokes', expect.any(Array), expect.any(Object), expect.any(Function));
    expect(SESSION_GALAXY_NODES_MIN).toBe(240);
  });

  it('says how far it has come while under way, keeps the places rounded, and drops what has no place', async () => {
    let seen: unknown = null;
    const run = async (_e: string, nodes: Array<{ id: string }>, _p: unknown, progress: (f: number) => void) => {
      progress(0.5);
      seen = universeLayout_underWay('data');
      return { [nodes[0]!.id]: [1.234, -2.345, 3.456], [nodes[1]!.id]: [Number.NaN, 0, 0] } as Record<string, [number, number, number]>;
    };
    expect(await universeLayout_lay('data', lab(3), run as never)).toBe(true);
    expect(seen).toMatchObject({ fraction: 0.5 });
    expect(universeLayout_underWay('data')).toBeNull();
    const places = kept.get('data')!;
    expect(Object.values(places)).toEqual([[1.23, -2.35, 3.46]]);
  });
});

describe('warming every layout', () => {
  it('lays out what is not kept, DATA last once the facts settle, one pass at a time', async () => {
    kept.set('spokes', { a: [0, 0, 0] });
    order.length = 0;
    const run = async (_e: string, nodes: Array<{ id: string }>) => Object.fromEntries(nodes.map((n) => [n.id, [0, 0, 0]])) as Record<string, [number, number, number]>;
    const warm = universeLayouts_warm(() => lab(300), run as never);
    // A second pass while one runs does nothing.
    expect(await universeLayouts_warm(() => lab(300), run as never)).toBe(0);
    // DATA waits for the facts: nothing of it is kept until they settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kept.has('data')).toBe(false);
    factsSettled();
    const laid = await warm;
    expect(order[order.length - 1]).toBe('data');
    expect(order).not.toContain('spokes');
    expect(laid).toBe(order.length);
  }, 30000);
});

describe('a layout the session could not lay out', () => {
  it('is said, by name and with the reason, and the rest are still laid out', async () => {
    const { errorStack } = await import('@fnndsc/fond');
    errorStack.stack_clear();
    const run = async (engine: string, nodes: Array<{ id: string }>) => {
      if (order.length === 0 && !run.failed) { run.failed = true; throw new Error(`Cannot find module layoutWorker.js (${engine})`); }
      return Object.fromEntries(nodes.map((n) => [n.id, [0, 0, 0]])) as Record<string, [number, number, number]>;
    };
    run.failed = false;
    const warm = universeLayouts_warm(() => lab(300), run as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    factsSettled();
    const laid = await warm;
    const said: string[] = errorStack.stack_search('could not be laid out by the session');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Cannot find module layoutWorker.js');
    expect(laid).toBeGreaterThan(0);
    expect(order[order.length - 1]).toBe('data');
  }, 30000);
});
