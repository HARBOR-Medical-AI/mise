/**
 * The core boots and runs with no ChRIS package loaded.
 *
 * Boots `@fnndsc/brasa/core` over the null backend in plain Node, with a
 * resolve hook that refuses cumin, salsa and chili, and runs the core shell:
 * navigation, the file tools, pipes, redirection to this host's disk, help.
 * Exits 1 when any line answers otherwise, or when anything asked for a
 * ChRIS package, caught or not.
 *
 * Run after the build: `npm run test:core-boot --workspace @fnndsc/brasa`.
 */
import { register } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'core-boot-'));
process.env.CORE_BOOT_LOADS = join(scratch, 'chris-loads.txt');
register(new URL('./coreBoot.hook.mjs', import.meta.url));

const { engine_create, nullBackend_make, surface_set, HeadlessSurface } = await import('../dist/core.js');
// A backend's long-running steps, as an infrastructure backend would bring them.
const apply = { id: 'apply', label: 'Apply', state: 'running', progress: { current: 3, total: 10, unit: 'nodes' } };
const steps = {
  id: 'steps', label: 'install steps',
  list: async () => [{ id: 'plan', label: 'Plan', state: 'done', logTail: 'planned\n' }, { ...apply }],
};
const engine = await engine_create(nullBackend_make({
  seed: { '/home/user/hello.txt': 'hello\nworld\n', '/home/user/docs/a.txt': 'alpha' },
  tasks: [steps],
}));
// What a line says on its error channel outside its envelope (a refused redirection does), kept per line.
const errSaid = [];
engine.sink_install({ data_write: () => undefined, err_write: (text) => { errSaid.push(String(text)); }, progress_write: () => undefined });

/** A surface that says whose the engine's disk is: its operator's, or nobody's. */
function surface_make(operators) {
  const surface = new HeadlessSurface();
  Object.assign(surface.capabilities, { engineFilesystem: operators });
  return surface;
}
// Whoever runs this script sits at the disk it runs on, as at a local shell:
// redirection and a manifest beside the engine are theirs to use.
surface_set(surface_make(true));

const redirected = join(scratch, 'out.txt');
// A manifest on the engine's disk: play and expect are the core's, so a
// session with no ChRIS in it plays one and makes claims about its paths.
const manifest = join(scratch, 'core.mise');
writeFileSync(manifest, '@param WHERE = hello.txt\n@answers L\nL=$(ls)\nexpect path ${WHERE} exists\n');
/** Each line, the status it answers with, and what its output holds (and must not). */
const CHECKS = [
  { line: 'pwd', ok: true, has: ['/home/user'] },
  { line: 'ls', ok: true, has: ['hello.txt', 'docs'] },
  { line: 'cd docs', ok: true },
  { line: 'pwd', ok: true, has: ['/home/user/docs'] },
  { line: 'cat a.txt', ok: true, has: ['alpha'] },
  { line: 'cd ~', ok: true },
  { line: 'cat hello.txt | tac', ok: true, has: ['world\nhello'] },
  { line: `cat hello.txt > ${redirected}`, ok: true },
  { line: 'mkdir -p new/deeper', ok: true },
  { line: 'touch --withContents fresh new/deeper/f.txt', ok: true },
  { line: 'cp new/deeper/f.txt copy.txt', ok: true },
  { line: 'mv copy.txt moved.txt', ok: true },
  { line: 'cat moved.txt', ok: true, has: ['fresh'] },
  { line: 'rm moved.txt', ok: true },
  { line: 'rm -r new', ok: true },
  { line: 'ls', ok: true, has: ['hello.txt'], hasNot: ['moved.txt', 'new'] },
  { line: 'cat docs', ok: false, has: ['Is a directory'] },
  { line: 'ls /usr', ok: true, has: ['bin', 'games', 'share'] },
  { line: 'help', ok: true, has: ['ls', 'cat', 'Games', 'help <Section>'], hasNot: ['feed', 'plugin', 'pacs', 'connect'] },
  { line: 'help feed', ok: true, has: ["No help available for 'feed'"] },
  { line: 'ls /usr/bin', ok: true, has: ['ls', 'cat', 'help'], hasNot: ['feed', 'plugin', 'pacs', 'upload'] },
  { line: 'ls /proc/steps', ok: true, has: ['plan', 'apply'] },
  { line: 'cat /proc/steps/apply/progress', ok: true, has: ['3/10 nodes'] },
  { line: 'cat /proc/steps/plan/log', ok: true, has: ['planned'] },
  { line: 'expect path hello.txt exists', ok: true, has: ['✓ path hello.txt exists'] },
  { line: 'expect gather size eq 1', ok: false, has: ['expect knows nothing about "gather" in this session — try path'] },
  { line: `play ${manifest}`, ok: true, has: ['played 2 lines', 'answering L'] },
  { line: 'A=$(ls)', ok: true },
  { line: 'fortune', ok: true },
  { line: 'nosuch', ok: false, has: ['command not found: nosuch'] },
];

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
let failed = 0;
/** Runs lines and says how each answered against what it should. */
async function checks_run(checks) {
  for (const check of checks) {
    errSaid.length = 0;
    const envelopes = await engine.line_execute(check.line);
    const ok = envelopes.length > 0 && envelopes.every((envelope) => envelope.status === 'ok');
    const said = strip(envelopes.map((envelope) => `${envelope.rendered}${envelope.renderedErr ?? ''}`).join('') + errSaid.join(''));
    const wrong = [];
    if (ok !== check.ok) wrong.push(`answered ${ok ? 'ok' : 'error'}`);
    for (const text of check.has ?? []) if (!said.includes(text)) wrong.push(`lacks ${JSON.stringify(text)}`);
    for (const text of check.hasNot ?? []) if (new RegExp(`\\b${text}\\b`).test(said)) wrong.push(`holds ${JSON.stringify(text)}`);
    console.log(`${wrong.length === 0 ? 'ok  ' : 'FAIL'}  ${check.line}${wrong.length ? ` — ${wrong.join('; ')}` : ''}`);
    if (wrong.length) failed++;
  }
}
await checks_run(CHECKS);

