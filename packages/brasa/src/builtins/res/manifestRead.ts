/**
 * @file Reading a manifest for `play`: from the backend's files, or from the
 * engine's own disk when the backend says the path is not its own and the
 * disk is the operator's.
 *
 * Apart from `play.ts` so the three answers a read can end in (read, not
 * found, refused or failed) can be held to their rule without a session.
 *
 * @module
 */
import { errorStack, type PathStanding } from '@fnndsc/fond';
import { backendInstalled_get } from '../../core/backend.js';
import { hostDisk_refusal } from '../../core/hostGate.js';
import { path_resolve } from '../utils.js';

/** Reads a file of the engine's disk as text. */
export type DiskRead = (target: string) => Promise<string>;

/**
 * The file system's own read.
 *
 * @param target - The path on the engine's disk.
 * @returns The file's text.
 */
async function disk_readText(target: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(target, 'utf8');
}

/** A manifest's text and where it was read, or the words for why it was not. */
export type ManifestRead =
  | { readonly ok: true; readonly value: { text: string; from: string } }
  | { readonly ok: false; readonly reason: string };

/**
 * The words a failed read of the backend's files left: the refusal's own
 * line when it carries one, else the error's message.
 *
 * @param error - What the read threw.
 * @returns One line.
 */
function readFailure_say(error: unknown): string {
  const named: { reason?: unknown } = (error ?? {}) as { reason?: unknown };
  if (typeof named.reason === 'string' && named.reason !== '') return named.reason;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a manifest, from the backend's filesystem (ChRIS: CFS) or from the
 * engine's own disk.
 *
 * A manifest is a ChRIS file: that is what makes one shareable, and sharing
 * it is `setfacl`, like any other file. But a repository's battery lives
 * beside the code that it tests, and uploading itself before it can run
 * would be a ritual, not a requirement — so a path that names no file of
 * the backend's is looked for on the host the ENGINE runs on. In a daemon
 * that is the daemon's disk, never the surface's.
 *
 * Two things stand between a failed read and that disk. The backend must
 * say the path is none of its own or is proved absent (`files.standing`):
 * a refusal, an outage or a listing that came back short is said as what
 * it is, and the disk is not read behind it. And the disk must be the
 * operator's (`hostDisk_refusal`): where it is nobody's, the answer says
 * so and names the tier.
 *
 * @param target - The manifest, as the operator wrote it.
 * @param disk_read - How the engine's disk is read; the file system's own unless a test counts the reads.
 * @returns The text and where it came from, or why neither has it.
 *
 * @example
 * ```ts
 * const source: ManifestRead = await manifestText_read('~/flows/battery.mise');
 * if (!source.ok) return envelope_error('', undefined, `play: ${source.reason}\n`);
 * ```
 */
export async function manifestText_read(target: string, disk_read: DiskRead = disk_readText): Promise<ManifestRead> {
  const resolved: string = await path_resolve(target);
  const files = backendInstalled_get()?.files;
  let absentFromBackend: boolean = false;
  if (files !== undefined) {
    // Asking the backend is how we find out whether the manifest lives
    // there. Its notes about a miss are drained: left on the stack they made
    // a play that ran a host-side battery perfectly exit non-zero.
    const mark: number = errorStack.checkpoint_mark();
    try {
      const bytes: Buffer = await files.read(resolved);
      return { ok: true, value: { text: bytes.toString('utf8'), from: resolved } };
    } catch (error: unknown) {
      errorStack.checkpoint_drain(mark);
      // A standing that cannot be had is not a proof of anything.
      const standing: PathStanding = files.standing !== undefined ? await files.standing(resolved).catch((): PathStanding => 'unknown') : 'unknown';
      errorStack.checkpoint_drain(mark);
      if (standing === 'unknown') {
        return { ok: false, reason: `cannot read ${target} — ${readFailure_say(error)}; the engine's disk was not looked at, since the session's own files did not say it is absent` };
      }
      absentFromBackend = standing === 'absent';
    }
  }

  const where: string = absentFromBackend ? `no such manifest in the session's filesystem` : `${target} is not in the session's filesystem`;
  const refused: string | null = hostDisk_refusal('play');
  if (refused !== null) {
    return { ok: false, reason: `cannot read ${target} — ${where}, and beside the engine it was not looked for: ${refused.replace(/^play: /, '')}` };
  }
  try {
    const text: string = await disk_read(target);
    return { ok: true, value: { text, from: target } };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `cannot read ${target} — ${where}, and none beside the engine.` };
    }
    return { ok: false, reason: `cannot read ${target} — ${where}, and beside the engine it could not be read (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))})` };
  }
}
