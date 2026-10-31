/**
 * @file The TD controller's model: an event merged over a read, the steps
 * as drawn, the condition's line, SINCE LAST COMMAND, SIZE's fit and cost,
 * the line COMMIT sends, and which lines open the controller.
 */
import { describe, it, expect } from '@jest/globals';
import type { ClusterSizeModel, ClusterSpecModel, ClusterSummary } from '@fnndsc/menu';
import {
  askForm_derive, classBadge_render, conditionWhy_derive, controllerLine_parse, duration_text, nameRefusal_derive, newLine_build, noteShort_format, planWords_render,
  since_build, sizeCost_compute, sizeFit_compute, stepLooks_build, summary_merge, verifyWords_render, zoneShort_format,
} from '../../src/features/controller/model.js';

const SPEC: ClusterSpecModel = {
  family: 'E5',
  controlPlane: { count: 3, vcpu: 8, ramGib: 24, bootGib: 200, bootTier: 'ultra' },
  workers: { count: 0, vcpu: 8, ramGib: 32, bootGib: 120, bootTier: 'balanced' },
  chris: { dataGib: 20, databaseGib: 5, queueGib: 1 },
};

const cluster_make = (extra: Partial<ClusterSummary> = {}): ClusterSummary => ({
  name: 'quay', path: '/net/oci/fnndsc-bch/clusters/quay', cluster: 'quay.oci.example.org', lastDone: '05-infra-plan',
  steps: [
    { folder: '01-compartment', state: 'done', name: 'compartment', evidence: 'clusters/quay' },
    { folder: '02-infra-plan', state: 'done', name: 'infra-plan', evidence: '17 to create' },
    { folder: '03-infra-apply', state: 'not done', name: 'infra-apply', evidence: 'not run yet' },
    { folder: '04-dns', state: 'not done', name: 'dns', evidence: 'not run yet' },
  ],
  resources: { instances: 0 }, cost: { hourly: 0.71, soFar: 3, currency: 'USD' },
  condition: 'SIZING', billing: false, origin: 'built', protected: true, refused: {}, region: 'us-ashburn-1', compartment: 'ocid', gone: null,
  spec: SPEC, next: 'infra-apply', billingStep: 'infra-apply', running: null, plan: null, verify: null, asking: null,
  ...extra,
});

const SIZE: ClusterSizeModel = {
  region: 'us-ashburn-1', family: 'E5', families: ['E4', 'E5'], vcpuPerCore: 2, cores: { min: 1, max: 94 }, memoryGib: { min: 1, max: 1049 },
  zones: [{ zone: 'disG:US-ASHBURN-AD-1', coresFree: 100, memoryFree: 1000 }, { zone: 'disG:US-ASHBURN-AD-2', coresFree: 14, memoryFree: 1000 }, { zone: 'disG:US-ASHBURN-AD-3', coresFree: null, memoryFree: null }],
  price: { vcpuHour: 0.015, gibHour: 0.002, currency: 'USD' },
  services: { volumeGibMonth: 0.0255, vpuGibMonth: 0.0017, balancerHour: 0.0113, balancerMbpsHour: 0.0001 },
  start: SPEC, baseDomain: 'oci.example.org',
};

