/**
 * @jest-environment jsdom
 */
/**
 * @file A slice fetch that is stopped asks for no further slice, abandons
 * the requests on the wire, keeps what arrived, and fetches only the rest
 * when asked again.
 *
 * The engine is the real one over a Cornerstone the test stands in for: a
 * loader whose every request the test lands or leaves hanging. The series
 * is made up, so no file is read from anywhere.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DicomSeriesModel } from '@fnndsc/menu';
import type { ImageEngineHost, ImageProgress } from '../../src/features/image/engine.js';

/** One request the loader has on the wire. */
interface Flight {
  imageId: string;
  xhr: FakeXhr;
  land: () => void;
  aborted: boolean;
}

/** The request the engine keeps so a stop can abandon it. */
class FakeXhr extends EventTarget {
  public timeout: number = 0;
  public onAbort: () => void = (): void => undefined;
  public abort(): void { this.onAbort(); }
}

const flights: Flight[] = [];
const cached: Set<string> = new Set<string>();
const eventTarget: EventTarget = new EventTarget();
let beforeSend: (xhr: FakeXhr, imageId: string) => Promise<unknown> = async (): Promise<unknown> => ({});

/** The stack a viewport was last given. */
interface StackCall { ids: string[]; index: number }
const stacks: StackCall[] = [];
const wheelBound: string[] = [];

/** Holds the first slice of a stack on the wire until the test lets it land; null lets it land at once. */
let firstSlice: Promise<void> | null = null;
/** How many stacks have been set, and one of them (by its number) held until the test lets it land. */
let stackCalls: number = 0;
let heldStack: { at: number; until: Promise<void> } | null = null;

class FakeViewport {
  constructor(private readonly element: HTMLElement, private readonly owner: FakeRenderingEngine) {}
  public async setStack(ids: string[], index: number): Promise<void> {
    stackCalls += 1;
    if (firstSlice !== null) await firstSlice;
    if (heldStack !== null && stackCalls === heldStack.at) await heldStack.until;
    stacks.push({ ids: [...ids], index });
    cached.add(ids[index] as string);
    this.element.dispatchEvent(new CustomEvent('STACK_NEW_IMAGE', { detail: { imageIdIndex: index, imageId: ids[index] } }));
  }
  /** As the library's: the viewport looks its engine up, and a destroyed engine is not there. */
  public render(): void {
    const engine: { renderViewport: () => void } | undefined = this.owner.destroyed ? undefined : { renderViewport: (): void => undefined };
    (engine as { renderViewport: () => void }).renderViewport();
  }
  public async setImageIdIndex(): Promise<void> { /* nothing to draw */ }
}

class FakeRenderingEngine {
  public destroyed: boolean = false;
  private readonly viewports: Map<string, FakeViewport> = new Map<string, FakeViewport>();
  constructor() { engines.push(this); }
  public setViewports(inputs: Array<{ viewportId: string; element: HTMLElement }>): void {
    for (const input of inputs) this.enableElement(input);
  }
  public enableElement(input: { viewportId: string; element: HTMLElement }): void {
    this.viewports.set(input.viewportId, new FakeViewport(input.element, this));
  }
  public getViewport(id: string): FakeViewport | undefined { return this.viewports.get(id); }
  public getViewports(): FakeViewport[] { return []; }
  public destroy(): void { this.destroyed = true; this.viewports.clear(); }
  public resize(): void { /* nothing to size */ }
  public renderViewports(): void { /* nothing to draw */ }
}

const groups: Map<string, Record<string, unknown>> = new Map<string, Record<string, unknown>>();
/** The metadata providers Cornerstone holds, the volumes in its cache, and how often volumes were given to viewports. */
const providers: Set<unknown> = new Set<unknown>();
const volumes: Set<string> = new Set<string>();
let volumesSet: number = 0;
/** Holds a volume's making until the test lets it finish; null lets it finish at once. */
let volumeGate: Promise<void> | null = null;
/** Whether a volume made has what a slab is drawn from. */
let volumeDrawable: boolean = false;
/** Every rendering engine made, to say which are still alive. */
const engines: FakeRenderingEngine[] = [];
const tool = (toolName: string): { toolName: string } => ({ toolName });

