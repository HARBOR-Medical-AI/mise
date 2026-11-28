/**
 * @file A door whose injected requests come from the door's own page.
 *
 * The door takes a password, and anything on its cookie, only from a page
 * of its own origin. The routes' tests are about what the routes do once
 * a request is the door's; this stands each test at the door, as a
 * browser there would be. What the door does with a request from
 * elsewhere is `origin.test.ts`'s, which uses the builder bare.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { porterApp_build, type PorterApp } from '../../src/app.js';
import { GrantStore } from '../../src/grants.js';

/** The origin a door on port 0 answers as (the tests' config). */
export const DOOR_ORIGIN: string = 'http://127.0.0.1:0';

type Build = typeof porterApp_build;

/**
 * Builds a door whose `inject` sends the door's origin unless a test set one.
 *
 * @param options - The builder's options.
 * @returns The door.
 */
export const doorApp_build: Build = async (options: Parameters<Build>[0]): Promise<PorterApp> => {
  // The door's grants in a folder of the test's own, never the config's shared state folder.
  const grants: GrantStore = options.grants ?? new GrantStore(join(mkdtempSync(join(tmpdir(), 'porter-door-grants-')), 'door-grants.json'), options.config.cookieHours);
  const door: PorterApp = await porterApp_build({ ...options, grants });
  const inject = door.app.inject.bind(door.app) as (asked: unknown) => unknown;
  (door.app as unknown as { inject: (asked: unknown) => unknown }).inject = (asked: unknown): unknown => {
    if (typeof asked !== 'object' || asked === null) return inject(asked);
    const one = asked as { headers?: Record<string, unknown> };
    return inject({ ...one, headers: { origin: DOOR_ORIGIN, ...(one.headers ?? {}) } });
  };
  return door;
};
