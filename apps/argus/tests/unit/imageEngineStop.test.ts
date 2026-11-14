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
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
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

class FakeViewport {
  constructor(private readonly element: HTMLElement, private readonly owner: FakeRenderingEngine) {}
  public async setStack(ids: string[], index: number): Promise<void> {
    if (firstSlice !== null) await firstSlice;
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
  public enableElement(input: { viewportId: string; element: HTMLElement }): void {
    this.viewports.set(input.viewportId, new FakeViewport(input.element, this));
  }
  public getViewport(id: string): FakeViewport | undefined { return this.viewports.get(id); }
  public getViewports(): FakeViewport[] { return []; }
  public destroy(): void { this.destroyed = true; this.viewports.clear(); }
  public resize(): void { /* nothing to size */ }
}

const groups: Map<string, Record<string, unknown>> = new Map<string, Record<string, unknown>>();
const tool = (toolName: string): { toolName: string } => ({ toolName });

jest.unstable_mockModule('@cornerstonejs/core', () => ({
  init: async (): Promise<void> => undefined,
  eventTarget,
  Enums: {
    Events: { IMAGE_LOAD_FAILED: 'IMAGE_LOAD_FAILED', STACK_NEW_IMAGE: 'STACK_NEW_IMAGE', VOLUME_NEW_IMAGE: 'VOLUME_NEW_IMAGE' },
    ViewportType: { STACK: 'stack', ORTHOGRAPHIC: 'orthographic', VOLUME_3D: 'volume3d' },
    OrientationAxis: { AXIAL: 'axial', CORONAL: 'coronal', SAGITTAL: 'sagittal' },
  },
  metaData: { addProvider: (): void => undefined },
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
jest.unstable_mockModule('@kitware/vtk.js/Common/Core/DataArray.js', () => ({ default: {} }));
jest.unstable_mockModule('@kitware/vtk.js/Common/DataModel/ImageData.js', () => ({ default: {} }));

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
