/**
 * @file Columns sized by hand: the grip on a cap, the floor a column keeps,
 * and the memory a device holds of what was sized.
 *
 * Every listing declares its tracks once and the façade writes the grid;
 * this module lets a hand move one boundary, the way a file manager does:
 * the boundary under the grip follows the pointer, and the two columns it
 * separates trade the width between them. Where one of the two is the
 * expanse (`1fr`), the other column is sized and the expanse gives or takes
 * the difference; it is never sized itself (law the-expanse-is-never-sized-
 * by-hand), so the alignment the expanse rule bought survives any sizing.
 * (The first build sized the column left of the grip and let the expanse
 * absorb: with the expanse on the left, as NAME is on a files listing, a
 * column then grew away from the hand and the NAME boundary did nothing.) A column keeps the floor its declaration gave it (`minmax`'s
 * min, else 3em), a double-press on the grip gives one column back, and
 * what was sized is remembered per device in the browser's storage, keyed
 * by the listing's prefix and the trait — a tablet and a desk want
 * different widths, so the memory is the device's.
 *
 * @module
 */

/** Whether a track is the expanse: the one `fr` track the rule allows. */
export function track_isExpanse(width: string): boolean {
  // `1fr`, `minmax(8em, 1fr)`: a digit then `fr` at a word's end (no boundary stands between `1` and `f`).
  return /\dfr\b/.test(width);
}

/**
 * The floor a column keeps, in CSS length: `minmax(min, …)`'s min, else
 * the declared width when it is smaller than 3em, else 3em.
 *
 * @param width - The trait's declared track.
 * @returns A CSS length.
 */
