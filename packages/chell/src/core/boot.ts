/**
 * @file Boot, connection, and REPL startup for the ChELL shell.
 *
 * Holds the process-lifecycle glue that sits around the command dispatcher:
 * - self/dependency package.json loading and the boot info panels
 * - password prompting and ChRIS connection establishment (CLI args or saved session)
 * - engine creation and cache prefetch
 * - the interactive session runner and `chell_start` entrypoint
 *
 * The parse/dispatch logic it drives lives in `../chell.js`.
 *
 * @module
 */
import * as os from 'os';
import { existsSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { REPL } from './repl.js';
import { session, homePath_derive } from '@fnndsc/brasa';
import { Result, Ok, Err, Client, type CommandEnvelope } from '@fnndsc/cumin';
import { spinner } from '@fnndsc/brasa';
import { logo_print, logo_animatePulse, logo_animateStop, logo_reviveOnScreen } from '../lib/logo.js';
import {
  BootInfoItem,
  BootInfoItem3,
  BootPanels,
  bootLogger_create,
  bootsequence_printIntroPanelsStacked
} from '../lib/bootsequence.js';
import { settings_load } from '../config/settings.js';
import { cli_parse, ChellCLIConfig } from './cli.js';
import { bootFlags_compute, type BootFlags } from './bootFlags.js';
import { context_getSingle } from '@fnndsc/salsa';
import { chrisContext, Context, SingleContext } from '@fnndsc/cumin';
import { engine_create, stopOnError_set, type BrasaEngine } from '@fnndsc/brasa';
import { sessionFromSaved_connect, sessionWithToken_connect, type SavedSessionResult, type TokenSessionResult } from '@fnndsc/brasa';
import { stdinLine_read } from '../lib/stdinLine.js';
import type { DaemonConsoleTarget } from './daemonConsole.js';
import { surface_set } from '@fnndsc/brasa';
import { cliSurface_create, oneShotPrompt_ask } from './cliSurface.js';
import { surfaceLine_execute } from './surfaceDispatch.js';
import { game_play, gameShow_find, gameTerminal_is, type GameShow } from './gamePlayer.js';
import { greeting_print } from './greeting.js';
import { versionReport_build, infoReport_build, stackInfo_get, welcomeLine_build, type PackageInfo } from '@fnndsc/brasa';
import { path_quote } from '@fnndsc/menu';
import {
  daemonSession_run,
  queryCheckpoint_flush,
  queryCheckpoint_prime,
  startupWarmup_run,
  type StartupWarmupCache,
  type StartupWarmupFlags,
} from './startupWarmup.js';

/**
 * Prompts the user for a password without echoing input. A standard input
 * that is closed (a service, `docker exec` without `-i`, `</dev/null`) has
 * no one to type it, and fails the prompt rather than leaving the process to
 * end with nothing said.
 *
 * @param user - The username.
 * @param url - The CUBE URL.
 * @returns A Promise resolving to the password string.
 * @throws {Error} When standard input is closed, or closes before a line is typed.
 */
async function password_prompt(user: string, url: string): Promise<string> {
  return oneShotPrompt_ask({ message: `Password for ${user}@${url}: `, hidden: true });
}

/**
 * Assemble and render the Neofetch-style boot info panels.
 *
 * @param context    - Current ChRIS session context.
 * @param mode       - Shell mode string (e.g. 'interactive').
 * @param cache      - Prefetch counts for the panel's ChRIS section.
 * @param useAsciiBoot - Render ASCII box-drawing instead of Unicode.
 */
function bootPanels_render(
  context: SingleContext,
  mode: string,
  cache: StartupWarmupCache,
  useAsciiBoot: boolean,
): void {
  const headerItems: BootInfoItem3[] = stackInfo_get().map(
    (i: PackageInfo): BootInfoItem3 => ({ app: i.pkg, name: i.name, version: i.version }),
  );

  const localItems: BootInfoItem[] = [
    { label: 'System', value: `${os.platform()} ${os.release()} (${os.arch()})` },
    { label: 'User',   value: `${os.userInfo().username}@${os.hostname()}` },
    ...(localIPv4_get() ? [{ label: 'Local', value: localIPv4_get() as string }] : []),
    { label: 'Time',   value: localTime_format() },
  ];

  const maxItemLen: number = Math.max(30, (process.stdout.columns || 100) - 20);
  const str_truncate = (s: string): string => s.length > maxItemLen ? `…${s.slice(-(maxItemLen - 1))}` : s;

  const chrisItems: BootInfoItem[] = [
    { label: 'ChRIS', value: str_truncate(context.URL || 'offline') },
    { label: 'User',  value: context.user || 'offline' },
    { label: 'Mode',  value: mode },
  ];

  if (typeof cache.plugins   === 'number') chrisItems.push({ label: 'Plugins',      value: `${cache.plugins}`   });
  if (typeof cache.pipelines === 'number') chrisItems.push({ label: 'Pipelines',    value: `${cache.pipelines}` });
  if (context.plugin)                      chrisItems.push({ label: 'Active Plugin', value: context.plugin       });
  if (typeof cache.feeds     === 'number') chrisItems.push({ label: 'User Feeds',   value: `${cache.feeds}`     });
  if (context.feed)                        chrisItems.push({ label: 'Active Feed',  value: `${context.feed}`    });
  if (typeof cache.public    === 'number') chrisItems.push({ label: 'Public Feeds', value: `${cache.public}`    });
  if (context.pacsserver)                  chrisItems.push({ label: 'PACS Server',  value: context.pacsserver   });

  chrisItems.push({ label: 'Path', value: str_truncate(context.folder ?? '/') });

  const panels: BootPanels = { header: headerItems, local: localItems, chris: chrisItems };
  bootsequence_printIntroPanelsStacked([], panels, !useAsciiBoot, useAsciiBoot);
}

/**
 * Returns the first non-internal IPv4 address of the local machine, or null if none found.
 */
function localIPv4_get(): string | null {
  const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const iface: os.NetworkInterfaceInfo[] | undefined = interfaces[key];
    if (!iface) continue;
    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }
  return null;
}

