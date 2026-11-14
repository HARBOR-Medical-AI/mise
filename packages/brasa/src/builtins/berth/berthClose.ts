/**
 * @file `berth close`: the berth's one outgoing folder returned to ChRIS as
 * one node, with no plugin of its own.
 *
 * The close writes `berth.json` into the outgoing folder, uploads the folder
 * to the person's CUBE files at `/home/<user>/berth/<uuid>/`, and makes the
 * node from it with the registered ds plugin `pl-dsdircopy`, whose `dir` is
 * that folder. Where the node goes follows from the anchors: every anchor
 * under one node of the person's feeds makes it a child of that node; no
 * anchor under their feeds makes a new feed, its root `pl-dircopy` over
 * every anchored path with the work its child, or with no anchor at all the
 * root `pl-dircopy` over the work itself. Anchors of two nodes, or of a node
 * and of none, are refused with the two choices, `--infeed <anchor>` and
 * `--newfeed`.
 *
 * Before the upload it asks when the person's processes still run in the
 * berth (`--force` answers), and says what changed in ChRIS under an anchor
 * with no node since it was anchored. A close that cannot make the node
 * keeps the upload and says so; nothing in the berth is removed, and a close
 * that made its node sets the state's `lastClosedAt`.
 *
 * Key components:
 * - close_run: the subcommand.
 * - CLOSE_USAGE: its usage line.
 * - WORK_PLUGIN, WORK_TITLE: the plugin the work's node runs, and the node's title unless one is given.
 *
 * Typical usage:
 * ```ts
 * await close_run(places, ['--title', 'seg run']);
 * ```
 *
 * Dependencies: the berth's places and state (berthState.ts); ChRIS through
 * berthCube.ts; the berth's processes from `/proc` (berthProcesses.ts); the
 * session's sink and question.
 *
 * @module
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { hostname } from 'node:os';
import { join, posix } from 'node:path';

import chalk from 'chalk';
import { size_format } from '@fnndsc/fond';
import { envelope_ok, type CommandEnvelope } from '@fnndsc/menu';

import { exitCode_set } from '../../core/handlerRun.js';
import { repl_confirm } from '../../core/question.js';
import { sink_dataLine } from '../../core/sink.js';
import {
  berthHome_get, feedName_set, feedRoot_create, folderContents_upload, pluginChild_run, remoteEntry_read, remoteTree_list,
  type AttachOutcome, type RemoteEntry, type RemoteFile, type UploadOutcome,
} from './berthCube.js';
import { processesOwn_list, type BerthProcess } from './berthProcesses.js';
import {
  anchorChanges_any, anchorChanges_compare, BERTH_RECORD_FILE, berthRecord_write, berthSource_read,
  type AnchorChanges, type BerthAttachment, type BerthPlacement, type BerthRecord, type PlacementChild, type RecordAnchor,
} from './berthRecord.js';
import { berthState_read, berthState_update, type AnchoredFile, type BerthAnchor, type BerthPlaces, type BerthState } from './berthState.js';
import { anchorNode_show, BerthRefusal, count_say, columns_render } from './berthWords.js';

/** The subcommand's usage line. */
export const CLOSE_USAGE: string = 'berth close [--infeed <anchor> | --newfeed] [--name <feed>] [--title <text>] [--force]';

/** The registered ds plugin the work's node runs: it copies its `dir` and does nothing else. */
export const WORK_PLUGIN: string = 'pl-dsdircopy';

/** The work node's title unless one is given. */
export const WORK_TITLE: string = 'berth work';

/** The environment variable naming the berth's image. */
const BERTH_IMAGE_ENV: string = 'MISE_BERTH_IMAGE';

/** The folder under the person's home the work is uploaded into, one folder per close. */
const BERTH_FILES_FOLDER: string = 'berth';

