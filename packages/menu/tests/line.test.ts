/**
 * @file A value written into a line comes back as one word, as it was.
 */
import { describe, it, expect } from '@jest/globals';
import { arg_quote, home_path, line_split, path_quote, line_tokens, path_write, script_commands, script_lines, word_write } from '../src/line.js';

/** Values that are grammar to a shell when left bare. */
const HOSTILE: string[] = [
  '', 'plain', 'two words', 'a"b', "it's", "''", '$HOME', '${a.b}', 'a;b', 'a|b', 'a>b', 'a&&b', '*', '?[x]', '@SER1', '%3', '~/x', '~', 'a\\b', 'line one\nline two', '\t tab', 'né 日本', '-flag', 'a\'"$;|>&*\n\\',
];

describe('arg_quote', () => {
  it('writes any value so that it reads back as one word, itself', () => {
    for (const value of HOSTILE) {
      expect(line_split(`verb ${arg_quote(value)} tail`)).toEqual(['verb', value, 'tail']);
    }
  });

  it('always quotes, and writes a single quote as a closed, escaped, reopened one', () => {
    expect(arg_quote('plain')).toBe("'plain'");
    expect(arg_quote("it's")).toBe("'it'\\''s'");
    expect(arg_quote('')).toBe("''");
  });
});

describe('word_write', () => {
  it('leaves one plain word bare, quotes anything else, and reads back the same either way', () => {
    expect(word_write('ada@example.org')).toBe('ada@example.org');
    expect(word_write('/home/u/a.txt')).toBe('/home/u/a.txt');
    expect(word_write('key=value,other')).toBe('key=value,other');
    for (const grammar of ['@SER1', '%3', '-flag', '~/x', '$HOME', 'a b', 'a;b', '', "it's", '*']) expect(word_write(grammar)).toBe(arg_quote(grammar));
    for (const value of HOSTILE) expect(line_split(`verb ${word_write(value)} tail`)).toEqual(['verb', value, 'tail']);
  });
});

describe('path_quote and home_path', () => {
  it('writes a path that literally begins with a tilde from where one stands, never as the home', () => {
    expect(path_quote('~/x')).toBe("'./~/x'");
    expect(path_quote('~')).toBe("'./~'");
    expect(path_quote('/home/u/a b')).toBe("'/home/u/a b'");
    expect(path_quote('rel/~x')).toBe("'rel/~x'");
  });

  it('leaves a plain path bare for the reader, and quotes any other as path_quote does', () => {
    expect(path_write('/scripts/vm/store.mise')).toBe('/scripts/vm/store.mise');
    expect(path_write('/home/u/my notes')).toBe("'/home/u/my notes'");
    expect(path_write('~/x')).toBe("'./~/x'");
    expect(path_write('/a/$b')).toBe("'/a/$b'");
  });

  it('writes the home with the tilde outside the quotes', () => {
    expect(home_path('')).toBe('~');
    expect(home_path('gather/my set.json')).toBe("~/'gather/my set.json'");
    expect(home_path('gather/a.json')).toBe('~/gather/a.json');
    expect(home_path('-x')).toBe("~/'-x'");
    expect(line_split(`ls ${home_path("it's")}`)).toEqual(['ls', "~/it's"]);
  });
});

describe('line_split', () => {
  it('splits on whitespace outside quotes only, and keeps an empty quoted word', () => {
    expect(line_split('  a   b\tc ')).toEqual(['a', 'b', 'c']);
    expect(line_split("a '' b")).toEqual(['a', '', 'b']);
    expect(line_split('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(line_split('a b\\ c')).toEqual(['a', 'b c']);
    expect(line_split('')).toEqual([]);
  });

  it('expands nothing, and says when a quote is left open', () => {
    expect(line_split('say "$HOME" \'$HOME\'')).toEqual(['say', '$HOME', '$HOME']);
    expect(line_split('say "a \\" b"')).toEqual(['say', 'a " b']);
    expect(line_split("open 'never closed")).toBeNull();
    expect(line_split('open "never closed')).toBeNull();
  });
});

describe('script_lines', () => {
  it('ends a line at a newline outside quotes only, so a quoted newline stays in its line', () => {
    expect(script_lines('a\nb')).toEqual(['a', 'b']);
    const held: string = `note ${arg_quote('line one\nline two')}`;
    expect(script_lines(`first\n${held}\nlast`)).toEqual(['first', held, 'last']);
    expect(line_split(script_lines(`first\n${held}\nlast`)[1] ?? '')).toEqual(['note', 'line one\nline two']);
    expect(script_lines('a "x\ny" b\nc')).toEqual(['a "x\ny" b', 'c']);
    expect(script_lines('a \\\nstill a')).toEqual(['a \\\nstill a']);
    expect(script_lines('')).toEqual(['']);
  });

  it('round-trips every hostile value through a script of several lines', () => {
    const script: string = HOSTILE.map((value: string): string => `put ${arg_quote(value)}`).join('\n');
    expect(script_lines(script).map((line: string): string[] | null => line_split(line))).toEqual(HOSTILE.map((value: string): string[] => ['put', value]));
  });
});

describe('comments, commands and tokens', () => {
  it('a comment ends at its own newline: a quote mark in it opens nothing, and the command after it stands', () => {
    expect(script_lines("# it's a note\nfile open /a\n# and \"another\nfile open /b")).toEqual(["# it's a note", 'file open /a', '# and "another', 'file open /b']);
    expect(script_commands("  # it's a note\nfile open /a\n\n# and \"another\n  file open /b  \n")).toEqual(['file open /a', 'file open /b']);
  });

  it('a blank line, an indent or a # inside a quoted value is part of the value, and comes back', () => {
    const folder: string = '/home/u/one\n\n   # not a comment\n  two';
    const script: string = `# note\n\nfile open ${arg_quote(folder)}\nview runs\n`;
    expect(script_commands(script)).toEqual([`file open ${arg_quote(folder)}`, 'view runs']);
    expect(line_split(script_commands(script)[0] ?? '')).toEqual(['file', 'open', folder]);
  });

  it('a line\'s tokens are its words as written, and read back to the same values', () => {
    const line: string = "vm new 'O'\\''Brien'  --note '$x' --n 3";
    expect(line_tokens(line)).toEqual(['vm', 'new', "'O'\\''Brien'", '--note', "'$x'", '--n', '3']);
    expect((line_tokens(line) ?? []).map((token: string): string => line_split(token)?.[0] ?? '')).toEqual(line_split(line));
    expect(line_tokens("open 'never closed")).toBeNull();
  });
});
