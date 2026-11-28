/**
 * @file Tests for the attach note.
 *
 * The note carries an attach token, so what matters is not that it writes but *how*: owner-only, in the berth's own
 * folder, never through something planted at the path, and left for the next daemon to replace.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachFile_path, attachFile_write, attachNote_lines } from '../src/daemon/attachFile.js';

let runtimeBefore: string | undefined;

beforeEach(() => {
  // Each test its own runtime folder: nothing shared, nothing to clean.
  runtimeBefore = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'attach-run-'));
});

afterEach(() => {
  if (runtimeBefore === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = runtimeBefore;
});

describe('attachFile', () => {
  it('writes the lines it was given, in the berth folder', () => {
    const path = attachFile_write(['wire: ws://host:1', 'token: secret']);

    expect(path).toBe(attachFile_path());
    expect(path).toBe(join(process.env.XDG_RUNTIME_DIR as string, 'calypso', 'attach.txt'));
    expect(readFileSync(path as string, 'utf8')).toBe('wire: ws://host:1\ntoken: secret\n');
  });

  it('is readable only by its owner, in a folder only its owner can use', () => {
    const path = attachFile_write(['token: secret']) as string;

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(process.env.XDG_RUNTIME_DIR as string, 'calypso')).mode & 0o777).toBe(0o700);
  });

  it('replaces a stale note whole', () => {
    attachFile_write(['old']);
    const path = attachFile_write(['new']) as string;

    expect(readFileSync(path, 'utf8')).toBe('new\n');
  });

  it('refuses to write through a symlink planted at the path, leaving the link and its target as they are', () => {
    const decoy = join(mkdtempSync(join(tmpdir(), 'attach-decoy-')), 'target');
    writeFileSync(decoy, 'untouched');
    mkdirSync(join(process.env.XDG_RUNTIME_DIR as string, 'calypso'), { mode: 0o700 });
    symlinkSync(decoy, attachFile_path());

    expect(attachFile_write(['token: secret'])).toBeNull();
    expect(readFileSync(decoy, 'utf8')).toBe('untouched');
    expect(lstatSync(attachFile_path()).isSymbolicLink()).toBe(true);
  });

  it('the retained note carries no credential: no token, no tokened link, no direct attach command', () => {
    const lines: string[] = attachNote_lines('chris@http://cube/api/v1/', '2026-11-28T10:00:00.000Z');
    const text: string = lines.join('\n');
    expect(text).toContain('identity:  chris@http://cube/api/v1/');
    expect(text).toContain('calypso --berths');
    expect(text).not.toMatch(/token=|--token|--attach|wss?:\/\/|ARGUS/);
  });

  it('writes nothing into a berth folder another account could use', () => {
    const folder = join(process.env.XDG_RUNTIME_DIR as string, 'calypso');
    mkdirSync(folder, { mode: 0o777 });
    // umask may have narrowed the mode: set it outright.
    chmodSync(folder, 0o777);

    expect(attachFile_write(['token: secret'])).toBeNull();
  });
});
