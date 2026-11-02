/**
 * @file The `chell --daemon` launcher.
 *
 * Hosts the already-created chell engine behind a CALYPSO daemon. Two host
 * concerns are handled here that the transport-agnostic daemon (in calypso)
 * cannot: color is forced on (a daemon has no TTY, so chalk would otherwise
 * strip it, and the rendered text must carry color for a remote terminal to
 * reproduce the local experience), and the engine's live sink output is
 * routed through the command's origin surface rather than rendered on the
 * daemon's own console.
 *
 * @module
 */
import { elevation_read, type ElevationDoor } from './elevation.js';
import * as path from 'node:path';
import chalk from 'chalk';
import { CalypsoDaemon, type PromptLastCommand } from './server.js';
import { bundledWebRoot_find, webRoot_resolve, webRootBuild_read, webRootVersion_read, type WebRootBuild } from './static.js';
import { hostFqdn_get } from './host.js';
import { codeWatch_start, type CodeWatch } from './codeIdentity.js';
import { token_generate } from './token.js';
import type { BrasaEngine } from '@fnndsc/brasa/core';
import type { ProgressEvent, PromptContext } from '@fnndsc/menu';
import type { OutputSink, Surface, SurfaceCapabilities, SurfacePeer, PromptRequest, LocalEditRequest, LocalEditResult } from '@fnndsc/menu/surface';
import type { FileDeliverRequest, FileDeliverResult } from '@fnndsc/menu';
import { backend_get, type Backend, type SessionIdentity } from '@fnndsc/brasa/core';
import { stackBanner_rows, stackBannerRow_paint, versions_get, versions_selectForBackend, buildHash_get } from '@fnndsc/brasa/core';
import { identity_normalise, berth_write, berthOwn_read, berth_path, berthUrl_isAlive, closing_take, type Berth } from './berth.js';
import type { ClosingCause } from '@fnndsc/menu';
import { attachFile_write, attachFile_remove } from './attachFile.js';
import { CHELL_ON_PATH, chellLaunch_find, type SurfaceLaunch } from './consoleSession.js';
import { Terminals, ptySpawn_load, type PtySpawn } from './terminals.js';
import { HOST_CONTROL_OFF, hostControl_describe, hostControl_guard, hostControl_tiers, hostPipe_run, hostShell_run, type HostControlPolicy } from './hostControl.js';

/** What a launched daemon hands back to its host (the console face's feed). */
export interface DaemonLaunchInfo {
  /** The CUBE identity this daemon hosts. */
  identity: string;
  /** The WebSocket wire address. */
  url: string;
  /** The attach token gating every session. */
  token: string;
  /** The berth file advertising this daemon. */
  berthPath: string;
  /** The ARGUS web-surface address, when a bundle is served. */
  argusUrl: string | null;
  /** The running daemon, for live telemetry. */
  daemon: CalypsoDaemon;
  /** The declared host-control policy. */
  hostControl: HostControlPolicy;
  /** The bind address, for the face's exposure line. */
  bindHost: string;
}

/** The daemon sink forwards live command output to the executing surface. */
export class DaemonSink implements OutputSink {
  constructor(private readonly daemon: CalypsoDaemon) {}

  /** @inheritdoc */
  public data_write(chunk: string | Buffer): void { this.output_write('data', chunk); }
  /** @inheritdoc */
  public err_write(chunk: string | Buffer): void { this.output_write('err', chunk); }
  /** @inheritdoc */
  public status_write(text: string): void { this.daemon.output_current('status', text); }
  /** @inheritdoc */
  public progress_write(event: ProgressEvent): void { this.daemon.progress_current(event); }
  /** @inheritdoc */
  public event_write(kind: string, data: unknown): void { this.daemon.event_current(kind, data); }

  private output_write(channel: 'data' | 'err', chunk: string | Buffer): void {
    const text: string = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    this.daemon.output_current(channel, text);
  }
}

/**
 * Builds the surface a daemon-hosted engine talks to.
 *
 * Interactivity is a surface capability: prompts, pipeline segments, shell
 * escapes, local editing and file delivery reach the surface running the
 * command through the daemon's brokers, without knowing the transport. Nothing
 * ever spawns on the daemon host, and nothing is ever written to its disk.
 *
 * @param daemon - The daemon whose brokers deliver the capability requests.
 * @returns The surface to install through the engine's `surface_install`.
 */
