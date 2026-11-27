/**
 * @file Nebulae: the soft glow a cluster wears while the scene draws stars.
 *
 * @module
 */

import * as THREE from 'three';

import { shared_mark } from './release.js';

/** A soft radial glow, shared by every nebula. */
let nebulaTexture: THREE.Texture | null = null;

/** Draws (once) the nebula's radial glow. */
export function nebulaTexture_get(): THREE.Texture {
  if (nebulaTexture !== null) return nebulaTexture;
  const canvas: HTMLCanvasElement = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context: CanvasRenderingContext2D | null = canvas.getContext('2d');
  if (context !== null) {
    const gradient: CanvasGradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  nebulaTexture = shared_mark(new THREE.CanvasTexture(canvas));
  return nebulaTexture;
}
