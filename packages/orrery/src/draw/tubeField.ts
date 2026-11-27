/**
 * @file The tubes of every solid molecule, and the lamps its stages wear.
 *
 * A tube joins two solid spheres and carries a pulse from parent to child:
 * into a live stage it streams, and the stage blinks with each pulse that
 * lands; into a finished one it replays the run stage by stage in the order
 * the stages ran, each stage dark until its pulse lands, flaring then and
 * staying lit, the lot dimming before the next replay. A tube into a failed
 * stage is red. A tube follows its spheres when one is pulled, and re-reads
 * the states it carries when a stage starts or finishes.
 *
 * @module
 */
import * as THREE from 'three';
import type { NodeState } from '../types/encoding.js';
import { LAMP_BLOOM_MS, LAMP_BLOOM_REACH, LAMP_DIM, LAMP_FADE_MS, LAMP_WHITE } from './lamps.js';
import { nebulaTexture_get } from './nebula.js';
import type { Palette } from './palette.js';
import { Made, drawn_release } from './release.js';
import { PULSE_TRIP_MS, REPLAY_REST_MS, WAVE_STEP_MS } from './timing.js';
import { TUBE_FRAGMENT, TUBE_VERTEX, tubeGeometry_get, tubeMesh_make, lineMesh_make, type LineRest, type TubeSpec } from './tubes.js';

/**
 * One node as the tubes read it.
 *
 * @property position - Where it stands.
 * @property radius - Its sphere's radius.
 * @property parents - The nodes it hangs from.
 * @property joins - The nodes it joins from another branch.
 * @property state - What it is doing.
 */
export interface TubeNode {
  position: THREE.Vector3;
  radius: number;
  parents: ReadonlyArray<string>;
  joins: ReadonlyArray<string>;
  state: NodeState;
}

/**
 * What holds a set of tubes: the field sets `tubes` to the mesh it draws
 * for it, and draws them at the owner's `mix` (a molecule fading in).
 */
export interface TubeOwner {
  tubes: THREE.InstancedMesh | null;
  mix: number;
  /**
   * The tubes' width against a sphere's: 1 joins lit spheres; a graph drawn
   * as points of light (stars, still tubed) takes a fine thread, or the
   * tubes read as bare sticks with the nodes lost at their ends.
   */
  thickness?: number;
}

/** What the field needs to know of the scene it draws in. */
export interface TubeFieldHost {
  /** Where the tubes are drawn. */
  parent: THREE.Object3D;
  /** A node as the tubes read it, now. */
  node(id: string): TubeNode | undefined;
  /** A stage's sphere, for its lamp; undefined when it is not drawn solid. */
  sphere(id: string): THREE.Mesh | undefined;
  /** The colours, now. */
  palette(): Palette;
}

/** One set of tubes: a molecule's, as built, with what it was built from. */
interface TubeSet {
  mesh: THREE.InstancedMesh;
  edges: Array<{ from: string; to: string; width: number }>;
  lamps: Map<string, number>;
  blinks: Set<string>;
  owner: TubeOwner;
  entries: ReadonlyArray<string>;
  members: ReadonlySet<string>;
}

/**
 * A tube's pulse, by the state of the stage it runs into: it streams into a
 * stage at work (1), replays into one that has run (2), rests otherwise (0).
 *
 * @param state - The stage's state.
 * @returns The tube shader's mode.
 */
export function tubeMode_derive(state: NodeState): number {
  if (state === 'live') return 1;
  if (state === 'done' || state === 'failed') return 2;
  return 0;
}

/**
 * The tubes of every solid molecule in a scene, and their lamps.
 */
export class TubeField {
  private readonly host: TubeFieldHost;
  /** What this field drew, let go together at a redraw. */
  private readonly made: Made = new Made();
  private sets: TubeSet[] = [];
  private materials: THREE.ShaderMaterial[] = [];
  private glows: Map<string, THREE.Sprite> = new Map();
  private stale: boolean = false;
  private census: number = 0;
  private censusLines: number = 0;

  /**
   * @param host - The scene the field draws in.
   */
  constructor(host: TubeFieldHost) {
    this.host = host;
  }

  /** How many tube materials are live (one per set and one for a census). */
  public materialCount(): number {
    return this.materials.length;
  }

  /** How many job-to-job tubes the census drew; 0 when it drew lines. */
  public censusCount(): number {
    return this.census;
  }

  /** How many job-to-job lines the census drew, each carrying the wave; 0 when it drew tubes. */
  public censusLineCount(): number {
    return this.censusLines;
  }

  /** Whether any set of tubes runs through a node. */
  public holds(id: string): boolean {
    return this.sets.some((set: TubeSet): boolean => set.members.has(id));
  }

