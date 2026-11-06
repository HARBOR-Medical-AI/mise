import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockIndexLoad = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockComputes = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPlanBuild = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockApply = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAdmin = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockValidate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAddJson = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFileContent = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  computeNames_resolve: mockComputes,
  fileContent_get: mockFileContent,
  localAccount_adminAccessEnsure: mockAdmin,
  plugin_add: jest.fn(),
  plugin_addJson: mockAddJson,
  pluginIndex_load: mockIndexLoad,
  pluginIndex_validate: mockValidate,
  pluginIndexSource_parse: (word: string, bare: string, ref?: string): unknown => {
    if (word.startsWith('host:')) return { kind: 'host', path: word.slice(5) };
    const github: RegExpExecArray | null = /^(\w[\w.-]*)\/([\w.-]+)(?:@(\S+))?$/.exec(word);
    if (github !== null) return { kind: 'github', owner: github[1], repo: github[2], ref: ref ?? github[3] ?? 'main' };
    return word.trim() === '' ? null : { kind: bare, path: word };
  },
  pluginIndexSource_format: (s: { kind: string; owner?: string; repo?: string; ref?: string; path?: string }): string =>
    s.kind === 'github' ? `${s.owner}/${s.repo}@${s.ref}` : `${s.kind}:${s.path}`,
  syncPlan_apply: mockApply,
  syncPlan_build: mockPlanBuild,
  syncPlanAdds_list: (plan: { entries: Array<{ group: string }> }): unknown[] => plan.entries.filter((e) => e.group === 'add' || e.group === 'newer'),
  syncSeams_cube: { real: true },
}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: {} }));

const mockPop = jest.fn<() => unknown>();
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, ...(model === undefined ? {} : { model }) }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, ...(renderedErr === undefined ? {} : { renderedErr }) }),
  errorStack: { stack_clear: jest.fn(), allOfType_get: jest.fn(() => []), stack_push: jest.fn(), stack_pop: mockPop },
  Ok: (value: unknown) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
}));

const mockConfirm = jest.fn<(q: string) => Promise<boolean>>();
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: mockConfirm }));
const lines: string[] = [];
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_dataLine: (line: string): void => { lines.push(line); } }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: async (p: string): Promise<string> => (p.startsWith('/') ? p : `/home/u/${p}`) }));

const verbs = await import('../src/builtins/res/plugin.sync.js');
const indexConfig = await import('../src/config/indexConfig.js');

