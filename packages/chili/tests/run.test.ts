/**
 * Integration test for the in-process `run()` entry (src/run.ts).
 *
 * `run()` exists so a host process (chell) can invoke chili commands repeatedly
 * in the same process instead of spawning `node`. That requires two properties:
 *   1. Re-entrancy — calling run() more than once in one process works (each
 *      call builds a fresh Commander program, so parser state is not shared).
 *   2. No process teardown — help/version/usage errors must NOT call
 *      process.exit (that would kill the host REPL). run() uses .exitOverride()
 *      and swallows the resulting CommanderError.
 *
 * The full chili command graph that run() wires up is laced with ESM-only
 * constructs (`import.meta.url`, pure-ESM deps), which chili's CommonJS jest
 * transform cannot compile. So rather than import run() into jest, we exercise
 * the *built* module in a real Node ESM process and assert on its behaviour —
 * a stronger, runtime-faithful proof. CI builds before testing; when the dist
 * is absent (e.g. `npm test` without a prior build) the test is skipped.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const distRun: string = path.resolve(__dirname, '../dist/run.js');
const built: boolean = existsSync(distRun);

if (!built) {
  console.warn(
    '[run.test] dist/run.js not built — skipping in-process integration test. Run `npm run build` first.'
  );
}

(built ? describe : describe.skip)('chili in-process run() [built dist]', () => {
  it('runs three commands back-to-back in one process without process.exit', () => {
    const runUrl: string = pathToFileURL(distRun).href;
    const script: string = `
      const realExit = process.exit.bind(process);
      process.exit = (c) => { console.log('UNEXPECTED_EXIT:' + c); realExit(99); };
      const { run } = await import(${JSON.stringify(runUrl)});
      await run(['--help', '-s']); console.log('MARK1');
      await run(['--help', '-s']); console.log('MARK2');
      await run(['__definitely_not_a_command__', '-s']); console.log('MARK3');
      await run(['--version']); console.log('MARK4');
      console.log('ALL_OK');
      realExit(0);
    `;
    const dir: string = mkdtempSync(path.join(os.tmpdir(), 'chili-run-'));
    const file: string = path.join(dir, 'proof.mjs');
    writeFileSync(file, script);

    // Hermetic: point the config dir at an empty temp location so no persisted
    // cumin session is loaded. Without a session there is no CUBE URL to reach,
    // so bootstrap cannot make a live network call and `--help` short-circuits
    // cleanly. (cumin's config.ts honours XDG_CONFIG_HOME.)
    const cfgDir: string = path.join(dir, 'config');

    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [file], {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, XDG_CONFIG_HOME: cfgDir },
      });
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      out = (err.stdout ?? '') + (err.stderr ?? '');
      code = err.status ?? 1;
    }

    // Both --help runs completed (re-entrancy), the unknown command did not
    // tear down the process, and execution reached the end with exit 0.
    expect(out).toContain('MARK1');
    expect(out).toContain('MARK2');
    expect(out).toContain('MARK3');
    // --version answers inside run() too, without an error or an exit.
    expect(out).toContain('MARK4');
    expect(out).not.toContain('CommanderError');
    expect(out).toContain('ALL_OK');
    expect(out).not.toContain('UNEXPECTED_EXIT');
    expect(code).toBe(0);
  });
});

/** The command the package's manifest names, built. */
const CHILI_BIN: string = path.resolve(__dirname, '..', (JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { bin: { chili: string } }).bin.chili);

(existsSync(CHILI_BIN) ? describe : describe.skip)('chili --version [built dist]', () => {
  it('prints the installed version alone and exits 0, run as the executable the manifest names', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { version: string };
    const dir: string = mkdtempSync(path.join(os.tmpdir(), 'chili-version-'));
    // The bin itself, by its shebang and its executable mode, as a global install runs it.
    expect(statSync(CHILI_BIN).mode & 0o111).not.toBe(0);
    for (const flag of ['--version', '-V']) {
      const out: string = execFileSync(CHILI_BIN, [flag], {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config') },
      });
      expect(out.trim()).toBe(manifest.version);
    }
  });
});
