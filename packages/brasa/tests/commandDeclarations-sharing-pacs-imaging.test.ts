/**
 * @file What the Sharing, PACS and Imaging declarations brought to the
 * framework, and the PACS resources answered by chili: the `pacsQuery` kind
 * (its check, its completion from the session's query index, its wildcards
 * matched only in paths), a value option that asks when given none, a
 * subcommand's own help page, and `pacsservers`, `pacsqueries` and
 * `pacsretrieve` parsed here and written back as chili's words. Each
 * command's own line is tested beside its handler (`acl-builtin`,
 * `xattr-builtin`, `dcm-builtin`, `image-builtin`, `query-builtin`,
 * `pull-builtin`, `pacs-builtin`). All data here is synthetic.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';
import { cuminMock_install } from './support/cuminMock.js';

/** The session's query index: two synthetic questions. */
const indexEntries = [
  { queryId: 41, server: 'SYNTH', criteria: { AccessionNumber: 'A0001' }, owner: 'mise-e2e', answeredAt: '2026-11-01T00:00:00Z', hasResult: true },
  { queryId: 412, server: 'SYNTH', criteria: { PatientID: 'X0002' }, owner: 'mise-e2e', answeredAt: '2026-11-02T00:00:00Z', hasResult: false },
];
cuminMock_install(() => ({ queryIndex_get: () => ({ entries_all: () => indexEntries }) }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  queryFolderName_build: (parts: { queryId: number; queryObj: Record<string, string>; username?: string; hasResult?: boolean }): string =>
    `${Object.entries(parts.queryObj).map(([key, value]) => `${key}:${value}`).join('_')}_qid:${parts.queryId}${parts.username ? `_${parts.username}` : ''}${parts.hasResult === false ? '_no-hits' : ''}`,
}));
// Pathname expansion answers from a small world: `/net/pacs/queries/A*` matches two folders.
const mockShellWordsExpand = jest.fn(async (words: ReadonlyArray<{ value: string }>, eligible: (word: { value: string }, index: number) => boolean) => ({
  ok: true as const,
  value: words.flatMap((word, index) => {
    if (!eligible(word, index)) return [word];
    if (word.value === '/net/pacs/queries/A*') {
      return ['/net/pacs/queries/A1', '/net/pacs/queries/A2'].map((value: string) => ({ value, globPattern: value, pathnameExpansion: false, pathnameExpanded: true }));
    }
    return [word];
  }),
}));
jest.unstable_mockModule('../src/lib/wildcard.js', () => ({ shellWords_expand: mockShellWordsExpand }));
const mockCfsComplete = jest.fn(async (partial: string): Promise<string[]> => [`${partial}Study_1.2.3_MR/`]);
jest.unstable_mockModule('../src/lib/completer/cfsPaths.js', () => ({ cfsPaths_complete: mockCfsComplete }));
const mockChili = jest.fn(async (): Promise<CommandEnvelope> => ({ status: 'ok', rendered: 'chili\n' }));
jest.unstable_mockModule('../src/chris/chiliDelegate.js', () => ({ chiliCommand_run: mockChili }));

const { command_declare } = await import('../src/core/commandDeclaration.js');
const { commandLine_parse, declaredCommand_run } = await import('../src/core/commandParse.js');
const { commandUsage_render, declarationHelp_derive, subcommandHelp_derive } = await import('../src/core/commandUsage.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { argumentKind_get } = await import('../src/core/argumentKinds.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { backend_install } = await import('../src/core/backend.js');
const { chrisArgumentKinds, PACS_QUERY_KIND } = await import('../src/chris/kinds.js');
const { chiliWords_write, pacsserversCommand, pacsqueriesCommand, pacsretrieveCommand } = await import('../src/chris/pacsResources.js');

backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;
type Declared = Parameters<typeof commandLine_parse>[0];

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

/** A command with an option that asks, as `query --csv-to` is. */
const askingCommand = command_declare({
  name: 'export',
  grammar: {
    operands: [{ name: 'what', kind: 'word', optional: true, summary: 'What' }],
    options: {
      to: { long: 'to', short: 't', asks: true, summary: 'Where', value: { name: 'cfs-path', kind: 'cfsPath' } },
      table: { long: 'table', summary: 'A table too' },
    },
  },
  help: { summary: 'Export', description: 'Export it.' },
  handler: async (): Promise<CommandEnvelope> => ({ status: 'ok', rendered: '' }),
});

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
});

