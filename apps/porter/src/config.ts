/**
 * @file What a porter is told, and what it assumes when it is not.
 *
 * A porter stands in front of ONE CUBE: the door asks for a username and a
 * password and never for a server, because a page that asks where to send
 * a password is a phishing form with a logo on it. The CUBE, the state
 * directory, the bind address and the chell to start are the deployment's
 * facts, read from the environment once at start.
 *
 * @module
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Everything a porter needs to know, resolved. */
export interface PorterConfig {
  /** The one CUBE this door serves, API base with its trailing slash. */
  cubeUrl: string;
  /** Where each identity's four directories live, one subtree per identity. */
  stateDir: string;
  /** The address the porter listens on; loopback unless a front says otherwise. */
  host: string;
  /** The port the porter listens on. */
  port: number;
  /** The chell entry to start a session with (`dist/index.js`). */
  chellEntry: string;
  /** What the door signs its cookie with. */
  secret: string;
  /** Whether the secret was made up at start: cookies die with this porter. */
  secretGenerated: boolean;
  /** How long a browser stays let in, in hours. */
  cookieHours: number;
  /** How long a session may stand with no surface on it before it is ended, in hours. */
  idleHours: number;
  /** How long a door token lives from its minting, in days; a fixed horizon, never slid. */
  tokenDays: number;
  /** The door's token store: hashes and names, mode 0600, in the porter's own state. */
  tokensFile: string;
  /**
   * A folder of sounds served in place of the page's own (`sounds/<name>`),
   * when the deployment has them: the original LCARS beeps, which may not
   * be redistributed and so are never in a package, kept outside the
   * install so an upgrade does not take them away. Null when none.
   */
  soundsDir: string | null;
  /**
   * Where sessions run: beside this porter (`local`, the default) or in
   * berths the berth launcher starts (`launcher`), when the deployment
   * turns it on; with it, where the launcher listens and the file holding
   * the secret porter carries to it.
   */
  berths: { mode: 'local' } | { mode: 'launcher'; listen: string; secretFile: string };
}

/** The environment variables a porter reads, and no others. */
export interface PorterEnv {
  PORTER_CUBE_URL?: string;
  PORTER_STATE_DIR?: string;
  PORTER_HOST?: string;
  PORTER_PORT?: string;
  PORTER_CHELL?: string;
  PORTER_SECRET?: string;
  PORTER_COOKIE_HOURS?: string;
  PORTER_IDLE_HOURS?: string;
  PORTER_TOKEN_DAYS?: string;
  PORTER_TOKENS_FILE?: string;
  PORTER_SOUNDS_DIR?: string;
  PORTER_BERTHS?: string;
  PORTER_LAUNCHER?: string;
  PORTER_LAUNCHER_SECRET_FILE?: string;
  XDG_STATE_HOME?: string;
}

/**
 * Where the door's token store is: `PORTER_TOKENS_FILE`, else beside the
 * session directories (which the adopt scan skips as a file). The CLI's
 * token verbs resolve it the same way the serving porter does.
 *
 * @param env - The environment.
 * @returns The file's path.
 */
export function porterTokensFile_resolve(env: PorterEnv): string {
  return env.PORTER_TOKENS_FILE !== undefined && env.PORTER_TOKENS_FILE.length > 0 ? env.PORTER_TOKENS_FILE : join(porterStateDir_resolve(env), 'tokens.json');
}

/** The port a porter takes when told none. */
export const PORTER_DEFAULT_PORT: number = 4180;

/**
 * How long a browser stays let in when the deployment does not say: a day,
 * the same span an idle session lives, so a cookie and the session it
 * names die together. CUBE's tokens carry no expiry of their own to follow.
 */
export const PORTER_DEFAULT_COOKIE_HOURS: number = 24;

/**
 * How long a session stands with nobody on it before the porter ends it:
 * a day, the same as the cookie, so the two die together. Ending is the
 * process only — the identity's state directory stays, and the next login
 * boots warm from it.
 */
export const PORTER_DEFAULT_IDLE_HOURS: number = 24;

/** How long a door token lives when the operator set nothing: a month, then a human logs in again. */
export const PORTER_DEFAULT_TOKEN_DAYS: number = 30;

/**
 * Finds the chell this porter will start sessions with: the one installed
 * beside it, by the package's own entry.
 *
 * @returns The absolute path of chell's entry script.
 */
export function chellEntry_locate(): string {
  const require: NodeRequire = createRequire(import.meta.url);
  return require.resolve('@fnndsc/chell');
}

/**
 * The stratus daemon's entry beside this porter, when stratus is installed:
 * what `:stratus oci` starts.
 *
 * @returns Its path, or null when this porter carries no stratus.
 */
export function stratusEntry_locate(): string | null {
  const require: NodeRequire = createRequire(import.meta.url);
  try {
    const manifest: string = require.resolve('@fnndsc/stratus/package.json');
    return join(dirname(manifest), 'dist', 'stratus.js');
  } catch {
    return null;
  }
}