describe('the TD controller model', () => {
  it('merges an event over a read, keeping the counts and the cost an event lacks', () => {
    const read: ClusterSummary = cluster_make();
    const shown: ClusterSummary = { ...cluster_make({ condition: 'BUILDING', resources: null }), cost: undefined };
    const merged: ClusterSummary = summary_merge(read, shown);
    expect(merged.condition).toBe('BUILDING');
    expect(merged.resources).toEqual({ instances: 0 });
    expect(merged.cost).toEqual({ hourly: 0.71, soFar: 3, currency: 'USD' });
    expect(summary_merge(undefined, shown)).toBe(shown);
    expect(summary_merge(read, { ...shown, cost: null }).cost).toBeNull();
  });

  it('draws each step, the next one asking while the engine asks', () => {
    expect(stepLooks_build(cluster_make()).map((look) => `${look.n} ${look.name} ${look.word} ${look.tone}${look.billFrom ? ' $' : ''}`)).toEqual([
      '01 compartment DONE done', '02 infra-plan DONE done', '03 infra-apply NEXT next $', '04 dns NOT DONE later',
    ]);
    expect(stepLooks_build(cluster_make({ asking: 'Continue? [y/N]' }))[2]?.word).toBe('ASKING');
    const odd: ClusterSummary = cluster_make({ steps: [{ folder: '01-a', state: 'running' }, { folder: '02-b', state: 'failed' }, { folder: '03-c', state: 'expired' }, { folder: '04-d', state: 'unknown' }] });
    expect(stepLooks_build(odd).map((look) => `${look.name} ${look.tone}`)).toEqual(['a running', 'b failed', 'c expired', 'd unknown']);
    expect(noteShort_format('done before adoption (harbor-oci: done, Terraform state holds 79 resources)')).toBe('Terraform state holds 79 resources');
    expect(noteShort_format('x'.repeat(80))).toHaveLength(60);
  });

  it('says what a cluster is and whether money runs', () => {
    expect(classBadge_render(cluster_make({ origin: 'found' }))).toBe('FOUND · NOT ADOPTED');
    expect(classBadge_render(cluster_make({ origin: 'adopted' }))).toBe('ADOPTED · PLANS ONLY');
    expect(classBadge_render(cluster_make({ origin: 'checkout' }))).toBe('CHECKOUT · READ ONLY');
    expect(classBadge_render(cluster_make({ gone: '2026-10-23' }))).toBe('TORN DOWN');
    expect(classBadge_render(cluster_make())).toBe('BUILT HERE');
    expect(conditionWhy_derive(cluster_make())).toEqual({ text: 'NOTHING BUILT · NOTHING BILLED', billing: false });
    expect(conditionWhy_derive(cluster_make({ origin: 'adopted', billing: true, condition: 'UP' }))).toEqual({ text: 'BILLING · ADOPTED', billing: true });
    expect(conditionWhy_derive(cluster_make({ billing: true, condition: 'BUILDING' }))).toEqual({ text: 'BILLING · BUILDING', billing: true });
    expect(conditionWhy_derive(cluster_make({ condition: 'STOPPED', next: 'infra-apply', billingStep: 'infra-apply' }))).toEqual({ text: 'PLANNED · NOTHING BILLED', billing: false });
    expect(conditionWhy_derive(cluster_make({ condition: 'STOPPED', next: 'iso', billingStep: 'infra-apply' }))).toEqual({ text: 'NOT FINISHED · NOTHING BILLED', billing: false });
    expect(conditionWhy_derive(cluster_make({ condition: 'STOPPED', billing: true, next: 'dns', billingStep: 'infra-apply' }))).toEqual({ text: 'BILLING · NOT FINISHED', billing: true });
  });

  it('says what changed since the last command, at most three rows', () => {
    const before: ClusterSummary = cluster_make();
    expect(since_build(null, before)).toEqual([{ label: '', text: 'FIRST READ' }]);
    expect(since_build(before, before)).toEqual([{ label: '', text: 'NO CHANGE' }]);
    const after: ClusterSummary = cluster_make({
      condition: 'BUILDING',
      steps: before.steps.map((step) => step.name === 'infra-apply' ? { ...step, state: 'running' } : step),
      verify: { at: null, checks: [{ name: 'API', ok: true, detail: '', how: 'reads' }] },
    });
    expect(since_build(before, after)).toEqual([
      { label: 'CONDITION', text: 'SIZING → BUILDING' },
      { label: 'INFRA-APPLY', text: 'NOT DONE → RUNNING' },
      { label: 'VERIFY', text: '1 OF 1 PASS' },
    ]);
    expect(since_build(before, cluster_make({ protected: false }))).toEqual([{ label: 'LOCK', text: 'OFF' }]);
    expect(since_build(before, cluster_make({ cost: { hourly: 1.2, soFar: 3, currency: 'USD' } }))).toEqual([{ label: 'PER HOUR', text: '$0.71 → $1.20' }]);
  });

  it('says verify and a plan in a phrase, drift apart', () => {
    expect(verifyWords_render([{ ok: true }, { ok: false }, { ok: null }])).toBe('1 OF 3 PASS · 1 FAIL · 1 NOT RUN');
    expect(planWords_render({ create: 52, replace: 0, change: 0, drift: 0, destroy: 0, groups: [], at: null })).toBe('52 + · 0 ~ · 0 −');
    expect(planWords_render({ create: 0, replace: 0, change: 0, drift: 6, destroy: 0, groups: [], at: null })).toBe('0 + · 6 ~ TAG DRIFT · 0 −');
    expect(planWords_render({ create: 0, replace: 21, change: 0, drift: 24, destroy: 0, groups: [], at: null })).toBe('0 + · 21 ~ · 24 ~ TAG DRIFT · 0 −');
  });

  it('fits a spec per zone, the tightest marked, unknown where the cloud does not say', () => {
    const fits = sizeFit_compute(SIZE, { ...SPEC, workers: { ...SPEC.workers, count: 2 } }, 'quay');
    expect(fits.map((fit) => [zoneShort_format(fit.zone), fit.nodes, fit.coresNeeded, fit.fits, fit.tightest])).toEqual([
      ['AD-1', ['quay-cp-0', 'quay-w-0'], 8, true, false],
      ['AD-2', ['quay-cp-1', 'quay-w-1'], 8, true, true],
      ['AD-3', ['quay-cp-2'], 4, null, false],
    ]);
    expect(sizeFit_compute(SIZE, { ...SPEC, controlPlane: { ...SPEC.controlPlane, vcpu: 32 } }, 'q')[1]?.fits).toBe(false);
  });

  it('prices a spec by what bills, and says what is not priced', () => {
    const cost = sizeCost_compute(SIZE, SPEC);
    expect(cost.rows.map((row) => row.what)).toEqual(['COMPUTE · 24 vCPU', 'MEMORY · 72 GiB', 'BOOT VOLUMES · 600 GiB', 'CHRIS VOLUMES · 26 GiB', 'LOAD BALANCERS · 3']);
    expect(cost.rows[0]?.hourly).toBeCloseTo(0.36);
    expect(cost.rows[1]?.hourly).toBeCloseTo(0.144);
    expect(cost.rows[2]?.hourly).toBeCloseTo((600 * (0.0255 + 30 * 0.0017)) / 730);
    expect(cost.rows[4]?.hourly).toBeCloseTo(3 * (0.0113 + 10 * 0.0001));
    expect(cost.hourly).toBeCloseTo(cost.rows.reduce((sum, row) => sum + (row.hourly ?? 0), 0));
    const unpriced = sizeCost_compute({ ...SIZE, price: null, services: null }, SPEC);
    expect(unpriced.hourly).toBeNull();
    expect(unpriced.rows.every((row) => row.hourly === null)).toBe(true);
  });

  it('commits a spec as cluster new with only what differs from the start', () => {
    expect(newLine_build('quay', SPEC, SPEC)).toBe('cluster new quay');
    expect(newLine_build('quay', { ...SPEC, family: 'E4', workers: { ...SPEC.workers, count: 2 }, chris: { dataGib: 100, databaseGib: 10, queueGib: 2 } }, SPEC))
      .toBe('cluster new quay --family E4 --workers 2x8/32 --data 100 --database 10 --queue 2');
    expect(newLine_build('quay', { ...SPEC, controlPlane: { ...SPEC.controlPlane, vcpu: 16 } }, SPEC)).toBe('cluster new quay --plane 3x16/24');
    expect(nameRefusal_derive('', [])).toBe('NAME IT FIRST');
    expect(nameRefusal_derive('Quay', [])).toContain('DNS LABEL');
    expect(nameRefusal_derive('harbor', ['harbor'])).toBe('HARBOR IS TAKEN');
    expect(nameRefusal_derive('quay', ['harbor'])).toBeNull();
  });

  it('knows its own lines and its questions', () => {
    expect(controllerLine_parse('cluster', [])).toBe('');
    expect(controllerLine_parse('cluster quay', ['quay'])).toBe('quay');
    expect(controllerLine_parse('cluster status', ['quay'])).toBeNull();
    expect(controllerLine_parse('cluster plan quay', ['quay'])).toBeNull();
    expect(controllerLine_parse('ls', ['quay'])).toBeNull();
    expect(askForm_derive('infra-apply creates 17 resources. Continue? [y/N]')).toBe('yes-no');
    expect(askForm_derive("Type the cluster's name to go on:")).toBe('typed');
    expect(duration_text(42_000)).toBe('42s');
    expect(duration_text(12 * 60_000)).toBe('12m');
    expect(duration_text(190 * 60_000)).toBe('3h 10m');
    expect(duration_text(52 * 3_600_000)).toBe('2d 4h');
  });
});
