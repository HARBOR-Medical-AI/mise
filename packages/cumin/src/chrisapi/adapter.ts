/**
 * @file ChRIS API adapter — the single seam between cumin and `@fnndsc/chrisapi`.
 *
 * This module is the only place in cumin that imports `@fnndsc/chrisapi` and
 * the only place allowed to cast against its objects. The chrisapi typings
 * lag the real API surface (missing methods, untyped `data` payloads), so
 * every other module works through the small set of generics exported here:
 * lifecycle (`authToken_get`, `client_create`), payload extractors
 * (`listData_get`, `itemData_get`, `items_get`, `collectionItems_get`),
 * dynamic dispatch for methods absent from the typings (`resource_call`),
 * client-shape helpers (`client_authGet`, `client_adminUrlEnsure`), and the
 * multipart posts chrisapi cannot stream (`client_adminPluginUpload`,
 * `client_userFileUpload`).
 *
 * Domain modules pass their own target type `T`; the adapter performs the
 * cast. This keeps the unsafe surface auditable in one file and gives tests
 * a single boundary to stub.
 *
 * @module
 */

import { pace_isPageMethod, pace_note } from './pace.js';
import { rows_check, shape_object, ShapeError, type Shape } from './shape.js';
import Client, { ListResource, PACSRetrieve, Request } from '@fnndsc/chrisapi';

/**
 * The chrisapi Client class, re-exported as a value.
 *
 * Kept as a value (not `export type`) because downstream packages call
 * static methods such as `Client.getAuthToken` through cumin's public API.
 */
export { Client };

export type {
  ListResource,
  Resource,
  ItemResource,
  User,
  Group,
  GroupUser,
  GroupUserList,
  UserGroupList,
  GroupList,
  ComputeResourceList,
  PluginInstance,
  PluginList,
  Feed,
  CommentList,
  Note,
  Comment,
  FileBrowserFolder,
  UserFile,
  PACSFile,
  PipelineSourceFile,
  PipelineSourceFileList,
  Tag,
  TagList,
  Tagging,
  FeedTagList,
  FeedTaggingList,
  TagFeedList,
} from '@fnndsc/chrisapi';

/**
 * Authentication slice of a connected chrisapi Client.
 *
 * The chrisapi typings omit the `auth` property although it exists at
 * runtime on every connected client.
 *
 * @property cubeUrl - Base URL of the CUBE instance, when present.
 * @property token - The bearer token for the current session.
 */
export interface ClientAuth {
  cubeUrl?: string;
  token: string;
  [key: string]: unknown;
}

/**
 * Requests an authentication token from a CUBE auth endpoint.
 *
 * @param authUrl - Full URL of the CUBE `auth-token/` endpoint.
 * @param user - Username to authenticate as.
 * @param password - Password for the user.
 * @returns The bearer token string.
 * @throws {Error} Propagates chrisapi/network errors (e.g. bad credentials).
 */
export async function authToken_get(
  authUrl: string,
  user: string,
  password: string,
): Promise<string> {
  return Client.getAuthToken(authUrl, user, password);
}

/**
 * Creates a chrisapi Client bound to a CUBE URL and bearer token.
 *
 * @param url - Base URL of the CUBE API (e.g. `https://cube/api/v1/`).
 * @param token - Bearer token obtained from `authToken_get`.
 * @returns A connected Client instance.
 */
export function client_create(url: string, token: string): Client {
  return rootLinks_share(new Client(url, { token }));
}

/**
 * How long a client waits for a page of the feed list. The API root is the
 * feed list, and CUBE counts every visible feed's jobs before it answers a
 * page: for an identity that sees thousands of feeds that can take longer
 * than chrisapi's 30 s default (#1280, FNNDSC/ChRIS_ultron_backEnd#746).
 */
export const FEED_LIST_TIMEOUT_MS: number = 120_000;

/** How long a token check waits: it reads one small page. */
export const TOKEN_CHECK_TIMEOUT_MS: number = 30_000;

/** How a client whose root read is shared is marked, so it is wrapped once. */
const ROOT_SHARED: unique symbol = Symbol('rootLinks_shared');

