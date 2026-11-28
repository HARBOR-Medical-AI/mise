/**
 * @file The `chell --remote` client.
 *
 * Attaches to a same-user CALYPSO daemon and drives it with the ordinary REPL,
 * proving the sibling-surfaces topology: the same REPL runs over either an
 * in-process engine or a remote one. The remote engine delivers received
 * output to the sink exactly as the local engine delivers live, so the REPL is
 * unchanged. Another surface's activity (the session bus) is printed as it
 * arrives.
 *
 * With identity-keyed berths, several daemons — one per `<user>@<url>` — can run
 * on one machine. This client resolves the berth to attach: by identity when one
 * was given (`chell --remote me@https://cube/api/v1/`), else the sole live berth,
 * else an interactive pick among several. A dead berth is reaped on the failed
 * probe. See docs/session-supervisor.adoc.
 *
 * @module
 */
import { createInterface, type Interface } from 'node:readline/promises';
import chalk from 'chalk';
import type { CommandEnvelope } from '@fnndsc/cumin';
import { REPL } from '../core/repl.js';
import { RemoteEngine, type DaemonStack } from './remoteEngine.js';
import { buildMismatch_line, closingLine_render, staleLines_render, surfaceNews_read } from './buildMatch.js';
import type { ClosingCause } from '@fnndsc/menu';
import { berthInstance_probe, LocalBerthResolver, type Berth } from '@fnndsc/calypso';
import { berthIdentities_derive } from './berthTarget.js';
import { splashLines_render } from './splash.js';
import { sink_set, StdoutSink, surface_get, surface_set, welcomeLine_build, welcomeLine_compose, stackBanner_rows, stackBannerRow_paint, buildHash_get } from '@fnndsc/brasa';
import { cliSurface_create } from '../core/cliSurface.js';
import type { FileDeliverRequest, FileDeliverResult } from '@fnndsc/menu';
import { TerminalProgressRenderer } from '../core/progressRenderer.js';
import { greeting_print } from '../core/greeting.js';
import { surfaceLine_execute } from '../core/surfaceDispatch.js';
import { game_play, gameShow_find, gameTerminal_is, type GameShow } from '../core/gamePlayer.js';
import { output_above } from '../core/lineDiscipline.js';
import { hostControl_phrase } from './hostControl.js';

/**
 * Builds a berth from an address given on the command line.
 *
 * Berth discovery reads this machine's runtime directory, so it cannot see a
 * daemon on another host. An explicit address is how a surface elsewhere
 * attaches, and the address accepted is the one the daemon prints — either the
 * ARGUS link, token and all, or the bare wire URL with `--token` beside it.
 *
 * @param address - `ws://host:port`, or `http://host:port/?token=…`.
 * @param token - The attach token, when the address does not carry one.
 * @returns The berth to attach, or null when the address cannot be read (a
 *   message is printed).
 */
export function berth_parse(address: string, token?: string): Berth | null {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    console.error(chalk.red(`[!] '${address}' is not a URL. Paste the address calypso printed.`));
    return null;
  }

  const carried: string | null = parsed.searchParams.get('token');
  const attachToken: string | undefined = token ?? carried ?? undefined;
  if (attachToken === undefined) {
    console.error(chalk.red('[!] No attach token. Pass --token, or paste the URL calypso printed, which carries one.'));
    return null;
  }

  // The daemon serves the web surface and the wire on one port, so an http
  // address names the same endpoint as its ws form.
  const scheme: string = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss' : 'ws';
  if (!parsed.hostname) {
    console.error(chalk.red(`[!] '${address}' names no host.`));
    return null;
  }
  const url: string = `${scheme}://${parsed.host}`;
  return { identity: `${url} (attached by address)`, url, token: attachToken };
}

/**
 * Fetches a file's bytes from a daemon's token-gated byte route.
 *
 * A remote client's engine is on another machine, so it cannot read the file
 * itself. It uses the same `/vfs` route a browser surface uses to render a
 * file natively — the intent travelled through the vocabulary, and only the
 * bytes travel here.
 *
 * @param berth - The daemon to fetch from, carrying its URL and attach token.
 * @returns A fetch bound to that daemon.
 */
