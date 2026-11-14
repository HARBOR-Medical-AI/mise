/**
 * @file `touch` through a link: a file made or written past a `.chrislink`,
 * by the feed path or by the graph's own address, lands in the link's
 * target; a target that refuses fails the command, and it says so.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_touch } = await import('../src/builtins/fs/touch.js');

type LinkedStore = ReturnType<typeof linkedStore_install>;

let store: LinkedStore;

beforeEach((): void => {
  store = linkedStore_install();
});

describe('touch through a link', () => {
  it.each([[VIA_PROC], [VIA_FEED]])('makes an empty file in the link\'s target (%s)', async (via: string) => {
    const envelope = await builtin_touch([`${via}/new.txt`]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain(`${via}/new.txt`);
    expect(store.entries.get(`${LINKED}/new.txt`)).toEqual({ type: 'file', content: '' });
  });

  it.each([[VIA_PROC], [VIA_FEED]])('writes text into the link\'s target (%s)', async (via: string) => {
    const envelope = await builtin_touch(['--withContents', 'hi', `${via}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(store.entries.get(`${LINKED}/hello.txt`)).toEqual({ type: 'file', content: 'hi' });
    expect(store.calls).toContain(`write ${LINKED}/hello.txt`);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('leaves a file already in the link\'s target as it is (%s)', async (via: string) => {
    expect((await builtin_touch([`${via}/hello.txt`])).status).toBe('ok');
    expect(store.entries.get(`${LINKED}/hello.txt`)?.content).toBe('hello\nworld\n');
    expect(store.calls.some((call: string): boolean => call.startsWith('write'))).toBe(false);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('fails, and says so, when the target folder refuses (%s)', async (via: string) => {
    store.refusing.add(LINKED);
    const envelope = await builtin_touch(['--withContents', 'hi', `${via}/new.txt`]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain(`Failed to create file: ${via}/new.txt`);
    expect(envelope.renderedErr).toContain('Permission denied');
    expect(store.entries.has(`${LINKED}/new.txt`)).toBe(false);
  });
});
