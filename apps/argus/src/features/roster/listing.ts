/**
 * @file The listing façade: a pane declares its listing and never wires one.
 *
 * Three panes assembled the same listing by hand — `RosterOrder`, then
 * `ListingHost`, then the chrome lookups, the filter block, the strip
 * observer, the `argus:roster` parse — and then each added an action
 * track, an indication model, a readout and (in one) a selection, again
 * by hand and in two spellings. The parts were shared; the composition
 * was copied, and copied composition drifts. It cost something concrete:
 * the grid gained a track and one row kept its old cell count, and a row
 * one cell short does not leave a gap, it shifts every cell after it.
 *
 * A `Listing` is the composition, owned once. A pane gives it a
 * declaration — traits, key, what a row may do, what its chrome is called
 * — and thereafter calls `rows_set`. The grid template, the caps row and
 * every row's cell count come from that one declaration, action track
 * included, so a pane never states a column count and cannot get it
 * wrong. Two laws of `docs/aegis.adoc` are consequences of the
 * declaration rather than behaviour a pane remembers to implement:
 * `a-row-is-indicated-before-it-is-acted-on` (declared actions split
 * click from double-click on every row that is offered one; no actions,
 * one click) and `a-selection-belongs-to-the-field` (`rows_set` names the
 * field, and a selection lives exactly as long as that name holds). A
 * third, `a-row-s-verbs-live-in-the-frame`, is the row zone: declared, a
 * row's verbs leave the row for the frame, no track is minted, and the
 * frame opens as they arrive.
 *
 * Built OVER the existing parts, additively: `RosterOrder` and
 * `ListingHost` keep their signatures, and no pane is touched here. The
 * panes convert one at a time, and their own spellings die as they do.
 *
 * @module
 */
import { columnStore_default, columns_read, column_write, floor_parse, grips_wire, length_px, track_isExpanse, type ColumnStore } from './columns.js';
import { RosterOrder, type RosterTerm } from './order.js';
import { barState_clear, barState_set } from './bar.js';
import { ListingHost } from './host.js';
import {
  actionCell_build,
  expansion_isOpen,
  expansion_toggle,
  leadingCells_count,
  listingRow_build,
  track_isFixed,
  traitColumns_map,
  traitValue_make,
  type Expansion,
  type ListingAction,
  type ListingTrait,
} from './row.js';

/**
 * One group of rows on stage: a listed directory, a query's answer, a
 * study's series. A flat listing passes one.
 *
 * @property key - Names the block, so a repaint can tell blocks apart.
 * @property header - What heads the block, when something does.
 * @property lead - Rows drawn before the ordered rows and outside the
 *   order: never sorted, filtered, counted, selected or given verbs. A
 *   browser's `..` is one.
 * @property rows - The rows the order governs.
 */
export interface ListingBlock<T> {
  key: string;
  header?: HTMLElement;
  lead?: ReadonlyArray<T>;
  rows: ReadonlyArray<T>;
}

/**
 * Where a pane's listing chrome is found.
 *
 * Every pane already follows one convention with a per-pane prefix:
 * `.pane-state` is common, and the mode-frame blocks are `<prefix>-filter`
 * and `<prefix>-select`. The façade finds them itself from the root, so
 * the pane writes no lookups. The row zone is not found this way: it is
 * declared (`rowZone`), because declaring it changes the grid.
 *
 * @property root - The element the chrome lives under (the pane, or a
 *   stamped body that carries its own frame).
 * @property prefix - The pane's block prefix (`files`, `runs`, `pacs`).
 */
export interface ListingChrome {
  root: HTMLElement;
  prefix: string;
}

/**
 * What the façade knows when it writes the state line.
 *
 * Typed rather than positional: a list of strings would be one more thing
 * whose order two sides have to agree on.
 *
 * @property filter - The order's own summary (`FILTERED n/m`), or empty.
 * @property selecting - Whether SELECT is on.
 * @property selected - How many rows are selected.
 * @property shown - How many of those are on stage under the filter.
 */
export interface ListingStateParts {
  filter: string;
  selecting: boolean;
  selected: number;
  shown: number;
  /** Columns standing aside because the pane is too narrow for them all. */
  shed?: number;
}

/**
 * The verbs a row may be given, and where they are held.
 *
 * On a listing without a row zone, declaring actions is what mints the
 * action track: a fixed column, on every row, reserved whether or not the
 * row is indicated. On a listing that declares a row zone the verbs leave
 * the row for the frame and no track is minted, so `width` is not read.
 * A listing that declares no actions keeps its single click.
 *
 * @property width - The track's CSS grid track (`21em`). Required unless
 *   the listing routes its verbs to a row zone.
 * @property of - The verbs for one row. A row offered none keeps its
 *   single click: there is nothing to indicate before acting on it.
 * @property always - Draw every row's verbs at once rather than on
 *   indication; the click then activates, as with no actions at all.
 */
export interface ListingActions<T> {
  width?: string;
  of: (row: T) => ReadonlyArray<ListingAction<T>>;
  always?: boolean;
}

/**
 * A pane's own row-level concerns: state that marks a row rather than a
 * column (a refused read, an arrival), and anything else it wants on the
 * element.
 *
 * @property className - Extra classes for the row element.
 * @property decorate - Runs on the built row: title, dataset, whatever.
 */
export interface ListingRowBuild<T> {
  className?: (row: T) => string;
  decorate?: (element: HTMLElement, row: T) => void;
  /**
   * Extra classes for the GROUP a row heads when the level has a child:
   * the wrapper holding the row and, while the row is open, its level.
   */
  groupClassName?: (row: T) => string;
}

/**
 * What a selection may be told to do.
 *
 * @property verbs - The verbs for the current selection, as key/row pairs
 *   in selection order.
 */
export interface ListingSelection<T> {
  verbs: (rows: ReadonlyArray<[string, T]>) => ReadonlyArray<ListingAction<void>>;
}

/**
 * A level beneath a level: one row's children, listed under it when the
 * row is open.
 *
 * The child's row type is its own and never leaks into the parent's
 * declaration — `level_visit` hands both halves to a visitor generic in
 * that type, which is how the façade builds the child level without
 * either side naming the other's rows. Make one with `listingChild_declare`.
 */
export interface ListingChild<T> {
  level_visit<R>(visitor: <C>(of: (row: T) => ReadonlyArray<C>, declaration: ListingLevel<C>) => R): R;
}

/**
 * Declares a child level.
 *
 * @param of - One row's children.
 * @param declaration - How the children list.
 * @returns The child, ready for a parent's `child`.
 */
export function listingChild_declare<T, C>(
  of: (row: T) => ReadonlyArray<C>,
  declaration: ListingLevel<C>,
): ListingChild<T> {
  return {
    level_visit<R>(visitor: <X>(of: (row: T) => ReadonlyArray<X>, declaration: ListingLevel<X>) => R): R {
      return visitor(of, declaration);
    },
  };
}

/**
 * What every level of a listing declares: the shape of its rows.
 *
 * @property traits - The columns, in cap order; each carries its track.
 * @property key - A row's identity, the string everything else is keyed by.
 * @property actions - The row verbs, when there are any.
 * @property activate - What activating a row does. With a child level the
 *   row also folds open or closed.
 * @property activatable - Whether a row answers a click at all; absent
 *   means every row does.
 * @property indicated - Told when a row is indicated (a regard write).
 * @property row - The pane's own row-level concerns.
 * @property defaultSort - The initial sort, when the level has a natural one.
 * @property child - The level beneath this one, if any.
 * @property control - The key of the trait whose cell is the row's
 *   CONTROL: the thing that activates it — folds it, on a level with a
 *   child; enters or opens it, on one that replaces the listing.
 *   Navigating and selecting are two intents and must not share a
 *   gesture: a press in this cell activates the row and nothing else — no
 *   indication, no verbs, the field stays lit — while a press anywhere
 *   else on the row indicates it and does not activate. The cell wears
 *   `.listing-control` so it can be drawn as the capsule it is (OPEN,
 *   CLOSE, UP, HERE). Absent, a folding row's click folds and indicates
 *   at once, and a replacing row keeps click-indicates, double-click-goes.
 */
export interface ListingLevel<T> {
  traits: ReadonlyArray<ListingTrait<T>>;
  key: (row: T) => string;
  /**
   * What the KERNEL calls this row — a path, an id — when it is a row the
   * session can number.
   *
   * A row of the session's last answer can be named by the number beside
   * it (`gather add @2,3`), and a level that says how its rows are
   * addressed gets an index pill as its leading column. The pill is found
   * by ADDRESS rather than by counting down the screen, so a sorted or
   * filtered listing still shows each row the number `@N` would actually
   * reach. A level that declares none has no pills, which is the honest
   * default: a row nothing can name must not wear a number.
   */
  address?: (row: T) => string | undefined;
  actions?: ListingActions<T>;
  activate?: (row: T) => void;
  activatable?: (row: T) => boolean;
  indicated?: (row: T) => void;
  row?: ListingRowBuild<T>;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /**
   * Filter terms that are not columns: `key:text` keeps the rows whose value
   * holds the text, and a bare word searches them too (the runs roster's
   * `tag:`, whose tags are marks beside the title rather than a column).
   */
  terms?: ReadonlyArray<RosterTerm<T>>;
  child?: ListingChild<T>;
  control?: string;
}

