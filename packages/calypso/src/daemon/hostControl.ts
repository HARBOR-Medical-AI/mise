/**
 * @file Host control: the daemon's own declared capabilities.
 *
 * Capabilities are declared, never detected. Surfaces declare theirs on
 * attach; this lets the HOST declare too. Off by default. With
 * `--host-control` (bare = every tier) the daemon runs `!cmd` itself, lets
 * `upload`/`download` reach its own disk, and runs pipe segments itself —
 * the AI-harness permission model applied to the session daemon: the
 * operator who starts the daemon decides what it may do on the machine it
 * runs on. The host always wins under the policy, so one `!` means one
 * machine, and every surface is told (attach ack, face, prompt, lamp).
 *
 * A non-loopback bind turns the attach token — a bearer secret in a URL —
 * into a shell on this host for anyone holding it, so that combination
 * refuses unless `--expose-host-control` is typed as well.
 *
 * `tasks` is the fourth tier and the only one never granted by `all`: it lets
 * the engine start long jobs that change things beyond this host (a cloud's
 * resources, and its bill), so it is named on its own (docs/stratus.adoc, D10).
 *
 * @module
 */
import { spawn, type ChildProcess } from 'child_process';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import * as path from 'node:path';

/**
 * What the engine may do on this host, by the operator's grant alone: its disk (the `files` tier), programs of its
 * own (the `shell` tier: docker for a plugin, say), and pipeline segments run here (the `pipes` tier). Nothing an
 * attached surface declares raises any of them.
 *
 * @example
 * ```ts
 * const grants: EngineHostGrants = engineHost_grants(policy);
 * ```
 */
export interface EngineHostGrants {
  /** The engine's disk is the operator's. */
  engineFilesystem: boolean;
  /** The engine may start programs on this host. */
  engineProcesses: boolean;
  /** Pipeline segments run on this host. */
  pipesHere: boolean;
}

/**
 * What the engine may do on this host, from the policy alone.
 *
 * @param policy - The host-control policy the operator started the daemon with.
 * @returns The grants.
 *
 * @example
 * ```ts
 * engineHost_grants({ tiers: new Set(['pipes']), exposed: false }).engineProcesses; // false
 * ```
 */
export function engineHost_grants(policy: HostControlPolicy): EngineHostGrants {
  return { engineFilesystem: policy.tiers.has('files'), engineProcesses: policy.tiers.has('shell'), pipesHere: policy.tiers.has('pipes') };
}

/**
 * What an attached surface declared of itself, as far as the daemon reads it.
 *
 * @example
 * ```ts
 * const attached: AttachedCapabilities = { color: true, pipeSegments: false };
 * ```
 */
export interface AttachedCapabilities {
  /** It renders colour. */
  color?: boolean;
  /** It runs pipeline segments. */
  pipeSegments?: boolean;
  /** It takes a file delivered. */
  fileDelivery?: boolean;
  /** It has a filesystem of its own to fill. */
  localFilesystem?: boolean;
  /** It holds the tasks tier (an elevation): B3 decides whether a surface may say so. */
  tasks?: boolean;
}

/**
 * The daemon's surface's capabilities, as the engine reads them.
 *
 * @example
 * ```ts
 * const capabilities: DaemonCapabilities = daemonCapabilities_compose(null, HOST_CONTROL_OFF);
 * ```
 */
export interface DaemonCapabilities {
  /** Hidden input. */
  hiddenInput: boolean;
  /** Local edit. */
  localEdit: boolean;
  /** A terminal. */
  tty: boolean;
  /** Colour. */
  color: boolean;
  /** Pipeline segments run somewhere. */
  pipeSegments: boolean;
  /** `!` lines are relayed. */
  shellCommands: boolean;
  /** Files are delivered. */
  fileDelivery: boolean;
  /** The engine's disk is the operator's. */
  engineFilesystem: boolean;
  /** The engine may start programs on this host. */
  engineProcesses: boolean;
  /** The surface has a filesystem of its own. */
  localFilesystem: boolean;
  /** Long tasks. */
  tasks: boolean;
}

