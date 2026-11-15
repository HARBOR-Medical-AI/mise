/**
 * @file Unit tests for the cohort as a kernel subject.
 *
 * The claims worth pinning are the ones that decide whether a cohort built
 * by a script and a cohort built by a surface are the same cohort: identity
 * is the PATH, a second sighting merges rather than doubles, a record
 * written before members had kinds still reads, and the fields the kernel
 * has no name for survive a kernel rewrite.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

/** The cohort file's content, as the fake filesystem holds it. */
let stored: string | null = null;
/** Directories the code asked for. */
const madeDirs: string[] = [];
/** How many writes of the cohort file were asked for. */
let touches: number = 0;
/** How many of the next writes CUBE refuses. */
let touchFails: number = 0;
/** Listing paths the code invalidated after writing. */
const invalidated: string[] = [];
/** Paths the fake filesystem calls directories. */
const directories: Set<string> = new Set(['/home/chris/uploads/brain']);

/** Decoded query answers the PACS mount holds, by query id. */
const answers: Map<number, { raw: string; json: unknown }> = new Map([[7, {
  raw: '',
  json: [{
    StudyInstanceUID: '1.2',
    StudyDescription: 'MR Brain',
    PatientID: '4455667',
    PatientName: 'DOE^JANE',
    series: [
      { SeriesInstanceUID: '1.2.3', SeriesDescription: 'SAG T1', Modality: 'MR', NumberOfSeriesRelatedInstances: '176' },
      { SeriesInstanceUID: '1.2.4', SeriesDescription: 'AX FLAIR', Modality: 'MR', NumberOfSeriesRelatedInstances: '40' },
    ],
  }],
}]]);
/** Which answers were asked for. */
const answerReads: number[] = [];

/** Where CUBE says each series landed, by series UID. */
let storage: Map<string, { fileCount: number; folderPath: string | null }> = new Map();

cuminMock_install(() => ({
  seriesStorage_resolveMany: async () => ({ ok: true, value: storage }),
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  listCache_get: () => ({ cache_invalidate: (p: string): void => { invalidated.push(p); } }),
}));

/** Files the fake filesystem holds, by parent folder. */
const filesByFolder: Map<string, string[]> = new Map([
  ['/home/chris/uploads', ['notes.txt', 'brain']],
]);

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  fileContent_get: async (): Promise<{ ok: boolean; value?: string }> => (
    stored === null ? { ok: false } : { ok: true, value: stored }
  ),
  files_path_isDirectory: async (target: string): Promise<boolean> => directories.has(target),
  queryId_extractFromFolder: (folder: string): number => {
    const match: RegExpExecArray | null = /_qid:(\d+)/.exec(folder);
    return match ? Number(match[1]) : NaN;
  },
  // A file is gathered only when its parent says it is there.
  vfsDispatcher: {
    // The PACS mount's decoded answers, by query id.
    pacs: {
      queryResult_fetch: async (queryId: number): Promise<unknown> => {
        answerReads.push(queryId);
        return answers.get(queryId) ?? null;
      },
    },
    list: async (folder: string): Promise<{ ok: boolean; value?: Array<{ name: string }> }> => {
      const held: string[] | undefined = filesByFolder.get(folder);
      return held === undefined ? { ok: false } : { ok: true, value: held.map((name: string) => ({ name })) };
    },
  },
}));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/touch.js', () => ({
  files_touch: async (_target: string, options: { withContents?: string }): Promise<boolean> => {
    touches += 1;
    if (touchFails > 0) { touchFails -= 1; return false; }
    stored = options.withContents ?? '';
    return true;
  },
}));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/mkdir.js', () => ({
  files_mkdir: async (target: string): Promise<boolean> => { madeDirs.push(target); return true; },
}));

jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({
  // The table is chili's to render; these tests are about the cohort, so the
  // rows are rendered flat enough to assert on.
  table_render: (rows: Record<string, unknown>[], fields: string[]): string =>
    rows.map((row) => fields.map((f: string): string => `${row[f]}`).join('|')).join('\n'),
}));

jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  commandArgs_process: (args: string[]) => {
    const parsed: { _: string[] } = { _: [] };
    for (const arg of args) parsed._.push(arg);
    return parsed;
  },
  path_resolve: async (p: string): Promise<string> => (
    p.startsWith('/') || p.startsWith('~') ? p.replace(/^~/, '/home/chris') : `/home/chris/${p}`
  ),
  storePath_resolve: async (p: string): Promise<string> => (
    p.startsWith('/') || p.startsWith('~') ? p.replace(/^~/, '/home/chris') : `/home/chris/${p}`
  ),
}));

