/**
 * @file The image pane: a series or a volume on a guest engine's field,
 * inside mise's frame.
 *
 * The field is foreign — an engine draws it and owns every tool behaviour —
 * and the frame is native: one block per library tool, LAYOUT, COLORMAP,
 * SAVE and the FOCUS mark ride the pane's mode frame like every mise
 * control, and nothing sits over the image. The bar reads the slice on
 * screen, what could not be read, and the layout when it is not the
 * default. Every verb the console offers lands on the same methods the
 * blocks press.
 *
 * Focus stays in the field: a click there takes it, keys stay there, Esc
 * gives it back. The FOCUS mark says who has the keyboard.
 *
 * A wait can be stopped where the person is looking: the field's working
 * notice carries a STOP capsule under its track while a series is OPENING
 * (the kernel is being asked what the path is) or LOADING (slices are
 * arriving), and Esc on the frame presses it. A stopped load keeps what
 * arrived and a note in the field's corner says how far it got, with LOAD
 * REST; a stopped open keeps its notice, with OPEN AGAIN. The rail carries
 * the same STOP block. Stopped is a state the person chose, said in the
 * frame's own voice, never as a refusal.
 *
 * @module
 */
import { STALE_PAGE_READOUT, stalePage_is } from '../../app/stalePage.js';
import { barState_set } from '../roster/bar.js';
import type { DicomSeriesModel, DicomTagsModel } from '@fnndsc/menu';
import {
  IMAGE_COLORMAPS,
  IMAGE_TOOLS,
  WINDOW_LEVEL_PRESETS,
  type WindowLevelPreset,
  type ImageColormap,
  type ImageEngine,
  type ImageEngineHost,
  type ImageEngineState,
  type ImageLayout,
  type ImageSource,
  type ImageProgress,
  type ImageTool,
  windowLevelPreset_find,
} from './engine.js';

/** Host callbacks. */
export interface ImagePanelHandlers {
  source: ImageSource;
  /** One line in the console. */
  note: (line: string) => void;
  /** The instance on screen, as this pane's regard. */
  regard: (path: string) => void;
  /** Puts bytes at a CFS path through the surface's own route; resolves to the HTTP status. */
  file_put: (path: string, body: Blob) => Promise<number>;
  /** Opens (or focuses) the tags pane that follows this one. */
  tags_open: () => void;
  /**
   * Reads a DICOM file's tags, for the overlay.
   *
   * The series model says what a series IS; the overlay says whose it is,
   * and only the header knows that.
   */
  tags_read: (path: string) => Promise<DicomTagsModel | null>;
}

/**
 * What a clinical viewer writes in the corner, and the tag behind each.
 *
 * Ordered as it is read rather than as DICOM stores it: who, which study,
 * which series, when. A tag the header does not carry is left out entirely
 * rather than shown empty, since a blank line beside a label reads as a
 * missing VALUE when it usually means a missing tag.
 */
const OVERLAY_FIELDS: ReadonlyArray<{ label: string; tag: string }> = [
  { label: '', tag: 'PatientName' },
  { label: 'MRN', tag: 'PatientID' },
  { label: 'ACC', tag: 'AccessionNumber' },
  { label: '', tag: 'StudyDescription' },
  { label: '', tag: 'SeriesDescription' },
  { label: '', tag: 'StudyDate' },
  { label: '', tag: 'PatientAge' },
  { label: '', tag: 'PatientSex' },
];

/** A sibling series in a study folder, for `image series <n>`. */
export interface SeriesChoice {
  path: string;
  label: string;
}

/** The wait a frame is in, as its STOP block reads it: none is null. */
export type ImageWait = 'opening' | 'loading' | 'stopped';

/** The STOP block's words while a wait can be stopped. */
export const STOP_LABEL: string = 'STOP';
/** The STOP block's words once a load was stopped: pressing it fetches what had not arrived. */
export const RESUME_LABEL: string = 'LOAD REST';
/** The notice's capsule after an open was stopped: pressing it asks again. */
export const REOPEN_LABEL: string = 'OPEN AGAIN';
/** The bar's word for an open the person stopped. */
export const OPENING_STOPPED_READOUT: string = 'STOPPED';

/** Bytes a series may reach before a volume layout waits for LOAD. */
export const VOLUME_GUARD_BYTES: number = 256 * 1024 * 1024;

