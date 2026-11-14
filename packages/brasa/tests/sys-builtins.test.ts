import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { ChrisIdentity, ChrisUser, CommandEnvelope, Result } from '@fnndsc/cumin';

const mockContext = jest.fn();
const mockCurrentIdentity = jest.fn<() => Promise<Result<ChrisIdentity>>>();
const mockFeedsList = jest.fn();
const mockInstancesList = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: mockContext,
  feeds_list: mockFeedsList,
  pluginInstances_list: mockInstancesList,
}));
cuminMock_install(() => ({
  currentIdentity_get: mockCurrentIdentity,
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string, errors?: unknown, renderedErr?: string) => {
    const envelope: Record<string, unknown> = { status: 'error', rendered };
    if (errors !== undefined) envelope.errors = errors;
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
}));

const mockSession = {
  timingEnabled_get: jest.fn(),
  timingEnabled_set: jest.fn(),
  physicalMode_get: jest.fn(),
  physicalMode_set: jest.fn(),
  getCWD: jest.fn(),
  connection: { config: { debug: false } as { debug: boolean } | null },
};
jest.unstable_mockModule('../src/session/index.js', () => ({ session: mockSession }));

const { builtin_id, builtin_whoami, builtin_whereami } = await import('../src/builtins/sys/whoami.js');
const { builtin_timing } = await import('../src/builtins/sys/timing.js');
const { builtin_physicalmode } = await import('../src/builtins/sys/physicalmode.js');
const { builtin_debug } = await import('../src/builtins/debug.js');
// debug toggles the backend's debugging: ChRIS's, over the connection this file mocks.
const { chrisDebug_get, chrisDebug_set } = await import('../src/chris/debug.js');
const { chrisSegment_title } = await import('../src/chris/navigation.js');
(await import('../src/core/backend.js')).backend_install({
  id: 'chris',
  session: {} as never,
  debug_get: chrisDebug_get,
  debug_set: chrisDebug_set,
  // pwd --title asks ChRIS for a segment's title, over the salsa this file mocks.
  vfs: { segment_title: chrisSegment_title } as never,
});
const { builtin_pwd } = await import('../src/builtins/fs/pwd.js');
const { builtin_version } = await import('../src/builtins/sys/version.js');
const { builtin_fortune, fortune_random } = await import('../src/builtins/sys/fortune.js');
const { FORTUNES } = await import('../src/builtins/sys/fortunes.data.js');
const { builtin_date, date_format } = await import('../src/builtins/sys/date.js');
const { builtin_cal } = await import('../src/builtins/sys/cal.js');
const { versions_get, versionReport_build, infoReport_build, stackInfo_get, welcomeLine_build, welcomeLine_compose, stackBanner_build, stackBanner_compose, stackBanner_rows, stackBannerRow_paint, buildHash_get, versions_selectForBackend } = await import('../src/core/version.js');

