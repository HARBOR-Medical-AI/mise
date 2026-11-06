/**
 * @file Plugin indexes: where descriptors come from, and reading them.
 *
 * A plugin index is a set of plugin descriptors, one JSON file per plugin at
 * its latest version, in the form CUBE's administrative upload takes, with
 * the JSON Schema they follow beside them. FNNDSC/chris-plugins is the one
 * that matters; a directory of `.json` files or a `.tar.gz` holding one is
 * an index too, on CUBE (how a surface with no host access syncs) or on the
 * host.
 *
 * Every source reads to the same {@link PluginIndex}: its descriptors as
 * text (so a later check can quote the file), the schema when one came with
 * them, and the commit when the source can name one. GitHub's archive of a
 * ref is fetched once, whole; its pax global header names the exact commit.
 *
 * Layout read from any source: descriptors are the `.json` files at the root
 * or under `plugins/`; the schema is `schema/plugin.schema.json` at the root
 * or one level up (a `plugins/` directory handed over on its own).
 *
 * Key components:
 * - PluginIndexSource: a parsed source (GitHub repository at a ref, CUBE path, host path).
 * - PluginIndex: the descriptors, schema and commit read from a source.
 * - pluginIndexSource_parse: read a source word (`FNNDSC/chris-plugins@main`, `host:./plugins`).
 * - pluginIndexArchive_read: read an index from archive bytes.
 * - pluginIndex_load: read an index from any source.
 *
 * Typical usage:
 * ```ts
 * const source: PluginIndexSource | null = pluginIndexSource_parse('FNNDSC/chris-plugins@main', 'cube');
 * const loaded: Result<PluginIndex> = source ? await pluginIndex_load(source) : Err();
 * ```
 *
 * Dependencies: Node.js built-ins (`node:fs`, `node:path`), `fetch` for the
 * GitHub archive, salsa's CUBE file reads for CUBE paths.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

import { errorStack, Err, Ok, type Result } from '@fnndsc/cumin';

import { fileContent_get, fileContent_getBinary, files_listRecursive, type FsItem } from '../files/index.js';
import { tarArchive_read, type TarArchive, type TarFile } from './tar_read.js';

/** Where GitHub serves a repository's archive of a ref. */
const GITHUB_TARBALL_URL: string = 'https://api.github.com/repos';

/** The ref read when a GitHub source names none. */
const DEFAULT_REF: string = 'main';

/** File name of the index's JSON Schema. */
const SCHEMA_FILE: string = 'plugin.schema.json';

/** Archive extensions read as a single archive rather than a directory. */
const ARCHIVE_PATTERN: RegExp = /\.(tar\.gz|tgz|tar)$/i;

/** A GitHub repository word: `owner/repo`, optionally `@ref`. */
const GITHUB_PATTERN: RegExp = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@(\S+))?$/;

/**
 * Where an index is read from.
 *
 * @example
 * ```ts
 * const source: PluginIndexSource = { kind: 'github', owner: 'FNNDSC', repo: 'chris-plugins', ref: 'main' };
 * ```
 */
export type PluginIndexSource =
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string; readonly ref: string }
  | { readonly kind: 'cube'; readonly path: string }
  | { readonly kind: 'host'; readonly path: string };

/**
 * One descriptor file of an index.
 *
 * @example
 * ```ts
 * const descriptor: IndexDescriptor = { file: 'pl-dircopy.json', text: '{"name":"pl-dircopy"}' };
 * ```
 */
export interface IndexDescriptor {
  /** The file's name (`pl-dircopy.json`), which rule 3 holds to the plugin's name. */
  readonly file: string;
  /** The file's text, as read. */
  readonly text: string;
}

/**
 * An index, read.
 *
 * @example
 * ```ts
 * const index: PluginIndex = pluginIndexArchive_read(bytes, 'FNNDSC/chris-plugins@main');
 * index.descriptors.length;
 * ```
 */
