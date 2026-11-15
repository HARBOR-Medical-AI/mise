/**
 * @file PACS VFS Provider.
 *
 * Implements virtual file browser directories and sequential synthetic PACS retrieves.
 *
 * @module
 */

import { vfsOutcome_convertFromBoolean, vfsOutcome_convertFromResult, type VfsOutcome } from '@fnndsc/fond';
import { Result, Ok, Err, errorStack, chrisConnection, chrisContext, Context, PACSQueryDecodedResult, PACSServer, seriesStorage_resolve, runtimeOutput_data, runtimeOutput_err, queryIndex_get, queryIndex_sweep, type QueryIndex, type QueryIndexEntry, type SeriesStorageState, type Client } from "@fnndsc/cumin";
import { retrieveTask_make, retrieve_fireAndWatch, retrieveTasks_skipComplete, type RetrieveTask, type RetrieveWatchEvents } from "../../retrieve/watch.js";
import { VFSProvider, VFSItem, CpOptions } from "../provider.js";
import { vfsItems_sort } from "../sort.js";
import {
  tag_extractValue,
  path_normalize,
  queryId_extractFromFolder,
  queryFolderName_build,
  folderUID_get,
  studies_extractFromDecoded,
  series_extractFromStudy,
  study_findByUID,
  series_findByUID,
  cpSrc_parse,
} from "./pacsHelpers.js";

import {
  pacsServers_list,
  pacsQuery_resultDecode,
} from "../../pacs/index.js";
import { files_copyRecursively } from "../../files/index.js";
import path from "path";
import chalk from "chalk";
import { pacsVfs_read, pacsVfs_readBinary } from "./pacs_content.js";



type SortOptions = { sort?: "name" | "size" | "date" | "owner"; reverse?: boolean };













function pacsRoot_list(): Result<VFSItem[]> {
  return Ok([{ name: "queries", type: "vfs", size: 0, owner: "root", date: new Date().toISOString() }]);
}

/**
 * Lists the query log: every query this identity has asked, not a page of them.
 *
 * The log used to be the first hundred records CUBE returned, which on a
 * working CUBE is a small fraction of them — an operator looking for a query
 * they knew they had run simply could not see it. A listing shows what is
 * there (#401).
 *
 * Served from the query index, which holds the whole log and is filled by a
 * background sweep. A cold index falls back to sweeping now: slower, but
 * complete, and it warms the index for everything after.
 *
 * @param options - Sort and order.
 * @returns Every stored query as a folder.
 */
async function queries_list(options?: SortOptions): Promise<Result<VFSItem[]>> {
  const index: QueryIndex = queryIndex_get();
  if (index.size_get() === 0) {
    // Nothing held yet: fill it rather than show a page of the log and
    // call it the log.
    await queryIndex_sweep();
  }
  const items: VFSItem[] = index.entries_all().map((entry: QueryIndexEntry): VFSItem => ({
    name: queryFolderName_build({
      queryId: String(entry.queryId),
      queryObj: entry.criteria,
      title: "query",
      username: entry.owner || undefined,
      hasResult: entry.hasResult,
    }),
    type: "dir",
    size: 0,
    owner: entry.owner || "system",
    date: entry.answeredAt,
  }));
  return Ok(vfsItems_sort(items, options?.sort, options?.reverse));
}

function studies_list(studies: Record<string, unknown>[], options?: SortOptions): Result<VFSItem[]> {
  const items: VFSItem[] = studies.map((studyObj: Record<string, unknown>, idx: number): VFSItem => {
    const rawUID: unknown = studyObj.StudyInstanceUID || studyObj.uid;
    const studyUID: string = tag_extractValue(rawUID || `study_${idx}`);
    const studyDesc: string = tag_extractValue(studyObj.StudyDescription || "NoDescription");
    return {
      name: `Study_${studyUID}_${studyDesc.replace(/[\s/]/g, "_")}`,
      type: "dir",
      size: 0,
      owner: "system",
      date: "",
    };
  });
  return Ok(vfsItems_sort(items, options?.sort, options?.reverse));
}

