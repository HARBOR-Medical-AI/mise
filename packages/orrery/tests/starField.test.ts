/**
 * @file The star field: stars drawn in two layers with their slots kept,
 * a molecule's stars and threads faded as it turns solid, nebulae marked,
 * and everything forgotten on a redraw.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as THREE from 'three';
import { held_watch, held_left, type HeldWatch } from './support/heldWatch.js';
import { StarField } from '../src/draw/starField.js';
import type { StarEntry } from '../src/draw/stars.js';

beforeAll(() => {
  // A nebula's glow is drawn on a canvas; there is no page here.
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

const star = (id: string, ember: boolean): StarEntry => ({ id, position: new THREE.Vector3(1, 2, 3), radius: 0.5, color: new THREE.Color(1, 1, 1), dim: false, ember });

describe('StarField', () => {
  it('draws glow and embers as two layers, keeping each star\'s place', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.draw([star('a', false), star('b', true), star('c', false)], 2, 1000, 90);
    expect(field.count()).toBe(3);
    expect(parent.children.length).toBe(2);
    expect(field.entry('b')?.layer).toBe(1);
    expect(field.entry('c')?.slot).toBe(1);
    expect([...field.ids()].sort()).toEqual(['a', 'b', 'c']);
    const material = (parent.children[0] as THREE.Points).material as THREE.ShaderMaterial;
    expect(material.uniforms['scale']?.value).toBeCloseTo(500, 9);
  });

  it('fades a molecule\'s stars and threads, and shows the fade once flushed', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    const entries: StarEntry[] = [star('a', false), star('b', false)];
    field.draw(entries, 1, 800, 50);
    field.threads_draw([0, 0, 0, 1, 1, 1, 0, 0, 0, 2, 2, 2], [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const points = parent.children[0] as THREE.Points;
    const alpha = points.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    const lines = parent.children[1] as THREE.LineSegments;
    const color = lines.geometry.getAttribute('color') as THREE.BufferAttribute;
    const versionBefore: number = alpha.version;
    field.stars_fade([entries[1] as StarEntry], 0.25);
    field.threads_fade([1], 0);
    expect(alpha.getX(0)).toBe(1);
    expect(alpha.getX(1)).toBe(0.25);
    expect(Array.from(color.array).slice(6)).toEqual([0, 0, 0, 0, 0, 0]);
    field.flush();
    expect(alpha.version).toBeGreaterThan(versionBefore);
  });

  it('marks a cluster with a nebula, dimmed at a third', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.nebula_add('shape:x', new THREE.Vector3(5, 0, 0), 3, new THREE.Color(1, 0.5, 0), true);
    expect(field.nebulae()).toEqual([{ id: 'shape:x', position: new THREE.Vector3(5, 0, 0), radius: 3 }]);
    const sprite = parent.children[0] as THREE.Sprite;
    expect(sprite.scale.x).toBe(6);
    expect(sprite.material.opacity).toBeCloseTo(0.2 / 3, 9);
  });

  it('lets go of what it drew at a redraw: both layers of stars, the threads and each nebula\'s material; the one nebula glow is kept', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.draw([star('a', false), star('b', true)], 1, 800, 50);
    field.threads_draw([0, 0, 0, 1, 1, 1], [1, 1, 1, 1, 1, 1]);
    field.nebula_add('shape:x', new THREE.Vector3(5, 0, 0), 3, new THREE.Color(1, 0.5, 0), false);
    const nebula = parent.children.find((one) => one instanceof THREE.Sprite) as THREE.Sprite;
    const glow: THREE.Texture | null = nebula.material.map;
    const watch: HeldWatch = held_watch(parent);
    expect(watch.held.size).toBeGreaterThanOrEqual(8);
    field.clear();
    expect(parent.children.length).toBe(0);
    // Left: the glow every nebula is drawn with, and the shape every sprite is drawn with.
    expect(new Set(held_left(watch))).toEqual(new Set([glow, nebula.geometry]));
  });

  it('forgets everything on a redraw', () => {
    const field = new StarField(new THREE.Group());
    field.draw([star('a', false)], 1, 800, 50);
    field.clear();
    expect(field.count()).toBe(0);
    expect(field.entry('a')).toBeUndefined();
    expect(field.nebulae()).toEqual([]);
  });

  it('hides and shows a node\'s stars and nebula for a replay, and flashes an arrival', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.draw([star('a', false), star('b', true)], 1, 800, 50);
    field.nebula_add('a', new THREE.Vector3(), 2, new THREE.Color(1, 1, 1), false);
    const sprite = parent.children.find((child) => child instanceof THREE.Sprite) as THREE.Sprite;
    const resting = sprite.material.opacity;
    field.presence_set(['a', 'b'], 0);
    field.flush();
    const glow = (parent.children[0] as THREE.Points).geometry;
    const ember = (parent.children[1] as THREE.Points).geometry;
    expect(glow.getAttribute('alpha').getX(0)).toBe(0);
    expect(ember.getAttribute('alpha').getX(0)).toBe(0);
    expect(sprite.material.opacity).toBe(0);
    field.presence_set(['a'], 1);
    field.flash_set('a', 0.75);
    expect(glow.getAttribute('alpha').getX(0)).toBe(1);
    expect(glow.getAttribute('flash').getX(0)).toBe(0.75);
    expect(sprite.material.opacity).toBe(resting);
  });

  it('shows a thread only once both its ends are present', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.draw([star('a', false), star('b', false), star('c', false)], 1, 800, 50);
    field.threads_draw([0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2], [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], ['a', 'b', 'b', 'c']);
    field.threads_present((id: string): boolean => id !== 'c');
    const colors = ((parent.children.find((child) => child instanceof THREE.LineSegments) as THREE.LineSegments).geometry.getAttribute('color').array) as Float32Array;
    expect([...colors.slice(0, 6)]).toEqual([1, 1, 1, 1, 1, 1]);
    expect([...colors.slice(6, 12)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('threads given a wave carry it as a tube does: on the clock, faded with the thread, gated when hidden', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.draw([star('a', false), star('b', false), star('c', false)], 1, 800, 50);
    field.threads_draw(
      [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2],
      [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      ['a', 'b', 'b', 'c'],
      { modes: [2, 1], starts: [0, 450], cycle: 4000 },
    );
    expect(field.threadsCarryWave()).toBe(true);
    const lines = parent.children.find((child) => child instanceof THREE.LineSegments) as THREE.LineSegments;
    const material = lines.material as THREE.ShaderMaterial;
    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.fragmentShader).toContain('pulse_at');
    // The wave is gated by the thread's own light: a faded thread carries none.
    expect(material.fragmentShader).toContain('lit');
    expect([...(lines.geometry.getAttribute('aMode').array as Float32Array)]).toEqual([2, 2, 1, 1]);
    expect([...(lines.geometry.getAttribute('aStart').array as Float32Array)]).toEqual([0, 0, 450, 450]);
    expect([...(lines.geometry.getAttribute('aAlong').array as Float32Array)]).toEqual([0, 1, 0, 1]);
    // The fades write the same colours the wave shader reads.
    field.threads_present((id: string): boolean => id !== 'c');
    expect([...(lines.geometry.getAttribute('aColor').array as Float32Array).slice(6, 12)]).toEqual([0, 0, 0, 0, 0, 0]);
    field.frame(9_876);
    expect(material.uniforms['time']?.value).toBe(9_876);
    field.clear();
    expect(field.threadsCarryWave()).toBe(false);
  });

  it('threads without a wave rest as plain lines', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.threads_draw([0, 0, 0, 1, 1, 1], [1, 1, 1, 1, 1, 1]);
    expect(field.threadsCarryWave()).toBe(false);
    expect((parent.children[0] as THREE.LineSegments).material).toBeInstanceOf(THREE.LineBasicMaterial);
    expect(() => field.frame(1)).not.toThrow();
  });

  it('draws a ringed star in a layer of its own, over the glow and the embers', () => {
    const parent = new THREE.Group();
    const field = new StarField(parent);
    field.draw([star('a', false), star('b', true), { ...star('p', false), ring: true }], 1, 800, 50);
    expect(parent.children.length).toBe(3);
    expect(field.entry('p')?.layer).toBe(2);
    const ring = parent.children[2] as THREE.Points;
    expect(ring.renderOrder).toBe(3);
    expect((ring.material as THREE.ShaderMaterial).fragmentShader).toContain('ring');
  });
});
