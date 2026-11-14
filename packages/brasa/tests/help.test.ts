import { describe, it, expect } from '@jest/globals';
import { chrisHelp, RESOURCE_LIST_OPTIONS } from '../src/chris/help.js';


/**
 * Resources not yet declared in one record, whose help pages carry the
 * Resource Contract: list, search, inspect via RESOURCE_LIST_OPTIONS. A
 * declared resource carries it in its grammar (res-builtins.test.ts).
 */
const RESOURCE_COMMANDS = ['plugins', 'pipeline'];

describe('RESOURCE_LIST_OPTIONS', () => {
  it('contains standard subcommands', () => {
    const joined = RESOURCE_LIST_OPTIONS.join('\n');
    expect(joined).toContain('list');
    expect(joined).toContain('search');
    expect(joined).toContain('inspect');
  });

  it('contains standard options', () => {
    const joined = RESOURCE_LIST_OPTIONS.join('\n');
    expect(joined).toContain('--all');
    expect(joined).toContain('--limit');
    expect(joined).toContain('--fields');
    expect(joined).toContain('--sort');
    expect(joined).toContain('--table');
    expect(joined).toContain('--csv');
  });
});

describe('chrisHelp resource entries', () => {
  it('every resource command has a help entry', () => {
    for (const cmd of RESOURCE_COMMANDS) {
      expect(chrisHelp[cmd]).toBeDefined();
    }
  });

  it('every resource help entry injects RESOURCE_LIST_OPTIONS', () => {
    for (const cmd of RESOURCE_COMMANDS) {
      const entry = chrisHelp[cmd];
      if (!entry?.options) continue;
      const joined = entry.options.join('\n');
      expect(joined).toContain('--all');
      expect(joined).toContain('--limit');
      expect(joined).toContain('inspect');
    }
  });

  it('no resource entry still uses "fieldslist"', () => {
    for (const [cmd, entry] of Object.entries(chrisHelp)) {
      if (!RESOURCE_COMMANDS.includes(cmd)) continue;
      const text = [...(entry.options ?? []), ...(entry.examples ?? [])].join('\n');
      expect(text).not.toContain('fieldslist');
    }
  });

  it('[admin] marker present on privileged subcommands', () => {
    const adminCommands: Record<string, string[]> = {
      plugins: ['add', 'delete'],
    };
    for (const [cmd, subs] of Object.entries(adminCommands)) {
      const entry = chrisHelp[cmd];
      const text = (entry?.options ?? []).join('\n');
      for (const sub of subs) {
        expect(text).toContain(`[admin]`);
        expect(text).toContain(sub);
      }
    }
  });
});

// id's help is its declaration's: commandDeclarations-navigation.test.ts.
