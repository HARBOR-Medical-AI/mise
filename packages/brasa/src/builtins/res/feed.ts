/**
 * @file `feed` and `feeds`: CUBE's feeds, listed and searched; one feed
 * created, its note and comments read and written, its DAG drawn, and the
 * feed removed.
 *
 * Declared in one record (`feedCommand`, and `feedsCommand` its second
 * name): the subcommands, their operands and options, and the listing
 * options every resource command reads. A feed named on the line is the
 * ChRIS argument kind `feed`, which completes the feeds the session knows.
 *
 * Key components:
 * - feedCommand / feedsCommand: the declaration, under each name.
 * - builtin_feed: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { feeds_fetchList, FeedListResult } from '@fnndsc/chili/commands/feeds/list.js';
import { feedFields_fetch } from '@fnndsc/chili/commands/feeds/fields.js';
import { feed_create } from '@fnndsc/chili/commands/feed/create.js';
import { feed_noteGet, feed_noteUpdate } from '@fnndsc/chili/commands/feed/note.js';
import type { FeedNote } from '@fnndsc/chili/commands/feed/note.js';
import { feed_commentsList, feed_commentCreate, feed_commentDelete, feed_commentUpdate } from '@fnndsc/chili/commands/feed/comments.js';
import type { FeedComment } from '@fnndsc/chili/commands/feed/comments.js';
import { feedList_render, feedCreate_render, feedNote_render, feedComments_render } from '@fnndsc/chili/views/feed.js';
import { Feed } from '@fnndsc/chili/models/feed.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import { feed_resolve, path_extractFeedID, type FeedRecord } from '@fnndsc/cumin';
import { builtin_edit } from '../fs/edit.js';
import { feedTree_handle } from './feed.tree.js';
import { feedDag_handle, feedDiagram_handle } from './feed.diagram.js';
import { session } from '../../session/index.js';
import { Err, Ok, Result, errorStack } from '@fnndsc/fond';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar, type SubcommandArguments } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, commandAlias_make, resourceListBag_build } from './resourceList.js';

/**
 * Resolves an explicit feed specifier or, when omitted, the `feed_N` segment of
 * the current working directory.
 *
 * @param specifier - Numeric ID, `feed_N`, title, title fragment, or undefined.
 * @returns The resolved numeric feed ID.
 */
async function feedID_resolve(specifier: string | undefined): Promise<Result<number>> {
  if (specifier === undefined || specifier.length === 0) {
    const cwd: string = await session.getCWD();
    const contextualID: number | null = path_extractFeedID(cwd);
    if (contextualID !== null) return Ok(contextualID);
    errorStack.stack_push('error', 'Not currently inside a feed directory.');
    return Err();
  }

  if (/^\d+$/.test(specifier)) return Ok(parseInt(specifier, 10));
  const directoryID: number | null = path_extractFeedID(specifier);
  if (directoryID !== null) return Ok(directoryID);

  const resolved: Result<FeedRecord> = await feed_resolve(specifier);
  return resolved.ok ? Ok(resolved.value.id) : Err();
}

/**
 * Joins the words naming a feed into one title or search specifier.
 *
 * @param words - The words, as typed.
 * @returns The specifier, or undefined for none.
 */