/** The one method the share wraps, and the mark it leaves. */
interface RootLinksClient {
  setUrls?: (timeout?: number) => Promise<unknown>;
  [ROOT_SHARED]?: boolean;
}

/**
 * Makes a client read its API root once, for every caller, at the feed
 * list's timeout. chrisapi reads the root to learn its links the first
 * time any call lacks one, at its 30 s default, and calls that arrive
 * together each start their own read. A read that fails is not kept: the
 * next caller asks again. Idempotent.
 *
 * @param client - A chrisapi Client.
 * @returns The same client, its `setUrls` shared.
 */
export function rootLinks_share(client: Client): Client {
  const wrapped: RootLinksClient = client as RootLinksClient;
  if (wrapped[ROOT_SHARED] === true || typeof wrapped.setUrls !== 'function') return client;
  wrapped[ROOT_SHARED] = true;
  const read: (timeout?: number) => Promise<unknown> = wrapped.setUrls.bind(client);
  let pending: Promise<unknown> | null = null;
  wrapped.setUrls = (): Promise<unknown> => {
    if (pending === null) {
      pending = read(FEED_LIST_TIMEOUT_MS).catch((error: unknown): never => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
  return client;
}

/**
 * Proves a token against CUBE without reading its root. chrisapi's own
 * check (`getUser`) reads the root first to learn the user's link, and the
 * root is the feed list (#1280); `users/` answers at once, and CUBE refuses
 * a token it does not know there with a 401.
 *
 * @param url - Base URL of the CUBE API, ending in `/`.
 * @param token - The token to prove.
 * @param timeout - How long to wait for the answer.
 * @throws {Error} chrisapi's error: carrying CUBE's response when it
 *   refused, "No server response!" when nothing came back.
 */
export async function token_verify(url: string, token: string, timeout: number = TOKEN_CHECK_TIMEOUT_MS): Promise<void> {
  await new Request({ token }, 'application/vnd.collection+json', timeout).get(`${url}users/`);
}

/**
 * Reads the runtime `auth` slice of a connected client.
 *
 * @param client - A connected chrisapi Client.
 * @returns The client's auth object (token and, when present, cubeUrl).
 */
export function client_authGet(client: Client): ClientAuth {
  return (client as unknown as { auth: ClientAuth }).auth;
}

/**
 * Resolves the admin URL of a client, populating client URLs if needed.
 *
 * Non-admin users have no admin link; for them this resolves to null.
 *
 * @param client - A connected chrisapi Client.
 * @returns The admin URL string, or null when the user has no admin access.
 */
export async function client_adminUrlEnsure(client: Client): Promise<string | null> {
  const slice: { adminUrl?: string; setUrls?: () => Promise<void> } =
    client as unknown as { adminUrl?: string; setUrls?: () => Promise<void> };
  if (!slice.adminUrl && typeof slice.setUrls === 'function') {
    // Deliberate absorption: setUrls failing and "no admin link" have the
    // same meaning for this probe (no admin access), and callers surface the
    // null with their own authorization message.
    await slice.setUrls().catch(() => undefined);
  }
  return slice.adminUrl ?? null;
}

/**
 * Executes a collection+json request against an administrative CUBE child URL.
 *
 * @param client - Connected CUBE client whose token authorizes the request.
 * @param path - Relative path below CUBE's advertised administrative endpoint.
 * @param method - Supported HTTP method.
 * @param data - Optional Collection+JSON template fields for a POST request.
 * @returns The decoded HTTP response document.
 * @throws {Error} When the client has no advertised administrative endpoint.
 */
export async function client_adminRequest(
  client: Client,
  path: string,
  method: 'get' | 'post',
  data?: Record<string, string>,
): Promise<unknown> {
  const adminURL: string | null = await client_adminUrlEnsure(client);
  if (!adminURL) throw new Error('Administrator privileges are required.');
  const request: Request = new Request(client_authGet(client), 'application/vnd.collection+json');
  const url: string = new URL(path, adminURL.endsWith('/') ? adminURL : `${adminURL}/`).toString();
  if (method === 'get') return (await request.get(url)).data;
  const template = { template: { data: Object.entries(data ?? {}).map(([name, value]) => ({ name, value })) } };
  // Posted directly rather than through chrisapi's Request: on a refusal
  // whose body is not Collection+JSON (Django REST's field errors are plain
  // JSON), chrisapi replaces the message with "Bad server response!" and
  // overwrites the body with it, so CUBE's reason never reached anyone.
  const response: Response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${client_authGet(client).token}`,
      'Content-Type': 'application/vnd.collection+json',
      Accept: 'application/vnd.collection+json',
    },
    body: JSON.stringify(template),
  });
  const text: string = await response.text();
  if (!response.ok) throw new Error(`CUBE refused POST ${url} (HTTP ${response.status}): ${refusalReason_extract(text)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`CUBE answered HTTP ${response.status} with a body that is not JSON`);
  }
}

/**
 * What an administrative plugin upload registers: a descriptor's JSON text,
 * or the URL of a plugin in another CUBE, which CUBE fetches itself.
 */
export type PluginAdminSource =
  | { readonly descriptor: string }
  | { readonly storeUrl: string };

/**
 * Registers one plugin through CUBE's administrative upload.
 *
 * Posted as multipart directly rather than through chrisapi: on a refusal
 * whose body is not Collection+JSON (Django REST's field errors are plain
 * JSON), chrisapi replaces CUBE's reason with "Bad server response!", and
 * a sync that names why each plugin failed needs that reason.
 *
 * @param client - Connected CUBE client whose token authorizes the upload.
 * @param computeNames - Compute resources to register the plugin on.
 * @param source - The descriptor text (field `fname`) or a store URL (field `plugin_store_url`).
 * @returns The registered plugin's fields, decoded from the Collection+JSON item.
 * @throws {Error} When the client has no administrative endpoint, or CUBE refuses (its reason in the message).
 */
export async function client_adminPluginUpload(
  client: Client,
  computeNames: string[],
  source: PluginAdminSource,
): Promise<Record<string, unknown>> {
  const adminURL: string | null = await client_adminUrlEnsure(client);
  if (!adminURL) throw new Error('Administrator privileges are required.');
  const form: FormData = new FormData();
  form.append('compute_names', computeNames.join(','));
  if ('descriptor' in source) {
    form.append('fname', new Blob([source.descriptor], { type: 'application/json' }), 'descriptor.json');
  } else {
    form.append('plugin_store_url', source.storeUrl);
  }
  const response: Response = await fetch(adminURL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${client_authGet(client).token}`,
      Accept: 'application/vnd.collection+json',
    },
    body: form,
  });
  const text: string = await response.text();
  if (!response.ok) throw new Error(`CUBE refused the plugin (HTTP ${response.status}): ${refusalReason_extract(text)}`);
  return collectionItemFields_decode(text);
}

/**
 * Posts one file to CUBE's user files, the multipart form chrisapi's
 * `uploadFile` sends, over fetch.
 *
 * fetch reads a form's file only as the connection takes its bytes, so a
 * file whose reads are watched (cumin's `upload_watchStalls`) shows the
 * upload's real progress; chrisapi's own client reads the whole file before
 * it is sent, and holds a fixed 30 s deadline over the whole request.
 *
 * @param client - Connected CUBE client whose token authorizes the upload.
 * @param uploadPath - The file's full CUBE path, without a leading slash.
 * @param file - The bytes, under the name they are sent as.
 * @param signal - Abandons the request (and its socket) when aborted; the
 *   abort's reason is what the returned promise rejects with.
 * @returns The new file's fields (`id`, `fname`, …), decoded from the Collection+JSON item.
 * @throws {Error} When CUBE refuses (its reason in the message), or the signal's reason.
 */
export async function client_userFileUpload(
  client: Client,
  uploadPath: string,
  file: File,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!client.userFilesUrl) await client.setUrls();
  const form: FormData = new FormData();
  form.append('upload_path', uploadPath);
  form.append('fname', file);
  const response: Response = await fetch(client.userFilesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Token ${client_authGet(client).token}`,
      Accept: 'application/vnd.collection+json',
    },
    body: form,
    signal,
  });
  const text: string = await response.text();
  if (!response.ok) throw new Error(`CUBE refused the upload (HTTP ${response.status}): ${refusalReason_extract(text)}`);
  return collectionItemFields_decode(text);
}

