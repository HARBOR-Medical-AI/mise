/**
 * @file Builtin `pacs status`.
 *
 * Reports, per series, how much of a PACS query's data has actually landed in
 * CUBE storage: a fill bar of registered files against the expected DICOM
 * instance count, the derived state (pending/pulling/pulled), and the in-CUBE
 * `/SERVICES` folder each pulled series occupies. This is the observability
 * half of the pull recovery loop: `pacs status` shows what is missing, and
 * re-running `pull` fetches exactly that.
 *
 * The target may be a query expression (`AccessionNumber:22119730`), a
 * `/net/pacs/queries/...` VFS path, or a bare numeric query id. An expression
 * is matched against the caller's existing PACS queries (most recent wins) so
 * repeated status checks do not mint new query records; only when no match
 * exists is a fresh query created.
 *
 * @module
 */
import chalk from 'chalk';
import { pacsQueries_list, pacsRetrieve_statusForQuery, type PACSQueryStatusReport, type SeriesRetrieveStatus, type FilteredResourceData } from '@fnndsc/cumin';
import { spinner } from '../../lib/spinner.js';
import { pacsQuery_createAndWait, queryExpr_parse } from './query.js';
import { queryId_extractFromFolder } from '@fnndsc/salsa';
import { pacsServer_resolve } from './pacsUtils.js';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** Width of the per-series fill bar, in characters. */
const BAR_WIDTH: number = 20;

/**
 * Renders a fill bar for a series' progress.
 *
 * @param actual - Files registered in CUBE.
 * @param expected - Files the PACS reports for the series.
 * @returns A `▓▓▓░░░`-style bar of {@link BAR_WIDTH} characters.
 */
