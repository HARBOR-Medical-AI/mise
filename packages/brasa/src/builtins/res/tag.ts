/**
 * @file `tag` and `tags`: CUBE's tags, listed, searched, and their fields
 * named. A feed wears a tag through `setfattr`; this lists the tags there are.
 *
 * Declared in one record (`tagCommand`, and `tagsCommand` its second name):
 * the subcommands and the listing options every resource command reads.
 *
 * Key components:
 * - tagCommand / tagsCommand: the declaration, under each name.
 * - builtin_tag: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { tags_fetchList, TagListResult } from '@fnndsc/chili/commands/tags/list.js';
import { tagFields_fetch } from '@fnndsc/chili/commands/tags/fields.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, commandAlias_make, resourceListBag_build } from './resourceList.js';

/**
 * Lists the tags a listing's options ask for.
 *
 * @param options - The bag chili's listing reads.
 * @returns The table, or that there are none, or the error.
 */
async function tagList_render(options: CLIoptions): Promise<CommandEnvelope> {
  try {
    const { tags, selectedFields, totalCount }: TagListResult = await tags_fetchList(options);
    if (tags.length === 0) { return envelope_ok(`${chalk.gray('No tags found.')}\n`); }
    return envelope_ok(table_render(tags, selectedFields, { title: { title: 'Tags', justification: 'center' }, pagination: totalCount !== undefined ? { shown: tags.length, total: totalCount } : undefined }));
  } catch (e: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`tag error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
  }
}

/**
 * Names the fields a tag has.
 *
 * @returns The fields' table, or that there are none.
 */
async function tagFields_render(): Promise<CommandEnvelope> {
  const fields: string[] | null = await tagFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Tag fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found for tags.')}\n`);
}

/** What a `tag` line may hold. */
const TAG_GRAMMAR = {
  bare: { summary: 'List the tags, as list does', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
  subcommands: {
    list: { summary: 'List the tags, 20 to a page', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
    search: {
      summary: 'List the tags a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value (inspect names the fields)' }],
      options: RESOURCE_LIST_OPTIONS_GRAMMAR,
    },
    inspect: { summary: 'Name the fields a tag has' },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `tag` line.
 *
 * @param args - The line, parsed.
 * @returns The listing, the fields, or the error.
 */
async function tag_run(args: CommandArguments<typeof TAG_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null:
    case 'list': return tagList_render(resourceListBag_build(args.options));
    case 'search': return tagList_render(resourceListBag_build(args.options, args.operands.term));
    case 'inspect': return tagFields_render();
  }
}

/**
 * `tag [[listing options] | list [listing options] | search <term> [listing options] | inspect]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [tagCommand, tagsCommand] }, 'backend');
 * ```
 */
export const tagCommand = command_declare({
  name: 'tag',
  grammar: TAG_GRAMMAR,
  help: {
    summary: "CUBE's tags: list them, search them, name their fields",
    description: "List the tags in CUBE, a page at a time or every page, filtered by a field:value search and in the columns asked for; inspect names the fields a tag has. tag and tags are one command. A feed wears a tag through setfattr -n tag -v <name>.",
    category: 'Resources',
    examples: ['tags list', 'tags list --all --sort name', 'tags search name:brain', 'tags inspect'],
  },
  handler: tag_run,
});

/** `tags`: the same command as `tag`. */
export const tagsCommand = commandAlias_make(tagCommand, 'tags');

/**
 * `tag` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `tag`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_tag(['list', '--all']);
 * ```
 */
export async function builtin_tag(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(tagCommand, args);
}
