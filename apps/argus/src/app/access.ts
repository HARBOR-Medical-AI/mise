/**
 * @file A feed's name and who it is shared with, as the host wires them.
 *
 * SHARE asks with the CUBE groups the operator belongs to and EVERYONE as
 * pills, the ones that already hold dimmed, and a field for a user's name;
 * it asks again after each pick until DONE. The holders of a feed — each
 * user, each group, and PUBLIC when it is — are marks on the indicated row,
 * each with a × that asks before it withdraws. RENAME asks for the name.
 * Every change is the line the operator could have typed (`setfacl`, or a
 * write to `/proc/jobs/feed_N/title`), run visibly.
 *
 * A module of the host: the host hands in the pane question, the session's
 * user and what to refresh once something changed.
 */
import type { WireEnvelope } from '@fnndsc/menu';
import { arg_quote } from '@fnndsc/menu';
import type { ExecuteOutcome } from '../calypso/client.js';
import type { PaneAskChoice, PaneAskRequest } from '../features/ask/paneAsk.js';
import { saveLine_compose } from '../features/edit/line.js';
import type { HostContext } from './hostContext.js';
import { lineVisible_run } from './lines.js';

/** Who can read a feed besides its owner. */
export interface FeedHolders {
  users: string[];
  groups: string[];
  public: boolean;
}

/** One holder, as a mark names it. */
export type FeedHolder = { kind: 'user' | 'group'; name: string } | { kind: 'public' };

/** What the access verbs ask of the host. */
export interface AccessHooks {
  askOnPane_await: (id: string, request: PaneAskRequest) => Promise<string | null>;
  /** The session's user, for the groups they belong to; null before the prompt names one. */
  promptUser: () => string | null;
  /** A feed's access or name changed: whatever shows it reads it again. */
  changed: (feedId: number) => void;
}

/** The access verbs a wired host has. */
export interface AccessVerbs {
  /** Reads a feed's holders, quietly; null when they could not be read. */
  holders_read: (feedId: number) => Promise<FeedHolders | null>;
  /** The holders as marks, each × withdrawing its grant after a question on the pane. */
  holders_build: (paneId: string, feedId: number, holders: FeedHolders) => HTMLElement;
  /** SHARE: asks with whom, until DONE. */
  share_choose: (paneId: string, feedId: number) => Promise<void>;
  /** RENAME: asks for the name, then writes the title. */
  rename: (paneId: string, feedId: number, title: string) => Promise<void>;
}

/**
 * A feed's holders, from a silent `getfacl`'s model.
 *
 * @param outcome - What the command returned.
 * @returns The holders, or null when the model carried none.
 */
export function holders_extract(outcome: ExecuteOutcome): FeedHolders | null {
  for (const envelope of outcome.envelopes as ReadonlyArray<WireEnvelope>) {
    if (envelope.model?.kind !== 'fs.acl') continue;
    const block = (envelope.model.data as Array<{ usernames?: string[]; groups?: string[]; public?: boolean }>)[0];
    if (block === undefined) return null;
    return { users: block.usernames ?? [], groups: block.groups ?? [], public: block.public === true };
  }
  return null;
}

/**
 * The groups a user belongs to, from `/etc/group`'s text (`name:x:gid:members`).
 *
 * @param text - The file.
 * @param user - The user.
 * @returns The groups' names, in the file's order.
 */
export function groupsOf_user(text: string, user: string): string[] {
  return text.split('\n')
    .map((line: string): string[] => line.trim().split(':'))
    .filter((parts: string[]): boolean => parts.length >= 4 && (parts[3] ?? '').split(',').includes(user))
    .map((parts: string[]): string => parts[0] ?? '')
    .filter((name: string): boolean => name !== '');
}

/**
 * The setfacl entry an answer to SHARE names: a pill's entry as it is, or a
 * typed name as a user's (a typed entry `g:lab:r` is taken as typed).
 *
 * @param answer - The answer.
 * @returns The entry.
 */
export function shareEntry_derive(answer: string): string {
  return /^(u|user|g|group|o|other):/.test(answer) ? answer : `u:${answer}:r`;
}

/**
 * The line that withdraws a holder: `setfacl -x` for a user or a group, the
 * other entry made private for PUBLIC.
 *
 * @param feedId - The feed.
 * @param holder - The holder.
 * @returns The line.
 */
export function holderLine_format(feedId: number, holder: FeedHolder): string {
  if (holder.kind === 'public') return `setfacl -m o::- feed_${feedId}`;
  return `setfacl -x ${holder.kind === 'user' ? 'u' : 'g'}:${arg_quote(holder.name)} feed_${feedId}`;
}

/**
 * What a holder's mark and its question say.
 *
 * @param holder - The holder.
 * @returns The words.
 */
