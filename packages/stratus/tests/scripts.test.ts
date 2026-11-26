/**
 * @file The library of scripts (docs/stratus.adoc, D17): sources named in
 * the configuration and cloned under the state, `scripts add`, `pull` and
 * `remove`, and the `/scripts` mount: a source's folder read-only, `mine`
 * written to, `.git` never shown, `play` reading through it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { stratusBackend_make } from '../src/backend.js';
import { ClusterStore } from '../src/cluster/state.js';
import { ScriptLibrary, git_run, scriptsRoot_derive } from '../src/scripts/library.js';
import { scripts_run } from '../src/commands/scripts.js';
import { ScriptsProvider } from '../src/vfs/scripts.js';
import { backend_install, HeadlessSurface, manifestText_read, surface_set } from '@fnndsc/brasa/core';

/** Says whose the session's host disk is: its operator's (the files tier), or nobody's. */
function hostDisk_set(operators: boolean): void {
  const surface: HeadlessSurface = new HeadlessSurface();
  Object.assign(surface.capabilities, { engineFilesystem: operators });
  surface_set(surface);
}

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
    // These tests clone from a repository on this host's disk, which is the operator's to name only with the files tier.
    hostDisk_set(true);
  });
  afterEach(() => { surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

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

describe('the library stays inside itself', () => {
  let root: string;
  let library: ScriptLibrary;
  let repo: string;
  /** A file on this host that no script path may reach. */
  let secret: string;

  /** A repository that carries links out of itself: a file link, a folder link, and a folder that is itself a link. */
  function leakyRepo_make(): string {
    const made: string = join(root, 'leaky.git');
    const work: string = join(root, 'leaky-work');
    mkdirSync(join(work, 'real'), { recursive: true });
    writeFileSync(join(work, 'real', 'ok.mise'), 'net new n\n');
    symlinkSync(secret, join(work, 'real', 'leak.mise'));
    symlinkSync(join(root, 'outside'), join(work, 'real', 'out'));
    symlinkSync(join(root, 'outside'), join(work, 'linked'));
    const git = (args: string[], cwd: string): void => {
      const ran = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      if (ran.status !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
    };
    git(['init', '-q', '-b', 'main'], work);
    git(['add', '-A'], work);
    git(['commit', '-q', '-m', 'first'], work);
    git(['clone', '-q', '--bare', work, made], root);
    return made;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-library-'));
    mkdirSync(join(root, 'outside'));
    secret = join(root, 'outside', 'secret.txt');
    writeFileSync(secret, 'not a script: a file elsewhere on this host\n');
    repo = leakyRepo_make();
    library = new ScriptLibrary(join(root, 'config'), join(root, 'state', 'scripts'));
    hostDisk_set(true);
  });
  afterEach(() => { surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('refuses a folder that is no name inside the repository, before anything is cloned', async () => {
    for (const folder of ['../outside', '/etc', 'real/../../outside', 'real/./x']) {
      const refused = await scripts_run({ library }, ['add', 'bad', repo, '--folder', folder]);
      expect(plain(refused.renderedErr)).toContain(`scripts add: --folder ${folder}: a folder inside the repository, and`);
      expect(existsSync(library.clone_derive('bad'))).toBe(false);
    }
    expect(library.sources_list()).toEqual([]);
  });

  it('refuses a folder that is a link out of the clone, and removes the clone', async () => {
    const refused = await scripts_run({ library }, ['add', 'bad', repo, '--folder', 'linked']);
    expect(plain(refused.renderedErr)).toContain('scripts add: --folder linked: it leads out of the repository\'s clone');
    expect(existsSync(library.clone_derive('bad'))).toBe(false);
    expect(library.sources_list()).toEqual([]);
  });

  it('reads a script in the library, and nothing a link in a clone points at outside it', async () => {
    expect((await scripts_run({ library }, ['add', 'leaky', repo, '--folder', 'real'])).renderedErr ?? '').toBe('');
    const mount = new ScriptsProvider(library, (): string => 'rudolph');
    const ok = await mount.readBinary('/scripts/leaky/ok.mise');
    expect(ok.ok && ok.value.toString()).toBe('net new n\n');
    // A file link out of the clone, and a file reached through a folder link out of it: neither is the library's.
    expect(await mount.readBinary('/scripts/leaky/leak.mise')).toMatchObject({ ok: false, errno: 'ENOENT' });
    expect(await mount.readBinary('/scripts/leaky/out/secret.txt')).toMatchObject({ ok: false, errno: 'ENOENT' });
    expect((await mount.list('/scripts/leaky/out')).ok).toBe(false);
    // Nor is their absence proved: the mount does not know, so play would not go looking on the disk for them.
    expect(await mount.absence_prove('/scripts/leaky/leak.mise')).toBe(false);
    expect(await mount.absence_prove('/scripts/leaky/out/secret.txt')).toBe(false);
  });

  it('shows nothing for a source kept from before whose folder or name leads out of the library', async () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'state', 'scripts', 'kept'), { recursive: true });
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [
      { name: 'kept', repo, folder: '../../../outside' },
      { name: 'abs', repo, folder: join(root, 'outside') },
      { name: '../../outside', repo },
    ] }));
    const mount = new ScriptsProvider(library, (): string => 'rudolph');
    for (const at of ['/scripts/kept/secret.txt', '/scripts/abs/secret.txt', '/scripts/../../outside/secret.txt']) {
      expect(await mount.readBinary(at)).toMatchObject({ ok: false });
      expect(await mount.absence_prove(at)).toBe(false);
    }
    expect((await mount.list('/scripts/kept')).ok).toBe(false);
  });

  it('keeps the file system\'s own answer for a script that may not be read', async () => {
    if (process.getuid?.() === 0) return;
    const mine: string = library.mine_derive();
    const closed: string = join(mine, 'closed.mise');
    writeFileSync(closed, 'net new n\n');
    chmodSync(closed, 0o000);
    try {
      const mount = new ScriptsProvider(library, (): string => 'rudolph');
      expect(await mount.readBinary('/scripts/mine/closed.mise')).toEqual({ ok: false, errno: 'EACCES', reason: '/scripts/mine/closed.mise: permission denied on the session\'s host' });
      expect(await mount.absence_prove('/scripts/mine/closed.mise')).toBe(false);
    } finally {
      chmodSync(closed, 0o600);
    }
  });

  it('needs the files tier for a repository on the session\'s own host, to add it and to pull one kept from before; a repository elsewhere needs none', async () => {
    hostDisk_set(false);
    const refused = await scripts_run({ library }, ['add', 'local', repo]);
    expect(plain(refused.renderedErr)).toContain(`scripts add: ${repo} is a repository on the session's host: the session's host disk is nobody's; start the session with --host-control=files`);
    expect(existsSync(library.clone_derive('local'))).toBe(false);
    for (const local of ['./repo', '../repo', '~/repo', 'file:///srv/repo', 'repo-dir']) expect(ScriptLibrary.repo_isLocal(local)).toBe(true);
    for (const remote of ['https://github.com/x/y.git', 'ssh://git@github.com/x/y.git', 'git://host/x.git', 'git@github.com:x/y.git', 'host.example.org:x/y.git']) expect(ScriptLibrary.repo_isLocal(remote)).toBe(false);
    // One added while the tier was on, then pulled with it off.
    hostDisk_set(true);
    expect((await scripts_run({ library }, ['add', 'local', repo, '--folder', 'real'])).renderedErr ?? '').toBe('');
    hostDisk_set(false);
    const pulled = await scripts_run({ library }, ['pull', 'local']);
    expect(plain(pulled.renderedErr ?? pulled.rendered)).toContain(`scripts pull: local is ${repo}, a repository on the session's host: the session's host disk is nobody's`);
    // What the library already holds is still read with the tier off.
    const mount = new ScriptsProvider(library, (): string => 'rudolph');
    expect((await mount.readBinary('/scripts/local/ok.mise')).ok).toBe(true);
  });
});