function feedSpecifier_join(words: readonly string[]): string | undefined {
  const joined: string = words.join(' ').trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * The error of a feed the line named and none matched.
 *
 * @param usage - The usage line to show beneath it.
 * @returns The error envelope.
 */
function feedResolution_error(usage: string): CommandEnvelope {
  const problem: { message: string } | undefined = errorStack.stack_pop();
  exitCode_set(1);
  const detail: string = problem?.message ?? 'Feed not found.';
  return envelope_error('', undefined, `${chalk.red(detail)}\n${chalk.gray(usage)}\n`);
}

/**
 * Lists the feeds a listing's options ask for.
 *
 * @param options - The bag chili's listing reads.
 * @returns The feed table, with a note when it is one page of more.
 */
async function feedList_handle(options: CLIoptions): Promise<CommandEnvelope> {
  const { feeds, selectedFields, totalCount }: FeedListResult = await feeds_fetchList(options);
  let rendered: string = `${feedList_render(feeds, selectedFields, { table: options.table === true, csv: options.csv === true })}\n`;
  if (totalCount !== undefined && feeds.length < totalCount) {
    rendered += `${chalk.dim(`  ↓ showing ${feeds.length} of ${totalCount}  ·  --all to fetch all  ·  --limit <n> for page size`)}\n`;
  }
  return envelope_ok(rendered);
}

/**
 * Handles `feed inspect`: lists the available feed fields.
 *
 * @returns An envelope carrying the field listing.
 */
async function feedInspect_handle(): Promise<CommandEnvelope> {
  const fields: string[] | null = await feedFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Feed fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found.')}\n`);
}

/** What a `feed note` line holds. */
type NoteRequest = SubcommandArguments<typeof FEED_GRAMMAR, 'note'>;

/**
 * Handles `feed note ...`: the note shown, updated from `--title` and
 * `--content`, or, with `edit`, opened in the editor. The note is a file,
 * `/proc/jobs/feed_N/note`, so editing it is `edit` on that file: a
 * terminal's editor and a browser's editor pane open the same text.
 *
 * @param request - The line.
 * @returns An envelope carrying the note or the update's outcome.
 */
async function feedNote_handle(request: NoteRequest): Promise<CommandEnvelope> {
  const feedId: number = request.operands.feed;
  if (request.operands.edit !== undefined) return builtin_edit([`/proc/jobs/feed_${feedId}/note`]);
  const { title, content } = request.options;
  if (title !== undefined || content !== undefined) {
    const result: Result<boolean> = await feed_noteUpdate(feedId, { title, content });
    if (result.ok) return envelope_ok(`${chalk.green(`Note updated on feed ${feedId}.`)}\n`);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Failed to update note.')}\n`);
  }
  const result: Result<FeedNote> = await feed_noteGet(feedId);
  if (result.ok) return envelope_ok(`${feedNote_render(result.value, feedId)}\n`);
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(`Failed to get note for feed ${feedId}.`)}\n`);
}

/**
 * Handles `feed comments <feed>`: every comment on a feed.
 *
 * @param feedId - The feed.
 * @returns The comments, or the failure.
 */
async function feedComments_handle(feedId: number): Promise<CommandEnvelope> {
  const result: Result<FeedComment[]> = await feed_commentsList(feedId);
  if (result.ok) return envelope_ok(`${feedComments_render(result.value, feedId)}\n`);
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(`Failed to list comments for feed ${feedId}.`)}\n`);
}

/** What a `feed comment` line holds. */
type CommentRequest = SubcommandArguments<typeof FEED_GRAMMAR, 'comment'>;

/**
 * Handles `feed comment <add|edit|delete> <feed> [comment]`.
 *
 * @param request - The line.
 * @returns An envelope carrying the comment operation's outcome.
 */
