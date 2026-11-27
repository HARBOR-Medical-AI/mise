/**
 * @file Tubes: the lit cylinders a solid edge wears, carrying a pulse from parent to child — streaming into a live stage, replaying a finished run.
 *
 * @module
 */

import * as THREE from 'three';

import { shared_mark } from './release.js';
import { PULSE_TRIP_MS } from './timing.js';

/**
 * The most job-to-job edges a census draws as tubes. Past it the census
 * keeps its lines: a lab's whole history is hundreds of thousands of
 * edges, and that many cylinders would stall the tablet it is read on.
 */
export const CENSUS_TUBE_CAP: number = 20_000;

export const TUBE_VERTEX: string = `
attribute vec3 aColor;
attribute float aMode;
attribute float aStart;
varying vec3 vColor;
varying float vMode;
varying float vStart;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vAlong = position.y + 0.5;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vColor = aColor;
  vMode = aMode;
  vStart = aStart;
  gl_Position = projectionMatrix * mv;
}`;

/**
 * The wave a connection carries, from parent (along 0) to child (along 1):
 * mode 1 streams (live), mode 2 replays the run — each stage at its start
 * into a cycle that rests and repeats — mode 0 rests. Tubes and the
 * census's lines carry the same wave, so information reads as travelling
 * down a connection whichever way it is drawn.
 */
const PULSE_GLSL: string = `
uniform float time;
uniform float born;
uniform float cycle;
float pulse_at(float along, float mode, float start) {
  if (mode > 0.5 && mode < 1.5) {
    float head = fract(time / ${PULSE_TRIP_MS.toFixed(1)});
    return smoothstep(0.14, 0.0, abs(along - head));
  }
  if (mode > 1.5) {
    // A finished feed replays its run: the wave goes stage by stage in the
    // order the stages ran, rests, and goes again.
    float local = mod(time - born, cycle) - start;
    float head = local / ${(PULSE_TRIP_MS / 2).toFixed(1)};
    if (head > -0.1 && head < 1.2) return smoothstep(0.14, 0.0, abs(along - head));
  }
  return 0.0;
}`;

/** A tube lit by its facing, carrying the wave from its foot to its head. */
export const TUBE_FRAGMENT: string = `
uniform float opacity;
${PULSE_GLSL}
varying vec3 vColor;
varying float vMode;
varying float vStart;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  vec3 base = vColor * (0.35 + 0.65 * facing);
  float pulse = pulse_at(vAlong, vMode, vStart);
  gl_FragColor = vec4(base + vec3(1.0, 0.95, 0.8) * pulse * 1.3, opacity);
}`;