/**
 * Decodes the first item of a Collection+JSON document into its fields.
 *
 * @param text - The response body.
 * @returns The item's `name`/`value` pairs as a record; empty when the body holds no item.
 */
export function collectionItemFields_decode(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const items: unknown = (parsed as { collection?: { items?: unknown } } | null)?.collection?.items;
  const first: unknown = Array.isArray(items) ? items[0] : undefined;
  const data: unknown = (first as { data?: unknown } | undefined)?.data;
  const fields: Record<string, unknown> = {};
  if (Array.isArray(data)) {
    for (const datum of data) {
      const pair: { name?: unknown; value?: unknown } = datum as { name?: unknown; value?: unknown };
      if (typeof pair.name === 'string') fields[pair.name] = pair.value;
    }
  }
  return fields;
}

/**
 * CUBE's own words for a refusal, from whatever body it sent: a
 * Collection+JSON error, Django REST field errors (\`{"username": ["…"]}\`)
 * or a \`detail\`, else the body itself.
 *
 * @param body - The response body, as text.
 * @returns The reason, one line.
 */
export function refusalReason_extract(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // An HTML error page (Django's own 403 or 500) says why in its text:
    // the title, the heading, the first paragraph. Styles and scripts go.
    const text: string = body
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 300) || 'no reason given';
  }
  const record: Record<string, unknown> = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const collection: { error?: { message?: unknown } } | undefined = record['collection'] as { error?: { message?: unknown } } | undefined;
  if (collection?.error?.message !== undefined) return refusalReason_extract(String(collection.error.message));
  if (typeof record['detail'] === 'string') return record['detail'];
  const parts: string[] = Object.entries(record).map(([field, value]): string =>
    `${field}: ${Array.isArray(value) ? value.map(String).join(' ') : String(value)}`);
  return parts.length > 0 ? parts.join('; ') : 'no reason given';
}

