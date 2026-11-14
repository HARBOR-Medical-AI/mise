/**
 * @file One declaration per command: the parser (GNU getopt_long, operands by
 * order, expansion by kind, value checks), the usage and help generated from
 * a grammar, completion read from it, the JSON Schema of every migrated
 * command, and the rule that a core command uses only core kinds.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';

// Pathname expansion answers from a small world: `*.nii` matches two files,
// `one*` one, anything else nothing.
const mockShellWordsExpand = jest.fn(async (words: ReadonlyArray<{ value: string }>) => ({
  ok: true as const,
  value: words.flatMap((word) => {
    if (word.value === '*.nii') return ['a.nii', 'b.nii'].map((value: string) => ({ value, globPattern: value, pathnameExpansion: false, pathnameExpanded: true }));
    if (word.value === 'one*') return [{ value: 'one.nii', globPattern: 'one.nii', pathnameExpansion: false, pathnameExpanded: true }];
    return [word];
  }),
}));
jest.unstable_mockModule('../src/lib/wildcard.js', () => ({ shellWords_expand: mockShellWordsExpand }));
// CFS completion answers from the same world.
const mockCfsComplete = jest.fn(async (partial: string): Promise<string[]> =>
  ['/home/mise-e2e/feeds/', '/home/mise-e2e/uploads/', '/home/mise-e2e/notes.txt'].filter((path: string) => path.startsWith(partial)));
jest.unstable_mockModule('../src/lib/completer/cfsPaths.js', () => ({ cfsPaths_complete: mockCfsComplete }));
// chili's transfer module does not load under jest's ESM loader; download's handler is not run here.
jest.unstable_mockModule('@fnndsc/chili/commands/fs/download.js', () => ({
  files_downloadWithProgress: jest.fn(), files_downloadManyWithProgress: jest.fn(), bytes_format: (bytes: number): string => `${bytes} B`,
}));

const { command_declare, declaration_isParsed } = await import('../src/core/commandDeclaration.js');
const { commandLine_parse, declaredCommand_run } = await import('../src/core/commandParse.js');
const { commandUsage_render, declarationHelp_derive } = await import('../src/core/commandUsage.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { CORE_KIND_NAMES, argumentKind_get, argumentWord_check } = await import('../src/core/argumentKinds.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize, shellWord_literal } = await import('../src/lib/parser.js');
const { backend_install } = await import('../src/core/backend.js');
const { commands_register, commandDeclaration_get, commandDeclarations_list, commandHelpEntry_get, envelopeHandler_get, plainHandler_get, commandHolds_get } = await import('../src/core/commandRegistry.js');
const { lsCommand } = await import('../src/builtins/fs/ls.js');
const { downloadCommand } = await import('../src/builtins/fs/download.js');
const { berthCommand } = await import('../src/builtins/berth/berth.js');
const { coreCommands } = await import('../src/core/coreCommands.js');
const { chrisArgumentKinds } = await import('../src/chris/kinds.js');
const { berthState_write } = await import('../src/builtins/berth/berthState.js');
const { HeadlessSurface, surface_set } = await import('../src/core/surface.js');
const { variable_set, textAnswer_make } = await import('../src/core/variables.js');

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;

// A ChRIS session's kinds (an anchor's name) through the backend seam, until a test says otherwise.
backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });

/** A grammar that exercises every piece of the parser. */
const TRY_GRAMMAR = {
  operands: [
    { name: 'first', kind: 'int', summary: 'A number' },
    { name: 'rest', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'Paths' },
    { name: 'last', kind: 'word', optional: true, summary: 'Never reached while rest repeats' },
  ],
  options: {
    recurse: { short: 'r', summary: 'Recurse' },
    force: { short: 'f', long: 'force', summary: 'Force' },
    output: { short: 'o', long: 'output', summary: 'Output', value: { name: 'file', kind: 'hostPath' } },
    tag: { short: 't', long: 'tag', summary: 'A tag', repeat: true, value: { name: 'tag', kind: 'word' } },
    level: { long: 'level', summary: 'A level', value: { name: 'n', kind: 'int', min: 1, max: 3 } },
    colour: { long: 'colour', summary: 'A colour', value: { name: 'c', kind: 'enum', values: ['red', 'blue'] } },
  },
} as const;

