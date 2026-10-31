/**
 * @file The tenancy as a tree over the fake cloud: paths, names, fields,
 * refusals, caching, and a session that is not connected.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { errorStack, errorStack_getAllOfType, type VFSItem } from '@fnndsc/fond';
import { FakeDriver, fakeCloud_sample, type FakeCloud } from '../src/cloud/fake/driver.js';
import { TenancyProvider, READ_ONLY_REASON } from '../src/vfs/tenancy.js';
import { AnswerCache } from '../src/cache.js';
import type { CloudContainer, CloudDriver } from '../src/cloud/driver.js';

const T = '/net/oci/fnndsc';
const KINDS = ['instances', 'networks', 'loadbalancers', 'volumes', 'buckets', 'dns'];
const R = `${T}/regions/us-ashburn-1`;

/** The sample cloud with a twin of `sandbox` and a compartment named like a reserved folder. */
function cloud_withTwins(): FakeCloud {
  const cloud: FakeCloud = fakeCloud_sample('fnndsc');
  const sandbox: CloudContainer = cloud.containers[2];
  const twin: CloudContainer = { ...sandbox, id: 'ocid1.compartment.oc1..twin00', description: 'the other sandbox' };
  const regions: CloudContainer = { ...sandbox, id: 'ocid1.compartment.oc1..region', name: 'regions', description: 'a compartment named regions' };
  return { ...cloud, containers: [...cloud.containers, twin, regions] };
}

const names = (items: VFSItem[]): string[] => items.map((item: VFSItem): string => item.name);

async function listed(tree: TenancyProvider, path: string): Promise<VFSItem[]> {
  const result = await tree.list(path);
  if (!result.ok) throw new Error(`could not list ${path}: ${errorStack_getAllOfType('error').join('; ')}`);
  return result.value;
}

