/**
 * @file Unit tests for the `setfacl` / `getfacl` / `chmod` builtins. The
 * kernel is mocked, as it is for every other builtin here.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

type R = { ok: boolean; value?: unknown };
const mockFeedShare = jest.fn<(feedID: number, username: string) => Promise<R>>();
const mockShareGroup = jest.fn<(feedID: number, group: string) => Promise<R>>();
const mockRevoke = jest.fn<(feedID: number, kind: string, name: string) => Promise<R>>();
const mockAccess = jest.fn<(feedID: number) => Promise<R>>();
const mockPublic = jest.fn<(feedID: number) => Promise<R>>();
const mockPrivate = jest.fn<(feedID: number) => Promise<R>>();
const mockStackPop = jest.fn<() => { type: string; message: string } | undefined>();

cuminMock_install(() => ({
  feed_share: mockFeedShare,
  feedShare_group: mockShareGroup,
  feedShare_revoke: mockRevoke,
  feedAccess_read: mockAccess,
  feed_makePublic: mockPublic,
  feed_makePrivate: mockPrivate,
  errorStack: { stack_pop: mockStackPop, stack_search: () => [] },
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string) => ({ status: 'error', rendered }),
  CommandEnvelope: class {},
}));

const mockQuestion = jest.fn<(prompt: string) => Promise<string>>();
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_question: mockQuestion }));

const { builtin_setfacl, builtin_getfacl, builtin_chmod, setfaclCommand, getfaclCommand, chmodCommand } = await import('../src/builtins/fs/acl.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/**
 * The refusal of a line, or a failure when it parses.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The refusal.
 */
async function refusal_get(declaration: Parameters<typeof commandLine_parse>[0], line: string): Promise<string> {
  const parsed = await commandLine_parse(declaration, shellWords_tokenize(line));
  if (parsed.ok) throw new Error(`expected a refusal for: ${line}`);
  return parsed.refusal;
}

describe('the Sharing lines, parsed against their declarations', () => {
  it('setfacl: -m or -x with its entry, anywhere among one or more feeds; none refused, an option it lacks named', async () => {
    const parsed = await commandLine_parse(setfaclCommand, shellWords_tokenize('feed_12 -m g:lab:r feed_13'));
    expect(parsed.ok && parsed.args.operands).toEqual({ path: ['feed_12', 'feed_13'] });
    expect(parsed.ok && parsed.args.options).toEqual({ modify: 'g:lab:r', remove: undefined });
    const long = await commandLine_parse(setfaclCommand, shellWords_tokenize('--remove=u:ann feed_1'));
    expect(long.ok && long.args.options['remove']).toBe('u:ann');
    expect(await refusal_get(setfaclCommand, '-m u:s:r')).toBe('setfacl: missing operand <path>; usage: setfacl [--modify <entry>] [--remove <entry>] <path…>');
    expect(await refusal_get(setfaclCommand, '-R -m u:s:r feed_1')).toBe("setfacl: invalid option -- 'R'; usage: setfacl [--modify <entry>] [--remove <entry>] <path…>");
    expect(await refusal_get(setfaclCommand, 'feed_1 -m')).toContain("option '-m' wants a value (<entry>)");
  });

  it('chmod: o+r or o-r, then the feeds; any other mode refused naming the two', async () => {
    const parsed = await commandLine_parse(chmodCommand, shellWords_tokenize('o-r feed_1 feed_2'));
    expect(parsed.ok && parsed.args.operands).toEqual({ mode: 'o-r', path: ['feed_1', 'feed_2'] });
    expect(await refusal_get(chmodCommand, 'u+x feed_1')).toBe("chmod: invalid argument 'u+x' for <mode> (valid: o+r, o-r); usage: chmod <mode> <path…>");
    expect(await refusal_get(chmodCommand, 'o+r')).toBe('chmod: missing operand <path>; usage: chmod <mode> <path…>');
  });

  it('getfacl: one or more feeds, and no option', async () => {
    expect(commandUsage_render(getfaclCommand)).toBe('getfacl <path…>');
    expect(await refusal_get(getfaclCommand, '-R feed_1')).toBe("getfacl: invalid option -- 'R'; usage: getfacl <path…>");
  });

  it('complete their options and modes, hold what the tables held, and write a tool each', async () => {
    expect(await declaredWord_complete(setfaclCommand, [], '-')).toEqual(['-m', '-x', '--modify', '--remove']);
    expect(await declaredWord_complete(chmodCommand, [], 'o')).toEqual(['o+r', 'o-r']);
    expect(getfaclCommand.holds).toEqual([]);
    expect(setfaclCommand.holds).toBeUndefined();
    expect(chmodCommand.holds).toBeUndefined();
    for (const declaration of [setfaclCommand, getfaclCommand, chmodCommand]) {
      expect(declaration.help.category).toBe('Sharing');
      expect(declaration.help.posix?.group).toBe('Files');
      expect(commandTools_derive(declaration).map((tool) => tool.name)).toEqual([declaration.name]);
    }
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStackPop.mockReturnValue(undefined);
  mockQuestion.mockResolvedValue('');
  for (const mock of [mockFeedShare, mockShareGroup, mockPublic, mockPrivate]) mock.mockResolvedValue({ ok: true, value: true });
  mockRevoke.mockResolvedValue({ ok: true, value: true });
  mockAccess.mockResolvedValue({ ok: true, value: { users: ['ann'], groups: ['lab'], public: false } });
});

describe('setfacl -m', () => {
  it('grants a user, a group, and makes a feed public or private by the other entry', async () => {
    expect((await builtin_setfacl(['-m', 'u:someone:r', '/home/me/feeds/feed_12'])).rendered).toBe('someone granted read on feed_12\n');
    expect(mockFeedShare).toHaveBeenCalledWith(12, 'someone');
    expect((await builtin_setfacl(['-m', 'g:lab:r', 'feed_12', 'feed_13'])).rendered).toBe('group lab granted read on feed_12 feed_13\n');
    expect(mockShareGroup).toHaveBeenCalledTimes(2);
    expect((await builtin_setfacl(['-m', 'o::r', '/proc/jobs/feed_12'])).rendered).toBe('feed_12 public\n');
    expect(mockPublic).toHaveBeenCalledWith(12);
    expect((await builtin_setfacl(['-m', 'o::-', 'feed_12'])).rendered).toBe('feed_12 private\n');
    expect(mockPrivate).toHaveBeenCalledWith(12);
  });

  it('asks who when given a feed and no entry, without saying a grant is permanent', async () => {
    mockQuestion.mockResolvedValue('someone');
    const envelope = await builtin_setfacl(['/home/me/feeds/feed_12']);
    expect(mockQuestion).toHaveBeenCalledWith('Share feed 12 with which user? ');
    expect(mockFeedShare).toHaveBeenCalledWith(12, 'someone');
    expect(envelope.status).toBe('ok');
  });

  it('grants nothing when the question is abandoned, nor for something that names no feed', async () => {
    expect((await builtin_setfacl(['feed_12'])).rendered).toContain('feed_12 shared with no one new');
    expect((await builtin_setfacl(['/home/me/notes.txt'])).rendered).toContain('does not name a feed');
    expect(mockFeedShare).not.toHaveBeenCalled();
  });

  it('refuses an entry that grants no read to a user or group, and passes the kernel\'s refusal on', async () => {
    expect((await builtin_setfacl(['-m', 'u:someone:w', 'feed_1'])).status).toBe('error');
    expect(mockFeedShare).not.toHaveBeenCalled();
    mockFeedShare.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ type: 'error', message: 'CUBE refused: not the owner' });
    expect((await builtin_setfacl(['-m', 'u:someone:r', 'feed_12'])).rendered).toBe('CUBE refused: not the owner\n');
  });
});

