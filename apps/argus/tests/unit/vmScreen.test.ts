/**
 * @jest-environment jsdom
 */
/**
 * @file The VM controller: its door lists every machine the tenancy runs with
 * + NEW, a found one among them; a machine opens on MACHINE, what it is; one
 * this session can only see stands with MACHINE and TEARDOWN alone, and acts
 * write no script. Opened on a machine the library declares, its
 * seats are that machine's lines in the controller's order with a TEARDOWN
 * seat of its own; the gutter wears a pill per machine and + NEW; a new
 * machine is named, committed (the script written, then declared) and
 * becomes a machine of the gutter; a CHRIS not in the script is appended by
 * RUN; a machine the host keeps with no script gets one synthesized and
 * written at its first act.
 */
import { describe, it, expect } from '@jest/globals';
import type { QuietAnswer, ScriptHooks } from '../../src/features/script/screen.js';
import { VmScreen } from '../../src/features/vm/screen.js';

const STORE_TEXT: string = [
  'net new chrisproject-services --cidr 10.20.0.0/16',
  'net build chrisproject-services',
  'vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04',
  'vm build store',
  'chris deploy store --profile minimal --compute NERC --host cube.chrisproject.org',
  'chris user add rudolph --email rudolph@example.org --on store',
].join('\n');

const LIMITS = { shape: 'VM.Standard.E5.Flex', family: 'E5', vcpu: { min: 2, max: 252, step: 2 }, memory: { min: 1, max: 2098, perVcpu: { min: 0.5, max: 32 } }, disk: { min: 50, max: 32768 }, data: { min: 50, max: 32768 } };
const SPEC = { net: 'chrisproject-services', open: [80, 443], vcpu: 2, memory: 8, disk: 50, data: 50, dataBackup: 'daily', os: 'ubuntu-26.04' };

/** Rows a test adds to the session's VMs. */
let ROWS_MORE: unknown[] = [];

/** What the screen wrote with the editor's save line, by path: `cat` answers it as the host would. */
const WRITTEN: Map<string, string> = new Map();

/** What the tenancy runs of store, as `vm status` reads it; a test moves it to stand for a build's effect. */
let STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };

/** The session's answers: a library with store.mise, two machines kept (store from the script, lone from nothing). */
function answer_make(line: string, mine: string[]): QuietAnswer {
  const envelope = (model: { kind: string; data: unknown }, rendered: string = ''): QuietAnswer => ({ envelopes: [{ rendered, model, status: 'ok' }] });
  if (line === 'vm status') return envelope({ kind: 'stratus.vm.status', data: { vms: [
    { name: 'store', state: 'built', region: 'us-ashburn-1', stands: STORE_RUNS, declared: '2026-11-01T00:00:00Z', declaredKept: true, spec: SPEC, address: '203.0.113.10', inside: '10.20.0.5', protected: false, built: '2026-11-01T00:00:00Z', chris: { profile: 'minimal', compute: 'NERC', host: 'cube.chrisproject.org', url: 'https://cube.chrisproject.org/api/v1/', porter: null } },
    { name: 'lone', state: 'declared', region: 'us-ashburn-1', spec: { ...SPEC, vcpu: 4 }, address: null, inside: null, protected: true, built: null, chris: null },
    { name: 'web', state: 'found', region: 'us-ashburn-1', spec: null, address: '129.158.63.113', inside: '10.20.0.234', protected: true, built: null, chris: null,
      found: { state: 'running', instanceId: 'ocid1.instance.web', shape: 'VM.Standard.E5.Flex', vcpus: 2, memoryGib: 8, tagged: true, chris: { url: 'https://web.example.org/api/v1/', porter: null } } },
    ...ROWS_MORE,
  ] } });
  if (line === 'ls /scripts') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts', items: [{ name: 'mine', type: 'dir' }, { name: 'chrisproject', type: 'source', status: 'cloned', title: 'git@github.com:HARBOR-Medical-AI/infra.git' }] }] });
  if (line === 'ls /scripts/mine') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/mine', items: mine.map((name: string) => ({ name, type: 'script' })) }] });
  if (line === 'ls /scripts/chrisproject') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/chrisproject', items: [{ name: 'store.mise', type: 'script' }] }] });
  if (line.startsWith('cat ')) return { envelopes: [{ rendered: WRITTEN.get(line.slice(4)) ?? `${STORE_TEXT}\n`, status: 'ok' }] };
  if (line.startsWith('play ') && line.endsWith('--status')) {
    const text: string = line.includes('store.mise') ? STORE_TEXT : '';
    const lines = text === '' ? [] : text.split('\n').map((each: string, index: number) => ({ number: index + 1, text: each, state: index < 5 ? 'done' : 'ready', detail: '' }));
    if (text === '') return { envelopes: [{ rendered: '', renderedErr: 'play: no such file\n', status: 'error' }] };
    return envelope({ kind: 'manifest.status', data: { manifest: 'store', lines } });
  }
  if (line === 'vm limits') return envelope({ kind: 'stratus.vm.limits', data: LIMITS });
  if (line === 'chris status store') return envelope({ kind: 'stratus.chris.status', data: { chris: [{ vm: 'store', profile: 'minimal', compute: 'NERC', url: 'https://cube.chrisproject.org/api/v1/', host: 'cube.chrisproject.org', porter: 'porter.chrisproject.org', deployed: '2026-11-05T04:04:12.000Z', image: 'ghcr.io/fnndsc/cube:6.11.0', porterVersion: '0.9.10',
    live: { at: '2026-11-05T06:00:00.000Z', cube: { url: 'https://cube.chrisproject.org/api/v1/', status: 200, admin: true }, porter: { url: 'https://porter.chrisproject.org/healthz', status: 200, sessions: 2, version: '0.9.10' }, accounts: [{ username: 'chris', email: 'dev@babyMRI.org' }, { username: 'jennings', email: 'j@example.org' }], accountsWhy: null } }] } });
  if (line.startsWith('chris deploy store') && line.endsWith('--plan')) return envelope({ kind: 'stratus.chris.plan', data: { vm: 'store', changes: [], restarts: ['porter (0.9.10 → 0.9.11): its open sessions end'], sessions: 2, asks: true } });
  if (line.startsWith('vm cost')) return envelope({ kind: 'stratus.vm.cost', data: { vms: [{ name: 'store', declared: true, spec: SPEC, cost: { machineHour: 0.052, dataHour: 0.003, currency: 'USD' }, changes: [], before: null }] } });
  return { envelopes: [{ rendered: '', status: 'ok' }] };
}

