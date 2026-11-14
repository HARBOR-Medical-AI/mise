/**
 * @file Cornerstone3D behind the image field: a DICOM series as a lazy
 * stack, a streamed volume in three linked planes, or a 3D render.
 *
 * Every tool behaviour here is the library's own (window and level, scroll,
 * zoom, pan, length, angle, probe, crosshairs); this file binds them and
 * reports. Image ids are `wadouri:` over the `/vfs` route mise serves, one
 * file each, so the first slice is on screen after one fetch and the rest
 * follow the wheel. A volume needs every slice before it exists, and the
 * bar says so while it loads.
 *
 * The measurement report adapter asks who an image is; mise answers from its
 * own series model and the file's name, never from the loader's memory.
 *
 * @module
 */
import { refusal_explain } from './refusal.js';
import type { DicomSeriesModel } from '@fnndsc/menu';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray.js';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData.js';
import type { SlabScene } from './slabScene.js';


import { byteUrl_absolute } from '../../calypso/routes.js';
import {
  IMAGE_TOOLS,
  type ImageColormap,
  type ImageEngine,
  type ImageEngineHost,
  type ImageEngineState,
  type ImageLayout,
  type ImageTool,
} from './engine.js';

type Cornerstone = typeof import('@cornerstonejs/core');
type CornerstoneTools = typeof import('@cornerstonejs/tools');
type DicomLoader = typeof import('@cornerstonejs/dicom-image-loader');

/** The three libraries, loaded once per page, only when an image pane asks. */
interface Loaded {
  core: Cornerstone;
  tools: CornerstoneTools;
  loader: DicomLoader;
}

let loaded: Promise<Loaded> | null = null;

/** The request each slice file is arriving on, by its URL, so a stop can abandon it. */
const requestByUrl: Map<string, XMLHttpRequest> = new Map<string, XMLHttpRequest>();

/**
 * The URL a slice's bytes arrive from: the image id without its scheme and
 * frame, since every frame of one file rides one request.
 *
 * @param imageId - The `wadouri:` image id.
 * @returns The key its request is kept under.
 */
function requestUrl_derive(imageId: string): string {
  return imageId.replace(/^wadouri:/, '').replace(/&frame=\d+$/, '');
}

/**
 * Keeps a slice's request while it is on the wire.
 *
 * @param xhr - The loader's request.
 * @param imageId - The slice it fetches.
 */
function request_keep(xhr: XMLHttpRequest, imageId: string): void {
  const url: string = requestUrl_derive(imageId);
  requestByUrl.set(url, xhr);
  xhr.addEventListener('loadend', (): void => {
    if (requestByUrl.get(url) === xhr) requestByUrl.delete(url);
  });
}

/** Loads and initialises Cornerstone3D once for the page. */
function cornerstone_load(): Promise<Loaded> {
  if (loaded === null) {
    loaded = (async (): Promise<Loaded> => {
      const [core, tools, loader] = await Promise.all([
        import('@cornerstonejs/core'),
        import('@cornerstonejs/tools'),
        import('@cornerstonejs/dicom-image-loader'),
      ]);
      await core.init();
      // A slice that never answers must still end: on a weak cell signal a
      // request can stall rather than fail, and a stalled slice held its
      // loader for good. Past the timeout it is refused, and asked again.
      loader.init({
        maxWebWorkers: 2,
        beforeSend: async (xhr: XMLHttpRequest, imageId: string): Promise<Record<string, string>> => {
          xhr.timeout = SLICE_TIMEOUT_MS;
          request_keep(xhr, imageId);
          return {};
        },
      });
      tools.init();
      for (const tool of [
        tools.StackScrollTool,
        tools.WindowLevelTool,
        tools.ZoomTool,
        tools.PanTool,
        tools.LengthTool,
        tools.AngleTool,
        tools.ProbeTool,
        tools.CrosshairsTool,
        tools.TrackballRotateTool,
      ]) {
        tools.addTool(tool);
      }
      return { core, tools, loader };
    })();
  }
  return loaded;
}

/** Cornerstone's own names for the pane's colormaps (vtk.js colour maps). */
const COLORMAP_NAMES: Readonly<Record<ImageColormap, string>> = {
  gray: 'Grayscale',
  hot: 'Black-Body Radiation',
  jet: 'jet',
  cool: 'Cool to Warm',
};

/** Which library tool each pane tool names. */
const TOOL_NAMES: Readonly<Record<ImageTool, string>> = {
  wl: 'WindowLevel',
  zoom: 'Zoom',
  pan: 'Pan',
  length: 'Length',
  angle: 'Angle',
  probe: 'Probe',
};


/**
 * How a frame tool is configured when it joins a tool group. ZOOM zooms and
 * nothing else: the library's zoom, by default, pinches to zoom on touch and
 * pans on a one-finger drag — so on a phone the ZOOM block panned — and pans
 * on a pinch too. A one-finger drag now zooms, as a mouse drag does.
 *
 * @param name - The tool's name.
 * @returns Its configuration, or undefined for the library's own.
 */
function toolConfig_derive(name: string): Record<string, unknown> | undefined {
  if (name === TOOL_NAMES.zoom) return { pinchToZoom: false, pan: false };
  return undefined;
}
/** A volume viewport's data, as far as the probe reads it. */
interface ProbeVolumeData {
  dimensions: number[];
  imageData: unknown;
  voxelManager?: { getAtIJKPoint: (ijk: [number, number, number]) => unknown };
}

/** A cached image, as far as the probe reads it: its pixels and how to scale them. */
interface ProbeImage {
  rows: number;
  columns: number;
  slope: number;
  intercept: number;
  preScale?: { scaled?: boolean };
  getPixelData: () => ArrayLike<number>;
}

/** The SLAB ghost's default opacity: faint enough that the crisp slice reads. */
const SLAB_GHOST_DEFAULT: number = 0.12;

let engineSerial: number = 0;

/** Cornerstone3D as the image engine. */

/** How many slices are asked for at once: enough to fill a pipe, few enough for a phone. */
const SLICES_IN_FLIGHT: number = 8;
/** The pauses before a refused slice is asked for again, and how many times. */
const SLICE_RETRY_PAUSES_MS: readonly number[] = [500, 1500, 4000];
/** How long one slice may take to arrive before it counts as refused. */
const SLICE_TIMEOUT_MS: number = 30_000;

