/**
 * @file A declared command as tools: one JSON Schema per command and per
 * subcommand, whose properties are the operands and options the grammar
 * declares, each typed by its kind. A pure function of the declaration, so
 * what an assistant may call is exactly what the shell parses.
 *
 * Key components:
 * - CommandTool: one tool, its name, description and input schema.
 * - commandTools_derive: the tools of a declaration.
 *
 * Typical usage:
 * ```ts
 * const tools: CommandTool[] = commandTools_derive(berthCommand);
 * tools.map((tool) => tool.name); // ['berth', 'berth_anchor', 'berth_close', 'berth_drop', 'berth_clear']
 * ```
 *
 * Dependencies: zod, which writes the JSON Schema; the argument kinds, which
 * give each value's schema.
 *
 * @module
 */
import { z } from 'zod';

import { argumentKind_get, type ArgumentKind } from './argumentKinds.js';
import type {
  ArgumentGrammar, CommandDeclaration, CommandGrammar, OperandGrammar, OptionGrammar, OptionsGrammar, SubcommandGrammar,
} from './commandDeclaration.js';

/**
 * One tool: a command, or one of its subcommands, as an assistant calls it.
 *
 * @example
 * ```ts
 * const tool: CommandTool = { name: 'ls', description: 'List directory contents', inputSchema: { type: 'object' } };
 * ```
 */
export interface CommandTool {
  /** The command's name, and the subcommand's after an underscore (`berth_anchor`). */
  readonly name: string;
  /** What it does: the command's summary, or the subcommand's. */
  readonly description: string;
  /** The JSON Schema of its input: an object of its operands and options. */
  readonly inputSchema: Record<string, unknown>;
}

/** What one stretch of a line holds, for its schema. */
interface ToolGrammar {
  /** Its operands. */
  readonly operands: readonly OperandGrammar[];
  /** Its options, the subcommand's then the command's. */
  readonly options: OptionsGrammar;
}

/**
 * The schema of one argument's value, by its kind.
 *
 * @param argument - The argument.
 * @param summary - What it is, for the schema's description.
 * @returns The schema.
 * @throws {Error} For a kind no one registered.
 */
function argument_schema(argument: ArgumentGrammar, summary: string): z.ZodType {
  const kind: ArgumentKind | null = argumentKind_get(argument.kind);
  if (kind === null) throw new Error(`no argument kind ${argument.kind}`);
  return kind.schema_make(argument).describe(summary);
}

/**
 * The input schema of one stretch: each operand (a list when it repeats,
 * required unless optional) and each option (a switch a boolean, a value
 * option its value or its list of values), all as properties of one object.
 *
 * @param grammar - The stretch.
 * @returns The zod object.
 * @throws {Error} For an operand and an option of one name.
 */
function toolInput_make(grammar: ToolGrammar): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const operand of grammar.operands) {
    const value: z.ZodType = argument_schema(operand, operand.summary);
    const schema: z.ZodType = operand.repeat === true
      ? z.array(value).min(operand.optional === true ? 0 : 1).describe(operand.summary)
      : value;
    shape[operand.name] = operand.optional === true ? schema.optional() : schema;
  }
  for (const [key, option] of Object.entries(grammar.options)) {
    if (Object.hasOwn(shape, key)) throw new Error(`${key} names an operand and an option`);
    shape[key] = optionValue_schema(option).optional();
  }
  return z.object(shape).strict();
}

/**
 * One option's value schema: a boolean for a switch, else its value's kind,
 * a list of them when it repeats.
 *
 * @param option - The option.
 * @returns The schema.
 */
function optionValue_schema(option: OptionGrammar): z.ZodType {
  // A family is every name it matches, each with its value or true.
  if (option.family !== undefined) {
    return z.array(z.object({ name: z.string().regex(option.family.pattern), value: z.union([z.string(), z.literal(true)]) }).strict()).describe(option.summary);
  }
  if (option.value === undefined) return z.boolean().describe(option.summary);
  const value: z.ZodType = argument_schema(option.value, option.summary);
  if (option.repeat === true) return z.array(value).describe(option.summary);
  // One that asks takes null for "ask me".
  return option.asks === true ? value.nullable() : value;
}

/**
 * One tool, its schema written by zod.
 *
 * @param name - The tool's name.
 * @param description - What it does.
 * @param grammar - Its stretch of the line.
 * @returns The tool.
 */
function tool_make(name: string, description: string, grammar: ToolGrammar): CommandTool {
  return { name, description, inputSchema: z.toJSONSchema(toolInput_make(grammar)) as Record<string, unknown> };
}

/**
 * A declared command's tools: the command itself (when it runs bare, or
 * has no subcommands), and each subcommand, with the command's options
 * beside the subcommand's own.
 *
 * @param declaration - The command.
 * @returns The tools, the bare command's first.
 * @throws {Error} For a kind no one registered, or an operand and an option of one name.
 *
 * @example
 * ```ts
 * commandTools_derive(lsCommand)[0]?.inputSchema; // { type: 'object', properties: { paths: …, long: … }, … }
 * ```
 */
export function commandTools_derive(declaration: CommandDeclaration): CommandTool[] {
  const grammar: CommandGrammar = declaration.grammar;
  const own: OptionsGrammar = grammar.options ?? {};
  const tools: CommandTool[] = [];
  if (grammar.subcommands === undefined || grammar.bare !== undefined) {
    const description: string = grammar.subcommands === undefined ? declaration.help.summary : (grammar.bare?.summary ?? declaration.help.summary);
    tools.push(tool_make(declaration.name, description, { operands: grammar.operands ?? [], options: { ...own, ...(grammar.bare?.options ?? {}) } }));
  }
  for (const [word, sub] of Object.entries(grammar.subcommands ?? {}) as Array<[string, SubcommandGrammar]>) {
    tools.push(tool_make(`${declaration.name}_${word}`, sub.summary, { operands: sub.operands ?? [], options: { ...own, ...(sub.options ?? {}) } }));
  }
  return tools;
}
