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
 * - The first user makes a folder with a file in it, lists it and reads it.
 * - The second user connects in the same session. It is the second; it
 *   makes a folder of its own, writes a file there through the session,
 *   lists it and reads it back. The first may do none of that there, so
 *   work still done with the first user's client would fail.
 * - The first user connects again. It is the first; CUBE, asked directly,
 *   denies it the second's folder, and the session neither shows that
 *   folder's file nor hands over its content; its own file is read afresh.
 *
 * A session read that failed for some other reason looks, from the session
 * alone, like a refusal. So the refusal is CUBE's own (a 403 or 404 for
 * that folder's id with the first's token, anything else an error), asked
 * before and after, and the session is held only to not producing what the
 * second was given. Where a CUBE gives the first the second's folder,
 * those checks are printed as skipped, not passed.
 *
 * What this run does not show: `/bin` and the process tree read the same
 * for both accounts on a CUBE where the second is an administrator, so
 * they are not asked; the unit tests of the connection hold those to the
 * client in use.
 *
 * The second account is the one the exemplars already use for cleanup
 * (`CUBE_ADMIN_USER`). Each account makes one scratch folder under its own
 * home. A folder is this run's only by CUBE's answer to its making, which
 * carries its id; a name that is taken makes nothing. Each is removed by
 * that id, by the account that made it, and nothing else is removed.
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
import { currentUser_get, Result, ChrisUser } from '@fnndsc/cumin';
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

/** A folder this run made: CUBE's own id and path for it, from its answer to the making. */
interface MadeFolder {
  /** The id CUBE gave it. */
  id: number;
  /** Its path, as CUBE spells it (no leading slash). */
  path: string;
}

/**
 * Makes a folder as a user and keeps CUBE's own answer: the id and the path
 * come from the making itself, never from a later lookup, so nothing else
 * that comes to bear the name can be taken for it.
 *
 * @param url - The CUBE.
 * @param token - The user's token.
 * @param folderPath - The folder, without its leading slash.
 * @returns What was made, or null when CUBE did not make it (the name is taken, the answer is not a usable receipt).
 */