export class CornerstoneEngine implements ImageEngine {
  public readonly name = 'cornerstone' as const;
  private readonly host: ImageEngineHost;
  private readonly series: DicomSeriesModel;
  private readonly serial: number = engineSerial++;
  private readonly imageIds: string[];
  private readonly pathByImageId: Map<string, string> = new Map<string, string>();
  /** The SOPInstanceUID mise knows each image by (from the file name, else invented). */
  private readonly sopByImageId: Map<string, string> = new Map<string, string>();
  private libraries: Loaded | null = null;
  private field: HTMLElement | null = null;
  private renderingEngine: import('@cornerstonejs/core').RenderingEngine | null = null;
  private layout: ImageLayout = 'single';
  private tool: ImageTool = 'wl';
  private slice: number = 0;
  private readonly refused: Set<string> = new Set<string>();
  /** Slices in a transfer syntax the loader cannot read: asking again changes nothing. */
  private readonly unsupported: Set<string> = new Set<string>();
  private startAt: number;
  private disposed: boolean = false;
  private metadataRegistered: boolean = false;
  /** Every slice fetched; the wheel is honoured only then. A one-slice series is whole at once. */
  private filled: boolean = false;
  private filling: Promise<boolean> | null = null;
  /** Slices on hand: fetched by a fill, or drawn by the stack. */
  private readonly held: Set<string> = new Set<string>();
  /** The first slice is on its way to the field. */
  private opening: boolean = false;
  /** Fetches running by this engine's hand. */
  private fetching: number = 0;
  /** The stop of each fetch loop in flight: a layout can start building while the stack still fills. */
  private readonly halts: Set<AbortController> = new Set<AbortController>();
  /** The console has been told of the stop in force. */
  private stopSaid: boolean = false;
  /** Slices on the wire, each with how many fetch loops wait on it. */
  private readonly inFlight: Map<string, number> = new Map<string, number>();
  /** Slices whose request a stop abandoned: their failure is the person's choice, not a refusal. */
  private readonly abandoned: Set<string> = new Set<string>();
  /** The person stopped a fetch before the last slice. */
  private stopped: boolean = false;
  /** The stack on the field holds only the slices on hand. */
  private partial: boolean = false;
  /** Keeps the canvas the size of the field: the frame opening beside it must not stretch the pixels. */
  private resizeObserver: ResizeObserver | null = null;
  /** The probe's listeners on the stack viewport, while the probe is the tool. */
  private probeOff: (() => void) | null = null;
  /** SLAB: the raw-vtk scene, while SLAB is on the field. */
  private slabScene: SlabScene | null = null;
  /** SLAB: the ghost volume's opacity, 0..1, or null to hide it. */
  private ghostLevel: number | null = SLAB_GHOST_DEFAULT;
  /** SLAB: the volume's scalar range, for the ghost and the slice's window. */
  private slabRange: [number, number] = [0, 1];
  /** The window/level last set, shared with SLAB's crisp slice; null means the volume range. */
  private lastVoi: { lower: number; upper: number } | null = null;
  /** The colormap on the field, tracked so a group snapshot can restore it. */
  private colormap: ImageColormap = 'gray';
  /**
   * The frame tool on the primary (left) drag, or null for the layout's own
   * gesture — the crosshair in MPR, the trackball in 3D. A stack always has
   * a tool here; a volume rests on its gesture until the frame lends it one.
   */
  private primary: ImageTool | null = 'wl';

  /**
   * @param host - The pane's lendings.
   * @param series - The series the kernel answered with.
   * @param startAt - The one-based slice to show first.
   */
  constructor(host: ImageEngineHost, series: DicomSeriesModel, startAt: number = 1) {
    this.host = host;
    this.series = series;
    this.startAt = Math.max(1, Math.min(startAt, series.files.length));
    // One file, many frames: each frame is an image id of its own.
    this.imageIds = series.files.length === 1 && series.frames > 1
      ? Array.from({ length: series.frames }, (_, frame: number): string => `wadouri:${byteUrl_absolute(host.source.url_resolve(series.files[0] ?? ''), location.href)}&frame=${frame}`)
      : series.files.map((path: string): string => `wadouri:${byteUrl_absolute(host.source.url_resolve(path), location.href)}`);
    this.imageIds.forEach((imageId: string, index: number): void => {
      this.pathByImageId.set(imageId, series.files.length === 1 ? (series.files[0] ?? '') : (series.files[index] ?? ''));
    });
    this.filled = this.imageIds.length <= 1;
  }

  public async open(field: HTMLElement): Promise<void> {
    this.field = field;
    this.opening = true;
    this.host.readout_set(`LOADING 1 OF ${this.imageIds.length}`);
    this.host.progress_set({ label: this.firstSliceLabel_get(), done: 0, total: 0 });
    try {
      this.libraries = await cornerstone_load();
      if (this.disposed) return;
      this.metadata_register();
      this.loadFailures_watch();
      this.field_observe(field);
      await this.stack_show();
    } finally {
      this.opening = false;
    }
    if (!this.disposed && this.stopped) this.host.readout_set(this.sliceReadout_get());
  }

  /**
   * Stops the fetch in flight and keeps what arrived.
   *
   * No further slice is asked for and each request on the wire is aborted.
   * The first slice of an opening series is one file and is let land, so the
   * field is never left black. A slice already downloaded and being decoded
   * finishes in the loader's cache and is counted when the rest is asked for.
   *
   * @returns Whether a fetch was running.
   */
  public load_stop(): boolean {
    if (this.disposed || (!this.opening && this.fetching === 0)) return false;
    this.stopped = !this.filled;
    this.stopSaid = false;
    this.requests_abandon();
    if (this.opening) {
      this.host.progress_set({ label: this.firstSliceLabel_get(), done: 0, total: 0 });
      this.host.readout_set(this.stoppedReadout_get());
    }
    return true;
  }

  /** The field's words while the first slice is on its way: reading, or stopped and letting that one land. */
  private firstSliceLabel_get(): string {
    return this.stopped ? 'STOPPED · FIRST SLICE ARRIVING' : `READING ${this.imageIds.length} SLICES`;
  }

  /** Aborts every request on the wire and ends the fetch loop that made them. */
  private requests_abandon(): void {
    for (const imageId of this.inFlight.keys()) {
      this.abandoned.add(imageId);
      requestByUrl.get(requestUrl_derive(imageId))?.abort();
    }
    for (const halt of this.halts) halt.abort();
  }

  /** The bar's words for a stopped fetch: how many slices are on hand, of how many. */
  private stoppedReadout_get(): string {
    return `STOPPED AT ${this.held.size} OF ${this.imageIds.length}`;
  }

  /**
   * Puts a stopped fetch on the field: the stack of the slices on hand, the
   * wheel turning through them, and the count in the bar and the console.
   */
  private async stopped_show(): Promise<void> {
    this.host.progress_set(null);
    if (this.layout === 'single') await this.stack_refit();
    if (this.disposed) return;
    this.host.readout_set(this.sliceReadout_get());
    if (this.stopSaid) return;
    this.stopSaid = true;
    this.host.note(`image: stopped at ${this.held.size} of ${this.imageIds.length} slices; LOAD REST or image load fetches the rest`);
  }

  /** The slices the stack shows: every one, or only those on hand after a stop. */
  private stackIds_get(): string[] {
    if (this.filled || !this.stopped) return this.imageIds;
    const onHand: string[] = this.imageIds.filter((imageId: string): boolean => this.held.has(imageId));
    return onHand.length > 0 ? onHand : this.imageIds;
  }

  /**
   * Sets the stack on the field to the slices it may show, keeping the slice
   * on screen: the slices on hand after a stop, every slice once whole.
   */
  private async stack_refit(): Promise<void> {
    const viewport = this.stackViewport_get();
    if (viewport === null) return;
    const ids: string[] = this.stackIds_get();
    const onScreen: string | undefined = this.imageIds[Math.max(0, this.slice - 1)];
    this.partial = ids.length !== this.imageIds.length;
    await viewport.setStack(ids, Math.max(0, onScreen === undefined ? 0 : ids.indexOf(onScreen)));
    if (this.disposed || this.stackViewport_get() !== viewport) return;
    viewport.render();
    if (this.filled || ids.length > 1) this.scroll_unlock();
  }

  /**
   * Fetches the rest of the stack, counted, and unlocks the wheel.
   *
   * The first slice was one file; the rest were fetched as the wheel
   * reached them, and a series that arrives in pieces scrolls in pieces —
   * the operator called it jagged. Now every slice is on hand before the
   * stack turns, the field counts them in, and the bar says so.
   */
  public async slices_fill(): Promise<boolean> {
    if (this.filled) return true;
    if (this.filling !== null) return this.filling;
    if (this.libraries === null || this.renderingEngine === null) return false;
    const total: number = this.imageIds.length;
    const started: number = performance.now();
    this.stopped = false;
    this.abandoned.clear();
    this.filling = (async (): Promise<boolean> => {
      // A fill after a stop asks only for what is not on hand.
      const wanted: string[] = this.imageIds.filter((imageId: string): boolean => !this.held.has(imageId));
      let done: number = total - wanted.length;
      const say = (): void => {
        this.host.readout_set(`LOADING ${done} OF ${total}`);
        this.host.progress_set({ label: 'READING SLICES', done, total });
      };
      say();
      const whole: boolean = await this.images_load(wanted, (): void => {
        done++;
        if (!this.disposed) say();
      });
      this.filling = null;
      if (this.disposed) return false;
      if (!whole) {
        await this.stopped_show();
        return false;
      }
      this.filled = true;
      this.host.progress_set(null);
      if (this.partial && this.layout === 'single') await this.stack_refit();
      this.scroll_unlock();
      this.host.readout_set(this.sliceReadout_get());
      this.host.note(`image: ${total} slices on hand in ${Math.round(performance.now() - started)} ms${this.refused.size > 0 ? `, ${this.refused.size} refused` : ''}`);
      return true;
    })();
    return this.filling;
  }

