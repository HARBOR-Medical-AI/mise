/**
 * @file `chris plugin sync` (issue #1405): the plugin index into a ChRIS this
 * stratus deployed, by the chell porter runs beside it. Over the fake cloud
 * and a fake VM whose porter answers as chell would: the plan read first and
 * asked about with its counts, a NO that registers nothing, a yes applied
 * pinned to the commit the plan read, a replay with nothing to add that asks
 * nothing, and the refusals (no porter, a chell too old, a token refused).
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type JobContext, type LineStatusProvider, type PromptRequest } from '@fnndsc/brasa/core';
import { LINE_DECLINED_MODEL_KIND } from '@fnndsc/menu';
import type { CloudDriver, CloudPrice, ResourceCounts, ServicePrices } from '../src/cloud/driver.js';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { VmStore } from '../src/vm/state.js';
import { NetStore } from '../src/net/state.js';
import type { VmRemote } from '../src/vm/remote.js';
import { STEPS_SOURCE } from '../src/cluster/steps.js';
import { net_run } from '../src/commands/net.js';
import { vm_run, type VmCommandContext } from '../src/commands/vm.js';
import { chris_run, type ChrisCommandContext } from '../src/commands/chris.js';
import { lineStatusProviders_make } from '../src/commands/lineStatus.js';
import { FAKE_INDEX_COMMIT, FakeChrisVm } from '../src/cloud/fake/chris.js';
import {
  chrisPluginApplyRun_make, PLUGIN_SYNC_LINE, pluginApplyScript_render, pluginPlanScript_render, pluginSyncPlan_parse, pluginSyncReceipt_parse, shQuote, type PluginPlanRead,
} from '../src/chris/plugins.js';
import type { DeployDeps } from '../src/chris/deploy.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const VM_LINE: string[] = ['new', 'store', '--net', 'scratch', '--open', '80,443', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04'];
const DEPLOY_LINE: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org'];
const QUESTION: string = `chris plugin sync store: adds 4 from chris-plugins @ 8c9a1f6 on store, 0 already there, 1 reported (invalid: pl-s3path). Nothing is removed or changed. Continue? [y/N]`;

describe('chris plugin sync, by the chell porter runs beside CUBE', () => {
  let root: string;
  let vms: VmStore;
  let vm: FakeChrisVm;
  let context: ChrisCommandContext;
  let surface: HeadlessSurface & { answers: string[]; asked: string[] };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'stratus-plugins-'));
    vms = new VmStore(join(root, 'vms'));
    const nets: NetStore = new NetStore(join(root, 'nets'));
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    const builder: FakeCloudBuilder = new FakeCloudBuilder(world);
    const built = (): FakeDriver => new FakeDriver({ ...fakeCloud_sample(), resources: [] }).built_see(world);
    const driver = { instances_find: async (region: string): Promise<unknown[]> => built().instances_find(region), clusters_find: async (): Promise<unknown[]> => [], resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => [], servicePrices_get: async (): Promise<ServicePrices | null> => null } as unknown as CloudDriver;
    vm = new FakeChrisVm();
    context = { vms, nets, builder, resolve: async (): Promise<string[]> => ['203.0.113.10'], nameservers_get: async (): Promise<string[]> => [], registrar: null, status_get: async (): Promise<number | null> => 200, remote_open: async (): Promise<VmRemote> => vm, tickMs: 0 };
    const vmContext: VmCommandContext = { store: vms, nets, driver, builder, region: (): string => 'us-ashburn-1' };
    surface = Object.assign(new HeadlessSurface(), { answers: [] as string[], asked: [] as string[] });
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    surface.prompt = async (request: PromptRequest): Promise<string> => { surface.asked.push(request.message); return surface.answers.shift() ?? ''; };
    surface_set(surface);
    runner_install(new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'steps' }]));
    sink_set(new BufferSink());
    const netContext = { store: nets, driver, builder, region: (): string => 'us-ashburn-1', clientCidr_read: async (): Promise<string> => '134.174.21.21/32' };
    await net_run(netContext, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['y'];
    await net_run(netContext, ['build', 'scratch']);
    await vm_run(vmContext, VM_LINE);
    surface.answers = ['y', 'y'];
    await vm_run(vmContext, ['build', 'store']);
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, DEPLOY_LINE);
    surface.asked = [];
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('reads the plan on the VM, asks with its counts, and a NO registers nothing', async () => {
    surface.answers = ['n'];
    const declined = await chris_run(context, ['plugin', 'sync', '--on', 'store']);
    expect(surface.asked).toEqual([QUESTION]);
    expect(plain(declined.rendered)).toContain('stopped before any plugin was registered; nothing changed on store (chris plugin sync --on store plans and asks again)');
    expect(declined.model).toEqual({ kind: LINE_DECLINED_MODEL_KIND, data: { line: 'chris plugin sync --on store', kept: 'nothing registered' } });
    expect(vm.syncs.map((run) => run.kind)).toEqual(['plan']);
    expect(vm.plugins.size).toBe(0);
  });

  it('applies a yes pinned to the commit the plan read; a replay has nothing to add and asks nothing', async () => {
    surface.answers = ['y'];
    const synced = await chris_run(context, ['plugin', 'sync', '--on', 'store']);
    expect(plain(synced.rendered)).toBe('store: 4 added, 0 skipped, 1 reported, 0 failed from chris-plugins @ 8c9a1f6 at https://cube.example.org/api/v1/\n');
    expect(vm.syncs).toEqual([{ kind: 'plan', ask: {} }, { kind: 'apply', ask: { source: 'FNNDSC/chris-plugins@main', ref: FAKE_INDEX_COMMIT } }]);
    expect([...vm.plugins.keys()]).toEqual(['pl-dircopy', 'pl-simpledsapp', 'pl-tsdircopy', 'pl-dcm2niix']);
    surface.asked = [];
    const again = await chris_run(context, ['plugin', 'sync', '--on', 'store']);
    expect(surface.asked).toEqual([]);
    expect(plain(again.rendered)).toBe('store: nothing to add from chris-plugins @ 8c9a1f6; 4 already there, 1 reported (invalid: pl-s3path)\n');
  });

  it('with --plan reads the plan and stops, asking nothing', async () => {
    const planned = await chris_run(context, ['plugin', 'sync', 'FNNDSC/chris-plugins', '--ref', 'v1', '--on', 'store', '--plan']);
    expect(surface.asked).toEqual([]);
    expect(plain(planned.rendered)).toBe('chris plugin sync store: would add 4 from chris-plugins @ 8c9a1f6, 0 already there, 1 reported (invalid: pl-s3path); --plan: nothing was registered\n');
    expect(vm.syncs).toEqual([{ kind: 'plan', ask: { source: 'FNNDSC/chris-plugins', ref: 'v1' } }]);
  });

  it('refuses a chell too old, naming the deploy replay, before anything is asked', async () => {
    vm.chellVersion = '5.19.15';
    const refused = await chris_run(context, ['plugin', 'sync']);
    expect(refused.renderedErr).toBe("chris plugin sync: the store's chell is 5.19.15; plugin sync needs 5.20.0 — replay chris deploy store\n");
    expect(surface.asked).toEqual([]);
  });

  it('says why when porter does not answer or CUBE refuses chris\'s token', async () => {
    vm.tokenRefused = true;
    expect((await chris_run(context, ['plugin', 'sync'])).renderedErr).toContain("store: CUBE gave chris no token with the password in cube.env (chris passwd --on store)");
    vm.tokenRefused = false;
    vm.porterRuns = false;
    expect((await chris_run(context, ['plugin', 'sync'])).renderedErr).toContain("store: porter's container does not answer (chris status store)");
    expect(surface.asked).toEqual([]);
  });

  it('refuses a ChRIS with no porter, a bad source or ref, and a session that may not act, before reaching the VM', async () => {
    vms.record_update('store', (record): void => { if (record.chris !== undefined) delete record.chris.porter; });
    expect((await chris_run(context, ['plugin', 'sync'])).renderedErr).toBe("chris plugin sync: store: no porter runs there, and plugin sync runs in porter's chell (chris deploy store --host <name> --porter <name>)\n");
    expect((await chris_run(context, ['plugin', 'sync', "x';rm"])).renderedErr).toContain('an index is owner/repo[@ref], cube:<path> or host:<path>');
    expect((await chris_run(context, ['plugin', 'sync', '--ref', 'a b'])).renderedErr).toContain('--ref a b: a branch, a tag or a commit');
    expect((await chris_run(context, ['plugin', 'list'])).renderedErr).toContain('chris plugin: list: not a verb');
    expect(vm.syncs).toEqual([]);
  });

  it('reads where a script\'s plugin sync line stands, from the records', async () => {
    const providers: Map<string, LineStatusProvider> = new Map(lineStatusProviders_make({ nets: context.nets, vms }).map((provider: LineStatusProvider): [string, LineStatusProvider] => [provider.verb, provider]));
    const read = async (line: string): Promise<string> => { const answer = await (providers.get('chris') as LineStatusProvider).read(line.split(' ')); return answer === null ? '—' : `${answer.state}${answer.detail === '' ? '' : ` (${answer.detail})`}`; };
    expect(await read('chris plugin sync --on store')).toBe('ready (reads the plan on the VM when it runs; nothing to add asks nothing)');
    expect(await read('chris plugin sync --on blt')).toBe('not yet (no ChRIS on blt (chris deploy blt))');
    vms.record_update('store', (record): void => { if (record.chris !== undefined) delete record.chris.porter; });
    expect(await read('chris plugin sync --ref 8c9a1f6')).toBe("not yet (no porter on store; plugin sync runs in porter's chell (chris deploy --porter))");
  });
});

describe('the plugin sync script and what it prints', () => {
  const PLAN: PluginPlanRead = { chell: '5.20.0', label: 'chris-plugins @ 8c9a1f6', source: 'FNNDSC/chris-plugins@main', commit: FAKE_INDEX_COMMIT, indexed: 2, computes: ['NERC'], entries: [{ group: 'add', name: 'pl-a' }, { group: 'skip', name: 'pl-b' }] };

  it('reads the password on the VM and hands chell a token on stdin, never a password on a line', () => {
    const script: string = pluginPlanScript_render({ source: 'FNNDSC/chris-plugins', ref: 'v1' }, 'https://cube.example.org/api/v1/');
    expect(script).toContain('os.environ["CHRIS_SUPERUSER_PASSWORD"]');
    expect(script).toContain("printf '%s\\n' \"$TOKEN\" | docker compose exec -T porter sh -c");
    expect(script).toContain('--auth-token-stdin');
    expect(script).toContain("'chris@https://cube.example.org/api/v1/'");
    expect(script).toContain('P=$(plugin sync FNNDSC/chris-plugins --ref v1 --plan)');
    expect(script).not.toMatch(/admin-password|admin-pass/);
    expect(pluginApplyScript_render(PLAN, 'https://cube.example.org/api/v1/')).toContain(`'plugin sync FNNDSC/chris-plugins@main --ref ${FAKE_INDEX_COMMIT} --yes'`);
    expect(PLUGIN_SYNC_LINE).toBe('cd /srv/data/chris && sh -s');
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it('reads a plan among whatever else chell printed, an empty field read as empty', () => {
    const printed: string = '\x1b[1mplugin sync: chris-plugins @ 8c9a1f6, 2 plugins\x1b[0m\nstratus-sync chell 5.20.0\nstratus-sync indexed 2\nstratus-sync label chris-plugins @ 8c9a1f6\nstratus-sync source host:/srv/index\nstratus-sync computes NERC host\nstratus-sync entries.group add skip\nstratus-sync entries.name pl-a pl-b\n${P.commit}: P.commit is empty.\n';
    expect(pluginSyncPlan_parse(printed)).toEqual({ chell: '5.20.0', label: 'chris-plugins @ 8c9a1f6', source: 'host:/srv/index', commit: null, indexed: 2, computes: ['NERC', 'host'], entries: [{ group: 'add', name: 'pl-a' }, { group: 'skip', name: 'pl-b' }] });
    expect(pluginSyncPlan_parse('[!] Connection refused\n')).toBeNull();
    expect(pluginSyncPlan_parse('stratus-sync indexed 2\nstratus-sync label x\nstratus-sync source y\nstratus-sync entries.group add\n')).toBeNull();
  });

  it('reads the summary, and a stop', () => {
    expect(pluginSyncReceipt_parse('added  pl-a 1.0\n\x1b[32m1 added, 3 skipped, 1 reported, 0 failed.\x1b[39m\n')).toEqual({ added: 1, skipped: 3, reported: 1, failed: 0, stopped: false });
    expect(pluginSyncReceipt_parse('Stopped: 48 added, 0 skipped, 1 reported, 0 failed. 126 never sent; what was added stays\n')).toMatchObject({ added: 48, stopped: true });
    expect(pluginSyncReceipt_parse('nothing\n')).toBeNull();
  });

  it('streams each plugin into the task\'s log as it lands', async () => {
    const vm: FakeChrisVm = new FakeChrisVm();
    const logged: string[] = [];
    const job: JobContext = { signal: new AbortController().signal, data: {}, progress_set: (): void => undefined, log_write: (line: string): void => { logged.push(line); }, data_set: (): void => undefined };
    const deps = { remote_open: async (): Promise<VmRemote> => vm } as unknown as DeployDeps;
    const result: { receipt?: unknown } = {};
    await chrisPluginApplyRun_make('store', 'https://cube.example.org/api/v1/', PLAN, deps, result)(job);
    expect(logged).toContain('added  pl-dircopy 3.0.0');
    expect(logged.at(-1)).toBe('4 added, 0 skipped, 1 reported, 0 failed');
    expect(result.receipt).toEqual({ added: 4, skipped: 0, reported: 1, failed: 0, stopped: false });
  });
});
