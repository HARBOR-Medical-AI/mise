/**
 * @file The person's processes in a berth, read from a fake `/proc`: the
 * session's own left out (this process, its parents, its console terminals
 * and the shells they start), everything else listed with the files it holds
 * open under the outgoing folder.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { processesOwn_list } = await import('../src/builtins/berth/berthProcesses.js');

/** This test's user, who owns every fake process. */
const UID: number = process.getuid?.() ?? 0;
/** The session's own process in the fake tree. */
const SELF: number = 10;
const OUTGOING: string = '/outgoing';

let procRoot: string;

/**
 * Puts one process in the fake `/proc`.
 *
 * @param pid - Its id.
 * @param ppid - Its parent's.
 * @param comm - Its command name.
 * @param argv - Its command line; none for a kernel thread.
 * @param env - Its environment.
 * @param fds - Its open descriptors: number to target.
 */
function process_put(pid: number, ppid: number, comm: string, argv: string[], env: string[] = [], fds: Record<string, string> = {}): void {
  const folder: string = join(procRoot, String(pid));
  mkdirSync(join(folder, 'fd'), { recursive: true });
  writeFileSync(join(folder, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0`);
  writeFileSync(join(folder, 'cmdline'), argv.length === 0 ? '' : `${argv.join('\0')}\0`);
  writeFileSync(join(folder, 'environ'), env.length === 0 ? '' : `${env.join('\0')}\0`);
  for (const [fd, target] of Object.entries(fds)) symlinkSync(target, join(folder, 'fd', fd));
}

beforeEach(() => {
  procRoot = mkdtempSync(join(tmpdir(), 'berth-proc-'));
  process_put(1, 0, 'tini', ['tini', '--', 'launch']);
  process_put(5, 1, 'sh', ['sh', '-c', 'calypso']);
  process_put(SELF, 5, 'node', ['node', 'calypso'], ['HOME=/home/alice']);
  process_put(20, SELF, 'node', ['node', 'chell', '--remote', 'alice'], ['CHELL_TERMINAL=abc', 'HOME=/home/alice']);
  process_put(21, 20, 'bash', ['bash', '-i'], ['CHELL_TERMINAL=abc']);
  process_put(22, 21, 'python3', ['python3', 'train.py', '--epochs', '3'], ['CHELL_TERMINAL=abc'], {
    0: '/dev/pts/0', 3: `${OUTGOING}/model.pt`, 4: '/etc/hosts', 5: `${OUTGOING}/logs/run.txt (deleted)`, 6: `${OUTGOING}/model.pt`, 7: '/outgoingness/x',
  });
  process_put(23, 22, 'sh', ['sh', '-c', 'nvidia-smi']);
  process_put(30, 1, 'vim', ['vim', 'notes.md']);
  process_put(40, SELF, 'node', ['node', 'worker.js']);
  process_put(50, 2, 'kworker/0:1', []);
  process_put(60, 1, '(sd pam)', ['(sd-pam)']);
  mkdirSync(join(procRoot, 'self'));
  writeFileSync(join(procRoot, 'uptime'), '1 1');
});

afterEach(() => {
  rmSync(procRoot, { recursive: true, force: true });
});

describe('the person\'s processes in a berth', () => {
  it('leaves out the session: this process, its parents, its console terminals and the shells they start', () => {
    const running = processesOwn_list(OUTGOING, procRoot, SELF, UID);
    expect(running.map((one) => one.pid)).toEqual([22, 23, 30, 40, 60]);
  });

  it('says each command and the files it holds open under the folder, once each', () => {
    const running = processesOwn_list(OUTGOING, procRoot, SELF, UID);
    expect(running[0]).toEqual({ pid: 22, command: 'python3 train.py --epochs 3', open: [`${OUTGOING}/logs/run.txt`, `${OUTGOING}/model.pt`] });
    expect(running.find((one) => one.pid === 30)).toEqual({ pid: 30, command: 'vim notes.md', open: [] });
    expect(running.find((one) => one.pid === 60)?.command).toBe('(sd-pam)');
  });

  it('a shell started by the person\'s own work is theirs, and a child of the session with no terminal mark is theirs', () => {
    const pids: number[] = processesOwn_list(OUTGOING, procRoot, SELF, UID).map((one) => one.pid);
    expect(pids).toContain(23);
    expect(pids).toContain(40);
    expect(pids).not.toContain(21);
  });

  it('lists nothing of another user, and nothing where there is no /proc', () => {
    expect(processesOwn_list(OUTGOING, procRoot, SELF, UID + 1)).toEqual([]);
    expect(processesOwn_list(OUTGOING, join(procRoot, 'missing'), SELF, UID)).toEqual([]);
  });

  it('reads the running system without failing', () => {
    expect(Array.isArray(processesOwn_list(OUTGOING))).toBe(true);
  });
});
