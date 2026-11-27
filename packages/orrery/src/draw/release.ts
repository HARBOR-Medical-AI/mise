/**
 * @file What a drawn field made, and letting it go.
 *
 * A geometry, a material and a texture each hold memory on the graphics
 * card until `dispose` is called on them; taking a mesh out of the scene
 * frees nothing. A field that draws keeps what it made here and lets all
 * of it go when the scene is redrawn. What several draws share (a cached
 * sphere, the one tube, the one nebula glow) is marked, and is not let go
 * with any one of them.
 *
 * Key components:
 * - {@link shared_mark}: marks a geometry or a texture as shared.
 * - {@link drawn_release}: disposes what one drawn object holds.
 * - {@link Made}: what one field made, added to the scene and released together.
 *
 * Typical usage:
 * - `this.made.thing_add(this.parent, mesh)` where a field draws; `this.made.all_release()` in its `clear`.
 *
 * Dependencies:
 * - three
 *
 * @module
 */

import * as THREE from 'three';

/** Geometries and textures that more than one drawn object uses. */
const shared: WeakSet<object> = new WeakSet();

/**
 * Marks a geometry or a texture as shared: no one drawn object lets it go.
 *
 * @param thing - The geometry or texture.
 * @returns The same thing.
 *
 * @example
 * const geometry: THREE.SphereGeometry = shared_mark(new THREE.SphereGeometry(1, 24, 18));
 */
export function shared_mark<T extends object>(thing: T): T {
  shared.add(thing);
  return thing;
}

/** A material as it may be: drawn with a texture. */
interface Textured {
  /** Its texture, when it has one. */
  map?: unknown;
}

/**
 * Lets go of one material and the texture it draws with.
 *
 * @param material - The material.
 *
 * @example
 * material_release(mesh.material);
 */
function material_release(material: THREE.Material): void {
  const map: unknown = (material as Textured).map;
  if (map instanceof THREE.Texture && !shared.has(map)) map.dispose();
  material.dispose();
}

/**
 * Lets go of what a drawn object, and everything under it, holds on the
 * graphics card: its geometry, its materials and their textures. What is
 * marked as shared is left.
 *
 * @param object - The drawn object.
 *
 * @example
 * drawn_release(mesh);
 */
export function drawn_release(object: THREE.Object3D): void {
  object.traverse((one: THREE.Object3D): void => { one_release(one); });
}

/** A drawn object as it may be: with a geometry, and one material or several. */
interface Held {
  /** Its shape, when it has one. */
  geometry?: unknown;
  /** Its material or materials, when it has any. */
  material?: unknown;
}

/**
 * Lets go of what one object itself holds.
 *
 * @param one - The object.
 *
 * @example
 * one_release(mesh);
 */
function one_release(one: THREE.Object3D): void {
  const held: Held = one as Held;
  // Every sprite is drawn with one shape that three.js itself keeps: it is not a sprite's to let go.
  if (held.geometry instanceof THREE.BufferGeometry && !(one instanceof THREE.Sprite) && !shared.has(held.geometry)) held.geometry.dispose();
  const materials: unknown[] = Array.isArray(held.material) ? held.material as unknown[] : [held.material];
  for (const material of materials) if (material instanceof THREE.Material) material_release(material as THREE.Material);
}

/**
 * What one field made: each thing is added to the scene through here, and
 * all of it is let go together when the scene is redrawn.
 *
 * @example
 * const made: Made = new Made();
 * made.thing_add(parent, mesh);
 * made.all_release();
 */
export class Made {
  private readonly things: Set<THREE.Object3D> = new Set<THREE.Object3D>();

  /**
   * Adds a drawn object to the scene and keeps it as made here.
   *
   * @param parent - Where it is drawn.
   * @param thing - The object.
   * @returns The object.
   *
   * @example
   * const mesh: THREE.Mesh = made.thing_add(parent, new THREE.Mesh(geometry, material));
   */
  public thing_add<T extends THREE.Object3D>(parent: THREE.Object3D, thing: T): T {
    parent.add(thing);
    this.things.add(thing);
    return thing;
  }

  /**
   * Forgets one object without letting it go: its field has let it go itself.
   *
   * @param thing - The object.
   *
   * @example
   * made.thing_forget(mesh);
   */
  public thing_forget(thing: THREE.Object3D): void {
    this.things.delete(thing);
  }

  /**
   * Takes everything made out of the scene and lets it go.
   *
   * @example
   * made.all_release();
   */
  public all_release(): void {
    for (const thing of this.things) {
      thing.removeFromParent();
      drawn_release(thing);
    }
    this.things.clear();
  }
}
