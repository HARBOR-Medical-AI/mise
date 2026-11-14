/**
 * @file `cp`, `mv` and `cat`, each declared in one record: their lines parse
 * as they did, refuse a bad one in the parser's words before the handler
 * runs, end options at `--`, and keep their help prose and holds. `-t` is a
 * switch that asks for the target directory; `--target-directory <dir>`
 * names one; `--highlight[=<language>]` takes its language only in its own
 * word, and `--no-highlight` wins over it.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
const mockQuestion = jest.fn<(request: Record<string, unknown>) => Promise<string>>(async () => '');
jest.unstable_mockModule('../src/core/question.js', () => ({
  repl_questionPath: (message: string, where: unknown, commit?: string): Promise<string> => mockQuestion({ message, where, commit }),
}));

const { linkedStore_install, HOME, LINKED } = await import('./support/linkedStore.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { cpCommand, builtin_cp } = await import('../src/builtins/fs/cp.js');
const { mvCommand, builtin_mv } = await import('../src/builtins/fs/mv.js');
const { catCommand, builtin_cat } = await import('../src/builtins/fs/cat.js');
type LinkedStore = ReturnType<typeof linkedStore_install>;
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

let store: LinkedStore;
beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  store = linkedStore_install();
});

describe('cp and mv parse as they did', () => {
  it('generate their usage from the grammar', () => {
    expect(commandUsage_render(cpCommand)).toBe('cp [-rt] [--target-directory <dir>] <paths…>');
    expect(commandUsage_render(mvCommand)).toBe('mv [-t] [--target-directory <dir>] <paths…>');
  });

  it('take bundled switches anywhere among the operands', async () => {
    const parsed: Parsed = await line_parse(cpCommand, 'a -rt b');
    expect(parsed.ok && parsed.args.operands).toEqual({ paths: ['a', 'b'] });
    expect(parsed.ok && parsed.args.options).toEqual({ recursive: true, askTarget: true, targetDirectory: undefined });
  });

  it('-t is a switch: the word after it is a source, not the directory', async () => {
    const parsed: Parsed = await line_parse(mvCommand, '-t a b c');
    expect(parsed.ok && parsed.args.operands).toEqual({ paths: ['a', 'b', 'c'] });
    expect(parsed.ok && parsed.args.options).toEqual({ askTarget: true, targetDirectory: undefined });
  });

  it('--target-directory names the directory, either way', async () => {
    const spaced: Parsed = await line_parse(cpCommand, '--target-directory backup a b');
    expect(spaced.ok && spaced.args.operands).toEqual({ paths: ['a', 'b'] });
    expect(spaced.ok && spaced.args.options['targetDirectory']).toBe('backup');
    const joined: Parsed = await line_parse(mvCommand, 'a --target-directory=backup');
    expect(joined.ok && joined.args.options['targetDirectory']).toBe('backup');
  });

  it('refuse an option they do not have, and nothing else runs', async () => {
    const cp: CommandEnvelope = await builtin_cp(['-x', `${LINKED}/hello.txt`, `${HOME}/c.txt`]);
    expect(cp.renderedErr).toContain("cp: invalid option -- 'x'; usage: cp [-rt]");
    const mv: CommandEnvelope = await builtin_mv(['--force', `${LINKED}/hello.txt`, `${HOME}/m.txt`]);
    expect(mv.renderedErr).toContain("mv: unrecognized option '--force'; usage: mv [-t]");
    expect(process.exitCode).toBe(1);
    expect(store.calls).toEqual([]);
  });

  it('end options at --: a source that starts with a dash', async () => {
    store.entries.set(`${HOME}/-odd.txt`, { type: 'file', content: 'odd\n' });
    const envelope: CommandEnvelope = await builtin_mv(['--', '-odd.txt', 'even.txt']);
    expect(envelope.status).toBe('ok');
    expect(store.entries.get(`${HOME}/even.txt`)?.content).toBe('odd\n');
  });
});

describe('cp and mv into a target directory', () => {
  it('-t asks for the directory, every operand a source', async () => {
    mockQuestion.mockResolvedValueOnce(`${LINKED}/inner`);
    store.entries.set(`${HOME}/a.txt`, { type: 'file', content: 'a\n' });
    const envelope: CommandEnvelope = await builtin_cp(['-t', 'a.txt', `${LINKED}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    const asked = mockQuestion.mock.calls[0]?.[0] as { where: { wantsDirectory: boolean }; commit: string };
    expect(asked.where.wantsDirectory).toBe(true);
    expect(asked.commit).toBe('COPY HERE');
    expect(store.entries.get(`${LINKED}/inner/a.txt`)?.content).toBe('a\n');
    expect(store.entries.get(`${LINKED}/inner/hello.txt`)?.content).toBe('hello\nworld\n');
  });

  it('-t abandoned moves nothing', async () => {
    mockQuestion.mockResolvedValueOnce('  ');
    const envelope: CommandEnvelope = await builtin_mv(['-t', `${LINKED}/hello.txt`]);
    expect(envelope.renderedErr).toContain('nothing moved');
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(true);
  });

  it('--target-directory moves every operand there, without asking', async () => {
    store.entries.set(`${HOME}/a.txt`, { type: 'file', content: 'a\n' });
    const envelope: CommandEnvelope = await builtin_mv(['--target-directory', `${LINKED}/inner`, 'a.txt', `${LINKED}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(mockQuestion).not.toHaveBeenCalled();
    expect(store.entries.get(`${LINKED}/inner/a.txt`)?.content).toBe('a\n');
    expect(store.entries.get(`${LINKED}/inner/hello.txt`)?.content).toBe('hello\nworld\n');
  });
});

describe('cat parses as it did', () => {
  it('generates its usage from the grammar', () => {
    expect(commandUsage_render(catCommand)).toBe('cat [--binary] [--no-highlight] [--highlight[=<language>]] <files…>');
  });

  it('--highlight=python names the language; bare --highlight reads empty (infer)', async () => {
    const named: Parsed = await line_parse(catCommand, 'source --highlight=python');
    expect(named.ok && named.args.operands).toEqual({ files: ['source'] });
    expect(named.ok && named.args.options).toEqual({ binary: false, highlight: 'python', noHighlight: false });
    const bare: Parsed = await line_parse(catCommand, '--highlight greet.py');
    // The language is only in the option's own word: greet.py stays a file.
    expect(bare.ok && bare.args.operands).toEqual({ files: ['greet.py'] });
    expect(bare.ok && bare.args.options['highlight']).toBe('');
  });

  it('--no-highlight wins over --highlight, whichever comes last', async () => {
    const source: string = 'def greet():\n    return 42\n';
    store.entries.set(`${HOME}/greet.py`, { type: 'file', content: source });
    expect((await builtin_cat(['--no-highlight', '--highlight=python', 'greet.py'])).rendered).toBe(source);
    expect((await builtin_cat(['--highlight=python', '--no-highlight', 'greet.py'])).rendered).toBe(source);
  });

  it('refuses an option it does not have, before any read', async () => {
    const envelope: CommandEnvelope = await builtin_cat(['-n', `${LINKED}/hello.txt`]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("cat: invalid option -- 'n'; usage: cat ");
    expect(process.exitCode).toBe(1);
    expect(store.calls).toEqual([]);
  });

  it('ends options at --: a file that starts with a dash', async () => {
    store.entries.set(`${HOME}/--binary`, { type: 'file', content: 'dash\n' });
    const envelope: CommandEnvelope = await builtin_cat(['--', '--binary']);
    expect(envelope.rendered).toBe('dash\n');
  });
});

describe('help and holds, from the declaration', () => {
  it('files under Files, with its POSIX note; cat holds nothing, cp and mv the session', () => {
    for (const declaration of [cpCommand, mvCommand, catCommand]) {
      expect(declaration.help.category).toBe('Files');
      expect(declaration.help.posix?.group).toBe('Files');
      expect(declaration.help.examples?.length).toBeGreaterThan(0);
    }
    expect(catCommand.holds).toEqual([]);
    expect(cpCommand.holds).toBeUndefined();
    expect(mvCommand.holds).toBeUndefined();
  });
});
