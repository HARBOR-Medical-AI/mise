/**
 * @file How many files a transfer moves at once: the `-j N` / `--jobs N`
 * option `download`, `upload` and `berth anchor` share, and the session
 * variable `TRANSFER_JOBS` that stands in when a line gives none.
 *
 * The option's bounds are the transfer pool's (cumin's
 * `TRANSFER_JOBS_MAX`), so the parser refuses `-j 40` before anything moves,
 * and the variable is checked by the same `int` kind, so the two refuse in
 * the same words.
 *
 * Key components:
 * - TRANSFER_JOBS_OPTION: the option, for a command's grammar.
 * - TRANSFER_JOBS_VARIABLE: the session variable's name.
 * - transferJobs_resolve: the line's number, else the variable's, else the default.
 * - transferLeftovers_render: the lines naming what failed and what a cancel left.
 *
 * Typical usage:
 * ```ts
 * const jobs: TransferJobs = transferJobs_resolve(args.options.jobs);
 * if ('refused' in jobs) return refusal(jobs.refused);
 * ```
 *
 * Dependencies: cumin's transfer pool for the bounds; the session's variables.
 *
 * @module
 */
import chalk from 'chalk';
import { TRANSFER_JOBS_DEFAULT, TRANSFER_JOBS_MAX } from '@fnndsc/cumin/transfer-pool';

import { argumentWord_check, type ArgumentCheck } from '../../core/argumentKinds.js';
import type { OptionGrammar } from '../../core/commandDeclaration.js';
import { TEXT_KIND, variable_get, type Variable } from '../../core/variables.js';

/** The session variable that says how many files move at once when a line does not. */
export const TRANSFER_JOBS_VARIABLE: string = 'TRANSFER_JOBS';

/**
 * `-j N` / `--jobs N`: how many files move at once.
 *
 * @example
 * ```ts
 * const GRAMMAR = { options: { jobs: TRANSFER_JOBS_OPTION } } as const satisfies CommandGrammar;
 * ```
 */
export const TRANSFER_JOBS_OPTION = {
  short: 'j',
  long: 'jobs',
  summary: `Move N files at once, 1 to ${TRANSFER_JOBS_MAX} (1 is one at a time); without it $TRANSFER_JOBS, else ${TRANSFER_JOBS_DEFAULT}`,
  value: { name: 'N', kind: 'int', min: 1, max: TRANSFER_JOBS_MAX },
} as const satisfies OptionGrammar;

/**
 * How many files a transfer moves at once, or why the session's variable
 * cannot say.
 *
 * @example
 * ```ts
 * const jobs: TransferJobs = { jobs: 8 };
 * ```
 */
export type TransferJobs = { readonly jobs: number } | { readonly refused: string };

/**
 * The number of files a transfer moves at once: the line's `-j`, else the
 * session's `TRANSFER_JOBS`, else the pool's default.
 *
 * @param given - The line's `-j`, already checked by the parser; undefined when the line gives none.
 * @returns The number, or a plain line refusing the variable's value.
 *
 * @example
 * ```ts
 * transferJobs_resolve(4);         // { jobs: 4 }
 * transferJobs_resolve(undefined); // { jobs: 8 }, or $TRANSFER_JOBS
 * ```
 */
export function transferJobs_resolve(given: number | undefined): TransferJobs {
  if (given !== undefined) return { jobs: given };
  const variable: Variable | undefined = variable_get(TRANSFER_JOBS_VARIABLE);
  if (variable === undefined) return { jobs: TRANSFER_JOBS_DEFAULT };
  const range: string = `it says how many files move at once, a whole number from 1 to ${TRANSFER_JOBS_MAX}`;
  if (variable.answer.kind !== TEXT_KIND || typeof variable.answer.data !== 'string') {
    return { refused: `${TRANSFER_JOBS_VARIABLE} holds a ${variable.answer.kind}; ${range}` };
  }
  const text: string = variable.answer.data.trim();
  const checked: ArgumentCheck = argumentWord_check(TRANSFER_JOBS_OPTION.value, text);
  if (!checked.ok) return { refused: `${TRANSFER_JOBS_VARIABLE} is ${text === '' ? "''" : text}; ${range}` };
  return { jobs: checked.value as number };
}

/**
 * The lines under a transfer's summary that name each file that failed
 * after its retry, and say how many a cancel left.
 *
 * @param failedPaths - The files that failed, as the transfer names them.
 * @param cancelledCount - How many files a cancel left unmoved.
 * @param verb - What the transfer does to a file (`downloaded`, `uploaded`).
 * @returns The lines, each ending in a newline; empty when nothing failed or was left.
 *
 * @example
 * ```ts
 * transferLeftovers_render(['/home/me/uploads/a.dcm'], 0, 'downloaded'); // '  failed: /home/me/uploads/a.dcm\n'
 * ```
 */
export function transferLeftovers_render(failedPaths: readonly string[], cancelledCount: number, verb: string): string {
  let rendered: string = '';
  for (const failed of failedPaths) rendered += `${chalk.red(`  failed: ${failed}`)}\n`;
  if (cancelledCount > 0) rendered += `${chalk.yellow(`  cancelled: ${cancelledCount} file(s) not ${verb}`)}\n`;
  return rendered;
}
