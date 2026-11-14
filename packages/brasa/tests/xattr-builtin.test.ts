/**
 * @file Unit tests for the `setfattr` / `getfattr` builtins. The kernel is mocked.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

type Tags = { ok: boolean; value?: Array<{ id: number; name: string; color: string }> };
const mockList = jest.fn<(feedId: number) => Promise<Tags>>();
const mockAdd = jest.fn<(feedId: number, name: string) => Promise<{ ok: boolean; value?: boolean }>>();
const mockRemove = jest.fn<(feedId: number, name: string) => Promise<{ ok: boolean; value?: boolean }>>();
const mockStackPop = jest.fn<() => { type: string; message: string } | undefined>();

cuminMock_install(() => ({
  feedTags_list: mockList,
  feedTag_add: mockAdd,
  feedTag_remove: mockRemove,
  errorStack: { stack_pop: mockStackPop, stack_search: () => [] },
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  CommandEnvelope: class {},
}));

jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  error_stripDebugPrefix: (message: string): string => message.replace(/^\[[^\]]*\]\s*\|\s*/, ''),
}));

const { builtin_getfattr, builtin_setfattr, getfattrCommand, setfattrCommand } = await import('../src/builtins/fs/xattr.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

describe('the tag lines, parsed against their declarations', () => {
  it('setfattr: -n or -x naming tag, -v its value, then the feeds; another attribute refused naming tag', async () => {
    const parsed = await commandLine_parse(setfattrCommand, shellWords_tokenize('-n user.tag -v review feed_12 feed_13'));
    expect(parsed.ok && parsed.args.options).toEqual({ name: 'user.tag', value: 'review', remove: undefined });
    expect(parsed.ok && parsed.args.operands).toEqual({ path: ['feed_12', 'feed_13'] });
    const refused = await commandLine_parse(setfattrCommand, shellWords_tokenize('-n color -v red feed_12'));
    expect(!refused.ok && refused.refusal).toBe("setfattr: invalid argument 'color' for '--name' (valid: tag, user.tag); usage: setfattr [--name <name>] [--value <value>] [--remove <name>] <path…>");
    const bad = await commandLine_parse(setfattrCommand, shellWords_tokenize('-n tag -v x -q feed_12'));
    expect(!bad.ok && bad.refusal).toMatch(/^setfattr: invalid option -- 'q'/);
  });

  it('setfattr: a line that neither sets nor removes, both, or sets without a value, is refused with the usage', async () => {
    expect((await builtin_setfattr(['feed_12'])).renderedErr).toContain('setfattr: -n tag or -x tag is needed; usage: setfattr ');
    expect((await builtin_setfattr(['-n', 'tag', '-x', 'tag', 'feed_12'])).renderedErr).toContain('-n sets and -x removes; give one');
    expect((await builtin_setfattr(['-n', 'tag', 'feed_12'])).renderedErr).toContain('-n tag needs -v <value>');
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('getfattr: -n tag and -d, then the feeds; completes the one attribute and holds nothing', async () => {
    expect(commandUsage_render(getfattrCommand)).toBe('getfattr [-d] [--name <name>] <path…>');
    expect(await declaredWord_complete(getfattrCommand, ['-n'], '')).toEqual(['tag', 'user.tag']);
    expect(getfattrCommand.holds).toEqual([]);
    expect(setfattrCommand.holds).toBeUndefined();
    expect(getfattrCommand.help.category).toBe('Sharing');
  });
});

const tag = (name: string) => ({ id: 1, name, color: '#888888' });

beforeEach(() => {
  jest.clearAllMocks();
  mockStackPop.mockReturnValue(undefined);
  mockList.mockResolvedValue({ ok: true, value: [] });
  mockAdd.mockResolvedValue({ ok: true, value: true });
  mockRemove.mockResolvedValue({ ok: true, value: true });
});

describe('getfattr', () => {
  it("dumps each feed's tags with a model", async () => {
    mockList.mockResolvedValueOnce({ ok: true, value: [tag('urgent'), tag('review')] }).mockResolvedValueOnce({ ok: true, value: [] });
    const envelope = await builtin_getfattr(['feed_12', '/proc/jobs/feed_13']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toBe('# file: feed_12\ntag="urgent"\ntag="review"\n\n# file: /proc/jobs/feed_13\n');
    expect(mockList.mock.calls.map((c) => c[0])).toEqual([12, 13]);
    expect((envelope as { model?: { kind: string } }).model?.kind).toBe('fs.xattr');
  });

  it('refuses a path that names no feed, a bad invocation, and says the kernel\'s words on failure', async () => {
    expect((await builtin_getfattr(['nowhere'])).rendered).toBe("getfattr: 'nowhere' does not name a feed\n");
    // A line with no feed is refused by the parser, before anything is read.
    expect((await builtin_getfattr([])).status).toBe('error');
    expect(mockList).not.toHaveBeenCalled();
    mockList.mockResolvedValueOnce({ ok: false });
    mockStackPop.mockReturnValueOnce({ type: 'error', message: 'Not connected to ChRIS.' });
    expect((await builtin_getfattr(['feed_12'])).rendered).toBe('Not connected to ChRIS.\n');
  });
});

describe('setfattr', () => {
  it('hangs a tag on every feed named, silently', async () => {
    const envelope = await builtin_setfattr(['-n', 'tag', '-v', 'urgent', 'feed_12', '13']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toBe('');
    expect(mockAdd.mock.calls).toEqual([[12, 'urgent'], [13, 'urgent']]);
  });

  it('takes one tag off, and refuses a value the feed does not wear', async () => {
    expect((await builtin_setfattr(['-x', 'tag', '-v', 'urgent', 'feed_12'])).status).toBe('ok');
    expect(mockRemove).toHaveBeenCalledWith(12, 'urgent');
    mockRemove.mockResolvedValueOnce({ ok: true, value: false });
    expect((await builtin_setfattr(['-x', 'tag', '-v', 'absent', 'feed_12'])).rendered).toBe('setfattr: feed_12: tag="absent": No such attribute value\n');
  });

  it('takes every tag off with -x tag alone', async () => {
    mockList.mockResolvedValueOnce({ ok: true, value: [tag('a'), tag('b')] });
    expect((await builtin_setfattr(['-x', 'tag', 'feed_12'])).status).toBe('ok');
    expect(mockRemove.mock.calls).toEqual([[12, 'a'], [12, 'b']]);
  });

  it("refuses a bad target, a bad invocation, and passes the kernel's refusal on", async () => {
    expect((await builtin_setfattr(['-n', 'tag', '-v', 'x', 'nowhere'])).rendered).toBe("setfattr: 'nowhere' does not name a feed\n");
    // An attribute a feed lacks is refused by the parser, naming the one it has.
    expect((await builtin_setfattr(['-n', 'color', '-v', 'x', 'feed_12'])).status).toBe('error');
    expect(mockAdd).not.toHaveBeenCalled();
    mockAdd.mockResolvedValueOnce({ ok: false });
    expect((await builtin_setfattr(['-n', 'tag', '-v', 'x', 'feed_12'])).rendered).toBe('setfattr: feed_12: could not add tag x\n');
    // A tag that is not in the vocabulary: the kernel's words, the cure named.
    mockAdd.mockResolvedValueOnce({ ok: false });
    mockStackPop.mockReturnValueOnce({ type: 'error', message: '[feedTag_add      ] | x: No such tag (mkdir /proc/tags/x)' });
    expect((await builtin_setfattr(['-n', 'tag', '-v', 'x', 'feed_12'])).rendered).toBe('setfattr: feed_12: x: No such tag (mkdir /proc/tags/x)\n');
    mockList.mockResolvedValueOnce({ ok: false });
    expect((await builtin_setfattr(['-x', 'tag', 'feed_12'])).rendered).toBe('setfattr: could not read the tags of feed 12\n');
  });
});