jest.unstable_mockModule('@cornerstonejs/core', () => ({
  init: async (): Promise<void> => undefined,
  eventTarget,
  Enums: {
    Events: { IMAGE_LOAD_FAILED: 'IMAGE_LOAD_FAILED', STACK_NEW_IMAGE: 'STACK_NEW_IMAGE', VOLUME_NEW_IMAGE: 'VOLUME_NEW_IMAGE' },
    ViewportType: { STACK: 'stack', ORTHOGRAPHIC: 'orthographic', VOLUME_3D: 'volume3d' },
    OrientationAxis: { AXIAL: 'axial', CORONAL: 'coronal', SAGITTAL: 'sagittal' },
  },
  metaData: {
    addProvider: (provider: unknown): void => { providers.add(provider); },
    removeProvider: (provider: unknown): void => { providers.delete(provider); },
  },
  cache: {
    getVolume: (volumeId: string): unknown => (volumes.has(volumeId) ? {} : undefined),
    removeVolumeLoadObject: (volumeId: string): void => { volumes.delete(volumeId); },
  },
  volumeLoader: {
    createAndCacheVolume: async (volumeId: string): Promise<unknown> => {
      if (volumeGate !== null) await volumeGate;
      volumes.add(volumeId);
      if (!volumeDrawable) return { load: (): void => undefined };
      // A volume a slab can be drawn from: its size and its pixels.
      return { load: (): void => undefined, dimensions: [2, 2, 3], spacing: [1, 1, 1], voxelManager: { getCompleteScalarDataArray: (): Float32Array => new Float32Array(12) } };
    },
  },
  setVolumesForViewports: async (): Promise<void> => { volumesSet += 1; },
  RenderingEngine: FakeRenderingEngine,
  imageLoader: {
    loadAndCacheImage: (imageId: string): Promise<unknown> => {
      if (cached.has(imageId)) return Promise.resolve({});
      return new Promise<unknown>((resolve, reject): void => {
        const xhr: FakeXhr = new FakeXhr();
        const flight: Flight = { imageId, xhr, aborted: false, land: (): void => { cached.add(imageId); resolve({}); } };
        // An aborted request fails as the library's does: the failure event, then the rejection.
        xhr.onAbort = (): void => {
          flight.aborted = true;
          xhr.dispatchEvent(new Event('loadend'));
          eventTarget.dispatchEvent(new CustomEvent('IMAGE_LOAD_FAILED', { detail: { imageId, error: { message: 'aborted' } } }));
          reject(new Error('aborted'));
        };
        void beforeSend(xhr, imageId);
        flights.push(flight);
      });
    },
  },
}));
jest.unstable_mockModule('@cornerstonejs/tools', () => ({
  init: (): void => undefined,
  addTool: (): void => undefined,
  StackScrollTool: tool('StackScroll'), WindowLevelTool: tool('WindowLevel'), ZoomTool: tool('Zoom'), PanTool: tool('Pan'),
  LengthTool: tool('Length'), AngleTool: tool('Angle'), ProbeTool: tool('Probe'), CrosshairsTool: tool('Crosshairs'), TrackballRotateTool: tool('TrackballRotate'),
  Enums: { MouseBindings: { Primary: 1, Secondary: 2, Auxiliary: 4, Wheel: 8 } },
  annotation: { state: { getAllAnnotations: (): unknown[] => [] } },
  ToolGroupManager: {
    getToolGroup: (id: string): Record<string, unknown> | undefined => groups.get(id),
    createToolGroup: (id: string): Record<string, unknown> => {
      const group: Record<string, unknown> = {
        addTool: (): void => undefined,
        addViewport: (): void => undefined,
        setToolPassive: (): void => undefined,
        setToolActive: (name: string): void => { if (name === 'StackScroll') wheelBound.push(id); },
      };
      groups.set(id, group);
      return group;
    },
    destroyToolGroup: (id: string): void => { groups.delete(id); },
  },
}));
jest.unstable_mockModule('@cornerstonejs/dicom-image-loader', () => ({
  init: (options: { beforeSend: typeof beforeSend }): void => { beforeSend = options.beforeSend; },
}));
jest.unstable_mockModule('@kitware/vtk.js/Common/Core/DataArray.js', () => ({ default: { newInstance: (): object => ({ getRange: (): number[] => [0, 1] }) } }));
jest.unstable_mockModule('@kitware/vtk.js/Common/DataModel/ImageData.js', () => ({
  default: {
    newInstance: (): object => ({
      setDimensions: (): void => undefined, setSpacing: (): void => undefined, setOrigin: (): void => undefined, setDirection: (): void => undefined,
      getPointData: (): object => ({ setScalars: (): void => undefined }),
    }),
  },
}));
/** Every slab scene opened, by the element it was opened on. */
const slabScenes: HTMLElement[] = [];
jest.unstable_mockModule('../../src/features/image/slabScene.js', () => ({
  slabScene_open: (element: HTMLElement): object => {
    slabScenes.push(element);
    return new Proxy({}, { get: (): (() => undefined) => (): undefined => undefined });
  },
}));

