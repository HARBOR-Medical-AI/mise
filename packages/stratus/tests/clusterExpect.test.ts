/**
 * @file The `cluster` subject `expect` asks: a step's state, the last verify,
 * the cluster's class and what it costs an hour, read and never changed.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { ClusterStore, type ClusterRecord } from '../src/cluster/state.js';
import { SPEC_DEFAULT } from '../src/cluster/spec.js';
import { clusterExpectSubject_make } from '../src/cluster/expect.js';

const NOW: Date = new Date('2026-10-22T12:00:00Z');

describe('the cluster subject', () => {
  let root: string;
  let store: ClusterStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cluster-expect-'));
    store = new ClusterStore(join(root, 'clusters'));
    const record: ClusterRecord = {
      name: 'quay', created: NOW.toISOString(), region: 'us-ashburn-1', baseDomain: 'oci.chrisproject.org',
      steps: { run: { state: 'done' }, verify: { state: 'done', note: '10 of 10 pass' } }, ids: {},
      compartmentId: 'ocid1.compartment.oc1..harbor',
    };
    store.create(record, SPEC_DEFAULT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const subject = () => clusterExpectSubject_make({ store, driver: new FakeDriver(fakeCloud_sample()), now: (): Date => NOW });

  it('reads a step, the last verify and the class from the cluster\'s state', async () => {
    expect(await subject().read({ target: 'quay', property: 'step', words: ['run'], deep: false })).toEqual({ got: 'done' });
    expect(await subject().read({ target: 'quay', property: 'step', words: ['dns'], deep: false })).toEqual({ got: 'not done' });
    expect(await subject().read({ target: 'quay', property: 'verify', words: [], deep: false })).toEqual({ got: '10' });
    expect(await subject().read({ target: 'quay', property: 'class', words: [], deep: false })).toEqual({ got: 'built' });
  });

  it('prices the compartment, as spend does', async () => {
    const reading = await subject().read({ target: 'quay', property: 'cost', words: [], deep: false });
    expect(Number(reading.got)).toBeGreaterThan(0);
  });

  it('refuses a cluster it does not keep, and a verify never run, by name', async () => {
    expect((await subject().read({ target: 'pier', property: 'class', words: [], deep: false })).refusal).toBe('no cluster "pier" is kept in this session (kept: quay)');
    store.record_update('quay', (record: ClusterRecord): void => { delete record.steps['verify']; });
    expect((await subject().read({ target: 'quay', property: 'verify', words: [], deep: false })).refusal).toBe('quay has not been verified here yet: cluster verify quay');
  });
});
