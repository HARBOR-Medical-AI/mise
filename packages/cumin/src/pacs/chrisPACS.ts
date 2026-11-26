/**
 * @file ChRIS PACS Management
 *
 * Provides helpers to list PACS servers that the current CUBE knows about.
 *
 * @module
 */

import { errorStack } from "../error/errorStack.js";
import { Result, Ok, Err } from "../utils/result.js";
import { retry_untilValue } from "../utils/retry.js";
import { ChRISResourceGroup } from "../resources/chrisResourceGroup.js";
import { FilteredResourceData, ListOptions } from "../resources/chrisResources.js";
import {
  listData_get,
  itemData_get,
  items_get,
  client_authGet,
  pacsRetrieve_deleteByUrl,
  type Client,
  shape_object,
  shape_build,
  type Shape,
} from "../chrisapi/adapter.js";
import { chrisConnection } from "../connect/chrisConnection.js";
import { tag_extractRaw, studies_extractFromDecoded, series_extractFromStudy } from "./dicomPayload.js";
import zlib from "zlib";


/**
 * Minimal shape of a PACS server as returned by the ChRIS API.
 */
export interface PACSServer {
  id: number;
  identifier?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Options for listing PACS servers (passed directly to the API).
 */
export interface PACSServerListOptions {
  identifier?: string;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

/**
 * Group handler for PACS servers.
 */
export class ChRISPACSGroup extends ChRISResourceGroup {
  constructor() {
    super("PACS", "getPACSList");
  }
}

/**
 * PACSQuery data structure from ChRIS API.
 */
interface PACSQueryData {
  result?: string;
  [key: string]: unknown;
}

/**
 * PACSQuery object from ChRIS API.
 */
interface PACSQuery {
  data: PACSQueryData;
}

/**
 * PACSRetrieve item data from collection.
 */
interface PACSRetrieveItemData {
  id: number;
  pacs_query_id: number;
  status: string;
  creation_date: string;
  [key: string]: unknown;
}

/**
 * PACSRetrieve item from collection.
 */
interface PACSRetrieveItem {
  data: PACSRetrieveItemData;
  [key: string]: unknown;
}

/**
 * Minimal shape of a PACS query record.
 */
export interface PACSQueryRecord {
  id: number;
  title?: string;
  status?: string;
  pacs_id?: number;
  result?: unknown;
  [key: string]: unknown;
}

/** A PACS server in a list: its id is the number a query is made with. */
const PACS_SERVER_SHAPE: Shape<PACSServer> = shape_build<PACSServer>('a PACS server')(['id', 'number']);

/** A PACS query just made: its id is the number everything after refers to it by. */
const PACS_QUERY_MADE_SHAPE: Shape<PACSQueryRecord> = shape_build<PACSQueryRecord>('a PACS query')(['id', 'number']);

/** A PACS query read back: each of its fields is read through a check of its own. */
const PACS_QUERY_READ_SHAPE: Shape<PACSQueryRecord> = shape_object<PACSQueryRecord>('a PACS query');

/** A PACS query's data where its result is decoded: the result is looked at before it is used. */
const PACS_QUERY_DATA_SHAPE: Shape<PACSQueryData> = shape_object<PACSQueryData>('a PACS query');

/** A PACS retrieve's data: its id is a number. (Its other fields cannot be checked against a live PACS under this project's rules, and are left as they were.) */
const PACS_RETRIEVE_DATA_SHAPE: Shape<PACSRetrieveItemData> = shape_build<PACSRetrieveItemData>('a PACS retrieve')(['id', 'number']);

/** A PACS retrieve in a list: its data is read field by field. */
const PACS_RETRIEVE_ITEM_SHAPE: Shape<PACSRetrieveItem> = shape_build<PACSRetrieveItem>('a PACS retrieve')(['data', PACS_RETRIEVE_DATA_SHAPE]);

/** What a PACS series record says of where it is and what it is: each field is read through a default or a check of its own. */
interface PACSSeriesData {
  /** Where the series' files are, as CUBE's path. */
  ['folder_path']?: string;
  /** The series' modality. */
  ['Modality']?: string;
  /** The series' description. */
  ['SeriesDescription']?: string;
  /** The series' instance UID. */
  ['SeriesInstanceUID']?: string;
}

/** A PACS series record. */
const PACS_SERIES_SHAPE: Shape<PACSSeriesData> = shape_object<PACSSeriesData>('a PACS series');

/**
 * Options for listing PACS queries.
 */
export interface PACSQueryListOptions extends ListOptions {
  pacs_id?: number;
  pacs_identifier?: string;
  /** Records created at or after this ISO timestamp. */
  min_creation_date?: string;
  /** Records created at or before this ISO timestamp. */
  max_creation_date?: string;
  /** Records owned by this username. */
  owner_username?: string;
  /** Records in this state, e.g. `succeeded`. */
  status?: string;
}

/**
 * Group handler for PACS queries.
 */
export class ChRISPACSQueryGroup extends ChRISResourceGroup {
  constructor() {
    super("PACSQueries", "getPACSQueries");
  }
}

/**
 * Resolve a PACS server identifier or ID to an ID and identifier.
 *
 * @param pacsserver - Numeric ID or identifier string.
 * @returns Result containing { id, identifier? } or Err on failure/ambiguity.
 */
export async function pacsServer_resolve(
  pacsserver: string
): Promise<Result<{ id: number; identifier?: string }>> {
  const client: Client | null = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
    return Err();
  }