const { CornerstoneEngine } = await import('../../src/features/image/cornerstoneEngine.js');
type Engine = InstanceType<typeof CornerstoneEngine>;

/** A made-up series of so many slices. */
function series_make(slices: number): DicomSeriesModel {
  const files: string[] = Array.from({ length: slices }, (_, at: number): string => `/home/someone/uploads/series-a/${String(at + 1).padStart(4, '0')}-9.9.9.${at + 1}.dcm`);
  return {
    path: '/home/someone/uploads/series-a', seriesInstanceUID: '9.9.9', studyInstanceUID: '9.9', modality: 'MR', seriesDescription: 'MADE UP SERIES',
    instances: slices, frames: 1, order: 'filename', bytes: slices * 1000, header: files[0] as string, files, annotations: [],
  } as DicomSeriesModel;
}

interface Bench {
  engine: Engine;
  readouts: string[];
  progress: Array<ImageProgress | null>;
  notes: string[];
}

/** An engine on a made-up series, its open under way: the caller awaits `opened`. */
function engine_start(slices: number): Bench & { opened: Promise<void> } {
  const readouts: string[] = [];
  const progress: Array<ImageProgress | null> = [];
  const notes: string[] = [];
  const host: ImageEngineHost = {
    source: { url_resolve: (file: string): string => `/vfs?path=${encodeURIComponent(file)}` },
    readout_set: (text: string): void => { readouts.push(text); },
    progress_set: (value: ImageProgress | null): void => { progress.push(value); },
    note: (line: string): void => { notes.push(line); },
    regard: (): void => undefined,
    probe_set: (): void => undefined,
  };
  const engine: Engine = new CornerstoneEngine(host, series_make(slices));
  const field: HTMLElement = document.createElement('section');
  document.body.replaceChildren(field);
  return { engine, readouts, progress, notes, opened: engine.open(field) };
}

/** An engine opened on a made-up series: its first slice on the field. */
async function engine_open(slices: number): Promise<Bench> {
  const bench = engine_start(slices);
  await bench.opened;
  return bench;
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
};

/** The requests still on the wire. */
const flying = (): Flight[] => flights.filter((flight: Flight): boolean => !cached.has(flight.imageId) && !flight.aborted);

/** Lands so many of the requests on the wire, oldest first. */
async function slices_land(count: number): Promise<void> {
  for (const flight of flying().slice(0, count)) flight.land();
  await settle();
}

beforeEach((): void => {
  flights.length = 0;
  stacks.length = 0;
  wheelBound.length = 0;
  cached.clear();
  groups.clear();
  firstSlice = null;
  stackCalls = 0;
  heldStack = null;
  providers.clear();
  volumes.clear();
  volumesSet = 0;
  volumeGate = null;
  volumeDrawable = false;
  slabScenes.length = 0;
  engines.length = 0;
});