/**
 * Returns the current local date/time as `YYYY-MM-DD HH:MM:SS ±HH:MM`.
 */
function localTime_format(): string {
  const now: Date = new Date();
  const offsetMinutes: number = now.getTimezoneOffset();
  const sign: string = offsetMinutes <= 0 ? '+' : '-';
  const absMinutes: number = Math.abs(offsetMinutes);
  const hours: number = Math.floor(absMinutes / 60);
  const minutes: number = absMinutes % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const offsetStr: string = `${sign}${pad(hours)}:${pad(minutes)}`;
  const dateStr: string = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr: string = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${dateStr} ${timeStr} ${offsetStr}`;
}

/**
 * Runs a chell script file: as a manifest, through `play`. A script and a
 * manifest are one format (kernel lines, `#` comments, an optional `@`
 * header) with one runner, so a script stops at its first refused line as a
 * manifest does, says which, and exits non-zero. `-e` asked for exactly
 * that and is still accepted. A shebang first line is a comment.
 *
 * The path is the host's: it is made absolute here, so `play` finds the file
 * beside the engine rather than a CFS file that happens to share its name.
 *
 * @param engine - The engine that runs the play.
 * @param scriptPath - Path to the script file, on this host.
 * @returns A Promise that resolves when the play ends.
 */
async function script_execute(engine: BrasaEngine, scriptPath: string): Promise<void> {
  if (!existsSync(scriptPath)) {
    console.error(chalk.red(`Error: Script file not found: ${scriptPath}`));
    process.exit(1);
  }
  const absolute: string = path.resolve(scriptPath);
  await surfaceLine_execute(engine, `play ${path_quote(absolute)}`);
}

type BootLogger = ReturnType<typeof bootLogger_create>;

/**
 * Connect using explicit CLI credentials. Returns Err() on unrecoverable failure.
 */
