import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { chrisHelp_install } from './support/chrisHelp.js';

chrisHelp_install();
import { cuminMock_install } from './support/cuminMock.js';

const mockGet = jest.fn(async () => null as string | null);
const mockSet = jest.fn(async () => true);
const mockServersList = jest.fn();
const mockStackPop = jest.fn((): { message: string } | undefined => undefined);
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  chrisContext: { PACSserver_get: mockGet, PACSserver_set: mockSet },
  pacsServers_list: mockServersList,
  errorStack: { stack_pop: mockStackPop },
}));

const mockQuery = jest.fn(async () => ({ status: 'ok', rendered: '' }));
const mockPull = jest.fn(async () => ({ status: 'ok', rendered: '' }));
const mockStatus = jest.fn(async () => ({ status: 'ok', rendered: '' }));
jest.unstable_mockModule('../src/builtins/net/query.js', () => ({ queryLine_run: mockQuery }));
jest.unstable_mockModule('../src/builtins/fs/pull.js', () => ({ pullLine_run: mockPull }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ error_stripDebugPrefix: (m: string) => m.replace(/^\[[^\]]+\]\s*\|\s*/, '') }));
jest.unstable_mockModule('../src/builtins/net/status.js', () => ({ pacsStatus_run: mockStatus }));

// pacs streams its output through the sink line writers.
const mockDataLine = jest.fn();
const mockErrLine = jest.fn();
jest.unstable_mockModule('../src/core/sink.js', () => ({
  sink_dataLine: mockDataLine,
  sink_errLine: mockErrLine,
  sink_get: jest.fn(() => ({ data_write: jest.fn(), err_write: jest.fn(), progress_write: jest.fn() })),
}));

const ok = <T>(value: T) => ({ ok: true as const, value });

const { builtin_pacs, pacsCommand } = await import('../src/builtins/net/pacs.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
// `pacs pull` and `pacs status` take a kind the ChRIS backend registers.
const { backend_install } = await import('../src/core/backend.js');
const { chrisArgumentKinds } = await import('../src/chris/kinds.js');
backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue(true);
});

