/**
 * @file Builtin gather command: the session's cohort as a kernel subject.
 *
 * Subcommands: list (the default), add, remove, clear, name, feed, process.
 * Declared in one record (`gatherCommand`).
 *
 * Gathering was a surface gesture before it was a verb, which meant the set
 * a session was working on could only be built by pressing on it. As a
 * subject it is scriptable: a line adds to it, a manifest builds one, and
 * the surface becomes one client of the cohort rather than the only place
 * it exists.
 *
 * Key components:
 * - gatherCommand: the declaration.
 * - builtin_gather: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_gather(['add', '@SER3']);
 * ```
 *
 * Dependencies: the cohort store; `gather.process.js`, loaded when a feed is
 * made or a run starts.
 *
 * @module
 */
import { listingIn_take, listingOperands_extract, type ListingModel } from '../../core/listing.js';
import { answerNumbering_derive, handleWords_map, numberedFooter_render, type NumberedHandle } from '../../session/answer.js';
import chalk from 'chalk';
import path from 'path';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import { path_resolve } from '../utils.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import {
  GatherKind,
  GatherMember,
  GatherState,
  cohort_read,
  cohort_write,
  cohortModel_wrap,
  cohortFolders_fill,
  member_key,
  members_drop,
  members_merge,
  pathKind_determine,
  seriesUID_parse,
} from './gather.store.js';
import { placeImagery_is, seriesFacts_fill } from './gather.facts.js';
import { CommandEnvelope, envelope_ok, envelope_error, type EnvelopeModel } from '@fnndsc/menu';

import { GATHER_MODEL_KIND } from './gather.kind.js';
import { exitCode_set } from '../../core/handlerRun.js';
export { GATHER_MODEL_KIND };

/**
 * Renders a refusal.
 *
 * @param message - What the operator needs to know.
 * @returns An error envelope, with the process marked failed.
 */
