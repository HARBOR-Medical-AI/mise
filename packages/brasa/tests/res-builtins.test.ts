import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// Satisfy builtins/utils' heavy imports so the real commandArgs_process loads.
const mockErrorPop = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: jest.fn() }));
jest.unstable_mockModule('../src/core/elevation.js', () => ({
  authorizationFailure_is: (message: string): boolean => message.includes('403'),
  sudoHint_build: (command: string, args: string[]): string => `Try: sudo ${[command, ...args].join(' ')}\n`,
}));
cuminMock_install(() => ({
  errorStack: { stack_pop: mockErrorPop },
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: {} }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

// Shared screen + per-resource chili command modules.
const mockTable = jest.fn(() => 'TABLE');
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({ table_display: mockTable, table_render: mockTable }));

const mockTagsList = jest.fn();
const mockTagFields = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/tags/list.js', () => ({ tags_fetchList: mockTagsList }));
jest.unstable_mockModule('@fnndsc/chili/commands/tags/fields.js', () => ({ tagFields_fetch: mockTagFields }));

const mockGroupsList = jest.fn();
const mockGroupFields = jest.fn();
const mockGroupMembers = jest.fn();
const mockGroupUserAdd = jest.fn();
const mockGroupUserRemove = jest.fn();
const mockGroupReferenceResolve = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/groups/list.js', () => ({ groups_fetchList: mockGroupsList }));
jest.unstable_mockModule('@fnndsc/chili/commands/groups/fields.js', () => ({ groupFields_fetch: mockGroupFields }));
jest.unstable_mockModule('@fnndsc/chili/commands/groups/membership.js', () => ({
  groupMembers_fetch: mockGroupMembers,
  groupReference_resolve: mockGroupReferenceResolve,
  groupUser_add: mockGroupUserAdd,
  groupUser_remove: mockGroupUserRemove,
}));

const mockWorkflowsList = jest.fn();
const mockWorkflowFields = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/workflows/list.js', () => ({ workflows_fetchList: mockWorkflowsList }));
jest.unstable_mockModule('@fnndsc/chili/commands/workflows/fields.js', () => ({ workflowFields_fetch: mockWorkflowFields }));

const mockMetasList = jest.fn();
const mockMetaFields = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/pluginmetas/list.js', () => ({ pluginMetas_fetchList: mockMetasList }));
jest.unstable_mockModule('@fnndsc/chili/commands/pluginmetas/fields.js', () => ({ pluginMetaFields_fetch: mockMetaFields }));

const mockInstancesList = jest.fn();
const mockInstanceFields = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/plugininstances/list.js', () => ({ pluginInstances_fetchList: mockInstancesList }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugininstances/fields.js', () => ({ pluginInstanceFields_fetch: mockInstanceFields }));

const mockComputeList = jest.fn();
const mockComputeFields = jest.fn();
const mockComputeRender = jest.fn(() => 'COMPUTE_RENDER');
jest.unstable_mockModule('@fnndsc/chili/commands/compute/list.js', () => ({ computeResources_fetchList: mockComputeList }));
jest.unstable_mockModule('@fnndsc/chili/commands/compute/fields.js', () => ({ computeFields_fetch: mockComputeFields }));
jest.unstable_mockModule('@fnndsc/chili/views/compute.js', () => ({ computeList_render: mockComputeRender }));

const { builtin_tag, tagsCommand } = await import('../src/builtins/res/tag.js');
const { builtin_group, groupsCommand } = await import('../src/builtins/res/group.js');
const { builtin_workflow, workflowsCommand } = await import('../src/builtins/res/workflow.js');
const { builtin_pluginmeta, pluginmetasCommand, metasCommand } = await import('../src/builtins/res/pluginmeta.js');
const { builtin_plugininstance, plugininstancesCommand, jobsCommand } = await import('../src/builtins/res/plugininstance.js');
const { builtin_compute, computeCommand } = await import('../src/builtins/res/compute.js');

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockGroupReferenceResolve.mockResolvedValue({ ok: true, value: { id: 7, name: 'pacs_users' } });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** Each resource builtin follows the same list/inspect/error/unknown shape. */
const cases = [
  {
    name: 'tag',
    builtin: builtin_tag,
    list: mockTagsList,
    fields: mockTagFields,
    listKey: 'tags',
  },
  {
    name: 'group',
    builtin: builtin_group,
    list: mockGroupsList,
    fields: mockGroupFields,
    listKey: 'groups',
  },
  {
    name: 'workflow',
    builtin: builtin_workflow,
    list: mockWorkflowsList,
    fields: mockWorkflowFields,
    listKey: 'workflows',
  },
  {
    name: 'pluginmeta',
    builtin: builtin_pluginmeta,
    list: mockMetasList,
    fields: mockMetaFields,
    listKey: 'pluginMetas',
  },
  {
    name: 'plugininstance',
    builtin: builtin_plugininstance,
    list: mockInstancesList,
    fields: mockInstanceFields,
    listKey: 'pluginInstances',
  },
] as const;

