#!/usr/bin/env node
/**
 * @file The `porter` entry: the mise display manager.
 *
 * Reads its configuration from the environment, stands a process host on
 * this machine, and listens. `porter --status` lists the sessions a running
 * porter's state directory holds; `porter --end <who>` ends one of them.
 *
 * @module
 */
import { CredentialStore } from './creds.js';
import { porterConfig_resolve, porterStateDir_resolve, porterTokensFile_resolve, chellEntry_locate, stratusEntry_locate, PORTER_DEFAULT_TOKEN_DAYS, type PorterConfig } from './config.js';
import { TokenStore, type DoorToken } from './tokens.js';
import { identity_normalise } from '@fnndsc/calypso/berth';
import { ProcessHost } from './host/processHost.js';
import { LauncherHost } from './host/launcherHost.js';
import { launcherSecret_read } from './launcher/secret.js';
import { porterApp_build, type PorterApp } from './app.js';
import type { SessionHost, SessionSighting } from './host/sessionHost.js';
import { berthKey_compute } from '@fnndsc/calypso/berth';
import { entry_isMain } from './entry.js';
import { versionReport_build } from './versions.js';

/**
 * Lists the sessions the state directory holds, without starting anything.
 *
 * Needs only the state directory (and the chell the host is built around,
 * which a listing never runs): no CUBE, no port, no secret.
 *
 * @param stateDir - Where the state directory is.
 */
async function status_print(stateDir: string): Promise<void> {
  const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: process.env['PORTER_CHELL'] ?? chellEntry_locate() });
  const sightings: SessionSighting[] = await host.sessions_adopt();
  console.log(`state: ${stateDir}`);
  if (sightings.length === 0) {
    console.log('no sessions');
    return;
  }
  for (const sighting of sightings) {
    const state: string = sighting.alive ? 'answering' : 'gone';
    // The pid is what the daemon wrote when it started. On a gone row it
    // names a process that is not there — a berth outlives a daemon killed
    // with -9 — and printed bare it read as one the listing had just made.
    const pid: string = sighting.berth.pid === undefined
      ? ''
      : sighting.alive ? `  pid ${sighting.berth.pid}` : `  pid ${sighting.berth.pid} (stale: the berth outlived it)`;
    console.log(`${berthKey_compute(sighting.identity)}  ${state.padEnd(9)}  ${sighting.berth.url.padEnd(24)}  ${sighting.identity}${pid}`);
  }
}

/**
 * Ends one session: the daemon is sent SIGTERM, its state directory stays,
 * and the operator's next login boots a fresh one on the kernel this
 * porter now carries. An adopted session keeps the kernel it was born
 * with across every porter upgrade — a session from last week answers a
 * surface from today with last week's answers — and until now the only
 * way to move it on was to find its pid by hand.
 *
 * @param stateDir - Where the state directory is.
 * @param who - The session's berth key, its identity (`user@cube`), or the
 *   user alone when one session carries that user.
 */
async function session_end(stateDir: string, who: string): Promise<void> {
  const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: process.env['PORTER_CHELL'] ?? chellEntry_locate() });
  const sightings: SessionSighting[] = await host.sessions_adopt();
  const matches: SessionSighting[] = sightings.filter((sighting: SessionSighting): boolean =>
    sighting.identity === who || berthKey_compute(sighting.identity) === who || sighting.identity.startsWith(`${who}@`));
  if (matches.length === 0) {
    console.error(`[!] no session for ${who}; 'porter --status' lists them`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`[!] ${who} names ${matches.length} sessions; use the berth key:`);
    for (const sighting of matches) console.error(`    ${berthKey_compute(sighting.identity)}  ${sighting.identity}`);
    process.exit(1);
  }
  const target: SessionSighting = matches[0] as SessionSighting;
  if (!target.alive) {
    console.log(`${berthKey_compute(target.identity)}  gone already  ${target.identity}`);
    return;
  }
  const ended: boolean = await host.evict(target.identity);
  console.log(`${berthKey_compute(target.identity)}  ${ended ? 'ended' : 'could not be ended'}  ${target.identity}${target.berth.pid !== undefined ? `  pid ${target.berth.pid}` : ''}`);
  if (ended) console.log('    state kept; the next login boots a fresh session on this porter\'s kernel');
}

/**
 * Lists the door tokens the store holds: who, which name, when minted,
 * when it dies, when it last let someone in. There is no plaintext to
 * show; a lost token is revoked and minted again.
 *
 * @param file - The token store.
 */
