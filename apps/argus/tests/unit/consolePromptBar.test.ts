/**
 * @jest-environment jsdom
 */
/**
 * @file The console draws its prompt bar at both of its moments, when a
 * context arrives while it is idle and when a prompt returns, and at both
 * a value from the session is a title and a text, never markup.
 *
 * @module
 */
import { describe, it, expect } from '@jest/globals';
import type { PromptContext } from '@fnndsc/menu';
import { ArgusTerminal } from '../../src/console/terminal.js';

/** An identity longer than the bar draws whole, so it is cut and carries a title; it reads as markup. */
const HOSTILE: string = `someone.with.a.long.name" onmouseover="alert(1)" data-x='<img src=x onerror=alert(2)>@tenancy`;

/** A context whose backend sent that identity. */
const context: PromptContext = {
  user: 'someone', uri: 'fnndsc', cwd: '/net/oci', pacsserver: null,
  physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
  segments: [{ key: 'user', label: 'user', value: HOSTILE, tone: 'identity' }],
};

/** A console and its prompt bar. */
function console_make(): { terminal: ArgusTerminal; bar: HTMLElement } {
  const container: HTMLElement = document.createElement('div');
  document.body.appendChild(container);
  const terminal: ArgusTerminal = new ArgusTerminal(
    container,
    async (): Promise<void> => undefined,
    async (): Promise<{ completions: string[]; prefix: string }> => ({ completions: [], prefix: '' }),
  );
  return { terminal, bar: container.querySelector('.argus-prompt-bar') as HTMLElement };
}

/** Asserts the bar holds one segment and its separator, with the identity whole in the title. */
function bar_check(bar: HTMLElement): void {
  const spans: HTMLElement[] = [...bar.children] as HTMLElement[];
  expect(spans.length).toBe(2);
  expect(spans[0]?.title).toBe(HOSTILE);
  expect(spans[0]?.textContent).toContain('…');
  expect(spans[0]?.getAttributeNames().sort()).toEqual(['style', 'title']);
  expect(bar.querySelectorAll('*').length).toBe(2);
  expect(bar.querySelector('img, [onmouseover], [data-x]')).toBeNull();
}

describe('the console\'s prompt bar', () => {
  it('is drawn when a prompt returns, a busy console having left it alone', () => {
    const { terminal, bar } = console_make();
    // A console is busy until its first prompt: a context arriving then is kept, not drawn.
    terminal.promptContext_set(context);
    expect(bar.children.length).toBe(0);
    terminal.prompt_draw();
    bar_check(bar);
  });

  it('is drawn at once when a context arrives while the console is idle', () => {
    const { terminal, bar } = console_make();
    terminal.prompt_draw();
    expect(bar.textContent).toBe('argus');
    terminal.promptContext_set(context);
    bar_check(bar);
  });
});
