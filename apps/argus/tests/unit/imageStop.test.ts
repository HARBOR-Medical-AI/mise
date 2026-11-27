/**
 * @jest-environment jsdom
 */
/**
 * @file A wait on the image frame can be stopped from the frame.
 *
 * The STOP block stands only while the frame is OPENING or LOADING, Esc on
 * the frame presses it, a stopped load reads LOAD REST and fetches the rest,
 * a stopped open cancels its line in the session, and a stopped frame wears
 * no refusal.
 *
 * The pane is the real one, standing on the page's own markup, over an
 * engine the test drives; the series is made up, so this needs neither a
 * CUBE nor a daemon.
 *
 * @module
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DicomSeriesModel } from '@fnndsc/menu';
import type { ImageEngineHost, ImageEngineState, ImageLayout } from '../../src/features/image/engine.js';
import type { ChrisDicomContext } from '../../src/compositions/chris/dicom.js';
import type { ExecuteOutcome } from '../../src/calypso/client.js';

/** The guest engine, faked: a load the test starts, stops and ends. */
class FakeEngine {
  public static last: FakeEngine | null = null;
  public static made: number = 0;
  public readonly name = 'cornerstone' as const;
  public loading: boolean = false;
  public stopped: boolean = false;
  public filled: boolean = false;
  public held: number = 0;
  public layout: ImageLayout = 'single';
  public fills: number = 0;
  public stops: number = 0;
  public layoutsAsked: ImageLayout[] = [];
  public disposed: boolean = false;
  /** Ends the open in flight. */
  public open_end: () => void = (): void => undefined;
  /** Fails the open in flight. */
  public open_fail: (why: string) => void = (): void => undefined;
  /** Ends the layout build in flight: built, or stopped. */
  public layout_end: (built: boolean) => void = (): void => undefined;

  constructor(public readonly host: ImageEngineHost, public readonly series: DicomSeriesModel) {
    FakeEngine.last = this;
    FakeEngine.made += 1;
  }

  public open(): Promise<void> {
    this.loading = true;
    this.host.readout_set(`LOADING 1 OF ${this.series.files.length}`);
    return new Promise<void>((resolve, reject): void => {
      this.open_fail = (why: string): void => { this.loading = false; reject(new Error(why)); };
      this.open_end = (): void => {
        this.loading = false;
        this.held = Math.max(this.held, 1);
        this.host.readout_set(`SLICE 1 OF ${this.series.files.length}${this.stopped ? ` · STOPPED AT ${this.held} OF ${this.series.files.length}` : ''}`);
        resolve();
      };
    });
  }

  public async slices_fill(): Promise<boolean> {
    this.fills += 1;
    this.stopped = false;
    this.loading = true;
    this.host.readout_set(`LOADING ${this.held} OF ${this.series.files.length}`);
    this.host.progress_set({ label: 'READING SLICES', done: this.held, total: this.series.files.length });
    return false;
  }

  /** Lands slices, as a fill does. */
  public slices_land(count: number): void {
    this.held += count;
    if (this.held >= this.series.files.length) {
      this.loading = false;
      this.filled = true;
      this.host.progress_set(null);
      this.host.readout_set(`SLICE 1 OF ${this.series.files.length}`);
      return;
    }
    this.host.readout_set(`LOADING ${this.held} OF ${this.series.files.length}`);
    this.host.progress_set({ label: 'READING SLICES', done: this.held, total: this.series.files.length });
  }

  public load_stop(): boolean {
    if (!this.loading) return false;
    this.stops += 1;
    this.loading = false;
    this.stopped = true;
    this.host.progress_set(null);
    this.host.readout_set(`SLICE 1 OF ${this.series.files.length} · STOPPED AT ${this.held} OF ${this.series.files.length}`);
    return true;
  }

  public layout_set(layout: ImageLayout): Promise<boolean> {
    this.layoutsAsked.push(layout);
    this.stopped = false;
    this.loading = true;
    this.host.progress_set({ label: `BUILDING ${layout.toUpperCase()}`, done: 0, total: this.series.files.length });
    return new Promise<boolean>((resolve): void => {
      this.layout_end = (built: boolean): void => {
        this.loading = false;
        if (built) this.layout = layout;
        resolve(built);
      };
    });
  }

  public state_get(): ImageEngineState {
    return {
      engine: 'cornerstone', layout: this.layout, slice: 1, slices: this.series.files.length, tool: 'wl', primaryTool: 'wl',
      refused: 0, annotations: 0, filled: this.filled, loading: this.loading, stopped: this.stopped, held: this.held,
    };
  }

