/**
 * @file ChRIS on a cluster: deploy (mirror, project, pin, helm,
 * rollouts), seed (secret, job, summary) and smoke (uv, then the journey)
 * over a scripted cluster and host, and the 429 a settling API answers.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KubeError, type KubeApi } from '../src/kube/kube.js';
import { busyWait_parse } from '../src/kube/kubeHttp.js';
import { CHRIS_RELEASE, CHRIS_VALUES, chrisomaticConfig_render, smokeVerdict_words, chrisWork_cluster, helmInstall_args, rollout_done, TEST_PASSWORD_FILE, type ChrisCall, type HostResult, type HostRunOptions } from '../src/kube/chris.js';
import { SPEC_DEFAULT } from '../src/cluster/spec.js';

/** A cluster that answers from a table of paths, keeping what is made and deleted. */
class ScriptedKube implements KubeApi {
  readonly made: Array<{ path: string; body: unknown }> = [];
  readonly deleted: string[] = [];
  constructor(private readonly answers: Record<string, () => unknown>) {}
  async json_get(path: string): Promise<unknown> {
    const answer = this.answers[path];
    if (answer === undefined) throw new KubeError(404, `GET ${path}: HTTP 404`);
    return answer();
  }
  async text_get(path: string): Promise<string> {
    return String(await this.json_get(path));
  }
  async json_post(path: string, body: unknown): Promise<unknown> {
    this.made.push({ path, body });
    return body;
  }
  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    throw new KubeError(404, `DELETE ${path}: HTTP 404`);
  }
}

const b64 = (text: string): string => Buffer.from(text).toString('base64');
const NODES = {
  items: ['a', 'b', 'c'].map((name: string) => ({
    metadata: { name: `quay-cp-${name}`, labels: { 'kubernetes.io/hostname': `quay-cp-${name}` } },
    status: { allocatable: { cpu: '8' } },
  })),
};
const PODS = { items: [{ spec: { nodeName: 'quay-cp-a', containers: [{ resources: { requests: { cpu: '6' } } }] }, status: { phase: 'Running' } }, { spec: { nodeName: 'quay-cp-c', containers: [{ resources: { requests: { cpu: '3' } } }] }, status: { phase: 'Running' } }] };
const ROLLED = (): unknown => ({ metadata: { generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1 } });

