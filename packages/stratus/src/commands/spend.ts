/**
 * @file `spend [<name>…]`: what each cluster costs, resource by resource, at
 * list price: an hour, and since each resource was made (docs/stratus.adoc,
 * D7; `harbor-oci`'s `burn`).
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import type { CommandHelp } from '@fnndsc/brasa/core';
import type { HarborCluster } from '../checkout/harborOci.js';
import { money_words, spend_line, spend_read, type Spend, type SpendItem } from '../cluster/spend.js';
import type { ClusterCommandContext } from './cluster.js';

/** `spend`'s help. */
export const SPEND_HELP: CommandHelp = {
  usage: 'spend [<name>…]',
  summary: 'What each cluster costs, an hour and so far',
  category: 'Resources',
  description: 'Prices every live resource in each cluster\'s compartment at list price: machines by vCPU and memory while they run, volumes by size and performance, load balancers by the hour and their minimum bandwidth. Prints each with its rate an hour and what it has come to since it was made, then the cluster\'s total. An estimate, not the bill: discounts, free tiers and traffic are not in it. Bare, every cluster.',
  examples: ['spend', 'spend harbor'],
};

/**
 * One cluster's spend as lines.
 *
 * @param name - The cluster.
 * @param spend - Its spend.
 * @returns The lines.
 */
export function spend_lines(name: string, spend: Spend): string[] {
  const nameWidth: number = Math.max(4, ...spend.items.map((item: SpendItem): number => item.name.length));
  const rate = (amount: number | null, unit: string = ''): string => (amount === null ? 'not priced' : `${money_words(amount, spend.currency)}${unit}`);
  return [
    chalk.bold(name),
    ...spend.items.map((item: SpendItem): string => `  ${item.kind.padEnd(15)} ${item.name.padEnd(nameWidth)}  ${rate(item.hourly, '/h').padStart(10)}  ${rate(item.soFar, ' so far').padStart(17)}  ${chalk.gray(item.detail)}`),
    `  ${chalk.yellow(spend_line(spend))}`,
  ];
}

/**
 * Runs `spend`.
 *
 * @param context - The session.
 * @param args - The clusters' names.
 * @returns The envelope.
 */
export async function spend_run(context: ClusterCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const flag: string | undefined = args.find((word: string): boolean => word.startsWith('-'));
  if (flag !== undefined) return envelope_error('', undefined, `spend: ${flag}: unknown option\n`);
  const all: HarborCluster[] = context.clusters.clusters_read();
  const missing: string[] = args.filter((name: string): boolean => !all.some((cluster: HarborCluster): boolean => cluster.name === name));
  if (missing.length > 0) return envelope_error('', undefined, `spend: ${missing.join(', ')}: no such cluster\n`);
  const chosen: HarborCluster[] = args.length === 0 ? all : all.filter((cluster: HarborCluster): boolean => args.includes(cluster.name));
  if (chosen.length === 0) return envelope_ok('no clusters\n');
  const blocks: string[] = [];
  for (const cluster of chosen) {
    const compartmentId: string | undefined = cluster.settings['OCI_COMPARTMENT_OCID'];
    const region: string | null = cluster.settings['OCI_REGION'] ?? context.region();
    if (compartmentId === undefined || region === null) { blocks.push(`${chalk.bold(cluster.name)}\n  ${chalk.gray('not priced: no compartment known')}`); continue; }
    blocks.push(spend_lines(cluster.name, await spend_read(context.driver, compartmentId, region, new Date())).join('\n'));
  }
  return envelope_ok(`${blocks.join('\n\n')}\n${chalk.gray('List prices: an estimate, not the bill.')}\n`);
}