  public ghost_set(): boolean { return false; }
  public slice_set(): boolean { return true; }
  public wl_set(): boolean { return true; }
  public colormap_set(): boolean { return true; }
  public tool_set(): boolean { return true; }
  public toolsOffered_get(): readonly string[] { return ['wl', 'zoom', 'pan', 'length', 'angle', 'probe']; }
  public async annotations_export(): Promise<Blob | null> { return null; }
  public async annotations_import(): Promise<number> { return 0; }
  public dispose(): void { this.disposed = true; }
}

jest.unstable_mockModule('../../src/features/image/cornerstoneEngine.js', () => ({ CornerstoneEngine: FakeEngine }));

/** The volume viewer's stand-in: the same stand-in, made from a path, and counted apart. */
class FakeVolumeEngine extends FakeEngine {
  public static volumes: number = 0;
  constructor(host: ImageEngineHost, public readonly path: string) {
    super(host, { files: [path] } as unknown as DicomSeriesModel);
    FakeVolumeEngine.volumes += 1;
  }
}
jest.unstable_mockModule('../../src/features/image/niivueEngine.js', () => ({ NiivueEngine: FakeVolumeEngine }));

const { ImagePanel, STOP_LABEL, RESUME_LABEL, REOPEN_LABEL, OPENING_STOPPED_READOUT } = await import('../../src/features/image/panel.js');
const { chrisDicom_make } = await import('../../src/compositions/chris/dicom.js');
const { PanelRoster } = await import('../../src/app/panes.js');
const { keys_wire } = await import('../../src/app/keys.js');
type Panel = InstanceType<typeof ImagePanel>;

/** The image pane's template, read from the page. */
const TEMPLATE: string = ((): string => {
  const html: string = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const found: RegExpExecArray | null = /<template id="tpl-pane-image">([\s\S]*?)<\/template>/.exec(html);
  if (found === null) throw new Error('the page has no image pane template');
  return found[1] as string;
})();

/** A made-up series of so many slices. */
function series_make(slices: number): DicomSeriesModel {
  const files: string[] = Array.from({ length: slices }, (_, at: number): string => `/home/someone/uploads/series-a/${String(at + 1).padStart(4, '0')}-9.9.9.${at + 1}.dcm`);
  return {
    path: '/home/someone/uploads/series-a', seriesInstanceUID: '9.9.9', studyInstanceUID: '9.9', modality: 'MR', seriesDescription: 'MADE UP SERIES',
    instances: slices, frames: 1, order: 'filename', bytes: slices * 1000, header: files[0] as string, files, annotations: [],
  } as DicomSeriesModel;
}

interface Stage {
  panel: Panel;
  pane: HTMLElement;
  stop: HTMLButtonElement;
  state: HTMLElement;
  field: HTMLElement;
  notes: string[];
}

/** Stands an image pane on the page's own markup. */
function stage_make(): Stage {
  document.body.innerHTML = TEMPLATE;
  const pane: HTMLElement = document.body.firstElementChild as HTMLElement;
  const notes: string[] = [];
  const panel: Panel = new ImagePanel(pane, {
    source: { url_resolve: (file: string): string => `/vfs?path=${encodeURIComponent(file)}` },
    note: (line: string): void => { notes.push(line); },
    regard: (): void => undefined,
    file_put: async (): Promise<number> => 200,
    tags_open: (): void => undefined,
    tags_read: async (): Promise<null> => null,
  });
  return {
    panel, pane, notes,
    stop: pane.querySelector('.image-stop') as HTMLButtonElement,
    state: pane.querySelector('.pane-state') as HTMLElement,
    field: pane.querySelector('.image-field') as HTMLElement,
  };
}

/** Lets the pane's awaits run: the engine's chunk is a dynamic import, which takes more than a microtask. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
};

/** A series shown and its fill under way: the frame is LOADING. */
async function loading_reach(stage: Stage, slices: number = 120): Promise<FakeEngine> {
  void stage.panel.series_show(series_make(slices));
  await settle();
  const engine: FakeEngine = FakeEngine.last as FakeEngine;
  engine.open_end();
  await settle();
  return engine;
}

/** Whether anything on the frame reads as a refusal. */
function refusal_find(stage: Stage): boolean {
  return stage.pane.querySelector('.image-working-failed') !== null
    || stage.state.classList.contains('state-refused')
    || /REFUSED|NOT A READABLE/.test(stage.state.textContent ?? '');
}

beforeEach((): void => { FakeEngine.last = null; FakeEngine.made = 0; FakeVolumeEngine.volumes = 0; });

