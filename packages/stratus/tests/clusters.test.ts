/**
 * @file A cluster read from a harbor-oci checkout: settings, state
 * with secrets withheld, steps from their evidence, credentials refused;
 * the `clusters/` tree; and `cluster status`.
 */
import { describe, it, expect } from '@jest/globals';
import type { VFSItem } from '@fnndsc/fond';
import { envFile_parse, harborCluster_read, lastDone_find, HARBOR_STEPS } from '../src/checkout/harborOci.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { TenancyProvider } from '../src/vfs/tenancy.js';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { cluster_run, stratusCommands_make, CLUSTER_HELP } from '../src/commands/cluster.js';
import type { CloudDriver, ResourceCounts } from '../src/cloud/driver.js';
import { harborCheckout_make } from './support/harborCheckout.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('reading a harbor-oci checkout', () => {
  it('reads KEY=value lines as a shell .env writes them', () => {
    expect(envFile_parse('# c\nA=1\nexport B="two words"\nC=\'3\'\n=x\nnoequals\n\nD=\n')).toEqual({ A: '1', B: 'two words', C: '3', D: '' });
  });

  it('shows only the settings a cluster names, the local file over the defaults, never a credential', () => {
    const cluster = harborCluster_read({ name: 'harbor', root: harborCheckout_make() }, NOW);
    expect(cluster.settings).toEqual({ CLUSTER_NAME: 'harbor', BASE_DOMAIN: 'oci.chrisproject.org', OCI_REGION: 'us-ashburn-1', OCI_COMPARTMENT_OCID: 'ocid1.compartment.oc1..harbor' });
    expect(cluster.cluster).toBe('harbor.oci.chrisproject.org');
    expect(JSON.stringify(cluster)).not.toContain('s3cret');
  });

  it('withholds the ISO link\'s URL from the state, naming where it is', () => {
    const root = harborCheckout_make();
    const cluster = harborCluster_read({ name: 'harbor', root }, NOW);
    expect(cluster.state?.['parUrl']).toBe(`withheld: a secret, on the host in ${root}/state/harbor.json`);
    expect(JSON.stringify(cluster)).not.toContain('SECRET');
    expect(cluster.state?.['parId']).toBe('par-1');
  });

  it('reads each step from its evidence, unknown where the host keeps none, in build order', () => {
    const root = harborCheckout_make();
    const steps = harborCluster_read({ name: 'harbor', root }, NOW).steps;
    expect(steps.map((step) => step.folder)).toEqual(HARBOR_STEPS.map((name, index) => `${String(index + 1).padStart(2, '0')}-${name}`));
    expect(Object.fromEntries(steps.map((step) => [step.name, step.state]))).toEqual({
      preflight: 'unknown', cluster: 'done', iso: 'done', 'infra-plan': 'done', 'infra-apply': 'done', dns: 'unknown',
      manifests: 'unknown', hosts: 'unknown', run: 'done', postinstall: 'not done', verify: 'unknown',
    });
    expect(steps[4]?.evidence).toBe('Terraform state holds 2 resources');
    expect(JSON.stringify(steps)).not.toContain('never shown');
    expect(steps[2]?.evidence).toBe('harbor-discovery.iso: link valid until 2099-01-01T00:00:00Z');
  });

  it('marks an expired ISO link, a planned stack not applied, and an empty checkout', () => {
    const expired = harborCluster_read({ name: 'x', root: harborCheckout_make({ parExpiresAt: '2026-10-13T00:00:00Z', stack: 'planned', kubeconfig: false }) }, NOW);
    expect(expired.steps.map((step) => step.state).slice(1, 5)).toEqual(['done', 'expired', 'done', 'not done']);
    expect(expired.steps[4]?.evidence).toBe('no Terraform state');
    expect(expired.steps[8]).toMatchObject({ state: 'not done', evidence: 'no kubeconfig saved' });
    expect(lastDone_find(expired)?.folder).toBe('04-infra-plan');
    const empty = harborCluster_read({ name: 'y', root: harborCheckout_make({ spec: false, state: false, stack: false, kubeconfig: false }) }, NOW);
    expect(empty.spec).toBeNull();
    expect(empty.state).toBeNull();
    expect(empty.secrets).toEqual([]);
    expect(empty.steps.filter((step) => step.state === 'done')).toEqual([]);
    expect(empty.steps[2]?.evidence).toBe('no ISO link in state');
    expect(empty.steps[3]?.evidence).toBe('no stack staged');
    expect(lastDone_find(empty)).toBeNull();
  });

  it('names the credentials by their host path only', () => {
    const root = harborCheckout_make();
    expect(harborCluster_read({ name: 'harbor', root }, NOW).secrets).toEqual([
      { name: 'kubeadmin-password', hostPath: `${root}/state/auth/kubeadmin-password` },
      { name: 'kubeconfig', hostPath: `${root}/state/auth/kubeconfig` },
    ]);
  });
});

