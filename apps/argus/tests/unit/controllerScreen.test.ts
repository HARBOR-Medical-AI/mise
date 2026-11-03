/**
 * @jest-environment jsdom
 */
/**
 * @file The TD controller's screen: a pill per cluster and NEW, a pill that
 * sends its line, an event redrawing the condition and the title, the
 * engine's question answered on the strip by a pill or a typed name, the
 * lock and the refusals drawn, and COMMIT held until the name is a free DNS
 * label.
 */
import { describe, it, expect } from '@jest/globals';
import type { ClusterSizeModel, ClusterSpecModel, ClusterSummary } from '@fnndsc/menu';
import { TdController, type ControllerHooks } from '../../src/features/controller/screen.js';

const SPEC: ClusterSpecModel = {
  family: 'E5',
  controlPlane: { count: 3, vcpu: 8, ramGib: 24, bootGib: 200, bootTier: 'ultra' },
  workers: { count: 0, vcpu: 8, ramGib: 32, bootGib: 120, bootTier: 'balanced' },
  chris: { dataGib: 20, databaseGib: 5, queueGib: 1 },
};

const cluster_make = (name: string, extra: Partial<ClusterSummary> = {}): ClusterSummary => ({
  name, path: `/net/oci/fnndsc-bch/clusters/${name}`, cluster: `${name}.oci.example.org`, lastDone: null,
  steps: [{ folder: '01-infra-apply', state: 'not done', name: 'infra-apply', evidence: 'not run yet' }],
  resources: null, cost: null, condition: 'SIZING', billing: false, origin: 'built', protected: true,
  refused: { teardown: `protected (cluster protect ${name} off lifts it)` }, region: 'us-ashburn-1', compartment: null, gone: null,
  spec: SPEC, next: 'infra-apply', billingStep: 'infra-apply', running: null, plan: null, verify: null, asking: null,
  ...extra,
});

const SIZE: ClusterSizeModel = {
  region: 'us-ashburn-1', family: 'E5', families: ['E5'], vcpuPerCore: 2, cores: null, memoryGib: null,
  zones: [{ zone: 'AD-1', coresFree: 100, memoryFree: 1000 }], price: null, services: null, start: SPEC, baseDomain: 'oci.example.org',
};

/** A controller over hooks that record the lines sent. */
function controller_make(size: ClusterSizeModel = SIZE, manage: boolean | null = true, elevate: ((line: string) => Promise<boolean>) | null = null): { controller: TdController; sent: string[]; cues: string[]; hooks: ControllerHooks } {
  const sent: string[] = [];
  const cues: string[] = [];
  const hooks: ControllerHooks = {
    run: async (line: string): Promise<void> => { sent.push(line); },
    refresh: async (): Promise<void> => undefined,
    size_read: async (): Promise<ClusterSizeModel> => size,
    stop: (): void => { sent.push('<stop>'); },
    leave: (): void => { sent.push('<leave>'); },
    manage_is: (): boolean | null => manage,
    elevate_ask: elevate,
    voice: { pill: (): void => undefined, cue: (name: string): void => { cues.push(name); } },
  };
  const controller: TdController = new TdController(hooks);
  document.body.append(controller.root);
  return { controller, sent, cues, hooks };
}

