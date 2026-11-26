/**
 * @file The declaration of a `/bin` line: a plugin's or a pipeline's, made
 * from what CUBE declares of it, so the line is parsed, completed, refused
 * and described as a builtin's is.
 *
 * CUBE owns a plugin's parameters and a pipeline's nodes; nothing here
 * declares them a second time. A plugin's declaration is made from its
 * parameters (flag, short flag, type, optional, default, help): a `bool`
 * parameter is a switch, `int` and `float` are numbers, `path` and
 * `unextpath` are CFS paths, anything else a word. A pipeline's is made
 * from its manifest: one `--<node>.<field>` option for every field of every
 * node, the node named by its title when that is unique and shell-safe and
 * always by `@<piping id>`. Beside them stand the session's own options of
 * a `/bin` line (`--detach`, `--parameters`, `--diagram`, …), which win a
 * name both claim; a plugin line's run fields (`--title`, `--compute`,
 * `--cpu_limit`, …), which CUBE takes beside the parameters and a parameter
 * of the same name wins; and the operands: the line's input paths, which glob.
 *
 * A declaration is made when the session first needs it and kept, by the
 * `/bin` entry it is made for: a plugin's carries its version
 * (`pl-dircopy-v2.1.1`), a pipeline's its id in this CUBE
 * (`PHI_detection_id12`), so a new version or a new registration is a new
 * declaration.
 *
 * A plugin's line ends, after a lone `--`, with the run's own `key=value`
 * context (`-- feed_title="T"`), which the line keeps apart before it is
 * parsed.
 *
 * Key components:
 * - pluginDeclaration_make / pipelineDeclaration_make: the pure builders.
 * - binDeclaration_get: the declaration of a word `/bin` answers, kept once made.
 * - pluginLine_parse / pipelineLine_parse: a line's words to its typed reading.
 *
 * Typical usage:
 * ```ts
 * const declaration: CommandDeclaration | null = await binDeclaration_get('pl-dircopy');
 * const parsed: PluginLineParse = await pluginLine_parse('pl-dircopy-v2.1.1', ['~/uploads', '--', 'feed_title=T']);
 * ```
 *
 * Dependencies: the parser and the declaration types; CUBE through cumin and
 * salsa (loaded when a declaration is made); `/bin` for which entry a word names.
 *
 * @module
 */
import { identityChange_listen, identityPartition_make } from '@fnndsc/cumin/identity-epoch';
import type { PipelineManifest, PipelineManifestNode } from '@fnndsc/salsa';
import type { CommandEnvelope } from '@fnndsc/menu';

import type {
  CommandArguments, CommandDeclaration, CommandGrammar, OperandGrammar, OptionGrammar, OptionValueGrammar,
} from '../core/commandDeclaration.js';
import { commandLine_parse, lineWords_read, type LineParse, type ParsedArguments } from '../core/commandParse.js';
import type { ShellWord } from '../lib/parser.js';

/** One parameter of a plugin, as CUBE declares it. */
export interface PluginParameterSpec {
  /** Its name, as CUBE stores it. */
  readonly name: string;
  /** Its type: `str`, `int`, `float`, `bool`, `path`, `unextpath` (or their long spellings). */
  readonly type: string;
  /** Whether a run may leave it out. */
  readonly optional: boolean;
  /** Its default, when it declares one. */
  readonly default?: unknown;
  /** One line of help. */
  readonly help?: string;
  /** Its flag as typed: `--dir`. */
  readonly flag: string;
  /** Its one-letter flag, when it has one: `-d`. */
  readonly shortFlag?: string;
}

/** One plugin version, as its declaration is made from it. */
export interface PluginSpec {
  /** The plugin's name. */
  readonly name: string;
  /** Its version. */
  readonly version: string;
  /** Its kind: `ds`, `fs` or `ts`. */
  readonly kind: string;
  /** Its title, when it has one. */
  readonly title?: string;
  /** What it does, when it says. */
  readonly description?: string;
  /** Every parameter, in CUBE's order. */
  readonly parameters: readonly PluginParameterSpec[];
}

/** A plugin line, read: its input, its parameters, its context, and what the session does with it. */
export interface PluginLine {
  /** The operand words, as typed: paths, `as <subject>`, and any bare `key=value`. */
  readonly operands: readonly string[];
  /** The plugin's parameters given, by flag name (`dir`), each its value. */
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  /** The run's own fields given, by the field CUBE's plugin instance takes (`title`, `compute_resource_name`, `cpu_limit`). */
  readonly run: Readonly<Record<string, string | number>>;
  /** The run's context words, after a lone `--` (`feed_title=T`). */
  readonly context: readonly string[];
  /** Return the run's handle at once rather than wait for it. */
  readonly detach: boolean;
  /** A look at the plugin instead of a run: its parameters, its README, or its raw README. */
  readonly inspect: 'parameters' | 'readme' | 'readmeRaw' | null;
}