// The same engine attended from elsewhere: its disk is nobody's (host control
// without the files tier). What reads or writes that disk is refused by name,
// and a refused line did nothing.
const refusedWrite = join(scratch, 'refused.txt');
const NOBODYS = "the session's host disk is nobody's; start the session with --host-control=files";
const OFF_CHECKS = [
  { line: `cat hello.txt > ${refusedWrite}`, ok: false, has: ['redirect (>', NOBODYS] },
  { line: `cat hello.txt >> ${refusedWrite}`, ok: false, has: ['redirect (>>', NOBODYS] },
  { line: `play ${manifest}`, ok: false, has: ['is not in the session\'s filesystem', 'beside the engine it was not looked for', NOBODYS] },
  { line: `touch --withContentsFromFile ${manifest} from-host.txt`, ok: false, has: [NOBODYS] },
  { line: 'cat hello.txt | tac', ok: true, has: ['world\nhello'] },
  { line: 'ls', ok: true, has: ['hello.txt'], hasNot: ['from-host.txt'] },
];
surface_set(surface_make(false));
await checks_run(OFF_CHECKS);
surface_set(surface_make(true));
if (existsSync(refusedWrite)) {
  console.log('FAIL  a refused redirection wrote this host\'s file');
  failed++;
}

// A task any surface can watch: live while it runs, settled when it is over.
const heard = [];
engine.ambient_listen((event) => { if (event.kind === 'watched') heard.push(`${event.subject}:${event.state}`); });
const watching = engine.watch_set('/proc/steps/apply', 'core-boot', true);
apply.state = 'done';
for (let waited = 0; waited < 10000 && !heard.includes('/proc/steps/apply:settled'); waited += 250) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const watched = watching === 'live' && heard.includes('/proc/steps/apply:settled');
console.log(`${watched ? 'ok  ' : 'FAIL'}  watch /proc/steps/apply${watched ? '' : ` — answered ${watching}, heard ${JSON.stringify(heard)}`}`);
if (!watched) failed++;

if (!existsSync(redirected) || readFileSync(redirected, 'utf-8') !== 'hello\nworld\n') {
  console.log('FAIL  redirection wrote this host\'s file');
  failed++;
}
const loads = existsSync(process.env.CORE_BOOT_LOADS) ? readFileSync(process.env.CORE_BOOT_LOADS, 'utf-8') : '';
if (loads !== '') {
  console.log(`FAIL  ChRIS packages were asked for:\n${loads}`);
  failed++;
}
console.log(failed === 0 ? `core boot: ${CHECKS.length + OFF_CHECKS.length} lines, no ChRIS package loaded` : `core boot: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
