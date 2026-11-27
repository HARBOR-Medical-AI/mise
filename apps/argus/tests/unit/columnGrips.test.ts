/**
 * @jest-environment jsdom
 */
/**
 * @file A column drag and the listing let go in the middle of it: the
 * drag's listeners are on the window, and go with the listing.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { GRIP_CLASS, grips_wire, type GripHooks } from '../../src/features/roster/columns.js';

/** A caps row of two sizeable columns, the first with a grip. */
function caps_make(): { caps: HTMLElement; grip: HTMLElement } {
  const caps: HTMLElement = document.createElement('div');
  caps.className = 'roster-caps';
  const grip: HTMLElement = document.createElement('span');
  grip.className = GRIP_CLASS;
  for (const key of ['name', 'size']) {
    const cap: HTMLElement = document.createElement('span');
    cap.className = 'roster-cap';
    cap.dataset['key'] = key;
    // There is no layout here: each column is said to be a hundred wide.
    cap.getBoundingClientRect = (): DOMRect => ({ width: 100, height: 20, left: 0, right: 100, top: 0, bottom: 20, x: 0, y: 0, toJSON: (): object => ({}) });
    if (key === 'name') cap.append(grip);
    caps.append(cap);
  }
  document.body.append(caps);
  return { caps, grip };
}

function hooks_make(signal: AbortSignal | undefined, sized: string[]): GripHooks {
  return {
    key_read: (cap: HTMLElement): string | null => cap.dataset['key'] ?? null,
    expanse_is: (): boolean => false,
    floor_measure: (): number => 0,
    expanseSlack: (): number => 0,
    size: (key: string): void => { sized.push(key); },
    reset: (): void => undefined,
    ...(signal !== undefined ? { signal } : {}),
  };
}

describe('a column drag', () => {
  it('puts its listeners on the window and takes them off at the pointer coming up', () => {
    const { caps, grip } = caps_make();
    const added = jest.spyOn(window, 'addEventListener');
    const removed = jest.spyOn(window, 'removeEventListener');
    const sized: string[] = [];
    grips_wire(caps, hooks_make(undefined, sized));
    grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, bubbles: true }));
    expect(added.mock.calls.map((call) => call[0])).toEqual(['pointermove', 'pointerup', 'pointercancel']);
    expect(caps.classList.contains('roster-sizing')).toBe(true);
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(removed.mock.calls.map((call) => call[0])).toEqual(['pointermove', 'pointerup', 'pointercancel']);
    expect(caps.classList.contains('roster-sizing')).toBe(false);
    added.mockRestore();
    removed.mockRestore();
    caps.remove();
  });

  it('ends when the listing is let go in the middle of it: nothing is left on the window, and a move after it sizes nothing', () => {
    const { caps, grip } = caps_make();
    const released: AbortController = new AbortController();
    const sized: string[] = [];
    grips_wire(caps, hooks_make(released.signal, sized));
    const added = jest.spyOn(window, 'addEventListener');
    const removed = jest.spyOn(window, 'removeEventListener');
    grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 }));
    const during: number = sized.length;
    expect(during).toBeGreaterThan(0);
    // The pane closes with the pointer still down.
    released.abort();
    const handlers = added.mock.calls.map((call) => call[1]);
    expect(removed.mock.calls.map((call) => call[0])).toEqual(['pointermove', 'pointerup', 'pointercancel']);
    expect(removed.mock.calls.map((call) => call[1])).toEqual(handlers);
    expect(caps.classList.contains('roster-sizing')).toBe(false);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
    expect(sized.length).toBe(during);
    // And the grip itself hears no new press.
    added.mockClear();
    grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, bubbles: true }));
    expect(added).not.toHaveBeenCalled();
    added.mockRestore();
    removed.mockRestore();
    caps.remove();
  });
});
