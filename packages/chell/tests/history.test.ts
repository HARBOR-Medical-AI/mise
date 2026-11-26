/**
 * @file The shell's history: one private place, a file shown private
 * before a byte is written, and no part of a secret in a line that is kept.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { history_appendPrivate, history_readPrivate, historyFile_resolve, historyLine_redact, recall_accept, HistoryPrivacyError } from '../src/core/history.js';

describe('historyFile_resolve', () => {
  const HOME_STATE: string = join(homedir(), '.local', 'state', 'chell', 'history');

  it('is a file of the operator\'s own state, never the folder the shell was started in', () => {
    expect(historyFile_resolve('.chell_history', { XDG_STATE_HOME: '/s' })).toEqual({ file: '/s/chell/history', ownFolder: true });
    expect(historyFile_resolve('.chell_history', {})).toEqual({ file: HOME_STATE, ownFolder: true });
    expect(historyFile_resolve('.chell_history', { XDG_STATE_HOME: '' })).toEqual({ file: HOME_STATE, ownFolder: true });
  });

  it('passes over a relative XDG_STATE_HOME, which would be the folder the shell stands in', () => {
    for (const relative of ['state', './state', '.', '../state']) {
      expect(historyFile_resolve('.chell_history', { XDG_STATE_HOME: relative })).toEqual({ file: HOME_STATE, ownFolder: true });
    }
  });

  it('keeps a file the operator placed by an absolute path, whose folder is theirs and not the shell\'s to change', () => {
    expect(historyFile_resolve('/home/me/keep/history', { XDG_STATE_HOME: '/s' })).toEqual({ file: '/home/me/keep/history', ownFolder: false });
    expect(historyFile_resolve('history.txt', { XDG_STATE_HOME: '/s' })).toEqual({ file: '/s/chell/history', ownFolder: true });
  });
});

describe('historyLine_redact', () => {
  it.each([
    ['connect --user rudolph --password hunter2 https://cube/api/v1/', 'connect --user rudolph --password *** https://cube/api/v1/'],
    ['connect --password=hunter2 --user rudolph https://cube/api/v1/', 'connect --password=*** --user rudolph https://cube/api/v1/'],
    ['connect --password "my secret pass" --user r url', 'connect --password *** --user r url'],
    // Quotes joined to quotes are one word, and the whole word goes.
    ["connect --password 'it''s' --user r url", 'connect --password *** --user r url'],
    ['connect --password "a b"\'c d\'e --user r url', 'connect --password *** --user r url'],
    ['connect --password my\\ secret\\ pass --user r url', 'connect --password *** --user r url'],
    ['connect --password "say \\"hi\\" there" url', 'connect --password *** url'],
    ['connect --password="a b" url', 'connect --password=*** url'],
    ["connect --password='a b'\"c\" url", 'connect --password=*** url'],
    ['connect -p hunter2 rudolph@https://cube/api/v1/', 'connect -p *** rudolph@https://cube/api/v1/'],
    ['connect -p=hunter2 url', 'connect -p=*** url'],
    // A password command later on the line is still one.
    ['cd /home/x; connect -p hunter2 url', 'cd /home/x; connect -p *** url'],
    ['ls && connect -p "hunter 2" url || pwd', 'ls && connect -p *** url || pwd'],
    ['!chell rudolph@https://cube/ -p hunter2 -c version', '!chell rudolph@https://cube/ -p *** -c version'],
    ['plugin add pl-x --adminUser chris --adminPassword chris1234', 'plugin add pl-x --adminUser chris --adminPassword ***'],
    ['plugin add pl-x --adminPassword=chris1234 --compute host', 'plugin add pl-x --adminPassword=*** --compute host'],
    ['!chell --remote --attach ws://127.0.0.1:9 --token 0123abcd', '!chell --remote --attach ws://127.0.0.1:9 --token ***'],
    ['!chell x@y --auth-token abcdef', '!chell x@y --auth-token ***'],
    ['connect rudolph:hunter2@https://cube/api/v1/', 'connect rudolph:***@https://cube/api/v1/'],
    // The bare form, with no scheme, where an identity is expected.
    ['connect rudolph:hunter2@cube.example.org', 'connect rudolph:***@cube.example.org'],
    ['!chell rudolph:hunter2@cube.example.org -c version', '!chell rudolph:***@cube.example.org -c version'],
    ['!curl https://rudolph:hunter2@cube.example.org/api/v1/', '!curl https://rudolph:***@cube.example.org/api/v1/'],
    ['!curl "https://rudolph:hunter 2@cube.example.org/api/v1/"', '!curl https://rudolph:***@cube.example.org/api/v1/'],
    ['!open http://pangea:42479/?token=0123abcd&x=1', '!open http://pangea:42479/?token=***&x=1'],
    ['!curl "http://127.0.0.1:9/vfs?path=%2Fa&token=0123abcd"', '!curl http://127.0.0.1:9/vfs?path=%2Fa&token=***'],
  ])('%j is kept as %j', (typed: string, kept: string) => {
    const out: string | null = historyLine_redact(typed);
    expect(out).toBe(kept);
    // No piece of the secret survives, whatever was expected.
    for (const secret of ['hunter', 'my secret', 'secret pass', "it's", 'a b', 'c d', 'chris1234', '0123abcd', 'abcdef', 'say']) {
      if (typed.includes(secret) && !kept.includes(secret)) expect(out).not.toContain(secret);
    }
  });

  it.each([
    ['mkdir -p new/deeper'],
    ['ls -lh /home/rudolph'],
    ['cat notes.txt | grep password'],
    ['download /home/user/data ./data'],
    ['cd /home/user@example/feeds'],
    ['feed create --title 12:30@noon'],
    ['feed create --title "meet rudolph:soon@noon"'],
    ['echo "the --password option takes a word"; pwd'],
    ['echo \'connect -p x\''],
    ['cd /x; mkdir -p a/b; ls'],
    [''],
  ])('%j carries no secret and is kept as typed', (typed: string) => {
    expect(historyLine_redact(typed)).toBe(typed);
  });

  it('does not keep a line it cannot read word by word that shows the mark of a secret, and keeps one that shows none', () => {
    expect(historyLine_redact('connect --password "hunter2 --user r url')).toBeNull();
    expect(historyLine_redact("connect -p 'hunter2 url")).toBeNull();
    expect(historyLine_redact('!curl "https://rudolph:hunter2@cube/')).toBeNull();
    expect(historyLine_redact('echo "an open quote')).toBe('echo "an open quote');
  });
});

describe('recall_accept', () => {
  it('puts the kept form where the typed line stood, drops a line that is not kept, and leaves any other entry alone', () => {
    const recall: string[] = ['connect --password hunter2 url', 'ls'];
    recall_accept(recall, 'connect --password hunter2 url');
    expect(recall).toEqual(['connect --password *** url', 'ls']);
    const broken: string[] = ['connect --password "hunter2', 'ls'];
    recall_accept(broken, 'connect --password "hunter2');
    expect(broken).toEqual(['ls']);
    const other: string[] = ['pwd', 'ls'];
    recall_accept(other, 'connect --password hunter2 url');
    expect(other).toEqual(['pwd', 'ls']);
    recall_accept(undefined, 'ls');
  });
});

describe('the history file', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chell-history-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** A path's permission bits. */
  const mode_of = (target: string): number => statSync(target).mode & 0o777;

  it('is made private, folder and file, by its first line', async () => {
    const place = { file: join(root, 'state', 'chell', 'history'), ownFolder: true };
    await history_appendPrivate(place, 'ls');
    await history_appendPrivate(place, 'pwd');
    expect(readFileSync(place.file, 'utf8')).toBe('ls\npwd\n');
    expect(mode_of(place.file)).toBe(0o600);
    expect(mode_of(join(root, 'state', 'chell'))).toBe(0o700);
    expect(await history_readPrivate(place)).toEqual(['ls', 'pwd']);
  });

  it('a file and folder found looser are made private before the line is written', async () => {
    const folder: string = join(root, 'chell');
    const place = { file: join(folder, 'history'), ownFolder: true };
    mkdirSync(folder, { mode: 0o755 });
    writeFileSync(place.file, 'old line\n', { mode: 0o644 });
    chmodSync(folder, 0o755);
    chmodSync(place.file, 0o644);
    await history_appendPrivate(place, 'new line');
    expect(mode_of(place.file)).toBe(0o600);
    expect(mode_of(folder)).toBe(0o700);
    expect(readFileSync(place.file, 'utf8')).toBe('old line\nnew line\n');
  });

  it('a file the operator placed is made private, and the folder they put it in is left as they have it', async () => {
    const folder: string = join(root, 'shared');
    mkdirSync(folder, { mode: 0o755 });
    chmodSync(folder, 0o755);
    const place = { file: join(folder, 'my-history'), ownFolder: false };
    await history_appendPrivate(place, 'ls');
    expect(mode_of(place.file)).toBe(0o600);
    expect(mode_of(folder)).toBe(0o755);
  });

  it('redacts what an older shell wrote, as it is read', async () => {
    const place = { file: join(root, 'old-history'), ownFolder: false };
    writeFileSync(place.file, 'ls\nconnect --password hunter2 url\nconnect --password "open\n\npwd\n', { mode: 0o600 });
    expect(await history_readPrivate(place)).toEqual(['ls', 'connect --password *** url', 'pwd']);
  });

  it('writes nothing through a link, and nothing into what is not a file', async () => {
    const elsewhere: string = join(root, 'elsewhere.txt');
    writeFileSync(elsewhere, 'theirs\n', { mode: 0o600 });
    const linked = { file: join(root, 'linked-history'), ownFolder: false };
    symlinkSync(elsewhere, linked.file);
    await expect(history_appendPrivate(linked, 'a secret line')).rejects.toThrow();
    expect(readFileSync(elsewhere, 'utf8')).toBe('theirs\n');
    const folder = { file: join(root, 'a-folder'), ownFolder: false };
    mkdirSync(folder.file);
    await expect(history_appendPrivate(folder, 'x')).rejects.toThrow();
  });

  it('writes nothing when its own folder cannot be had: where the folder should be, a file stands', async () => {
    const blocked: string = join(root, 'chell');
    writeFileSync(blocked, 'a file where the folder should be\n');
    const place = { file: join(blocked, 'history'), ownFolder: true };
    await expect(history_appendPrivate(place, 'a line')).rejects.toThrow();
    expect(readFileSync(blocked, 'utf8')).toBe('a file where the folder should be\n');
    expect(await history_readPrivate(place)).toEqual([]);
    expect(new HistoryPrivacyError('x')).toBeInstanceOf(HistoryPrivacyError);
  });
});
