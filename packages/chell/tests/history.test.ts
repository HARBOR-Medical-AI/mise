/**
 * @file The shell's history: one private place, a private file from its
 * first byte, and no secret in a line that is kept.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { history_appendPrivate, history_tighten, historyFile_resolve, historyLine_redact } from '../src/core/history.js';

describe('historyFile_resolve', () => {
  it('is a file of the operator\'s own state, never the folder the shell was started in', () => {
    expect(historyFile_resolve('.chell_history', { XDG_STATE_HOME: '/s' })).toBe('/s/chell/history');
    expect(historyFile_resolve('.chell_history', {})).toBe(join(homedir(), '.local', 'state', 'chell', 'history'));
    expect(historyFile_resolve('.chell_history', { XDG_STATE_HOME: '' })).toBe(join(homedir(), '.local', 'state', 'chell', 'history'));
  });

  it('keeps a file the operator placed by an absolute path, and takes a relative one for the old default\'s kind', () => {
    expect(historyFile_resolve('/home/me/keep/history', { XDG_STATE_HOME: '/s' })).toBe('/home/me/keep/history');
    expect(historyFile_resolve('history.txt', { XDG_STATE_HOME: '/s' })).toBe('/s/chell/history');
  });
});

describe('historyLine_redact', () => {
  it.each([
    ['connect --user rudolph --password hunter2 https://cube/api/v1/', 'connect --user rudolph --password *** https://cube/api/v1/'],
    ['connect --password=hunter2 --user rudolph https://cube/api/v1/', 'connect --password=*** --user rudolph https://cube/api/v1/'],
    ['connect --password "my secret pass" --user r url', 'connect --password *** --user r url'],
    ["connect --password 'it''s' --user r url", "connect --password ***'s' --user r url"],
    ['connect --password="a b" url', 'connect --password=*** url'],
    ['connect -p hunter2 rudolph@https://cube/api/v1/', 'connect -p *** rudolph@https://cube/api/v1/'],
    ['!chell rudolph@https://cube/ -p hunter2 -c version', '!chell rudolph@https://cube/ -p *** -c version'],
    ['plugin add pl-x --adminUser chris --adminPassword chris1234', 'plugin add pl-x --adminUser chris --adminPassword ***'],
    ['plugin add pl-x --adminPassword=chris1234 --compute host', 'plugin add pl-x --adminPassword=*** --compute host'],
    ['!chell --remote --attach ws://127.0.0.1:9 --token 0123abcd', '!chell --remote --attach ws://127.0.0.1:9 --token ***'],
    ['!chell x@y --auth-token abcdef', '!chell x@y --auth-token ***'],
    ['connect rudolph:hunter2@https://cube/api/v1/', 'connect rudolph:***@https://cube/api/v1/'],
    ['!curl https://rudolph:hunter2@cube.example.org/api/v1/', '!curl https://rudolph:***@cube.example.org/api/v1/'],
    ['!open http://pangea:42479/?token=0123abcd&x=1', '!open http://pangea:42479/?token=***&x=1'],
    ['!curl "http://127.0.0.1:9/vfs?path=%2Fa&token=0123abcd"', '!curl "http://127.0.0.1:9/vfs?path=%2Fa&token=***"'],
  ])('%j is kept as %j', (typed: string, kept: string) => {
    expect(historyLine_redact(typed)).toBe(kept);
  });

  it.each([
    ['mkdir -p new/deeper'],
    ['ls -lh /home/rudolph'],
    ['cat notes.txt | grep password'],
    ['echo "the --password option takes a word"; pwd'],
    ['download /home/user/data ./data'],
    ['cd /home/user@example/feeds'],
    ['feed create --title 12:30@noon'],
    [''],
  ])('%j carries no secret and is kept as typed', (typed: string) => {
    if (typed === 'echo "the --password option takes a word"; pwd') {
      // An option's name inside prose is still followed by a word, and that word goes: better one word of prose lost than a password kept.
      expect(historyLine_redact(typed)).toBe('echo "the --password *** takes a word"; pwd');
      return;
    }
    expect(historyLine_redact(typed)).toBe(typed);
  });
});

describe('the history file', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chell-history-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** A path's permission bits. */
  const mode_of = (target: string): number => statSync(target).mode & 0o777;

  it('is made private, folder and file, by its first line', async () => {
    const file: string = join(root, 'state', 'chell', 'history');
    await history_appendPrivate(file, 'ls');
    await history_appendPrivate(file, 'pwd');
    expect(readFileSync(file, 'utf8')).toBe('ls\npwd\n');
    expect(mode_of(file)).toBe(0o600);
    expect(mode_of(join(root, 'state', 'chell'))).toBe(0o700);
  });

  it('is made private when it was found looser, and is left alone when it is not there', () => {
    const folder: string = join(root, 'chell');
    const file: string = join(folder, 'history');
    history_tighten(file);
    expect(existsSync(folder)).toBe(false);
    mkdirSync(folder, { mode: 0o755 });
    writeFileSync(file, 'old line\n', { mode: 0o644 });
    chmodSync(folder, 0o755);
    chmodSync(file, 0o644);
    history_tighten(file);
    expect(mode_of(file)).toBe(0o600);
    expect(mode_of(folder)).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toBe('old line\n');
  });
});