const button_named = (root: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((button: HTMLButtonElement): boolean => (button.textContent ?? '').trim() === text);

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('the TD controller screen', () => {
  it('draws a pill per cluster and NEW, and a pill sends its line', async () => {
    const { controller, sent } = controller_make();
    controller.clusters_take([cluster_make('harbor', { origin: 'adopted', condition: 'UP', billing: true, refused: { build: 'adopted from ~/h', teardown: 'adopted, not built here' } }), cluster_make('quay')]);
    controller.cluster_choose('harbor');
    expect([...controller.root.querySelectorAll('.tdc-cluster')].map((pill) => pill.textContent)).toEqual(['HARBOR', 'QUAY', '+ NEW']);
    expect(controller.root.querySelector('.tdc-chip-class')?.textContent).toBe('ADOPTED · PLANS ONLY');
    expect(controller.root.querySelector('.tdc-condition-why')?.textContent).toBe('BILLING · ADOPTED');
    expect(document.title).toBe('UP · harbor');
    // An adopted cluster's BUILD is drawn and refused, never pressed.
    const build: HTMLButtonElement | undefined = button_named(controller.root, 'BUILD · REFUSED');
    expect(build?.disabled).toBe(true);
    button_named(controller.root, 'PLAN')?.click();
    await flush();
    expect(sent).toEqual(['cluster plan harbor']);
    button_named(controller.root, 'QUAY')?.click();
    await flush();
    expect(sent.at(-1)).toBe('cluster quay');
    expect(controller.cluster_get()?.name).toBe('quay');
    controller.dispose();
    controller.root.remove();
  });

  it('entered as READ, the header says so and BUILD, ADOPT and TEAR DOWN are held with the door as their reason; PLAN and VERIFY stand', async () => {
    const { controller } = controller_make(SIZE, false);
    controller.clusters_take([cluster_make('quay', { protected: false, refused: {} })]);
    controller.cluster_choose('quay');
    expect(controller.root.querySelector('.tdc-mode .tdc-condition-name')?.textContent).toBe('READ');
    const build: HTMLButtonElement | undefined = button_named(controller.root, 'BUILD · REFUSED');
    expect(build?.disabled).toBe(true);
    expect(build?.title).toContain('refused: entered as READ');
    expect(button_named(controller.root, 'PLAN')?.disabled).toBe(false);
    expect(button_named(controller.root, 'VERIFY')?.disabled).toBe(false);
    controller.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    expect(button_named(controller.root, 'TEAR DOWN · REFUSED')?.title).toContain('no door to check a password at');
    // A found cluster's ADOPT is held the same way, by the kernel's reason when it carries one.
    controller.clusters_take([cluster_make('harbor', { origin: 'found', condition: 'UP', billing: true, protected: true, refused: { adopt: 'entered as READ; MANAGE asks your password once' } })]);
    controller.cluster_choose('harbor');
    controller.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="overview"]')?.click();
    expect(button_named(controller.root, 'ADOPT · REFUSED')?.title).toBe('refused: entered as READ; MANAGE asks your password once');
    // With MANAGE, the chip says so and nothing is held by the door.
    const { controller: managed } = controller_make(SIZE, true);
    managed.clusters_take([cluster_make('quay', { protected: false, refused: {} })]);
    managed.cluster_choose('quay');
    expect(managed.root.querySelector('.tdc-mode .tdc-condition-name')?.textContent).toBe('MANAGE');
    expect([...managed.root.querySelectorAll<HTMLButtonElement>('.tdc-pill')].find((pill: HTMLButtonElement): boolean => pill.textContent === 'BUILD')?.disabled).toBe(false);
    controller.dispose(); controller.root.remove(); managed.dispose(); managed.root.remove();
  });

  it('entered as READ with a door, BUILD asks the password first and sends only once MANAGE', async () => {
    const raised: string[] = [];
    const { controller, sent } = controller_make(SIZE, false, async (line: string): Promise<boolean> => { raised.push(line); return true; });
    controller.clusters_take([cluster_make('quay', { protected: false, refused: {} })]);
    controller.cluster_choose('quay');
    // The pill, not the gutter's BUILD seat.
    const build: HTMLButtonElement | undefined = [...controller.root.querySelectorAll<HTMLButtonElement>('.tdc-pill')].find((pill: HTMLButtonElement): boolean => pill.textContent === 'BUILD');
    expect(build?.disabled).toBe(false);
    expect(build?.classList.contains('tdc-pill-asks')).toBe(true);
    build?.click();
    await flush();
    expect(raised).toEqual(['cluster build quay']);
    expect(sent).toEqual(['cluster build quay']);
    controller.dispose();
    controller.root.remove();
  });

  it('redraws from an event, keeping the cost a read gave', () => {
    const { controller, cues } = controller_make();
    controller.clusters_take([cluster_make('quay', { cost: { hourly: 0.71, soFar: 2, currency: 'USD' } })]);
    controller.cluster_choose('quay');
    controller.cluster_take({ ...cluster_make('quay', { condition: 'BUILDING', running: { job: 'quay-build', step: 'infra-apply', since: null } }), cost: undefined });
    expect(controller.root.querySelector('.tdc-condition-name')?.textContent).toBe('BUILDING');
    expect(controller.cluster_get()?.cost?.hourly).toBe(0.71);
    controller.cluster_take({ ...cluster_make('quay', { condition: 'FAILED', steps: [{ folder: '01-infra-apply', state: 'failed', name: 'infra-apply' }] }), cost: undefined });
    expect(cues).toContain('redalert');
    controller.dispose();
    controller.root.remove();
  });

  it('shows the teardown running on its seat, feeds its log, and says torn down when it ends', async () => {
    const { controller, sent, cues } = controller_make();
    controller.clusters_take([cluster_make('quay', { condition: 'UP', protected: false, refused: {} })]);
    controller.cluster_choose('quay');
    controller.view_show('teardown');
    // The teardown's task arrives by an event: the condition, the RUNNING box with its clock and KILL, and FOLLOW by the job id.
    controller.cluster_take({ ...cluster_make('quay', { condition: 'TEARING DOWN', protected: false, refused: {}, running: { job: 'quay-teardown', step: 'teardown', since: '2026-11-03T14:54:55.990Z' } }), cost: undefined });
    expect(controller.root.querySelector('.tdc-condition-name')?.textContent).toBe('TEARING DOWN');
    expect(controller.root.querySelector('.tdc-condition-why')?.textContent).toContain('BEING TORN DOWN');
    const body: HTMLElement = controller.root.querySelector('.tdc-body') as HTMLElement;
    expect(body.querySelector('.tdc-running .tdc-section-title, .tdc-running h3, .tdc-running')?.textContent).toContain('RUNNING · TEARDOWN');
    expect(body.querySelector('.tdc-running-clock')?.textContent).toMatch(/^14:54 · /);
    expect(button_named(body, 'KILL')).toBeDefined();
    expect(button_named(body, 'TEAR DOWN')).toBeUndefined();
    button_named(body, 'FOLLOW')?.click();
    await flush();
    expect(sent.at(-1)).toBe('wait quay-teardown');
    // The line on the lane feeds THE STEP'S LOG on this seat too.
    const line: Promise<void> = controller.line_send('cluster teardown quay');
    controller.output_take('14:54:56 Resource Manager destroy job ocid1.ormjob\n');
    expect([...body.querySelectorAll('.tdc-steplog-line')].map((one: Element): string => one.textContent ?? '')).toEqual(['14:54:56 Resource Manager destroy job ocid1.ormjob']);
    await line;
    // It ends: GONE, said in the log with a cue, and the seat says TORN DOWN with when.
    controller.cluster_take({ ...cluster_make('quay', { condition: 'GONE', gone: '2026-11-03T15:20:00.000Z', refused: { build: 'torn down', teardown: 'already torn down' } }), cost: undefined });
    expect(cues).toContain('ack');
    expect([...controller.root.querySelectorAll('.tdc-log-note')].map((one: Element): string => one.textContent ?? '')).toContain('quay: torn down; nothing of it bills');
    expect(controller.root.querySelector('.tdc-body .tdc-note-title')?.textContent).toBe('TORN DOWN');
    expect(controller.root.querySelector('.tdc-body .tdc-note .tdc-prose')?.textContent).toContain('2026-11-03 15:20');
    // The read after the line no longer lists it (history, not a cluster): the seat keeps it GONE until another is chosen.
    controller.clusters_take([]);
    expect(controller.cluster_get()?.name).toBe('quay');
    expect(controller.root.querySelector('.tdc-condition-name')?.textContent).toBe('GONE');
    expect(controller.root.querySelector('.tdc-body .tdc-note-title')?.textContent).toBe('TORN DOWN');
    controller.dispose();
    controller.root.remove();
  });

  it('answers the billing question by a pill and the teardown question by the name typed back', async () => {
    const { controller } = controller_make();
    controller.clusters_take([cluster_make('quay', { protected: false, refused: {} })]);
    controller.cluster_choose('quay');
    const billing: Promise<string | null> = controller.ask_take('infra-apply creates 17 resources. Billing starts at $0.50 an hour. Continue? [y/N]', 'text');
    expect(controller.root.querySelector('.tdc-strip')?.getAttribute('data-tone')).toBe('bill');
    button_named(controller.root, 'YES · BILL')?.click();
    expect(await billing).toBe('y');
    expect((controller.root.querySelector('.tdc-strip') as HTMLElement).hidden).toBe(true);
    const named: Promise<string | null> = controller.ask_take("Destroy what quay built? Type the cluster's name to go on:", 'text');
    const destroy: HTMLButtonElement | undefined = button_named(controller.root, 'DESTROY');
    const input: HTMLInputElement = controller.root.querySelector('.tdc-strip-input') as HTMLInputElement;
    expect(destroy?.disabled).toBe(true);
    input.value = 'qua';
    input.dispatchEvent(new Event('input'));
    expect(destroy?.disabled).toBe(true);
    input.value = 'quay';
    input.dispatchEvent(new Event('input'));
    expect(destroy?.disabled).toBe(false);
    destroy?.click();
    expect(await named).toBe('quay');
    controller.dispose();
    controller.root.remove();
  });

  it('shows a found cluster as the cloud says it, with ADOPT; one with nothing left offers REMOVE WHAT IS LEFT and no lock', async () => {
    const { controller, sent } = controller_make();
    const why: string = 'found in the tenancy, not adopted: cluster adopt harbor first';
    controller.clusters_take([
      cluster_make('harbor', { origin: 'found', condition: 'UP', billing: true, protected: true, refused: { plan: why, verify: why, build: why, teardown: why }, steps: [{ folder: '01-compartment', state: 'done', name: 'compartment', evidence: 'found ocid1.compartment.oc1..h' }, { folder: '06-infra-apply', state: 'done', name: 'infra-apply', evidence: '3 instances live in its compartment' }, { folder: '10-run', state: 'unknown', name: 'run', evidence: 'the cloud does not say; adopt it and verify to know' }] }),
      cluster_make('quay', { origin: 'found', condition: 'GONE', billing: false, cluster: null, compartment: 'ocid1.compartment.oc1..q', resources: { buckets: 1 }, refused: { plan: 'gone', verify: 'gone', build: 'gone' } }),
    ]);
    controller.cluster_choose('harbor');
    expect(controller.root.querySelector('.tdc-chip-class')?.textContent).toBe('FOUND · NOT ADOPTED');
    expect([...controller.root.querySelectorAll('.tdc-chip')].map((chip) => chip.textContent)).toContain('2 OF 3 DONE · FROM THE CLOUD');
    expect([...controller.root.querySelectorAll('.tdc-head-value')].map((value) => value.textContent)).toContain('harbor.oci.example.org');
    button_named(controller.root, 'ADOPT')?.click();
    await flush();
    expect(sent).toEqual(['cluster adopt harbor']);
    controller.cluster_choose('quay');
    expect(controller.root.querySelector('.tdc-chip-class')?.textContent).toBe('FOUND · NOTHING LEFT');
    expect(controller.root.querySelector('.tdc-lock')).toBeNull();
    expect(controller.root.querySelector('.tdc-condition-why')?.textContent).toBe('TORN DOWN · NOTHING BILLED');
    expect(controller.root.querySelector('.tdc-note-found')?.textContent).toContain('its compartment (holding 1 buckets)');
    expect(button_named(controller.root, 'ADOPT')).toBeUndefined();
    controller.view_show('teardown');
    expect(controller.root.querySelector('.tdc-lock')).toBeNull();
    button_named(controller.root, 'REMOVE WHAT IS LEFT')?.click();
    await flush();
    expect(sent.at(-1)).toBe('cluster teardown quay');
    controller.dispose();
    controller.root.remove();
  });

  it('shows the lock, and lifting it is a line of its own', async () => {
    const { controller, sent } = controller_make();
    controller.clusters_take([cluster_make('quay')]);
    controller.cluster_choose('quay');
    controller.view_show('teardown');
    expect(controller.root.querySelector('.tdc-lock')?.textContent).toBe('PROTECTED');
    expect(button_named(controller.root, 'TEAR DOWN')).toBeUndefined();
    button_named(controller.root, 'LIFT THE LOCK')?.click();
    await flush();
    expect(sent).toEqual(['cluster protect quay off']);
    controller.clusters_take([cluster_make('quay', { protected: false, refused: {} })]);
    button_named(controller.root, 'TEAR DOWN')?.click();
    await flush();
    expect(sent.at(-1)).toBe('cluster teardown quay');
    controller.dispose();
    controller.root.remove();
  });

  it('holds COMMIT until the new name is a free DNS label, then writes the spec and plays the tenant', async () => {
    const { controller, sent, hooks } = controller_make();
    controller.clusters_take([cluster_make('harbor')]);
    // The session's read after `cluster new`: the spec written, quay is kept.
    const run = hooks.run;
    hooks.run = async (line: string): Promise<void> => {
      await run(line);
      if (line.startsWith('cluster new ')) controller.clusters_take([cluster_make('harbor'), cluster_make('quay')]);
    };
    button_named(controller.root, '+ NEW')?.click();
    await flush();
    expect(controller.view_get()).toBe('size');
    const commit = (): HTMLButtonElement | undefined => [...controller.root.querySelectorAll('.tdc-commit button')].find((b) => (b.textContent ?? '').startsWith('COMMIT')) as HTMLButtonElement | undefined;
    expect(commit()?.textContent).toBe('COMMIT · NAME IT FIRST');
    const name: HTMLInputElement = controller.root.querySelector('#tdc-new-name') as HTMLInputElement;
    name.value = 'harbor';
    name.dispatchEvent(new Event('input'));
    expect(commit()?.textContent).toBe('COMMIT · HARBOR IS TAKEN');
    name.value = 'quay';
    name.dispatchEvent(new Event('input'));
    expect(commit()?.disabled).toBe(false);
    expect([...controller.root.querySelectorAll('.tdc-commit-line')].map((line) => line.textContent)).toEqual(['cluster new quay', 'play ~/tenant.mise --param NAME=quay']);
    commit()?.click();
    await flush();
    await flush();
    expect(sent).toEqual(['cluster new quay', 'play ~/tenant.mise --param NAME=quay']);
    expect(controller.cluster_get()?.name).toBe('quay');
    expect(controller.view_get()).toBe('build');
    controller.dispose();
    controller.root.remove();
  });

  it('holds COMMIT until a zone is chosen when the tenancy holds several, and names the one chosen', async () => {
    const { controller, sent } = controller_make({ ...SIZE, baseDomain: null, dnsZones: ['lab.example.org', 'oci.example.org'] });
    controller.clusters_take([cluster_make('harbor')]);
    button_named(controller.root, '+ NEW')?.click();
    await flush();
    const name: HTMLInputElement = controller.root.querySelector('#tdc-new-name') as HTMLInputElement;
    name.value = 'quay';
    name.dispatchEvent(new Event('input'));
    const commit = (): HTMLButtonElement | undefined => [...controller.root.querySelectorAll('.tdc-commit button')].find((b) => (b.textContent ?? '').startsWith('COMMIT')) as HTMLButtonElement | undefined;
    expect(commit()?.textContent).toBe('COMMIT · NO ZONE');
    expect(commit()?.disabled).toBe(true);
    button_named(controller.root, 'oci.example.org')?.click();
    expect(controller.root.querySelector('.tdc-commit-line')?.textContent).toBe('cluster new quay --base-domain oci.example.org');
    expect(commit()?.disabled).toBe(false);
    commit()?.click();
    await flush();
    expect(sent[0]).toBe('cluster new quay --base-domain oci.example.org');
    controller.dispose();
    controller.root.remove();
  });
});
