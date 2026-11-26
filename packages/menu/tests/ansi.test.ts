/**
 * @file The ANSI-to-HTML converter, moved here from the ARGUS console so the
 * porter's greeter renders a boot the way the console renders a transcript.
 */
import { describe, it, expect } from '@jest/globals';
import { ansi_renderHtml, html_escape, CONSOLE_PALETTE } from '../src/ansi/ansi';

describe('ansi_renderHtml', () => {
  it('leaves plain text alone, escaped', () => {
    expect(ansi_renderHtml('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('renders a 16-colour run as a styled span and resets after it', () => {
    expect(ansi_renderHtml('\x1b[32m[ OK ]\x1b[39m Connect')).toBe('<span style="color:#33cc66">[ OK ]</span> Connect');
  });

  it('renders bold, dim, inverse and underline', () => {
    expect(ansi_renderHtml('\x1b[1mbold\x1b[22m')).toContain('font-weight:bold');
    expect(ansi_renderHtml('\x1b[2mdim\x1b[22m')).toContain('opacity');
    expect(ansi_renderHtml('\x1b[4munder\x1b[24m')).toContain('underline');
    expect(ansi_renderHtml('\x1b[31m\x1b[7minv\x1b[27m\x1b[39m')).toContain('background');
  });

  it('renders 256-colour and truecolour foregrounds', () => {
    expect(ansi_renderHtml('\x1b[38;5;196mred\x1b[0m')).toMatch(/color:#[0-9a-f]{6}/);
    expect(ansi_renderHtml('\x1b[38;2;10;20;30mrgb\x1b[0m')).toContain('color:#0a141e');
    expect(ansi_renderHtml('\x1b[48;2;1;2;3mbg\x1b[0m')).toContain('background');
  });

  it('drops cursor movement and a spinner\'s hide/show, and strips carriage returns', () => {
    expect(ansi_renderHtml('\x1b[?25la\x1b[2Kb\x1b[?25h\r')).toBe('ab');
    expect(ansi_renderHtml('\x1b]0;title\x07text')).toBe('text');
  });

  it('keeps newlines', () => {
    expect(ansi_renderHtml('one\ntwo')).toBe('one\ntwo');
  });
});

describe('html_escape', () => {
  it('escapes the three characters markup would read', () => {
    expect(html_escape('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('escapes both quotes, so a value cannot end the attribute it is written into', () => {
    expect(html_escape(`a"b'c`)).toBe('a&quot;b&#39;c');
    expect(html_escape('" onmouseover="x')).toBe('&quot; onmouseover=&quot;x');
    // An ampersand is escaped once, before the quotes' own entities exist.
    expect(html_escape('&"')).toBe('&amp;&quot;');
  });
});

describe('CONSOLE_PALETTE', () => {
  it('names the five colours the console lists in', () => {
    expect(Object.keys(CONSOLE_PALETTE).sort()).toEqual(['cyan', 'green', 'magenta', 'white', 'yellow']);
    for (const hex of Object.values(CONSOLE_PALETTE)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});
