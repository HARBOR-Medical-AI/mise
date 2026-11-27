/**
 * @file The orrery itself: one three.js space, composed of the layers.
 *
 * A surface hands in a graph — nodes with identity, parents and joins, a
 * scalar metric, a multiplicity, and a LOOK it has read from its own domain
 * (a state, a named paint, an ember, whether the finish wave passes) — and
 * the orrery lays it out (`layout/`), draws it (`draw/`), and lets it be
 * steered and picked (`controls/`). It knows nothing of what the nodes
 * stand for: a surface says what a node looks like, and gets its own nodes
 * back from every pick.
 *
 * Layout is a strategy seam:
 * - `ranked`: deterministic tiers by graph depth; the same graph always
 *   draws the same picture, the third dimension is presentation.
 * - `molecule`: a d3-force-3d settle, radii scaled by the metric; a surface
 *   that groups its nodes (a hand-off key) settles in a worker it provides.
 *
 * Colours come from the palette the surface hands in, read on every
 * rebuild, so a theme change repaints the space like everything else.
 *
 * The scene composes its parts, each in its own file beside this one: the
 * settle (`settle.ts`), the pulse wave (`wave.ts`), the replay track
 * (`replayTrack.ts`), the grab (`grab.ts`) and the hover tip (`hover.ts`).
 * This file holds the fields, the rebuild and the draw, and the public face
 * a surface mounts.
 *
 * @module
 */
import { edgeSpan_measure, rootsTop_check } from './tree.js';
import * as THREE from 'three';
import { PHYSICS_DEFAULT, type HierarchyArrangement, type PhysicsTerms } from '../layout/index.js';
import {
  STAR_GLOW,
  CensusField,
  HandoffField,
  SphereField,
  StarField,
  TubeField,
  LabelField,
  paint_resolve,
  type Palette,
  type HandoffLook,
  type TubeNode,
  type TubeOwner,
} from '../draw/index.js';
import { CameraRig, PointerGestures, Picker, type PickStar, type PickNebula, type WorldReach } from '../controls/index.js';
import type { NodeLook } from '../types/encoding.js';
import type { SpaceNode } from './node.js';
import {
  SLICE_BUDGET_MS,
  SLICE_MIN_WORK,
  layout_ranked,
  moleculeRadii_computeForSpace,
  moleculeScene_prepare,
  type MoleculeSettle,
  type PlacedNode,
} from './settle.js';
import { bodies_draw, edges_draw, type DrawnBodies, type DrawPorts } from './bodies.js';
import { FlatMolecule } from './flat.js';
import { DrawnNodes, censusNodes_map, handoffLook_build, handoffView_compute, perUnit_compute, tubeNode_build } from './drawn.js';
import { Flights, type Approach, type FlightGraph, type UnfoldPlan } from './flights.js';
import { SceneFrames } from './frames.js';
import type { CensusNode } from '../draw/index.js';
import { HierarchySettle } from './hierarchySettle.js';
import { PulseWave } from './wave.js';
import { ReplayTrack, type ReplayStanding } from './replayTrack.js';
import { GrabSession } from './grab.js';
import { HoverTip } from './hover.js';

export type { SpaceNode } from './node.js';
export type { Approach, UnfoldPlan, Places } from './flights.js';

/**
 * How a space is arranged: a hierarchy round each shape's hub (galaxy,
 * spokes, clumps), constellations round the plugin stars, or a tree of hubs
 * the surface names (hubs), or grown feed by feed as a coral (accretion).
 */
export type SpaceArrangement = HierarchyArrangement | 'constellations' | 'hubs' | 'accretion';

/** The normalized graph the scene renders. */
export interface SpaceGraph<N extends SpaceNode = SpaceNode> {
  nodes: N[];
}

/** The two ways a graph takes shape. */
export type LayoutStrategy = 'ranked' | 'molecule';

/** Callbacks the host wires into picking. */
export interface OrreryHandlers<N extends SpaceNode = SpaceNode> {
  select?: (node: N) => void;
  activate?: (node: N) => void;
  /** A click on empty space cleared the selection. */
  deselect?: () => void;
  /**
   * A two-finger gesture ended: the camera stands where the fingers left
   * it. A host that reads a pinch as a step (out of a feed) asks
   * {@link Orrery.camera_distance} here.
   */
  gesture_end?: () => void;
  /** The words the hover tip shows for a node; null for the node's label. */
  tip?: (node: N) => string | null;
  /**
   * A settle too big for one frame is run in slices, and each slice says
   * how far it has come; `done === total` is the settle's end. A scene
   * given this handler never holds the page for a whole settle.
   */
  progress?: (done: number, total: number, nodes: number) => void;
  /**
   * The feed a node belongs to, for the hand-off: while the scene draws
   * stars, a feed near enough to read turns solid as a whole. No key, or no
   * handler, and a node stays a star.
   */
  handoffKey?: (node: N) => string | null;
  /**
   * A replay moved: its moment (in the arrivals' units) and whether it
   * still plays; called each frame it advances and once when it stops.
   */
  replay?: (at: number, playing: boolean) => void;
}

/** The terms a settle honours: orrery's own, re-exported for the panes. */
export type { PhysicsTerms };
export { PHYSICS_DEFAULT };

/** What a surface hands the orrery beside its graph. */
export interface OrreryOptions {
  /** Ambient mode: slower spin, no picking, no selection ring. */
  ambient?: boolean;
  /**
   * The colours to draw with, asked on every rebuild so a theme change
   * repaints; the default palette when absent.
   */
  palette?: () => Palette;
  /**
   * A worker that settles a grouped space off the page, speaking the
   * layout-worker protocol (`layout/worker` names the engines). The bundle
   * that hosts the page must build it, so the surface makes it; without
   * one, the settle runs on the page.
   */
  layoutWorker?: () => Worker;
}

/**
 * The palette used when a surface hands none in.
 *
 * @returns Warm status colours, a cool root and a cool pulse.
 */
export function palette_default(): Palette {
  return {
    running: new THREE.Color('#ff7700'),
    done: new THREE.Color('#ffeecc'),
    error: new THREE.Color('#ff2222'),
    template: new THREE.Color('#ffaa44'),
    unknown: new THREE.Color('#555555'),
    edge: new THREE.Color('#cc5500'),
    join: new THREE.Color('#ffcc99'),
    root: new THREE.Color('#6fbfae'),
    pulse: new THREE.Color('#48d8f0'),
  };
}

