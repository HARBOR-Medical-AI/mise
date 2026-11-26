/**
 * @file Exemplar 05 — CALYPSO daemon exit-gate smoke against a live CUBE.
 *
 * Starts a real `chell --daemon`, attaches over the WebSocket protocol, drives
 * live shell commands through that remote surface, and restarts the daemon
 * against the same isolated config directory.
 *
 * This is intentionally a smoke, not a duplicate of every destructive TS
 * exemplar. The PACS/feed truth is covered by 03/04; this program proves the
 * stage-2 topology: daemon-hosted engine, remote surface, and restart
 * rehydrate. Browser compatibility is covered independently in calypso's
 * ordinary CI suite, without live CUBE credentials.
 *
 *   node exemplars/ts/dist/05_calypsoDaemon.js
 *
 * @module
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import {
  CONTRACT_VERSION,
  serverMessage_parse,
  type ServerMessage,
} from '@fnndsc/calypso';
import type { CommandEnvelope } from '@fnndsc/cumin';
import {
  env_load, config_isolate, check, section, summary_exit, runId_make, sleep, restToken_get,
  CubeEnv,
} from './lib/harness.js';

interface Discovery {
  url: string;
  token: string;
}

interface DaemonHandle {
  process: ChildProcessWithoutNullStreams;
  discovery: Discovery;
}

/** Package root, from `exemplars/ts/dist` at runtime. */
const PACKAGE_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Isolated config directory shared across daemon restart within this exemplar. */
const STABLE_CONFIG_DIR: string = mkdtempSync(path.join(tmpdir(), 'chell-calypso-exitgate-'));
/**
 * Isolated runtime directory: the daemon advertises through identity-keyed
 * berth files under `$XDG_RUNTIME_DIR/calypso`, so giving the child its own
 * runtime directory both isolates this run from any daemon the user is
 * really running and gives the exemplar one place to look.
 */
const RUNTIME_DIR: string = mkdtempSync(path.join(tmpdir(), 'chell-calypso-runtime-'));
/** Where the spawned daemon's berth files land. */
const BERTH_DIR: string = path.join(RUNTIME_DIR, 'calypso');

/**
 * Starts a daemon process and waits for its same-user discovery file.
 *
 * @param env - Live CUBE configuration.
 * @param useSavedSession - When true, start from the saved context instead of
 *   passing credentials again; this is the restart/crash-rehydrate path.
 */
async function daemon_start(env: CubeEnv, useSavedSession: boolean): Promise<DaemonHandle> {
  rmSync(BERTH_DIR, { recursive: true, force: true });
  const args: string[] = ['dist/index.js'];
  // The daemon logs in with a token handed to it on its standard input, never with a password on its command
  // line, which every user of the host can list.
  const token: string | null = useSavedSession ? null : await restToken_get(env.url, env.user, env.password);
  if (token !== null) {
    args.push(`${env.user}@${env.url}`, '--auth-token-stdin');
  }
  args.push('--daemon', '--no-logo', '--no-prefetch-feeds', '--no-prefetch-plugins', '--no-prefetch-jobs');

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, XDG_CONFIG_HOME: STABLE_CONFIG_DIR, XDG_RUNTIME_DIR: RUNTIME_DIR },
  });
  child.stdin.end(token !== null ? `${token}\n` : '');
  const output: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString('utf-8')));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString('utf-8')));

  const discovery: Discovery | null = await wait_forDiscovery(child, output);
  if (!discovery) {
    child.kill('SIGTERM');
    throw new Error(`daemon did not publish discovery\n${daemonOutput_sanitize(output.join(''))}`);
  }
  return { process: child, discovery };
}

/**
 * Waits until the daemon writes a discovery file or exits.
 *
 * @param child - Daemon process.
 * @param output - Captured daemon output, for diagnostics.
 */