const tryCommand = command_declare({
  name: 'try',
  grammar: TRY_GRAMMAR,
  help: { summary: 'Try the parser', description: 'Exercises the parser.' },
  handler: async (args): Promise<CommandEnvelope> => ({
    status: 'ok',
    rendered: `${args.operands.first} ${args.operands.rest.join(',')} ${args.options.force} ${args.options.tag.join('+')}\n`,
  }),
});

/** A grammar with a numeric operand and subcommands. */
const SUB_GRAMMAR = {
  options: { verbose: { short: 'v', long: 'verbose', summary: 'Say more' } },
  subcommands: {
    add: { summary: 'Add', operands: [{ name: 'amount', kind: 'number', summary: 'How much' }], options: { quiet: { short: 'q', summary: 'Say less' } } },
    list: { summary: 'List' },
  },
} as const;

const subCommand = command_declare({
  name: 'tally',
  grammar: SUB_GRAMMAR,
  help: { summary: 'Tally', description: 'Adds.' },
  handler: async (): Promise<CommandEnvelope> => ({ status: 'ok', rendered: '' }),
});

/**
 * Parses a line's words against a declaration.
 *
 * @param declaration - The command.
 * @param line - The words after the command, as typed.
 * @returns The parse.
 */
async function line_parse(declaration: Parameters<typeof commandLine_parse>[0], line: string): Promise<Parsed> {
  return commandLine_parse(declaration, shellWords_tokenize(line));
}

/**
 * The refusal of a line, or a failure when it parses.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The refusal.
 */
async function refusal_get(declaration: Parameters<typeof commandLine_parse>[0], line: string): Promise<string> {
  const parsed: Parsed = await line_parse(declaration, line);
  if (parsed.ok) throw new Error(`expected a refusal for: ${line}`);
  return parsed.refusal;
}

beforeEach(() => {
  mockShellWordsExpand.mockClear();
  process.exitCode = 0;
});

