/**
 * @file Running a line on a VM through its network's bastion
 * (docs/stratus.adoc, D16): a session opened for the VM's own key, then
 * `ssh` with the bastion as its proxy, one line at a time, its input given
 * on stdin. A new session refuses the key for its first half minute or so,
 * so opening one waits until a first line is admitted.
 *
 * @module
 */
import { spawn } from 'child_process';
import * as path from 'path';
import type { BuildCall, CloudBuilder, ShellSession } from '../cloud/builder.js';
import type { NetStore } from '../net/state.js';
import { vm_read, vmNet_read } from './build.js';
import { VM_USER, type VmStore } from './state.js';

/** What a line on a VM answered. */
export interface RemoteAnswer {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A VM reached: one line at a time. */
export interface VmRemote {
  /** Runs a line in the VM's shell, as its login user, with the given input. */
  run(line: string, input?: string): Promise<RemoteAnswer>;
}

/** How long a session lasts: three hours, the bastion's longest. */
export const SESSION_TTL_SECONDS: number = 10_800;

/**
 * `ssh`'s arguments that reach a VM through a bastion session: the bastion as
 * the proxy, the VM's own key for both hops, the host keys kept in its folder.
 *
 * @param session - The session's id and the bastion's host.
 * @param keyPath - The VM's private key.
 * @param privateIp - The VM's address inside the network.
 * @returns The arguments, the destination last.
 */
export function sshArgs_build(session: ShellSession, keyPath: string, privateIp: string): string[] {
  const known: string = path.join(path.dirname(keyPath), 'known_hosts');
  const common: string[] = ['-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`];
  return [...common, '-o', `ProxyCommand=ssh ${common.join(' ')} -W %h:%p -p 22 ${session.sessionId}@${session.host}`, `${VM_USER}@${privateIp}`];
}

/**
 * A VM reached over `ssh` with the given arguments.
 *
 * @param args - From {@link sshArgs_build}.
 * @param signal - Stops a line running.
 * @returns The remote.
 */
export function sshRemote_make(args: ReadonlyArray<string>, signal: AbortSignal): VmRemote {
  return {
    run: (line: string, input?: string): Promise<RemoteAnswer> => new Promise((resolve): void => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', ...args, line], { stdio: ['pipe', 'pipe', 'pipe'], signal });
      let stdout: string = '';
      let stderr: string = '';
      child.stdout.on('data', (chunk: Buffer): void => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer): void => { stderr += chunk.toString(); });
      child.on('error', (error: Error): void => resolve({ code: 255, stdout, stderr: `${stderr}${error.message}` }));
      child.on('close', (code: number | null): void => resolve({ code: code ?? 255, stdout, stderr }));
      child.stdin.end(input ?? '');
    }),
  };
}

/**
 * How long to wait between tries.
 *
 * @param ms - Milliseconds.
 * @param signal - Stops the wait.
 * @returns When it is over.
 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve): void => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', (): void => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** What opening a VM's remote needs. */
export interface RemoteDeps {
  readonly store: VmStore;
  readonly nets: NetStore;
  readonly builder: CloudBuilder;
  /** Makes the remote from `ssh`'s arguments; {@link sshRemote_make} when absent. */
  readonly remote_make?: (args: ReadonlyArray<string>, signal: AbortSignal) => VmRemote;
  /** Between tries, in milliseconds; 10 s when absent. */
  readonly retryMs?: number;
}

/**
 * Opens a VM: a session on its network's bastion, then a first line tried
 * until it is admitted (three minutes at most).
 *
 * @param name - The VM.
 * @param deps - The VMs, the networks, the cloud.
 * @param call - The step's log and stop.
 * @returns The remote.
 * @throws Error - When the VM is not built, the cloud opens no sessions, or no line is admitted.
 */
export async function vmRemote_open(name: string, deps: RemoteDeps, call: BuildCall): Promise<VmRemote> {
  const { record, spec } = vm_read(deps.store, name);
  const privateIp: string | undefined = record.machineOutputs?.['private_ip'];
  if (record.built === undefined || privateIp === undefined) throw new Error(`${name}: not built (vm build ${name})`);
  const bastionId: string | undefined = vmNet_read(deps.nets, spec).outputs['bastion_id'];
  if (bastionId === undefined) throw new Error(`${name}: the network ${spec.net} has no bastion`);
  const open = deps.builder.shellSession_open?.bind(deps.builder);
  if (open === undefined) throw new Error(`the ${deps.builder.id} cloud opens no shell sessions`);
  const key = deps.store.key_ensure(name);
  const session: ShellSession = await open({ region: record.region, bastionId, privateIp, publicKey: key.publicKey, ttlSeconds: SESSION_TTL_SECONDS, label: name }, call);
  const remote: VmRemote = (deps.remote_make ?? sshRemote_make)(sshArgs_build(session, key.privatePath, privateIp), call.signal);
  const until: number = Date.now() + 3 * 60_000;
  for (;;) {
    const answer: RemoteAnswer = await remote.run('true');
    if (answer.code === 0) break;
    if (Date.now() > until || call.signal.aborted) throw new Error(`${name}: ssh through the bastion was not admitted in three minutes: ${answer.stderr.trim().split('\n').at(-1) ?? ''}`);
    call.log(`ssh not admitted yet (${answer.stderr.trim().split('\n').at(-1) ?? `exit ${answer.code}`}); trying again`);
    await pause(deps.retryMs ?? 10_000, call.signal);
  }
  call.log(`reached ${name} at ${privateIp} through the bastion`);
  return remote;
}