export interface PluginIndex {
  /** The source as the operator would write it. */
  readonly source: string;
  /** A short name for headers: `chris-plugins @ 8c9a1f6`. */
  readonly label: string;
  /** The full commit the descriptors were read at, when the source names one. */
  readonly commit: string | null;
  /** Every descriptor, sorted by file name. */
  readonly descriptors: IndexDescriptor[];
  /** The parsed JSON Schema, or null when none came with the descriptors. */
  readonly schema: unknown;
}

/**
 * One file of an index, its path relative to the index's root.
 */
interface IndexEntry {
  /** Path relative to the root, `/`-separated (`plugins/pl-x.json`, `../schema/plugin.schema.json`). */
  readonly path: string;
  /** The file's text. */
  readonly text: string;
}

/**
 * Parses an index source word.
 *
 * `owner/repo[@ref]` is a GitHub repository; `host:<path>` a host path;
 * `cube:<path>` a CUBE path. Any other word is a path, read where `bare`
 * says: `plugin sync` reads a bare path on CUBE, `plugin validate` (which
 * needs no CUBE) on the host.
 *
 * @param word - The source as typed.
 * @param bare - Where a path with no prefix is read.
 * @param ref - A ref overriding the word's own (`--ref`), for a GitHub source.
 * @returns The parsed source, or null for an empty word.
 *
 * @example
 * ```ts
 * pluginIndexSource_parse('FNNDSC/chris-plugins@v1', 'cube'); // { kind: 'github', …, ref: 'v1' }
 * pluginIndexSource_parse('host:./plugins', 'cube');          // { kind: 'host', path: './plugins' }
 * ```
 */
export function pluginIndexSource_parse(word: string, bare: 'cube' | 'host', ref?: string): PluginIndexSource | null {
  const trimmed: string = word.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('host:')) return { kind: 'host', path: trimmed.slice('host:'.length) };
  if (trimmed.startsWith('cube:')) return { kind: 'cube', path: trimmed.slice('cube:'.length) };
  const github: RegExpExecArray | null = trimmed.startsWith('.') ? null : GITHUB_PATTERN.exec(trimmed);
  if (github !== null && github[1] !== undefined && github[2] !== undefined) {
    return { kind: 'github', owner: github[1], repo: github[2], ref: ref ?? github[3] ?? DEFAULT_REF };
  }
  return { kind: bare, path: trimmed };
}

/**
 * Renders a source as the operator would write it.
 *
 * @param source - The parsed source.
 * @returns The source word (`FNNDSC/chris-plugins@main`, `host:./plugins`, `cube:/home/u/plugins`).
 *
 * @example
 * ```ts
 * pluginIndexSource_format({ kind: 'host', path: './plugins' }); // 'host:./plugins'
 * ```
 */
export function pluginIndexSource_format(source: PluginIndexSource): string {
  if (source.kind === 'github') return `${source.owner}/${source.repo}@${source.ref}`;
  return `${source.kind}:${source.path}`;
}

/**
 * Reads an index from archive bytes.
 *
 * A single top folder (GitHub's `FNNDSC-chris-plugins-<sha>/`) is the root;
 * the pax global header's `comment` is the commit.
 *
 * @param bytes - The archive, gzipped or plain.
 * @param source - The source word, for the index's `source` and `label`.
 * @returns The index.
 * @throws {Error} When the archive is unreadable, an entry's path is unsafe,
 *   or the schema it carries is not JSON.
 *
 * @example
 * ```ts
 * const index: PluginIndex = pluginIndexArchive_read(readFileSync('index.tar.gz'), 'FNNDSC/chris-plugins@main');
 * ```
 */
export function pluginIndexArchive_read(bytes: Buffer, source: string): PluginIndex {
  const archive: TarArchive = tarArchive_read(bytes);
  const root: string = archiveRoot_find(archive.files);
  const entries: IndexEntry[] = archive.files
    .filter((file: TarFile): boolean => file.path.startsWith(root))
    .map((file: TarFile): IndexEntry => ({ path: file.path.slice(root.length), text: file.content.toString('utf8') }));
  const commit: string | null = archive.globals['comment'] ?? null;
  return pluginIndex_assemble(source, commit, entries);
}

