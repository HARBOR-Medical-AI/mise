/**
 * @file ARGUS composition: attach, then wire the console and instruments.
 *
 * One page, one session, two projections: the indwelling terminal renders
 * the session's ANSI stream, and the Files instrument renders its envelope
 * models. This module owns the wiring only — the attach handshake, the
 * drawer mechanics, and the lowering of graphical gestures to session
 * commands — with each instrument behind its own module.
 *
 * The attach token arrives as a `?token=` query parameter (printed by
 * `chell --daemon`), is pasted into the attach form, or — behind a door
 * (`?door`, the porter) — is held by the door and never shown to the page.
 * The WebSocket URL and the byte route are derived from where the page was
 * served (see `calypso/routes.ts`): the daemon's root, or a door's
 * `/s/<identity>/` prefix; a `?ws=` parameter overrides the wire for the
 * dev server case.
 *
 * @module
 */
import { more_wire } from '../features/roster/more.js';
import { type SessionNotes, feedListModelSchema, FEED_LIST_MODEL_KIND, feedDagModelSchema, dicomSeriesModelSchema, dicomTagsModelSchema, imageViewModelSchema, DICOM_MODEL_KINDS, IMAGE_MODEL_KINDS, type DicomSeriesModel, type DicomTagsModel, DAG_MODEL_KINDS, type PromptContext, type WireEnvelope, type WatchState, type FeedDagModel, type LaneTelemetry, type CubeTelemetry, type JobsStateTelemetry } from '@fnndsc/menu';
import { type SceneNode } from '../scene/chrisSpace.js';
import { element_require, template_stamp, pane_find } from '../frame/dom.js';
import { DormantRegistry, DORMANT_CAP, localKeyStore, type GroupSnapshot, type DesktopAction, type DesktopShape } from './dormant.js';
import { linkLanding_parse, type LinkLanding } from './link.js';
import { shareSheet_open, viewLink_parse, viewScript_compose } from './shareView.js';
import { PanesPanel } from '../features/panes/panel.js';
import { logo_linesRender } from '@fnndsc/menu/logo';
import { tdMark_linesRender } from '@fnndsc/menu/logo/td';
import { backend_ask, wireUrl_resolve, vfsUrl_build as routeVfsUrl_build, downloadUrl_build as routeDownloadUrl_build, door_isPresent, doorUrl_build } from '../calypso/routes.js';
import {
  ArgusClient,
  type AttachInfo,
  type ExecuteOutcome,
  type OutputChannel,
  type ProgressMessage,
  type SurfaceAsk,
  type SurfaceEdit,
  attachBackend_get,
} from '../calypso/client.js';
import { ArgusTerminal } from '../console/terminal.js';
import { consolePalette_publish } from '../console/ansi.js';
import { ArgusProgress } from '../console/progress.js';
import { listingNumbering_set } from '../features/roster/listing.js';
import { type DownloadOutcome } from '../features/files/download.js';
import { FilesPanel, type FsListing, type FsListingEntry, extension_isImage } from '../features/files/panel.js';
import { GatherPanel, type GatherSeries, type GatherFeed } from '../features/gather/panel.js';
import { LauncherPanel, type LauncherTile, type LauncherRow } from '../features/launcher/panel.js';
import { dashboardTiles_build } from './dashboardTiles.js';
import { runLine_compose, runLine_executable, runLine_hasTitle, runLine_titleAppend } from '../features/files/runLine.js';
import { DagPanel } from '../features/dag/panel.js';
import { UniversePanel } from '../features/universe/panel.js';
import { paneAsk_open, type PaneAskRequest } from '../features/ask/paneAsk.js';
import { PacsPanel } from '../features/pacs/panel.js';
import { EmptyPanel } from '../features/empty/panel.js';
import { ModelRouter, type PaneClaim } from '../frame/modelRouter.js';
import { chrisRoutes_install } from '../compositions/chris/routes.js';
import { chrisPanes_make, type ChrisPanes } from '../compositions/chris/panes.js';
import { chrisDicom_make, type ChrisDicom } from '../compositions/chris/dicom.js';
import { chrisStage_make, type ChrisStage } from '../compositions/chris/stage.js';
import { chrisTiles_make } from '../compositions/chris/tiles.js';
import { stratusTiles_make } from '../compositions/stratus/tiles.js';
import { clusterClaims_set, stratusLanguage, type StratusLangHost } from '../compositions/stratus/lang.js';
import { chrisSignals_make, type ChrisSignals } from '../compositions/chris/signals.js';
import { ViewerPanel } from '../features/view/panel.js';
import { ImagePanel, type SeriesChoice } from '../features/image/panel.js';
import { TagsPanel } from '../features/tags/panel.js';
import { DICOM_FILE_PATTERN, SERIES_FOLDER_PATTERN, VOLUME_FILE_PATTERN } from '../features/image/engine.js';
import { SubjectBus, type RegardValue } from './subjects.js';
import { StatusBar } from './status.js';
import { LaneInstrument } from './laneInstrument.js';
import { Cascade } from './cascade.js';
import { PipelineCycler, cyclerNames_seed } from './cycler.js';
import { argusLine_run, claims_list, language_extend, viewScript_run, DRAWER_CHORDS, VERB_LINES, type ArgusHost, type DrawerChord, trekLine_isGame } from '../console/argusLang.js';
import { chrisLanguage, type ChrisLangHost } from '../compositions/chris/lang.js';

/** Console zoom, exposed for the language (the bar carries no control). */
let consoleZoom_set: (pane: string | null) => void = () => undefined;
export function consoleZoom_toggle(): void {
  consoleZoom_set(document.body.dataset['zoom'] === 'console' ? null : 'console');
}
import {
  paneFactory_register,
  paneInstance_adopt,
  paneInstance_create,
  paneInstance_dispose,
  paneInstance_get,
  PanelRoster,
  paneInstances_list,
  type PaneInstance,
  pane_isPrimary,
  primary_register,
  type PaneKind,
} from './panes.js';
import { LayoutManager, type LayoutNode } from './layout.js';
import type { HostContext } from './hostContext.js';
import { paneVerbs_wire } from './paneVerbs.js';
import { desktop_wire, type CatalogueBinding, type Desktop, type ReplayPlace } from './desktop.js';
import { binView_wire, type BinView } from './binView.js';
import { nodeOverlay_wire, type FileText, type NodeOverlay } from './nodeOverlay.js';
import { cohort_wire, type CohortModule } from './cohort.js';
import { editor_wire, type EditorModule } from './editor.js';
import { feedRowHandlers_make, feedVerbs_wire, type FeedVerbs } from './feedRows.js';
import { helpPane_wire, type HelpPaneHooks, type HelpPaneModule } from './helpPane.js';
import { gamesPane_wire, type GamesPaneModule } from './gamesPane.js';
import { trekBridge_wire, type TrekBridgeModule } from './trekBridge.js';
import { tdController_wire, type TdControllerModule } from './tdController.js';
import { synthVoice } from '../lcars/synth.js';
import { notesPane_wire, type NotesPaneModule } from './notesPane.js';
import { capacityPane_wire, type CapacityPaneModule } from './capacityPane.js';
import { asks_wire, type Asks } from './asks.js';
import { keys_wire } from './keys.js';
import { paneChrome_wire } from './paneChrome.js';
import { argusHost_build } from './consoleHost.js';
import { browser_wire, feedOf_path, imagery_is, TABLE_FILE_PATTERN, type Browser } from './browser.js';
import { place_derive, type Side } from './sides.js';
import { stalePage_watch } from './stalePage.js';
import { buildMatch_wire, type BuildWatch } from './buildMatch.js';
import { doorPill_wire } from './door.js';
import { restart_wire, type RestartControl, type SurfaceSeen } from './restart.js';
import type { ClosingCause } from '@fnndsc/menu';
import { greeting_ask } from './greeting.js';
// TheLCARS.com's stylesheet is NOT imported. ARGUS's frame is its own, written
// from `tests/smoke/canon/lcars.json` — the computed style of this surface's own
// rendered page — and proven against it at zero differences across 275 elements.
// The theme directory still supplies the FONT the frame names, when an operator
// has put their own LCARS-26.zip where the build can find it; where they have
// not, the type falls back and the frame is unchanged.
import '../lcars/argus.css';
import '../lcars/takeover.css';
import '../features/trek/trek.css';
import '../features/controller/controller.css';
import { consoleMode_wire, type ConsoleModeControl } from './consoleMode.js';
import { consoleStop_wire } from './consoleStop.js';
import type { TerminalScreen } from '../console/terminalScreen.js';

/**
 * What the console shows above the first prompt: the ChRIS brain at rest,
 * the same art a TTY boot and the porter's greeter draw, with the
 * session's own greeting beside it from the kernel's `motd` — who you
 * are, what you hold, what is running, a fortune. Nothing written here
 * about projections: the brain says ChRIS, the pane's title says ARGUS.
 */
const SPLASH_BRAIN: string[] = logo_linesRender(true);

/** The stratus composition's splash: the Trusted Domain mark in the driver's ring. */
const SPLASH_TD: string[] = tdMark_linesRender(true);

/** The stratus composition's tab mark: the same TD mark (docs/stratus.adoc, D11). */
const TD_FAVICON: string = new URL('../assets/brand/td-oci.svg', import.meta.url).href;

/** The frame's own tab mark: a rounded LCARS block in the frame's blue, no backend's logo. */
const FRAME_FAVICON: string = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#000"/><rect x="6" y="14" width="52" height="36" rx="18" fill="#20bdef"/><rect x="34" y="14" width="24" height="36" fill="#20bdef"/></svg>')}`;

/**
 * Points the tab's mark somewhere else (the page's own is ChRIS's).
 *
 * @param href - The mark's URL.
 */
function favicon_set(href: string): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')) link.href = href;
}

/** What this surface calls itself in the greeting. */
const SURFACE_NAME: string = 'ARGUS';

/** The localStorage key remembering the operator's audio choice. */
const AUDIO_STORAGE_KEY: string = 'argus-audio';

/** The recorded beeps' volume; a deployment's files are mastered hot. */
const AUDIO_VOLUME: number = 0.4;

/** Whether the panel beeps are muted; the audio pill owns this. */
let audioMuted: boolean = false;

/** The frame's four beeps: the audio element, the file the porter may override, and the synthesized cue otherwise. */
const FRAME_SOUNDS: Readonly<Record<string, { file: string; cue: string }>> = {
  audio1: { file: 'press', cue: 'press' },
  audio2: { file: 'arrive', cue: 'ack' },
  audio3: { file: 'retreat', cue: 'close' },
  audio4: { file: 'refuse', cue: 'deny' },
};

/** The sounds the deployment keeps as recordings (the porter's `sounds/index.json`), by bare name; empty when it keeps none. */
const recordedSounds: Set<string> = new Set<string>();

/**
 * Asks the porter which sounds it serves as recordings; without a porter, or a sounds folder, the answer is none.
 */
function recordedSounds_learn(): void {
  void fetch('sounds/index.json')
    .then((response: Response): Promise<unknown> => (response.ok ? response.json() : Promise.resolve(null)))
    .then((listed: unknown): void => {
      const files: unknown = typeof listed === 'object' && listed !== null ? (listed as { files?: unknown }).files : undefined;
      if (!Array.isArray(files)) return;
      for (const file of files) if (typeof file === 'string') recordedSounds.add(file.replace(/\.[a-z0-9]+$/, ''));
    })
    .catch((): void => undefined);
}

/**
 * Plays one of the page's LCARS beeps: the deployment's recording when it keeps one, else the page's own voice, synthesized.
 * The audio pill can mute the whole voice.
 *
 * @param audioId - The id of the audio element to play.
 */
function sound_play(audioId: string): void {
  if (audioMuted) {
    return;
  }
  const sound: { file: string; cue: string } | undefined = FRAME_SOUNDS[audioId];
  if (sound !== undefined && !recordedSounds.has(sound.file)) {
    synthVoice.cue_play(sound.cue);
    return;
  }
  const audio: HTMLElement | null = document.getElementById(audioId);
  if (audio instanceof HTMLAudioElement) {
    audio.currentTime = 0;
    audio.volume = AUDIO_VOLUME;
    void audio.play().catch((): void => undefined);
  }
}

/**
 * Wires the header's menu pill. On a phone the header has no room for the
 * versions, the audio and theme pills and the credits: they fold behind
 * this pill, which opens them over the page and closes them again (and so
 * does a press anywhere outside). On a wide screen the pill is not shown.
 */
function headMenuPill_wire(): void {
  const pill: HTMLElement = element_require('head-menu-pill');
  const open_set = (open: boolean): void => {
    if (open) document.body.dataset['headMenu'] = 'open';
    else delete document.body.dataset['headMenu'];
    pill.setAttribute('aria-expanded', String(open));
  };
  pill.addEventListener('click', (event: MouseEvent): void => {
    event.stopPropagation();
    open_set(document.body.dataset['headMenu'] !== 'open');
  });
  document.addEventListener('click', (event: MouseEvent): void => {
    if (document.body.dataset['headMenu'] !== 'open') return;
    const inside: boolean = event.target instanceof Element && event.target.closest('#header-dag-info') !== null;
    if (!inside) open_set(false);
  });
}

/**
 * Wires the audio pill: green means the panel voice is live, red means
 * muted. The choice persists per browser.
 */
function audioPill_wire(): void {
  const pill: HTMLElement = element_require('audio-pill');
  try {
    audioMuted = window.localStorage.getItem(AUDIO_STORAGE_KEY) === 'off';
  } catch {
    audioMuted = false;
  }
  const paint: () => void = (): void => {
    pill.classList.toggle('audio-off', audioMuted);
    synthVoice.muted_set(audioMuted);
  };
  paint();
  recordedSounds_learn();
  pill.addEventListener('click', (): void => {
    audioMuted = !audioMuted;
    try {
      window.localStorage.setItem(AUDIO_STORAGE_KEY, audioMuted ? 'off' : 'on');
    } catch {
      // A browser without storage still gets the session-long choice.
    }
    paint();
    // Unmuting speaks; muting is, fittingly, silent.
    sound_play('audio2');
  });
}

/**
 * Resolves the daemon WebSocket URL from where this page was served.
 *
 * @returns The WebSocket URL.
 */
function wsUrl_resolve(): string {
  return wireUrl_resolve(window.location);
}


/** Watches the header so its slide distance is never a stale measurement. */
let headerHeightObserver: ResizeObserver | null = null;
/**
 * The header's last AT-REST extent. Zoom-from-away cannot measure the header
 * directly — clearing the away state to zoom catches it mid-slide, and a
 * mid-slide measurement is short — so it reads the last rested height here.
 */
let headerRestHeight: number = 0;

/**
 * Keeps `--zoom-header-height` equal to the header's current extent.
 *
 * The header slides off by a measured distance, and its height is not
 * fixed: version rows arrive from the daemon after attach, and a face can
 * be swapped. Measuring once, at the moment of the gesture, left whatever
 * grew afterwards on stage. A ceiling or a pixel of slack does not fix
 * that; keeping the measurement current does.
 *
 * @param header - The header wrap that slides.
 * @param body - The element carrying the custom property.
 */
function headerHeight_track(header: HTMLElement, body: HTMLElement): void {
  const sync = (): void => {
    // Only while the header is at rest. Zooming hides the lid and the
    // status readouts, so a header measured mid-slide is shorter than the
    // distance it has to travel, and tracking it there would shorten the
    // slide until the header reappeared.
    if (body.dataset['zoom'] !== undefined || body.dataset['header'] === 'away') return;
    // Layout, not paint: the bounding box carries the slide's translate, so
    // a header still gliding back (the dashboard letting go of its zoom)
    // measured a few pixels, and every later zoom slid it up by those few
    // and left it on screen. Offsets ignore the translate.
    headerRestHeight = Math.ceil(header.offsetTop + header.offsetHeight);
    body.style.setProperty('--zoom-header-height', `${headerRestHeight}px`);
  };
  sync();
  if (headerHeightObserver !== null) return;
  headerHeightObserver = new ResizeObserver(sync);
  headerHeightObserver.observe(header);
}