export function daemonSurface_create(daemon: CalypsoDaemon, policy: HostControlPolicy = HOST_CONTROL_OFF): Surface {
  return {
    // A daemon has no capabilities of its own to offer. Those that vary by
    // surface are read from whichever one is executing, as it declared them on
    // attach — a browser and a remote shell differ, and answering for both
    // would either archive a directory a shell wanted whole or hand a browser
    // a tree it cannot hold.
    get capabilities(): SurfaceCapabilities {
      const attached = daemon.capabilities_current();
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
        pipeSegments: policy.tiers.has('pipes') || (attached?.pipeSegments ?? false),
        shellCommands: true,
        fileDelivery: attached?.fileDelivery ?? false,
        // The daemon's disk belongs to nobody attending this session — unless
        // the operator who started it declared otherwise with the `files`
        // tier of --host-control, in which case it is theirs by declaration.
        engineFilesystem: policy.tiers.has('files'),
        localFilesystem: attached?.localFilesystem ?? false,
        // Long jobs that change things beyond this host, and bill: only the
        // operator who started the daemon grants them, never a surface.
        tasks: policy.tiers.has('tasks') || (attached?.tasks ?? false),
      };
    },
    peers: (): SurfacePeer[] => daemon.surfaces_list(),
    prompt: (request: PromptRequest): Promise<string> =>
      daemon.prompt_current({
        message: request.message,
        hidden: request.hidden ?? false,
        ...(request.wants === undefined ? {} : { wants: request.wants }),
        ...(request.path === undefined ? {} : { path: request.path }),
        ...(request.commit === undefined ? {} : { commit: request.commit }),
      }),
    // Under host control the host wins: the segment or the shell runs here,
    // output on the session bus like any command's. Otherwise both relay to
    // the surface that typed them.
    pipeSegment: (command: string, input: Buffer, signal?: AbortSignal): Promise<Buffer> =>
      policy.tiers.has('pipes') ? hostPipe_run(command, input, signal) : daemon.pipe_current(command, input),
    // A terminal's chell is on this host: under host control it runs `!` in
    // its own pty, so a full-screen program gets a terminal (#1096).
    shellCommand: (command: string, signal?: AbortSignal): Promise<number> =>
      !policy.tiers.has('shell')
        ? daemon.shell_current(command)
        : daemon.current_isTerminal()
          ? daemon.shell_current(command, true)
          : hostShell_run(command, (channel: 'data' | 'err', chunk: string): void => { daemon.output_current(channel, chunk); }, signal),
    localEdit: (request: LocalEditRequest): Promise<LocalEditResult> =>
      daemon.edit_current(request.content, request.extension, request.path),
    fileDeliver: (request: FileDeliverRequest): Promise<FileDeliverResult> =>
      daemon.deliver_current(request),
    // A command following a task waits out of the lane, so the session runs other lines meanwhile.
    aside: <T>(waiting: Promise<T>): Promise<T> => daemon.aside_current(waiting),
    // A joblet holds what its line changes, in the same lane as every line.
    hold: (holds: string[] | 'all'): Promise<() => void> => daemon.hold_take(holds),
  };
}

/**
 * Starts the daemon over an engine and advertises it for same-user discovery.
 *
 * @param engine - The engine to host (already created and connected by boot).
 * @param beforeListen - Optional host preparation run after the duplicate guard
 *   and before the socket binds or the berth is published.
 * @returns The launched daemon's addresses and handle, once it is listening;
 *   the process then stays alive on the WebSocket server.
 */
/**
 * The daemon's prompt provider: the backend's prompt context for the last
 * command, with the host-control tiers this daemon declares.
 *
 * @param prompt - The backend's prompt.
 * @param hostControl - The declared host-control policy.
 * @returns What the daemon calls for each promptline.
 */
