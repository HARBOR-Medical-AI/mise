/**
 * @file The words the shell or its surface answers before any command does:
 * `sudo` and `exit` (dispatch), `!` (the line's shell escape), `clear` and
 * `prompt` (the surface). None has a handler in the registry, and none
 * parses a grammar of its own: `sudo`'s words are another command's line,
 * `!`'s a host shell's. What each has is its page, declared here in one
 * record, so `help` and `/bin` read it as they read a command's.
 *
 * Key components:
 * - ShellWordDeclaration: one word's record: its name, usage and prose.
 * - SHELL_WORDS: every one, registered with the core's commands.
 *
 * @module
 */
import type { CommandProse } from './commandDeclaration.js';

/**
 * A word the shell answers before the registry: its name, its usage as
 * written (it has no grammar to generate one from), and its help prose.
 *
 * @example
 * ```ts
 * const exitWord: ShellWordDeclaration = { name: 'exit', usage: 'exit', help: { summary: 'Exit the shell', description: 'Exit the shell.' } };
 * ```
 */
export interface ShellWordDeclaration {
  /** The word. */
  readonly name: string;
  /** Its usage line. */
  readonly usage: string;
  /** What `help` says of it. */
  readonly help: CommandProse;
}

/** Every word the shell answers before the registry. */
export const SHELL_WORDS: ReadonlyArray<ShellWordDeclaration> = [
  {
    name: 'sudo',
    usage: 'sudo <command> [arguments...]',
    help: {
      summary: 'Run one ChRIS command with a temporary administrator identity',
      description: 'Run one ChRIS command with a temporary administrator identity. It asks for an administrator username and a hidden password on the active surface. The elevated CUBE token is used only for the nested command; it is not saved or made the session identity.',
      category: 'Admin',
      examples: ['sudo group adduser pacs_users peter.hong', 'sudo plugin add pl-dircopy'],
    },
  },
  {
    name: 'exit',
    usage: 'exit',
    help: { summary: 'Exit the shell', description: 'Exit the shell', category: 'General', examples: ['exit'] },
  },
  {
    name: 'clear',
    usage: 'clear',
    help: {
      summary: 'Empty the console: the screen and its scrollback in a terminal, the record in the transcript',
      description: 'Empty the console: the screen and its scrollback in a terminal, the record in the transcript. Ctrl-L clears the screen alone.',
      category: 'Settings',
      examples: ['clear'],
    },
  },
  {
    name: 'prompt',
    usage: 'prompt [list | <theme>]',
    help: {
      summary: 'List available prompt themes or switch the active theme',
      description: 'List available prompt themes or switch the active theme: list shows every theme and marks the active one; a theme name switches to it at once.',
      category: 'Settings',
      examples: [
        'prompt             # Show current theme',
        'prompt list        # List all themes',
        'prompt default     # Switch to single-line smart-truncation theme',
        'prompt p10k        # Switch to two-line Powerlevel10k-inspired theme',
      ],
    },
  },
  {
    name: '!',
    usage: '! <shell_command>',
    help: {
      summary: 'Execute command on host shell (shell escape)',
      description: 'Execute command on host shell (shell escape)',
      category: 'General',
      examples: [
        '! ls                  # List files on host system',
        '! pwd                 # Print host working directory',
        '! cat /etc/hostname   # Read host file',
        '! df -h               # Check host disk usage',
        '! echo "test" > /tmp/file.txt  # Write to host file',
      ],
    },
  },
];