describe('builtin_pacs', () => {
  it('has a page for pacs query that is query\'s line, and completes its subcommands and their options', async () => {
    const { subcommandHelp_derive } = await import('../src/core/commandUsage.js');
    const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
    const page = subcommandHelp_derive(pacsCommand, 'query');
    expect(page?.usage).toContain('pacs query [--csv] [--force] [--table] [--series] [--anon] [--fresh] [--title <title>]');
    expect(page?.examples).toEqual(['pacs query PatientID:1234         # Query PACS']);
    expect(await declaredWord_complete(pacsCommand, [], 'p')).toEqual(['pull']);
    expect(await declaredWord_complete(pacsCommand, ['pull'], '--d')).toEqual(['--detach']);
    expect(pacsCommand.help.category).toBe('PACS');
  });

  it('takes its usage from its declaration: bare, or one subcommand', () => {
    expect(commandUsage_render(pacsCommand, 'connect')).toBe('pacs connect [server]');
    expect(commandUsage_render(pacsCommand, 'status')).toBe('pacs status <target>');
    expect(commandUsage_render(pacsCommand)).toMatch(/^pacs \[connect \[server\] \| disconnect \| list \| query /);
  });

  it('shows the active server with no subcommand', async () => {
    mockGet.mockResolvedValue('PACSDCM');
    await builtin_pacs([]);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('Active PACS server'));
  });

  it('notes when no server is set', async () => {
    mockGet.mockResolvedValue(null);
    await builtin_pacs([]);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('No PACS server set'));
  });

  it('lists servers, marking the active one, on bare connect', async () => {
    mockGet.mockResolvedValue('PACSDCM');
    mockServersList.mockResolvedValue(ok([{ id: 1, identifier: 'PACSDCM' }, { id: 2, identifier: 'ORTHANC' }]));
    await builtin_pacs(['connect']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('active'));
  });

  it('notes when no servers are registered', async () => {
    mockServersList.mockResolvedValue(ok([]));
    await builtin_pacs(['connect']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('No PACS servers registered'));
  });

  it('a listing CUBE refused is not an empty one: it says why, says pacs_users, and fails', async () => {
    mockServersList.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValueOnce({ message: '[pacsServers_list] | Failed to list PACS servers: You do not have permission to perform this action.' });
    const env = await builtin_pacs(['list']);
    expect(env.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(mockDataLine).not.toHaveBeenCalledWith(expect.stringContaining('No PACS servers registered'));
    const said: string = mockErrLine.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('You do not have permission');
    expect(said).not.toContain('[pacsServers_list]');
    expect(said).toContain('pacs_users');
  });

  it('a listing that failed for another reason says why, without the pacs_users hint', async () => {
    mockServersList.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValueOnce({ message: 'Not connected to ChRIS. Please log in.' });
    const env = await builtin_pacs(['connect']);
    expect(env.status).toBe('error');
    const said: string = mockErrLine.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('Not connected');
    expect(said).not.toContain('pacs_users');
  });

  it('sets the active server', async () => {
    mockSet.mockResolvedValue(true);
    await builtin_pacs(['connect', 'ORTHANC']);
    expect(mockSet).toHaveBeenCalledWith('ORTHANC');
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining("set to 'ORTHANC'"));
  });

  it('reports a failure to set the server', async () => {
    mockSet.mockResolvedValue(false);
    await builtin_pacs(['connect', 'ghost']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('Failed to set'));
    expect(process.exitCode).toBe(1);
  });

  it('disconnects the active server', async () => {
    mockSet.mockResolvedValue(true);
    await builtin_pacs(['disconnect']);
    expect(mockSet).toHaveBeenCalledWith('');
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('cleared'));
  });

  it('reports a failure to disconnect', async () => {
    mockSet.mockResolvedValue(false);
    await builtin_pacs(['disconnect']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('Failed to clear'));
    expect(process.exitCode).toBe(1);
  });

  it('lists servers with the list alias', async () => {
    mockServersList.mockResolvedValue(ok([{ id: 1, identifier: 'PACSDCM' }]));
    await builtin_pacs(['list']);
    expect(mockServersList).toHaveBeenCalled();
  });

  it('routes query to the query handler, with the line query parses', async () => {
    await builtin_pacs(['query', 'PatientID:X', '--table']);
    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      subcommand: 'query',
      operands: { expression: ['PatientID:X'] },
      options: expect.objectContaining({ table: true, csvTo: undefined, fresh: false }),
    }));
  });

  it('routes pull to the pull handler, with the line pull parses', async () => {
    await builtin_pacs(['pull', '--detach', '/net/pacs/queries/x']);
    expect(mockPull).toHaveBeenCalledWith(expect.objectContaining({
      subcommand: 'pull',
      operands: { target: ['/net/pacs/queries/x'] },
      options: expect.objectContaining({ detach: true, retry: undefined, newFeed: [] }),
    }));
  });

  it('routes status to the status report, with its one target', async () => {
    await builtin_pacs(['status', '2833']);
    expect(mockStatus).toHaveBeenCalledWith('2833');
  });

  it('rejects an unknown subcommand, a subcommand\'s option it lacks, and status without a target', async () => {
    const unknown = await builtin_pacs(['frobnicate']);
    expect(unknown.renderedErr).toContain("pacs: unknown subcommand 'frobnicate' (connect, disconnect, list, query, pull, status)");
    expect((await builtin_pacs(['connect', '--table'])).renderedErr).toContain("pacs: connect: unrecognized option '--table'");
    expect((await builtin_pacs(['status'])).renderedErr).toContain('pacs: status: missing operand <target>; usage: pacs status <target>');
    expect(mockStatus).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
