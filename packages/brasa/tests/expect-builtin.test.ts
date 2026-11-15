/**
 * @file Unit tests for `expect`, the verb that makes a workflow a test.
 *
 * The claims worth pinning: a comparison between a counted number and a
 * written one must not fail on its quotes; a subject that cannot answer is
 * reported as not knowing rather than as a failed claim; `--within` keeps
 * asking and passes the moment the claim holds; and a claim that does not
 * hold exits non-zero, because that is the whole point of the verb.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

/** The cohort the fake session holds. */
let cohort: { version: number; name: string | null; feed: null; series: Array<Record<string, unknown>> } =
  { version: 1, name: null, feed: null, series: [] };

/** Statuses answered per ask, replayed in order; the last repeats. */
let statusAnswers: Array<Map<number, string>> = [];
let statusAsks: number = 0;

/** What a listing answers for a path. */
let listings: Map<string, Array<{ name: string; type?: string }>> = new Map();

/** Where CUBE says each series landed, by series UID. */
let storage: Map<string, { fileCount: number; folderPath: string | null }> = new Map();

cuminMock_install(() => ({
  seriesStorage_resolveMany: async () => ({ ok: true, value: storage }),
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  procCache_get: () => ({
    feed_get: (id: number) => (id === 4599
      ? { erroredJobs: 0, startedJobs: 0, scheduledJobs: 0, createdJobs: 0, cancelledJobs: 0, finishedJobs: 2 }
      : undefined),
  }),
  listCache_get: () => ({ cache_invalidate: (): void => undefined }),
}));

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  jobs_statusBatch: async (ids: number[]): Promise<Map<number, string>> => {
    const answer: Map<number, string> = statusAnswers[Math.min(statusAsks, statusAnswers.length - 1)]
      ?? new Map(ids.map((id: number): [number, string] => [id, 'finishedSuccessfully']));
    statusAsks += 1;
    return answer;
  },
  fileContent_get: async (): Promise<{ ok: boolean; value?: string }> => ({ ok: true, value: JSON.stringify(cohort) }),
  files_path_isDirectory: async (): Promise<boolean> => true,
}));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/touch.js', () => ({ files_touch: async (): Promise<boolean> => true }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/mkdir.js', () => ({ files_mkdir: async (): Promise<boolean> => true }));

jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({
  vfs: {
    data_get: async (target: string): Promise<{ ok: boolean; value?: Array<{ name: string; type?: string }> }> => {
      const held = listings.get(target);
      return held === undefined ? { ok: false } : { ok: true, value: held };
    },
  },
}));

jest.unstable_mockModule('../src/builtins/res/dicom.js', () => ({
  tagsModel_read: async (): Promise<{ ok: boolean; value: unknown }> => ({
    ok: true,
    value: {
      path: '/x', subject: 'folder', read: 1, of: 1, refused: [],
      constant: [{ tag: '(0010,0020)', name: 'PatientID', vr: 'LO', value: 'anon-001', group: 'patient', phi: true }],
      varying: [{
        tag: '(0008,0018)', name: 'SOPInstanceUID', vr: 'UI', group: 'instance', phi: false,
        distinct: 2, first: '1.2.3', last: '1.2.4',
        values: [{ path: 'a', value: '1.2.3' }, { path: 'b', value: '1.2.4' }],
      }],
    },
  }),
}));

jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  // Mirrors the real parser closely enough to matter here: a declared
  // boolean flag must NOT eat the operand after it, which is the whole
  // reason `--deep` is declared one.
  commandArgs_process: (args: string[], options: { booleanLongOptions?: readonly string[] } = {}) => {
    const flags: Set<string> = new Set(options.booleanLongOptions ?? []);
    const parsed: { _: string[]; [key: string]: string | boolean | string[] } = { _: [] };
    for (let i = 0; i < args.length; i++) {
      const arg: string = args[i];
      if (arg.startsWith('--')) {
        const name: string = arg.slice(2);
        if (flags.has(name)) { parsed[name] = true; continue; }
        parsed[name] = args[i + 1] ?? true;
        i++;
        continue;
      }
      parsed._.push(arg);
    }
    return parsed;
  },
  path_resolve: async (p: string): Promise<string> => p,
  storePath_resolve: async (p: string): Promise<string> => p,
}));

