/**
 * @jest-environment jsdom
 */
/**
 * @file The stratus composition's tiles: CLUSTERS from `cluster status`, the
 * lead with a cluster gone wrong in red, and CAPACITY from `capacity`,
 * teaching the line that names a family when there is none.
 */
import { describe, it, expect } from '@jest/globals';
import { limitShort_format, money_text, stratusTiles_make, zoneShort_format, type StratusTileHooks } from '../../src/compositions/stratus/tiles.js';
import type { ExecuteOutcome } from '../../src/calypso/client.js';

const CLUSTERS = {
  clusters: [
    { name: 'harbor', path: '/net/oci/t/clusters/harbor', cluster: 'harbor.oci.example.org', lastDone: '09-run', steps: [{ folder: '03-iso', state: 'expired' }, { folder: '09-run', state: 'done' }], resources: { instances: 3 }, cost: { hourly: 0.6213, soFar: 210, currency: 'USD' } },
    { name: 'lab', path: '/net/oci/t/clusters/lab', cluster: null, lastDone: null, steps: [{ folder: '01-preflight', state: 'unknown' }], resources: null },
  ],
};
const CAPACITY = {
  region: 'us-ashburn-1',
  rows: [
    { family: 'E5', limit: 'standard-e5-core-count', zone: 'disG:US-ASHBURN-AD-1', value: 4629, used: 4, available: 4625 },
    { family: 'E5', limit: 'standard-e5-memory-count', zone: null, value: 100, used: null, available: null },
    { family: 'E5', limit: 'standard-e5-core-count', zone: 'disG:US-ASHBURN-AD-2', value: 10, used: 10, available: 0 },
  ],
};

/** The hooks, answering each line with a model or an error, and recording what was asked and opened. */
function hooks_make(answers: Record<string, unknown>, seen: string[], named: string[][] = []): StratusTileHooks {
  return {
    ask: async (line: string): Promise<ExecuteOutcome> => {
      const kind: string = line.startsWith('cluster') ? 'stratus.clusters' : 'stratus.capacity';
      const data: unknown = answers[line];
      return (data === undefined
        ? { envelopes: [{ status: 'error', rendered: '', renderedErr: `${line}: refused\n` }] }
        : { envelopes: [{ status: 'ok', rendered: '', model: { kind, data } }] }) as unknown as ExecuteOutcome;
    },
    cluster_open: (name: string): void => { seen.push(`cluster ${name}`); },
    home_open: (): void => { seen.push('home'); },
    line_run: (line: string): void => { seen.push(`run ${line}`); },
    capacity_open: (family: string): void => { seen.push(`capacity:${family}`); },
    names_seen: (names: string[]): void => { named.push(names); },
  };
}

