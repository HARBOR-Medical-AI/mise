/**
 * @file `verify`: the kubeconfig read, the ten checks over a fake cluster
 * (healthy and not), the probe only under the tier, and `cluster verify`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessSurface, surface_set, type CommandEnvelope } from '@fnndsc/brasa/core';
import { kubeconfig_read, KubeError, type KubeApi } from '../src/kube/kube.js';
import { FakeKube, fakeVerifyReach, type FakeNode } from '../src/kube/fakeKube.js';
import { cpuQuantity_parse, verify_run, type VerifyContext } from '../src/cluster/verify.js';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { ClusterStore } from '../src/cluster/state.js';
import { SPEC_DEFAULT } from '../src/cluster/spec.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { cluster_run, type ClusterCommandContext } from '../src/commands/cluster.js';
import { checkout_read } from '../src/cluster/adopt.js';
import { harborCheckout_make } from './support/harborCheckout.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const NODES: FakeNode[] = [0, 1, 2].map((n: number): FakeNode => ({ name: `harbor-cp-${n}`, zone: `AD-${n + 1}`, shape: 'VM.Standard.E5.Flex' }));

/** A context over a cluster, the fake world's DNS and console. */
function context_of(kube: KubeApi, probe: boolean, extra: Partial<VerifyContext> = {}): VerifyContext {
  const reach = fakeVerifyReach((): FakeNode[] => NODES);
  return {
    kube, resolve: reach.resolve, https_status: reach.https_status, cluster: 'harbor', baseDomain: 'oci.example.org', shape: 'VM.Standard.E5.Flex', expectedNodes: 3,
    addresses: { api: '10.0.0.10', apiInt: '10.0.0.11', apps: '10.0.0.12' }, probe, probeTimeoutMs: 1000, pollMs: 0, ...extra,
  };
}

describe('the kubeconfig', () => {
  it('reads the current context\'s server, CA and client, all decoded', () => {
    const b64 = (text: string): string => Buffer.from(text).toString('base64');
    const access = kubeconfig_read([
      'apiVersion: v1', 'current-context: admin', 'clusters:',
      '- name: other', '  cluster: {server: "https://other:6443"}',
      `- name: harbor`, `  cluster: {server: "https://api.harbor:6443/", certificate-authority-data: ${b64('CA')}}`,
      'contexts:', '- name: admin', '  context: {cluster: harbor, user: admin}',
      'users:', `- name: admin`, `  user: {client-certificate-data: ${b64('CERT')}, client-key-data: ${b64('KEY')}}`,
    ].join('\n'));
    expect(access).toEqual({ server: 'https://api.harbor:6443', ca: 'CA', cert: 'CERT', key: 'KEY', token: null });
    expect(kubeconfig_read('clusters:\n- name: a\n  cluster: {server: "https://a"}\nusers:\n- name: u\n  user: {token: t}\n')).toEqual({ server: 'https://a', ca: null, cert: null, key: null, token: 't' });
    expect(() => kubeconfig_read('# nothing\n')).toThrow('names no cluster server');
    expect(new KubeError(404, 'gone').status).toBe(404);
  });
});

describe('the ten checks', () => {
  it('pass nine on a healthy cluster, and leave the probe to the tier', async () => {
    const checks = await verify_run(context_of(new FakeKube({ nodes: NODES }), false));
    expect(checks.map((check) => `${check.name}:${check.ok}`)).toEqual(['API:true', 'cluster version:true', 'nodes:true', 'OCI CCM:true', 'operators:true', 'storage class:true', 'DNS:true', 'console:true', 'CPU headroom:true', 'block volume:null']);
    expect(checks[9]).toMatchObject({ how: 'writes', detail: expect.stringContaining('needs the tasks tier') });
    expect(checks[8]?.detail).toBe('unrequested cores: 4.5 / 4.5 / 4.5 (a plugin job asks 2)');
    expect(cpuQuantity_parse('250m')).toBe(0.25);
  });

  it('runs the probe under the tier, and deletes what it made', async () => {
    const kube: FakeKube = new FakeKube({ nodes: NODES });
    const checks = await verify_run(context_of(kube, true));
    expect(checks[9]).toMatchObject({ name: 'block volume', ok: true, detail: expect.stringContaining("pod Succeeded, read back 'stratus'") });
    expect(kube.made).toEqual(['/api/v1/namespaces', '/api/v1/namespaces/stratus-verify/persistentvolumeclaims', '/api/v1/namespaces/stratus-verify/pods']);
    expect(kube.deleted).toEqual(['/api/v1/namespaces/stratus-verify']);
    const failing = await verify_run(context_of(new FakeKube({ nodes: NODES, probeSucceeds: false }), true));
    expect(failing[9]?.ok).toBe(false);
  });

  it('fail each on its own, saying why', async () => {
    const checks = await verify_run(context_of(new FakeKube({ nodes: NODES.slice(0, 2), degraded: ['monitoring'] }), false, {
      shape: 'VM.Standard.E4.Flex', addresses: { api: '10.0.0.99' },
      https_status: async (): Promise<number> => 503,
    }));
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(byName['nodes']).toMatchObject({ ok: false, detail: '2/3 Ready' });
    expect(byName['OCI CCM']).toMatchObject({ ok: false, detail: expect.stringContaining('harbor-cp-0 is VM.Standard.E5.Flex') });
    expect(byName['operators']).toMatchObject({ ok: false, detail: '5 operators, not settled: monitoring' });
    expect(byName['DNS']?.detail).toBe('api.harbor.oci.example.org -> 10.0.0.10 (wanted 10.0.0.99); api-int.harbor.oci.example.org: no address recorded; *.apps.harbor.oci.example.org: no address recorded');
    expect(byName['console']).toMatchObject({ ok: false, detail: 'https://console-openshift-console.apps.harbor.oci.example.org/ HTTP 503' });
    const broken: KubeApi = { json_get: async () => { throw new Error('connect ECONNREFUSED'); }, text_get: async () => 'not ok', json_post: async () => ({}), delete: async () => undefined };
    const down = await verify_run(context_of(broken, false));
    expect(down[0]).toMatchObject({ name: 'API', ok: false, detail: '/readyz not ok' });
    expect(down[1]).toMatchObject({ ok: false, detail: 'connect ECONNREFUSED' });
  });
});

