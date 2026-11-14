/**
 * @file Command help system.
 *
 * Provides help text for shell commands, and the `help` command itself,
 * declared in one record (`helpCommand`). A declared command's page comes
 * from its declaration; `helpText` holds the pages of the rest.
 *
 * @module
 */
import { variablesPage_render } from './variablesPage.js';
import { HELP_SECTIONS, helpPosix_render, helpSection_render, helpToc_render, section_find, shellTopic_render, type HelpLookup, type HelpSection } from './helpSections.js';
import { gamesShelf_render, gamesShelf_names } from './games/shelf.js';
import chalk from 'chalk';
import { commands_register, commandDeclaration_get, commandHelpEntry_get, helpTopic_names, builtinCommand_has, type CommandHelp } from '../core/commandRegistry.js';
import {
  command_declare, declaration_isParsed,
  type AnyCommandDeclaration, type CommandArguments, type CommandGrammar, type OptionGrammar, type OptionsGrammar, type SubcommandGrammar,
} from '../core/commandDeclaration.js';
import { declaredCommand_run } from '../core/commandParse.js';
import { declarationHelp_derive, subcommandHelp_derive } from '../core/commandUsage.js';
import { backendInstalled_get } from '../core/backend.js';
import type { CommandEnvelope } from '@fnndsc/menu';


/**
 * Help-text registry keyed by builtin command name, for the commands not yet
 * declared in one record: a declared command's help is generated from its
 * declaration, and its entry leaves this table.
 */
export const helpText: Record<string, CommandHelp> = {
  sudo: {
    category: 'Admin',
    usage: 'sudo <command> [arguments...]',
    description: 'Run one ChRIS command with a temporary administrator identity',
    options: [
      'Prompts for an administrator username and hidden password on the active surface.',
      'The elevated CUBE token is used only for the nested command; it is not saved or made the session identity.',
    ],
    examples: [
      'sudo group adduser pacs_users peter.hong',
      'sudo plugin add pl-dircopy',
    ],
  },
  url: {
    category: 'Sharing',
    usage: 'url [path]',
    summary: 'Print a link (a web address) that opens ARGUS at a path, to send to a colleague',
    description: 'Print a web address that opens ARGUS at a path (a feed or node lands in RUNS, anything else in FILES)',
    options: [],
    examples: [
      'url                                   # Where you stand',
      'url /home/sandip.samal/feeds/feed_4389/pl-dicom_repack_639204',
      'url .                                 # Paste it to a colleague the feed is shared with',
      '',
      '# The door comes from CHELL_DOOR; without it the fragment alone is printed.',
    ],
  },
  exit: {
    category: 'General',
    usage: 'exit',
    description: 'Exit the shell',
    examples: ['exit'],
  },
  clear: {
    category: 'Settings',
    usage: 'clear',
    description: 'Empty the console: the screen and its scrollback in a terminal, the record in the transcript. Ctrl-L clears the screen alone.',
    examples: ['clear'],
  },
  prompt: {
    category: 'Settings',
    usage: 'prompt [list | <theme>]',
    description: 'List available prompt themes or switch the active theme',
    options: [
      'list        Show all available themes (marks the active one)',
      '<theme>     Switch to the named theme immediately',
    ],
    examples: [
      'prompt             # Show current theme',
      'prompt list        # List all themes',
      'prompt default     # Switch to single-line smart-truncation theme',
      'prompt p10k        # Switch to two-line Powerlevel10k-inspired theme',
    ],
  },
  '!': {
    category: 'General',
    usage: '! <shell_command>',
    description: 'Execute command on host shell (shell escape)',
    examples: [
      '! ls                  # List files on host system',
      '! pwd                 # Print host working directory',
      '! cat /etc/hostname   # Read host file',
      '! df -h               # Check host disk usage',
      '! echo "test" > /tmp/file.txt  # Write to host file',
    ],
  },
};

// The help is registered with the engine's commands; every reader below goes
// through the registry, never this record.
commands_register({ help: helpText });

/**
 * Displays help text for a command.
 *
 * @param command - The command to display help for.
 */
/**
 * Formats and returns the detailed help text for a specific command as a string.
 *
 * @param command - The command name to retrieve help for.
/**
 * Word-wraps a flat string to fit within a given width, with uniform indentation.
 *
 * @param str    - Input text (single line or freeform).
 * @param width  - Total line width including indent (default 78).
 * @param indent - Leading spaces on every line (default 2).
 * @returns Multi-line string, each line at most `width` chars wide.
 */
