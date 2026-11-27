/**
 * @file A pane's chrome: the drawer behind its handle (the binding radio,
 * the SPLIT and MOVE pills with their four direction capsules, every chord
 * named in its capsule's title, CLOSE), and the children a kind adds — a
 * browser's CWD binding and its frame verbs (HOME, BACK, MKDIR, REFRESH,
 * UPLOAD), a graph's ENTER NODE, PROCESS NODE, ENTER FEED, BACK, CLEAR
 * DETAIL and REFRESH.
 *
 * A module of the host: the host hands in the pane verbs, the browser, the
 * pill spawn, the opens and the home as hooks; the module wires one pane's
 * mount.
 */
import { path_quote } from '@fnndsc/menu';
import { DRAWER_CHORDS, type DrawerChord } from '../console/argusLang.js';
import type { FilesPanel } from '../features/files/panel.js';
import type { Browser } from './browser.js';
import { nodeOf_path } from './browser.js';
import type { CatalogueBinding } from './desktop.js';
import type { HostContext } from './hostContext.js';
import type { PaneVerbs } from './paneVerbs.js';
import { side_deriveFromPlace, splitSelector_format, type Side } from './sides.js';
import type { RegardValue } from './subjects.js';

/** What the chrome asks of the host. */
export interface PaneChromeHooks {
  verbs: Pick<PaneVerbs, 'move' | 'chordKeys_format'>;
  browser: Pick<Browser, 'follows' | 'follow_set' | 'cwdBind_sync_register' | 'cwdBind_sync' | 'rooted_walk' | 'rooted_back' | 'directory_make' | 'listing_refresh' | 'files_deliver'>;
  /** The drawer SPLIT pill's spawn: a pane of a binding split from a parent. */
  pillPane_spawn: (parentId: string, binding: 'view' | 'fs' | 'empty', dir: 'row' | 'col', before: boolean) => string | null;
  process_open: (fromId: string, binding: CatalogueBinding) => void;
  /** BACK inside a node: the overlay's previous listing. */
  overlay_back: (paneId: string) => void;
  /** Home: the files domain, the DAG dismissed. */
  home_apply: () => void;
  orphans_dispose: () => void;
  /** The primary DAG's close is its dismissal from home. */
  dag_dismiss: () => void;
}

/**
 * Wires the chrome to a host.
 *
 * @param context - The layout, the panels, the subjects, the console and the sound.
 * @param hooks - The verbs, the browser, the spawn, the opens and the home.
 * @returns A function wiring one pane's mount: its id, its kind, its element.
 */