  if (/^\d+$/.test(pacsserver)) {
    const id: number = Number(pacsserver);
    return Ok({ id, identifier: undefined });
  }

  try {
    const list: Awaited<ReturnType<typeof client.getPACSList>> = await client.getPACSList({
      identifier: pacsserver,
      limit: 5,
    });
    const matches: PACSServer[] = listData_get(list, PACS_SERVER_SHAPE);
    if (matches.length === 1) {
      const match: PACSServer = matches[0];
      return Ok({ id: match.id, identifier: match.identifier });
    }
    if (matches.length === 0) {
      errorStack.stack_push("error", `No PACS server found for "${pacsserver}".`);
      return Err();
    }
    errorStack.stack_push(
      "error",
      `Multiple PACS servers matched "${pacsserver}". Please specify an ID or unique identifier.`
    );
    return Err();
  } catch (error: unknown) {
    const errorMessage: string =
      error instanceof Error ? error.message : String(error);
    errorStack.stack_push(
      "error",
      `Failed to resolve PACS server "${pacsserver}": ${errorMessage}`
    );
    return Err();
  }
}

/**
 * Fetch all PACS servers visible to the current ChRIS connection.
 *
 * @param options - Optional search/pagination parameters (identifier, limit, offset).
 * @returns Result containing an array of PACS server records, or Err on failure.
 */
export async function pacsServers_list(
  options: PACSServerListOptions = {}
): Promise<Result<PACSServer[]>> {
  // The whole list, unfiltered, changes when an administrator registers a
  // server: it is kept a minute and shared while asked, so a query, a
  // listing and `pacs list` stop asking CUBE for it each time.
  const whole: boolean = Object.keys(options).length === 0;
  if (whole) {
    const now: number = Date.now();
    // Kept per client: a login is a new client, and another identity's list is not this one's.
    const client: unknown = await chrisConnection.client_get();
    if (serversKept !== null && serversKept.client === client && now - serversKept.at < PACS_SERVERS_KEEP_MS) return serversKept.answer;
    const answer: Promise<Result<PACSServer[]>> = pacsServers_fetch(options);
    serversKept = { at: now, answer, client };
    // A refusal or a failure is not kept: the next ask tries again.
    void answer.then((result: Result<PACSServer[]>): void => { if (!result.ok && serversKept?.answer === answer) serversKept = null; });
    return answer;
  }
  return pacsServers_fetch(options);
}

/** How long the unfiltered server list is kept. */
export const PACS_SERVERS_KEEP_MS: number = 60 * 1000;

/** The unfiltered server list, as last asked. */
let serversKept: { at: number; answer: Promise<Result<PACSServer[]>>; client: unknown } | null = null;

/** Forgets the kept server list (a server registered, an identity changed, a test). */
export function pacsServers_forget(): void {
  serversKept = null;
}

/**
 * Asks CUBE for the PACS servers.
 *
 * @param options - Search/pagination parameters.
 * @returns The servers, or Err with the error stack holding why.
 */
async function pacsServers_fetch(options: PACSServerListOptions): Promise<Result<PACSServer[]>> {
  try {
    const group: ChRISPACSGroup = new ChRISPACSGroup();
    const clientAvailable: unknown = await group.client_get();
    if (!clientAvailable) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }

    const listOptions: ListOptions = options as ListOptions;
    const filtered: FilteredResourceData | null = await group.asset.resources_getAll(
      listOptions
    );

    if (!filtered || !filtered.tableData) {
      return Ok([]);
    }

    const servers: PACSServer[] = filtered.tableData.map(
      (row: Record<string, unknown>): PACSServer => ({
        id: typeof row.id === "number" ? row.id : Number(row.id),
        identifier: (row.identifier as string) || (row.name as string) || undefined,
        name: (row.name as string) || undefined,
        description: (row.description as string) || undefined,
      })
    );
    return Ok(servers);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to list PACS servers: ${errorMessage}`);
    return Err();
  }
}

/**
 * List PACS queries with optional filtering.
 *
 * @param options - Search/pagination options (pacs_id, pacs_identifier, limit, offset, etc.).
 * @returns Result containing filtered resource data or Err.
 */
export async function pacsQueries_list(
  options: PACSQueryListOptions = {}
): Promise<Result<FilteredResourceData | null>> {
  try {
    const group: ChRISPACSQueryGroup = new ChRISPACSQueryGroup();
    const filtered: FilteredResourceData | null =
      await group.asset.resources_listAndFilterByOptions(options);
    return Ok(filtered);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to list PACS queries: ${errorMessage}`);
    return Err();
  }
}

