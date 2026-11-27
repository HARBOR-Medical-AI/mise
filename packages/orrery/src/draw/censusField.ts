/**
 * @file The census: every job of every stage.
 *
 * A stage that stands for many jobs is drawn as a shell of them around its
 * place, each job its own sphere (or, under stars, its own point of light);
 * each job is joined to a job of its parent stage, and every connection
 * carries the feed's wave: by tubes while there are few enough of them, by
 * lines carrying the same wave past that and under stars.
 * A wave down the graph flares every job of a stage together.
 *
 * @module
 */
import * as THREE from 'three';
import type { NodeState } from '../types/encoding.js';
import { THREAD_OPACITY } from './constants.js';
import { fibonacciPoint_make } from './geometry.js';
import { LAMP_BLOOM_REACH, LAMP_WHITE } from './lamps.js';
import { nebulaTexture_get } from './nebula.js';
import type { Palette } from './palette.js';
import { Made } from './release.js';
import type { StarField } from './starField.js';
import type { StarEntry } from './stars.js';
import { WAVE_STEP_MS } from './timing.js';
import { tubeMode_derive, type TubeField } from './tubeField.js';
import { CENSUS_TUBE_CAP, type TubeSpec } from './tubes.js';

/** Past this many stages the census blooms none: each glow is a draw of its own. */
export const CENSUS_GLOW_CAP: number = 400;

/**
 * How finely a census member's sphere is cut, by how many the census draws:
 * smooth on a 4K screen while there are few (980 faces, near a node
 * sphere's own cut; detail 1's 80 faces read as a faceted stone), coarser
 * as the crowd grows, so a census of tens of thousands of jobs still turns
 * at frame rate.
 *
 * @param total - The members the census draws.
 * @returns The icosahedron's detail.
 */
export function censusDetail_derive(total: number): number {
  if (total <= 2_000) return 6;
  if (total <= 20_000) return 3;
  return 1;
}

/**
 * One stage as the census draws it.
 *
 * @property id - The stage.
 * @property position - Where it stands.
 * @property radius - Its sphere's radius as a single node.
 * @property count - How many jobs it stands for.
 * @property color - Its hue.
 * @property dim - Faint scenery.
 * @property ember - Some of its jobs failed: under stars, drawn solid over the glow.
 * @property state - What it is doing.
 * @property parents - The stages it hangs from.
 * @property ghost - An anchor, not a stage: it counts in the cloud's centre
 *   and in how deep a stage lies, and draws no jobs.
 */
export interface CensusNode {
  id: string;
  position: THREE.Vector3;
  radius: number;
  count: number;
  color: THREE.Color;
  dim: boolean;
  ember: boolean;
  state: NodeState;
  parents: ReadonlyArray<string>;
  ghost?: boolean;
}

/** Where a census cloud stands and how far it reaches, for framing it. */
export interface CensusCloud {
  center: THREE.Vector3;
  radius: number;
}

/** What a census draws with. */
export interface CensusHost {
  parent: THREE.Object3D;
  stars: StarField;
  tubes: TubeField;
  /** The display's pixel ratio, the canvas height in device pixels, the camera's field of view. */
  starsView(): { pixelRatio: number; heightPx: number; fovDeg: number };
}

/** Every job of every stage, drawn. */
export class CensusField {
  private readonly host: CensusHost;
  /** What this field drew, let go together at a redraw. */
  private readonly made: Made = new Made();
  private mesh: THREE.InstancedMesh | null = null;
  private base: Float32Array | null = null;
  private memberIds: string[] = [];
  private memberPositions: THREE.Vector3[] = [];
  /** Each stage's glow as the wave lands on it, and how far its shell reaches. */
  private glows: Array<{ id: string; sprite: THREE.Sprite; reach: number }> = [];

  /**
   * @param host - What the census draws with.
   */
  constructor(host: CensusHost) {
    this.host = host;
  }

  /** Whether the census is drawn as instanced spheres (not stars). */
  public drawn(): boolean {
    return this.mesh !== null;
  }

  /** The stage behind each job, in draw order. */
  public ids(): ReadonlyArray<string> {
    return this.memberIds;
  }

  /** Where each job stands, in draw order. */
  public positions(): ReadonlyArray<THREE.Vector3> {
    return this.memberPositions;
  }

