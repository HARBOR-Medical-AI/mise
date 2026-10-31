/**
 * @file The console's prompt bar: a backend's segments in its order, or the
 * ChRIS-shaped fields when a daemon sends none.
 */
import { describe, it, expect } from '@jest/globals';
import type { PromptContext } from '@fnndsc/menu';
import { promptBar_render, identity_shorten, procProgress_format, type PromptBarParts } from '../../src/console/promptBar.js';

const parts: PromptBarParts = {
  glyphs: { powerline: 'P', cube: 'C', database: 'D', user: 'U', folder: 'F', microscope: 'M', bolt: 'B', error: 'E', cloud: 'W', globe: 'G', sitemap: 'S' },
  palette: {
    pacs: { bg: '#1', fg: '#a' }, host: { bg: '#2', fg: '#b' }, user: { bg: '#3', fg: '#c' }, dir: { bg: '#4', fg: '#d' },
    physical: { bg: '#5', fg: '#e' }, duration: { bg: '#6', fg: '#f' }, status: { bg: '#7', fg: '#g' }, time: { bg: '#8', fg: '#h' },
  },
  procStates: {
    cold: { icon: 'c', label: 'proc cold', color: { bg: '#6', fg: '#f' } },
    cached: { icon: 'r', label: 'proc cached, refreshing', color: { bg: '#8', fg: '#h' } },
    failed: { icon: 'w', label: 'proc failed', color: { bg: '#7', fg: '#g' } },
  },
};

const chris: PromptContext = {
  user: 'chris', uri: 'https://cube.example.org/api/v1/', cwd: '/home/chris/feeds', pacsserver: null,
  physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
};

/** The visible texts of the bar's segments, in order. */
function texts_of(html: string): string[] {
  return [...html.matchAll(/> ([^<]*) <\/span>/g)].map((match) => match[1] ?? '');
}

describe('promptBar_render', () => {
  it('names the surface before the first context', () => {
    expect(promptBar_render(null, parts)).toBe('<span class="dim">argus</span>');
  });

  it('draws a ChRIS daemon from its named fields, as before', () => {
    expect(texts_of(promptBar_render(chris, parts))).toEqual(['C cube.example.org', 'U chris', 'F ~/feeds']);
  });

  it('draws a backend\'s segments in its order, glyph by key and colour by tone, with the telemetry trailing', () => {
    const html: string = promptBar_render({
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
    }, parts);
    expect(texts_of(html)).toEqual(['W OCI', 'C fnndsc', 'G us-ashburn-1', 'U rudolph', 'S harbor', 'F /net/oci/fnndsc/domains/harbor', 'infra-apply 3/9', 'E 2']);
    expect(html).toContain('background-color:#2"> W OCI');
    expect(html).toContain('background-color:#8"> infra-apply 3/9');
  });

  it('cuts a long identity from the left and keeps the whole of it as a title', () => {
    const long: string = 'rudolph.pienaar@childrens.harvard.edu';
    const html: string = promptBar_render({ ...chris, segments: [{ key: 'user', label: 'user', value: long, tone: 'identity' }] }, parts);
    expect(texts_of(html)).toEqual([`U ${identity_shorten(long)}`]);
    expect(identity_shorten(long)).toBe('…enaar@childrens.harvard.edu');
    expect(identity_shorten(long).length).toBe(28);
    expect(html).toContain(`title="${long}"`);
    expect(identity_shorten('rudolph')).toBe('rudolph');
  });

  it('formats proc progress as chell does', () => {
    expect(procProgress_format(25, 100)).toBe('25/100 25%');
    expect(procProgress_format(5, 0)).toBe('5/?');
  });
});