/** The options that take a value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(['--infeed', '--name', '--title']);

/** What `berth close` was asked. */
interface CloseRequest {
  /** The anchor whose node the work is a child of (`--infeed`); null when not given. */
  readonly infeed: string | null;
  /** A new feed whatever the anchors (`--newfeed`). */
  readonly newfeed: boolean;
  /** The new feed's name (`--name`); null when not given. */
  readonly name: string | null;
  /** The work node's title. */
  readonly title: string;
  /** Answer the running-process question yes (`--force`). */
  readonly force: boolean;
}

/** One option's word and its value, as typed. */
interface OptionWord {
  /** The option, `--name`. */
  readonly option: string;
  /** Its value, or null for a flag. */
  readonly value: string | null;
}

/**
 * Reads the option words of a close: `--opt value` and `--opt=value` alike.
 *
 * @param args - The words after `close`.
 * @returns The options in order.
 * @throws {BerthRefusal} For an operand, an unknown option, or an option missing its value.
 */
function closeWords_read(args: readonly string[]): OptionWord[] {
  const words: OptionWord[] = [];
  for (let at: number = 0; at < args.length; at += 1) {
    const arg: string = args[at] as string;
    const equals: number = arg.indexOf('=');
    const option: string = arg.startsWith('--') && equals !== -1 ? arg.slice(0, equals) : arg;
    if (VALUE_OPTIONS.has(option)) {
      const value: string | undefined = equals !== -1 && arg.startsWith('--') ? arg.slice(equals + 1) : args[(at += 1)];
      if (value === undefined || value === '') throw new BerthRefusal(`close: ${option} wants a value; ${CLOSE_USAGE}`);
      words.push({ option, value });
    } else if (arg === '--newfeed' || arg === '--force' || arg === '-f') {
      words.push({ option: arg === '-f' ? '--force' : arg, value: null });
    } else if (arg.startsWith('-')) {
      throw new BerthRefusal(`close: unknown option ${arg}; ${CLOSE_USAGE}`);
    } else {
      throw new BerthRefusal(`close: takes no operand (${arg}); ${CLOSE_USAGE}`);
    }
  }
  return words;
}

/**
 * Reads `berth close`'s words.
 *
 * @param args - The words after `close`.
 * @returns The request.
 * @throws {BerthRefusal} As {@link closeWords_read} does, and for `--infeed` with `--newfeed`.
 */
function closeRequest_parse(args: readonly string[]): CloseRequest {
  const words: OptionWord[] = closeWords_read(args);
  const last = (option: string): string | null => words.filter((word: OptionWord): boolean => word.option === option).at(-1)?.value ?? null;
  const has = (option: string): boolean => words.some((word: OptionWord): boolean => word.option === option);
  const request: CloseRequest = {
    infeed: last('--infeed'),
    newfeed: has('--newfeed'),
    name: last('--name'),
    title: last('--title') ?? WORK_TITLE,
    force: has('--force'),
  };
  if (request.infeed !== null && request.newfeed) throw new BerthRefusal('close: --infeed and --newfeed are two places; give one');
  return request;
}

/**
 * The files of the outgoing folder that are work: every file under it but
 * the record a close writes at its top.
 *
 * @param outgoing - The outgoing folder.
 * @returns Their paths and sizes.
 */
function outgoingFiles_list(outgoing: string): AnchoredFile[] {
  const entries: Dirent[] = existsSync(outgoing) ? readdirSync(outgoing, { withFileTypes: true, recursive: true }) : [];
  const record: string = join(outgoing, BERTH_RECORD_FILE);
  const files: AnchoredFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const path: string = join(entry.parentPath, entry.name);
    if (path === record) continue;
    files.push({ name: path, size: statSync(path, { throwIfNoEntry: false })?.size ?? 0 });
  }
  return files;
}

/**
 * The words for an anchor and its node: `sub-01 (pl-fshack_41)`.
 *
 * @param anchor - The anchor.
 * @returns The words.
 */
function anchorWithNode_say(anchor: BerthAnchor): string {
  return anchor.node === null ? `${anchor.name} (no node)` : `${anchor.name} (${anchorNode_show(anchor)})`;
}

/**
 * The work as a child of an anchor's node.
 *
 * @param anchor - The anchor, with a node.
 * @param by - What decided it.
 * @returns The placement.
 */