  /**
   * Draws the census.
   *
   * @param nodes - The stages.
   * @param starring - Draw jobs as points of light, not spheres.
   * @param palette - The colours.
   * @returns Where the cloud stands and how far it reaches.
   */
  public build(nodes: ReadonlyArray<CensusNode>, starring: boolean, palette: Palette): CensusCloud {
    let total: number = 0;
    for (const node of nodes) if (node.ghost !== true) total += Math.max(1, node.count);
    const geometry: THREE.IcosahedronGeometry = new THREE.IcosahedronGeometry(1, censusDetail_derive(total));
    const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5, metalness: 0.1 });
    const starred: StarEntry[] = [];
    const instanced: THREE.InstancedMesh = new THREE.InstancedMesh(geometry, material, starring ? 1 : total);
    const color: THREE.Color = new THREE.Color();
    const carrier: THREE.Object3D = new THREE.Object3D();
    const shells: Map<string, THREE.Vector3[]> = new Map();
    const shellRadii: Map<string, number> = new Map();
    let index: number = 0;
    let cloudRadius: number = 1;
    const center: THREE.Vector3 = new THREE.Vector3();
    for (const node of nodes) center.add(node.position);
    center.divideScalar(Math.max(1, nodes.length));

    for (const node of nodes) {
      // An anchor is nobody's job: a census of it would draw a shell of nothing.
      if (node.ghost === true) continue;
      const n: number = Math.max(1, node.count);
      const shellRadius: number = n === 1 ? 0 : node.radius * (1.6 + 0.55 * Math.cbrt(n));
      const memberRadius: number = n === 1 ? node.radius : Math.max(0.06, Math.min(node.radius * 0.5, (2.2 * shellRadius) / Math.sqrt(n)));
      const points: THREE.Vector3[] = [];
      for (let k = 0; k < n; k++) {
        const point: THREE.Vector3 = n === 1 ? node.position.clone() : fibonacciPoint_make(k, n, shellRadius).add(node.position);
        points.push(point);
        color.set(node.color);
        if (starring) {
          starred.push({ id: node.id, position: point, radius: memberRadius, color: color.clone(), dim: node.dim, ember: node.ember });
        } else {
          carrier.position.copy(point);
          carrier.scale.setScalar(memberRadius);
          carrier.updateMatrix();
          instanced.setMatrixAt(index, carrier.matrix);
          instanced.setColorAt(index, color);
        }
        this.memberIds.push(node.id);
        this.memberPositions.push(point);
        index += 1;
        cloudRadius = Math.max(cloudRadius, center.distanceTo(point) + memberRadius);
      }
      shells.set(node.id, points);
      shellRadii.set(node.id, memberRadius);
      if (!starring && nodes.length <= CENSUS_GLOW_CAP) this.glow_add(node, shellRadius + memberRadius);
    }
    if (starring) {
      const view = this.host.starsView();
      this.host.stars.draw(starred, view.pixelRatio, view.heightPx, view.fovDeg);
    } else {
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
      this.made.thing_add(this.host.parent, instanced);
      this.mesh = instanced;
      this.base = instanced.instanceColor ? Float32Array.from(instanced.instanceColor.array) : null;
    }

    // Every job joins a job of its parent stage, and every connection
    // carries the feed's wave: drawn as spheres, by the tubes a feed wears
    // while there are few enough of them to draw; past that, and under
    // stars, by lines that carry the same wave — information still travels
    // down every one of them.
    const { specs, deepest } = connections_build(nodes, shells, shellRadii, palette);
    if (!starring && specs.length > 0 && specs.length <= CENSUS_TUBE_CAP) {
      this.host.tubes.census_build(specs, deepest);
    } else if (specs.length > 0) {
      this.host.tubes.censusLines_build(specs, deepest, starring ? { tint: 1, opacity: THREAD_OPACITY, additive: true } : { tint: 1, opacity: 0.35, additive: false });
    }
    return { center, radius: cloudRadius };
  }

  /**
   * Flares every job of a stage with the wave, written straight into the
   * instance colours.
   *
   * @param fireAt - When a stage fires, by id; undefined when it does not.
   * @param elapsed - Time since the wave set off.
   * @param pulse - The flare's hue.
   * @param flareMs - How long a flare lasts.
   * @returns The latest a stage fires, so the caller knows when the wave is done.
   */
  public flare(fireAt: (id: string) => number | undefined, elapsed: number, pulse: THREE.Color, flareMs: number): number {
    let peak: number = 0;
    if (this.mesh === null || this.base === null || !this.mesh.instanceColor) return peak;
    const colors: Float32Array = this.mesh.instanceColor.array as Float32Array;
    const base: Float32Array = this.base;
    for (let i = 0; i < this.memberIds.length; i++) {
      const at: number | undefined = fireAt(this.memberIds[i] ?? '');
      if (at === undefined) continue;
      peak = Math.max(peak, at);
      const dt: number = elapsed - at;
      const flare: number = dt >= 0 && dt <= flareMs ? Math.sin((dt / flareMs) * Math.PI) : 0;
      const o: number = i * 3;
      colors[o] = base[o]! + (pulse.r - base[o]!) * flare;
      colors[o + 1] = base[o + 1]! + (pulse.g - base[o + 1]!) * flare;
      colors[o + 2] = base[o + 2]! + (pulse.b - base[o + 2]!) * flare;
    }
    this.mesh.instanceColor.needsUpdate = true;
    // The stage blooms as its jobs flare, as a lone node's lamp does.
    for (const { id, sprite, reach } of this.glows) {
      const at: number | undefined = fireAt(id);
      const dt: number = at === undefined ? -1 : elapsed - at;
      const flare: number = dt >= 0 && dt <= flareMs ? Math.sin((dt / flareMs) * Math.PI) : 0;
      sprite.visible = flare > 0;
      sprite.scale.setScalar(reach * (2 + LAMP_BLOOM_REACH * flare));
      sprite.material.opacity = 0.9 * flare;
    }
    return peak;
  }

  /**
   * Stands a stage's glow, hidden until the wave lands on it.
   *
   * @param node - The stage.
   * @param reach - How far its shell reaches.
   */
  private glow_add(node: CensusNode, reach: number): void {
    const sprite: THREE.Sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebulaTexture_get(), color: node.color.clone().lerp(LAMP_WHITE, 0.35),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sprite.position.copy(node.position);
    sprite.visible = false;
    this.made.thing_add(this.host.parent, sprite);
    this.glows.push({ id: node.id, sprite, reach });
  }

  /**
   * The stage behind the job a ray meets first; the touched job lights up.
   *
   * @param raycaster - The ray, aimed by the caller.
   * @returns The stage, or null.
   */
  public pick(raycaster: THREE.Raycaster): string | null {
    if (this.mesh === null) return null;
    const hit: THREE.Intersection | undefined = raycaster.intersectObject(this.mesh)[0];
    if (hit === undefined || hit.instanceId === undefined) return null;
    this.mesh.setColorAt(hit.instanceId, new THREE.Color('#ffffff'));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return this.memberIds[hit.instanceId] ?? null;
  }

  /**
   * Lets go of the census mesh and every glow it drew, and forgets them: the scene is being redrawn.
   *
   * @example
   * field.clear();
   */
  public clear(): void {
    this.made.all_release();
    this.mesh = null;
    this.base = null;
    this.memberIds = [];
    this.memberPositions = [];
    this.glows = [];
  }
}

