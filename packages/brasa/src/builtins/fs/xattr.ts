/**
 * @file `setfattr` and `getfattr` — a feed's tags.
 *
 * CUBE's freeform tags on a feed are, in POSIX terms, the values of one
 * extended attribute, `tag`. Each command is declared in one record: the
 * attribute's name is one of the words it answers to, the feeds are path
 * operands that glob. The capability lives in the kernel (`feedTags_list`,
 * `feedTag_add`, `feedTag_remove`); this is its shell face.
 *
 * Key components:
 * - setfattrCommand, getfattrCommand: the declarations.
 * - builtin_setfattr, builtin_getfattr: each declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_setfattr(['-n', 'tag', '-v', 'urgent', 'feed_12']);
 * ```
 *
 * Dependencies: cumin's tag calls; the target and dump words (`xattr.args.ts`).
 *
 * @module
 */
import chalk from 'chalk';
import { feedTags_list, feedTag_add, feedTag_remove, type FeedTag } from '@fnndsc/cumin';
import { xattrTarget_resolve, xattr_render } from './xattr.args.js';
import { error_stripDebugPrefix } from '../utils.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { commandUsage_render } from '../../core/commandUsage.js';
import { exitCode_set } from '../../core/handlerRun.js';

/** The feeds a line names, as both commands take them. */
const FEEDS_OPERAND = {
  name: 'path',
  kind: 'cfsPath',
  repeat: true,
  glob: true,
  summary: 'The feeds: an id, feed_N, any path through /feeds/, or /proc/jobs/feed_N',
} as const;

/**
 * A refusal, on a line of its own.
 *
 * @param message - What was refused, and why.
 * @returns The error envelope.
 */
function refusal(message: string): CommandEnvelope {
  return envelope_error(`${message}\n`);
}

/**
 * The kernel's last word, or a fallback.
 *
 * @param fallback - What to say when the kernel said nothing.
 * @returns The message.
 */
function error_said(fallback: string): string {
  const error: StackMessage | undefined = errorStack.stack_pop();
  return error?.message ?? fallback;
}

/** What a `getfattr` line may hold. */
const GETFATTR_GRAMMAR = {
  operands: [FEEDS_OPERAND],
  options: {
    name: { short: 'n', long: 'name', summary: 'The attribute to read (only tag exists)', value: { name: 'name', kind: 'enum', values: ['tag', 'user.tag'] } },
    dump: { short: 'd', long: 'dump', summary: 'Dump every attribute (the default)' },
  },
} as const satisfies CommandGrammar;

/**
 * Reads the tags a feed wears, in `getfattr`'s dump shape.
 *
 * @param args - The line, parsed.
 * @returns An envelope carrying the rendered blocks and a model of them.
 */
async function getfattr_run(args: CommandArguments<typeof GETFATTR_GRAMMAR>): Promise<CommandEnvelope> {
  const blocks: string[] = [];
  const model: Array<{ path: string; feedId: number; tags: string[] }> = [];
  for (const path of args.operands.path) {
    const feedId: number | null = xattrTarget_resolve(path);
    if (feedId === null) return refusal(`getfattr: '${path}' does not name a feed`);
    const held: Result<FeedTag[]> = await feedTags_list(feedId);
    if (!held.ok) return refusal(error_said(`getfattr: could not read the tags of feed ${feedId}`));
    const tags: string[] = held.value.map((tag: FeedTag): string => tag.name);
    blocks.push(xattr_render(path, tags));
    model.push({ path, feedId, tags });
  }
  return envelope_ok(`${blocks.join('\n\n')}\n`, { kind: 'fs.xattr', data: model });
}

/**
 * `getfattr [-d] [-n tag] <path>…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [getfattrCommand] }, 'backend');
 * ```
 */
export const getfattrCommand = command_declare({
  name: 'getfattr',
  grammar: GETFATTR_GRAMMAR,
  help: {
    summary: 'Show the tags a feed wears',
    description: 'Show a feed\'s tags in getfattr\'s dump shape: a # file: line, then one tag="…" line per tag.',
    category: 'Sharing',
    posix: { group: 'Files', differs: 'a feed\'s tags, as extended attributes' },
    examples: [
      'getfattr feed_12',
      'getfattr -n tag /home/me/feeds/feed_12',
    ],
  },
  // Reading a feed's tags changes nothing of the session.
  holds: [],
  handler: getfattr_run,
});

/**
 * `getfattr` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `getfattr`.
 * @returns The tags, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_getfattr(['feed_12']);
 * ```
 */
export async function builtin_getfattr(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(getfattrCommand, args);
}

