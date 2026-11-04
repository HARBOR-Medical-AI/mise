/**
 * @file Typed envelope models: the kind map behind the typed chell API.
 *
 * The envelope's model slot has always been discriminated but untyped
 * (`{ kind: string, data: unknown }`); this module is where the kinds gain
 * compile-time payload types. `FsModelMap` maps each `kind` a filesystem
 * command emits to the payload its core actually builds, and
 * `TypedEnvelope<K>` narrows a `CommandEnvelope` accordingly, so typed-API
 * callers read `envelope.model.data` without a cast.
 *
 * The map grows with the facade: commands join it as their cores join the
 * typed API (see docs/typed-chell-api.adoc). When models later cross the
 * wire, calypso validates exactly the kinds in this map at its boundary.
 *
 * @module
 */
import type { NetStatsModel, CommandEnvelope } from '@fnndsc/menu';
import type { MkdirOutcome } from '../builtins/fs/mkdir.js';
import type { TouchOutcome } from '../builtins/fs/touch.js';
import type { RmOutcome } from '../builtins/fs/rm.js';
import type { LsListing } from '../builtins/fs/ls.js';
import type { CatOutcome } from '../builtins/fs/cat.js';
import type { CpModelData } from '../builtins/fs/cp.js';
import type { MvModelData } from '../builtins/fs/mv.js';

/**
 * The payload the `fs.cwd` kind carries.
 *
 * @property path - The current working directory.
 * @property shown - The display form (titles substituted), when produced.
 */
export interface CwdModel {
  path: string;
  shown?: string;
}

/**
 * A run the kernel has scheduled: what a surface needs to point at it —
 * which feed it landed in, which instance it is, whether the feed is new.
 *
 * @property pluginName - The executable that was run, as typed.
 * @property instanceId - The plugin instance CUBE scheduled.
 * @property feedId - The feed the instance belongs to.
 * @property newFeed - True when this run created the feed (a dircopy root
 *   stands above it); false when it was appended to an existing node.
 * @property outputPath - Where the instance's output will land.
 * @property status - How the run settled, in CUBE's word
 *   (`finishedSuccessfully`), or `detached` when the line did not wait for it.
 */
export interface RunScheduled {
  pluginName: string;
  instanceId: number;
  feedId: number;
  newFeed: boolean;
  outputPath: string;
  status: string;
}

/**
 * One node of a scheduled pipeline.
 *
 * @property instanceId - The plugin instance CUBE scheduled for it.
 * @property pluginName - Its plugin.
 * @property outputPath - Where its output lands, or null when CUBE has not said.
 * @property status - How it settled, or `detached`.
 */
export interface PipelineNode {
  instanceId: number;
  pluginName: string;
  outputPath: string | null;
  status: string;
}

/**
 * A pipeline the kernel has scheduled: every node it made, not one of them
 * standing for all.
 *
 * @property pipelineName - The pipeline, by name.
 * @property workflowId - The workflow CUBE made for it.
 * @property feedId - The feed its nodes joined.
 * @property newFeed - True when the run rooted a new feed first (a `/bin` run from outside a feed: pl-dircopy of the input, then the pipeline off it).
 * @property instances - Every node, in the order CUBE scheduled them.
 * @property leaves - The nodes no other node in it runs off: where the work ends.
 * @property leafPaths - Where the leaves write, in the leaves' order, for the leaf whose output CUBE has named: the line `download ${RUN.leafPaths} <dir>` needs neither /proc nor find.
 */
export interface PipelineScheduled {
  pipelineName: string;
  workflowId: number;
  feedId: number;
  newFeed: boolean;
  instances: PipelineNode[];
  leaves: number[];
  leafPaths: string[];
}

/**
 * One plugin instance as `plugininstance list` lists it — the run history a
 * surface reads (what ran, on which feed, by whom, when). Only `id` is
 * certain: the other fields ride along when the listing selected them
 * (`--fields`), so a surface asks for what it needs.
 *
 * @property id - The instance id.
 * @property pluginName - The plugin's name (`pl-dcm2niix`).
 * @property pluginVersion - Its version (`1.0.2`).
 * @property feedId - The feed it belongs to.
 * @property owner - The username that owns it.
 * @property status - CUBE's status word.
 * @property startedAt - ISO start, when known.
 */
export interface PluginInstanceRow {
  id: number;
  pluginName?: string;
  pluginVersion?: string;
  feedId?: number;
  owner?: string;
  status?: string;
  startedAt?: string;
}

/**
 * A feed `pull --new-feed` created: its id, the pl-dircopy root the pulled
 * series landed under, and the root's data folder as the session addresses
 * it — the place a run appended to the feed takes as its input.
 *
 * @property feedId - The feed.
 * @property rootInstanceId - The pl-dircopy root instance.
 * @property owner - The username that owns it.
 * @property path - The root's data folder (`/home/<owner>/feeds/feed_N/pl-dircopy_M/data`).
 */
export interface FeedCreated {
  feedId: number;
  rootInstanceId: number;
  owner: string;
  path: string;
}

/**
 * Model kinds emitted by the filesystem commands, mapped to their payloads.
 */
export interface FsModelMap {
  'feed.created': FeedCreated;
  'fs.cwd': CwdModel;
  'net.stats': NetStatsModel;
  'run.scheduled': RunScheduled;
  'pipeline.scheduled': PipelineScheduled;
  'plugininstance.list': PluginInstanceRow[];
  'fs.mkdir': MkdirOutcome[];
  'fs.touch': TouchOutcome[];
  'fs.rm': RmOutcome[];
  'fs.listing': LsListing[];
  'fs.cat': CatOutcome[];
  'fs.cp': CpModelData;
  'fs.mv': MvModelData;
}

/** Every kind the typed API currently maps. */
export type ModelKind = keyof FsModelMap;

/**
 * A command envelope whose model slot is narrowed to one known kind.
 *
 * Structurally a plain `CommandEnvelope` (the wire and the REPL see no
 * difference); the narrowing is purely compile-time.
 */
export interface TypedEnvelope<K extends ModelKind> extends CommandEnvelope {
  model?: { kind: K; data: FsModelMap[K] };
}

/**
 * Narrows a core's envelope to its declared kind.
 *
 * The single trusted assertion of the typed API: each command core is the
 * sole producer of its kind, so the envelope it returns carries that kind's
 * payload by construction. Centralized here so the facade methods stay
 * cast-free.
 *
 * @param envelope - The envelope a command core returned.
 * @returns The same envelope, typed by its kind.
 */
export function envelope_typed<K extends ModelKind>(envelope: CommandEnvelope): TypedEnvelope<K> {
  return envelope as TypedEnvelope<K>;
}
