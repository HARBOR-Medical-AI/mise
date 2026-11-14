import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { chrisHelp_install } from './support/chrisHelp.js';

chrisHelp_install();
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';

// Real commandArgs helpers (path_resolve) run; stub the load-time boundary.
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', folder: '/home/chris' })),
}));
cuminMock_install(() => ({
  envelope_ok: (rendered: string): CommandEnvelope => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string): CommandEnvelope => {
    const envelope: CommandEnvelope = { status: 'error', rendered };
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

const mockClientGet = jest.fn(async () => ({}) as unknown);
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: jest.fn(async () => '/home/chris'), connection: { client_get: mockClientGet } },
}));

// pacsUtils does the CUBE/PACS work; stub it so we exercise cubepath's own logic.
const mockServerResolve = jest.fn();
const mockSeriesCollect = jest.fn();
const mockCubePathGet = jest.fn();
jest.unstable_mockModule('../src/builtins/net/pacsUtils.js', () => ({
  pacsServer_resolve: mockServerResolve,
  pacs_seriesCollect: mockSeriesCollect,
  series_cubePathGet: mockCubePathGet,
}));

const { builtin_cubepath, cubepathCommand } = await import('../src/builtins/net/cubepath.js');
const { declarationHelp_derive } = await import('../src/core/commandUsage.js');

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockClientGet.mockResolvedValue({});
});

describe('builtin_cubepath', () => {
  it('has its help from its declaration (the shell answers --help before the command runs)', () => {
    const help = declarationHelp_derive(cubepathCommand);
    expect(help.usage).toBe('cubepath [--retry] [--pacsserver <id>] <path…>');
    expect(help.options).toContainEqual(expect.stringMatching(/^--pacsserver <id>\s+Override PACS server/));
  });

  it('requires at least one path', async () => {
    const envelope: CommandEnvelope = await builtin_cubepath([]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('cubepath: missing operand <path>');
    expect(process.exitCode).toBe(1);
  });

  it('errors when no PACS server can be resolved', async () => {
    mockServerResolve.mockResolvedValue(null);
    const envelope: CommandEnvelope = await builtin_cubepath(['/net/pacs/queries/x']);
    expect(envelope.renderedErr).toContain('No PACS server available');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-PACS VFS path', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    const envelope: CommandEnvelope = await builtin_cubepath(['/home/chris/data']);
    expect(envelope.renderedErr).toContain('Not a PACS VFS path');
    expect(envelope.renderedErr).toContain('No series found');
  });

  it('notes when no series are found under the path', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    mockSeriesCollect.mockResolvedValue([]);
    const envelope: CommandEnvelope = await builtin_cubepath(['/net/pacs/queries/empty']);
    expect(envelope.renderedErr).toContain('No series found');
    expect(process.exitCode).toBe(1);
  });

  it('errors when not connected to ChRIS', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    mockSeriesCollect.mockResolvedValue([{ seriesUID: '1.2', seriesLabel: 'AX_T2' }]);
    mockClientGet.mockResolvedValue(null);
    const envelope: CommandEnvelope = await builtin_cubepath(['/net/pacs/queries/s']);
    expect(envelope.renderedErr).toContain('Not connected');
    expect(process.exitCode).toBe(1);
  });

  it('reports a resolved CUBE path with a file count', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    mockSeriesCollect.mockResolvedValue([{ seriesUID: '1.2', seriesLabel: 'AX_T2' }]);
    mockCubePathGet.mockResolvedValue({ folderPath: '/cube/data/series', fileCount: 5 });
    const envelope: CommandEnvelope = await builtin_cubepath(['/net/pacs/queries/s']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('5 files');
    expect(envelope.rendered).toContain('/cube/data/series');
  });

  it('flags a series with zero pulled files', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    mockSeriesCollect.mockResolvedValue([{ seriesUID: '1.2', seriesLabel: 'AX_T2' }]);
    mockCubePathGet.mockResolvedValue({ folderPath: '/cube/data/series', fileCount: 0 });
    const envelope: CommandEnvelope = await builtin_cubepath(['/net/pacs/queries/s']);
    expect(envelope.rendered).toContain('may not be pulled');
  });

  it('reports series that are not in CUBE, with a summary', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    mockSeriesCollect.mockResolvedValue([{ seriesUID: '1.2', seriesLabel: 'AX_T2' }]);
    mockCubePathGet.mockResolvedValue(null);
    const envelope: CommandEnvelope = await builtin_cubepath(['/net/pacs/queries/s', '--retry']);
    expect(envelope.rendered).toContain('not in CUBE');
    expect(envelope.rendered).toContain('1/1 series not found');
  });

  it('honours an explicit --pacsserver override', async () => {
    mockServerResolve.mockResolvedValue('PACSDCM');
    mockSeriesCollect.mockResolvedValue([{ seriesUID: '1.2', seriesLabel: 'AX_T2' }]);
    mockCubePathGet.mockResolvedValue({ folderPath: '/cube/x', fileCount: 1 });
    await builtin_cubepath(['/net/pacs/queries/s', '--pacsserver', '3']);
    expect(mockServerResolve).toHaveBeenCalledWith('3');
  });
});
