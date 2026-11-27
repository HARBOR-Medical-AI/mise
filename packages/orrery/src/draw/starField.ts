/**
 * @file The stars of a scene: every node a point of light, the threads that
 * join them, and the nebulae that mark a cluster.
 *
 * A scene draws its field as stars from afar; the field holds the two
 * layers (glow and embers), the thread lines, and the nebulae, keeps each
 * star's slot, and lets a molecule's stars and threads fade out as the
 * molecule turns solid and back in as it turns to stars again.
 *
 * @module
 */
import * as THREE from 'three';
import { NEBULA_OPACITY, THREAD_OPACITY } from './constants.js';
import { nebulaTexture_get } from './nebula.js';
import { Made } from './release.js';
import { starLayer_make, starScale_compute, type StarEntry, type StarLayer } from './stars.js';
import { lineMaterial_make, lineWave_set } from './tubes.js';

/**
 * The wave the threads carry, one entry a thread: its mode (0 rests, 1
 * streams into a live stage, 2 replays a finished run), when it sets off
 * into the replay's cycle, and that cycle.
 */
export interface ThreadWave {
  modes: ReadonlyArray<number>;
  starts: ReadonlyArray<number>;
  cycle: number;
}

/** A cluster's nebula: whose it is, where, how far it reaches. */
export interface Nebula {
  id: string;
  position: THREE.Vector3;
  radius: number;
}

/** The stars, threads and nebulae of one scene. */
export class StarField {
  private readonly parent: THREE.Object3D;
  /** What this field drew, let go together at a redraw. */
  private readonly made: Made = new Made();
  private stars: StarEntry[] = [];
  private index: Map<string, number> = new Map();
  private nebulaList: Nebula[] = [];
  private materials: THREE.ShaderMaterial[] = [];
  private layers: Array<{ alpha: THREE.BufferAttribute; base: Float32Array; flash: THREE.BufferAttribute }> = [];
  private threads: { attribute: THREE.BufferAttribute; base: Float32Array; ends: ReadonlyArray<string> } | null = null;
  /** The threads' wave material, on the scene's clock; null when they carry none. */
  private threadMaterial: THREE.ShaderMaterial | null = null;
  /** Each nebula's sprite and resting opacity, by its cluster's id. */
  private nebulaSprites: Map<string, { material: THREE.SpriteMaterial; base: number }> = new Map();
  /** Every star of a node, by id; built when first asked. */
  private starsById: Map<string, StarEntry[]> | null = null;
  private starsTouched: boolean = false;
  private threadsTouched: boolean = false;

  /**
   * @param parent - Where the field is drawn.
   */
  constructor(parent: THREE.Object3D) {
    this.parent = parent;
  }

  /** How many stars are drawn. */
  public count(): number {
    return this.stars.length;
  }

  /** Every star, in the order drawn. */
  public list(): ReadonlyArray<StarEntry> {
    return this.stars;
  }

  /** The first star drawn for a node, if any. */
  public entry(id: string): StarEntry | undefined {
    const at: number | undefined = this.index.get(id);
    return at === undefined ? undefined : this.stars[at];
  }

  /** Every node drawn as a star. */
  public ids(): IterableIterator<string> {
    return this.index.keys();
  }

  /** Every nebula. */
  public nebulae(): ReadonlyArray<Nebula> {
    return this.nebulaList;
  }

  /**
   * Draws stars as two layers — the glow, and the embers over it.
   *
   * @param entries - The stars.
   * @param pixelRatio - The display's pixel ratio.
   * @param heightPx - The canvas's height, in device pixels.
   * @param fovDeg - The camera's vertical field of view.
   */
  public draw(entries: StarEntry[], pixelRatio: number, heightPx: number, fovDeg: number): void {
    for (const entry of entries) {
      if (!this.index.has(entry.id)) this.index.set(entry.id, this.stars.length);
      this.stars.push(entry);
    }
    this.starsById = null;
    // The glow, the embers over it, and rings (stars of another kind) over both.
    for (const [ember, ring] of [[false, false], [true, false], [false, true]] as const) {
      const layer: StarEntry[] = entries.filter((entry: StarEntry): boolean => (entry.ring === true) === ring && (ring || entry.ember === ember));
      if (layer.length === 0) continue;
      const drawn: StarLayer = starLayer_make(layer, ember, this.layers.length, pixelRatio, ring);
      this.layers.push({ alpha: drawn.alpha, base: drawn.base, flash: drawn.flash });
      this.made.thing_add(this.parent, drawn.points);
      this.materials.push(drawn.material);
    }
    this.scale_update(heightPx, fovDeg);
  }