/** Bytes in the nearest unit, for the bar. */
function bytes_format(bytes: number): string {
  const units: string[] = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value: number = bytes;
  let unit: number = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** The hue a modality wears on the frame. */
function modalityHue_derive(modality: string): string {
  const upper: string = modality.toUpperCase();
  if (upper === 'MR' || upper === 'CT' || upper === 'PT') return upper;
  return 'OT';
}

/** The image pane controller. */
export class ImagePanel {
  private readonly pane: HTMLElement;
  private readonly field: HTMLElement;
  private readonly title: HTMLElement;
  private readonly modeSpan: HTMLElement;
  private readonly stateSpan: HTMLElement;
  private readonly layoutPills: Map<ImageLayout, HTMLButtonElement> = new Map<ImageLayout, HTMLButtonElement>();

  private readonly overlayPill: HTMLButtonElement;
  private readonly colormapPill: HTMLButtonElement;
  private readonly savePill: HTMLButtonElement;
  private readonly loadPill: HTMLButtonElement;
  /** Asks again for the slices a network dropped; shown only while some are refused. */
  private readonly retryPill: HTMLButtonElement;
  /** Stops the wait in flight, then offers the rest; shown only while there is one or the other. */
  private readonly stopPill: HTMLButtonElement;
  /** Ends the kernel ask behind an open, while the frame is OPENING; null otherwise. */
  private openingStop: (() => void) | null = null;
  /** What the frame is OPENING, for the words of a stop. */
  private openingPath: string = '';
  /** Counts the opens this frame was asked for: only the latest may put a series on the field. */
  private openingSerial: number = 0;
  /** Asks again for what the frame was OPENING; null when nothing can. */
  private openingAgain: (() => void) | null = null;
  /** The person stopped the open whose notice stands on the field. */
  private openingStopped: boolean = false;
  /** The corner note of a stopped load: how far it got, and LOAD REST. */
  private stoppedNote: HTMLElement | null = null;
  private readonly presetPill: HTMLButtonElement;
  private readonly focusMark: HTMLElement;
  /** Bytes a series may reach before MPR or 3D waits for LOAD; null turns the guard off. */
  private guardBytes: number | null = VOLUME_GUARD_BYTES;
  /** LOAD was pressed (or `--force` given) for the series on the field. */
  private forced: boolean = false;
  /** The layout LOAD will apply. */
  private pendingLayout: ImageLayout | null = null;

  /** The field's working notice, while there is one. */
  private progressNote: HTMLElement | null = null;

  /** The overlay's element, when the overlay is on and a series is up. */
  private overlayNote: HTMLElement | null = null;

  /** The probe's live reading, while the probe is the tool and the pointer is on the image. */
  private probeNote: HTMLElement | null = null;

  /** Whether the operator has asked for the header overlay. */
  private overlay: boolean = false;

  /** The overlay's lines, read once per series. */
  private overlayLines: string[] = [];
  private presetIndex: number = -1;
  private readonly toolPills: Map<ImageTool, HTMLButtonElement> = new Map<ImageTool, HTMLButtonElement>();
  private readonly handlers: ImagePanelHandlers;
  private engine: ImageEngine | null = null;
  private series: DicomSeriesModel | null = null;
  private siblings: SeriesChoice[] = [];
  private colormap: ImageColormap = 'gray';
  private tool: ImageTool = 'wl';

  /**
   * @param mount - The stamped pane element.
   * @param handlers - Host callbacks.
   */
  constructor(mount: HTMLElement, handlers: ImagePanelHandlers) {
    this.handlers = handlers;
    this.pane = mount;
    this.field = element_find(mount, '.image-field');
    this.title = element_find(mount, '.pane-title');
    this.modeSpan = element_find(mount, '.pane-mode');
    this.stateSpan = element_find(mount, '.pane-state');
    for (const pill of mount.querySelectorAll<HTMLButtonElement>('.image-layout')) {
      const layout: ImageLayout = (pill.dataset['layout'] ?? 'single') as ImageLayout;
      this.layoutPills.set(layout, pill);
      pill.addEventListener('click', (): void => void this.layout_set(layout));
    }
    this.overlayPill = element_find(mount, '.image-overlay') as HTMLButtonElement;
    this.overlayPill.addEventListener('click', (): void => void this.overlay_set(!this.overlay));
    this.colormapPill = element_find(mount, '.image-colormap') as HTMLButtonElement;
    this.savePill = element_find(mount, '.image-save') as HTMLButtonElement;
    this.loadPill = element_find(mount, '.image-load') as HTMLButtonElement;
    this.retryPill = element_find(mount, '.image-retry') as HTMLButtonElement;
    this.stopPill = element_find(mount, '.image-stop') as HTMLButtonElement;
    this.presetPill = element_find(mount, '.image-preset') as HTMLButtonElement;
    this.focusMark = element_find(mount, '.image-focus');
    this.field.tabIndex = 0;

    this.colormapPill.addEventListener('click', (): void => void this.colormap_cycle());
    this.savePill.addEventListener('click', (): void => void this.annotations_save());
    this.loadPill.addEventListener('click', (): void => void this.load_press());
    this.retryPill.addEventListener('click', (): void => void this.retry_press());
    this.stopPill.addEventListener('click', (): void => void this.stop_press());
    this.presetPill.addEventListener('click', (): void => this.preset_cycle());
    element_find(mount, '.image-tags').addEventListener('click', (): void => this.handlers.tags_open());
    for (const tool of IMAGE_TOOLS) {
      const pill: HTMLButtonElement = element_find(mount, `.image-tool[data-tool="${tool}"]`) as HTMLButtonElement;
      this.toolPills.set(tool, pill);
      pill.addEventListener('click', (): void => void this.tool_set(tool));
    }
    this.toolPills_paint();

    // Focus stays in the field: a click takes it, keys stay, Esc gives it
    // back. The mark on the frame says who has the keyboard.
    // The mark is painted from the gestures themselves as well as from the
    // focus events: a window without focus (a headless run, a background
    // tab) still moves activeElement but fires no focusin.
    this.field.addEventListener('mousedown', (): void => {
      this.field.focus();
      this.focusMark_paint(true);
    });
    this.field.addEventListener('focusin', (): void => this.focusMark_paint(true));
    this.field.addEventListener('focusout', (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node) || !this.field.contains(event.relatedTarget)) this.focusMark_paint(false);
    });
    this.field.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // A wait in flight is stopped first; the next Esc gives the keyboard back.
        if (!this.wait_stop()) this.field_release();
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
    });
  }

  /** Whether the field holds the keyboard. */
  public field_hasFocus(): boolean {
    return document.activeElement instanceof Node && this.field.contains(document.activeElement);
  }

  /** Gives the keyboard back. */
  public field_release(): boolean {
    if (!this.field_hasFocus()) return false;
    (document.activeElement as HTMLElement).blur();
    this.focusMark_paint(false);
    return true;
  }

  /**
   * Shows a DICOM series the kernel answered with.
   *
   * @param model - The series.
   * @param options - Sibling series for a study folder, and the slice to start at.
   */
  public async series_show(model: DicomSeriesModel, options: { siblings?: SeriesChoice[]; startAt?: number; force?: boolean } = {}): Promise<void> {
    this.openingStop = null;
    this.openingStopped = false;
    this.engine_dispose();
    this.series = model;
    this.forced = options.force === true;
    this.pendingLayout = null;
    this.loadPill.hidden = true;
    this.retryPill.hidden = true;
    this.presets_paint(model.modality);
    this.siblings = options.siblings ?? [];
    this.pane.dataset['modality'] = modalityHue_derive(model.modality);
    // The header keeps one line, so a long description is ellipsised there;
    // the whole of it stays reachable as the element's own title.
    this.title.textContent = `IMAGE ${model.modality.toUpperCase()} ${model.seriesDescription}`.trim();
    this.title.title = this.title.textContent;
    if (this.siblings.length > 1) {
      const at: number = this.siblings.findIndex((choice: SeriesChoice): boolean => choice.path === model.path) + 1;
      this.handlers.note(`image: series ${at} of ${this.siblings.length} in this study; image series <n> switches`);
    }
    const cornerstone: typeof import('./cornerstoneEngine.js') | null = await this.chunk_import((): Promise<typeof import('./cornerstoneEngine.js')> => import('./cornerstoneEngine.js'));
    if (cornerstone === null) return;
    const { CornerstoneEngine } = cornerstone;
    const engine: ImageEngine = new CornerstoneEngine(this.engineHost_get(), model, options.startAt ?? 1);
    await this.engine_open(engine);
    if (this.engine !== engine) return;
    // The first slice cost one file. The rest are fetched now, counted,
    // and the wheel waits for the last — unless the series is over the
    // guard, where the bar says its size and LOAD fetches the rest.
    if (this.guard_trips()) {
      this.loadPill.hidden = false;
      this.stateSpan.textContent = `SERIES ${bytes_format(model.bytes)} · LOAD FOR STACK`;
      this.handlers.note(`image: ${bytes_format(model.bytes)} to fetch before the stack scrolls; press LOAD, image load, or image --force <path>`);
    } else if (!engine.state_get().stopped) {
      // Stopped while the first slice arrived: the rest waits for LOAD REST.
      void engine.slices_fill();
    }
    this.stopPill_paint();
    await this.annotations_reload(engine, model);
  }

  /**
   * Reads the annotation files the kernel found for the series back onto
   * the field: what was saved comes back when the series reopens.
   */
  private async annotations_reload(engine: ImageEngine, model: DicomSeriesModel): Promise<void> {
    let placed: number = 0;
    for (const path of model.annotations.filter((file: string): boolean => /\.dcm$/i.test(file))) {
      if (this.engine !== engine) return;
      const name: string = path.split('/').pop() ?? path;
      try {
        const response: Response = await fetch(this.handlers.source.url_resolve(path));
        if (!response.ok) {
          this.handlers.note(`image: ${name}: HTTP ${response.status}`);
          continue;
        }
        const count: number = await engine.annotations_import(await response.arrayBuffer());
        placed += count;
        this.handlers.note(count > 0 ? `image: ${count} measurement${count === 1 ? '' : 's'} from ${name}` : `image: ${name}: no measurements this engine can place`);
      } catch (error: unknown) {
        this.handlers.note(`image: ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.pane.dataset['annotations'] = String(placed);
  }

  /**
   * Shows a NIfTI or MGZ volume.
   *
   * @param path - The volume's CFS path.
   */
  public async volume_show(path: string): Promise<void> {
    this.openingStop = null;
    this.openingStopped = false;
    this.engine_dispose();
    this.series = null;
    this.siblings = [];
    this.pane.dataset['modality'] = 'NIFTI';
    this.title.textContent = `IMAGE ${path.split('/').pop() ?? ''}`;
    this.title.title = path;
    this.forced = true;
    this.loadPill.hidden = true;
    this.retryPill.hidden = true;
    this.presets_paint('NIFTI');
    const niivue: typeof import('./niivueEngine.js') | null = await this.chunk_import((): Promise<typeof import('./niivueEngine.js')> => import('./niivueEngine.js'));
    if (niivue === null) return;
    const { NiivueEngine } = niivue;
    await this.engine_open(new NiivueEngine(this.engineHost_get(), path));
  }

  /**
   * Loads one of the pane's on-demand engines, and says on the field when
   * it cannot: the chunk's name carries the build, and a page older than
   * the server's build asks for a chunk the server no longer has. The
   * operator saw "no DICOMs" and a TypeError in the developer console; the
   * field now reads the cure.
   *
   * @param load - The dynamic import.
   * @returns The module, or null when it is of an older build than the server's.
   */
  private async chunk_import<T>(load: () => Promise<T>): Promise<T | null> {
    try {
      const loaded: T | undefined = await load();
      if (loaded !== undefined) return loaded;
    } catch (error: unknown) {
      if (!stalePage_is(error)) throw error;
    }
    barState_set(this.stateSpan, 'stale', STALE_PAGE_READOUT);
    this.handlers.note(`image: ${STALE_PAGE_READOUT.toLowerCase()} — the viewer's code is of an older build than the server has`);
    return null;
  }

  /**
   * Says on the field that an open is under way, before the kernel has
   * answered.
   *
   * The ask behind `image <path>` is a header read over a wire, and it can
   * take seconds. A press that shows nothing for those seconds is a press
   * the operator repeats, or gives up on; the pane is therefore on stage
   * and working from the moment of the press, and the engine's own notice
   * takes over from this one when the series arrives.
   *
   * @param path - What is being opened.
   * @param stop - Ends the ask behind the open; given, the frame offers STOP while it waits.
   * @param again - Asks again; given, a stopped open offers OPEN AGAIN.
   * @returns This open's number, for {@link opening_checkIsLatest}.
   */
  public opening_show(path: string, stop?: () => void, again?: () => void): number {
    const name: string = path.replace(/\/$/, '').split('/').pop() ?? path;
    this.openingSerial += 1;
    this.openingStop = stop ?? null;
    this.openingAgain = again ?? null;
    this.openingStopped = false;
    this.openingPath = path;
    this.stateSpan.textContent = 'OPENING';
    this.progress_show({ label: `OPENING ${name}`, done: 0, total: 0 });
    this.stopPill_paint();
    return this.openingSerial;
  }

  /**
   * Whether an open is still the frame's latest. An answer to an earlier one
   * is dropped: showing it would build an engine the later open tears down
   * while its first slice is still arriving.
   *
   * @param serial - What {@link opening_show} returned.
   * @returns True when no later open was asked for.
   */
  public opening_checkIsLatest(serial: number): boolean {
    return serial === this.openingSerial;
  }

  /**
   * Says on the field that the person stopped an open.
   *
   * A chosen state, not a refusal: the frame's own colour, no track (nothing
   * is on its way), and whatever was on the field before stays beneath it.
   *
   * @param path - What was being opened.
   */
  private opening_stopped(path: string): void {
    this.openingStopped = true;
    this.stateSpan.textContent = OPENING_STOPPED_READOUT;
    this.progress_show({ label: OPENING_STOPPED_READOUT, done: 0, total: 0 });
    const note: HTMLElement | null = this.progressNote;
    if (note === null) return;
    note.classList.add('image-working-stopped');
    (note.querySelector('.image-working-fill') as HTMLElement).classList.remove('image-working-pacing');
    (note.querySelector('.image-working-count') as HTMLElement).textContent = path;
  }

  /**
   * The wait this frame is in: OPENING, LOADING, a load the person stopped, or none.
   *
   * @returns The wait, or null when the frame is at rest.
   */
  public wait_get(): ImageWait | null {
    if (this.openingStop !== null) return 'opening';
    if (this.engine?.load_stop === undefined) return null;
    const state: ImageEngineState = this.engine.state_get();
    // A stop already taken, while the first slice still lands, is no wait to stop.
    if (state.loading) return state.stopped ? null : 'loading';
    return state.stopped ? 'stopped' : null;
  }

  /**
   * Stops the wait in flight, as STOP and Esc both do.
   *
   * OPENING: the kernel ask is ended and the frame says it was stopped.
   * LOADING: no further slice is asked for and what arrived stays.
   *
   * @returns Whether there was a wait to stop.
   */
  public wait_stop(): boolean {
    const stop: (() => void) | null = this.openingStop;
    if (stop !== null) {
      this.openingStop = null;
      stop();
      this.opening_stopped(this.openingPath);
      this.stopPill_paint();
      return true;
    }
    if (this.wait_get() !== 'loading' || this.engine?.load_stop === undefined) return false;
    const stopped: boolean = this.engine.load_stop();
    this.stopPill_paint();
    return stopped;
  }

  /** The STOP block's press: stops the wait in flight, or fetches the rest of a stopped load. */
  private async stop_press(): Promise<void> {
    if (this.wait_stop()) return;
    if (this.wait_get() === 'stopped') await this.load_press();
  }

  /** The notice's capsule: OPEN AGAIN on a stopped open, STOP on a wait. */
  private notice_press(): void {
    if (this.openingStopped && this.openingStop === null) {
      this.openingAgain?.();
      return;
    }
    void this.stop_press();
  }

  /**
   * Paints the controls a person sees on the field without opening anything:
   * the working notice's capsule (STOP on a wait, OPEN AGAIN on a stopped
   * open) and the corner note of a stopped load (the count, and LOAD REST).
   *
   * @param wait - The wait the frame is in.
   */
  private fieldControls_paint(wait: ImageWait | null): void {
    const capsule: HTMLButtonElement | null = this.progressNote?.querySelector<HTMLButtonElement>('.image-field-stop') ?? null;
    if (capsule !== null) {
      const reopen: boolean = this.openingStopped && this.openingStop === null && this.openingAgain !== null;
      capsule.hidden = !reopen && wait !== 'opening' && wait !== 'loading';
      capsule.textContent = reopen ? REOPEN_LABEL : STOP_LABEL;
      capsule.title = reopen ? 'ask again for what was stopped' : 'stop this wait; what has arrived stays (Esc on the frame does the same)';
    }
    if (wait !== 'stopped' || this.engine === null) {
      this.stoppedNote?.remove();
      this.stoppedNote = null;
      return;
    }
    // The engine clears the field when it changes what it draws: the note is put back.
    if (this.stoppedNote === null || this.stoppedNote.parentElement === null) {
      const note: HTMLElement = document.createElement('div');
      note.className = 'image-stopped-note';
      note.innerHTML = '<span class="image-stopped-words"></span><button class="pacs-capsule image-field-stop" title="fetch the slices that had not arrived"></button>';
      (note.querySelector('.image-field-stop') as HTMLButtonElement).addEventListener('click', (): void => void this.stop_press());
      this.field.appendChild(note);
      this.stoppedNote = note;
    }
    const state: ImageEngineState = this.engine.state_get();
    (this.stoppedNote.querySelector('.image-stopped-words') as HTMLElement).textContent = `STOPPED AT ${state.held} OF ${state.slices}`;
    (this.stoppedNote.querySelector('.image-field-stop') as HTMLElement).textContent = RESUME_LABEL;
  }

  /** Shows the STOP block only while a wait can be stopped or a stopped load can be resumed, with the words for which. */
  private stopPill_paint(): void {
    const wait: ImageWait | null = this.wait_get();
    this.stopPill.hidden = wait === null;
    this.stopPill.textContent = wait === 'stopped' ? RESUME_LABEL : STOP_LABEL;
    this.stopPill.title = wait === 'stopped'
      ? 'fetch the slices that had not arrived'
      : 'stop this wait; what has arrived stays (Esc on the frame does the same)';
    if (wait === null) delete this.pane.dataset['wait'];
    else this.pane.dataset['wait'] = wait;
    this.fieldControls_paint(wait);
  }

  /**
   * Says on the field what could not open, and why.
   *
   * Never a blank field: a pane that opened for a press and then shows
   * nothing has told the operator less than a console line would. The
   * notice stays until the next open; whatever was on the field before
   * stays beneath it.
   *
   * @param path - What was asked for.
   * @param reason - Why it could not open, in the frame's voice.
   */
  public opening_fail(path: string, reason: string): void {
    this.openingStop = null;
    this.openingStopped = false;
    this.stopPill_paint();
    this.stateSpan.textContent = reason;
    this.progress_show({ label: reason, done: 0, total: 0 });
    const note: HTMLElement | null = this.progressNote;
    if (note === null) return;
    note.classList.add('image-working-failed');
    (note.querySelector('.image-working-count') as HTMLElement).textContent = path;
  }

  /** The sibling series a study folder offered. */
  public siblings_get(): readonly SeriesChoice[] {
    return this.siblings;
  }

  /** The series on the field, or null. */
  public series_get(): DicomSeriesModel | null {
    return this.series;
  }

  /** What is on the field, for the bar and the smoke probe. */
  public state_get(): (ImageEngineState & { colormap: ImageColormap; path: string | null; guard: number | null; waiting: ImageLayout | null }) | null {
    if (this.engine === null) return null;
    return { ...this.engine.state_get(), colormap: this.colormap, path: this.series?.path ?? null, guard: this.guardBytes, waiting: this.pendingLayout };
  }

  /**
   * Sets the layout; false when the field has no engine or it refused.
   */
  public async layout_set(layout: ImageLayout): Promise<boolean> {
    if (this.engine === null) return false;
    // A volume layout pulls every slice; over the guard it waits for LOAD.
    // The stack never asks: its first slice costs one file.
    if (layout !== 'single' && this.guard_trips()) {
      this.pendingLayout = layout;
      this.loadPill.hidden = false;
      this.stateSpan.textContent = `SERIES ${bytes_format(this.series?.bytes ?? 0)} · LOAD FOR ${layout.toUpperCase()}`;
      this.handlers.note(`image: ${bytes_format(this.series?.bytes ?? 0)} to fetch for ${layout}; press LOAD, image load, or image --force <path>`);
      return false;
    }
    // Lit before the work, not after it. Building a volume takes seconds,
    // and a control that keeps reading SINGLE throughout is a viewer that
    // looks like it ignored the press — which is what an operator reported.
    const previous: ImageLayout = this.engine.state_get().layout;
    this.layoutPills_paint(layout);
    this.modeSpan.textContent = layout === 'single' ? '' : layout.toUpperCase();
    this.overlay_hide();
    const engine: ImageEngine = this.engine;
    const ok: boolean = await engine.layout_set(layout);
    // Another series took the field while this one built: nothing here is its to paint.
    if (this.engine !== engine) return false;
    if (!ok && engine.state_get().stopped) {
      // Stopped while its slices arrived: the layout waits, and LOAD REST builds it.
      const standing: ImageLayout = engine.state_get().layout;
      this.pendingLayout = layout;
      this.layoutPills_paint(standing);
      this.modeSpan.textContent = standing === 'single' ? '' : standing.toUpperCase();
      this.overlay_paint();
      this.toolPills_paint();
      this.stopPill_paint();
      return false;
    }
    if (!ok) {
      this.progress_show(null);
      this.layoutPills_paint(previous);
      this.modeSpan.textContent = previous === 'single' ? '' : previous.toUpperCase();
      this.handlers.note(`image: layout ${layout}: not offered by ${this.engine.name}`);
      return false;
    }
    this.progress_show(null);
    this.overlay_paint();
    this.toolPills_paint();
    return true;
  }

  /** Lights the layout on the field and dims the rest. */
  private layoutPills_paint(layout: ImageLayout): void {
    for (const [name, pill] of this.layoutPills) pill.classList.toggle('rail-off', name !== layout);
  }

  /** Whether the series on the field is over the guard and not yet consented to. */
  private guard_trips(): boolean {
    return this.guardBytes !== null && !this.forced && this.engine?.name === 'cornerstone' && (this.series?.bytes ?? 0) > this.guardBytes;
  }

  /** LOAD: consent for this series, then the layout that was waiting. */
  public async load_press(): Promise<boolean> {
    this.forced = true;
    this.loadPill.hidden = true;
    this.retryPill.hidden = true;
    const layout: ImageLayout | null = this.pendingLayout;
    this.pendingLayout = null;
    if (layout !== null) return this.layout_set(layout);
    // Nothing waiting but the stack itself.
    if (this.engine === null || this.engine.state_get().filled) return false;
    return this.engine.slices_fill();
  }

  /**
   * Sets the guard: bytes, or null for none. A readout that acts says so,
   * so the console line names the new threshold.
   */
  public guard_set(bytes: number | null): void {
    this.guardBytes = bytes;
  }

  public guard_get(): number | null {
    return this.guardBytes;
  }

  /** Cycles the modality's window presets on the PRESET block. */
  private preset_cycle(): void {
    const presets: WindowLevelPreset[] = this.presets_select(this.series?.modality ?? 'NIFTI');
    if (presets.length === 0) return;
    this.presetIndex = (this.presetIndex + 1) % presets.length;
    const preset: WindowLevelPreset | undefined = presets[this.presetIndex];
    if (preset === undefined) return;
    if (this.wl_set(preset.lower, preset.upper)) this.presetPill.textContent = preset.name.toUpperCase();
  }

  private presets_select(modality: string): WindowLevelPreset[] {
    const upper: string = modality.toUpperCase();
    return WINDOW_LEVEL_PRESETS.filter((preset: WindowLevelPreset): boolean => preset.modalities.length === 0 || preset.modalities.includes(upper));
  }

  /** The PRESET block shows only where the modality has presets: a block that cannot act is no block. */
  private presets_paint(modality: string): void {
    this.presetIndex = -1;
    const presets: WindowLevelPreset[] = this.presets_select(modality);
    this.presetPill.hidden = presets.length === 0;
    this.presetPill.textContent = 'PRESET';
  }

  public slice_set(slice: number): boolean {
    if (this.engine === null) return false;
    const ok: boolean = this.engine.slice_set(slice);
    if (!ok) this.handlers.note(`image: slice ${slice}: not offered in ${this.engine.state_get().layout} layout by ${this.engine.name}`);
    return ok;
  }

  public wl_set(lower: number, upper: number): boolean {
    if (this.engine === null) return false;
    const ok: boolean = this.engine.wl_set(lower, upper);
    if (!ok) this.handlers.note(`image: wl: not offered by ${this.engine.name}`);
    return ok;
  }

  /** SLAB: the ghost volume's opacity (0..1), or null to hide it. */
  public ghost_set(level: number | null): boolean {
    if (this.engine === null) return false;
    const ok: boolean = this.engine.ghost_set(level);
    if (!ok) this.handlers.note('image: ghost applies to the SLAB layout');
    return ok;
  }

  /** A named window and level preset for the series' modality. */
  public wlPreset_set(name: string): boolean {
    const modality: string = this.series?.modality ?? 'NIFTI';
    const preset = windowLevelPreset_find(name, modality);
    if (preset === undefined) {
      this.handlers.note(`image: wl preset ${name}: none for ${modality}`);
      return false;
    }
    return this.wl_set(preset.lower, preset.upper);
  }

  public colormap_set(name: ImageColormap): boolean {
    if (this.engine === null) return false;
    const ok: boolean = this.engine.colormap_set(name);
    if (!ok) {
      this.handlers.note(`image: colormap ${name}: not offered by ${this.engine.name}`);
      return false;
    }
    this.colormap = name;
    this.colormapPill.textContent = name.toUpperCase();
    return true;
  }

  public tool_set(tool: ImageTool): boolean {
    if (this.engine === null) return false;
    const ok: boolean = this.engine.tool_set(tool);
    if (!ok) {
      this.handlers.note(`image: ${tool}: not offered by ${this.engine.name}`);
      return false;
    }
    this.tool = tool;
    this.toolPills_paint();
    return true;
  }

  /**
   * Saves the measurements on the field as a DICOM SR under
   * `~/annotations/<SeriesInstanceUID>/`, through the surface's own route.
   */
  public async annotations_save(): Promise<boolean> {
    if (this.engine === null) return false;
    const uid: string | undefined = this.series?.seriesInstanceUID;
    const home: string | undefined = /^(\/home\/[^/]+)\//.exec(this.series?.path ?? '')?.[1];
    if (uid === undefined || home === undefined) {
      this.handlers.note('image: save: this series has no UID to file an annotation under');
      return false;
    }
    const blob: Blob | null = await this.engine.annotations_export();
    if (blob === null) {
      this.handlers.note(`image: save: nothing measured, or ${this.engine.name} writes no report`);
      return false;
    }
    const target: string = `${home}/annotations/${uid}/measurements.dcm`;
    const status: number = await this.handlers.file_put(target, blob);
    this.handlers.note(status === 200 ? `✓ ${target}` : `image: save: ${target}: HTTP ${status}`);
    return status === 200;
  }

  /** Releases the field. */
  public dispose(): void {
    this.engine_dispose();
  }

  private async colormap_cycle(): Promise<void> {
    const next: ImageColormap = IMAGE_COLORMAPS[(IMAGE_COLORMAPS.indexOf(this.colormap) + 1) % IMAGE_COLORMAPS.length] ?? 'gray';
    this.colormap_set(next);
  }

  private async engine_open(engine: ImageEngine): Promise<void> {
    this.engine = engine;
    this.field.replaceChildren();
    this.progressNote = null;
    this.overlayNote = null;
    this.probeNote = null;
    this.layoutPills_paint('single');
    this.modeSpan.textContent = '';
    this.colormapPill.textContent = this.colormap.toUpperCase();
    try {
      await engine.open(this.field);
    } catch (error: unknown) {
      this.stateSpan.textContent = 'REFUSED';
      this.handlers.note(`image: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const layout: ImageLayout = engine.state_get().layout;
    this.layoutPills_paint(layout);
    this.modeSpan.textContent = layout === 'single' ? '' : layout.toUpperCase();
    engine.tool_set(this.tool);
    this.toolPills_paint();
    this.progress_show(null);
    void this.overlay_fill();
  }

  private engine_dispose(): void {
    this.engine?.dispose();
    this.engine = null;
    this.progressNote = null;
    this.overlayNote = null;
    this.probeNote = null;
    this.stoppedNote = null;
    this.field.replaceChildren();
    this.stateSpan.textContent = '';
    this.stopPill_paint();
  }

  /** Shows RETRY with the count while slices are refused and the engine can ask again. */
  private retryPill_paint(): void {
    const refused: number = this.engine === null ? 0 : this.engine.state_get().refused;
    const able: boolean = this.engine?.refused_retry !== undefined;
    this.retryPill.hidden = !able || refused === 0;
    if (!this.retryPill.disabled) this.retryPill.textContent = `RETRY ${refused}`;
  }

  /** Asks again for the refused slices; one round at a time. */
  private async retry_press(): Promise<void> {
    if (this.engine?.refused_retry === undefined || this.retryPill.disabled) return;
    this.retryPill.disabled = true;
    this.retryPill.textContent = 'ASKING…';
    try {
      await this.engine.refused_retry();
    } finally {
      this.retryPill.disabled = false;
      this.retryPill_paint();
    }
  }

  private engineHost_get(): ImageEngineHost {
    return {
      source: this.handlers.source,
      readout_set: (text: string): void => {
        this.stateSpan.textContent = text;
        this.retryPill_paint();
        this.stopPill_paint();
      },
      progress_set: (progress: ImageProgress | null): void => {
        this.progress_show(progress);
        this.stopPill_paint();
      },
      note: this.handlers.note,
      regard: (path: string): void => {
        this.handlers.regard(path);
        this.overlaySlice_paint();
      },
      probe_set: (text: string | null): void => this.probe_show(text),
    };
  }

  /**
   * Draws or clears the probe's reading at the foot of the field.
   *
   * @param text - The reading, or null when the pointer is off the image.
   */
  private probe_show(text: string | null): void {
    if (text === null) {
      this.probeNote?.remove();
      this.probeNote = null;
      return;
    }
    if (this.probeNote === null || this.probeNote.parentElement === null) {
      const note: HTMLElement = document.createElement('div');
      note.className = 'image-probe-note';
      this.field.appendChild(note);
      this.probeNote = note;
    }
    this.probeNote.textContent = text;
  }

  /** The overlay's first line: the slice on screen, when there is more than one. */
  private overlaySlice_paint(): void {
    const row: HTMLElement | null = this.overlayNote?.querySelector<HTMLElement>('.image-overlay-slice') ?? null;
    if (row === null || this.engine === null) return;
    const state: ImageEngineState = this.engine.state_get();
    row.textContent = state.slices > 1 ? `SLICE ${Math.max(1, state.slice)} OF ${state.slices}` : '';
    row.hidden = state.slices <= 1;
  }

  /**
   * Shows, moves or takes away the field's working notice.
   *
   * The field is the only place an operator is looking while an image
   * loads, so the notice stands ON it rather than in the bar. A total of
   * zero draws motion without a fraction, which is the honest picture of
   * work whose length nobody stated.
   *
   * @param progress - What is happening, or null when nothing is.
   */
  private progress_show(progress: ImageProgress | null): void {
    if (progress === null) {
      this.progressNote?.remove();
      this.progressNote = null;
      return;
    }
    if (this.progressNote === null || this.progressNote.parentElement === null) {
      const note: HTMLElement = document.createElement('div');
      note.className = 'image-working';
      note.innerHTML = '<span class="image-working-label"></span><span class="image-working-track"><span class="image-working-fill"></span></span><span class="image-working-count"></span><button class="pacs-capsule image-field-stop" hidden></button>';
      (note.querySelector('.image-field-stop') as HTMLButtonElement).addEventListener('click', (): void => this.notice_press());
      this.field.appendChild(note);
      this.progressNote = note;
    }
    const note: HTMLElement = this.progressNote;
    // A notice that failed is not working; a fresh report is.
    note.classList.remove('image-working-failed', 'image-working-stopped');
    const counted: boolean = progress.total > 0;
    const fraction: number = counted ? Math.min(1, progress.done / progress.total) : 0;
    (note.querySelector('.image-working-label') as HTMLElement).textContent = progress.label;
    // Counted work says the fraction as a percentage too: a count of files
    // reads as a count, and how far along is the question being asked.
    (note.querySelector('.image-working-count') as HTMLElement).textContent =
      counted ? `${progress.done} / ${progress.total} · ${Math.round(fraction * 100)}%` : '';
    const fill: HTMLElement = note.querySelector('.image-working-fill') as HTMLElement;
    fill.classList.toggle('image-working-pacing', !counted);
    fill.style.width = counted ? `${Math.round(fraction * 100)}%` : '';
  }

  /**
   * Turns the header overlay on or off.
   *
   * Off by default and remembered for the pane, not for the series: the
   * same pane is used where a screen is shared, and an overlay that came
   * back on its own would put a name on a projector nobody asked it to.
   *
   * @param on - True to write the header on the image.
   */
  private async overlay_set(on: boolean): Promise<void> {
    this.overlay = on;
    this.overlayPill.textContent = on ? 'OVERLAY ON' : 'OVERLAY OFF';
    this.overlayPill.classList.toggle('rail-off', !on);
    if (!on) {
      this.overlay_hide();
      return;
    }
    await this.overlay_fill();
  }

  /** Takes the overlay off the field without forgetting it was asked for. */
  private overlay_hide(): void {
    this.overlayNote?.remove();
    this.overlayNote = null;
  }

  /**
   * Reads the header of what is on the field and draws the overlay.
   *
   * One read per series: the tags wanted here are the study's and the
   * patient's, which every instance of a series repeats.
   */
  private async overlay_fill(): Promise<void> {
    if (!this.overlay || this.series === null) return;
    const path: string = this.series.files[0] ?? this.series.path;
    const model: DicomTagsModel | null = await this.handlers.tags_read(path);
    if (model === null) {
      this.handlers.note(`image: overlay: ${path}: no header to read`);
      return;
    }
    this.overlayLines = OVERLAY_FIELDS.flatMap((field: { label: string; tag: string }): string[] => {
      const held = model.constant.find((tag: { name: string }): boolean => tag.name === field.tag);
      const value: string = (held?.value ?? '').trim();
      if (value === '') return [];
      return [field.label === '' ? value : `${field.label} ${value}`];
    });
    this.overlay_paint();
  }

  /** Puts the lines already read onto the field. */
  private overlay_paint(): void {
    if (!this.overlay || this.overlayLines.length === 0) return;
    this.overlay_hide();
    const note: HTMLElement = document.createElement('div');
    note.className = 'image-overlay-note';
    // The slice count leads: it is the one line that changes as the wheel turns.
    const sliceRow: HTMLElement = document.createElement('span');
    sliceRow.className = 'image-overlay-slice';
    note.appendChild(sliceRow);
    for (const line of this.overlayLines) {
      const row: HTMLElement = document.createElement('span');
      row.textContent = line;
      note.appendChild(row);
    }
    this.field.appendChild(note);
    this.overlayNote = note;
    this.overlaySlice_paint();
  }

  private toolPills_paint(): void {
    const offered: ReadonlySet<ImageTool> = new Set(this.engine?.toolsOffered_get() ?? IMAGE_TOOLS);
    // Null when the layout's own gesture holds the primary (the MPR
    // crosshair, the 3D trackball): then no tool pill is lit. Falls back to
    // the panel's tool only when there is no engine yet.
    const primary: ImageTool | null = this.engine !== null ? this.engine.state_get().primaryTool : this.tool;
    for (const [tool, pill] of this.toolPills) {
      // A tool a layout cannot honour is dimmed and does nothing; the one on
      // the primary drag is lit; the rest are on the rail. A volume's own
      // gesture (crosshair, trackball) holds the primary when nothing is lit.
      const usable: boolean = offered.has(tool);
      pill.classList.toggle('rail-na', !usable);
      pill.classList.toggle('rail-off', usable && tool !== primary);
      pill.disabled = !usable;
    }
  }

  private focusMark_paint(on: boolean): void {
    this.focusMark.hidden = !on;
    this.pane.classList.toggle('image-field-focused', on);
  }
}

function element_find(mount: HTMLElement, selector: string): HTMLElement {
  const found: HTMLElement | null = mount.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`image pane: missing ${selector}`);
  return found;
}