describe('the parser: GNU getopt_long', () => {
  it('reads bundled short switches, a long switch, and options anywhere among the operands', async () => {
    const parsed: Parsed = await line_parse(tryCommand, '-rf 3 a b --force');
    expect(parsed).toEqual({
      ok: true,
      args: {
        subcommand: null,
        operands: { first: 3, rest: ['a', 'b'], last: undefined },
        options: { recurse: true, force: true, output: undefined, tag: [], level: undefined, colour: undefined },
        expanded: { rest: false },
      },
    });
  });

  it('takes a value as --name x, --name=x, -o x and -ox, the last one counting, and every one for an option that repeats', async () => {
    const parsed: Parsed = await line_parse(tryCommand, '1 --output a -o b -oc --output=d -t x --tag y --tag=z -tw');
    expect(parsed.ok && parsed.args.options['output']).toBe('d');
    expect(parsed.ok && parsed.args.options['tag']).toEqual(['x', 'y', 'z', 'w']);
  });

  it('ends the options at --: what follows is an operand, a dash and all', async () => {
    const parsed: Parsed = await line_parse(tryCommand, '1 -- -r --force');
    expect(parsed.ok && parsed.args.operands['rest']).toEqual(['-r', '--force']);
    expect(parsed.ok && parsed.args.options['recurse']).toBe(false);
  });

  it('takes a negative number as an operand when an operand is numeric, and as options when none is', async () => {
    const parsed: Parsed = await line_parse(tryCommand, '-5 x');
    expect(parsed.ok && parsed.args.operands['first']).toBe(-5);
    const added: Parsed = await line_parse(subCommand, 'add -2.5 -v');
    expect(added.ok && added.args).toEqual({ subcommand: 'add', operands: { amount: -2.5 }, options: { quiet: false, verbose: true }, expanded: {} });
    // ls has no numeric operand, so -1 is its one-column switch.
    const listed: Parsed = await line_parse(lsCommand, '-1');
    expect(listed.ok && listed.args.options['oneColumn']).toBe(true);
  });

  it('takes a lone dash as an operand', async () => {
    const parsed: Parsed = await line_parse(tryCommand, '1 -');
    expect(parsed.ok && parsed.args.operands['rest']).toEqual(['-']);
  });

  it('refuses in plain words, with the usage, before any handler runs', async () => {
    const usage: string = 'usage: try [-rf] [--output <file>] [--tag <tag>] [--level <n>] [--colour <c>] <first> [rest…] [last]';
    expect(await refusal_get(tryCommand, '1 --nosuch')).toBe(`try: unrecognized option '--nosuch'; ${usage}`);
    expect(await refusal_get(tryCommand, '1 -rz')).toBe(`try: invalid option -- 'z'; ${usage}`);
    expect(await refusal_get(tryCommand, '1 --output')).toBe(`try: option '--output' wants a value (<file>); ${usage}`);
    expect(await refusal_get(tryCommand, '1 -o')).toBe(`try: option '-o' wants a value (<file>); ${usage}`);
    expect(await refusal_get(tryCommand, '1 --force=yes')).toBe(`try: option '--force' takes no value; ${usage}`);
    expect(await refusal_get(tryCommand, '')).toBe(`try: missing operand <first>; ${usage}`);
    expect(await refusal_get(tryCommand, 'many')).toBe(`try: invalid argument 'many' for <first> (not a whole number); ${usage}`);
    expect(await refusal_get(tryCommand, '1 --level 9')).toBe(`try: invalid argument '9' for '--level' (at most 3); ${usage}`);
    expect(await refusal_get(tryCommand, '1 --level 0')).toBe(`try: invalid argument '0' for '--level' (at least 1); ${usage}`);
    expect(await refusal_get(tryCommand, '1 --colour green')).toBe(`try: invalid argument 'green' for '--colour' (valid: red, blue); ${usage}`);
    expect(await refusal_get(tryCommand, '1 --output=')).toBe(`try: invalid argument '' for '--output' (an empty word is not a path); ${usage}`);
  });

  it('refuses an unknown subcommand, a missing one, and a subcommand\'s own words with its own usage', async () => {
    expect(await refusal_get(subCommand, 'sail')).toBe("tally: unknown subcommand 'sail' (add, list); usage: tally [-v] <add [-q] <amount> | list>");
    expect(await refusal_get(subCommand, '-v')).toBe('tally: missing subcommand (add, list); usage: tally [-v] <add [-q] <amount> | list>');
    expect(await refusal_get(subCommand, 'list now')).toBe("tally: list: unexpected operand 'now'; usage: tally list");
    expect(await refusal_get(subCommand, 'add 1 -x')).toBe("tally: add: invalid option -- 'x'; usage: tally add [-q] <amount>");
  });

  it('runs the handler on a good line, and refuses a bad one on the error channel with exit status 1', async () => {
    expect((await declaredCommand_run(tryCommand, ['2', '-t', 'a', 'x'])).rendered).toBe('2 x false a\n');
    const refused: CommandEnvelope = await declaredCommand_run(tryCommand, ['--force']);
    expect(refused.status).toBe('error');
    expect(refused.renderedErr).toContain('try: missing operand <first>');
    expect(process.exitCode).toBe(1);
  });
});

