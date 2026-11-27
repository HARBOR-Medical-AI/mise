/**
 * @file A value a surface writes into a line reaches the kernel as one word,
 * itself: the quoting functions of `@fnndsc/menu` against the kernel's own
 * tokeniser, and the kernel's path resolution for the home and a literal
 * tilde.
 */
import { describe, it, expect } from '@jest/globals';
import { arg_quote, home_path, line_split, path_quote, path_write, word_write } from '@fnndsc/menu';
import { shellWords_tokenize, type ShellWord } from '../src/lib/parser.js';
import { path_resolveFrom } from '../src/core/paths.js';

/** Values that are grammar to the shell when left bare. */
const HOSTILE: string[] = [
  '', 'plain', 'two words', 'a"b', "it's", "''", '$HOME', '${a.b}', '$(x)', 'a;b', 'a|b', 'a>b', 'a>>b', 'a&&b', 'a||b', 'a &', '*', '?[x]', '@SER1', '%3', '~/x', '~', 'a\\b', 'line one\nline two', '\t tab', 'né 日本', '-flag', '!host', '#note', 'a\'"$;|>&*\n\\',
];

/** Whether a word is plain text the shell will neither expand nor match against files. */
function word_isLiteral(word: ShellWord): boolean {
  return word.segments === undefined && !word.pathnameExpansion;
}

describe('a quoted value reaches the kernel as itself', () => {
  it.each([['arg_quote', arg_quote], ['word_write', word_write]] as const)('%s: one operand, the value, expanded and matched by nothing', (_name: string, write: (value: string) => string) => {
    for (const value of HOSTILE) {
      const words: ShellWord[] = shellWords_tokenize(`verb ${write(value)} tail`);
      expect(words.map((word: ShellWord): string => word.value)).toEqual(['verb', value, 'tail']);
      expect(word_isLiteral(words[1] as ShellWord)).toBe(true);
    }
  });

  it('what the surface\'s own splitter reads is what the kernel reads, for every writer', () => {
    for (const value of HOSTILE) {
      for (const written of [arg_quote(value), word_write(value), path_quote(value), path_write(value), home_path(value)]) {
        const line: string = `verb ${written} tail`;
        expect(line_split(line)).toEqual(shellWords_tokenize(line).map((word: ShellWord): string => word.value));
      }
    }
  });

  it('bare double quotes, as surfaces wrote before, do not: a name in them is a reference', () => {
    const words: ShellWord[] = shellWords_tokenize('cat "/home/u/$HOME"');
    expect(words[1]?.segments).toBeDefined();
  });
});

describe('the home, and a path that only looks like it', () => {
  const home: string = '/home/ada';
  const cwd: string = '/home/ada/work';
  /** The path the kernel resolves for the one operand a written word carries. */
  const resolved = (written: string): string => path_resolveFrom(shellWords_tokenize(`ls ${written}`)[1]?.value ?? '', home, cwd);

  it('home_path names the home, whatever the rest holds', () => {
    expect(resolved(home_path(''))).toBe('/home/ada');
    expect(resolved(home_path('gather/my set.json'))).toBe('/home/ada/gather/my set.json');
    expect(resolved(home_path("it's $HOME"))).toBe("/home/ada/it's $HOME");
  });

  it('path_quote and path_write name a path that begins with a tilde as the folder it is, never the home', () => {
    for (const write of [path_quote, path_write]) {
      expect(resolved(write('~/x'))).toBe('/home/ada/work/~/x');
      expect(resolved(write('~'))).toBe('/home/ada/work/~');
      expect(resolved(write('/data/a b'))).toBe('/data/a b');
      expect(resolved(write('rel/x'))).toBe('/home/ada/work/rel/x');
    }
  });

  it('a tilde left bare, or merely quoted, is the home: which is why a literal one is written from where one stands', () => {
    expect(resolved('~/x')).toBe('/home/ada/x');
    expect(resolved("'~/x'")).toBe('/home/ada/x');
  });
});
