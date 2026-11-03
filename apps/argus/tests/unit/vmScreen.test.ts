/**
 * @jest-environment jsdom
 */
/**
 * @file The VM controller: opened on a machine the library declares, its
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

/** The session's answers: a library with store.mise, two machines kept (store from the script, lone from nothing). */
function answer_make(line: string, mine: string[]): QuietAnswer {
  const envelope = (model: { kind: string; data: unknown }, rendered: string = ''): QuietAnswer => ({ envelopes: [{ rendered, model, status: 'ok' }] });
  if (line === 'vm status') return envelope({ kind: 'stratus.vm.status', data: { vms: [
    { name: 'store', state: 'built', region: 'us-ashburn-1', spec: SPEC, address: '203.0.113.10', inside: '10.20.0.5', protected: false, built: '2026-11-01T00:00:00Z', chris: { profile: 'minimal', compute: 'NERC', host: 'cube.chrisproject.org', url: 'https://cube.chrisproject.org/api/v1/', porter: null } },
    { name: 'lone', state: 'declared', region: 'us-ashburn-1', spec: { ...SPEC, vcpu: 4 }, address: null, inside: null, protected: true, built: null, chris: null },
  ] } });
  if (line === 'ls /scripts') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts', items: [{ name: 'mine', type: 'dir' }, { name: 'chrisproject', type: 'source', status: 'cloned', title: 'git@github.com:HARBOR-Medical-AI/infra.git' }] }] });
  if (line === 'ls /scripts/mine') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/mine', items: mine.map((name: string) => ({ name, type: 'script' })) }] });
  if (line === 'ls /scripts/chrisproject') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/chrisproject', items: [{ name: 'store.mise', type: 'script' }] }] });
  if (line.startsWith('cat ')) return { envelopes: [{ rendered: `${STORE_TEXT}\n`, status: 'ok' }] };
  if (line.startsWith('play ') && line.endsWith('--status')) {
    const text: string = line.includes('store.mise') ? STORE_TEXT : '';
    const lines = text === '' ? [] : text.split('\n').map((each: string, index: number) => ({ number: index + 1, text: each, state: index < 5 ? 'done' : 'ready', detail: '' }));
    if (text === '') return { envelopes: [{ rendered: '', renderedErr: 'play: no such file\n', status: 'error' }] };
    return envelope({ kind: 'manifest.status', data: { manifest: 'store', lines } });
  }
  if (line === 'vm limits') return envelope({ kind: 'stratus.vm.limits', data: LIMITS });
  if (line.startsWith('vm cost')) return envelope({ kind: 'stratus.vm.cost', data: { vms: [{ name: 'store', declared: true, spec: SPEC, cost: { machineHour: 0.052, dataHour: 0.003, currency: 'USD' }, changes: [], before: null }] } });
  return { envelopes: [{ rendered: '', status: 'ok' }] };
}

function screen_make(mine: string[] = []): { screen: VmScreen; sent: string[]; asked: string[] } {
  const sent: string[] = [];
  const asked: string[] = [];
  const hooks: ScriptHooks = {
    run: async (line: string): Promise<void> => { sent.push(line); },
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
  it('opens on a machine the library declares: its lines as SIZE, BUILD, CHRIS, USERS, then TEARDOWN; a pill per machine and + NEW; the machine\'s facts in the header', async () => {
    const { screen, asked } = screen_make();
    await screen.vm_open('store');
    await settle();
    expect(asked).toContain('vm status');
    expect(screen.vm_get()).toBe('store');
    expect(screen.path_get()).toBe('/scripts/chrisproject/store.mise');
    expect(screen.steps_get().map((step) => step.label)).toEqual(['SIZE', 'BUILD', 'CHRIS', 'USERS', 'TEARDOWN']);
    expect([...screen.root.querySelectorAll('.takeover-seat .tdc-cluster')].map((pill) => pill.textContent)).toEqual(['STORE', 'LONE', '+ NEW']);
    expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('BUILT');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('203.0.113.10');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('cube.chrisproject.org');
    expect(document.title).toBe('BUILT · store');
    // The rail opens on the first seat needing the operator: USERS (ready); BUILD carries no lock here, TEARDOWN does.
    expect(screen.view_get()).toBe('users');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-4"]')?.click();
    await settle();
    const body: HTMLElement = screen.root.querySelector('.tdc-body') as HTMLElement;
    expect(button_named(body, 'TEARDOWN')).toBeUndefined();
    expect(button_named(body, 'RUN')?.title).toContain('vm build store');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="teardown"]')?.click();
    await settle();
    expect(screen.root.querySelector('.tdc-note-title')?.textContent).toBe('UNLOCKED');
    expect(button_named(body, 'TEARDOWN')?.title).toContain('vm teardown store');
    expect(button_named(body, 'TEARDOWN · ALL')?.title).toContain('--all');
    screen.dispose();
    screen.root.remove();
  });

  it('a new machine: named and committed, its script is written under mine and the line declares it; then it is a machine of the gutter', async () => {
    const { screen, sent } = screen_make();
    await screen.vm_open('');
    await settle();
    expect(screen.view_get()).toBe('new');
    expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('NEW');
    const commit: HTMLButtonElement | undefined = button_named(screen.root, 'COMMIT · NAME IT');
    expect(commit?.disabled).toBe(true);
    const name: HTMLInputElement = screen.root.querySelector('#vm-new-name') as HTMLInputElement;
    name.value = 'Blt';
    name.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'COMMIT · NAME IS A HOSTNAME')?.disabled).toBe(true);
    name.value = 'store';
    name.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'COMMIT · ALREADY KEPT')?.disabled).toBe(true);
    name.value = 'blt';
    name.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector('.vm-new-line')?.textContent).toBe('vm new blt --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04');
    button_named(screen.root, 'COMMIT')?.click();
    await settle(20);
    expect(sent[0]?.startsWith("touch --withContents='vm new blt --net chrisproject-services")).toBe(true);
    expect(sent[0]?.includes('vm build blt')).toBe(true);
    expect(sent[0]?.endsWith("' '/scripts/mine/blt.mise'")).toBe(true);
    expect(sent[1]).toBe('vm new blt --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04');
    screen.dispose();
    screen.root.remove();
  });

  it('a machine the host keeps with no script gets its script from its record, written at the first act; CHRIS not in the script is appended by RUN', async () => {
    const { screen, sent } = screen_make();
    await screen.vm_open('lone');
    await settle();
    expect(screen.path_get()).toBe('/scripts/mine/lone.mise');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('SCRIPT NOT WRITTEN YET');
    expect(screen.steps_get().map((step) => [step.label, step.state])).toEqual([['SIZE', null], ['BUILD', null], ['CHRIS', null], ['USERS', null], ['TEARDOWN', null]]);
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
});
