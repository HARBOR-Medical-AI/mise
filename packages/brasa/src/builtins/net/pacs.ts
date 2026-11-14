/**
 * @file Compound `pacs` command.
 *
 * Entry point for all PACS operations: server context management, querying,
 * and series retrieval. Declared in one record (`pacsCommand`) with a
 * subcommand each; `pacs query` and `pacs pull` take the very lines of the
 * standalone `query` and `pull` (one grammar each) and run their handlers.
 *
 * Key components:
 * - pacsCommand: the declaration.
 * - builtin_pacs: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_pacs(['connect', 'PACSDCM']);
 * ```
 *
 * Dependencies: cumin's context and server listing; the query, pull and
 * status verbs.
 *
 * @module
 */

import chalk from 'chalk';
import { chrisContext, pacsServers_list } from '@fnndsc/cumin';
import { PACS_SERVERS_MODEL_KIND, type PacsServer, type PacsServersModel, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { queryLine_run } from './query.js';
import { QUERY_GRAMMAR } from './query.args.js';
import { pacsRefusal_hint, pacsRefusal_is } from './pacsAccess.js';
import { pacsStatus_run } from './status.js';
import { pullLine_run } from '../fs/pull.js';
import { PULL_GRAMMAR } from '../fs/pull.args.js';
import { sink_dataLine, sink_errLine } from '../../core/sink.js';
import { errorStack } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/**
 * Streams the list of registered PACS servers, marking the active one.
 *
 * A listing CUBE refused is not an empty one: it says why, and a
 * permission refusal says what to do about it.
 *
 * @param active - Current active PACS server identifier or null.
 * @returns False when the servers could not be listed.
 */
async function servers_print(active: string | null): Promise<boolean> {
  const result = await pacsServers_list();

  if (!result.ok) {
    const problem: string = errorStack.stack_pop()?.message ?? 'Failed to list PACS servers.';
    // Imported here rather than at the top, as query.ts does, so this
    // module keeps its narrow graph.
    const { error_stripDebugPrefix } = await import('../utils.js');
    sink_errLine(chalk.red(`pacs: ${error_stripDebugPrefix(problem)}`));
    if (pacsRefusal_is([problem])) sink_errLine(pacsRefusal_hint().trimEnd());
    return false;
  }
  if (result.value.length === 0) {
    sink_dataLine(chalk.yellow('No PACS servers registered in CUBE.'));
    return true;
  }

  sink_dataLine('');
  for (const srv of result.value) {
    const label: string = srv.identifier ?? srv.name ?? String(srv.id);
    const isActive: boolean =
      active !== null &&
      (label === active || String(srv.id) === active);
    const marker: string = isActive ? chalk.green(' ✓ active') : '';
    const idStr: string = chalk.gray(`[${srv.id}]`);
    sink_dataLine(`  ${idStr}  ${chalk.cyan(label.padEnd(20))}${marker}`);
  }
  sink_dataLine('');
  sink_dataLine(chalk.gray('  Use: pacs connect <name|id>'));
  sink_dataLine('');
  return true;
}


/**
 * Projects the registered PACS servers onto the wire's `pacs.servers` model.
 *
 * A server with no identifier is left out rather than given a made-up one:
 * the identifier is what `--pacsserver` names and what CUBE files a query
 * under, so a row that cannot be named cannot be chosen either.
 *
 * @param active - The identifier or id of the connected server, when there is one.
 * @returns The model, or null when CUBE registers nothing.
 */
async function serversModel_build(active: string | null): Promise<PacsServersModel | null> {
  const result = await pacsServers_list();
  if (!result.ok || result.value.length === 0) return null;
  const servers: PacsServer[] = [];
  for (const server of result.value) {
    const identifier: string | undefined = server.identifier ?? server.name;
    if (identifier === undefined || identifier === '') continue;
    servers.push({
      id: server.id,
      identifier,
      active: active !== null && (identifier === active || String(server.id) === active),
    });
  }
  return servers.length > 0 ? { servers } : null;
}

/** What a `pacs` line may hold: a subcommand, or none for the active server. */
const PACS_GRAMMAR = {
  bare: { summary: 'Show the active PACS server' },
  subcommands: {
    connect: {
      summary: 'List the registered PACS servers with the active one marked; given one, make it active',
      operands: [{ name: 'server', kind: 'word', optional: true, summary: 'The server, by identifier or by id' }],
    },
    disconnect: { summary: 'Clear the active PACS server' },
    list: { summary: 'List the registered PACS servers with the active one marked' },
    query: { summary: 'Create a PACS query and wait for its answer, as query does (help query)', operands: QUERY_GRAMMAR.operands, options: QUERY_GRAMMAR.options },
    pull: { summary: 'Pull DICOM series into ChRIS storage, as pull does (help pull)', operands: PULL_GRAMMAR.operands, options: PULL_GRAMMAR.options },
    status: {
      summary: 'Per series, what has landed in CUBE and what is missing, with in-CUBE paths',
      operands: [{ name: 'target', kind: 'pacsQuery', glob: true, summary: 'A query id, a /net/pacs/queries/… path, or a Key:Value question' }],
    },
  },
} as const satisfies CommandGrammar;

/**
 * `pacs [connect [server] | disconnect | list | query … | pull … | status <target>]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pacsCommand] }, 'backend');
 * ```
 */
export const pacsCommand = command_declare({
  name: 'pacs',
  grammar: PACS_GRAMMAR,
  help: {
    summary: 'PACS subsystem — server context, query, and series retrieval',
    description: 'PACS subsystem — server context, query, and series retrieval. Bare, it names the active server. '
      + 'pacs query and pacs pull take the lines query and pull take; their pages say more.',
    category: 'PACS',
    examples: [
      'pacs                              # Show active server',
      'pacs connect                      # List all servers',
      'pacs connect PACSDCM              # Set active server by identifier',
      'pacs connect 1                    # Set active server by numeric ID',
      'pacs disconnect                   # Clear active server',
      'pacs list                         # List all servers',
      'pacs query PatientID:1234         # Query PACS',
      'pacs pull /net/pacs/queries/42_AccessionNumber:12345678',
      'pacs status AccessionNumber:22119730   # What has landed in CUBE, what is missing',
    ],
  },
  handler: pacs_run,
});

/**
 * `pacs` over words already split: the declaration's parse and handler.
 *
 * @param args - The subcommand and its words.
 * @returns An envelope; streaming subcommands carry empty rendered text and
 *   emit their output live, while query/pull return their own envelopes.
 *
 * @example
 * ```ts
 * await builtin_pacs(['list']);
 * ```
 */
export async function builtin_pacs(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(pacsCommand, args);
}

/**
 * PACS subsystem command — server context management, query, and pull.
 *
 * @param args - The line, parsed.
 * @returns An envelope; streaming subcommands carry empty rendered text and
 *   emit their output live, while query/pull return their own envelopes.
 */
async function pacs_run(args: CommandArguments<typeof PACS_GRAMMAR>): Promise<CommandEnvelope> {
  // No subcommand — show active server
  if (args.subcommand === null) {
    const active: string | null = await chrisContext.PACSserver_get();
    if (active) {
      sink_dataLine(`Active PACS server: ${chalk.cyan(active)}`);
      sink_dataLine(chalk.gray('  pacs connect         — list all servers'));
      sink_dataLine(chalk.gray('  pacs disconnect      — clear active server'));
    } else {
      sink_dataLine(chalk.yellow('No PACS server set.'));
      sink_dataLine(chalk.gray('  pacs connect         — list available servers'));
      sink_dataLine(chalk.gray('  pacs connect <id>    — set active server'));
    }
    return envelope_ok('');
  }

  switch (args.subcommand) {
    case 'connect': {
      const target: string | undefined = args.operands.server;
      if (!target) {
        const active: string | null = await chrisContext.PACSserver_get();
        if (!(await servers_print(active))) {
          exitCode_set(1);
          return envelope_error('');
        }
        return envelope_ok('');
      }
      const ok: boolean = await chrisContext.PACSserver_set(target);
      if (ok) {
        sink_dataLine(chalk.green(`[+] PACS server set to '${target}'`));
        return envelope_ok('');
      }
      sink_errLine(chalk.red(`pacs connect: Failed to set server '${target}'`));
      exitCode_set(1);
      return envelope_error('');
    }

    case 'disconnect': {
      const ok: boolean = await chrisContext.PACSserver_set('');
      if (ok) {
        sink_dataLine(chalk.green('[-] PACS server context cleared.'));
        return envelope_ok('');
      }
      sink_errLine(chalk.red('pacs disconnect: Failed to clear PACS server context.'));
      exitCode_set(1);
      return envelope_error('');
    }

    case 'list': {
      const active: string | null = await chrisContext.PACSserver_get();
      if (!(await servers_print(active))) {
        exitCode_set(1);
        return envelope_error('');
      }
      // The same question, answered twice in one breath: a terminal reads
      // the printed list, a graphical surface reads the model. A surface
      // offering a choice of servers must know what there is to choose
      // from, and asking CUBE itself would reach around the session that
      // owns the connection.
      const model: PacsServersModel | null = await serversModel_build(active);
      if (model === null) return envelope_ok('');
      return envelope_ok('', { kind: PACS_SERVERS_MODEL_KIND, data: model });
    }

    case 'query':
      return queryLine_run(args);

    case 'pull':
      return pullLine_run(args);

    case 'status':
      return pacsStatus_run(args.operands.target);
  }
}
