/**
 * @jest-environment jsdom
 */
/**
 * @file The script screen: the library listed from `ls /scripts`, a script
 * opened makes its lines the rail with each seat's state, a step's pill sends
 * its line as it stands after the form changed it, VM NEW's sliders come from
 * `vm limits` and re-ask `vm cost` (the newest answer wins, the price list's
 * read said), VM NEW holds its build (DECLARE, BUILD, and the note a
 * declaration not built wears), the engine's question stands on the strip,
 * and the user lines gather under USERS where ADD appends and sends.
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

/** The task running a line now, by line number, as `play --status` would carry it. */
let runningAt: Record<number, string> = {};

/** What `play --status` says of a line, by line number, beyond its state's usual word. */
let detailAt: Record<number, string> = {};

/** The session's answers to the screen's quiet lines, as a fake stratus would give them. */
function answer_make(line: string, states: string[]): QuietAnswer {
  const envelope = (model: { kind: string; data: unknown }, rendered: string = ''): QuietAnswer => ({ envelopes: [{ rendered, model, status: 'ok' }] });
  if (line === 'ls /scripts') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts', items: [{ name: 'chrisproject', type: 'source', status: 'cloned', title: 'git@github.com:HARBOR-Medical-AI/infra.git chrisproject' }, { name: 'mine', type: 'dir' }] }] });
  if (line === 'ls /scripts/chrisproject') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/chrisproject', items: [{ name: 'store.mise', type: 'script' }] }] });
  if (line === 'ls /scripts/mine') return envelope({ kind: 'fs.listing', data: [{ path: '/scripts/mine', items: [] }] });
  if (line.startsWith('cat ')) return { envelopes: [{ rendered: `${STORE_TEXT}\n`, status: 'ok' }] };
  if (line.startsWith('play ') && line.endsWith('--status')) {
    const lines = STORE_TEXT.split('\n').map((text: string, index: number) => ({ number: index + 1, text, state: states[index] ?? null, detail: detailAt[index + 1] ?? (states[index] === 'done' ? 'unchanged' : ''), ...(runningAt[index + 1] === undefined ? {} : { running: runningAt[index + 1] }) }));
    return envelope({ kind: 'manifest.status', data: { manifest: 'store', lines } });
  }
  if (line === 'vm limits') return envelope({ kind: 'stratus.vm.limits', data: LIMITS });
  if (line === 'net status chrisproject-services') return envelope({ kind: 'stratus.net.status', data: { read: '2026-11-05T06:10:00.000Z', nets: [{ name: 'chrisproject-services', state: 'built', cidr: '10.20.0.0/16', builtCidr: '10.20.0.0/16', stack: { id: 'ocid1.ormstack.net', state: 'active' }, bastion: 'ocid1.bastion.net', admits: '134.174.21.21/32', subnet: 'ocid1.subnet.net' }] } });
  if (line.startsWith('vm cost')) {
    const memory: number = Number(line.match(/--memory (\d+)/)?.[1] ?? 8);
    const spec = { net: 'chrisproject-services', open: [80, 443], vcpu: 2, memory, disk: 50, data: 50, dataBackup: 'daily', os: 'ubuntu-26.04' };
    const cost = { machineHour: 0.04 + memory * 0.0015, dataHour: 0.003, currency: 'USD' };
    const row = line === 'vm cost' ? { name: 'store', declared: true, spec, cost, changes: [], before: null } : { name: 'store', declared: true, spec, cost, changes: memory === 8 ? [] : [`memory 8 → ${memory}`], before: memory === 8 ? null : { machineHour: 0.052, dataHour: 0.003, currency: 'USD' } };
    return envelope({ kind: 'stratus.vm.cost', data: { vms: [row], pricesRead: '2026-11-04T23:41:00.000Z' } });
  }
  return { envelopes: [{ rendered: '', status: 'ok' }] };
}