/**
 * The daemon's surface's capabilities: those that vary by surface read from the one executing, as it declared
 * them on attach; what the engine may do on this host from the operator's policy alone.
 *
 * @param attached - What the executing surface declared, if one is attached.
 * @param policy - The host-control policy.
 * @returns The capabilities.
 *
 * @example
 * ```ts
 * daemonCapabilities_compose({ pipeSegments: true }, HOST_CONTROL_OFF).engineProcesses; // false
 * ```
 */
export function daemonCapabilities_compose(attached: AttachedCapabilities | null | undefined, policy: HostControlPolicy): DaemonCapabilities {
  return {
    hiddenInput: true,
    localEdit: true,
    tty: true,
    // Colour follows the executing surface: a colour terminal or a browser
    // console renders ANSI, a bare pipe does not.
    color: attached?.color ?? false,
    // A segment runs on this host under host control, else on the acting
    // surface: a chell runs one, a browser none. Said truly, a builtin
    // that would hand text to a system program answers in the kernel instead.
    pipeSegments: engineHost_grants(policy).pipesHere || (attached?.pipeSegments ?? false),
    shellCommands: true,
    fileDelivery: attached?.fileDelivery ?? false,
    // The daemon's disk belongs to nobody attending this session — unless
    // the operator who started it declared otherwise with the `files`
    // tier of --host-control, in which case it is theirs by declaration.
    engineFilesystem: engineHost_grants(policy).engineFilesystem,
    // Programs on this host (docker for a plugin, say) are the operator's to grant, by the shell tier, and
    // never a surface's: what an attached surface declares does not reach this.
    engineProcesses: engineHost_grants(policy).engineProcesses,
    localFilesystem: attached?.localFilesystem ?? false,
    // Long jobs that change things beyond this host, and bill: only the
    // operator who started the daemon grants them, never a surface.
    tasks: policy.tiers.has('tasks') || (attached?.tasks ?? false),
  };
}

/** The tiers the policy can grant, in the order they are told. */
export const HOST_CONTROL_TIERS: readonly HostControlTier[] = ['shell', 'files', 'pipes', 'tasks'];
export type HostControlTier = 'shell' | 'files' | 'pipes' | 'tasks';

/** What bare `--host-control` and `all` grant: this host's own tiers; `tasks` only when named. */
export const HOST_CONTROL_ALL: readonly HostControlTier[] = ['shell', 'files', 'pipes'];

/**
 * The daemon's host-control policy.
 *
 * @property tiers - What the host does itself; empty means off.
 * @property exposed - `--expose-host-control` was typed.
 */
export interface HostControlPolicy {
  tiers: ReadonlySet<HostControlTier>;
  exposed: boolean;
}

/** The raw inputs a launcher collected (a flag value, an env value, the override). */
export interface HostControlInputs {
  /** `--host-control` value: true for bare, a tier list string, undefined when absent. */
  flag?: string | boolean;
  /** `CALYPSO_HOST_CONTROL`: `all`, a tier list, or unset. */
  env?: string;
  /** `--expose-host-control`. */
  exposed?: boolean;
}

/** The policy that grants nothing. */
export const HOST_CONTROL_OFF: HostControlPolicy = { tiers: new Set(), exposed: false };

/**
 * Parses a tier list (`shell,files`, `all`, or empty for all).
 *
 * @param value - The list as typed.
 * @returns The tiers, or an error naming the unknown word.
 */
export function hostControlTiers_parse(value: string | boolean | undefined): { tiers: Set<HostControlTier> } | { error: string } {
  if (value === undefined || value === false) return { tiers: new Set() };
  if (value === true || value.trim() === '' || value.trim() === 'all') return { tiers: new Set(HOST_CONTROL_ALL) };
  const tiers: Set<HostControlTier> = new Set();
  for (const word of value.split(',').map((part: string): string => part.trim()).filter((part: string): boolean => part !== '')) {
    if (word === 'all') { for (const tier of HOST_CONTROL_ALL) tiers.add(tier); continue; }
    if (!(HOST_CONTROL_TIERS as readonly string[]).includes(word)) {
      return { error: `unknown host-control tier '${word}' (shell, files, pipes, tasks, or all)` };
    }
    tiers.add(word as HostControlTier);
  }
  return { tiers };
}

