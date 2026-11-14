/**
 * @file The lab's own toys: `who`, `uptime`, `say`.
 *
 * Small tools that happen to be fun. `who` names the surfaces on this
 * session, `uptime` how long the process has been up, and `say` hands words
 * to a surface with a voice (the console prints them). The ChRIS lab's
 * `ping` and `chrisfetch` are in `chrislab.ts`.
 *
 * @module
 */
import { backendInstalled_get } from '../../core/backend.js';
import chalk from 'chalk';
import { surface_get, type SurfacePeer } from '../../core/surface.js';
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** A span of seconds in words: `2d 3h 04m`, `17m 05s`. */
export function uptime_words(seconds: number): string {
  const s: number = Math.floor(seconds);
  const days: number = Math.floor(s / 86400);
  const hours: number = Math.floor((s % 86400) / 3600);
  const minutes: number = Math.floor((s % 3600) / 60);
  const secs: number = s % 60;
  if (days > 0) return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(secs).padStart(2, '0')}s`;
}

/** `who` takes nothing. */
const WHO_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `who`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [whoCommand] });
 * ```
 */
export const whoCommand = command_declare({
  name: 'who',
  grammar: WHO_GRAMMAR,
  help: {
    summary: 'Who is attached to this session',
    description: "Lists the surfaces on this session — each terminal and browser, by the host's name for it — marking the one you are at. A local shell answers for itself alone.",
    posix: { group: 'System', differs: 'the surfaces on this session (each terminal and browser), not logged-in users' },
    examples: ['who'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => who_run(),
});

/**
 * `who` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `who`: none.
 * @returns The surfaces, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_who([]);
 * ```
 */
export async function builtin_who(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(whoCommand, args);
}

/**
 * Lists the surfaces attached to this session.
 *
 * @returns The surfaces.
 *
 * @example
 * ```ts
 * await who_run();
 * ```
 */
export async function who_run(): Promise<CommandEnvelope> {
  const peers: SurfacePeer[] | null = surface_get().peers?.() ?? null;
  const user: string = (await backendInstalled_get()?.session.user_get()) ?? '?';
  if (peers === null) {
    return envelope_ok(`${user}  this terminal\n`, { kind: 'games.who', data: { user, peers: [] } });
  }
  // A surface with a question open says what it is waiting on: its
  // command is paused until someone answers there.
  const lines: string[] = peers.map((p: SurfacePeer): string =>
    `${user.padEnd(16)} ${p.kind.padEnd(8)} ${p.id}${p.you ? chalk.gray('  (you)') : ''}${p.asking !== undefined ? chalk.yellow(`  ? ${p.asking.trim()}`) : ''}`);
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.who', data: { user, peers } });
}

/** `uptime` takes nothing. */
const UPTIME_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `uptime`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [uptimeCommand] });
 * ```
 */
export const uptimeCommand = command_declare({
  name: 'uptime',
  grammar: UPTIME_GRAMMAR,
  help: {
    summary: "How long this session's process has been up",
    description: 'The time, how long the process serving this session has run, how many surfaces are attached, since when, and its pid.',
    posix: { group: 'System', differs: "how long this session's process has run, not this machine" },
    examples: ['uptime'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => uptime_run(),
});

/**
 * `uptime` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `uptime`: none.
 * @returns The uptime, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_uptime([]);
 * ```
 */
export async function builtin_uptime(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(uptimeCommand, args);
}

/**
 * Says how long this process has been up, and who is here.
 *
 * @returns The uptime.
 *
 * @example
 * ```ts
 * await uptime_run();
 * ```
 */
export async function uptime_run(): Promise<CommandEnvelope> {
  const seconds: number = process.uptime();
  const peers: SurfacePeer[] | null = surface_get().peers?.() ?? null;
  const since: Date = new Date(Date.now() - seconds * 1000);
  const now: string = new Date().toTimeString().slice(0, 8);
  const who: string = peers === null ? '' : `, ${peers.length} surface${peers.length === 1 ? '' : 's'}`;
  const line: string = ` ${now}  up ${uptime_words(seconds)}${who}  (since ${since.toISOString().replace('T', ' ').slice(0, 19)}Z, pid ${process.pid})`;
  return envelope_ok(`${line}\n`, { kind: 'games.uptime', data: { seconds, since: since.toISOString(), pid: process.pid, surfaces: peers?.length ?? null } });
}

/** What `say` takes: the words to speak, unless something is piped in. */
const SAY_GRAMMAR = {
  operands: [{ name: 'text', kind: 'word', optional: true, repeat: true, summary: 'What to say (default: what is piped in)' }],
} as const satisfies CommandGrammar;

/**
 * `say [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [sayCommand] });
 * ```
 */
export const sayCommand = command_declare({
  name: 'say',
  grammar: SAY_GRAMMAR,
  help: {
    summary: 'A surface with a voice speaks it',
    description: "Hands words to the surface: a browser speaks them (ARGUS, through the page's speech), a terminal prints them. Reads what is piped in, else the words given.",
    examples: ['say analysis complete', 'fortune | say'],
  },
  handler: async (args: CommandArguments<typeof SAY_GRAMMAR>): Promise<CommandEnvelope> => say_run(args.operands.text),
});

/**
 * `say` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `say`.
 * @returns The words said, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_say(['hello', 'there']);
 * ```
 */
export async function builtin_say(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(sayCommand, args);
}

/**
 * Says words: what was piped in, else the words given.
 *
 * @param words - The operand words.
 * @returns The words as said, or a refusal when there are none.
 *
 * @example
 * ```ts
 * await say_run(['hello']);
 * ```
 */
export async function say_run(words: readonly string[]): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'say: nothing to say (say hello, or fortune | say)\n');
  const said: string = text.replace(/\n$/, '').replace(/\s+/g, ' ').trim();
  return envelope_ok(`${chalk.gray('♪')} ${said}\n`, { kind: 'games.say', data: { text: said } });
}
