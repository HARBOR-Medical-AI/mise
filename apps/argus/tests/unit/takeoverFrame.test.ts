/**
 * @jest-environment jsdom
 */
/**
 * @file The takeover frame's gutter: a press on the view already shown sends
 * the gutter away, a press that navigates brings it back and navigates, the
 * restore strip and `gutter_restore` bring it back.
 */
import { describe, it, expect } from '@jest/globals';
import { takeoverFrame_build, type TakeoverFrame } from '../../src/features/takeover/frame.js';

describe('the takeover frame', () => {
  const frame_make = (): { frame: TakeoverFrame; shown: string[]; left: number } => {
    const shown: string[] = [];
    const counted: { left: number } = { left: 0 };
    const frame: TakeoverFrame = takeoverFrame_build({
      id: 'td-test', className: 'td-test', brand: { name: 'TEST', sub: 'FRAME', mark: false }, banner: 'TEST',
      views: [{ key: 'overview', label: 'OVERVIEW' }, { key: 'size', label: 'SIZE' }], leave: { label: 'LEAVE' },
      stage: { title: 'STAGE', note: '' }, log: { title: 'LOG', note: '' }, labels: { views: 'Views', log: 'Log' },
    }, (key: string): void => { shown.push(key); frame.view_mark(key); }, (): void => { counted.left += 1; });
    document.body.append(frame.root);
    return { frame, shown, left: counted.left };
  };

  it('sends the gutter away on a press on the view already shown, and brings it back to navigate', () => {
    const { frame, shown } = frame_make();
    frame.view_mark('overview');
    frame.views.get('size')?.click();
    expect(shown).toEqual(['size']);
    expect(frame.gutterAway_is()).toBe(false);
    // The view shown, pressed again: the gutter goes, nothing navigates.
    frame.views.get('size')?.click();
    expect(shown).toEqual(['size']);
    expect(frame.root.dataset['gutter']).toBe('away');
    expect(frame.gutterAway_is()).toBe(true);
    // A press that navigates brings it back first.
    frame.views.get('overview')?.click();
    expect(shown).toEqual(['size', 'overview']);
    expect(frame.gutterAway_is()).toBe(false);
    frame.root.remove();
  });

  it('is brought back by the restore strip, and by gutter_restore, which says whether it was away', () => {
    const { frame } = frame_make();
    frame.view_mark('overview');
    frame.views.get('overview')?.click();
    expect(frame.gutterAway_is()).toBe(true);
    frame.root.querySelector<HTMLElement>('.takeover-gutter-restore')?.click();
    expect(frame.gutterAway_is()).toBe(false);
    frame.views.get('overview')?.click();
    expect(frame.gutter_restore()).toBe(true);
    expect(frame.gutterAway_is()).toBe(false);
    expect(frame.gutter_restore()).toBe(false);
    frame.root.remove();
  });
});
