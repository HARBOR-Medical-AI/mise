/**
 * @file Where `play` reads a manifest from, and when it may look on the
 * engine's own disk: only after the backend's files say the path is none of
 * theirs or is proved absent, and only where that disk is the operator's.
 * Every case counts the reads of the disk.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: async (typed: string): Promise<string> => typed }));

const { manifestText_read } = await import('../src/builtins/res/manifestRead.js');
const { backend_install } = await import('../src/core/backend.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');
const { FileReadRefusal } = await import('../src/core/fileRefusal.js');
const { errorStack } = await import('@fnndsc/fond');

type Standing = 'outside' | 'absent' | 'unknown';

/** What the backend's files do with the one path the tests ask for. */
interface Files {
  /** The text a read answers, or what it throws. */
  readonly read: string | Error;
  /** Where the path stands; undefined for a backend that offers no such question. */
  readonly standing?: Standing | Error;
}

/** Paths the disk was read at. */
let diskReads: string[];
/** What the disk holds, by path; a path not here is ENOENT, an Error is thrown as it is. */
let disk: Map<string, string | Error>;
/** How often the backend was asked where a path stands. */
let standingAsked: number;

/** The stand-in for the file system's read, counting. */
async function disk_read(target: string): Promise<string> {
  diskReads.push(target);
  const held: string | Error | undefined = disk.get(target);
  if (held === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), { code: 'ENOENT' });
  if (held instanceof Error) throw held;
  return held;
}

/** Installs a backend with these files, or one with no files at all. */
function backend_set(files: Files | null): void {
  backend_install({
    id: 'test',
    session: {} as never,
    ...(files === null ? {} : {
      files: {
        read: async (): Promise<Buffer> => {
          // A miss leaves notes behind, as CUBE's does; the read drains them.
          if (files.read instanceof Error) { errorStack.stack_push('error', 'a note the failed read left'); throw files.read; }
          return Buffer.from(files.read);
        },
        write: async (): Promise<void> => undefined,
        ...(files.standing === undefined ? {} : {
          standing: async (): Promise<Standing> => {
            standingAsked += 1;
            if (files.standing instanceof Error) throw files.standing;
            return files.standing as Standing;
          },
        }),
      },
    }),
  } as never);
}

/** Says whose the engine's disk is. */
function tier_set(on: boolean): void {
  const surface = new HeadlessSurface();
  Object.assign(surface.capabilities, { engineFilesystem: on });
  surface_set(surface);
}

const AT: string = '/work/flows/battery.mise';
const NOBODYS: string = "the session's host disk is nobody's; start the session with --host-control=files";

beforeEach(() => {
  diskReads = [];
  disk = new Map([[AT, 'on the disk']]);
  standingAsked = 0;
  errorStack.stack_clear();
});

afterEach(() => { surface_set(new HeadlessSurface()); });

describe.each([[true], [false]])('with the files tier %s', (tier: boolean) => {
  beforeEach(() => tier_set(tier));

  it('a manifest the backend has is read from the backend, and the disk is not looked at', async () => {
    backend_set({ read: 'in the store', standing: 'unknown' });
    expect(await manifestText_read(AT, disk_read)).toEqual({ ok: true, value: { text: 'in the store', from: AT } });
    expect(diskReads).toEqual([]);
    expect(standingAsked).toBe(0);
  });

  it.each([
    ['refused', new FileReadRefusal(AT, 403, 'not yours to read: CUBE refused the bytes (403)'), 'not yours to read: CUBE refused the bytes (403)'],
    ['failed', new FileReadRefusal(AT, 502, 'CUBE could not serve it (503)'), 'CUBE could not serve it (503)'],
    ['said not found, without a proof', new FileReadRefusal(AT, 404, 'no such file in CUBE (404)'), 'no such file in CUBE (404)'],
    ['threw something of its own', new Error('socket hang up'), 'socket hang up'],
  ])('a read that %s, with the path\'s standing unknown, is said as that and the disk is never read', async (_what: string, failure: Error, said: string) => {
    backend_set({ read: failure, standing: 'unknown' });
    const answer = await manifestText_read(AT, disk_read);
    expect(answer).toEqual({ ok: false, reason: `cannot read ${AT} — ${said}; the engine's disk was not looked at, since the session's own files did not say it is absent` });
    expect(diskReads).toEqual([]);
    expect(errorStack.stack_getAll()).toEqual([]);
  });

  it('a backend that cannot say where a path stands never lets the disk be read behind a failed read', async () => {
    backend_set({ read: new FileReadRefusal(AT, 404, 'no such file in CUBE (404)') });
    expect((await manifestText_read(AT, disk_read)).ok).toBe(false);
    expect(diskReads).toEqual([]);
  });

  it('a standing that itself fails is not a proof', async () => {
    backend_set({ read: new Error('no such file'), standing: new Error('the listing broke') });
    const answer = await manifestText_read(AT, disk_read);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain("the engine's disk was not looked at");
    expect(diskReads).toEqual([]);
  });
});

describe('with the files tier on', () => {
  beforeEach(() => tier_set(true));

  it.each([
    ['proved absent from the backend', { read: new FileReadRefusal(AT, 404, 'no such file in CUBE (404)'), standing: 'absent' } as Files],
    ['outside the backend\'s files', { read: new Error(`cannot read ${AT}: EROFS`), standing: 'outside' } as Files],
    ['asked of a backend with no files', null],
  ])('a manifest %s is read from the disk, once', async (_what: string, files: Files | null) => {
    backend_set(files);
    expect(await manifestText_read(AT, disk_read)).toEqual({ ok: true, value: { text: 'on the disk', from: AT } });
    expect(diskReads).toEqual([AT]);
    expect(errorStack.stack_getAll()).toEqual([]);
  });

  it('says not found when neither has it, in words for each way the backend stood', async () => {
    disk.clear();
    backend_set({ read: new Error('gone'), standing: 'absent' });
    expect(await manifestText_read(AT, disk_read)).toEqual({ ok: false, reason: `cannot read ${AT} — no such manifest in the session's filesystem, and none beside the engine.` });
    backend_set({ read: new Error('not mine'), standing: 'outside' });
    expect(await manifestText_read(AT, disk_read)).toEqual({ ok: false, reason: `cannot read ${AT} — ${AT} is not in the session's filesystem, and none beside the engine.` });
    expect(diskReads).toEqual([AT, AT]);
  });

  it('says a disk that could not be read, which is not the same as nothing there', async () => {
    disk.set(AT, Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    backend_set(null);
    expect(await manifestText_read(AT, disk_read)).toEqual({ ok: false, reason: `cannot read ${AT} — ${AT} is not in the session's filesystem, and beside the engine it could not be read (EACCES)` });
  });
});

describe('with the files tier off', () => {
  beforeEach(() => tier_set(false));

  it.each([
    ['proved absent from the backend', { read: new Error('gone'), standing: 'absent' } as Files, "no such manifest in the session's filesystem"],
    ['outside the backend\'s files', { read: new Error('not mine'), standing: 'outside' } as Files, `${AT} is not in the session's filesystem`],
    ['asked of a backend with no files', null, `${AT} is not in the session's filesystem`],
  ])('a manifest %s is refused by name, and the disk is read zero times', async (_what: string, files: Files | null, where: string) => {
    backend_set(files);
    expect(await manifestText_read(AT, disk_read)).toEqual({ ok: false, reason: `cannot read ${AT} — ${where}, and beside the engine it was not looked for: ${NOBODYS}` });
    expect(diskReads).toEqual([]);
  });
});