export function text_boxFormat(str: string, width: number = 78, indent: number = 2): string {
  const prefix: string = ' '.repeat(indent);
  const maxContent: number = Math.max(1, width - indent);
  const words: string[] = str.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current: string = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxContent) {
      current += ' ' + word;
    } else {
      lines.push(prefix + current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(prefix + current);
  return lines.join('\n');
}

/** Formats one command-help descriptor. */
function commandHelp_render(command: string, help: CommandHelp): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold.magenta(command.toUpperCase()));
  lines.push(chalk.gray('─'.repeat(60)));
  lines.push('');
  
  lines.push(chalk.bold.blue('USAGE'));
  const usageParts: string[] = help.usage.split(' ');
  const cmdName: string = usageParts[0];
  const args: string = usageParts.slice(1).join(' ');
  lines.push(`  ${chalk.green(cmdName)} ${chalk.cyan(args)}`);
  
  lines.push('');
  lines.push(chalk.bold.blue('DESCRIPTION'));
  text_boxFormat(help.description, 78, 2).split('\n').forEach((l: string) => lines.push(l));

  if (help.subcommands && help.subcommands.length > 0) {
    lines.push('');
    lines.push(chalk.bold.blue('SUBCOMMANDS'));
    help.subcommands.forEach((opt: string) => {
      const trimmed: string = opt.trim();
      if (!trimmed) { lines.push(''); return; }
      lines.push(`  ${trimmed}`);
    });
  }

  if (help.options && help.options.length > 0) {
    lines.push('');
    lines.push(chalk.bold.blue('OPTIONS'));
    help.options.forEach((opt: string) => {
      const trimmed: string = opt.trim();
      if (!trimmed) {
        lines.push('');
        return;
      }
      
      // Check if it's a header (ends with :)
      if (trimmed.endsWith(':')) {
        lines.push(`  ${chalk.bold.white(trimmed)}`);
        return;
      }

      // Try to split by double space (common separator in help definitions)
      const splitMatch: RegExpMatchArray | null = opt.match(/^(\s*)(.*?)(\s{2,})(.*)$/);
      
      if (splitMatch) {
        const [, indent, content, separator, description] = splitMatch;
        lines.push(`  ${indent}${chalk.yellow(content)}${separator}${description}`);
      } else {
        // Fallback: check if it starts with -
        if (trimmed.startsWith('-')) {
          lines.push(`  ${chalk.yellow(opt)}`);
        } else {
          lines.push(`  ${opt}`);
        }
      }
    });
  }

  if (help.examples && help.examples.length > 0) {
    lines.push('');
    lines.push(chalk.bold.blue('EXAMPLES'));
    help.examples.forEach((ex: string) => {
      const commentIdx: number = ex.indexOf('#');
      if (commentIdx !== -1) {
        const cmdPart: string = ex.substring(0, commentIdx);
        const commentPart: string = ex.substring(commentIdx);
        lines.push(`  ${chalk.white(cmdPart)}${chalk.gray(commentPart)}`);
      } else {
        lines.push(`  ${chalk.white(ex)}`);
      }
    });
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Gets the formatted help text for a registered command.
 *
 * @param command - Registered builtin command name.
 * @returns The formatted help text string, or undefined if no help exists.
 */
export function commandHelp_get(command: string): string | undefined {
  const declaration: AnyCommandDeclaration | undefined = commandDeclaration_get(command);
  const help: CommandHelp | undefined = declaration !== undefined && declaration_isParsed(declaration)
    ? declarationHelp_derive(declaration)
    : commandHelpEntry_get(command) ?? subcommandHelp_get(command);
  return help ? commandHelp_render(command, help) : undefined;
}

/**
 * A declared command's subcommand's help, for a topic of two words (`pacs query`).
 *
 * @param topic - The topic.
 * @returns The help, or undefined when the topic names no declared subcommand.
 */
function subcommandHelp_get(topic: string): CommandHelp | undefined {
  const words: string[] = topic.split(' ');
  if (words.length !== 2) return undefined;
  const declaration: AnyCommandDeclaration | undefined = commandDeclaration_get(words[0] as string);
  return declaration !== undefined && declaration_isParsed(declaration) ? subcommandHelp_derive(declaration, words[1] as string) : undefined;
}

/**
 * Renders contextual help for one registered pipeline executable.
 *
 * @param name - Pipeline executable name as exposed in `/bin`.
 * @returns Pipeline-specific help text, terminated with a newline.
 */
export function pipelineExecutableHelp_render(name: string): string {
  const help: CommandHelp = {
    usage: `${name} [run options]`,
    description: 'Run or inspect this registered CUBE pipeline.',
    options: [
      'DIAGRAM OUTPUT:',
      '  --diagram               Draw the shallow pipeline topology',
      '  --diagram --withargs    Include stored non-null defaults inline',
      '  --signalflow            Emit SignalFlow YAML',
      '  --diagram --signalflow  Compatible explicit SignalFlow spelling',
      '',
      'INSPECTION:',
      '  --nodes, --parameters   Show pipeline nodes and parameters',
      '  --source, --readme      Show the pipeline YAML source',
      '  --manifest              Emit complete registered invocation YAML',
      '',
      'EXECUTION:',
      '  <dir>                   The input: in a feed, that node; outside one, pl-dircopy roots a new feed of it',
      '  <dir> <dir>…            Several directories: one run each; a wildcard expands in any part of a path',
      '  <file> [as <subject>]…  Files shaped into subjects and rooted as a new feed (operands first on the line)',
      '  --compute <resource>    Override the compute resource',
      '  --previous <inst_id>    Attach to an explicit plugin instance',
      '  --paramFile <cfs-file>  Apply one sparse YAML invocation overlay',
      '  --<node>.<parameter> <value>  Override a hosted parameter',
      '  --<node>.<control> <value>    Override a node execution control',
      '  --verbose               Echo every parameter of every piping before the run',
      '',
      'help operands for the full rules; whatif <line> prints a run and starts nothing.',
    ],
    examples: [
      `${name} --diagram`,
      `${name} --diagram --withargs`,
      `${name} --signalflow | signalflow -`,
      `${name} --source`,
      `${name} --manifest`,
      `${name} --previous 123`,
      `${name} ~/uploads/subjects`,
    ],
  };
  return `${commandHelp_render(name, help)}\n`;
}

/**
 * Renders contextual help for one versioned plugin executable.
 *
 * @param name - Plugin executable name as exposed in `/bin`.
 * @returns Plugin-specific help text, terminated with a newline.
 */
export function pluginExecutableHelp_render(name: string): string {
  const help: CommandHelp = {
    usage: `${name} [<dir> | <file> [as <subject>]…] [plugin options]`,
    description: 'Run this registered CUBE plugin version on an input, or inspect it.',
    options: [
      'INPUT (the operand, first on the line; a flag before it is written with =):',
      '  <dir>              That tree is the input: in a feed, that node; outside one, pl-dircopy roots a new feed of it',
      '  <dir> <dir>…       Several directories: one run each; a wildcard expands in any part of a path',
      '  <file>             One subject named by the stem, the file in it; several files are several subjects',
      '  <file>… as <name>  The files since the last as, as one subject called <name>',
      '  (nothing)          The working directory, as before',
      '  To an fs plugin (pl-dircopy) an operand is its dir, untranslated.',
      '',
      'INSPECTION:',
      '  --parameters   Show parameter definitions for this plugin version',
      '  --readme       Show the rendered plugin README',
      '  --readme --raw Output raw README markdown for piping',
      '',
      'help operands for the full rules; whatif <line> prints a run and starts nothing.',
    ],
    examples: [
      `${name} ~/uploads/subjects`,
      `${name} ~/uploads/t1.nii as sub-01 --threads 2`,
      `${name} --parameters`,
      `${name} --readme`,
      `${name} --readme --raw | glow -`,
    ],
  };
  return `${commandHelp_render(name, help)}\n`;
}

/**
 * Renders a command's help text as a string.
 *
 * The help text is returned as a string so callers can carry it in an envelope
 * and deliver it through the sink, rather than printing to the console — which
 * on a daemon would land on the daemon's terminal instead of the surface.
 *
 * @param command - The command to render help for.
 * @returns The help text, terminated with a newline.
 */
export function help_render(command: string): string {
  const helpStr: string | undefined = commandHelp_get(command);
  if (helpStr !== undefined) {
    return `${helpStr}\n`;
  }
  return helpMissing_render(command);
}

/**
 * The page for a name with no help in this session.
 *
 * @param command - The name asked about.
 * @returns The page.
 */
export function helpMissing_render(command: string): string {
  return `${chalk.yellow(`No help available for '${command}'`)}\n${chalk.gray('Type "help" to see all available commands.')}\n`;
}

/** Words the shell or its surface answers itself, with no handler in the registry. */
const SHELL_WORDS: ReadonlyArray<string> = ['exit', '!', 'help', 'prompt'];

/**
 * Whether this session can run a verb (or a verb's subcommand, `pacs query`):
 * its handler is registered (the core's, or its backend's), or the shell
 * answers it. Help is shown only for what can be run.
 *
 * @param name - The command, perhaps with a subcommand.
 * @returns True when the session has it.
 */
export function verb_available(name: string): boolean {
  const verb: string = name.split(' ')[0] ?? '';
  if (SHELL_WORDS.includes(verb)) return true;
  if (verb === 'sudo') return backendInstalled_get()?.elevate !== undefined;
  return builtinCommand_has(verb);
}

/**
 * Checks if arguments contain --help flag.
 * -h is treated as help unless the command uses it for "human-readable" (ls, du).
 *
 * @param args - Command arguments.
 * @param command - The command name (optional).
 * @returns True if help is requested.
 */
export function args_checkHasHelpFlag(args: string[], command?: string): boolean {
  const isPluginExecutable: boolean = !!command && /-v.+$/.test(command);
  if (!isPluginExecutable && args.includes('--help')) return true;

  // A declared command's -h is help unless its grammar takes -h itself (ls: human sizes).
  const declaration: AnyCommandDeclaration | undefined = command === undefined ? undefined : commandDeclaration_get(command);
  if (declaration !== undefined && declaration_isParsed(declaration)) {
    const groups: OptionsGrammar[] = [
      declaration.grammar.options ?? {},
      declaration.grammar.bare?.options ?? {},
      ...Object.values(declaration.grammar.subcommands ?? {}).map((sub: SubcommandGrammar): OptionsGrammar => sub.options ?? {}),
    ];
    const takesH: boolean = groups.some((group: OptionsGrammar): boolean => Object.values(group).some((option: OptionGrammar): boolean => option.short === 'h'));
    return !takesH && args.includes('-h');
  }

  if (isPluginExecutable) {
    return false;
  }

  return args.includes('-h');
}

/** What a `help` line may hold. */
const HELP_GRAMMAR = {
  operands: [
    { name: 'topic', kind: 'word', optional: true, repeat: true, summary: 'A command, a section or a Shell topic; help pacs query, a subcommand' },
  ],
} as const satisfies CommandGrammar;

/**
 * `help [topic…]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [helpCommand] });
 * ```
 */
export const helpCommand = command_declare({
  name: 'help',
  grammar: HELP_GRAMMAR,
  help: {
    summary: 'Display help information',
    description: 'Display help information',
    category: 'General',
    examples: [
      'help                  # List all commands',
      'help games            # The /usr/games shelf, by category',
      'help ls               # Show help for ls',
      'help timing           # Show help for timing',
    ],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof HELP_GRAMMAR>): Promise<CommandEnvelope> => help_answer(args.operands.topic),
});

/**
 * `help` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `help`.
 * @returns The page, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_help(['ls']);
 * ```
 */
export async function builtin_help(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(helpCommand, args);
}

/**
 * The help page a topic names: bare, the table of contents; else a section,
 * a Shell topic, a command, or what the backend answers for the name.
 *
 * @param topic - The words naming it (two for a subcommand: `pacs query`).
 * @returns The page.
 *
 * @example
 * ```ts
 * await help_answer(['PACS']);
 * ```
 */
export async function help_answer(topic: readonly string[]): Promise<CommandEnvelope> {
  const commandName: string | undefined = topic.length > 0 ? topic.join(' ') : undefined;

  // The variables: the core's page, with whatever the backend keeps too.
  if (commandName === 'variables') {
    const backendPage: string | null = (await backendInstalled_get()?.fallback?.help?.('variables')) ?? null;
    return { status: 'ok', rendered: backendPage ?? variablesPage_render([]) };
  }
  // The shelf: its own page, in the style of this one.
  if (commandName === 'games') {
    return { status: 'ok', rendered: gamesShelf_render(commandSummary_get) };
  }
  // The release notes: `help notes` is `notes`. Loaded on the press, not at
  // import: the notes module reads the wire's model schemas, which this page
  // otherwise never needs.
  if (commandName === 'notes') {
    const { builtin_notes } = await import('./sys/notes.js');
    return builtin_notes([]);
  }
  // A section (`help PACS`), a Shell topic (`help pipes`), then a command.
  if (commandName) {
    const lookup: HelpLookup = helpLookup_make();
    const section = section_find(commandName, (name: string): boolean => verb_available(name));
    if (section?.name === 'POSIX') return { status: 'ok', rendered: helpPosix_render(lookup) };
    // The Games section is the shelf's own page, by its categories.
    if (section?.name === 'Games') return { status: 'ok', rendered: gamesShelf_render(commandSummary_get) };
    if (section !== undefined) return { status: 'ok', rendered: helpSection_render(section, lookup) };
    const topic: string | undefined = shellTopic_render(commandName);
    if (topic !== undefined) return { status: 'ok', rendered: topic };
    // A verb this session has; else whatever its backend answers for (ChRIS:
    // a plugin or pipeline executable); else no help, never a page for a verb
    // the session cannot run.
    if (verb_available(commandName)) return { status: 'ok', rendered: help_render(commandName) };
    const backendHelp: string | null = (await backendInstalled_get()?.fallback?.help?.(commandName)) ?? null;
    return { status: 'ok', rendered: backendHelp ?? helpMissing_render(commandName) };
  }

  // Otherwise the table of contents: the sections, what each is for, and
  // a few of its commands (builtins/helpSections.ts).
  return { status: 'ok', rendered: helpToc_render(helpLookup_make()) };
}

/**
 * What the help sections read of the commands this session has.
 *
 * @returns The lookup.
 */
export function helpLookup_make(): HelpLookup {
  const runnable: string[] = helpTopic_names().filter((name: string): boolean => name.indexOf(' ') < 0 && verb_available(name));
  return {
    commands: (): ReadonlyArray<string> => runnable,
    summary: (name: string): string | undefined => {
      const help: CommandHelp | undefined = commandHelpEntry_get(name);
      return help === undefined ? undefined : help.summary ?? help.description;
    },
    text: (name: string): string => {
      const help: CommandHelp | undefined = commandHelpEntry_get(name);
      return help === undefined ? '' : `${help.description} ${(help.options ?? []).join(' ')}`;
    },
    // A command on the games shelf is the Games section's, whatever it declares.
    section: (name: string): string | undefined => commandHelpEntry_get(name)?.category ?? (gamesShelf_names(commandSummary_get).includes(name) ? 'Games' : undefined),
    games: (): ReadonlyArray<string> => gamesShelf_names(commandSummary_get),
    posix: (name: string): { group: string; differs: string } | undefined => commandHelpEntry_get(name)?.posix,
  };
}

/**
 * The groups `help` lists commands under, in order. A command declares its
 * own (`category` on its help entry); the games shelf is its own page.
 */
export const HELP_CATEGORIES: ReadonlyArray<string> = HELP_SECTIONS.map((section: HelpSection): string => section.name);

/**
 * Gets the list of all builtin command names.
 *
 * @returns Array of builtin command names.
 */
export function builtinCommands_list(): string[] {
  // `/usr/bin` and completion offer what this session can run, never a
  // backend's verbs it does not have.
  return helpTopic_names().filter((name: string): boolean => verb_available(name));
}

/**
 * A command's one-line summary (its `summary`, else its description), for
 * a listing that names many commands at once.
 *
 * @param command - The command.
 * @returns The line, or undefined for a command with no help entry.
 */
export function commandSummary_get(command: string): string | undefined {
  const help: CommandHelp | undefined = commandHelpEntry_get(command);
  return help === undefined ? undefined : (help.summary ?? help.description);
}

/**
 * Gets the description for a builtin command.
 *
 * @param command - The command name.
 * @returns The command description, or undefined if not found.
 */
export function builtinCommand_descriptionGet(command: string): string | undefined {
  return commandHelpEntry_get(command)?.description;
}
