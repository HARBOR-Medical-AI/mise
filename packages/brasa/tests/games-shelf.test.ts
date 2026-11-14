/**
 * @file The games shelf: `help games` lists the commands that exist, by
 * category, and never one that has not landed.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import { GAMES_SHELF, gamesShelf_names, gamesShelf_render } from '../src/builtins/games/shelf.js';
import { builtin_help, commandSummary_get } from '../src/builtins/help.js';
import { chrisHelp_install } from './support/chrisHelp.js';
import { commandHelpEntry_get, commands_register } from '../src/core/commandRegistry.js';
import { dateCommand } from '../src/builtins/sys/date.js';
import { fortuneCommand } from '../src/builtins/sys/fortune.js';
import { calCommand } from '../src/builtins/sys/cal.js';
import { weatherCommand } from '../src/builtins/sys/weather.js';

// `motd` reads the session's index, which this suite never reaches.
cuminMock_install(() => ({ procCache_get: jest.fn() }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: jest.fn() }));
const { motdCommand } = await import('../src/builtins/sys/motd.js');

// The shelf as a ChRIS session has it: `motd` and the lab's tools are ChRIS's.
chrisHelp_install();
// The shelf's commands are declared: their help is their declarations'.
commands_register({ declarations: [dateCommand, fortuneCommand, calCommand, weatherCommand] });
commands_register({ declarations: [motdCommand] }, 'backend');

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('the games shelf', () => {
  it('names each command once', () => {
    const all: string[] = GAMES_SHELF.flatMap((c) => [...c.commands]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('lists only commands with a help entry, and lists every one of those it names', () => {
    const names: string[] = gamesShelf_names(commandSummary_get);
    for (const name of names) expect(commandHelpEntry_get(name)).toBeDefined();
    const shelved: Set<string> = new Set(GAMES_SHELF.flatMap((c) => [...c.commands]));
    for (const name of ['fortune', 'cal', 'date', 'weather', 'motd']) {
      expect(shelved.has(name)).toBe(true);
      expect(names).toContain(name);
    }
  });

  it('renders the page by category with each command and its summary, leaving a category with nothing landed off', () => {
    const page: string = plain(gamesShelf_render((command: string): string | undefined => (command === 'fortune' ? 'Print a random fortune' : undefined)));
    expect(page).toContain('/usr/games');
    expect(page).toContain('Text toys');
    expect(page).toMatch(/fortune\s+Print a random fortune/);
    expect(page).not.toContain('Time and sky');
    // The note mentions cowsay by name; the rows must not list it before it lands.
    expect(page).not.toMatch(/^\s{2}cowsay\b/m);
  });

  it('answers help games with the page, and bare help points at it', async () => {
    const page: string = plain((await builtin_help(['games'])).rendered);
    expect(page).toContain('Time and sky');
    expect(page).toMatch(/weather\s+/);
    const bare: string = plain((await builtin_help([])).rendered);
    expect(bare).toContain('Games');
  });
});
