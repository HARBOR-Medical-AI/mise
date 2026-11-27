/**
 * @file Exemplar 15 — one session, two accounts.
 *
 * A program that connects as one CUBE user, works, and then connects as
 * another in the same process must be served as the second from that
 * moment: who it is, what it may read, and what it is shown. Nothing the
 * first user's work warmed (a client, a listing) may answer for the second.
 *
 * The first user makes a folder with a file in it and lists it, so its
 * listing is held. The second user then connects and asks three things
 * whose answers depend on who asks: who am I; my own home; and the first
 * user's listing again, which must be read from CUBE as the second user
 * and not handed over from what the first one held. The first user then
 * connects again and is served as the first.
 *
 * The second account is the one the exemplars already use for cleanup
 * (`CUBE_ADMIN_USER`). It only reads here: nothing is written or removed
 * as that account.
 *
 *   node exemplars/ts/dist/15_accountSwitch.js
 *
 * @module
 */

import { files_mkdir, files_touch, files_listWhole } from '@fnndsc/salsa';
import { currentUser_get, listCache_get, Result, ChrisUser } from '@fnndsc/cumin';
import {
  env_load, config_isolate, cube_connect, connection_active, adminEnv_require, check, step, section, summary_exit,
  runId_make, restToken_get, folder_deleteAndConfirm, CleanupPlan, CubeEnv,
} from './lib/harness.js';

/** What kinds of entry a folder may hold, as CUBE keeps them apart. */
const KINDS: ReadonlyArray<string> = ['files', 'dirs', 'links'];

/** Whether a folder's listing, read from CUBE now, names something; and what the read came to. */
async function folder_holds(path: string, name: string): Promise<{ kind: string; holds: boolean }> {
  let kind: string = 'missing';
  for (const asset of KINDS) {
    const outcome = await files_listWhole(asset, path);
    if (outcome.kind === 'refused') return { kind: 'refused', holds: false };
    if (outcome.kind === 'missing') continue;
    kind = kind === 'listing' ? kind : outcome.kind;
    if (outcome.kind === 'listing' && outcome.data.tableData.some((row: Record<string, unknown>): boolean => JSON.stringify(row).includes(name))) return { kind: 'listing', holds: true };
  }
  return { kind, holds: false };
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
  const runId: string = runId_make();
  const scratchDir: string = `/home/${first}/${runId}`;
  const marker: string = 'only-the-first.txt';

  // tag::accountSwitch[]
  section(`as ${first}: make something only ${first} has, and hold its listing`);
  if (!check('created the scratch folder', await files_mkdir(scratchDir))) return;
  cleanup.register('removed the scratch folder', async () => {
    const token: string = await restToken_get(env.url, env.user, env.password);
    return folder_deleteAndConfirm(env.url, token, scratchDir.slice(1));
  });
  if (!check(`wrote ${marker}`, await files_touch(`${scratchDir}/${marker}`, `made by ${first} in ${runId}`))) return;
  check(`${first} lists the folder and sees the file`, (await folder_holds(scratchDir, marker)).holds);
  check(`${first} lists its own home and sees the folder`, (await folder_holds(`/home/${first}`, runId)).holds);
  // The listing is kept for the session, as a shell keeps what `ls` showed it.
  listCache_get().cache_set(scratchDir, [{ name: marker }]);
  check('that listing is held for the session', listCache_get().cache_get(scratchDir) !== null);

  section(`connect as ${second}, in the same session`);
  if (!check(`connected as ${second}`, await user_connect(env, second, env.adminPassword as string))) return;
  const who: Result<ChrisUser> = await step('asked who is connected', currentUser_get());
  if (who.ok) check(`the session is ${second}`, who.value.username === second);
  check(`nothing ${first} held is held for ${second}`, listCache_get().cache_get(scratchDir) === null);
  const secondHome = await folder_holds(`/home/${second}`, runId);
  check(`${second} is given its own home, read as ${second}`, secondHome.kind === 'listing' || secondHome.kind === 'empty');
  check(`and ${first}'s folder is not in it`, !secondHome.holds);
  listCache_get().cache_set(`/home/${second}`, [{ name: 'what the second saw' }]);

  section(`connect as ${first} again`);
  if (!check(`connected as ${first}`, await user_connect(env, env.user, env.password))) return;
  const back: Result<ChrisUser> = await step('asked who is connected', currentUser_get());
  if (back.ok) check(`the session is ${first}`, back.value.username === first);
  check(`nothing ${second} read is held for ${first}`, listCache_get().cache_get(`/home/${second}`) === null);
  check(`${first} still sees its own file, read afresh`, (await folder_holds(scratchDir, marker)).holds);
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
  config_isolate();
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