/**
 * Reads an index from its source.
 *
 * @param source - The parsed source.
 * @param fetcher - The fetch used for GitHub; the global one by default.
 * @returns The index, or an error on the error stack (the fetch failed, the
 *   path is not there, the archive is unreadable).
 *
 * @example
 * ```ts
 * const loaded: Result<PluginIndex> = await pluginIndex_load({ kind: 'host', path: './plugins' });
 * ```
 */
export async function pluginIndex_load(source: PluginIndexSource, fetcher: typeof fetch = fetch): Promise<Result<PluginIndex>> {
  const word: string = pluginIndexSource_format(source);
  try {
    if (source.kind === 'github') return Ok(await pluginIndexGitHub_fetch(source, fetcher));
    if (source.kind === 'host') return Ok(await pluginIndexHost_read(source.path, word));
    return await pluginIndexCube_read(source.path, word);
  } catch (error: unknown) {
    errorStack.stack_push('error', `plugin index ${word}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Fetches a GitHub repository's archive of a ref and reads it.
 *
 * @param source - The GitHub source.
 * @param fetcher - The fetch to use.
 * @returns The index.
 * @throws {Error} When GitHub does not answer with the archive.
 */
async function pluginIndexGitHub_fetch(
  source: { readonly owner: string; readonly repo: string; readonly ref: string },
  fetcher: typeof fetch,
): Promise<PluginIndex> {
  const url: string = `${GITHUB_TARBALL_URL}/${source.owner}/${source.repo}/tarball/${encodeURIComponent(source.ref)}`;
  const response: Response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${url}`);
  const bytes: Buffer = Buffer.from(await response.arrayBuffer());
  return pluginIndexArchive_read(bytes, `${source.owner}/${source.repo}@${source.ref}`);
}

/**
 * Reads an index from a host path: a directory or an archive.
 *
 * @param path - The host path.
 * @param word - The source word.
 * @returns The index.
 * @throws {Error} When the path cannot be read.
 */
async function pluginIndexHost_read(path: string, word: string): Promise<PluginIndex> {
  if (ARCHIVE_PATTERN.test(path)) return pluginIndexArchive_read(await fs.readFile(path), word);
  const entries: IndexEntry[] = [];
  for (const [relative, directory] of [['', path], ['plugins/', nodePath.join(path, 'plugins')]] as const) {
    const names: string[] = await directoryNames_read(directory);
    for (const name of names.filter((candidate: string): boolean => candidate.endsWith('.json'))) {
      entries.push({ path: `${relative}${name}`, text: await fs.readFile(nodePath.join(directory, name), 'utf8') });
    }
  }
  for (const relative of [`schema/${SCHEMA_FILE}`, `../schema/${SCHEMA_FILE}`]) {
    const text: string | null = await fs.readFile(nodePath.join(path, relative), 'utf8').catch((): null => null);
    if (text !== null) entries.push({ path: relative, text });
  }
  return pluginIndex_assemble(word, null, entries);
}

/**
 * Lists a host directory's file names, or none when it is not there.
 *
 * @param directory - The host directory.
 * @returns Its entries' names; empty when the directory does not exist.
 * @throws {Error} On a read failure other than absence.
 */
async function directoryNames_read(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
}

/**
 * Reads an index from a CUBE path: a directory or an uploaded archive.
 *
 * @param path - The CUBE path, absolute.
 * @param word - The source word.
 * @returns The index, or an error on the error stack.
 */
async function pluginIndexCube_read(path: string, word: string): Promise<Result<PluginIndex>> {
  if (ARCHIVE_PATTERN.test(path)) {
    const bytes: Result<Buffer> = await fileContent_getBinary(path);
    return bytes.ok ? Ok(pluginIndexArchive_read(bytes.value, word)) : Err();
  }
  const root: string = path.replace(/\/+$/, '');
  const items: FsItem[] = await files_listRecursive(root);
  const entries: IndexEntry[] = [];
  for (const item of items.filter((candidate: FsItem): boolean => candidate.type === 'file')) {
    const relative: string = item.path.replace(/^\/+/, '').slice(root.replace(/^\/+/, '').length + 1);
    if (!/^(plugins\/)?[^/]+\.json$/.test(relative) && relative !== `schema/${SCHEMA_FILE}`) continue;
    const text: Result<string> = await fileContent_get(`${root}/${relative}`);
    if (!text.ok) return Err();
    entries.push({ path: relative, text: text.value });
  }
  if (!entries.some((entry: IndexEntry): boolean => entry.path.endsWith(SCHEMA_FILE))) {
    const above: Result<string> = await fileContent_get(`${nodePath.posix.dirname(root)}/schema/${SCHEMA_FILE}`);
    // An index handed over without its schema is still an index; rule 1
    // then says it was not checked rather than this read failing.
    if (above.ok) entries.push({ path: `../schema/${SCHEMA_FILE}`, text: above.value });
    else errorStack.stack_pop();
  }
  return Ok(pluginIndex_assemble(word, null, entries));
}

/**
 * Finds an archive's single top folder, the index's root.
 *
 * @param files - The archive's files.
 * @returns The root with its trailing slash, or '' when the files share none.
 */
function archiveRoot_find(files: readonly TarFile[]): string {
  const tops: Set<string> = new Set(files.map((file: TarFile): string => file.path.split('/')[0] ?? ''));
  const top: string | undefined = [...tops][0];
  return tops.size === 1 && top !== undefined && files.every((file: TarFile): boolean => file.path.includes('/')) ? `${top}/` : '';
}

/**
 * Builds an index from its files, by the layout every source shares.
 *
 * @param source - The source word.
 * @param commit - The commit, when the source names one.
 * @param entries - The files, relative to the root.
 * @returns The index.
 * @throws {Error} When the schema file is not JSON.
 */
function pluginIndex_assemble(source: string, commit: string | null, entries: readonly IndexEntry[]): PluginIndex {
  const descriptors: IndexDescriptor[] = entries
    .filter((entry: IndexEntry): boolean => /^(plugins\/)?[^/]+\.json$/.test(entry.path) && !entry.path.endsWith(SCHEMA_FILE))
    .map((entry: IndexEntry): IndexDescriptor => ({ file: entry.path.replace(/^plugins\//, ''), text: entry.text }))
    .sort((a: IndexDescriptor, b: IndexDescriptor): number => a.file.localeCompare(b.file));
  const schemaEntry: IndexEntry | undefined =
    entries.find((entry: IndexEntry): boolean => entry.path === `schema/${SCHEMA_FILE}`)
    ?? entries.find((entry: IndexEntry): boolean => entry.path === `../schema/${SCHEMA_FILE}`);
  let schema: unknown = null;
  if (schemaEntry !== undefined) {
    try {
      schema = JSON.parse(schemaEntry.text) as unknown;
    } catch {
      throw new Error(`${schemaEntry.path} is not JSON`);
    }
  }
  return { source, label: indexLabel_build(source, commit), commit, descriptors, schema };
}

/**
 * Builds an index's short name for headers.
 *
 * @param source - The source word.
 * @param commit - The commit, when known.
 * @returns `chris-plugins @ 8c9a1f6` for a repository, else the source word.
 */
function indexLabel_build(source: string, commit: string | null): string {
  const github: RegExpExecArray | null = GITHUB_PATTERN.exec(source);
  if (github === null || source.includes(':')) return commit === null ? source : `${source} @ ${commit.slice(0, 7)}`;
  return `${github[2] ?? source} @ ${commit === null ? (github[3] ?? DEFAULT_REF) : commit.slice(0, 7)}`;
}
