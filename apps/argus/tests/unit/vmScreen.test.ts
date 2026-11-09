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
import { leverFloor_derive, serviceDraft_why, vmServices_change, vmServices_read } from '../../src/features/vm/model.js';
import { chrisQuestion_plain } from '../../src/features/vm/run.js';

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
/** CUBE's accounts as `chris status` reads them; a test may add one. */
let ACCOUNTS: Array<{ username: string; email: string; id?: number; groups?: string[] }> = [{ username: 'chris', email: 'dev@babyMRI.org', id: 1, groups: ['all_users', 'pacs_users'] }, { username: 'jennings', email: 'j@example.org', id: 4, groups: ['all_users'] }];
let STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };

/** The session's answers: a library with store.mise, two machines kept (store from the script, lone from nothing). */
function answer_make(line: string, mine: string[]): QuietAnswer {
  const envelope = (model: { kind: string; data: unknown }, rendered: string = ''): QuietAnswer => ({ envelopes: [{ rendered, model, status: 'ok' }] });
  if (line === 'vm status') return envelope({ kind: 'stratus.vm.status', data: { vms: [
    { name: 'store', state: 'built', region: 'us-ashburn-1', stands: STORE_RUNS, declared: '2026-11-01T00:00:00Z', declaredKept: true, spec: SPEC, address: '203.0.113.10', inside: '10.20.0.5', protected: false, lock: { at: '2026-11-05T14:02:00.000Z', kept: true }, built: '2026-11-01T00:00:00Z', chris: { profile: 'minimal', compute: 'NERC', host: 'cube.chrisproject.org', url: 'https://cube.chrisproject.org/api/v1/', porter: null } },
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
  if (line === 'chris status store') return envelope({ kind: 'stratus.chris.status', data: { chris: [{ vm: 'store', profile: 'minimal', compute: 'NERC', url: 'https://cube.chrisproject.org/api/v1/', host: 'cube.chrisproject.org', porter: 'porter.chrisproject.org', deployed: '2026-11-05T04:04:12.000Z', image: 'ghcr.io/fnndsc/cube:6.11.0', porterVersion: '0.9.10', berths: true, berthLimits: { cpus: 2, memoryGib: 4 },
    live: { at: '2026-11-05T06:00:00.000Z', cube: { url: 'https://cube.chrisproject.org/api/v1/', status: 200, admin: true }, porter: { url: 'https://porter.chrisproject.org/healthz', status: 200, sessions: 2, version: '0.9.10' }, accounts: ACCOUNTS, accountsWhy: null, groups: ['all_users', 'pacs_users'] } }] } });
  if (line.startsWith('chris deploy store') && line.endsWith('--plan')) return envelope({ kind: 'stratus.chris.plan', data: { vm: 'store', changes: line.includes('cube2') ? ['host cube.chrisproject.org → cube2.chrisproject.org'] : [], restarts: ['porter (0.9.10 → 0.9.11): its open sessions end'], sessions: 2, asks: true } });
  if (line.startsWith('vm cost')) return envelope({ kind: 'stratus.vm.cost', data: { vms: [{ name: 'store', declared: true, spec: SPEC, cost: { machineHour: 0.052, dataHour: 0.003, currency: 'USD' }, changes: [], before: null }] } });
  return { envelopes: [{ rendered: '', status: 'ok' }] };
}

function screen_make(mine: string[] = []): { screen: VmScreen; sent: string[]; asked: string[]; fed: Array<string | null> } {
  WRITTEN.clear();
  const sent: string[] = [];
  const asked: string[] = [];
  const fed: Array<string | null> = [];
  let screen: VmScreen | null = null;
  const hooks: ScriptHooks = {
    run: async (line: string): Promise<boolean> => {
      sent.push(line);
      // `chris passwd` asks as the engine does: the admin's restart first, then the password hidden, twice.
      const passwd: RegExpMatchArray | null = line.match(/^chris passwd (\S+) --on (\S+)$/);
      if (passwd !== null && screen !== null) {
        const name: string = passwd[1] as string;
        if (name === 'chris') fed.push(await screen.ask_take(`chris passwd: chris on ${passwd[2]}: CUBE at https://cube.chrisproject.org/api/v1/ starts again to take the new password, and is down for a minute or so. Continue? [y/N]`, 'confirm'));
        fed.push(await screen.ask_take(`${name}'s new password (empty: generate one):`, 'secret'));
        fed.push(await screen.ask_take(`${name}'s new password, again:`, 'secret'));
      }
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
  screen = new VmScreen(hooks);
  document.body.append(screen.root);
  return { screen, sent, asked, fed };
}

const button_named = (root: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((button: HTMLButtonElement): boolean => (button.textContent ?? '').trim() === text);
/** ITS USERS' rows, a cell each. */
const accountRows = (root: HTMLElement): string[][] => [...root.querySelectorAll('.vm-account-listing .listing-row')].map((row) => ['name', 'uid', 'gid', 'groups', 'email', 'password'].map((key) => row.querySelector(`.vm-cell-${key}`)?.textContent ?? ''));
/** ITS USERS' change block, a line each. */
const changeLines = (root: HTMLElement): string[] => [...root.querySelectorAll('.vm-account-change .vm-change-line')].map((line) => line.textContent ?? '');
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
      expect(screen.root.querySelector('.vm-size .tdc-section-aside')?.textContent).toContain('RUNS AS READ FROM THE TENANCY 04:48 UTC');
      expect(button_named(screen.root, 'DECLARE')).toBeUndefined();
      // Nothing differs from what runs: BUILD is not drawn.
      expect(button_named(screen.root, 'BUILD')?.hidden).toBe(true);
      // SIZE is one pane: no cost column, no log column (the operator, 2026-11-06).
      expect(screen.root.querySelector('.tdc-col-cost')).toBeNull();
      expect(screen.root.querySelector('.tdc-col-steplog')).toBeNull();
      expect(screen.root.querySelector('.vm-change-lines')?.textContent).toBe('nothing changes · what runs is what is sized');
      expect(screen.root.querySelector('.vm-change')?.classList.contains('vm-change-none')).toBe(true);
      // Each lever's value is typed too: a number box in step with its slider, its range in its title.
      expect((screen.root.querySelector('#vm-number-disk') as HTMLInputElement).value).toBe('50');
      expect((screen.root.querySelector('#vm-number-disk') as HTMLInputElement).step).toBe('10');
      // The offer moved off what runs: the mark lights, and BUILD WOULD says the change and what it means.
      const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
      disk.value = '180';
      disk.dispatchEvent(new Event('input'));
      expect(screen.root.querySelectorAll('.ss-slider-differs').length).toBe(1);
      expect(screen.root.querySelector('.vm-change-lines')?.textContent).toBe('boot disk 50 → 180 GB · grows online');
      expect((screen.root.querySelector('#vm-number-disk') as HTMLInputElement).value).toBe('180');
      // The script's line, edited, never says the standing it had before the edit.
      expect(screen.root.querySelector('.vm-size-lines .ss-line-changed .ss-line-detail')).toBeNull();
      // BUILD says what it does; the script's line says it is edited, never done.
      expect(screen.root.querySelector('.vm-build')?.textContent).toContain('BUILD · boot disk 50 → 180 GB');
      expect([...screen.root.querySelectorAll('.ss-line-state')].map((state) => state.textContent)).toContain('~ EDITED · NOT BUILT: BUILD writes it, then builds it');
      const memory: HTMLInputElement = screen.root.querySelector('#ss-slider-memory') as HTMLInputElement;
      memory.value = '16';
      memory.dispatchEvent(new Event('input'));
      // Several changes are listed one a line, and BUILD counts them.
      expect([...screen.root.querySelectorAll('.vm-change-line')].map((one) => one.textContent)).toEqual(['memory 8 → 16 GiB · reboots', 'boot disk 50 → 180 GB · grows online']);
      expect(screen.root.querySelector('.vm-build')?.textContent).toMatch(/^BUILD · 2 changes/);
      // A number typed moves its slider; one off the steps is said wrong and moves nothing.
      const typed = screen.root.querySelector('#vm-number-memory') as HTMLInputElement;
      typed.value = '15.5';
      typed.dispatchEvent(new Event('input'));
      expect(typed.classList.contains('vm-lever-wrong')).toBe(true);
      expect(memory.value).toBe('16');
      memory.value = '8';
      memory.dispatchEvent(new Event('input'));
      // BUILD sends the declaration then the build; once what runs reads back as offered, the note is the receipt.
      STORE_RUNS = { at: '2026-11-05T05:10:00.000Z', vcpu: 2, memory: 8, disk: 180, data: 50 };
      screen.root.querySelector<HTMLButtonElement>('.vm-build')?.click();
      await settle(1);
      // From the press the run alone speaks: PREPARE under way, the offer spent (no change block, no BUILD).
      expect(screen.root.querySelector('.vm-run .vm-run-step')?.textContent).toContain('PREPARE');
      expect(screen.root.querySelector('.vm-run')?.textContent).not.toContain('VM LOG');
      expect(screen.root.querySelector('.vm-change')).toBeNull();
      await settle(30);
      // The build is one run, its outcome said large; what runs is read back after.
      expect(screen.root.querySelector('.vm-run-outcome')?.textContent).toBe('BUILT · BOOT DISK 50 → 180 GB');
      expect(screen.root.querySelector('.vm-size .tdc-section-aside')?.textContent).toContain('RUNS AS READ FROM THE TENANCY 05:10 UTC');
      // Built, and nothing is left to build: the offer does not return.
      expect(screen.root.querySelector('.vm-change')).toBeNull();
      screen.dispose();
      screen.root.remove();
    } finally {
      STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };
    }
  });

  it('the password that raises a READ session is asked in plain words, in a field wide enough, CONTINUE or CANCEL', async () => {
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle();
    const answered: Promise<string | null> = screen.ask_take('MANAGE · your password, for: vm build store · this session was entered as READ; your password, checked at the door you logged in by, makes it MANAGE until you leave it (it crosses once, kept nowhere); NO, or nothing, keeps READ', 'secret');
    await settle();
    const bar: HTMLElement = screen.root.querySelector('.vm-raise') as HTMLElement;
    expect(bar.querySelector('.vm-raise-title')?.textContent).toBe('YOUR PASSWORD, TO VM BUILD STORE');
    expect(bar.textContent).toContain('This session can only read.');
    expect(bar.textContent).not.toContain('door you logged in by');
    const field: HTMLInputElement = bar.querySelector('#ss-errand-input') as HTMLInputElement;
    expect(field.type).toBe('password');
    field.value = 'a password';
    button_named(bar, 'CONTINUE')?.click();
    await expect(answered).resolves.toBe('a password');
    expect(field.value).toBe('');
    screen.dispose();
    screen.root.remove();
  });

  it('a question is shown once, on the strip; the log carries its answer; the machines listing wears no index pill', async () => {
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle();
    const answered: Promise<string | null> = screen.ask_take('vm build store: boot disk 100 → 150 GB. Grown online, no reboot. $39.95 → $42.08 a month. A NO builds nothing. Continue? [y/N]', 'confirm');
    await settle();
    // On the screen the question is the act's, plain; its buttons say what each answer does.
    const strip: HTMLElement = screen.root.querySelector('.tdc-strip') as HTMLElement;
    expect(strip.querySelector('.tdc-strip-text')?.textContent).toBe('Resize store\'s boot disk 100 → 150 GB? Grown online, no reboot. $39.95 → $42.08 a month.');
    expect([...strip.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['YES · RESIZE', 'NO · BUILD NOTHING']);
    const log = (): string => [...screen.root.querySelectorAll('.tdc-log-line')].map((line) => line.textContent).join('\n');
    expect(log()).not.toContain('Continue? [y/N]');
    button_named(strip, 'NO · BUILD NOTHING')?.click();
    await expect(answered).resolves.toBe('n');
    expect(log()).toContain('vm build store: answered NO');
    await screen.vm_open('');
    await settle();
    const mount: HTMLElement = screen.root.querySelector('.vm-machines-listing') as HTMLElement;
    expect(mount.style.getPropertyValue('--roster-cols').startsWith('0px ')).toBe(true);
    screen.dispose();
    screen.root.remove();
  });

  it('CHRIS is one pane: the line beside what runs, what a replay does, RUN, and its accounts each with its host access', async () => {
    const { screen, asked } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    expect(asked).toContain('chris status store');
    // USERS is no seat of its own: a ChRIS's accounts stand on CHRIS (the operator, 2026-11-07).
    expect(screen.root.querySelector('.takeover-gutter button[data-view="users"]')).toBeNull();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(12);
    const pane: string = screen.root.querySelector('.vm-chris')?.textContent ?? '';
    expect(pane).toContain('THE CHRIS');
    expect(pane).toContain('READ FROM IT 06:00 UTC');
    expect(pane).toContain('answers 200 · chris signs in');
    expect(pane).toContain('answers 200 · 0.9.10 · 2 open');
    expect(screen.root.querySelectorAll('.ss-col-side')).toHaveLength(0);
    expect(asked.some((line: string): boolean => line.startsWith('chris deploy store') && line.endsWith('--plan'))).toBe(true);
    // Nothing differs from what runs: no change block; one quiet line on the deploy line, with a small REPLAY that still asks.
    expect(screen.root.querySelector('.ss-note-deploy')).toBeNull();
    expect(screen.root.querySelector('.vm-chris-change')).toBeNull();
    expect(screen.root.querySelector('.vm-replay-quiet span')?.textContent).toBe('nothing changes · a replay re-checks and restarts porter; 2 porter sessions open now end');
    expect(screen.root.querySelector('.vm-chris-run')?.textContent).toBe('REPLAY');
    // Nothing edited: no edited chip on any seat.
    expect(screen.root.querySelector('.vm-chip-edited')).toBeNull();
    // ITS USERS is an ARGUS listing: CUBE's accounts with their id, the user-private group, groups and email; the password never shown.
    expect(accountRows(screen.root)).toEqual([
      ['chris · admin', '1', '1', 'all_users, pacs_users', 'dev@babyMRI.org', '•••• set'],
      ['jennings', '4', '4', 'all_users', 'j@example.org', '•••• set'],
      ['rudolph · its line adds it', '—', '—', 'all_users', 'rudolph@example.org', 'asked when it runs'],
    ]);
    // The script's user line CUBE does not hold yet is a pending change of its own; APPLY names it.
    expect(changeLines(screen.root)).toEqual(['add user rudolph · its line in the script']);
    expect(screen.root.querySelector('.vm-account-apply')?.textContent).toBe('APPLY · add user rudolph · its line in the script');
    // The host's records cannot say a user was made: its line stands as they read it until CUBE holds the account.
    expect(screen.steps_get().find((step) => step.label === 'USERS')?.state).not.toBe('done');
    screen.dispose();
    screen.root.remove();
  });

  it('a user line reads done once CUBE holds its account, as its accounts were read from it: the receipt of ADD is CHRIS', async () => {
    ACCOUNTS = [...ACCOUNTS, { username: 'rudolph', email: 'rudolph@example.org' }];
    try {
      const { screen } = screen_make();
      await screen.vm_open('store');
      await settle(12);
      const users = screen.steps_get().find((step) => step.label === 'USERS');
      expect(users?.state).toBe('done');
      screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
      await settle(12);
      expect(screen.root.querySelector('.vm-chris')?.textContent).toContain('in CUBE, read from it 06:00 UTC');
      screen.dispose();
      screen.root.remove();
    } finally {
      ACCOUNTS = ACCOUNTS.filter((one) => one.username !== 'rudolph');
    }
  });

  it('SIZE changed by a slider writes the script before it builds, a script from git to its working copy, so the declaration reads done', async () => {
    const { screen, sent } = screen_make();
    await screen.vm_open('store');
    await settle();
    expect(screen.path_get()).toBe('/scripts/chrisproject/store.mise');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-3"]')?.click();
    await settle();
    // Nothing changed: BUILD is not drawn, nor a note under it (a button that cannot do anything is not offered).
    expect(screen.root.querySelector<HTMLButtonElement>('.vm-build')?.hidden).toBe(true);
    expect(screen.root.querySelector('.vm-commit-says')?.textContent).toBe('');
    const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
    disk.value = '180';
    disk.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector<HTMLButtonElement>('.vm-build')?.hidden).toBe(false);
    screen.root.querySelector<HTMLButtonElement>('.vm-build')?.click();
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
    expect(screen.steps_get().map((step) => step.label)).toEqual(['SPEC', 'SERVICES', 'CHRIS', 'USERS', 'TEARDOWN']);
    expect([...screen.root.querySelectorAll('.takeover-seat .tdc-cluster')].map((pill) => pill.textContent)).toEqual(['STORE', 'LONE', 'WEB', '+ NEW']);
    // The header is one band: which machine and its condition, the mode, its cost now, what runs, its lock.
    expect(screen.root.querySelector('.tdc-condition-label')?.textContent).toBe('STORE');
    expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('BUILT');
    const band: string = screen.root.querySelector('.ss-header')?.textContent ?? '';
    expect(band).toContain('UNLOCKED');
    expect(band).toContain('NOW');
    expect(band).not.toContain('203.0.113.10');
    expect(band).not.toContain('2 DONE');
    expect(document.title).toBe('BUILT · store');
    // A machine opens on its SIZE: what runs, where it stands.
    expect(screen.view_get()).toBe('line-3');
    const size: string = screen.root.querySelector('.tdc-body')?.textContent ?? '';
    expect(size).toContain('THE SPEC');
    expect(size).toContain('203.0.113.10 · inside 10.20.0.5');
    expect(size).toContain('chrisproject-services');
    expect(size).not.toContain('WHAT CAN BE DONE');
    // SIZE holds the build: DECLARE and BUILD, and no undoing (TEARDOWN is its own seat here).
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-3"]')?.click();
    await settle();
    const body: HTMLElement = screen.root.querySelector('.tdc-body') as HTMLElement;
    expect(button_named(body, 'TEARDOWN')).toBeUndefined();
    expect(button_named(body, 'DECLARE')).toBeUndefined();
    expect(button_named(body, 'BUILD')?.hidden).toBe(true);
    expect(button_named(body, 'BUILD')?.title).toBe('sends: vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04, then vm build store');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    expect(screen.root.querySelector('.tdc-note-title')?.textContent).toBe('UNLOCKED');
    // Where the lock is kept and when it was set, read from the tenancy.
    expect(screen.root.querySelector('.ss-lock-where')?.textContent).toBe('KEPT IN THE TENANCY · SET 2026-11-05 14:02 UTC');
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
    expect([...screen.root.querySelectorAll('.takeover-gutter button')].map((seat) => seat.textContent?.trim())).toEqual(['MACHINES', 'NEW · SPEC', 'LEAVE']);
    // The machines are an ARGUS listing: a row a machine, its columns read from the tenancy; no legend beside it.
    const listed: string[] = [...screen.root.querySelectorAll('.vm-row')].map((row) => row.textContent ?? '');
    expect(listed).toHaveLength(3);
    expect(listed[0]).toContain('BUILT');
    expect(listed[0]).toContain('cube.chrisproject.org');
    expect(listed[2]).toContain('FOUND · RUNNING');
    expect(listed[2]).toContain('129.158.63.113');
    expect(listed[2]).toContain('web.example.org');
    expect(screen.root.querySelector('.tdc-body')?.textContent).not.toContain('WHAT A ROW OPENS');
    expect(screen.root.querySelector('.tdc-condition-label')?.textContent).toBe('MACHINES IN THE TENANCY');
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
    expect(screen.steps_get().map((step) => [step.label, step.state])).toEqual([['SPEC', null], ['SERVICES', null], ['CHRIS', null], ['USERS', null], ['TEARDOWN', null]]);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="chris"]')?.click();
    await settle();
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toBe('chris deploy lone --profile minimal --compute lone');
    screen.root.querySelector<HTMLButtonElement>('.vm-chris-run')?.click();
    await settle(20);
    // The script is written first (declaration, build, the deploy after the build), then the deploy runs.
    expect(sent[0]?.startsWith("touch --withContents='vm new lone --net chrisproject-services --open 80,443 --vcpu 4")).toBe(true);
    expect(sent[0]?.includes('vm build lone\nchris deploy lone --profile minimal --compute lone')).toBe(true);
    expect(sent[1]).toBe('chris deploy lone --profile minimal --compute lone');
    // A user with no line yet, added on CHRIS, names the machine on screen, never leaving the kernel to pick the ChRIS (walked on the store 2026-11-05).
    [...screen.root.querySelectorAll<HTMLButtonElement>('.takeover-gutter button')].find((seat) => seat.textContent?.trim() === 'CHRIS')?.click();
    await settle();
    // No ChRIS runs there: no user is offered.
    expect(screen.root.querySelector('.vm-account-new')).toBeNull();
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
    // Whether each part stands is read from the tenancy, with when.
    expect(blocks()).toEqual([`STANDS · READ ${STORE_RUNS.at.slice(11, 16)}[tdc-step-stands]`, `STANDS · READ ${STORE_RUNS.at.slice(11, 16)}[tdc-step-stands]`]);
    const row = (steps: Array<[string, string, string | null]>, stands: unknown = undefined) => ({
      name: 'store', state: 'built', region: 'us-ashburn-1', spec: SPEC, address: '203.0.113.10', inside: '10.20.0.5', protected: false, built: '2026-11-01T00:00:00Z', chris: null, stands,
      teardown: { started: '2026-11-04T04:00:00Z', steps: steps.map(([name, state, ended]) => ({ name, state, started: '2026-11-04T04:00:00Z', ended, note: null })) },
    }) as unknown as Parameters<VmScreen['row_take']>[0];
    // A step under way is the act's own word; a part the tenancy was not read for says the word is this host's record.
    screen.row_take(row([['machine', 'running', null], ['data', 'not done', null]]));
    expect(blocks()).toEqual(['GOING · THIS HOST\'S RECORD[tdc-step-going]', 'STANDS · THIS HOST\'S RECORD[tdc-step-stands]']);
    screen.row_take(row([['machine', 'done', '2026-11-04T04:03:00Z'], ['data', 'kept', '2026-11-04T04:03:00Z']]));
    expect(blocks()).toEqual(['GONE · 04:03[tdc-step-gone]', 'STAYS · 04:03[tdc-step-skipped]']);
    // Read back from the tenancy: the machine is not there and the data is, said with when it was read.
    screen.row_take(row([['machine', 'done', '2026-11-04T04:03:00Z'], ['data', 'kept', '2026-11-04T04:03:00Z']], { at: '2026-11-04T04:05:00Z', vcpu: null, memory: null, disk: null, data: 50 }));
    expect(blocks()).toEqual(['GONE · READ 04:05[tdc-step-gone]', 'STAYS · READ 04:05[tdc-step-skipped]']);
    screen.dispose();
    screen.root.remove();
  });

  it('once the machine is gone, the guard offers only what is left to undo, and MACHINE says no machine; gone whole, nothing is offered', async () => {
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle();
    const kept = { name: 'store', state: 'data kept', region: 'us-ashburn-1', spec: SPEC, address: '203.0.113.10', inside: null, protected: false, built: null, chris: null,
      stands: { at: '2026-11-05T16:00:00.000Z', vcpu: null, memory: null, disk: null, data: 50, backup: 'daily', os: null, open: null } } as unknown as Parameters<VmScreen['row_take']>[0];
    screen.row_take(kept);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle(8);
    const guard: HTMLElement = screen.root.querySelector('.ss-col-side') as HTMLElement;
    expect(button_named(guard, 'TEARDOWN')).toBeUndefined();
    expect(button_named(guard, 'TEARDOWN · ALL')).toBeDefined();
    expect(guard.textContent).toContain('The machine is gone; its data stands.');
    expect(guard.textContent).not.toContain('TEARDOWN STOPS');
    // SIZE says the machine is gone and its data stands: a build makes the machine over it.
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-3"]')?.click();
    await settle();
    expect(screen.root.querySelector('.vm-change-lines')?.textContent).toContain('the machine made');
    expect(screen.root.querySelector('.vm-change-lines')?.textContent).toContain('over its data volume (50 GB), which stands');
    screen.row_take({ ...kept, state: 'gone', stands: { ...(kept as unknown as { stands: object }).stands, data: null } } as unknown as Parameters<VmScreen['row_take']>[0]);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    const none: HTMLElement = screen.root.querySelector('.ss-col-side') as HTMLElement;
    expect(none.querySelector('.tdc-note-title')?.textContent).toBe('NOTHING OF IT STANDS');
    expect(none.querySelectorAll('button')).toHaveLength(0);
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
    expect(screen.steps_get().map((step) => step.label)).toEqual(['SPEC', 'SERVICES', 'CHRIS', 'USERS', 'TEARDOWN']);
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
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('FOUND · NOT READ');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    expect(screen.root.querySelector('.tdc-body .tdc-note-title')?.textContent).toBe('PROTECTED');
    button_named(screen.root.querySelector('.tdc-body') as HTMLElement, 'PROTECT · OFF')?.click();
    await settle(20);
    expect(sent).toEqual(['vm protect web off']);
    screen.dispose();
    screen.root.remove();
  });

  it('SERVICES: what the machine opens, a row each; ADD SERVICE writes public SSH on the line; BUILD says the change', async () => {
    STORE_RUNS = { ...STORE_RUNS, open: [80, 443] } as typeof STORE_RUNS;
    try {
      const { screen } = screen_make();
      await screen.vm_open('store');
      await settle(12);
      expect([...screen.root.querySelectorAll('.takeover-gutter button')].map((seat) => seat.textContent?.trim())).toEqual(['SPEC', 'SERVICES', 'CHRIS', 'TEARDOWN', 'LEAVE']);
      screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="services"]')?.click();
      await settle(12);
      const rows: string[] = [...screen.root.querySelectorAll('.vm-services-list .vm-service:not(.vm-service-head)')].map((row) => row.textContent ?? '');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('WEB80Caddy: CUBE answers 200');
      expect(rows[0]).toContain('OPEN');
      expect(screen.root.querySelector('.vm-services-change')?.textContent).toBe('nothing changes · what the line opens is what the tenancy opens');
      // ADD SERVICE: public SSH for ops, its key pasted; the line carries it, and the change names it with the warning.
      [...screen.root.querySelectorAll<HTMLButtonElement>('.vm-service-add .tdc-family')].find((pill) => pill.textContent === 'PUBLIC SSH')?.click();
      await settle(2);
      const key = screen.root.querySelector<HTMLInputElement>('#vm-service-public-key') as HTMLInputElement;
      key.value = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTests op@pangea';
      key.dispatchEvent(new Event('input'));
      button_named(screen.root, 'ADD')?.click();
      await settle(4);
      const line: string = screen.root.querySelector('.vm-services .ss-line-text')?.textContent ?? '';
      expect(line).toContain("--ssh 2222 --ssh-user ops --ssh-key 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTests op@pangea'");
      expect(screen.root.querySelector('.vm-service-ssh')?.textContent).toContain('anyone can knock, only ops\'s key gets in, and ops has sudo');
      // The edit is SERVICES', and the chip names it there and on every seat.
      expect(screen.root.querySelector('.vm-chip-edited')?.textContent).toBe('SERVICES EDITED · NOT BUILT');
      const build = [...screen.root.querySelectorAll<HTMLButtonElement>('.vm-services-change button')][0];
      expect(build?.textContent).toBe('BUILD · public SSH on 2222 for ops');
      screen.dispose();
      screen.root.remove();
    } finally {
      STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };
    }
  });

  it('the VM LOG is shut to its newest line until its strip is pressed', async () => {
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    const stage = screen.root.querySelector('.takeover-stage') as HTMLElement;
    expect(stage.dataset['vmLog']).toBe('shut');
    (screen.root.querySelector('.vm-log-strip') as HTMLElement).click();
    expect(stage.dataset['vmLog']).toBe('open');
    screen.dispose();
    screen.root.remove();
  });

  it('services read off a line, and what they change against what runs', () => {
    const key: string = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTests op@pangea';
    expect(vmServices_read('vm new store --open 443,80', null)).toEqual({ open: [80, 443], ssh: null });
    expect(vmServices_change(vmServices_read('vm new store --open 80,443,8080', null), [80, 443], null)).toEqual(['open 8080']);
    expect(vmServices_change(vmServices_read('vm new store --open 80', null), [80, 443], null)).toEqual(['close 443']);
    const kept = { port: 2222, user: 'ops', key, on: true };
    expect(vmServices_change(vmServices_read('vm new store --open 80,443 --ssh off', kept), [80, 443, 2222], { ports: [80, 443, 2222], ssh: kept })).toEqual(['public SSH on 2222 closed']);
    expect(vmServices_change(vmServices_read('vm new store --open 80,443', kept), [80, 443, 2222], { ports: [80, 443, 2222], ssh: kept })).toEqual([]);
  });

  it('a deploy\'s question reads in the screen\'s words, its buttons saying what they do', () => {
    expect(chrisQuestion_plain('chris deploy store: as deployed; restarts CUBE and porter: their files are written again and Docker restarts what changed in them (this deploy\'s record keeps no versions to compare); no porter session is open now. A NO changes nothing. Continue? [y/N]')).toEqual({
      text: 'Replay ChRIS on store? It restarts CUBE and porter: their files are written again and Docker restarts what changed in them (this deploy\'s record keeps no versions to compare). No porter session is open now.',
      yes: 'YES · REPLAY', no: 'NO · CHANGE NOTHING',
    });
    expect(chrisQuestion_plain('chris deploy store: a first deploy: CUBE (minimal) with its workers, Postgres, dragonfly, nats and pfcon are put up, compute store; the admin password for chris is asked next, hidden (empty: one is generated). A NO changes nothing. Continue? [y/N]')?.yes).toBe('YES · DEPLOY');
    expect(chrisQuestion_plain('vm build store: boot disk 100 → 150 GB. Continue? [y/N]')).toBeNull();
  });

  it('a control offers only what can be done: the operator\'s case, disk 150 → 50 and data 50 → 150 on the store', async () => {
    STORE_RUNS = { ...STORE_RUNS, disk: 150, data: 50 };
    try {
      const { screen, sent } = screen_make();
      await screen.vm_open('store');
      await settle(12);
      // A disk only grows: what runs is the floor of its slider and its box, said ONLY GROWS; less is never offered.
      const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
      const diskBox: HTMLInputElement = screen.root.querySelector('#vm-number-disk') as HTMLInputElement;
      expect(disk.min).toBe('150');
      expect(diskBox.min).toBe('150');
      expect(disk.value).toBe('150');
      expect(screen.root.querySelector('.vm-lever:has(#ss-slider-disk) .tdc-slider-ends')?.textContent).toContain('150 · ONLY GROWS');
      diskBox.value = '50';
      diskBox.dispatchEvent(new Event('input'));
      expect(diskBox.classList.contains('vm-lever-wrong')).toBe(true);
      expect(disk.value).toBe('150');
      // The data change builds alone; nothing is refused, BUILD carries it and its note is true.
      const data: HTMLInputElement = screen.root.querySelector('#vm-number-data') as HTMLInputElement;
      data.value = '150';
      data.dispatchEvent(new Event('input'));
      await settle(2);
      expect([...screen.root.querySelectorAll('.vm-change-line')].map((one) => one.textContent)).toEqual(['data volume 50 → 150 GB · grows online']);
      const build = screen.root.querySelector('.vm-build') as HTMLButtonElement;
      expect(build.disabled).toBe(false);
      expect(build.textContent).toMatch(/^BUILD · data volume 50 → 150 GB/);
      expect(screen.root.querySelector('.vm-commit-says')?.textContent).toMatch(/plans, then asks with the cost before anything bills$/);
      // The OS is fixed while the machine stands.
      expect((screen.root.querySelector('.vm-size input[id^="ss-os-"]') as HTMLInputElement).disabled).toBe(true);
      expect(sent.some((line: string): boolean => line.includes('--disk 50'))).toBe(false);
      screen.dispose();
      screen.root.remove();
    } finally {
      STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };
    }
  });

  it('ADD SERVICE offers only what can be added and says why on itself; CHRIS offers only profiles that exist', async () => {
    expect(serviceDraft_why({ kind: 'CUSTOM', port: '22', user: 'ops', key: '' }, [80, 443], null)).toBe('22 IS SSH: ADD PUBLIC SSH');
    expect(serviceDraft_why({ kind: 'CUSTOM', port: '443', user: 'ops', key: '' }, [80, 443], null)).toBe('443 IS OPEN ALREADY');
    expect(serviceDraft_why({ kind: 'CUSTOM', port: '70000', user: 'ops', key: '' }, [], null)).toBe('A PORT IS 1–65535');
    expect(serviceDraft_why({ kind: 'SSH', port: '2222', user: 'root', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey x' }, [], null)).toBe('A LINUX USER, NOT ROOT OR UBUNTU');
    expect(serviceDraft_why({ kind: 'SSH', port: '2222', user: 'ops', key: '-----BEGIN OPENSSH PRIVATE KEY-----' }, [], null)).toBe('THAT IS A PRIVATE KEY');
    expect(serviceDraft_why({ kind: 'SSH', port: '2222', user: 'ops', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey x' }, [80, 443], null)).toBeNull();
    expect(leverFloor_derive('--disk', 50, 150)).toBe(150);
    expect(leverFloor_derive('--vcpu', 2, 4)).toBe(2);
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="services"]')?.click();
    await settle(4);
    // Both web ports are open: WEB is not offered; ADD is not drawn until the service can be added, what it needs said in its place.
    expect([...screen.root.querySelectorAll('.vm-service-add .tdc-family')].map((pill) => pill.textContent)).toEqual(['CUSTOM', 'PUBLIC SSH']);
    const add = screen.root.querySelector('.vm-service-add-go') as HTMLButtonElement;
    const needs = screen.root.querySelector('.vm-service-needs') as HTMLElement;
    expect(add.hidden).toBe(true);
    expect(needs.textContent).toBe('to add: a port');
    const port = screen.root.querySelector('#vm-service-port') as HTMLInputElement;
    port.value = '22';
    port.dispatchEvent(new Event('input'));
    expect(needs.textContent).toBe('to add: 22 is ssh: add public ssh');
    port.value = '8080';
    port.dispatchEvent(new Event('input'));
    expect(add.hidden).toBe(false);
    expect(add.disabled).toBe(false);
    expect(needs.hidden).toBe(true);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(8);
    // PROFILE is a listing of every profile stratus knows; complete is shown, never offered.
    const profiles = (): string[][] => [...screen.root.querySelectorAll('.vm-profile-listing .listing-row')].map((row) => ['name', 'puts', 'needs', 'state'].map((key) => row.querySelector(`.vm-cell-${key}`)?.textContent ?? ''));
    expect(profiles()).toEqual([
      ['MINIMAL', 'CUBE, workers, Postgres, Dragonfly, NATS, pfcon, Caddy', '2 vCPU · 4 GiB · data 50 GB', 'available · chosen'],
      ['COMPLETE', 'minimal + Orthanc, pfdcm, oxidicom (the PACS side)', 'floor to be set', 'not built yet'],
    ]);
    const complete: HTMLElement = [...screen.root.querySelectorAll<HTMLElement>('.vm-profile-listing .listing-row')][1] as HTMLElement;
    expect(complete.classList.contains('vm-profile-unoffered')).toBe(true);
    complete.click();
    await settle();
    expect(screen.root.querySelector('.vm-chris .ss-line-text')?.textContent).not.toContain('--profile complete');
    screen.dispose();
    screen.root.remove();
  });

  it('ITS USERS: a new user with groups, a held account\'s groups and password, collected into one change block with one APPLY that runs each in turn', async () => {
    const { screen, sent } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(12);
    const type = (id: string, value: string): void => { const input = screen.root.querySelector<HTMLInputElement>(`#vm-account-${id}`) as HTMLInputElement; input.value = value; input.dispatchEvent(new Event('input')); };
    // A new user is a new row; its groups are only the ones CUBE holds, all_users always on.
    button_named(screen.root, '+ NEW USER')?.click();
    await settle();
    // all_users is shown as every account's, never a button; the groups CUBE holds beside it are the choice.
    expect([...screen.root.querySelectorAll<HTMLElement>('.vm-account-groups .tdc-family')].map((pill) => `${pill.textContent}${pill.tagName === 'BUTTON' ? '' : ' (fixed)'}`)).toEqual(['all_users (fixed)', 'pacs_users']);
    type('name', 'ana');
    expect(changeLines(screen.root)).toContain('add user ana · groups all_users · not applied: a name is 4 to 32 letters, digits or . @ + - _');
    type('name', 'ana.lima');
    type('email', 'j@example.org');
    expect(changeLines(screen.root)).toContain('add user ana.lima · groups all_users · not applied: j@example.org is jennings\'s already');
    type('email', 'ana@example.org');
    button_named(screen.root, 'pacs_users')?.click();
    await settle();
    // A held account's groups: pressed, edited, a pending change shown in its row (a password is set in its row, never here).
    const row = (name: string): HTMLElement => [...screen.root.querySelectorAll<HTMLElement>('.vm-account-listing .listing-row')].find((one) => one.querySelector('.vm-cell-name')?.textContent === name) as HTMLElement;
    row('jennings').click();
    await settle();
    button_named(screen.root, 'pacs_users')?.click();
    await settle();
    expect(accountRows(screen.root)[1]).toEqual(['jennings', '4', '4', 'all_users · + pacs_users', 'j@example.org', '•••• set']);
    expect(changeLines(screen.root)).toEqual([
      'add user rudolph · its line in the script',
      'add user ana.lima · groups all_users, pacs_users',
      'groups for jennings: + pacs_users',
    ]);
    const apply: HTMLButtonElement = screen.root.querySelector('.vm-account-apply') as HTMLButtonElement;
    expect(apply.textContent).toBe('APPLY · 3 changes');
    expect(screen.root.querySelector('.vm-account-change .vm-commit-says')?.textContent).toContain('a new user\'s password is asked there hidden, typed twice, or empty for one generated and shown once');
    apply.click();
    await settle(40);
    // The new user's line is saved into the script first, then every change runs in turn, each naming the machine.
    expect(sent[0]?.startsWith('touch --withContents=')).toBe(true);
    expect(sent[0]).toContain('chris user add ana.lima --email ana@example.org --groups pacs_users --on store');
    expect(sent.slice(1)).toEqual([
      'chris user add rudolph --email rudolph@example.org --on store',
      'chris user add ana.lima --email ana@example.org --groups pacs_users --on store',
      'chris user mod jennings --groups pacs_users --on store',
    ]);
    expect([...screen.root.querySelectorAll('.vm-account-run .vm-change-line')].map((line) => line.textContent)).toEqual([
      'add user rudolph · its line in the script · done',
      'add user ana.lima · groups all_users, pacs_users · done',
      'groups for jennings: + pacs_users · done',
    ]);
    screen.dispose();
    screen.root.remove();
  });

  it('ITS USERS: an account the script declares has its line rewritten to the change before it runs, so a replay asks for what CUBE holds', async () => {
    ACCOUNTS = [...ACCOUNTS, { username: 'rudolph', email: 'rudolph@example.org', id: 3, groups: ['all_users'] }];
    try {
      const { screen, sent } = screen_make();
      await screen.vm_open('store');
      await settle(12);
      screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
      await settle(12);
      // Nothing pending: no APPLY, no change block, no note.
      expect(changeLines(screen.root).some((line) => /password/.test(line))).toBe(false);
      expect((screen.root.querySelector('.vm-account-change') as HTMLElement).hidden).toBe(true);
      ([...screen.root.querySelectorAll<HTMLElement>('.vm-account-listing .listing-row')].find((one) => one.querySelector('.vm-cell-name')?.textContent === 'rudolph') as HTMLElement).click();
      await settle();
      // A row with nothing changed offers no UNDO.
      expect(button_named(screen.root, 'UNDO ITS CHANGES')?.hidden).toBe(true);
      const email = screen.root.querySelector<HTMLInputElement>('#vm-account-email') as HTMLInputElement;
      email.value = 'rp@example.org';
      email.dispatchEvent(new Event('input'));
      button_named(screen.root, 'pacs_users')?.click();
      await settle();
      expect(changeLines(screen.root)).toEqual(['email for rudolph: rudolph@example.org → rp@example.org · groups + pacs_users']);
      expect(button_named(screen.root, 'UNDO ITS CHANGES')?.hidden).toBe(false);
      expect(screen.root.querySelector('.vm-account-change .vm-commit-says')?.textContent).toContain('an account the script declares has its line rewritten to match, saved first');
      (screen.root.querySelector('.vm-account-apply') as HTMLButtonElement).click();
      await settle(30);
      expect(sent[0]).toContain('chris user add rudolph --email rp@example.org --on store --groups pacs_users');
      expect(sent[1]).toBe('chris user mod rudolph --email rp@example.org --groups pacs_users --on store');
      screen.dispose();
      screen.root.remove();
    } finally {
      ACCOUNTS = ACCOUNTS.filter((one) => one.username !== 'rudolph');
    }
  });

  it('a password is set in its row: typed twice and matched as typed, SET in the row, the engine answered from it, never in the log, a line or the page after', async () => {
    const { screen, sent, fed } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(12);
    const row = (name: string): HTMLElement => [...screen.root.querySelectorAll<HTMLElement>('.vm-account-listing .listing-row')].find((one) => one.querySelector('.vm-cell-name')?.textContent === name) as HTMLElement;
    const type = (id: string, value: string): void => { const input = screen.root.querySelector<HTMLInputElement>(`#vm-account-${id}`) as HTMLInputElement; input.value = value; input.dispatchEvent(new Event('input')); };
    const set = (): HTMLButtonElement | null => screen.root.querySelector<HTMLButtonElement>('.vm-password-set');
    row('jennings').click();
    await settle();
    // Masked, both; SET is not drawn until the two match and are long enough.
    expect([...screen.root.querySelectorAll<HTMLInputElement>('.vm-password-input')].map((input) => `${input.id}:${input.type}`)).toEqual(['vm-account-password:password', 'vm-account-retype:password']);
    expect(set()?.hidden).toBe(true);
    type('password', 'short');
    expect(screen.root.querySelector('.vm-password-check')?.textContent).toBe('at least 8 characters');
    type('password', 'a-secret-for-jennings');
    type('retype', 'a-secret-for-jenning');
    expect(screen.root.querySelector('.vm-password-check')?.textContent).toBe('the two differ');
    expect(set()?.hidden).toBe(true);
    type('retype', 'a-secret-for-jennings');
    expect(screen.root.querySelector('.vm-password-check')?.textContent).toBe('the two match');
    expect(set()?.hidden).toBe(false);
    expect(set()?.textContent).toBe('SET PASSWORD · jennings');
    // An ordinary account: set at the press, nothing asked on the strip; the row answers the engine's two hidden questions.
    set()?.click();
    await settle(20);
    expect(sent).toEqual(['chris passwd jennings --on store']);
    expect(fed).toEqual(['a-secret-for-jennings', 'a-secret-for-jennings']);
    expect((screen.root.querySelector('.tdc-strip') as HTMLElement).hidden).toBe(true);
    expect(accountRows(screen.root)[1]?.[5]).toMatch(/^password set · \d\d:\d\d$/);
    expect(screen.root.querySelector('.vm-password-receipt')?.textContent).toMatch(/^password set · \d\d:\d\d UTC$/);
    // Never in the log, the lines sent, or the page.
    const log: string = [...screen.root.querySelectorAll('.tdc-log-line')].map((line) => line.textContent).join('\n');
    expect(log).not.toContain('a-secret-for-jennings');
    expect(sent.join('\n')).not.toContain('a-secret-for-jennings');
    expect(screen.root.outerHTML).not.toContain('a-secret-for-jennings');
    expect([...screen.root.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === 'a-secret-for-jennings')).toBe(false);
    // The admin's: GENERATE fills both and shows it once; SET asks here, in the row; YES answers the engine's restart question from the row.
    row('chris · admin').click();
    await settle();
    expect(screen.root.querySelector('.vm-account-password')?.textContent).toContain('a new password for chris restarts CUBE, asked here first');
    button_named(screen.root, 'GENERATE')?.click();
    const made: string = (screen.root.querySelector<HTMLInputElement>('#vm-account-password') as HTMLInputElement).value;
    expect(made).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((screen.root.querySelector<HTMLInputElement>('#vm-account-retype') as HTMLInputElement).value).toBe(made);
    expect(screen.root.querySelector('.vm-password-generated')?.textContent).toBe(`generated: ${made} · shown this once: keep it now`);
    set()?.click();
    await settle();
    expect(sent).toHaveLength(1);
    expect(screen.root.querySelector('.vm-password-ask')?.textContent).toContain('CUBE starts again to take it');
    button_named(screen.root, 'YES · SET AND RESTART CUBE')?.click();
    await settle(20);
    expect(sent.at(-1)).toBe('chris passwd chris --on store');
    expect(fed.slice(2)).toEqual(['y', made, made]);
    expect(screen.root.outerHTML).not.toContain(made);
    expect([...screen.root.querySelectorAll('.tdc-log-line')].map((line) => line.textContent).join('\n')).not.toContain(made);
    expect(screen.root.querySelector('.vm-password-receipt')?.textContent).toMatch(/^password set · \d\d:\d\d UTC · CUBE took it$/);
    // Passwords are never in the change block.
    expect(changeLines(screen.root).some((line) => /password/.test(line))).toBe(false);
    screen.dispose();
    screen.root.remove();
  });

  it('CHRIS settings are a listing: FIELD · SET TO · RUNS, a value edited in place, one the engine would refuse marked and never kept, a row that differs from what runs marked', async () => {
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(12);
    const rows = (): string[][] => [...screen.root.querySelectorAll('.vm-setting-listing .listing-row')].map((row) => ['field', 'set', 'runs'].map((key) => row.querySelector(`.vm-cell-${key}`)?.textContent ?? ''));
    expect(rows()).toEqual([
      ['COMPUTE', 'NERC', 'NERC'],
      ['HOST', 'cube.chrisproject.org', 'cube.chrisproject.org'],
      ['PORTER', 'none · changes', 'porter.chrisproject.org'],
      ['BERTHS', 'off · changes', 'on'],
      ['BERTH CPU', '—', '2'],
      ['BERTH MEMORY', '—', '4 GiB'],
    ]);
    expect(screen.root.querySelectorAll('.vm-chris .tdc-name-row')).toHaveLength(0);
    const host = (): HTMLElement => [...screen.root.querySelectorAll<HTMLElement>('.vm-setting-listing .listing-row')][1] as HTMLElement;
    host().click();
    await settle();
    const input = screen.root.querySelector<HTMLInputElement>('#vm-setting-host') as HTMLInputElement;
    expect(input.value).toBe('cube.chrisproject.org');
    input.value = 'not a host';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(input.classList.contains('vm-lever-wrong')).toBe(true);
    expect(screen.root.querySelector('.vm-setting-edit .vm-lever-hint')?.textContent).toBe('a host name, as cube.example.org');
    input.value = 'cube2.chrisproject.org';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(rows()[1]).toEqual(['HOST', 'cube2.chrisproject.org · changes', 'cube.chrisproject.org']);
    expect(host().classList.contains('vm-setting-edited')).toBe(true);
    expect(screen.root.querySelector('.vm-chris .ss-line-text')?.textContent).toContain('--host cube2.chrisproject.org');
    // A setting that changes brings the change block; the quiet replay line goes.
    await settle(8);
    expect(screen.root.querySelector('.vm-chris-change')?.textContent).toContain('host cube.chrisproject.org → cube2.chrisproject.org');
    expect(screen.root.querySelector('.vm-replay-quiet')).toBeNull();
    screen.dispose();
    screen.root.remove();
  });
  it('the CHRIS and SPEC bands say how many berths the machine holds: of the shape it stands in on CHRIS, of the shape the line declares on SPEC, and nothing when berths are off', async () => {
    STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 6, memory: 16, disk: 50, data: 50 };
    const { screen } = screen_make();
    await screen.vm_open('store');
    await settle(12);
    // SPEC: the line declares 2 vCPU and 8 GiB, which holds none above the minimal profile's floor at 2 CPUs and 4 GiB a berth.
    expect(screen.root.querySelector('.vm-size .tdc-section-aside')?.textContent).toBe('RUNS AS READ FROM THE TENANCY 04:48 UTC · HOLDS 0 BERTHS');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-5"]')?.click();
    await settle(12);
    // CHRIS: the machine stands at 6 vCPU and 16 GiB: (6-2)/2 and (16-4)/4 are 2 and 3.
    expect(screen.root.querySelector('.vm-chris .tdc-section-aside')?.textContent).toBe('READ FROM IT 06:00 UTC · HOLDS 2 BERTHS');
    screen.dispose();
    screen.root.remove();
    STORE_RUNS = { at: '2026-11-05T04:48:00.000Z', vcpu: 2, memory: 8, disk: 50, data: 50 };
  });
});
