/**
 * @jest-environment jsdom
 */
/**
 * @file A series whose pull ended without its files reads as ended.
 *
 * The defect these cover: a pull sent to the background on a silent PACS
 * left every series reading `RETRIEVING 0/1` with a bar pacing, for good.
 * A row whose pull is over says so in words, carries the reason, shows no
 * moving bar, and can be pulled again.
 *
 * The pane is the real one, standing on the page's own markup; the progress
 * messages are made up, so this needs neither a PACS nor a daemon.
 *
 * @module
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { PacsQueryModel, PacsSeries } from '@fnndsc/menu';
import type { ProgressMessage } from '../../src/calypso/client.js';
import {
  PacsPanel, badgeState_settle, badgeText_compose, badge_checkIsInFlight, badge_paint, seriesVerbs_offered,
  type BadgeState,
} from '../../src/features/pacs/panel.js';
import { PACS_STUDY_ROSTER, verbRule_get } from '../../src/features/roster/verbs.js';

/** Every state a retrieve can end a series in without its files. */
const ENDED: ReadonlyArray<string> = ['unconfirmed', 'stalled', 'timeout', 'error', 'unknown'];

/** A badge element painted from a state. */
function badge_make(state: BadgeState): HTMLElement {
  const badge: HTMLElement = document.createElement('span');
  badge_paint(badge, state);
  return badge;
}

describe('badgeText_compose', () => {
  it('reads NOT RECEIVED when none of the files came', () => {
    expect(badgeText_compose({ status: 'unconfirmed', current: 0, total: 1 })).toBe('NOT RECEIVED');
    expect(badgeText_compose({ status: 'unconfirmed' })).toBe('NOT RECEIVED');
  });

  it('says how far a series got when it began and then ended', () => {
    expect(badgeText_compose({ status: 'stalled', current: 12, total: 40 })).toBe('STOPPED AT 12/40');
    expect(badgeText_compose({ status: 'timeout', current: 12, total: 40 })).toBe('TIMED OUT AT 12/40');
    expect(badgeText_compose({ status: 'unconfirmed', current: 12, total: 40 })).toBe('? UNCONFIRMED 12/40');
    expect(badgeText_compose({ status: 'stalled', current: 3 })).toBe('STOPPED AT 3');
  });

  it('reads a failure as one, and a state with no words of its own as its name', () => {
    expect(badgeText_compose({ status: 'error', current: 0, total: 4 })).toBe('✗ ERROR');
    expect(badgeText_compose({ status: 'unknown' })).toBe('UNKNOWN');
  });

  it('keeps the tick for files in CUBE alone', () => {
    for (const status of ENDED) {
      for (const current of [0, 5]) {
        expect(badgeText_compose({ status, current, total: 9 })).not.toContain('✓');
      }
    }
    expect(badge_make({ status: 'done', total: 9 }).textContent).toBe('✓ 9 IN CUBE');
  });
});

describe('badge_paint', () => {
  it('draws a bar that moves only for a pull that is queued or running', () => {
    expect(badge_make({ status: 'queued' }).querySelector('.pacs-bar-pacing')).not.toBeNull();
    expect(badge_make({ status: 'running', current: 0, total: 1 }).querySelector('.pacs-bar-pacing')).not.toBeNull();
    for (const status of [...ENDED, 'done', 'idle']) {
      for (const current of [0, 5]) {
        const badge: HTMLElement = badge_make({ status, current, total: 9 });
        expect(badge.querySelector('.pacs-bar-pacing')).toBeNull();
        expect(badge.querySelector('.pacs-bar')).toBeNull();
      }
    }
  });

  it('carries the reason on the badge, and drops it when the next state has none', () => {
    const badge: HTMLElement = badge_make({ status: 'unconfirmed', current: 0, total: 1, reason: 'the PACS sent nothing for 60 s and CUBE has none of it' });
    expect(badge.textContent).toBe('NOT RECEIVED');
    expect(badge.title).toBe('the PACS sent nothing for 60 s and CUBE has none of it');
    expect(badge.dataset['state']).toBe('unconfirmed');
    badge_paint(badge, { status: 'queued' });
    expect(badge.hasAttribute('title')).toBe(false);
  });
});