async function wait_forDiscovery(
  child: ChildProcessWithoutNullStreams,
  output: string[],
): Promise<Discovery | null> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null;
    const discovery: Discovery | null = discovery_read();
    if (discovery) return discovery;
    await sleep(250);
  }
  if (output.length > 0) return discovery_read();
  return null;
}

/**
 * Reads daemon discovery from the isolated berth directory, validating only
 * the shape needed by this exemplar. The daemon writes one identity-keyed
 * `berth-*.json` there; with the runtime directory isolated, the first valid
 * berth is this run's daemon.
 */
function discovery_read(): Discovery | null {
  if (!existsSync(BERTH_DIR)) return null;
  for (const name of readdirSync(BERTH_DIR)) {
    if (!name.startsWith('berth-') || !name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(BERTH_DIR, name), 'utf-8'));
      if (
        parsed && typeof parsed === 'object' &&
        typeof (parsed as Discovery).url === 'string' &&
        typeof (parsed as Discovery).token === 'string'
      ) {
        return { url: (parsed as Discovery).url, token: (parsed as Discovery).token };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Stops a daemon and waits briefly for process exit.
 *
 * @param handle - Daemon to stop.
 */
async function daemon_stop(handle: DaemonHandle): Promise<void> {
  if (handle.process.exitCode !== null) return;
  handle.process.kill('SIGTERM');
  const deadline: number = Date.now() + 5_000;
  while (Date.now() < deadline && handle.process.exitCode === null) await sleep(100);
  if (handle.process.exitCode === null) handle.process.kill('SIGKILL');
}

/**
 * Minimal raw CALYPSO client used by the live daemon smoke.
 */
class CalypsoClient {
  private readonly ws: WebSocket;
  private readonly pending: Map<string, {
    resolve: (envelopes: CommandEnvelope[]) => void;
    reject: (err: Error) => void;
  }> = new Map();
  private nextId: number = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (payload: Buffer) => this.message_handle(payload));
  }

  /**
   * Attaches to a daemon.
   *
   * @param discovery - URL and attach token from the daemon discovery file.
   */
  public static connect(discovery: Discovery): Promise<CalypsoClient> {
    return new Promise((resolve, reject) => {
      const ws: WebSocket = new WebSocket(discovery.url);
      ws.once('error', reject);
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'attach',
          protocolVersion: CONTRACT_VERSION,
          token: discovery.token,
        }));
      });
      ws.once('message', (payload: Buffer) => {
        const message: ServerMessage | null = serverMessage_fromPayload(payload);
        if (!message) {
          reject(new Error('invalid attach response'));
          ws.close();
          return;
        }
        if (message.type === 'error') {
          reject(new Error(message.reason));
          ws.close();
          return;
        }
        if (message.type !== 'attached') {
          reject(new Error(`unexpected attach response ${message.type}`));
          ws.close();
          return;
        }
        resolve(new CalypsoClient(ws));
      });
    });
  }

  /**
   * Executes one command line through the daemon.
   *
   * @param line - ChELL input line.
   */
  public execute(line: string): Promise<CommandEnvelope[]> {
    const id: string = `e2e-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'execute', id, line }));
    });
  }

  /** Closes the WebSocket. */
  public close(): void {
    this.ws.close();
  }

  /**
   * Routes server messages to pending command promises.
   *
   * @param payload - Raw WebSocket payload.
   */
  private message_handle(payload: Buffer): void {
    const message: ServerMessage | null = serverMessage_fromPayload(payload);
    if (!message) return;
    if (message.type === 'result') {
      this.pending.get(message.id)?.resolve(message.envelopes as CommandEnvelope[]);
      this.pending.delete(message.id);
    }
    if (message.type === 'error' && message.id) {
      this.pending.get(message.id)?.reject(new Error(message.reason));
      this.pending.delete(message.id);
    }
  }
}

/**
 * Parses and validates a daemon message.
 *
 * @param payload - Raw WebSocket payload.
 */
function serverMessage_fromPayload(payload: Buffer): ServerMessage | null {
  try {
    const parsed = serverMessage_parse(JSON.parse(payload.toString('utf-8')));
    return parsed.ok && parsed.value ? parsed.value : null;
  } catch {
    return null;
  }
}

/**
 * Concatenates stdout/stderr renderings from returned command envelopes.
 *
 * @param envelopes - Command result envelopes.
 */
function rendered_join(envelopes: CommandEnvelope[]): string {
  return envelopes.map((e: CommandEnvelope) => `${e.rendered ?? ''}${e.renderedErr ?? ''}`).join('\n');
}

/**
 * Executes a command and asserts its rendered text includes a marker.
 *
 * @param client - Attached daemon client.
 * @param description - Check text.
 * @param line - ChELL command line.
 * @param marker - Expected rendered substring.
 */
async function command_expect(
  client: CalypsoClient,
  description: string,
  line: string,
  marker: string,
): Promise<void> {
  const output: string = rendered_join(await client.execute(line));
  check(description, output.includes(marker));
}

/**
 * Drives a safe live filesystem round-trip through the daemon.
 *
 * @param client - Attached daemon client.
 */
async function filesystemRoundtrip_run(client: CalypsoClient): Promise<void> {
  const runId: string = runId_make();
  const dirname: string = `${runId}-calypso`;
  await client.execute('cd');
  await client.execute(`mkdir ${dirname}`);
  await client.execute(`cd ${dirname}`);
  await client.execute('touch --withContents "hello from the calypso daemon exemplar" hello.txt');
  await command_expect(client, 'daemon filesystem round-trip read back content', 'cat hello.txt', 'hello from the calypso daemon exemplar');
  await client.execute('rm hello.txt');
  await client.execute('cd ..');
  await client.execute(`rm -r ${dirname}`);
}

/**
 * Removes attach tokens from daemon diagnostics.
 *
 * @param output - Raw daemon output.
 */
function daemonOutput_sanitize(output: string): string {
  return output.replace(/token:\s+[0-9a-f]+/gi, 'token: <redacted>');
}

/**
 * Removes this run's isolated berth directory.
 *
 * The runtime directory is exemplar-private, so nothing of the user's needs
 * preserving; cleanup just avoids leaving stale berths behind.
 */
function discovery_cleanup(): void {
  rmSync(BERTH_DIR, { recursive: true, force: true });
}

/**
 * Program entry.
 */
async function main(): Promise<void> {
  const env: CubeEnv = env_load();
  config_isolate();
  // Berths live in the isolated RUNTIME_DIR, so nothing needs preserving.

  let daemon: DaemonHandle | null = null;
  let client: CalypsoClient | null = null;
  try {
    section('daemon surface over live CUBE');
    daemon = await daemon_start(env, false);
    client = await CalypsoClient.connect(daemon.discovery);
    await command_expect(client, 'remote surface reports chell version', 'version', 'chell');
    await command_expect(client, 'remote surface uses the live CUBE identity', 'whoami', env.user);
    await filesystemRoundtrip_run(client);
    await command_expect(client, 'remote surface can inspect process tree', 'ls /proc', 'jobs');

    section('crash/restart rehydrate');
    await client.execute('cd /SERVICES');
    client.close();
    await daemon_stop(daemon);
    daemon = await daemon_start(env, true);
    client = await CalypsoClient.connect(daemon.discovery);
    await command_expect(client, 'working directory survived daemon restart via context files', 'pwd', '/SERVICES');
    await command_expect(client, 'restarted daemon re-derived CUBE identity', 'whoami', env.user);

  } finally {
    client?.close();
    if (daemon) await daemon_stop(daemon);
    discovery_cleanup();
    rmSync(STABLE_CONFIG_DIR, { recursive: true, force: true });
  }

  summary_exit();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  discovery_cleanup();
  rmSync(STABLE_CONFIG_DIR, { recursive: true, force: true });
  process.exit(1);
});
