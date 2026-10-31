/**
 * @file What a cluster costs: machines, volumes and load balancers at list
 * price, an hour and since each was made; the price list's storage and
 * balancer parts; `spend`.
 */
import { describe, it, expect } from '@jest/globals';
import type { CloudInstance, CloudLoadBalancer, CloudVolume, ServicePrices } from '../src/cloud/driver.js';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { ociServicePrices_read, servicePrices_map, SERVICE_PARTS } from '../src/cloud/oci/prices.js';
import { balancer_hourly, HOURS_PER_MONTH, instance_hourly, money_words, spend_line, spend_read, volume_hourly } from '../src/cluster/spend.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { spend_run, SPEND_HELP } from '../src/commands/spend.js';
import type { ClusterCommandContext } from '../src/commands/cluster.js';
import { harborCheckout_make } from './support/harborCheckout.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const SERVICE: ServicePrices = { volumeGibMonth: 0.0255, vpuGibMonth: 0.0017, balancerHour: 0.0113, balancerMbpsHour: 0.0001, currency: 'USD' };
const NOW: Date = new Date('2026-10-07T14:00:00.000Z');

describe('pricing one resource', () => {
  const base = { id: 'i', state: 'running', region: 'r', created: '2026-10-06T14:00:00.000Z', tags: {}, raw: {} };
  it('prices a machine by vCPU and memory, a volume by size and performance, a balancer by hour and bandwidth', () => {
    const instance: CloudInstance = { ...base, name: 'n', shape: 'VM.Standard.E5.Flex', zone: 'z', ips: [], vcpus: 8, memoryGib: 24 };
    expect(instance_hourly(instance, [{ shape: 'VM.Standard.E5.Flex', vcpuHour: 0.015, gibHour: 0.002, currency: 'USD' }])).toBeCloseTo(0.168);
    expect(instance_hourly({ ...instance, vcpus: undefined }, [{ shape: 'VM.Standard.E5.Flex', vcpuHour: 1, gibHour: 1, currency: 'USD' }])).toBeNull();
    expect(instance_hourly(instance, [])).toBeNull();
    const volume: CloudVolume = { ...base, name: 'v', sizeGib: 200, attachedTo: null, boot: true, vpusPerGib: 120 };
    expect(volume_hourly(volume, SERVICE)).toBeCloseTo((200 * (0.0255 + 120 * 0.0017)) / HOURS_PER_MONTH);
    expect(volume_hourly({ ...volume, vpusPerGib: undefined }, SERVICE)).toBeCloseTo((200 * (0.0255 + 10 * 0.0017)) / HOURS_PER_MONTH);
    const balancer: CloudLoadBalancer = { ...base, name: 'lb', ips: [], shape: 'flexible', minimumMbps: 10 };
    expect(balancer_hourly(balancer, SERVICE)).toBeCloseTo(0.0123);
    expect(balancer_hourly({ ...balancer, minimumMbps: undefined }, SERVICE)).toBeCloseTo(0.0123);
    expect(money_words(1.234, 'USD')).toBe('$1.23');
    expect(money_words(1, 'EUR')).toBe('EUR 1.00');
    expect(money_words(0.0017, 'USD')).toBe('$0.0017');
    expect(money_words(0, 'USD')).toBe('$0.00');
  });
});

describe('a compartment\'s spend', () => {
  it('prices what bills, leaves out what is gone, and adds up an hour and so far', async () => {
    const spend = await spend_read(new FakeDriver(fakeCloud_sample()), 'ocid1.compartment.oc1..harbor', 'us-ashburn-1', NOW);
    expect(spend.items.map((item) => `${item.kind}:${item.name}`)).toEqual([
      'compute:node-0', 'compute:node-1', 'compute:node-2',
      'volumes:etcd-0', 'volumes:node-0 (Boot Volume)', 'volumes:node-1 (Boot Volume)', 'volumes:node-2 (Boot Volume)', 'volumes:spare',
      'load balancers:api', 'load balancers:apps',
    ]);
    expect(spend.unpriced).toBe(0);
    expect(spend.hourly).toBeCloseTo(spend.items.reduce((sum, item) => sum + (item.hourly ?? 0), 0));
    expect(spend.soFar).toBeCloseTo(spend.hourly * 24);
    expect(spend_line(spend)).toMatch(/^\$\d+\.\d\d an hour · \$\d+\.\d\d so far, at list price$/);
    const cloud = fakeCloud_sample();
    const unpriced = await spend_read(new FakeDriver({ ...cloud, servicePrices: null, prices: [] }), 'ocid1.compartment.oc1..harbor', 'us-ashburn-1', NOW);
    expect(unpriced.unpriced).toBe(10);
    expect(spend_line(unpriced)).toContain('(10 not priced)');
  });
});

describe('the price list\'s storage and balancer parts', () => {
  it('reads all four or says nothing', async () => {
    const parts: Map<string, number> = new Map([[SERVICE_PARTS.volumeGibMonth, 0.0255], [SERVICE_PARTS.vpuGibMonth, 0.0017], [SERVICE_PARTS.balancerHour, 0.0113], [SERVICE_PARTS.balancerMbpsHour, 0.0001]]);
    expect(servicePrices_map(parts)).toEqual(SERVICE);
    parts.delete(SERVICE_PARTS.balancerHour);
    expect(servicePrices_map(parts)).toBeNull();
    const item = (partNumber: string, value: number) => ({ partNumber, currencyCodeLocalizations: [{ currencyCode: 'USD', prices: [{ model: 'PAY_AS_YOU_GO', value }] }] });
    const read = await ociServicePrices_read(async () => ({ items: [item('B91961', 0.0255), item('B91962', 0.0017), item('B93030', 0.0113), item('B93031', 0.0001)] }));
    expect(read).toEqual(SERVICE);
    await expect(ociServicePrices_read(async () => ({}))).rejects.toThrow('no items');
  });
});

describe('spend', () => {
  const context_of = (sources: Array<{ name: string; root: string }>): ClusterCommandContext => {
    const clusters: ClusterTree = new ClusterTree({ sources, owner: (): string => 'r', now: (): Date => NOW });
    return { clusters, driver: new FakeDriver(fakeCloud_sample()), region: (): string => 'us-ashburn-1', clustersPath: (): string => '/d' };
  };

  it('prints each resource and the cluster\'s total, and says it is an estimate', async () => {
    const answer = await spend_run(context_of([{ name: 'harbor', root: harborCheckout_make() }]), []);
    const text: string = plain(answer.rendered);
    expect(text).toContain('compute         node-0');
    expect(text).toContain('load balancers  apps');
    expect(text).toMatch(/an hour · \$[\d.]+ so far, at list price/);
    expect(text).toContain('List prices: an estimate, not the bill.');
    expect(SPEND_HELP.category).toBe('Resources');
  });

  it('refuses an unknown cluster or option, and says when there is nothing to price', async () => {
    const context = context_of([{ name: 'harbor', root: harborCheckout_make() }]);
    expect((await spend_run(context, ['nope'])).renderedErr).toBe('spend: nope: no such cluster\n');
    expect((await spend_run(context, ['-x'])).renderedErr).toBe('spend: -x: unknown option\n');
    expect((await spend_run(context_of([]), [])).rendered).toBe('no clusters\n');
  });
});
