/**
 * @file Surface capabilities: the input/interaction seam a host provides.
 *
 * The output sink (`./sink.js`) lets a host decide where a command's output
 * goes. This module is its input-side counterpart: it lets a host declare
 * what *interaction* it can offer — prompting for a line, reading a secret
 * without echo, opening a local editor — and lets a builtin ask for a
 * capability and fail with a clear message when the attached surface cannot
 * provide it, rather than hanging on a standard input that is not there.
 *
 * The CLI host backs this with readline and the local `$EDITOR`; a future
 * daemon backs it with request messages to a remote surface, and a surface
 * that cannot (say) open a local editor simply declares `localEdit: false`.
 *
 * Capabilities the surface can act on directly (prompting) are methods here;
 * capabilities a builtin still performs itself (local editing, whose editor
 * mechanics remain in the `edit` builtin until a remote surface needs its
 * own implementation) are declared as flags a builtin gates on via
 * {@link capability_require}. This module is deliberately free of Node
 * built-ins so it stays trivially testable and host-agnostic; the readline
 * implementation lives in `./cliSurface.js`.
 *
 * @see docs/calypso.adoc — "Interactivity is a declared surface capability".
 * @module
 */




// The delivery request and result cross the wire, so they are declared once in
// the contract package and named here rather than repeated. Where a surface
// gets the bytes is its own business: the local CLI reads through the
// in-process engine, a remote CLI and a browser both fetch the daemon's
// token-gated byte route. Pushing bytes through the session bus instead would
// base64 a DICOM series across a channel meant for session state.
export type { FileDeliverRequest, FileDeliverResult, PromptKind, PromptPath } from '@fnndsc/menu';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FileDeliverRequest, FileDeliverResult, PromptKind, PromptPath } from '@fnndsc/menu';

// The interfaces themselves are menu's (`@fnndsc/menu/surface`): the contract
// the engine, its hosts and its surfaces all meet. The implementations and the
// installed instance stay here.
import type { SurfaceCapabilities, PromptRequest, LocalEditRequest, LocalEditResult, SurfacePeer, Surface } from '@fnndsc/menu/surface';
export type { SurfaceCapabilities, PromptRequest, LocalEditRequest, LocalEditResult, SurfacePeer, Surface } from '@fnndsc/menu/surface';



/**
 * Raised when a builtin requests an interaction the attached surface cannot
 * provide. Carries the capability name so a host can present it uniformly.
 */
export class CapabilityError extends Error {
  /** The capability that was required but absent. */
  public readonly capability: keyof SurfaceCapabilities;

  /**
   * @param capability - The missing capability.
   * @param message - Human-readable explanation.
   */
  constructor(capability: keyof SurfaceCapabilities, message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.capability = capability;
  }
}

/**
 * The default surface for a host that has not installed one: it can do
 * nothing interactive and says so clearly. This is the correct default for
 * an unknown host — a CLI host replaces it (see `./cliSurface.js`), and any
 * attempt to prompt or edit before a real surface is installed fails loudly
 * instead of hanging.
 */
export class HeadlessSurface implements Surface {
  /** @inheritdoc */
  public readonly capabilities: SurfaceCapabilities = {
    hiddenInput: false,
    localEdit: false,
    tty: false,
    color: false,
    pipeSegments: false,
    shellCommands: false,
    fileDelivery: false,
    engineFilesystem: false,
    localFilesystem: false,
    engineProcesses: false,
  };

  /** @inheritdoc */
  public prompt(_request: PromptRequest): Promise<string> {
    throw new CapabilityError('tty', 'This surface cannot prompt for input.');
  }

  /** @inheritdoc */
  public pipeSegment(_command: string, _input: Buffer, _signal?: AbortSignal): Promise<Buffer> {
    throw new CapabilityError('pipeSegments', 'This surface cannot run pipeline segments.');
  }

  /** @inheritdoc */
  public shellCommand(_command: string, _signal?: AbortSignal): Promise<number> {
    throw new CapabilityError('shellCommands', 'This surface cannot run shell commands.');
  }

  /** @inheritdoc */
  public localEdit(_request: LocalEditRequest): Promise<LocalEditResult> {
    throw new CapabilityError('localEdit', 'This surface cannot open a local editor.');
  }

  /** @inheritdoc */
  public fileDeliver(_request: FileDeliverRequest): Promise<FileDeliverResult> {
    throw new CapabilityError('fileDelivery', 'This surface cannot receive a file.');
  }
}

/** The active surface. Defaults to headless until a host installs one. */
let activeSurface: Surface = new HeadlessSurface();

/** A surface standing in for the host's on one async path (a joblet's). */
const surfaceScope: AsyncLocalStorage<Surface> = new AsyncLocalStorage<Surface>();

/**
 * Returns the surface the code runs under: the one standing in on this
 * async path, else the installed one.
 *
 * @returns The surface.
 */
export function surface_get(): Surface {
  return surfaceScope.getStore() ?? activeSurface;
}

/**
 * The installed surface, whatever stands in for it on this path.
 *
 * @returns The host's surface.
 */
export function surfaceInstalled_get(): Surface {
  return activeSurface;
}

/**
 * Runs work under a surface standing in for the installed one.
 *
 * @param surface - The stand-in.
 * @param operation - The work.
 * @returns What the work returns.
 */
export async function surfaceScope_run<T>(surface: Surface, operation: () => Promise<T>): Promise<T> {
  return await surfaceScope.run(surface, operation);
}

/**
 * Installs a surface. Called by the host that owns the interaction channel.
 *
 * @param surface - The surface to install.
 * @returns The previously installed surface, so callers can restore it.
 */
export function surface_set(surface: Surface): Surface {
  const previous: Surface = activeSurface;
  activeSurface = surface;
  return previous;
}

/**
 * Waits without holding the session, where the host can step a command out
 * of its turn (`Surface.aside`); elsewhere it simply waits.
 *
 * @param waiting - What the command waits on.
 * @returns What it resolved with.
 */
export function aside_await<T>(waiting: Promise<T>): Promise<T> {
  const surface: Surface = surface_get();
  return surface.aside !== undefined ? surface.aside(waiting) : waiting;
}

/**
 * Asserts that the active surface has a capability, throwing a
 * {@link CapabilityError} with a clear message when it does not.
 *
 * @param capability - The capability the caller needs.
 * @param message - The message to present when it is absent.
 * @throws {CapabilityError} When the active surface lacks the capability.
 */
export function capability_require(
  capability: keyof SurfaceCapabilities,
  message: string,
): void {
  if (!activeSurface.capabilities[capability]) {
    throw new CapabilityError(capability, message);
  }
}
