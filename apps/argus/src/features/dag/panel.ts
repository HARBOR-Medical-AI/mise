/**
 * @file The DAG pane: a feed's live execution graph, drawn beside the files
 * it produces.
 *
 * The pane is a projection of the `feed.dag` envelope model — it issues no
 * bespoke requests of its own. It follows the working directory the way the
 * files panel does (cd into a feed and its graph appears); an explicit
 * `feed diagram <feed>` pins the shown feed until the cwd enters a
 * different one. Statuses arriving on the typed progress channel recolor
 * nodes in place; the topology itself came once, on the envelope.
 *
 * Selection shows the node's facts; activation lowers to a `cd` of the
 * node's data space — the graph and the filesystem are one object seen
 * twice, so "fly into a node" is navigation, not a new machine.
 *
 * @module
 */
import {
  feedDagModelSchema,
  feedIndexingModelSchema,
  type FeedIndexingModel,
  feedListModelSchema,
  DAG_MODEL_KINDS,
  FEED_LIST_MODEL_KIND,
  PROC_JUMP_MODEL_KIND,
  procJumpModelSchema,
  type ProcJumpModel,
  type FeedDagModel,
  type FeedDagNode,
  type FeedListEntry,
  type PromptContext,
  type WireEnvelope,
  type WatchState,
} from '@fnndsc/menu';
import { barState_clear, barState_set } from '../roster/bar.js';
import { ChrisSpace, type LayoutStrategy, type PhysicsTerms, type SceneNode } from '../../scene/chrisSpace.js';
import { Listing, type ListingStateParts } from '../roster/listing.js';
import { type ListingAction } from '../roster/row.js';
import { FEED_TRAITS } from './roster.js';
import { feedFacts_render } from '../feed/facts.js';
import { FeedFrame, type FeedFrameFacts } from './feedFrame.js';
import { FeedViewFrame, feedHueLegend_build, feedShape_same, feedStatuses_patch, type FeedModes, type FeedVerb } from '../feed/view.js';
import { FollowGuard } from './follow.js';
import type { ProgressMessage } from '../../calypso/client.js';
import { refusalReason_strip } from './refusal.js';
import { paneAsk_open, type PaneAskChoice } from '../ask/paneAsk.js';
import { linkLine_build, linkLine_set } from '../../app/link.js';
import { feedGraph_build, feedMetric_extract, type HueMode, type MetricMode } from '../../scene/feedGraph.js';

/** What the pane asks of its host. */
export interface DagPanelHandlers {
  /** Runs a session command silently (instrument traffic, not transcript). */
  command_run: (line: string) => void;
  /** Lowers a node activation to a visible cd. */
  node_enter: (vfsPath: string) => void;
  /**
   * A dblclick dive arrived inside a node: the host overlays the rooted
   * browser. When absent, activation falls back to `node_enter`.
   */
  node_dive?: (vfsPath: string) => void;
  /** A node was selected: the pane indicates its data address (a regard write). */
  node_regard?: (vfsPath: string) => void;
  /**
   * PROCESS on a node: open the bound catalogue on the node's own data, so
   * the run appends to it. The surface decides where the pane lands; the
   * graph only says which node was asked about.
   */
  node_process?: (node: { vfsPath: string; instanceId: number; label: string }) => void;
  /** A feed was picked in the roster: the pane indicates the feed's address (a regard write). */
  feed_regard?: (procPath: string) => void;
  /**
   * What a roster row may be told to do. The panel knows what a feed IS;
   * only the surface knows what can be done about it, since every verb
   * lowers to a session command.
   */
  feed_verbs?: (feed: FeedListEntry) => ReadonlyArray<ListingAction<FeedListEntry>>;
  /**
   * A roster row was indicated, so the surface may read something out
   * beside its verbs (who a feed is shared with).
   */
  feed_indicated?: (feed: FeedListEntry) => void;
  /** A feed came into view: the layout should summon this pane. */
  feed_shown?: () => void;
  /** The × on a feed's tag: take it off. */
  feed_untag?: (feedId: number, tag: string) => void;
  /** A feed was entered: read its note and tags for the frame (feedMarks_show). */
  feed_entered?: (feedId: number) => void;
  /** NOTE on the frame: the feed's note, in the editor. */
  feed_note?: (feedId: number) => void;
  /** TAG on the frame: ask which tags to hang on the feed. */
  feed_tag?: (feedId: number, worn: ReadonlyArray<string>) => void;
  /** RENAME on the frame: ask for the feed's name. */
  feed_rename?: (feedId: number, title: string) => void;
  /**
   * The pane is the subscription: it holds a watch on the feed it shows
   * and releases it when it stops showing one.
   */
  watch_set?: (subject: string, on: boolean) => void;
}

/** How often the roster re-asks the session while it stays on screen. */
const ROSTER_TICK_MS: number = 60_000;

/**
 * How often the roster re-asks while any feed on it is still working.
 *
 * A run the operator just started is the one thing they watch, and a minute
 * of a row reading RUNNING after it finished is a minute of the surface
 * lying. The roster is cache-resident, so the faster beat costs a read and
 * no visit; it falls back to {@link ROSTER_TICK_MS} once every row is
 * terminal.
 */
const ROSTER_LIVE_TICK_MS: number = 10_000;
/** How long the bar keeps the landed roster line (`FEED LIST CURRENT · n NEW`). */
const ROSTER_CHECK_DWELL_MS: number = 5_000;

/** Statuses a feed wears while it still has work to do. */
const FEED_LIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'scheduled', 'created', 'started']);

/** Feed-id extraction from a working directory. */
const CWD_FEED_PATTERNS: readonly RegExp[] = [
  /\/proc\/jobs\/feed_(\d+)(?:\/|$)/,
  /\/feeds?\/feed_(\d+)(?:\/|$)/,
];

/** What a graph's mode blocks read, lower-cased; empty when a block is absent. */
export interface DagViewModes {
  layout: string;
  projection: string;
  scale: string;
  hue: string;
  census: string;
  draw?: string;
  pulse?: string;
  gravity?: string;
  /** Where the graph stands: the selected job's name, else the feed's (`feed_N`). */
  place?: string | null;
}

/**
 * The console lines that put a graph back into a view, from what its mode
 * blocks read. Every mode is said, in the form that SETS it: a view is
 * replayed on another device, or for another operator, whose own kept
 * modes are not this one's (a bare `dag census` toggled, so a receiver
 * already in CENSUS was taken out of it). Where the graph stands comes
 * last, by name, so a replay never meets a number that is both a feed and
 * a job.
 *
 * @param modes - What the blocks read.
 * @returns The lines, in the order the frame lists the blocks.
 */
export function dagView_lines(modes: DagViewModes): string[] {
  const lines: string[] = [];
  if (modes.layout === 'ranked' || modes.layout === 'molecule') lines.push(`dag layout ${modes.layout}`);
  if (modes.projection === '2d' || modes.projection === '3d') lines.push(`dag projection ${modes.projection}`);
  if (modes.draw === 'spheres' || modes.draw === 'stars') lines.push(`dag draw ${modes.draw}`);
  if (modes.pulse === 'pulse on' || modes.pulse === 'pulse off') lines.push(`dag ${modes.pulse}`);
  if (modes.scale === 'time' || modes.scale === 'size') lines.push(`dag scale ${modes.scale}`);
  if (modes.census === 'census' || modes.census === 'shape') lines.push(`dag census ${modes.census === 'census' ? 'on' : 'off'}`);
  if (modes.gravity === 'gravity on' || modes.gravity === 'gravity off') lines.push(`dag ${modes.gravity}`);
  if (modes.hue === 'status' || modes.hue === 'compute') lines.push(`dag hue ${modes.hue}`);
  if (modes.place !== undefined && modes.place !== null) lines.push(`dag select ${modes.place}`);
  return lines;
}

/** Progress statuses mapped onto the DAG vocabulary. */
const PROGRESS_STATUS_MAP: Readonly<Record<string, string>> = {
  running: 'started',
  done: 'finishedSuccessfully',
  error: 'finishedWithError',
};

/**
 * The DAG pane controller.
 */



/**
 * The feed id a roster filter names, when it is one: a bare id, or a
 * `feed_N` name.
 *
 * @param text - The filter's text.
 * @returns The id, or null when the text names no feed.
 */
export function filterFeedID_parse(text: string): number | null {
  const match: RegExpExecArray | null = /^(?:feed_)?(\d+)$/.exec(text.trim());
  return match === null ? null : Number(match[1]);
}

