/**
 * @file What runs of a ChRIS, read from it over HTTPS (CUBE's answer and the
 * admin's sign-in, its accounts every page, porter's health, sessions and
 * version), and what a deploy would do before it acts (the changes, the
 * restarts, the sessions a porter restart ends, whether it asks).
 */
import { describe, it, expect } from '@jest/globals';
import { chrisLive_read, type HttpGet } from '../src/chris/live.js';
import { chrisPlan_derive, chrisPlan_words } from '../src/chris/plan.js';
import { CHRIS_IMAGES, PORTER_VERSION } from '../src/chris/profiles.js';
import type { VmRecord } from '../src/vm/state.js';
import type { ChrisSecrets } from '../src/chris/compose.js';

const CHRIS: NonNullable<VmRecord['chris']> = { profile: 'minimal', compute: 'NERC', host: 'cube.example.org', url: 'https://cube.example.org/api/v1/', deployed: '2026-11-04T20:00:00.000Z', porter: 'porter.example.org', image: CHRIS_IMAGES.cube, porterVersion: PORTER_VERSION };
const SECRETS: ChrisSecrets = { djangoKey: 'd', postgresPassword: 'p', pfconSecretKey: 's', pfconPassword: 'f', adminPassword: 'right-password' };

/** A CUBE and a porter as the public reaches them: two pages of accounts, the next page named on plain http (as behind the proxy). */
function world_make(): { get: HttpGet; asked: string[] } {
  const asked: string[] = [];
  const get: HttpGet = async (url, auth) => {
    asked.push(url);
    const admin: boolean = auth?.user === 'chris' && auth.password === 'right-password';
    if (url === 'https://porter.example.org/healthz') return { status: 200, body: { ok: true, sessions: 3, version: '0.9.11' } };
    if (!admin) return { status: 401, body: null };
    if (url === 'https://cube.example.org/api/v1/') return { status: 200, body: {} };
    if (url === 'https://cube.example.org/api/v1/groups/?limit=100') return { status: 200, body: { count: 2, next: null, results: [{ id: 7, name: 'all_users' }, { id: 8, name: 'pacs_users' }] } };
    if (url === 'https://cube.example.org/api/v1/groups/7/users/?limit=100') return { status: 200, body: { next: 'http://cube.example.org/api/v1/groups/7/users/?limit=100&offset=100', results: [{ user_id: 3, user_username: 'rudolph', user_email: 'r@example.org' }, { user_id: 1, user_username: 'chris', user_email: 'dev@babyMRI.org' }] } };
    if (url === 'https://cube.example.org/api/v1/groups/7/users/?limit=100&offset=100') return { status: 200, body: { next: null, results: [{ user_id: 4, user_username: 'jennings', user_email: 'j@example.org' }] } };
    if (url === 'https://cube.example.org/api/v1/groups/8/users/?limit=100') return { status: 200, body: { next: null, results: [{ user_id: 1, user_username: 'chris', user_email: 'dev@babyMRI.org' }] } };
    return { status: 404, body: null };
  };
  return { get, asked };
}

describe('what runs of a ChRIS', () => {
  it('reads CUBE, the admin\'s sign-in, every page of its accounts on the public origin, and porter\'s health, sessions and version', async () => {
    const { get, asked } = world_make();
    const live = await chrisLive_read(CHRIS, SECRETS, get);
    expect(live.cube).toEqual({ url: 'https://cube.example.org/api/v1/', status: 200, admin: true });
    expect(live.porter).toEqual({ url: 'https://porter.example.org/healthz', status: 200, sessions: 3, version: '0.9.11' });
    expect(live.accounts?.map((one) => one.username)).toEqual(['chris', 'jennings', 'rudolph']);
    // Each account with CUBE's id and every group it is in; the groups CUBE holds beside them.
    expect(live.accounts?.[0]).toEqual({ username: 'chris', email: 'dev@babyMRI.org', id: 1, groups: ['all_users', 'pacs_users'] });
    expect(live.accounts?.[2]).toEqual({ username: 'rudolph', email: 'r@example.org', id: 3, groups: ['all_users'] });
    expect(live.groups).toEqual(['all_users', 'pacs_users']);
    expect(asked).toContain('https://cube.example.org/api/v1/groups/7/users/?limit=100&offset=100');
    expect(asked.some((url: string): boolean => url.startsWith('http://'))).toBe(false);
  });

  it('says why the accounts were not read: no password kept here, or the admin does not sign in', async () => {
    const { get } = world_make();
    expect(await chrisLive_read(CHRIS, null, get)).toMatchObject({ cube: { status: 401, admin: null }, accounts: null, accountsWhy: 'this host keeps no admin password for it' });
    expect(await chrisLive_read(CHRIS, { ...SECRETS, adminPassword: 'old' }, get)).toMatchObject({ cube: { admin: false }, accounts: null, accountsWhy: 'the admin does not sign in' });
    const silent: HttpGet = async () => null;
    expect(await chrisLive_read(CHRIS, SECRETS, silent)).toMatchObject({ cube: { status: null, admin: null }, porter: { status: null, sessions: null } });
  });
});