function screen_make(mine: string[] = []): { screen: VmScreen; sent: string[]; asked: string[] } {
  WRITTEN.clear();
  const sent: string[] = [];
  const asked: string[] = [];
  const hooks: ScriptHooks = {
    run: async (line: string): Promise<boolean> => {
      sent.push(line);
      const save: RegExpMatchArray | null = line.match(/^touch --withContents='([\s\S]*)' '([^']+)'$/);
      if (save !== null) WRITTEN.set(save[2] as string, (save[1] as string).replace(/'\\''/g, "'"));
      return true;
    },
    ask: async (line: string): Promise<QuietAnswer> => { asked.push(line); return answer_make(line, mine); },
    stop: (): void => { sent.push('<stop>'); },
    leave: (): void => { sent.push('<leave>'); },
    manage_is: (): boolean | null => true,
    elevate_ask: null,
    voice: { pill: (): void => undefined, cue: (): void => undefined },
  };
  const screen: VmScreen = new VmScreen(hooks);
  document.body.append(screen.root);
  return { screen, sent, asked };
}

const button_named = (root: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((button: HTMLButtonElement): boolean => (button.textContent ?? '').trim() === text);
const settle = async (rounds: number = 8): Promise<void> => { for (let i: number = 0; i < rounds; i++) await new Promise((resolve) => { setTimeout(resolve, 0); }); };

describe('the VM controller', () => {
  it('SIZE renders what runs beside each lever, offers BUILD alone, says what BUILD would do against what runs, and its receipt is what runs read back', async () => {
    STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };
    try {
      const { screen } = screen_make();
      await screen.vm_open('store');
      await settle();
      screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-3"]')?.click();
      await settle();
      // What runs, read from the tenancy, beside the lever; the levers come before the lines.
      expect([...screen.root.querySelectorAll('.ss-slider-runs')].map((mark) => mark.textContent)).toEqual(['RUNS 2', 'RUNS 8 GiB', 'RUNS 50 GB', 'RUNS 50 GB']);
      expect(screen.root.querySelector('.tdc-lever-group .tdc-section-title')?.textContent).toContain('RUNS AS READ FROM THE TENANCY 04:48 UTC');
      expect(button_named(screen.root, 'DECLARE')).toBeUndefined();
      expect(button_named(screen.root, 'BUILD')).toBeDefined();
      expect(screen.root.querySelector('.ss-note-would .tdc-note-title')?.textContent).toBe('WHAT RUNS IS WHAT IS OFFERED');
      // The offer moved off what runs: the mark lights, and BUILD WOULD says the change and what it means.
      const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
      disk.value = '180';
      disk.dispatchEvent(new Event('input'));
      expect(screen.root.querySelectorAll('.ss-slider-differs').length).toBe(1);
      expect(screen.root.querySelector('.ss-note-would')?.textContent).toContain('BUILD WOULDboot disk 50 → 180 GB: grows online, no reboot');
      const memory: HTMLInputElement = screen.root.querySelector('#ss-slider-memory') as HTMLInputElement;
      memory.value = '16';
      memory.dispatchEvent(new Event('input'));
      expect(screen.root.querySelector('.ss-note-would')?.textContent).toContain('memory 8 → 16 GiB: the machine reboots');
      memory.value = '8';
      memory.dispatchEvent(new Event('input'));
      // BUILD sends the declaration then the build; once what runs reads back as offered, the note is the receipt.
      STORE_RUNS = { at: '2026-11-05T05:10:00.000Z', vcpu: 2, memory: 8, disk: 180, data: 50 };
      button_named(screen.root, 'BUILD')?.click();
      await settle(30);
      expect(screen.root.querySelector('.ss-note-would .tdc-note-title')?.textContent).toBe('BUILT · WHAT RUNS IS WHAT WAS OFFERED');
      expect(screen.root.querySelector('.ss-note-would')?.textContent).toContain('read from the tenancy 05:10 UTC');
      screen.dispose();
      screen.root.remove();
    } finally {
      STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };
    }
  });

  it('CHRIS renders what runs of the ChRIS and what a deploy would do; USERS renders CUBE\'s accounts beside the script\'s lines', async () => {
    const { screen, asked } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    expect(asked).toContain('chris status store');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(12);
    const side: string = screen.root.querySelector('.ss-col-side')?.textContent ?? '';
    expect(side).toContain('THE CHRIS · AS IT RUNS');
    expect(side).toContain('READ FROM IT 06:00 UTC');
    expect(side).toContain('ANSWERS 200 · CHRIS SIGNS IN');
    expect(side).toContain('ANSWERS 200 · 2 OPEN · 0.9.10');
    expect(asked.some((line: string): boolean => line.startsWith('chris deploy store') && line.endsWith('--plan'))).toBe(true);
    const note: string = screen.root.querySelector('.ss-note-deploy')?.textContent ?? '';
    expect(note).toContain('DEPLOY WOULD');
    expect(note).toContain('restarts porter (0.9.10 → 0.9.11): its open sessions end');
    expect(note).toContain('2 porter sessions open now end');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="users"]')?.click();
    await settle(12);
    const users: string = screen.root.querySelector('.ss-col-side')?.textContent ?? '';
    expect(users).toContain('IN THE CHRIS · ITS ACCOUNTS');
    expect(users).toContain('RUDOLPHNOT IN CUBE YET · ITS LINE ADDS IT');
    expect(users).toContain('CHRISIN CUBE · NO LINE (the admin)');
    expect(users).toContain('JENNINGSIN CUBE · NO LINE');
    screen.dispose();
    screen.root.remove();
  });

  it('SIZE changed by a slider writes the script before it builds, a script from git to its working copy, so the declaration reads done', async () => {
    const { screen, sent } = screen_make();
    await screen.vm_open('store');
    await settle();
    expect(screen.path_get()).toBe('/scripts/chrisproject/store.mise');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-3"]')?.click();
    await settle();
    const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
    disk.value = '180';
    disk.dispatchEvent(new Event('input'));
    button_named(screen.root, 'BUILD')?.click();
    await settle(20);
    expect(sent[0]?.startsWith("touch --withContents='net new chrisproject-services")).toBe(true);
    expect(sent[0]?.includes('--disk 180')).toBe(true);
    expect(sent[0]?.endsWith("' '/scripts/mine/store.mise'")).toBe(true);
    expect(sent[1]).toBe('vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 180 --data 50 --data-backup daily --os ubuntu-26.04');
    expect(sent[2]).toBe('vm build store');
    expect(screen.path_get()).toBe('/scripts/mine/store.mise');
    screen.dispose();
    screen.root.remove();
  });

  it('opens on a machine the library declares: its lines as SIZE (holding its build), CHRIS, USERS, then TEARDOWN; a pill per machine and + NEW; the machine\'s facts in the header', async () => {
    const { screen, asked } = screen_make();
    await screen.vm_open('store');
    await settle();
    expect(asked).toContain('vm status');
    expect(screen.vm_get()).toBe('store');
    expect(screen.path_get()).toBe('/scripts/chrisproject/store.mise');
    expect(screen.steps_get().map((step) => step.label)).toEqual(['MACHINE', 'SIZE', 'CHRIS', 'USERS', 'TEARDOWN']);
    expect([...screen.root.querySelectorAll('.takeover-seat .tdc-cluster')].map((pill) => pill.textContent)).toEqual(['STORE', 'LONE', 'WEB', '+ NEW']);
    expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('BUILT');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('203.0.113.10');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('cube.chrisproject.org');
    expect(document.title).toBe('BUILT · store');
    // A machine opens on what it is: its doing, size, addresses and the ChRIS on it.
    expect(screen.view_get()).toBe('machine');
    const facts: string = screen.root.querySelector('.tdc-body')?.textContent ?? '';
    expect(facts).toContain('THE MACHINE');
    expect(facts).toContain('2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups) · ubuntu-26.04');
    expect(facts).toContain('https://cube.chrisproject.org/api/v1/');
    expect(facts).toContain('its records and its SSH key held here');
    // What runs, read from the tenancy, beside what is declared, and where the declaration is kept.
    expect(facts).toContain('RUNS2 vCPU · 8 GiB · disk 50 GB · data 50 GB (read from the tenancy 04:48 UTC)');
    expect(facts).toContain('· kept in the tenancy');
    // SIZE holds the build: DECLARE and BUILD, and no undoing (TEARDOWN is its own seat here).
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-3"]')?.click();
    await settle();
    const body: HTMLElement = screen.root.querySelector('.tdc-body') as HTMLElement;
    expect(button_named(body, 'TEARDOWN')).toBeUndefined();
    expect(button_named(body, 'DECLARE')).toBeUndefined();
    expect(button_named(body, 'BUILD')?.title).toBe('sends: vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04, then vm build store');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    expect(screen.root.querySelector('.tdc-note-title')?.textContent).toBe('UNLOCKED');
    // What each undoing stops billing, and what keeps billing, beside the pills.
    await settle(8);
    const guard: string = screen.root.querySelector('.ss-col-side')?.textContent ?? '';
    expect(guard).toContain('TEARDOWN STOPS');
    expect(guard).toContain('STILL BILLS');
    expect(guard).toContain('TEARDOWN · ALL STOPS');
    expect(button_named(body, 'TEARDOWN')?.title).toContain('vm teardown store');
    expect(button_named(body, 'TEARDOWN · ALL')?.title).toContain('--all');
    screen.dispose();
    screen.root.remove();
  });

  it('a new machine: sized and priced before anything is sent, then BUILD, its one commit, writes its script, declares it and builds it; then it is a machine of the gutter', async () => {
    const { screen, sent, asked } = screen_make();
    await screen.vm_open('');
    await settle();
    // The door lists what is there, as a folder does; + NEW MACHINE opens the new one.
    expect(screen.view_get()).toBe('machines');
    expect([...screen.root.querySelectorAll('.takeover-gutter button')].map((seat) => seat.textContent?.trim())).toEqual(['MACHINES', 'NEW · SIZE', 'LEAVE']);
    const listed: string[] = [...screen.root.querySelectorAll('.vm-row')].map((row) => row.textContent ?? '');
    expect(listed).toHaveLength(3);
    expect(listed[0]).toContain('BUILT');
    expect(listed[0]).toContain('cube.chrisproject.org');
    expect(listed[2]).toContain('FOUND · RUNNING');
    expect(listed[2]).toContain('129.158.63.113 · 2 vCPU · 8 GiB · CUBE at web.example.org');
    button_named(screen.root, '+ NEW MACHINE')?.click();
    await settle();
    expect(screen.view_get()).toBe('new');
    expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('NEW');
    const commit: HTMLButtonElement | undefined = button_named(screen.root, 'BUILD · NAME IT');
    expect(commit?.disabled).toBe(true);
    expect(commit?.classList.contains('tdc-pill-bill')).toBe(true);
    // The levers and the price stand before anything is sent: the disk moved, the line and the price follow; nothing was sent.
    const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
    disk.value = '120';
    disk.dispatchEvent(new Event('input'));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    await settle();
    expect(asked.some((line: string): boolean => line.startsWith('vm cost unnamed') && line.includes('--disk 120'))).toBe(true);
    expect(screen.root.querySelector('.tdc-col-cost')?.textContent).toContain('AS SIZED');
    expect(sent).toEqual([]);
    const name: HTMLInputElement = screen.root.querySelector('#vm-new-name') as HTMLInputElement;
    name.value = 'Blt';
    name.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'BUILD · NAME IS A HOSTNAME')?.disabled).toBe(true);
    name.value = 'store';
    name.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'BUILD · ALREADY IN THE TENANCY')?.disabled).toBe(true);
    name.value = 'web';
    name.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'BUILD · ALREADY IN THE TENANCY')?.disabled).toBe(true);
    name.value = 'blt';
    name.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector('.vm-new-line')?.textContent).toBe('vm new blt --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 120 --data 50 --data-backup daily --os ubuntu-26.04');
    button_named(screen.root, 'BUILD')?.click();
    await settle(30);
    expect(sent[0]?.startsWith("touch --withContents='vm new blt --net chrisproject-services")).toBe(true);
    expect(sent[0]?.includes('--disk 120')).toBe(true);
    expect(sent[0]?.includes('vm build blt')).toBe(true);
    expect(sent[0]?.endsWith("' '/scripts/mine/blt.mise'")).toBe(true);
    expect(sent[1]).toBe('vm new blt --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 120 --data 50 --data-backup daily --os ubuntu-26.04');
    expect(sent[2]).toBe('vm build blt');
    screen.dispose();
    screen.root.remove();
  });

  it('a machine the host keeps with no script gets its script from its record, written at the first act; CHRIS not in the script is appended by RUN', async () => {
    const { screen, sent, asked } = screen_make();
    await screen.vm_open('lone');
    await settle();
    expect(screen.path_get()).toBe('/scripts/mine/lone.mise');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('SCRIPT NOT WRITTEN YET');
    // Not written yet, its lines' states are read from the screen's own text, so its seats wear them before the first act.
    expect(asked.some((line: string): boolean => line.startsWith("play /scripts/mine/lone.mise --status --text='vm new lone"))).toBe(true);
    // Read from its record, the script is not called edited.
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-1"]')?.click();
    await settle();
    expect([...screen.root.querySelectorAll('.tdc-body .tdc-note-title')].map((title) => title.textContent)).not.toContain('EDITED · NOT SAVED');
    expect(screen.steps_get().map((step) => [step.label, step.state])).toEqual([['MACHINE', null], ['SIZE', null], ['CHRIS', null], ['USERS', null], ['TEARDOWN', null]]);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="chris"]')?.click();
    await settle();
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toBe('chris deploy lone --profile minimal --compute lone');
    button_named(screen.root, 'RUN')?.click();
    await settle(20);
    // The script is written first (declaration, build, the deploy after the build), then the deploy runs.
    expect(sent[0]?.startsWith("touch --withContents='vm new lone --net chrisproject-services --open 80,443 --vcpu 4")).toBe(true);
    expect(sent[0]?.includes('vm build lone\nchris deploy lone --profile minimal --compute lone')).toBe(true);
    expect(sent[1]).toBe('chris deploy lone --profile minimal --compute lone');
    screen.dispose();
    screen.root.remove();
  });

  it('TEARDOWN draws the kernel\'s steps as blocks, moved by the VM\'s event: the machine going then gone, the data staying', async () => {
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    const blocks = (): string[] => [...screen.root.querySelectorAll('.tdc-teardown-step')].map((block) => `${block.querySelector('.tdc-strip-word')?.textContent}[${[...block.classList].find((name) => name.startsWith('tdc-step-'))}]`);
    expect(blocks()).toEqual(['STANDS[tdc-step-stands]', 'STANDS[tdc-step-stands]']);
    const row = (steps: Array<[string, string, string | null]>) => ({
      name: 'store', state: 'built', region: 'us-ashburn-1', spec: SPEC, address: '203.0.113.10', inside: '10.20.0.5', protected: false, built: '2026-11-01T00:00:00Z', chris: null,
      teardown: { started: '2026-11-04T04:00:00Z', steps: steps.map(([name, state, ended]) => ({ name, state, started: '2026-11-04T04:00:00Z', ended, note: null })) },
    }) as unknown as Parameters<VmScreen['row_take']>[0];
    screen.row_take(row([['machine', 'running', null], ['data', 'not done', null]]));
    expect(blocks()).toEqual(['GOING[tdc-step-going]', 'STANDS[tdc-step-stands]']);
    screen.row_take(row([['machine', 'done', '2026-11-04T04:03:00Z'], ['data', 'kept', '2026-11-04T04:03:00Z']]));
    expect(blocks()).toEqual(['GONE · 04:03[tdc-step-gone]', 'STAYS · 04:03[tdc-step-skipped]']);
    screen.dispose();
    screen.root.remove();
  });

  it('a machine another host built is read from the tenancy whole: every seat, its size changed here; one whose key the tenancy does not keep has only its facts and teardown', async () => {
    // Built by another host, read from the tenancy whole (its key kept there), and one the tenancy keeps no key for.
    ROWS_MORE = [
    { name: 'shared', state: 'built', region: 'us-ashburn-1', spec: SPEC, address: '203.0.113.11', inside: '10.20.0.6', protected: true, built: '2026-11-01T00:00:00Z', chris: null, takenFrom: '2026-11-04T10:00:00Z', keyless: false },
    { name: 'old', state: 'built', region: 'us-ashburn-1', spec: SPEC, address: '203.0.113.12', inside: '10.20.0.7', protected: true, built: '2026-10-01T00:00:00Z', chris: null, takenFrom: '2026-11-04T10:00:00Z', keyless: true },
    ];
    const { screen } = screen_make();
    await screen.vm_open('shared');
    await settle();
    expect(screen.steps_get().map((step) => step.label)).toEqual(['MACHINE', 'SIZE', 'CHRIS', 'USERS', 'TEARDOWN']);
    expect(screen.root.querySelector('.tdc-body')?.textContent).toContain('read from the tenancy 2026-11-04 10:00: its stacks and the secrets its vault keeps');
    screen.dispose();
    screen.root.remove();
    const { screen: second } = screen_make();
    await second.vm_open('old');
    await settle();
    expect(second.steps_get().map((step) => step.label)).toEqual(['MACHINE', 'TEARDOWN']);
    expect(second.root.querySelector('.ss-header')?.textContent).toContain('NO SSH KEY IN THE TENANCY');
    expect(second.root.querySelector('.tdc-body')?.textContent).toContain('vm keep, on the host that holds the key, keeps it');
    second.dispose();
    second.root.remove();
    ROWS_MORE = [];
  });

  it('a machine found in the tenancy: what it is, and only its teardown; lifting its lock writes no script (the kernel takes it over)', async () => {
    const { screen, sent } = screen_make();
    await screen.vm_open('web');
    await settle();
    expect(screen.steps_get().map((step) => step.label)).toEqual(['MACHINE', 'TEARDOWN']);
    expect(screen.path_get()).toBe('');
    expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('FOUND · RUNNING');
    const facts: string = screen.root.querySelector('.tdc-body')?.textContent ?? '';
    expect(facts).toContain('found: built by stratus, and its stacks did not read into this host');
    expect(facts).toContain('VM.Standard.E5.Flex · 2 vCPU · 8 GiB');
    expect(facts).toContain('https://web.example.org/api/v1/ (as its instance\'s tag says)');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('https://web.example.org/api/v1/');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    expect(screen.root.querySelector('.tdc-body .tdc-note-title')?.textContent).toBe('PROTECTED');
    button_named(screen.root.querySelector('.tdc-body') as HTMLElement, 'PROTECT · OFF')?.click();
    await settle(20);
    expect(sent).toEqual(['vm protect web off']);
    screen.dispose();
    screen.root.remove();
  });
});