describe('the stratus tiles', () => {
  it('a cluster found in the tenancy and not adopted reads its condition in place of a last step, and one with nothing left reads GONE and is counted apart', async () => {
    const found = { clusters: [
      { name: 'harbor', path: '/net/oci/t/clusters/harbor', cluster: 'harbor.oci.example.org', lastDone: null, steps: [], resources: null, origin: 'found', condition: 'UP' },
      { name: 'quay', path: '/net/oci/t/clusters/quay', cluster: null, lastDone: null, steps: [], resources: null, origin: 'found', condition: 'GONE' },
    ] };
    const tiles = await stratusTiles_make(hooks_make({ 'cluster status': found, capacity: CAPACITY }, [], []))();
    expect(tiles.lead!.tile.rows.map((r) => r.text)).toEqual(['harbor  UP · NOT ADOPTED  harbor.oci.example.org', 'quay  GONE']);
    expect(tiles.lead!.tile.figures.map((f) => f.text)).toEqual(['1 CLUSTER', '1 GONE']);
  });

  it('lead with CLUSTERS: each cluster\'s last step and cluster, red where a step went wrong, opening its folder', async () => {
    const seen: string[] = [];
    const named: string[][] = [];
    const tiles = await stratusTiles_make(hooks_make({ 'cluster status': CLUSTERS, capacity: CAPACITY }, seen, named))();
    // The paint tells the language the clusters, so `cluster harbor` opens the controller before it has read them.
    expect(named).toEqual([['harbor', 'lab']]);
    const clusters = tiles.lead!.tile;
    expect(tiles.lead!.weight).toBe(2);
    expect(clusters.name).toBe('OPENSHIFT');
    expect(clusters.figures.map((f) => [f.text, f.errored ?? false])).toEqual([['2 CLUSTERS', false], ['1 NEEDS A LOOK', true], ['$0.62/H', false]]);
    expect(clusters.rows.map((r) => [r.text, r.errored])).toEqual([['harbor  09-run  $0.62/h  harbor.oci.example.org', true], ['lab  NOTHING DONE', false]]);
    expect(money_text(1, 'EUR')).toBe('EUR 1.00');
    clusters.rows[0]!.open!();
    clusters.enter();
    expect(seen).toEqual(['cluster harbor', 'cluster ']);
    expect(tiles.about?.['files']?.text).toContain('the clusters this session knows');
  });

  it('place CAPACITY after FILES: per zone, free of permitted, red where nothing is free', async () => {
    const seen: string[] = [];
    const tiles = await stratusTiles_make(hooks_make({ 'cluster status': CLUSTERS, capacity: CAPACITY }, seen))();
    const capacity = tiles.afterFiles[0]!;
    expect(capacity.figures).toEqual([{ text: 'US-ASHBURN-1' }]);
    expect(capacity.rows.map((r) => [r.text, r.errored])).toEqual([
      ['E5  US-ASHBURN-AD-1  core  4625 / 4629 FREE', false],
      ['E5  REGION  memory  100 PERMITTED', false],
      ['E5  US-ASHBURN-AD-2  core  0 / 10 FREE', true],
    ]);
    // A row opens the CAPACITY pane on its family; the tile on every family (#1284).
    capacity.rows[0]!.open!();
    capacity.enter();
    expect(seen).toEqual(['capacity:E5', 'capacity:']);
  });

  it('say NONE with no clusters, and open the pane with nothing read', async () => {
    const seen: string[] = [];
    const tiles = await stratusTiles_make(hooks_make({ 'cluster status': { clusters: [] } }, seen))();
    expect(tiles.lead!.tile.figures).toEqual([{ text: 'NONE' }]);
    const capacity = tiles.afterFiles[0]!;
    expect(capacity.figures).toEqual([{ text: 'NOT READ' }]);
    capacity.rows[0]!.open!();
    expect(seen).toEqual(['capacity:']);
    const refused = await stratusTiles_make(hooks_make({}, []))();
    expect(refused.lead!.weight).toBe(0);
  });

  it('paints CLUSTERS without waiting on a slow capacity, and paints again when it lands', async () => {
    const seen: string[] = [];
    let capacity_answer: (answer: ExecuteOutcome) => void = (): void => {};
    const slow: Promise<ExecuteOutcome> = new Promise<ExecuteOutcome>((resolve: (answer: ExecuteOutcome) => void): void => { capacity_answer = resolve; });
    const asked: string[] = [];
    const base: StratusTileHooks = hooks_make({ 'cluster status': CLUSTERS, capacity: CAPACITY }, seen);
    const hooks: StratusTileHooks = {
      ...base,
      ask: (line: string): Promise<ExecuteOutcome> => { asked.push(line); return line === 'capacity' ? slow : base.ask(line); },
      repaint: (): void => { seen.push('repaint'); },
      capacityGraceMs: 20,
    };
    const source = stratusTiles_make(hooks);
    const first = await source();
    expect(first.lead!.tile.figures[0]).toEqual({ text: '2 CLUSTERS' });
    expect(first.afterFiles[0]!.figures).toEqual([{ text: 'READING' }]);
    expect(seen).toEqual([]);
    // A second paint while the first capacity is on its way asks for no second one.
    await source();
    expect(asked.filter((line: string): boolean => line === 'capacity')).toHaveLength(1);
    capacity_answer(await base.ask('capacity'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['repaint']);
    // The repaint's ask answers at once, and the tile reads the region.
    const painted = await source();
    expect(asked.filter((line: string): boolean => line === 'capacity')).toHaveLength(2);
    expect(painted.afterFiles[0]!.figures).toEqual([{ text: 'US-ASHBURN-1' }]);
  });

  it('shortens zones and limits to what a tile has room for', () => {
    expect(zoneShort_format('disG:US-ASHBURN-AD-1')).toBe('US-ASHBURN-AD-1');
    expect(zoneShort_format('us-east-1a')).toBe('us-east-1a');
    expect(zoneShort_format(null)).toBe('REGION');
    expect(limitShort_format({ family: 'A1', limit: 'standard-a1-memory-count', zone: null, value: 1, used: null, available: null })).toBe('memory');
    expect(limitShort_format({ family: 'GPU', limit: 'gpu-a10-count', zone: null, value: 1, used: null, available: null })).toBe('a10');
  });
});