function series_list(seriesArr: Record<string, unknown>[], options?: SortOptions): Result<VFSItem[]> {
  const items: VFSItem[] = seriesArr.map((seriesObj: Record<string, unknown>, idx: number): VFSItem => {
    const rawUID: unknown = seriesObj.SeriesInstanceUID || seriesObj.uid;
    const seriesUID: string = tag_extractValue(rawUID || `series_${idx}`);
    const seriesDesc: string = tag_extractValue(seriesObj.SeriesDescription || "NoDescription");
    return {
      name: `Series_${seriesUID}_${seriesDesc.replace(/[\s/]/g, "_")}`,
      type: "dir",
      size: 0,
      owner: "system",
      date: "",
    };
  });
  return Ok(vfsItems_sort(items, options?.sort, options?.reverse));
}

function seriesFiles_list(seriesObj: Record<string, unknown>): Result<VFSItem[]> {
  return Ok([
    { name: "metadata.json", type: "file", size: JSON.stringify(seriesObj).length, owner: "system", date: "" },
    { name: "image_slices.dcm", type: "file", size: 0, owner: "system", date: "" },
  ]);
}


function seriesToRetrieve_build(
  decoded: PACSQueryDecodedResult,
  studyUID: string,
  seriesUID: string | undefined,
  src: string
): Result<{ uid: string; description: string; expectedFiles: number }[]> {
  const studies: Record<string, unknown>[] = studies_extractFromDecoded(decoded.json);
  const studyObj: Record<string, unknown> | undefined = study_findByUID(studies, studyUID);
  if (!studyObj) {
    errorStack.stack_push("error", `cp: Study with UID ${studyUID} not found in query results.`);
    return Err();
  }

  const seriesArray: Record<string, unknown>[] = series_extractFromStudy(studyObj);
  const seriesToRetrieve: { uid: string; description: string; expectedFiles: number }[] = [];
  const expectedCount_extract = (obj: Record<string, unknown> | undefined): number =>
    Number(tag_extractValue(obj?.NumberOfSeriesRelatedInstances ?? 0)) || 0;

  if (seriesUID) {
    const seriesObj: Record<string, unknown> | undefined = series_findByUID(seriesArray, seriesUID);
    const desc: string = seriesObj ? tag_extractValue(seriesObj.SeriesDescription || "Series") : "Series";
    seriesToRetrieve.push({ uid: seriesUID, description: desc, expectedFiles: expectedCount_extract(seriesObj) });
  } else {
    for (const s of seriesArray) {
      const sUID: string = tag_extractValue(s.SeriesInstanceUID || s.uid);
      if (sUID) {
        seriesToRetrieve.push({ uid: sUID, description: tag_extractValue(s.SeriesDescription || "Series"), expectedFiles: expectedCount_extract(s) });
      }
    }
  }

  if (seriesToRetrieve.length === 0) {
    errorStack.stack_push("error", `cp: No series found to retrieve from '${src}'`);
    return Err();
  }

  return Ok(seriesToRetrieve);
}

async function pacsServer_resolve(): Promise<Result<string>> {
  const fromContext: string | null = await chrisContext.current_get(Context.PACSserver);
  if (fromContext) return Ok(fromContext);

  const serversResult: Result<PACSServer[]> = await pacsServers_list();
  if (serversResult.ok && serversResult.value.length > 0) {
    return Ok(String(serversResult.value[0].id));
  }
  errorStack.stack_push("error", "cp: No PACS server available or configured in context.");
  return Err();
}

