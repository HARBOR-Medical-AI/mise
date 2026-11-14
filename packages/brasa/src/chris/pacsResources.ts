/**
 * @file `pacsservers`, `pacsqueries` and `pacsretrieve`: CUBE's PACS
 * resources, answered by chili.
 *
 * Each is declared in one record with chili's own subcommands and options,
 * so the line is parsed, refused, completed and described here; the parsed
 * line is then written back as chili's words and run in-process.
 *
 * Key components:
 * - pacsserversCommand, pacsqueriesCommand, pacsretrieveCommand: the declarations.
 *
 * Typical usage:
 * ```ts
 * commands_register({ declarations: [pacsserversCommand, pacsqueriesCommand, pacsretrieveCommand] }, 'backend');
 * ```
 *
 * Dependencies: the chili delegation.
 *
 * @module
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import { command_declare, type CommandArguments, type CommandGrammar, type OptionGrammar, type OptionsGrammar, type SubcommandGrammar } from '../core/commandDeclaration.js';
import { chiliCommand_run } from './chiliDelegate.js';

/** A resource listing's options, as chili's `list` takes them. */
const LIST_OPTIONS = {
  page: { short: 'p', long: 'page', summary: 'Page size (default 20)', value: { name: 'size', kind: 'int', min: 1 } },
  fields: { short: 'f', long: 'fields', summary: 'Comma-separated fields to display', value: { name: 'fields', kind: 'word' } },
  search: { short: 's', long: 'search', summary: 'Search by comma-separated key:value pairs', value: { name: 'terms', kind: 'word' } },
  sort: { long: 'sort', summary: 'Sort by field (name, size, date, owner, …)', value: { name: 'field', kind: 'word' } },
  reverse: { short: 'r', long: 'reverse', summary: 'Reverse the sort order' },
  table: { long: 'table', summary: 'Tabular output, with headers' },
  csv: { long: 'csv', summary: 'CSV output (over --table)' },
} as const satisfies OptionsGrammar;

/** A PACS server, as `--pacsserver` names one. */
const PACSSERVER_OPTION = { long: 'pacsserver', summary: 'The PACS server, by id or identifier (default: the context\'s)', value: { name: 'id', kind: 'word' } } as const satisfies OptionGrammar;

