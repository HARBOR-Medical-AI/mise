/**
 * @file `capacity`: the limits a shape family draws on, per zone, free and
 * permitted, with the model the CAPACITY tile draws.
 */
import { describe, it, expect } from '@jest/globals';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { capacity_run, capacityRows_read, specFamily_parse, CAPACITY_HELP } from '../src/commands/capacity.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { harborCheckout_make } from './support/harborCheckout.js';
import { AnswerCache } from '../src/cache.js';

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const context_make = (roots: Record<string, string>, region: string | null = 'us-ashburn-1') => ({
  clusters: new ClusterTree({ sources: Object.entries(roots).map(([name, root]) => ({ name, root })), owner: (): string => 'rudolph', now: (): Date => new Date('2026-10-21T12:00:00Z') }),
  driver: new FakeDriver(fakeCloud_sample()),
  region: (): string | null => region,
});

describe('capacity', () => {
  it('reads the family a spec names', () => {
    expect(specFamily_parse('# spec\nfamily: E5   # every node\n')).toBe('E5');
    expect(specFamily_parse('controlPlane:\n  count: 3\n')).toBeNull();
    expect(specFamily_parse(null)).toBeNull();
  });

  it('reads each limit a family\'s shapes draw on at every zone, free where the cloud says', async () => {
    const rows = await capacityRows_read(new FakeDriver(fakeCloud_sample()), 'us-ashburn-1', ['e5']);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ family: 'e5', limit: 'standard-e5-core-count', zone: 'Uocm:US-ASHBURN-AD-1', value: 9250, used: 12, available: 9238 });
    expect(rows[1]).toEqual({ family: 'e5', limit: 'standard-e5-core-count', zone: 'Uocm:US-ASHBURN-AD-2', value: 9250, used: null, available: null });
    expect(await capacityRows_read(new FakeDriver(fakeCloud_sample()), 'us-ashburn-1', ['Z9'])).toEqual([]);
  });

  it('keeps what it read: the second ask reads the cloud nothing, and the rows are the same', async () => {
    const driver = new FakeDriver(fakeCloud_sample());
    const cache = new AnswerCache(60_000);
    const first = await capacityRows_read(driver, 'us-ashburn-1', ['e5'], cache);
    const asked = { ...driver.calls };
    expect(asked['limitAvailability_get']).toBe(6);
    const second = await capacityRows_read(driver, 'us-ashburn-1', ['e5'], cache);
    expect(second).toEqual(first);
    expect(driver.calls).toEqual(asked);
    // Without a cache every ask reads the cloud again.
    await capacityRows_read(driver, 'us-ashburn-1', ['e5']);
    expect(driver.calls['limitAvailability_get']).toBe(12);
    // A line's ask keeps through the session's cache too.
    const context = { ...context_make({}), driver, cache };
    await capacity_run(context, ['E5']);
    await capacity_run(context, ['E5']);
    expect(driver.calls['limitAvailability_get']).toBe(12);
  });

  it('takes the families the clusters\' specs name, and answers lines with the model', async () => {
    const answer = await capacity_run(context_make({ harbor: harborCheckout_make() }), []);
    const lines = plain(answer.rendered).split('\n');
    expect(lines[0]).toBe('capacity in us-ashburn-1');
    expect(lines[1]).toBe('E5    standard-e5-core-count    Uocm:US-ASHBURN-AD-1  9238 of 9250 free');
    expect(lines[2]).toBe('E5    standard-e5-core-count    Uocm:US-ASHBURN-AD-2  9250 permitted, use not reported');
    expect(answer.model?.kind).toBe('stratus.capacity');
    expect((answer.model?.data as { region: string; rows: unknown[] }).rows).toHaveLength(6);
  });

  it('takes families named, says when none has limits, and refuses with no family or no connection', async () => {
    const named = await capacity_run(context_make({}), ['E5']);
    expect(plain(named.rendered).split('\n')).toHaveLength(8);
    const none = await capacity_run(context_make({}), ['Z9']);
    expect(none.rendered).toBe('capacity in us-ashburn-1: no limits for Z9\n');
    // No family named and no spec naming one: every family the region offers.
    const every = await capacity_run(context_make({}), []);
    expect(every.renderedErr ?? '').toBe('');
    expect(plain(every.rendered)).toContain('capacity in us-ashburn-1');
    expect((every.model?.data as { rows: Array<{ family: string }> }).rows.some((row) => row.family === 'E5')).toBe(true);
    expect((await capacity_run(context_make({}, null), ['E5'])).renderedErr).toBe('capacity: not connected\n');
    expect(CAPACITY_HELP.category).toBe('Resources');
  });
});
