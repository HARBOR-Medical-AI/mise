/**
 * stratus boots and runs with no ChRIS package loaded.
 *
 * Boots `@fnndsc/brasa/core` over the stratus backend and the fake cloud in
 * plain Node, with a resolve hook that refuses cumin, salsa and chili, and
 * walks the tenancy tree: the mount, the tenancy, its compartments, a nested
 * one, `info.json`, the regions with their zones, limits, shapes and prices,
 * and the duplicate-name rule. Exits 1 when any line answers otherwise, or
 * when anything asked for a ChRIS package, caught or not.
 *
 * Run after the build: `npm run test:boot --workspace @fnndsc/stratus`.
 */
import { register } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'stratus-boot-'));
process.env.CORE_BOOT_LOADS = join(scratch, 'chris-loads.txt');
register(new URL('./stratusBoot.hook.mjs', import.meta.url));

const { engine_create } = await import('@fnndsc/brasa/core');
const { stratusBackend_make, FakeDriver, fakeCloud_sample, ClusterStore } = await import('../dist/index.js');

const cloud = fakeCloud_sample('fnndsc');
// A second compartment named like the first, so the duplicate rule is exercised.
const twin = { ...cloud.containers[2], id: 'ocid1.compartment.oc1..twin00', description: 'the other sandbox' };
const made = stratusBackend_make({
  driver: new FakeDriver({ ...cloud, containers: [...cloud.containers, twin] }),
  configDir: join(scratch, 'config'),
  store: new ClusterStore(join(scratch, 'clusters')),
});
const engine = await engine_create(made.backend);
engine.sink_install({ data_write: () => undefined, err_write: () => undefined, progress_write: () => undefined });

