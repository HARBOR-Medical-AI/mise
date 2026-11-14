/**
 * @file What a pull's line may hold, as `pull` and `pacs pull` both take it:
 * the queries, studies or series to pull, and how to wait for them.
 *
 * One grammar, so the standalone verb and the subcommand cannot drift. It
 * lives apart from the pull verb so `pacs` reads it without loading that
 * verb's graph.
 *
 * Key components:
 * - PULL_GRAMMAR: the operands and options.
 * - PullLine: what a handler of either line reads.
 *
 * Dependencies: the declaration types only.
 *
 * @module
 */
import type { CommandArguments, CommandGrammar } from '../../core/commandDeclaration.js';

/**
 * A pull's operands and options.
 *
 * @example
 * ```ts
 * const pullCommand = command_declare({ name: 'pull', grammar: PULL_GRAMMAR, help, handler });
 * ```
 */
export const PULL_GRAMMAR = {
  operands: [
    { name: 'target', kind: 'pacsQuery', repeat: true, glob: true, summary: 'A /net/pacs/queries/… path (a query, a study or a series), or a Key:Value question asked first' },
  ],
  options: {
    detach: { long: 'detach', summary: 'Fire the retrieves and return the handles at once: <seriesUID> <retrieveId> per line' },
    nowait: { long: 'nowait', summary: 'The older spelling of --detach' },
    retry: { long: 'retry', summary: 'Re-fire retrieves for [NO LONK] series up to N more times', value: { name: 'N', kind: 'int', min: 0 } },
    newFeed: { long: 'new-feed', repeat: true, summary: 'Create one named feed from the complete retrieved selection', value: { name: 'title', kind: 'word' } },
  },
} as const satisfies CommandGrammar;

/** What a handler of a pull line reads: the targets and the options, from `pull` or `pacs pull`. */
export type PullLine = Pick<CommandArguments<typeof PULL_GRAMMAR>, 'operands' | 'options'>;