describe('the parser: operands expand by kind, after the shape', () => {
  it('expands only a globbing path operand, never an option or its value, and says which came from expansion', async () => {
    const parsed: Parsed = await line_parse(tryCommand, '1 *.nii -o *.out');
    expect(mockShellWordsExpand).toHaveBeenCalledTimes(1);
    expect(mockShellWordsExpand.mock.calls[0]?.[0].map((word: { value: string }) => word.value)).toEqual(['*.nii']);
    expect(parsed.ok && parsed.args.operands['rest']).toEqual(['a.nii', 'b.nii']);
    expect(parsed.ok && parsed.args.options['output']).toBe('*.out');
    expect(parsed.ok && parsed.args.expanded).toEqual({ rest: true });
  });

  it('leaves a quoted wildcard as written, and a word matching nothing as typed', async () => {
    const quoted: Parsed = await line_parse(tryCommand, "1 '*.nii'");
    expect(mockShellWordsExpand).not.toHaveBeenCalled();
    expect(quoted.ok && quoted.args.operands['rest']).toEqual(['*.nii']);
    const missing: Parsed = await line_parse(tryCommand, '1 none*');
    expect(missing.ok && missing.args.operands['rest']).toEqual(['none*']);
    expect(missing.ok && missing.args.expanded).toEqual({ rest: false });
  });

  it('globs download\'s sources and never its destination, the destination the last word', async () => {
    const parsed: Parsed = await line_parse(downloadCommand, '*.nii ./out* -f');
    expect(parsed.ok && parsed.args).toEqual({
      subcommand: null,
      operands: { source: ['a.nii', 'b.nii'], destination: './out*' },
      options: { force: true },
      expanded: { source: true },
    });
  });

  it('refuses a one-path operand a wildcard gives several, and takes one it gives one', async () => {
    expect(await refusal_get(berthCommand, 'anchor *.nii')).toBe("berth: anchor: <path> takes one path; '*.nii' matches 2; usage: berth anchor [-y] [--refresh] <path> [name]");
    const one: Parsed = await line_parse(berthCommand, 'anchor one* w');
    expect(one.ok && one.args.operands).toEqual({ path: 'one.nii', name: 'w' });
  });

  it('says why an expansion failed', async () => {
    mockShellWordsExpand.mockResolvedValueOnce({ ok: false } as never);
    expect(await refusal_get(lsCommand, '*.nii')).toMatch(/^ls: a wildcard could not be expanded; usage: ls /);
  });

  it('takes words a caller split as literals: nothing it hands over globs', async () => {
    await declaredCommand_run(tryCommand, ['1', '*.nii']);
    expect(mockShellWordsExpand).not.toHaveBeenCalled();
  });

  it('reads the words a line carried, quoting kept, when they come with the arguments', async () => {
    const words = shellWords_tokenize('1 *.nii');
    const args: string[] & { words?: unknown } = words.map((word) => word.value);
    Object.defineProperty(args, 'words', { value: words, enumerable: false });
    expect((await declaredCommand_run(tryCommand, args)).rendered).toBe('1 a.nii,b.nii false \n');
  });
});

describe('the migrated commands parse as they did', () => {
  it('ls: options after the paths, --sort both ways, -a taken', async () => {
    const parsed: Parsed = await line_parse(lsCommand, 'dir -l --sort=size -ra');
    expect(parsed.ok && parsed.args.operands).toEqual({ path: ['dir'] });
    expect(parsed.ok && parsed.args.options).toEqual(expect.objectContaining({ long: true, sort: 'size', reverse: true, all: true }));
    expect(await refusal_get(lsCommand, '--nosuch')).toBe("ls: unrecognized option '--nosuch'; usage: ls [-l1hfrdaA] [--sort <field>] [path…]");
  });

  it('download: one source and a destination, several sources, and too few words', async () => {
    const parsed: Parsed = await line_parse(downloadCommand, '/a /b /c ./d');
    expect(parsed.ok && parsed.args.operands).toEqual({ source: ['/a', '/b', '/c'], destination: './d' });
    expect(await refusal_get(downloadCommand, '/a')).toBe('download: missing operand <destination>; usage: download [-f] <source…> <destination>');
  });

  it('berth: bare, each subcommand, and its refusals', async () => {
    expect((await line_parse(berthCommand, '')).ok && true).toBe(true);
    const anchored: Parsed = await line_parse(berthCommand, 'anchor ~/x --refresh -y');
    expect(anchored.ok && anchored.args).toEqual({ subcommand: 'anchor', operands: { path: '~/x', name: undefined }, options: { refresh: true, yes: true }, expanded: { path: false } });
    const closed: Parsed = await line_parse(berthCommand, 'close --infeed=sub-01 --title "seg run" -f');
    expect(closed.ok && closed.args.options).toEqual({ infeed: 'sub-01', newfeed: false, name: undefined, title: 'seg run', force: true });
    expect(await refusal_get(berthCommand, 'anchor')).toBe('berth: anchor: missing operand <path>; usage: berth anchor [-y] [--refresh] <path> [name]');
  });
});

