/**
 * @file Tests for command-line pipe, redirect, wildcard, and shell preprocessing.
 *
 * Exercises the exported pure parsing seams and directory-target resolution;
 * temporary filesystem state is isolated to one suite-owned directory.
 *
 * @module
 */

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  Ok: <T>(value: T) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
  errorStack: { stack_push: jest.fn() },
}));

const {
  pipes_parse,
  redirect_parse,
  redirectTarget_resolve,
  pathnameExpansion_isEligible,
  command_shellEscape_detect,
} = await import('../src/core/preprocess.js');

describe('pipes_parse', () => {
  it('returns a single segment when there is no pipe', () => {
    expect(pipes_parse('ls /home')).toEqual(['ls /home']);
  });
  it('splits on unquoted pipes and trims segments', () => {
    expect(pipes_parse('ls /bin | grep pl | wc -l')).toEqual(['ls /bin', 'grep pl', 'wc -l']);
  });
  it('ignores pipes inside single or double quotes', () => {
    expect(pipes_parse('echo "a | b"')).toEqual(['echo "a | b"']);
    expect(pipes_parse("echo 'a | b'")).toEqual(["echo 'a | b'"]);
  });
  it('ignores an escaped pipe', () => {
    expect(pipes_parse('cat \\|')).toEqual(['cat \\|']);
  });
  it('drops a trailing empty segment', () => {
    expect(pipes_parse('ls |')).toEqual(['ls']);
  });
});

describe('redirect_parse', () => {
  it('returns null when there is no redirection', () => {
    expect(redirect_parse('ls /home')).toBeNull();
  });
  it('parses an overwrite redirect', () => {
    expect(redirect_parse('cat a.txt > out.txt')).toEqual({
      command: 'cat a.txt',
      operator: '>',
      filePath: 'out.txt',
    });
  });
  it('parses an append redirect', () => {
    expect(redirect_parse('cat a.txt >> out.txt')).toEqual({
      command: 'cat a.txt',
      operator: '>>',
      filePath: 'out.txt',
    });
  });
  it('ignores redirect operators inside quotes', () => {
    expect(redirect_parse('echo "a > b"')).toBeNull();
  });
  it('ignores an escaped redirect operator', () => {
    expect(redirect_parse('echo \\>')).toBeNull();
  });
});

describe('pathnameExpansion_isEligible', () => {
  it('expands ordinary command arguments without an allow-list', () => {
    expect(pathnameExpansion_isEligible('ls', 0, 1)).toBe(true);
    expect(pathnameExpansion_isEligible('connect', 0, 1)).toBe(true);
  });

  // download is declared: its grammar says which operands glob, so the
  // table is never asked about it (commandDeclarations.test.ts).
  it('keeps upload\'s host operands out of CFS/VFS expansion', () => {
    expect(pathnameExpansion_isEligible('upload', 0, 2)).toBe(false);
  });
});

describe('command_shellEscape_detect', () => {
  it('detects a leading bang', () => {
    expect(command_shellEscape_detect('!echo hi')).toBe(true);
    expect(command_shellEscape_detect('echo hi')).toBe(false);
  });
});

describe('redirectTarget_resolve', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'chell-redir-'));
    file = path.join(dir, 'existing.txt');
    writeFileSync(file, 'data');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the path unchanged for a non-existent target', () => {
    const target = path.join(dir, 'nope.txt');
    const r = redirectTarget_resolve(target, 'cat a.txt');
    expect(r.ok && r.value).toBe(target);
  });

  it('returns the path unchanged for an existing regular file', () => {
    const r = redirectTarget_resolve(file, 'cat a.txt');
    expect(r.ok && r.value).toBe(file);
  });

  it('joins the cat source basename when the target is a directory', () => {
    const r = redirectTarget_resolve(dir, 'cat /home/chris/brain.mgz');
    expect(r.ok && r.value).toBe(path.join(dir, 'brain.mgz'));
  });

  it.each(['--highlight', '--highlight=python', '--no-highlight'])(
    'ignores the cat %s option when deriving a redirected filename',
    (option: string): void => {
      const r = redirectTarget_resolve(dir, `cat /home/chris/script.py ${option}`);
      expect(r.ok && r.value).toBe(path.join(dir, 'script.py'));
    },
  );

  it('errors when the target is a directory and the command is not cat', () => {
    expect(redirectTarget_resolve(dir, 'ls /home').ok).toBe(false);
  });

  it('errors when cat has no source file', () => {
    expect(redirectTarget_resolve(dir, 'cat').ok).toBe(false);
  });

  it('errors when cat has multiple source files', () => {
    expect(redirectTarget_resolve(dir, 'cat a.txt b.txt').ok).toBe(false);
  });
});
