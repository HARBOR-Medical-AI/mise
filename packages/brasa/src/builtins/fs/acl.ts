/**
 * @file `setfacl`, `getfacl` and `chmod` — a feed's access list.
 *
 * Sharing a feed is, in POSIX terms, an access control entry, and a shell
 * already has the verbs for it: a user (`u:`), a group (`g:`), and the other
 * entry (`o::r`, everyone: a public feed). `setfacl -x` withdraws a user's or
 * a group's grant, and `chmod o±r` is the other entry spelled as a mode.
 * `share X with Y` is a sentence; it lands nowhere in a terminal.
 *
 * Each is declared in one record: the feeds are path operands that glob,
 * `setfacl`'s entry an option's value, `chmod`'s mode one of two words. The
 * capability itself lives in the kernel (cumin `feed_share`,
 * `feedShare_group`, `feedShare_revoke`, `feedAccess_read`,
 * `feed_makePublic`, `feed_makePrivate`). This is its shell face.
 *
 * Key components:
 * - setfaclCommand, getfaclCommand, chmodCommand: the declarations.
 * - builtin_setfacl, builtin_getfacl, builtin_chmod: each declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_setfacl(['-m', 'u:someone:r', 'feed_12']);
 * ```
 *
 * Dependencies: cumin's sharing calls; the words of an entry and of a feed (`acl.args.ts`).
 *
 * @module
 */
import { feed_share, feedShare_group, feedShare_revoke, feedAccess_read, feed_makePublic, feed_makePrivate, type FeedAccess } from '@fnndsc/cumin';
import {
  aclEntry_parse, aclRemoval_parse, aclTarget_resolve, acl_render,
  type AclEntry, type AclRemoval,
} from './acl.args.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The feeds a line names, as each of these commands takes them. */
const FEEDS_OPERAND = {
  name: 'path',
  kind: 'cfsPath',
  repeat: true,
  glob: true,
  summary: 'The feeds: an id, feed_N, any path through /feeds/, or /proc/jobs/feed_N',
} as const;

/** What a `setfacl` line may hold. */
const SETFACL_GRAMMAR = {
  operands: [FEEDS_OPERAND],
  options: {
    modify: { short: 'm', long: 'modify', summary: 'Add an entry: u:<user>:r, g:<group>:r, o::r (public) or o::- (private)', value: { name: 'entry', kind: 'word' } },
    remove: { short: 'x', long: 'remove', summary: 'Withdraw a grant: u:<user> or g:<group>', value: { name: 'entry', kind: 'word' } },
  },
} as const satisfies CommandGrammar;

/**
 * The feeds some targets name, in order.
 *
 * @param verb - The command, for its refusal.
 * @param paths - The targets as the line gave them.
 * @param distinct - Whether a feed named twice counts once.
 * @returns The feed ids, or the refusal of the first target that names none.
 */
function feedIDs_resolve(verb: string, paths: readonly string[], distinct: boolean): number[] | CommandEnvelope {
  const feedIDs: number[] = [];
  for (const path of paths) {
    const feedID: number | null = aclTarget_resolve(path);
    if (feedID === null) return envelope_error(`${verb}: '${path}' does not name a feed\n`);
    if (!distinct || !feedIDs.includes(feedID)) feedIDs.push(feedID);
  }
  return feedIDs;
}

/**
 * Adds or modifies an access control entry on feeds, or withdraws a grant;
 * given feeds and no entry, asks whom to share them with.
 *
 * @param args - The line, parsed.
 * @returns An envelope naming what was granted or withdrawn.
 */