  public async layout_set(layout: ImageLayout): Promise<boolean> {
    if (this.libraries === null || this.field === null) return false;
    if (layout === this.layout) return true;
    if (layout === 'single') {
      await this.stack_show();
      return true;
    }
    if (layout === 'slab') return this.slab_show();
    return this.volume_show(layout);
  }

  /**
   * Asks again for every refused slice a network could have dropped (not
   * one the loader cannot read), saying how far along; the slice on screen
   * is redrawn if it was among them.
   *
   * @returns How many slices are still refused.
   */
  public async refused_retry(): Promise<number> {
    const again: string[] = [...this.refused].filter((imageId: string): boolean => !this.unsupported.has(imageId));
    if (again.length === 0 || this.disposed) return this.refused.size;
    const onScreen: string | undefined = this.imageIds[Math.max(0, this.slice - 1)];
    let done: number = 0;
    const say = (): void => this.host.progress_set({ label: 'ASKING AGAIN', done, total: again.length });
    say();
    await this.images_load(again, (): void => {
      done++;
      if (!this.disposed) say();
    });
    if (this.disposed) return this.refused.size;
    this.host.progress_set(null);
    this.host.readout_set(this.sliceReadout_get());
    this.host.note(`image: asked again for ${again.length} slices; ${again.length - [...again].filter((id: string): boolean => this.refused.has(id)).length} arrived, ${this.refused.size} still refused`);
    if (onScreen !== undefined && again.includes(onScreen) && !this.refused.has(onScreen)) this.slice_set(this.slice);
    return this.refused.size;
  }

  /**
   * Loads slices a few at a time, each asked again a few times with a
   * growing pause before it counts as refused. A phone on a cell network
   * that was sent every slice of a series at once dropped most of them;
   * a few at a time, and a second and third try, rides out a weak signal.
   *
   * A stop ends the loop where it stands: no slice is asked for after it,
   * and one whose request was abandoned is neither counted nor refused.
   *
   * @param imageIds - The slices.
   * @param landed - Told as each one arrives or is given up on.
   * @returns Whether the loop reached its last slice; false when it was stopped.
   */
  private async images_load(imageIds: ReadonlyArray<string>, landed: () => void): Promise<boolean> {
    if (this.libraries === null) return false;
    const { core } = this.libraries;
    const halt: AbortController = new AbortController();
    const halted: Promise<false> = new Promise<false>((resolve): void => {
      halt.signal.addEventListener('abort', (): void => resolve(false), { once: true });
    });
    const load_one = async (imageId: string): Promise<void> => {
      for (let attempt = 0; attempt <= SLICE_RETRY_PAUSES_MS.length; attempt++) {
        if (this.disposed || halt.signal.aborted || this.unsupported.has(imageId)) return;
        if (attempt > 0) {
          await Promise.race([new Promise<void>((resolve): void => { window.setTimeout(resolve, SLICE_RETRY_PAUSES_MS[attempt - 1]); }), halted]);
          if (halt.signal.aborted) return;
        }
        this.inFlight.set(imageId, (this.inFlight.get(imageId) ?? 0) + 1);
        try {
          const arrived: boolean = await Promise.race([core.imageLoader.loadAndCacheImage(imageId).then((): true => true), halted]);
          if (!arrived) return;
          this.refused.delete(imageId);
          this.held.add(imageId);
          return;
        } catch {
          // Refused this time: counted by the load-failure watch, asked again.
        } finally {
          const waiting: number = (this.inFlight.get(imageId) ?? 1) - 1;
          if (waiting > 0) this.inFlight.set(imageId, waiting);
          else this.inFlight.delete(imageId);
        }
      }
    };
    let next: number = 0;
    const worker = async (): Promise<void> => {
      while (next < imageIds.length && !this.disposed && !halt.signal.aborted) {
        const imageId: string = imageIds[next++] as string;
        await load_one(imageId);
        if (!halt.signal.aborted) landed();
      }
    };
    this.halts.add(halt);
    this.fetching++;
    try {
      await Promise.all(Array.from({ length: Math.min(SLICES_IN_FLIGHT, imageIds.length) }, worker));
    } finally {
      this.fetching--;
      this.halts.delete(halt);
    }
    return !halt.signal.aborted;
  }

  public slice_set(slice: number): boolean {
    if (this.layout === 'slab') return this.slabSlice_set(slice - 1);
    if (this.layout !== 'single' || this.renderingEngine === null || (!this.filled && !this.partial)) return false;
    const viewport = this.stackViewport_get();
    if (viewport === null) return false;
    const wanted: number = Math.max(0, Math.min(slice - 1, this.imageIds.length - 1));
    // A stack of the slices on hand answers only for those.
    const index: number = this.partial ? this.stackIds_get().indexOf(this.imageIds[wanted] ?? '') : wanted;
    if (index < 0) return false;
    void viewport.setImageIdIndex(index);
    return true;
  }

  public wl_set(lower: number, upper: number): boolean {
    this.lastVoi = { lower, upper };
    if (this.layout === 'slab') { if (this.slabScene === null) return false; this.slabScene.wl_set(lower, upper); return true; }
    if (this.renderingEngine === null) return false;
    for (const viewport of this.renderingEngine.getViewports()) {
      (viewport as { setProperties?: (properties: { voiRange: { lower: number; upper: number } }) => void }).setProperties?.({ voiRange: { lower, upper } });
      viewport.render();
    }
    return true;
  }

  public colormap_set(name: ImageColormap): boolean {
    if (this.renderingEngine === null) return false;
    this.colormap = name;
    const colormap: string = COLORMAP_NAMES[name];
    for (const viewport of this.renderingEngine.getViewports()) {
      try {
        (viewport as { setProperties?: (properties: { colormap: { name: string } }) => void }).setProperties?.({ colormap: { name: colormap } });
        viewport.render();
      } catch {
        return false;
      }
    }
    return true;
  }

