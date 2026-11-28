/**
 * @file The token store across processes: real child processes, each its
 * own Node over the built store (`dist/tokens.js`, which CI builds before
 * it tests), writing one folder at once. What one process reports as made
 * is in the final store; a process that dies before its publication leaves
 * nothing that blocks the next, and one that dies after leaves its version
 * whole.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenStore } from '../../src/tokens.js';

const BUILT: string = fileURLToPath(new URL('../../dist/tokens.js', import.meta.url));
const SOURCE: string = fileURLToPath(new URL('../../src/tokens.ts', import.meta.url));

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'porter-processes-'));
  path = join(dir, 'tokens.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * Runs a script in a child Node over the built store.
 *
 * @param body - The script, given `store` (opened) and `TokenStore`.
 * @param hooks - Hooks' bodies by name, as source.
 * @returns What it printed, and how it ended.
 */
function child_run(body: string, hooks: string = '{}'): Promise<{ out: string; code: number | null }> {
  const script: string = `
    import { TokenStore } from ${JSON.stringify(BUILT)};
    const store = new TokenStore(${JSON.stringify(path)}, 30, () => new Date(), ${hooks});
    store.load();
    ${body}
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out: string = '';
    child.stdout.on('data', (chunk: Buffer): void => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer): void => { out += chunk.toString(); });
    child.on('exit', (code: number | null): void => { resolve({ out, code }); });
  });
}

describe('the token store across processes', () => {
  it('runs over a build no older than its source', () => {
    expect(existsSync(BUILT)).toBe(true);
    expect(statSync(BUILT).mtimeMs).toBeGreaterThanOrEqual(statSync(SOURCE).mtimeMs);
  });

  it('four processes minting at once: every mint each reports is in the final store', async () => {
    new TokenStore(path, 30).load();
    const runs = await Promise.all([0, 1, 2, 3].map((p: number) => child_run(`
      for (let i = 0; i < 15; i++) { const made = store.mint('u${String(p)}-' + i + '@c/', 'u${String(p)}-' + i, 'n'); console.log('MADE ' + made.record.user); }
    `)));
    const reported: string[] = runs.flatMap((run) => run.out.split('\n').filter((line) => line.startsWith('MADE ')).map((line) => line.slice(5)));
    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(reported).toHaveLength(60);
    const final = new TokenStore(path, 30);
    final.load();
    expect(final.list().map((t) => t.user).sort()).toEqual([...reported].sort());
  });

  it('a revocation and logins of the same token in other processes: revoked stays revoked', async () => {
    const seed = new TokenStore(path, 30);
    seed.load();
    const held = seed.mint('kim@c/', 'kim', 'laptop');
    const logins = [0, 1, 2].map(() => child_run(`
      for (let i = 0; i < 20; i++) store.login_authorize(${JSON.stringify(held.token)}, (u) => u + '@c/');
    `));
    const revoke = child_run(`console.log('GONE ' + store.revoke('kim', 'laptop'));`);
    const [r] = await Promise.all([revoke, ...logins]);
    expect(r.out).toContain('GONE 1');
    const final = new TokenStore(path, 30);
    final.load();
    expect(final.check(held.token)).toEqual({ ok: false, why: 'unknown' });
  });

  it('a process that dies before its publication leaves nothing in the way; one that dies after leaves its version whole', async () => {
    new TokenStore(path, 30).load();
    const before = await child_run(`store.mint('a@c/', 'a', 'n');`, `{ read_after: () => process.exit(7) }`);
    expect(before.code).toBe(7);
    const after = await child_run(`store.mint('b@c/', 'b', 'n');`, `{ publish_after: () => process.exit(8) }`);
    expect(after.code).toBe(8);
    const next = await child_run(`store.mint('c@c/', 'c', 'n'); console.log('OK');`);
    expect(next.out).toContain('OK');
    const final = new TokenStore(path, 30);
    final.load();
    expect(final.list().map((t) => t.user).sort()).toEqual(['b', 'c']);
  });

  it('four first opens of a never-migrated store at once: one version 1, and every opener reads it', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [{ name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null }] }));
    const runs = await Promise.all([0, 1, 2, 3].map(() => child_run(`console.log('SEES ' + store.list().map((t) => t.name).join(','));`)));
    expect(runs.every((run) => run.code === 0 && run.out.includes('SEES laptop'))).toBe(true);
    expect(readdirSync(`${path}.d/s0`).filter((name) => name.endsWith('.json'))).toEqual(['1.json']);
    expect(existsSync(path)).toBe(false);
  });
});
