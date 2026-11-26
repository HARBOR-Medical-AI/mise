/**
 * @file The layout runner and its built-package check, against workers that misbehave.
 *
 * The runner is real and so is the worker thread; the worker's file is a
 * fixture that stays silent, or ends without answering. The built-package
 * check is run as CI runs it, as a process, and its exit status is what is
 * asserted.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cuminMock_install } from './support/cuminMock.js';

// The runner asks nothing of the ChRIS packages; they are stood in for only so the module loads.
cuminMock_install(() => ({ procLayout_get: async () => null, procLayout_set: async () => null }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ procDataFacts_settled: async (): Promise<number> => 0 }));

const { layout_runInWorker } = await import('../src/chris/universeLayout.js');

const fixture = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);
const check: string = fileURLToPath(new URL('../scripts/layoutWorkerBuilt.mjs', import.meta.url));
const nodes = [{ id: 'root', parents: [], radius: 1, group: null }];

/** Runs the built-package check as a process, bounded so a check that hangs fails here and not in CI's own timeout. */
const check_run = (args: string[]): { status: number | null; said: string } => {
  const ran = spawnSync(process.execPath, [check, ...args], { encoding: 'utf-8', timeout: 20_000 });
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
};

describe('the layout runner', () => {
  it('fails when the worker ends before it answers, a clean exit included, and does not wait for ever', async () => {
    await expect(layout_runInWorker('galaxy', nodes, {} as never, (): void => undefined, fixture('quittingWorker.mjs')))
      .rejects.toThrow('the layout worker ended (exit 0) before it answered');
  }, 10_000);
});

describe('the built-package check', () => {
  it('passes on the package\'s own worker', () => {
    const { status, said } = check_run([]);
    expect(said).toContain('the built worker laid out 3 nodes');
    expect(status).toBe(0);
  }, 30_000);

  it('ends with a failure at its deadline when the worker is alive and silent', () => {
    const { status, said } = check_run(['--worker', fileURLToPath(fixture('silentWorker.mjs')), '--allowed-ms', '500']);
    expect(said).toContain('no answer from the worker in 500 ms');
    expect(status).toBe(1);
  }, 30_000);

  it('fails when the worker ends without answering', () => {
    const { status, said } = check_run(['--worker', fileURLToPath(fixture('quittingWorker.mjs'))]);
    expect(said).toContain('before it answered');
    expect(status).toBe(1);
  }, 30_000);
});
