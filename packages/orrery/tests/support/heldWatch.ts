/**
 * @file A watch on what a drawn scene holds on the graphics card: every
 * geometry, material and texture under a parent, and which of them have
 * been let go.
 */
import * as THREE from 'three';

/** What was held under a parent when the watch began, and what has been disposed since. */
export interface HeldWatch {
  held: Set<object>;
  disposed: Set<object>;
}

/**
 * Begins watching everything held under a parent.
 *
 * @param parent - The scene's group.
 * @returns What is held, and (filled as they fire) what has been disposed.
 */
export function held_watch(parent: THREE.Object3D): HeldWatch {
  const watch: HeldWatch = { held: new Set(), disposed: new Set() };
  const note = (thing: { addEventListener: (type: 'dispose', heard: () => void) => void }): void => {
    if (watch.held.has(thing)) return;
    watch.held.add(thing);
    thing.addEventListener('dispose', (): void => { watch.disposed.add(thing); });
  };
  parent.traverse((one: THREE.Object3D): void => {
    // An instanced mesh holds its instances on the card itself, and says so when it lets them go.
    if (one instanceof THREE.InstancedMesh) note(one as unknown as { addEventListener: (type: 'dispose', heard: () => void) => void });
    const drawn = one as THREE.Object3D & { geometry?: unknown; material?: unknown };
    if (drawn.geometry instanceof THREE.BufferGeometry) note(drawn.geometry);
    for (const material of Array.isArray(drawn.material) ? drawn.material : [drawn.material]) {
      if (!(material instanceof THREE.Material)) continue;
      note(material);
      const map: unknown = (material as THREE.Material & { map?: unknown }).map;
      if (map instanceof THREE.Texture) note(map);
    }
  });
  return watch;
}

/**
 * Says what of the held things was not disposed.
 *
 * @param watch - The watch.
 * @returns The things still held.
 */
export function held_left(watch: HeldWatch): object[] {
  return [...watch.held].filter((thing: object): boolean => !watch.disposed.has(thing));
}