async function setfacl_run(args: CommandArguments<typeof SETFACL_GRAMMAR>): Promise<CommandEnvelope> {
  const { modify, remove } = args.options;
  if (remove !== undefined) {
    const removal: AclRemoval | string = aclRemoval_parse(remove);
    if (typeof removal === 'string') return envelope_error(`${removal}\n`);
    const feedIDs: number[] | CommandEnvelope = feedIDs_resolve('setfacl', args.operands.path, false);
    return Array.isArray(feedIDs) ? acl_remove(removal, feedIDs) : feedIDs;
  }
  if (modify !== undefined) {
    const entry: AclEntry | null = aclEntry_parse(modify);
    if (entry === null) return envelope_error(`setfacl: '${modify}' is not an entry (want u:<user>:r, g:<group>:r, o::r or o::-)\n`);
    const feedIDs: number[] | CommandEnvelope = feedIDs_resolve('setfacl', args.operands.path, false);
    return Array.isArray(feedIDs) ? acl_apply(entry, feedIDs, 'setfacl') : feedIDs;
  }
  // A path and no entry names WHAT to share and not WITH WHOM, which is a
  // question rather than a usage error (an-absent-value-is-a-question). The
  // grant CUBE offers is read on a feed, so the only thing missing is the
  // identity: ask for it, and refuse when it is not answered.
  const feedIDs: number[] | CommandEnvelope = feedIDs_resolve('setfacl', args.operands.path, true);
  if (!Array.isArray(feedIDs)) return feedIDs;
  // One question for the whole set: a grant is per identity, and asking
  // who once for twenty feeds is the same answer twenty times.
  const who: string = (await who_ask(feedIDs)).trim();
  if (who === '') {
    const named: string = feedIDs.map((id: number): string => `feed_${id}`).join(' ');
    return envelope_error(`setfacl: nobody named; ${named} shared with no one new\n`);
  }
  return acl_apply({ kind: 'user', name: who, perms: 'r' }, feedIDs, 'setfacl');
}

/**
 * `setfacl [-m <entry>] [-x <entry>] <path>…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [setfaclCommand] }, 'backend');
 * ```
 */
export const setfaclCommand = command_declare({
  name: 'setfacl',
  grammar: SETFACL_GRAMMAR,
  help: {
    summary: 'Share a feed with a user, a group or everyone, or stop sharing it',
    description:
      'A feed\'s access list, as POSIX ACL entries. -m u:<user>:r shares it with a user, -m g:<group>:r '
      + 'with a group, -m o::r with everyone (a public feed) and -m o::- makes it private again. '
      + '-x u:<user> or -x g:<group> withdraws that grant. A feed is named by id, by the feed_N a '
      + 'listing shows, by any path through /feeds/, or by /proc/jobs/feed_N. Given a feed and no '
      + 'entry, it asks which user to share it with.',
    category: 'Sharing',
    posix: { group: 'Files', differs: 'ChRIS sharing, as ACL entries' },
    examples: [
      'setfacl -m u:someone:r /home/me/feeds/feed_12',
      'setfacl -m g:grantlab:r feed_12 feed_13',
      'setfacl -m o::r feed_12                  # public',
      'setfacl -x u:someone feed_12',
      'setfacl feed_12                          # asks who to share it with',
    ],
  },
  handler: setfacl_run,
});

/**
 * `setfacl` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `setfacl`.
 * @returns An envelope naming what was granted, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_setfacl(['-x', 'u:someone', 'feed_12']);
 * ```
 */
export async function builtin_setfacl(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(setfaclCommand, args);
}

/**
 * Applies one entry to feeds: a user or group granted read, or the other
 * entry making them public (`r`) or private (no `r`). `setfacl -m` and
 * `chmod o±r` both land here.
 *
 * @param entry - The entry.
 * @param feedIDs - The feeds.
 * @param verb - The verb, for its refusals.
 * @returns An envelope naming what changed.
 */
