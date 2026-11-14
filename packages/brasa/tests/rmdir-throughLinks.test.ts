/**
 * @file `rmdir` through a link: an empty folder past a `.chrislink`, by the
 * feed path or by the graph's own address, is removed from the link's
 * target; the link itself, named as the operand, is asked of as the entry
 * it is (not a folder), and the folder it points at stays.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_rmdir } = await import('../src/builtins/fs/rmdir.js');

type LinkedStore = ReturnType<typeof linkedStore_install>;

let store: LinkedStore;

beforeEach((): void => {
  process.exitCode = 0;
  store = linkedStore_install();
  store.entries.set(`${LINKED}/empty`, { type: 'dir' });
});

describe('rmdir through a link', () => {
  it.each([[VIA_PROC], [VIA_FEED]])('removes the empty folder in the link\'s target (%s)', async (via: string) => {
    const envelope = await builtin_rmdir([`${via}/empty`]);
    expect(envelope.status).toBe('ok');
    expect(store.entries.has(`${LINKED}/empty`)).toBe(false);
    expect(store.calls).toContain(`rmdir ${LINKED}/empty`);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('fails, and says so, when the target folder refuses (%s)', async (via: string) => {
    store.refusing.add(LINKED);
    const envelope = await builtin_rmdir([`${via}/empty`]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain(`rmdir: failed to remove '${via}/empty': Permission denied`);
    expect(store.entries.has(`${LINKED}/empty`)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('asks of the link itself, never of the folder it points at (%s)', async (via: string) => {
    const envelope = await builtin_rmdir([via]);
    expect(envelope.status).toBe('error');
    expect(store.calls).toContain(`rmdir ${VIA_FEED}`);
    expect(store.calls).not.toContain(`rmdir ${LINKED}`);
    expect(store.entries.has(LINKED)).toBe(true);
  });
});