async function folder_make(url: string, token: string, folderPath: string): Promise<MadeFolder | null> {
  const response: Response = await fetch(`${url}filebrowser/`, {
    method: 'POST',
    headers: { Authorization: `Token ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath }),
  });
  if (response.status !== 201) return null;
  const body = (await response.json().catch((): null => null)) as { id?: unknown; path?: unknown } | null;
  if (body === null || body.path !== folderPath || typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0) return null;
  return { id: body.id, path: folderPath };
}

/**
 * Asks CUBE for a folder by its id, as a user.
 *
 * @param url - The CUBE.
 * @param token - The user's token.
 * @param folder - The folder.
 * @returns `given` when CUBE shows that very folder; `denied` when CUBE says it may not be had or is not there for this user (403, 404).
 * @throws {Error} On any other answer: a failure to ask is neither.
 */
async function folder_askById(url: string, token: string, folder: MadeFolder): Promise<'given' | 'denied'> {
  const response: Response = await fetch(`${url}filebrowser/${String(folder.id)}/`, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } });
  if (response.status === 403 || response.status === 404) return 'denied';
  if (!response.ok) throw new Error(`CUBE answered ${response.status} when asked for folder ${String(folder.id)}`);
  const body = (await response.json()) as { id?: unknown; path?: unknown };
  if (body.id !== folder.id || body.path !== folder.path) throw new Error(`CUBE's answer for folder ${String(folder.id)} is about another folder`);
  return 'given';
}

/**
 * Removes a folder this run made, by the id its making gave, and waits for CUBE to say it is gone.
 *
 * @param url - The CUBE.
 * @param token - The token of the user that made it.
 * @param folder - The folder.
 * @returns Whether it is gone.
 */
async function folder_unmake(url: string, token: string, folder: MadeFolder): Promise<boolean> {
  const response: Response = await fetch(`${url}filebrowser/${String(folder.id)}/`, { method: 'DELETE', headers: { Authorization: `Token ${token}` } });
  if (response.status !== 202 && response.status !== 204) return false;
  const gone = await poll_until<boolean>(async () => ((await folder_askById(url, token, folder).catch((): 'given' => 'given')) === 'denied' ? true : null), 30_000, 2_000);
  return gone.ok;
}

/** Connects the session's one connection as a user, as `connect` does. */
async function user_connect(env: CubeEnv, user: string, password: string): Promise<boolean> {
  const token: string | null = await connection_active().connection_connect({ user, password, url: env.url, debug: true });
  return token !== null && token.length > 0;
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
  const firstFile: string = 'only-the-first.txt';
  const firstContent: string = `made by ${first} in ${runId}`;
  const secondFile: string = 'only-the-second.txt';
  const secondContent: string = `made by ${second} in ${runId}`;
  const firstToken: string = await restToken_get(env.url, env.user, env.password);
  const secondToken: string = await restToken_get(env.url, second, env.adminPassword as string);

  // tag::accountSwitch[]
  section(`as ${first}: make something only ${first} has`);
  // The folder is this run's only by CUBE's answer to its making, which carries its id: a name that is taken
  // makes nothing, and then nothing is written and nothing is removed.
  const mine: MadeFolder | null = await folder_make(env.url, firstToken, `home/${first}/${runId}`);
  if (mine === null) { check(`CUBE made ${first}'s scratch folder for this run and said which it is`, false); return; }
  check(`CUBE made ${first}'s scratch folder for this run and said which it is`, true);
  cleanup.register(`removed ${first}'s scratch folder, by the id its making gave`, (): Promise<boolean> => folder_unmake(env.url, firstToken, mine));
  const minePath: string = `/${mine.path}/${firstFile}`;
  if (!check(`wrote ${firstFile}`, await files_touch(minePath, firstContent))) return;
  check(`${first} lists the folder and sees the file`, (await folder_read(`/${mine.path}`, firstFile)).holds);
  const mineRead: Result<string> = await step(`${first} reads the file`, fileContent_get(minePath));
  if (mineRead.ok) check('its content is what was written', mineRead.value === firstContent);

  section(`connect as ${second}, in the same session`);
  if (!check(`connected as ${second}`, await user_connect(env, second, env.adminPassword as string))) return;
  const who: Result<ChrisUser> = await step('asked who is connected', currentUser_get());
  if (who.ok) check(`the session is ${second}`, who.value.username === second);
  // A fixture of the second's own, known to this run: a folder made the same way, with one file in it.
  const theirs: MadeFolder | null = await folder_make(env.url, secondToken, `home/${second}/${runId}`);
  if (theirs === null) { check(`CUBE made ${second}'s scratch folder for this run and said which it is`, false); return; }
  check(`CUBE made ${second}'s scratch folder for this run and said which it is`, true);
  cleanup.register(`removed ${second}'s scratch folder, by the id its making gave`, (): Promise<boolean> => folder_unmake(env.url, secondToken, theirs));
  const theirsPath: string = `/${theirs.path}/${secondFile}`;
  // Whether this CUBE keeps the second's folder from the first: asked of CUBE itself, by the folder's id,
  // with the first's token. Any answer but "given" or "denied" is an error, not a result.
  const kept: boolean = (await folder_askById(env.url, firstToken, theirs)) === 'denied';
  // Written through the session: the first may not write there, so a write made with the first's client fails.
  if (!check(`${second} wrote ${secondFile} in its own folder, through the session`, await files_touch(theirsPath, secondContent))) return;
  const theirsListed: FolderRead = await folder_read(`/${theirs.path}`, secondFile);
  if (!check(`${second} lists its folder and sees the file: the listing was read with ${second}'s client`, theirsListed.kind === 'listing' && theirsListed.holds)) return;
  const theirsRead: Result<string> = await step(`${second} reads the file`, fileContent_get(theirsPath));
  if (theirsRead.ok) check(`its content is what was written: the transfer was made with ${second}'s client`, theirsRead.value === secondContent);

  section(`connect as ${first} again`);
  if (!check(`connected as ${first}`, await user_connect(env, env.user, env.password))) return;
  const back: Result<ChrisUser> = await step('asked who is connected', currentUser_get());
  if (back.ok) check(`the session is ${first}`, back.value.username === first);
  if (!kept) {
    console.log(`  - skipped: this CUBE gives ${first} the folder ${second} made, so what the session shows of it does not tell the two apart here`);
  } else {
    // CUBE itself, asked now with the first's token for that very folder, denies it: so a session that
    // shows it, or hands over its file, is using what the second was given. A session read that merely
    // failed would not be told from a refusal by the session alone, which is why CUBE is asked directly
    // before and after, and a read that must succeed follows.
    check(`CUBE denies ${first} the folder ${second} made (asked by its id)`, (await folder_askById(env.url, firstToken, theirs)) === 'denied');
    const shown: FolderRead = await folder_read(`/${theirs.path}`, secondFile);
    check(`the session does not show ${first} that folder's file`, !shown.holds && shown.kind !== 'listing');
    const handed: Result<string> = await fileContent_get(theirsPath).catch((): Result<string> => ({ ok: false }) as Result<string>);
    check(`nor hand over its content: the transfer is made with ${first}'s client again`, !(handed.ok && handed.value === secondContent));
    check(`CUBE still denies it, and still gives it to ${second}`, (await folder_askById(env.url, firstToken, theirs)) === 'denied' && (await folder_askById(env.url, secondToken, theirs)) === 'given');
  }
  const again: Result<string> = await step(`${first} reads its own file afresh`, fileContent_get(minePath));
  if (again.ok) check('its content is what was written', again.value === firstContent);
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