/**
 * Narrows an arbitrary resource to a chrisapi ListResource.
 *
 * @param resource - Any value to test.
 * @returns True when the value is a ListResource instance.
 */
export function resource_isList(resource: unknown): resource is ListResource {
  return resource instanceof ListResource;
}

// What an answer must look like before it is used as its type: every reader below takes a shape, and those
// who read through this seam get the means to write one from it.
export { rows_check, shape_build, shape_nullable, shape_object, ShapeError, type Shape, type ShapeField } from './shape.js';

/**
 * Anything that may carry a `data` payload.
 *
 * @example
 * const logs: DataCarrier = await resource_call(resource, DATA_CARRIER_SHAPE, 'getLogs');
 */
export interface DataCarrier {
  /** The payload, when there is one; read through a shape of its own. */
  data?: unknown;
}

/**
 * A list resource, as far as its items are read.
 *
 * @example
 * const page: ItemsCarrier = await client.getGroups();
 */
export interface ItemsCarrier {
  /** What is called for the items; looked at before it is called. */
  getItems?: unknown;
}

/**
 * Anything that may carry a `data` payload: held only to being an object,
 * its `data` read through `listData_get` or `itemData_get` with a shape of
 * its own.
 */
export const DATA_CARRIER_SHAPE: Shape<DataCarrier> = shape_object<DataCarrier>('a resource');

/**
 * Reads the `data` of a list resource as rows of a shape.
 *
 * Absence and malformation are two answers. No `data` at all (or no list)
 * is an empty list. `data` that is there and is not an array, or a row
 * that is not what the shape says is read, is a `ShapeError`: a listing
 * short by rows it does not mention is never returned.
 *
 * @param list - A chrisapi list resource (or anything carrying `data`).
 * @param shape - The shape of a row.
 * @returns The rows; empty when there is no `data`.
 * @throws {ShapeError} When `data` is present and is not a list of the shape.
 */
export function listData_get<T>(list: { data?: unknown } | null | undefined, shape: Shape<T>): T[] {
  const data: unknown = list?.data;
  if (data === undefined || data === null) return [];
  return rows_check(data, shape, 'data');
}

