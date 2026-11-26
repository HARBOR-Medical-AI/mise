import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { token_generate, token_writeFile, token_matches, tokenWords_say } from '../src/daemon/token';

describe('token_generate', () => {
  it('produces a 64-char hex string (256 bits)', () => {
    const token = token_generate();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different token each call', () => {
    expect(token_generate()).not.toBe(token_generate());
  });
});

describe('token_writeFile', () => {
  it('writes the token to a user-only-readable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calypso-token-'));
    const path = join(dir, 'token');
    try {
      const token = token_generate();
      token_writeFile(token, path);
      expect(readFileSync(path, 'utf-8')).toBe(`${token}\n`);
      // Mode is 0600 (owner read/write only) on POSIX.
      const mode = statSync(path).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('token_matches', () => {
  it('accepts an exact match', () => {
    const token = token_generate();
    expect(token_matches(token, token)).toBe(true);
  });

  it('rejects a different token of equal length', () => {
    expect(token_matches(token_generate(), token_generate())).toBe(false);
  });

  it('rejects a token of different length without throwing', () => {
    expect(token_matches('abcd', 'abcde')).toBe(false);
    expect(token_matches('', 'x')).toBe(false);
  });
});

describe('tokenWords_say', () => {
  const TOKEN: string = '0123456789abcdef'.repeat(4);
  const KEPT: string = '/run/user/1000/calypso/berth-abc.json';

  it('gives the token itself to a terminal, where its operator reads it', () => {
    expect(tokenWords_say(TOKEN, true, KEPT)).toEqual({ token: TOKEN, query: `?token=${TOKEN}`, flag: `--token ${TOKEN}`, aside: '' });
  });

  it('gives no part of the token to anything else, and says where it is kept', () => {
    const words = tokenWords_say(TOKEN, false, KEPT);
    for (const said of Object.values(words)) expect(said).not.toContain(TOKEN);
    expect(words.token).toBe(`not printed, since this output is not a terminal; it is kept in ${KEPT}`);
    expect(words.query).toBe('');
    expect(words.flag).toBe(`--token <the token kept in ${KEPT}>`);
    expect(words.aside).toBe(` (its token is kept in ${KEPT})`);
  });
});
