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
function controller_make(size: ClusterSizeModel = SIZE): { controller: TdController; sent: string[]; cues: string[]; hooks: ControllerHooks } {
  const sent: string[] = [];
  const cues: string[] = [];
  const hooks: ControllerHooks = {
    run: async (line: string): Promise<void> => { sent.push(line); },
    size_read: async (): Promise<ClusterSizeModel> => size,
    stop: (): void => { sent.push('<stop>'); },
    leave: (): void => { sent.push('<leave>'); },
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
