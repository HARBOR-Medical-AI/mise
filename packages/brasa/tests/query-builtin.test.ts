import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chrisHelp_install } from './support/chrisHelp.js';

chrisHelp_install();
import { cuminMock_install } from './support/cuminMock.js';

const mockPush = jest.fn();
const mockPop = jest.fn();
const mockGetAll = jest.fn(() => [] as unknown[]);
const mockCurrentGet = jest.fn(async () => null as string | null);
const mockUserGet = jest.fn(async () => null as string | null);
const mockQueryGet = jest.fn();
const mockDecode = jest.fn();
const mockCreate = jest.fn();
const mockServersList = jest.fn();
const mockIndexFind = jest.fn(() => null as unknown);
const mockIndexNote = jest.fn();
const mockIndexDrop = jest.fn();
cuminMock_install(() => ({
  seriesStorage_resolve: jest.fn(async () => ({ ok: false })),
  seriesStorage_resolveMany: jest.fn(async () => ({ ok: true, value: new Map() })),
  tag_extractValue: (v) => (v && typeof v === 'object' && 'value' in v ? String(v.value ?? '') : String(v ?? '')),
  studies_extractFromDecoded: jest.fn(() => []),
  series_extractFromStudy: jest.fn(() => []),
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  errorStack: { stack_push: mockPush, stack_pop: mockPop, stack_getAll: mockGetAll, checkpoint_mark: jest.fn(() => 1), checkpoint_drain: jest.fn(() => []) },
  Ok: (value: unknown) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
  chrisContext: { current_get: mockCurrentGet, ChRISuser_get: mockUserGet },
  Context: { PACSserver: 'PACSserver', ChRISuser: 'ChRISuser' },
  pacsQuery_get: mockQueryGet,
  pacsQuery_resultDecode: mockDecode,
  pacsQueries_create: mockCreate,
  listCache_get: () => ({ cache_invalidate: jest.fn(), cache_invalidateTree: jest.fn() }),
  queryIndex_get: () => ({ entry_note: mockIndexNote, entry_find: mockIndexFind, entry_drop: mockIndexDrop }),
  pacsServers_list: mockServersList,
}));

const mockTable = jest.fn(() => 'TABLE_OUT');
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({ screen: { table_output: mockTable } }));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({
  spinner: { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() },
}));
// A failed question strips the stack's debug prefix before the reason
// becomes data; the builtins' utils module pulls the session and storage
// stacks, which this suite has no business loading.
const mockPrompt = jest.fn<(request: Record<string, unknown>) => Promise<string>>();
const mockCwd = jest.fn<() => Promise<string>>(async () => '/home/chris');
const mockFilesCreate = jest.fn<(csv: string, destination: string) => Promise<boolean>>(async () => true);
jest.unstable_mockModule('../src/core/question.js', () => ({
  repl_questionPath: (message: string, path: unknown, commit?: string): Promise<string> =>
    mockPrompt({ message, wants: 'path', path, commit }),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: mockCwd } }));
// Rendering a table and putting it somewhere have one owner; this suite
// tests the ASK around them, so the writer is stubbed and the renderer's
// own behaviour is pinned in query-csv.test.ts.
jest.unstable_mockModule('../src/builtins/net/query.csv.js', () => ({
  pacsAnswer_renderCsv: (): string => '"MRN"\n"1234"\n',
  pacsAnswer_renderTable: (_model: unknown, level: string = 'study'): string => `TABLE ${level}\n`,
  csvFile_write: (csv: string, destination: string): Promise<{ ok: boolean; path?: string; message?: string }> =>
    mockFilesCreate(csv, destination).then((written: boolean) => (
      written ? { ok: true, path: destination } : { ok: false, message: `could not write ${destination}` })),
}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  error_stripDebugPrefix: (message: string): string => message.replace(/^\[[^\]]+\]\s*\|\s*/, ''),
  path_resolve: async (p: string): Promise<string> => p.replace('~', '/home/chris'),
}));

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

const { pacsQuery_createAndWait, builtin_query, queryCommand } = await import('../src/builtins/net/query.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockCurrentGet.mockResolvedValue(null);
  mockIndexFind.mockReturnValue(null);
  mockUserGet.mockResolvedValue(null);
  mockServersList.mockResolvedValue(ok([{ id: 1, identifier: 'PACSDCM' }]));
  mockGetAll.mockReturnValue([]);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
});