/**
 * Reads the `data` of an item resource as a shape.
 *
 * @param item - A chrisapi item resource (or anything carrying `data`).
 * @param shape - The shape of the data.
 * @returns The data; null when there is none.
 * @throws {ShapeError} When `data` is present and is not what the shape says is read.
 */
export function itemData_get<T>(item: { data?: unknown } | null | undefined, shape: Shape<T>): T | null {
  const data: unknown = item?.data;
  return data === undefined || data === null ? null : shape.value_check(data, 'data');
}

/**
 * Reads the items of a list resource as a shape each.
 *
 * @param list - A chrisapi list resource exposing `getItems()`; null or undefined for none.
 * @param shape - The shape of an item.
 * @returns The items; empty when there is no list, or it has no items.
 * @throws {ShapeError} When the list has no `getItems` to call, what it returns is not a list, or an item is not what the shape says is read.
 */
export function items_get<T>(list: ItemsCarrier | null | undefined, shape: Shape<T>): T[] {
  if (list === undefined || list === null) return [];
  const read: unknown = list.getItems;
  if (typeof read !== 'function') throw new ShapeError(`a list of ${shape.what}`, 'getItems', read === undefined ? 'missing' : `a ${typeof read}`, 'a function');
  const items: unknown = (read as () => unknown).call(list);
  if (items === undefined || items === null) return [];
  return rows_check(items, shape, 'items');
}

/**
 * Reads the collection+json items embedded in a resource as a shape each.
 *
 * @param resource - A chrisapi resource carrying a `collection` document.
 * @param shape - The shape of an item.
 * @returns The items; empty when there is no collection, or it has no items.
 * @throws {ShapeError} When the collection is present and is not a document, or its items are present and are not a list of the shape.
 */
export function collectionItems_get<T>(
  resource: { collection?: unknown } | null | undefined,
  shape: Shape<T>,
): T[] {
  const collection: unknown = resource?.collection;
  if (collection === undefined || collection === null) return [];
  // A collection that is there and is not a document is malformed, not empty.
  if (typeof collection !== 'object' || Array.isArray(collection)) throw new ShapeError(`a list of ${shape.what}`, 'collection', Array.isArray(collection) ? 'an array' : `a ${typeof collection}`, 'an object');
  const items: unknown = (collection as { items?: unknown }).items;
  if (items === undefined || items === null) return [];
  return rows_check(items, shape, 'collection.items');
}

/**
 * Invokes a method on a chrisapi object that its typings do not declare,
 * and hands back what it answered as it is: unknown.
 *
 * Used for client/resource methods that exist at runtime but are missing or
 * mistyped in `@fnndsc/chrisapi` (e.g. `createWorkflow`,
 * `getPipelineSourceFiles`, `_post`, `put` with a `path` body). For a call
 * whose answer is not read (a delete, a put), or is read only after checks
 * of the caller's own. A caller that reads the answer as a type uses
 * `resource_call`, which holds it to a shape.
 *
 * @param obj - The chrisapi object to dispatch on.
 * @param methodName - Name of the runtime method to invoke.
 * @param args - Arguments forwarded to the method.
 * @returns The method's resolved value, unchecked and untyped.
 * @throws {Error} When the named method does not exist on the object.
 */
export async function resource_invoke(
  obj: object,
  methodName: string,
  ...args: unknown[]
): Promise<unknown> {
  const method: unknown = (obj as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') {
    throw new Error(`chrisapi object has no method '${methodName}'`);
  }
  if (!pace_isPageMethod(methodName)) {
    return (method as (...callArgs: unknown[]) => Promise<unknown>).apply(obj, args);
  }
  // A page fetch is timed: the pace register is how a surface turns a
  // walk's page count into minutes.
  const startedAt: number = performance.now();
  const result: unknown = await (method as (...callArgs: unknown[]) => Promise<unknown>).apply(obj, args);
  pace_note(Math.round(performance.now() - startedAt));
  return result;
}

