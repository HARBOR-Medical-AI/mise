/**
 * @file The CAPACITY pane: what the region has free for a shape family, as a
 * listing.
 *
 * The session's `capacity` answers a `stratus.capacity` model — one row per
 * limit a family's shapes draw on, at every zone it is kept in, with what is
 * used and left when the cloud says — and this pane is its projection on
 * the stage: one block per family under the listing façade's caps, a row
 * per limit and zone, the free figure red when nothing is left. The pane
 * writes nothing of its own: the rows are the session's, and the bar names
 * the region they were read in. A family's pill on the OPENSHIFT tile and the
 * CAPACITY tile's rows open it on that family; `capacity pane [<family>]`
 * types the same (#1284).
 *
 * @module
 */
import type { CapacityModel, CapacityRow } from '@fnndsc/menu';
import { Listing } from '../roster/listing.js';
import type { ListingTrait } from '../roster/row.js';
import type { ListingBlock } from '../roster/listing.js';

/** One row: a limit at a zone, for a family. */
export interface CapacityPaneRow {
  /** Row identity: `<family>:<limit>:<zone|region>`. */
  key: string;
  family: string;
  limit: string;
  /** The zone, short (`US-ASHBURN-AD-1`), or `REGION` for a region-wide limit. */
  zone: string;
  /** What the limit permits. */
  value: number;
  /** Spent and left; null when the cloud does not say. */
  used: number | null;
  available: number | null;
}

/** The pane's hooks: a line to the session, quietly. */
export interface CapacityPanelHooks {
  /** Asks the session `capacity [<family>]` and answers its model, or null. */
  ask: (line: string) => Promise<CapacityModel | null>;
}

/**
 * A zone as a cap has room for: the part after the cloud's prefix
 * (`disG:US-ASHBURN-AD-1` reads `US-ASHBURN-AD-1`); `REGION` when the limit
 * is region-wide.
 *
 * @param zone - The zone, or null.
 * @returns The short form.
 */
export function zone_text(zone: string | null): string {
  if (zone === null) return 'REGION';
  const colon: number = zone.indexOf(':');
  return (colon === -1 ? zone : zone.slice(colon + 1)).toUpperCase();
}

/** A figure the cloud gave, or a dash where it did not. */
function figure_text(value: number | null): string {
  return value === null ? '—' : String(value);
}

/**
 * The rows a model makes: one block per family, in the model's order, the
 * rows in the model's order within it.
 *
 * @param model - The session's answer.
 * @returns The blocks.
 */
export function capacityBlocks_build(model: CapacityModel): Array<{ key: string; title: string; rows: CapacityPaneRow[] }> {
  const byFamily: Map<string, CapacityPaneRow[]> = new Map();
  for (const row of model.rows) {
    const rows: CapacityPaneRow[] = byFamily.get(row.family) ?? [];
    rows.push({ key: `${row.family}:${row.limit}:${row.zone ?? 'region'}`, family: row.family, limit: row.limit, zone: zone_text(row.zone), value: row.value, used: row.used, available: row.available });
    byFamily.set(row.family, rows);
  }
  return [...byFamily.entries()].map(([family, rows]): { key: string; title: string; rows: CapacityPaneRow[] } => ({ key: family, title: `${family} · ${model.region}`, rows }));
}

/** The CAPACITY pane: a region's room as a listing. */
export class CapacityPanel {
  private readonly listing: Listing<CapacityPaneRow>;
  private readonly state: HTMLElement | null;
  private model: CapacityModel | null = null;

  /**
   * @param mount - The stamped pane element (`tpl-pane-capacity`).
   * @param hooks - The session line.
   */
  constructor(mount: HTMLElement, private readonly hooks: CapacityPanelHooks) {
    const panel: HTMLElement | null = mount.querySelector<HTMLElement>('.capacity-panel');
    if (panel === null) throw new Error('capacity pane: no .capacity-panel in its template');
    this.state = mount.querySelector<HTMLElement>('.pane-state');
    this.listing = new Listing<CapacityPaneRow>({
      mount: panel,
      traits: this.traits_declare(),
      key: (row: CapacityPaneRow): string => row.key,
      chrome: { root: mount, prefix: 'capacity' },
      caps: 'root',
      // A readout: a row is a limit at a zone, and acts on nothing.
      activatable: (): boolean => false,
      row: { className: (row: CapacityPaneRow): string => `capacity-row${row.available === 0 ? ' capacity-row-full' : ''}` },
    });
  }

  /** The columns: the family, the limit, the zone (which takes the expanse), and the three figures. */
  private traits_declare(): ReadonlyArray<ListingTrait<CapacityPaneRow>> {
    return [
      { key: 'family', label: 'FAMILY', className: 'capacity-family', width: 'minmax(4em, 5em)', cell: (row: CapacityPaneRow): string => row.family },
      { key: 'limit', label: 'LIMIT', className: 'capacity-limit', width: 'minmax(10em, 16em)', cell: (row: CapacityPaneRow): string => row.limit },
      { key: 'zone', label: 'ZONE', className: 'capacity-zone', width: 'minmax(8em, 1fr)', cell: (row: CapacityPaneRow): string => row.zone },
      { key: 'used', label: 'USED', className: 'capacity-num', width: '6em', cell: (row: CapacityPaneRow): string => figure_text(row.used), compare: (row: CapacityPaneRow): number => row.used ?? -1 },
      { key: 'available', label: 'FREE', className: 'capacity-num', width: '6em', cell: (row: CapacityPaneRow): string => figure_text(row.available), compare: (row: CapacityPaneRow): number => row.available ?? -1 },
      { key: 'value', label: 'OF', className: 'capacity-num', width: '6em', cell: (row: CapacityPaneRow): string => String(row.value), compare: (row: CapacityPaneRow): number => row.value },
    ];
  }

  /** Shows a model the session answered. */
  public model_show(model: CapacityModel): void {
    this.model = model;
    this.render();
  }

  /** The families on the pane, in the model's order. */
  public families_shown(): string[] {
    return this.model === null ? [] : [...new Set(this.model.rows.map((row: CapacityRow): string => row.family))];
  }

  /** Asks the session again, for one family or for every one it offers, and shows the answer. */
  public async family_ask(family: string): Promise<void> {
    const model: CapacityModel | null = await this.hooks.ask(family === '' ? 'capacity' : `capacity ${family}`);
    if (model !== null) this.model_show(model);
  }

  private render(): void {
    const model: CapacityModel | null = this.model;
    if (model === null) return;
    const head = (text: string): HTMLElement => {
      const header: HTMLElement = document.createElement('header');
      header.className = 'files-path capacity-block-head';
      header.textContent = text;
      return header;
    };
    const blocks: Array<ListingBlock<CapacityPaneRow>> = capacityBlocks_build(model).map((block) => ({ key: block.key, header: head(block.title), rows: block.rows }));
    this.listing.rows_set(blocks, { field: 'capacity' });
    // The bar names the region read and the families on the pane.
    if (this.state !== null) this.state.textContent = `${model.region.toUpperCase()} · ${this.families_shown().join(' · ') || 'NO FAMILY'}`;
  }
}