describe('usage and help, generated from the grammar', () => {
  it('writes each migrated command\'s usage line', () => {
    expect(commandUsage_render(lsCommand)).toBe('ls [-l1hfrdaA] [--sort <field>] [path…]');
    expect(commandUsage_render(downloadCommand)).toBe('download [-f] <source…> <destination>');
    expect(commandUsage_render(berthCommand)).toBe('berth [anchor [-y] [--refresh] <path> [name] | close [-f] [--newfeed] [--infeed <anchor>] [--name <feed>] [--title <text>] | drop <name> | clear]');
    expect(commandUsage_render(berthCommand, 'drop')).toBe('berth drop <name>');
  });

  it('derives the help record: usage, prose, operands and options, subcommands beneath their heading', () => {
    const ls = declarationHelp_derive(lsCommand);
    expect(ls).toEqual(expect.objectContaining({ usage: commandUsage_render(lsCommand), summary: 'List directory contents', category: 'Navigation' }));
    expect(ls.posix?.group).toBe('Files');
    expect(ls.options).toContain('--sort <field>    Sort by (name, size, date, owner)');
    expect(ls.options?.[0]).toMatch(/^\[path…\]\s{2,}What to list/);
    const berth = declarationHelp_derive(berthCommand);
    expect(berth.options?.[0]).toBe('SUBCOMMANDS:');
    expect(berth.options?.[1]).toMatch(/^ {2}\(none\)\s{2,}List the anchors/);
    expect(berth.options).toContainEqual(expect.stringMatching(/^ {4}-y, --yes\s{2,}Answer yes to the question above 10 GB$/));
    expect(berth.examples).toContain('berth drop sub-01');
  });
});

describe('the registry holds one record per declared command', () => {
  it('answers a declared name by parsing first, generates its help, and keeps its holds', async () => {
    commands_register({ declarations: [tryCommand] });
    expect(commandDeclaration_get('try')).toBe(tryCommand);
    expect(commandDeclarations_list()).toContain(tryCommand);
    expect(commandHelpEntry_get('try')?.usage).toBe(commandUsage_render(tryCommand));
    expect(commandHolds_get('try')).toBeNull();
    expect((await envelopeHandler_get('try')?.(['4', 'x']))?.rendered).toBe('4 x false \n');
    expect((await envelopeHandler_get('try')?.(['--nosuch']))?.status).toBe('error');
    expect(await plainHandler_get('try')?.(['4'])).toBeUndefined();
  });

  it('registers an expression grammar by its words, its usage its own', async () => {
    const seen: string[][] = [];
    commands_register({
      declarations: [{
        name: 'expr', grammar: 'expression',
        help: { usage: 'expr <expression>', summary: 'An expression', description: 'Its own parser.' },
        holds: [],
        handler: async (args: string[]): Promise<CommandEnvelope> => { seen.push(args); return { status: 'ok', rendered: '' }; },
        complete: async (_words: readonly string[], word: string): Promise<string[]> => [`${word}-done`],
      }],
    });
    await envelopeHandler_get('expr')?.(['-name', '*.txt']);
    expect(seen).toEqual([['-name', '*.txt']]);
    expect(commandHelpEntry_get('expr')?.usage).toBe('expr <expression>');
    expect(commandHolds_get('expr')).toEqual([]);
    const declared = commandDeclaration_get('expr');
    expect(declared !== undefined && declaration_isParsed(declared)).toBe(false);
    expect(await declaredWord_complete(declared as NonNullable<typeof declared>, [], 'x')).toEqual(['x-done']);
  });
});

