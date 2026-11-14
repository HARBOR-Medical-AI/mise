/**
 * @file `find` from a link named on the line, by both addresses of a run's
 * output: the graph's own (`/proc/jobs/…/data/<link>`) and the feed path.
 * A starting point is walked where the store keeps it, as POSIX's `-H`;
 * a link met below a starting point is listed as a link, never walked.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() } }));

const { linkedStore_install, VIA_PROC, VIA_FEED, OUTPUT } = await import('./support/linkedStore.js');
const { builtin_find, find_complete, findCommand } = await import('../src/builtins/fs/find.js');

beforeEach((): void => {
  linkedStore_install();
  process.exitCode = 0;
});

describe('find through a .chrislink', () => {
  it.each([['/proc/jobs', VIA_PROC], ['the feed path', VIA_FEED]])('walks the link target from %s, printed as typed', async (_how: string, start: string) => {
    const found = await builtin_find([start]);
    expect(found.status).toBe('ok');
    expect(found.rendered).toBe(`${start}\n${start}/hello.txt\n${start}/inner\n${start}/inner/deep.txt\n`);
  });

  it('selects by its tests below the link', async () => {
    expect((await builtin_find([VIA_PROC, '-type', 'f', '-name', 'deep*'])).rendered).toBe(`${VIA_PROC}/inner/deep.txt\n`);
  });

  it('lists a link met below a starting point as a link, and does not walk it', async () => {
    const found = await builtin_find([OUTPUT]);
    expect(found.rendered).toBe(`${OUTPUT}\n${VIA_FEED}\n`);
    expect((await builtin_find([OUTPUT, '-type', 'l'])).rendered).toBe(`${VIA_FEED}\n`);
  });
});

describe('find as an expression grammar', () => {
  it('declares its words its own', () => {
    expect(findCommand.grammar).toBe('expression');
    expect(findCommand.help.category).toBe('Files');
  });

  it('completes tests once the expression begins, and -type and -status words', async () => {
    expect(await find_complete(['.'], '-ty')).toEqual(['-type']);
    expect(await find_complete(['.', '-type'], '')).toEqual(['f', 'd', 'l']);
    expect(await find_complete(['.', '-status'], 'finished')).toEqual(['finishedSuccessfully', 'finishedWithError']);
    expect(await find_complete(['.', '-name'], 'a')).toEqual([]);
    expect(await find_complete(['.', '-type', 'f'], '')).toContain('-name');
  });

  it('refuses a test it does not have, by name', async () => {
    const refused = await builtin_find(['.', '-bogus']);
    expect(refused.status).toBe('error');
    expect(refused.renderedErr).toContain("find: unknown predicate '-bogus'");
  });
});