/**
 * The root level, plus what only the root has: where it mounts, what
 * chrome it binds, whether it selects, how its state line reads.
 *
 * @property mount - The listing region: the frame seats at its head, the
 *   field opens beneath.
 * @property gridHost - Where `--roster-cols` is written. Defaults to the
 *   mount; a pane whose form stands on the same grid outside the mount
 *   names an ancestor of both.
 * @property chrome - The pane's chrome, when it has any to bind.
 * @property caps - Where the caps row lives: once in the frame (`root`),
 *   or minted afresh at the head of every block (`each`).
 * @property rowZone - The frame's row zone, where a row's verbs live.
 *   A listing whose mount stands in a framed field (a `.mode-frame`
 *   beside it) gets one MINTED there by the façade and need declare
 *   nothing; this names one explicitly for a mount framed some other way.
 *   With a zone no level mints an action track — a row keeps its columns
 *   and the expanse grows into the freed width — and the indicated row's
 *   verbs are drawn in the zone, one beneath another as the frame's other
 *   blocks are, with the readout under them; a selection's verbs ride the
 *   same zone. Verbs arriving in the zone open the frame it stands on; the
 *   last of them leaving retracts it, unless the operator has since
 *   pressed something else on the frame; and the frame retracting (Esc,
 *   the strip, a touch on the field) un-indicates the row, so an
 *   indicated row and an open frame are one state. A listing with no
 *   frame at all keeps the in-row track. A listing that selects must have
 *   a zone: a selection's verbs have nowhere else to go.
 * @property selection - Declared when the listing can select.
 * @property state - Composes the state line from the façade's parts; a
 *   pane prepends its own words here. Null leaves the span untouched.
 */
export interface ListingDeclaration<T> extends ListingLevel<T> {
  mount: HTMLElement;
  gridHost?: HTMLElement;
  chrome?: ListingChrome;
  caps?: 'root' | 'each';
  rowZone?: HTMLElement;
  selection?: ListingSelection<T>;
  state?: (parts: ListingStateParts) => string | null;
  /**
   * What the field says when blocks were set but hold no rows: an answer
   * with nothing in it, which is a fact worth a line, as against no answer
   * yet, which is silence. Absent, the field is simply empty.
   */
  empty?: () => HTMLElement;
  /**
   * What the field says when rows were set but the filter keeps every one
   * of them off stage: a pane that can do something about a miss (ask the
   * session for what the filter names) says so here, given the filter's
   * text. Absent, the field is simply empty under `FILTERED 0/n`.
   */
  filteredEmpty?: (text: string) => HTMLElement;
  /**
   * What a press on the frame's REFRESH block does: the pane asks its
   * source again, bypassing whatever the session remembers. Absent, the
   * block (when the markup has one) does nothing.
   */
  refresh?: () => void;
}

/**
 * Draws a block some other way than the grid — cards, previews. The
 * façade still opens the field, orders the rows and seats the frame; the
 * painter draws what it is given, rows already in order.
 */
export type ListingPainter<T> = (block: ListingBlock<T>, into: HTMLElement) => void;

/** The detail an `argus:roster` event carries. */
type RosterEventDetail =
  | { op: 'sort'; key: string; dir?: 'asc' | 'desc' }
  | { op: 'filter'; text: string };

/**
 * What a parent level asks of the level beneath it, with the child's row
 * type erased.
 */
interface ChildSeat<T> {
  /** Passes the filter text down; every level reads the one strip. */
  filter_set(text: string): void;
  /** Passes a sort down; a key names its level and the others ignore it. */
  sort_set(key: string, dir: 'asc' | 'desc'): void;
  /** Whether any of a row's children survive the filter. */
  survives(parent: T): boolean;
  /** Draws a row's children beneath it. */
  render(parent: T, into: HTMLElement, whole: boolean): void;
  /** Drops everything it held about the rows last drawn. */
  forget(): void;
  /** Sets which rows are open at a depth beneath this seat's level. */
  open_set(depth: number, keys: ReadonlyArray<string>): void;
  /** Closes every row at every depth beneath. */
  open_clear(): void;
  /** The template at a depth beneath this seat's level. */
  template_select(depth: number): string;
}

/** What a level asks of the listing that holds it. */
interface LevelHost {
  /** Repaints the whole listing on the next frame. */
  repaint(): void;
  /**
   * Whether the listing routes its verbs to a row zone, so no level mints
   * a track and every level's indication is drawn in the one zone.
   */
  framed(): boolean;
  /** Whether this row's activation is still in flight. */
  activating_is(key: string): boolean;
  /** Acknowledges a press: lights the row and says OPENING on the bar. */
  activation_begin(key: string, element: HTMLElement | null, name: string): void;
  /** Draws the indicated row's verbs in the row zone; none empties it. */
  zoneVerbs_set(capsules: ReadonlyArray<Node>): void;
  /** Says something beneath the zone's verbs, about the indicated row. */
  zoneReadout_set(text: string | Node): void;
  /**
   * A level indicated a row: the listing holds ONE indication across its
   * levels, so the level that held it before stands down quietly, and the
   * listing can restore this one after a repaint.
   */
  indication_claim(claim: IndicationClaim): void;
  /** A level stood its row down of its own accord (or had nothing). */
  indication_release(level: object): void;
}

/**
 * The one indication a listing holds, whichever level holds it.
 *
 * @property level - The level holding it, as an identity.
 * @property key - The indicated row's key at that level.
 * @property drop - Stands the row down quietly: class off, cell emptied,
 *   no callbacks and no zone change — the claim that replaces it draws.
 * @property restore - Indicates the same row again without telling the
 *   pane, after a repaint or a stage change; false when the row has left.
 */
interface IndicationClaim {
  level: object;
  key: string;
  drop: () => void;
  restore: () => boolean;
}

/**
 * How a level's click gathers a row while SELECT is on. Only the root
 * level selects; a level beneath has none and its rows indicate or
 * activate as they would otherwise.
 */
type LevelSelect<T> = ((key: string, row: T) => boolean) | null;

/**
 * Computes a level's grid template from its traits and its actions.
 *
 * @param traits - The columns.
 * @param actions - The action track, when declared and when the verbs
 *   live on the row; a listing whose verbs ride the frame passes none.
 * @returns The `grid-template-columns` value.
 * @throws {Error} When a trait carries no width, an uncapped trait
 *   follows a capped one, or actions on the row declare no track — each
 *   a declaration error that would otherwise surface as a shifted row.
 */
export function listingTemplate_build<T>(
  traits: ReadonlyArray<ListingTrait<T>>,
  actions?: ListingActions<T>,
  sized?: ReadonlyMap<string, number>,
): string {
  const tracks: string[] = [];
  let cappedSeen: boolean = false;
  for (const trait of traits) {
    if (trait.width === undefined || trait.width.trim() === '') {
      throw new Error(`listing trait '${trait.key}' declares no width`);
    }
    if (!track_isFixed(trait.width)) {
      throw new Error(`listing trait '${trait.key}' declares a content-sized track '${trait.width.trim()}': a row is its own grid, so a track sized to its content sizes per row and jogs every column after it`);
    }
    if (trait.capped === false) {
      if (cappedSeen) throw new Error(`uncapped listing trait '${trait.key}' must lead the traits`);
    } else {
      cappedSeen = true;
    }
    // A column sized by hand takes its px. The expanse keeps its `1fr`, so it
    // still takes whatever room is spare; a hand can only move its minimum,
    // which is what it shows when the row is wider than the pane (columns.ts).
    const px: number | undefined = sized?.get(trait.key);
    if (px === undefined) tracks.push(trait.width.trim());
    else tracks.push(track_isExpanse(trait.width) ? `minmax(${px}px, 1fr)` : `${px}px`);
  }
  if (actions !== undefined) {
    if (actions.width === undefined || actions.width.trim() === '') {
      throw new Error('listing actions on the row declare no track; declare a width, or a row zone for the verbs to ride');
    }
    if (!track_isFixed(actions.width)) {
      throw new Error(`listing actions declare a content-sized track '${actions.width.trim()}'`);
    }
    tracks.push(actions.width.trim());
  }
  return tracks.join(' ');
}

/** One numbered row as the kernel tells it: its kind, its place, its address. */
export interface NumberedHandle {
  kind: string;
  ordinal: number;
  address: string;
}

/** Which listing the session's numbers currently count. */
let numbering: { source: string; handles: ReadonlyArray<NumberedHandle> } | null = null;

/** Address to the handle that reaches it, rebuilt whenever the numbering changes. */
let handleByAddress: Map<string, NumberedHandle> = new Map();

/** How wide each kind's sequence runs, so its codes pad alike. */
let widthByKind: Map<string, number> = new Map();

/**
 * Takes the session's numbering, and repaints every pill on the surface.
 *
 * @param held - What the kernel says is numbered, or null for nothing.
 */
export function listingNumbering_set(
  held: { source: string; handles: ReadonlyArray<NumberedHandle> } | null,
): void {
  numbering = held;
  handleByAddress = new Map();
  widthByKind = new Map();
  if (held !== null) {
    for (const handle of held.handles) {
      // First wins: a listing that holds the same address twice numbers the
      // first, which is the one the handle reaches.
      if (!handleByAddress.has(handle.address)) handleByAddress.set(handle.address, handle);
      widthByKind.set(handle.kind, Math.max(widthByKind.get(handle.kind) ?? 0, `${handle.ordinal}`.length));
    }
  }
  listingPills_paint();
}

