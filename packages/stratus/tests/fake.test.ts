/**
 * @file The fake cloud keeps the driver contract, and counts what it is asked.
 */
import { describe, it, expect } from '@jest/globals';
import { FakeDriver, fakeCloud_sample, availabilityKey_make } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld } from '../src/cloud/fake/builder.js';
import { driverContract_describe } from './support/driverContract.js';

driverContract_describe('the fake cloud', () => new FakeDriver(fakeCloud_sample()));

describe('the fake cloud', () => {
  it('nests containers and answers availability by key', async () => {
    const driver = new FakeDriver(fakeCloud_sample('acme'));
    const root = await driver.root_get();
    expect(root.name).toBe('acme');
    const sandbox = (await driver.containers_list(root.id)).find((c) => c.name === 'sandbox');
    expect(sandbox).toBeDefined();
    expect((await driver.containers_list(sandbox!.id)).map((c) => c.name)).toEqual(['scratch-a']);
    expect(await driver.limitAvailability_get('us-ashburn-1', 'vcn', 'vcn-count')).toEqual({ used: 1, available: 49 });
    expect(await driver.limitAvailability_get('us-ashburn-1', 'vcn', 'nothing')).toBeNull();
    expect(availabilityKey_make('r', 's', 'n')).toBe('r/s/n');
    expect(availabilityKey_make('r', 's', 'n', 'z')).toBe('r/s/n/z');
    expect(driver.calls['containers_list']).toBe(2);
  });

  it('answers what the fake builder applied once it sees the world: a machine as an instance, a data stack by its tag', async () => {
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    const driver: FakeDriver = new FakeDriver(fakeCloud_sample()).built_see(world);
    const before: number = (await driver.instances_find('us-ashburn-1')).length;
    world.moduleStacks.set('stack-m', { module: 'vmMachine', owner: 'smk', tag: 'mise-vm', placeId: 'ocid1.compartment.oc1..fake-scratch', planned: {}, applied: { vcpu: '2', memory: '8' } });
    world.moduleStacks.set('stack-d', { module: 'vmData', owner: 'smk', tag: 'mise-vm', placeId: 'ocid1.compartment.oc1..fake-scratch', planned: {}, applied: {} });
    world.moduleStacks.set('stack-p', { module: 'vmMachine', owner: 'planned', tag: 'mise-vm', placeId: 'ocid1.compartment.oc1..fake-scratch', planned: {}, applied: null });
    const instances = await driver.instances_find('us-ashburn-1');
    expect(instances.length).toBe(before + 1);
    expect(instances.find((one) => one.name === 'smk')).toMatchObject({ id: 'ocid1.instance.oc1..fake-smk', state: 'running', vcpus: 2, memoryGib: 8, tags: { 'mise-service': 'smk' } });
    expect((await driver.clusters_find('mise-vm', 'us-ashburn-1')).map((one) => one.name)).toEqual(['smk']);
  });

  it('refuses a fixture with no root', async () => {
    const cloud = fakeCloud_sample();
    const driver = new FakeDriver({ ...cloud, containers: cloud.containers.filter((c) => c.parentId !== null) });
    await expect(driver.root_get()).rejects.toThrow('no root container');
  });

  it('answers an unknown region with nothing', async () => {
    const driver = new FakeDriver(fakeCloud_sample());
    expect(await driver.zones_list('eu-nowhere-1')).toEqual([]);
    expect(await driver.limitServices_list('eu-nowhere-1')).toEqual([]);
    expect(await driver.limits_list('eu-nowhere-1', 'compute')).toEqual([]);
    expect(await driver.shapes_list('eu-nowhere-1')).toEqual([]);
  });
});