/** What reading a plugin line came to. */
export type PluginLineParse =
  | { readonly ok: true; readonly line: PluginLine }
  | { readonly ok: false; readonly refusal: string };

/** The ways a pipeline line asks to look at the pipeline rather than run it. */
export type PipelineLook = 'diagram' | 'signalflow' | 'manifest' | 'nodes' | 'source' | 'help';

/** One override of a pipeline node, as `pipeline run` takes it. */
export interface PipelineLineBinding {
  /** The node: its title, or `@<piping id>`. */
  readonly node: string;
  /** The field: a parameter or an execution control. */
  readonly field: string;
  /** The value. */
  readonly value: unknown;
}

/** A pipeline line, read. */
export interface PipelineLine {
  /** The operand words: the input paths, as typed. */
  readonly operands: readonly string[];
  /** A look at the pipeline instead of a run, or null for a run. */
  readonly look: PipelineLook | null;
  /** Draw the diagram with each node's stored arguments. */
  readonly withArguments: boolean;
  /** Draw the diagram as SignalFlow YAML. */
  readonly signalflow: boolean;
  /** The compute resource every node runs on, when given. */
  readonly compute?: string;
  /** The instance the run attaches to, when given. */
  readonly previous?: number;
  /** A CFS file of overrides, when given. */
  readonly paramFile?: string;
  /** The node overrides given. */
  readonly bindings: readonly PipelineLineBinding[];
  /** Return the run's handles at once. */
  readonly detach: boolean;
  /** Echo every parameter of every piping. */
  readonly verbose: boolean;
}

/** What reading a pipeline line came to. */
export type PipelineLineParse =
  | { readonly ok: true; readonly line: PipelineLine }
  | { readonly ok: false; readonly refusal: string };

/** The `/bin` entry a word names: a plugin version, or a pipeline. */
export type BinEntry =
  | { readonly kind: 'plugin'; readonly executable: string }
  | { readonly kind: 'pipeline'; readonly name: string };

/** The operand every `/bin` line takes: its input. */
const INPUT_OPERAND: OperandGrammar = {
  name: 'input',
  kind: 'cfsPath',
  optional: true,
  repeat: true,
  glob: true,
  summary: 'The input: a directory (several: one run each), or files, `as <subject>` naming the files before it; none, where you stand',
};

/** The session's own options of a plugin line: they win a name a parameter also claims. */
const PLUGIN_SESSION_OPTIONS: Readonly<Record<string, OptionGrammar>> = {
  detach: { long: 'detach', summary: 'Return the run at once, without waiting for it to settle' },
  parameters: { long: 'parameters', summary: 'Show the parameters this version declares, and run nothing' },
  readme: { long: 'readme', summary: "Show the plugin's README, and run nothing" },
  raw: { long: 'raw', summary: 'With --readme, the README as markdown, for a pipe' },
  help: { short: 'h', long: 'help', summary: 'Show this page' },
};

/** The session's own options of a pipeline line. */
const PIPELINE_SESSION_OPTIONS: Readonly<Record<string, OptionGrammar>> = {
  diagram: { long: 'diagram', summary: "Draw the pipeline's shallow topology, and run nothing" },
  withargs: { long: 'withargs', summary: "With --diagram, each node's stored arguments inline" },
  signalflow: { long: 'signalflow', summary: 'Emit SignalFlow YAML, and run nothing' },
  manifest: { long: 'manifest', summary: 'Emit the complete registered invocation YAML, and run nothing' },
  nodes: { long: 'nodes', summary: 'Show the nodes and their parameters, and run nothing' },
  parameters: { long: 'parameters', summary: 'As --nodes' },
  source: { long: 'source', summary: 'Show the pipeline YAML source, and run nothing' },
  readme: { long: 'readme', summary: 'As --source' },
  compute: { long: 'compute', summary: 'Run every node on this compute resource', value: { name: 'resource', kind: 'compute' } },
  previous: { long: 'previous', summary: 'Attach to this plugin instance instead of the operand or where you stand', value: { name: 'instance', kind: 'int', min: 1 } },
  paramFile: { long: 'paramFile', summary: 'Apply one sparse YAML invocation overlay, a CFS file', value: { name: 'file', kind: 'cfsPath' } },
  detach: { long: 'detach', summary: 'Return the run at once, without waiting for it to settle' },
  verbose: { long: 'verbose', summary: 'Echo every parameter of every piping before the run' },
  help: { short: 'h', long: 'help', summary: 'Show this page' },
};