/**
 * Invokes a method on a chrisapi object and holds what it answers to a shape.
 *
 * @param obj - The chrisapi object to dispatch on.
 * @param shape - The shape of the answer.
 * @param methodName - Name of the runtime method to invoke.
 * @param args - Arguments forwarded to the method.
 * @returns The answer, as the shape's type.
 * @throws {Error} When the named method does not exist on the object.
 * @throws {ShapeError} When the answer is not what the shape says is read.
 *
 * @example
 * const logs: DataCarrier = await resource_call(resource, DATA_CARRIER_SHAPE, 'getLogs');
 */
export async function resource_call<T>(
  obj: object,
  shape: Shape<T>,
  methodName: string,
  ...args: unknown[]
): Promise<T> {
  return shape.value_check(await resource_invoke(obj, methodName, ...args));
}

/**
 * Tests whether a chrisapi object exposes a named runtime method.
 *
 * Companion to `resource_call` for methods that are legitimately optional
 * across CUBE/chrisapi versions (e.g. `getPublicFeeds`, `getLogs`).
 *
 * @param obj - The chrisapi object to probe.
 * @param methodName - Name of the method to look for.
 * @returns True when the object has a callable property of that name.
 */
export function method_exists(obj: object, methodName: string): boolean {
  return typeof (obj as Record<string, unknown>)[methodName] === 'function';
}

/**
 * Deletes a PACS retrieve resource addressed by URL.
 *
 * The chrisapi Client offers no delete-by-id for retrieves, so the resource
 * is constructed directly from its REST URL and the client's auth.
 *
 * @param retrieveUrl - Full REST URL of the retrieve resource.
 * @param auth - Auth slice of the connected client (from `client_authGet`).
 */
export async function pacsRetrieve_deleteByUrl(
  retrieveUrl: string,
  auth: ClientAuth,
): Promise<void> {
  const retrieve: PACSRetrieve = new PACSRetrieve(retrieveUrl, auth);
  await retrieve.delete();
}

/**
 * One file's bytes, from whichever CUBE resource serves them: the shape
 * cumin's downloads read (`data`, `getFileStream`, `getFileBlob`).
 *
 * @property data - The file's fields (`fname`, `fsize`, ...).
 */
export interface FileBytesSource {
  data: Record<string, unknown>;
  getFileStream(timeout?: number): Promise<unknown>;
  getFileBlob(timeout?: number): Promise<unknown>;
}

/**
 * A file through the file browser (`/filebrowser/files/<id>/`), the
 * resource CUBE serves a feed's files under to everyone the feed is
 * shared with. `/userfiles/<id>/` refuses the same file (403) to anyone
 * but its owner, so a colleague's shared output could be listed and not
 * downloaded (ekanite, 2026-10-14: file 30916964, 200 here, 403 there).
 *
 * @param client - The connected client.
 * @param fileId - The file's id.
 * @returns The file, or null when the file browser does not serve it.
 * @throws {Error} When CUBE refuses; the caller reads the status from it.
 */
export async function filebrowserFile_get(client: Client, fileId: number): Promise<FileBytesSource | null> {
  const base: string = String(client.url ?? '').replace(/\/?$/, '/');
  const auth: ClientAuth = client_authGet(client);
  const listing: Request = new Request(auth, 'application/vnd.collection+json');
  const document = (await listing.get(`${base}filebrowser/files/${fileId}/`)).data as {
    collection?: { items?: Array<{ data?: Array<{ name: string; value: unknown }>; links?: Array<{ rel: string; href: string }> }> };
  };
  const item = document.collection?.items?.[0];
  const href: string | undefined = item?.links?.find((link: { rel: string }): boolean => link.rel === 'file_resource')?.href;
  if (item === undefined || href === undefined) return null;
  const data: Record<string, unknown> = Object.fromEntries((item.data ?? []).map((field: { name: string; value: unknown }): [string, unknown] => [field.name, field.value]));
  return {
    data,
    getFileStream: (timeout: number = 30000): Promise<unknown> =>
      new Request(auth, 'application/octet-stream', timeout).getStream(href),
    getFileBlob: async (timeout: number = 30000): Promise<unknown> =>
      (await new Request(auth, 'application/octet-stream', timeout).get(href)).data,
  };
}

