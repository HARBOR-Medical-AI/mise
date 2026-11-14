/**
 * @file Builtin version.
 * Reports the mise stack versions (the chell surface, the brasa engine, its
 * chili/salsa/cumin layers, and the calypso sibling surface) as a command
 * envelope — the in-shell counterpart of `chell --version`. Declared in one
 * record (`versionCommand`).
 *
 * @module
 */
import { versionReport_build, versions_get, type StackVersions } from '../../core/version.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What a `version` line may hold: nothing. */
const VERSION_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `version`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [versionCommand] });
 * ```
 */
export const versionCommand = command_declare({
  name: 'version',
  grammar: VERSION_GRAMMAR,
  help: {
    summary: 'Report the versions of the mise stack layers running this session',
    description: 'Report the versions of the mise stack layers running this session',
    category: 'General',
    examples: ['version'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => version_run(),
});

/**
 * Reports the version of chell and the brasa engine, its layers, and the
 * calypso sibling surface it runs with — the same report as `chell --version`,
 * available from inside the shell.
 *
 * @returns An envelope carrying the multi-line version report and a typed model
 *   of each layer's version.
 *
 * @example
 * ```ts
 * (await version_run()).model?.kind; // 'sys.version'
 * ```
 */
export async function version_run(): Promise<CommandEnvelope> {
  const versions: StackVersions = versions_get();
  return envelope_ok(`${versionReport_build()}\n`, {
    kind: 'sys.version',
    data: versions,
  });
}

/**
 * `version` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `version` (none).
 * @returns The report, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_version([]);
 * ```
 */
export async function builtin_version(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(versionCommand, args);
}