async function acl_apply(entry: AclEntry, feedIDs: number[], verb: string): Promise<CommandEnvelope> {
  const reads: boolean = entry.perms.includes('r');
  if (entry.kind !== 'other' && !reads) {
    return envelope_error(`${verb}: '${entry.perms}' grants no read — CUBE shares a feed for reading (setfacl -x withdraws a grant)\n`);
  }
  const done: string[] = [];
  for (const feedID of feedIDs) {
    const outcome: Result<boolean> = entry.kind === 'user'
      ? await feed_share(feedID, entry.name)
      : entry.kind === 'group'
        ? await feedShare_group(feedID, entry.name)
        : reads ? await feed_makePublic(feedID) : await feed_makePrivate(feedID);
    if (!outcome.ok) {
      const error: StackMessage | undefined = errorStack.stack_pop();
      return envelope_error(`${error?.message ?? `${verb}: could not change the access of feed ${feedID}`}\n`);
    }
    done.push(`feed_${feedID}`);
  }
  const said: string = entry.kind === 'user'
    ? `${entry.name} granted read on ${done.join(' ')}`
    : entry.kind === 'group'
      ? `group ${entry.name} granted read on ${done.join(' ')}`
      : `${done.join(' ')} ${reads ? 'public' : 'private'}`;
  return envelope_ok(`${said}\n`, {
    kind: 'fs.acl',
    data: { usernames: entry.kind === 'user' ? [entry.name] : [], groups: entry.kind === 'group' ? [entry.name] : [], ...(entry.kind === 'other' ? { public: reads } : {}), targets: done },
  });
}

/**
 * Withdraws a user's or a group's grant on feeds. A feed that held no such
 * grant is said, not passed over in silence.
 *
 * @param removal - The grant.
 * @param feedIDs - The feeds.
 * @returns An envelope naming what was withdrawn.
 */
async function acl_remove(removal: AclRemoval, feedIDs: number[]): Promise<CommandEnvelope> {
  const lines: string[] = [];
  const removed: string[] = [];
  for (const feedID of feedIDs) {
    const outcome: Result<boolean> = await feedShare_revoke(feedID, removal.kind, removal.name);
    if (!outcome.ok) {
      const error: StackMessage | undefined = errorStack.stack_pop();
      return envelope_error(`${error?.message ?? `setfacl: could not withdraw ${removal.kind} ${removal.name} from feed ${feedID}`}\n`);
    }
    if (outcome.value) removed.push(`feed_${feedID}`);
    else lines.push(`setfacl: feed_${feedID}: no entry for ${removal.kind} ${removal.name}`);
  }
  if (removed.length > 0) lines.unshift(`${removal.kind} ${removal.name} no longer reads ${removed.join(' ')}`);
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'fs.acl.removed', data: { kind: removal.kind, name: removal.name, targets: removed } });
}

/** What a `chmod` line may hold: a feed's one mode, then the feeds. */
const CHMOD_GRAMMAR = {
  operands: [
    { name: 'mode', kind: 'enum', values: ['o+r', 'o-r'], summary: 'o+r makes the feeds public, o-r private: no other mode is one a feed has' },
    FEEDS_OPERAND,
  ],
} as const satisfies CommandGrammar;

/**
 * `chmod o+r` / `o-r` on feeds: the other entry, public or private, as
 * `setfacl -m o::r` / `o::-` writes it.
 *
 * @param args - The line, parsed.
 * @returns An envelope naming what changed.
 */
async function chmod_run(args: CommandArguments<typeof CHMOD_GRAMMAR>): Promise<CommandEnvelope> {
  const feedIDs: number[] | CommandEnvelope = feedIDs_resolve('chmod', args.operands.path, false);
  if (!Array.isArray(feedIDs)) return feedIDs;
  return acl_apply({ kind: 'other', name: '', perms: args.operands.mode === 'o+r' ? 'r' : '-' }, feedIDs, 'chmod');
}

/**
 * `chmod <o+r|o-r> <path>…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [chmodCommand] }, 'backend');
 * ```
 */