export class DagPanel {
  private readonly scene: ChrisSpace;
  private readonly canvas: HTMLElement;
  private readonly title: HTMLElement;
  private readonly facts: HTMLElement;
  /** The address of what the graph shows, in its corner. */
  private readonly linkLine: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly strategyPill: HTMLElement;
  /** BACK on the frame: out of the graph, to the roster. */
  private backPill: HTMLElement | null = null;
  /** The feed on stage: NOTE, TAG, and its marks (tags, the note's first line). */
  private readonly feedFrame: FeedFrame;
  private readonly feedList: HTMLElement;
  private readonly handlers: DagPanelHandlers;
  private rosterTimer: ReturnType<typeof setInterval> | null = null;
  private shownFeedId: number | null = null;
  private pinnedFeedId: number | null = null;
  private requestedFeedId: number | null = null;
  /** A hand pick holds against a follow it superseded (its late answer is dropped). */
  private readonly follow: FollowGuard = new FollowGuard();
  private readonly defaultTitle: string;
  /** What scales a molecule node: execution wall time, or output bytes. */
  private metricMode: MetricMode = 'time';
  /** The feed view's frame: its modes, the device's memory of them, the pills (features/feed/view.ts). */
  private readonly feedView: FeedViewFrame;
  /** The feed modes as this pane last put them on its scene. */
  private modesApplied: FeedModes | null = null;
  /** The last shown model, re-projected locally when the scale flips. */
  private lastModel: FeedDagModel | null = null;
  /** The roster last shown, re-rendered on any order change. */
  private lastRoster: FeedListEntry[] = [];
  /** Feeds the daemon currently annunciates as roster arrivals. */
  private arrivals: Set<number> = new Set();
  /**
   * Feeds a filter named by id that the roster lacked, each with the
   * session's answer: null while the ask is out, `listed` when CUBE listed
   * the feed and the roster took it, else CUBE's reason. Forgotten when the
   * filter's text changes.
   */
  private readonly feedAsks: Map<number, string | null> = new Map();
  /** The filter text the miss note last stood for. */
  private filterMissText: string = '';
  /** The miss note on stage, rewritten in place when the answer lands. */
  private filterMissNote: HTMLElement | null = null;
  /**
   * The roster walk as the pane last saw it: `checking` while the session
   * walks the feed index (asked by REFRESH, or on its own at login and when
   * a total moved), then the landed line for a few seconds, then nothing.
   */
  private rosterCheck: 'checking' | { landed: string } | null = null;
  /** Clears the landed line after its dwell. */
  private rosterCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** The pane's root, where its questions stand. */
  private paneRoot: HTMLElement | null = null;
  /** CLEAR NEW on the roster frame, shown only while something is NEW. */
  private clearNewPill: HTMLElement | null = null;
  /** A JUMP TO asked of the session and not yet answered. */
  private jumpPending: boolean = false;
  /** The node a jump landed on, selected once its feed's graph is drawn. */
  private jumpNode: number | null = null;
  /** Whether the node a jump lands on is then entered (`dag enter`). */
  private jumpEnter: boolean = false;
  /** The last arrival set seen, so one set asks for the roster once. */
  private arrivalsKey: string = '';
  /** The roster, declared into the listing façade. */
  private readonly listing: Listing<FeedListEntry>;
  /** The title bar's state span (LIVE / SETTLED / STALE on a graph; the listing writes FILTERED n/m). */
  private readonly stateSpan: HTMLElement | null;
  /** The feed this pane currently holds a watch on. */
  private watchedFeedId: number | null = null;
  /** The watched feed's last reported liveness. */
  private liveState: WatchState | null = null;
  /** A feed the operator selected whose graph has not arrived yet. */
  private pendingFeedId: number | null = null;
  /** The cwd as last observed, so a follow answers a MOVE, not a promptline. */
  private lastCwd: string | null = null;