/** What a `setfattr` line may hold. */
const SETFATTR_GRAMMAR = {
  operands: [FEEDS_OPERAND],
  options: {
    name: { short: 'n', long: 'name', summary: 'The attribute to set (only tag exists)', value: { name: 'name', kind: 'enum', values: ['tag', 'user.tag'] } },
    value: { short: 'v', long: 'value', summary: 'The tag', value: { name: 'value', kind: 'word' } },
    remove: { short: 'x', long: 'remove', summary: 'Remove the tag given by -v, or every tag without -v', value: { name: 'name', kind: 'enum', values: ['tag', 'user.tag'] } },
  },
} as const satisfies CommandGrammar;

/**
 * A refusal of a line that says neither what to set nor what to remove, or
 * a set without its value, with the usage.
 *
 * @param reason - What is missing.
 * @returns The error envelope.
 */
function setfattrLine_refuse(reason: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(`setfattr: ${reason}; usage: ${commandUsage_render(setfattrCommand)}`)}\n`);
}

/**
 * Hangs a tag on feeds (`-n tag -v <value>`), or takes one off (`-x tag -v
 * <value>`), or takes every tag off (`-x tag`, as setfattr removes the
 * whole attribute). Silent on success, as setfattr is; a refusal is named.
 *
 * @param args - The line, parsed.
 * @returns An envelope, empty on success.
 */
async function setfattr_run(args: CommandArguments<typeof SETFATTR_GRAMMAR>): Promise<CommandEnvelope> {
  const { name, remove } = args.options;
  if (name !== undefined && remove !== undefined) return setfattrLine_refuse('-n sets and -x removes; give one');
  if (name === undefined && remove === undefined) return setfattrLine_refuse('-n tag or -x tag is needed');
  const mode: 'set' | 'remove' = name !== undefined ? 'set' : 'remove';
  const value: string | null = args.options.value === undefined ? null : args.options.value.trim();
  if (mode === 'set' && (value === null || value === '')) return setfattrLine_refuse(`-n ${name ?? 'tag'} needs -v <value>`);
  const changed: Array<{ feedId: number; tag: string; done: boolean }> = [];
  for (const path of args.operands.path) {
    const feedId: number | null = xattrTarget_resolve(path);
    if (feedId === null) return refusal(`setfattr: '${path}' does not name a feed`);
    let names: string[];
    if (mode === 'remove' && value === null) {
      const held: Result<FeedTag[]> = await feedTags_list(feedId);
      if (!held.ok) return refusal(error_said(`setfattr: could not read the tags of feed ${feedId}`));
      names = held.value.map((tag: FeedTag): string => tag.name);
    } else {
      names = [value ?? ''];
    }
    for (const tagName of names) {
      const done: Result<boolean> = mode === 'set' ? await feedTag_add(feedId, tagName) : await feedTag_remove(feedId, tagName);
      if (!done.ok) {
        const said: string = error_stripDebugPrefix(error_said(`could not ${mode === 'set' ? 'add' : 'remove'} tag ${tagName}`));
        return refusal(`setfattr: ${path}: ${said}`);
      }
      if (mode === 'remove' && value !== null && !done.value) {
        return refusal(`setfattr: ${path}: tag="${tagName}": No such attribute value`);
      }
      changed.push({ feedId, tag: tagName, done: done.value });
    }
  }
  return envelope_ok('', { kind: 'fs.xattr.changed', data: { mode, changed } });
}

/**
 * `setfattr -n tag -v <value> <path>… | -x tag [-v <value>] <path>…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [setfattrCommand] }, 'backend');
 * ```
 */
export const setfattrCommand = command_declare({
  name: 'setfattr',
  grammar: SETFATTR_GRAMMAR,
  help: {
    summary: 'Hang a tag on a feed, or take it off',
    description:
      'A feed\'s tags are the values of one extended attribute, tag (also user.tag): CUBE\'s '
      + 'freeform labels. -n tag -v <value> hangs one of your tags (a folder under /proc/tags: '
      + 'mkdir /proc/tags/<name> makes a tag, and naming one that does not exist is an error); '
      + '-x tag -v <value> takes it off; -x tag alone takes every tag off, as '
      + 'setfattr removes the whole attribute. A feed is named by id, by feed_N, by any path '
      + 'through /feeds/, or by its projection /proc/jobs/feed_N. Silent on success.',
    category: 'Sharing',
    posix: { group: 'Files', differs: 'tags on a feed, as extended attributes' },
    examples: [
      'setfattr -n tag -v urgent feed_12',
      'setfattr -n tag -v review feed_12 feed_13',
      'setfattr -x tag -v urgent /proc/jobs/feed_12',
    ],
  },
  handler: setfattr_run,
});

/**
 * `setfattr` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `setfattr`.
 * @returns An envelope, empty on success, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_setfattr(['-x', 'tag', 'feed_12']);
 * ```
 */
export async function builtin_setfattr(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(setfattrCommand, args);
}
