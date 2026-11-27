/**
 * @file The solid spheres of a scene, the halos that mark a cluster, and
 * the plain lines between spheres that do not wear tubes.
 *
 * A sphere is lit, coloured as it is handed; a dimmed one is faint scenery
 * and takes no pointer; a selected one glows; flat, it is a disc facing the
 * camera. Every sphere is found by its node's id.
 *
 * @module
 */
import * as THREE from 'three';
import { DIM_OPACITY, HALO_OPACITY } from './constants.js';
import { SphereGeometries } from './geometry.js';
import { Made, drawn_release } from './release.js';

/**
 * How a sphere looks.
 *
 * @property color - Its hue.
 * @property dim - Faint scenery that takes no pointer.
 * @property selected - Lit from within: the node in hand.
 * @property flat - A disc, not a sphere (a 2D projection).
 * @property fade - Drawn at this opacity (a molecule fading in).
 */
export interface SphereLook {
  color: THREE.Color;
  dim?: boolean;
  selected?: boolean;
  flat?: boolean;
  fade?: number;
}

/** A plain line between two spheres, which follows them when they move. */
interface Edge {
  line: THREE.Line;
  fromId: string;
  toId: string;
  dashed: boolean;
}

/** The solid spheres, halos and plain edges of one scene. */
export class SphereField {
  private readonly parent: THREE.Object3D;
  /** What this field drew, let go together at a redraw. */
  private readonly made: Made = new Made();
  private readonly geometries: SphereGeometries = new SphereGeometries();
  private byId: Map<string, THREE.Mesh> = new Map();
  private edges: Edge[] = [];

  /**
   * @param parent - Where the spheres are drawn.
   */
  constructor(parent: THREE.Object3D) {
    this.parent = parent;
  }

  /** Every drawn sphere and halo, by its node's id. */
  public get map(): Map<string, THREE.Mesh> {
    return this.byId;
  }

  /**
   * Draws one sphere.
   *
   * @param id - Its node.
   * @param position - Where it stands.
   * @param radius - Its radius.
   * @param look - How it looks.
   * @returns The mesh.
   */
  public sphere_add(id: string, position: THREE.Vector3, radius: number, look: SphereLook): THREE.Mesh {
    const geometry: THREE.BufferGeometry = look.flat === true ? new THREE.CircleGeometry(radius, 36) : this.geometries.of(radius);
    const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({
      color: look.color,
      roughness: 0.35,
      metalness: 0.15,
      emissive: look.selected === true ? new THREE.Color('#ffffff') : new THREE.Color('#000000'),
      emissiveIntensity: look.selected === true ? 0.35 : 0,
      ...(look.dim === true ? { transparent: true, opacity: DIM_OPACITY } : {}),
      ...(look.fade !== undefined ? { transparent: true, opacity: look.fade } : {}),
    });
    const mesh: THREE.Mesh = new THREE.Mesh(geometry, material);
    if (look.flat === true) {
      // A disc lies in the plane the tubes are centred on, so a tube's near
      // face stood in front of it and ran across the node it joined. The
      // schematic reads the other way: the node sits ON its tubes. The
      // tubes are transparent (their shader fades and pulses), and three
      // draws every transparent thing after every opaque one whatever its
      // render order — so the disc is transparent too, at full opacity,
      // ordered after the tubes and without the depth test: it covers the
      // tube ends as a sphere's near hemisphere does in 3D.
      material.transparent = true;
      material.depthTest = false;
      mesh.renderOrder = 2;
    }
    mesh.position.copy(position);
    mesh.userData['nodeId'] = id;
    // A dimmed node is scenery: drawn behind the graph in hand, it takes no
    // pointer, so a hover or a click never lands on the field behind.
    mesh.userData['dim'] = look.dim === true;
    this.made.thing_add(this.parent, mesh);
    this.byId.set(id, mesh);
    return mesh;
  }