/** A parsed line, as the chili writer reads it. */
interface ChiliLine {
  /** The subcommand. */
  readonly subcommand: string | null;
  /** The operands, by name. */
  readonly operands: Readonly<Record<string, unknown>>;
  /** The options, by property. */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * A parsed line written back as chili's words: the subcommand, each option
 * given (`--long`, with its value), then the operands in order.
 *
 * @param grammar - The command's grammar.
 * @param line - The line, parsed.
 * @returns chili's words after the command.
 *
 * @example
 * ```ts
 * chiliWords_write(PACSQUERIES_GRAMMAR, { subcommand: 'decode', operands: { queryId: 7 }, options: { raw: true } }); // ['decode', '--raw', '7']
 * ```
 */
export function chiliWords_write(grammar: CommandGrammar, line: ChiliLine): string[] {
  const scope: SubcommandGrammar | undefined = line.subcommand === null ? undefined : grammar.subcommands?.[line.subcommand];
  const words: string[] = line.subcommand === null ? [] : [line.subcommand];
  const options: Array<[string, OptionGrammar]> = Object.entries({ ...(scope?.options ?? {}), ...(grammar.options ?? {}) });
  for (const [key, option] of options) {
    const value: unknown = line.options[key];
    const name: string = option.long !== undefined ? `--${option.long}` : `-${option.short ?? ''}`;
    if (value === true) words.push(name);
    else if (typeof value === 'string' || typeof value === 'number') words.push(name, String(value));
  }
  for (const operand of scope?.operands ?? grammar.operands ?? []) {
    const value: unknown = line.operands[operand.name];
    if (Array.isArray(value)) words.push(...value.map(String));
    else if (value !== undefined) words.push(String(value));
  }
  return words;
}

/**
 * Runs a declared line through chili.
 *
 * @param name - The chili command.
 * @param grammar - Its grammar.
 * @param line - The line, parsed.
 * @returns chili's captured output.
 */
function chiliLine_run(name: string, grammar: CommandGrammar, line: ChiliLine): Promise<CommandEnvelope> {
  return chiliCommand_run(name, ['-s', ...chiliWords_write(grammar, line)]);
}

/** What a `pacsservers` line may hold. */
const PACSSERVERS_GRAMMAR = {
  subcommands: {
    list: { summary: 'List the PACS servers CUBE registers', options: LIST_OPTIONS },
    fieldslist: { summary: 'List the fields a PACS server has' },
  },
} as const satisfies CommandGrammar;

/**
 * `pacsservers <list [options] | fieldslist>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pacsserversCommand] }, 'backend');
 * ```
 */
export const pacsserversCommand = command_declare({
  name: 'pacsservers',
  grammar: PACSSERVERS_GRAMMAR,
  help: {
    summary: 'List or inspect available PACS servers (context-aware)',
    description: 'The PACS servers CUBE registers, as a resource listing: list them, or list the fields a server has.',
    category: 'PACS',
    examples: [
      'pacsservers list         # List PACS servers',
      'pacsservers list --table # Table view',
      'pacsservers fieldslist   # Show fields',
    ],
  },
  // Listing servers changes nothing of the session.
  holds: [],
  handler: (line: CommandArguments<typeof PACSSERVERS_GRAMMAR>): Promise<CommandEnvelope> => chiliLine_run('pacsservers', PACSSERVERS_GRAMMAR, line),
});

/** What a `pacsqueries` line may hold. */
const PACSQUERIES_GRAMMAR = {
  subcommands: {
    list: { summary: 'List the queries asked of the PACS server', options: { ...LIST_OPTIONS, pacsserver: PACSSERVER_OPTION } },
    fieldslist: { summary: 'List the fields a PACS query has' },
    create: {
      summary: 'Create a PACS query against the current or given server',
      operands: [{ name: 'query', kind: 'word', summary: 'The question: JSON, or comma-separated Key:Value pairs' }],
      options: {
        title: { long: 'title', summary: 'Title for the query', value: { name: 'title', kind: 'word' } },
        description: { long: 'description', summary: 'A description for the query', value: { name: 'description', kind: 'word' } },
        pacsserver: PACSSERVER_OPTION,
      },
    },
    decode: {
      summary: 'Decode the result payload of a PACS query',
      operands: [{ name: 'queryId', kind: 'int', min: 1, summary: 'The query\'s id' }],
      options: { raw: { long: 'raw', summary: 'Print the raw decoded JSON' } },
    },
  },
} as const satisfies CommandGrammar;

/**
 * `pacsqueries <list | fieldslist | create <query> | decode <queryId>>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pacsqueriesCommand] }, 'backend');
 * ```
 */
export const pacsqueriesCommand = command_declare({
  name: 'pacsqueries',
  grammar: PACSQUERIES_GRAMMAR,
  help: {
    summary: 'Create or list PACS queries (uses current pacsserver context unless overridden)',
    description: 'The queries asked of a PACS, as a resource listing: list them (for the context\'s server unless --pacsserver names one), list their fields, create one, or decode one\'s answer.',
    category: 'PACS',
    examples: [
      'pacsqueries list                          # List for current pacsserver',
      'pacsqueries list --pacsserver PACSDCM     # Override server',
      'pacsqueries create "PatientID:1234" --title "PID 1234"',
      'pacsqueries decode <id>                   # Decode a query result',
    ],
  },
  handler: (line: CommandArguments<typeof PACSQUERIES_GRAMMAR>): Promise<CommandEnvelope> => chiliLine_run('pacsqueries', PACSQUERIES_GRAMMAR, line),
});

/** What a `pacsretrieve` line may hold. */
const PACSRETRIEVE_GRAMMAR = {
  subcommands: {
    pull: { summary: 'Retrieve a query\'s DICOM data into ChRIS', operands: [{ name: 'queryId', kind: 'int', min: 1, summary: 'The query\'s id' }] },
    report: { summary: 'Show the status of a query\'s retrieve', operands: [{ name: 'queryId', kind: 'int', min: 1, summary: 'The query\'s id' }] },
    cancel: { summary: 'Cancel (delete) a retrieve', operands: [{ name: 'retrieveId', kind: 'int', min: 1, summary: 'The retrieve\'s id' }] },
  },
} as const satisfies CommandGrammar;

/**
 * `pacsretrieve <pull <queryId> | report <queryId> | cancel <retrieveId>>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pacsretrieveCommand] }, 'backend');
 * ```
 */
export const pacsretrieveCommand = command_declare({
  name: 'pacsretrieve',
  grammar: PACSRETRIEVE_GRAMMAR,
  help: {
    summary: 'Pull or inspect DICOM retrieves for PACS queries',
    description: 'A PACS query\'s retrieves: pull its DICOM data into ChRIS, report how far a retrieve has come, or cancel one.',
    category: 'PACS',
    examples: [
      'pacsretrieve pull <queryId>       # Pull data for a query',
      'pacsretrieve report <queryId>     # Show retrieve status',
      'pacsretrieve cancel <retrieveId> # Cancel a retrieve',
    ],
  },
  handler: (line: CommandArguments<typeof PACSRETRIEVE_GRAMMAR>): Promise<CommandEnvelope> => chiliLine_run('pacsretrieve', PACSRETRIEVE_GRAMMAR, line),
});
