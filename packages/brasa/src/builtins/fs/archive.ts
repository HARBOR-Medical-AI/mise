/**
 * @file Archiving a directory so it can leave CUBE as one file.
 *
 * CUBE serves a file's bytes but has no representation of a directory, so a
 * client that wants a copy of a tree must build one. The platform's own answer
 * is a registered pipeline — `pl-dircopy` into a zip plugin — and using it is
 * right: making an archive is a computation, and computations here are
 * plugins. What is wrong is where that orchestration has historically lived.
 * The ChRIS web UI carried it in a saga, so no other client could reuse it,
 * and a presentation layer became an orchestrator. Here it is an intent, in
 * the kernel, reached identically by every surface.
 *
 * The cost is real and worth stating: an archive run creates a feed, so the
 * compute graph records a copy as though it were an analysis step. That is a
 * CUBE gap, filed as issue #233, not a design choice — the day CUBE can hand
 * over a directory, this module is deleted.
 *
 * @module
 */

import chalk from 'chalk';
import {
  feed_create,
  files_listRecursive,
  job_statusFetch,
  feed_delete,
  pipeline_readiness,
  pipeline_run,
  type FeedCreationResult,
  type PipelineReadiness,
  type FsItem,
} from '@fnndsc/salsa';
import type { WorkflowResult } from '@fnndsc/cumin';
import { sink_get } from '../../core/sink.js';
import { vfs } from '../../lib/vfs/vfs.js';
import type { ListingItem } from '@fnndsc/menu';
import { errorStack, type Result } from '@fnndsc/fond';

/**
 * The registered pipeline that produces the archive.
 *
 * Named rather than assembled: a pipeline is the platform's unit of composed
 * work and is what a deployment actually registers. `CHRIS_ARCHIVE_PIPELINE`
 * overrides it, because the name carries a version stamp and a given CUBE may
 * have registered a different one.
 */
const ARCHIVE_PIPELINE: string = process.env['CHRIS_ARCHIVE_PIPELINE'] ?? 'zip v20240311';

/** How often the archive job's status is checked, in milliseconds. */
const POLL_INTERVAL_MS: number = 2000;

/** How long to wait before giving up on the archive job, in milliseconds. */
const POLL_TIMEOUT_MS: number = 15 * 60 * 1000;

/** Terminal job states, successful or not. */
const SETTLED: readonly string[] = [
  'finishedSuccessfully', 'finishedWithError', 'cancelled',
];

/**
 * The archive a run produced.
 *
 * @property path - The archive's path in the session's namespace.
 * @property filename - Its basename, for a surface to suggest at the destination.
 * @property size - Its size in bytes, when the listing reported one.
 */
export interface ArchiveResult {
  path: string;
  filename: string;
  size?: number;
}

/**
 * Waits for a plugin instance to reach a terminal state.
 *
 * @param instanceId - The instance to watch.
 * @param label - What to call it while reporting progress.
 * @returns The terminal status, or null when it never settled.
 */
async function instance_settle(instanceId: number, label: string): Promise<string | null> {
  const deadline: number = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status: Result<string> = await job_statusFetch(instanceId);
    if (status.ok && SETTLED.includes(status.value)) {
      return status.value;
    }
    sink_get().progress_write({
      operation: 'task',
      kind: 'inspection',
      phase: 'working',
      label: `${label} — ${status.ok ? status.value : 'waiting'}`,
    });
    await new Promise<void>((resolve): void => { setTimeout(resolve, POLL_INTERVAL_MS); });
  }
  return null;
}

/**
 * Archives a directory into a single file inside CUBE.
 *
 * Announces what it is doing, because it is a workaround and a silent one
 * would leave the operator wondering why a feed appeared: see
 * link:../../../../docs/CUBE-gaps.adoc[CUBE-gaps.adoc].
 *
 * @param directory - The directory to archive, already resolved.
 * @returns The archive, or null when the run could not complete. Reasons are
 *   pushed to the error stack.
 */