/** One execution control of a run: the field CUBE's plugin instance takes, and its value. */
interface ExecutionField {
  /** The field, as CUBE names it. */
  readonly field: string;
  /** Its value: the kind, and the bounds of a number. */
  readonly value: OptionValueGrammar;
  /** What it sets, for help: `CPU limit`. */
  readonly summary: string;
}

/**
 * The execution controls a run takes beside its plugin's parameters, as
 * CUBE's plugin instance names them: every pipeline node's, and a plugin
 * line's.
 */
const EXECUTION_FIELDS: readonly ExecutionField[] = [
  { field: 'compute_resource_name', value: { name: 'resource', kind: 'compute' }, summary: 'compute resource' },
  { field: 'cpu_limit', value: { name: 'millicores', kind: 'cpu' }, summary: 'CPU limit (2000m, or 2000 millicores)' },
  { field: 'memory_limit', value: { name: 'size', kind: 'memory' }, summary: 'memory limit (512Mi, 8Gi, or MiB)' },
  { field: 'gpu_limit', value: { name: 'gpus', kind: 'int', min: 0 }, summary: 'number of GPUs' },
  { field: 'number_of_workers', value: { name: 'workers', kind: 'int', min: 1 }, summary: 'number of workers' },
];

/** A plugin line's option for one field of its run, and the field it is posted as. */
interface RunOption {
  /** The field of CUBE's plugin instance the value is posted as. */
  readonly field: string;
  /** The option. */
  readonly option: OptionGrammar;
}

/**
 * The run's own fields a plugin line takes, by property: its title and its
 * execution controls, which CUBE's plugin-instance create reads from the
 * same request as the plugin's parameters, each by its field's name
 * (`--title`, `--cpu_limit`). `--compute` is `--compute_resource_name` as
 * `pipeline run` spells it; given both, `--compute_resource_name` counts. A
 * parameter of the plugin's that claims a name wins it, and its value goes
 * to CUBE under that name, as a parameter.
 */
const PLUGIN_RUN_OPTIONS: Readonly<Record<string, RunOption>> = {
  'run.title': { field: 'title', option: { long: 'title', summary: "The run's title, as its node shows it", value: { name: 'title', kind: 'word' } } },
  'run.compute': { field: 'compute_resource_name', option: { long: 'compute', summary: 'Run on this compute resource (as --compute_resource_name)', value: { name: 'resource', kind: 'compute' } } },
  ...Object.fromEntries(EXECUTION_FIELDS.map((control: ExecutionField): [string, RunOption] => [
    `run.${control.field}`,
    { field: control.field, option: { long: control.field, summary: `The run's ${control.summary}`, value: control.value } },
  ])),
};

/** A node title usable as a selector: one shell word, no dot. */
const SELECTOR_WORD: RegExp = /^[A-Za-z0-9_-]+$/;

/**
 * The value a CUBE parameter type takes, or none for a switch.
 *
 * @param type - The type as CUBE serves it.
 * @param name - The word usage shows for the value.
 * @returns The value's grammar, or undefined for `bool`.
 */
function parameterValue_make(type: string, name: string): OptionValueGrammar | undefined {
  switch (type) {
    case 'bool': case 'boolean': return undefined;
    case 'int': case 'integer': return { name, kind: 'int' };
    case 'float': case 'number': return { name, kind: 'number' };
    case 'path': case 'unextpath': return { name, kind: 'cfsPath' };
    default: return { name, kind: 'word' };
  }
}

/**
 * A parameter's summary: its help, its default, and whether it is required.
 *
 * @param parameter - The parameter.
 * @returns The line.
 */
function parameterSummary_make(parameter: PluginParameterSpec): string {
  const shown: string = parameter.default === undefined || parameter.default === null || parameter.default === '' ? '' : ` (default ${String(parameter.default)})`;
  return `${parameter.help ?? parameter.name}${shown}${parameter.optional ? '' : ' (required)'}`;
}

/**
 * The long name a parameter's flag gives, without the dashes: `--dir` is
 * `dir`; a flag of one dash and one letter has none.
 *
 * @param parameter - The parameter.
 * @returns The long name, or undefined.
 */
function parameterLong_read(parameter: PluginParameterSpec): string | undefined {
  if (parameter.flag.startsWith('--') && parameter.flag.length > 2) return parameter.flag.slice(2);
  if (/^-[A-Za-z0-9]$/.test(parameter.flag)) return undefined;
  return parameter.flag === '' ? parameter.name : parameter.flag.replace(/^-+/, '');
}