  /**
   * Keeps the stars' pixel scale true to the canvas and the camera.
   *
   * @param heightPx - The canvas's height, in device pixels.
   * @param fovDeg - The camera's vertical field of view.
   */
  public scale_update(heightPx: number, fovDeg: number): void {
    if (this.materials.length === 0) return;
    const scale: number = starScale_compute(heightPx, fovDeg);
    for (const material of this.materials) {
      const uniform = material.uniforms['scale'];
      if (uniform !== undefined) uniform.value = scale;
    }
  }

  /**
   * Draws the faint threads between stars, as one line batch.
   *
   * @param positions - Segment ends, six numbers a segment.
   * @param colors - Their colours, six numbers a segment.
   * @param ends - The nodes each segment joins, two ids a segment: a thread
   *   shows in a replay only once both have arrived. Optional.
   * @param wave - The wave each thread carries, as a tube would; without
   *   one the threads rest. The fades above dim the wave with the thread.
   */
  public threads_draw(positions: ReadonlyArray<number>, colors: ReadonlyArray<number>, ends: ReadonlyArray<string> = [], wave?: ThreadWave): void {
    if (positions.length === 0) return;
    const geometry: THREE.BufferGeometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions as number[], 3));
    const attribute: THREE.Float32BufferAttribute = new THREE.Float32BufferAttribute(colors as number[], 3);
    this.threads = { attribute, base: Float32Array.from(colors), ends };
    if (wave === undefined) {
      geometry.setAttribute('color', attribute);
      this.made.thing_add(this.parent, new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: THREAD_OPACITY, blending: THREE.AdditiveBlending, depthWrite: false,
      })));
      return;
    }
    // The same attribute the fades write, read by the wave shader.
    geometry.setAttribute('aColor', attribute);
    lineWave_set(geometry, wave.modes, wave.starts);
    this.threadMaterial = lineMaterial_make(wave.cycle, { tint: 1, opacity: THREAD_OPACITY, additive: true });
    const lines: THREE.LineSegments = new THREE.LineSegments(geometry, this.threadMaterial);
    lines.frustumCulled = false;
    this.made.thing_add(this.parent, lines);
  }

  /**
   * Moves the threads' wave on to this frame's time.
   *
   * @param now - This frame's time.
   */
  public frame(now: number): void {
    const time = this.threadMaterial?.uniforms['time'];
    if (time !== undefined) time.value = now;
  }

  /** Whether the threads carry the wave (a readout and a test ask). */
  public threadsCarryWave(): boolean {
    return this.threadMaterial !== null;
  }

  /**
   * A cluster's handle while the scene draws stars: a soft glow facing the
   * camera.
   *
   * @param id - The cluster's anchor.
   * @param position - Where it stands.
   * @param radius - How far it reaches.
   * @param color - Its hue.
   * @param dim - Drawn at a third of its light.
   */
  public nebula_add(id: string, position: THREE.Vector3, radius: number, color: THREE.Color, dim: boolean): void {
    const sprite: THREE.Sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebulaTexture_get(),
      color,
      transparent: true,
      opacity: dim ? NEBULA_OPACITY / 3 : NEBULA_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    sprite.position.copy(position);
    sprite.scale.setScalar(radius * 2);
    sprite.renderOrder = 0;
    this.made.thing_add(this.parent, sprite);
    this.nebulaList.push({ id, position: position.clone(), radius });
    this.nebulaSprites.set(id, { material: sprite.material, base: sprite.material.opacity });
  }

  /**
   * Fades stars to a share of their resting light (0 gone, 1 as drawn).
   *
   * @param entries - The stars.
   * @param share - How much of their light they keep.
   */
  public stars_fade(entries: ReadonlyArray<StarEntry>, share: number): void {
    for (const entry of entries) {
      const layer = entry.layer === undefined ? undefined : this.layers[entry.layer];
      if (layer === undefined || entry.slot === undefined) continue;
      layer.alpha.setX(entry.slot, (layer.base[entry.slot] ?? 1) * share);
      this.starsTouched = true;
    }
  }

  /**
   * Fades thread segments to a share of their resting colour.
   *
   * @param segments - The segments, by index.
   * @param share - How much of their colour they keep.
   */
  public threads_fade(segments: ReadonlyArray<number>, share: number): void {
    if (this.threads === null || segments.length === 0) return;
    const colors = this.threads.attribute.array as Float32Array;
    const base: Float32Array = this.threads.base;
    for (const segment of segments) {
      for (let k = segment * 6; k < segment * 6 + 6; k++) colors[k] = (base[k] ?? 0) * share;
    }
    this.threadsTouched = true;
  }

  /** Sends this frame's fades to the screen. */
  public flush(): void {
    if (this.starsTouched) for (const layer of this.layers) layer.alpha.needsUpdate = true;
    if (this.threadsTouched && this.threads !== null) this.threads.attribute.needsUpdate = true;
    this.starsTouched = false;
    this.threadsTouched = false;
  }

  /**
   * Lets go of every layer of stars, thread and nebula it drew, and forgets them: the scene is being redrawn.
   *
   * @example
   * field.clear();
   */
  public clear(): void {
    this.made.all_release();
    this.stars = [];
    this.index = new Map();
    this.nebulaList = [];
    this.materials = [];
    this.layers = [];
    this.threads = null;
    this.threadMaterial = null;
    this.nebulaSprites = new Map();
    this.starsById = null;
    this.starsTouched = false;
    this.threadsTouched = false;
  }

  /**
   * Shows or hides nodes' stars and nebulae (a replay: 0 not yet arrived,
   * 1 as drawn). Threads follow with {@link threads_present}.
   *
   * @param ids - The nodes.
   * @param presence - How much of their resting light they keep.
   */
  public presence_set(ids: Iterable<string>, presence: number): void {
    for (const id of ids) {
      for (const entry of this.stars_list(id)) {
        const layer = entry.layer === undefined ? undefined : this.layers[entry.layer];
        if (layer === undefined || entry.slot === undefined) continue;
        layer.alpha.setX(entry.slot, (layer.base[entry.slot] ?? 1) * presence);
        this.starsTouched = true;
      }
      const nebula = this.nebulaSprites.get(id);
      if (nebula !== undefined) nebula.material.opacity = nebula.base * presence;
    }
  }

  /**
   * Sets how brightly a node's stars flash (an arrival), 0 at rest.
   *
   * @param id - The node.
   * @param strength - 0..1.
   */
  public flash_set(id: string, strength: number): void {
    for (const entry of this.stars_list(id)) {
      const layer = entry.layer === undefined ? undefined : this.layers[entry.layer];
      if (layer === undefined || entry.slot === undefined) continue;
      layer.flash.setX(entry.slot, strength);
      layer.flash.needsUpdate = true;
    }
  }

  /**
   * Shows each thread whose two ends are both present, hides the rest.
   * Threads drawn without their ends are left as they are.
   *
   * @param present - Whether a node is present.
   */
  public threads_present(present: (id: string) => boolean): void {
    const threads = this.threads;
    if (threads === null || threads.ends.length === 0) return;
    const colors = threads.attribute.array as Float32Array;
    const segments: number = threads.ends.length / 2;
    for (let segment = 0; segment < segments; segment++) {
      const shown: number = present(threads.ends[segment * 2] ?? '') && present(threads.ends[segment * 2 + 1] ?? '') ? 1 : 0;
      for (let k = segment * 6; k < segment * 6 + 6; k++) colors[k] = (threads.base[k] ?? 0) * shown;
    }
    this.threadsTouched = true;
  }

  /** Every star drawn for a node. */
  private stars_list(id: string): ReadonlyArray<StarEntry> {
    if (this.starsById === null) {
      this.starsById = new Map();
      for (const entry of this.stars) this.starsById.set(entry.id, [...(this.starsById.get(entry.id) ?? []), entry]);
    }
    return this.starsById.get(id) ?? [];
  }
}
