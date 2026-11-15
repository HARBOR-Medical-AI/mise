/**
 * @file What a line holds of the session while it runs (#1273): a read holds
 * nothing and runs beside anything; `cd` holds the working directory;
 * whatever cannot be read off the line holds the whole session.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { commands_register } from '../src/core/commandRegistry.js';
import { lineHolds_get } from '../src/core/holds.js';
import { coreCommands } from '../src/core/coreCommands.js';
import { holdsStandIn_make } from './support/declarationStandIns.js';

beforeAll((): void => {
  commands_register({ declarations: [holdsStandIn_make('look', []), holdsStandIn_make('move', ['cwd']), holdsStandIn_make('collect', ['cohort'])] });
});

describe('what a line holds', () => {
  it('a read holds nothing, a writer holds what it changes', () => {
    expect(lineHolds_get('look /a')).toEqual([]);
    expect(lineHolds_get('move /b')).toEqual(['cwd']);
  });

  it('a pipe and a semicolon list hold what their commands hold, together', () => {
    expect(lineHolds_get('look /a | look')).toEqual([]);
    expect(lineHolds_get('move /b; collect add x | look').sort()).toEqual(['cohort', 'cwd']);
  });

  it('a command that has not said holds the whole session, and so does the line', () => {
    expect(lineHolds_get('look; pull pacs')).toBe('all');
    expect(lineHolds_get('look | sortable-host-tool')).toBe('all');
  });

  it('an assignment holds what its capture holds; a literal holds nothing', () => {
    expect(lineHolds_get('x=$(look /a)')).toEqual([]);
    expect(lineHolds_get('x=$(pull pacs)')).toBe('all');
    expect(lineHolds_get('x=hello')).toEqual([]);
  });

  it('a host shell, or a capture inside a word, holds the whole session', () => {
    expect(lineHolds_get('!ls')).toBe('all');
    expect(lineHolds_get('look $(move /b)')).toBe('all');
  });

  it('a line sent to the background holds nothing: its joblet takes its own hold', () => {
    expect(lineHolds_get('pull pacs x &')).toEqual([]);
  });

  it('an empty line holds nothing', () => {
    expect(lineHolds_get('')).toEqual([]);
  });
});

describe('what the commands declare', () => {
  it('the core\'s reads hold nothing and cd holds the working directory', () => {
    // ls holds what its declaration says.
    expect(coreCommands.declarations?.find((declaration) => declaration.name === 'ls')?.holds).toEqual([]);
    expect(coreCommands.declarations?.find((declaration) => declaration.name === 'cat')?.holds).toEqual([]);
    expect(coreCommands.declarations?.find((declaration) => declaration.name === 'cd')?.holds).toEqual(['cwd']);
    expect(coreCommands.holds?.play).toBeUndefined();
  });
});