/**
 * Data needed to create a PACS query.
 */
export interface PACSQueryCreateData {
  title: string;
  query: string;
  description?: string;
  execute?: boolean;
}

/**
 * Create a PACS query against a specific PACS server.
 *
 * @param pacsserver - PACS server ID or identifier.
 * @param data - Query creation data (title, query JSON string, optional description).
 * @returns Result containing a PACSQueryRecord or Err.
 */
export async function pacsQueries_create(
  pacsserver: string,
  data: PACSQueryCreateData
): Promise<Result<PACSQueryRecord>> {
  const resolved: Result<{ id: number; identifier?: string }> = await pacsServer_resolve(pacsserver);
  if (!resolved.ok) {
    return Err();
  }
  const { id } = resolved.value;

  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }
    const query: Awaited<ReturnType<typeof client.createPACSQuery>> = await client.createPACSQuery(id, data);
    const queryData: PACSQueryRecord | null = itemData_get(query, PACS_QUERY_MADE_SHAPE);
    const record: PACSQueryRecord = {
      id: queryData?.id as number,
      title: queryData?.title as string,
      status: queryData?.status as string,
      pacs_id: queryData?.pacs_id as number,
      result: queryData?.result,
    };
    return Ok(record);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to create PACS query: ${errorMessage}`);
    return Err();
  }
}

/**
 * Decoded PACS query result payload.
 */
export interface PACSQueryDecodedResult {
  raw: string;
  base64Decoded?: Buffer;
  zlibDecoded?: Buffer;
  gzipDecoded?: Buffer;
  text?: string;
  json?: unknown;
}

/**
 * Attempt to decode a PACS query result payload.
 *
 * @param queryId - PACS query ID.
 * @returns Result containing decoded forms (raw, decoded buffers, text, optional JSON) or Err on failure.
 */
export async function pacsQuery_resultDecode(
  queryId: number
): Promise<Result<PACSQueryDecodedResult>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }

    const query: Awaited<ReturnType<typeof client.getPACSQuery>> = await client.getPACSQuery(queryId);
    if (!query || !query.data) {
      errorStack.stack_push("error", `PACS query ${queryId} not found.`);
      return Err();
    }

    const queryData: PACSQueryData | null = itemData_get(query, PACS_QUERY_DATA_SHAPE);
    const raw: string | undefined = queryData?.result;
    if (!raw || typeof raw !== "string") {
      errorStack.stack_push("error", `PACS query ${queryId} has no result payload.`);
      return Err();
    }

    const decoded: PACSQueryDecodedResult = { raw };

    let b64: Buffer | null = null;
    try {
      b64 = Buffer.from(raw, "base64");
      decoded.base64Decoded = b64;
    } catch (e: unknown) {
      errorStack.stack_push("warning", `Base64 decode failed for query ${queryId}: ${e}`);
    }

    if (b64) {
      try {
        decoded.zlibDecoded = Buffer.from(zlib.inflateSync(b64));
      } catch (e: unknown) {
        // Ignore; maybe not zlib
      }
      try {
        decoded.gzipDecoded = Buffer.from(zlib.gunzipSync(b64));
      } catch (e: unknown) {
        // Ignore; maybe not gzip
      }

      const textCandidate: Buffer | undefined =
        decoded.zlibDecoded || decoded.gzipDecoded || decoded.base64Decoded;
      if (textCandidate) {
        decoded.text = textCandidate.toString("utf-8");
        try {
          decoded.json = JSON.parse(decoded.text);
        } catch {
          // Not JSON; leave as text
        }
      }
    }

    return Ok(decoded);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push(
      "error",
      `Failed to decode PACS query result for ${queryId}: ${errorMessage}`
    );
    return Err();
  }
}

/**
 * Fetch a single PACS query record by ID.
 *
 * @param queryId - PACS query ID.
 * @returns Result containing a PACSQueryRecord (with current status/result) or Err.
 */
export async function pacsQuery_get(queryId: number): Promise<Result<PACSQueryRecord>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }
    const query: Awaited<ReturnType<typeof client.getPACSQuery>> = await client.getPACSQuery(queryId);
    if (!query || !query.data) {
      errorStack.stack_push("error", `PACS query ${queryId} not found.`);
      return Err();
    }
    const qData: PACSQueryRecord | null = itemData_get(query, PACS_QUERY_READ_SHAPE);
    return Ok({
      id: queryId,
      title: qData?.title as string | undefined,
      status: qData?.status as string | undefined,
      pacs_id: qData?.pacs_id as number | undefined,
      result: qData?.result,
    });
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to get PACS query ${queryId}: ${msg}`);
    return Err();
  }
}

