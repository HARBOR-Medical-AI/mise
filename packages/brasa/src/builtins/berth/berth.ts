/**
 * @file `berth`: the anchors of the berth a session runs in. `berth` lists
 * them, `berth anchor` downloads a ChRIS path into one, `berth drop` removes
 * one, and `berth clear` removes them all and empties the outgoing folder.
 *
 * An anchor is a mount in the shell's sense: any ChRIS path the person can
 * read, downloaded through the CUBE API with the session's token into
 * `<anchors>/<name>/`. The path alone says whether it has a node: under the
 * person's own `/home/<user>/feeds/` the plugin instance the path runs
 * through is its node, and a node not `finishedSuccessfully` is refused;
 * anywhere else it has none. The size is said before the download, above
 * 10 GB it asks, and what does not fit is refused. The files downloaded lose
 * their write permission, and the state file keeps what was downloaded, for
 * the close.
 *
 * Key components:
 * - builtin_berth: the verb and its subcommands.
 * - BERTH_USAGE: its usage line.
 * - ANCHOR_ASK_BYTES: the size above which an anchor asks first.
 *
 * Typical usage:
 * ```ts
 * await builtin_berth(['anchor', '~/feeds/feed_5/pl-fshack_41/data/sub-01']);
 * await builtin_berth([]);
 * await builtin_berth(['drop', 'sub-01']);
 * ```
 *
 * Dependencies: the berth's places from the environment (berthState.ts);
 * ChRIS through berthCube.ts; the session's sink and question.
 *
 * @module
 */
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';

import chalk from 'chalk';
import { size_format } from '@fnndsc/fond';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';

import { exitCode_set } from '../../core/handlerRun.js';
import { repl_confirm } from '../../core/question.js';
import { sink_dataLine, sink_get } from '../../core/sink.js';
import {
  berthHome_get, berthPath_resolve, nodeStatus_get, remoteEntry_read, remoteFile_locate, remoteFile_open, remoteTree_list,
  type RemoteBytes, type RemoteEntry, type RemoteFile,
} from './berthCube.js';
import { freeBytes_get } from './berthDisk.js';
import {
  BERTH_STATE_FILE, berthPlaces_read, berthState_read, berthState_update,
  type AnchoredFile, type BerthAnchor, type BerthPlaces, type BerthState,
} from './berthState.js';

/** The verb's usage line. */
export const BERTH_USAGE: string = 'berth [anchor <path> [name] [--refresh] [--yes] | drop <name> | clear]';

/** The anchor subcommand's usage line. */
const ANCHOR_USAGE: string = 'berth anchor <path> [name] [--refresh] [--yes]';

/** The size above which an anchor asks before it downloads: 10 GB. */
export const ANCHOR_ASK_BYTES: number = 10 * 1024 ** 3;

/** The one status of a node whose output is anchored. */
const NODE_FINISHED: string = 'finishedSuccessfully';

/** The prefix of the folder an anchor is downloaded into before it takes its name. */
const PARTIAL_PREFIX: string = '.partial-';

/** The write bits a downloaded file loses. */
const WRITE_BITS: number = 0o222;

/** A refusal: the verb's words for it, and an exit status of 1. */
class BerthRefusal extends Error {
  /**
   * @param message - The words after `berth: `.
   */
  constructor(message: string) {
    super(message);
    this.name = 'BerthRefusal';
  }
}

/** What `berth anchor` was asked. */
interface AnchorRequest {
  /** The path as typed. */
  readonly typed: string;
  /** The name given, if one was. */
  readonly name: string | undefined;
  /** Download again an anchor that stands. */
  readonly refresh: boolean;
  /** Answer the size question yes. */
  readonly yes: boolean;
}

/** Where an anchor's path stands: what is downloaded, and its node. */
interface AnchorSource {
  /** The ChRIS path downloaded (a node's `data` when the path names the node itself). */
  readonly path: string;
  /** The name the anchor takes unless one is given. */
  readonly defaultName: string;
  /** The plugin instance, under the person's own feeds; else null. */
  readonly node: number | null;
  /** The node's feed; else null. */
  readonly feed: number | null;
  /** The node's folder name (`pl-fshack_41`), for the words; else null. */
  readonly nodeName: string | null;
}

