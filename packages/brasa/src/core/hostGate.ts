/**
 * @file The host gate: whether a session may reach the engine's own host.
 *
 * An engine may be attended from elsewhere, by a surface that does not own
 * the machine it runs on. Its host is reached three ways, and the surface
 * says which it may: the disk (`engineFilesystem`, the `files` tier), a
 * program (`engineProcesses`, the `shell` tier), and a long task beyond the
 * host with its local tools (`tasks`, granted only by the operator's flag or
 * an elevation). A command that would reach one asks here first, before it
 * touches anything, so the refusal's words are one and do not say whether
 * what it would have touched is there.
 *
 * Key components:
 * - `hostDisk_refusal`: the engine's disk.
 * - `hostProcess_refusal`: a program on the engine's host.
 * - `hostTasks_refusal`: a long task beyond it.
 *
 * Typical usage:
 * ```ts
 * const refused: string | null = hostProcess_refusal('plugin add from an image (docker)');
 * if (refused !== null) return envelope_error('', undefined, `${refused}\n`);
 * ```
 *
 * Dependencies: the active surface (`surface_get`). `scripts/host-gate.mjs` holds every engine source that imports
 * `fs` or `child_process` to a reason, and pins the calls to these refusals.
 *
 * @module
 */
import { surface_get } from './surface.js';

/**
 * Why a command may not touch the engine's own disk, when it may not.
 *
 * The engine's disk is the operator's only where the surface says so
 * (`engineFilesystem`): a local shell, or a daemon started with the files
 * tier of host control. Anywhere else it is the disk of a machine nobody
 * attending the session sits at, and a command that would read or write it
 * says this instead, naming itself and the tier. Every such command asks
 * here, so the words are one.
 *
 * @param what - What is asking, as the operator would name it (`play`, `redirect (>)`).
 * @returns The refusal, or null when the disk is the operator's.
 *
 * @example
 * ```ts
 * const refused: string | null = hostDisk_refusal('play');
 * if (refused !== null) return envelope_error('', undefined, `${refused}\n`);
 * ```
 */
export function hostDisk_refusal(what: string): string | null {
  if (surface_get().capabilities.engineFilesystem) return null;
  return `${what}: the session's host disk is nobody's; start the session with --host-control=files`;
}

/**
 * Why a command may not start a program on the engine's own host, when it
 * may not. A program there (docker, say) runs as the engine's account on a
 * machine nobody attending the session may own: only an in-process local
 * shell, or a daemon whose operator granted the `shell` tier, may.
 *
 * @param what - What is asking, as the operator would name it (`plugin add from an image (docker)`).
 * @returns The refusal, or null when the host's programs are the operator's.
 *
 * @example
 * ```ts
 * const refused: string | null = hostProcess_refusal('plugin add from an image (docker)');
 * ```
 */
export function hostProcess_refusal(what: string): string | null {
  if (surface_get().capabilities.engineProcesses === true) return null;
  return `${what}: this session may not start programs on its host; start the session with --host-control=shell`;
}

/**
 * Why a command may not start a long task beyond the engine's host (stratus's
 * ssh, tofu, kubectl), when it may not: only the operator's flag or an
 * elevation grants the `tasks` tier.
 *
 * @param what - What is asking, as the operator would name it.
 * @returns The refusal, or null when the session may start tasks.
 *
 * @example
 * ```ts
 * const refused: string | null = hostTasks_refusal('vm build');
 * ```
 */
export function hostTasks_refusal(what: string): string | null {
  if (surface_get().capabilities.tasks === true) return null;
  return `${what}: this session may not start tasks; start the session with --host-control=tasks`;
}