/** A screen over hooks that record the lines sent and asked; with `held`, a sent line holds the lane until `release` is called; a line starting with one of `refused` ends in an error. */
function screen_make(states: string[] = ['done', 'done', 'done', 'done', 'ready'], held: boolean = false, manage: boolean | null = true, elevate: ((line: string) => Promise<boolean>) | null = null, refused: string[] = []): { screen: ScriptScreen; sent: string[]; asked: string[]; hooks: ScriptHooks; release: () => void } {
  const sent: string[] = [];
  const asked: string[] = [];
  let releases: Array<() => void> = [];
  const hooks: ScriptHooks = {
    run: (line: string): Promise<boolean> => {
      sent.push(line);
      const clean: boolean = !refused.some((start: string): boolean => line.startsWith(start));
      return held ? new Promise((resolve: (clean: boolean) => void): void => { releases.push((): void => resolve(clean)); }) : Promise.resolve(clean);
    },
    ask: async (line: string): Promise<QuietAnswer> => { asked.push(line); return answer_make(line, states); },
    stop: (): void => { sent.push('<stop>'); },
    leave: (): void => { sent.push('<leave>'); },
    manage_is: (): boolean | null => manage,
    elevate_ask: elevate,
    voice: { pill: (): void => undefined, cue: (): void => undefined },
  };
  const screen: ScriptScreen = new ScriptScreen(hooks);
  document.body.append(screen.root);
  return { screen, sent, asked, hooks, release: (): void => { const pending: Array<() => void> = releases; releases = []; for (const resolve of pending) resolve(); } };
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
    // VM NEW holds the build after it: one seat declares and builds.
    expect(screen.steps_get().map((step) => [step.label, step.state])).toEqual([['NET NEW', 'done'], ['VM NEW', 'done'], ['CHRIS DEPLOY', 'done'], ['USERS', 'ready']]);
    // The rail opens on the first step that needs the operator, and each seat wears its state.
    expect(screen.view_get()).toBe('users');
    expect([...screen.root.querySelectorAll('.takeover-gutter button[data-state]')].map((seat) => seat.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'ready']);
    expect(document.title).toBe('4 DONE · 1 READY · store');
    screen.dispose();
    screen.root.remove();
  });

  it('a step\'s pill sends its line as the form left it, and the standing is read again after', async () => {
    const { screen, sent, asked } = screen_make();
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-1"]')?.click();
    await settle();
    expect(screen.view_get()).toBe('line-1');
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toBe('net new chrisproject-services --cidr 10.20.0.0/16');
    // What stands of the network, read from the tenancy, beside its line.
    await settle();
    const stands: string = screen.root.querySelector('.ss-col-side')?.textContent ?? '';
    expect(stands).toContain('THE NETWORK · AS IT STANDS');
    expect(stands).toContain('READ FROM THE TENANCY 06:10 UTC');
    expect(stands).toContain('10.20.0.0/16 (as built)');
    expect(stands).toContain('ACTIVE · ocid1.ormstack.net');
    expect(stands).toContain('admits 134.174.21.21/32');
    const cidr: HTMLInputElement | null = screen.root.querySelector('#ss-cidr-1');
    expect(cidr?.value).toBe('10.20.0.0/16');
    cidr!.value = '10.30.0.0/16';
    cidr!.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector('.ss-line-text')?.textContent).toBe('net new chrisproject-services --cidr 10.30.0.0/16');
    asked.length = 0;
    // A declaration's pill says what it does: DECLARE.
    button_named(screen.root, 'DECLARE')?.click();
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

  it('VM NEW holds its build: BUILD sends the declaration as shown and then the build, and a refused declaration builds nothing', async () => {
    const { screen, sent } = screen_make(['done', 'done', 'done', 'done', 'ready'], false, true, null, ['vm new']);
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
    await settle();
    // Both lines stand under the seat, and its pills are DECLARE and BUILD, the build in the billing tone.
    expect([...screen.root.querySelectorAll('.ss-line-text')].map((line) => line.textContent)).toEqual([expect.stringContaining('vm new store'), 'vm build store']);
    expect(button_named(screen.root, 'BUILD')?.classList.contains('tdc-pill-bill')).toBe(true);
    expect(button_named(screen.root, 'RUN')).toBeUndefined();
    const disk: HTMLInputElement = screen.root.querySelector('#ss-slider-disk') as HTMLInputElement;
    disk.value = '180';
    disk.dispatchEvent(new Event('input'));
    expect(button_named(screen.root, 'BUILD')?.title).toBe('sends: vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 180 --data 50 --data-backup daily --os ubuntu-26.04, then vm build store');
    button_named(screen.root, 'BUILD')?.click();
    await settle();
    expect(sent).toEqual(['vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 180 --data 50 --data-backup daily --os ubuntu-26.04']);
    screen.dispose();
    screen.root.remove();
  });

  it('a declaration not built says so beside its price, with what a build would change; built, the note goes', async () => {
    detailAt = { 3: 'declared, not built: disk 50 → 180; the build plans and asks' };
    try {
      const { screen } = screen_make(['done', 'done', 'changed', 'done', 'ready']);
      await screen.open('/scripts/chrisproject/store.mise');
      await settle();
      expect(screen.steps_get()[1]?.state).toBe('changed');
      screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
      await settle();
      const note: HTMLElement | null = screen.root.querySelector('.tdc-col-cost .ss-note-declared');
      expect(note?.querySelector('.tdc-note-title')?.textContent).toBe('DECLARED · NOT BUILT');
      expect(note?.textContent).toContain('disk 50 → 180');
      expect(note?.textContent).toContain('BUILD applies it');
      screen.dispose();
      screen.root.remove();
      const { screen: built } = screen_make();
      await built.open('/scripts/chrisproject/store.mise');
      await settle();
      built.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
      await settle();
      expect(built.root.querySelector('.ss-note-declared')).toBeNull();
      built.dispose();
      built.root.remove();
    } finally {
      detailAt = {};
    }
  });

  it('the price list is read once and said so; an older price answering late never overwrites a newer', async () => {
    const { screen, hooks } = screen_make();
    const answered: Array<() => void> = [];
    const ask = hooks.ask;
    // The first price answers only when released, after the second has answered.
    hooks.ask = (line: string): Promise<QuietAnswer> => line.includes('--memory 16') ? new Promise((resolve) => { answered.push((): void => { void ask(line).then(resolve); }); }) : ask(line);
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
    await settle();
    const memory: HTMLInputElement = screen.root.querySelector('#ss-slider-memory') as HTMLInputElement;
    memory.value = '16';
    memory.dispatchEvent(new Event('input'));
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    memory.value = '24';
    memory.dispatchEvent(new Event('input'));
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    await settle();
    expect(screen.root.querySelector('.ss-cost')?.textContent).toContain('memory 8 → 24');
    for (const release of answered) release();
    await settle();
    expect(screen.root.querySelector('.ss-cost')?.textContent).toContain('memory 8 → 24');
    expect(screen.root.querySelector('.ss-cost')?.textContent).toContain('READ 23:41 UTC · KEPT FOR THE SESSION');
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
    // A hidden word goes through the errand's own bar across the body, not the strip; the field is emptied as it is read.
    const secret: Promise<string | null> = screen.ask_take('password for rudolph (empty: generate one): ', 'secret');
    expect(strip?.hidden).toBe(true);
    const bar: HTMLElement | null = screen.root.querySelector('.ss-body > .errand-bar');
    expect(bar?.querySelector('.errand-caption')?.textContent).toBe('password for rudolph (empty: generate one):');
    const input: HTMLInputElement | null = screen.root.querySelector('#ss-errand-input');
    expect(input?.type).toBe('password');
    expect(input?.classList.contains('errand-path')).toBe(true);
    input!.value = 'hunter2';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await secret).toBe('hunter2');
    expect(input?.value).toBe('');
    expect(screen.root.querySelector('.ss-body > .errand-bar')).toBeNull();
    expect([...screen.root.querySelectorAll('.tdc-log-answer')].map((row) => row.textContent)).toEqual(['y', '(hidden)']);
    screen.dispose();
    screen.root.remove();
  });

  it('entered as READ, the header says so and every control that would act is held with the door as its reason; a VM declared or locked is held too; a network declared still runs', async () => {
    const { screen, sent } = screen_make(['done', 'done', 'ready', 'not yet', 'not yet'], false, false);
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    expect(screen.root.querySelector('.tdc-mode .tdc-condition-name')?.textContent).toBe('READ');
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
    await settle();
    // VM NEW's BUILD would act: held. Its DECLARE and the lock are kept in the tenancy, which READ would keep on this host
    // alone: held too (raised first where the session can be).
    const run: HTMLButtonElement | undefined = button_named(screen.root, 'BUILD · REFUSED');
    expect(run?.disabled).toBe(true);
    expect(run?.title).toContain('entered as READ');
    expect(run?.title).toContain('no door to check a password at');
    expect(button_named(screen.root, 'DECLARE · REFUSED')?.disabled).toBe(true);
    expect(button_named(screen.root, 'TEARDOWN · REFUSED')?.disabled).toBe(true);
    expect(button_named(screen.root, 'TEARDOWN · ALL · REFUSED')?.disabled).toBe(true);
    expect(button_named(screen.root, 'PROTECT · OFF · REFUSED')?.disabled).toBe(true);
    // NET NEW declares and builds nothing: DECLARE stands and sends.
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-1"]')?.click();
    await settle();
    button_named(screen.root, 'DECLARE')?.click();
    await settle();
    expect(sent).toEqual(['net new chrisproject-services --cidr 10.20.0.0/16']);
    // USERS: ADD is held by the door, not by the form.
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="users"]')?.click();
    await settle();
    expect(button_named(screen.root, 'ADD · REFUSED')?.disabled).toBe(true);
    // With MANAGE the chip says so and nothing is held by the door.
    const { screen: managed } = screen_make(['done', 'done', 'ready', 'not yet', 'not yet'], false, true);
    await managed.open('/scripts/chrisproject/store.mise');
    await settle();
    expect(managed.root.querySelector('.tdc-mode .tdc-condition-name')?.textContent).toBe('MANAGE');
    managed.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
    await settle();
    expect(button_named(managed.root, 'BUILD')?.disabled).toBe(false);
    screen.dispose(); screen.root.remove(); managed.dispose(); managed.root.remove();
  });

  it('entered as READ with a door, a control that would act asks the password first and sends only once MANAGE; refused, nothing is sent', async () => {
    const raised: string[] = [];
    let answer: boolean = false;
    const { screen, sent } = screen_make(['done', 'done', 'ready', 'not yet', 'not yet'], false, false, async (line: string): Promise<boolean> => { raised.push(line); return answer; });
    await screen.open('/scripts/chrisproject/store.mise');
    await settle();
    screen.root.querySelector<HTMLButtonElement>('.takeover-gutter button[data-view="line-2"]')?.click();
    await settle();
    const run: HTMLButtonElement | undefined = button_named(screen.root, 'BUILD');
    expect(run?.disabled).toBe(false);
    expect(run?.classList.contains('tdc-pill-asks')).toBe(true);
    expect(run?.title).toContain('asks your password first');
    // The password is asked for the build before the declaration is sent: refused, nothing goes.
    run?.click();
    await settle();
    expect(raised).toEqual(['vm build store']);
    expect(sent).toEqual([]);
    answer = true;
    run?.click();
    await settle();
    expect(raised).toEqual(['vm build store', 'vm build store']);
    expect(sent).toEqual(['vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04', 'vm build store']);
    screen.dispose();
    screen.root.remove();
  });

  it('a step whose task runs is followed with wait: the rail opens on it, STOP FOLLOWING stops the follow and not the task, FOLLOW follows it again', async () => {
    runningAt = { 3: '/proc/steps/vm-store-apply-machine' };
    try {
      const { screen, sent, asked, release } = screen_make(['done', 'done', 'ready', 'not yet', 'not yet'], true);
      await screen.open('/scripts/chrisproject/store.mise');
      await settle();
      // The rail opens on the running step, the seat runs, and the session's own `wait` follows the task under the step.
      expect(screen.view_get()).toBe('line-2');
      expect(sent).toEqual(['wait /proc/steps/vm-store-apply-machine']);
      expect(screen.running_is()).toBe(true);
      expect(screen.following_is()).toBe(true);
      expect(screen.root.querySelector('.takeover-gutter button[data-view="line-2"]')?.classList.contains('ss-seat-running')).toBe(true);
      expect(screen.root.querySelector('.takeover-gutter button[data-view="line-2"] .ss-seat-mark')?.textContent).toBe('▶');
      expect(screen.root.querySelector('.tdc-condition-name')?.textContent).toBe('RUNNING');
      expect(screen.root.querySelector('.ss-note-running')?.textContent).toContain('/proc/steps/vm-store-apply-machine');
      // STOP FOLLOWING is the console's Ctrl-C: the stop is sent, the task is not touched.
      button_named(screen.root, 'STOP FOLLOWING')?.click();
      expect(sent).toEqual(['wait /proc/steps/vm-store-apply-machine', '<stop>']);
      release();
      await settle();
      // The lane is free, the task still runs: the header offers FOLLOW and does not follow unasked.
      expect(screen.running_is()).toBe(false);
      expect(sent.length).toBe(2);
      expect(screen.root.querySelector('.ss-header')?.textContent).toContain('not followed');
      button_named(screen.root, 'FOLLOW')?.click();
      await settle();
      expect(sent[2]).toBe('wait /proc/steps/vm-store-apply-machine');
      release();
      await settle();
      // The task's end, heard on the ambient channel, reads the standing again; the seat then reads what it is.
      runningAt = {};
      asked.length = 0;
      screen.taskEnded_take();
      await settle();
      expect(asked).toContain('play /scripts/chrisproject/store.mise --status');
      expect(screen.root.querySelector('.takeover-gutter button[data-view="line-2"] .ss-seat-mark')?.textContent).toBe('▸');
      expect(button_named(screen.root, 'FOLLOW')).toBeUndefined();
      screen.dispose();
      screen.root.remove();
    } finally {
      runningAt = {};
    }
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