/** Shortest the console may be dragged, so its strip stays grabbable. */

const DRAWER_MIN_HEIGHT_PX: number = 120;

/**
 * Space kept above a dragged console.
 *
 * Enough for the page header and the drawer's own bar, so a console pulled
 * to its limit still shows the controls that shrink it again.
 */
const DRAWER_HEADROOM_PX: number = 96;

/**
 * Wires the tactical drawer: the lid's bar-10 segment toggles the console,
 * the mars pill retracts it, and the access strip drag-resizes it. The
 * bar-10 segment beckons while the drawer is closed, and stops the moment
 * attention belongs to the open console, per the prototype's design.
 *
 * @param drawer - The drawer element containing the terminal.
 * @param strip - The access strip below the terminal (drag to resize).
 * @param toggle - The lid's bar-10 segment (click to toggle).
 * @param close - The mars close pill in the drawer header.
 * @param terminal - The terminal to refit after size changes.
 */
function drawer_wire(
  drawer: HTMLElement,
  strip: HTMLElement,
  toggle: HTMLElement,
  terminal: ArgusTerminal,
): (closed: boolean) => void {
  // A drag leaves an inline height on the drawer, which would defeat the
  // closed class; stash it while closed and restore it on reopen.
  let openHeight: string = '';
  const closed_set = (closed: boolean): void => {
    if (closed) {
      openHeight = drawer.style.height;
      drawer.style.height = '';
    } else if (openHeight !== '') {
      drawer.style.height = openHeight;
    }
    // The closed-state beckon is pure CSS on the lid's end block
    // (#drawer.drawer-closed ~ .bar-panel .bar-10). Stamping a filter class
    // on the whole bar here made every segment pulse against the static
    // elbow arm it joins.
    drawer.classList.toggle('drawer-closed', closed);
    sound_play('audio3');
    if (!closed) {
      terminal.size_fit();
      terminal.focus_take();
    }
  };

  toggle.addEventListener('click', (): void =>
    closed_set(!drawer.classList.contains('drawer-closed')),
  );

  let dragStartY: number = 0;
  let dragStartHeight: number = 0;
  let dragging: boolean = false;
  // Pointer events, captured: a finger drags the strip as a mouse does (a
  // phone sent no mouse events, and the console's foot would not move).
  strip.addEventListener('pointerdown', (event: PointerEvent): void => {
    dragging = true;
    dragStartY = event.clientY;
    dragStartHeight = drawer.getBoundingClientRect().height;
    // Dragging steers the height directly; the zoom transition would lag it.
    drawer.classList.add('drawer-dragging');
    strip.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  strip.addEventListener('pointermove', (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    // The strip floats above the lid, so pulling it down grows the console.
    // The only bounds are the ones the screen imposes: a floor so the strip
    // stays grabbable, and a ceiling so the console cannot push its own
    // header off the top. Everything between is the operator's to choose.
    const ceiling: number = Math.max(DRAWER_MIN_HEIGHT_PX, window.innerHeight - DRAWER_HEADROOM_PX);
    const wanted: number = dragStartHeight + (event.clientY - dragStartY);
    const height: number = Math.min(Math.max(DRAWER_MIN_HEIGHT_PX, wanted), ceiling);
    drawer.style.height = `${height}px`;
    terminal.size_fit();
  });
  const drag_end = (): void => {
    dragging = false;
    drawer.classList.remove('drawer-dragging');
  };
  strip.addEventListener('pointerup', drag_end);
  strip.addEventListener('pointercancel', drag_end);

  return closed_set;
}

/**
 * Wires pane zoom: any control carrying data-pane names a pane, and
 * activating it zooms that pane to the full viewport — the gutter glides
 * off stage left, the header off stage top. Esc (or the same control
 * again) restores the composition, which zoom never touches: zoom is a
 * modifier over the layout, not a layout of its own.
 *
 * @param terminal - The terminal to refit once the glide settles.
 */
function zoom_wire(terminal: ArgusTerminal): (pane: string | null) => void {
  const body: HTMLElement = document.body;
  const header: HTMLElement | null = document.querySelector<HTMLElement>('.wrap:not(#gap)');
  // The header state set aside for the duration of a zoom (see below).
  let headerBeforeZoom: string | undefined;

  const zoom_set = (pane: string | null): void => {
    for (const marked of document.querySelectorAll('.pane-zoomed, .pane-zoomed-path')) {
      marked.classList.remove('pane-zoomed', 'pane-zoomed-path');
    }
    if (pane === null) {
      delete body.dataset['zoom'];
      // Give the header back the state zoom set aside.
      if (headerBeforeZoom !== undefined) {
        body.dataset['header'] = headerBeforeZoom;
        headerBeforeZoom = undefined;
      }
    } else {
      // A scrolled page would carry its offset into the clamped zoom view,
      // hiding the pane's top edge; zoom always starts from the origin.
      window.scrollTo(0, 0);
      // Zoom presents from the header-present geometry: its own slide is the
      // one that reclaims the header's space. If the header is already away it
      // has slid the wrap up once already, so leaving that state on with zoom
      // slides the pane up twice — its top frame, and its controls, off the
      // page. Set the away state aside for the duration; restore it on unzoom.
      // Synchronous with the data-zoom set below, so no header flash paints.
      if (body.dataset['header'] === 'away') {
        headerBeforeZoom = 'away';
        delete body.dataset['header'];
        // The header is mid-slide as its away state clears, so it cannot be
        // measured now; use its last rested extent for the slide distance.
        if (headerRestHeight > 0) body.style.setProperty('--zoom-header-height', `${headerRestHeight}px`);
      } else if (header !== null) {
        // The header's height is content-driven; measure its viewport bottom
        // (not offsetHeight — the first bar's top margin collapses OUT of the
        // wrap, and an offsetHeight slide left that margin's worth of header
        // crushed on stage).
        headerHeight_track(header, body);
      }
      body.dataset['zoom'] = pane;
      // A tree pane's zoom marks its leaf AND the split path above it:
      // hiding siblings alone left the leaf imprisoned in its old cell
      // (half a pane of graph, half a pane of nothing) — every ancestor
      // box on the path must also yield its full region.
      const mount: HTMLElement | undefined = paneInstance_get(pane)?.mount;
      const leaf: HTMLElement | null = mount?.parentElement ?? null;
      leaf?.classList.add('pane-zoomed');
      let ancestor: HTMLElement | null = leaf?.parentElement ?? null;
      while (ancestor !== null && ancestor.id !== 'layout-root') {
        ancestor.classList.add('pane-zoomed-path');
        ancestor = ancestor.parentElement;
      }
    }
    // The capsule is a toggle and must read as its next action.
    for (const capsule of document.querySelectorAll<HTMLElement>('.drawer-zoom')) {
      capsule.textContent = pane !== null && capsule.dataset['pane'] === pane ? 'RESTORE' : 'ZOOM';
    }
    sound_play('audio3');
  };
  // While zoomed, the thin top strip is the restore control (the
  // header-away listener yields to the zoom state).
  element_require('header-restore').addEventListener('click', (): void => {
    if (body.dataset['zoom'] !== undefined) {
      zoom_set(null);
    }
  });

  // Delegated: pane instances (and their zoom capsules) arrive live.
  document.addEventListener('click', (event: Event): void => {
    const target: EventTarget | null = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const control: HTMLElement | null = target.closest<HTMLElement>('[data-pane]');
    if (control === null) {
      return;
    }
    const pane: string = control.dataset['pane'] ?? '';
    if (pane === '') {
      return;
    }
    zoom_set(body.dataset['zoom'] === pane ? null : pane);
  });

  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && body.dataset['zoom'] !== undefined) {
      zoom_set(null);
      // One press, one level: the header-restore listener must not also
      // consume this Esc.
      event.stopImmediatePropagation();
    }
  });

  element_require('drawer').addEventListener('transitionend', (event: Event): void => {
    if ((event as TransitionEvent).propertyName === 'height') {
      terminal.size_fit();
    }
  });
  return zoom_set;
}

/**
 * Builds the top frame's data cascade, live from boot, and binds the
 * labeled telemetry face beside it.
 *
 * @returns The cascade, or null when the page has no cascade element.
 */
function cascade_build(): Cascade | null {
  // The ambient number grid has retired; the class remains the keeper of
  // the labeled telemetry rows in the stats face.
  const cascadeInstance: Cascade = new Cascade(document.getElementById('data-cascade'));
  const telemetryFace: HTMLElement | null = document.getElementById('header-telemetry');
  if (telemetryFace !== null) {
    cascadeInstance.telemetryPanel_bind(telemetryFace);
  }
  return cascadeInstance;
}

/**
 * Wires the header faces. The two gutter-top buttons SELECT: ARGUS WEB
 * shows the live stats/controls/versions face, 02-CALYPSO the pipeline
 * DAG cycler (also the resting face).
 * Pressing the already-selected button sends the whole header gliding off
 * the top, leaving the lid strip; the strip (or Esc) restores it to the
 * cascade. One declaration (`data-header` on the body) carries the state:
 * absent (cascade), 'stats', 'versions', or 'away'.
 */
/** The band's floor and the headroom it leaves the workspace, in pixels. */
const BAND_MIN_HEIGHT_PX: number = 96;
const BAND_HEADROOM_PX: number = 220;
/** Where the operator's chosen band height is remembered, per browser. */
const BAND_HEIGHT_KEY: string = 'argus.headerBand.height';

/**
 * Wires the header band's drag strip: the boundary it shares with the body
 * is a control, exactly as the console drawer's is from the other side.
 *
 * The height is ONE height for every face, so a face switch never moves
 * the workspace, and it is remembered: an operator who wants a tall cohort
 * should not have to ask for it twice. Dragged below the floor the band
 * takes the floor rather than vanishing — a band nobody can see is a band
 * they cannot drag back.
 */
/** How far above the header's foot the grip stands: on the rail's centred bar. */
const BAND_GRIP_RISE_PX: number = 52;

function headerBand_wire(): void {
  const root: HTMLElement = document.documentElement;
  const strip: HTMLElement | null = document.getElementById('header-strip');
  const header: HTMLElement | null = document.querySelector<HTMLElement>('.wrap:not(#gap)');
  if (strip === null || header === null) return;

  const height_apply = (pixels: number): void => {
    const ceiling: number = Math.max(BAND_MIN_HEIGHT_PX, window.innerHeight - BAND_HEADROOM_PX);
    const wanted: number = Math.min(Math.max(BAND_MIN_HEIGHT_PX, pixels), ceiling);
    root.style.setProperty('--header-band-h', `${wanted}px`);
    try { window.localStorage.setItem(BAND_HEIGHT_KEY, String(wanted)); } catch { /* a private window keeps nothing */ }
  };

  const remembered: string | null = ((): string | null => {
    try { return window.localStorage.getItem(BAND_HEIGHT_KEY); } catch { return null; }
  })();
  if (remembered !== null && Number.isFinite(Number(remembered))) height_apply(Number(remembered));

  /**
   * The strip rides the boundary, so it follows the band's own foot — but
   * its grip stands on the rail's centred bar, inside the header's art,
   * not on the boundary line itself: there the grip lay on the console's
   * title bar, in the title bar's own hue, and nobody could see it. The
   * centred bar is where the operator reached for a grab.
   */
  const strip_place = (): void => {
    const box: DOMRect = header.getBoundingClientRect();
    strip.style.top = `${Math.max(0, box.bottom - BAND_GRIP_RISE_PX)}px`;
  };
  strip_place();
  window.addEventListener('resize', strip_place);
  new MutationObserver(strip_place).observe(document.body, { attributes: true, attributeFilter: ['data-header'] });
  window.setInterval(strip_place, 500);

  let dragging: boolean = false;
  let startY: number = 0;
  let startHeight: number = 0;
  // Pointer events, captured: a finger drags the band's foot as a mouse does.
  strip.addEventListener('pointerdown', (event: PointerEvent): void => {
    const face: HTMLElement | null = document.querySelector<HTMLElement>('.header-face');
    dragging = true;
    startY = event.clientY;
    startHeight = face === null ? BAND_MIN_HEIGHT_PX : face.getBoundingClientRect().height;
    strip.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  strip.addEventListener('pointermove', (event: PointerEvent): void => {
    if (!dragging) return;
    height_apply(startHeight + (event.clientY - startY));
    strip_place();
  });
  const band_dragEnd = (): void => { dragging = false; strip_place(); };
  strip.addEventListener('pointerup', band_dragEnd);
  strip.addEventListener('pointercancel', band_dragEnd);
}

/** Set once the surface is up: puts the cohort on the main panel. */
let cohortStage_run: (() => void) | null = null;

/**
 * The band's cohort says when it holds more than it shows. The band keeps
 * one height (gathering never moves the body), so a long cohort scrolls
 * inside it — and nothing said so, and ON STAGE sat on a retracted frame.
 * A chip at the band's foot reads `+N MORE · ON STAGE` while rows lie below
 * the view: N is how many, the press puts the whole cohort on stage. It is
 * gone when everything is in view.
 *
 * @param field - The band's cohort field.
 */
function gatherMore_wire(field: HTMLElement): void {
  const rows: HTMLElement | null = field.querySelector<HTMLElement>('.gather-rows');
  if (rows === null) return;
  // The band's chip is the field's chip wearing a verb: N counts the rows
  // below, the press puts the whole cohort on stage.
  const chip: HTMLButtonElement = more_wire(rows, {
    rows: '.listing-row',
    label: (below: number): string => `+${below} MORE · ON STAGE`,
    press: (): void => { cohortStage_run?.(); },
    className: 'strategy-pill gather-more',
    mount: field,
  });
  chip.title = 'the whole cohort as a pane on the main panel';
}

/**
 * A mode frame says when it holds more blocks than its field is tall. The
 * frame scrolls (a short band or pane cannot grow for it: gathering never
 * moves the body), its scrollbar is gone, and the field's chip at its foot
 * reads `▼ N MORE` while blocks lie below the view — the press shows them —
 * or `▲ TOP` once the foot is reached.
 *
 * @param frame - The frame.
 */
function frameMore_wire(frame: HTMLElement): void {
  more_wire(frame, { rows: '.strategy-pill, .listing-action, .holder-mark', className: 'frame-more' });
}

/** Wires every mode frame on the page, now and as panes mint theirs. */
function modeFrames_watch(): void {
  const wire = (root: ParentNode): void => {
    for (const frame of root.querySelectorAll<HTMLElement>('.mode-frame:not([data-more])')) frameMore_wire(frame);
  };
  new MutationObserver((records: MutationRecord[]): void => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches('.mode-frame') && node.dataset['more'] === undefined) frameMore_wire(node);
        wire(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  wire(document);
}

/**
 * Speaks what `say` said, through the page's own speech when it has one.
 * A page without it (or a muted one) says nothing: the console already
 * printed the words.
 *
 * @param data - The envelope's model data: `{ text }`.
 */
function voice_say(data: unknown): void {
  const text: unknown = (data as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.length === 0 || typeof window.speechSynthesis === 'undefined') return;
  const words: SpeechSynthesisUtterance = new SpeechSynthesisUtterance(text);
  words.rate = 1;
  window.speechSynthesis.speak(words);
}

function headerFaces_wire(): void {
  const body: HTMLElement = document.body;
  const header: HTMLElement | null = document.querySelector<HTMLElement>('.wrap:not(#gap)');

  const face_select = (face: string): void => {
    if (body.dataset['header'] === face) {
      // Second press on the selected face: the header itself departs, gliding
      // up by its measured height while it leaves the flow (the CSS takes it
      // absolute), so the workspace flows up to fill the top exactly.
      if (header !== null) {
        headerHeight_track(header, body);
      }
      body.dataset['header'] = 'away';
    } else {
      body.dataset['header'] = face;
    }
  };
  document.querySelector('.panel-1')?.addEventListener('click', (): void => face_select('stats'));
  document.querySelector('.panel-2')?.addEventListener('click', (): void => face_select('dag'));
  document.querySelector('.panel-gather')?.addEventListener('click', (): void => face_select('gather'));
  // The band is not a pane, but its field hosts a frame (`data-frame-host`)
  // and that frame answers to the one grammar the panes' do: the strip
  // toggles it, a press inside it acts, a press on the fill or anywhere
  // else retracts it, and Esc retracts it with the rest. The document's
  // retraction handler reads the host; the band keeps no toggle of its own.
  const bandField: HTMLElement | null = document.querySelector<HTMLElement>('.header-gather-field');
  bandField?.querySelector('.gather-stage')?.addEventListener('click', (event: Event): void => {
    event.stopPropagation();
    cohortStage_run?.();
  });
  if (bandField !== null) gatherMore_wire(bandField);
  modeFrames_watch();

  const header_restore = (): void => {
    if (body.dataset['zoom'] !== undefined) {
      // The strip belongs to the zoom while one is active.
      return;
    }
    delete body.dataset['header'];
    sound_play('audio3');
  };
  element_require('header-restore').addEventListener('click', header_restore);
  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    // Esc peels one layer at a time: a zoom first, then the gutter, then the
    // header — so the header restores only when nothing inner is still away.
    if (
      event.key === 'Escape' &&
      body.dataset['header'] === 'away' &&
      body.dataset['zoom'] === undefined &&
      body.dataset['gutter'] !== 'away'
    ) {
      header_restore();
    }
  });
}

/**
 * The themes the pill cycles through: four schemes of the imported look,
 * and PHAROS, the house visual language in its clinical palette (docs/pharos.adoc),
 * which is not a scheme of that look but a theme of its own on the same
 * tokens.
 */
const LCARS_SCHEMES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'lower-decks', label: 'LOWER DECKS' },
  { key: 'gold', label: 'CERRITOS GOLD' },
  { key: 'medical', label: 'MEDICAL' },
  { key: 'nemesis', label: 'NEMESIS' },
  { key: 'pharos', label: 'PHAROS' },
];