async function connectionFromArgs_open(
  config: ChellCLIConfig,
  boot: BootLogger | null,
): Promise<Result<SingleContext>> {
  let { user, password, url } = config.connectConfig!;

  if (!user) {
    console.error(chalk.red('Error: Username required when connecting via CLI args.'));
    return Err();
  }

  if (!password && url && config.mode !== 'execute' && config.mode !== 'script') {
    try {
      password = await password_prompt(user, url);
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Error: no password for ${user}@${url} (${reason}); log in with --saved-token, --auth-token-stdin or -p.`));
      return Err();
    }
  }

  if (!password && config.mode === 'execute') {
    console.error(chalk.red('Error: Password required for connection in execute mode.'));
    return Err();
  }

  if (!url || !password) {
    return Ok(await context_getSingle());
  }

  spinner.start(`Establishing uplink to ${url}`);
  try {
    await session.connection.connection_connect({ user: user!, password, url, debug: false });
    session.offline = false;
    await chrisContext.current_set(Context.ChRISuser, user!);
    await chrisContext.current_set(Context.ChRISURL, url);
    // The working directory is the identity's own and is NOT reset here:
    // this line once wrote `/` on every credentialed boot, which is why a
    // daemon always came up at the root however the operator had left it.
    // With nothing stored the kernel answers the identity's home.
    await chrisContext.current_set(Context.ChRISfeed, '');
    await chrisContext.current_set(Context.ChRISplugin, '');
    spinner.stop();
    if (config.mode !== 'execute' && config.mode !== 'script') {
      console.log(chalk.green('[+] Connection established.'));
    }
    boot?.log('ok', 'Connect', `Connected to ${url}`);
    return Ok(await context_getSingle());
  } catch (error: unknown) {
    spinner.stop();
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`[!] Connection failed: ${errorMessage}`));
    boot?.log('fail', 'Connect', errorMessage);
    return Err();
  }
}

/**
 * Connect with a CUBE token read from stdin. Returns Err() on any refusal.
 *
 * This is how a login front hands a session its identity: the front
 * exchanged the operator's password for a token itself, so the session
 * gets the token and never the password — and not on argv, where `ps`
 * would show it to the host. Refusals are by name: the flag without an
 * identity, the flag beside a password, a stream with no line on it, and
 * a token the server will not have.
 */
async function connectionFromToken_open(
  config: ChellCLIConfig,
  boot: BootLogger | null,
): Promise<Result<SingleContext>> {
  const user: string | undefined = config.connectConfig?.user;
  const url: string | undefined = config.connectConfig?.url;
  if (!user || !url) {
    console.error(chalk.red('Error: --auth-token-stdin needs a <user>@<url> target to say whose token it is.'));
    return Err();
  }
  if (config.connectConfig?.password !== undefined) {
    console.error(chalk.red('Error: --auth-token-stdin and --password are two logins; give one.'));
    return Err();
  }
  const token: string | null = await stdinLine_read();
  if (token === null || token.length === 0) {
    console.error(chalk.red('Error: --auth-token-stdin read no token: stdin ended before a line arrived.'));
    boot?.log('fail', 'Connect', 'No token on stdin');
    return Err();
  }

  spinner.start(`Establishing uplink to ${url}`);
  const result: TokenSessionResult = await sessionWithToken_connect(user, url, token);
  spinner.stop();
  if (result.status === 'refused') {
    console.error(chalk.red(`[!] Connection refused: ${result.error ?? 'the server did not accept the token'}`));
    boot?.log('fail', 'Connect', result.error ?? 'Token refused');
    return Err();
  }
  if (config.mode !== 'execute' && config.mode !== 'script') {
    console.log(chalk.green('[+] Connection established.'));
  }
  boot?.log('ok', 'Connect', `Connected to ${url} (token)`);
  return Ok(result.context);
}

/**
 * Connect with the token this identity saved last time, or refuse. Unlike a
 * saved-session restore, nothing falls back to offline: a porter restarting
 * a session needs to know it did not come up, so it can send the operator
 * to the login door. Refusals are by name: the flag without an identity,
 * beside another login, no saved token for that identity, and a token the
 * server will not have.
 */
async function connectionFromSavedToken_open(
  config: ChellCLIConfig,
  boot: BootLogger | null,
): Promise<Result<SingleContext>> {
  const user: string | undefined = config.connectConfig?.user;
  const url: string | undefined = config.connectConfig?.url;
  if (!user || !url) {
    console.error(chalk.red('Error: --saved-token needs a <user>@<url> target to say whose token it is.'));
    return Err();
  }
  if (config.connectConfig?.password !== undefined || config.authTokenStdin) {
    console.error(chalk.red('Error: --saved-token is a login of its own; give it alone.'));
    return Err();
  }
  spinner.start(`Validating the token ${user} saved`);
  const result: SavedSessionResult = await sessionFromSaved_connect();
  spinner.stop();
  const ctx: SingleContext = result.context;
  const theirs: boolean = ctx.user === user && url_sameServer(ctx.URL ?? '', url);
  if (result.status !== 'restored' || !theirs) {
    const why: string = !theirs && result.status === 'restored'
      ? `the saved token is ${ctx.user}@${ctx.URL}'s, not ${user}@${url}'s`
      : result.status === 'invalid-token' ? `the server refused the saved token${result.error ? ` (${result.error})` : ''}`
        : result.status === 'unreachable' ? `CUBE did not answer${result.error ? ` (${result.error})` : ''}; the saved token was not checked, so log in again once it answers`
        : 'no token is saved for this identity';
    console.error(chalk.red(`[!] Connection refused: ${why}`));
    boot?.log('fail', 'Connect', why);
    return Err();
  }
  boot?.log('ok', 'Connect', `Connected to ${url} (saved token)`);
  return Ok(ctx);
}

/** Whether two CUBE API URLs name one server (a trailing slash is no difference). */
function url_sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Restore a saved session from disk. Always succeeds — falls back to offline mode.
 */
async function connectionFromSavedSession_open(
  config: ChellCLIConfig,
  boot: BootLogger | null,
): Promise<SingleContext> {
  const verbose: boolean = config.mode !== 'execute' && config.mode !== 'script';

  spinner.start('Validating saved session');
  const result: SavedSessionResult = await sessionFromSaved_connect();
  spinner.stop();

  const ctx: SingleContext = result.context;
  const reconnectHint = (): void =>
    console.log(chalk.gray(`    Use: connect --user ${ctx.user} --password <pwd> ${ctx.URL}`));

  switch (result.status) {
    case 'no-context':
      if (verbose) console.log(chalk.yellow('[!] No previous context found'));
      break;
    case 'no-token':
      console.log(chalk.yellow('[!] No token found'));
      console.log(chalk.yellow('[!] Running in disconnected mode'));
      reconnectHint();
      boot?.log('skip', 'Session', 'No saved token; offline');
      break;
    case 'no-client':
      console.log(chalk.yellow('[!] Failed to create client'));
      console.log(chalk.yellow('[!] Running in disconnected mode'));
      reconnectHint();
      break;
    case 'unreachable':
      console.log(chalk.yellow('[!] CUBE did not answer; the saved token was not checked'));
      if (result.error) console.log(chalk.gray(`    Error: ${result.error}`));
      console.log(chalk.yellow('[!] Running in disconnected mode'));
      reconnectHint();
      break;
    case 'invalid-token':
      console.log(chalk.yellow('[!] Token expired or invalid'));
      if (result.error) console.log(chalk.gray(`    Error: ${result.error}`));
      console.log(chalk.yellow('[!] Running in disconnected mode'));
      reconnectHint();
      break;
    case 'restored':
      if (verbose) {
        console.log(chalk.green('[+] Previous context detected'));
        console.log(chalk.gray(`    User: ${chalk.cyan(ctx.user)}`));
        console.log(chalk.gray(`    URL:  ${chalk.cyan(ctx.URL)}`));
        console.log(chalk.green('[+] Token validated with server'));
        console.log(chalk.green('[+] Session restored'));
        boot?.log('ok', 'Session', `Restored ${ctx.user}@${ctx.URL}`);
      }
      break;
  }

  return ctx;
}

/**
 * Establish a ChRIS connection: explicit CLI args or saved session restore.
 *
 * @param config - Parsed CLI config.
 * @param boot   - Boot logger; null in non-interactive modes.
 * @returns Ok(context) on success; Err() on unrecoverable failure (caller should exit).
 */
async function connection_establish(
  config: ChellCLIConfig,
  boot: BootLogger | null,
): Promise<Result<SingleContext>> {
  if (config.authTokenStdin) {
    return await connectionFromToken_open(config, boot);
  }
  if (config.savedToken) {
    return await connectionFromSavedToken_open(config, boot);
  }
  if (config.connectConfig) {
    return await connectionFromArgs_open(config, boot);
  }

  const ctx: SingleContext = await connectionFromSavedSession_open(config, boot);
  if (!ctx.user || !ctx.URL) {
    if (!session.offline) {
      console.log(chalk.yellow('[!] Running in disconnected mode.'));
      session.offline = true;
    }
  }
  return Ok(ctx);
}

/**
 * Stands in for the daemon console where no terminal can hold one.
 *
 * @param target - The daemon, for the one line that says how to reach it.
 */
async function daemonConsole_skip(target: DaemonConsoleTarget): Promise<void> {
  console.log(chalk.gray(`[+] No terminal here; the daemon keeps listening. Attach a surface with: chell --remote ${target.identity}`));
}

/**
 * Runs the interactive session: prefetches the boot cache, renders the boot
 * panels and greeting, kicks off non-blocking topology warm-up, and enters the
 * REPL loop.
 *
 * @param engine - The engine the REPL hosts.
 * @param config - The parsed CLI config.
 * @param currentContext - The resolved session context.
 * @param flags - Prefetch/interactivity boot flags.
 * @param boot - The boot logger, or null when non-interactive.
 */
async function interactiveSession_run(
  engine: BrasaEngine,
  config: ChellCLIConfig,
  currentContext: SingleContext,
  flags: Pick<BootFlags, 'prefetchPlugins' | 'prefetchFeeds' | 'prefetchPublicFeeds' | 'prefetchJobs' | 'isInteractiveSession' | 'useAsciiBoot'>,
  boot: ReturnType<typeof bootLogger_create> | null,
): Promise<void> {
  const warmupFlags: StartupWarmupFlags = {
    plugins: flags.prefetchPlugins,
    feeds: flags.prefetchFeeds,
    publicFeeds: flags.prefetchPublicFeeds,
    jobs: flags.prefetchJobs,
  };
  const cache: StartupWarmupCache = await startupWarmup_run(
    warmupFlags,
    currentContext.user ?? undefined,
    flags.isInteractiveSession,
    boot,
  );

  if (flags.isInteractiveSession) {
    logo_animateStop();
    bootPanels_render(
      currentContext,
      config.mode,
      cache,
      flags.useAsciiBoot,
    );
  }

  if (flags.isInteractiveSession) {
    console.log(chalk.bold.cyan(welcomeLine_build('chell')));
    console.log('');
  }
  console.log(chalk.yellow('Order up! Your Taco Chell is ready! Filled with chili, salsa, and cumin goodness! 🌮'));
  console.log('');
  if (flags.isInteractiveSession) {
    if (session.offline) {
      console.log(chalk.yellow('You are currently disconnected. Use: connect --user <user> --password <pwd> <url>'));
    }
    console.log(chalk.gray("Tip: type 'help' for available commands."));
    console.log('');
    // The session greets through the kernel's `motd`, fortune included.
    await greeting_print(engine);
  }

  const repl: REPL = new REPL(engine);
  await repl.start();
}

/**
 * Starts the ChELL REPL.
 * Initializes connection and enters the command loop.
 *
 * @param argv - The argument vector to parse. Defaults to `process.argv`; the
 *   `calypso` entry passes an argv with daemon mode forced in.
 * @returns A Promise that resolves when the shell exits.
 */
export async function chell_start(argv: string[] = process.argv): Promise<void> {
  const config: ChellCLIConfig = await cli_parse(argv, versionReport_build(), infoReport_build());
  const {
    isInteractiveSession,
    useAsciiBoot,
    prefetchPlugins,
    prefetchFeeds,
    prefetchPublicFeeds,
    prefetchJobs,
    showLogo,
  }: BootFlags = bootFlags_compute(config, !!process.stdout.isTTY);
  const boot: ReturnType<typeof bootLogger_create> | null = isInteractiveSession ? bootLogger_create('ChELL Boot', useAsciiBoot) : null;

  if (config.mode === 'auth' && config.auth !== undefined) {
    const { auth_run } = await import('../remote/auth.js');
    process.exit(await auth_run(config.auth));
  }
  if (config.mode === 'help' || config.mode === 'version' || config.mode === 'info') {
    if (config.output) console.log(config.output);
    return;
  }

  // --- Common Initialization ---

  // `--no-logo` hides the logo; it does not print it uncoloured. Off a TTY
  // the flag is implied, so a host reading this boot off a pipe — the
  // porter's greeter, which draws the brain itself — gets rows and no art.
  // A remote surface draws its art after the attach answer, which names the
  // session's backend and so which art is its own.
  if (isInteractiveSession && showLogo && config.mode !== 'remote') {
    logo_print(!useAsciiBoot);
  }

  await settings_load();

  // --- Remote Mode ---
  // A remote surface attaches to a daemon and drives it with the ordinary
  // REPL; it needs no local engine, session, or CUBE connection.
  if (config.mode === 'remote') {
    const { remote_run } = await import('../remote/client.js');
    const cc: { user?: string; url?: string } | undefined = config.connectConfig;
    // A `<user>@<where>` target names the identity to attach to, as typed; the
    // client tries it exactly before it reads it as a CUBE URL. A bare
    // `--remote` resolves the sole live berth (identity undefined).
    const identity: string | undefined = config.remoteTarget;
    const splash: { colorize: boolean } | undefined = isInteractiveSession && showLogo && config.commandToExecute === undefined
      ? { colorize: !useAsciiBoot }
      : undefined;
    // A door wins over everything: the terminal logs in there and attaches
    // to whatever the door mounts, with the door's cookie on the upgrade.
    if (config.door !== undefined) {
      const { door_enter } = await import('../remote/door.js');
      const reach = await door_enter(config.door, cc?.user, config.connectConfig?.password);
      if (reach === null) {
        process.exit(1);
      }
      await remote_run(reach.identity, config.commandToExecute, { address: reach.url, headers: reach.headers }, { stopOnError: config.stopOnError === true, allowHostRequests: config.allowHostRequests === true, ...(splash !== undefined ? { splash } : {}) });
      if (config.commandToExecute !== undefined) {
        process.exit(process.exitCode ?? 0);
      }
      return;
    }
    // An explicit address wins over identity resolution: a daemon on another
    // machine has no berth in this host's runtime directory to resolve.
    const attach = config.attach !== undefined
      ? { address: config.attach, ...(config.attachToken !== undefined ? { token: config.attachToken } : {}) }
      : undefined;
    await remote_run(identity, config.commandToExecute, attach, { stopOnError: config.stopOnError === true, allowHostRequests: config.allowHostRequests === true, ...(splash !== undefined ? { splash } : {}) });
    if (config.commandToExecute !== undefined) {
      process.exit(process.exitCode ?? 0);
    }
    return;
  }

  // Install the CLI surface so builtins can prompt in every mode. The REPL
  // reinstalls a surface backed by its persistent readline interface for
  // interactive use; execute and script modes keep this one-shot surface.
  surface_set(cliSurface_create());

  spinner.start('Initializing session components');
  const engine: BrasaEngine = await engine_create();
  spinner.stop();

  if (isInteractiveSession) {
    console.log(chalk.green('[+] Session initialized.'));
    boot?.log('ok', 'Session', 'Components initialized');
  }

  // Set physical filesystem mode if requested
  if (config.physicalFS) {
    session.physicalMode_set(true);
    if (config.mode !== 'execute' && config.mode !== 'script') {
      console.log(chalk.yellow('[!] Physical filesystem mode enabled - logical-to-physical mapping disabled'));
    }
  }

  const ctxResult: Result<SingleContext> = await connection_establish(config, boot);
  if (!ctxResult.ok) process.exit(1);
  let currentContext: SingleContext = ctxResult.value;
  if (!currentContext.folder) {
    currentContext = { ...currentContext, folder: homePath_derive(currentContext.user) };
  }

  // Credentials are good: reset the screen and bring the brain to life above a
  // clear one. Animating in place would leave it anchored off the top of a
  // screen the login output has already scrolled, where it paints over the
  // boot report and the daemon's own addresses instead of over itself. This
  // is the boot experience for every interactive mode, daemon included: the
  // brain lights up at connect and the boot log scrolls beneath it. What a
  // daemon boot must NOT do is repaint the brain after the addresses print —
  // the ready handoff halts the pulse without a final repaint (logo_animateHalt)
  // so the text record stays verbatim for the console face's Esc view.
  if (isInteractiveSession && showLogo && !useAsciiBoot) {
    logo_reviveOnScreen();
  }


  // --- Daemon Mode ---
  // Host the connected engine over WebSocket and stay alive on the server.
  if (config.mode === 'daemon') {
    // Off a TTY the daemon's stdout is somebody's pipe — a porter's, a
    // service manager's — and that somebody may go away first. A session
    // outlives its door: a write to a pipe with no reader is dropped, not
    // fatal, so the wire and the surfaces on it never notice.
    if (process.stdout.isTTY !== true) {
      const pipe_tolerate = (error: NodeJS.ErrnoException): void => {
        if (error.code !== 'EPIPE') throw error;
      };
      process.stdout.on('error', pipe_tolerate);
      process.stderr.on('error', pipe_tolerate);
    }
    const warmupFlags: StartupWarmupFlags = {
      plugins: prefetchPlugins,
      feeds: prefetchFeeds,
      publicFeeds: prefetchPublicFeeds,
      jobs: prefetchJobs,
    };
    await daemonSession_run(
      engine,
      currentContext.user ?? undefined,
      warmupFlags,
      isInteractiveSession,
      boot ?? bootLogger_create('ChELL Boot', useAsciiBoot),
      undefined,
      { flag: config.hostControl, env: process.env['CALYPSO_HOST_CONTROL'], exposed: config.exposeHostControl === true },
      // A boot ends at a login only where there is a terminal to log in on.
      // Off a TTY — a service manager, a login front holding the pipe — a
      // console spawned onto stdin would attach a surface to nothing and
      // wait for an Enter that cannot come; the daemon just keeps listening,
      // the same as the standalone `calypso` binary already does.
      process.stdin.isTTY === true && process.stdout.isTTY === true ? undefined : daemonConsole_skip,
    );
    return;
  }

  // --- Execution Mode ---

  if (config.mode === 'execute' && config.commandToExecute) {
    // Set stop-on-error flag if requested
    if (config.stopOnError) {
      stopOnError_set(true);
    }
    // A one-shot skips the warm-up, correctly — but not the replay index,
    // which a previous run already paid to build and which decides whether
    // a scripted PACS question troubles the PACS at all.
    await queryCheckpoint_prime(currentContext.user ?? undefined);
    const envelopes: CommandEnvelope[] = await surfaceLine_execute(engine, config.commandToExecute);
    // `chell -c cmatrix` on a terminal plays it, as the shell would.
    const show: GameShow | null = gameShow_find(envelopes);
    if (show !== null && gameTerminal_is()) await game_play(show);
    // An error envelope means the command failed, whether or not the builtin
    // set an exit code itself; scripts must never see failure exit 0.
    const anyError: boolean = envelopes.some((envelope: CommandEnvelope): boolean => envelope.status === 'error');
    // What this run learned about prior PACS queries outlives it: the
    // checkpoint's debounced writer never fires in a process this short.
    await queryCheckpoint_flush();
    process.exit(process.exitCode || (anyError ? 1 : 0));
  }

  // --- Script Mode ---

  if (config.mode === 'script' && config.scriptFile) {
    await queryCheckpoint_prime(currentContext.user ?? undefined);
    await script_execute(engine, config.scriptFile);
    await queryCheckpoint_flush();
    process.exit(process.exitCode || 0);
  }

  // --- Interactive Mode ---

  await interactiveSession_run(
    engine,
    config,
    currentContext,
    { prefetchPlugins, prefetchFeeds, prefetchPublicFeeds, prefetchJobs, isInteractiveSession, useAsciiBoot },
    boot,
  );
}