/**
 * The one-letter name a parameter answers to, without the dash.
 *
 * @param parameter - The parameter.
 * @returns The letter, or undefined.
 */
function parameterShort_read(parameter: PluginParameterSpec): string | undefined {
  for (const flag of [parameter.shortFlag, parameter.flag]) {
    if (flag !== undefined && /^-[A-Za-z0-9]$/.test(flag)) return flag.slice(1);
  }
  return undefined;
}

/**
 * The options of a plugin's line: the session's, then one per parameter
 * whose names the session's options leave free, by its flag's long name,
 * then the run's own fields whose names both leave free.
 *
 * @param parameters - The plugin's parameters.
 * @returns The options, by property.
 */
function pluginOptions_make(parameters: readonly PluginParameterSpec[]): Record<string, OptionGrammar> {
  const options: Record<string, OptionGrammar> = { ...PLUGIN_SESSION_OPTIONS };
  const longs: Set<string> = new Set(Object.values(options).flatMap((option: OptionGrammar): string[] => (option.long === undefined ? [] : [option.long])));
  const shorts: Set<string> = new Set(Object.values(options).flatMap((option: OptionGrammar): string[] => (option.short === undefined ? [] : [option.short])));
  for (const parameter of parameters) {
    const long: string | undefined = parameterLong_read(parameter);
    const short: string | undefined = parameterShort_read(parameter);
    const key: string = long ?? parameter.name;
    if ((long !== undefined && longs.has(long)) || Object.hasOwn(options, key)) continue;
    const usableShort: string | undefined = short !== undefined && !shorts.has(short) ? short : undefined;
    if (long === undefined && usableShort === undefined) continue;
    const value: OptionValueGrammar | undefined = parameterValue_make(parameter.type, parameter.name);
    options[key] = {
      ...(usableShort !== undefined ? { short: usableShort } : {}),
      ...(long !== undefined ? { long } : {}),
      summary: parameterSummary_make(parameter),
      ...(value !== undefined ? { value } : {}),
    };
    if (long !== undefined) longs.add(long);
    if (usableShort !== undefined) shorts.add(usableShort);
  }
  // The run's own fields, where the session's options and the parameters leave the name free.
  for (const [key, run] of Object.entries(PLUGIN_RUN_OPTIONS)) {
    if (run.option.long !== undefined && longs.has(run.option.long)) continue;
    options[key] = run.option;
  }
  return options;
}

/**
 * A plugin version's declaration, made from what CUBE declares of it: its
 * `/bin` entry's name, its input operand, the session's options and one per
 * parameter, and help from its title and description.
 *
 * @param spec - The plugin version.
 * @param handler - What runs a parsed line (the run, or a test's stand-in).
 * @returns The declaration.
 *
 * @example
 * ```ts
 * const declaration = pluginDeclaration_make({ name: 'pl-dircopy', version: '2.1.1', kind: 'fs', parameters: [{ name: 'dir', type: 'path', optional: false, flag: '--dir' }] }, run);
 * declaration.grammar.options?.['dir']?.value?.kind; // 'cfsPath'
 * ```
 */
export function pluginDeclaration_make(spec: PluginSpec, handler: (args: CommandArguments<CommandGrammar>) => Promise<CommandEnvelope>): CommandDeclaration {
  const name: string = `${spec.name}-v${spec.version}`;
  const fs: string = spec.kind === 'fs' ? ' To an fs plugin every operand is its dir, untranslated.' : '';
  return {
    name,
    grammar: { operands: [INPUT_OPERAND], options: pluginOptions_make(spec.parameters) },
    help: {
      summary: spec.title ?? `The CUBE plugin ${spec.name}, version ${spec.version}`,
      description: `${spec.description ?? `Run ${spec.name} ${spec.version}, a CUBE ${spec.kind} plugin.`} A run stands where you are, or on its operands, first on the line: a directory is the input (in a feed, that node; outside one, pl-dircopy roots a new feed of it), several directories are one run each, and files are shaped into subjects, each file its own named by its stem or the files before \`as <name>\` one.${fs} --title, --compute and the limits set the run's own fields, as CUBE names them. After a lone --, key=value words set the run's context (feed_title). help operands gives the full rules; whatif <line> prints a run and starts nothing.`,
      category: 'Resources',
      examples: [
        `${name} ~/uploads/subjects`, `${name} ~/uploads/t1.nii as sub-01`, `${name} ~/uploads/subjects --title "T1 run" --compute host --memory_limit 8Gi`,
        `${name} --parameters`, `${name} --readme --raw | glow -`, `${name} -- feed_title="Brain MRI"`,
      ],
    },
    holds: [],
    handler,
  };
}

