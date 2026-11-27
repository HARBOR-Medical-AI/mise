/**
 * @jest-environment jsdom
 */
/**
 * @file SHARE VIEW: the stage as a script from the baseline, shown and
 * copied, and the copy says what happened.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { shareSheet_open, viewScript_compose, VIEW_BASELINE } from '../../src/app/shareView.js';

describe('viewScript_compose', () => {
  it('starts from the baseline, then the steps, without the desktop\'s comments or blanks', () => {
    expect(viewScript_compose('view runs\n\n# a note\ndag %1 census on\ndag %1 select pl-x_7')).toBe(
      ['# ARGUS view: run these lines in the ARGUS console to see what I see', '# lines: quoted', VIEW_BASELINE, 'view runs', 'dag %1 census on', 'dag %1 select pl-x_7'].join('\n'),
    );
  });
});

describe('shareSheet_open', () => {
  it('shows the script and copies it at once, saying COPIED', async () => {
    const writeText = jest.fn(async (_text: string): Promise<void> => undefined);
    const sheet: HTMLElement = shareSheet_open('desktop clear\nview runs', { writeText });
    await Promise.resolve(); await Promise.resolve();
    expect(sheet.querySelector('.share-script')?.textContent).toBe('desktop clear\nview runs');
    expect(writeText).toHaveBeenCalledWith('desktop clear\nview runs');
    expect(sheet.querySelector('.share-lines')?.textContent).toBe('COPIED');
    (sheet.querySelector('.share-close') as HTMLButtonElement).click();
    expect(document.querySelector('.share-sheet')).toBeNull();
  });

  it('selects the script for the hand when the browser will not copy', async () => {
    const sheet: HTMLElement = shareSheet_open('view runs', { writeText: async (): Promise<void> => { throw new Error('insecure'); } });
    await Promise.resolve(); await Promise.resolve();
    expect(sheet.querySelector('.share-lines')?.textContent).toBe('SELECT + COPY');
    expect(window.getSelection()?.toString()).toBe('view runs');
  });
});
