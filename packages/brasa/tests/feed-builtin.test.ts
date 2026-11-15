import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';

// builtins/utils deps (for real commandArgs_process).
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(),
  feedGraphData_ensure: jest.fn(),
  feedGraph_build: jest.fn(),
}));
const mockFeedResolve: jest.Mock = jest.fn();
const mockFeedDelete: jest.Mock = jest.fn();
const mockStackPop: jest.Mock = jest.fn();
cuminMock_install(() => ({
  Ok: <T>(value: T) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  feed_resolve: mockFeedResolve,
  path_extractFeedID: (path: string): number | null => {
    const match: RegExpMatchArray | null = path.match(/(?:^|\/)feed_(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : null;
  },
  errorStack: { stack_pop: mockStackPop, stack_search: () => [] },
  feed_delete: mockFeedDelete,
}));
const mockCwdGet = jest.fn(async (): Promise<string> => '/');
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: mockCwdGet } }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('@fnndsc/chili/models/feed.js', () => ({}));

// chell entry (chiliCommand_run) — mocked so the whole shell isn't loaded.
const mockChiliRun = jest.fn();
jest.unstable_mockModule('../src/chris/chiliDelegate.js', () => ({ chiliCommand_run: mockChiliRun }));

const mockFeedsList = jest.fn();
const mockFeedFields = jest.fn();
const mockFeedCreate = jest.fn();
const mockCommentsList = jest.fn();
const mockNoteGet = jest.fn();
const mockNoteUpdate = jest.fn();
const mockCommentCreate = jest.fn();
const mockCommentDelete = jest.fn();
const mockCommentUpdate = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/feeds/list.js', () => ({ feeds_fetchList: mockFeedsList }));
jest.unstable_mockModule('@fnndsc/chili/commands/feeds/fields.js', () => ({ feedFields_fetch: mockFeedFields }));
jest.unstable_mockModule('@fnndsc/chili/commands/feed/create.js', () => ({ feed_create: mockFeedCreate }));
jest.unstable_mockModule('@fnndsc/chili/commands/feed/note.js', () => ({
  feed_noteGet: mockNoteGet,
  feed_noteUpdate: mockNoteUpdate,
}));
jest.unstable_mockModule('@fnndsc/chili/commands/feed/comments.js', () => ({
  feed_commentsList: mockCommentsList,
  feed_commentCreate: mockCommentCreate,
  feed_commentDelete: mockCommentDelete,
  feed_commentUpdate: mockCommentUpdate,
}));
jest.unstable_mockModule('@fnndsc/chili/views/feed.js', () => ({
  feedList_render: jest.fn(() => 'FEED_LIST'),
  feedCreate_render: jest.fn(() => 'FEED_CREATED'),
  feedNote_render: jest.fn(() => 'FEED_NOTE'),
  feedComments_render: jest.fn(() => 'FEED_COMMENTS'),
}));
const mockTableDisplay = jest.fn();
const mockTableRender = jest.fn(() => 'FIELDS_TABLE');
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({ table_display: mockTableDisplay, table_render: mockTableRender }));
// The note is a file; editing it is `edit` on that file (#831).
const mockBuiltinEdit = jest.fn(async (_a: string[]): Promise<unknown> => ({ rendered: '' }));
jest.unstable_mockModule('../src/builtins/fs/edit.js', () => ({ builtin_edit: mockBuiltinEdit }));

const mockFeedTreeHandle = jest.fn(async (id: number) => ({ status: 'ok', rendered: `TREE ${id}` }));
const mockFeedDiagramHandle = jest.fn(async (id: number) => ({ status: 'ok', rendered: `SIGNALFLOW ${id}` }));
const mockFeedDagHandle = jest.fn(async (id: number) => ({ status: 'ok', rendered: `DAG ${id}` }));
jest.unstable_mockModule('../src/builtins/res/feed.tree.js', () => ({ feedTree_handle: mockFeedTreeHandle }));
jest.unstable_mockModule('../src/builtins/res/feed.diagram.js', () => ({
  feedDiagram_handle: mockFeedDiagramHandle,
  feedDag_handle: mockFeedDagHandle,
  feedDagModel_build: jest.fn(),
}));

const mockConfirm = jest.fn(async (): Promise<boolean> => true);
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: mockConfirm }));