function gather_error(message: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(message)}\n`);
}

/**
 * What to call a member in a listing.
 *
 * @param member - The member to name.
 * @returns Its description, else the leaf of its path.
 */
function member_label(member: GatherMember): string {
  const described: unknown = member.description;
  if (typeof described === 'string' && described.trim().length > 0) return described;
  return path.posix.basename(member.vfsPath);
}

/**
 * Where a member IS: home in CUBE, or still at the source.
 *
 * A series is home once CUBE has said where it landed; a place gathered
 * from the filesystem was never anywhere else.
 *
 * @param member - The member to place.
 * @returns A one-word state for the listing.
 */
function member_state(member: GatherMember): string {
  if (member.kind !== 'series') return 'in CUBE';
  const landed: unknown = member.folderPath;
  return typeof landed === 'string' && landed.length > 0 ? 'in CUBE' : 'at PACS';
}

/**
 * Renders the cohort as a table, with its name and counts.
 *
 * @param state - The cohort to show.
 * @returns A success envelope carrying the rendered table and the model.
 */
function cohort_render(state: GatherState): CommandEnvelope {
  const model: EnvelopeModel = cohortModel_wrap(state);
  if (state.series.length === 0) {
    return envelope_ok(`${chalk.gray('The cohort is empty. Gather something with `gather add <path>`.')}\n`, model);
  }

  // Each member wears the handle an index expands to (#1099): one sequence
  // per kind, as the cohort's numbering counts them.
  const numbered: NumberedHandle[] = answerNumbering_derive(GATHER_MODEL_KIND, state) ?? [];
  const words: Map<string, string> = handleWords_map(numbered);
  const kindCode = (member: GatherMember): string => (member.kind === 'dir' ? 'DIR' : member.kind === 'file' ? 'FIL' : 'SER');
  const rows: Record<string, unknown>[] = state.series.map(
    (member: GatherMember): Record<string, unknown> => ({
      '@': words.get(`${kindCode(member)}:${member.vfsPath}`) ?? '',
      kind: member.kind,
      member: member_label(member),
      state: member_state(member),
      path: member.vfsPath,
    }),
  );
  const seriesCount: number = state.series.filter(
    (member: GatherMember): boolean => member.kind === 'series',
  ).length;
  const placeCount: number = state.series.length - seriesCount;
  const parts: string[] = [];
  if (seriesCount > 0) parts.push(`${seriesCount} ${seriesCount === 1 ? 'series' : 'series'}`);
  if (placeCount > 0) parts.push(`${placeCount} ${placeCount === 1 ? 'place' : 'places'}`);
  const title: string = state.name === null ? 'Cohort' : `Cohort · ${state.name}`;

  return envelope_ok(
    `${table_render(rows, ['@', 'kind', 'member', 'state', 'path'], {
      title: { title, justification: 'center' },
    })}${chalk.gray(parts.join(' · '))}\n${numbered.length > 0 ? `${chalk.gray(numberedFooter_render(numbered))}\n` : ''}`,
    model,
  );
}

/**
 * Takes paths into the cohort.
 *
 * Each operand is resolved against the session's cwd, so `gather add .` and
 * a relative series path mean what they say. What a path IS is asked of the
 * filesystem rather than guessed from its spelling.
 *
 * @param operands - Paths to gather.
 * @returns The cohort after the change.
 */
async function gather_add(operands: string[]): Promise<CommandEnvelope> {
  if (operands.length === 0) return gather_error('Usage: gather add <path> [path...]');

  const incoming: GatherMember[] = [];
  for (const operand of operands) {
    const resolved: string = await path_resolve(operand);
    const kind: GatherKind | null = await pathKind_determine(resolved);
    // A path that names nothing is refused by name, before anything is
    // taken: a cohort holding a typo is a cohort a run will be refused on.
    if (kind === null) return gather_error(`gather: ${resolved}: nothing is there.`);
    const member: GatherMember = { vfsPath: resolved, kind };
    if (member.kind === 'series') {
      const uid: string | undefined = seriesUID_parse(resolved);
      if (uid !== undefined) member.seriesUID = uid;
      member.imagery = true;
    } else if (placeImagery_is(member)) {
      member.imagery = true;
    }
    incoming.push(member);
  }
  await seriesFacts_fill(incoming);

  const state: GatherState = await cohort_read();
  const { members, added, merged } = members_merge(state.series, incoming);
  state.series = members;
  // A series CUBE already holds is known by its folder from the moment it
  // is gathered: that folder is what a surface opens as an image and what
  // `gather process` roots on. One CUBE read for every series still unplaced,
  // before the one write, so the band redraws after one round trip, not two.
  await cohortFolders_fill(state);
  await cohort_write(state);

  const noted: string[] = [];
  if (added > 0) noted.push(`${added} gathered`);
  if (merged > 0) noted.push(`${merged} already in the cohort`);
  const envelope: CommandEnvelope = cohort_render(state);
  return envelope_ok(`${chalk.green(`gather: ${noted.join(', ')}.`)}\n${envelope.rendered}`, envelope.model);
}

/**
 * Drops members from the cohort, by path or by listing index.
 *
 * An index is how the operator reads the cohort back, so `gather remove 2`
 * removes the second row rather than refusing because 2 is not a path.
 *
 * @param operands - Paths or `#`-style indices to drop.
 * @returns The cohort after the change.
 */