describe('badgeState_settle', () => {
  it('ends a series still in flight, keeping what it had counted', () => {
    expect(badgeState_settle({ status: 'queued' })).toMatchObject({ status: 'unconfirmed', current: 0 });
    const settled: BadgeState | null = badgeState_settle({ status: 'running', current: 3, total: 8 });
    expect(settled).toMatchObject({ status: 'unconfirmed', current: 3, total: 8 });
    expect(settled?.reason).toMatch(/pull ended/);
    expect(badge_checkIsInFlight(settled as BadgeState)).toBe(false);
  });

  it('leaves a series that has had its own last word', () => {
    for (const status of [...ENDED, 'done', 'idle']) expect(badgeState_settle({ status })).toBeNull();
  });
});

/** A made-up answer: one study of two series, neither home. */
function model_make(): PacsQueryModel {
  const series = (uid: string, description: string): PacsSeries => ({
    seriesUID: uid, description, modality: 'MR', fileCount: 1, vfsPath: `/net/pacs/queries/q_qid:7/study/${description}`,
  });
  return {
    queryId: 7,
    vfsPath: '/net/pacs/queries/q_qid:7',
    pacsName: 'TESTPACS',
    expression: 'AccessionNumber:0000',
    studies: [{
      studyUID: '9.9', vfsPath: '/net/pacs/queries/q_qid:7/study', description: 'Made-up study', patientName: 'TEST^PERSON',
      patientId: '000', date: '', modalities: 'MR', accession: '0000', series: [series('9.9.1', 'SAG T1'), series('9.9.2', 'AX T2')],
    }],
  };
}

/** A per-series pull progress message, as a joblet's pull sends them. */
function progress_make(itemId: string | undefined, extra: Partial<ProgressMessage>): ProgressMessage {
  return {
    type: 'progress', id: 'joblet-1', operation: 'pull', kind: 'retrieve', phase: 'watching', unit: 'files',
    ...(itemId !== undefined ? { itemId } : {}), ...extra,
  } as ProgressMessage;
}