const { builtin_gather } = await import('../src/builtins/res/gather.js');
const { member_key, members_merge, members_drop, seriesUID_parse, cohortFolders_note, cohortFolders_resolve, cohort_read, cohortDirs_forget } = await import('../src/builtins/res/gather.store.js');

/** The cohort as the fake filesystem currently holds it. */
function cohort_held(): { name: string | null; series: Record<string, unknown>[] } {
  return JSON.parse(stored ?? '{"series":[]}') as { name: string | null; series: Record<string, unknown>[] };
}

beforeEach(() => {
  stored = null;
  storage = new Map();
  madeDirs.length = 0;
  cohortDirs_forget();
  touches = 0;
  touchFails = 0;
  invalidated.length = 0;
  answerReads.length = 0;
});

describe('gather', () => {
  it('says the cohort is empty before anything is gathered', async () => {
    const envelope = await builtin_gather([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toMatch(/empty/);
  });

  it('refuses a bare add or remove, saying what it takes, rather than guessing', async () => {
    const envelope = await builtin_gather(['add']);
    expect(envelope.status).toBe('error');
    expect(`${envelope.rendered}${envelope.renderedErr ?? ''}`).toMatch(/gather add: what\? give paths or handles \(@SER3\), \$\{listing\}, or pipe a listing in/);
  });

  it('takes a listing piped in as its operands', async () => {
    const { listingIn_set } = await import('../src/core/listing.js');
    const { answerAdapters_register } = await import('../src/session/answerAdapters.js');
    answerAdapters_register();
    listingIn_set({ kind: 'fs.listing', data: [{ path: '/home/chris/uploads', items: [{ name: 'brain', type: 'dir' }, { name: 'notes.txt', type: 'file' }] }] });
    await builtin_gather(['add']);
    expect(cohort_held().series.map((m) => m.vfsPath)).toEqual(['/home/chris/uploads/brain', '/home/chris/uploads/notes.txt']);
  });

  it('gathers a PACS projection as a series, keeping its UID', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.840.113619.2']);
    const held = cohort_held();
    expect(held.series).toHaveLength(1);
    expect(held.series[0].kind).toBe('series');
    expect(held.series[0].seriesUID).toBe('1.2.840.113619.2');
    expect(held.series[0].vfsPath).toBe('/net/pacs/queries/qid:1/1.2.840.113619.2');
  });

  it('fills a series\' facts from the query answer its path names, one read per query', async () => {
    const study: string = '/net/pacs/queries/MRN_4455667_qid:7/Study_1.2_MR_Brain';
    await builtin_gather(['add', `${study}/Series_1.2.3_SAG_T1`, `${study}/Series_1.2.4_AX_FLAIR`]);
    const held = cohort_held();
    expect(held.series[0]).toEqual(expect.objectContaining({
      seriesUID: '1.2.3', description: 'SAG T1', modality: 'MR', files: 176, patient: '4455667', study: 'MR Brain',
    }));
    expect(held.series[1]).toEqual(expect.objectContaining({ seriesUID: '1.2.4', description: 'AX FLAIR' }));
    expect(answerReads).toEqual([7]);
  });

  it('knows a gathered series CUBE already holds by its folder, from the gather on', async () => {
    storage = new Map([['1.2.3', { fileCount: 176, folderPath: '/SERVICES/PACS/orthanc/p/s/1-SAG_T1-abcdef0' }]]);
    const study: string = '/net/pacs/queries/MRN_4455667_qid:7/Study_1.2_MR_Brain';
    const answered = await builtin_gather(['add', `${study}/Series_1.2.3_SAG_T1`, `${study}/Series_1.2.4_AX_FLAIR`]);
    const held = cohort_held();
    expect(held.series[0].folderPath).toBe('/SERVICES/PACS/orthanc/p/s/1-SAG_T1-abcdef0');
    expect(held.series[1].folderPath).toBeUndefined();
    // The answer a surface redraws from carries it too.
    expect((answered.model?.data as { series: Array<{ folderPath?: string }> }).series[0].folderPath).toBe('/SERVICES/PACS/orthanc/p/s/1-SAG_T1-abcdef0');
    storage = new Map();
  });

  it('gathers a series bare when its answer cannot be read', async () => {
    const envelope = await builtin_gather(['add', '/net/pacs/queries/X_qid:99/Study_9_a/Series_9.9_b']);
    expect(envelope.status).toBe('ok');
    expect(cohort_held().series[0]).toEqual(expect.objectContaining({ seriesUID: '9.9' }));
    expect(cohort_held().series[0].description).toBeUndefined();
  });

  it('calls a gathered folder imagery by its name, and a folder of anything else not', async () => {
    directories.add('/home/chris/uploads/00002-SAG_T1-678f278');
    filesByFolder.set('/home/chris/uploads', ['notes.txt', 'brain', '00002-SAG_T1-678f278']);
    await builtin_gather(['add', '/home/chris/uploads/00002-SAG_T1-678f278', '/home/chris/uploads/brain']);
    const held = cohort_held();
    expect(held.series[0].imagery).toBe(true);
    expect(held.series[1].imagery).toBeUndefined();
  });

  it('answers a name with the cohort, so a surface takes the name from the kernel', async () => {
    const envelope = await builtin_gather(['name', 'sag', 'cohort']);
    expect(envelope.model).toEqual(expect.objectContaining({ kind: 'gather.cohort', data: expect.objectContaining({ name: 'sag cohort' }) }));
  });

  it('asks the filesystem whether a gathered place is a directory', async () => {
    await builtin_gather(['add', '/home/chris/uploads/brain', '/home/chris/uploads/notes.txt']);
    const kinds: unknown[] = cohort_held().series.map((m) => m.kind);
    expect(kinds).toEqual(['dir', 'file']);
  });

  it('merges a second sighting rather than holding it twice', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    expect(cohort_held().series).toHaveLength(1);
  });

  it('resolves a relative operand against the session, so `gather add .` means here', async () => {
    await builtin_gather(['add', 'uploads/brain']);
    expect(cohort_held().series[0].vfsPath).toBe('/home/chris/uploads/brain');
  });

  it('creates the holding directory and invalidates the listing it wrote into', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    expect(madeDirs).toContain('/home/chris/gather');
    expect(invalidated).toContain('/home/chris/gather');
  });

  it('makes the holding directory once, not on every write', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    await builtin_gather(['add', '/net/pacs/queries/qid:1/4.5.6']);
    expect(madeDirs).toEqual(['/home/chris/gather']);
  });

  it('writes the cohort once per gather, with the folders CUBE named in it', async () => {
    storage.set('1.2.3', { fileCount: 3, folderPath: '/home/chris/PACS/s1' });
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    expect(touches).toBe(1);
    expect(cohort_held().series[0]?.folderPath).toBe('/home/chris/PACS/s1');
  });

  it('makes the directory again when a write finds it gone, and refuses a write CUBE will not take', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    madeDirs.length = 0;
    touchFails = 1;
    const again = await builtin_gather(['add', '/net/pacs/queries/qid:1/4.5.6']);
    expect(again.status).toBe('ok');
    expect(madeDirs).toEqual(['/home/chris/gather']);
    touchFails = 2;
    const refused = await builtin_gather(['add', '/net/pacs/queries/qid:1/7.8.9']);
    expect(refused.status).toBe('error');
    expect(refused.renderedErr).toContain('could not write');
  });

  it('removes by the index the operator read back', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3', '/net/pacs/queries/qid:1/4.5.6']);
    const envelope = await builtin_gather(['remove', '1']);
    expect(envelope.status).toBe('ok');
    const paths: unknown[] = cohort_held().series.map((m) => m.vfsPath);
    expect(paths).toEqual(['/net/pacs/queries/qid:1/4.5.6']);
  });

  it('refuses to remove what it is not holding, by name', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    const envelope = await builtin_gather(['remove', '/net/pacs/queries/qid:1/9.9.9']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toMatch(/9\.9\.9/);
    expect(cohort_held().series).toHaveLength(1);
  });

  it('clears the name and the feed with the members', async () => {
    await builtin_gather(['add', '/net/pacs/queries/qid:1/1.2.3']);
    await builtin_gather(['name', 'sag', 'cohort']);
    expect(cohort_held().name).toBe('sag cohort');
    await builtin_gather(['clear']);
    expect(cohort_held().series).toHaveLength(0);
    expect(cohort_held().name).toBeNull();
  });

  it('reads a cohort written before members had paths, and keeps what it does not understand', async () => {
    stored = JSON.stringify({
      version: 1, name: 'from the surface', feed: null,
      series: [{ seriesUID: '1.2.3', description: 'SAG T1', patient: '1279049', studyFacts: { extra: true } }],
    });
    await builtin_gather(['add', '/home/chris/uploads/brain']);
    const held = cohort_held();
    expect(held.series).toHaveLength(2);
    expect(held.series[0].studyFacts).toEqual({ extra: true });
    expect(held.name).toBe('from the surface');
  });

  it('refuses an unknown subcommand by name', async () => {
    const envelope = await builtin_gather(['frobnicate']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toMatch(/frobnicate/);
  });
});

