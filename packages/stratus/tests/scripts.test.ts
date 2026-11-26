/**
 * @file The library of scripts (docs/stratus.adoc, D17): sources named in
 * the configuration and cloned under the state, `scripts add`, `pull` and
 * `remove`, and the `/scripts` mount: a source's folder read-only, `mine`
 * written to, `.git` never shown, `play` reading through it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { stratusBackend_make } from '../src/backend.js';
import { ClusterStore } from '../src/cluster/state.js';
import { ScriptLibrary, git_run, scriptsRoot_derive } from '../src/scripts/library.js';
import { scripts_run } from '../src/commands/scripts.js';
import { ScriptsProvider } from '../src/vfs/scripts.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** A bare-ish repository on disk with a folder of scripts, to clone from. */
function repo_make(root: string): string {
  const repo: string = join(root, 'infra.git');
  const work: string = join(root, 'infra-work');
  mkdirSync(join(work, 'chrisproject'), { recursive: true });
  writeFileSync(join(work, 'README.md'), '# infra\n');
  writeFileSync(join(work, 'chrisproject', 'store.mise'), 'net new chrisproject-services --cidr 10.20.0.0/16\nvm new store --net chrisproject-services --vcpu 2 --memory 8 --disk 50 --data 50 --os ubuntu-26.04\n');
  const git = (args: string[], cwd: string): void => {
    const ran = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (ran.status !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
  };
  git(['init', '-q', '-b', 'main'], work);
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'first'], work);
  git(['clone', '-q', '--bare', work, repo], root);
  return repo;
}

