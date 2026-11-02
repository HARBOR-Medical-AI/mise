/**
 * @jest-environment jsdom
 */
/**
 * @file The switch between a person's sessions through the porter: the
 * `stratus` and `chris` verbs, the question at the cloud door, and what the
 * page asks the porter.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { argusLine_run, type ArgusHost } from '../../src/console/argusLang.js';
import { session_switch } from '../../src/app/sessionSwitch.js';

/** A host that records each switch it is asked for. */
function host_make(asked: Array<{ to: string; spend: boolean }>): ArgusHost {
  return { session_switch: async (to: 'stratus' | 'chris', spend: boolean): Promise<string> => { asked.push({ to, spend }); return `to ${to}`; }, manage_is: (): boolean | null => null } as unknown as ArgusHost;
}

/** The sheet standing, if one is. */
const sheet = (): HTMLElement | null => document.querySelector('.cloud-ask');

/** Presses the sheet's pill by label. */
function pill_press(label: string): void {
  const button: HTMLButtonElement | undefined = [...document.querySelectorAll<HTMLButtonElement>('.cloud-ask button')].find((one: HTMLButtonElement): boolean => one.textContent === label);
  if (button === undefined) throw new Error(`no ${label} pill`);
  button.click();
}

describe('the stratus and chris verbs', () => {
  it('enters the cloud session as READ unless manage is said; chris goes back', async () => {
    const asked: Array<{ to: string; spend: boolean }> = [];
    expect(await argusLine_run(host_make(asked), 'stratus oci')).toBe('to stratus');
    expect(await argusLine_run(host_make(asked), 'stratus oci read')).toBe('to stratus');
    expect(await argusLine_run(host_make(asked), 'stratus oci manage')).toBe('to stratus');
    expect(await argusLine_run(host_make(asked), 'chris')).toBe('to chris');
    expect(asked).toEqual([{ to: 'stratus', spend: false }, { to: 'stratus', spend: false }, { to: 'stratus', spend: true }, { to: 'chris', spend: false }]);
    expect(sheet()).toBeNull();
  });

  it('in the cloud session, says the mode; manage asks the password once and raises it', async () => {
    const raised: string[] = [];
    let granted: boolean = false;
    const host = (mode: boolean | null): ArgusHost => ({ ...host_make([]), manage_is: (): boolean | null => mode, elevate_ask: async (line: string): Promise<boolean> => { raised.push(line); return granted; } } as unknown as ArgusHost);
    expect(await argusLine_run(host(false), 'stratus oci')).toBe('stratus oci: this is your cloud session, MODE READ (stratus oci manage asks your password once)');
    expect(await argusLine_run(host(false), 'stratus oci manage')).toBe('stratus oci manage: not raised; MODE READ');
    granted = true;
    expect(await argusLine_run(host(false), 'stratus oci manage')).toBe('stratus oci: MODE MANAGE');
    expect(raised).toEqual(['stratus oci manage', 'stratus oci manage']);
    expect(await argusLine_run(host(true), 'stratus oci manage')).toBe('stratus oci: MODE MANAGE already');
    expect(await argusLine_run(host(true), 'stratus oci')).toBe('stratus oci: this is your cloud session, MODE MANAGE');
  });

  it('refuses another cloud, an unknown word, two words, and words after chris, by name', async () => {
    const asked: Array<{ to: string; spend: boolean }> = [];
    expect(await argusLine_run(host_make(asked), 'stratus aws')).toBe('stratus: aws: the only cloud is oci');
    expect(await argusLine_run(host_make(asked), 'stratus oci --spend')).toContain('--spend: unknown word');
    expect(await argusLine_run(host_make(asked), 'stratus oci read manage')).toContain('one word');
    expect(await argusLine_run(host_make(asked), 'chris now')).toContain('takes no words');
    expect(asked).toEqual([]);
    expect(sheet()).toBeNull();
  });
});

describe('session_switch', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/s/abcdef0123456789/?door'); });

  it('refuses a page that did not come through a porter', async () => {
    window.history.replaceState({}, '', '/');
    expect(await session_switch('stratus', false)).toContain('did not come through a porter');
  });

  it('says what the porter refused, and asks it for the person\'s cloud session', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = jest.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), body: String(init?.body) });
      return { json: async () => ({ error: 'no OCI credentials are filed for rudolph' }) } as Response;
    }) as unknown as typeof fetch;
    expect(await session_switch('stratus', true)).toBe('stratus: no OCI credentials are filed for rudolph');
    expect(calls).toEqual([{ url: '/switch', body: JSON.stringify({ to: 'stratus', cloud: 'oci', spend: true }) }]);
  });
});