/** The capsules a person can see on the field, by their words. */
function fieldControls_read(stage: Stage): string[] {
  return [...stage.field.querySelectorAll<HTMLButtonElement>('.image-field-stop')]
    .filter((capsule: HTMLButtonElement): boolean => !capsule.hidden)
    .map((capsule: HTMLButtonElement): string => capsule.textContent ?? '');
}

/** The capsule on the field with these words. */
function fieldControl_find(stage: Stage, words: string): HTMLButtonElement {
  const found: HTMLButtonElement | undefined = [...stage.field.querySelectorAll<HTMLButtonElement>('.image-field-stop')]
    .find((capsule: HTMLButtonElement): boolean => !capsule.hidden && capsule.textContent === words);
  if (found === undefined) throw new Error(`no ${words} on the field`);
  return found;
}

describe('the control a person sees on the field', () => {
  it('is a capsule in the working notice, under its track, while the frame is OPENING', () => {
    const stage: Stage = stage_make();
    let ended: number = 0;
    stage.panel.opening_show('/home/someone/uploads/series-a', (): void => { ended += 1; });
    const notice: HTMLElement = stage.field.querySelector('.image-working') as HTMLElement;
    const capsule: HTMLButtonElement = fieldControl_find(stage, STOP_LABEL);
    expect(capsule.tagName).toBe('BUTTON');
    expect(capsule.className).toBe('pacs-capsule image-field-stop');
    expect(capsule.parentElement).toBe(notice);
    expect([...notice.children].map((child: Element): string => child.className)).toEqual(
      ['image-working-label', 'image-working-track', 'image-working-count', 'pacs-capsule image-field-stop']);
    capsule.click();
    expect(ended).toBe(1);
    expect(stage.state.textContent).toBe(OPENING_STOPPED_READOUT);
  });

  it('is not drawn on a notice whose wait cannot be stopped, nor on one that failed', () => {
    const stage: Stage = stage_make();
    stage.panel.opening_show('/home/someone/uploads/volume.nii.gz');
    expect(fieldControls_read(stage)).toEqual([]);
    stage.panel.opening_show('/home/someone/uploads/series-a', (): void => undefined);
    stage.panel.opening_fail('/home/someone/uploads/series-a', 'NOT A READABLE SERIES');
    expect(fieldControls_read(stage)).toEqual([]);
  });

  it('stands in the notice while the frame is LOADING; pressed, the corner says how far and offers LOAD REST', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(36);
    expect(fieldControls_read(stage)).toEqual([STOP_LABEL]);
    expect(stage.field.querySelector('.image-stopped-note')).toBeNull();
    fieldControl_find(stage, STOP_LABEL).click();
    await settle();
    expect(engine.stops).toBe(1);
    const corner: HTMLElement = stage.field.querySelector('.image-stopped-note') as HTMLElement;
    expect(corner.querySelector('.image-stopped-words')?.textContent).toBe('STOPPED AT 37 OF 120');
    expect(fieldControls_read(stage)).toEqual([RESUME_LABEL]);
    expect(fieldControl_find(stage, RESUME_LABEL).className).toBe('pacs-capsule image-field-stop');
    expect(fieldControl_find(stage, RESUME_LABEL).parentElement).toBe(corner);
    fieldControl_find(stage, RESUME_LABEL).click();
    await settle();
    expect(engine.fills).toBe(2);
    expect(stage.field.querySelector('.image-stopped-note')).toBeNull();
    expect(fieldControls_read(stage)).toEqual([STOP_LABEL]);
    engine.slices_land(83);
    expect(fieldControls_read(stage)).toEqual([]);
    expect(stage.field.querySelector('.image-stopped-note')).toBeNull();
  });

  it('puts the corner note back when the engine clears the field', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(5);
    fieldControl_find(stage, STOP_LABEL).click();
    await settle();
    stage.field.replaceChildren();
    engine.host.readout_set('SLICE 2 OF 120 · STOPPED AT 6 OF 120');
    expect(stage.field.querySelector('.image-stopped-words')?.textContent).toBe('STOPPED AT 6 OF 120');
    expect(fieldControls_read(stage)).toEqual([RESUME_LABEL]);
  });

  it('a stopped open keeps its notice and offers OPEN AGAIN, which asks again', async () => {
    const stage: Stage = stage_make();
    const panels = new PanelRoster();
    panels.set('image', 'image-1', stage.panel);
    const asked: Array<{ line: string; answer: (outcome: ExecuteOutcome) => void }> = [];
    const noted: string[] = [];
    const ctx = {
      client: () => ({
        line_execute: (line: string): Promise<ExecuteOutcome> => new Promise<ExecuteOutcome>((resolve): void => { asked.push({ line, answer: resolve }); }),
      }),
      panels: () => panels,
      terminal: () => ({ line_note: (line: string): void => { noted.push(line); } }),
      launcher_yield: (): void => undefined,
      vfsUrl_build: (file: string): string => `/vfs?path=${encodeURIComponent(file)}`,
    } as unknown as ChrisDicomContext;
    const opening: Promise<string> = chrisDicom_make(ctx).image_open('image-1', '/home/someone/uploads/series-a');
    await settle();
    fieldControl_find(stage, STOP_LABEL).click();
    asked[0]?.answer({ envelopes: [], liveChannels: new Set() } as unknown as ExecuteOutcome);
    await opening;
    expect(fieldControls_read(stage)).toEqual([REOPEN_LABEL]);
    expect(stage.field.querySelector('.image-working-label')?.textContent).toBe('STOPPED');
    fieldControl_find(stage, REOPEN_LABEL).click();
    await settle();
    expect(asked.map((ask): string => ask.line)).toEqual(["dcm series '/home/someone/uploads/series-a'", "dcm series '/home/someone/uploads/series-a'"]);
    expect(stage.panel.wait_get()).toBe('opening');
    expect(fieldControls_read(stage)).toEqual([STOP_LABEL]);
    asked[1]?.answer({ envelopes: [{ status: 'ok', rendered: '', model: { kind: 'dicom.series', data: series_make(4) } }], liveChannels: new Set() } as unknown as ExecuteOutcome);
    await settle();
    expect(FakeEngine.made).toBe(1);
    expect(noted.at(-1)).toBe('image /home/someone/uploads/series-a');
  });
});