/**
 * The census's connections: each job to the job of its parent stage it
 * stands against, in the stage's hue (red into a failed one); a live stage
 * streams, a finished run replays with every job of a stage together.
 *
 * @param nodes - The stages.
 * @param shells - Each stage's jobs, where they stand.
 * @param shellRadii - Each stage's job radius.
 * @param palette - The colours.
 * @returns The connections and the deepest stage a wave reaches.
 */
export function connections_build(
  nodes: ReadonlyArray<CensusNode>,
  shells: ReadonlyMap<string, THREE.Vector3[]>,
  shellRadii: ReadonlyMap<string, number>,
  palette: Palette,
): { specs: TubeSpec[]; deepest: number } {
  const byId: Map<string, CensusNode> = new Map(nodes.map((node: CensusNode): [string, CensusNode] => [node.id, node]));
  const depth: Map<string, number> = new Map();
  const depth_compute = (id: string, seen: Set<string> = new Set()): number => {
    const known: number | undefined = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents: string[] = (byId.get(id)?.parents ?? []).filter((p: string): boolean => byId.has(p));
    const d: number = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p: string): number => depth_compute(p, seen)));
    depth.set(id, d);
    return d;
  };
  const bright: THREE.Color = palette.edge.clone().lerp(new THREE.Color('#ffffff'), 0.45);
  const specs: TubeSpec[] = [];
  let deepest: number = 0;
  for (const node of nodes) {
    const mine: THREE.Vector3[] = shells.get(node.id) ?? [];
    for (const parentId of node.parents) {
      const theirs: THREE.Vector3[] | undefined = shells.get(parentId);
      if (!theirs || theirs.length === 0) continue;
      const width: number = Math.max(0.02, Math.min(shellRadii.get(node.id) ?? 0.1, shellRadii.get(parentId) ?? 0.1) * 0.34);
      const start: number = depth_compute(parentId) * WAVE_STEP_MS;
      deepest = Math.max(deepest, depth_compute(parentId));
      for (let k = 0; k < mine.length; k++) {
        const to: THREE.Vector3 | undefined = mine[k];
        const from: THREE.Vector3 | undefined = theirs.length === mine.length ? theirs[k] : theirs[k % theirs.length];
        if (from === undefined || to === undefined) continue;
        specs.push({ from, to, width, color: node.state === 'failed' ? palette.error : bright, mode: tubeMode_derive(node.state), start });
      }
    }
  }
  return { specs, deepest };
}