export function paneChrome_wire(context: Pick<HostContext, 'layout' | 'panels' | 'subjects' | 'terminal' | 'sound'>, hooks: PaneChromeHooks): (id: string, kind: string, mount: HTMLElement) => void {
  const { layout, panels, subjects } = context;

  /** The drawer every kind has: handle, binding radio, SPLIT and MOVE, chord titles, CLOSE. */
  const drawer_wire = (id: string, drawer: HTMLElement, handle: HTMLElement): void => {
    handle.addEventListener('click', (event: Event): void => {
      // Working controls riding the header (the strategy pill) keep their
      // own meaning; only the frame itself is the drawer's handle.
      if (event.target instanceof Element && event.target.closest('button') !== null) return;
      drawer.hidden = !drawer.hidden;
      // An open drawer is keyboard-live either way it opened: first verb
      // takes focus so arrows/Tab/Enter/Esc work without a prefix press.
      if (!drawer.hidden) drawer.querySelector<HTMLButtonElement>('button')?.focus();
      context.sound('audio3');
    });
    const zoomCapsule: HTMLElement | null = drawer.querySelector<HTMLElement>('.drawer-zoom');
    if (zoomCapsule !== null) zoomCapsule.dataset['pane'] = id;
    // A double click on the frame zooms or restores the pane, as a title
    // bar does on every desktop; its two clicks have opened and closed the
    // drawer, which ends as it was. ZOOM in the drawer stays the visible way.
    handle.addEventListener('dblclick', (event: Event): void => {
      if (event.target instanceof Element && event.target.closest('button') !== null) return;
      window.getSelection()?.removeAllRanges();
      zoomCapsule?.click();
    });
    // The binding radio: what the next split creates. UNLINKED is the
    // unmarked case; the selection is per-pane drawer state.
    for (const bind of drawer.querySelectorAll<HTMLElement>('.drawer-bind')) {
      bind.addEventListener('click', (): void => {
        for (const peer of drawer.querySelectorAll('.drawer-bind')) peer.classList.remove('drawer-bind-selected');
        bind.classList.add('drawer-bind-selected');
        context.sound('audio3');
      });
    }
    // The four direction capsules act under the lit pill: SPLIT opens a new
    // pane on that side (the one verb that creates a pane; the selected
    // binding says what it IS), MOVE walks this pane there for one press.
    const splitters: HTMLButtonElement[] = [...drawer.querySelectorAll<HTMLButtonElement>('[data-split]')];
    const sideOf = (splitter: HTMLElement): Side => side_deriveFromPlace(splitter.dataset['split'], splitter.dataset['place']) ?? 'right';
    const mode_set = (mode: 'split' | 'move'): void => {
      drawer.dataset['mode'] = mode;
      for (const pill of drawer.querySelectorAll<HTMLElement>('.drawer-mode')) {
        pill.classList.toggle('drawer-mode-selected', pill.dataset['mode'] === mode);
      }
      for (const splitter of splitters) {
        const side: Side = sideOf(splitter);
        // A side this pane cannot go dims before the press.
        splitter.disabled = mode === 'move' && !layout.move_possible(id, side);
        const selector: string = splitSelector_format(side);
        splitter.title = mode === 'move'
          ? `this pane moves ${side}${hooks.verbs.chordKeys_format(selector, true)}`
          : `new pane opens ${side}${hooks.verbs.chordKeys_format(selector, false)}`;
      }
    };
    for (const pill of drawer.querySelectorAll<HTMLElement>('.drawer-mode')) {
      pill.addEventListener('click', (): void => {
        const wanted: 'split' | 'move' = pill.dataset['mode'] === 'move' ? 'move' : 'split';
        // MOVE pressed while armed disarms; SPLIT is the rest state.
        mode_set(wanted === 'move' && drawer.dataset['mode'] === 'move' ? 'split' : wanted);
        context.sound('audio3');
      });
    }
    for (const splitter of splitters) {
      splitter.addEventListener('click', (): void => {
        if (drawer.dataset['mode'] === 'move') {
          hooks.verbs.move(id, sideOf(splitter));
          mode_set('split');
          drawer.hidden = true;
          return;
        }
        const dir: 'row' | 'col' = splitter.dataset['split'] === 'row' ? 'row' : 'col';
        const before: boolean = splitter.dataset['place'] === 'before';
        const binding: string = drawer.querySelector<HTMLElement>('.drawer-bind-selected')?.dataset['bind'] ?? 'unlinked';
        // A pill-born pane is a linked filesystem (follows the parent's regard
        // at the directory level), a slaved viewer, or a blank pane.
        const canonical: 'view' | 'fs' | 'empty' = binding === 'viewer' ? 'view' : binding === 'fs' ? 'fs' : 'empty';
        if (hooks.pillPane_spawn(id, canonical, dir, before) === null) return;
        drawer.hidden = true;
        context.sound('audio3');
      });
    }
    // Every capsule a chord presses names its keys in its title.
    for (const selector of new Set(DRAWER_CHORDS.filter((chord: DrawerChord): boolean => chord.selector !== null && chord.move !== true).map((chord: DrawerChord): string => chord.selector ?? ''))) {
      const capsule: HTMLElement | null = drawer.querySelector<HTMLElement>(selector);
      if (capsule !== null && !capsule.title.includes('[keys ')) capsule.title = `${capsule.title}${hooks.verbs.chordKeys_format(selector, false)}`;
    }
    drawer.querySelector<HTMLElement>('.drawer-close')?.addEventListener('click', (): void => {
      if (id === 'dag') {
        // The primary DAG's close is its dismissal from home.
        hooks.dag_dismiss();
        hooks.home_apply();
        return;
      }
      // The root leaf: closing the last pane means home.
      if (!layout.leaf_close(id)) hooks.home_apply();
      hooks.orphans_dispose();
      context.sound('audio3');
    });
  };

  /**
   * A browser's chrome: the CWD binding beside LINKED FS (a browser either
   * follows the session or holds its place), and the frame verbs that act
   * on where the FIELD points — HOME and BACK, MKDIR, REFRESH and UPLOAD.
   */
  const files_wire = (id: string, drawer: HTMLElement, mount: HTMLElement): void => {
    const { browser } = hooks;
    const binding: HTMLElement | null = drawer.querySelector<HTMLElement>('.drawer-binding');
    if (binding !== null) {
      const label: HTMLElement = document.createElement('span');
      label.className = 'drawer-label drawer-label-cwd';
      label.textContent = 'CWD';
      binding.appendChild(label);
      const cwdBind_offer = (text: string, follow: boolean, hint: string): void => {
        const capsule: HTMLButtonElement = document.createElement('button');
        capsule.className = 'pacs-capsule drawer-cwdbind';
        capsule.dataset['follow'] = follow ? 'on' : 'off';
        capsule.textContent = text;
        capsule.title = hint;
        capsule.addEventListener('click', (): void => {
          if (browser.follows(id) !== follow) browser.follow_set(id, follow);
          context.sound('audio3');
        });
        binding.appendChild(capsule);
      };
      cwdBind_offer('FOLLOW CWD', true, "bind this browser to the session cwd (the console's browser)");
      cwdBind_offer('ROOT HERE', false, 'unbind from the cwd: this browser keeps its own place');
      // The pair reads the pane's state wherever the state was changed —
      // the drawer, the language, or a split being born rooted.
      browser.cwdBind_sync_register(id, (): void => {
        const following: boolean = browser.follows(id);
        for (const capsule of binding.querySelectorAll<HTMLElement>('.drawer-cwdbind')) {
          capsule.classList.toggle('drawer-bind-selected', (capsule.dataset['follow'] === 'on') === following);
        }
      });
      browser.cwdBind_sync(id);
    }
    // A following browser's back and home are the session's own; a rooted
    // one walks its own history.
    const panel_get = (): FilesPanel | undefined => panels.get('files', id);
    mount.querySelector<HTMLElement>('.files-home')?.addEventListener('click', (): void => {
      if (browser.follows(id)) { context.terminal.line_run('cd ~'); return; }
      const panel: FilesPanel | undefined = panel_get();
      if (panel !== undefined) browser.rooted_walk(id, panel, '~');
    });
    mount.querySelector<HTMLElement>('.files-back')?.addEventListener('click', (): void => {
      if (browser.follows(id)) { context.terminal.line_run('cd -'); return; }
      const panel: FilesPanel | undefined = panel_get();
      if (panel !== undefined) browser.rooted_back(id, panel);
    });
    // MKDIR, REFRESH and UPLOAD act on the PLACE the field holds, which is
    // the browser's own path and not necessarily the session's cwd.
    const here = (): string | null => panel_get()?.path_current() ?? null;
    mount.querySelector<HTMLElement>('.files-mkdir')?.addEventListener('click', (): void => {
      const place: string | null = here();
      if (place !== null) browser.directory_make(id, place);
    });
    mount.querySelector<HTMLElement>('.files-refresh')?.addEventListener('click', (): void => {
      const place: string | null = here();
      if (place !== null) browser.listing_refresh(id, place);
    });
    const chooser: HTMLInputElement | null = mount.querySelector<HTMLInputElement>('.files-upload-input');
    mount.querySelector<HTMLElement>('.files-upload')?.addEventListener('click', (): void => {
      // The operator's own machine is the browser's, and only the browser
      // may open a file there — so the picker is the surface's, and the
      // bytes travel to the daemon, which writes them through the kernel.
      if (here() !== null) chooser?.click();
    });
    chooser?.addEventListener('change', (): void => {
      const place: string | null = here();
      const chosen: FileList | null = chooser.files;
      if (place === null || chosen === null || chosen.length === 0) return;
      void browser.files_deliver(id, place, Array.from(chosen));
      chooser.value = '';
    });
  };

  /** A graph's children: ENTER NODE, PROCESS NODE, ENTER FEED, BACK, CLEAR DETAIL, REFRESH. */
  const dag_wire = (id: string, child_offer: (label: string, hint: string, act: () => void) => void): void => {
    /** The place a regard points at: a file's directory, a directory itself. */
    const place_derive = (regard: RegardValue): string => (regard.modelKind === 'fs.file' ? regard.address.replace(/\/[^/]*$/, '') || '/' : regard.address);
    // ENTER always lands in a place; nothing regarded means the feed on stage.
    child_offer('ENTER NODE', 'move the session into the indicated node (its data directory)', (): void => {
      const regard: RegardValue | null = subjects.regard_get(id);
      const feedId: number | null = panels.get('dag', id)?.feed_get() ?? null;
      const place: string | null = regard === null ? (feedId === null ? null : `/proc/jobs/feed_${feedId}`) : place_derive(regard);
      if (place !== null) context.terminal.line_run(`cd ${path_quote(place)}`);
    });
    child_offer('PROCESS NODE', 'run an executable on the indicated node\'s output (a catalogue opens beside)', (): void => {
      const regard: RegardValue | null = subjects.regard_get(id);
      const feedId: number | null = panels.get('dag', id)?.feed_get() ?? null;
      if (regard === null || feedId === null) return;
      const place: string = place_derive(regard);
      const node: number | null = nodeOf_path(place) ?? (/_(\d+)\/?$/.exec(place) === null ? null : parseInt(/_(\d+)\/?$/.exec(place)?.[1] ?? '', 10));
      if (node === null) return;
      hooks.process_open(id, { input: place.replace(/\/data\/?$/, '') + '/data', feed: feedId, node });
    });
    child_offer('ENTER FEED', 'move the session into the feed on stage (or the one picked in the roster)', (): void => {
      const feedId: number | null = panels.get('dag', id)?.feed_get() ?? null;
      if (feedId !== null) context.terminal.line_run(`cd "/proc/jobs/feed_${feedId}"`);
    });
    child_offer('BACK', 'return to the previous listing inside the node', (): void => hooks.overlay_back(id));
    child_offer('CLEAR DETAIL', 'dismiss the node facts (a click on empty space does too)', (): void => { panels.get('dag', id)?.detail_clear(); });
    child_offer('REFRESH', 'revisit the feed now (a watch keeps sampling it while it runs)', (): void => { panels.get('dag', id)?.refresh(); });
  };

  return (id: string, kind: string, mount: HTMLElement): void => {
    const drawer: HTMLElement | null = mount.querySelector<HTMLElement>('.pane-drawer');
    const handle: HTMLElement | null = mount.querySelector<HTMLElement>('.pane-handle');
    if (drawer === null || handle === null) return;
    drawer_wire(id, drawer, handle);
    // Semantic children: parent-contextualized intents, per pane kind.
    const children: HTMLElement | null = drawer.querySelector<HTMLElement>('.drawer-children');
    if (children === null) return;
    const child_offer = (label: string, hint: string, act: () => void): void => {
      const capsule: HTMLButtonElement = document.createElement('button');
      capsule.className = 'pacs-capsule drawer-child';
      capsule.textContent = label;
      capsule.title = hint;
      capsule.addEventListener('click', (): void => {
        act();
        drawer.hidden = true;
        context.sound('audio3');
      });
      children.appendChild(capsule);
    };
    if (kind === 'files' || kind === 'catalogue') files_wire(id, drawer, mount);
    if (kind === 'dag') dag_wire(id, child_offer);
  };
}
