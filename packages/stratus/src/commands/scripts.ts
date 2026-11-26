/**
 * @file `scripts`: the library's sources (docs/stratus.adoc, D17). `scripts`
 * lists them with where each clone stands; `scripts add <name> <repo>
 * [--folder <folder>]` names a repository and clones it; `scripts pull
 * [<name>]` brings the clones up to date, fast-forward only; `scripts remove
 * <name>` forgets one and removes its clone. The scripts themselves are read
 * at `/scripts/<name>/`, by `play` and by `ls`.
 *
 * Declared in one record (`scriptsCommand_make`): its line is parsed against
 * the grammar before anything here runs.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { command_declare, declaredCommand_run, hostDisk_refusal, type CommandArguments, type CommandDeclaration, type CommandGrammar } from '@fnndsc/brasa/core';
import { MINE, ScriptLibrary, type GitAnswer, type ScriptSource } from '../scripts/library.js';
import { SCRIPTS_PREFIX } from '../vfs/scripts.js';

/** What `scripts` reads from the session. */
export interface ScriptsCommandContext {
  readonly library: ScriptLibrary;
}

function scriptsList_run(context: ScriptsCommandContext): CommandEnvelope {
  const sources: ScriptSource[] = context.library.sources_list();
  if (sources.length === 0) return envelope_ok(`no sources: scripts add <name> <repo> [--folder <folder>] names a repository of scripts; ${SCRIPTS_PREFIX}/${MINE}/ is this host's own\n`);
  const lines: string[] = sources.map((source: ScriptSource): string => `${chalk.bold(source.name)}  ${source.repo}${source.folder !== undefined && source.folder !== '' ? `  ${source.folder}` : ''}  ${chalk.gray(context.library.head_read(source.name))}`);
  return envelope_ok(`${lines.join('\n')}\n${chalk.gray(`${MINE}  this host's own scripts`)}\n`);
}

/**
 * Whether git is to be held to network transports: so wherever the session's
 * host disk is nobody's. What `scripts.json` says a source's repository is
 * decides nothing by itself, since a clone pulls from its own configured
 * upstream; git is told, and refuses `file` and local helpers itself.
 *
 * @returns True without the files tier.
 */
function network_only(): boolean {
  return hostDisk_refusal('scripts') !== null;
}

function scriptsAdd_run(context: ScriptsCommandContext, name: string, repo: string, folder: string | undefined): CommandEnvelope {
  // A repository on this host's own disk is a place on that disk the operator chose to have read.
  const refused: string | null = ScriptLibrary.repo_isLocal(repo) ? hostDisk_refusal(`scripts add: ${repo} is a repository on the session's host`) : null;
  if (refused !== null) return envelope_error('', undefined, `${refused}\n`);
  const added: GitAnswer = context.library.source_add({ name, repo, ...(folder !== undefined ? { folder } : {}) }, network_only());
  return added.ok ? envelope_ok(`${added.text}; its scripts are at ${SCRIPTS_PREFIX}/${name}/\n`) : envelope_error('', undefined, `scripts add: ${added.text}\n`);
}

function scriptsPull_run(context: ScriptsCommandContext, named: string | undefined): CommandEnvelope {
  const names: string[] = named !== undefined ? [named] : context.library.sources_list().map((source: ScriptSource): string => source.name);
  if (names.length === 0) return envelope_ok('no sources to pull\n');
  const answers: GitAnswer[] = names.map((name: string): GitAnswer => {
    // A source kept from before, whose repository is on this host's disk, is read from that disk by a pull as by an add.
    const source: ScriptSource | null = context.library.source_read(name);
    const refused: string | null = source !== null && ScriptLibrary.repo_isLocal(source.repo) ? hostDisk_refusal(`scripts pull: ${name} is ${source.repo}, a repository on the session's host`) : null;
    return refused !== null ? { ok: false, text: refused } : context.library.source_pull(name, network_only());
  });
  const text: string = `${answers.map((answer: GitAnswer): string => answer.ok ? answer.text : chalk.red(answer.text)).join('\n')}\n`;
  return answers.every((answer: GitAnswer): boolean => answer.ok) ? envelope_ok(text) : envelope_error('', undefined, text);
}

function scriptsRemove_run(context: ScriptsCommandContext, name: string): CommandEnvelope {
  const removed: GitAnswer = context.library.source_remove(name);
  return removed.ok ? envelope_ok(`${removed.text}\n`) : envelope_error('', undefined, `scripts remove: ${removed.text}\n`);
}

/** What a `scripts` line may hold. */
const SCRIPTS_GRAMMAR = {
  bare: { summary: 'List the sources and where each clone stands' },
  subcommands: {
    add: {
      summary: 'Name a repository of scripts and clone it',
      operands: [
        { name: 'name', kind: 'word', summary: 'The source\'s name: its scripts are at /scripts/<name>/' },
        { name: 'repo', kind: 'word', summary: 'The git repository' },
      ],
      options: { folder: { long: 'folder', summary: 'Only this folder of the repository', value: { name: 'folder', kind: 'word' } } },
    },
    pull: { summary: 'Bring the clones up to date, fast-forward only', operands: [{ name: 'name', kind: 'word', optional: true, summary: 'One source; none, every one' }] },
    remove: { summary: 'Forget a source and remove its clone', operands: [{ name: 'name', kind: 'word', summary: 'The source' }] },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `scripts` line.
 *
 * @param context - The session.
 * @param args - The line, parsed.
 * @returns The envelope.
 */
async function scriptsLine_run(context: ScriptsCommandContext, args: CommandArguments<typeof SCRIPTS_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null: return scriptsList_run(context);
    case 'add': return scriptsAdd_run(context, args.operands.name, args.operands.repo, args.options.folder);
    case 'pull': return scriptsPull_run(context, args.operands.name);
    case 'remove': return scriptsRemove_run(context, args.operands.name);
  }
}

/**
 * `scripts`: the declaration, over the session's library.
 *
 * @param context - The session.
 * @returns The declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [scriptsCommand_make({ library })] }, 'backend');
 * ```
 */
export function scriptsCommand_make(context: ScriptsCommandContext): CommandDeclaration<typeof SCRIPTS_GRAMMAR> {
  return command_declare({
    name: 'scripts',
    grammar: SCRIPTS_GRAMMAR,
    help: {
      summary: 'The library of scripts: git repositories mounted at /scripts',
      category: 'Workflows',
      description: 'A script (a .mise file) states what should exist; the library is where they are kept. Its sources are git repositories named by scripts add, each cloned under stratus\'s state on this host and shown at /scripts/<name>/ (the whole repository, or the folder --folder names), read-only: play /scripts/<name>/<file>.mise plays one, ls lists them, play --status says where each line stands. scripts pull brings a clone up to date (fast-forward only; a clone that is gone is cloned again); scripts remove forgets a source and removes its clone. /scripts/mine/ is this host\'s own folder, written to: a working copy a step edits lands there, and the way back into a repository is git, outside the session.',
      examples: ['scripts add chrisproject git@github.com:HARBOR-Medical-AI/infra.git --folder chrisproject', 'scripts', 'scripts pull', 'ls /scripts/chrisproject', 'play /scripts/chrisproject/store.mise --status'],
    },
    handler: (args): Promise<CommandEnvelope> => scriptsLine_run(context, args),
  });
}

/**
 * `scripts` over words already split: the declaration's parse and handler.
 *
 * @param context - The session.
 * @param args - The words after `scripts`.
 * @returns The envelope, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await scripts_run(context, ['pull']);
 * ```
 */
export async function scripts_run(context: ScriptsCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  return declaredCommand_run(scriptsCommand_make(context), [...args]);
}