describe('ChRIS on a cluster', () => {
  let root: string;
  let secrets: Map<string, string>;
  let ran: Array<{ command: string; args: ReadonlyArray<string>; env?: Record<string, string> }>;
  let answers: Map<string, HostResult>;
  let log: string[];

  const call_make = (kube: KubeApi): ChrisCall => ({
    kube,
    host: async (command: string, args: ReadonlyArray<string>, options?: HostRunOptions): Promise<HostResult> => {
      ran.push({ command, args, ...(options?.env !== undefined ? { env: options.env } : {}) });
      // uv makes the virtualenv's python.
      if (command === 'uv' && args[0] === 'venv') { mkdirSync(join(String(args[3]), 'bin'), { recursive: true }); writeFileSync(join(String(args[3]), 'bin', 'python'), ''); }
      const answer: HostResult = answers.get(command) ?? { code: 0, stdout: '', stderr: '' };
      for (const line of answer.stdout.split('\n')) if (line !== '') options?.line?.(line);
      return answer;
    },
    kubeconfigPath: '/host/quay/auth/kubeconfig',
    folder: root,
    cubeHost: 'cube.apps.quay.oci.example.org',
    spec: SPEC_DEFAULT,
    release: CHRIS_RELEASE,
    waits: { pollMs: 0, mirrorReactMs: 0, mirrorWaitMs: 1000, rolloutWaitMs: 1000, seedWaitMs: 1000 },
    secret_read: (file: string): string | null => secrets.get(file) ?? null,
    secret_write: (file: string, text: string): void => { secrets.set(file, text); },
    secret_path: (file: string): string => `/host/quay/auth/${file}`,
    log: (line: string): void => { log.push(line); },
    signal: new AbortController().signal,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-chris-'));
    secrets = new Map();
    ran = [];
    answers = new Map();
    log = [];
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('deploys: the mirror and project made, pinned to the freest node, the chart installed, every workload waited on', async () => {
    let pool: number = 0;
    const apps: string = '/apis/apps/v1/namespaces/chris';
    const kube: ScriptedKube = new ScriptedKube({
      '/apis/machineconfiguration.openshift.io/v1/machineconfigpools/master': () => ({ status: { conditions: [{ type: 'Updating', status: pool++ === 0 ? 'True' : 'False' }] } }),
      '/api/v1/nodes': () => NODES,
      '/api/v1/pods': () => PODS,
      ...Object.fromEntries(['heart', 'server', 'worker-mains', 'worker-periodic'].map((name: string) => [`${apps}/deployments/chris-${name}`, ROLLED])),
      ...Object.fromEntries(['postgresql', 'rabbitmq', 'nats'].map((name: string) => [`${apps}/statefulsets/chris-${name}`, ROLLED])),
    });
    // pfcon is read twice: for a pin (none yet), then for its rollout.
    let pfconReads: number = 0;
    const pfcon = (): unknown => { if (pfconReads++ === 0) throw new KubeError(404, 'none'); return ROLLED(); };
    (kube as unknown as { answers: Record<string, () => unknown> }).answers[`${apps}/deployments/chris-pfcon`] = pfcon;
    const note: string = await chrisWork_cluster.deploy(call_make(kube));
    expect(note).toBe('fnndsc/chris 1.0.8 at https://cube.apps.quay.oci.example.org/api/v1/, pinned to quay-cp-b');
    expect(kube.made.map((entry) => entry.path)).toEqual(['/apis/config.openshift.io/v1/imagetagmirrorsets', '/apis/project.openshift.io/v1/projectrequests']);
    expect(ran.map((entry) => entry.args[0])).toEqual(['repo', '--kubeconfig=/host/quay/auth/kubeconfig']);
    expect(log).toContain('the nodes are taking the mirror, one at a time');
    expect(log).toContain('chris-pfcon rolled out');
    expect(log.some((line: string): boolean => line.startsWith('pin chosen by unrequested CPU: quay-cp-a 2.0, quay-cp-b 8.0, quay-cp-c 5.0'))).toBe(true);
  });

  it('keeps a pin a deploy already made, and builds helm\'s arguments from the spec', async () => {
    const args: string[] = helmInstall_args({ kubeconfigPath: '/k', release: CHRIS_RELEASE, cubeHost: 'cube.apps.quay.x', spec: SPEC_DEFAULT }, 'quay-cp-c');
    expect(args).toEqual([
      '--kubeconfig=/k', 'upgrade', '--install', 'chris', 'fnndsc/chris', '--version', '1.0.8', '--namespace', 'chris', '--values', CHRIS_VALUES,
      '--set-string', 'route.host=cube.apps.quay.x',
      '--set-string', 'pfcon.nodeSelector.kubernetes\\.io/hostname=quay-cp-c',
      '--set-string', 'pfcon.pman.extraEnv.NODE_SELECTOR=kubernetes.io/hostname=quay-cp-c',
      '--set-string', 'pfcon.storage.size=20Gi', '--set-string', 'postgresql.primary.persistence.size=5Gi', '--set-string', 'rabbitmq.persistence.size=1Gi',
    ]);
    expect(CHRIS_VALUES.endsWith('chris/values-openshift.yaml')).toBe(true);
    expect(rollout_done(null)).toBe(false);
    expect(rollout_done({ metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1 } })).toBe(false);
    expect(rollout_done(ROLLED() as never)).toBe(true);
  });

  it('seeds through chrisomatic in a job, its config in a secret, and says the summary', async () => {
    const kube: ScriptedKube = new ScriptedKube({
      '/api/v1/namespaces/chris/secrets/chris-chris-backend': () => ({ data: { CHRIS_SUPERUSER_PASSWORD: b64('su"pw') } }),
      '/api/v1/namespaces/chris/secrets/chris-pfcon': () => ({ data: { PFCON_USER: b64('pfcon'), PFCON_PASSWORD: b64('pfpw') } }),
      '/apis/batch/v1/namespaces/chris/jobs/chris-seed': () => ({ status: { succeeded: 1 } }),
      [`/api/v1/namespaces/chris/pods?labelSelector=${encodeURIComponent('job-name=chris-seed')}`]: () => ({ items: [{ metadata: { name: 'chris-seed-x' } }] }),
      '/api/v1/namespaces/chris/pods/chris-seed-x/log?tailLines=60': () => 'working\n──── Summary: ────\n 3 created, 1 unchanged ──\n',
    });
    // The job is gone at once after its delete: the first read after it is the new one's.
    let jobReads: number = 0;
    (kube as unknown as { answers: Record<string, () => unknown> }).answers['/apis/batch/v1/namespaces/chris/jobs/chris-seed'] = () => { if (jobReads++ === 0) throw new KubeError(404, 'gone'); return { status: { succeeded: 1 } }; };
    const note: string = await chrisWork_cluster.seed(call_make(kube));
    expect(note).toBe('test user smoke, compute resource innetwork, pl-dircopy and pl-simpledsapp · 3 created, 1 unchanged');
    expect(secrets.get(TEST_PASSWORD_FILE)?.trim().length).toBeGreaterThan(20);
    const secret = kube.made.find((entry) => entry.path === '/api/v1/namespaces/chris/secrets')?.body as { stringData: Record<string, string> };
    expect(secret.stringData['chrisomatic.yml']).toContain('password: "su\\"pw"');
    expect(kube.made.map((entry) => entry.path)).toEqual(['/api/v1/namespaces/chris/secrets', '/apis/batch/v1/namespaces/chris/jobs']);
    expect(kube.deleted).toEqual(['/api/v1/namespaces/chris/secrets/chris-seed-config', '/apis/batch/v1/namespaces/chris/jobs/chris-seed?propagationPolicy=Background']);
    // A second seed keeps the password it made.
    const kept: string | undefined = secrets.get(TEST_PASSWORD_FILE);
    jobReads = 0;
    await chrisWork_cluster.seed(call_make(kube));
    expect(secrets.get(TEST_PASSWORD_FILE)).toBe(kept);
  });

  it('writes the chrisomatic config as YAML that quotes every value', () => {
    const text: string = chrisomaticConfig_render({ cubeUrl: 'http://s/api/v1/', superuserPassword: 'a: b', testUser: 'smoke', testPassword: 't#x', pfconUrl: 'http://p/', pfconUser: 'u', pfconPassword: 'p' });
    expect(text).toContain('    password: "a: b"');
    expect(text).toContain('      password: "t#x"');
    expect(text).toContain('    - name: "pl-simpledsapp"');
  });

  it('smokes: chris_smoke installed with uv once, then run with the CUBE, the user and the router\'s CA', async () => {
    const kube: ScriptedKube = new ScriptedKube({ '/api/v1/namespaces/openshift-ingress-operator/secrets/router-ca': () => ({ data: { 'tls.crt': b64('CA') } }) });
    await expect(chrisWork_cluster.smoke(call_make(kube))).rejects.toThrow('no test user yet');
    secrets.set(TEST_PASSWORD_FILE, 'pw\n');
    answers.set(join(root, 'smoke-venv', 'bin', 'python'), { code: 0, stdout: 'login ok\nfeed made\nPASS\n', stderr: '' });
    expect(await chrisWork_cluster.smoke(call_make(kube))).toBe('the smoke journey passes as smoke · PASS');
    expect(ran.map((entry) => `${entry.command.split('/').pop() ?? ''} ${entry.args[0] ?? ''}`)).toEqual(['uv venv', 'uv pip', 'python -m']);
    expect(ran[2]?.env).toEqual({ CUBE_URL: 'https://cube.apps.quay.oci.example.org/api/v1/', CHRIS_SMOKE_USER: 'smoke', CHRIS_SMOKE_PASSWORD_FILE: '/host/quay/auth/chris-test-password', SMOKE_CA_BUNDLE: '/host/quay/auth/router-ca.crt' });
    expect(secrets.get('router-ca.crt')).toBe('CA');
    expect(log).toContain('smoke: feed made');
    answers.set(join(root, 'smoke-venv', 'bin', 'python'), { code: 1, stdout: 'FAIL: plugin did not finish\n', stderr: '' });
    await expect(chrisWork_cluster.smoke(call_make(kube))).rejects.toThrow('the smoke journey found ChRIS broken: FAIL: plugin did not finish');
    // The second and third runs found the virtualenv made.
    expect(ran.filter((entry) => entry.command === 'uv')).toHaveLength(2);
  });

  it('says the journey\'s verdict in a few words', () => {
    expect(smokeVerdict_words('{"verdict": "pass", "exit_code": 0, "failed_step": null, "duration_s": 17.4, "steps": [{"name": "a", "ok": true}, {"name": "b", "ok": true}]}')).toBe('pass · 2 steps · 17 s');
    expect(smokeVerdict_words('{"verdict": "fail", "failed_step": "authenticate", "duration_s": 2, "steps": [{"name": "authenticate", "ok": false}]}')).toBe('fail · 1 step · failed at authenticate · 2 s');
    expect(smokeVerdict_words('PASS')).toBe('PASS');
  });

  it('waits as long as a 429 asks, within a second and ten', () => {
    expect(busyWait_parse('{"kind":"Status","code":429,"details":{"retryAfterSeconds":1}}')).toBe(1000);
    expect(busyWait_parse('{"details":{"retryAfterSeconds":60}}')).toBe(10_000);
    expect(busyWait_parse('not json')).toBe(2000);
  });
});
