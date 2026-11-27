/**
 * @file The hover tip and the pick: a small tip follows the pointer over a
 * node so identity does not cost a click; a tap names it for a moment; a
 * click selects or activates what the tip named.
 *
 * Composed by the scene (pane mode only; a miniature has no tip) through
 * small ports.
 */
import type { Picker } from '../controls/index.js';
import type { SpaceNode } from './node.js';

/** How long a tap's name stays up after the finger lifts. */
export const TAP_TIP_MS: number = 1500;

/** What the hover reads of the scene and tells it. */
export interface HoverPorts<N extends SpaceNode> {
  picker: Picker;
  /** The canvas the pointer is over; the tip is placed against it and the cursor set on it. */
  canvas: HTMLElement;
  nodes: () => ReadonlyArray<N>;
  /** How the pointer pressed last (`touch` widens the pick). */
  pressKind: () => string | undefined;
  fingersDown: () => number;
  /** The words the tip shows for a node; null for the node's label. */
  words: (node: N) => string | null;
  /** The census draws, never paints a selection. */
  census: () => boolean;
  selected_get: () => string | null;
  selected_set: (id: string | null) => void;
  /** Repaints the selection ring after it changed. */
  selection_paint: () => void;
  select?: (node: N) => void;
  activate?: (node: N) => void;
  /** A click on empty space cleared the selection. */
  deselect?: () => void;
}

/** The scene's hover tip and pick. */
export class HoverTip<N extends SpaceNode> {
  private readonly tip: HTMLDivElement;
  /** The node the tip names, and where the pointer was. */
  private hovered: { id: string; x: number; y: number } | null = null;
  /** The pending hide of a tap's name. */
  private tapTimer: number | null = null;

  /**
   * @param container - Where the tip lives (over the canvas).
   * @param ports - What the hover reads of the scene and tells it.
   */
  constructor(container: HTMLElement, private readonly ports: HoverPorts<N>) {
    this.tip = document.createElement('div');
    this.tip.className = 'dag-node-tip';
    this.tip.hidden = true;
    container.appendChild(this.tip);
  }

  /**
   * Takes the tip out of the page and stops its timer: the scene is done.
   *
   * @example
   * hover.tip_dispose();
   */
  public tip_dispose(): void {
    if (this.tapTimer !== null) window.clearTimeout(this.tapTimer);
    this.tapTimer = null;
    this.tip.remove();
  }

  /** Hides the tip (a gesture began). */
  public hide(): void {
    this.tip.hidden = true;
  }

  /**
   * The pointer left the canvas: a touch keeps the name up a moment, a
   * mouse takes it away.
   *
   * @param event - The leave.
   */
  public leave(event: PointerEvent): void {
    this.hovered = null;
    if (event.pointerType === 'touch' && !this.tip.hidden) {
      if (this.tapTimer !== null) window.clearTimeout(this.tapTimer);
      this.tapTimer = window.setTimeout((): void => {
        this.tapTimer = null;
        if (this.ports.fingersDown() === 0) this.tip.hidden = true;
      }, TAP_TIP_MS);
      return;
    }
    this.tip.hidden = true;
  }

  /**
   * Names the node under the pointer in the tip, or hides it.
   *
   * @param event - The move.
   */
  public hover(event: PointerEvent): void {
    // In census the spheres are members of one instanced mesh: the group
    // under the pointer is what the tip names, as a click would pick.
    const nodeId: string | null = this.ports.picker.node_under(event, this.ports.pressKind() === 'touch');
    const node: N | undefined = nodeId === null ? undefined : this.ports.nodes().find((n: N) => n.id === nodeId);
    if (node === undefined) {
      this.tip.hidden = true;
      this.ports.canvas.style.cursor = '';
      this.hovered = null;
      return;
    }
    this.hovered = { id: node.id, x: event.clientX, y: event.clientY };
    const bounds: DOMRect = this.ports.canvas.getBoundingClientRect();
    this.tip.textContent = this.ports.words(node) ?? node.label;
    this.tip.style.left = `${event.clientX - bounds.left + 14}px`;
    this.tip.style.top = `${event.clientY - bounds.top + 10}px`;
    this.tip.hidden = false;
    this.ports.canvas.style.cursor = 'pointer';
  }

  /**
   * Resolves a pointer event to a node and fires the matching handler. What
   * the tip names is what a click takes, when the pointer has not moved off
   * it: the operator aimed at the node they read.
   *
   * @param event - The click.
   * @param kind - A select (one click) or an activate (two).
   */
  public pick(event: MouseEvent, kind: 'select' | 'activate'): void {
    const held = this.hovered;
    const nodeId: string | null = held !== null && Math.hypot(event.clientX - held.x, event.clientY - held.y) <= 6
      ? held.id
      : this.ports.picker.node_under(event, this.ports.pressKind() === 'touch');
    if (nodeId === null) {
      // Empty space is the natural off switch for the node detail.
      if (kind === 'select' && this.ports.selected_get() !== null) {
        this.ports.selected_set(null);
        this.ports.selection_paint();
        this.ports.deselect?.();
      }
      return;
    }
    const node: N | undefined = this.ports.nodes().find((n: N) => n.id === nodeId);
    if (!node) return;
    if (kind === 'select') {
      this.ports.selected_set(nodeId);
      if (!this.ports.census()) this.ports.selection_paint();
      this.ports.select?.(node);
    } else {
      this.ports.activate?.(node);
    }
  }
}
