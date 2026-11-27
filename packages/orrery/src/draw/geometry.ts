/**
 * @file The shapes the drawers share: halos, shells of points, spheres.
 *
 * @module
 */
import * as THREE from 'three';

import { shared_mark } from './release.js';

/**
 * A halo's radius by the feeds it gathers: room for a few, more for a crowd,
 * never so much it swallows the neighbouring cluster.
 *
 * @param count - The feeds of the shape.
 * @returns The radius in scene units.
 */
export function haloRadius_compute(count: number): number {
  return 1.6 + 0.45 * Math.sqrt(Math.max(1, count));
}

/** The k-th of n points on a fibonacci sphere of the given radius. */
export function fibonacciPoint_make(k: number, n: number, radius: number): THREE.Vector3 {
  const golden: number = Math.PI * (3 - Math.sqrt(5));
  const y: number = n === 1 ? 0 : 1 - (2 * k) / (n - 1);
  const ring: number = Math.sqrt(Math.max(0, 1 - y * y));
  const angle: number = golden * k;
  return new THREE.Vector3(Math.cos(angle) * ring * radius, y * radius, Math.sin(angle) * ring * radius);
}

/**
 * Sphere geometries shared by radius: one per size a scene draws, not one
 * per node (thousands of identical spheres each built their own, and a
 * rebuild paid for every one).
 */
export class SphereGeometries {
  private readonly byKey: Map<number, THREE.SphereGeometry> = new Map();

  /**
   * The sphere of a radius, built once.
   *
   * @param radius - The radius, kept to a thousandth.
   * @returns The shared geometry.
   */
  public of(radius: number): THREE.SphereGeometry {
    const key: number = Math.round(radius * 1000);
    let geometry: THREE.SphereGeometry | undefined = this.byKey.get(key);
    if (geometry === undefined) {
      geometry = shared_mark(new THREE.SphereGeometry(key / 1000, 24, 18));
      geometry.computeBoundingSphere();
      this.byKey.set(key, geometry);
    }
    return geometry;
  }

  /** Lets every geometry go. */
  public dispose(): void {
    for (const geometry of this.byKey.values()) geometry.dispose();
    this.byKey.clear();
  }
}