async function feedComment_handle(request: CommentRequest): Promise<CommandEnvelope> {
  const { op, feed: feedId, comment: commentId } = request.operands;
  const { title, content } = request.options;
  if (op === 'add') {
    const result: Result<FeedComment> = await feed_commentCreate(feedId, { title, content });
    if (result.ok) return envelope_ok(`${chalk.green(`Comment added (id: ${result.value.id}) on feed ${feedId}.`)}\n`);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Failed to add comment.')}\n`);
  }
  if (commentId === undefined) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Usage: feed comment ${op} <feed> <comment>${op === 'edit' ? ' [--title <text>] [--content <text>]' : ''}`)}\n`);
  }
  if (op === 'delete') {
    const result: Result<boolean> = await feed_commentDelete(feedId, commentId);
    if (result.ok) return envelope_ok(`${chalk.green(`Comment ${commentId} deleted.`)}\n`);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Failed to delete comment.')}\n`);
  }
  const result: Result<boolean> = await feed_commentUpdate(feedId, commentId, { title, content });
  if (result.ok) return envelope_ok(`${chalk.green(`Comment ${commentId} updated.`)}\n`);
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red('Failed to update comment.')}\n`);
}

/**
 * Removes a feed and everything hanging off it.
 *
 * Deletion is irreversible and takes the whole analysis with it — every
 * plugin instance, every output — so it asks first, by default, naming what
 * will go. `-f` skips the question for a caller that has already asked its
 * own (a script, a surface that confirmed).
 *
 * @param words - The words naming the feed, none for the one the working directory is in.
 * @param forced - Whether the question is answered already.
 * @returns An envelope naming what was removed, or why it was not.
 */
async function feedRemove_handle(words: readonly string[], forced: boolean): Promise<CommandEnvelope> {
  const feedResult: Result<number> = await feedID_resolve(feedSpecifier_join(words));
  if (!feedResult.ok) return feedResolution_error('Usage: feed rm [<feed>] [-f]');
  const feedID: number = feedResult.value;
  if (!forced) {
    const { repl_confirm } = await import('../../core/question.js');
    let agreed: boolean = false;
    try {
      agreed = await repl_confirm(
        `Remove feed ${feedID} and everything in it? This cannot be undone `,
      );
    } catch {
      agreed = false;
    }
    if (!agreed) {
      return envelope_ok(`feed ${feedID} was not removed\n`);
    }
  }
  const { feed_delete } = await import('@fnndsc/cumin');
  const removed: Result<boolean> = await feed_delete(feedID);
  if (!removed.ok || !removed.value) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`feed rm: feed ${feedID} could not be removed`)}\n`);
  }
  return envelope_ok(`removed feed ${feedID}\n`, { kind: 'feed.rm', data: { feed: feedID } });
}

/** What a `feed tree` line holds; `feed diagram` reads the same options. */
type TreeRequest = SubcommandArguments<typeof FEED_GRAMMAR, 'tree'>;

/** What a `feed diagram` line holds. */
type DiagramRequest = SubcommandArguments<typeof FEED_GRAMMAR, 'diagram'>;

/**
 * Handles `feed tree [<feed>]`: the feed's plugin-instance DAG, drawn.
 *
 * @param request - The line.
 * @returns The tree, or the feed that could not be found.
 */
async function feedTree_run(request: TreeRequest): Promise<CommandEnvelope> {
  const feedResult: Result<number> = await feedID_resolve(feedSpecifier_join(request.operands.feed));
  if (!feedResult.ok) return feedResolution_error('Usage: feed tree [<feed>] [--focus <id>] [--max-nodes <n>]');
  return feedTree_handle(feedResult.value, request.options.focus, request.options.maxNodes ?? 0, request.options.flat);
}

/**
 * Handles `feed diagram [<feed>]`: the tree with the feed's DAG as a model,
 * so one line serves a terminal and a graphical surface alike, or the DAG
 * as SignalFlow YAML.
 *
 * @param request - The line.
 * @returns The diagram, or the feed that could not be found.
 */
async function feedDiagram_run(request: DiagramRequest): Promise<CommandEnvelope> {
  const feedResult: Result<number> = await feedID_resolve(feedSpecifier_join(request.operands.feed));
  if (!feedResult.ok) return feedResolution_error('Usage: feed diagram [--signalflow] [<feed>]');
  if (request.options.signalflow) return feedDiagram_handle(feedResult.value, 'signalflow');
  return feedDag_handle(feedResult.value, request.options.focus, request.options.maxNodes ?? 0, request.options.flat);
}