const studyPayload = [{
  StudyDescription: 'Brain Study',
  PatientName: { value: 'DOE^JANE' },
  PatientID: '1234',
  StudyDate: '20240101',
  ModalitiesInStudy: 'MR',
  AccessionNumber: 'A100',
  series: [
    { SeriesDescription: 'T1 MPRAGE', Modality: 'MR', NumberOfSeriesRelatedInstances: { value: '176' } },
  ],
}];

describe('pacsQuery_createAndWait', () => {
  it('rejects an invalid query expression', async () => {
    expect(await pacsQuery_createAndWait('nocolon', 'T', 'PACSDCM')).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('error', expect.stringContaining('Invalid expression'));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns null when the query create fails', async () => {
    mockCreate.mockResolvedValue(err());
    expect(await pacsQuery_createAndWait('PatientID:X', 'T', 'PACSDCM')).toBeNull();
  });

  it('resolves with the query id, VFS path and decoded payload', async () => {
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'working' }));
    mockDecode.mockResolvedValue(ok({ json: {} }));
    const onStatus = jest.fn();
    const result = await pacsQuery_createAndWait('PatientID:X', 'T', 'PACSDCM', onStatus);
    expect(result).toEqual({
      queryId: 9,
      vfsPath: '/net/pacs/queries/PatientID:X_qid:9_chris',
      decoded: { json: {} },
    });
    expect(mockCreate).toHaveBeenCalledWith('PACSDCM', { title: 'T', query: JSON.stringify({ PatientID: 'X' }) });
    expect(onStatus).toHaveBeenCalledWith('Query 9 — working');
  });

  it('reports a pending status while the query record is unreadable', async () => {
    mockCreate.mockResolvedValue(ok({ id: 3 }));
    mockQueryGet.mockResolvedValue(err());
    mockDecode.mockResolvedValue(ok({ json: [] }));
    const onStatus = jest.fn();
    await pacsQuery_createAndWait('PatientID:X', 'T', 'PACSDCM', onStatus);
    expect(onStatus).toHaveBeenCalledWith('Query 3 — pending');
  });

  it('times out when the result never populates', async () => {
    jest.useFakeTimers();
    mockCreate.mockResolvedValue(ok({ id: 5 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'working' }));
    mockDecode.mockResolvedValue(ok({}));
    const pending = pacsQuery_createAndWait('PatientID:X', 'T', 'PACSDCM');
    await jest.advanceTimersByTimeAsync(61_000);
    expect(await pending).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('error', expect.stringContaining('Timed out waiting for query 5'));
  });

  it('pops the transient decode error pushed by each poll probe', async () => {
    jest.useFakeTimers();
    mockCreate.mockResolvedValue(ok({ id: 5 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'working' }));
    mockDecode
      .mockResolvedValueOnce(err())
      .mockResolvedValueOnce(err())
      .mockResolvedValue(ok({ json: [] }));
    const pending = pacsQuery_createAndWait('PatientID:X', 'T', 'PACSDCM');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await pending).not.toBeNull();
    expect(mockPop).toHaveBeenCalledTimes(2);
  });

  it('completes with an empty result when the query succeeds with no matches', async () => {
    jest.useFakeTimers();
    mockCreate.mockResolvedValue(ok({ id: 6 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(err());
    const pending = pacsQuery_createAndWait('PatientID:ghost', 'T', 'PACSDCM');
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result).not.toBeNull();
    expect(result?.decoded.json).toBeUndefined();
    expect(mockPush).not.toHaveBeenCalledWith('error', expect.stringContaining('Timed out'));
  });
});

