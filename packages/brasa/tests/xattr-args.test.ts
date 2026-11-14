/**
 * @file Unit tests for the words of a feed's tags: its targets and the dump.
 * The lines are parsed against their declarations
 * (`xattr-builtin.test.ts`).
 */
import { describe, it, expect } from '@jest/globals';
import { xattrTarget_resolve, xattr_render } from '../src/builtins/fs/xattr.args.js';

describe('targets and rendering', () => {
  it('resolves a feed by id, feed_N, a /feeds/ path, or its /proc projection', () => {
    expect(xattrTarget_resolve('12')).toBe(12);
    expect(xattrTarget_resolve('feed_12')).toBe(12);
    expect(xattrTarget_resolve('/home/me/feeds/feed_12/pl-dircopy_3')).toBe(12);
    expect(xattrTarget_resolve('/proc/jobs/feed_12')).toBe(12);
    expect(xattrTarget_resolve('/home/me/uploads')).toBeNull();
  });

  it("renders getfattr's dump shape, quoting a value's quotes", () => {
    expect(xattr_render('feed_12', ['urgent', 'say "hi"'])).toBe('# file: feed_12\ntag="urgent"\ntag="say \\"hi\\""');
    expect(xattr_render('feed_12', [])).toBe('# file: feed_12');
  });
});
