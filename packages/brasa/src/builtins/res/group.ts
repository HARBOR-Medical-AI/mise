/**
 * @file `group` and `groups`: CUBE's groups, listed, searched, and their
 * members listed, added and removed. Changing a membership needs an
 * administrator (`sudo group adduser …`).
 *
 * Declared in one record (`groupCommand`, and `groupsCommand` its second
 * name): the subcommands, their operands, and the listing options every
 * resource command reads.
 *
 * Key components:
 * - groupCommand / groupsCommand: the declaration, under each name.
 * - builtin_group: the declaration run over words already split.
 * - groupSync_note: the caveat an add carries.
 *
 * @module
 */
import chalk from 'chalk';
import { groups_fetchList, GroupListResult } from '@fnndsc/chili/commands/groups/list.js';
import { groupFields_fetch } from '@fnndsc/chili/commands/groups/fields.js';
import {
  groupMembers_fetch,
  groupReference_resolve,
  GroupReference,
  groupUser_add,
  groupUser_remove,
  GroupMember,
  GroupMembershipResult,
} from '@fnndsc/chili/commands/groups/membership.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { authorizationFailure_is, sudoHint_build } from '../../core/elevation.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, commandAlias_make, resourceListBag_build } from './resourceList.js';

/**
 * Renders an error for a failed group membership operation.
 *
 * @param message - User-facing error or usage detail.
 * @returns An error command envelope.
 */
function group_error(message: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(message)}\n`);
}

/**
 * Renders the human-readable name and stable numeric ID of one group.
 *
 * @param group - Resolved CUBE group identity.
 * @returns Operator-facing group label.
 */
function group_label(group: GroupReference): string {
  return `${group.name} (${group.id})`;
}

/**
 * Applies one membership operation to every named user and renders its outcome.
 *
 * Current membership is read once so adding an existing member or removing a
 * non-member is an idempotent no-op. CUBE mutations remain individual requests:
 * all requested users are attempted and a partial batch reports every result.
 *
 * @param group - Resolved target group.
 * @param usernames - Usernames in operator-supplied order.
 * @param operation - Whether this batch adds or removes members.
 * @returns Success envelope, or an error envelope after any failed mutation.
 */
async function groupMembership_batch(
  group: GroupReference,
  usernames: string[],
  operation: 'add' | 'remove',
): Promise<CommandEnvelope> {
  const existing: GroupMembershipResult<GroupMember[]> = await groupMembers_fetch(group.id);
  if (!existing.ok) return group_error(existing.error);

  const members: Set<string> = new Set(existing.value.map(
    (member: GroupMember): string => member.username,
  ));
  let rendered: string = '';
  let renderedErr: string = '';
  let failures: number = 0;
  let elevationHintShown: boolean = false;
  let added: number = 0;

  for (const username of usernames) {
    const present: boolean = members.has(username);
    if (operation === 'add' && present) {
      rendered += `${chalk.gray(`${username} is already a member of ${group_label(group)}.`)}\n`;
      continue;
    }
    if (operation === 'remove' && !present) {
      rendered += `${chalk.gray(`${username} was not a member of ${group_label(group)}.`)}\n`;
      continue;
    }

    const result: GroupMembershipResult<GroupMember | boolean> = operation === 'add'
      ? await groupUser_add(group.id, username)
      : await groupUser_remove(group.id, username);
    if (!result.ok) {
      failures += 1;
      renderedErr += `${chalk.red(`Could not ${operation} ${username} ${operation === 'add' ? 'to' : 'from'} ${group_label(group)}: ${result.error}`)}\n`;
      if (!elevationHintShown && authorizationFailure_is(result.error)) {
        renderedErr += sudoHint_build(
          `group ${operation}user`,
          [group.name, ...usernames],
        );
        elevationHintShown = true;
      }
      continue;
    }

    if (operation === 'add') {
      members.add(username);
      added += 1;
      rendered += `${chalk.green(`Added ${username} to ${group_label(group)}.`)}\n`;
    } else {
      members.delete(username);
      rendered += `${chalk.green(`Removed ${username} from ${group_label(group)}.`)}\n`;
    }
  }

  // CUBE cannot say whether its groups are its own: one that takes them
  // from a directory rewrites a user's groups at each login, and the add
  // above reads "Added" either way (the operator lost two afternoons'
  // pacs_users grants to Authentik that way).
  if (added > 0) rendered += groupSync_note();

  if (failures > 0) {
    exitCode_set(1);
    return envelope_error(rendered, undefined, renderedErr);
  }
  return envelope_ok(rendered);
}

/**
 * The caveat a successful add carries: where CUBE takes its groups from a
 * directory, the grant belongs there.
 *
 * @returns The note, ending in a newline.
 */
export function groupSync_note(): string {
  return `${chalk.gray('Note: where CUBE takes its groups from a directory (Authentik, LDAP), a membership added here is undone at the user\'s next login; grant it in the directory to make it stick.')}\n`;
}

/**
 * Lists the groups a listing's options ask for.
 *
 * @param options - The bag chili's listing reads.
 * @returns The table, or that there are none, or the error.
 */
async function groupList_render(options: CLIoptions): Promise<CommandEnvelope> {
  try {
    const { groups, selectedFields, totalCount }: GroupListResult = await groups_fetchList(options);
    if (groups.length === 0) { return envelope_ok(`${chalk.gray('No groups found.')}\n`); }
    return envelope_ok(table_render(groups, selectedFields, { title: { title: 'Groups', justification: 'center' }, pagination: totalCount !== undefined ? { shown: groups.length, total: totalCount } : undefined }));
  } catch (e: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`group error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
  }
}

