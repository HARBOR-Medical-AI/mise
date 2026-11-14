/**
 * @file Declaration check — every command is declared in one record.
 *
 * A command declares itself with `command_declare`
 * (packages/brasa/src/core/commandDeclaration.ts): its name, grammar, kinds,
 * handler, holds and help in one record, registered through its group's
 * `declarations`. The registry answers a name only from a declaration, and
 * the words the shell answers before it (`sudo`, `exit`, `!`, `clear`,
 * `prompt`) have only a page, declared in `core/shellWords.ts`.
 *
 * This holds that shape in the source, a hard check at zero: a command
 * group (`core/coreCommands.ts`, `chris/chrisCommands.ts`) holds nothing
 * but `declarations` and `shellWords`, and the registry's `CommandGroup`
 * has no record that binds a name to a handler of raw words or a page of
 * its own beside a declaration. The runtime side, that every name the
 * engine answers has a declaration behind it, is
 * packages/brasa/tests/helpCategories.test.ts.
 *
 * Enforces "One declaration per command" in docs/principles.adoc. Run via
 * `npm run lint:commands`.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

/** The engine's command groups: the core's and the ChRIS backend's. */
const groupPaths = [
  new URL('../packages/brasa/src/core/coreCommands.ts', import.meta.url).pathname,
  new URL('../packages/brasa/src/chris/chrisCommands.ts', import.meta.url).pathname,
];

/** The registry, whose `CommandGroup` says what a group may hold. */
const registryPath = new URL('../packages/brasa/src/core/commandRegistry.ts', import.meta.url).pathname;

/** What a group may hold. */
const GROUP_KEYS = new Set(['declarations', 'shellWords']);

/** The records that once bound a name beside a declaration. */
const RETIRED_RECORDS = [
  /const envelope: Record<string, EnvelopeHandler> = \{/,
  /const plain: Record<string, CommandHandler> = \{/,
  /const holds: Record<string, readonly SessionPiece\[\]> = \{/,
  /Record<string, CommandHelp> = \{/,
];

const problems = [];

for (const path of groupPaths) {
  const text = readFileSync(path, 'utf8');
  for (const record of RETIRED_RECORDS) {
    if (record.test(text)) problems.push(`${path}: binds names outside a declaration (${record.source})`);
  }
  const group = text.match(/export const \w+: CommandGroup = \{([^}]*)\};/);
  if (group === null) {
    problems.push(`${path}: could not locate its CommandGroup — has the source moved?`);
    continue;
  }
  const keys = [...group[1].matchAll(/^\s*(\w+)\s*(?::|,)/gm)].map((match) => match[1]);
  for (const key of keys) {
    if (!GROUP_KEYS.has(key)) problems.push(`${path}: its group holds '${key}', which is not a declaration`);
  }
}

const registry = readFileSync(registryPath, 'utf8');
const groupType = registry.match(/export interface CommandGroup \{([\s\S]*?)\n\}/);
if (groupType === null) {
  problems.push(`${registryPath}: could not locate CommandGroup — has the source moved?`);
} else {
  for (const field of ['envelope', 'plain', 'help', 'holds']) {
    if (new RegExp(`^\\s*${field}\\?:`, 'm').test(groupType[1])) problems.push(`${registryPath}: CommandGroup takes '${field}', a name bound outside a declaration`);
  }
}

if (problems.length > 0) {
  console.error('command-declarations: a command must be declared in one record (command_declare, core/commandDeclaration.ts)');
  console.error('and registered through its group\'s declarations. See "One declaration per command" in docs/principles.adoc.');
  console.error(problems.map((problem) => `  ${problem}`).join('\n'));
  process.exit(1);
}

console.log(`command-declarations: every command group binds names only through declarations (${groupPaths.length} groups).`);
