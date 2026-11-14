/**
 * @file The Connection, Navigation and Settings commands, each declared in
 * one record: their lines parse as they did, refuse a bad one in the
 * parser's words, generate their usage, keep their help prose and holds,
 * complete from their grammar, and write a tool schema; a core command
 * uses only core kinds.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';
import { cuminMock_install } from './support/cuminMock.js';

// cumin's root and salsa do not load under jest's ESM loader; no handler that reads them runs here.
cuminMock_install(() => ({ currentIdentity_get: jest.fn(), chrisContext: { currentContext_update: jest.fn() } }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: jest.fn() }));
jest.unstable_mockModule('../src/builtins/net/pacsUtils.js', () => ({ pacs_seriesCollect: jest.fn(), pacsServer_resolve: jest.fn(), series_cubePathGet: jest.fn() }));

// Pathname expansion answers from a small world: `feed*` matches two folders, `one*` one.
const mockShellWordsExpand = jest.fn(async (words: ReadonlyArray<{ value: string }>) => ({
  ok: true as const,
  value: words.flatMap((word) => {
    if (word.value === 'feed*') return ['feed_1', 'feed_2'].map((value: string) => ({ value, globPattern: value, pathnameExpansion: false, pathnameExpanded: true }));
    if (word.value === 'one*') return [{ value: 'one', globPattern: 'one', pathnameExpansion: false, pathnameExpanded: true }];
    return [word];
  }),
}));
jest.unstable_mockModule('../src/lib/wildcard.js', () => ({ shellWords_expand: mockShellWordsExpand }));
const mockCfsComplete = jest.fn(async (partial: string): Promise<string[]> =>
  ['/home/mise-e2e/feeds/', '/home/mise-e2e/uploads/'].filter((path: string) => path.startsWith(partial)));
jest.unstable_mockModule('../src/lib/completer/cfsPaths.js', () => ({ cfsPaths_complete: mockCfsComplete }));
// chili's modules do not load under jest's ESM loader; no handler that needs them runs here.
jest.unstable_mockModule('@fnndsc/chili/path/pathCommand.js', () => ({ scan_do: jest.fn(), archyTree_create: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({ bytes_format: (bytes: number): string => `${bytes} B` }));
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({ table_render: jest.fn(() => '') }));
jest.unstable_mockModule('@fnndsc/chili/commands/connect/login.js', () => ({ connect_login: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/commands/connect/logout.js', () => ({ connect_logout: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/views/connect.js', () => ({ login_render: jest.fn(() => ''), logout_render: jest.fn(() => '') }));
const mockTimingSet = jest.fn();
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { timingEnabled_get: (): boolean => false, timingEnabled_set: mockTimingSet, physicalMode_get: (): boolean => false, physicalMode_set: jest.fn(), getCWD: async (): Promise<string> => '/home/mise-e2e' },
}));

const { declaration_isParsed } = await import('../src/core/commandDeclaration.js');
const { commandLine_parse, declaredCommand_run } = await import('../src/core/commandParse.js');
const { commandUsage_render, declarationHelp_derive } = await import('../src/core/commandUsage.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { CORE_KIND_NAMES } = await import('../src/core/argumentKinds.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { cdCommand } = await import('../src/builtins/fs/cd.js');
const { pwdCommand } = await import('../src/builtins/fs/pwd.js');
const { treeCommand } = await import('../src/builtins/fs/tree.js');
const { duCommand } = await import('../src/builtins/fs/du.js');
const { cubepathCommand } = await import('../src/builtins/net/cubepath.js');
const { netstatCommand } = await import('../src/builtins/net/netstat.js');
const { connectCommand } = await import('../src/builtins/net/connect.js');
const { logoutCommand } = await import('../src/builtins/net/logout.js');
const { contextCommand } = await import('../src/builtins/sys/context.js');
const { idCommand, whoamiCommand, whereamiCommand } = await import('../src/builtins/sys/whoami.js');
const { timingCommand } = await import('../src/builtins/sys/timing.js');
const { debugCommand } = await import('../src/builtins/debug.js');
const { physicalmodeCommand } = await import('../src/builtins/sys/physicalmode.js');

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;
type Declared = Parameters<typeof commandLine_parse>[0];

/** The core's commands of these sections, which may use only core kinds. */
const CORE: ReadonlyArray<Declared> = [cdCommand, pwdCommand, timingCommand, debugCommand];
/** The ChRIS backend's commands of these sections. */
const CHRIS: ReadonlyArray<Declared> = [
  netstatCommand, connectCommand, logoutCommand, contextCommand, whoamiCommand, idCommand, whereamiCommand,
  physicalmodeCommand, treeCommand, duCommand, cubepathCommand,
];

