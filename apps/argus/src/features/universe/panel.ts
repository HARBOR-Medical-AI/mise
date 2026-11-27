/**
 * @file The UNIVERSE pane: the space of everything run here.
 *
 * Every feed the index holds, drawn as its own small molecule — a sphere
 * per plugin group, sized by jobs and hued by status — and pulled toward
 * the feeds that share its pipeline shape, so the field reads as what this
 * lab runs, how much of each, and where the red is. Its own pane kind
 * (docs/aegis.adoc: a session's universe is its own pane), so RUNS-02
 * stays a feed viewer and this keeps its camera and its memory.
 *
 * It breathes. While the index warms, each landing the prompt reports adds
 * or reshapes a molecule. Once the index is whole it keeps moving with the
 * lab: a feed arriving through the roster delta drifts in, a status change
 * recolours, a feed gone from the roster leaves. And it remembers: where
 * the molecules settled is kept per identity, so a reopened pane finds them
 * where they were.
 *
 * @module
 */
import { PROC_LAYOUT_MODEL_KIND, PROC_UNIVERSE_MODEL_KIND, UNIVERSE_REACH, procLayoutModelSchema, procUniverseModelSchema, universeKey_derive, universeReach_derive, type ProcUniverseModel, arg_quote } from '@fnndsc/menu';
import { feedGraph_build } from '../../scene/feedGraph.js';
import { FEED_MODES_DEFAULT, FeedViewFrame, feedHueLegend_build, feedShape_same, feedStatuses_patch, type FeedModes, type FeedVerb } from '../feed/view.js';
import { FeedFrame, type FeedFrameFacts } from '../dag/feedFrame.js';
import { feedFacts_render } from '../feed/facts.js';
import { ranked_layout } from '@fnndsc/orrery';
import type { FeedDagModel, FeedDagNode, PromptContext, WireEnvelope, WatchState } from '@fnndsc/menu';
import { barState_clear, barState_set, type BarState } from '../roster/bar.js';
import { ChrisSpace, PHYSICS_DEFAULT, type DrawMode, type PhysicsTerms, type SceneGraph, type SceneNode, type SettleMode, type ScenePlan } from '../../scene/chrisSpace.js';
import {
  LandedFeeds, universeGraph_build, universeTip_render, universeStoreKey_format, storedPositions_parse,
  instanceId_format, descendedGraph_build, sphereIds_list, clusterTip_render, clusterGraph_build, clusterIds_list, shapeWords_format, shapeWords_brief, shape_derive,
  foldedGraph_build, foldTip_render, foldShape_parse, foldIds_list, unfoldedGraph_build,
  type LandedFeed, type UniverseScale, type EnteredFeed,
  universeSettings_build,
  universeSettings_parse,
  accretionGraph_build,
  constellationsGraph_build,
  pluginTip_render,
  pluginOfStar,
  type UniverseSettings,
} from './space.js';
import { dataGraph_build, dataHubKey_parse, dataHubTip_render, dataPath_build, descriptionGroups_build } from './dataSpace.js';

/** How the whole space is arranged: round each shape's hub, or round the plugin stars. */
type Arrangement = UniverseSettings['arrangement'];

/** How long a pill's answer holds the bar before the standing state returns. */
const NOTE_HOLD_MS: number = 4000;

/**
 * Whether the settle's terms are the ones every browser starts with (and the
 * session lays out with): charge, links, collisions and gravity all on.
 *
 * @param physics - The terms.
 * @returns Whether they are.
 */
function physics_isDefault(physics: PhysicsTerms): boolean {
  const standard: PhysicsTerms = { ...PHYSICS_DEFAULT, gravity: true };
  return physics.charge === standard.charge && physics.link === standard.link && physics.collide === standard.collide && physics.gravity === standard.gravity;
}

/**
 * A cheap fingerprint of a set of places: how many, and a weighted sum.
 * Tells a settle that moved nothing from one that moved something.
 *
 * @param positions - The places.
 * @returns The fingerprint.
 */
function placesSignature_compute(positions: Record<string, [number, number, number]>): string {
  let sum: number = 0;
  for (const at of Object.values(positions)) sum += at[0] * 1.3 + at[1] * 1.7 + at[2] * 1.9;
  return `${Object.keys(positions).length}:${sum.toFixed(2)}`;
}

/**
 * Whether an arrangement brings a graph of its own (the FEEDS view only)
 * rather than the shared space round each shape's hub.
 *
 * @param arrangement - The arrangement.
 * @returns Whether it does.
 */
function ownGraph_is(arrangement: Arrangement): boolean {
  return arrangement === 'constellations' || arrangement === 'data' || arrangement === 'accretion';
}
import type { KeyStore } from '../../app/dormant.js';
import { WaitProgress } from '../wait/progress.js';
import { projection_paint, projection_press } from './projection.js';

/** What the pane asks of its host. */
export interface UniversePanelHandlers {
  /** Runs a session command whose envelopes come back through `envelope_observe`. */
  command_run: (line: string) => void;
  /** Holds or releases the session's watch on a subject (a feed entered is watched, as RUNS watches it). */
  watch_set?: (subject: string, on: boolean) => void;
  /** The entered feed's facts, verbs and marks, as the RUNS pane takes them (see FeedFrame). */
  feed_entered?: (feedId: number) => void;
  feed_note?: (feedId: number) => void;
  feed_tag?: (feedId: number, worn: ReadonlyArray<string>) => void;
  feed_rename?: (feedId: number, title: string) => void;
  feed_untag?: (feedId: number, tag: string) => void;
  /** The kernel's graph of one feed (`feed diagram`), or null when it cannot be had. */
  feed_dag?: (feedId: number) => Promise<FeedDagModel | null>;
  /** The operator enters a node's data: the session's cwd moves there. */
  node_enter?: (vfsPath: string) => void;
  /** The fly-in: the camera into the node, its data browsable inside; Esc back out. */
  node_dive?: (vfsPath: string) => void;
  /** PROCESS on a node: a catalogue bound to its data. */
  node_process?: (node: { vfsPath: string; instanceId: number; label: string }) => void;
  /** OPEN: the feed in a RUNS pane of its own. */
  /** Opens a plugin's /bin entry, its one-node graph, in the files browser. */
  plugin_open?: (plugin: string) => void;
  feed_open?: (feedId: number) => void;
  /** A line for the console: what the pane is waiting for, or why it refused. */
  note?: (line: string) => void;
}

/** One feed entered: what was asked for, and what came. */
interface EnteredState {
  feedId: number;
  title: string;
  entered: EnteredFeed;
  ids: Set<string>;
}

/** The pane's mount points inside its template. */
export interface UniversePanelMount {
  canvas: HTMLElement;
  /** The mode frame, holding the entered feed's pills (`data-feed-verb`, `.dag-note` …). */
  frame?: HTMLElement | null;
  title: HTMLElement;
  state: HTMLElement | null;
  empty: HTMLElement;
  projectionPill: HTMLElement | null;
  refreshPill: HTMLElement | null;
  /** REPLAY: the space's history played back in the order its feeds were made. */
  replayPill?: HTMLElement | null;
  scalePill: HTMLElement | null;
  /** VIEW: every feed its own molecule, or the shapes folded. */
  viewPill: HTMLElement | null;
  /** GRAVITY: the mass-weighted centring that gathers the clusters; a knob for play. */
  gravityPill: HTMLElement | null;
  /** DENSITY: a sphere per stage (SHAPE), or a point per job (CENSUS). */
  densityPill: HTMLElement | null;
  /** DRAW: every node a point of light (STARS), or a lit sphere (SPHERES). */
  drawPill?: HTMLElement | null;
  /** CAPTIONS: the hubs' words over the picture, on or off. */
  captionsPill?: HTMLElement | null;
  /** LAYOUT: the space's own emergent shape (GALAXY), molecules as spokes round their hub (SPOKES), or packed (CLUMPS). */
  arrangementPill?: HTMLElement | null;
  /** The facts overlay on the field: the selected node's payload and verbs. */
  facts: HTMLElement | null;
  /** BACK, on the frame while a feed is entered. */
  backPill: HTMLElement | null;
  /** OPEN FEED, on the frame while a feed is entered. */
  openPill: HTMLElement | null;
}

/** How long the pane waits for the session to lay a layout out before settling it here. */
const SESSION_WAIT_MS: number = 180_000;
/** How often the pane asks the session how far it has come. */
const SESSION_WAIT_ASK_MS: number = 1500;

/** The least time between two repaints from landings. */
const REPAINT_MS: number = 1000;

/** The least time between two whole re-asks while the lab moves. */
const REASK_MS: number = 5000;

/** The least time between two writes of remembered positions. */
const REMEMBER_MS: number = 3000;

/** How long the camera takes to reach a molecule, and to frame its feed. */
const DESCENT_MS: number = 650;

/** How long the climb back out takes. */
const ASCENT_MS: number = 650;

/**
 * How far past its framing a pinch must draw the camera back to climb out
 * of a feed or a cluster: half as far again as the descent left it. Less,
 * and a pinch to see a sprawling feed whole would leave it.
 */
const PINCH_LEAVE_FACTOR: number = 1.5;