describe('several opens of one frame', () => {
  it('only the latest puts a series on the field: an earlier answer builds no engine to tear down', async () => {
    const stage: Stage = stage_make();
    const panels = new PanelRoster();
    panels.set('image', 'image-1', stage.panel);
    const answers: Array<(outcome: ExecuteOutcome) => void> = [];
    const ctx = {
      client: () => ({ line_execute: (): Promise<ExecuteOutcome> => new Promise<ExecuteOutcome>((resolve): void => { answers.push(resolve); }) }),
      panels: () => panels,
      launcher_yield: (): void => undefined,
      vfsUrl_build: (file: string): string => `/vfs?path=${encodeURIComponent(file)}`,
    } as unknown as ChrisDicomContext;
    const dicom = chrisDicom_make(ctx);
    const opens: Array<Promise<string>> = [1, 2, 3].map((): Promise<string> => dicom.image_open('image-1', '/home/someone/uploads/series-a'));
    await settle();
    const series = { envelopes: [{ status: 'ok', rendered: '', model: { kind: 'dicom.series', data: series_make(4) } }], liveChannels: new Set() } as unknown as ExecuteOutcome;
    for (const answer of answers) answer(series);
    const lines: string[] = await Promise.all(opens);
    await settle();
    expect(FakeEngine.made).toBe(1);
    expect(lines.filter((line: string): boolean => line.includes('a later open took the pane'))).toHaveLength(2);
    expect(lines.at(-1)).toBe('image /home/someone/uploads/series-a');
  });
});

describe('the STOP block', () => {
  it('reuses the frame\'s own block markup, hidden on a frame at rest', () => {
    const stage: Stage = stage_make();
    expect(stage.stop.tagName).toBe('BUTTON');
    expect(stage.stop.className).toBe('strategy-pill image-stop');
    expect(stage.stop.closest('.mode-frame')).not.toBeNull();
    expect(stage.stop.hidden).toBe(true);
    expect(stage.panel.wait_get()).toBeNull();
  });

  it('stands while the frame is OPENING, and goes when the open ends unreadable', () => {
    const stage: Stage = stage_make();
    stage.panel.opening_show('/home/someone/uploads/series-a', (): void => undefined);
    expect(stage.state.textContent).toBe('OPENING');
    expect(stage.stop.hidden).toBe(false);
    expect(stage.stop.textContent).toBe(STOP_LABEL);
    expect(stage.pane.dataset['wait']).toBe('opening');
    stage.panel.opening_fail('/home/someone/uploads/series-a', 'NOT A READABLE SERIES');
    expect(stage.stop.hidden).toBe(true);
    expect(stage.pane.dataset['wait']).toBeUndefined();
  });

  it('is not offered for an open that cannot be stopped', () => {
    const stage: Stage = stage_make();
    stage.panel.opening_show('/home/someone/uploads/volume.nii.gz');
    expect(stage.stop.hidden).toBe(true);
    expect(stage.panel.wait_stop()).toBe(false);
  });

  it('stands while the frame is LOADING and goes when the last slice lands', async () => {
    const stage: Stage = stage_make();
    void stage.panel.series_show(series_make(120));
    await settle();
    const engine: FakeEngine = FakeEngine.last as FakeEngine;
    expect(stage.state.textContent).toBe('LOADING 1 OF 120');
    expect(stage.stop.hidden).toBe(false);
    engine.open_end();
    await settle();
    expect(engine.fills).toBe(1);
    expect(stage.panel.wait_get()).toBe('loading');
    expect(stage.stop.textContent).toBe(STOP_LABEL);
    engine.slices_land(119);
    expect(stage.stop.hidden).toBe(true);
    expect(stage.panel.wait_get()).toBeNull();
  });
});

