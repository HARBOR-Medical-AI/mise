/**
 * @file The room a berth's disk has: the bytes free on the filesystem that
 * holds a folder.
 *
 * Key components:
 * - freeBytes_get: the bytes an unprivileged user may still write there.
 *
 * Typical usage:
 * ```ts
 * const room: number = freeBytes_get('/anchors');
 * ```
 *
 * Dependencies: Node.js built-ins only (`statfs`).
 *
 * @module
 */
import { statfsSync, type StatsFs } from 'node:fs';

/**
 * The bytes free on the filesystem holding a folder, for an unprivileged
 * user: the blocks available to one, not those kept for root.
 *
 * @param folder - The folder.
 * @returns Free bytes.
 *
 * @example
 * ```ts
 * freeBytes_get('/anchors'); // 85899345920
 * ```
 */
export function freeBytes_get(folder: string): number {
  const stats: StatsFs = statfsSync(folder);
  return Number(stats.bavail) * Number(stats.bsize);
}