/**
 * Parses a line's words against a declaration.
 *
 * @param declaration - The command.
 * @param line - The words after the command, as typed.
 * @returns The parse.
 */
async function line_parse(declaration: Declared, line: string): Promise<Parsed> {
  return commandLine_parse(declaration, shellWords_tokenize(line));
}

/**
 * The refusal of a line, or a failure when it parses.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The refusal.
 */
async function refusal_get(declaration: Declared, line: string): Promise<string> {
  const parsed: Parsed = await line_parse(declaration, line);
  if (parsed.ok) throw new Error(`expected a refusal for: ${line}`);
  return parsed.refusal;
}

beforeEach(() => {
  mockShellWordsExpand.mockClear();
  process.exitCode = 0;
});

describe('the Navigation commands parse as they did', () => {
  it('cd: one path, none, a lone dash, a wildcard matching one folder; two paths or two matches refused', async () => {
    expect((await line_parse(cdCommand, '~/feeds')).ok && true).toBe(true);
    const none: Parsed = await line_parse(cdCommand, '');
    expect(none.ok && none.args.operands).toEqual({ path: undefined });
    const back: Parsed = await line_parse(cdCommand, '-');
    expect(back.ok && back.args.operands).toEqual({ path: '-' });
    const one: Parsed = await line_parse(cdCommand, 'one*');
    expect(one.ok && one.args.operands).toEqual({ path: 'one' });
    expect(await refusal_get(cdCommand, 'a b')).toBe("cd: unexpected operand 'b'; usage: cd [path]");
    expect(await refusal_get(cdCommand, 'feed*')).toBe("cd: <path> takes one path; 'feed*' matches 2; usage: cd [path]");
    expect(await refusal_get(cdCommand, '-P x')).toBe("cd: invalid option -- 'P'; usage: cd [path]");
  });

  it('pwd: --title, and nothing else', async () => {
    const titled: Parsed = await line_parse(pwdCommand, '--title');
    expect(titled.ok && titled.args.options).toEqual({ title: true });
    expect(await refusal_get(pwdCommand, '-L')).toBe("pwd: invalid option -- 'L'; usage: pwd [--title]");
  });

  it('tree: its switches anywhere, one path; an option it does not have refused by name', async () => {
    const parsed: Parsed = await line_parse(treeCommand, '/data --dirs --follow');
    expect(parsed.ok && parsed.args.operands).toEqual({ path: '/data' });
    expect(parsed.ok && parsed.args.options).toEqual({ follow: true, listPaths: false, dirs: true, dirpath: false });
    expect(await refusal_get(treeCommand, '-L 1 /data')).toBe("tree: invalid option -- 'L'; usage: tree [--follow] [--path] [--dirs] [--dirpath] [path]");
    expect(await refusal_get(treeCommand, '--bogus /data')).toMatch(/^tree: unrecognized option '--bogus'; usage: /);
  });

  it('du: bundled switches, -d N, -dN, --max-depth=N, several paths; a depth that is not a count refused', async () => {
    const parsed: Parsed = await line_parse(duCommand, '-sh -d 2 a b');
    expect(parsed.ok && parsed.args.operands).toEqual({ path: ['a', 'b'] });
    expect(parsed.ok && parsed.args.options).toEqual({ humanReadable: true, summarize: true, all: false, total: false, separateDirs: false, maxDepth: 2 });
    const glued: Parsed = await line_parse(duCommand, '-d0 x');
    expect(glued.ok && glued.args.options['maxDepth']).toBe(0);
    const long: Parsed = await line_parse(duCommand, '--max-depth=3 --human-readable x');
    expect(long.ok && long.args.options).toEqual(expect.objectContaining({ maxDepth: 3, humanReadable: true }));
    expect(await refusal_get(duCommand, '-d x')).toBe("du: invalid argument 'x' for '--max-depth' (not a whole number); usage: du [-hsacS] [--max-depth <N>] [path…]");
    expect(await refusal_get(duCommand, '--bogus /data')).toMatch(/^du: unrecognized option '--bogus'/);
  });

  it('cubepath: one or more paths, --pacsserver and --retry anywhere; none refused', async () => {
    const parsed: Parsed = await line_parse(cubepathCommand, '/net/pacs/queries/q --pacsserver 3 --retry /net/pacs/queries/r');
    expect(parsed.ok && parsed.args.operands).toEqual({ path: ['/net/pacs/queries/q', '/net/pacs/queries/r'] });
    expect(parsed.ok && parsed.args.options).toEqual({ pacsserver: '3', retry: true });
    expect(await refusal_get(cubepathCommand, '')).toBe('cubepath: missing operand <path>; usage: cubepath [--retry] [--pacsserver <id>] <path…>');
  });
});