describe('builtin_query', () => {
  it('takes its usage from its declaration, --csv-to\'s path optional', async () => {
    expect(commandUsage_render(queryCommand)).toContain('[--csv-to [<cfs-path>]]');
    expect(commandUsage_render(queryCommand)).toMatch(/\[expression…\]$/);
  });

  it('parses its question and options anywhere on the line; a value option needs its value', async () => {
    const parsed = await commandLine_parse(queryCommand, shellWords_tokenize('--title "a b" PatientID:X --pacsserver=SYNTH --series'));
    expect(parsed.ok && parsed.args.operands).toEqual({ expression: ['PatientID:X'] });
    expect(parsed.ok && parsed.args.options).toEqual(expect.objectContaining({ title: 'a b', pacsserver: 'SYNTH', series: true, csvTo: undefined }));
    const refused = await commandLine_parse(queryCommand, shellWords_tokenize('PatientID:X --title'));
    expect(!refused.ok && refused.refusal).toMatch(/^query: option '--title' wants a value \(<title>\); usage: query /);
    // A wildcard in a question is the PACS's to read: it is never matched against CFS.
    const wild = await commandLine_parse(queryCommand, shellWords_tokenize('PatientName:SMITH*'));
    expect(wild.ok && wild.args.operands).toEqual({ expression: ['PatientName:SMITH*'] });
    expect(queryCommand.help.category).toBe('PACS');
    expect(queryCommand.holds).toBeUndefined();
  });

  it('requires a query expression', async () => {
    const envelope = await builtin_query([]);
    expect(envelope.renderedErr).toContain('Missing query expression');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an invalid expression before creating anything', async () => {
    const envelope = await builtin_query(['nocolon']);
    expect(envelope.renderedErr).toContain('Invalid expression');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors when no PACS server can be resolved', async () => {
    mockServersList.mockResolvedValue(ok([]));
    const envelope = await builtin_query(['PatientID:X']);
    expect(envelope.renderedErr).toContain('No PACS server available');
    expect(process.exitCode).toBe(1);
  });

  it('defaults to the first registered server when no context is set', async () => {
    mockServersList.mockResolvedValue(ok([{ id: 4, identifier: 'PACSDCM' }]));
    mockCreate.mockResolvedValue(ok({ id: 9 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: studyPayload }));
    await builtin_query(['PatientID:X']);
    expect(mockCreate).toHaveBeenCalledWith('4', expect.anything());
  });

  it('renders the study/series summary and prints the VFS path', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: studyPayload }));
    const { rendered: output } = await builtin_query(['PatientID:X']);
    expect(output).toContain('Query 9 complete');
    expect(output).toContain('Brain Study');
    expect(output).toContain('T1 MPRAGE');
    expect(output).toContain('/net/pacs/queries/PatientID:X_qid:9_chris');
  });

  it('renders the answer\'s rows as a table with --table, one per study', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(ok({ id: 9 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: studyPayload }));
    const envelope = await builtin_query(['PatientID:X', '--table', '--title', 'My Query']);
    expect(envelope.rendered).toContain('TABLE study');
    expect(mockCreate).toHaveBeenCalledWith('PACSDCM', expect.objectContaining({ title: 'My Query' }));
  });

  it('answers one row per series with --series, the series table when no format is named', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(ok({ id: 9 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: studyPayload }));
    const envelope = await builtin_query(['PatientID:X', '--series']);
    expect(envelope.rendered).toContain('TABLE series');
  });

  it('refuses a flag it does not know, by name', async () => {
    const envelope = await builtin_query(['PatientID:X', '--sereis']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr ?? envelope.rendered).toContain("query: unrecognized option '--sereis'");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses --csv with --table: two formats for one screen', async () => {
    const envelope = await builtin_query(['PatientID:X', '--csv', '--table']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr ?? envelope.rendered).toContain('--csv and --table are two formats');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('honours a --pacsserver override', async () => {
    mockCreate.mockResolvedValue(ok({ id: 9 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: studyPayload }));
    await builtin_query(['PatientID:X', '--pacsserver', '5']);
    expect(mockCreate).toHaveBeenCalledWith('5', expect.anything());
    // The override settles the server, so the context is never asked for
    // one. It IS asked who is asking, which the replay lookup is keyed on.
    expect(mockCurrentGet).not.toHaveBeenCalledWith('PACSserver');
  });

  it('warns without browse hints when the query completes with no studies', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(ok({ id: 9 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: null }));
    const { rendered: output } = await builtin_query(['PatientID:X']);
    expect(output).toContain('no studies found');
    expect(output).not.toContain('VFS path');
    expect(output).not.toContain('pull /net/pacs');
  });

  it('reports a generic failure when the error stack is empty', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(err());
    const envelope = await builtin_query(['PatientID:X']);
    expect(envelope.renderedErr).toContain('query: Failed');
    expect(process.exitCode).toBe(1);
  });

  it('prints the stacked errors on failure', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(err());
    mockGetAll.mockReturnValue([{ message: 'PACS server refused the query' }]);
    const envelope = await builtin_query(['PatientID:X']);
    expect(envelope.renderedErr).toContain('PACS server refused the query');
    expect(envelope.renderedErr).not.toContain('pacs_users');
    expect(process.exitCode).toBe(1);
  });

  it('a query CUBE refused for want of permission says the account needs pacs_users', async () => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    mockCreate.mockResolvedValue(err());
    mockGetAll.mockReturnValue([
      { message: '[pacsServers_list] | Failed to list PACS servers: You do not have permission to perform this action.' },
      { message: '[pacsServer_resolve] | Failed to resolve PACS server "PACSDCM": You do not have permission to perform this action.' },
    ]);
    const envelope = await builtin_query(['PatientID:X']);
    expect(envelope.renderedErr).toContain('You do not have permission');
    expect(envelope.renderedErr).toContain('pacs_users');
    expect(process.exitCode).toBe(1);
  });
});