function tokens_print(file: string): void {
  const store: TokenStore = new TokenStore(file, PORTER_DEFAULT_TOKEN_DAYS);
  store.load();
  const tokens: DoorToken[] = store.list();
  console.log(`tokens: ${file}`);
  if (tokens.length === 0) {
    console.log('no door tokens');
    return;
  }
  const now: number = Date.now();
  for (const token of tokens) {
    const dies: string = Date.parse(token.expires) <= now ? `died ${token.expires.slice(0, 10)}` : `dies ${token.expires.slice(0, 10)}`;
    const used: string = token.lastUsed === null ? 'never used' : `last used ${token.lastUsed.slice(0, 16).replace('T', ' ')}`;
    console.log(`${token.user.padEnd(18)}  ${token.name.padEnd(24)}  minted ${token.created.slice(0, 10)}  ${dies.padEnd(16)}  ${used}`);
  }
}

/**
 * Revokes a user's door tokens: one by name, or every one of theirs. A
 * running porter notices on the token's next use, since it re-reads the
 * store when the file changed under it.
 *
 * @param file - The token store.
 * @param user - The CUBE username.
 * @param name - The token's name, or undefined for all of the user's.
 */
function token_revoke(file: string, user: string, name: string | undefined): void {
  const store: TokenStore = new TokenStore(file, PORTER_DEFAULT_TOKEN_DAYS);
  store.load();
  const gone: number = store.revoke(user, name);
  if (gone === 0) {
    console.error(`[!] no door token ${name === undefined ? `for ${user}` : `named "${name}" for ${user}`}; 'porter --tokens' lists them`);
    process.exit(1);
  }
  console.log(`revoked ${gone} door token${gone === 1 ? '' : 's'} ${name === undefined ? `of ${user}` : `("${name}") of ${user}`}; a script carrying one is refused on its next call`);
}

/**
 * Mints a door token for a user by the operator's hand, on the host: the
 * way a service identity gets its key, or a user who cannot reach the
 * login page from anywhere. Printed once; the store keeps the hash.
 *
 * @param env - The environment: the CUBE (`PORTER_CUBE_URL`) names the identity, `PORTER_TOKEN_DAYS` its life.
 * @param user - The CUBE username.
 * @param name - The token's name.
 */
function token_mint(env: NodeJS.ProcessEnv, user: string, name: string): void {
  const cubeUrl: string | undefined = env['PORTER_CUBE_URL'];
  if (cubeUrl === undefined || cubeUrl.length === 0) {
    console.error('[!] --mint needs PORTER_CUBE_URL: the token is for an identity at one CUBE');
    process.exit(1);
  }
  const daysText: string = env['PORTER_TOKEN_DAYS'] ?? String(PORTER_DEFAULT_TOKEN_DAYS);
  const days: number = Number(daysText);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`[!] PORTER_TOKEN_DAYS is not a span of days: ${daysText}`);
    process.exit(1);
  }
  const store: TokenStore = new TokenStore(porterTokensFile_resolve(env), days);
  store.load();
  const made: { token: string; record: DoorToken } = store.mint(identity_normalise(user, cubeUrl.endsWith('/') ? cubeUrl : `${cubeUrl}/`), user, name);
  console.log(`minted a door token "${name}" for ${user}; it dies ${made.record.expires.slice(0, 10)} and is shown once:`);
  console.log(made.token);
  console.log('hand it over out of band; the script keeps it in ~/.config/chell/doors/<door-host>.json (0600) or CHELL_DOOR_TOKEN');
}

/** What the command line asks for. */
export type PorterAsk =
  | { mode: 'serve' }
  | { mode: 'status' }
  | { mode: 'end'; who: string }
  | { mode: 'tokens' }
  | { mode: 'revoke'; user: string; name?: string }
  | { mode: 'mint'; user: string; name: string }
  | { mode: 'creds'; user: string; config: string; profile?: string }
  | { mode: 'help' }
  | { mode: 'version' };