describe('cohort membership', () => {
  it('keys a member by its path, falling back to the UID of an older record', () => {
    expect(member_key({ vfsPath: '/a', kind: 'dir' })).toBe('/a');
    expect(member_key({ vfsPath: '', kind: 'series', seriesUID: '1.2.3' })).toBe('1.2.3');
  });

  it('merges what a later sighting knows onto what the cohort held', () => {
    const { members, added, merged } = members_merge(
      [{ vfsPath: '/a', kind: 'series', description: 'SAG' }],
      [{ vfsPath: '/a', kind: 'series', folderPath: '/home/chris/feeds/feed_1' }],
    );
    expect(added).toBe(0);
    expect(merged).toBe(1);
    expect(members[0].description).toBe('SAG');
    expect(members[0].folderPath).toBe('/home/chris/feeds/feed_1');
  });

  it('names what it could not drop', () => {
    const { dropped, missing } = members_drop([{ vfsPath: '/a', kind: 'dir' }], ['/a', '/b']);
    expect(dropped).toBe(1);
    expect(missing).toEqual(['/b']);
  });
});

describe('what is not there', () => {
  it('refuses to gather a path that names nothing, before taking anything', async () => {
    const envelope = await builtin_gather(['add', '/home/chris/uploads/brain', '/home/chris/uploads/nope.txt']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('nope.txt');
    expect(envelope.renderedErr).toContain('nothing is there');
    expect(stored).toBeNull();
  });
});

describe('where a gathered series landed', () => {
  const SERIES = '/net/pacs/queries/q/Study_1.9_MRI_BRAIN/Series_1.2.3_SAG_T1';

  it('reads the series UID from a query path, in either form', () => {
    expect(seriesUID_parse(SERIES)).toBe('1.2.3');
    expect(seriesUID_parse('/net/pacs/x/1.2.3')).toBe('1.2.3');
    expect(seriesUID_parse('/net/pacs/q/Study_1.9_MRI_BRAIN')).toBeUndefined();
    expect(seriesUID_parse('/home/chris/uploads/brain')).toBeUndefined();
  });

  it('notes the folder a pull reports on the member that stands for the series', async () => {
    stored = JSON.stringify({ version: 1, name: null, feed: null, series: [{ vfsPath: SERIES, kind: 'series' }, { vfsPath: '/home/chris/uploads/brain', kind: 'dir' }] });
    expect(await cohortFolders_note(new Map([['1.2.3', '/home/chris/SERVICES/PACS/s']]))).toBe(1);
    expect(cohort_held().series[0]).toMatchObject({ seriesUID: '1.2.3', folderPath: '/home/chris/SERVICES/PACS/s' });
    expect(cohort_held().series[1]).toEqual({ vfsPath: '/home/chris/uploads/brain', kind: 'dir' });
  });

  it('leaves the cohort file alone when a pull reports nothing it holds', async () => {
    stored = JSON.stringify({ version: 1, name: null, feed: null, series: [{ vfsPath: SERIES, kind: 'series' }] });
    const before: string | null = stored;
    expect(await cohortFolders_note(new Map([['9.9.9', '/elsewhere']]))).toBe(0);
    expect(stored).toBe(before);
  });

  it('asks CUBE for a member not yet known to be home, and keeps what it says', async () => {
    stored = JSON.stringify({ version: 1, name: null, feed: null, series: [{ vfsPath: SERIES, kind: 'series' }, { vfsPath: '/net/pacs/q/Study_1.9_X/Series_4.5_AX', kind: 'series' }] });
    storage = new Map([['1.2.3', { fileCount: 0, folderPath: '/home/chris/SERVICES/PACS/s' }]]);
    const state = await cohortFolders_resolve(await cohort_read());
    expect(state.series[0].folderPath).toBe('/home/chris/SERVICES/PACS/s');
    expect(state.series[1].folderPath).toBeUndefined();
    expect(cohort_held().series[0]).toMatchObject({ folderPath: '/home/chris/SERVICES/PACS/s' });
  });
});
