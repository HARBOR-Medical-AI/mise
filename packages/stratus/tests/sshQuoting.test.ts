/**
 * @file A key folder with a space, a percent and both quotes in its name
 * reaches a VM: the arguments the engine gives `ssh`, and the line it prints
 * for the operator, are read by OpenSSH itself (its option words, its
 * percent expansion, the shell it hands `ProxyCommand` to) and by a real
 * `sh`. Nothing is connected to: the proxy is a stand-in that writes down
 * its arguments and ends.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshArgs_build, sshCommon_build } from '../src/vm/remote.js';
import { sshLine_build } from '../src/commands/vm.js';
import { shWord_quote, shWord_write, sshOption_write, sshProxy_compose } from '../src/vm/quoting.js';

const SESSION = { sessionId: 'ocid1.bastionsession.oc1..abc', host: 'host.bastion.example.invalid' };
const VM_IP: string = '10.0.0.5';

let root: string;
let realSsh: string;
let record: string;
let env: NodeJS.ProcessEnv;

/** The words the stand-in was started with, one per line as it wrote them. */
function recorded_read(): string[] {
  return readFileSync(record, 'utf8').split('\0').slice(0, -1);
}

/** A key in a folder of the given name, with the host keys beside it. */
function key_make(folder: string): { key: string; known: string } {
  const dir: string = join(root, folder, 'ssh');
  mkdirSync(dir, { recursive: true });
  const key: string = join(dir, 'id_ed25519');
  writeFileSync(key, '');
  chmodSync(key, 0o600);
  return { key, known: join(dir, 'known_hosts') };
}

/** What OpenSSH makes of a set of arguments, without connecting (`ssh -G`). */
function config_read(args: ReadonlyArray<string>): Map<string, string> {
  const out: string = execFileSync(realSsh, ['-F', '/dev/null', '-G', ...args], { env, encoding: 'utf8' });
  return new Map(out.split('\n').filter((line: string): boolean => line.includes(' ')).map((line: string): [string, string] => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stratus-ssh-'));
  realSsh = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
  record = join(root, 'recorded');
  const bin: string = join(root, 'bin');
  mkdirSync(bin);
  // The stand-in is the first `ssh` on the path: what a shell starts when a line or a ProxyCommand says `ssh`.
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor word in "$@"; do printf \'%s\\0\' "$word"; done > "$SSH_RECORD"\n');
  chmodSync(join(bin, 'ssh'), 0o755);
  env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: root, SSH_RECORD: record };
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Folder names a key may sit under. */
const FOLDERS: string[] = ['plain', 'two words', '100% sure', "ada's", 'a "quoted" name', 'back\\slash', 'all of it 50% \'x\' "y" $HOME'];

describe('the arguments the engine gives ssh', () => {
  it.each(FOLDERS)('with the key under %j: OpenSSH reads the host-key file and the key as the paths they are', (folder: string) => {
    const { key, known } = key_make(folder);
    const read: Map<string, string> = config_read(sshArgs_build(SESSION, key, VM_IP));
    expect(read.get('userknownhostsfile')).toBe(known);
    // `-G` shows the key before its percents are expanded; the run below shows it after.
    expect(read.get('identityfile')).toBe(key.replace(/%/g, '%%'));
    expect(read.get('hostname')).toBe(VM_IP);
  });

  it.each(FOLDERS)('with the key under %j: the proxy OpenSSH starts is given the same options, the VM\'s address, and the session', (folder: string) => {
    const { key } = key_make(folder);
    rmSync(record, { force: true });
    const ran: SpawnSyncReturns<string> = spawnSync(realSsh, ['-F', '/dev/null', '-v', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...sshArgs_build(SESSION, key, VM_IP), 'true'], { env, encoding: 'utf8', timeout: 20_000 });
    // The stand-in ends at once, so the connection fails; what it was started with is the test.
    expect(ran.status).not.toBe(0);
    expect(recorded_read()).toEqual([...sshCommon_build(key), '-W', `${VM_IP}:22`, '-o', 'Port=22', `${SESSION.sessionId}@${SESSION.host}`]);
    // The key, percents expanded, as OpenSSH went on to look for it.
    // (OpenSSH writes a backslash doubled in its log.)
    expect(ran.stderr).toContain(`identity file ${key.replace(/\\/g, '\\\\')} type`);
    // And those options, read by the inner ssh, name the same two files.
    const inner: Map<string, string> = config_read([...recorded_read().slice(0, sshCommon_build(key).length), 'nowhere.invalid']);
    expect(inner.get('userknownhostsfile')).toBe(join(key, '..', 'known_hosts'));
    expect(inner.get('identityfile')).toBe(key.replace(/%/g, '%%'));
  });
});

describe('the line printed for the operator', () => {
  it.each(FOLDERS)('with the key under %j: a shell starts ssh with exactly the engine\'s arguments', (folder: string) => {
    const { key } = key_make(folder);
    rmSync(record, { force: true });
    const ran: SpawnSyncReturns<string> = spawnSync('sh', ['-c', sshLine_build(SESSION, key, VM_IP)], { env, encoding: 'utf8', timeout: 20_000 });
    expect(ran.status).toBe(0);
    expect(recorded_read()).toEqual(sshArgs_build(SESSION, key, VM_IP));
  });

  it('reads as before for a plain path, the key named by option', () => {
    expect(sshLine_build({ sessionId: 's', host: 'h' }, '/k/ssh/id_ed25519', VM_IP)).toBe(
      "ssh -o IdentityFile=/k/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/k/ssh/known_hosts -o 'ProxyCommand=ssh -o IdentityFile=/k/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/k/ssh/known_hosts -W %h:%p -o Port=22 s@h' ubuntu@10.0.0.5",
    );
  });
});

describe('the words themselves', () => {
  it('a shell word: always quoted for a script, bare when plain for a line a person reads', () => {
    expect(shWord_quote('/k/ssh/id')).toBe("'/k/ssh/id'");
    expect(shWord_quote("it's")).toBe("'it'\\''s'");
    expect(shWord_write('/k/ssh/id')).toBe('/k/ssh/id');
    expect(shWord_write("it's")).toBe("'it'\\''s'");
    expect(shWord_write('')).toBe("''");
    expect(shWord_write('a b')).toBe("'a b'");
  });

  it('an option value is bare when plain; otherwise quoted, its percents doubled, a quote and a backslash escaped', () => {
    expect(sshOption_write('UserKnownHostsFile', '/k/known_hosts')).toBe('UserKnownHostsFile=/k/known_hosts');
    expect(sshOption_write('IdentityFile', '/k 1/50%/"q"\\id')).toBe('IdentityFile="/k 1/50%%/\\"q\\"\\\\id"');
    expect(sshOption_write('IdentityFile', '/k/50%')).toBe('IdentityFile="/k/50%%"');
  });

  it('a path OpenSSH would expand from the environment is refused, since it cannot be written literally', () => {
    expect(() => sshOption_write('IdentityFile', '/k/${HOME}/id')).toThrow('OpenSSH would expand');
  });

  it('a proxy command doubles the percents of its values and leaves the tokens that are meant', () => {
    expect(sshProxy_compose(['ssh', '-o', 'IdentityFile="/k/50%%"'], ['-W', '%h:%p'], ['s@h'])).toBe("ssh -o 'IdentityFile=\"/k/50%%%%\"' -W %h:%p s@h");
  });
});
