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
  /** The path of the page that kept it: another mount on the same origin in this tab does not take it. */
  page: string;
}

/**
 * Keeps a token for the page that is about to be loaded afresh. It is kept
 * for this tab only, for the page at this path only, and is taken out again
 * by the first thing that page does; it is never put in the address.
 *
 * @param storageReach - Reaches the tab's session storage; reaching it can itself be refused, so it is asked for here.
 * @param token - The token.
 * @param page - The path of the page it is for.
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
 * @param page - The path of this page.
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

/**
 * The address of this page with no token in it: where a retry goes when
 * the token for it could not be kept, so that the fresh page shows its form
 * and does not try again a token the daemon has already refused.
 *
 * @param path - The page's path.
 * @param search - The page's query string.
 * @returns The path and what is left of the query.
 *
 * @example
 * window.location.replace(addressClean_derive(window.location.pathname, window.location.search));
 */
export function addressClean_derive(path: string, search: string): string {
  const params: URLSearchParams = new URLSearchParams(search);
  params.delete('token');
  const rest: string = params.toString();
  return rest === '' ? path : `${path}?${rest}`;
}
