/**
 * @file `inspect <id>` for the resource commands: one record of a CUBE
 * collection, every field it has with its value, beside `inspect` alone,
 * which names the fields.
 *
 * A resource command's `inspect` takes an optional id (`jobs inspect 42`,
 * `feed inspect 5975`). With it the record is read through the command's own
 * listing, filtered `id:<id>` and asked for every field, and drawn as a
 * table of fields and values; an id CUBE holds no record of is said and
 * exits 1.
 *
 * Key components:
 * - RESOURCE_ID_OPERANDS: the optional id operand, as grammar.
 * - ResourceRecordSource: how one command reads its fields and its rows.
 * - resourceRecord_render: the record drawn, or why not.
 *
 * Typical usage:
 * ```ts
 * inspect: { summary: '…', operands: RESOURCE_ID_OPERANDS },
 * case 'inspect': return args.operands.id === undefined ? fields_render() : resourceRecord_render(TAG_RECORD, args.operands.id);
 * ```
 *
 * Dependencies: chili's table, the session's exit status.
 *
 * @module
 */
import chalk from 'chalk';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';

import { exitCode_set } from '../../core/handlerRun.js';

/** The operand of `inspect`: a record's id, or none to name the fields. */
export const RESOURCE_ID_OPERANDS = [
  { name: 'id', kind: 'int', min: 1, optional: true, summary: "The record's id: its fields and values; none names the fields" },
] as const;

/**
 * How one resource command reads its fields and its rows.
 *
 * @example
 * ```ts
 * const source: ResourceRecordSource = {
 *   command: 'tag', noun: 'tag', title: 'Tag',
 *   fields_fetch: tagFields_fetch,
 *   rows_fetch: async (options: CLIoptions) => (await tags_fetchList(options)).tags,
 * };
 * ```
 */
export interface ResourceRecordSource {
  /** The command's name, as a refusal opens. */
  readonly command: string;
  /** What one record is called: `plugin instance`. */
  readonly noun: string;
  /** The table's title before the id: `Plugin Instance`. */
  readonly title: string;
  /** The fields a record has. */
  readonly fields_fetch: () => Promise<string[] | null>;
  /** The rows a listing's options give. */
  readonly rows_fetch: (options: CLIoptions) => Promise<readonly object[]>;
}

/**
 * One field's value in words: a dash for none, JSON for a structure.
 *
 * @param value - The value.
 * @returns The words.
 */
function fieldValue_say(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * One record by its id, every field with its value: `inspect <id>`.
 *
 * @param source - How the command reads its fields and rows.
 * @param id - The record's id.
 * @returns The table of fields and values; an error when CUBE holds no such record or cannot be read.
 *
 * @example
 * ```ts
 * await resourceRecord_render(PLUGININSTANCE_RECORD, 864581); // ┌ Plugin Instance 864581 ┐ id 864581, status finishedSuccessfully, …
 * ```
 */
export async function resourceRecord_render(source: ResourceRecordSource, id: number): Promise<CommandEnvelope> {
  try {
    const fields: string[] = (await source.fields_fetch()) ?? [];
    const options: CLIoptions = { search: `id:${id}`, ...(fields.length > 0 ? { fields: fields.join(',') } : {}) };
    const rows: readonly object[] = await source.rows_fetch(options);
    const row: object | undefined = rows.find((one: object): boolean => Number(Reflect.get(one, 'id')) === id);
    if (row === undefined) {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`${source.command} inspect: no ${source.noun} ${id}`)}\n`);
    }
    const names: string[] = fields.length > 0 ? fields : Object.keys(row);
    const table: Array<{ field: string; value: string }> = names.map((name: string) => ({ field: name, value: fieldValue_say(Reflect.get(row, name)) }));
    return envelope_ok(table_render(table, ['field', 'value'], { title: { title: `${source.title} ${id}`, justification: 'center' } }));
  } catch (e: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`${source.command} inspect: ${e instanceof Error ? e.message : String(e)}`)}\n`);
  }
}