/** The words that name a feed: an id, its feed_N, or a title; none, the feed the working directory is in. */
const FEED_OPERANDS = [
  { name: 'feed', kind: 'feed', optional: true, repeat: true, summary: 'An id, feed_N, an exact title or a unique search; none for the feed you are in' },
] as const;

/** The options that shape a drawn tree. */
const TREE_OPTIONS = {
  focus: { long: 'focus', summary: "Scope the tree to one node's subtree", value: { name: 'id', kind: 'int', min: 1 } },
  maxNodes: { long: 'max-nodes', summary: 'Draw at most this many nodes (0 draws them all)', value: { name: 'n', kind: 'int', min: 0 } },
  flat: { long: 'flat', summary: 'Draw every node, not collapsing siblings of one shape' },
} as const;

/** A note's or a comment's words. */
const TEXT_OPTIONS = {
  title: { long: 'title', summary: 'The title', value: { name: 'text', kind: 'word' } },
  content: { long: 'content', summary: 'The text', value: { name: 'text', kind: 'word' } },
} as const;

/** What a `feed` line may hold. */
const FEED_GRAMMAR = {
  subcommands: {
    list: {
      summary: 'List the feeds, 20 to a page',
      options: { ...RESOURCE_LIST_OPTIONS_GRAMMAR, user: { long: 'user', summary: "Only this user's feeds (an administrator)", value: { name: 'username', kind: 'word' } } },
    },
    search: {
      summary: 'List the feeds a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value, or part of a name' }],
      options: { ...RESOURCE_LIST_OPTIONS_GRAMMAR, user: { long: 'user', summary: "Only this user's feeds (an administrator)", value: { name: 'username', kind: 'word' } } },
    },
    inspect: { summary: 'Name the fields a feed has' },
    create: {
      summary: 'Create a feed from data folders in ChRIS',
      operands: [{ name: 'paths', kind: 'cfsPath', optional: true, repeat: true, summary: 'The data folders the feed starts from' }],
      options: {
        dirs: { long: 'dirs', summary: 'The data folders, comma-separated', value: { name: 'path,…', kind: 'word' } },
        params: { long: 'params', summary: "The feed's fields, as name:value pairs", value: { name: 'params', kind: 'word' } },
      },
    },
    note: {
      summary: "Show a feed's note; with --title or --content, change it; with edit, open it in the editor (edit /proc/jobs/feed_N/note)",
      operands: [
        { name: 'edit', kind: 'enum', values: ['edit'], optional: true, summary: 'Open the note in the editor' },
        { name: 'feed', kind: 'int', min: 1, summary: "The feed's id" },
      ],
      options: TEXT_OPTIONS,
    },
    comments: { summary: 'List the comments on a feed', operands: [{ name: 'feed', kind: 'int', min: 1, summary: "The feed's id" }] },
    comment: {
      summary: 'Add a comment to a feed, or edit or delete one',
      operands: [
        { name: 'op', kind: 'enum', values: ['add', 'edit', 'delete'], summary: 'What to do' },
        { name: 'feed', kind: 'int', min: 1, summary: "The feed's id" },
        { name: 'comment', kind: 'int', min: 1, optional: true, summary: "The comment's id, to edit or delete it" },
      ],
      options: TEXT_OPTIONS,
    },
    rm: {
      summary: 'Remove a feed and everything in it; asks first',
      operands: FEED_OPERANDS,
      options: { force: { short: 'f', long: 'force', summary: 'Remove without asking' } },
    },
    tree: { summary: "Draw the feed's plugin-instance DAG", operands: FEED_OPERANDS, options: TREE_OPTIONS },
    diagram: {
      summary: 'Draw the DAG as tree does, carrying it as a model; with --signalflow, write it as SignalFlow YAML',
      operands: FEED_OPERANDS,
      options: { ...TREE_OPTIONS, signalflow: { long: 'signalflow', summary: 'Write the DAG as SignalFlow YAML (feed diagram --signalflow 42 | signalflow -)' } },
    },
    share: {
      summary: 'Retired: setfacl and chmod share a feed',
      operands: [{ name: 'words', kind: 'word', optional: true, repeat: true, summary: 'Anything; it says which verb to use' }],
    },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `feed` line.
 *
 * @param args - The line, parsed.
 * @returns The answer, or the error.
 */