/**
 * The node selectors of a pipeline: each node's title when that is unique
 * and one shell word, and always `@<piping id>`.
 *
 * @param manifest - The pipeline's manifest.
 * @param node - One node.
 * @returns Its selectors.
 */
function nodeSelectors_list(manifest: PipelineManifest, node: PipelineManifestNode): string[] {
  const unique: boolean = SELECTOR_WORD.test(node.title) && manifest.nodes.filter((other: PipelineManifestNode): boolean => other.title === node.title).length === 1;
  return unique ? [node.title, `@${node.pipingID}`] : [`@${node.pipingID}`];
}

/**
 * The fields a pipeline node takes: its execution controls, then its
 * plugin's parameters (but `plugininstances`, the edges CUBE draws itself).
 *
 * @param node - The node.
 * @returns Each field's name, kind and summary.
 */
function nodeFields_list(node: PipelineManifestNode): Array<{ name: string; value: OptionValueGrammar | undefined; summary: string }> {
  const controls = EXECUTION_FIELDS.map((control: ExecutionField) => ({
    name: control.field,
    value: { ...control.value, name: control.field },
    summary: `${node.title} (${node.pluginName}): its ${control.summary}`,
  }));
  const parameters = (node.parameterDefinitions ?? [])
    .filter((parameter): boolean => parameter.name !== 'plugininstances')
    .map((parameter) => ({
      name: parameter.name,
      value: parameterValue_make(parameter.type, parameter.name),
      summary: `${node.title} (${node.pluginName}): ${parameter.help ?? parameter.name}`,
    }));
  return [...controls, ...parameters];
}

/**
 * A pipeline's declaration, made from its manifest: its `/bin` entry's
 * name, its input operand, the session's options and one `--<node>.<field>`
 * option for every field of every node.
 *
 * @param binName - The pipeline's `/bin` name (`PHI_detection_id12`).
 * @param manifest - Its manifest, with the nodes' parameter definitions.
 * @param handler - What runs a parsed line.
 * @returns The declaration.
 *
 * @example
 * ```ts
 * const declaration = pipelineDeclaration_make('PHI_id3', manifest, run);
 * Object.keys(declaration.grammar.options ?? {}); // ['diagram', …, 'segment.threshold', '@41.threshold', …]
 * ```
 */
export function pipelineDeclaration_make(binName: string, manifest: PipelineManifest, handler: (args: CommandArguments<CommandGrammar>) => Promise<CommandEnvelope>): CommandDeclaration {
  const options: Record<string, OptionGrammar> = { ...PIPELINE_SESSION_OPTIONS };
  for (const node of manifest.nodes) {
    for (const field of nodeFields_list(node)) {
      for (const selector of nodeSelectors_list(manifest, node)) {
        const key: string = `${selector}.${field.name}`;
        if (Object.hasOwn(options, key)) continue;
        options[key] = { long: key, summary: field.summary, ...(field.value !== undefined ? { value: field.value } : {}) };
      }
    }
  }
  return {
    name: binName,
    grammar: { operands: [INPUT_OPERAND], options },
    help: {
      summary: `The CUBE pipeline ${manifest.name}`,
      description: `Run the pipeline ${manifest.name} (${manifest.nodes.length} node${manifest.nodes.length === 1 ? '' : 's'}) from the feed node you are in, or on its operands (a directory in a feed is that node; outside one, pl-dircopy roots a new feed of it; several directories are one run each), or look at it. --<node>.<field> overrides one field of one node, the node named by its title or @<piping id>. help operands gives the full rules; whatif <line> prints a run and starts nothing.`,
      category: 'Resources',
      examples: [`${binName} --diagram`, `${binName} --diagram --withargs`, `${binName} --signalflow | signalflow -`, `${binName} --manifest`, `${binName} --previous 123`, `${binName} ~/uploads/subjects`],
    },
    holds: [],
    handler,
  };
}

/**
 * Splits a plugin line at its first lone `--`: the plugin's words before,
 * the run's context after.
 *
 * @param words - The line's words.
 * @returns The two parts.
 */
function contextWords_split(words: readonly ShellWord[]): { line: ShellWord[]; context: string[] } {
  const at: number = words.findIndex((word: ShellWord): boolean => word.value === '--');
  if (at === -1) return { line: [...words], context: [] };
  return { line: words.slice(0, at), context: words.slice(at + 1).map((word: ShellWord): string => word.value) };
}

/** A parsed line as these readers take it: its operands and options by name, whatever grammar parsed it. */
type LineRead = Pick<ParsedArguments, 'operands' | 'options'> | CommandArguments<CommandGrammar>;

/**
 * A parsed line's operands and options, as records by name.
 *
 * @param args - The parsed line.
 * @returns Its operands and options.
 */
