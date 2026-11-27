/**
 * @file The page's start: one attach at a time, and a second attempt
 * after a failed one from a clean page.
 *
 * The surface wires its listeners and timers before it attaches, so an
 * attach that is refused leaves the page wired; wiring it again for the
 * next attempt doubled every listener, and a toggle then fired twice and
 * seemed to do nothing. Here an attempt in flight is the only one, and an
 * attempt after a failure is made by a page loaded afresh.
 *
 * Key components:
 * - {@link attachStart_make}: makes the page's `start`.
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

/**
 * What the start is made of.
 *
 * @example
 * const ports: AttachStartPorts = { surface_start, form_hide, form_show, page_restart };
 */
export interface AttachStartPorts {
  /** Wires the surface and attaches it; rejects when the attach is refused or the daemon cannot be reached. */
  surface_start: (token: string) => Promise<void>;
  /** Hides the attach form: the surface is up. */
  form_hide: () => void;
  /** Shows the attach form with why the attach failed. */
  form_show: (reason: string) => void;
  /** Loads the page afresh and has it attach with this token. */
  page_restart: (token: string) => void;
}

/**
 * Makes the page's start.
 *
 * While an attach is in flight, another is not begun. After an attach has
 * failed, the page it left wired is not wired again: the next attempt
 * restarts the page.
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
  let failed: boolean = false;
  return (token: string): void => {
    if (starting) return;
    if (failed) {
      // Claimed before the page is asked to restart: the reload is not instant, and Enter and the button
      // pressed together before it commits must not each keep a token and ask for a reload. The first wins.
      starting = true;
      ports.page_restart(token);
      return;
    }
    starting = true;
    ports.surface_start(token).then(
      (): void => {
        starting = false;
        ports.form_hide();
      },
      (error: unknown): void => {
        starting = false;
        failed = true;
        ports.form_show(error instanceof Error ? error.message : String(error));
      },
    );
  };
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
