/**
 * @file What a PACS query's line may hold, as `query` and `pacs query` both
 * take it: the question, and how its answer should read.
 *
 * One grammar, so the standalone verb and the subcommand cannot drift. It
 * lives apart from the query verb so `pacs` reads it without loading that
 * verb's graph.
 *
 * Key components:
 * - QUERY_GRAMMAR: the operands and options.
 * - QueryLine: what a handler of either line reads.
 *
 * Dependencies: the declaration types only.
 *
 * @module
 */
import type { CommandArguments, CommandGrammar } from '../../core/commandDeclaration.js';

/**
 * A PACS query's operands and options.
 *
 * @example
 * ```ts
 * const queryCommand = command_declare({ name: 'query', grammar: QUERY_GRAMMAR, help, handler });
 * ```
 */
export const QUERY_GRAMMAR = {
  operands: [
    { name: 'expression', kind: 'word', optional: true, repeat: true, summary: 'The question: Key:Value[,Key:Value…] (Key:a,b,c asks for each), or a JSON object' },
  ],
  options: {
    title: { long: 'title', summary: 'Title for the query record (default: Query <timestamp>)', value: { name: 'title', kind: 'word' } },
    pacsserver: { long: 'pacsserver', summary: 'Override the PACS server (default: the context\'s); a comma-separated list asks each', value: { name: 'id', kind: 'word' } },
    patients: { long: 'patients', summary: 'Ask after several patients: MRNs comma-separated, or @<cfs-file> (one per line)', value: { name: 'list', kind: 'word' } },
    csv: { long: 'csv', summary: 'Render the answer as CSV (a row per study, and one per patient with none)' },
    csvTo: { long: 'csv-to', asks: true, summary: 'Write that CSV into ChRIS storage; given no path, the destination is asked for', value: { name: 'cfs-path', kind: 'cfsPath' } },
    force: { long: 'force', summary: 'Overwrite the table at that path; without it, an existing file is kept' },
    table: { long: 'table', summary: 'Show the answer\'s rows as an aligned table: the CSV\'s columns, for a screen' },
    series: { long: 'series', summary: 'One row per series instead of per study; alone, it shows the series table' },
    anon: { long: 'anon', summary: 'Stand in for names and record numbers (for demonstrating on a live PACS)' },
    fresh: { long: 'fresh', summary: 'Ask the PACS even if this question was answered before' },
  },
} as const satisfies CommandGrammar;

/** What a handler of a query line reads: the question and the options, from `query` or `pacs query`. */
export type QueryLine = Pick<CommandArguments<typeof QUERY_GRAMMAR>, 'operands' | 'options'>;