/**
 * Builds the policy from what a launcher collected: the flag wins over the
 * env twin, the override is only ever typed.
 *
 * @param inputs - Flag, env, override.
 * @returns The policy, or an error to print and refuse on.
 */
export function hostControl_build(inputs: HostControlInputs): { policy: HostControlPolicy } | { error: string } {
  const source: string | boolean | undefined = inputs.flag !== undefined && inputs.flag !== false ? inputs.flag : inputs.env;
  const parsed = hostControlTiers_parse(source);
  if ('error' in parsed) return parsed;
  return { policy: { tiers: parsed.tiers, exposed: inputs.exposed === true } };
}

/**
 * Parses a raw argv (the standalone calypso binary) and the environment.
 *
 * @param argv - Process arguments.
 * @param env - Process environment.
 * @returns The policy, or an error.
 */
export function hostControl_parseArgv(argv: readonly string[], env: NodeJS.ProcessEnv): { policy: HostControlPolicy } | { error: string } {
  let flag: string | boolean | undefined;
  for (let index: number = 0; index < argv.length; index++) {
    const word: string = argv[index] ?? '';
    if (word === '--host-control') {
      const next: string | undefined = argv[index + 1];
      flag = next !== undefined && !next.startsWith('-') ? next : true;
    } else if (word.startsWith('--host-control=')) {
      flag = word.slice('--host-control='.length);
    }
  }
  return hostControl_build({ flag, env: env['CALYPSO_HOST_CONTROL'], exposed: argv.includes('--expose-host-control') });
}

/**
 * The launch guard: host control on a non-loopback bind refuses unless the
 * operator typed the override.
 *
 * @param policy - The policy.
 * @param bindHost - The bind address.
 * @returns The refusal line, or null when the launch may proceed.
 */
export function hostControl_guard(policy: HostControlPolicy, bindHost: string): string | null {
  if (policy.tiers.size === 0 || bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1') return null;
  if (policy.exposed) return null;
  const what: string = policy.tiers.size === 1 && policy.tiers.has('tasks') ? 'the power to start jobs that spend money' : 'a shell on this host';
  return `--host-control with CALYPSO_BIND=${bindHost} would hand ${what} to anyone holding the attach URL; bind to loopback, or type --expose-host-control if you mean it.`;
}

/**
 * The policy as a readout: `shell files pipes`, or empty when off.
 *
 * @param policy - The policy.
 * @returns The tiers in canonical order.
 */
export function hostControl_describe(policy: HostControlPolicy): string {
  return HOST_CONTROL_TIERS.filter((tier: HostControlTier): boolean => policy.tiers.has(tier)).join(' ');
}

/** The tiers as the attach ack carries them. */
export function hostControl_tiers(policy: HostControlPolicy): string[] {
  return HOST_CONTROL_TIERS.filter((tier: HostControlTier): boolean => policy.tiers.has(tier));
}

/**
 * Runs a shell command on the daemon host: `sh -c`, stdin closed (a daemon
 * has no terminal to offer), stdout and stderr streamed to the caller as
 * they arrive, working directory the daemon's own.
 *
 * @param command - The command without its leading `!`.
 * @param write - Receives output chunks by channel.
 * @returns The exit code (1 when the process died without one).
 */
export function hostShell_run(command: string, write: (channel: 'data' | 'err', chunk: string) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve: (code: number) => void, reject: (error: Error) => void): void => {
    // Its own process group, so a cancel reaches everything the shell started.
    const child: ChildProcess = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(), detached: true });
    const stop: () => void = processGroup_stopper(child);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (chunk: Buffer): void => write('data', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer): void => write('err', chunk.toString('utf8')));
    child.once('error', (error: Error): void => { signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', (code: number | null): void => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted === true) write('err', `${command}: stopped\n`);
      resolve(code ?? (signal?.aborted === true ? 130 : 1));
    });
  });
}

/**
 * Programs that, given no terminal on any descriptor, wait forever rather
 * than fail: Neovim reads its closed input to the end and then runs with no
 * user interface, waiting for one to attach. On pipes such a `!` would hold
 * the session's lane with nothing drawn, so it is refused by name. Programs
 * that fail on their own without a terminal (vim, nano, top, tmux) or work
 * on pipes (less, man) are not listed.
 */