/**
 * How a rebuild settles the graph it draws.
 *
 * - `full`: every node settles (seeded nodes start where they stood).
 * - `new`: nodes that already stood somewhere hold still; only nodes new to
 *   the scene settle among them — a landing adds a molecule without moving
 *   three thousand spheres.
 * - `hold`: nothing settles when every node already stands somewhere (a
 *   census toggle, a palette change, a space re-shown as it was); any new
 *   node settles as under `new`.
 */
export type SettleMode = 'full' | 'new' | 'hold';

/** How the scene draws its nodes: lit spheres, or points of light. */
export type DrawMode = 'spheres' | 'stars';


/** What `graph_set` takes beside the graph. */
export interface GraphSetOptions {
  wave?: boolean;
  fit?: boolean;
  frozen?: ReadonlyArray<string>;
  physics?: Partial<PhysicsTerms>;
  settle?: SettleMode;
}

/**
 * One live DAG rendering bound to a container element.
 */
export class Orrery<N extends SpaceNode = SpaceNode> {
  private readonly container: HTMLElement;
  private readonly handlers: OrreryHandlers<N>;
  private readonly paletteOf: () => Palette;
  private readonly ambient: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group: THREE.Group = new THREE.Group();
  /** What lies under a pointer, among everything drawn. */
  private readonly picker: Picker;
  /** The solid spheres, halos and plain edges. */
  private readonly spheres: SphereField = new SphereField(this.group);
  /** Every drawn sphere and halo, by its node's id: the sphere field's own map. */
  private get meshes(): Map<string, THREE.Mesh> {
    return this.spheres.map;
  }
  /** The field's stars, threads and nebulae. */
  private readonly starField: StarField = new StarField(this.group);
  /** Captions pinned above nodes. */
  private readonly labels: LabelField = new LabelField(this.group);
  /** Every solid molecule's tubes, and the lamps its stages wear. */
  private readonly tubes: TubeField = new TubeField({
    parent: this.group,
    node: (id: string): TubeNode | undefined => this.tubeNode_find(id),
    sphere: (id: string): THREE.Mesh | undefined => this.meshes.get(id),
    palette: (): Palette => this.palette_read(),
  });
  /** Every molecule's place between stars and spheres. */
  private readonly handoffField: HandoffField = new HandoffField({
    spheres: this.spheres,
    stars: this.starField,
    tubes: this.tubes,
    look: (id: string): HandoffLook | undefined => this.handoffLook_find(id),
  });
  /** Every job of every stage, when the scene draws a census. */
  private readonly censusField: CensusField = new CensusField({
    parent: this.group,
    stars: this.starField,
    tubes: this.tubes,
    starsView: () => ({ pixelRatio: window.devicePixelRatio, heightPx: this.renderer.domElement.height, fovDeg: this.camera.fov }),
  });
  /** The drawn nodes looked up by id: where each stands in the world. */
  private readonly drawn: DrawnNodes = new DrawnNodes({
    meshes: (): ReadonlyMap<string, THREE.Mesh> => this.meshes,
    stars: this.starField,
    census: this.censusField,
    group: this.group,
  });
  /** The choreographies a surface asks for as one word each. */
  private readonly flights: Flights<N> = new Flights<N>({
    positions_get: () => this.positions_get(),
    positions_seed: (places) => this.positions_seed(places),
    graph_set: (graph: FlightGraph<N>, options) => this.graph_set(graph, options),
    flyToFit: (ids, durationMs, onDone, bulk, margin) => this.camera_flyToFit(ids, durationMs, onDone, bulk, margin),
    flyToward: (id, distance, durationMs, onDone) => this.camera_flyToward(id, distance, durationMs, onDone),
    alive: (): boolean => !this.disposed,
  });
  /** A named space's settle as a hierarchy, in the surface's worker. */
  private readonly hierarchy: HierarchySettle<N>;
  /** The pulse wave over the drawn nodes. */
  private readonly wave: PulseWave<N>;
  /** The replay of the space's history, when one runs. */
  private readonly replay: ReplayTrack;
  /** A node pulled by the pointer, and the molecule's reaction. */
  private readonly grab: GrabSession;
  /** The hover tip and the pick (pane mode only; a miniature has none). */
  private readonly hover: HoverTip<N> | null = null;
  /**
   * The camera and the world it turns: the focus, the flights, the hold
   * inside a node, the idle spin, and whether the operator has placed the
   * camera since the scene last framed itself.
   */
  private readonly rig: CameraRig;
  /**
   * The pointer's intents on the canvas — the view drag, the fingers, the
   * taps — or null for a miniature, which nobody steers.
   */
  private gestures: PointerGestures | null = null;

  /** Where the last projection left every node — the next settle's seed. */
  private lastPositions: Map<string, THREE.Vector3> = new Map();
  /** Nodes held still through the current settle. */
  private frozen: Set<string> = new Set();
  /** Physics for the current settle alone, over the standing terms. */
  private physicsOnce: Partial<PhysicsTerms> | undefined = undefined;
  /** CENSUS: render every member of every ×N group as an instanced point. */
  private census: boolean = false;
  /** The molecule's physics terms (see PhysicsTerms). */
  private physics: PhysicsTerms = { ...PHYSICS_DEFAULT };
  private graph: SpaceGraph<N> = { nodes: [] };
  /** How nodes are drawn: lit spheres (every pane), or stars (the universe's choice). */
  private drawMode: DrawMode = 'spheres';
  /** Placed nodes by id, for the spheres a solid feed draws. */
  private placedById: Map<string, PlacedNode> = new Map();
  /** Times the scene has framed the graph itself (`camera_fit`). */
  private fits: number = 0;
  private strategy: LayoutStrategy = 'ranked';
  private selectedId: string | null = null;
  private readonly frames: SceneFrames;
  private disposed: boolean = false;
  /** The active projection: the sculpted 3D stage, or the flat schematic. */
  private projection: '3d' | '2d' = '3d';
  /** One molecule laid flat in a standing space (flat.ts); a new graph ends it. */
  private readonly flat: FlatMolecule = new FlatMolecule();
  /** Counts rebuilds, so a sliced settle overtaken by a newer one stops. */
  private rebuildGen: number = 0;
  /** Whether a settle is running in slices, its readout up. */
  private slicing: boolean = false;
  /** How a hierarchy sits molecules around their anchor. */
  private arrangement: SpaceArrangement = 'galaxy';
  /** Where each arrangement's spheres stood, for a return to it. */
  private arrangementMemory: Map<SpaceArrangement, Map<string, THREE.Vector3>> = new Map();