/** What the surface believes is numbered, for a readout that says so. */
export function listingNumbering_get(): { source: string; handles: ReadonlyArray<NumberedHandle> } | null {
  return numbering;
}

/**
 * Draws a handle the way the operator types it: the kind, then the place
 * zero-padded to the width its sequence needs, never fewer than three.
 *
 * @param handle - The row's handle.
 * @returns The code, such as `SER003`.
 */
export function handle_render(handle: NumberedHandle): string {
  const width: number = Math.max(3, widthByKind.get(handle.kind) ?? 0);
  return `${handle.kind}${`${handle.ordinal}`.padStart(width, '0')}`;
}

/**
 * Paints every index pill on the surface.
 *
 * Two numbers can stand in this cell and they are not the same thing. A
 * row the session's last answer holds wears the number `@N` reaches, LIT:
 * what you read is what you type. Every other row wears its own place in
 * the listing, dim — a counter, useful for reading and not a promise that
 * anything answers to it. The distinction is the hue, not the digits.
 *
 * Numbers are zero-padded to the widest in their listing, so the column is
 * a column rather than a ragged edge, and a row's digits do not shift as
 * the listing grows past ten.
 */
export function listingPills_paint(): void {
  // Grouped by the element each row actually sits in, not by a container
  // class: a child level mounts its rows in its own group, and a paint that
  // only knew the root's container left every nested listing unpadded.
  const groups: Map<HTMLElement, HTMLElement[]> = new Map();
  for (const pill of document.querySelectorAll<HTMLElement>('.listing-index')) {
    const row: HTMLElement | null = pill.closest<HTMLElement>('.listing-row');
    const parent: HTMLElement | null = row?.parentElement ?? null;
    if (row === null || parent === null) continue;
    if (row.classList.contains('listing-lead')) {
      // A lead row stands outside the order — `..` is the way out of the
      // listing, not the first thing in it — so it keeps the cell, empty.
      pill.textContent = '';
      pill.classList.remove('numbered');
      continue;
    }
    // The blocks of one field count as one: a roster led by a NEW block
    // counts on through it, not 1 then 001 again.
    const block: boolean = parent.classList.contains('listing-rows') && parent.parentElement?.classList.contains('listing-block') === true;
    const key: HTMLElement = block ? (parent.closest<HTMLElement>('.listing-field') ?? parent) : parent;
    const held: HTMLElement[] | undefined = groups.get(key);
    if (held === undefined) groups.set(key, [row]); else held.push(row);
  }

  for (const rows of groups.values()) {
    // A row the session reaches wears its HANDLE, lit — the code the
    // operator types. Every other row counts itself, dim, padded to the
    // group so the column stays a column: a counter, and since a bare
    // number is nothing the operator can type, plainly not a promise.
    const width: number = `${Math.max(rows.length, 1)}`.length;
    rows.forEach((row: HTMLElement, at: number): void => {
      const pill: HTMLElement | null = row.querySelector<HTMLElement>('.listing-index');
      if (pill === null) return;
      const address: string | undefined = pill.dataset['address'];
      const handle: NumberedHandle | undefined = address === undefined ? undefined : handleByAddress.get(address);
      pill.textContent = handle === undefined ? `${at + 1}`.padStart(width, '0') : handle_render(handle);
      pill.classList.toggle('numbered', handle !== undefined);
    });
  }
}

/**
 * The index trait a level with addressable rows leads with.
 *
 * @returns The synthesized leading trait.
 */
function indexTrait_build<T>(address?: (row: T) => string | undefined): ListingTrait<T> {
  return {
    key: 'index',
    label: '',
    className: 'listing-index-cell',
    width: '5.2rem',
    capped: false,
    cell: (row: T): HTMLElement => {
      const pill: HTMLElement = document.createElement('span');
      pill.className = 'listing-index';
      const held: string | undefined = address?.(row);
      if (held !== undefined) pill.dataset['address'] = held;
      const handle: NumberedHandle | undefined = held === undefined ? undefined : handleByAddress.get(held);
      if (handle !== undefined) {
        pill.textContent = handle_render(handle);
        pill.classList.add('numbered');
      }
      return pill;
    },
  };
}

/**
 * One level of a listing: its order, its rows on stage, its indication,
 * and the level beneath it. The root listing is one of these with chrome
 * and a selection around it.
 */
class Level<T> {
  private declaration: ListingLevel<T>;
  private readonly host: LevelHost;
  private readonly select: LevelSelect<T>;
  public readonly order: RosterOrder<T>;
  public template: string;
  private readonly child: ChildSeat<T> | null;
  private readonly expansion: Expansion;
  /** Every row on stage, by key. */
  private readonly rowsByKey: Map<string, HTMLElement> = new Map();
  /** Every row's data, by key, for verbs and callbacks. */
  private readonly dataByKey: Map<string, T> = new Map();
  /** Every row's action cell, by key, so indicating fills one. */
  private readonly cellsByKey: Map<string, HTMLElement> = new Map();
  /** Rows drawn outside the order: no verbs, no selection. */
  private readonly leadKeys: Set<string> = new Set();
  private indicated: string | null = null;
  /** How many levels above this one: the root is 0. */
  private readonly depth: number;

  /**
   * @param declaration - The level's shape.
   * @param host - The listing holding it.
   * @param capsInRoot - Whether this level's frame carries a caps row.
   * @param select - Gathers a clicked row while SELECT is on, returning
   *   true when it did; null for a level that never selects.
   * @param depth - How many levels above this one; the root is 0.
   */
  constructor(declaration: ListingLevel<T>, host: LevelHost, capsInRoot: boolean, select: LevelSelect<T>, depth: number = 0) {
    // A level whose rows the kernel can name leads with an index pill. The
    // façade mints the column so every listing wears it the same way, and
    // so a pane gains it by saying how its rows are addressed rather than
    // by drawing a number itself.
    // EVERY level leads with the index column: a listing is a numbered
    // thing whether or not the session can reach into it, and a column
    // that appeared only on some listings would move the geometry between
    // panes. What an address buys is the LIT number — the one `@N` takes.
    declaration = { ...declaration, traits: [indexTrait_build(declaration.address), ...declaration.traits] };
    this.declaration = declaration;
    this.host = host;
    this.select = select;
    this.depth = depth;
    this.template = listingTemplate_build(declaration.traits, this.trackActions_get(), this.sized);
    const capped: ReadonlyArray<ListingTrait<T>> = declaration.traits.filter(
      (trait: ListingTrait<T>): boolean => trait.capped !== false,
    );
    this.order = new RosterOrder<T>(
      traitColumns_map(capped),
      traitValue_make(declaration.traits),
      (): void => this.host.repaint(),
      declaration.defaultSort,
      leadingCells_count(declaration.traits),
      capsInRoot,
      declaration.terms ?? [],
    );
    this.expansion = { mode: declaration.child === undefined ? 'replace' : 'fold', open: new Set<string>() };
    this.child = declaration.child === undefined ? null : this.childSeat_build(declaration.child);
    if (this.child !== null) {
      const seat: ChildSeat<T> = this.child;
      this.order.filterChange_observe((text: string): void => seat.filter_set(text));
    }
  }

  /** Builds the level beneath this one, its row type kept to itself. */
  private childSeat_build(child: ListingChild<T>): ChildSeat<T> {
    return child.level_visit(<C>(of: (row: T) => ReadonlyArray<C>, declaration: ListingLevel<C>): ChildSeat<T> => {
      const level: Level<C> = new Level<C>(declaration, this.host, false, null, this.depth + 1);
      return {
        filter_set: (text: string): void => level.filter_set(text),
        sort_set: (key: string, dir: 'asc' | 'desc'): void => level.sort_set(key, dir),
        survives: (parent: T): boolean => level.anyMatch(of(parent)),
        render: (parent: T, into: HTMLElement, whole: boolean): void => {
          const element: HTMLElement = document.createElement('div');
          element.className = 'listing-level';
          // The stylesheet indents by depth, never by which pane this is.
          element.dataset['depth'] = String(this.depth + 1);
          element.style.setProperty('--roster-cols', level.template);
          element.appendChild(level.order.caps_mint());
          level.rows_draw(of(parent), [], element, whole);
          into.appendChild(element);
        },
        forget: (): void => level.forget(),
        open_set: (depth: number, keys: ReadonlyArray<string>): void => level.open_set(depth, keys),
        open_clear: (): void => level.open_clear(),
        template_select: (depth: number): string => level.template_select(depth),
      };
    });
  }

  /**
   * Declares, or withdraws, the row verbs after construction.
   *
   * A surface declares what a row may do once it knows, which is after
   * the pane exists; a browser given no verbs keeps its single click and
   * spends no track. The template follows the declaration.
   *
   * @param actions - The verbs and their track, or null for none.
   */
  public actions_set(actions: ListingActions<T> | null): void {
    this.declaration = { ...this.declaration, ...(actions === null ? { actions: undefined } : { actions }) };
    this.template = listingTemplate_build(this.traits_shown(), this.trackActions_get(), this.sized);
  }

  /** The columns standing aside because the pane is too narrow (their keys). */
  public readonly shed: Set<string> = new Set();