describe('STOP while LOADING', () => {
  it('stops the engine\'s fetch, keeps what arrived, and says so with the count', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(36);
    stage.stop.click();
    await settle();
    expect(engine.stops).toBe(1);
    expect(engine.disposed).toBe(false);
    expect(stage.state.textContent).toBe('SLICE 1 OF 120 · STOPPED AT 37 OF 120');
    expect(stage.pane.querySelector('.image-working')).toBeNull();
    expect(stage.panel.state_get()?.held).toBe(37);
  });

  it('then reads LOAD REST, which fetches the rest and puts STOP back', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(36);
    stage.stop.click();
    await settle();
    expect(stage.stop.hidden).toBe(false);
    expect(stage.stop.textContent).toBe(RESUME_LABEL);
    expect(stage.pane.dataset['wait']).toBe('stopped');
    stage.stop.click();
    await settle();
    expect(engine.fills).toBe(2);
    expect(engine.stops).toBe(1);
    expect(stage.state.textContent).toBe('LOADING 37 OF 120');
    expect(stage.stop.textContent).toBe(STOP_LABEL);
    engine.slices_land(83);
    expect(stage.stop.hidden).toBe(true);
    expect(stage.state.textContent).toBe('SLICE 1 OF 120');
  });

  it('stopped while the first slice arrives, asks for no other until LOAD REST', async () => {
    const stage: Stage = stage_make();
    void stage.panel.series_show(series_make(120));
    await settle();
    const engine: FakeEngine = FakeEngine.last as FakeEngine;
    stage.stop.click();
    engine.open_end();
    await settle();
    expect(engine.fills).toBe(0);
    expect(stage.stop.textContent).toBe(RESUME_LABEL);
    expect(stage.state.textContent).toBe('SLICE 1 OF 120 · STOPPED AT 1 OF 120');
  });

  it('wears no refusal: no failed notice, no refused state, no RETRY', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(10);
    stage.stop.click();
    await settle();
    expect(refusal_find(stage)).toBe(false);
    expect((stage.pane.querySelector('.image-retry') as HTMLElement).hidden).toBe(true);
    expect(stage.notes.some((line: string): boolean => /refus|error|fail/i.test(line))).toBe(false);
  });

  it('a layout stopped while its slices arrive waits, and LOAD REST builds it', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage, 40);
    engine.slices_land(39);
    const building: Promise<boolean> = stage.panel.layout_set('mpr');
    await settle();
    expect(stage.stop.hidden).toBe(false);
    expect(stage.stop.textContent).toBe(STOP_LABEL);
    stage.stop.click();
    engine.layout_end(false);
    expect(await building).toBe(false);
    expect(stage.panel.state_get()?.waiting).toBe('mpr');
    expect(stage.stop.textContent).toBe(RESUME_LABEL);
    expect(stage.notes.some((line: string): boolean => line.includes('not offered'))).toBe(false);
    expect((stage.pane.querySelector('.image-layout[data-layout="single"]') as HTMLElement).classList.contains('rail-off')).toBe(false);
    stage.stop.click();
    await settle();
    expect(engine.layoutsAsked).toEqual(['mpr', 'mpr']);
    engine.layout_end(true);
    await settle();
    expect(stage.panel.state_get()?.layout).toBe('mpr');
  });
});