/** A census line: each vertex says how far along its connection it stands. */
export const LINE_VERTEX: string = `
attribute vec3 aColor;
attribute float aMode;
attribute float aStart;
attribute float aAlong;
varying vec3 vColor;
varying float vMode;
varying float vStart;
varying float vAlong;
void main() {
  vColor = aColor;
  vMode = aMode;
  vStart = aStart;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * A line at rest is a faint thread; where the wave passes it burns bright,
 * and opaque enough to read over the cloud. A line faded to nothing (a
 * replay's thread before its ends arrive, a molecule handing off) carries
 * no wave either: the pulse is gated by the line's own light.
 */
export const LINE_FRAGMENT: string = `
uniform float opacity;
${PULSE_GLSL}
varying vec3 vColor;
varying float vMode;
varying float vStart;
varying float vAlong;
void main() {
  float lit = smoothstep(0.0, 0.04, max(vColor.r, max(vColor.g, vColor.b)));
  float pulse = pulse_at(vAlong, vMode, vStart) * lit;
  gl_FragColor = vec4(vColor + vec3(1.0, 0.95, 0.8) * pulse * 1.3, min(1.0, opacity + pulse));
}`;

/** How a batch of wave-carrying lines rests: its opacity, and whether it adds light (stars). */
export interface LineRest {
  tint: number;
  opacity: number;
  additive: boolean;
}

/**
 * The material every wave-carrying line batch draws with: the census's
 * lines and the stars' threads alike, on the tubes' clock.
 *
 * @param cycle - The replay's period, in ms.
 * @param rest - How the lines rest.
 * @returns The material.
 */
export function lineMaterial_make(cycle: number, rest: LineRest): THREE.ShaderMaterial {
  const now: number = performance.now();
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: now }, opacity: { value: rest.opacity }, born: { value: now }, cycle: { value: cycle } },
    vertexShader: LINE_VERTEX,
    fragmentShader: LINE_FRAGMENT,
    transparent: true,
    depthWrite: !rest.additive,
    ...(rest.additive ? { blending: THREE.AdditiveBlending } : {}),
  });
}

/**
 * The wave attributes a line batch carries, two vertices a line: its mode,
 * when the wave sets off along it, and how far along it each end stands.
 *
 * @param geometry - The batch's geometry; the attributes are set on it.
 * @param modes - One mode a line (0 rests, 1 streams, 2 replays).
 * @param starts - One start a line, into the replay's cycle.
 */
export function lineWave_set(geometry: THREE.BufferGeometry, modes: ReadonlyArray<number>, starts: ReadonlyArray<number>): void {
  const count: number = modes.length;
  const perVertexMode: Float32Array = new Float32Array(count * 2);
  const perVertexStart: Float32Array = new Float32Array(count * 2);
  const along: Float32Array = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    perVertexMode[i * 2] = modes[i] ?? 0;
    perVertexMode[i * 2 + 1] = modes[i] ?? 0;
    perVertexStart[i * 2] = starts[i] ?? 0;
    perVertexStart[i * 2 + 1] = starts[i] ?? 0;
    along[i * 2 + 1] = 1;
  }
  geometry.setAttribute('aMode', new THREE.Float32BufferAttribute(perVertexMode, 1));
  geometry.setAttribute('aStart', new THREE.Float32BufferAttribute(perVertexStart, 1));
  geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
}

/** The tube every solid edge wears, stretched and turned per edge. */
let tubeGeometry: THREE.CylinderGeometry | null = null;

/** A unit tube, one high along y, centred: its foot at -0.5, its head at +0.5. */
export function tubeGeometry_get(): THREE.CylinderGeometry {
  if (tubeGeometry === null) tubeGeometry = shared_mark(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true));
  return tubeGeometry;
}

/** One tube: where it runs, how wide, its hue, and its pulse. */
export interface TubeSpec {
  from: THREE.Vector3;
  to: THREE.Vector3;
  width: number;
  color: THREE.Color;
  /** 0 rests, 1 streams (a live stage), 2 replays (a finished run). */
  mode: number;
  /** When, into the replay's cycle, the wave sets off along it. */
  start: number;
}

/**
 * Makes one instanced mesh of tubes from their specs: the shared unit tube
 * stretched and turned per spec, each carrying its own hue and pulse.
 *
 * @param specs - The tubes.
 * @param cycle - The replay's period, in ms.
 * @returns The mesh, not yet added to anything.
 */
export function tubeMesh_make(specs: ReadonlyArray<TubeSpec>, cycle: number): THREE.InstancedMesh {
  const now: number = performance.now();
  const material: THREE.ShaderMaterial = new THREE.ShaderMaterial({
    uniforms: { time: { value: now }, opacity: { value: 1 }, born: { value: now }, cycle: { value: cycle } },
    vertexShader: TUBE_VERTEX,
    fragmentShader: TUBE_FRAGMENT,
    transparent: true,
  });
  const geometry: THREE.BufferGeometry = tubeGeometry_get().clone();
  const colors: Float32Array = new Float32Array(specs.length * 3);
  const modes: Float32Array = new Float32Array(specs.length);
  const starts: Float32Array = new Float32Array(specs.length);
  const mesh: THREE.InstancedMesh = new THREE.InstancedMesh(geometry, material, specs.length);
  const up: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
  const carrier: THREE.Object3D = new THREE.Object3D();
  specs.forEach((spec: TubeSpec, i: number): void => {
    const along: THREE.Vector3 = spec.to.clone().sub(spec.from);
    const length: number = along.length();
    carrier.position.copy(spec.from).addScaledVector(along, 0.5);
    carrier.quaternion.setFromUnitVectors(up, length > 0 ? along.divideScalar(length) : up);
    carrier.scale.set(spec.width, length, spec.width);
    carrier.updateMatrix();
    mesh.setMatrixAt(i, carrier.matrix);
    colors.set([spec.color.r, spec.color.g, spec.color.b], i * 3);
    modes[i] = spec.mode;
    starts[i] = spec.start;
  });
  geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  geometry.setAttribute('aMode', new THREE.InstancedBufferAttribute(modes, 1));
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Makes the census's lines from the tube specs they stand in for: one draw
 * for all of them, each carrying its hue and the same wave a tube would.
 * Lines take the place of tubes where there are too many to draw as
 * cylinders, and under stars, where they are the threads.
 *
 * @param specs - The connections.
 * @param cycle - The replay's period, in ms.
 * @param rest - The resting thread: its hue scale and opacity, and whether it adds light (stars).
 * @returns The lines, not yet added to anything.
 */
export function lineMesh_make(specs: ReadonlyArray<TubeSpec>, cycle: number, rest: LineRest): THREE.LineSegments {
  const positions: Float32Array = new Float32Array(specs.length * 6);
  const colors: Float32Array = new Float32Array(specs.length * 6);
  specs.forEach((spec: TubeSpec, i: number): void => {
    positions.set([spec.from.x, spec.from.y, spec.from.z, spec.to.x, spec.to.y, spec.to.z], i * 6);
    const r: number = spec.color.r * rest.tint;
    const g: number = spec.color.g * rest.tint;
    const b: number = spec.color.b * rest.tint;
    colors.set([r, g, b, r, g, b], i * 6);
  });
  const geometry: THREE.BufferGeometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  lineWave_set(geometry, specs.map((spec: TubeSpec): number => spec.mode), specs.map((spec: TubeSpec): number => spec.start));
  const lines: THREE.LineSegments = new THREE.LineSegments(geometry, lineMaterial_make(cycle, rest));
  lines.frustumCulled = false;
  return lines;
}