function childOf_place(anchor: BerthAnchor & { readonly node: number }, by: 'anchors' | '--infeed'): PlacementChild {
  return { kind: 'child', by, parent: anchor.node, parentName: anchorNode_show(anchor), feed: anchor.feed, anchor: by === '--infeed' ? anchor.name : null };
}

/**
 * Where the work's node goes, from the anchors and the flags: a child of
 * the one node every anchor is under, or a new feed when no anchor is under
 * a node; `--infeed` and `--newfeed` choose, and anchors of two nodes, or of
 * a node and of none, want one of them.
 *
 * @param anchors - The berth's anchors.
 * @param request - What was asked.
 * @returns The placement.
 * @throws {BerthRefusal} For anchors that point two ways with no flag, an `--infeed` anchor that is not there or has no node, and `--name` for a node in a feed that stands.
 */
function closePlacement_decide(anchors: readonly BerthAnchor[], request: CloseRequest): BerthPlacement {
  const name: string = request.name ?? request.title;
  const inputs: string[] = anchors.map((anchor: BerthAnchor): string => anchor.path);
  let placement: BerthPlacement;
  if (request.newfeed) {
    placement = { kind: 'newFeed', by: '--newfeed', name, inputs };
  } else if (request.infeed !== null) {
    const chosen: BerthAnchor | undefined = anchors.find((anchor: BerthAnchor): boolean => anchor.name === request.infeed);
    if (chosen === undefined) throw new BerthRefusal(`close: --infeed: no anchor named ${request.infeed}`);
    if (chosen.node === null) throw new BerthRefusal(`close: --infeed: ${chosen.name} has no node; --infeed takes an anchor under a node of your feeds, or --newfeed makes a new feed`);
    placement = childOf_place({ ...chosen, node: chosen.node }, '--infeed');
  } else {
    placement = anchorsPlacement_decide(anchors, name, inputs);
  }
  if (placement.kind === 'child' && request.name !== null) {
    throw new BerthRefusal(`close: --name names a new feed; the work goes into feed ${placement.feed ?? '?'} under ${placement.parentName}`);
  }
  return placement;
}

/**
 * Where the anchors alone put the work, with no flag given.
 *
 * @param anchors - The berth's anchors.
 * @param name - The new feed's name, should there be one.
 * @param inputs - Every anchored path.
 * @returns The placement.
 * @throws {BerthRefusal} For anchors of two nodes, or of a node and of none.
 */
function anchorsPlacement_decide(anchors: readonly BerthAnchor[], name: string, inputs: readonly string[]): BerthPlacement {
  const noded: BerthAnchor[] = anchors.filter((anchor: BerthAnchor): boolean => anchor.node !== null);
  if (noded.length === 0) return { kind: 'newFeed', by: 'anchors', name, inputs };
  const first: BerthAnchor = noded[0] as BerthAnchor;
  const other: BerthAnchor | undefined = noded.find((anchor: BerthAnchor): boolean => anchor.node !== first.node);
  const none: BerthAnchor | undefined = anchors.find((anchor: BerthAnchor): boolean => anchor.node === null);
  const choices: string = 'a node has one parent: --infeed <anchor> makes the work a child of that anchor\'s node, --newfeed a new feed over every anchor';
  if (other !== undefined) {
    throw new BerthRefusal(`close: the anchors are under two nodes, ${anchorWithNode_say(first)} and ${anchorWithNode_say(other)}; ${choices}`);
  }
  if (none !== undefined) {
    throw new BerthRefusal(`close: ${anchorWithNode_say(first)} is under a node and ${none.name} is under none; ${choices}`);
  }
  return childOf_place({ ...first, node: first.node as number }, 'anchors');
}

/**
 * Says the person's processes still running in the berth and asks whether
 * to return the work while they run; `--force` answers yes.
 *
 * @param outgoing - The outgoing folder.
 * @param force - Whether the question is answered already.
 * @returns True to go on, false when the person said no.
 */