describe('a layout asked for while one is being built', () => {
  const lit = (stage: Stage, layout: string): boolean => !(stage.pane.querySelector(`.image-layout[data-layout="${layout}"]`) as HTMLElement).classList.contains('rail-off');

  it('the same layout pressed again joins the build under way: one build, and a stop of it still waits for LOAD REST', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage, 40);
    engine.slices_land(39);
    const first: Promise<boolean> = stage.panel.layout_set('mpr');
    await settle();
    // MPR is pressed again while its slices arrive.
    const second: Promise<boolean> = stage.panel.layout_set('mpr');
    await settle();
    expect(engine.layoutsAsked).toEqual(['mpr']);
    // STOP ends the build.
    stage.stop.click();
    engine.layout_end(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    // The field is back on the stack, the pill says so, and the layout waits for LOAD REST.
    expect(stage.panel.state_get()?.waiting).toBe('mpr');
    expect(lit(stage, 'single')).toBe(true);
    expect(lit(stage, 'mpr')).toBe(false);
    expect(stage.stop.textContent).toBe(RESUME_LABEL);
    stage.stop.click();
    await settle();
    expect(engine.layoutsAsked).toEqual(['mpr', 'mpr']);
    engine.layout_end(true);
    await settle();
    expect(stage.panel.state_get()?.layout).toBe('mpr');
  });

  it('another layout chosen meanwhile is the one that stands: the first one\'s late answer repaints no pill and clears no progress', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage, 40);
    engine.slices_land(40);
    const mpr: Promise<boolean> = stage.panel.layout_set('mpr');
    await settle();
    const mpr_end: (built: boolean) => void = engine.layout_end;
    // 3D is chosen before MPR is built, and is built.
    const render: Promise<boolean> = stage.panel.layout_set('3d');
    await settle();
    expect(lit(stage, '3d')).toBe(true);
    const mode: HTMLElement = stage.pane.querySelector('.pane-mode') as HTMLElement;
    const progress: string | null = stage.pane.querySelector('.image-working')?.textContent ?? null;
    // MPR's build, replaced, answers late and says it did not stand.
    mpr_end(false);
    expect(await mpr).toBe(false);
    await settle();
    expect(lit(stage, '3d')).toBe(true);
    expect(lit(stage, 'mpr')).toBe(false);
    expect(lit(stage, 'single')).toBe(false);
    expect(mode.textContent).toBe('3D');
    expect(stage.pane.querySelector('.image-working')?.textContent ?? null).toBe(progress);
    expect(stage.notes.some((line: string): boolean => line.includes('not offered'))).toBe(false);
    engine.layout_end(true);
    expect(await render).toBe(true);
    expect(lit(stage, '3d')).toBe(true);
  });
});

describe('a frame closed before its viewer exists', () => {
  it('makes no engine when the viewer\'s code arrives after the close', async () => {
    const stage: Stage = stage_make();
    // The series is shown, and the frame closes before the viewer's code has been fetched.
    void stage.panel.series_show(series_make(10));
    stage.panel.dispose();
    await settle();
    await settle();
    expect(FakeEngine.made).toBe(0);
    expect(FakeEngine.last).toBeNull();
    // And a series handed to a closed frame afterwards makes none either.
    await stage.panel.series_show(series_make(10));
    await settle();
    expect(FakeEngine.made).toBe(0);
  });

  it('an open still asking for its header when the frame closes is no longer the frame\'s latest', () => {
    const stage: Stage = stage_make();
    const asking: number = stage.panel.opening_show('/home/someone/uploads/series-a', (): void => undefined);
    expect(stage.panel.opening_checkIsLatest(asking)).toBe(true);
    stage.panel.dispose();
    // Its header comes back now: whoever holds the answer is told it is stale, and shows nothing.
    expect(stage.panel.opening_checkIsLatest(asking)).toBe(false);
  });

  it('a series asked for before another makes no engine for the first when its viewer code arrives', async () => {
    const stage: Stage = stage_make();
    void stage.panel.series_show(series_make(10));
    void stage.panel.series_show(series_make(20));
    await settle();
    await settle();
    expect(FakeEngine.made).toBe(1);
    stage.panel.dispose();
  });
});