describe('a stack fill, stopped', () => {
  it('reads LOADING while it fetches, eight slices at a time', async () => {
    const bench: Bench = await engine_open(20);
    expect(bench.engine.state_get().loading).toBe(false);
    const filling: Promise<boolean> = bench.engine.slices_fill();
    await settle();
    expect(bench.engine.state_get().loading).toBe(true);
    expect(bench.readouts.at(-1)).toBe('LOADING 1 OF 20');
    expect(flights).toHaveLength(8);
    bench.engine.load_stop();
    expect(await filling).toBe(false);
  });

  it('asks for no further slice, abandons the requests on the wire, and keeps what arrived', async () => {
    const bench: Bench = await engine_open(20);
    const filling: Promise<boolean> = bench.engine.slices_fill();
    await settle();
    await slices_land(5);
    expect(flights).toHaveLength(13);
    expect(flying()).toHaveLength(8);
    const onWire: Flight[] = flying();

    expect(bench.engine.load_stop()).toBe(true);
    expect(await filling).toBe(false);
    await settle();

    expect(onWire.every((flight: Flight): boolean => flight.aborted)).toBe(true);
    expect(flights).toHaveLength(13);
    const state = bench.engine.state_get();
    expect(state.loading).toBe(false);
    expect(state.stopped).toBe(true);
    expect(state.filled).toBe(false);
    expect(state.held).toBe(6);
    // An abandoned request is the person's choice: it is not a refused slice.
    expect(state.refused).toBe(0);
    expect(bench.readouts.some((text: string): boolean => text.includes('REFUSED'))).toBe(false);
  });

  it('says STOPPED AT with the count, shows the slices on hand, and lets the wheel turn through them', async () => {
    const bench: Bench = await engine_open(20);
    const filling: Promise<boolean> = bench.engine.slices_fill();
    await settle();
    await slices_land(5);
    bench.engine.load_stop();
    await filling;
    await settle();
    expect(bench.readouts.at(-1)).toBe('SLICE 1 OF 20 · STOPPED AT 6 OF 20');
    expect(bench.progress.at(-1)).toBeNull();
    expect(bench.notes.at(-1)).toBe('image: stopped at 6 of 20 slices; LOAD REST or image load fetches the rest');
    expect(stacks.at(-1)?.ids).toHaveLength(6);
    expect(stacks.at(-1)?.ids.every((imageId: string): boolean => cached.has(imageId))).toBe(true);
    expect(wheelBound).toHaveLength(1);
    expect(bench.engine.slice_set(3)).toBe(true);
    // A slice that never arrived is not one the stopped stack can show.
    expect(bench.engine.slice_set(20)).toBe(false);
  });

  it('asked again, fetches only what had not arrived and ends whole', async () => {
    const bench: Bench = await engine_open(20);
    const first: Promise<boolean> = bench.engine.slices_fill();
    await settle();
    await slices_land(5);
    bench.engine.load_stop();
    await first;
    await settle();
    const before: number = flights.length;
    const onHand: Set<string> = new Set<string>(cached);

    const rest: Promise<boolean> = bench.engine.slices_fill();
    await settle();
    expect(bench.engine.state_get().stopped).toBe(false);
    expect(bench.engine.state_get().loading).toBe(true);
    expect(bench.readouts.at(-1)).toBe('LOADING 6 OF 20');
    while (flying().length > 0) await slices_land(8);
    expect(await rest).toBe(true);

    const asked: string[] = flights.slice(before).map((flight: Flight): string => flight.imageId);
    expect(asked).toHaveLength(14);
    expect(asked.some((imageId: string): boolean => onHand.has(imageId))).toBe(false);
    const state = bench.engine.state_get();
    expect(state.filled).toBe(true);
    expect(state.stopped).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.held).toBe(20);
    expect(state.refused).toBe(0);
    expect(bench.readouts.at(-1)).toBe('SLICE 1 OF 20');
    expect(stacks.at(-1)?.ids).toHaveLength(20);
  });

  it('with nothing being fetched, has nothing to stop', async () => {
    const bench: Bench = await engine_open(20);
    expect(bench.engine.load_stop()).toBe(false);
    expect(bench.engine.state_get().stopped).toBe(false);
  });
});

describe('a volume layout\'s slices, stopped', () => {
  it('ride the same loop: the stop abandons them and the field goes back to the stack on hand', async () => {
    const bench: Bench = await engine_open(20);
    const building: Promise<boolean> = bench.engine.layout_set('mpr');
    await settle();
    expect(bench.engine.state_get().loading).toBe(true);
    expect(flights).toHaveLength(8);
    await slices_land(3);
    const onWire: Flight[] = flying();
    expect(bench.engine.load_stop()).toBe(true);
    expect(await building).toBe(false);
    expect(onWire.every((flight: Flight): boolean => flight.aborted)).toBe(true);
    expect(flights).toHaveLength(11);
    const state = bench.engine.state_get();
    expect(state.layout).toBe('single');
    expect(state.stopped).toBe(true);
    expect(state.held).toBe(4);
    expect(bench.readouts.at(-1)).toBe('SLICE 1 OF 20 · STOPPED AT 4 OF 20');
    expect(stacks.at(-1)?.ids).toHaveLength(4);
  });
});

