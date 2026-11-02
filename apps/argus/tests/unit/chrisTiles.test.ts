/**
 * @jest-environment jsdom
 */
/**
 * @file The ChRIS composition's tiles: CLOUD stands only where a porter can
 * be asked, and runs the console's own line.
 */
import { describe, it, expect } from '@jest/globals';
import { chrisTiles_make, type ChrisTileHooks } from '../../src/compositions/chris/tiles.js';
import type { ExecuteOutcome } from '../../src/calypso/client.js';
import type { LauncherTile } from '../../src/features/launcher/panel.js';

/** The hooks, with a cloud door or none. */
function hooks_make(cloud_enter: (() => void) | null): ChrisTileHooks {
  return {
    ask: async (): Promise<ExecuteOutcome> => ({ envelopes: [] } as unknown as ExecuteOutcome),
    universe_show: (): void => undefined, runs_show: (): void => undefined, feed_enter: (): void => undefined,
    line_offer: (): void => undefined, pacs_query: (): string => '', pacs_open: (): void => undefined,
    cloud_enter,
  };
}

describe('the ChRIS tiles', () => {
  it('place CLOUD after the UNIVERSE through a porter, and nowhere without one', async () => {
    const entered: string[] = [];
    const withDoor = await chrisTiles_make(hooks_make((): void => { entered.push('cloud'); }))();
    expect(withDoor.afterPanes.map((tile: LauncherTile): string => tile.key)).toEqual(['universe', 'cloud']);
    const cloud: LauncherTile = withDoor.afterPanes[1] as LauncherTile;
    expect(cloud.name).toBe('CLOUD');
    expect(cloud.verb).toBe('ENTER YOUR CLOUD SESSION');
    expect(cloud.rows.map((row): string => row.text)).toEqual(['enter as READ · look only', 'a line that would act asks your password · MANAGE then']);
    cloud.enter();
    cloud.rows[1]?.open?.();
    expect(entered).toEqual(['cloud', 'cloud']);
    const withoutDoor = await chrisTiles_make(hooks_make(null))();
    expect(withoutDoor.afterPanes.map((tile: LauncherTile): string => tile.key)).toEqual(['universe']);
  });
});