const PLAN = {
  label: 'chris-plugins @ 8c9a1f6', source: 'FNNDSC/chris-plugins@main', commit: '8c9a1f6abc', indexed: 4, computes: ['host'],
  entries: [
    { group: 'add', name: 'pl-a', version: '1.0', descriptor: '{}' },
    { group: 'newer', name: 'pl-b', version: '2.0', cubeVersions: ['1.0'], descriptor: '{}' },
    { group: 'skip', name: 'pl-c', version: '1.0' },
    { group: 'drift', name: 'pl-d', version: '1.0', detail: 'differs in dock_image' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  lines.length = 0;
  process.exitCode = 0;
  indexConfig.pluginIndex_clear();
  mockIndexLoad.mockResolvedValue({ ok: true, value: { label: 'x' } });
  mockComputes.mockResolvedValue({ ok: true, value: ['host'] });
  mockPlanBuild.mockResolvedValue(PLAN);
  mockAdmin.mockResolvedValue({ ok: true });
  mockConfirm.mockResolvedValue(true);
  mockApply.mockImplementation(async (_plan: unknown, _seams: unknown, note: unknown) => {
    (note as (r: unknown) => void)({ name: 'pl-a', version: '1.0', ok: true });
    (note as (r: unknown) => void)({ name: 'pl-b', version: '2.0', ok: true });
    return { plan: PLAN, results: [{ name: 'pl-a', version: '1.0', ok: true }, { name: 'pl-b', version: '2.0', ok: true }], added: 2, skipped: 1, reported: 1, failed: 0 };
  });
});

describe('plugin sync', () => {
  it('reads the configured index, shows the plan, asks, and streams what lands', async () => {
    const env = await verbs.pluginSync_run({ _: ['sync'] }, ['sync']);
    expect(mockIndexLoad).toHaveBeenCalledWith({ kind: 'github', owner: 'FNNDSC', repo: 'chris-plugins', ref: 'main' });
    expect(lines[0]).toContain('plugin sync: chris-plugins @ 8c9a1f6, 4 plugins → this CUBE, on host');
    expect(lines[0]).toContain('pl-b 2.0');
    expect(lines[0]).not.toContain('pl-c');
    expect(mockConfirm.mock.calls[0]?.[0]).toBe('Register 2 plugins from chris-plugins @ 8c9a1f6 on host? Nothing already here is changed or deleted. [y/N]');
    expect(lines.slice(1)).toEqual([expect.stringContaining('pl-a 1.0'), expect.stringContaining('pl-b 2.0')]);
    expect(env.rendered).toContain('2 added, 1 skipped, 1 reported, 0 failed.');
    expect(env.model).toMatchObject({ kind: 'plugin.sync', data: { applied: true, results: expect.any(Array) } });
    expect(JSON.stringify(env.model)).not.toContain('descriptor');
  });

  it('--plan shows the plan and registers nothing', async () => {
    const env = await verbs.pluginSync_run({ _: ['sync', 'FNNDSC/chris-plugins'], plan: true, ref: 'v1' }, ['sync']);
    expect(mockIndexLoad).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v1' }));
    expect(env.rendered).toContain('--plan: 2 to add; nothing was registered.');
    expect(env.model).toMatchObject({ data: { applied: false } });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('says there is nothing to add', async () => {
    mockPlanBuild.mockResolvedValue({ ...PLAN, entries: [PLAN.entries[2]] });
    expect((await verbs.pluginSync_run({ _: ['sync'] }, ['sync'])).rendered).toContain('Nothing to add.');
  });

  it('shows a non-administrator the plan and the sudo line', async () => {
    mockAdmin.mockResolvedValue({ ok: false });
    const env = await verbs.pluginSync_run({ _: ['sync', 'cube-index'] }, ['sync', 'cube-index']);
    expect(mockIndexLoad).toHaveBeenCalledWith({ kind: 'cube', path: '/home/u/cube-index' });
    expect(env.rendered).toContain('plugin sync:');
    expect(env.renderedErr).toContain('sudo plugin sync cube-index');
    expect(process.exitCode).toBe(1);
  });

  it('takes a NO, and --yes skips the question', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    expect((await verbs.pluginSync_run({ _: ['sync'] }, ['sync'])).rendered).toContain('No: nothing was registered.');
    expect(mockApply).not.toHaveBeenCalled();
    await verbs.pluginSync_run({ _: ['sync'], yes: true }, ['sync']);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('exits 1 naming what did not register', async () => {
    mockApply.mockImplementation(async (_p: unknown, _s: unknown, note: unknown) => {
      (note as (r: unknown) => void)({ name: 'pl-a', version: '1.0', ok: false, reason: 'refused' });
      (note as (r: unknown) => void)({ name: 'pl-b', version: '2.0', ok: false });
      return { plan: PLAN, results: [{ name: 'pl-a', version: '1.0', ok: false, reason: 'refused' }, { name: 'pl-b', version: '2.0', ok: false }], added: 0, skipped: 1, reported: 1, failed: 2 };
    });
    const env = await verbs.pluginSync_run({ _: ['sync'] }, ['sync']);
    expect(lines[1]).toContain('refused');
    expect(lines[2]).toContain('no reason given');
    expect(env.renderedErr).toContain('Not registered: pl-a 1.0, pl-b 2.0');
    expect(process.exitCode).toBe(1);
  });

  it('says a stopped apply stopped, what landed and that a rerun continues', async () => {
    mockApply.mockImplementation(async (_p: unknown, _s: unknown, note: unknown) => {
      (note as (r: unknown) => void)({ name: 'pl-a', version: '1.0', ok: true });
      return { plan: PLAN, results: [{ name: 'pl-a', version: '1.0', ok: true }], added: 1, skipped: 1, reported: 1, failed: 0, stopped: true, unsent: 1 };
    });
    const env = await verbs.pluginSync_run({ _: ['sync'], yes: true }, ['sync']);
    expect(env.status).toBe('error');
    expect(env.rendered).toContain('Stopped: 1 added, 1 skipped, 1 reported, 0 failed. 1 never sent; what was added stays, and a rerun continues from it.');
    expect((env.model?.data as { stopped?: boolean }).stopped).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('fails on an unreadable index, compute or CUBE', async () => {
    mockIndexLoad.mockResolvedValueOnce({ ok: false });
    mockPop.mockReturnValueOnce({ message: 'plugin index x: HTTP 404' });
    expect((await verbs.pluginSync_run({ _: ['sync'] }, ['sync'])).renderedErr).toContain('HTTP 404');
    mockComputes.mockResolvedValueOnce({ ok: false });
    expect((await verbs.pluginSync_run({ _: ['sync'], compute: 'zz' }, ['sync'])).renderedErr).toContain('plugin sync:');
    mockPlanBuild.mockRejectedValueOnce(new Error('Not connected'));
    expect((await verbs.pluginSync_run({ _: ['sync'] }, ['sync'])).renderedErr).toContain('this CUBE could not be read: Not connected');
    expect((await verbs.pluginSync_run({ _: ['sync', ' '] }, ['sync'])).renderedErr).toContain('no index to read');
  });
});

describe('plugin validate', () => {
  const report = {
    label: 'plugins', commit: null, descriptors: 2, ok: true, findings: [],
    rules: [{ rule: 1, title: 'schema', checked: false, note: 'no schema', failed: 0 }, { rule: 2, title: 'upload', checked: true, failed: 0 }],
  };

  it('checks a host directory and reports each rule', async () => {
    mockValidate.mockResolvedValue(report);
    const env = await verbs.pluginValidate_run({ _: ['validate', './plugins'], offline: true });
    expect(mockIndexLoad).toHaveBeenCalledWith({ kind: 'host', path: './plugins' }, expect.any(Function));
    expect(mockValidate).toHaveBeenCalledWith({ label: 'x' }, expect.objectContaining({ offline: true }));
    expect(env.rendered).toContain('rule 1 (schema): not checked, no schema');
    expect(env.rendered).toContain('2 descriptors: every rule that ran passes.');
    expect(env.model).toMatchObject({ kind: 'plugin.validate' });
  });

  it('exits 1 on a finding, and reads one file alone', async () => {
    mockValidate.mockResolvedValue({ ...report, descriptors: 1, ok: false, findings: [{ file: 'pl-x.json', rule: 3, message: 'misnamed' }], rules: [{ rule: 3, title: 'name', checked: true, failed: 1 }] });
    mockFileContent.mockResolvedValue({ ok: true, value: '{}' });
    const env = await verbs.pluginValidate_run({ _: ['validate', 'cube:pl-x.json'] });
    expect(mockFileContent).toHaveBeenCalledWith('/home/u/pl-x.json');
    expect(env.rendered).toContain('pl-x.json rule 3: misnamed');
    expect(env.rendered).toContain('1 finding in 1 file.');
    expect(env.model).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it('says what could not be read or checked', async () => {
    expect((await verbs.pluginValidate_run({ _: ['validate'] })).rendered).toContain('Usage: plugin validate');
    expect((await verbs.pluginValidate_run({ _: ['validate', '/nonexistent/pl-x.json'] })).renderedErr).toContain('could not read');
    mockValidate.mockRejectedValueOnce(new Error("the index's schema does not compile"));
    expect((await verbs.pluginValidate_run({ _: ['validate', 'FNNDSC/chris-plugins'] })).renderedErr).toContain('does not compile');
  });
});

describe('plugin add --json', () => {
  it('reads a host file and registers it', async () => {
    mockAddJson.mockResolvedValue({ outcome: 'installed', name: 'pl-x', version: '1' });
    expect((await verbs.pluginAdd_run({ _: ['add'], json: 'host:/nonexistent/x.json' }, ['add'])).renderedErr).toContain('could not read');
    mockFileContent.mockResolvedValue({ ok: true, value: '{"name":"pl-x"}' });
    const env = await verbs.pluginAdd_run({ _: ['add'], json: 'cube:/home/u/pl-x.json', compute: 'host' }, ['add']);
    expect(mockAddJson).toHaveBeenCalledWith('{"name":"pl-x"}', expect.objectContaining({ compute: 'host' }), expect.any(Function));
    expect(env.rendered).toContain('Registered pl-x 1.');
    mockFileContent.mockResolvedValue({ ok: false });
    expect((await verbs.pluginAdd_run({ _: ['add'], json: 'cube:/x.json' }, ['add'])).renderedErr).toContain('could not read');
  });
});

describe('plugin index', () => {
  it('shows, sets and resets the index sync reads', async () => {
    expect((await verbs.pluginIndexVerb_run({ _: ['index'] })).rendered).toContain('FNNDSC/chris-plugins@main');
    expect((await verbs.pluginIndexVerb_run({ _: ['index', 'FNNDSC/chris-plugins@v2'] })).rendered).toContain('FNNDSC/chris-plugins@v2');
    expect(indexConfig.pluginIndex_get()).toBe('FNNDSC/chris-plugins@v2');
    expect((await verbs.pluginIndexVerb_run({ _: ['index'] })).rendered).toContain('(set)');
    await verbs.pluginIndexVerb_run({ _: ['index', 'idx'] });
    expect(indexConfig.pluginIndex_get()).toBe('cube:/home/u/idx');
    expect((await verbs.pluginIndexVerb_run({ _: ['index', ' '] })).renderedErr).toContain('Usage: plugin index');
    await verbs.pluginIndexVerb_run({ _: ['index'], reset: true });
    expect(indexConfig.pluginIndex_isDefault()).toBe(true);
  });

  it('persists through the host\'s hook', async () => {
    const persist = jest.fn(async (): Promise<void> => undefined);
    indexConfig.indexConfigPersist_install(persist);
    await verbs.pluginIndexVerb_run({ _: ['index', 'a/b'] });
    expect(persist).toHaveBeenCalled();
    expect(indexConfig.pluginIndexOverride_get()).toBe('a/b@main');
  });
});
