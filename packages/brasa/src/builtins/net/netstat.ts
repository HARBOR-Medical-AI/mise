/**
 * @file Builtin `netstat`: what the session has asked of CUBE.
 *
 * A navigation that felt slow was fourteen requests where four would do,
 * and nothing in the session could say so. `netstat` reads the kernel's
 * request ledger: how many requests since the session began (or the last
 * `netstat -r`), by endpoint family with the time spent, and the last few
 * timed. Smoke asserts budgets against the same model; an operator on a
 * slow day asks it before guessing where the time went.
 *
 * Declared in one record (`netstatCommand`): how many recent requests to
 * list, and whether to reset the count.
 *
 * Key components:
 * - netstatCommand: the declaration.
 * - builtin_netstat: the declaration run over words already split.
 * - netstat_render: the ledger as text.
 *
 * Typical usage:
 * ```ts
 * await builtin_netstat(['-n', '30']);
 * ```
 *
 * Dependencies: cumin's request ledger.
 *
 * @module
 */
import chalk from 'chalk';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
// The ledger by its own door: a jest ESM test importing a name from the
// cumin ROOT overflows cjs-module-lexer on that index and sees none of
// the names added after the overflow — the subpath is small and seen whole.
import { requestLedger_snapshot, requestLedger_reset, type LedgerSnapshot, type LedgerFamily, type LedgerEntry } from '@fnndsc/cumin/request-ledger';
import { NET_STATS_MODEL_KIND, type CommandEnvelope, envelope_ok } from '@fnndsc/menu';

/** How many recent requests the table shows unless asked otherwise. */
const LAST_SHOWN: number = 10;

/**
 * Renders the ledger: the total, the families, the last requests.
 *
 * @param snapshot - The ledger.
 * @param last - How many recent requests to list.
 * @returns The text, coloured.
 */
export function netstat_render(snapshot: LedgerSnapshot, last: number): string {
  const lines: string[] = [];
  lines.push(`${chalk.cyan('REQUESTS')} ${chalk.bold(String(snapshot.total))} since ${snapshot.since}  ${chalk.gray(`${snapshot.ms} ms on the wire`)}`);
  if (snapshot.families.length > 0) {
    const width: number = Math.max(...snapshot.families.map((f: LedgerFamily): number => f.family.length));
    for (const family of snapshot.families) {
      lines.push(`  ${family.family.padEnd(width)}  ${String(family.count).padStart(5)}  ${chalk.gray(`${family.ms} ms`)}`);
    }
  }
  const recent: LedgerEntry[] = snapshot.last.slice(-last);
  if (recent.length > 0) {
    lines.push(chalk.cyan(`LAST ${recent.length}`));
    for (const entry of recent) {
      const status: string = entry.status === 0 ? chalk.red('FAIL') : entry.status >= 400 ? chalk.yellow(String(entry.status)) : chalk.green(String(entry.status));
      lines.push(`  ${String(entry.ms).padStart(5)} ms  ${status}  ${entry.method.padEnd(4)} ${entry.path}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** What a `netstat` line may hold. */
const NETSTAT_GRAMMAR = {
  options: {
    reset: { short: 'r', long: 'reset', summary: 'Forget the count after showing it' },
    count: { short: 'n', summary: `List that many recent requests (default ${LAST_SHOWN})`, value: { name: 'count', kind: 'int', min: 0 } },
  },
} as const satisfies CommandGrammar;

/**
 * `netstat [-r] [-n <count>]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [netstatCommand] }, 'backend');
 * ```
 */
export const netstatCommand = command_declare({
  name: 'netstat',
  grammar: NETSTAT_GRAMMAR,
  help: {
    summary: 'What the session has asked of CUBE',
    description: 'What the session has asked of CUBE: requests since the session (or the last reset), by endpoint family with the time spent, and the last few timed',
    category: 'Connection',
    examples: [
      'netstat              # the count, by family, the last 10',
      'netstat -n 30        # the last 30 requests, timed',
      'netstat -r; cd ~/feeds; netstat   # what one navigation costs',
    ],
  },
  handler: async (args: CommandArguments<typeof NETSTAT_GRAMMAR>): Promise<CommandEnvelope> => netstat_run(args.options.count ?? LAST_SHOWN, args.options.reset),
});

/**
 * `netstat` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `netstat`.
 * @returns The ledger, or the refusal of a bad line.
 */
export async function builtin_netstat(args: string[] = []): Promise<CommandEnvelope> {
  return declaredCommand_run(netstatCommand, args);
}

/**
 * Reads the ledger, and resets it when asked; the readout then shows what
 * was forgotten.
 *
 * @param last - How many recent requests to list.
 * @param reset - Forget the count after reading it.
 * @returns The ledger as text and as the `net.stats` model.
 */
function netstat_run(last: number, reset: boolean): CommandEnvelope {
  const snapshot: LedgerSnapshot = requestLedger_snapshot({ last: Math.max(last, LAST_SHOWN) });
  if (reset) requestLedger_reset();
  const rendered: string = netstat_render(snapshot, last) + (reset ? `${chalk.gray('count reset')}\n` : '');
  return envelope_ok(rendered, { kind: NET_STATS_MODEL_KIND, data: snapshot });
}
