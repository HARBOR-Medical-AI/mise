/**
 * @file The General commands, declared in one record each: each parses its
 * line as it did and refuses a bad one before its handler runs, lists under
 * General with its POSIX line, writes its tools, completes from its kinds,
 * keeps what it holds, and `echo` and `command` take their words as they come.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';

const { declaration_isParsed } = await import('../src/core/commandDeclaration.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { CORE_KIND_NAMES } = await import('../src/core/argumentKinds.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { commands_register, commandHolds_get, envelopeHandler_get } = await import('../src/core/commandRegistry.js');
const { coreCommands } = await import('../src/core/coreCommands.js');
const { HELP_CATEGORIES, helpCommand } = await import('../src/builtins/help.js');
const { variable_set, variable_unset, textAnswer_make } = await import('../src/core/variables.js');
const { aproposCommand, manCommand } = await import('../src/builtins/sys/apropos.js');
const { commandCommand } = await import('../src/builtins/sys/command.js');
const { versionCommand } = await import('../src/builtins/sys/version.js');
const { setCommand, unsetCommand } = await import('../src/builtins/sys/variables.js');
const { echoCommand, printfCommand } = await import('../src/builtins/sys/echo.js');
const { killCommand, waitCommand } = await import('../src/builtins/sys/tasks.js');
const { fgCommand, jobletsCommand } = await import('../src/builtins/sys/joblets.js');
const { notesCommand } = await import('../src/builtins/sys/notes.js');
const { dateCommand, builtin_date } = await import('../src/builtins/sys/date.js');

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;
type Parsable = Parameters<typeof commandLine_parse>[0];

/** The General commands, each declared. */
const GENERAL = [
  aproposCommand, manCommand, commandCommand, versionCommand, setCommand, unsetCommand, echoCommand, printfCommand,
  killCommand, waitCommand, jobletsCommand, fgCommand, notesCommand, dateCommand, helpCommand,
];

/** The General commands parsed against a grammar (all but echo and command). */
const PARSED: Parsable[] = GENERAL.filter(declaration_isParsed);

/**
 * Parses a line's words against a declaration.
 *
 * @param declaration - The command.
 * @param line - The words after the command, as typed.
 * @returns The parse.
 */
async function line_parse(declaration: Parsable, line: string): Promise<Parsed> {
  return commandLine_parse(declaration, shellWords_tokenize(line));
}

/**
 * The refusal of a line, or a failure when it parses.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The refusal.
 */
async function refusal_get(declaration: Parsable, line: string): Promise<string> {
  const parsed: Parsed = await line_parse(declaration, line);
  if (parsed.ok) throw new Error(`expected a refusal for: ${line}`);
  return parsed.refusal;
}

beforeEach(() => {
  process.exitCode = 0;
});

