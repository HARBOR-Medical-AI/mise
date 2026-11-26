/**
 * @file Headless CDP driver for the argus smoke suite.
 *
 * Launches chromium against a live argus (daemon URL from ARGUS_URL or the
 * calypso attach file), evaluates expressions in the page, and captures
 * screenshots. No frameworks: chromium + the repo's own ws client.
 */
import { WebSocket } from 'ws';
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

const DEBUG_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9345);

/**
 * Extra chromium flags, from SMOKE_CHROME_FLAGS and SMOKE_PROFILE_DIR.
 *
 * A container or a sandboxed home needs its own profile directory, and
 * sometimes needs the sandbox disabled, before chromium will open its
 * debug port at all. Those are environment facts, not suite policy, so
 * they come from the environment rather than being written down here.
 */
const EXTRA_FLAGS = chromeFlags_read(process.env);

/**
 * The extra chromium arguments the environment asks for.
 *
 * SMOKE_CHROME_FLAGS holds flags, space separated, so a value in it cannot
 * hold a space. A profile folder can (a run's own folder under a home with
 * a space in its name), so it has a name of its own, SMOKE_PROFILE_DIR,
 * and is handed to chromium as one argument whatever it holds.
 *
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {string[]} The arguments, each as chromium is to see it.
 */
export function chromeFlags_read(env) {
  const flags = (env.SMOKE_CHROME_FLAGS ?? '').split(' ').filter(Boolean);
  const profile = env.SMOKE_PROFILE_DIR ?? '';
  if (profile !== '') flags.push(`--user-data-dir=${profile}`);
  return flags;
}

/** Reads the argus URL: $ARGUS_URL, else the user's calypso attach file. */
export function argusUrl_discover() {
  if (process.env.ARGUS_URL) return process.env.ARGUS_URL;
  const attach = readFileSync(`/tmp/calypso-${os.userInfo().username}.attach`, 'utf8');
  const line = attach.split('\n').find((l) => l.startsWith('ARGUS:'));
  if (!line) throw new Error('no ARGUS line in attach file; set ARGUS_URL');
  // Loopback dodges hostname-hijacking proxies.
  return line.replace('ARGUS:', '').trim().replace(/\/\/[^:/]+:/, '//127.0.0.1:');
}

/** Whether something already answers CDP on a port. */
function port_answers(port) {
  try {
    return execSync(`curl -s --max-time 2 --noproxy "*" http://127.0.0.1:${port}/json/version`).toString().trim().startsWith('{');
  } catch {
    return false;
  }
}

/**
 * Ends a browser this driver started: its whole process group (the browser
 * and every renderer, GPU and utility process under it), once.
 *
 * @param chrome - The spawned browser, started as its own group's leader.
 * @param signal - SIGTERM for a close, SIGKILL when the script is going now.
 */
function browser_end(chrome, signal) {
  if (chrome.pid === undefined || chrome.exitCode !== null || chrome.signalCode !== null) return;
  try {
    process.kill(-chrome.pid, signal);
  } catch {
    // The group is gone already.
  }
}

/**
 * Ties a browser's life to the script's: however the script ends — done, a
 * thrown error, an unhandled rejection, Ctrl-C, a `timeout`'s SIGTERM, a
 * closed terminal — the browser goes with it. A browser left behind kept
 * rendering at a core or more each, for days: nineteen of them once held
 * pangea's load at 150.
 *
 * @param chrome - The spawned browser.
 */
function browser_tether(chrome) {
  // 'exit' runs on a normal end and after an uncaught error or rejection.
  process.once('exit', () => browser_end(chrome, 'SIGKILL'));
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => {
      browser_end(chrome, 'SIGKILL');
      process.exit(code);
    });
  }
}

/** Boots chromium, navigates, and returns an evaluate/screenshot handle. */
export async function page_open(url) {
  // A browser already on the port (one left behind, or another run's) would
  // be driven in place of this one: refuse, and say which port.
  if (port_answers(DEBUG_PORT)) {
    throw new Error(`a browser already answers on port ${DEBUG_PORT} (one left behind by an earlier run, or another run's); end it or set SMOKE_CDP_PORT`);
  }
  // Its own process group, so one signal ends the browser and everything
  // under it, and tethered so it never outlives the script.
  // SMOKE_CHROME_BIN picks the browser: chromium 153 cannot load a loopback
  // page headless (its local-network-access gate holds the request), so a
  // host on it runs the suite on an older build (2026-10-14, pangea).
  const chrome = spawn(process.env.SMOKE_CHROME_BIN ?? 'chromium', [
    '--headless=new', '--no-proxy-server', '--disable-gpu',
    `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=2560,1440',
    '--hide-scrollbars', ...EXTRA_FLAGS, 'about:blank',
  ], { stdio: 'ignore', detached: true });
  browser_tether(chrome);
  // Wait for the port to answer rather than guessing at a delay: a cold
  // profile or a slower machine takes longer than any fixed sleep, and the
  // failure then looks like a suite error rather than a slow start.
  let listing = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      listing = execSync(`curl -s --noproxy "*" http://127.0.0.1:${DEBUG_PORT}/json`).toString();
      if (listing.trim().startsWith('[')) break;
    } catch {
      listing = '';
    }
  }
  if (!listing.trim().startsWith('[')) {
    browser_end(chrome, 'SIGKILL');
    throw new Error(`chromium never opened its debug port on ${DEBUG_PORT}; set SMOKE_CHROME_FLAGS (e.g. --no-sandbox --user-data-dir=/tmp/x) if it needs them`);
  }
  const list = JSON.parse(listing);
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  // A CDP call the browser refuses rejects, by method and CDP's own words:
  // resolving its absent result made a refused call look like success, and
  // a stage measured nothing without knowing it (#830).
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject, method });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject, method } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(`cdp ${method}: ${m.error.message ?? JSON.stringify(m.error)}`));
    else resolve(m.result);
  });
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  // SMOKE_DPR emulates a HiDPI display (a real desktop at 1.25–2×): canvas
  // sizing bugs hide at the headless default of 1. The viewport is pinned
  // at every ratio: left to the window, its height is whatever a chromium
  // build's own chrome leaves of 1440, and the canon recorded on one
  // machine then scores a hundred moved heights on the next.
  const dpr = Number(process.env.SMOKE_DPR ?? '1');
  // SMOKE_WIDTH / SMOKE_HEIGHT run the suite at another size (a tablet's
  // 1024×768); SMOKE_TOUCH=1 makes the pointer coarse, as a finger is. The
  // desk width stays the canon's; the nightly runs the listing stages again
  // at the tablet size and under a finger (epic #915).
  const width = Number(process.env.SMOKE_WIDTH ?? '2560');
  const height = Number(process.env.SMOKE_HEIGHT ?? '1440');
  const touch = process.env.SMOKE_TOUCH === '1';
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: touch });
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 4000));
  return {
    /** Sends one raw CDP command (a viewport change, say). */
    send,
    /** Evaluates an async expression body; returns its JSON value. */
    eval: async (expression) => {
      const out = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (out?.exceptionDetails) throw new Error(out.exceptionDetails.text);
      return out?.result?.value;
    },
    shot: async (path) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
    },
    /** Raw CDP access for probes. */
    cdp: send,
    close: () => browser_end(chrome, 'SIGTERM'),
  };
}