export class UniversePanel {
  private readonly scene: ChrisSpace;
  /** The wait over the field: the session asked, or a settle in slices. */
  private readonly wait: WaitProgress;
  /** Whether `proc universe` has been asked and not yet answered. */
  private asking: boolean = false;
  /** The space last taken, as a key: a repeat answer is not a new space. */
  private spaceKey: string = '';
  private readonly landed: LandedFeeds = new LandedFeeds();
  private readonly canvas: HTMLElement;
  private readonly title: HTMLElement;
  private readonly state: HTMLElement | null;
  /** The timer of a pill's answer holding the bar, while one does. */
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly empty: HTMLElement;
  private readonly handlers: UniversePanelHandlers;
  private readonly store: KeyStore | undefined;
  /** Whether the index was whole when the space last arrived. */
  private whole: boolean = false;
  /** Whether a space has arrived at all. */
  private shown: boolean = false;
  private warming: string = '';
  private repaintTimer: number | null = null;
  private lastReask: number = 0;
  private rememberTimer: number | null = null;
  /** What was last put to the session, per layout: a settle that moved nothing puts nothing. */
  private putSignatures: Map<string, string> = new Map();
  /** How many places the session keeps, per layout, as last heard or put; absent when unknown. */
  private sessionPlaces: Map<string, number | null> = new Map();
  /** The layout the pane waits for the session to lay out, and until when; null when it waits for none. */
  private sessionWait: { name: string; until: number; timer: number | null } | null = null;
  private storeKey: string | null = null;
  private arrivalsKey: string = '';
  private feedsCount: number | null = null;
  private disposed: boolean = false;
  /** What sizes a sphere: its jobs (log) or nothing. */
  private scale: UniverseScale = 'jobs';
  /**
   * What the top of the universe shows: every feed as its own molecule
   * (the whole compute structure, the default), or the shapes folded, one
   * molecule per pipeline for when a thousand runs of one are in the way.
   */
  private view: 'feeds' | 'shapes' = 'feeds';
  /** The feed entered, while one is. */
  private inside: EnteredState | null = null;
  /** The cluster in view, while one is: a shape and its spheres. */
  private cluster: { shape: string; ids: string[] } | null = null;
  /** A descent or an ascent in flight: clicks wait. */
  /**
   * How far the camera stood when the descent (into a feed or a cluster)
   * landed: a pinch that draws it back well past this climbs out.
   */
  private framedAt: number | null = null;
  /** The feed whose graph is being asked for, while it is. */
  private entering: number | null = null;
  private readonly facts: HTMLElement | null;
  private viewPill: HTMLElement | null = null;
  private gravityPill: HTMLElement | null = null;
  private densityPill: HTMLElement | null = null;
  /** SHAPE draws a stage as one sphere with its count; CENSUS every job of it as a point. */
  private density: 'shape' | 'census' = 'shape';
  /** How the space is drawn: stars by default, lit spheres by choice. */
  private drawMode: DrawMode = 'stars';
  private drawPill: HTMLElement | null = null;
  private captionsPill: HTMLElement | null = null;
  /** Whether the space's captions are drawn. */
  private captions: boolean = true;
  /** How molecules sit round their anchor. */
  private arrangement: Arrangement = 'galaxy';
  private arrangementPill: HTMLElement | null = null;
  private scalePill: HTMLElement | null = null;
  /** The settle's terms as the operator has them; gravity on by default here. */
  private physics: PhysicsTerms = { ...PHYSICS_DEFAULT, gravity: true };
  private readonly backPill: HTMLElement | null;
  private readonly openPill: HTMLElement | null;
  private readonly pane: HTMLElement | null;
  /** The entered feed's note, tags and name on the frame. */
  private feedFrame: FeedFrame | null = null;
  /** The feed view's modes and pills while a feed is entered (features/feed/view.ts). */
  private feedView: FeedViewFrame | null = null;
  /** The kernel's graph of the entered feed, kept to redraw it when a mode turns. */
  private insideModel: FeedDagModel | null = null;
  /** The entered feed as last read for the scene. */
  private insideEntered: EnteredFeed | null = null;
  /** The feed-view modes the entered feed was last drawn in, to tell when the memory moved under it. */
  private insideModes: FeedModes | null = null;
  /** The feed this pane holds a watch on, and what the watch last said of it. */
  private watchedFeedId: number | null = null;
  private liveState: WatchState | null = null;
  private readonly escape_listen: (event: KeyboardEvent) => void;
  /** The plugin whose stages are lit across the sky, or null. */
  private lit: string | null = null;
  /** DATA's hubs as last drawn: labels and feed counts, for the tips. */
  private dataHubs: Map<string, { label: string; feeds: number }> = new Map();
  /** The DATA hub whose feeds are lit, by its path key, or null. */
  private litHub: string | null = null;
  /** The REPLAY block, painted with the replay's state. */
  private replayPill: HTMLElement | null = null;
  /** The day the readout last showed, so it repaints once a day of history, not once a frame. */
  private replayDay: string = '';
  /** The reach the scene was last given; undefined until the first paint. */
  private reach: number | undefined | null = null;

  constructor(mount: UniversePanelMount, handlers: UniversePanelHandlers, store?: KeyStore) {
    this.canvas = mount.canvas;
    this.title = mount.title;
    this.state = mount.state;
    this.empty = mount.empty;
    this.handlers = handlers;
    this.store = store;
    this.facts = mount.facts;
    this.backPill = mount.backPill;
    this.openPill = mount.openPill;
    this.pane = mount.canvas.closest<HTMLElement>('.workspace-pane');
    this.wait = new WaitProgress(mount.canvas);
    this.scene = new ChrisSpace(mount.canvas, {
      // A space of thousands settles in slices, and says how far it has
      // come: the page never sits frozen behind a settle.
      progress: (done: number, total: number, nodes: number): void => this.settle_progress(done, total, nodes),
      // A feed turns solid as a whole when it is near enough to read; a
      // folded shape's molecule does the same.
      // The molecule a node belongs to, named as the session names it when it lays the space out.
      handoffKey: (node: SceneNode): string | null => universeKey_derive(node.id),
      // A sphere is a plugin group inside a feed; the tip says both. Inside
      // a feed the nodes are its own and carry their labels.
      tip: (node: SceneNode): string | null => (this.inside === null ? (dataHubTip_render(node.id, this.dataHubs) ?? pluginTip_render(node.id, this.landed) ?? foldTip_render(node.id, this.landed) ?? universeTip_render(node.id, this.landed) ?? clusterTip_render(node.id, this.landed)) : null),
      // Outside: a click on a sphere descends into its feed. Inside: a
      // click on one of the feed's nodes shows its facts and its verbs.
      select: (node: SceneNode): void => this.node_select(node),
      // A double click inside a feed flies into the node, as in the DAG pane.
      activate: (node: SceneNode): void => {
        // A double click on a plugin star frames the stages it ran.
        const plugin: string | null = this.inside === null ? pluginOfStar(node.id) : null;
        if (plugin !== null) this.plugin_frame(plugin);
        else this.node_dive(node);
      },
      deselect: (): void => {
        this.facts_clear();
        if (this.lit !== null) this.plugin_light(null);
      },
      replay: (): void => this.replay_paint(),
      // A phone has no Esc: pinching out past where the descent framed a
      // feed climbs out, as a double tap went in.
      gesture_end: (): void => this.pinch_leave(),
    });
    // A taxonomy is a molecule, not a rank order: gravity pulls the
    // clusters into a crown, and a bounded reach lets a lone molecule hug
    // itself rather than spread across the field as dots.
    this.scene.strategy_set('molecule');
    this.scene.physics_set(this.physics);
    this.frame_wire(mount);
    // The entered feed's frame is the feed view's (law a-feed-has-one-view):
    // its note, tags and name, and its modes, wired as the RUNS pane wires them.
    this.feedFrame = new FeedFrame(mount.frame ?? null, {
      ...(handlers.feed_entered !== undefined ? { feed_entered: handlers.feed_entered } : {}),
      ...(handlers.feed_note !== undefined ? { feed_note: handlers.feed_note } : {}),
      ...(handlers.feed_tag !== undefined ? { feed_tag: handlers.feed_tag } : {}),
      ...(handlers.feed_rename !== undefined ? { feed_rename: handlers.feed_rename } : {}),
      ...(handlers.feed_untag !== undefined ? { feed_untag: handlers.feed_untag } : {}),
      shown: (): number | null => this.inside?.feedId ?? null,
      name: (): string => this.inside?.title ?? '',
      renamed: (feedId: number, title: string): void => {
        if (this.inside?.feedId !== feedId) return;
        this.inside = { ...this.inside, title };
        this.title_paint();
      },
    });
    this.feedView = new FeedViewFrame(mount.frame ?? null, {
      changed: (verb: FeedVerb, modes: FeedModes): void => this.feedMode_apply(verb, modes),
    });
    this.escape_listen = this.escape_wire();
    this.scene.draw_set(this.drawMode);
    this.canvas.style.display = 'none';
    this.title_paint();
  }

  /**
   * Wires the frame's pills: BACK and OPEN, projection, refresh, replay,
   * scale, view, gravity, density, draw, captions and arrangement.
   *
   * @param mount - The pane's mount points.
   */
  private frame_wire(mount: UniversePanelMount): void {
    mount.backPill?.addEventListener('click', (): void => this.ascend());
    mount.openPill?.addEventListener('click', (): void => {
      if (this.inside !== null) this.handlers.feed_open?.(this.inside.feedId);
    });
    mount.projectionPill?.addEventListener('click', (): void => projection_press(this.pane, this.scene, this.inside?.ids ?? null, (line: string): void => this.bar_note(line)));
    mount.refreshPill?.addEventListener('click', (): void => this.request());
    this.replayPill = mount.replayPill ?? null;
    mount.replayPill?.addEventListener('click', (): void => {
      const state = this.scene.replay_state();
      if (state === null) this.bar_note(this.replay_start(1));
      else if (state.playing) this.scene.replay_pause();
      else this.scene.replay_play();
      this.replay_paint();
    });
    mount.scalePill?.addEventListener('click', (): void => {
      this.scale = this.scale === 'jobs' ? 'feeds' : 'jobs';
      if (mount.scalePill !== null) mount.scalePill.textContent = this.scale === 'jobs' ? 'JOBS' : 'ALIKE';
      // The spheres change size: every one of them settles again.
      if (this.shown) this.paint(true, 'full');
      this.settings_save();
    });
    mount.viewPill?.addEventListener('click', (): void => this.view_set(this.view === 'feeds' ? 'shapes' : 'feeds'));
    this.viewPill = mount.viewPill;
    this.gravityPill = mount.gravityPill;
    mount.gravityPill?.addEventListener('click', (): void => { this.physics_set('gravity', !this.physics.gravity); });
    this.densityPill = mount.densityPill;
    mount.densityPill?.addEventListener('click', (): void => { this.density_set(this.density === 'shape' ? 'census' : 'shape'); });
    this.drawPill = mount.drawPill ?? null;
    this.scalePill = mount.scalePill;
    // Inside a feed the draw pill is the feed view's (remembered per device);
    // outside, the space's (remembered per identity, with the other space choices).
    mount.drawPill?.addEventListener('click', (): void => {
      if (this.inside !== null) { this.feedView?.press('draw'); return; }
      this.draw_set(this.drawMode === 'stars' ? 'spheres' : 'stars');
    });
    this.captionsPill = mount.captionsPill ?? null;
    mount.captionsPill?.addEventListener('click', (): void => { this.bar_note(this.captions_set(!this.captions)); });
    this.arrangementPill = mount.arrangementPill ?? null;
    mount.arrangementPill?.addEventListener('click', (): void => {
      const cycle: Arrangement[] = ['galaxy', 'spokes', 'clumps', 'constellations', 'data', 'accretion'];
      this.bar_note(this.arrangement_set(cycle[(cycle.indexOf(this.arrangement) + 1) % cycle.length] as Arrangement));
    });
  }

  /**
   * Esc climbs out, one press, one level: a replay first, then a feed or a cluster.
   *
   * @returns The listener, for dispose to remove.
   */
  private escape_wire(): (event: KeyboardEvent) => void {
    const listen = (event: KeyboardEvent): void => {
      // A replay is a level of its own: Esc ends it, the space shown whole.
      if (event.key === 'Escape' && this.scene.replay_state() !== null && (this.pane === null || this.pane.offsetParent !== null)) {
        this.replay_end();
        return;
      }
      // Inside a node (the overlay up) Esc is the overlay's: it flies back out.
      if (event.key !== 'Escape' || (this.inside === null && this.cluster === null) || this.scene.moving() || this.scene.holding_get()) return;
      if (this.pane !== null && this.pane.offsetParent === null) return;
      this.ascend();
    };
    window.addEventListener('keydown', listen);
    return listen;
  }