  /**
   * Draws a cluster's halo: translucent, unlit, written last so the spheres
   * inside it show through; picked only when nothing solid is.
   *
   * @param id - The cluster's anchor.
   * @param position - Where it stands.
   * @param radius - How far it reaches.
   * @param color - Its hue.
   * @param dim - Faint scenery that takes no pointer.
   */
  public halo_add(id: string, position: THREE.Vector3, radius: number, color: THREE.Color, dim: boolean): void {
    const halo: THREE.Mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 24, 18),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: dim ? HALO_OPACITY * 0.4 : HALO_OPACITY, depthWrite: false }),
    );
    halo.position.copy(position);
    halo.renderOrder = 1;
    halo.userData['nodeId'] = id;
    halo.userData['halo'] = true;
    halo.userData['dim'] = dim;
    this.made.thing_add(this.parent, halo);
    this.byId.set(id, halo);
  }

  /**
   * Draws a plain line between two spheres; a join is dashed.
   *
   * @param fromId - The parent.
   * @param toId - The child.
   * @param from - Where the parent stands.
   * @param to - Where the child stands.
   * @param color - Its hue.
   * @param dashed - A join across branches.
   * @param dim - Faint scenery.
   */
  public edge_add(fromId: string, toId: string, from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, dashed: boolean, dim: boolean = false): void {
    const geometry: THREE.BufferGeometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    let line: THREE.Line;
    if (dashed) {
      line = new THREE.Line(geometry, new THREE.LineDashedMaterial({
        color, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: dim ? DIM_OPACITY : 0.9,
      }));
      line.computeLineDistances();
    } else {
      line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: dim ? DIM_OPACITY : 0.75 }));
    }
    this.made.thing_add(this.parent, line);
    this.edges.push({ line, fromId, toId, dashed });
  }

  /** Brings every plain edge to its spheres, where they stand now. */
  public edges_follow(): void {
    for (const edge of this.edges) {
      const from: THREE.Mesh | undefined = this.byId.get(edge.fromId);
      const to: THREE.Mesh | undefined = this.byId.get(edge.toId);
      if (from === undefined || to === undefined) continue;
      edge.line.geometry.setFromPoints([from.position, to.position]);
      if (edge.dashed) edge.line.computeLineDistances();
    }
  }

  /**
   * Gives a sphere a new hue (its state changed); a lamp re-reads it.
   *
   * @param id - The node.
   * @param color - Its hue now.
   */
  public recolor(id: string, color: THREE.Color): void {
    const mesh: THREE.Mesh | undefined = this.byId.get(id);
    if (mesh === undefined || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
    mesh.material.color = color;
    delete mesh.userData['lampBase'];
  }

  /**
   * Lights the node in hand from within and every other not at all.
   *
   * @param selectedId - The node in hand, or null.
   */
  public select(selectedId: string | null): void {
    for (const [id, mesh] of this.byId) {
      if (!(mesh.material instanceof THREE.MeshStandardMaterial)) continue;
      const on: boolean = id === selectedId;
      mesh.material.emissive.set(on ? '#ffffff' : '#000000');
      mesh.material.emissiveIntensity = on ? 0.35 : 0;
    }
  }

  /**
   * Lets one sphere go: its molecule is stars again.
   *
   * @param mesh - The sphere.
   */
  public remove(mesh: THREE.Mesh): void {
    this.parent.remove(mesh);
    this.made.thing_forget(mesh);
    drawn_release(mesh);
    const id: unknown = mesh.userData['nodeId'];
    if (typeof id === 'string' && this.byId.get(id) === mesh) this.byId.delete(id);
  }

  /**
   * Lets go of every sphere, halo and edge it drew, and forgets them: the scene is being redrawn.
   *
   * @example
   * field.clear();
   */
  public clear(): void {
    this.made.all_release();
    this.byId = new Map();
    this.edges = [];
  }

  /** Lets the shared geometries go: the scene is done. */
  public dispose(): void {
    this.geometries.dispose();
  }
}
