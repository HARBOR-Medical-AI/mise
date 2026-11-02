/**
 * @file `scripts`: the library's sources (docs/stratus.adoc, D17). `scripts`
 * lists them with where each clone stands; `scripts add <name> <repo>
 * [--folder <folder>]` names a repository and clones it; `scripts pull
 * [<name>]` brings the clones up to date, fast-forward only; `scripts remove
 * <name>` forgets one and removes its clone. The scripts themselves are read
 * at `/scripts/<name>/`, by `play` and by `ls`.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import type { CommandHelp } from '@fnndsc/brasa/core';
import { MINE, type GitAnswer, type ScriptLibrary, type ScriptSource } from '../scripts/library.js';
import { SCRIPTS_PREFIX } from '../vfs/scripts.js';
import { options_read } from './build.js';

/** What `scripts` reads from the session. */
export interface ScriptsCommandContext {
  readonly library: ScriptLibrary;
}

/** `scripts`'s usage. */
const SCRIPTS_USAGE: string = 'scripts | scripts add <name> <repo> [--folder <folder>] | scripts pull [<name>] | scripts remove <name>';

function scriptsList_run(context: ScriptsCommandContext): CommandEnvelope {
  const sources: ScriptSource[] = context.library.sources_list();
  if (sources.length === 0) return envelope_ok(`no sources: scripts add <name> <repo> [--folder <folder>] names a repository of scripts; ${SCRIPTS_PREFIX}/${MINE}/ is this host's own\n`);
  const lines: string[] = sources.map((source: ScriptSource): string => `${chalk.bold(source.name)}  ${source.repo}${source.folder !== undefined && source.folder !== '' ? `  ${source.folder}` : ''}  ${chalk.gray(context.library.head_read(source.name))}`);
  return envelope_ok(`${lines.join('\n')}\n${chalk.gray(`${MINE}  this host's own scripts`)}\n`);
}

function scriptsAdd_run(context: ScriptsCommandContext, args: ReadonlyArray<string>): CommandEnvelope {
  const read = options_read(args, ['--folder']);
  if ('error' in read) return envelope_error('', undefined, `scripts add: ${read.error} (--folder)\n`);
  const [name, repo, ...extra] = read.rest;
  if (name === undefined || repo === undefined || extra.length > 0) return envelope_error('', undefined, `scripts add: usage: ${SCRIPTS_USAGE}\n`);
  const folder: string | undefined = read.options.get('--folder');
  const added: GitAnswer = context.library.source_add({ name, repo, ...(folder !== undefined ? { folder } : {}) });
  return added.ok ? envelope_ok(`${added.text}; its scripts are at ${SCRIPTS_PREFIX}/${name}/\n`) : envelope_error('', undefined, `scripts add: ${added.text}\n`);
}

function scriptsPull_run(context: ScriptsCommandContext, args: ReadonlyArray<string>): CommandEnvelope {
  if (args.length > 1 || args.some((word: string): boolean => word.startsWith('-'))) return envelope_error('', undefined, `scripts pull: usage: ${SCRIPTS_USAGE}\n`);
  const names: string[] = args.length === 1 ? [args[0] as string] : context.library.sources_list().map((source: ScriptSource): string => source.name);
  if (names.length === 0) return envelope_ok('no sources to pull\n');
  const answers: GitAnswer[] = names.map((name: string): GitAnswer => context.library.source_pull(name));
  const text: string = `${answers.map((answer: GitAnswer): string => answer.ok ? answer.text : chalk.red(answer.text)).join('\n')}\n`;
  return answers.every((answer: GitAnswer): boolean => answer.ok) ? envelope_ok(text) : envelope_error('', undefined, text);
}

function scriptsRemove_run(context: ScriptsCommandContext, args: ReadonlyArray<string>): CommandEnvelope {
  const [name, ...extra] = args;
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, `scripts remove: usage: ${SCRIPTS_USAGE}\n`);
  const removed: GitAnswer = context.library.source_remove(name);
  return removed.ok ? envelope_ok(`${removed.text}\n`) : envelope_error('', undefined, `scripts remove: ${removed.text}\n`);
}

/**
 * `scripts`.
 *
 * @param context - The session.
 * @param args - The words after `scripts`.
 * @returns The envelope.
 */
export async function scripts_run(context: ScriptsCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb, ...rest] = args;
  switch (verb) {
    case undefined: return scriptsList_run(context);
    case 'add': return scriptsAdd_run(context, rest);
    case 'pull': return scriptsPull_run(context, rest);
    case 'remove': return scriptsRemove_run(context, rest);
    default: return envelope_error('', undefined, `scripts: ${verb}: not a verb (${SCRIPTS_USAGE})\n`);
  }
}

/** `scripts`'s help. */
export const SCRIPTS_HELP: CommandHelp = {
  usage: SCRIPTS_USAGE,
  summary: 'The library of scripts: git repositories mounted at /scripts',
  category: 'Workflows',
  description: 'A script (a .mise file) states what should exist; the library is where they are kept. Its sources are git repositories named by scripts add, each cloned under stratus\'s state on this host and shown at /scripts/<name>/ (the whole repository, or the folder --folder names), read-only: play /scripts/<name>/<file>.mise plays one, ls lists them, play --status says where each line stands. scripts pull brings a clone up to date (fast-forward only; a clone that is gone is cloned again); scripts remove forgets a source and removes its clone. /scripts/mine/ is this host\'s own folder, written to: a working copy a step edits lands there, and the way back into a repository is git, outside the session.',
  examples: ['scripts add chrisproject git@github.com:HARBOR-Medical-AI/infra.git --folder chrisproject', 'scripts', 'scripts pull', 'ls /scripts/chrisproject', 'play /scripts/chrisproject/store.mise --status'],
};
