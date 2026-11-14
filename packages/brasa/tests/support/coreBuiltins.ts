/**
 * @file Stubs the builtin modules the command groups import one by one.
 *
 * The core group, and the ChRIS group beside its barrel import, take some
 * handlers from the module that defines them. A test that stubs the builtins
 * wholesale stubs those modules too, with the same functions it stubs
 * elsewhere; which modules they are is read from the groups' own imports, so
 * the two cannot drift.
 */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { STAND_IN_MAKERS, wordsStandIn_make, type StandInHandler } from './declarationStandIns.js';

const groupSource: string = ['../../src/core/coreCommands.ts', '../../src/chris/chrisCommands.ts']
  .map((group: string): string => readFileSync(new URL(group, import.meta.url), 'utf8'))
  .join('\n');

/**
 * The functions and constants a builtin module exports, read from its source.
 *
 * @param module - The module's path under `src/builtins`, as imported (`.js`).
 * @returns Its exported names.
 */
function moduleFunctions_read(module: string): string[] {
  const source: string = readFileSync(new URL(`../../src/builtins/${module.replace(/\.js$/, '.ts')}`, import.meta.url), 'utf8');
  return [...source.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((match: RegExpMatchArray): string => match[1]);
}

/** Each builtin module a group imports by name (not the barrel), with what it exports. */
const CORE_MODULES: ReadonlyArray<[string, string[]]> = [...new Set([...groupSource.matchAll(/import \{[^}]*\} from '\.\.\/builtins\/([^']+)';/g)]
  .map((match: RegExpMatchArray): string => match[1])
  .filter((module: string): boolean => module !== 'index.js'))]
  .map((module: string): [string, string[]] => [`../../src/builtins/${module}`, moduleFunctions_read(module)]);

/**
 * The stub for one export: the test's own, else for a declaration
 * (`lsCommand`) its stand-in running the test's `builtin_ls` stub, else a
 * fresh `jest.fn()`.
 *
 * @param name - The export's name.
 * @param stubs - The test's stubs, by export name.
 * @returns The stub.
 */
function export_stub(name: string, stubs: Record<string, unknown>): unknown {
  if (stubs[name] !== undefined) return stubs[name];
  const standIn = STAND_IN_MAKERS[name];
  const command: string = COMMAND_NAMES[name] ?? name.replace(/Command$/, '');
  const builtin: unknown = stubs[`builtin_${command}`];
  if (standIn !== undefined) return standIn((builtin as StandInHandler | undefined) ?? jest.fn());
  // Any other declaration (`echoCommand`) stands in by its name, its words handed to the test's stub.
  if (/^[a-z]\w*Command$/.test(name)) return wordsStandIn_make(command, (builtin as StandInHandler | undefined) ?? jest.fn());
  return jest.fn();
}

/** A declaration whose export cannot spell its command's name (`2048` is no identifier). */
const COMMAND_NAMES: Readonly<Record<string, string>> = { game2048Command: '2048' };

/**
 * Mocks every builtin module the core group imports: a function the test
 * stubs answers with its stub, a declared command stands in (running the
 * test's stub of its builtin with the typed line), any other export is a
 * fresh `jest.fn()`.
 *
 * @param stubs - The test's stubs, by export name.
 */
export function coreBuiltins_mock(stubs: Record<string, unknown>): void {
  for (const [path, names] of CORE_MODULES) {
    jest.unstable_mockModule(path, () => Object.fromEntries(names.map((name: string): [string, unknown] => [name, export_stub(name, stubs)])));
  }
}