const { builtin_feed } = await import('../src/builtins/res/feed.js');
// A feed on the line is the ChRIS kind `feed`, which the ChRIS backend registers.
(await import('../src/core/backend.js')).backend_install({ id: 'test', session: {} as never, argumentKinds: (await import('../src/chris/kinds.js')).chrisArgumentKinds });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockCwdGet.mockResolvedValue('/');
  mockFeedResolve.mockResolvedValue(ok({ id: 12, name: 'Brain Run' }));
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('builtin_feed', () => {
  it('lists the feeds bare, with the listing options list takes: feeds --all --user', async () => {
    mockFeedsList.mockResolvedValue({ feeds: [{ id: 1 }], selectedFields: ['id'], totalCount: 1 });
    const env = await builtin_feed(['--all', '--user', 'radstar']);
    expect(env.rendered).toContain('FEED_LIST');
    expect(mockFeedsList).toHaveBeenCalledWith({ all: true, user: 'radstar' });
    const bare = await builtin_feed(['--frob']);
    expect(bare.renderedErr).toContain("feed: unrecognized option '--frob'; usage: feed [[--all]");
  });

  it('lists feeds', async () => {
    mockFeedsList.mockResolvedValue({ feeds: [{ id: 1 }], selectedFields: ['id'], totalCount: 1 });
    const env = await builtin_feed(['list']);
    expect(env.rendered).toContain('FEED_LIST');
  });

  it('creates a feed and renders the result', async () => {
    mockFeedCreate.mockResolvedValue({ id: 5, name: 'f' });
    const env = await builtin_feed(['create', '--dirs', '/a']);
    expect(env.rendered).toContain('FEED_CREATED');
  });

  it('inspects fields', async () => {
    mockFeedFields.mockResolvedValue(['id', 'name']);
    const env = await builtin_feed(['inspect']);
    expect(env.rendered).toContain('FIELDS_TABLE');
    expect(env.renderedErr).toBeUndefined();
  });

  it('lists comments for a feed', async () => {
    mockCommentsList.mockResolvedValue({ ok: true, value: [{ id: 1 }] });
    const env = await builtin_feed(['comments', '3']);
    expect(env.rendered).toContain('FEED_COMMENTS');
  });

  it('rejects a non-numeric comments feed id', async () => {
    const env = await builtin_feed(['comments', 'abc']);
    expect(env.renderedErr).toContain("feed: comments: invalid argument 'abc' for <feed> (not a whole number); usage: feed comments <feed>");
  });

  it('returns an error envelope for an unknown subcommand', async () => {
    const env = await builtin_feed(['frobnicate']);
    expect(mockChiliRun).not.toHaveBeenCalled();
    expect(env.renderedErr).toContain("feed: unknown subcommand 'frobnicate'");
  });

  it('reports an error from a handler', async () => {
    mockFeedsList.mockRejectedValue(new Error('boom'));
    const env = await builtin_feed(['list']);
    expect(env.renderedErr).toContain('boom');
  });

  it('hints at pagination when the listing is truncated', async () => {
    mockFeedsList.mockResolvedValue({ feeds: [{ id: 1 }], selectedFields: ['id'], totalCount: 5 });
    const env = await builtin_feed(['list']);
    expect(env.rendered).toContain('showing 1 of 5');
  });

  it('routes search to a filtered list', async () => {
    mockFeedsList.mockResolvedValue({ feeds: [], selectedFields: [], totalCount: 0 });
    await builtin_feed(['search', 'brain']);
    expect(mockFeedsList).toHaveBeenCalledWith(expect.objectContaining({ search: 'brain' }));
  });

  it('draws a shallow feed diagram through the dag handler', async () => {
    const env: CommandEnvelope = await builtin_feed(['diagram', 'feed_12']);
    expect(mockFeedDagHandle).toHaveBeenCalledWith(12, undefined, 0, false);
    expect(env.rendered).toBe('DAG 12');
  });

  it('passes tree rendering options through the shallow diagram alias', async () => {
    await builtin_feed(['diagram', 'feed_12', '--focus', '31', '--max-nodes', '8', '--flat']);

    expect(mockFeedDagHandle).toHaveBeenCalledWith(12, 31, 8, true);
  });

  it('resolves a feed title for tree and SignalFlow diagram output', async () => {
    await builtin_feed(['tree', 'Brain', 'Run']);
    await builtin_feed(['diagram', '--signalflow', 'Brain', 'Run']);

    expect(mockFeedResolve).toHaveBeenCalledWith('Brain Run');
    expect(mockFeedTreeHandle).toHaveBeenCalledWith(12, undefined, 0, false);
    expect(mockFeedDiagramHandle).toHaveBeenCalledWith(12, 'signalflow');
  });

  it('resolves an omitted feed specifier from the current directory', async () => {
    mockCwdGet.mockResolvedValue('/proc/jobs/feed_44/pl-root_90');

    await builtin_feed(['tree']);
    await builtin_feed(['diagram']);
    await builtin_feed(['diagram', '--signalflow']);

    expect(mockFeedTreeHandle).toHaveBeenCalledWith(44, undefined, 0, false);
    expect(mockFeedDiagramHandle).toHaveBeenCalledWith(44, 'signalflow');
  });

  it('inspects one feed by its id: every field with its value, read through the listing filtered by id', async () => {
    mockFeedFields.mockResolvedValue(['id', 'name', 'owner_username']);
    mockFeedsList.mockResolvedValue({ feeds: [{ id: 5975, name: 'decl-walk-close', owner_username: 'mise-e2e' }], selectedFields: ['id', 'name', 'owner_username'] });
    const env = await builtin_feed(['inspect', '5975']);
    expect(env.status).toBe('ok');
    expect(mockFeedsList).toHaveBeenCalledWith({ search: 'id:5975', fields: 'id,name,owner_username' });
    expect(mockTableRender).toHaveBeenLastCalledWith(
      [{ field: 'id', value: '5975' }, { field: 'name', value: 'decl-walk-close' }, { field: 'owner_username', value: 'mise-e2e' }],
      ['field', 'value'],
      { title: { title: 'Feed 5975', justification: 'center' } },
    );
  });

  it('says a feed id CUBE holds no feed of, and refuses an id that is not a number', async () => {
    mockFeedFields.mockResolvedValue(['id']);
    mockFeedsList.mockResolvedValue({ feeds: [], selectedFields: ['id'] });
    const missing = await builtin_feed(['inspect', '9']);
    expect(missing.renderedErr).toContain('feed inspect: no feed 9');
    expect(process.exitCode).toBe(1);
    const word = await builtin_feed(['inspect', 'feed_9']);
    expect(word.status).toBe('error');
  });

  it('reports empty inspect results', async () => {
    mockFeedFields.mockResolvedValue(null);
    const env = await builtin_feed(['inspect']);
    expect(env.rendered).toContain('No fields found');
  });

  it('shows a feed note', async () => {
    mockNoteGet.mockResolvedValue(ok({ title: 'T', content: 'C' }));
    const env = await builtin_feed(['note', '5']);
    expect(env.rendered).toContain('FEED_NOTE');
  });

  it('updates a note from flags', async () => {
    mockNoteUpdate.mockResolvedValue(ok(true));
    const env = await builtin_feed(['note', '5', '--title', 'New']);
    expect(mockNoteUpdate).toHaveBeenCalledWith(5, { title: 'New', content: undefined });
    expect(env.rendered).toContain('Note updated on feed 5');
  });

  it('rejects malformed note commands and reports failures', async () => {
    const usage = await builtin_feed(['note', 'abc']);
    expect(usage.renderedErr).toContain("feed: note: invalid argument 'abc' for <feed> (not a whole number); usage: feed note");

    mockNoteGet.mockResolvedValue(err());
    await builtin_feed(['note', '5']);
    expect(process.exitCode).toBe(1);
  });

  it('edits a note as the file it is: edit on /proc/jobs/feed_N/note', async () => {
    mockBuiltinEdit.mockResolvedValueOnce({ rendered: 'SAVED' });
    const env = await builtin_feed(['note', 'edit', '5']);
    expect(mockBuiltinEdit).toHaveBeenCalledWith(['/proc/jobs/feed_5/note']);
    expect(env.rendered).toBe('SAVED');
  });

  it('refuses the retired feeds share by name, pointing at the access verbs', async () => {
    const env = await builtin_feed(['share', '12']);
    expect(env.renderedErr).toContain('feeds share is retired: setfacl -m o::r <feed> (or chmod o+r <feed>)');
  });

  it('rejects a non-numeric note edit id', async () => {
    const usage = await builtin_feed(['note', 'edit', 'abc']);
    expect(usage.renderedErr).toContain("feed: note: invalid argument 'abc' for <feed>");
    expect(mockBuiltinEdit).not.toHaveBeenCalled();
  });

  it('adds, edits and deletes comments', async () => {
    mockCommentCreate.mockResolvedValue(ok({ id: 3 }));
    const added = await builtin_feed(['comment', 'add', '5', '--content', 'hi']);
    expect(added.rendered).toContain('Comment added (id: 3)');

    mockCommentUpdate.mockResolvedValue(ok(true));
    await builtin_feed(['comment', 'edit', '5', '3', '--content', 'edit']);
    expect(mockCommentUpdate).toHaveBeenCalledWith(5, 3, { title: undefined, content: 'edit' });

    mockCommentDelete.mockResolvedValue(ok(true));
    const deleted = await builtin_feed(['comment', 'delete', '5', '3']);
    expect(deleted.rendered).toContain('Comment 3 deleted');
  });

  it('rejects malformed and unknown comment operations', async () => {
    const add = await builtin_feed(['comment', 'add', 'abc']);
    expect(add.renderedErr).toContain("feed: comment: invalid argument 'abc' for <feed> (not a whole number); usage: feed comment");

    const del = await builtin_feed(['comment', 'delete', '5', 'abc']);
    expect(del.renderedErr).toContain("invalid argument 'abc' for <comment>");

    const edit = await builtin_feed(['comment', 'edit', '5', 'abc']);
    expect(edit.renderedErr).toContain("invalid argument 'abc' for <comment>");

    const bare = await builtin_feed(['comment', 'delete', '5']);
    expect(bare.renderedErr).toContain('Usage: feed comment delete <feed> <comment>');
    expect(mockCommentDelete).not.toHaveBeenCalled();

    const frob = await builtin_feed(['comment', 'frob', '5']);
    expect(frob.renderedErr).toContain("invalid argument 'frob' for <op> (valid: add, edit, delete)");
    expect(process.exitCode).toBe(1);
  });

  it('reports failed comment mutations', async () => {
    mockCommentCreate.mockResolvedValue(err());
    await builtin_feed(['comment', 'add', '5']);
    expect(process.exitCode).toBe(1);

    mockCommentsList.mockResolvedValue(err());
    await builtin_feed(['comments', '5']);
    expect(process.exitCode).toBe(1);
  });
});