/** The usage, one line per word the entry takes. */
export const PORTER_USAGE: string = [
  'porter                      serve the door (PORTER_CUBE_URL, PORTER_PORT, … from the environment)',
  'porter --status             the sessions this porter carries (--sessions says the same)',
  'porter --end <who>          end one session: its berth key, user, or user@cube',
  'porter --tokens             the door tokens the store holds: user, name, minted, dies, last used',
  'porter --revoke <user> [<name>]   revoke one door token by name, or every one of the user\'s',
  'porter --mint <user> --name <name>   mint a door token by hand (PORTER_CUBE_URL names the CUBE); shown once',
  'porter --creds <user> --oci <config> [--profile <name>]   file a user\'s OCI key under their ChRIS identity, for :stratus oci',
  'porter --version            the door\'s version and the session code it serves (-V)',
  'porter --help               this',
].join('\n');

/**
 * Reads the command line. A word the entry does not know is refused by
 * name: left to fall through it once started a second door that adopted
 * the live sessions before dying on the port.
 *
 * @param argv - The words after the entry (process.argv.slice(2)).
 * @returns What was asked, or the refusal.
 */
export function porterArgs_parse(argv: ReadonlyArray<string>): PorterAsk | { refusal: string } {
  if (argv.length === 0) return { mode: 'serve' };
  const [word, ...rest] = argv;
  if (word === '--help' || word === '-h') return { mode: 'help' };
  if (word === '--version' || word === '-V') {
    return rest.length === 0 ? { mode: 'version' } : { refusal: `${word} takes no argument ('${rest[0] ?? ''}')` };
  }
  if (word === '--status' || word === '--sessions') {
    return rest.length === 0 ? { mode: 'status' } : { refusal: `${word} takes no argument ('${rest[0] ?? ''}')` };
  }
  if (word === '--end') {
    const who: string | undefined = rest[0];
    if (who === undefined || who.startsWith('--')) return { refusal: '--end wants <berth key | user | user@cube>' };
    if (rest.length > 1) return { refusal: `--end takes one name ('${rest[1] ?? ''}' is extra)` };
    return { mode: 'end', who };
  }
  if (word === '--tokens') {
    return rest.length === 0 ? { mode: 'tokens' } : { refusal: `--tokens takes no argument ('${rest[0] ?? ''}')` };
  }
  if (word === '--revoke') {
    const user: string | undefined = rest[0];
    if (user === undefined || user.startsWith('--')) return { refusal: '--revoke wants <user> [<name>]' };
    if (rest.length > 2) return { refusal: `--revoke takes a user and at most a name ('${rest[2] ?? ''}' is extra)` };
    const name: string | undefined = rest[1];
    return name === undefined ? { mode: 'revoke', user } : { mode: 'revoke', user, name };
  }
  if (word === '--mint') {
    const user: string | undefined = rest[0];
    if (user === undefined || user.startsWith('--')) return { refusal: '--mint wants <user> --name <name>' };
    if (rest[1] !== '--name' || rest[2] === undefined || rest[2].startsWith('--')) return { refusal: '--mint wants --name <name> after the user: the operator names what the token is for' };
    if (rest.length > 3) return { refusal: `--mint takes a user and a name ('${rest[3] ?? ''}' is extra)` };
    return { mode: 'mint', user, name: rest[2] };
  }
  if (word === '--creds') {
    const user: string | undefined = rest[0];
    if (user === undefined || user.startsWith('--')) return { refusal: '--creds wants <user> --oci <config> [--profile <name>]' };
    if (rest[1] !== '--oci' || rest[2] === undefined || rest[2].startsWith('--')) return { refusal: '--creds wants --oci <config> after the user: the OCI config whose key to file' };
    if (rest.length === 3) return { mode: 'creds', user, config: rest[2] };
    if (rest[3] === '--profile' && rest[4] !== undefined && rest.length === 5) return { mode: 'creds', user, config: rest[2], profile: rest[4] };
    return { refusal: `--creds takes a user, --oci <config> and at most --profile <name> ('${rest[3] ?? ''}' is not that)` };
  }
  return { refusal: `unknown word '${word ?? ''}'` };
}

/**
 * Files a user's existing OCI key under their ChRIS identity, by the
 * operator's hand on this host: the key copied into porter's state, mode
 * 600, beside a config naming the copy. Nothing crosses the wire.
 *
 * @param env - The environment: `PORTER_CUBE_URL` names the identity.
 * @param user - The CUBE username.
 * @param config - The OCI config to take the profile from.
 * @param profile - Which profile.
 */
