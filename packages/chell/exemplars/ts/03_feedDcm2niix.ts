/**
 * @file Exemplar 03 — feed with a DICOM → NIfTI analysis.
 *
 * The canonical ChRIS workflow, end to end: stage an MR image series from
 * PACS (pull it unless it is already in CUBE), root a feed on it with
 * pl-dircopy, chain pl-dcm2niix onto that node, wait for the job, and
 * verify NIfTI output landed in the feed's tree.
 *
 * The cleanup plan deletes the feed, the run's PACSQueries, and — when
 * the series was pulled fresh — the DICOM files, so the CUBE ends the run
 * exactly as it began.
 *
 * Requires CUBE_ADMIN_USER/CUBE_ADMIN_PASSWORD for PACS cleanup.
 *
 *   node exemplars/ts/dist/03_feedDcm2niix.js
 *
 * @module
 */

import {
  ChRISFeed, ChRISPlugin, feed_delete, listData_get, shape_build,
  Result, Ok, Err, Dictionary, PluginInstance, SimpleRecord, Client,
} from '@fnndsc/cumin';
import { job_statusFetch, job_logFetch, vfsDispatcher, type VFSItem } from '@fnndsc/salsa';
import {
  env_load, adminEnv_require, pacsFixture_require, config_isolate, cube_connect, connection_active,
  check, step, section, summary_exit, poll_until, runId_make, restToken_get,
  folder_deleteAndConfirm, pacsQuery_deleteById, CleanupPlan, CubeEnv,
} from './lib/harness.js';
import {
  query_createAndWait, series_findInDecode, series_locateInCube, series_pull,
  QueryOutcome, SeriesTarget, SeriesLocation,
} from './lib/pacs.js';

/** Series description marker of a small MR image series in the test study. */
const IMAGE_SERIES_MARKER: string = 'SAG T1';
/** Terminal CUBE job states. */
const TERMINAL_STATES: string[] = ['finishedSuccessfully', 'finishedWithError', 'cancelled'];
/**
 * Canonical dcm2niix arguments, matching the settings routinely used on
 * production CUBEs (compressed NIfTI, BIDS sidecar, no cropping). The
 * plugin's bare defaults fail on typical series.
 */
const DCM2NIIX_PARAMS: Record<string, string> = {
  b: 'y', f: '%3s_%d_%c', m: '0', v: '0', x: 'n', z: 'y', d: '5',
};

/**
 * Resolves the highest registered version of a plugin by exact name;
 * CUBE_DCM2NIIX_VERSION pins a specific one.
 *
 * @param name - Exact plugin name (e.g. `pl-dcm2niix`).
 * @returns The plugin id.
 */
async function pluginNewest_resolve(name: string): Promise<Result<number>> {
  const client: Client | null = await connection_active().client_get();
  if (!client) return Err();

  const plugins: Array<{ id: number; version: string }> =
    listData_get(await client.getPlugins({ name_exact: name, limit: 50 }), shape_build<{ id: number; version: string }>('a plugin')(['id', 'number'], ['version', 'string']));
  if (plugins.length === 0) return Err();

  const wanted: string | undefined = process.env.CUBE_DCM2NIIX_VERSION;
  const pinned: { id: number; version: string } | undefined =
    wanted ? plugins.find((p) => p.version === wanted) : undefined;
  const newest: { id: number; version: string } = [...plugins].sort(
    (a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }),
  )[0];
  const chosen: { id: number; version: string } = pinned ?? newest;
  console.log(`  (using ${name} v${chosen.version})`);
  return Ok(chosen.id);
}

/**
 * Polls a plugin instance until it reaches a terminal state; on failure,
 * prints the job log tail so the run is diagnosable from its output.
 *
 * @param instanceId - The plugin instance id.
 * @returns Ok when the job finished successfully.
 */
async function job_awaitSuccess(instanceId: number): Promise<Result<string>> {
  const finalState: Result<string> = await poll_until<string>(async () => {
    const status: Result<string> = await job_statusFetch(instanceId);
    return status.ok && TERMINAL_STATES.includes(status.value) ? status.value : null;
  }, 600_000, 5_000);

  if (finalState.ok && finalState.value === 'finishedSuccessfully') return finalState;

  const log: Result<string> = await job_logFetch(instanceId);
  if (log.ok) console.log(`  --- job log tail ---\n${log.value.slice(-1_500)}`);
  return Err();
}

/**
 * Ensures the image series is in CUBE, pulling it when absent.
 *
 * @param env - The CUBE environment.
 * @param cleanup - The cleanup plan (pull query + fresh files register here).
 * @param target - The series to stage.
 * @returns The series location in CUBE storage.
 */
async function series_stage(
  env: CubeEnv,
  cleanup: CleanupPlan,
  target: SeriesTarget,
): Promise<Result<SeriesLocation>> {
  const preexisting: SeriesLocation | null = await series_locateInCube(target.seriesUID);
  if (preexisting) {
    console.log(`  (series already in CUBE at ${preexisting.folderPath})`);
    return Ok(preexisting);
  }

  const pulled: Result<SeriesLocation> = await series_pull(
    env.pacs, target, `${runId_make()}-pull`,
    (queryId: number) => cleanup.register(`deleted PACSQuery ${queryId}`, async () => {
      const token: string = await restToken_get(env.url, env.user, env.password);
      return pacsQuery_deleteById(env.url, token, queryId);
    }),
  );
  if (!pulled.ok) return Err();

  cleanup.register('deleted the freshly pulled series folder (admin)', async () => {
    const adminToken: string = await restToken_get(env.url, env.adminUser!, env.adminPassword!);
    return folder_deleteAndConfirm(env.url, adminToken, pulled.value.folderPath);
  });
  return pulled;
}