  /**
   * Asks for the space: every feed the index holds, as it landed.
   * Cache-resident, answered at once whole or not.
   */
  public request(): void {
    this.asking = true;
    // The first ask is the whole wait: nothing is on the field yet, so the
    // field says what it is waiting on. A re-ask under a drawn space is
    // the lab moving and says nothing.
    if (!this.shown) this.wait.show('ASKING THE SESSION FOR THE SPACE', null);
    this.title_paint();
    // Where the session keeps this layout, asked first: a browser that has
    // never drawn this space draws it at once from the session's copy.
    if (!this.shown) this.handlers.command_run(`proc layout ${this.sessionLayoutName_derive(this.arrangement)}`);
    this.handlers.command_run('proc universe');
  }

  /**
   * A settle's progress, from the scene: the bar while it runs, gone at
   * its end — and the positions remembered only once they stand.
   */
  private settle_progress(done: number, total: number, nodes: number): void {
    if (done >= total) {
      this.wait.hide();
      this.remember_later();
      return;
    }
    this.wait.show(`SETTLING ${nodes.toLocaleString('en-US')} SPHERES`, total === 0 ? 1 : done / total);
  }

  /**
   * Takes the space when it arrives.
   *
   * @param envelope - Any envelope answering this pane.
   */
  public envelope_observe(envelope: WireEnvelope): void {
    if (envelope.model?.kind === PROC_LAYOUT_MODEL_KIND) {
      const layout = procLayoutModelSchema.safeParse(envelope.model.data);
      if (layout.success) this.sessionLayout_take(layout.data.name, layout.data.positions, layout.data.laying ?? null);
      return;
    }
    if (envelope.model?.kind !== PROC_UNIVERSE_MODEL_KIND) return;
    const universe = procUniverseModelSchema.safeParse(envelope.model.data);
    if (universe.success) this.space_show(universe.data);
  }

  /**
   * Follows the session: landings while the index warms and after, the
   * warming figure for the title, and the identity the memory is kept
   * under. Once the index is whole, a feed arriving or the feed count
   * moving re-asks for the space so a new molecule drifts in and a gone
   * one leaves.
   *
   * @param context - The pushed prompt context.
   */
  public promptContext_observe(context: PromptContext): void {
    if (this.disposed) return;
    this.identity_note(context.user, context.uri);
    const landings: LandedFeed[] = context.procWarmup?.landed ?? [];
    if (landings.length > 0 && this.shown) this.landings_take(landings);
    const warm = context.procWarmup;
    if (warm?.total !== undefined && warm.total > 0 && warm.sweeping !== false && !this.whole) {
      const percent: number = Math.floor((warm.loaded / warm.total) * 100);
      const warming: string = `INDEX WARMING ${warm.loaded.toLocaleString()}/${warm.total.toLocaleString()} (${percent}%)`;
      if (warming !== this.warming) {
        this.warming = warming;
        this.title_paint();
      }
    } else if (this.shown && !this.whole && (warm === undefined || warm.sweeping === false || warm.state === 'cached')) {
      // The sweep ended under an open pane: ask once for the whole space.
      this.warming = '';
      this.request();
    }
    if (this.shown && this.whole) {
      const arrivalsKey: string = (warm?.arrived ?? []).join(',');
      const feeds: number | null = context.procIndex?.feeds ?? null;
      const moved: boolean =
        (arrivalsKey.length > 0 && arrivalsKey !== this.arrivalsKey) ||
        (feeds !== null && this.feedsCount !== null && feeds !== this.feedsCount);
      this.arrivalsKey = arrivalsKey;
      if (feeds !== null) this.feedsCount = feeds;
      if (moved && Date.now() - this.lastReask > REASK_MS) {
        this.lastReask = Date.now();
        this.request();
      }
    }
  }

  /** Fits the scene to its mount. */
  public size_fit(): void {
    this.scene.size_fit();
  }

  /**
   * The console's verbs on this pane: `universe enter <feed>`, `universe
   * back`, `universe open`. A surface can be asked what it can be pressed.
   *
   * @param verb - The verb.
   * @param args - Its words.
   * @returns What happened, for the console.
   */
  /** The verbs the console addresses the universe with, by name. */
  private verbs_get(): Readonly<Record<string, (args: string[]) => string>> {
    return {
      enter: (args: string[]): string => this.verb_enter(args),
      node: (args: string[]): string => this.verb_node(args),
      state: (): string => this.verb_state(),
      plugin: (args: string[]): string => this.verb_plugin(args),
      replay: (args: string[]): string => this.verb_replay(args),
      layout: (args: string[]): string => this.verb_layout(args),
      draw: (args: string[]): string => this.verb_draw(args),
      regrow: (): string => this.verb_regrow(),
      captions: (args: string[]): string => this.verb_captions(args),
      density: (args: string[]): string => this.verb_density(args),
      physics: (args: string[]): string => this.verb_physics(args),
      view: (args: string[]): string => this.verb_view(args),
      cluster: (args: string[]): string => this.verb_cluster(args),
      back: (): string => this.verb_back(),
      open: (): string => this.verb_open(),
    };
  }

  /**
   * Runs a typed `universe` verb: each is its own method, found by name;
   * a verb that moves the camera waits while a flight is under way.
   *
   * @param verb - The verb.
   * @param args - Its words.
   * @returns What happened, in words.
   */
  public control(verb: string, args: string[]): string {
    if (this.scene.moving() && (verb === 'cluster' || verb === 'back')) return 'universe: still moving; ask again';
    const run: ((args: string[]) => string) | undefined = this.verbs_get()[verb];
    if (run === undefined) return 'universe enter <feed>|node <instance>|cluster <feed>|view feeds|shapes|density shape|census|draw stars|spheres|captions on|off|layout galaxy|spokes|clumps|constellations|data|accretion|regrow|plugin <name>|off|replay [speed]|pause|stop|at <date>|state|physics <term> on|off|reset|back|open';
    return run(args);
  }