async function series_retrieveAndCopy(
  seriesItem: { uid: string; description: string; expectedFiles: number },
  studyUID: string,
  pacsserver: string,
  dest: string,
  idx: number,
  total: number
): Promise<boolean> {
  runtimeOutput_data(`${chalk.cyan(`\n[PACS Retrieve ${idx + 1}/${total}] Processing series: ${seriesItem.description} (${seriesItem.uid})...`)}\n`);

  const client: Client | null = await chrisConnection.client_get();
  if (!client) {
    runtimeOutput_err(`${chalk.red("  ✗ Not connected to ChRIS.")}\n`);
    return false;
  }

  // One retrieve engine for cp and pull alike: bounded, retried firing plus
  // the LONK watch, replacing this provider's former 5-second polling loop.
  const task: RetrieveTask = retrieveTask_make({
    label: seriesItem.description,
    seriesUID: seriesItem.uid,
    studyUID,
    pacsName: pacsserver,
    // The decode's instance count enables the idempotency skip: a series
    // already fully registered in CUBE is copied without refiring.
    expectedFiles: seriesItem.expectedFiles,
  });

  const alreadyThere: number = await retrieveTasks_skipComplete([task]);
  if (alreadyThere === 0) {
    const events: RetrieveWatchEvents = {
      task: (t: RetrieveTask, status: string): void => {
        if (status === 'running' && t.actualFiles > 0) {
          runtimeOutput_data(`${chalk.gray(`     ${t.actualFiles} file(s) received...`)}\n`);
        } else if (status === 'error') {
          runtimeOutput_err(`${chalk.red("  ✗ PACS retrieve reported an error.")}\n`);
        } else if (status === 'stalled' || status === 'timeout') {
          runtimeOutput_err(`${chalk.red(`  ✗ PACS retrieve ${status}.`)}\n`);
        }
      },
    };
    runtimeOutput_data(`${chalk.gray("  -> Firing PACS retrieve and watching progress...")}\n`);
    const firingErrors: number = await retrieve_fireAndWatch([task], pacsserver, client, events);
    if (firingErrors > 0) {
      runtimeOutput_err(`${chalk.red(`  ✗ Retrieve could not be fired for series ${seriesItem.uid}.`)}\n`);
      return false;
    }
    if (task.status !== 'pulled') {
      return false;
    }
  }

  runtimeOutput_data(`${chalk.gray("  -> Finding folder path on ChRIS storage...")}\n`);
  let folderPath: string | null = task.cubePathDir;
  if (folderPath === null) {
    const stateResult: Result<SeriesStorageState> = await seriesStorage_resolve(seriesItem.uid, { attempts: 4, delayMs: 2_000 });
    folderPath = stateResult.ok ? stateResult.value.folderPath : null;
  }
  if (!folderPath) {
    runtimeOutput_err(`${chalk.red(`  ✗ No registered folder path found for series UID ${seriesItem.uid}`)}\n`);
    return false;
  }

  const absoluteFolderPath: string = folderPath.startsWith("/") ? folderPath : "/" + folderPath;
  const cleanDesc: string = seriesItem.description.replace(/[\s/]/g, "_");
  const targetSeriesFolder: string = path.posix.join(dest, `Series_${seriesItem.uid}_${cleanDesc}`);

  runtimeOutput_data(`${chalk.gray(`  -> Copying series files to '${targetSeriesFolder}'...`)}\n`);
  // store-path: the folder CUBE registered for the series, into a destination `cp` resolved (storePath_resolve, both ends).
  const copySuccess: boolean = await files_copyRecursively(absoluteFolderPath, targetSeriesFolder);
  if (!copySuccess) {
    runtimeOutput_err(`${chalk.red(`  ✗ Recursive copy failed from '${absoluteFolderPath}' to '${targetSeriesFolder}'`)}\n`);
    return false;
  }

  runtimeOutput_data(`${chalk.green(`  ✓ Series '${seriesItem.description}' copied successfully.`)}\n`);
  return true;
}

/**
 * Virtual PACS Search results VFS provider.
 */
export class PacsVfsProvider implements VFSProvider {
  /** Prefix matches /net/pacs and subdirectories. */
  prefix = "/net/pacs";