/**
 * `group inspect [<group>]`: one group's identity, or the fields a group has.
 *
 * @param reference - The group's name or id, or none for the fields.
 * @returns The identity or the fields, or the error.
 */
async function groupInspect_render(reference: string | undefined): Promise<CommandEnvelope> {
  if (reference !== undefined) {
    const resolved = await groupReference_resolve(reference);
    if (!resolved.ok) return group_error(resolved.error);
    return envelope_ok(table_render(
      [{ id: resolved.value.id, name: resolved.value.name }],
      ['id', 'name'],
      { title: { title: `Group ${group_label(resolved.value)}`, justification: 'center' } },
    ));
  }
  const fields: string[] | null = await groupFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Group fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found for groups.')}\n`);
}

/**
 * `group members <group>`: the users in one group.
 *
 * @param reference - The group's name or id.
 * @returns The members' table, or that it has none, or the error.
 */
async function groupMembers_render(reference: string): Promise<CommandEnvelope> {
  const resolved = await groupReference_resolve(reference);
  if (!resolved.ok) return group_error(resolved.error);
  const result: GroupMembershipResult<GroupMember[]> = await groupMembers_fetch(resolved.value.id);
  if (!result.ok) return group_error(result.error);
  if (result.value.length === 0) {
    return envelope_ok(`${chalk.gray(`Group ${group_label(resolved.value)} has no users.`)}\n`);
  }
  const rows: Record<string, unknown>[] = result.value.map(
    (member: GroupMember): Record<string, unknown> => ({
      id: member.id,
      username: member.username,
    }),
  );
  return envelope_ok(table_render(
    rows,
    ['id', 'username'],
    { title: { title: `Group ${group_label(resolved.value)} users`, justification: 'center' } },
  ));
}

/**
 * `group adduser|removeuser <group> <user…>`: one membership change for
 * every user named.
 *
 * @param reference - The group's name or id.
 * @param usernames - The users, in the order given.
 * @param operation - Whether they are added or removed.
 * @returns The batch's outcome, or the error.
 */
async function groupMembership_change(reference: string, usernames: string[], operation: 'add' | 'remove'): Promise<CommandEnvelope> {
  const resolved = await groupReference_resolve(reference);
  if (!resolved.ok) return group_error(resolved.error);
  return groupMembership_batch(resolved.value, usernames, operation);
}

/** What a `group` line may hold. */
const GROUP_GRAMMAR = {
  bare: { summary: 'List the first page of groups' },
  subcommands: {
    list: { summary: 'List the groups, 20 to a page', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
    search: {
      summary: 'List the groups a filter matches: field:value, or a name fragment (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value, or part of a name' }],
      options: RESOURCE_LIST_OPTIONS_GRAMMAR,
    },
    inspect: { summary: "One group's name and id, or, with none named, the fields a group has", operands: [{ name: 'group', kind: 'word', optional: true, summary: "The group's name or id" }] },
    members: { summary: 'List the users in a group', operands: [{ name: 'group', kind: 'word', summary: "The group's name or id" }] },
    adduser: { summary: 'Add users to a group (an administrator: sudo group adduser …)', operands: [{ name: 'group', kind: 'word', summary: "The group's name or id" }, { name: 'users', kind: 'word', repeat: true, summary: 'The usernames' }] },
    removeuser: { summary: 'Remove users from a group (an administrator: sudo group removeuser …)', operands: [{ name: 'group', kind: 'word', summary: "The group's name or id" }, { name: 'users', kind: 'word', repeat: true, summary: 'The usernames' }] },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `group` line.
 *
 * @param args - The line, parsed.
 * @returns The listing, the group, its members, or what a change did.
 */
async function group_run(args: CommandArguments<typeof GROUP_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null: return groupList_render({});
    case 'list': return groupList_render(resourceListBag_build(args.options));
    case 'search': {
      const term: string = args.operands.term;
      return groupList_render(resourceListBag_build(args.options, term.includes(':') ? term : `name_icontains:${term}`));
    }
    case 'inspect': return groupInspect_render(args.operands.group);
    case 'members': return groupMembers_render(args.operands.group);
    case 'adduser': return groupMembership_change(args.operands.group, args.operands.users, 'add');
    case 'removeuser': return groupMembership_change(args.operands.group, args.operands.users, 'remove');
  }
}

/**
 * `group [list | search <term> | inspect [group] | members <group> | adduser|removeuser <group> <user…>]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [groupCommand, groupsCommand] }, 'backend');
 * ```
 */
export const groupCommand = command_declare({
  name: 'group',
  grammar: GROUP_GRAMMAR,
  help: {
    summary: "CUBE's groups: list them, search them, list and change their members",
    description: "List the groups in CUBE, a page at a time or every page, filtered by a search (field:value, or part of a name) and in the columns asked for; inspect names one group's id, or the fields a group has. members lists a group's users; adduser and removeuser change them, each user in turn, and need an administrator (sudo group adduser …). Where CUBE takes its groups from a directory (Authentik, LDAP), a membership added here is undone at the user's next login. group and groups are one command.",
    category: 'Resources',
    examples: ['groups list', 'groups search pacs', 'group inspect pacs_users', 'group members pacs_users', 'sudo group adduser pacs_users peter.hong joe.schmo', 'sudo group removeuser pacs_users joe.schmo'],
  },
  handler: group_run,
});

/** `groups`: the same command as `group`; a read, which holds nothing of the session. */
export const groupsCommand = commandAlias_make(groupCommand, 'groups', []);

/**
 * `group` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `group`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_group(['members', 'pacs_users']);
 * ```
 */
export async function builtin_group(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(groupCommand, args);
}
