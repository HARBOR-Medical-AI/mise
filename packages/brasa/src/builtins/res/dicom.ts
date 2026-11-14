/**
 * @file `dcm` — DICOM as the kernel sees it: a folder as a series, a file or
 * folder as tags.
 *
 *   dcm series <folder>                     what this folder is as a series
 *   dcm tags <file|folder> [--all] [--filter <text>]
 *
 * One parser in salsa answers both; this command renders the text a terminal
 * reads and carries the typed model a surface draws (`dicom.series`,
 * `dicom.tags`). Identifying tags are flagged on the model and shown here in
 * full — the terminal is the operator's own screen; a shared surface redacts
 * by the flag.
 *
 * A folder's tags are read from every file up to a cap, then from an even
 * sample; the rendered text always says how many were read of how many
 * there are, and which could not be read. Long values are shortened on
 * screen and say by how much; the model carries them whole.
 *
 * @module
 */
import chalk from 'chalk';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import {
  context_getSingle,
  dicomSeries_summarize,
  dicomFolder_list,
  dicomHeader_get,
  dicomFiles_sample,
  dicomTags_summarize,
  type DicomSeriesSummary,
  type DicomFolderListing,
  type DicomTagSet,
  type DicomTag,
  type DicomTagsSummary,
  type DicomVaryingTag,
  type DicomTagGroup,
} from '@fnndsc/salsa';
import { DICOM_MODEL_KINDS, DICOM_TAG_GROUPS, type DicomSeriesModel, type DicomTagsModel, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { commandArgs_process, path_resolve, type ParsedArgs } from '../utils.js';
import { args_checkHasHelpFlag, help_render } from '../help.js';
import type { Result } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';

/** The most files a folder's tags are read from before sampling evenly. */
export const DCM_TAGS_FILE_CAP: number = 512;

/** On-screen values longer than this are shortened and say so. */
const VALUE_SCREEN_LIMIT: number = 64;

/** Groups a tag listing hides unless asked with `--all`. */
const HIDDEN_GROUPS: ReadonlySet<DicomTagGroup> = new Set<DicomTagGroup>(['meta', 'private']);

/** Rendering choices for a tag listing. */
interface TagsRenderOptions {
  all: boolean;
  filter: string | undefined;
}

/**
 * Handles `dcm <series|tags> ...`.
 *
 * @param args - Subcommand and its arguments.
 * @returns An envelope with the rendered text and the typed model.
 */
export async function builtin_dcm(args: string[]): Promise<CommandEnvelope> {
  if (args_checkHasHelpFlag(args, 'dcm')) return envelope_ok(help_render('dcm'));
  const subcommand: string | undefined = args[0];
  switch (subcommand) {
    case 'series':
      return dcmSeries_handle(args.slice(1));
    case 'tags':
      return dcmTags_handle(args.slice(1));
    default:
      return usage_error(subcommand === undefined ? 'dcm: a subcommand is required' : `dcm: unknown subcommand '${subcommand}'`);
  }
}

/**
 * An error envelope carrying the usage line.
 */
function usage_error(reason: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(reason)}\n${chalk.gray('Usage: dcm series <folder> | dcm tags <file|folder> [--all] [--filter <text>]')}\n`);
}

/**
 * The address the bytes actually live at.
 *
 * A path can name a file three times over: the logical place a listing shows
 * it (`/home/me/feeds/feed_42/pl-dircopy_1/data/...`), the projection the
 * graph gives for the same place (`/proc/jobs/feed_42/pl-dircopy_1/data/...`),
 * and the physical file CUBE stores. A `pl-dircopy` of a PACS pull is the
 * case where all three differ: its output folder is a LINK, and the DICOM
 * under it is stored beneath `/SERVICES/PACS`. Reading the logical name got
 * no file id, so every slice of a pulled series was unreadable from the feed
 * it was pulled into — a listing that shows what it cannot open — while the
 * same series read fine at its PACS address, and `cd` into the folder (which
 * does follow links) made the very same command work.
 *
 * So the address is resolved before anything is read: a projection through
 * the provider that owns it, then the link walk the rest of the file
 * commands already do. A path that resolves to nothing stands as it was, so
 * a bad path still refuses by its own name.
 *
 * @param input - The path as the operator or a surface gave it.
 * @returns The physical path, or the input when it resolves no further.
 */
export async function path_physical(input: string): Promise<string> {
  // Resolution is best effort by design: whatever cannot answer — a stubbed
  // dispatcher, a path no link walk knows — leaves the address as it was,
  // and the command refuses by its own name rather than by an exception.
  try {
    const { vfsDispatcher } = await import('@fnndsc/salsa');
    let candidate: string = input;
    if (vfsDispatcher?.path_isVirtual?.(input) === true) {
      const link: RegExpExecArray | null = /^(\/proc\/jobs\/feed_\d+\/[^/]+\/data)(\/.*)?$/.exec(input);
      if (link === null) return input;
      const target: Result<string> = await vfsDispatcher.linkTarget_resolve(link[1] as string);
      if (!target.ok) return input;
      candidate = `${target.value}${link[2] ?? ''}`;
    }
    const { logicalPath_resolve } = await import('@fnndsc/chili/utils');
    const physical: Result<string> = await logicalPath_resolve(candidate);
    return physical.ok ? physical.value : candidate;
  } catch {
    return input;
  }
}

/**
 * `dcm series <folder>`: the folder as a series.
 */
async function dcmSeries_handle(args: string[]): Promise<CommandEnvelope> {
  const parsed: ParsedArgs = commandArgs_process(args);
  const target: string | undefined = (parsed._ as string[])[0];
  if (target === undefined) return usage_error('dcm series: a folder is required');
  // A stop is honoured between the reads; one already on its way to CUBE
  // runs to its answer, which is then dropped.
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();
  // Read afresh at each step: the signal changes while a read is awaited.
  const stop_isAsked = (): boolean => signal?.aborted === true;
  const stopped = (): CommandEnvelope => envelope_error('', undefined, 'dcm series: stopped\n');
  const folder: string = await path_physical(await path_resolve(target));
  if (stop_isAsked()) return stopped();
  const annotationRoot: string | undefined = await annotationRoot_get();
  const summary: Result<DicomSeriesSummary> = await dicomSeries_summarize(folder, annotationRoot !== undefined ? { annotationRoot } : {});
  if (stop_isAsked()) return stopped();
  if (!summary.ok) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`dcm series: ${folder}: not a readable DICOM folder`)}\n`);
  }
  const model: DicomSeriesModel = summary.value;
  return envelope_ok(series_render(model), { kind: DICOM_MODEL_KINDS.series, data: model });
}

