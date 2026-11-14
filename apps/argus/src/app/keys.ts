/**
 * @file The keys the stage answers: Esc as a contextual back that retreats
 * exactly one level a press, and the prefix chords (aegis.adoc:
 * a-drawer-verb-has-a-chord) — with a drawer open, one key presses one of
 * its capsules, the arrows focus the pane in that direction, and Ctrl-B is
 * the prefix everywhere.
 *
 * A module of the host: every level Esc can retreat from is a named step in
 * one ladder, and the host hands in the transients it owns (the command
 * line, the errand, the dives, the chrome) as hooks.
 */
import { DRAWER_CHORDS, focus_move, type ArgusHost, type DrawerChord } from '../console/argusLang.js';
import { paneAsk_abandon } from '../features/ask/paneAsk.js';
import type { DagPanel } from '../features/dag/panel.js';
import type { FilesPanel } from '../features/files/panel.js';
import type { ImagePanel } from '../features/image/panel.js';
import type { HostContext } from './hostContext.js';
import type { PaneVerbs } from './paneVerbs.js';
import { SIDES, side_findByArrow, type Side } from './sides.js';

/** What the keys ask of the host. */
export interface KeyHooks {
  /** The command line: the topmost transient. */
  palette_isOpen: () => boolean;
  palette_open: () => void;
  palette_close: () => void;
  /** An errand standing on the stage, abandoned. */
  errand_abandon: () => boolean;
  /** Inside a /bin node: the first Esc flies back out to the graph. */
  dive_leave: () => boolean;
  /** A node overlay up: its two levels. */
  overlay_escape: () => boolean;
  /** Every open drawer hidden; true when one was. */
  drawers_close: () => boolean;
  /** Every open mode frame retracted; true when one was. */
  modeFrames_close: () => boolean;
  /** Whether the console, not the stage, has the operator's hands. */
  consoleFocused: () => boolean;
  /** The console gives the keys back to the stage: its line lets go, the prefix answers for panes again. */
  console_release: () => void;
  /** The pane verbs the chords press. */
  verbs: Pick<PaneVerbs, 'bar_note' | 'flip' | 'resize'>;
  /** The host the language's focus move reads. */
  host: () => ArgusHost;
  /** Break out: this pane alone on stage, the arrangement it leaves carded first. */
  stage_alone: (paneId: string) => void;
  element_require: (id: string) => HTMLElement;
}

/** What a step of the Esc ladder decided. */
type Retreat = 'claimed' | 'yielded' | 'passed';

/** The buttons of a pane's mode frame the keys can reach: shown and enabled, top to bottom. */
export function frameButtons_list(pane: HTMLElement): HTMLButtonElement[] {
  return [...pane.querySelectorAll<HTMLButtonElement>('.mode-frame button')]
    .filter((button: HTMLButtonElement): boolean => !button.disabled && !button.hidden && button.offsetParent !== null);
}

/** The rows a pane's listing shows, top to bottom. */
export function listingRows_list(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>('.listing-row')].filter((row: HTMLElement): boolean => row.offsetParent !== null);
}

/**
 * Where the row cursor goes on a key: down and up a row, Home and End to
 * the ends; from nowhere, down starts at the top and up at the bottom.
 *
 * @param at - The cursor's row, or -1 for none.
 * @param count - How many rows there are.
 * @param key - The key.
 * @returns The new row, or null for a key that does not move the cursor.
 */
