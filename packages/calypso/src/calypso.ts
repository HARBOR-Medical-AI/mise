#!/usr/bin/env node
/**
 * @file The `calypso` daemon entry.
 *
 * Starts the session daemon on its own: create a brasa engine, restore a saved
 * session, and host the engine over a WebSocket for surfaces to attach. The
 * daemon is non-interactive — it runs from credentials already saved by the
 * CLI. If none are present it still starts (attachable, but offline until a
 * surface connects), telling the operator to log in with `chell` first.
 *
 * @module
 */

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { versionReport_build, type BrasaEngine } from '@fnndsc/brasa/core';
import type { SavedSessionResult } from '@fnndsc/brasa';
import chalk from 'chalk';
import { daemon_launch, type DaemonLaunchInfo } from './daemon/launch.js';
import { packageWebRoot_find } from './daemon/static.js';
import { daemonConsole_run } from './daemon/consoleSession.js';
import { hostControl_parseArgv, type HostControlPolicy } from './daemon/hostControl.js';
import { LocalBerthResolver, berthUrl_isAlive, type Berth, type LocatedBerth } from './daemon/berth.js';
import { berthLines_say } from './daemon/token.js';

/** The backends a test may ask the calypso command to host instead of ChRIS. */
const TEST_BACKENDS: ReadonlyArray<string> = ['null'];

/**
 * The backend the command was asked to host: ChRIS, unless a test names
 * another with `--backend <id>` (and says it is a test with
 * `CALYPSO_TEST_BACKENDS=1`; the switch is no operator's).
 *
 * @param argv - The command line.
 * @param env - The environment.
 * @returns The backend id, or the refusal.
 */
export function backendRequest_parse(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): { backend: string } | { error: string } {
  const at: number = argv.indexOf('--backend');
  if (at === -1) return { backend: 'chris' };
  const id: string | undefined = argv[at + 1];
  if (env['CALYPSO_TEST_BACKENDS'] !== '1') return { error: '--backend is for tests (set CALYPSO_TEST_BACKENDS=1)' };
  if (id === undefined || !TEST_BACKENDS.includes(id)) return { error: `--backend takes ${TEST_BACKENDS.join(', ')}` };
  return { backend: id };
}

/**
 * The engine over the backend asked for. ChRIS restores the saved session;
 * the null backend loads none of the ChRIS packages at all, so a surface
 * attached to it meets a session with nothing of ChRIS's.
 *
 * @param backend - The backend id.
 * @returns The engine.
 */
async function engine_createForBackend(backend: string): Promise<BrasaEngine> {
  if (backend === 'null') {
    const { engine_create, nullBackend_make } = await import('@fnndsc/brasa/core');
    console.error('[+] Hosting the null backend: no commands of its own, a filesystem in memory.');
    return engine_create(nullBackend_make({ seed: { '/home/user/README': 'A session with no backend of its own.\n' } }));
  }
  const { engine_create, sessionFromSaved_connect } = await import('@fnndsc/brasa');
  const engine: BrasaEngine = await engine_create();
  const result: SavedSessionResult = await sessionFromSaved_connect();
  if (result.status === 'restored') {
    console.error(`[+] Session restored: ${result.context.user}@${result.context.URL}`);
  } else {
    console.error(`[!] No active session (${result.status}). Log in with 'chell' first; hosting offline.`);
  }
  return engine;
}

/**
 * Creates the engine, restores the saved session, and hosts the daemon.
 *
 * @returns A promise that resolves once the daemon is listening; the process
 *   then stays alive on the WebSocket server.
 */
async function calypso_start(): Promise<void> {
  const requested: { backend: string } | { error: string } = backendRequest_parse(process.argv, process.env);
  if ('error' in requested) {
    console.error(`[!] ${requested.error}`);
    process.exit(1);
  }
  const engine: BrasaEngine = await engine_createForBackend(requested.backend);

  const parsedPolicy = hostControl_parseArgv(process.argv, process.env);
  if ('error' in parsedPolicy) {
    console.error(`[!] ${parsedPolicy.error}`);
    process.exit(1);
  }
  const policy: HostControlPolicy = parsedPolicy.policy;
  // The calypso command still defaults to ARGUS, when it is installed beside it.
  const info: DaemonLaunchInfo = await daemon_launch(engine, undefined, {
    hostControl: policy,
    webRoot: packageWebRoot_find('@fnndsc/argus'),
  });
  // The boot ends at a login, the same as `chell --daemon`: on a TTY the
  // daemon's own terminal becomes its first surface, an ordinary
  // `chell --remote` spawned onto it. Off a TTY (systemd, nohup) there is
  // no terminal to attach, so the daemon just keeps listening.
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    await daemonConsole_run({ identity: info.identity, url: info.url, token: info.token });
  }
}

/**
 * Prints how to attach to each live daemon.
 *
 * A daemon prints its addresses once, at launch, into a terminal it then
 * occupies. The facts survive in the berth — url and token, mode 0600 in the
 * user's runtime directory — so they are reprinted from there rather than
 * copied somewhere more convenient and less private. `/tmp` would be more
 * convenient; it is also world-readable, and the token is a credential.
 */
async function berths_print(): Promise<void> {
  const resolver: LocalBerthResolver = new LocalBerthResolver(
    (berth: Berth): Promise<boolean> => berthUrl_isAlive(berth.url),
  );
  // Each berth with the record it was read from: this runtime's, or a porter session's.
  const berths: LocatedBerth[] = await resolver.listLocated();
  if (berths.length === 0) {
    console.error(chalk.yellow('No calypso is running.'));
    console.error(chalk.gray("Start one with:  calypso <user>@<url>"));
    return;
  }
  for (const { berth, path } of berths) {
    // Each berth's token is printed to a terminal and, anywhere else, named by the record it was actually read from.
    const [identity, argus, attach] = berthLines_say(berth.identity, berth.url, berth.token, process.stdout.isTTY === true, path);
    console.log(chalk.bold.cyan(identity));
    console.log(chalk.green(argus));
    console.log(chalk.gray(attach));
  }
}

const currentFile: string = fileURLToPath(import.meta.url);
let isMain: boolean = false;
try {
  isMain = realpathSync(process.argv[1]) === realpathSync(currentFile);
} catch {
  // Not invoked as a script.
}

if (isMain) {
  // Two flags, not a subcommand grammar: this binary hosts a daemon, and the
  // only other things anyone needs from it are where the running ones are
  // and what code it would run (the stack, as `chell --version` prints it).
  if (process.argv.includes('--version') || process.argv.includes('-V')) console.log(versionReport_build());
  else void (process.argv.includes('--berths') ? berths_print() : calypso_start());
}
