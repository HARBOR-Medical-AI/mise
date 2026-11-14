/**
 * @file The room a berth's disk has, read from the filesystem itself.
 */
import { describe, it, expect } from '@jest/globals';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { freeBytes_get } from '../src/builtins/berth/berthDisk.js';

describe('freeBytes_get', () => {
  it('is the blocks free to an unprivileged user times their size', () => {
    const stats = statfsSync(tmpdir());
    expect(freeBytes_get(tmpdir())).toBe(Number(stats.bavail) * Number(stats.bsize));
    expect(freeBytes_get(tmpdir())).toBeGreaterThan(0);
  });
});