async function gather_remove(operands: string[]): Promise<CommandEnvelope> {
  if (operands.length === 0) return gather_error('Usage: gather remove <path|index> [path|index...]');

  const state: GatherState = await cohort_read();
  if (state.series.length === 0) return gather_error('gather: the cohort is empty.');

  const keys: string[] = [];
  for (const operand of operands) {
    const asIndex: number = Number.parseInt(operand.replace(/^#/, ''), 10);
    if (!Number.isNaN(asIndex) && `${asIndex}` === operand.replace(/^#/, '')) {
      const member: GatherMember | undefined = state.series[asIndex - 1];
      if (member === undefined) return gather_error(`gather: no member ${operand} — the cohort holds ${state.series.length}.`);
      keys.push(member_key(member));
      continue;
    }
    keys.push(await path_resolve(operand));
  }

  const { members, dropped, missing } = members_drop(state.series, keys);
  if (missing.length > 0) {
    return gather_error(`gather: not in the cohort: ${missing.join(', ')}`);
  }
  state.series = members;
  await cohort_write(state);
  const envelope: CommandEnvelope = cohort_render(state);
  return envelope_ok(`${chalk.green(`gather: ${dropped} removed.`)}\n${envelope.rendered}`, envelope.model);
}

/**
 * Empties the cohort, keeping nothing — not its name, not its feed.
 *
 * @returns The empty cohort.
 */
async function gather_clear(): Promise<CommandEnvelope> {
  const state: GatherState = await cohort_read();
  const held: number = state.series.length;
  const emptied: GatherState = { version: state.version, name: null, feed: null, series: [] };
  await cohort_write(emptied);
  const envelope: CommandEnvelope = cohort_render(emptied);
  return envelope_ok(`${chalk.green(`gather: cleared ${held} ${held === 1 ? 'member' : 'members'}.`)}\n${envelope.rendered}`, envelope.model);
}

/**
 * Reads or sets the cohort's name.
 *
 * @param operands - The new name, or nothing to read the current one.
 * @returns The cohort, named.
 */
async function gather_name(operands: string[]): Promise<CommandEnvelope> {
  const state: GatherState = await cohort_read();
  if (operands.length === 0) {
    if (state.name === null) return envelope_ok(`${chalk.gray('The cohort has no name.')}\n`);
    return envelope_ok(`${state.name}\n`);
  }
  state.name = operands.join(' ');
  await cohort_write(state);
  // The cohort travels with the answer, as every changing verb's does, so
  // a surface showing it takes the name from here.
  return envelope_ok(`${chalk.green(`gather: the cohort is "${state.name}".`)}\n`, cohortModel_wrap(state));
}

/**
 * Makes the cohort's feed, or names the one it has.
 *
 * @param title - The feed's title as `--title` gave it, or null for the cohort's name.
 * @returns The cohort, with its feed.
 */
async function gather_feed(title: string | null): Promise<CommandEnvelope> {
  // Loaded on demand, as `process` is: making a feed carries the pull and
  // feed machinery, which the cohort's own verbs never need.
  const { cohortFeed_make } = await import('./gather.process.js');
  const made: { state: GatherState; made: boolean } | string = await cohortFeed_make(title);
  if (typeof made === 'string') return gather_error(`gather feed: ${made}`);
  const feedId: number | undefined = made.state.feed?.feedId;
  const said: string = made.made ? `gather: the cohort's feed is ${feedId}, made now.` : `gather: the cohort's feed is ${feedId}.`;
  const envelope: CommandEnvelope = cohort_render(made.state);
  return envelope_ok(`${chalk.green(said)}\n${envelope.rendered}`, envelope.model);
}

/** What `add` takes. */
const ADD_OPERAND = {
  name: 'paths', kind: 'cfsPath', optional: true, repeat: true, glob: true,
  summary: 'Paths, handles (@SER3, @SER1-4) or ${listing}; with none, a listing piped in',
} as const;

/** What `remove` and `rm` take. */
const REMOVE_OPERAND = {
  name: 'members', kind: 'cfsPath', optional: true, repeat: true, glob: true,
  summary: 'Paths, handles or listed indices (2, #2); with none, a listing piped in',
} as const;

/** The title of a feed `feed` or `process` makes. */
const TITLE_OPTION = { long: 'title', summary: "The feed's title, when one is made (the cohort's name otherwise)", value: { name: 'title', kind: 'word' } } as const;

/** What a `gather` line may hold. */
const GATHER_GRAMMAR = {
  bare: { summary: 'Show the cohort (as list)' },
  subcommands: {
    list: { summary: 'Show the cohort' },
    add: { summary: 'Take series, directories or files into it', operands: [ADD_OPERAND] },
    remove: { summary: 'Drop members, by path or by listed index', operands: [REMOVE_OPERAND] },
    rm: { summary: 'As remove', operands: [REMOVE_OPERAND] },
    clear: { summary: 'Empty it, name and feed included' },
    name: {
      summary: "Read the cohort's name, or give it one",
      operands: [{ name: 'name', kind: 'word', optional: true, repeat: true, summary: 'The new name; its words are joined' }],
    },
    feed: {
      summary: "The cohort's feed, made now if it has none: series still at the PACS are pulled first, then one feed is rooted on every member",
      options: { title: TITLE_OPTION },
    },
    process: {
      summary: 'Run a plugin or pipeline ONCE over the whole cohort, off one feed whose root holds every member',
      operands: [
        { name: 'executable', kind: 'word', summary: "The plugin's /bin name or the pipeline's own name" },
        { name: 'arguments', kind: 'word', optional: true, repeat: true, summary: "After --: the run's own arguments" },
      ],
      options: {
        title: TITLE_OPTION,
        detach: { long: 'detach', summary: 'Return at once rather than wait for the run' },
      },
    },
  },
} as const satisfies CommandGrammar;

/**
 * `gather [list | add | remove | rm | clear | name | feed | process]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [gatherCommand] }, 'backend');
 * ```
 */
export const gatherCommand = command_declare({
  name: 'gather',
  grammar: GATHER_GRAMMAR,
  help: {
    summary: 'Hold the set of things this session is working on',
    description: "Hold the set of things this session is working on: the cohort. add and remove take paths, handles (@SER3, @SER1-4), ${listing}, or a listing piped in with no operands: query … | gather add. With none of these they refuse rather than guess. process runs off the cohort's own feed when it has one, refuses while a series is unpulled, and answers as the bare run would: R=$(gather process …). <executable> is the /bin name or the pipeline's own name: gather process \"FreeSurfer 8.2.0 mri_convert\". A plugin that starts jobs of its own (pl-dymap) finishes once they are submitted; watch them in the feed.",
    category: 'Workflows',
    examples: [
      'gather',
      'gather add /net/pacs/queries/qid:3125/Study_1.2.3/Series_4.5.6',
      'gather add ~/uploads/brain',
      'gather add @SER3 @SER7',
      'query PatientID:1234567,Modality:MR | gather add',
      'gather remove 2',
      'gather name "sag cohort"',
      'gather feed',
      'R=$(gather process pl-dcm2niix-v1.0.2 --title "sag nifti")',
      'gather process pl-x -- --threshold 0.5',
    ],
  },
  holds: ['cohort'],
  handler: async (args: CommandArguments<typeof GATHER_GRAMMAR>): Promise<CommandEnvelope> => {
    try {
      switch (args.subcommand) {
        case null:
        case 'list':
          return cohort_render(await cohort_read());
        case 'add':
          return await gatherMembers_change('add', args.operands.paths);
        case 'remove':
        case 'rm':
          return await gatherMembers_change(args.subcommand, args.operands.members);
        case 'clear':
          return await gather_clear();
        case 'name':
          return await gather_name(args.operands.name);
        case 'feed':
          return await gather_feed(args.options.title ?? null);
        case 'process': {
          // Loaded on demand: running carries the plugin and pipeline
          // machinery, which the cohort's own verbs never need.
          const { gather_process } = await import('./gather.process.js');
          return await gather_process({
            name: args.operands.executable,
            title: args.options.title ?? null,
            detach: args.options.detach,
            forwarded: args.operands.arguments,
          });
        }
      }
    } catch (e: unknown) {
      return gather_error(`gather: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

/**
 * `gather` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `gather`.
 * @returns An envelope carrying the cohort, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_gather(['add', '~/uploads/brain']);
 * ```
 */
export async function builtin_gather(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(gatherCommand, args);
}

/**
 * Adds members to the cohort or drops them. With no operands, a listing
 * piped in is the operand list (#1103): `query … | gather add`. With
 * neither, the verb says what it needs rather than taking the held listing
 * behind the operator's back.
 *
 * @param verb - `add`, `remove` or `rm`.
 * @param operands - The paths, handles or indices given.
 * @returns The cohort after the change, or a refusal.
 */
async function gatherMembers_change(verb: 'add' | 'remove' | 'rm', operands: string[]): Promise<CommandEnvelope> {
  let given: string[] = operands;
  if (given.length === 0) {
    const piped: ListingModel | null = listingIn_take();
    if (piped === null) {
      return gather_error(`gather ${verb}: what? give paths or handles (@SER3), \${listing}, or pipe a listing in (query … | gather ${verb === 'rm' ? 'remove' : verb})`);
    }
    given = listingOperands_extract(piped) ?? [];
    if (given.length === 0) return gather_error(`gather ${verb}: the listing piped in has nothing to ${verb === 'add' ? 'gather' : 'remove'}.`);
  }
  return verb === 'add' ? await gather_add(given) : await gather_remove(given);
}