  /** `universe enter`. */
  private verb_enter(args: string[]): string {
      const feedId: number = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(feedId)) return 'universe enter <feed id>';
      if (this.landed.get(feedId) === undefined) return `universe enter: feed ${feedId} has not landed here`;
      if (this.inside !== null) return `universe enter: already inside feed ${this.inside.feedId}; universe back first`;
      this.descend(feedId);
      return `entering feed ${feedId}`;
  }

  /** `universe node`. */
  private verb_node(args: string[]): string {
      const instanceID: number = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(instanceID)) return 'universe node <instance id>: fly into the entered feed\'s node that hosts it';
      if (this.inside === null) return 'universe node: not inside a feed (universe enter <feed> first)';
      return this.node_flyTo(instanceID) ? `flying into instance ${instanceID}` : `universe node: no node of feed ${this.inside.feedId} hosts instance ${instanceID}`;
  }

  /** `universe state`. */
  private verb_state(): string {
      // A surface can be asked what it holds: the draw, the kept choices,
      // and whether the entered feed's nodes are solid or stars.
      const scene: Record<string, unknown> = this.scene.state_get();
      const kept: string | null = (() => {
        const key: string | null = this.settingsKey_get();
        try { return key === null || this.store === undefined ? null : this.store.getItem(key); } catch { return null; }
      })();
      return [
        `universe: ${this.inside !== null ? `inside feed ${this.inside.feedId}` : this.cluster !== null ? 'in a cluster' : 'the whole space'}; view ${this.view}, scale ${this.scale}, density ${this.density}`,
        `scene: ${Object.entries(scene).map(([k, v]): string => `${k}=${String(v)}`).join(' ')}`,
        `kept settings: ${kept ?? '(none)'}`,
        `lit: ${this.lit ?? 'none'}`,
        `captions: ${this.captions ? 'on' : 'off'}`,
        `session layout: ${(() => { const kept = this.sessionPlaces.get(this.sessionLayoutName_derive(this.arrangement)); return kept === undefined ? 'not asked' : kept === null ? 'none kept' : `${kept} places kept`; })()}`,
        `replay: ${(() => { const r = this.scene.replay_state(); return r === null ? 'none' : `${r.playing ? 'playing' : 'paused'} at ${new Date(r.at).toISOString().slice(0, 10)} of ${new Date(r.span[0]).toISOString().slice(0, 10)}..${new Date(r.span[1]).toISOString().slice(0, 10)}`; })()}`,
      ].join('\n');
  }

  /** `universe plugin`. */
  private verb_plugin(args: string[]): string {
      const name: string = args[0] ?? '';
      if (name === '' ) return 'universe plugin <name> | off';
      if (this.arrangement !== 'constellations' || this.inside !== null || this.cluster !== null) return 'universe plugin: the CONSTELLATIONS layout only (universe layout constellations)';
      if (name.toLowerCase() === 'off') { this.plugin_light(null); return 'no plugin lit'; }
      if (!this.landed.all().some((feed: LandedFeed): boolean => feed.groups.some((group): boolean => group.plugin === name))) return `universe plugin: no feed here ran ${name}`;
      this.plugin_light(name);
      return pluginTip_render(`plugin:${name}`, this.landed) ?? name;
  }

  /** `universe replay`. */
  private verb_replay(args: string[]): string {
      const word: string = (args[0] ?? '').toLowerCase();
      if (word === 'stop') {
        if (this.scene.replay_state() === null) return 'universe replay: none is running';
        this.replay_end();
        return 'replay stopped; the space is whole';
      }
      if (word === 'pause') {
        if (this.scene.replay_state() === null) return 'universe replay: none is running';
        this.scene.replay_pause();
        this.replay_paint();
        return 'replay paused';
      }
      if (word === 'at') {
        if (this.scene.replay_state() === null) return 'universe replay: none is running (universe replay first)';
        const at: number = Date.parse(args[1] ?? '');
        if (!Number.isFinite(at)) return 'universe replay at <YYYY-MM-DD>';
        this.scene.replay_pause();
        this.scene.replay_seek(at);
        this.replay_paint();
        return `replay at ${new Date(this.scene.replay_state()?.at ?? at).toISOString().slice(0, 10)}`;
      }
      const speed: number = word === '' ? 1 : Number(word);
      if (!Number.isFinite(speed) || speed <= 0) return 'universe replay [speed] | pause | stop | at <YYYY-MM-DD>';
      if (this.scene.replay_state() !== null) {
        this.scene.replay_play(speed);
        this.replay_paint();
        return `replaying at ×${speed}`;
      }
      return this.replay_start(speed);
  }

  /** `universe layout`. */
  private verb_layout(args: string[]): string {
      const wanted: string = (args[0] ?? '').toLowerCase();
      if (wanted !== 'galaxy' && wanted !== 'spokes' && wanted !== 'clumps' && wanted !== 'constellations' && wanted !== 'data' && wanted !== 'accretion') return 'universe layout galaxy|spokes|clumps|constellations|data|accretion';
      return this.arrangement_set(wanted);
  }

  /** `universe draw`. */
  private verb_draw(args: string[]): string {
      const wanted: string = (args[0] ?? '').toLowerCase();
      if (wanted !== 'stars' && wanted !== 'spheres') return 'universe draw stars|spheres';
      return this.draw_set(wanted);
  }

  /** `universe regrow`. */
  private verb_regrow(): string {
      // A coral keeps what has grown, and a removed feed leaves its gap:
      // regrowing forgets the kept places and grows the space afresh.
      if (this.arrangement !== 'accretion' || this.inside !== null || this.cluster !== null) return 'universe regrow: the ACCRETION layout only (universe layout accretion)';
      this.replay_end();
      const key: string | null = this.positionsKey_derive('accretion');
      try { if (key !== null) this.store?.setItem(key, '{}'); } catch { /* a refused store forgets nothing; the space still regrows */ }
      this.paint(true, 'full');
      return 'the space regrown from its first feed';
  }

  /** `universe captions`. */
  private verb_captions(args: string[]): string {
      const wanted: string = (args[0] ?? '').toLowerCase();
      if (wanted !== 'on' && wanted !== 'off') return 'universe captions on|off';
      return this.captions_set(wanted === 'on');
  }

  /** `universe density`. */
  private verb_density(args: string[]): string {
      const wanted: string = (args[0] ?? '').toLowerCase();
      if (wanted !== 'shape' && wanted !== 'census') return 'universe density shape|census';
      return this.density_set(wanted);
  }

  /** `universe physics`. */
  private verb_physics(args: string[]): string {
      const term: string = (args[0] ?? '').toLowerCase();
      if (term === 'reset') return this.physics_reset();
      if (!['charge', 'link', 'collide', 'gravity'].includes(term)) return 'universe physics charge|link|collide|gravity [on|off] | reset';
      const on: boolean = (args[1] ?? 'on').toLowerCase() !== 'off';
      return this.physics_set(term as keyof PhysicsTerms, on);
  }

  /** `universe view`. */
  private verb_view(args: string[]): string {
      const wanted: string = (args[0] ?? '').toLowerCase();
      if (wanted !== 'feeds' && wanted !== 'shapes') return 'universe view feeds|shapes';
      if (this.inside !== null || this.cluster !== null) return 'universe view: climb out first (universe back)';
      this.view_set(wanted);
      return wanted === 'feeds' ? 'every feed its own molecule' : 'the shapes folded, one molecule each';
  }

  /** `universe cluster`. */
  private verb_cluster(args: string[]): string {
      const feedId: number = parseInt(args[0] ?? '', 10);
      const feed: LandedFeed | undefined = Number.isFinite(feedId) ? this.landed.get(feedId) : undefined;
      if (feed === undefined) return 'universe cluster <feed id>: the cluster of a feed that landed here';
      if (this.inside !== null) return `universe cluster: inside feed ${this.inside.feedId}; universe back first`;
      this.cluster_enter(shape_derive(feed));
      return `viewing the cluster of feed ${feedId}: ${shapeWords_format(shape_derive(feed))}`;
  }

  /** `universe back`. */
  private verb_back(): string {
      if (this.inside === null && this.cluster === null) return 'universe back: not inside a feed or a cluster';
      this.ascend();
      return 'climbing out';
  }

  /** `universe open`. */
  private verb_open(): string {
      if (this.inside === null) return 'universe open: not inside a feed';
      this.handlers.feed_open?.(this.inside.feedId);
      return `opening feed ${this.inside.feedId}`;
  }

  /**
   * Sets one physics term of the settle and re-settles the top of the
   * universe. Refused while inside a feed or a cluster: their settle is
   * the descent's own.
   *
   * @param term - The term.
   * @param on - Its new state.
   * @returns What happened, for the console.
   */
  private physics_set(term: keyof PhysicsTerms, on: boolean): string {
    if (this.inside !== null || this.cluster !== null) return 'universe physics: climb out first (universe back)';
    if (term === 'reach') return 'universe physics: reach is the pane\'s own';
    this.physics = { ...this.physics, [term]: on };
    this.physics_apply();
    return `physics ${term} ${on ? 'on' : 'off'}`;
  }

  /**
   * Draws the space as stars or as lit spheres; nothing moves.
   *
   * @param mode - The draw mode.
   * @returns What happened, for the console.
   */
  private draw_set(mode: DrawMode): string {
    this.replay_end();
    this.drawMode = mode;
    if (this.drawPill !== null) this.drawPill.textContent = mode.toUpperCase();
    this.scene.draw_set(mode);
    this.settings_save();
    return mode === 'stars' ? 'every sphere a point of light' : 'every sphere lit and solid';
  }

  /**
   * Shows or hides the space's captions; nothing moves or redraws.
   *
   * @param on - Shown.
   * @returns What happened, for the console.
   */
  private captions_set(on: boolean): string {
    this.captions = on;
    if (this.captionsPill !== null) this.captionsPill.textContent = on ? 'CAPTIONS ON' : 'CAPTIONS OFF';
    this.scene.captions_set(on);
    this.settings_save();
    return on ? 'captions on: each hub names itself and its count' : 'captions off: a hub names itself on hover';
  }

  /**
   * Arranges the molecules round their anchors: spokes or clumps. The space
   * is laid out afresh, with its readout.
   *
   * @param arrangement - The arrangement.
   * @returns What happened, for the console.
   */
  private arrangement_set(arrangement: Arrangement): string {
    if (ownGraph_is(arrangement) && this.view !== 'feeds') return `universe layout ${arrangement}: the FEEDS view only (universe view feeds)`;
    this.replay_end();
    // Constellations, DATA and accretion each bring a graph of their own; the others share one.
    const graphOf = (a: Arrangement): string => (ownGraph_is(a) ? a : 'hubs');
    const graphChanges: boolean = graphOf(arrangement) !== graphOf(this.arrangement);
    this.litHub = null;
    // The space as it stands is the old arrangement's: kept under its name
    // before the name changes. Kept after, a galaxy was filed as spokes and
    // every layout recalled the one before it.
    this.remember_now();
    this.arrangement = arrangement;
    if (this.arrangementPill !== null) this.arrangementPill.textContent = arrangement.toUpperCase();
    // Nothing kept here for this layout: the session may keep it, and its
    // answer seeds the settle before it runs (the session answers in order).
    if (this.positions_recalled(arrangement) === undefined) this.handlers.command_run(`proc layout ${this.sessionLayoutName_derive(arrangement)}`);
    if (this.inside === null && this.cluster === null) {
      // Constellations bring their own graph (the plugin stars, no hubs):
      // the arrangement is set without a redraw and the new graph painted.
      this.scene.arrangement_set(arrangement === 'data' ? 'hubs' : arrangement, this.positions_recalled(arrangement), !graphChanges);
      if (graphChanges) this.paint(true, this.positions_recalled(arrangement) === undefined ? 'full' : 'hold');
    }
    this.settings_save();
    return arrangement === 'galaxy'
      ? 'the space finds its own shape: every sphere pushing, every edge holding'
      : arrangement === 'spokes' ? 'each molecule a spoke round its hub'
      : arrangement === 'clumps' ? 'molecules packed round their hub'
      : arrangement === 'constellations' ? 'every plugin a star, placed by what runs with what; every feed pulled to the stars it ran'
      : arrangement === 'data' ? 'every feed hung from what it began from: its format, its modality, its series'
      : 'the space grown in the order it was made: each feed wandering until it sticks, to its kin more readily than to strangers';
  }

  /** Where this identity's frame choices are kept. */
  private settingsKey_get(): string | null {
    return this.storeKey === null ? null : this.storeKey.replace(/^argus\.universe\./, 'argus.universe.settings.');
  }

  /** Keeps the frame's choices for this identity. The physics knobs are play and are not kept. */
  private settings_save(): void {
    const key: string | null = this.settingsKey_get();
    if (this.store === undefined || key === null) return;
    try {
      this.store.setItem(key, JSON.stringify(universeSettings_build(this.drawMode, this.view, this.scale, this.density, this.arrangement, this.captions)));
    } catch {
      // A full or refused store forgets; the choices still hold for now.
    }
  }

  /**
   * Takes this identity's kept frame choices, before the space is drawn.
   *
   * @returns Whether the view or the scale changed, which reshapes the space.
   */
  private settings_recall(): boolean {
    const key: string | null = this.settingsKey_get();
    if (this.store === undefined || key === null) return false;
    let text: string | null = null;
    try {
      text = this.store.getItem(key);
    } catch {
      return false;
    }
    const kept = universeSettings_parse(text);
    const reshaped: boolean = kept.view !== this.view || kept.scale !== this.scale;
    this.drawMode = kept.draw;
    this.view = kept.view;
    this.scale = kept.scale;
    this.density = kept.density;
    this.arrangement = kept.arrangement;
    if (this.arrangementPill !== null) this.arrangementPill.textContent = kept.arrangement.toUpperCase();
    this.scene.arrangement_set(kept.arrangement === 'data' ? 'hubs' : kept.arrangement, this.positions_recalled(kept.arrangement));
    if (this.drawPill !== null) this.drawPill.textContent = kept.draw.toUpperCase();
    if (this.viewPill !== null) this.viewPill.textContent = kept.view.toUpperCase();
    if (this.scalePill !== null) this.scalePill.textContent = kept.scale === 'jobs' ? 'JOBS' : 'ALIKE';
    if (this.densityPill !== null) this.densityPill.textContent = kept.density.toUpperCase();
    this.scene.draw_set(kept.draw);
    this.scene.census_set(kept.density === 'census');
    this.captions = kept.captions;
    if (this.captionsPill !== null) this.captionsPill.textContent = kept.captions ? 'CAPTIONS ON' : 'CAPTIONS OFF';
    this.scene.captions_set(kept.captions);
    return reshaped;
  }

  /**
   * Draws every job of the space as its own point (CENSUS), or a stage as
   * one sphere with its count (SHAPE). The counts already ride the
   * groups, so a census costs no data and no call: the scene shells each
   * group's members around it in one instanced mesh.
   *
   * @param density - Which.
   * @returns What happened, for the console.
   */
  private density_set(density: 'shape' | 'census'): string {
    this.replay_end();
    this.density = density;
    if (this.densityPill !== null) this.densityPill.textContent = density.toUpperCase();
    this.scene.census_set(density === 'census');
    this.settings_save();
    return density === 'census' ? 'every job its own point' : 'a stage one sphere, with its count';
  }

  /** Puts every term back as the universe wants them. */
  private physics_reset(): string {
    if (this.inside !== null || this.cluster !== null) return 'universe physics: climb out first (universe back)';
    this.physics = { ...PHYSICS_DEFAULT, gravity: true };
    this.physics_apply();
    return 'physics reset';
  }

  private physics_apply(): void {
    if (this.gravityPill !== null) this.gravityPill.textContent = this.physics.gravity ? 'GRAVITY ON' : 'GRAVITY OFF';
    // The reach rides on top of the operator's terms, chosen per paint.
    this.scene.physics_set({ ...this.physics, reach: this.reach ?? undefined });
    this.title_paint();
  }

  /** Switches the top of the universe between every feed and the folded shapes. */
  private view_set(view: 'feeds' | 'shapes'): void {
    this.replay_end();
    // Folded shapes have no plugin stars, no data hubs and no feeds to grow: they give way to the galaxy.
    if (view === 'shapes' && ownGraph_is(this.arrangement)) {
      this.arrangement = 'galaxy';
      if (this.arrangementPill !== null) this.arrangementPill.textContent = 'GALAXY';
      this.scene.arrangement_set('galaxy', this.positions_recalled('galaxy'), false);
    }
    // The view leaving is kept under its own name before the name changes.
    this.remember_now();
    this.view = view;
    if (this.viewPill !== null) this.viewPill.textContent = view.toUpperCase();
    if (this.shown && this.inside === null && this.cluster === null) {
      // A view already seen is drawn where it stood; only a first visit
      // settles the whole space. Settled afresh on every switch, a return
      // to FEEDS raced whatever the operator did next, and a step that
      // cancelled the settle left the scene holding the folded shapes.
      const kept = this.positions_recalled(this.arrangement);
      if (kept !== undefined) {
        this.scene.positions_seed(kept);
        this.paint(true, 'new');
      } else {
        this.paint(true, 'full');
      }
    }
    this.settings_save();
  }

  /** Whether a feed is entered, for a host that asks. */
  public inside_get(): number | null {
    return this.inside?.feedId ?? null;
  }

  /** Whether a space has arrived, for a host deciding whether to ask. */
  public shown_get(): boolean {
    return this.shown;
  }

  /** Releases the scene. */
  public dispose(): void {
    this.disposed = true;
    this.watch_hold(null);
    window.removeEventListener('keydown', this.escape_listen);
    if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
    if (this.rememberTimer !== null) window.clearTimeout(this.rememberTimer);
    this.remember_now();
    this.scene.dispose();
  }

  /**
   * Puts the space on the canvas. A whole space replaces what was drawn,
   * so a feed gone from the index leaves; a warming one is what has landed
   * so far and grows from here.
   */
  private space_show(model: ProcUniverseModel): void {
    this.asking = false;
    // The same space twice (two asks crossed: the tile's and the pane's) is
    // taken once: a second paint would throw away the settle under way.
    const spaceKey: string = `${model.whole ? 'W' : 'L'}|${model.feeds.map((feed: LandedFeed): string => `${feed.id}:${feed.jobs}:${feed.status}`).join(',')}`;
    if (this.shown && spaceKey === this.spaceKey) {
      this.title_paint();
      return;
    }
    this.spaceKey = spaceKey;
    this.wait.hide();
    this.whole = model.whole;
    if (!this.shown) {
      this.shown = true;
      this.seed_recall();
    }
    this.landed.clear();
    this.landed.take(model.feeds);
    if (this.whole) this.warming = '';
    this.empty.style.display = 'none';
    this.canvas.style.display = 'block';
    // A space arriving while a feed is entered (or being entered) is taken,
    // not drawn: the descent stands until the climb, which paints what has
    // landed since. Drawn, it keeps a camera the operator has placed: a
    // re-ask is the lab moving, not a reason to fly the operator out.
    if (this.inside === null && this.cluster === null && this.entering === null && !this.scene.moving()) this.paint(!this.scene.camera_touched());
    else this.title_paint();
  }

  /** Takes landings into the space, repainting at most once a second. */
  private landings_take(landed: ReadonlyArray<LandedFeed>): void {
    if (!this.landed.take(landed) || this.repaintTimer !== null || this.inside !== null || this.cluster !== null || this.entering !== null) return;
    this.repaintTimer = window.setTimeout((): void => {
      this.repaintTimer = null;
      if (this.disposed || this.entering !== null || this.inside !== null || this.cluster !== null || this.scene.moving()) return;
      this.paint(!this.scene.camera_touched());
    }, REPAINT_MS);
  }

  /**
   * Draws the top of the universe.
   *
   * @param fit - Frame the space whole.
   * @param settle - `new` (the default): what already stands holds still and
   *   only newcomers settle, so a landing or a climb back out moves nothing
   *   the operator has seen; `full` when the spheres themselves change (a
   *   scale or a view), which re-settles all of them.
   */
  private paint(fit: boolean = true, settle: SettleMode = 'new'): void {
    // The session is laying this layout out: its places are drawn when they come.
    if (this.sessionWait_holds()) {
      this.title_paint();
      return;
    }
    // The top of the universe: every feed (the structure itself), or the
    // shapes folded when the operator asks for it.
    const built = this.view === 'shapes' ? foldedGraph_build(this.landed.all(), this.scale)
      : this.arrangement === 'constellations' ? constellationsGraph_build(this.landed.all(), this.scale)
      : this.arrangement === 'data' ? this.dataGraph_paint()
      : this.arrangement === 'accretion' ? accretionGraph_build(this.landed.all(), this.scale)
      : universeGraph_build(this.landed.all(), this.scale);
    // A lit plugin: its stages as drawn, every other stage faint. The stars
    // stay lit — a faint star takes no pointer, and another plugin must
    // stay one press away.
    const lit: string | null = this.arrangement === 'constellations' ? this.lit : null;
    const graph = lit === null ? built : { nodes: built.nodes.map((node: SceneNode): SceneNode => (node.attrs?.['kind'] === 'star' || node.attrs?.['plugin'] === lit ? node : { ...node, dim: true })) };
    // Hug while small, spread when a crowd: the bound that keeps a lone
    // molecule together would pack seven hundred feeds into one ball.
    // Set only when it changes: physics_set settles the old graph again.
    const reach: number | undefined = universeReach_derive(graph.nodes.length);
    if (reach !== this.reach) {
      this.reach = reach;
      // The graph below settles under the new reach; settling the old one
      // first cost a whole second settle.
      this.scene.physics_set({ reach }, false);
    }
    this.scene.graph_set(graph, { wave: false, fit, settle });
    this.title_paint();
    this.remember_later();
  }

  /**
   * Descends into one feed: the camera flies to its molecule, the kernel's
   * graph of the feed is asked for, the molecule unfolds into it in place
   * while the rest of the space dims, and the camera frames the feed.
   *
   * @param feedId - The feed.
   */
  private descend(feedId: number, clicked?: string): void {
    // A feed is entered from the space as it stands, not a moment of its history.
    this.replay_end();
    const feed: LandedFeed | undefined = this.landed.get(feedId);
    const ask = this.handlers.feed_dag;
    if (feed === undefined || ask === undefined || this.scene.moving() || this.inside !== null) return;
    this.facts_clear();
    // The feed is entered in the device's remembered modes, whichever door last turned them.
    this.feedView?.recall();
    const spheres: string[] = sphereIds_list(feedId, feed);
    // The ask can take seconds on a large feed, and can be refused: the bar
    // says which feed is being entered while it waits, and the console
    // says why when nothing comes. A descent that yields nothing must not
    // be silent — the operator's click did happen.
    this.entering = feedId;
    this.title_paint();
    const asked: number = Date.now();
    // A click flies toward the star clicked; a word (universe enter) frames
    // the feed's spheres.
    const approach = clicked !== undefined ? { toward: clicked, distance: 14, durationMs: DESCENT_MS } : { fit: spheres, durationMs: DESCENT_MS };
    this.scene.descent(approach, async (): Promise<ScenePlan | null> => {
      const model: FeedDagModel | null = await ask(feedId);
      if (this.disposed) return null;
      this.entering = null;
      if (model === null) {
        this.title_paint();
        this.handlers.note?.(`universe: feed ${feedId}: the session gave no graph for it (feed diagram feed_${feedId} refused or answered nothing after ${Math.round((Date.now() - asked) / 1000)}s)`);
        return null;
      }
      const plan: ScenePlan = this.insidePlan_build(feedId, feed, model, [spheres, foldIds_list(shape_derive(feed), this.landed)], DESCENT_MS);
      return {
        ...plan,
        drawn: (): void => {
          const ids: Set<string> = new Set(plan.unfolding);
          this.inside = { feedId, title: model.feedName, entered: this.insideEntered as EnteredFeed, ids };
          this.insideModel = model;
          this.pane?.classList.add('universe-inside');
          projection_paint(this.pane, this.scene, this.inside !== null);
          // The feed view's look stands while inside: its draw style and its
          // pulse, whatever the space was drawn as; the space's comes back on the way out.
          const modes: FeedModes = this.feedView?.modes_get() ?? { ...FEED_MODES_DEFAULT };
          this.insideModes = modes;
          this.scene.draw_set(modes.draw);
          if (this.drawPill !== null) this.drawPill.textContent = modes.draw.toUpperCase();
          this.scene.waveLoop_set(modes.pulse);
          this.feedFrame?.shown_set(true);
          this.feedFrame?.arrived(feedId);
          // Live, as RUNS is: the session samples the feed and its fresh
          // models patch it in place (a-feed-has-one-view).
          this.watch_hold(feedId);
          this.title_paint();
        },
      };
    }, (): void => this.landed_note());
  }

  /**
   * The plan that draws one feed inside the space, read the feed view's way
   * (law a-feed-has-one-view): the shared builder under the view's modes,
   * its ids scoped to the space, laid out as its tree (root on top) and held
   * there unless the view is arranged as a molecule, the rest of the space
   * dimmed behind it.
   *
   * @param feedId - The feed.
   * @param feed - Its landing.
   * @param model - The kernel's graph of it.
   * @param from - Where the feed unfolds from.
   * @param durationMs - How long the camera takes to frame it.
   * @returns The plan, without its drawn hook.
   */
  private insidePlan_build(feedId: number, feed: LandedFeed, model: FeedDagModel, from: ReadonlyArray<ReadonlyArray<string>>, durationMs: number): ScenePlan {
    const modes: FeedModes = this.feedView?.modes_get() ?? { ...FEED_MODES_DEFAULT };
    const entered: EnteredFeed = feedGraph_build(model, {
      metric: modes.metric,
      hue: modes.hue,
      legend: modes.hue === 'compute' ? feedHueLegend_build(model) : new Map(),
      draw: modes.draw,
      id_map: (nodeId: string): string => instanceId_format(feedId, nodeId),
    });
    this.insideEntered = entered;
    // A feed opens as its tree, root on top, as it does from the roster:
    // laid out here and held where it is put, not settled into a burst.
    let placed: Record<string, [number, number, number]> | undefined;
    if (modes.strategy === 'ranked') {
      placed = {};
      for (const at of ranked_layout(entered.nodes.map((node: SceneNode) => ({ id: node.id, parentIds: node.parentIds, ...(node.metric !== undefined ? { metric: node.metric } : {}) })))) {
        placed[at.id] = [at.position[0], at.position[1], at.position[2]];
      }
    }
    // The base is what stands behind the feed: every feed, or its own
    // shape unfolded with the rest still folded; the feed's molecule
    // replaced by its graph, everything but the graph dimmed.
    const prefix: string = `feed:${feedId}:`;
    const graph: SceneGraph = this.view === 'feeds'
      ? descendedGraph_build(this.landed.all(), feedId, entered, this.scale, this.arrangement === 'constellations', this.arrangement === 'data' ? dataGraph_build(this.landed.all(), this.scale).graph : this.arrangement === 'accretion' ? accretionGraph_build(this.landed.all(), this.scale) : undefined)
      : {
          nodes: [
            ...unfoldedGraph_build(this.landed.all(), shape_derive(feed), this.scale).graph.nodes
              .filter((node: SceneNode): boolean => !node.id.startsWith(prefix))
              .map((node: SceneNode): SceneNode => ({ ...node, dim: true })),
            ...entered.nodes,
          ],
        };
    const ids: string[] = entered.nodes.map((node: SceneNode): string => node.id);
    // Only the feed moves: the rest of the space holds still. Frame the
    // bulk of the feed, not its outliers: a node must be wide enough to
    // hover and click, and the wheel reaches the rest.
    return {
      graph,
      unfolding: ids,
      from,
      physics: { reach: UNIVERSE_REACH, gravity: false },
      ...(placed !== undefined ? { placed } : {}),
      frame: ids,
      durationMs,
      bulk: 1,
      margin: 0.95,
    };
  }

  /**
   * A feed-view mode turned while a feed is entered: the feed redrawn in
   * place under the new modes (arrangement, metric, hue), or the scene told
   * (draw, pulse). Outside a feed there is nothing to apply: the modes are
   * kept for the next one.
   *
   * @param verb - The mode.
   * @param modes - The modes as they now stand.
   */
  private feedMode_apply(verb: FeedVerb, modes: FeedModes): void {
    if (this.inside === null) return;
    this.insideModes = modes;
    if (verb === 'pulse') { this.scene.waveLoop_set(modes.pulse); return; }
    if (verb === 'draw') {
      this.scene.draw_set(modes.draw);
      if (this.drawPill !== null) this.drawPill.textContent = modes.draw.toUpperCase();
      // Solid follows the draw style, so the feed is read again; the tubes stay.
    }
    const feed: LandedFeed | undefined = this.landed.get(this.inside.feedId);
    if (feed === undefined || this.insideModel === null || this.scene.moving()) return;
    const inside = this.inside;
    const plan: ScenePlan = this.insidePlan_build(inside.feedId, feed, this.insideModel, [[...inside.ids]], 400);
    this.scene.unfold({ ...plan, drawn: (): void => { this.inside = { ...inside, entered: this.insideEntered as EnteredFeed }; } });
  }

  /**
   * The pane is back on stage. Inside a feed, the device's feed memory may
   * have moved while it was away (a mode turned in RUNS on the same feed):
   * the frame takes it again, and the feed is redrawn under what changed,
   * so a feed never stands in modes the device has since left.
   */
  public stage_returned(): void {
    if (this.inside === null || this.feedView === null) return;
    const before: FeedModes | null = this.insideModes;
    const now: FeedModes = this.feedView.recall();
    if (before === null || JSON.stringify(before) === JSON.stringify(now)) return;
    if (before.draw !== now.draw) this.feedMode_apply('draw', now);
    if (before.pulse !== now.pulse) this.feedMode_apply('pulse', now);
    if (before.strategy !== now.strategy || before.metric !== now.metric || before.hue !== now.hue) this.feedMode_apply('strategy', now);
    this.insideModes = now;
  }

  /**
   * Holds the session's watch on the entered feed, releasing any other; null releases.
   *
   * @param feedId - The feed entered, or null on the way out.
   */
  private watch_hold(feedId: number | null): void {
    if (this.watchedFeedId === feedId) return;
    if (this.watchedFeedId !== null) this.handlers.watch_set?.(`/proc/jobs/feed_${this.watchedFeedId}`, false);
    this.watchedFeedId = feedId;
    this.liveState = null;
    if (feedId !== null) this.handlers.watch_set?.(`/proc/jobs/feed_${feedId}`, true);
  }

  /**
   * A watched subject's liveness changed; only the feed this pane is inside
   * is its business (an unwatch is answered too, and is not painted).
   *
   * @param subject - The watched subject address.
   * @param state - Its reported state.
   */
  public watched_observe(subject: string, state: WatchState): void {
    const match: RegExpMatchArray | null = /feed_(\d+)$/.exec(subject);
    if (match === null || Number(match[1]) !== this.watchedFeedId) return;
    this.liveState = state;
    this.title_paint();
  }

  /**
   * A fresh model of a feed from the session's sampler: the feed this pane
   * is inside is patched in place when its shape held, else redrawn where
   * it stands, under the feed view's modes. Anything else is not its business.
   *
   * @param model - The refreshed feed model.
   */
  public model_refresh(model: FeedDagModel): void {
    const inside = this.inside;
    if (inside === null || inside.feedId !== model.feedId || this.insideModel === null) return;
    const previous: FeedDagModel = this.insideModel;
    this.insideModel = model;
    if (feedShape_same(previous, model)) {
      feedStatuses_patch(this.scene, model, (nodeId: string): string => instanceId_format(model.feedId, nodeId));
      for (const node of model.nodes) this.insideEntered?.payloads.set(instanceId_format(model.feedId, node.id), node);
      return;
    }
    const feed: LandedFeed | undefined = this.landed.get(model.feedId);
    if (feed === undefined || this.scene.moving()) return;
    const plan: ScenePlan = this.insidePlan_build(model.feedId, feed, model, [[...inside.ids]], 400);
    const ids: Set<string> = new Set(plan.unfolding);
    this.scene.unfold({ ...plan, drawn: (): void => { this.inside = { ...inside, entered: this.insideEntered as EnteredFeed, ids }; this.title_paint(); } });
  }

  /**
   * Shows the entered feed's note, tags and name on the frame (see FeedFrame).
   *
   * @param feedId - The feed read.
   * @param facts - Its note, tags and name.
   */
  public feedMarks_show(feedId: number, facts: FeedFrameFacts): void {
    this.feedFrame?.show(feedId, facts);
  }

  /**
   * Climbs back out one level: from a feed to the cluster it was entered
   * from (or the whole space), from a cluster to the whole space, framed.
   */
  private ascend(): void {
    if (this.scene.moving()) return;
    this.framedAt = null;
    if (this.inside !== null) {
      this.inside = null;
      this.insideModel = null;
      this.facts_clear();
      this.pane?.classList.remove('universe-inside');
      // Out of the feed, the space's own look comes back.
      this.scene.waveLoop_set(false);
      this.scene.draw_set(this.drawMode);
      if (this.drawPill !== null) this.drawPill.textContent = this.drawMode.toUpperCase();
      this.feedFrame?.shown_set(false);
      this.watch_hold(null);
      projection_paint(this.pane, this.scene, this.inside !== null);
      if (this.cluster !== null) {
        this.cluster_show(this.cluster.shape);
        return;
      }
    } else if (this.cluster === null) {
      return;
    } else {
      this.cluster = null;
      this.pane?.classList.remove('universe-cluster');
    }
    this.paint(false);
    this.scene.frame([], ASCENT_MS);
  }

  /**
   * Brings one cluster into view: every feed of the shape lit, the rest
   * dimmed where they stand, the camera flown to frame the cluster. The
   * fsv reading one level up from a feed: a directory of feeds alike.
   *
   * @param shape - The shape.
   */
  private cluster_enter(shape: string): void {
    this.replay_end();
    if (this.scene.moving() || this.inside !== null) return;
    this.cluster_show(shape);
  }

  private cluster_show(shape: string): void {
    if (this.view === 'feeds') {
      // Every feed is already drawn: the cluster is lit where it stands,
      // the rest dimmed, nothing moved, the camera flown to frame it.
      const ids: string[] = clusterIds_list(shape, this.landed);
      if (ids.length === 0) return;
      this.cluster = { shape, ids };
      this.pane?.classList.add('universe-cluster');
      this.scene.relight(clusterGraph_build(this.landed.all(), shape, this.scale), ids, DESCENT_MS, (): void => this.landed_note(), (): void => this.title_paint());
      return;
    }
    const { graph, memberIds } = unfoldedGraph_build(this.landed.all(), shape, this.scale);
    if (memberIds.length === 0) return;
    this.cluster = { shape, ids: memberIds };
    this.pane?.classList.add('universe-cluster');
    // The members unfold from where the folded molecule stood: each starts
    // at its centre and settles out, the rest of the field frozen, no
    // gravity to the origin, no centering — the feed descent's settle.
    const memberSet: Set<string> = new Set(memberIds);
    this.scene.unfold({
      graph,
      unfolding: graph.nodes.filter((node: SceneNode): boolean => memberSet.has(node.id) || node.ghost === true).map((node: SceneNode): string => node.id),
      from: [foldIds_list(shape, this.landed)],
      physics: { reach: UNIVERSE_REACH, gravity: false },
      frame: memberIds,
      durationMs: DESCENT_MS,
      drawn: (): void => this.title_paint(),
    }, (): void => this.landed_note());
  }

  /** A descent landed: the flight is over, and where it stands is its framing. */
  private landed_note(): void {
    this.framedAt = this.scene.camera_distance();
  }

  /**
   * A two-finger gesture ended. Inside a feed or a cluster, a camera drawn
   * back well past the descent's framing climbs out one level — pinch out
   * is leave, as double tap is enter.
   */
  private pinch_leave(): void {
    if (this.inside === null && this.cluster === null) return;
    if (this.scene.moving() || this.scene.holding_get() || this.framedAt === null) return;
    if (this.scene.camera_distance() <= this.framedAt * PINCH_LEAVE_FACTOR) return;
    this.ascend();
  }

  /**
   * Flies into one of the entered feed's nodes: the camera dollies to the
   * sphere and the host opens the node's data inside it.
   *
   * @param node - The node.
   */
  private node_dive(node: SceneNode): void {
    const payload: FeedDagNode | undefined = this.inside?.entered.payloads.get(node.id);
    const dive = this.handlers.node_dive;
    if (payload === undefined || dive === undefined || this.scene.moving()) return;
    this.scene.flight_into(node.id, (): void => dive(payload.vfsPath));
  }

  /** Flies back out of a node, for the host closing the overlay. */
  public flight_back(onDone: () => void): void {
    this.scene.flight_back(onDone);
  }

  /**
   * Flies into the entered feed's node that hosts an instance: the
   * immersive hop from inside one node to a descendant.
   *
   * @param instanceID - The plugin instance.
   * @returns Whether a node of the entered feed hosts it.
   */
  public node_flyTo(instanceID: number): boolean {
    if (this.inside === null) return false;
    for (const [sceneId, payload] of this.inside.entered.payloads) {
      if (payload.instanceId !== instanceID) continue;
      const dive = this.handlers.node_dive;
      if (dive === undefined) return false;
      this.scene.flight_into(sceneId, (): void => dive(payload.vfsPath));
      return true;
    }
    return false;
  }

  /** A click: descend from a sphere outside, show facts on a node inside. */
  private node_select(node: SceneNode): void {
    if (this.scene.moving()) return;
    if (this.inside === null) {
      // A plugin star lights the stages it ran; pressed again, it goes out.
      const plugin: string | null = pluginOfStar(node.id);
      if (plugin !== null) {
        this.plugin_light(this.lit === plugin ? null : plugin);
        return;
      }
      // A DATA hub lights the feeds beneath it; pressed again, it goes out.
      const hub: string | null = dataHubKey_parse(node.id);
      if (hub !== null) {
        this.litHub = this.litHub === hub ? null : hub;
        this.paint(false, 'hold');
        return;
      }
      const match: RegExpMatchArray | null = node.id.match(/^feed:(\d+):\d+$/);
      const folded: string | null = foldShape_parse(node.id);
      if (match !== null) this.descend(Number(match[1]), node.id);
      else if (folded !== null) this.cluster_enter(folded);
      else if (node.id.startsWith('shape:')) this.cluster_enter(node.id.slice('shape:'.length));
      return;
    }
    const payload: FeedDagNode | undefined = this.inside.entered.payloads.get(node.id);
    if (payload !== undefined) this.facts_show(node, payload);
  }

  /** The selected node's facts and verbs, on the field's overlay. */
  private facts_show(node: SceneNode, payload: FeedDagNode): void {
    if (this.facts === null) return;
    // The feed view's one overlay (a-feed-has-one-view): the rows, status
    // line and verbs RUNS shows for the same node.
    feedFacts_render(this.facts, payload, {
      enter: (): void => {
        if (this.handlers.node_dive !== undefined) this.node_dive(node);
        else this.handlers.node_enter?.(payload.vfsPath);
      },
      ...(this.handlers.node_process !== undefined ? { process: this.handlers.node_process } : {}),
    });
    this.facts.hidden = false;
  }

  private facts_clear(): void {
    if (this.facts === null) return;
    this.facts.replaceChildren();
    this.facts.hidden = true;
  }

  /**
   * Writes the bar's standing state. While a pill's answer holds the bar,
   * the standing state waits: the note's timer repaints when it lets go.
   *
   * @param cls - The state class (`state-live`, `state-wait`, ...).
   * @param text - The standing readout.
   */
  private state_stand(cls: BarState, text: string): void {
    if (this.state === null) return;
    if (this.noteTimer !== null) return;
    barState_set(this.state, cls, text);
  }

  /**
   * A frame pill's answer, on the pane's own bar for a moment — not in
   * the console, which carries only what was typed or asked there (AEGIS:
   * a-pill-answers-on-its-own-bar). The standing state returns after.
   *
   * @param line - The answer.
   */
  private bar_note(line: string): void {
    if (this.state === null) return;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    barState_set(this.state, 'note', line);
    this.noteTimer = setTimeout((): void => {
      this.noteTimer = null;
      barState_clear(this.state, 'note');
      this.title_paint();
    }, NOTE_HOLD_MS);
  }

  /** Titles the space with what it holds and, while warming, how far the index is. */
  private title_paint(): void {
    if (this.entering !== null && this.inside === null) {
      const feed: LandedFeed | undefined = this.landed.get(this.entering);
      this.title.textContent = `UNIVERSE — ENTERING FEED ${this.entering}${feed !== undefined && feed.title.length > 0 ? ` · ${feed.title}` : ''} …`;
      this.state_stand('wait', 'ASKING');
      return;
    }
    if (this.inside !== null) {
      const jobs: number = this.inside.entered.nodes.reduce((sum: number, node: SceneNode): number => sum + (node.count ?? 1), 0);
      this.title.textContent = `UNIVERSE — INSIDE FEED ${this.inside.feedId} · ${this.inside.title} · ${jobs.toLocaleString('en-US')} JOBS`;
      // Whether what is drawn is current: LIVE while sampled, SETTLED once
      // it can no longer change, STALE when the last sample failed.
      this.state_stand(this.liveState === 'stale' ? 'stale' : 'live', this.liveState === null ? 'INSIDE' : `INSIDE · ${this.liveState.toUpperCase()}`);
      return;
    }
    if (this.cluster !== null) {
      const count: number = this.landed.all().filter((feed: LandedFeed): boolean => shape_derive(feed) === this.cluster?.shape).length;
      // The bar is not the place for eleven plugin names: the first few and
      // the count, the whole shape on the halo's tip.
      this.title.textContent = `UNIVERSE — SHAPE ${shapeWords_brief(this.cluster.shape)} · ${count} FEED${count === 1 ? '' : 'S'}`;
      this.state_stand('live', 'CLUSTER');
      return;
    }
    if (this.asking && !this.shown) {
      // Nothing has been told yet: say that, not "0 FEEDS", which reads
      // as an empty lab.
      this.title.textContent = 'UNIVERSE — ASKING THE SESSION …';
      this.state_stand('wait', 'ASKING');
      return;
    }
    const figure: string = `${this.landed.size()} FEEDS · ${this.landed.shapes()} SHAPES`;
    this.title.textContent = this.whole
      ? `UNIVERSE — ${figure}`
      : `UNIVERSE — ${figure}${this.warming.length > 0 ? ` · ${this.warming}` : ' · INDEX WARMING'}`;
    this.state_stand(this.whole ? 'settled' : 'wait', this.whole ? 'WHOLE' : 'LANDING');
    if (this.scene.replay_state() !== null) this.replay_paint();
  }

  /**
   * Starts a replay: every feed hidden until the day it was made, then
   * shown with a flash where it stands now, the camera untouched. Only the
   * whole space, feed by feed, as stars: a replay of a folded shape or a
   * census would reveal something no feed was.
   *
   * @param speed - 1 crosses the whole history in thirty seconds.
   * @returns What happened, in words.
   */
  private replay_start(speed: number): string {
    if (this.inside !== null || this.cluster !== null) return 'universe replay: climb out first (universe back)';
    if (this.view !== 'feeds') return 'universe replay: the FEEDS view only (universe view feeds)';
    if (this.density !== 'shape') return 'universe replay: SHAPE density only (universe density shape)';
    if (this.drawMode !== 'stars') return 'universe replay: it draws stars (universe draw stars)';
    const made: Map<number, number> = new Map();
    for (const feed of this.landed.all()) {
      const at: number = Date.parse(feed.createdAt ?? '');
      if (Number.isFinite(at)) made.set(feed.id, at);
    }
    if (made.size === 0) return 'universe replay: the session does not say when its feeds were made (a daemon from before the replay: restart it)';
    const arrivals: Map<string, number> = new Map();
    for (const id of Object.keys(this.scene.positions_get())) {
      const feed: RegExpMatchArray | null = id.match(/^feed:(\d+):/);
      const at: number | undefined = feed === null ? undefined : made.get(Number(feed[1]));
      if (at !== undefined) arrivals.set(id, at);
    }
    this.facts_clear();
    this.replayDay = '';
    this.scene.replay_begin(arrivals, speed);
    this.replay_paint();
    const state = this.scene.replay_state();
    const from: string = new Date(state?.span[0] ?? 0).toISOString().slice(0, 10);
    const to: string = new Date(state?.span[1] ?? 0).toISOString().slice(0, 10);
    return `replaying ${made.size} feeds, ${from} to ${to}, at ×${speed} (universe replay pause | stop | at <date>; Esc stops)`;
  }

  /**
   * Lights one plugin's stages across the sky — its star and every stage
   * that ran it as drawn, the rest faint, nothing moved — and says what it
   * is on the facts overlay; null puts it out.
   *
   * @param plugin - The plugin, or null.
   */
  private plugin_light(plugin: string | null): void {
    this.lit = plugin;
    if (plugin === null) this.facts_clear();
    else this.pluginFacts_show(plugin);
    if (this.shown && this.inside === null && this.cluster === null) this.paint(false, 'hold');
  }

  /**
   * Frames the stages a plugin ran: the camera flown to hold their bulk.
   *
   * @param plugin - The plugin.
   */
  private plugin_frame(plugin: string): void {
    if (this.lit !== plugin) this.plugin_light(plugin);
    const ids: string[] = [];
    for (const feed of this.landed.all()) {
      feed.groups.forEach((group, index: number): void => {
        if (group.plugin === plugin) ids.push(`feed:${feed.id}:${index}`);
      });
    }
    if (ids.length === 0 || this.scene.moving()) return;
    this.scene.frame(ids, DESCENT_MS, undefined, 0.9);
  }

  /** A lit plugin's facts and its verb, on the field's overlay. */
  private pluginFacts_show(plugin: string): void {
    if (this.facts === null) return;
    this.facts.replaceChildren();
    const tip: string = pluginTip_render(`plugin:${plugin}`, this.landed) ?? plugin;
    const [, feeds = '', errored = ''] = tip.split(' · ');
    for (const [label, value] of [['PLUGIN', plugin], ['FEEDS', feeds.replace(/ feeds?$/, '')], ['ERRORED', errored.replace(/ errored$/, '')]] as Array<[string, string]>) {
      const row: HTMLDivElement = document.createElement('div');
      row.className = 'telemetry-row';
      const name: HTMLSpanElement = document.createElement('span');
      name.className = 'telemetry-label';
      name.textContent = label;
      const figure: HTMLSpanElement = document.createElement('span');
      figure.className = 'telemetry-value';
      figure.textContent = value;
      row.append(name, figure);
      this.facts.append(row);
    }
    // The plugin's verb rides its facts: a control lives where it acts.
    const verbs: HTMLDivElement = document.createElement('div');
    verbs.className = 'universe-node-verbs';
    const open: HTMLButtonElement = document.createElement('button');
    open.className = 'pacs-capsule universe-plugin-open';
    open.textContent = 'OPEN IN /BIN';
    open.title = 'the plugin in the files browser: its one-node graph, its parameters';
    open.addEventListener('click', (): void => this.handlers.plugin_open?.(plugin));
    verbs.append(open);
    this.facts.append(verbs);
    this.facts.hidden = false;
  }

  /**
   * DATA's graph for this paint: the hubs kept for the tips, and with a hub
   * lit, every feed not beneath it faint (the hubs stay, and pressable).
   */
  private dataGraph_paint(): SceneGraph {
    const { graph, hubs } = dataGraph_build(this.landed.all(), this.scale);
    this.dataHubs = hubs;
    const lit: string | null = this.litHub;
    if (lit === null) return graph;
    const groupOf = descriptionGroups_build(this.landed.all().map((feed: LandedFeed): string | undefined => feed.data?.seriesDescription).filter((d: string | undefined): d is string => d !== undefined));
    const beneath: Set<number> = new Set(this.landed.all()
      .filter((feed: LandedFeed): boolean => dataPath_build(feed, groupOf).some((step): boolean => step.key === lit))
      .map((feed: LandedFeed): number => feed.id));
    return { nodes: graph.nodes.map((node: SceneNode): SceneNode => {
      if (dataHubKey_parse(node.id) !== null) return node;
      const feed: RegExpMatchArray | null = node.id.match(/^feed:(\d+):/);
      return feed !== null && beneath.has(Number(feed[1])) ? node : { ...node, dim: true };
    }) };
  }

  /** Ends a replay, if one runs: the space shown whole again. */
  private replay_end(): void {
    if (this.scene.replay_state() === null) return;
    this.scene.replay_stop();
    this.replayDay = '';
    this.title_paint();
    this.replay_paint();
  }

  /**
   * Paints the replay on the frame and the bar: the block names its state
   * (REPLAY at rest, PLAYING, PAUSED, REPLAYED at the end) and the bar's
   * readout the day the history has reached, repainted once a day.
   */
  private replay_paint(): void {
    const state = this.scene.replay_state();
    if (this.replayPill !== null) {
      const done: boolean = state !== null && !state.playing && state.at >= state.span[1];
      this.replayPill.textContent = state === null ? 'REPLAY' : state.playing ? 'PLAYING' : done ? 'REPLAYED' : 'PAUSED';
      this.replayPill.classList.toggle('rail-off', state === null);
    }
    if (state === null || this.state === null) return;
    const day: string = `${state.playing ? 'REPLAY' : 'PAUSED'} ${new Date(state.at).toISOString().slice(0, 10)}`;
    if (day === this.replayDay) return;
    this.replayDay = day;
    this.state_stand('live', day);
  }

  /** Learns whose universe this is, once, and seeds it if a space is already up. */
  private identity_note(user: string, uri: string): void {
    const key: string = universeStoreKey_format(user, uri);
    if (key === this.storeKey) return;
    this.storeKey = key;
    const reshaped: boolean = this.settings_recall();
    if (this.shown) {
      const seeded: boolean = this.seed_recall();
      // Repaint only for something recalled: a restart of a settle already
      // under way for nothing new costs its whole run again.
      if ((reshaped || seeded) && this.inside === null && this.cluster === null) this.paint(false);
    }
  }

  /** Seeds the next settle from the remembered positions, if any. */
  /**
   * Where an arrangement's positions are kept: a galaxy under the key the
   * universe always used, each other arrangement beside it, and the folded
   * shapes of each apart from every feed's.
   */
  private positionsKey_derive(arrangement: Arrangement): string | null {
    if (this.storeKey === null) return null;
    // The folded shapes are other nodes: kept beside every feed's places, never over them.
    const key: string = arrangement === 'galaxy' ? this.storeKey : `${this.storeKey}.${arrangement}`;
    return this.view === 'shapes' ? `${key}.shapes` : key;
  }

  /** The positions kept for an arrangement, or none. */
  private positions_recalled(arrangement: Arrangement): Record<string, [number, number, number]> | undefined {
    const key: string | null = this.positionsKey_derive(arrangement);
    if (this.store === undefined || key === null) return undefined;
    try {
      const positions = storedPositions_parse(this.store.getItem(key));
      return Object.keys(positions).length > 0 ? positions : undefined;
    } catch {
      return undefined;
    }
  }

  /** @returns Whether any positions were remembered and seeded. */
  private seed_recall(): boolean {
    const key: string | null = this.positionsKey_derive(this.arrangement);
    if (this.store === undefined || key === null) return false;
    const positions = storedPositions_parse(this.store.getItem(key));
    if (Object.keys(positions).length === 0) return false;
    this.scene.positions_seed(positions);
    return true;
  }

  private remember_later(): void {
    if (this.rememberTimer !== null) return;
    this.rememberTimer = window.setTimeout((): void => {
      this.rememberTimer = null;
      this.remember_now();
    }, REMEMBER_MS);
  }

  /** Writes where the molecules stand, for the next visit. */
  private remember_now(): void {
    if (this.store === undefined || this.storeKey === null || !this.shown) return;
    // Kept only as the view on stage: a remember timer set under SHAPES and
    // firing after FEEDS is back once filed the folded shapes as the galaxy,
    // for this browser and for the session's copy.
    if (!this.positions_matchView(this.scene.positions_get())) return;
    try {
      // The positions are the panel's arrangement's (DATA settles as the scene's hubs).
      const key: string | null = this.positionsKey_derive(this.arrangement);
      if (key !== null) this.store.setItem(key, JSON.stringify(this.scene.positions_get()));
    } catch {
      // A full or refused store forgets; the space still draws.
    }
    this.sessionLayout_put();
  }

  /**
   * Whether a set of places is the view on stage's: folded stages under
   * SHAPES, every feed's own under FEEDS.
   *
   * @param positions - The places.
   * @returns Whether they are.
   */
  private positions_matchView(positions: Record<string, [number, number, number]>): boolean {
    const ids: string[] = Object.keys(positions);
    const folded: boolean = ids.some((id: string): boolean => id.startsWith('fold:'));
    const feeds: boolean = ids.some((id: string): boolean => id.startsWith('feed:'));
    return this.view === 'shapes' ? folded && !feeds : !folded;
  }

  /**
   * The name the session keeps a layout under: the arrangement, with the
   * folded shapes (other nodes) and spheres alike (other radii) kept apart.
   */
  private sessionLayoutName_derive(arrangement: Arrangement): string {
    // Spheres all alike are other radii, so other places: kept apart from JOBS, which the session lays out itself.
    return `${arrangement}${this.view === 'shapes' ? '-shapes' : ''}${this.scale === 'feeds' ? '-alike' : ''}`;
  }

  /**
   * Takes the session's copy of a layout: kept here when this browser
   * keeps none of its own, so the next settle holds it and only what is new
   * since settles. A browser that has its own keeps it.
   *
   * @param name - The layout the session answered for.
   * @param positions - Its places, or null when it keeps none.
   */
  private sessionLayout_take(name: string, positions: Record<string, [number, number, number]> | null, laying: { nodes: number; fraction: number } | null = null): void {
    // What the session keeps is never less than this browser put there.
    if (positions !== null || !this.sessionPlaces.has(name)) this.sessionPlaces.set(name, positions === null ? null : Object.keys(positions).length);
    if (positions === null && laying !== null) {
      this.sessionWait_hold(name, laying);
      return;
    }
    const waited: boolean = this.sessionWait?.name === name;
    if (waited) this.sessionWait_end();
    if (positions === null || this.store === undefined) {
      // The session laid nothing out after all: this browser settles the space itself.
      if (waited && this.shown) this.paint(true, 'full');
      return;
    }
    const arrangement: Arrangement | undefined = (['galaxy', 'spokes', 'clumps', 'constellations', 'data', 'accretion'] as const)
      .find((a: Arrangement): boolean => this.sessionLayoutName_derive(a) === name);
    if (arrangement === undefined || this.positions_recalled(arrangement) !== undefined) return;
    const key: string | null = this.positionsKey_derive(arrangement);
    if (key === null) return;
    try {
      this.store.setItem(key, JSON.stringify(positions));
    } catch {
      return;
    }
    this.putSignatures.set(name, placesSignature_compute(positions));
    // Taken for the layout on stage, under a space already drawn (a settle
    // of this browser's own under way): seeded and painted again, holding
    // what the session placed so only what is new since settles. A space
    // not yet on stage seeds from the store when it arrives.
    if (arrangement === this.arrangement && this.shown && this.inside === null && this.cluster === null && this.entering === null) {
      this.scene.positions_seed(positions);
      this.paint(waited, 'new');
    }
  }

  /**
   * Waits for the session laying a layout out, showing its progress, rather
   * than settling the same space again here: asked again every moment until
   * the places come, and given up on after {@link SESSION_WAIT_MS}.
   *
   * @param name - The layout the session is laying out.
   * @param laying - How far it has come.
   */
  private sessionWait_hold(name: string, laying: { nodes: number; fraction: number }): void {
    if (name !== this.sessionLayoutName_derive(this.arrangement) || this.positions_recalled(this.arrangement) !== undefined) return;
    const until: number = this.sessionWait?.name === name ? this.sessionWait.until : Date.now() + SESSION_WAIT_MS;
    if (this.sessionWait?.timer !== undefined && this.sessionWait?.timer !== null) window.clearTimeout(this.sessionWait.timer);
    if (Date.now() >= until) {
      this.sessionWait_end();
      if (this.shown) this.paint(true, 'full');
      return;
    }
    this.wait.show(`LAYING OUT ${laying.nodes.toLocaleString('en-US')} SPHERES · THE SESSION`, laying.fraction);
    const timer: number = window.setTimeout((): void => { this.handlers.command_run(`proc layout ${name}`); }, SESSION_WAIT_ASK_MS);
    this.sessionWait = { name, until, timer };
  }

  /** Stops waiting for the session. */
  private sessionWait_end(): void {
    if (this.sessionWait?.timer !== undefined && this.sessionWait?.timer !== null) window.clearTimeout(this.sessionWait.timer);
    this.sessionWait = null;
    this.wait.hide();
  }

  /** Whether the pane waits for the session to lay out the layout on stage. */
  private sessionWait_holds(): boolean {
    return this.sessionWait !== null && this.sessionWait.name === this.sessionLayoutName_derive(this.arrangement)
      && Date.now() < this.sessionWait.until && this.inside === null && this.cluster === null;
  }

  /**
   * Puts where the whole space stands to the session, when it moved: every
   * browser after this one draws it at once. Only the whole space at rest —
   * never a feed entered, a cluster, or a replay.
   */
  private sessionLayout_put(): void {
    if (this.inside !== null || this.cluster !== null || this.scene.replay_state() !== null) return;
    // Only the space every browser would find: the index whole, the physics
    // as they come. A knob turned (gravity off) is play, and never replaces
    // the places kept for everyone.
    if (!this.whole || !physics_isDefault(this.physics)) return;
    const positions: Record<string, [number, number, number]> = {};
    for (const [id, at] of Object.entries(this.scene.positions_get())) {
      // A node not yet placed has no place to keep (NaN travels as null, and the session refuses the lot).
      if (!at.every((v: number): boolean => Number.isFinite(v))) continue;
      positions[id] = [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100, Math.round(at[2] * 100) / 100];
    }
    if (Object.keys(positions).length === 0) return;
    const name: string = this.sessionLayoutName_derive(this.arrangement);
    const signature: string = placesSignature_compute(positions);
    if (this.putSignatures.get(name) === signature) return;
    this.putSignatures.set(name, signature);
    this.sessionPlaces.set(name, Object.keys(positions).length);
    this.handlers.command_run(`proc layout put ${name} ${arg_quote(JSON.stringify(positions))}`);
  }
}
