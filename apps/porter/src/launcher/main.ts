#!/usr/bin/env node
/**
 * @file `berth-launcher`: the one process on a spoke that holds the
 * container engine (docs/dev-bastion.adoc, stand-in, Q1). Porter asks it,
 * and nothing else may, to start, stop or report a user's berth.
 *
 * It reads:
 *   BERTH_LAUNCHER_SECRET_FILE  the secret porter carries (mode 0600; required)
 *   BERTH_LAUNCHER_LISTEN       a unix socket path, or host:port on loopback (required)
 *   BERTH_DOCKER_SOCKET         the engine's socket (/var/run/docker.sock)
 *   BERTH_IMAGE                 the berth image, pulled before each berth is made (mise-berth's latest by default)
 *   BERTH_PREFIX                what this spoke's berths are named with (mise-berth)
 *   BERTH_CUBE_NETWORK          cube-net, where every berth reaches the CUBE API (<prefix>-cube-net)
 *   BERTH_PORTER_CONTAINER      porter's container, joined to each berth's wire; unset when porter runs on the host
 *   BERTH_CUBE_HOST             CUBE's name, resolved to cube-net's gateway inside each berth; unset: by public DNS
 *   BERTH_POLICY_FILE           the spoke's policy (cpus, memoryGib, pids, holds); defaults when unset
 *   BERTH_PROFILE               the ChRIS profile the spoke runs, for its floor (minimal)
 *
 * @module
 */
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { entry_isMain } from '../entry.js';
import { launcherSecret_read } from './secret.js';
import { DockerSocket } from './docker.js';
import { BERTH_IMAGE_DEFAULT, BerthLauncher } from './launcher.js';
import { berthPolicy_read, type BerthPolicy } from './policy.js';
import { launcherServer_create } from './server.js';

async function launcher_start(): Promise<void> {
  const env: NodeJS.ProcessEnv = process.env;
  const listen: string | undefined = env['BERTH_LAUNCHER_LISTEN'];
  // A socket an earlier run left is removed first, so a launcher that stops below never looks as if it answers.
  if (listen !== undefined && listen !== '' && !/^(127\.0\.0\.1|localhost|::1):\d+$/.test(listen) && existsSync(listen)) unlinkSync(listen);
  let secret: string;
  let policy: BerthPolicy;
  try {
    secret = launcherSecret_read(env['BERTH_LAUNCHER_SECRET_FILE']);
    policy = berthPolicy_read(env['BERTH_POLICY_FILE'] ?? null);
  } catch (error: unknown) {
    console.error(`[!] berth-launcher: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (listen === undefined || listen === '') {
    console.error('[!] berth-launcher: BERTH_LAUNCHER_LISTEN is required: a unix socket path, or 127.0.0.1:<port>');
    process.exit(1);
  }
  if (!/^(127\.0\.0\.1|localhost|::1):\d+$/.test(listen) && Buffer.byteLength(listen) > 100) {
    console.error(`[!] berth-launcher: ${listen}: a socket path longer than 100 bytes; give a shorter one`);
    process.exit(1);
  }
  const prefix: string = env['BERTH_PREFIX'] ?? 'mise-berth';
  const launcher: BerthLauncher = new BerthLauncher({
    docker: new DockerSocket(env['BERTH_DOCKER_SOCKET'] ?? '/var/run/docker.sock'),
    policy,
    image: env['BERTH_IMAGE'] ?? BERTH_IMAGE_DEFAULT,
    prefix,
    cubeNetwork: env['BERTH_CUBE_NETWORK'] ?? `${prefix}-cube-net`,
    porterContainer: env['BERTH_PORTER_CONTAINER'] !== undefined && env['BERTH_PORTER_CONTAINER'] !== '' ? env['BERTH_PORTER_CONTAINER'] : null,
    log: (line: string): void => { console.log(`[+] ${line}`); },
    ...(env['BERTH_PROFILE'] !== undefined ? { profile: env['BERTH_PROFILE'] } : {}),
    ...(env['BERTH_CUBE_HOST'] !== undefined && env['BERTH_CUBE_HOST'] !== '' ? { cubeHost: env['BERTH_CUBE_HOST'] } : {}),
  });
  const server = launcherServer_create(launcher, secret, (line: string): void => { console.log(`[+] ${line}`); });
  const hostPort: RegExpExecArray | null = /^(127\.0\.0\.1|localhost|::1):(\d+)$/.exec(listen);
  if (hostPort !== null) {
    server.listen(Number(hostPort[2]), hostPort[1]);
  } else {
    if (existsSync(listen)) unlinkSync(listen);
    server.listen(listen, (): void => { chmodSync(listen, 0o600); });
  }
  server.on('listening', (): void => {
    console.log(`[+] BERTH LAUNCHER on ${listen}: ${prefix} berths, each on its own wire with porter${env['BERTH_PORTER_CONTAINER'] ? ` (${env['BERTH_PORTER_CONTAINER']})` : ' (on the host)'} and on ${env['BERTH_CUBE_NETWORK'] ?? `${prefix}-cube-net`}; each ${policy.limits.cpus} CPU, ${policy.limits.memoryGib} GiB, ${policy.limits.pids} processes${policy.holds !== null ? `, at most ${policy.holds}` : ''}`);
    void launcher.capacity_get().then((capacity: number): void => { console.log(`    this host holds ${capacity} berth${capacity === 1 ? '' : 's'}`); }, (): void => undefined);
    void launcher.orphans_clear().then((removed: string[]): void => { if (removed.length > 0) console.log(`    removed what an earlier run left: ${removed.join(', ')}`); }, (error: unknown): void => { console.error(`[!] orphans: ${error instanceof Error ? error.message : String(error)}`); });
  });
  const stop = (): void => { server.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// Started as the program, through npm's bin link or by its own path; imported, it stays quiet.
if (entry_isMain(process.argv[1], import.meta.url)) void launcher_start();