/** Each line, the status it answers with, and what its output holds (and must not). */
const CHECKS = [
  { line: 'pwd', ok: true, has: ['/net/oci/fnndsc/clusters'] },
  { line: 'ls /', ok: true, has: ['net'] },
  { line: 'ls /net', ok: true, has: ['oci'] },
  { line: 'ls /net/oci', ok: true, has: ['fnndsc'] },
  { line: 'cd /net/oci/fnndsc', ok: true },
  { line: 'ls', ok: true, has: ['harbor-oci', 'sandbox~andbox', 'sandbox~twin00', 'regions', 'clusters', 'info.json'], hasNot: ['scratch-a'] },
  { line: 'ls -l', ok: true, has: ['harbor-oci', 'active'] },
  { line: 'cat info.json', ok: true, has: ['"name": "fnndsc"'] },
  { line: 'cat harbor-oci/info.json', ok: true, has: ['"name": "harbor-oci"'] },
  { line: 'ls sandbox', ok: false, has: ['ambiguous', 'sandbox~andbox', 'sandbox~twin00'] },
  { line: 'ls sandbox~andbox', ok: true, has: ['scratch-a'] },
  { line: 'cd sandbox~andbox/scratch-a', ok: true },
  { line: 'pwd', ok: true, has: ['/net/oci/fnndsc/sandbox~andbox/scratch-a'] },
  { line: 'cd ~', ok: true },
  { line: 'pwd', ok: true, has: ['/net/oci/fnndsc/clusters'] },
  { line: 'ls ../regions', ok: true, has: ['us-ashburn-1'] },
  { line: 'ls ../regions/us-ashburn-1', ok: true, has: ['zones', 'limits', 'shapes', 'prices'] },
  { line: 'ls ../regions/us-ashburn-1/zones', ok: true, has: ['Uocm:US-ASHBURN-AD-1', 'Uocm:US-ASHBURN-AD-3'] },
  { line: 'ls ../regions/us-ashburn-1/limits', ok: true, has: ['compute', 'load-balancer', 'vcn'] },
  { line: 'ls ../regions/us-ashburn-1/limits/compute', ok: true, has: ['standard-e5-core-count'] },
  { line: 'ls ../regions/us-ashburn-1/limits/compute/standard-e5-core-count', ok: true, has: ['Uocm:US-ASHBURN-AD-1'] },
  { line: 'cat ../regions/us-ashburn-1/limits/compute/standard-e5-core-count/Uocm:US-ASHBURN-AD-1/value', ok: true, has: ['9250'] },
  { line: 'cat ../regions/us-ashburn-1/limits/compute/standard-e5-core-count/Uocm:US-ASHBURN-AD-1/available', ok: true, has: ['9238'] },
  { line: 'ls ../regions/us-ashburn-1/limits/load-balancer/lb-flexible-count', ok: true, has: ['value', 'used', 'available'] },
  { line: 'cat ../regions/us-ashburn-1/limits/load-balancer/lb-flexible-count/used', ok: true, has: ['3'] },
  { line: 'ls ../regions/us-ashburn-1/shapes', ok: true, has: ['VM.Standard.E5.Flex', 'VM.Standard.A2.Flex'] },
  { line: 'cat ../regions/us-ashburn-1/shapes/VM.Standard.E5.Flex/family', ok: true, has: ['E5'] },
  { line: 'cat ../regions/us-ashburn-1/shapes/VM.Standard.E5.Flex/vcpus', ok: true, has: ['1-94'] },
  { line: 'cat ../regions/us-ashburn-1/prices/VM.Standard.E5.Flex/vcpuHour', ok: true, has: ['0.015'] },
  { line: 'cat ../regions/us-ashburn-1/shapes/VM.Standard.E5.Flex/family | wc -l', ok: true, has: ['1'] },
  { line: 'ls ../regions/eu-nowhere-1', ok: false, has: ['No such file or directory'] },
  { line: 'cat ../regions', ok: false, has: ['Is a directory'] },
  { line: 'touch ../regions/x', ok: false },
  { line: 'cluster new trial --base-domain fake.example --workers 2x8/32', ok: true, has: ['spec written', 'workers 2 × 8 vCPU 32 GiB'] },
  { line: 'ls ~/trial', ok: true, has: ['spec.yaml', 'state.json', 'steps', 'auth'] },
  { line: 'cluster plan trial', ok: true, has: ['8 of 9238 cores', 'an hour', 'needs the tasks tier'] },
  { line: 'cluster build trial', ok: false, has: ['build steps are not written yet'] },
  { line: 'kill trial-build', ok: false, has: ['no such task'] },
  { line: 'ls /proc/steps', ok: true },
  { line: 'ls /usr/bin', ok: true, has: ['ls', 'cat'], hasNot: ['feed', 'plugin', 'pacs'] },
  { line: 'help', ok: true, has: ['ls', 'cat'], hasNot: ['feed', 'plugin', 'pacs'] },
  { line: 'nosuch', ok: false, has: ['command not found: nosuch'] },
];

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
let failed = 0;
for (const check of CHECKS) {
  const envelopes = await engine.line_execute(check.line);
  const ok = envelopes.length > 0 && envelopes.every((envelope) => envelope.status === 'ok');
  const said = strip(envelopes.map((envelope) => `${envelope.rendered}${envelope.renderedErr ?? ''}`).join(''));
  const wrong = [];
  if (ok !== check.ok) wrong.push(`answered ${ok ? 'ok' : 'error'}`);
  for (const text of check.has ?? []) if (!said.includes(text)) wrong.push(`lacks ${JSON.stringify(text)}`);
  for (const text of check.hasNot ?? []) if (new RegExp(`\\b${text}\\b`).test(said)) wrong.push(`holds ${JSON.stringify(text)}`);
  console.log(`${wrong.length === 0 ? 'ok  ' : 'FAIL'}  ${check.line}${wrong.length ? ` — ${wrong.join('; ')}` : ''}`);
  if (wrong.length) failed++;
}

const identity = await made.backend.session.identity_get();
if (identity.user !== 'rudolph' || identity.where !== 'fnndsc' || !identity.connected) {
  console.log(`FAIL  identity: ${JSON.stringify(identity)}`);
  failed++;
} else {
  console.log('ok    identity rudolph@fnndsc, connected');
}

if (existsSync(process.env.CORE_BOOT_LOADS)) {
  console.error(`FAIL  a ChRIS package was asked for:\n${readFileSync(process.env.CORE_BOOT_LOADS, 'utf8')}`);
  failed++;
}
if (failed > 0) {
  console.error(`stratus boot: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`stratus boot: ${CHECKS.length + 1} checks ok, no ChRIS package loaded`);
process.exit(0);
