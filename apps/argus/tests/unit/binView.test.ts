/**
 * @jest-environment jsdom
 *
 * @file The /bin view's readouts: a summary highlighted, a pipeline node's
 * rows and a plugin's rows (selected and immersed, readout and form), and
 * the painter that makes a form's rows into cells writing the line.
 */
import { describe, it, expect } from '@jest/globals';
import type { PipelineDiagramNode, PluginInfoModel } from '@fnndsc/menu';
import { binText_highlight, facts_paint, pipelineNodeRows_build, pluginRows_build, type BinForm, type FactRow } from '../../src/app/binView.js';

describe('binText_highlight', () => {
  it('marks strings, flags, keys and headings, and leaves ANSI to the console renderer', () => {
    const html: string = binText_highlight('USAGE\n  name: pl-x\n  --prefix "abc"');
    expect(html).toContain('<span class="man-head">USAGE</span>');
    expect(html).toContain('<span class="man-key">name:</span>');
    expect(html).toContain('<span class="man-flag">--prefix</span>');
    // html_escape writes a quote as &quot;, which is what the string
    // pattern looks for: a quoted string is marked.
    expect(html).toContain('<span class="man-str">&quot;abc&quot;</span>');
    expect(binText_highlight('\x1b[31mred\x1b[0m')).not.toContain('man-');
  });
});

const node: PipelineDiagramNode = { id: '7', label: 'convert', pluginName: 'pl-dcm2niix', pluginVersion: '1.0.0', parentIds: [], joinParentIds: [], arguments: [{ name: 'compress', value: true }, { name: 'outputFilename', value: 'out' }] } as unknown as PipelineDiagramNode;

describe('pipelineNodeRows_build', () => {
  it('says what it is and how much there is, selected; every argument, immersed', () => {
    expect(pipelineNodeRows_build(undefined, true, false, [])).toEqual([]);
    const selected: FactRow[] = pipelineNodeRows_build(node, false, false, ['convert']);
    expect(selected.map((row) => row.label)).toEqual(['NODE', 'PLUGIN', 'VERSION', 'ARGUMENTS']);
    expect(selected[3]?.value).toBe('2 — open the node to read them');
    const immersed: FactRow[] = pipelineNodeRows_build(node, true, false, ['convert']);
    expect(immersed.slice(3).map((row) => [row.label, row.value])).toEqual([['compress', 'true'], ['outputFilename', 'out']]);
    expect(immersed.every((row) => row.edit === undefined)).toBe(true);
  });

  it('as a form, each argument edits its node-qualified flag, a boolean as a boolean', () => {
    const rows: FactRow[] = pipelineNodeRows_build(node, true, true, ['convert', 'other']);
    expect(rows[3]?.edit).toEqual({ flag: '--convert.compress', type: 'boolean', placeholder: 'true' });
    expect(rows[4]?.edit).toEqual({ flag: '--convert.outputFilename', type: 'string', placeholder: 'out' });
    const bare: FactRow[] = pipelineNodeRows_build({ ...node, arguments: [] } as PipelineDiagramNode, true, true, ['convert']);
    expect(bare[3]?.value).toMatch(/runs on the plugin's defaults/);
  });
});

const plugin: PluginInfoModel = {
  name: 'pl-simpledsapp', version: '2.1.0', type: 'ds',
  parameters: [
    { flag: '--prefix', type: 'str', optional: true, default: '', help: 'a prefix' },
    { flag: '--ignoreInputDir', type: 'boolean', optional: true, default: false },
    { flag: '--dummyInt', type: 'int', optional: false, default: 1 },
  ],
} as unknown as PluginInfoModel;

describe('pluginRows_build', () => {
  it('counts the parameters selected and lists them immersed, with the hint built from type, required and default', () => {
    const selected: FactRow[] = pluginRows_build(plugin, false, false);
    expect(selected.map((row) => row.label)).toEqual(['PLUGIN', 'VERSION', 'TYPE', 'PARAMETERS']);
    expect(selected[2]?.value).toBe('DS');
    expect(selected[3]?.value).toBe('3 — open the node to read them');
    const immersed: FactRow[] = pluginRows_build(plugin, true, true);
    expect(immersed[3]).toEqual({ label: '--prefix', value: 'str — a prefix', edit: { flag: '--prefix', type: 'str', placeholder: '' } });
    expect(immersed[4]?.value).toBe('boolean · default false');
    expect(immersed[5]?.value).toBe('int · required · default 1');
    expect(pluginRows_build({ ...plugin, parameters: [] } as PluginInfoModel, true, false)[3]?.value).toMatch(/takes no arguments/);
  });
});

describe('facts_paint', () => {
  it('paints readout rows as label and value, and marks immersion', () => {
    const facts: HTMLElement = document.createElement('div');
    facts_paint(facts, [{ label: 'PLUGIN', value: 'pl-x' }], true, null);
    expect(facts.classList.contains('dag-facts-immersed')).toBe(true);
    expect(facts.querySelector('.telemetry-label')?.textContent).toBe('PLUGIN');
    expect(facts.querySelector('.telemetry-value')?.textContent).toBe('pl-x');
    facts_paint(facts, [], false, null);
    expect(facts.childElementCount).toBe(0);
    expect(facts.classList.contains('dag-facts-immersed')).toBe(false);
  });

  it('in a form, a row with a flag is a cell that writes the line, a boolean a check', () => {
    let line: string = 'pl-simpledsapp --ignoreInputDir';
    const form: BinForm = { line_get: (): string => line, line_set: (next: string): void => { line = next; }, run: (): void => {} };
    const facts: HTMLElement = document.createElement('div');
    facts_paint(facts, [
      { label: '--prefix', value: 'str', edit: { flag: '--prefix', type: 'str', placeholder: '' } },
      { label: '--ignoreInputDir', value: 'boolean', edit: { flag: '--ignoreInputDir', type: 'boolean', placeholder: '' } },
    ], true, form);
    const inputs: HTMLInputElement[] = [...facts.querySelectorAll<HTMLInputElement>('.telemetry-input')];
    expect(inputs.map((input) => input.type)).toEqual(['text', 'checkbox']);
    expect(inputs[1]?.checked).toBe(true);
    const text: HTMLInputElement = inputs[0] as HTMLInputElement;
    text.value = 'smoke-';
    text.dispatchEvent(new Event('input'));
    expect(line).toBe('pl-simpledsapp --ignoreInputDir --prefix smoke-');
    const check: HTMLInputElement = inputs[1] as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent(new Event('change'));
    expect(line).toBe('pl-simpledsapp --prefix smoke-');
  });
});