describe('kinds', () => {
  it('a core command uses only core kinds, and a ChRIS command only core kinds and the ChRIS backend\'s', () => {
    const chrisKinds: string[] = chrisArgumentKinds.map((kind) => kind.name);
    const kindsOf = (declaration: NonNullable<typeof coreCommands.declarations>[number]): string[] => {
      if (!declaration_isParsed(declaration)) return [];
      const grammar = declaration.grammar;
      const lines = [grammar, ...Object.values(grammar.subcommands ?? {})];
      return lines.flatMap((line) => [
        ...(line.operands ?? []).map((operand) => operand.kind),
        ...Object.values(line.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
      ]);
    };
    expect(coreCommands.declarations?.length).toBeGreaterThan(0);
    for (const declaration of coreCommands.declarations ?? []) {
      for (const kind of kindsOf(declaration)) expect(CORE_KIND_NAMES).toContain(kind);
    }
    // The ChRIS group's module graph (chili) does not load under jest's ESM
    // loader; its declarations are these two.
    for (const declaration of [downloadCommand, berthCommand]) {
      for (const kind of kindsOf(declaration)) expect([...CORE_KIND_NAMES, ...chrisKinds]).toContain(kind);
    }
  });

  it('checks each core kind\'s words', () => {
    expect(argumentWord_check({ kind: 'int' }, '+7')).toEqual({ ok: true, value: 7 });
    expect(argumentWord_check({ kind: 'number' }, ' ')).toEqual({ ok: false, reason: 'not a number' });
    expect(argumentWord_check({ kind: 'number', max: 1 }, '1.5')).toEqual({ ok: false, reason: 'at most 1' });
    expect(argumentWord_check({ kind: 'variable' }, 'SUB_01')).toEqual({ ok: true, value: 'SUB_01' });
    expect(argumentWord_check({ kind: 'variable' }, '1x')).toEqual({ ok: false, reason: 'not a variable name' });
    expect(argumentWord_check({ kind: 'job' }, '%3')).toEqual({ ok: true, value: '%3' });
    expect(argumentWord_check({ kind: 'job' }, 'three')).toEqual({ ok: false, reason: 'a job is %N, or %% for the most recent' });
    expect(argumentWord_check({ kind: 'word' }, '')).toEqual({ ok: true, value: '' });
    expect(argumentWord_check({ kind: 'nosuch' }, 'x')).toEqual({ ok: false, reason: 'this session has no argument kind nosuch' });
  });

  it('finds a backend\'s kind through the backend seam, after the core\'s', () => {
    backend_install({ id: 'none', session: {} as never });
    expect(argumentKind_get('anchor')).toBeNull();
    backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });
    expect(argumentKind_get('anchor')?.name).toBe('anchor');
    expect(argumentWord_check({ kind: 'anchor' }, '')).toEqual({ ok: false, reason: 'an empty word names no anchor' });
  });
});

