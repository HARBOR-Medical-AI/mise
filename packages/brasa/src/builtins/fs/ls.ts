/**
 * @file `ls`: lists folders and files of ChRIS's filesystem (CFS).
 *
 * Declared in one record (`lsCommand`): its grammar, its help and its
 * handler. Paths glob; options may stand anywhere among them.
 *
 * Key components:
 * - lsCommand: the declaration.
 * - builtin_ls: the declaration run over words already split.
 * - ls_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_ls(['-l', 'docs']);
 * await ls_run({ paths: ['docs'], long: true });
 * ```
 *
 * Dependencies: the session's filesystem, its listing cache and its cwd.
 *
 * @module
 */
import { answerNumbering_derive, handle_word, numberedFooter_render, type NumberedHandle } from '../../session/answer.js';
import chalk from 'chalk';
import { path_resolve } from '../utils.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import { itemType_isContainer } from '../../core/itemKinds.js';
import { errorStack, type Result, type VFSItem } from '@fnndsc/fond';
import type { ListingCache } from '../../core/backend.js';
import { session } from '../../session/index.js';
import { vfs, type VfsListing } from '../../lib/vfs/vfs.js';
import { type ListingItem, type CommandEnvelope } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** Valid sort fields for ls. */
type LsSortField = 'name' | 'size' | 'date' | 'owner';

/** What an `ls` line may hold. `-a` and `-A` are taken and already hold: nothing in a listing is hidden. */
const LS_GRAMMAR = {
  operands: [
    { name: 'path', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'What to list; the working directory when none is given' },
  ],
  options: {
    long: { short: 'l', summary: 'Long format: detail, feed and plugin titles, each row numbered' },
    oneColumn: { short: '1', summary: 'One entry per line' },
    human: { short: 'h', summary: 'Human-readable sizes (with -l)' },
    refresh: { short: 'f', long: 'refresh', summary: 'Read afresh, past the cache' },
    reverse: { short: 'r', long: 'reverse', summary: 'Reverse the sort' },
    directory: { short: 'd', summary: 'List a folder itself, not its contents' },
    all: { short: 'a', long: 'all', summary: 'Taken: nothing in a listing is hidden' },
    almostAll: { short: 'A', long: 'almost-all', summary: 'Taken: nothing in a listing is hidden' },
    sort: { long: 'sort', summary: 'Sort by', value: { name: 'field', kind: 'enum', values: ['name', 'size', 'date', 'owner'] } },
  },
} as const satisfies CommandGrammar;

/**
 * `ls [-l1hfrdaA] [--sort <field>] [path…]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [lsCommand] });
 * ```
 */
export const lsCommand = command_declare({
  name: 'ls',
  grammar: LS_GRAMMAR,
  help: {
    summary: 'List directory contents',
    description: "List the folders and files of ChRIS's filesystem: the working directory, or each path given (a wildcard matches paths). Several paths list files first, together, then each folder under its own name. The long format shows feed and plugin instance titles, and numbers each row with the handle an index names it by (@FIL2).",
    category: 'Navigation',
    posix: { group: 'Files', differs: "lists ChRIS's filesystem (CFS), not this machine's; -l numbers rows" },
    examples: [
      'ls                    # List current directory',
      'ls -l                 # Long format with titles',
      'ls -lh                # Long format with human sizes',
      'ls -f                 # Force refresh from server',
      'ls /home/user/data    # List specific directory',
      'ls *.txt              # List matching files (wildcard)',
      'ls --sort=size -r     # Sort by size, reversed',
      'ls data -l            # Options may follow the paths',
      '',
      '# Long format shows feed and plugin instance titles:',
      '# d user 0  2025-05-18  feed_875           Brain MRI Analysis',
      '# d user 0  2025-05-18  pl-dircopy_33314   pl-dircopy v2.1.2',
    ],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof LS_GRAMMAR>): Promise<CommandEnvelope> => ls_run({
    paths: args.operands.path,
    long: args.options.long,
    human: args.options.human,
    oneColumn: args.options.oneColumn,
    sort: args.options.sort ?? 'name',
    reverse: args.options.reverse,
    directory: args.options.directory,
    refresh: args.options.refresh,
  }),
});