describe('replay', () => {
  /** An index entry for a question already answered. */
  const held = (overrides: Record<string, unknown> = {}) => ({
    queryId: 2661,
    server: 'PACSDCM',
    criteria: { PatientID: 'X' },
    owner: 'someone',
    answeredAt: new Date(Date.now() - 3 * 86400 * 1000).toISOString(),
    hasResult: true,
    ...overrides,
  });

  beforeEach(() => {
    mockCurrentGet.mockResolvedValue('PACSDCM');
    // The asking identity comes from the authenticated login, not from a
    // per-session context snapshot a surface may not have.
    mockUserGet.mockResolvedValue('someone');
    mockServersList.mockResolvedValue(ok([{ id: 1, identifier: 'PACSDCM' }]));
  });

  it('serves a stored answer without troubling the PACS, and says how old it is', async () => {
    mockIndexFind.mockReturnValue(held());
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 's1' }] }));
    const { rendered: output } = await builtin_query(['PatientID:X']);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(output).toContain('answered');
    expect(output).toContain('days ago');
    expect(output).toContain('--fresh');
  });

  it('puts provenance on the model so every surface says the same thing', async () => {
    // One entry, held: the helper stamps a fresh `now` on every call.
    const entry = held();
    mockIndexFind.mockReturnValue(entry);
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 's1' }] }));
    const envelope = await builtin_query(['PatientID:X']);
    const model = (envelope as { model?: { data?: { provenance?: { replayed?: boolean; answeredAt?: string } } } }).model;
    expect(model?.data?.provenance?.replayed).toBe(true);
    expect(model?.data?.provenance?.answeredAt).toBe(entry.answeredAt);
  });

  it('marks a freshly queried answer as not replayed', async () => {
    mockIndexFind.mockReturnValue(null);
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'someone' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 'fresh' }] }));
    const envelope = await builtin_query(['PatientID:X']);
    const model = (envelope as { model?: { data?: { provenance?: { replayed?: boolean } } } }).model;
    expect(model?.data?.provenance?.replayed).toBe(false);
  });

  it('never replays a query that found nothing: an absence decays', async () => {
    mockIndexFind.mockReturnValue(held({ hasResult: false }));
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'someone' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 'fresh' }] }));
    await builtin_query(['PatientID:X']);
    expect(mockCreate).toHaveBeenCalled();
  });

  it('--fresh asks the PACS even when a stored answer exists', async () => {
    mockIndexFind.mockReturnValue(held());
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'someone' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 'fresh' }] }));
    const { rendered: output } = await builtin_query(['PatientID:X', '--fresh']);
    expect(mockCreate).toHaveBeenCalled();
    expect(output).not.toContain('answered');
  });

  it('falls through and forgets the entry when the stored answer is gone', async () => {
    mockIndexFind.mockReturnValue(held());
    // The index promised a payload CUBE no longer has.
    mockDecode
      .mockResolvedValueOnce(err())
      .mockResolvedValue(ok({ json: [{ uid: 'fresh' }] }));
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'someone' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    await builtin_query(['PatientID:X']);
    expect(mockIndexDrop).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });

  it('keys the lookup on the authenticated login, not a session context snapshot', async () => {
    // A surface attached to a running calypso has no ChRISuser context;
    // keying on it made every stored answer unreachable from argus while
    // chell found them all.
    mockCurrentGet.mockResolvedValue(null);
    mockUserGet.mockResolvedValue('someone');
    mockIndexFind.mockReturnValue(held());
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 's1' }] }));
    await builtin_query(['PatientID:X']);
    expect(mockIndexFind).toHaveBeenCalledWith({ PatientID: 'X' }, 'PACSDCM', 'someone');
  });

  it('files a fresh query under the asking identity when CUBE names no owner', async () => {
    mockIndexFind.mockReturnValue(null);
    mockCreate.mockResolvedValue(ok({ id: 9 }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 'fresh' }] }));
    await builtin_query(['PatientID:X']);
    expect(mockIndexNote).toHaveBeenCalledWith(expect.objectContaining({
      queryId: 9,
      owner: 'someone',
      server: 'PACSDCM',
    }));
  });

  it('asks the PACS when the question is new to the index', async () => {
    mockIndexFind.mockReturnValue(null);
    mockCreate.mockResolvedValue(ok({ id: 9, owner_username: 'someone' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [{ uid: 'fresh' }] }));
    await builtin_query(['PatientID:X']);
    expect(mockCreate).toHaveBeenCalled();
  });
});