function bar_render(actual: number, expected: number): string {
  const denominator: number = Math.max(expected, actual, 1);
  const filled: number = Math.min(BAR_WIDTH, Math.round((actual / denominator) * BAR_WIDTH));
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

/**
 * Colors a series line by its retrieve state.
 *
 * @param status - The series' derived state.
 * @param text - The rendered line.
 * @returns The line, colored: pulled green, pulling yellow, pending gray,
 *   error red.
 */
function seriesLine_colorize(status: SeriesRetrieveStatus['status'], text: string): string {
  if (status === 'pulled') return chalk.green(text);
  if (status === 'pulling') return chalk.yellow(text);
  if (status === 'error') return chalk.red(text);
  return chalk.gray(text);
}

/**
 * Finds the caller's most recent PACS query whose stored expression matches
 * the given one.
 *
 * Queries store their expression as canonical JSON of the parsed key/value
 * map, so matching compares parsed objects rather than raw strings.
 *
 * @param exprObj - The parsed query expression.
 * @returns The highest (most recent) matching query id, or null when none
 *   matches.
 */
async function queryId_findForExpression(exprObj: Record<string, string>): Promise<number | null> {
  // No bound: this looks for the most recent query matching an expression,
  // and a search over the first 200 of 1,817 answers "not found" for
  // anything older — a page presented as the log (#401).
  const listResult = await pacsQueries_list({});
  if (!listResult.ok || !listResult.value) return null;
  const listing: FilteredResourceData = listResult.value;
  const rows: Record<string, unknown>[] = listing.tableData ?? [];

  let bestId: number | null = null;
  for (const row of rows) {
    const rawQuery: unknown = row.query;
    const id: number = Number(row.id);
    if (typeof rawQuery !== 'string' || !Number.isInteger(id)) continue;
    let stored: Record<string, string>;
    try {
      stored = JSON.parse(rawQuery) as Record<string, string>;
    } catch {
      continue;
    }
    const storedKeys: string[] = Object.keys(stored ?? {});
    const exprKeys: string[] = Object.keys(exprObj);
    const matches: boolean =
      storedKeys.length === exprKeys.length &&
      exprKeys.every((key: string) => stored[key] === exprObj[key]);
    if (matches && (bestId === null || id > bestId)) bestId = id;
  }
  return bestId;
}

/**
 * Resolves a status target to a numeric query id.
 *
 * @param target - A bare query id, a `/net/pacs/queries/...` path, or a query
 *   expression.
 * @param pacsserver - The resolved PACS server identifier, used only when a
 *   fresh query must be created for an unmatched expression.
 * @returns The query id, or null when the target cannot be resolved (an error
 *   line has been rendered by the caller from the returned reason).
 */
async function statusTarget_resolve(
  target: string,
  pacsserver: string,
): Promise<{ queryId: number | null; reason: string }> {
  if (/^\d+$/.test(target)) {
    return { queryId: Number(target), reason: '' };
  }

  if (target.startsWith('/')) {
    const parsedId: number = queryId_extractFromFolder(target);
    if (!Number.isNaN(parsedId)) return { queryId: parsedId, reason: '' };
    return { queryId: null, reason: `Cannot parse a query id from path: ${target}` };
  }

  const exprObj: Record<string, string> | null = queryExpr_parse(target);
  if (!exprObj) {
    return { queryId: null, reason: `Not a query id, PACS path, or query expression: ${target}` };
  }

  const existing: number | null = await queryId_findForExpression(exprObj);
  if (existing !== null) return { queryId: existing, reason: '' };

  // No prior query for this expression: run one so status has a series list
  // to compare against.
  spinner.start(`Querying PACS for ${target}...`, true);
  const created = await pacsQuery_createAndWait(
    target,
    `status_${target}`,
    pacsserver,
    (msg: string) => spinner.updateMessage(msg),
  );
  spinner.stop();
  if (!created) return { queryId: null, reason: `Query failed for: ${target}` };
  return { queryId: created.queryId, reason: '' };
}

/**
 * Renders a status report: per study, one bar line per series with counts,
 * state, and the in-CUBE folder path.
 *
 * @param report - The status report to render.
 * @returns The rendered multi-line report.
 */
function statusReport_render(report: PACSQueryStatusReport): string {
  const lines: string[] = [];
  let pulledCount: number = 0;
  let seriesCount: number = 0;

  for (const study of report.studies) {
    lines.push(chalk.bold(`Study: ${study.studyDescription ?? study.studyInstanceUID ?? 'unknown'}`));
    const descWidth: number = Math.max(
      ...study.series.map((s: SeriesRetrieveStatus) => (s.seriesDescription ?? s.seriesInstanceUID).length),
      1,
    );
    for (const series of study.series) {
      seriesCount++;
      if (series.status === 'pulled') pulledCount++;
      const desc: string = (series.seriesDescription ?? series.seriesInstanceUID).padEnd(descWidth);
      const bar: string = bar_render(series.actualFiles, series.expectedFiles);
      const counts: string = `${series.actualFiles}/${series.expectedFiles}`.padStart(9);
      const state: string = series.status.padEnd(7);
      lines.push(seriesLine_colorize(series.status, `  ${desc}  ${bar} ${counts}  ${state}`));
      if (series.folderPath !== null) {
        lines.push(chalk.gray(`  ${' '.repeat(descWidth)}  ${series.folderPath}`));
      }
    }
    lines.push('');
  }

  const summaryColor = pulledCount === seriesCount ? chalk.green : chalk.yellow;
  lines.push(summaryColor(`${pulledCount}/${seriesCount} series fully in CUBE.`));
  if (pulledCount < seriesCount) {
    lines.push(chalk.gray(`Re-run pull to fetch the missing series; already-complete series are skipped.`));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reports per-series pull status for a PACS query: expected vs registered
 * file counts, derived state, and the in-CUBE storage path.
 *
 * `pacs status` parses its line against the `pacs` declaration; this runs it.
 *
 * @param target - A query expression, a `/net/pacs/queries/...` path, or a
 *   numeric query id.
 * @returns An envelope carrying the rendered report and a typed model of it.
 * @example
 * pacs status AccessionNumber:22119730
 * pacs status /net/pacs/queries/AccessionNumber:22119730_qid:2833
 * pacs status 2833
 */
export async function pacsStatus_run(target: string): Promise<CommandEnvelope> {

  const pacsserver: string | null = await pacsServer_resolve(null);
  if (!pacsserver) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('pacs status: No PACS server available. Set one with: pacs connect <id>')}\n`);
  }

  const { queryId, reason } = await statusTarget_resolve(target, pacsserver);
  if (queryId === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`pacs status: ${reason}`)}\n`);
  }

  spinner.start(`Resolving CUBE storage for query ${queryId}...`, true);
  const reportResult = await pacsRetrieve_statusForQuery(queryId);
  spinner.stop();
  if (!reportResult.ok) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`pacs status: Failed to build status report for query ${queryId}.`)}\n`);
  }

  const report: PACSQueryStatusReport = reportResult.value;
  const rendered: string = `${chalk.bold(`Query ${queryId}`)}\n${statusReport_render(report)}`;
  return envelope_ok(rendered, { kind: 'pacs.status', data: report });
}