describe.each(cases)('builtin_$name', ({ builtin, list, fields, listKey }) => {
  it('lists resources', async () => {
    list.mockResolvedValue({ [listKey]: [{ id: 1 }], selectedFields: ['id'], totalCount: 1 });
    await builtin([]);
    expect(mockTable).toHaveBeenCalled();
  });

  it('notes an empty listing', async () => {
    list.mockResolvedValue({ [listKey]: [], selectedFields: [], totalCount: 0 });
    const envelope = await builtin(['list']);
    expect(envelope.rendered).toContain('No ');
  });

  it('reports a listing error and sets a non-zero exit code', async () => {
    list.mockRejectedValue(new Error('boom'));
    const envelope = await builtin(['list']);
    expect(process.exitCode).toBe(1);
    expect(envelope.renderedErr).toContain('boom');
  });

  it('inspects fields', async () => {
    fields.mockResolvedValue(['id', 'name']);
    await builtin(['inspect']);
    expect(mockTable).toHaveBeenCalled();
  });

  it('notes empty fields on inspect', async () => {
    fields.mockResolvedValue([]);
    const envelope = await builtin(['inspect']);
    expect(envelope.rendered).toContain('No fields');
  });

  it('rejects an unknown subcommand with a non-zero exit code', async () => {
    await builtin(['frobnicate']);
    expect(process.exitCode).toBe(1);
  });

  it('searches by its term, keeping the line\'s other options (#1237)', async () => {
    list.mockResolvedValue({ [listKey]: [{ id: 1 }], selectedFields: ['id'], totalCount: 1 });
    await builtin(['search', 'id:5536', '--fields', 'id']);
    expect(process.exitCode).toBe(0);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ search: expect.stringContaining('5536'), fields: 'id' }));
  });

  it('refuses a search with no term, or more than one', async () => {
    const none = await builtin(['search']);
    expect(process.exitCode).toBe(1);
    expect(none.renderedErr).toContain('search: missing operand <term>');
    process.exitCode = 0;
    const two = await builtin(['search', 'a:1', 'b:2']);
    expect(process.exitCode).toBe(1);
    expect(two.renderedErr).toContain("unexpected operand 'b:2'");
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses a list option it does not read, by name, its usage naming --search', async () => {
    const envelope = await builtin(['list', '--feed', '5536']);
    expect(process.exitCode).toBe(1);
    expect(envelope.renderedErr).toContain("unrecognized option '--feed'");
    expect(envelope.renderedErr).toContain('[--search <field:value>]');
    expect(list).not.toHaveBeenCalled();
  });

  it('takes the standard list options', async () => {
    list.mockResolvedValue({ [listKey]: [{ id: 1 }], selectedFields: ['id'], totalCount: 1 });
    await builtin(['list', '--all', '--limit', '5', '--fields', 'id', '--sort', 'id', '--reverse', '--search', 'id:1']);
    expect(process.exitCode).toBe(0);
    expect(list).toHaveBeenCalled();
  });
});

describe('the declared resource commands', () => {
  const declared = [tagsCommand, groupsCommand, workflowsCommand, pluginmetasCommand, plugininstancesCommand] as const;

  it('each declares the Resource Contract: list and search with the listing options, and inspect', () => {
    for (const declaration of declared) {
      const subcommands: Record<string, { options?: Record<string, { long?: string }> }> = declaration.grammar.subcommands;
      expect([declaration.name, ['list', 'search', 'inspect'].every((word: string): boolean => word in subcommands)]).toEqual([declaration.name, true]);
      for (const word of ['list', 'search']) {
        const longs: Array<string | undefined> = Object.values(subcommands[word]?.options ?? {}).map((option) => option.long);
        expect(longs).toEqual(expect.arrayContaining(['all', 'limit', 'offset', 'fields', 'search', 'sort', 'reverse', 'table', 'csv']));
      }
    }
  });

  it('answers each other name with the same command, its usage saying the name typed', async () => {
    expect(metasCommand.grammar).toBe(pluginmetasCommand.grammar);
    expect(jobsCommand.handler).toBe(plugininstancesCommand.handler);
    const envelope = await jobsCommand.handler({ subcommand: 'cancel', operands: { id: '42' }, options: {}, expanded: {} } as never);
    expect(envelope.renderedErr).toContain('proc find 42');
    const { commandUsage_render } = await import('../src/core/commandUsage.js');
    expect(commandUsage_render(jobsCommand, 'search')).toMatch(/^jobs search /);
  });

  it('says a membership change needs an administrator, and a read holds nothing of the session', () => {
    expect(groupsCommand.grammar.subcommands.adduser.summary).toContain('administrator');
    expect(groupsCommand.grammar.subcommands.removeuser.summary).toContain('administrator');
    expect(groupsCommand.holds).toEqual([]);
    expect(plugininstancesCommand.holds).toEqual([]);
    expect(computeCommand.holds).toBeUndefined();
  });

  it('refuses a listing option on the bare command, its usage naming list\'s', async () => {
    const envelope = await builtin_tag(['--all']);
    expect(envelope.renderedErr).toContain("tag: unrecognized option '--all'; usage: tag [list [--all]");
    expect(mockTagsList).not.toHaveBeenCalled();
  });
});