describe('setfacl -x', () => {
  it('withdraws a user or a group grant, and says when a feed held none', async () => {
    expect((await builtin_setfacl(['-x', 'u:ann', 'feed_12'])).rendered).toBe('user ann no longer reads feed_12\n');
    expect(mockRevoke).toHaveBeenCalledWith(12, 'user', 'ann');
    mockRevoke.mockResolvedValueOnce({ ok: true, value: false });
    expect((await builtin_setfacl(['-x', 'g:lab', 'feed_13'])).rendered).toBe('setfacl: feed_13: no entry for group lab\n');
  });

  it('refuses -x on the other entry and points at o::-', async () => {
    const envelope = await builtin_setfacl(['-x', 'o', 'feed_1']);
    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toContain('setfacl -m o::-');
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('chmod', () => {
  it('makes a feed public with o+r and private with o-r, and refuses any other mode', async () => {
    expect((await builtin_chmod(['o+r', 'feed_12'])).rendered).toBe('feed_12 public\n');
    expect((await builtin_chmod(['o-r', 'feed_12'])).rendered).toBe('feed_12 private\n');
    // A mode a feed lacks is refused by the parser, naming the two it has.
    expect((await builtin_chmod(['u+x', 'feed_12'])).status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(mockPublic).toHaveBeenCalledTimes(1);
    expect((await builtin_chmod(['o+r', '/home/me/uploads'])).rendered).toContain('does not name a feed');
  });
});

describe('getfacl', () => {
  it('renders users, groups and the other entry', async () => {
    const envelope = await builtin_getfacl(['/home/me/feeds/feed_12']);
    expect(envelope.rendered).toBe(['# file: home/me/feeds/feed_12', 'user::rw-', 'user:ann:r--', 'group:lab:r--', 'other::---'].join('\n') + '\n');
    expect(envelope.model).toEqual({ kind: 'fs.acl', data: [{ path: '/home/me/feeds/feed_12', usernames: ['ann'], groups: ['lab'], public: false }] });
  });

  it('asks for a path, and reports a failed read', async () => {
    expect((await builtin_getfacl([])).status).toBe('error');
    mockAccess.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ type: 'error', message: 'feed 12 not found' });
    expect((await builtin_getfacl(['feed_12'])).rendered).toBe('feed 12 not found\n');
  });
});
