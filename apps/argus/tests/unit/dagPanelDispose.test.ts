/**
 * @jest-environment jsdom
 */
/**
 * @file A closed DAG pane is held by nothing: its observers (two of them
 * on the document), its listener on the window, its timers, its listing
 * and its scene are all let go.
 *
 * Seam: the scene (WebGL) is a stand-in that counts what it is asked.
 */
import { describe, it, expect, jest } from '@jest/globals';

const sceneCalls: Record<string, number> = {};
/** A scene that draws nothing and counts what it is asked. */
class FakeSpace {
  constructor() {
    return new Proxy(this, {
      get: (_target: FakeSpace, name: string | symbol): unknown => {
        if (typeof name !== 'string') return undefined;
        if (name === 'physics_get') return (): object => ({ gravity: false });
        if (name === 'strategy_get') return (): string => 'ranked';
        if (name === 'projection_get') return (): string => '3d';
        return (): undefined => { sceneCalls[name] = (sceneCalls[name] ?? 0) + 1; return undefined; };
      },
    });
  }
}
jest.unstable_mockModule('../../src/scene/chrisSpace.js', () => ({ ChrisSpace: FakeSpace }));

const { DagPanel } = await import('../../src/features/dag/panel.js');

/** Every observer made while the pane is built, and whether each was disconnected. */
function observers_watch(): { made: Array<{ disconnected: boolean }>; restore: () => void } {
  const made: Array<{ disconnected: boolean }> = [];
  const Real = globalThis.MutationObserver;
  class Watched extends Real {
    private readonly note: { disconnected: boolean } = { disconnected: false };
    constructor(heard: MutationCallback) { super(heard); made.push(this.note); }
    override disconnect(): void { this.note.disconnected = true; super.disconnect(); }
  }
  globalThis.MutationObserver = Watched;
  return { made, restore: (): void => { globalThis.MutationObserver = Real; } };
}

function pane_make(): { root: HTMLElement; parts: HTMLElement[] } {
  const root: HTMLElement = document.createElement('section');
  root.className = 'pane pane-dag';
  const made = (tag: string, cls: string): HTMLElement => { const one = document.createElement(tag); one.className = cls; root.append(one); return one; };
  const holder: HTMLElement = made('div', 'dag-facts-holder');
  const facts: HTMLElement = document.createElement('div');
  holder.append(facts);
  const parts: HTMLElement[] = [made('div', 'dag-canvas'), made('span', 'pane-title'), facts, made('div', 'dag-empty'), made('button', 'dag-strategy'), made('div', 'dag-feeds')];
  document.body.append(root);
  return { root, parts };
}

/** How many observers of size have been made: a listing let go makes no more. */
let resizeObserversMade: number = 0;
globalThis.ResizeObserver = class {
  constructor() { resizeObserversMade += 1; }
  observe(): void { /* nothing is laid out here */ }
  unobserve(): void { /* nothing is laid out here */ }
  disconnect(): void { /* nothing is laid out here */ }
} as unknown as typeof ResizeObserver;

describe('a DAG pane closed', () => {
  it('disconnects every observer, takes its listener off the window, stops its timers, and lets go of its listing and scene', () => {
    const watch = observers_watch();
    const added = jest.spyOn(window, 'addEventListener');
    const { root, parts } = pane_make();
    const [canvas, title, facts, empty, pill, feeds] = parts as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    const panel = new DagPanel(canvas, title, facts, empty, pill, feeds, {} as never);
    watch.restore();
    // The pane watches the document's theme, the page's zoom and its own facts.
    expect(watch.made.length).toBeGreaterThanOrEqual(3);
    const resize = added.mock.calls.find((call) => call[0] === 'resize');
    expect(resize).toBeDefined();
    const signal: AbortSignal | undefined = (resize?.[2] as AddEventListenerOptions | undefined)?.signal;
    expect(signal?.aborted).toBe(false);
    added.mockRestore();

    jest.useFakeTimers();
    try {
      // A zoom glide begins: the scene is to be refitted once it settles.
      document.body.dataset['zoom'] = 'in';
      return Promise.resolve().then((): void => {
        const fitsBefore: number = sceneCalls['size_fit'] ?? 0;
        panel.dispose();
        expect(watch.made.every((one) => one.disconnected)).toBe(true);
        expect(signal?.aborted).toBe(true);
        expect(sceneCalls['dispose']).toBe(1);
        // Nothing is left to fire: not the zoom's refit, not the roster's clocks.
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(5000);
        window.dispatchEvent(new Event('resize'));
        document.documentElement.dataset['theme'] = 'other';
        expect(sceneCalls['size_fit'] ?? 0).toBe(fitsBefore);
        expect(sceneCalls['palette_refresh'] ?? 0).toBe(0);
        // A feed's graph that was asked for before the close comes back now, and so does a roster.
        const drawsBefore: number = Object.entries(sceneCalls).filter(([name]) => name !== 'dispose').reduce((sum, [, count]) => sum + count, 0);
        const resizeObservers: number = resizeObserversMade;
        panel.envelope_observe({ status: 'ok', rendered: '', model: { kind: 'feed.dag', data: { feedId: 7, feedName: 'a feed', nodes: [] } } } as never);
        panel.envelope_observe({ status: 'ok', rendered: '', model: { kind: 'feed.list', data: { feeds: [] } } } as never);
        jest.advanceTimersByTime(5000);
        expect(Object.entries(sceneCalls).filter(([name]) => name !== 'dispose').reduce((sum, [, count]) => sum + count, 0)).toBe(drawsBefore);
        expect(resizeObserversMade).toBe(resizeObservers);
        expect(jest.getTimerCount()).toBe(0);
        root.remove();
      }).finally((): void => { jest.useRealTimers(); });
    } catch (error: unknown) {
      jest.useRealTimers();
      throw error;
    }
  });
});