  /** A stage under a set of tubes started or finished: its tubes are re-read next frame. */
  public stale_mark(): void {
    this.stale = true;
  }

  /**
   * Joins a molecule's solid spheres with tubes.
   *
   * @param owner - What holds the set; its `tubes` becomes the mesh.
   * @param entries - The molecule's nodes, children of its tubes.
   * @param members - The nodes whose spheres are solid: a tube runs only between two.
   */
  public build(owner: TubeOwner, entries: ReadonlyArray<string>, members: ReadonlySet<string>): void {
    const opacity: number = owner.mix;
    const palette: Palette = this.host.palette();
    const edges: Array<{ fromId: string; from: TubeNode; toId: string; to: TubeNode; join: boolean }> = [];
    for (const id of entries) {
      const child: TubeNode | undefined = this.host.node(id);
      if (child === undefined) continue;
      for (const parentId of child.parents) {
        const parent: TubeNode | undefined = this.host.node(parentId);
        if (parent !== undefined && members.has(parentId)) edges.push({ fromId: parentId, from: parent, toId: id, to: child, join: false });
      }
      for (const parentId of child.joins) {
        const parent: TubeNode | undefined = this.host.node(parentId);
        if (parent !== undefined && members.has(parentId)) edges.push({ fromId: parentId, from: parent, toId: id, to: child, join: true });
      }
    }
    if (edges.length === 0) return;
    // A stage's depth in its molecule: the wave reaches it that many steps in.
    const depth: Map<string, number> = new Map();
    const depth_compute = (id: string, seen: Set<string> = new Set()): number => {
      const known: number | undefined = depth.get(id);
      if (known !== undefined) return known;
      if (seen.has(id)) return 0;
      seen.add(id);
      const node: TubeNode | undefined = this.host.node(id);
      const parents: string[] = node === undefined ? [] : [...node.parents, ...node.joins].filter((p: string): boolean => members.has(p));
      const d: number = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p: string): number => depth_compute(p, seen)));
      depth.set(id, d);
      return d;
    };
    const now: number = performance.now();
    const colors: Float32Array = new Float32Array(edges.length * 3);
    const modes: Float32Array = new Float32Array(edges.length);
    const starts: Float32Array = new Float32Array(edges.length);
    const bright: THREE.Color = palette.edge.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    const mesh: THREE.InstancedMesh = new THREE.InstancedMesh(tubeGeometry_get(), new THREE.ShaderMaterial({
      uniforms: { time: { value: now }, opacity: { value: opacity }, born: { value: now }, cycle: { value: 1 } },
      vertexShader: TUBE_VERTEX,
      fragmentShader: TUBE_FRAGMENT,
      transparent: true,
    }), edges.length);
    const up: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
    const carrier: THREE.Object3D = new THREE.Object3D();
    let deepest: number = 0;
    const set: Array<{ from: string; to: string; width: number }> = [];
    // A replayed stage lights when its pulse arrives: the root at once,
    // every other stage as the first tube into it lands.
    const lamps: Map<string, number> = new Map();
    // A running stage blinks with the stream: lit each time a pulse lands,
    // dark again before the next, until it is done.
    const blinks: Set<string> = new Set();
    edges.forEach(({ fromId, from, toId, to, join }, i: number): void => {
      const along: THREE.Vector3 = to.position.clone().sub(from.position);
      const length: number = along.length();
      // Thick enough to read as a tube, not a hairline, at the molecule's framing.
      const width: number = Math.max(0.06, Math.min(from.radius, to.radius) * 0.34) * (owner.thickness ?? 1);
      carrier.position.copy(from.position).addScaledVector(along, 0.5);
      carrier.quaternion.setFromUnitVectors(up, length > 0 ? along.clone().divideScalar(length) : up);
      carrier.scale.set(width, length, width);
      carrier.updateMatrix();
      mesh.setMatrixAt(i, carrier.matrix);
      set.push({ from: fromId, to: toId, width });
      const color: THREE.Color = to.state === 'failed' ? palette.error : join ? palette.join : bright;
      colors.set([color.r, color.g, color.b], i * 3);
      modes[i] = tubeMode_derive(to.state);
      const d: number = depth_compute(fromId);
      deepest = Math.max(deepest, d);
      starts[i] = d * WAVE_STEP_MS;
      if (modes[i] === 1) blinks.add(toId);
      if (modes[i] === 2) {
        const landed: number = starts[i]! + PULSE_TRIP_MS / 2;
        lamps.set(toId, Math.min(lamps.get(toId) ?? Infinity, landed));
        if (d === 0) lamps.set(fromId, 0);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Instanced attributes ride a clone of the shared tube, so each
    // molecule's tubes carry their own colours and pulses.
    const geometry: THREE.BufferGeometry = tubeGeometry_get().clone();
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    geometry.setAttribute('aMode', new THREE.InstancedBufferAttribute(modes, 1));
    geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 1));
    mesh.geometry = geometry;
    mesh.frustumCulled = false;
    this.made.thing_add(this.host.parent, mesh);
    owner.tubes = mesh;
    if (mesh.material instanceof THREE.ShaderMaterial) {
      this.materials.push(mesh.material);
      const cycle = mesh.material.uniforms['cycle'];
      if (cycle !== undefined) cycle.value = (deepest + 1) * WAVE_STEP_MS + PULSE_TRIP_MS / 2 + REPLAY_REST_MS;
    }
    this.sets.push({ mesh, edges: set, lamps, blinks, owner, entries, members });
  }

  /**
   * Draws a census's job-to-job tubes: one mesh for all of them.
   *
   * @param specs - The tubes.
   * @param deepest - The deepest stage the wave reaches, for the replay's cycle.
   */
  public census_build(specs: ReadonlyArray<TubeSpec>, deepest: number): void {
    if (specs.length === 0) return;
    const mesh: THREE.InstancedMesh = tubeMesh_make(specs, (deepest + 1) * WAVE_STEP_MS + PULSE_TRIP_MS / 2 + REPLAY_REST_MS);
    this.made.thing_add(this.host.parent, mesh);
    if (mesh.material instanceof THREE.ShaderMaterial) this.materials.push(mesh.material);
    this.census = specs.length;
  }

  /**
   * Draws a census's job-to-job connections as lines that carry the same
   * wave a tube does: past the tube cap, and under stars, information still
   * travels down every connection.
   *
   * @param specs - The connections, as tubes would be drawn.
   * @param deepest - The deepest stage the wave reaches, for the replay's cycle.
   * @param rest - The resting thread: hue scale, opacity, additive under stars.
   */
  public censusLines_build(specs: ReadonlyArray<TubeSpec>, deepest: number, rest: LineRest): void {
    if (specs.length === 0) return;
    const lines: THREE.LineSegments = lineMesh_make(specs, (deepest + 1) * WAVE_STEP_MS + PULSE_TRIP_MS / 2 + REPLAY_REST_MS, rest);
    this.made.thing_add(this.host.parent, lines);
    if (lines.material instanceof THREE.ShaderMaterial) this.materials.push(lines.material);
    this.censusLines = specs.length;
  }

  /**
   * Moves the tubes' clock on, re-reads states that changed, and lights the lamps.
   *
   * @param now - This frame's time.
   */
  public frame(now: number): void {
    if (this.materials.length === 0) return;
    for (const material of this.materials) {
      const time = material.uniforms['time'];
      if (time !== undefined) time.value = now;
    }
    if (this.stale) this.restatus();
    this.lamps_animate(now);
  }

  /**
   * Brings every tube to the spheres it joins, where they stand now: a
   * pulled node drags its tubes with it.
   */
  public follow(): void {
    const up: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
    const carrier: THREE.Object3D = new THREE.Object3D();
    for (const { mesh, edges } of this.sets) {
      edges.forEach(({ from, to, width }: { from: string; to: string; width: number }, i: number): void => {
        const a: THREE.Mesh | undefined = this.host.sphere(from);
        const b: THREE.Mesh | undefined = this.host.sphere(to);
        if (a === undefined || b === undefined) return;
        const along: THREE.Vector3 = b.position.clone().sub(a.position);
        const length: number = along.length();
        carrier.position.copy(a.position).addScaledVector(along, 0.5);
        carrier.quaternion.setFromUnitVectors(up, length > 0 ? along.clone().divideScalar(length) : up);
        carrier.scale.set(width, length, width);
        carrier.updateMatrix();
        mesh.setMatrixAt(i, carrier.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Lets one set of tubes go: its molecule is stars again.
   *
   * @param mesh - The set's mesh.
   */
  public release(mesh: THREE.InstancedMesh): void {
    this.host.parent.remove(mesh);
    this.made.thing_forget(mesh);
    this.sets = this.sets.filter((set: TubeSet): boolean => set.mesh !== mesh);
    if (mesh.material instanceof THREE.ShaderMaterial) {
      const material: THREE.ShaderMaterial = mesh.material;
      this.materials = this.materials.filter((m: THREE.ShaderMaterial): boolean => m !== material);
    }
    drawn_release(mesh);
  }

  /**
   * Lets go of every set of tubes, line and glow it drew, and forgets them: the scene is being redrawn.
   *
   * @example
   * field.clear();
   */
  public clear(): void {
    this.made.all_release();
    this.materials = [];
    this.census = 0;
    this.censusLines = 0;
    this.sets = [];
    this.glows = new Map();
  }

  /** Re-reads every set of tubes from the states as they are now. */
  private restatus(): void {
    this.stale = false;
    const stale: TubeSet[] = this.sets;
    this.sets = [];
    for (const set of stale) {
      this.host.parent.remove(set.mesh);
      this.made.thing_forget(set.mesh);
      if (set.mesh.material instanceof THREE.ShaderMaterial) {
        const material: THREE.ShaderMaterial = set.mesh.material;
        this.materials = this.materials.filter((m: THREE.ShaderMaterial): boolean => m !== material);
      }
      drawn_release(set.mesh);
      set.owner.tubes = null;
      this.build(set.owner, set.entries, set.members);
    }
    this.follow();
  }

  /**
   * Lights a replayed molecule's stages on its tubes' clock: every stage
   * starts the cycle dimmed, flares as its pulse lands and stays lit, and
   * the lot dims again as the rest runs out — then the run replays.
   */
  private lamps_animate(now: number): void {
    const shown: Set<string> = new Set();
    for (const { mesh: tubes, lamps, blinks } of this.sets) {
      if ((lamps.size === 0 && blinks.size === 0) || !(tubes.material instanceof THREE.ShaderMaterial)) continue;
      const born: number = Number(tubes.material.uniforms['born']?.value ?? now);
      const cycle: number = Number(tubes.material.uniforms['cycle']?.value ?? 1);
      const local: number = (((now - born) % cycle) + cycle) % cycle;
      // Out of the cycle's last stretch every lamp fades back down.
      const fade: number = Math.min(1, Math.max(0, (cycle - local) / LAMP_FADE_MS));
      for (const [id, landed] of lamps) {
        const since: number = local - landed;
        this.lamp_paint(id, since < 0 ? 0 : fade, since >= 0 && since < LAMP_BLOOM_MS ? since / LAMP_BLOOM_MS : -1, shown);
      }
      // The stream's pulse lands every trip; a running stage flares then
      // and dies back toward dark.
      const trip: number = ((now % PULSE_TRIP_MS) + PULSE_TRIP_MS) % PULSE_TRIP_MS;
      for (const id of blinks) {
        if (lamps.has(id)) continue;
        const decay: number = Math.max(0, 1 - trip / (PULSE_TRIP_MS * 0.8));
        this.lamp_paint(id, decay * decay, trip < LAMP_BLOOM_MS ? trip / LAMP_BLOOM_MS : -1, shown);
      }
    }
    for (const [id, glow] of this.glows) {
      if (shown.has(id)) continue;
      glow.visible = false;
      if (this.host.sphere(id) === undefined) {
        this.host.parent.remove(glow);
        this.made.thing_forget(glow);
        drawn_release(glow);
        this.glows.delete(id);
      }
    }
  }

  /**
   * Paints one stage's lamp: its colour from dark to lit, and — while a
   * pulse has just landed — a flash toward white and a glow that blooms
   * out and settles.
   */
  private lamp_paint(id: string, lit: number, bloom: number, shown: Set<string>): void {
    const sphere: THREE.Mesh | undefined = this.host.sphere(id);
    if (sphere === undefined || !(sphere.material instanceof THREE.MeshStandardMaterial)) return;
    let base: unknown = sphere.userData['lampBase'];
    if (!(base instanceof THREE.Color)) {
      base = sphere.material.color.clone();
      sphere.userData['lampBase'] = base;
    }
    const flash: number = bloom < 0 ? 0 : (1 - bloom) ** 2;
    sphere.material.color
      .copy(base as THREE.Color)
      .multiplyScalar(LAMP_DIM + (1 - LAMP_DIM) * Math.max(lit, flash))
      .lerp(LAMP_WHITE, Math.min(1, 0.22 * lit + 0.7 * flash));
    if (bloom < 0) return;
    let glow: THREE.Sprite | undefined = this.glows.get(id);
    if (glow === undefined) {
      glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: nebulaTexture_get(), color: (base as THREE.Color).clone().lerp(LAMP_WHITE, 0.35),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.glows.set(id, glow);
      this.made.thing_add(this.host.parent, glow);
    }
    const radius: number = (sphere.geometry as THREE.BufferGeometry & { parameters?: { radius?: number } }).parameters?.radius ?? 0.55;
    // Out fast, then settle: the glow swells to its reach and fades.
    const swell: number = 1 - (1 - bloom) ** 3;
    glow.position.copy(sphere.position);
    glow.scale.setScalar(radius * (2 + LAMP_BLOOM_REACH * swell) * sphere.scale.x);
    glow.material.opacity = 0.9 * (1 - bloom) ** 1.5;
    glow.visible = true;
    shown.add(id);
  }
}
