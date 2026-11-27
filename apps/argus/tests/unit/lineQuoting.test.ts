/**
 * @file A line a surface builds from a value carries the value as one word,
 * itself.
 *
 * Each line is read by the kernel's own tokeniser, and by the surface's
 * splitter, which must agree.
 */
import { describe, it, expect } from '@jest/globals';
import { arg_quote, line_split as surface_split } from '@fnndsc/menu';
import { args_tokenize } from '../../../../packages/brasa/src/lib/parser.js';
import { editLine_compose, saveLine_compose } from '../../src/features/edit/line.js';
import { runLine_compose, runLine_executable, runLine_flagGet, runLine_flagSet, runLine_titleAppend } from '../../src/features/files/runLine.js';
import { scriptWord_write } from '../../src/features/script/model.js';
import { holderLine_format } from '../../src/app/access.js';
import { tagLines_compose } from '../../src/app/tags.js';

/**
 * A line's words, as the kernel's own tokeniser reads them; the surface's splitter must read the same.
 *
 * @param line - The line.
 * @returns Its words.
 */
function line_split(line: string): string[] {
  const words: string[] = [...args_tokenize(line)];
  expect(surface_split(line)).toEqual(words);
  return words;
}

/** Values that are grammar when left bare, or that double quotes do not hold. */
const HOSTILE: string[] = ['two words', 'a"b', "it's", '$HOME', '${a.b}', 'a;b', 'a|b', 'a>b', '*', '@SER1', 'line one\nline two', 'a\'"$;|>&*\n\\'];

describe('a line built from a value carries it as one word', () => {
  it('an editor\'s save and open', () => {
    for (const value of HOSTILE) {
      expect(line_split(saveLine_compose(`/home/u/${value}`, value))).toEqual(['touch', `--withContents=${value}`, `/home/u/${value}`]);
      expect(line_split(editLine_compose(`/home/u/${value}`))).toEqual(['edit', `/home/u/${value}`]);
    }
  });

  it('a run line: the folder it stands in, a flag\'s value written and read back, the title', () => {
    for (const value of HOSTILE) {
      const base: string = runLine_compose(`/home/u/${value}`, 'pl-x');
      // The `;` after the folder is the line's own grammar; the folder before it is one word.
      expect(base.endsWith('; pl-x')).toBe(true);
      expect(line_split(base.slice(0, -'; pl-x'.length))).toEqual(['cd', `/home/u/${value}`]);
      const flagged: string = runLine_flagSet('cd /x; pl-x --keep 1', '--prefix', value);
      expect(runLine_flagGet(flagged, '--prefix')).toBe(value);
      expect(runLine_flagGet(flagged, '--keep')).toBe('1');
      expect(line_split(flagged)).toEqual(['cd', '/x;', 'pl-x', '--keep', '1', '--prefix', value]);
      expect(line_split(runLine_titleAppend('pl-x', value))).toEqual(['pl-x', '--', `feed_title=${value}`]);
    }
  });

  it('a hand-typed double-quoted value on a run line is still read back, and still stands when another flag is set', () => {
    const typed: string = 'cd "/x y"; pl-x --prefix "old one"';
    expect(runLine_flagGet(typed, '--prefix')).toBe('old one');
    expect(runLine_flagSet(typed, '--n', '3')).toBe('cd "/x y"; pl-x --prefix "old one" --n 3');
  });

  it('the executable of a run line is its last command\'s first word, whatever the folder before it holds: a flag edited by hand is kept by RUN', () => {
    for (const folder of ['/home/u/plain', '/home/u/line one\nline two', '/home/u/a;b', "/home/u/it's -- here"]) {
      const edited: string = runLine_flagSet(runLine_compose(folder, 'pl-simpledsapp-v2.1.5'), '--prefix', 'mine-');
      // RUN keeps the line the strip holds when its executable is the bound one (main.ts), and rebuilds it otherwise.
      expect(runLine_executable(edited)).toBe('pl-simpledsapp-v2.1.5');
      expect(runLine_flagGet(edited, '--prefix')).toBe('mine-');
    }
    expect(runLine_executable('')).toBe('');
    expect(runLine_executable('pl-x --n 1 -- feed_title=T')).toBe('pl-x');
  });

  it('a holder withdrawn, and a tag set', () => {
    for (const value of HOSTILE) {
      expect(line_split(holderLine_format(7, { kind: 'user', name: value }))).toEqual(['setfacl', '-x', `u:${value}`, 'feed_7']);
      expect(tagLines_compose(7, value, []).map((line: string): string[] => line_split(line))).toEqual([['mkdir', `/proc/tags/${value}`], ['setfattr', '-n', 'tag', '-v', value, 'feed_7']]);
    }
  });

  it('a script\'s word: the operator\'s grammar stays, and what cannot have been typed bare is quoted', () => {
    for (const grammar of ['$name', '@SER1', '~/x', '*.dcm', '--cidr=10.0.0.0/16', 'store']) expect(scriptWord_write(grammar)).toBe(grammar);
    for (const value of ['two words', 'a;b', 'a|b', 'a>b', "it's", 'a"b', 'a\\b', '']) expect(scriptWord_write(value)).toBe(arg_quote(value));
  });
});