describe('one open owns the field, whichever viewer it is', () => {
  it('a volume shown and the frame closed before its viewer arrives makes no engine', async () => {
    const stage: Stage = stage_make();
    void stage.panel.volume_show('/home/someone/uploads/brain.nii.gz');
    stage.panel.dispose();
    await settle();
    await settle();
    expect(FakeVolumeEngine.volumes).toBe(0);
    expect(FakeEngine.made).toBe(0);
  });

  it('a series whose viewer arrives after a volume was shown opens nothing over it', async () => {
    const stage: Stage = stage_make();
    void stage.panel.series_show(series_make(10));
    void stage.panel.volume_show('/home/someone/uploads/brain.nii.gz');
    await settle();
    await settle();
    expect(FakeVolumeEngine.volumes).toBe(1);
    // One engine in all: the volume's. The series made none.
    expect(FakeEngine.made).toBe(1);
    expect(FakeEngine.last).toBeInstanceOf(FakeVolumeEngine);
    stage.panel.dispose();
  });

  it('a viewer\'s code that fails to arrive says so for the open that is current, and says nothing for one the field was given away from', async () => {
    const stage: Stage = stage_make();
    const inner = stage.panel as unknown as { chunk_import: (load: () => Promise<unknown>, shown: number) => Promise<unknown>; showSerial: number };
    const stalePage = (): Promise<never> => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/viewer-OLD.js'));
    // The open that is current: its failure is said.
    void stage.panel.series_show(series_make(10));
    await settle();
    (FakeEngine.last as FakeEngine).open_end();
    await settle();
    const words: string = stage.state.textContent ?? '';
    const noted: number = stage.notes.length;
    // An import begun for an earlier open, failing now: nothing is said over the viewer that is showing.
    expect(await inner.chunk_import(stalePage, inner.showSerial - 1)).toBeNull();
    expect(stage.state.textContent).toBe(words);
    expect(stage.notes.length).toBe(noted);
    // The same failure for the open that is current is said, on the frame and in a note.
    expect(await inner.chunk_import(stalePage, inner.showSerial)).toBeNull();
    expect(stage.state.textContent).not.toBe(words);
    expect(stage.notes.length).toBe(noted + 1);
    stage.panel.dispose();
  });

  it.each([['opens', true], ['is refused', false]])('an engine replaced while it opens paints nothing when it then %s: the field, its words and its notes are the later one\'s', async (_name: string, opens: boolean) => {
    const stage: Stage = stage_make();
    void stage.panel.series_show(series_make(10));
    await settle();
    const first: FakeEngine = FakeEngine.last as FakeEngine;
    // Another series is shown while the first is still opening, and opens.
    void stage.panel.series_show(series_make(30));
    await settle();
    const second: FakeEngine = FakeEngine.last as FakeEngine;
    expect(second).not.toBe(first);
    second.open_end();
    await settle();
    const words: string = stage.state.textContent ?? '';
    const noted: number = stage.notes.length;
    const working: string | null = stage.pane.querySelector('.image-working')?.textContent ?? null;
    const pills: string = [...stage.pane.querySelectorAll('.image-layout')].map((pill: Element): string => pill.className).join('|');
    // The first one's open settles now.
    if (opens) first.open_end(); else first.open_fail('the first slice could not be read');
    await settle();
    expect(stage.state.textContent).toBe(words);
    expect(stage.state.textContent).not.toBe('REFUSED');
    expect(stage.notes.length).toBe(noted);
    expect(stage.pane.querySelector('.image-working')?.textContent ?? null).toBe(working);
    expect([...stage.pane.querySelectorAll('.image-layout')].map((pill: Element): string => pill.className).join('|')).toBe(pills);
    expect(stage.panel.state_get()?.path).toBe(series_make(30).path);
    stage.panel.dispose();
  });
});

describe('STOP while OPENING', () => {
  it('ends the ask, and the frame says it was stopped in its own voice', () => {
    const stage: Stage = stage_make();
    let ended: number = 0;
    stage.panel.opening_show('/home/someone/uploads/series-a', (): void => { ended += 1; });
    stage.stop.click();
    expect(ended).toBe(1);
    expect(stage.state.textContent).toBe(OPENING_STOPPED_READOUT);
    expect(stage.stop.hidden).toBe(true);
    const notice: HTMLElement = stage.pane.querySelector('.image-working') as HTMLElement;
    expect(notice.querySelector('.image-working-label')?.textContent).toBe('STOPPED');
    expect(notice.querySelector('.image-working-count')?.textContent).toBe('/home/someone/uploads/series-a');
    expect(notice.classList.contains('image-working-stopped')).toBe(true);
    expect(notice.querySelector('.image-working-pacing')).toBeNull();
    expect(refusal_find(stage)).toBe(false);
    // Pressed once: a second press finds nothing to stop.
    expect(stage.panel.wait_stop()).toBe(false);
    expect(ended).toBe(1);
  });

  it('cancels the line in the session, sends no other, and shows no late answer', async () => {
    const stage: Stage = stage_make();
    const panels = new PanelRoster();
    panels.set('image', 'image-1', stage.panel);
    const asked: Array<{ line: string; signal: AbortSignal | undefined; answer: (outcome: ExecuteOutcome) => void }> = [];
    const ctx = {
      client: () => ({
        line_execute: (line: string, options?: { signal?: AbortSignal }): Promise<ExecuteOutcome> =>
          new Promise<ExecuteOutcome>((resolve): void => { asked.push({ line, signal: options?.signal, answer: resolve }); }),
      }),
      panels: () => panels,
      launcher_yield: (): void => undefined,
      vfsUrl_build: (file: string): string => `/vfs?path=${encodeURIComponent(file)}`,
    } as unknown as ChrisDicomContext;
    const opening: Promise<string> = chrisDicom_make(ctx).image_open('image-1', '/home/someone/uploads/series-a');
    await settle();
    expect(asked.map((ask): string => ask.line)).toEqual(["dcm series '/home/someone/uploads/series-a'"]);
    expect(stage.panel.wait_get()).toBe('opening');
    expect(asked[0]?.signal?.aborted).toBe(false);
    stage.stop.click();
    expect(asked[0]?.signal?.aborted).toBe(true);
    // The session's answer to a cancelled line, then nothing more is asked.
    asked[0]?.answer({ envelopes: [{ status: 'error', rendered: '', renderedErr: 'dcm series: stopped\n' }], liveChannels: new Set() } as unknown as ExecuteOutcome);
    expect(await opening).toBe('image: /home/someone/uploads/series-a: stopped');
    expect(asked).toHaveLength(1);
    expect(FakeEngine.last).toBeNull();
    expect(stage.state.textContent).toBe(OPENING_STOPPED_READOUT);
    expect(refusal_find(stage)).toBe(false);
  });
});

