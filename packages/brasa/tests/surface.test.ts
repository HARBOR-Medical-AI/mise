/**
 * @file Tests for the surface-capability seam: the registry, capability
 * gating, and the headless default's clear failures.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  surface_get,
  surface_set,
  capability_require,
  CapabilityError,
  HeadlessSurface,
  type Surface,
} from '../src/core/surface.js';

/** A surface with all capabilities, recording the prompts it received. */
function fullSurface_create(): Surface & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    capabilities: {
      hiddenInput: true,
      localEdit: true,
      tty: true,
      pipeSegments: true,
      shellCommands: true,
    },
    pipeSegment: async (_c: string, i: Buffer): Promise<Buffer> => i,
    shellCommand: async (_command: string): Promise<number> => 0,
    localEdit: async (r): Promise<{ content: string; changed: boolean }> => ({ content: r.content, changed: false }),
    prompt: async (request): Promise<string> => {
      prompts.push(request.message);
      return 'answer';
    },
  };
}

beforeEach(() => {
  surface_set(new HeadlessSurface());
});

describe('surface registry', () => {
  it('defaults to a headless surface', () => {
    expect(surface_get()).toBeInstanceOf(HeadlessSurface);
  });

  it('installs a surface and returns the previous one', () => {
    const first: Surface = surface_get();
    const previous: Surface = surface_set(fullSurface_create());
    expect(previous).toBe(first);
    expect(surface_get().capabilities.tty).toBe(true);
  });
});

describe('capability_require', () => {
  it('passes when the active surface has the capability', () => {
    surface_set(fullSurface_create());
    expect(() => capability_require('localEdit', 'nope')).not.toThrow();
  });

  it('throws a CapabilityError naming the capability when absent', () => {
    surface_set(new HeadlessSurface());
    try {
      capability_require('localEdit', 'edit: cannot edit here');
      throw new Error('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).capability).toBe('localEdit');
      expect((err as CapabilityError).message).toBe('edit: cannot edit here');
    }
  });
});

describe('HeadlessSurface', () => {
  it('cannot prompt and says so', () => {
    const surface: HeadlessSurface = new HeadlessSurface();
    expect(surface.capabilities).toEqual({
      hiddenInput: false,
      localEdit: false,
      tty: false,
      color: false,
      pipeSegments: false,
      shellCommands: false,
      fileDelivery: false,
      engineFilesystem: false,
      engineProcesses: false,
      localFilesystem: false,
    });
    expect(() => surface.prompt({ message: 'x' })).toThrow(CapabilityError);
    expect(() => surface.fileDeliver({ path: '/x', filename: 'x' })).toThrow(CapabilityError);
    expect(() => (surface as unknown as { shellCommand(command: string): Promise<number> })
      .shellCommand('pwd')).toThrow(CapabilityError);
  });
});

describe('an installed surface', () => {
  it('receives prompt requests through the registry', async () => {
    const surface = fullSurface_create();
    surface_set(surface);
    const answer: string = await surface_get().prompt({ message: 'Name?' });
    expect(answer).toBe('answer');
    expect(surface.prompts).toEqual(['Name?']);
  });
});