describe('the Connection commands parse as they did', () => {
  it('netstat: -r, --reset, -n N; a count that is not one refused', async () => {
    const parsed: Parsed = await line_parse(netstatCommand, '-r -n 30');
    expect(parsed.ok && parsed.args.options).toEqual({ reset: true, count: 30 });
    expect(await refusal_get(netstatCommand, '-n x')).toBe("netstat: invalid argument 'x' for '-n' (not a whole number); usage: netstat [-r] [-n <count>]");
    expect(await refusal_get(netstatCommand, '--verbose')).toBe("netstat: unrecognized option '--verbose'; usage: netstat [-r] [-n <count>]");
  });

  it('connect: the URL, --user and --password either way; no URL refused', async () => {
    const parsed: Parsed = await line_parse(connectCommand, '--user=chris --password chris1234 http://localhost:8000');
    expect(parsed.ok && parsed.args.operands).toEqual({ url: 'http://localhost:8000' });
    expect(parsed.ok && parsed.args.options).toEqual({ user: 'chris', password: 'chris1234' });
    expect(await refusal_get(connectCommand, '--user chris')).toBe('connect: missing operand <url>; usage: connect [--user <username>] [--password <password>] <url>');
  });

  it('connect: a line without both credentials is refused before any login', async () => {
    const envelope: CommandEnvelope = await declaredCommand_run(connectCommand, ['http://localhost:8000']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('connect: --user and --password are both needed; usage: connect ');
    expect(process.exitCode).toBe(1);
  });

  it('logout, context, whoami, id and whereami take nothing after the command', async () => {
    for (const declaration of [logoutCommand, contextCommand, whoamiCommand, idCommand, whereamiCommand]) {
      expect((await line_parse(declaration, '')).ok).toBe(true);
      expect(await refusal_get(declaration, 'extra')).toBe(`${declaration.name}: unexpected operand 'extra'; usage: ${declaration.name}`);
    }
  });
});

describe('the Settings commands', () => {
  it('timing, debug and physicalmode: on, off, or neither; anything else refused naming the two', async () => {
    for (const declaration of [timingCommand, debugCommand, physicalmodeCommand]) {
      expect(commandUsage_render(declaration)).toBe(`${declaration.name} [on | off]`);
      const bare: Parsed = await line_parse(declaration, '');
      expect(bare.ok && bare.args.subcommand).toBeNull();
      const on: Parsed = await line_parse(declaration, 'on');
      expect(on.ok && on.args.subcommand).toBe('on');
      expect(await refusal_get(declaration, 'sideways')).toBe(`${declaration.name}: unknown subcommand 'sideways' (on, off); usage: ${declaration.name} [on | off]`);
    }
  });

  it('timing runs its subcommand on the session', async () => {
    const envelope: CommandEnvelope = await declaredCommand_run(timingCommand, ['on']);
    expect(mockTimingSet).toHaveBeenCalledWith(true);
    expect(envelope.model).toEqual({ kind: 'sys.timing', data: { enabled: true } });
  });
});

describe('help, holds and kinds, from the declaration', () => {
  it('keeps each command in its help section, its POSIX note where it had one, and its examples', () => {
    for (const declaration of CORE) expect(['Navigation', 'Settings']).toContain(declaration.help.category);
    for (const declaration of CHRIS) expect(['Navigation', 'Connection', 'Settings']).toContain(declaration.help.category);
    expect(declarationHelp_derive(cdCommand).posix?.group).toBe('Files');
    expect(declarationHelp_derive(duCommand).options).toContain('-d, --max-depth <N>   Print total only if N or fewer levels below');
    expect(declarationHelp_derive(timingCommand).options?.[0]).toBe('SUBCOMMANDS:');
    expect(declarationHelp_derive(netstatCommand).examples).toContain('netstat -n 30        # the last 30 requests, timed');
  });

  it('id documents the Unix-style ChRIS identity projection', () => {
    const id = declarationHelp_derive(idCommand);
    expect(id.usage).toBe('id');
    expect(id.description).toContain('UID');
    expect(id.description).toContain('GID');
    expect(id.description).toContain('memberships');
  });

  it('holds what the tables held: cd the working directory; pwd, tree, du, id, whoami and whereami nothing', () => {
    expect(cdCommand.holds).toEqual(['cwd']);
    for (const declaration of [pwdCommand, treeCommand, duCommand, idCommand, whoamiCommand, whereamiCommand]) expect(declaration.holds).toEqual([]);
    for (const declaration of [connectCommand, logoutCommand, timingCommand, debugCommand, physicalmodeCommand]) expect(declaration.holds).toBeUndefined();
  });

  it('a core command uses only core kinds; these ChRIS commands need no kind of the backend\'s', () => {
    const kindsOf = (declaration: Declared): string[] => {
      const grammar = declaration.grammar;
      return [grammar, ...Object.values(grammar.subcommands ?? {})].flatMap((line) => [
        ...(line.operands ?? []).map((operand) => operand.kind),
        ...Object.values(line.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
      ]);
    };
    for (const declaration of [...CORE, ...CHRIS]) {
      expect(declaration_isParsed(declaration)).toBe(true);
      for (const kind of kindsOf(declaration)) expect(CORE_KIND_NAMES).toContain(kind);
    }
  });
});

describe('completion, read from the declaration', () => {
  it('completes a setting\'s subcommands, an option\'s names, and a path operand as a CFS path', async () => {
    expect(await declaredWord_complete(timingCommand, [], 'o')).toEqual(['on', 'off']);
    expect(await declaredWord_complete(duCommand, [], '--m')).toEqual(['--max-depth']);
    expect(await declaredWord_complete(treeCommand, [], '--d')).toEqual(['--dirs', '--dirpath']);
    expect(await declaredWord_complete(cdCommand, [], '/home/mise-e2e/f')).toEqual(['/home/mise-e2e/feeds/']);
    expect(await declaredWord_complete(netstatCommand, [], '-')).toEqual(['-r', '-n', '--reset']);
  });

  it('completes nothing past cd\'s one path, and nothing for a command that takes nothing', async () => {
    expect(await declaredWord_complete(cdCommand, ['/home'], '/home/mise-e2e/f')).toEqual([]);
    expect(await declaredWord_complete(whoamiCommand, [], '')).toEqual([]);
  });
});

describe('the schema: one tool per command and subcommand', () => {
  it('writes every one of these commands as tools', () => {
    for (const declaration of [...CORE, ...CHRIS]) {
      for (const tool of commandTools_derive(declaration)) {
        expect(tool.name.startsWith(declaration.name)).toBe(true);
        expect(tool.inputSchema['type']).toBe('object');
      }
    }
    expect(commandTools_derive(timingCommand).map((tool) => tool.name)).toEqual(['timing', 'timing_on', 'timing_off']);
    const [cubepath] = commandTools_derive(cubepathCommand);
    expect(cubepath?.inputSchema['required']).toEqual(['path']);
    const [du] = commandTools_derive(duCommand);
    expect((du?.inputSchema['properties'] as Record<string, Record<string, unknown>>)['maxDepth']).toEqual(expect.objectContaining({ type: 'integer', minimum: 0 }));
  });
});
