/**
 * @file Exemplar 15 — one session, two accounts.
 *
 * A program that connects as one CUBE user, works, and then connects as
 * another in the same process must be served as the second from that
 * moment: who it is, what it may read, and what it is shown. Nothing the
 * first user's work warmed (a client, a listing) may answer for the second.
 *
 * What is checked is chosen so that the answer depends on whose client did
 * the asking, through the listing path and through the transfer path:
 *
 * - The first user makes a folder with a file in it, lists it and reads it,
 *   and asks for the second user's home, which it is not given.
 * - The second user connects in the same session. It is the second; it is
 *   given its own home, where the first was not; and it reads a file of its
 *   own. A listing or a transfer still made with the first user's client
 *   would be refused here.
 * - The first user connects again. It is the first; the second's home and
 *   the second's file are refused again; its own file is read afresh.
 *
 * What this run does not show: `/bin` and the process tree read the same
 * for both accounts on a CUBE where the second is an administrator, so
 * they are not asked; the unit tests of the connection hold those to the
 * client in use. Where a CUBE lets the first user read the second's home,
 * the checks that rest on that are said to be skipped, not passed.
 *
 * The second account is the one the exemplars already use for cleanup
 * (`CUBE_ADMIN_USER`). It only reads here: nothing is written or removed
 * as that account. The folder the first user makes is this run's only on
 * CUBE's own word that this run made it; it is then removed by the id CUBE
 * gave it, and a folder that was already there is never touched.
 *
 *   node exemplars/ts/dist/15_accountSwitch.js
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files_touch, files_listWhole, fileContent_get } from '@fnndsc/salsa';
import { chrisIO, currentUser_get, Result, ChrisUser } from '@fnndsc/cumin';
import {
  env_load, config_isolate, cube_connect, connection_active, adminEnv_require, check, step, section, summary_exit,
  runId_make, restToken_get, poll_until, CleanupPlan, CubeEnv,
} from './lib/harness.js';

/** What kinds of entry a folder may hold, as CUBE keeps them apart. */
const KINDS: ReadonlyArray<string> = ['files', 'dirs', 'links'];

/** What a folder's listing came to, read from CUBE now, as whoever is connected. */
interface FolderRead {
  /** Given entries, given none, not there, or refused. */
  kind: 'listing' | 'empty' | 'missing' | 'refused';
  /** Whether it names what was looked for. */
  holds: boolean;
  /** The path of one plain file in it, when it has one. */
  aFile: string | null;
}

/**
 * Reads a folder as whoever is connected.
 *
 * @param path - The folder.
 * @param name - What to look for in it.
 * @returns What the read came to.
 */
async function folder_read(path: string, name: string): Promise<FolderRead> {
  const read: FolderRead = { kind: 'missing', holds: false, aFile: null };
  for (const asset of KINDS) {
    const outcome = await files_listWhole(asset, path);
    if (outcome.kind === 'refused') return { kind: 'refused', holds: false, aFile: null };
    if (outcome.kind === 'missing') continue;
    if (outcome.kind === 'empty') { if (read.kind === 'missing') read.kind = 'empty'; continue; }
    read.kind = 'listing';
    for (const row of outcome.data.tableData as Array<Record<string, unknown>>) {
      if (JSON.stringify(row).includes(name)) read.holds = true;
      const fname: unknown = row['fname'];
      if (asset === 'files' && read.aFile === null && typeof fname === 'string' && fname !== '') read.aFile = fname.startsWith('/') ? fname : `/${fname}`;
    }
  }
  return read;
}

/**
 * Looks a folder up by its path, as a user, and says plainly what CUBE said.
 *
 * @param url - The CUBE.
 * @param token - The user's token.
 * @param folderPath - The folder, without its leading slash.
 * @returns Its id, or null when CUBE says there is none.
 * @throws {Error} When CUBE did not answer the question: not knowing is not "none".
 */
async function folder_look(url: string, token: string, folderPath: string): Promise<number | null> {
  const response: Response = await fetch(`${url}filebrowser/search/?path=${encodeURIComponent(folderPath)}`, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`CUBE answered ${response.status} when asked whether ${folderPath} is there`);
  const body: unknown = await response.json();
  const results: unknown = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error(`CUBE's answer about ${folderPath} was not a list of folders`);
  if (results.length === 0) return null;
  // The answer must be about this very folder, and name it by an id that can be acted on.
  const found = results[0] as { id?: unknown; path?: unknown };
  if (found.path !== folderPath || typeof found.id !== 'number' || !Number.isSafeInteger(found.id) || found.id <= 0) {
    throw new Error(`CUBE's answer about ${folderPath} names another folder or no usable id`);
  }
  return found.id;
}

/** Connects the session's one connection as a user, as `connect` does. */
async function user_connect(env: CubeEnv, user: string, password: string): Promise<boolean> {
  const token: string | null = await connection_active().connection_connect({ user, password, url: env.url, debug: true });
  return token !== null && token.length > 0;
}

/**
 * Asks for a file, as whoever is connected, and says which of three things happened: it was given; CUBE did
 * not give it; or the asking itself broke, which is neither.
 */
async function file_ask(path: string): Promise<'given' | 'not given' | 'broke'> {
  try {
    return (await fileContent_get(path)).ok ? 'given' : 'not given';
  } catch {
    return 'broke';
  }
}

/**
 * The scenario: the first user works, the second connects, the first returns.
 *
 * @param env - The CUBE environment, with both accounts.
 * @param cleanup - Undo actions, registered as resources are made.
 */
