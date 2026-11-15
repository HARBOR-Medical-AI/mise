/**
 * @file Every command stratus registers is declared in one record: the
 * registry answers each name from a declaration, each says where `help`
 * lists it, each kind its grammar names is registered (the core's, or
 * stratus's through the backend seam), and each is described as tools.
 * A line is parsed against the grammar, so a bad one is refused before the
 * command runs, and completion reads the same record.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  argumentKind_get, backend_install, commandDeclaration_get, commandHolds_get, commandTools_derive, envelopeCommand_names,
  type AnyCommandDeclaration, type CommandDeclaration, type CommandGrammar, type OperandGrammar, type OptionGrammar,
} from '@fnndsc/brasa/core';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { stratusBackend_make } from '../src/backend.js';
import { ClusterStore } from '../src/cluster/state.js';

/** stratus's commands, as its backend registers them. */
const STRATUS_COMMANDS: ReadonlyArray<string> = ['cluster', 'capacity', 'spend', 'net', 'vm', 'chris', 'scripts'];

/**
 * Every kind a grammar names: its operands', its options' values', its subcommands'.
 *
 * @param grammar - The grammar.
 * @returns The kinds' names.
 */
function grammarKinds_list(grammar: CommandGrammar): string[] {
  const of = (operands: readonly OperandGrammar[] | undefined, options: Readonly<Record<string, OptionGrammar>> | undefined): string[] => [
    ...(operands ?? []).map((operand: OperandGrammar): string => operand.kind),
    ...Object.values(options ?? {}).flatMap((option: OptionGrammar): string[] => (option.value === undefined ? [] : [option.value.kind])),
  ];
  return [
    ...of(grammar.operands, grammar.options),
    ...of(undefined, grammar.bare?.options),
    ...Object.values(grammar.subcommands ?? {}).flatMap((sub) => of(sub.operands, sub.options)),
  ];
}

describe('stratus\'s commands', () => {
  beforeAll(() => {
    const configDir: string = mkdtempSync(path.join(tmpdir(), 'stratus-declared-'));
    const made = stratusBackend_make({ driver: new FakeDriver(fakeCloud_sample()), configDir, store: new ClusterStore(path.join(configDir, 'clusters')) });
    backend_install(made.backend);
  });

  it('are each declared in one record, the registry answering every name from it', () => {
    for (const name of STRATUS_COMMANDS) {
      const declaration: AnyCommandDeclaration | undefined = commandDeclaration_get(name);
      expect(declaration?.name).toBe(name);
      expect(declaration?.grammar).not.toBe('expression');
      expect(['Resources', 'Workflows']).toContain(declaration?.help.category);
    }
    expect(envelopeCommand_names().filter((name: string): boolean => commandDeclaration_get(name) === undefined)).toEqual([]);
  });

  it('name only kinds the session has: the core\'s, or stratus\'s through the backend seam', () => {
    for (const name of STRATUS_COMMANDS) {
      const declaration = commandDeclaration_get(name) as CommandDeclaration;
      for (const kind of grammarKinds_list(declaration.grammar)) expect([name, kind, argumentKind_get(kind)?.name]).toEqual([name, kind, kind]);
    }
  });

  it('keep what they hold: capacity and spend hold nothing, the rest the whole session', () => {
    expect(commandHolds_get('capacity')).toEqual([]);
    expect(commandHolds_get('spend')).toEqual([]);
    for (const name of ['cluster', 'net', 'vm', 'chris', 'scripts']) expect(commandHolds_get(name)).toBeNull();
  });

  it('are described as tools, one per command and subcommand', () => {
    const tools: string[] = STRATUS_COMMANDS.flatMap((name: string): string[] => commandTools_derive(commandDeclaration_get(name) as CommandDeclaration).map((tool) => tool.name));
    expect(tools).toEqual(expect.arrayContaining(['cluster', 'cluster_new', 'cluster_teardown', 'capacity', 'spend', 'net_build', 'vm_new', 'vm_cost', 'chris_deploy', 'chris_user', 'scripts_add']));
  });
});