  /** The traits on stage: every declared one but those standing aside. */
  public traits_shown(): ReadonlyArray<ListingTrait<T>> {
    return this.shed.size === 0 ? this.declaration.traits : this.declaration.traits.filter((trait: ListingTrait<T>): boolean => !this.shed.has(trait.key));
  }

  /**
   * Which columns stand aside, and the template without them.
   *
   * @param keys - The trait keys to set aside.
   */
  public shed_set(keys: ReadonlyArray<string>): void {
    this.shed.clear();
    for (const key of keys) this.shed.add(key);
    this.template = listingTemplate_build(this.traits_shown(), this.trackActions_get(), this.sized);
  }

  /** The keys that may stand aside, in the order they give way (rank 1 first). */
  public shedOrder(): string[] {
    return this.declaration.traits
      .filter((trait: ListingTrait<T>): boolean => trait.shed !== undefined)
      .sort((a: ListingTrait<T>, b: ListingTrait<T>): number => (a.shed as number) - (b.shed as number))
      .map((trait: ListingTrait<T>): string => trait.key);
  }

  /** A trait's cap label, for naming what stood aside. */
  public label_find(key: string): string {
    return this.declaration.traits.find((trait: ListingTrait<T>): boolean => trait.key === key)?.label ?? key;
  }

  /** The columns sized by hand, trait key → px; the template follows (columns.ts). */
  public readonly sized: Map<string, number> = new Map();

  /** Sizes one column (null gives it back to its declaration) and rewrites the template. */
  public column_size(key: string, px: number | null): void {
    if (px === null) this.sized.delete(key); else this.sized.set(key, px);
    this.template = listingTemplate_build(this.traits_shown(), this.trackActions_get(), this.sized);
  }

  /** The declared track of a trait, for its floor. */
  public track_find(key: string): string | null {
    return this.declaration.traits.find((trait: ListingTrait<T>): boolean => trait.key === key)?.width ?? null;
  }

  /** The trait keys, in grid order. */
  public traitKeys(): string[] {
    return this.declaration.traits.map((trait: ListingTrait<T>): string => trait.key);
  }

  /** The expanse trait's key and track, when the level declares one. */
  public expanse_find(): { key: string; width: string } | null {
    const expanse: ListingTrait<T> | undefined = this.declaration.traits.find((trait: ListingTrait<T>): boolean => track_isExpanse(trait.width ?? ''));
    return expanse === undefined ? null : { key: expanse.key, width: expanse.width ?? '' };
  }

  /**
   * The actions the grid must make room for: the declared ones on a
   * listing whose verbs live on the row, none on a listing whose verbs
   * ride the frame's row zone.
   */
  private trackActions_get(): ListingActions<T> | undefined {
    return this.host.framed() ? undefined : this.declaration.actions;
  }

  /** Sets this level's filter text and passes it beneath. */
  public filter_set(text: string): void {
    this.order.filter_set(text, false);
  }

  /** Sorts this level and every level beneath by a key each may ignore. */
  public sort_set(key: string, dir: 'asc' | 'desc'): void {
    this.order.sort_set(key, dir);
    this.child?.sort_set(key, dir);
  }

  /**
   * Sets which rows are open at a depth counted from this level (0 = here).
   *
   * @param depth - Levels beneath this one.
   * @param keys - The keys to hold open there; every other row closes.
   */
  public open_set(depth: number, keys: ReadonlyArray<string>): void {
    if (depth === 0) {
      this.expansion.open.clear();
      if (this.expansion.mode === 'fold') for (const key of keys) this.expansion.open.add(key);
      return;
    }
    this.child?.open_set(depth - 1, keys);
  }

  /** Closes every row at this level and every level beneath. */
  public open_clear(): void {
    this.expansion.open.clear();
    this.child?.open_clear();
  }

  /**
   * The grid template at a depth counted from this level (0 = here).
   *
   * @param depth - Levels beneath this one.
   * @returns The template.
   * @throws {Error} When no level exists at that depth.
   */
  public template_select(depth: number): string {
    if (depth === 0) return this.template;
    if (this.child === null) throw new Error(`no listing level at depth ${this.depth + depth}`);
    return this.child.template_select(depth - 1);
  }

  /** Whether any row of a set survives the filter, at this level or beneath. */
  public anyMatch(rows: ReadonlyArray<T>): boolean {
    return rows.some((row: T): boolean => this.order.matches(row) || (this.child?.survives(row) ?? false));
  }

  /** Whether the filter is empty, so every row is whole. */
  public filter_isEmpty(): boolean {
    return this.order.state_get().filter.length === 0;
  }

  /**
   * The rows the order keeps, in order.
   *
   * @param rows - The rows.
   * @param whole - Whether every row is kept regardless of the filter (the
   *   parent matched, so its children all show).
   * @returns The kept rows, sorted.
   */
  public rows_keep(rows: ReadonlyArray<T>, whole: boolean): T[] {
    const kept: T[] = whole
      ? [...rows]
      : rows.filter((row: T): boolean => this.order.matches(row) || (this.child?.survives(row) ?? false));
    return this.order.sorted(kept);
  }

  /** Drops everything held about the rows last drawn. */
  public forget(): void {
    this.rowsByKey.clear();
    this.dataByKey.clear();
    this.cellsByKey.clear();
    this.leadKeys.clear();
    this.indicated = null;
    this.child?.forget();
  }

  /**
   * Draws lead rows, then the kept rows in order, each open row followed
   * by its children.
   *
   * @param rows - The rows the order governs.
   * @param lead - Rows drawn first and outside the order.
   * @param into - The element rows are appended to.
   * @param whole - Whether every row is kept regardless of the filter.
   * @returns How many governed rows were drawn.
   */
  public rows_draw(rows: ReadonlyArray<T>, lead: ReadonlyArray<T>, into: HTMLElement, whole: boolean): number {
    for (const row of lead) into.appendChild(this.row_build(row, true));
    const kept: T[] = this.rows_keep(rows, whole);
    for (const row of kept) {
      const element: HTMLElement = this.row_build(row, false);
      if (this.child === null) {
        into.appendChild(element);
        continue;
      }
      // A row that heads a level is wrapped with it: the group is the
      // thing that opens and closes, and a stylesheet or a scenario can
      // address "this study and its series" as one element.
      const key: string = this.declaration.key(row);
      // A filter that hides its own matches behind a fold is a filter that
      // did not answer: a row kept only because a CHILD matched opens, so
      // what the filter found is what the operator sees — and what a verb
      // reading the field then acts on.
      const survivesByChild: boolean = this.order.filterText_get() !== ''
        && !this.order.matches(row)
        && (this.child?.survives(row) ?? false);
      const open: boolean = expansion_isOpen(this.expansion, key) || survivesByChild;
      const group: HTMLElement = document.createElement('div');
      const own: string | undefined = this.declaration.row?.groupClassName?.(row);
      group.className = `listing-group${open ? ' listing-open' : ''}${own === undefined || own === '' ? '' : ` ${own}`}`;
      group.appendChild(element);
      if (open) {
        element.classList.add('listing-open');
        this.child.render(row, group, whole || this.order.matches(row));
      }
      into.appendChild(group);
    }
    return kept.length;
  }

  /**
   * Builds one row: a cell per trait, then the action track when actions
   * are declared and live on the row, then the pane's own decoration; and
   * wires the click.
   *
   * @param row - The row's data.
   * @param lead - Whether the row stands outside the order.
   * @returns The row element.
   */
  private row_build(row: T, lead: boolean): HTMLElement {
    const declaration: ListingLevel<T> = this.declaration;
    const key: string = declaration.key(row);
    const framed: boolean = this.host.framed();
    const element: HTMLElement = listingRow_build(row, this.traits_shown(), {
      className: (data: T): string => {
        const own: string | undefined = declaration.row?.className?.(data);
        return own === undefined || own === '' ? 'listing-row' : `listing-row ${own}`;
      },
      decorate: (built: HTMLElement, data: T): void => {
        built.dataset['key'] = key;
        if (declaration.actions !== undefined && !framed) {
          // The track is on EVERY row, lead rows included, and empty until
          // the row is indicated: what changes on indication is what the
          // track holds, never the geometry around it.
          const cell: HTMLSpanElement = document.createElement('span');
          cell.className = 'listing-actions';
          if (!lead && declaration.actions.always === true) {
            cell.replaceChildren(...actionCell_build(data, declaration.actions.of(data)).childNodes);
          }
          built.appendChild(cell);
          this.cellsByKey.set(key, cell);
        }
        declaration.row?.decorate?.(built, data);
      },
    });
    this.rowsByKey.set(key, element);
    this.dataByKey.set(key, row);
    if (lead) {
      this.leadKeys.add(key);
      // A lead row stands outside the order — `..` is not the first thing
      // in the listing, it is the way out of it — so the counter skips it.
      element.classList.add('listing-lead');
    }
    if (declaration.activatable?.(row) === false) return element;
    element.classList.add('listing-activatable');
    // Only a row with verbs to hide learns the split; one offered none —
    // a directory the browser enters, say, or its `..` — has nothing to
    // indicate before acting on it, and asking for a second click while
    // offering nothing for the first is a worse bargain than the one it
    // replaced. A lead row is judged the same way: `..` is offered
    // nothing and keeps one click; `.` is offered the place's verbs.
    const splits: boolean = declaration.actions !== undefined
      && declaration.actions.always !== true
      && declaration.actions.of(row).length > 0;
    // A row that FOLDS stays on stage when activated, so its click can
    // do both: open or close it, and indicate it. A row that replaces
    // the listing cannot — going and staying are different gestures.
    const folds: boolean = !lead && this.child !== null;
    // With a control declared, the two intents are kept apart on the row
    // itself: the control's cell activates (folds, enters, opens) and
    // nothing else; the rest of the row indicates and does not activate.
    const controlCell: HTMLElement | null = this.controlCell_find(element);
    element.addEventListener('click', (event: Event): void => {
      if (!lead && this.select !== null && this.select(key, row)) return;
      if (controlCell !== null && event.target instanceof Node && controlCell.contains(event.target)) {
        // Entering or opening moves on, so whatever was indicated stands
        // down first (as it does on a double-click) and the frame it held
        // open retracts; a fold stays on stage and keeps its indication.
        if (!folds) this.row_indicate(null);
        this.row_activate(row, key, lead);
        return;
      }
      if (!splits) {
        this.row_activate(row, key, lead);
        return;
      }
      // A click says "this one"; a double-click says "go". Only a listing
      // that hides verbs until a row is indicated needs the split.
      this.row_indicate(key);
      if (folds && controlCell === null) this.row_activate(row, key, false);
    });
    if (splits && !folds) {
      element.addEventListener('dblclick', (): void => {
        // The click that opened the double-click indicated the row;
        // activating moves on, so the indication goes too.
        this.row_indicate(null);
        this.row_activate(row, key, lead);
      });
    }
    return element;
  }