function lineRecords_read(args: LineRead): { operands: Readonly<Record<string, unknown>>; options: Readonly<Record<string, unknown>> } {
  return { operands: { ...args.operands }, options: { ...args.options } };
}

/**
 * The plugin's parameters a parsed line gave: every option but the
 * session's, by its property, a switch only when set.
 *
 * @param options - The parsed options.
 * @returns The parameters.
 */
function pluginParameters_read(options: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(PLUGIN_SESSION_OPTIONS, key) || Object.hasOwn(PLUGIN_RUN_OPTIONS, key)) continue;
    if (value === false || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') parameters[key] = value;
  }
  return parameters;
}

/**
 * The run's own fields a parsed line gave, by the field each is posted as:
 * `--compute` first, so `--compute_resource_name` counts when both are given.
 *
 * @param options - The parsed options.
 * @returns The fields.
 */
function pluginRun_read(options: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const run: Record<string, string | number> = {};
  for (const [key, option] of Object.entries(PLUGIN_RUN_OPTIONS)) {
    const value: unknown = options[key];
    if (typeof value === 'string' || typeof value === 'number') run[option.field] = value;
  }
  return run;
}

/**
 * A plugin line, parsed: the typed reading of the line a declaration parsed.
 *
 * @param args - The parsed line.
 * @param context - The run's context words.
 * @returns The plugin line.
 *
 * @example
 * ```ts
 * pluginLine_read(parsed.args, ['feed_title=T']).parameters; // { dir: '/home/a/uploads' }
 * ```
 */
export function pluginLine_read(args: LineRead, context: readonly string[] = []): PluginLine {
  const { operands, options } = lineRecords_read(args);
  const inspect: PluginLine['inspect'] = options['readme'] === true ? (options['raw'] === true ? 'readmeRaw' : 'readme') : options['parameters'] === true ? 'parameters' : null;
  return {
    operands: (operands['input'] as string[] | undefined) ?? [],
    parameters: pluginParameters_read(options),
    run: pluginRun_read(options),
    context: [...context],
    detach: options['detach'] === true,
    inspect,
  };
}

/**
 * Parses a plugin's line against a declaration: the context split off at
 * the first lone `--`, the rest parsed as a builtin's line is.
 *
 * @param declaration - The plugin's declaration.
 * @param args - The words after the `/bin` name, carrying their shell words when a line gave them.
 * @returns The plugin line, or the refusal (`pl-dircopy-v2.1.1: unrecognized option '--x'; usage: …`).
 *
 * @example
 * ```ts
 * const parsed: PluginLineParse = await pluginWords_parse(declaration, ['~/uploads', '--', 'feed_title=T']);
 * ```
 */
export async function pluginWords_parse(declaration: CommandDeclaration, args: readonly string[]): Promise<PluginLineParse> {
  const { line, context } = contextWords_split(lineWords_read(args));
  const parsed: LineParse = await commandLine_parse(declaration, line);
  if (!parsed.ok) return parsed;
  return { ok: true, line: pluginLine_read(parsed.args, context) };
}

/** The look a pipeline line asks for, by its options, in the order they win. */
const PIPELINE_LOOKS: ReadonlyArray<readonly [string, PipelineLook]> = [
  ['help', 'help'], ['diagram', 'diagram'], ['signalflow', 'signalflow'], ['manifest', 'manifest'],
  ['nodes', 'nodes'], ['parameters', 'nodes'], ['source', 'source'], ['readme', 'source'],
];

/**
 * A pipeline line, parsed: the look it asks for or the run's options and
 * node overrides.
 *
 * @param args - The parsed line.
 * @returns The pipeline line.
 *
 * @example
 * ```ts
 * pipelineLine_read(parsed.args).bindings; // [{ node: 'segment', field: 'threshold', value: 0.5 }]
 * ```
 */
export function pipelineLine_read(args: LineRead): PipelineLine {
  const { operands, options } = lineRecords_read(args);
  const look: PipelineLook | null = PIPELINE_LOOKS.find(([key]: readonly [string, PipelineLook]): boolean => options[key] === true)?.[1] ?? null;
  const bindings: PipelineLineBinding[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(PIPELINE_SESSION_OPTIONS, key) || value === false || value === undefined) continue;
    const dot: number = key.lastIndexOf('.');
    if (dot <= 0) continue;
    bindings.push({ node: key.slice(0, dot), field: key.slice(dot + 1), value });
  }
  return {
    operands: (operands['input'] as string[] | undefined) ?? [],
    look,
    withArguments: options['withargs'] === true,
    signalflow: options['signalflow'] === true,
    ...(typeof options['compute'] === 'string' ? { compute: options['compute'] } : {}),
    ...(typeof options['previous'] === 'number' ? { previous: options['previous'] } : {}),
    ...(typeof options['paramFile'] === 'string' ? { paramFile: options['paramFile'] } : {}),
    bindings,
    detach: options['detach'] === true,
    verbose: options['verbose'] === true,
  };
}

