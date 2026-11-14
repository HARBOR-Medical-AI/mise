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
import type { PacsQueryModel, PacsSeries, WireEnvelope } from '@fnndsc/menu';
import type { ProgressMessage } from '../../src/calypso/client.js';
import {
  PacsPanel, badgeState_settle, badgeText_compose, badge_checkIsFault, badge_checkIsInFlight, badge_paint, jobEnd_parse,
  pullEndReason_derive, pullLine_compose, seriesVerbs_offered,
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

  it('takes the reason it is given: the pull\'s own error', () => {
    expect(badgeState_settle({ status: 'queued' }, 'the pull failed: exit 1')).toEqual({ status: 'unconfirmed', current: 0, reason: 'the pull failed: exit 1' });
  });
});

describe('badge_checkIsFault', () => {
  it('is a fault when the files did not come, stopped, ran out of time or failed', () => {
    expect(badge_checkIsFault({ status: 'unconfirmed', current: 0, total: 1 })).toBe(true);
    expect(badge_checkIsFault({ status: 'stalled', current: 12, total: 40 })).toBe(true);
    expect(badge_checkIsFault({ status: 'timeout', current: 12, total: 40 })).toBe(true);
    expect(badge_checkIsFault({ status: 'error' })).toBe(true);
  });

  it('is not one for a series in flight, home, never asked, or still arriving when the watch lost it', () => {
    for (const status of ['queued', 'running', 'done', 'idle']) expect(badge_checkIsFault({ status })).toBe(false);
    expect(badge_checkIsFault({ status: 'unconfirmed', current: 12, total: 40 })).toBe(false);
  });

  it('marks the badge, in the alert hue the stylesheet gives a fault', () => {
    expect(badge_make({ status: 'unconfirmed', current: 0, total: 1 }).hasAttribute('data-fault')).toBe(true);
    const badge: HTMLElement = badge_make({ status: 'stalled', current: 3, total: 9 });
    badge_paint(badge, { status: 'queued' });
    expect(badge.hasAttribute('data-fault')).toBe(false);
    const sheet: string = fs.readFileSync(path.join(process.cwd(), 'src/lcars/argus.css'), 'utf-8');
    expect(sheet).toMatch(/\.pacs-badge\[data-fault\] \{[^}]*color: var\(--state-error\);[^}]*\}/);
  });
});

describe('pullLine_compose', () => {
  it('quotes every path as one word, keeping spaces, a single quote and a $ as they are', () => {
    expect(pullLine_compose(["/net/pacs/queries/q_qid:7/study/O'BRIEN $HOME T1", '/net/pacs/queries/q_qid:7/study/AX T2']))
      .toBe("pull '/net/pacs/queries/q_qid:7/study/O'\\''BRIEN $HOME T1' '/net/pacs/queries/q_qid:7/study/AX T2' &");
    expect(pullLine_compose(['/net/pacs/queries/q_qid:7/study'])).toBe("pull '/net/pacs/queries/q_qid:7/study' &");
  });
});

