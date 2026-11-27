/**
 * @file Captions: words a surface pins to a node, drawn in the space.
 *
 * A hub the operator should read without hovering — "DICOM · 38", "SAG
 * MPRAGE · 12" — carries a caption: its text drawn once on a canvas, shown
 * as a sprite above the node, always facing the camera, one size on screen
 * however far away. A dimmed node's caption dims with it. Where captions
 * meet on screen the bigger node's is read and the smaller's gives way: its
 * words are a hover away, and words drawn over words are read as neither.
 *
 * @module
 */
import * as THREE from 'three';

import { Made, drawn_release } from './release.js';

/**
 * A caption's height on screen, as a share of the view's height: the same
 * at any distance, so a hub is read from afar and not shouted at up close.
 * Sized in the space instead, a caption three units tall was under three
 * pixels across a space of several hundred.
 */
export const CAPTION_SCREEN_HEIGHT: number = 0.028;
/** The opacity of a caption on a dimmed node. */
const CAPTION_DIM: number = 0.25;
/**
 * The plate behind a caption's words: dark, mostly opaque, so the words
 * read over the brightest cloud. Bare words were lost on a phone over a
 * nebula of four hundred feeds.
 */
const CAPTION_PLATE: string = 'rgba(0, 0, 0, 0.7)';
/** Pixels of text height on the canvas a caption is drawn on. */
const CANVAS_TEXT_PX: number = 48;

/** One caption as drawn. */
interface Caption {
  sprite: THREE.Sprite;
  texture: THREE.Texture;
  /** Which caption wins where two meet: the greater. */
  rank: number;
}

/** A caption's box on screen, in normalised device coordinates. */
interface ScreenBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** The captions of one scene. */
export class LabelField {
  private captions: Map<string, Caption> = new Map();
  /** Whether captions are shown at all: the operator may want the picture bare. */
  private shown: boolean = true;

  /** What this field drew, let go together at a redraw. */
  private readonly made: Made = new Made();

  /**
   * @param parent - Where the captions are drawn.
   */
  constructor(private readonly parent: THREE.Object3D) {}

  /** @returns How many captions are drawn. */
  public count(): number {
    return this.captions.size;
  }

  /**
   * Pins a caption above a node.
   *
   * @param id - The node.
   * @param text - The words.
   * @param position - Where the node stands.
   * @param radius - How far it reaches: the caption stands just above it.
   * @param color - The words' colour.
   * @param dim - Drawn faint, with its node.
   * @param rank - Which caption wins where two meet on screen: the greater.
   */
  public caption_add(id: string, text: string, position: THREE.Vector3, radius: number, color: THREE.Color, dim: boolean, rank: number = 0): void {
    const canvas: HTMLCanvasElement = document.createElement('canvas');
    const context: CanvasRenderingContext2D | null = canvas.getContext('2d');
    const font: string = `600 ${CANVAS_TEXT_PX}px sans-serif`;
    let width: number = text.length * CANVAS_TEXT_PX * 0.6;
    if (context !== null) {
      context.font = font;
      width = Math.ceil(context.measureText(text).width);
    }
    canvas.width = Math.max(1, width + CANVAS_TEXT_PX);
    canvas.height = Math.round(CANVAS_TEXT_PX * 1.5);
    if (context !== null) {
      // A resized canvas forgets its font.
      context.font = font;
      context.textBaseline = 'middle';
      const radius: number = canvas.height / 4;
      context.fillStyle = CAPTION_PLATE;
      context.beginPath();
      context.roundRect(0, 0, canvas.width, canvas.height, radius);
      context.fill();
      context.fillStyle = `#${color.getHexString()}`;
      context.fillText(text, CANVAS_TEXT_PX / 2, canvas.height / 2);
    }
    const texture: THREE.CanvasTexture = new THREE.CanvasTexture(canvas);
    const material: THREE.SpriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false, opacity: dim ? CAPTION_DIM : 0.9 });
    const sprite: THREE.Sprite = new THREE.Sprite(material);
    sprite.scale.set(CAPTION_SCREEN_HEIGHT * (canvas.width / canvas.height), CAPTION_SCREEN_HEIGHT, 1);
    // Anchored at its lower edge, just above the node's reach.
    sprite.center.set(0.5, 0);
    sprite.position.set(position.x, position.y + radius, position.z);
    // Over the stars and the nebulae: words are read, not glowed through.
    sprite.renderOrder = 4;
    // Drawn while captions are off, it stays hidden until they are on.
    sprite.visible = this.shown;
    this.made.thing_add(this.parent, sprite);
    // A caption drawn again for the same node replaces the one before, which is taken out and let go.
    const before: THREE.Sprite | undefined = this.captions.get(id)?.sprite;
    if (before !== undefined) {
      before.removeFromParent();
      this.made.thing_forget(before);
      drawn_release(before);
    }
    this.captions.set(id, { sprite, texture, rank });
  }

  /**
   * Shows each caption that meets no greater one on screen, and hides the
   * rest. Cheap enough for every frame: captions are few.
   *
   * @param camera - The camera the space is seen through.
   * @returns How many captions are shown.
   */
  public declutter(camera: THREE.PerspectiveCamera): number {
    if (!this.shown) return 0;
    const ordered: Caption[] = [...this.captions.values()].sort((a: Caption, b: Caption): number => b.rank - a.rank);
    const kept: ScreenBox[] = [];
    const at: THREE.Vector3 = new THREE.Vector3();
    // A sprite not sized by distance spans its scale times the projection's.
    const across: number = camera.projectionMatrix.elements[0] ?? 1;
    const up: number = camera.projectionMatrix.elements[5] ?? 1;
    for (const caption of ordered) {
      caption.sprite.getWorldPosition(at).project(camera);
      if (at.z > 1) {
        caption.sprite.visible = false;
        continue;
      }
      const halfWidth: number = (caption.sprite.scale.x * across) / 2;
      const box: ScreenBox = { left: at.x - halfWidth, right: at.x + halfWidth, bottom: at.y, top: at.y + caption.sprite.scale.y * up };
      const meets: boolean = kept.some((other: ScreenBox): boolean => box.left < other.right && other.left < box.right && box.bottom < other.top && other.bottom < box.top);
      caption.sprite.visible = !meets;
      if (!meets) kept.push(box);
    }
    return kept.length;
  }

  /**
   * Shows or hides every caption; each keeps its place and words.
   *
   * @param on - Shown.
   */
  public shown_set(on: boolean): void {
    this.shown = on;
    if (!on) for (const caption of this.captions.values()) caption.sprite.visible = false;
  }

  /** @returns Whether captions are shown. */
  public shown_get(): boolean {
    return this.shown;
  }

  /**
   * Lets go of every caption it drew, its texture and its material, and forgets them: the scene is being redrawn.
   *
   * @example
   * field.clear();
   */
  public clear(): void {
    this.made.all_release();
    this.captions = new Map();
  }
}