describe('the pacsQuery kind', () => {
  it('is the ChRIS backend\'s, and checks only that a word is given', () => {
    expect(argumentKind_get('pacsQuery')).toBe(PACS_QUERY_KIND);
    expect(PACS_QUERY_KIND.word_read('2833', { kind: 'pacsQuery' })).toEqual({ ok: true, value: '2833' });
    expect(PACS_QUERY_KIND.word_read('', { kind: 'pacsQuery' })).toEqual({ ok: false, reason: 'an empty word names no query' });
  });

  it('completes the index\'s query folders, its ids while digits are typed, and inside a folder as CFS lists it', async () => {
    const complete = (partial: string): Promise<string[]> => (PACS_QUERY_KIND.words_complete as (p: string, a: { kind: string }) => Promise<string[]>)(partial, { kind: 'pacsQuery' });
    expect(await complete('')).toEqual(['/net/pacs/queries/AccessionNumber:A0001_qid:41_mise-e2e/', '/net/pacs/queries/PatientID:X0002_qid:412_mise-e2e_no-hits/']);
    expect(await complete('/net/pacs/queries/Acc')).toEqual(['/net/pacs/queries/AccessionNumber:A0001_qid:41_mise-e2e/']);
    expect(await complete('41')).toEqual(['41', '412']);
    expect(await complete('/home/')).toEqual([]);
    expect(await complete('AccessionNumber:')).toEqual([]);
    expect(mockCfsComplete).not.toHaveBeenCalled();
    expect(await complete('/net/pacs/queries/AccessionNumber:A0001_qid:41_mise-e2e/')).toEqual(['/net/pacs/queries/AccessionNumber:A0001_qid:41_mise-e2e/Study_1.2.3_MR/']);
  });

  it('matches a wildcard in a path, and leaves a question\'s for the PACS', async () => {
    const expanded = await (PACS_QUERY_KIND.words_expand as NonNullable<typeof PACS_QUERY_KIND.words_expand>)(shellWords_tokenize('/net/pacs/queries/A* PatientName:SMITH*'));
    expect(expanded.ok && expanded.words.map((word) => word.value)).toEqual(['/net/pacs/queries/A1', '/net/pacs/queries/A2', 'PatientName:SMITH*']);
  });
});

describe('a value option that asks', () => {
  it('reads null when given no value, last on the line or before another option; its value otherwise', async () => {
    const last: Parsed = await line_parse(askingCommand, 'x --to');
    expect(last.ok && last.args.options).toEqual({ to: null, table: false });
    const before: Parsed = await line_parse(askingCommand, '--to --table x');
    expect(before.ok && before.args.options).toEqual({ to: null, table: true });
    expect(before.ok && before.args.operands).toEqual({ what: 'x' });
    const short: Parsed = await line_parse(askingCommand, '-t');
    expect(short.ok && short.args.options['to']).toBeNull();
    const given: Parsed = await line_parse(askingCommand, '--to ~/a.csv x');
    expect(given.ok && given.args.options['to']).toBe('~/a.csv');
    const absent: Parsed = await line_parse(askingCommand, 'x');
    expect(absent.ok && absent.args.options['to']).toBeUndefined();
  });

  it('says its value is optional in the usage and the help, and takes null in the schema', () => {
    expect(commandUsage_render(askingCommand)).toBe('export [--table] [--to [<cfs-path>]] [what]');
    expect(declarationHelp_derive(askingCommand).options).toContain('-t, --to [<cfs-path>]  Where');
    const [tool] = commandTools_derive(askingCommand);
    const to: Record<string, unknown> = (tool?.inputSchema['properties'] as Record<string, Record<string, unknown>>)['to'] as Record<string, unknown>;
    expect(JSON.stringify(to)).toContain('"null"');
  });
});