/**
 * Says a refusal on the error channel and fails the line.
 *
 * @param message - The words after `berth: `.
 * @returns The error envelope.
 */
function berth_refuse(message: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(`berth: ${message}`)}\n`);
}

/**
 * The berth's places, or a refusal for a session on a host.
 *
 * @param subcommand - The subcommand refused, for the words.
 * @returns The places.
 * @throws {BerthRefusal} When the session runs on a host.
 */
function places_require(subcommand: string): BerthPlaces {
  const places: BerthPlaces | null = berthPlaces_read();
  if (places === null) throw new BerthRefusal(`${subcommand}: this session runs on the host, not in a berth`);
  return places;
}

/**
 * Reads `berth anchor`'s words.
 *
 * @param args - The words after `anchor`.
 * @returns The request.
 * @throws {BerthRefusal} For an unknown option, or a missing or extra operand.
 */
function anchorRequest_parse(args: readonly string[]): AnchorRequest {
  const operands: string[] = [];
  let refresh: boolean = false;
  let yes: boolean = false;
  for (const arg of args) {
    if (arg === '--refresh') refresh = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg.startsWith('-') && arg !== '-') throw new BerthRefusal(`anchor: unknown option ${arg}; ${ANCHOR_USAGE}`);
    else operands.push(arg);
  }
  if (operands.length === 0 || operands.length > 2) throw new BerthRefusal(`anchor: usage: ${ANCHOR_USAGE}`);
  return { typed: operands[0] as string, name: operands[1], refresh, yes };
}

/**
 * Refuses a name that cannot be a folder of the anchors place: empty, with a
 * `/`, `.` or `..`, or starting with `.` (the state file's and a download's own).
 *
 * @param name - The anchor's name.
 * @throws {BerthRefusal} For a name that cannot be one.
 */
function anchorName_check(name: string): void {
  if (name === '' || name.includes('/') || name.startsWith('.')) {
    throw new BerthRefusal(`anchor: ${name === '' ? 'an empty name' : name} cannot name an anchor; a name is one folder name, not starting with .`);
  }
}

/**
 * Where a resolved path stands: under the person's own feeds its node is
 * the plugin instance it runs through, and a path that names the node's own
 * folder is its output, `data`; anywhere else it has no node.
 *
 * @param resolved - The absolute ChRIS path.
 * @param home - The person's home, `/home/<user>`.
 * @returns The source.
 * @throws {BerthRefusal} For a path in the person's feeds that is at no node.
 */
async function anchorSource_find(resolved: string, home: string): Promise<AnchorSource> {
  const defaultName: string = posix.basename(resolved);
  if (!resolved.startsWith(`${home.replace(/\/$/, '')}/feeds/`)) {
    return { path: resolved, defaultName, node: null, feed: null, nodeName: null };
  }
  const { path_extractFeedID, path_extractPluginInstanceID } = await import('@fnndsc/cumin');
  const node: number | null = path_extractPluginInstanceID(resolved);
  const feed: number | null = path_extractFeedID(resolved);
  if (node === null || feed === null) {
    throw new BerthRefusal(`anchor: ${resolved} is in your feeds but not at a node (…/feeds/feed_N/pl-x_ID)`);
  }
  const segments: string[] = resolved.split('/');
  const nodeName: string = [...segments].reverse().find((segment: string): boolean => segment.endsWith(`_${node}`)) ?? `${node}`;
  // A path that ends at the node's own folder names the node, whose output
  // is its data: its child nodes are other nodes, not this one's output.
  const path: string = segments[segments.length - 1] === nodeName ? `${resolved}/data` : resolved;
  return { path, defaultName, node, feed, nodeName };
}

/**
 * Refuses a node CUBE does not report as finished: its output is incomplete
 * and may change under the work.
 *
 * @param source - The anchor's source.
 * @throws {BerthRefusal} When the node is anything but finishedSuccessfully.
 */
async function nodeFinished_check(source: AnchorSource): Promise<void> {
  if (source.node === null) return;
  const status: string = await nodeStatus_get(source.node);
  if (status !== NODE_FINISHED) {
    throw new BerthRefusal(`anchor: ${source.nodeName ?? source.node} is ${status}, not ${NODE_FINISHED}; its output may still change`);
  }
}

/**
 * The sum of the sizes of some files.
 *
 * @param files - The files.
 * @returns Their bytes.
 */
function bytes_sum(files: ReadonlyArray<{ readonly size: number }>): number {
  return files.reduce((total: number, file: { readonly size: number }): number => total + file.size, 0);
}

/**
 * A count with its noun, `1 file`, `3 files`.
 *
 * @param count - The count.
 * @param noun - The noun, singular.
 * @returns The words.
 */
function count_say(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Writes one ChRIS file to the berth's disk, without its write permission.
 *
 * @param file - The file to read.
 * @param target - Where it is written.
 * @param bytes_add - Told the bytes as they arrive.
 */
async function file_download(file: RemoteFile, target: string, bytes_add: (count: number) => void): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const bytes: RemoteBytes = await remoteFile_open(file.source);
  if (Buffer.isBuffer(bytes.stream)) {
    writeFileSync(target, bytes.stream);
    bytes_add(bytes.stream.length);
  } else {
    bytes.stream.on('data', (chunk: Buffer): void => bytes_add(chunk.length));
    await pipeline(bytes.stream, createWriteStream(target));
  }
  chmodSync(target, statSync(target).mode & ~WRITE_BITS);
}

/**
 * Downloads files into a folder, saying the bytes as they arrive.
 *
 * @param files - The files.
 * @param folder - The folder they are written under, by their relative names.
 * @param label - The anchor's name, for the progress.
 */
async function files_download(files: readonly RemoteFile[], folder: string, label: string): Promise<void> {
  mkdirSync(folder, { recursive: true });
  const total: number = bytes_sum(files);
  let current: number = 0;
  const progress = (phase: 'transferring' | 'complete'): void => sink_get().progress_write({
    operation: 'download', kind: 'transfer', phase, label, current, total, unit: 'bytes',
    status: phase === 'complete' ? 'done' : 'running',
  });
  for (const file of files) {
    await file_download(file, join(folder, ...file.name.split('/')), (count: number): void => { current += count; progress('transferring'); });
  }
  progress('complete');
}

/**
 * The files of a source: one file, or every file under a folder.
 *
 * @param source - The anchor's source.
 * @param typed - The path as typed, for the words.
 * @returns The files.
 * @throws {BerthRefusal} When nothing stands at the path.
 */
async function sourceFiles_list(source: AnchorSource, typed: string): Promise<RemoteFile[]> {
  const entry: RemoteEntry | null = await remoteEntry_read(source.path);
  if (entry === null) throw new BerthRefusal(`anchor: ${typed}: no such file or directory`);
  if (entry.kind === 'file') return [await remoteFile_locate(source.path, entry.size)];
  return remoteTree_list(source.path);
}

/**
 * Checks the name against the anchors that stand, and the folder it takes.
 *
 * @param places - The berth's places.
 * @param name - The anchor's name.
 * @param source - The anchor's source.
 * @param request - What was asked.
 * @returns The anchor of that name being refreshed, or null for a new one.
 * @throws {BerthRefusal} For a name another path holds, an anchor that stands without --refresh, or a folder that is not an anchor.
 */
function anchorName_claim(places: BerthPlaces, name: string, source: AnchorSource, request: AnchorRequest): BerthAnchor | null {
  const standing: BerthAnchor | undefined = berthState_read(places.anchors).anchors.find((anchor: BerthAnchor): boolean => anchor.name === name);
  if (standing !== undefined && standing.path !== source.path) {
    throw new BerthRefusal(`anchor: the anchor ${name} holds ${standing.path}; name this one: ${ANCHOR_USAGE.replace('[name]', '<name>')}`);
  }
  if (standing !== undefined && !request.refresh) {
    throw new BerthRefusal(`anchor: ${name} is anchored already; --refresh downloads it again`);
  }
  if (standing === undefined && existsSync(join(places.anchors, name))) {
    throw new BerthRefusal(`anchor: ${join(places.anchors, name)} is there and is not an anchor`);
  }
  return standing ?? null;
}

/**
 * Says the size and the room, and refuses or asks as the size wants: what
 * does not fit is refused, above {@link ANCHOR_ASK_BYTES} the person is asked.
 *
 * @param places - The berth's places.
 * @param name - The anchor's name.
 * @param files - The files to download.
 * @param freed - Bytes a refresh frees before it downloads.
 * @param yes - Whether the question is answered already.
 * @returns True to download, false when the person said no.
 * @throws {BerthRefusal} When it does not fit.
 */
async function anchorSize_settle(places: BerthPlaces, name: string, files: readonly RemoteFile[], freed: number, yes: boolean): Promise<boolean> {
  const bytes: number = bytes_sum(files);
  const room: number = freeBytes_get(places.anchors) + freed;
  sink_dataLine(`berth: anchor: ${name}: ${count_say(files.length, 'file')}, ${size_format(bytes)}; ${size_format(room)} free in ${places.anchors}`);
  if (bytes > room) {
    throw new BerthRefusal(`anchor: ${name} does not fit: ${size_format(bytes)} with ${size_format(room)} free; anchor a folder inside it`);
  }
  if (bytes <= ANCHOR_ASK_BYTES || yes) return true;
  return repl_confirm(`berth: anchor: download ${size_format(bytes)} into ${join(places.anchors, name)}? [y/N] `);
}

/**
 * `berth anchor <path> [name] [--refresh] [--yes]`: downloads a ChRIS path
 * into `<anchors>/<name>/` and records it.
 *
 * @param args - The words after `anchor`.
 * @returns What was anchored, or the refusal.
 * @throws {BerthRefusal} As the steps refuse.
 */
async function anchor_run(args: readonly string[]): Promise<CommandEnvelope> {
  const places: BerthPlaces = places_require('anchor');
  const request: AnchorRequest = anchorRequest_parse(args);
  const resolved: string = await berthPath_resolve(request.typed);
  const source: AnchorSource = await anchorSource_find(resolved, await berthHome_get());
  const name: string = request.name ?? source.defaultName;
  anchorName_check(name);
  const standing: BerthAnchor | null = anchorName_claim(places, name, source, request);
  await nodeFinished_check(source);
  const files: RemoteFile[] = await sourceFiles_list(source, request.typed);
  const freed: number = standing === null ? 0 : bytes_sum(standing.files);
  if (!await anchorSize_settle(places, name, files, freed, request.yes)) {
    exitCode_set(1);
    return envelope_ok(`berth: anchor: ${name}: nothing downloaded\n`);
  }

  const final: string = join(places.anchors, name);
  const partial: string = join(places.anchors, `${PARTIAL_PREFIX}${name}`);
  if (standing !== null) {
    // A refresh lets the old copy go first, as drop does: ChRIS still holds it.
    rmSync(final, { recursive: true, force: true });
    berthState_update(places.anchors, (state: BerthState): BerthState => ({ ...state, anchors: state.anchors.filter((anchor: BerthAnchor): boolean => anchor.name !== name) }));
  }
  rmSync(partial, { recursive: true, force: true });
  try {
    await files_download(files, partial, name);
  } catch (error: unknown) {
    rmSync(partial, { recursive: true, force: true });
    throw new BerthRefusal(`anchor: ${name}: ${error instanceof Error ? error.message : String(error)}; nothing anchored`);
  }
  renameSync(partial, final);
  const anchor: BerthAnchor = {
    name,
    path: source.path,
    node: source.node,
    feed: source.feed,
    files: files.map((file: RemoteFile): AnchoredFile => ({ name: file.name, size: file.size })),
    anchoredAt: new Date().toISOString(),
  };
  berthState_update(places.anchors, (state: BerthState): BerthState => ({ ...state, anchors: [...state.anchors, anchor] }));
  const node: string = source.nodeName === null ? 'no node' : `node ${source.nodeName}`;
  return envelope_ok(`${chalk.green(`${name}`)} ${chalk.gray(`${source.path} → ${final}  ${count_say(files.length, 'file')}, ${size_format(bytes_sum(files))}, ${node}`)}\n`);
}

/**
 * A time as the listing shows it: local date and minute.
 *
 * @param iso - An ISO 8601 time.
 * @returns `2026-11-13 10:22`, or the text as it is when it is not a time.
 */
function time_show(iso: string): string {
  const at: Date = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * The node column for an anchor: the node's folder name from its path, or none.
 *
 * @param anchor - The anchor.
 * @returns `pl-fshack_41`, or `none`.
 */
function anchorNode_show(anchor: BerthAnchor): string {
  if (anchor.node === null) return 'none';
  return anchor.path.split('/').reverse().find((segment: string): boolean => segment.endsWith(`_${anchor.node}`)) ?? String(anchor.node);
}

/**
 * Lays rows out in columns, each as wide as its widest cell.
 *
 * @param rows - The rows, the header first.
 * @returns The lines.
 */
function columns_render(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = (rows[0] ?? []).map((_cell: string, at: number): number => Math.max(...rows.map((row: readonly string[]): number => (row[at] ?? '').length)));
  return rows.map((row: readonly string[]): string => row.map((cell: string, at: number): string => (at === row.length - 1 ? cell : cell.padEnd(widths[at] ?? 0))).join('  ').trimEnd());
}

/**
 * `berth`: every anchor with its path, node, files, size and time, and when
 * the berth last closed; on a host, that the session runs there.
 *
 * @returns The listing.
 */
function berth_list(): CommandEnvelope {
  const places: BerthPlaces | null = berthPlaces_read();
  if (places === null) return envelope_ok('berth: this session runs on the host, not in a berth\n');
  const state: BerthState = berthState_read(places.anchors);
  const closed: string = `last close: ${state.lastClosedAt === null ? 'never' : time_show(state.lastClosedAt)}`;
  if (state.anchors.length === 0) {
    return envelope_ok(`no anchors in ${places.anchors}; ${ANCHOR_USAGE} downloads one\n${chalk.gray(closed)}\n`);
  }
  const rows: string[][] = [
    ['NAME', 'PATH', 'NODE', 'FILES', 'SIZE', 'ANCHORED'],
    ...state.anchors.map((anchor: BerthAnchor): string[] => [
      anchor.name, anchor.path, anchorNode_show(anchor), String(anchor.files.length), size_format(bytes_sum(anchor.files)), time_show(anchor.anchoredAt),
    ]),
  ];
  const [header, ...lines] = columns_render(rows);
  return envelope_ok(`${chalk.bold(header ?? '')}\n${lines.join('\n')}\n${chalk.gray(closed)}\n`);
}

/**
 * `berth drop <name>`: removes one anchor, with no question, since ChRIS still holds it.
 *
 * @param args - The words after `drop`.
 * @returns What was dropped.
 * @throws {BerthRefusal} For no name, or no anchor of that name.
 */
function drop_run(args: readonly string[]): CommandEnvelope {
  const places: BerthPlaces = places_require('drop');
  if (args.length !== 1) throw new BerthRefusal('drop: usage: berth drop <name>');
  const name: string = args[0] as string;
  const anchor: BerthAnchor | undefined = berthState_read(places.anchors).anchors.find((one: BerthAnchor): boolean => one.name === name);
  if (anchor === undefined) throw new BerthRefusal(`drop: no anchor named ${name}`);
  rmSync(join(places.anchors, name), { recursive: true, force: true });
  berthState_update(places.anchors, (state: BerthState): BerthState => ({ ...state, anchors: state.anchors.filter((one: BerthAnchor): boolean => one.name !== name) }));
  return envelope_ok(`${chalk.gray(`dropped ${name}; ChRIS still holds ${anchor.path}`)}\n`);
}

/**
 * The files under a folder changed since a time: every file when there is none.
 *
 * @param folder - The folder.
 * @param since - The time, in milliseconds since the epoch; null for every file.
 * @returns Their paths.
 */
function filesChanged_list(folder: string, since: number | null): string[] {
  const changed: string[] = [];
  const entries: Dirent[] = existsSync(folder) ? readdirSync(folder, { withFileTypes: true, recursive: true }) : [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const path: string = join(entry.parentPath, entry.name);
    const modified: number | undefined = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    if (since === null || modified === undefined || modified > since) changed.push(path);
  }
  return changed;
}

/**
 * Removes everything inside a folder, leaving the folder: a berth's places
 * are mounts, which the session does not remove.
 *
 * @param folder - The folder.
 */
function folder_empty(folder: string): void {
  if (!existsSync(folder)) return;
  for (const name of readdirSync(folder)) rmSync(join(folder, name), { recursive: true, force: true });
}

/**
 * `berth clear`: removes every anchor and empties the outgoing folder, asking
 * first only when the outgoing folder holds files not yet closed.
 *
 * @param args - The words after `clear`.
 * @returns What was removed, or that nothing was.
 * @throws {BerthRefusal} For any word after clear.
 */
async function clear_run(args: readonly string[]): Promise<CommandEnvelope> {
  const places: BerthPlaces = places_require('clear');
  if (args.length !== 0) throw new BerthRefusal('clear: usage: berth clear');
  const state: BerthState = berthState_read(places.anchors);
  const since: number | null = state.lastClosedAt === null ? null : Date.parse(state.lastClosedAt);
  const unclosed: string[] = filesChanged_list(places.outgoing, since);
  if (unclosed.length > 0) {
    const asked: string = `berth: clear: ${places.outgoing} holds ${count_say(unclosed.length, 'file')} not yet closed; remove them and every anchor? [y/N] `;
    if (!await repl_confirm(asked)) {
      exitCode_set(1);
      return envelope_ok('berth: clear: nothing removed\n');
    }
  }
  for (const name of readdirSync(places.anchors)) {
    if (name !== BERTH_STATE_FILE) rmSync(join(places.anchors, name), { recursive: true, force: true });
  }
  berthState_update(places.anchors, (now: BerthState): BerthState => ({ ...now, anchors: [] }));
  folder_empty(places.outgoing);
  return envelope_ok(`${chalk.gray(`cleared ${count_say(state.anchors.length, 'anchor')} and emptied ${places.outgoing}`)}\n`);
}

/**
 * `berth [anchor … | drop <name> | clear]`: the anchors of this session's berth.
 *
 * @param args - The words after `berth`.
 * @returns The answer, or a refusal in POSIX tone.
 *
 * @example
 * ```ts
 * await builtin_berth(['anchor', '~/uploads/weights', 'w']);
 * await builtin_berth([]); // the anchors
 * ```
 */
export async function builtin_berth(args: string[]): Promise<CommandEnvelope> {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === undefined) return berth_list();
    if (subcommand === 'anchor') return await anchor_run(rest);
    if (subcommand === 'drop') return drop_run(rest);
    if (subcommand === 'clear') return await clear_run(rest);
    if (berthPlaces_read() === null) return berth_refuse(`${subcommand}: this session runs on the host, not in a berth`);
    return berth_refuse(`${subcommand}: unknown subcommand; usage: ${BERTH_USAGE}`);
  } catch (error: unknown) {
    if (error instanceof BerthRefusal) return berth_refuse(error.message);
    const reason: string = error instanceof Error ? error.message : String(error);
    return berth_refuse(subcommand === undefined ? reason : `${subcommand}: ${reason}`);
  }
}