describe('the first slice, still arriving', () => {
  /** Holds the first slice; the returned function lets it land. */
  const firstSlice_hold = (): (() => void) => {
    let land: () => void = (): void => undefined;
    firstSlice = new Promise<void>((resolve): void => { land = resolve; });
    return land;
  };

  it('a frame that closes meanwhile opens no further and throws nothing: its viewport is not rendered', async () => {
    const land: () => void = firstSlice_hold();
    const bench = engine_start(20);
    await settle();
    bench.engine.dispose();
    land();
    await expect(bench.opened).resolves.toBeUndefined();
    expect(bench.notes.some((line: string): boolean => line.includes('first on screen'))).toBe(false);
  });

  it('stopped meanwhile, lands and says so on the field and the bar', async () => {
    const land: () => void = firstSlice_hold();
    const bench = engine_start(20);
    await settle();
    expect(bench.progress.at(-1)?.label).toBe('READING 20 SLICES');
    expect(bench.engine.load_stop()).toBe(true);
    expect(bench.progress.at(-1)?.label).toBe('STOPPED · FIRST SLICE ARRIVING');
    expect(bench.readouts.at(-1)).toBe('STOPPED AT 0 OF 20');
    land();
    await bench.opened;
    expect(bench.readouts.at(-1)).toBe('SLICE 1 OF 20 · STOPPED AT 1 OF 20');
    expect(flights).toHaveLength(0);
    const state = bench.engine.state_get();
    expect(state.stopped).toBe(true);
    expect(state.loading).toBe(false);
    // LOAD REST: the other nineteen, and the stack ends whole.
    const rest: Promise<boolean> = bench.engine.slices_fill();
    await settle();
    while (flying().length > 0) await slices_land(8);
    expect(await rest).toBe(true);
    expect(flights).toHaveLength(19);
    expect(bench.readouts.at(-1)).toBe('SLICE 1 OF 20');
  });
});

describe('a frame that closes', () => {
  it('abandons the requests on the wire', async () => {
    const bench: Bench = await engine_open(20);
    void bench.engine.slices_fill();
    await settle();
    const onWire: Flight[] = flying();
    expect(onWire).toHaveLength(8);
    bench.engine.dispose();
    await settle();
    expect(onWire.every((flight: Flight): boolean => flight.aborted)).toBe(true);
    expect(flights).toHaveLength(8);
  });
});

