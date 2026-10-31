/**
 * @file The argus smoke suite: UI invariants against a live daemon.
 *
 * Every scenario here exists because its violation shipped once:
 *   - drawer-everywhere: PACS-03 had no pane controls behind Ctrl-B.
 *   - zoom-completeness: offsetHeight left a crushed header band on stage.
 *   - lid-parity: closed-state overrides wrapped the lid's tail segments.
 *   - single-beckon-author: a JS class made the whole lid pulse at the elbow.
 *   - runs-honesty: a refused roster stood as RETRIEVING… forever.
 *
 * Run: npm run smoke   (needs a live daemon; ARGUS_URL overrides discovery)
 *
 * The image scenarios need a DICOM series and a NIfTI on the daemon's CFS.
 * Name them with SMOKE_DICOM_SERIES and SMOKE_NIFTI, or let the suite
 * synthesize its own (tests/smoke/fixtures/synth.mjs), put them under the
 * identity's uploads through /vfs, and remove them at the end;
 * SMOKE_NO_FIXTURES=1 skips that and the scenarios say why they skipped.
 * The node scenarios get a feed rooted on those fixtures the same way,
 * unless SMOKE_DAG_FEED names one.
 *
 * What the suite cannot make for itself is named, never committed: a big
 * feed (SMOKE_BIG_FEED, about a thousand nodes, slow to create) and the
 * PACS fixtures, which name real studies and patients. SMOKE_PACS_QUERY is
 * a `pacs query ...` line finding a study of two or more series, one of
 * them already in CUBE; SMOKE_PACS_MRN an MRN with imaging; SMOKE_PACS_COHORT
 * a `pacs query --patients a,b` line where one MRN is a miss. They are read
 * from a local file, `$XDG_CONFIG_HOME/mise/smoke.env` (or the path in
 * SMOKE_ENV), one KEY=value a line; a variable set in the environment wins.
 * The file is the operator's, outside the tree: an MRN is a patient.
 *
 * The whole suite drives a real browser against a live daemon — about three
 * minutes for twenty-seven scenarios — so while building one thing,
 * `SMOKE_ONLY=pacs-listing npm run smoke` runs just that one (about thirty
 * seconds) and `SMOKE_SKIP=` leaves scenarios out. Neither is set in CI or
 * before a merge, where the whole suite is the point.
 */
import { argusUrl_discover, page_open } from './driver.mjs';
import { existsSync as envFile_exists, readFileSync as envFile_read } from 'node:fs';
import { homedir as envFile_home } from 'node:os';
import { join as envFile_join } from 'node:path';

// The fixtures the suite cannot make for itself, from the operator's own
// file outside the tree; what the environment already sets wins.
const smokeEnv = process.env.SMOKE_ENV ?? envFile_join(process.env.XDG_CONFIG_HOME ?? envFile_join(envFile_home(), '.config'), 'mise', 'smoke.env');
if (envFile_exists(smokeEnv)) {
  for (const line of envFile_read(smokeEnv, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (line.trim().startsWith('#') || at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(at + 1).trim();
  }
  console.log(`fixtures from ${smokeEnv}`);
}

const failures = [];
let passes = 0;

function check(name, condition, detail = '') {
  if (condition) { passes += 1; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * Scenario gating and timing.
 *
 * The whole suite drives a real browser against a live daemon, which is
 * minutes, not seconds — so a scenario nobody is working on is time spent
 * proving something already proven. `SMOKE_ONLY` runs just the named
 * scenarios (comma-separated, matched as substrings) and `SMOKE_SKIP`
 * leaves them out; neither is set in CI or in a release check, where the
 * whole suite is the point.
 *
 * Each scenario reports its own wall time, so the expensive ones are
 * visible rather than merely felt.
 */
/** The files-document stage's Markdown fixture: a heading, a list, code, a table, a link, a script that must not run. */
const DOC_MARKDOWN = [
  '# Smoke document', '', 'A *Markdown* file with **strong** words and `code`.', '',
  '## A list', '', '- one', '- two', '', '```sh', 'make deploy', '```', '',
  '| key | value |', '| --- | --- |', '| a | 1 |', '| b | 2 |', '',
  '[the project](https://chrisproject.org) and [a neighbour](guide.adoc)', '',
  '<script>window.smokeDocRan = true</script>', '',
].join('\n');

/** The files-document stage's AsciiDoc fixture: a title, an attribute, an admonition, a listing, a table. */
const DOC_ASCIIDOC = [
  '= Smoke guide', ':toc:', '', '== Setup', '', 'NOTE: An *admonition* with `mono`.', '',
  '[source,sh]', '----', 'make deploy', '----', '', '|===', '|key |value', '', '|a |1', '|b |2', '|===', '',
  '* an item', '* https://chrisproject.org[a link]', '',
].join('\n');

const only = (process.env.SMOKE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const skip = (process.env.SMOKE_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const timings = [];
let stageName = null;
let stageAt = 0;

function stage_close() {
  if (stageName === null) return;
  timings.push([stageName, Date.now() - stageAt]);
  stageName = null;
}

/**
 * Announces a scenario and says whether to run it.
 *
 * @param {string} name - The scenario's name.
 * @returns {Promise<boolean>} True when this run includes it.
 */
/** The console the suite drives, once it is known (terminal or transcript). */
let suiteConsole = 'transcript';

/**
 * Scenarios of the transcript's own interface (its ask capsules, a pane
 * question answered at the console): a terminal console has neither, so a
 * suite driving a terminal skips them by name, and the nightly transcript
 * lane runs them.
 */
const TRANSCRIPT_ONLY = ['console-asks', 'question-both-places'];
/** The terminal's own: its questions are chell's, asked and answered in line. */
const TERMINAL_ONLY = ['terminal-asks'];

async function stage(name) {
  if (stageName !== null) await stage_leaks(stageName);
  stage_close();
  const wanted = (only.length === 0 || only.some((s) => name.includes(s)))
    && !skip.some((s) => name.includes(s));
  if (!wanted) return false;
  if (suiteConsole === 'terminal' && TRANSCRIPT_ONLY.includes(name)) {
    console.log(`${name}: skipped, the transcript's own (the transcript lane runs it)`);
    return false;
  }
  if (suiteConsole !== 'terminal' && TERMINAL_ONLY.includes(name)) {
    console.log(`${name}: skipped, the terminal's own`);
    return false;
  }
  console.log(name);
  stageName = name;
  stageAt = Date.now();
  return true;
}

const page = await page_open(argusUrl_discover());
if (await page.eval(`!CSS.supports('scrollbar-width', 'none')`) === true) {
  console.log('note: this browser has no scrollbar-width (Chromium < 121); whether a field hides its scrollbar is not judged');
}
/** The session's place when the suite began; every scenario leaves it there. */
let leakBaseline = null;
/** The operator's cohort file as the suite found it, put back at the end. */
let cohortKept = null;
/** The suite's own fixtures on the operator's CUBE, removed at the end whatever fails. */
let fixtureFolder = null;
let fixtureFeed = null;

/**
 * Fails a scenario that leaves the session other than it found it: the
 * working directory moved, a row left lit (indicated or mid-press), or a
 * question left open. A leftover is how one scenario breaks the next, and
 * the next is then blamed: this names the scenario that leaked instead.
 *
 * @param {string} name - The scenario that just ran.
 */
async function stage_leaks(name) {
  let state = null;
  try {
    state = await evalIn(`
      await console_idle();
      for (let i = 0; i < 20 && document.querySelectorAll('.listing-activating').length > 0; i++) await sleep(250);
      // A console left busy (#919): a prompt that never came back queues every
      // line typed after it, and the next scenario's commands run never. The
      // console declares the state (data-busy); a command may still be
      // ending, so the probe waits a few seconds before calling it a leak.
      for (let i = 0; i < 20 && !console_quiet(); i++) await sleep(250);
      const busy = !console_quiet();
      // A RUNS pane left on a graph rather than its roster: the next scenario's cwd then repaints it.
      const graphs = [...document.querySelectorAll('.pane-dag')].filter((p) => p.offsetParent !== null && p.querySelector('.dag-feedlist') && p.querySelector('.roster-shown') === null && p.querySelector('.dag-canvas')?.style.display === 'block').length;
      // Lit rows on stage: a folded band's open cohort is indicated by design and is not a leak.
      return { cwd: window.__argusPromptContext?.cwd ?? null, lit: [...document.querySelectorAll('.listing-indicated, .listing-activating')].filter((e) => e.offsetParent !== null).length, asks: document.querySelectorAll('.ask-bar').length, graphs, busy };`);
  } catch {
    return;
  }
  const moved = leakBaseline !== null && state.cwd !== null && state.cwd !== leakBaseline;
  if (moved || state.lit > 0 || state.asks > 0 || state.graphs > 0 || state.busy) {
    check(`${name} leaves the session as it found it (cwd ${leakBaseline}, nothing lit, no open question, no RUNS pane left on a graph, the console idle)`, false, JSON.stringify(state));
    // Put it back, so the leak is named once, against the scenario that
    // made it, and not again against every one after.
    await evalIn(`
      await console_idle();
      document.getElementById('status-strip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await runs_back();
      if (${JSON.stringify(state.cwd)} !== ${JSON.stringify(leakBaseline)}) {
        const input = console_input();
        input.value = 'cd ' + ${JSON.stringify(leakBaseline ?? '~')}; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        for (let i = 0; i < 40 && window.__argusPromptContext?.cwd !== ${JSON.stringify(leakBaseline)}; i++) await sleep(250);
      }
      return 1;`).catch(() => undefined);
  }
}

// `settled` waits for a measured value to stop changing, so a scenario can
// follow a CSS glide without guessing at its duration: a fixed sleep either
// samples mid-flight or, when a click has yet to register, before it starts.
const evalIn = (body) => page.eval(`(async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  // A field hides its scrollbar with scrollbar-width (Chromium 121+). A
  // browser without it cannot show whether the field did, so that part of a
  // check is not judged there rather than failed: the headless Chromium the
  // suite can run on some hosts is 117.
  const scrollbarJudged = CSS.supports('scrollbar-width', 'none');
  const scrollbarNone = (el) => !scrollbarJudged || getComputedStyle(el).scrollbarWidth === 'none';
  const settled = async (read, { quiet = 3, step = 60, limit = 3000 } = {}) => {
    let last = NaN; let still = 0;
    for (let waited = 0; waited < limit; waited += step) {
      await sleep(step);
      const now = read();
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= quiet) return now;
    }
    return last;
  };
  // A scenario that speaks to the session starts from a settled console: no
  // question left open by an earlier scenario (Esc abandons it — the ask
  // owns Esc, so nothing else moves), and the session not BUSY with a command
  // an earlier scenario issued. A command typed into an open question is an
  // answer, and one queued behind a slow command times out looking idle.
  // The console is the transcript or a terminal (#1125); a scenario types,
  // waits and reads the same way in either. In a terminal the chell marks
  // what it is doing (idle, busy, asking) and the page wears it as
  // data-terminal-state; the transcript wears data-busy for what ARGUS
  // itself runs, in both.
  const terminal_mode = () => window.__argusConsole?.mode?.() === 'terminal';
  const TERMINAL_KEYS = { Enter: '\\r', Tab: '\\t', Escape: '\\u0003', ArrowUp: '\\u001b[A', ArrowDown: '\\u001b[B' };
  const console_input = () => {
    if (!terminal_mode()) return document.querySelector('#terminal input');
    // A stand-in for the transcript's input: a line set on it is typed into
    // the terminal on Enter (Tab completes it there; Esc is Ctrl-C, which
    // abandons an open question as Esc does in the transcript).
    return {
      value: '',
      focus() { /* the terminal takes the keys it is sent */ },
      dispatchEvent(event) {
        const sent = TERMINAL_KEYS[event.key];
        // A pane's question with the terminal at rest: the line answers the
        // pane, as typing at the transcript did (the pressed verb's question
        // stands on its pane; the terminal's chell did not ask it).
        const bar = [...document.querySelectorAll('.ask-bar')].filter((b) => b.offsetParent !== null).pop();
        if (event.type === 'keydown' && event.key === 'Escape' && bar !== undefined && !console_asking()) {
          // Esc at the console abandons the pane's question, as it did at the transcript.
          bar.querySelector('.ask-bar-abandon')?.click();
          return true;
        }
        if (event.type === 'keydown' && event.key === 'Enter' && bar !== undefined && !console_asking()) {
          const field = bar.querySelector('.ask-bar-field');
          const said = this.value.trim().toLowerCase();
          if (field !== null) { field.value = this.value; bar.querySelector('.ask-bar-commit')?.click(); }
          else if (said === 'y' || said === 'yes') bar.querySelector('.ask-bar-yes')?.click();
          else if (said === 'n' || said === 'no') bar.querySelector('.ask-bar-no')?.click();
          this.value = '';
          return true;
        }
        if (event.type === 'keydown' && sent !== undefined) {
          window.__argusConsole.type((event.key === 'Enter' || event.key === 'Tab' ? this.value : '') + sent);
          this.value = '';
        }
        return true;
      },
    };
  };
  const console_asking = () => terminal_mode()
    ? document.getElementById('terminal')?.dataset.terminalState === 'asking'
    : (document.querySelector('.argus-input-glyph')?.textContent ?? '❯') !== '❯';
  const console_quiet = () => {
    const term = document.getElementById('terminal');
    return term?.dataset.busy !== 'true' && (!terminal_mode() || term?.dataset.terminalState === 'idle');
  };
  // A mark in the console's output, and what was written after it: the
  // transcript counts its blocks, a terminal its buffer's lines (from the
  // line the mark's prompt stood on, where the typed line lands).
  const console_mark = () => terminal_mode()
    ? window.__argusConsole.mark()
    : (document.querySelector('#terminal .argus-output')?.children.length ?? 0);
  const console_since = (mark, join = '\\n') => terminal_mode()
    ? window.__argusConsole.since(mark).join('\\n')
    : [...(document.querySelector('#terminal .argus-output')?.children ?? [])].slice(mark).map((e) => e.textContent).join(join);
  const console_echoes = () => terminal_mode()
    ? window.__argusConsole.lines().map((line) => line.startsWith('❯ ') ? line : (/\\$ (\\S.*)$/.exec(line)?.[1] !== undefined ? '❯ ' + /\\$ (\\S.*)$/.exec(line)[1] : null)).filter((line) => line !== null)
    : [...document.querySelectorAll('#terminal .argus-echo')].map((e) => e.textContent);
  // The question the console has open, as text: the transcript's newest ask
  // block; a terminal's last line while its chell marks asking.
  const console_lastAsk = () => {
    if (!terminal_mode()) return [...document.querySelectorAll('#terminal .argus-ask')].pop()?.textContent.trim() ?? '';
    if (!console_asking()) return '';
    const lines = window.__argusConsole.lines();
    return (lines[lines.length - 1] ?? '').trim();
  };
  // Answers the console's open question by typing, as an operator would.
  const console_answer = (text) => {
    const input = console_input();
    input.value = text; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  // The console's text, as the transcript's whole #terminal reads: in a
  // terminal its buffer, each prompt line written as the transcript echoes a
  // line (❯ line), so a scenario finds what followed a command either way.
  const console_text = () => terminal_mode()
    ? window.__argusConsole.lines().map((line) => { const typed = /\\$ (\\S.*)$/.exec(line); return typed === null ? line : '❯ ' + typed[1]; }).join('\\n')
    : (document.getElementById('terminal')?.innerText ?? '');
  // After a line typed and its wait: the console must be at rest again
  // before the scenario reads it. A busy session (a feed walked, a /proc
  // refresh) outlasts any fixed wait, and a terminal's answer comes one round
  // trip later than the transcript's.
  const console_settled = async (limit = 15000) => {
    for (let waited = 0; waited < limit && !console_quiet() && !console_asking(); waited += 100) await sleep(100);
  };
  const console_idle = async ({ limit = 30000 } = {}) => {
    for (let i = 0; i < 3 && console_asking(); i++) {
      console_input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
    }
    const status = () => document.getElementById('drawer-status')?.textContent ?? '';
    for (let waited = 0; waited < limit; waited += 250) {
      if (/READY/.test(status()) && !console_asking() && (!terminal_mode() || console_quiet())) return true;
      await sleep(250);
    }
    return false;
  };
  // Finds a node on a drawn graph by touch: sweeps a grid of the canvas
  // until the facts plate answers (a press on empty space selects nothing,
  // so the sweep is harmless). Blind probe points missed small graphs.
  const node_find = async (canvas, facts) => {
    const box = canvas.getBoundingClientRect();
    for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const at = { clientX: Math.round(box.left + box.width * fx), clientY: Math.round(box.top + box.height * fy), bubbles: true, cancelable: true };
        canvas.dispatchEvent(new MouseEvent('mousemove', at)); await sleep(60);
        canvas.dispatchEvent(new MouseEvent('click', at)); await sleep(220);
        if (facts().trim() !== '') return at;
      }
    }
    return null;
  };
  // Empties the cohort where ARGUS keeps it: the band's CLEAR, and its
  // question answered. (The console's \`gather clear\` empties the file but
  // not the surface's own copy, which the next GATHER writes back: the
  // surface still owns the cohort.) Returns whether it stands empty.
  const cohort_empty = async () => {
    const band = document.getElementById('header-gather');
    if (band.querySelector('.gather-series')) {
      band.querySelector('.gather-remove')?.click();
      // An unsaved cohort asks "Save the cohort first?": no, just clear. The
      // question stands where it can be seen (the console's capsules when
      // the band is away); the clear is the kernel's, a CUBE round trip.
      const no_find = () => [...document.querySelectorAll('.ask-capsule-no, .ask-bar-no')].find((e) => e.offsetParent !== null) ?? null;
      for (let i = 0; i < 20; i++) { await sleep(200); const no = no_find(); if (no) { no.click(); break; } if (!band.querySelector('.gather-series')) break; }
      for (let i = 0; i < 80 && band.querySelector('.gather-series'); i++) await sleep(250);
    }
    return band.querySelector('.gather-series') === null;
  };
  // A line typed at the console and run to its prompt: the console wears
  // data-busy from a submit until the prompt returns, and a line typed
  // while busy queues behind it (#919: fixed sleeps raced CUBE's pace, so a
  // scenario asked a pane in a directory its cd had not reached yet).
  const console_run = async (line, limit = 30000) => {
    for (let w = 0; w < limit && !console_quiet(); w += 100) await sleep(100);
    const input = console_input();
    if (!input) return false;
    input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // A terminal's chell marks busy a moment after the keys arrive.
    await sleep(terminal_mode() ? 300 : 50);
    for (let w = 0; w < limit && !console_quiet(); w += 100) await sleep(100);
    return console_quiet();
  };
  // A RUNS pane left on a graph goes back to its roster by its own BACK.
  const runs_back = async () => {
    // Hidden ones too: a RUNS pane behind another comes back on stage (or
    // after a reload) on whatever it was left showing.
    const onGraph = (p) => p.querySelector('.dag-feedlist') && p.querySelector('.roster-shown') === null && p.querySelector('.dag-canvas')?.style.display === 'block';
    for (const p of document.querySelectorAll('.pane-dag')) {
      for (let i = 0; i < 4 && onGraph(p); i++) { p.querySelector('.dag-back')?.click(); await sleep(500); }
    }
  };
  // A scenario leaves the session as it found it: RUNS panes on their
  // rosters, and the session's place at home, where the suite began.
  // Home first, then the graphs: a cwd still inside a feed repaints a RUNS
  // pane's graph after its BACK was pressed.
  const home_return = async () => {
    await console_idle();
    const home = () => (window.__argusPromptContext?.cwd ?? '').endsWith('/' + (window.__argusPromptContext?.user ?? '\u0000'));
    if (!home()) {
      const input = console_input();
      input.value = 'cd ~'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 40 && !home(); i++) await sleep(250);
      await console_settled();
    }
    await runs_back();
    // A row left indicated stands down (a press off every listing).
    if (document.querySelector('.listing-indicated')) { document.getElementById('status-strip')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(200); }
  };
  ${body}
})()`);

try {
  console.log('boot');
  const ready = await evalIn(`
    for (let i=0;i<120;i++){ await sleep(500);
      const m=document.getElementById('drawer-status');
      if (m && m.textContent.includes('READY')) return true; }
    return false;`);
  check('session reaches READY', ready === true);
  // A fresh browser begins at the dashboard alone on the screen: no header,
  // no gutter, no console. The scenarios want the full surface, so the
  // suite steps out with Esc (the landing's own way out) once it has looked.
  const landing = await evalIn(`
    // The tiles are painted from the session's answers (the roster, the
    // home listing), a moment after READY: settle on them, never a guess.
    for (let i = 0; i < 60 && document.querySelectorAll('.launcher-tile').length === 0; i++) await sleep(250);
    const shown = (id) => { const e = document.getElementById(id); if (e === null || e.offsetParent === null) return false; const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
    const seen = { zoom: document.body.dataset.zoom ?? null, tiles: document.querySelectorAll('.launcher-tile').length, drawer: shown('drawer'), gutter: shown('gutter-files'), composition: document.body.dataset.composition ?? null };
    if (seen.zoom === 'launcher') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
    return { ...seen, after: document.body.dataset.zoom ?? null };`);
  if (landing.composition === 'chris') {
    check('a fresh browser lands on the dashboard alone: zoomed, no console, no gutter; Esc gives the full surface',
      // ChRIS's dashboard holds eight tiles.
      landing.zoom === 'launcher' && landing.tiles >= 7 && !landing.drawer && !landing.gutter && landing.after === null, JSON.stringify(landing));
  } else {
    // A frame-alone daemon serves on a fresh port each start, so every boot
    // is a first visit: the dashboard stands on stage inside the whole frame.
    check('a frame-alone session lands on the dashboard inside the frame: not zoomed, console and gutter on stage',
      landing.zoom === null && landing.tiles >= 5 && landing.drawer && landing.gutter, JSON.stringify(landing));
  }
  // The baseline is home, not whatever cwd the session kept from before
  // the suite: a session left in a since-removed directory made every
  // scenario read as a leak and every repair cd into nothing.
  // Which console the suite drives (#1125): the terminal wherever the daemon
  // offers one; the transcript, deprecated, only on a daemon that offers none
  // (CALYPSO_NO_PTY=1 makes one). SMOKE_CONSOLE=terminal|transcript says
  // which the suite expects; a terminal console is ready once its chell marks idle.
  const consoleWanted = process.env.SMOKE_CONSOLE ?? '';
  if (consoleWanted === 'terminal' || consoleWanted === 'transcript') {
    const chosen = await evalIn(`
      for (let i = 0; i < 120 && terminal_mode() && !console_quiet(); i++) await sleep(250);
      const first = document.querySelector('#terminal .argus-output')?.textContent ?? '';
      return { mode: window.__argusConsole?.mode?.() ?? 'transcript', state: document.getElementById('terminal')?.dataset.terminalState ?? null, deprecated: /the transcript, deprecated: this host offers no pseudo-terminal/.test(first) };`);
    check(`the console is the ${consoleWanted} the suite asked for`, chosen.mode === consoleWanted, JSON.stringify(chosen));
    if (consoleWanted === 'transcript') check('the transcript says it is the deprecated fallback, and why', chosen.deprecated, JSON.stringify(chosen));
  }
  suiteConsole = await evalIn('return window.__argusConsole?.mode?.() ?? "transcript";');
  console.log(`console: ${suiteConsole}`);
  leakBaseline = await evalIn(`await home_return(); return window.__argusPromptContext?.cwd ?? null;`);
  // A fresh identity's first boot builds its whole job index, and the
  // universe and node scenarios read that index: wait for the sweep to
  // finish (up to fifteen minutes) rather than test a half-built one.
  {
    const warmed = await evalIn(`
      const t0 = Date.now();
      const sweeping = () => { const w = window.__argusPromptContext?.procWarmup; return w !== undefined && w.sweeping !== false; };
      for (let i = 0; i < 1800 && sweeping(); i++) await sleep(500);
      const w = window.__argusPromptContext?.procWarmup;
      return { waitedS: Math.round((Date.now() - t0) / 1000), still: sweeping(), loaded: w?.loaded ?? null, total: w?.total ?? null };`);
    console.log(warmed.still
      ? `  index: still warming after ${warmed.waitedS}s (${warmed.loaded}/${warmed.total}); index scenarios may fail`
      : `  index: whole${warmed.waitedS > 1 ? ` after ${warmed.waitedS}s` : ''}`);
  }
  // The operator's working cohort is theirs: every GATHER press rewrites
  // ~/gather/current.json (the session's own working state, shared with
  // every surface of this identity), so the suite keeps it as it found it.
  // Read now through /vfs, written back in the finally below, whatever fails.
  {
    const url = new URL(argusUrl_discover());
    const token = url.searchParams.get('token') ?? '';
    const cohortPath = leakBaseline !== null ? `${leakBaseline}/gather/current.json` : null;
    if (cohortPath !== null) {
      try {
        const response = await fetch(`${url.origin}/vfs?path=${encodeURIComponent(cohortPath)}&token=${encodeURIComponent(token)}`);
        cohortKept = { path: cohortPath, body: response.ok ? Buffer.from(await response.arrayBuffer()) : null, origin: url.origin, token };
        console.log(cohortKept.body !== null ? `  cohort: ${cohortPath} kept (${cohortKept.body.length} bytes), restored at the end` : `  cohort: none at ${cohortPath}`);
      } catch (error) {
        console.log(`  cohort: could not read ${cohortPath} (${error.message}); the GATHER scenarios may change it`);
      }
    }
  }
  let dicomSeries = process.env.SMOKE_DICOM_SERIES ?? '';
  let niftiPath = process.env.SMOKE_NIFTI ?? '';
  fixtureFolder = null;
  if (dicomSeries === '' && process.env.SMOKE_NO_FIXTURES === undefined) {
    const { series_write, nifti_write, SERIES_FOLDER } = await import('./fixtures/synth.mjs');
    const { mkdtempSync, readFileSync: read } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, basename } = await import('node:path');
    const local = mkdtempSync(join(tmpdir(), 'argus-smoke-fixtures-'));
    const slices = series_write(local);
    const nifti = nifti_write(join(local, 'sphere.nii.gz'));
    const home = await evalIn(`
      await console_idle();
      const input = console_input();
      input.value = 'cd ~; pwd'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 40; i++) { await sleep(250); const m = console_text().split('\\n').map((l) => l.trim()).reverse().find((l) => /^\\/home\\/[^\\s]+$/.test(l)); if (m) return m; }
      return null;`);
    if (home === null) {
      console.log('  fixtures: could not learn the identity\'s home; image scenarios will skip');
    } else {
      const url = new URL(argusUrl_discover());
      const token = url.searchParams.get('token') ?? '';
      fixtureFolder = `${home}/uploads/argus-smoke-${Date.now()}`;
      const put = async (localPath, remotePath) => {
        const response = await fetch(`${url.origin}/vfs?path=${encodeURIComponent(remotePath)}&token=${encodeURIComponent(token)}`, { method: 'POST', body: read(localPath) });
        if (!response.ok) throw new Error(`upload ${remotePath}: HTTP ${response.status}`);
      };
      try {
        for (const slice of slices) await put(slice, `${fixtureFolder}/${SERIES_FOLDER}/${basename(slice)}`);
        await put(nifti, `${fixtureFolder}/sphere.nii.gz`);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(local, 'README.md'), DOC_MARKDOWN);
        writeFileSync(join(local, 'guide.adoc'), DOC_ASCIIDOC);
        await put(join(local, 'README.md'), `${fixtureFolder}/docs/README.md`);
        await put(join(local, 'guide.adoc'), `${fixtureFolder}/docs/guide.adoc`);
        dicomSeries = `${fixtureFolder}/${SERIES_FOLDER}`;
        niftiPath = `${fixtureFolder}/sphere.nii.gz`;
        console.log(`  fixtures: ${slices.length} slices and a NIfTI put under ${fixtureFolder}`);
      } catch (error) {
        console.log(`  fixtures: ${error.message}; image scenarios will skip`);
        fixtureFolder = null;
      }
    }
  }
  // A feed for the node scenarios, unless one is named: the fixture folder
  // rooted as a feed (cd into it, run a DS plugin; the dircopy root holds
  // the series and the NIfTI), so node-dive has a node and node-volume a
  // volume without a feed id in the environment. Removed at the end.
  fixtureFeed = null;
  if (!process.env.SMOKE_DAG_FEED && fixtureFolder !== null) {
    fixtureFeed = await evalIn(`
      await console_idle();
      
      const before = console_mark();
      const input = console_input();
      input.value = ${JSON.stringify(`cd "${fixtureFolder}"; pl-simpledsapp-v2.1.5 -- feed_title="argus smoke fixture"`)}; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let feed = null;
      for (let i = 0; i < 360; i++) {
        await sleep(250);
        const text = console_since(before, ' ');
        feed = feed ?? (text.match(/Feed created: (\\d+)/) ?? [])[1] ?? null;
        if (/finished successfully|finished with error|refused/i.test(text)) break;
      }
      await home_return();
      return feed;`);
    console.log(fixtureFeed !== null ? `  fixtures: feed ${fixtureFeed} rooted on them for the node scenarios` : '  fixtures: no feed could be rooted on them; node scenarios will skip');
  }

  // The LOG OUT pill leaves by a door; at a daemon's root there is none.
  check('the LOG OUT pill stands only behind a door', await evalIn(`return document.getElementById('door-pill')?.hidden === true;`) === true);
  check('the RESTART pill stands only behind a door', await evalIn(`return document.getElementById('restart-pill')?.hidden === true;`) === true);
  if (!ready) throw new Error('no session');

  if (await stage('universe-pane')) {
    // The UNIVERSE is its own pane kind: pressing the dashboard's tile
    // opens one beside the errand host and asks the session for the space;
    // the title says what landed and whether the index is whole; a second
    // press focuses the same pane rather than opening another. The hover
    // tip on a sphere names the group and its feed (unit-tested; a pointer
    // over a settling sphere is not something a smoke can aim).
    const universe = await evalIn(`
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const tiles = () => [...document.querySelectorAll('.launcher-tile')];
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (tiles().length > 0) break; }
      const tile = tiles().find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE');
      const verb = tile?.querySelector('.launcher-verb');
      verb?.click();
      const panes = () => [...document.querySelectorAll('.pane-universe')].filter((p) => p.offsetParent !== null);
      // A wait over two seconds shows its progress: sampled from the press,
      // the pane either has its space or says what it is waiting on, and a
      // settle's percentage climbs.
      const waited = [];
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        const p = panes()[0];
        const w = p?.querySelector('.wait-progress');
        const drawn = /[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden);
        waited.push([i * 100 + 100, drawn ? 'DRAWN' : (w && !w.hidden ? w.textContent : '')]);
      }
      // Wait for a space with something in it: the smoke's cache is warm, so
      // a title still reading 0 FEEDS after this is a space that never came.
      for (let i = 0; i < 120; i++) { await sleep(500); if (panes().length > 0 && /[1-9]\\d* FEEDS/.test(panes()[0].querySelector('.universe-title')?.textContent ?? '')) break; }
      // The space arrives before it has settled: the settle runs in slices
      // under its own readout, and the scene is the settled one once the
      // readout is gone.
      for (let i = 0; i < 240; i++) { const w = panes()[0]?.querySelector('.wait-progress'); if (!w || w.hidden) break; await sleep(500); }
      await sleep(2000);
      // Gone from the screen, not only flagged hidden: a stylesheet can
      // outrank the flag and leave the last percentage standing.
      const readoutGone = (() => { const w = panes()[0]?.querySelector('.wait-progress'); return !w || getComputedStyle(w).display === 'none'; })();
      const first = panes()[0] ?? null;
      const title = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      const state = first?.querySelector('.pane-state')?.textContent?.trim() ?? '';
      const canvas = first?.querySelector('.universe-canvas canvas');
      const drawn = canvas !== null && canvas !== undefined && canvas.offsetWidth > 0 && getComputedStyle(first.querySelector('.universe-canvas')).display !== 'none';
      const framed = ['.field-rule', '.mode-strip', '.mode-elbow', '.mode-frame .universe-projection', '.mode-frame .universe-view', '.mode-frame .universe-scale', '.mode-frame .universe-density', '.mode-frame .universe-gravity', '.mode-frame .universe-refresh']
        .every((sel) => first?.querySelector(sel) !== null);
      const runsIsFeedViewer = (document.querySelector('.pane-dag .dag-title')?.textContent ?? '').startsWith('UNIVERSE') === false;
      // The descent, by word: enter a feed that landed, read the pane inside,
      // climb back out. The feed id comes from the remembered positions.
      await sleep(3500);
      // The space's positions: of the universe's stores (one per arrangement,
      // and its settings), the one that remembers feeds.
      const feedsIn = (k) => { try { return Object.keys(JSON.parse(localStorage.getItem(k) ?? '{}')).filter((x) => x.startsWith('feed:')).length; } catch { return 0; } };
      const storeKey = Object.keys(localStorage).filter((k) => k.startsWith('argus.universe.') && !k.includes('settings')).sort((a, b) => feedsIn(b) - feedsIn(a)).find((k) => feedsIn(k) > 0);
      const landedId = storeKey ? (Object.keys(JSON.parse(localStorage.getItem(storeKey) ?? '{}')).find((k) => k.startsWith('feed:')) ?? '').split(':')[1] : '';
      // A click does not resettle the space: wheel the camera in, click the
      // empty corner of the field, and neither the scene's own framing
      // count nor the remembered settle moves.
      const fitsBefore = canvas?.dataset.fits ?? '';
      const settledBefore = storeKey ? localStorage.getItem(storeKey) : '';
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      await sleep(300);
      for (const type of ['pointerdown', 'pointerup', 'click']) canvas.dispatchEvent(new (type === 'click' ? MouseEvent : PointerEvent)(type, { bubbles: true, clientX: rect.left + 6, clientY: rect.top + 6, button: 0 }));
      await sleep(4500);
      const fitsAfter = canvas?.dataset.fits ?? '';
      const settledAfter = storeKey ? localStorage.getItem(storeKey) : '';
      const clickTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      const clickKept = fitsBefore !== '' && fitsBefore === fitsAfter && settledBefore === settledAfter && !/INSIDE|ENTERING/.test(clickTitle);
      await say('universe enter ' + landedId, 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (/INSIDE FEED/.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(2500);
      const insideTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      const insideState = first?.querySelector('.pane-state')?.textContent?.trim() ?? '';
      const insideBlocks = ['.universe-back', '.universe-open'].every((sel) => { const e = first?.querySelector(sel); return e !== null && e !== undefined && getComputedStyle(e).display !== 'none'; });
      const outsideBlocksHiddenBefore = true;
      // 3D / 2D inside a feed flattens that feed only: the block reads 2D,
      // the pane stays inside, and the climb finds the space still in depth
      // (the feed is left flat on purpose: BACK takes the flat reading with it).
      const projectionPill = first?.querySelector('.universe-projection');
      projectionPill?.click();
      await sleep(1200);
      const insideFlat = { pill: projectionPill?.textContent?.trim() ?? '', title: first?.querySelector('.universe-title')?.textContent?.trim() ?? '' };
      await say('universe back', 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (!/INSIDE FEED/.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(2000);
      const backProjection = projectionPill?.textContent?.trim() ?? '';
      const backTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      const backBlocksHidden = ['.universe-back', '.universe-open'].every((sel) => { const e = first?.querySelector(sel); return e === null || e === undefined || getComputedStyle(e).display === 'none'; });
      // The cluster, by word: the shape of that feed in view, the rest dimmed,
      // BACK on the frame; and the climb out.
      await say('universe cluster ' + landedId, 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (/SHAPE /.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(2000);
      const clusterTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      const clusterState = first?.querySelector('.pane-state')?.textContent?.trim() ?? '';
      const clusterBack = (() => { const e = first?.querySelector('.universe-back'); return e !== null && e !== undefined && getComputedStyle(e).display !== 'none'; })();
      await say('universe back', 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (!/SHAPE /.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(1500);
      const clusterBackTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      // The fold: SHAPES view, the same cluster unfolds from its molecule, and back.
      await say('universe view shapes', 2500);
      const viewPill = first?.querySelector('.universe-view')?.textContent?.trim() ?? '';
      await say('universe cluster ' + landedId, 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (/SHAPE /.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(2500);
      const unfoldTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      await say('universe back', 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (!/SHAPE /.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(2000);
      await say('universe view feeds', 2500);
      const viewPillBack = first?.querySelector('.universe-view')?.textContent?.trim() ?? '';
      // The knobs: gravity off by word, the block says so, reset puts it back.
      await say('universe physics gravity off', 2000);
      const gravityOff = first?.querySelector('.universe-gravity')?.textContent?.trim() ?? '';
      await say('universe physics reset', 2000);
      const gravityReset = first?.querySelector('.universe-gravity')?.textContent?.trim() ?? '';
      // The draw: stars by default, spheres by word, the choice kept per identity.
      const drawDefault = first?.querySelector('.universe-draw')?.textContent?.trim() ?? '';
      await say('universe draw spheres', 2500);
      const drawSpheres = first?.querySelector('.universe-draw')?.textContent?.trim() ?? '';
      const keptSpheres = Object.keys(localStorage).filter((k) => k.startsWith('argus.universe.settings.')).map((k) => JSON.parse(localStorage.getItem(k) ?? '{}').draw).join(',');
      await say('universe draw stars', 2500);
      const drawStars = first?.querySelector('.universe-draw')?.textContent?.trim() ?? '';
      // The layout: a galaxy by default, clumps by word, laid out afresh (in the worker) and kept.
      const layoutDefault = first?.querySelector('.universe-arrangement')?.textContent?.trim() ?? '';
      await say('universe layout clumps', 500);
      for (let i = 0; i < 60; i++) { await sleep(500); const w = first?.querySelector('.wait-progress'); if (!w || getComputedStyle(w).display === 'none') break; }
      const layoutClumps = first?.querySelector('.universe-arrangement')?.textContent?.trim() ?? '';
      const keptClumps = Object.keys(localStorage).filter((k) => k.startsWith('argus.universe.settings.')).map((k) => JSON.parse(localStorage.getItem(k) ?? '{}').arrangement).join(',');
      await say('universe layout galaxy', 500);
      for (let i = 0; i < 60; i++) { await sleep(500); const w = first?.querySelector('.wait-progress'); if (!w || getComputedStyle(w).display === 'none') break; }
      // Every job its own point, and back to a sphere per stage.
      await say('universe density census', 4000);
      const densityCensus = first?.querySelector('.universe-density')?.textContent?.trim() ?? '';
      const censusTitle = first?.querySelector('.universe-title')?.textContent?.trim() ?? '';
      // Census with a feed entered: the census shells every job of the feed
      // (a feed view's nodes are tubed, never solid, so none is held out),
      // and the camera stays where the flight put it.
      await say('universe enter ' + landedId, 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (/INSIDE FEED/.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(2000);
      const stateMark = console_mark();
      await say('universe state', 1500);
      let censusState = '';
      for (let i = 0; i < 40 && censusState === ''; i++) { censusState = console_since(stateMark, '\\n').split('\\n').filter((l) => /^scene:/.test(l)).slice(-1)[0] ?? ''; if (censusState === '') await sleep(250); }
      await say('universe back', 500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (!/INSIDE FEED/.test(first?.querySelector('.universe-title')?.textContent ?? '')) break; }
      await sleep(1500);
      await say('universe density shape', 3000);
      const densityShape = first?.querySelector('.universe-density')?.textContent?.trim() ?? '';
      // Press the tile again: the same pane, focused, not a second one.
      await say('dashboard', 2500);
      for (let i = 0; i < 60; i++) { await sleep(500); if (tiles().length > 0) break; }
      tiles().find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      for (let i = 0; i < 40; i++) { await sleep(500); if (panes().length > 0) break; }
      await sleep(1000);
      const count = document.querySelectorAll('.pane-universe').length;
      await say('view files', 2000);
      return { hadTile: tile !== undefined, title, state, drawn, framed, runsIsFeedViewer, count, landedId, insideTitle, insideState, insideBlocks, outsideBlocksHiddenBefore, insideFlat, backProjection, backTitle, backBlocksHidden, clusterTitle, clusterState, clusterBack, clusterBackTitle, viewPill, unfoldTitle, viewPillBack, gravityOff, gravityReset, densityCensus, censusTitle, densityShape, clickKept, fitsBefore, fitsAfter, clickTitle, waited, drawDefault, drawSpheres, keptSpheres, drawStars, readoutGone, layoutDefault, layoutClumps, keptClumps, censusState };`);
    check('the UNIVERSE tile opens a pane of its own kind, titled by what landed',
      universe.hadTile && /^UNIVERSE — [1-9]\d* FEEDS · [1-9]\d* SHAPES/.test(universe.title), universe.title);
    check('the universe pane says whether the index is whole', universe.state === 'WHOLE' || universe.state === 'LANDING', universe.state);
    check('the universe draws on its own field, framed with its modes', universe.drawn && universe.framed);
    check('RUNS stays a feed viewer while the universe is up', universe.runsIsFeedViewer);
    check('a second press focuses the universe rather than opening another', universe.count === 1, String(universe.count));
    {
      // From half a second on, never a blank field: the space, or what it waits on.
      // The wait is the browser's own settle, or the session laying the space out for every browser.
      const blank = universe.waited.filter(([t, s]) => t >= 500 && !(s === 'DRAWN' || /ASKING|SETTLING|LAYING OUT/.test(s)));
      const percents = universe.waited.map(([, s]) => (s.match(/(?:SETTLING|LAYING OUT) .* (\d+)%$/) ?? [])[1]).filter((v) => v !== undefined).map(Number);
      const climbs = percents.length < 2 || percents[percents.length - 1] > percents[0];
      check('a wait over two seconds shows its progress: from the press the universe is drawn or says what it waits on, and a settle climbs',
        blank.length === 0 && climbs && universe.readoutGone,
        JSON.stringify(universe.waited.filter((_, i) => i % 5 === 0)));
    }
    check('the universe draws stars by default; universe draw spheres and stars switch it, and the choice is kept for this identity',
      universe.drawDefault === 'STARS' && universe.drawSpheres === 'SPHERES' && universe.keptSpheres === 'spheres' && universe.drawStars === 'STARS',
      `${universe.drawDefault} | ${universe.drawSpheres} | ${universe.keptSpheres} | ${universe.drawStars}`);
    check('the universe lays itself out as a galaxy by default; universe layout clumps switches it, and the choice is kept',
      universe.layoutDefault === 'GALAXY' && universe.layoutClumps === 'CLUMPS' && universe.keptClumps === 'clumps',
      `${universe.layoutDefault} | ${universe.layoutClumps} | ${universe.keptClumps}`);
    {
      const marked = Number((universe.censusState.match(/solidMarked=(\d+)/) ?? [])[1] ?? -1);
      const nodes = Number((universe.censusState.match(/ nodes=(\d+)/) ?? [])[1] ?? 0);
      const members = Number((universe.censusState.match(/censusMembers=(\d+)/) ?? [])[1] ?? 0);
      check('in census a feed entered shells every job: no node is held out as solid, and the census holds at least one member per node',
        marked === 0 && nodes > 0 && members >= nodes && /census=true/.test(universe.censusState), universe.censusState);
    }
    check('a click keeps the camera: a wheeled-in camera and the settled space stand through a click on the field',
      universe.clickKept, `fits ${universe.fitsBefore} -> ${universe.fitsAfter} | ${universe.clickTitle}`);
    check('universe enter <feed> descends: the title names the feed inside, the state says INSIDE, BACK and OPEN FEED stand on the frame',
      universe.landedId !== '' && new RegExp('^UNIVERSE — INSIDE FEED ' + universe.landedId + ' · ').test(universe.insideTitle) && /^INSIDE( · (LIVE|SETTLED|STALE))?$/.test(universe.insideState) && universe.insideBlocks,
      `${universe.landedId} | ${universe.insideTitle} | ${universe.insideState}`);
    check('2D inside a feed flattens that feed only: the block reads 2D inside, and the space climbed back to reads 3D',
      universe.insideFlat?.pill === '2D' && /INSIDE FEED/.test(universe.insideFlat?.title ?? '') && universe.backProjection === '3D',
      `inside ${universe.insideFlat?.pill} | back ${universe.backProjection}`);
    check('universe back climbs out: the space is titled whole again and the descent blocks retract',
      /^UNIVERSE — [1-9]\d* FEEDS · [1-9]\d* SHAPES/.test(universe.backTitle) && universe.backBlocksHidden, universe.backTitle);
    check('universe cluster <feed> brings its shape into view: the title names the shape and its count, the state says CLUSTER, BACK stands',
      /^UNIVERSE — SHAPE .+ · [1-9]\d* FEEDS?$/.test(universe.clusterTitle) && universe.clusterState === 'CLUSTER' && universe.clusterBack,
      `${universe.clusterTitle} | ${universe.clusterState}`);
    check('universe back from a cluster returns to the whole space',
      /^UNIVERSE — [1-9]\d* FEEDS · [1-9]\d* SHAPES/.test(universe.clusterBackTitle), universe.clusterBackTitle);
    check('universe view shapes folds the top, a folded shape unfolds into its members, and the view comes back to feeds',
      universe.viewPill === 'SHAPES' && /^UNIVERSE — SHAPE .+ · [1-9]\d* FEEDS?$/.test(universe.unfoldTitle) && universe.viewPillBack === 'FEEDS',
      `${universe.viewPill} | ${universe.unfoldTitle} | ${universe.viewPillBack}`);
    check('universe physics gravity off turns the GRAVITY block off, and reset turns it back on',
      universe.gravityOff === 'GRAVITY OFF' && universe.gravityReset === 'GRAVITY ON', `${universe.gravityOff} | ${universe.gravityReset}`);
    check('universe density census draws every job and the block says so; shape brings the spheres back',
      universe.densityCensus === 'CENSUS' && /FEEDS · [1-9]\d* SHAPES/.test(universe.censusTitle) && universe.densityShape === 'SHAPE',
      `${universe.densityCensus} | ${universe.censusTitle} | ${universe.densityShape}`);
  }

  if (await stage('universe-pill-bar')) {
  // A frame pill answers on its pane's own bar, not in the console: the
  // UNIVERSE layout pill cycled six times once filled the console with the
  // layouts' descriptions, no command typed.
  const pill = await evalIn(`
    await console_idle();
    const panes = () => [...document.querySelectorAll('.pane-universe')].filter((p) => p.offsetParent !== null);
    if (panes().length === 0) {
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelectorAll('.launcher-tile').length > 0) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      for (let i = 0; i < 120; i++) { await sleep(500); if (panes().length > 0 && /[1-9]\\d* FEEDS/.test(panes()[0].querySelector('.universe-title')?.textContent ?? '')) break; }
      for (let i = 0; i < 240; i++) { const w = panes()[0]?.querySelector('.wait-progress'); if (!w || w.hidden) break; await sleep(500); }
    }
    const pane = panes()[0]; if (!pane) return { error: 'no universe pane' };
    const bar = pane.querySelector('.pane-state');
    const arrangement = pane.querySelector('.universe-arrangement');
    const captions = pane.querySelector('.universe-captions');
    const standing = bar?.textContent.trim() ?? '';
    // The boot's welcome can land after the console reads idle: measure
    // only once the console has stood still for a moment.
    // What the console wrote, not its prompt bar: the bar's readouts move on their own.
    const written = () => terminal_mode() ? String(window.__argusConsole.mark()) : (document.querySelector('#terminal .argus-output')?.innerText ?? '');
    { let last = ''; let still = 0; for (let i = 0; i < 60 && still < 3; i++) { const now = written(); still = now === last ? still + 1 : 0; last = now; await sleep(500); } }
    const consoleBefore = written();
    captions?.click(); await sleep(150);
    const noted = { text: bar?.textContent.trim() ?? '', cls: bar?.classList.contains('state-note') ?? false };
    captions?.click(); await sleep(150);
    const notedAgain = bar?.textContent.trim() ?? '';
    await sleep(4600);
    const restored = { text: bar?.textContent.trim() ?? '', cls: bar?.classList.contains('state-note') ?? false };
    const consoleAfter = written();
    return { standing, noted, notedAgain, restored, consoleGrew: consoleAfter !== consoleBefore, grew: terminal_mode() ? console_text().slice(-300) : consoleAfter.startsWith(consoleBefore) ? consoleAfter.slice(consoleBefore.length).slice(-300) : consoleAfter.slice(-300), arrangementLabel: arrangement?.textContent.trim() ?? '' };`);
  check('a frame pill answers on its own bar: the captions pill holds its answer on the pane state, then the standing state returns',
    pill.error === undefined && pill.noted.cls && /captions/i.test(pill.noted.text) && pill.notedAgain !== pill.noted.text && !pill.restored.cls && pill.restored.text === pill.standing,
    JSON.stringify(pill));
  check('a frame pill writes nothing to the console', pill.error === undefined && pill.consoleGrew === false, JSON.stringify(pill));
  }

  if (await stage('edge-flare')) {
  // A field meets its edge (the operator's ask: "a slight flare pulse effect
  // and a bounce like on mobile devices"): a wheel past a listing's foot,
  // and past its top, sets data-edge and the stylesheet runs the flare on
  // the field and the bounce on its rows; the flare's end clears it.
  const edge = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(80); await console_settled(); await console_idle(); };
    document.getElementById('gutter-files').click(); await sleep(700);
    await say('cd /bin');
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    const field = () => fp()?.querySelector('.listing-field');
    for (let i = 0; i < 60; i++) { await sleep(400); const f = field(); if (f && f.scrollHeight > f.clientHeight + 40) break; }
    const f = field();
    if (!f || f.scrollHeight <= f.clientHeight + 2) return { skipped: 'no overflowing listing' };
    f.scrollTop = f.scrollHeight; await sleep(300);
    f.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
    await sleep(60);
    const bottom = f.dataset.edge ?? '';
    const flare = getComputedStyle(f).animationName;
    const bounce = getComputedStyle(f.firstElementChild).animationName;
    let cleared = false;
    for (let i = 0; i < 20; i++) { await sleep(100); if (f.dataset.edge === undefined) { cleared = true; break; } }
    f.scrollTop = 0; await sleep(300);
    f.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true }));
    await sleep(60);
    const top = f.dataset.edge ?? '';
    const topFlare = getComputedStyle(f).animationName;
    await say('cd ~');
    return { bottom, flare, bounce, cleared, top, topFlare };`);
  if (edge.skipped !== undefined) {
    console.log('  skip  edge flare (' + edge.skipped + ')');
  } else {
    check('a wheel past a field\'s foot flares it and bounces its rows; the flare\'s end clears it',
      edge.bottom === 'bottom' && edge.flare === 'edge-flare-bottom' && edge.bounce === 'edge-bounce-bottom' && edge.cleared, JSON.stringify(edge));
    check('a wheel past a field\'s top flares the top', edge.top === 'top' && edge.topFlare === 'edge-flare-top', JSON.stringify(edge));
  }
  }

  if (await stage('restart-question')) {
  // #863: behind a door the RESTART pill asks first, in the notice's spot,
  // naming what a restart would cut off; Esc answers no and the keys never
  // reach the stage. A daemon's root has no door to restart through, so the
  // stage borrows the door's mark (?door) and never answers yes.
  await evalIn(`location.assign(location.href + (location.search ? '&' : '?') + 'door'); return 1;`).catch(() => 1);
  await new Promise((r) => setTimeout(r, 1500));
  const asked = await evalIn(`
    for (let i = 0; i < 120 && !/READY/.test(document.getElementById('drawer-status')?.textContent ?? ''); i++) await sleep(500);
    const pill = document.getElementById('restart-pill');
    const shown = pill?.hidden === false;
    pill?.click(); await sleep(300);
    const question = document.querySelector('.restart-question');
    const words = question?.querySelector('.stale-page-words div')?.textContent ?? '';
    const focused = document.activeElement?.classList.contains('restart-yes') ?? false;
    let stageSawEsc = false;
    const spy = (event) => { if (event.key === 'Escape') stageSawEsc = true; };
    document.addEventListener('keydown', spy);
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', spy);
    await sleep(200);
    return { shown, words, focused, gone: document.querySelector('.restart-question') === null, stageSawEsc };`);
  await evalIn(`location.assign(location.href.replace(/[?&]door/, '')); return 1;`).catch(() => 1);
  await new Promise((r) => setTimeout(r, 1500));
  await evalIn(`for (let i = 0; i < 120 && !/READY/.test(document.getElementById('drawer-status')?.textContent ?? ''); i++) await sleep(500); return 1;`);
  check('behind a door the RESTART pill asks first, in words, with YES focused', asked.shown && /^Restart the calypso daemon\? You'll stay logged in/.test(asked.words) && asked.focused, JSON.stringify(asked));
  check('Esc answers the restart question no, and the stage never sees the key', asked.gone && !asked.stageSawEsc, JSON.stringify(asked));
  }

  if (await stage('roster-returns-unlit')) {
  // The operator: OPEN a run, Esc back, and the run stood lit with the
  // others dimmed, and no press anywhere took it away. The press's
  // acknowledgement (listing-activating) waited for the roster's own rows
  // to settle it, and a run's answer is a graph taking the pane. The graph
  // settles it now; the roster comes back with nothing lit, and a press
  // off the listing stands an indication down.
  const unlit = await evalIn(`
    await console_idle();
    document.getElementById('gutter-runs').click(); await sleep(1200);
    const dp = [...document.querySelectorAll('.pane-dag')].find((p) => p.offsetParent !== null);
    const settle = async (want, tries = 60) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    await settle(() => dp?.querySelector('.feedlist-row') != null);
    const row = () => dp.querySelector('.feedlist-row');
    if (row() === null) return { skipped: 'no runs listed' };
    const lit = () => dp.querySelectorAll('.listing-indicated, .listing-activating').length;
    row().querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(() => dp.querySelector('.listing-indicated .listing-control') !== null);
    dp.querySelector('.listing-indicated .listing-control').click();
    const entered = await settle(() => dp.querySelector('.roster-shown') === null && dp.querySelector('canvas')?.offsetParent != null, 80);
    // Esc retreats one level a press: a frame open on the graph takes the
    // first, the graph the next.
    for (let i = 0; i < 3 && dp.querySelector('.roster-shown') === null; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(500); }
    const back = await settle(() => dp.querySelector('.roster-shown') !== null);
    await sleep(300);
    const afterEsc = lit();
    row().querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(() => lit() === 1);
    document.getElementById('status-strip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    return { entered, back, afterEsc, afterPress: lit() };`);
  if (unlit.skipped !== undefined) {
    console.log('  skip  roster returns unlit (' + unlit.skipped + ')');
  } else {
    check('a run OPENed and left by Esc returns to a roster with nothing lit', unlit.entered && unlit.back && unlit.afterEsc === 0, JSON.stringify(unlit));
    check('a press off the listing stands an indicated run down', unlit.afterPress === 0, JSON.stringify(unlit));
  }
  }

  if (await stage('more-everywhere')) {
  // Every scrolling field wears the chip: the fields a page has at rest are
  // wired the moment they are stamped, and a node's readout once immersed.
  const more = await evalIn(`
    await console_idle();
    const wired = (sel) => { const el = document.querySelector(sel); return el === null ? 'absent' : (el.dataset.more === 'wired' && scrollbarNone(el) ? 'wired' : 'bare'); };
    // The panes are stamped when opened: open each, then read its field.
    for (const id of ['gutter-dashboard', 'gutter-panes', 'gutter-tools']) { document.getElementById(id)?.click(); await sleep(600); }
    const atRest = { launcherGrid: wired('.launcher-grid'), launcherBody: wired('.launcher-body'), panesBody: wired('.panes-body'), pacs: wired('#pacs-workspace') };
    // a mount around a wired field never scrolls itself (the band's own
    // rows are a wired field, so the gather PANE's mount is the one read)
    const mounts = ['.pane-gather .gather-rows', '.files-table-rows'].map((sel) => { const el = document.querySelector(sel); return el === null ? 'absent' : getComputedStyle(el).overflowY; });
    // the viewer's body: open a text file in a split with a viewer
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(80); await console_settled(); await console_idle(); };
    await say('cd /bin');
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    if (!fp()) { document.getElementById('gutter-files').click(); for (let i = 0; i < 40; i++) { await sleep(250); if (fp()) break; } }
    let plugin = null;
    for (let i = 0; i < 60; i++) { await sleep(500); plugin = fp()?.querySelector('.files-row.files-type-plugin'); if (plugin) break; }
    if (!plugin) { await say('cd ~'); return { atRest, mounts, node: 'no plugin row' }; }
    plugin.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    let facts = null;
    for (let i = 0; i < 60; i++) { await sleep(500); facts = document.querySelector('.dag-facts-immersed'); if (facts) break; }
    const node = facts === null ? 'no immersed readout' : (facts.dataset.more === 'wired' && scrollbarNone(facts) ? 'wired' : 'bare');
    const chip = facts?.querySelector('.more-chip');
    const overflowing = facts !== null && facts.scrollHeight > facts.clientHeight + 2;
    const chipRight = chip === null || chip === undefined ? 'absent' : (overflowing ? (!chip.hidden && /MORE|TOP/.test(chip.textContent) ? 'shown' : 'hidden-while-overflowing') : (chip.hidden ? 'hidden' : 'shown-while-fitting'));
    // Leave as it came: out of the dive, the diagram closed, back home.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(800);
    fp()?.querySelector('.files-close-pill')?.click(); await sleep(500);
    await say('cd ~');
    return { atRest, mounts, node, chipRight, overflowing };`);
  check('the fields a page has at rest wear the chip and hide their scrollbars: the dashboard, the desktop, the PACS workspace',
    more.atRest !== undefined && Object.values(more.atRest).every((v) => v === 'wired' || v === 'absent') && Object.values(more.atRest).some((v) => v === 'wired'),
    JSON.stringify(more.atRest));
  check('a mount around a wired field never scrolls itself', (more.mounts ?? []).every((v) => v === 'hidden' || v === 'absent'), JSON.stringify(more.mounts));
  check('a node readout immersed in a DAG wears the chip, shown only while it holds more',
    more.node === 'wired' && (more.chipRight === 'shown' || more.chipRight === 'hidden'), JSON.stringify(more));
  }

  if (await stage('pane-move')) {
  // A pane can be moved: the drawer's MOVE arms the direction capsules for
  // one press; the typed verb is the same move, refused by name.
  const move = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120); await console_settled(); await console_idle(); };
    const text = () => console_text();
    const after = (cmd) => { const t = text(); return t.slice(t.lastIndexOf('❯ ' + cmd) + cmd.length + 2).trim(); };
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    if (!fp()) { document.getElementById('gutter-files').click(); for (let i = 0; i < 40; i++) { await sleep(250); if (fp()) break; } }
    const leaves = () => [...document.querySelectorAll('.layout-leaf')].map((l) => l.dataset.leaf);
    const before = new Set(leaves());
    await say('pane split right');
    const born = leaves().find((id) => !before.has(id)); if (!born) return { error: 'no pane born' };
    const rect = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"]').getBoundingClientRect();
    const filesId = leaves().find((id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"] .pane-files'));
    const rightOf = rect(born).left >= rect(filesId).right - 2;
    const mount = document.querySelector('.layout-leaf[data-leaf="' + born + '"]');
    const drawer = mount.querySelector('.pane-drawer');
    drawer.hidden = false;
    const movePill = drawer.querySelector('.drawer-mode[data-mode="move"]'); movePill.click(); await sleep(100);
    const capsule = (split, place) => drawer.querySelector('[data-split="' + split + '"][data-place="' + place + '"]');
    const armed = { lit: movePill.classList.contains('drawer-mode-selected'), mode: drawer.dataset.mode, rightDimmed: capsule('col', 'after').disabled, belowOffered: !capsule('row', 'after').disabled };
    const consoleBefore = text().length;
    capsule('row', 'after').click(); await sleep(150);
    // the tree re-rendered: the leaf is a new element, the pane's mount moved into it
    const bar = document.querySelector('.layout-leaf[data-leaf="' + born + '"] .pane-state')?.textContent.trim() ?? '';
    const belowOf = rect(born).top >= rect(filesId).bottom - 2;
    const fellBack = drawer.dataset.mode === 'split' && drawer.querySelector('.drawer-mode[data-mode="split"]').classList.contains('drawer-mode-selected');
    const consoleQuiet = !/moved|MOVED/.test(text().slice(consoleBefore));
    await say('pane move above'); const typed = after('pane move above');
    const aboveOf = rect(born).bottom <= rect(filesId).top + 2;
    await say('pane move above'); const refused = after('pane move above');
    await say('pane close');
    return { born, rightOf, armed, bar, belowOf, fellBack, consoleQuiet, typed, aboveOf, refused };`);
  check("a pane moves where the drawer's MOVE sends it: armed, the edge dims, a split-right pane goes below; the drawer falls back to SPLIT; the bar says MOVED; the console carries nothing",
    move.error === undefined && move.rightOf && move.armed.lit && move.armed.mode === 'move' && move.armed.rightDimmed && move.armed.belowOffered && move.belowOf && move.fellBack && /MOVED BELOW/.test(move.bar) && move.consoleQuiet,
    JSON.stringify(move));
  check('pane move <side> is the verb typed, refused by name at the edge',
    move.error === undefined && /^moved above/.test(move.typed) && move.aboveOf && /already topmost/.test(move.refused), JSON.stringify(move));
  }

  if (await stage('pane-move-restore')) {
  // A moved pane returns where it was moved to: the desktop records the
  // stage's tiling at dormancy and lays it over the replayed panes.
  const back = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120); await console_settled(); await console_idle(); };
    const settle = async (test, tries = 40) => { for (let i = 0; i < tries; i++) { if (test()) return true; await sleep(250); } return test(); };
    document.getElementById('gutter-files').click(); await sleep(800);
    const leaves = () => [...document.querySelectorAll('.layout-leaf')].map((l) => l.dataset.leaf);
    const rect = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"]').getBoundingClientRect();
    const before = new Set(leaves());
    await say('pane split right');
    const born = leaves().find((id) => !before.has(id)); if (!born) return { error: 'no pane born' };
    const drawer = document.querySelector('.layout-leaf[data-leaf="' + born + '"] .pane-drawer');
    drawer.hidden = false;
    drawer.querySelector('.drawer-mode[data-mode="move"]').click(); await sleep(100);
    drawer.querySelector('[data-split="row"][data-place="after"]').click(); await sleep(200);
    const movedBelow = rect(born).top >= rect('files').bottom - 2;
    // away, then back through PANES
    document.getElementById('gutter-runs').click(); await sleep(1200);
    document.getElementById('gutter-panes').click(); await sleep(800);
    const desktop = (window.__argusDormant?.list?.() ?? []).find((g) => (g.actions ?? []).some((a) => a.op === 'empty') && g.shape !== undefined);
    const shaped = desktop !== undefined && desktop.shape !== undefined && !('leaf' in desktop.shape) && desktop.shape.dir === 'row';
    const card = [...document.querySelectorAll('.panes-card')].find((c) => c.querySelector('.panes-card-label')?.textContent === desktop?.label);
    if (card) card.click();
    const empty = () => [...document.querySelectorAll('.layout-leaf')].find((l) => l.querySelector('.pane-empty') && l.offsetParent !== null);
    const returned = await settle(() => empty() !== undefined && document.querySelector('.layout-leaf[data-leaf="files"]') !== null, 60);
    await sleep(400);
    const belowAgain = returned && empty().getBoundingClientRect().top >= rect('files').bottom - 2;
    const restoredId = empty()?.dataset.leaf ?? null;
    if (restoredId) { const d = empty().querySelector('.pane-drawer'); d.hidden = false; d.querySelector('.drawer-close')?.click(); await sleep(300); }
    return { born, movedBelow, carded: desktop !== undefined, shaped, cardFound: card !== undefined, returned, belowAgain };`);
  check('a moved pane returns where it was moved to: the desktop keeps the tiling and lays it over the replayed panes',
    back.error === undefined && back.movedBelow && back.carded && back.shaped && back.cardFound && back.returned && back.belowAgain, JSON.stringify(back));
  }

  if (await stage('prefix-chords')) {
  // With the drawer open, one key presses one capsule; the arrows focus.
  const chord = await evalIn(`
    await console_idle();
    const press = (key, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    const prefix = () => press('b', { ctrlKey: true });
    const leaves = () => [...document.querySelectorAll('.layout-leaf')].map((l) => l.dataset.leaf);
    const rect = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"]').getBoundingClientRect();
    const drawerOf = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"] .pane-drawer');
    document.getElementById('gutter-files').click(); await sleep(600);
    document.querySelector('.pane-files .files-panel')?.click(); await sleep(150);
    const before = new Set(leaves());
    prefix(); await sleep(150);
    const opened = drawerOf('files') !== null && !drawerOf('files').hidden;
    const titled = /\\[keys % l\\]/.test(drawerOf('files')?.querySelector('[data-split="col"][data-place="after"]')?.title ?? '');
    press('l'); await sleep(400);
    const born = leaves().find((id) => !before.has(id));
    const splitRight = born !== undefined && rect(born).left >= rect('files').right - 2;
    // J: move below, one chord (arms MOVE, presses BELOW, MOVE stands down)
    prefix(); await sleep(150);
    const bornDrawerOpen = born !== undefined && !drawerOf(born).hidden;
    press('J'); await sleep(400);
    const movedBelow = born !== undefined && rect(born).top >= rect('files').bottom - 2;
    const stoodDown = born !== undefined && drawerOf(born).dataset.mode === 'split';
    // the arrows focus: up from the moved pane is the files pane, whose drawer the next prefix opens
    prefix(); await sleep(150);
    press('ArrowUp'); await sleep(200);
    prefix(); await sleep(150);
    const focusedUp = drawerOf('files') !== null && !drawerOf('files').hidden;
    press('Escape'); await sleep(150);
    // ? prints the table
    prefix(); await sleep(150);
    press('?'); await sleep(600);
    const table = /prefix chords/.test(console_text());
    // down to the moved pane by arrow, then x closes it
    prefix(); await sleep(150);
    press('ArrowDown'); await sleep(200);
    prefix(); await sleep(150);
    const xDrawerIsBorn = born !== undefined && !drawerOf(born).hidden;
    press('x'); await sleep(400);
    const closed = !leaves().includes(born);
    return { opened, titled, born, splitRight, bornDrawerOpen, movedBelow, stoodDown, focusedUp, table, xDrawerIsBorn, closed };`);
  check('a chord presses a drawer verb: l splits right, J moves below and stands MOVE down, x closes; the capsule names its key',
    chord.opened && chord.titled && chord.splitRight && chord.bornDrawerOpen && chord.movedBelow && chord.stoodDown && chord.xDrawerIsBorn && chord.closed, JSON.stringify(chord));
  check('an arrow with the drawer open focuses the pane in that direction, and ? prints the chord table',
    chord.focusedUp && chord.table, JSON.stringify(chord));
  }

  if (await stage('keys-reach-the-frame')) {
  // a-frame-is-reachable-by-keys: over a listing the arrows move a row
  // cursor and Enter indicates the row, its verbs riding the frame; → (or
  // Ctrl-B r) takes the keys into the frame, the arrows walk its verbs, ←
  // gives them back; Ctrl-B & closes every pane on the stage.
  const keyed = await evalIn(`
    await console_idle();
    const press = (key, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    const prefix = () => press('b', { ctrlKey: true });
    const leaves = () => [...document.querySelectorAll('.layout-leaf')].map((l) => l.dataset.leaf);
    document.getElementById('gutter-files').click(); await sleep(800);
    document.querySelector('.pane-files .files-panel')?.click(); await sleep(150);
    document.activeElement?.blur?.();
    const pane = document.querySelector('.layout-leaf[data-leaf="files"]')?.closest('.workspace-pane') ?? document.querySelector('.layout-leaf[data-leaf="files"]');
    const rows = () => [...pane.querySelectorAll('.listing-row')].filter((r) => r.offsetParent !== null);
    const cursorAt = () => rows().findIndex((r) => r.classList.contains('listing-cursor'));
    const rowCount = rows().length;
    press('ArrowDown'); await sleep(100);
    const first = cursorAt();
    press('ArrowDown'); await sleep(100);
    const second = cursorAt();
    press('End'); await sleep(100);
    const last = cursorAt();
    press('Home'); await sleep(100);
    const home = cursorAt();
    // The first row can be the way up (..), which a single press takes; a
    // row below it is indicated by Enter and acted on only by a second.
    press('ArrowDown'); await sleep(100);
    const picked = cursorAt();
    press('Enter'); await sleep(500);
    const indicated = rows()[picked]?.classList.contains('listing-indicated') === true;
    press('ArrowRight'); await sleep(400);
    const inFrame = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest('.mode-frame') !== null;
    const firstVerb = document.activeElement?.textContent?.trim() ?? '';
    press('ArrowDown'); await sleep(100);
    const walked = document.activeElement instanceof HTMLButtonElement && (document.activeElement.textContent?.trim() ?? '') !== firstVerb;
    press('ArrowLeft'); await sleep(100);
    const backOut = document.activeElement === document.body || document.activeElement === null;
    press('Escape'); await sleep(300);
    // Ctrl-B r: the same way in, from the drawer.
    prefix(); await sleep(150); press('r'); await sleep(400);
    const chordIn = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest('.mode-frame') !== null;
    document.activeElement?.blur?.(); press('Escape'); await sleep(300);
    // Ctrl-B &: two splits, then every pane closes.
    const before = new Set(leaves());
    prefix(); await sleep(150); press('l'); await sleep(400);
    prefix(); await sleep(150); press('j'); await sleep(400);
    const born = leaves().filter((id) => !before.has(id));
    prefix(); await sleep(150); press('&'); await sleep(900);
    const said = /closed \\d+ panes?/.test(console_text());
    const gone = born.length === 2 && born.every((id) => !leaves().includes(id));
    document.getElementById('gutter-files').click(); await sleep(500);
    return { rowCount, first, second, last, home, picked, indicated, inFrame, firstVerb, walked, backOut, chordIn, born, said, gone };`);
  check('over a listing the arrows move a row cursor (Home/End the ends) and Enter indicates the row',
    keyed.rowCount >= 2 && keyed.first === 0 && keyed.second === 1 && keyed.last === keyed.rowCount - 1 && keyed.home === 0 && keyed.indicated, JSON.stringify(keyed));
  check('→ and Ctrl-B r take the keys into the frame, the arrows walk its verbs, ← gives them back',
    keyed.inFrame && keyed.walked && keyed.backOut && keyed.chordIn, JSON.stringify(keyed));
  check('Ctrl-B & closes every pane on the stage and says how many',
    keyed.said && keyed.gone, JSON.stringify(keyed));
  }

  if (await stage('prefix-chords-2')) {
  // The rest of tmux's table: last pane, pane ids, flip, resize, PANES, scrollback, break out.
  const more = await evalIn(`
    await console_idle();
    const press = (key, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    const prefix = () => press('b', { ctrlKey: true });
    const leaves = () => [...document.querySelectorAll('.layout-leaf')].map((l) => l.dataset.leaf);
    const rect = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"]').getBoundingClientRect();
    const drawerOf = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"] .pane-drawer');
    const bar = (id) => document.querySelector('.layout-leaf[data-leaf="' + id + '"] .pane-state')?.textContent.trim() ?? '';
    document.getElementById('gutter-files').click(); await sleep(600);
    document.querySelector('.pane-files .files-panel')?.click(); await sleep(150);
    const before = new Set(leaves());
    prefix(); await sleep(150); press('l'); await sleep(400);
    const born = leaves().find((id) => !before.has(id)); if (!born) return { error: 'no pane born' };
    // ; : the last pane (files) takes focus; its drawer answers the next prefix
    prefix(); await sleep(150); press(';'); await sleep(200);
    prefix(); await sleep(150);
    const lastFocused = drawerOf('files') !== null && !drawerOf('files').hidden;
    // q : every pane names itself on its bar
    press('q'); await sleep(200);
    const named = bar('files') === '@files' && bar(born) === '@' + born;
    // Space : the pair flips, beside becomes above
    prefix(); await sleep(150); press(' '); await sleep(400);
    const flipped = rect(born).top >= rect('files').bottom - 2 && /FLIPPED/.test(bar('files'));
    // Ctrl-Down : the boundary moves down, files grows
    const filesBefore = rect('files').height;
    prefix(); await sleep(150); press('ArrowDown', { ctrlKey: true }); await sleep(300);
    const grew = rect('files').height > filesBefore + 4;
    const drawerStayed = drawerOf('files') !== null && !drawerOf('files').hidden;
    press('Escape'); await sleep(150);
    // [ : the scrollback takes the keys
    prefix(); await sleep(150); press('['); await sleep(200);
    const scrollback = document.activeElement?.classList.contains('argus-output') === true;
    document.querySelector('.pane-files .files-panel')?.click(); await sleep(150);
    // ! : files alone on stage, the arrangement a PANES card
    // The arrangement is carded: a card left the stage at the break-out. Not
    // a count — at the cap a new card drops the oldest, and an arrangement an
    // earlier scenario carded under the same anchor is the same card, re-touched.
    const brokeAt = Date.now();
    prefix(); await sleep(150); press('!'); await sleep(600);
    const alone = leaves().length === 1 && leaves()[0] === 'files' && /ALONE/.test(bar('files'));
    const carded = (window.__argusDormant?.list?.() ?? []).some((card) => card.lastTouched >= brokeAt);
    // w : PANES
    prefix(); await sleep(150); press('w'); await sleep(600);
    const panesShown = document.querySelector('.pane-panes')?.offsetParent !== null;
    document.getElementById('gutter-files').click(); await sleep(400);
    return { born, lastFocused, named, flipped, grew, drawerStayed, scrollback, alone, carded, panesShown };`);
  check('; focuses the last pane, q names every pane on its bar, Space flips the pair, Ctrl-arrow moves the boundary and keeps the drawer',
    more.error === undefined && more.lastFocused && more.named && more.flipped && more.grew && more.drawerStayed, JSON.stringify(more));
  check('[ hands the keys to the scrollback, ! breaks the pane out with the arrangement carded, w opens PANES',
    more.error === undefined && more.scrollback && more.alone && more.carded && more.panesShown, JSON.stringify(more));
  }

  if (await stage('games')) {
  // The games shelf (#892): `help games` is the session's page, the toys
  // run in the kernel so a pipe of builtins works in a browser, and a
  // segment the browser cannot run is refused in words rather than hung.
  const games = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120); await console_settled(); await console_idle(); };
    const text = () => console_text();
    const after = (cmd) => { const t = text(); return t.slice(t.lastIndexOf('❯ ' + cmd) + cmd.length + 2).trim(); };
    await say('help games'); const page = after('help games');
    await say('fortune | cowsay'); const cow = after('fortune | cowsay');
    await say('figlet HI | rev'); const big = after('figlet HI | rev');
    // wc, head, tail, sort, uniq and cut are the kernel's own and run on
    // every surface; tr is the host's, which a browser cannot run.
    await say('fortune | tr a-z A-Z'); const refused = after('fortune | tr a-z A-Z');
    await say('ls /usr/games'); const shelf = after('ls /usr/games');
    await say('wtf is lonk'); const wtf = after('wtf is lonk');
    await say('who'); const who = after('who');
    await say('qr hi'); const qr = after('qr hi');
    await say('say hello there'); const said = after('say hello there');
    await say('pom'); const pom = after('pom');
    await say('timer 2s the kettle'); const timerSet = after('timer 2s the kettle');
    let chimed = ''; for (let i = 0; i < 20; i++) { await sleep(300); if (/🔔 the kettle/.test(text())) { chimed = 'yes'; break; } }
    // A terminal plays a showpiece in place: the game has the screen and
    // the keys (the console reads playing), q gives them back, no pane opens.
    let inPlace = null;
    if (terminal_mode()) {
      window.__argusConsole.type('sl\\r');
      let playing = false; for (let i = 0; i < 40 && !playing; i++) { await sleep(250); playing = document.getElementById('terminal')?.dataset.terminalState === 'playing'; }
      const paneWhile = [...document.querySelectorAll('.pane-games')].some((p) => p.offsetParent !== null);
      window.__argusConsole.type('q');
      let back = false; for (let i = 0; i < 40 && !back; i++) { await sleep(250); back = console_quiet(); }
      inPlace = { playing, paneWhile, back };
    }
    // --pane: a still in the console, the moving one on a GAMES pane; a game
    // takes the keyboard, Esc gives it back, a second program reuses the pane.
    await say('sl --pane'); const slNote = after('sl --pane');
    const gamesPane = () => [...document.querySelectorAll('.pane-games')].find((p) => p.offsetParent !== null);
    for (let i = 0; i < 40; i++) { await sleep(250); if (gamesPane()) break; }
    const slPane = gamesPane();
    const slDrawn = slPane ? { canvas: slPane.querySelector('.games-canvas') !== null, state: slPane.querySelector('.pane-state')?.textContent ?? '', controlsInField: slPane.querySelector('.games-field button') !== null } : null;
    await say('tetris --pane'); await sleep(600);
    const panes = [...document.querySelectorAll('.pane-games')].filter((p) => p.offsetParent !== null).length;
    const tetrisPane = gamesPane();
    const focused = tetrisPane ? tetrisPane.classList.contains('games-field-focused') && tetrisPane.querySelector('.games-field').contains(document.activeElement) : false;
    const tetrisState = tetrisPane?.querySelector('.pane-state')?.textContent ?? '';
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200);
    const released = tetrisPane ? !tetrisPane.classList.contains('games-field-focused') && !tetrisPane.querySelector('.games-field').contains(document.activeElement) : false;
    tetrisPane?.querySelector('.games-pause')?.click(); await sleep(100);
    const paused = tetrisPane?.querySelector('.pane-state')?.textContent ?? '';
    tetrisPane?.querySelector('.drawer-close')?.click(); await sleep(400);
    const closed = gamesPane() === undefined;
    // A game by question: hangman asks in the console (the glyph turns ?);
    // the answer goes down the same input. Not through say(): console_idle
    // presses Escape at an open question, which is an answer of its own.
    input.value = 'hangman'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    let asked = false; for (let i = 0; i < 40; i++) { await sleep(250); if (console_asking()) { asked = true; break; } }
    const gallows = asked && text().includes('+---+');
    input.value = 'q'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300);
    // The answer resumes the command once it has its turn again: wait for its word, not a guess.
    for (let i = 0; i < 80 && !/the word was/.test(after('hangman')); i++) await sleep(250);
    await console_idle();
    const hanged = after('hangman');
    return { pom: pom.slice(0, 80), timerSet: timerSet.slice(0, 80), chimed, page: page.slice(0, 2000), cow: cow.slice(0, 2000), big: big.slice(0, 200), refused: refused.slice(0, 200), shelf: shelf.slice(0, 800), wtf: wtf.slice(0, 200), who: who.slice(0, 300), qr: qr.slice(0, 400), said: said.slice(0, 80),
      slNote: slNote.slice(0, 900), slDrawn, inPlace, panes, focused, tetrisState, released, paused, closed, gallows, hanged: hanged.match(/the word was [a-z]+/)?.[0] ?? hanged.slice(-120) };`);
  check('help games lists the shelf by category, and ls /usr/games walks it',
    /Text toys/.test(games.page) && /cowsay/.test(games.page) && /Time and sky/.test(games.page) && /cowsay/.test(games.shelf) && /fortune/.test(games.shelf), JSON.stringify({ page: games.page.slice(0, 120), shelf: games.shelf.slice(0, 120) }));
  check('fortune | cowsay runs in the kernel, brain and all; builtins chain',
    /\(\(\(\)\)\)/.test(games.cow) && /^[<(\/|] .+ [>)\\|]$/m.test(games.cow) && games.big.length > 0 && !/not found|error/i.test(games.big), JSON.stringify({ cow: games.cow.slice(0, 160), big: games.big.slice(0, 80) }));
  check('a pipe segment the browser cannot run is refused in words, not hung',
    /cannot run pipeline segments/.test(games.refused), games.refused.slice(0, 160));
  check('time and sky: pom names the moon; a 2-second timer chimes into the console',
    /Moon is/.test(games.pom) && /^timer \d+ set/.test(games.timerSet) && games.chimed === 'yes', JSON.stringify({ pom: games.pom.slice(0, 40), timerSet: games.timerSet.slice(0, 40), chimed: games.chimed }));
  check('the lab\'s own: wtf knows LONK, who sees this browser, qr draws blocks, say prints the words',
    /Light Oxidicom NotifiKations/.test(games.wtf) && /browser/.test(games.who) && /\(you\)/.test(games.who) && /█/.test(games.qr) && /♪ hello there/.test(games.said),
    JSON.stringify({ wtf: games.wtf.slice(0, 60), who: games.who.slice(0, 80), qr: games.qr.slice(0, 30), said: games.said }));
  if (games.inPlace !== null) check('a terminal plays sl in place: the game has the screen, no pane opens, q gives the prompt back',
    games.inPlace.playing && !games.inPlace.paneWhile && games.inPlace.back, JSON.stringify(games.inPlace));
  check('sl --pane prints a still and opens a GAMES pane with a canvas and no control in its field',
    /sl: ARGUS draws it in its GAMES pane/.test(games.slNote) && games.slDrawn?.canvas === true && games.slDrawn?.controlsInField === false && /SL/.test(games.slDrawn?.state ?? ''),
    JSON.stringify({ note: games.slNote.slice(0, 120), drawn: games.slDrawn }));
  check('tetris reuses the pane on stage, takes the keyboard, Esc gives it back, PAUSE reads on the bar, CLOSE closes',
    games.panes === 1 && games.focused && /TETRIS/.test(games.tetrisState) && games.released && /PAUSED/.test(games.paused) && games.closed,
    JSON.stringify({ panes: games.panes, focused: games.focused, state: games.tetrisState, released: games.released, paused: games.paused, closed: games.closed }));
  check('hangman asks in the console and q gives the word up',
    games.gallows && /the word was [a-z]+/.test(games.hanged), JSON.stringify({ gallows: games.gallows, hanged: games.hanged.slice(0, 80) }));
  }

  if (await stage('trek-bridge')) {
  // The trek bridge (#1157): `trek` on the command line of either console
  // (and typed at the transcript) is a program that takes the screen and
  // gives it back. The bridge plays the game through the engine's own
  // prompts from controls lit by the question, is heard by rule through
  // the page's voice, and LEAVE BRIDGE (Esc asks first) ends the game as
  // end of input, the console returning READY.
  const trek = await evalIn(`
    await console_idle();
    const input = console_input();
    const until = async (read, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (read()) return true; await sleep(150); } return false; };
    // a sector of the scan is an SVG cell (role button), which has no click(): it is pressed as a pointer presses it
    const click = (sel) => { const b = document.querySelector(sel); if (!b) return false; if (typeof b.click === 'function') b.click(); else b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; };
    const q = (sel) => document.querySelector(sel);
    const label = (name) => [...document.querySelectorAll('.tb-head-label')].find((l) => l.textContent === name)?.nextElementSibling?.textContent ?? null;
    // Under a terminal the line goes down the command line (the LANG capsule, prefix-:), where the
    // surface's trek subject takes it; the transcript takes it from its own input. Not through
    // say(): the line does not return its prompt until the game ends.
    let entry = 'transcript';
    if (terminal_mode()) {
      entry = 'command line';
      const pill = document.getElementById('lang-pill');
      if (document.getElementById('lang-palette').hidden) { pill.click(); await sleep(150); }
      const li = document.getElementById('lang-input'); li.value = 'trek --seed 42';
      li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else {
      input.value = 'trek --seed 42'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    const opened = await until(() => q('#trek-bridge') !== null && document.body.dataset.takeover === 'trek');
    const paletteClosed = document.getElementById('lang-palette').hidden;
    const hidden = [...document.body.children].filter((el) => el.id !== 'trek-bridge').every((el) => getComputedStyle(el).visibility === 'hidden');
    // setup: the strip asks the length and the skill; the command pills stay dimmed until Command:
    const lengthAsked = await until(() => !q('.tb-ask')?.hidden && /length/i.test(q('.tb-ask-text')?.textContent ?? ''));
    const dimmedBefore = q('[data-command="move"]')?.disabled === true;
    const beforePress = window.__argusTrek.question();
    click('[data-command="move"]');
    const dimmedPressed = window.__argusTrek.question() === beforePress;
    click('.tb-ask .tb-choice');
    await until(() => /skill/i.test(q('.tb-ask-text')?.textContent ?? ''));
    click('.tb-ask .tb-choice');
    const commandReady = await until(() => q('[data-command="move"]')?.disabled === false);
    const drawn = { condition: q('.tb-condition-name')?.textContent ?? '', sectors: document.querySelectorAll('.tb-sector').length, ship: document.querySelectorAll('.tb-sector-ship').length, quadrants: document.querySelectorAll('.tb-quadrant').length, score: label('SCORE') };
    // a move: MOVE lights the wheel; a sector pressed points it; SET COURSE; the distance (quadrants) lit; ENGAGE
    const stardate1 = label('STARDATE');
    click('[data-command="move"]');
    const wheelLit = await until(() => q('.tb-station-helm .tb-wheel')?.classList.contains('tb-lit'));
    const asksCourse = window.__argusTrek.question();
    const here = window.__argusTrek.readout().position.sector;
    click('.tb-sector[data-x="' + here.x + '"][data-y="' + (here.y === 0 ? 2 : 0) + '"]');
    click('.tb-station-helm .tb-wheel .tb-commit');
    const distanceLit = await until(() => q('#tb-distance')?.closest('.tb-slider')?.classList.contains('tb-lit'));
    const distanceValue = Number(q('#tb-distance')?.value);
    q('#tb-distance').closest('.tb-slider').querySelector('.tb-commit').click();
    const moved = await until(() => label('STARDATE') !== stardate1, 30000);
    const since = q('.tb-head-since')?.textContent ?? '';
    // the views: the gutter changes the body, a station view is drawn large, the computer answers through the engine
    click('[data-view="helm"]');
    const helmView = q('.tb-body')?.dataset.view === 'helm' && q('.tb-view-helm .tb-wheel-face')?.getAttribute('width') === '260';
    click('[data-view="engineering"]');
    const engineeringRows = document.querySelectorAll('.tb-view-engineering .tb-dc-name').length;
    click('[data-view="computer"]');
    click('[data-request="s"]');
    const scored = await until(() => /TOTAL/.test(q('.tb-computer-answer')?.textContent ?? ''), 20000);
    await until(() => q('[data-command="move"]')?.disabled === false);
    click('[data-view="bridge"]');
    // the voice: the bank and its models fetched, cues played, oscillators started
    await sleep(600);
    const voice = window.__argusTrek.heard().voice;
    const heard = window.__argusTrek.heard();
    // leaving: Esc asks, STAY stays, LEAVE ends the game as end of input; ARGUS comes back and the console returns READY
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const leaveAsked = await until(() => q('.tb-leave-ask')?.hidden === false);
    click('.tb-leave-ask .tb-pill:not(.tb-grave)');
    const stayed = q('.tb-leave-ask')?.hidden === true && q('#trek-bridge') !== null;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => q('.tb-leave-ask')?.hidden === false);
    click('.tb-leave-ask .tb-grave');
    const closed = await until(() => q('#trek-bridge') === null && document.body.dataset.takeover === undefined, 20000);
    const restored = [...document.body.children].every((el) => getComputedStyle(el).visibility !== 'hidden' || el.hidden || el.offsetParent === null || getComputedStyle(el).display === 'none');
    await console_idle();
    const tail = console_text().slice(-400);
    return { entry, paletteClosed, opened, hidden, lengthAsked, dimmedBefore, dimmedPressed, commandReady, drawn, wheelLit, asksCourse, distanceLit, distanceValue, moved, since: since.slice(0, 160), helmView, engineeringRows, scored, voice, heard: { events: heard.events, states: heard.states, lastError: heard.lastError }, leaveAsked, stayed, closed, restored, tail, asking: console_asking() };`);
  check('trek takes the screen and gives it back: the page hides behind the bridge, Esc asks, STAY stays, LEAVE ends the game, the console returns READY',
    trek.opened && trek.hidden && trek.paletteClosed && trek.leaveAsked && trek.stayed && trek.closed && trek.restored && !trek.asking && !/cannot ask here/.test(trek.tail),
    JSON.stringify({ entry: trek.entry, paletteClosed: trek.paletteClosed, opened: trek.opened, hidden: trek.hidden, leaveAsked: trek.leaveAsked, stayed: trek.stayed, closed: trek.closed, restored: trek.restored, asking: trek.asking, tail: trek.tail.slice(-160) }));
  check("the bridge answers the engine's own prompts from lit controls, and a dimmed pill presses nothing",
    trek.lengthAsked && trek.dimmedBefore && trek.dimmedPressed && trek.commandReady && trek.wheelLit && trek.asksCourse === 'course' && trek.distanceLit && trek.moved,
    JSON.stringify({ lengthAsked: trek.lengthAsked, dimmedBefore: trek.dimmedBefore, dimmedPressed: trek.dimmedPressed, commandReady: trek.commandReady, wheelLit: trek.wheelLit, asksCourse: trek.asksCourse, distanceLit: trek.distanceLit, moved: trek.moved }));
  check('the bridge draws the state the engine shows: the condition, 100 sectors with one ship, the 64-quadrant chart, the score; a pressed sector is a tenth of a quadrant',
    /GREEN|YELLOW|RED|DOCKED/.test(trek.drawn.condition) && trek.drawn.sectors === 100 && trek.drawn.ship === 1 && trek.drawn.quadrants === 64 && /^-?\d+$/.test(trek.drawn.score ?? '') && trek.distanceValue > 0 && trek.distanceValue < 1 && trek.heard.states >= 2 && trek.heard.lastError === null && /STARDATE/.test(trek.since),
    JSON.stringify({ drawn: trek.drawn, distanceValue: trek.distanceValue, heard: trek.heard, since: trek.since.slice(0, 80) }));
  check('the gutter changes the view: HELM draws its station large, ENGINEERING every device, COMPUTER answers SCORE through the engine',
    trek.helmView && trek.engineeringRows >= 14 && trek.scored, JSON.stringify({ helmView: trek.helmView, engineeringRows: trek.engineeringRows, scored: trek.scored }));
  check("the bridge is heard through the page's voice: the bank and every model fetched, none missing, cues played, oscillators started",
    trek.voice !== undefined && trek.voice.loaded >= 60 && trek.voice.missing === 0 && trek.voice.played >= 8 && trek.voice.voices > 0, JSON.stringify(trek.voice));
  }

  if (await stage('trek-motion')) {
  // The moving bridge (#1172): nothing on the screen moves without an
  // engine line or a change of state behind it. On seed 13 a Klingon sits
  // in the start quadrant: the standing order fills the long-range scan at
  // the first prompt, a torpedo flies the printed track point by point and
  // the kill bursts when its line arrives, the frames played are counted
  // against the log's lines kind by kind, the Klingon wears one mark on the
  // scan, the wheel and its target pill, and a view pill pressed during a
  // quadrant crossing lands the picture at its end at once.
  const motion = await evalIn(`
    await console_idle();
    const input = console_input();
    const until = async (read, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (read()) return true; await sleep(100); } return false; };
    const click = (sel) => { const b = document.querySelector(sel); if (!b) return false; if (typeof b.click === 'function') b.click(); else b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; };
    const q = (sel) => document.querySelector(sel);
    const frames = () => window.__argusTrek.frames();
    const idle = async (ms = 30000) => until(() => !frames().busy && q('[data-command="move"]')?.disabled === false, ms);
    const logLines = () => [...document.querySelectorAll('.tb-log .tb-log-line')].map((l) => l.textContent ?? '');
    if (terminal_mode()) {
      const pill = document.getElementById('lang-pill');
      if (document.getElementById('lang-palette').hidden) { pill.click(); await sleep(150); }
      const li = document.getElementById('lang-input'); li.value = 'trek --seed 13';
      li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else {
      input.value = 'trek --seed 13'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    const opened = await until(() => q('#trek-bridge') !== null);
    await until(() => !q('.tb-ask')?.hidden && /length/i.test(q('.tb-ask-text')?.textContent ?? ''));
    click('.tb-ask .tb-choice');
    await until(() => /skill/i.test(q('.tb-ask-text')?.textContent ?? ''));
    click('.tb-ask .tb-choice');
    const ready = await idle();
    // the standing order: the first prompt answered with the engine's own l, the scan's lines folded, the long-range cells filled
    const standing = { fold: q('.tb-log-fold .tb-log-fold-head')?.textContent ?? null, scanned: document.querySelectorAll('.tb-lrs-cell:not(.tb-unscanned):not(.tb-lrs-edge)').length, edge: document.querySelectorAll('.tb-lrs-cell.tb-lrs-edge').length };
    // one mark per Klingon, everywhere it is drawn
    const scanMark = q('.tb-sector-klingon use')?.getAttribute('href') ?? null;
    const wheelMark = q('.tb-station-tactical .tb-wheel-marks .tb-wheel-mark-klingon use')?.getAttribute('href') ?? null;
    const pillMark = q('.tb-station-tactical .tb-target use')?.getAttribute('href') ?? null;
    const ring = q('.tb-scan .tb-ring')?.dataset.percent ?? null;
    // a torpedo at the Klingon: its sector pressed sets the firing course, no burst
    const klingon = window.__argusTrek.readout().klingons[0];
    const before = frames().played;
    click('[data-command="torpedo"]');
    await until(() => q('.tb-station-tactical .tb-wheel')?.classList.contains('tb-lit'));
    click('.tb-sector[data-x="' + klingon.x + '"][data-y="' + klingon.y + '"]');
    click('.tb-station-tactical .tb-wheel .tb-commit');
    await until(() => /burst/i.test(window.__argusTrek.prompt() ?? ''));
    click('.tb-station-tactical .tb-pillrow .tb-choice[data-line="n"]');
    const flew = await until(() => q('.tb-photon') !== null, 8000);
    const fired = await idle();
    const played = frames().played;
    const lines = logLines();
    // the frames played against the lines printed, kind by kind
    const count = (re) => lines.filter((l) => re.test(l)).length;
    const printed = {
      'torpedo-head': count(/^Torpedo track(, torpedo number \\d+)?:/), 'torpedo-point': count(/^\\s*\\d+\\.\\d\\s+\\d+\\.\\d\\s*$/), 'torpedo-end': count(/^Torpedo missed|^Torpedo disappears/),
      'kill': count(/\\*\\*\\* Klingon at \\d+,\\d+ destroyed|^Starbase at \\d+,\\d+ destroyed|^Inhabited starsystem .* destroyed|^Unknown object . at \\d+,\\d+ destroyed/), 'nova': count(/Star at \\d+,\\d+ gone nova/),
      'misfire': count(/^Photon tubes misfire/), 'phaser': count(/^\\d+ unit hit on Klingon at/), 'incoming': count(/^HIT: \\d+ units/),
      'klingon-move': count(/^Klingon at \\d+,\\d+ moves to/), 'klingon-escape': count(/^Klingon at \\d+,\\d+ escapes to quadrant/), 'supernova': count(/RED ALERT: supernova occurring/), 'supernova-report': count(/Caution is advised/),
    };
    const unmatched = Object.entries(played).filter(([kind, n]) => !['line', 'state', 'fold'].includes(kind) && printed[kind] !== n).map(([kind, n]) => kind + ':' + n + '/' + (printed[kind] ?? 'none'));
    const trackFrames = (played['torpedo-point'] ?? 0) - (before['torpedo-point'] ?? 0);
    const killLine = lines.findIndex((l) => /\\*\\*\\* Klingon at \\d+,\\d+ destroyed/.test(l));
    const lastPoint = lines.reduce((at, l, i) => (/^\\s*\\d+\\.\\d\\s+\\d+\\.\\d\\s*$/.test(l) ? i : at), -1);
    const klingonsDrawn = document.querySelectorAll('.tb-sector-klingon').length;
    const klingonsState = window.__argusTrek.readout().klingons.length;
    const motionLeft = document.querySelectorAll('.tb-motion').length;
    // a move west that crosses the quadrant line, cut short by a view pill: the picture lands at once
    const quadrantBefore = window.__argusTrek.readout().position.quadrant;
    const here = window.__argusTrek.readout().position.sector;
    click('[data-command="move"]');
    await until(() => q('.tb-station-helm .tb-wheel')?.classList.contains('tb-lit'));
    click('.tb-sector[data-x="' + here.x + '"][data-y="' + Math.max(0, here.y - 1) + '"]');
    click('.tb-station-helm .tb-wheel .tb-commit');
    await until(() => q('#tb-distance')?.closest('.tb-slider')?.classList.contains('tb-lit'));
    const slider = q('#tb-distance'); slider.value = String(((here.y + 2) / 10).toFixed(1)); slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.closest('.tb-slider').querySelector('.tb-commit').click();
    const sliding = await until(() => q('.tb-motion-slide') !== null, 30000);
    const pressedAt = Date.now();
    click('[data-view="helm"]');
    const landed = await until(() => !frames().busy && q('.tb-motion') === null, 5000);
    const skipMs = Date.now() - pressedAt;
    await idle();
    const quadrantAfter = window.__argusTrek.readout().position.quadrant;
    click('[data-view="bridge"]');
    const title = q('.tb-srs-section .tb-title')?.textContent ?? '';
    const logWhole = logLines().filter((l) => /^HIT:|moves to|escapes to|Starsystem/.test(l)).length;
    // leave
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => q('.tb-leave-ask')?.hidden === false);
    click('.tb-leave-ask .tb-grave');
    const closed = await until(() => q('#trek-bridge') === null && document.body.dataset.takeover === undefined, 20000);
    await console_idle();
    return { opened, ready, standing, scanMark, wheelMark, pillMark, ring, flew, fired, played, printed, unmatched, trackFrames, killLine, lastPoint, klingonsDrawn, klingonsState, motionLeft, quadrantBefore, quadrantAfter, sliding, landed, skipMs, title, logWhole, closed, asking: console_asking() };`);
  check("a frame replays a printed line: every torpedo point, kill, nova, move and hit the picture played is a line in the log, and the track's frames are the printed points",
    motion.flew && motion.fired && motion.unmatched.length === 0 && motion.trackFrames > 0 && motion.trackFrames === motion.printed['torpedo-point'] && motion.killLine > motion.lastPoint && motion.klingonsDrawn === motion.klingonsState && motion.motionLeft === 0,
    JSON.stringify({ flew: motion.flew, fired: motion.fired, unmatched: motion.unmatched, trackFrames: motion.trackFrames, printed: motion.printed, played: motion.played, killLine: motion.killLine, lastPoint: motion.lastPoint, klingonsDrawn: motion.klingonsDrawn, klingonsState: motion.klingonsState, motionLeft: motion.motionLeft }));
  check('the standing order fills the long-range scan at the first prompt, and the marks are one table: the Klingon wears the same mark on the scan, the wheel and its target pill',
    motion.ready && /^LONG RANGE SCAN · STANDING ORDER/.test(motion.standing.fold ?? '') && motion.standing.scanned >= 5 && motion.standing.edge === 3 && motion.scanMark !== null && motion.scanMark === motion.wheelMark && motion.scanMark === motion.pillMark && motion.ring !== null,
    JSON.stringify({ ready: motion.ready, standing: motion.standing, scanMark: motion.scanMark, wheelMark: motion.wheelMark, pillMark: motion.pillMark, ring: motion.ring }));
  check('a press that acts skips the picture to its end: a view pill during a crossing lands the ship in the new quadrant at once, the log whole',
    motion.sliding && motion.landed && motion.skipMs < 1500 && (motion.quadrantAfter.x !== motion.quadrantBefore.x || motion.quadrantAfter.y !== motion.quadrantBefore.y) && motion.title.includes(motion.quadrantAfter.x + ',' + motion.quadrantAfter.y) && motion.logWhole >= 1 && motion.closed && !motion.asking,
    JSON.stringify({ sliding: motion.sliding, landed: motion.landed, skipMs: motion.skipMs, quadrantBefore: motion.quadrantBefore, quadrantAfter: motion.quadrantAfter, title: motion.title, logWhole: motion.logWhole, closed: motion.closed, asking: motion.asking }));
  }

  if (await stage('notes')) {
  // What's new (#897): the kernel's notes in the console and as NEWS; the
  // dashboard's WHAT'S NEW block naming the installed release; the NOTES
  // pane on the listing façade, a headline's rest unfolding on a press.
  const notes = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120); await console_settled(); await console_idle(); };
    const text = () => console_text();
    const after = (cmd) => { const t = text(); return t.slice(t.lastIndexOf('❯ ' + cmd) + cmd.length + 2).trim(); };
    await say('notes'); const typed = after('notes');
    await say('help notes'); const helped = after('help notes');
    await say('cat /usr/share/doc/NEWS'); const news = after('cat /usr/share/doc/NEWS');
    await say('notes --since soon'); const refused = after('notes --since soon');
    // The dashboard block, then the pane it opens, alone on the stage.
    document.getElementById('gutter-dashboard')?.click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelectorAll('.launcher-tile').length > 0) break; }
    const tile = [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === "WHAT'S NEW");
    const figures = tile ? [...tile.querySelectorAll('.launcher-figure')].map((f) => f.textContent.trim()) : [];
    const tileRows = tile ? tile.querySelectorAll('.launcher-row').length : 0;
    tile?.querySelector('.launcher-verb')?.click();
    const pane = () => [...document.querySelectorAll('.pane-notes')].find((p) => p.offsetParent !== null);
    for (let i = 0; i < 40; i++) { await sleep(250); if (pane() && pane().querySelectorAll('.notes-row').length > 0) break; }
    const alone = [...document.querySelectorAll('#layout-root .workspace-pane')].filter((p) => p.offsetParent !== null).map((p) => (p.className.match(/pane-(files|help|notes|dag|universe|pacs|launcher)/) ?? [])[1] ?? '?');
    const heads = pane() ? [...pane().querySelectorAll('.notes-block-head')].map((h) => h.textContent.trim()) : [];
    const rows = pane() ? pane().querySelectorAll('.notes-row:not(.notes-row-body)').length : 0;
    const bar = pane()?.querySelector('.pane-state')?.textContent ?? '';
    // A headline with more unfolds its rest on a press, and folds it on the next.
    const more = pane()?.querySelector('.notes-row-more');
    more?.querySelector('.notes-text')?.click(); await sleep(400);
    const unfolded = pane()?.querySelectorAll('.notes-row-body').length ?? 0;
    more?.querySelector('.notes-text')?.click(); await sleep(400);
    const refolded = pane()?.querySelectorAll('.notes-row-body').length ?? 0;
    // LAST 5 RELEASES asks the kernel again and the blocks grow.
    pane()?.querySelector('.notes-since')?.click();
    let grown = 0; for (let i = 0; i < 40; i++) { await sleep(250); grown = pane()?.querySelectorAll('.notes-block-head').length ?? 0; if (grown > heads.length) break; }
    const sincePill = pane()?.querySelector('.notes-since')?.textContent ?? '';
    // Typed from the console: a second ask focuses the pane that is there.
    document.getElementById('gutter-console').click(); await sleep(400);
    await say('notes pane'); const again = after('notes pane');
    const panes = [...document.querySelectorAll('.pane-notes')].filter((p) => p.offsetParent !== null).length;
    pane()?.querySelector('.drawer-close')?.click(); await sleep(400);
    document.getElementById('header-restore')?.click(); await sleep(600);
    return { typed: typed.slice(0, 300), helped: helped.slice(0, 120), news: news.slice(0, 200), refused: refused.slice(0, 120), figures, tileRows, alone, heads, rows, bar, unfolded, refolded, grown, sincePill, again: again.slice(0, 80), panes };`);
  check('notes, help notes and NEWS say what the installed releases changed, and a bad --since is refused by name',
    /^\d{4}-\d{2}-\d{2} · /.test(notes.typed) && /argus\s+\S/.test(notes.typed) && notes.helped.slice(0, 10) === notes.typed.slice(0, 10) && /^\d{4}-\d{2}-\d{2} · /.test(notes.news) && /--since wants a count or a date/.test(notes.refused),
    JSON.stringify({ typed: notes.typed.slice(0, 80), news: notes.news.slice(0, 60), refused: notes.refused.slice(0, 60) }));
  check("the dashboard's WHAT'S NEW block names the installed release and its first headlines",
    notes.figures.length === 2 && /^\d{4}-\d{2}-\d{2}$|AFTER RESTART/.test(notes.figures[0]) && /CHANGES?$/.test(notes.figures[1]) && notes.tileRows >= 1,
    JSON.stringify({ figures: notes.figures, rows: notes.tileRows }));
  check('the NOTES pane opens alone from the dashboard: a block per release, a row per headline, the bar naming the release read',
    notes.alone.join(',') === 'notes' && notes.heads.length >= 1 && /^\d{4}-\d{2}-\d{2} · /.test(notes.heads[0] ?? '') && notes.rows >= 1 && /^DAEMON · /.test(notes.bar),
    JSON.stringify({ alone: notes.alone, heads: notes.heads.slice(0, 2), rows: notes.rows, bar: notes.bar }));
  check('a headline with more unfolds its rest on a press and folds on the next; LAST 5 RELEASES asks the kernel again',
    notes.unfolded === 1 && notes.refolded === 0 && notes.grown > notes.heads.length && /LAST 5/.test(notes.sincePill),
    JSON.stringify({ unfolded: notes.unfolded, refolded: notes.refolded, grown: notes.grown, was: notes.heads.length, pill: notes.sincePill }));
  check('notes pane typed again focuses the pane on stage rather than opening another',
    /on stage/.test(notes.again) && notes.panes === 1, JSON.stringify({ again: notes.again, panes: notes.panes }));
  }

  if (await stage('listing-columns')) {
  // On a files listing (NAME is the expanse, on the left) every boundary
  // follows the hand: dragging a grip 24 px right moves that boundary 24 px
  // right and leaves the column after the next one where it was. The first
  // build moved the column away from the hand and the NAME boundary did
  // nothing (the operator, 2026-10-06).
  const follows = await evalIn(`
    await console_idle();
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    for (let i = 0; i < 40; i++) { await sleep(250); if (fp.querySelectorAll('.files-row').length > 1) break; }
    const caps = () => [...fp.querySelectorAll('.roster-order .roster-cap')];
    const out = [];
    for (let i = 0; i < caps().length - 1; i++) {
      const cap = caps()[i]; const grip = cap.querySelector('.roster-grip'); if (!grip) continue;
      const before = cap.getBoundingClientRect().right;
      const farEdge = caps()[i + 2]?.getBoundingClientRect().left ?? null;
      const r = grip.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 7 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 24, clientY: y, pointerId: 7 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 24, clientY: y, pointerId: 7 }));
      await sleep(120);
      const after = caps()[i].getBoundingClientRect().right;
      const farAfter = caps()[i + 2]?.getBoundingClientRect().left ?? null;
      const capsRow = fp.querySelector('.roster-order .roster-caps');
      out.push({ key: cap.dataset.key, moved: Math.round(after - before), farMoved: farEdge === null ? null : Math.round(farAfter - farEdge), overflowing: capsRow.scrollWidth > capsRow.clientWidth + 1 });
    }
    fp.querySelector('.files-columns')?.click(); await sleep(200);
    return out;`);
  // Where the row fits, the two columns beside the grip trade and nothing
  // beyond them moves; where it is already wider than the pane (a tablet),
  // the column grows and everything after it shifts with the hand.
  check('on a files listing every grip moves its own boundary with the hand, and nothing beyond the next column moves unless the row overflows',
    follows.length >= 2 && follows.every((b) => Math.abs(b.moved - 24) <= 2 && (b.farMoved === null || (b.overflowing ? Math.abs(b.farMoved - 24) <= 2 : Math.abs(b.farMoved) <= 2))),
    JSON.stringify(follows));
  // Columns sized by hand: a grip on a cap's edge drags the column within
  // its floor, the expanse takes the difference, the COLUMNS block reads
  // SIZED, a reload keeps it on this device, a double-press gives one back
  // and the block gives all back.
  const cols = await evalIn(`
    await console_idle();
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60; i++) { await sleep(400); if (document.querySelectorAll('.feedlist-row').length > 3) break; }
    const dp = () => [...document.querySelectorAll('.pane-dag')].find((p) => p.offsetParent !== null);
    const cap = (key) => dp().querySelector('.roster-order .roster-cap[data-key="' + key + '"]');
    const w = (key) => Math.round(cap(key)?.getBoundingClientRect().width ?? 0);
    const block = () => dp().querySelector('.runs-columns');
    const before = { title: w('title'), progress: w('progress'), owner: w('owner'), block: block()?.textContent ?? null };
    // Drag the TITLE grip 80px to the right.
    const grip = cap('title')?.querySelector('.roster-grip');
    const r = grip.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
    grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 80, clientY: y, pointerId: 1 }));
    grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 80, clientY: y, pointerId: 1 }));
    await sleep(200);
    const dragged = { title: w('title'), progress: w('progress'), owner: w('owner'), block: block()?.textContent ?? null, stored: localStorage.getItem('argus.columns.runs.title') };
    // The sort did not fire from the grip's press.
    const sortedBy = dp().querySelector('.roster-cap.roster-active')?.dataset.key ?? null;
    // A double-press on the grip gives TITLE back.
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(200);
    const reset = { title: w('title'), block: block()?.textContent ?? null, stored: localStorage.getItem('argus.columns.runs.title') };
    // Size OWNER, then the block gives all back.
    const ownerGrip = cap('owner')?.querySelector('.roster-grip');
    const r2 = ownerGrip.getBoundingClientRect(); const x2 = r2.left + r2.width / 2; const y2 = r2.top + r2.height / 2;
    ownerGrip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x2, clientY: y2, button: 0, pointerId: 2 }));
    ownerGrip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x2 + 40, clientY: y2, pointerId: 2 }));
    ownerGrip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x2 + 40, clientY: y2, pointerId: 2 }));
    await sleep(200);
    const ownerSized = { owner: w('owner'), block: block()?.textContent ?? null };
    block()?.click(); await sleep(200);
    const all = { owner: w('owner'), block: block()?.textContent ?? null, stored: localStorage.getItem('argus.columns.runs.owner') };
    const lastHasGrip = [...dp().querySelectorAll('.roster-order .roster-cap')].pop()?.querySelector('.roster-grip') !== null;
    return { before, dragged, sortedBy, reset, ownerSized, all, lastHasGrip };`);
  // Where PROGRESS has room (the desk) the TITLE boundary follows the 80 px
  // drag; where it is already at its minimum (a tablet, the row wider than
  // the pane) there is nothing to give, and the boundary stays put rather
  // than move against the hand.
  const roomy = cols.before.progress > 260;
  check('a drag on a cap\'s grip sizes the column; the expanse gives the difference; the block reads SIZED; the device remembers',
    (roomy
      ? cols.dragged.title >= cols.before.title + 70 && cols.dragged.progress <= cols.before.progress - 70 && /SIZED/.test(cols.dragged.block ?? '') && cols.dragged.stored !== null
      : cols.dragged.title >= cols.before.title && Math.abs(cols.dragged.progress - cols.before.progress) <= 2)
    && cols.dragged.owner === cols.before.owner && cols.sortedBy !== 'title',
    JSON.stringify({ before: cols.before, dragged: cols.dragged, sortedBy: cols.sortedBy }));
  check('a double-press on the grip gives the column back; COLUMNS gives them all back; the last cap has no grip',
    cols.reset.title === cols.before.title && cols.reset.stored === null && !/SIZED/.test(cols.reset.block ?? '') && cols.ownerSized.owner >= cols.before.owner + 30 && /SIZED/.test(cols.ownerSized.block ?? '') && cols.all.owner === cols.before.owner && cols.all.stored === null && !/SIZED/.test(cols.all.block ?? '') && cols.lastHasGrip === false,
    JSON.stringify({ reset: cols.reset, ownerSized: cols.ownerSized, all: cols.all, lastHasGrip: cols.lastHasGrip }));
  }

  if (await stage('help-pane')) {
  // Help lives on the stage: a HELP tile on the dashboard, a HELP pane of
  // the chords and the verbs, and the same tables typed into the console.
  const help = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120); await console_settled(); await console_idle(); };
    const text = () => console_text();
    const after = (cmd) => { const t = text(); return t.slice(t.lastIndexOf('❯ ' + cmd) + cmd.length + 2).trim(); };
    // The order that found #816: a stage whose pane is not in home (UNIVERSE),
    // then the dashboard, then HELP — the spawn must have a host on stage.
    document.getElementById('gutter-dashboard')?.click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelectorAll('.launcher-tile').length > 0) break; }
    [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
    for (let i = 0; i < 60; i++) { await sleep(500); if ([...document.querySelectorAll('.pane-universe')].some((p) => p.offsetParent !== null)) break; }
    document.getElementById('gutter-dashboard')?.click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelectorAll('.launcher-tile').length > 0) break; }
    const tile = [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'KEYS');
    const figures = tile ? [...tile.querySelectorAll('.launcher-figure')].map((f) => f.textContent.trim()) : [];
    tile?.querySelector('.launcher-verb')?.click();
    const pane = () => [...document.querySelectorAll('.pane-help')].find((p) => p.offsetParent !== null);
    for (let i = 0; i < 40; i++) { await sleep(250); if (pane()) break; }
    // From the dashboard the keys stand alone: no file listing beside them,
    // and the dashboard's zoom has given the frame back.
    const alone = [...document.querySelectorAll('#layout-root .workspace-pane')].filter((p) => p.offsetParent !== null).map((p) => (p.className.match(/pane-(files|help|dag|universe|pacs|launcher)/) ?? [])[1] ?? '?');
    const unzoomed = document.body.dataset.zoom === undefined;
    // A block's press opens only what it names: header folded away, console closed.
    const quiet = { header: document.body.dataset.header ?? null, consoleClosed: document.getElementById('drawer').classList.contains('drawer-closed') };
    // The rest of the scenario types into the console: open it as the operator would.
    document.getElementById('gutter-console').click(); await sleep(400);
    // And zoomed from here the console owns the whole page: the header the
    // dashboard folded away does not come back with the zoom (it did — its
    // height was measured mid-glide, a few pixels, so the zoom slid it a few).
    document.querySelector('#console-drawer .drawer-zoom')?.click(); await sleep(1200);
    const consoleZoom = { zoom: document.body.dataset.zoom ?? null, headerBottom: Math.round(document.querySelector('.wrap:not(#gap)').getBoundingClientRect().bottom) };
    document.querySelector('#console-drawer .drawer-zoom')?.click(); await sleep(800);
    // Leave the page as the next scenario expects it: the header back, by its strip.
    document.getElementById('header-restore')?.click(); await sleep(800);
    const rows = pane() ? pane().querySelectorAll('.listing-row').length : 0;
    const keyRows = pane() ? pane().querySelectorAll('.help-row.help-pane').length : 0;
    const verbRows = pane() ? pane().querySelectorAll('.help-row.help-verb').length : 0;
    const chip = pane()?.querySelector('.more-chip') !== null;
    await say('help keys'); const typedKeys = /prefix chords/.test(after('help keys'));
    await say('help verbs'); const typedVerbs = /argus verbs/.test(after('help verbs'));
    await say('help pane'); const again = /on stage/.test(after('help pane'));
    const panes = document.querySelectorAll('.pane-help').length;
    return { tile: tile !== undefined, figures, alone, unzoomed, quiet, consoleZoom, rows, keyRows, verbRows, chip, typedKeys, typedVerbs, again, panes };`);
  check('the dashboard KEYS tile opens the keys alone on the stage: no file listing beside them, the header folded away, the console closed',
    help.tile && help.unzoomed && help.alone.length === 1 && help.alone[0] === 'help' && help.quiet.header === 'away' && help.quiet.consoleClosed,
    JSON.stringify({ alone: help.alone, unzoomed: help.unzoomed, quiet: help.quiet }));
  check('a console zoomed after leaving the dashboard owns the whole page: the header stays off it',
    help.consoleZoom.zoom === 'console' && help.consoleZoom.headerBottom <= 1, JSON.stringify(help.consoleZoom));
  check('the dashboard has a KEYS tile that opens the KEYS pane: the chords and the verbs as a listing',
    help.tile && help.figures.some((f) => /KEYS/.test(f)) && help.rows > 30 && help.keyRows >= 10 && help.verbRows >= 10, JSON.stringify(help));
  check('help keys and help verbs answer in the console; a second help pane focuses the pane on stage rather than opening another',
    help.typedKeys && help.typedVerbs && help.again && help.panes === 1, JSON.stringify(help));
  }

  if (await stage('universe-constellations')) {
    // CONSTELLATIONS: every plugin a ringed star, every feed pulled to the
    // stars it ran. A plugin lit by word shows its facts and its verb, and
    // OPEN IN /BIN opens its graph in the files browser.
    const sky = await evalIn(`
      try {
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { await console_idle(); input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const lastLine = (re) => console_text().split('\\n').map((l) => l.trim()).filter((l) => re.test(l)).slice(-1)[0] ?? '';
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.launcher-tile')) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      const pane = () => [...document.querySelectorAll('.pane-universe')].find((p) => p.offsetParent !== null);
      const settled = () => { const p = pane(); const w = p?.querySelector('.wait-progress'); return /[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden); };
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      await say('universe layout constellations', 1500);
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      const block = pane()?.querySelector('.universe-arrangement')?.textContent.trim() ?? '';
      await say('universe state', 600);
      const scene = lastLine(/^scene: /);
      await say('universe plugin no-such-plugin', 600);
      const refused = lastLine(/^universe plugin/);
      await say('universe plugin pl-dircopy', 1500);
      const lit = lastLine(/^pl-dircopy · |^universe plugin/);
      const facts = pane()?.querySelector('.universe-facts');
      const factsText = facts && !facts.hidden ? facts.textContent : '';
      await say('universe state', 600);
      const litState = lastLine(/^lit: /);
      let opened = { pressed: false, path: '', diagram: false };
      const open = facts?.querySelector('.universe-plugin-open');
      if (open) {
        open.click();
        opened.pressed = true;
        const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
        for (let i = 0; i < 60; i++) { await sleep(500); if (fp()?.querySelector('.files-diagram')) break; }
        opened.path = fp()?.querySelector('.files-content-header span')?.textContent ?? '';
        opened.diagram = !!fp()?.querySelector('.files-diagram');
        opened.console = console_text().split('\\n').filter((l) => l.trim()).slice(-4);
        opened.header = fp()?.querySelector('.files-path')?.textContent.trim() ?? '';
        for (let i = 0; i < 4 && fp()?.querySelector('.files-close-pill'); i++) { fp().querySelector('.files-close-pill').click(); await sleep(400); }
      }
      document.getElementById('gutter-dashboard')?.click(); await sleep(600);
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      await sleep(1000);
      await say('universe plugin off', 800);
      await say('universe layout galaxy', 1500);
      return { block, scene, refused, lit, factsText, litState, opened };
      } catch (err) { return { crash: String(err && err.stack || err) }; }`);
    if (sky.crash) console.log('  CRASH ' + sky.crash);
    check('CONSTELLATIONS is an arrangement of its own, with a ringed star per plugin in the scene',
      sky.block === 'CONSTELLATIONS' && /arrangement=constellations/.test(sky.scene), JSON.stringify({ block: sky.block, scene: sky.scene }));
    check('universe plugin refuses a plugin no feed ran, by name', /no feed here ran no-such-plugin/.test(sky.refused), JSON.stringify(sky.refused));
    if (/no feed here ran/.test(sky.lit)) {
      console.log('  skipped: no feed here ran pl-dircopy');
    } else {
      check('a lit plugin says how many feeds ran it and how much of it failed, and shows its facts and its verb',
        /^pl-dircopy · [\d,]+ feeds? · \d+% errored$/.test(sky.lit) && /PLUGINpl-dircopy/.test(sky.factsText) && /OPEN IN \/BIN/.test(sky.factsText) && sky.litState === 'lit: pl-dircopy',
        JSON.stringify({ lit: sky.lit, facts: sky.factsText, state: sky.litState }));
      check('OPEN IN /BIN opens the plugin\'s graph in the files browser',
        sky.opened.pressed && /^\/bin\/pl-dircopy-v/.test(sky.opened.path) && sky.opened.diagram, JSON.stringify(sky.opened));
    }
  }

  if (await stage('universe-data')) {
    // DATA: every feed hung from what it began from — format, modality,
    // series — each hub a captioned nebula. A feed not yet read hangs from
    // a hub that says so.
    const data = await evalIn(`
      try {
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { await console_idle(); input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const lastLine = (re) => console_text().split('\\n').map((l) => l.trim()).filter((l) => re.test(l)).slice(-1)[0] ?? '';
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.launcher-tile')) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      const pane = () => [...document.querySelectorAll('.pane-universe')].find((p) => p.offsetParent !== null);
      const settled = () => { const p = pane(); const w = p?.querySelector('.wait-progress'); return /[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden); };
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      await say('universe layout data', 1500);
      const said = lastLine(/^every feed hung from|^universe layout/);
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      const block = pane()?.querySelector('.universe-arrangement')?.textContent.trim() ?? '';
      await say('universe state', 600);
      const scene = lastLine(/^scene: /);
      // CAPTIONS is the operator's: pressed off, the words go and the kept
      // choice says so; pressed again, they come back.
      const captions = () => pane()?.querySelector('.universe-captions');
      captions()?.click();
      await say('universe state', 600);
      const off = { block: captions()?.textContent.trim() ?? '', scene: lastLine(/^scene: /), kept: lastLine(/^kept settings: /) };
      captions()?.click();
      await say('universe state', 600);
      const on = { block: captions()?.textContent.trim() ?? '', scene: lastLine(/^scene: /) };
      await say('universe layout galaxy', 1500);
      return { said, block, scene, off, on };
      } catch (err) { return { crash: String(err && err.stack || err) }; }`);
    check('DATA hangs every feed from what it began from, as an arrangement of its own',
      /^every feed hung from what it began from/.test(data.said) && data.block === 'DATA' && /arrangement=hubs/.test(data.scene),
      JSON.stringify(data));
    check('CAPTIONS turns the hubs\' words off and on, and the choice is kept',
      data.off?.block === 'CAPTIONS OFF' && /captions=off/.test(data.off?.scene ?? '') && /"captions":false/.test(data.off?.kept ?? '')
        && data.on?.block === 'CAPTIONS ON' && /captions=[1-9]/.test(data.on?.scene ?? ''),
      JSON.stringify({ off: data.off, on: data.on }));
  }

  if (await stage('universe-layouts')) {
    // Each layout keeps its own places: switching files the space as it
    // stands under the layout it was, never under the one it becomes (a
    // galaxy once filed as spokes, and every layout recalled the one before).
    const kept = await evalIn(`
      try {
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { await console_idle(); input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.launcher-tile')) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      const pane = () => [...document.querySelectorAll('.pane-universe')].find((p) => p.offsetParent !== null);
      const settled = () => { const p = pane(); const w = p?.querySelector('.wait-progress'); return /[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden); };
      const settle = async () => { for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; } await sleep(1500); };
      await settle();
      await say('universe layout galaxy', 1500); await settle();
      await say('universe layout spokes', 1500); await settle();
      await say('universe layout galaxy', 1500); await settle();
      const keys = Object.keys(localStorage).filter((k) => /^argus\\.universe\\./.test(k) && !/settings/.test(k));
      const galaxyKey = keys.find((k) => !/\\.(spokes|clumps|constellations|data|accretion|shapes)$/.test(k));
      const spokesKey = keys.find((k) => /\\.spokes$/.test(k));
      const g = galaxyKey ? localStorage.getItem(galaxyKey) : null;
      const sp = spokesKey ? localStorage.getItem(spokesKey) : null;
      return { galaxyKey, spokesKey, both: g !== null && sp !== null, differ: g !== sp, sizes: [g?.length ?? 0, sp?.length ?? 0] };
      } catch (err) { return { crash: String(err && err.stack || err) }; }`);
    check('each layout keeps its own places: GALAXY and SPOKES are filed apart',
      kept.both === true && kept.differ === true, JSON.stringify(kept));
  }

  if (await stage('universe-session-layout')) {
    // The universe is laid out once per identity: the first browser to
    // settle a layout puts it to the session, which keeps it beside the
    // index, and the next browser draws from it at once.
    const kept = await evalIn(`
      try {
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { await console_idle(); input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const lastLine = (re) => console_text().split('\\n').map((l) => l.trim()).filter((l) => re.test(l)).slice(-1)[0] ?? '';
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.launcher-tile')) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      const pane = () => [...document.querySelectorAll('.pane-universe')].find((p) => p.offsetParent !== null);
      const settled = () => { const p = pane(); const w = p?.querySelector('.wait-progress'); return /[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden); };
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      await say('universe layout galaxy', 1500);
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      // Remembered a moment after the settle stands, then put.
      let answer = '';
      for (let i = 0; i < 40; i++) {
        await say('proc layout galaxy', 800);
        answer = lastLine(/^layout galaxy:/);
        if (/places, kept/.test(answer)) break;
        await sleep(1000);
      }
      await say('universe state', 600);
      const state = lastLine(/^session layout: /);
      await say('proc layout ../x', 600);
      const refused = lastLine(/^proc layout: /);
      return { answer, state, refused };
      } catch (err) { return { crash: String(err && err.stack || err) }; }`);
    check('the session keeps where the universe was laid out, and refuses a name that is not a layout',
      /^layout galaxy: [\d,]+ places, kept /.test(kept.answer) && /^session layout: \d+ places kept/.test(kept.state) && /not a layout/.test(kept.refused),
      JSON.stringify(kept));
  }

  if (await stage('universe-accretion')) {
    // ACCRETION grows the space in the order it was made, kin sticking to
    // kin; REGROW forgets the kept coral and grows it afresh.
    const acc = await evalIn(`
      try {
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { await console_idle(); input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const lastLine = (re) => console_text().split('\\n').map((l) => l.trim()).filter((l) => re.test(l)).slice(-1)[0] ?? '';
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.launcher-tile')) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      const pane = () => [...document.querySelectorAll('.pane-universe')].find((p) => p.offsetParent !== null);
      const settled = () => { const p = pane(); const w = p?.querySelector('.wait-progress'); return /[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden); };
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      await say('universe layout accretion', 1500);
      const said = lastLine(/^the space grown in the order|^universe layout/);
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      const block = pane()?.querySelector('.universe-arrangement')?.textContent.trim() ?? '';
      await say('universe regrow', 1500);
      const regrown = lastLine(/^the space regrown|^universe regrow/);
      for (let i = 0; i < 480; i++) { await sleep(500); if (settled()) break; }
      await say('universe state', 600);
      const scene = lastLine(/^scene: /);
      await say('universe layout galaxy', 1500);
      await say('universe regrow', 600);
      const refused = lastLine(/^universe regrow/);
      return { said, block, regrown, scene, refused };
      } catch (err) { return { crash: String(err && err.stack || err) }; }`);
    check('ACCRETION grows the space as a coral, and REGROW grows it afresh (ACCRETION only)',
      /^the space grown in the order it was made/.test(acc.said) && acc.block === 'ACCRETION' && /^the space regrown/.test(acc.regrown)
        && /arrangement=accretion/.test(acc.scene) && /the ACCRETION layout only/.test(acc.refused),
      JSON.stringify(acc));
  }

  if (await stage('universe-replay')) {
    // REPLAY plays the space's history: every feed hidden until the day it
    // was made, then shown where it stands now, the day on the bar. A word
    // starts it, pauses it, moves it to a date; the block names its state;
    // Esc ends it and the space is whole again.
    const replay = await evalIn(`
      await console_idle();
      const input = console_input();
      const say = async (line, ms) => { await console_idle(); input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      document.getElementById('gutter-dashboard')?.click();
      for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.launcher-tile')) break; }
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      const pane = () => [...document.querySelectorAll('.pane-universe')].find((p) => p.offsetParent !== null);
      for (let i = 0; i < 480; i++) { await sleep(500); const p = pane(); const w = p?.querySelector('.wait-progress'); if (/[1-9]\\d* FEEDS/.test(p?.querySelector('.universe-title')?.textContent ?? '') && !(w && !w.hidden)) break; }
      const readout = () => pane()?.querySelector('.pane-state')?.textContent.trim() ?? '';
      const block = () => pane()?.querySelector('.universe-replay')?.textContent.trim() ?? '';
      const lastLine = (re) => console_text().split('\\n').map((l) => l.trim()).filter((l) => re.test(l)).slice(-1)[0] ?? '';
      const atRest = { readout: readout(), block: block() };
      await say('universe replay 6', 400);
      const started = lastLine(/^replaying|^universe replay/);
      const days = [];
      for (let i = 0; i < 60; i++) { await sleep(250); const r = readout(); if (days[days.length - 1] !== r) days.push(r); if (block() === 'REPLAYED') break; }
      const ended = { readout: readout(), block: block() };
      await say('universe state', 600);
      const stated = lastLine(/^replay: /);
      await say('universe replay at 2025-06-01', 600);
      const moved = { readout: readout(), block: block(), said: lastLine(/^replay at|^universe replay/) };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(800);
      const stopped = { readout: readout(), block: block() };
      return { atRest, started, days: days.slice(0, 12), dayCount: days.length, ended, stated, moved, stopped };`);
    const dated = (text) => /^(REPLAY|PAUSED) \d{4}-\d\d-\d\d$/.test(text);
    check('REPLAY rests on the frame, the bar saying the space as it is',
      replay.atRest.block === 'REPLAY' && /WHOLE|LANDING/.test(replay.atRest.readout), JSON.stringify(replay.atRest));
    check('universe replay plays the history: the bar walks the days and the block says PLAYING, then REPLAYED',
      /^replaying \d+ feeds, \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/.test(replay.started) && replay.days.filter(dated).length >= 3 && replay.ended.block === 'REPLAYED',
      JSON.stringify({ started: replay.started, days: replay.days, ended: replay.ended }));
    check('universe state says where the replay stands', /^replay: paused at \d{4}-\d\d-\d\d of \d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d$/.test(replay.stated), JSON.stringify(replay.stated));
    check('universe replay at <date> moves the history there and holds it',
      replay.moved.block === 'PAUSED' && /^PAUSED \d{4}-\d\d-\d\d$/.test(replay.moved.readout), JSON.stringify(replay.moved));
    check('Esc ends the replay and the space is whole again',
      replay.stopped.block === 'REPLAY' && /WHOLE|LANDING/.test(replay.stopped.readout), JSON.stringify(replay.stopped));
  }

  if (await stage('drawer-everywhere (files, runs, pacs)')) {
  for (const preset of ['gutter-files', 'gutter-runs', 'gutter-tools']) {
    const result = await evalIn(`
      document.getElementById('${preset}').click(); await sleep(700);
      const leaves = [...document.querySelectorAll('#layout-root .layout-leaf > *')];
      const bad = leaves.filter((m) => !m.querySelector('.pane-handle') || !m.querySelector('.pane-drawer'));
      const first = leaves[0];
      let opened = false;
      if (first) {
        const drawer = first.querySelector('.pane-drawer');
        first.querySelector('.pane-handle').click(); await sleep(150);
        opened = drawer && !drawer.hidden;
        if (opened) { first.querySelector('.pane-handle').click(); await sleep(100); }
      }
      return { leaves: leaves.length, bad: bad.map((b) => b.id || b.className), opened };`);
    check(`${preset}: every shown pane carries handle+drawer`, result.bad.length === 0 && result.leaves > 0, JSON.stringify(result.bad));
    check(`${preset}: drawer opens from the handle`, result.opened === true);
  }
  }

  if (await stage('gutter-idempotency')) {
  const pacsTwice = await evalIn(`
    document.getElementById('gutter-tools').click(); await sleep(500);
    document.getElementById('gutter-tools').click(); await sleep(500);
    const pacs = document.getElementById('pacs-workspace');
    return { shown: pacs.getBoundingClientRect().height > 100 };`);
  check('PACS-03 always renders PACS (a given never toggles)', pacsTwice.shown === true);
  const consoleGiven = await evalIn(`
    const drawerEl = document.getElementById('drawer');
    if (!drawerEl.classList.contains('drawer-closed')) {
      document.getElementById('drawer-toggle').click(); await sleep(500);
    }
    document.getElementById('gutter-console').click(); await sleep(500);
    const first = !drawerEl.classList.contains('drawer-closed');
    document.getElementById('gutter-console').click(); await sleep(500);
    const second = !drawerEl.classList.contains('drawer-closed');
    return { first, second };`);
  check('CONSOLE-05 always renders the console open (never toggles)', consoleGiven.first && consoleGiven.second);
  }

  if (await stage('zoom-completeness')) {
  const zoom = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(700);
    const pane = document.querySelector('.pane-files');
    pane.querySelector('.pane-handle').click(); await sleep(150);
    pane.querySelector('.drawer-zoom').click();
    const header = document.querySelector('.wrap:not(#gap)');
    // The header glides; a fixed wait either catches it mid-flight or, if
    // the click has not registered yet, before it starts. Wait for the
    // motion to stop instead of guessing how long it takes.
    await settled(() => header.getBoundingClientRect().bottom);
    const gutter = document.querySelector('.left-frame');
    const lid = document.getElementById('drawer-toggle');
    const status = document.getElementById('status-strip');
    const strip = document.getElementById('header-restore');
    const zoomed = {
      headerBottom: header.getBoundingClientRect().bottom,
      gutterRight: gutter.getBoundingClientRect().right,
      lidHidden: lid.getBoundingClientRect().height === 0,
      statusHidden: status.getBoundingClientRect().height === 0,
      stripShown: strip.getBoundingClientRect().height > 0,
      capsule: (() => { const c = pane.querySelector('.drawer-zoom');
        return c.getBoundingClientRect().height > 0 ? c.textContent : 'HIDDEN'; })(),
    };
    // Every step here is a glide; each waits for its own motion to stop.
    strip.click();
    await settled(() => header.getBoundingClientRect().bottom);
    zoomed.stripRestored = header.getBoundingClientRect().bottom > 50;
    zoomed.capsuleAfter = pane.querySelector('.drawer-zoom').textContent;
    pane.querySelector('.drawer-zoom').click();
    await settled(() => header.getBoundingClientRect().bottom);
    // Contextual back is a stack: the open pane drawer takes the first
    // Esc, the zoom the next.
    for (let i = 0; i < 3 && header.getBoundingClientRect().bottom <= 1; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settled(() => header.getBoundingClientRect().bottom);
    }
    zoomed.restoredHeaderBottom = header.getBoundingClientRect().bottom;
    return zoomed;`);
  check('zoom slides the whole header off stage', zoom.headerBottom <= 1, `bottom=${zoom.headerBottom}`);
  check('zoom slides the gutter off stage', zoom.gutterRight <= 1, `right=${zoom.gutterRight}`);
  check('zoom hides the lid and the status readouts', zoom.lidHidden && zoom.statusHidden);
  check('zoom leaves the thin restore strip, and it restores', zoom.stripShown && zoom.stripRestored);
  check('the capsule reads RESTORE while zoomed, ZOOM after', zoom.capsule === 'RESTORE' && zoom.capsuleAfter === 'ZOOM', `${zoom.capsule}/${zoom.capsuleAfter}`);
  check('Esc restores the header', zoom.restoredHeaderBottom > 50, `bottom=${zoom.restoredHeaderBottom}`);
  }

  if (await stage('header-dblclick-zoom')) {
  // A double click on a pane's frame zooms it and a second restores it, as
  // a title bar does; the drawer the two clicks toggle ends as it was, and
  // the title's words are not left selected.
  const dbl = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(700);
    const pane = document.querySelector('.pane-files');
    const handle = pane.querySelector('.pane-handle');
    const drawer = pane.querySelector('.pane-drawer');
    const drawerBefore = drawer.hidden;
    const double = () => { handle.click(); handle.click(); handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); };
    double(); await sleep(700);
    const zoomed = document.body.dataset.zoom ?? null;
    const drawerKept = drawer.hidden === drawerBefore;
    const selected = (window.getSelection()?.toString() ?? '').length;
    double(); await sleep(700);
    return { zoomed, drawerKept, selected, restored: document.body.dataset.zoom ?? null, paneId: pane.closest('[data-pane-id]')?.dataset.paneId ?? null };`);
  check('a double click on a pane frame zooms it, a second restores it; the drawer ends as it was',
    typeof dbl.zoomed === 'string' && dbl.zoomed.length > 0 && dbl.drawerKept && dbl.selected === 0 && dbl.restored === null, JSON.stringify(dbl));
  // The console is a pane in this: its frame zooms on a double click, and
  // the lid closes it even while it is zoomed (it used to do nothing there).
  const con = await evalIn(`
    const drawerEl = document.getElementById('drawer');
    if (drawerEl.classList.contains('drawer-closed')) { document.getElementById('drawer-toggle').click(); await sleep(500); }
    const handle = document.getElementById('console-handle');
    const cdrawer = document.getElementById('console-drawer');
    const drawerBefore = cdrawer.hidden;
    const double = () => { handle.click(); handle.click(); handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); };
    double(); await sleep(700);
    const zoomed = document.body.dataset.zoom ?? null;
    const drawerKept = cdrawer.hidden === drawerBefore;
    double(); await sleep(700);
    const restored = document.body.dataset.zoom ?? null;
    double(); await sleep(700);
    const lid = document.getElementById('drawer-toggle');
    const lidShown = lid.getBoundingClientRect().height > 0;
    lid.click(); await sleep(900);
    const afterLid = { zoom: document.body.dataset.zoom ?? null, closed: drawerEl.classList.contains('drawer-closed') };
    lid.click(); await sleep(700);
    return { zoomed, drawerKept, restored, lidShown, afterLid, reopened: !drawerEl.classList.contains('drawer-closed') };`);
  check('a double click on the console frame zooms it, a second restores it; the lid closes a zoomed console',
    con.zoomed === 'console' && con.drawerKept && con.restored === null && con.lidShown && con.afterLid.zoom === null && con.afterLid.closed && con.reopened, JSON.stringify(con));
  }

  if (await stage('split-zoom')) {
  const splitZoom = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(600);
    const pane = document.querySelector('.pane-files');
    pane.querySelector('.pane-handle').click(); await sleep(150);
    pane.querySelector('[data-split="col"][data-place="after"]').click(); await sleep(600);
    const leaves = document.querySelectorAll('#layout-root .layout-leaf').length;
    pane.querySelector('.pane-handle').click(); await sleep(150);
    // The leaf grows into the region; wait for that growth to stop rather
    // than sampling it mid-glide.
    pane.querySelector('.drawer-zoom').click();
    const leaf = pane.closest('.layout-leaf');
    await settled(() => Math.round(leaf.getBoundingClientRect().width));
    const r = leaf.getBoundingClientRect();
    const full = r.width > window.innerWidth * 0.85;
    for (let i = 0; i < 3 && document.body.dataset.zoom !== undefined; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settled(() => Math.round(leaf.getBoundingClientRect().width));
    }
    document.getElementById('gutter-files').click(); await sleep(400);
    return { leaves, full, w: Math.round(r.width) };`);
  check('a zoomed leaf inside a split conquers the whole region', splitZoom.leaves >= 2 && splitZoom.full, `leaves=${splitZoom.leaves} w=${splitZoom.w}`);
  }

  if (await stage('lid-parity + single-beckon-author')) {
  const lid = await evalIn(`
    const bar = document.getElementById('drawer-toggle');
    const segs = () => [...bar.querySelectorAll('div')].map((d) => { const r = d.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; });
    const anims = () => [getComputedStyle(bar).animationName,
      ...[...bar.querySelectorAll('div:not(.bar-10)')].map((d) => getComputedStyle(d).animationName)];
    const drawer = document.getElementById('drawer');
    const wasClosed = drawer.classList.contains('drawer-closed');
    if (wasClosed) { bar.click(); await sleep(600); }
    const open = segs();
    bar.click(); await sleep(600);
    const closed = segs();
    const closedAnims = anims();
    const capAnim = getComputedStyle(bar.querySelector('.bar-10')).animationName;
    bar.click(); await sleep(300);
    if (wasClosed) { bar.click(); await sleep(300); }
    return { open, closed, closedAnims, capAnim };`);
  check('lid segments identical open and closed', JSON.stringify(lid.open) === JSON.stringify(lid.closed));
  check('closed lid: bar and segments carry no animation', lid.closedAnims.every((a) => a === 'none'), JSON.stringify(lid.closedAnims));
  check('closed lid: the end block beckons', lid.capAnim !== 'none', lid.capAnim);
  }

  if (await stage('lang-toggle')) {
  const lang = await evalIn(`
    const pill = document.getElementById('lang-pill');
    const palette = document.getElementById('lang-palette');
    pill.click(); await sleep(150);
    const a = { open: !palette.hidden, lit: pill.classList.contains('lang-live') };
    pill.click(); await sleep(150);
    const b = { open: !palette.hidden, lit: pill.classList.contains('lang-live') };
    return { a, b };`);
  check('LANG opens the line and lights the given', lang.a.open && lang.a.lit);
  check('LANG again removes the line and dims the given', !lang.b.open && !lang.b.lit);
  }

  if (await stage('runs-honesty')) {
  const runs = await evalIn(`
    document.getElementById('gutter-runs').click();
    for (let i=0;i<60;i++){ await sleep(500);
      if (document.querySelector('.feedlist-row')) return 'roster';
      if (document.querySelector('.feedlist-refusal') || document.querySelector('.feedlist-warming')) return 'refusal';
      }
    return document.querySelector('.feedlist-loading') ? 'loading' : 'silent-empty';`);
  check('RUNS-02 answers with roster, refusal, or visible wait', runs !== 'silent-empty', runs);
  // A refusal keeps its words; the count belongs to the live figure beneath it.
  const refusalText = await evalIn(`return document.querySelector('.feedlist-refusal')?.textContent ?? '';`);
  check('a refused roster repeats no frozen count', !/\(\s*[\d,]+\/[\d,]+/.test(refusalText), refusalText);
  }

  if (await stage('runs-filter-asks')) {
  // A filter naming a feed the roster lacks asks the session for it, and
  // the field says what CUBE answered (a-share-is-seen-on-the-next-look).
  const miss = await evalIn(`
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60 && !document.querySelector('.feedlist-row'); i++) await sleep(500);
    const pane = document.querySelector('.feedlist-row').closest('.pane-dag');
    // A NEW block may land a beat before the roster beneath it: count once the rows hold still.
    let rows = 0;
    for (let i = 0, still = 0; i < 40 && still < 3; i++) { const n = pane.querySelectorAll('.feedlist-row').length; still = n === rows ? still + 1 : 0; rows = n; await sleep(150); }
    // Typed into the strip, as the operator does.
    const input = pane.querySelector('.roster-filter-input');
    pane.querySelector('.runs-filter').click(); await sleep(200);
    input.value = '999999999'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const asking = document.querySelector('.feedlist-miss')?.textContent ?? '';
    let answer = asking;
    for (let i = 0; i < 60 && answer.includes('asking'); i++) { await sleep(500); answer = document.querySelector('.feedlist-miss')?.textContent ?? ''; }
    const state = pane.querySelector('.pane-state')?.textContent ?? '';
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
    pane.querySelector('.runs-filter').click(); await sleep(300);
    const back = pane.querySelectorAll('.feedlist-row').length;
    return { rows, asking, answer, state, back };`);
  check('a RUNS filter naming a feed the roster lacks asks CUBE and says so', miss.asking.includes('asking CUBE'), miss.asking);
  check("CUBE's answer lands in the field: not shared, or shared to a group you are not in", miss.answer.includes('does not list feed_999999999'), miss.answer);
  check('the roster stands as it was: FILTERED 0/n while asked, every row back after', miss.state.startsWith('FILTERED 0/') && miss.back === miss.rows && miss.rows > 0, JSON.stringify(miss));
  }

  if (await stage('runs-refresh')) {
  // REFRESH asks CUBE for the feed list again; the bar says so while the
  // walk runs and when it lands (a-share-is-seen-on-the-next-look).
  const refresh = await evalIn(`
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60 && !document.querySelector('.feedlist-row'); i++) await sleep(500);
    const pane = document.querySelector('.feedlist-row').closest('.pane-dag');
    // A NEW block may land a beat before the roster beneath it: count once the rows hold still.
    let rows = 0;
    for (let i = 0, still = 0; i < 40 && still < 3; i++) { const n = pane.querySelectorAll('.feedlist-row').length; still = n === rows ? still + 1 : 0; rows = n; await sleep(150); }
    const state = () => pane.querySelector('.pane-state')?.textContent ?? '';
    pane.querySelector('.runs-refresh').click();
    let checking = '';
    // The press waits its turn on the session's lane, and the walk is as slow as CUBE is (17 s measured).
    for (let i = 0; i < 300 && !checking.includes('CHECKING'); i++) { await sleep(100); checking = state(); }
    let landed = checking;
    for (let i = 0; i < 1200 && !landed.includes('FEED LIST CURRENT'); i++) { await sleep(100); landed = state(); }
    const back = pane.querySelectorAll('.feedlist-row').length;
    return { rows, checking, landed, back };`);
  check('REFRESH on the roster says CHECKING CUBE FOR THE FEED LIST while the walk runs', refresh.checking.includes('CHECKING CUBE FOR THE FEED LIST'), refresh.checking);
  check('and FEED LIST CURRENT when it lands, the roster still standing', refresh.landed.includes('FEED LIST CURRENT') && refresh.back >= refresh.rows && refresh.rows > 0, JSON.stringify(refresh));
  }

  if (await stage('console-grammar')) {
  const consoleGrammar = await evalIn(`
    const drawerEl = document.getElementById('drawer');
    if (drawerEl.classList.contains('drawer-closed')) {
      document.getElementById('drawer-toggle').click(); await sleep(500);
    }
    const handle = document.getElementById('console-handle');
    const cdrawer = document.getElementById('console-drawer');
    handle.click(); await sleep(150);
    const out = { opened: !cdrawer.hidden };
    const capsule = cdrawer.querySelector('.drawer-zoom');
    out.capsuleShown = capsule.getBoundingClientRect().height > 0;
    capsule.click(); await sleep(600);
    out.zoomed = document.body.dataset.zoom === 'console';
    out.reads = capsule.textContent;
    capsule.click(); await sleep(600);
    out.restored = document.body.dataset.zoom === undefined;
    out.readsAfter = capsule.textContent;
    cdrawer.querySelector('.console-retract').click(); await sleep(500);
    out.retracted = drawerEl.classList.contains('drawer-closed');
    document.getElementById('drawer-toggle').click(); await sleep(300);
    return out;`);
  check('console drawer opens from its handle', consoleGrammar.opened && consoleGrammar.capsuleShown);
  check('console drawer zooms the console and reads RESTORE', consoleGrammar.zoomed && consoleGrammar.reads === 'RESTORE');
  check('console zoom restores and reads ZOOM', consoleGrammar.restored && consoleGrammar.readsAfter === 'ZOOM');
  check('console drawer CLOSE retracts the console', consoleGrammar.retracted === true);
  }

  if (await stage('console-height')) {
  // The operator divides the stage, not a constant. A workspace floor is a
  // console ceiling: the drawer can only grow into space the workspace will
  // give up, so a `min-height` on main silently capped the console at
  // roughly half the frame however far the strip was dragged.
  const consoleHeight = await evalIn(`
    const out = {};
    const drawerEl = document.getElementById('drawer');
    if (drawerEl.classList.contains('drawer-closed')) {
      document.getElementById('drawer-toggle').click(); await sleep(400);
    }
    out.workspaceFloor = getComputedStyle(document.querySelector('main')).minHeight;

    // Drive the strip the way a hand does: press, travel, release.
    const strip = document.getElementById('drawer-strip');
    out.stripFound = !!strip;
    if (strip) {
      const start = drawerEl.getBoundingClientRect().height;
      // Pointer events on the strip itself, as it captures them (a finger
      // drags it as a mouse does); mouse events on the window were the old
      // grammar, and the strip stopped hearing them.
      const at = strip.getBoundingClientRect().top + 2;
      const pointer = (type, clientY) => strip.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientY, bubbles: true }));
      pointer('pointerdown', at);
      pointer('pointermove', window.innerHeight);
      pointer('pointerup', window.innerHeight);
      await sleep(200);
      out.start = start;
      out.grown = drawerEl.getBoundingClientRect().height;
      out.viewport = window.innerHeight;
      // Put the stage back: a console left at full height leaves no
      // workspace for the checks that follow.
      drawerEl.style.height = '';
      await sleep(200);
      out.restoredHeight = drawerEl.getBoundingClientRect().height;
    }
    return out;`);
  if (consoleHeight.stripFound) {
    // The old ceiling was the viewport less the 20rem floor and the chrome
    // above it; comfortably over half the viewport proves the floor is gone.
    const past = consoleHeight.grown > consoleHeight.viewport * 0.6;
    check('the console drags past the old workspace floor', past,
      JSON.stringify({ start: consoleHeight.start, grown: consoleHeight.grown, viewport: consoleHeight.viewport }));
    check('and the workspace keeps no floor of its own', consoleHeight.workspaceFloor === '0px', consoleHeight.workspaceFloor);
    check('and the console returns to its resting height', consoleHeight.restoredHeight < consoleHeight.grown,
      JSON.stringify({ grown: consoleHeight.grown, restored: consoleHeight.restoredHeight }));
  }
  }

  if (await stage('warmup-failure')) {
  // A warm-up moved off the boot gate has no readout left to be printed
  // to, so it is named on the JOBS readout and stays there until a later
  // attempt clears it. Driven through the surface's own prompt-context
  // path, so this exercises the rendering an operator actually sees.
  const warmFail = await evalIn(`
    const jobs = document.getElementById('status-jobs');
    const base = globalThis.__argusPromptContext;
    const show = globalThis.__argusPromptContext_show;
    if (!jobs || !base || !show) return { ready: false };

    // The readout is written synchronously, and each reading is taken in the
    // same turn as the show that caused it: the daemon pushes a live
    // promptline every second while the index moves, and any await between
    // a show and its reading is a gap that push can land in, replacing the
    // injected context with a real one that carries no failure.
    show({ ...base, warmupFailures: [{ label: 'Groups', message: 'membership service unavailable' }] });
    const named = jobs.textContent.includes('WARM-UP FAILED') && jobs.textContent.includes('GROUPS');
    const degraded = jobs.classList.contains('status-degraded');
    const explained = jobs.title.includes('membership service unavailable');

    // It persists: another context carrying the same failure must not clear it.
    show({ ...base, warmupFailures: [{ label: 'Groups', message: 'membership service unavailable' }] });
    const persists = jobs.textContent.includes('WARM-UP FAILED');

    // And a later success clears it.
    show({ ...base });
    const cleared = !jobs.textContent.includes('WARM-UP FAILED') && !jobs.classList.contains('status-degraded');

    return { ready: true, named, degraded, explained, persists, cleared };`);
  if (warmFail.ready) {
    check('a failed deferred warm-up is named on the status readout and persists',
      warmFail.named && warmFail.degraded && warmFail.persists && warmFail.cleared,
      JSON.stringify(warmFail));
    check('and the readout explains it', warmFail.explained, JSON.stringify(warmFail));
  } else {
    check('a failed deferred warm-up is named on the status readout and persists', false,
      'the surface exposed no prompt-context seam');
  }
  }

  if (await stage('focus-citizenship')) {
  const focusCit = await evalIn(`
    const prefix = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
    const cdrawer = document.getElementById('console-drawer');
    const drawerEl = document.getElementById('drawer');
    if (drawerEl.classList.contains('drawer-closed')) { document.getElementById('drawer-toggle').click(); await sleep(400); }
    // touch the workspace, prefix must address the pane
    document.getElementById('gutter-files').click(); await sleep(500);
    const fpane = document.querySelector('.pane-files');
    // A touch is a pointer going down and a click; the layout takes focus on the first.
    for (const d of document.querySelectorAll('.pane-drawer:not([hidden])')) d.hidden = true;
    fpane.querySelector('.files-panel').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    fpane.querySelector('.files-panel').click(); await sleep(150);
    prefix(); await sleep(200);
    const fdrawer = fpane.querySelector('.pane-drawer');
    const paneGot = !fdrawer.hidden && cdrawer.hidden;
    if (!fdrawer.hidden) { prefix(); await sleep(200); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(200); }
    // touch the console, prefix must address the console
    document.getElementById('terminal').click(); await sleep(150);
    prefix(); await sleep(200);
    const consoleGot = !cdrawer.hidden;
    if (!cdrawer.hidden) cdrawer.hidden = true;
    // the given focuses its channel too
    document.getElementById('gutter-console').click(); await sleep(300);
    prefix(); await sleep(200);
    const givenGot = !cdrawer.hidden;
    if (!cdrawer.hidden) cdrawer.hidden = true;
    return { paneGot, consoleGot, givenGot };`);
  check('focus citizenship: a touched pane owns the prefix', focusCit.paneGot === true);
  check('focus citizenship: the touched console owns the prefix', focusCit.consoleGot === true);
  check('focus citizenship: CONSOLE-05 hands the prefix to the console', focusCit.givenGot === true);
  }

  if (await stage('census-pill')) {
  const censusPill = await evalIn(`
    document.getElementById('gutter-runs').click(); await sleep(500);
    const pill = document.querySelector('.dag-census');
    if (!pill) return { present: false };
    const before = pill.textContent;
    pill.click(); await sleep(300);
    const after = pill.textContent;
    pill.click(); await sleep(300);
    const g = document.querySelector('.dag-gravity');
    const gBefore = g ? g.textContent : null;
    if (g) { g.click(); await sleep(300); }
    const gAfter = g ? g.textContent : null;
    if (g) { g.click(); await sleep(300); }
    // HUE is a mode: STATUS by default, COMPUTE colors by resource with a
    // legend on the bar, and the block reads its state either way.
    const h = document.querySelector('.dag-hue');
    const hBefore = h ? h.textContent : null;
    if (h) { h.click(); await sleep(400); }
    const hAfter = h ? h.textContent : null;
    const dp = h ? h.closest('.pane-dag') : null;
    const legend = dp ? dp.querySelector('.pane-mode .pane-legend') !== null : false;
    if (h) { h.click(); await sleep(300); }
    return { present: true, before, after, restored: pill.textContent === before, gBefore, gAfter, gRestored: g ? g.textContent === gBefore : false, hBefore, hAfter, legend, hRestored: h ? h.textContent === hBefore : false };`);
  check('CENSUS pill present, toggles SHAPE/CENSUS, restores', censusPill.present && censusPill.before === 'SHAPE' && censusPill.after === 'CENSUS' && censusPill.restored);
  check('GRAVITY pill reads its state and toggles', censusPill.gBefore === 'GRAVITY OFF' && censusPill.gAfter === 'GRAVITY ON' && censusPill.gRestored);
  check('the HUE block reads STATUS, COMPUTE puts the legend on the bar, and it restores', censusPill.hBefore === 'STATUS' && censusPill.hAfter === 'COMPUTE' && censusPill.legend && censusPill.hRestored, JSON.stringify({ b: censusPill.hBefore, a: censusPill.hAfter, l: censusPill.legend }));
  }

  if (await stage('mode-frame')) {
  // The field carries content only: at rest the mode frame is a strip at
  // the field's edge and no control stands in the field; touching the
  // strip slides the frame in (its pills work there); touching the field
  // retracts it; so does Esc. The header's retraction grammar, pane scale.
  const modeFrame = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    for (let i = 0; i < 40; i++) { await sleep(300); if (fp.querySelectorAll('.files-row').length > 1) break; }
    const body = fp.querySelector('.files-body');
    const strip = fp.querySelector('.mode-strip');
    const frame = fp.querySelector('.mode-frame');
    const bodyRect = body.getBoundingClientRect();
    // Column caps are the table's own frame (caps-are-the-sort), not chrome over the field.
    // The field's MORE chip is its one sanctioned control (a-field-says-it-holds-more).
    // The path's crumbs are the listing's own frame too, as the caps are: a browser away
    // from home wears them above the caps (#899 found the check had only ever run at home).
    const inField = [...body.querySelectorAll('button')].filter(b => !b.closest('.mode-frame') && !b.closest('.mode-strip') && !b.closest('.files-path') && !b.classList.contains('more-chip') && ![...b.classList].some(k => k.startsWith('roster-')));
    const rule = fp.querySelector('.field-rule').getBoundingClientRect();
    const elbow = fp.querySelector('.mode-elbow').getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    // At rest the strip IS the spine, drawn at the spine's width (--spine-w),
    // not a sliver: retracting returns it to that width.
    const spineW = parseFloat(getComputedStyle(strip).getPropertyValue('--spine-w')) || stripRect.width;
    const atRest = {
      stripShown: stripRect.width > 0 && stripRect.height > 40,
      strip: { w: Math.round(stripRect.width), h: Math.round(stripRect.height), spineW: Math.round(spineW), body: Math.round(bodyRect.height) },
      frameOff: getComputedStyle(frame).visibility === 'hidden' && Math.abs(stripRect.width - spineW) <= 1,
      fieldClean: inField.length === 0,
      pane: (fp.querySelector('.pane-title')?.textContent ?? '') + ' · ' + (fp.querySelector('.files-binding')?.textContent ?? ''),
      controls: inField.slice(0, 4).map(b => b.className.replace(/\s+/g, '.') + ':' + b.textContent.trim().slice(0, 20)),
      // the frame is drawn at rest: a rule along the top meeting the spine through an elbow
      ruleDrawn: rule.width > 100 && rule.height >= 4 && Math.abs(rule.right - stripRect.left) <= 1,
      elbowJoins: elbow.width > 20 && Math.abs(elbow.right - stripRect.right) <= 1 && Math.abs(elbow.top - rule.top) <= 1,
      // filtering is a mode: the strip is folded at rest
      filterFolded: fp.querySelector('.roster-filter').getBoundingClientRect().height === 0,
    };
    // The frame slides in; wait for the strip to stop widening.
    strip.click();
    await settled(() => Math.round(strip.getBoundingClientRect().width));
    const barRect = strip.getBoundingClientRect();
    const opened = barRect.width > 80 && frame.getBoundingClientRect().left < bodyRect.right - 40 && getComputedStyle(frame).visibility === 'visible' && fp.dataset.modes === 'open';
    const pill = fp.querySelector('.files-view');
    const pillWorks = (() => { const b = pill.textContent; pill.click(); const c = pill.textContent; return b === 'LIST' && c === 'CARDS'; })();
    await sleep(200);
    const modeRead = fp.querySelector('.pane-mode').textContent;
    // blocks sit flush against the spine, under the rule
    const frameRect = frame.getBoundingClientRect();
    // the blocks are segments of the widened bar: same width, same right edge, under the elbow
    const blocksFlush = Math.abs(frameRect.right - barRect.right) <= 1 && Math.abs(frameRect.width - barRect.width) <= 1 && frameRect.top >= rule.bottom;
    // FILTER is a block on the frame: it unfolds the strip and reads its state
    const fb = fp.querySelector('.files-filter');
    const filterBefore = fb.textContent;
    fb.click(); await sleep(250);
    const filterOpen = fp.querySelector('.roster-filter').getBoundingClientRect().height > 0 && fb.textContent === 'FILTER ON';
    fb.click(); await sleep(250);
    const filterClosed = fp.querySelector('.roster-filter').getBoundingClientRect().height === 0 && fb.textContent === filterBefore;
    // Retraction is a glide too: the strip narrows back to the spine.
    fp.querySelector('.files-panel').click();
    await settled(() => Math.round(strip.getBoundingClientRect().width));
    const fieldRetracts = fp.dataset.modes === undefined && getComputedStyle(frame).visibility === 'hidden' && Math.abs(strip.getBoundingClientRect().width - spineW) <= 1;
    strip.click();
    await settled(() => Math.round(strip.getBoundingClientRect().width));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settled(() => Math.round(strip.getBoundingClientRect().width));
    const escRetracts = fp.dataset.modes === undefined;
    // back to LIST for the scenarios that follow
    for (let i = 0; i < 3 && pill.textContent !== 'LIST'; i++) pill.click();
    await sleep(200);
    return { atRest, opened, pillWorks, modeRead, blocksFlush, filterBefore, filterOpen, filterClosed, fieldRetracts, escRetracts, restored: pill.textContent === 'LIST' };`);
  // On a field too short to carry it (a 1024×768 tablet leaves the files
  // field ~50 px tall) the strip folds away; the operator accepted that
  // layout on 2026-10-06 (#923), so the strip is asked for where it fits.
  const stripFits = (modeFrame.atRest.strip?.body ?? 999) >= 120;
  check('the mode frame rests as a strip, and the field carries no control', (modeFrame.atRest.stripShown || !stripFits) && modeFrame.atRest.frameOff && modeFrame.atRest.fieldClean, JSON.stringify(modeFrame.atRest));
  check('the field is framed at rest: a rule turning through an elbow into the spine', modeFrame.atRest.ruleDrawn && modeFrame.atRest.elbowJoins, JSON.stringify(modeFrame.atRest));
  check('touching the strip slides the mode frame in, and its pills work there', modeFrame.opened && modeFrame.pillWorks && modeFrame.blocksFlush, JSON.stringify({ o: modeFrame.opened, p: modeFrame.pillWorks, f: modeFrame.blocksFlush }));
  check('filtering is a mode: folded at rest, the FILTER block unfolds it and reads its state', modeFrame.atRest.filterFolded && modeFrame.filterBefore === 'FILTER OFF' && modeFrame.filterOpen && modeFrame.filterClosed, JSON.stringify({ r: modeFrame.atRest.filterFolded, b: modeFrame.filterBefore, o: modeFrame.filterOpen, c: modeFrame.filterClosed }));
  check('the bar annunciates the non-default mode', modeFrame.modeRead === 'CARDS', modeFrame.modeRead);
  check('touching the field retracts the mode frame; so does Esc', modeFrame.fieldRetracts && modeFrame.escRetracts && modeFrame.restored, JSON.stringify({ field: modeFrame.fieldRetracts, esc: modeFrame.escRetracts, restored: modeFrame.restored }));
  }

  if (await stage('cards')) {
  // CARDS projects the same listing: the pill reads the mode, cards carry
  // the kind as badge, the count equals the rows', and LIST comes back.
  // PREVIEW is the third projection: every card leads with a glimpse.
  const cards = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    for (let i = 0; i < 40; i++) { await sleep(300); if (fp.querySelectorAll('.files-row').length > 1) break; }
    // The lead rows (.. and ~, away from home) are not cards: count the listing's own rows.
    const rows = fp.querySelectorAll('.files-row:not(.files-lead-up):not(.files-lead-home)').length;
    const pill = fp.querySelector('.files-view');
    const before = pill.textContent;
    pill.click(); await sleep(300);
    const after = pill.textContent;
    const cardEls = [...fp.querySelectorAll('.files-card:not(.files-card-up)')];
    const mismatched = cardEls.map(c => [c.querySelector('.files-card-badge')?.textContent.toLowerCase() ?? null, [...c.classList].find(k => k.startsWith('files-type-'))?.replace('files-type-', '') ?? null]).filter(([b, t]) => b !== t);
    const badgesMatch = mismatched.length === 0;
    const paneName = (fp.querySelector('.pane-title')?.textContent ?? '') + ' · ' + (fp.querySelector('.files-binding')?.textContent ?? '');
    pill.click(); await sleep(600);
    const previewLabel = pill.textContent;
    const previewCards = [...fp.querySelectorAll('.files-card:not(.files-card-up)')];
    const thumbs = previewCards.filter(c => c.querySelector('.files-card-thumb')).length;
    const previewRead = fp.querySelector('.pane-mode').textContent;
    pill.click(); await sleep(300);
    const restored = pill.textContent === before && fp.querySelectorAll('.files-row').length > 1;
    return { before, after, rows, cardCount: cardEls.length, badgesMatch, mismatched: mismatched.slice(0, 4), paneName, previewLabel, previewCards: previewCards.length, thumbs, previewRead, restored };`);
  check('CARDS projects the same listing', cards.before === 'LIST' && cards.after === 'CARDS' && cards.cardCount === cards.rows && cards.badgesMatch, JSON.stringify({ pane: cards.paneName, before: cards.before, after: cards.after, rows: cards.rows, cards: cards.cardCount, mismatched: cards.mismatched }));
  check('PREVIEW leads every card with a glimpse', cards.previewLabel === 'PREVIEW' && cards.previewCards === cards.rows && cards.thumbs === cards.rows && cards.previewRead === 'PREVIEW' && cards.restored, JSON.stringify({ pane: cards.paneName, p: cards.previewLabel, n: cards.previewCards, rows: cards.rows, t: cards.thumbs, read: cards.previewRead, r: cards.restored }));
  }

  if (await stage('bin-context')) {
  // Everything in /bin is a graph: a plugin is the one-node case, drawn on
  // the same stage a pipeline gets, and its node opens as its parameters.
  // The wall of scraped text it used to be is gone.
  const binCtx = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const pill = document.getElementById('lang-pill');
    if (document.getElementById('lang-palette').hidden) { pill.click(); await sleep(150); }
    const li = document.getElementById('lang-input'); li.value = 'ls /bin';
    li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled();
    pill.click(); await sleep(100);
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    for (let i = 0; i < 60; i++) { await sleep(500); if (fp.querySelector('.files-row.files-type-plugin')) break; }
    const plugin = fp.querySelector('.files-row.files-type-plugin');
    if (!plugin) return { skipped: 'no plugin rows' };
    // A catalogue row is offered no verbs, so one click enters it (a-row-is-indicated-before-it-is-acted-on).
    plugin.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Esc is about to be a level test, so the command line — the topmost
    // transient, which takes any Esc while open — closes first. Running a
    // line closes the palette; the pill press above reopened it.
    if (!document.getElementById('lang-palette').hidden) { pill.click(); await sleep(150); }
    let pluginScene = false;
    for (let i = 0; i < 60; i++) { await sleep(500); if (fp.querySelector('.files-diagram canvas')) { pluginScene = true; break; } }
    // No prose: the graph is the whole view.
    const pluginWall = fp.querySelector('.files-content') !== null;
    let pluginSelected = '', pluginImmersed = '', pluginEscLeftNode = false, pluginOpensInside = false;
    const immersed = () => fp.querySelector('.files-diagram .dag-facts')?.classList.contains('dag-facts-immersed') === true;
    if (pluginScene) {
      const canvas = fp.querySelector('.files-diagram canvas');
      const facts = () => fp.querySelector('.files-diagram .dag-facts');
      const box = canvas.getBoundingClientRect();
      const at = { clientX: Math.round(box.left + box.width / 2), clientY: Math.round(box.top + box.height / 2) };
      const hit = (type) => canvas.dispatchEvent(new MouseEvent(type, { ...at, bubbles: true, cancelable: true }));
      // A level of one opens itself (the graph is the form): the plugin
      // arrives inside its one node, its parameters open.
      for (let i = 0; i < 20 && !immersed(); i++) await sleep(250);
      pluginOpensInside = immersed();
      // ONE press leaves the node and not the view — the same
      // retreat-exactly-one-level rule the pipeline dive follows.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(1500);
      pluginEscLeftNode = !immersed() && fp.querySelector('.files-diagram') !== null;
      // Outside the node, a touch reads out what it is; a dive goes back in.
      hit('click'); await sleep(500);
      pluginSelected = (facts()?.textContent ?? '');
      hit('dblclick'); await sleep(1800);
      pluginImmersed = (facts()?.textContent ?? '');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(1500);
    }
    // A view is closed by the operator, never by an arrival: a listing
    // asked for while the view is up lands under it, and CLOSE shows it.
    let survivesListing = false, listingUnderneath = false;
    if (pluginScene) {
      const term = console_input();
      term.value = 'ls /usr/bin';
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(2500); await console_settled();
      survivesListing = fp.querySelector('.files-diagram') !== null;
      fp.querySelector('.files-close-pill')?.click(); await sleep(600);
      // A plain includes, not a regex: a slash inside this template
      // literal would be eaten before the page ever parsed it.
      listingUnderneath = [...fp.querySelectorAll('.files-path')]
        .some(el => (el.textContent ?? '').includes('/usr/bin'));
      // Back to /bin for the pipeline half of this scenario.
      term.value = 'ls /bin';
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 60; i++) { await sleep(500); if (fp.querySelector('.files-row.files-type-pipeline')) break; }
    }
    // Esc is contextual back: the content view is a level above the listing
    // (the command line, if still open, is the topmost transient and would
    // take the press — close it first).
    if (!document.getElementById('lang-palette').hidden) { pill.click(); await sleep(150); }
    // A plugin opens inside its node, so the view is two levels up from
    // the listing: the first press leaves the node, the second the view.
    const beforeEsc = fp.querySelector('.files-row.files-type-plugin');
    if (beforeEsc) {
      beforeEsc.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 40 && !immersed(); i++) await sleep(250);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(1500);
    }
    const escKeptView = fp.querySelector('.files-diagram') !== null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(600);
    const escBack = escKeptView && !fp.querySelector('.files-diagram') && fp.querySelectorAll('.files-row').length > 0;
    const pipeline = fp.querySelector('.files-row.files-type-pipeline');
    if (!pipeline) {
      // Leave the browser as it was found: a view left up would take the
      // next scenario's listing underneath it.
      for (let i = 0; i < 4 && fp.querySelector('.files-close-pill'); i++) { fp.querySelector('.files-close-pill').click(); await sleep(400); }
      return { skipped: null, pluginScene, pluginWall, pluginOpensInside, pluginSelected, pluginImmersed, pluginEscLeftNode, survivesListing, listingUnderneath, escBack, pipelineSkipped: true };
    }
    pipeline.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    let summary = false, canvas = false;
    for (let i = 0; i < 60; i++) { await sleep(500); const c = fp.querySelector('.files-content'); if (c && /pipeline/.test(c.textContent)) summary = true; if (fp.querySelector('.files-diagram canvas')) { canvas = true; break; } }
    // The diagram canvas fills its mount in CSS pixels at any device pixel
    // ratio (SMOKE_DPR=1.5 shows the runaway this guards): measured while
    // the view is up, before CLOSE.
    const panelx = fp.querySelector('.files-panel');
    const spills = panelx.scrollWidth > panelx.clientWidth + 1;
    fp.querySelector('.files-close-pill')?.click(); await sleep(300);
    return { skipped: null, pluginScene, pluginWall, pluginOpensInside, pluginSelected, pluginImmersed, pluginEscLeftNode, survivesListing, listingUnderneath, escBack, summary, canvas, pipelineSkipped: false, spills, dpr: window.devicePixelRatio };`);
  if (binCtx.skipped) {
    console.log(`  skipped: ${binCtx.skipped}`);
  } else {
    check('a plugin opens as a graph of one node, with no wall of text',
      binCtx.pluginScene === true && binCtx.pluginWall === false,
      JSON.stringify({ scene: binCtx.pluginScene, wall: binCtx.pluginWall }));
    check('a plugin opens inside its one node, its parameters open', binCtx.pluginOpensInside === true);
    check('touching the plugin node reads out what it is',
      /PLUGIN/.test(binCtx.pluginSelected ?? '') && /PARAMETERS/.test(binCtx.pluginSelected ?? ''),
      JSON.stringify(binCtx.pluginSelected ?? '').slice(0, 160));
    check('Esc leaves the plugin node, not the view holding it',
      binCtx.pluginEscLeftNode === true, JSON.stringify(binCtx.pluginEscLeftNode));
    check('diving into it opens the node as its parameters',
      /VERSION/.test(binCtx.pluginImmersed ?? '')
      && (/--/.test(binCtx.pluginImmersed ?? '') || /no arguments/.test(binCtx.pluginImmersed ?? '')),
      JSON.stringify(binCtx.pluginImmersed ?? '').slice(0, 200));
    check('a view is closed by the operator, never by an arriving listing',
      binCtx.survivesListing === true && binCtx.listingUnderneath === true,
      JSON.stringify({ survived: binCtx.survivesListing, under: binCtx.listingUnderneath }));
    check('Esc returns a content view to its listing, one level a press: the node, then the view', binCtx.escBack === true);
    if (binCtx.pipelineSkipped) console.log('  skipped: no pipeline rows');
    else {
      check('a pipeline opens as its summary with its DAG rendered', binCtx.summary && binCtx.canvas);
      check('the content view never spills sideways (a scene canvas fills its mount at any pixel ratio)', binCtx.spills === false, JSON.stringify({ spills: binCtx.spills, dpr: binCtx.dpr }));
    }
  }
  }

  if (await stage('diagram-modes')) {
  // A pane has one mode frame, and its blocks answer to what the field
  // holds. A wave is a verb you press, never something breathing at rest.
  //
  // The frame swap needs only a diagram on stage; the blocks need a scene
  // behind it, and `pipeline diagram` is slow the first time a pipeline is
  // opened. So the two are checked separately rather than making the
  // cheap assertions hostage to a cold command.
  const diagramModes = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = document.querySelector('.pane-files');
    const body = fp.querySelector('.files-body');
    const shown = (sel) => { const el = body.querySelector(sel);
      return el !== null && getComputedStyle(el).display !== 'none'; };
    const input = console_input();
    input.value = 'cd /bin'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i=0;i<60;i++){ await sleep(500); if (fp.querySelectorAll('.files-row').length > 5) break; }
    const listing = { view: shown('.files-view'), pulse: shown('.diagram-pulse') };

    const pipeline = fp.querySelector('.files-row.files-type-pipeline');
    if (!pipeline) { await home_return(); return { skipped: 'no pipeline in /bin' }; }
    pipeline.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i=0;i<40;i++){ await sleep(250); if (fp.querySelector('.files-diagram')) break; }
    const diagram = { view: shown('.files-view'), pulse: shown('.diagram-pulse'),
      strategy: shown('.diagram-strategy'), projection: shown('.diagram-projection') };

    // The blocks act on a scene, so wait for one before pressing them.
    let scene = false;
    for (let i=0;i<160;i++){ await sleep(500); if (fp.querySelector('.files-diagram canvas')) { scene = true; break; } }
    let node = null;
    let blocks = null;
    if (scene) {
      await sleep(1200);
      // A node's substance is what it will run with, and the model already
      // carries it: a touch reads it out, a dive goes in, Esc comes back.
      const canvas = fp.querySelector('.files-diagram canvas');
      const facts = () => fp.querySelector('.files-diagram .dag-facts');
      const restingEmpty = (facts()?.textContent ?? '') === '';
      const box = canvas.getBoundingClientRect();
      const at = { clientX: Math.round(box.left + box.width / 2), clientY: Math.round(box.top + box.height / 2) };
      const hit = (type) => canvas.dispatchEvent(new MouseEvent(type, { ...at, bubbles: true, cancelable: true }));
      hit('click'); await sleep(500);
      const selected = (facts()?.textContent ?? '');
      hit('dblclick'); await sleep(1800);
      const immersedText = (facts()?.textContent ?? '');
      const immersedClass = facts()?.classList.contains('dag-facts-immersed') === true;
      // ONE press. Esc retreats exactly one level, so a second would leave
      // the view as well and this asserts it does not have to.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(1500);
      node = { restingEmpty, selected, immersedText, immersedClass,
        afterEsc: facts()?.classList.contains('dag-facts-immersed') === true,
        keptDiagram: fp.querySelector('.files-diagram') !== null };

      const pulseEl = body.querySelector('.diagram-pulse');
      const restingBefore = pulseEl.classList.contains('pulse-running');
      pulseEl.click(); await sleep(300);
      const litOnPress = pulseEl.classList.contains('pulse-running');
      const projEl = body.querySelector('.diagram-projection');
      const projBefore = projEl.textContent.trim();
      projEl.click(); await sleep(400);
      blocks = { restingBefore, litOnPress, projBefore,
        projAfter: projEl.textContent.trim(),
        bar: fp.querySelector('.pane-mode').textContent.trim() };
    }

    fp.querySelector('.files-close-pill')?.click(); await sleep(700);
    const restored = { view: shown('.files-view'), pulse: shown('.diagram-pulse'),
      bar: fp.querySelector('.pane-mode').textContent.trim() };
    // Leave as it came: back home, for the scenarios that follow.
    await home_return();
    return { listing, diagram, scene, node, blocks, restored };`);
  if (diagramModes.skipped) {
    console.log(`  skipped: ${diagramModes.skipped}`);
  } else {
    check('a listing offers its own modes and none of the diagram\'s',
      diagramModes.listing?.view === true && diagramModes.listing?.pulse === false,
      JSON.stringify(diagramModes.listing));
    check('a diagram on stage swaps the frame to the modes a graph has',
      diagramModes.diagram?.pulse === true && diagramModes.diagram?.strategy === true
      && diagramModes.diagram?.projection === true && diagramModes.diagram?.view === false,
      JSON.stringify(diagramModes.diagram));
    check('closing the diagram gives the frame back to the listing, and clears the bar',
      diagramModes.restored?.view === true && diagramModes.restored?.pulse === false
      && diagramModes.restored?.bar === '',
      JSON.stringify(diagramModes.restored));
    if (!diagramModes.scene) {
      console.log('  skipped: the diagram did not render in time, so its blocks were not pressed');
    } else {
      check('PULSE is a verb: at rest until pressed, never breathing on its own',
        diagramModes.blocks?.restingBefore === false && diagramModes.blocks?.litOnPress === true,
        JSON.stringify(diagramModes.blocks));
      check('a diagram mode reads its state and the bar annunciates the non-default',
        diagramModes.blocks?.projBefore === '3D' && diagramModes.blocks?.projAfter === '2D'
        && /2D/.test(diagramModes.blocks?.bar ?? ''),
        JSON.stringify(diagramModes.blocks));
      check('a graph at rest says nothing until a node is touched',
        diagramModes.node?.restingEmpty === true, JSON.stringify(diagramModes.node?.restingEmpty));
      check('touching a node reads out what it will run',
        /PLUGIN/.test(diagramModes.node?.selected ?? '') && /ARGUMENTS/.test(diagramModes.node?.selected ?? ''),
        JSON.stringify(diagramModes.node?.selected ?? '').slice(0, 160));
      check('diving in opens the node as its parameters, and Esc leaves the node not the view',
        diagramModes.node?.immersedClass === true && /PLUGIN/.test(diagramModes.node?.immersedText ?? '')
        && diagramModes.node?.afterEsc === false && diagramModes.node?.keptDiagram === true,
        JSON.stringify({ immersed: diagramModes.node?.immersedClass, afterEsc: diagramModes.node?.afterEsc,
          kept: diagramModes.node?.keptDiagram }));
    }
  }
  }

  // Diving into a DAG node: the gesture that had NO coverage at all. The
  // files pane's inline diagram has a dive of its own and it is checked
  // above, but that one immerses the FACTS chip; this one flies the camera
  // inside a node and mounts the node's filesystem over the scene. Nothing
  // asked whether the second half ever arrived — and when it did not, the
  // camera sat parked inside a sphere filling the pane with one flat
  // colour, which an operator reasonably read as a crash.
  const dagFeed = process.env.SMOKE_DAG_FEED ?? fixtureFeed ?? undefined;
  if (await stage('pane-title')) {
  // A pane's header is one line of a fixed height. A long name (a series
  // description, a converter's filename) wrapped inside it, which cut the
  // letters top and bottom and pushed the mode and state readouts onto a
  // second row. The name gives way first; the readouts keep their line.
  const header = await evalIn(`
    await console_idle();
    const bars = [...document.querySelectorAll('.workspace-pane')]
      .filter((p) => p.offsetParent !== null)
      .map((p) => p.querySelector('.lcars-bar-horizontal'))
      .filter((b) => b !== null);
    if (bars.length === 0) return { bars: 0 };
    const measured = bars.map((bar) => {
      const title = bar.querySelector('.lcars-title');
      const state = bar.querySelector('.pane-state');
      const box = (el) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top) }; };
      return {
        text: title?.textContent?.slice(0, 40) ?? '',
        barH: Math.round(bar.getBoundingClientRect().height),
        titleH: title ? box(title).h : 0,
        offLine: title !== null && state !== null && state.textContent !== ''
          ? Math.abs(box(title).top - box(state).top) > 8 : false,
      };
    });
    return { bars: bars.length, measured,
      wrapped: measured.filter((m) => m.titleH > m.barH || m.offLine) };`);
  check('every pane header keeps its title on one line, readouts beside it',
    header.bars > 0 && header.wrapped.length === 0, JSON.stringify(header.wrapped ?? header));
  }

  if (await stage('console-zoom')) {
  // The console's zoom owns the stage. The regression this guards: the
  // drawer was given a height measured from the viewport while it still
  // began below the header's gap, so it ran past the foot of the screen —
  // the workspace showed under it in a band, and the page grew taller than
  // the viewport, which (with overflow frozen) could carry the console's
  // own top frame above the fold.
  const zoom = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms) => { input.value = line;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const box = (sel) => { const el = document.querySelector(sel); if (el === null) return null;
      const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    await say('console zoom', 1800);
    const vp = window.innerHeight;
    const drawer = box('#drawer');
    const main = document.querySelector('main');
    const workspaceShown = main !== null && main.offsetParent !== null
      && main.getBoundingClientRect().top < vp;
    const scroller = document.scrollingElement;
    // An elbow is a join: with the gutter off stage it has nothing to turn
    // into, and what is left of it is a hook in the corner.
    const frame = document.querySelector('.right-frame');
    const fillet = {
      before: getComputedStyle(frame, '::before').display,
      after: getComputedStyle(frame, '::after').display,
    };
    const shot = {
      state: document.body.dataset.zoom,
      vp,
      drawer,
      fillet,
      // Inside the viewport, top frame included.
      framed: drawer !== null && drawer.top >= 0 && drawer.bottom <= vp,
      workspaceShown,
      // Nothing to scroll: a frozen scroll is what hid the top edge.
      overflows: Math.round(scroller.scrollHeight) > vp + 1,
    };
    await say('console zoom', 1500);
    return shot;`);
  check('the zoomed console sits inside the viewport, top frame and all',
    zoom.state === 'console' && zoom.framed === true, JSON.stringify(zoom));
  check('the workspace steps off stage for it, and nothing is left to scroll',
    zoom.workspaceShown === false && zoom.overflows === false, JSON.stringify(zoom));
  check('the elbow does not hang in the corner with nothing to turn into',
    zoom.fillet?.before === 'none' && zoom.fillet?.after === 'none', JSON.stringify(zoom.fillet));
  }

  if (await stage('launcher')) {
  // Where a session begins when nothing is open: one block per domain,
  // each carrying what it holds and ending in the verb that opens it, its
  // rows doors into recent work. The launcher is the empty state, so it
  // yields the moment content opens.
  const launcher = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms) => { input.value = line;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const tiles = () => [...document.querySelectorAll('.launcher-tile')];
    const named = (name) => tiles().find((t) => t.querySelector('.launcher-name')?.textContent === name);
    // The gutter's own way in: DASHBOARD-04, where a dead SOURCES block was.
    document.getElementById('gutter-dashboard')?.click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (tiles().length > 0) break; }
    await sleep(1500);
    const painted = tiles().map((t) => ({
      name: t.querySelector('.launcher-name')?.textContent ?? '',
      figures: [...t.querySelectorAll('.launcher-figure')].map((f) => f.textContent),
      rows: t.querySelectorAll('.launcher-row').length,
      verb: t.querySelector('.launcher-verb')?.textContent ?? '',
      numeral: t.dataset.numeral,
    }));
    const alone = [...document.querySelectorAll('.workspace-pane')]
      .filter((p) => p.offsetParent !== null).map((p) => p.className.replace('workspace-pane ', ''));
    // A row is a door: the first folder in FILES lands the browser there.
    const row = named('FILES')?.querySelector('button.launcher-row');
    const wanted = row?.querySelector('.launcher-row-text')?.textContent ?? '';
    row?.click();
    for (let i = 0; i < 80; i++) { await sleep(500);
      if (document.querySelector('.pane-files') !== null && tiles().length === 0) break; }
    await sleep(2500);
    const pane = [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    const landed = pane?.querySelector('.files-path')?.textContent?.trim() ?? '';
    const yielded = tiles().length === 0;
    // And the word brings it back.
    await say('dashboard', 2500);
    for (let i = 0; i < 60; i++) { await sleep(500); if (tiles().length > 0) break; }
    const returned = tiles().length > 0;
    // The gutter block names the place, and the pane agrees with it.
    const named2 = document.getElementById('gutter-dashboard')?.textContent?.trim() ?? '';
    const paneTitle = document.querySelector('.pane-launcher .pane-title')?.textContent?.trim() ?? '';
    await say('view files', 2000);
    await home_return();
    return { painted, alone, wanted, landed, yielded, returned, gutter: named2, paneTitle };`);
  check('the launcher opens as blocks, one per domain, each with its verb',
    launcher.painted.length >= 3
    && launcher.painted.every((t) => t.name !== '' && t.verb !== '' && t.numeral !== undefined)
    && launcher.painted.some((t) => t.name === 'FILES') && launcher.painted.some((t) => t.name === 'ANALYSES'),
    JSON.stringify(launcher.painted));
  check('it owns the stage while it is the empty state',
    launcher.alone.length === 1 && launcher.alone[0] === 'pane-launcher', JSON.stringify(launcher.alone));
  check('a row is a door: pressing one lands there, and the launcher yields',
    launcher.yielded === true && launcher.wanted !== '' && launcher.landed.endsWith(launcher.wanted),
    JSON.stringify({ wanted: launcher.wanted, landed: launcher.landed, yielded: launcher.yielded }));
  check('the word dashboard brings it back', launcher.returned === true, String(launcher.returned));
  check('the gutter names the place, and the pane agrees',
    /^DASHBOARD/.test(launcher.gutter) && launcher.paneTitle === 'DASHBOARD',
    JSON.stringify({ gutter: launcher.gutter, pane: launcher.paneTitle }));
  }

  if (await stage('attach')) {
  // The surface holds what a second surface needs: this page reached the
  // daemon by a URL carrying the attach token, so `attach` can say how to
  // reach the same session from a terminal or another browser without
  // asking the session anything. The token is a bearer credential with no
  // expiry, so the masked form must never carry it.
  const attach = await evalIn(`
    await console_idle();
    
    const input = console_input();
    const say = async (line, ms) => { const before = console_mark(); input.value = line;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled();
      return console_since(before, '\\n'); };
    const token = new URLSearchParams(location.search).get('token') ?? '';
    const masked = await say('attach', 2200);
    const revealed = await say('attach --reveal', 2200);
    return {
      token: token === '' ? null : token.length,
      masked, revealed,
      leaks: token !== '' && masked.includes(token),
      reveals: token !== '' && revealed.includes(token),
      remote: /chell --remote/.test(masked),
      byAddress: /chell --remote --attach "http/.test(masked),
    };`);
  check('attach says how to reach this session from a terminal and another browser',
    attach.remote === true && attach.byAddress === true, attach.masked?.slice(0, 120));
  check('the masked form never carries the token, and --reveal does',
    attach.token !== null && attach.leaks === false && attach.reveals === true,
    JSON.stringify({ tokenLength: attach.token, leaks: attach.leaks, reveals: attach.reveals }));
  }

  if (await stage('pane-ask')) {
  // A question the surface asks stands on the pane that asked it. The
  // console is closed here on purpose: that is the state the question used
  // to vanish into, taking the press with it and leaving the surface
  // waiting on something nobody could see.
  const asked = await evalIn(`
    await console_idle();
    document.getElementById('gutter-files').click(); await sleep(700);
    const drawerEl = document.getElementById('drawer');
    if (!drawerEl.classList.contains('drawer-closed')) { document.getElementById('drawer-toggle').click(); await sleep(400); }
    const pane = document.querySelector('.pane-files');
    pane.querySelector('.files-mkdir').click(); await sleep(500);
    const bar = pane.querySelector('.ask-bar');
    const asks = [...document.querySelectorAll('#terminal .argus-ask')].map((e) => e.textContent.trim());
    const state = {
      onPane: bar !== null,
      words: bar?.querySelector('.ask-bar-caption')?.textContent ?? '',
      tall: bar?.getBoundingClientRect().height ?? 0,
      focused: document.activeElement?.className ?? '',
      commit: bar?.querySelector('.ask-bar-commit')?.textContent ?? '',
      noted: asks.some((line) => line.includes('New directory')),
      consoleClosed: drawerEl.classList.contains('drawer-closed') && drawerEl.getBoundingClientRect().height < 1,
    };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
    state.leftOnAbandon = pane.querySelector('.ask-bar') === null;
    return state;`);
  check('a question the surface asks stands on the pane that asked, not in a closed console',
    asked.onPane === true && asked.consoleClosed === true && asked.tall > 10
    && asked.words.includes('New directory') && asked.commit === 'MAKE IT',
    JSON.stringify(asked));
  check('the question takes the keyboard, the console keeps the exchange, and Esc abandons it',
    asked.focused === 'ask-bar-field' && asked.noted === true && asked.leftOnAbandon === true,
    JSON.stringify(asked));
  }

  if (await stage('question-both-places')) {
  // A question on a pane stands on the console's line too (#826): answered
  // on the pane, the console records it and frees its line; answered at the
  // console, the pane's bar goes. Nothing typed at the prompt runs as a
  // command while a question waits.
  const both = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms = 300) => { await console_run(line); await sleep(ms); };
    const settle = async (want, tries = 60) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    document.getElementById('gutter-files').click(); await sleep(700);
    const held = () => ({ glyph: document.querySelector('#terminal .argus-input-glyph')?.textContent ?? null, open: [...document.querySelectorAll('#terminal .argus-ask:not(.argus-ask-answered)')].map((b) => b.textContent.trim().slice(0, 50)), blocks: document.querySelectorAll('#terminal .argus-ask').length, cwd: window.__argusPromptContext?.cwd ?? null });
    const diag = { start: held() };
    await say('rm -r ~/smoke-both', 2000); await say('mkdir -p ~/smoke-both', 2000); await say('cd ~/smoke-both', 2000);
    diag.afterCd = held();
    const pane = [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    diag.panes = document.querySelectorAll('.pane-files').length;
    const named = (n) => [...pane.querySelectorAll('.files-row')].find((r) => r.querySelector('.files-name')?.textContent.trim() === n);
    const lastAsk = () => [...document.querySelectorAll('#terminal .argus-ask')].pop();
    // The pane follows the cwd by a listing of its own, which lands after the
    // prompt does: MKDIR asks in the place the pane SHOWS, so the pane is
    // looked at before it is pressed, as an operator would.
    const here = () => pane.querySelector('.files-crumb-here')?.textContent?.trim() ?? '';
    const paneAt = async (leaf) => settle(() => here() === leaf, 120);
    diag.paneFollowed = await paneAt('smoke-both');
    // 1. a text question answered ON THE PANE
    pane.querySelector('.files-mkdir').click(); await sleep(500);
    diag.afterClick = { ...held(), bars: pane.querySelectorAll('.ask-bar').length, caption: pane.querySelector('.ask-bar-caption')?.textContent ?? null, here: here() };
    const askedBoth = pane.querySelector('.ask-bar') !== null && /New directory/.test(lastAsk()?.textContent ?? '');
    pane.querySelector('.ask-bar-field').value = 'on-pane';
    pane.querySelector('.ask-bar-commit').click();
    const paneMade = await settle(() => named('on-pane') !== undefined, 120);
    diag.afterCommit = { ...held(), bars: pane.querySelectorAll('.ask-bar').length, here: here() };
    const consoleRecorded = /on-pane/.test(lastAsk()?.querySelector('.ask-answer')?.textContent ?? '');
    // Where the console stands when it fails to record (#919): its glyph (? = a
    // question of its own is open), the questions it still holds unanswered.
    const consoleState = {
      glyph: document.querySelector('#terminal .argus-input-glyph')?.textContent ?? [...document.querySelectorAll('#terminal span')].map((s) => s.textContent).find((t) => t === '?' || t === '❯') ?? null,
      open: [...document.querySelectorAll('#terminal .argus-ask:not(.argus-ask-answered)')].map((b) => b.textContent.trim().slice(0, 60)),
      asks: document.querySelectorAll('#terminal .argus-ask').length,
      lastAsk: lastAsk()?.textContent.trim().slice(0, 80) ?? null,
      diag,
    };
    // 2. a text question answered AT THE CONSOLE (the mkdir's prompt comes back first)
    await console_run('');
    await paneAt('smoke-both');
    pane.querySelector('.files-mkdir').click(); await sleep(500);
    await say('at-console', 300);
    const consoleMade = await settle(() => named('at-console') !== undefined, 120);
    const barGone = pane.querySelector('.ask-bar') === null;
    diag.afterConsoleAnswer = { ...held(), tail: [...document.querySelectorAll('#terminal .argus-output > *')].slice(-4).map((b) => b.className + ': ' + b.textContent.trim().slice(0, 90)), rows: [...pane.querySelectorAll('.files-row .files-name')].map((n) => n.textContent.trim()).slice(0, 8), here: here() };
    // 3. a confirm answered ON THE PANE (a file: rm -i asks once; a
    // directory's rm -ri asks to descend and then to remove, as POSIX does)
    await say('touch ~/smoke-both/confirm.txt', 300); await say('ls', 300);
    await settle(() => named('confirm.txt') !== undefined, 120);
    named('confirm.txt').querySelector('.files-name').dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(500);
    [...pane.querySelectorAll('.files-row-zone .listing-action')].find((b) => b.textContent.trim() === 'DELETE')?.click();
    await settle(() => pane.querySelector('.ask-bar-yes') !== null, 40);
    pane.querySelector('.ask-bar-yes')?.click();
    const removed = await settle(() => named('confirm.txt') === undefined, 120);
    const confirmRecorded = /\\by\\b|yes/i.test(lastAsk()?.querySelector('.ask-answer')?.textContent ?? '');
    await say('cd ~', 300); await say('rm -r ~/smoke-both', 300);
    return { askedBoth, paneMade, consoleRecorded, consoleMade, barGone, removed, confirmRecorded, consoleState };`);
  check('a pane question stands on the console too; answered on the pane, the console records it',
    both.askedBoth && both.paneMade && both.consoleRecorded, JSON.stringify(both));
  check('answered at the console, the pane question is answered and its bar goes — nothing runs as a command',
    both.consoleMade && both.barGone, JSON.stringify(both));
  check('a confirm answered on the pane acts, and the console records the answer',
    both.removed && both.confirmRecorded, JSON.stringify(both));
  }

  if (await stage('edit-pane')) {
  // The kernel's edit answered with a pane (#831): the file in a guest field,
  // SAVE and REVERT on the frame, and every save a touch line in the console
  // that the kernel reads back character for character.
  const edited = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms = 1500) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const settle = async (want, tries = 60) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    document.getElementById('gutter-files').click(); await sleep(700);
    await say("touch --withContents 'line one' ~/smoke-edit.txt", 2500);
    await say('edit ~/smoke-edit.txt', 500);
    const shownPane = () => [...document.querySelectorAll('.pane-edit')].find((p) => p.offsetParent !== null);
    const opened = await settle(() => shownPane()?.querySelector('.cm-content') !== null && shownPane()?.querySelector('.cm-content') !== undefined);
    const pane = shownPane();
    const state = () => pane?.querySelector('.pane-state')?.textContent ?? '';
    const content = pane?.querySelector('.cm-content');
    const text = () => [...(pane?.querySelectorAll('.cm-line') ?? [])].map((l) => l.textContent).join('\\n');
    const answered = /opened in the editor/.test(console_text());
    const openState = state();
    const saveDimmed = pane?.querySelector('.edit-save')?.disabled === true;
    const titled = pane?.querySelector('.pane-title')?.textContent ?? '';
    // type at the end of the file: a second line with every hard character
    content?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); content?.focus(); await sleep(200);
    const focusLit = pane?.querySelector('.edit-focus')?.hidden === false;
    const sel = window.getSelection(); sel.selectAllChildren(content); sel.collapseToEnd();
    document.execCommand('insertText', false, "\\nline two $HOME @1 it's a\\\\b; x | y > z");
    await sleep(300);
    const dirtyState = state();
    const saveLit = pane?.querySelector('.edit-save')?.disabled === false;
    content?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    const saved = await settle(() => state() === 'SAVED', 40);
    const echoes = console_echoes();
    const saveLine = echoes.reverse().find((e) => /touch --withContents/.test(e)) ?? '';
    await say('cat ~/smoke-edit.txt', 2500);
    const results = console_text();
    const readBack = results.includes("line two $HOME @1 it's a\\\\b; x | y > z");
    // REVERT throws away what was typed since the save
    content?.focus(); sel.selectAllChildren(content); sel.collapseToEnd();
    document.execCommand('insertText', false, ' DISCARD');
    await sleep(300);
    pane?.querySelector('.edit-revert')?.click(); await sleep(300);
    const reverted = !text().includes('DISCARD') && state() === 'SAVED';
    // Esc gives the keyboard back, and the FOCUS mark goes
    content?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); content?.focus(); await sleep(200);
    const heldBefore = pane?.querySelector('.edit-focus')?.hidden === false;
    content?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await sleep(300);
    const released = heldBefore && pane?.querySelector('.edit-focus')?.hidden === true && !pane.contains(document.activeElement);
    // a second edit of the same file finds its pane
    await say('edit ~/smoke-edit.txt', 2500);
    const onePane = [...document.querySelectorAll('.pane-edit')].filter((p) => p.offsetParent !== null).length === 1;
    await say('rm ~/smoke-edit.txt', 2000);
    pane?.querySelector('.drawer-close')?.click(); await sleep(400);
    return { opened, answered, openState, saveDimmed, titled, focusLit, dirtyState, saveLit, saved, saveLine: saveLine.slice(0, 160), readBack, reverted, released, onePane };`);
  check('edit opens an EDIT pane beside the focused one, answered "opened in the editor", SAVED with SAVE dimmed',
    edited.opened && edited.answered && edited.openState === 'SAVED' && edited.saveDimmed && edited.titled === 'EDIT SMOKE-EDIT.TXT', JSON.stringify(edited));
  check('typing lights DIRTY and SAVE; Ctrl-S saves by a touch line in the console, and the kernel reads every character back',
    edited.focusLit && edited.dirtyState === 'DIRTY' && edited.saveLit && edited.saved && /touch --withContents='/.test(edited.saveLine) && edited.readBack, JSON.stringify(edited));
  check('an edit pane: REVERT throws away unsaved text, Esc gives the keyboard back, a second edit finds the pane',
    edited.reverted && edited.released && edited.onePane, JSON.stringify(edited));
  }

  if (await stage('feed-tags')) {
  // A feed's tags (#831): TAG asks with the user's tags as pills and a field
  // for a new one (mkdir then setfattr, visible lines), the roster marks the
  // feed, a mark's press filters by its tag, the graph's frame shows the
  // marks and NOTE, and × takes a tag off. Feed SMOKE_DAG_FEED, a throwaway tag.
  const feed = process.env.SMOKE_DAG_FEED ?? fixtureFeed ?? '880';
  const tagged = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms = 1500) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const settle = async (want, tries = 60) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    const TAG = 'smoke-tag-${Date.now() % 100000}';
    document.getElementById('gutter-runs').click(); await sleep(1200);
    const dp = [...document.querySelectorAll('.pane-dag')].find(p => p.offsetParent !== null);
    const row = () => dp.querySelector('.feedlist-row[data-feed="${feed}"]');
    await say('runs filter id:${feed}', 1500);
    await settle(() => row() !== null);
    row().querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const zone = () => dp.querySelector('.runs-row-zone');
    await settle(() => [...(zone()?.querySelectorAll('.listing-action') ?? [])].some(b => b.textContent.trim() === 'TAG'));
    const verbs = [...zone().querySelectorAll('.listing-action')].map(b => b.textContent.trim());
    [...zone().querySelectorAll('.listing-action')].find(b => b.textContent.trim() === 'TAG').click();
    const bar = () => dp.querySelector('.ask-bar');
    const asked = await settle(() => bar() !== null);
    const done = bar()?.querySelector('.ask-bar-abandon')?.textContent?.trim() ?? '';
    bar().querySelector('.ask-bar-field').value = TAG;
    bar().querySelector('.ask-bar-commit').click();
    // the question comes back with the new tag held
    const reasked = await settle(() => bar()?.querySelector('.ask-bar-held[data-value="' + TAG + '"]') != null, 80);
    const echoes = () => console_echoes();
    const madeLine = echoes().some(e => e.includes("mkdir '/proc/tags/" + TAG + "'"));
    const setLine = echoes().some(e => e.includes("setfattr -n tag -v '" + TAG + "' feed_${feed}"));
    bar()?.querySelector('.ask-bar-abandon')?.click(); await sleep(400);
    const marked = await settle(() => row()?.querySelector('.feedlist-tag[data-tag="' + TAG + '"]') != null, 80);
    // a mark's press filters the roster by its tag
    row()?.querySelector('.feedlist-tag[data-tag="' + TAG + '"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(800);
    const filterText = dp.querySelector('.roster-filter-input')?.value ?? '';
    const onlyTagged = [...dp.querySelectorAll('.feedlist-row')].every(r => r.querySelector('.feedlist-tag[data-tag="' + TAG + '"]') !== null);
    // enter the feed: the frame shows the mark and NOTE
    row()?.querySelector('.feedlist-control')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const entered = await settle(() => dp.querySelector('.dag-marks .feedlist-tag[data-tag="' + TAG + '"]') !== null, 120);
    const noteLabel = dp.querySelector('.dag-note')?.textContent?.trim() ?? '';
    const tagShown = dp.querySelector('.dag-tag')?.hidden === false;
    // × takes it off, and the frame reads again
    dp.querySelector('.dag-marks .feedlist-tag[data-tag="' + TAG + '"] .feedlist-tag-x')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const removed = await settle(() => dp.querySelector('.dag-marks .feedlist-tag[data-tag="' + TAG + '"]') === null, 80);
    const untagLine = echoes().some(e => e.includes("setfattr -x tag -v '" + TAG + "' feed_${feed}"));
    await say('rmdir /proc/tags/' + TAG, 2500);
    await say('runs filter off', 800);
    dp.querySelector('.dag-back')?.click(); await sleep(600);
    return { verbs, asked, done, reasked, madeLine, setLine, marked, filterText, onlyTagged, entered, noteLabel, tagShown, removed, untagLine };`);
  check('TAG asks with the tags as pills and a field; a new tag runs mkdir then setfattr, and the question comes back with it held',
    tagged.verbs.includes('TAG') && tagged.verbs.includes('NOTE') && tagged.asked && tagged.done === 'DONE' && tagged.madeLine && tagged.setLine && tagged.reasked, JSON.stringify(tagged));
  check("the roster marks the feed with its tag, and a mark's press filters the roster by it",
    tagged.marked && /^tag:smoke-tag-/.test(tagged.filterText) && tagged.onlyTagged, JSON.stringify(tagged));
  check("the graph's frame shows the feed's marks and NOTE; × takes a tag off by a visible setfattr -x",
    tagged.entered && /NOTE$/.test(tagged.noteLabel) && tagged.tagShown && tagged.removed && tagged.untagLine, JSON.stringify(tagged));
  }

  if (await stage('edit-row')) {
  // EDIT on a text file's row (#831): the kernel's edit, as a visible line,
  // opens the editor pane on the file; a binary file is offered no EDIT.
  const row = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms = 1500) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const settle = async (want, tries = 60) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    document.getElementById('gutter-files').click(); await sleep(700);
    await say('mkdir -p ~/smoke-edit-row', 2000);
    await say("touch --withContents='row text' ~/smoke-edit-row/notes.yaml", 2500);
    await say("touch --withContents='x' ~/smoke-edit-row/scan.dcm", 2500);
    await say('cd ~/smoke-edit-row', 2000);
    const pane = [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    const named = (n) => [...pane.querySelectorAll('.files-row')].find((r) => r.querySelector('.files-name')?.textContent.trim() === n);
    await settle(() => named('notes.yaml') !== undefined && named('scan.dcm') !== undefined);
    const verbsOf = async (n) => {
      named(n).querySelector('.files-name').dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(500);
      return [...pane.querySelectorAll('.files-row-zone .listing-action')].map((b) => b.textContent.trim());
    };
    const binaryVerbs = await verbsOf('scan.dcm');
    const textVerbs = await verbsOf('notes.yaml');
    [...pane.querySelectorAll('.files-row-zone .listing-action')].find((b) => b.textContent.trim() === 'EDIT')?.click();
    const opened = await settle(() => [...document.querySelectorAll('.pane-edit')].some((p) => p.offsetParent !== null && /row text/.test(p.querySelector('.cm-content')?.textContent ?? '')), 80);
    const echoed = console_echoes().some((line) => /edit '.*smoke-edit-row\\/notes\\.yaml'/.test(line));
    [...document.querySelectorAll('.pane-edit')].find((p) => p.offsetParent !== null)?.querySelector('.drawer-close')?.click(); await sleep(400);
    await say('cd ~', 1500); await say('rm -r ~/smoke-edit-row', 2500);
    return { binaryVerbs, textVerbs, opened, echoed };`);
  check('a text file offers EDIT, a binary one does not; EDIT opens the editor by a visible edit line',
    row.textVerbs.includes('EDIT') && !row.binaryVerbs.includes('EDIT') && row.opened && row.echoed, JSON.stringify(row));
  }

  if (await stage('feed-share')) {
  // A feed's sharing and name (#853): SHARE asks with the operator's groups
  // and EVERYONE as pills; a pick runs setfacl and comes back held; the
  // holders are marks on the row, each × asking before it withdraws; RENAME
  // asks for the name and writes the title. Feed SMOKE_DAG_FEED, the
  // operator's personal group (it holds only them), restored at the end.
  const feed = process.env.SMOKE_DAG_FEED ?? fixtureFeed ?? '880';
  const shared = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line, ms = 1500) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const settle = async (want, tries = 60) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    const me = window.__argusPromptContext?.user ?? '';
    document.getElementById('gutter-runs').click(); await sleep(1200);
    const dp = [...document.querySelectorAll('.pane-dag')].find(p => p.offsetParent !== null);
    const row = () => dp.querySelector('.feedlist-row[data-feed="${feed}"]');
    await say('runs filter id:${feed}', 1500);
    await settle(() => row() !== null);
    const indicate = () => row().querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    indicate();
    const zone = () => dp.querySelector('.runs-row-zone');
    const verb = (name) => [...(zone()?.querySelectorAll('.listing-action') ?? [])].find(b => b.textContent.trim() === name);
    await settle(() => verb('SHARE') !== undefined);
    const readout = () => zone()?.querySelector('.listing-readout')?.textContent ?? '';
    await settle(() => readout() !== '');
    const before = readout();
    const echoes = () => console_echoes();
    const bar = () => dp.querySelector('.ask-bar');
    verb('SHARE').click();
    await settle(() => bar() !== null);
    const pills = [...bar().querySelectorAll('.ask-bar-choice')].map(p => p.textContent.trim());
    const mine = bar().querySelector('.ask-bar-choice[data-value="g:' + me + ':r"]');
    if (mine === null) { bar().querySelector('.ask-bar-abandon').click(); await home_return(); return { skipped: 'no personal group named ' + me, pills }; }
    mine.click();
    const groupHeld = await settle(() => bar()?.querySelector('.ask-bar-held[data-value="g:' + me + ':r"]') != null, 80);
    bar().querySelector('.ask-bar-choice[data-value="o::r"]').click();
    const publicHeld = await settle(() => bar()?.querySelector('.ask-bar-held[data-value="o::r"]') != null, 80);
    const grantLines = echoes().some(e => e.includes("setfacl -m g:" + me + ":r feed_${feed}")) && echoes().some(e => e.includes('setfacl -m o::r feed_${feed}'));
    bar().querySelector('.ask-bar-abandon').click(); await sleep(400);
    const marked = await settle(() => /group /.test(readout()) && /PUBLIC/.test(readout()), 80);
    // × on each, answering yes on the pane
    const removeMark = async (cls) => {
      zone().querySelector('.holder-mark.' + cls + ' .holder-mark-x')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(() => dp.querySelector('.ask-bar-yes') !== null, 40);
      const asked = dp.querySelector('.ask-bar-caption')?.textContent ?? '';
      dp.querySelector('.ask-bar-yes')?.click();
      return asked;
    };
    const askedGroup = await removeMark('holder-group');
    // A readout mid-refresh is empty for a moment: wait for the marks to stand again.
    await settle(() => readout() !== '' && !/group /.test(readout()) && zone().querySelector('.holder-mark.holder-public') !== null, 80);
    const askedPublic = await removeMark('holder-public');
    const restored = await settle(() => /SHARED WITH NOBODY/.test(readout()), 80);
    const revokeLines = echoes().some(e => e.includes("setfacl -x g:'" + me + "' feed_${feed}")) && echoes().some(e => e.includes('setfacl -m o::- feed_${feed}'));
    // Whatever the checks saw, the feed leaves as it came: no group, not public.
    await say('setfacl -x g:' + me + ' feed_${feed}', 2000); await say('setfacl -m o::- feed_${feed}', 2000);
    // RENAME, and back
    const title = row().querySelector('.feedlist-title-text, .feedlist-title').textContent.trim();
    indicate(); await settle(() => verb('RENAME') !== undefined);
    verb('RENAME').click(); await settle(() => bar() !== null);
    const suggested = bar().querySelector('.ask-bar-field').value;
    bar().querySelector('.ask-bar-field').value = title + ' smoke';
    bar().querySelector('.ask-bar-commit').click();
    const renamed = await settle(() => (row()?.querySelector('.feedlist-title')?.textContent ?? '').includes(title + ' smoke'), 80);
    await say("touch --withContents='" + title + "' /proc/jobs/feed_${feed}/title", 2500);
    await say('runs filter off', 800);
    // Leave the roster as it came: RENAME left the row indicated (the frame
    // open, every other row dimmed), and the stages after this one measure
    // a roster at rest. A press off the listing stands it down.
    document.getElementById('status-strip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(() => dp.querySelectorAll('.listing-indicated, .listing-activating').length === 0, 20);
    return { pills, groupHeld, publicHeld, grantLines, marked, askedGroup, askedPublic, restored, revokeLines, before, suggested, title, renamed };`)
  if (shared.skipped !== undefined) {
    console.log('  skip  feed sharing (' + shared.skipped + ')');
  } else {
    check('SHARE offers the groups and EVERYONE as pills; each pick runs setfacl and comes back held',
      shared.pills.includes('EVERYONE') && shared.groupHeld && shared.publicHeld && shared.grantLines, JSON.stringify(shared));
    check("the holders are marks on the row; each × asks, then withdraws by a visible line",
      shared.marked && /Stop sharing feed_\d+ with group /.test(shared.askedGroup) && /with PUBLIC/.test(shared.askedPublic) && shared.restored && shared.revokeLines, JSON.stringify(shared));
    check('RENAME asks with the name it has, and the roster shows the new one',
      shared.suggested === shared.title && shared.renamed, JSON.stringify(shared));
  }
  }

  if (await stage('contrast')) {
  // The frame's type, measured against WCAG 2.1 AA in every scheme.
  //
  // docs/WCAG-AA.adoc records the audit that found and fixed three defects;
  // until now it was a document, so nothing stopped the next pairing from
  // regressing. This walks what is actually on stage, composites every
  // translucent layer between the type and its first opaque ground (a chip
  // painted black at .72 over gold IS the type's ground; skipping it
  // measures a pairing that is not on screen), and holds each to its own
  // threshold: 3:1 for large text, 24px or 18.66px bold and up, 4.5:1 for
  // the rest.
  //
  // Scope is the frame that carries type, as the audit's is: the console's
  // scrollback is the session's own output and wears the daemon's ANSI, not
  // the theme's palette.
  const contrast = await evalIn(`
    await console_idle();
    const FRAME = [
      '.lcars-title', '.pane-state', '.pane-mode', '.lcars-bar-horizontal',
      '.roster-cap', '.listing-action', '.strategy-pill', '.pacs-capsule',
      '.files-name', '.files-type', '.files-path', '.files-binding',
      '.feedlist-title', '.feedlist-status', '.feedlist-id',
      '.telemetry-label', '.telemetry-value', '.left-frame button',
      '.drawer-label', '.drawer-child', '.lamp-online', '.lamp-host',
    ].join(', ');
    const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const parse = (text) => { const m = text.match(/rgba?\\(([^)]+)\\)/); if (m === null) return null;
      const p = m[1].split(',').map(Number); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }; };
    const over = (top, base) => top.rgb.map((c, i) => c * top.a + base[i] * (1 - top.a));
    const ratio = (a, b) => { const la = lum(a); const lb = lum(b);
      const hi = Math.max(la, lb); const lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
    const ground = (el) => {
      const layers = []; let node = el;
      while (node !== null) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg !== null && bg.a > 0) { layers.push(bg); if (bg.a === 1) break; }
        node = node.parentElement;
      }
      let base = [0, 0, 0];
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const ownText = (el) => [...el.childNodes]
      .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    const opacityOf = (el) => { let o = 1; let node = el;
      while (node !== null && node !== document.body) { o *= parseFloat(getComputedStyle(node).opacity); node = node.parentElement; }
      return o; };
    const sweep = () => {
      const seen = [];
      for (const el of document.querySelectorAll(FRAME)) {
        const text = ownText(el);
        if (text === '') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2 || el.offsetParent === null) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden') continue;
        const alpha = opacityOf(el);
        if (alpha < 0.05) continue;
        const fg = parse(cs.color);
        if (fg === null) continue;
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        const bg = ground(el);
        const ink = over({ rgb: fg.rgb, a: fg.a * alpha }, bg);
        const r = ratio(ink, bg);
        if (r + 0.005 < need) {
          seen.push({ text: text.slice(0, 22), cls: (el.className || el.tagName).toString().slice(0, 34),
            px: Math.round(size * 10) / 10, need, ratio: Math.round(r * 100) / 100 });
        }
      }
      return seen;
    };
    const schemes = ['lower-decks', 'gold', 'medical', 'nemesis', 'pharos'];
    const root = document.documentElement;
    const before = root.dataset.theme;
    const out = {};
    for (const scheme of schemes) {
      if (scheme === 'lower-decks') delete root.dataset.theme; else root.dataset.theme = scheme;
      await sleep(700);
      out[scheme] = sweep();
    }
    if (before === undefined) delete root.dataset.theme; else root.dataset.theme = before;
    await sleep(500);
    return out;`);
  const themes = Object.keys(contrast);
  const failing = themes.filter((theme) => contrast[theme].length > 0);
  const detail = failing.map((theme) => `${theme}: ${contrast[theme].slice(0, 4).map((f) => `${f.cls} "${f.text}" ${f.ratio}<${f.need}`).join(' | ')}`).join('  ·  ');
  check('every pairing the frame paints clears WCAG AA, in all five schemes',
    failing.length === 0, detail === '' ? JSON.stringify(themes) : detail);
  }

  if (await stage('frame-alone')) {
  // A session over a backend with no composition of its own has the frame
  // alone (#985): its own tiles, no RUNS or PACS in the gutter, no GATHER,
  // no index instrument, a files pane over the session's store, and the
  // language with no ChRIS word. Under ChRIS the same page says ChRIS.
  const alone = await evalIn(`
    await console_idle();
    const shown = (id) => { const e = document.getElementById(id); return e !== null && e.offsetParent !== null && getComputedStyle(e).display !== 'none'; };
    document.getElementById('gutter-dashboard')?.click();
    for (let i = 0; i < 40 && document.querySelectorAll('.launcher-tile').length === 0; i++) await sleep(250);
    const tiles = [...document.querySelectorAll('.launcher-tile .launcher-name')].map((e) => e.textContent);
    // The index instrument sits in a header face that may itself be away;
    // what the composition decides is whether its own rule hides it.
    const ruled = (id) => { const e = document.getElementById(id); return e !== null && getComputedStyle(e).display !== 'none'; };
    const marks = { runs: shown('gutter-runs'), pacs: shown('gutter-tools'), gather: shown('header-gather-pill'), index: ruled('index-instrument') };
    // The frame's own posture before Esc: the header's brand and the console
    // drawer on stage, whatever the composition (the ChRIS landing zooms only
    // on its first visit, which the boot stage stepped out of).
    const onStage = (sel) => { const e = document.querySelector(sel); if (e === null) return false; const r = e.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
    const posture = { brand: onStage('.wrap:not(#gap) .brand-label'), drawer: onStage('#drawer'), zoom: document.body.dataset.zoom ?? null, tdMark: onStage('.brand-mark-td') };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400);
    const input = console_input();
    input.value = 'view runs'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const output = () => console_text();
    for (let i = 0; i < 20 && !/view: unknown given/.test(output()); i++) await sleep(250);
    const said = (output().match(/view: unknown given[^\\n]*/) ?? [''])[0];
    document.getElementById('gutter-files').click(); await sleep(400);
    return { composition: document.body.dataset.composition ?? null, tiles, marks, posture, viewRuns: said };`);
  if (alone.composition === 'chris') {
    check('under ChRIS the page draws ChRIS: RUNS and PACS in the gutter, its tiles, its index instrument',
      alone.marks.runs && alone.marks.pacs && alone.marks.index && alone.tiles.includes('ANALYSES'), JSON.stringify(alone));
  } else {
    // The frame's five tiles stand in order; a composition of its own
    // (stratus: OPENSHIFT, CAPACITY) adds tiles of its own among them.
    const frameTiles = ['FILES', 'PANES', 'KEYS', "WHAT'S NEW", 'CONSOLE'];
    const ownTiles = alone.composition === 'stratus' ? ['OPENSHIFT', 'CAPACITY'] : [];
    check('a session with no ChRIS composition has the frame\'s five tiles and its own, no RUNS, PACS, GATHER or index instrument',
      JSON.stringify(alone.tiles.filter((name) => !ownTiles.includes(name))) === JSON.stringify(frameTiles) && !alone.marks.runs && !alone.marks.pacs && !alone.marks.gather && !alone.marks.index, JSON.stringify(alone));
    check('a frame-alone session keeps its header brand and console drawer on stage at the dashboard',
      alone.posture.brand && alone.posture.drawer && alone.posture.zoom === null && (alone.composition !== 'stratus' || alone.posture.tdMark), JSON.stringify(alone.posture));
    check('the frame alone speaks no ChRIS word: view runs is refused by name', /view: unknown given 'runs' \(files\)/.test(alone.viewRuns), JSON.stringify(alone.viewRuns.slice(0, 200)));
  }
  }

  if (await stage('stratus-tiles')) {
  // The stratus composition's tiles (compositions/stratus/tiles.ts): OPENSHIFT
  // leads with the clusters `cluster status` names, CAPACITY follows FILES
  // with what `capacity` reads. Under any other composition neither stands.
  const tiles = await evalIn(`
    await console_idle();
    document.getElementById('gutter-dashboard')?.click();
    for (let i = 0; i < 60 && document.querySelectorAll('.launcher-tile').length === 0; i++) await sleep(250);
    await sleep(1500);
    const named = [...document.querySelectorAll('.launcher-tile')].map((t) => ({ name: t.querySelector('.launcher-name')?.textContent ?? '', rows: t.querySelectorAll('.launcher-row').length, figures: [...t.querySelectorAll('.launcher-figure')].map((f) => f.textContent.trim()) }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400);
    document.getElementById('gutter-files')?.click(); await sleep(400);
    return { composition: document.body.dataset.composition ?? null, named };`);
  const names = tiles.named.map((t) => t.name);
  if (tiles.composition === 'stratus') {
    const clusters = tiles.named.find((t) => t.name === 'OPENSHIFT');
    const capacity = tiles.named.find((t) => t.name === 'CAPACITY');
    check('under stratus the dashboard leads with OPENSHIFT and puts CAPACITY after FILES',
      names[0] === 'OPENSHIFT' && names.indexOf('CAPACITY') === names.indexOf('FILES') + 1, JSON.stringify(names));
    check('OPENSHIFT counts its clusters and lists a row for each; CAPACITY names a region or teaches the line',
      clusters !== undefined && /CLUSTER|NONE/.test(clusters.figures[0] ?? '') && capacity !== undefined && capacity.rows > 0, JSON.stringify({ clusters, capacity }));
  } else {
    check('under any other composition neither OPENSHIFT nor CAPACITY stands', !names.includes('OPENSHIFT') && !names.includes('CAPACITY'), JSON.stringify(names));
  }
  }

  if (await stage('td-controller')) {
  // The TD controller (features/controller/, docs/stratus.adoc D13): under
  // stratus, `cluster` takes the screen with its views, its clusters' pills and
  // its condition in the tab's title, and Esc gives the page back. A screen
  // narrower than the controller's least refuses by name and the console says
  // so. Under any other composition `cluster` is the session's own.
  const td = await evalIn(`
    await console_idle();
    if (document.body.dataset.composition !== 'stratus') return { composition: document.body.dataset.composition ?? null };
    const titleBefore = document.title;
    const input = console_input();
    input.value = 'cluster'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 40 && document.body.dataset.takeover !== 'controller' && !/needs a screen/.test(console_text()); i++) await sleep(250);
    const opened = document.body.dataset.takeover === 'controller';
    if (!opened) {
      for (let i = 0; i < 40 && !/no clusters|cluster status prints|built here|checkout|adopted/.test(console_text()); i++) await sleep(250);
      return { composition: 'stratus', opened, narrow: innerWidth < 1250, said: (console_text().match(/cluster: the controller needs[^\\n]*/) ?? [''])[0], text: /no clusters|built here|checkout|adopted/.test(console_text()) };
    }
    for (let i = 0; i < 60 && (window.__argusController?.heard().reads ?? 0) === 0; i++) await sleep(250);
    const views = [];
    for (const view of ['overview', 'size', 'build', 'cluster', 'chris', 'teardown']) {
      document.querySelector('.tdc-view-' + view)?.click(); await sleep(300);
      views.push({ view: window.__argusController?.view() ?? null, sections: document.querySelectorAll('.tdc-body > section, .tdc-body > div').length });
    }
    const pills = [...document.querySelectorAll('.tdc-cluster')].map((pill) => pill.textContent);
    const hidden = [...document.body.children].filter((node) => node.id !== 'td-controller' && getComputedStyle(node).visibility !== 'hidden' && node.offsetParent !== null).length;
    const title = document.title;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400);
    return { composition: 'stratus', opened, views, pills, hidden, title, titleBack: document.title === titleBefore, after: document.body.dataset.takeover ?? null, left: document.getElementById('td-controller') !== null };`);
  if (td.composition !== 'stratus') {
    check('under any other composition cluster opens no controller', true, JSON.stringify(td));
  } else if (!td.opened) {
    check('a screen narrower than the controller\'s least refuses by name, and the line runs as text', td.narrow && /needs a screen at least 1250 px wide/.test(td.said) && td.text, JSON.stringify(td));
  } else {
    check('cluster takes the screen as the controller: six views, a pill per cluster and NEW, the condition in the title, the page hidden behind it',
      JSON.stringify(td.views.map((v) => v.view)) === JSON.stringify(['overview', 'size', 'build', 'cluster', 'chris', 'teardown']) && td.views.every((v) => v.sections > 0)
        && td.pills.at(-1) === '+ NEW' && / · /.test(td.title) && td.hidden === 0, JSON.stringify(td));
    check('Esc gives the controller\'s screen back: no takeover, no controller, the tab\'s title as it was', td.after === null && !td.left && td.titleBack, JSON.stringify(td));
  }
  }

  if (await stage('feed-one-view')) {
  // A feed is one view, whichever door opens it (law a-feed-has-one-view):
  // entered from the universe and opened from RUNS, the same feed stands as
  // the same tree, root on top, under the same frame words, with the same
  // facts for the same node; a mode turned through one door stands through
  // the other. The device's feed memory is put back as it was found.
  const oneView = await evalIn(`
    await console_idle();
    const kept = localStorage.getItem('argus.feedview');
    localStorage.removeItem('argus.feedview');
    const input = console_input();
    const say = async (line, ms) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const settle = async (want, tries = 80) => { for (let i = 0; i < tries; i++) { if (want()) return true; await sleep(250); } return want(); };
    const universeOpen = async () => {
      document.getElementById('gutter-dashboard')?.click();
      await settle(() => document.querySelector('.launcher-tile') !== null);
      [...document.querySelectorAll('.launcher-tile')].find((t) => t.querySelector('.launcher-name')?.textContent === 'UNIVERSE')?.querySelector('.launcher-verb')?.click();
      await settle(() => { const p = up(); return p !== undefined && /[1-9]\\d* FEEDS/.test(p.querySelector('.universe-title')?.textContent ?? ''); }, 240);
      await sleep(1500);
    };
    const up = () => [...document.querySelectorAll('.pane-universe')].find((x) => x.offsetParent !== null);
    const runs = () => [...document.querySelectorAll('.pane-dag')].find((x) => x.offsetParent !== null);
    // A node's facts: sweep the field until a press lands on one.
    const facts_of = async (pane, factsSel) => {
      const canvas = pane.querySelector('canvas'); const r = canvas.getBoundingClientRect();
      for (let y = 0.15; y < 0.95; y += 0.04) for (let x = 0.2; x < 0.9; x += 0.03) {
        const cx = r.left + r.width * x, cy = r.top + r.height * y;
        // One press only: a pointer pair and a click on the same node read
        // as a double press, which dives into the node and leaves its overlay up.
        canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        await sleep(40);
        const f = pane.querySelector(factsSel);
        if (f && f.querySelector('.telemetry-row')) return { rows: [...f.querySelectorAll('.telemetry-label')].map((e) => e.textContent), line: f.querySelector('.dag-subway') !== null, verbs: [...f.querySelectorAll('.feed-node-verbs button')].map((b) => b.textContent) };
      }
      return null;
    };
    await universeOpen();
    // Of the universe's stores (one per arrangement, and its settings), the
    // one that remembers feeds: a .shapes store a scenario before left
    // first in line holds none, and its first feed id was '' (#1043).
    const feedsIn = (k) => { try { return Object.keys(JSON.parse(localStorage.getItem(k) ?? '{}')).filter((x) => x.startsWith('feed:')).length; } catch { return 0; } };
    const key = Object.keys(localStorage).filter((k) => k.startsWith('argus.universe.') && !k.includes('settings')).sort((a, b) => feedsIn(b) - feedsIn(a)).find((k) => feedsIn(k) > 0);
    const ids = key ? Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}')).filter((k) => k.startsWith('feed:')).map((k) => k.split(':')[1]) : [];
    const feedId = ids[Math.min(3, ids.length - 1)] ?? '';
    const enter = async () => { await say('universe enter ' + feedId, 500); await settle(() => /INSIDE FEED/.test(up()?.querySelector('.universe-title')?.textContent ?? ''), 120); await sleep(1500); };
    await enter();
    const u = up();
    const uWords = { strategy: u.querySelector('.universe-feed-strategy')?.textContent.trim(), metric: u.querySelector('.universe-feed-metric')?.textContent.trim(), hue: u.querySelector('.universe-feed-hue')?.textContent.trim(), draw: u.querySelector('.universe-draw')?.textContent.trim() };
    const uTree = u.querySelector('canvas')?.dataset.rootsTop ?? '';
    const uFacts = await facts_of(u, '.universe-facts');
    // The RUNS door: the RUNS pane opening the same feed itself.
    up()?.querySelector('.universe-back')?.click(); await sleep(1200);
    document.getElementById('gutter-runs')?.click(); await sleep(1200);
    await say('feed diagram feed_' + feedId, 500);
    await settle(() => { const t = runs()?.querySelector('.dag-title')?.textContent ?? ''; return new RegExp('FEED ' + feedId + '\\b').test(t); }, 120);
    await sleep(2500);
    const d = runs();
    const rWords = { strategy: d.querySelector('.dag-strategy')?.textContent.trim(), metric: d.querySelector('.dag-scale')?.textContent.trim(), hue: d.querySelector('.dag-hue')?.textContent.trim(), draw: d.querySelector('.dag-draw')?.textContent.trim() };
    const rTree = d.querySelector('canvas')?.dataset.rootsTop ?? '';
    const rFacts = await facts_of(d, '.dag-facts');
    // CENSUS in RUNS shells every job of the feed: the canvas counts them
    // (a feed view's nodes held out as solid once left it nothing to shell).
    d.querySelector('.dag-census')?.click(); await sleep(2500);
    const rCensus = { words: d.querySelector('.dag-census')?.textContent.trim(), members: Number(d.querySelector('canvas')?.dataset.census ?? -1) };
    d.querySelector('.dag-census')?.click(); await sleep(800);
    // A mode turned in RUNS stands when the universe enters the feed again.
    d.querySelector('.dag-strategy')?.click(); await sleep(400);
    const turned = d.querySelector('.dag-strategy')?.textContent.trim();
    await universeOpen();
    await enter();
    const again = up()?.querySelector('.universe-feed-strategy')?.textContent.trim();
    up()?.querySelector('.universe-back')?.click(); await sleep(1500);
    if (kept === null) localStorage.removeItem('argus.feedview'); else localStorage.setItem('argus.feedview', kept);
    document.getElementById('gutter-files')?.click(); await sleep(600);
    await home_return();
    return { feedId, uWords, rWords, uTree, rTree, uFacts, rFacts, rCensus, turned, again };`);
  // The scenario walks both doors, two universes and a mode turned and
  // turned back; what it leaves in the page broke a later stage that passes
  // alone (the class #873 names). It leaves a fresh page instead: a reload,
  // the session READY again, the full surface as the suite began.
  await page.cdp('Page.reload', { ignoreCache: false });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await evalIn(`
    for (let i = 0; i < 120; i++) { await sleep(500); const m = document.getElementById('drawer-status'); if (m && m.textContent.includes('READY')) break; }
    if (document.body.dataset.zoom === 'launcher') { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400); }
    return true;`);
  check('a feed entered from the universe and opened from RUNS opens as its tree, root on top, under the same frame words (RANKED · TIME · STATUS · SPHERES)',
    oneView.feedId !== '' && oneView.uTree === 'yes' && oneView.rTree === 'yes'
    && JSON.stringify(oneView.uWords) === JSON.stringify(oneView.rWords)
    && oneView.uWords.strategy === 'RANKED' && oneView.uWords.draw === 'SPHERES',
    JSON.stringify({ feedId: oneView.feedId, uWords: oneView.uWords, rWords: oneView.rWords, uTree: oneView.uTree, rTree: oneView.rTree }));
  check('a node picked through either door shows the same facts: the rows, the line of stages, ENTER NODE and PROCESS',
    oneView.uFacts !== null && oneView.rFacts !== null && JSON.stringify(oneView.uFacts) === JSON.stringify(oneView.rFacts)
    && oneView.uFacts.line === true && oneView.uFacts.verbs.includes('ENTER NODE') && oneView.uFacts.verbs.includes('PROCESS'),
    JSON.stringify({ u: oneView.uFacts, r: oneView.rFacts }));
  check('CENSUS in RUNS shells the feed\'s jobs: the census holds a member per job, not none',
    oneView.rCensus?.words === 'CENSUS' && oneView.rCensus.members > 0, JSON.stringify(oneView.rCensus));
  check('a mode turned through one door stands through the other: MOLECULE in RUNS, MOLECULE when the universe enters the feed again',
    oneView.turned === 'MOLECULE' && oneView.again === 'MOLECULE',
    JSON.stringify({ turned: oneView.turned, again: oneView.again }));
  }

  if (await stage('node-dive')) {
  if (!dagFeed) {
    console.log('  skipped: set SMOKE_DAG_FEED=<a feed id whose DAG has at least one node>');
  } else {
    const dive = await evalIn(`
      // A graph needs a pane to stand in: RUNS first, then the feed.
      document.getElementById('gutter-runs').click(); await sleep(1200);
      const input = console_input();
      input.value = 'feed diagram ${dagFeed}';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 160; i++) { await sleep(500); if (document.querySelector('.dag-canvas canvas')) break; }
      await sleep(4500);
      const canvas = document.querySelector('.dag-canvas canvas');
      if (canvas === null) { await home_return(); return { drew: false }; }
      const box = canvas.getBoundingClientRect();
      const facts = () => (document.querySelector('.dag-facts')?.textContent ?? '').replace(/\\s+/g, ' ');
      // Walk down the middle until a click lands on a node.
      let touched = '';
      let redive = null;
      for (const f of [0.42, 0.52, 0.62, 0.72, 0.32]) {
        const at = { clientX: Math.round(box.left + box.width / 2), clientY: Math.round(box.top + box.height * f) };
        const hit = (type) => canvas.dispatchEvent(new MouseEvent(type, { ...at, bubbles: true, cancelable: true }));
        hit('click'); await sleep(500);
        if (facts() !== '') { touched = facts(); hit('dblclick'); redive = () => { hit('click'); hit('dblclick'); }; break; }
      }
      if (touched === '') { await home_return(); return { drew: true, touched: '' }; }
      for (let i = 0; i < 50; i++) { await sleep(400); if (document.querySelector('.node-overlay')) break; }
      await sleep(2500);
      // A node's folder not yet in the session's cache is a walk of CUBE.
      for (let i = 0; i < 60 && (document.querySelector('.node-overlay')?.querySelectorAll('.listing-row').length ?? 0) === 0; i++) await sleep(250);
      const ov = document.querySelector('.node-overlay');
      const inside = {
        opened: ov !== null,
        header: (ov?.getAttribute('aria-label') ?? '').toUpperCase(),
        rows: ov ? ov.querySelectorAll('.listing-row').length : 0,
      };
      // Esc leaves the node and flies the camera home; the scene stays.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(2500);
      const left = document.querySelector('.node-overlay') === null;
      // A phone has no Esc: at the node's root the listing's way up reads
      // EXIT NODE and leaves; EXIT NODE also stands first on the node's frame.
      redive();
      for (let i = 0; i < 50; i++) { await sleep(400); if (document.querySelector('.node-overlay')) break; }
      await sleep(2500);
      const pill = document.querySelector('.node-overlay .node-overlay-exit');
      // On the node's own frame, first among its verbs, inside the node's box.
      const ovBox = document.querySelector('.node-overlay')?.getBoundingClientRect();
      const onFrame = pill?.parentElement?.classList.contains('mode-frame') === true && pill?.parentElement?.firstElementChild === pill;
      const pb = pill?.getBoundingClientRect();
      const pillWhole = onFrame && !!pb && !!ovBox && pb.right <= ovBox.right + 1 && pb.left >= ovBox.left - 1;
      // One frame: no strip of its own above the node's browser.
      const oneFrame = document.querySelectorAll('.node-overlay > *').length === 1;
      const upRow = [...document.querySelectorAll('.node-overlay .listing-row')].find((r) => /EXIT NODE/.test(r.textContent));
      const rowReads = upRow !== undefined;
      (upRow?.querySelector('.listing-name, .row-name') ?? upRow)?.click();
      await sleep(2500);
      await home_return();
      return { drew: true, touched, inside, left,
        pill: { shown: pill !== null, word: pill?.textContent.trim() ?? '', whole: pillWhole, oneFrame, rowReads, left: document.querySelector('.node-overlay') === null },
        keptScene: document.querySelector('.dag-canvas canvas') !== null };`);
    if (dive.drew !== true) {
      console.log('  skipped: the DAG did not draw in time');
    } else if (dive.touched === '') {
      console.log('  skipped: no node lay under the probe clicks');
    } else {
      check('diving into a node opens the node itself, not just an animation',
        dive.inside?.opened === true && /INSIDE /.test(dive.inside?.header ?? ''),
        JSON.stringify(dive.inside));
      check("the node's own filesystem is what the dive arrives at",
        dive.inside?.rows > 0, JSON.stringify(dive.inside));
      check('Esc leaves the node and keeps the scene',
        dive.left === true && dive.keptScene === true, JSON.stringify(dive));
      check('EXIT NODE leaves the node without Esc: the way up at its root reads it, and it stands first on the node\'s own frame (one frame, no strip above)',
        dive.pill?.shown === true && dive.pill?.word === 'EXIT NODE' && dive.pill?.whole === true && dive.pill?.oneFrame === true && dive.pill?.rowReads === true && dive.pill?.left === true && dive.keptScene === true,
        JSON.stringify(dive.pill));
    }
  }
  }

  if (await stage('node-volume')) {
  // Imagery a run produced opens at the address the graph gives for it.
  // Two faults met here: a file click read every non-raster file as text
  // (so a NIfTI in a node answered READ REFUSED), and the kernel could not
  // serve bytes under a /proc projection at all — the proc provider handed
  // its CFS target back to the dispatcher, whose default provider is the
  // host filesystem, which refused it. The browser is walked rather than
  // the graph: the same file click, at the same projected path, without
  // hunting a node under a canvas.
  if (!dagFeed) {
    console.log('  skipped: set SMOKE_DAG_FEED=<a feed id whose DAG has a node holding imagery>');
  } else {
    const volume = await evalIn(`
      await console_idle();
      document.getElementById('gutter-files').click(); await sleep(800);
      const input = console_input();
      const say = async (line, ms) => { input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const pane = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
      const rows = () => [...(pane()?.querySelectorAll('.files-row') ?? [])];
      const name = (r) => r.querySelector('.files-name')?.textContent.trim() ?? '';
      const imagery = () => rows().find((r) => /\\.(nii|nii\\.gz|mgz)$/.test(name(r)));
      const settleRows = async (want) => { for (let i = 0; i < 40; i++) { await sleep(500); if (want()) return true; } return false; };

      // Every node of the feed, until one holds a volume in its own data.
      // The feed's own directory lists its ROOT only (children hang under
      // it), so the node names come from the kernel's tree; each is
      // addressable flat under the feed. The path is the projection:
      // /proc, not /home.
      
      const before = console_mark();
      await say('feed tree ${dagFeed}', 6000);
      const tree = console_since(before, ' ');
      const nodes = [...new Set((tree.match(/pl-[A-Za-z0-9_.-]+_\\d+/g) ?? []))];
      let at = null;
      const seen = [];
      for (const node of nodes) {
        const data = '/proc/jobs/feed_${dagFeed}/' + node + '/data';
        await say('cd "' + data + '"', 3500);
        await settleRows(() => rows().length > 0);
        seen.push([node, rows().map((r) => name(r) + (r.classList.contains('files-type-dir') ? '/' : '')).slice(0, 6)]);
        if (imagery()) { at = node; break; }
        // A copied folder nests under one directory (dircopy flattens its
        // source path into a name): a volume one level down is still the
        // node's imagery.
        // (Not the trail row (~/…) or the way up: only the node's own entries.)
        const dirs = rows().filter((r) => r.classList.contains('files-type-dir') && !/^(\\.\\.|~|\\/)/.test(name(r)));
        if (dirs.length === 1) {
          await say('cd "' + data + '/' + name(dirs[0]).replace(/\\/$/, '') + '"', 3500);
          await settleRows(() => rows().length > 0);
          seen.push([node + '/' + name(dirs[0]), rows().map((r) => name(r)).slice(0, 6)]);
          if (imagery()) { at = node; break; }
        }
      }
      if (at === null) { await home_return(); return { nodes, volume: null, seen }; }
      const found = imagery();
      const volumeName = name(found);
      // In a browser a row with verbs indicates on a click and opens from
      // its control: the kind's glyph is the press that acts.
      found.querySelector('.files-control')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      let viewer = null;
      for (let i = 0; i < 160; i++) { await sleep(500);
        viewer = [...document.querySelectorAll('.pane-image')].find((p) => p.offsetParent !== null);
        if (viewer && /SLICES/.test(viewer.querySelector('.pane-state')?.textContent ?? '')) break; }
      await sleep(1500);
      const state = viewer?.querySelector('.pane-state')?.textContent.trim() ?? null;
      const refused = pane()?.textContent.includes('READ REFUSED') ?? false;
      await home_return();
      return { nodes, node: at, volume: volumeName, state, refused };`);
    if (volume.volume === null) {
      console.log('  skipped: no node of this feed holds a volume ' + JSON.stringify({ nodes: volume.nodes, seen: volume.seen }));
    } else {
      check('a volume under a node opens as an image at its projected address',
        volume.refused === false && /SLICES/.test(volume.state ?? ''),
        JSON.stringify(volume));
    }
  }
  }

  if (await stage('follow-declared')) {
  // The following browser says so on its bar, and the binding is a verb
  // both ways: ROOT HERE drops CWD from the bar, FOLLOW CWD brings it back.
  const follow = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const state = () => fp.querySelector('.pane-state').textContent;
    const atLogin = state();
    const verb = async (label) => { fp.querySelector('.pane-handle').click(); await sleep(150); const cap = [...fp.querySelectorAll('.drawer-cwdbind')].find(c => c.textContent === label); if (!cap) return false; cap.click(); await sleep(400); return true; };
    const rooted = await verb('ROOT HERE'); const afterRoot = state();
    const followed = await verb('FOLLOW CWD'); await sleep(1500); const afterFollow = state();
    return { atLogin, rooted, afterRoot, followed, afterFollow };`);
  check('the following browser says CWD on its bar', /^CWD\b/.test(follow.atLogin));
  check('ROOT HERE and FOLLOW CWD re-bind the browser, and the bar follows', follow.rooted && !/^CWD\b/.test(follow.afterRoot) && follow.followed && /^CWD\b/.test(follow.afterFollow));
  }

  if (await stage('control-homes')) {
  // A control lives where it acts: the drawer acts on the pane, the frame on
  // the field, the row on the row. Each verb is found in its new home, and
  // the browser's drawer is down to two groups.
  const homes = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const frame = fp.querySelector('.mode-frame');
    const onFrame = [...frame.querySelectorAll('.strategy-pill')].map(p => p.textContent.trim());
    fp.querySelector('.pane-handle').click(); await sleep(200);
    const drawer = fp.querySelector('.pane-drawer');
    const groups = [...drawer.querySelectorAll('.drawer-group')].filter(g => g.offsetParent !== null).length;
    const inDrawer = [...drawer.querySelectorAll('button')].map(b => b.textContent.trim());
    const bindsCwd = [...drawer.querySelectorAll('.drawer-cwdbind')].map(b => b.textContent.trim());
    const selected = drawer.querySelector('.drawer-cwdbind.drawer-bind-selected')?.textContent.trim() ?? '';
    fp.querySelector('.pane-handle').click(); await sleep(150);
    return { onFrame, groups, inDrawer, bindsCwd, selected };`);
  check('HOME and BACK live on the frame that answers to the field',
    homes.onFrame.includes('HOME') && homes.onFrame.includes('BACK'));
  check('FOLLOW CWD and ROOT HERE ride the binding group',
    homes.bindsCwd.join(',') === 'FOLLOW CWD,ROOT HERE');
  check('the binding pair reads the browser it states', homes.selected === 'FOLLOW CWD');
  check("a browser's drawer has two groups", homes.groups === 2);
  check('the row verbs left the drawer',
    !homes.inDrawer.includes('DOWNLOAD') && !homes.inDrawer.includes('DELETE')
    && !homes.inDrawer.includes('HOME') && !homes.inDrawer.includes('BACK'));

  // Moving a control must not cost what it did: a rooted browser still walks
  // its own history — HOME lands home, a folder descends, BACK returns.
  const walk = await evalIn(`
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const names = () => [...fp.querySelectorAll('.files-row .files-name')].map(n => n.textContent.trim());
    const settle = async (want) => { for (let i = 0; i < 40; i++) { await sleep(250); if (want()) return true; } return false; };
    const bind = async (follow) => { fp.querySelector('.pane-handle').click(); await sleep(150);
      fp.querySelector('.drawer-cwdbind[data-follow="' + (follow ? 'on' : 'off') + '"]').click();
      await sleep(200); fp.querySelector('.pane-handle').click(); await sleep(150); };
    await bind(false);
    // Settle on a CHANGE, never on a count: the pane already holds a listing
    // when HOME is pressed, so "more than one row" is true before the answer
    // arrives and the walk then measures the previous place.
    const before = names().join(',');
    const bar = () => fp.querySelector('.pane-state')?.textContent ?? '';
    fp.querySelector('.files-home').click();
    await settle(() => names().length > 1 && names().join(',') !== before);
    // A listing served from the cache says STALE on the bar until the
    // session's refresh replaces it in place. Snapshot the FRESH home, or
    // BACK's fresh listing is compared with a picture the surface itself
    // had already corrected.
    await settle(() => !/STALE/.test(bar()));
    const homeBar = bar();
    const home = names();
    // Not a lead row: .. goes up and ~ goes home.
    const folder = fp.querySelector('.files-row.files-type-dir:not(.files-lead-up):not(.files-lead-home)');
    const into = folder?.querySelector('.files-name')?.textContent.trim() ?? '';
    // A directory's OPEN control enters it; its body would select it.
    folder?.querySelector('.listing-control')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(() => names().join(',') !== home.join(','));
    const inside = names();
    fp.querySelector('.files-back').click();
    await settle(() => names().join(',') === home.join(','));
    const back = names();
    const backBar = bar();
    await bind(true);
    return { home, into, inside, back, homeBar, backBar };`);
  // The console language reaches each verb where it now lives, which is the
  // point of moving them through a host capability rather than a capsule.
  const spoken = await evalIn(`
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const term = console_input();
    const say = async (line) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(600); await console_settled(); };
    const bound = () => fp.querySelector('.drawer-cwdbind.drawer-bind-selected')?.textContent.trim() ?? '';
    await say('file root'); const rooted = bound();
    await say('file follow'); const followed = bound();
    await say('file home'); await sleep(1200);
    const rows = fp.querySelectorAll('.files-row').length;
    const stage = [...document.querySelectorAll('.workspace-pane')].filter((p) => p.offsetParent !== null).map((p) => (p.className.match(/pane-[a-z]+/g) ?? []).filter((c) => c !== 'pane-handle').join('+') + (p.contains(fp) ? '*' : ''));
    return { rooted, followed, rows, stage };`);
  check('the language re-binds a browser where the binding now lives',
    spoken.rooted === 'ROOT HERE' && spoken.followed === 'FOLLOW CWD', JSON.stringify({ rooted: spoken.rooted, followed: spoken.followed, stage: spoken.stage }));
  check('the language still reaches HOME on the frame', spoken.rows > 1);

  check('HOME lands a rooted browser home', walk.home.length > 1 && walk.into !== '');
  check('a folder still descends from the listing', walk.inside.join(',') !== walk.home.join(','));
  // On a miss, say exactly how the second listing of home differed from
  // the first: what it gained, what it lost, and whether only the order
  // moved — three different bugs, and a count cannot tell them apart.
  const homeSet = new Set(walk.home); const backSet = new Set(walk.back);
  const backDiff = {
    home: walk.home.length, into: walk.into, inside: walk.inside.length, back: walk.back.length,
    gained: walk.back.filter((n) => !homeSet.has(n)), lost: walk.home.filter((n) => !backSet.has(n)),
    sameSetOtherOrder: walk.back.length === walk.home.length && walk.back.every((n) => homeSet.has(n)) && walk.back.join(',') !== walk.home.join(','),
    homeBar: walk.homeBar, backBar: walk.backBar,
  };
  check('BACK returns a rooted browser to where it was', walk.back.join(',') === walk.home.join(','), JSON.stringify(backDiff));
  }

  if (await stage('row-verbs')) {
  // A row's verbs live in the FRAME, never on the row: indicating a row
  // puts them in the frame's row zone and opens the frame, the row carries
  // only its light, and no row reserves a track. A directory is offered no
  // verbs and one click enters it; a file's click indicates. Nothing moves.
  const verbs = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const term = console_input();
    const say = async (line, ms) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const rows = () => [...fp().querySelectorAll('.files-row')];
    const named = (n) => rows().find(r => r.querySelector('.files-name')?.textContent.trim() === n);
    const heading = () => fp().querySelector('.files-path')?.textContent.trim() ?? '';
    const tops = () => rows().map(r => Math.round(r.querySelector('.files-name')?.getBoundingClientRect().top ?? 0));
    const zone = () => fp().querySelector('.files-row-zone');
    const zoneVerbs = () => [...zone().querySelectorAll('.listing-action')].map(b => b.textContent.trim());
    const modes = () => fp().dataset.modes ?? null;
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const settle = async (want) => { for (let i = 0; i < 140; i++) { await sleep(500); if (want()) return true; } return false; };

    // A scenario starts from nothing of its own.
    await say('rm -r ~/smoke-verbs', 2500);
    await say('mkdir -p ~/smoke-verbs', 2500);
    await say('cd ~/smoke-verbs', 2500);
    await settle(() => (window.__argusPromptContext?.cwd ?? '').endsWith('/smoke-verbs'));
    const chooser = fp().querySelector('.files-upload-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode('verbs\\n')], 'smoke-verbs.txt', { type: 'text/plain' }));
    chooser.files = dt.files;
    chooser.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(() => named('smoke-verbs.txt'));

    const before = tops();
    const modesBefore = modes();
    const file = named('smoke-verbs.txt');
    click(file); await sleep(700);
    const indicated = zoneVerbs();
    const modesAfter = modes();
    const rowLit = file.classList.contains('listing-indicated');
    const tracks = fp().querySelectorAll('.files-row .listing-actions').length;
    const onRow = fp().querySelectorAll('.files-row .listing-action').length;
    const after = tops();
    const stayed = fp().querySelector('.files-content') === null && /smoke-verbs$/.test(heading());
    const zoneCol = (() => { const xs = [...zone().querySelectorAll('.listing-action')].map(b => Math.round(b.getBoundingClientRect().left)); return xs.length > 1 && xs.every(x => x === xs[0]); })();

    // a touch on the field stands the row down and retracts the frame
    click(fp().querySelector('.files-panel')); await sleep(600);
    const stoodDown = { modes: modes(), lit: fp().querySelector('.files-row.listing-indicated') === null, zoneHidden: zone().hidden };

    // a directory: its body selects it (MOVE / COPY / DELETE in the frame,
    // nothing entered); its OPEN control enters it and selects nothing
    await say('cd ~', 2500);
    await settle(() => named('smoke-verbs'));
    click(named('smoke-verbs')); await sleep(600);
    const dirSelected = { lit: named('smoke-verbs')?.classList.contains('listing-indicated') ?? false, verbs: zoneVerbs(), stayed: !/smoke-verbs$/.test(heading()) };
    click(fp().querySelector('.files-panel')); await sleep(400);
    click(named('smoke-verbs').querySelector('.listing-control'));
    const entered = await settle(() => /smoke-verbs$/.test(heading()));
    const dirModes = modes();
    await say('cd ~', 2500);
    await say('rm -r ~/smoke-verbs', 3000);
    return { before, after, modesBefore, modesAfter, indicated, rowLit, tracks, onRow, stayed, zoneCol, stoodDown, dirSelected, entered, dirModes };`);
  check('a click indicates rather than activates', verbs.stayed && verbs.indicated.length > 0);
  check("the verbs are the ones the row can be given",
    ['DOWNLOAD', 'MOVE', 'COPY', 'DELETE'].every((v) => verbs.indicated.includes(v)), verbs.indicated.join(','));
  check("a row's verbs live in the frame's row zone, one beneath another, and the frame opens as they arrive",
    verbs.onRow === 0 && verbs.zoneCol && verbs.modesBefore === null && verbs.modesAfter === 'open');
  check('the indicated row carries its light and no row reserves a track', verbs.rowLit && verbs.tracks === 0);
  check('no row moves when one is indicated', verbs.before.join(',') === verbs.after.join(','));
  check('a touch on the field stands the row down and retracts the frame',
    verbs.stoodDown.modes === null && verbs.stoodDown.lit && verbs.stoodDown.zoneHidden, JSON.stringify(verbs.stoodDown));
  check("a directory's body selects it, with its verbs in the frame, and enters nothing",
    verbs.dirSelected.lit && verbs.dirSelected.stayed && ['MOVE', 'COPY', 'DELETE'].every((v) => verbs.dirSelected.verbs.includes(v)), JSON.stringify(verbs.dirSelected));
  check("a directory's OPEN enters it and selects nothing", verbs.entered && verbs.dirModes === null);
  // A row one cell short does not leave a gap: it shifts every cell of every
  // row after it into the wrong column, which is how the action track's own
  // column first landed under a name.
  const grid = await evalIn(`
    const fp = [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const cap = [...fp.querySelectorAll('.roster-cap')].find(c => c.textContent.trim().startsWith('NAME'));
    const rows = [...fp.querySelectorAll('.files-row')];
    const names = rows.map(r => Math.round(r.querySelector('.files-name')?.getBoundingClientRect().left ?? -1));
    return { cap: Math.round(cap?.getBoundingClientRect().left ?? -2), names };`);
  check("every row's name sits under the NAME cap",
    grid.names.length > 1 && grid.names.every((left) => Math.abs(left - grid.cap) <= 8),
    JSON.stringify(grid));
  }

  if (await stage('file-download')) {
  // DOWNLOAD saves the file under its own name, or saves nothing and says
  // why. It once let the browser fetch the byte route itself, which saved
  // whatever came back — a login page, a `not found` — as a broken file
  // named `vfs`, and the surface said nothing. Proven at the surface's
  // hand-off: what ARGUS gives the browser to save (the name, the bytes).
  // The browser's own save is the browser's; headless Chromium saves no
  // download at all (#830), so the disk proves nothing about ARGUS.
  await evalIn(`
    window.__argusHandoffs = [];
    if (!window.__argusHandoffWrapped) {
      window.__argusHandoffWrapped = true;
      const press = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          const entry = { name: this.download, href: this.href, text: null };
          window.__argusHandoffs.push(entry);
          if (this.href.startsWith('blob:')) fetch(this.href).then((r) => r.text()).then((t) => { entry.text = t; }).catch(() => { entry.text = '(unreadable)'; });
          return;
        }
        return press.call(this);
      };
    }
    return true;`);
  const dl = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const term = console_input();
    const say = async (line, ms) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const named = (n) => [...fp().querySelectorAll('.files-row')].find(r => r.querySelector('.files-name')?.textContent.trim() === n);
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const settle = async (want) => { for (let i = 0; i < 140; i++) { await sleep(500); if (want()) return true; } return false; };
    const downloadVerb = () => [...fp().querySelectorAll('.files-row-zone .listing-action')].find(b => b.textContent.trim() === 'DOWNLOAD') ?? null;
    await say('rm -r ~/smoke-download', 2500);
    await say('mkdir -p ~/smoke-download', 2500);
    await say('cd ~/smoke-download', 2500);
    // A busy session (a /proc refresh) can take longer than the wait to move:
    // a file delivered before it does lands at home.
    await settle(() => (window.__argusPromptContext?.cwd ?? '').endsWith('/smoke-download'));
    const chooser = fp().querySelector('.files-upload-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode('a,b\\n1,2\\n')], 'smoke-download.csv', { type: 'text/csv' }));
    chooser.files = dt.files;
    chooser.dispatchEvent(new Event('change', { bubbles: true }));
    const uploaded = await settle(() => named('smoke-download.csv'));
    click(named('smoke-download.csv')); await sleep(700);
    const verb = downloadVerb();
    if (verb !== null) verb.click();
    await settle(() => /download: smoke-download\\.csv/.test(console_text()));
    // The same verb pressed after the file is gone: the session cannot read
    // it, and the verb must say so rather than hand the browser an error.
    click(named('smoke-download.csv')); await sleep(700);
    const stale = downloadVerb();
    await say('rm ~/smoke-download/smoke-download.csv', 3000);
    if (stale !== null) stale.click();
    await settle(() => /download: \\S*smoke-download\\.csv: .*nothing was saved/.test(console_text()));
    const lines = console_text().split('\\n').map(l => l.trim()).filter(l => /^download: /.test(l));
    await say('cd ~', 2500);
    await say('rm -r ~/smoke-download', 3000);
    return { uploaded, pressed: verb !== null, stalePressed: stale !== null, lines };`);
  const handed = await evalIn(`
    for (let i = 0; i < 20 && (window.__argusHandoffs ?? []).some((h) => h.text === null); i++) await sleep(150);
    return (window.__argusHandoffs ?? []).map((h) => ({ name: h.name, blob: h.href.startsWith('blob:'), text: h.text }));`);
  check('DOWNLOAD hands the browser the file under its own name, whole',
    dl.pressed && handed.length >= 1 && handed[0].name === 'smoke-download.csv' && handed[0].blob && handed[0].text === 'a,b\n1,2\n' && dl.lines.some((l) => l === 'download: smoke-download.csv'),
    JSON.stringify({ dl, handed }));
  check('a file the session cannot read is handed over as nothing, and the console says why',
    dl.stalePressed && handed.length === 1 && dl.lines.some((l) => /smoke-download\.csv: the session could not read that file — nothing was saved$/.test(l)),
    JSON.stringify({ lines: dl.lines, handed }));
  }

  if (await stage('place-verbs')) {
  // Two verbs that act on the PLACE: they ride the field's frame, they make
  // and land things in the listing on stage, and the listing shows what
  // they did. Every artefact is removed again at the end.
  const place = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const term = console_input();
    const say = async (line, ms) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const names = () => [...fp().querySelectorAll('.files-row .files-name')].map(n => n.textContent.trim());
    // A cold daemon's first calls to CUBE are slower than a warm one's, and
    // this scenario waits on a real upload: the settle is generous because
    // the alternative is a check that fails for being early.
    const settle = async (want) => { for (let i = 0; i < 140; i++) { await sleep(500); if (want()) return true; } return false; };

    await say('cd ~', 2000);
    await settle(() => names().length > 2);
    const onFrame = [...fp().querySelectorAll('.mode-frame .strategy-pill')].map(p => p.textContent.trim());

    // MKDIR asks for a name and makes it where the field points
    // The question stands on the pane that asked it, and the console keeps
    // the exchange — so the ask is READ in the transcript and ANSWERED on
    // the bar. This scenario used to type the answer into the console, and
    // went on passing its ask check while the answer went nowhere.
    // The question is stood inside the press itself, so what was last is read BEFORE it.
    const askBefore = [...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null;
    fp().querySelector('.files-mkdir').click();
    let asked = '';
    for (let i = 0; i < 40; i++) { await sleep(300); const last = [...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null; if (last !== askBefore && last !== null) { asked = last.textContent.trim(); break; } }
    let bar = null;
    for (let i = 0; i < 40; i++) { await sleep(150); bar = fp().querySelector('.ask-bar'); if (bar) break; }
    const field = bar?.querySelector('.ask-bar-field');
    if (field) {
      field.value = 'smoke-place';
      bar.querySelector('.ask-bar-commit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    const made = field !== null && field !== undefined && await settle(() => names().includes('smoke-place'));

    // UPLOAD delivers the browser's own bytes into the folder on stage
    await say('cd ~/smoke-place', 2500);
    await settle(() => (window.__argusPromptContext?.cwd ?? '').endsWith('/smoke-place'));
    const chooser = fp().querySelector('.files-upload-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode('smoke\\n')], 'smoke-place.txt', { type: 'text/plain' }));
    chooser.files = dt.files;
    chooser.dispatchEvent(new Event('change', { bubbles: true }));
    const landed = await settle(() => names().includes('smoke-place.txt'));

    await say('cd ~', 2000);
    await say('rm -r ~/smoke-place', 4000);
    // rm reports what it removed; it does not re-list the folder it removed
    // from, so the listing is asked for again the way an operator would.
    await say('ls', 2500);
    const cleared = await settle(() => !names().includes('smoke-place'));
    return { onFrame, asked, made, landed, cleared };`);
  check('MKDIR, UPLOAD and REFRESH ride the frame that answers to the field',
    place.onFrame.includes('MKDIR') && place.onFrame.includes('UPLOAD') && place.onFrame.includes('REFRESH'));
  check('MKDIR asks for a name, in the place the field holds', /New directory in \//.test(place.asked), JSON.stringify({ asked: place.asked }));
  check('the directory it made is in the listing', place.made);
  check("a file the operator picked lands in the folder on stage", place.landed);
  check('the artefacts are removed again', place.cleared);
  }

  if (await stage('process-workflow')) {
  // Building compute from the surface: PROCESS on a directory opens /bin as
  // a catalogue bound to it, joined to the pane; RUN on a plugin composes
  // the line the console would take, asks the new feed's title once, runs
  // it, and lights a FEED capsule that opens the run's graph beside the
  // catalogue. A real run on a scratch directory, removed at the end.
  const proc = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const panes = () => [...document.querySelectorAll('.pane-files')].filter(p => p.offsetParent !== null);
    const fp = () => panes()[0];
    const term = console_input();
    const say = async (line, ms) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const rows = (p) => [...p.querySelectorAll('.files-row')];
    const named = (p, n) => rows(p).find(r => r.querySelector('.files-name')?.textContent.trim() === n);
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const settle = async (want, n = 140) => { for (let i = 0; i < n; i++) { await sleep(500); if (want()) return true; } return false; };

    await say('rm -r ~/smoke-process', 2500);
    await say('mkdir -p ~/smoke-process', 2500);
    await say('cd ~/smoke-process', 2500);
    await settle(() => (window.__argusPromptContext?.cwd ?? '').endsWith('/smoke-process'));
    const chooser = fp().querySelector('.files-upload-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode('process me\\n')], 'input.txt', { type: 'text/plain' }));
    chooser.files = dt.files;
    chooser.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(() => named(fp(), 'input.txt'));
    await say('cd ~', 2500);
    await settle(() => named(fp(), 'smoke-process'));

    // PROCESS on the directory: a catalogue bound to it opens beside
    click(named(fp(), 'smoke-process').querySelector('.files-name')); await sleep(600);
    const dirVerbs = [...fp().querySelectorAll('.files-row-zone .listing-action')].map(b => b.textContent.trim());
    [...fp().querySelectorAll('.files-row-zone .listing-action')].find(b => b.textContent.trim() === 'PROCESS')?.click();
    const opened = await settle(() => panes().length === 2, 40);
    const cat = panes()[1];
    await settle(() => rows(cat).length > 3, 60);
    const catalogue = { heading: cat.querySelector('.files-path')?.textContent.trim(), caps: [...cat.querySelectorAll('.roster-cap')].map(c => c.textContent.trim()),
      binding: cat.querySelector('.files-binding')?.textContent ?? '' };

    // RUN on a plugin that needs nothing (simpledsapp's parameters are all
    // optional; dircopy's --dir is required, and CUBE refuses it): the line
    // composed, the title asked
    const plugin = rows(cat).filter(r => /^pl-simpledsapp-v/.test(r.querySelector('.files-name')?.textContent.trim() ?? '')).pop();
    click(plugin.querySelector('.files-name')); await sleep(600);
    const pluginVerbs = [...cat.querySelectorAll('.files-row-zone .listing-action')].map(b => b.textContent.trim());
    const echoesBefore = console_echoes().length;
    const askBefore = [...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null;
    [...cat.querySelectorAll('.files-row-zone .listing-action')].find(b => b.textContent.trim() === 'RUN')?.click();
    const asked = await settle(() => ([...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null) !== askBefore, 20);
    const askText = [...document.querySelectorAll('#terminal .argus-ask')].pop()?.textContent.trim() ?? '';
    term.value = 'smoke process run';
    term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(() => console_echoes().length > echoesBefore, 30);
    const echoed = console_echoes().pop()?.trim() ?? '';
    const scheduled = await settle(() => cat.querySelector('.files-feed') !== null, 160);
    const capsule = cat.querySelector('.files-feed')?.textContent.trim() ?? '';
    const feedId = parseInt(capsule.replace(/\\D/g, ''), 10);
    let graph = false;
    if (scheduled) {
      click(cat.querySelector('.files-feed'));
      graph = await settle(() => [...document.querySelectorAll('.pane-dag')].some(p => p.offsetParent !== null && p.querySelector('.dag-canvas')?.style.display === 'block'), 120);
    }
    if (Number.isFinite(feedId)) await say('feed rm -f ' + feedId, 5000);
    await say('cd ~', 2000);
    await say('rm -r ~/smoke-process', 3000);
    await home_return();
    return { dirVerbs, opened, catalogue, pluginVerbs, asked, askText, echoed, scheduled, capsule, graph };`);
  check('PROCESS is offered on a directory', proc.dirVerbs.includes('PROCESS'), proc.dirVerbs.join(','));
  check('PROCESS opens a catalogue bound to the place, and RUN schedules a run on it',
    proc.opened && proc.catalogue.heading === '/bin' && /^INPUT .*smoke-process → new feed$/.test(proc.catalogue.binding) && proc.scheduled,
    JSON.stringify({ opened: proc.opened, catalogue: proc.catalogue, scheduled: proc.scheduled, echoed: proc.echoed }));
  check('the catalogue lists executables in catalogue traits', proc.catalogue.caps.join(',').startsWith('NAME'), proc.catalogue.caps.join(','));
  check('a plugin row is offered RUN, and RUN asks the new feed\'s title once', proc.pluginVerbs.includes('RUN') && proc.asked && /Feed title/.test(proc.askText), proc.askText);
  check('RUN lowers to the line the console would take', /^❯ cd ".*smoke-process"; pl-simpledsapp-v[\d.]+ -- feed_title="smoke process run"$/.test(proc.echoed), proc.echoed);
  check('the FEED capsule opens the run\'s graph beside the catalogue', proc.graph, proc.capsule);
  }

  if (await stage('process-form')) {
  // The graph is the form: opening a plugin from a bound catalogue dives
  // straight into its one node, whose parameters are VALUE cells writing
  // their flags into the run strip's line; a hand edit on the line stands;
  // RUN on the graph's frame runs the line as it reads. A real run on a
  // scratch directory, removed at the end.
  const form = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const panes = () => [...document.querySelectorAll('.pane-files')].filter(p => p.offsetParent !== null);
    const fp = () => panes()[0];
    const term = console_input();
    const say = async (line, ms) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const rows = (p) => [...p.querySelectorAll('.files-row')];
    const named = (p, n) => rows(p).find(r => r.querySelector('.files-name')?.textContent.trim() === n);
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const settle = async (want, n = 140) => { for (let i = 0; i < n; i++) { await sleep(500); if (want()) return true; } return false; };
    const cell = (cat, flag) => [...cat.querySelectorAll('.dag-facts .telemetry-row')]
      .find(r => r.querySelector('.telemetry-label')?.textContent === flag)?.querySelector('.telemetry-input');

    await say('rm -r ~/smoke-form', 2500);
    await say('mkdir -p ~/smoke-form', 2500);
    await say('cd ~', 2500);
    await settle(() => named(fp(), 'smoke-form'));
    click(named(fp(), 'smoke-form').querySelector('.files-name')); await sleep(600);
    [...fp().querySelectorAll('.files-row-zone .listing-action')].find(b => b.textContent.trim() === 'PROCESS')?.click();
    await settle(() => panes().length === 2, 40);
    const cat = panes()[1];
    await settle(() => rows(cat).length > 3, 60);
    const plugin = rows(cat).filter(r => /^pl-simpledsapp-v/.test(r.querySelector('.files-name')?.textContent.trim() ?? '')).pop();

    // OPEN from the row's control: the one-node graph dives itself
    click(plugin.querySelector('.files-control'));
    const dived = await settle(() => cat.querySelector('.dag-facts-immersed .telemetry-input') !== null, 60);
    await sleep(600);
    const lineBefore = cat.querySelector('.files-command')?.value ?? '';
    const cells = [...cat.querySelectorAll('.dag-facts .telemetry-row')].map(r => [r.querySelector('.telemetry-label')?.textContent, r.querySelector('.telemetry-input')?.type ?? 'readout']);
    const prefix = cell(cat, '--prefix');
    prefix.value = 'smoke-'; prefix.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
    const ignore = cell(cat, '--ignoreInputDir');
    ignore.checked = true; ignore.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200);
    const lineWritten = cat.querySelector('.files-command')?.value ?? '';
    const line = cat.querySelector('.files-command');
    line.value = line.value + ' --dummyInt 7'; line.dispatchEvent(new Event('input', { bubbles: true }));
    prefix.value = 'smoke-run-'; prefix.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
    const lineHand = line.value;
    const runPill = getComputedStyle(cat.querySelector('.diagram-run')).display;

    const echoesBefore = console_echoes().length;
    const askBefore = [...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null;
    cat.querySelector('.diagram-run').click();
    const asked = await settle(() => ([...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null) !== askBefore, 20);
    term.value = 'smoke form run';
    term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(() => console_echoes().length > echoesBefore, 30);
    const echoed = console_echoes().pop()?.trim() ?? '';
    const scheduled = await settle(() => cat.querySelector('.files-feed') !== null, 160);
    const feedId = parseInt((cat.querySelector('.files-feed')?.textContent ?? '').replace(/\\D/g, ''), 10);
    if (Number.isFinite(feedId)) await say('feed rm -f ' + feedId, 5000);
    await say('cd ~', 2000);
    await say('rm -r ~/smoke-form', 3000);
    await home_return();
    return { dived, lineBefore, cells, lineWritten, lineHand, runPill, asked, echoed, scheduled };`);
  check('a plugin opened from a bound catalogue dives into its one node, its parameters as cells',
    form.dived && form.cells.some(([l, t]) => l === '--prefix' && t === 'text') && form.cells.some(([l, t]) => l === '--ignoreInputDir' && t === 'checkbox'),
    JSON.stringify(form.cells));
  check('a cell writes its flag into the line as typed, a boolean bare',
    /pl-simpledsapp-v[\d.]+ --prefix smoke- --ignoreInputDir$/.test(form.lineWritten), form.lineWritten);
  check('a hand edit on the line stands when a cell writes again',
    /--prefix smoke-run- --ignoreInputDir --dummyInt 7$/.test(form.lineHand), form.lineHand);
  check('RUN rides the graph\'s frame and runs the line as it reads',
    form.runPill !== 'none' && form.asked && /^❯ cd ".*smoke-form"; pl-simpledsapp-v[\d.]+ --prefix smoke-run- --ignoreInputDir --dummyInt 7 -- feed_title="smoke form run"$/.test(form.echoed) && form.scheduled,
    JSON.stringify({ runPill: form.runPill, asked: form.asked, echoed: form.echoed, scheduled: form.scheduled }));
  }

  if (await stage('process-desktop')) {
  // A catalogue is a desktop: left for another domain, it returns from PANES
  // bound as it was, its line verbatim and RUN ready; and it leads with
  // RECENT, the operator's lately-run executables from the kernel's listing.
  const desk = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const panes = () => [...document.querySelectorAll('.pane-files')].filter(p => p.offsetParent !== null);
    const fp = () => panes()[0];
    const term = console_input();
    // Each line waits for the one before to finish: a remove still under
    // way when mkdir -p runs leaves nothing behind once it lands.
    const say = async (line, ms) => { await console_idle(); term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); await console_idle(); };
    const rows = (p) => [...p.querySelectorAll('.files-row')];
    const named = (p, n) => rows(p).find(r => r.querySelector('.files-name')?.textContent.trim() === n);
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const settle = async (want, n = 140) => { for (let i = 0; i < n; i++) { await sleep(500); if (want()) return true; } return false; };
    const catalogue = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null && /smoke-desk/.test(p.querySelector('.files-binding')?.textContent ?? ''));

    // A scenario starts from nothing of its own: a view another left up
    // takes a listing underneath it, so close any before listing ~.
    for (let i = 0; i < 4 && fp()?.querySelector('.files-close-pill'); i++) { fp().querySelector('.files-close-pill').click(); await sleep(400); }
    await say('rm -r ~/smoke-desk', 2500);
    await say('mkdir -p ~/smoke-desk', 2500);
    await say('cd ~', 2500);
    const homed = await settle(() => fp() !== undefined && named(fp(), 'smoke-desk') !== undefined);
    if (!homed) return { error: 'the browser never listed ~/smoke-desk', panes: panes().map(p => ({ path: p.querySelector('.files-path')?.textContent.trim() ?? '', binding: p.querySelector('.files-binding')?.textContent.trim() ?? '', view: p.querySelector('.files-diagram') ? 'diagram' : p.querySelector('.files-content') ? 'content' : 'listing', bar: p.querySelector('.lcars-title')?.textContent.trim() ?? '' })), all: document.querySelectorAll('.pane-files').length, rows: fp() ? rows(fp()).map(r => r.querySelector('.files-name')?.textContent.trim()).slice(0, 60) : [], console: console_text().split('\\n').filter(l => l.trim()).slice(-8) };
    click(named(fp(), 'smoke-desk').querySelector('.files-name')); await sleep(600);
    [...fp().querySelectorAll('.files-row-zone .listing-action')].find(b => b.textContent.trim() === 'PROCESS')?.click();
    await settle(() => catalogue() !== undefined, 40);
    await settle(() => rows(catalogue()).length > 3, 60);
    const headersBefore = await settle(() => [...catalogue().querySelectorAll('.files-path')].some(h => h.textContent.trim() === 'RECENT'), 40);
    const recentRows = [...catalogue().querySelectorAll('section[data-key="/bin/recent"] .files-row .files-name')].map(n => n.textContent.trim());
    const line = catalogue().querySelector('.files-command');
    line.value = 'cd "/home/x/smoke-desk"; pl-simpledsapp-v2.1.5 --prefix kept-'; line.dispatchEvent(new Event('input', { bubbles: true }));
    const bindingBefore = catalogue().querySelector('.files-binding')?.textContent ?? '';

    // Away to RUNS, then PANES: the catalogue's arrangement is a card
    document.getElementById('gutter-runs').click(); await sleep(1200);
    document.getElementById('gutter-panes').click(); await sleep(800);
    // The desktop that holds THIS catalogue (another scenario's may still be
    // on stage and name the card): found by its action, pressed by its label.
    const desktop = (window.__argusDormant?.list?.() ?? []).find(g => (g.actions ?? []).some(a => a.op === 'catalogue' && /smoke-desk$/.test(a.input ?? '')));
    const cardLabel = desktop?.label ?? null;
    const card = [...document.querySelectorAll('.panes-card')].find(c => c.querySelector('.panes-card-label')?.textContent === cardLabel);
    const catalogueLine = (desktop?.actions ?? []).find(a => a.op === 'catalogue' && /smoke-desk$/.test(a.input ?? ''))?.line ?? null;
    if (card) card.click();
    const mine = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null && /smoke-desk/.test(p.querySelector('.files-binding')?.textContent ?? ''));
    const back = await settle(() => mine() !== undefined && (mine().querySelector('.files-command')?.value ?? '') !== '', 60);
    await settle(() => mine() && rows(mine()).length > 3, 60);
    const bindingAfter = mine()?.querySelector('.files-binding')?.textContent ?? '';
    const lineAfter = mine()?.querySelector('.files-command')?.value ?? '';
    const listingBack = mine()?.querySelector('.files-diagram') === null;
    await say('cd ~', 2000);
    await say('rm -r ~/smoke-desk', 3000);
    return { headersBefore, recentRows, bindingBefore, cardLabel, catalogueLine, back, bindingAfter, lineAfter, listingBack };`);
  if (desk.error !== undefined) {
    check('the browser lists a fresh ~/smoke-desk', false, JSON.stringify(desk));
  } else {
  check('a bound catalogue leads with RECENT, the executables lately run', desk.headersBefore && desk.recentRows.length > 0 && desk.recentRows.every(n => /^pl-/.test(n)), JSON.stringify(desk.recentRows));
  check('a catalogue left for another domain is a PROCESS card in PANES, carrying its line', desk.cardLabel !== null && /^PROCESS /.test(desk.cardLabel) && desk.catalogueLine === 'cd "/home/x/smoke-desk"; pl-simpledsapp-v2.1.5 --prefix kept-', JSON.stringify({ label: desk.cardLabel, line: desk.catalogueLine }));
  check('restore returns the catalogue bound as it was, its line verbatim, as a listing',
    desk.back && desk.bindingAfter === desk.bindingBefore && /smoke-desk → new feed$/.test(desk.bindingAfter) && desk.lineAfter === 'cd "/home/x/smoke-desk"; pl-simpledsapp-v2.1.5 --prefix kept-' && desk.listingBack,
    JSON.stringify({ back: desk.back, bindingBefore: desk.bindingBefore, bindingAfter: desk.bindingAfter, lineAfter: desk.lineAfter, listingBack: desk.listingBack }));
  }
  }

  if (await stage('roster-shares')) {
  // The roster's rows carry the verbs that act on a FEED: setfacl grants to
  // an identity on a feed, so sharing belongs here. Indicating is not
  // entering, the geometry holds, and both verbs ask before they act.
  const shares = await evalIn(`
    document.getElementById('gutter-runs').click(); await sleep(1000);
    const term = console_input();
    const key = (k) => term.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const rows = () => [...document.querySelectorAll('.feedlist-row')];
    const tops = () => rows().map(r => Math.round(r.querySelector('.feedlist-title')?.getBoundingClientRect().top ?? 0));
    const asks = () => [...document.querySelectorAll('#terminal .argus-ask')];
    const rosterShown = () => document.querySelector('.dag-feedlist')?.offsetParent !== null;
    for (let i = 0; i < 60; i++) { await sleep(400); if (rows().length > 1) break; }

    const before = tops();
    // A feed the session's own user holds: the roster also lists other
    // owners' public feeds, whose access the session cannot read.
    const me = window.__argusPromptContext?.user ?? '';
    const target = rows().find((r) => r.querySelector('.feedlist-owner')?.textContent.trim() === me) ?? rows()[1];
    // A roster row's verbs live in the frame's row zone, like every listing's.
    const dp = [...document.querySelectorAll('.pane-dag')].find(p => p.offsetParent !== null);
    const zone = () => dp.querySelector('.runs-row-zone');
    const zoneVerbs = () => [...zone().querySelectorAll('.listing-action')];
    target.querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    let readout = '';
    for (let i = 0; i < 50; i++) { await sleep(400); readout = zone().querySelector('.listing-readout')?.textContent ?? ''; if (readout) break; }
    const verbs = zoneVerbs().map(b => b.textContent.trim());
    const others = rows().every(r => r.querySelectorAll('.listing-action').length === 0) && target.classList.contains('listing-indicated');
    const after = tops();
    const stayed = rosterShown();

    // SHARE asks who, and says what cannot be undone before it is answered
    // The scrollback keeps every question ever asked (a game by question
    // earlier in the run, say) and is capped, so a NEW ask is a block that was
    // not the last one before — not any block, and not one more block.
    const askBeforeShare = asks().pop() ?? null;
    zoneVerbs().find(b => b.textContent === 'SHARE')?.click();
    let asked = '';
    for (let i = 0; i < 50; i++) { await sleep(400); if ((asks().pop() ?? null) !== askBeforeShare) { asked = asks().pop().textContent.trim(); break; } }
    key('Escape'); await sleep(600);

    // DELETE raises the kernel's own confirmation, and NO removes nothing
    const feedsBefore = rows().length;
    const askBeforeDelete = asks().pop() ?? null;
    zoneVerbs().find(b => b.textContent === 'DELETE')?.click();
    let confirm = '';
    for (let i = 0; i < 50; i++) { await sleep(400); if ((asks().pop() ?? null) !== askBeforeDelete) { confirm = asks().pop().textContent.trim(); break; } }
    // Escape from the ROW, which is where the hand already is after pressing
    // the row's own verb. Pressed at the console input a question was always
    // abandoned; pressed anywhere else it reached nothing at all.
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(1200);
    const feedsAfter = rows().length;
    // Abandoning a question releases the command that asked it. Bound to the
    // input line alone, Escape pressed with focus on a row reached nothing:
    // the question stayed open and the removal held the lane for as long as
    // the session lived. The lane is where that shows.
    const lane = () => {
      const box = document.getElementById('lane-instrument');
      const row = [...(box?.querySelectorAll('.lane-row') ?? [])]
        .find((r) => r.querySelector('.telemetry-label')?.textContent === 'LANE');
      return row?.querySelector('.telemetry-value')?.textContent ?? '';
    };
    // The lane rides a heartbeat, so give it a few before believing it.
    await sleep(3000);
    const laneAfter = lane();

    // a double-click still enters the feed
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    let entered = false;
    for (let i = 0; i < 60; i++) { await sleep(400); if (!rosterShown()) { entered = true; break; } }
    await home_return();
    return { feed: target?.dataset.feed ?? null, verbs, readout, others, moved: before.join(',') !== after.join(','), stayed, asked, confirm, feedsBefore, feedsAfter, laneAfter, entered };`);
  check('a feed row carries the verbs that act on a feed',
    shares.verbs.join(',') === 'NOTE,TAG,RENAME,SHARE,DELETE' && shares.others);
  check('the row reads back who holds it', /^SHARED WITH /.test(shares.readout), JSON.stringify({ feed: shares.feed, readout: shares.readout }));
  check('no roster row moves when one is indicated', !shares.moved);
  check('indicating a feed does not enter it', shares.stayed);
  check('abandoning the confirmation releases the command that asked it',
    !/feed rm/.test(shares.laneAfter ?? ''), `LANE ${shares.laneAfter}`);
  check('SHARE asks with whom (a group, everyone, or a user), and no longer says a grant is permanent',
    /with a group, everyone, or a user/.test(shares.asked) && !/cannot be taken back/.test(shares.asked));
  check('DELETE raises the kernel\'s own confirmation', /Remove feed \d+ and everything in it/.test(shares.confirm));
  check('answering no removes nothing', shares.feedsBefore === shares.feedsAfter);
  check('a double-click still enters the feed', shares.entered);

  // Granting for real needs a second identity to grant TO, which not every
  // environment has: set SMOKE_SHARE_USER to run it, and the check says it
  // was skipped rather than passing quietly.
  const shareUser = process.env.SMOKE_SHARE_USER;
  if (shareUser === undefined || shareUser === '') {
    console.log('  skip  a grant reaches the row that made it (set SMOKE_SHARE_USER)');
  } else {
    const granted = await evalIn(`
      document.getElementById('gutter-runs').click(); await sleep(1200);
      const term = console_input();
      const rows = () => [...document.querySelectorAll('.feedlist-row')];
      for (let i = 0; i < 60; i++) { await sleep(400); if (rows().length > 1) break; }
      const target = rows()[1];
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 50; i++) { await sleep(400); if (target.querySelector('.listing-readout')) break; }
      const askBefore = [...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null;
      zoneVerbs().find(b => b.textContent === 'SHARE')?.click();
      for (let i = 0; i < 50; i++) { await sleep(400); if (([...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null) !== askBefore) break; }
      term.value = ${JSON.stringify(shareUser)};
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(3000); await console_settled();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      let readout = '';
      for (let i = 0; i < 50; i++) { await sleep(400); readout = target.querySelector('.listing-readout')?.textContent ?? ''; if (readout.includes(${JSON.stringify(shareUser)})) break; }
      return { readout };`);
    check('a grant reaches the row that made it', granted.readout.includes(shareUser), granted.readout);
  }
  }

  if (await stage('select-mode')) {
  // SELECT is a mode: it changes what a click means. The selection is the
  // field's — it survives a filter, it is cleared by navigation — and its
  // verbs are ONE command over many operands.
  const select = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null && p.querySelector('.files-select'));
    const term = console_input();
    const say = async (line, ms) => { term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    const rows = () => [...fp().querySelectorAll('.files-row')];
    const named = (n) => rows().find(r => r.querySelector('.files-name')?.textContent.trim() === n);
    const bar = () => fp().querySelector('.pane-state')?.textContent.trim() ?? '';
    const verbs = () => [...fp().querySelectorAll('.files-row-zone .listing-action')].map(b => b.textContent.trim());
    const settle = async (want) => { for (let i = 0; i < 140; i++) { await sleep(500); if (want()) return true; } return false; };

    // A scenario starts from nothing of its own: a folder left by a run that
    // failed part-way would put yesterday's files under today's names.
    await say('rm -r ~/smoke-select', 2500);
    await say('mkdir -p ~/smoke-select', 2500);
    await say('cd ~/smoke-select', 2500);
    await settle(() => (window.__argusPromptContext?.cwd ?? '').endsWith('/smoke-select'));
    // Two files to gather, put there by the surface's own delivery.
    const chooser = fp().querySelector('.files-upload-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode('one\\n')], 'one.txt', { type: 'text/plain' }));
    dt.items.add(new File([new TextEncoder().encode('two\\n')], 'two.txt', { type: 'text/plain' }));
    chooser.files = dt.files;
    chooser.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(() => named('one.txt') && named('two.txt'));

    fp().querySelector('.files-select').click(); await sleep(300);
    const modeOn = bar();
    named('one.txt').dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(200);
    named('two.txt').dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(400);
    const picked = bar();
    const offered = verbs();
    const marked = rows().filter(r => r.classList.contains('listing-selected')).length;

    // a filter hides one: the selection stands, and the bar says how many show
    await say('file filter one', 1800);
    const filtered = bar();
    await say('file filter', 1800);

    // the bulk removal is ONE command that asks ONCE, naming how many
    verbs().find((v) => v.startsWith('DELETE')) && [...fp().querySelectorAll('.files-row-zone .listing-action')]
      .find(b => b.textContent.startsWith('DELETE')).click();
    let asked = '';
    for (let i = 0; i < 60; i++) { await sleep(400); const a = [...document.querySelectorAll('#terminal .argus-ask')].pop(); if (a) { asked = a.textContent.trim(); break; } }
    const echoed = console_echoes().pop()?.trim() ?? '';
    // A confirm is answered with the capsule that reads as what it does.
    // The LAST question's capsule: the scrollback keeps every question ever
    // asked, and pressing the first YES presses one already answered.
    [...document.querySelectorAll('#terminal .ask-capsule')].filter(c => c.textContent === 'YES').pop()?.click();
    const removed = await settle(() => !named('one.txt') && !named('two.txt'));

    // navigation clears what was gathered
    await say('cd ~', 2500);
    const afterNav = bar();
    await say('rm -r ~/smoke-select', 3000);
    return { modeOn, picked, offered, marked, filtered, asked, echoed, removed, afterNav };`);
  check('SELECT reads as a mode on the bar', /SELECT/.test(select.modeOn));
  check('a click gathers a row instead of indicating it',
    /2 SELECTED/.test(select.picked) && select.marked === 2);
  check("the selection's verbs count what they would act on",
    select.offered.includes('DELETE 2') && select.offered.includes('MOVE 2') && select.offered.includes('COPY 2'));
  check('a filter hides rows without losing them, and the bar says so',
    /2 SELECTED · 1 SHOWN/.test(select.filtered));
  check('a bulk act is one command the operator could have typed',
    /rm -rI /.test(select.echoed));
  check('and it asks once, naming how many', /remove 2 items/.test(select.asked));
  check('answering yes removes them all', select.removed);
  check('navigation clears the selection', !/SELECTED/.test(select.afterNav));
  }

  if (await stage('select-wait')) {
  // Selecting a feed answers at once: the roster steps aside, the pane says
  // what it is retrieving, and the bar reads LOADING until the graph lands.
  const selectWait = await evalIn(`
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.feedlist-row')) break; }
    const dp = document.querySelector('.pane-dag');
    const rows = dp.querySelectorAll('.feedlist-row');
    if (rows.length === 0) return { skipped: 'no roster' };
    // Double-click enters: a roster row carries verbs, so a single click indicates rather than activates.
    rows[rows.length - 1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    // "At once" is the double-click's own turn: the list steps aside, the
    // pane names the feed and the bar reads LOADING before the handler
    // returns. Read there, not after a sleep — a feed whose graph is already
    // resident lands inside any sleep, and LOADING has rightly cleared.
    const atOnce = {
      listHidden: dp.querySelector('.dag-feedlist').style.display === 'none',
      retrieving: /^RETRIEVING FEED \\d+/.test(dp.querySelector('.dag-empty').textContent),
      state: dp.querySelector('.pane-state').textContent,
    };
    for (let i = 0; i < 120; i++) { await sleep(500); if (dp.querySelector('.dag-canvas').style.display === 'block') break; }
    const landed = dp.querySelector('.dag-canvas').style.display === 'block' && dp.querySelector('.dag-empty').style.display === 'none';
    const stateAfter = dp.querySelector('.pane-state').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300);
    await home_return();
    return { skipped: null, atOnce, landed, stateAfter };`);
  if (selectWait.skipped) {
    console.log(`  skipped: ${selectWait.skipped}`);
  } else {
    check('selecting a feed answers at once', selectWait.atOnce.listHidden && selectWait.atOnce.retrieving && selectWait.atOnce.state === 'LOADING', JSON.stringify(selectWait.atOnce));
    check('the graph lands and LOADING clears', selectWait.landed && selectWait.stateAfter !== 'LOADING', JSON.stringify({ landed: selectWait.landed, stateAfter: selectWait.stateAfter }));
  }
  }

  if (await stage('pin-survives')) {
  // A pick survives promptlines: with the session cwd parked inside another
  // feed, picking a feed must hold — the follow answers a move, not a
  // promptline. (The regression this guards replaced every pick with the
  // cwd's feed a few seconds later.) The session cwd is put back after.
  const pin = await evalIn(`
    const input = console_input();
    const run = async (line, ms) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
    await run('cd /proc/jobs/feed_21', 2000);
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.feedlist-row')) break; }
    const dp = [...document.querySelectorAll('.pane-dag')].find(p => p.offsetParent !== null);
    const rows = [...dp.querySelectorAll('.feedlist-row')].filter(r => r.querySelector('.feedlist-id')?.textContent.trim() !== '21');
    if (rows.length === 0) { await run('cd ~', 1500); return { skipped: 'no other feed' }; }
    // Double-click enters: a roster row carries verbs, so a single click indicates rather than activates.
    rows[rows.length - 1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    for (let i = 0; i < 120; i++) { await sleep(500); if (dp.querySelector('.dag-canvas').style.display === 'block') break; }
    const picked = dp.querySelector('.dag-title').textContent;
    await run('proc feeds', 1500); // a promptline, as any command brings
    await sleep(5000);
    const later = dp.querySelector('.dag-title').textContent;
    // Back to the roster (Esc retreats one level a press), then home.
    for (let i = 0; i < 4 && dp.querySelector('.roster-shown') === null; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400); }
    await run('cd ~', 1500);
    return { skipped: null, picked, later };`);
  if (pin.skipped) console.log(`  skipped: ${pin.skipped}`);
  else check('a pick survives promptlines while the cwd sits elsewhere', pin.picked === pin.later && !/FEED 21\b/.test(pin.later), `${pin.picked} -> ${pin.later}`);
  }

  if (await stage('roster-settles')) {
  // A run the surface can see must stop reading RUNNING when it finishes.
  // The regression this guards: the roster asked its flex-laid-out element
  // whether it was `block`, so it never re-asked the session and every row
  // it had ever drawn was frozen.
  const settles = await evalIn(`
    await console_idle();
    
    const term = console_input();
    const say = async (line, ms) => { const b = console_mark(); term.value = line;
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled();
      return console_since(b, '\\n'); };
    await say('rm -r ~/smoke-roster', 2000);
    await say('mkdir -p ~/smoke-roster', 2000);
    await say('cd ~/smoke-roster', 2000);
    await say('touch --withContents "roster" input.txt', 2500);
    const ran = await say('pl-simpledsapp-v2.1.5 -- feed_title="smoke roster"', 12000);
    const feed = (ran.match(/Feed created: (\\d+)/) ?? [])[1] ?? null;
    if (feed === null) return { error: 'no feed created' };
    document.getElementById('gutter-runs').click(); await sleep(3000);
    // The pane on stage that holds a roster: another scenario's graph pane
    // may be on stage too, and it is not the one RUNS-02 just opened.
    const dp = () => [...document.querySelectorAll('.pane-dag')]
      .find((p) => p.offsetParent !== null && p.querySelector('.dag-feedlist')) ?? null;
    const row = () => [...(dp()?.querySelectorAll('.feedlist-row') ?? [])].find(r => r.dataset.feed === feed) ?? null;
    const status = () => row()?.querySelector('.feedlist-status')?.textContent.trim()
      ?? (row()?.className.match(/feedlist-(\\w+)/) ?? [])[1] ?? null;
    // One patient watch, nothing asked of the session: the roster's own
    // request may queue behind the walk of the feed just created, so the
    // row's arrival is waited for, and then its settling.
    let first = null;
    let reached = null;
    let seenAfterMs = null;
    const startedAt = Date.now();
    for (let i = 0; i < 120; i++) {
      await sleep(1500);
      const now = status();
      if (now === null) continue;
      if (first === null) { first = now; seenAfterMs = Date.now() - startedAt; }
      if (!/running/i.test(now)) { reached = now; break; }
    }
    // And the roster is not painted over by a cwd inside the feed.
    await say('cd ~/feeds/feed_' + feed, 4000);
    const rosterUp = dp()?.querySelector('.dag-feedlist')?.style.display !== 'none'
      && dp()?.querySelector('.dag-canvas')?.style.display !== 'block';
    const seen = { panes: [...document.querySelectorAll('.pane-dag')].filter((p) => p.offsetParent !== null).length, title: dp()?.querySelector('.dag-title')?.textContent ?? null, roster: dp()?.querySelector('.dag-feedlist')?.style.display ?? null };
    await say('cd ~', 2000);
    await say('feed rm -f ' + feed, 5000);
    await say('rm -r ~/smoke-roster', 3000);
    return { feed, first, seenAfterMs, settled: reached, rosterUp, seen };`);
  // A row that reads RUNNING must stop; one the roster first drew after the
  // run had already finished is honest as it stands.
  check('a run the roster lists stops reading RUNNING when it finishes, with nothing asked of it',
    settles.error === undefined && settles.first !== null && /finishedsuccessfully/i.test(settles.settled ?? ''),
    JSON.stringify(settles));
  check('a cwd inside a feed does not paint its graph over the roster',
    settles.error === undefined && settles.rosterUp === true, JSON.stringify({ rosterUp: settles.rosterUp, seen: settles.seen }));
  }
  if (await stage('stale-page')) {
  // A page older than its server's build says so: a failed on-demand chunk
  // (the event Vite's loader raises for it) puts a notice over the stage
  // and a line on the console, once; the sentence's word `refresh` is the
  // control. The words are read from the module, so the two cannot drift.
  const { readFileSync: readSource } = await import('node:fs');
  const source = readSource(new URL('../../src/app/stalePage.ts', import.meta.url), 'utf8');
  const part = (key) => (source.match(new RegExp(`${key}: '([^']*)'`)) ?? [])[1] ?? '';
  const sentence = `${part('before')}${part('refresh')}${part('after')}`;
  const stale = await evalIn(`
    await console_idle();
    const before = document.querySelectorAll('.stale-page').length;
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    await sleep(300);
    const notices = [...document.querySelectorAll('.stale-page')];
    const words = notices[0]?.textContent ?? '';
    const control = notices[0]?.querySelector('.stale-page-reload')?.textContent ?? '';
    // The console's own line, not any line that quotes the sentence (the release notes do).
    const lines = console_text().split('\\n').filter(l => l.startsWith('argus: ' + ${JSON.stringify(sentence)})).length;
    notices.forEach(n => n.remove());
    return { before, count: notices.length, words, control, lines };`);
  check('a page older than its server\'s build says so once, in plain words whose "refresh" reloads, on the stage and the console',
    sentence !== '' && stale.before === 0 && stale.count === 1 && stale.words === sentence && stale.control === part('refresh') && stale.lines === 1,
    JSON.stringify({ sentence, ...stale }));
  }

  if (await stage('home-trail')) {
  // The way home is one press: a `~` lead row above `..` anywhere but home,
  // and the path line a trail whose every segment but the last goes there.
  const trail = await evalIn(`
    await console_idle();
    const input = console_input();
    const say = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
    document.getElementById('gutter-files').click();
    const fp = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null);
    const here = () => fp()?.querySelector('.files-crumbs .files-crumb-here')?.dataset.path ?? '';
    const crumbs = () => [...(fp()?.querySelectorAll('.files-crumbs .files-crumb') ?? [])].map(c => c.textContent);
    const leads = () => [...(fp()?.querySelectorAll('.files-row') ?? [])].slice(0, 2).map(r => r.classList.contains('files-lead-home') ? '~' : r.classList.contains('files-lead-up') ? '..' : 'row');
    const settle = async (want) => { for (let i = 0; i < 60; i++) { await sleep(250); if (want()) return true; } return false; };
    await say('cd ~');
    await settle(() => crumbs().length === 1 && crumbs()[0] === '~');
    const home = here();
    const atHome = { crumbs: crumbs(), leads: leads() };
    // One level down, into the first folder home holds.
    const folder = [...fp().querySelectorAll('.files-row.files-type-dir:not(.files-lead-up):not(.files-lead-home) .files-name')][0]?.textContent.trim() ?? '';
    await say('cd "' + home + '/' + folder + '"');
    await settle(() => here() === home + '/' + folder);
    const below = { crumbs: crumbs(), leads: leads(), here: here() };
    // The ~ row goes home.
    fp().querySelector('.files-row.files-lead-home .listing-control')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(() => here() === home);
    const homeAgain = here();
    // Outside home the trail starts at the root; its / segment goes there.
    await say('cd /bin');
    await settle(() => here() === '/bin');
    const bin = { crumbs: crumbs(), leads: leads() };
    fp().querySelector('.files-crumbs button.files-crumb')?.click();
    await settle(() => here() === '/');
    const root = { here: here(), leads: leads() };
    await say('cd ~');
    await settle(() => here() === home);
    return { home, folder, atHome, below, homeAgain, bin, root };`);
  check('at home the trail is ~ alone and no ~ row leads the listing',
    trail.atHome.crumbs.join('|') === '~' && trail.atHome.leads[0] !== '~', JSON.stringify(trail.atHome));
  check('below home the trail reads ~/<folder> and the ~ row leads above ..',
    trail.folder !== '' && trail.below.crumbs.join('|') === '~|' + trail.folder && trail.below.leads.join('|') === '~|..', JSON.stringify(trail.below));
  check('the ~ row goes home', trail.homeAgain === trail.home, trail.homeAgain);
  check('outside home the trail starts at /, and its / segment goes to the root',
    trail.bin.crumbs.join('|') === '/|bin' && trail.root.here === '/' && trail.root.leads[0] === '~', `${JSON.stringify(trail.bin)} | ${JSON.stringify(trail.root)}`);
  }

  if (await stage('enter-place')) {
  // ENTER always lands in a place: from the roster pick, ENTER FEED moves the
  // session (and so the cwd-following browser) into /proc/jobs/feed_N.
  const enterPlace = await evalIn(`
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.feedlist-row')) break; }
    const dp = [...document.querySelectorAll('.pane-dag')].find((p) => p.offsetParent !== null && p.querySelector('.feedlist-row')) ?? document.querySelector('.pane-dag');
    const rows = dp.querySelectorAll('.feedlist-row');
    if (rows.length === 0) return { skipped: 'no roster' };
    const row = rows[rows.length - 1];
    const feedId = row.querySelector('.feedlist-id') ? row.querySelector('.feedlist-id').textContent.trim() : null;
    // A single press indicates a run; its OPEN cell enters it (#454).
    row.querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 20 && !row.querySelector('.listing-control'); i++) await sleep(150);
    (row.querySelector('.listing-control') ?? row).click();
    for (let i = 0; i < 120; i++) { await sleep(500); if (dp.querySelector('.dag-canvas').style.display === 'block') break; }
    dp.querySelector('.pane-handle').click(); await sleep(150);
    const cap = [...dp.querySelectorAll('.drawer-child')].find(c => c.textContent === 'ENTER FEED');
    if (!cap) return { skipped: null, offered: false };
    cap.click();
    // RUNS-02 owns the whole workspace, so the cwd-following browser is off
    // stage: the session's cwd is read from the console's prompt line.
    let path = null;
    for (let i = 0; i < 40; i++) { await sleep(500); const lines = console_text().split('\\n').filter(l => !l.trim().startsWith('❯') && l.includes('/proc/jobs/feed_')); const last = lines[lines.length - 1]; const m = last ? /\\/proc\\/jobs\\/feed_\\d+/.exec(last) : null; if (m) { path = m[0]; break; } }
    if (!dp.querySelector('.pane-drawer').hidden) { dp.querySelector('.pane-handle').click(); await sleep(100); }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300);
    // The session is shared with whoever else is attached: put its cwd back.
    const input = console_input(); input.value = 'cd ~';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(1500); await console_settled();
    return { skipped: null, offered: true, feedId, path };`);
  if (enterPlace.skipped) {
    console.log(`  skipped: ${enterPlace.skipped}`);
  } else {
    check('ENTER FEED moves the session into the feed', enterPlace.offered && typeof enterPlace.path === 'string' && enterPlace.path.startsWith('/proc/jobs/feed_'), JSON.stringify(enterPlace));
  }
  }

  if (await stage('live-watch')) {
  // The pane is the subscription: entering a feed opens a watch, the bar
  // reports its liveness, the drawer offers REFRESH, leaving releases it.
  // A daemon older than the watch wire answers `error`; that is reported
  // as a skip, not a pass.
  const live = await evalIn(`
    document.getElementById('gutter-runs').click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.feedlist-row')) break; }
    const dp = [...document.querySelectorAll('.pane-dag')].find((p) => p.offsetParent !== null && p.querySelector('.feedlist-row')) ?? document.querySelector('.pane-dag');
    const row = dp.querySelector('.feedlist-row');
    if (!row) return { skipped: 'no roster' };
    // A single press indicates a run; its OPEN cell enters it (#454).
    row.querySelector('.feedlist-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 20 && !row.querySelector('.listing-control'); i++) await sleep(150);
    (row.querySelector('.listing-control') ?? row).click();
    for (let i = 0; i < 60; i++) { await sleep(500); if (dp.querySelector('.dag-canvas').style.display === 'block') break; }
    const state = dp.querySelector('.pane-state');
    let text = '';
    for (let i = 0; i < 20; i++) { await sleep(500); text = state.textContent.trim(); if (text) break; }
    dp.querySelector('.pane-handle').click(); await sleep(150);
    const refreshCap = [...dp.querySelectorAll('.drawer-child')].find(c => c.textContent === 'REFRESH');
    const offered = !!refreshCap;
    if (refreshCap) { refreshCap.click(); await sleep(1500); }
    const after = state.textContent.trim();
    // Esc is contextual back: an open drawer would take the press, so make
    // sure it is closed before asking for the list.
    if (!dp.querySelector('.pane-drawer').hidden) { dp.querySelector('.pane-handle').click(); await sleep(150); }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300);
    // Shown, however it lays itself out: the roster is a frame above a
    // scrolling field now, so it shows as flex rather than block.
    const listBack = dp.querySelector('.dag-feedlist').style.display !== 'none';
    const stateCleared = !/^(LIVE|SETTLED|STALE)$/.test(state.textContent.trim());
    return { skipped: text ? null : 'no watched report (daemon predates the watch wire?)', text, offered, after, listBack, stateCleared };`);
  if (live.skipped) {
    console.log(`  skipped: ${live.skipped}`);
  } else {
    check('entering a feed reports its liveness on the bar', /^(LIVE|SETTLED|STALE)$/.test(live.text));
    check('the drawer offers REFRESH and the state survives a refresh', live.offered && /^(LIVE|SETTLED|STALE)$/.test(live.after));
    check('leaving the feed releases the watch: list back, state cleared', live.listBack && live.stateCleared);
  }
  }

  if (await stage('roster-order')) {
  const roster = await evalIn(`
    document.getElementById('gutter-files').click(); await sleep(800);
    const pill = document.getElementById('lang-pill');
    if (document.getElementById('lang-palette').hidden) { pill.click(); await sleep(150); }
    const li = document.getElementById('lang-input'); li.value = 'ls /bin';
    li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled();
    pill.click(); await sleep(100);
    const fp = document.querySelector('.pane-files');
    for (let i = 0; i < 60; i++) { await sleep(500); if (fp.querySelectorAll('.files-row').length > 3) break; }
    const caps = fp.querySelectorAll('.roster-cap').length;
    const names = () => [...fp.querySelectorAll('.files-row .files-name')].map(e => e.textContent).filter(n => n !== '..');
    const before = names().slice(0, 3).join('|');
    fp.querySelector('.roster-cap[data-key="name"]').click(); await sleep(250);
    const after = names().slice(0, 3).join('|');
    const lit = fp.querySelector('.roster-cap.roster-active') !== null;
    fp.querySelector('.files-filter').click(); await sleep(200);
    const strip = fp.querySelector('.roster-filter').getBoundingClientRect().height > 0;
    const input = fp.querySelector('.roster-filter-input');
    input.value = 'zzzz-no-such-entry'; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(250);
    const state = fp.querySelector('.pane-state').textContent;
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
    fp.querySelector('.files-filter').click(); await sleep(100);
    return { caps, sorted: before !== after && before.length > 0, lit, strip, state };`);
  check('column caps sort the files listing (touch to sort, lit when active)', roster.caps >= 4 && roster.sorted && roster.lit, JSON.stringify(roster));
  check('FILTER summons the strip and the bar carries FILTERED n/m', roster.strip && /(^|· )FILTERED 0\//.test(roster.state), roster.state);
  }

  if (await stage('pacs-listing')) {
  // A query's answer is the same listing the other two panes are: a frame
  // that sorts and filters, caps minted per study over one column
  // declaration, verbs outside the grid, progress at every level.
  const pacsFrame = await evalIn(`
    document.getElementById('gutter-tools').click(); await sleep(700);
    const ws = document.getElementById('pacs-workspace');
    const frame = ws.querySelector('#pacs-results > .roster-order') !== null;
    const field = ws.querySelector('#pacs-results > .listing-field') !== null;
    const patientCaps = [...ws.querySelectorAll('#pacs-results > .roster-order .roster-cap')].map(c => c.textContent.trim());
    const strip = () => ws.querySelector('#pacs-results .roster-filter').getBoundingClientRect().height;
    const rest = strip();
    ws.querySelector('.pacs-listing .mode-strip').click(); await sleep(350);
    const framed = ws.dataset.modes === 'open';
    const pill = ws.querySelector('.pacs-filter');
    pill.click(); await sleep(250);
    const open = strip() > 0; const onLabel = pill.textContent.trim();
    pill.click(); await sleep(250);
    const shut = strip(); const offLabel = pill.textContent.trim();
    document.getElementById('pacs-results').click(); await sleep(300);
    const retracted = ws.dataset.modes !== 'open';
    return { frame, field, patientCaps, rest, framed, open, onLabel, shut, offLabel, retracted };`);
  check('the PACS results are a framed field: frame outside the scroll, mode frame on the spine',
    pacsFrame.frame === true && pacsFrame.field === true
    && pacsFrame.framed === true && pacsFrame.retracted === true, JSON.stringify(pacsFrame));
  // The MRN level is the outermost one, always: a listing that reports on
  // a set says what happened to every member of it, and only the record of
  // what was ASKED can mention a patient who has no studies.
  check('the patient caps head the region before any answer, ANSWERED among them',
    Array.isArray(pacsFrame.patientCaps) && pacsFrame.patientCaps.includes('PATIENT')
    && pacsFrame.patientCaps.includes('MRN') && pacsFrame.patientCaps.includes('ANSWERED')
    && pacsFrame.patientCaps.includes('STUDIES') && pacsFrame.patientCaps.includes('SERVER'),
    JSON.stringify(pacsFrame.patientCaps));
  // The join is round at every phase of the breath, and nothing sits under
  // the elbow's fillet: the caps row clears its reach.
  const join = await evalIn(`
    const listing = document.querySelector('.pacs-listing');
    const elbow = listing.querySelector('.mode-elbow');
    const strip = listing.querySelector('.mode-strip');
    const e = elbow.getBoundingClientRect();
    const cs = getComputedStyle(elbow, '::after');
    const fillet = { left: e.left + parseFloat(cs.left), top: e.top + parseFloat(cs.top), right: e.left + parseFloat(cs.left) + parseFloat(cs.width), bottom: e.top + parseFloat(cs.top) + parseFloat(cs.height) };
    const under = [...listing.querySelectorAll('.roster-cap, .listing-row > span')].filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.right > fillet.left && r.left < fillet.right && r.bottom > fillet.top && r.top < fillet.bottom; }).map((c) => c.textContent.trim());
    return { stripRadius: getComputedStyle(strip).borderTopRightRadius, elbowRadius: getComputedStyle(elbow).borderTopRightRadius, under };`);
  check('the strip wears the elbow\'s sweep, so the join is round at every phase of the breath', join.stripRadius === join.elbowRadius && join.elbowRadius !== '0px', JSON.stringify(join));
  check('nothing sits under the elbow\'s fillet: the caps clear its reach', join.under.length === 0, JSON.stringify(join));
  check('FILTER summons the results strip and reads its state',
    pacsFrame.rest === 0 && pacsFrame.open === true && pacsFrame.onLabel === 'FILTER ON'
    && pacsFrame.shut === 0 && pacsFrame.offLabel === 'FILTER OFF', JSON.stringify(pacsFrame));

  // The query form stands on the listing's own grid, in the caps' order: a
  // term is typed in the column it will fill.
  const pacsForm = await evalIn(`
    document.getElementById('gutter-tools').click(); await sleep(600);
    const l = (el) => Math.round(el.getBoundingClientRect().left);
    const caps = new Map([...document.querySelectorAll('#pacs-results > .roster-order .roster-cap')]
      .map(c => [c.dataset.key, l(c)]));
    const cells = [...document.querySelectorAll('#pacs-form [data-key]')];
    // The form stands on the STUDY grid, which is where its date, accession
    // and modality terms are answered; its patient terms are answered a
    // level up, and those two columns share the same tracks — so the caps
    // heading the region name them in the same places.
    const off = cells.filter(c => caps.has(c.dataset.key))
      .map(c => [c.dataset.key, l(c) - caps.get(c.dataset.key)]);
    // The two patient terms are answered by the caps heading the region;
    // the rest are answered a level down, where the study caps are minted.
    const patientTerms = off.filter(([key]) => key === 'patient' || key === 'mrn').length;
    // The order the form lowers to is the order the columns read in.
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pacs-f-name', 'AAA'); set('pacs-f-mrn', '111'); set('pacs-f-date', '20100101');
    set('pacs-f-accession', '222'); set('pacs-f-modality', 'CT');
    await sleep(200);
    const line = document.getElementById('pacs-command').value;
    for (const id of ['pacs-f-name','pacs-f-mrn','pacs-f-date','pacs-f-accession','pacs-f-modality']) set(id, '');
    await sleep(150);
    return { off, line, patientTerms, run: l(document.getElementById('pacs-run')) };`);
  check('the query form stands on the listing grid, in the caps\' order',
    pacsForm.patientTerms === 2
    && pacsForm.off.filter(([key]) => key === 'patient' || key === 'mrn')
      .every(([, delta]) => delta === 0)
    && pacsForm.line === 'pacs query PatientName:AAA,PatientID:111,StudyDate:20100101,AccessionNumber:222,Modality:CT',
    JSON.stringify(pacsForm));

  // Two exports, two scopes. The answer's export stands on the command
  // line; the cohort's rides the cohort row in the GATHER pane (below), so
  // there is no tray under the results for the two to be confused in.
  const pacsExports = await evalIn(`
    document.getElementById('gutter-tools').click(); await sleep(600);
    const table = document.getElementById('pacs-export');
    const line = document.getElementById('pacs-commandline');
    const box = table ? table.getBoundingClientRect() : null;
    return {
      tableLabel: table ? table.textContent.trim() : null,
      tableOnTheLine: line !== null && table !== null && line.contains(table),
      // Wide enough to read its own label: it lived on the results frame,
      // which is the CLOSED spine until someone opens it, so it rendered as
      // 22px of clipped text and read as missing.
      tableWidth: box ? Math.round(box.width) : 0,
      trayGone: document.getElementById('pacs-gather') === null,
    };`);
  check("the answer's export is readable without opening anything",
    pacsExports.tableLabel === 'EXPORT CSV' && pacsExports.tableOnTheLine === true
    && pacsExports.tableWidth > 60,
    JSON.stringify(pacsExports));
  check('no tray stands under the results: the cohort is a pane',
    pacsExports.trayGone === true, JSON.stringify(pacsExports));

  // Demonstrating against a live hospital PACS puts a real name and record
  // number on a projector. ANON arms the kernel's stand-ins and masks every
  // field in the pane that carries what was typed — including the command
  // line, which spells the same values back.
  const pacsAnon = await evalIn(`
    document.getElementById('gutter-tools').click(); await sleep(600);
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const typed = (id) => document.getElementById(id).type;
    set('pacs-f-mrn', '1234567');
    await sleep(150);
    const before = { line: document.getElementById('pacs-command').value, mrn: typed('pacs-f-mrn'), label: document.getElementById('pacs-anon').textContent.trim() };
    document.getElementById('pacs-anon').click(); await sleep(250);
    const armed = {
      line: document.getElementById('pacs-command').value,
      mrn: typed('pacs-f-mrn'), command: typed('pacs-command'), accession: typed('pacs-f-accession'),
      label: document.getElementById('pacs-anon').textContent.trim(),
      revealShown: document.getElementById('pacs-reveal').hidden === false,
      rows: document.querySelectorAll('#pacs-results .listing-row').length,
    };
    document.getElementById('pacs-reveal').click(); await sleep(200);
    const revealed = { mrn: typed('pacs-f-mrn'), command: typed('pacs-command') };
    document.getElementById('pacs-anon').click(); await sleep(250);
    const disarmed = { line: document.getElementById('pacs-command').value, mrn: typed('pacs-f-mrn'), label: document.getElementById('pacs-anon').textContent.trim() };
    set('pacs-f-mrn', '');
    await sleep(150);
    return { before, armed, revealed, disarmed };`);
  check("ANON arms the stand-ins on the line and reads its state",
    pacsAnon.before.label === 'ANON OFF' && pacsAnon.before.line === 'pacs query PatientID:1234567'
    && pacsAnon.armed.label === 'ANON ON' && pacsAnon.armed.line === 'pacs query PatientID:1234567 --anon',
    JSON.stringify(pacsAnon));
  check("ANON masks every field that carries what was typed, the command line included",
    pacsAnon.before.mrn === 'text' && pacsAnon.armed.mrn === 'password'
    && pacsAnon.armed.command === 'password' && pacsAnon.armed.accession === 'password',
    JSON.stringify(pacsAnon));
  check("REVEAL lifts the mask, so a typed record number can be checked before it is asked",
    pacsAnon.armed.revealShown === true && pacsAnon.revealed.mrn === 'text' && pacsAnon.revealed.command === 'text',
    JSON.stringify(pacsAnon));
  check("disarming takes the flag off the line and unmasks",
    pacsAnon.disarmed.label === 'ANON OFF' && pacsAnon.disarmed.line === 'pacs query PatientID:1234567'
    && pacsAnon.disarmed.mrn === 'text',
    JSON.stringify(pacsAnon));

  // Sorting needs an actual answer, so it needs a PACS to answer. Set
  // SMOKE_PACS_QUERY to a query that finds at least one study with two
  // series (e.g. 'pacs query PatientID:12345').
  const pacsQuery = process.env.SMOKE_PACS_QUERY;
  if (!pacsQuery) {
    console.log('  skipped: set SMOKE_PACS_QUERY=<a `pacs query ...` line that finds a study of two or more series>');
  } else {
    const pacsSort = await evalIn(`
      document.getElementById('gutter-tools').click(); await sleep(500);
      const cmd = document.getElementById('pacs-command');
      cmd.value = ${JSON.stringify(pacsQuery)};
      cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 180; i++) { await sleep(1000);
        if (document.querySelectorAll('#pacs-results .pacs-study').length > 0) break; }
      // A repeat of the same answer can land a moment later; let it, so the
      // fold under test is the operator's and not a race with the wire.
      await sleep(2500);
      const study = () => document.querySelector('#pacs-results .pacs-study');
      if (!study()) return { studies: 0 };
      // A closed group holds no level; activating its row opens it (the
      // façade repaints on the next frame).
      if (!study().classList.contains('listing-open')) {
        study().querySelector('.pacs-study-row .listing-control').click(); await sleep(400);
      }
      const names = () => [...study().querySelectorAll('.pacs-series .pacs-series-desc')].map(e => e.textContent);
      const before = names().join('|');
      const caps = study().querySelectorAll('.roster-cap').length;
      const track = study().querySelector('.pacs-study-progress .listing-progress') !== null;
      const accession = study().querySelector('.pacs-study-accession')?.textContent ?? '';
      // A row's verbs live in the frame: no series row carries one; a
      // click on a series puts its verbs in the row zone and opens the
      // frame, and the study row, clicked, is indicated as well as folded.
      const ws = document.getElementById('pacs-workspace');
      const zoneVerbs = () => [...ws.querySelectorAll('.pacs-row-zone .listing-action')].map(b => b.textContent.trim());
      const onRows = study().querySelectorAll('.listing-action').length;
      study().querySelector('.pacs-series').click(); await sleep(400);
      const seriesVerbs = zoneVerbs();
      const framed = ws.dataset.modes === 'open';
      const seriesLit = study().querySelector('.pacs-series.listing-indicated') !== null;
      const verbs = onRows === 0 && seriesVerbs.length > 0 && framed && seriesLit;
      // Two intents on the study row: the control cell folds and selects
      // nothing; the row body selects and folds nothing.
      const wasOpen = study().classList.contains('listing-open');
      study().querySelector('.pacs-study-row .listing-control').click(); await sleep(400);
      const foldOnly = { toggled: study().classList.contains('listing-open') !== wasOpen, studyLit: study().querySelector('.pacs-study-row').classList.contains('listing-indicated') };
      study().querySelector('.pacs-study-row .listing-control').click(); await sleep(400);
      study().querySelector('.pacs-study-row .pacs-study-desc, .pacs-study-row > span:nth-child(4)').click(); await sleep(400);
      const selectOnly = { stillOpen: study().classList.contains('listing-open') === wasOpen, studyLit: study().querySelector('.pacs-study-row').classList.contains('listing-indicated'), verbs: zoneVerbs() };
      const foldBox = study().querySelector('.pacs-study-row .listing-control').getBoundingClientRect();
      const foldTarget = { w: Math.round(foldBox.width), h: Math.round(foldBox.height) };
      ws.querySelector('.pacs-row-zone')?.closest('.mode-frame') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300);
      study().querySelector('.roster-cap[data-key="series"]').click(); await sleep(400);
      const ascending = names().join('|');
      const lit = study().querySelector('.roster-cap.roster-active') !== null;
      study().querySelector('.roster-cap[data-key="series"]').click(); await sleep(400);
      const descending = names().join('|');
      return { studies: 1, rows: names().length, before, ascending, descending, caps, track, verbs, lit, accession, foldOnly, selectOnly, foldTarget };`);
    // An answer that was not fetched now says when it was, and the control
    // reads as what it will do next.
    const pacsProvenance = await evalIn(`
      document.getElementById('gutter-tools').click(); await sleep(500);
      const ws = document.getElementById('pacs-workspace');
      const said = () => ws.querySelector('#pacs-provenance');
      const run = () => ws.querySelector('#pacs-run');
      const cmd = () => ws.querySelector('#pacs-command');
      const studies = () => document.querySelectorAll('#pacs-results .pacs-study').length;
      // A previous scenario's answer is still on stage, so waiting for
      // studies to EXIST would sample the old one. Wait for this query to
      // clear the field, then for its own answer to land.
      const answer_await = async () => {
        for (let i = 0; i < 60; i++) { await sleep(100);
          if (document.querySelector('#pacs-results .pacs-waiting')) break; }
        for (let i = 0; i < 240; i++) { await sleep(1000); if (studies() > 0) break; }
        await sleep(2500);
      };
      cmd().value = ${JSON.stringify(pacsQuery)};
      cmd().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await answer_await();
      const shown = !said().hidden;
      const text = said().textContent.trim();
      const label = run().textContent.trim();
      const deeper = run().classList.contains('pacs-capsule-requery');
      // Re-asking must put the flag in the line the operator can read.
      run().click(); await sleep(300);
      const line = cmd().value;
      await answer_await();
      return { shown, text, label, deeper, line, studies: studies(),
        clearedReadout: said().hidden, clearedLabel: run().textContent.trim(),
        clearedLine: cmd().value };`);
    check('a replayed answer says when it was answered, and the control reads RE-QUERY',
      pacsProvenance.shown === true && /^RESULTS \d{4}-\d{2}-\d{2}/.test(pacsProvenance.text)
      && / AGO$/.test(pacsProvenance.text)
      && pacsProvenance.label === 'RE-QUERY' && pacsProvenance.deeper === true,
      JSON.stringify(pacsProvenance));
    check('RE-QUERY lowers to --fresh in the visible line, and a fresh answer clears the readout',
      / --fresh$/.test(pacsProvenance.line) && pacsProvenance.clearedReadout === true
      && pacsProvenance.clearedLabel === 'QUERY'
      && !/--fresh/.test(pacsProvenance.clearedLine),
      JSON.stringify(pacsProvenance));

    check('the control cell folds and selects nothing; the row selects and folds nothing',
      pacsSort.foldOnly?.toggled === true && pacsSort.foldOnly?.studyLit === false
      && pacsSort.selectOnly?.stillOpen === true && pacsSort.selectOnly?.studyLit === true && pacsSort.selectOnly?.verbs.includes('PULL STUDY'),
      JSON.stringify({ fold: pacsSort.foldOnly, select: pacsSort.selectOnly }));
    check('the control cell is a target, not a glyph', pacsSort.foldTarget?.w >= 24 && pacsSort.foldTarget?.h >= 24, JSON.stringify(pacsSort.foldTarget));
    check('a study heads its series with caps and a summed track, and the series verbs live in the frame',
      pacsSort.studies === 1 && pacsSort.caps >= 4 && pacsSort.track === true && pacsSort.verbs === true
      && pacsSort.accession.length > 0,
      JSON.stringify(pacsSort));
    // The bars are read as a column, so their right edges must be one line.
    // They were not: the bar and its state note shared a flexible cell, so
    // every bar stopped where its own note began and `NOT RETRIEVED` beside
    // `\u2713 74 IN CUBE` tore the edge. The note has a track of its own now,
    // wide enough for the longest thing a series ever says.
    const pacsBars = await evalIn(`
      const badges = [...document.querySelectorAll('#pacs-results .pacs-badge')];
      const bars = badges.map(b => b.querySelector('.listing-progress, .pacs-bar-full')).filter(Boolean)
        .map(el => Math.round(el.getBoundingClientRect().right));
      const notes = [...document.querySelectorAll('#pacs-results .pacs-badge-note')];
      const clipped = notes.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent.trim());
      // The widest note a series can carry, measured where it would sit.
      let needed = 0, track = 0;
      if (notes.length > 0) {
        const probe = notes[0].cloneNode(true);
        probe.textContent = 'RETRIEVING 1410/1760';
        probe.style.width = 'max-content';
        notes[0].parentElement.appendChild(probe);
        needed = Math.ceil(probe.getBoundingClientRect().width);
        probe.remove();
        track = Math.round(notes[0].getBoundingClientRect().width);
      }
      const files = [...document.querySelectorAll('#pacs-results .pacs-series-files')];
      const fileRights = files.map(f => Math.round(f.getBoundingClientRect().right));
      return { bars: bars.length, edges: [...new Set(bars)], clipped, needed, track,
        filesFlush: fileRights.length > 1 ? Math.max(...fileRights) - Math.min(...fileRights) : 0,
        filesAlign: files[0] ? getComputedStyle(files[0]).textAlign : '' };`);
    check('every series bar ends on the same line, whatever its state says',
      pacsBars.bars > 1 && pacsBars.edges.length === 1, JSON.stringify(pacsBars));
    check('the state note has room for the longest thing a series says',
      pacsBars.clipped.length === 0 && pacsBars.track >= pacsBars.needed, JSON.stringify(pacsBars));
    check('the file counts are set flush right, so a column of them reads',
      pacsBars.filesAlign === 'right' && pacsBars.filesFlush === 0, JSON.stringify(pacsBars));

    check('sorting a study reorders its series, and reverses',
      pacsSort.rows > 1 && pacsSort.lit === true
      && pacsSort.ascending !== pacsSort.descending
      && pacsSort.ascending === pacsSort.ascending.split('|').sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).join('|'),
      JSON.stringify(pacsSort));
  }

  // The MRN level answers for a SET: every patient asked gets a row, and
  // what became of each is readable at a glance. Set SMOKE_PACS_COHORT to
  // a `pacs query --patients a,b` line whose MRNs include at least one the
  // PACS will not match.
  const pacsCohort = process.env.SMOKE_PACS_COHORT;
  if (!pacsCohort) {
    console.log('  skipped: set SMOKE_PACS_COHORT=<a `pacs query --patients a,b` line, one MRN a miss>');
  } else {
    const cohort = await evalIn(`
      document.getElementById('gutter-tools').click(); await sleep(600);
      const ws = document.getElementById('pacs-workspace');
      const cmd = ws.querySelector('#pacs-command');
      const rows = () => [...ws.querySelectorAll('#pacs-results .pacs-patient-row')];
      cmd.value = ${JSON.stringify(pacsCohort)};
      cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 300; i++) { await sleep(1000); if (rows().length > 1) break; }
      await sleep(2000);
      const mrns = rows().map(r => r.querySelector('.pacs-patient-mrn')?.textContent ?? '');
      const studies = rows().map(r => r.querySelector('.pacs-patient-count')?.textContent ?? '');
      const answered = rows().map(r => r.querySelector('.pacs-patient-answered')?.textContent ?? '');
      const bar = ws.querySelector('.pane-state')?.textContent ?? '';
      const tracks = rows().filter(r => r.querySelector('.pacs-patient-progress .listing-progress')).length;
      // A crowd arrives folded; unfolding one patient shows its studies.
      // The first patient the PACS answered (a miss has nothing to unfold).
      // A folding row's group wears listing-open, and its control cell folds
      // it: a press on the row itself selects and folds nothing.
      const firstKey = (rows().find((r) => r.classList.contains('listing-activatable')) ?? rows()[0])?.dataset.key;
      const patient = () => rows().find((r) => r.dataset.key === firstKey);
      const foldedBefore = !patient()?.parentElement.classList.contains('listing-open');
      // The press re-renders the listing: the patient is found again by its key.
      (patient()?.querySelector('.listing-control') ?? patient())?.click(); await sleep(800);
      const first = patient();
      const openAfter = first?.parentElement.classList.contains('listing-open') ?? false;
      // The patient's study level is the first nested level inside its group
      // (the façade's .listing-level); its caps are minted there.
      const studyLevel = first?.parentElement.querySelector('.listing-level') ?? null;
      const studyCaps = [...(studyLevel?.querySelectorAll(':scope > .roster-caps .roster-cap') ?? [])]
        .map(c => c.textContent.trim());
      // A term is typed in the column it fills: the study-level terms of
      // the form stand over the study caps, which are minted a level down.
      const l = (el) => Math.round(el.getBoundingClientRect().left);
      const caps = new Map([...(studyLevel?.querySelectorAll(':scope > .roster-caps .roster-cap') ?? [])]
        .map(c => [c.dataset.key, l(c)]));
      const studyTerms = [...document.querySelectorAll('#pacs-form [data-key]')]
        .filter(c => ['date', 'accession', 'modality', 'server'].includes(c.dataset.key))
        .map(c => [c.dataset.key, caps.has(c.dataset.key) ? l(c) - caps.get(c.dataset.key) : 'no-cap']);
      return { count: rows().length, mrns, studies, answered, bar, tracks, foldedBefore, openAfter, studyCaps, studyTerms };`);
    check('every patient asked gets a row, misses included',
      cohort.count >= 2 && cohort.studies.includes('0'),
      // Counts, never the MRNs themselves: a test log is not a place for patient identifiers.
      JSON.stringify({ n: cohort.count, mrns: (cohort.mrns ?? []).length, studies: cohort.studies }));
    check('the bar counts what was found, what was not, and what could not be asked',
      /FOUND \d+ · NONE \d+ · UNASKED \d+/.test(cohort.bar), JSON.stringify(cohort.bar));
    check('each patient row says how old its own answer is',
      Array.isArray(cohort.answered) && cohort.answered.every((text) => text.trim() !== ''),
      JSON.stringify(cohort.answered));
    check('a patient sums the progress of everything beneath it',
      cohort.tracks === cohort.count, JSON.stringify({ tracks: cohort.tracks, rows: cohort.count }));
    check('the form\'s study terms stand over the study caps, a level down',
      Array.isArray(cohort.studyTerms) && cohort.studyTerms.length === 4
      && cohort.studyTerms.every(([, delta]) => delta === 0),
      JSON.stringify(cohort.studyTerms));
    check('a cohort arrives folded, and a patient unfolds into its studies',
      cohort.foldedBefore === true && cohort.openAfter === true
      && cohort.studyCaps.includes('ACCESSION'),
      JSON.stringify({ folded: cohort.foldedBefore, open: cohort.openAfter, caps: cohort.studyCaps }));
  }
  }

  if (await stage('verbs-fit-their-track')) {
    // A row's verbs must fit the track declared for them. The PACS series
    // track was sized for one verb; adding a second pushed the first out of
    // its cell, and the GATHER a whole workflow starts with went missing
    // from every series already in CUBE. Nothing caught it, because nothing
    // had ever asked whether a capsule lands inside the cell holding it.
    // Whatever listing is on stage answers: this needs no PACS of its own.
    // Verbs stand in a row's own track (a listing with no frame) or in the
    // frame's row zone (every framed listing): indicate a row in Home so
    // there are verbs on stage to measure, wherever they stand.
    const fit = await evalIn(`
      await console_idle();
      document.getElementById('gutter-files').click(); await sleep(800);
      const fp = [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
      for (let i = 0; i < 40 && (fp?.querySelectorAll('.files-row').length ?? 0) < 2; i++) await sleep(250);
      // An entry of the directory: not the way up, not the trail row (~/…).
      const row = [...(fp?.querySelectorAll('.files-row') ?? [])].find((r) => !/^(\\.\\.|~|\\/)/.test(r.querySelector('.files-name')?.textContent.trim() ?? '..'));
      row?.querySelector('.files-name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 20 && !fp?.querySelector('.listing-zone .listing-action'); i++) await sleep(150);
      const bad = [];
      let cells = 0;
      for (const zone of document.querySelectorAll('.listing-zone')) {
        const box = zone.getBoundingClientRect();
        if (box.width === 0) continue;
        const verbs = [...zone.querySelectorAll('.listing-action')].filter((b) => b.getBoundingClientRect().width > 0);
        if (verbs.length === 0) continue;
        cells += 1;
        for (const verb of verbs) {
          const v = verb.getBoundingClientRect();
          if (v.left < box.left - 1 || v.right > box.right + 1) bad.push(\`\${verb.textContent.trim()} in a \${Math.round(box.width)}px zone\`);
        }
      }
      for (const cell of document.querySelectorAll('.listing-actions')) {
        const box = cell.getBoundingClientRect();
        if (box.width === 0) continue;
        const verbs = [...cell.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0);
        if (verbs.length === 0) continue;
        cells += 1;
        for (const verb of verbs) {
          const v = verb.getBoundingClientRect();
          // A pixel of rounding is not an overflow; a whole capsule is.
          if (v.left < box.left - 1 || v.right > box.right + 1) {
            bad.push(\`\${verb.textContent.trim()} in a \${Math.round(box.width)}px track\`);
          }
        }
      }
      // Leave as found: the row stands down.
      document.getElementById('status-strip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(200);
      return { cells, bad: bad.slice(0, 6) };`);
    if (fit.cells === 0) {
      console.log('  skipped: no listing with row verbs on stage');
    } else {
      check('every row verb fits inside the track or zone that holds it', fit.bad.length === 0, `${fit.cells} cells · ${fit.bad.join('; ')}`);
    }
  }

  if (await stage('gather-pane')) {
  // GATHER lands in the cohort, the header's third face (since 2026-09-18
  // the cohort rides the header; a pane is its escape, ON STAGE). The first
  // gather reveals the band; the cohort row carries SAVE / EXPORT CSV /
  // CREATE FEED / PROCESS / DISMISS, a series row REMOVE / IMAGE / PROCESS;
  // REMOVE takes the row out, DISMISS sends the band away. The suite starts
  // the cohort empty (`gather clear`) and the operator's file is restored at
  // the end.
  if (!process.env.SMOKE_PACS_QUERY) {
    console.log('  skipped: set SMOKE_PACS_QUERY=<a `pacs query ...` line that finds a study with a series in CUBE>');
  } else {
    const gather = await evalIn(`
      await console_idle();
      const startedEmpty = await cohort_empty();
      const band = document.getElementById('header-gather');
      document.getElementById('gutter-tools')?.click(); await sleep(500);
      const ws = document.getElementById('pacs-workspace');
      const cmd = document.getElementById('pacs-command');
      const studies = () => document.querySelectorAll('#pacs-results .pacs-study').length;
      cmd.value = ${JSON.stringify(process.env.SMOKE_PACS_QUERY)};
      cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 60; i++) { await sleep(100); if (document.querySelector('#pacs-results .pacs-waiting')) break; }
      for (let i = 0; i < 240; i++) { await sleep(1000); if (studies() > 0) break; }
      await sleep(2500);
      const study = document.querySelector('#pacs-results .pacs-study');
      if (!study) return { error: 'no study' };
      if (!study.classList.contains('listing-open')) { study.querySelector('.pacs-study-row .listing-control')?.click(); await sleep(400); }
      const zoneVerbs = (root, zone) => [...root.querySelectorAll(zone + ' .listing-action')].map(b => b.textContent.trim());
      const series = [...study.querySelectorAll('.pacs-series')];
      // a series CUBE holds is gathered, not pulled
      let picked = null;
      for (const row of series) { row.click(); await sleep(300); if (zoneVerbs(ws, '.pacs-row-zone').includes('GATHER')) { picked = row; break; } }
      if (!picked) return { error: 'no series in CUBE to gather' };
      const uid = picked.dataset.seriesuid;
      [...ws.querySelectorAll('.pacs-row-zone .listing-action')].find(b => b.textContent.trim() === 'GATHER')?.click();
      // The band redraws from the kernel's answer, a CUBE round trip away.
      for (let i = 0; i < 80; i++) { await sleep(250); if (band.querySelector('.gather-series')) break; }
      await sleep(600);
      const revealed = document.body.dataset.header === 'gather';
      const rows = () => [...band.querySelectorAll('.gather-series')].map(r => r.dataset.seriesuid);
      const listed = rows();
      const caps = [...band.querySelectorAll('.roster-cap')].map(c => c.textContent.trim());
      const count = band.querySelector('.gather-cohort-count')?.textContent.trim() ?? null;
      // the PACS row's GATHER lights from the cohort
      picked.click(); await sleep(300);
      const lit = [...ws.querySelectorAll('.pacs-row-zone .listing-action')].find(b => b.textContent.trim() === 'GATHER')?.classList.contains('listing-action-selected') ?? false;
      document.getElementById('status-strip').dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(200);
      // series row: its verbs
      band.querySelector('.gather-series')?.click(); await sleep(400);
      const seriesVerbs = zoneVerbs(band, '.gather-row-zone');
      // cohort row: its verbs
      band.querySelector('.gather-cohort-row .gather-cohort-name')?.click(); await sleep(400);
      const cohortVerbs = zoneVerbs(band, '.gather-row-zone');
      // REMOVE takes the row out
      band.querySelector('.gather-series')?.click(); await sleep(300);
      [...band.querySelectorAll('.gather-row-zone .listing-action')].find(b => b.textContent.trim() === 'REMOVE')?.click();
      for (let i = 0; i < 80 && rows().length > 0; i++) await sleep(250);
      const afterRemove = rows();
      // DISMISS sends the band away
      band.querySelector('.gather-cohort-row .gather-cohort-name')?.click(); await sleep(300);
      [...band.querySelectorAll('.gather-row-zone .listing-action')].find(b => b.textContent.trim() === 'DISMISS')?.click(); await sleep(800);
      const dismissed = document.body.dataset.header !== 'gather';
      await home_return();
      return { startedEmpty, revealed, listed, uid, caps, count, lit, seriesVerbs, cohortVerbs, afterRemove, dismissed };`);
    check('gathering a series reveals the cohort in the header, listing it',
      gather.error === undefined && gather.revealed && gather.listed.length === 1 && gather.listed[0] === gather.uid,
      JSON.stringify({ error: gather.error, startedEmpty: gather.startedEmpty, revealed: gather.revealed, listed: (gather.listed ?? []).length }));
    check('the cohort and its series wear caps, and the cohort row counts its series',
      gather.error === undefined && gather.caps.includes('COHORT') && gather.caps.includes('SERIES') && /^1\b/.test(gather.count ?? ''),
      JSON.stringify({ caps: gather.caps, count: gather.count }));
    check("the PACS row's GATHER lights from the cohort", gather.error === undefined && gather.lit === true, String(gather.lit));
    check('a series row carries REMOVE / IMAGE / PROCESS, the cohort row SAVE / EXPORT CSV / CREATE FEED / PROCESS / DISMISS',
      gather.error === undefined && gather.seriesVerbs.join(',') === 'REMOVE,IMAGE,PROCESS' && gather.cohortVerbs.join(',') === 'SAVE,EXPORT CSV,CREATE FEED,PROCESS,DISMISS',
      JSON.stringify({ series: gather.seriesVerbs, cohort: gather.cohortVerbs }));
    check('REMOVE takes the series out; DISMISS sends the band away',
      gather.error === undefined && gather.afterRemove.length === 0 && gather.dismissed === true,
      JSON.stringify({ afterRemove: (gather.afterRemove ?? []).length, dismissed: gather.dismissed }));
  }
  }

  if (await stage('gather-series-parity')) {
  // A series looks the same wherever it is listed: the cohort's rows ARE
  // the PACS answer's series rows, so the one series, measured in both
  // listings, paints alike — plain, indicated, and dimmed beside another
  // row's indication. And an indicated bar keeps its colour: a series
  // pulled to the last file, selected, must not read like one never
  // fetched (a black fill in a black-tinted track once made it so). The
  // hue and the inversion were each decided per pane and per state; only
  // the same row in two places, side by side, shows them drift.
  if (!process.env.SMOKE_PACS_QUERY) {
    console.log('  skipped: set SMOKE_PACS_QUERY=<a `pacs query ...` line that finds a study with a series in CUBE>');
  } else {
    const parity = await evalIn(`
      document.getElementById('gutter-tools').click(); await sleep(500);
      const ws = document.getElementById('pacs-workspace');
      const cmd = document.getElementById('pacs-command');
      const studies = () => document.querySelectorAll('#pacs-results .pacs-study').length;
      cmd.value = ${JSON.stringify(process.env.SMOKE_PACS_QUERY)};
      cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 60; i++) { await sleep(100); if (document.querySelector('#pacs-results .pacs-waiting')) break; }
      for (let i = 0; i < 240; i++) { await sleep(1000); if (studies() > 0) break; }
      await sleep(2500);
      const study = document.querySelector('#pacs-results .pacs-study');
      if (!study) return { error: 'no study' };
      if (!study.classList.contains('listing-open')) { study.querySelector('.pacs-study-row .listing-control').click(); await sleep(400); }
      const zoneVerb = (root, zone, word) => [...root.querySelectorAll(zone + ' .listing-action')].find(b => b.textContent.trim() === word);
      // a series CUBE holds whole: gathered, and its bar full
      let picked = null;
      for (const row of study.querySelectorAll('.pacs-series')) {
        if (!row.querySelector('.pacs-bar-full')) continue;
        row.click(); await sleep(300);
        if (zoneVerb(ws, '.pacs-row-zone', 'GATHER')) { picked = row; break; }
      }
      if (!picked) return { error: 'no fully pulled series in CUBE to gather' };
      const uid = picked.dataset.seriesuid;
      zoneVerb(ws, '.pacs-row-zone', 'GATHER').click();
      const face = document.getElementById('header-gather');
      for (let i = 0; i < 80 && !face.querySelector('.gather-series[data-seriesuid="' + uid + '"]'); i++) await sleep(250);
      if (face.offsetParent === null) { document.getElementById('header-gather-pill').click(); await sleep(600); }
      if (face.offsetParent === null) { document.body.dataset.header = 'gather'; await sleep(600); }
      const band = () => face.querySelector('.gather-series[data-seriesuid="' + uid + '"]');
      const pacs = () => document.querySelector('#pacs-results .pacs-series[data-seriesuid="' + uid + '"]');
      if (!band()) return { error: 'the band does not list the gathered series', uid };
      // What a row wears, every part the eye compares.
      const paint = (row) => {
        const of = (sel, prop) => { const el = sel ? row.querySelector(sel) : row; return el ? getComputedStyle(el)[prop] : null; };
        return { row: of(null, 'backgroundColor'), opacity: of(null, 'opacity'), index: of('.listing-index', 'backgroundColor'), digits: of('.listing-index', 'color'),
          desc: of('.pacs-series-desc', 'color'), badge: of('.pacs-badge', 'color'), bar: of('.pacs-bar-full', 'backgroundColor'), note: of('.pacs-badge-note', 'color'), files: of('.pacs-series-files', 'color') };
      };
      const lit = (root) => root.querySelectorAll('.listing-indicated').length;
      const both = () => ({ pacs: paint(pacs()), band: paint(band()), litPacs: lit(document.getElementById('pacs-results')), litBand: lit(face) });
      // indicated in both
      pacs().click(); await sleep(300); band().click(); await sleep(300);
      const indicated = both();
      // the band's frame, open with the cohort's verbs: no scrollbar down it,
      // a chip saying how many blocks lie below when it holds more than the
      // band is tall, and no sideways scroll under the rows
      const frame = face.querySelector('.mode-frame'); const more = frame.querySelector('.frame-more');
      const listingField = face.querySelector('.listing-field'); const fieldChip = listingField.querySelector('.more-chip');
      const frameInfo = { scrollbar: scrollbarNone(frame) ? 'none' : getComputedStyle(frame).scrollbarWidth, overflowing: frame.scrollHeight > frame.clientHeight + 2, chip: more && !more.hidden ? more.textContent : null, fieldOX: getComputedStyle(listingField).overflowX, fieldScrollbar: scrollbarNone(listingField) ? 'none' : getComputedStyle(listingField).scrollbarWidth, fieldChip: fieldChip !== null, fieldChipHonest: (fieldChip?.hidden ?? true) === !(listingField.scrollHeight > listingField.clientHeight + 2) };
      // the idle track an indicated row would draw, beside the full bar it does
      const idle = document.createElement('span'); idle.className = 'listing-progress listing-progress-idle'; pacs().querySelector('.pacs-badge').appendChild(idle);
      const idleTrack = getComputedStyle(idle).backgroundColor; idle.remove();
      // dimmed: another row of each listing indicated
      const other = [...study.querySelectorAll('.pacs-series')].find(r => r !== pacs());
      if (other) { other.click(); await sleep(300); }
      face.querySelector('.gather-cohort-row .gather-cohort-name').click(); await sleep(300);
      const dimmed = both();
      // plain: nothing indicated in either listing. Esc retracts every
      // open frame, the band's with the panes', and a frame retracting
      // stands its row down.
      for (let i = 0; i < 3; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(250); }
      const bandFrameOpen = face.querySelector('[data-frame-host]')?.dataset.modes === 'open';
      const plain = both();
      // and the band's strip still brings its frame back, and the fill sends it away
      face.querySelector('.mode-strip').click(); await sleep(300);
      const stripOpens = face.querySelector('[data-frame-host]').dataset.modes === 'open';
      face.querySelector('.mode-strip').click(); await sleep(300);
      const stripCloses = face.querySelector('[data-frame-host]').dataset.modes !== 'open';
      // leave the cohort as it was found
      const input = console_input();
      input.value = 'gather clear'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(1500); await console_settled();
      return { uid, indicated, idleTrack, dimmed, plain, bandFrameOpen, stripOpens, stripCloses, frameInfo, other: other !== undefined };`);
    const same = (state) => state && JSON.stringify(state.pacs) === JSON.stringify(state.band);
    const lum = (css) => { const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(css ?? ''); if (!m) return 0; const a = m[4] === undefined ? 1 : Number(m[4]);
      const ch = (v) => { const c = (Number(v) / 255) * a; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * ch(m[1]) + 0.7152 * ch(m[2]) + 0.0722 * ch(m[3]); };
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    check('the same series paints alike in the cohort band and the PACS answer, indicated in both',
      parity.error === undefined && same(parity.indicated) && parity.indicated.litPacs === 1 && parity.indicated.litBand === 1,
      JSON.stringify(parity.error ?? parity.indicated));
    check('and alike when each is dimmed beside another indicated row',
      parity.error === undefined && same(parity.dimmed) && parity.dimmed.pacs.opacity !== parity.indicated.pacs.opacity,
      JSON.stringify(parity.error ?? parity.dimmed));
    check('and alike plain, nothing indicated: Esc retracts the band\'s frame with the panes\' and stands its row down',
      parity.error === undefined && same(parity.plain) && parity.plain.litPacs === 0 && parity.plain.litBand === 0 && parity.bandFrameOpen === false,
      JSON.stringify(parity.error ?? { plain: parity.plain, bandFrameOpen: parity.bandFrameOpen }));
    check("the band's frame wears no scrollbar: a chip says what lies below, and the rows never scroll sideways",
      parity.error === undefined && parity.frameInfo.scrollbar === 'none' && parity.frameInfo.fieldOX === 'hidden'
      && (!parity.frameInfo.overflowing || /^▼ \d+ MORE$/.test(parity.frameInfo.chip ?? ''))
      && parity.frameInfo.fieldScrollbar === 'none' && parity.frameInfo.fieldChip && parity.frameInfo.fieldChipHonest,
      JSON.stringify(parity.error ?? parity.frameInfo));
    check("the band's strip still brings its frame back and sends it away",
      parity.error === undefined && parity.stripOpens === true && parity.stripCloses === true,
      JSON.stringify({ stripOpens: parity.stripOpens, stripCloses: parity.stripCloses }));
    check('an indicated full bar keeps a colour: it stands off the idle track and the row',
      parity.error === undefined && contrast(parity.indicated.pacs.bar, parity.idleTrack) >= 3 && contrast(parity.indicated.pacs.bar, parity.indicated.pacs.row) >= 1.5,
      JSON.stringify(parity.error ?? { bar: parity.indicated?.pacs.bar, idleTrack: parity.idleTrack, row: parity.indicated?.pacs.row }));
  }
  }
  if (await stage('files-json')) {
  // A JSON file is shown as the structure it is: pretty-printed, keys and
  // strings and numbers and literals in their own hues, RAW for the bytes
  // as written. The cohort manifest is the file every session has.
  const json = await evalIn(`
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    const input = console_input();
    const say = async (line) => { await console_idle(); input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(80); await console_settled(); await console_idle(); };
    await say('cd ~/gather');
    // The gutter's FILES summons the browser from any stage; the dashboard's
    // OPEN HOME only while the dashboard is what is on stage.
    if (!fp()) { document.getElementById('gutter-files').click(); for (let i = 0; i < 40; i++) { await sleep(250); if (fp()) break; } }
    if (!fp()) { [...document.querySelectorAll('.launcher-verb')].find((b) => b.textContent.trim() === 'OPEN HOME')?.click(); for (let i = 0; i < 40; i++) { await sleep(250); if (fp()) break; } }
    if (!fp()) return { error: 'no files pane' };
    const rowOf = (word) => [...fp().querySelectorAll('.listing-row')].find((r) => r.textContent.includes(word));
    for (let i = 0; i < 40; i++) { await sleep(250); if (rowOf('current.json') || rowOf('gather')) break; }
    if (!rowOf('current.json') && rowOf('gather')) { (rowOf('gather').querySelector('.listing-control') ?? rowOf('gather')).click(); for (let i = 0; i < 40; i++) { await sleep(250); if (rowOf('current.json')) break; } }
    const row = rowOf('current.json');
    if (!row) { await home_return(); return { error: 'no current.json row' }; }
    (row.querySelector('.listing-control') ?? row).click();
    for (let i = 0; i < 40; i++) { await sleep(250); if (fp().querySelector('.files-content')) break; }
    const pane = fp(); const body = () => pane.querySelector('.files-content');
    const pills = () => [...pane.querySelectorAll('.files-content-header button')].map((b) => b.textContent.trim());
    const pill = (w) => [...pane.querySelectorAll('.files-content-header button')].find((b) => b.textContent.trim() === w);
    const pretty = { json: body().classList.contains('files-json'), keys: body().querySelectorAll('.json-key').length, lines: body().textContent.split('\\n').length, pills: pills() };
    // The content view is the pane's field: it scrolls inside the pane and
    // never runs past its foot (a long manifest's bottom was simply gone).
    const panel = pane.querySelector('.files-panel');
    const field = { overflowY: getComputedStyle(body()).overflowY, inside: Math.round(body().getBoundingClientRect().bottom) <= Math.round(panel.getBoundingClientRect().bottom) + 1, scrollbar: scrollbarNone(body()) ? 'none' : getComputedStyle(body()).scrollbarWidth, chip: body().querySelector('.more-chip') !== null, chipHonest: (body().querySelector('.more-chip')?.hidden ?? true) === !(body().scrollHeight > body().clientHeight + 2) };
    pill('RAW')?.click(); await sleep(400);
    const raw = { json: body().classList.contains('files-json'), lines: body().textContent.split('\\n').length, pills: pills() };
    pill('PRETTY')?.click(); await sleep(400);
    const back = body().classList.contains('files-json');
    pill('CLOSE')?.click(); await sleep(300);
    await home_return();
    return { pretty, raw, back, field };`);
  check('the content view scrolls inside the pane and never runs past its foot',
    json.error === undefined && json.field.overflowY === 'auto' && json.field.inside === true,
    JSON.stringify(json.error ?? json.field));
  check('the content view wears no scrollbar and its chip says what lies below',
    json.error === undefined && json.field.scrollbar === 'none' && json.field.chip && json.field.chipHonest,
    JSON.stringify(json.error ?? json.field));
  check('a JSON file opens pretty-printed with its keys marked, DOWNLOAD / RAW / CLOSE on its header',
    json.error === undefined && json.pretty.json && json.pretty.keys >= 3 && json.pretty.lines > 2 && json.pretty.pills.join(',') === 'DOWNLOAD,RAW,CLOSE',
    JSON.stringify(json.error ?? json.pretty));
  check('RAW shows the bytes as written and offers PRETTY, which returns to the structure',
    json.error === undefined && !json.raw.json && json.raw.lines < json.pretty.lines && json.raw.pills.join(',') === 'DOWNLOAD,PRETTY,CLOSE' && json.back === true,
    JSON.stringify(json.error ?? json.raw));
  }
  if (await stage('files-document')) {
  // A Markdown or AsciiDoc file opened to read shows its source in colour,
  // with RENDERED for the page it describes and SOURCE back; a Viewer pane
  // beside the browser shows it rendered. The fixture folder holds one of
  // each. SMOKE_SHOTS=<dir> keeps a screenshot of each view.
  const shot = async (name) => { if (process.env.SMOKE_SHOTS) await page.shot(`${process.env.SMOKE_SHOTS}/document-${name}.png`); };
  const prelude = `
    const input = console_input();
    const say = async (line) => { await console_idle(); input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120); await console_settled(); await console_idle(); };
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    const rowOf = (word) => [...fp().querySelectorAll('.listing-row')].find((r) => r.textContent.includes(word));
    const pills = () => [...fp().querySelectorAll('.files-content-header button')].map((b) => b.textContent.trim());
    const pill = (w) => [...fp().querySelectorAll('.files-content-header button')].find((b) => b.textContent.trim() === w);`;
  const open = (name) => evalIn(`${prelude}
    if (!fp()) { document.getElementById('gutter-files').click(); for (let i = 0; i < 40; i++) { await sleep(250); if (fp()) break; } }
    if (!fp()) return { error: 'no files pane' };
    await say('cd ${fixtureFolder}/docs');
    for (let i = 0; i < 40; i++) { await sleep(250); if (rowOf('${name}')) break; }
    const row = rowOf('${name}'); if (!row) return { error: 'no ${name} row' };
    (row.querySelector('.listing-control') ?? row).click();
    let body = null;
    for (let i = 0; i < 40; i++) { await sleep(250); body = fp().querySelector('.files-content.files-source'); if (body) break; }
    return { coloured: body?.querySelectorAll('span[class]').length ?? 0, text: (body?.textContent ?? '').slice(0, 20), pills: pills() };`);
  const render = () => evalIn(`${prelude}
    pill('RENDERED')?.click();
    let page = null;
    for (let i = 0; i < 60; i++) { await sleep(250); page = fp().querySelector('.doc-rendered'); if (page) break; }
    if (page === null) return { error: 'no rendered page', pills: pills() };
    await sleep(300);
    return { h1: page.querySelector('h1')?.textContent ?? null, ran: window.smokeDocRan === true, script: page.querySelector('script') !== null, admonition: page.querySelector('.admonitionblock') !== null, table: page.querySelector('table') !== null, pills: pills(), inside: Math.round(page.getBoundingClientRect().bottom) <= Math.round(fp().querySelector('.files-panel').getBoundingClientRect().bottom) + 1, scrolls: getComputedStyle(page).overflowY };`);
  const leave = () => evalIn(`${prelude}
    pill('SOURCE')?.click(); await sleep(400);
    const back = fp().querySelector('.doc-rendered') === null && fp().querySelector('.files-content') !== null;
    pill('CLOSE')?.click(); await sleep(400);
    return back;`);
  const doc = {};
  if (fixtureFolder === null) doc.error = 'no fixture folder';
  else {
    for (const [key, name] of [['md', 'README.md'], ['adoc', 'guide.adoc']]) {
      const source = await open(name); await shot(`${key}-source`);
      const rendered = await render(); await shot(`${key}-rendered`);
      doc[key] = { source, rendered, back: await leave() };
    }
    // The Viewer pane: bound to the browser's group, it renders what is indicated.
    doc.viewed = await evalIn(`${prelude}
      const leaves = () => [...document.querySelectorAll('.layout-leaf')].map((l) => l.dataset.leaf);
      const before = new Set(leaves());
      await say('pane bind viewer');
      await say('pane split right');
      const born = leaves().find((id) => !before.has(id));
      const viewer = born === undefined ? null : document.querySelector('.layout-leaf[data-leaf="' + born + '"]');
      if (viewer === null) return { error: 'no viewer pane' };
      const row = rowOf('guide.adoc');
      (row?.querySelector('.listing-control') ?? row)?.click();
      let page = null;
      for (let i = 0; i < 60; i++) { await sleep(250); page = viewer.querySelector('.doc-rendered'); if (page) break; }
      await sleep(300);
      return { born, h1: page?.querySelector('h1')?.textContent ?? null, browserStill: fp().querySelector('.files-content') === null };`);
    await shot('viewer');
    await evalIn(`${prelude}
      ${doc.viewed.born ? `document.querySelector('.layout-leaf[data-leaf="${doc.viewed.born}"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await say('pane close');` : ''}
      await say('cd ~');
      await home_return();
      return true;`).catch(() => undefined);
  }
  check('a Markdown file opens as its source in colour, DOWNLOAD / RENDERED / CLOSE on its header',
    doc.error === undefined && doc.md.source.coloured >= 3 && doc.md.source.text.startsWith('# ') && doc.md.source.pills.join(',') === 'DOWNLOAD,RENDERED,CLOSE',
    JSON.stringify(doc.error ?? doc.md?.source));
  check('RENDERED shows the Markdown as its page, its script not run, inside the pane; SOURCE returns',
    doc.error === undefined && doc.md.rendered.h1 === 'Smoke document' && doc.md.rendered.ran === false && doc.md.rendered.script === false && doc.md.rendered.table && doc.md.rendered.inside && doc.md.rendered.scrolls === 'auto' && doc.md.rendered.pills.join(',') === 'DOWNLOAD,SOURCE,CLOSE' && doc.md.back,
    JSON.stringify(doc.error ?? doc.md?.rendered));
  check('an AsciiDoc file opens in colour and renders with its admonition and table',
    doc.error === undefined && doc.adoc.source.coloured >= 3 && doc.adoc.rendered.h1 === 'Smoke guide' && doc.adoc.rendered.admonition && doc.adoc.rendered.table && doc.adoc.back,
    JSON.stringify(doc.error ?? doc.adoc));
  check('a Viewer pane beside the browser renders the indicated document',
    doc.error === undefined && doc.viewed.h1 === 'Smoke guide' && doc.viewed.browserStill === true,
    JSON.stringify(doc.error ?? doc.viewed));
  }
  if (await stage('dag-back-facts')) {
  // The way out of a graph is a press: BACK heads the graph's frame and
  // returns to the roster; a tap on the node facts plate's own ground
  // stands the plate down, as a tap on empty space does — on a phone the
  // plate reads as the background.
  const dagBack = await evalIn(`
    // The dashboard's analyses tile lists feeds: put it on stage rather than hope an earlier scenario left it there.
    document.getElementById('gutter-dashboard')?.click();
    const feedRow = () => [...document.querySelectorAll('.launcher-row')].find((e) => /^\\d{3,}\\s/.test(e.textContent.trim()) && !/ERRORED|FEEDS|ENTRIES/.test(e.textContent));
    for (let i = 0; i < 40 && !feedRow(); i++) await sleep(250);
    const row = feedRow();
    if (!row) return { skipped: 'no feed row on the dashboard' };
    row.click(); await sleep(1500);
    let canvas = null;
    for (let i = 0; i < 160; i++) { await sleep(500); canvas = [...document.querySelectorAll('.pane-dag canvas')].find((c) => c.offsetParent !== null); if (canvas) break; }
    if (!canvas) { await home_return(); return { skipped: 'no graph drawn in time' }; }
    await sleep(2500);
    const pane = canvas.closest('.pane-dag');
    const facts = pane.querySelector('.dag-facts'); const back = pane.querySelector('.dag-back');
    const backOnGraph = { hidden: back.hidden, first: back.parentElement.firstElementChild === back, text: back.textContent.trim() };
    const box = canvas.getBoundingClientRect();
    const shown = (await node_find(canvas, () => facts.textContent)) !== null;
    if (!shown) { await home_return(); return { skipped: 'no node found on the graph', backOnGraph }; }
    const fb = facts.getBoundingClientRect();
    const ground = document.elementFromPoint(fb.left + 3, fb.top + 3);
    ground.dispatchEvent(new MouseEvent('click', { clientX: fb.left + 3, clientY: fb.top + 3, bubbles: true })); await sleep(400);
    const cleared = facts.textContent.trim() === '';
    back.click(); await sleep(1500);
    const rosterShown = pane.querySelector('.dag-roster').classList.contains('roster-shown');
    const backHidden = back.hidden;
    await home_return();
    return { backOnGraph, groundWas: ground.className, cleared, rosterShown, backHidden };`);
  if (dagBack.skipped) {
    console.log(`  skipped: ${dagBack.skipped}`);
  } else {
    check('BACK heads the graph frame, and a press returns to the roster and hides itself',
      dagBack.backOnGraph.hidden === false && dagBack.backOnGraph.first && dagBack.backOnGraph.text === 'BACK' && dagBack.rosterShown && dagBack.backHidden,
      JSON.stringify(dagBack));
    check("a tap on the facts plate's own ground stands the plate down",
      /dag-facts/.test(dagBack.groundWas) && dagBack.cleared === true,
      JSON.stringify({ groundWas: dagBack.groundWas, cleared: dagBack.cleared }));
  }
  }
  if (await stage('header-grip')) {
  // The band's foot is a grip that stands whenever a face does — the
  // resting face included — and breathes; dragged, it resizes the band.
  const grip = await evalIn(`
    delete document.body.dataset.header; await sleep(600);
    const strip = document.getElementById('header-strip'); const face = () => [...document.querySelectorAll('.header-face')].find((f) => f.offsetParent !== null);
    const b = strip.getBoundingClientRect();
    const rest = { header: document.body.dataset.header ?? null, display: getComputedStyle(strip).display, breathes: getComputedStyle(strip, '::after').animationName, hit: (document.elementFromPoint(b.left + b.width / 2, b.top + 6) ?? {}).id ?? null };
    const before = Math.round(face()?.getBoundingClientRect().height ?? 0);
    const x = b.left + b.width / 2, y = b.top + 6;
    const ev = (type, yy) => strip.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, buttons: 1 }));
    ev('pointerdown', y); await sleep(50); for (let i = 1; i <= 8; i++) { ev('pointermove', y + i * 10); await sleep(20); } ev('pointerup', y + 80); await sleep(300);
    const after = Math.round(face()?.getBoundingClientRect().height ?? 0);
    const b2 = strip.getBoundingClientRect();
    ev('pointerdown', b2.top + 6); await sleep(50); for (let i = 1; i <= 8; i++) { ev('pointermove', b2.top + 6 - i * 10); await sleep(20); } ev('pointerup', b2.top + 6 - 80); await sleep(300);
    return { rest, before, after, restored: Math.round(face()?.getBoundingClientRect().height ?? 0) };`);
  check('the band grip stands on the resting face, breathes, and is what a press lands on',
    grip.rest.header === null && grip.rest.display !== 'none' && grip.rest.breathes === 'grip-breathe' && grip.rest.hit === 'header-strip',
    JSON.stringify(grip.rest));
  check('dragging the grip resizes the band, and back',
    grip.after > grip.before + 40 && Math.abs(grip.restored - grip.before) <= 2,
    JSON.stringify({ before: grip.before, after: grip.after, restored: grip.restored }));
  }
  if (await stage('netstat')) {
  // The wire is a readout: netstat counts what the session asked of CUBE,
  // by family, timed — and a navigation's cost is read from it, which is
  // how the budgets below are held.
  const net = await evalIn(`
    const input = console_input();
    const say = async (line) => { await console_idle(); input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(80); await console_settled(); await console_idle(); };
    const text = () => console_text();
    const after = (cmd) => { const t = text(); return t.slice(t.lastIndexOf('❯ ' + cmd) + cmd.length + 2); };
    // The boot's own cost, read before anything resets the ledger: the
    // group warm reads members off the membership pages and asks CUBE for
    // no user one by one (it asked for 51 on a 5-group CUBE).
    await say('netstat');
    const bootOut = after('netstat');
    const bootFamilies = [...bootOut.matchAll(/^\\s+(\\S+)\\s+(\\d+)\\s+\\d+ ms$/gm)].map((m) => [m[1], Number(m[2])]);
    // The boot keeps warming behind the prompt (groups, users, the index)
    // and the ledger counts those too, as it should; a navigation's cost
    // is read on a quiet wire, so wait for one.
    let quiet = false;
    for (let i = 0; i < 20 && !quiet; i++) { await say('netstat -r'); await sleep(3000); await say('netstat'); quiet = /REQUESTS 0 since/.test(after('netstat')); }
    if (!quiet) return { error: 'the wire never went quiet' };
    // A revisit is the deterministic cost: the first visit may list a
    // parent the cache never held (the root, for /bin) or revalidate a
    // listing a signal marked stale, both honest and both once.
    await say('cd ~/feeds'); await say('cd /bin'); await say('cd ~');
    await say('netstat -r');
    await say('cd ~/feeds');
    await say('netstat');
    const out = after('netstat');
    const total = Number(/REQUESTS (\\d+) since/.exec(out)?.[1] ?? NaN);
    const families = [...out.matchAll(/^\\s+(\\S+)\\s+(\\d+)\\s+\\d+ ms$/gm)].map((m) => [m[1], Number(m[2])]);
    const last = (out.match(/^\\s+\\d+ ms\\s+\\d{3}\\s+GET /gm) ?? []).length;
    // /bin: the boot warmed it; cd must read that, not fetch it again.
    await say('netstat -r');
    await say('cd /bin');
    await say('netstat');
    const binOut = after('netstat');
    const binTotal = Number(/REQUESTS (\\d+) since/.exec(binOut)?.[1] ?? NaN);
    const binFamilies = [...binOut.matchAll(/^\\s+(\\S+)\\s+(\\d+)\\s+\\d+ ms$/gm)].map((m) => [m[1], Number(m[2])]);
    await say('cd ~');
    // The ledger itself, shown by a listing forced fresh: that always asks.
    await say('netstat -r');
    await say('ls --refresh ~');
    await say('netstat');
    const forced = after('netstat');
    const forcedTotal = Number(/REQUESTS (\\d+) since/.exec(forced)?.[1] ?? NaN);
    const forcedFamilies = [...forced.matchAll(/^\\s+(\\S+)\\s+(\\d+)\\s+\\d+ ms$/gm)].map((m) => [m[1], Number(m[2])]);
    const forcedLast = (forced.match(/^\\s+\\d+ ms\\s+\\d{3}\\s+GET /gm) ?? []).length;
    // A pipeline diagram — the browser asks one per card in PREVIEW, by the
    // /bin slug. Resolved once per session and its pipings read off the item
    // the resolution served: at most three requests the first time (the id,
    // the pipings, the defaults), none the second.
    await say('ls /bin');
    const slug = /\\b([A-Za-z0-9][\\w.-]*_id\\d+)\\b/.exec(after('ls /bin'))?.[1] ?? null;
    let diagram = null;
    if (slug !== null) {
      await say('netstat -r');
      await say('pipeline diagram ' + slug);
      await say('netstat');
      const firstOut = after('netstat');
      await say('netstat -r');
      await say('pipeline diagram ' + slug);
      await say('netstat');
      const againOut = after('netstat');
      diagram = { slug,
        first: Number(/REQUESTS (\\d+) since/.exec(firstOut)?.[1] ?? NaN),
        firstFamilies: [...firstOut.matchAll(/^\\s+(\\S+)\\s+(\\d+)\\s+\\d+ ms$/gm)].map((m) => [m[1], Number(m[2])]),
        again: Number(/REQUESTS (\\d+) since/.exec(againOut)?.[1] ?? NaN) };
    }
    return { total, families, last, binTotal, binFamilies, forcedTotal, forcedFamilies, forcedLast, diagram, bootFamilies };`);
  check('netstat counts a listing forced fresh by family and lists its requests timed',
    net.error === undefined && Number.isFinite(net.forcedTotal) && net.forcedTotal >= 3 && net.forcedFamilies.length >= 3 && net.forcedLast >= 3,
    JSON.stringify(net));
  // The budget: a home listing is at most the searches and the three
  // collections it needs; the number here is today's measured cost and
  // comes DOWN with the slices that follow (the epic: a navigation costs
  // what it must).
  // Budgets are held by FAMILY: a warm behind the prompt (users, publicfeeds,
  // the pipeline index) may land in the window and is not the navigation's.
  const asked = (families, re) => families.filter(([f]) => re.test(f)).reduce((n, [, c]) => n + c, 0);
  // What a session may read of users, or groups, by id before this stage:
  // the login's own identity, and an `id`/`whoami` an earlier scenario may
  // have asked. The group warm reads neither that way.
  const BOOT_USER_READS = 2;
  check('a revisited CUBE directory fetches none of its collections: the listing cache serves',
    net.error === undefined && asked(net.families, /^filebrowser\/:id\//) === 0,
    JSON.stringify(net.families));
  check('a revisited /bin fetches no plugins, pipelines or sources: the listing the boot warmed serves',
    net.error === undefined && asked(net.binFamilies, /^(plugins|pipelines|pipelines\/sourcefiles)$/) === 0,
    JSON.stringify(net.binFamilies));
  check('the boot asks CUBE for no user one by one: a group\'s members are read off its membership pages',
    net.error === undefined && asked(net.bootFamilies, /^users\/:id$/) <= BOOT_USER_READS,
    JSON.stringify(net.bootFamilies));
  check('the boot lists no group by id: a group is read off the one groups listing',
    net.error === undefined && asked(net.bootFamilies, /^groups\/search$/) <= BOOT_USER_READS,
    JSON.stringify(net.bootFamilies));
  check('a pipeline diagram costs at most its id, pipings and defaults once, and nothing again',
    net.error === undefined && (net.diagram === null || (net.diagram.first <= 3 && net.diagram.again === 0
      && net.diagram.firstFamilies.every(([f, n]) => /^pipelines\/(search|:id\/(pipings|parameters))$/.test(f) && n <= 1))),
    JSON.stringify(net.diagram));
  }
  if (await stage('press-ack')) {
  // A press is acknowledged before anything answers: the row lights, the
  // rest dims, its capsule works, the bar reads OPENING <name>; the
  // listing that lands stands it down.
  const ack = await evalIn(`
    const input = console_input();
    const say = async (line) => { await console_idle(); input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(80); await console_settled(); await console_idle(); };
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    await say('cd ~');
    if (!fp()) { document.getElementById('gutter-files').click(); for (let i = 0; i < 40; i++) { await sleep(250); if (fp()) break; } }
    if (!fp()) return { error: 'no files pane' };
    const pane = fp(); const state = pane.querySelector('.pane-state');
    const rowOf = (word) => [...pane.querySelectorAll('.listing-row')].find((r) => r.textContent.includes(word) && !r.textContent.includes('..'));
    for (let i = 0; i < 40; i++) { await sleep(250); if (rowOf('feeds')) break; }
    const row = rowOf('feeds'); if (!row) { await home_return(); return { error: 'no feeds row' }; }
    // The path the header shows, without the LINK line that rides beside it.
    const pathOf = () => { const header = pane.querySelector('.files-path'); if (!header) return '';
      const copy = header.cloneNode(true); copy.querySelectorAll('.link-line').forEach((e) => e.remove()); return copy.textContent.trim(); };
    const before = pathOf();
    (row.querySelector('.listing-control') ?? row).click();
    // the instant after the press, before the kernel can have answered
    const atOnce = { lit: row.classList.contains('listing-activating'), others: [...pane.querySelectorAll('.listing-row')].filter((r) => r !== row).map((r) => getComputedStyle(r).opacity), bar: state?.textContent ?? '', wait: state?.classList.contains('state-wait') ?? false };
    // the same row pressed again while in flight is absorbed
    (row.querySelector('.listing-control') ?? row).click();
    let landed = null; for (let i = 0; i < 200; i++) { await sleep(50); if (pathOf() !== before) { landed = pathOf(); break; } }
    await sleep(300);
    const after = { landed, lit: pane.querySelector('.listing-activating') !== null, bar: state?.textContent ?? '', wait: state?.classList.contains('state-wait') ?? false };
    await home_return();
    return { atOnce, after };`);
  check('the instant a row is pressed it lights, the rest dims, and the bar reads OPENING <name>',
    ack.error === undefined && ack.atOnce.lit && ack.atOnce.others.length > 0 && ack.atOnce.others.every((o) => Number(o) < 0.5) && /^OPENING feeds$/.test(ack.atOnce.bar) && ack.atOnce.wait,
    JSON.stringify(ack.error ?? ack.atOnce));
  check('the listing that lands stands the press down, and a second press on the same row was absorbed',
    ack.error === undefined && ack.after.landed === '~/feeds' && !ack.after.lit && !ack.after.wait && !/OPENING/.test(ack.after.bar),
    JSON.stringify(ack.error ?? ack.after));
  }
  if (await stage('favicon')) {
  // The tab wears the mark: the page links an SVG icon and a PNG, relative
  // to where it is mounted, and both are served.
  const icon = await evalIn(`
    const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => l.getAttribute('href'));
    const fetched = {};
    for (const href of new Set(links)) { const r = await fetch(new URL(href, document.baseURI)); fetched[href] = r.status + ' ' + (r.headers.get('content-type') ?? ''); }
    return { links, fetched };`);
  check('the page links its SVG and PNG icons, relative, and both are served',
    icon.links.includes('favicon.svg') && icon.links.includes('favicon.png') && /^200 image\/svg\+xml/.test(icon.fetched['favicon.svg'] ?? '') && /^200 image\/png/.test(icon.fetched['favicon.png'] ?? ''),
    JSON.stringify(icon));
  }
  if (await stage('gather-process')) {
  // PROCESS on the cohort: its feed first (made by the pull the operator
  // could have typed, named at the ask), then a catalogue bound to the
  // feed's root; the cohort row lights FEED N. A real feed on the user's
  // CUBE, removed at the end.
  if (!process.env.SMOKE_PACS_QUERY) {
    console.log('  skipped: set SMOKE_PACS_QUERY=<a `pacs query ...` line that finds a study with a series in CUBE>');
  } else {
    const cohort = await evalIn(`
      await console_idle();
      await cohort_empty();
      document.getElementById('gutter-tools').click(); await sleep(500);
      const ws = document.getElementById('pacs-workspace');
      const term = console_input();
      const say = async (line, ms) => { term.value = line;
        term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(ms); await console_settled(); };
      const cmd = document.getElementById('pacs-command');
      const studies = () => document.querySelectorAll('#pacs-results .pacs-study').length;
      cmd.value = ${JSON.stringify(process.env.SMOKE_PACS_QUERY)};
      cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 60; i++) { await sleep(100); if (document.querySelector('#pacs-results .pacs-waiting')) break; }
      for (let i = 0; i < 240; i++) { await sleep(1000); if (studies() > 0) break; }
      await sleep(2500);
      const study = document.querySelector('#pacs-results .pacs-study');
      if (!study) return { error: 'no study' };
      if (!study.classList.contains('listing-open')) { study.querySelector('.pacs-study-row .listing-control').click(); await sleep(400); }
      const zoneVerbs = (root, zone) => [...root.querySelectorAll(zone + ' .listing-action')].map(b => b.textContent.trim());
      let picked = null;
      for (const row of [...study.querySelectorAll('.pacs-series')]) { row.click(); await sleep(300); if (zoneVerbs(ws, '.pacs-row-zone').includes('GATHER')) { picked = row; break; } }
      if (!picked) return { error: 'no series in CUBE to gather' };
      [...ws.querySelectorAll('.pacs-row-zone .listing-action')].find(b => b.textContent.trim() === 'GATHER').click();
      // The gather lands in the band; ON STAGE gives the cohort its pane,
      // where this scenario's checks are read.
      const band = document.getElementById('header-gather');
      for (let i = 0; i < 80 && !band.querySelector('.gather-series'); i++) await sleep(250);
      band.querySelector('.gather-stage')?.click();
      const pane = () => [...document.querySelectorAll('.pane-gather')].find(p => p.offsetParent !== null);
      for (let i = 0; i < 40; i++) { await sleep(250); if (pane()) break; }
      await sleep(600);
      const gp = pane();
      if (!gp) { await home_return(); return { error: 'no gather pane' }; }
      gp.querySelector('.gather-cohort-row .gather-cohort-name').click(); await sleep(400);
      const cohortVerbs = zoneVerbs(gp, '.gather-row-zone');
      const echoesBefore = console_echoes().length;
      const askBefore = [...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null;
      [...gp.querySelectorAll('.gather-row-zone .listing-action')].find(b => b.textContent.trim() === 'PROCESS')?.click();
      let asked = false;
      for (let i = 0; i < 20; i++) { await sleep(500); if (([...document.querySelectorAll('#terminal .argus-ask')].pop() ?? null) !== askBefore) { asked = true; break; } }
      const askText = [...document.querySelectorAll('#terminal .argus-ask')].pop()?.textContent.trim() ?? '';
      term.value = 'smoke cohort';
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // The name, then the feed: the kernel's verbs, as the operator could type them.
      for (let i = 0; i < 60; i++) { await sleep(500); if (console_echoes().slice(echoesBefore).some((l) => /gather feed/.test(l))) break; }
      const echoed = console_echoes().slice(echoesBefore).map((l) => l.trim()).join(' | ');
      let capsule = null;
      for (let i = 0; i < 240; i++) { await sleep(500); const c = gp.querySelector('.gather-feed'); if (c) { capsule = c.textContent.trim(); break; } }
      const feedId = parseInt((capsule ?? '').replace(/\\D/g, ''), 10);
      const catalogue = () => [...document.querySelectorAll('.pane-files')].find(p => p.offsetParent !== null && p.querySelector('.files-binding'));
      for (let i = 0; i < 40; i++) { await sleep(500); if (catalogue()) break; }
      const binding = catalogue()?.querySelector('.files-binding')?.textContent ?? '';
      const title = gp.querySelector('.gather-title')?.textContent.trim();
      gp.querySelector('.gather-cohort-row .gather-cohort-name').click(); await sleep(400);
      const verbsAfter = zoneVerbs(gp, '.gather-row-zone');
      if (Number.isFinite(feedId)) await say('feed rm -f ' + feedId, 5000);
      [...gp.querySelectorAll('.gather-row-zone .listing-action')].find(b => b.textContent.trim() === 'DISMISS')?.click(); await sleep(500);
      await home_return();
      return { cohortVerbs, asked, askText, echoed, capsule, feedId, binding, title, verbsAfter };`);
    check('the cohort row offers PROCESS beside CREATE FEED', cohort.error === undefined && cohort.cohortVerbs.join(',') === 'SAVE,EXPORT CSV,CREATE FEED,PROCESS,DISMISS', JSON.stringify(cohort.cohortVerbs ?? cohort));
    check('PROCESS asks the cohort\'s name once and makes its feed by the pull the operator could have typed',
      cohort.error === undefined && cohort.asked && /Cohort name/.test(cohort.askText) && /❯ gather name 'smoke cohort' \| ❯ gather feed/.test(cohort.echoed) && Number.isFinite(cohort.feedId),
      JSON.stringify({ asked: cohort.asked, askText: cohort.askText, echoed: cohort.echoed, capsule: cohort.capsule }));
    check('the cohort row lights FEED N, the pane wears the name, and CREATE FEED is spent',
      cohort.error === undefined && /^FEED \d+$/.test(cohort.capsule ?? '') && cohort.title === 'GATHER · SMOKE COHORT' && cohort.verbsAfter.join(',') === 'SAVE,EXPORT CSV,PROCESS,DISMISS',
      JSON.stringify({ capsule: cohort.capsule, title: cohort.title, verbsAfter: cohort.verbsAfter }));
    check("a catalogue opens bound to the feed's root, so a run appends to the cohort",
      cohort.error === undefined && new RegExp('^INPUT /home/[^ ]+/feeds/feed_' + cohort.feedId + '/pl-dircopy_\\d+/data → feed ' + cohort.feedId + ' · node \\d+$').test(cohort.binding),
      cohort.binding);
  }
  }
  if (await stage('pacs-server-control')) {
    // SERVER is a choice, not a phrase: the cell reads its own state and
    // unfolds a strip of segments — the FILTER gesture, in the caps'
    // vocabulary. No dropdown, because LCARS has no popup layer, and no
    // ALL, because a fan-out is always something the operator named.
    const servers = await evalIn(`
      document.getElementById('gutter-tools').click(); await sleep(700);
      const ws = document.getElementById('pacs-workspace');
      const cell = ws.querySelector('#pacs-f-server');
      const strip = ws.querySelector('#pacs-server-strip');
      const restingHidden = strip.hidden;
      cell.click();
      for (let i = 0; i < 120; i++) { await sleep(250);
        if (strip.querySelectorAll('.pacs-server-segment').length > 0) break; }
      const segments = [...strip.querySelectorAll('.pacs-server-segment')].map(s => s.textContent.trim());
      const noAll = !segments.some(s => /^ALL$/i.test(s));
      // One chosen is a context; several is a query, and only the fan-out
      // reaches the line.
      const first = strip.querySelector('.pacs-server-segment');
      first.click(); await sleep(300);
      const oneCell = cell.textContent.trim();
      const oneLine = ws.querySelector('#pacs-command').value;
      const second = [...strip.querySelectorAll('.pacs-server-segment')][1];
      let manyCell = '', manyLine = '', lit = 0;
      if (second) {
        second.click(); await sleep(300);
        manyCell = cell.textContent.trim();
        manyLine = ws.querySelector('#pacs-command').value;
        lit = strip.querySelectorAll('.pacs-server-chosen').length;
      }
      // Esc retracts it, exactly as it retracts a mode frame.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      const closedByEsc = strip.hidden;
      return { restingHidden, segments: segments.length, noAll,
        oneCell, oneLine, manyCell, manyLine, lit, closedByEsc };`);
    check('the SERVER cell unfolds a strip carrying every registered server',
      servers.restingHidden === true && servers.segments > 0,
      JSON.stringify(servers));
    check('the strip offers no ALL: a fan-out is always something the operator named',
      servers.noAll === true, JSON.stringify(servers.segments));
    check('one server reads as itself and adds no flag; several reads +n and lowers to a fan-out',
      servers.oneCell !== '' && !servers.oneLine.includes('--pacsserver')
      && /\+1$/.test(servers.manyCell) && servers.manyLine.includes('--pacsserver')
      && servers.lit === 2,
      JSON.stringify(servers));
    check('Esc retracts the server strip, as it retracts a mode frame',
      servers.closedByEsc === true, JSON.stringify(servers.closedByEsc));
  }

  if (await stage('terminal-asks')) {
  // The terminal's questions are chell's own (#1125): a command typed in it
  // asks in line, the answer is typed there, Ctrl-C abandons the question as
  // Esc does in the transcript, and a question answered on a pane is written
  // into the scrollback with its answer.
  const asks = await evalIn(`
    await console_idle();
    const type = (keys) => window.__argusConsole.type(keys);
    const asked = async () => { for (let i = 0; i < 80 && !console_asking(); i++) await sleep(250); return console_asking(); };
    const rested = async () => { for (let i = 0; i < 120 && !console_quiet(); i++) await sleep(250); return console_quiet(); };
    await console_run('rm -r ~/smoke-tasks'); await console_run('mkdir -p ~/smoke-tasks');
    await console_run('touch --withContents "kept" ~/smoke-tasks/a.txt');
    const kept = async () => { const m = console_mark(); await console_run('ls ~/smoke-tasks'); return /a\\.txt/.test(console_since(m)); };

    // Asked in line, answered there: no removes nothing.
    type('rm -i ~/smoke-tasks/a.txt\\r');
    const inLine = await asked();
    const question = console_lastAsk();
    type('n\\r');
    const answeredRest = await rested();
    const keptAfterNo = await kept();

    // Ctrl-C abandons the question, and the command that asked it.
    type('rm -i ~/smoke-tasks/a.txt\\r');
    const askedAgain = await asked();
    const before = console_mark();
    type('\\u0003');
    const abandonedRest = await rested();
    const said = console_since(before);
    const keptAfterAbandon = await kept();

    // A question pressed on a pane stands on the pane; its answer lands in the scrollback.
    await console_run('cd ~/smoke-tasks');
    document.getElementById('gutter-files').click(); await sleep(800);
    const fp = () => [...document.querySelectorAll('.pane-files')].find((p) => p.offsetParent !== null);
    for (let i = 0; i < 60 && !(window.__argusPromptContext?.cwd ?? '').endsWith('/smoke-tasks'); i++) await sleep(250);
    let row = null;
    for (let i = 0; i < 60 && row === null; i++) { row = [...(fp()?.querySelectorAll('.files-row') ?? [])].find((r) => r.querySelector('.files-name')?.textContent.trim() === 'a.txt') ?? null; if (row === null) await sleep(250); }
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(700);
    const mirrorMark = console_mark();
    [...(fp()?.querySelectorAll('.files-row-zone .listing-action') ?? [])].find((b) => b.textContent.trim() === 'DELETE')?.click();
    let bar = null;
    for (let i = 0; i < 60 && bar === null; i++) { bar = fp()?.querySelector('.ask-bar') ?? null; if (bar === null) await sleep(250); }
    const onPane = bar !== null;
    const no = [...(bar?.querySelectorAll('button') ?? [])].find((b) => /^no$/i.test(b.textContent.trim()));
    no?.click();
    let mirrored = '';
    for (let i = 0; i < 60 && mirrored === ''; i++) { mirrored = console_since(mirrorMark).split('\\n').find((l) => /^\\? .*\\s(n|no)$/i.test(l.trim())) ?? ''; if (mirrored === '') await sleep(250); }
    const keptAfterPane = await kept();
    await console_run('cd ~'); await console_run('rm -r ~/smoke-tasks');
    return { inLine, question, answeredRest, keptAfterNo, askedAgain, abandonedRest, said: said.slice(-300), keptAfterAbandon, onPane, mirrored, keptAfterPane };`);
  check('a command typed in the terminal asks in line, and no removes nothing',
    asks.inLine && /a\.txt/.test(asks.question) && asks.answeredRest && asks.keptAfterNo, JSON.stringify(asks));
  check('Ctrl-C abandons a question in the terminal, and the command that asked it',
    asks.askedAgain && asks.abandonedRest && asks.keptAfterAbandon, JSON.stringify({ said: asks.said }));
  check('a question pressed on a pane stands on the pane, and its answer is written into the terminal\'s scrollback',
    asks.onPane && asks.mirrored !== '' && asks.keptAfterPane, JSON.stringify({ onPane: asks.onPane, mirrored: asks.mirrored }));
  }

  if (await stage('find')) {
  // find is POSIX's: an expression over the namespace, an entry before what
  // lies under it, an unknown predicate refused by name. Over /proc/jobs it
  // answers from the job index, so asking which runs a plugin made, or a
  // pipeline, asks CUBE nothing once the index knows.
  const found = await evalIn(`
    await console_idle();
    const ask = async (line) => { const m = console_mark(); await console_run(line, 60000); return console_since(m); };
    const paths = (out) => out.split('\\n').map((l) => l.trim()).filter((l) => /^\\/\\S*$/.test(l));
    await console_run('rm -r ~/smoke-find'); await console_run('mkdir -p ~/smoke-find/a/b');
    await console_run('touch ~/smoke-find/a/x.nii'); await console_run('touch ~/smoke-find/a/b/y.nii'); await console_run('touch ~/smoke-find/notes.txt');
    const rel = (out) => paths(out).map((p) => p.slice(p.indexOf('/smoke-find'))).filter((p) => p.startsWith('/smoke-find'));
    const all = rel(await ask('find ~/smoke-find'));
    const nii = rel(await ask("find ~/smoke-find -name '*.nii'"));
    const dirs = rel(await ask('find ~/smoke-find -type d'));
    const shallow = rel(await ask('find ~/smoke-find -maxdepth 1'));
    const either = rel(await ask("find ~/smoke-find -type f ( -name 'n*' -o -path '*/b/*' )"));
    const refused = await ask('find ~/smoke-find -bogus');

    // /proc/jobs: the index judges every job's run (a backfill behind the
    // prompt, once); a pattern nothing matches prints only what find could
    // not judge. A direct run and a pipeline's runs together are every job.
    let unjudged = '';
    for (let i = 0; i < 40; i++) { unjudged = (await ask("find /proc/jobs -pipeline 'no pipeline is named this'")).split('\\n').find((l) => /not judged/.test(l)) ?? ''; if (unjudged === '') break; await sleep(3000); }
    // Counted by the kernel's wc: a filter at the end of a pipe runs in the
    // session on every surface, a browser's terminal among them.
    const count = (out) => Number(out.split('\\n').map((l) => l.trim()).filter((l) => /^\\d+$/.test(l)).pop() ?? NaN);
    const niiCount = count(await ask("find ~/smoke-find -name '*.nii' | wc -l"));
    await console_run('rm -r ~/smoke-find');
    await console_run('netstat -r');
    const jobs = count(await ask("find /proc/jobs -plugin '*' | wc -l"));
    const direct = count(await ask("find /proc/jobs -pipeline '' | wc -l"));
    const piped = count(await ask("find /proc/jobs -plugin '*' ! -pipeline '' | wc -l"));
    const wire = await ask('netstat');
    const asked = Number(/REQUESTS (\\d+) since/.exec(wire)?.[1] ?? NaN);
    const families = [...wire.matchAll(/^\\s*(\\S+)\\s+(\\d+)\\s+\\d+ ms$/gm)].map((m) => m[1] + ' ' + m[2]);
    return { all, nii, dirs, shallow, either, refused: refused.slice(-200), unjudged, jobs, direct, piped, asked, families, niiCount };`);
  check('find prints everything beneath a path, an entry before what lies under it',
    JSON.stringify(found.all) === JSON.stringify(['/smoke-find', '/smoke-find/a', '/smoke-find/a/b', '/smoke-find/a/b/y.nii', '/smoke-find/a/x.nii', '/smoke-find/notes.txt']),
    JSON.stringify(found.all));
  check('find selects by -name, -type and -maxdepth, and joins tests with ( -o )',
    JSON.stringify(found.nii) === JSON.stringify(['/smoke-find/a/b/y.nii', '/smoke-find/a/x.nii'])
    && JSON.stringify(found.dirs) === JSON.stringify(['/smoke-find', '/smoke-find/a', '/smoke-find/a/b'])
    && JSON.stringify(found.shallow) === JSON.stringify(['/smoke-find', '/smoke-find/a', '/smoke-find/notes.txt'])
    && JSON.stringify(found.either) === JSON.stringify(['/smoke-find/a/b/y.nii', '/smoke-find/notes.txt']),
    JSON.stringify({ nii: found.nii, dirs: found.dirs, shallow: found.shallow, either: found.either }));
  check('a pipe ends in the kernel\'s wc on every surface: find … | wc -l counts what find printed',
    found.niiCount === 2, JSON.stringify(found.niiCount));
  check('find refuses a predicate it does not know, by name',
    /unknown predicate '-bogus'/.test(found.refused), JSON.stringify(found.refused));
  // The backfill reads every job's pipeline run once, behind the prompt; on
  // an account of a few hundred thousand jobs that is hours of CUBE pages,
  // and while it reads, its own asks are the instance reads the second check
  // forbids. Until the index has read them, neither claim can be judged.
  if (found.unjudged !== '') {
    console.log(`  not judged: the index is still reading which pipeline run made each job (${/\d+/.exec(found.unjudged)?.[0] ?? 'some'} left); the two /proc/jobs checks wait for it`);
  } else {
    check('find judges every job\'s pipeline run once the index has read it',
      found.unjudged === '', JSON.stringify(found.unjudged));
    // The wire counts the whole session: the roster's delta and a pane's own
    // reads may land meanwhile. What find would ask is jobs and folders.
    check('over /proc/jobs, a direct run and a pipeline\'s runs together are every job, and find asks CUBE for no job or folder',
      found.jobs > 0 && found.direct + found.piped === found.jobs
      && !found.families.some((f) => /instances|filebrowser|^feeds/.test(f)),
      JSON.stringify({ jobs: found.jobs, direct: found.direct, piped: found.piped, asked: found.asked, families: found.families }));
  }
  }

  if (await stage('console-asks')) {
    // The session can ask this surface a question now. A `text` or a
    // `secret` is answered in the console — where the session speaks, and
    // where the scrollback keeps what was asked — and a secret never enters
    // the transcript, not even as a length. A `path` borrows an instrument
    // instead, which is the ask-errand scenario.
    const asks = await evalIn(`
      const term = () => console_input();
      const lines = () => [...document.querySelectorAll('#terminal .argus-ask')];
      const run = (line) => { const t = term(); t.value = line;
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
      const key = (k) => term().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

      // The scrollback keeps every question ever asked, answered ones
      // included, so everything here is counted from where this scenario
      // started: the asks it causes are the ones after that mark, and the
      // capsules it presses are the newest — pressing the first NO on the
      // page presses one an earlier scenario already answered.
      await console_idle();
      const askedBefore = lines().length;
      const capsulesBefore = document.querySelectorAll('#terminal .ask-capsule').length;

      // sudo asks for an administrator username, then a password. Answering
      // the first and abandoning the second establishes nothing.
      run('sudo plugin add pl-no-such-plugin-for-smoke');
      for (let i = 0; i < 120; i++) { await sleep(500); if (lines().length > askedBefore) break; }
      if (lines().length <= askedBefore) return { asked: false };
      const first = lines()[askedBefore].textContent ?? '';
      const typeAtText = term().type;
      term().value = 'not-a-real-admin'; key('Enter');
      for (let i = 0; i < 120; i++) { await sleep(300); if (lines().length > askedBefore + 1) break; }
      const typeAtSecret = term().type;
      term().value = 'smoke-secret-value';
      key('Escape'); await sleep(1200);
      const abandoned = (lines()[askedBefore + 1]?.textContent ?? '').includes('abandoned');
      const leaked = (document.getElementById('terminal').textContent + console_text()).includes('smoke-secret-value');
      const glyph = document.querySelector('.argus-input-glyph').textContent;

      // A yes/no is two capsules, and pressing one answers it.
      await console_idle();
      run('rm -i /home/__no_such_file_for_smoke__');
      let capsules = 0;
      for (let i = 0; i < 120; i++) { await sleep(250);
        capsules = document.querySelectorAll('#terminal .ask-capsule').length - capsulesBefore;
        if (capsules > 0) break; }
      if (capsules > 0) {
        [...document.querySelectorAll('#terminal .ask-capsule')].filter(c => c.textContent === 'NO').pop().click();
        await sleep(800);
      }
      return { asked: true, first, typeAtText, typeAtSecret, abandoned, leaked, glyph, capsules,
        settled: document.querySelector('.argus-input-glyph').textContent === '❯' };`);
    if (asks.asked === false) {
      console.log('  skipped: no question arrived (sudo did not reach its prompt)');
    } else {
      check('the session can put a question to this surface, in the console',
        /administrator/i.test(asks.first ?? ''), JSON.stringify(asks.first));
      check('a secret is masked, and never enters the transcript',
        asks.typeAtText === 'text' && asks.typeAtSecret === 'password' && asks.leaked === false,
        JSON.stringify({ text: asks.typeAtText, secret: asks.typeAtSecret, leaked: asks.leaked }));
      check('Esc abandons a question, and the transcript says so',
        asks.abandoned === true && asks.glyph === '❯', JSON.stringify(asks.abandoned));
      if (asks.capsules === 0) {
        console.log('  skipped: no yes/no arrived (nothing asked one)');
      } else {
        check('a yes/no is two capsules, and pressing one answers it',
          asks.capsules === 2 && asks.settled === true,
          JSON.stringify({ capsules: asks.capsules, settled: asks.settled }));
      }
    }
  }

  if (await stage('ask-errand')) {
    // An ask is never a box: a location borrows the instrument that already
    // shows that space. A NEW browser opens beside the asker, anchored
    // where the ask said, with the errand's controls on its own frame.
    //
    // Without an MRN that has imaging the query never reaches its write, so
    // there is nothing to ask and nothing to test — and a fan-out to a real
    // PACS for a nonsense MRN sits in the session queue for minutes, where
    // every later scenario's command waits behind it. So it is not issued.
    const errand = !process.env.SMOKE_PACS_MRN ? { opened: false, unset: true } : await evalIn(`
      const term = () => console_input();
      const run = (line) => { const t = term(); t.value = line;
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
      const panes = () => document.querySelectorAll('#layout-root .layout-leaf').length;
      const before = panes();
      // A query that replays: the errand is what this scenario is about,
      // not how long a PACS takes to answer a question it has answered
      // before. SMOKE_PACS_MRN names an MRN with imaging.
      run(${JSON.stringify(`pacs query PatientID:${process.env.SMOKE_PACS_MRN ?? '__smoke__'} --csv-to`)});
      let opened = false;
      for (let i = 0; i < 240; i++) { await sleep(500);
        if (document.querySelector('.errand-commit')) { opened = true; break; } }
      if (!opened) return { opened: false };
      const caption = document.querySelector('.errand-caption')?.textContent ?? '';
      const commit = document.querySelector('.errand-commit')?.textContent ?? '';
      const composed = document.querySelector('.errand-path')?.value ?? '';
      const grew = panes() > before;
      // The errand's controls ride a bar of their own across the top of the
      // pane it borrowed, not the mode frame — which is a narrow rail
      // against the spine, and answers to what the field holds.
      const barred = document.querySelector('.errand-bar')?.parentElement?.classList.contains('files-body') === true;
      // Polled, never slept: the listing lands when the daemon answers, and
      // a fixed wait either samples before it or wastes the difference.
      const listing = () => document.querySelector('.errand-bar')?.closest('.files-body')
        ?.querySelectorAll('.files-row').length ?? 0;
      let rows = 0;
      for (let i = 0; i < 80; i++) { await sleep(250); rows = listing(); if (rows > 0) break; }
      // The console states the question too, so the scrollback holds it.
      const noted = [...document.querySelectorAll('#terminal .argus-ask')]
        .some(el => /where should the table go/i.test(el.textContent ?? ''));
      // Esc abandons: the pane closes, the layout comes back, and the
      // command is told rather than left waiting.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(1500);
      const closed = document.querySelector('.errand-commit') === null && panes() === before;
      const said = [...document.querySelectorAll('#terminal .argus-ask')]
        .some(el => (el.textContent ?? '').includes('abandoned'));
      return { opened: true, caption, commit, composed, grew, barred, rows, noted, closed, said };`);
    if (errand.opened === false) {
      console.log(errand.unset
        ? '  skipped: set SMOKE_PACS_MRN=<an MRN with imaging> for the location ask'
        : '  skipped: no location was asked for (the query never reached its write)');
    } else {
      check('a location ask opens a browser beside the asker, carrying the errand on its own bar',
        errand.grew === true && errand.barred === true && /where should the table go/i.test(errand.caption),
        JSON.stringify({ grew: errand.grew, barred: errand.barred, caption: errand.caption }));
      // A question that blocks the command that asked it must not block the
      // browsing that answers it: the errand's listings are instrument
      // reads, and they run beside the waiting command rather than behind
      // it. An empty errand is a deadlock wearing a pane.
      check('the errand browses while the command that asked waits',
        errand.rows > 0, JSON.stringify({ rows: errand.rows }));
      check('the committing verb reads what the kernel said it does',
        errand.commit === 'EXPORT HERE', JSON.stringify(errand.commit));
      check('the answer is composed from where the browser stands, and is editable',
        /\.csv$/.test(errand.composed ?? ''), JSON.stringify(errand.composed));
      check('the console states the question the errand answers',
        errand.noted === true, JSON.stringify(errand.noted));
      check('Esc abandons the errand: the pane closes and the command is told',
        errand.closed === true && errand.said === true, JSON.stringify(errand));
    }
  }

  if (await stage('host-control')) {
  // The HOST lamp reads the attach ack's declared tiers and nothing else:
  // present exactly when the daemon declared host control, absent at rest.
  // And `!` on a daemon without the policy refuses by name.
  const hostControl = await evalIn(`
    const lamp = document.getElementById('status-host');
    const lit = lamp.textContent.trim();
    const input = console_input();
    // Output lands above the prompt line, so read the whole transcript for
    // a token no other scenario prints.
    const token = 'argus-host-probe-' + Date.now();
    await console_idle();
    input.value = '!echo ' + token; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // The answer is a token no other scenario prints, or a refusal by name;
    // polled, since a fixed wait either samples before it or wastes the rest.
    // What the line printed, not the line itself (which carries the token too).
    const streams = () => console_text().split('\\n').filter((line) => !line.includes('!echo')).join('\\n');
    const errors = () => console_text();
    let ran = false, refusedByName = false;
    for (let i = 0; i < 60; i++) { await sleep(250);
      ran = streams().includes(token); refusedByName = errors().includes('--host-control');
      if (ran || refusedByName) break; }
    return { lit, ran, refusedByName };`);
  if (hostControl.lit !== '') {
    check('the HOST lamp reads the daemon\'s declared tiers, and ! runs on the host', /^HOST /.test(hostControl.lit) && hostControl.ran, JSON.stringify(hostControl));
  } else {
    check('the HOST lamp reads the daemon\'s declared tiers: absent at rest, and ! refuses by name', hostControl.lit === '' && hostControl.refusedByName && !hostControl.ran, JSON.stringify(hostControl));
  }
  }

  if (await stage('roster-totals')) {
  // The roster's totals ride the same grid as its other columns: caps for
  // SIZE and TIME, one cell per cap on every row, a dash (never a zero)
  // where a feed's nodes are not resident, a number where they are.
  //
  // Counted against the caps rather than a literal: the track list is
  // positional, so "as many cells as caps" is the invariant that protects
  // the grid, and it needs no edit when a column is added.
  const totals = await evalIn(`
    document.getElementById('gutter-runs').click(); await sleep(800);
    for (let i = 0; i < 60; i++) { await sleep(500); if (document.querySelector('.feedlist-row')) break; }
    const dp = [...document.querySelectorAll('.pane-dag')].find(p => p.offsetParent !== null);
    const caps = [...dp.querySelectorAll('.roster-cap')].map(c => c.textContent.replace(/[▲▼\\s]/g, ''));
    const rows = [...dp.querySelectorAll('.feedlist-row')];
    const cells = rows.map(r => r.children.length);
    // The invariant that protects the grid is that every row holds as many
    // cells as the grid has TRACKS — the caps head only the sortable columns,
    // and the action track is a real track with no cap of its own.
    const tracks = rows.length > 0 ? getComputedStyle(rows[0]).gridTemplateColumns.split(' ').length : 0;
    const sizes = rows.map(r => r.querySelector('.feedlist-size')?.textContent ?? '');
    return { caps, tracks, cellsUniform: rows.length > 0 && tracks >= caps.length && cells.every(n => n === tracks), rows: rows.length, honest: sizes.every(s => s === '—' || /\\d/.test(s)) };`);
  check('the roster carries SIZE and TIME on its grid, dashes where nodes are not resident', totals.caps.includes('SIZE') && totals.caps.includes('TIME') && totals.cellsUniform && totals.rows > 0 && totals.honest, JSON.stringify(totals));
  }

  if (await stage('theme-cycle')) {
  // A theme is one declaration on the root element, and the pill cycles it.
  // PHAROS is the theme with shapes of its own: reached by the pill, it must
  // be readable back off the caps — a chamfered cap in the language's face —
  // and leaving it must restore what the browser had.
  const themed = await evalIn(`
    const pill = document.getElementById('theme-pill');
    const root = document.documentElement;
    const before = root.dataset.theme ?? null;
    const capOf = () => document.querySelector('.roster-cap');
    document.getElementById('gutter-files').click(); await sleep(600);
    for (let i = 0; i < 30; i++) { await sleep(300); if (capOf()) break; }
    let steps = 0;
    while (root.dataset.theme !== 'pharos' && steps < 8) { pill.click(); await sleep(120); steps += 1; }
    const cap = capOf();
    const style = cap ? getComputedStyle(cap) : null;
    const under = {
      theme: root.dataset.theme ?? null, label: pill.textContent.trim(),
      radius: style ? style.borderTopLeftRadius : null,
      chamfer: style ? style.clipPath : null,
      face: style ? style.fontFamily : null,
      capBg: style ? style.backgroundColor : null,
    };
    // Cycle on until the browser's own choice is back.
    let back = 0;
    while ((root.dataset.theme ?? null) !== before && back < 8) { pill.click(); await sleep(120); back += 1; }
    return { before, under, restored: (root.dataset.theme ?? null) === before };`);
  check('the pill reaches PHAROS and the caps read as the language: a chamfered cap in its own face',
    themed.under.theme === 'pharos' && themed.under.label === 'PHAROS'
    && themed.under.radius === '0px' && /^polygon\(/.test(themed.under.chamfer ?? '') && /Chakra/.test(themed.under.face ?? ''),
    JSON.stringify(themed.under));
  check('leaving PHAROS restores the theme the browser had', themed.restored, JSON.stringify(themed));
  }

  if (await stage('nameplate')) {
  const seal = await evalIn(`
    const mark = document.querySelector('.brand-mark');
    if (!mark) return { present: false };
    const style = getComputedStyle(mark);
    const r = mark.getBoundingClientRect();
    // Chromium 117 knows the mask only by its -webkit- name.
    const mask = style.maskImage ?? style.webkitMaskImage ?? '';
    return { present: true, masked: mask.includes('url'), visible: r.width > 20 && r.height > 10 };`);
  check('the nameplate seal is present, masked, and visible', seal.present && seal.masked && seal.visible);
  }

  if (await stage('running-row')) {
  // The RUNNING row on the ARGUS WEB face reads the lab's pulse, and its
  // ERRORED figure is a press: it opens the runs roster filtered to the
  // feeds with errored jobs, and the bar says FILTERED.
  const pulse = await evalIn(`
    const box = document.getElementById('index-instrument');
    await console_idle(); await sleep(1500);
    const row = [...box.querySelectorAll('.index-row')].find((r) => /RUNNING/.test(r.textContent));
    const press = row?.querySelector('.index-verb');
    if (!row || !press) return { row: row?.textContent ?? null, pressed: false };
    press.click();
    let rows = 0, bar = '';
    for (let i = 0; i < 120; i++) { await sleep(250); rows = document.querySelectorAll('.feedlist-row').length; bar = document.querySelector('#layout-root .listing-state, .feedlist-state, .roster-state')?.textContent ?? ''; if (rows > 0) break; }
    await sleep(600);
    const statuses = [...document.querySelectorAll('.feedlist-row')].map((r) => r.textContent).filter((t) => t.length > 0);
    const allErrored = statuses.every((t) => /ERROR/.test(t));
    return { row: row.textContent, pressed: true, rows, allErrored, filterOpen: !!document.querySelector('.roster-filter:not([hidden])') };`);
  check('the RUNNING row reads the lab\'s pulse with an ERRORED press', pulse.pressed && /RUNNING\d/.test(pulse.row ?? ''), JSON.stringify(pulse));
  check('the ERRORED figure opens the roster filtered to errored feeds', pulse.rows > 0 && pulse.allErrored && pulse.filterOpen, JSON.stringify(pulse));
  }

  if (await stage('lane-instrument')) {
  // LANE, BEAT and CUBE on the ARGUS WEB face: the lane reads IDLE while a
  // feed indexes (the walk is off the lane), the beat is fresh, and CUBE's
  // pace is a number once a page has been fetched.
  const bigFeed = process.env.SMOKE_BIG_FEED ?? '';
  const lanes = await evalIn(`
    const box = document.getElementById('lane-instrument');
    const rows = () => Object.fromEntries([...box.querySelectorAll('.lane-row')].map((r) => [r.querySelector('.telemetry-label').textContent, r.querySelector('.telemetry-value').textContent]));
    await console_idle(); await sleep(1500);
    const idle = rows();
    if ('${bigFeed}' === '') return { idle, skipped: true };
    const input = console_input();
    input.value = 'proc refresh ${bigFeed}'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    let during = null;
    for (let i = 0; i < 120; i++) { await sleep(250); if (/FEED ${bigFeed} /.test(document.getElementById('status-jobs').textContent)) { await sleep(1200); during = rows(); break; } }
    for (let i = 0; i < 480 && /FEED ${bigFeed} /.test(document.getElementById('status-jobs').textContent); i++) await sleep(250);
    await sleep(1500);
    return { idle, during, after: rows() };`);
  check('the lane reads IDLE and the beat is fresh on a quiet session', /^IDLE/.test(lanes.idle.LANE ?? '') && /^[0-2]\.\d S AGO$/.test(lanes.idle.BEAT ?? ''), JSON.stringify(lanes.idle));
  if (lanes.skipped) {
    console.log('  skipped the walk: set SMOKE_BIG_FEED=<id>');
  } else {
    check('the lane stays IDLE while a feed indexes off it', lanes.during !== null && /^IDLE/.test(lanes.during.LANE ?? ''), JSON.stringify(lanes.during));
    check('CUBE has a pace once pages were fetched', /S\/PAGE · \d+ PAGES\/MIN$/.test(lanes.after.CUBE ?? ''), JSON.stringify(lanes.after));
  }
  }

  if (await stage('header-index')) {
  // The INDEX instrument on the header's resting face: a quiet index reads
  // CURRENT; a feed's walk takes a row with a bar and its count; the row
  // goes when the walk lands. Same context the status line reads.
  const bigFeed = process.env.SMOKE_BIG_FEED ?? '';
  const instrument = await evalIn(`
    const box = document.getElementById('index-instrument');
    await console_idle();
    const idle = box.textContent;
    const idleRows = box.querySelectorAll('.index-row').length;
    if ('${bigFeed}' === '') return { idle, idleRows, skipped: true };
    const input = console_input();
    input.value = 'proc refresh ${bigFeed}'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    let named = '', barred = false;
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const row = [...box.querySelectorAll('.index-row')].find((r) => /FEED ${bigFeed}/.test(r.textContent));
      if (row) { named = row.textContent; if (row.querySelector('.index-bar .listing-progress-fill')) barred = true; }
      if (named && !row) break;
    }
    for (let i = 0; i < 480 && /FEED ${bigFeed}/.test(box.textContent); i++) await sleep(250);
    return { idle, idleRows, named, barred, after: box.textContent, afterRows: box.querySelectorAll('.index-row').length };`);
  // The pulse row (RUNNING) is permanent too; quiet means no walk row.
  check('a quiet index reads CURRENT on the header, with no walk row', /CURRENT/.test(instrument.idle) && !/FEED \d/.test(instrument.idle), JSON.stringify(instrument));
  if (instrument.skipped) {
    console.log('  skipped the walk: set SMOKE_BIG_FEED=<id> to a feed of about a thousand nodes');
  } else {
    check('a feed being indexed takes a row of its own with a bar and its count', /INDEXING \d/.test(instrument.named) && instrument.barred, JSON.stringify(instrument));
    check('the row goes when the walk lands and the index reads CURRENT again', !/FEED \d/.test(instrument.after) && /CURRENT/.test(instrument.after), JSON.stringify(instrument));
  }
  }

  if (await stage('lane')) {
  // Index movement never holds the lane: `proc refresh <id>` starts a feed's
  // re-walk and answers at once that the feed is indexing; a command sent
  // right behind it answers while the walk still counts on the JOBS readout.
  const bigFeed = process.env.SMOKE_BIG_FEED ?? '';
  if (bigFeed === '') {
    console.log('  skipped: set SMOKE_BIG_FEED=<id> to a feed of about a thousand nodes');
  } else {
    const lane = await evalIn(`
      const input = console_input();
      const jobs = document.getElementById('status-jobs');
      const say = (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
      await console_idle();
      const t0 = performance.now();
      say('proc refresh ${bigFeed}');
      await sleep(80);
      await console_idle();
      const refreshMs = Math.round(performance.now() - t0);
      const walking = /FEED ${bigFeed} /.test(jobs.textContent);
      const term = (document.getElementById('terminal').textContent + console_text());
      const answeredIndexing = /Feed ${bigFeed}: indexing/.test(term);
      const t1 = performance.now();
      say('ls ~');
      await sleep(80);
      await console_idle();
      const lsMs = Math.round(performance.now() - t1);
      const stillWalking = /FEED ${bigFeed} /.test(jobs.textContent);
      for (let i = 0; i < 480 && /FEED ${bigFeed} /.test(jobs.textContent); i++) await sleep(250);
      return { refreshMs, walking, answeredIndexing, lsMs, stillWalking, cleared: !/FEED ${bigFeed} /.test(jobs.textContent) };`);
    check('a cold walk returns the lane at once', lane.answeredIndexing && lane.refreshMs < 3000, JSON.stringify(lane));
    check('a command sent behind the walk answers while the feed still indexes', lane.walking && lane.stillWalking, JSON.stringify(lane));
    check('the walk lands and its readout clears', lane.cleared, JSON.stringify(lane));
  }
  }

  if (await stage('index-annunciation')) {
  // A feed's first-visit topology load is never a silent hang: the JOBS
  // readout names the feed and counts its instances while the daemon walks
  // it. `proc refresh <id>` drops and re-walks one feed, which is the same
  // path a first visit takes; only a feed large enough to outlast one
  // telemetry tick can be observed, so the scenario needs SMOKE_BIG_FEED.
  const bigFeed = process.env.SMOKE_BIG_FEED ?? '';
  if (bigFeed === '') {
    console.log('  skipped: set SMOKE_BIG_FEED=<id> to a feed of about a thousand nodes (one that outlasts a telemetry tick yet finishes within the wait)');
  } else {
    const indexing = await evalIn(`
      const input = console_input();
      const jobs = document.getElementById('status-jobs');
      await console_idle();
      input.value = 'proc refresh ${bigFeed}'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let seen = ''; let counted = false;
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const text = jobs.textContent;
        if (/FEED ${bigFeed} \\d+/.test(text)) { seen = text; if (/FEED ${bigFeed} [1-9]\\d*\\/[1-9]/.test(text)) counted = true; }
        if (seen && !/FEED ${bigFeed} /.test(text)) break;
      }
      for (let i = 0; i < 480 && /FEED ${bigFeed} /.test(jobs.textContent); i++) await sleep(250);
      return { seen, counted, cleared: !/FEED ${bigFeed} /.test(jobs.textContent) };`);
    check('the JOBS readout names a feed being indexed and counts its instances', indexing.seen !== '' && indexing.counted, JSON.stringify(indexing));
    check('the feed indexing readout clears when the walk completes', indexing.cleared, JSON.stringify(indexing));
  }
  }

  // ---------------------------------------------------------------- image
  // An image pane on a guest engine's field. Needs a DICOM series folder
  // on the daemon's CFS (SMOKE_DICOM_SERIES=<folder>, e.g. the synthesized
  // series the S7 fixtures upload) and, optionally, a volume
  // (SMOKE_NIFTI=<path>). Assertions read mise's seams — state, bar,
  // console lines, focus — never the engine's internals.
  // Without a series named in the environment, the suite makes its own:
  // synthesized fixtures written now, put on the daemon through its own
  // /vfs route under the identity's uploads, and removed at the end.
  // (The fixtures are made at boot, beside the session's first READY.)
  if (await stage('image-pane')) {
  if (dicomSeries === '') {
    console.log('  skipped: set SMOKE_DICOM_SERIES=<series folder on the daemon>');
  } else {
    await evalIn(`await console_idle();`);
    const opened = await evalIn(`
      document.getElementById('gutter-files').click(); await sleep(600);
      const pane = document.querySelector('.pane-files');
      pane.querySelector('.pane-handle').click(); await sleep(150);
      pane.querySelector('[data-split="col"][data-place="after"]').click(); await sleep(600);
      const prompt = document.querySelector('.empty-prompt'); if (!prompt) return { error: 'no empty prompt' };
      prompt.value = 'dcm series ${dicomSeries}';
      prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let image = null;
      for (let i = 0; i < 120; i++) { await sleep(500); image = document.querySelector('.pane-image'); if (image && /SLICE \\d+ OF \\d+/.test(image.querySelector('.pane-state').textContent) && !image.querySelector('.image-working')) break; }
      if (!image) return { error: 'no image pane' };
      const state = image.querySelector('.pane-state').textContent;
      // The engine sizes its canvas on its next frame; measure after it.
      await sleep(600);
      const field = image.querySelector('.image-field').getBoundingClientRect();
      const canvas = image.querySelector('.image-field canvas');
      const c = canvas ? canvas.getBoundingClientRect() : null;
      const fits = c !== null && Math.abs(c.width - field.width) < 4 && Math.abs(c.height - field.height) < 4;
      const dprOk = canvas !== null && Math.abs(canvas.width - c.width * devicePixelRatio) < 4;
      const inField = image.querySelector('.image-field button, .image-field .strategy-pill') === null;
      const onFrame = image.querySelectorAll('.mode-frame .image-tool').length;
      const hue = image.dataset.modality;
      const noted = console_text().split('\\n').some((l) => /^image: \\d+ slices, first on screen in \\d+ ms/.test(l.trim()));
      const r = image.querySelector('.image-viewport').getBoundingClientRect();
      return { state, fits, dprOk, canvasPx: canvas ? canvas.width : null, cssPx: c ? Math.round(c.width) : null, dpr: devicePixelRatio, inField, onFrame, hue, noted, wheelAt: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };`);
    // The wheel over the field turns the stack; the page stays put. A real
    // wheel through the debugger, as the operator's would arrive.
    if (opened.error === undefined) {
      for (let i = 0; i < 3; i++) {
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: opened.wheelAt.x, y: opened.wheelAt.y, deltaX: 0, deltaY: 120 });
        await new Promise((r) => setTimeout(r, 250));
      }
      const turned = await evalIn(`
        const image = document.querySelector('.pane-image');
        let after = image.querySelector('.pane-state').textContent;
        for (let i = 0; i < 40 && /SLICE 1 OF/.test(after); i++) { await sleep(100); after = image.querySelector('.pane-state').textContent; }
        return { after, scrollY: window.scrollY };`);
      opened.after = turned.after;
      opened.scrollY = turned.scrollY;
    }
    check('an image pane opens on a series with the first slice on its bar', opened.error === undefined && /SLICE 1 OF \d+/.test(opened.state), JSON.stringify(opened));
    check('the engine\'s canvas fills its mount at the device pixel ratio', opened.fits === true && opened.dprOk === true, JSON.stringify(opened));
    check('no control sits inside the image field and the tool blocks ride the frame', opened.inField === true && opened.onFrame === 6, JSON.stringify(opened));
    check('the frame wears the modality as its hue', typeof opened.hue === 'string' && opened.hue.length > 0, JSON.stringify(opened));
    check('the wheel over the field turns the stack and the page stays put', opened.after !== opened.state && /SLICE [2-9]/.test(opened.after ?? '') && opened.scrollY === 0, JSON.stringify(opened));
    check('the pane says in the console when the first slice landed', opened.noted === true, JSON.stringify(opened));
  }
  }
  if (await stage('image-annotations')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    // A length drawn through the debugger, as the operator's would arrive.
    const at = await evalIn(`
      await console_idle();
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image layout single');
      const image = document.querySelector('.pane-image');
      for (let i = 0; i < 40 && !image.querySelector('.image-viewport-stack'); i++) await sleep(150);
      image.querySelector('.image-tool[data-tool="length"]').click(); await sleep(200);
      const r = image.querySelector('.image-viewport').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x - 40, y: at.y - 40, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 40 + i * 10, y: at.y - 40 + i * 10, button: 'left' }); await new Promise((r) => setTimeout(r, 40)); }
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 40, y: at.y + 40, button: 'left', clickCount: 1 });
    const saved = await evalIn(`
      await sleep(600);
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image save');
      let landed = null;
      for (let i = 0; i < 60; i++) { await sleep(300); landed = console_text().split('\\n').find((l) => /^✓ \\/home\\/.*\\/annotations\\/.*measurements\\.dcm$/.test(l.trim())); if (landed) break; }
      if (!landed) return { error: 'nothing landed', tail: console_text().split('\\n').slice(-4) };
      const file = landed.trim().slice(2);
      // Reopen the series: the file the kernel now lists comes back onto the field.
      const before = document.querySelector('.pane-image').dataset.annotations ?? null;
      await run('image ${dicomSeries}');
      let reloaded = null;
      for (let i = 0; i < 80; i++) { await sleep(300); reloaded = console_text().split('\\n').find((l) => /^image: \\d+ measurements? from measurements\\.dcm/.test(l.trim())); if (reloaded) break; }
      const placed = document.querySelector('.pane-image').dataset.annotations ?? null;
      // Leave the identity's CFS as it was found.
      await run('rm -r ' + file.slice(0, file.lastIndexOf('/')));
      await sleep(1500);
      return { file, before, reloaded, placed };`);
    check('a measurement saved as an SR comes back when the series reopens', saved.error === undefined && /measurements\.dcm$/.test(saved.file ?? '') && saved.before === '0' && saved.placed === '1', JSON.stringify(saved));
  }
  }
  if (await stage('image-answers')) {
  if (dicomSeries === '') {
    console.log('  skipped: set SMOKE_DICOM_SERIES=<series folder on the daemon>');
  } else {
    // `image <path>` is a KERNEL command now, not a surface verb: it crosses
    // the wire, resolves the series and emits an intent this surface opens
    // the pane from. So a typed open is a round-trip (no client-side instant
    // notice), and the console carries the reflection a TTY would print.
    const opened = await evalIn(`
      await console_idle();
      const term = document.getElementById('terminal');
      const before = console_mark();
      const seen = { openingSeen: false };
      const observer = new MutationObserver(() => {
        const note = document.querySelector('.pane-image .image-working-label');
        if (note && /^OPENING /.test(note.textContent)) seen.openingSeen = true;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const input = console_input();
      input.value = 'image ${dicomSeries}';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let pane = null;
      for (let i = 0; i < 200; i++) { await sleep(200); pane = [...document.querySelectorAll('.pane-image')].find((p) => /SLICE \\d+ OF \\d+/.test(p.querySelector('.pane-state').textContent)); if (pane) break; }
      observer.disconnect();
      const reflection = console_since(before);
      return { opened: pane !== null, openingSeen: seen.openingSeen, reflectsSeries: /MODALITY|SERIES\\b|slices/i.test(reflection) };`);
    check('image <path> is a kernel command whose intent opens the pane', opened.opened === true, JSON.stringify(opened));
    const refused = await evalIn(`
      await console_idle();
      const term = document.getElementById('terminal');
      const before = console_mark();
      const input = console_input();
      input.value = 'image /home/does-not-exist/argus-smoke-nowhere-${Date.now()}';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let said = false;
      for (let i = 0; i < 60; i++) { await sleep(200); if (/not a readable DICOM series/.test(console_since(before))) { said = true; break; } }
      return { said };`);
    check('a bad image path is refused in the console by the kernel', refused.said === true, JSON.stringify(refused));
  }
  }
  if (await stage('image-field')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    // A stack fills before it turns: reopen the series and record what the
    // bar and the field say on the way, then wheel while it is still
    // arriving and again once it is whole.
    const filled = await evalIn(`
      await console_idle();
      const image = document.querySelector('.pane-image');
      const seen = { readouts: [], notes: [], lockedTurn: null, wholeTurn: null };
      const observer = new MutationObserver(() => {
        const r = image.querySelector('.pane-state').textContent; if (seen.readouts[seen.readouts.length - 1] !== r) seen.readouts.push(r);
        const n = image.querySelector('.image-working'); if (n) { const t = n.querySelector('.image-working-label').textContent + ' ' + n.querySelector('.image-working-count').textContent; if (seen.notes[seen.notes.length - 1] !== t) seen.notes.push(t); }
      });
      observer.observe(image, { subtree: true, childList: true, characterData: true });
      const input = console_input();
      input.value = 'image ${dicomSeries}';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 200; i++) { await sleep(100); if (/^LOADING \\d+ OF/.test(image.querySelector('.pane-state').textContent)) break; }
      seen.duringFill = image.querySelector('.pane-state').textContent;
      for (let i = 0; i < 200; i++) { await sleep(100); if (/^SLICE 1 OF/.test(image.querySelector('.pane-state').textContent) && !image.querySelector('.image-working')) break; }
      observer.disconnect();
      seen.whole = image.querySelector('.pane-state').textContent;
      const r = image.querySelector('.image-viewport').getBoundingClientRect();
      seen.wheelAt = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return seen;`);
    // The observer, not a poll: with the slices already in the loader's
    // cache the count runs to 100% inside a frame.
    const firstSlice = filled.readouts.indexOf(filled.readouts.find((r) => /^SLICE 1 OF \d+$/.test(r)));
    const counted = filled.readouts.slice(firstSlice + 1).some((r) => /^LOADING \d+ OF \d+$/.test(r));
    check('a stack counts every slice in before it turns', firstSlice >= 0 && counted && filled.notes.some((n) => /^READING SLICES \d+ \/ \d+ · 100%$/.test(n)) && /^SLICE 1 OF \d+$/.test(filled.whole ?? ''), JSON.stringify(filled));
    // Over the guard the stack waits for LOAD and nothing turns until it lands.
    const held = await evalIn(`
      await console_idle();
      const image = document.querySelector('.pane-image');
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image guard 1000');
      await run('image ${dicomSeries}');
      let state = '';
      for (let i = 0; i < 100; i++) { await sleep(150); state = image.querySelector('.pane-state').textContent; if (/LOAD FOR STACK/.test(state)) break; }
      const loadShown = !image.querySelector('.image-load').hidden;
      const r = image.querySelector('.image-viewport').getBoundingClientRect();
      return { state, loadShown, wheelAt: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };`);
    for (let i = 0; i < 3; i++) {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: held.wheelAt.x, y: held.wheelAt.y, deltaX: 0, deltaY: 120 });
      await new Promise((r) => setTimeout(r, 200));
    }
    const loaded = await evalIn(`
      const image = document.querySelector('.pane-image');
      const stillHeld = image.querySelector('.pane-state').textContent;
      const input = console_input();
      input.value = 'image load'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let state = '';
      for (let i = 0; i < 200; i++) { await sleep(100); state = image.querySelector('.pane-state').textContent; if (/^SLICE 1 OF/.test(state) && !image.querySelector('.image-working')) break; }
      input.value = 'image guard off'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled();
      return { stillHeld, state, loadHidden: image.querySelector('.image-load').hidden };`);
    for (let i = 0; i < 3; i++) {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: held.wheelAt.x, y: held.wheelAt.y, deltaX: 0, deltaY: 120 });
      await new Promise((r) => setTimeout(r, 200));
    }
    const turned = await evalIn(`
      const image = document.querySelector('.pane-image');
      let after = image.querySelector('.pane-state').textContent;
      for (let i = 0; i < 40 && /SLICE 1 OF/.test(after); i++) { await sleep(100); after = image.querySelector('.pane-state').textContent; }
      return { after };`);
    check('a stack over the guard shows its first slice and waits for LOAD, and the wheel does not turn it', /LOAD FOR STACK/.test(held.state ?? '') && held.loadShown === true && /LOAD FOR STACK/.test(loaded.stillHeld ?? ''), JSON.stringify({ held, loaded }));
    check('LOAD fills the stack and the wheel turns it', /^SLICE 1 OF \d+$/.test(loaded.state ?? '') && loaded.loadHidden === true && /SLICE [2-9]/.test(turned.after ?? ''), JSON.stringify({ loaded, turned }));
    // The overlay counts the slices, and follows the wheel.
    const overlay = await evalIn(`
      const image = document.querySelector('.pane-image');
      image.querySelector('.image-overlay').click();
      let row = null;
      for (let i = 0; i < 40; i++) { await sleep(150); row = image.querySelector('.image-overlay-slice'); if (row && row.textContent) break; }
      return { first: row ? row.textContent : null, state: image.querySelector('.pane-state').textContent };`);
    check('the overlay leads with the slice count and it matches the bar', overlay.first !== null && overlay.first === overlay.state, JSON.stringify(overlay));
    // The probe reads live under the pointer and leaves nothing behind.
    const armed = await evalIn(`
      const image = document.querySelector('.pane-image');
      image.querySelector('.image-tool[data-tool="probe"]').click(); await sleep(200);
      const r = image.querySelector('.image-viewport').getBoundingClientRect();
      return { at: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, out: { x: r.x + 4, y: r.y + 4 } };`);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: armed.at.x, y: armed.at.y });
    await new Promise((r) => setTimeout(r, 200));
    const probed = await evalIn(`
      const image = document.querySelector('.pane-image');
      const note = image.querySelector('.image-probe-note');
      return { text: note ? note.textContent : null, rings: document.querySelectorAll('.pane-image svg circle').length };`);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: armed.at.x, y: armed.at.y, button: 'left', clickCount: 1 });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: armed.at.x, y: armed.at.y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const clicked = await evalIn(`
      const image = document.querySelector('.pane-image');
      return { rings: image.querySelectorAll('svg circle').length, annotations: (window.__argusImageState ? null : undefined) };`);
    check('the probe reads position, slice and value live under the pointer', probed.text !== null && /^X \d+  Y \d+  ·  SLICE \d+  ·  -?[\d.]+/.test(probed.text), JSON.stringify(probed));
    check('a probe press leaves no ring on the image', clicked.rings === 0 && probed.rings === 0, JSON.stringify({ probed, clicked }));
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: armed.out.x - 40, y: armed.out.y - 40 });
    // The field keeps its shape when the frame opens beside it.
    const shaped = await evalIn(`
      const image = document.querySelector('.pane-image');
      image.querySelector('.image-tool[data-tool="wl"]').click(); await sleep(100);
      const canvas = image.querySelector('.image-field canvas');
      const before = { css: Math.round(canvas.getBoundingClientRect().width), px: canvas.width };
      image.querySelector('.mode-strip').click();
      let after = null;
      for (let i = 0; i < 40; i++) { await sleep(150); const w = Math.round(canvas.getBoundingClientRect().width); if (w !== before.css && Math.abs(canvas.width - w * devicePixelRatio) < 4) { after = { css: w, px: canvas.width }; break; } }
      if (after === null) after = { css: Math.round(canvas.getBoundingClientRect().width), px: canvas.width };
      const open = image.dataset.modes === 'open';
      image.querySelector('.mode-strip').click(); await sleep(600);
      return { before, after, open, dpr: devicePixelRatio };`);
    check('the field keeps its shape when the frame opens beside it', shaped.open === true && shaped.after.css < shaped.before.css && Math.abs(shaped.after.px - shaped.after.css * shaped.dpr) < 4, JSON.stringify(shaped));
  }
  }
  if (await stage('image-focus')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    const focus = await evalIn(`
      const image = document.querySelector('.pane-image');
      const field = image.querySelector('.image-field');
      field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(150);
      const taken = field.contains(document.activeElement) || document.activeElement === field;
      const markOn = !image.querySelector('.image-focus').hidden;
      // A key pressed on the field stays there: the drawer's verbs do not walk.
      const drawerBefore = image.querySelector('.pane-drawer').hidden;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await sleep(100);
      const drawerAfter = image.querySelector('.pane-drawer').hidden;
      // Esc gives the keyboard back, one press, one level: the frame it did not touch stays as it was.
      image.dataset.modes = 'open';
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200);
      const released = !(field.contains(document.activeElement) || document.activeElement === field);
      const markOff = image.querySelector('.image-focus').hidden;
      const frameStillOpen = image.dataset.modes === 'open';
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200);
      const frameClosedNext = image.dataset.modes !== 'open';
      return { taken, markOn, drawerBefore, drawerAfter, released, markOff, frameStillOpen, frameClosedNext };`);
    check('the image field keeps the keyboard until Esc', focus.taken && focus.markOn && focus.drawerBefore === focus.drawerAfter && focus.released && focus.markOff, JSON.stringify(focus));
    check('Esc from the field is one level: the open frame waits for the next press', focus.frameStillOpen && focus.frameClosedNext, JSON.stringify(focus));
  }
  }
  if (await stage('image-verbs')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    const verbs = await evalIn(`
      await console_idle();
      const image = document.querySelector('.pane-image');
      image.click();
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image slice 4');
      let slice = image.querySelector('.pane-state').textContent;
      for (let i = 0; i < 40 && !/SLICE 4 OF/.test(slice); i++) { await sleep(100); slice = image.querySelector('.pane-state').textContent; }
      await run('image colormap hot');
      const colormap = image.querySelector('.image-colormap').textContent;
      await run('image layout mpr');
      let mode = '';
      for (let i = 0; i < 120; i++) { await sleep(500); mode = image.querySelector('.pane-mode').textContent; if (mode === 'MPR' && image.querySelectorAll('.image-mpr .image-viewport').length === 3) break; }
      const planes = image.querySelectorAll('.image-mpr .image-viewport').length;
      const layoutPill = image.querySelector('.image-layout:not(.rail-off)').textContent;
      // 3D reached FROM MPR, the operator's path: the volume is cached
      // under the engine's id by the MPR build, so a 3D that waited on a
      // fresh load's events would render nothing. The render must carry
      // lit pixels.
      await run('image layout 3d');
      let render3d = 0;
      for (let i = 0; i < 120; i++) { await sleep(500); if (image.querySelector('.pane-mode').textContent === '3D' && image.querySelector('.image-render .image-viewport')) break; }
      await sleep(2000);
      const render = image.querySelector('.image-render');
      const canvas3d = render ? render.querySelector('canvas') : null;
      if (canvas3d) { try { const ctx = canvas3d.getContext('2d'); const d = ctx.getImageData(0, 0, canvas3d.width, canvas3d.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 30) render3d++; } catch (e) { render3d = -1; } }
      const mode3d = image.querySelector('.pane-mode').textContent;
      await run('image layout single');
      await settled(() => image.querySelector('.pane-state').textContent, { limit: 6000 });
      const back = image.querySelector('.pane-mode').textContent;
      return { slice, colormap, mode, planes, layoutPill, mode3d, render3d, back };`);
    check('image slice <n> moves the stack and the bar says which slice', /SLICE 4 OF/.test(verbs.slice ?? ''), JSON.stringify(verbs));
    check('image colormap names the block', verbs.colormap === 'HOT', JSON.stringify(verbs));
    check('image layout mpr stands three linked planes and the bar annunciates the mode', verbs.mode === 'MPR' && verbs.planes === 3 && verbs.layoutPill === 'MPR', JSON.stringify(verbs));
    check('image layout 3d from MPR renders a volume, not a black field', verbs.mode3d === '3D' && verbs.render3d > 1000, JSON.stringify(verbs));
    check('image layout single returns and the mode annunciation clears', verbs.back === '', JSON.stringify(verbs));
  }
  }
  if (await stage('image-tools')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    // MPR offers the pointer tools on a plane; 3D offers only navigation.
    const mpr = await evalIn(`
      await console_idle();
      const image = document.querySelector('.pane-image');
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image guard off');
      await run('image layout mpr');
      for (let i = 0; i < 80; i++) { await sleep(200); if (image.querySelector('.pane-mode').textContent === 'MPR' && image.querySelectorAll('.image-mpr .image-viewport').length === 3) break; }
      const resting = [...image.querySelectorAll('.image-tool')].every((b) => b.classList.contains('rail-off') && !b.classList.contains('rail-na'));
      image.querySelector('.image-tool[data-tool="length"]').click(); await sleep(150);
      const lengthLit = !image.querySelector('.image-tool[data-tool="length"]').classList.contains('rail-off');
      const plane = image.querySelector('.image-viewport-axial') || image.querySelector('.image-mpr .image-viewport');
      const r = plane.getBoundingClientRect();
      return { resting, lengthLit, at: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, from: { x: r.x + r.width * 0.35, y: r.y + r.height * 0.4 } };`);
    // Draw a length across a plane with a real drag.
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: mpr.from.x, y: mpr.from.y });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: mpr.at.x, y: mpr.at.y });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: mpr.at.x, y: mpr.at.y });
    await new Promise((r) => setTimeout(r, 400));
    const drawn = await evalIn(`
      const image = document.querySelector('.pane-image');
      const lines = image.querySelectorAll('.image-mpr svg line').length;
      image.querySelector('.image-tool[data-tool="probe"]').click(); await sleep(150);
      const r = (image.querySelector('.image-viewport-axial') || image.querySelector('.image-mpr .image-viewport')).getBoundingClientRect();
      window.__probeAt = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return { lines };`);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (await evalIn('return window.__probeAt.x')), y: (await evalIn('return window.__probeAt.y')) });
    await new Promise((r) => setTimeout(r, 300));
    const probed = await evalIn(`
      const image = document.querySelector('.pane-image');
      const note = image.querySelector('.image-probe-note');
      return { text: note ? note.textContent : null };`);
    check('MPR rests on the crosshair with no tool lit, and offers the pointer tools', mpr.resting === true && mpr.lengthLit === true, JSON.stringify(mpr));
    check('a length drawn on an MPR plane leaves a measurement', drawn.lines >= 2, JSON.stringify(drawn));
    check('the probe reads a voxel on an MPR plane', probed.text !== null && /^X \d+  Y \d+  Z \d+  ·  /.test(probed.text), JSON.stringify(probed));
    const nav3d = await evalIn(`
      const image = document.querySelector('.pane-image');
      const input = console_input();
      input.value = 'image layout 3d'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 120; i++) { await sleep(250); if (image.querySelector('.pane-mode').textContent === '3D' && image.querySelector('.image-render .image-viewport')) break; }
      await sleep(1200);
      const pills = Object.fromEntries([...image.querySelectorAll('.image-tool')].map((b) => [b.dataset.tool, b.classList.contains('rail-na') ? 'na' : b.classList.contains('rail-off') ? 'off' : 'lit']));
      const canvas = image.querySelector('.image-render canvas');
      const bbox = () => { const c = canvas.getContext('2d'); const d = c.getImageData(0, 0, canvas.width, canvas.height).data; let minx = 1e9, maxx = -1; for (let y = 0; y < canvas.height; y += 3) for (let x = 0; x < canvas.width; x += 3) { const i = (y * canvas.width + x) * 4; if (d[i] + d[i+1] + d[i+2] > 30) { if (x < minx) minx = x; if (x > maxx) maxx = x; } } return maxx < 0 ? null : { w: maxx - minx, cx: Math.round((minx + maxx) / 2) }; };
      window.__bbox = bbox;
      const r = image.querySelector('.image-render .image-viewport').getBoundingClientRect();
      image.querySelector('.image-tool[data-tool="pan"]').click(); await sleep(150);
      return { pills, panLit: !image.querySelector('.image-tool[data-tool="pan"]').classList.contains('rail-off'), before: bbox(), at: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, to: { x: r.x + r.width * 0.78, y: r.y + r.height / 2 } };`);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: nav3d.at.x, y: nav3d.at.y });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: nav3d.to.x, y: nav3d.to.y });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: nav3d.to.x, y: nav3d.to.y });
    await new Promise((r) => setTimeout(r, 500));
    const panned = await evalIn(`return { after: window.__bbox() };`);
    check('3D offers zoom and pan, and marks the slice tools unavailable', nav3d.pills.zoom !== 'na' && nav3d.pills.pan !== 'na' && nav3d.pills.length === 'na' && nav3d.pills.angle === 'na' && nav3d.pills.probe === 'na' && nav3d.pills.wl === 'na', JSON.stringify(nav3d.pills));
    check('PAN drags the 3D render across the field', nav3d.panLit === true && nav3d.before !== null && panned.after !== null && Math.abs(panned.after.cx - nav3d.before.cx) > 40, JSON.stringify({ before: nav3d.before, after: panned.after }));
    await evalIn(`const input = console_input(); input.value = 'image layout single'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(600); await console_settled(); return 1;`);
  }
  }
  if (await stage('image-study')) {
  if (dicomSeries === '' || fixtureFolder === null) {
    console.log('  skipped: needs the image fixtures');
  } else {
    // A study folder opens its first series: `image` finds the series
    // inside a folder that is not one itself.
    const study = await evalIn(`
      await console_idle();
      const input = console_input();
      input.value = ${JSON.stringify('image ')} + ${JSON.stringify(fixtureFolder)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        const p = [...document.querySelectorAll('.pane-image')].find((x) => x.offsetParent !== null);
        const state = p?.querySelector('.pane-state')?.textContent ?? '';
        if (p && /NOT A READABLE/.test(p.innerText)) return { opened: false, state, text: p.innerText.slice(0, 160) };
        if (/SLICE \\d+ OF 16/.test(state)) return { opened: true, state };
      }
      return { opened: false, console: console_text().split('\\n').slice(-4) };`);
    check('a study folder opens its first series', study.opened === true, JSON.stringify(study));
  }
  }

  if (await stage('image-frame')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    // Every frame block does what its word says — by a mouse and by a
    // finger. ZOOM once panned on a phone: the library's zoom pinched to
    // zoom and panned on a one-finger drag, and nothing here drove a block
    // and read what it did. Each block is driven for real and the field is
    // read back through `image state`, not the block's own light.
    const say = async (line) => evalIn(`
      await console_idle();
      const input = console_input();
      input.value = ${JSON.stringify(line)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(250); await console_settled();
      return 1;`);
    const read = async () => {
      await say('image state');
      const lines = await evalIn(`
        for (let i = 0; i < 40; i++) { await sleep(100); const t = console_text().split('\\n'); if (t.some((l) => /^viewports: /.test(l.trim()))) break; }
        const t = console_text().split('\\n').map((l) => l.trim());
        return { head: t.filter((l) => /^image: layout=/.test(l)).slice(-1)[0] ?? '', views: t.filter((l) => /^viewports: /.test(l)).slice(-1)[0] ?? '' };`);
      const first = (lines.views.replace(/^viewports: /, '').split(' | ')[0] ?? '');
      const num = (re, text) => { const m = re.exec(text); return m ? Number(m[1]) : NaN; };
      const focus = (/focus=([-\d.,]+)/.exec(first)?.[1] ?? '').split(',').map(Number);
      const voi = /voi=([-\d.]+)\.\.([-\d.]+)/.exec(first);
      return {
        scale: num(/scale=([-\d.]+)/, first), focus, voi: voi ? [Number(voi[1]), Number(voi[2])] : null,
        annotations: num(/annotations=(\d+)/, lines.head), slice: num(/slice=(\d+)\//, lines.head), layout: /layout=(\w+)/.exec(lines.head)?.[1] ?? '',
      };
    };
    const field = async () => evalIn(`
      const v = document.querySelector('.pane-image .image-viewport, .pane-image .image-render .image-viewport');
      const r = v.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
    const pick = async (tool) => evalIn(`document.querySelector('.pane-image .image-tool[data-tool="${tool}"]').click(); await sleep(200); return 1;`);
    const mouseDrag = async (a, b) => {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: a.x, y: a.y });
      for (let k = 1; k <= 6; k++) await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: a.x + (b.x - a.x) * k / 6, y: a.y + (b.y - a.y) * k / 6 });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: b.x, y: b.y });
      await new Promise((r) => setTimeout(r, 300));
    };
    const click = async (at) => {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: at.x, y: at.y });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: at.x, y: at.y });
      await new Promise((r) => setTimeout(r, 200));
    };
    const touchDrag = async (points, dy, dx = 0) => {
      const at = (k) => points.map((p, i) => ({ x: p.x + dx * k / 6, y: p.y + dy * k / 6, id: i }));
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
      // A finger rests a moment before it moves; the viewer takes a touch
      // as a drag only once it has landed.
      await new Promise((r) => setTimeout(r, 150));
      for (let k = 1; k <= 6; k++) { await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) }); await new Promise((r) => setTimeout(r, 30)); }
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await new Promise((r) => setTimeout(r, 300));
    };
    const moved = (a, b) => Math.hypot(...a.focus.map((v, i) => v - (b.focus[i] ?? 0))) > Math.max(1e-3, a.scale * 1e-3);
    // ZOOM zooms about the point pressed, so the view's centre may shift as
    // it scales; what it must do is scale. PAN must move and not scale.
    const zoomed = (a, b) => Math.abs(a.scale - b.scale) > a.scale * 0.01;
    const windowed = (a, b) => a.voi !== null && b.voi !== null && (Math.abs(a.voi[0] - b.voi[0]) > 0.5 || Math.abs(a.voi[1] - b.voi[1]) > 0.5);

    await say('image guard off');
    await say('image layout single');
    await evalIn(`for (let i = 0; i < 120; i++) { await sleep(250); const t = document.querySelector('.pane-image .pane-state')?.textContent || ''; if (/SLICE \\d+ OF/.test(t) && !/LOADING/.test(t)) break; } return 1;`);
    const c = await field();
    const a = { x: c.x - 50, y: c.y - 40 };
    const b = { x: c.x + 50, y: c.y + 40 };
    const results = {};
    // By a finger, then by a mouse, each read against the field before it.
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    for (const tool of ['wl', 'zoom', 'pan']) {
      await pick(tool);
      const before = await read();
      await touchDrag([b], -80, -100);
      const after = await read();
      results[`touch ${tool}`] = { zoomed: zoomed(before, after), moved: moved(before, after), windowed: windowed(before, after) };
    }
    const sliceBefore = await read();
    await touchDrag([{ x: c.x - 40, y: c.y - 60 }, { x: c.x + 40, y: c.y - 60 }], 120);
    const sliceAfter = await read();
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    // The library drops mouse events for two seconds after a touch (and
    // touches after a mouse), so a finger's tap is never read twice.
    await new Promise((r) => setTimeout(r, 2200));
    check('W/L by a finger changes the window and neither zooms nor pans', results['touch wl'].windowed && !results['touch wl'].zoomed && !results['touch wl'].moved, JSON.stringify(results['touch wl']));
    check('ZOOM by a finger zooms (it once panned on a phone)', results['touch zoom'].zoomed && !results['touch zoom'].windowed, JSON.stringify(results['touch zoom']));
    check('PAN by a finger pans, and does not zoom', results['touch pan'].moved && !results['touch pan'].zoomed, JSON.stringify(results['touch pan']));
    check('two fingers up or down step through the series', sliceAfter.slice !== sliceBefore.slice, JSON.stringify({ before: sliceBefore.slice, after: sliceAfter.slice }));
    for (const tool of ['wl', 'zoom', 'pan']) {
      await pick(tool);
      const before = await read();
      await mouseDrag(a, b);
      const after = await read();
      results[`mouse ${tool}`] = { zoomed: zoomed(before, after), moved: moved(before, after), windowed: windowed(before, after) };
    }
    check('W/L by mouse changes the window and neither zooms nor pans', results['mouse wl'].windowed && !results['mouse wl'].zoomed && !results['mouse wl'].moved, JSON.stringify(results['mouse wl']));
    check('ZOOM by mouse zooms', results['mouse zoom'].zoomed && !results['mouse zoom'].windowed, JSON.stringify(results['mouse zoom']));
    check('PAN by mouse pans, and does not zoom', results['mouse pan'].moved && !results['mouse pan'].zoomed, JSON.stringify(results['mouse pan']));

    await pick('length');
    const lengthBefore = await read();
    await mouseDrag(a, b);
    const lengthAfter = await read();
    check('LENGTH leaves a measurement', lengthAfter.annotations === lengthBefore.annotations + 1, JSON.stringify({ before: lengthBefore.annotations, after: lengthAfter.annotations }));
    // The angle starts in empty field: pressed on the length's end it would
    // take that handle instead.
    await pick('angle');
    await mouseDrag({ x: c.x - 60, y: c.y + 50 }, { x: c.x, y: c.y + 10 });
    await click({ x: c.x + 60, y: c.y + 50 });
    const angleAfter = await read();
    check('ANGLE leaves a measurement', angleAfter.annotations === lengthAfter.annotations + 1, JSON.stringify({ before: lengthAfter.annotations, after: angleAfter.annotations }));
    await pick('probe');
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + 3, y: c.y + 3 });
    await new Promise((r) => setTimeout(r, 300));
    const probe = await evalIn(`return document.querySelector('.pane-image .image-probe-note')?.textContent ?? null;`);
    check('PROBE reads the pixel under the pointer', probe !== null && probe.length > 0, JSON.stringify(probe));


    // A rendered volume: ZOOM and PAN take the drag from rotate.
    await say('image layout 3d');
    await evalIn(`for (let i = 0; i < 160; i++) { await sleep(250); const img = document.querySelector('.pane-image'); if (img.querySelector('.pane-mode').textContent === '3D' && img.querySelector('.image-render .image-viewport')) break; } await sleep(1500); return 1;`);
    const r3 = await field();
    const a3 = { x: r3.x - 50, y: r3.y - 40 };
    const b3 = { x: r3.x + 50, y: r3.y + 40 };
    await pick('zoom');
    const z0 = await read();
    await mouseDrag(a3, b3);
    const z1 = await read();
    await pick('pan');
    const p0 = await read();
    await mouseDrag(a3, b3);
    const p1 = await read();
    check('ZOOM on a rendered volume zooms', zoomed(z0, z1), JSON.stringify({ z0, z1 }));
    check('PAN on a rendered volume pans, and does not zoom', moved(p0, p1) && !zoomed(p0, p1), JSON.stringify({ p0, p1 }));
    await say('image layout single');
  }
  }
  if (await stage('image-slab')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    const slab = await evalIn(`
      await console_idle();
      const image = document.querySelector('.pane-image');
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image guard off');
      await run('image layout slab');
      for (let i = 0; i < 120; i++) { await sleep(250); if (/^SLAB/.test(image.querySelector('.pane-state').textContent) && !image.querySelector('.image-working')) break; }
      const canvas = image.querySelector('.image-render canvas');
      const cr = canvas ? canvas.getBoundingClientRect() : null;
      const pills = Object.fromEntries([...image.querySelectorAll('.image-tool')].map((b) => [b.dataset.tool, b.classList.contains('rail-na') ? 'na' : b.classList.contains('rail-off') ? 'off' : 'lit']));
      const layoutLit = image.querySelector('.image-layout[data-layout="slab"]') && !image.querySelector('.image-layout[data-layout="slab"]').classList.contains('rail-off');
      const vp = image.querySelector('.image-render .image-viewport');
      const r = vp ? vp.getBoundingClientRect() : null;
      return { state: image.querySelector('.pane-state').textContent, mode: image.querySelector('.pane-mode').textContent, hasCanvas: canvas !== null, canvasFits: cr !== null && cr.width > 100 && cr.height > 100, pills, layoutLit, at: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null };`);
    // The wheel sweeps the slice.
    const slabAt = slab.at ?? { x: 1400, y: 1000 };
    for (let i = 0; i < 4; i++) { await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: slabAt.x, y: slabAt.y, deltaX: 0, deltaY: 120 }); await new Promise((r) => setTimeout(r, 200)); }
    const swept = await evalIn(`
      const image = document.querySelector('.pane-image');
      const input = console_input();
      const after = image.querySelector('.pane-state').textContent;
      input.value = 'image ghost 0.3'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(400); await console_settled();
      const ghostLine = console_text().split('\\n').map((l) => l.trim()).filter((l) => /^image ghost/.test(l)).slice(-1)[0] ?? '';
      input.value = 'image layout single'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(600); await console_settled();
      const back = image.querySelector('.pane-mode').textContent;
      return { after, ghostLine, back };`);
    check('image layout slab renders a vtk scene and reads its slice on the bar', slab.mode === 'SLAB' && /^SLAB . z \d+ \/ \d+/.test(slab.state) && slab.hasCanvas && slab.canvasFits && slab.layoutLit, JSON.stringify(slab));
    check('SLAB offers zoom and pan and marks the slice tools unavailable', slab.pills.zoom !== 'na' && slab.pills.pan !== 'na' && slab.pills.length === 'na' && slab.pills.probe === 'na' && slab.pills.wl === 'na', JSON.stringify(slab.pills));
    check('the wheel sweeps the SLAB slice and the ghost tunes', /^SLAB . z \d+/.test(swept.after) && swept.after !== slab.state && swept.ghostLine === 'image ghost 0.3', JSON.stringify(swept));
    check('SLAB returns to SINGLE', swept.back === '', JSON.stringify(swept));
  }
  }
  if (await stage('image-tags')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    const tags = await evalIn(`
      await console_idle();
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      await run('image layout single');
      await run('image slice 2');
      await run('image tags');
      let pane = null;
      for (let i = 0; i < 60; i++) { await sleep(500); pane = document.querySelector('.pane-tags'); if (pane && pane.querySelectorAll('.tags-row').length > 0) break; }
      if (!pane) return { error: 'no tags pane' };
      const groups = [...pane.querySelectorAll('.tags-group-row .tags-group-name')].map((e) => e.textContent);
      const rowOf = (name) => [...pane.querySelectorAll('.tags-row')].find((r) => r.querySelector('.tags-name')?.textContent === name);
      const instance = () => rowOf('InstanceNumber')?.querySelector('.tags-value')?.textContent ?? null;
      const before = instance();
      const phiBefore = rowOf('PatientName')?.querySelector('.tags-value')?.textContent ?? null;
      const redactBlock = pane.querySelector('.tags-redact').textContent;
      const state = pane.querySelector('.pane-state').textContent;
      // The image pane moves; the tags pane follows.
      await run('image slice 5');
      let after = before;
      for (let i = 0; i < 40 && after === before; i++) { await sleep(150); after = instance(); }
      // REDACT off reveals; on hides again.
      await run('tags redact off');
      await sleep(300);
      const phiRevealed = rowOf('PatientName')?.querySelector('.tags-value')?.textContent ?? null;
      await run('tags redact on');
      await sleep(300);
      const phiHidden = rowOf('PatientName')?.querySelector('.tags-value')?.textContent ?? null;
      // The filter narrows, and descends into a sequence.
      await run('tags filter Position');
      await sleep(400);
      const filtered = [...pane.querySelectorAll('.tags-row')].filter((r) => r.getBoundingClientRect().height > 0).map((r) => r.querySelector('.tags-name')?.textContent);
      await run('tags filter ReferencedSOPClass');
      await sleep(400);
      const deep = [...pane.querySelectorAll('.tags-row')].filter((r) => r.getBoundingClientRect().height > 0).map((r) => r.querySelector('.tags-name')?.textContent);
      await run('tags filter off');
      await sleep(300);
      const hue = pane.dataset.modality;
      const sameGroup = pane.closest('.layout-leaf') !== null;
      return { groups, before, after, phiBefore, phiRevealed, phiHidden, redactBlock, state, filtered, deep, hue, sameGroup };`);
    check('image tags opens a tags pane beside the image pane with module groups', tags.error === undefined && tags.groups.includes('PATIENT') && tags.groups.includes('IMAGE') && tags.sameGroup, JSON.stringify(tags));
    check("the tags pane follows the image pane's slice", tags.before === '2' && tags.after === '5', JSON.stringify(tags));
    check('identifying values show redacted until REDACT says otherwise', tags.phiBefore === '••••' && tags.phiRevealed !== '••••' && tags.phiRevealed !== null && tags.phiHidden === '••••' && /REDACT ON/.test(tags.redactBlock) && /REDACTED/.test(tags.state), JSON.stringify(tags));
    check('the tags filter narrows the listing and descends into sequences', Array.isArray(tags.filtered) && tags.filtered.includes('ImagePositionPatient') && !tags.filtered.includes('PatientName') && tags.deep.includes('ReferencedImageSequence'), JSON.stringify(tags));
    check("the tags pane wears the slice's modality as its hue", tags.hue === 'MR', JSON.stringify(tags));
  }
  }
  if (await stage('image-guard')) {
  if (dicomSeries === '' || !(await evalIn(`return document.querySelector('.pane-image') !== null;`))) {
    console.log('  skipped: needs the image pane from image-pane');
  } else {
    const guard = await evalIn(`
      await console_idle();
      const image = document.querySelector('.pane-image');
      const input = console_input();
      const run = async (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300); await console_settled(); };
      // The series shown afresh: LOAD is consent for one showing of a series,
      // and an earlier scenario may already have given it for this one.
      await run('image ${dicomSeries}');
      for (let i = 0; i < 60 && !/SERIES/.test(image.querySelector('.pane-state')?.textContent ?? ''); i++) await sleep(250);
      await run('image layout single');
      for (let i = 0; i < 40 && !image.querySelector('.image-viewport-stack'); i++) await sleep(150);
      const fetches = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/vfs?')).length;
      await run('image guard 1000');
      const before = fetches();
      await run('image layout mpr');
      await sleep(1500);
      const state = image.querySelector('.pane-state').textContent;
      const mode = image.querySelector('.pane-mode').textContent;
      const loadShown = !image.querySelector('.image-load').hidden;
      const during = fetches();
      await run('image load');
      let planes = 0;
      for (let i = 0; i < 80; i++) { await sleep(250); planes = image.querySelectorAll('.image-mpr .image-viewport').length; if (planes === 3 && image.querySelector('.pane-mode').textContent === 'MPR') break; }
      const loadHidden = image.querySelector('.image-load').hidden;
      await run('image guard off');
      await run('image layout single');
      await sleep(1500);
      return { state, mode, loadShown, fetched: during - before, planes, loadHidden };`);
    check('a volume layout over the guard waits for LOAD and fetches nothing', /^SERIES .* · LOAD FOR MPR$/.test(guard.state ?? '') && guard.mode === '' && guard.loadShown === true && guard.fetched === 0, JSON.stringify(guard));
    check('LOAD consents and the waiting layout follows', guard.planes === 3 && guard.loadHidden === true, JSON.stringify(guard));
  }
  }
  if (await stage('image-volume')) {
  if (niftiPath === '') {
    console.log('  skipped: set SMOKE_NIFTI=<volume path on the daemon>');
  } else {
    const volume = await evalIn(`
      await console_idle();
      const input = console_input();
      input.value = 'image ${niftiPath}';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      let image = null; let drawn = false;
      for (let i = 0; i < 120; i++) { await sleep(500); drawn = console_text().includes('drawn in'); image = [...document.querySelectorAll('.pane-image')].find((p) => p.dataset.modality === 'NIFTI'); if (drawn && image) break; }
      if (!image) return { error: 'no NIFTI pane' };
      const canvas = image.querySelector('.image-canvas');
      const field = image.querySelector('.image-field').getBoundingClientRect();
      const c = canvas ? canvas.getBoundingClientRect() : null;
      return { drawn, fits: c !== null && Math.abs(c.width - field.width) < 4, state: image.querySelector('.pane-state').textContent };`);
    check('image <volume> opens a NIfTI on the same pane kind and says when it drew', volume.error === undefined && volume.drawn === true && volume.fits === true, JSON.stringify(volume));
  }
  }
  if (await stage('image-panes')) {
  if (dicomSeries === '') {
    console.log('  skipped: set SMOKE_DICOM_SERIES=<series folder on the daemon>');
  } else {
    // A group moved away from waits in PANES-06, not lost. The regression this
    // guards: navigating to another domain disposed the PANES pane itself, so
    // the card grid came up empty after a domain switch (the pane was gone).
    const panes = await evalIn(`
      await console_idle();
      const run = async (line) => { const i = console_input(); i.value = line; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(400); await console_settled(); };
      // The desktop is opened in the FILES domain (the restore check below
      // reads it back); a stage an earlier scenario left elsewhere would be
      // captured as that domain instead.
      document.getElementById('gutter-files').click(); await sleep(600);
      await run('image ${dicomSeries}');
      let viewer = null;
      for (let i = 0; i < 160; i++) { await sleep(300); viewer = [...document.querySelectorAll('.pane-image')].find((p) => /SLICE \\d+ OF \\d+/.test(p.querySelector('.pane-state')?.textContent || '')); if (viewer) break; }
      if (!viewer) return { error: 'no viewer to set aside' };
      // Move away to RUNS, then to PANES: the viewer's group must be a card.
      document.getElementById('gutter-runs').click(); await sleep(1000);
      const dormantAfterAway = (window.__argusDormant?.list?.() ?? []).length;
      document.getElementById('gutter-panes').click(); await sleep(800);
      const pane = document.querySelector('.pane-panes');
      const cards = document.querySelectorAll('.panes-card');
      const card = cards[0] ?? null;
      return { dormantAfterAway, paneShown: pane !== null && pane.offsetParent !== null, cards: cards.length, label: card?.querySelector('.panes-card-label')?.textContent ?? null };`);
    check('a group moved away from is a card in PANES, after a domain switch', panes.error === undefined && panes.paneShown === true && panes.cards >= 1, JSON.stringify(panes));
    // Bring it back: pressing the card restores the viewer onto the stage.
    const restored = await evalIn(`
      const card = document.querySelector('.panes-card'); if (!card) return { error: 'no card to press' };
      card.click();
      let viewer = null;
      for (let i = 0; i < 160; i++) { await sleep(300); viewer = [...document.querySelectorAll('.pane-image')].find((p) => /SLICE \\d+ OF \\d+/.test(p.querySelector('.pane-state')?.textContent || '')); if (viewer) break; }
      await sleep(500);
      // The domain the viewer lived in comes back beside it, not a stray home:
      // the desktop was opened in the FILES domain, so a files pane is on stage.
      const domainBack = document.querySelector('.pane-files') !== null;
      return { restored: viewer !== null, domainBack, state: viewer?.querySelector('.pane-state')?.textContent ?? null };`);
    check('pressing the card restores the group onto the stage', restored.error === undefined && restored.restored === true, JSON.stringify(restored));
    check('the restored desktop brings its domain back beside the viewer', restored.domainBack === true, JSON.stringify(restored));
  }
  }
} catch (error) {
  // A crash is a red like any other: it is named with the scenario it
  // happened in, and the summary still prints. The first nightly ended
  // with no summary at all — "no summary (crashed?)" in the ledger — and
  // the scenarios after the crash were never run, which this says too.
  check(`${stageName ?? 'boot'} crashed, and the scenarios after it did not run`, false, error.message.split('\n')[0]);
} finally {
  if (stageName !== null) await stage_leaks(stageName).catch(() => undefined);
  // The suite's own fixtures go, whatever failed: a crash once left two
  // feeds and an upload folder behind on the operator's CUBE.
  try {
    if (fixtureFeed !== null) {
      await evalIn(`
        await console_idle();
        const input = console_input();
        input.value = 'feed rm -f ${fixtureFeed}'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        for (let i = 0; i < 40; i++) { await sleep(250); if (console_text().includes('removed feed ${fixtureFeed}')) return; }`);
      console.log(`  fixtures: removed feed ${fixtureFeed}`);
    }
    if (fixtureFolder !== null) {
      // The identity's CFS is left as it was found.
      await evalIn(`
        await console_idle();
        const input = console_input();
        input.value = 'rm -r ${fixtureFolder}'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        for (let i = 0; i < 40; i++) { await sleep(250); if (console_text().includes('Removed dir: ${fixtureFolder}')) return; }`);
      console.log(`  fixtures: removed ${fixtureFolder}`);
    }
  } catch (error) {
    console.log(`  fixtures: cleanup failed (${error.message}); feed ${fixtureFeed ?? '-'} and ${fixtureFolder ?? '-'} may remain`);
  }
  if (cohortKept !== null && cohortKept.body !== null) {
    try {
      const back = await fetch(`${cohortKept.origin}/vfs?path=${encodeURIComponent(cohortKept.path)}&token=${encodeURIComponent(cohortKept.token)}`, { method: 'POST', body: cohortKept.body });
      console.log(back.ok ? `  cohort: ${cohortKept.path} restored` : `  cohort: restore answered HTTP ${back.status}; ${cohortKept.path} may differ from how it was found`);
    } catch (error) {
      console.log(`  cohort: restore failed (${error.message}); ${cohortKept.path} may differ from how it was found`);
    }
  }
  stage_close();
  page.close();
}

// The three slowest scenarios, named. A suite this expensive should say
// where its minutes went rather than leaving it to be guessed at.
const slowest = [...timings].sort((a, b) => b[1] - a[1]).slice(0, 3);
const spent = timings.reduce((total, [, ms]) => total + ms, 0);
console.log(`\n${Math.round(spent / 1000)}s in ${timings.length} scenario(s)`
  + ` — slowest: ${slowest.map(([name, ms]) => `${name} ${Math.round(ms / 1000)}s`).join(', ')}`);
console.log(`\n${passes} ok, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
