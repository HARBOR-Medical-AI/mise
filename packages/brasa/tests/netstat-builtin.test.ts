/**
 * @file netstat: the wire is a readout. The ledger is stubbed at its own
 * door; the builtin's rendering and options are what is exercised.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';

cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown): CommandEnvelope => ({ status: 'ok', rendered, model } as CommandEnvelope),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string): CommandEnvelope => {
    const envelope: CommandEnvelope = { status: 'error', rendered };
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
}));

const snapshot = {
  total: 3,
  ms: 450,
  since: '12:00:00',
  families: [
    { family: 'filebrowser/search', count: 2, ms: 300 },
    { family: 'plugins', count: 1, ms: 150 },
  ],
  last: [
    { ms: 120, status: 200, method: 'GET', path: 'filebrowser/search?path=home' },
    { ms: 180, status: 404, method: 'GET', path: 'filebrowser/search?path=nope' },
    { ms: 150, status: 0, method: 'GET', path: 'plugins' },
  ],
};
const mockSnapshot = jest.fn(() => snapshot);
const mockReset = jest.fn();
jest.unstable_mockModule('@fnndsc/cumin/request-ledger', () => ({
  requestLedger_snapshot: mockSnapshot,
  requestLedger_reset: mockReset,
}));

const { builtin_netstat, netstat_render } = await import('../src/builtins/net/netstat.js');

/** Strips ANSI colour so the words can be read. */
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('netstat_render', () => {
  it('reads the total, every family and the last requests, timed', () => {
    const out: string = plain(netstat_render(snapshot, 10));
    expect(out).toContain('REQUESTS 3 since 12:00:00');
    expect(out).toContain('450 ms on the wire');
    expect(out).toMatch(/filebrowser\/search\s+2\s+300 ms/);
    expect(out).toMatch(/plugins\s+1\s+150 ms/);
    expect(out).toContain('LAST 3');
    expect(out).toMatch(/120 ms\s+200\s+GET\s+filebrowser\/search\?path=home/);
    expect(out).toMatch(/180 ms\s+404\s+GET/);
    expect(out).toMatch(/150 ms\s+FAIL\s+GET\s+plugins/);
  });

  it('shows only the last N asked for, and nothing of an empty ledger but its count', () => {
    expect(plain(netstat_render(snapshot, 1))).toContain('LAST 1');
    const empty: string = plain(netstat_render({ total: 0, ms: 0, since: '12:00:00', families: [], last: [] }, 10));
    expect(empty).toContain('REQUESTS 0 since');
    expect(empty).not.toContain('LAST');
  });
});

describe('builtin_netstat', () => {
  it('answers the snapshot as text and as the net.stats model', async () => {
    const envelope: CommandEnvelope = await builtin_netstat([]);
    expect(envelope.status).toBe('ok');
    expect(plain(envelope.rendered)).toContain('REQUESTS 3');
    expect((envelope as { model?: { kind: string; data: unknown } }).model).toEqual({ kind: 'net.stats', data: snapshot });
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('-r resets the ledger after reading it and says so', async () => {
    const envelope: CommandEnvelope = await builtin_netstat(['-r']);
    expect(envelope.status).toBe('ok');
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(plain(envelope.rendered)).toContain('count reset');
  });

  it('-n N shows the last N', async () => {
    const envelope: CommandEnvelope = await builtin_netstat(['-n', '2']);
    expect(plain(envelope.rendered)).toContain('LAST 2');
    expect(mockSnapshot).toHaveBeenCalledWith({ last: 10 });
  });

  it('refuses a count that is not one, and an option it does not know, by name', async () => {
    const bad: CommandEnvelope = await builtin_netstat(['-n', 'x']);
    expect(bad.status).toBe('error');
    expect(plain(bad.renderedErr ?? '')).toContain("netstat: invalid argument 'x' for '-n' (not a whole number)");
    const negative: CommandEnvelope = await builtin_netstat(['-n', '-1']);
    expect(plain(negative.renderedErr ?? '')).toContain("netstat: invalid argument '-1' for '-n' (at least 0)");
    const unknown: CommandEnvelope = await builtin_netstat(['--verbose']);
    expect(unknown.status).toBe('error');
    expect(plain(unknown.renderedErr ?? '')).toContain("netstat: unrecognized option '--verbose'");
    expect(mockSnapshot).not.toHaveBeenCalled();
    process.exitCode = 0;
  });
});
