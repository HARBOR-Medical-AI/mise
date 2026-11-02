/**
 * @file The door a session can be raised at (docs/stratus.adoc, D14). A
 * stratus session enters as READ; the first line that would act outside the
 * host asks the person's password once, the daemon checks it at the CUBE
 * door porter logged them in by, and that surface is MANAGE from then on.
 * The host that started the daemon names the door in the environment; a
 * daemon started without one cannot be raised, and says so.
 *
 * @module
 */

/** The door: whose password, and how it is checked. */
export interface ElevationDoor {
  /** The person, as the door knows them. */
  readonly user: string;
  /** Checks a password at the door; true when it is theirs. */
  readonly verify: (password: string) => Promise<boolean>;
}

/** The environment names the door a porter gives a daemon it starts. */
export const ELEVATION_URL_ENV: string = 'CALYPSO_ELEVATION_URL';
export const ELEVATION_USER_ENV: string = 'CALYPSO_ELEVATION_USER';

/**
 * Checks a password at a CUBE: `auth-token/` answers 200 with a token for
 * the right one, which is dropped unread; anything else is a refusal.
 *
 * @param cubeUrl - The CUBE's API root (`https://cube.example.org/api/v1/`).
 * @param username - The person.
 * @param password - What they typed.
 * @param fetcher - The fetch to use (a test's stand-in).
 * @returns True when the CUBE minted a token for it.
 */
export async function cubePassword_check(cubeUrl: string, username: string, password: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const url: string = `${cubeUrl.endsWith('/') ? cubeUrl : `${cubeUrl}/`}auth-token/`;
  try {
    const response: Response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The door from the environment, when the host named one.
 *
 * @param env - The environment.
 * @param fetcher - The fetch to use.
 * @returns The door, or null when none was named.
 */
export function elevation_read(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ElevationDoor | null {
  const url: string | undefined = env[ELEVATION_URL_ENV];
  const user: string | undefined = env[ELEVATION_USER_ENV];
  if (url === undefined || url === '' || user === undefined || user === '') return null;
  return { user, verify: (password: string): Promise<boolean> => cubePassword_check(url, user, password, fetcher) };
}