describe('the General commands are declared', () => {
  it('each once, in the core group, under General, with core kinds only', () => {
    const declared = coreCommands.declarations ?? [];
    for (const declaration of GENERAL) {
      expect(declared.filter((one) => one.name === declaration.name)).toEqual([declaration]);
      expect(declaration.help.category).toBe('General');
      expect(HELP_CATEGORIES).toContain('General');
    }
    for (const declaration of PARSED) {
      const lines = [declaration.grammar, ...Object.values(declaration.grammar.subcommands ?? {})];
      const kinds: string[] = lines.flatMap((line) => [
        ...(line.operands ?? []).map((operand) => operand.kind),
        ...Object.values(line.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
      ]);
      for (const kind of kinds) expect(CORE_KIND_NAMES).toContain(kind);
    }
  });

  it('each named like a Unix utility says how it mirrors it', () => {
    const unix: string[] = ['apropos', 'man', 'command', 'set', 'unset', 'echo', 'printf', 'kill', 'wait', 'joblets', 'fg', 'date'];
    for (const declaration of GENERAL.filter((one) => unix.includes(one.name))) expect(declaration.help.posix).toBeDefined();
  });

  it('parses its line against a grammar, but for echo and command, whose words are their own', () => {
    expect(GENERAL.filter((one) => !declaration_isParsed(one)).map((one) => one.name)).toEqual(['command', 'echo']);
  });
});

describe('usage, generated from the grammar', () => {
  it('writes each parsed command\'s usage line', () => {
    expect(PARSED.map((declaration) => commandUsage_render(declaration))).toEqual([
      'apropos <word…>',
      'man [-k] [topic…]',
      'version',
      'set [name]',
      'unset <name…>',
      'printf <format> [argument…]',
      'kill <task…>',
      'wait [task…]',
      'joblets',
      'fg [job]',
      'notes [-al] [--since <N|DATE>]',
      'date [-u] [format]',
      'help [topic…]',
    ]);
    expect(echoCommand.help.usage).toBe('echo [WORD]…');
    expect(commandCommand.help.usage).toBe('command <name> [args...]');
  });
});

describe('each parses its line as it did', () => {
  it('reads operands and options, anywhere on the line', async () => {
    const operands = async (declaration: Parsable, line: string): Promise<unknown> => {
      const parsed: Parsed = await line_parse(declaration, line);
      return parsed.ok ? { operands: parsed.args.operands, options: parsed.args.options } : parsed.refusal;
    };
    expect(await operands(manCommand, 'pull -k')).toEqual({ operands: { topic: ['pull'] }, options: { keyword: true } });
    expect(await operands(manCommand, 'pacs query')).toEqual({ operands: { topic: ['pacs', 'query'] }, options: { keyword: false } });
    expect(await operands(aproposCommand, 'dicom series')).toEqual({ operands: { word: ['dicom', 'series'] }, options: {} });
    expect(await operands(notesCommand, '-s 3 --long')).toEqual({ operands: {}, options: { since: '3', all: false, long: true } });
    expect(await operands(notesCommand, '--since=2026-10-01 -a')).toEqual({ operands: {}, options: { since: '2026-10-01', all: true, long: false } });
    expect(await operands(dateCommand, '+%Y -u')).toEqual({ operands: { format: '+%Y' }, options: { utc: true } });
    expect(await operands(fgCommand, '%2')).toEqual({ operands: { job: '%2' }, options: {} });
    expect(await operands(setCommand, 'A')).toEqual({ operands: { name: 'A' }, options: {} });
    expect(await operands(unsetCommand, 'A B')).toEqual({ operands: { name: ['A', 'B'] }, options: {} });
    expect(await operands(printfCommand, "'%s-%d' scan 7")).toEqual({ operands: { format: '%s-%d', argument: ['scan', '7'] }, options: {} });
    expect(await operands(printfCommand, "-- '%d' -5")).toEqual({ operands: { format: '%d', argument: ['-5'] }, options: {} });
    expect(await operands(killCommand, '%1 /proc/steps/trial-build')).toEqual({ operands: { task: ['%1', '/proc/steps/trial-build'] }, options: {} });
    expect(await operands(waitCommand, '')).toEqual({ operands: { task: [] }, options: {} });
    expect(await operands(helpCommand, 'pacs query')).toEqual({ operands: { topic: ['pacs', 'query'] }, options: {} });
  });

  it('refuses a bad line in plain words, with the usage, before the handler runs', async () => {
    expect(await refusal_get(setCommand, '1A')).toBe("set: invalid argument '1A' for <name> (not a variable name); usage: set [name]");
    expect(await refusal_get(setCommand, 'A B')).toBe("set: unexpected operand 'B'; usage: set [name]");
    expect(await refusal_get(setCommand, '-e')).toBe("set: invalid option -- 'e'; usage: set [name]");
    expect(await refusal_get(unsetCommand, '')).toBe('unset: missing operand <name>; usage: unset <name…>');
    expect(await refusal_get(fgCommand, 'x')).toBe("fg: invalid argument 'x' for <job> (a job is %N, or %% for the most recent); usage: fg [job]");
    expect(await refusal_get(jobletsCommand, 'x')).toBe("joblets: unexpected operand 'x'; usage: joblets");
    expect(await refusal_get(versionCommand, 'now')).toBe("version: unexpected operand 'now'; usage: version");
    expect(await refusal_get(dateCommand, '-x')).toBe("date: invalid option -- 'x'; usage: date [-u] [format]");
    expect(await refusal_get(notesCommand, '--since')).toBe("notes: option '--since' wants a value (<N|DATE>); usage: notes [-al] [--since <N|DATE>]");
    expect(await refusal_get(aproposCommand, '')).toBe('apropos: missing operand <word>; usage: apropos <word…>');
    expect(await refusal_get(printfCommand, "'%d' -5")).toBe("printf: invalid option -- '5'; usage: printf <format> [argument…]");
    expect(await refusal_get(killCommand, '-9 a')).toBe("kill: invalid option -- '9'; usage: kill <task…>");
  });

  it('date refuses a format without its +, and reads one with it', async () => {
    const refused: CommandEnvelope = await builtin_date(['%Y']);
    expect(refused.status).toBe('error');
    expect(refused.renderedErr).toContain("date: '%Y': a format starts with +");
    expect(process.exitCode).toBe(1);
    expect((await builtin_date(['+%Y', '-u'])).rendered).toMatch(/^\d{4}\n$/);
  });
});

describe('echo and command take their words as they come', () => {
  it('hands echo its words, dashes and all, through the registry', async () => {
    commands_register({ declarations: [echoCommand] });
    expect((await envelopeHandler_get('echo')?.(['use', '-n', 'here']))?.rendered).toBe('use -n here\n');
    expect((await envelopeHandler_get('echo')?.(['-n', 'hi']))?.renderedErr).toContain('echo: -n: echo takes no options');
  });
});

describe('what each holds of the session', () => {
  it('a read holds nothing; set, unset and command hold the whole session', () => {
    commands_register({ declarations: GENERAL });
    for (const name of ['apropos', 'man', 'version', 'echo', 'printf', 'kill', 'wait', 'joblets', 'fg', 'notes', 'date', 'help']) {
      expect(commandHolds_get(name)).toEqual([]);
    }
    for (const name of ['set', 'unset', 'command']) expect(commandHolds_get(name)).toBeNull();
  });
});

describe('the schema: one tool per command', () => {
  it('writes every parsed General command as a tool whose inputs are its operands and options', () => {
    for (const declaration of PARSED) {
      const tools = commandTools_derive(declaration);
      expect(tools.map((tool) => tool.name)).toEqual([declaration.name]);
      expect(tools[0]?.inputSchema['type']).toBe('object');
      expect(tools[0]?.description.length).toBeGreaterThan(0);
    }
    const required = (declaration: Parsable): unknown => commandTools_derive(declaration)[0]?.inputSchema['required'];
    expect(required(printfCommand)).toEqual(['format']);
    expect(required(unsetCommand)).toEqual(['name']);
    expect(required(killCommand)).toEqual(['task']);
    expect(required(setCommand)).toBeUndefined();
    const properties = commandTools_derive(notesCommand)[0]?.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['since']).toEqual(expect.objectContaining({ type: 'string' }));
    expect(properties['all']).toEqual(expect.objectContaining({ type: 'boolean' }));
  });
});

describe('completion, read from the declarations', () => {
  it('completes option names, and a variable from the names the session holds', async () => {
    expect(await declaredWord_complete(notesCommand, [], '-')).toEqual(['-s', '-a', '-l', '--since', '--all', '--long']);
    expect(await declaredWord_complete(dateCommand, [], '--')).toEqual(['--utc']);
    expect(await declaredWord_complete(manCommand, [], '-')).toEqual(['-k']);
    variable_set('SUBJECT', textAnswer_make('sub-01', 'test'));
    try {
      expect(await declaredWord_complete(setCommand, [], 'SU')).toEqual(['SUBJECT']);
      expect(await declaredWord_complete(unsetCommand, ['A'], 'SU')).toEqual(['SUBJECT']);
    } finally {
      variable_unset('SUBJECT');
    }
    expect(await declaredWord_complete(fgCommand, [], '%')).toEqual([]);
  });
});
