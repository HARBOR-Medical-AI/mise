/**
 * @file Captions: words pinned above a node, facing the camera, sized with
 * it, faint with it, forgotten on a redraw, and giving way to a greater one
 * where two meet on screen.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as THREE from 'three';
import { held_watch, held_left, type HeldWatch } from './support/heldWatch.js';
import { LabelField, CAPTION_SCREEN_HEIGHT } from '../src/draw/labelField.js';

beforeAll(() => {
  // No page here: a canvas that draws nothing.
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

describe('LabelField', () => {
  it('pins a caption just above its node, one size on screen at any distance, and dims it with its node', () => {
    const parent = new THREE.Group();
    const labels = new LabelField(parent);
    labels.caption_add('hub', 'DICOM · 38', new THREE.Vector3(1, 2, 3), 10, new THREE.Color(1, 1, 1), false);
    labels.caption_add('small', 'MR', new THREE.Vector3(0, 0, 0), 0.5, new THREE.Color(1, 1, 1), true);
    expect(labels.count()).toBe(2);
    const [big, small] = parent.children as THREE.Sprite[];
    expect(big.position.y).toBe(12);
    expect(big.scale.y).toBe(CAPTION_SCREEN_HEIGHT);
    expect(small.scale.y).toBe(CAPTION_SCREEN_HEIGHT);
    expect(big.scale.x).toBeGreaterThan(big.scale.y);
    expect((big.material as THREE.SpriteMaterial).sizeAttenuation).toBe(false);
    expect((small.material as THREE.SpriteMaterial).opacity).toBe(0.25);
    expect((big.material as THREE.SpriteMaterial).opacity).toBe(0.9);
  });

  it('lets go of a caption\'s texture and material at a redraw, and of the caption it replaces when one is drawn again', () => {
    const parent = new THREE.Group();
    const labels = new LabelField(parent);
    labels.caption_add('a', 'A', new THREE.Vector3(), 1, new THREE.Color(), false);
    const first: HeldWatch = held_watch(parent);
    // Drawn again for the same node: the one before is taken out of the scene and let go.
    labels.caption_add('a', 'A again', new THREE.Vector3(), 1, new THREE.Color(), false);
    expect(parent.children.length).toBe(1);
    // What is left is the one shape every sprite is drawn with, which is three.js's own.
    const spriteShape: THREE.BufferGeometry = (parent.children[0] as THREE.Sprite).geometry;
    expect(held_left(first)).toEqual([spriteShape]);
    const second: HeldWatch = held_watch(parent);
    expect(second.held.size).toBe(3);
    labels.clear();
    expect(parent.children.length).toBe(0);
    expect(held_left(second)).toEqual([spriteShape]);
  });

  it('forgets every caption on a redraw', () => {
    const parent = new THREE.Group();
    const labels = new LabelField(parent);
    labels.caption_add('a', 'A', new THREE.Vector3(), 1, new THREE.Color(), false);
    labels.clear();
    expect(labels.count()).toBe(0);
  });

  it('shows the greater of two captions that meet on screen, and both when apart', () => {
    const parent = new THREE.Group();
    const labels = new LabelField(parent);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    labels.caption_add('small', 'SR · 3', new THREE.Vector3(0.5, 0, 0), 0, new THREE.Color(), false, 3);
    labels.caption_add('big', 'DICOM · 36', new THREE.Vector3(0, 0, 0), 0, new THREE.Color(), false, 36);
    labels.caption_add('far', 'NIfTI · 435', new THREE.Vector3(30, 20, 0), 0, new THREE.Color(), false, 435);
    parent.updateMatrixWorld();
    expect(labels.declutter(camera)).toBe(2);
    const [small, big, far] = parent.children as THREE.Sprite[];
    expect([small.visible, big.visible, far.visible]).toEqual([false, true, true]);
    small.position.set(-30, -20, 0);
    parent.updateMatrixWorld();
    expect(labels.declutter(camera)).toBe(3);
    expect(small.visible).toBe(true);
  });

  it('hides a caption behind the camera', () => {
    const parent = new THREE.Group();
    const labels = new LabelField(parent);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    labels.caption_add('behind', 'X', new THREE.Vector3(0, 0, 200), 0, new THREE.Color(), false);
    parent.updateMatrixWorld();
    expect(labels.declutter(camera)).toBe(0);
  });

  it('draws a dark plate behind the words, so they read over a bright cloud', () => {
    const calls: string[] = [];
    const context = {
      font: '', textBaseline: '', fillStyle: '',
      measureText: () => ({ width: 100 }),
      beginPath: () => calls.push('path'),
      roundRect: () => calls.push('plate'),
      fill: () => calls.push(`fill ${context.fillStyle}`),
      fillText: () => calls.push(`text ${context.fillStyle}`),
    };
    const saved = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
    try {
      new LabelField(new THREE.Group()).caption_add('hub', 'NIfTI · 435', new THREE.Vector3(), 1, new THREE.Color(1, 1, 1), false);
    } finally {
      (globalThis as { document?: unknown }).document = saved;
    }
    expect(calls).toEqual(['path', 'plate', 'fill rgba(0, 0, 0, 0.7)', 'text #ffffff']);
  });

  it('hides every caption when captions are off, and shows them again', () => {
    const parent = new THREE.Group();
    const labels = new LabelField(parent);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld();
    labels.caption_add('a', 'DICOM · 3', new THREE.Vector3(), 0, new THREE.Color(), false, 3);
    parent.updateMatrixWorld();
    labels.shown_set(false);
    expect(labels.declutter(camera)).toBe(0);
    expect((parent.children[0] as THREE.Sprite).visible).toBe(false);
    expect(labels.shown_get()).toBe(false);
    labels.caption_add('b', 'MR · 2', new THREE.Vector3(50, 50, 0), 0, new THREE.Color(), false, 2);
    expect((parent.children[1] as THREE.Sprite).visible).toBe(false);
    labels.shown_set(true);
    expect(labels.declutter(camera)).toBe(2);
    expect((parent.children[0] as THREE.Sprite).visible).toBe(true);
  });
});