describe('completion, read from the declaration', () => {
  it('completes subcommand words, then a subcommand\'s operand by its kind', async () => {
    expect(await declaredWord_complete(berthCommand, [], 'an')).toEqual(['anchor']);
    expect(await declaredWord_complete(berthCommand, [], '')).toEqual(['anchor', 'close', 'drop', 'clear']);
    expect(await declaredWord_complete(berthCommand, ['anchor'], '/home/mise-e2e/')).toEqual(['/home/mise-e2e/feeds/', '/home/mise-e2e/uploads/', '/home/mise-e2e/notes.txt']);
    // The name after the path is a word: nothing to offer.
    expect(await declaredWord_complete(berthCommand, ['anchor', '/x'], '')).toEqual([]);
  });

  it('completes option names, short and long, in reach of the line', async () => {
    expect(await declaredWord_complete(lsCommand, [], '-')).toEqual(['-l', '-1', '-h', '-f', '-r', '-d', '-a', '-A', '--refresh', '--reverse', '--all', '--almost-all', '--sort']);
    expect(await declaredWord_complete(lsCommand, [], '--r')).toEqual(['--refresh', '--reverse']);
    expect(await declaredWord_complete(berthCommand, ['close'], '--')).toEqual(['--infeed', '--newfeed', '--name', '--title', '--force']);
  });

  it('completes an option\'s value by its kind, as the next word or after =', async () => {
    expect(await declaredWord_complete(lsCommand, ['--sort'], 's')).toEqual(['size']);
    expect(await declaredWord_complete(lsCommand, [], '--sort=d')).toEqual(['--sort=date']);
    // A host path completes from the engine's disk only when it is the surface's; the default surface's is not.
    expect(await declaredWord_complete(tryCommand, ['1', '-o'], '')).toEqual([]);
    expect(await declaredWord_complete(lsCommand, [], '--nosuch=')).toEqual([]);
  });

  it('completes download\'s first word as a CFS path, and after -- an operand however it starts', async () => {
    expect(await declaredWord_complete(downloadCommand, [], '/home/mise-e2e/u')).toEqual(['/home/mise-e2e/uploads/']);
    expect(await declaredWord_complete(downloadCommand, ['--'], '-')).toEqual([]);
    expect(mockCfsComplete).toHaveBeenLastCalledWith('-');
  });

  it('completes an anchor name from the berth, and nothing on a host', async () => {
    backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });
    delete process.env['MISE_BERTH_ANCHORS'];
    expect(await declaredWord_complete(berthCommand, ['drop'], '')).toEqual([]);
    const root: string = mkdtempSync(join(tmpdir(), 'declared-'));
    try {
      mkdirSync(join(root, 'anchors'));
      mkdirSync(join(root, 'outgoing'));
      const anchor = { name: 'sub-01', path: '/x/sub-01', node: null, feed: null, files: [], anchoredAt: '2026-11-14T00:00:00Z' };
      berthState_write(join(root, 'anchors'), { version: 1, anchors: [anchor, { ...anchor, name: 'weights' }], lastClosedAt: null });
      process.env['MISE_BERTH_ANCHORS'] = join(root, 'anchors');
      process.env['MISE_BERTH_OUTGOING'] = join(root, 'outgoing');
      expect(await declaredWord_complete(berthCommand, ['drop'], 's')).toEqual(['sub-01']);
      expect(await declaredWord_complete(berthCommand, ['close', '--infeed'], '')).toEqual(['sub-01', 'weights']);
    } finally {
      delete process.env['MISE_BERTH_ANCHORS'];
      delete process.env['MISE_BERTH_OUTGOING'];
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes a host path from the engine\'s disk only when it is the surface\'s', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'declared-'));
    mkdirSync(join(root, 'out'));
    writeFileSync(join(root, 'one.txt'), '');
    const previous = surface_set(new (class extends HeadlessSurface {
      public override readonly capabilities = { ...new HeadlessSurface().capabilities, engineFilesystem: true };
    })());
    try {
      expect(await declaredWord_complete(downloadCommand, ['/a'], `${root}/`)).toEqual(expect.arrayContaining([`${root}/out/`, `${root}/one.txt`]));
      expect(await declaredWord_complete(downloadCommand, ['/a'], `${root}/o`)).toEqual(expect.arrayContaining([`${root}/out/`, `${root}/one.txt`]));
      expect(await declaredWord_complete(downloadCommand, ['/a'], `${root}/nosuch/`)).toEqual([]);
    } finally {
      surface_set(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes a variable by the names the session holds, a job by the joblets running, a whole number by nothing', async () => {
    const kinds = { variable: argumentKind_get('variable'), job: argumentKind_get('job'), int: argumentKind_get('int') };
    variable_set('SUBJECT', textAnswer_make('sub-01', 'test'));
    expect(await kinds.variable?.words_complete?.('SU', { kind: 'variable' })).toEqual(['SUBJECT']);
    expect(await kinds.job?.words_complete?.('%', { kind: 'job' })).toEqual([]);
    expect(kinds.int?.words_complete).toBeUndefined();
  });

  it('completes nothing when a kind\'s source fails', async () => {
    mockCfsComplete.mockRejectedValueOnce(new Error('offline'));
    expect(await declaredWord_complete(lsCommand, [], 'x')).toEqual([]);
  });
});