  /**
   * The cell of the declared control trait on a built row, marked as the
   * control it is; null when the level declares none.
   *
   * @param element - The row, its cells in trait order.
   * @returns The control cell, or null.
   */
  private controlCell_find(element: HTMLElement): HTMLElement | null {
    const controlKey: string | undefined = this.declaration.control;
    if (controlKey === undefined) return null;
    const index: number = this.declaration.traits.findIndex((trait: ListingTrait<T>): boolean => trait.key === controlKey);
    if (index < 0) throw new Error(`listing level declares control '${controlKey}', which names no trait`);
    const cell: Element | undefined = element.children[index];
    if (!(cell instanceof HTMLElement)) return null;
    cell.classList.add('listing-control');
    return cell;
  }

  /** Activates a row: folds it when it has children, and tells the pane. */
  private row_activate(row: T, key: string, lead: boolean): void {
    if (!lead && this.child !== null) {
      expansion_toggle(this.expansion, key);
      this.host.repaint();
      this.declaration.activate?.(row);
      return;
    }
    // The press is acknowledged before anything answers: the row lights
    // `activating`, the rest dims as for an indicated row, the capsule
    // works, and the bar reads OPENING <name> until the listing lands or a
    // refusal returns. A second press on the same row while it is in
    // flight is absorbed (the double-press of impatience is not two
    // navigations); a press on another row replaces the intent.
    if (this.host.activating_is(key)) return;
    this.host.activation_begin(key, this.rowsByKey.get(key) ?? null, rowName_derive(key));
    this.declaration.activate?.(row);
  }

  /**
   * Indicates one row: its verbs fill its own track — or the frame's row
   * zone, on a listing that routes them there — and the previously
   * indicated row's verbs go.
   *
   * @param key - The row's key, or null to indicate nothing.
   */
  public row_indicate(key: string | null, quiet: boolean = false): void {
    const framed: boolean = this.host.framed();
    this.indication_drop();
    if (key === null) {
      this.host.indication_release(this);
      return;
    }
    const row: T | undefined = this.dataByKey.get(key);
    const element: HTMLElement | undefined = this.rowsByKey.get(key);
    if (row === undefined || element === undefined) {
      this.host.indication_release(this);
      return;
    }
    this.indicated = key;
    element.classList.add('listing-indicated');
    const offered: ReadonlyArray<ListingAction<T>> = this.declaration.actions?.of(row) ?? [];
    // The claim goes in before the zone is drawn, so the level that held
    // the indication before has stood down by the time the verbs land.
    this.host.indication_claim({
      level: this,
      key,
      drop: (): void => this.indication_drop(),
      restore: (): boolean => {
        if (!this.rowsByKey.has(key)) return false;
        this.row_indicate(key, true);
        return true;
      },
    });
    if (framed) {
      this.host.zoneVerbs_set([...actionCell_build(row, offered).childNodes]);
    } else {
      const cell: HTMLElement | undefined = this.cellsByKey.get(key);
      if (cell !== undefined && offered.length > 0) {
        cell.replaceChildren(...actionCell_build(row, offered).childNodes);
      }
    }
    if (!quiet) this.declaration.indicated?.(row);
  }

  /**
   * Stands the indicated row down quietly: its light off, its cell
   * emptied, nothing told and the zone untouched — for a claim another
   * level is taking, or a row about to be indicated again.
   */
  private indication_drop(): void {
    if (this.indicated === null) return;
    this.cellsByKey.get(this.indicated)?.replaceChildren();
    this.rowsByKey.get(this.indicated)?.classList.remove('listing-indicated');
    this.indicated = null;
  }

  /** The key this level indicates, or null. */
  public indicated_get(): string | null {
    return this.indicated;
  }

  /**
   * Shows a readout beside an indicated row's verbs; dropped when the
   * operator has moved on.
   *
   * @param key - The row the readout belongs to.
   * @param text - What to say beside the verbs.
   */
  public readout_show(key: string, text: string | Node): void {
    if (this.indicated !== key) return;
    if (this.host.framed()) {
      this.host.zoneReadout_set(text);
      return;
    }
    const cell: HTMLElement | undefined = this.cellsByKey.get(key);
    if (cell === undefined) return;
    const readout: HTMLSpanElement = document.createElement('span');
    readout.className = 'listing-readout';
    readout.append(text);
    cell.querySelector('.listing-readout')?.remove();
    cell.appendChild(readout);
  }

  /** A row's element, when it is on stage. */
  public row_element(key: string): HTMLElement | null {
    return this.rowsByKey.get(key) ?? null;
  }

  /** The keys of the governed rows on stage. */
  public keysOnStage_list(): string[] {
    return [...this.rowsByKey.keys()].filter((key: string): boolean => !this.leadKeys.has(key));
  }
}

/**
 * A listing a pane declares into.
 *
 * Owns the frame, the field, the grid template, the action track, the
 * indication, the selection and the state line — everything the panes
 * used to compose for themselves. A pane's listing code is a declaration
 * plus `rows_set`.
 */
export class Listing<T> {
  private readonly declaration: ListingDeclaration<T>;
  private readonly level: Level<T>;
  private readonly host: ListingHost<T>;
  private readonly gridHost: HTMLElement;
  private readonly stateSpan: HTMLElement | null;
  /** The press in flight: its row's key and element, or null. */
  private activating: { key: string; element: HTMLElement | null } | null = null;
  private readonly filterBlock: HTMLElement | null;
  private readonly selectBlock: HTMLElement | null;
  /** The frame's row zone, when the verbs ride the frame. */
  private readonly zone: HTMLElement | null;
  /** The pane the zone's frame belongs to, whose `data-modes` opens it. */
  /**
   * The pane the row zone opens, resolved from the document each time it is
   * needed rather than kept from construction.
   *
   * A listing can be built before its mount is in the document — the node
   * overlay stamps its body, constructs the browser on it, and only then
   * appends the whole thing to the scene — and a pane looked up at that
   * moment is null forever after. The zone then filled with verbs that
   * nobody could see, because the attribute that opens the frame was never
   * written: one listing, two sources of truth about where it lives, and
   * the stale one won. The DOM is the truth; ask it.
   *
   * @returns The enclosing pane, or null when the listing is detached.
   */
  /** Whether the zone's pane watcher is installed; see `zone_wire`. */
  private wired: boolean = false;

  private zonePane_get(): HTMLElement | null {
    // A listing is usually in a pane, and the pane's own `data-modes` is
    // what opens its frame. Not every listing is: the cohort rides the
    // header band, which is not a pane at all — so the frame's host is
    // whatever declares itself one, and a pane is only the common case.
    // Without this the band's zone filled with verbs behind a frame that
    // nothing ever told to open: the row lit, and the verbs stayed dark.
    return this.zone?.closest<HTMLElement>('.workspace-pane, [data-frame-host]') ?? null;
  }
  /**
   * Whether verbs arriving in the zone are what opened the frame. Only then
   * does the zone emptying retract it: a frame the operator opened, or has
   * pressed something else on since, is theirs to close.
   */
  private zoneOpened: boolean = false;
  /**
   * The one indication across every level, kept across a repaint of the
   * same field (a fold, a sort, a re-listing) and dropped by navigation —
   * the same life a selection has, for the same reason: what the operator
   * pointed at is the field's until they point elsewhere or leave.
   */
  private claim: IndicationClaim | null = null;
  /** What was last given to `rows_set`, repainted on any order change. */
  private blocks: ReadonlyArray<ListingBlock<T>> = [];
  /** The field the rows belong to; a different one is navigation. */
  private field: string | null = null;
  private painter: ListingPainter<T> | null = null;
  private selecting: boolean = false;
  /** The selected rows, by key, kept across renders of the same field. */
  private readonly selection: Map<string, T> = new Map();
  private repaintQueued: boolean = false;