describe('a cohort', () => {
  /** Serves each created query a distinct id, and records the load. */
  function pacs_stub(options: {
    /** MRNs whose create should fail, as a PACS that could not be reached. */
    unreachable?: Set<string>;
    /** MRNs the PACS answers with nothing. */
    empty?: Set<string>;
  } = {}): { peak: () => number; asked: () => string[] } {
    let nextId: number = 100;
    let active: number = 0;
    let peak: number = 0;
    const asked: string[] = [];
    const idFor: Map<number, string> = new Map();
    mockCreate.mockImplementation(async (_server: unknown, payload: unknown) => {
      const criteria = JSON.parse((payload as { query: string }).query) as Record<string, string>;
      const mrn: string = criteria.PatientID ?? '';
      asked.push(mrn);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (options.unreachable?.has(mrn)) return err();
      const id: number = nextId++;
      idFor.set(id, mrn);
      return ok({ id, owner_username: 'chris' });
    });
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockImplementation(async (queryId: number) => {
      const mrn: string | undefined = idFor.get(queryId);
      if (mrn !== undefined && options.empty?.has(mrn)) return ok({ json: [] });
      return ok({ json: [{ ...studyPayload[0], PatientID: mrn ?? '' }] });
    });
    return { peak: (): number => peak, asked: (): string[] => asked };
  }

  /** The patient rows of the envelope's model. */
  function patients_derive(envelope: unknown): Array<Record<string, unknown>> {
    const model = (envelope as { model?: { data?: { patients?: Array<Record<string, unknown>> } } }).model;
    return model?.data?.patients ?? [];
  }

  it('asks one question per MRN and answers with a row for each', async () => {
    const load = pacs_stub();
    const envelope = await builtin_query(['--patients', '1234,4532,6654']);
    expect(load.asked().sort()).toEqual(['1234', '4532', '6654']);
    const patients = patients_derive(envelope);
    expect(patients.map((patient) => patient.patientId)).toEqual(['1234', '4532', '6654']);
    expect(patients.every((patient) => patient.status === 'found')).toBe(true);
  });

  it('reads the operator\'s inline comma list as the same cohort', async () => {
    const load = pacs_stub();
    await builtin_query(['PatientID:1234,4532']);
    expect(load.asked().sort()).toEqual(['1234', '4532']);
  });

  // Not operator-settable: a flag that can hurt a shared clinical system
  // will eventually be set to fifty.
  it('never has more than four questions in flight', async () => {
    const load = pacs_stub();
    await builtin_query(['--patients', '1,2,3,4,5,6,7,8,9,10,11,12']);
    expect(load.asked()).toHaveLength(12);
    expect(load.peak()).toBeLessThanOrEqual(4);
    expect(load.peak()).toBeGreaterThan(1);
  });

  // A server that timed out has told us nothing; a PACS that answered with
  // nothing has told us something, and a clinician acts on the difference.
  it('distinguishes a miss from a question that could not be asked', async () => {
    pacs_stub({ empty: new Set(['4532']), unreachable: new Set(['6654']) });
    const envelope = await builtin_query(['--patients', '1234,4532,6654']);
    const byId = new Map(patients_derive(envelope).map((patient) => [patient.patientId, patient]));
    expect(byId.get('1234')?.status).toBe('found');
    expect(byId.get('4532')?.status).toBe('none');
    expect(byId.get('4532')?.studyCount).toBe(0);
    expect(byId.get('6654')?.status).toBe('unasked');
    // A failure never reads as a zero, and it says what happened.
    expect(byId.get('6654')?.queryId).toBeUndefined();
    expect(typeof byId.get('6654')?.error).toBe('string');
    // The reason is read in a table and on a graphical surface, so the
    // stack's debugging prefix never reaches either.
    expect(byId.get('6654')?.error).not.toMatch(/^\[/);
  });

  it('counts what it found, what it did not, and what it could not ask', async () => {
    pacs_stub({ empty: new Set(['4532']), unreachable: new Set(['6654']) });
    const envelope = await builtin_query(['--patients', '1234,4532,6654']);
    const rendered: string = (envelope as { rendered: string }).rendered;
    expect(rendered).toContain('FOUND 1');
    expect(rendered).toContain('NONE 1');
    expect(rendered).toContain('UNASKED 1');
  });

  it('replays the MRNs already asked and troubles the PACS only for the rest', async () => {
    const load = pacs_stub();
    mockIndexFind.mockImplementation((criteria: Record<string, string>) =>
      criteria.PatientID === '1234'
        ? { queryId: 77, criteria, owner: 'chris', hasResult: true, answeredAt: '2026-06-14T09:22:00.000Z' }
        : null);
    const envelope = await builtin_query(['--patients', '1234,4532']);
    // The replayed MRN never reached the PACS.
    expect(load.asked()).toEqual(['4532']);
    const byId = new Map(patients_derive(envelope).map((patient) => [patient.patientId, patient]));
    expect((byId.get('1234')?.provenance as { replayed?: boolean } | undefined)?.replayed).toBe(true);
    expect((byId.get('4532')?.provenance as { replayed?: boolean } | undefined)?.replayed).toBe(false);
  });

  it('reports the whole command as failed only when nothing could be asked', async () => {
    pacs_stub({ unreachable: new Set(['1234', '4532']) });
    const envelope = await builtin_query(['--patients', '1234,4532']);
    expect((envelope as { status: string }).status).toBe('error');
    // The model still crosses: which MRNs went unasked is the useful part.
    expect(patients_derive(envelope)).toHaveLength(2);
  });

  it('refuses a cross-product that would launch hundreds', async () => {
    pacs_stub();
    const many: string = Array.from({ length: 40 }, (_unused, index) => String(index)).join(',');
    const envelope = await builtin_query([`PatientID:${many}`]);
    expect((envelope as { status: string }).status).toBe('error');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('narrows every question in the cohort by the terms given alongside it', async () => {
    pacs_stub();
    await builtin_query(['StudyDate:20240101', '--patients', '1234,4532']);
    const sent = mockCreate.mock.calls.map((call) => JSON.parse((call[1] as { query: string }).query));
    expect(sent).toEqual([
      { StudyDate: '20240101', PatientID: '1234' },
      { StudyDate: '20240101', PatientID: '4532' },
    ]);
  });
});

describe('several servers', () => {
  /** Serves every create, recording which server it was put to. */
  function servers_stub(options: { unreachable?: Set<string> } = {}): {
    puts: () => Array<{ server: string; mrn: string }>;
  } {
    let nextId: number = 200;
    const puts: Array<{ server: string; mrn: string }> = [];
    mockCreate.mockImplementation(async (server: unknown, payload: unknown) => {
      const criteria = JSON.parse((payload as { query: string }).query) as Record<string, string>;
      puts.push({ server: String(server), mrn: criteria.PatientID ?? '' });
      if (options.unreachable?.has(String(server))) return err();
      return ok({ id: nextId++, owner_username: 'chris' });
    });
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    return { puts: (): Array<{ server: string; mrn: string }> => puts };
  }

  it('puts one question to each server named', async () => {
    const load = servers_stub();
    await builtin_query(['PatientID:1234', '--pacsserver', 'PACSDCM,ORTHANC']);
    expect(load.puts()).toEqual([
      { server: 'PACSDCM', mrn: '1234' },
      { server: 'ORTHANC', mrn: '1234' },
    ]);
  });

  // Two servers may hold the same study; a row that cannot say which one
  // answered cannot be acted on.
  it('names the server on every row when more than one could have answered', async () => {
    servers_stub();
    const envelope = await builtin_query(['PatientID:1234', '--pacsserver', 'PACSDCM,ORTHANC']);
    const model = (envelope as { model?: { data?: { studies?: Array<Record<string, unknown>>; patients?: Array<Record<string, unknown>> } } }).model;
    expect(model?.data?.studies?.map((study) => study.server)).toEqual(['PACSDCM', 'ORTHANC']);
    expect(model?.data?.patients?.map((patient) => patient.server)).toEqual(['PACSDCM', 'ORTHANC']);
  });

  it('says nothing about servers when only one could have answered', async () => {
    servers_stub();
    const envelope = await builtin_query(['--patients', '1234,4532', '--pacsserver', 'PACSDCM']);
    const model = (envelope as { model?: { data?: { studies?: Array<Record<string, unknown>>; patients?: Array<Record<string, unknown>> } } }).model;
    expect(model?.data?.studies?.every((study) => study.server === undefined)).toBe(true);
    expect(model?.data?.patients?.every((patient) => patient.server === undefined)).toBe(true);
  });

  // An unreachable server tells us nothing about the patient; the server
  // that answered still tells us what it found.
  it('records an unreachable server as unasked, not as a patient with nothing', async () => {
    servers_stub({ unreachable: new Set(['ORTHANC']) });
    const envelope = await builtin_query(['PatientID:1234', '--pacsserver', 'PACSDCM,ORTHANC']);
    const patients = ((envelope as { model?: { data?: { patients?: Array<Record<string, unknown>> } } })
      .model?.data?.patients ?? []);
    expect(patients.map((patient) => [patient.server, patient.status])).toEqual([
      ['PACSDCM', 'found'],
      ['ORTHANC', 'unasked'],
    ]);
  });

  it('counts the servers into the fan-out guard', async () => {
    servers_stub();
    const many: string = Array.from({ length: 20 }, (_unused, index) => String(index)).join(',');
    const envelope = await builtin_query([`PatientID:${many}`, '--pacsserver', 'A,B']);
    expect((envelope as { status: string }).status).toBe('error');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('asks one server exactly as it always did', async () => {
    const load = servers_stub();
    await builtin_query(['PatientID:1234', '--pacsserver', 'PACSDCM']);
    expect(load.puts()).toEqual([{ server: 'PACSDCM', mrn: '1234' }]);
  });
});

describe('a flag given no value asks', () => {
  it('asks for a destination when --csv-to carries none', async () => {
    mockCreate.mockResolvedValue(ok({ id: 400, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockResolvedValue('/home/chris/audits/mine.csv');

    await builtin_query(['PatientID:1234', '--csv-to']);

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const asked = mockPrompt.mock.calls[0][0] as {
      wants?: string; commit?: string; path?: { anchor?: string; wantsDirectory?: boolean; suggest?: string };
    };
    // The ask says what it wants, so a surface can choose its instrument.
    expect(asked.wants).toBe('path');
    expect(asked.path?.wantsDirectory).toBe(false);
    expect(asked.path?.suggest).toMatch(/^pacs-.*\.csv$/);
    // A control reads as what it will do next.
    expect(asked.commit).toBe('EXPORT HERE');
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.any(String), '/home/chris/audits/mine.csv');
  });

  it('says where the table went in the answer\'s model, and names no file when none was written', async () => {
    mockCreate.mockResolvedValue(ok({ id: 402, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));

    const wrote = await builtin_query(['PatientID:1234', '--csv-to', '/home/chris/audits/my table.csv']);
    expect(wrote.model?.kind).toBe('pacs.query');
    expect((wrote.model?.data as { written?: string }).written).toBe('/home/chris/audits/my table.csv');

    const shown = await builtin_query(['PatientID:1234']);
    expect(shown.model?.kind).toBe('pacs.query');
    expect('written' in (shown.model?.data as object)).toBe(false);
  });

  // The anchor is a fact — the session's own cwd — never a directory
  // invented for the occasion, since inventing one means creating it.
  it('anchors the ask where the session already is', async () => {
    mockCreate.mockResolvedValue(ok({ id: 401, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockResolvedValue('/home/chris/x.csv');
    mockCwd.mockResolvedValue('/home/chris/feeds');

    await builtin_query(['PatientID:1234', '--csv-to']);

    const asked = mockPrompt.mock.calls[0][0] as { path?: { anchor?: string } };
    expect(asked.path?.anchor).toBe('/home/chris/feeds');
  });

  it('asks as well when another option follows the flag', async () => {
    mockCreate.mockResolvedValue(ok({ id: 403, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockResolvedValue('/home/chris/y.csv');

    await builtin_query(['PatientID:1234', '--csv-to', '--series']);

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.any(String), '/home/chris/y.csv');
  });

  it('takes a value that follows the flag, and asks nothing', async () => {
    mockCreate.mockResolvedValue(ok({ id: 402, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));

    await builtin_query(['PatientID:1234', '--csv-to', '/home/chris/named.csv']);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.any(String), '/home/chris/named.csv');
  });

  // A flag whose value is the next flag was given no value at all.
  it('does not eat the flag that follows it', async () => {
    mockCreate.mockResolvedValue(ok({ id: 403, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockResolvedValue('/home/chris/x.csv');

    await builtin_query(['PatientID:1234', '--csv-to', '--fresh']);

    expect(mockPrompt).toHaveBeenCalledTimes(1);
  });

  // An abandoned ask is not a failed query: the answer stands, and only the
  // writing of it does not happen.
  it('writes nothing when the ask is abandoned, and says so', async () => {
    mockCreate.mockResolvedValue(ok({ id: 404, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockRejectedValue(new Error('the operator abandoned the ask'));

    const envelope = await builtin_query(['PatientID:1234', '--csv-to']);

    expect(mockFilesCreate).not.toHaveBeenCalled();
    expect((envelope as { renderedErr?: string }).renderedErr ?? '').toContain('nothing written');
  });
});

describe('an ask anchors somewhere a file can land', () => {
  beforeEach((): void => {
    mockCreate.mockResolvedValue(ok({ id: 500, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockResolvedValue('/home/chris/x.csv');
  });

  // A session sitting in a provider path is browsing, not standing
  // somewhere a file lands; an errand opened there offers a destination
  // that is refused the moment it is committed.
  it('falls back to home when the session is inside a virtual provider', async () => {
    for (const where of ['/bin', '/proc/jobs/feed_21', '/net/pacs/queries', '/usr/bin', '/etc']) {
      mockPrompt.mockClear();
      mockCwd.mockResolvedValue(where);
      await builtin_query(['PatientID:1234', '--csv-to']);
      const asked = mockPrompt.mock.calls[0][0] as { path?: { anchor?: string } };
      expect(asked.path?.anchor).toBe('~');
    }
  });

  it('still anchors where the operator is when that is a real place', async () => {
    mockCwd.mockResolvedValue('/home/chris/feeds/feed_3');
    await builtin_query(['PatientID:1234', '--csv-to']);
    const asked = mockPrompt.mock.calls[0][0] as { path?: { anchor?: string } };
    expect(asked.path?.anchor).toBe('/home/chris/feeds/feed_3');
  });
});

describe('an abandoned ask keeps the answer', () => {
  // The answer is what the operator waited for; only the writing of it did
  // not happen. Throwing the model away because a destination was refused
  // would make a surface show nothing at all.
  it('carries the model when the destination was abandoned', async () => {
    mockCreate.mockResolvedValue(ok({ id: 600, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockPrompt.mockRejectedValue(new Error('the operator abandoned the ask'));

    const envelope = await builtin_query(['PatientID:1234', '--csv-to']);

    expect((envelope as { status: string }).status).toBe('error');
    const model = (envelope as { model?: { data?: { studies?: unknown[] } } }).model;
    expect(model?.data?.studies).toHaveLength(1);
  });

  it('carries it when the write itself was refused', async () => {
    mockCreate.mockResolvedValue(ok({ id: 601, owner_username: 'chris' }));
    mockQueryGet.mockResolvedValue(ok({ status: 'succeeded' }));
    mockDecode.mockResolvedValue(ok({ json: [studyPayload[0]] }));
    mockFilesCreate.mockResolvedValue(false);

    const envelope = await builtin_query(['PatientID:1234', '--csv-to', '/home/chris/x.csv']);

    expect((envelope as { status: string }).status).toBe('error');
    const model = (envelope as { model?: { data?: { studies?: unknown[] } } }).model;
    expect(model?.data?.studies).toHaveLength(1);
  });
});
