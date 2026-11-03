/**
 * @file A cluster's teardown, its first form (docs/stratus.adoc, D6, decided
 * 2026-10-22): what this daemon built, removed, and nothing else.
 *
 * The stack's own resources go by a destroy job; then the cluster's DNS
 * records, the discovery image and its link, the volumes the cluster's CSI
 * driver made for its claims (which the stack never knew), and the
 * installer's records. The CSI volumes are named by the cluster itself, read
 * from its PersistentVolumes before the destroy: OCI's attribution tag on them
 * is the same for every cluster, so it cannot say whose they are.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { KubeApi } from '../kube/kube.js';
import { EARLIER_PASS, teardownStep_run, type CloudBuilder, type TeardownCall, type TeardownStep, type TeardownStepState } from '../cloud/builder.js';
import type { Installer } from '../installer/installer.js';
import type { ClusterRecord, ClusterStore, TeardownStepRecord } from './state.js';

/** The CSI driver whose volumes are the cloud's block volumes. */
export const OCI_BLOCK_DRIVER: string = 'blockvolume.csi.oraclecloud.com';

/**
 * The block volumes a cluster's claims hold, from its PersistentVolumes.
 *
 * @param kube - The cluster.
 * @returns The volumes' ids.
 */
export async function clusterVolumes_read(kube: KubeApi): Promise<string[]> {
  const answer = await kube.json_get('/api/v1/persistentvolumes') as { items?: Array<{ spec?: { csi?: { driver?: string; volumeHandle?: string } } }> };
  return (answer.items ?? [])
    .filter((volume): boolean => volume.spec?.csi?.driver === OCI_BLOCK_DRIVER && typeof volume.spec.csi.volumeHandle === 'string')
    .map((volume): string => volume.spec?.csi?.volumeHandle as string);
}

/**
 * The job that tears a cluster down.
 *
 * @param store - The clusters.
 * @param builder - The cloud's build half.
 * @param installer - The installer, or null when none is reachable.
 * @param name - The cluster.
 * @param volumeIds - The cluster's own volumes, read before.
 * @param done - The steps an earlier pass finished: passed over, not asked for again.
 * @param shown - Called as each step begins and ends, the record written: a surface watching redraws.
 * @returns The job's work.
 */
export function teardownRun_make(store: ClusterStore, builder: CloudBuilder, installer: Installer | null, name: string, volumeIds: ReadonlyArray<string>, done: ReadonlySet<TeardownStep> = new Set(), shown: () => void = (): void => undefined): JobRun {
  return async (context: JobContext): Promise<void> => {
    const record: ClusterRecord | null = store.record_read(name);
    if (record === null) throw new Error(`${name}: no such cluster`);
    if (builder.teardown_run === undefined) throw new Error(`${builder.id}: this cloud cannot tear a cluster down`);
    const now = (): string => new Date().toISOString();
    // Each step lands on the record as it begins and ends, so a stopped teardown reads as such and resumes from the
    // first step not done, and the state is shown each time.
    store.record_update(name, (current: ClusterRecord): void => { current.teardown = { started: current.teardown?.started ?? now(), steps: { ...(current.teardown?.steps ?? {}) } }; });
    shown();
    const step = (stepName: TeardownStep, state: TeardownStepState, note?: string): void => {
      store.record_update(name, (current: ClusterRecord): void => {
        const steps: Record<string, TeardownStepRecord> = current.teardown?.steps ?? {};
        const was: TeardownStepRecord = steps[stepName] ?? { state };
        // A step an earlier pass finished keeps that pass's time and words; the pass over it is only logged.
        if (note === EARLIER_PASS && was.state === 'done') return;
        steps[stepName] = { ...was, state, ...(state === 'running' ? { started: now() } : { ended: now() }), ...(note !== undefined ? { note } : {}) };
        current.teardown = { started: current.teardown?.started ?? now(), steps };
      });
      if (state !== 'running') context.log_write(`${stepName}: ${state}${note !== undefined ? ` (${note})` : ''}`);
      shown();
    };
    const call: TeardownCall = { log: (line: string): void => context.log_write(line), signal: context.signal, step, done };
    const gone: string[] = await builder.teardown_run({
      cluster: name, region: record.region, compartmentId: record.compartmentId ?? '', baseDomain: record.baseDomain, volumeIds,
      ...(record.ids['stackRef'] !== undefined ? { stackRef: record.ids['stackRef'] } : {}),
      ...(record.ids['isoObject'] !== undefined ? { isoObject: record.ids['isoObject'] } : {}),
      ...(record.ids['isoLinkId'] !== undefined ? { isoLinkId: record.ids['isoLinkId'] } : {}),
    }, call);
    if (context.signal.aborted) return;
    const installed: string | null = await teardownStep_run(call, 'installer', async (): Promise<string | null> => {
      if (installer === null || record.ids['clusterId'] === undefined || record.ids['infraEnvId'] === undefined) return null;
      await installer.cluster_delete({ clusterId: record.ids['clusterId'], infraEnvId: record.ids['infraEnvId'] });
      return 'the installer\'s cluster and infra-env';
    });
    if (installed !== null) gone.push(installed);
    store.record_update(name, (current: ClusterRecord): void => { current.gone = now(); });
    context.log_write(`gone: ${gone.join('; ')}`);
  };
}
