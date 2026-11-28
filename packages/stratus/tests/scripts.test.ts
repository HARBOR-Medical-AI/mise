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
import { ScriptLibrary, git_run, gitConfig_read, gitProtocols_configured, networkOnly_keys, networkProtocols_allow, scriptsRoot_derive } from '../src/scripts/library.js';
import { scripts_run } from '../src/commands/scripts.js';
import { ScriptsProvider } from '../src/vfs/scripts.js';
import { backend_install, HeadlessSurface, manifestText_read, surface_set } from '@fnndsc/brasa/core';

/** Says whose the session's host disk is (the files tier), and whether it may run git there (the shell tier: by default, as the disk). */
function hostDisk_set(operators: boolean, programs: boolean = true): void {
  const surface: HeadlessSurface = new HeadlessSurface();
  Object.assign(surface.capabilities, { engineFilesystem: operators, engineProcesses: programs });
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

  it('without the shell tier (host control off, or files alone) runs no git: scripts already there are listed and read, add and pull refuse with zero calls', async () => {
    library.source_add({ name: 'chrisproject', repo, folder: 'chrisproject' });
    const calls: string[][] = [];
    const recording = new ScriptLibrary(join(root, 'config'), join(root, 'state', 'scripts'), (args: ReadonlyArray<string>) => { calls.push([...args]); return { ok: true, text: '' }; });
    for (const files of [false, true]) {
      hostDisk_set(files, false);
      calls.length = 0;
      expect(recording.sources_list().map((source) => source.name)).toEqual(['chrisproject']);
      expect(recording.head_read('chrisproject')).toBe('its head is read with the shell tier');
      const made = stratusBackend_make({ driver: new FakeDriver(fakeCloud_sample()), configDir: join(root, 'config'), store: new ClusterStore(join(root, 'config', 'clusters')), library: recording });
      const vfs = made.backend.vfs!.dispatcher;
      const top = await vfs.list('/scripts');
      expect(top.ok && top.value.map((item) => `${item.name} ${item.status ?? ''}`.trim())).toEqual(['chrisproject cloned · at its head is read with the shell tier', 'mine']);
      const text = await vfs.read('/scripts/chrisproject/store.mise');
      expect(text.ok).toBe(true);
      expect(recording.source_add({ name: 'other', repo: 'https://example.org/other.git' })).toEqual({ ok: false, text: 'scripts add (git): this session may not start programs on its host; start the session with --host-control=shell' });
      expect(recording.source_pull('chrisproject')).toEqual({ ok: false, text: 'scripts pull chrisproject (git): this session may not start programs on its host; start the session with --host-control=shell' });
      expect(calls).toEqual([]);
    }
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

  it('a source kept under a name that is no source\'s name is no source: not listed, not pulled, not removed, and no path is made from it', async () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [
      { name: '../../outside', repo },
      { name: '/etc', repo },
      { name: 'mine', repo },
      { name: 'Bad Name', repo },
      { repo },
    ] }));
    expect(library.sources_list()).toEqual([]);
    const listed = await new ScriptsProvider(library, (): string => 'rudolph').list('/scripts');
    expect(listed.ok && listed.value.map((item) => item.name)).toEqual(['mine']);
    for (const name of ['../../outside', '/etc', 'Bad Name']) {
      expect(plain((await scripts_run({ library }, ['remove', name])).renderedErr)).toContain('not a source');
      expect(plain((await scripts_run({ library }, ['pull', name])).renderedErr ?? '')).toContain('not a source');
    }
    // The folder those names pointed at stands untouched.
    expect(readFileSync(secret, 'utf8')).toBe('not a script: a file elsewhere on this host\n');
    expect(existsSync(join(root, 'outside'))).toBe(true);
  });

  it('a failed add leaves a clone that stood there before it', async () => {
    const standing: string = library.clone_derive('kept');
    mkdirSync(join(standing, '.git'), { recursive: true });
    writeFileSync(join(standing, 'theirs.mise'), 'net new n\n');
    const refused = await scripts_run({ library }, ['add', 'kept', repo, '--folder', 'nosuchfolder']);
    expect(plain(refused.renderedErr)).toContain('has no folder nosuchfolder');
    expect(readFileSync(join(standing, 'theirs.mise'), 'utf8')).toBe('net new n\n');
    expect(library.sources_list()).toEqual([]);
  });

  it('with the tier off, git itself refuses a clone or a pull from this host, whatever the library\'s file says the source is', async () => {
    // Added while the tier was on; its clone's own upstream is the repository on this host.
    expect((await scripts_run({ library }, ['add', 'local', repo, '--folder', 'real'])).renderedErr ?? '').toBe('');
    // The file now says it is a repository elsewhere: the check of the file passes, and git is asked.
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [{ name: 'local', repo: 'https://git.example.invalid/x/y.git', folder: 'real' }] }));
    hostDisk_set(false);
    const pulled = await scripts_run({ library }, ['pull', 'local']);
    expect(plain(pulled.renderedErr ?? pulled.rendered)).toMatch(/local: git pull: .*(not allowed|transport)/);
    // And a clone by a spelling the check of the file does not know as local is refused by git the same way.
    expect(git_run(['clone', '--quiet', `file://${repo}`, join(root, 'state', 'scripts', 'direct')], undefined, true)).toMatchObject({ ok: false });
    expect(existsSync(join(root, 'state', 'scripts', 'direct', '.git'))).toBe(false);
    // With the tier on the same pull goes through.
    hostDisk_set(true);
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [{ name: 'local', repo, folder: 'real' }] }));
    expect(plain((await scripts_run({ library }, ['pull', 'local'])).rendered)).toMatch(/^local: at [0-9a-f]{7} /);
  });

  it('lists a link in a clone as itself: its size and date are the link\'s, not those of what it points at', async () => {
    expect((await scripts_run({ library }, ['add', 'leaky', repo, '--folder', 'real'])).renderedErr ?? '').toBe('');
    writeFileSync(secret, 'x'.repeat(5000));
    const listed = await new ScriptsProvider(library, (): string => 'rudolph').list('/scripts/leaky');
    const leak = listed.ok ? listed.value.find((item) => item.name === 'leak.mise') : undefined;
    expect(leak).toBeDefined();
    expect(leak!.size).toBeLessThan(5000);
    expect(leak!.size).toBe(secret.length);
  });

  it('says permission denied, not no such file, for a script under a folder that may not be looked into', async () => {
    if (process.getuid?.() === 0) return;
    const closed: string = join(library.mine_derive(), 'closed');
    mkdirSync(closed);
    writeFileSync(join(closed, 'x.mise'), 'net new n\n');
    chmodSync(closed, 0o000);
    try {
      const mount = new ScriptsProvider(library, (): string => 'rudolph');
      const read = await mount.readBinary('/scripts/mine/closed/x.mise');
      expect(read).toMatchObject({ ok: false, errno: 'EACCES' });
      expect(read.ok === false && read.reason).toContain("/scripts/mine/closed/x.mise: permission denied on the session's host");
      expect(await mount.absence_prove('/scripts/mine/closed/x.mise')).toBe(false);
    } finally {
      chmodSync(closed, 0o700);
    }
  });

  it('with the tier off, a clone folder or this host\'s own folder that is a link out of the library is not the library\'s: nothing is read through it and git is not run in it', async () => {
    const scripts: string = join(root, 'state', 'scripts');
    mkdirSync(scripts, { recursive: true });
    // What stands at a source's clone name, and at `mine`, each lead outside the library's root.
    symlinkSync(join(root, 'outside'), join(scripts, 'linked'));
    symlinkSync(join(root, 'outside'), join(scripts, 'mine'));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [{ name: 'linked', repo: 'https://git.example.invalid/x/y.git' }] }));
    hostDisk_set(false);
    const ran: string[][] = [];
    const watched = new ScriptLibrary(join(root, 'config'), scripts, (args: ReadonlyArray<string>, cwd?: string) => { ran.push([...args, cwd ?? '']); return { ok: true, text: '' }; });
    const mount = new ScriptsProvider(watched, (): string => 'rudolph');
    for (const at of ['/scripts/linked/secret.txt', '/scripts/mine/secret.txt']) {
      expect(await mount.readBinary(at)).toMatchObject({ ok: false, errno: 'ENOENT' });
      expect(await mount.absence_prove(at)).toBe(false);
    }
    expect((await mount.list('/scripts/linked')).ok).toBe(false);
    expect(await mount.write('/scripts/mine/new.mise', 'x')).toMatchObject({ ok: false });
    expect(existsSync(join(root, 'outside', 'new.mise'))).toBe(false);
    // Pulling it, and adding a source over a standing link of that name: git is never run.
    expect(plain((await scripts_run({ library: watched }, ['pull', 'linked'])).renderedErr ?? '')).toContain('linked: its clone is not inside the library');
    writeFileSync(watched.sourcesFile, JSON.stringify({ sources: [] }));
    expect(plain((await scripts_run({ library: watched }, ['add', 'linked', 'https://git.example.invalid/x/y.git'])).renderedErr)).toContain('linked: its clone would not be inside the library');
    expect(ran).toEqual([]);
    // Removing a source whose clone name is such a link forgets it and leaves what the link points at.
    writeFileSync(watched.sourcesFile, JSON.stringify({ sources: [{ name: 'linked', repo: 'https://git.example.invalid/x/y.git' }] }));
    expect(plain((await scripts_run({ library: watched }, ['remove', 'linked'])).rendered)).toContain('was left');
    expect(readFileSync(secret, 'utf8')).toBe('not a script: a file elsewhere on this host\n');
  });

  it('tells a configured folder that may not be entered from one whose parent is a file, and both from one that is not there', async () => {
    if (process.getuid?.() === 0) return;
    expect((await scripts_run({ library }, ['add', 'leaky', repo])).renderedErr ?? '').toBe('');
    const clone: string = library.clone_derive('leaky');
    mkdirSync(join(clone, 'shut', 'inner'), { recursive: true });
    writeFileSync(join(clone, 'shut', 'inner', 'x.mise'), 'net new n\n');
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [
      { name: 'leaky', repo, folder: 'shut/inner' },
    ] }));
    const mount = new ScriptsProvider(library, (): string => 'rudolph');
    chmodSync(join(clone, 'shut'), 0o000);
    try {
      const denied = await mount.readBinary('/scripts/leaky/x.mise');
      expect(denied).toMatchObject({ ok: false, errno: 'EACCES' });
      expect(denied.ok === false && denied.reason).toBe("/scripts/leaky/x.mise: permission denied on the session's host");
      expect(await mount.absence_prove('/scripts/leaky/x.mise')).toBe(false);
    } finally {
      chmodSync(join(clone, 'shut'), 0o700);
    }
    // A file where a folder of the configured path was wanted: not a directory, and not permission denied.
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [{ name: 'leaky', repo, folder: 'real/ok.mise/inner' }] }));
    const notdir = await mount.readBinary('/scripts/leaky/x.mise');
    expect(notdir).toMatchObject({ ok: false, errno: 'ENOTDIR' });
    expect(notdir.ok === false && notdir.reason).toBe('/scripts/leaky/x.mise: a part of the path is a file, not a folder');
    expect(await mount.absence_prove('/scripts/leaky/x.mise')).toBe(false);
    // And a configured folder that is simply not there.
    writeFileSync(library.sourcesFile, JSON.stringify({ sources: [{ name: 'leaky', repo, folder: 'nowhere' }] }));
    expect(await mount.readBinary('/scripts/leaky/x.mise')).toMatchObject({ ok: false, errno: 'ENOENT' });
    expect(await mount.absence_prove('/scripts/leaky/x.mise')).toBe(true);
  });

  it('shortens a policy the operator set in the environment, never widening it', () => {
    // An HTTPS-only host stays HTTPS-only: SSH is not switched on for it.
    expect(networkProtocols_allow('https')).toBe('https');
    expect(networkProtocols_allow('file:https:git')).toBe('https:git');
    // A policy of local transports alone leaves nothing a nobody's-disk session may use.
    expect(networkProtocols_allow('file:ext')).toBe('');
    expect(networkProtocols_allow('')).toBe('');
    const saved: string | undefined = process.env['GIT_ALLOW_PROTOCOL'];
    try {
      process.env['GIT_ALLOW_PROTOCOL'] = 'https';
      // git:// would be a network transport, and this host's policy does not allow it.
      const refused = git_run(['ls-remote', 'git://git.example.invalid/x.git'], undefined, true);
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/not allowed/);
      // And a list that held `file` loses it.
      process.env['GIT_ALLOW_PROTOCOL'] = 'file:https';
      expect(git_run(['ls-remote', `file://${repo}`], undefined, true).text).toMatch(/not allowed/);
      expect(git_run(['ls-remote', `file://${repo}`]).ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['GIT_ALLOW_PROTOCOL']; else process.env['GIT_ALLOW_PROTOCOL'] = saved;
    }
  });

  it('an add over a clone name that is a link out of the library looks at nothing under it, whatever folder is named', async () => {
    const scripts: string = join(root, 'state', 'scripts');
    mkdirSync(scripts, { recursive: true });
    // The link's target holds a folder of the very name asked for: were it looked at, the add would go on.
    mkdirSync(join(root, 'outside', 'there'));
    symlinkSync(join(root, 'outside'), join(scripts, 'linked'));
    const ran: string[][] = [];
    const watched = new ScriptLibrary(join(root, 'config'), scripts, (args: ReadonlyArray<string>): { ok: boolean; text: string } => { ran.push([...args]); return { ok: true, text: '' }; });
    for (const folder of ['there', 'missing', '../x']) {
      const refused = await scripts_run({ library: watched }, ['add', 'linked', 'https://git.example.invalid/x/y.git', '--folder', folder]);
      expect(plain(refused.renderedErr)).toContain('linked: its clone would not be inside the library');
    }
    expect(ran).toEqual([]);
  });

  it('builds git\'s keys from the operator\'s policy, and refuses to run git on a policy it could not read', () => {
    const none = (): null => null;
    expect(networkOnly_keys(none)).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.http.allow=always',
      '-c', 'protocol.ftp.allow=user', '-c', 'protocol.ftps.allow=user']);
    // A transport the operator configured has no key given for it: theirs stands. Their general policy fills the rest.
    const set: Record<string, string> = { 'protocol.allow': 'user', 'protocol.ssh.allow': 'never' };
    expect(networkOnly_keys((key: string): string | null => set[key] ?? null)).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.https.allow=user', '-c', 'protocol.git.allow=user', '-c', 'protocol.http.allow=user', '-c', 'protocol.ftp.allow=user', '-c', 'protocol.ftps.allow=user']);
    // A transport of this host that the configuration names, to whatever policy, is given never by name; a network one it names is left alone.
    expect(networkOnly_keys(none, (): string[] => ['leak', 'file', 'ssh', 'sftp-helper'])).toEqual(['-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'protocol.leak.allow=never', '-c', 'protocol.sftp-helper.allow=never',
      '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.http.allow=always',
      '-c', 'protocol.ftp.allow=user', '-c', 'protocol.ftps.allow=user']);
    // A name is kept in the case git holds it in, and a name that an object would answer to by inheritance is no network transport.
    expect(networkOnly_keys(none, (): string[] => ['Leak', 'HTTPS', 'constructor', 'toString', 'hasOwnProperty'])).toEqual(['-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.Leak.allow=never', '-c', 'protocol.HTTPS.allow=never', '-c', 'protocol.constructor.allow=never', '-c', 'protocol.toString.allow=never', '-c', 'protocol.hasOwnProperty.allow=never',
      '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.http.allow=always',
      '-c', 'protocol.ftp.allow=user', '-c', 'protocol.ftps.allow=user']);
    expect(networkOnly_keys(none, () => ({ unread: 'protocol.*.allow: bad config' }))).toEqual({ refused: "git's transport policy could not be read (protocol.*.allow: bad config); nothing was fetched" });
    expect(networkOnly_keys(none, (): string[] => ['a b'])).toMatchObject({ refused: expect.stringContaining('a name that is not one') });
    // A read that failed, and a value that is no policy, are neither of them taken for "not set".
    expect(networkOnly_keys((key: string) => (key === 'protocol.ssh.allow' ? { unread: 'protocol.ssh.allow: bad config line 3' } : null))).toEqual({ refused: "git's transport policy could not be read (protocol.ssh.allow: bad config line 3); nothing was fetched" });
    expect(networkOnly_keys((key: string) => (key === 'protocol.allow' ? 'sometimes' : null))).toEqual({ refused: 'git\'s transport policy could not be read (protocol.allow is "sometimes"); nothing was fetched' });
    // And through git itself: a configuration file that cannot be parsed stops the fetch before git is asked for anything.
    const config: string = join(root, 'broken-gitconfig');
    writeFileSync(config, '[protocol\n\tallow = ');
    const saved = [process.env['GIT_CONFIG_GLOBAL'], process.env['GIT_ALLOW_PROTOCOL']];
    try {
      process.env['GIT_CONFIG_GLOBAL'] = config;
      delete process.env['GIT_ALLOW_PROTOCOL'];
      expect(gitConfig_read('protocol.allow')).toMatchObject({ unread: expect.stringContaining('protocol.allow') });
      expect(git_run(['ls-remote', 'https://git.example.invalid/x.git'], undefined, true)).toMatchObject({ ok: false, text: expect.stringContaining("git's transport policy could not be read") });
    } finally {
      if (saved[0] === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = saved[0];
      if (saved[1] === undefined) delete process.env['GIT_ALLOW_PROTOCOL']; else process.env['GIT_ALLOW_PROTOCOL'] = saved[1];
    }
  });

  it('refuses a remote helper installed on this host, by whatever name, before the helper is run', () => {
    // A helper git would run for `leak://…`: a program on this host that says it ran by leaving a file.
    const bin: string = join(root, 'bin');
    const ranMark: string = join(root, 'helper-ran');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git-remote-leak'), `#!/bin/sh\ntouch '${ranMark}'\nexit 1\n`, { mode: 0o755 });
    const names = ['PATH', 'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const saved = names.map((name) => process.env[name]);
    try {
      process.env['PATH'] = `${bin}:${process.env['PATH'] ?? ''}`;
      process.env['GIT_CONFIG_GLOBAL'] = join(root, 'empty-gitconfig');
      writeFileSync(join(root, 'empty-gitconfig'), '');
      process.env['GIT_CONFIG_NOSYSTEM'] = '1';
      delete process.env['GIT_ALLOW_PROTOCOL'];
      delete process.env['GIT_PROTOCOL_FROM_USER'];
      // Without the restriction git runs it: the helper is real, and this is what is being kept out.
      git_run(['ls-remote', 'leak://anything']);
      expect(existsSync(ranMark)).toBe(true);
      rmSync(ranMark);
      // With it, and no list in the environment, git refuses the transport and the helper is never started.
      const refused = git_run(['ls-remote', 'leak://anything'], undefined, true);
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/not allowed/);
      expect(existsSync(ranMark)).toBe(false);
      // The same under a list in the environment, which names it and loses it.
      process.env['GIT_ALLOW_PROTOCOL'] = 'leak:https';
      expect(git_run(['ls-remote', 'leak://anything'], undefined, true).text).toMatch(/not allowed/);
      expect(existsSync(ranMark)).toBe(false);
      // The operator's own configuration allowing it outright changes nothing: it is denied by name.
      delete process.env['GIT_ALLOW_PROTOCOL'];
      writeFileSync(join(root, 'empty-gitconfig'), '[protocol "leak"]\n\tallow = always\n[protocol "file"]\n\tallow = always\n[protocol "ext"]\n\tallow = always\n');
      expect(gitProtocols_configured()).toEqual(['leak', 'file', 'ext']);
      expect(git_run(['ls-remote', 'leak://anything'], undefined, true).text).toMatch(/not allowed/);
      expect(existsSync(ranMark)).toBe(false);
      // A helper named in mixed case, and one named as something every object answers to, each allowed outright: refused, never started.
      for (const name of ['Leak', 'constructor']) {
        writeFileSync(join(bin, `git-remote-${name}`), `#!/bin/sh\ntouch '${ranMark}'\nexit 1\n`, { mode: 0o755 });
        writeFileSync(join(root, 'empty-gitconfig'), `[protocol "${name}"]\n\tallow = always\n`);
        expect(gitProtocols_configured()).toEqual([name]);
        git_run(['ls-remote', `${name}://anything`]);
        expect(existsSync(ranMark)).toBe(true);
        rmSync(ranMark);
        expect(git_run(['ls-remote', `${name}://anything`], undefined, true).text).toMatch(/not allowed/);
        expect(existsSync(ranMark)).toBe(false);
      }
      writeFileSync(join(root, 'empty-gitconfig'), '');
      // Nor does a repository's own configuration allowing it, for a pull through its configured upstream.
      const work: string = join(root, 'helper-clone');
      mkdirSync(work);
      expect(git_run(['init', '-q'], work).ok).toBe(true);
      expect(git_run(['remote', 'add', 'origin', 'leak://anything'], work).ok).toBe(true);
      expect(git_run(['config', 'protocol.leak.allow', 'always'], work).ok).toBe(true);
      expect(git_run(['config', 'protocol.other.allow', 'always'], work).ok).toBe(true);
      expect(gitProtocols_configured(work)).toEqual(expect.arrayContaining(['leak', 'other']));
      expect(git_run(['pull', '--quiet', '--ff-only', 'origin', 'main'], work, true).text).toMatch(/not allowed/);
      expect(existsSync(ranMark)).toBe(false);
    } finally {
      names.forEach((name, at) => { const value = saved[at]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    }
  });

  it('with no policy in the environment, leaves git\'s own configuration exactly as the operator set it, and turns off only this host\'s transports', () => {
    const config: string = join(root, 'gitconfig');
    // ssh is never; git is user, which git allows a person at a terminal and refuses when told the request is not theirs.
    writeFileSync(config, '[protocol "ssh"]\n\tallow = never\n[protocol "git"]\n\tallow = user\n');
    const names = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER'] as const;
    const saved = names.map((name) => process.env[name]);
    /** Whether git refused by its transport policy, as against failing to reach a host that is not there. */
    const byPolicy = (url: string): boolean => /not allowed/.test(git_run(['ls-remote', url], undefined, true).text);
    try {
      process.env['GIT_CONFIG_GLOBAL'] = config;
      process.env['GIT_CONFIG_NOSYSTEM'] = '1';
      delete process.env['GIT_ALLOW_PROTOCOL'];
      delete process.env['GIT_PROTOCOL_FROM_USER'];
      // never stays never.
      expect(byPolicy('ssh://git@git.example.invalid/x.git')).toBe(true);
      // user, with nothing said about who is asking: allowed by policy (the host is not there, which is another failure).
      expect(byPolicy('git://git.example.invalid/x.git')).toBe(false);
      // user, with git told the request is not the user's own: refused by policy. The library does not turn that into always.
      process.env['GIT_PROTOCOL_FROM_USER'] = '0';
      expect(byPolicy('git://git.example.invalid/x.git')).toBe(true);
      // ftp is unconfigured and so user by git's default: the same both ways.
      expect(byPolicy('ftp://git.example.invalid/x.git')).toBe(true);
      process.env['GIT_PROTOCOL_FROM_USER'] = '1';
      expect(byPolicy('ftp://git.example.invalid/x.git')).toBe(false);
      // https is unconfigured and always by git's default.
      expect(byPolicy('https://git.example.invalid/x.git')).toBe(false);
      // This host's own transports are off whatever the rest says, and on without the restriction.
      expect(byPolicy(`file://${repo}`)).toBe(true);
      expect(byPolicy(repo)).toBe(true);
      expect(git_run(['ls-remote', repo]).ok).toBe(true);
      // The operator's general policy is what an unconfigured network transport gets, not git's built-in one.
      writeFileSync(config, '[protocol]\n\tallow = user\n[protocol "ssh"]\n\tallow = always\n');
      process.env['GIT_PROTOCOL_FROM_USER'] = '0';
      expect(byPolicy('https://git.example.invalid/x.git')).toBe(true);
      expect(byPolicy('ssh://git@git.example.invalid/x.git')).toBe(false);
      expect(byPolicy(`file://${repo}`)).toBe(true);
      process.env['GIT_PROTOCOL_FROM_USER'] = '1';
      expect(byPolicy('https://git.example.invalid/x.git')).toBe(false);
      // Even told the request is the user's own, this host's transports stay off.
      expect(byPolicy(`file://${repo}`)).toBe(true);
      // A configuration that allows file outright is overridden for file, and for file alone: ssh stays never.
      writeFileSync(config, '[protocol "file"]\n\tallow = always\n[protocol "ssh"]\n\tallow = never\n');
      expect(byPolicy(`file://${repo}`)).toBe(true);
      expect(byPolicy(repo)).toBe(true);
      expect(byPolicy('ssh://git@git.example.invalid/x.git')).toBe(true);
      expect(byPolicy('https://git.example.invalid/x.git')).toBe(false);
    } finally {
      names.forEach((name, at) => { const value = saved[at]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    }
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

  it('a script under a folder that may not be looked into is said as permission denied, and the disk is read zero times', async () => {
    if (process.getuid?.() === 0) return;
    await backend_set(new FakeDriver(fakeCloud_sample()));
    const closed: string = join(library.mine_derive(), 'closed');
    mkdirSync(closed);
    writeFileSync(join(closed, 'x.mise'), 'net new n\n');
    chmodSync(closed, 0o000);
    try {
      const answer = await manifestText_read('/scripts/mine/closed/x.mise', disk_read);
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.reason).toContain("/scripts/mine/closed/x.mise: permission denied on the session's host");
      expect(answer.ok === false && answer.reason).toContain("the engine's disk was not looked at");
      expect(diskReads).toEqual([]);
    } finally {
      chmodSync(closed, 0o700);
    }
  });

  it('this host\'s own folder that could not be made is said as that, and the disk is read zero times', async () => {
    if (process.getuid?.() === 0) return;
    await backend_set(new FakeDriver(fakeCloud_sample()));
    // The library's root can be read and not written, and `mine` is not there yet.
    const scripts: string = join(root, 'state', 'scripts');
    mkdirSync(scripts, { recursive: true });
    chmodSync(scripts, 0o555);
    try {
      expect(library.mine_place()).toMatchObject({ ok: false, unseen: 'EACCES' });
      const answer = await manifestText_read('/scripts/mine/x.mise', disk_read);
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.reason).toContain("/scripts/mine/x.mise: permission denied on the session's host");
      expect(diskReads).toEqual([]);
    } finally {
      chmodSync(scripts, 0o755);
    }
  });

  it('a script under a path where a file stands for a folder is said as not a directory, and the disk is read zero times', async () => {
    await backend_set(new FakeDriver(fakeCloud_sample()));
    writeFileSync(join(library.mine_derive(), 'afile'), 'x');
    const answer = await manifestText_read('/scripts/mine/afile/x.mise', disk_read);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain('/scripts/mine/afile/x.mise: a part of the path is a file, not a folder');
    expect(answer.ok === false && answer.reason).not.toContain('permission denied');
    expect(diskReads).toEqual([]);
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