let logSpy: jest.SpiedFunction<typeof console.log>;
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('builtin_whoami', () => {
  it('reports the connected user in the envelope', async () => {
    mockContext.mockResolvedValue({ user: 'chris' });
    const envelope: CommandEnvelope = await builtin_whoami([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('chris');
    expect(envelope.model).toEqual({ kind: 'session.identity', data: { user: 'chris' } });
    expect(process.exitCode).toBe(0);
  });
  it('reports not-connected with a non-zero exit code', async () => {
    mockContext.mockResolvedValue({ user: null });
    const envelope: CommandEnvelope = await builtin_whoami([]);
    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toContain('not connected');
    expect(process.exitCode).toBe(1);
  });
});

describe('builtin_id', () => {
  it('reports the CUBE user ID through the Unix identity projection', async () => {
    const user: ChrisUser = {
      id: 42,
      username: 'alice',
      email: 'alice@example.org',
      is_staff: false,
    };
    mockCurrentIdentity.mockResolvedValue({
      ok: true,
      value: {
        user,
        groups: [{ id: 9, name: 'research' }, { id: 7, name: 'pacs' }],
      },
    });

    const envelope: CommandEnvelope = await builtin_id([]);

    expect(envelope).toEqual({
      status: 'ok',
      rendered: 'uid=42(alice) gid=42(alice) groups=42(alice),7(pacs),9(research)\n',
      model: {
        kind: 'session.posixIdentity',
        data: {
          uid: 42,
          user: 'alice',
          gid: 42,
          group: 'alice',
          groups: [
            { gid: 42, group: 'alice' },
            { gid: 7, group: 'pacs' },
            { gid: 9, group: 'research' },
          ],
        },
      },
    });
  });

  it('reports an identity lookup failure with a non-zero exit code', async () => {
    mockCurrentIdentity.mockResolvedValue({ ok: false });

    const envelope: CommandEnvelope = await builtin_id([]);

    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toContain('identity unavailable');
    expect(process.exitCode).toBe(1);
  });
});

describe('builtin_whereami', () => {
  it('reports the CUBE URL in the envelope', async () => {
    mockContext.mockResolvedValue({ URL: 'http://c/api/' });
    const envelope: CommandEnvelope = await builtin_whereami([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('http://c/api/');
    expect(envelope.model).toEqual({ kind: 'session.cube', data: { url: 'http://c/api/' } });
  });
  it('reports not-connected when no URL', async () => {
    mockContext.mockResolvedValue({ URL: null });
    const envelope: CommandEnvelope = await builtin_whereami([]);
    expect(envelope.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });
});

describe('builtin_timing', () => {
  it('shows enabled status with no argument', async () => {
    mockSession.timingEnabled_get.mockReturnValue(true);
    const envelope: CommandEnvelope = await builtin_timing([]);
    expect(envelope.rendered).toContain('enabled');
    expect(envelope.model).toEqual({ kind: 'sys.timing', data: { enabled: true } });
  });
  it('shows disabled status with no argument', async () => {
    mockSession.timingEnabled_get.mockReturnValue(false);
    const envelope: CommandEnvelope = await builtin_timing([]);
    expect(envelope.rendered).toContain('disabled');
  });
  it('turns timing on', async () => {
    const envelope: CommandEnvelope = await builtin_timing(['on']);
    expect(mockSession.timingEnabled_set).toHaveBeenCalledWith(true);
    expect(envelope.model).toEqual({ kind: 'sys.timing', data: { enabled: true } });
  });
  it('turns timing off', async () => {
    const envelope: CommandEnvelope = await builtin_timing(['off']);
    expect(mockSession.timingEnabled_set).toHaveBeenCalledWith(false);
    expect(envelope.model).toEqual({ kind: 'sys.timing', data: { enabled: false } });
  });
  it('rejects an unknown argument', async () => {
    const envelope: CommandEnvelope = await builtin_timing(['sideways']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("unknown subcommand 'sideways' (on, off)");
  });
});

describe('builtin_physicalmode', () => {
  it('shows status with no argument', async () => {
    mockSession.physicalMode_get.mockReturnValue(true);
    const envelope: CommandEnvelope = await builtin_physicalmode([]);
    expect(envelope.rendered).toContain('enabled');
    expect(envelope.model).toEqual({ kind: 'sys.physicalMode', data: { enabled: true } });
  });
  it('turns physical mode on and off', async () => {
    const onEnvelope: CommandEnvelope = await builtin_physicalmode(['on']);
    expect(mockSession.physicalMode_set).toHaveBeenCalledWith(true);
    expect(onEnvelope.model).toEqual({ kind: 'sys.physicalMode', data: { enabled: true } });
    const offEnvelope: CommandEnvelope = await builtin_physicalmode(['off']);
    expect(mockSession.physicalMode_set).toHaveBeenCalledWith(false);
    expect(offEnvelope.model).toEqual({ kind: 'sys.physicalMode', data: { enabled: false } });
  });
  it('rejects an unknown argument', async () => {
    const envelope: CommandEnvelope = await builtin_physicalmode(['sideways']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("unknown subcommand 'sideways' (on, off)");
  });
});

describe('builtin_debug', () => {
  beforeEach(() => {
    mockSession.connection.config = { debug: false };
  });

  it('is refused by name on a backend with no debug mode', async () => {
    const { backend_install, backend_get } = await import('../src/core/backend.js');
    const chris = backend_get();
    backend_install({ id: 'plain', session: {} as never });
    const envelope: CommandEnvelope = await builtin_debug(['on']);
    backend_install(chris);
    expect(envelope.renderedErr).toContain('debug: this session has no debug mode.');
  });

  it('errors when the connection config is missing', async () => {
    mockSession.connection.config = null;
    const envelope: CommandEnvelope = await builtin_debug([]);
    expect(envelope.status).toBe('error');
    expect(envelope.errors?.[0].message).toContain('not initialized');
  });
  it('shows status with no argument', async () => {
    const envelope: CommandEnvelope = await builtin_debug([]);
    expect(envelope.rendered).toContain('Debug mode');
    expect(envelope.model).toEqual({ kind: 'sys.debug', data: { enabled: false } });
  });
  it('turns debug on and off', async () => {
    await builtin_debug(['on']);
    expect(mockSession.connection.config?.debug).toBe(true);
    await builtin_debug(['off']);
    expect(mockSession.connection.config?.debug).toBe(false);
  });
  it('rejects an unknown argument', async () => {
    const envelope: CommandEnvelope = await builtin_debug(['sideways']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("unknown subcommand 'sideways' (on, off)");
  });
});

describe('builtin_pwd', () => {
  it('reports the raw cwd without --title', async () => {
    mockSession.getCWD.mockResolvedValue('/home/chris/uploads');
    const envelope: CommandEnvelope = await builtin_pwd([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toBe('/home/chris/uploads\n');
    expect(envelope.model?.kind).toBe('fs.cwd');
  });

  it('replaces feed and plugin segments with titles for --title', async () => {
    mockSession.getCWD.mockResolvedValue('/home/chris/feeds/feed_123/pl-dircopy_456');
    mockFeedsList.mockResolvedValue({ tableData: [{ name: 'Brain Study' }] });
    mockInstancesList.mockResolvedValue({ tableData: [{ plugin_name: 'pl-dircopy', plugin_version: '2.1.1' }] });
    const envelope: CommandEnvelope = await builtin_pwd(['--title']);
    expect(envelope.rendered).toBe('/home/chris/feeds/Brain Study/pl-dircopy v2.1.1\n');
  });
});

describe('builtin_version', () => {
  it('resolves a version for every stack layer', () => {
    const versions: Record<string, string> = versions_get();
    for (const layer of ['chell', 'brasa', 'chili', 'salsa', 'cumin', 'calypso']) {
      expect(typeof versions[layer]).toBe('string');
      expect(versions[layer].length).toBeGreaterThan(0);
    }
  });

  it('builds a report naming chell, the brasa engine, its layers, and calypso', () => {
    const report: string = versionReport_build();
    for (const layer of ['chell', 'brasa', 'chili', 'salsa', 'cumin', 'calypso']) {
      expect(report).toContain(layer);
    }
  });

  it('yields an ok envelope carrying the report and a typed model', async () => {
    const envelope: CommandEnvelope = await builtin_version([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('chell');
    expect(envelope.model?.kind).toBe('sys.version');
    expect((envelope.model?.data as { cumin: string }).cumin).toBe(versions_get().cumin);
  });

  it('composes the welcome line from explicit values', () => {
    expect(welcomeLine_compose('chell', '5.3.0', 'abc123'))
      .toBe('ChELL Executes Layered Logic, v 5.3.0 (abc123). Welcome.');
    // A session host has nobody to welcome yet: its line ends at the build.
    expect(welcomeLine_compose('calypso', '0.5.0', 'abc123'))
      .toBe('CALYPSO Accepts Language, Yielding Permitted Shell Operations, v 0.5.0 (abc123).');
    // Unknown packages fall back to the chell surface identity.
    expect(welcomeLine_compose('nonsense', '1.0.0', 'abc123')).toContain('ChELL');
  });

  it('writes every package out in full on the stack banner, argus last when served', () => {
    const lines: string[] = stackBanner_build('0.6.0');
    expect(lines[0]).toMatch(/^ChELL Executes Layered Logic\s+\d/);
    expect(lines[lines.length - 1]).toMatch(/^ARGUS Renders Graphical User Surfaces\s+0\.6\.0$/);
    // Versions sit in one column: every name is padded to the widest.
    const versionColumn: Set<number> = new Set(lines.map((line: string): number => line.search(/\S+$/)));
    expect(versionColumn.size).toBe(1);
    // No web surface found, no argus row.
    expect(stackBanner_build(null).some((line: string): boolean => line.startsWith('ARGUS'))).toBe(false);
  });

  it('composes the banner from a daemon-reported stack, rows only for versions it reported', () => {
    const lines: string[] = stackBanner_compose({ chell: '5.6.2', calypso: '0.11.0' });
    expect(lines).toEqual([
      'ChELL Executes Layered Logic                                   5.6.2',
      'CALYPSO Accepts Language, Yielding Permitted Shell Operations  0.11.0',
    ]);
    expect(stackBanner_compose({})).toEqual([]);
  });

  it('paints a banner row in three parts and keeps the version column aligned', () => {
    const rows = stackBanner_rows({ chell: '5.6.2', calypso: '0.11.0' });
    const paint = { name: (s: string): string => `<${s}>`, phrase: (s: string): string => `{${s}}`, version: (s: string): string => `[${s}]` };
    const painted: string[] = rows.map((row) => stackBannerRow_paint(row, paint));
    expect(painted[0]).toBe(`<ChELL>{ Executes Layered Logic}${' '.repeat(rows[0].nameWidth - 'ChELL Executes Layered Logic'.length)}  [5.6.2]`);
    expect(painted[1]).toBe('<CALYPSO>{ Accepts Language, Yielding Permitted Shell Operations}  [0.11.0]');
    // Stripped of paint, the versions stand in one column.
    const plain: string[] = painted.map((line: string): string => line.replace(/[<>{}[\]]/g, ''));
    expect(new Set(plain.map((line: string): number => line.search(/\S+$/))).size).toBe(1);
  });

  it('builds a welcome line with the resolved version and a build hash', () => {
    const line: string = welcomeLine_build('chell');
    expect(line).toContain(`v ${versions_get().chell}`);
    expect(line).toMatch(/\([0-9a-f]{6}\)|\(dev\)|\(unknown\)/);
    expect(line.endsWith('. Welcome.')).toBe(true);
  });

  it('reports a non-empty build hash marker in every environment', () => {
    // Under ts-jest no dist/buildinfo.json exists, so the dev marker (or a
    // real hash when one does exist) must come back rather than throwing.
    const hash: string = buildHash_get();
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('builtin_fortune', () => {
  it('bundles a non-empty set of fortunes', () => {
    expect(FORTUNES.length).toBeGreaterThan(0);
    expect(FORTUNES.every((f: string) => f.length > 0)).toBe(true);
  });

  it('returns an ok envelope carrying a bundled fortune and typed model', async () => {
    const envelope: CommandEnvelope = await builtin_fortune([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered.length).toBeGreaterThan(0);
    expect(envelope.model?.kind).toBe('sys.fortune');
    const chosen = (envelope.model?.data as { fortune: string }).fortune;
    expect(FORTUNES).toContain(chosen);
    expect(envelope.rendered).toBe(`${chosen}\n`);
  });

  it('picks a bundled fortune, honouring a line-count bound', () => {
    const unbounded: string = fortune_random();
    expect(FORTUNES).toContain(unbounded);

    const bounded: string = fortune_random(4);
    expect(FORTUNES).toContain(bounded);
    expect(bounded.split('\n').length).toBeLessThanOrEqual(4);

    // An impossible bound falls back to the full collection instead of failing.
    expect(FORTUNES).toContain(fortune_random(0));
  });
});

describe('builtin_date', () => {
  const fixed = new Date('2026-07-13T22:24:05Z');

  it('formats strftime specifiers in UTC', () => {
    expect(date_format(fixed, '%Y-%m-%d', true)).toBe('2026-07-13');
    expect(date_format(fixed, '%H:%M:%S', true)).toBe('22:24:05');
    expect(date_format(fixed, '%A %B %e', true)).toBe('Monday July 13');
    expect(date_format(fixed, '100%%', true)).toBe('100%');
    expect(date_format(fixed, '%F %Z', true)).toBe('2026-07-13 UTC');
  });

  it('returns an ok envelope with the default format and a typed model', async () => {
    const envelope: CommandEnvelope = await builtin_date([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered.trim().length).toBeGreaterThan(0);
    expect(envelope.model?.kind).toBe('sys.date');
    expect(typeof (envelope.model?.data as { iso: string }).iso).toBe('string');
  });

  it('honours a +FORMAT argument', async () => {
    const envelope: CommandEnvelope = await builtin_date(['-u', '+%Y']);
    expect(envelope.rendered).toBe(`${new Date().getUTCFullYear()}\n`);
  });
});

describe('builtin_cal', () => {
  it('renders the current month with the weekday header', async () => {
    const envelope: CommandEnvelope = await builtin_cal([]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('Su Mo Tu We Th Fr Sa');
    expect(envelope.model?.kind).toBe('sys.cal');
  });

  it('renders a specific month, including a leap-year February', async () => {
    const envelope: CommandEnvelope = await builtin_cal(['2', '2024']);
    expect(envelope.rendered).toContain('February 2024');
    expect(envelope.rendered).toContain('29');
  });

  it('renders a full year as a grid', async () => {
    const envelope: CommandEnvelope = await builtin_cal(['2026']);
    expect(envelope.rendered).toContain('January');
    expect(envelope.rendered).toContain('December');
    expect(envelope.model?.data as { year: number }).toEqual({ year: 2026 });
  });

  it('rejects an invalid month', async () => {
    const envelope: CommandEnvelope = await builtin_cal(['13', '2026']);
    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toContain('not a month number');
  });
});

describe('stackInfo_get / infoReport_build', () => {
  it('describes every package with a role and resolved version', () => {
    const info = stackInfo_get();
    expect(info.map((item: { pkg: string; role: string }): [string, string] => [item.pkg, item.role])).toEqual([
      ['chell', 'surface'],
      ['brasa', 'engine'],
      ['chili', 'layer'],
      ['salsa', 'layer'],
      ['cumin', 'layer'],
      ['calypso', 'sessionHost'],
    ]);
    expect(info.find((item: { pkg: string }) => item.pkg === 'calypso')?.name)
      .toBe('CALYPSO Accepts Language, Yielding Permitted Shell Operations');
    for (const item of info) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.version.length).toBeGreaterThan(0);
    }
  });

  it('groups the info report by role, naming each package and version', () => {
    const report: string = infoReport_build();
    for (const heading of ['SURFACES', 'SESSION HOST', 'ENGINE', 'LAYERS']) {
      expect(report).toContain(heading);
    }
    expect(report.indexOf('calypso')).toBeGreaterThan(report.indexOf('SESSION HOST'));
    expect(report.indexOf('calypso')).toBeLessThan(report.indexOf('ENGINE'));
    for (const item of stackInfo_get()) {
      expect(report).toContain(item.name);
      expect(report).toContain(item.version);
    }
  });
});

describe('versions_selectForBackend', () => {
  const stack = { chell: '5.16.7', brasa: '0.44.1', chili: '3.7.14', salsa: '4.2.1', cumin: '3.28.3', calypso: '0.25.0' };

  it('names every package for a ChRIS session', () => {
    expect(versions_selectForBackend(stack, 'chris')).toEqual(stack);
  });

  it('leaves ChRIS\'s own packages out for any other backend', () => {
    expect(versions_selectForBackend(stack, 'stratus')).toEqual({ chell: '5.16.7', brasa: '0.44.1', calypso: '0.25.0' });
    expect(versions_selectForBackend(stack, 'null')).toEqual({ chell: '5.16.7', brasa: '0.44.1', calypso: '0.25.0' });
    expect(stack.cumin).toBe('3.28.3');
  });
});
