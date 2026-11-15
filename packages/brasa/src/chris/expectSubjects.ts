/**
 * @file What `expect` can claim about the ChRIS world: the cohort, a feed, a
 * run, and what a path's DICOM headers say. Registered with the ChRIS
 * backend (`Backend.expectSubjects`); the core's `expect` names none of it.
 * What each reads is loaded when a claim is made, not when the backend is
 * described.
 *
 * @module
 */
import type { DicomTag, DicomTagsModel, DicomVaryingTag, ListingItem } from '@fnndsc/menu';
import type { Result } from '@fnndsc/fond';
import type { ExpectAsk, ExpectReading, ExpectSubject } from '../core/backend.js';
import { path_resolve } from '../builtins/utils.js';
import type { GatherMember, GatherState } from '../builtins/res/gather.store.js';
import { DEEP_MAX, folder_walkDeep } from '../builtins/res/expect.js';

/**
 * Reads how much of the cohort is home.
 *
 * A place gathered from the filesystem was never anywhere else, so it counts
 * as home; a series counts once CUBE has said where it landed.
 *
 * @param state - The cohort.
 * @returns How many members are in CUBE.
 */
function cohortPulled_count(state: GatherState): number {
  return state.series.filter((member: GatherMember): boolean => {
    if (member.kind !== 'series') return true;
    const landed: unknown = member.folderPath;
    return typeof landed === 'string' && landed.length > 0;
  }).length;
}

/**
 * Answers a claim about the cohort.
 *
 * @param property - `size`, `pulled`, `unpulled` or `name`.
 * @returns What the cohort says.
 */
async function gather_read(property: string): Promise<ExpectReading> {
  // Loaded on demand, as the cohort's reference loads it: the backend's
  // description is read at install, long before a claim is made.
  const { cohort_read, cohortFolders_resolve } = await import('../builtins/res/gather.store.js');
  const read: GatherState = await cohort_read();
  // Whether a series is home is CUBE's to say: a folder the cohort has not
  // noted yet is asked for before the claim is read.
  const state: GatherState = property === 'pulled' || property === 'unpulled' ? await cohortFolders_resolve(read) : read;
  if (property === 'size') return { got: `${state.series.length}` };
  if (property === 'pulled') return { got: `${cohortPulled_count(state)}` };
  // "Every member landed" said directly: no arithmetic between two readings.
  if (property === 'unpulled') return { got: `${state.series.length - cohortPulled_count(state)}` };
  return { got: state.name ?? '' };
}

/**
 * Answers a claim about a feed.
 *
 * @param target - The feed id.
 * @returns What the feed says.
 */
async function feed_read(target: string): Promise<ExpectReading> {
  const feedID: number = Number(target);
  if (!Number.isInteger(feedID)) return { got: null, refusal: `"${target}" is not a feed id` };
  const { procCache_get } = await import('@fnndsc/cumin');
  const { feedStatus_derive } = await import('../builtins/proc.helpers.js');
  const feed = procCache_get().feed_get(feedID);
  if (feed === undefined || feed === null) {
    return { got: null, refusal: `feed ${feedID} is not in this session's index yet` };
  }
  return { got: feedStatus_derive(feed) };
}

/**
 * Answers a claim about one run.
 *
 * @param target - The plugin instance id.
 * @returns What the run says.
 */
async function run_read(target: string): Promise<ExpectReading> {
  const instanceID: number = Number(target);
  if (!Number.isInteger(instanceID)) return { got: null, refusal: `"${target}" is not an instance id` };
  const { jobs_statusBatch } = await import('@fnndsc/salsa');
  const statuses: Map<number, string> = await jobs_statusBatch([instanceID]);
  const status: string | undefined = statuses.get(instanceID);
  if (status === undefined) return { got: null, refusal: `instance ${instanceID} did not answer` };
  return { got: status };
}

/**
 * Answers what a path's DICOM headers say about one tag.
 *
 * @param ask - The claim: the path, and the tag as the property's word.
 * @returns The tag's value, every value it takes when it varies, or why not.
 */
async function pathTags_read(ask: ExpectAsk): Promise<ExpectReading> {
  const tagName: string | undefined = ask.words[0];
  const { tagsModel_read } = await import('../builtins/res/dicom.js');
  const resolved: string = await path_resolve(ask.target ?? '');
  if (tagName === undefined) return { got: null, refusal: 'expect path <p> tags <TagName> <predicate> <value>' };
  let model: Result<DicomTagsModel> = await tagsModel_read(resolved);
  if (!model.ok) {
    // A plugin's output is routinely nested, so a tag claim made at the
    // node's own folder looks BENEATH it before giving up: the files a run
    // produced are what the claim is about, wherever the plugin filed them.
    const walked: Array<{ folder: string; item: ListingItem }> = await folder_walkDeep(resolved, DEEP_MAX);
    const folders: string[] = [...new Set(walked
      .filter((entry): boolean => entry.item.type === 'dir')
      .map((entry): string => `${entry.folder.replace(/\/$/, '')}/${entry.item.name}`))];
    for (const folder of folders) {
      const beneath: Result<DicomTagsModel> = await tagsModel_read(folder);
      if (beneath.ok) { model = beneath; break; }
    }
  }
  if (!model.ok) return { got: null, refusal: `${resolved} holds no readable DICOM, here or beneath it` };
  const constant: DicomTag | undefined = model.value.constant.find(
    (tag: DicomTag): boolean => tag.name === tagName || tag.tag === tagName,
  );
  if (constant !== undefined) return { got: constant.value };
  // A tag that varies across the folder answers with every value it takes,
  // so a claim about "the" value cannot pass by reading only the first file.
  const varying: DicomVaryingTag | undefined = model.value.varying.find(
    (tag: DicomVaryingTag): boolean => tag.name === tagName || tag.tag === tagName,
  );
  if (varying !== undefined) {
    const values: string[] = [...new Set(varying.values
      .map((entry: { value: string | null }): string => entry.value ?? '')
      .filter((value: string): boolean => value.length > 0))];
    return { got: values.join(', ') };
  }
  return { got: '' };
}

/** The ChRIS world's subjects. */
export const chrisExpectSubjects: ReadonlyArray<ExpectSubject> = [
  { name: 'gather', named: false, properties: { size: 0, pulled: 0, unpulled: 0, name: 0 }, read: async (ask: ExpectAsk): Promise<ExpectReading> => await gather_read(ask.property) },
  { name: 'feed', named: true, properties: { status: 0 }, read: async (ask: ExpectAsk): Promise<ExpectReading> => await feed_read(ask.target ?? '') },
  { name: 'run', named: true, properties: { status: 0 }, read: async (ask: ExpectAsk): Promise<ExpectReading> => await run_read(ask.target ?? '') },
  { name: 'path', named: true, properties: { tags: 1 }, read: pathTags_read },
];