describe('a subcommand\'s own help', () => {
  it('has the subcommand\'s usage, its operands and options, and the command\'s examples that run it', () => {
    const help = subcommandHelp_derive(pacsqueriesCommand, 'decode');
    expect(help?.usage).toBe('pacsqueries decode [--raw] <queryId>');
    expect(help?.options).toEqual(['<queryId>  The query\'s id', '--raw      Print the raw decoded JSON']);
    expect(help?.examples).toEqual(['pacsqueries decode <id>                   # Decode a query result']);
    expect(subcommandHelp_derive(pacsqueriesCommand, 'nosuch')).toBeUndefined();
  });
});

describe('the PACS resources, answered by chili', () => {
  it('parse chili\'s subcommands and options; a bad line is refused before chili runs', async () => {
    const list: Parsed = await line_parse(pacsqueriesCommand, 'list --pacsserver SYNTH -p 5 --table');
    expect(list.ok && list.args.options).toEqual(expect.objectContaining({ pacsserver: 'SYNTH', page: 5, table: true, csv: false }));
    const refused: CommandEnvelope = await declaredCommand_run(pacsretrieveCommand, ['report', 'x']);
    expect(refused.renderedErr).toContain("pacsretrieve: report: invalid argument 'x' for <queryId> (not a whole number)");
    expect((await declaredCommand_run(pacsserversCommand, [])).renderedErr).toContain('pacsservers: missing subcommand (list, fieldslist)');
    expect((await declaredCommand_run(pacsserversCommand, ['list', '--pacsserver', 'X'])).renderedErr).toContain("unrecognized option '--pacsserver'");
    expect(mockChili).not.toHaveBeenCalled();
  });

  it('write the parsed line back as chili\'s words, and run it', async () => {
    expect(chiliWords_write(pacsqueriesCommand.grammar, { subcommand: 'decode', operands: { queryId: 7 }, options: { raw: true } })).toEqual(['decode', '--raw', '7']);
    const envelope: CommandEnvelope = await declaredCommand_run(pacsqueriesCommand, ['create', 'AccessionNumber:A0001', '--title', 'synthetic']);
    expect(mockChili).toHaveBeenCalledWith('pacsqueries', ['-s', 'create', '--title', 'synthetic', 'AccessionNumber:A0001']);
    expect(envelope.rendered).toBe('chili\n');
    await declaredCommand_run(pacsserversCommand, ['list', '-rs', 'identifier:SYNTH']);
    expect(mockChili).toHaveBeenLastCalledWith('pacsservers', ['-s', 'list', '--search', 'identifier:SYNTH', '--reverse']);
  });

  it('complete their subcommands and options, hold what the tables held, and write a tool per subcommand', async () => {
    expect(await declaredWord_complete(pacsretrieveCommand, [], '')).toEqual(['pull', 'report', 'cancel']);
    expect(await declaredWord_complete(pacsqueriesCommand, ['list'], '--p')).toEqual(['--page', '--pacsserver']);
    expect(pacsserversCommand.holds).toEqual([]);
    expect(pacsqueriesCommand.holds).toBeUndefined();
    expect(commandTools_derive(pacsretrieveCommand).map((tool) => tool.name)).toEqual(['pacsretrieve_pull', 'pacsretrieve_report', 'pacsretrieve_cancel']);
    for (const declaration of [pacsserversCommand, pacsqueriesCommand, pacsretrieveCommand]) expect(declaration.help.category).toBe('PACS');
  });
});
