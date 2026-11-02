/**
 * @file The library of scripts (docs/stratus.adoc, D17): sources named in
 * the configuration and cloned under the state, `scripts add`, `pull` and
 * `remove`, and the `/scripts` mount: a source's folder read-only, `mine`
 * written to, `.git` never shown, `play` reading through it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { stratusBackend_make } from '../src/backend.js';
import { ClusterStore } from '../src/cluster/state.js';
import { ScriptLibrary, git_run, scriptsRoot_derive } from '../src/scripts/library.js';
import { scripts_run } from '../src/commands/scripts.js';

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
    expect((await scripts_run(context, ['fetch'])).renderedErr).toContain('fetch: not a verb');
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
    expect(top.ok && top.value.map((item) => `${item.name} ${item.type} ${item.status ?? ''}`.trim())).toEqual(['chrisproject source cloned', 'whole source cloned', 'mine dir']);
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