describe('the PACS pane, following a pull', () => {
  let panel: PacsPanel;
  let notes: string[];
  let lines: string[];

  /** The badge standing for a series. */
  const badge_find = (uid: string): HTMLElement => {
    const found: HTMLElement | null = document.querySelector<HTMLElement>(`.pacs-series[data-seriesuid="${uid}"] .pacs-badge`);
    if (found === null) throw new Error(`no badge for ${uid}`);
    return found;
  };
  /** Lets the pane's queued repaints run. */
  const settle = async (): Promise<void> => { await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 0); }); };

  beforeEach(async (): Promise<void> => {
    const page: string = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf-8');
    document.documentElement.innerHTML = page.replace(/<script[\s\S]*?<\/script>/g, '');
    notes = [];
    lines = [];
    const root: HTMLElement | null = document.getElementById('pacs-workspace');
    if (root === null) throw new Error('the page has no PACS workspace');
    panel = new PacsPanel(root, {
      command_run: (line: string): void => { lines.push(line); },
      command_show: (line: string): void => { lines.push(line); },
      note: (text: string): void => { notes.push(text); },
      workspace_close: (): void => undefined,
      image_open: (): void => undefined,
      dir_open: (): void => undefined,
      process_open: (): void => undefined,
      gather_add: (): void => undefined,
      gathered_is: (): boolean => false,
    } as unknown as ConstructorParameters<typeof PacsPanel>[1]);
    panel.envelope_observe({ status: 'ok', rendered: '', model: { kind: 'pacs.query', data: model_make() } } as never);
    await settle();
  });

  it('reads a silent series as NOT RECEIVED with its reason, says it once in the console, and stops the bar', async () => {
    const reason: string = 'the PACS sent nothing for 60 s and CUBE has none of it';
    panel.progress_observe(progress_make('9.9.1', { status: 'running', current: 0, total: 1 }));
    expect(badge_find('9.9.1').textContent).toBe('RETRIEVING 0/1');
    expect(badge_find('9.9.1').querySelector('.pacs-bar-pacing')).not.toBeNull();

    panel.progress_observe(progress_make('9.9.1', { status: 'unconfirmed', current: 0, total: 1 }));
    panel.progress_observe(progress_make('9.9.1', { phase: 'retrying', status: 'unconfirmed', current: 0, total: 1, reason }));
    panel.progress_observe(progress_make('9.9.1', { phase: 'retrying', status: 'unconfirmed', current: 0, total: 1, reason }));
    await settle();

    const badge: HTMLElement = badge_find('9.9.1');
    expect(badge.textContent).toBe('NOT RECEIVED');
    expect(badge.title).toBe(reason);
    expect(badge.querySelector('.pacs-bar')).toBeNull();
    expect(notes).toEqual([`pull: SAG T1: NOT RECEIVED, ${reason}`]);
  });

  it('counts a series that was not received as pullable again, and pulls it', async () => {
    const pull: HTMLElement = document.getElementById('pacs-pull-shown') as HTMLElement;
    expect(pull.textContent).toBe('PULL 2');
    panel.progress_observe(progress_make('9.9.1', { status: 'unconfirmed', current: 0, total: 1, reason: 'the PACS sent nothing' }));
    panel.progress_observe(progress_make('9.9.2', { status: 'done', current: 1, total: 1, path: '/SERVICES/PACS/TESTPACS/x' }));
    await settle();
    expect(pull.hidden).toBe(false);
    expect(pull.textContent).toBe('PULL 1');

    pull.click();
    expect(lines).toEqual(['pull "/net/pacs/queries/q_qid:7/study/SAG T1" &']);
    expect(badge_find('9.9.1').textContent).toBe('QUEUED');
    expect(badge_find('9.9.1').hasAttribute('title')).toBe(false);
  });

  it('keeps offering the row and the study their pull once a series has ended without its files', () => {
    const ended: PacsSeries = (model_make().studies[0] as PacsQueryModel['studies'][number]).series[0] as PacsSeries;
    expect(seriesVerbs_offered(ended).pull).toBe(true);
    expect(verbRule_get(PACS_STUDY_ROSTER, 'pullStudy').offered({ addressable: true, allInCube: false })).toBe(true);
  });

  it('settles a series the pull ended without a word on, and leaves the ones that had theirs', async () => {
    panel.progress_observe(progress_make('9.9.1', { status: 'running', current: 0, total: 1 }));
    panel.progress_observe(progress_make('9.9.2', { status: 'done', current: 1, total: 1 }));
    panel.progress_observe(progress_make(undefined, { phase: 'complete', unit: 'series', status: 'unconfirmed', current: 1, total: 2 }));
    await settle();
    expect(badge_find('9.9.1').textContent).toBe('NOT RECEIVED');
    expect(badge_find('9.9.1').title).toMatch(/pull ended/);
    expect(badge_find('9.9.1').querySelector('.pacs-bar')).toBeNull();
    expect(document.querySelector('.pacs-series[data-seriesuid="9.9.2"] .pacs-badge')?.textContent).toBe('✓ 1 IN CUBE');
  });

  it('does not settle a series another pull is still sending', async () => {
    panel.progress_observe(progress_make('9.9.1', { id: 'joblet-2', status: 'running', current: 0, total: 1 }));
    panel.progress_observe(progress_make(undefined, { id: 'joblet-1', phase: 'complete', unit: 'series', status: 'done', current: 0, total: 0 }));
    await settle();
    expect(badge_find('9.9.1').textContent).toBe('RETRIEVING 0/1');
  });
});