  public tool_set(tool: ImageTool): boolean {
    if (this.libraries === null) return false;
    const { tools } = this.libraries;
    const group = tools.ToolGroupManager.getToolGroup(this.toolGroupId_get());
    if (group === undefined) return false;
    if (!this.toolsOffered_get().includes(tool)) return false;
    const bindings = tools.Enums.MouseBindings;
    this.probe_disarm();

    // SLAB drives its own vtk interactor: rotate on the left, zoom on the
    // right, pan on the middle, always. The frame's zoom/pan blocks are
    // offered but the gestures are already live, so the click is a no-op.
    if (this.layout === 'slab') return true;

    // A rendered volume: zoom and pan take the primary drag, rotate keeps a
    // button of its own, and clicking the tool already on the primary hands
    // it back to rotate. The pointer tools do not apply to a projection.
    if (this.layout === '3d') {
      this.primary = this.primary === tool ? null : tool;
      this.volumeBindings_apply(group as never);
      this.tool = tool;
      return true;
    }

    // MPR: each plane is a slice, so the pointer tools apply. The chosen
    // tool takes the primary drag off the crosshair; probe is the hover
    // readout, and the crosshair simply stands down while it reads. Clicking
    // the active tool restores the crosshair. Zoom stays on the secondary,
    // pan on the auxiliary, the wheel scrolls throughout.
    if (this.layout === 'mpr') {
      const cross: string = tools.CrosshairsTool.toolName;
      const release: boolean = this.primary === tool;
      // Passivate everything the frame can bind, then set the drags fresh:
      // setToolActive adds a binding rather than moving it.
      for (const name of [cross, TOOL_NAMES.wl, TOOL_NAMES.length, TOOL_NAMES.angle, TOOL_NAMES.zoom, TOOL_NAMES.pan]) group.setToolPassive(name);
      group.setToolActive(TOOL_NAMES.zoom, { bindings: [{ mouseButton: bindings.Secondary }] });
      group.setToolActive(TOOL_NAMES.pan, { bindings: [{ mouseButton: bindings.Auxiliary }] });
      if (release) {
        group.setToolActive(cross, { bindings: [{ mouseButton: bindings.Primary }] });
        this.primary = null;
      } else if (tool === 'probe') {
        this.probe_arm();
        this.primary = 'probe';
      } else if (tool === 'zoom' || tool === 'pan') {
        group.setToolActive(TOOL_NAMES[tool], { bindings: [{ mouseButton: bindings.Primary }] });
        this.primary = tool;
      } else {
        group.setToolActive(TOOL_NAMES[tool], { bindings: [{ mouseButton: bindings.Primary }] });
        this.primary = tool;
      }
      this.tool = tool;
      return true;
    }

    // A stack. The probe is a readout, not a mark: it reads what is under
    // the pointer while the pointer is there, and leaves nothing behind.
    if (tool === 'probe') {
      for (const other of IMAGE_TOOLS) {
        if (other !== 'probe') group.setToolPassive(TOOL_NAMES[other]);
      }
      this.tool = tool;
      this.primary = 'probe';
      this.probe_arm();
      return true;
    }
    for (const other of IMAGE_TOOLS) {
      if (other !== tool && other !== 'probe') group.setToolPassive(TOOL_NAMES[other]);
    }
    group.setToolActive(TOOL_NAMES[tool], { bindings: [{ mouseButton: bindings.Primary }] });
    this.tool = tool;
    this.primary = tool;
    return true;
  }

  public ghost_set(level: number | null): boolean {
    if (this.layout !== 'slab' || this.slabScene === null) return false;
    this.ghostLevel = level === null ? null : Math.max(0, Math.min(1, level));
    this.slabScene.ghost_set(this.ghostLevel);
    return true;
  }

  /**
   * The frame tools that apply to what is on the field now.
   *
   * A stack answers to every tool. An MPR plane is a slice too, so it takes
   * the pointer tools and the navigators. A 3D render is a projection with
   * no slice to measure or probe, so it offers navigation alone.
   */
  public toolsOffered_get(): readonly ImageTool[] {
    if (this.layout === '3d' || this.layout === 'slab') return ['zoom', 'pan'];
    if (this.layout === 'mpr') return ['wl', 'zoom', 'pan', 'length', 'angle', 'probe'];
    return IMAGE_TOOLS;
  }

  public async annotations_export(): Promise<Blob | null> {
    if (this.libraries === null) return null;
    const { tools, core } = this.libraries;
    const annotations = tools.annotation.state.getAllAnnotations();
    if (annotations.length === 0) return null;
    // The adapter wants annotations grouped by image id, then by tool, each
    // tool's list under `data`; a group in any other shape is dropped
    // without a word, which is how an empty report once went to disk.
    const toolState: Record<string, Record<string, { data: unknown[] }>> = {};
    for (const entry of annotations as Array<{ metadata: { referencedImageId?: string; toolName: string } }>) {
      const imageId: string = entry.metadata.referencedImageId ?? '';
      if (!this.pathByImageId.has(imageId)) continue;
      const byTool: Record<string, { data: unknown[] }> = (toolState[imageId] ??= {});
      (byTool[entry.metadata.toolName] ??= { data: [] }).data.push(entry);
    }
    if (Object.keys(toolState).length === 0) return null;
    const { adaptersSR } = await import('@cornerstonejs/adapters');
    const report = adaptersSR.Cornerstone3D.MeasurementReport.generateReport(toolState, core.metaData, {}) as { dataset: Record<string, unknown> };
    // dcmjs's writer reaches for Node's Buffer; the browser gets the polyfill.
    if ((globalThis as { Buffer?: unknown }).Buffer === undefined) {
      (globalThis as { Buffer?: unknown }).Buffer = (await import('buffer')).Buffer;
    }
    const dcmjs = (await import('dcmjs')).default;
    return dcmjs.data.datasetToBlob(report.dataset);
  }

