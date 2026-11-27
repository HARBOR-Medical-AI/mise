/**
 * @file The page's start: one attach at a time, and a second attempt in
 * place after a refusal, or from a clean page after a failure once wiring
 * had begun.
 *
 * The surface attaches before it wires anything (main.ts, surface_start):
 * an attach that is refused has wired nothing, and the next attempt is made
 * on the same page. Wiring a page twice doubled every listener, and a toggle
 * then fired twice and seemed to do nothing; so a start that failed after
 * the attach was acknowledged (the wiring threw, or the session went away
 * before the surface was ready: `AttachWiredError`) leaves the page at once
 * for a clean one, with the form and the reason (`failReason_keep`).
 *
 * Key components:
 * - {@link attachStart_make}: makes the page's `start`.
 * - {@link AttachWiredError}: a start that failed once wiring had begun.
 * - {@link surfaceStart_run}: the start in order: attach held, wire, release, READY.
 * - {@link failReason_keep} and {@link failReason_take}: carry why a start failed to the clean page.
 * - {@link retryToken_keep} and {@link retryToken_take}: carry the token over the reload.
 *
 * Typical usage:
 * - `const start = attachStart_make(ports)`; the attach form's button and its Enter key both call `start(token)`.
 *
 * Dependencies:
 * - the surface's own start, and the page's form, handed in as ports
 *
 * @module
 */

import type { AttachedSession } from '../calypso/client.js';

/**
 * What the start is made of.
 *
 * @example
 * const ports: AttachStartPorts = { surface_start, form_hide, form_show, page_clean };
 */
export interface AttachStartPorts {
  /** Attaches the surface, then wires it; rejects when the attach is refused or the daemon cannot be reached (nothing wired), or with an `AttachWiredError` when wiring had begun. */
  surface_start: (token: string) => Promise<void>;
  /** Hides the attach form: the surface is up. */
  form_hide: () => void;
  /** Shows the attach form with why the attach failed. */
  form_show: (reason: string) => void;
  /** Leaves this page, which holds what was wired, for a clean one showing its form and why. */
  page_clean: (reason: string) => void;
}

/**
 * A start that failed once the surface had begun wiring itself (the attach
 * was acknowledged, then the wiring threw or the session went away before
 * the surface was ready). The page holds what was wired, so the next
 * attempt is made by a page loaded afresh.
 *
 * @example
 * ```ts
 * throw new AttachWiredError(cause);
 * ```
 */
export class AttachWiredError extends Error {
  /**
   * @param cause - What went wrong.
   */
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AttachWiredError';
  }
}

/**
 * Makes the page's start.
 *
 * While an attach is in flight, another is not begun. The surface attaches
 * before it wires anything, so an attach that was refused leaves nothing
 * wired, and the next attempt is made in place. One that failed after
 * wiring had begun leaves the page wired: it is left at once for a clean
 * page that shows the form and why.
 *
 * @param ports - The surface's start and the form.
 * @returns The start: call it with the token to attach with.
 *
 * @example
 * const start = attachStart_make(ports);
 * button.addEventListener('click', (): void => { start(input.value.trim()); });
 */
export function attachStart_make(ports: AttachStartPorts): (token: string) => void {
  let starting: boolean = false;
  return (token: string): void => {
    if (starting) return;
    starting = true;
    ports.surface_start(token).then(
      (): void => {
        starting = false;
        ports.form_hide();
      },
      (error: unknown): void => {
        const reason: string = error instanceof Error ? error.message : String(error);
        // Wired, then failed: this page holds listeners and timers that are not to run on. It is left at
        // once for a clean one with the form and the reason; nothing else starts here meanwhile.
        if (error instanceof AttachWiredError) { ports.page_clean(reason); return; }
        // Refused before anything was wired: the form, here, takes the next attempt.
        starting = false;
        ports.form_show(reason);
      },
    );
  };
}

/**
 * What a page's wiring gives back: how to say it is ready, once what was held has been handed over.
 *
 * @example
 * ```ts
 * return { ready_show: () => { mode_show('READY'); } };
 * ```
 */
export interface SurfaceWired {
  /** Says the surface is ready. */
  ready_show: () => void;
}

/**
 * What the start sequence is made of.
 *
 * @example
 * ```ts
 * const ports: SurfaceStartPorts = { attach_held, backend_ask, surface_wire };
 * ```
 */
export interface SurfaceStartPorts {
  /** Attaches, held: nothing reaches a handler until it is released. */
  attach_held: (token: string) => Promise<AttachedSession>;
  /** Which backend the session runs over, when the attach did not say: asked of the daemon. */
  backend_ask: (token: string) => Promise<string>;
  /** Wires the page to the attached session, all at once: installs its handlers, binds its client, applies the attach's facts. */
  surface_wire: (token: string, held: AttachedSession, backend: string) => SurfaceWired;
}

