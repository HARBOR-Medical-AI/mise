/**
 * @file Where a path stands in ChRIS after a read of it failed: asked of the
 * session's tree at the path the store keeps, and unknown whenever even
 * that could not be worked out.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const asked: string[] = [];
let resolve: (typed: string) => Promise<string> = async (typed: string): Promise<string> => typed;
let standing: (path: string) => Promise<string> = async (): Promise<string> => 'unknown';

cuminMock_install(() => ({}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ storePath_resolve: (typed: string): Promise<string> => resolve(typed) }));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({ path_standing: (path: string): Promise<string> => { asked.push(path); return standing(path); } }),
}));

const { chrisFiles } = await import('../src/chris/files.js');

describe('chrisFiles.standing', () => {
  it('asks the session\'s tree about the path the store keeps, links and job data followed', async () => {
    resolve = async (typed: string): Promise<string> => (typed === '/proc/jobs/7/data/x.mise' ? '/home/u/feeds/feed_1/pl-a_7/data/x.mise' : typed);
    standing = async (path: string): Promise<string> => (path.endsWith('x.mise') ? 'absent' : 'unknown');
    expect(await chrisFiles.standing!('/proc/jobs/7/data/x.mise')).toBe('absent');
    expect(asked).toEqual(['/home/u/feeds/feed_1/pl-a_7/data/x.mise']);
  });

  it('is unknown when the path cannot be resolved, or the tree cannot be asked', async () => {
    resolve = async (): Promise<string> => { throw new Error('the link could not be followed'); };
    expect(await chrisFiles.standing!('/home/u/link/x.mise')).toBe('unknown');
    resolve = async (typed: string): Promise<string> => typed;
    standing = async (): Promise<string> => { throw new Error('no tree'); };
    expect(await chrisFiles.standing!('/home/u/x.mise')).toBe('unknown');
  });
});
