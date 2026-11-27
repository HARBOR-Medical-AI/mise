/**
 * @file A word ARGUS quotes is the word the kernel reads back (#1258).
 *
 * ARGUS writes lines the kernel parses: an EDIT save, a cohort's `gather
 * add`, a tag. Its quoting once followed a reading of backslashes the kernel
 * no longer has, and every save of a backslash doubled it. This feeds the
 * quoted word through the kernel's own word parser, so the two cannot drift.
 */
import { describe, it, expect } from '@jest/globals';
import { arg_quote } from '@fnndsc/menu';
import { saveLine_compose } from '../../src/features/edit/line.js';
import { args_tokenize } from '../../../../packages/brasa/src/lib/parser.js';

const WORDS: ReadonlyArray<string> = [
  'plain',
  "it's",
  "'''",
  'a\\b',
  'C:\\Users\\x',
  '\\section{x} $\\alpha$',
  'l1; a | b > c\nl2 $HOME @1 ${gather}',
  '"double" and \'single\'',
  '\\',
  '',
];

describe('arg_quote', () => {
  it.each(WORDS)('quotes %j so the kernel reads it back unchanged', (word: string) => {
    expect(args_tokenize(`touch ${arg_quote(word)}`)).toEqual(['touch', word]);
  });

  it('writes a save line whose text and path read back whole', () => {
    const text: string = "regex: \\.mgz$\nit's done\n";
    const words: string[] = args_tokenize(saveLine_compose("/home/u/it's.txt", text));
    expect(words).toEqual(['touch', `--withContents=${text}`, "/home/u/it's.txt"]);
  });
});
