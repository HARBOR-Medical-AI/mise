/**
 * @file The command registry keeps names in registration order, lets a later
 * registration replace an earlier, answers each declared name with both
 * forms of handler, and keeps a shell word's page with no handler.
 */
import { describe, it, expect } from '@jest/globals';
import {
  commands_register,
  envelopeHandler_get,
  plainHandler_get,
  builtinCommand_has,
  envelopeCommand_names,
  plainCommand_names,
  commandHelpEntry_get,
  helpTopic_names,
  commandOrder_set,
} from '../src/core/commandRegistry.js';
import { command_declare, type AnyCommandDeclaration } from '../src/core/commandDeclaration.js';

/**
 * A declared command answering one word.
 *
 * @param name - Its name.
 * @param tag - What it answers.
 * @returns The declaration.
 */
const declared = (name: string, tag: string): AnyCommandDeclaration => command_declare({
  name,
  grammar: {},
  help: { summary: tag, description: tag, category: 'General' },
  handler: async () => ({ status: 'ok' as const, rendered: tag }),
});

/**
 * A shell word: a page and no handler.
 *
 * @param name - The word.
 * @returns Its declaration.
 */
const shellWord = (name: string) => ({ name, usage: name, help: { summary: 'u', description: 'd' } });

describe('the command registry', () => {
  it('lists names in the order registered, and a later registration of a name replaces the earlier', async () => {
    commands_register({ declarations: [declared('zz-a', 'first'), declared('zz-b', 'b')] });
    commands_register({ declarations: [declared('zz-a', 'second')] });
    expect(envelopeCommand_names().filter((n: string) => n.startsWith('zz-'))).toEqual(['zz-a', 'zz-b']);
    expect((await envelopeHandler_get('zz-a')?.([]))?.rendered).toBe('second');
  });

  it('answers a declared name with an envelope and a plain handler, either making it a builtin', () => {
    commands_register({ declarations: [declared('zz-plain', 'p')] });
    expect(typeof plainHandler_get('zz-plain')).toBe('function');
    expect(typeof envelopeHandler_get('zz-plain')).toBe('function');
    expect(plainCommand_names()).toContain('zz-plain');
    expect(builtinCommand_has('zz-plain')).toBe(true);
    expect(builtinCommand_has('zz-nothing')).toBe(false);
  });

  it('looks names up as the tables did: a name inherited from Object.prototype counts as a builtin (kept deliberately; changing it is its own decision)', () => {
    expect(builtinCommand_has('toString')).toBe(true);
    expect(typeof plainHandler_get('constructor')).toBe('function');
  });

  it('keeps a shell word\'s page and no handler: its name lists with the builtins /bin lists, in registration order', () => {
    commands_register({ shellWords: [shellWord('zz-help'), shellWord('zz-help2')] });
    expect(commandHelpEntry_get('zz-help')).toEqual({ usage: 'zz-help', summary: 'u', description: 'd' });
    expect(builtinCommand_has('zz-help')).toBe(false);
    const names: string[] = helpTopic_names().filter((n: string) => n.startsWith('zz-help'));
    expect(names).toEqual(['zz-help', 'zz-help2']);
    expect(commandHelpEntry_get('zz-none')).toBeUndefined();
  });

  it('lists in the order set, apart from which group registered a name; an unlisted name lists after, in registration order', () => {
    commands_register({ shellWords: [shellWord('zz-o-late')] });
    commands_register({ shellWords: [shellWord('zz-o-early'), shellWord('zz-o-new')] });
    commandOrder_set({ help: ['zz-o-early', 'zz-o-late'] });
    const names: string[] = helpTopic_names().filter((n: string) => n.startsWith('zz-o-'));
    expect(names).toEqual(['zz-o-early', 'zz-o-late', 'zz-o-new']);
  });
});

describe('a backend beside the core', () => {
  it('adds its commands, and may not replace one of the core\'s', () => {
    commands_register({ declarations: [declared('corecmd', 'core')] });
    commands_register({ declarations: [declared('backendcmd', 'backend')] }, 'backend');
    expect(builtinCommand_has('backendcmd')).toBe(true);
    expect(() => commands_register({ declarations: [declared('corecmd', 'theirs')] }, 'backend'))
      .toThrow("a backend cannot replace the core's commands: corecmd");
  });
});