/**
 * Where the porter keeps its sessions' state, from the environment alone.
 *
 * Asked separately because `porter --status` reads the directory and
 * starts nothing: it has no business demanding the CUBE, the port or a
 * secret it will not use.
 *
 * @param env - The environment; `process.env` in production.
 * @returns The state directory.
 */
export function porterStateDir_resolve(env: PorterEnv): string {
  const stateBase: string = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return env.PORTER_STATE_DIR ?? join(stateBase, 'porter');
}

/**
 * Resolves the porter's configuration from the environment.
 *
 * @param env - The environment; `process.env` in production.
 * @param locateChell - How to find chell when the environment does not say.
 * @returns The resolved configuration.
 * @throws {Error} When the one fact with no default — the CUBE — is missing
 *   or not a URL, or the port is not a number.
 */
export function porterConfig_resolve(env: PorterEnv, locateChell: () => string = chellEntry_locate): PorterConfig {
  const cubeUrl: string | undefined = env.PORTER_CUBE_URL;
  if (cubeUrl === undefined || cubeUrl.length === 0) {
    throw new Error('PORTER_CUBE_URL is required: the one CUBE this door serves, e.g. https://cube.example.org/api/v1/');
  }
  try {
    new URL(cubeUrl);
  } catch {
    throw new Error(`PORTER_CUBE_URL is not a URL: ${cubeUrl}`);
  }
  const portText: string = env.PORTER_PORT ?? String(PORTER_DEFAULT_PORT);
  const port: number = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORTER_PORT is not a port: ${portText}`);
  }
  const hoursText: string = env.PORTER_COOKIE_HOURS ?? String(PORTER_DEFAULT_COOKIE_HOURS);
  const cookieHours: number = Number(hoursText);
  if (!Number.isFinite(cookieHours) || cookieHours <= 0) {
    throw new Error(`PORTER_COOKIE_HOURS is not a span of hours: ${hoursText}`);
  }
  const idleText: string = env.PORTER_IDLE_HOURS ?? String(PORTER_DEFAULT_IDLE_HOURS);
  const idleHours: number = Number(idleText);
  if (!Number.isFinite(idleHours) || idleHours <= 0) {
    throw new Error(`PORTER_IDLE_HOURS is not a span of hours: ${idleText}`);
  }
  const daysText: string = env.PORTER_TOKEN_DAYS ?? String(PORTER_DEFAULT_TOKEN_DAYS);
  const tokenDays: number = Number(daysText);
  if (!Number.isFinite(tokenDays) || tokenDays <= 0) {
    throw new Error(`PORTER_TOKEN_DAYS is not a span of days: ${daysText}`);
  }
  const stateDir: string = porterStateDir_resolve(env);
  // A secret nobody set is made up here: the door still works, but every
  // browser is asked again when this porter restarts. Said out loud at start.
  const secretGiven: boolean = env.PORTER_SECRET !== undefined && env.PORTER_SECRET.length >= 20;
  if (env.PORTER_SECRET !== undefined && !secretGiven) {
    throw new Error('PORTER_SECRET is too short: give at least 20 characters, or none to have one made up per start');
  }
  // Berths are a deployment's choice, off unless it says: a porter on a workstation starts sessions beside itself.
  const berthsMode: string = env.PORTER_BERTHS ?? 'local';
  if (berthsMode !== 'local' && berthsMode !== 'launcher') throw new Error(`PORTER_BERTHS is local or launcher, not ${berthsMode}`);
  if (berthsMode === 'launcher' && (env.PORTER_LAUNCHER === undefined || env.PORTER_LAUNCHER === '' || env.PORTER_LAUNCHER_SECRET_FILE === undefined || env.PORTER_LAUNCHER_SECRET_FILE === '')) {
    throw new Error('PORTER_BERTHS=launcher needs PORTER_LAUNCHER (the launcher\'s socket, or 127.0.0.1:<port>) and PORTER_LAUNCHER_SECRET_FILE');
  }
  return {
    cubeUrl: cubeUrl.endsWith('/') ? cubeUrl : `${cubeUrl}/`,
    stateDir,
    host: env.PORTER_HOST ?? '127.0.0.1',
    port,
    chellEntry: env.PORTER_CHELL ?? locateChell(),
    secret: secretGiven ? (env.PORTER_SECRET as string) : randomBytes(32).toString('hex'),
    secretGenerated: !secretGiven,
    cookieHours,
    idleHours,
    tokenDays,
    // Beside the session directories, which the adopt scan skips as a file.
    tokensFile: porterTokensFile_resolve(env),
    soundsDir: env.PORTER_SOUNDS_DIR !== undefined && env.PORTER_SOUNDS_DIR.length > 0 ? env.PORTER_SOUNDS_DIR : null,
    berths: berthsMode === 'launcher' ? { mode: 'launcher', listen: env.PORTER_LAUNCHER as string, secretFile: env.PORTER_LAUNCHER_SECRET_FILE as string } : { mode: 'local' },
  };
}