/**
 * The page's start, in order: attach (held); learn the backend when the
 * attach did not say it (raced against a close); wire the page, all at once, which installs
 * the handlers and applies what the attach said, while the session's own
 * messages wait; then hand those over, in order, so a later word of the
 * session wins over the attach's; then say READY. A close while the page
 * is still setting up settles the start at once. Anything that fails after
 * the attach was acknowledged abandons the client (handlers taken away,
 * socket closed) and fails with an `AttachWiredError`; nothing says READY.
 *
 * @param token - The attach token.
 * @param ports - The attach and the wiring.
 * @returns Resolves when the surface is ready.
 * @throws {Error} When the attach is refused or cannot be made (nothing wired); an `AttachWiredError` after it.
 *
 * @example
 * ```ts
 * await surfaceStart_run(token, { attach_held, backend_ask, surface_wire });
 * ```
 */
export async function surfaceStart_run(token: string, ports: SurfaceStartPorts): Promise<void> {
  const held: AttachedSession = await ports.attach_held(token);
  try {
    // The one thing the start waits on before it wires (which backend, when the attach did not say), raced
    // against the socket's close: a close settles the start, and an answer after it wires nothing.
    const backend: string = held.attach.backend ?? await Promise.race([ports.backend_ask(token), held.client.held_closed()]);
    if (held.client.held_isClosed()) throw new Error('the daemon closed the connection before the surface was ready');
    // From here the wiring runs to its end with nothing to wait for: no close can come in between.
    const wired: SurfaceWired = ports.surface_wire(token, held, backend);
    held.client.held_release();
    wired.ready_show();
  } catch (error: unknown) {
    held.client.held_abandon();
    throw new AttachWiredError(error);
  }
}

/**
 * Whether the attach form may be submitted. Behind a door the door holds
 * the token, and the page attaches with none: an empty form is a retry
 * through the door. Elsewhere a token must be given.
 *
 * @param token - What the form holds, trimmed.
 * @param throughDoor - Whether the page stands behind a door.
 * @returns True when it may be submitted.
 *
 * @example
 * ```ts
 * attachSubmit_allowed('', true); // true: through the door
 * ```
 */
export function attachSubmit_allowed(token: string, throughDoor: boolean): boolean {
  return token.length > 0 || throughDoor;
}

/** Where the reason a start failed is kept over the move to a clean page, for that one load. */
const REASON_KEY: string = 'argus.attach.reason';

/**
 * Keeps why a start failed, for the clean page this one is about to leave for.
 *
 * @param storage - The tab's storage, asked for when used (a tab may refuse it).
 * @param reason - Why.
 * @param place - The page and daemon it is for (`retryPlace_name`).
 * @returns True when it was kept.
 *
 * @example
 * ```ts
 * failReason_keep(() => window.sessionStorage, 'the daemon closed the connection', place);
 * ```
 */