export function floor_parse(width: string): string {
  const minmax: RegExpMatchArray | null = width.trim().match(/^minmax\(\s*([^,]+?)\s*,/);
  if (minmax !== null) return (minmax[1] ?? '3em').trim();
  return '3em';
}

/** The storage a device keeps sizes in: the browser's, or a test's. */
export interface ColumnStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORE_PREFIX: string = 'argus.columns';

/** The browser's local storage when it answers, else null (a private window, a blocked origin). */
export function columnStore_default(): ColumnStore | null {
  try {
    const store: Storage | undefined = globalThis.localStorage;
    if (store === undefined) return null;
    store.getItem(`${STORE_PREFIX}.probe`);
    return store;
  } catch {
    return null;
  }
}

/**
 * The sizes a device remembers for one listing.
 *
 * @param store - Where sizes live.
 * @param prefix - The listing's chrome prefix (`files`, `runs`).
 * @param keys - The trait keys the listing has.
 * @returns Trait key → width in px, for the ones remembered.
 */
export function columns_read(store: ColumnStore | null, prefix: string, keys: ReadonlyArray<string>): Map<string, number> {
  const sizes: Map<string, number> = new Map();
  if (store === null) return sizes;
  for (const key of keys) {
    try {
      const raw: string | null = store.getItem(`${STORE_PREFIX}.${prefix}.${key}`);
      const px: number = raw === null ? Number.NaN : Number(raw);
      if (Number.isFinite(px) && px > 0) sizes.set(key, Math.round(px));
    } catch {
      // A store that refuses a read remembers nothing for this key.
    }
  }
  return sizes;
}

/** Remembers one column's size, or forgets it (null). */
export function column_write(store: ColumnStore | null, prefix: string, key: string, px: number | null): void {
  if (store === null) return;
  try {
    if (px === null) store.removeItem(`${STORE_PREFIX}.${prefix}.${key}`);
    else store.setItem(`${STORE_PREFIX}.${prefix}.${key}`, String(Math.round(px)));
  } catch {
    // A store that refuses a write forgets; the size holds for this page.
  }
}

/**
 * One side of a boundary: its track's width now, its floor, and whether it
 * is the expanse with room to stretch. An expanse pinned at its minimum (the
 * row wider than the pane, as on a tablet) is not fluid: it behaves as a
 * fixed column, and the hand moves its minimum.
 */
export interface BoundarySide {
  width: number;
  floor: number;
  expanse: boolean;
}

/** A track's width: the cap's box and its margins (caps keep a hairline margin, so the box alone is short). */
export function trackWidth_measure(cap: HTMLElement): number {
  const style: CSSStyleDeclaration = getComputedStyle(cap);
  return cap.getBoundingClientRect().width + (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0);
}

/**
 * Where a boundary drag lands: the widths the two columns take so the
 * boundary sits `dx` px from where it started (positive is right), clamped
 * so neither column goes under its floor and the expanse keeps its own.
 * A side that is the expanse is not given a width: it takes what is left.
 *
 * @param left - The column left of the boundary.
 * @param right - The column right of it.
 * @param dx - How far the pointer moved since the press.
 * @param expanseSlack - How much the expanse can still give, when it is neither side but absorbs.
 * @param overflowing - Whether the row is already wider than its pane. There
 *   the neighbours are at their minimums and have nothing to trade, so the
 *   column left of the boundary simply grows or shrinks and the row grows
 *   with it, the way Finder's and Explorer's list views do (everything to
 *   the right shifts; the listing scrolls).
 * @returns The new widths (null for a side left alone), and the boundary's actual move.
 */
export function boundary_drag(left: BoundarySide, right: BoundarySide | null, dx: number, expanseSlack: number = 0, overflowing: boolean = false): { left: number | null; right: number | null; moved: number } {
  if (overflowing && !left.expanse) {
    const moved: number = dx >= 0 ? dx : Math.min(0, Math.max(left.floor - left.width, dx));
    return moved === 0 ? { left: null, right: null, moved } : { left: Math.round(left.width + moved), right: null, moved };
  }
  let lo: number;
  let hi: number;
  // A boundary never moves against the hand: a column already narrower than
  // its measured floor (an em read against another font) is not pushed back
  // up, and a side with no room stops the boundary where it is.
  const toward = (wanted: number): number => (dx >= 0 ? Math.max(0, Math.min(hi, wanted)) : Math.min(0, Math.max(lo, wanted)));
  if (right === null) {
    // No sizeable neighbour (the last column, a control track): the left
    // column alone, the expanse elsewhere taking the difference.
    lo = left.floor - left.width; hi = expanseSlack;
    const moved: number = toward(dx);
    return { left: Math.round(left.width + moved), right: null, moved };
  }
  if (left.expanse) {
    // The expanse on the left (NAME on a files listing): the right column's
    // left edge follows the hand; the expanse grows or gives.
    lo = left.floor - left.width; hi = right.width - right.floor;
    const moved: number = toward(dx);
    if (moved === 0) return { left: null, right: null, moved };
    return { left: null, right: Math.round(right.width - moved), moved };
  }
  if (right.expanse) {
    lo = left.floor - left.width; hi = right.width - right.floor;
    const moved: number = toward(dx);
    return { left: Math.round(left.width + moved), right: null, moved };
  }
  // Two fixed columns: they trade; nothing else on the row moves.
  lo = left.floor - left.width; hi = right.width - right.floor;
  const moved: number = toward(dx);
  if (moved === 0) return { left: null, right: null, moved };
  return { left: Math.round(left.width + moved), right: Math.round(right.width - moved), moved };
}

/** What the grips need of their listing. */
export interface GripHooks {
  /** The trait key a cap stands for. */
  key_read: (cap: HTMLElement) => string | null;
  /** Whether a trait's track is the expanse. */
  expanse_is: (key: string) => boolean;
  /** The floor of a column, in px, measured where the cap stands. */
  floor_measure: (key: string) => number;
  /** How much the expanse can still give, in px. */
  expanseSlack: () => number;
  /** A column was dragged to a width. */
  size: (key: string, px: number) => void;
  /** A grip was pressed twice: the column goes back to its declaration. */
  reset: (key: string) => void;
  /** Aborted when the listing is let go: a drag in hand ends there, and the grips hear nothing more. */
  signal?: AbortSignal;
}

/** The class a cap's grip wears. */
export const GRIP_CLASS: string = 'roster-grip';

/**
 * Wires every grip in a caps row: a pointer drag moves the boundary the grip
 * stands on (the two columns beside it trade width, {@link boundary_drag}),
 * a double-press gives those columns back their declared widths, and no
 * press reaches the cap's sort.
 *
 * @param caps - The caps row (`.roster-caps`).
 * @param hooks - The listing's part.
 */
export function grips_wire(caps: HTMLElement, hooks: GripHooks): void {
  for (const grip of caps.querySelectorAll<HTMLElement>(`.${GRIP_CLASS}`)) {
    if (grip.dataset['wired'] === '1') continue;
    grip.dataset['wired'] = '1';
    const cap: HTMLElement | null = grip.closest<HTMLElement>('.roster-cap');
    if (cap === null) continue;
    const heard: AddEventListenerOptions = hooks.signal === undefined ? {} : { signal: hooks.signal };
    grip.addEventListener('click', (event: MouseEvent): void => { event.stopPropagation(); }, heard);
    /** The cap right of this one that stands for a sizeable trait, or null. */
    const neighbour_find = (): { cap: HTMLElement; key: string } | null => {
      let next: Element | null = cap.nextElementSibling;
      while (next !== null && !next.classList.contains('roster-cap')) next = next.nextElementSibling;
      if (!(next instanceof HTMLElement)) return null;
      const key: string | null = hooks.key_read(next);
      return key === null ? null : { cap: next, key };
    };
    grip.addEventListener('dblclick', (event: MouseEvent): void => {
      event.stopPropagation();
      const key: string | null = hooks.key_read(cap);
      const right = neighbour_find();
      // Both columns beside the boundary go back to their declarations; for
      // the expanse that gives back a minimum the hand moved while it was pinned.
      if (key !== null) hooks.reset(key);
      if (right !== null) hooks.reset(right.key);
    }, heard);
    grip.addEventListener('pointerdown', (down: PointerEvent): void => {
      const key: string | null = hooks.key_read(cap);
      if (key === null || down.button !== 0) return;
      down.preventDefault();
      down.stopPropagation();
      // Capture keeps a fast drag on the grip; a pointer the browser does not
      // know (a scripted press) cannot be captured, and the drag still works
      // because the moves are heard on the window, not the grip.
      try { grip.setPointerCapture(down.pointerId); } catch { /* an unknown pointer id */ }
      const startX: number = down.clientX;
      // An expanse with no spare room is pinned at its minimum and acts as a
      // fixed column; one that is stretching is fluid and is never sized.
      const side_measure = (on: HTMLElement, onKey: string): BoundarySide => {
        const width: number = trackWidth_measure(on);
        const floor: number = hooks.floor_measure(onKey);
        return { width, floor, expanse: hooks.expanse_is(onKey) && width > floor + 1 };
      };
      const left: BoundarySide = side_measure(cap, key);
      const neighbour = neighbour_find();
      const right: BoundarySide | null = neighbour === null ? null : side_measure(neighbour.cap, neighbour.key);
      // An expanse with no sizeable neighbour has nothing to trade with.
      if (left.expanse && right === null) return;
      const slack: number = hooks.expanseSlack();
      // A row already wider than its pane: the column grows and the row with it.
      const overflowing: boolean = caps.scrollWidth > caps.clientWidth + 1;
      caps.classList.add('roster-sizing');
      const move = (event: PointerEvent): void => {
        const landed = boundary_drag(left, right, event.clientX - startX, slack, overflowing);
        if (landed.left !== null) hooks.size(key, landed.left);
        if (landed.right !== null && neighbour !== null) hooks.size(neighbour.key, landed.right);
      };
      const up = (): void => {
        caps.classList.remove('roster-sizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        hooks.signal?.removeEventListener('abort', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      // The listing let go in the middle of a drag: the drag ends there, as if the pointer had come up. Its
      // listeners are on the window and would otherwise stay until a pointer-up that may never come.
      hooks.signal?.addEventListener('abort', up, { once: true });
    }, heard);
  }
}

/**
 * A CSS length in px, measured on an element (em and rem resolve against it).
 *
 * @param length - A CSS length (`12em`, `96px`, `5.2rem`).
 * @param on - The element whose font sizes the em is read against.
 * @returns Pixels, or 0 when the length cannot be read.
 */
export function length_px(length: string, on: HTMLElement): number {
  const m: RegExpMatchArray | null = length.trim().match(/^([\d.]+)\s*(px|em|rem)$/);
  if (m === null) return 0;
  const n: number = Number(m[1]);
  if (m[2] === 'px') return n;
  const base: HTMLElement = m[2] === 'rem' ? document.documentElement : on;
  const font: number = Number.parseFloat(getComputedStyle(base).fontSize) || 16;
  return n * font;
}
