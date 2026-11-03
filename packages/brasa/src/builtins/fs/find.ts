/**
 * @file `find`: walk the namespace and print the paths an expression selects.
 *
 * POSIX's form: starting points first (`.` when none), then an expression of
 * tests and actions joined by implicit AND, `-o`, `!`/`-not` and parentheses.
 * The walk reads every folder through the listing cache (`vfs.listing_get`),
 * the same listings `ls` reads, so a tree already seen is walked without a
 * word to CUBE; only a folder never listed, or one whose listing expired, is
 * fetched. Links are not followed (POSIX's default). A long walk says how far
 * it has got, and Ctrl-C stops it, saying where; a folder that cannot be read
 * is named and the command fails, as POSIX `find` does, without stopping the
 * walk.
 *
 * Tests: `-name`, `-iname`, `-path`, `-ipath` (shell patterns, `*` crossing `/`
 * in a path), `-type f|d|l`, `-newermt DATE`, and, where the namespace knows
 * them, `-status` and `-plugin` (a job's, in `/proc/jobs`); options `-maxdepth N`,
 * `-mindepth N`; actions `-print` (the default) and `-print0`. Anything else
 * is refused by name.
 *
 * @module
 */
import chalk from 'chalk';
import path from 'path';
import { path_resolve } from '../utils.js';
import { vfs, type VfsListing } from '../../lib/vfs/vfs.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { spinner } from '../../lib/spinner.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { errorStack, type Result, type VFSSubtree, type VFSSubtreeEntry } from '@fnndsc/fond';
import { envelope_error, type CommandEnvelope, type ListingItem } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** One entry the walk visits. */
export interface FindNode {
  /** The path as printed (relative to how its starting point was typed). */
  shown: string;
  /** The entry's own name. */
  name: string;
  /** `d` a folder (any kind the namespace lists into), `l` a link, `f` anything else. */
  type: 'f' | 'd' | 'l';
  /** ISO date, when the listing carries one. */
  date?: string;
  /** Levels below its starting point. */
  depth: number;
  /** A job's or feed's status, when the namespace knows it. */
  status?: string;
  /** The plugin a job ran. */
  plugin?: string;
  /** The pipeline whose run made a job ('' for a direct run), when the namespace knows it. */
  pipeline?: string;
  /** The workflow (pipeline run) that made a job ('' for a direct run). */
  workflow?: string;
}

/** A parsed expression. */
export type FindExpr =
  | { kind: 'and' | 'or'; left: FindExpr; right: FindExpr }
  | { kind: 'not'; operand: FindExpr }
  | { kind: 'test'; test: (node: FindNode) => boolean }
  | { kind: 'print'; separator: string };

/** What the command line asks for. */
export interface FindQuery {
  starts: string[];
  expr: FindExpr;
  maxdepth: number;
  mindepth: number;
  /** Whether the expression names an action; without one, every match is printed. */
  acts: boolean;
  /** Whether a test asks which pipeline run made a job (`-pipeline`, `-workflow`). */
  asksRuns: boolean;
  /** One pipeline run asked for by id (`-workflow N`, no pattern): `/proc/jobs` is searched for its feeds alone. */
  workflowId: number | null;
}

/** How long a walk runs before it says how far it has got. */
const PROGRESS_AFTER_MS: number = 1500;

/** Listing types the namespace descends into. */
const FOLDER_TYPES: ReadonlySet<string> = new Set(['dir', 'vfs', 'job']);

/**
 * A shell pattern as a regular expression, the way `find` matches it: `*`
 * any run of characters (a `/` included), `?` one, `[...]` a class.
 *
 * @param pattern - The pattern.
 * @param ignoreCase - Whether case is ignored.
 * @returns The expression, anchored at both ends.
 */