export function failReason_keep(storage: () => Storage, reason: string, place: string): boolean {
  try {
    storage().setItem(REASON_KEY, JSON.stringify({ reason, page: place }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes why the start before this page failed, once, when it was for this page.
 *
 * @param storage - The tab's storage, asked for when used.
 * @param place - This page and its daemon.
 * @returns The reason, or null.
 *
 * @example
 * ```ts
 * const reason: string | null = failReason_take(() => window.sessionStorage, place);
 * ```
 */
export function failReason_take(storage: () => Storage, place: string): string | null {
  try {
    const kept: string | null = storage().getItem(REASON_KEY);
    storage().removeItem(REASON_KEY);
    if (kept === null) return null;
    const read: unknown = JSON.parse(kept);
    if (read === null || typeof read !== 'object') return null;
    const { reason, page } = read as Partial<Record<'reason' | 'page', unknown>>;
    return typeof reason === 'string' && page === place ? reason : null;
  } catch {
    return null;
  }
}

/** Where the token for the attempt after a reload is kept, for that one load. */
const RETRY_KEY: string = 'argus.attach.retry';

/** What is kept over the reload: the token, and the page it is for. */
interface RetryHandoff {
  /** The token to attach with. */
  token: string;
  /** The page that kept it and the daemon it attaches to: its path and its socket's address. Another mount on the same origin in this tab, or the same page pointed at another daemon, does not take it. */
  page: string;
}

/**
 * Names the place a handoff is for: the page's path and the address of the
 * daemon's socket it attaches to. One page can be pointed at another daemon
 * (`?ws=`), and a token for one daemon is not handed to the other.
 *
 * @param path - The page's path.
 * @param socket - The socket address the page attaches to, as resolved.
 * @returns The place, as one string.
 *
 * @example
 * const place: string = retryPlace_name(window.location.pathname, wsUrl_resolve());
 */
export function retryPlace_name(path: string, socket: string): string {
  return `${path}\n${socket}`;
}

/**
 * Keeps a token for the page that is about to be loaded afresh. It is kept
 * for this tab only, for the page at this path only, and is taken out again
 * by the first thing that page does; it is never put in the address.
 *
 * @param storageReach - Reaches the tab's session storage; reaching it can itself be refused, so it is asked for here.
 * @param token - The token.
 * @param page - The place it is for (see {@link retryPlace_name}).
 * @returns Whether it was kept; where it could not be, the caller sends the fresh page to its form.
 *
 * @example
 * if (retryToken_keep((): Storage => window.sessionStorage, token, window.location.pathname)) window.location.reload();
 */
export function retryToken_keep(storageReach: () => Storage, token: string, page: string): boolean {
  try {
    const handoff: RetryHandoff = { token, page };
    storageReach().setItem(RETRY_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes the token a page before this one kept for it, and removes it. What
 * was kept is removed whoever it was for: a handoff is used once or not at
 * all, and one left behind by another page does not wait for a later load.
 *
 * @param storageReach - Reaches the tab's session storage.
 * @param page - This page's place (see {@link retryPlace_name}).
 * @returns The token, or null when none was kept for this page (or the storage cannot be reached).
 *
 * @example
 * const retry: string | null = retryToken_take((): Storage => window.sessionStorage, window.location.pathname);
 */
export function retryToken_take(storageReach: () => Storage, page: string): string | null {
  try {
    const storage: Storage = storageReach();
    const kept: string | null = storage.getItem(RETRY_KEY);
    if (kept === null) return null;
    storage.removeItem(RETRY_KEY);
    const handoff: unknown = JSON.parse(kept);
    if (typeof handoff !== 'object' || handoff === null) return null;
    const { token, page: forPage } = handoff as Partial<RetryHandoff>;
    return typeof token === 'string' && forPage === page ? token : null;
  } catch {
    return null;
  }
}

/** The mark in a page's address that says: show the form, and attach with nothing until a token is typed. */
export const MANUAL_PARAM: string = 'attach';

/**
 * The address a retry goes to when the token for it could not be kept: this
 * page, with no token in it and marked for its form. The fresh page then
 * attaches with nothing of its own accord (not a token the daemon has
 * already refused, and not a door that has), and the token typed there is
 * that page's first attempt. Everything else of the address is kept, the
 * fragment a link carries included.
 *
 * @param path - The page's path.
 * @param search - The page's query string.
 * @param hash - The page's fragment, with its `#`, or empty.
 * @returns The address to go to.
 *
 * @example
 * window.location.replace(addressManual_derive(window.location.pathname, window.location.search, window.location.hash));
 */
export function addressManual_derive(path: string, search: string, hash: string): string {
  const params: URLSearchParams = new URLSearchParams(search);
  params.delete('token');
  params.set(MANUAL_PARAM, 'manual');
  return `${path}?${params.toString()}${hash}`;
}

/**
 * Says whether an address names the document the page already is: the same
 * path and the same query. Going to such an address, whatever its fragment,
 * loads no new document.
 *
 * @param address - The address to go to: path, query and fragment.
 * @param path - The page's path.
 * @param search - The page's query string.
 * @returns True when the address is this document's.
 *
 * @example
 * if (addressSame_check(address, window.location.pathname, window.location.search)) window.location.reload();
 */
export function addressSame_check(address: string, path: string, search: string): boolean {
  const bare: string = address.split('#')[0] ?? '';
  const mark: number = bare.indexOf('?');
  const toPath: string = mark === -1 ? bare : bare.slice(0, mark);
  const toQuery: string = mark === -1 ? '' : bare.slice(mark + 1);
  return toPath === path && new URLSearchParams(toQuery).toString() === new URLSearchParams(search).toString();
}

/** A page that attaches as it loads. */
interface BootAttach {
  /** What it does. */
  kind: 'attach';
  /** The token it attaches with; empty behind a door, which holds the token itself. */
  token: string;
}

/** A page that shows its form as it loads. */
interface BootForm {
  /** What it does. */
  kind: 'form';
}

/** What a page does when it loads: attach with a token, or show its form. */
export type BootChoice = BootAttach | BootForm;

/**
 * What a page that has just loaded does about attaching.
 *
 * A token handed over by the page before it comes first. A page marked for
 * its form shows the form, whatever else its address says. Otherwise a
 * token in the address attaches with it, a page behind a door attaches
 * with nothing (the door holds the token), and any other page shows the
 * form.
 *
 * @param retryToken - The token the page before kept for this one, or null.
 * @param search - The page's query string.
 * @param throughDoor - Whether the page is behind a door.
 * @returns The choice.
 *
 * @example
 * const choice: BootChoice = bootChoice_derive(retryToken_take(storage, place), window.location.search, throughDoor);
 */
export function bootChoice_derive(retryToken: string | null, search: string, throughDoor: boolean): BootChoice {
  if (retryToken !== null) return { kind: 'attach', token: retryToken };
  const params: URLSearchParams = new URLSearchParams(search);
  if (params.get(MANUAL_PARAM) === 'manual') return { kind: 'form' };
  const urlToken: string | null = params.get('token');
  if (urlToken !== null && urlToken.length > 0) return { kind: 'attach', token: urlToken };
  if (throughDoor) return { kind: 'attach', token: '' };
  return { kind: 'form' };
}