export const chmodCommand = command_declare({
  name: 'chmod',
  grammar: CHMOD_GRAMMAR,
  help: {
    summary: 'Make a feed public, or private again',
    description: 'The other entry of a feed\'s access list spelled as a mode: o+r makes it public, o-r private, '
      + 'exactly as setfacl -m o::r and o::- do. No other mode is one a feed has.',
    category: 'Sharing',
    posix: { group: 'Files', differs: 'sets who may see a feed or folder (ChRIS sharing)' },
    examples: [
      'chmod o+r feed_12',
      'chmod o-r /proc/jobs/feed_12',
    ],
  },
  handler: chmod_run,
});

/**
 * `chmod` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `chmod`.
 * @returns An envelope naming what changed, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_chmod(['o+r', 'feed_12']);
 * ```
 */
export async function builtin_chmod(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(chmodCommand, args);
}

/**
 * Asks which identity a feed should be shared with.
 *
 * @param feedIDs - The distinct feeds the grant is for, named in the question.
 * @returns The answer, empty when the operator abandoned it.
 */
async function who_ask(feedIDs: number[]): Promise<string> {
  const { repl_question } = await import('../../core/question.js');
  const named: string = feedIDs.length === 1
    ? `feed ${feedIDs[0]}`
    : `${feedIDs.length} feeds (${feedIDs.map((id: number): string => `feed_${id}`).join(', ')})`;
  try {
    // A grant is withdrawn by `setfacl -x`, so the question says only what
    // it asks.
    return await repl_question(`Share ${named} with which user? `);
  } catch {
    return '';
  }
}

/** What a `getfacl` line may hold. */
const GETFACL_GRAMMAR = {
  operands: [FEEDS_OPERAND],
} as const satisfies CommandGrammar;

/**
 * Reports a feed's access list, in `getfacl`'s own shape.
 *
 * @param args - The line, parsed.
 * @returns An envelope carrying the rendered list.
 */
async function getfacl_run(args: CommandArguments<typeof GETFACL_GRAMMAR>): Promise<CommandEnvelope> {
  const blocks: string[] = [];
  const model: Array<{ path: string; usernames: string[]; groups: string[]; public: boolean }> = [];
  for (const path of args.operands.path) {
    const feedID: number | null = aclTarget_resolve(path);
    if (feedID === null) {
      return envelope_error(`getfacl: '${path}' does not name a feed\n`);
    }
    const held: Result<FeedAccess> = await feedAccess_read(feedID);
    if (!held.ok) {
      const error: StackMessage | undefined = errorStack.stack_pop();
      return envelope_error(`${error?.message ?? `getfacl: could not read the access list of feed ${feedID}`}\n`);
    }
    blocks.push(acl_render(path, null, held.value));
    model.push({ path, usernames: held.value.users, groups: held.value.groups, public: held.value.public });
  }

  return envelope_ok(`${blocks.join('\n\n')}\n`, { kind: 'fs.acl', data: model });
}

/**
 * `getfacl <path>…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [getfaclCommand] }, 'backend');
 * ```
 */
export const getfaclCommand = command_declare({
  name: 'getfacl',
  grammar: GETFACL_GRAMMAR,
  help: {
    summary: 'Show who can read a feed: users, groups, and whether it is public',
    description:
      'Show who can read a feed, in the familiar block: a # file: line, the owner\'s user:: entry, '
      + 'one user: line per user and one group: line per group holding access, then other:: '
      + '(r-- when the feed is public).',
    category: 'Sharing',
    posix: { group: 'Files', differs: 'who a feed or folder is shared with, as ACL entries' },
    examples: [
      'getfacl /home/me/feeds/feed_12',
    ],
  },
  // Reading an access list changes nothing of the session.
  holds: [],
  handler: getfacl_run,
});

/**
 * `getfacl` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `getfacl`.
 * @returns The access lists, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_getfacl(['feed_12']);
 * ```
 */
export async function builtin_getfacl(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(getfaclCommand, args);
}