export function pattern_convertToRegExp(pattern: string, ignoreCase: boolean = false): RegExp {
  let source: string = '';
  for (let i: number = 0; i < pattern.length; i++) {
    const ch: string = pattern[i] as string;
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const close: number = pattern.indexOf(']', i + 2);
      if (close === -1) { source += '\\['; continue; }
      const body: string = pattern.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
      source += `[${body}]`;
      i = close;
    } else if (ch === '\\' && i + 1 < pattern.length) {
      source += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}

/**
 * Parses `find`'s arguments.
 *
 * @param args - The words after `find`.
 * @returns The query, or the refusal to say.
 */
export function find_parse(args: string[]): FindQuery | string {
  const starts: string[] = [];
  let i: number = 0;
  while (i < args.length && !/^[-!(]/.test(args[i] as string)) starts.push(args[i++] as string);
  if (starts.length === 0) starts.push('.');
  const words: string[] = args.slice(i);
  let at: number = 0;
  let maxdepth: number = Number.POSITIVE_INFINITY;
  let mindepth: number = 0;
  let acts: boolean = false;
  let asksRuns: boolean = false;
  let workflowId: number | null = null;

  const argument = (predicate: string): string => {
    const value: string | undefined = words[++at];
    if (value === undefined) throw new Error(`find: ${predicate} needs an argument`);
    return value;
  };
  const depth = (predicate: string): number => {
    const value: string = argument(predicate);
    if (!/^\d+$/.test(value)) throw new Error(`find: ${predicate} takes a number, not '${value}'`);
    return Number(value);
  };

  const primary = (): FindExpr => {
    const word: string | undefined = words[at];
    if (word === undefined) throw new Error('find: an expression ends where a test was expected');
    if (word === '(') {
      at++;
      const inner: FindExpr = or();
      if (words[at] !== ')') throw new Error("find: a '(' is not closed");
      at++;
      return inner;
    }
    let expr: FindExpr;
    switch (word) {
      case '-name': case '-iname': {
        const re: RegExp = pattern_convertToRegExp(argument(word), word === '-iname');
        expr = { kind: 'test', test: (node: FindNode): boolean => re.test(node.name) };
        break;
      }
      case '-path': case '-ipath': case '-wholename': {
        const re: RegExp = pattern_convertToRegExp(argument(word), word === '-ipath');
        expr = { kind: 'test', test: (node: FindNode): boolean => re.test(node.shown) };
        break;
      }
      case '-type': {
        const kind: string = argument(word);
        if (!['f', 'd', 'l'].includes(kind)) throw new Error(`find: -type takes f, d or l, not '${kind}'`);
        expr = { kind: 'test', test: (node: FindNode): boolean => node.type === kind };
        break;
      }
      case '-pipeline': case '-workflow': {
        const wanted: string = argument(word);
        const re: RegExp = pattern_convertToRegExp(wanted, true);
        const field: 'pipeline' | 'workflow' = word === '-pipeline' ? 'pipeline' : 'workflow';
        asksRuns = true;
        if (field === 'workflow' && /^\d+$/.test(wanted) && workflowId === null) workflowId = Number(wanted);
        expr = { kind: 'test', test: (node: FindNode): boolean => node[field] !== undefined && re.test(node[field] as string) };
        break;
      }
      case '-status': case '-plugin': {
        const re: RegExp = pattern_convertToRegExp(argument(word), true);
        const field: 'status' | 'plugin' = word === '-status' ? 'status' : 'plugin';
        expr = { kind: 'test', test: (node: FindNode): boolean => node[field] !== undefined && re.test(node[field] as string) };
        break;
      }
      case '-newermt': {
        const when: string = argument(word);
        const time: number = Date.parse(when);
        if (Number.isNaN(time)) throw new Error(`find: -newermt takes a date, not '${when}'`);
        expr = { kind: 'test', test: (node: FindNode): boolean => node.date !== undefined && Date.parse(node.date) > time };
        break;
      }
      case '-maxdepth': maxdepth = depth(word); expr = { kind: 'test', test: (): boolean => true }; break;
      case '-mindepth': mindepth = depth(word); expr = { kind: 'test', test: (): boolean => true }; break;
      case '-true': expr = { kind: 'test', test: (): boolean => true }; break;
      case '-false': expr = { kind: 'test', test: (): boolean => false }; break;
      case '-print': acts = true; expr = { kind: 'print', separator: '\n' }; break;
      case '-print0': acts = true; expr = { kind: 'print', separator: '\0' }; break;
      default: throw new Error(`find: unknown predicate '${word}'`);
    }
    at++;
    return expr;
  };
  const not = (): FindExpr => {
    if (words[at] === '!' || words[at] === '-not') { at++; return { kind: 'not', operand: not() }; }
    return primary();
  };
  const and = (): FindExpr => {
    let left: FindExpr = not();
    while (at < words.length && words[at] !== '-o' && words[at] !== '-or' && words[at] !== ')') {
      if (words[at] === '-a' || words[at] === '-and') at++;
      left = { kind: 'and', left, right: not() };
    }
    return left;
  };
  const or = (): FindExpr => {
    let left: FindExpr = and();
    while (words[at] === '-o' || words[at] === '-or') { at++; left = { kind: 'or', left, right: and() }; }
    return left;
  };

  try {
    const expr: FindExpr = words.length === 0 ? { kind: 'test', test: (): boolean => true } : or();
    if (at < words.length) return `find: unexpected '${words[at]}'`;
    return { starts, expr, maxdepth, mindepth, acts, asksRuns, workflowId };
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Evaluates an expression on one entry, printing as its actions say.
 *
 * @param expr - The expression.
 * @param node - The entry.
 * @param out - Where printed paths go.
 * @returns Whether the expression is true for the entry.
 */
export function find_evaluate(expr: FindExpr, node: FindNode, out: string[]): boolean {
  switch (expr.kind) {
    case 'and': return find_evaluate(expr.left, node, out) && find_evaluate(expr.right, node, out);
    case 'or': return find_evaluate(expr.left, node, out) || find_evaluate(expr.right, node, out);
    case 'not': return !find_evaluate(expr.operand, node, out);
    case 'test': return expr.test(node);
    case 'print': out.push(node.shown + expr.separator); return true;
  }
}

/** The plugin a `/proc/jobs` job ran, read from its name (`pl-x_10`). */
function pluginName_parse(item: ListingItem): string | undefined {
  if (item.type !== 'job' || /^feed_\d+$/.test(item.name)) return undefined;
  const match: RegExpExecArray | null = /^(.+)_\d+$/.exec(item.name);
  return match === null ? undefined : match[1];
}

/** An entry's kind, as `-type` names it. */
function itemType_derive(item: ListingItem): 'f' | 'd' | 'l' {
  if (item.type === 'link') return 'l';
  return FOLDER_TYPES.has(item.type) ? 'd' : 'f';
}

/**
 * `find [path...] [expression]`.
 *
 * @param args - The words after `find`.
 * @returns The selected paths, and why any part of the walk failed.
 */
export async function builtin_find(args: string[]): Promise<CommandEnvelope> {
  const query: FindQuery | string = find_parse(args);
  if (typeof query === 'string') {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(query)}\n`);
  }
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();
  const out: string[] = [];
  let failures: string = '';
  let folders: number = 0;
  let found: number = 0;
  const startedAt: number = Date.now();
  let announced: boolean = false;
  const progress = (): void => {
    if (Date.now() - startedAt < PROGRESS_AFTER_MS) return;
    const words: string = `find: ${folders} folder${folders === 1 ? '' : 's'} walked, ${found} found`;
    if (announced) spinner.updateMessage(words); else { spinner.start(words); announced = true; }
  };
  // Jobs a -pipeline or -workflow test could not judge: their run is not known yet.
  let unjudged: number = 0;
  const visit = (node: FindNode): void => {
    if (query.asksRuns && node.plugin !== undefined && node.pipeline === undefined) unjudged++;
    if (node.depth < query.mindepth) return;
    const before: number = out.length;
    const matched: boolean = find_evaluate(query.expr, node, out);
    if (!query.acts && matched) out.push(`${node.shown}\n`);
    if (out.length > before) found++;
  };

  try {
    for (const start of query.starts) {
      const resolved: string = await path_resolve(start);
      const shownRoot: string = start.startsWith('~') ? resolved : start;
      const self: Result<VfsListing> = await vfs.listing_get(resolved, { directory: true });
      const entry: ListingItem | undefined = self.ok ? self.value.items[0] : undefined;
      if (entry === undefined) {
        errorStack.stack_pop();
        failures += `find: '${start}': No such file or directory\n`;
        continue;
      }
      const rootType: 'f' | 'd' | 'l' = itemType_derive(entry);
      visit({ shown: shownRoot, name: path.posix.basename(resolved) || resolved, type: rootType, date: entry.date || undefined, depth: 0 });
      if (rootType !== 'd') continue;
      // Depth first, in listing order: an entry, then everything beneath it.
      const walk = async (real: string, shown: string, depth: number): Promise<boolean> => {
        if (signal?.aborted) return false;
        if (depth >= query.maxdepth) return true;
        const listed: Result<VfsListing> = await vfs.listing_get(real);
        folders++;
        progress();
        if (!listed.ok) {
          const why: string = errorStack.stack_pop()?.message ?? 'cannot be read';
          failures += `find: '${shown}': ${why}\n`;
          return true;
        }
        for (const item of listed.value.items) {
          const node: FindNode = {
            shown: shown === '/' ? `/${item.name}` : `${shown}/${item.name}`,
            name: item.name,
            type: itemType_derive(item),
            date: item.date || undefined,
            depth: depth + 1,
            status: typeof item.status === 'string' ? item.status : undefined,
            plugin: pluginName_parse(item),
          };
          visit(node);
          if (node.type === 'd' && !(await walk(path.posix.join(real, item.name), node.shown, node.depth))) return false;
        }
        return true;
      };
      // A mount that holds the subtree answers it whole (/proc/jobs, from
      // its cache); only what it leaves unanswered is walked.
      let held: VFSSubtree | null = await vfsDispatcher_get().subtree(resolved).catch((): null => null);
      // One pipeline run asked for by id under /proc/jobs: CUBE names the feeds its jobs are in, and only those are
      // read; every other feed, indexed or not, is left alone (#1364: a cold session indexed them all first).
      if (held !== null && query.workflowId !== null && resolved === '/proc/jobs') {
        // Read when asked, not at load: find's other walks owe salsa nothing.
        const { workflowFeedIDs_get } = await import('@fnndsc/salsa');
        const feeds: Set<string> = new Set((await workflowFeedIDs_get(query.workflowId)).map((id: number): string => `feed_${id}`));
        const inScope = (rel: string): boolean => feeds.has(rel.split('/')[0] ?? '');
        held = { entries: held.entries.filter((entry: VFSSubtreeEntry): boolean => inScope(entry.rel)), unanswered: held.unanswered.filter(inScope) };
      }
      if (held !== null) {
        const join = (base: string, rel: string): string => (base === '/' ? `/${rel}` : `${base}/${rel}`);
        for (const entry of held.entries) {
          if (entry.depth > query.maxdepth) continue;
          visit({
            shown: join(shownRoot, entry.rel),
            name: entry.item.name,
            type: itemType_derive(entry.item as ListingItem),
            date: entry.item.date || undefined,
            depth: entry.depth,
            status: entry.attrs?.['status'] ?? entry.item.status,
            plugin: entry.attrs?.['plugin'],
            pipeline: entry.attrs?.['pipeline'],
            workflow: entry.attrs?.['workflow'],
          });
        }
        let stopped: boolean = false;
        for (const rel of held.unanswered) {
          const depth: number = rel.split('/').length;
          if (!(await walk(path.posix.join(resolved, rel), join(shownRoot, rel), depth))) { stopped = true; break; }
        }
        if (stopped) { failures += `find: stopped (Ctrl-C) after ${folders} folders; ${found} found so far\n`; break; }
        continue;
      }
      if (!(await walk(resolved, shownRoot, 0))) {
        failures += `find: stopped (Ctrl-C) after ${folders} folders; ${found} found so far\n`;
        break;
      }
    }
  } finally {
    if (announced) spinner.stop();
  }

  // Not a failure: said, so an answer that leaves jobs out never looks whole.
  const unjudgedNote: string = unjudged > 0
    ? `find: ${unjudged} job${unjudged === 1 ? '' : 's'} not judged: which pipeline run made ${unjudged === 1 ? 'it' : 'them'} is not known yet (being read now, behind the prompt); asked again, find judges ${unjudged === 1 ? 'it' : 'them'} too\n`
    : '';
  if (failures !== '') exitCode_set(1);
  failures += unjudgedNote;
  const failed: boolean = failures !== unjudgedNote;
  return { status: failed ? 'error' : 'ok', rendered: out.join(''), renderedErr: failures === '' ? undefined : (failed ? chalk.red(failures) : chalk.yellow(failures)) };
}
