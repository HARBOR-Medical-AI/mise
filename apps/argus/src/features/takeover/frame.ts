/**
 * @file The frame a screen takes over in: ARGUS's own, drawn once for every
 * program that takes the screen (trek's bridge, the TD controller).
 *
 * A takeover hides the page, so it must bring the frame with it, and it
 * brings the page's: the gutter at the page's width with a brand block and a
 * seat at its head, the banner and a face beside them closed by the band, the
 * gap, then the views as seats on the gutter with LEAVE closing the column,
 * and beside them the body's band flush with the first seat, its fillet
 * under it, and the page's main holding the body and the log as panes. The measurements are argus.css's (each
 * takeover-* class is listed beside the page's own) and the seats are the
 * page's panel-N classes, so the two cannot drift apart (aegis.adoc:
 * a-takeover-keeps-the-frame). What a screen draws inside the frame is its
 * own.
 *
 * @module
 */

/** One view on the gutter. */
export interface TakeoverView {
  /** The key the screen knows the view by. */
  key: string;
  /** The seat's label. */
  label: string;
  /** The view destroys (TEARDOWN): the seat wears red. */
  destroy?: boolean;
}

/** What a screen asks the frame for. */
export interface TakeoverSpec {
  /** The root's id (`td-controller`, `trek-bridge`). */
  id: string;
  /** The root's own class, for the screen's stylesheet. */
  className: string;
  /** The brand block: the name, the words under it, and whether the TD mark stands over them. */
  brand: { name: string; sub: string; mark: boolean };
  /** The banner's words, in the page's banner seat. */
  banner: string;
  /** The views, top down. */
  views: ReadonlyArray<TakeoverView>;
  /** The seat that closes the gutter. */
  leave: { label: string; destroy?: boolean };
  /** The strip over the body. */
  stage: { title: string; note: string };
  /** The strip over the log. */
  log: { title: string; note: string };
  /** `aria-label`s for the gutter's views and the log. */
  labels: { views: string; log: string };
}

/** The frame, with the places a screen fills. */
export interface TakeoverFrame {
  root: HTMLElement;
  /** The seat under the brand block: a domain's pills, a game's seed. */
  seat: HTMLElement;
  /** The head's face, beside the banner. */
  face: HTMLElement;
  /** The view seats by key. */
  views: Map<string, HTMLButtonElement>;
  leave: HTMLButtonElement;
  /** The strip over the body: its title and its note. */
  stageTitle: HTMLElement;
  stageNote: HTMLElement;
  /** Where the body goes. */
  body: HTMLElement;
  /** Between the body and the band: the engine's question. */
  aside: HTMLElement;
  logTitle: HTMLElement;
  logNote: HTMLElement;
  /** Where the log goes. */
  log: HTMLElement;
  /** Lights one view's seat; the elbow follows the first seat's colour. */
  view_mark: (key: string) => void;
  /** Replaces the views, for a screen whose views come from data (a script's lines); LEAVE stays. */
  views_set: (views: ReadonlyArray<TakeoverView>) => void;
  /** Whether the gutter is off stage (a press on the view already shown sent it away). */
  gutterAway_is: () => boolean;
  /** Brings the gutter back when it is away; true when it was. */
  gutter_restore: () => boolean;
  /** Whether the head is off stage (a press on the brand block rolled it away). */
  headerAway_is: () => boolean;
  /** Brings the head back when it is away; true when it was. */
  header_restore: () => boolean;
}

/** The page's seats, in the gutter's order; a screen with more views takes the next hue. */
const SEATS: ReadonlyArray<string> = ['panel-3', 'panel-4', 'panel-5', 'panel-6'];

/**
 * Makes an element with a class and optional text.
 *
 * @param tag - The tag.
 * @param className - The class attribute, whole.
 * @param text - Text content, when any.
 * @returns The element.
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A band of the frame: the page's five blocks, the head's (bar-1 to bar-5)
 * or the body's (bar-6 to bar-10).
 *
 * @param first - The first block's number.
 * @param className - The band's own class, beside `bar-panel`.
 * @returns The band.
 */