/**
 * Minimal shape of a PACS retrieve record.
 */
export interface PACSRetrieveRecord {
  id: number;
  pacs_query_id?: number;
  status?: string;
  creation_date?: string;
  [key: string]: unknown;
}

/**
 * Group handler for PACS retrieves.
 */
export class ChRISPACSRetrieveGroup extends ChRISResourceGroup {
  constructor() {
    super("PACSRetrieves", "getPACSRetrieves");
  }
}

/**
 * Create a PACS retrieve for a given query.
 * This triggers the external service to pull DICOM data from PACS to ChRIS.
 *
 * @param queryId - PACS query ID to retrieve data for.
 * @returns Result containing a PACSRetrieveRecord or Err.
 */
export async function pacsRetrieve_create(
  queryId: number
): Promise<Result<PACSRetrieveRecord>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }

    const retrieve: Awaited<ReturnType<typeof client.createPACSRetrieve>> = await client.createPACSRetrieve(queryId);
    const retrieveData: PACSRetrieveItemData | null = itemData_get(retrieve, PACS_RETRIEVE_DATA_SHAPE);
    const record: PACSRetrieveRecord = {
      id: retrieveData?.id as number,
      pacs_query_id: queryId,
      status: retrieveData?.status as string,
      creation_date: retrieveData?.creation_date as string,
    };
    return Ok(record);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to create PACS retrieve for query ${queryId}: ${errorMessage}`);
    return Err();
  }
}

/**
 * List all retrieves for a given PACS query.
 *
 * @param queryId - PACS query ID.
 * @param options - Optional list options.
 * @returns Result containing an array of PACSRetrieveRecord or Err.
 */
export async function pacsRetrieves_list(
  queryId: number,
  options: ListOptions = {}
): Promise<Result<PACSRetrieveRecord[]>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }

    const query: Awaited<ReturnType<typeof client.getPACSQuery>> = await client.getPACSQuery(queryId);
    if (!query || !query.data) {
      errorStack.stack_push("error", `PACS query ${queryId} not found.`);
      return Err();
    }

    const retrieveList: Awaited<ReturnType<NonNullable<typeof query>["getRetrieves"]>> = await query.getRetrieves(options);
    const items: PACSRetrieveItem[] = items_get(retrieveList, PACS_RETRIEVE_ITEM_SHAPE);

    const records: PACSRetrieveRecord[] = items.map((item: PACSRetrieveItem): PACSRetrieveRecord => ({
      id: item.data.id,
      pacs_query_id: item.data.pacs_query_id,
      status: item.data.status,
      creation_date: item.data.creation_date,
    }));

    return Ok(records);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to list PACS retrieves for query ${queryId}: ${errorMessage}`);
    return Err();
  }
}

/**
 * Delete (cancel) a PACS retrieve.
 *
 * @param retrieveId - PACS retrieve ID to delete.
 * @returns Result containing void or Err.
 */