describe('what an engine put on Cornerstone\'s own objects', () => {
  /** Lands every request as it is made, so a layout's slices are whole at once. */
  async function slices_landAll(): Promise<void> {
    for (let round = 0; round < 12 && flying().length > 0; round++) await slices_land(8);
  }

  it('is taken back when the engine is let go: its metadata provider is removed, and a slice that fails afterwards is not its to report', async () => {
    const bench: Bench = await engine_open(3);
    expect(providers.size).toBe(1);
    bench.engine.dispose();
    expect(providers.size).toBe(0);
    const before: number = bench.readouts.length;
    const noted: number = bench.notes.length;
    // A slice of this very series fails to load, for whoever else asked for it.
    eventTarget.dispatchEvent(new CustomEvent('IMAGE_LOAD_FAILED', { detail: { imageId: `wadouri:/vfs?path=${encodeURIComponent('/home/someone/uploads/series-a/0002-9.9.9.2.dcm')}`, error: { message: 'gone' } } }));
    await settle();
    expect(bench.readouts.length).toBe(before);
    expect(bench.notes.length).toBe(noted);
  });

  it('a volume goes with the layout that used it: ten slab builds leave one slab volume, and letting the engine go leaves none', async () => {
    const bench: Bench = await engine_open(3);
    const inner = bench.engine as unknown as { slab_show: () => Promise<boolean> };
    for (let build = 0; build < 10; build++) {
      const building: Promise<boolean> = inner.slab_show();
      await slices_landAll();
      await building;
      expect([...volumes].filter((id: string): boolean => id.includes('-slab-'))).toHaveLength(1);
    }
    // Back to a volume layout: the slab's volume goes, and the layout's own is the one in the cache.
    const mpr: Promise<boolean> = bench.engine.layout_set('mpr');
    await slices_landAll();
    await mpr;
    expect([...volumes].some((id: string): boolean => id.includes('-slab-'))).toBe(false);
    expect(volumes.size).toBe(1);
    bench.engine.dispose();
    expect(volumes.size).toBe(0);
  });

  it('an engine let go while a volume is being made has, once it is made, no volume, no engine, no tool group and no provider of its own', async () => {
    const bench: Bench = await engine_open(3);
    let made: () => void = (): void => undefined;
    volumeGate = new Promise<void>((resolve: () => void): void => { made = resolve; });
    const building: Promise<boolean> = bench.engine.layout_set('mpr');
    await slices_landAll();
    await settle();
    // The slices are in and the volume is being made: the frame closes.
    bench.engine.dispose();
    volumeGate = null;
    made();
    expect(await building).toBe(false);
    await settle();
    expect(volumes.size).toBe(0);
    expect(volumesSet).toBe(0);
    expect(engines.every((engine: FakeRenderingEngine): boolean => engine.destroyed)).toBe(true);
    expect(groups.size).toBe(0);
    expect(providers.size).toBe(0);
    expect(document.body.querySelector('.image-mpr')).toBeNull();
  });

  it('a layout chosen while another\'s volume is being made is the one that stands: the first build installs nothing', async () => {
    const bench: Bench = await engine_open(3);
    let made: () => void = (): void => undefined;
    volumeGate = new Promise<void>((resolve: () => void): void => { made = resolve; });
    const first: Promise<boolean> = bench.engine.layout_set('mpr');
    await slices_landAll();
    await settle();
    volumeGate = null;
    // Another layout is chosen before the first one's volume is made.
    const second: Promise<boolean> = bench.engine.layout_set('3d');
    await slices_landAll();
    await second;
    const setBefore: number = volumesSet;
    made();
    expect(await first).toBe(false);
    await settle();
    expect(volumesSet).toBe(setBefore);
    expect(bench.engine.state_get().layout).toBe('3d');
    expect(engines.filter((engine: FakeRenderingEngine): boolean => !engine.destroyed)).toHaveLength(1);
    // The late build released its own volume and not the one that stands: that one is in the cache until the end.
    expect(volumes.size).toBe(1);
    bench.engine.dispose();
    expect(volumes.size).toBe(0);
  });

  /** The frames the page has been asked for and has not yet given: the test gives them. */
  const frames: Array<() => void> = [];
  const realFrame = globalThis.requestAnimationFrame;
  beforeEach((): void => {
    frames.length = 0;
    globalThis.requestAnimationFrame = ((callback: () => void): number => { frames.push(callback); return frames.length; }) as typeof requestAnimationFrame;
  });
  afterEach((): void => { globalThis.requestAnimationFrame = realFrame; });

  /** Gives every frame asked for, and those asked for in turn, until none is. */
  async function frames_give(): Promise<number> {
    let given: number = 0;
    for (let round = 0; round < 80 && frames.length > 0; round++) {
      (frames.shift() as () => void)();
      given += 1;
      await Promise.resolve();
      await Promise.resolve();
    }
    await settle();
    return given;
  }

  /**
   * A slab build up to where it waits for its element to have a size: with no layout here the element never
   * has one, so the build waits on a frame, held until the test gives it.
   */
  async function slab_begin(bench: Bench): Promise<{ building: Promise<boolean> }> {
    volumeDrawable = true;
    const building: Promise<boolean> = (bench.engine as unknown as { slab_show: () => Promise<boolean> }).slab_show();
    await slices_landAll();
    await settle();
    expect(frames.length).toBe(1);
    return { building };
  }

  it('a layout chosen while a stopped build is putting the stack back stands: STOPPED is not said over it', async () => {
    const bench: Bench = await engine_open(20);
    const mpr: Promise<boolean> = bench.engine.layout_set('mpr');
    await settle();
    await slices_land(3);
    // The stack the stop goes back to is held as its first slice is set.
    let shown: () => void = (): void => undefined;
    firstSlice = new Promise<void>((resolve: () => void): void => { shown = resolve; });
    expect(bench.engine.load_stop()).toBe(true);
    await settle();
    // 3D is chosen while that stack is still being put back, and is built.
    const render: Promise<boolean> = bench.engine.layout_set('3d');
    await slices_landAll();
    expect(await render).toBe(true);
    const readout: string | undefined = bench.readouts.at(-1);
    const progressed: number = bench.progress.length;
    const noted: number = bench.notes.length;
    // The held stack lands now.
    firstSlice = null;
    shown();
    expect(await mpr).toBe(false);
    await settle();
    expect(bench.engine.state_get().layout).toBe('3d');
    expect(bench.readouts.at(-1)).toBe(readout);
    expect(bench.readouts.at(-1)).not.toContain('STOPPED');
    expect(bench.progress.length).toBe(progressed);
    expect(bench.notes.length).toBe(noted);
    bench.engine.dispose();
  });

  it('a layout chosen while a stopped build refits its stack stands: the late stack moves no slice and says nothing', async () => {
    const bench: Bench = await engine_open(20);
    const mpr: Promise<boolean> = bench.engine.layout_set('mpr');
    await settle();
    await slices_land(3);
    // The stop puts the stack back (its first set lands) and then refits it: that second set is held.
    let refitted: () => void = (): void => undefined;
    heldStack = { at: stackCalls + 2, until: new Promise<void>((resolve: () => void): void => { refitted = resolve; }) };
    expect(bench.engine.load_stop()).toBe(true);
    await settle();
    await settle();
    expect(stackCalls).toBe((heldStack as { at: number }).at);
    // 3D is chosen while the refit is held, and is built.
    const render: Promise<boolean> = bench.engine.layout_set('3d');
    await slices_landAll();
    expect(await render).toBe(true);
    // The field is on a slice of 3D's own.
    (bench.engine as unknown as { slice: number }).slice = 7;
    const readout: string | undefined = bench.readouts.at(-1);
    const noted: number = bench.notes.length;
    const progressed: number = bench.progress.length;
    // The held refit lands, bringing the stack's first slice with it.
    heldStack = null;
    refitted();
    expect(await mpr).toBe(false);
    await settle();
    expect(bench.engine.state_get().layout).toBe('3d');
    expect(bench.engine.state_get().slice).toBe(7);
    expect(bench.readouts.at(-1)).toBe(readout);
    expect(bench.notes.length).toBe(noted);
    expect(bench.progress.length).toBe(progressed);
    bench.engine.dispose();
  });

  it('a slab build left alone opens one scene on an element that is on the field', async () => {
    const bench: Bench = await engine_open(3);
    const { building } = await slab_begin(bench);
    expect(slabScenes).toHaveLength(0);
    await frames_give();
    expect(await building).toBe(true);
    expect(slabScenes).toHaveLength(1);
    expect(document.body.contains(slabScenes[0] as HTMLElement)).toBe(true);
    bench.engine.dispose();
  }, 15_000);

  it('an engine let go while a slab waits for its element to be sized opens no scene, and keeps no volume', async () => {
    const bench: Bench = await engine_open(3);
    const { building } = await slab_begin(bench);
    bench.engine.dispose();
    const given: number = await frames_give();
    expect(await building).toBe(false);
    // The wait ended at the first frame that saw the engine gone, not after all sixty.
    expect(given).toBe(1);
    expect(slabScenes).toHaveLength(0);
    expect(volumes.size).toBe(0);
  }, 15_000);

  it('a layout chosen while a slab waits for its element to be sized stands: the slab opens no scene on the element it had made', async () => {
    const bench: Bench = await engine_open(3);
    const { building } = await slab_begin(bench);
    volumeDrawable = false;
    const mpr: Promise<boolean> = bench.engine.layout_set('mpr');
    await slices_landAll();
    expect(await mpr).toBe(true);
    await frames_give();
    expect(await building).toBe(false);
    expect(slabScenes).toHaveLength(0);
    expect(bench.engine.state_get().layout).toBe('mpr');
    expect([...volumes].some((id: string): boolean => id.includes('-slab-'))).toBe(false);
    expect(volumes.size).toBe(1);
    bench.engine.dispose();
  }, 15_000);
});