async function scenario_run(env: CubeEnv, cleanup: CleanupPlan): Promise<void> {
  const first: string = env.user;
  const second: string = env.adminUser as string;
  const runId: string = `${runId_make()}-${randomBytes(4).toString('hex')}`;
  const scratchDir: string = `/home/${first}/${runId}`;
  const marker: string = 'only-the-first.txt';
  const content: string = `made by ${first} in ${runId}`;
  const secondHome: string = `/home/${second}`;

  // tag::accountSwitch[]
  section(`as ${first}: make something only ${first} has`);
  // Made only where there is nothing of that name: a folder that is already there is not this run's, is not
  // written into, and is not removed.
  const token: string = await restToken_get(env.url, env.user, env.password);
  if (!check('no folder of this run\'s name is there yet', (await folder_look(env.url, token, scratchDir.slice(1))) === null)) return;
  // The receipt is CUBE's own answer to the making: made by this call, not "it is there". A folder that came
  // to be there in between is somebody else's: nothing is written into it and nothing is removed.
  const creation: Result<boolean> = await chrisIO.folder_create(scratchDir);
  if (!check('CUBE says this run made the folder (it was not already there)', creation.ok && creation.value === true)) return;
  const made: number | null = await folder_look(env.url, token, scratchDir.slice(1));
  if (!check('CUBE gave the new folder an id', made !== null)) return;
  cleanup.register('removed the scratch folder, by the id it was given', async (): Promise<boolean> => {
    const mine: string = await restToken_get(env.url, env.user, env.password);
    const response: Response = await fetch(`${env.url}filebrowser/${String(made)}/`, { method: 'DELETE', headers: { Authorization: `Token ${mine}` } });
    if (response.status !== 202 && response.status !== 204) return false;
    const gone = await poll_until<boolean>(async () => ((await folder_look(env.url, mine, scratchDir.slice(1))) === null ? true : null), 30_000, 2_000);
    return gone.ok;
  });
  if (!check(`wrote ${marker}`, await files_touch(`${scratchDir}/${marker}`, content))) return;
  check(`${first} lists the folder and sees the file`, (await folder_read(scratchDir, marker)).holds);
  const mineRead: Result<string> = await step(`${first} reads the file`, fileContent_get(`${scratchDir}/${marker}`));
  if (mineRead.ok) check('its content is what was written', mineRead.value === content);
  const asFirst: FolderRead = await folder_read(secondHome, '');
  // Whether this CUBE tells the two accounts apart by the second's home: if the first is given it, it does not.
  const apart: boolean = asFirst.kind !== 'listing';
  if (apart) check(`${first} is not given ${second}'s home`, true);
  else console.log(`  - skipped: this CUBE gives ${first} the listing of ${second}'s home, so that listing does not tell the two apart here`);

  section(`connect as ${second}, in the same session`);
  if (!check(`connected as ${second}`, await user_connect(env, second, env.adminPassword as string))) return;
  const who: Result<ChrisUser> = await step('asked who is connected', currentUser_get());
  if (who.ok) check(`the session is ${second}`, who.value.username === second);
  const asSecond: FolderRead = await folder_read(secondHome, runId);
  // The second's own home must be read, whatever else: a read that fails shows nothing about anybody.
  if (!check(`${second} is given its own home${apart ? `, which ${first} was not: the listing was read with ${second}'s client` : ''}`, asSecond.kind === 'listing')) return;
  check(`${first}'s folder is not in ${second}'s home`, !asSecond.holds);
  // A file to read as the second: one of its own, which the first cannot be given. Where there is none, or
  // the first may read the second's home, the transfer path does not tell the two apart here, and is skipped.
  const secondFile: string | null = apart ? asSecond.aFile : null;
  if (secondFile === null) console.log(`  - skipped: no file here that ${second} may read and ${first} may not, so the transfer path is not shown to tell them apart`);
  else check(`${second} reads a file of its own: the transfer was made with ${second}'s client`, (await file_ask(secondFile)) === 'given');

  section(`connect as ${first} again`);
  if (!check(`connected as ${first}`, await user_connect(env, env.user, env.password))) return;
  const back: Result<ChrisUser> = await step('asked who is connected', currentUser_get());
  if (back.ok) check(`the session is ${first}`, back.value.username === first);
  if (apart) check(`${second}'s home is not given to ${first} again: nothing ${second} was shown is handed over`, (await folder_read(secondHome, '')).kind !== 'listing');
  if (secondFile !== null) check(`nor is ${second}'s file (CUBE does not give it; the asking did not break): the transfer is made with ${first}'s client again`, (await file_ask(secondFile)) === 'not given');
  // And straight after those refusals, a read that must succeed: the refusals were CUBE's answer to the
  // first user, not a session that had stopped working.
  const again: Result<string> = await step(`${first} reads its own file afresh`, fileContent_get(`${scratchDir}/${marker}`));
  if (again.ok) check('its content is what was written', again.value === content);
  // end::accountSwitch[]
}

/**
 * Program entry: connect as the first user, run the scenario, always run cleanup.
 */
async function main(): Promise<void> {
  const env: CubeEnv = env_load();
  adminEnv_require(env);
  if (env.adminUser === env.user) {
    console.log('CUBE_ADMIN_USER is the same account as CUBE_USER: there is no second account to switch to — skipping.');
    process.exit(2);
  }
  // Nothing of the developer's own session is read or written: the config, and with it the cache (where each
  // identity's checkpoints are kept), the runtime folder and the state folder, are this run's own.
  config_isolate();
  for (const name of ['XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME']) process.env[name] = mkdtempSync(join(tmpdir(), 'chell-exemplar-'));
  await cube_connect(env);

  const cleanup: CleanupPlan = new CleanupPlan();
  try {
    await scenario_run(env, cleanup);
  } finally {
    section('cleanup — restore the CUBE');
    // Whoever the scenario left connected, the cleanup asks CUBE as the first user by its own token.
    await cleanup.run();
  }
  summary_exit();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
