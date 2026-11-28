/**
 * @file Whether a daemon may start beside this runtime's record of its identity.
 *
 * Every listener here is this test's own, on loopback.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { berth_write, type Berth } from '../src/daemon/berth.js';
import { rival_read, rivalRefusal_lines } from '../src/daemon/rival.js';

const IDENTITY: string = 'chris@http://cube/api/v1/';
let runtimeBefore: string | undefined;

beforeEach(() => {
  runtimeBefore = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'rival-run-'));
});

afterEach(() => {
  if (runtimeBefore === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = runtimeBefore;
});

/** A loopback listener of this test's; its port and a close. */
async function listener_start(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('a start beside a record', () => {
  it('no record: a daemon may start', async () => {
    expect(await rival_read(IDENTITY)).toBeNull();
  });

  it('an earlier release\'s record in a valid runtime folder whose address answers: refused, with how to stop it and no pid to kill', async () => {
    const { port, close } = await listener_start();
    try {
      const legacy: Berth = { identity: IDENTITY, url: `ws://127.0.0.1:${port}`, token: 't', pid: 777 };
      berth_write(legacy);
      const rival = await rival_read(IDENTITY);
      expect(rival?.liveness).toBe('unverified');
      const [refusal, hint] = rivalRefusal_lines(rival!, '');
      expect(refusal).toContain('A daemon of an earlier release may still be running');
      expect(refusal).toContain('(pid 777 when it was written)');
      expect(hint).toBe('    Stop the old daemon from its original terminal (Ctrl-C at the idle daemon prompt) or through its service manager, then retry.');
      expect(`${refusal}${hint}`).not.toMatch(/\bkill\b/);
    } finally {
      await close();
    }
  });

  it('the same record with nothing listening: a daemon may start', async () => {
    const { port, close } = await listener_start();
    await close();
    berth_write({ identity: IDENTITY, url: `ws://127.0.0.1:${port}`, token: 't', pid: 777 });
    expect(await rival_read(IDENTITY)).toBeNull();
  });

  it('a live record: refused, pointed at it', async () => {
    berth_write({ identity: IDENTITY, url: 'ws://127.0.0.1:1', token: 't' });
    const rival = await rival_read(IDENTITY, async () => 'live');
    expect(rivalRefusal_lines(rival!, ` ${IDENTITY}`)).toEqual([`[!] Calypso is already running for ${IDENTITY} at ws://127.0.0.1:1`, `    attach with:  chell --remote ${IDENTITY}`]);
  });

  it('a keyed record whose instance does not answer: a daemon may start', async () => {
    berth_write({ identity: IDENTITY, url: 'ws://127.0.0.1:1', token: 't', pid: 1, booted: 'b', probeKey: 'a'.repeat(64) });
    expect(await rival_read(IDENTITY)).toBeNull();
  });
});
