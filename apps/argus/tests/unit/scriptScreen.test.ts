/**
 * @jest-environment jsdom
 */
/**
 * @file The script screen: the library listed from `ls /scripts`, a script
 * opened makes its lines the rail with each seat's state, a step's RUN sends
 * its line as it stands after the form changed it, VM NEW's sliders come from
 * `vm limits` and re-ask `vm cost`, the engine's question stands on the
 * strip, and the user lines gather under USERS where ADD appends and sends.
 */
import { describe, it, expect } from '@jest/globals';
import { ScriptScreen, type QuietAnswer, type ScriptHooks } from '../../src/features/script/screen.js';

const STORE_TEXT: string = [
  'net new chrisproject-services --cidr 10.20.0.0/16',
  'vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04',
  'vm build store',
  'chris deploy store --profile minimal --compute NERC --host cube.chrisproject.org',
  'chris user add rudolph --email rudolph@example.org',
].join('\n');

const LIMITS = { shape: 'VM.Standard.E5.Flex', family: 'E5', vcpu: { min: 2, max: 252, step: 2 }, memory: { min: 1, max: 2098, perVcpu: { min: 0.5, max: 32 } }, disk: { min: 50, max: 32768 }, data: { min: 50, max: 32768 } };

/** The session's answers to the screen's quiet lines, as a fake stratus would give them. */
function answer_make(line: string, states: string[]): QuietAnswer {
  const envelope = (model: { kind: string; data: unknown }, rendered: string = ''): QuietAnswer => ({ envelopes: [{ rendered, model, status: 'ok' }] });
  if (line === 'ls /scripts') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts', items: [{ name: 'chrisproject', type: 'source', status: 'cloned', title: 'git@github.com:HARBOR-Medical-AI/infra.git chrisproject' }, { name: 'mine', type: 'dir' }] }] });
  if (line === 'ls /scripts/chrisproject') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/chrisproject', items: [{ name: 'store.mise', type: 'script' }] }] });
  if (line === 'ls /scripts/mine') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/mine', items: [] }] });
  if (line.startsWith('cat ')) return { envelopes: [{ rendered: `${STORE_TEXT}\n`, status: 'ok' }] };
  if (line.startsWith('play ') && line.endsWith('--status')) {
    const lines = STORE_TEXT.split('\n').map((text: string, index: number) => ({ number: index + 1, text, state: states[index] ?? null, detail: states[index] === 'done' ? 'unchanged' : '' }));
    return envelope({ kind: 'manifest.status', data: { manifest: 'store', lines } });
  }
  if (line === 'vm limits') return envelope({ kind: 'stratus.vm.limits', data: LIMITS });
  if (line.startsWith('vm cost')) {
    const memory: number = Number(line.match(/--memory (\d+)/)?.[1] ?? 8);
    const spec = { net: 'chrisproject-services', open: [80, 443], vcpu: 2, memory, disk: 50, data: 50, dataBackup: 'daily', os: 'ubuntu-26.04' };
    const cost = { machineHour: 0.04 + memory * 0.0015, dataHour: 0.003, currency: 'USD' };
    const row = line === 'vm cost' ? { name: 'store', declared: true, spec, cost, changes: [], before: null } : { name: 'store', declared: true, spec, cost, changes: memory === 8 ? [] : [`memory 8 → ${memory}`], before: memory === 8 ? null : { machineHour: 0.052, dataHour: 0.003, currency: 'USD' } };
    return envelope({ kind: 'stratus.vm.cost', data: { vms: [row] } });
  }
  return { envelopes: [{ rendered: '', status: 'ok' }] };
}

/** A screen over hooks that record the lines sent and asked. */
function screen_make(states: string[] = ['done', 'done', 'done', 'done', 'ready']): { screen: ScriptScreen; sent: string[]; asked: string[]; hooks: ScriptHooks; answers: Array<(value: string | null) => void> } {
  const sent: string[] = [];
  const asked: string[] = [];
  const hooks: ScriptHooks = {
    run: async (line: string): Promise<void> => { sent.push(line); },
    ask: async (line: string): Promise<QuietAnswer> => { asked.push(line); return answer_make(line, states); },
    stop: (): void => { sent.push('<stop>'); },
    leave: (): void => { sent.push('<leave>'); },
    voice: { pill: (): void => undefined, cue: (): void => undefined },
  };
  const screen: ScriptScreen = new ScriptScreen(hooks);
  document.body.append(screen.root);
  return { screen, sent, asked, hooks, answers: [] };
}