describe('cluster verify', () => {
  let root: string;
  let store: ClusterStore;
  let context: ClusterCommandContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-verify-'));
    store = new ClusterStore(join(root, 'clusters'));
    const clusters: ClusterTree = new ClusterTree({ sources: [{ name: 'checkout', root: harborCheckout_make() }], owner: (): string => 'r', now: (): Date => new Date(), store });
    const driver: FakeDriver = new FakeDriver(fakeCloud_sample());
    const verifyReach = fakeVerifyReach((): FakeNode[] => NODES);
    context = { clusters, driver, region: (): string => 'us-ashburn-1', clustersPath: (): string => '/d', build: { clusters, store, driver, region: (): string => 'us-ashburn-1', deps: null, builder: null, baseDomain: 'oci.example.org', verifyReach } };
    store.create({ name: 'harbor', created: 'now', region: 'us-ashburn-1', baseDomain: 'oci.example.org', steps: {}, ids: { apiIp: '10.0.0.10', apiIntIp: '10.0.0.11', appsIp: '10.0.0.12' } }, SPEC_DEFAULT);
    surface_set(new HeadlessSurface());
  });
  afterEach(() => { surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('runs the checks through the kubeconfig on the host and keeps the result as the verify step', async () => {
    expect((await cluster_run(context, ['verify', 'harbor'])).renderedErr).toBe('cluster verify: harbor: no kubeconfig yet: its cluster is not installed\n');
    store.secret_write('harbor', 'kubeconfig', 'clusters:\n- name: h\n  cluster: {server: "https://api"}\n');
    const verified: CommandEnvelope = await cluster_run(context, ['verify']);
    expect(verified.status).toBe('ok');
    expect(plain(verified.rendered)).toContain('✓ API              /readyz ok');
    expect(plain(verified.rendered)).toContain('· block volume');
    expect(plain(verified.rendered)).toContain('verify: 9 of 10 pass, 1 not run (needs the tasks tier)');
    expect(store.record_read('harbor')?.steps['verify']).toMatchObject({ state: 'done', note: '9 of 10 pass, 1 not run (needs the tasks tier)' });
    const granted: HeadlessSurface = new HeadlessSurface();
    (granted.capabilities as { tasks?: boolean }).tasks = true;
    surface_set(granted);
    expect(plain((await cluster_run(context, ['verify', 'harbor'])).rendered)).toContain('verify: 10 of 10 pass');
  });

  it('fails when a check fails, and refuses what it cannot verify', async () => {
    store.secret_write('harbor', 'kubeconfig', 'clusters:\n- name: h\n  cluster: {server: "https://api"}\n');
    const sick: ClusterCommandContext = { ...context, build: { ...context.build!, verifyReach: { ...context.build!.verifyReach!, https_status: async () => 500 } } };
    const failed: CommandEnvelope = await cluster_run(sick, ['verify', 'harbor']);
    expect(failed.status).toBe('error');
    expect(plain(failed.rendered)).toContain('verify: 8 of 10 pass, 1 fail');
    expect(store.record_read('harbor')?.steps['verify']?.state).toBe('failed');
    expect((await cluster_run(context, ['verify', 'checkout'])).renderedErr).toContain('read from a harbor-oci checkout; cluster adopt checkout --from');
    expect((await cluster_run(context, ['verify', 'nope'])).renderedErr).toBe('cluster verify: nope: no such cluster\n');
    expect((await cluster_run(context, ['verify', '-x'])).renderedErr).toBe('cluster verify: usage: cluster verify [<name>]\n');
    store.create({ name: 'other', created: 'now', region: 'r', baseDomain: 'b', steps: {}, ids: {} }, SPEC_DEFAULT);
    expect((await cluster_run(context, ['verify'])).renderedErr).toBe('cluster verify: which cluster? (harbor, other)\n');
  });

  it('adoption keeps the load balancers\' addresses from the state\'s outputs', () => {
    const checkout: string = harborCheckout_make();
    const state: string = join(checkout, 'state', 'stack', 'oci-openshift-1.6.1', 'terraform-stacks', 'create-cluster', 'terraform.tfstate');
    writeFileSync(state, JSON.stringify({ outputs: { open_shift_api_lb_addr: { value: '1.2.3.4' }, open_shift_api_int_lb_addr: { value: '10.0.0.5' }, open_shift_apps_lb_addr: { value: '1.2.3.5' } } }));
    const read = checkout_read('harbor', checkout, new Date());
    expect('record' in read && read.record.ids).toMatchObject({ apiIp: '1.2.3.4', apiIntIp: '10.0.0.5', appsIp: '1.2.3.5' });
  });
});