const { builtin_expect, claim_holds, duration_parse } = await import('../src/builtins/res/expect.js');
// The ChRIS world's subjects, registered as the ChRIS backend registers them.
const { chrisExpectSubjects } = await import('../src/chris/expectSubjects.js');
(await import('../src/core/backend.js')).backend_install({ id: 'chris', session: {} as never, expectSubjects: chrisExpectSubjects });

beforeEach(() => {
  cohort = { version: 1, name: null, feed: null, series: [] };
  storage = new Map();
  statusAnswers = [];
  statusAsks = 0;
  listings = new Map();
  process.exitCode = 0;
});

/** A cohort member, home or not. */
function member(vfsPath: string, home: boolean): Record<string, unknown> {
  return { vfsPath, kind: 'series', ...(home ? { folderPath: '/home/chris/feeds/feed_1' } : {}) };
}

describe('expect', () => {
  it('holds when the cohort is the size claimed, and says so', async () => {
    cohort.series = [member('/a', false), member('/b', false)];
    const envelope = await builtin_expect(['gather', 'size', 'eq', '2']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('✓');
    expect(process.exitCode).toBe(0);
  });

  it('REFUSES, non-zero, when it does not hold — with what it wanted and got', async () => {
    cohort.series = [member('/a', false)];
    const envelope = await builtin_expect(['gather', 'size', 'eq', '14']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('wanted  14');
    expect(envelope.renderedErr).toContain('got     1');
    expect(process.exitCode).toBe(1);
  });

  it('counts a member as home only once CUBE has said where it landed', async () => {
    cohort.series = [member('/a', true), member('/b', false)];
    expect((await builtin_expect(['gather', 'pulled', 'eq', '1'])).status).toBe('ok');
  });

  it('says how many members have not landed, so "all pulled" is one claim', async () => {
    cohort.series = [member('/a', true), member('/b', false)];
    expect((await builtin_expect(['gather', 'unpulled', 'eq', '1'])).status).toBe('ok');
    cohort.series = [member('/a', true)];
    expect((await builtin_expect(['gather', 'unpulled', 'eq', '0'])).status).toBe('ok');
  });

  it('asks CUBE where a series not yet noted on the cohort landed, by the UID its path names', async () => {
    cohort.series = [{ vfsPath: '/net/pacs/queries/q/Study_1.9_MRI/Series_1.2.3_SAG_T1', kind: 'series' }, member('/b', false)];
    storage = new Map([['1.2.3', { fileCount: 0, folderPath: '/home/chris/SERVICES/PACS/x/series' }]]);
    expect((await builtin_expect(['gather', 'unpulled', 'eq', '1'])).status).toBe('ok');
    expect((await builtin_expect(['gather', 'pulled', 'eq', '1'])).status).toBe('ok');
  });

  it('reads a feed status out of the session index', async () => {
    expect((await builtin_expect(['feed', '4599', 'status', 'eq', 'finishedSuccessfully'])).status).toBe('ok');
  });

  it('says a feed it has never indexed cannot answer, rather than calling the claim false', async () => {
    const envelope = await builtin_expect(['feed', '1', 'status', 'eq', 'finishedSuccessfully']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('not in this session');
  });

  it('keeps asking within the time given, and passes the moment the run settles', async () => {
    statusAnswers = [
      new Map([[601152, 'started']]),
      new Map([[601152, 'finishedSuccessfully']]),
    ];
    const envelope = await builtin_expect(['run', '601152', 'status', 'eq', 'finishedSuccessfully', '--within', '10s']);
    expect(envelope.status).toBe('ok');
    expect(statusAsks).toBeGreaterThan(1);
  }, 15000);

  it('gives up when the time is up, and says how long it waited', async () => {
    statusAnswers = [new Map([[601152, 'started']])];
    const envelope = await builtin_expect(['run', '601152', 'status', 'eq', 'finishedSuccessfully', '--within', '1s']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('waited');
  }, 15000);

  it('asserts on a DICOM tag, which is how an anonymization is proved', async () => {
    expect((await builtin_expect(['path', '/x', 'tags', 'PatientID', 'eq', 'anon-001'])).status).toBe('ok');
    expect((await builtin_expect(['path', '/x', 'tags', 'PatientID', 'notContains', '22119730'])).status).toBe('ok');
  });

  it('answers a varying tag with every value it takes, never just the first file s', async () => {
    const envelope = await builtin_expect(['path', '/x', 'tags', 'SOPInstanceUID', 'eq', '1.2.3']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('1.2.3, 1.2.4');
  });

  it('counts what a folder holds, narrowed by a pattern', async () => {
    listings.set('/out', [{ name: 'a.nii.gz' }, { name: 'b.nii' }, { name: 'log.txt' }]);
    expect((await builtin_expect(['path', '/out', 'count', 'eq', '3'])).status).toBe('ok');
    expect((await builtin_expect(['path', '/out', 'count', 'gt', '0', '--matching', '*.nii*'])).status).toBe('ok');
    expect((await builtin_expect(['path', '/out', 'count', 'eq', '3', '--matching', '*.nii*'])).status).toBe('error');
  });

  it('counts beneath the folder when a run filed its output in a tree', async () => {
    // pfdicom writes under share/incoming/<input tree>; a claim made at the
    // node's own folder must find what the run actually produced.
    listings.set('/out', [{ name: 'share', type: 'dir' }]);
    listings.set('/out/share', [{ name: 'incoming', type: 'dir' }]);
    listings.set('/out/share/incoming', [{ name: 'brain.nii.gz', type: 'file' }, { name: 'log.txt', type: 'file' }]);

    expect((await builtin_expect(['path', '/out', 'count', '--matching', '*.nii*', '--deep', 'eq', '1'])).status).toBe('ok');
    // Without --deep the same claim sees only the folder at the top.
    expect((await builtin_expect(['path', '/out', 'count', '--matching', '*.nii*', 'gt', '0'])).status).toBe('error');
  });

  it('prints the claim as it was made, narrowing included', async () => {
    listings.set('/out', [{ name: 'a.nii', type: 'file' }]);
    const envelope = await builtin_expect(['path', '/out', 'count', '--matching', '*.nii*', 'eq', '1']);
    expect(envelope.rendered).toContain("--matching '*.nii*'");
  });

  it('says whether a path is there, with exists as the whole claim', async () => {
    listings.set('/here', []);
    expect((await builtin_expect(['path', '/here', 'exists'])).status).toBe('ok');
    expect((await builtin_expect(['path', '/gone', 'exists'])).status).toBe('error');
  });

  it('refuses a comparison it does not know, by name', async () => {
    const envelope = await builtin_expect(['gather', 'size', 'approximately', '14']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('approximately');
  });

  it('refuses a subject it knows nothing about', async () => {
    const envelope = await builtin_expect(['weather', 'today', 'eq', 'fine']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('weather');
  });
});

describe('claim_holds', () => {
  it('reads a counted number and a written one as the same claim', () => {
    expect(claim_holds('14', 'eq', '14')).toEqual({ held: true });
    expect(claim_holds('14', 'ne', '13')).toEqual({ held: true });
  });

  it('refuses to compare text with a numeric predicate', () => {
    expect(claim_holds('running', 'gt', '3')).toEqual({ refusal: expect_refusal() });
  });

  it('matches on a regular expression, and refuses a broken one', () => {
    expect(claim_holds('feed_4599', 'matches', '^feed_\\d+$')).toEqual({ held: true });
    expect('refusal' in claim_holds('x', 'matches', '([')).toBe(true);
  });
});

describe('duration_parse', () => {
  it('reads the durations an operator writes', () => {
    expect(duration_parse('30s')).toBe(30000);
    expect(duration_parse('20m')).toBe(1200000);
    expect(duration_parse('2h')).toBe(7200000);
    expect(duration_parse('45')).toBe(45000);
    expect(duration_parse('soon')).toBeNull();
  });
});

/** The refusal text a numeric comparison gives for a non-number. */
function expect_refusal(): string {
  return 'gt compares numbers, and "running" is not one';
}

describe('the subjects come from the session', () => {
  it('names every subject this session has, merging one name across the core and the backend', async () => {
    const envelope = await builtin_expect(['domain', 'quay', 'verify', 'eq', '10']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('expect knows nothing about "domain" in this session — try path, gather, feed, run.');
    const property = await builtin_expect(['path', '/x', 'size', 'eq', '1']);
    expect(property.renderedErr).toContain('path has no property "size" — try exists, count, tags.');
  });
});
