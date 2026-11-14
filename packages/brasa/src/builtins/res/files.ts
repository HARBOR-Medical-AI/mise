/**
 * @file `files`, `links` and `dirs`: CUBE's file, link and folder resources
 * as rows (a listing of the records, not of a folder's contents, which `ls`
 * shows), listed, searched, and their fields named.
 *
 * Declared in one record each (`filesCommand`, `linksCommand`,
 * `dirsCommand`), of one grammar: the subcommands, the path a listing is
 * under, and the listing options every resource command reads.
 *
 * Key components:
 * - filesCommand / linksCommand / dirsCommand: the declarations.
 * - builtin_files / builtin_links / builtin_dirs: each run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { files_fetchList } from '@fnndsc/chili/commands/files/list.js';
import { fileFields_fetch } from '@fnndsc/chili/commands/files/fields.js';
import { FilteredResourceData } from '@fnndsc/cumin';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandDeclaration, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, resourceListBag_build } from './resourceList.js';

/** The record kinds one grammar lists. */
type FileAsset = 'files' | 'links' | 'dirs';

/**
 * Lists one kind of record, under a path when one is given.
 *
 * @param assetName - The kind.
 * @param options - The bag chili's listing reads.
 * @param path - The ChRIS path the records are under, or none.
 * @returns The table, or that there are none, or the error.
 */
async function fileGroupList_render(assetName: FileAsset, options: CLIoptions, path: string | undefined): Promise<CommandEnvelope> {
  try {
    const results: FilteredResourceData | null = await files_fetchList(options, assetName, path);
    if (!results) {
      return envelope_error('', undefined, `No ${assetName} resources found. Perhaps check your current context?\n`);
    }
    if (results.tableData.length === 0) {
      return envelope_ok(`No ${assetName} found matching the criteria.\n`);
    }
    return envelope_ok(table_render(
      results.tableData,
      results.selectedFields,
      {
        title: { title: assetName, justification: 'center' },
        pagination: results.totalCount !== undefined ? { shown: results.tableData.length, total: results.totalCount } : undefined,
      },
    ));
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`${assetName} error: ${msg}`)}\n`);
  }
}

/**
 * Names the fields one kind of record has.
 *
 * @param assetName - The kind.
 * @returns The fields' table, or that there are none.
 */
async function fileGroupFields_render(assetName: FileAsset): Promise<CommandEnvelope> {
  const fields: string[] | null = await fileFields_fetch(assetName);
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ fields: f })), ['fields']));
  }
  return envelope_ok(`No resource fields found for ${assetName}.\n`);
}

/** What a `files`, `links` or `dirs` line may hold. */
const FILE_GROUP_GRAMMAR = {
  subcommands: {
    list: {
      summary: 'List the records, 20 to a page, under a path when one is given',
      operands: [{ name: 'path', kind: 'cfsPath', optional: true, summary: 'The ChRIS path the records are under' }],
      options: { ...RESOURCE_LIST_OPTIONS_GRAMMAR },
    },
    search: {
      summary: 'List the records a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value (inspect names the fields)' }],
      options: { ...RESOURCE_LIST_OPTIONS_GRAMMAR },
    },
    inspect: { summary: 'Name the fields a record has' },
    fieldslist: { summary: 'The same as inspect' },
  },
} as const satisfies CommandGrammar;

/**
 * The handler of one kind of record's command.
 *
 * @param assetName - The kind.
 * @returns The handler.
 */
function fileGroupHandler_make(assetName: FileAsset): (args: CommandArguments<typeof FILE_GROUP_GRAMMAR>) => Promise<CommandEnvelope> {
  return async (args: CommandArguments<typeof FILE_GROUP_GRAMMAR>): Promise<CommandEnvelope> => {
    switch (args.subcommand) {
      case 'list': return fileGroupList_render(assetName, resourceListBag_build(args.options), args.operands.path);
      case 'search': return fileGroupList_render(assetName, resourceListBag_build(args.options, args.operands.term), undefined);
      case 'inspect':
      case 'fieldslist': return fileGroupFields_render(assetName);
    }
  };
}

/**
 * One kind of record's declaration.
 *
 * @param assetName - The kind, which names the command.
 * @param noun - What a record is, for the help.
 * @returns The declaration.
 */
function fileGroupCommand_make(assetName: FileAsset, noun: string): CommandDeclaration<typeof FILE_GROUP_GRAMMAR> {
  return command_declare({
    name: assetName,
    grammar: FILE_GROUP_GRAMMAR,
    help: {
      summary: `CUBE's ${noun} records: list them, search them, name their fields`,
      description: `List CUBE's ${noun} records as rows, under a ChRIS path when one is given, a page at a time or every page, filtered by a field:value search and in the columns asked for; inspect names the fields a record has. These are the records themselves; ls lists a folder's contents.`,
      category: 'Resources',
      examples: [`${assetName} list`, `${assetName} list ~/uploads --fields fname,fsize`, `${assetName} search fname:dicom`, `${assetName} inspect`],
    },
    handler: fileGroupHandler_make(assetName),
  });
}

/** `files <list|search|inspect>`: the declaration. */
export const filesCommand = fileGroupCommand_make('files', 'file');

/** `links <list|search|inspect>`: the declaration. */
export const linksCommand = fileGroupCommand_make('links', 'link');

/** `dirs <list|search|inspect>`: the declaration. */
export const dirsCommand = fileGroupCommand_make('dirs', 'folder');

/**
 * `files` over words already split: the declaration's parse and handler.
 *
 * @param args - command arguments.
 * @returns An envelope carrying the files listing or fields.
 *
 * @example
 * ```ts
 * await builtin_files(['list', '/home/chris/uploads']);
 * ```
 */
export async function builtin_files(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(filesCommand, args);
}

/**
 * `links` over words already split: the declaration's parse and handler.
 *
 * @param args - command arguments.
 * @returns An envelope carrying the links listing or fields.
 *
 * @example
 * ```ts
 * await builtin_links(['list']);
 * ```
 */
export async function builtin_links(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(linksCommand, args);
}

/**
 * `dirs` over words already split: the declaration's parse and handler.
 *
 * @param args - command arguments.
 * @returns An envelope carrying the dirs listing or fields.
 *
 * @example
 * ```ts
 * await builtin_dirs(['list']);
 * ```
 */
export async function builtin_dirs(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(dirsCommand, args);
}
