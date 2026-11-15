/**
 * @file `berth`: the anchors of the berth a session runs in. `berth` lists
 * them, `berth anchor` downloads a ChRIS path into one, `berth close` returns
 * the outgoing folder to ChRIS as one node (berthClose.ts), `berth drop`
 * removes one anchor, and `berth clear` removes them all and empties the
 * outgoing folder.
 *
 * An anchor is a mount in the shell's sense: any ChRIS path the person can
 * read, downloaded through the CUBE API with the session's token into
 * `<anchors>/<name>/`. The path alone says whether it has a node: under the
 * person's own `/home/<user>/feeds/` the plugin instance the path runs
 * through is its node, and a node not `finishedSuccessfully` is refused;
 * anywhere else it has none. The size is said before the download, above
 * 10 GB it asks, and what does not fit is refused. The files move through the
 * transfer pool, 8 at a time unless `-j` or `TRANSFER_JOBS` says otherwise;
 * an anchor is whole or not made, so a file that fails after its retry is
 * named and nothing is anchored. The files downloaded lose their write
 * permission, and the state file keeps what was downloaded, for the close.
 *
 * Declared in one record (`berthCommand`): the subcommands, their operands
 * and options, an anchor's name a ChRIS argument kind (`anchor`) that
 * completes from the berth's state.
 *
 * Key components:
 * - berthCommand: the declaration: the verb and its subcommands.
 * - builtin_berth: the declaration run over words already split.
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
import { transferPool_run, type TransferFailure, type TransferPoolResult } from '@fnndsc/cumin/transfer-pool';
import { size_format } from '@fnndsc/fond';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';

import { command_declare, type CommandArguments, type CommandGrammar, type SubcommandArguments } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { commandUsage_render } from '../../core/commandUsage.js';
import { exitCode_set } from '../../core/handlerRun.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { TRANSFER_JOBS_OPTION, transferJobs_resolve, type TransferJobs } from '../fs/transferJobs.js';
import { repl_confirm } from '../../core/question.js';
import { sink_dataLine, sink_get } from '../../core/sink.js';
import {
  berthHome_get, berthPath_resolve, nodeStatus_get, remoteEntry_read, remoteFile_locate, remoteFile_open, remoteFiles_memoRun, remoteTree_list,
  type RemoteBytes, type RemoteEntry, type RemoteFile,
} from './berthCube.js';
import { close_run, WORK_TITLE } from './berthClose.js';
import { freeBytes_get } from './berthDisk.js';
import {
  BERTH_STATE_FILE, berthPlaces_read, berthState_read, berthState_update,
  type AnchoredFile, type BerthAnchor, type BerthPlaces, type BerthState,
} from './berthState.js';
import { anchorNode_show, BerthRefusal, bytes_sum, columns_render, count_say } from './berthWords.js';

/** The size above which an anchor asks before it downloads: 10 GB. */
export const ANCHOR_ASK_BYTES: number = 10 * 1024 ** 3;

/** The one status of a node whose output is anchored. */
const NODE_FINISHED: string = 'finishedSuccessfully';

/** The prefix of the folder an anchor is downloaded into before it takes its name. */
const PARTIAL_PREFIX: string = '.partial-';

/** The write bits a downloaded file loses. */
const WRITE_BITS: number = 0o222;

/** What a `berth anchor` line holds. */
type AnchorRequest = SubcommandArguments<typeof BERTH_GRAMMAR, 'anchor'>;

/**
 * The anchor subcommand's usage line, from the declaration.
 *
 * @returns The line.
 */