/**
 * `ls` over words already split: the declaration's parse and handler, for a
 * caller holding words rather than a line.
 *
 * @param args - The words after `ls`.
 * @returns The listing, or the refusal of a bad line.
 */
export async function builtin_ls(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(lsCommand, args);
}

/**
 * Prefixes each entry line of a long listing with its handle, and adds the
 * footer. The handles come from the listing's own numbering; when the lines
 * and the entries do not pair one to one, the listing is left as it was
 * rather than wearing numbers that could be wrong.
 *
 * @param rendered - The long listing as drawn.
 * @param listings - The entries, per target, in drawn order.
 * @returns The listing with handles, or as it was.
 */
function longHandles_add(rendered: string, listings: ReadonlyArray<LsListing>): string {
  const handles: NumberedHandle[] = answerNumbering_derive('fs.listing', listings) ?? [];
  if (handles.length === 0) return rendered;
  const lines: string[] = rendered.split('\n');
  const entry = (line: string): boolean => /^[dl-] /.test(line.replace(/\x1b\[[0-9;]*m/g, ''));
  if (lines.filter(entry).length !== handles.length) return rendered;
  const width: number = Math.max(...handles.map((handle: NumberedHandle): number => handle_word(handle).length));
  let at: number = 0;
  const out: string[] = lines.map((line: string): string => {
    if (!entry(line)) return line;
    const handle: NumberedHandle | undefined = handles[at++];
    return `${chalk.cyan((handle === undefined ? '' : handle_word(handle)).padEnd(width))}  ${line}`;
  });
  const text: string = out.join('\n');
  return `${text}${text.endsWith('\n') ? '' : '\n'}${chalk.gray(numberedFooter_render(handles))}\n`;
}

/**
 * Whether a path is a folder, as its parent lists it (a mount point counts).
 *
 * @param target - The absolute path.
 * @returns True for a folder; false for a file or for nothing there.
 */
async function folder_is(target: string): Promise<boolean> {
  const clean: string = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target;
  if (clean === '/') return true;
  const slash: number = clean.lastIndexOf('/');
  const mark: number = errorStack.checkpoint_mark();
  const siblings: Result<VFSItem[]> = await vfsDispatcher_get().list(clean.slice(0, slash) || '/');
  errorStack.checkpoint_drain(mark);
  return siblings.ok && siblings.value.some((item: VFSItem): boolean => item.name === clean.slice(slash + 1) && itemType_isContainer(item.type));
}

/** Typed invocation options for ls. */
export interface LsOptions {
  /** Paths to list; empty or omitted lists the session cwd. */
  paths?: string[];
  /** Long (detailed) listing. */
  long?: boolean;
  /** Human-readable sizes in the long listing. */
  human?: boolean;
  /** One entry per line. */
  oneColumn?: boolean;
  /** Sort field. */
  sort?: LsSortField;
  /** Reverse the sort order. */
  reverse?: boolean;
  /** List the entry itself rather than its contents. */
  directory?: boolean;
  /** Invalidate cached listings before reading. */
  refresh?: boolean;
}

/**
 * One listed target and its resolved entries, for the envelope model.
 *
 * @property path - The listed directory (resolved; the cwd when none given).
 * @property items - The listing entries in display order.
 */
export interface LsListing {
  path: string;
  items: ListingItem[];
  /** False when the listing was served stale; a refresh follows on the ambient bus. */
  fresh?: boolean;
}

/**
 * Lists directories: the shared typed core behind the parsed builtin and
 * the typed API.
 *
 * @param runOptions - Target paths, sorting, and presentation flags.
 * @returns An envelope whose rendered text carries the listing and whose
 *   `fs.listing` model carries the entries per target.
 */
export async function ls_run(runOptions: LsOptions): Promise<CommandEnvelope> {
  const pathArgs: string[] = runOptions.paths ?? [];
  const shouldRefresh: boolean = runOptions.refresh ?? false;

  const options: {
    long: boolean;
    human: boolean;
    oneColumn: boolean;
    sort: LsSortField;
    reverse: boolean;
    directory: boolean;
  } = {
    long: runOptions.long ?? false,
    human: runOptions.human ?? false,
    oneColumn: runOptions.oneColumn ?? false,
    sort: runOptions.sort ?? 'name',
    reverse: runOptions.reverse ?? false,
    directory: runOptions.directory ?? false,
  };

  let rendered: string = '';
  let renderedErr: string = '';

  if (shouldRefresh) {
    const listCache: ListingCache = listingCache_get();
    if (pathArgs.length === 0) {
      const cwd: string = await session.getCWD();
      rendered += `${chalk.gray(`[Cache] Invalidating: ${cwd}`)}\n`;
      // The named listing only. A refresh used to clear EVERY listing too,
      // so one REFRESH press made the next navigation anywhere fetch again
      // — /bin included, seconds — for a staleness nobody had claimed.
      listCache.cache_invalidate?.(cwd);
    } else {
      for (const pathArg of pathArgs) {
        const resolvedPath: string = await path_resolve(pathArg);
        rendered += `${chalk.gray(`[Cache] Invalidating: ${resolvedPath}`)}\n`;
        listCache.cache_invalidate?.(resolvedPath);
      }
    }
  }

  // One or more listings, in argument order; each returns its own envelope.
  const targets: Array<string | undefined> = [];
  if (pathArgs.length === 0) {
    targets.push(undefined);
  } else {
    for (const pathArg of pathArgs) {
      targets.push(await path_resolve(pathArg));
    }
  }

  // Several operands read as a shell gives them: files first, together, then
  // each folder under its own `name:` header, a blank line between blocks.
  const order: number[] = targets.map((_target: string | undefined, index: number): number => index);
  const folders: Set<number> = new Set<number>();
  if (targets.length > 1 && !options.directory) {
    for (const index of order) {
      if (await folder_is(targets[index] as string)) folders.add(index);
    }
    order.sort((a: number, b: number): number => Number(folders.has(a)) - Number(folders.has(b)));
  }

  let anyFailed: boolean = false;
  let blocks: number = 0;
  const listings: LsListing[] = [];
  for (const index of order) {
    const target: string | undefined = targets[index];
    const kept: { listing?: VfsListing } = {};
    const envelope: CommandEnvelope = await vfs.list(target, options, kept);
    if (folders.has(index) && envelope.status !== 'error') {
      rendered += `${blocks > 0 ? '\n' : ''}${pathArgs[index]}:\n`;
      blocks++;
    } else if (envelope.status !== 'error' && blocks === 0 && targets.length > 1) {
      blocks++;
    }
    rendered += envelope.rendered;
    if (envelope.renderedErr !== undefined) {
      renderedErr += envelope.renderedErr;
    }
    if (envelope.status === 'error') {
      anyFailed = true;
      continue;
    }
    // The entries for the model: the listing vfs.list just rendered.
    if (kept.listing !== undefined) {
      listings.push({ path: kept.listing.path, items: kept.listing.items, fresh: kept.listing.fresh });
    }
  }

  // A failed listing is a failed command: aggregating error envelopes into an
  // ok status would let `ls missing-dir` exit 0.
  if (anyFailed) {
    exitCode_set(1);
  }
  // The long form is a table: each entry wears the handle an index expands
  // to (#1099), and a footer says what is numbered. The short grid stays the
  // POSIX grid.
  if (options.long) rendered = longHandles_add(rendered, listings);
  const result: CommandEnvelope = { status: anyFailed ? 'error' : 'ok', rendered };
  result.model = { kind: 'fs.listing', data: listings };
  if (renderedErr.length > 0) {
    result.renderedErr = renderedErr;
  }
  return result;
}