function berthBytes_fetch(berth: Berth, headers: Record<string, string> = {}): (filePath: string) => Promise<Buffer> {
  return async (filePath: string): Promise<Buffer> => {
    // A berth is `ws://host:port`; a door's is `wss://host/s/<key>/`. Either
    // way the byte route is `vfs` beside the wire, and a door puts the token
    // on for a cookie it recognises.
    const base: string = berth.url.replace(/^ws/, 'http').replace(/\/$/, '');
    const url: string = berth.token.length > 0
      ? `${base}/vfs?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(berth.token)}`
      : `${base}/vfs?path=${encodeURIComponent(filePath)}`;
    const response: Response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`calypso refused to serve ${filePath} (HTTP ${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  };
}

/**
 * Prompts the operator to choose one berth from several, over the terminal.
 *
 * @param berths - The live berths to choose among.
 * @returns The chosen berth, or null when the choice was invalid or aborted.
 */
async function berth_pick(berths: Berth[]): Promise<Berth | null> {
  console.log(chalk.cyan('Several calypso sessions are running:'));
  berths.forEach((berth: Berth, index: number): void => {
    console.log(`  ${chalk.bold(String(index + 1))}. ${berth.identity}  ${chalk.gray(berth.url)}`);
  });
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await rl.question(chalk.cyan(`Attach to which? [1-${berths.length}] `));
    const choice: number = parseInt(answer.trim(), 10);
    if (isNaN(choice) || choice < 1 || choice > berths.length) {
      console.error(chalk.red('[!] Invalid choice.'));
      return null;
    }
    return berths[choice - 1];
  } finally {
    rl.close();
  }
}

/**
 * Selects the berth to attach to: by the target's identity when given, else
 * the sole live berth, else an interactive pick (a non-interactive caller must
 * be explicit).
 *
 * @param target - The `<user>@<where>` target as typed, or undefined for a
 *   bare `--remote`.
 * @returns The berth to attach, or null when none can be resolved (a message is
 *   printed).
 */
async function berth_select(target: string | undefined): Promise<Berth | null> {
  // Only a record whose daemon proves it is the instance that wrote it is attached to (calypso's instance probe):
  // the attach token is never sent to an address that merely accepts a connection.
  const resolver: LocalBerthResolver = new LocalBerthResolver(berthInstance_probe);

  if (target) {
    for (const identity of berthIdentities_derive(target)) {
      const berth: Berth | null = await resolver.resolve(identity);
      if (berth) {
        return berth;
      }
    }
    console.error(chalk.red(`[!] No live calypso for ${target}. Start one with:  calypso ${target}`));
    return null;
  }

  const berths: Berth[] = await resolver.list();
  if (berths.length === 0) {
    console.error(chalk.red('[!] No calypso found. Start one with:  calypso <user>@<url>'));
    return null;
  }
  if (berths.length === 1) {
    return berths[0];
  }
  if (!process.stdin.isTTY) {
    console.error(chalk.red('[!] Several calypso sessions are running; specify one:  chell --remote <user>@<url>'));
    for (const berth of berths) {
      console.error(`      ${berth.identity}  ${chalk.gray(berth.url)}`);
    }
    return null;
  }
  return berth_pick(berths);
}

/**
 * Splits a line on `;` outside quotes, the way the kernel's batch does, so
 * `-e` can stop between segments.
 *
 * @param line - The one-shot line as typed.
 * @returns The segments, trimmed, empties dropped.
 */
export function commands_split(line: string): string[] {
  const segments: string[] = [];
  let current: string = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char: string = line[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      else if (char === '\\' && i + 1 < line.length) { current += line[i + 1] as string; i += 1; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ';') { segments.push(current); current = ''; continue; }
    current += char;
  }
  segments.push(current);
  return segments.map((segment: string): string => segment.trim()).filter((segment: string): boolean => segment.length > 0);
}

/** What a one-shot line through a door answered, and the status it ended with. */
interface LineRun {
  /** The envelopes, in order. */
  readonly envelopes: CommandEnvelope[];
  /** The exit status, as `$?` would hold it. */
  readonly exitCode: number;
}

/**
 * Runs one segment and reads the status it ended with: the daemon's, or 1
 * for an error envelope it named no status for.
 *
 * @param engine - The attached engine.
 * @param segment - The line.
 * @returns What it answered and its status.
 */
async function segment_run(engine: RemoteEngine, segment: string): Promise<LineRun> {
  engine.exitCode_take();
  const envelopes: CommandEnvelope[] = await surfaceLine_execute(engine, segment);
  const said: number = engine.exitCode_take();
  const failed: boolean = envelopes.some((envelope: CommandEnvelope): boolean => envelope.status === 'error');
  return { envelopes, exitCode: said !== 0 ? said : (failed ? 1 : 0) };
}

/** Runs a line segment by segment, stopping at the first that fails (an error envelope or a status other than 0). */
async function segments_execute(engine: RemoteEngine, line: string): Promise<LineRun> {
  const envelopes: CommandEnvelope[] = [];
  let exitCode: number = 0;
  for (const segment of commands_split(line)) {
    const answered: LineRun = await segment_run(engine, segment);
    envelopes.push(...answered.envelopes);
    exitCode = answered.exitCode;
    if (exitCode !== 0) break;
  }
  return { envelopes, exitCode };
}

/**
 * Runs the remote client: resolves a daemon berth, attaches, and enters the
 * REPL.
 *
 * @param identity - The `<user>@<where>` to attach to, as typed (see
 *   {@link berthIdentities_derive}), or undefined to resolve the sole live berth.
 * @param commandToExecute - An optional one-shot command. When present, execute
 *   it and detach without creating an interactive REPL.
 * @param attach - An explicit daemon address, for a daemon on another machine
 *   that this host's berth directory cannot know about. Bypasses discovery.
 * @param options - `stopOnError` for a one-shot line; `splash` to draw the
 *   session's art once the attach answer names its backend.
 * @returns A promise that resolves when the client session ends.
 */
export async function remote_run(
  identity?: string,
  commandToExecute?: string,
  attach?: { address: string; token?: string; headers?: Record<string, string> },
  options: { stopOnError?: boolean; splash?: { colorize: boolean } } = {},
): Promise<void> {
  // Through a door there is no token to carry: the cookie in the headers is
  // the credential, and the door puts the token on the daemon's side.
  const addressed: Berth | null = attach
    ? (attach.headers !== undefined
      ? { identity: identity ?? attach.address, url: attach.address, token: '' }
      : berth_parse(attach.address, attach.token))
    : null;
  const headers: Record<string, string> = attach?.headers ?? {};
  // An address names no identity; a caller that knows one (the daemon
  // console attaching to its own daemon) says so, and the surface greets
  // with it rather than with the address twice.
  const berth: Berth | null = attach
    ? (addressed !== null && identity !== undefined ? { ...addressed, identity } : addressed)
    : await berth_select(identity);
  if (!berth) {
    process.exit(1);
  }

  let engine: RemoteEngine;
  let intentionalClose: boolean = false;
  // Why the daemon went, when it says before it goes.
  let closing: ClosingCause | null = null;
  try {
    engine = await RemoteEngine.connect({
      url: berth.url,
      token: berth.token,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      onSession: commandToExecute === undefined
        ? (surface: string, envelope: CommandEnvelope): void => {
            if (envelope.rendered.length > 0) {
              // Above whatever is being typed, which is then drawn again:
              // the prompt at rest, or an open question.
              output_above(`${chalk.gray(`[surface ${surface.slice(0, 6)}]`)}\n${envelope.rendered}`);
            }
          }
        : undefined,
      onPrompt: (message: string, hidden: boolean): Promise<string> =>
        // The REPL has installed the CLI surface (readline-backed) by the time
        // a prompt can arrive, so this reads from the local terminal.
        surface_get().prompt({ message, hidden }),
      onPipe: (command: string, input: Buffer): Promise<Buffer> =>
        // Pipeline segments run on this machine, through the client's own
        // tools — never on the daemon host.
        surface_get().pipeSegment(command, input),
      onShell: (command: string): Promise<number> =>
        // Host-shell escapes belong to the attached surface, so `!cmd` runs
        // on this client machine and never on the daemon host.
        surface_get().shellCommand(command),
      onEdit: (content: string, extension: string | undefined): Promise<{ content: string; changed: boolean }> =>
        // Editing happens in this machine's editor.
        surface_get().localEdit({ content, extension }),
      onDeliver: (request: FileDeliverRequest): Promise<FileDeliverResult> =>
        // A downloaded file lands on this machine's disk, never the daemon's.
        surface_get().fileDeliver(request),
      // A `!` the daemon runs under host control draws here, on a pty of its own.
      ...(process.stdin.isTTY === true && process.stdout.isTTY === true
        ? { terminal: { input: process.stdin, output: process.stdout, term: process.env['TERM'] ?? '' } }
        : {}),
      onClosing: (cause: ClosingCause): void => { closing = cause; },
      // The daemon's code moved on disk mid-session: say so where the operator is looking.
      onStale: (stale: boolean): void => {
        if (!stale) return;
        process.stderr.write(`\n${staleLines_render(surfaceNews_read()).map((line: string): string => chalk.yellow(line)).join('\n')}\n`);
      },
      onClose: (): void => {
        if (intentionalClose) return;
        // A daemon that said why it went is believed; an unannounced drop is a disconnect.
        console.error(chalk.yellow(`\n${closing !== null ? closingLine_render(closing) : '[!] Daemon disconnected.'}`));
        process.exit(0);
      },
    });
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`[!] Could not attach to the daemon: ${message}`));
    process.exit(1);
    return;
  }

  if (commandToExecute !== undefined) {
    const progressRenderer: TerminalProgressRenderer = new TerminalProgressRenderer();
    sink_set(new StdoutSink(progressRenderer));
    surface_set(cliSurface_create(undefined, berthBytes_fetch(berth, headers)));
    try {
      // `-e` through a door: the daemon's own stop-on-error is not this
      // process's, so the line is run a segment at a time here and stops at
      // the first whose answer is an error (`cd nowhere; rm -r x` removes nothing).
      const run: LineRun = options.stopOnError === true
        ? await segments_execute(engine, commandToExecute)
        : await segment_run(engine, commandToExecute);
      const envelopes: CommandEnvelope[] = run.envelopes;
      // The line's own status, as the daemon's `$?` holds it.
      process.exitCode = run.exitCode;
      // `chell --remote -c cmatrix` on a terminal plays it here.
      const show: GameShow | null = gameShow_find(envelopes);
      if (show !== null && gameTerminal_is()) await game_play(show);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      console.error(chalk.red(`Command error: ${message}`));
    } finally {
      // Nothing announced by the command may outlive it; see the same clear in
      // the REPL's line handler.
      progressRenderer.clear();
      intentionalClose = true;
      engine.close();
    }
    return;
  }

  // The splash is the session's composition, known only now: the brain for
  // ChRIS, the Trusted Domain mark for stratus, nothing for another backend.
  if (options.splash !== undefined) {
    const art: string[] = splashLines_render(engine.backend_get(), options.splash.colorize);
    if (art.length > 0) {
      for (const line of art) console.log(line);
      console.log('');
    }
  }

  // Greet with the daemon's own reported versions and build hash; a daemon
  // that predates the handshake field falls back to the local install's.
  // The daemon console skips the greeting: it sits on the daemon's own
  // terminal, directly under the banner the daemon just printed.
  const stack: DaemonStack | undefined = engine.daemonStack();
  const onDaemonTerminal: boolean = process.env['CHELL_CONSOLE'] === '1';
  if (!onDaemonTerminal) {
    const welcome: string = stack !== undefined
      ? welcomeLine_compose('chell', stack.chell, stack.build)
      : welcomeLine_build('chell');
    console.log(chalk.bold.cyan(welcome));
  }
  console.log(chalk.green(`[+] Attached to CALYPSO daemon ${berth.identity} at ${berth.url}`));
  if (stack !== undefined && !onDaemonTerminal) {
    // Banner the daemon's whole stack, every package written out in full;
    // older daemons report only chell and calypso, and get only those rows.
    for (const row of stackBanner_rows(stack)) {
      console.log(`    ${stackBannerRow_paint(row, { name: chalk.bold.cyan, phrase: chalk.white, version: chalk.gray })}`);
    }
  }
  const buildWarning: string | null = stack !== undefined ? buildMismatch_line(buildHash_get(), stack.build) : null;
  if (buildWarning !== null) console.log(chalk.yellow(buildWarning));
  // The daemon's own word on itself: its disk code moved since it started.
  if (engine.daemonStale) for (const line of staleLines_render(surfaceNews_read())) console.log(chalk.yellow(line));
  const hostControl: string[] = engine.hostControl ?? [];
  if (hostControl.length > 0) {
    // The daemon acts on its own host: `!`, pipes, and the disk are the
    // daemon's, not this machine's. Said once here, and on every prompt.
    console.log(chalk.yellow(`[!] HOST CONTROL: ${hostControl.join(' ')} — ${hostControl_phrase(hostControl)}`));
  }
  console.log(chalk.gray("    Type 'exit' to detach.\n"));
  // The session greets: who you are, what you hold, what is running — the
  // kernel's `motd`, the same greeting a browser shows, with the fortune
  // that used to stand here inside it.
  await greeting_print(engine);

  // The daemon pushes the themed prompt string; the REPL renders whatever the
  // daemon last sent, falling back until the first push arrives.
  const repl: REPL = new REPL(engine, {
    promptText: (): string => engine.promptLine() || 'chell(remote) ❯ ',
    // The engine is on the daemon, so this surface fetches bytes from it
    // rather than reading a file it has no access to.
    bytesFetch: berthBytes_fetch(berth, headers),
  });
  await repl.start();
}