/** The localStorage key remembering where a session begins. */
const LANDING_STORAGE_KEY: string = 'argus-landing';

/** How often the dashboard re-reads what each domain holds, while it is on stage. */
const DASHBOARD_TICK_MS: number = 15_000;

/**
 * Whether this browser begins at the launcher.
 *
 * A browser that has never said starts there once: the launcher is the
 * answer to "where am I, what can I do, what next", and the resting
 * workspace answers none of them at once. Having seen it, the operator's
 * own choice stands — the capsule on the launcher itself sets this.
 *
 * @returns True when a session should open on the launcher.
 */
function landing_isLauncher(): boolean {
  try {
    return (window.localStorage.getItem(LANDING_STORAGE_KEY) ?? 'launcher') === 'launcher';
  } catch {
    return true;
  }
}

/**
 * Remembers where a session begins.
 *
 * @param on - True to begin at the launcher, false to begin as last left.
 */
function landing_set(on: boolean): void {
  try {
    window.localStorage.setItem(LANDING_STORAGE_KEY, on ? 'launcher' : 'last');
  } catch {
    // A browser without storage still gets the session-long choice.
  }
}

/** The localStorage key remembering the theme. */
const LCARS_STORAGE_KEY: string = 'argus-theme';
/** The key the choice was remembered under before the attribute was renamed. */
const LCARS_STORAGE_KEY_FORMER: string = 'argus-lcars';

/** The scheme a browser that has never chosen one starts in. */
const LCARS_DEFAULT_KEY: string = 'medical';

/** Scheme keys that were renamed, so a remembered choice survives. */
const LCARS_RENAMED: Readonly<Record<string, string>> = { sickbay: 'medical' };

/**
 * Wires the theme pill: each press advances to the next theme. The theme
 * is one declaration (`data-theme` on the root element); the palettes and
 * the ornament live in CSS. The choice persists per browser.
 */
function themePill_wire(): void {
  const pill: HTMLElement = element_require('theme-pill');
  const fallback: number = Math.max(
    LCARS_SCHEMES.findIndex((scheme): boolean => scheme.key === LCARS_DEFAULT_KEY),
    0,
  );
  let index: number = fallback;
  try {
    const saved: string | null =
      window.localStorage.getItem(LCARS_STORAGE_KEY) ?? window.localStorage.getItem(LCARS_STORAGE_KEY_FORMER);
    // A remembered scheme survives its own renaming; a browser that never
    // chose gets the default rather than whichever scheme is listed first.
    const wanted: string | null = saved === null ? null : (LCARS_RENAMED[saved] ?? saved);
    const found: number = LCARS_SCHEMES.findIndex((scheme): boolean => scheme.key === wanted);
    index = found >= 0 ? found : fallback;
  } catch {
    index = fallback;
  }
  // The scheme lives on the root element: the theme's derived variables
  // (--panel-4-color and kin) are resolved where they are defined — :root —
  // so a body-level override would leave them holding the original palette.
  const root: HTMLElement = document.documentElement;
  const paint = (): void => {
    const scheme = LCARS_SCHEMES[index] ?? LCARS_SCHEMES[0]!;
    if (scheme.key === 'lower-decks') {
      delete root.dataset['theme'];
    } else {
      root.dataset['theme'] = scheme.key;
    }
    pill.textContent = scheme.label;
  };
  paint();
  pill.addEventListener('click', (): void => {
    index = (index + 1) % LCARS_SCHEMES.length;
    paint();
    try {
      window.localStorage.setItem(LCARS_STORAGE_KEY, LCARS_SCHEMES[index]?.key ?? 'lower-decks');
    } catch {
      // A browser without storage still gets the session-long choice.
    }
    sound_play('audio2');
  });
}

/**
 * Fills the about face: the mise stack and its versions, this bundle's
 * git hash and build time, the wire contract, and the page's credits.
 *
 * @param attach - The attach ack, carrying the daemon's stack report.
 */
function aboutFace_fill(attach: AttachInfo): void {
  // The rows container only: the face's static footer (the attribution,
  // moved up from the page bottom) stays untouched.
  const face: HTMLElement | null = document.getElementById('about-rows');
  if (face === null) {
    return;
  }
  face.replaceChildren();
  // The packages the session runs: ChRIS's own (cumin, salsa, chili) only
  // under the ChRIS composition, where they are what the session is made of.
  const chrisStack: boolean = attachBackend_get(attach) === 'chris';
  const stack: Record<string, string | undefined> = {
    ...(chrisStack ? { cumin: attach.stack?.cumin, salsa: attach.stack?.salsa, chili: attach.stack?.chili } : {}),
    brasa: attach.stack?.brasa,
    calypso: attach.stack?.calypso,
    chell: attach.stack?.chell,
  };
  const rows: Array<[string, string]> = [];
  for (const [name, version] of Object.entries(stack)) {
    if (version !== undefined) {
      rows.push([name.toUpperCase(), version]);
    }
  }
  rows.push(
    ['MENU', __ARGUS_MENU__],
    ['ARGUS', `${__ARGUS_GIT__} · ${__ARGUS_BUILT__}Z`],
    ['WIRE', `V${attach.protocolVersion}`],
  );
  if (attach.stack?.build !== undefined) {
    rows.push(['BUILD', attach.stack.build]);
  }
  for (const [label, value] of rows) {
    const row: HTMLDivElement = document.createElement('div');
    row.className = 'telemetry-row';
    const name: HTMLSpanElement = document.createElement('span');
    name.className = 'telemetry-label';
    name.textContent = label;
    const figure: HTMLSpanElement = document.createElement('span');
    figure.className = 'telemetry-value';
    figure.textContent = value;
    // A narrow header elides a long value rather than wrapping it; the
    // whole fact stays reachable on hover.
    figure.title = value;
    row.append(name, figure);
    face.appendChild(row);
  }
}

/**
 * Wires the LCARS panel beeps: every frame button clicks with the theme's
 * voice, live or inert alike.
 */
function panelSounds_wire(): void {
  for (const button of document.querySelectorAll('.left-frame button, .left-frame-top button')) {
    button.addEventListener('click', (): void => sound_play('audio2'));
  }
}

/**
 * Attaches to the daemon and wires every instrument to the session.
 *
 * @param token - The attach token.
 * @returns Resolves when the surface is attached and interactive.
 * @throws {Error} When the attach is refused.
 */
/** The data cascade, built at page boot and fed by the session's wiring. */
let cascade: Cascade | null = null;