  /**
   * @param declaration - The listing's shape and chrome.
   */
  constructor(declaration: ListingDeclaration<T>) {
    this.declaration = declaration;
    this.gridHost = declaration.gridHost ?? declaration.mount;
    this.zone = declaration.rowZone ?? zone_mint(declaration.mount, declaration.chrome?.prefix);
    if (declaration.selection !== undefined && this.zone === null) {
      throw new Error('a listing that selects declares a row zone: a selection\'s verbs ride the frame');
    }
    this.level = new Level<T>(
      declaration,
      {
        repaint: (): void => this.repaint_queue(),
        framed: (): boolean => this.zone !== null,
        activating_is: (key: string): boolean => this.activating?.key === key,
        activation_begin: (key: string, element: HTMLElement | null, name: string): void => this.activation_begin(key, element, name),
        zoneVerbs_set: (capsules: ReadonlyArray<Node>): void => this.zoneVerbs_set(capsules),
        zoneReadout_set: (text: string | Node): void => this.zoneReadout_set(text),
        indication_claim: (claim: IndicationClaim): void => {
          if (this.claim !== null && this.claim.level !== claim.level) this.claim.drop();
          this.claim = claim;
        },
        indication_release: (level: object): void => {
          if (this.claim === null || this.claim.level !== level) return;
          this.claim = null;
          this.zoneVerbs_set([]);
        },
      },
      declaration.caps !== 'each',
      declaration.selection === undefined ? null : (key: string, row: T): boolean => this.selection_gather(key, row),
    );
    this.host = new ListingHost<T>(declaration.mount, this.level.order);
    // The grid is one declaration: track list, caps and cells all read it.
    this.gridHost.style.setProperty('--roster-cols', this.level.template);
    if (this.zone !== null) {
      this.zone.classList.add('listing-zone');
      this.zone.hidden = true;
      declaration.mount.classList.add('listing-framed');
      this.zone_wire();
    }

    const chrome: ListingChrome | undefined = declaration.chrome;
    this.stateSpan = chrome?.root.querySelector<HTMLElement>('.pane-state') ?? null;
    this.filterBlock = chrome?.root.querySelector<HTMLElement>(`.${chrome.prefix}-filter`) ?? null;
    this.selectBlock = chrome?.root.querySelector<HTMLElement>(`.${chrome.prefix}-select`) ?? null;
    this.filterBlock?.classList.add('rail-off');
    const heard: AddEventListenerOptions = { signal: this.released.signal };
    this.filterBlock?.addEventListener('click', (): void => this.filter_toggle(), heard);
    chrome?.root.querySelector<HTMLElement>(`.${chrome.prefix}-refresh`)
      ?.addEventListener('click', (): void => this.declaration.refresh?.(), heard);
    this.columns_wire(chrome);
    this.level.order.stripChange_observe((): void => this.filterBlock_sync());
    this.selectBlock?.addEventListener('click', (): void => this.select_toggle(), heard);
    // The language reaches ordering through a DOM event on the pane.
    chrome?.root.addEventListener('argus:roster', (event: Event): void => {
      const detail: RosterEventDetail = (event as CustomEvent<RosterEventDetail>).detail;
      if (detail.op === 'sort') this.level.sort_set(detail.key, detail.dir ?? 'asc');
      else if (detail.text === '') this.level.order.strip_toggle(false);
      else this.level.order.filter_set(detail.text);
    }, heard);
    this.filterBlock_sync();
  }

  /**
   * Puts rows on stage.
   *
   * The field names what the rows belong to: the listed path for a
   * browser, a constant for a roster, a query's id. The same field is the
   * same field, so the selection survives a filter and a re-listing; a
   * different field is navigation, so it clears.
   *
   * @param blocks - The rows, in blocks.
   * @param context - The field the rows belong to.
   */
  public rows_set(blocks: ReadonlyArray<ListingBlock<T>>, context: { field: string }): void {
    // Let go is let go: rows handed to a listing after that are not drawn, and nothing is taken again.
    if (this.released.signal.aborted) return;
    if (this.field !== null && context.field !== this.field) {
      this.selection.clear();
      // Navigation: what was pointed at is not here any more.
      this.claim?.drop();
      this.claim = null;
    }
    this.field = context.field;
    this.blocks = blocks;
    // The listing that answers a press settles it, wherever it landed.
    this.activation_settle();
    this.render();
    this.grips_ensure();
  }

  /**
   * Acknowledges a press before anything answers (aegis.adoc:
   * a-press-is-acknowledged): the row lights `activating`, the rest dims,
   * its capsule works, and the bar reads OPENING <name> until the listing
   * lands (`rows_set`) or the kernel refuses (`activation_refuse`). A
   * press on another row while one is in flight replaces the intent.
   *
   * @param key - The row's key.
   * @param element - The row's element, when it is on stage.
   * @param name - What the bar names.
   */
  private activation_begin(key: string, element: HTMLElement | null, name: string): void {
    this.activating?.element?.classList.remove('listing-activating');
    this.activating = { key, element };
    element?.classList.add('listing-activating');
    barState_set(this.stateSpan, 'wait', `OPENING ${name}`);
  }

  /** Stands the press down: the answer landed (rows here, or a pane's own answer — a graph). */
  public activation_settle(): void {
    if (this.activating === null) return;
    this.activating.element?.classList.remove('listing-activating');
    this.activating = null;
    barState_clear(this.stateSpan, 'wait');
  }

  /**
   * Stands the press down with the kernel's refusal on the bar: the row
   * returns to the listing it was pressed in, which stayed on stage.
   *
   * @param reason - The kernel's own words.
   */
  public activation_refuse(reason: string): void {
    if (this.activating === null) return;
    this.activation_settle();
    barState_set(this.stateSpan, 'refused', reason.toUpperCase());
  }

  /** The row a press is waiting on, or null. */
  public activating_get(): string | null {
    return this.activating?.key ?? null;
  }

  /** Coalesces order changes across every level into one repaint. */
  private repaint_queue(): void {
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    window.requestAnimationFrame((): void => {
      this.repaintQueued = false;
      this.render();
    });
  }

  /** Paints the blocks: frame seated, field opened, rows drawn, state written. */
  private render(): void {
    this.level.forget();
    const field: HTMLElement = this.host.field_open();
    const whole: boolean = this.level.filter_isEmpty();
    let shown: number = 0;
    let total: number = 0;
    const governed: number = this.blocks.reduce((sum: number, block: ListingBlock<T>): number => sum + block.rows.length, 0);
    if (this.blocks.length > 0 && governed === 0 && this.declaration.empty !== undefined) {
      field.appendChild(this.declaration.empty());
    }
    for (const block of this.blocks) {
      const section: HTMLElement = document.createElement('section');
      section.className = 'listing-block';
      section.dataset['key'] = block.key;
      if (block.header !== undefined) section.appendChild(block.header);
      if (this.declaration.caps === 'each') section.appendChild(this.level.order.caps_mint());
      total += block.rows.length;
      if (this.painter !== null) {
        const kept: T[] = this.level.rows_keep(block.rows, whole);
        shown += kept.length;
        this.painter({ ...block, rows: kept }, section);
      } else {
        const rows: HTMLElement = document.createElement('div');
        rows.className = 'listing-rows';
        shown += this.level.rows_draw(block.rows, block.lead ?? [], rows, whole);
        section.appendChild(rows);
      }
      field.appendChild(section);
    }
    if (!whole && governed > 0 && shown === 0 && this.declaration.filteredEmpty !== undefined) {
      field.appendChild(this.declaration.filteredEmpty(this.level.order.filterText_get()));
    }
    this.level.order.counts_set(shown, total);
    // The numbers are painted after the rows are placed, so a fold, a sort
    // or a re-listing renumbers what is actually on stage.
    listingPills_paint();
    // The rows were rebuilt; the indication is restored onto the new row
    // if it is still on stage, and stood down if the repaint dropped it.
    if (this.claim !== null && !this.claim.restore()) {
      this.claim = null;
      this.zoneVerbs_set([]);
    }
    this.selection_render();
    this.state_render();
    this.shed_fit();
  }

  /** Watches the pane's width, so columns give way and come back as it moves. */
  private shedObserver: ResizeObserver | null = null;
  /** Watches the pane's row zone closing; kept so it can be let go. */
  private modesObserver: MutationObserver | null = null;
  /** Aborted when the listing is let go: every listener it put up hears nothing more. */
  private readonly released: AbortController = new AbortController();

  /**
   * Lets go of everything the listing took: its listeners on the pane's
   * chrome and frame, its two observers, and a column drag in hand (whose
   * listeners are on the window). The panel that owns the listing calls it
   * when its pane closes.
   *
   * @example
   * listing.hold_release();
   */
  public hold_release(): void {
    this.released.abort();
    this.shedObserver?.disconnect();
    this.shedObserver = null;
    this.modesObserver?.disconnect();
    this.modesObserver = null;
  }
  /** The width the columns were last fitted to. */
  private shedWidth: number = -1;

