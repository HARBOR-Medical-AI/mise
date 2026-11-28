// A real session and a real attached chell, outside Jest (which cannot load brasa's built graph): the built
// calypso daemon on the null backend (no CUBE, an in-memory filesystem) in private folders on loopback, and the
// built chell remote engine attached to it. Host commands it is asked to run are recorded, never run; questions are
// answered from the list given. Prints one JSON report and exits; the daemon is stopped either way.
//
// Usage: node remoteConsentSession.mjs '<answers JSON>' '<lines JSON>'
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../../../..');
const answers = JSON.parse(process.argv[2] ?? '[]');
const lines = JSON.parse(process.argv[3] ?? '[]');
const base = mkdtempSync(join(tmpdir(), 'chell-consent-'));
const dirs = Object.fromEntries(['home', 'run', 'config', 'cache', 'state', 'tmp'].map((name) => {
  const dir = join(base, name);
  mkdirSync(dir, { mode: 0o700 });
  return [name, dir];
}));
const env = {
  PATH: process.env.PATH ?? '', HOME: dirs.home, TMPDIR: dirs.tmp, XDG_RUNTIME_DIR: dirs.run, XDG_CONFIG_HOME: dirs.config,
  XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, PORTER_STATE_DIR: join(dirs.state, 'porter'), CALYPSO_NO_PTY: '1', CALYPSO_TEST_BACKENDS: '1',
};
const daemon = spawn(process.execPath, [join(root, 'packages/calypso/dist/calypso.js'), '--backend', 'null'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
const report = { ran: [], questions: [], error: null };
try {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const { berthAll_read, berthInstance_probe } = await import(join(root, 'packages/calypso/dist/daemon/berth.js'));
  let berth = null;
  for (let tries = 0; tries < 100 && berth === null; tries++) {
    const [found] = berthAll_read();
    if (found !== undefined && (await berthInstance_probe(found)) === 'live') berth = found;
    else await new Promise((done) => setTimeout(done, 100));
  }
  if (berth === null) throw new Error('the session did not start');
  const { RemoteEngine } = await import(join(root, 'packages/chell/dist/remote/remoteEngine.js'));
  const remote = await RemoteEngine.connect({
    url: berth.url,
    token: berth.token,
    onShell: async (command) => { report.ran.push(command); return 0; },
    consentAsk: async (question) => { report.questions.push(question); return answers.shift() ?? 'n'; },
  });
  remote.sink_install({ data_write: () => undefined, err_write: () => undefined, status_write: () => undefined, progress_write: () => undefined });
  for (const line of lines) {
    await remote.line_execute(line);
    report.questions.push(`-- after ${line}`);
  }
  remote.close();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  daemon.kill('SIGTERM');
}
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(0);
