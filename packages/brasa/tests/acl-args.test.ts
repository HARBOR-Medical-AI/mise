/**
 * @file Unit tests for the words of a feed's access list: user, group and
 * other entries; `-x` for a user or a group; the targets a feed is named
 * by; getfacl's block. The lines themselves are parsed against their
 * declarations (`acl-builtin.test.ts`).
 */

import { describe, it, expect } from '@jest/globals';
import {
  aclEntry_parse, aclRemoval_parse, aclTarget_resolve, acl_render,
} from '../src/builtins/fs/acl.args.js';

describe('access control entries', () => {
  it('reads user, group and other entries, short and long', () => {
    expect(aclEntry_parse('u:someone:r')).toEqual({ kind: 'user', name: 'someone', perms: 'r' });
    expect(aclEntry_parse('user:someone:rw-')).toEqual({ kind: 'user', name: 'someone', perms: 'rw-' });
    expect(aclEntry_parse('g:grantlab:r')).toEqual({ kind: 'group', name: 'grantlab', perms: 'r' });
    expect(aclEntry_parse('o::r')).toEqual({ kind: 'other', name: '', perms: 'r' });
    expect(aclEntry_parse('other::-')).toEqual({ kind: 'other', name: '', perms: '-' });
    expect(aclEntry_parse('o:r')).toEqual({ kind: 'other', name: '', perms: 'r' });
  });

  it('refuses a malformed entry', () => {
    expect(aclEntry_parse('someone')).toBeNull();
    expect(aclEntry_parse('u::r')).toBeNull();
    expect(aclEntry_parse('u:someone:zz')).toBeNull();
    expect(aclEntry_parse('o:x:r')).toBeNull();
    expect(aclEntry_parse('m::r')).toBeNull();
  });

  it('reads a removal for a user (bare or u:) or a group, and refuses the other entry by name', () => {
    expect(aclRemoval_parse('u:ann')).toEqual({ kind: 'user', name: 'ann' });
    expect(aclRemoval_parse('ann')).toEqual({ kind: 'user', name: 'ann' });
    expect(aclRemoval_parse('g:grantlab')).toEqual({ kind: 'group', name: 'grantlab' });
    expect(aclRemoval_parse('o')).toContain('setfacl -m o::-');
    expect(aclRemoval_parse('o::')).toContain('cannot be removed');
  });
});

describe('acl target', () => {
  it('accepts an id, the name a listing shows, any path through /feeds/, and /proc/jobs/feed_N', () => {
    expect(aclTarget_resolve('12')).toBe(12);
    expect(aclTarget_resolve('feed_12')).toBe(12);
    expect(aclTarget_resolve('/home/someone/feeds/feed_12/pl-dircopy_3/data')).toBe(12);
    expect(aclTarget_resolve('/SHARED/someone/feeds/feed_4299')).toBe(4299);
    expect(aclTarget_resolve('/proc/jobs/feed_880')).toBe(880);
  });

  it('refuses what names no feed', () => {
    expect(aclTarget_resolve('/home/someone/uploads')).toBeNull();
    expect(aclTarget_resolve('0')).toBeNull();
  });
});

describe('getfacl rendering', () => {
  it('wears the shape getfacl wears: owner entry, users, groups, then other', () => {
    expect(acl_render('/home/me/feeds/feed_12', 'me', { users: ['ann'], groups: ['lab'], public: true })).toBe(
      ['# file: home/me/feeds/feed_12', '# owner: me', 'user::rw-', 'user:ann:r--', 'group:lab:r--', 'other::r--'].join('\n'),
    );
    expect(acl_render('feed_12', null, { users: [], groups: [], public: false })).toBe(['# file: feed_12', 'user::rw-', 'other::---'].join('\n'));
  });
});
