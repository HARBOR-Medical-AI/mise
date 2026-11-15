/**
 * @jest-environment jsdom
 */
/**
 * @file A line pressed while another runs is answered at once.
 *
 * The defect: a tile's line (the CLOUD tile's `stratus oci`) pressed while
 * the console was busy — a line still running, or a session still booting
 * — went into a queue with no echo and no word, so the press read as
 * nothing at all. It now stands in the transcript as queued, and runs
 * where it stands when the line before it ends.
 *
 * @module
 */
import { describe, it, expect } from '@jest/globals';
import { ArgusTerminal } from '../../src/console/terminal.js';

/** A console whose submits are recorded; `busy` until the first prompt, as a session's is. */
function console_make(): { terminal: ArgusTerminal; container: HTMLElement; sent: string[] } {
  const container: HTMLElement = document.createElement('div');
  document.body.appendChild(container);
  const sent: string[] = [];
  const terminal: ArgusTerminal = new ArgusTerminal(
    container,
    async (line: string): Promise<void> => { sent.push(line); },
    async (): Promise<{ completions: string[]; prefix: string }> => ({ completions: [], prefix: '' }),
  );
  return { terminal, container, sent };
}

/** The transcript's echoes, as text. */
function echoes_read(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.argus-echo')].map((echo: Element): string => (echo.textContent ?? '').replace(/\s+/g, ' ').trim());
}

describe('a line pressed while the console is busy', () => {
  it('stands in the transcript at once, saying it is queued, and sends nothing yet', () => {
    const { terminal, container, sent } = console_make();
    terminal.line_run('stratus oci');
    expect(sent).toEqual([]);
    expect(echoes_read(container)).toEqual(['❯ stratus oci queued: runs when the line running now ends']);
    expect(container.querySelector('.argus-queued')).not.toBeNull();
  });

  it('runs where it stands when the console is free: one echo, no longer marked queued, sent once', () => {
    const { terminal, container, sent } = console_make();
    terminal.line_run('stratus oci');
    terminal.prompt_draw();
    expect(sent).toEqual(['stratus oci']);
    expect(echoes_read(container)).toEqual(['❯ stratus oci']);
    expect(container.querySelector('.argus-queued')).toBeNull();
    expect(container.querySelector('.argus-queued-note')).toBeNull();
  });

  it('keeps two presses in order, each echoed once', () => {
    const { terminal, container, sent } = console_make();
    terminal.line_run('ls');
    terminal.line_run('pwd');
    terminal.prompt_draw();
    expect(sent).toEqual(['ls']);
    terminal.prompt_draw();
    expect(sent).toEqual(['ls', 'pwd']);
    expect(echoes_read(container)).toEqual(['❯ ls', '❯ pwd']);
  });
});