describe('the clusters tree', () => {
  const tree_make = (roots: Record<string, string>): ClusterTree => new ClusterTree({
    sources: Object.entries(roots).map(([name, root]) => ({ name, root })), owner: (): string => 'rudolph', now: (): Date => NOW,
  });
  const listed = async (tree: ClusterTree, segments: string[]): Promise<VFSItem[]> => {
    const node = tree.node_resolve(segments);
    if (node.kind !== 'listing') throw new Error(`not a listing: ${segments.join('/')}`);
    return node.list();
  };

  it('lists each cluster with its last step and its cluster, and a cluster\'s files, steps and auth', async () => {
    const root = harborCheckout_make();
    const tree = tree_make({ harbor: root, empty: harborCheckout_make({ spec: false, state: false, stack: false, kubeconfig: false }) });
    expect(await listed(tree, [])).toEqual([
      { name: 'harbor', type: 'cluster', size: 0, owner: 'rudolph', date: NOW.toISOString(), status: '09-run', title: 'harbor.oci.chrisproject.org' },
      { name: 'empty', type: 'cluster', size: 0, owner: 'rudolph', date: NOW.toISOString(), status: 'empty', title: 'harbor.oci.chrisproject.org' },
    ]);
    expect((await listed(tree, ['harbor'])).map((item) => [item.name, item.type, item.size])).toEqual([
      ['spec.yaml', 'file', 59], ['settings', 'file', 128], ['state.json', 'file', expect.any(Number)], ['steps', 'kind', 11], ['auth', 'kind', 2],
    ]);
    expect((await listed(tree, ['empty'])).map((item) => item.name)).toEqual(['settings', 'steps', 'auth']);
    const steps = await listed(tree, ['harbor', 'steps']);
    expect(steps[1]).toMatchObject({ name: '02-cluster', type: 'step', status: 'done', title: 'Assisted Installer cluster cluster-1' });
    expect((await listed(tree, ['harbor', 'steps', '02-cluster'])).map((item) => item.name)).toEqual(['state', 'evidence']);
  });

  it('reads the files and a step\'s fields; refuses a credential with its host path', async () => {
    const root = harborCheckout_make();
    const tree = tree_make({ harbor: root });
    expect(tree.node_resolve(['harbor', 'spec.yaml'])).toMatchObject({ kind: 'file', text: expect.stringContaining('family: E5') });
    expect(tree.node_resolve(['harbor', 'settings'])).toMatchObject({ kind: 'file', text: expect.stringContaining('CLUSTER_NAME=harbor\n') });
    const state = tree.node_resolve(['harbor', 'state.json']);
    expect(state.kind === 'file' && JSON.parse(state.text).parUrl).toContain('withheld');
    expect(tree.node_resolve(['harbor', 'steps', '05-infra-apply', 'state'])).toEqual({ kind: 'file', text: 'done\n' });
    expect(tree.node_resolve(['harbor', 'auth', 'kubeconfig'])).toEqual({ kind: 'refused', errno: 'EACCES', reason: `a secret stays on the daemon's host: ${root}/state/auth/kubeconfig` });
    expect((await listed(tree, ['harbor', 'auth'])).map((item) => [item.name, item.type])).toEqual([['kubeadmin-password', 'secret'], ['kubeconfig', 'secret']]);
  });

  it('answers what is not there as missing', () => {
    const tree = tree_make({ harbor: harborCheckout_make() });
    for (const missing of [['other'], ['harbor', 'nothing'], ['harbor', 'spec.yaml', 'x'], ['harbor', 'steps', '99-x'], ['harbor', 'steps', '02-cluster', 'x'], ['harbor', 'steps', '02-cluster', 'state', 'x'], ['harbor', 'auth', 'none'], ['harbor', 'auth', 'kubeconfig', 'x']]) {
      expect(tree.node_resolve(missing)).toEqual({ kind: 'missing' });
    }
  });

  it('stands under the tenancy\'s clusters/, with credentials refused EACCES through the provider', async () => {
    const root = harborCheckout_make();
    const tenancy = new TenancyProvider({ driver: new FakeDriver(fakeCloud_sample()), clusters: tree_make({ harbor: root }) });
    const listing = await tenancy.list('/net/oci/fnndsc/clusters');
    expect(listing.ok && listing.value.map((item) => item.name)).toEqual(['harbor']);
    expect(await tenancy.read('/net/oci/fnndsc/clusters/harbor/steps/09-run/state')).toEqual({ ok: true, value: 'done\n' });
    expect(await tenancy.read('/net/oci/fnndsc/clusters/harbor/auth/kubeadmin-password')).toEqual({ ok: false, errno: 'EACCES', reason: `a secret stays on the daemon's host: ${root}/state/auth/kubeadmin-password` });
  });
});

