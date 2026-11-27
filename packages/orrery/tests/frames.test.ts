/**
 * @file The scene's frames: asked for while its box has a size, stopped
 * while it has none, started again by the box's observer, and let go.
 */
import { describe, it, expect } from '@jest/globals';
import { SceneFrames } from '../src/scene/frames.js';

/** A stand-in for the browser: frames asked for are run by the test, and the box's observer is the test's to fire. */
function world_make(size: { width: number; height: number }) {
  const asked: Map<number, () => void> = new Map();
  let serial: number = 0;
  const seen = { steps: 0, fits: 0, observed: 0, disconnected: 0, cancelled: [] as number[] };
  let changed: () => void = (): void => undefined;
  const box = { get clientWidth(): number { return size.width; }, get clientHeight(): number { return size.height; } } as unknown as HTMLElement;
  const frames: SceneFrames = new SceneFrames(box, {
    frame_step: (): void => { seen.steps += 1; },
    size_fit: (): void => { seen.fits += 1; },
    frame_ask: (callback: () => void): number => { serial += 1; asked.set(serial, callback); return serial; },
    frame_cancel: (handle: number): void => { seen.cancelled.push(handle); asked.delete(handle); },
    box_watch: (_box: HTMLElement, heard: () => void): (() => void) => { changed = heard; seen.observed += 1; return (): void => { seen.disconnected += 1; }; },
  });
  /** Runs the frames the browser has been asked for. */
  const frames_run = (): void => { for (const [handle, callback] of [...asked]) { asked.delete(handle); callback(); } };
  return { frames, seen, asked, frames_run, box_change: (): void => { changed(); } };
}

describe('SceneFrames', () => {
  it('draws a frame and asks for the next while its box has a size', () => {
    const { frames, seen, asked, frames_run } = world_make({ width: 800, height: 600 });
    expect(seen.steps).toBe(1);
    expect(asked.size).toBe(1);
    frames_run();
    frames_run();
    expect(seen.steps).toBe(3);
    expect(frames.frames_running()).toBe(true);
  });

  it('a box of no size is drawn nothing and asks for nothing; given a size again, it draws again', () => {
    const size = { width: 800, height: 600 };
    const { frames, seen, asked, frames_run, box_change } = world_make(size);
    // The pane is hidden: its box has no size.
    size.width = 0;
    size.height = 0;
    frames_run();
    expect(seen.steps).toBe(1);
    expect(asked.size).toBe(0);
    expect(frames.frames_running()).toBe(false);
    // The observer tells of a box still without a size: refitted, and still nothing drawn.
    box_change();
    expect(seen.steps).toBe(1);
    expect(asked.size).toBe(0);
    // Shown again.
    size.width = 800;
    size.height = 600;
    box_change();
    expect(seen.fits).toBe(2);
    expect(seen.steps).toBe(2);
    expect(asked.size).toBe(1);
    // A change of size while the frames run starts no second loop beside the first.
    box_change();
    expect(asked.size).toBe(1);
    expect(seen.steps).toBe(2);
  });

  it('starts with no frames in a box that has no size yet', () => {
    const size = { width: 0, height: 0 };
    const { seen, asked, box_change } = world_make(size);
    expect(seen.steps).toBe(0);
    expect(asked.size).toBe(0);
    size.width = 10;
    size.height = 10;
    box_change();
    expect(seen.steps).toBe(1);
  });

  it('let go, it disconnects its observer, takes back the frame it asked for, and draws no more', () => {
    const { frames, seen, asked, frames_run, box_change } = world_make({ width: 800, height: 600 });
    expect(seen.observed).toBe(1);
    frames.frames_dispose();
    expect(seen.disconnected).toBe(1);
    expect(seen.cancelled).toEqual([1]);
    expect(asked.size).toBe(0);
    frames_run();
    box_change();
    frames.frames_resume();
    expect(seen.steps).toBe(1);
    expect(seen.fits).toBe(0);
    expect(frames.frames_running()).toBe(false);
  });
});