describe('the schema: one tool per command and subcommand', () => {
  it('writes every migrated command as tools whose inputs are its operands and options', () => {
    backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });
    for (const declaration of [lsCommand, downloadCommand, berthCommand]) {
      for (const tool of commandTools_derive(declaration)) {
        expect(tool.name.startsWith(declaration.name)).toBe(true);
        expect(tool.inputSchema['type']).toBe('object');
        expect(tool.description.length).toBeGreaterThan(0);
      }
    }
    const [ls] = commandTools_derive(lsCommand);
    const lsProperties = ls?.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(lsProperties['path']).toEqual(expect.objectContaining({ type: 'array' }));
    expect(lsProperties['long']).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(lsProperties['sort']).toEqual(expect.objectContaining({ enum: ['name', 'size', 'date', 'owner'] }));
    expect(ls?.inputSchema['required']).toBeUndefined();
    const [download] = commandTools_derive(downloadCommand);
    expect(download?.inputSchema['required']).toEqual(['source', 'destination']);
    expect(commandTools_derive(berthCommand).map((tool) => tool.name)).toEqual(['berth', 'berth_anchor', 'berth_close', 'berth_drop', 'berth_clear']);
    const anchor = commandTools_derive(berthCommand)[1];
    expect(anchor?.inputSchema['required']).toEqual(['path']);
    expect(anchor?.inputSchema['additionalProperties']).toBe(false);
  });

  it('types a number and an integer by kind, bounds kept, and refuses an operand and an option of one name', () => {
    const [tally] = commandTools_derive(subCommand).filter((tool) => tool.name === 'tally_add');
    expect((tally?.inputSchema['properties'] as Record<string, Record<string, unknown>>)['amount']).toEqual(expect.objectContaining({ type: 'number' }));
    const [tried] = commandTools_derive(tryCommand);
    expect((tried?.inputSchema['properties'] as Record<string, Record<string, unknown>>)['level']).toEqual(expect.objectContaining({ type: 'integer', minimum: 1, maximum: 3 }));
    const clash = command_declare({
      name: 'clash',
      grammar: { operands: [{ name: 'x', kind: 'word', summary: 'x' }], options: { x: { short: 'x', summary: 'x' } } },
      help: { summary: 'Clash', description: 'Clash' },
      handler: async (): Promise<CommandEnvelope> => ({ status: 'ok', rendered: '' }),
    });
    expect(() => commandTools_derive(clash)).toThrow('x names an operand and an option');
    expect(() => commandTools_derive(command_declare({
      name: 'odd', grammar: { operands: [{ name: 'y', kind: 'nosuch', summary: 'y' }] }, help: { summary: 'Odd', description: 'Odd' },
      handler: async (): Promise<CommandEnvelope> => ({ status: 'ok', rendered: '' }),
    }))).toThrow('no argument kind nosuch');
  });
});

describe('a literal word for the parser', () => {
  it('never globs', async () => {
    const parsed: Parsed = await commandLine_parse(tryCommand, [shellWord_literal('1'), shellWord_literal('*.nii')]);
    expect(parsed.ok && parsed.args.operands['rest']).toEqual(['*.nii']);
  });
});
