import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';
import { commands_register } from '../src/core/commandRegistry.js';
import { backend_install } from '../src/core/backend.js';
import { chrisHelp_install, declarations_install, everyVerb_install } from './support/chrisHelp.js';
import {
  text_boxFormat,
  commandHelp_get,
  help_render,
  pluginExecutableHelp_render,
  pipelineExecutableHelp_render,
  args_checkHasHelpFlag,
  builtin_help,
  builtinCommands_list,
  builtinCommand_descriptionGet,
} from '../src/builtins/help.js';

// The core's declared commands (ls) carry their help in their declarations.
declarations_install();

let logSpy: jest.SpiedFunction<typeof console.log>;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

describe('text_boxFormat', () => {
  it('indents a short string on a single line', () => {
    expect(text_boxFormat('hello', 78, 2)).toBe('  hello');
  });

  it('honours a custom indent', () => {
    expect(text_boxFormat('x', 78, 4)).toBe('    x');
  });

  it('wraps words that exceed the content width', () => {
    expect(text_boxFormat('aaa bbb ccc', 10, 0)).toBe('aaa bbb\nccc');
  });

  it('collapses runs of whitespace', () => {
    expect(text_boxFormat('a    b', 78, 0)).toBe('a b');
  });
});

describe('commandHelp_get', () => {
  it('renders the sections for a known command', () => {
    const help = commandHelp_get('ls');
    expect(help).toBeDefined();
    expect(help).toContain('LS');
    expect(help).toContain('USAGE');
    expect(help).toContain('DESCRIPTION');
  });

  it('returns undefined for an unknown command', () => {
    expect(commandHelp_get('nonexistentcmd')).toBeUndefined();
  });
});

describe('help_render', () => {
  it('returns the rendered help for a known command', () => {
    expect(help_render('ls')).toContain('USAGE');
  });

  it('notes when no help exists', () => {
    expect(help_render('nonexistentcmd')).toContain('No help available');
  });

  it('renders dynamic pipeline executable operations', () => {
    const help: string = pipelineExecutableHelp_render('example_pipeline_id42');
    expect(help).toContain('example_pipeline_id42');
    expect(help).toContain('--diagram --withargs');
    expect(help).toContain('--signalflow');
    expect(help).toContain('--manifest');
    expect(help).toContain('--source, --readme');
  });

  it('renders dynamic plugin executable operations', () => {
    const help: string = pluginExecutableHelp_render('pl-dircopy-v2.1.3');
    expect(help).toContain('pl-dircopy-v2.1.3');
    expect(help).toContain('--parameters');
    expect(help).toContain('--readme --raw');
  });
});

describe('args_checkHasHelpFlag', () => {
  it('detects --help', () => {
    expect(args_checkHasHelpFlag(['--help'])).toBe(true);
  });

  it('detects -h by default', () => {
    expect(args_checkHasHelpFlag(['-h'])).toBe(true);
  });

  it('treats -h as human-readable for ls and du', () => {
    expect(args_checkHasHelpFlag(['-h'], 'ls')).toBe(false);
    expect(args_checkHasHelpFlag(['-h'], 'du')).toBe(false);
  });

  it('does not treat --help as help for a plugin-executable name', () => {
    expect(args_checkHasHelpFlag(['--help'], 'pl-dircopy-v1.0')).toBe(false);
  });

  it('returns false with no flags', () => {
    expect(args_checkHasHelpFlag([])).toBe(false);
  });
});

describe('builtin_help in a session with nothing of its own', () => {
  it('lists only what the shell answers, and has no page for a verb it cannot run', async () => {
    // Nothing of its own to run: no section of commands, only the Shell.
    const envelope = await builtin_help([]);
    expect(envelope.rendered).toContain('chell — the ChRIS shell');
    expect(envelope.rendered).not.toContain('sudo');
    expect(envelope.rendered).not.toContain('Imaging');
    // cat has a help entry and no handler here (cd and ls, declared, bring both).
    expect((await builtin_help(['cat'])).rendered).toContain("No help available for 'cat'");
  });
});

describe('builtin_help in a session that has the verbs', () => {
  beforeAll(() => {
    const ran = async (): Promise<CommandEnvelope> => ({ status: 'ok', rendered: '' });
    commands_register({ envelope: { ls: ran, image: ran, dcm: ran } });
    chrisHelp_install();
    backend_install({
      id: 'test',
      session: {
        init: async () => undefined, identity_get: async () => ({ user: 'u', where: 'w', connected: true }),
        user_get: async () => 'u', home_get: async () => '/home/u', cwd_load: async () => null, cwd_save: async () => undefined,
      },
      elevate: async (_credentials, run) => run(),
      fallback: { help: async (name: string) => (/-v[^/]+$/.test(name) ? pluginExecutableHelp_render(name) : null) },
    });
  });

  it('lists sections with their commands, sudo among them when the backend can elevate', async () => {
    expect((await builtin_help([])).rendered).toContain('Navigation');
    expect((await builtin_help(['Admin'])).rendered).toContain('sudo');
  });

  it('shows a specific command help when named', async () => {
    const envelope = await builtin_help(['ls']);
    expect(envelope.rendered).toContain('USAGE');
  });

  it('lists the imaging commands in their own section', async () => {
    expect((await builtin_help([])).rendered).toContain('Imaging');
    const envelope = await builtin_help(['Imaging']);
    // A summary, not the whole description, on the listing line.
    expect(envelope.rendered).toContain('Show a DICOM series or a volume');
  });

  it('asks the backend for a name that is not a verb (ChRIS: a plugin version)', async () => {
    const envelope = await builtin_help(['pl-dircopy-v2.1.3']);
    expect(envelope.rendered).toContain('pl-dircopy-v2.1.3');
    expect(envelope.rendered).toContain('--parameters');
    expect((await builtin_help(['nosuch'])).rendered).toContain("No help available for 'nosuch'");
  });
});

describe('help metadata accessors', () => {
  beforeAll(() => {
    chrisHelp_install();
    everyVerb_install();
  });

  it('lists the known builtin commands', () => {
    const commands = builtinCommands_list();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).toContain('ls');
    expect(commands).toContain('cd');
    // `image` is a listable command, so tab-completion offers it.
    expect(commands).toContain('image');
  });

  it('returns a description for a known command', () => {
    expect(typeof builtinCommand_descriptionGet('ls')).toBe('string');
  });

  it('returns undefined for an unknown command description', () => {
    expect(builtinCommand_descriptionGet('nonexistentcmd')).toBeUndefined();
  });
});

describe('apropos and man', () => {
  it('apropos finds by a word, says nothing appropriate (exit 1), and man is help by its Unix name', async () => {
    const { builtin_apropos, builtin_man } = await import('../src/builtins/sys/apropos.js');
    expect((await builtin_apropos(['dicom'])).rendered).toContain('image');
    expect((await builtin_apropos([])).status).toBe('error');
    process.exitCode = 0;
    expect((await builtin_apropos(['zzzq-nothing'])).rendered).toContain('nothing appropriate');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect((await builtin_man(['-k', 'dicom'])).rendered).toContain('image');
    expect((await builtin_man(['ls'])).rendered).toContain('USAGE');
    expect((await builtin_man([])).status).toBe('error');
  });
});