describe('builtin_compute search', () => {
  it('keeps the compute resources a term matches, by name or by field:value', async () => {
    mockComputeList.mockResolvedValue({ ok: true, value: { resources: [{ id: 1, name: 'host', description: 'local' }, { id: 2, name: 'moc', description: 'cloud' }] } });
    await builtin_compute(['search', 'mo']);
    expect(mockComputeRender).toHaveBeenLastCalledWith([{ id: 2, name: 'moc', description: 'cloud' }], { table: false, csv: false });
    await builtin_compute(['search', 'description:LOC', '--table']);
    expect(mockComputeRender).toHaveBeenLastCalledWith([{ id: 1, name: 'host', description: 'local' }], { table: true, csv: false });
  });
});

describe('builtin_plugininstance job verbs', () => {
  it.each(['cancel', 'delete', 'output', 'parameters'])('%s names the /proc/jobs way', async (verb: string) => {
    const envelope = await builtin_plugininstance([verb, '42']);
    expect(process.exitCode).toBe(1);
    expect(envelope.renderedErr).toContain('proc find 42');
  });
});

describe('builtin_group membership', () => {
  it('resolves a group name search through the collection query', async () => {
    mockGroupsList.mockResolvedValue({ groups: [], selectedFields: [], totalCount: 0 });

    await builtin_group(['search', 'pacs_users']);

    expect(mockGroupsList).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'name_icontains:pacs_users' }),
    );
  });

  it('resolves an exact group name before listing members', async () => {
    mockGroupMembers.mockResolvedValue({
      ok: true,
      value: [{ id: 12, username: 'peter.hong' }],
    });

    const envelope = await builtin_group(['members', 'pacs_users']);

    expect(mockGroupReferenceResolve).toHaveBeenCalledWith('pacs_users');
    expect(mockGroupMembers).toHaveBeenCalledWith(7);
    expect(mockTable).toHaveBeenCalledWith(
      [{ id: 12, username: 'peter.hong' }],
      ['id', 'username'],
      expect.any(Object),
    );
    expect(envelope.status).toBe('ok');
  });

  it('inspects an exact group name as its CUBE identity', async () => {
    const envelope = await builtin_group(['inspect', 'pacs_users']);

    expect(mockGroupReferenceResolve).toHaveBeenCalledWith('pacs_users');
    expect(mockTable).toHaveBeenCalledWith(
      [{ id: 7, name: 'pacs_users' }],
      ['id', 'name'],
      expect.any(Object),
    );
    expect(envelope.status).toBe('ok');
  });

  it('adds every missing user named in a group batch', async () => {
    mockGroupMembers.mockResolvedValue({
      ok: true,
      value: [{ id: 12, username: 'peter.hong' }],
    });
    mockGroupUserAdd.mockResolvedValue({
      ok: true,
      value: { id: 13, username: 'joe.schmo' },
    });

    const envelope = await builtin_group(['adduser', 'pacs_users', 'peter.hong', 'joe.schmo']);

    expect(mockGroupReferenceResolve).toHaveBeenCalledWith('pacs_users');
    expect(mockGroupUserAdd).toHaveBeenCalledWith(7, 'joe.schmo');
    expect(mockGroupUserAdd).not.toHaveBeenCalledWith(7, 'peter.hong');
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('already a member');
    expect(envelope.rendered).toContain('Added joe.schmo');
    expect(envelope.rendered).toContain('peter.hong');
    // An add carries the caveat once: a directory-synced CUBE undoes it at the next login.
    expect(envelope.rendered.match(/undone at the user's next login/g)?.length).toBe(1);
  });

  it('an add that changed nothing carries no caveat', async () => {
    mockGroupMembers.mockResolvedValue({ ok: true, value: [{ id: 12, username: 'peter.hong' }] });
    const envelope = await builtin_group(['adduser', 'pacs_users', 'peter.hong']);
    expect(envelope.rendered).toContain('already a member');
    expect(envelope.rendered).not.toContain('next login');
  });

  it('reports every batch result and fails overall when one mutation fails', async () => {
    mockGroupMembers.mockResolvedValue({ ok: true, value: [] });
    mockGroupUserAdd
      .mockResolvedValueOnce({ ok: true, value: { id: 12, username: 'peter.hong' } })
      .mockResolvedValueOnce({ ok: false, error: 'Request failed with status code 403' });

    const envelope = await builtin_group(['adduser', 'pacs_users', 'peter.hong', 'joe.schmo']);

    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toContain('Added peter.hong');
    expect(envelope.renderedErr).toContain('joe.schmo');
    expect(envelope.renderedErr).toContain('status code 403');
    expect(envelope.renderedErr).toContain('Try: sudo group adduser pacs_users peter.hong joe.schmo');
    expect(process.exitCode).toBe(1);
  });

  it('continues to accept a numeric group ID', async () => {
    mockGroupMembers.mockResolvedValue({ ok: true, value: [] });
    mockGroupUserRemove.mockResolvedValue({ ok: true, value: true });

    const envelope = await builtin_group(['removeuser', '7', 'peter.hong']);

    expect(mockGroupReferenceResolve).toHaveBeenCalledWith('7');
    expect(mockGroupUserRemove).not.toHaveBeenCalled();
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('was not a member');
  });

  it('rejects a group name that cannot be resolved', async () => {
    mockGroupReferenceResolve.mockResolvedValue({
      ok: false,
      error: "No group named 'pacs_users'.",
    });

    const envelope = await builtin_group(['members', 'pacs_users']);

    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("No group named 'pacs_users'.");
  });

  it('removes a user from a group', async () => {
    mockGroupMembers.mockResolvedValue({
      ok: true,
      value: [{ id: 12, username: 'peter.hong' }],
    });
    mockGroupUserRemove.mockResolvedValue({ ok: true, value: true });

    const envelope = await builtin_group(['removeuser', '7', 'peter.hong']);

    expect(mockGroupUserRemove).toHaveBeenCalledWith(7, 'peter.hong');
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('peter.hong');
  });

  it('removes every present user from a named group batch', async () => {
    mockGroupMembers.mockResolvedValue({
      ok: true,
      value: [{ id: 12, username: 'peter.hong' }],
    });
    mockGroupUserRemove.mockResolvedValue({ ok: true, value: true });

    const envelope = await builtin_group(['removeuser', 'pacs_users', 'peter.hong', 'joe.schmo']);

    expect(mockGroupReferenceResolve).toHaveBeenCalledWith('pacs_users');
    expect(mockGroupUserRemove).toHaveBeenCalledWith(7, 'peter.hong');
    expect(mockGroupUserRemove).not.toHaveBeenCalledWith(7, 'joe.schmo');
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('Removed peter.hong');
    expect(envelope.rendered).toContain('joe.schmo was not a member');
  });
});