describe('the feed declaration', () => {
  it('names a feed by the ChRIS kind feed, and every other word by a core kind', async () => {
    const { feedCommand } = await import('../src/builtins/res/feed.js');
    const { commandAliases_list } = await import('../src/core/commandDeclaration.js');
    const feedsCommand = commandAliases_list(feedCommand).find((one) => one.name === 'feeds');
    const { CORE_KIND_NAMES } = await import('../src/core/argumentKinds.js');
    const kinds: string[] = Object.values(feedCommand.grammar.subcommands).flatMap((sub: { operands?: ReadonlyArray<{ kind: string }>; options?: Record<string, { value?: { kind: string } }> }): string[] => [
      ...(sub.operands ?? []).map((operand) => operand.kind),
      ...Object.values(sub.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
    ]);
    expect(kinds.filter((kind: string): boolean => !CORE_KIND_NAMES.includes(kind))).toEqual(['feed', 'feed', 'feed']);
    expect(feedsCommand?.holds).toEqual([]);
    expect(feedCommand.holds).toBeUndefined();
  });

  it('creates a feed from the folders named, as --dirs does', async () => {
    mockFeedCreate.mockResolvedValue({ id: 5, name: 'f' });
    await builtin_feed(['create', '/home/u/uploads/a', '/home/u/uploads/b']);
    expect(mockFeedCreate).toHaveBeenCalledWith({ dirs: '/home/u/uploads/a,/home/u/uploads/b' });
  });
});

describe('feed rm', () => {
  beforeEach(() => {
    mockFeedResolve.mockResolvedValue(ok({ id: 12 }));
    mockFeedDelete.mockResolvedValue(ok(true));
    mockConfirm.mockResolvedValue(true);
  });

  it('asks before removing, naming what goes and that it cannot be undone', async () => {
    const envelope: CommandEnvelope = await builtin_feed(['rm', 'feed_12']);
    expect(mockConfirm).toHaveBeenCalledWith(
      'Remove feed 12 and everything in it? This cannot be undone ',
    );
    expect(mockFeedDelete).toHaveBeenCalledWith(12);
    expect(envelope.rendered).toContain('removed feed 12');
  });

  it('removes nothing when the question is answered no', async () => {
    mockConfirm.mockResolvedValue(false);
    const envelope: CommandEnvelope = await builtin_feed(['rm', 'feed_12']);
    expect(mockFeedDelete).not.toHaveBeenCalled();
    expect(envelope.rendered).toContain('was not removed');
  });

  it('removes nothing when the question cannot be put at all', async () => {
    mockConfirm.mockRejectedValue(new Error('no surface can ask'));
    const envelope: CommandEnvelope = await builtin_feed(['rm', 'feed_12']);
    expect(mockFeedDelete).not.toHaveBeenCalled();
    expect(envelope.rendered).toContain('was not removed');
  });

  it('skips the question under -f, for a caller that already asked', async () => {
    await builtin_feed(['rm', 'feed_12', '-f']);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockFeedDelete).toHaveBeenCalledWith(12);
  });

  it('reports a removal the server refused', async () => {
    mockFeedDelete.mockResolvedValue(ok(false));
    const envelope: CommandEnvelope = await builtin_feed(['rm', 'feed_12']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('could not be removed');
  });
});
