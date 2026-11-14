/**
 * @file The lab's own toys and the byte tools on the games shelf, and the
 * QR encoder's arithmetic.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockUrl = jest.fn(async (): Promise<string | null> => 'http://cube.example:8000/api/v1/');
const mockUser = jest.fn(async (): Promise<string | null> => 'ada');
const mockCatBinary = jest.fn(async (_path: string): Promise<{ ok: boolean; value?: Buffer }> => ({ ok: true, value: Buffer.from('hello') }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  chrisContext: { ChRISURL_get: mockUrl, ChRISuser_get: mockUser },
  requestLedger_snapshot: () => ({ since: '', total: 4, ms: 400, families: [], last: [] }),
  errorStack: { stack_pop: () => undefined, stack_push: () => undefined },
  procCache_get: () => ({
    feeds_find: () => [],
    feedScopeCounts_get: () => ({ user: 1, public: 2, shared: 3, total: 6 }),
    warmupProgress_get: () => ({ active: false, loaded: 0, total: 0 }),
    lifecycle_get: () => ({ state: 'current' }),
  }),
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({ files_catBinary: mockCatBinary, files_cat: jest.fn(async () => ({ ok: false })) }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: async (p: string): Promise<string> => p, storePath_resolve: async (p: string): Promise<string> => p, error_stripDebugPrefix: (s: string): string => s }));
jest.unstable_mockModule('../src/core/surface.js', () => ({ surface_get: () => ({ peers: () => [{ id: 's1', kind: 'browser', you: true }, { id: 's2', kind: 'chell', you: false, asking: 'Another game: ' }] }) }));
jest.unstable_mockModule('../src/chris/jobsState.js', () => ({ jobsState_derive: () => ({ running: 0, scheduled: 0 }) }));
jest.unstable_mockModule('../src/builtins/sys/fortune.js', () => ({ fortune_random: () => 'a fortune' }));

const { uptime_words, builtin_who, builtin_say } = await import('../src/builtins/games/lab.js');
const { ping_run, ping_summary, builtin_ping, builtin_chrisfetch } = await import('../src/builtins/games/chrislab.js');
// `who` asks the backend for the session's user: here, the context this file mocks.
(await import('../src/core/backend.js')).backend_install({ id: 'chris', session: { user_get: (): Promise<string | null> => mockUser() } as never });
const { wtf_lookup, builtin_wtf } = await import('../src/builtins/games/wtf.js');
const { magic_derive, hexdump_render, strings_find, builtin_file, builtin_xxd, builtin_sha256sum } = await import('../src/builtins/games/bytes.js');
const { rs_remainder, qr_encode, qr_render, penalty_compute } = await import('../src/builtins/games/qr.js');

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('who, uptime, ping, chrisfetch, say', () => {
  it('who names the peers and marks you', async () => {
    const out: string = plain((await builtin_who([])).rendered);
    expect(out).toMatch(/ada\s+browser\s+s1\s+\(you\)/);
    expect(out).toMatch(/ada\s+chell\s+s2/);
    // A surface with a question open says what it is waiting on.
    expect(out).toMatch(/s2\s+\? Another game:/);
    expect(out).not.toMatch(/s1.*\?/);
  });

  it('uptime words', () => {
    expect(uptime_words(65)).toBe('1m 05s');
    expect(uptime_words(3 * 3600 + 7 * 60)).toBe('3h 07m');
    expect(uptime_words(2 * 86400 + 3600 + 240)).toBe('2d 1h 04m');
  });

  it('ping times each round trip and sums up; a lost one is lost', async () => {
    let calls: number = 0;
    const fetchFn = async (): Promise<{ status: number }> => { calls++; if (calls === 2) throw new Error('down'); return { status: 401 }; };
    const samples = await ping_run('http://x', 3, fetchFn);
    expect(samples.map((s) => s.status)).toEqual([401, null, 401]);
    expect(ping_summary(samples)).toMatch(/3 sent, 2 answered, 33% lost/);
    const out: string = plain((await builtin_ping(['-c', '2'], fetchFn)).rendered);
    expect(out).toContain('PING cube (http://cube.example:8000/api/v1/)');
    expect(out).toMatch(/2 sent/);
    expect(out).toContain('100 ms each on average');
    expect((await builtin_ping(['pacs'])).status).toBe('error');
  });

  it('chrisfetch sets the brain beside the facts', async () => {
    const out: string = plain((await builtin_chrisfetch([])).rendered);
    expect(out).toContain('ada@cube.example');
    expect(out).toMatch(/Feeds\s+6 \(1 own, 3 shared, 2 public\)/);
    expect(out).toMatch(/Surfaces\s+2 attached \(1 browser, 1 chell\)/);
    expect(out).toContain('((()))');
  });

  it('say prints the words and carries them in the model', async () => {
    const envelope = await builtin_say(['hello', 'there']);
    expect(plain(envelope.rendered)).toBe('♪ hello there\n');
    expect((envelope.model as { data: { text: string } }).data.text).toBe('hello there');
    expect((await builtin_say([])).status).toBe('error');
  });
});

describe('wtf', () => {
  it('knows the lab, forgives "is" and case, and says when it does not know', async () => {
    expect(wtf_lookup('LONK')[0]).toMatch(/Light Oxidicom NotifiKations/);
    expect(wtf_lookup('c-move').length).toBe(1);
    const out: string = plain((await builtin_wtf(['is', 'cube', 'frobnicator'])).rendered);
    expect(out).toMatch(/^CUBE — the ChRIS Ultron Back End/m);
    expect(out).toMatch(/FROBNICATOR: nothing known/);
    expect(plain((await builtin_wtf(['-l'])).rendered)).toContain('pfdcm');
  });
});

describe('file, xxd, strings, sha256sum', () => {
  it('names files by their magic', () => {
    const dicom: Buffer = Buffer.alloc(200); dicom.write('DICM', 128, 'latin1');
    expect(magic_derive(dicom)).toMatch(/^DICOM/);
    expect(magic_derive(Buffer.from([0x1f, 0x8b, 0]), 'x.nii.gz')).toMatch(/NIfTI/);
    expect(magic_derive(Buffer.from('%PDF-1.4'))).toBe('PDF document');
    expect(magic_derive(Buffer.from('{"a": 1}'))).toBe('JSON text');
    expect(magic_derive(Buffer.from('plain words\n'))).toBe('ASCII text');
    expect(magic_derive(Buffer.from([0, 1, 2, 3, 250]))).toBe('data');
    expect(magic_derive(Buffer.alloc(0))).toBe('empty');
  });

  it('dumps hex canonically and finds strings', () => {
    expect(hexdump_render(Buffer.from('ABCDEFGHIJKLMNOPQ'))).toBe('00000000: 4142 4344 4546 4748 494a 4b4c 4d4e 4f50  ABCDEFGHIJKLMNOP\n00000010: 51                                       Q');
    expect(strings_find(Buffer.from('ab\0hello\0\x01worlds!\0xy'))).toEqual(['hello', 'worlds!']);
  });

  it('reads the file the way cat does', async () => {
    expect(plain((await builtin_file(['a.txt'])).rendered)).toMatch(/^a\.txt: ASCII text/);
    expect(plain((await builtin_xxd(['a.txt'])).rendered)).toBe('00000000: 6865 6c6c 6f                             hello\n');
    expect(plain((await builtin_sha256sum(['a.txt'])).rendered)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  a.txt\n');
    mockCatBinary.mockResolvedValueOnce({ ok: false });
    expect((await builtin_file(['gone'])).status).toBe('error');
  });
});

describe('qr', () => {
  it('computes Reed–Solomon check codewords (the HELLO WORLD vector)', () => {
    // The 1-M "HELLO WORLD" example from Thonky: 16 data codewords, 10 ec.
    const data: number[] = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rs_remainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('picks the smallest version that fits, draws finders, and renders half blocks', () => {
    const small = qr_encode('hi');
    expect(small?.version).toBe(1);
    expect(small?.size).toBe(21);
    const dark: boolean[][] = small?.dark as boolean[][];
    // The finder's corners and centre are dark, its ring light.
    expect(dark[0]?.[0]).toBe(true); expect(dark[3]?.[3]).toBe(true); expect(dark[1]?.[1]).toBe(false);
    expect(dark[0]?.[20]).toBe(true); expect(dark[20]?.[0]).toBe(true);
    // The dark module beside the lower-left finder.
    expect(dark[21 - 8]?.[8]).toBe(true);
    expect(qr_encode('x'.repeat(60))?.version).toBe(4);
    // Version 10's alignment centres are 6, 28 and 50 (a table once said 52,
    // and every version-10 code was unreadable): the pattern's centre is
    // dark, its ring light, and the top-right finder's ring is untouched.
    const ten = qr_encode('y'.repeat(250));
    expect(ten?.version).toBe(10);
    expect(ten?.dark[1]?.[ten.size - 2]).toBe(false);
    expect(ten?.dark[28]?.[50]).toBe(true);
    expect(ten?.dark[27]?.[50]).toBe(false);
    expect(ten?.dark[28]?.[28]).toBe(true);
    expect(qr_encode('x'.repeat(250))?.version).toBe(10);
    expect(qr_encode('x'.repeat(272))).toBeNull();
    const lines: string[] = qr_render(dark);
    expect(lines.length).toBe((21 + 4) / 2 + 0.5);
    expect(lines[0]).toBe('█'.repeat(25));
    expect(penalty_compute(dark)).toBeGreaterThan(0);
  });
});
