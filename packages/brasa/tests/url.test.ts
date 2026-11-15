/**
 * @file `url`: a web address that opens ARGUS at a path — the door with the
 * resolved path as its fragment, or the fragment alone and a word when no
 * door is known.
 */
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: async (): Promise<string> => '/home/rudolph/feeds/feed_4389' } }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: async (p: string): Promise<string> => (p.startsWith('/') ? p : `/home/rudolph/${p}`) }));

const { builtin_url, url_compose } = await import('../src/builtins/fs/url.js');

describe('url', () => {
  it('composes the door with the path as its fragment, spaces escaped', () => {
    expect(url_compose('https://titan.tch.harvard.edu/', '/home/s/uploads/3d anon')).toBe('https://titan.tch.harvard.edu/#/home/s/uploads/3d%20anon');
    expect(url_compose('', '/proc/jobs/feed_4389')).toBe('#/proc/jobs/feed_4389');
  });

  it('opens where the session stands when given no path', async () => {
    const envelope = await builtin_url([], { CHELL_DOOR: 'https://titan.tch.harvard.edu' });
    expect(envelope.rendered).toBe('https://titan.tch.harvard.edu/#/home/rudolph/feeds/feed_4389\n');
    expect(envelope.model).toEqual({ kind: 'fs.url', data: { path: '/home/rudolph/feeds/feed_4389', url: 'https://titan.tch.harvard.edu/#/home/rudolph/feeds/feed_4389' } });
  });

  it('resolves a relative path, and says so when no door is known', async () => {
    const envelope = await builtin_url(['uploads'], {});
    expect(envelope.rendered).toContain('#/home/rudolph/uploads\n');
    expect(envelope.rendered).toContain('No door is known to this session (CHELL_DOOR is unset)');
  });

  it('refuses two paths, and an option it does not take, in the parser\'s words', async () => {
    const two = await builtin_url(['a', 'b'], {});
    expect(two.status).toBe('error');
    expect(two.renderedErr).toContain("url: unexpected operand 'b'; usage: url [path]");
    expect((await builtin_url(['--long'], {})).renderedErr).toContain("url: unrecognized option '--long'");
  });

  it('is declared with a core kind only, and described as a tool', async () => {
    const { urlCommand } = await import('../src/builtins/fs/url.js');
    const { commandTools_derive } = await import('../src/core/commandSchema.js');
    expect(urlCommand.grammar.operands.map((operand) => operand.kind)).toEqual(['cfsPath']);
    expect(urlCommand.help.category).toBe('Sharing');
    expect(commandTools_derive(urlCommand)[0]?.inputSchema).toEqual(expect.objectContaining({ properties: { path: expect.objectContaining({ type: 'string' }) } }));
  });
});
