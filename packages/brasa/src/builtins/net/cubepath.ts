/**
 * @file `cubepath`: where each series under a PACS path lives in CUBE.
 *
 * Given one or more `/net/pacs/queries/...` VFS paths (at query, study, or series level),
 * resolves where each matching series lives in CUBE storage and reports the
 * actual file count there. Zero files means the series has not been pulled.
 *
 * Declared in one record (`cubepathCommand`): paths that glob, the PACS
 * server, and whether to wait for a series still arriving.
 *
 * Key components:
 * - cubepathCommand: the declaration.
 * - builtin_cubepath: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_cubepath(['/net/pacs/queries/AccessionNumber:12345678_qid:2661', '--retry']);
 * ```
 *
 * Dependencies: pacsUtils for the series and their CUBE folders; the
 * session's client.
 *
 * @module
 */

import chalk from 'chalk';
import { Client } from '@fnndsc/cumin';
import { session } from '../../session/index.js';
import { path_resolve } from '../utils.js';
import {
  PACSSeriesInfo,
  SeriesCubePath,
  pacs_seriesCollect,
  pacsServer_resolve,
  series_cubePathGet,
} from './pacsUtils.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What a `cubepath` line may hold. */
const CUBEPATH_GRAMMAR = {
  operands: [
    { name: 'path', kind: 'cfsPath', repeat: true, glob: true, summary: 'A PACS path: a query, a study or a series under /net/pacs/queries' },
  ],
  options: {
    pacsserver: { long: 'pacsserver', summary: 'Override PACS server (default: context PACSserver)', value: { name: 'id', kind: 'word' } },
    retry: { long: 'retry', summary: 'Ask again, a few times, for a series not yet in CUBE' },
  },
} as const satisfies CommandGrammar;

/**
 * `cubepath [--retry] [--pacsserver <id>] <path…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cubepathCommand] }, 'backend');
 * ```
 */
export const cubepathCommand = command_declare({
  name: 'cubepath',
  grammar: CUBEPATH_GRAMMAR,
  help: {
    summary: 'Where each series under a PACS path lives in CUBE',
    description: 'Show CUBE FS path and file count for each series under a PACS VFS path. Zero files = not pulled.',
    category: 'Navigation',
    examples: [
      '# All series under a query',
      'cubepath /net/pacs/queries/AccessionNumber:12345678_qid:2661',
      '',
      '# All series under a study',
      'cubepath /net/pacs/queries/AccessionNumber:12345678_qid:2661/Study_1.2.3_Brain_MRI',
      '',
      '# Single series',
      'cubepath /net/pacs/queries/AccessionNumber:12345678_qid:2661/Study_1.2.3/Series_1.2.3.4_AX_T2',
    ],
  },
  handler: async (args: CommandArguments<typeof CUBEPATH_GRAMMAR>): Promise<CommandEnvelope> =>
    cubepath_run(args.operands.path, args.options.pacsserver ?? null, args.options.retry),
});

/**
 * `cubepath` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cubepath`.
 * @returns Each series' CUBE folder and file count, or the refusal of a bad line.
 */
export async function builtin_cubepath(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cubepathCommand, args);
}

/**
 * Resolves CUBE FS paths and file counts for all series under one or more PACS VFS paths.
 *
 * @param positional - The PACS paths.
 * @param pacsserverOverride - The PACS server named, or null for the context's.
 * @param retry - Ask again for a series not yet in CUBE.
 * @returns Each series' CUBE folder and file count; warnings on the error channel.
 */
async function cubepath_run(positional: readonly string[], pacsserverOverride: string | null, retry: boolean): Promise<CommandEnvelope> {
  const pacsIdentifier: string | null = await pacsServer_resolve(pacsserverOverride);
  if (!pacsIdentifier) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('cubepath: No PACS server available. Set one with: pacs connect <id>')}\n`);
  }

  // Warnings accumulate on the err channel; result lines on the data channel.
  let errOut: string = '';

  // Collect series from all paths
  const allSeries: PACSSeriesInfo[] = [];
  for (const rawPath of positional) {
    const vfsPath: string = rawPath.startsWith('/') ? rawPath : await path_resolve(rawPath);
    if (!vfsPath.startsWith('/net/pacs')) {
      errOut += `${chalk.red(`cubepath: Not a PACS VFS path: ${rawPath}`)}\n`;
      continue;
    }
    const found: PACSSeriesInfo[] = await pacs_seriesCollect(vfsPath, pacsIdentifier, 'cubepath');
    allSeries.push(...found);
  }

  if (allSeries.length === 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${errOut}${chalk.yellow('cubepath: No series found under that path.')}\n`);
  }

  const client: Client | null = await session.connection.client_get();
  if (!client) {
    exitCode_set(1);
    return envelope_error('', undefined, `${errOut}${chalk.red('cubepath: Not connected to ChRIS.')}\n`);
  }

  const maxAttempts: number = retry ? 4 : 1;
  const retryDelayMs: number = retry ? 2_000 : 0;

  type SeriesResult = { info: PACSSeriesInfo; cubePath: SeriesCubePath | null };

  const results: SeriesResult[] =
    await Promise.all(
      allSeries.map(async (info: PACSSeriesInfo): Promise<SeriesResult> => {
        const cubePath: SeriesCubePath | null =
          await series_cubePathGet(info.seriesUID, maxAttempts, retryDelayMs);
        return { info, cubePath };
      }),
    );

  const maxLabelLen: number = Math.max(...results.map((r: SeriesResult) => r.info.seriesLabel.length));

  let rendered: string = '';
  let notInCube: number = 0;
  for (const { info, cubePath } of results) {
    const label: string = info.seriesLabel.padEnd(maxLabelLen);
    const arrow: string = chalk.cyan('->');
    if (cubePath) {
      const countStr: string = cubePath.fileCount > 0
        ? chalk.green(`(${cubePath.fileCount} files)`)
        : chalk.yellow('(0 files — may not be pulled)');
      rendered += `  ${chalk.white(label)}  ${arrow}  ${chalk.cyan(cubePath.folderPath)}  ${countStr}\n`;
    } else {
      rendered += `  ${chalk.white(label)}  ${arrow}  ${chalk.gray('(not in CUBE)')}\n`;
      notInCube++;
    }
  }

  if (notInCube > 0) {
    rendered += `${chalk.gray(`\n  ${notInCube}/${results.length} series not found in CUBE — use pull to retrieve.`)}\n`;
  }

  const envelope: CommandEnvelope = envelope_ok(rendered);
  if (errOut.length > 0) {
    envelope.renderedErr = errOut;
  }
  return envelope;
}