describe('cluster status', () => {
  const context_make = (roots: Record<string, string>, driver: CloudDriver = new FakeDriver(fakeCloud_sample()), region: string | null = 'us-ashburn-1') => ({
    clusters: new ClusterTree({ sources: Object.entries(roots).map(([name, root]) => ({ name, root })), owner: (): string => 'rudolph', now: (): Date => NOW }),
    driver,
    region: (): string | null => region,
    clustersPath: (): string => '/net/oci/fnndsc/clusters',
  });

  it('prints each cluster: cluster, checkout, every step with its state and evidence, and the compartment\'s live resources', async () => {
    const root = harborCheckout_make();
    const answer = await cluster_run(context_make({ harbor: root }), []);
    expect(answer.status).toBe('ok');
    const lines = plain(answer.rendered).split('\n');
    expect(lines[0]).toBe('harbor  harbor.oci.chrisproject.org');
    expect(lines[1]).toBe(`checkout     ${root}`);
    expect(lines[3]).toBe('  02-cluster      done      Assisted Installer cluster cluster-1');
    expect(lines[13]).toBe('compartment  3 instances, 1 networks, 3 subnets, 2 securitygroups, 2 loadbalancers, 5 volumes, 1 buckets, 1 dns (us-ashburn-1)');
    expect((await cluster_run(context_make({ harbor: root }), ['status', 'harbor'])).rendered).toBe(answer.rendered);
    expect(answer.model).toEqual({
      kind: 'stratus.clusters',
      data: { clusters: [{
        name: 'harbor', path: '/net/oci/fnndsc/clusters/harbor', cluster: 'harbor.oci.chrisproject.org', lastDone: '09-run',
        steps: expect.arrayContaining([expect.objectContaining({ folder: '02-cluster', name: 'cluster', state: 'done', started: null, ended: null }), expect.objectContaining({ folder: '01-preflight', state: 'unknown' })]),
        resources: { instances: 3, networks: 1, subnets: 3, securitygroups: 2, loadbalancers: 2, volumes: 5, buckets: 1, dns: 1 },
        cost: { hourly: expect.any(Number), soFar: expect.any(Number), currency: 'USD' },
        condition: 'UP', billing: true, origin: 'checkout', protected: true, gone: null, spec: null, next: null, billingStep: 'infra-apply', running: null, plan: null, verify: null, asking: null,
        refused: { build: 'read from a harbor-oci checkout, not built here', teardown: 'read from a harbor-oci checkout, not built here' },
        region: 'us-ashburn-1', compartment: 'ocid1.compartment.oc1..harbor',
      }] },
    });
  });

  it('says why a compartment was not counted', async () => {
    const root = harborCheckout_make();
    const failing = new (class extends FakeDriver {
      override async resources_search(): Promise<ResourceCounts> { throw new Error('throttled'); }
    })(fakeCloud_sample());
    const failed = await cluster_run(context_make({ harbor: root }, failing), []);
    expect(plain(failed.rendered)).toContain('compartment  not counted: throttled');
    expect((failed.model?.data as { clusters: Array<{ resources: unknown }> }).clusters[0]?.resources).toBeNull();
    expect(plain((await cluster_run(context_make({ harbor: root }, undefined, null), [])).rendered)).toContain('compartment  not counted: not connected');
    const quiet = new (class extends FakeDriver {
      override async resources_search(): Promise<ResourceCounts> { return {}; }
    })(fakeCloud_sample());
    expect(plain((await cluster_run(context_make({ harbor: root }, quiet), [])).rendered)).toContain('compartment  nothing live (us-ashburn-1)');
  });

  it('says when the daemon has no clusters, refuses an unknown one by name, and a verb not yet written', async () => {
    const none = await cluster_run(context_make({}), []);
    expect(none.rendered).toBe('no clusters here or in the tenancy: cluster new <name> makes one; stratus --cluster <name>=<harbor-oci checkout> reads one\n');
    expect(none.model).toEqual({ kind: 'stratus.clusters', data: { clusters: [] } });
    const context = context_make({ harbor: harborCheckout_make() });
    expect((await cluster_run(context, ['status', 'nope'])).renderedErr).toBe('cluster: nope: no such cluster (harbor)\n');
    expect((await cluster_run(context, ['harbor'])).rendered).toBe((await cluster_run(context, ['status', 'harbor'])).rendered);
    expect((await cluster_run(context, ['harbor', 'x'])).renderedErr).toContain('cluster: harbor: not a verb');
    expect((await cluster_run(context, ['rename'])).renderedErr).toBe('cluster: rename: not a verb this session has yet (cluster status, new, size, plan, build, adopt, verify, protect, teardown)\n');
  });

  it('is one of the backend\'s two commands, with its help in the Resources category', async () => {
    const group = stratusCommands_make(context_make({}));
    expect(Object.keys(group.envelope ?? {})).toEqual(['cluster', 'capacity', 'spend']);
    expect(group.help?.['cluster']).toBe(CLUSTER_HELP);
    expect(CLUSTER_HELP.category).toBe('Resources');
    expect((await group.envelope!['cluster']!([])).status).toBe('ok');
  });
});
