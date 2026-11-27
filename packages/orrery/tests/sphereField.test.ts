/**
 * @file The sphere field: spheres, halos and plain edges drawn and found by
 * id; the node in hand lit; a changed state recoloured; edges following a
 * moved sphere; a sphere let go.
 */
import { describe, it, expect } from '@jest/globals';
import * as THREE from 'three';
import { held_watch, held_left, type HeldWatch } from './support/heldWatch.js';
import { SphereField } from '../src/draw/sphereField.js';
import { DIM_OPACITY, HALO_OPACITY } from '../src/draw/constants.js';

describe('SphereField', () => {
  it('draws spheres as handed: coloured, dimmed faint and scenery, a flat one a disc, a fading one faint', () => {
    const parent = new THREE.Group();
    const field = new SphereField(parent);
    const a = field.sphere_add('a', new THREE.Vector3(1, 0, 0), 0.5, { color: new THREE.Color(1, 0, 0) });
    const b = field.sphere_add('b', new THREE.Vector3(2, 0, 0), 0.5, { color: new THREE.Color(0, 1, 0), dim: true });
    const c = field.sphere_add('c', new THREE.Vector3(3, 0, 0), 0.5, { color: new THREE.Color(0, 0, 1), flat: true, selected: true });
    const d = field.sphere_add('d', new THREE.Vector3(4, 0, 0), 0.5, { color: new THREE.Color(1, 1, 1), fade: 0.3 });
    expect(field.map.get('a')).toBe(a);
    expect((a.material as THREE.MeshStandardMaterial).color.toArray()).toEqual([1, 0, 0]);
    expect(b.userData['dim']).toBe(true);
    expect((b.material as THREE.MeshStandardMaterial).opacity).toBe(DIM_OPACITY);
    expect(c.geometry).toBeInstanceOf(THREE.CircleGeometry);
    expect((c.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.35);
    // A disc sits ON its tubes: drawn after them, without the depth test a
    // tube's near face would win in the plane they share. A sphere keeps both.
    expect(c.renderOrder).toBe(2);
    expect((c.material as THREE.MeshStandardMaterial).depthTest).toBe(false);
    expect((c.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    expect((c.material as THREE.MeshStandardMaterial).opacity).toBe(1);
    expect(a.renderOrder).toBe(0);
    expect((a.material as THREE.MeshStandardMaterial).depthTest).toBe(true);
    expect((d.material as THREE.MeshStandardMaterial).opacity).toBe(0.3);
    expect(a.geometry).toBe(field.sphere_add('e', new THREE.Vector3(), 0.5, { color: new THREE.Color() }).geometry);
    expect(parent.children.length).toBe(5);
  });

  it('lets go of what it drew at a redraw: each sphere\'s material, a disc\'s geometry, halos and edges whole; the cached sphere shape is kept', () => {
    const parent = new THREE.Group();
    const field = new SphereField(parent);
    const round = field.sphere_add('a', new THREE.Vector3(1, 0, 0), 0.5, { color: new THREE.Color(1, 0, 0) });
    field.sphere_add('b', new THREE.Vector3(2, 0, 0), 0.5, { color: new THREE.Color(0, 1, 0) });
    field.sphere_add('c', new THREE.Vector3(3, 0, 0), 0.5, { color: new THREE.Color(0, 0, 1), flat: true });
    field.halo_add('shape:x', new THREE.Vector3(), 3, new THREE.Color(1, 0.5, 0), false);
    field.edge_add('a', 'b', new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Color(1, 1, 1), false);
    field.edge_add('a', 'c', new THREE.Vector3(1, 0, 0), new THREE.Vector3(3, 0, 0), new THREE.Color(1, 1, 1), true);
    const watch: HeldWatch = held_watch(parent);
    // Five drawn things with a material each, and four geometries of their own beside the one shared.
    expect(watch.held.size).toBe(6 + 5);
    field.clear();
    expect(parent.children.length).toBe(0);
    // The one thing left is the sphere shape the two round spheres share: the cache's, let go with the scene.
    expect(held_left(watch)).toEqual([round.geometry]);
    field.dispose();
    expect(held_left(watch)).toEqual([]);
  });

  it('marks a cluster with a halo that is picked only when nothing solid is', () => {
    const field = new SphereField(new THREE.Group());
    field.halo_add('shape:x', new THREE.Vector3(), 3, new THREE.Color(1, 0.5, 0), false);
    const halo = field.map.get('shape:x') as THREE.Mesh;
    expect(halo.userData['halo']).toBe(true);
    expect((halo.material as THREE.MeshBasicMaterial).opacity).toBe(HALO_OPACITY);
  });

  it('lights the node in hand and no other', () => {
    const field = new SphereField(new THREE.Group());
    field.sphere_add('a', new THREE.Vector3(), 0.5, { color: new THREE.Color() });
    field.sphere_add('b', new THREE.Vector3(), 0.5, { color: new THREE.Color(), selected: true });
    field.select('a');
    const intensity = (id: string): number => ((field.map.get(id) as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveIntensity;
    expect([intensity('a'), intensity('b')]).toEqual([0.35, 0]);
  });

  it('recolours a changed state and lets its lamp re-read it', () => {
    const field = new SphereField(new THREE.Group());
    const mesh = field.sphere_add('a', new THREE.Vector3(), 0.5, { color: new THREE.Color(1, 1, 1) });
    mesh.userData['lampBase'] = new THREE.Color();
    const red = new THREE.Color(1, 0, 0);
    field.recolor('a', red);
    expect((mesh.material as THREE.MeshStandardMaterial).color).toBe(red);
    expect(mesh.userData['lampBase']).toBeUndefined();
  });

  it('keeps plain edges on their spheres as they move', () => {
    const field = new SphereField(new THREE.Group());
    const a = field.sphere_add('a', new THREE.Vector3(0, 0, 0), 0.5, { color: new THREE.Color() });
    field.sphere_add('b', new THREE.Vector3(0, 2, 0), 0.5, { color: new THREE.Color() });
    field.edge_add('a', 'b', new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2, 0), new THREE.Color(), true, true);
    a.position.set(5, 0, 0);
    field.edges_follow();
    const line = field.map.get('a')?.parent?.children.find((o) => o instanceof THREE.Line) as THREE.Line;
    expect(Array.from(line.geometry.getAttribute('position').array).slice(0, 3)).toEqual([5, 0, 0]);
  });

  it('lets a sphere go and forgets all on a redraw', () => {
    const parent = new THREE.Group();
    const field = new SphereField(parent);
    const mesh = field.sphere_add('a', new THREE.Vector3(), 0.5, { color: new THREE.Color() });
    field.remove(mesh);
    expect(field.map.has('a')).toBe(false);
    expect(parent.children.length).toBe(0);
    field.sphere_add('b', new THREE.Vector3(), 0.5, { color: new THREE.Color() });
    field.clear();
    expect(field.map.size).toBe(0);
    field.dispose();
  });
});