async function feed_run(args: CommandArguments<typeof FEED_GRAMMAR>): Promise<CommandEnvelope> {
  try {
    switch (args.subcommand) {
      case 'list': return await feedList_handle(resourceListBag_build(args.options, undefined, args.options.user !== undefined ? { user: args.options.user } : {}));
      case 'search': return await feedList_handle(resourceListBag_build(args.options, args.operands.term, args.options.user !== undefined ? { user: args.options.user } : {}));
      case 'inspect': return await feedInspect_handle();
      case 'create': {
        const dirs: string = [...args.operands.paths, ...(args.options.dirs !== undefined ? [args.options.dirs] : [])].join(',');
        const options: CLIoptions = { ...(dirs !== '' ? { dirs } : {}), ...(args.options.params !== undefined ? { params: args.options.params } : {}) };
        const feed: Feed | null = await feed_create(options);
        return envelope_ok(feed ? `${feedCreate_render(feed)}\n` : '');
      }
      case 'note': return await feedNote_handle(args);
      case 'comments': return await feedComments_handle(args.operands.feed);
      case 'comment': return await feedComment_handle(args);
      case 'rm': return await feedRemove_handle(args.operands.feed, args.options.force);
      case 'tree': return await feedTree_run(args);
      case 'diagram': return await feedDiagram_run(args);
      case 'share':
        // Retired: sharing is an access entry, and a shell has the verbs.
        exitCode_set(1);
        return envelope_error('', undefined, `${chalk.red('feeds share is retired: setfacl -m o::r <feed> (or chmod o+r <feed>) makes a feed public; setfacl -m u:<user>:r or g:<group>:r shares it')}\n`);
    }
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Feed error: ${msg}`)}\n`);
  }
}

/**
 * `feed <list | search | inspect | create | note | comments | comment | rm | tree | diagram> …`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [feedCommand, feedsCommand] }, 'backend');
 * ```
 */
export const feedCommand = command_declare({
  name: 'feed',
  grammar: FEED_GRAMMAR,
  help: {
    summary: "CUBE's feeds: list and search them; create one, note and comment on it, draw its DAG, remove it",
    description: "A feed is a data analysis in ChRIS: a DAG of linked plugin instances, also a folder at /home/<user>/feeds/feed_N. List the feeds a page at a time or every page, filtered by a search and in the columns asked for; inspect names a feed's fields. create starts a feed from data folders; note and comment read and write the words on one; tree and diagram draw its DAG; rm removes it and everything in it, asking first. A feed is named by its id, its feed_N, an exact title or a unique search; inside a feed_N path, leave it out to mean that feed. Sharing a feed is setfacl's and chmod's. feed and feeds are one command.",
    category: 'Resources',
    examples: [
      'feeds list',
      'feeds list --all --user radstar',
      'feeds search experiment',
      'feed create /home/user/uploads/MRI-data',
      'feed tree 1669',
      'feed diagram                       # the feed you are in',
      'feed diagram --signalflow 42 | signalflow -',
      'feed note 42 --title "QC passed" --content "No artefacts found"',
      'feed note edit 42',
      'feed comment add 42 --title "Issue" --content "Slice 14 looks odd"',
      'feed comment delete 42 7',
      'feed rm feed_42',
    ],
  },
  handler: feed_run,
});

/** `feeds`: the same command as `feed`; a read, which holds nothing of the session. */
export const feedsCommand = commandAlias_make(feedCommand, 'feeds', []);

/**
 * `feed` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `feed`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_feed(['tree', 'feed_12']);
 * ```
 */
export async function builtin_feed(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(feedCommand, args);
}