function creds_import(env: NodeJS.ProcessEnv, user: string, config: string, profile: string | undefined): void {
  const cubeUrl: string | undefined = env['PORTER_CUBE_URL'];
  if (cubeUrl === undefined || cubeUrl.length === 0) {
    console.error('[!] --creds needs PORTER_CUBE_URL: credentials are filed under an identity at one CUBE');
    process.exit(1);
  }
  const identity: string = identity_normalise(user, cubeUrl.endsWith('/') ? cubeUrl : `${cubeUrl}/`);
  const kept = new CredentialStore(porterStateDir_resolve(env)).oci_import(identity, config, profile);
  if ('error' in kept) {
    console.error(`[!] --creds: ${kept.error}; nothing filed`);
    process.exit(1);
  }
  console.log(`filed ${user}'s OCI key under ${identity}: ${kept.config} (mode 600)`);
  console.log(`  the key acts as ${kept.user} in ${kept.tenancy}; :stratus oci in ${user}'s ChRIS session starts on it`);
}

async function porter_start(): Promise<void> {
  const ask: PorterAsk | { refusal: string } = porterArgs_parse(process.argv.slice(2));
  if ('refusal' in ask) {
    console.error(`[!] porter: ${ask.refusal}\n${PORTER_USAGE}`);
    process.exit(1);
  }
  if (ask.mode === 'help') { console.log(PORTER_USAGE); return; }
  if (ask.mode === 'version') { console.log(versionReport_build()); return; }
  if (ask.mode === 'status') { await status_print(porterStateDir_resolve(process.env)); return; }
  if (ask.mode === 'end') { await session_end(porterStateDir_resolve(process.env), ask.who); return; }
  if (ask.mode === 'tokens') { tokens_print(porterTokensFile_resolve(process.env)); return; }
  if (ask.mode === 'revoke') { token_revoke(porterTokensFile_resolve(process.env), ask.user, ask.name); return; }
  if (ask.mode === 'mint') { token_mint(process.env, ask.user, ask.name); return; }
  if (ask.mode === 'creds') { creds_import(process.env, ask.user, ask.config, ask.profile); return; }
  let config: PorterConfig;
  try {
    config = porterConfig_resolve(process.env);
  } catch (error: unknown) {
    console.error(`[!] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  // Sessions beside this porter, or berths the launcher starts (PORTER_BERTHS=launcher).
  let host: SessionHost;
  if (config.berths.mode === 'launcher') {
    let secret: string;
    try {
      secret = launcherSecret_read(config.berths.secretFile);
    } catch (error: unknown) {
      console.error(`[!] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    host = new LauncherHost({ listen: config.berths.listen, secret });
  } else {
    host = new ProcessHost({ stateDir: config.stateDir, chellEntry: config.chellEntry, stratusEntry: stratusEntry_locate() });
  }
  const sweepText: string | undefined = process.env['PORTER_SWEEP_SECONDS'];
  const built: PorterApp = await porterApp_build({
    config,
    host,
    // A berth runs the image's calypso, not this porter's: its versions are the image's to keep, never a reason to restart it.
    ...(config.berths.mode === 'launcher' ? { installed: {}, logoutEnds: true } : {}),
    logger: false,
    log: (line: string): void => { console.log(`[+] ${line}`); },
    // Not documented: the sweep's cadence only matters to a test of it.
    ...(sweepText !== undefined && Number(sweepText) > 0 ? { sweepMs: Number(sweepText) * 1000 } : {}),
  });
  await built.app.listen({ host: config.host, port: config.port });
  // The port first, the sessions after: a porter that cannot hold its door
  // has no business claiming what the one holding it carries.
  await built.adopt();
  console.log(`[+] PORTER at http://${config.host}:${config.port}/ for ${config.cubeUrl}`);
  console.log(`    state:  ${config.stateDir}`);
  console.log(config.berths.mode === 'launcher' ? `    berths: started by the launcher at ${config.berths.listen}; a logout stops the user's berth` : `    chell:  ${config.chellEntry}`);
  console.log(`    idle:   sessions end after ${config.idleHours} h with nobody on them; their state directories stay`);
  if (config.secretGenerated) {
    console.log('    secret: made up for this run — set PORTER_SECRET so a restart does not ask every browser again');
  }
  const stop = async (): Promise<void> => {
    await built.app.close();
    process.exit(0);
  };
  process.once('SIGINT', (): void => { void stop(); });
  process.once('SIGTERM', (): void => { void stop(); });
}

// Started as the program, through npm's bin link or by its own path; imported, it stays quiet.
if (entry_isMain(process.argv[1], import.meta.url)) void porter_start();
