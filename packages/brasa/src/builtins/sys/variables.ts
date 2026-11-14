/**
 * @file `set` and `unset`: the session's variables, seen and cleared.
 *
 * Bare `set` lists every variable in scope with what it holds; `set A` shows
 * A's answer whole, as JSON, and answers with A's own model, so it can be
 * captured again. `unset` removes names; a manifest's parameter and the
 * session's built-ins refuse by name. POSIX `set`'s options and positional
 * parameters are not here, and an option is refused by name. Declared in
 * one record each (`setCommand`, `unsetCommand`): a name is a `variable`,
 * checked before the handler runs, and completes from the session's.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { reference_isReserved } from '../../core/expansion.js';
import { answer_read, TEXT_KIND, variable_get, variable_unset, variables_list, type FieldReading, type Variable } from '../../core/variables.js';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The model kind `set` lists under. */
export const VARIABLES_MODEL_KIND: string = 'variables.list';

/** One variable as `set` lists it. */
export interface VariableListing {
  name: string;
  kind: string;
  source: string;
  readOnly: boolean;
  summary: string;
}

/** How long a summary may run before it is cut, with how much it left out said. */
const SUMMARY_MAX: number = 60;

/**
 * One line saying what a variable holds.
 *
 * @param name - Its name.
 * @param variable - It.
 * @returns The summary.
 */
function variableSummary_render(name: string, variable: Variable): string {
  const reading: FieldReading = answer_read(variable.answer, name, []);
  if ('refused' in reading) return reading.refused.replace(`${name} `, '');
  const shown: string = reading.values.join(' ');
  const count: string = reading.values.length === 1 ? '' : ` (${reading.values.length} operands)`;
  return shown.length > SUMMARY_MAX ? `${shown.slice(0, SUMMARY_MAX)}…${count === '' ? ` (${shown.length} characters)` : count}` : `${shown}${count}`;
}

/** What a `set` line may hold. */
const SET_GRAMMAR = {
  operands: [
    { name: 'name', kind: 'variable', optional: true, summary: 'The variable to show whole; bare, every variable is listed' },
  ],
} as const satisfies CommandGrammar;

/** What an `unset` line may hold. */
const UNSET_GRAMMAR = {
  operands: [
    { name: 'name', kind: 'variable', repeat: true, summary: 'The variables to remove' },
  ],
} as const satisfies CommandGrammar;

/**
 * `set [NAME]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [setCommand] });
 * ```
 */
export const setCommand = command_declare({
  name: 'set',
  grammar: SET_GRAMMAR,
  help: {
    summary: 'List the variables, or show one',
    description: 'Bare, lists every variable in scope: its name, the kind of answer it holds, and what it expands to; a manifest\'s parameters are marked read-only. With a name, shows that variable\'s answer whole (JSON for a model) and answers with it, so it can be captured again. A variable is set by a line of its own: NAME=$(command) holds what the command answered (its model, or the text it printed when it has none), NAME=word holds one word. ${NAME} expands to its rows; ${NAME.field} to a field of its model. See help variables.',
    category: 'General',
    posix: { group: 'System', differs: 'lists and shows variables only: no options, no positional parameters; a variable holds a command\'s typed answer' },
    examples: ['set', 'set A', 'A=$(ls ~/uploads)', 'LABEL=\'sag cohort\''],
  },
  handler: async (args: CommandArguments<typeof SET_GRAMMAR>): Promise<CommandEnvelope> => set_run(args.operands.name),
});

/**
 * `unset NAME…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [unsetCommand] });
 * ```
 */
export const unsetCommand = command_declare({
  name: 'unset',
  grammar: UNSET_GRAMMAR,
  help: {
    summary: 'Remove variables',
    description: 'Removes each named variable from the scope the line runs in. Quiet when it removes, as unset is. A manifest\'s parameter and the session\'s own names (cwd, listing, gather) are read-only and refuse by name.',
    category: 'General',
    posix: { group: 'System', differs: 'removes session variables; a manifest\'s parameters and the session\'s built-ins refuse' },
    examples: ['unset A', 'unset A B'],
  },
  handler: async (args: CommandArguments<typeof UNSET_GRAMMAR>): Promise<CommandEnvelope> => unset_run(args.operands.name),
});

/**
 * `set` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `set`.
 * @returns The listing, the variable's own answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_set(['A']);
 * ```
 */
export async function builtin_set(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(setCommand, args);
}

/**
 * `unset` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `unset`.
 * @returns Quiet on success, a line per name it would not remove, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_unset(['A', 'B']);
 * ```
 */
export async function builtin_unset(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(unsetCommand, args);
}

/**
 * Lists the variables in scope, or shows one whole.
 *
 * @param name - The variable to show, or undefined to list them all.
 * @returns The listing, or the variable's own answer.
 *
 * @example
 * ```ts
 * await set_run(undefined);
 * ```
 */
export async function set_run(name: string | undefined): Promise<CommandEnvelope> {
  if (name !== undefined) {
    const variable: Variable | undefined = variable_get(name);
    if (variable === undefined) {
      exitCode_set(1);
      return envelope_error('', undefined, `set: ${name}: no such variable\n`);
    }
    const body: string = variable.answer.kind === TEXT_KIND
      ? String(variable.answer.data)
      : JSON.stringify(variable.answer.data, null, 2);
    const head: string = chalk.gray(`${name}  ${variable.answer.kind}  from: ${variable.answer.source}${variable.readOnly ? '  (read-only)' : ''}`);
    return envelope_ok(`${head}\n${body}\n`, { kind: variable.answer.kind, data: variable.answer.data });
  }

  const listed: VariableListing[] = variables_list().map((variable: { name: string } & Variable): VariableListing => ({
    name: variable.name,
    kind: variable.answer.kind,
    source: variable.answer.source,
    readOnly: variable.readOnly,
    summary: variableSummary_render(variable.name, variable),
  }));
  if (listed.length === 0) return envelope_ok(`${chalk.gray('no variables set; NAME=$(command) or NAME=word sets one')}\n`, { kind: VARIABLES_MODEL_KIND, data: listed });
  const width: number = Math.max(...listed.map((one: VariableListing): number => one.name.length));
  const kindWidth: number = Math.max(...listed.map((one: VariableListing): number => one.kind.length));
  const lines: string[] = listed.map((one: VariableListing): string =>
    `${chalk.bold(one.name.padEnd(width))}  ${chalk.cyan(one.kind.padEnd(kindWidth))}  ${one.summary}${one.readOnly ? chalk.gray('  (read-only)') : ''}`);
  return envelope_ok(`${lines.join('\n')}\n`, { kind: VARIABLES_MODEL_KIND, data: listed });
}

/**
 * Removes variables, each in turn.
 *
 * @param names - The variables to remove.
 * @returns Quiet on success, as unset is; a line per name it would not remove.
 *
 * @example
 * ```ts
 * await unset_run(['A']);
 * ```
 */
export async function unset_run(names: readonly string[]): Promise<CommandEnvelope> {
  const complaints: string[] = [];
  for (const name of names) {
    if (reference_isReserved(name)) { complaints.push(`unset: \${${name}} is the session's own; it is read-only`); continue; }
    const refused: string | null = variable_unset(name);
    if (refused !== null) complaints.push(`unset: ${refused}`);
  }
  if (complaints.length > 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${complaints.join('\n')}\n`);
  }
  return envelope_ok('');
}
