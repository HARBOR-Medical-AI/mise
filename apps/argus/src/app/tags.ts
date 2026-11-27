/**
 * @file A feed's tags, as the host wires them: TAG asks which tags to hang
 * and the × on a tag takes it off. Every change is the line the operator
 * could have typed — `setfattr`, and `mkdir /proc/tags/<name>` before it
 * when the tag is new — run visibly, so the transcript holds each one.
 *
 * The question offers the user's tags (`/proc/tags`) as pills, the ones the
 * feed already wears dimmed, and a field for a new name. It asks again
 * after each pick, so several tags hang from one press; DONE ends it.
 *
 * A module of the host: the host hands in the pane question and a way to
 * show the roster again once a tag changed.
 */
import type { WireEnvelope } from '@fnndsc/menu';
import { arg_quote } from '@fnndsc/menu';
import type { ExecuteOutcome } from '../calypso/client.js';
import type { PaneAskChoice, PaneAskRequest } from '../features/ask/paneAsk.js';
import type { HostContext } from './hostContext.js';
import { lineVisible_run } from './lines.js';

/** What the tag verbs ask of the host. */
export interface TagHooks {
  /** A question on a pane, where the press was. */
  askOnPane_await: (id: string, request: PaneAskRequest) => Promise<string | null>;
  /** The roster (or a graph's readout) shows the feed's tags again. */
  tags_changed: (feedId: number) => void;
}

/** The tag verbs a wired host has. */
export interface TagVerbs {
  /** TAG: asks which tags to hang on a feed, until DONE. */
  tag_choose: (paneId: string, feedId: number, worn: ReadonlyArray<string>) => Promise<void>;
  /** × on a tag: takes it off the feed. */
  tag_remove: (feedId: number, tag: string) => Promise<boolean>;
}

/**
 * The tag names a `ls /proc/tags` answered.
 *
 * @param outcome - The listing's outcome.
 * @returns The names, in the kernel's order.
 */
export function tagNames_extract(outcome: ExecuteOutcome): string[] {
  for (const envelope of outcome.envelopes as ReadonlyArray<WireEnvelope>) {
    if (envelope.model?.kind !== 'fs.listing') continue;
    const listings = envelope.model.data as Array<{ items?: Array<{ name?: unknown }> }>;
    return (listings[0]?.items ?? []).map((item): string => String(item.name ?? '')).filter((name: string): boolean => name !== '');
  }
  return [];
}

/**
 * The lines that hang a tag on a feed: `mkdir` first when the tag is new.
 *
 * @param feedId - The feed.
 * @param tag - The tag.
 * @param known - The user's tags.
 * @returns The lines, in order.
 */
export function tagLines_compose(feedId: number, tag: string, known: ReadonlyArray<string>): string[] {
  const set: string = `setfattr -n tag -v ${arg_quote(tag)} feed_${feedId}`;
  return known.includes(tag) ? [set] : [`mkdir ${arg_quote(`/proc/tags/${tag}`)}`, set];
}

/**
 * Wires the tag verbs to a host.
 *
 * @param context - The console and the wire.
 * @param hooks - The pane question and the roster's refresh.
 * @returns The tag verbs.
 */
export function tags_wire(context: Pick<HostContext, 'terminal' | 'client'>, hooks: TagHooks): TagVerbs {
  /** The user's tags, asked of the kernel quietly. */
  const tags_read = async (): Promise<string[]> => {
    try {
      return tagNames_extract(await context.client.line_execute('ls /proc/tags', { silent: true, observe: false }));
    } catch {
      return [];
    }
  };

  const tag_choose = async (paneId: string, feedId: number, worn: ReadonlyArray<string>): Promise<void> => {
    const wearing: Set<string> = new Set(worn);
    for (;;) {
      const known: string[] = await tags_read();
      const choices: PaneAskChoice[] = known.map((name: string): PaneAskChoice => ({ value: name, held: wearing.has(name) }));
      const offered: string = known.filter((name: string): boolean => !wearing.has(name)).join(', ');
      const answer: string | null = await hooks.askOnPane_await(paneId, {
        kind: 'choose',
        message: `Tag feed_${feedId}${offered === '' ? '' : ` (${offered})`}, or a new tag: `,
        choices,
        commit: 'TAG',
        close: 'DONE',
      });
      const tag: string = (answer ?? '').trim();
      if (tag === '' || tag.includes('/')) return;
      if (wearing.has(tag)) continue;
      let took: boolean = true;
      for (const line of tagLines_compose(feedId, tag, known)) {
        took = await lineVisible_run(context, line);
        if (!took) break;
      }
      if (!took) return;
      wearing.add(tag);
      hooks.tags_changed(feedId);
    }
  };

  const tag_remove = async (feedId: number, tag: string): Promise<boolean> => {
    const took: boolean = await lineVisible_run(context, `setfattr -x tag -v ${arg_quote(tag)} feed_${feedId}`);
    if (took) hooks.tags_changed(feedId);
    return took;
  };

  return { tag_choose, tag_remove };
}