  /**
   * Cache for decoded PACS query results to avoid redundant API hits.
   *
   * Contract (see docs/code-audit-2026-08.adoc, cache inventory): only a
   * settled result — one carrying a structured `json` payload — is cached,
   * since a query's payload is written once and never mutates afterwards; a
   * payload-less decode (query still running, or empty) is re-fetched on the
   * next access. The cache is size-bounded so a long-lived daemon does not
   * grow it monotonically; eviction is oldest-inserted-first, which for
   * monotonically increasing query ids approximates least-recently-created.
   */
  private _queryCache: Map<number, PACSQueryDecodedResult> = new Map<number, PACSQueryDecodedResult>();

  /** Upper bound on cached decoded query results. */
  private static readonly QUERY_CACHE_MAX: number = 100;

  /**
   * Fetches the decoded query result, leveraging a cache to prevent redundant API calls.
   *
   * Public so a verb that reads one series' facts out of an answer the
   * operator just listed (`gather add`) takes them from this cache rather
   * than asking CUBE again.
   *
   * @param queryId - The ID of the PACS query to decode.
   * @returns Promise resolving to the decoded PACS query result, or null if fetch fails.
   */
  public async queryResult_fetch(queryId: number): Promise<PACSQueryDecodedResult | null> {
    const cached: PACSQueryDecodedResult | undefined = this._queryCache.get(queryId);
    if (cached) {
      return cached;
    }

    const decodedResult: Result<PACSQueryDecodedResult> = await pacsQuery_resultDecode(queryId);
    if (!decodedResult.ok || !decodedResult.value) {
      return null;
    }

    // Cache settled results only: a decode without a structured payload may
    // be a still-running query whose payload arrives later, and caching it
    // would pin the empty view for the life of the process.
    if (decodedResult.value.json !== undefined && decodedResult.value.json !== null) {
      if (this._queryCache.size >= PacsVfsProvider.QUERY_CACHE_MAX) {
        const oldest: number | undefined = this._queryCache.keys().next().value;
        if (oldest !== undefined) this._queryCache.delete(oldest);
      }
      this._queryCache.set(queryId, decodedResult.value);
    }
    return decodedResult.value;
  }