describe('builtin_compute', () => {
  it('lists compute resources via computeList_render', async () => {
    mockComputeList.mockResolvedValue({ ok: true, value: { resources: [{ id: 1 }] } });
    const envelope = await builtin_compute([]);
    expect(mockComputeRender).toHaveBeenCalled();
    expect(envelope.rendered).toContain('COMPUTE_RENDER');
  });

  it('surfaces a compute fetch failure as an error envelope', async () => {
    mockComputeList.mockResolvedValue({ ok: false });
    const envelope = await builtin_compute(['list']);
    expect(process.exitCode).toBe(1);
    expect(envelope.status).toBe('error');
  });

  it('reports a listing error with a non-zero exit code', async () => {
    mockComputeList.mockRejectedValue(new Error('boom'));
    const envelope = await builtin_compute(['list']);
    expect(process.exitCode).toBe(1);
    expect(envelope.renderedErr).toContain('boom');
  });

  it('inspects fields, or notes none', async () => {
    mockComputeFields.mockResolvedValue(['id']);
    await builtin_compute(['inspect']);
    expect(mockTable).toHaveBeenCalled();
    mockComputeFields.mockResolvedValue([]);
    const envelope = await builtin_compute(['inspect']);
    expect(envelope.rendered).toContain('No fields');
  });

  it('rejects an unknown subcommand', async () => {
    await builtin_compute(['frob']);
    expect(process.exitCode).toBe(1);
  });
});