async function processes_settle(outgoing: string, force: boolean): Promise<boolean> {
  const running: BerthProcess[] = processesOwn_list(outgoing);
  if (running.length === 0) return true;
  const rows: string[][] = [
    ['PID', 'COMMAND', `OPEN UNDER ${outgoing}`],
    ...running.map((one: BerthProcess): string[] => [String(one.pid), one.command, one.open.length === 0 ? '-' : one.open.join(', ')]),
  ];
  sink_dataLine(`berth: close: ${running.length} ${running.length === 1 ? 'process' : 'processes'} of yours still ${running.length === 1 ? 'runs' : 'run'} in the berth:`);
  for (const line of columns_render(rows)) sink_dataLine(`  ${line}`);
  if (force) return true;
  return repl_confirm(`berth: close: return ${outgoing} while ${running.length === 1 ? 'it runs' : 'they run'}?`);
}

/**
 * The files ChRIS holds at an anchor's path at the close, named as the anchor named them.
 *
 * @param anchor - The anchor.
 * @returns The files with their sizes; none when nothing stands there.
 * @throws {Error} When ChRIS cannot be read there.
 */
async function anchorFilesNow_read(anchor: BerthAnchor): Promise<AnchoredFile[]> {
  const entry: RemoteEntry | null = await remoteEntry_read(anchor.path);
  if (entry === null) return [];
  if (entry.kind === 'file') return [{ name: posix.basename(anchor.path), size: entry.size }];
  return (await remoteTree_list(anchor.path)).map((file: RemoteFile): AnchoredFile => ({ name: file.name, size: file.size }));
}

/**
 * Says what changed in one comparison: the counts, or why it could not be made.
 *
 * @param changes - The comparison.
 * @returns The words.
 */
function changes_say(changes: AnchorChanges): string {
  if (changes.unreadable !== null) return `cannot compare with ChRIS: ${changes.unreadable}`;
  const parts: string[] = [];
  if (changes.added.length > 0) parts.push(`${count_say(changes.added.length, 'file')} added`);
  if (changes.removed.length > 0) parts.push(`${count_say(changes.removed.length, 'file')} gone`);
  if (changes.resized.length > 0) parts.push(`${count_say(changes.resized.length, 'file')} of another size`);
  return `changed in ChRIS since anchored: ${parts.join(', ')}`;
}

/**
 * Compares every anchor with no node against what ChRIS holds at the close, and says
 * what differs; an anchor under a node is skipped, since a finished node
 * does not change.
 *
 * @param anchors - The berth's anchors.
 * @returns The anchors as the record holds them.
 */
async function anchorsChanges_read(anchors: readonly BerthAnchor[]): Promise<RecordAnchor[]> {
  const recorded: RecordAnchor[] = [];
  for (const anchor of anchors) {
    if (anchor.node !== null) {
      recorded.push({ ...anchor, changes: null });
      continue;
    }
    let changes: AnchorChanges;
    try {
      changes = anchorChanges_compare(anchor.files, await anchorFilesNow_read(anchor));
    } catch (error: unknown) {
      changes = { added: [], removed: [], resized: [], unreadable: error instanceof Error ? error.message : String(error) };
    }
    if (anchorChanges_any(changes)) sink_dataLine(`berth: close: ${anchor.name}: ${changes_say(changes)}; ${BERTH_RECORD_FILE} lists them`);
    recorded.push({ ...anchor, changes });
  }
  return recorded;
}

/** The node a close made, or why it made none. */
interface AttachResult {
  /** The node, when it was made. */
  readonly attached: BerthAttachment | null;
  /** CUBE's reason, when it was not. */
  readonly reason: string | null;
  /** A new feed's root made before the work failed; else null. */
  readonly root: AttachOutcome | null;
}

/**
 * Makes the work's node where the placement says.
 *
 * @param placement - Where it goes.
 * @param folder - The uploaded folder in the person's CUBE files.
 * @param title - The work node's title.
 * @returns The node, or CUBE's reason.
 */
