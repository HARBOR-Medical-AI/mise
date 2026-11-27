/**
 * @file The scene's frames: asked for while its box has a size, and not
 * while it has none.
 *
 * A page that is hidden is the browser's to stop drawing. A pane that is
 * hidden inside a visible page is not: the browser goes on calling for
 * frames, and a scene that asked for the next one unconditionally would
 * render sixty times a second into a box nobody can see. The frames here
 * stop when the box has no size and start again when it has one, told by
 * the same observer that refits the canvas.
 *
 * Key components:
 * - {@link SceneFrames}: the loop and the box's observer, released together.
 *
 * Typical usage:
 * - `new SceneFrames(container, ports)` once the scene is built; `frames_dispose()` when it is torn down.
 *
 * Dependencies:
 * - the browser's `requestAnimationFrame` and `ResizeObserver` (a test stands its own in)
 *
 * @module
 */

/**
 * What the frames are made of: the scene's own work, and the browser's parts a test stands in.
 *
 * @example
 * const ports: FramePorts = { frame_step: (): void => { render(); }, size_fit: (): void => { fit(); } };
 */
export interface FramePorts {
  /** One frame's work: the motions stepped and the scene rendered. */
  frame_step: () => void;
  /** Refits the canvas to its box. */
  size_fit: () => void;
  /** Asks for the next frame; `window.requestAnimationFrame` by default. */
  frame_ask?: (callback: () => void) => number;
  /** Takes back a frame asked for; `window.cancelAnimationFrame` by default. */
  frame_cancel?: (handle: number) => void;
  /** Watches the box for a change of size and returns what stops the watch; a `ResizeObserver` by default. */
  box_watch?: (box: HTMLElement, changed: () => void) => () => void;
}

/**
 * Watches a box with the browser's own observer.
 *
 * @param box - The box.
 * @param changed - Told when its size changes (and once when the watch begins).
 * @returns What stops the watch.
 *
 * @example
 * const watch_stop: () => void = box_observe(container, (): void => { fit(); });
 */
function box_observe(box: HTMLElement, changed: () => void): () => void {
  const observer: ResizeObserver = new ResizeObserver(changed);
  observer.observe(box);
  return (): void => { observer.disconnect(); };
}

/**
 * The scene's frame loop and the observer of its box.
 *
 * @example
 * const frames: SceneFrames = new SceneFrames(container, { frame_step: (): void => { render(); }, size_fit: (): void => { fit(); } });
 * frames.frames_dispose();
 */
export class SceneFrames {
  private handle: number | null = null;
  private disposed: boolean = false;
  private readonly watchStop: () => void;
  private readonly asker: (callback: () => void) => number;
  private readonly canceller: (handle: number) => void;

  /**
   * @param box - The scene's box.
   * @param ports - The scene's work and, in a test, the browser's parts.
   */
  constructor(private readonly box: HTMLElement, private readonly ports: FramePorts) {
    this.asker = ports.frame_ask ?? ((callback: () => void): number => window.requestAnimationFrame(callback));
    this.canceller = ports.frame_cancel ?? ((handle: number): void => { window.cancelAnimationFrame(handle); });
    // A pane resize (a collapsed console, a divider drag) reshapes the box without a window resize; an
    // unfitted canvas would stretch the graph. And a box that has a size again draws again.
    this.watchStop = (ports.box_watch ?? box_observe)(box, (): void => {
      if (this.disposed) return;
      this.ports.size_fit();
      this.frames_resume();
    });
    this.frame_tick();
  }

  /**
   * Says whether a frame is asked for now.
   *
   * @returns True while the frames run.
   *
   * @example
   * if (!frames.frames_running()) frames.frames_resume();
   */
  public frames_running(): boolean {
    return this.handle !== null;
  }

  /**
   * Starts the frames again, when they had stopped for a box of no size.
   *
   * @example
   * frames.frames_resume();
   */
  public frames_resume(): void {
    if (!this.disposed && this.handle === null) this.frame_tick();
  }

  /**
   * Stops the frames for good and lets the observer go.
   *
   * @example
   * frames.frames_dispose();
   */
  public frames_dispose(): void {
    this.disposed = true;
    this.watchStop();
    if (this.handle !== null) this.canceller(this.handle);
    this.handle = null;
  }

  /**
   * One frame, and the next asked for: unless the box has no size, when nothing is drawn and nothing asked.
   *
   * @example
   * this.frame_tick();
   */
  private frame_tick(): void {
    this.handle = null;
    if (this.disposed) return;
    if (this.box.clientWidth === 0 || this.box.clientHeight === 0) return;
    this.ports.frame_step();
    // The step may have torn the scene down.
    if (this.frames_ended()) return;
    this.handle = this.asker((): void => { this.frame_tick(); });
  }

  /**
   * Says whether the frames have been stopped for good.
   *
   * @returns True once disposed.
   *
   * @example
   * if (this.frames_ended()) return;
   */
  private frames_ended(): boolean {
    return this.disposed;
  }
}