describe('play over stratus\'s own files, with the files tier on', () => {
  let root: string;
  let library: ScriptLibrary;
  /** Paths the session's host disk was read at by play. */
  let diskReads: string[];
  const disk_read = async (target: string): Promise<string> => { diskReads.push(target); return 'on the disk'; };

  /** Installs a stratus backend over a cloud, connected or not. */
  async function backend_set(driver: FakeDriver): Promise<void> {
    const configDir: string = join(root, 'config');
    const made = stratusBackend_make({ driver, configDir, store: new ClusterStore(join(configDir, 'clusters')), library });
    await made.backend.session.init().catch((): undefined => undefined);
    backend_install(made.backend);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-play-'));
    library = new ScriptLibrary(join(root, 'config'), join(root, 'state', 'scripts'));
    diskReads = [];
    hostDisk_set(true);
  });
  afterEach(() => { surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('a checkout on the host, outside every mount, is read from the disk once', async () => {
    await backend_set(new FakeDriver(fakeCloud_sample()));
    expect(await manifestText_read('/home/someone/src/infra/store.mise', disk_read)).toEqual({ ok: true, value: { text: 'on the disk', from: '/home/someone/src/infra/store.mise' } });
    expect(diskReads).toEqual(['/home/someone/src/infra/store.mise']);
  });

  it('a script the library proves absent is looked for on the disk; one it holds is read from the library', async () => {
    await backend_set(new FakeDriver(fakeCloud_sample()));
    writeFileSync(join(library.mine_derive(), 'here.mise'), 'net new n\n');
    expect(await manifestText_read('/scripts/mine/here.mise', disk_read)).toEqual({ ok: true, value: { text: 'net new n\n', from: '/scripts/mine/here.mise' } });
    expect(diskReads).toEqual([]);
    expect((await manifestText_read('/scripts/mine/gone.mise', disk_read)).ok).toBe(true);
    expect(diskReads).toEqual(['/scripts/mine/gone.mise']);
  });

  it('a script that may not be read is said as that, and the disk is read zero times', async () => {
    if (process.getuid?.() === 0) return;
    await backend_set(new FakeDriver(fakeCloud_sample()));
    const closed: string = join(library.mine_derive(), 'closed.mise');
    writeFileSync(closed, 'net new n\n');
    chmodSync(closed, 0o000);
    try {
      const answer = await manifestText_read('/scripts/mine/closed.mise', disk_read);
      expect(answer).toEqual({ ok: false, reason: "cannot read /scripts/mine/closed.mise — /scripts/mine/closed.mise: permission denied on the session's host; the engine's disk was not looked at, since the session's own files did not say it is absent" });
      expect(diskReads).toEqual([]);
    } finally {
      chmodSync(closed, 0o600);
    }
  });

  it('an ambiguous name in the tenancy is said as ambiguous, and the disk is read zero times', async () => {
    // The sample cloud with a second compartment of the same name: its plain name is two things.
    const cloud = fakeCloud_sample('fnndsc');
    const sandbox = cloud.containers[2]!;
    await backend_set(new FakeDriver({ ...cloud, containers: [...cloud.containers, { ...sandbox, id: 'ocid1.compartment.oc1..twin00', description: 'the other sandbox' }] }));
    const answer = await manifestText_read('/net/oci/fnndsc/sandbox/plan.mise', disk_read);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain('sandbox: ambiguous: sandbox~andbox, sandbox~twin00');
    expect(answer.ok === false && answer.reason).toContain("the engine's disk was not looked at");
    expect(diskReads).toEqual([]);
  });

  it('a tenancy that cannot be reached is said as not connected, and the disk is read zero times', async () => {
    const unreachable = new Proxy(new FakeDriver(fakeCloud_sample()), {
      get: (target: FakeDriver, name: string | symbol): unknown => {
        const own: unknown = Reflect.get(target, name);
        return typeof own === 'function' && name !== 'constructor' && !String(name).startsWith('cloud') ? async (): Promise<never> => { throw new Error('connect ETIMEDOUT'); } : own;
      },
    });
    await backend_set(unreachable);
    const answer = await manifestText_read('/net/oci/fnndsc/clusters/tenant.mise', disk_read);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain('not connected: connect ETIMEDOUT');
    expect(diskReads).toEqual([]);
  });

  it('a name the tenancy does not hold is not found there, and still the disk is not read: its mount proves nothing', async () => {
    await backend_set(new FakeDriver(fakeCloud_sample()));
    expect((await manifestText_read('/net/oci/fnndsc/clusters/nothing.mise', disk_read)).ok).toBe(false);
    expect(diskReads).toEqual([]);
  });
});