export function rowCursor_next(at: number, count: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown': return at < 0 ? 0 : Math.min(count - 1, at + 1);
    case 'ArrowUp': return at < 0 ? count - 1 : Math.max(0, at - 1);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/**
 * Wires the keys to a host: one capturing keydown listener on the window.
 *
 * @param context - The layout, the panels, the pane mounts, the console and the sound.
 * @param hooks - The transients the host owns.
 * @returns A function removing the listener.
 */
export function keys_wire(context: Pick<HostContext, 'layout' | 'panels' | 'paneInstance_get' | 'terminal' | 'sound'>, hooks: KeyHooks): () => void {
  const { layout, panels, paneInstance_get } = context;

  /**
   * Esc, one level a press: the topmost transient first (the command line,
   * then any question — the console's, a pane's, an errand's — since
   * retreating past a question would leave a command waiting on an answer
   * nobody is being asked for), then a wait on the focused image frame
   * (stopped where it stands), then the chrome (an image field holding the
   * keyboard, SELECT mode, drawers and frames), then the zoom (yielded to
   * its own listener), then one navigation pop (a /bin dive, a node overlay,
   * a camera held inside a node, a content view back to its listing, the
   * graph back to the feed list). Never a walk back up invisible depth.
   */
  const escape_steps: ReadonlyArray<() => Retreat> = [
    (): Retreat => { if (!hooks.palette_isOpen()) return 'passed'; hooks.palette_close(); return 'claimed'; },
    (): Retreat => (context.terminal.ask_abandon() ? 'claimed' : 'passed'),
    (): Retreat => (paneAsk_abandon() ? 'claimed' : 'passed'),
    (): Retreat => (hooks.errand_abandon() ? 'claimed' : 'passed'),
    // A pane's own line (the PACS form's MRN, a filter) gives the keys back
    // to the stage, so the arrows can walk the listing it filled.
    (): Retreat => {
      const active: Element | null = document.activeElement;
      if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return 'passed';
      if (active.closest('.workspace-pane') === null || active.closest('#terminal') !== null) return 'passed';
      active.blur();
      return 'claimed';
    },
    // A wait on the focused image frame (OPENING, LOADING) is stopped where
    // it stands, before anything gives ground.
    (): Retreat => {
      const focusedId: string | null = layout.focused_get();
      const waiting: [string, ImagePanel] | undefined = panels.entries('image')
        .find(([id, panel]: [string, ImagePanel]): boolean => id === focusedId || panel.field_hasFocus());
      return waiting?.[1].wait_stop() === true ? 'claimed' : 'passed';
    },
    // An image field holding the keyboard gives it back first (focus-stays-in-the-field).
    (): Retreat => (panels.values('image').some((panel): boolean => panel.field_release()) ? 'claimed' : 'passed'),
    // So does an editor's field: Esc takes the keyboard back, the text stands.
    (): Retreat => (panels.values('edit').some((panel): boolean => panel.field_release()) ? 'claimed' : 'passed'),
    // And a GAMES field: the game keeps running, the keys go back to the stage.
    (): Retreat => (panels.values('games').some((panel): boolean => panel.field_release()) ? 'claimed' : 'passed'),
    // SELECT is transient chrome of its own; an open question owns Esc, so
    // a press that also left a mode would answer two things at once.
    (): Retreat => {
      if (context.terminal.ask_isOpen()) return 'passed';
      let left: boolean = false;
      for (const panel of panels.values('files')) {
        if (panel.select_isOn()) { panel.select_toggle(false); left = true; }
      }
      return left ? 'claimed' : 'passed';
    },
    (): Retreat => {
      const drawers: boolean = hooks.drawers_close();
      const frames: boolean = hooks.modeFrames_close();
      return drawers || frames ? 'claimed' : 'passed';
    },
    // The zoom listener (bubble phase) takes this press.
    (): Retreat => (document.body.dataset['zoom'] !== undefined ? 'yielded' : 'passed'),
    (): Retreat => (hooks.dive_leave() ? 'claimed' : 'passed'),
    (): Retreat => (hooks.overlay_escape() ? 'claimed' : 'passed'),
    // A camera parked inside a node with no overlay over it: Esc is the way out, whatever left it there.
    (): Retreat => {
      const held: [string, DagPanel] | undefined = panels.entries('dag').find(([, panel]: [string, DagPanel]): boolean => panel.inside_isHeld());
      if (held === undefined) return 'passed';
      held[1].flight_back((): void => undefined);
      return 'claimed';
    },
    // A files pane's content view is a level: the focused pane answers first (focus citizenship).
    (): Retreat => {
      const focusedId: string | null = layout.focused_get();
      const content: [string, FilesPanel] | undefined = panels.entries('files')
        .filter(([, panel]: [string, FilesPanel]): boolean => panel.content_isShown())
        .sort(([a]: [string, FilesPanel], [b]: [string, FilesPanel]): number => (a === focusedId ? -1 : b === focusedId ? 1 : 0))[0];
      if (content === undefined) return 'passed';
      content[1].listing_restore();
      return 'claimed';
    },
    (): Retreat => (panels.values('dag').some((panel): boolean => panel.nav_pop()) ? 'claimed' : 'passed'),
  ];

  const escape_handle = (event: KeyboardEvent): void => {
    // The dashboard alone on the screen: Esc's one answer is the full
    // surface (the zoom's own listener), not a retreat in a pane unseen.
    if (document.body.dataset['zoom'] === 'launcher') return;
    for (const step of escape_steps) {
      const outcome: Retreat = step();
      if (outcome === 'yielded') return;
      if (outcome === 'claimed') {
        event.stopImmediatePropagation();
        // The command line's close is silent; every other retreat sounds.
        if (step !== escape_steps[0]) context.sound('audio3');
        return;
      }
    }
  };

  /**
   * A chord with a drawer open: tmux's letters where tmux has one, vim's for
   * a direction, a capital to MOVE; the arrows focus; Tab still walks the
   * verbs. A key typed into a line is never a chord.
   *
   * @returns Whether the press was a chord.
   */
  const chord_handle = (event: KeyboardEvent, drawer: HTMLElement): boolean => {
    const claim = (): void => { event.preventDefault(); event.stopImmediatePropagation(); };
    const arrowSide: Side | null = side_findByArrow(event.key);
    if (event.ctrlKey && !event.metaKey && !event.altKey && arrowSide !== null) {
      // Ctrl-arrow: the boundary beside this pane moves a step; the drawer stays.
      const focused: string | null = layout.focused_get();
      if (focused !== null) hooks.verbs.resize(focused, arrowSide, 0.05);
      claim();
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const close_and = (act: () => void): boolean => { hooks.drawers_close(); act(); claim(); return true; };
    // A focus move is the keys going to a pane: the console lets go of them.
    if (arrowSide !== null) return close_and((): void => { console_letGo(); if (focus_move(hooks.host(), SIDES[arrowSide].focusWord) !== null) context.sound('audio3'); });
    switch (event.key) {
      case 'o': case 'O': {
        const shown: string[] = layout.panes_shown();
        const at: number = shown.indexOf(layout.focused_get() ?? '');
        const next: string | undefined = shown[(at + (event.key === 'o' ? 1 : shown.length - 1)) % shown.length];
        return close_and((): void => { console_letGo(); if (next !== undefined) { layout.focus_set(next); context.sound('audio3'); } });
      }
      case '?': return close_and((): void => context.terminal.line_run('argus keys'));
      case ';': return close_and((): void => { console_letGo(); if (layout.focus_last() !== null) context.sound('audio3'); });
      case 'q':
        // Every pane names itself on its bar for a moment, so a target (@id) can be read off the stage.
        return close_and((): void => { for (const shown of layout.panes_shown()) hooks.verbs.bar_note(shown, `@${shown}`); });
      case ' ': {
        const focused: string | null = layout.focused_get();
        return close_and((): void => { if (focused !== null) hooks.verbs.flip(focused); });
      }
      case '!': {
        const focused: string | null = layout.focused_get();
        return close_and((): void => {
          if (focused !== null && layout.panes_shown().length > 1) {
            hooks.stage_alone(focused);
            hooks.verbs.bar_note(focused, 'ALONE ON STAGE');
            context.sound('audio3');
          }
        });
      }
      case 'w': return close_and((): void => hooks.element_require('gutter-panes').click());
      case 'r': return close_and((): void => { console_letGo(); const pane: HTMLElement | null = focusedPane_get(); if (pane !== null) frame_enter(pane); });
      case '&': return close_and((): void => context.terminal.line_run('pane close all'));
      case '[':
        // The scrollback takes the keys: PageUp/PageDown page it, Esc gives them back.
        return close_and((): void => {
          const scrollback: HTMLElement | null = document.querySelector<HTMLElement>('.argus-output');
          if (scrollback !== null) { scrollback.tabIndex = -1; scrollback.focus(); }
        });
      default: break;
    }
    const chord: DrawerChord | undefined = DRAWER_CHORDS.find((one: DrawerChord): boolean => one.key === event.key && one.selector !== null);
    if (chord === undefined || chord.selector === null) return false;
    // A capital arms MOVE first; a side the pane cannot go is dimmed and the
    // press lands on nothing, so MOVE is stood down again.
    if (chord.move === true) drawer.querySelector<HTMLButtonElement>('.drawer-mode[data-mode="move"]')?.click();
    const control: HTMLButtonElement | null = drawer.querySelector<HTMLButtonElement>(chord.selector);
    if (control === null || control.disabled) {
      if (chord.move === true) drawer.querySelector<HTMLButtonElement>('.drawer-mode[data-mode="split"]')?.click();
    } else {
      control.click();
    }
    claim();
    return true;
  };

  /** The focused pane's element (a zoomed one when the stage is zoomed), or null. */
  /** The keys leave the console for the stage: its line lets go, and the prefix answers for panes. */
  const console_letGo = (): void => {
    const active: Element | null = document.activeElement;
    if (active instanceof HTMLElement && active.closest('#drawer') !== null) active.blur();
    hooks.console_release();
  };

  const focusedPane_get = (): HTMLElement | null => {
    const zoomed: string | undefined = document.body.dataset['zoom'];
    if (zoomed === 'console' || zoomed === 'launcher') return null;
    const id: string | null = zoomed !== undefined ? zoomed : layout.focused_get();
    if (id === null) return null;
    const mount: HTMLElement | null = paneInstance_get(id)?.mount ?? null;
    return mount?.closest<HTMLElement>('.workspace-pane') ?? mount;
  };

  /**
   * The keys into a pane's mode frame (a-frame-is-reachable-by-keys): the
   * frame opens as its strip's press opens it, and the first verb takes the
   * focus; Tab or the arrows walk the rest, Enter presses, ← or Esc leaves.
   *
   * @param pane - The pane.
   * @returns Whether the frame had a verb to take the keys.
   */
  const frame_enter = (pane: HTMLElement): boolean => {
    if (pane.classList.contains('workspace-pane')) pane.dataset['modes'] = 'open';
    // A frame that stood as a strip unfolds over a moment and redraws its
    // verbs as it opens, which drops a focus given too early: its first verb
    // takes the focus once it shows, and takes it again for a short while
    // whenever the redraw left the keys with the page (never from a verb the
    // operator has moved to).
    let frames: number = 0;
    const focus_first = (): void => {
      frames += 1;
      const active: Element | null = document.activeElement;
      const held: boolean = active instanceof HTMLButtonElement && active.closest('.mode-frame') !== null && pane.contains(active);
      if (!held && (active === null || active === document.body)) frameButtons_list(pane)[0]?.focus();
      if (frames < 30) window.requestAnimationFrame(focus_first);
    };
    focus_first();
    context.sound('audio3');
    return true;
  };

  /**
   * The keys a pane answers with no prefix: inside its frame the arrows walk
   * the verbs and ← leaves; over its listing the arrows move a row cursor,
   * Enter indicates the row (its verbs ride the frame) and Enter again goes,
   * and → takes the keys into the frame. A key aimed at anything that takes
   * keys of its own (a line, a button, a field) is left to it.
   *
   * @returns Whether the press was the pane's.
   */
  const pane_handle = (event: KeyboardEvent): boolean => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    const pane: HTMLElement | null = focusedPane_get();
    if (pane === null) return false;
    const claim = (): boolean => { event.preventDefault(); event.stopImmediatePropagation(); return true; };
    const active: Element | null = document.activeElement;
    // Inside the frame: the arrows walk its verbs, ← gives the keys back.
    if (active instanceof HTMLButtonElement && active.closest('.mode-frame') !== null && pane.contains(active)) {
      const buttons: HTMLButtonElement[] = frameButtons_list(pane);
      const at: number = buttons.indexOf(active);
      if (event.key === 'ArrowLeft') { active.blur(); return claim(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const next: HTMLButtonElement | undefined = buttons[event.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1)];
        next?.focus();
        return claim();
      }
      return false;
    }
    // Over the listing only when nothing else holds the keys.
    if (active !== null && active !== document.body && !active.classList.contains('listing-row')) return false;
    const rows: HTMLElement[] = listingRows_list(pane);
    if (rows.length === 0) return false;
    const cursorAt: number = rows.findIndex((row: HTMLElement): boolean => row.classList.contains('listing-cursor'));
    const at: number = cursorAt >= 0 ? cursorAt : rows.findIndex((row: HTMLElement): boolean => row.classList.contains('listing-indicated'));
    if (event.key === 'ArrowRight') return frame_enter(pane) && claim();
    if (event.key === 'Enter') {
      const row: HTMLElement | undefined = rows[at];
      if (row === undefined) return false;
      // A click says "this one", a double-click "go": Enter on a row already
      // indicated goes, as the second press of the mouse does — through the
      // row's control cell where it declares one (a study folding open its
      // series), since that cell is the row's only way to go.
      if (row.classList.contains('listing-indicated')) {
        const control: HTMLElement | null = row.querySelector<HTMLElement>('.listing-control');
        if (control !== null) control.click();
        else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      } else {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return claim();
    }
    const next: number | null = rowCursor_next(at, rows.length, event.key);
    if (next === null) return false;
    for (const row of rows) row.classList.remove('listing-cursor');
    const row: HTMLElement | undefined = rows[next];
    row?.classList.add('listing-cursor');
    row?.scrollIntoView({ block: 'nearest' });
    return claim();
  };

  /** The prefix: Ctrl-B opens the focused pane's drawer (or the console's); pressed again, or ':', the command line. */
  const prefix_handle = (event: KeyboardEvent): void => {
    const open: boolean = document.querySelector('.pane-drawer:not([hidden])') !== null;
    if (event.key === ':' && open) {
      hooks.drawers_close();
      hooks.palette_open();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!(event.key === 'b' && event.ctrlKey && !event.altKey && !event.metaKey)) return;
    // The prefix belongs to argus EVERYWHERE: the terminal implements no
    // readline Ctrl-B, so an exclusion only donated the key to the browser's
    // bookmarks. Claim it unconditionally.
    event.preventDefault();
    if (open) {
      hooks.drawers_close();
      hooks.palette_open();
      return;
    }
    // A zoomed tree pane is the only one on stage: the prefix must reach its
    // drawer, whatever the layout focus was before the zoom.
    const zoomed: string | undefined = document.body.dataset['zoom'];
    const consoleHasIt: boolean = zoomed === 'console' || (zoomed === undefined && hooks.consoleFocused());
    const focused: string = zoomed !== undefined && zoomed !== 'console' ? zoomed : (layout.focused_get() ?? 'files');
    const drawer: HTMLElement | null = consoleHasIt
      ? hooks.element_require('console-drawer')
      : (paneInstance_get(focused)?.mount?.querySelector<HTMLElement>('.pane-drawer') ?? null);
    if (drawer === null) return;
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) drawer.querySelector<HTMLButtonElement>('button')?.focus();
    context.sound('audio3');
  };

  const handle = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      escape_handle(event);
      return;
    }
    const openDrawer: HTMLElement | null = document.querySelector<HTMLElement>('.pane-drawer:not([hidden])');
    // An editor's field is contenteditable: a key typed there is text, never a chord.
    const typing: boolean = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      || (event.target instanceof HTMLElement && event.target.isContentEditable);
    if (openDrawer !== null && !typing && chord_handle(event, openDrawer)) return;
    if (openDrawer === null && !typing && !hooks.palette_isOpen() && pane_handle(event)) return;
    prefix_handle(event);
  };
  window.addEventListener('keydown', handle, { capture: true });
  return (): void => window.removeEventListener('keydown', handle, { capture: true });
}
