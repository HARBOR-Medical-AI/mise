/**
 * @file `wtf`: what an acronym means, from the book in `wtf.data.ts`.
 *
 * `wtf is lonk`, `wtf lonk`, `wtf cube pfdcm`. A term the book lacks is
 * said so; `wtf -l` lists every term it has.
 *
 * @module
 */
import chalk from 'chalk';
import { ACRONYMS } from './wtf.data.js';
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The meanings of a term, or none. */
export function wtf_lookup(term: string): ReadonlyArray<string> {
  const key: string = term.trim().toLowerCase().replace(/[?.!,]+$/, '');
  return ACRONYMS[key] ?? ACRONYMS[key.replace(/-/g, '')] ?? [];
}

/** What a `wtf` line may hold. */
const WTF_GRAMMAR = {
  operands: [{ name: 'terms', kind: 'word', optional: true, repeat: true, summary: 'The terms to look up, after an optional "is"' }],
  options: {
    list: { short: 'l', long: 'list', summary: 'Every term in the book' },
  },
} as const satisfies CommandGrammar;

/**
 * `wtf [is] <term>... | wtf -l`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [wtfCommand] });
 * ```
 */
export const wtfCommand = command_declare({
  name: 'wtf',
  grammar: WTF_GRAMMAR,
  help: {
    summary: 'What an acronym means: wtf is lonk',
    description: 'BSD\'s acronym expander with the lab\'s own book: ChRIS, CUBE, pfdcm, oxidicom, LONK, PACS, DICOM, MRN, SeaGaP, the mise packages and more. A term the book lacks is said so; -l lists every term it has.',
    examples: ['wtf is lonk', 'wtf cube pfdcm', 'wtf -l'],
  },
  handler: async (args: CommandArguments<typeof WTF_GRAMMAR>): Promise<CommandEnvelope> => (args.options.list ? wtfList_run() : wtf_run(args.operands.terms)),
});

/**
 * `wtf` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `wtf`.
 * @returns The meanings, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_wtf(['is', 'lonk']);
 * ```
 */
export async function builtin_wtf(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(wtfCommand, args);
}

/**
 * Lists every term in the book.
 *
 * @returns The terms on one line.
 *
 * @example
 * ```ts
 * await wtfList_run();
 * ```
 */
export async function wtfList_run(): Promise<CommandEnvelope> {
  const terms: string[] = Object.keys(ACRONYMS).sort();
  return envelope_ok(`${terms.join('  ')}\n`, { kind: 'games.wtf', data: { terms } });
}

/**
 * Looks up the piped terms, else the words given.
 *
 * @param terms - The words given, an `is` or an article among them dropped.
 * @returns Each term's meanings, or a refusal when there is no term.
 *
 * @example
 * ```ts
 * await wtf_run(['is', 'lonk']);
 * ```
 */
export async function wtf_run(terms: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const text: string | null = text_input(terms);
  const words: string[] = (text ?? '').trim().split(/\s+/).filter((w: string): boolean => w.length > 0 && !/^(is|are|the|a|an)$/i.test(w));
  if (words.length === 0) return envelope_error('', undefined, 'wtf: usage: wtf [is] <term>   (wtf -l lists the terms)\n');
  const lines: string[] = [];
  const found: Record<string, ReadonlyArray<string>> = {};
  for (const word of words) {
    const meanings: ReadonlyArray<string> = wtf_lookup(word);
    if (meanings.length === 0) {
      lines.push(`${chalk.cyan(word.toUpperCase())}: ${chalk.gray('nothing known. Gee... I don\'t know what that means (wtf -l lists what I do)')}`);
      continue;
    }
    found[word.toLowerCase()] = meanings;
    // A meaning names its term first; the term is lit rather than repeated.
    for (const meaning of meanings) {
      const dash: number = meaning.indexOf(' — ');
      lines.push(dash > 0 ? `${chalk.cyan(meaning.slice(0, dash))} — ${meaning.slice(dash + 3)}` : `${chalk.cyan(word.toUpperCase())}: ${meaning}`);
    }
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.wtf', data: { terms: words, found } });
}
