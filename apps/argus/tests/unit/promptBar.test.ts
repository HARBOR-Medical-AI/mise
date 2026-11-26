/**
 * @jest-environment jsdom
 */
/**
 * @file The console's prompt bar: a backend's segments in its order, or the
 * ChRIS-shaped fields when a daemon sends none. A value from the session
 * is a property of its element, never markup.
 */
import { describe, it, expect } from '@jest/globals';
import type { PromptContext } from '@fnndsc/menu';
import { promptBar_fill, identity_shorten, procProgress_format, type PromptBarParts } from '../../src/console/promptBar.js';

const parts: PromptBarParts = {
  glyphs: { powerline: 'P', cube: 'C', database: 'D', user: 'U', folder: 'F', microscope: 'M', bolt: 'B', error: 'E', cloud: 'W', globe: 'G', sitemap: 'S' },
  palette: {
    pacs: { bg: '#111111', fg: '#aaaaaa' }, host: { bg: '#222222', fg: '#bbbbbb' }, user: { bg: '#333333', fg: '#cccccc' }, dir: { bg: '#444444', fg: '#dddddd' },
    physical: { bg: '#555555', fg: '#eeeeee' }, duration: { bg: '#666666', fg: '#ffffff' }, status: { bg: '#777777', fg: '#abcabc' }, time: { bg: '#888888', fg: '#defdef' },
  },
  procStates: {
    cold: { icon: 'c', label: 'proc cold', color: { bg: '#666666', fg: '#ffffff' } },
    cached: { icon: 'r', label: 'proc cached, refreshing', color: { bg: '#888888', fg: '#defdef' } },
    failed: { icon: 'w', label: 'proc failed', color: { bg: '#777777', fg: '#abcabc' } },
  },
};

const chris: PromptContext = {
  user: 'chris', uri: 'https://cube.example.org/api/v1/', cwd: '/home/chris/feeds', pacsserver: null,
  physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
};

/** A bar filled from a context. */
function bar_fill(context: PromptContext | null): HTMLElement {
  const bar: HTMLElement = document.createElement('div');
  bar.innerHTML = '<span>what was there before</span>';
  promptBar_fill(bar, context, parts);
  return bar;
}

/** The bar's segments, without the separators between them. */
function segments_of(bar: HTMLElement): HTMLElement[] {
  return ([...bar.children] as HTMLElement[]).filter((_span: HTMLElement, index: number): boolean => index % 2 === 0);
}

/** The visible texts of the bar's segments, in order. */
function texts_of(bar: HTMLElement): string[] {
  return segments_of(bar).map((span: HTMLElement): string => (span.textContent ?? '').trim());
}

describe('promptBar_fill', () => {
  it('says argus before the first context, replacing what the bar held', () => {
    const bar: HTMLElement = bar_fill(null);
    expect(bar.innerHTML).toBe('<span class="dim">argus</span>');
  });

  it('draws a ChRIS daemon from its named fields, as before', () => {
    expect(texts_of(bar_fill(chris))).toEqual(['C cube.example.org', 'U chris', 'F ~/feeds']);
  });

  it('draws a backend\'s segments in its order, glyph by key and colour by tone, with the telemetry trailing', () => {
    const bar: HTMLElement = bar_fill({
      ...chris, user: 'rudolph', uri: 'fnndsc', cwd: '/net/oci/fnndsc/domains/harbor', lastExitCode: 2,
      segments: [
        { key: 'cloud', label: 'cloud', value: 'OCI', tone: 'leader' },
        { key: 'tenancy', label: 'tenancy', value: 'fnndsc', tone: 'place' },
        { key: 'region', label: 'region', value: 'us-ashburn-1', tone: 'place' },
        { key: 'user', label: 'user', value: 'rudolph', tone: 'identity' },
        { key: 'cluster', label: 'cluster', value: 'harbor', tone: 'work' },
        { key: 'cwd', label: 'working directory', value: '/net/oci/fnndsc/domains/harbor', tone: 'path' },
        { key: 'step', label: 'step', value: 'infra-apply 3/9', tone: 'note' },
      ],
    });
    expect(texts_of(bar)).toEqual(['W OCI', 'C fnndsc', 'G us-ashburn-1', 'U rudolph', 'S harbor', 'F /net/oci/fnndsc/domains/harbor', 'infra-apply 3/9', 'E 2']);
    const drawn: HTMLElement[] = segments_of(bar);
    expect(drawn[0]?.textContent).toBe(' W OCI ');
    expect(drawn[0]?.getAttribute('style')).toBe('color: rgb(187, 187, 187); background-color: rgb(34, 34, 34);');
    expect(drawn[6]?.style.backgroundColor).toBe('rgb(136, 136, 136)');
  });

  it('joins segments with a separator in the colours of its neighbours, the last fading out', () => {
    const spans: HTMLElement[] = [...bar_fill(chris).children] as HTMLElement[];
    expect(spans.length).toBe(6);
    expect(spans[1]?.textContent).toBe('P');
    expect(spans[1]?.style.color).toBe('rgb(34, 34, 34)');
    expect(spans[1]?.style.backgroundColor).toBe('rgb(51, 51, 51)');
    expect(spans[5]?.style.color).toBe('rgb(68, 68, 68)');
    expect(spans[5]?.style.backgroundColor).toBe('');
  });

  it('cuts a long identity from the left and keeps the whole of it as a title', () => {
    const long: string = 'rudolph.pienaar@childrens.harvard.edu';
    const bar: HTMLElement = bar_fill({ ...chris, segments: [{ key: 'user', label: 'user', value: long, tone: 'identity' }] });
    expect(texts_of(bar)).toEqual([`U ${identity_shorten(long)}`]);
    expect(identity_shorten(long)).toBe('…enaar@childrens.harvard.edu');
    expect(identity_shorten(long).length).toBe(28);
    expect(segments_of(bar)[0]?.title).toBe(long);
    expect(identity_shorten('rudolph')).toBe('rudolph');
  });

  it('keeps a value that reads as markup inside its title and its text', () => {
    const hostile: string = `a-long-identity-that-is-cut" onmouseover="alert(1)" x='<img src=x onerror=alert(2)>`;
    const bar: HTMLElement = bar_fill({ ...chris, segments: [{ key: 'user', label: 'user', value: hostile, tone: 'identity' }, { key: 'cwd', label: 'cwd', value: '<b>"here"</b>', tone: 'path' }] });
    const drawn: HTMLElement[] = segments_of(bar);
    expect(drawn.length).toBe(2);
    expect(drawn[0]?.title).toBe(hostile);
    expect(drawn[0]?.getAttributeNames().sort()).toEqual(['style', 'title']);
    expect(drawn[1]?.textContent).toBe(' F <b>"here"</b> ');
    expect(bar.querySelector('img, b')).toBeNull();
    expect(bar.querySelectorAll('*').length).toBe(4);
  });

  it('formats proc progress as chell does', () => {
    expect(procProgress_format(25, 100)).toBe('25/100 25%');
    expect(procProgress_format(5, 0)).toBe('5/?');
  });
});