async function work_attach(placement: BerthPlacement, folder: string, title: string): Promise<AttachResult> {
  if (placement.kind === 'child') {
    const work: AttachOutcome = await pluginChild_run(WORK_PLUGIN, placement.parent, { dir: folder, title });
    if (!work.ok) return { attached: null, reason: work.reason, root: null };
    return { attached: { feed: work.feed ?? placement.feed, node: work.instance, plugin: work.pluginName, root: null }, reason: null, root: null };
  }
  if (placement.inputs.length === 0) {
    // No anchor: the work is the feed's root, so its title is the node's,
    // and the feed is named after it unless a name was given.
    const root: AttachOutcome = await feedRoot_create([folder], title);
    if (!root.ok) return { attached: null, reason: root.reason, root: null };
    if (placement.name !== title && root.feed !== null) {
      const refused: string | null = await feedName_set(root.feed, placement.name);
      if (refused !== null) sink_dataLine(`berth: close: feed ${root.feed} keeps the name ${title}: ${refused}`);
    }
    return { attached: { feed: root.feed, node: root.instance, plugin: root.pluginName, root: null }, reason: null, root: null };
  }
  const root: AttachOutcome = await feedRoot_create(placement.inputs, placement.name);
  if (!root.ok) return { attached: null, reason: root.reason, root: null };
  const work: AttachOutcome = await pluginChild_run(WORK_PLUGIN, root.instance, { dir: folder, title });
  if (!work.ok) return { attached: null, reason: work.reason, root };
  return { attached: { feed: root.feed, node: work.instance, plugin: work.pluginName, root: root.instance }, reason: null, root };
}

/**
 * Puts the node made into the session's job index, so `/proc` shows it at
 * once, and follows its run until it settles.
 *
 * @param placement - Where it went.
 * @param attached - The node made.
 * @param who - The person.
 */
async function work_index(placement: BerthPlacement, attached: BerthAttachment, who: string): Promise<void> {
  if (attached.feed === null) return;
  const { newFeed_cacheAdd, run_follow } = await import('../feedCreation.js');
  if (placement.kind === 'child') {
    const { procCache_get } = await import('@fnndsc/cumin');
    procCache_get().instance_add({ id: attached.node, feedID: attached.feed, parentID: placement.parent, pluginName: attached.plugin, params: null, status: 'scheduled' });
  } else {
    newFeed_cacheAdd({
      feedID: attached.feed,
      title: placement.name,
      ownerUsername: who,
      rootInstanceID: attached.root ?? attached.node,
      ...(attached.root === null ? {} : { child: { id: attached.node, pluginName: attached.plugin } }),
    });
  }
  run_follow(attached.feed);
}

/**
 * Where the work went, in words.
 *
 * @param placement - Where it was placed.
 * @param attached - The node made.
 * @returns The line.
 */
function whereWent_say(placement: BerthPlacement, attached: BerthAttachment): string {
  const node: string = `node ${attached.node} (${attached.plugin})`;
  const feed: string = `feed ${attached.feed ?? '?'}`;
  if (placement.kind === 'child') return `${feed}, ${node}, a child of ${placement.parentName}`;
  if (attached.root === null) return `the new ${feed} "${placement.name}", ${node}, its root`;
  return `the new ${feed} "${placement.name}", ${node}, a child of pl-dircopy_${attached.root} over ${count_say(placement.inputs.length, 'anchored path')}`;
}

/**
 * The record of a close, before its node is made.
 *
 * @param places - The berth's places.
 * @param who - The person.
 * @param anchors - The anchors with what changed.
 * @param folder - The CUBE files folder.
 * @param placement - Where the node goes.
 * @param title - The work node's title.
 * @returns The record.
 */
function closeRecord_build(places: BerthPlaces, who: string, anchors: readonly RecordAnchor[], folder: string, placement: BerthPlacement, title: string): BerthRecord {
  const image: string | undefined = process.env[BERTH_IMAGE_ENV];
  return {
    version: 1,
    who,
    session: hostname(),
    image: image === undefined || image === '' ? null : image,
    source: berthSource_read(process.cwd()),
    closedAt: new Date().toISOString(),
    title,
    anchors,
    outgoing: places.outgoing,
    folder,
    placement,
    attached: null,
  };
}