  /**
   * Reads a TID 1500 report's measurements onto the field. Each referenced
   * slice is loaded first, since the adapter needs its plane; what it
   * cannot place (a tool this build lacks, a slice not in this series) it
   * skips, and the count says how many landed.
   */
  public async annotations_import(bytes: ArrayBuffer): Promise<number> {
    if (this.libraries === null || this.renderingEngine === null) return 0;
    const { core, tools } = this.libraries;
    const dcmjs = (await import('dcmjs')).default;
    const { adaptersSR } = await import('@cornerstonejs/adapters');
    let dataset: Record<string, unknown>;
    try {
      dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(bytes, { ignoreErrors: true }).dict);
    } catch (error: unknown) {
      this.host.note(`image: annotation file could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    // dcmjs reads a one-item sequence back as a one-item array; the adapter
    // reads the template sequence as an object.
    const template: unknown = dataset['ContentTemplateSequence'];
    if (Array.isArray(template)) dataset['ContentTemplateSequence'] = template[0];
    // The adapter finds images by `<SOPInstanceUID>:<frame>`; mise names them.
    const imageIdBySop: Record<string, string> = {};
    for (const [imageId, sop] of this.sopByImageId) {
      imageIdBySop[`${sop}:1`] = imageId;
      imageIdBySop[`${sop}:undefined`] = imageId;
    }
    const referenced: Set<string> = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node === null || typeof node !== 'object') return;
      const record: Record<string, unknown> = node as Record<string, unknown>;
      const sop: unknown = (record['ReferencedSOPSequence'] as { ReferencedSOPInstanceUID?: string } | undefined)?.ReferencedSOPInstanceUID;
      if (typeof sop === 'string' && imageIdBySop[`${sop}:1`] !== undefined) referenced.add(imageIdBySop[`${sop}:1`] ?? '');
      for (const value of Object.values(record)) if (typeof value === 'object') walk(value);
    };
    walk(dataset['ContentSequence']);
    await Promise.all([...referenced].map((imageId: string): Promise<unknown> => core.imageLoader.loadAndCacheImage(imageId).catch((): null => null)));
    let placed: number = 0;
    try {
      const toolState = adaptersSR.Cornerstone3D.MeasurementReport.generateToolState(dataset, imageIdBySop, core.metaData, {}) as Record<string, Array<{ annotation: { metadata: { referencedImageId?: string } } }>>;
      const element: HTMLDivElement | undefined = this.field?.querySelector<HTMLDivElement>('.image-viewport') ?? undefined;
      const held: string[] = [];
      for (const [toolType, measurements] of Object.entries(toolState)) {
        held.push(`${toolType}×${measurements.length}`);
        for (const measurement of measurements) {
          if (measurement.annotation.metadata.referencedImageId === undefined) {
            this.host.note(`image: a ${toolType} in the report references a slice not in this series`);
            continue;
          }
          if (element === undefined) continue;
          tools.annotation.state.addAnnotation(measurement.annotation as never, element);
          placed++;
        }
      }
      if (placed === 0) this.host.note(`image: the report holds ${held.length === 0 ? 'no measurement group this build reads' : held.join(', ')}`);
    } catch (error: unknown) {
      this.host.note(`image: annotation file could not be placed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (placed > 0) this.renderingEngine.render();
    return placed;
  }

  public state_get(): ImageEngineState {
    const annotations: number = this.libraries === null
      ? 0
      : (this.libraries.tools.annotation.state.getAllAnnotations() as Array<{ metadata: { referencedImageId?: string } }>)
          .filter((entry): boolean => this.pathByImageId.has(entry.metadata.referencedImageId ?? '')).length;
    return {
      engine: 'cornerstone',
      layout: this.layout,
      slice: this.slice,
      slices: this.imageIds.length,
      tool: this.tool,
      primaryTool: this.primary,
      refused: this.refused.size,
      annotations,
      filled: this.filled,
      loading: this.opening || this.fetching > 0,
      stopped: this.stopped,
      held: this.held.size,
      voi: this.lastVoi,
      viewports: this.viewports_read(),
      ghost: this.layout === 'slab' ? this.ghostLevel : undefined,
      colormap: this.colormap,
    };
  }

  /** Every viewport's zoom, focus and live window, read from the viewport. */
  private viewports_read(): Array<{ id: string; scale: number; focus: [number, number, number]; voi: { lower: number; upper: number } | null }> {
    if (this.renderingEngine === null) return [];
    return this.renderingEngine.getViewports().map((viewport) => {
      const camera = viewport.getCamera() as { parallelProjection?: boolean; parallelScale?: number; position?: number[]; focalPoint?: number[] };
      const focal: number[] = camera.focalPoint ?? [0, 0, 0];
      const position: number[] = camera.position ?? focal;
      const distance: number = Math.hypot((position[0] ?? 0) - (focal[0] ?? 0), (position[1] ?? 0) - (focal[1] ?? 0), (position[2] ?? 0) - (focal[2] ?? 0));
      const properties = (viewport as unknown as { getProperties?: () => { voiRange?: { lower: number; upper: number } } }).getProperties?.();
      return {
        id: viewport.id,
        scale: camera.parallelProjection === true ? (camera.parallelScale ?? 0) : distance,
        focus: [focal[0] ?? 0, focal[1] ?? 0, focal[2] ?? 0],
        voi: properties?.voiRange ?? null,
      };
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.requests_abandon();
    this.probe_disarm();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.field_clear();
    this.field = null;
  }

  /**
   * Keeps the canvases the size of the field.
   *
   * The mode frame opens beside the field and the field narrows; the
   * library sizes its canvas once, at enable, and a canvas stretched by
   * CSS to a narrower box draws a squeezed image with every measurement
   * stranded where it was. Resizing the engine keeps the camera, so the
   * pixels keep their shape and the annotations stay on the anatomy.
   */
  private field_observe(field: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    let queued: boolean = false;
    this.resizeObserver = new ResizeObserver((): void => {
      if (queued || this.disposed) return;
      queued = true;
      requestAnimationFrame((): void => {
        queued = false;
        if (this.disposed) return;
        if (this.slabScene !== null) { this.slabScene.resize(); return; }
        if (this.renderingEngine === null) return;
        try { this.renderingEngine.resize(true, true); } catch { /* a mid-build volume resize can throw; the next render recovers */ }
      });
    });
    this.resizeObserver.observe(field);
  }

  /** The bar's line for the slice on screen. */
  private sliceReadout_get(): string {
    return `SLICE ${Math.max(1, this.slice)} OF ${this.imageIds.length}${this.refused.size > 0 ? ` · REFUSED ${this.refused.size}` : ''}${this.stopped ? ` · ${this.stoppedReadout_get()}` : ''}`;
  }

  /** Binds the wheel to the stack. Called once every slice is on hand. */
  private scroll_unlock(): void {
    if (this.libraries === null || this.layout !== 'single') return;
    const { tools } = this.libraries;
    const group = tools.ToolGroupManager.getToolGroup(this.toolGroupId_get());
    if (group === undefined) return;
    group.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: tools.Enums.MouseBindings.Wheel }, { numTouchPoints: 2 }] });
  }

  /**
   * Reads the voxel under the pointer and says it, live.
   *
   * Position in the image's own indices, the slice on screen, and the
   * value in the modality's unit (HU for CT). Off the image the reading
   * goes away, as it does when the pointer leaves the field.
   */
  private probe_arm(): void {
    this.probe_disarm();
    const elements: HTMLDivElement[] = [...(this.field?.querySelectorAll<HTMLDivElement>('.image-viewport') ?? [])];
    if (elements.length === 0 || this.libraries === null) return;
    const { core } = this.libraries;
    const unit: string = this.series.modality.toUpperCase() === 'CT' ? ' HU' : '';
    const offs: Array<() => void> = [];
    for (const element of elements) {
      const move = (event: MouseEvent): void => {
        const reading: string | null = this.probeReading_read(core, element, event, unit);
        this.host.probe_set(reading);
      };
      const leave = (): void => this.host.probe_set(null);
      element.addEventListener('mousemove', move);
      element.addEventListener('mouseleave', leave);
      offs.push((): void => {
        element.removeEventListener('mousemove', move);
        element.removeEventListener('mouseleave', leave);
      });
    }
    this.probeOff = (): void => {
      for (const off of offs) off();
      this.host.probe_set(null);
    };
  }

  /**
   * The probe's line for a pointer over one viewport, or null off the image.
   *
   * A stack reads its current image's pixels; an MPR plane reads the volume
   * the plane samples. Either way the answer is position, the plane or
   * slice, and the value in the modality's unit.
   */
  private probeReading_read(core: Cornerstone, element: HTMLDivElement, event: MouseEvent, unit: string): string | null {
    const enabled = core.getEnabledElement(element) as { viewport?: unknown } | undefined;
    const viewport = enabled?.viewport as {
      canvasToWorld?: (point: [number, number]) => number[];
      getCurrentImageId?: () => string | undefined;
      getCurrentImageIdIndex?: () => number;
      getImageData?: () => ProbeVolumeData | undefined;
    } | undefined;
    if (viewport?.canvasToWorld === undefined) return null;
    const rect: DOMRect = element.getBoundingClientRect();
    const world: [number, number, number] = viewport.canvasToWorld([event.clientX - rect.left, event.clientY - rect.top]) as [number, number, number];
    // A stack slice reads its own image's pixels; an MPR plane reads the
    // volume it samples, which is right for the reformatted planes too. The
    // element's own class says which it is — an orthographic viewport also
    // answers getCurrentImageId, so the method alone cannot tell them apart.
    if (element.classList.contains('image-viewport-stack')) {
      const imageId: string = viewport.getCurrentImageId?.() ?? '';
      const image: ProbeImage | undefined = core.cache.getImage(imageId) as unknown as ProbeImage | undefined;
      const coords: [number, number] | undefined = core.utilities.worldToImageCoords(imageId, world) as [number, number] | undefined;
      if (image === undefined || coords === undefined) return null;
      const i: number = Math.floor(coords[0]);
      const j: number = Math.floor(coords[1]);
      if (i < 0 || j < 0 || i >= image.columns || j >= image.rows) return null;
      const pixels: ArrayLike<number> = image.getPixelData();
      const samples: number = Math.max(1, Math.round(pixels.length / (image.rows * image.columns)));
      const raw: number | undefined = pixels[(j * image.columns + i) * samples];
      const value: number | undefined = raw === undefined ? undefined : (image.preScale?.scaled === true ? raw : raw * (image.slope ?? 1) + (image.intercept ?? 0));
      const slice: number = typeof viewport.getCurrentImageIdIndex === 'function' ? (viewport.getCurrentImageIdIndex() ?? 0) + 1 : 1;
      return `X ${i}  Y ${j}  ·  SLICE ${slice}  ·  ${value === undefined || Number.isNaN(value) ? '—' : `${Math.round(value * 10) / 10}${unit}`}`;
    }
    // An MPR plane: the volume the plane samples, at the world point.
    const data: ProbeVolumeData | undefined = typeof viewport.getImageData === 'function' ? viewport.getImageData() : undefined;
    if (data?.imageData === undefined || data.voxelManager === undefined) return null;
    const ijk: number[] = (core.utilities.transformWorldToIndex(data.imageData, world) as number[]).map((v: number): number => Math.round(v));
    const [i = 0, j = 0, k = 0] = ijk;
    const [w = 0, h = 0, d = 0] = data.dimensions;
    if (i < 0 || j < 0 || k < 0 || i >= w || j >= h || k >= d) return null;
    const value: unknown = data.voxelManager.getAtIJKPoint([i, j, k]);
    return `X ${i}  Y ${j}  Z ${k}  ·  ${typeof value === 'number' ? `${Math.round(value * 10) / 10}${unit}` : '—'}`;
  }

  private probe_disarm(): void {
    this.probeOff?.();
    this.probeOff = null;
  }

  /**
   * Tells the metadata layer who each image is, from mise's own knowledge:
   * the series model names the series and study, oxidicom's file name
   * carries the SOPInstanceUID. The SR adapter asks exactly this.
   */
  private metadata_register(): void {
    if (this.metadataRegistered || this.libraries === null) return;
    this.metadataRegistered = true;
    const series: DicomSeriesModel = this.series;
    const sopByImageId: Map<string, string> = this.sopByImageId;
    for (const [imageId, path] of this.pathByImageId) {
      const name: string = path.split('/').pop() ?? '';
      const fromName: string | undefined = /^\d+-(.+)\.dcm$/i.exec(name)?.[1];
      sopByImageId.set(imageId, fromName ?? `${series.seriesInstanceUID ?? '0'}.${sopByImageId.size + 1}`);
    }
    const sopClass: string = '1.2.840.10008.5.1.4.1.1.4';
    this.libraries.core.metaData.addProvider((type: string, imageId: string): unknown => {
      const sop: string | undefined = sopByImageId.get(imageId);
      if (sop === undefined) return undefined;
      if (type === 'sopCommonModule') return { sopInstanceUID: sop, sopClassUID: sopClass };
      if (type === 'instance') {
        return {
          SOPInstanceUID: sop,
          SOPClassUID: sopClass,
          SeriesInstanceUID: series.seriesInstanceUID ?? '',
          StudyInstanceUID: series.studyInstanceUID ?? '',
          Modality: series.modality,
          SeriesDescription: series.seriesDescription,
          SeriesNumber: series.seriesNumber ?? 0,
          PatientID: '',
          PatientName: '',
          StudyDate: '',
          StudyTime: '',
          AccessionNumber: '',
          StudyID: '',
        };
      }
      return undefined;
    }, 10_000);
  }

  /** A slice that cannot be read is counted and named; the canvas is never left blank without a word. */
  private loadFailures_watch(): void {
    if (this.libraries === null) return;
    const { core } = this.libraries;
    core.eventTarget.addEventListener(core.Enums.Events.IMAGE_LOAD_FAILED, (event: Event): void => {
      const detail: { imageId?: string; error?: { message?: string } } = (event as CustomEvent).detail ?? {};
      if (detail.imageId === undefined || !this.pathByImageId.has(detail.imageId)) return;
      // A request the person stopped did not fail: it is neither counted nor explained.
      if (this.abandoned.delete(detail.imageId)) return;
      this.refused.add(detail.imageId);
      const message: string = detail.error?.message ?? '';
      const syntax: string | undefined = /transfer syntax[^0-9]*([0-9.]+)/i.exec(message)?.[1];
      if (syntax !== undefined) this.unsupported.add(detail.imageId);
      this.host.readout_set(
        syntax !== undefined
          ? `UNSUPPORTED TRANSFER SYNTAX ${syntax}`
          : `REFUSED ${this.refused.size} OF ${this.imageIds.length}`,
      );
      this.host.note(`image: ${this.pathByImageId.get(detail.imageId) ?? detail.imageId}: ${message || 'could not be read'}`);
      // The loader says that it failed; the route says why. REFUSED alone
      // sent an operator hunting through three layers for a 403.
      if (syntax === undefined) {
        void refusal_explain(detail.imageId).then((why: string): void => {
          this.host.readout_set(`REFUSED ${this.refused.size} OF ${this.imageIds.length} · ${why}`);
          this.host.note(`image: ${this.pathByImageId.get(detail.imageId ?? '') ?? detail.imageId}: ${why.toLowerCase()}`);
        });
      }
    });
  }

  private engineId_get(): string {
    return `image-${this.serial}`;
  }

  private toolGroupId_get(): string {
    return `${this.engineId_get()}-${this.layout}`;
  }

  private stackViewport_get(): import('@cornerstonejs/core').Types.IStackViewport | null {
    if (this.renderingEngine === null) return null;
    const viewport = this.renderingEngine.getViewport(`${this.engineId_get()}-stack`);
    return (viewport as import('@cornerstonejs/core').Types.IStackViewport | undefined) ?? null;
  }

  /** One stack viewport: the first slice after one file, the rest on the wheel. */
  private async stack_show(): Promise<void> {
    if (this.libraries === null || this.field === null) return;
    const { core, tools } = this.libraries;
    this.field_clear();
    this.layout = 'single';
    const element: HTMLDivElement = this.viewport_make('stack');
    const engineId: string = this.engineId_get();
    const viewportId: string = `${engineId}-stack`;
    this.renderingEngine = new core.RenderingEngine(engineId);
    this.renderingEngine.enableElement({ viewportId, type: core.Enums.ViewportType.STACK, element });
    const viewport = this.renderingEngine.getViewport(viewportId) as import('@cornerstonejs/core').Types.IStackViewport;
    element.addEventListener(core.Enums.Events.STACK_NEW_IMAGE, (event: Event): void => {
      const detail: { imageIdIndex: number; imageId: string } = (event as CustomEvent).detail;
      // The slice's place in the series, whichever stack is on the field.
      const place: number = this.imageIds.indexOf(detail.imageId);
      this.slice = (place >= 0 ? place : detail.imageIdIndex) + 1;
      this.held.add(detail.imageId);
      const path: string = this.pathByImageId.get(detail.imageId) ?? '';
      this.host.readout_set(this.sliceReadout_get());
      this.host.regard(path);
    });
    const started: number = performance.now();
    // The stack draws its first slice and fetches the rest as they are
    // scrolled to, so the wait here is one file — but it is a file over a
    // wire, and an empty black field says nothing about whether anything
    // is happening.
    this.host.progress_set({ label: this.firstSliceLabel_get(), done: 0, total: 0 });
    const ids: string[] = this.stackIds_get();
    this.partial = ids.length !== this.imageIds.length;
    await viewport.setStack(ids, Math.max(0, ids.indexOf(this.imageIds[this.startAt - 1] ?? '')));
    // The frame may have closed, or the layout changed, while the slice
    // arrived: its rendering engine is then destroyed, and a render of the
    // viewport it held throws.
    if (this.disposed || this.stackViewport_get() !== viewport) return;
    viewport.render();
    this.host.progress_set(null);
    this.host.note(`image: ${this.imageIds.length} slices, first on screen in ${Math.round(performance.now() - started)} ms`);
    const group = tools.ToolGroupManager.getToolGroup(this.toolGroupId_get()) ?? tools.ToolGroupManager.createToolGroup(this.toolGroupId_get());
    if (group === undefined) return;
    for (const name of Object.values(TOOL_NAMES)) group.addTool(name, toolConfig_derive(name));
    group.addTool(tools.StackScrollTool.toolName);
    group.addViewport(viewportId, engineId);
    const bindings = tools.Enums.MouseBindings;
    // The wheel turns the stack only once the stack is whole.
    if (this.filled || (this.partial && ids.length > 1)) group.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: bindings.Wheel }, { numTouchPoints: 2 }] });
    this.primary = this.tool;
    if (this.tool === 'probe') this.probe_arm();
    else group.setToolActive(TOOL_NAMES[this.tool], { bindings: [{ mouseButton: bindings.Primary }] });
    group.setToolActive(TOOL_NAMES.zoom, { bindings: [{ mouseButton: bindings.Secondary }] });
    group.setToolActive(TOOL_NAMES.pan, { bindings: [{ mouseButton: bindings.Auxiliary }] });
  }

  /** Three linked planes, or one 3D render, over a volume streamed slice by slice. */
  private async volume_show(layout: 'mpr' | '3d'): Promise<boolean> {
    if (this.libraries === null || this.field === null) return false;
    const { core, tools } = this.libraries;
    const started: number = performance.now();
    const total: number = this.imageIds.length;
    this.host.readout_set(`LOADING ${total} SLICES FOR ${layout.toUpperCase()}`);
    // Cleared BEFORE the wait, not after it. This load takes seconds, and
    // leaving the previous image on the field throughout is a viewer that
    // looks like it ignored the press — the operator reported exactly that.
    this.field_clear();
    this.layout = layout;
    this.host.progress_set({ label: `BUILDING ${layout.toUpperCase()}`, done: 0, total });
    // A volume exists only once every header is known; the loader learns
    // them by loading. This is the cost the LOAD guard stands in front of.
    if (!(await this.layoutSlices_load(`BUILDING ${layout.toUpperCase()}`))) return false;
    const engineId: string = this.engineId_get();
    const volumeId: string = `cornerstoneStreamingImageVolume:${engineId}`;
    const grid: HTMLElement = document.createElement('div');
    grid.className = layout === 'mpr' ? 'image-mpr' : 'image-render';
    this.field.appendChild(grid);
    const planes: Array<[string, import('@cornerstonejs/core').Enums.OrientationAxis | undefined]> = layout === 'mpr'
      ? [['axial', core.Enums.OrientationAxis.AXIAL], ['coronal', core.Enums.OrientationAxis.CORONAL], ['sagittal', core.Enums.OrientationAxis.SAGITTAL]]
      : [['render', undefined]];
    this.renderingEngine = new core.RenderingEngine(engineId);
    const inputs = planes.map(([name, orientation]) => {
      const element: HTMLDivElement = document.createElement('div');
      element.className = `image-viewport image-viewport-${name}`;
      grid.appendChild(element);
      return {
        viewportId: `${engineId}-${name}`,
        type: layout === 'mpr' ? core.Enums.ViewportType.ORTHOGRAPHIC : core.Enums.ViewportType.VOLUME_3D,
        element,
        ...(orientation !== undefined ? { defaultOptions: { orientation } } : {}),
      };
    });
    this.renderingEngine.setViewports(inputs);
    // Built fresh every time. The id is the engine's, so a volume built for
    // one layout is cached under it; switching layouts (MPR to 3D) would
    // hand `createAndCacheVolume` the loaded volume back, `load()` would be
    // a no-op, no streaming event would fire, and a 3D viewport that waits
    // on those events to first render would stay black — the operator's
    // "select 3D, nada", seen only from MPR because a first 3D built the
    // volume itself. Purged, so each build streams and renders as the first.
    if (core.cache.getVolume(volumeId) !== undefined) {
      try { core.cache.removeVolumeLoadObject(volumeId); } catch { /* not loaded yet */ }
    }
    const volume = await core.volumeLoader.createAndCacheVolume(volumeId, { imageIds: this.imageIds });
    void (volume as { load: () => void }).load();
    const viewportIds: string[] = inputs.map((input): string => input.viewportId);
    await core.setVolumesForViewports(this.renderingEngine, [{ volumeId }], viewportIds);
    if (layout === '3d') {
      const render = this.renderingEngine.getViewport(viewportIds[0] ?? '') as {
        setProperties?: (properties: { preset: string }) => void;
        resetCamera?: () => void;
      } | undefined;
      render?.setProperties?.({ preset: this.series.modality.toUpperCase() === 'CT' ? 'CT-Bone' : 'MR-Default' });
      // The camera is framed here rather than left to the streaming events,
      // so the render does not depend on a fresh load to first appear.
      render?.resetCamera?.();
    }
    const group = tools.ToolGroupManager.getToolGroup(this.toolGroupId_get()) ?? tools.ToolGroupManager.createToolGroup(this.toolGroupId_get());
    if (group === undefined) return true;
    const bindings = tools.Enums.MouseBindings;
    for (const viewportId of viewportIds) group.addViewport(viewportId, engineId);
    if (layout === 'mpr') {
      group.addTool(tools.CrosshairsTool.toolName, {
        getReferenceLineColor: (id: string): string => (id.endsWith('axial') ? 'rgb(200, 0, 0)' : id.endsWith('coronal') ? 'rgb(200, 200, 0)' : 'rgb(0, 200, 0)'),
      });
      group.addTool(tools.StackScrollTool.toolName);
      // The pointer tools apply to an MPR plane as they do to a stack slice:
      // each plane IS a slice. Added here so the frame can lend one to the
      // primary drag; before this they were never on the MPR group and the
      // button threw, so measuring and probing an MPR did nothing.
      for (const name of [TOOL_NAMES.zoom, TOOL_NAMES.pan, TOOL_NAMES.wl, TOOL_NAMES.length, TOOL_NAMES.angle]) group.addTool(name, toolConfig_derive(name));
      this.primary = null;
      group.setToolActive(tools.CrosshairsTool.toolName, { bindings: [{ mouseButton: bindings.Primary }] });
      group.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: bindings.Wheel }, { numTouchPoints: 2 }] });
      group.setToolActive(TOOL_NAMES.zoom, { bindings: [{ mouseButton: bindings.Secondary }] });
      group.setToolActive(TOOL_NAMES.pan, { bindings: [{ mouseButton: bindings.Auxiliary }] });
      for (const input of inputs) {
        input.element.addEventListener(core.Enums.Events.VOLUME_NEW_IMAGE, (event: Event): void => {
          const detail: { imageIndex?: number } = (event as CustomEvent).detail;
          this.host.readout_set(`MPR ${input.viewportId.split('-').pop()?.toUpperCase() ?? ''} ${detail.imageIndex ?? ''}`);
        });
      }
    } else {
      // A rendered volume navigates with three drags at once: rotate, zoom
      // and pan, one per mouse button, so none is lost when the frame moves
      // one onto the primary drag. Pan was never added before, so the PAN
      // button threw and only rotate answered — the operator saw exactly
      // that.
      group.addTool(tools.TrackballRotateTool.toolName);
      group.addTool(TOOL_NAMES.zoom, toolConfig_derive(TOOL_NAMES.zoom));
      group.addTool(TOOL_NAMES.pan);
      this.primary = null;
      this.volumeBindings_apply(group);
    }
    this.renderingEngine.renderViewports(viewportIds);
    // The layout is the bar's mode annunciation; the state reads the count.
    this.host.readout_set(`${this.imageIds.length} SLICES${this.refused.size > 0 ? ` · REFUSED ${this.refused.size}` : ''}`);
    this.host.note(`image: ${layout} up in ${Math.round(performance.now() - started)} ms`);
    return true;
  }

  /**
   * Fetches every slice a volume layout is built from, through the same
   * loop the stack fills by, so the same stop reaches it. Stopped, the field
   * goes back to the stack of the slices on hand.
   *
   * @param label - The field's words while the slices arrive.
   * @returns Whether every slice was asked for; false when stopped or disposed.
   */
  private async layoutSlices_load(label: string): Promise<boolean> {
    const total: number = this.imageIds.length;
    this.stopped = false;
    this.abandoned.clear();
    let loaded: number = 0;
    const whole: boolean = await this.images_load(this.imageIds, (): void => {
      loaded++;
      if (!this.disposed) this.host.progress_set({ label, done: loaded, total });
    });
    if (this.disposed || this.field === null) return false;
    if (!whole) {
      await this.stack_show();
      await this.stopped_show();
      return false;
    }
    this.filled = true;
    return true;
  }

  /**
   * Puts rotate, zoom and pan on the three mouse buttons of a volume,
   * whichever the frame has chosen for the primary (left) drag.
   *
   * The chosen tool takes the primary; the other two take the secondary and
   * auxiliary, rotate always among them, so a rendered volume rotates,
   * zooms and pans no matter which button the frame has moved where.
   *
   * @param group - The layout's tool group.
   */
  private volumeBindings_apply(group: {
    setToolActive: (name: string, options: { bindings: Array<{ mouseButton?: number; numTouchPoints?: number }> }) => void;
    setToolPassive: (name: string) => void;
  }): void {
    if (this.libraries === null) return;
    const { tools } = this.libraries;
    const bindings = tools.Enums.MouseBindings;
    const rotate: string = tools.TrackballRotateTool.toolName;
    const chosen: string = this.primary === 'zoom' ? TOOL_NAMES.zoom : this.primary === 'pan' ? TOOL_NAMES.pan : rotate;
    const rest: string[] = [rotate, TOOL_NAMES.zoom, TOOL_NAMES.pan].filter((name): boolean => name !== chosen);
    // Passivate before binding: setToolActive ADDS a mouse binding rather
    // than moving it, so without this the tool that held the primary keeps
    // it and a second tool bound there never answers — the PAN button lit
    // and did nothing.
    for (const name of [rotate, TOOL_NAMES.zoom, TOOL_NAMES.pan]) group.setToolPassive(name);
    group.setToolActive(chosen, { bindings: [{ mouseButton: bindings.Primary }] });
    if (rest[0] !== undefined) group.setToolActive(rest[0], { bindings: [{ mouseButton: bindings.Secondary }] });
    if (rest[1] !== undefined) group.setToolActive(rest[1], { bindings: [{ mouseButton: bindings.Auxiliary }] });
  }

  /**
   * SLAB: a crisp acquisition slice sweeping through a ghost of the volume.
   *
   * One VOLUME_3D viewport carries two actors: the volume, ghosted to a
   * faint shell, and a `vtkImageSlice` plane showing the real DICOM slice at
   * full window/level. The wheel moves the plane through the volume; the
   * plane rides the volume's own geometry, so it lands at each slice's true
   * depth. Cornerstone keeps the pixels in a voxel manager rather than the
   * image data's scalars, so they are attached here for the plane's mapper.
   */
  /**
   * SLAB: a crisp acquisition slice sweeping through a ghost of the volume.
   *
   * The scene is vtk's own, not a Cornerstone viewport: a `vtkImageSlice`
   * composited into a Cornerstone `VOLUME_3D` viewport crashes that
   * viewport's z-buffer pass, while the same actors in a plain vtk renderer
   * compose fine. Cornerstone still loads the pixels; they are handed to the
   * scene as one `vtkImageData`. See `slabScene.ts`.
   */
  private async slab_show(): Promise<boolean> {
    if (this.libraries === null || this.field === null) return false;
    const { core } = this.libraries;
    const started: number = performance.now();
    const total: number = this.imageIds.length;
    this.host.readout_set(`LOADING ${total} SLICES FOR SLAB`);
    this.field_clear();
    this.layout = 'slab';
    this.host.progress_set({ label: 'BUILDING SLAB', done: 0, total });
    if (!(await this.layoutSlices_load('BUILDING SLAB'))) return false;
    // A Cornerstone volume is the easiest way to stack the slices with the
    // right geometry; its pixels and geometry are copied into a fresh
    // vtkImageData for the scene, so nothing Cornerstone renders is touched.
    const engineId: string = `${this.engineId_get()}-slab-${engineSerial++}`;
    const volumeId: string = `cornerstoneStreamingImageVolume:${engineId}`;
    if (core.cache.getVolume(volumeId) !== undefined) {
      try { core.cache.removeVolumeLoadObject(volumeId); } catch { /* not loaded */ }
    }
    const volume = await core.volumeLoader.createAndCacheVolume(volumeId, { imageIds: this.imageIds });
    await (volume as { load: () => Promise<void> | void }).load();
    if (this.disposed || this.field === null) return false;
    const volAny = volume as unknown as {
      voxelManager?: { getCompleteScalarDataArray?: () => ArrayLike<number>; scalarData?: ArrayLike<number> };
      dimensions?: number[]; spacing?: number[]; origin?: number[]; direction?: number[];
    };
    // Without a viewport the voxel manager has not materialized its array;
    // getCompleteScalarDataArray() builds it from the cached frames.
    const sd: ArrayLike<number> | undefined = volAny.voxelManager?.getCompleteScalarDataArray?.() ?? volAny.voxelManager?.scalarData;
    const dimK: number = volAny.dimensions?.[2] ?? total;
    if (sd === undefined || volAny.dimensions === undefined) {
      this.host.progress_set(null);
      this.host.readout_set('SLAB: could not read the volume');
      return true;
    }
    const da = vtkDataArray.newInstance({ numberOfComponents: 1, values: sd });
    this.slabRange = da.getRange() as [number, number];
    const imageData = vtkImageData.newInstance();
    (imageData as unknown as { setDimensions: (d: number[]) => void }).setDimensions(volAny.dimensions);
    if (volAny.spacing !== undefined) (imageData as unknown as { setSpacing: (s: number[]) => void }).setSpacing(volAny.spacing);
    if (volAny.origin !== undefined) (imageData as unknown as { setOrigin: (o: number[]) => void }).setOrigin(volAny.origin);
    if (volAny.direction !== undefined) (imageData as unknown as { setDirection: (d: number[]) => void }).setDirection(volAny.direction);
    (imageData as unknown as { getPointData: () => { setScalars: (a: unknown) => void } }).getPointData().setScalars(da);
    const startK: number = Math.max(0, Math.min((this.slice > 0 ? this.slice : (this.startAt || 1)) - 1, dimK - 1));
    const element: HTMLDivElement = document.createElement('div');
    element.className = 'image-viewport image-viewport-render';
    const grid: HTMLElement = document.createElement('div');
    grid.className = 'image-render';
    grid.appendChild(element);
    this.field.appendChild(grid);
    for (let i = 0; i < 60 && element.offsetWidth === 0; i++) {
      await new Promise<void>((resolve): void => { requestAnimationFrame((): void => resolve()); });
    }
    if (this.disposed) return false;
    const { slabScene_open } = await import('./slabScene.js');
    this.slabScene = slabScene_open(element, {
      imageData,
      range: this.slabRange,
      startK,
      slices: dimK,
      voi: this.lastVoi,
      ghost: this.ghostLevel,
      onSweep: (k: number): void => this.slabSwept(k, dimK),
    });
    this.slice = startK + 1;
    this.primary = null;
    this.host.progress_set(null);
    this.host.readout_set(`SLAB \u00b7 z ${startK + 1} / ${dimK}`);
    this.host.note(`image: slab up in ${Math.round(performance.now() - started)} ms`);
    const path: string = this.imageIds[startK] !== undefined ? (this.pathByImageId.get(this.imageIds[startK] ?? '') ?? '') : '';
    if (path !== '') this.host.regard(path);
    return true;
  }

  /** Called by the scene when the wheel sweeps: update the bar and the regard. */
  private slabSwept(k: number, dimK: number): void {
    this.slice = k + 1;
    this.host.readout_set(`SLAB \u00b7 z ${k + 1} / ${dimK}`);
    const path: string = this.imageIds[k] !== undefined ? (this.pathByImageId.get(this.imageIds[k] ?? '') ?? '') : '';
    if (path !== '') this.host.regard(path);
  }

  /** Sweeps the crisp slice to a zero-based index; false unless SLAB is up. */
  private slabSlice_set(k: number): boolean {
    if (this.layout !== 'slab' || this.slabScene === null) return false;
    this.slabScene.sweep(k);
    this.slabSwept(this.slabScene.slice_get(), this.imageIds.length);
    return true;
  }


  private viewport_make(name: string): HTMLDivElement {
    const element: HTMLDivElement = document.createElement('div');
    element.className = `image-viewport image-viewport-${name}`;
    this.field?.appendChild(element);
    return element;
  }

  private field_clear(): void {
    this.probe_disarm();
    this.slabScene?.dispose();
    this.slabScene = null;
    if (this.renderingEngine !== null && this.libraries !== null) {
      for (const layout of ['single', 'mpr', '3d']) {
        this.libraries.tools.ToolGroupManager.destroyToolGroup(`${this.engineId_get()}-${layout}`);
      }
      this.renderingEngine.destroy();
      this.renderingEngine = null;
    }
    this.field?.replaceChildren();
  }
}