/**
 * Parses a pipeline's line against a declaration.
 *
 * @param declaration - The pipeline's declaration.
 * @param args - The words after the `/bin` name.
 * @returns The pipeline line, or the refusal.
 *
 * @example
 * ```ts
 * const parsed: PipelineLineParse = await pipelineWords_parse(declaration, ['--segment.threshold', '0.5']);
 * ```
 */
export async function pipelineWords_parse(declaration: CommandDeclaration, args: readonly string[]): Promise<PipelineLineParse> {
  const parsed: LineParse = await commandLine_parse(declaration, lineWords_read(args));
  if (!parsed.ok) return parsed;
  return { ok: true, line: pipelineLine_read(parsed.args) };
}

/** The declarations made, by the `/bin` entry each is for (`plugin:pl-dircopy-v2.1.1`, `pipeline:PHI_id12`). */
const declarationsOwn: Map<string, CommandDeclaration> = new Map();
/**
 * As each piece of work sees them: the session's, or for work begun under another identity or done as
 * another user a set of its own, so that neither reads what the other was shown.
 */
const declarations: Map<string, CommandDeclaration> = identityPartition_make(declarationsOwn, (): Map<string, CommandDeclaration> => new Map());

/**
 * Forgets every declaration made, so the next is read from CUBE again.
 *
 * @example
 * ```ts
 * binDeclarations_forget();
 * ```
 */
export function binDeclarations_forget(): void {
  declarationsOwn.clear();
}
// What `/bin` declares is one CUBE's plugins and pipelines, as one user may run them: at a change of
// identity every declaration made is forgotten.
identityChange_listen(binDeclarations_forget);

/**
 * The `/bin` entry a word names: a plugin by its full `/bin` name, a
 * pipeline by its `/bin` name or its own, or a bare plugin name's highest
 * version.
 *
 * @param command - The word.
 * @returns The entry, or null when `/bin` names none.
 *
 * @example
 * ```ts
 * await binEntry_resolve('pl-dircopy'); // { kind: 'plugin', executable: 'pl-dircopy-v2.1.1' }
 * ```
 */
export async function binEntry_resolve(command: string): Promise<BinEntry | null> {
  const { binExecutableMatches_get, binPluginHighest_find } = await import('./binExecutables.js');
  const matches = await binExecutableMatches_get(command);
  if (matches.plugin !== undefined) return { kind: 'plugin', executable: matches.plugin.name };
  if (matches.pipeline !== undefined) return { kind: 'pipeline', name: matches.pipeline.name };
  const highest = await binPluginHighest_find(command);
  return highest === null ? null : { kind: 'plugin', executable: highest.executable };
}

/**
 * Reads one plugin version from CUBE: its kind, title and every parameter.
 *
 * @param executable - Its `/bin` name, `<name>-v<version>`.
 * @returns The plugin, or null when CUBE cannot say.
 */
async function pluginSpec_read(executable: string): Promise<PluginSpec | null> {
  const { pluginSpecifier_parse } = await import('../builtins/res/plugin.info.js');
  const specifier = pluginSpecifier_parse(executable);
  if (specifier === null) return null;
  const { session } = await import('../session/index.js');
  const { plugin_find, pluginParameters_drain } = await import('@fnndsc/cumin');
  const client = await session.connection.client_get();
  if (client === null) return null;
  const found = await plugin_find(client, specifier.name, specifier.version);
  if (found === null) return null;
  const rows = await pluginParameters_drain(found.handle);
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const title: string | undefined = text(found.data.title);
  const description: string | undefined = text(found.data.description);
  return {
    name: found.data.name ?? specifier.name,
    version: found.data.version ?? specifier.version,
    kind: found.data.type ?? 'ds',
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    parameters: rows.map((row): PluginParameterSpec => {
      const help: string | undefined = text(row.help);
      const shortFlag: string | undefined = text(row['short_flag']);
      return {
        name: row.name,
        type: row.type ?? 'str',
        optional: row.optional ?? false,
        ...(row.default === undefined ? {} : { default: row.default }),
        ...(help !== undefined ? { help } : {}),
        flag: text(row['flag']) ?? `--${row.name}`,
        ...(shortFlag !== undefined ? { shortFlag } : {}),
      };
    }),
  };
}