function band_make(first: number, className: string): HTMLElement {
  const band: HTMLElement = el('div', className === '' ? 'bar-panel' : `bar-panel ${className}`);
  for (let n: number = first; n < first + 5; n++) band.append(el('div', `bar-${n}`));
  return band;
}

/**
 * A titled strip, as every pane's (the files bar's spacing): the title at the
 * left, a note at the right, the rounded end.
 *
 * @param title - The title.
 * @param note - The note.
 * @returns The strip and its two texts.
 */
function strip_make(title: string, note: string): { strip: HTMLElement; title: HTMLElement; note: HTMLElement } {
  const strip: HTMLElement = el('div', 'lcars-terminal-header-bar files-header-bar');
  const bar: HTMLElement = el('div', 'lcars-bar-horizontal');
  const titleNode: HTMLElement = el('span', 'lcars-title', title);
  const noteNode: HTMLElement = el('span', 'lcars-terminal-status', note);
  bar.append(titleNode, noteNode);
  strip.append(bar, el('div', 'lcars-bar-end bar-punctuation'));
  return { strip, title: titleNode, note: noteNode };
}

/**
 * Builds the frame.
 *
 * @param spec - What the screen asks for.
 * @param onView - Called with a view's key when its seat is pressed.
 * @param onLeave - Called when LEAVE is pressed.
 * @returns The frame.
 */