async function surface_start(token: string): Promise<void> {
  // Which console the page shows (consoleMode.ts): wired once attached, read
  // by the questions that have no pane to stand on.
  let consoleMode: ConsoleModeControl | null = null;
  // Which backend the session runs over decides the composition: ChRIS's
  // panes, words, tiles and instruments, or the frame alone. Asked before
  // anything is built; a daemon older than the question is ChRIS.
  const backend: string = await backend_ask(token);
  const chris: boolean = backend === 'chris';
  // One declaration on the body: what a composition owns in the page's own
  // markup (its gutter domains, its header band and instrument) stands only
  // under that composition.
  document.body.dataset['composition'] = backend;
  const statusBar: StatusBar = new StatusBar(document);
  // The composition's share of the session's signals: the index instrument,
  // and RUNS, the universe and PACS (compositions/chris/signals.ts).
  const signals: ChrisSignals = !chris ? { promptContext_take: (): void => undefined, telemetry_take: (): void => undefined, progress_take: (): void => undefined } : chrisSignals_make(element_require('index-instrument'), {
    dag_primary: (): DagPanel => dagPanel,
    dag_instances: (): DagPanel[] => panels.values('dag'),
    universes: (): UniversePanel[] => panels.values('universe'),
    pacs: (): PacsPanel => pacsPanel,
    runs_show: (filter: string): void => runs_show(filter),
  });
  // A joblet's STOP is a line at the console, `kill %N`, as typed there.
  const laneInstrument: LaneInstrument = new LaneInstrument(element_require('lane-instrument'), undefined, (line: string): void => { void terminal.line_run(line); });
  // The beat's age moves on the surface's own clock, not only on beats.
  window.setInterval((): void => laneInstrument.tick(), 500);

  // Panel roster: every live controller by pane id, for routing —
  // targeted progress, and the claim rule for console-issued models.
  const panels: PanelRoster = new PanelRoster();
  // The composition's words in the language (compositions/chris/lang.ts):
  // installed before any pane's chrome reads the chords.
  if (chris) language_extend(chrisLanguage((): ChrisLangHost => argusHost));
  // `cluster` takes the screen as the controller (compositions/stratus/lang.ts).
  if (backend === 'stratus') language_extend(stratusLanguage((): StratusLangHost => ({ ...argusHost, controller_open: (name: string): Promise<string> => tdController.open(name) })));

  // The subject bus: pane linkage as hub-and-spoke subjects. Every regard
  // write also flows to the daemon as session truth (the two-layer model).
  const subjects: SubjectBus = new SubjectBus();
  subjects.writeObserver_set((value: RegardValue, groupId: string): void => {
    client.regard_send({
      address: value.address,
      ...(value.modelKind !== undefined ? { modelKind: value.modelKind } : {}),
      groupId,
      paneId: value.paneId,
    });
    // A pane's regard just changed — re-light the PACS rows' verbs to match.
    pacsStage_relight();
  });

  /**
   * The host as its modules read it (app/hostContext.ts). The layout, the
   * dormant groups, the terminal and the client are made further down; a
   * module reads them when it is called, never at wiring.
   */
  const context: HostContext = {
    get layout(): LayoutManager { return layout; },
    panels,
    paneInstance_get,
    subjects,
    get dormant(): DormantRegistry { return dormant; },
    sound: sound_play,
    get terminal(): ArgusTerminal { return terminal; },
    get client(): ArgusClient { return client; },
  };

  /** Builds the byte route for a path, from where this page was served. */
  /**
   * A /bin entry as the graph it is (app/binView.ts): a pipeline's nodes or
   * a plugin's one, the dive into a node, the form a bound catalogue makes
   * of it. The catalogue bindings and RUN are its hooks.
   */
  const binView: BinView = binView_wire(context, {
    catalogue_find: (paneId: string): CatalogueBinding | undefined => catalogueBindings.get(paneId),
    run_press: (paneId: string, executable: string, kind: 'plugin' | 'pipeline'): void => { void run_press(paneId, executable, kind); },
  });
  const binEntry_show = binView.entry_show;

  /**
   * The browser (app/browser.ts): the files pane as this host builds it,
   * its readers, its rooted listings and history, its binding to the cwd,
   * its row and selection verbs. The host's routes, opens, asks, cohort and
   * /bin view are its hooks, read when called.
   */
  const vfsUrl_build = (path: string): string => routeVfsUrl_build(path, token);
  const browser: Browser = browser_wire(context, {
    vfsUrl_build,
    downloadUrl_build: (path: string): string => routeDownloadUrl_build(path, token),
    image_open: (fromId: string, path: string): Promise<string> => image_open(fromId, path),
    process_open: (fromId: string, binding: CatalogueBinding): void => process_open(fromId, binding),
    run_press: (paneId: string, executable: string, kind: 'plugin' | 'pipeline'): void => { void run_press(paneId, executable, kind); },
    cohort_gather: (entries: ReadonlyArray<GatherSeries>): void => cohort_gather(entries),
    verbLine_run: (paneId: string, line: string): void => verbLine_run(paneId, line),
    askOnPane_await: (paneId: string, request: PaneAskRequest): Promise<string | null> => askOnPane_await(paneId, request),
    binEntry_show,
    catalogue_find: (paneId: string): CatalogueBinding | undefined => catalogueBindings.get(paneId),
    promptUser: (): string | null => promptUser,
    template_stamp,
    pane_find,
  });
  const { previewProvider, fileText_fetch, file_save, rootedListing_show, listing_refresh, directory_make, files_deliver, filesBody_stamp, rowVerbs_build } = browser;
  const filesInstance_build = browser.instance_build;

  /** The session's user, as the prompt context last named it; null before the first. */
  let promptUser: string | null = null;
  /** The session's identity (user and CUBE), as the prompt last named it. */
  let promptIdentity: string | null = null;

  /** What a bound catalogue processes: the input, and where a run of it lands. */
  const catalogueBindings: Map<string, CatalogueBinding> = new Map();

  // Builds one viewer pane instance: a slaved projection of its group's
  // regard. The subscription happens at spawn time, after the instance has
  // joined its group (the retained cell then replays immediately).


  // The DICOM panes: a series or volume, and its instance's tags
  // (compositions/chris/dicom.ts), bound to this surface.
  const {
    imageInstance_build, tagsInstance_build, tags_ask, tagsPane_follow, tagsPane_open,
    series_ask, subfolders_ask, imagePane_resolve, image_open,
  }: ChrisDicom = chrisDicom_make({
    client: (): ArgusClient => client,
    terminal: (): ArgusTerminal => terminal,
    panels: (): PanelRoster => panels,
    subjects: (): SubjectBus => subjects,
    layout: (): LayoutManager => layout,
    desktop: (): Desktop => desktop,
    instance_spawn: (kind: PaneKind, inheritFrom?: string): PaneInstance => instance_spawn(kind, inheritFrom),
    errandHost_find: (): string | null => errandHost_find(),
    launcher_yield: (): void => launcher_yield(),
    birth_record: (childId: string, parent: string, dir: 'row' | 'col', before: boolean, binding?: string): void =>
      birth_record(childId, parent, dir, before, binding),
    vfsUrl_build: (path: string): string => vfsUrl_build(path),
  });

  /**
   * Opens a series' own CFS folder as a file browser, joined to the series'
   * group so the browser and its viewer are one restorable group. A browser
   * already showing this folder is reused; a viewer on stage for the series
   * lends its group, else the browser anchors the group on the folder.
   */
  /**
   * PROCESS: opens `/bin` as a catalogue bound to an input, right of the pane
   * the verb was pressed in and joined to its group, so the operator picks
   * what to run from a listing — the same gesture as every other choice.
   *
   * @param fromId - The pane PROCESS was pressed in.
   * @param binding - The input, and the feed/node a run of it lands in.
   */
  const process_open = (fromId: string, binding: CatalogueBinding): void => {
    launcher_yield();
    const shown: Set<string> = new Set(layout.panes_shown());
    for (const [id, bound] of catalogueBindings) {
      if (shown.has(id) && bound.input === binding.input) { layout.focus_set(id); return; }
    }
    const host: string = shown.has(fromId) ? fromId : (errandHost_find() ?? fromId);
    const spawned: PaneInstance = instance_spawn('catalogue', fromId);
    if (!layout.leaf_split(host, desktop.replayPlace_get()?.dir ?? 'col', spawned.id, desktop.replayPlace_get()?.before ?? false)) {
      paneInstance_dispose(spawned.id);
      layout.mount_remove(spawned.id);
      return;
    }
    birth_record(spawned.id, host, desktop.replayPlace_get()?.dir ?? 'col', desktop.replayPlace_get()?.before ?? false);
    catalogueBindings.set(spawned.id, binding);
    const panel: FilesPanel | undefined = panels.get('files', spawned.id);
    if (panel === undefined) return;
    panel.binding_set({
      input: binding.input,
      place: binding.feed === null ? 'new feed' : `feed ${binding.feed}${binding.node === null ? '' : ` · node ${binding.node}`}`,
    });
    panel.feedOpen_declare((feedId: number): void => feed_open(spawned.id, feedId));
    rootedListing_show(spawned.id, panel, '/bin');
    recent_lead(panel);
    layout.focus_set(spawned.id);
  };

  /** How many executables the catalogue leads with, and how far back it looks for them. */
  const RECENT_SHOWN: number = 5;
  const RECENT_LOOKBACK: number = 40;

  /**
   * Leads a catalogue with what this operator ran lately: the kernel's own
   * instance listing (newest first, as a model), reduced to the distinct
   * executables of the operator's runs, the feed root's copy left out.
   *
   * @param panel - The catalogue.
   */
  const recent_lead = (panel: FilesPanel): void => {
    const fields: string = 'id,plugin_name,plugin_version,owner_username';
    void client.line_execute(`plugininstance list --limit ${RECENT_LOOKBACK} --fields ${fields}`, { silent: true, observe: false })
      .then((outcome: ExecuteOutcome): void => {
        const names: string[] = [];
        for (const envelope of outcome.envelopes) {
          if (envelope.model?.kind !== 'plugininstance.list' || !Array.isArray(envelope.model.data)) continue;
          for (const row of envelope.model.data as Array<{ pluginName?: unknown; pluginVersion?: unknown; owner?: unknown }>) {
            if (typeof row.pluginName !== 'string' || typeof row.pluginVersion !== 'string') continue;
            if (promptUser !== null && typeof row.owner === 'string' && row.owner !== promptUser) continue;
            if (row.pluginName === 'pl-dircopy') continue;
            const name: string = `${row.pluginName}-v${row.pluginVersion}`;
            if (!names.includes(name)) names.push(name);
            if (names.length >= RECENT_SHOWN) break;
          }
        }
        panel.recent_set(names.length === 0 ? null : names);
      })
      .catch((): void => { /* no history is no block */ });
  };

  /**
   * Opens a feed's graph in a runs pane beside the pane that asks, joined to
   * its group — what a run's FEED capsule does.
   *
   * @param fromId - The pane asking.
   * @param feedId - The feed.
   */
  const feed_open = (fromId: string, feedId: number): void => {
    launcher_yield();
    const shown: Set<string> = new Set(layout.panes_shown());
    for (const [id, panel] of panels.entries('dag')) {
      if (id !== 'dag' && shown.has(id) && panel.feed_get() === feedId) { layout.focus_set(id); return; }
    }
    const host: string = shown.has(fromId) ? fromId : (errandHost_find() ?? fromId);
    const spawned: PaneInstance = instance_spawn('dag', fromId);
    if (!layout.leaf_split(host, desktop.replayPlace_get()?.dir ?? 'col', spawned.id, desktop.replayPlace_get()?.before ?? false)) {
      paneInstance_dispose(spawned.id);
      layout.mount_remove(spawned.id);
      return;
    }
    birth_record(spawned.id, host, desktop.replayPlace_get()?.dir ?? 'col', desktop.replayPlace_get()?.before ?? false);
    panels.get('dag', spawned.id)?.feed_enter(feedId);
  };

  /**
   * RUN: runs an executable on the catalogue's input. The line the strip
   * holds is authoritative; empty, it is composed — a `cd` to the input
   * (which is how the kernel takes its input) then the executable, and for
   * a new feed a title, asked once with the input's name to hand. The line
   * is echoed as if typed; the kernel's answer names the feed, which lights
   * the strip's FEED capsule. A refusal reads beside the row's verbs.
   *
   * The line stands as the strip holds it when it runs this executable (a
   * dive's values and hand edits alike); otherwise it starts afresh. A new
   * feed's title is asked once, when the line has none. A pipeline runs on
   * a node, so off one it is refused by name rather than sent to fail.
   *
   * @param id - The catalogue pane.
   * @param executable - The row's executable name.
   * @param kind - Whether it is a plugin or a pipeline.
   */
  const run_press = async (id: string, executable: string, kind: 'plugin' | 'pipeline'): Promise<void> => {
    const binding: CatalogueBinding | undefined = catalogueBindings.get(id);
    const panel: FilesPanel | undefined = panels.get('files', id);
    if (binding === undefined || panel === undefined) return;
    const refuse = (reason: string): void => {
      terminal.output_write('err', `\x1b[31m${reason}\x1b[0m\n`);
      const indicated: string | null = panel.indicated_get();
      if (indicated !== null) panel.rowReadout_show(indicated, reason.toUpperCase().slice(0, 80));
    };
    if (kind === 'pipeline' && binding.node === null) {
      refuse(`${executable}: a pipeline runs on a node — PROCESS a node of a feed`);
      return;
    }
    let line: string = panel.commandLine_get();
    if (line === '' || runLine_executable(line) !== executable) line = runLine_compose(binding.input, executable);
    if (binding.feed === null && !runLine_hasTitle(line)) {
      const suggested: string = binding.input.split('/').filter(Boolean).pop() ?? 'feed';
      const title: string | null = await askOnPane_await(id, { message: 'Feed title: ', kind: 'text', suggest: suggested, commit: 'RUN' });
      const wanted: string = (title ?? '').trim();
      if (wanted === '') return;
      line = runLine_titleAppend(line, wanted);
    }
    panel.commandLine_set(line);
    terminal.line_echo(line);
    let outcome: ExecuteOutcome;
    try {
      outcome = await client.line_execute(line, { silent: true });
    } catch (error: unknown) {
      refuse(error instanceof Error ? error.message : String(error));
      return;
    }
    terminal.outcome_write(outcome);
    if (outcome.envelopes.some((envelope): boolean => envelope.model?.kind === 'fs.cwd')) {
      void client.line_execute('ls', { silent: true });
    }
    // A plugin answers run.scheduled, a pipeline pipeline.scheduled; both say
    // which feed the work landed in, and the surface lights that feed.
    const scheduled: WireEnvelope | undefined = outcome.envelopes.find(
      (envelope: WireEnvelope): boolean => envelope.model?.kind === 'run.scheduled' || envelope.model?.kind === 'pipeline.scheduled',
    );
    const data: { feedId?: unknown } | undefined = scheduled?.model?.data as { feedId?: unknown } | undefined;
    if (typeof data?.feedId === 'number') {
      panel.run_show(data.feedId);
      return;
    }
    const refusal: string = outcome.envelopes
      .map((envelope: WireEnvelope): string => envelope.renderedErr ?? '')
      .join(' ')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
      .split('\n')[0] ?? '';
    const indicated: string | null = panel.indicated_get();
    if (indicated !== null) panel.rowReadout_show(indicated, refusal === '' ? 'NOT SCHEDULED' : refusal.toUpperCase().slice(0, 80));
  };

  const dir_open = (folderPath: string): void => {
    launcher_yield();
    const shown: Set<string> = new Set(layout.panes_shown());
    for (const [id] of panels.entries('files')) {
      if (shown.has(id) && subjects.regard_get(id)?.address === folderPath) { layout.focus_set(id); return; }
    }
    let inheritFrom: string | undefined;
    for (const [id, panel] of panels.entries('image')) {
      if (shown.has(id) && (subjects.regard_get(id)?.address === folderPath || panel.state_get()?.path === folderPath)) { inheritFrom = id; break; }
    }
    const host: string | null = errandHost_find();
    if (host === null) return;
    const spawned: PaneInstance = instance_spawn('files', inheritFrom);
    if (!layout.leaf_split(host, desktop.replayPlace_get()?.dir ?? 'col', spawned.id, desktop.replayPlace_get()?.before ?? false)) {
      paneInstance_dispose(spawned.id);
      layout.mount_remove(spawned.id);
      return;
    }
    birth_record(spawned.id, host, desktop.replayPlace_get()?.dir ?? 'col', desktop.replayPlace_get()?.before ?? false);
    if (inheritFrom === undefined) subjects.regard_write(spawned.id, { address: folderPath, modelKind: 'dicom.series' });
    const panel: FilesPanel | undefined = panels.get('files', spawned.id);
    if (panel !== undefined) rootedListing_show(spawned.id, panel, folderPath);
  };

  /**
   * The GATHER pane: a cohort as a listing, born beside the PACS workspace
   * and joined to its group. Its rows' IMAGE and PROCESS open into that
   * group; DISMISS closes the pane (the cohort is forgotten on the surface
   * only — a saved manifest is a file in ~/gather).
   *
   * @param id - The pane id.
   * @returns The instance.
   */
  /**
   * The session's cohort (app/cohort.ts): one per session, the band's and
   * the GATHER pane's alike. The host's open verbs, asks and stage are its
   * hooks; the ones declared further down are read when called.
   */
  const cohortModule: CohortModule = cohort_wire(context, {
    image_open: (fromId: string, path: string): Promise<string> => image_open(fromId, path),
    process_open: (fromId: string, binding: CatalogueBinding): void => process_open(fromId, binding),
    feed_open: (fromId: string, feedId: number): void => feed_open(fromId, feedId),
    askOnPane_await: (id: string, request: PaneAskRequest): Promise<string | null> => askOnPane_await(id, request),
    errandHost_find: (): string | null => errandHost_find(),
    instance_spawn: (kind: PaneKind, inheritFrom?: string): PaneInstance => instance_spawn(kind, inheritFrom),
    birth_record: (childId: string, parent: string, dir: 'row' | 'col', before: boolean): void => birth_record(childId, parent, dir, before),
    replayPlace_get: (): ReplayPlace | null => desktop.replayPlace_get(),
    stage_relight: (): void => pacsStage_relight(),
    home_apply: (): void => home_apply(),
    orphans_dispose: (): void => orphans_dispose(),
    template_stamp,
    pane_find,
    element_require,
  });
  const gatherInstance_build = cohortModule.instance_build;
  const cohort_gather = cohortModule.gather;
  const gather_open = cohortModule.open;

  const viewInstance_build = (id: string): PaneInstance => {
    const mount: HTMLElement = template_stamp('tpl-pane-view');
    // The viewer's body scrolls a long text or a tall picture, and says so.
    more_wire(pane_find(mount, '.view-body'));
    const panel: ViewerPanel = new ViewerPanel(
      pane_find(mount, '.view-body'),
      pane_find(mount, '.view-title'),
      {
        content_fetch: async (path: string): Promise<string> => (await fileText_fetch(path)).text,
        imageUrl_build: vfsUrl_build,
        path_isImage: extension_isImage,
      },
    );
    panels.set('view', id, panel);
    return {
      id,
      kind: 'view',
      mount,
      dispose: (): void => {
        panels.delete(id);
        subjects.pane_leave(id);
      },
    };
  };

  /**
   * Inside a node: the rooted browser over the canvas once the camera has
   * flown into a sphere (app/nodeOverlay.ts). The host's files body, rooted
   * listing, row verbs and file readers are its hooks.
   */
  const nodeOverlay: NodeOverlay = nodeOverlay_wire(context, {
    filesBody_stamp,
    rootedListing_show,
    rowVerbs_build,
    image_open: (fromId: string, path: string): Promise<string> => image_open(fromId, path),
    imagery_is,
    tableFile_is: (path: string): boolean => TABLE_FILE_PATTERN.test(path),
    vfsUrl_build,
    fileText_fetch,
    previewProvider,
  });
  const nodeOverlay_open = nodeOverlay.open;
  const nodeOverlay_close = nodeOverlay.close;


  // A feed's tags, name and access: TAG, RENAME, SHARE and the marks' ×, each a visible line (app/tags.ts, app/access.ts).
  const feedVerbs: FeedVerbs = feedVerbs_wire(context, { askOnPane_await: (paneId, request) => askOnPane_await(paneId, request), promptUser: (): string | null => promptUser, changed: (): void => { for (const dag of panels.values('dag')) { dag.roster_ask(); dag.marks_refresh(); dag.indicated_refresh(); } } });
  // The ChRIS composition's own panes: RUNS and the UNIVERSE (compositions/chris/panes.ts).
  const chrisPanes: ChrisPanes = chrisPanes_make({
    client: (): ArgusClient => client,
    terminal: (): ArgusTerminal => terminal,
    panels: (): PanelRoster => panels,
    subjects: (): SubjectBus => subjects,
    context: (): HostContext => context,
    feedVerbs: (): FeedVerbs => feedVerbs,
    nodeOverlay: (): NodeOverlay => nodeOverlay,
    nodeOverlay_open: (paneId: string, root: string): void => nodeOverlay_open(paneId, root),
    process_open: (fromId: string, binding: CatalogueBinding): void => process_open(fromId, binding),
    promptUser: (): string | null => promptUser,
    runs_show: (): void => runs_show(),
    dag_primary: (): DagPanel => dagPanel,
    binEntry_show: (paneId: string, panel: FilesPanel, path: string, kind: 'plugin' | 'pipeline'): void => binEntry_show(paneId, panel, path, kind),
    dag_summon: (): void => dag_summon(),
  });
  // The primary instances carry the preset ids the gutter's trees name.
  const filesPrimary: PaneInstance = filesInstance_build('files', true);
  paneInstance_adopt(filesPrimary);
  // The composition's stage: RUNS, the UNIVERSE and PACS raised whole, their
  // presets, and the panes it splits in (compositions/chris/stage.ts).
  const stage: ChrisStage = chrisStage_make({
    panes: chrisPanes,
    dicom: { imageInstance_build, tagsInstance_build },
    gather_build: gatherInstance_build,
    pacsMount: element_require('pacs-workspace'),
  });
  // Built either way (the frame's closures reach RUNS and PACS), put on the
  // stage only under the ChRIS composition: the frame alone has none of them.
  const staged: ChrisStage = chris ? stage : { primaries: [], domains: [], presets: [], factories: [] };
  for (const primary of staged.primaries) paneInstance_adopt(primary);
  for (const domain of staged.domains) primary_register(domain);
  // PANES is a gutter domain like FILES/RUNS/PACS: its mount is a primary the
  // layout can raise, its card grid wired once the dormant set and restore
  // exist below.
  const launcherMount: HTMLElement = template_stamp('tpl-pane-launcher');
  paneInstance_adopt({ id: 'launcher', kind: 'launcher', mount: launcherMount });
  const panesMount: HTMLElement = template_stamp('tpl-pane-panes');
  paneInstance_adopt({ id: 'panes', kind: 'panes', mount: panesMount });
  const filesPanel: FilesPanel = panels.get('files', 'files') as FilesPanel;
  const dagPanel: DagPanel = panels.get('dag', 'dag') as DagPanel;

  const cycler: PipelineCycler = new PipelineCycler(
    element_require('pipeline-cycler'),
    element_require('pipeline-cycler-name'),
    (line: string): void => {
      void client.line_execute(line, { silent: true });
    },
  );


  /**
   * A pane on stage to open an errand beside.
   *
   * The focused pane when it is in the current tree, otherwise the tree's
   * first leaf: an errand has to land somewhere the operator can see, and
   * the alternative is a question asked of nobody.
   *
   * @returns A pane id in the current tree, or null when there is no tree.
   */
  /** Opens or retracts the console drawer; set once the drawer is wired. */
  let consoleClosed_set: ((closed: boolean) => void) | null = null;

  /**
   * Where a question stands (app/asks.ts): on the pane that provoked it,
   * as an errand beside it, or on the console when no pane can carry it.
   */
  const asks: Asks = asks_wire(context, {
    instance_spawn: (kind: PaneKind, inheritFrom?: string): PaneInstance => instance_spawn(kind, inheritFrom),
    birth_record: (childId: string, parent: string, dir: 'row' | 'col', before: boolean): void => birth_record(childId, parent, dir, before),
    replayPlace_get: (): ReplayPlace | null => desktop.replayPlace_get(),
    rootedListing_show,
    console_expose: (): void => consoleClosed_set?.(false),
    questionSheet_ask: (request: PaneAskRequest): Promise<string | null> | null =>
      consoleMode !== null && consoleMode.terminal_is() ? consoleMode.question_sheet(request) : null,
  });
  const { errandHost_find, errand_open, verbLine_run, askOnPane_await } = asks;

  // The PACS workspace scrolls whole when its levels outgrow a short leaf,
  // and says what it holds in rows (#pacs-workspace).
  more_wire(element_require('pacs-workspace'), { rows: '.listing-row' });
  const pacsPanel: PacsPanel = new PacsPanel(element_require('pacs-workspace'), {
    command_run: (line: string): void => {
      // The claim rule: a pane's own request resolves to it alone. The
      // DAG pane's own commands already come back this way, and the PACS
      // pane needs the same — asking the session for the registered
      // servers is worth nothing if the answer goes nowhere.
      // A query or a retrieve is a big, auditable action the operator took
      // through a button, so it is echoed into the console — the transcript
      // is the whole story of the session, not only of what was typed —
      // then run silently so a long retrieve never locks the prompt. The
      // incidental probes (`pacs list`, `mkdir -p ~/gather`) are not echoed.
      // The operator's own acts run as theirs, not as instrument traffic: a
      // pull may need to ask (keep waiting on a silent PACS?).
      // A retrieve comes as a joblet (`pull … &`): the answer is its start
      // notice, and its badges follow its progress on the bus (#1273).
      const operatorAct: boolean = /^(pacs query|pull )/.test(line);
      if (operatorAct) terminal.line_echo(line);
      void client.line_execute(line, { silent: true, operator: operatorAct }).then((outcome: ExecuteOutcome): void => {
        for (const envelope of outcome.envelopes) pacsPanel.envelope_observe(envelope);
      });
    },
    command_show: (line: string): void => {
      terminal.line_run(line);
    },
    note: (text: string): void => terminal.line_note(text),
    image_open: (folderPath: string): void => {
      void image_open(null, folderPath).then((line: string): void => terminal.line_note(line));
    },
    dir_open: (folderPath: string): void => dir_open(folderPath),
    // PROCESS on a series or a study: a catalogue bound to its folder,
    // beside the PACS workspace. A PACS folder is outside any feed.
    process_open: (folderPath: string): void => process_open('pacs', { input: folderPath, feed: null, node: null }),
    // GATHER: the cohort is a pane beside the workspace, not a tray under it.
    // The cohort is the session's, in the band: gathering takes a series
    // wherever the operator is standing, and never moves the workspace.
    gather_add: (entry: GatherSeries): void => cohort_gather([entry]),
    gathered_is: (seriesUID: string): boolean => cohortModule.has(seriesUID),
    workspace_close: (): void => home_apply(),
  });

  /**
   * Lights the PACS rows' verbs from the live stage: a folder gets a viewer
   * bit when a shown image pane regards it, a browser bit when a shown files
   * pane regards it. Called on every stage change, so a series' IMAGE and DIR
   * light when their panes open and go dark when they leave — a restore lights
   * them for free as the panes come back.
   */
  const pacsStage_relight = (): void => {
    const shown: Set<string> = new Set(layout.panes_shown());
    const lit: Map<string, { viewer: boolean; browser: boolean }> = new Map();
    for (const instance of paneInstances_list()) {
      if (!shown.has(instance.id)) continue;
      const raw: string | undefined = subjects.regard_get(instance.id)?.address;
      if (raw === undefined) continue;
      const kind: string | null = paneKind_get(instance.id);
      if (kind !== 'image' && kind !== 'files') continue;
      // A viewer anchors on the folder with its trailing slash stripped; a
      // browser keeps it — normalise so both light the same series row.
      const address: string = raw.replace(/\/$/, '');
      const entry = lit.get(address) ?? { viewer: false, browser: false };
      if (kind === 'image') entry.viewer = true;
      else entry.browser = true;
      lit.set(address, entry);
    }
    pacsPanel.stage_lit(lit);
  };

  // The tiling tree: presets are the gutter's trees; a feed in view varies
  // home by materializing the DAG pane (files left, DAG right); splits
  // carve the current tree until the next preset resets to givens.
  const layout: LayoutManager = new LayoutManager(
    element_require('layout-root'),
    new Map([
      ...staged.primaries.map((primary: PaneInstance): [string, HTMLElement] => [primary.id, primary.mount]),
      ['files', filesPrimary.mount],
      ['launcher', launcherMount],
      ['panes', panesMount],
    ]),
  );
  let dagShown: boolean = false;
  const homeTree = (): LayoutNode =>
    dagShown
      ? {
          dir: 'col',
          ratio: 0.45,
          first: { pane: 'files' },
          second: { pane: 'dag' },
        }
      : { pane: 'files' };
  layout.preset_register('files', homeTree);
  for (const [name, tree] of staged.presets) layout.preset_register(name, tree);
  // PANES-06 is a full-workspace preset too: the grid of dormant groups.
  layout.preset_register('panes', (): LayoutNode => ({ pane: 'panes' }));
  // The launcher owns the stage as well: it is where a session begins, and
  // what it says is the whole of what is on screen.
  layout.preset_register('launcher', (): LayoutNode => ({ pane: 'launcher' }));
  // Any geometry change (split, close, claim, preset, a settled divider
  // drag) refits the measured canvases once the DOM has settled; a
  // reparented WebGL canvas otherwise keeps its old pixel size.
  layout.renderObserver_set((): void => {
    // The dashboard alone on the screen lasts only while it holds the
    // stage: whatever takes the stage (a gutter, a numeral, a typed verb)
    // gets the full surface back.
    if (document.body.dataset['zoom'] === 'launcher' && !layout.panes_shown().includes('launcher')) consoleZoom_set(null);
    window.requestAnimationFrame((): void => {
      for (const panel of panels.values('dag')) {
        panel.size_fit();
      }
    });
  });

  // Disposes split-born instances the current tree no longer holds; the
  // primaries (the presets' panes) always survive offstage.
  // Groups that have left the stage are not gone: a snapshot of each is kept
  // dormant so the PANES view can bring it back. Rehydrated from the surface's
  // own storage on load — dormant, never onto the stage.
  /**
   * Re-runs the drawer SPLIT pill's spawn: a pane of `binding` split from
   * `parentId` at `dir`/`before`, an `fs` binding wired to follow the parent's
   * regard at the directory level. The one code path the pill and a desktop
   * replay share, so a pill-born pane returns exactly as it was made.
   *
   * @returns The new pane's id, or null when the split failed.
   */
  const pillPane_spawn = (parentId: string, binding: 'view' | 'fs' | 'empty', dir: 'row' | 'col', before: boolean): string | null => {
    const spawned: PaneInstance = binding === 'view' ? instance_spawn('view', parentId)
      : binding === 'fs' ? instance_spawn('files', parentId)
      : instance_spawn('empty');
    if (!layout.leaf_split(parentId, dir, spawned.id, before)) {
      paneInstance_dispose(spawned.id);
      layout.mount_remove(spawned.id);
      return null;
    }
    birth_record(spawned.id, parentId, dir, before, binding);
    if (binding === 'fs') {
      const browser_show = (value: RegardValue): void => {
        const panel: FilesPanel | undefined = panels.get('files', spawned.id);
        if (panel === undefined) return;
        const dirPath: string = value.modelKind === 'fs.file' ? (value.address.replace(/\/[^/]*$/, '') || '/') : value.address;
        rootedListing_show(spawned.id, panel, dirPath);
      };
      subjects.regard_subscribe(spawned.id, browser_show);
      const current: RegardValue | null = subjects.regard_get(parentId);
      if (current !== null) browser_show(current);
    }
    return spawned.id;
  };
  const dormant: DormantRegistry = new DormantRegistry(DORMANT_CAP, localKeyStore());
  // The dormant set is read (and, at slice 3, restored) by the PANES view.
  // Exposed for verification until that view exists.
  Object.assign(globalThis as Record<string, unknown>, {
    __argusDormant: {
      list: (): GroupSnapshot[] => dormant.list(),
      get: (id: string): GroupSnapshot | undefined => dormant.get(id),
      dismiss: (id: string): boolean => dormant.dismiss(id),
    },
  });

  /**
   * The desktop: the stage captured as a script of console lines, and
   * replayed (app/desktop.ts). The host's open verbs are its hooks.
   */
  const desktop: Desktop = desktop_wire(context, {
    image_open,
    dir_open,
    process_open,
    gather_open,
    feed_open,
    edit_open: (path: string): string | null => editorModule.edit_open(path),
    pillPane_spawn,
    pacsQuery_get: (): string | null => pacsPanel.query_get(),
    catalogue_find: (paneId: string): CatalogueBinding | undefined => catalogueBindings.get(paneId),
    catalogueIds: (): string[] => [...catalogueBindings.keys()],
    stage_relight: (): void => pacsStage_relight(),
  });
  const { birth_record, domain_enter, orphans_dispose } = desktop;
  const stageDesktop_capture = desktop.capture;
  const group_restore = desktop.restore;

  const home_apply = (): void => {
    domain_enter('files');
    dagPanel.size_fit();
  };

  /**
   * The launcher is the EMPTY state, so the moment anything opens it is no
   * longer the truth: content arriving (a viewer, a browser, a catalogue)
   * takes the stage back to home, where a pane has somewhere to live. A
   * pane spawned against a stage that holds only the launcher has no host
   * and lands nowhere, which reads as a press that did nothing.
   */
  /** Opens the launcher: the domain a session begins in, and returns to. */
  const launcher_enter = (): void => {
    domain_enter('launcher');
    launcherPanel.render();
    layout.focus_set('launcher');
    // The dashboard stands alone on the screen: no header, no gutter, no
    // console, until a press opens something to frame.
    consoleZoom_set('launcher');
  };

  /** The dashboard alone on the screen steps aside for the full surface. */
  /**
   * The dashboard alone on the screen steps aside. A press on a block opens
   * only what it names: the gutter comes back, the header stays folded away
   * and the console closed — most people never need either, and the strip
   * and CONSOLE-05 are there for those who do (the CONSOLE block opens it).
   * Esc, the operator's own way out, gives the whole surface back.
   *
   * @param quiet - True for a block's press: header away, console closed.
   */
  const landing_leave = (quiet: boolean = false): void => {
    if (document.body.dataset['zoom'] !== 'launcher') return;
    consoleZoom_set(null);
    if (!quiet) return;
    const header: HTMLElement | null = document.querySelector<HTMLElement>('.wrap:not(#gap)');
    if (header !== null) headerHeight_track(header, document.body);
    document.body.dataset['header'] = 'away';
    consoleClosed_set?.(true);
  };

  const launcher_yield = (): void => {
    landing_leave();
    if (layout.activePreset_get() !== 'launcher') return;
    dagShown = false;
    home_apply();
  };

  /**
   * What the launcher's blocks say, asked of the kernel at paint time.
   *
   * Cache-resident reads only: the roster the RUNS pane already keeps, a
   * listing of home, and the dormant set the surface holds itself. A first
   * screen that costs a visit to CUBE is a first screen that opens slowly.
   *
   * @returns The blocks, the one with most to say first.
   */
  // Whether the daemon's own code on disk has moved since it started (the
  // attach ack says, and the push after): the dashboard's WHAT'S NEW block
  // then reads AFTER RESTART, since the notes it shows are the running daemon's.
  let daemonStale: boolean = false;
  const launcherTiles_build = dashboardTiles_build({
    ask: (line: string): Promise<ExecuteOutcome> => client.line_execute(line, { silent: true, observe: false }),
    home_open: (): void => { dagShown = false; home_apply(); layout.focus_set('files'); },
    home_cd: (path: string): void => { dagShown = false; home_apply(); terminal.line_run(`cd "${path}"`); },
    desktops: (): GroupSnapshot[] => dormant.list(),
    desktop_restore: (id: string): void => { void group_restore(id); },
    panes_open: (): void => { domain_enter('panes'); panesPanel.render(); layout.focus_set('panes'); },
    keys_open: (): void => { help_open(); },
    notes_open: (): void => { notesPane.open(); },
    notes_latest: (): Promise<SessionNotes | null> => notesPane.latest(),
    daemon_stale: (): boolean => daemonStale,
    console_open: (): void => element_require('gutter-console').click(),
    // ANALYSES, PACS and the UNIVERSE: the composition's tiles (compositions/chris/tiles.ts).
    ...(!chris ? {} : { contribution: chrisTiles_make({
      ask: (line: string): Promise<ExecuteOutcome> => client.line_execute(line, { silent: true, observe: false }),
      universe_show: (): void => universe_show(),
      runs_show: (filter?: string): void => runs_show(filter),
      feed_enter: (feedId: number): void => { runs_show(); panels.get('dag', 'dag')?.feed_enter(feedId); },
      line_offer: (line: string): void => terminal.line_offer(line),
      pacs_query: (): string => pacsPanel.query_get() ?? '',
      pacs_open: (): void => { domain_enter('pacs'); layout.focus_set('pacs'); },
      // CLOUD runs the console's own line, so the door asks the same question pressed or typed.
      cloud_enter: door_isPresent(window.location.search) ? (): void => { element_require('gutter-console').click(); terminal.line_run('stratus oci'); } : null,
    }) }),
    // OPENSHIFT and CAPACITY: the stratus composition's tiles (compositions/stratus/tiles.ts).
    ...(backend !== 'stratus' ? {} : { contribution: stratusTiles_make({
      ask: (line: string): Promise<ExecuteOutcome> => client.line_execute(line, { silent: true, observe: false }),
      cluster_open: (name: string): void => { void tdController.open(name); },
      home_open: (): void => { dagShown = false; home_apply(); layout.focus_set('files'); },
      line_run: (line: string): void => { element_require('gutter-console').click(); terminal.line_run(line); },
      capacity_open: (family: string): void => { capacityPane.open(family); },
      names_seen: (names: string[]): void => clusterNames_seen(names),
      repaint: (): void => launcherPanel.render(),
    }) }),
  });

  const launcherPanel: LauncherPanel = new LauncherPanel(launcherMount, {
    tiles: launcherTiles_build,
    leave: (): void => landing_leave(true),
    startHere_get: landing_isLauncher,
    startHere_set: landing_set,
  });
  // A dashboard read once is a dashboard that lies by the time it is read.
  // It re-asks on its own beat while it is the thing on screen, and asks
  // nothing at all when it is not — the roster's own rule, and the defect
  // the roster was carrying this morning.
  setInterval((): void => {
    if (layout.activePreset_get() !== 'launcher') return;
    if (!launcherMount.isConnected || document.visibilityState !== 'visible') return;
    launcherPanel.render();
  }, DASHBOARD_TICK_MS);

  // The desktop cards scroll without a scrollbar and say what they hold.
  more_wire(pane_find(panesMount, '.panes-body'), { rows: '.panes-card' });
  const panesPanel: PanesPanel = new PanesPanel(panesMount, {
    list: (): GroupSnapshot[] => dormant.list(),
    restore: (id: string): void => { void group_restore(id); },
    dismiss: (id: string): void => { dormant.dismiss(id); },
  });
  const dag_summon = (): void => {
    const preset: string = layout.activePreset_get();
    // A preset that owns the whole workspace is the operator's own choice,
    // and the launcher owns it as PACS and RUNS do: a feed coming into view
    // must not paint a graph over the screen they are reading.
    if (preset === 'pacs' || preset === 'dag' || preset === 'launcher') {
      // A full-workspace preset is the operator's choice; the summon only
      // notes that home should include the DAG when they return to it.
      dagShown = true;
      return;
    }
    if (dagShown && preset === 'files') return;
    dagShown = true;
    home_apply();
  };

  // Creates a fresh pane instance, registered and chromed for the tree. A
  // pane spawned from another's drawer inherits the parent's link group —
  // the semantic tracing; otherwise it starts a group of its own. A viewer
  // marks itself and subscribes here, after joining, so the retained cell
  // replays immediately.
  const instance_spawn = (kind: PaneKind, inheritFrom?: string): PaneInstance => {
    const instance: PaneInstance = paneInstance_create(kind);
    subjects.pane_join(
      instance.id,
      inheritFrom !== undefined ? subjects.group_resolve(inheritFrom) : instance.id,
    );
    if (kind === 'tags') {
      subjects.regard_subscribe(instance.id, (value: RegardValue): void => {
        if (value.modelKind === 'dicom.instance') tagsPane_follow(instance.id, value.address);
      });
    }
    if (kind === 'view') {
      subjects.viewer_mark(instance.id);
      subjects.regard_subscribe(instance.id, (value: RegardValue): void => {
        // A DICOM instance is the tags pane's regard; a text viewer would
        // only cat its bytes.
        if (value.modelKind === 'dicom.instance') return;
        panels.get('view', instance.id)?.regard_show(value);
      });
    }
    layout.mount_register(instance.id, instance.mount);
    pane_chrome_wire(instance.id, kind, instance.mount);
    return instance;
  };

  // Wires one pane's chrome under the machinery-behind-the-frame rule: at
  // rest the pane shows only work and state; clicking the header (the
  // frame) toggles the pane drawer, which holds the layout verbs and the
  // kind's semantic children (docs/aegis.adoc).
  /** The timers of controls' answers holding a pane's bar, by bar. */
  // The verbs on a pane as a thing on the stage, wired to this host (app/paneVerbs.ts).
  const { bar_note: paneBar_note, move: pane_move, flip: pane_flip, resize: pane_resize, chordKeys_format } = paneVerbs_wire(context);
  /**
   * A pane's chrome (app/paneChrome.ts): the drawer behind its handle and
   * the children its kind adds. The pane verbs, the browser, the pill
   * spawn, the opens and the home are its hooks.
   */
  const pane_chrome_wire = paneChrome_wire(context, {
    verbs: { move: pane_move, chordKeys_format },
    browser,
    pillPane_spawn,
    process_open: (fromId: string, binding: CatalogueBinding): void => process_open(fromId, binding),
    overlay_back: (paneId: string): void => nodeOverlay.back(paneId),
    home_apply: (): void => home_apply(),
    orphans_dispose: (): void => orphans_dispose(),
    dag_dismiss: (): void => { dagShown = false; },
  });
  pane_chrome_wire('files', 'files', filesPrimary.mount);
  for (const primary of staged.primaries) pane_chrome_wire(primary.id, primary.kind, primary.mount);
  pane_chrome_wire('launcher', 'launcher', launcherMount);
  pane_chrome_wire('panes', 'panes', panesMount);

  // Keyboard machinery, tmux-shaped: Ctrl-B is the prefix — it opens the
  // focused pane's drawer with keyboard focus on its first verb (Tab walks,
  // Enter fires); Esc closes any open drawer before anything else claims it.
  // Focus citizenship: the console is a pane for the prefix key's
  // purposes. The operator's last touch decides — console area in,
  // workspace tree out.
  let consoleFocused: boolean = false;
  const consoleFocused_set = (value: boolean): void => { consoleFocused = value; };
  for (const eventName of ['click', 'focusin'] as const) {
    document.addEventListener(eventName, (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('#drawer') !== null) consoleFocused = true;
      else if (event.target.closest('#layout-root') !== null) consoleFocused = false;
    });
  }

  const drawers_close = (): boolean => {
    let closed: boolean = false;
    for (const drawer of document.querySelectorAll<HTMLElement>('.pane-drawer:not([hidden])')) {
      drawer.hidden = true;
      closed = true;
    }
    return closed;
  };
  // The mode frame is transient chrome like a drawer: a frame that got out
  // of the way leaves a strip; the strip brings it back; the field (or
  // Esc) sends it away again. One retraction grammar, header and pane: the
  // band's field hosts its own frame (`data-frame-host`) and retracts with
  // the panes' — Esc once left the cohort row standing lit in the band
  // while every pane's row stood down.
  const modeFrames_close = (): boolean => {
    let closed: boolean = false;
    for (const pane of document.querySelectorAll<HTMLElement>('.workspace-pane[data-modes="open"], [data-frame-host][data-modes="open"]')) {
      delete pane.dataset['modes'];
      closed = true;
    }
    // The PACS server strip is the same gesture wearing the form's clothes:
    // a band that unfolds from a cell and retracts to the field or to Esc.
    // It retracts with the frames so there is one grammar, not two.
    if (pacsPanel.serverStrip_isOpen()) {
      pacsPanel.serverStrip_close();
      closed = true;
    }
    return closed;
  };
  document.addEventListener('click', (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    // A block inside the bar acts; the bar's plain fill (or the spine
    // itself, open) retracts it.
    if (event.target.closest('.mode-frame') !== null && event.target.closest('.mode-fill') === null) return;
    // The server cell and its strip act on their own clicks; letting the
    // document's retraction see them would close the strip with the very
    // press that opened it.
    if (event.target.closest('#pacs-server-strip') !== null
      || event.target.closest('#pacs-f-server') !== null) return;
    // A row of a listing whose verbs ride the frame is the frame's other
    // half: touching one puts its verbs there and opens the frame, and
    // the field's retraction must not close what the same press opened.
    // The façade retracts it when the row stands down. A question on the pane is not the field either.
    if (event.target.closest('.listing-framed .listing-row, .ask-bar') !== null) return;
    const strip: HTMLElement | null = event.target.closest<HTMLElement>('.mode-strip');
    const pane: HTMLElement | null = strip?.closest<HTMLElement>('.workspace-pane, [data-frame-host]') ?? null;
    const wasOpen: boolean = pane?.dataset['modes'] === 'open';
    const closedAny: boolean = modeFrames_close();
    if (strip !== null && pane !== null && !wasOpen) {
      pane.dataset['modes'] = 'open';
      sound_play('audio3');
      return;
    }
    if (closedAny) sound_play('audio3');
  });
  /**
   * The keys the stage answers (app/keys.ts): Esc one level a press, the
   * prefix chords, the prefix itself. The command line, the errand, the
   * dives and the chrome are its hooks; the ones declared further down are
   * read when a key is pressed.
   */
  keys_wire(context, {
    palette_isOpen: (): boolean => !palette.hidden,
    palette_open: (): void => palette_open(),
    palette_close: (): void => palette_close(),
    errand_abandon: (): boolean => asks.errand_abandon(),
    dive_leave: (): boolean => binView.dive_leave(),
    overlay_escape: (): boolean => nodeOverlay.escape(),
    drawers_close,
    modeFrames_close,
    consoleFocused: (): boolean => consoleFocused,
    console_release: (): void => consoleFocused_set(false),
    verbs: { bar_note: paneBar_note, flip: pane_flip, resize: pane_resize },
    host: (): ArgusHost => argusHost,
    stage_alone: (paneId: string): void => {
      stageDesktop_capture();
      layout.tree_set({ pane: paneId });
      orphans_dispose();
    },
    element_require,
  });

  // A claimed empty pane becomes what its command projected.
  // Where a model goes: the frame's router, filled by the session's
  // composition (ChRIS: RUNS, the universe, PACS, DICOM images and tags).
  const router: ModelRouter = new ModelRouter();
  /** Turns an empty pane into a new pane of a kind. */
  const pane_replace = (emptyId: string, kind: PaneKind): PaneInstance => {
    const instance: PaneInstance = instance_spawn(kind);
    layout.leaf_replace(emptyId, instance.id);
    paneInstance_dispose(emptyId);
    layout.mount_remove(emptyId);
    return instance;
  };
  // A listing claims an empty pane as files: the frame's own.
  router.claim_add('fs.listing', 'files');
  if (chris) chrisRoutes_install(router, {
    dag_target: (): DagPanel => {
      const focused: string | null = layout.focused_get();
      return focused !== null && panels.has('dag', focused) ? (panels.get('dag', focused) as DagPanel) : dagPanel;
    },
    dags: (): DagPanel[] => [dagPanel, ...panels.values('dag')],
    universes: (): UniversePanel[] => panels.values('universe'),
    pacs: (): PacsPanel => pacsPanel,
    pacs_present: (): void => {
      layout.preset_apply('pacs');
      orphans_dispose();
    },
    image_open: (path: string, force: boolean): void => {
      void image_open(layout.focused_get(), path, force ? { force: true } : {})
        .then((line: string): void => terminal.line_note(line));
    },
    pane_replace: (emptyId: string, kind: 'dag' | 'image' | 'tags'): string => pane_replace(emptyId, kind).id,
    cohort_adopt: (envelope: WireEnvelope): void => cohortModule.envelope_observe(envelope),
    dag_get: (id: string): DagPanel | undefined => panels.get('dag', id),
    image_get: (id: string): ImagePanel | undefined => panels.get('image', id),
    tags_get: (id: string): TagsPanel | undefined => panels.get('tags', id),
  });

  const pane_claim = (emptyId: string, kind: PaneKind, envelopes: WireEnvelope[]): void => {
    const claimer: PaneClaim | undefined = router.claimer_get(kind);
    if (claimer !== undefined) {
      claimer(emptyId, envelopes);
      return;
    }
    const instance: PaneInstance = pane_replace(emptyId, kind);
    const panel: FilesPanel | undefined = panels.get('files', instance.id);
    for (const envelope of envelopes) {
      panel?.envelope_observe(envelope);
    }
  };

  // The HELP pane and the editor: modules of their own (app/helpPane.ts, app/editor.ts).
  const paneHooks: HelpPaneHooks = { instance_spawn, birth_record, launcher_yield, launcher_active: (): boolean => layout.activePreset_get() === 'launcher', template_stamp };
  const helpPane: HelpPaneModule = helpPane_wire(context, paneHooks);
  const help_open: () => string = helpPane.open;
  const gamesPane: GamesPaneModule = gamesPane_wire(context, paneHooks);
  // trek takes the screen: a program over ARGUS, given back when the game ends.
  const trekBridge: TrekBridgeModule = trekBridge_wire(context);
  // `cluster` in a stratus session takes the screen as the controller, given back on LEAVE (app/tdController.ts).
  // The clusters each read finds (the controller's, or the OPENSHIFT tile's paint) are claimed, so `cluster <name>` opens on one; the daemon is told the claims again.
  function clusterNames_seen(names: string[]): void {
    if (clusterClaims_set(names)) context.client.claims_send(claims_list());
  }
  const tdController: TdControllerModule = tdController_wire(context, (names: string[]): void => clusterNames_seen(names));
  const notesPane: NotesPaneModule = notesPane_wire(context, { ...paneHooks, ask: (line: string): Promise<ExecuteOutcome> => client.line_execute(line, { silent: true }) });
  // CAPACITY: what the region has free, as a pane (app/capacityPane.ts, #1284).
  const capacityPane: CapacityPaneModule = capacityPane_wire(context, { ...paneHooks, ask: (line: string): Promise<ExecuteOutcome> => client.line_execute(line, { silent: true }) });
  const editorModule: EditorModule = editor_wire(context, { ...paneHooks, replayPlace_get: desktop.replayPlace_get, errandHost_find, saved: (): void => { for (const dag of panels.values('dag')) dag.marks_refresh(); } });
  paneFactory_register('files', (id: string): PaneInstance => filesInstance_build(id, false));
  paneFactory_register('catalogue', (id: string): PaneInstance => filesInstance_build(id, false, true));
  paneFactory_register('view', viewInstance_build);
  paneFactory_register('help', helpPane.instance_build);
  paneFactory_register('games', gamesPane.instance_build);
  paneFactory_register('notes', notesPane.instance_build);
  paneFactory_register('capacity', capacityPane.instance_build);
  paneFactory_register('edit', editorModule.instance_build);
  for (const [kind, build] of staged.factories) paneFactory_register(kind, build);
  paneFactory_register('empty', (id: string): PaneInstance => {
    const mount: HTMLElement = template_stamp('tpl-pane-empty');
    new EmptyPanel(mount, {
      execute: (line: string): Promise<ExecuteOutcome> =>
        client.line_execute(line, { silent: true, observe: false }),
      claim: (kind: PaneKind, envelopes: WireEnvelope[]): void => pane_claim(id, kind, envelopes),
      claimKind_find: (modelKind: string): PaneKind | undefined => router.claimKind_find(modelKind),
    });
    return { id, kind: 'empty', mount };
  });

  // The left gutter dismisses from its own edge, as the header does from the
  // top: a press on the domain ALREADY shown sends the gutter off stage left
  // (data-gutter='away'), handing its width to the workspace — a focus of the
  // whole field, distinct from a single-pane zoom. A press that would NAVIGATE
  // stays deterministic (the gutter law); only a press on the current domain
  // toggles the chrome away. The pulsing left strip, or Esc, restores it.
  const gutterAway_set = (away: boolean): void => {
    if (away) document.body.dataset['gutter'] = 'away';
    else delete document.body.dataset['gutter'];
    sound_play('audio3');
  };
  const domainPress = (preset: string, navigate: () => void): void => {
    // Already there means the domain's own pane is on stage, not only that
    // its preset was the last applied: KEYS opened from the dashboard
    // stands in home's place, and FILES-02 then sent the gutter away
    // instead of bringing the files back. (Each preset's primary pane
    // shares its name.)
    if (layout.activePreset_get() === preset && layout.panes_shown().includes(preset)) {
      gutterAway_set(true);
      return;
    }
    if (document.body.dataset['gutter'] === 'away') delete document.body.dataset['gutter'];
    navigate();
  };
  element_require('gutter-restore').addEventListener('click', (): void => gutterAway_set(false));
  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    // Esc restores the gutter, after a zoom but before the header (one layer
    // per press): the gutter is the middle chrome layer.
    if (event.key === 'Escape' && document.body.dataset['gutter'] === 'away' && document.body.dataset['zoom'] === undefined) {
      gutterAway_set(false);
    }
  });

  // FILES-01: home. RUNS-02: home + the feed chooser. PACS-03: toggles the
  // PACS tree against home.
  element_require('gutter-files').addEventListener('click', (): void => {
    // A gutter press is a preset declaration and must be deterministic:
    // FILES-01 always yields the full files pane. The DAG rejoins home only
    // when a feed next comes into view (the summon), never as leftovers.
    domainPress('files', (): void => {
      dagShown = false;
      home_apply();
      layout.focus_set('files');
      consoleFocused_set(false);
    });
  });
  /**
   * RUNS-02's gesture, as a function: the DAG takes the whole workspace and
   * lands on the feed list, a graph retained from an earlier visit dismissed
   * before the roster paints. With a filter, the roster opens filtered.
   *
   * @param filter - A roster filter to apply, or none.
   */
  const runs_show = (filter: string = ''): void => {
    domain_enter('dag');
    dagPanel.stage_returned(); // the device's feed memory again (a-feed-has-one-view)
    dagPanel.list_reset();
    dagPanel.roster_filter(filter);
    dagPanel.feedsChooser_request();
    layout.focus_set('dag');
    consoleFocused_set(false);
  };
  // The UNIVERSE takes the stage: its own preset, its one primary pane,
  // raised whole and asked for the space. Never the RUNS pane: that stays
  // a feed viewer.
  const universe_show = (): void => {
    domain_enter('universe');
    const panel: UniversePanel | undefined = panels.get('universe', 'universe');
    if (panel !== undefined && !panel.shown_get()) panel.request();
    panel?.stage_returned(); // inside a feed, the device's memory again (a-feed-has-one-view)
    layout.focus_set('universe');
    consoleFocused_set(false);
  };
  element_require('gutter-runs').addEventListener('click', (): void => domainPress('dag', (): void => runs_show()));
  // CONSOLE-05: a given always renders its target — the console open with
  // the prompt live; never a toggle (the lid and the drawer's CLOSE retract).
  element_require('gutter-console').addEventListener('click', (): void => {
    if (element_require('drawer').classList.contains('drawer-closed')) {
      element_require('drawer-toggle').click();
    }
    terminal.focus_take();
    consoleFocused_set(true);
  });
  element_require('gutter-tools').addEventListener('click', (): void => {
    // Navigating to PACS is deterministic; pressing it while already there
    // sends the gutter away (the field focus), not a re-render.
    domainPress('pacs', (): void => {
      domain_enter('pacs');
      layout.focus_set('pacs');
      consoleFocused_set(false);
    });
  });
  element_require('gutter-dashboard').addEventListener('click', (): void => {
    // DASHBOARD-04 is the way back to where a session begins. Pressing it
    // while already there sends the gutter away, as every domain does.
    domainPress('launcher', launcher_enter);
  });
  element_require('gutter-panes').addEventListener('click', (): void => {
    // Opening PANES captures the current arrangement as a desktop card (the
    // chokepoint), free and recoverable, then draws the grid. Pressing PANES
    // while already there sends the gutter away instead.
    domainPress('panes', (): void => {
      domain_enter('panes');
      panesPanel.render();
      layout.focus_set('panes');
      consoleFocused_set(false);
    });
  });

  // ------------------------------------------------------------ the language
  // Every gesture as a sentence (docs/aegis.adoc: the argus language). The
  // host hands the language the same controls the mouse uses.
  const paneKind_get = (id: string): PaneKind | null => paneInstance_get(id)?.kind ?? null;
  /**
   * The console language's host (app/consoleHost.ts): what a typed sentence
   * may do to the stage, built from the same controls the mouse uses.
   */
  const argusHost: ChrisLangHost = argusHost_build(context, {
    verbs: { move: pane_move, flip: pane_flip, resize: pane_resize },
    help_open,
    notes_open: notesPane.open,
    capacity_open: capacityPane.open,
    launcher_enter,
    // `trek` on the command line (either console): the bridge takes the screen and gives it back when the game ends.
    trek_open: (line: string): string => {
      if (trekBridge.active_is()) return 'trek: the bridge is already up';
      void trekBridge.open(line);
      return 'trek: the bridge takes the screen (Esc or LEAVE BRIDGE gives it back)';
    },
    identity_get: (): string | null => promptIdentity,
    consoleZoom_toggle,
    feed_enter: (feedId: number): void => dagPanel.feed_enter(feedId),
    file_save,
    stage_keep: (): void => stageDesktop_capture(),
    files_open: (paneId: string, path: string): boolean => {
      const panel: FilesPanel | undefined = panels.get('files', paneId);
      if (panel === undefined) return false;
      browser.follow_set(paneId, false);
      rootedListing_show(paneId, panel, path);
      return true;
    },
    image_open: (paneId: string | null, path: string, options: { force?: boolean }): Promise<string> => image_open(paneId, path, options),
    series_ask,
    tagsPane_open,
  });

  // The command line: prefix-: (tmux tradition) or the LANG capsule. One
  // floating line; sentences run client-side, anything else falls through
  // to the session console with full echo.
  const palette: HTMLElement = element_require('lang-palette');
  const paletteInput: HTMLInputElement = element_require('lang-input') as HTMLInputElement;
  const paletteResult: HTMLElement = element_require('lang-result');
  const langPill: HTMLElement = element_require('lang-pill');
  const palette_open = (): void => {
    drawers_close();
    palette.hidden = false;
    langPill.classList.add('lang-live');
    paletteResult.textContent = '';
    paletteInput.value = '';
    paletteInput.focus();
    sound_play('audio3');
  };
  const palette_close = (): void => {
    palette.hidden = true;
    langPill.classList.remove('lang-live');
    paletteResult.textContent = '';
  };
  // LCARS has no keyboard: the gutter given is a show/remove toggle, and
  // it wears a lit dress while the line is on stage.
  langPill.addEventListener('click', (): void => {
    if (palette.hidden) palette_open();
    else palette_close();
  });
  const LANG_SUBJECT_WORDS: string[] = [
    'pane', 'view', 'runs', 'node', 'dag', 'file', 'pacs', 'header', 'console', 'back', 'desktop', 'argus', 'help', 'notes', 'capacity',
  ];
  const LANG_FOLLOWERS: Record<string, string[]> = {
    pane: ['split', 'zoom', 'close', 'bind', 'claim', 'focus', 'flip', 'resize'],
    resize: ['left', 'right', 'up', 'down'],
    help: ['keys', 'verbs'],
    notes: ['pane'],
    capacity: ['pane'],
    focus: ['left', 'right', 'up', 'down', 'last'],
    view: ['files', 'runs', 'pacs'],
    runs: ['enter', 'sort', 'filter'],
    node: ['enter', 'immerse', 'back', 'clear'],
    dag: ['layout', 'projection', 'scale', 'hue', 'draw', 'pulse', 'census', 'gravity', 'select', 'enter', 'physics', 'refresh'],
    draw: ['spheres', 'stars'],
    pulse: ['on', 'off'],
    census: ['on', 'off'],
    gravity: ['on', 'off'],
    physics: ['charge', 'link', 'collide', 'gravity', 'reset'],
    file: ['home', 'back', 'download', 'delete', 'sort', 'filter', 'follow', 'root', 'list', 'cards', 'preview'],
    // The session owns most of `pacs`; the surface claims sort and filter.
    pacs: ['sort', 'filter', 'connect', 'disconnect', 'list', 'query', 'pull', 'status'],
    header: ['stats', 'dag', 'away', 'restore'],
    console: ['open', 'close', 'toggle', 'zoom', 'height'],
    desktop: ['save', 'load', 'show', 'list', 'delete', 'clear', 'share'],
    split: ['left', 'right', 'above', 'below'],
    bind: ['unlinked', 'fs', 'viewer'],
    claim: ['files', 'runs', 'pacs'],
    layout: ['ranked', 'molecule'],
    projection: ['2d', '3d'],
    scale: ['time', 'size'],
    hue: ['status', 'compute'],
    argus: ['verbs'],
  };
  paletteInput.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      palette_close();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const words: string[] = paletteInput.value.split(/\s+/);
      const prefix: string = words[words.length - 1] ?? '';
      const context: string = words.length <= 1 ? '' : (words[words.length - 2] ?? '');
      const pool: string[] = words.length <= 1
        ? LANG_SUBJECT_WORDS
        : LANG_FOLLOWERS[context] ?? LANG_FOLLOWERS[words[0] ?? ''] ?? [];
      const match: string | undefined = pool.find((word: string): boolean => word.startsWith(prefix.toLowerCase()));
      if (match !== undefined) {
        words[words.length - 1] = match;
        paletteInput.value = `${words.join(' ')} `;
      }
      return;
    }
    if (event.key === 'Enter') {
      const line: string = paletteInput.value.trim();
      if (line.length === 0) { palette_close(); return; }
      void argusLine_run(argusHost, line).then((result: string | null): void => {
        if (result !== null && (trekBridge.active_is() || tdController.active_is())) {
          // The sentence gave the screen to a program (trek's bridge): the command line
          // stands down, or its Esc would take the one meant for the bridge.
          terminal.output_write('data', `: ${line}\n${result}\n`);
          palette_close();
        } else if (result !== null) {
          paletteResult.textContent = result;
          terminal.output_write('data', `: ${line}\n${result}\n`);
          paletteInput.value = '';
          paletteInput.select();
        } else {
          // Not an argus sentence: the session console takes it, visibly.
          palette_close();
          terminal.line_run(line);
        }
      });
    }
  });

  // Boot: the launcher for a browser that has never chosen otherwise (a
  // first screen that answers where am I, what can I do, what next), else
  // the arrangement this browser last had.
  if (landing_isLauncher()) {
    layout.preset_apply('launcher');
    launcherPanel.render();
  } else {
    // A preset this composition has not got (RUNS, last seen under ChRIS) is home.
    const saved: string | null = layout.savedPreset_get();
    layout.preset_apply(saved !== null && layout.preset_has(saved) ? saved : 'files');
  }

  const drawerStatus: HTMLElement = element_require('drawer-status');
  const mode_show = (mode: string): void => {
    drawerStatus.textContent = `MODE: [${mode}]`;
  };

  // The browser wears the console's listing colours by token; the console
  // says what they are.
  consolePalette_publish(document.documentElement);
  const terminal: ArgusTerminal = new ArgusTerminal(
    element_require('terminal'),
    async (line: string): Promise<void> => {
      // The argus language claims its reserved subjects client-side; the
      // sentence never touches the wire.
      // `clear` empties the transcript, as clear(1) empties a terminal.
      if (line.trim() === 'clear') {
        terminal.clear();
        terminal.prompt_draw();
        mode_show('READY');
        return;
      }
      const local: string | null = await argusLine_run(argusHost, line);
      if (local !== null) {
        terminal.output_write('data', `${local}\n`);
        // No wire round-trip means no promptline push: the console must
        // unlock itself or every following line queues forever.
        terminal.prompt_draw();
        mode_show('READY');
        return;
      }
      // A game of trek takes the screen: the bridge runs the command and
      // answers its questions; the transcript keeps the game's text.
      if (trekLine_isGame(line)) {
        mode_show('BUSY');
        terminal.line_note('trek: the bridge takes the screen (Esc or LEAVE BRIDGE gives it back)');
        await trekBridge.open(line);
        mode_show('READY');
        terminal.prompt_draw();
        return;
      }
      mode_show('BUSY');
      const startedAt: number = performance.now();
      try {
        const outcome: ExecuteOutcome = await client.line_execute(line);
        terminal.outcome_write(outcome);
        consoleModels_take(outcome.envelopes);
      } catch (error: unknown) {
        const reason: string = error instanceof Error ? error.message : String(error);
        terminal.output_write('err', `\x1b[31m${reason}\x1b[0m\n`);
      }
      progress.clear();
      statusBar.activity_clear();
      // The felt latency, measured: command round-trip in the MODE strip.
      mode_show(`READY ${Math.round(performance.now() - startedAt)}ms`);
      terminal.prompt_draw();
    },
    (prefix: string) => client.line_complete(prefix),
  );

  // A page older than the build it is served from says so, once, when it
  // asks for a chunk the server no longer has.
  stalePage_watch((line: string): void => terminal.line_note(line));

  // Progress describes a running command, so nothing it draws may outlive
  // one; the submit handler clears the region once the command settles.
  const progress: ArgusProgress = new ArgusProgress(
    terminal.progressRegion_get(),
    (text: string): void => terminal.output_write('err', text),
  );
  const restart: RestartControl = restart_wire({ unsaved: (): string[] => [...panels.values('edit')].filter((pane) => pane.dirty_is()).map((pane) => pane.path_get() ?? '?') });
  const buildWatch: BuildWatch = buildMatch_wire(statusBar, (line: string): void => terminal.line_note(line), restart.ask);
  // The console as a terminal (#1125): built once the daemon says it offers
  // one and this device chose it (consoleMode.ts).
  let consoleScreen: TerminalScreen | null = null;
  /**
   * What a console command's answers move beyond the console: `say` speaks,
   * a showpiece or game opens the GAMES pane, a moved working directory
   * re-lists the panel slaved to it. The transcript's own commands, and in
   * terminal mode the ones typed in this page's terminal (their echoes).
   *
   * @param envelopes - The command's envelopes.
   */
  const consoleModels_take = (envelopes: ReadonlyArray<WireEnvelope>): void => {
    for (const envelope of envelopes) {
      // `say`: a surface with a voice speaks the words (games shelf, #892).
      if (envelope.model?.kind === 'games.say') voice_say(envelope.model.data);
      // A showpiece or a game: a terminal console plays it in place (its
      // chell takes the screen); `--pane`, or the transcript, which has no
      // screen to play on, runs it in the GAMES pane.
      if (envelope.model?.kind === 'games.show') {
        const pane: boolean = (envelope.model.data as { pane?: boolean } | undefined)?.pane === true;
        if (pane || consoleMode === null || !consoleMode.terminal_is()) terminal.line_note(gamesPane.show(envelope.model.data));
      }
    }
    // The panel is slaved to the working directory: any command that
    // moved it (an fs.cwd model) triggers a silent listing refresh,
    // whose fs.listing envelope repaints the panel on observation.
    if (envelopes.some((envelope): boolean => envelope.model?.kind === 'fs.cwd')) {
      void client.line_execute('ls', { silent: true });
    }
  };
  const attached: { client: ArgusClient; attach: AttachInfo } = await ArgusClient.session_attach(
    wsUrl_resolve(),
    token,
    {
      output_receive: (channel: OutputChannel, chunk: string): void => {
        terminal.output_write(channel, chunk);
        if (channel === 'data' && trekBridge.active_is()) trekBridge.output_take(chunk);
        if (channel !== 'status' && tdController.running_is()) tdController.output_take(chunk);
      },
      event_receive: (_id: string, kind: string, data: unknown): void => {
        if (trekBridge.active_is()) trekBridge.event_take(kind, data);
        tdController.event_take(kind, data);
      },
      terminalOpened_receive: (terminalId: string, replay: string, refused: string | undefined): void => consoleScreen?.opened(terminalId, replay, refused),
      terminalData_receive: (terminalId: string, data: string): void => consoleScreen?.data(terminalId, data),
      terminalExit_receive: (terminalId: string, code: number): void => consoleScreen?.exited(terminalId, code),
      progress_receive: (message: ProgressMessage): void => {
        progress.write(message);
        statusBar.progress_observe(message);
        cascade?.progress_observe(message);
        signals.progress_take(message);
      },
      /**
       * A question the session put to this surface.
       *
       * Every kind is answered in the console for now — where the session
       * speaks, and where the scrollback keeps what was asked. A `path`
       * additionally deserves an instrument to walk, which is the next
       * slice; until then it is answerable rather than refused, which is
       * what matters.
       */
      ask_receive: async (request: SurfaceAsk): Promise<string | null> => {
        // The bridge owns the screen and the running command: its game's questions are answered there.
        if (trekBridge.active_is()) return trekBridge.ask(request);
        // The controller's own lines ask on its strip: a build's question before billing, teardown's name typed back.
        if (tdController.running_is()) return tdController.ask(request);
        if (request.kind !== 'path') {
          // A question a PRESSED VERB provoked stands on the pane that was
          // pressed: `rm -i` asks before it removes, and the operator is
          // looking at the row they just acted on, not at the console. The
          // transcript still keeps the exchange either way.
          const provoker: string | null = asks.askingPane_take();
          if (provoker !== null && paneInstance_get(provoker) !== undefined) {
            return askOnPane_await(provoker, {
              message: request.message,
              kind: request.kind === 'secret' ? 'secret' : request.kind === 'confirm' ? 'confirm' : 'text',
              ...(request.suggest === undefined ? {} : { suggest: request.suggest }),
            });
          }
          // A terminal console's chell did not ask it: it stands on a sheet.
          if (consoleMode !== null && consoleMode.terminal_is()) {
            return consoleMode.question_sheet({
              message: request.message,
              kind: request.kind === 'secret' ? 'secret' : request.kind === 'confirm' ? 'confirm' : 'text',
              ...(request.suggest === undefined ? {} : { suggest: request.suggest }),
            });
          }
          // Otherwise the session speaks where it always does. A closed
          // console is a question nobody can see, so asking one exposes it.
          consoleClosed_set?.(false);
          return terminal.ask_open({
            message: request.message,
            kind: request.kind,
            ...(request.suggest === undefined ? {} : { suggest: request.suggest }),
          });
        }
        // A location borrows an instrument. The console still says what was
        // asked, so the scrollback holds the whole exchange rather than the
        // half that happened at the keyboard.
        const noted: (answer: string | null) => void = terminal.ask_note(request.message);
        const answer: string | null = await errand_open(request);
        noted(answer);
        return answer;
      },
      edit_receive: (request: SurfaceEdit): boolean => editorModule.edit_receive(request), // `edit` opens a pane here
      promptline_receive: (context: PromptContext): void => {
        promptUser = context.user;
        // The prompt's own two facts, in the shape every attach line takes.
        promptIdentity = context.uri === '' ? context.user : `${context.user}@${context.uri}`;
        // The smoke suite is argus's only executable verification — there
        // is no unit level here — so the surface exposes the last context
        // it was handed, and a way to re-show one. Read-only to the page.
        Object.assign(globalThis as Record<string, unknown>, {
          __argusPromptContext: context,
          __argusPromptContext_show: (replacement: PromptContext): void =>
            statusBar.promptContext_show(replacement),
        });
        terminal.promptContext_set(context);
        statusBar.promptContext_show(context);
        cascade?.promptContext_observe(context);
        signals.promptContext_take(context);
        for (const panel of panels.values('files')) panel.home_set(context.user === '' ? null : `/home/${context.user}`);
      },
      telemetry_receive: (index: { jobs: number; feeds: number }, extra?: { lane?: LaneTelemetry; cube?: CubeTelemetry; state?: JobsStateTelemetry; surfaces?: SurfaceSeen[] }): void => {
        signals.telemetry_take(index, extra);
        laneInstrument.telemetry_show(extra ?? {});
        statusBar.questions_show(extra?.lane?.questions ?? []);
        restart.telemetry_take(extra);
        cascade?.index_observe(index);
      },
      // A line typed in a chell (a terminal console, or a shell elsewhere on
      // the session) whose subject this language claims: run here, answered there.
      surfaceLine_receive: async (line: string): Promise<{ rendered: string; status: 'ok' | 'error' }> => {
        const answer: string | null = await argusLine_run(argusHost, line);
        if (answer === null) throw new Error('not a line of this surface');
        return { rendered: answer, status: 'ok' };
      },
      session_receive: (surface: string, envelope: WireEnvelope, from?: string): void => {
        terminal.session_write(surface, envelope);
        // A line typed in this page's own terminal is this console's command.
        if (from !== undefined && from === consoleScreen?.terminalId_get()) consoleModels_take([envelope]);
      },
      // The sampler's refreshed models: every DAG pane showing that feed
      // repaints in place; nothing pins, nothing reaches the transcript.
      ambient_receive: (envelope: WireEnvelope): void => {
        // A chime (timer, leave): noted in the console, and spoken.
        if (envelope.model?.kind === 'games.chime') {
          const text: unknown = (envelope.model.data as { text?: unknown } | null)?.text;
          if (typeof text === 'string') { terminal.line_note(`🔔 ${text}`); voice_say({ text }); }
          return;
        }
        // A task's end, or a joblet's (`[1]+ Done  pull …`), or a joblet
        // waiting on an answer: a line in the console, as a shell prints it.
        if (envelope.model?.kind === 'tasks.job' || envelope.model?.kind === 'joblet.waiting') {
          const text: string = envelope.rendered.trim();
          if (text !== '') terminal.line_note(text);
          return;
        }
        if (envelope.model?.kind === 'fs.listing') {
          // A stale listing's refresh: every Files pane showing that path
          // swaps it in and drops its STALE readout.
          filesPanel.ambient_observe(envelope);
          for (const panel of panels.values('files')) panel.ambient_observe(envelope);
          return;
        }
        router.route('ambient', envelope);
      },
      stale_receive: (stale: boolean): void => { daemonStale = stale; buildWatch.stale_take(stale); },
      closing_receive: (cause: ClosingCause): void => restart.closing_take(cause),
      watched_receive: (subject: string, state: WatchState): void => router.watched(subject, state),
      // Which listing the session's numbers count. Every listing's index
      // pills repaint from it, so the rows wearing a number are exactly the
      // rows `@N` reaches — on whichever pane happens to hold them.
      numbered_receive: (numbering: { id: number; source: string; rows: number; handles: Array<{ kind: string; ordinal: number; address: string }> }): void => {
        listingNumbering_set({ source: numbering.source, handles: numbering.handles });
      },
      envelope_observe: (envelope: WireEnvelope): void => {
        // The composition's routes take their models first (ChRIS: a DAG to
        // the focused DAG pane, an image intent to an image pane).
        const kind: string | undefined = envelope.model?.kind;
        if (!router.route('console', envelope)) {
          // A console listing reaches every browser bound to the cwd.
          for (const [paneId, panel] of panels.entries('files')) {
            if (browser.follows(paneId)) panel.envelope_observe(envelope);
          }
          router.observe('console', envelope);
          // A verb that changed a folder does not re-list it: `rm` reports
          // what it removed, `mv` what it moved. A browser showing that
          // folder asks for it again, or it shows rows that are gone —
          // which is the listing lying about the store.
          if (kind === 'fs.rm' || kind === 'fs.mv' || kind === 'fs.cp') {
            for (const [paneId, panel] of panels.entries('files')) {
              const place: string | null = panel.path_current();
              if (place !== null) listing_refresh(paneId, place);
            }
          }
        }
        // Any line's cohort — a press here, a line at a chell — is the
        // kernel's word on it, and the band and the GATHER pane redraw.
        cohortModule.envelope_observe(envelope);
        cycler.envelope_observe(envelope);
      },
      close_handle: (): void => {
        statusBar.connection_show(false);
        cascade?.connection_show(false);
        mode_show('OFFLINE');
      },
    },
  );
  const client: ArgusClient = attached.client;
  // The language's subjects, the composition's included: a line in one typed
  // in any chell on the session is routed here (claims.ts on the daemon).
  client.claims_send(claims_list());
  consoleStop_wire(client, (): string | null => consoleScreen?.terminalId_get() ?? null);
  consoleMode = consoleMode_wire({
    client,
    terminal,
    offered: attached.attach.terminals === true,
    screen_set: (screen: TerminalScreen | null): void => { consoleScreen = screen; },
  });

  statusBar.attach_show(attached.attach);
  daemonStale = attached.attach.stale === true;
  buildWatch.attach_take(attached.attach);
  restart.attach_take(attached.attach);
  statusBar.connection_show(true);
  cascade?.connection_show(true);
  aboutFace_fill(attached.attach);

  // Seed the ambient cycler with the pipelines /bin lists (an unobserved read).
  if (chris) cyclerNames_seed(client, cycler);
  // The browser that follows the session shows the session's place from
  // the first moment: one silent, observed listing of the working
  // directory. (The seed above used to do this by accident, at /bin.)
  void client.line_execute('ls', { silent: true });
  // The launcher's blocks are what the session says it holds, so they are
  // asked for once the session can answer. The paint at boot puts the pane
  // on stage; this fills it.
  if (layout.activePreset_get() === 'launcher') launcherPanel.render();
  // The cohort the session was working on comes back with it. Quietly: the
  // band is not revealed, because restoring is not an act the operator
  // just took — the count on its button is how they learn it is there.
  // The block reads its own state from the first frame: an empty cohort is
  // the same block dimmed, not a lit one promising something it does not
  // hold. The restore below may fill it a moment later.
  cohortStage_run = cohortModule.stage;
  if (chris) {
    cohortModule.annunciate();
    void cohortModule.restore();
  }
  mode_show('READY');
  // The splash is the composition's: ChRIS's brain, stratus's TD mark, or
  // the frame's own line; the tab's mark follows it.
  const stratus: boolean = backend === 'stratus';
  terminal.splash_write(chris ? SPLASH_BRAIN : stratus ? SPLASH_TD : []);
  if (stratus) terminal.line_note('stratus · a session over the cloud substrate a Trusted Domain runs on: the tenancy under /net, the console, the frame');
  else if (!chris) terminal.line_note(`mise · a session over the ${backend} backend: its files, the console, the frame`);
  if (stratus) favicon_set(TD_FAVICON);
  else if (!chris) favicon_set(FRAME_FAVICON);
  terminal.prompt_draw();
  terminal.focus_take();
  // The greeting is the session's to give, beneath the brain; the build notes follow it.
  greeting_ask(client, terminal, SURFACE_NAME, buildWatch.release);

  consoleClosed_set = drawer_wire(
    element_require('drawer'),
    element_require('drawer-strip'),
    element_require('drawer-toggle'),
    terminal,
  );
  // The console joins the drawer grammar: its header is a handle, its
  // drawer carries only the verbs that apply (zoom via the shared
  // data-pane path; CLOSE retracts through the lid's own toggle).
  const consoleDrawer: HTMLElement = element_require('console-drawer');
  element_require('console-handle').addEventListener('click', (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('button') !== null) {
      return;
    }
    consoleDrawer.hidden = !consoleDrawer.hidden;
    if (!consoleDrawer.hidden) {
      consoleDrawer.querySelector<HTMLButtonElement>('button')?.focus();
    }
    sound_play('audio3');
  });
  consoleDrawer.querySelector<HTMLElement>('.console-retract')?.addEventListener('click', (): void => {
    consoleDrawer.hidden = true;
    element_require('drawer-toggle').click();
  });
  consoleZoom_set = zoom_wire(terminal);
  // The console's frame answers a double click as every pane's does: zoom,
  // and again to restore.
  element_require('console-handle').addEventListener('dblclick', (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    window.getSelection()?.removeAllRanges();
    consoleZoom_toggle();
  });
  // The lid closes the console wherever it stands: a zoomed console's
  // height is the zoom's, so the lid first gives the stage back, then its
  // own press closes (CLOSE in the drawer rides this too).
  element_require('drawer-toggle').addEventListener('click', (): void => {
    if (document.body.dataset['zoom'] === 'console') consoleZoom_set(null);
  }, { capture: true });
  // A ChRIS session that begins at the dashboard begins with it alone on the
  // screen. A frame-alone session (stratus, null) begins with the dashboard
  // on stage inside the whole frame: its daemon serves on a fresh port each
  // start, so its browser storage is always a first visit, and a header and
  // console hidden behind a zoom on every start hide the identity and the
  // prompt the session is for. The DASHBOARD gutter still zooms it.
  if (layout.activePreset_get() === 'launcher' && chris) consoleZoom_set('launcher');
  panelSounds_wire();
  window.addEventListener('resize', (): void => terminal.size_fit());
  // SHARE VIEW: the stage as lines a colleague can replay (app/shareView.ts).
  // Assigned, not added: a second attach must not stand two sheets.
  element_require('share-pill').onclick = (): void => { shareSheet_open(viewScript_compose(argusHost.desktop_serialize())); };
  // A link (`url` in chell, LINK on a graph) lands where it points, once:
  // a feed or node in RUNS, anything else in FILES. The fragment is then
  // dropped, so a reload does not land again.
  // A view link offers a colleague's view: its lines are shown and asked
  // about before anything runs (console/argusLang.ts viewScript_run).
  const viewed: string | null = viewLink_parse(window.location.hash);
  if (viewed !== null) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    void viewScript_run(argusHost, viewed, 'a link').then((said: string): void => terminal.line_note(`view: ${said.split('\n').slice(-1)[0] ?? ''}`));
  }
  const landing: LinkLanding | null = viewed !== null ? null : linkLanding_parse(window.location.hash);
  if (landing !== null) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    if (landing.kind === 'runs') {
      runs_show();
      dagPanel.target_jumpTo(landing.target);
    } else {
      dir_open(landing.path);
    }
  }
}