  /**
   * @param canvas - The element the scene renders into.
   * @param title - The pane header's title element.
   * @param facts - The selection facts chip.
   * @param empty - The empty-state element.
   * @param strategyPill - The ranked/molecule toggle pill.
   * @param handlers - Host callbacks.
   */
  constructor(
    canvas: HTMLElement,
    title: HTMLElement,
    facts: HTMLElement,
    empty: HTMLElement,
    strategyPill: HTMLElement,
    feedList: HTMLElement,
    handlers: DagPanelHandlers,
  ) {
    this.feedList = feedList;
    this.canvas = canvas;
    // No graph yet, no canvas: an empty scene above the chooser or the
    // empty-state hint is dead space. First arrival shows it.
    canvas.style.display = 'none';
    this.title = title;
    this.defaultTitle = title.textContent ?? '';
    this.facts = facts;
    this.empty = empty;
    this.strategyPill = strategyPill;
    this.handlers = handlers;
    const paneRootEl: HTMLElement | null = strategyPill.closest<HTMLElement>('.pane-dag');
    this.paneRoot = paneRootEl;
    // JUMP TO: a feed or a node by its number or name (a-share-is-seen-on-the-next-look).
    paneRootEl?.querySelector<HTMLElement>('.runs-jump')?.addEventListener('click', (): void => { void this.jump_ask(); });
    // CLEAR NEW: every NEW mark off at once.
    this.clearNewPill = paneRootEl?.querySelector<HTMLElement>('.runs-clearnew') ?? null;
    this.clearNewPill?.addEventListener('click', (): void => this.unseen_clear('all'));
    // The link line: the address that opens ARGUS on the selected node, or
    // the feed, standing in the graph's corner; it follows the facts.
    this.linkLine = linkLine_build('/proc/jobs');
    this.linkLine.classList.add('dag-linkline');
    this.linkLine.hidden = true;
    facts.parentElement?.appendChild(this.linkLine);
    this.observe_keep(new MutationObserver((): void => this.linkLine_refresh())).observe(facts, { childList: true });
    this.stateSpan = paneRootEl?.querySelector<HTMLElement>('.pane-state') ?? null;
    this.modeSpan = paneRootEl?.querySelector<HTMLElement>('.pane-mode') ?? null;
    const verbs: DagPanelHandlers['feed_verbs'] = handlers.feed_verbs;
    this.listing = new Listing<FeedListEntry>({
      mount: this.feedList,
      traits: FEED_TRAITS,
      key: (feed: FeedListEntry): string => String(feed.id),
      chrome: paneRootEl === null ? undefined : { root: paneRootEl, prefix: 'runs' },
      // Declared verbs ride the frame's row zone on indication; a roster
      // given none keeps its single click. OPEN is the control either way.
      actions: verbs === undefined ? undefined : { of: (feed: FeedListEntry): ReadonlyArray<ListingAction<FeedListEntry>> => verbs(feed) },
      control: 'control',
      terms: [{ key: 'tag', value: (feed: FeedListEntry): string => (feed.tags ?? []).join(' ') }],
      activate: (feed: FeedListEntry): void => this.feed_activate(feed),
      indicated: (feed: FeedListEntry): void => this.handlers.feed_indicated?.(feed),
      row: {
        // Row state is not a column: a feed's status and its arrival mark
        // the row, they do not sit under a cap.
        className: (feed: FeedListEntry): string =>
          `feedlist-row feedlist-${feed.status}${this.arrivals.has(feed.id) ? ' feedlist-arrived' : ''}${feed.new === true ? ' feedlist-new' : ''}`,
        decorate: (element: HTMLElement, feed: FeedListEntry): void => {
          element.dataset['feed'] = String(feed.id);
          // NEW since the last visit: who shared it rides beside the title.
          if (feed.new === true) {
            const mark: HTMLSpanElement = document.createElement('span');
            mark.className = 'feedlist-newmark';
            mark.textContent = `NEW · FROM ${feed.owner.toUpperCase()}`;
            element.querySelector('.feedlist-title')?.append(mark);
          }
          element.title = verbs === undefined
            ? 'enter the feed (Esc returns to this list)'
            : 'click to indicate, double-click to enter (Esc returns to this list)';
        },
      },
      // The bar is the graph's while a graph is on stage (LIVE / SETTLED /
      // STALE); the listing's summary is written only while the roster is.
      state: (parts: ListingStateParts): string | null =>
        this.canvas.style.display === 'block' ? null : [parts.filter, (parts.shed ?? 0) > 0 ? `${parts.shed} COLUMN${parts.shed === 1 ? '' : 'S'} HIDDEN` : '', this.rosterCheck_line() || this.newCount_line()].filter(Boolean).join(' · '),
      // REFRESH: ask CUBE for the feed list again, now. The walk runs off
      // the lane and the bar says so (a-share-is-seen-on-the-next-look).
      refresh: (): void => this.handlers.command_run('proc feeds --fresh'),
      // A filter that matches nothing says so; one that names a feed by id
      // asks the session for it (a-share-is-seen-on-the-next-look).
      filteredEmpty: (text: string): HTMLElement => this.filterMiss_note(text),
      defaultSort: { key: 'createdAt', dir: 'desc' },
    });
    // A tag mark answers its own press before the row hears it.
    this.feedList.addEventListener('click', (event: MouseEvent): void => this.tagMark_press(event), { capture: true });
    this.feedList.addEventListener('dblclick', (event: MouseEvent): void => { if (event.target instanceof Element && event.target.closest('.feedlist-tag') !== null) event.stopPropagation(); }, { capture: true });
    // The roster is the subscription too: while the list stays on screen it
    // re-asks the session, so a feed run from a console — or from this very
    // surface — shows up, and settles, without a reload. Nothing is asked
    // while the pane is off stage or hidden behind another tab. The beat
    // follows the work: fast while a listed feed is live, slow when all of
    // them have finished.
    this.rosterTimer = setInterval((): void => {
      if (!this.feedList.isConnected || !this.rosterShown) return;
      if (this.rosterPending || document.visibilityState !== 'visible') return;
      const live: boolean = this.lastRoster.some((feed: FeedListEntry): boolean => FEED_LIVE_STATUSES.has(feed.status));
      const due: number = live ? ROSTER_LIVE_TICK_MS : ROSTER_TICK_MS;
      if (Date.now() - this.rosterAskedAt < due) return;
      this.rosterAskedAt = Date.now();
      this.handlers.command_run('proc feeds');
    }, ROSTER_LIVE_TICK_MS);
    this.scene = new ChrisSpace(canvas, {
      select: (node: SceneNode): void => this.facts_show(node),
      activate: (node: SceneNode): void => this.node_activate(node),
      deselect: (): void => this.facts.replaceChildren(),
    });
    // BACK heads the frame: the way out of a graph is a press, as it is out
    // of a node and out of an entered feed in the universe — Esc does the
    // same, and a phone has no Esc. From a graph it returns to the roster
    // beneath; a graph that arrived with no roster beneath it (cwd-follow)
    // asks for one. Hidden while the roster is what is shown.
    this.backPill = strategyPill.parentElement?.querySelector<HTMLElement>('.dag-back') ?? null;
    this.feedFrame = new FeedFrame(strategyPill.parentElement, {
      ...handlers,
      shown: (): number | null => this.shownFeedId,
      name: (): string => this.lastModel?.feedName ?? '',
      // A renamed feed's bar says its new name without waiting for the graph to be asked again.
      renamed: (feedId: number, title: string): void => {
        if (this.lastModel !== null) this.lastModel = { ...this.lastModel, feedName: title };
        this.title.textContent = `DAG · FEED ${feedId} — ${title}`.toUpperCase();
      },
    });
    this.backPill?.addEventListener('click', (): void => {
      if (!this.nav_pop()) this.feedsChooser_request();
    });
    // The facts overlay is where the operator looks when they pick a node,
    // and on a phone it is most of the picture: a tap on its own ground
    // (not on a row or a verb) stands it down, as a tap on empty space
    // does — the operator who taps "the background" and lands on the
    // overlay meant the same thing.
    this.facts.addEventListener('click', (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('button, a, input') !== null) return;
      if (this.facts.classList.contains('dag-facts-immersed')) return;
      this.scene.selection_clear();
      this.factsShown = null;
      this.facts.replaceChildren();
    });
    // The feed view's frame (law a-feed-has-one-view): arrangement,
    // projection, draw, pulse, metric, census, gravity and hue are the feed
    // view's own modes, remembered per device, wired once (features/feed/view.ts)
    // and mounted by this pane and by the universe's descent alike.
    this.feedView = new FeedViewFrame(strategyPill.parentElement, {
      changed: (verb: FeedVerb, modes: FeedModes): void => this.feedMode_apply(verb, modes),
    });
    this.metricMode = this.feedView.modes_get().metric;
    this.hueMode = this.feedView.modes_get().hue;
    this.scalePill = this.feedView.pill_find('metric');
    this.huePill = this.feedView.pill_find('hue');
    // What this device last chose stands from the first graph: a feed opens
    // as its tree, root on top, unless the device chose otherwise.
    this.feedModes_recall();
    // The language reaches the expert knobs through DOM events on the pane
    // (verbs run over the DOM, never a private API).
    const paneRoot: HTMLElement | null = strategyPill.closest<HTMLElement>('.pane-dag');
    paneRoot?.addEventListener('argus:dag-physics', (event: Event): void => {
      const detail = (event as CustomEvent<{ term: string; on: boolean } | 'reset'>).detail;
      if (detail === 'reset') {
        this.scene.physics_set({ charge: true, link: true, collide: true });
        return;
      }
      if (detail.term === 'gravity') {
        if (this.scene.physics_get().gravity !== detail.on) this.feedView.press('gravity');
        return;
      }
      this.scene.physics_set({ [detail.term]: detail.on } as Partial<PhysicsTerms>);
    });
    // The THEME pill re-seats the palette on the root element; follow it.
    this.observe_keep(new MutationObserver((): void => this.scene.palette_refresh())).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] },
    );
    window.addEventListener('resize', (): void => this.scene.size_fit(), { signal: this.released.signal });
    // A zoom glide resizes the canvas without a window resize; refit once
    // the transition has settled.
    this.observe_keep(new MutationObserver((): void => {
      if (this.zoomTimer !== null) window.clearTimeout(this.zoomTimer);
      this.zoomTimer = window.setTimeout((): void => {
        this.zoomTimer = null;
        this.scene.size_fit();
      }, 600);
    })).observe(document.body, { attributes: true, attributeFilter: ['data-zoom'] });
  }

  /** The observers the pane put on the document and on its own nodes, kept so a closed pane lets them go. */
  private readonly observers: MutationObserver[] = [];
  /** Aborted when the pane closes: its listener on the window hears nothing more. */
  private readonly released: AbortController = new AbortController();
  /** The wait before the scene is refitted after a zoom glide; null when none is pending. */
  private zoomTimer: number | null = null;

  /**
   * Keeps an observer so that closing the pane disconnects it.
   *
   * @param observer - The observer.
   * @returns The same observer.
   */
  private observe_keep(observer: MutationObserver): MutationObserver {
    this.observers.push(observer);
    return observer;
  }

  /**
   * Observes every session envelope; a `feed.dag` model repaints the pane.
   * An explicit invocation (any feed.dag arrival not requested by the pane
   * itself) pins the feed.
   *
   * @param envelope - Any envelope crossing the session.
   */
  public envelope_observe(envelope: WireEnvelope): void {
    if (this.jump_take(envelope)) return;
    if (this.feedAsk_take(envelope)) return;
    if (envelope.model?.kind === FEED_LIST_MODEL_KIND) {
      // Taken when asked for, or onto a roster: another command's listing never pulls a graph off stage.
      const asked: boolean = this.rosterPending || this.rosterShown;
      this.rosterPending = false;
      const roster = feedListModelSchema.safeParse(envelope.model.data);
      if (roster.success && (asked || this.canvas.style.display === 'none')) {
        this.chooser_show(roster.data.feeds);
      }
      return;
    }
    if (this.pendingFeedId !== null && envelope.status === 'error' && envelope.model === undefined) {
      this.feedRequest_refuse(envelope.renderedErr ?? envelope.rendered ?? '');
      return;
    }
    if (this.rosterPending && envelope.status === 'error') {
      // The roster request was refused (the warmup guard declines global
      // queries over a half-built index). A loading row that outlives its
      // request is a lie: show the refusal, and let the prompt context
      // keep the warming figure honest below it.
      this.rosterPending = false;
      this.rosterRefusal_show(envelope);
      return;
    }
    if (envelope.model?.kind === DAG_MODEL_KINDS.feedIndexing) {
      this.feedIndexing_take(envelope.model.data);
      return;
    }
    if (envelope.model?.kind === DAG_MODEL_KINDS.feedDag) this.feedDag_take(envelope.model.data);
  }

  /**
   * The session answered at once: the feed's topology is on its way. The
   * pane holds its LOADING posture, names the walk, and opens the feed's
   * watch, which carries the graph in when the walk lands.
   *
   * @param data - The model's data, unparsed.
   */
  private feedIndexing_take(data: unknown): void {
    const indexing = feedIndexingModelSchema.safeParse(data);
    if (!indexing.success || this.follow.drops(indexing.data.feedId, this.pinnedFeedId)) return;
    if (this.requestedFeedId === indexing.data.feedId) {
      this.requestedFeedId = null;
    } else if (this.pendingFeedId !== indexing.data.feedId) {
      // The operator asked for this one by hand (the console, or another
      // surface): it is the feed on its way, so pin it as a graph would be.
      this.pinnedFeedId = indexing.data.feedId;
      this.pendingFeedId = indexing.data.feedId;
    }
    this.feedIndexing_show(indexing.data);
  }

  /**
   * A feed's graph arrived: it takes the whole pane, patches in place when
   * it is the feed on stage in the same shape, and opens the feed's watch.
   *
   * @param data - The model's data, unparsed.
   */
  private feedDag_take(data: unknown): void {
    const parsed = feedDagModelSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const model: FeedDagModel = parsed.data;
    if (this.follow.drops(model.feedId, this.pinnedFeedId)) return;
    if (this.requestedFeedId === model.feedId) {
      this.requestedFeedId = null;
    } else {
      // The operator asked for this one by hand: pin it.
      this.pinnedFeedId = model.feedId;
    }
    this.shownFeedId = model.feedId;
    this.pendingFeedId = null;
    this.linkLine_refresh();
    // The graph is the press's answer: the roster row it lit stands down.
    this.listing.activation_settle();
    barState_clear(this.stateSpan, 'wait');
    this.title.textContent = `DAG · FEED ${model.feedId} — ${model.feedName}`.toUpperCase();
    this.empty.style.display = 'none';
    // A graph arrival always takes the whole pane: selecting a feed IS
    // entering it. (The half-pane "preview above the list" is gone; live
    // scrubbing returns when a context split exists to receive it.)
    this.roster_show(false);
    this.canvas.style.display = 'block';
    if (this.lastModel !== null && this.lastModel.feedId !== model.feedId) {
      // A different feed owes nothing to the old one: stale selection facts
      // must not haunt the new graph.
      this.facts.replaceChildren();
      this.scene.selection_clear();
    }
    const previous: FeedDagModel | null = this.lastModel;
    this.lastModel = model;
    // A feed entered stands in the device's remembered modes, whichever door
    // last turned them (a-feed-has-one-view): the universe may have, since.
    this.feedModes_recall();
    // The feed on stage asked again (a second open, a watch's answer):
    // the same shape patches in place — a rebuild would resettle the graph
    // and drop its tubes and pulses mid-run.
    if (previous !== null && previous.feedId === model.feedId && feedShape_same(previous, model)) {
      this.statuses_patch(model);
    } else {
      this.graph_show(model);
    }
    this.watch_open(model.feedId);
    // A feed opened is a feed seen: its NEW mark comes off.
    if (this.lastRoster.some((feed: FeedListEntry): boolean => feed.id === model.feedId && feed.new === true)) this.unseen_clear([model.feedId]);
    // A jump to a node lands on its feed, then on the node.
    if (this.jumpNode !== null) {
      if (this.scene.selection_set(String(this.jumpNode))) {
        this.jumpNode = null;
        // `dag enter`: once the node is selected, ENTER NODE is pressed as by hand.
        if (this.jumpEnter) {
          this.jumpEnter = false;
          window.setTimeout((): void => {
            [...this.facts.querySelectorAll<HTMLButtonElement>('button')].find((button: HTMLButtonElement): boolean => button.textContent?.trim() === 'ENTER NODE')?.click();
          }, 0);
        }
      }
    }
    // A feed entered (not a repaint of the one on stage) reads its note and tags.
    this.feedFrame.arrived(model.feedId);
    this.handlers.feed_shown?.();
  }

  /**
   * Takes the device's remembered feed modes and puts on the scene what
   * moved since this pane last applied them (the other door may have turned
   * one): nothing that held is re-applied, so an unchanged view never relays out.
   *
   * @returns Whether anything that redraws the feed moved (metric, hue, draw).
   */
  private feedModes_recall(): boolean {
    const kept: FeedModes = this.feedView.recall();
    const was: FeedModes | null = this.modesApplied;
    this.modesApplied = kept;
    if (was === null || was.strategy !== kept.strategy) this.scene.strategy_set(kept.strategy);
    if (was === null || was.projection !== kept.projection) this.scene.projection_set(kept.projection);
    if (was === null || was.draw !== kept.draw) this.scene.draw_set(kept.draw);
    if (was === null || was.pulse !== kept.pulse) this.scene.waveLoop_set(kept.pulse);
    if (was === null || was.census !== kept.census) this.scene.census_set(kept.census);
    if (was === null || was.gravity !== kept.gravity) this.scene.physics_set({ gravity: kept.gravity });
    this.metricMode = kept.metric;
    this.hueMode = kept.hue;
    this.modes_render();
    return was !== null && (was.metric !== kept.metric || was.hue !== kept.hue || was.draw !== kept.draw);
  }

  /**
   * The pane is back on stage: the device's feed memory may have moved while
   * it was away (a mode turned in the universe on the same feed), so it is
   * taken again, and the feed on stage redrawn when what moved redraws it.
   */
  public stage_returned(): void {
    if (this.feedModes_recall() && this.lastModel !== null && this.canvas.style.display !== 'none') this.graph_show(this.lastModel, false);
  }

  /**
   * Applies one feed-view mode the frame turned: a scene call, or a redraw
   * of the feed for the metric and the hue.
   *
   * @param verb - The mode.
   * @param modes - The modes as they now stand.
   */
  private feedMode_apply(verb: FeedVerb, modes: FeedModes): void {
    this.modesApplied = modes;
    switch (verb) {
      case 'strategy': this.scene.strategy_set(modes.strategy); break;
      case 'projection': this.scene.projection_set(modes.projection); break;
      case 'draw':
        this.scene.draw_set(modes.draw);
        // Solid follows the draw style; the tubes stay.
        if (this.lastModel !== null) this.graph_show(this.lastModel, false);
        break;
      case 'pulse': this.scene.waveLoop_set(modes.pulse); break;
      case 'census': this.scene.census_set(modes.census); break;
      case 'gravity': this.scene.physics_set({ gravity: modes.gravity }); break;
      case 'metric':
        this.metricMode = modes.metric;
        if (this.lastModel !== null) this.graph_show(this.lastModel, false);
        break;
      case 'hue':
        this.hueMode = modes.hue;
        if (this.lastModel !== null) this.graph_show(this.lastModel, false);
        // A feed restored from an older checkpoint may predate the cache's
        // knowledge of compute: asking for the hue is the operator's consent
        // to re-read the feed's nodes once, and the legend says so meanwhile.
        if (this.hueMode === 'compute' && !this.computeKnown && this.shownFeedId !== null && this.canvas.style.display !== 'none') {
          this.computeRereading = true;
          this.handlers.command_run(`proc refresh ${this.shownFeedId}`);
          this.refresh();
        }
        break;
    }
    this.modes_render();
  }

  /** Reads the entered feed's note, tags and name again (one of them changed). */
  public marks_refresh(): void {
    this.feedFrame.refresh();
  }

  /**
   * Shows the entered feed's facts on the frame (see FeedFrame).
   *
   * @param feedId - The feed read.
   * @param facts - Its note, tags and name.
   */
  public feedMarks_show(feedId: number, facts: FeedFrameFacts): void {
    this.feedFrame.show(feedId, facts);
  }

  /**
   * Holds the pane's watch on the feed it shows, releasing any other.
   *
   * @param feedId - The feed now on stage.
   */
  private watch_open(feedId: number): void {
    if (this.watchedFeedId === feedId) return;
    this.watch_release();
    this.watchedFeedId = feedId;
    this.liveState_show(null);
    this.handlers.watch_set?.(`/proc/jobs/feed_${feedId}`, true);
  }

  /** Releases the pane's watch, if any. */
  private watch_release(): void {
    if (this.watchedFeedId === null) return;
    this.handlers.watch_set?.(`/proc/jobs/feed_${this.watchedFeedId}`, false);
    this.watchedFeedId = null;
    this.liveState_show(null);
  }

  /**
   * Shows the watched feed's liveness in the bar: LIVE while sampled,
   * SETTLED once it can no longer change, STALE when the last sample
   * failed. Honest-wait: an observer must know whether what they see is
   * current. Null clears it (no graph on stage, or none reported yet).
   *
   * @param state - The reported state, or null.
   */
  private modeSpan: HTMLElement | null = null;
  /** What colors a node: its status, or the compute resource it ran on. */
  private hueMode: HueMode = 'status';
  private huePill: HTMLElement | null = null;
  /** The compute legend of the graph on stage: resource → hue. */
  private hueLegend: Map<string, string> = new Map();
  /** Whether any node on stage reports where it ran. */
  private computeKnown: boolean = false;
  /** True while a re-read for compute is in flight. */
  private computeRereading: boolean = false;

  /**
   * Assigns a hue per distinct compute resource in the model, from the
   * frame's own cycle, in order of first appearance; `mixed` groups wear
   * the unknown grey.
   *
   * @param model - The model on stage.
   * @returns Resource → CSS color.
   */
  private hueLegend_build(model: FeedDagModel): Map<string, string> {
    return feedHueLegend_build(model);
  }

  /**
   * The bar's mode readout: every display mode that is not the default,
   * so state stays legible with the mode frame retracted — and nothing
   * at rest (the dark cockpit annunciates nothing at rest).
   */
  private modes_render(): void {
    if (this.modeSpan === null) return;
    const parts: string[] = [];
    if (this.scene.strategy_get() !== 'ranked') parts.push('MOLECULE');
    if (this.scene.projection_get() !== '3d') parts.push('2D');
    if (this.metricMode !== 'time') parts.push('SIZE');
    if (this.scene.census_get()) parts.push('CENSUS');
    if (this.scene.waveLoop_get()) parts.push('PULSE');
    if (this.scene.physics_get().gravity) parts.push('GRAVITY');
    this.modeSpan.replaceChildren(document.createTextNode(parts.join(' · ')));
    if (this.hueMode === 'compute') {
      // The legend travels with the mode: a swatch per resource on the bar.
      const legend: HTMLSpanElement = document.createElement('span');
      legend.className = 'pane-legend';
      legend.append(document.createTextNode(parts.length > 0 ? ' · COMPUTE' : 'COMPUTE'));
      for (const [resource, hue] of this.hueLegend) {
        const swatch: HTMLSpanElement = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.backgroundColor = hue;
        const name: HTMLSpanElement = document.createElement('span');
        name.textContent = resource;
        legend.append(document.createTextNode(' '), swatch, name);
      }
      if (this.hueLegend.size === 0) legend.append(document.createTextNode(this.computeRereading ? ' (re-reading the feed\u2026)' : ' (none reported)'));
      this.modeSpan.appendChild(legend);
    }
  }

  private liveState_show(state: WatchState | null): void {
    this.liveState = state;
    if (this.stateSpan === null) return;
    if (state === null) {
      barState_set(this.stateSpan, null, this.canvas.style.display !== 'none' ? '' : undefined);
      return;
    }
    barState_set(this.stateSpan, state, state.toUpperCase());
  }

  /** The watched feed's last reported liveness (null before any report). */
  public liveState_get(): WatchState | null {
    return this.liveState;
  }

  /** The feed on stage or being retrieved, or null at the roster. */
  public feed_get(): number | null {
    return this.pendingFeedId ?? this.shownFeedId;
  }

  /** Whether a graph is on stage (as against the roster, or a wait). */
  public graph_isShown(): boolean {
    return this.canvas.style.display === 'block';
  }

  /** What the title bar reads for the feed on stage, without the pane's own prefix. */
  public feedTitle_get(): string {
    return (this.title.textContent ?? '').replace(/^DAG\s*·\s*/i, '').trim();
  }

  /**
   * The view the graph is drawn in, as the console lines that reproduce
   * it — only what differs from the defaults, so a desktop replays what
   * the operator chose and nothing else.
   */
  /** The selected job's `/proc` name, else the feed's, else null. */
  private place_name(): string | null {
    const selected: FeedDagNode | undefined = this.factsShown === null || this.facts.childElementCount === 0 ? undefined : this.factsPayloads.get(this.factsShown.id);
    const name: string | undefined = selected?.vfsPath.replace(/\/data$/, '').split('/').pop();
    if (name !== undefined && name !== '') return name;
    return this.shownFeedId === null ? null : `feed_${this.shownFeedId}`;
  }

  public view_lines(): string[] {
    const frame: HTMLElement | null = this.strategyPill.parentElement;
    const read = (selector: string): string => frame?.querySelector<HTMLElement>(selector)?.textContent?.trim().toLowerCase() ?? '';
    return dagView_lines({
      layout: read('.dag-strategy'),
      projection: read('.dag-projection'),
      scale: read('.dag-scale'),
      hue: read('.dag-hue'),
      census: read('.dag-census'),
      draw: read('.dag-draw'),
      pulse: read('.dag-pulse'),
      gravity: read('.dag-gravity'),
      place: this.place_name(),
    });
  }

  /**
   * A watched subject's liveness changed. Only the feed on stage is this
   * pane's business.
   *
   * @param subject - The watched subject address.
   * @param state - Its reported state.
   */
  public watched_observe(subject: string, state: WatchState): void {
    const match: RegExpMatchArray | null = /feed_(\d+)$/.exec(subject);
    // Only a watch this pane still holds is its business: the daemon also
    // answers an unwatch with the subject's state, and a pane that just
    // left the feed must not paint that answer.
    if (!match || Number(match[1]) !== this.watchedFeedId) return;
    this.liveState_show(state);
  }

  /**
   * A refreshed model arrived from the session's sampler. It repaints only
   * the feed on stage, never pins, never waves, and keeps the scene's
   * positions: same groups with the same counts patch status and facts in
   * place, anything else re-lays out warm from the last positions — so the
   * census only re-expands when a group's count moved.
   *
   * @param model - The refreshed feed model.
   */
  public model_refresh(model: FeedDagModel): void {
    // The graph a pending pane was waiting for: the walk landed and the
    // watch was kicked. It arrives as the answer to the ask, not as a
    // repaint, so it takes the pane the way a requested graph does.
    if (this.pendingFeedId === model.feedId && this.canvas.style.display === 'none') {
      this.envelope_observe({ status: 'ok', rendered: '', model: { kind: DAG_MODEL_KINDS.feedDag, data: model } });
      return;
    }
    if (this.shownFeedId !== model.feedId || this.canvas.style.display === 'none') return;
    const previous: FeedDagModel | null = this.lastModel;
    this.lastModel = model;
    if (previous !== null && feedShape_same(previous, model)) {
      this.statuses_patch(model);
      return;
    }
    this.graph_show(model, false);
  }

  /**
   * Patches a same-shaped model's statuses and facts into the scene in
   * place.
   *
   * @param model - The model, the same shape as the one on stage.
   */
  private statuses_patch(model: FeedDagModel): void {
    feedStatuses_patch(this.scene, model);
    for (const node of model.nodes) this.factsPayloads.set(node.id, node);
    // The pane is watching because something is moving; the facts on
    // screen are part of what moved.
    if (this.factsShown !== null) this.facts_show(this.factsShown);
  }

  /**
   * Revisits the feed on stage now (the drawer's REFRESH, or `dag refresh`).
   * The answer is a fresh model through the ordinary request path; a watch
   * keeps sampling on its own beat regardless.
   */
  public refresh(): void {
    if (this.shownFeedId === null || this.canvas.style.display === 'none') return;
    this.requestedFeedId = this.shownFeedId;
    this.handlers.command_run(`feed diagram feed_${this.shownFeedId}`);
  }

  /** The scale pill, dimmed when the feed carries no data for its mode. */
  private scalePill: HTMLElement | null = null;

  /** Renders a model into the scene under the current metric mode. */
  private graph_show(model: FeedDagModel, wave: boolean = true): void {
    // Honesty on the pill itself: a mode with no data behind it dims and
    // says so, instead of silently rendering an unchanged graph.
    const hasData: boolean = model.nodes.some((node: FeedDagNode): boolean => feedMetric_extract(node, this.metricMode) !== undefined);
    this.scalePill?.classList.toggle('rail-na', !hasData);
    if (this.scalePill !== null) {
      this.scalePill.title = hasData
        ? 'molecule node size: wall time or output bytes'
        : `no ${this.metricMode === 'time' ? 'wall-time' : 'output-size'} data in this feed's cache yet`;
    }
    // Honesty on the HUE block: a feed whose nodes report no compute dims it.
    this.hueLegend = this.hueLegend_build(model);
    const anyCompute: boolean = model.nodes.some((node: FeedDagNode): boolean => node.computeResource !== undefined);
    this.computeKnown = anyCompute;
    if (anyCompute) this.computeRereading = false;
    this.huePill?.classList.toggle('rail-na', !anyCompute);
    if (this.huePill !== null) {
      this.huePill.title = anyCompute
        ? 'what colors a node: its status, or the compute resource it ran on'
        : "no compute resource reported for this feed's nodes yet";
    }
    // The feed view's own reading (law a-feed-has-one-view), the descent's too.
    this.scene.graph_set({ nodes: feedGraph_build(model, { metric: this.metricMode, hue: this.hueMode, legend: this.hueLegend, draw: this.feedView.modes_get().draw }).nodes }, { wave });
    this.scene.size_fit();
    if (this.hueMode === 'compute') this.modes_render();
    this.factsPayloads.clear();
    for (const node of model.nodes) {
      this.factsPayloads.set(node.id, node);
    }
    // A redrawn graph carries new facts for the node the operator is
    // looking at; the overlay is repainted from them, or stood down when
    // the node it was showing is no longer in the graph.
    if (this.factsShown !== null) {
      if (this.factsPayloads.has(this.factsShown.id)) this.facts_show(this.factsShown);
      else this.factsShown = null;
    }
  }

  /** Node facts, kept for the selection chip. */
  private readonly factsPayloads: Map<string, FeedDagNode> = new Map();

  /** The node whose facts are on the overlay, so a live model can repaint it. */
  private factsShown: SceneNode | null = null;

  /**
   * Follows the working directory: entering a different feed's tree
   * refreshes the pane (and releases a pin on a feed left behind).
   *
   * @param context - The pushed prompt context.
   */
  public promptContext_observe(context: PromptContext): void {
    if (this.rosterProgress !== null && this.rosterProgress.isConnected) {
      const warm = context.procWarmup;
      if (warm?.total !== undefined && warm.total > 0 && warm.sweeping !== false) {
        const percent: number = Math.floor((warm.loaded / warm.total) * 100);
        this.rosterProgress.textContent =
          `INDEX WARMING \u2014 ${warm.loaded}/${warm.total} (${percent}%). The roster opens when the index is whole.`;
      }
      if (warm === undefined || warm.sweeping === false || warm.state === 'cached') {
        // The index came whole: ask again on the operator's behalf.
        this.rosterProgress = null;
        this.feedsChooser_request();
      }
    }
    this.arrivals_observe(context.procWarmup?.arrived ?? []);
    this.rosterCheck_observe(context.procWarmup?.roster, context.procWarmup?.arrived ?? []);
    // A feed being indexed for this pane: the count moves with the prompt.
    const walks = context.procWarmup?.feeds ?? (context.procWarmup?.feed !== undefined ? [context.procWarmup.feed] : []);
    const walk = walks.find((w): boolean => w.id === this.pendingFeedId);
    if (walk !== undefined) {
      this.feedIndexing_show({ feedId: walk.id, loaded: walk.loaded, total: walk.total, ...(walk.failed !== undefined ? { failed: walk.failed } : {}) });
    }
    // Promptlines arrive after every command, the pane's own silent ones
    // included; only a cwd that actually MOVED is a reason to follow. A
    // pinned feed therefore survives until the operator cds somewhere else
    // (observed: a session parked inside feed 21 replaced every pick with
    // feed 21 a few seconds later). The cwd is recorded on EVERY promptline,
    // before the reasons not to follow: recorded only when following, it
    // went stale while the roster stood, and the next promptline after a
    // pick read a move from minutes ago and replaced the pick with it.
    const moved: boolean = this.lastCwd !== null && context.cwd !== this.lastCwd;
    this.lastCwd = context.cwd;
    // An offstage pane must not queue diagram traffic: following the cwd
    // while nobody can see the graph is pure session-queue congestion (and
    // exactly the kind of delay RUNS-02 then sits behind).
    if (!this.canvas.isConnected) {
      return;
    }
    // The roster is a place the operator chose (RUNS-02 always lands on
    // it): while it is on stage, a cwd that happens to sit inside a feed
    // must not paint that feed over it. Following resumes on the next move
    // once a graph is up.
    if (this.rosterShown || this.pendingFeedId !== null) {
      return;
    }
    if (!moved) {
      return;
    }
    const feedId: number | null = cwdFeed_find(context.cwd);
    if (feedId === null) {
      return;
    }
    if (feedId === this.shownFeedId) {
      return;
    }
    if (this.pinnedFeedId !== null && feedId === this.pinnedFeedId) {
      return;
    }
    // A different feed underfoot re-follows, ending any pin.
    this.pinnedFeedId = null;
    this.requestedFeedId = feedId;
    this.handlers.command_run(`feed diagram feed_${feedId}`);
  }

  /**
   * Recolors a node when the progress channel reports its job moving.
   *
   * @param message - A typed progress message.
   */
  public progress_observe(message: ProgressMessage): void {
    if (message.itemId === undefined) {
      return;
    }
    const status: string | undefined =
      message.status !== undefined ? PROGRESS_STATUS_MAP[message.status] : undefined;
    if (status !== undefined) {
      this.scene.status_update(String(message.itemId), status);
    }
  }

  /** Refits the scene after a zoom transition settles. */
  public size_fit(): void {
    this.scene.size_fit();
  }

  /**
   * Releases everything the pane took, so that a closed pane is held by
   * nothing: its watch, its timers, its observers (two of them on the
   * document), its listener on the window, its listing and its scene.
   */
  public dispose(): void {
    this.watch_release();
    if (this.rosterTimer !== null) clearInterval(this.rosterTimer);
    this.rosterTimer = null;
    if (this.rosterCheckTimer !== null) clearTimeout(this.rosterCheckTimer);
    this.rosterCheckTimer = null;
    if (this.zoomTimer !== null) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = null;
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
    this.rosterFrameObserver?.disconnect();
    this.rosterFrameObserver = null;
    this.released.abort();
    this.listing.hold_release();
    this.scene.dispose();
  }

  /** Enters a feed by id: pins it and fetches its graph (the textual verb). */
  public feed_enter(feedId: number): void {
    this.follow.pick(this.requestedFeedId, feedId);
    this.pinnedFeedId = feedId;
    this.requestedFeedId = null;
    this.feedRequest_show(feedId);
    this.handlers.command_run(`feed diagram feed_${feedId}`);
  }

  /**
   * Answers a selection at once: the roster steps aside, the pane says
   * which feed it is retrieving, and the bar reads LOADING until the graph
   * arrives (honest-wait). A large feed takes seconds to project; a roster
   * that stays hoverable for those seconds says nothing was selected.
   *
   * @param feedId - The feed asked for.
   */
  private feedRequest_show(feedId: number): void {
    this.pendingFeedId = feedId;
    this.roster_show(false);
    this.canvas.style.display = 'none';
    this.facts.replaceChildren();
    this.title.textContent = `DAG · FEED ${feedId}`;
    this.empty.textContent = `RETRIEVING FEED ${feedId}…`;
    this.empty.style.display = 'block';
    barState_set(this.stateSpan, 'wait', 'LOADING');
  }

  /**
   * Shows a feed's topology walk in place while it runs: index movement the
   * session started and left to run, so the pane's own request ended at
   * once. The count follows the prompt context; a failure names itself and
   * REFRESH retries.
   *
   * @param indexing - The walk as the session last reported it.
   */
  private feedIndexing_show(indexing: FeedIndexingModel): void {
    if (this.pendingFeedId === null) this.pendingFeedId = indexing.feedId;
    this.roster_show(false);
    this.canvas.style.display = 'none';
    this.title.textContent = `DAG · FEED ${indexing.feedId}`;
    const count: string = indexing.total > 0
      ? `${indexing.loaded.toLocaleString()} / ${indexing.total.toLocaleString()}`
      : `${indexing.loaded.toLocaleString()} / ?`;
    this.empty.textContent = indexing.failed !== undefined
      ? `INDEXING FEED ${indexing.feedId} FAILED AT ${count} — ${indexing.failed.toUpperCase()} — REFRESH RETRIES`
      : `INDEXING FEED ${indexing.feedId} — ${count}`;
    this.empty.style.display = 'block';
    barState_set(this.stateSpan, 'wait', indexing.failed !== undefined ? 'FAILED' : 'LOADING');
    if (indexing.failed === undefined) this.watch_open(indexing.feedId);
  }

  /**
   * A selection was refused (the feed is gone, or the session declined):
   * the roster returns with the refusal above it, and the bar clears.
   *
   * @param reason - The session's rendered refusal.
   */
  private feedRequest_refuse(reason: string): void {
    const feedId: number | null = this.pendingFeedId;
    this.pendingFeedId = null;
    this.listing.activation_settle();
    this.empty.textContent = `FEED ${feedId ?? '?'}: ${reason.trim() || 'not available'}`.toUpperCase();
    this.empty.style.display = 'block';
    this.roster_show(true);
    this.title.textContent = this.defaultTitle;
    barState_clear(this.stateSpan, 'wait');
    this.listing.state_refresh();
  }

  /** Asks for the cache-resident feed roster (the RUNS-02 gesture). */
  public feedsChooser_request(): void {
    // The roster itself is cache-resident, but the request waits in the
    // session queue behind whatever is executing — honesty demands the wait
    // be visible from the first frame.
    const loading: HTMLDivElement = document.createElement('div');
    loading.className = 'feedlist-loading';
    loading.textContent = 'RETRIEVING FEED ROSTER…';
    this.feedList.replaceChildren(loading);
    if (this.canvas.style.display !== 'none') this.graph_leave();
    this.roster_show(true);
    this.rosterPending = true;
    this.rosterAskedAt = Date.now();
    this.handlers.command_run('proc feeds');
  }

  /** An unanswered roster request, awaiting its envelope. */
  private rosterPending: boolean = false;

  /**
   * Lands the pane on a feed or node a link or a word names, as JUMP TO
   * does once it has the answer.
   *
   * @param target - A feed or node id, or its `/proc` name.
   * @param enter - Enter the node once it is selected (ENTER NODE).
   */
  public target_jumpTo(target: string, enter: boolean = false): void {
    this.jumpEnter = enter;
    void this.jump_ask(target);
  }

  /**
   * Points the link line at what the pane shows: the selected node, else
   * the feed; hidden while no graph is on stage.
   */
  private linkLine_refresh(): void {
    if (this.shownFeedId === null) {
      this.linkLine.hidden = true;
      return;
    }
    const selected: FeedDagNode | undefined = this.factsShown === null || this.facts.childElementCount === 0 ? undefined : this.factsPayloads.get(this.factsShown.id);
    linkLine_set(this.linkLine, selected?.vfsPath.replace(/\/data$/, '') ?? `/proc/jobs/feed_${this.shownFeedId}`);
    this.linkLine.hidden = false;
  }

  /**
   * JUMP TO: asks for a feed or node, by number or name, on the pane, then
   * asks the session where that is (`proc jump --where`, which moves
   * nothing). The answer lands the pane; a number that is both a feed and
   * a node is asked again as a choice.
   *
   * @param target - What to jump to, when already known (a choice made).
   */
  private async jump_ask(target?: string): Promise<void> {
    if (this.paneRoot === null) return;
    const asked: string = (target ?? (await paneAsk_open(this.paneRoot, {
      kind: 'text',
      message: 'Jump to a feed or node (4389, feed_4389, pl-dircopy_639204): ',
      commit: 'JUMP',
    })) ?? '').trim();
    if (asked === '' || /\s/.test(asked)) return;
    this.jumpPending = true;
    this.handlers.command_run(`proc jump --where ${asked}`);
  }

  /**
   * Takes the session's answer to a jump: one place lands the pane on it
   * (the feed entered, the node selected when the graph is drawn); several
   * are offered as a choice; none says why on the bar.
   *
   * @param envelope - An envelope the pane observes.
   * @returns Whether it was a jump's answer.
   */
  private jump_take(envelope: WireEnvelope): boolean {
    if (!this.jumpPending) return false;
    if (envelope.model?.kind === PROC_JUMP_MODEL_KIND) {
      this.jumpPending = false;
      const parsed = procJumpModelSchema.safeParse(envelope.model.data);
      if (!parsed.success) return true;
      const model: ProcJumpModel = parsed.data;
      if (model.choices.length === 1) {
        const place: ProcJumpModel['choices'][number] = model.choices[0] as ProcJumpModel['choices'][number];
        this.jumpNode = place.nodeId ?? null;
        this.feed_enter(place.feedId);
        return true;
      }
      void this.jump_choose(model);
      return true;
    }
    if (envelope.status === 'error' && envelope.model === undefined) {
      this.jumpPending = false;
      this.jumpNote_show(refusalReason_strip(envelope.renderedErr || envelope.rendered || '').replace(/^proc jump:\s*/, ''));
      return true;
    }
    return false;
  }

  /**
   * Asks which place a bare number meant, when it is both a feed and a node.
   *
   * @param model - The places the session found.
   */
  private async jump_choose(model: ProcJumpModel): Promise<void> {
    if (this.paneRoot === null) return;
    const choices: PaneAskChoice[] = model.choices.map((place: ProcJumpModel['choices'][number]): PaneAskChoice => ({
      value: place.name,
      label: place.kind === 'feed'
        ? `FEED ${place.feedId} · ${place.title}`
        : `NODE ${place.nodeId ?? ''} · ${place.name.replace(/_\d+$/, '')} IN FEED ${place.feedId}`,
    }));
    const picked: string | null = await paneAsk_open(this.paneRoot, {
      kind: 'choose',
      message: `${model.target} is both a feed and a node: `,
      choices,
      commit: 'JUMP',
    });
    if (picked !== null && picked.trim() !== '') await this.jump_ask(picked.trim());
  }

  /**
   * Says on the bar why a jump went nowhere, for as long as the landed
   * roster line stays.
   *
   * @param reason - The session's reason.
   */
  private jumpNote_show(reason: string): void {
    if (this.rosterCheckTimer !== null) clearTimeout(this.rosterCheckTimer);
    this.rosterCheck = { landed: reason.toUpperCase() };
    if (this.canvas.style.display === 'block') { if (this.stateSpan !== null) this.stateSpan.textContent = reason.toUpperCase(); }
    else this.listing.state_refresh();
    this.rosterCheckTimer = setTimeout((): void => {
      this.rosterCheck = null;
      this.rosterCheckTimer = null;
      this.listing.state_refresh();
    }, ROSTER_CHECK_DWELL_MS * 2);
  }

  /**
   * Follows the session's roster walk on the bar: `CHECKING CUBE FOR THE
   * FEED LIST…` while one runs, `FEED LIST CURRENT · n NEW` (or `NOTHING
   * NEW`) for {@link ROSTER_CHECK_DWELL_MS} when it lands. userB who logs
   * in after a share, or presses REFRESH, is told what the session is
   * doing rather than left to wonder whether the feed will appear.
   *
   * @param roster - The walk the prompt context names, or none.
   * @param arrived - The feed ids the prompt context annunciates as arrivals.
   */
  private rosterCheck_observe(roster: 'delta' | 'full' | undefined, arrived: number[]): void {
    if (roster === 'full') {
      if (this.rosterCheck === 'checking') return;
      if (this.rosterCheckTimer !== null) { clearTimeout(this.rosterCheckTimer); this.rosterCheckTimer = null; }
      this.rosterCheck = 'checking';
      this.listing.state_refresh();
      return;
    }
    if (this.rosterCheck !== 'checking') return;
    const fresh: number = arrived.filter((id: number): boolean => !this.lastRoster.some((feed: FeedListEntry): boolean => feed.id === id)).length;
    this.rosterCheck = { landed: fresh > 0 ? `FEED LIST CURRENT · ${fresh} NEW` : 'FEED LIST CURRENT · NOTHING NEW' };
    this.listing.state_refresh();
    this.rosterCheckTimer = setTimeout((): void => {
      this.rosterCheck = null;
      this.rosterCheckTimer = null;
      this.listing.state_refresh();
    }, ROSTER_CHECK_DWELL_MS);
  }

  /** The bar's count of what is NEW since the last visit, or empty. */
  private newCount_line(): string {
    const count: number = this.lastRoster.filter((feed: FeedListEntry): boolean => feed.new === true).length;
    return count === 0 ? '' : `${count} NEW SINCE YOUR LAST VISIT`;
  }

  /**
   * Takes NEW marks off, in the session (kept with the roster) and on the
   * rows at once.
   *
   * @param feedIds - The feeds seen, or `all`.
   */
  private unseen_clear(feedIds: number[] | 'all'): void {
    this.handlers.command_run(feedIds === 'all' ? 'proc seen all' : `proc seen ${feedIds.map((id: number): string => `feed_${id}`).join(' ')}`);
    const cleared: FeedListEntry[] = this.lastRoster.map((feed: FeedListEntry): FeedListEntry => {
      if (feed.new !== true || (feedIds !== 'all' && !feedIds.includes(feed.id))) return feed;
      const { new: _new, ...rest } = feed;
      return rest;
    });
    if (this.rosterShown) this.chooser_show(cleared);
    else this.lastRoster = cleared;
    this.listing.state_refresh();
  }

  /** The bar's word on the roster walk, or empty. */
  private rosterCheck_line(): string {
    if (this.rosterCheck === null) return '';
    return this.rosterCheck === 'checking' ? 'CHECKING CUBE FOR THE FEED LIST…' : this.rosterCheck.landed;
  }

  /**
   * The field's word when the filter keeps every row off stage. A filter
   * that is a feed's id or `feed_N` name, for a feed the roster lacks, is
   * asked of the session (`proc feeds N`): a feed shared to this identity
   * since the roster was walked arrives through that ask, and one CUBE
   * does not list is answered with why — so a colleague's share is seen,
   * or its absence explained, on the look that went for it.
   *
   * @param text - The filter's text.
   * @returns The note the field shows.
   */
  private filterMiss_note(text: string): HTMLElement {
    if (text !== this.filterMissText) {
      this.filterMissText = text;
      this.feedAsks.clear();
    }
    const note: HTMLDivElement = document.createElement('div');
    note.className = 'feedlist-refusal feedlist-miss';
    const feedID: number | null = filterFeedID_parse(text);
    if (feedID === null) {
      note.textContent = `no feed matches "${text}"`;
    } else if (!this.feedAsks.has(feedID)) {
      this.feedAsks.set(feedID, null);
      note.textContent = `feed_${feedID} is not in the roster; asking CUBE…`;
      this.handlers.command_run(`proc feeds ${feedID}`);
    } else {
      note.textContent = this.feedAsks.get(feedID) ?? `feed_${feedID} is not in the roster; asking CUBE…`;
    }
    this.filterMissNote = note;
    return note;
  }

  /**
   * Takes the answer to a filter's ask, if the envelope is one: a listing
   * of exactly the asked feed joins the roster (the filter then shows it,
   * marked as an arrival); a refusal naming the feed is written into the
   * miss note where the ask was made.
   *
   * @param envelope - An envelope the pane observes.
   * @returns Whether the envelope was an ask's answer.
   */
  private feedAsk_take(envelope: WireEnvelope): boolean {
    if (this.feedAsks.size === 0) return false;
    if (envelope.model?.kind === FEED_LIST_MODEL_KIND) {
      const roster = feedListModelSchema.safeParse(envelope.model.data);
      const only: FeedListEntry | undefined = roster.success && roster.data.feeds.length === 1 ? roster.data.feeds[0] : undefined;
      if (only === undefined || this.feedAsks.get(only.id) !== null) return false;
      this.feedAsks.set(only.id, 'listed');
      this.arrivals.add(only.id);
      this.chooser_show([...this.lastRoster.filter((feed: FeedListEntry): boolean => feed.id !== only.id), only]);
      return true;
    }
    if (envelope.status !== 'error' || envelope.model !== undefined) return false;
    const reason: string = refusalReason_strip(envelope.renderedErr || envelope.rendered || '');
    const named: number | null = filterFeedID_parse(/feed_(\d+)/.exec(reason)?.[0] ?? '');
    if (named === null || this.feedAsks.get(named) !== null) return false;
    this.feedAsks.set(named, reason);
    if (this.filterMissNote !== null && this.filterMissNote.isConnected) this.filterMissNote.textContent = reason;
    return true;
  }

  /**
   * Whether the roster is the thing on stage.
   *
   * Held as state rather than read back off `style.display`: the roster is
   * laid out as a flex column, and three separate checks asked it whether
   * it was `block`. All three were false forever — the roster never re-asked
   * (a finished run read RUNNING until the pane was rebuilt), a cwd inside a
   * feed painted its graph over the roster, and an arriving feed that was
   * not listed never prompted a look. One field, one answer.
   */
  private rosterShown: boolean = false;

  /** When the roster last asked the session, so the beat can follow the work. */
  private rosterAskedAt: number = 0;

  /** The live progress line of a refused roster, fed by the prompt. */
  private rosterProgress: HTMLElement | null = null;

  /**
   * Paints the roster refusal in place of the loading row: the daemon's
   * own reason, with a live warming figure beneath it.
   *
   * @param envelope - The error envelope that answered `proc feeds`.
   */
  private rosterRefusal_show(envelope: WireEnvelope): void {
    // The daemon's reason froze the count as it stood; the figure beneath
    // moves with the prompt, so the reason keeps only its words.
    const stripped: string = refusalReason_strip(envelope.renderedErr || envelope.rendered || '');
    const reason: string = stripped.length > 0 ? stripped : 'the roster request was refused';
    const refusal: HTMLDivElement = document.createElement('div');
    refusal.className = 'feedlist-refusal';
    refusal.textContent = reason;
    const progress: HTMLDivElement = document.createElement('div');
    progress.className = 'feedlist-warming';
    progress.textContent = 'INDEX WARMING\u2026 the roster opens when the index is whole.';
    this.feedList.replaceChildren(refusal, progress);
    this.roster_show(true);
    this.rosterProgress = progress;
  }

  /**
   * Declares the list level: RUNS-02 always lands on the feed roster and
   * nothing else. A graph retained from an earlier visit would be a ghost
   * render above the list, so the canvas hides and any pin releases; the
   * shown-feed memory survives so the cwd follow does not immediately
   * repaint what was just dismissed.
   */
  public list_reset(): void {
    this.pendingFeedId = null;
    barState_clear(this.stateSpan, 'wait');
    this.watch_release();
    this.facts.replaceChildren();
    this.scene.selection_clear();
    this.canvas.style.display = 'none';
    this.pinnedFeedId = null;
    this.requestedFeedId = null;
    this.title.textContent = this.defaultTitle;
    // The empty-state hint ("no feed in view — press RUNS-02...") is for a
    // pane that arrived with nothing to say; RUNS-02 itself is the answer to
    // that hint, so flashing it here before the roster lands is nonsense.
    this.empty.style.display = 'none';
  }

  /**
   * Pops one navigation level: a shown graph (entered or previewed) steps
   * back to the feed list. Scrubbing the list is one level however many
   * previews it painted — the pop clears whatever graph is up and restores
   * the pure list.
   *
   * @returns True when a level was popped; false when the pane is already
   * at its list (or never had one), letting Esc fall through.
   */
  public nav_pop(): boolean {
    if (this.pendingFeedId !== null && this.feedList.childElementCount > 0) {
      // Backing out of a selection still in flight: the roster returns;
      // the late graph, if it comes, is ignored by the pin having cleared.
      this.pendingFeedId = null;
      this.pinnedFeedId = null;
      this.requestedFeedId = null;
      this.listing.activation_settle();
      this.empty.style.display = 'none';
      this.roster_show(true);
      this.title.textContent = this.defaultTitle;
      barState_clear(this.stateSpan, 'wait');
      this.listing.state_refresh();
      return true;
    }
    if (this.canvas.style.display === 'none') {
      return false;
    }
    if (this.feedList.childElementCount === 0) {
      // No roster was ever shown: this pane arrived by cwd-follow, and
      // there is no list level beneath it to return to.
      return false;
    }
    this.graph_leave();
    this.roster_show(true);
    this.listing.state_refresh();
    return true;
  }

  /** Leaves the graph whole (watch, canvas, pin, title, facts): RUNS over a graph once left all of it standing. */
  private graph_leave(): void {
    this.watch_release();
    this.canvas.style.display = 'none';
    this.pinnedFeedId = null;
    this.requestedFeedId = null;
    this.title.textContent = this.defaultTitle;
    this.facts.replaceChildren();
    this.scene.selection_clear();
  }

  /**
   * Shows the titled feed chooser over the pane; picking one loads its DAG.
   *
   * @param feeds - The roster, newest first.
   */
  /**
   * Roster arrivals (feeds created or shared since the last look): their
   * rows pulse while the daemon annunciates them, and a roster on stage
   * that does not yet list one asks for the list again, once per arrival set.
   *
   * @param arrived - The feed ids the prompt context annunciates.
   */
  private arrivals_observe(arrived: number[]): void {
    const key: string = arrived.join(',');
    if (key === this.arrivalsKey) return;
    this.arrivalsKey = key;
    this.arrivals = new Set(arrived);
    for (const feed of this.lastRoster) {
      this.listing.row_element(String(feed.id))?.classList.toggle('feedlist-arrived', this.arrivals.has(feed.id));
    }
    const listed: Set<number> = new Set(this.lastRoster.map((feed: FeedListEntry): number => feed.id));
    const unlisted: boolean = arrived.some((id: number): boolean => !listed.has(id));
    if (unlisted && this.rosterShown) this.feedsChooser_request();
  }

  private chooser_show(feeds: FeedListEntry[]): void {
    this.lastRoster = feeds;
    this.empty.style.display = 'none';
    // The roster is shown before the rows are set: the listing writes the
    // bar only while the roster, not a graph, is on stage.
    this.roster_show(true);
    // What is NEW since the last visit leads, in a block of its own, before
    // the roster in date order: a share from August is news today.
    const fresh: FeedListEntry[] = feeds.filter((feed: FeedListEntry): boolean => feed.new === true);
    if (this.clearNewPill !== null) this.clearNewPill.hidden = fresh.length === 0;
    if (fresh.length === 0) {
      // One block, one field: the roster is a constant place, so a selection
      // (should the roster ever gain one) would survive every re-listing.
      this.listing.rows_set([{ key: 'roster', rows: feeds }], { field: 'roster' });
    } else {
      const header: HTMLDivElement = document.createElement('div');
      header.className = 'feedlist-newhead';
      header.textContent = `NEW SINCE YOUR LAST VISIT · ${fresh.length}`;
      const rest: FeedListEntry[] = feeds.filter((feed: FeedListEntry): boolean => feed.new !== true);
      this.listing.rows_set([{ key: 'new', rows: fresh, header }, { key: 'roster', rows: rest }], { field: 'roster' });
    }
    this.rosterFrame_track();
  }

  /**
   * Enters a feed: the full graph takes the pane and the list steps aside.
   * Esc (contextual back) returns here.
   *
   * @param entry - The feed to enter.
   */
  private feed_activate(entry: FeedListEntry): void {
    this.follow.pick(this.requestedFeedId, entry.id);
    this.pinnedFeedId = entry.id;
    this.requestedFeedId = null;
    this.handlers.feed_regard?.(`/proc/jobs/feed_${entry.id}`);
    this.feedRequest_show(entry.id);
    this.handlers.command_run(`feed diagram feed_${entry.id}`);
  }

  /**
   * Indicates one roster row: its verbs appear in its own action cell and
   * the previously indicated row's cell empties.
   *
   * @param entry - The feed to indicate, or null to indicate none.
   */
  public row_indicate(entry: FeedListEntry | null): void {
    this.listing.row_indicate(entry === null ? null : String(entry.id));
  }

  /**
   * Shows a readout beside an indicated row's verbs.
   *
   * Dropped when the operator has moved on: a readout about a row nobody is
   * looking at answers a question already withdrawn.
   *
   * @param feedId - The feed the readout belongs to.
   * @param text - What to say beside the verbs.
   */
  /** The indicated feed's readout reads again (its holders changed). */
  public indicated_refresh(): void {
    const key: string | null = this.listing.indicated_get();
    const feed: FeedListEntry | undefined = key === null ? undefined : this.lastRoster.find((one: FeedListEntry): boolean => String(one.id) === key);
    if (feed !== undefined) this.handlers.feed_indicated?.(feed);
  }

  /** Asks the session for the roster again now (a tag changed). */
  public roster_ask(): void {
    this.rosterAskedAt = Date.now();
    this.handlers.command_run('proc feeds');
  }

  /**
   * A press on a tag mark: its × takes the tag off, the mark itself filters
   * the roster by it. Neither reaches the row beneath, which would indicate
   * or enter the feed.
   *
   * @param event - The press.
   */
  private tagMark_press(event: MouseEvent): void {
    const target: Element | null = event.target instanceof Element ? event.target : null;
    const mark: HTMLElement | null = target?.closest<HTMLElement>('.feedlist-tag') ?? null;
    if (mark === null) return;
    event.stopPropagation();
    event.preventDefault();
    const tag: string = mark.dataset['tag'] ?? '';
    const feedId: number = Number(mark.closest<HTMLElement>('[data-feed]')?.dataset['feed']);
    if (target?.closest('.feedlist-tag-x') !== null && Number.isFinite(feedId)) {
      this.handlers.feed_untag?.(feedId, tag);
      return;
    }
    this.roster_filter(`tag:${tag}`);
  }

  public rowReadout_show(feedId: number, text: string | Node): void {
    // The feed id is stringified at the boundary: the façade keys by string.
    this.listing.readout_show(String(feedId), text);
  }

  /** Shows or hides the roster filter strip (the mode frame's FILTER, or `runs filter`). */
  public filter_toggle(open?: boolean): void {
    this.listing.filter_toggle(open);
  }

  /**
   * Sets the roster's filter, opening the strip when there is one and
   * closing it when it is emptied: what a readout that acts on the roster
   * (the header's ERRORED figure) asks for. The filter is the listing's
   * own; it holds across the rows arriving.
   *
   * @param text - The filter text (`status:error`), or empty for none.
   */
  public roster_filter(text: string): void {
    this.listing.filter_toggle(text !== '');
    this.listing.filter_set(text);
  }

  /** Keeps the roster frame's rule beneath the caps (and the filter strip). */
  private rosterFrameObserver: ResizeObserver | null = null;

  /**
   * The caps and filter strip are the roster's own frame, sticky at the top
   * of its scroller; the field rule and the mode frame sit beneath them.
   * The offset rides a CSS variable on the host, kept true as the filter
   * strip comes and goes.
   */
  private rosterFrame_track(): void {
    const host: HTMLElement | null = this.feedList.parentElement;
    const roster: HTMLElement | null = this.feedList.querySelector<HTMLElement>('.roster-order');
    this.rosterFrameObserver?.disconnect();
    this.rosterFrameObserver = null;
    if (host === null) return;
    if (roster === null) {
      host.style.removeProperty('--mode-frame-top');
      return;
    }
    const sync = (): void => {
      host.style.setProperty('--mode-frame-top', `${Math.ceil(roster.getBoundingClientRect().bottom - host.getBoundingClientRect().top)}px`);
    };
    sync();
    this.rosterFrameObserver = new ResizeObserver(sync);
    this.rosterFrameObserver.observe(roster);
  }

  /** Shows or hides the roster and its frame host together. */
  private roster_show(on: boolean): void {
    this.rosterShown = on;
    if (this.backPill !== null) this.backPill.hidden = on;
    // The feed's own verbs and marks stand only while a feed is on stage.
    this.feedFrame.shown_set(!on);
    // Flex, not block: the frame sits above a scrolling field. Nothing
    // asks this element what it is showing; `rosterShown` is the answer.
    this.feedList.style.display = on ? 'flex' : 'none';
    this.feedList.parentElement?.classList.toggle('roster-shown', on);
  }

  /** Paints the selection facts chip. */
  private facts_show(node: SceneNode): void {
    // Kept so a live model can repaint the node the operator is looking at:
    // a strip that says `scheduled` while the job has started is a readout
    // that has stopped being true, which is worse than no readout.
    this.factsShown = node;
    const payload: FeedDagNode | undefined = this.factsPayloads.get(node.id);
    if (!payload) {
      this.facts.textContent = node.label;
      return;
    }
    // A selection is an indication: the node's data address becomes the
    // pane's regard, feeding any slaved viewer in its group.
    this.handlers.node_regard?.(payload.vfsPath);
    // The feed view's one overlay (a-feed-has-one-view): the same rows,
    // status line and verbs the universe shows for the same node.
    feedFacts_render(this.facts, payload, {
      ...(this.handlers.node_dive !== undefined || this.handlers.node_enter !== undefined ? { enter: (): void => this.node_activate(node) } : {}),
      ...(this.handlers.node_process !== undefined ? { process: this.handlers.node_process } : {}),
    });
  }

  /** Activation: fly into the node — literally when the host can overlay. */
  private node_activate(node: SceneNode): void {
    const payload: FeedDagNode | undefined = this.factsPayloads.get(node.id);
    if (!payload) {
      return;
    }
    if (this.handlers.node_dive !== undefined) {
      const dive: (vfsPath: string) => void = this.handlers.node_dive;
      this.scene.flight_into(node.id, (): void => dive(payload.vfsPath));
    } else {
      this.handlers.node_enter(payload.vfsPath);
    }
  }

  /** Clears the node detail (selection + facts chip) — the drawer's CLEAR DETAIL. */
  public detail_clear(): void {
    this.scene.selection_clear();
    this.facts.replaceChildren();
  }

  /** Fires one pulse wave: dependency-order replay, honest to history. */
  public wave_start(): void {
    this.scene.wave_start();
  }

  /**
   * Whether the camera is parked inside a node.
   *
   * @returns True while the scene holds the camera inside one.
   */
  public inside_isHeld(): boolean {
    return this.scene.holding_get();
  }

  /**
   * Flies the camera back out of a node once its overlay has closed.
   *
   * @param onDone - Called when the camera is home.
   */
  public flight_back(onDone: () => void): void {
    this.scene.flight_back(onDone);
  }

  /**
   * Flies into the node hosting the given plugin instance — the immersive
   * hop: clicking a descendant instance inside a node is graph navigation,
   * not directory descent. Call after the current overlay's `flight_back`
   * has landed.
   *
   * @param instanceID - The CUBE plugin-instance id to dive into.
   * @returns True when the instance is a node of the shown graph.
   */
  public node_flyTo(instanceID: number): boolean {
    for (const [sceneId, node] of this.factsPayloads) {
      if (node.instanceId !== instanceID) continue;
      if (this.handlers.node_dive === undefined) return false;
      const dive: (vfsPath: string) => void = this.handlers.node_dive;
      this.facts_show({ id: sceneId, label: node.label, parentIds: [], joinParentIds: [] });
      this.scene.flight_into(sceneId, (): void => dive(node.vfsPath));
      return true;
    }
    return false;
  }
}

/**
 * Extracts a feed id from a working directory, wherever a feed's tree is
 * mounted in the VFS.
 *
 * @param cwd - The session's working directory.
 * @returns The feed id, or null when the cwd is outside any feed.
 */
export function cwdFeed_find(cwd: string): number | null {
  for (const pattern of CWD_FEED_PATTERNS) {
    const match: RegExpMatchArray | null = cwd.match(pattern);
    if (match?.[1] !== undefined) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}