/**
 * Where the session's annotations live: `/home/<user>/annotations`.
 */
async function annotationRoot_get(): Promise<string | undefined> {
  const user: string | null = (await context_getSingle()).user;
  return user === null ? undefined : `/home/${user}/annotations`;
}

/**
 * `dcm tags <file|folder> [--all] [--filter <text>]`.
 */
async function dcmTags_handle(args: string[]): Promise<CommandEnvelope> {
  const parsed: ParsedArgs = commandArgs_process(args, { booleanLongOptions: ['all'] });
  const target: string | undefined = (parsed._ as string[])[0];
  if (target === undefined) return usage_error('dcm tags: a file or folder is required');
  const options: TagsRenderOptions = {
    all: parsed.all === true,
    filter: typeof parsed.filter === 'string' ? parsed.filter : undefined,
  };
  const resolved: string = await path_physical(await path_resolve(target));
  const model: Result<DicomTagsModel> = await tagsModel_read(resolved);
  if (!model.ok) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`dcm tags: ${resolved}: not a readable DICOM file or folder`)}\n`);
  }
  return envelope_ok(tags_render(model.value, options), { kind: DICOM_MODEL_KINDS.tags, data: model.value });
}

/**
 * Reads a path's tags, whether it names one file or a folder of them.
 *
 * Shared with `expect`, which asserts on tag values: an assertion must read
 * the header exactly the way the readout does, or a manifest could pass
 * against a file the operator is shown differently.
 *
 * @param resolved - A physical path, already resolved.
 * @returns The tags model, or a refusal when the path holds no readable DICOM.
 */
export async function tagsModel_read(resolved: string): Promise<Result<DicomTagsModel>> {
  return /\.dcm$/i.test(resolved) ? await fileTags_model(resolved) : await folderTags_model(resolved);
}

/**
 * One file's tags as the model.
 */
async function fileTags_model(path: string): Promise<Result<DicomTagsModel>> {
  const header: Result<DicomTagSet> = await dicomHeader_get(path);
  if (!header.ok) return { ok: false };
  return {
    ok: true,
    value: { path, subject: 'file', read: 1, of: 1, refused: [], constant: header.value.tags, varying: [] },
  };
}

/**
 * A folder's tags as the model: every file up to the cap, then an even sample.
 */
async function folderTags_model(folder: string): Promise<Result<DicomTagsModel>> {
  const listed: Result<DicomFolderListing> = await dicomFolder_list(folder);
  if (!listed.ok || listed.value.files.length === 0) return { ok: false };
  const chosen: string[] = dicomFiles_sample(listed.value.files, DCM_TAGS_FILE_CAP).map((file): string => file.path);
  const read: Array<{ path: string; tags: DicomTagSet }> = [];
  const refused: string[] = [];
  for (const path of chosen) {
    const header: Result<DicomTagSet> = await dicomHeader_get(path);
    if (header.ok) read.push({ path, tags: header.value });
    else refused.push(path);
  }
  if (read.length === 0) return { ok: false };
  const summary: DicomTagsSummary = dicomTags_summarize(read);
  return {
    ok: true,
    value: {
      path: folder,
      subject: 'folder',
      read: read.length,
      of: listed.value.files.length,
      refused,
      constant: summary.constant,
      varying: summary.varying,
    },
  };
}

/**
 * Renders the series summary.
 */
export function series_render(model: DicomSeriesModel): string {
  const rows: Array<[string, string]> = [];
  rows.push(['UID', model.seriesInstanceUID ?? chalk.gray('none')]);
  if (model.studyInstanceUID !== undefined) rows.push(['STUDY', model.studyInstanceUID]);
  rows.push(['MODALITY', model.modality]);
  rows.push(['DESCRIPTION', model.seriesDescription === '' ? chalk.gray('none') : model.seriesDescription]);
  if (model.seriesNumber !== undefined) rows.push(['NUMBER', String(model.seriesNumber)]);
  const frames: string = model.frames > 1 ? `  ${model.frames} frames each` : '';
  rows.push(['INSTANCES', `${model.instances}${frames}  ${chalk.gray(`order: ${model.order}`)}`]);
  if (model.geometry !== undefined) {
    const g: DicomSeriesModel['geometry'] = model.geometry;
    const parts: string[] = [`${g.rows} x ${g.columns}`];
    if (g.pixelSpacing !== undefined) parts.push(`${g.pixelSpacing[0]} x ${g.pixelSpacing[1]} mm`);
    if (g.sliceThickness !== undefined) parts.push(`${g.sliceThickness} mm thick`);
    if (g.spacingBetweenSlices !== undefined) parts.push(`${g.spacingBetweenSlices} mm apart`);
    rows.push(['GEOMETRY', parts.join(', ')]);
  }
  if (model.transferSyntax !== undefined) {
    rows.push(['SYNTAX', model.transferSyntax.name ?? chalk.yellow(`unknown ${model.transferSyntax.uid}`)]);
  }
  rows.push(['BYTES', bytes_format(model.bytes)]);
  rows.push(['HEADER', chalk.gray(model.header)]);
  rows.push(['ANNOTATIONS', model.annotations.length === 0 ? chalk.gray('none') : model.annotations.join('\n' + ' '.repeat(16))]);
  const lines: string[] = [`${chalk.bold('SERIES')}  ${model.path}`];
  for (const [label, value] of rows) lines.push(`  ${chalk.cyan(label.padEnd(12))} ${value}`);
  return lines.join('\n') + '\n';
}

/**
 * Renders a tags model: one file grouped, or a folder's constant groups
 * then its varying tags with first..last and distinct counts.
 */
export function tags_render(model: DicomTagsModel, options: TagsRenderOptions): string {
  const lines: string[] = [];
  const count: string = model.subject === 'file' ? '' : model.read === model.of ? `  ${model.read} files` : `  ${chalk.yellow(`${model.read} of ${model.of} files, sampled evenly`)}`;
  lines.push(`${chalk.bold('TAGS')}  ${model.path}${count}`);
  if (model.refused.length > 0) {
    lines.push(`  ${chalk.red(`REFUSED ${model.refused.length}`)}  ${model.refused.slice(0, 3).join(', ')}${model.refused.length > 3 ? ', …' : ''}`);
  }

  const constant: DicomTag[] = model.constant.filter((tag: DicomTag): boolean => tag_shown(tag, options));
  const varying: DicomVaryingTag[] = model.varying.filter((tag: DicomVaryingTag): boolean => tag_shown(tag, options));
  // Hidden means "would have shown but for --all": a tag the filter drops
  // is not hidden, it is filtered, and the count must not claim otherwise.
  const unhidden: TagsRenderOptions = { all: true, filter: options.filter };
  const hidden: number = options.all
    ? 0
    : model.constant.filter((tag: DicomTag): boolean => HIDDEN_GROUPS.has(tag.group) && tag_shown(tag, unhidden)).length +
      model.varying.filter((tag: DicomVaryingTag): boolean => HIDDEN_GROUPS.has(tag.group) && tag_shown(tag, unhidden)).length;
  const nameWidth: number = Math.min(32, Math.max(8, ...[...constant, ...varying].map((tag): number => tag.name.length)));

  if (model.subject === 'folder' && varying.length > 0) lines.push(`  ${chalk.bold('CONSTANT')}`);
  for (const group of DICOM_TAG_GROUPS) {
    const inGroup: DicomTag[] = constant.filter((tag: DicomTag): boolean => tag.group === group);
    if (inGroup.length === 0) continue;
    lines.push(`  ${chalk.magenta(group.toUpperCase())}`);
    for (const tag of inGroup) lines.push(...tag_lines(tag, nameWidth, 4));
  }
  if (varying.length > 0) {
    lines.push(`  ${chalk.bold('VARYING')}  ${varying.length} tag${varying.length === 1 ? '' : 's'}`);
    for (const tag of varying) {
      const range: string = tag.distinct === 1 ? screen_value(tag.first) : `${screen_value(tag.first)} ${chalk.gray('..')} ${screen_value(tag.last)}`;
      const missing: number = tag.values.filter((entry): boolean => entry.value === null).length;
      const note: string = chalk.gray(`(${tag.distinct} distinct${missing > 0 ? `, ${missing} without` : ''})`);
      lines.push(`    ${chalk.gray(tag.tag)}  ${tag.name.padEnd(nameWidth)}  ${tag.vr}  ${range}  ${note}`);
    }
  }
  if (constant.length === 0 && varying.length === 0) {
    lines.push(`  ${chalk.yellow(options.filter !== undefined ? `no tags match '${options.filter}'` : 'no tags')}`);
  }
  if (hidden > 0) lines.push(`  ${chalk.gray(`${hidden} meta/private tag${hidden === 1 ? '' : 's'} hidden; --all shows them`)}`);
  return lines.join('\n') + '\n';
}

/**
 * Whether a tag passes the group and filter choices.
 */
function tag_shown(tag: { group: DicomTagGroup; tag: string; name: string; decoded?: string } & ({ value: string } | { first: string; last: string }), options: TagsRenderOptions): boolean {
  if (!options.all && HIDDEN_GROUPS.has(tag.group)) return false;
  if (options.filter === undefined) return true;
  const needle: string = options.filter.toLowerCase();
  return tag_matches(tag, needle);
}

/**
 * Whether a tag, or any item inside a sequence it carries, mentions the
 * needle. A filter that stopped at the top level hid the referenced-image
 * sequences an SR is made of.
 */
function tag_matches(tag: { tag: string; name: string; decoded?: string; items?: DicomTag[][] } & ({ value: string } | { first: string; last: string }), needle: string): boolean {
  const haystack: string[] = [tag.tag, tag.name, tag.decoded ?? ''];
  if ('value' in tag) haystack.push(tag.value);
  else haystack.push(tag.first, tag.last);
  if (haystack.some((text: string): boolean => text.toLowerCase().includes(needle))) return true;
  return (tag.items ?? []).some((item: DicomTag[]): boolean => item.some((inner: DicomTag): boolean => tag_matches(inner, needle)));
}

/**
 * One tag's line, and its sequence items indented beneath it.
 */
function tag_lines(tag: DicomTag, nameWidth: number, indent: number): string[] {
  const pad: string = ' '.repeat(indent);
  const phi: string = tag.phi ? chalk.yellow(' PHI') : '';
  const decoded: string = tag.decoded !== undefined ? `  ${chalk.gray(tag.decoded)}` : '';
  const lines: string[] = [`${pad}${chalk.gray(tag.tag)}  ${tag.name.padEnd(nameWidth)}  ${tag.vr}  ${screen_value(tag.value)}${decoded}${phi}`];
  if (tag.items !== undefined) {
    tag.items.forEach((item: DicomTag[], index: number): void => {
      lines.push(`${pad}  ${chalk.gray(`item ${index + 1}`)}`);
      for (const inner of item) lines.push(...tag_lines(inner, nameWidth, indent + 4));
    });
  }
  return lines;
}

/**
 * A value as it fits on screen: whole when short, else shortened and
 * saying by how much.
 */
function screen_value(value: string): string {
  if (value.length <= VALUE_SCREEN_LIMIT) return value;
  return `${value.slice(0, VALUE_SCREEN_LIMIT)}${chalk.gray(`… (+${value.length - VALUE_SCREEN_LIMIT})`)}`;
}

/**
 * Bytes in the nearest unit.
 */
export function bytes_format(bytes: number): string {
  const units: string[] = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value: number = bytes;
  let unit: number = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}