/**
 * Page entry: use the URL token when present, otherwise show the attach
 * form and start on submit.
 */
function page_boot(): void {
  cascade = cascade_build();
  headerFaces_wire();
  headerBand_wire();
  headMenuPill_wire();
  audioPill_wire();
  themePill_wire();
  doorPill_wire();
  const params: URLSearchParams = new URLSearchParams(window.location.search);
  const urlToken: string | null = params.get('token');
  const throughDoor: boolean = door_isPresent(window.location.search);
  const attachForm: HTMLElement = element_require('attach-form');
  const attachError: HTMLElement = element_require('attach-error');

  const start: (token: string) => void = (token: string): void => {
    surface_start(token).then(
      (): void => {
        attachForm.classList.add('attach-hidden');
      },
      (error: unknown): void => {
        attachForm.classList.remove('attach-hidden');
        attachError.textContent = error instanceof Error ? error.message : String(error);
      },
    );
  };

  const tokenInput: HTMLInputElement = element_require('attach-token') as HTMLInputElement;
  element_require('attach-submit').addEventListener('click', (): void => {
    if (tokenInput.value.trim().length > 0) {
      start(tokenInput.value.trim());
    }
  });
  tokenInput.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && tokenInput.value.trim().length > 0) {
      start(tokenInput.value.trim());
    }
  });

  if (urlToken !== null && urlToken.length > 0) {
    // The token rode the URL; go straight to the session without the form.
    attachForm.classList.add('attach-hidden');
    start(urlToken);
  } else if (throughDoor) {
    // A door holds the token and puts it on the attach itself; the page
    // would only be asking for something it is never shown.
    attachForm.classList.add('attach-hidden');
    start('');
  }
}

page_boot();