  /**
   * Lazily lists virtual directory contents under `/net/pacs`.
   */
  async list(
    pathStr: string,
    options?: SortOptions
  ): Promise<Result<VFSItem[]>> {
    try {
      const effectivePath: string = path_normalize(pathStr);

      if (effectivePath === "/net/pacs") return pacsRoot_list();
      if (effectivePath === "/net/pacs/queries") return queries_list(options);

      const parts: string[] = effectivePath.split("/").filter(Boolean);

      if (parts.length >= 3 && parts[2] !== "queries") {
        errorStack.stack_push("error", `'${effectivePath}': No such virtual directory. Valid paths under /net/pacs: /net/pacs/queries`);
        return Err();
      }

      const queryFolder: string = parts[3];
      if (!queryFolder) return Ok([]);

      const queryId: number = queryId_extractFromFolder(queryFolder);
      if (Number.isNaN(queryId)) {
        errorStack.stack_push("error", `'${effectivePath}': No such virtual directory. Use 'ls /net/pacs/queries' to see available queries.`);
        return Err();
      }

      const decoded: PACSQueryDecodedResult | null = await this.queryResult_fetch(queryId);
      if (!decoded?.json) {
        errorStack.stack_push("error", `PACS query ${queryId} has no structured study/series result payload.`);
        return Err();
      }

      const studies: Record<string, unknown>[] = studies_extractFromDecoded(decoded.json);

      if (parts.length === 4) return studies_list(studies, options);

      const studyUID: string = folderUID_get(parts[4], "Study");
      const studyObj: Record<string, unknown> | undefined = study_findByUID(studies, studyUID);
      // A missing UID is "no such directory", never an empty one: rendering
      // not-found as an empty listing hides typos and stale paths entirely.
      if (!studyObj) {
        errorStack.stack_push("error", `'${effectivePath}': No such study in query ${queryId}. Use 'ls' on the query directory to see available studies.`);
        return Err();
      }

      const seriesArr: Record<string, unknown>[] = series_extractFromStudy(studyObj);

      if (parts.length === 5) return series_list(seriesArr, options);

      if (parts.length === 6) {
        const seriesUID: string = folderUID_get(parts[5], "Series");
        const seriesObj: Record<string, unknown> | undefined = series_findByUID(seriesArr, seriesUID);
        if (!seriesObj) {
          errorStack.stack_push("error", `'${effectivePath}': No such series in study ${studyUID}.`);
          return Err();
        }
        return seriesFiles_list(seriesObj);
      }

      return Ok([]);
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `PACS VFS list failed: ${msg}`);
      return Err();
    }
  }

  /** @inheritdoc */
  async cp(src: string, dest: string, _options: CpOptions): Promise<VfsOutcome> {
    return vfsOutcome_convertFromBoolean(await this.copy_run(src, dest, _options), 'EIO');
  }

  /**
   * Triggers sequential synthetic PACS pulls and link-copies results to feed destination.
   *
   * @param src - Source PACS absolute virtual path.
   * @param dest - Destination native feed folder.
   * @param options - Copy options like recursive.
   */
  private async copy_run(src: string, dest: string, _options: CpOptions): Promise<boolean> {
    try {
      const parsedResult: Result<{ studyUID: string; seriesUID?: string; queryId: number }> = cpSrc_parse(src);
      if (!parsedResult.ok) return false;
      const { studyUID, seriesUID, queryId } = parsedResult.value;

      const decoded: PACSQueryDecodedResult | null = await this.queryResult_fetch(queryId);
      if (!decoded?.json) {
        errorStack.stack_push("error", `cp: Failed to decode query results for query ID ${queryId}`);
        return false;
      }

      const seriesResult: Result<{ uid: string; description: string; expectedFiles: number }[]> = seriesToRetrieve_build(decoded, studyUID, seriesUID, src);
      if (!seriesResult.ok) return false;
      const seriesToRetrieve: { uid: string; description: string; expectedFiles: number }[] = seriesResult.value;

      const serverResult: Result<string> = await pacsServer_resolve();
      if (!serverResult.ok) return false;
      const pacsserver: string = serverResult.value;

      runtimeOutput_data(`${chalk.cyan(`[PACS Retrieve] Initiating sequential gather of ${seriesToRetrieve.length} series...`)}\n`);

      let overallSuccess: boolean = true;
      for (let i: number = 0; i < seriesToRetrieve.length; i++) {
        const ok: boolean = await series_retrieveAndCopy(seriesToRetrieve[i], studyUID, pacsserver, dest, i, seriesToRetrieve.length);
        if (!ok) overallSuccess = false;
      }
      return overallSuccess;
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `PACS cp failed: ${msg}`);
      return false;
    }
  }

  /** @inheritdoc */
  async read(pathStr: string): Promise<VfsOutcome<string>> {
    return vfsOutcome_convertFromResult(await this.text_read(pathStr), 'ENOENT');
  }

  /**
   * Reads virtual file content under '/net/pacs'.
   *
   * @param pathStr - The absolute virtual path of the file to read.
   * @returns Promise resolving to a Result containing the file contents as a string.
   */
  private async text_read(pathStr: string): Promise<Result<string>> {
    return pacsVfs_read(pathStr, (queryId: number) => this.queryResult_fetch(queryId));
  }

  /** @inheritdoc */
  async readBinary(pathStr: string): Promise<VfsOutcome<Buffer>> {
    return vfsOutcome_convertFromResult(await this.bytes_read(pathStr), 'ENOENT');
  }

  /**
   * Reads virtual file binary content under '/net/pacs'.
   *
   * @param pathStr - The absolute virtual path of the file to read.
   * @returns Promise resolving to a Result containing the file contents as a Buffer.
   */
  private async bytes_read(pathStr: string): Promise<Result<Buffer>> {
    return pacsVfs_readBinary(pathStr, (queryId: number) => this.queryResult_fetch(queryId));
  }
}