  /**
   * @param container - The element the canvas fills.
   * @param handlers - Picking callbacks (ignored in ambient mode).
   * @param options - Pane vs miniature behavior.
   */
  constructor(container: HTMLElement, handlers: OrreryHandlers<N> = {}, options: OrreryOptions = {}) {
    this.container = container;
    this.handlers = handlers;
    this.paletteOf = options.palette ?? palette_default;
    this.hierarchy = new HierarchySettle<N>(options.layoutWorker, (): number => this.rebuildGen);
    this.ambient = options.ambient === true;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // The renderer sizes its canvas in DEVICE pixels and never writes the
    // CSS size (`setSize(w, h, false)` below); the class pins the canvas to
    // its mount so a HiDPI display cannot spill it sideways — one rule for
    // every mount (a pane, a /bin diagram, the header's cycler), not a
    // per-host stylesheet that a new host forgets.
    this.renderer.domElement.classList.add('dag-scene-canvas');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 0, 14);
    this.rig = new CameraRig(this.camera, this.group);
    this.picker = new Picker(this.camera, this.group, this.renderer.domElement, {
      meshes: (): Iterable<THREE.Object3D> => this.meshes.values(),
      stars: (): Iterable<PickStar> => this.starField.list(),
      nebulae: (): Iterable<PickNebula> => this.starField.nebulae(),
      // A census is picked by its members only while it stands.
      census: () => (this.census && this.censusField.drawn() ? this.censusField : null),
    }, STAR_GLOW);
    this.wave = new PulseWave<N>({
      nodes: (): ReadonlyArray<N> => this.graph.nodes,
      mesh: (id: string): THREE.Mesh | undefined => this.meshes.get(id),
      census: (): CensusField | null => (this.census && this.censusField.drawn() ? this.censusField : null),
      selected: (): string | null => this.selectedId,
      ambient: this.ambient,
    });
    this.replay = new ReplayTrack({
      stars: this.starField,
      redraw: (): void => this.rebuild(false, 'hold'),
      ...(handlers.replay !== undefined ? { moved: handlers.replay } : {}),
    });
    this.grab = new GrabSession({
      picker: this.picker,
      camera: this.camera,
      group: this.group,
      meshes: (): ReadonlyMap<string, THREE.Mesh> => this.meshes,
      nodes: (): ReadonlyArray<N> => this.graph.nodes,
      // Ranked is deterministic truth: a pull peeks at ONE node and the
      // release returns it home. The whole-graph elastic reaction belongs
      // to the molecule — heating it under ranked dissolved the tiers.
      solo: (): boolean => this.strategy === 'ranked',
      dimensions: (): 2 | 3 => (this.projection === '2d' ? 2 : 3),
      spin_pause: (): void => this.rig.spin_pause(),
    });
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key: THREE.DirectionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(4, 6, 8);
    this.scene.add(key);
    this.scene.add(this.group);
    container.appendChild(this.renderer.domElement);
    this.size_fit();
    if (!this.ambient) this.hover = this.pointer_wire(container);
    // The frames and the box's observer: drawn while the box has a size, refitted when it changes.
    this.frames = new SceneFrames(container, { frame_step: (): void => { this.tick(); }, size_fit: (): void => { this.size_fit(); } });
  }

  /**
   * Wires the pointer: the hover tip that names a node, and the gestures
   * that steer the view, grab a node and tap one.
   *
   * @param container - Where the tip lives.
   * @returns The hover tip.
   */
  private pointer_wire(container: HTMLElement): HoverTip<N> {
    const hover: HoverTip<N> = new HoverTip<N>(container, {
      picker: this.picker,
      canvas: this.renderer.domElement,
      nodes: (): ReadonlyArray<N> => this.graph.nodes,
      pressKind: (): string | undefined => this.gestures?.pressKind(),
      fingersDown: (): number => this.gestures?.fingersDown() ?? 0,
      words: (node: N): string | null => this.handlers.tip?.(node) ?? null,
      census: (): boolean => this.census,
      selected_get: (): string | null => this.selectedId,
      selected_set: (id: string | null): void => { this.selectedId = id; },
      selection_paint: (): void => this.selection_paint(),
      ...(this.handlers.select !== undefined ? { select: this.handlers.select } : {}),
      ...(this.handlers.activate !== undefined ? { activate: this.handlers.activate } : {}),
      ...(this.handlers.deselect !== undefined ? { deselect: this.handlers.deselect } : {}),
    });
    this.gestures = new PointerGestures(this.renderer.domElement, this.rig, {
      grab_begin: (event: PointerEvent): boolean => this.grab.begin(event),
      grab_move: (event: PointerEvent): void => { if (this.grab.move(event)) this.positions_sync(); },
      grab_end: (): boolean => this.grab.end(),
      hover: (event: PointerEvent): void => hover.hover(event),
      leave: (event: PointerEvent): void => hover.leave(event),
      tap: (event: MouseEvent, kind: 'select' | 'activate'): void => hover.pick(event, kind),
      tip_hide: (): void => hover.hide(),
      gesture_end: (): void => this.handlers.gesture_end?.(),
    }, {
      flat: (): boolean => this.projection === '2d',
      // Census is a place: the camera parks off the focus.
      untethered: (): boolean => this.census,
    });
    return hover;
  }

  /** One frame: the motions stepped, the scene rendered. The next is asked for by {@link SceneFrames}. */
  private tick(): void {
    if (this.disposed) return;
    if (this.ambient) {
      this.rig.tumble_step();
      this.wave.animate();
    } else {
      // A touched graph holds still; the idle spin resumes after the wait.
      // A flight or a stay inside a node holds it unconditionally.
      this.rig.spin_step(!(this.gestures?.pointerOver() ?? false) && this.projection === '3d' && !this.flat.active());
      if (this.grab.step()) this.positions_sync();
      this.wave.animate();
      this.rig.flight_step();
    }
    this.starField.scale_update(this.renderer.domElement.height, this.camera.fov);
    this.handoff_step();
    this.replay.step();
    const now: number = performance.now();
    this.tubes.frame(now);
    this.starField.frame(now);
    this.labels.declutter(this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  /** Sets physics terms and re-settles (warm-started, so it morphs). */
  public physics_set(terms: Partial<PhysicsTerms>, resettle: boolean = true): void {
    this.physics = { ...this.physics, ...terms };
    // A caller about to set a new graph anyway changes the terms without
    // settling the old one first: the first paint of a space used to
    // settle three thousand spheres twice.
    if (resettle) this.rebuild();
  }

  public physics_get(): PhysicsTerms {
    return { ...this.physics };
  }

  /**
   * Toggles the census projection: the full multiplicity of the graph as
   * instanced members on analytic shells (spectacle), versus the semantic
   * shape (work). Selection belongs to shape; census draws, never picks.
   *
   * @param on - Whether census is active.
   */
  public census_set(on: boolean): void {
    if (this.census === on) return;
    this.census = on;
    // The census shells what stands; it moves nothing.
    this.rebuild(true, 'hold');
  }

  public census_get(): boolean {
    return this.census;
  }

  /**
   * Replaces the rendered graph. Layout runs under the current strategy.
   *
   * @param graph - The normalized graph.
   */
  public graph_set(graph: SpaceGraph<N>, options: GraphSetOptions = {}): void {
    this.graph = graph;
    this.flat.clear();
    // Nodes to hold still through this settle, and physics for it alone:
    // a descent settles one feed while the field around it stands, with
    // no gravity — gravity pulls to the origin, and a feed unfolding far
    // from it would stream there instead of opening where it stood.
    this.frozen = new Set(options.frozen ?? []);
    this.physicsOnce = options.physics;
    // A graph arriving under a flight keeps the camera where the flight
    // put it (`fit: false`); every other arrival is framed whole.
    this.rebuild(options.fit !== false, options.settle ?? 'full');
    // An ARRIVING graph gets one wave; a local re-projection (a scale or
    // layout flip) must not fire one — an unasked pulse reads as a glitch.
    if (options.wave !== false) this.wave.start();
  }

  /** Sets continuous wave looping; enabling fires a wave immediately. */
  public waveLoop_set(on: boolean): void {
    this.wave.loop_set(on);
  }

  /** @returns Whether the wave is looping. */
  public waveLoop_get(): boolean {
    return this.wave.loop_get();
  }

  /**
   * Starts the pulse wave: nodes flare in dependency order, a join waiting
   * for its last parent. History-honest — only nodes that actually executed
   * (terminal success or error, or an authored template node) fire, so on a
   * running feed the wave halts at the execution frontier.
   */
  public wave_start(): void {
    this.wave.start();
  }

  /**
   * Where every node settled last, by id, for a caller that remembers.
   *
   * @returns Rounded positions, node id to [x, y, z].
   */
  public positions_get(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const [id, position] of this.lastPositions) {
      out[id] = [Math.round(position.x * 100) / 100, Math.round(position.y * 100) / 100, Math.round(position.z * 100) / 100];
    }
    return out;
  }

  /**
   * Seeds the next settle from remembered positions: a node that was here
   * before starts where it stood, a new one starts fresh. Takes effect on
   * the next `graph_set`.
   *
   * @param positions - Node id to [x, y, z].
   */
  public positions_seed(positions: Record<string, [number, number, number]>): void {
    this.lastPositions = new Map(
      Object.entries(positions).map(([id, [x, y, z]]): [string, THREE.Vector3] => [id, new THREE.Vector3(x, y, z)]),
    );
  }

  /**
   * Flies the camera into a node: a dolly toward the sphere until it fills
   * the frame. The idle spin holds for the whole stay; `flight_back` reverses.
   *
   * @param nodeId - The node to fly into.
   * @param onArrived - Called once the camera is inside the node.
   */
  public flight_into(nodeId: string, onArrived: () => void): void {
    if (this.rig.flying() || this.rig.holding_get()) return;
    // The dive leaves the graph exactly as the operator has it — no reset snap.
    const target: THREE.Vector3 | null = this.drawn.diveTarget_find(nodeId);
    if (target !== null) this.rig.flyInto(target, onArrived);
  }

  /**
   * Flies the camera to frame a set of nodes: the fit `camera_fit` would
   * give those nodes alone, reached by a flight from where the camera
   * stands rather than a cut. A descent into one feed frames that feed;
   * the climb back frames everything. Never holds: picking goes on.
   *
   * @param ids - The nodes to frame; every drawn node when empty.
   * @param durationMs - The flight's length.
   * @param onDone - Called when the camera arrives.
   * @param bulk - The share of the nodes the frame must hold, 0..1: at 1
   *   every outlier is inside the frame; at 0.85 the farthest few spill,
   *   and the bulk is close enough to touch. A large feed's settle throws
   *   a few nodes far out, and a frame that held them all put the feed at
   *   the centre as a starburst of two-pixel spheres nobody could click.
   */
  public camera_flyToFit(ids: ReadonlyArray<string>, durationMs: number, onDone: () => void, bulk: number = 1, margin: number = 1.15): void {
    this.rig.flyToFit(this.drawn.reaches_list(ids), durationMs, onDone, bulk, margin);
  }

  /**
   * How far the camera stands from what it looks at.
   *
   * @returns The distance from the eye to the focus, in scene units.
   */
  public camera_distance(): number {
    return this.rig.eyeDistance();
  }

  /**
   * Whether the operator has placed the camera since the scene last framed
   * the graph: a wheel or a drag. A repaint of the same space keeps a
   * placed camera; a fresh space is framed whole.
   *
   * @returns True once the operator has wheeled or dragged since the last fit.
   */
  public camera_touched(): boolean {
    return this.rig.touched_get();
  }

  /** @returns Whether a flight the surface asked for is under way (see `flights.ts`); a dive into a node is a hold, not a flight. */
  public moving(): boolean {
    return this.flights.moving();
  }

  /** Frames nodes, the scene moving until the camera arrives (see `Flights.frame`). */
  public frame(ids: ReadonlyArray<string>, durationMs: number, onDone: () => void = (): void => {}, bulk?: number, margin?: number): void {
    this.flights.frame(ids, durationMs, onDone, bulk, margin);
  }

  /** Lights a graph where everything stands and frames part of it (see `Flights.relight`). */
  public relight(graph: SpaceGraph<N>, frame: ReadonlyArray<string>, durationMs: number, onDone: () => void = (): void => {}, drawn?: () => void): void {
    this.flights.relight(graph, frame, durationMs, onDone, drawn);
  }

  /** Unfolds a graph from where other nodes stood, then frames it (see {@link UnfoldPlan}). */
  public unfold(plan: UnfoldPlan<N>, onDone: () => void = (): void => {}): void {
    this.flights.unfold(plan, onDone);
  }

  /** Descends: approach, ask, unfold, frame (see `Flights.descent`). */
  public descent(approach: Approach, ask: () => Promise<UnfoldPlan<N> | null>, onDone: () => void = (): void => {}, onRefused: () => void = (): void => {}): void {
    this.flights.descent(approach, ask, onDone, onRefused);
  }

  /**
   * Draws the nodes as lit spheres or as stars. Moves nothing: the scene
   * is redrawn where it stands, the camera where the operator put it.
   *
   * @param mode - The draw mode.
   */
  public draw_set(mode: DrawMode): void {
    if (mode === this.drawMode) return;
    this.drawMode = mode;
    this.rebuild(false, 'hold');
  }

  /**
   * Shows or hides the nodes' captions; nothing is redrawn.
   *
   * @param on - Shown.
   */
  public captions_set(on: boolean): void {
    this.labels.shown_set(on);
  }

  /** @returns How nodes are drawn. */
  public draw_get(): DrawMode {
    return this.drawMode;
  }

  /**
   * What the scene holds, for a surface asked to say so: how it draws,
   * how many nodes are solid spheres and how many stars, which of the
   * graph's solid-marked nodes are drawn solid, and the hand-off's state.
   *
   * @returns A plain summary.
   */
  public state_get(): Record<string, unknown> {
    const solidMarked: string[] = this.graph.nodes.filter((node: N): boolean => node.solid === true).map((node: N): string => node.id);
    const solidDrawn: number = solidMarked.filter((id: string): boolean => this.meshes.has(id)).length;
    return {
      draw: this.drawMode,
      arrangement: this.arrangement,
      captions: this.labels.shown_get() ? this.labels.count() : 'off',
      // How many nodes the scene knows a place for: what a hold can hold.
      known: this.lastPositions.size,
      census: this.census,
      nodes: this.graph.nodes.length,
      meshes: this.meshes.size,
      stars: this.starField.count(),
      solidMarked: solidMarked.length,
      solidDrawn,
      tubes: this.tubes.materialCount(),
      censusTubes: this.tubes.censusCount(),
      censusLines: this.tubes.censusLineCount(),
      // How many jobs the census shells: every one, when it stands.
      censusMembers: this.census ? this.censusField.ids().length : 0,
      handoffGroups: this.handoffField.size(),
      handoffSolid: this.handoffField.solidCount(),
      camera: this.rig.eyeDistance().toFixed(1),
      settling: this.slicing,
      ...edgeSpan_measure(this.graph.nodes, this.lastPositions),
    };
  }

  /**
   * Flies the camera toward one node, along the line it already looks
   * down, to a distance where its neighbourhood fills the view: the zoom
   * into the star the operator clicked, not a framing of all it belongs to.
   *
   * @param id - The node.
   * @param distance - How far from it to stop, in scene units.
   * @param durationMs - The flight's length.
   * @param onDone - Called on arrival (at once when the node is not drawn).
   */
  public camera_flyToward(id: string, distance: number, durationMs: number, onDone: () => void): void {
    const drawn: WorldReach | null = this.drawn.world_find(id);
    if (drawn === null) {
      onDone();
      return;
    }
    this.rig.flyToward(drawn, distance, durationMs, onDone);
  }

  /**
   * Whether the camera is parked inside a node.
   *
   * The fly-in dollies to just shy of a node's surface, so while this is
   * true the pane is filled by the inside of one sphere. Anything that can
   * leave an operator there without an overlay on top has to be able to ask
   * this and fly them back.
   *
   * @returns True while the camera is held inside a node.
   */
  public holding_get(): boolean {
    return this.rig.holding_get();
  }

  /**
   * Flies the camera back out to its pre-dive stance and releases the hold.
   *
   * @param onDone - Called once the camera is home.
   */
  public flight_back(onDone: () => void): void {
    this.rig.flyBack(onDone);
  }

  /**
   * Switches the layout strategy and re-lays the current graph.
   *
   * @param strategy - Ranked tiers or the force-settled molecule.
   */
  public strategy_set(strategy: LayoutStrategy): void {
    this.strategy = strategy;
    this.rebuild();
  }

  /** Clears the node selection (a new graph owes nothing to the old one). */
  public selection_clear(): void {
    this.selectedId = null;
    this.selection_paint();
  }

  /**
   * Selects a node by id, as a press on it would: lit, and named through
   * the `select` handler. For a surface that lands on a node it was asked
   * for (a jump), not one the operator pressed.
   *
   * @param id - The node's id.
   * @returns Whether the graph holds that node.
   */
  public selection_set(id: string): boolean {
    const node: N | undefined = this.graph.nodes.find((candidate: N): boolean => candidate.id === id);
    if (node === undefined) return false;
    this.selectedId = id;
    this.selection_paint();
    this.handlers.select?.(node);
    return true;
  }

  /**
   * Lights the selected sphere and dims the rest, touching materials only.
   * Selection used to rebuild the scene: every click re-ran the settle of
   * every node (seconds, on three thousand) and refitted the camera to
   * the whole graph, so a click on a sphere the operator had dollied up
   * to threw them back out to the whole space before anything else
   * happened, and a double click could never land. A selection is paint.
   */
  private selection_paint(): void {
    this.spheres.select(this.selectedId);
  }

  /** @returns The active layout strategy. */
  public strategy_get(): LayoutStrategy {
    return this.strategy;
  }

  /**
   * Switches projection. 2D is the schematic reading: the layout flattens
   * to the plane, the view squares up face-on, the idle spin rests, and an
   * empty-space drag pans (there is no depth to orbit). 3D restores the
   * sculpted stage.
   *
   * @param projection - The projection to show.
   */
  public projection_set(projection: '3d' | '2d'): void {
    this.projection = projection;
    if (projection === '2d') {
      this.group.quaternion.identity();
    }
    this.rebuild();
  }

  /** @returns The active projection. */
  public projection_get(): '3d' | '2d' {
    return this.projection;
  }

  /** Lays some nodes flat facing the eye (a spin would turn them edge-on, so it rests), the rest standing; null stands them back up. */
  public flat_set(ids: ReadonlyArray<string> | null): void {
    if (this.flat.set(ids, this.graph.nodes, this.lastPositions, { camera: this.camera, focus: this.rig.focus, world: this.group }, this.physics)) this.rebuild(false, 'hold');
  }
  /** @returns Whether a subset lies flat. */
  public flat_get(): boolean { return this.flat.active(); }

  /**
   * Updates one node's look in place (its state changed on the progress
   * channel) without re-laying the graph.
   *
   * @param nodeId - The node.
   * @param look - How it looks now.
   */
  public look_update(nodeId: string, look: NodeLook): void {
    const node: N | undefined = this.graph.nodes.find((n: N) => n.id === nodeId);
    if (!node) return;
    node.look = look;
    this.spheres.recolor(nodeId, paint_resolve(look.paint, this.palette_read()));
    // A stage that started or finished changes what its tubes carry: a
    // stream, a replay, or nothing.
    if (this.tubes.holds(nodeId)) this.tubes.stale_mark();
  }

  /** @returns The colours to draw with now. */
  private palette_read(): Palette {
    return this.paletteOf();
  }

  /** Re-reads the palette (the THEME pill changed) and repaints. */
  public palette_refresh(): void {
    this.rebuild(true, 'hold');
  }

  /** Fits the renderer to the container's current box. */
  public size_fit(): void {
    const width: number = Math.max(1, this.container.clientWidth);
    const height: number = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Tears the scene down and releases the GL context. */
  public dispose(): void {
    this.disposed = true;
    this.hierarchy.dispose();
    this.frames.frames_dispose();
    this.gestures?.detach();
    this.hover?.tip_dispose();
    // What the last draw made is let go with the scene: geometries, materials and textures.
    this.group.clear();
    this.spheres.clear();
    this.censusField.clear();
    this.starField.clear();
    this.labels.clear();
    this.tubes.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.spheres.dispose();
  }

  /**
   * Arranges molecules as clumps or spokes. The space is laid out afresh:
   * a remembered shape would keep the old arrangement.
   *
   * @param arrangement - The arrangement: a registered engine's name.
   * @param remembered - Where its spheres stood, from a host's memory.
   * @param redraw - Redraw at once; false when the host is about to hand
   *   in the graph the arrangement needs (constellations bring their stars).
   */
  public arrangement_set(arrangement: SpaceArrangement, remembered?: Record<string, [number, number, number]>, redraw: boolean = true): void {
    if (arrangement === this.arrangement) return;
    // Each arrangement keeps where its spheres stood: going back to one
    // already seen redraws it, and only a first visit pays its settle.
    this.arrangementMemory.set(this.arrangement, new Map(this.lastPositions));
    this.arrangement = arrangement;
    let kept: Map<string, THREE.Vector3> | undefined = this.arrangementMemory.get(arrangement);
    if (kept === undefined && remembered !== undefined && Object.keys(remembered).length > 0) {
      kept = new Map(Object.entries(remembered).map(([id, [x, y, z]]): [string, THREE.Vector3] => [id, new THREE.Vector3(x, y, z)]));
    }
    this.lastPositions = kept ?? new Map();
    if (redraw) this.rebuild(true, kept === undefined ? 'full' : 'hold');
  }

  /** @returns How a hierarchy sits molecules round their hubs. */
  public arrangement_get(): SpaceArrangement {
    return this.arrangement;
  }

  /**
   * Plays the space's history: every node with an arrival hidden until it
   * arrives, then shown with a flash, at its final place, the camera
   * untouched. Nodes without one stand throughout. Nothing turns solid
   * while it plays; stars only.
   *
   * @param arrivals - When each node arrived (epoch ms for dates).
   * @param speed - 1 crosses the whole history in {@link REPLAY_WALL_MS}.
   */
  public replay_begin(arrivals: ReadonlyMap<string, number>, speed: number = 1): void {
    this.replay.begin(arrivals, speed);
  }

  /**
   * Plays on (or again from the start, at the end).
   *
   * @param speed - A new speed, or the one it had.
   */
  public replay_play(speed?: number): void {
    this.replay.play(speed);
  }

  /** Holds the replay where it is. */
  public replay_pause(): void {
    this.replay.pause();
  }

  /**
   * Moves the replay to a moment: what had arrived by then shown, the rest hidden.
   *
   * @param at - The moment, in the arrivals' units.
   */
  public replay_seek(at: number): void {
    this.replay.seek(at);
  }

  /** Ends the replay: the space redrawn whole, the hand-off back. */
  public replay_stop(): void {
    this.replay.stop();
  }

  /**
   * Where the replay stands, or null when none runs.
   *
   * @returns Whether it plays, its moment, and its span.
   */
  public replay_state(): ReplayStanding | null {
    return this.replay.state();
  }

  /**
   * Builds the census: one instanced member per collapsed count, on a
   * fibonacci shell around its group's anchor; equal-count parent/child
   * groups pair members by index, so chains of ×N groups render as
   * branched filaments over the shell — the cell-surface reading.
   */
  private censusBuild(placed: PlacedNode[], palette: Palette, fit: boolean = true): void {
    const nodes: CensusNode[] = censusNodes_map(placed, palette);
    const cloud = this.censusField.build(nodes, this.drawMode === 'stars', palette);
    // How many jobs the census shells, on the canvas: a smoke reads it to
    // prove CENSUS draws every job, not the shape.
    this.renderer.domElement.dataset['census'] = String(this.censusField.ids().length);
    const center: THREE.Vector3 = cloud.center;
    const cloudRadius: number = cloud.radius;

    // The census parks the camera only when a framing was asked for: a
    // descent redraws under a camera the flight has placed, and re-parking
    // it there was the view resetting under every click.
    if (!this.ambient && fit) {
      // A census cloud grown from near-planar anchors reads edge-on from
      // the axis; open on a three-quarter orbit so the shells read as
      // volume from the first frame.
      this.rig.frame(center, cloudRadius, { stance: 'threeQuarter', farScale: 2.5 });
    }
  }

  /**
   * Fits the camera to the placed graph: distance from the bounding sphere
   * so a sprawling molecule (or a wide 2D settle) sits inside the frustum
   * instead of clipping through the near plane as black voids — or leaving
   * the view entirely.
   */
  private camera_fit(placed: PlacedNode[]): void {
    if (placed.length === 0) return;
    this.rig.touch_clear();
    // How many times the scene has framed the graph itself, on the canvas:
    // a smoke reads it to prove a click did not refit a placed camera.
    this.fits += 1;
    this.renderer.domElement.dataset['fits'] = String(this.fits);
    const center: THREE.Vector3 = new THREE.Vector3();
    for (const item of placed) center.add(item.position);
    center.divideScalar(placed.length);
    // A space of molecules (a host that names them) is framed by its bulk:
    // a few bodies flung far out would otherwise shrink the galaxies to a
    // speck. A single graph is framed whole.
    const reaches: number[] = placed.map((item: PlacedNode): number => center.distanceTo(item.position) + item.radius).sort((a: number, b: number): number => a - b);
    const share: number = this.handlers.handoffKey !== undefined ? 0.95 : 1;
    const radius: number = Math.max(1, reaches[Math.max(0, Math.ceil(reaches.length * share) - 1)] ?? 1);
    // The far plane always clears the framed graph: a fixed 200 clipped
    // sprawling molecules into black voids (and swallowed 2D whole).
    this.rig.frame(center, radius);
  }

  /**
   * Rebuilds meshes and edges from the current graph and strategy.
   *
   * @param fit - Frame the result.
   * @param mode - How the graph settles; see {@link SettleMode}.
   */
  private rebuild(fit: boolean = true, mode: SettleMode = 'full'): void {
    const generation: number = ++this.rebuildGen;
    // A settle in slices overtaken by this rebuild ends here: its readout
    // closes, or a quick rebuild after it would leave the bar standing at
    // whatever it last said.
    if (this.slicing) {
      this.slicing = false;
      this.handlers.progress?.(1, 1, 0);
    }
    if (this.strategy !== 'molecule') {
      this.draw(layout_ranked(this.graph.nodes), fit);
      return;
    }
    let frozen: ReadonlySet<string> = this.frozen;
    if (mode !== 'full' && frozen.size === 0) {
      const standing: string[] = this.graph.nodes.map((node: N): string => node.id).filter((id: string): boolean => this.lastPositions.has(id));
      if (standing.length > 0) frozen = new Set(standing);
    }
    const settle: MoleculeSettle = moleculeScene_prepare(
      this.graph.nodes,
      this.projection === '2d' ? 2 : 3,
      this.lastPositions,
      this.physics_current(),
      frozen,
    );
    // Nothing to move (a repaint under `hold` or `new` with every node
    // standing: a plugin lit, a palette changed): draw where they stand.
    // Any engine would only spend its ticks on bodies that cannot move.
    if (settle.moving === 0) {
      this.draw(settle.place(), fit);
      return;
    }
    const progress = this.handlers.progress;
    // The work is the ticks times the nodes that move: a descent settles a
    // handful among thousands and must land in the same call, since the
    // flight that follows reads the meshes it draws.
    const small: boolean = settle.total * settle.moving < SLICE_MIN_WORK;
    // A host that names its molecules (the universe) settles a big space
    // as a hierarchy in a worker: molecules alone, then molecules as bodies.
    // SPOKES and CLUMPS exist only there, at any size; a small galaxy
    // settles on the page as it always has.
    if ((!small || this.arrangement !== 'galaxy') && progress !== undefined && this.handlers.handoffKey !== undefined && this.frozen.size === 0) {
      this.hierarchy_run(generation, fit, frozen, progress);
      return;
    }
    if (progress === undefined || small) {
      settle.step(settle.total);
      this.draw(settle.place(), fit);
      return;
    }
    this.settle_slice(settle, generation, fit, progress);
  }

  /** @returns The physics of this settle: the standing terms, with the once-only ones over them. */
  private physics_current(): PhysicsTerms {
    return this.physicsOnce !== undefined ? { ...this.physics, ...this.physicsOnce } : this.physics;
  }

  /**
   * Runs a settle too big for one frame in slices: the page keeps drawing
   * the scene that stands, the operator sees a bar move, and the new scene
   * replaces it at the end. A newer rebuild overtaking it ends it.
   */
  private settle_slice(settle: MoleculeSettle, generation: number, fit: boolean, progress: (done: number, total: number, nodes: number) => void): void {
    const nodes: number = this.graph.nodes.length;
    let done: number = 0;
    this.slicing = true;
    progress(0, settle.total, nodes);
    const slice = (): void => {
      if (generation !== this.rebuildGen || this.disposed) return;
      const started: number = performance.now();
      while (done < settle.total && performance.now() - started < SLICE_BUDGET_MS) {
        settle.step(1);
        done += 1;
      }
      if (done < settle.total) {
        progress(done, settle.total, nodes);
        window.requestAnimationFrame(slice);
        return;
      }
      this.slicing = false;
      this.draw(settle.place(), fit);
      progress(settle.total, settle.total, nodes);
    };
    window.requestAnimationFrame(slice);
  }

  /**
   * Settles the graph as a hierarchy in the worker, reporting progress, and
   * draws the answer if no newer rebuild has overtaken it.
   */
  private hierarchy_run(generation: number, fit: boolean, frozen: ReadonlySet<string>, progress: (done: number, total: number, nodes: number) => void): void {
    const keyOf = this.handlers.handoffKey;
    if (keyOf === undefined) return;
    this.slicing = true;
    this.hierarchy.run({
      generation,
      nodes: this.graph.nodes,
      keyOf,
      seeds: this.lastPositions,
      frozen,
      physics: this.physics_current(),
      arrangement: this.arrangement,
      progress: (done: number, total: number, nodes: number): void => {
        // The settle's end, landed or failed, takes the readout down.
        if (done === total) this.slicing = false;
        progress(done, total, nodes);
      },
      placed: (placed: PlacedNode[]): void => {
        this.slicing = false;
        this.draw(placed, fit);
      },
    });
  }

  /** Draws placed nodes as the scene: meshes, edges, census, the frame. */
  private draw(placed: PlacedNode[], fit: boolean): void {
    const palette: Palette = this.drawn_clear(placed);
    if (this.census) {
      // The census shells every job but the feed the operator is at: an
      // entered feed stays solid spheres in its tubes, whatever the density.
      const solidOnes: PlacedNode[] = placed.filter((item: PlacedNode): boolean => item.node.solid === true && item.node.ghost !== true);
      this.censusBuild(placed.filter((item: PlacedNode): boolean => item.node.solid !== true), palette, fit);
      if (solidOnes.length > 0) this.solid_draw(solidOnes, palette);
      return;
    }
    if (!this.ambient && fit) this.camera_fit(placed);
    // Stars: every node but a solid one is a point of light, a halo a
    // nebula; they are drawn in batches after the bodies.
    const starring: boolean = this.drawMode === 'stars';
    // A replay shows every node as a star: nothing turns solid under it.
    const handoffKey = starring && !this.replay.active() ? this.handlers.handoffKey : undefined;
    const ports: DrawPorts = {
      spheres: this.spheres,
      labels: this.labels,
      stars: this.starField,
      handoff: this.handoffField,
      selected: this.selectedId,
      flat: this.projection === '2d',
      starring,
      // A placed node is one of the graph's own: the surface's node, typed wide.
      handoffKey: handoffKey as ((node: SpaceNode) => string | null) | undefined,
    };
    const bodies: DrawnBodies = bodies_draw(placed, palette, ports);
    if (bodies.starred.length > 0) this.starField.draw(bodies.starred, window.devicePixelRatio, this.renderer.domElement.height, this.camera.fov);
    for (const item of placed) this.placedById.set(item.node.id, item);
    if (handoffKey !== undefined) {
      const byNode: Map<string, N> = new Map(this.graph.nodes.map((node: N): [string, N] => [node.id, node]));
      this.handoffField.gather(bodies.starred, (id: string): string | null => {
        const node: N | undefined = byNode.get(id);
        return node === undefined ? null : handoffKey(node);
      });
    }
    edges_draw(placed, bodies.byId, palette, ports);
    // Solid spheres are joined by tubes: under stars, the nodes marked solid
    // (a feed the operator entered); drawn as spheres, every node not dimmed
    // — the DAG pane's graph and the universe's SPHERES alike. Dimmed
    // scenery keeps its faint lines.
    const solidIds: string[] = placed
      .filter((item: PlacedNode): boolean => item.node.ghost !== true && item.node.halo !== true && (starring ? item.node.solid === true || item.node.tubed === true : item.node.dim !== true))
      .map((item: PlacedNode): string => item.node.id);
    if (solidIds.length > 0) {
      // Under stars a graph tubed but not solid (a feed drawn as points of
      // light) is threaded finely; solid spheres keep their full tubes.
      const solidAmong: boolean = !starring || placed.some((item: PlacedNode): boolean => item.node.solid === true && solidIds.includes(item.node.id));
      const entered: TubeOwner = { tubes: null, mix: 1, ...(solidAmong ? {} : { thickness: 0.25 }) };
      this.tubes.build(entered, solidIds, new Set(solidIds));
    }
    // A readout a smoke can read, beside the fit count: whether what is
    // lit stands as a tree with its roots on top (a feed opened as its tree).
    this.renderer.domElement.dataset['rootsTop'] = rootsTop_check(placed.filter((item: PlacedNode): boolean => item.node.dim !== true && item.node.ghost !== true && item.node.halo !== true).map((item: PlacedNode) => ({ id: item.node.id, parentIds: item.node.parentIds, y: item.position.y }))) ? 'yes' : 'no';
    // A redraw during a replay keeps what has not arrived hidden.
    if (this.replay.active()) this.replay.paintAll();
  }

  /**
   * Clears everything drawn and remembers where the new placement stands.
   *
   * @param placed - The nodes about to be drawn.
   * @returns The palette this draw paints with.
   */
  private drawn_clear(placed: PlacedNode[]): Palette {
    this.group.clear();
    this.spheres.clear();
    this.censusField.clear();
    this.renderer.domElement.dataset['census'] = '0';
    this.grab.clear();
    this.starField.clear();
    this.labels.clear();
    this.handoffField.clear();
    this.placedById = new Map();
    this.tubes.clear();
    const palette: Palette = this.palette_read();
    this.wave.color = palette.pulse;
    this.lastPositions = new Map(placed.map((p: PlacedNode): [string, THREE.Vector3] => [p.node.id, p.position.clone()]));
    if (this.projection === '2d') {
      // The molecule already settled in-plane; ranked drops only its
      // parallax hash — its layout was two-dimensional by construction.
      for (const item of placed) item.position.z = 0;
    }
    return palette;
  }

  /**
   * Steps the hand-off once a frame: a feed whose largest sphere spans
   * more than a few pixels turns solid, crossfading, its threads rising
   * to edges; one that shrinks back goes to stars and its spheres are let go.
   */
  private handoff_step(): void {
    if (this.handoffField.size() === 0) return;
    const height: number = this.renderer.domElement.clientHeight || 1;
    this.handoffField.step(handoffView_compute(this.camera, this.group), perUnit_compute(height, this.camera.fov), performance.now());
  }

  /** @returns How a placed node's sphere is drawn when its molecule turns solid. */
  private handoffLook_find(id: string): HandoffLook | undefined {
    const placed: PlacedNode | undefined = this.placedById.get(id);
    return placed === undefined ? undefined : handoffLook_build(placed, this.palette_read());
  }

  /** @returns A placed node as the tubes read it. */
  private tubeNode_find(id: string): TubeNode | undefined {
    const placed: PlacedNode | undefined = this.placedById.get(id);
    return placed === undefined ? undefined : tubeNode_build(placed);
  }

  /** Copies simulation positions onto meshes and re-anchors every edge. */
  private positions_sync(): void {
    for (const { id, position } of this.grab.positions()) {
      this.meshes.get(id)?.position.set(...position);
      // Where a pulled node comes to rest is where it stands: a later
      // redraw starts from here instead of snapping it back.
      this.lastPositions.set(id, new THREE.Vector3(...position));
    }
    this.tubes.follow();
    this.spheres.edges_follow();
  }

  /**
   * Draws nodes as lit spheres joined by tubes, among a census: the feed the
   * operator entered, which the census's points would otherwise swallow.
   *
   * @param solidOnes - The nodes to draw solid.
   * @param palette - The palette.
   */
  private solid_draw(solidOnes: ReadonlyArray<PlacedNode>, palette: Palette): void {
    for (const item of solidOnes) {
      this.placedById.set(item.node.id, item);
      this.spheres.sphere_add(item.node.id, item.position, item.radius, { color: paint_resolve(item.node.look.paint, palette) });
    }
    const ids: string[] = solidOnes.map((item: PlacedNode): string => item.node.id);
    const entered: TubeOwner = { tubes: null, mix: 1 };
    this.tubes.build(entered, ids, new Set(ids));
  }
}