describe('Esc on the frame', () => {
  const press = (target: EventTarget): KeyboardEvent => {
    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it('with the field holding the keyboard, stops the load first and gives the keyboard back on the next press', async () => {
    const stage: Stage = stage_make();
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(4);
    stage.field.focus();
    expect(stage.panel.field_hasFocus()).toBe(true);
    press(stage.field);
    expect(engine.stops).toBe(1);
    expect(stage.panel.field_hasFocus()).toBe(true);
    expect(stage.stop.textContent).toBe(RESUME_LABEL);
    press(stage.field);
    expect(engine.stops).toBe(1);
    expect(stage.panel.field_hasFocus()).toBe(false);
  });

  it('with the frame the focused pane, stops an open; a frame that is not focused is left alone', () => {
    const stage: Stage = stage_make();
    const panels = new PanelRoster();
    panels.set('image', 'image-1', stage.panel);
    let focused: string | null = 'files';
    const sounds: string[] = [];
    const detach: () => void = keys_wire({
      layout: { focused_get: (): string | null => focused, panes_shown: (): string[] => ['files', 'image-1'] },
      panels,
      paneInstance_get: (): undefined => undefined,
      terminal: { ask_abandon: (): boolean => false, ask_isOpen: (): boolean => false },
      sound: (id: string): void => { sounds.push(id); },
    } as unknown as Parameters<typeof keys_wire>[0], {
      palette_isOpen: (): boolean => false,
      errand_abandon: (): boolean => false,
      drawers_close: (): boolean => false,
      modeFrames_close: (): boolean => false,
      dive_leave: (): boolean => false,
      overlay_escape: (): boolean => false,
    } as unknown as Parameters<typeof keys_wire>[1]);
    let ended: number = 0;
    stage.panel.opening_show('/home/someone/uploads/series-a', (): void => { ended += 1; });
    press(window);
    expect(ended).toBe(0);
    expect(stage.panel.wait_get()).toBe('opening');
    focused = 'image-1';
    press(window);
    expect(ended).toBe(1);
    expect(stage.state.textContent).toBe(OPENING_STOPPED_READOUT);
    // The retreat's own sound, the one every Esc makes: never an error's.
    expect(sounds).toEqual(['audio3']);
    detach();
  });
});

describe('image stop, the block\'s line', () => {
  it('stops the wait on the pane it names, and says when there is none', async () => {
    const { argusHost_build } = await import('../../src/app/consoleHost.js');
    const stage: Stage = stage_make();
    const panels = new PanelRoster();
    panels.set('image', 'image-1', stage.panel);
    const host = argusHost_build({
      layout: { panes_shown: (): string[] => ['image-1'], focused_get: (): string | null => 'image-1' },
      panels,
      paneInstance_get: (): undefined => undefined,
      subjects: { group_resolve: (id: string): string => id },
    } as unknown as Parameters<typeof argusHost_build>[0], { verbs: {} } as unknown as Parameters<typeof argusHost_build>[1]);
    const engine: FakeEngine = await loading_reach(stage);
    engine.slices_land(9);
    expect(await host.image_control('image-1', 'stop', [])).toBe('image stop');
    expect(engine.stops).toBe(1);
    expect(stage.stop.textContent).toBe(RESUME_LABEL);
    expect(await host.image_control('image-1', 'stop', [])).toBe('image stop: nothing is opening or loading');
    await host.image_control('image-1', 'load', []);
    expect(engine.fills).toBe(2);
  });
});