  /**
   * Fits the columns to the pane: from every column, the ones with a rank
   * give way lowest first until the caps row no longer runs past the
   * field. A row never runs under the frame's rail, where it was clipped
   * without a word (the operator's black square, 2026-10-14); what stood
   * aside is said on the bar and the COLUMNS block.
   *
   * @param force - Fit again even at the same width.
   */
  private shed_fit(force: boolean = false): void {
    const order: string[] = this.level.shedOrder();
    if (order.length === 0) return;
    if (this.shedObserver === null && typeof ResizeObserver !== 'undefined' && !this.released.signal.aborted) {
      this.shedObserver = new ResizeObserver((): void => this.shed_fit());
      this.shedObserver.observe(this.gridHost);
    }
    const caps: HTMLElement | null = this.declaration.mount.querySelector<HTMLElement>('.roster-order .roster-caps')
      ?? this.declaration.mount.querySelector<HTMLElement>('.roster-caps');
    if (caps === null || caps.clientWidth === 0) return;
    const width: number = caps.clientWidth;
    if (!force && width === this.shedWidth) {
      // Same width: only the caps a repaint may have minted afresh are hidden again.
      for (const cap of caps.querySelectorAll<HTMLElement>('.roster-cap')) cap.hidden = this.level.shed.has(cap.dataset['key'] ?? '');
      return;
    }
    this.shedWidth = width;
    const before: string = [...this.level.shed].join(',');
    const apply = (keys: string[]): boolean => {
      this.level.shed_set(keys);
      this.gridHost.style.setProperty('--roster-cols', this.level.template);
      for (const cap of caps.querySelectorAll<HTMLElement>('.roster-cap')) cap.hidden = this.level.shed.has(cap.dataset['key'] ?? '');
      return caps.scrollWidth <= caps.clientWidth + 1;
    };
    let shed: string[] = [];
    let fits: boolean = apply(shed);
    for (const key of order) {
      if (fits) break;
      shed = [...shed, key];
      fits = apply(shed);
    }
    if (shed.join(',') !== before) {
      this.columnsBlock_paint();
      if (this.field !== null) this.render();
    }
  }

  /**
   * Indicates one row of the root level, or nothing.
   *
   * @param key - The row's key, or null.
   */
  public row_indicate(key: string | null): void {
    if (key === null) {
      // Whichever level holds it.
      this.claim?.drop();
      const claim: IndicationClaim | null = this.claim;
      this.claim = null;
      if (claim !== null) this.zoneVerbs_set([]);
      return;
    }
    this.level.row_indicate(key);
  }

  /** The indicated row's key at whichever level holds it, or null. */
  public indicated_get(): string | null {
    return this.claim?.key ?? null;
  }

  /**
   * Redraws the indicated row's verbs from their live predicates — a verb
   * whose result is on stage lights, one whose result left goes dark —
   * without re-rendering the listing or telling the pane again.
   */
  public indication_refresh(): void {
    if (this.claim === null) return;
    if (!this.claim.restore()) {
      this.claim = null;
      this.zoneVerbs_set([]);
    }
  }

  /**
   * Shows a readout beside an indicated row's verbs.
   *
   * @param key - The row the readout belongs to.
   * @param text - What to say.
   */
  public readout_show(key: string, text: string | Node): void {
    this.level.readout_show(key, text);
  }

  /**
   * A row's element while it is on stage, for a pane that marks rows
   * between renders (an arrival pulse).
   *
   * @param key - The row's key.
   * @returns The element, or null when the row is not on stage.
   */
  public row_element(key: string): HTMLElement | null {
    return this.level.row_element(key);
  }

  /**
   * The grid template a level's traits declare, for a form that stands on it.
   *
   * @param depth - Which level: 0 for the root, 1 for its child, and so on.
   * @returns The template.
   */
  public template_get(depth: number = 0): string {
    return this.level.template_select(depth);
  }

  /** The field on stage, or null before the first render — for a pane that seats a wait in it. */
  public field_get(): HTMLElement | null {
    return this.host.field_get();
  }

  /**
   * Holds open exactly these rows at a depth, and repaints when rows are
   * on stage. A level with one row opens itself this way; a cohort still
   * arrives folded.
   *
   * @param depth - Which level: 0 for the root, 1 for its child, and so on.
   * @param keys - The keys to hold open there.
   */
  public open_set(depth: number, keys: ReadonlyArray<string>): void {
    this.level.open_set(depth, keys);
    if (this.field !== null) this.render();
  }

  /** Closes every row at every level. Takes effect at the next render. */
  public open_clear(): void {
    this.level.open_clear();
  }

  /**
   * Draws blocks another way, or `null` to return to the grid. A painted
   * block has no grid, so its rows carry no track, no indication and no
   * select-click; the painter owns what a click means. Takes effect at the
   * next `rows_set`: the pane decides when the field is repainted, since
   * something else may be standing on it.
   *
   * @param paint - The painter, or null.
   */
  public painter_set(paint: ListingPainter<T> | null): void {
    this.painter = paint;
  }

  /**
   * Declares, or withdraws, the row verbs after construction: the track
   * is minted or dropped, the template rewritten, and the rows on stage
   * repainted to match.
   *
   * @param actions - The verbs and their track, or null for none.
   */
  public actions_declare(actions: ListingActions<T> | null): void {
    this.level.actions_set(actions);
    this.gridHost.style.setProperty('--roster-cols', this.level.template);
    if (this.field !== null) this.render();
  }

  /** The frame's COLUMNS block, when the pane has one: reads SIZED, resets all. */
  private columnsBlock: HTMLElement | null = null;
  /** Where sized columns are remembered, keyed by the chrome prefix. */
  private columnsPrefix: string | null = null;

  /**
   * Hand-sizeable columns: the grips on the root caps, the device's memory
   * of what was sized, and the COLUMNS block (columns.ts).
   */
  private columns_wire(chrome: ListingChrome | undefined): void {
    this.columnsPrefix = chrome?.prefix ?? null;
    this.columnsBlock = chrome?.root.querySelector<HTMLElement>(`.${chrome.prefix}-columns`) ?? null;
    this.columnsBlock?.addEventListener('click', (): void => this.columns_reset(), { signal: this.released.signal });
    // What this device remembers applies before any row lands.
    if (this.columnsPrefix !== null) {
      for (const [key, px] of columns_read(columnStore_default(), this.columnsPrefix, this.level.traitKeys())) {
        this.level.column_size(key, px);
      }
      this.gridHost.style.setProperty('--roster-cols', this.level.template);
    }
    this.columnsBlock_paint();
    this.grips_ensure();
  }

  /**
   * Wires the grips on the root caps. The caps row is seated when the first
   * rows land, so this runs at construction and again on every render;
   * a grip already wired is left alone.
   */
  private grips_ensure(): void {
    const caps: HTMLElement | null = this.declaration.mount.querySelector<HTMLElement>('.roster-order .roster-caps');
    if (caps === null) return;
    const store: ColumnStore | null = columnStore_default();
    grips_wire(caps, {
      signal: this.released.signal,
      key_read: (cap: HTMLElement): string | null => cap.dataset['key'] ?? null,
      expanse_is: (key: string): boolean => track_isExpanse(this.level.track_find(key) ?? ''),
      floor_measure: (key: string): number => length_px(floor_parse(this.level.track_find(key) ?? '3em'), caps),
      expanseSlack: (): number => {
        const expanse: { key: string; width: string } | null = this.level.expanse_find();
        const cap: HTMLElement | null = expanse === null ? null : caps.querySelector<HTMLElement>(`.roster-cap[data-key="${expanse.key}"]`);
        return cap === null || expanse === null ? 0 : Math.max(0, cap.getBoundingClientRect().width - length_px(floor_parse(expanse.width), caps));
      },
      size: (key: string, px: number): void => this.column_size(key, px, store),
      reset: (key: string): void => this.column_size(key, null, store),
    });
  }

  private column_size(key: string, px: number | null, store: ColumnStore | null): void {
    this.level.column_size(key, px);
    this.gridHost.style.setProperty('--roster-cols', this.level.template);
    if (this.columnsPrefix !== null) column_write(store, this.columnsPrefix, key, px);
    this.columnsBlock_paint();
  }

  /** Every column back to its declaration (the COLUMNS block). */
  public columns_reset(): void {
    const store: ColumnStore | null = columnStore_default();
    for (const key of [...this.level.sized.keys()]) this.column_size(key, null, store);
  }

  /** The trait keys sized by hand, for a readout or a test. */
  public columns_sized(): string[] {
    return [...this.level.sized.keys()];
  }

  private columnsBlock_paint(): void {
    if (this.columnsBlock === null) return;
    const sized: boolean = this.level.sized.size > 0;
    const shed: string[] = [...this.level.shed].map((key: string): string => this.level.label_find(key));
    this.columnsBlock.textContent = `COLUMNS${sized ? ' · SIZED' : ''}${shed.length > 0 ? ` · ${shed.length} HIDDEN` : ''}`;
    this.columnsBlock.classList.toggle('rail-off', !sized && shed.length === 0);
    this.columnsBlock.title = `${sized ? 'columns sized by hand; press to give them all back' : 'drag a cap\'s edge to size its column; a double-press gives one back'}${shed.length > 0 ? `. Hidden for want of room: ${shed.join(', ')} (a wider pane brings them back)` : ''}`;
  }

  /** Shows or hides the filter strip (the mode frame's FILTER, or the language). */
  public filter_toggle(open?: boolean): void {
    this.level.order.strip_toggle(open);
  }

  /**
   * Sets the filter text, as the strip's input would: a readout that acts
   * on this listing (the header's ERRORED figure) filters it by this path.
   * The text holds across the rows arriving, as the strip's does.
   *
   * @param text - The filter (`status:error`, or a plain term), or empty.
   */
  public filter_set(text: string): void {
    // The order owns the text: it syncs the strip's input, opens the strip
    // for a non-empty filter, and tells the level beneath.
    this.level.order.filter_set(text);
  }