export async function pacsRetrieve_delete(
  retrieveId: number
): Promise<Result<void>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push("error", "Not connected to ChRIS. Please log in.");
      return Err();
    }

    // The API typically has endpoints like /api/v1/pacsfiles/retrieves/{id}/
    // We need to construct the URL and make a DELETE request
    // For now, use a simple approach: we know retrieves exist, so direct delete via constructed object

    // Note: This is a simplified implementation
    // In a production system, you'd want to verify the retrieve exists first
    const baseUrl: string = client_authGet(client)?.cubeUrl || "";
    if (!baseUrl) {
      errorStack.stack_push("error", "Could not determine CUBE URL for delete operation.");
      return Err();
    }

    const retrieveUrl: string = `${baseUrl}api/v1/pacsfiles/retrieves/${retrieveId}/`;
    await pacsRetrieve_deleteByUrl(retrieveUrl, client_authGet(client));
    return Ok(undefined);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to delete PACS retrieve ${retrieveId}: ${errorMessage}`);
    return Err();
  }
}

/**
 * Status of a single series in the retrieve process.
 */
export interface SeriesRetrieveStatus {
  seriesInfo: Record<string, unknown>;
  seriesInstanceUID: string;
  seriesDescription?: string;
  expectedFiles: number;
  actualFiles: number;
  status: "pending" | "pulling" | "pulled" | "error";
  /** CUBE storage folder the series landed in, or null when nothing arrived. */
  folderPath: string | null;
}

/**
 * Study with series status information.
 */
export interface StudyRetrieveStatus {
  studyInfo: Record<string, unknown>;
  studyInstanceUID?: string;
  studyDescription?: string;
  series: SeriesRetrieveStatus[];
}

/**
 * Complete retrieve status report for a query.
 */
export interface PACSQueryStatusReport {
  queryId: number;
  retrieveStatus?: string;
  retrieveId?: number;
  studies: StudyRetrieveStatus[];
}

/** A series' presence in CUBE storage: registered file count and folder. */
export interface SeriesStorageState {
  /** Number of PACSFiles registered for the series. */
  fileCount: number;
  /** Display folder path (leading slash), or null when nothing arrived. */
  folderPath: string | null;
}

/**
 * What CUBE's own series record says of a series stored in its PACS folder:
 * its modality and description, no file read.
 *
 * @property modality - The series' modality, when recorded.
 * @property seriesDescription - The series' description, when recorded.
 */
export interface PACSSeriesFacts {
  modality?: string;
  seriesDescription?: string;
}

/** Series records already fetched, by PACS and patient folder: one ask serves every series of a patient. */
const seriesByPatient: Map<string, Promise<Map<string, PACSSeriesFacts>>> = new Map();

/**
 * The series folder a path lies in, when it lies in CUBE's PACS store
 * (`SERVICES/PACS/<pacs>/<patient>/<study>/<series>/...`).
 *
 * @param path - A CFS path, with or without its leading slash.
 * @returns The series folder (no leading slash), its PACS and its patient folder; null elsewhere.
 */
export function pacsSeriesFolder_parse(path: string): { folder: string; pacs: string; patient: string } | null {
  const parts: string[] = path.replace(/^\/+/, '').split('/');
  if (parts.length < 6 || parts[0] !== 'SERVICES' || parts[1] !== 'PACS') return null;
  const [, , pacs, patient] = parts as [string, string, string, string];
  if (pacs.length === 0 || patient.length === 0) return null;
  return { folder: parts.slice(0, 6).join('/'), pacs, patient };
}

/**
 * What CUBE's series record says of the series a PACS path lies in. CUBE
 * cannot be asked by folder, but a patient folder begins with the patient's
 * ID, and the series list answers by patient: the patient's series are
 * asked for once, and the folder matched exactly among them. A path outside
 * the PACS store, a folder not found, or a failed ask is none.
 *
 * @param path - A CFS path in the PACS store.
 * @returns The series' facts, or null.
 */
export async function pacsSeriesFacts_fetch(path: string): Promise<PACSSeriesFacts | null> {
  const at = pacsSeriesFolder_parse(path);
  if (at === null) return null;
  const patientID: string = at.patient.split('-')[0] ?? '';
  if (patientID.length === 0) return null;
  const key: string = `${at.pacs}/${at.patient}`;
  let asked: Promise<Map<string, PACSSeriesFacts>> | undefined = seriesByPatient.get(key);
  if (asked === undefined) {
    asked = patientSeries_fetch(at.pacs, patientID).catch((): Map<string, PACSSeriesFacts> => {
      // A failed ask is forgotten, so the next feed of this patient asks again.
      seriesByPatient.delete(key);
      return new Map();
    });
    seriesByPatient.set(key, asked);
  }
  return (await asked).get(at.folder) ?? null;
}

/** Every series CUBE records for one patient in one PACS, by folder: only modality and description kept. */
async function patientSeries_fetch(pacs: string, patientID: string): Promise<Map<string, PACSSeriesFacts>> {
  const found: Map<string, PACSSeriesFacts> = new Map();
  const client: Client | null = await chrisConnection.client_get();
  if (!client) return found;
  for (let offset: number = 0; ; offset += SERIES_PAGE) {
    const page: Awaited<ReturnType<typeof client.getPACSSeriesList>> =
      await client.getPACSSeriesList({ PatientID: patientID, pacs_identifier: pacs, limit: SERIES_PAGE, offset });
    const items: ReturnType<typeof page.getItems> = page.getItems();
    if (!items || items.length === 0) break;
    for (const item of items) {
      const data: { folder_path?: string; Modality?: string; SeriesDescription?: string } | null =
        itemData_get(item, PACS_SERIES_SHAPE);
      const folder: string | undefined = data?.folder_path?.replace(/^\/+/, '');
      if (!folder) continue;
      const facts: PACSSeriesFacts = {};
      const modality: string = (data?.Modality ?? '').trim();
      const description: string = (data?.SeriesDescription ?? '').trim();
      if (modality.length > 0) facts.modality = modality;
      if (description.length > 0) facts.seriesDescription = description;
      found.set(folder, facts);
    }
    if (items.length < SERIES_PAGE) break;
  }
  return found;
}

/** Forgets the series records fetched: a test, or a new identity. */
export function pacsSeriesFacts_clear(): void {
  seriesByPatient.clear();
}

/**
 * Resolves a series' CUBE storage state: its registered file count and the
 * folder it landed in.
 *
 * With `retry` options, re-probes across the registration lag between a PACS
 * push completing and the PACSSeries record becoming queryable, returning the
 * first state that carries a folder. This is the one series-storage resolver;
 * the per-package copies it replaces are gone.
 *
 * @param seriesInstanceUID - The series instance UID to inspect.
 * @param retry - Optional bounded re-probing: total attempts and the delay
 *   between them.
 * @returns Result containing the storage state; failures resolve to an empty
 *   state (count 0, no folder) rather than failing the whole report.
 */
export async function seriesStorage_resolve(
  seriesInstanceUID: string,
  retry?: { attempts: number; delayMs: number }
): Promise<Result<SeriesStorageState>> {
  if (retry && retry.attempts > 1) {
    const landed: SeriesStorageState | null = await retry_untilValue<SeriesStorageState>(
      retry.attempts,
      [retry.delayMs],
      async (): Promise<SeriesStorageState | null> => {
        const probe: Result<SeriesStorageState> = await seriesStorage_resolve(seriesInstanceUID);
        return probe.ok && probe.value.folderPath !== null ? probe.value : null;
      },
    );
    return Ok(landed ?? { fileCount: 0, folderPath: null });
  }
  const empty: SeriesStorageState = { fileCount: 0, folderPath: null };
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      return Ok(empty);
    }

    // First get the PACSSeries record to find the folder_path
    const seriesList: Awaited<ReturnType<typeof client.getPACSSeriesList>> = await client.getPACSSeriesList({
      SeriesInstanceUID: seriesInstanceUID,
      limit: 1,
    });

    const seriesItems: ReturnType<typeof seriesList.getItems> = seriesList.getItems();
    if (!seriesItems || seriesItems.length === 0) {
      return Ok(empty);
    }

    const seriesData: { folder_path?: string } | null =
      itemData_get(seriesItems[0], PACS_SERIES_SHAPE);
    const rawFolder: string | undefined = seriesData?.folder_path;
    if (!rawFolder) {
      return Ok(empty);
    }
    const folderPath: string = rawFolder.startsWith("/") ? rawFolder : `/${rawFolder}`;

    // Count PACSFiles in that folder (API stores fname without leading slash)
    const filesList: Awaited<ReturnType<typeof client.getPACSFiles>> = await client.getPACSFiles({
      fname: rawFolder.startsWith("/") ? rawFolder.slice(1) : rawFolder,
      limit: 1000,
    });

    const items: ReturnType<typeof filesList.getItems> = filesList.getItems();
    const fileCount: number = filesList.totalCount || (items ? items.length : 0);
    return Ok({ fileCount, folderPath });
  } catch (error: unknown) {
    errorStack.stack_push("warning", `Failed to resolve storage for series ${seriesInstanceUID}: ${error}`);
    return Ok(empty); // Return the empty state rather than failing the whole operation
  }
}

/**
 * Determine series status based on file counts.
 *
 * @param expected - Expected number of files.
 * @param actual - Actual number of files pulled.
 * @returns Status string.
 */
function series_determineStatus(
  expected: number,
  actual: number
): "pending" | "pulling" | "pulled" | "error" {
  if (actual === 0) {
    return "pending";
  }
  if (actual < expected) {
    return "pulling";
  }
  if (actual === expected) {
    return "pulled";
  }
  return "error"; // More files than expected
}

async function retrieve_latestFromQuery(
  queryId: number
): Promise<{ retrieveStatus?: string; retrieveId?: number }> {
  const retrievesResult: Result<PACSRetrieveRecord[]> = await pacsRetrieves_list(queryId);
  if (!retrievesResult.ok || retrievesResult.value.length === 0) return {};
  const latest: PACSRetrieveRecord = retrievesResult.value[retrievesResult.value.length - 1];
  return { retrieveStatus: latest.status, retrieveId: latest.id };
}

async function studySeries_buildStatus(
  study: Record<string, unknown>
): Promise<StudyRetrieveStatus> {
  const studyStatus: StudyRetrieveStatus = {
    studyInfo: study,
    studyInstanceUID: tag_extractRaw(study.StudyInstanceUID) as string | undefined,
    studyDescription: tag_extractRaw(study.StudyDescription) as string | undefined,
    series: [],
  };

  const seriesArray: Record<string, unknown>[] = series_extractFromStudy(study);

  for (const seriesObj of seriesArray) {
    if (!seriesObj || typeof seriesObj !== "object") continue;

    const series: Record<string, unknown> = seriesObj as Record<string, unknown>;
    const seriesUID: string | undefined = tag_extractRaw(series.SeriesInstanceUID) as string | undefined;
    if (!seriesUID) continue;

    const expectedFiles: number = Number(tag_extractRaw(series.NumberOfSeriesRelatedInstances)) || 0;
    const storageResult: Result<SeriesStorageState> = await seriesStorage_resolve(seriesUID);
    const storage: SeriesStorageState = storageResult.ok ? storageResult.value : { fileCount: 0, folderPath: null };
    const status: "pending" | "pulling" | "pulled" | "error" = series_determineStatus(expectedFiles, storage.fileCount);

    studyStatus.series.push({
      seriesInfo: series,
      seriesInstanceUID: seriesUID,
      seriesDescription: tag_extractRaw(series.SeriesDescription) as string | undefined,
      expectedFiles,
      actualFiles: storage.fileCount,
      status,
      folderPath: storage.folderPath,
    });
  }

  return studyStatus;
}

/** How many stored-series pages or file counts are asked for at once. */
const SERIES_BULK_CONCURRENCY: number = 8;

/** How many stored series one page asks for. */
const SERIES_PAGE: number = 300;

/**
 * The exact keys CUBE indexes a stored series by.
 *
 * Only identifiers belong here. A name is matched loosely and would answer
 * a different question from the one asked, which on this path means telling
 * an operator a series is not held when it is.
 */
export interface SeriesStorageFilter {
  PatientID?: string;
  AccessionNumber?: string;
  StudyInstanceUID?: string;
  SeriesInstanceUID?: string;
}

/**
 * Resolves the storage state of every series CUBE holds under the given
 * filters, in one pass.
 *
 * This exists because the per-series resolver costs two round trips EACH,
 * and a patient's history runs to hundreds of series: reconciling a stored
 * PACS answer that way took twenty seconds against a live CUBE, all of it
 * spent asking the same question three hundred times. CUBE already indexes
 * a stored series by study, so the whole reconciliation is one page per
 * study — the count of studies, not of series.
 *
 * The series record carries the folder but no file count, so counts are a
 * second pass over what was actually found, which is only ever the series
 * already home.
 *
 * @param filters - What to ask about, usually one per study in an answer.
 * @param options - `counts: false` skips the file counts, leaving zero.
 * @returns Series UID to storage state, holding only the series CUBE has.
 */
export async function seriesStorage_resolveMany(
  filters: ReadonlyArray<SeriesStorageFilter>,
  options?: { counts?: boolean }
): Promise<Result<Map<string, SeriesStorageState>>> {
  const found: Map<string, SeriesStorageState> = new Map<string, SeriesStorageState>();
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) return Ok(found);

    await batches_run(filters, SERIES_BULK_CONCURRENCY, async (filter: SeriesStorageFilter): Promise<void> => {
      for (let offset: number = 0; ; offset += SERIES_PAGE) {
        const page: Awaited<ReturnType<typeof client.getPACSSeriesList>> =
          await client.getPACSSeriesList({ ...filter, limit: SERIES_PAGE, offset });
        const items: ReturnType<typeof page.getItems> = page.getItems();
        if (!items || items.length === 0) return;
        for (const item of items) {
          const data: { folder_path?: string; SeriesInstanceUID?: string } | null =
            itemData_get(item, PACS_SERIES_SHAPE);
          const uid: string | undefined = data?.SeriesInstanceUID;
          const rawFolder: string | undefined = data?.folder_path;
          if (!uid || !rawFolder) continue;
          found.set(uid, {
            fileCount: 0,
            folderPath: rawFolder.startsWith("/") ? rawFolder : `/${rawFolder}`,
          });
        }
        if (items.length < SERIES_PAGE) return;
      }
    });

    if (options?.counts === false) return Ok(found);

    const homed: [string, SeriesStorageState][] = [...found.entries()];
    await batches_run(homed, SERIES_BULK_CONCURRENCY, async (
      [, state]: [string, SeriesStorageState]
    ): Promise<void> => {
      if (state.folderPath === null) return;
      state.fileCount = await folderFiles_count(client, state.folderPath);
    });
    return Ok(found);
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("warning", `Bulk series storage lookup failed: ${message}`);
    return Err();
  }
}

/**
 * Counts the PACS files registered under one folder.
 *
 * Asks for a single row and reads the total, since the count is the whole
 * question and the rows are not wanted.
 *
 * @param client - The connected CUBE client.
 * @param folderPath - The folder, with or without its leading slash.
 * @returns The number of files, or zero when CUBE will not say.
 */
async function folderFiles_count(client: Client, folderPath: string): Promise<number> {
  const fname: string = folderPath.startsWith("/") ? folderPath.slice(1) : folderPath;
  const probe: Awaited<ReturnType<typeof client.getPACSFiles>> =
    await client.getPACSFiles({ fname, limit: 1 });
  const total: number | undefined = probe.totalCount;
  if (typeof total === "number" && total > 0) return total;
  const items: ReturnType<typeof probe.getItems> = probe.getItems();
  return items ? items.length : 0;
}

/**
 * Runs work over a list, a bounded number at a time.
 *
 * @param items - What to work through.
 * @param width - How many at once.
 * @param work - What to do with one item.
 */
async function batches_run<T>(
  items: ReadonlyArray<T>,
  width: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  for (let start: number = 0; start < items.length; start += width) {
    await Promise.all(items.slice(start, start + width).map(work));
  }
}

/**
 * Reports the retrieve status for a PACS query.
 *
 * @param queryId - ID of the PACS query to inspect.
 * @returns Result wrapping the status report, or Err on failure.
 */
export async function pacsRetrieve_statusForQuery(
  queryId: number
): Promise<Result<PACSQueryStatusReport>> {
  try {
    const decodedResult: Result<PACSQueryDecodedResult> = await pacsQuery_resultDecode(queryId);
    if (!decodedResult.ok) return Err();

    const decoded: PACSQueryDecodedResult = decodedResult.value;
    if (!decoded.json) {
      errorStack.stack_push("error", `Query ${queryId} has no decoded JSON result.`);
      return Err();
    }

    const { retrieveStatus, retrieveId } = await retrieve_latestFromQuery(queryId);
    const payloadArray: Record<string, unknown>[] = studies_extractFromDecoded(decoded.json);
    const studies: StudyRetrieveStatus[] = [];

    for (const obj of payloadArray) {
      if (!obj || typeof obj !== "object") continue;
      studies.push(await studySeries_buildStatus(obj as Record<string, unknown>));
    }

    return Ok({ queryId, retrieveStatus, retrieveId, studies });
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to generate status report for query ${queryId}: ${errorMessage}`);
    return Err();
  }
}
