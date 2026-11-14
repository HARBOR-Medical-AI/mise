import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';
import type { SessionMotd } from '@fnndsc/menu';

const mockContext = jest.fn();
const mockCache = {
  feeds_find: jest.fn(() => [] as unknown[]),
  feedScopeCounts_get: jest.fn(() => ({ user: 0, public: 0, shared: 0, total: 0 })),
  warmupProgress_get: jest.fn(() => ({ loaded: 0, total: 0, active: false })),
  lifecycle_get: jest.fn(() => ({ state: 'empty' })),
};
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: mockContext }));
cuminMock_install(() => ({
  procCache_get: () => mockCache,
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
}));

const { builtin_motd, motd_gather, motd_render } = await import('../src/builtins/sys/motd.js');

/** A feed with the given job counters, the rest zero. */
function feed_make(counts: Partial<Record<'finishedJobs' | 'erroredJobs' | 'startedJobs' | 'scheduledJobs' | 'cancelledJobs' | 'createdJobs', number>>): unknown {
  return { id: 1, ownerUsername: 'chris', finishedJobs: 0, erroredJobs: 0, startedJobs: 0, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0, ...counts };
}

beforeEach(() => {
  mockContext.mockReset();
  mockCache.feeds_find.mockReset().mockReturnValue([]);
  mockCache.feedScopeCounts_get.mockReset().mockReturnValue({ user: 0, public: 0, shared: 0, total: 0 });
  mockCache.warmupProgress_get.mockReset().mockReturnValue({ loaded: 0, total: 0, active: false });
  mockCache.lifecycle_get.mockReset().mockReturnValue({ state: 'empty' });
});

describe('motd_gather', () => {
  it('sums the jobs across feeds and derives the failure rate from what settled', () => {
    mockCache.feeds_find.mockReturnValue([
      feed_make({ finishedJobs: 90, erroredJobs: 10, startedJobs: 4, scheduledJobs: 1 }),
      feed_make({ finishedJobs: 100, cancelledJobs: 2, createdJobs: 2 }),
    ]);
    mockCache.feedScopeCounts_get.mockReturnValue({ user: 300, public: 100, shared: 12, total: 412 });
    mockCache.warmupProgress_get.mockReturnValue({ loaded: 209, total: 209, active: false });
    mockCache.lifecycle_get.mockReturnValue({ state: 'current' });
    const motd: SessionMotd = motd_gather('chris', 'ARGUS');
    expect(motd.feeds).toEqual({ total: 412, own: 300, shared: 12, public: 100 });
    expect(motd.jobs).toEqual({ total: 209, finished: 190, errored: 10, cancelled: 2, running: 4, scheduled: 3 });
    expect(motd.failureRate).toBeCloseTo(0.05);
    expect(motd.index).toEqual({ state: 'current', loaded: 209, total: 209 });
    expect(motd.fortune.split('\n').length).toBeLessThanOrEqual(4);
  });
  it('has no failure rate before anything settled, and calls a live sweep warming', () => {
    mockCache.feeds_find.mockReturnValue([feed_make({ startedJobs: 2 })]);
    mockCache.warmupProgress_get.mockReturnValue({ loaded: 4700, total: 210012, active: true });
    mockCache.lifecycle_get.mockReturnValue({ state: 'reconciling' });
    const motd: SessionMotd = motd_gather('chris', '');
    expect(motd.failureRate).toBeNull();
    expect(motd.index.state).toBe('warming');
  });
});

describe('motd_render', () => {
  const base: SessionMotd = {
    user: 'chris',
    surface: 'ARGUS',
    feeds: { total: 412, own: 300, shared: 12, public: 100 },
    jobs: { total: 210012, finished: 205000, errored: 2700, cancelled: 12, running: 480, scheduled: 3 },
    failureRate: 2700 / 207700,
    index: { state: 'current', loaded: 210012, total: 210012 },
    fortune: 'A cookie.',
  };
  it('says where you arrived, the counts, the rate, the pulse, then the fortune', () => {
    expect(motd_render(base)).toBe([
      'Welcome to ARGUS, chris.',
      '412 feeds · 210,012 jobs run · 1.3 % failed · 480 running, 3 scheduled',
      '',
      'A cookie.',
      '',
    ].join('\n'));
  });
  it('says so far while warming, and leaves out what it does not have', () => {
    const warming: SessionMotd = { ...base, surface: '', jobs: { ...base.jobs, running: 0, scheduled: 0 }, failureRate: null, index: { state: 'warming', loaded: 4700, total: 210012 }, fortune: '' };
    expect(motd_render(warming)).toBe('Welcome, chris.\n412 feeds · 4,700 of 210,012 jobs indexed so far\n');
  });
  it('says a cold index is cold', () => {
    const cold: SessionMotd = { ...base, feeds: { total: 0, own: 0, shared: 0, public: 0 }, index: { state: 'cold', loaded: 0, total: 0 }, fortune: '' };
    expect(motd_render(cold)).toBe('Welcome to ARGUS, chris.\nyour index is still cold: the feeds and jobs arrive as it warms\n');
  });
});

describe('builtin_motd', () => {
  it('greets the connected user with the typed model beneath', async () => {
    mockContext.mockResolvedValue({ user: 'chris', URL: 'https://c/api/v1/' });
    const envelope: CommandEnvelope = await builtin_motd(['ARGUS']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered.startsWith('Welcome to ARGUS, chris.\n')).toBe(true);
    expect(envelope.model?.kind).toBe('session.motd');
    expect((envelope.model?.data as SessionMotd).surface).toBe('ARGUS');
  });
  it('says so when nobody is connected, and refuses a flag by name', async () => {
    mockContext.mockResolvedValue({ user: null, URL: null });
    expect((await builtin_motd([])).rendered).toMatch(/not connected/);
    expect(((await builtin_motd(['--brief'])) as { renderedErr?: string }).renderedErr).toMatch(/unrecognized option '--brief'/);
  });
});
