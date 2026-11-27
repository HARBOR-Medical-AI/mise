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

/**
 * Keeps a token for the page that is about to be loaded afresh. It is kept
 * for this tab only and is taken out again by the first thing that page
 * does; it is never put in the address.
 *
 * @param storage - The tab's session storage.
 * @param token - The token.
 * @returns Whether it was kept; where it could not be, the fresh page shows the form again.
 *
 * @example
 * retryToken_keep(window.sessionStorage, token);
 * window.location.reload();
 */
export function retryToken_keep(storage: Storage, token: string): boolean {
  try {
    storage.setItem(RETRY_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes the token a page before this one kept for it, and removes it.
 *
 * @param storage - The tab's session storage.
 * @returns The token, or null when none was kept.
 *
 * @example
 * const retry: string | null = retryToken_take(window.sessionStorage);
 */
export function retryToken_take(storage: Storage): string | null {
  try {
    const token: string | null = storage.getItem(RETRY_KEY);
    if (token !== null) storage.removeItem(RETRY_KEY);
    return token;
  } catch {
    return null;
  }
}