function promptProvider_wrap(
  prompt: NonNullable<Backend['prompt']>,
  hostControl: HostControlPolicy,
): (last?: PromptLastCommand) => Promise<PromptContext> {
  return async (last?: PromptLastCommand): Promise<PromptContext> => ({
    ...(await prompt(
      last !== undefined
        ? { lastCommandDurationMs: last.durationMs, lastExitCode: last.exitCode }
        : {},
    )),
    ...(hostControl.tiers.size > 0 ? { hostControl: hostControl_tiers(hostControl) } : {}),
  });
}

/**
 * What a launcher decided beyond the engine.
 *
 * @property hostControl - The declared host-control policy (off by default).
 */
export interface DaemonLaunchOptions {
  hostControl?: HostControlPolicy;
  /**
   * The web surface's built bundle, as the launcher found it (chell finds
   * ARGUS); `CALYPSO_WEB_ROOT` and a bundle in the working directory or the
   * enclosing checkout come first. calypso itself depends on no surface.
   */
  webRoot?: string | null;
  /**
   * How to run the chell a browser's terminal holds: chell passes itself;
   * the standalone calypso binary runs the `chell` on the path.
   */
  surfaceLaunch?: SurfaceLaunch;
}

export async function daemon_launch(
  engine: BrasaEngine,
  beforeListen?: () => Promise<void>,
  options: DaemonLaunchOptions = {},
): Promise<DaemonLaunchInfo> {
  // Force color into the engine's rendered text: no TTY here to auto-detect.
  if (chalk.level < 1) {
    chalk.level = 3;
  }

  // Key the berth by the identity this daemon hosts, so several daemons —
  // one per identity — can advertise on one machine. A daemon with no restored
  // session (disconnected standalone start) has the backend's disconnected
  // identity, so it stays discoverable.
  const backend: Backend = backend_get();
  const sessionIdentity: SessionIdentity = await backend.session.identity_get();
  const identity: string = identity_normalise(sessionIdentity.user, sessionIdentity.where);

  // Guard against a split-brain second daemon for this identity: if one is
  // already live, point the operator at it and refuse rather than host a rival
  // and orphan the running one's berth. This covers both launch paths (chell
  // --daemon and the standalone calypso binary), since both land here.
  const existing: Berth | null = berthOwn_read(identity);
  if (existing && (await berthUrl_isAlive(existing.url))) {
    const attachHint: string = sessionIdentity.connected ? ` ${identity}` : '';
    console.error(chalk.red(`[!] Calypso is already running for ${identity} at ${existing.url}`));
    console.error(chalk.gray(`    attach with:  chell --remote${attachHint}`));
    process.exit(1);
  }

  if (beforeListen) {
    await beforeListen();
  }

  const token: string = token_generate();
  // The web surface is served from the same port as the wire when a built
  // bundle is found: an explicit CALYPSO_WEB_ROOT wins, then the working
  // directory, then the checkout enclosing this module — so a dev-tree
  // `chell --daemon` serves the surface from any directory, with no
  // configuration at all — and last the bundle the launcher found (an
  // installed ARGUS, for somebody who installed rather than cloned).
  const webRoot: string | null = webRoot_resolve([
    process.env['CALYPSO_WEB_ROOT'],
    path.join(process.cwd(), 'apps', 'argus', 'dist'),
    bundledWebRoot_find() ?? undefined,
    options.webRoot ?? undefined,
  ]);
  // Loopback is the posture; CALYPSO_BIND is a deliberate, per-launch
  // opt-out for demos on a trusted network. The attach token still gates
  // every session, but the web bundle and the wire become reachable from
  // any host that can route here.
  const bindHost: string = process.env['CALYPSO_BIND'] ?? '127.0.0.1';
  const hostControl: HostControlPolicy = options.hostControl ?? HOST_CONTROL_OFF;
  const refusal: string | null = hostControl_guard(hostControl, bindHost);
  if (refusal !== null) {
    console.error(chalk.red(`[!] ${refusal}`));
    process.exit(1);
  }
  // The page this kernel starts beside, remembered now: a bundle rebuilt on
  // disk later is served fresh while this process keeps its old code, and a
  // surface compares its own stamp against this one to say so.
  const surfaceBuild: WebRootBuild | null = webRoot !== null ? webRootBuild_read(webRoot) : null;
  // The daemon's own code, fingerprinted now: read again on a slow clock and
  // on every attach, and the answer pushed when it flips.
  let codeWatch: CodeWatch | null = null;
  const elevation: ElevationDoor | null = elevation_read(process.env);
  const daemon: CalypsoDaemon = new CalypsoDaemon({
    engine,
    token,
    host: bindHost,
    port: 0,
    ...(webRoot !== null ? { webRoot } : {}),
    // Which backend the session runs over: a surface draws that composition.
    backend: backend.id,
    // Only the daemon holds the session context, so it renders the themed
    // prompt and pushes it to surfaces. The backend says what both carry.
    ...(backend.telemetry !== undefined ? { telemetryProvider: backend.telemetry } : {}),
    ...(backend.prompt !== undefined ? { promptProvider: promptProvider_wrap(backend.prompt, hostControl) } : {}),
    // Report this process's own versions and build hash so attaching surfaces
    // greet with the daemon's truth rather than their local install's.
    // The stack the session is made of: ChRIS's packages only for a ChRIS session.
    stack: { ...versions_selectForBackend(versions_get(), backend.id), build: buildHash_get(), ...(surfaceBuild !== null ? { surface: surfaceBuild } : {}) },
    hostControl: hostControl_tiers(hostControl),
    // The door this session can be raised at with the person's password, when its host named one (D14).
    ...(elevation !== null ? { elevation } : {}),
    codeCheck: (): void => { void codeWatch?.check().catch((): void => undefined); },
  });
  if (elevation !== null) console.log(chalk.gray(`    MANAGE by password: ${elevation.user} may raise a surface of this session with their ChRIS password`));
  codeWatch = await codeWatch_start((stale: boolean): void => daemon.stale_set(stale)).catch((): null => null);
  // The engine takes its sink and its surface through its own seam: output
  // relays to the attached surfaces, and prompts, pipes, the shell and edits
  // reach them (or this host, where a host-control tier allows).
  engine.sink_install(new DaemonSink(daemon));
  engine.surface_install(daemonSurface_create(daemon, hostControl));
  // Jobs that were running when the daemon last stopped go on, or say why not.
  const resumed: number = engine.jobs_resume?.() ?? 0;

  const port: number = await daemon.start();
  // The berth records where this daemon can actually be reached. Loopback is
  // right for the ordinary case and wrong the moment CALYPSO_BIND opens the
  // wire to the network: a berth copied to another machine, or an address
  // pasted into `chell --remote --attach`, has to name a host that resolves
  // from somewhere else.
  // Every address printed or written below names this host once, and by
  // its fully qualified name: a wildcard bind has no routable form, and the
  // bare hostname resolves only inside its own search domain. Pasted on
  // another machine, the qualified name still works.
  const displayHost: string = bindHost === '0.0.0.0' ? await hostFqdn_get() : bindHost;
  const url: string = `ws://${displayHost}:${port}`;
  // The berth says what code this daemon runs: a door that ships newer code
  // restarts the session at the next login rather than mount an older kernel.
  const berth: Berth = { identity, url, token, pid: process.pid, versions: { ...versions_get() } as Record<string, string>, booted: new Date().toISOString() };
  berth_write(berth);

  // Terminals: a browser's console as a chell under a pty, attached back
  // over loopback (or the one address bound, when that is not a wildcard).
  // A machine where node-pty did not build offers none; its surfaces fall
  // back to the transcript console (deprecated). CALYPSO_NO_PTY=1 makes a
  // daemon that machine, so the fallback can be exercised where a pty builds.
  const ptySpawn: PtySpawn | null = process.env['CALYPSO_NO_PTY'] === '1' ? null : await ptySpawn_load();
  if (ptySpawn !== null) {
    const terminalHost: string = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost;
    daemon.terminals_set(new Terminals({
      spawn: ptySpawn,
      launch: options.surfaceLaunch ?? chellLaunch_find() ?? CHELL_ON_PATH,
      target: { identity, url: `ws://${terminalHost}:${port}`, token },
    }));
  }

  const attachHint: string = sessionIdentity.connected ? ` ${identity}` : '';
  // The boot animation keeps repainting this terminal, and scrollback dies with
  // the next clear. The same addresses go to a file so they can be read back
  // without fighting either.
  const noteLines: string[] = [
    `identity:  ${identity}`,
    `wire:      ${url}`,
    `token:     ${token}`,
    ...(webRoot !== null
      ? [`ARGUS:     http://${displayHost}:${port}/?token=${token}`]
      : []),
    `attach:    chell --remote --attach ${url} --token ${token}`,
    ...(hostControl.tiers.size > 0
      ? [`host control: ${hostControl_describe(hostControl)}${hostControl.exposed && bindHost !== '127.0.0.1' ? ` (EXPOSED on ${bindHost})` : ''}`]
      : []),
  ];
  const notePath: string | null = attachFile_write(noteLines);
  const cleanup = (): void => { if (notePath !== null) attachFile_remove(); };
  if (notePath !== null) {
    process.once('exit', cleanup);
    process.once('SIGINT', (): void => { cleanup(); process.exit(0); });
  }
  // Ended from outside (a porter's restart or end, a plain kill): every
  // surface is told why before the process goes, from the reason the host
  // left beside the berth, so a dropped wire is never mistaken for a crash.
  process.once('SIGTERM', (): void => {
    const cause: ClosingCause = closing_take(identity) ?? 'stop';
    void daemon.closing_announce(cause).finally((): void => { cleanup(); process.exit(0); });
  });

  // The stack, every package written out once, versions in a clean column:
  // the build hash rides the listening line below rather than one row's
  // version, which pushed that row past the column the rest share.
  const build: string = buildHash_get();
  for (const row of stackBanner_rows(versions_selectForBackend(versions_get(), backend.id), webRoot !== null ? webRootVersion_read(webRoot) : null)) {
    console.log(`    ${stackBannerRow_paint(row, { name: chalk.bold.cyan, phrase: chalk.white, version: chalk.gray })}`);
  }
  console.log(chalk.green(`[+] CALYPSO listening on ${url} ${chalk.gray(`(build ${build})`)}`));
  if (hostControl.tiers.size > 0) {
    // Annunciated every launch: this daemon acts on its own host.
    console.log(chalk.yellow(`[!] HOST CONTROL: ${hostControl_describe(hostControl)} — ${hostControl.tiers.has('tasks') && hostControl.tiers.size === 1 ? 'this session may start jobs that change the cloud and bill' : `\`!\`, pipes, and the disk are this host's${hostControl.tiers.has('tasks') ? '; jobs may change the cloud and bill' : ''}`}`));
    if (hostControl.exposed && bindHost !== '127.0.0.1') {
      console.log(chalk.red(`[!] HOST CONTROL EXPOSED ON ${bindHost}: the attach URL is a shell on this host`));
    }
  }
  if (resumed > 0) console.log(chalk.yellow(`[!] ${resumed} task${resumed === 1 ? '' : 's'} picked up again after the restart (ls /proc)`));
  console.log(chalk.gray(`    identity:  ${identity}`));
  console.log(chalk.gray(`    token:     ${token}`));
  console.log(chalk.gray(`    berth:     ${berth_path(identity)}`));
  console.log(chalk.gray(`    attach a surface with:  chell --remote${attachHint}`));
  if (bindHost !== '127.0.0.1') {
    // Berth discovery is a file in this host's runtime directory, so it cannot
    // reach another machine. An explicit address is how a surface elsewhere
    // attaches, and it is worth printing ready to paste.
    console.log(chalk.gray(`    from another machine:   chell --remote --attach ${url} --token ${token}`));
  }
  if (webRoot !== null) {
    console.log(chalk.green(`[+] ARGUS web surface at http://${displayHost}:${port}/?token=${token}`));
    console.log(chalk.gray(`    serving:   ${webRoot}`));
  }
  if (notePath !== null) {
    console.log(chalk.gray(`    these lines also in:  ${notePath}`));
    console.log(chalk.gray('    or run:               calypso --berths'));
  }

  return {
    identity,
    url,
    token,
    berthPath: berth_path(identity),
    argusUrl: webRoot !== null ? `http://${displayHost}:${port}/?token=${token}` : null,
    daemon,
    hostControl,
    bindHost,
  };
}