/**
 * Makes (or finds kept) the declaration of one `/bin` entry.
 *
 * @param entry - The entry.
 * @returns The declaration, or null when CUBE cannot say what the entry takes.
 */
async function entryDeclaration_get(entry: BinEntry): Promise<CommandDeclaration | null> {
  const key: string = entry.kind === 'plugin' ? `plugin:${entry.executable}` : `pipeline:${entry.name}`;
  const kept: CommandDeclaration | undefined = declarations.get(key);
  if (kept !== undefined) return kept;
  const { errorStack } = await import('@fnndsc/fond');
  // A declaration that cannot be read says nothing here: the line that needs it says why.
  const checkpoint: number = errorStack.checkpoint_mark();
  let made: CommandDeclaration | null = null;
  try {
    // The run is loaded when a line runs, never when a declaration is made for completion or help.
    if (entry.kind === 'plugin') {
      const spec: PluginSpec | null = await pluginSpec_read(entry.executable);
      if (spec !== null) {
        made = pluginDeclaration_make(spec, async (args: CommandArguments<CommandGrammar>): Promise<CommandEnvelope> => {
          const { pluginParsed_run } = await import('../builtins/pluginExecute.js');
          return pluginParsed_run(entry.executable, pluginLine_read(args));
        });
      }
    } else {
      const { pipelineManifest_get } = await import('@fnndsc/salsa');
      const manifest = await pipelineManifest_get(entry.name);
      if (manifest.ok) {
        made = pipelineDeclaration_make(entry.name, manifest.value, async (args: CommandArguments<CommandGrammar>): Promise<CommandEnvelope> => {
          const { pipelineParsed_run } = await import('./commandFallback.js');
          return pipelineParsed_run(entry.name, pipelineLine_read(args));
        });
      }
    }
  } catch {
    made = null;
  }
  errorStack.checkpoint_drain(checkpoint);
  // Kept for the work that read it: the session's own, in the session's set; work done as another user, or
  // begun before someone else connected, in a set of its own (see `declarations`).
  if (made !== null) declarations.set(key, made);
  return made;
}

/**
 * The declaration of a word `/bin` answers, made from CUBE the first time
 * and kept by its entry: what completion, help and the schema read of a
 * plugin or a pipeline, and what its line is parsed against.
 *
 * @param command - The word: a plugin's `/bin` name or bare name, or a pipeline's.
 * @returns The declaration, or null when the word names nothing in `/bin` or CUBE cannot say.
 *
 * @example
 * ```ts
 * (await binDeclaration_get('pl-dircopy'))?.name; // 'pl-dircopy-v2.1.1'
 * ```
 */
export async function binDeclaration_get(command: string): Promise<CommandDeclaration | null> {
  const entry: BinEntry | null = await binEntry_resolve(command);
  return entry === null ? null : entryDeclaration_get(entry);
}

/**
 * The declaration of one plugin version, by its full `/bin` name.
 *
 * @param executable - `<name>-v<version>`.
 * @returns The declaration, or null when CUBE cannot say.
 *
 * @example
 * ```ts
 * await pluginDeclaration_get('pl-dircopy-v2.1.1');
 * ```
 */
export async function pluginDeclaration_get(executable: string): Promise<CommandDeclaration | null> {
  return entryDeclaration_get({ kind: 'plugin', executable });
}

/**
 * The declaration of one pipeline, by its `/bin` name.
 *
 * @param name - The pipeline's `/bin` name.
 * @returns The declaration, or null when CUBE cannot say.
 *
 * @example
 * ```ts
 * await pipelineDeclaration_get('PHI_detection_id12');
 * ```
 */
export async function pipelineDeclaration_get(name: string): Promise<CommandDeclaration | null> {
  return entryDeclaration_get({ kind: 'pipeline', name });
}

/**
 * The fields `--<node>.<field>` names for a pipeline, for `pipeline run`'s
 * completion: every option of its declaration that overrides a node.
 *
 * @param pipeline - The pipeline as the line names it.
 * @returns The names, without the dashes; none when the pipeline cannot be read.
 *
 * @example
 * ```ts
 * await pipelineNodeOptions_list('PHI_detection'); // ['segment.threshold', '@41.threshold', …]
 * ```
 */
export async function pipelineNodeOptions_list(pipeline: string): Promise<string[]> {
  const entry: BinEntry | null = await binEntry_resolve(pipeline);
  if (entry === null || entry.kind !== 'pipeline') return [];
  const declaration: CommandDeclaration | null = await entryDeclaration_get(entry);
  return Object.keys(declaration?.grammar.options ?? {}).filter((key: string): boolean => !Object.hasOwn(PIPELINE_SESSION_OPTIONS, key));
}