const TERMINAL_WAITERS: ReadonlySet<string> = new Set<string>(['nvim']);

/** Arguments with which a terminal waiter runs, and ends, without a terminal. */
const TERMINAL_WAITER_HEADLESS: ReadonlySet<string> = new Set<string>([
  '--headless', '--embed', '-es', '-Es', '-l', '-v', '--version', '-h', '--help', '--api-info',
]);

/**
 * A program's own name, through symbolic links: `vi` that is Neovim is `nvim`.
 *
 * @param word - The command's first word.
 * @param env - The environment whose `PATH` is searched.
 * @returns The real file's basename, or the word's own when it is not found.
 */
function programName_resolve(word: string, env: NodeJS.ProcessEnv): string {
  const candidates: string[] = word.includes('/')
    ? [word]
    : (env['PATH'] ?? '').split(':').filter((dir: string): boolean => dir.length > 0).map((dir: string): string => path.join(dir, word));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return path.basename(realpathSync(candidate));
    } catch {
      // Not here.
    }
  }
  return path.basename(word);
}

/**
 * The refusal for a `!` command that would wait forever on pipes: a program
 * that needs a terminal, run for a surface that has none.
 *
 * Only the command's first program is read (after any `NAME=value`
 * assignments); a headless flag anywhere in the line lets it through.
 *
 * @param command - The command without its leading `!`.
 * @param env - The environment the command would run in.
 * @returns The refusal, or null when the command may run on pipes.
 * @example
 * hostShellTerminal_refusal('nvim notes.txt'); // 'nvim needs a terminal, ...'
 * hostShellTerminal_refusal('nvim --headless +q'); // null
 * hostShellTerminal_refusal('ls -l'); // null
 */
export function hostShellTerminal_refusal(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const words: string[] = command.trim().split(/\s+/).filter((word: string): boolean => word.length > 0);
  const first: string | undefined = words.find((word: string): boolean => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (first === undefined) return null;
  if (words.some((word: string): boolean => TERMINAL_WAITER_HEADLESS.has(word))) return null;
  const typed: string = path.basename(first);
  const real: string = programName_resolve(first, env);
  const waiter: string | undefined = [typed, real].find((name: string): boolean => TERMINAL_WAITERS.has(name));
  if (waiter === undefined) return null;
  return `${typed} needs a terminal, and this surface has none: attach chell --remote from a terminal to run it here`;
}

/** How long a cancelled host process has to end after SIGTERM before SIGKILL. */
export const HOST_KILL_GRACE_MS: number = 2000;

/**
 * Stops a child and everything in its process group: SIGTERM, then SIGKILL
 * after {@link HOST_KILL_GRACE_MS} if it has not ended.
 *
 * @param child - A child spawned `detached`, so it leads its own group.
 * @returns The stopper, safe to call more than once.
 */
export function processGroup_stopper(child: ChildProcess): () => void {
  let stopping: boolean = false;
  return (): void => {
    if (stopping || child.pid === undefined || child.exitCode !== null) return;
    stopping = true;
    const signalGroup = (name: NodeJS.Signals): void => {
      try { process.kill(-(child.pid as number), name); } catch { try { child.kill(name); } catch { /* already gone */ } }
    };
    signalGroup('SIGTERM');
    const hard: ReturnType<typeof setTimeout> = setTimeout((): void => { if (child.exitCode === null) signalGroup('SIGKILL'); }, HOST_KILL_GRACE_MS);
    hard.unref?.();
    child.once('close', (): void => clearTimeout(hard));
  };
}

/**
 * Runs one pipeline segment on the daemon host: the input on stdin, the
 * output collected.
 *
 * @param command - The segment's command.
 * @param input - The upstream bytes.
 * @returns The segment's stdout.
 */
export function hostPipe_run(command: string, input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve: (output: Buffer) => void, reject: (error: Error) => void): void => {
    const child: ChildProcess = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], cwd: process.cwd(), detached: true });
    const stop: () => void = processGroup_stopper(child);
    signal?.addEventListener('abort', stop, { once: true });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
    child.once('error', (error: Error): void => { signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', (): void => { signal?.removeEventListener('abort', stop); resolve(Buffer.concat(chunks)); });
    child.stdin?.end(input);
  });
}
