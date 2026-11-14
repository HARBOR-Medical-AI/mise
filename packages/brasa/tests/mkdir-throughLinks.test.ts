/**
 * @file `mkdir` through a link: a folder made past a `.chrislink`, by the
 * feed path or by the graph's own address, is made in the link's target,
 * `-p` parents included; a target that refuses fails the command, and it
 * says so.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_mkdir } = await import('../src/builtins/fs/mkdir.js');

type LinkedStore = ReturnType<typeof linkedStore_install>;

let store: LinkedStore;

beforeEach((): void => {
  store = linkedStore_install();
});

describe('mkdir through a link', () => {
  it.each([[VIA_PROC], [VIA_FEED]])('makes the folder in the link\'s target (%s)', async (via: string) => {
    const envelope = await builtin_mkdir([`${via}/new`]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain(`${via}/new`);
    expect(store.entries.get(`${LINKED}/new`)).toEqual({ type: 'dir' });
    expect(store.calls).toContain(`mkdir ${LINKED}/new`);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('makes parents in the link\'s target with -p (%s)', async (via: string) => {
    const envelope = await builtin_mkdir(['-p', `${via}/a/b`]);
    expect(envelope.status).toBe('ok');
    expect(store.entries.get(`${LINKED}/a`)).toEqual({ type: 'dir' });
    expect(store.entries.get(`${LINKED}/a/b`)).toEqual({ type: 'dir' });
  });

  it.each([[VIA_PROC], [VIA_FEED]])('fails, and says so, when the target folder refuses (%s)', async (via: string) => {
    store.refusing.add(LINKED);
    const envelope = await builtin_mkdir([`${via}/new`]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain(`mkdir: cannot create directory '${via}/new': Permission denied`);
    expect(store.entries.has(`${LINKED}/new`)).toBe(false);
  });
});