const button_named = (root: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((button: HTMLButtonElement): boolean => (button.textContent ?? '').trim() === text);

const settle = async (rounds: number = 6): Promise<void> => { for (let i: number = 0; i < rounds; i++) await new Promise((resolve) => { setTimeout(resolve, 0); }); };

describe('the script screen', () => {
  it('opens on the library: the scripts listed with where each stands, and OPEN makes a script the rail', async () => {
    const { screen, asked } = screen_make();
    await screen.open('');
    await settle();
    expect(screen.view_get()).toBe('library');
    expect(asked).toEqual(expect.arrayContaining(['ls /scripts', 'ls /scripts/chrisproject', 'ls /scripts/mine', 'play /scripts/chrisproject/store.mise --status']));
    expect(screen.root.querySelector('.ss-script-name')?.textContent).toBe('store');
    expect(screen.root.querySelector('.ss-script-standing')?.textContent).toBe('4 DONE · 1 READY');
    expect(document.title).toBe('LIBRARY · SCRIPTS');
    button_named(screen.root, 'OPEN')?.click();
    await settle();
    expect(screen.path_get()).toBe('/scripts/chrisproject/store.mise');
    expect(screen.steps_get().map((step) => [step.label, step.state])).toEqual([['NET NEW', 'done'], ['VM NEW', 'done'], ['VM BUILD', 'done'], ['CHRIS DEPLOY', 'done'], ['USERS', 'ready']]);
    // The rail opens on the first step that needs the operator, and each seat wears its state.
    expect(screen.view_get()).toBe('users');
    expect([...screen.root.querySelectorAll('.takeover-gutter button[data-state]')].map((seat) => seat.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'done', 'ready']);
    expect(document.title).toBe('4 DONE · 1 READY · store');
    screen.dispose();
    screen.root.remove();
  });

  it('a step\'s RUN sends its line as the form left it, and the standing is read again after', async () => {
    const { screen, sent, asked } = screen_make();
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-1"]')?.click();
    await settle();
    expect(screen.view_get()).toBe('line-1');
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toBe('net new chrisproject-services --cidr 10.20.0.0/16');
    const cidr: HTMLInputElement | null = screen.root.querySelector('#ss-cidr-1');
    expect(cidr?.value).toBe('10.20.0.0/16');
    cidr!.value = '10.30.0.0/16';
    cidr!.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toBe('net new chrisproject-services --cidr 10.30.0.0/16');
    asked.length = 0;
    button_named(screen.root, 'RUN')?.click();
    await settle();
    expect(sent).toEqual(['net new chrisproject-services --cidr 10.30.0.0/16']);
    expect(asked).toContain('play /scripts/chrisproject/store.mise --status');
    // Edited: the side column offers SAVE to the working copy.
    expect(screen.root.querySelector('.tdc-note-title')?.textContent).toBe('EDITED · NOT SAVED');
    button_named(screen.root, 'SAVE')?.click();
    await settle();
    expect(sent[1]?.startsWith("touch --withContents='net new chrisproject-services --cidr 10.30.0.0/16")).toBe(true);
    expect(sent[1]?.endsWith("' '/scripts/mine/store.mise'")).toBe(true);
    expect(screen.path_get()).toBe('/scripts/mine/store.mise');
    screen.dispose();
    screen.root.remove();
  });

  it('VM NEW\'s sliders come from vm limits, move the line and re-ask vm cost; the cost column and the header show it', async () => {
    const { screen, asked } = screen_make();
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
    await settle();
    expect(asked).toContain('vm limits');
    const memory: HTMLInputElement | null = screen.root.querySelector('#ss-slider-memory');
    expect(memory).not.toBeNull();
    expect(memory?.min).toBe('1');
    // Two vCPUs allow 64 GiB at most.
    expect(memory?.max).toBe('64');
    expect(memory?.value).toBe('8');
    memory!.value = '16';
    memory!.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toContain('--memory 16');
    // The price is asked a moment after the last move.
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    await settle();
    expect(asked.at(-1)).toBe('vm cost store --net chrisproject-services --open 80,443 --vcpu 2 --memory 16 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04');
    expect(screen.root.querySelector('.ss-cost')?.textContent).toContain('memory 8 → 16');
    expect(screen.root.querySelector('.ss-cost')?.textContent).toContain('AS DECLARED');
    expect(screen.root.querySelector('.ss-header')?.textContent).toContain('THIS STEP');
    screen.dispose();
    screen.root.remove();
  });

  it('the engine\'s question stands on the strip: CONTINUE sends y, a hidden word is typed unseen', async () => {
    const { screen } = screen_make();
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    const answered: Promise<string | null> = screen.ask_take('store: build it at $0.052 an hour? [y/N] ', 'confirm');
    expect(screen.asking_is()).toBe(true);
    const strip: HTMLElement | null = screen.root.querySelector('.tdc-strip');
    expect(strip?.hidden).toBe(false);
    expect(strip?.dataset['tone']).toBe('bill');
    button_named(strip as HTMLElement, 'CONTINUE')?.click();
    expect(await answered).toBe('y');
    expect(screen.asking_is()).toBe(false);
    const secret: Promise<string | null> = screen.ask_take('password for rudolph (empty: generate one): ', 'secret');
    const input: HTMLInputElement | null = screen.root.querySelector('#ss-strip-input');
    expect(input?.type).toBe('password');
    input!.value = 'hunter2';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await secret).toBe('hunter2');
    expect([...screen.root.querySelectorAll('.tdc-log-answer')].map((row) => row.textContent)).toEqual(['y', '(hidden)']);
    screen.dispose();
    screen.root.remove();
  });

  it('USERS gathers the user lines; ADD is held until a login and an address stand, then appends the line and sends it', async () => {
    const { screen, sent } = screen_make();
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    expect(screen.view_get()).toBe('users');
    expect(screen.root.querySelectorAll('.ss-users .ss-line').length).toBe(1);
    expect(button_named(screen.root, 'ADD · NAME')?.disabled).toBe(true);
    const name: HTMLInputElement = screen.root.querySelector('#ss-user-name') as HTMLInputElement;
    name.value = 'jennings';
    name.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'ADD · EMAIL')?.disabled).toBe(true);
    const email: HTMLInputElement = screen.root.querySelector('#ss-user-email') as HTMLInputElement;
    email.value = 'jennings@example.org';
    email.dispatchEvent(new Event('input'));
    const add: HTMLButtonElement | undefined = button_named(screen.root, 'ADD');
    expect(add?.disabled).toBe(false);
    expect(screen.root.querySelector('.ss-user-line')?.textContent).toBe('chris user add jennings --email jennings@example.org');
    add?.click();
    await settle();
    expect(sent).toEqual(['chris user add jennings --email jennings@example.org']);
    expect(screen.root.querySelectorAll('.ss-users .ss-line').length).toBe(2);
    screen.dispose();
    screen.root.remove();
  });
});