describe('what a deploy would do', () => {
  const ask = { profile: 'minimal', compute: 'NERC', host: 'cube.example.org', porter: 'porter.example.org', berths: false };

  it('a replay as deployed restarts nothing and does not ask; a first deploy puts it up and asks', () => {
    expect(chrisPlan_derive(CHRIS, ask, null)).toEqual({ changes: [], restarts: [], sessions: null, asks: false, first: false });
    // A first deploy builds on the machine: it asks, with what it puts up.
    expect(chrisPlan_derive(undefined, ask, null)).toMatchObject({ restarts: [], asks: true, first: true });
  });

  it('a new porter restarts porter and says the sessions it ends; a new host restarts CUBE; an old record says it may restart both', () => {
    const older = { ...CHRIS, porterVersion: '0.9.10' };
    const plan = chrisPlan_derive(older, ask, 3);
    expect(plan.restarts).toEqual([`porter (0.9.10 → ${PORTER_VERSION}): its open sessions end`]);
    expect(plan.asks).toBe(true);
    expect(chrisPlan_words('store', plan)).toBe(`chris deploy store: as deployed; restarts porter (0.9.10 → ${PORTER_VERSION}): its open sessions end; 3 porter sessions open now end`);
    expect(chrisPlan_derive(CHRIS, { ...ask, host: 'cube2.example.org' }, null)).toMatchObject({ changes: ['host cube.example.org → cube2.example.org'], restarts: ['CUBE and its workers (their environment changes)'], asks: true });
    const unknown = { ...CHRIS, image: undefined, porterVersion: undefined };
    delete unknown.image; delete unknown.porterVersion;
    expect(chrisPlan_derive(unknown, ask, 1).restarts).toEqual(['CUBE and porter: their files are written again and Docker restarts what changed in them (this deploy\'s record keeps no versions to compare)']);
    expect(chrisPlan_words('store', chrisPlan_derive(unknown, ask, 0))).toBe('chris deploy store: as deployed; restarts CUBE and porter: their files are written again and Docker restarts what changed in them (this deploy\'s record keeps no versions to compare); no porter session is open now');
    // A compute changed alone is a registration: it changes the record and restarts nothing, and still asks with the change.
    expect(chrisPlan_derive(CHRIS, { ...ask, compute: 'store' }, null)).toEqual({ changes: ['compute NERC → store'], restarts: [], sessions: null, asks: true, first: false });
  });

  it('berths: a first deploy says it puts a berth up for each person; off → on is a change and a porter restart, as deployed asks nothing', () => {
    const berthed = { ...ask, berths: true };
    expect(chrisPlan_derive(undefined, berthed, null).changes).toContain('a berth for each person behind porter, 1 vCPU · 2 GiB each (the berth launcher, the berth image pulled)');
    expect(chrisPlan_derive(undefined, { ...berthed, berthLimits: { cpus: 1.5, memoryGib: 4 } }, null).changes).toContain('a berth for each person behind porter, 1.5 vCPU · 4 GiB each (the berth launcher, the berth image pulled)');
    expect(chrisPlan_derive(undefined, ask, null).changes.some((one: string): boolean => one.includes('berth'))).toBe(false);
    const on = chrisPlan_derive(CHRIS, berthed, 2);
    expect(on).toMatchObject({ changes: ['berths off → on'], restarts: ['porter (berths on): its open sessions end'], asks: true, first: false });
    const had = { ...CHRIS, berths: 'launcher' as const, berthImage: 'ghcr.io/fnndsc/berth@sha256:' + 'a'.repeat(64) };
    expect(chrisPlan_derive(had, berthed, null)).toEqual({ changes: [], restarts: [], sessions: null, asks: false, first: false });
    // Limits: a record without them ran the defaults; a change on a replay with berths on is a change and a launcher restart, not a porter restart.
    expect(chrisPlan_derive(had, { ...berthed, berthLimits: { cpus: 1, memoryGib: 2 } }, null).asks).toBe(false);
    const limited = { ...had, berthLimits: { cpus: 1, memoryGib: 2 } };
    expect(chrisPlan_derive(limited, { ...berthed, berthLimits: { cpus: 2, memoryGib: 4 } }, 3)).toEqual({ changes: ['berth limits 1 vCPU · 2 GiB → 2 vCPU · 4 GiB'], restarts: ['the berth launcher: running berths keep their limits and sessions until their next start, which needs a fresh login'], sessions: 3, asks: true, first: false });
    expect(chrisPlan_derive({ ...had, berthLimits: { cpus: 0.5, memoryGib: 1.5 } }, berthed, null).changes).toEqual(['berth limits 0.5 vCPU · 1.5 GiB → 1 vCPU · 2 GiB']);
    // Berths turning on or off carry no limits change.
    expect(chrisPlan_derive(CHRIS, { ...berthed, berthLimits: { cpus: 2, memoryGib: 4 } }, null).changes).toEqual(['berths off → on']);
    expect(chrisPlan_derive(had, ask, null)).toMatchObject({ changes: ['berths on → off'], restarts: ['porter (berths off): its open sessions end, and the running berths stop (their homes are kept)'], asks: true });
  });
});