function holder_said(holder: FeedHolder): string {
  return holder.kind === 'public' ? 'PUBLIC' : holder.kind === 'group' ? `group ${holder.name}` : holder.name;
}

/**
 * Wires the access verbs to a host.
 *
 * @param context - The console and the wire.
 * @param hooks - The pane question, the session's user, the refresh.
 * @returns The access verbs.
 */
export function access_wire(context: Pick<HostContext, 'terminal' | 'client'>, hooks: AccessHooks): AccessVerbs {
  const quiet = { silent: true, observe: false };

  const holders_read = async (feedId: number): Promise<FeedHolders | null> => {
    try {
      return holders_extract(await context.client.line_execute(`getfacl feed_${feedId}`, quiet));
    } catch {
      return null;
    }
  };

  /** The groups the session's user belongs to, read from /etc/group. */
  const groups_read = async (): Promise<string[]> => {
    const user: string | null = hooks.promptUser();
    if (user === null) return [];
    try {
      const outcome: ExecuteOutcome = await context.client.line_execute('cat /etc/group', quiet);
      return groupsOf_user(outcome.envelopes.map((envelope): string => envelope.rendered).join(''), user);
    } catch {
      return [];
    }
  };

  const holder_remove = async (paneId: string, feedId: number, holder: FeedHolder): Promise<void> => {
    const answer: string | null = await hooks.askOnPane_await(paneId, { kind: 'confirm', message: `Stop sharing feed_${feedId} with ${holder_said(holder)}? ` });
    if (answer !== 'y') return;
    if (await lineVisible_run(context, holderLine_format(feedId, holder))) hooks.changed(feedId);
  };

  const holders_build = (paneId: string, feedId: number, holders: FeedHolders): HTMLElement => {
    const marks: HTMLSpanElement = document.createElement('span');
    marks.className = 'holder-marks';
    const all: FeedHolder[] = [
      ...holders.users.map((name: string): FeedHolder => ({ kind: 'user', name })),
      ...holders.groups.map((name: string): FeedHolder => ({ kind: 'group', name })),
      ...(holders.public ? [{ kind: 'public' } as FeedHolder] : []),
    ];
    if (all.length === 0) {
      marks.textContent = 'SHARED WITH NOBODY';
      return marks;
    }
    marks.append('SHARED WITH ');
    for (const holder of all) {
      const mark: HTMLSpanElement = document.createElement('span');
      mark.className = `holder-mark holder-${holder.kind}`;
      mark.title = holder_said(holder);
      const name: HTMLSpanElement = document.createElement('span');
      name.className = 'holder-mark-name';
      name.textContent = holder_said(holder);
      mark.append(name);
      const remove: HTMLSpanElement = document.createElement('span');
      remove.className = 'holder-mark-x';
      remove.title = `stop sharing with ${holder_said(holder)} (asks first)`;
      remove.textContent = '×';
      remove.addEventListener('click', (event: MouseEvent): void => {
        event.stopPropagation();
        void holder_remove(paneId, feedId, holder);
      });
      mark.append(remove);
      marks.append(mark);
    }
    return marks;
  };

  const share_choose = async (paneId: string, feedId: number): Promise<void> => {
    for (;;) {
      const [holders, groups] = await Promise.all([holders_read(feedId), groups_read()]);
      const held: FeedHolders = holders ?? { users: [], groups: [], public: false };
      const choices: PaneAskChoice[] = [
        { value: 'o::r', label: 'EVERYONE', held: held.public },
        ...groups.map((group: string): PaneAskChoice => ({ value: `g:${group}:r`, label: group, held: held.groups.includes(group) })),
      ];
      const answer: string = ((await hooks.askOnPane_await(paneId, {
        kind: 'choose',
        message: `Share feed_${feedId} with a group, everyone, or a user: `,
        choices,
        commit: 'SHARE',
        close: 'DONE',
      })) ?? '').trim();
      if (answer === '') return;
      if (!(await lineVisible_run(context, `setfacl -m ${arg_quote(shareEntry_derive(answer))} feed_${feedId}`))) return;
      hooks.changed(feedId);
    }
  };

  const rename = async (paneId: string, feedId: number, title: string): Promise<void> => {
    const answer: string = ((await hooks.askOnPane_await(paneId, { kind: 'text', message: `Rename feed_${feedId} to: `, suggest: title, commit: 'RENAME' })) ?? '').trim();
    if (answer === '' || answer === title) return;
    if (await lineVisible_run(context, saveLine_compose(`/proc/jobs/feed_${feedId}/title`, answer))) hooks.changed(feedId);
  };

  return { holders_read, holders_build, share_choose, rename };
}