export function takeoverFrame_build(spec: TakeoverSpec, onView: (key: string) => void, onLeave: () => void): TakeoverFrame {
  const root: HTMLElement = el('section', `takeover ${spec.className}`);
  root.id = spec.id;

  // The head row: the brand block and the seat on the gutter, the banner, the
  // face and the band beside them.
  const gutterHead: HTMLElement = el('div', 'takeover-gutter-head');
  const brand: HTMLButtonElement = el('button', 'panel-1 takeover-brand');
  brand.type = 'button';
  brand.setAttribute('aria-label', spec.brand.name);
  brand.title = 'press to roll the head away; the strip at the top, or Esc, brings it back';
  // As the page's first panel: a press on the brand block rolls the head off the top, the stage flowing up to fill
  // it. The page's panel selects a face first and departs on the second press; the takeover's head has one face.
  const headerAway_set = (away: boolean): void => {
    if (away) root.dataset['header'] = 'away';
    else delete root.dataset['header'];
  };
  brand.addEventListener('click', (): void => headerAway_set(!(root.dataset['header'] === 'away')));
  if (spec.brand.mark) {
    const mark: HTMLElement = el('span', 'brand-mark brand-mark-td');
    mark.setAttribute('aria-hidden', 'true');
    brand.append(mark);
  }
  const words: HTMLElement = el('span', 'takeover-brand-words');
  words.append(el('span', 'takeover-brand-name', spec.brand.name), el('span', 'takeover-brand-sub', spec.brand.sub));
  brand.append(words);
  const seat: HTMLElement = el('div', 'panel-2 takeover-seat');
  gutterHead.append(brand, seat);
  const head: HTMLElement = el('div', 'takeover-head');
  const face: HTMLElement = el('div', 'takeover-face');
  head.append(el('div', 'banner', spec.banner), face, band_make(1, 'first-bar-panel'));
  const top: HTMLElement = el('div', 'takeover-top');
  top.append(gutterHead, head);

  // The body row: the views on the gutter, LEAVE closing it, the stage beside.
  const gutter: HTMLElement = el('nav', 'takeover-gutter');
  gutter.setAttribute('aria-label', spec.labels.views);
  // The gutter's restore strip: the page's #gutter-restore, on this frame; the only pointer target left once the
  // gutter has carried its seats away.
  const restore: HTMLElement = el('div', 'takeover-gutter-restore');
  restore.setAttribute('role', 'button');
  restore.setAttribute('tabindex', '0');
  restore.title = 'restore gutter';
  const gutterAway_set = (away: boolean): void => {
    if (away) root.dataset['gutter'] = 'away';
    else delete root.dataset['gutter'];
  };
  restore.addEventListener('click', (): void => gutterAway_set(false));
  // The head's restore strip: the page's #header-restore, on this frame, along the top edge.
  const headRestore: HTMLElement = el('div', 'takeover-header-restore');
  headRestore.setAttribute('role', 'button');
  headRestore.setAttribute('tabindex', '0');
  headRestore.title = 'restore the head';
  headRestore.addEventListener('click', (): void => headerAway_set(false));
  const seats: HTMLElement = el('div', '');
  const views: Map<string, HTMLButtonElement> = new Map();
  let shown: ReadonlyArray<TakeoverView> = spec.views;
  const seats_fill = (): void => {
    seats.replaceChildren();
    views.clear();
    shown.forEach((view: TakeoverView, index: number): void => {
      const seatClass: string = SEATS[index] ?? 'panel-view';
      const button: HTMLButtonElement = el('button', `${seatClass}${view.destroy === true ? ' takeover-view-destroy' : ''}`, view.label);
      button.type = 'button';
      button.dataset['view'] = view.key;
      // As the page's gutter: a press on the view ALREADY shown sends the gutter off stage left, handing its width to
      // the stage; a press that would navigate stays deterministic. The restore strip, or Esc, brings it back.
      button.addEventListener('click', (): void => {
        if (button.getAttribute('aria-current') === 'page') {
          gutterAway_set(true);
          return;
        }
        gutterAway_set(false);
        onView(view.key);
      });
      views.set(view.key, button);
      seats.append(button);
    });
    seats.append(el('div', 'panel-spacer'));
  };
  seats_fill();
  const leaveSeat: HTMLElement = el('div', '');
  const leave: HTMLButtonElement = el('button', `panel-7${spec.leave.destroy === true ? ' takeover-view-destroy' : ''}`, spec.leave.label);
  leave.type = 'button';
  leave.addEventListener('click', onLeave);
  leaveSeat.append(leave);
  gutter.append(seats, leaveSeat);

  // The body's elbow is the page's with the console closed: the band at the
  // head of the column, flush beside the gutter's first seat, its inner
  // fillet under the band's left end, and the page's own <main> below it
  // (its padding is what keeps the fillet clear), holding the screen's
  // fields as panes, each under its strip.
  const main: HTMLElement = el('div', 'takeover-main');
  const stage: HTMLElement = el('main', 'takeover-stage');
  const over: { strip: HTMLElement; title: HTMLElement; note: HTMLElement } = strip_make(spec.stage.title, spec.stage.note);
  const body: HTMLElement = el('div', 'takeover-body');
  const aside: HTMLElement = el('div', 'takeover-aside');
  const logStrip: { strip: HTMLElement; title: HTMLElement; note: HTMLElement } = strip_make(spec.log.title, spec.log.note);
  const log: HTMLElement = el('section', 'takeover-log');
  log.setAttribute('aria-label', spec.labels.log);
  stage.append(over.strip, body, aside, logStrip.strip, log);
  main.append(band_make(6, ''), stage);
  const wrap: HTMLElement = el('div', 'takeover-wrap');
  wrap.append(gutter, main);
  root.append(top, wrap, restore, headRestore);

  // The chosen view's seat is lit, as LANG is when it is live. The first seat
  // carries the body's elbow, so the band's first block and the fillet take
  // its colour, lit or not: an elbow is one piece with the seat it joins.
  const view_mark = (key: string): void => {
    for (const [name, button] of views) {
      const on: boolean = name === key;
      button.classList.toggle('takeover-view-on', on);
      button.setAttribute('aria-current', on ? 'page' : 'false');
    }
    root.dataset['firstLit'] = key === shown[0]?.key ? 'true' : 'false';
  };

  const views_set = (next: ReadonlyArray<TakeoverView>): void => {
    shown = next;
    seats_fill();
  };

  const gutterAway_is = (): boolean => root.dataset['gutter'] === 'away';
  const gutter_restore = (): boolean => {
    if (!gutterAway_is()) return false;
    gutterAway_set(false);
    return true;
  };
  const headerAway_is = (): boolean => root.dataset['header'] === 'away';
  const header_restore = (): boolean => {
    if (!headerAway_is()) return false;
    headerAway_set(false);
    return true;
  };

  return { root, seat, face, views, leave, stageTitle: over.title, stageNote: over.note, body, aside, logTitle: logStrip.title, logNote: logStrip.note, log, view_mark, views_set, gutterAway_is, gutter_restore, headerAway_is, header_restore };
}