/**
 * Roots a feed on the series folder with pl-dircopy.
 *
 * @param cleanup - The cleanup plan (feed deletion registers here).
 * @param folderPath - CUBE path of the staged series.
 * @returns The pl-dircopy instance id (the parent node for the analysis).
 */
async function feed_root(cleanup: CleanupPlan, folderPath: string): Promise<Result<number>> {
  const feed: ChRISFeed = new ChRISFeed();
  const detail: SimpleRecord | null = await feed.createFromDirs(folderPath, { params: '' });
  if (!check('feed created from the series directory', detail !== null) || !detail) return Err();

  const feedId: number = Number(detail.id);
  cleanup.register(`deleted feed ${feedId}`, async () => (await feed_delete(feedId)).ok);

  const plugin: ChRISPlugin = new ChRISPlugin();
  const dircopyDict: Dictionary | null = plugin.pluginInstance_convertToDict(detail.pluginInstance as PluginInstance);
  const dircopyId: number = Number(dircopyDict?.id);
  if (!check('dircopy instance id resolved', Number.isFinite(dircopyId))) return Err();
  return Ok(dircopyId);
}

/**
 * Runs pl-dcm2niix on the parent node and verifies NIfTI output.
 *
 * @param parentId - The plugin instance to chain onto.
 * @param runId - Run tag for the instance title.
 */
async function analysis_runAndVerify(parentId: number, runId: string): Promise<void> {
  const dcm2niixId: Result<number> = await pluginNewest_resolve('pl-dcm2niix');
  if (!check('pl-dcm2niix is registered', dcm2niixId.ok) || !dcm2niixId.ok) return;

  const plugin: ChRISPlugin = new ChRISPlugin();
  const instance: PluginInstance | undefined | null = await plugin.plugin_runOnCUBE(
    dcm2niixId.value, parentId, { title: `${runId}-dcm2niix`, ...DCM2NIIX_PARAMS },
  );
  if (!check('dcm2niix instance created', !!instance) || !instance) return;

  const instanceDict: Dictionary | null = plugin.pluginInstance_convertToDict(instance);
  const instanceId: number = Number(instanceDict?.id);
  const finished: Result<string> = await step('dcm2niix finished successfully', job_awaitSuccess(instanceId));
  if (!finished.ok) return;

  section('verify NIfTI output');
  const outputPath: string = String(instanceDict?.output_path ?? '');
  if (!check('instance reports an output path', outputPath.length > 0)) return;

  const listing: Result<VFSItem[]> = await step('listed the output directory', vfsDispatcher.list(`/${outputPath}`));
  if (!listing.ok) return;
  const hasNii: boolean = listing.value.some((item: { name: string }) => item.name.includes('.nii'));
  check('output contains a NIfTI file', hasNii);
}

/**
 * Stage → feed → analysis → verify, registering every undo on the plan.
 *
 * @param env - The CUBE environment.
 * @param cleanup - Undo actions, registered as resources are created.
 */
async function scenario_run(env: CubeEnv, accession: string, cleanup: CleanupPlan): Promise<void> {
  const runId: string = runId_make();

  section(`stage the '${IMAGE_SERIES_MARKER}' series from PACS`);
  const queried: Result<QueryOutcome> = await step(
    'query completed',
    query_createAndWait(env.pacs, { AccessionNumber: accession }, `${runId}-query`),
  );
  if (!queried.ok) return;
  cleanup.register(`deleted PACSQuery ${queried.value.queryId}`, async () => {
    const token: string = await restToken_get(env.url, env.user, env.password);
    return pacsQuery_deleteById(env.url, token, queried.value.queryId);
  });

  const target: Result<SeriesTarget> = series_findInDecode(
    queried.value.decoded,
    (d: string) => d.includes(IMAGE_SERIES_MARKER),
  );
  if (!check(`found the '${IMAGE_SERIES_MARKER}' series`, target.ok) || !target.ok) return;

  const staged: Result<SeriesLocation> = await series_stage(env, cleanup, target.value);
  if (!check('series staged in CUBE', staged.ok) || !staged.ok) return;

  // tag::feedRun[]
  section('feed: pl-dircopy on the series folder');
  const parentId: Result<number> = await feed_root(cleanup, staged.value.folderPath);
  if (!parentId.ok) return;

  section('analysis: pl-dcm2niix');
  await analysis_runAndVerify(parentId.value, runId);
  // end::feedRun[]
}

/**
 * Program entry: connect, run the scenario, always run cleanup.
 */
async function main(): Promise<void> {
  const env: CubeEnv = env_load();
  adminEnv_require(env);
  const accession: string = pacsFixture_require(env);
  config_isolate();
  await cube_connect(env);

  const cleanup: CleanupPlan = new CleanupPlan();
  try {
    await scenario_run(env, accession, cleanup);
  } finally {
    section('cleanup — restore the CUBE');
    await cleanup.run();
  }
  summary_exit();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
