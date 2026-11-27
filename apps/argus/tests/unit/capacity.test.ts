/**
 * @file The CAPACITY pane's rows: one block per family, a row per limit and
 * zone, the zone short, the figures as the cloud gave them; and the model
 * read off an outcome.
 */
import { describe, it, expect } from '@jest/globals';
import type { CapacityModel } from '@fnndsc/menu';
import { args_tokenize } from '../../../../packages/brasa/src/lib/parser.js';
import { CapacityPanel, capacityBlocks_build, zone_text } from '../../src/features/capacity/panel.js';
import { capacityModel_extract } from '../../src/app/capacityPane.js';

const MODEL: CapacityModel = {
  region: 'us-ashburn-1',
  rows: [
    { family: 'E5', limit: 'standard-e5-core-count', zone: 'disG:US-ASHBURN-AD-1', value: 4629, used: 4, available: 4625 },
    { family: 'E5', limit: 'standard-e5-memory-count', zone: null, value: 100, used: null, available: null },
    { family: 'A1', limit: 'standard-a1-core-count', zone: 'disG:US-ASHBURN-AD-1', value: 10, used: 10, available: 0 },
  ],
};

describe('asking for a family', () => {
  /** What the pane asks the session for a family, read as the kernel reads a line. */
  async function asked_read(family: string): Promise<string[]> {
    const lines: string[] = [];
    const pane = { hooks: { ask: async (line: string): Promise<null> => { lines.push(line); return null; } }, model_show: (): void => undefined };
    await CapacityPanel.prototype.family_ask.call(pane as unknown as CapacityPanel, family);
    return [...args_tokenize(lines[0] ?? '')];
  }

  it('names the family as one word of the line, whatever it holds; no family asks for all of them', async () => {
    expect(await asked_read('E5')).toEqual(['capacity', 'E5']);
    expect(await asked_read('two words')).toEqual(['capacity', 'two words']);
    expect(await asked_read('a;b $HOME')).toEqual(['capacity', 'a;b $HOME']);
    expect(await asked_read('')).toEqual(['capacity']);
  });
});

describe('the CAPACITY pane', () => {
  it('shortens a zone to its name and reads REGION for a region-wide limit', () => {
    expect(zone_text('disG:US-ASHBURN-AD-1')).toBe('US-ASHBURN-AD-1');
    expect(zone_text('ad-2')).toBe('AD-2');
    expect(zone_text(null)).toBe('REGION');
  });

  it('makes one block per family in the model\'s order, a row per limit and zone, a dash where the cloud did not say', () => {
    const blocks = capacityBlocks_build(MODEL);
    expect(blocks.map((b) => [b.key, b.title, b.rows.length])).toEqual([['E5', 'E5 · us-ashburn-1', 2], ['A1', 'A1 · us-ashburn-1', 1]]);
    expect(blocks[0]!.rows[0]).toEqual({ key: 'E5:standard-e5-core-count:disG:US-ASHBURN-AD-1', family: 'E5', limit: 'standard-e5-core-count', zone: 'US-ASHBURN-AD-1', value: 4629, used: 4, available: 4625 });
    expect(blocks[0]!.rows[1]).toMatchObject({ zone: 'REGION', used: null, available: null, key: 'E5:standard-e5-memory-count:region' });
    expect(blocks[1]!.rows[0]!.available).toBe(0);
  });

  it('reads the stratus.capacity model off an outcome and ignores the rest', () => {
    const outcome = { envelopes: [{ status: 'ok', rendered: '', model: { kind: 'fs.cwd', data: {} } }, { status: 'ok', rendered: '', model: { kind: 'stratus.capacity', data: MODEL } }] } as never;
    expect(capacityModel_extract(outcome)?.rows).toHaveLength(3);
    expect(capacityModel_extract({ envelopes: [] } as never)).toBeNull();
    expect(capacityModel_extract({ envelopes: [{ status: 'ok', rendered: '', model: { kind: 'stratus.capacity', data: { nonsense: true } } }] } as never)).toBeNull();
  });
});