/**
 * `berth close [--infeed <anchor> | --newfeed] [--name <feed>] [--title <text>] [--force]`:
 * returns the outgoing folder to ChRIS as one node.
 *
 * @param places - The berth's places.
 * @param args - The words after `close`.
 * @returns Where the work went and its files folder, or that nothing closed.
 * @throws {BerthRefusal} For an empty outgoing folder, a placement the anchors do not decide, and an upload that fails.
 *
 * @example
 * ```ts
 * await close_run({ anchors: '/anchors', outgoing: '/outgoing' }, ['--newfeed', '--name', 'seg run']);
 * ```
 */
export async function close_run(places: BerthPlaces, args: readonly string[]): Promise<CommandEnvelope> {
  const request: CloseRequest = closeRequest_parse(args);
  const work: AnchoredFile[] = outgoingFiles_list(places.outgoing);
  if (work.length === 0) throw new BerthRefusal(`close: ${places.outgoing} is empty; nothing to close`);
  const state: BerthState = berthState_read(places.anchors);
  const placement: BerthPlacement = closePlacement_decide(state.anchors, request);
  const home: string = (await berthHome_get()).replace(/\/$/, '');
  if (home === '') throw new BerthRefusal('close: the session names no ChRIS home to upload to; connect first');
  if (!await processes_settle(places.outgoing, request.force)) {
    exitCode_set(1);
    return envelope_ok('berth: close: nothing closed\n');
  }
  const anchors: RecordAnchor[] = await anchorsChanges_read(state.anchors);
  const who: string = posix.basename(home);
  const folder: string = `${home}/${BERTH_FILES_FOLDER}/${randomUUID()}`;
  const record: BerthRecord = closeRecord_build(places, who, anchors, folder, placement, request.title);
  berthRecord_write(places.outgoing, record);

  const total: number = work.reduce((sum: number, file: AnchoredFile): number => sum + file.size, 0);
  sink_dataLine(`berth: close: uploading ${count_say(work.length, 'file')}, ${size_format(total)}, and ${BERTH_RECORD_FILE} to ${folder}`);
  let sent: UploadOutcome;
  try {
    sent = await folderContents_upload(places.outgoing, folder);
  } catch (error: unknown) {
    throw new BerthRefusal(`close: upload to ${folder}: ${error instanceof Error ? error.message : String(error)}; nothing attached`);
  }
  if (sent.failed > 0) {
    throw new BerthRefusal(`close: ${count_say(sent.failed, 'file')} did not reach ${folder}; nothing attached, and what did reach it stays there`);
  }

  const made: AttachResult = await work_attach(placement, folder, request.title);
  if (made.attached === null) {
    exitCode_set(1);
    const root: string = made.root?.ok === true ? `; the new feed ${made.root.feed ?? '?'} holds the anchored paths under pl-dircopy_${made.root.instance}` : '';
    return envelope_ok(`${chalk.yellow(`berth: close: uploaded, not attached: ${made.reason ?? 'CUBE gave no reason'}${root}`)}\n${chalk.gray(`berth: close: the work stays in ${folder}`)}\n`);
  }
  const written: string = berthRecord_write(places.outgoing, { ...record, attached: made.attached });
  await work_index(placement, made.attached, who);
  // The close is no older than the record it wrote last, so `berth clear`
  // never counts that record as work not yet closed.
  const closedAt: string = new Date(Math.ceil(Math.max(Date.now(), statSync(written).mtimeMs))).toISOString();
  berthState_update(places.anchors, (now: BerthState): BerthState => ({ ...now, lastClosedAt: closedAt }));
  return envelope_ok(`${chalk.green(`berth: close: the work is ${whereWent_say(placement, made.attached)}`)}\n${chalk.gray(`berth: close: its files are in ${folder}`)}\n`);
}