describe('the tenancy tree', () => {
  let driver: FakeDriver;
  let tree: TenancyProvider;
  beforeEach(() => {
    errorStack.stack_clear();
    driver = new FakeDriver(cloud_withTwins());
    tree = new TenancyProvider({ driver, now: (): string => '2026-10-20T12:00:00.000Z' });
  });

  it('mounts at /net/<cloud> and lists the tenancy there', async () => {
    expect(tree.prefix).toBe('/net/oci');
    const items = await listed(tree, '/net/oci');
    expect(items).toEqual([{ name: 'fnndsc', type: 'tenancy', size: 0, owner: 'rudolph', date: '2026-10-20T12:00:00.000Z', status: 'active' }]);
    expect(await listed(tree, '/net/oci/')).toHaveLength(1);
  });

  it('lists a tenancy as its compartments, kind folders, regions, clusters and info.json; duplicates and reserved names wear the suffix', async () => {
    const items = await listed(tree, T);
    expect(names(items)).toEqual(['harbor-oci', 'regions~region', 'sandbox~andbox', 'sandbox~twin00', ...KINDS, 'regions', 'clusters', 'info.json']);
    const harbor = items[0];
    expect(harbor).toMatchObject({ type: 'compartment', owner: 'rudolph', status: 'active', title: 'Trusted Domain builds', tags: ['openshift-tags.openshift-resource=harbor'], date: '2026-08-27T12:00:00.000Z' });
    expect(items.find((item) => item.name === 'info.json')).toMatchObject({ type: 'file' });
    expect(items.find((item) => item.name === 'regions')).toMatchObject({ type: 'dir' });
  });

  it('refuses the plain name of a duplicate, naming both, and enters the suffixed one', async () => {
    expect((await tree.list(`${T}/sandbox`)).ok).toBe(false);
    expect(errorStack_getAllOfType('error').join('\n')).toContain('sandbox: ambiguous: sandbox~andbox, sandbox~twin00');
    expect(names(await listed(tree, `${T}/sandbox~andbox`))).toEqual(['scratch-a', ...KINDS, 'info.json']);
    expect(names(await listed(tree, `${T}/sandbox~twin00`))).toEqual([...KINDS, 'info.json']);
    expect(names(await listed(tree, `${T}/sandbox~andbox/scratch-a`))).toEqual([...KINDS, 'info.json']);
    expect(names(await listed(tree, `${T}/regions~region`))).toEqual([...KINDS, 'info.json']);
  });

  it('reads info.json of the tenancy and of a nested compartment', async () => {
    const root = await tree.read(`${T}/info.json`);
    expect(root.ok && JSON.parse(root.value).name).toBe('fnndsc');
    const deep = await tree.read(`${T}/sandbox~andbox/scratch-a/info.json`);
    expect(deep.ok && JSON.parse(deep.value).name).toBe('scratch-a');
    const binary = await tree.readBinary(`${T}/info.json`);
    expect(binary.ok && binary.value.toString('utf-8').includes('"fnndsc"')).toBe(true);
  });

  it('walks regions: zones, limits by service with zone folders or fields, shapes, prices', async () => {
    expect(names(await listed(tree, `${T}/regions`))).toEqual(['us-ashburn-1']);
    expect(await listed(tree, `${T}/regions`)).toMatchObject([{ type: 'region' }]);
    expect(names(await listed(tree, R))).toEqual(['zones', 'limits', 'shapes', 'prices']);
    expect(names(await listed(tree, `${R}/zones`))).toEqual(['Uocm:US-ASHBURN-AD-1', 'Uocm:US-ASHBURN-AD-2', 'Uocm:US-ASHBURN-AD-3']);
    expect(names(await listed(tree, `${R}/zones/Uocm:US-ASHBURN-AD-2`))).toEqual(['name']);
    expect(await tree.read(`${R}/zones/Uocm:US-ASHBURN-AD-2/name`)).toEqual({ ok: true, value: 'Uocm:US-ASHBURN-AD-2\n' });
    expect(names(await listed(tree, `${R}/limits`))).toEqual(['compute', 'load-balancer', 'vcn']);
    expect(names(await listed(tree, `${R}/limits/compute`))).toEqual(['standard-e5-core-count', 'standard-e5-memory-count']);
    expect(names(await listed(tree, `${R}/limits/compute/standard-e5-core-count`))).toEqual(['Uocm:US-ASHBURN-AD-1', 'Uocm:US-ASHBURN-AD-2', 'Uocm:US-ASHBURN-AD-3']);
    expect(names(await listed(tree, `${R}/limits/compute/standard-e5-core-count/Uocm:US-ASHBURN-AD-1`))).toEqual(['value', 'scope', 'service', 'zone', 'used', 'available']);
    expect(names(await listed(tree, `${R}/limits/compute/standard-e5-core-count/Uocm:US-ASHBURN-AD-2`))).toEqual(['value', 'scope', 'service', 'zone']);
    expect(await tree.read(`${R}/limits/compute/standard-e5-core-count/Uocm:US-ASHBURN-AD-1/available`)).toEqual({ ok: true, value: '9238\n' });
    expect(names(await listed(tree, `${R}/limits/load-balancer/lb-flexible-count`))).toEqual(['value', 'scope', 'service', 'used', 'available']);
    expect(await tree.read(`${R}/limits/load-balancer/lb-flexible-count/scope`)).toEqual({ ok: true, value: 'region\n' });
    expect(await tree.read(`${R}/limits/vcn/vcn-count/scope`)).toEqual({ ok: true, value: 'global\n' });
    expect(names(await listed(tree, `${R}/shapes`))).toEqual(['VM.Standard.A2.Flex', 'VM.Standard.E5.Flex']);
    expect(names(await listed(tree, `${R}/shapes/VM.Standard.E5.Flex`))).toEqual(['family', 'flexible', 'vcpus', 'memory', 'processor', 'gpus', 'quotas', 'info.json']);
    expect(await tree.read(`${R}/shapes/VM.Standard.E5.Flex/vcpus`)).toEqual({ ok: true, value: '1-94\n' });
    expect(await tree.read(`${R}/shapes/VM.Standard.E5.Flex/memory`)).toEqual({ ok: true, value: '1-1049 GiB\n' });
    expect(await tree.read(`${R}/shapes/VM.Standard.E5.Flex/quotas`)).toEqual({ ok: true, value: 'standard-e5-core-count\nstandard-e5-memory-count\n' });
    expect(names(await listed(tree, `${R}/prices`))).toEqual(['VM.Standard.E5.Flex', 'VM.Standard.A2.Flex']);
    expect(names(await listed(tree, `${R}/prices/VM.Standard.A2.Flex`))).toEqual(['vcpuHour', 'gibHour', 'currency']);
    expect(await tree.read(`${R}/prices/VM.Standard.A2.Flex/vcpuHour`)).toEqual({ ok: true, value: '0.007\n' });
  });

  it('lists clusters empty, and refuses what is not there with the shell\'s words', async () => {
    expect(await listed(tree, `${T}/clusters`)).toEqual([]);
    for (const missing of ['/net/aws', `${T}/nothing`, `${T}/clusters/x`, `${T}/regions/eu-nowhere-1`, `${R}/elsewhere`, `${R}/zones/none`, `${R}/limits/nosuch`, `${R}/limits/compute/nosuch`, `${R}/limits/compute/standard-e5-core-count/nozone`, `${R}/shapes/none`, `${R}/prices/none`, `${R}/shapes/VM.Standard.E5.Flex/nofield`, `${R}/shapes/VM.Standard.E5.Flex/family/deeper`, `${T}/info.json/x`, `${T}/harbor-oci/info.json/x`, '/net/oci/other-tenancy']) {
      errorStack.stack_clear();
      expect((await tree.list(missing)).ok).toBe(false);
      expect(errorStack_getAllOfType('error').join('\n')).toContain('No such file or directory');
      expect(await tree.read(missing)).toEqual({ ok: false, errno: 'ENOENT' });
    }
  });

  it('a file lists as Not a directory and a folder reads as EISDIR; writes are refused', async () => {
    errorStack.stack_clear();
    expect((await tree.list(`${T}/info.json`)).ok).toBe(false);
    expect(errorStack_getAllOfType('error').join('\n')).toContain('Not a directory');
    expect(await tree.read(T)).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await tree.read('/net/oci')).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await tree.read(`${R}/limits/compute/standard-e5-core-count`)).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await tree.cp()).toEqual({ ok: false, errno: 'EROFS', reason: READ_ONLY_REASON });
  });

  it('asks the cloud once for what it has been asked before, until the cache is cleared', async () => {
    await listed(tree, T);
    await listed(tree, T);
    await listed(tree, `${T}/harbor-oci`);
    expect(driver.calls['identity_get']).toBe(1);
    expect(driver.calls['root_get']).toBe(1);
    expect(driver.calls['containers_list']).toBe(2);
    tree.cache_clear();
    await listed(tree, T);
    expect(driver.calls['containers_list']).toBe(3);
  });

  it('with an aged cache asks again', async () => {
    let now = 0;
    const aged = new TenancyProvider({ driver, cache: new AnswerCache(10, () => now) });
    await listed(aged, `${T}/regions`);
    now = 11;
    await listed(aged, `${T}/regions`);
    expect(driver.calls['regions_list']).toBe(2);
  });
});

describe('a tenancy tree that is not connected', () => {
  it('lists the mount empty and says why beneath it', async () => {
    const broken: CloudDriver = new (class extends FakeDriver {
      override async identity_get(): Promise<never> { throw new Error('config file not found'); }
    })(fakeCloud_sample());
    const tree = new TenancyProvider({ driver: broken });
    errorStack.stack_clear();
    expect(await tree.list('/net/oci')).toEqual({ ok: true, value: [] });
    expect((await tree.list('/net/oci/fnndsc')).ok).toBe(false);
    expect(errorStack_getAllOfType('error').join('\n')).toContain('not connected: config file not found');
    expect(await tree.read('/net/oci/fnndsc/info.json')).toEqual({ ok: false, errno: 'ENOENT', reason: 'not connected: config file not found' });
  });
});
