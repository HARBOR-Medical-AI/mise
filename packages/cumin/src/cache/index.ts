/**
 * @file Cache module exports.
 *
 * @module
 */
export {
  ListCache,
  listCache_get,
  LIST_CACHE_SIGNAL_BACKED_TTL_MS,
  LIST_CACHE_SIGNAL_FREE_TTL_MS,
  LIST_CACHE_PLUGIN_INDEX_TTL_MS,
  LIST_CACHE_MAX_ENTRIES,
} from './listCache.js';
export type { CacheStats, CacheResult, CacheOptions, ListCacheSnapshot, ListCacheEntrySnapshot } from './listCache.js';
export {
  listCheckpointPath_get,
  listCheckpoint_restore,
  listCheckpoint_save,
  listCheckpoint_watch,
} from './listCheckpoint.js';
export type { ListCheckpointRestoreResult } from './listCheckpoint.js';
export {
  QueryIndex,
  queryIndex_get,
  queryKey_build,
  queryCriteria_parse,
} from './queryIndex.js';
export type {
  QueryIndexEntry,
  QueryIndexEntrySnapshot,
  QueryIndexSnapshot,
  QueryIndexListener,
} from './queryIndex.js';
export {
  queryIndexCheckpointPath_get,
  queryIndexCheckpoint_restore,
  queryIndexCheckpoint_finish,
  queryIndexCheckpoint_hold,
  queryIndexCheckpoint_save,
  queryIndexCheckpoint_watch,
  QUERY_INDEX_CHECKPOINT_FLOOR_MS,
} from './queryIndexCheckpoint.js';
export type { QueryIndexRestoreResult } from './queryIndexCheckpoint.js';
export {
  listingsForFeeds_note,
  listingsForFeeds_drop,
  listingsForRoster_note,
  listingInvalidation_flush,
  listingInvalidation_reset,
  LISTING_INVALIDATION_WINDOW_MS,
} from './listingInvalidation.js';
export { ProcCache, procCache_get, status_isTerminal, feed_isActive, feedTopology_changed, feedStatus_deriveFromCounts, PROC_TERMINAL_STATUSES, PROC_ARRIVAL_TTL_MS, PROC_LANDED_TTL_MS, PROC_FEED_LOAD_FAILURE_TTL_MS } from './procCache.js';
export type {
  RosterFolders,
  ProcInstance,
  ProcFeed,
  ProcFeedScopeCounts,
  ProcWarmupProgress,
  ProcFeedLoadProgress,
  ProcLandedFeed,
  ProcJobGroup,
  ProcRosterSyncKind,
  ProcCacheState,
  ProcCacheLifecycle,
  ProcCacheSnapshot,
  ProcFeedSnapshot,
  ProcFeedDataFacts,
  ProcDataFormat,
  ProcCacheChange,
  ProcCacheListener,
} from './procCache.js';
// Prompt-facing process-index state is contract vocabulary: it lives in
// `@fnndsc/menu`, and callers import it from there.
//
// Only its *types* are named here, and that is a constraint rather than a
// preference. cumin emits CommonJS while menu is an ES module, so a runtime
// import would break any bundle that reaches cumin — the failure surfacing in
// a bundler rather than at the call site. Types are erased at compile time, so
// this file carries no runtime dependency on menu at all. The constraint lifts
// when cumin becomes an ES module; see "The module-format split" in
// docs/menu.adoc.
export type { ProcPromptState, ProcPromptProgress } from '@fnndsc/menu';
export {
  procCheckpointPath_get,
  procCheckpointDir_get,
  procCheckpoint_restore,
  procCheckpoint_save,
  procCheckpointFeed_save,
  procCheckpointRoster_save,
  procCheckpoint_watch,
  procLayout_get,
  procLayout_set,
  procLayoutHome_set,
  procLayoutName_check,
  procLayoutPositions_check,
  PROC_LAYOUT_NODES_MAX,
  PROC_LAYOUT_ID_MAX,
} from './procCheckpoint.js';
export type { ProcCheckpointRestoreResult, ProcLayoutRecord, ProcLayoutPosition } from './procCheckpoint.js';