  /**
   * The filter as it stands, empty when the field is showing everything.
   *
   * A pane's own field verb needs to know: acting on "what is shown" means
   * the filtered set while a filter is on, and the WHOLE answer when none
   * is — never the subset that happens to be unfolded, since folding is a
   * way of looking rather than a way of choosing.
   *
   * @returns The filter text.
   */
  public filterText_get(): string {
    return this.level.order.filterText_get();
  }

  /** The FILTER block reads the strip's state, like every mode block. */
  private filterBlock_sync(): void {
    if (this.filterBlock === null) return;
    const on: boolean = this.level.order.strip_isOpen();
    this.filterBlock.textContent = on ? 'FILTER ON' : 'FILTER OFF';
    this.filterBlock.classList.toggle('rail-off', !on);
  }

  /**
   * Turns SELECT on or off. Turning it off clears nothing: the selection
   * is the field's until the field changes.
   *
   * @param on - Whether to select; omitted flips the mode.
   */
  public select_toggle(on?: boolean): void {
    if (this.declaration.selection === undefined) return;
    this.selecting = on ?? !this.selecting;
    // Entering or leaving the mode is the operator's hand on the frame:
    // the indication standing down must not retract it.
    this.zoneOpened = false;
    if (this.claim !== null) this.row_indicate(null);
    this.declaration.mount.classList.toggle('listing-selecting', this.selecting);
    this.selectBlock?.classList.toggle('rail-off', !this.selecting);
    if (this.selectBlock !== null) this.selectBlock.textContent = this.selecting ? 'SELECT ON' : 'SELECT OFF';
    this.selection_render();
    this.state_render();
  }

  /** Whether SELECT is on. */
  public select_isOn(): boolean {
    return this.selecting;
  }

  /** The selected keys, in selection order. */
  public selection_get(): string[] {
    return [...this.selection.keys()];
  }

  /**
   * A row was clicked: while SELECT is on, toggles its membership of the
   * selection and answers true; otherwise answers false and the click
   * means what it would have meant.
   */
  private selection_gather(key: string, row: T): boolean {
    if (!this.selecting) return false;
    if (this.selection.has(key)) this.selection.delete(key);
    else this.selection.set(key, row);
    this.selection_render();
    this.state_render();
    return true;
  }

  /** Paints the selection: the marked rows, and the zone's verbs. */
  private selection_render(): void {
    for (const key of this.level.keysOnStage_list()) {
      this.level.row_element(key)?.classList.toggle('listing-selected', this.selection.has(key));
    }
    if (this.zone === null) return;
    if (!this.selecting) {
      // While SELECT is off the zone is the indicated row's alone; with
      // nothing indicated it is empty.
      if (this.claim === null) this.zoneVerbs_set([]);
      return;
    }
    const rows: Array<[string, T]> = [...this.selection.entries()];
    const offered: ReadonlyArray<ListingAction<void>> =
      rows.length > 0 ? this.declaration.selection?.verbs(rows) ?? [] : [];
    this.zoneVerbs_set(offered.length === 0 ? [] : [...actionCell_build<void>(undefined, offered).childNodes]);
  }

  /**
   * Binds the zone to its frame: a press on any other block of the frame
   * makes the frame the operator's, so the zone emptying no longer
   * retracts it; and the frame retracting — Esc, the strip, a touch on the
   * field — un-indicates the row, since a row's verbs that nobody can see
   * are not on offer.
   */
  private zone_wire(): void {
    const zone: HTMLElement | null = this.zone;
    const pane: HTMLElement | null = this.zonePane_get();
    // A detached listing has no pane to watch yet. It is wired on the first
    // paint that finds one instead, so a listing built before it is in the
    // document still stands its row down when the frame closes.
    if (zone === null || pane === null || this.wired) return;
    this.wired = true;
    // Capture phase: the block's own handler may empty the zone (SELECT
    // stands the indication down), and the claim has to be in before it.
    zone.closest<HTMLElement>('.mode-frame')?.addEventListener('click', (event: Event): void => {
      if (event.target instanceof Node && zone.contains(event.target)) return;
      this.zoneOpened = false;
    }, { capture: true, signal: this.released.signal });
    const observer: MutationObserver = new MutationObserver((): void => {
      if (pane.dataset['modes'] === 'open') return;
      this.zoneOpened = false;
      if (this.claim !== null) this.row_indicate(null);
    });
    observer.observe(pane, { attributes: true, attributeFilter: ['data-modes'] });
    this.modesObserver = observer;
  }

  /**
   * Draws verbs in the row zone, or empties it.
   *
   * Verbs arriving open the frame; the last of them leaving retracts it
   * when their arrival is what opened it.
   *
   * @param capsules - The verbs, built by `actionCell_build`; none empties.
   */
  private zoneVerbs_set(capsules: ReadonlyArray<Node>): void {
    const zone: HTMLElement | null = this.zone;
    if (zone === null) return;
    zone.replaceChildren(...capsules);
    zone.hidden = capsules.length === 0;
    // The listing may have joined the document since it was built.
    if (!this.wired) this.zone_wire();
    const pane: HTMLElement | null = this.zonePane_get();
    if (pane === null) return;
    if (capsules.length > 0) {
      if (pane.dataset['modes'] !== 'open') {
        pane.dataset['modes'] = 'open';
        this.zoneOpened = true;
      }
      return;
    }
    if (this.zoneOpened) {
      this.zoneOpened = false;
      delete pane.dataset['modes'];
    }
  }

  /**
   * Says something beneath the zone's verbs; replaces what was said before.
   *
   * @param text - The readout.
   */
  private zoneReadout_set(text: string | Node): void {
    const zone: HTMLElement | null = this.zone;
    if (zone === null) return;
    zone.querySelector('.listing-readout')?.remove();
    const readout: HTMLSpanElement = document.createElement('span');
    readout.className = 'listing-readout';
    readout.append(text);
    zone.appendChild(readout);
    zone.hidden = false;
  }

  /** How many selected rows are on stage under the current filter. */
  private selectionShown_count(): number {
    let shown: number = 0;
    for (const key of this.selection.keys()) {
      if (this.level.row_element(key) !== null) shown += 1;
    }
    return shown;
  }

  /** Rewrites the state line from the façade's parts, through the composer. */
  public state_refresh(): void {
    this.state_render();
  }

  private state_render(): void {
    if (this.stateSpan === null) return;
    const parts: ListingStateParts = {
      filter: this.level.order.summary(),
      selecting: this.selecting,
      selected: this.selection.size,
      shown: this.selectionShown_count(),
      shed: this.level.shed.size,
    };
    const text: string | null =
      this.declaration.state !== undefined ? this.declaration.state(parts) : listingState_compose(parts);
    if (text === null) return;
    this.stateSpan.textContent = text;
  }
}

/**
 * Mints the row zone into the mode frame that frames the mount's field,
 * placed above the frame's fill so it stands beneath the field's own
 * blocks; null when the field has no frame.
 *
 * The frame is the one beside the mount, in the same field element — a
 * pane may carry two framed fields (a scene and a roster), and only the
 * roster's frame is the roster's.
 *
 * @param mount - The listing region.
 * @param prefix - The pane's block prefix, for a `<prefix>-row-zone` class
 *   a scenario can find the zone by.
 * @returns The zone, or null.
 */
function zone_mint(mount: HTMLElement, prefix: string | undefined): HTMLElement | null {
  const frame: HTMLElement | null = mount.parentElement?.querySelector<HTMLElement>(':scope > .mode-frame') ?? null;
  if (frame === null) return null;
  const zone: HTMLSpanElement = document.createElement('span');
  zone.className = prefix === undefined ? 'listing-zone' : `listing-zone ${prefix}-row-zone`;
  zone.hidden = true;
  const fill: HTMLElement | null = frame.querySelector<HTMLElement>(':scope > .mode-fill');
  if (fill !== null) frame.insertBefore(zone, fill);
  else frame.appendChild(zone);
  return zone;
}

/**
 * The default state line: SELECT while selecting, the filter's summary,
 * and how many are selected — with how many of those are on stage when a
 * filter hides some, since a verb acts on the whole selection.
 *
 * @param parts - The façade's parts.
 * @returns The line, empty when there is nothing to say.
 */
/**
 * What the bar names while a press waits: the last segment of the row's
 * key (a path, mostly) — `OPENING feed_4587`.
 *
 * @param key - The row's key.
 * @returns The name.
 */
export function rowName_derive(key: string): string {
  return key.split('/').filter((part: string): boolean => part !== '').pop() ?? key;
}

export function listingState_compose(parts: ListingStateParts): string {
  const words: string[] = [];
  if (parts.selecting) words.push('SELECT');
  if (parts.filter !== '') words.push(parts.filter);
  if ((parts.shed ?? 0) > 0) words.push(`${parts.shed} COLUMN${parts.shed === 1 ? '' : 'S'} HIDDEN`);
  if (parts.selected > 0) {
    words.push(
      parts.shown === parts.selected
        ? `${parts.selected} SELECTED`
        : `${parts.selected} SELECTED · ${parts.shown} SHOWN`,
    );
  }
  return words.join(' · ');
}