describe('a pull\'s joblet end', () => {
  it('is read from the session\'s job notice, and nothing else', () => {
    const end = jobEnd_parse({ status: 'ok', rendered: '', model: { kind: 'tasks.job', data: { id: '1', source: 'joblets', label: 'pull /q', state: 'failed', outcome: 'exit 1' } } } as WireEnvelope);
    expect(end).toEqual({ source: 'joblets', label: 'pull /q', state: 'failed', outcome: 'exit 1' });
    expect(jobEnd_parse({ status: 'ok', rendered: '', model: { kind: 'joblet.started', data: { number: 1, line: 'pull /q' } } } as WireEnvelope)).toBeNull();
    expect(jobEnd_parse({ status: 'ok', rendered: '', model: { kind: 'tasks.job', data: { source: 'joblets' } } } as WireEnvelope)).toBeNull();
    expect(jobEnd_parse({ status: 'ok', rendered: '' } as WireEnvelope)).toBeNull();
  });

  it('gives the series its pull queued the pull\'s own reason', () => {
    expect(pullEndReason_derive({ source: 'joblets', label: 'pull /q', state: 'failed', outcome: 'pull: CUBE answered 503' })).toBe('the pull failed: pull: CUBE answered 503');
    expect(pullEndReason_derive({ source: 'joblets', label: 'pull /q', state: 'failed' })).toBe('the pull failed: it gave no reason');
    expect(pullEndReason_derive({ source: 'joblets', label: 'pull /q', state: 'cancelled' })).toMatch(/was stopped/);
    expect(pullEndReason_derive({ source: 'joblets', label: 'pull /q', state: 'done' })).toMatch(/pull ended/);
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
  /** What each pull the pane sends answers with; a start notice unless a test says otherwise. */
  let answer: (line: string) => Promise<ReadonlyArray<WireEnvelope>>;

  /** The badge standing for a series. */
  const badge_find = (uid: string): HTMLElement => {
    const found: HTMLElement | null = document.querySelector<HTMLElement>(`.pacs-series[data-seriesuid="${uid}"] .pacs-badge`);
    if (found === null) throw new Error(`no badge for ${uid}`);
    return found;
  };
  /** What a series' badge says, without the PULL a fault carries. */
  const badgeText_read = (uid: string): string => badge_find(uid).querySelector('.pacs-badge-note')?.textContent ?? '';
  /** The PULL a fault carries on its own row, if any. */
  const rowPull_find = (uid: string): HTMLButtonElement | null => badge_find(uid).querySelector<HTMLButtonElement>('.listing-action');
  /** Lets the pane's queued repaints and the pull's answer run. */
  const settle = async (): Promise<void> => { await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 0); }); };
  /** The session's notice that a joblet ended, as it reaches the page. */
  const jobEnd_make = (label: string, state: string, outcome?: string): WireEnvelope => ({
    status: 'ok', rendered: `[1]+ ${state}  ${label}\n`,
    model: { kind: 'tasks.job', data: { id: '1', source: 'joblets', label, state, ...(outcome !== undefined ? { outcome } : {}) } },
  } as WireEnvelope);
  /** A joblet's start notice, as the session answers a line ending `&`. */
  const started_make = (line: string): WireEnvelope => ({
    status: 'ok', rendered: `[1] ${line}\n`,
    model: { kind: 'joblet.started', data: { number: 1, line: line.replace(/ &$/, ''), path: '/proc/joblets/1' } },
  } as WireEnvelope);

  beforeEach(async (): Promise<void> => {
    const page: string = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf-8');
    document.documentElement.innerHTML = page.replace(/<script[\s\S]*?<\/script>/g, '');
    notes = [];
    lines = [];
    answer = async (line: string): Promise<ReadonlyArray<WireEnvelope>> => [started_make(line)];
    const root: HTMLElement | null = document.getElementById('pacs-workspace');
    if (root === null) throw new Error('the page has no PACS workspace');
    panel = new PacsPanel(root, {
      command_run: (line: string): void => { lines.push(line); },
      command_show: (line: string): void => { lines.push(line); },
      pull_run: (line: string): Promise<ReadonlyArray<WireEnvelope>> => { lines.push(line); return answer(line); },
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
    expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
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
    expect(lines).toEqual(["pull '/net/pacs/queries/q_qid:7/study/SAG T1' &"]);
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
    expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
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

  describe('a pull that ends before it reports on a series it queued', () => {
    /** The PULL N block over the listing. */
    const pullShown_find = (): HTMLElement => document.getElementById('pacs-pull-shown') as HTMLElement;
    const LINE: string = "pull '/net/pacs/queries/q_qid:7/study/SAG T1' '/net/pacs/queries/q_qid:7/study/AX T2'";

    it('settles every series it queued as NOT RECEIVED, with the pull\'s own error, when its joblet fails', async () => {
      pullShown_find().click();
      await settle();
      expect(badge_find('9.9.1').textContent).toBe('QUEUED');
      expect(lines).toEqual([`${LINE} &`]);

      panel.jobEnd_observe(jobEnd_make(LINE, 'failed', 'pull: CUBE answered 503'));
      await settle();
      for (const uid of ['9.9.1', '9.9.2']) {
        expect(badgeText_read(uid)).toBe('NOT RECEIVED');
        expect(badge_find(uid).title).toBe('the pull failed: pull: CUBE answered 503');
        expect(badge_find(uid).querySelector('.pacs-bar')).toBeNull();
      }
      expect(notes).toContain('pull: SAG T1: NOT RECEIVED, the pull failed: pull: CUBE answered 503');
      expect(notes).toContain('pull: AX T2: NOT RECEIVED, the pull failed: pull: CUBE answered 503');
      // Both can be pulled again.
      expect(pullShown_find().textContent).toBe('PULL 2');
    });

    it('settles them when the session refuses the pull at its start', async () => {
      answer = async (): Promise<ReadonlyArray<WireEnvelope>> => [
        { status: 'error', rendered: '', renderedErr: 'pull: this session runs no joblets\n' } as WireEnvelope,
      ];
      pullShown_find().click();
      await settle();
      expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
      expect(badge_find('9.9.1').title).toBe('the pull could not start: pull: this session runs no joblets');
      expect(badgeText_read('9.9.2')).toBe('NOT RECEIVED');
    });

    it('settles them when the line never reaches the session', async () => {
      answer = async (): Promise<ReadonlyArray<WireEnvelope>> => { throw new Error('the daemon is not connected'); };
      pullShown_find().click();
      await settle();
      expect(badge_find('9.9.1').title).toBe('the pull could not start: the daemon is not connected');
      expect(badgeText_read('9.9.2')).toBe('NOT RECEIVED');
    });

    it('settles them when the pull is stopped, and when it ends having said nothing', async () => {
      const row: string = "pull '/net/pacs/queries/q_qid:7/study/SAG T1'";
      panel.progress_observe(progress_make('9.9.1', { status: 'stalled', current: 0, total: 1 }));
      await settle();
      rowPull_find('9.9.1')?.click();
      await settle();
      expect(badge_find('9.9.1').textContent).toBe('QUEUED');
      panel.jobEnd_observe(jobEnd_make(row, 'cancelled', 'stopped when asked'));
      await settle();
      expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
      expect(badge_find('9.9.1').title).toMatch(/was stopped/);

      rowPull_find('9.9.1')?.click();
      await settle();
      expect(badge_find('9.9.1').textContent).toBe('QUEUED');
      panel.jobEnd_observe(jobEnd_make(row, 'done'));
      await settle();
      expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
      expect(badge_find('9.9.1').title).toMatch(/pull ended/);
    });

    it('leaves a series the pull did report on with its own last word', async () => {
      pullShown_find().click();
      panel.progress_observe(progress_make('9.9.2', { status: 'done', current: 1, total: 1 }));
      await settle();
      panel.jobEnd_observe(jobEnd_make(LINE, 'failed', 'exit 1'));
      await settle();
      expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
      expect(badge_find('9.9.2').textContent).toBe('✓ 1 IN CUBE');
    });

    it('leaves a series another press still has queued, and ignores ends that are not its own', async () => {
      const row: string = "pull '/net/pacs/queries/q_qid:7/study/SAG T1'";
      panel.progress_observe(progress_make('9.9.1', { status: 'stalled', current: 0, total: 1 }));
      await settle();
      rowPull_find('9.9.1')?.click();
      pullShown_find().click();
      await settle();
      panel.jobEnd_observe(jobEnd_make('pull /net/pacs/queries/q_qid:9', 'failed', 'not this one'));
      panel.jobEnd_observe({ status: 'ok', rendered: '', model: { kind: 'tasks.job', data: { source: 'feeds', label: row, state: 'failed' } } } as WireEnvelope);
      await settle();
      expect(badge_find('9.9.1').textContent).toBe('QUEUED');

      // The row's own pull ends; the frame's PULL 2 still has SAG T1 queued.
      panel.jobEnd_observe(jobEnd_make(row, 'failed', 'exit 1'));
      await settle();
      expect(badge_find('9.9.1').textContent).toBe('QUEUED');

      panel.jobEnd_observe(jobEnd_make(LINE, 'failed', 'exit 1'));
      await settle();
      expect(badgeText_read('9.9.1')).toBe('NOT RECEIVED');
      expect(badgeText_read('9.9.2')).toBe('NOT RECEIVED');
    });
  });

  describe('an ended row', () => {
    it('reads as a fault and carries its own PULL, which pulls that series again', async () => {
      panel.progress_observe(progress_make('9.9.1', { status: 'unconfirmed', current: 0, total: 1, reason: 'the PACS sent nothing for 60 s and CUBE has none of it' }));
      await settle();
      const badge: HTMLElement = badge_find('9.9.1');
      expect(badge.hasAttribute('data-fault')).toBe(true);
      const pull: HTMLButtonElement | null = rowPull_find('9.9.1');
      expect(pull?.textContent).toBe('PULL');

      pull?.click();
      expect(lines).toEqual(["pull '/net/pacs/queries/q_qid:7/study/SAG T1' &"]);
      expect(badge_find('9.9.1').textContent).toBe('QUEUED');
      expect(badge_find('9.9.1').hasAttribute('data-fault')).toBe(false);
      expect(rowPull_find('9.9.1')).toBeNull();
    });

    it('is a fault when it stopped or timed out, and not when the watch lost sight of files arriving', async () => {
      panel.progress_observe(progress_make('9.9.1', { status: 'stalled', current: 12, total: 40 }));
      panel.progress_observe(progress_make('9.9.2', { status: 'unconfirmed', current: 12, total: 40 }));
      await settle();
      expect(badgeText_read('9.9.1')).toBe('STOPPED AT 12/40');
      expect(badge_find('9.9.1').hasAttribute('data-fault')).toBe(true);
      expect(rowPull_find('9.9.1')).not.toBeNull();
      expect(badgeText_read('9.9.2')).toBe('? UNCONFIRMED 12/40');
      expect(badge_find('9.9.2').hasAttribute('data-fault')).toBe(false);
      expect(rowPull_find('9.9.2')).toBeNull();

      panel.progress_observe(progress_make('9.9.2', { status: 'timeout', current: 12, total: 40 }));
      await settle();
      expect(badgeText_read('9.9.2')).toBe('TIMED OUT AT 12/40');
      expect(rowPull_find('9.9.2')).not.toBeNull();
    });

    it('sends a path with spaces, a single quote and a $ quoted, from every press', async () => {
      const awkward: PacsQueryModel = model_make();
      const study: PacsQueryModel['studies'][number] = awkward.studies[0] as PacsQueryModel['studies'][number];
      const odd: PacsSeries = { ...(study.series[0] as PacsSeries), vfsPath: "/net/pacs/queries/q_qid:8/study/O'BRIEN $HOME T1" };
      awkward.queryId = 8;
      study.series = [odd];
      panel.envelope_observe({ status: 'ok', rendered: '', model: { kind: 'pacs.query', data: awkward } } as never);
      await settle();
      const quoted: string = "pull '/net/pacs/queries/q_qid:8/study/O'\\''BRIEN $HOME T1' &";

      (document.getElementById('pacs-pull-shown') as HTMLElement).click();
      panel.progress_observe(progress_make('9.9.1', { status: 'unconfirmed', current: 0, total: 1 }));
      await settle();
      rowPull_find('9.9.1')?.click();
      expect(lines).toEqual([quoted, quoted]);
    });

    it('carries no PULL when the series came home', async () => {
      panel.progress_observe(progress_make('9.9.1', { status: 'done', current: 1, total: 1 }));
      await settle();
      expect(rowPull_find('9.9.1')).toBeNull();
      expect(badge_find('9.9.1').hasAttribute('data-fault')).toBe(false);
    });
  });
});