describe('the library of scripts', () => {
  let root: string;
  let library: ScriptLibrary;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-scripts-'));
    repo = repo_make(root);
    library = new ScriptLibrary(join(root, 'config'), join(root, 'state', 'scripts'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('proves a script absent only when the file system itself says it is not there', async () => {
    const mount = new ScriptsProvider(library, (): string => 'rudolph');
    const mine: string = library.mine_derive();
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'there.mise'), 'net new n\n');
    expect(await mount.absence_prove('/scripts/mine/gone.mise')).toBe(true);
    expect(await mount.absence_prove('/scripts/mine/deeper/gone.mise')).toBe(true);
    expect(await mount.absence_prove('/scripts/mine/there.mise')).toBe(false);
    // The mount itself, a source the library does not know, and a path that climbs: nothing is proved.
    expect(await mount.absence_prove('/scripts')).toBe(false);
    expect(await mount.absence_prove('/scripts/nosuchsource/x.mise')).toBe(false);
    expect(await mount.absence_prove('/scripts/mine/../x.mise')).toBe(false);
    if (process.getuid?.() !== 0) {
      // A folder that may not be looked into: not knowing is not absence.
      const closed: string = join(mine, 'closed');
      mkdirSync(closed);
      chmodSync(closed, 0o000);
      try {
        expect(await mount.absence_prove('/scripts/mine/closed/x.mise')).toBe(false);
      } finally {
        chmodSync(closed, 0o700);
      }
    }
  });

  it('says where a path stands after a read of it failed: outside for a checkout, absent for a script proved missing, unknown for the tenancy', async () => {
    const configDir: string = join(root, 'config');
    mkdirSync(library.mine_derive(), { recursive: true });
    const made = stratusBackend_make({ driver: new FakeDriver(fakeCloud_sample()), configDir, store: new ClusterStore(join(configDir, 'clusters')), library });
    const files = made.backend.files!;
    // A checkout on this host: no mount serves it, so it is none of the session's files.
    await expect(files.read('/home/someone/src/infra/store.mise')).rejects.toThrow();
    expect(await files.standing!('/home/someone/src/infra/store.mise')).toBe('outside');
    // The library looked at its own folder and the file system said no such file.
    await expect(files.read('/scripts/mine/gone.mise')).rejects.toThrow();
    expect(await files.standing!('/scripts/mine/gone.mise')).toBe('absent');
    await made.backend.session.init();
    // Connected, a name the tenancy does not hold: still its mount's word alone, and still unknown.
    await expect(files.read('/net/oci/fnndsc/clusters/nothing.mise')).rejects.toThrow();
    expect(await files.standing!('/net/oci/fnndsc/clusters/nothing.mise')).toBe('unknown');
    expect(await files.standing!('/net/oci/nosuchtenancy/x.mise')).toBe('unknown');
    // A cloud that cannot be reached: every call of the driver fails. The tenancy's mount reports that as missing
    // ("not connected"), which reads as ENOENT; it is a failure, and the standing stays unknown.
    const unreachable = new Proxy(new FakeDriver(fakeCloud_sample()), {
      get: (target: FakeDriver, name: string | symbol): unknown => {
        const own: unknown = Reflect.get(target, name);
        return typeof own === 'function' && name !== 'constructor' && !String(name).startsWith('cloud') ? async (): Promise<never> => { throw new Error('connect ETIMEDOUT'); } : own;
      },
    });
    const down = stratusBackend_make({ driver: unreachable, configDir: join(root, 'config-down'), store: new ClusterStore(join(root, 'config-down', 'clusters')), library });
    await expect(down.backend.files!.read('/net/oci/fnndsc/clusters/tenant.mise')).rejects.toThrow();
    expect(await down.backend.files!.standing!('/net/oci/fnndsc/clusters/tenant.mise')).toBe('unknown');
    // And with the cloud down a checkout path is still simply not the session's.
    expect(await down.backend.files!.standing!('/home/someone/src/infra/store.mise')).toBe('outside');
  });

  it('derives its root under the state directory', () => {
    expect(scriptsRoot_derive({ XDG_STATE_HOME: '/s' })).toBe('/s/stratus/scripts');
    expect(git_run(['--version']).ok).toBe(true);
  });

  it('adds a source by cloning it, lists it with its head, pulls it, and forgets it with its clone', async () => {
    const context = { library };
    expect(plain((await scripts_run(context, [])).rendered)).toContain('no sources');
    expect((await scripts_run(context, ['add', 'Bad', repo])).renderedErr).toContain('a source\'s name is lower-case');
    expect((await scripts_run(context, ['add', 'infra', repo, '--folder', 'nowhere'])).renderedErr).toContain('has no folder nowhere');
    expect(existsSync(library.clone_derive('infra'))).toBe(false);
    const added = await scripts_run(context, ['add', 'chrisproject', repo, '--folder', 'chrisproject']);
    expect(added.renderedErr ?? '').toBe('');
    expect(plain(added.rendered)).toContain('chrisproject: ' + repo + ' (chrisproject) cloned to ');
    expect(plain(added.rendered)).toContain('its scripts are at /scripts/chrisproject/');
    expect(JSON.parse(readFileSync(library.sourcesFile, 'utf-8'))).toEqual({ sources: [{ name: 'chrisproject', repo, folder: 'chrisproject' }] });
    expect((await scripts_run(context, ['add', 'chrisproject', repo])).renderedErr).toContain('already a source');
    expect(plain((await scripts_run(context, [])).rendered)).toMatch(/^chrisproject  \S+infra\.git  chrisproject  [0-9a-f]{7} \d{4}-\d\d-\d\d first\nmine  this host's own scripts\n$/);
    expect(plain((await scripts_run(context, ['pull'])).rendered)).toMatch(/^chrisproject: at [0-9a-f]{7} /);
    rmSync(library.clone_derive('chrisproject'), { recursive: true, force: true });
    expect(plain((await scripts_run(context, ['pull', 'chrisproject'])).rendered)).toBe('chrisproject: cloned again\n');
    expect((await scripts_run(context, ['pull', 'other'])).renderedErr).toContain('other: not a source');
    expect(plain((await scripts_run(context, ['remove', 'chrisproject'])).rendered)).toBe('chrisproject: forgotten; its clone removed\n');
    expect(existsSync(library.clone_derive('chrisproject'))).toBe(false);
    expect((await scripts_run(context, ['remove', 'chrisproject'])).renderedErr).toContain('not a source');
    expect((await scripts_run(context, ['fetch'])).renderedErr).toContain("scripts: unknown subcommand 'fetch' (add, pull, remove)");
  });

  it('is mounted at /scripts: a source read-only without its .git, mine written to, and play reading through it', async () => {
    const configDir: string = join(root, 'config');
    library.source_add({ name: 'chrisproject', repo, folder: 'chrisproject' });
    library.source_add({ name: 'whole', repo });
    const made = stratusBackend_make({ driver: new FakeDriver(fakeCloud_sample()), configDir, store: new ClusterStore(join(configDir, 'clusters')), library });
    const vfs = made.backend.vfs!.dispatcher;
    expect(made.backend.vfs?.structural).toContain('/scripts');
    const rootList = await vfs.list('/');
    expect(rootList.ok && rootList.value.map((item) => item.name)).toEqual(expect.arrayContaining(['net', 'scripts']));
    const top = await vfs.list('/scripts');
    expect(top.ok && top.value.map((item) => `${item.name} ${item.type} ${item.status ?? ''}`.trim())).toEqual([expect.stringMatching(/^chrisproject source cloned · at [0-9a-f]{7} \d{4}-\d\d-\d\d first$/), expect.stringMatching(/^whole source cloned · at [0-9a-f]{7} \d{4}-\d\d-\d\d first$/), 'mine dir']);
    const folder = await vfs.list('/scripts/chrisproject');
    expect(folder.ok && folder.value.map((item) => `${item.name} ${item.type}`)).toEqual(['store.mise script']);
    const whole = await vfs.list('/scripts/whole');
    expect(whole.ok && whole.value.map((item) => item.name)).toEqual(['chrisproject', 'README.md']);
    expect((await vfs.list('/scripts/whole/.git')).ok).toBe(false);
    expect((await vfs.list('/scripts/nowhere')).ok).toBe(false);
    const text = await vfs.read('/scripts/chrisproject/store.mise');
    expect(text.ok && text.value.startsWith('net new chrisproject-services')).toBe(true);
    expect((await vfs.readBinary('/scripts/whole/.git/HEAD')).ok).toBe(false);
    expect((await vfs.write('/scripts/chrisproject/store.mise', 'x')).ok).toBe(false);
    await expect(made.backend.files!.write('/scripts/chrisproject/store.mise', Buffer.from('x'))).rejects.toThrow('the way back into it is git');
    await made.backend.files!.write('/scripts/mine/try.mise', Buffer.from('vm cost store --memory 16\n'));
    expect(readFileSync(join(library.mine_derive(), 'try.mise'), 'utf-8')).toBe('vm cost store --memory 16\n');
    const mine = await vfs.list('/scripts/mine');
    expect(mine.ok && mine.value.map((item) => `${item.name} ${item.type}`)).toEqual(['try.mise script']);
    expect((await made.backend.files!.read('/scripts/chrisproject/store.mise')).toString('utf-8')).toContain('vm new store');
    await expect(made.backend.files!.read('/scripts/chrisproject/none.mise')).rejects.toThrow();
  });
});
