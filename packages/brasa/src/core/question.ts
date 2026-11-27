/**
 * @file Shared question helpers for builtins.
 *
 * Thin adapters over the active {@link Surface}'s prompt operation. Builtins
 * (and the salsa admin-prompt flow, which is handed these functions) call
 * `repl_question` / `repl_questionHidden` and remain unaware of how the host
 * actually reads input — a local readline interface, or a request to a remote
 * surface. The host installs the surface (see `./cliSurface.js`); until it
 * does, the default surface fails these calls with a clear message rather
 * than hanging on a standard input that is not there.
 *
 * @module
 */

import { surface_get, type PromptKind, type PromptPath } from './surface.js';

/**
 * Asks a question through the active surface.
 *
 * @param prompt - The question string to display.
 * @returns The trimmed user answer.
 */
export function repl_question(prompt: string): Promise<string> {
  return surface_get().prompt({ message: prompt });
}

/**
 * What a question is for and about, beyond its wording: a name the command
 * and a surface share, and the things it concerns. A surface matches these
 * to know which question it has been asked.
 *
 * @example
 * ```ts
 * await repl_confirm('Build store?', { purpose: 'stratus.vm.build', subject: { vm: 'store' } });
 * ```
 */
export interface QuestionAbout {
  /** What the question is for (`stratus.vm.build`). */
  purpose: string;
  /** What it is about, by name (`vm`, `account`). */
  subject?: Record<string, string>;
}

/**
 * Asks for a secret (no echo) through the active surface.
 *
 * @param prompt - The prompt string to display.
 * @param about - What the question is for and about, for a surface that knows it.
 * @returns The trimmed secret string.
 */
export function repl_questionHidden(prompt: string, about?: QuestionAbout): Promise<string> {
  return surface_get().prompt({ message: prompt, hidden: true, ...about });
}

/**
 * Asks for a yes/no through the active surface.
 *
 * The kind travels so a surface can offer two capsules rather than make an
 * operator type a letter; a terminal still reads `y`/`n`, and the answer is
 * interpreted here so every caller agrees on what counts as yes.
 *
 * @param prompt - The question string to display.
 * @param about - What the question is for and about, for a surface that knows it.
 * @returns True when the answer was yes.
 */
export async function repl_confirm(prompt: string, about?: QuestionAbout): Promise<boolean> {
  const answer: string = await surface_get().prompt({ message: prompt, wants: 'confirm', ...about });
  const said: string = answer.trim().toLowerCase();
  return said === 'y' || said === 'yes';
}

/**
 * Asks for a location through the active surface.
 *
 * The anchor is a fact the kernel knows — the session's own cwd, the
 * directory a command is already working in — never a directory invented
 * for the occasion, since inventing one means creating it behind the
 * operator's back.
 *
 * @param prompt - The question string to display.
 * @param details - Where to start, whether a directory is wanted, and a
 *   basename to offer.
 * @param commit - The word the committing control should read.
 * @returns The location the operator gave.
 */
export function repl_questionPath(
  prompt: string,
  details: PromptPath,
  commit?: string,
): Promise<string> {
  const wants: PromptKind = 'path';
  return surface_get().prompt({
    message: prompt,
    wants,
    path: details,
    ...(commit === undefined ? {} : { commit }),
  });
}