function anchorUsage_get(): string {
  return commandUsage_render(berthCommand, 'anchor');
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
 * Writes one ChRIS file to the berth's disk, without its write permission.
 *
 * @param file - The file to read.
 * @param target - Where it is written.
 * @param bytes_add - Told the bytes as they arrive, and told them back (negative) when the attempt fails.
 * @param signal - The transfer pool's signal: a cancel stops the stream where it is.
 * @throws {Error} When the file cannot be read or written.
 */
async function file_download(file: RemoteFile, target: string, bytes_add: (count: number) => void, signal: AbortSignal): Promise<void> {
  let counted: number = 0;
  const count_add = (count: number): void => { counted += count; bytes_add(count); };
  try {
    mkdirSync(dirname(target), { recursive: true });
    const bytes: RemoteBytes = await remoteFile_open(file.source);
    if (Buffer.isBuffer(bytes.stream)) {
      writeFileSync(target, bytes.stream);
      count_add(bytes.stream.length);
    } else {
      bytes.stream.on('data', (chunk: Buffer): void => count_add(chunk.length));
      await pipeline(bytes.stream, createWriteStream(target), { signal });
    }
    chmodSync(target, statSync(target).mode & ~WRITE_BITS);
  } catch (error: unknown) {
    // A retry counts its bytes again: the progress takes this attempt's back.
    bytes_add(-counted);
    throw error;
  }
}

/**
 * Downloads files into a folder through the transfer pool, saying the bytes
 * as they arrive across every file in flight.
 *
 * @param files - The files.
 * @param folder - The folder they are written under, by their relative names.
 * @param label - The anchor's name, for the progress.
 * @param jobs - How many files move at once.
 * @throws {Error} Naming each file that failed after its retry, or saying the line was cancelled.
 */
async function files_download(files: readonly RemoteFile[], folder: string, label: string, jobs: number): Promise<void> {
  mkdirSync(folder, { recursive: true });
  const total: number = bytes_sum(files);
  let current: number = 0;
  const progress = (phase: 'transferring' | 'complete'): void => sink_get().progress_write({
    operation: 'download', kind: 'transfer', phase, label, current, total, unit: 'bytes',
    status: phase === 'complete' ? 'done' : 'running',
  });
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();
  const result: TransferPoolResult<RemoteFile, void> = await remoteFiles_memoRun(() => transferPool_run(files,
    (file: RemoteFile, poolSignal: AbortSignal): Promise<void> => file_download(file, join(folder, ...file.name.split('/')),
      (count: number): void => { current += count; progress('transferring'); }, poolSignal),
    { jobs, ...(signal !== undefined ? { signal } : {}) }));
  if (result.cancelled.length > 0) {
    throw new Error(`cancelled with ${count_say(result.cancelled.length, 'file')} not downloaded`);
  }
  if (result.failed.length > 0) {
    const named: string = result.failed.map((failure: TransferFailure<RemoteFile>): string => `${failure.item.name} (${failure.reason})`).join(', ');
    throw new Error(`${count_say(result.failed.length, 'file')} of ${files.length} failed: ${named}`);
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
    throw new BerthRefusal(`anchor: the anchor ${name} holds ${standing.path}; name this one: ${anchorUsage_get().replace('[name]', '<name>')}`);
  }
  if (standing !== undefined && !request.options.refresh) {
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
  return repl_confirm(`berth: anchor: download ${size_format(bytes)} into ${join(places.anchors, name)}?`);
}

/**
 * `berth anchor <path> [name] [--refresh] [--yes] [-j N]`: downloads a ChRIS path
 * into `<anchors>/<name>/` and records it.
 *
 * @param request - The line.
 * @returns What was anchored, or the refusal.
 * @throws {BerthRefusal} As the steps refuse.
 */
async function anchor_run(request: AnchorRequest): Promise<CommandEnvelope> {
  const places: BerthPlaces = places_require('anchor');
  const jobs: TransferJobs = transferJobs_resolve(request.options.jobs);
  if ('refused' in jobs) throw new BerthRefusal(`anchor: ${jobs.refused}`);
  const typed: string = request.operands.path;
  const resolved: string = await berthPath_resolve(typed);
  const source: AnchorSource = await anchorSource_find(resolved, await berthHome_get());
  const name: string = request.operands.name ?? source.defaultName;
  anchorName_check(name);
  const standing: BerthAnchor | null = anchorName_claim(places, name, source, request);
  await nodeFinished_check(source);
  const files: RemoteFile[] = await sourceFiles_list(source, typed);
  const freed: number = standing === null ? 0 : bytes_sum(standing.files);
  if (!await anchorSize_settle(places, name, files, freed, request.options.yes)) {
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
    await files_download(files, partial, name, jobs.jobs);
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
    return envelope_ok(`no anchors in ${places.anchors}; ${anchorUsage_get()} downloads one\n${chalk.gray(closed)}\n`);
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
 * @param name - The anchor's name.
 * @returns What was dropped.
 * @throws {BerthRefusal} For no anchor of that name.
 */
function drop_run(name: string): CommandEnvelope {
  const places: BerthPlaces = places_require('drop');
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
 * @returns What was removed, or that nothing was.
 */
async function clear_run(): Promise<CommandEnvelope> {
  const places: BerthPlaces = places_require('clear');
  const state: BerthState = berthState_read(places.anchors);
  const since: number | null = state.lastClosedAt === null ? null : Date.parse(state.lastClosedAt);
  const unclosed: string[] = filesChanged_list(places.outgoing, since);
  if (unclosed.length > 0) {
    const asked: string = `berth: clear: ${places.outgoing} holds ${count_say(unclosed.length, 'file')} not yet closed; remove them and every anchor?`;
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

/** What a `berth` line may hold. */
const BERTH_GRAMMAR = {
  bare: { summary: 'List the anchors: name, ChRIS path, node or none, files, size, when anchored; and when the berth last closed' },
  subcommands: {
    anchor: {
      summary: 'Download a ChRIS path you can read into <anchors>/<name>/, named by its last part unless a name is given',
      operands: [
        { name: 'path', kind: 'cfsPath', glob: true, summary: 'The ChRIS path: a file or folder you can read' },
        { name: 'name', kind: 'word', optional: true, summary: "The anchor's name; the path's last part when none is given" },
      ],
      options: {
        refresh: { long: 'refresh', summary: 'Download an anchor that stands again' },
        yes: { short: 'y', long: 'yes', summary: 'Answer yes to the question above 10 GB' },
        jobs: TRANSFER_JOBS_OPTION,
      },
    },
    close: {
      summary: 'Upload the outgoing folder, with berth.json, to ~/berth/<uuid>/ and make it one node: pl-dsdircopy, a child of the node every anchor is under, or pl-dircopy, a new feed\'s root, when none is',
      options: {
        infeed: { long: 'infeed', summary: "A child of that anchor's node", value: { name: 'anchor', kind: 'anchor' } },
        newfeed: { long: 'newfeed', summary: 'A new feed of the work alone, every anchor named in berth.json' },
        name: { long: 'name', summary: "The new feed's name", value: { name: 'feed', kind: 'word' } },
        title: { long: 'title', summary: `The node's title (${WORK_TITLE})`, value: { name: 'text', kind: 'word' } },
        force: { short: 'f', long: 'force', summary: 'Answer yes when your processes still run' },
      },
    },
    drop: {
      summary: 'Remove one anchor; ChRIS still holds it',
      operands: [{ name: 'name', kind: 'anchor', summary: 'The anchor' }],
    },
    clear: { summary: 'Remove every anchor and empty the outgoing folder; asks first when it holds files not yet closed' },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `berth` line, saying a refusal in POSIX tone.
 *
 * @param args - The line, parsed.
 * @returns The answer, or the refusal.
 */
async function berth_run(args: CommandArguments<typeof BERTH_GRAMMAR>): Promise<CommandEnvelope> {
  try {
    switch (args.subcommand) {
      case null: return berth_list();
      case 'anchor': return await anchor_run(args);
      case 'drop': return drop_run(args.operands.name);
      case 'clear': return await clear_run();
      case 'close': return await close_run(places_require('close'), {
        infeed: args.options.infeed ?? null,
        newfeed: args.options.newfeed,
        name: args.options.name ?? null,
        title: args.options.title ?? WORK_TITLE,
        force: args.options.force,
      });
    }
  } catch (error: unknown) {
    if (error instanceof BerthRefusal) return berth_refuse(error.message);
    const reason: string = error instanceof Error ? error.message : String(error);
    return berth_refuse(args.subcommand === null ? reason : `${args.subcommand}: ${reason}`);
  }
}

/**
 * `berth [anchor … | close … | drop <name> | clear]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [berthCommand] }, 'backend');
 * ```
 */
export const berthCommand = command_declare({
  name: 'berth',
  grammar: BERTH_GRAMMAR,
  help: {
    summary: "The ChRIS paths downloaded into this session's berth, and the work returned: anchor, list, close, drop, clear",
    description: "Anchor ChRIS paths in this session's berth: download each into the anchors folder, list them, return the outgoing folder to ChRIS as one node, drop one, or clear them all. Under your own ~/feeds an anchor has a node, the plugin instance its path runs through, which must be finishedSuccessfully; anywhere else (uploads, PACS, /PUBLIC, /SHARED) it has none. Anchors of two nodes, or of a node and of none, want --infeed or --newfeed to close, never both. A close removes nothing. An anchor's files move 8 at a time (-j N, or the session variable TRANSFER_JOBS, 1 to 32); a file that fails is tried once more, and an anchor with a file that still fails is named and not made. help anchors says more. On a host, not in a berth, berth says so and refuses the subcommands.",
    category: 'Workflows',
    examples: [
      'berth',
      'berth anchor ~/feeds/feed_5/pl-dircopy_7/pl-fshack_41/data/sub-01',
      'berth anchor ~/uploads/weights',
      'berth anchor /PUBLIC/atlas/weights atlas-weights',
      'berth anchor ~/uploads/weights --refresh',
      'berth anchor -j 16 ~/uploads/study',
      'berth close',
      'berth close --title "sub-01 segmentation"',
      'berth close --infeed sub-01',
      'berth close --newfeed --name "unet weights"',
      'berth drop sub-01',
      'berth clear',
    ],
  },
  // A berth's anchors are the berth's own disk: anchoring reads CUBE and
  // writes there, and changes no piece of the session.
  holds: [],
  handler: berth_run,
});

/**
 * `berth` over words already split: the declaration's parse and handler.
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
  return declaredCommand_run(berthCommand, args);
}