export async function directory_archive(directory: string): Promise<ArchiveResult | null> {
  const name: string = directory.split('/').filter(Boolean).pop() ?? 'archive';

  const bin: Result<ListingItem[]> = await vfs.data_get('/bin');
  if (!bin.ok || !bin.value.some((item: ListingItem): boolean => item.name.startsWith('pl-dircopy'))) {
    errorStack.stack_push('error',
      'pl-dircopy is not registered on this CUBE, so no feed can be created and no directory archived.');
    return null;
  }

  // Ask whether the pipeline can run before creating anything. Preparing it
  // needs no feed, and a feed created for a run that never happens is litter
  // on someone's CUBE that nobody knows to clean up.
  const readiness: PipelineReadiness = await pipeline_readiness(ARCHIVE_PIPELINE);
  if (!readiness.ready) {
    errorStack.stack_push('error', readiness.reason === 'unregistered'
      ? `The '${ARCHIVE_PIPELINE}' pipeline is not registered on this CUBE, so a directory cannot be archived. ` +
        'Register it from the ChRIS store, or set CHRIS_ARCHIVE_PIPELINE to one that is.'
      : `The '${ARCHIVE_PIPELINE}' pipeline is registered but cannot run here — see the reason above, which is ` +
        'usually a node not registered on the target compute environment. Fix that, or set ' +
        'CHRIS_ARCHIVE_PIPELINE to a pipeline that can run.');
    return null;
  }

  sink_get().status_write(
    `${chalk.yellow('⚠ CUBE cannot hand over a directory, so this runs the ')}` +
    `${chalk.bold(ARCHIVE_PIPELINE)}${chalk.yellow(' pipeline to make an archive first.')}\n` +
    `${chalk.gray('  That creates a feed. See docs/CUBE-gaps.adoc and issue 233.')}\n`,
  );

  const feed: FeedCreationResult | null = await feed_create([directory], { title: `Archive of ${name}` });
  if (!feed) {
    errorStack.stack_push('error', `Could not create a feed to archive ${directory}.`);
    return null;
  }
  const dircopyId: number = feed.pluginInstance.data.id;

  const workflow: Result<WorkflowResult> = await pipeline_run(ARCHIVE_PIPELINE, dircopyId);
  if (!workflow.ok || workflow.value.pluginInstanceIds.length === 0) {
    // Readiness passed, so this failed between then and now. Say what was left
    // behind rather than overwriting a reason the stack already carries.
    await feed_discard(feed.id, name);
    return null;
  }

  const archiveInstanceId: number = workflow.value.pluginInstanceIds[0];
  const status: string | null = await instance_settle(archiveInstanceId, `Archiving ${name}`);
  sink_get().progress_write({ operation: 'task', kind: 'inspection', phase: 'complete' });

  if (status === null) {
    errorStack.stack_push('error', `Archiving ${name} did not finish within the time allowed.`);
    // The run may yet finish, so its feed is left alone rather than deleted
    // out from under a job that is still going.
    return null;
  }
  if (status !== 'finishedSuccessfully') {
    errorStack.stack_push('error', `Archiving ${name} ended as ${status}.`);
    await feed_discard(feed.id, name);
    return null;
  }

  return archiveOutput_find(feed.id, dircopyId, archiveInstanceId, name);
}

/**
 * Removes a feed created for an archive run that then failed.
 *
 * The feed exists only to root the archive. Left behind it is litter in
 * someone's feed list and a copy in the compute graph asserting an analysis
 * that produced nothing — so it is removed, and named when it cannot be.
 *
 * @param feedId - The feed to discard.
 * @param name - The directory's name, for the message.
 */
async function feed_discard(feedId: number, name: string): Promise<void> {
  const removed: boolean = await feed_delete(feedId);
  errorStack.stack_push('error', removed
    ? `Archiving ${name} failed; the feed it created was removed.`
    : `Archiving ${name} failed, and feed ${feedId} could not be removed. Delete it when convenient.`);
}

/**
 * Locates the file an archive run produced.
 *
 * The output directory is listed rather than its path reconstructed: the
 * archive's name is the pipeline's business, and a client that guesses it
 * breaks the day the pipeline changes.
 *
 * @param feedId - The feed the run created.
 * @param dircopyId - The `pl-dircopy` instance that rooted it.
 * @param archiveInstanceId - The instance that produced the archive.
 * @param name - The directory's name, for the error message.
 * @returns The archive, or null when the output directory held no file.
 */
async function archiveOutput_find(
  feedId: number,
  dircopyId: number,
  archiveInstanceId: number,
  name: string,
): Promise<ArchiveResult | null> {
  const outputRoot: string = `feeds/feed_${feedId}/pl-dircopy_${dircopyId}`;
  // store-path: the output of the run CUBE made, named by its feed's and its job's ids.
  const items: FsItem[] = await files_listRecursive(outputRoot);
  const produced: FsItem[] = items.filter((item: FsItem): boolean =>
    item.path.includes(`_${archiveInstanceId}/data/`) && item.type !== 'dir');

  if (produced.length === 0) {
    errorStack.stack_push('error', `The archive of ${name} produced no file.`);
    return null;
  }

  const archive: FsItem = produced[0];
  const filename: string = archive.path.split('/').filter(Boolean).pop() ?? `${name}.zip`;
  return {
    path: archive.path,
    filename,
    ...(typeof archive.size === 'number' ? { size: archive.size } : {}),
  };
}
