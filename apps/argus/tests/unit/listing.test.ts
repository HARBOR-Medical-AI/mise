/**
 * @jest-environment jsdom
 */
/**
 * @file Unit tests for the listing façade.
 *
 * These prove the façade's own claims against a real DOM (jsdom): that
 * every row holds exactly as many cells as the grid has tracks, `..` rows
 * and action tracks included — the defect that shipped, which no test
 * caught — and that the two laws the façade expresses hold as
 * consequences of the declaration. Layout and computed geometry are not
 * jsdom's to answer; those stay with the smoke suite.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  Listing,
  listingNumbering_set,
  listingChild_declare,
  listingState_compose,
  listingTemplate_build,
  type ListingBlock,
  type ListingDeclaration,
  type ListingStateParts,
} from '../../src/features/roster/listing.js';
import type { ListingTrait } from '../../src/features/roster/row.js';

/** One fake entry: enough shape for a glyph, a name and a sortable size. */
interface Entry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
}

/** A fake study with series beneath it, for the two-level case. */
interface Study {
  uid: string;
  description: string;
  series: Series[];
}

interface Series {
  uid: string;
  modality: string;
}

const ENTRY_TRAITS: ReadonlyArray<ListingTrait<Entry>> = [
  {
    key: 'glyph',
    label: '',
    className: 'glyph',
    capped: false,
    width: '1.4em',
    cell: (entry: Entry): string => (entry.kind === 'dir' ? '▸' : '·'),
  },
  {
    key: 'name',
    label: 'NAME',
    className: 'name',
    width: '1fr',
    cell: (entry: Entry): string => entry.name,
  },
  {
    key: 'size',
    label: 'SIZE',
    className: 'size',
    width: '6em',
    // Displayed short, ordered by the number: the case `compare` exists for.
    cell: (entry: Entry): string => `${entry.size}B`,
    compare: (entry: Entry): number => entry.size,
  },
];

const ENTRIES: Entry[] = [
  { name: 'beta', kind: 'file', size: 100 },
  { name: 'alpha', kind: 'dir', size: 0 },
  { name: 'gamma', kind: 'file', size: 20 },
];

const UP: Entry = { name: '..', kind: 'dir', size: 0 };
/** The place's own row, offered verbs though it stands outside the order. */
const HERE: Entry = { name: '.', kind: 'file', size: 0 };

/** Waits for the frame RosterOrder and the façade coalesce their repaints into. */
async function frame(): Promise<void> {
  await new Promise<void>((resolve: () => void): void => {
    window.requestAnimationFrame((): void => {
      window.requestAnimationFrame((): void => resolve());
    });
  });
}

/**
 * A pane root carrying the chrome convention under one prefix: the state
 * span, the FILTER and SELECT blocks, and the mount. Framed, the mount
 * stands in a field beside a mode frame (with its fill), which is where the
 * façade mints the row zone; unframed, there is no frame and the verbs stay
 * on the row. The root is the workspace pane, whose `data-modes` is what
 * opens the frame.
 */
function chrome_build(prefix: string, framed: boolean = false): { root: HTMLElement; mount: HTMLElement; zone: HTMLElement } {
  const root: HTMLElement = document.createElement('div');
  root.className = 'workspace-pane';
  root.innerHTML = framed
    ? `
    <span class="pane-state"></span>
    <div class="field">
      <aside class="mode-frame">
        <button class="${prefix}-filter">FILTER OFF</button>
        <button class="${prefix}-select">SELECT OFF</button>
        <span class="mode-fill"></span>
      </aside>
      <div class="mount"></div>
    </div>
  `
    : `
    <span class="pane-state"></span>
    <button class="${prefix}-filter">FILTER OFF</button>
    <button class="${prefix}-select">SELECT OFF</button>
    <div class="mount"></div>
  `;
  document.body.appendChild(root);
  const mount: HTMLElement = root.querySelector<HTMLElement>('.mount') as HTMLElement;
  // The zone is the façade's to mint; a framed harness reads it back after
  // construction. Unframed, a placeholder stands in that no listing touches.
  const zone: HTMLElement = document.createElement('span');
  return { root, mount, zone };
}

/** The zone the façade minted into a framed harness. */
function zone_minted(root: HTMLElement, prefix: string = 'files'): HTMLElement {
  return root.querySelector<HTMLElement>(`.mode-frame > .${prefix}-row-zone`) as HTMLElement;
}

/** The tracks a template declares. */
function tracks_count(template: string): number {
  return template.trim().split(/\s+/).length;
}

/** The rows on stage, lead rows included. */
function rows_onStage(mount: HTMLElement): HTMLElement[] {
  return [...mount.querySelectorAll<HTMLElement>('.listing-row')];
}

/** The text of a row's name cell. */
function names_onStage(mount: HTMLElement): string[] {
  return rows_onStage(mount).map((row: HTMLElement): string => row.querySelector('.name')?.textContent ?? '');
}

function listing_build(
  overrides: Partial<ListingDeclaration<Entry>> = {},
  prefix: string = 'files',
): { listing: Listing<Entry>; root: HTMLElement; mount: HTMLElement; zone: HTMLElement } {
  const { root, mount, zone } = chrome_build(prefix);
  const listing: Listing<Entry> = new Listing<Entry>({
    mount,
    traits: ENTRY_TRAITS,
    key: (entry: Entry): string => entry.name,
    chrome: { root, prefix },
    defaultSort: { key: 'name', dir: 'asc' },
    ...overrides,
  });
  return { listing, root, mount, zone };
}

/** A listing whose verbs ride the frame: the mount stands in a framed field, and the façade mints the zone. */
function framed_build(
  overrides: Partial<ListingDeclaration<Entry>> = {},
): { listing: Listing<Entry>; root: HTMLElement; mount: HTMLElement; zone: HTMLElement } {
  const { root, mount } = chrome_build('files', true);
  const listing: Listing<Entry> = new Listing<Entry>({
    mount,
    traits: ENTRY_TRAITS,
    key: (entry: Entry): string => entry.name,
    chrome: { root, prefix: 'files' },
    defaultSort: { key: 'name', dir: 'asc' },
    ...overrides,
  });
  return { listing, root, mount, zone: zone_minted(root) };
}

/** The labels of the verbs the zone holds. */
function zoneVerbs_of(zone: HTMLElement): string[] {
  return [...zone.querySelectorAll('.listing-action')].map((b: Element): string => b.textContent ?? '');
}

/** The verbs one row is offered: OPEN for a file, none for a directory. */
const OPEN_FILES: (entry: Entry) => ReadonlyArray<{ label: string; run: (entry: Entry) => void }> =
  (entry: Entry) => (entry.kind === 'file' ? [{ label: 'OPEN', run: (): void => {} }] : []);

describe('listingTemplate_build', () => {
  it('lists every trait track, then the action track', () => {
    expect(listingTemplate_build(ENTRY_TRAITS, { width: '21em', of: (): [] => [] })).toBe('1.4em 1fr 6em 21em');
    expect(listingTemplate_build(ENTRY_TRAITS)).toBe('1.4em 1fr 6em');
  });

  it('refuses a trait without a width', () => {
    const traits: ReadonlyArray<ListingTrait<Entry>> = [{ key: 'x', label: 'X', className: 'x', cell: (): string => '' }];
    expect((): string => listingTemplate_build(traits)).toThrow(/declares no width/);
  });

  it('refuses a content-sized track, and accepts a fixed one, a share, or a minmax with a fixed minimum', () => {
    const named = (width: string): ReadonlyArray<ListingTrait<Entry>> =>
      [{ key: 'w', label: 'W', className: 'w', width, cell: (): string => '' }];
    for (const bad of ['auto', 'min-content', 'max-content', 'fit-content(10em)', 'minmax(0, 13em)', 'minmax(0px, 1fr)']) {
      expect((): string => listingTemplate_build(named(bad))).toThrow(/content-sized/);
    }
    for (const good of ['13em', '1fr', '7.5em', 'minmax(5em, 1fr)', 'minmax(4em, 12em)', '120px', '0.5fr']) {
      expect(listingTemplate_build(named(good))).toBe(good);
    }
    expect((): string => listingTemplate_build(ENTRY_TRAITS, { width: 'auto', of: (): [] => [] })).toThrow(/content-sized/);
  });

  it('refuses actions on the row that declare no track', () => {
    expect((): string => listingTemplate_build(ENTRY_TRAITS, { of: (): [] => [] })).toThrow(/declare no track/);
  });

  it('refuses an uncapped trait that does not lead', () => {
    const traits: ReadonlyArray<ListingTrait<Entry>> = [
      { key: 'a', label: 'A', className: 'a', width: '1fr', cell: (): string => '' },
      { key: 'b', label: '', className: 'b', width: '1em', capped: false, cell: (): string => '' },
    ];
    expect((): string => listingTemplate_build(traits)).toThrow(/must lead/);
  });
});

describe('the grid is one declaration', () => {
  it('writes the template on the grid host and every row fills every track, lead rows and action track included', () => {
    const { listing, mount } = listing_build({ actions: { width: '21em', of: (): [] => [] } });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    const template: string = mount.style.getPropertyValue('--roster-cols');
    expect(template).toBe('5.2rem 1.4em 1fr 6em 21em');
    const rows: HTMLElement[] = rows_onStage(mount);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.children).toHaveLength(tracks_count(template));
    expect(rows[0]?.querySelector('.name')?.textContent).toBe('..');
  });

  it('blanks exactly the leading uncapped columns in the caps row', () => {
    const { listing, mount } = listing_build();
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    const caps: HTMLElement | null = mount.querySelector<HTMLElement>('.roster-caps');
    expect(caps).not.toBeNull();
    const cells: Element[] = [...(caps as HTMLElement).children];
    expect(cells).toHaveLength(4);
    // Two leading uncapped columns are blanked now: the index the façade
    // mints for every listing, then the pane's own glyph.
    expect(cells[0]?.classList.contains('roster-cap')).toBe(false);
    expect(cells[1]?.classList.contains('roster-cap')).toBe(false);
    expect(cells[2]?.classList.contains('roster-cap')).toBe(true);
    expect(cells[3]?.classList.contains('roster-cap')).toBe(true);
  });

  it('lets a form stand on the template through gridHost', () => {
    const { root, mount } = chrome_build('pacs');
    const listing: Listing<Entry> = new Listing<Entry>({
      mount,
      gridHost: root,
      traits: ENTRY_TRAITS,
      key: (entry: Entry): string => entry.name,
    });
    expect(root.style.getPropertyValue('--roster-cols')).toBe(listing.template_get());
    expect(mount.style.getPropertyValue('--roster-cols')).toBe('');
  });
});

describe('a-row-is-indicated-before-it-is-acted-on', () => {
  it('with no actions declared there is no track and a click activates', () => {
    const activate = jest.fn();
    const { listing, mount } = listing_build({ activate });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    expect(mount.querySelector('.listing-actions')).toBeNull();
    expect(tracks_count(listing.template_get())).toBe(4);
    const row: HTMLElement = rows_onStage(mount)[0] as HTMLElement;
    row.click();
    expect(activate).toHaveBeenCalledWith(ENTRIES[1]);
    expect(listing.indicated_get()).toBeNull();
  });

  it('with actions declared a click indicates, a double-click activates, and no row changes shape', () => {
    const activate = jest.fn();
    const indicated = jest.fn();
    const run = jest.fn();
    const { listing, mount } = listing_build({
      activate,
      indicated,
      actions: { width: '21em', of: (): ReadonlyArray<{ label: string; run: (entry: Entry) => void }> => [{ label: 'OPEN', run }] },
    });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    const before: number[] = rows_onStage(mount).map((row: HTMLElement): number => row.children.length);
    const row: HTMLElement = rows_onStage(mount)[1] as HTMLElement;
    row.click();
    expect(activate).not.toHaveBeenCalled();
    expect(indicated).toHaveBeenCalledWith(ENTRIES[1]);
    expect(listing.indicated_get()).toBe('alpha');
    expect(row.classList.contains('listing-indicated')).toBe(true);
    expect(row.querySelector('.listing-action')?.textContent).toBe('OPEN');
    // The verbs filled the track; nothing gained or lost a cell.
    expect(rows_onStage(mount).map((r: HTMLElement): number => r.children.length)).toEqual(before);
    // The verb runs on its row and does not activate it.
    (row.querySelector<HTMLButtonElement>('.listing-action') as HTMLButtonElement).click();
    expect(run).toHaveBeenCalledWith(ENTRIES[1]);
    expect(activate).not.toHaveBeenCalled();
    // Indicating another empties the first.
    (rows_onStage(mount)[2] as HTMLElement).click();
    expect(row.querySelector('.listing-action')).toBeNull();
    expect(row.classList.contains('listing-indicated')).toBe(false);
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(activate).toHaveBeenCalledWith(ENTRIES[1]);
    expect(listing.indicated_get()).toBeNull();
  });

  it('a lead row offered no verbs keeps its single click; one offered verbs indicates like any row', () => {
    const activate = jest.fn();
    const { listing, mount } = listing_build({
      activate,
      actions: { width: '21em', of: OPEN_FILES },
    });
    // `..` is a directory: nothing offered, one click, never indicated.
    listing.rows_set([{ key: '/x', lead: [UP, HERE], rows: ENTRIES }], { field: '/x' });
    const up: HTMLElement = rows_onStage(mount)[0] as HTMLElement;
    up.click();
    expect(activate).toHaveBeenCalledWith(UP);
    expect(listing.indicated_get()).toBeNull();
    // `.` is offered the place's verbs: a click indicates it.
    const here: HTMLElement = rows_onStage(mount)[1] as HTMLElement;
    here.click();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(listing.indicated_get()).toBe('.');
    expect(here.querySelector('.listing-action')?.textContent).toBe('OPEN');
  });

  it('a readout lands beside the indicated row and nowhere else', () => {
    const { listing, mount } = listing_build({
      actions: { width: '21em', of: (): [] => [] },
    });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    listing.readout_show('alpha', 'NOBODY');
    expect(mount.querySelector('.listing-readout')).toBeNull();
    listing.row_indicate('alpha');
    listing.readout_show('alpha', 'SHARED WITH x');
    expect(listing.row_element('alpha')?.querySelector('.listing-readout')?.textContent).toBe('SHARED WITH x');
    listing.readout_show('beta', 'STALE');
    expect(mount.querySelectorAll('.listing-readout')).toHaveLength(1);
  });
});

describe('a-selection-belongs-to-the-field', () => {
  function selectable(): { listing: Listing<Entry>; root: HTMLElement; mount: HTMLElement; zone: HTMLElement } {
    return framed_build({
      actions: { of: (): [] => [] },
      selection: {
        verbs: (rows: ReadonlyArray<[string, Entry]>): ReadonlyArray<{ label: string; run: () => void }> =>
          [{ label: `RM ${rows.length}`, run: (): void => {} }],
      },
    });
  }

  it('let go, it hears nothing more: a word from the language, a press on its chrome and a closing row zone change nothing', async () => {
    const { listing, root, mount } = selectable();
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'filter', text: 'alp' } }));
    await frame();
    expect(names_onStage(mount)).toEqual(['alpha']);
    listing.hold_release();
    // The language says to show everything again, and to sort: the listing is no longer listening.
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'filter', text: '' } }));
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'sort', key: 'size', dir: 'desc' } }));
    await frame();
    expect(names_onStage(mount)).toEqual(['alpha']);
    // SELECT is pressed on the pane's chrome: nothing turns on.
    (root.querySelector('.files-select') as HTMLElement).click();
    expect(root.querySelector('.files-select')?.textContent).not.toBe('SELECT ON');
    // Rows handed to it afterwards are not drawn: let go is let go.
    listing.rows_set([{ key: '/y', rows: [{ name: 'late', kind: 'file', size: 1 }] }], { field: '/y' });
    expect(names_onStage(mount)).toEqual(['alpha']);
    // Let go twice is let go once.
    expect((): void => { listing.hold_release(); }).not.toThrow();
  });

  it('refuses a listing that selects without a row zone for the verbs', () => {
    expect((): Listing<Entry> => listing_build({
      selection: { verbs: (): [] => [] },
    }).listing).toThrow(/row zone/);
  });

  it('gathers on click while SELECT is on, and the zone holds the verbs', () => {
    const { listing, root, mount, zone } = selectable();
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    listing.select_toggle(true);
    expect(root.querySelector('.files-select')?.textContent).toBe('SELECT ON');
    (rows_onStage(mount)[1] as HTMLElement).click();
    (rows_onStage(mount)[2] as HTMLElement).click();
    expect(listing.selection_get()).toEqual(['alpha', 'beta']);
    expect(listing.indicated_get()).toBeNull();
    expect(zoneVerbs_of(zone)).toEqual(['RM 2']);
    expect(root.querySelector('.pane-state')?.textContent).toBe('SELECT · 2 SELECTED');
    // The lead row is not a member of anything.
    (rows_onStage(mount)[0] as HTMLElement).click();
    expect(listing.selection_get()).toEqual(['alpha', 'beta']);
  });

  it('survives a filter and a re-listing of the same field, and clears on another', async () => {
    const { listing, root, mount } = selectable();
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    listing.select_toggle(true);
    (rows_onStage(mount)[0] as HTMLElement).click();
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(listing.selection_get()).toEqual(['alpha', 'beta']);

    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'filter', text: 'alp' } }));
    await frame();
    expect(names_onStage(mount)).toEqual(['alpha']);
    expect(listing.selection_get()).toEqual(['alpha', 'beta']);
    expect(root.querySelector('.pane-state')?.textContent).toBe('SELECT · FILTERED 1/3 · 2 SELECTED · 1 SHOWN');

    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'filter', text: '' } }));
    await frame();
    listing.rows_set([{ key: '/x', rows: [...ENTRIES] }], { field: '/x' });
    expect(listing.selection_get()).toEqual(['alpha', 'beta']);
    expect(listing.row_element('alpha')?.classList.contains('listing-selected')).toBe(true);

    listing.select_toggle(false);
    expect(listing.selection_get()).toEqual(['alpha', 'beta']);

    listing.rows_set([{ key: '/y', rows: ENTRIES }], { field: '/y' });
    expect(listing.selection_get()).toEqual([]);
  });
});

describe('a-row-s-verbs-live-in-the-frame', () => {
  /** MutationObserver delivers on a microtask; one turn is enough. */
  async function observed(): Promise<void> {
    await Promise.resolve();
  }

  it('mints its zone into the field\'s frame, above the fill, and a listing with no frame keeps the track', () => {
    const { root } = framed_build({ actions: { of: OPEN_FILES } });
    const frame: HTMLElement = root.querySelector('.mode-frame') as HTMLElement;
    const zone: HTMLElement = zone_minted(root);
    expect(zone.classList.contains('listing-zone')).toBe(true);
    expect(zone.nextElementSibling?.classList.contains('mode-fill')).toBe(true);
    expect(frame.querySelectorAll('.listing-zone')).toHaveLength(1);
    const { mount: bare } = listing_build({ actions: { width: '21em', of: OPEN_FILES } });
    expect(bare.classList.contains('listing-framed')).toBe(false);
  });

  it('opens the frame of the pane it is IN, even when it was built before joining the document', () => {
    // The node overlay stamps its body, builds the browser on it, and only
    // then appends the whole thing to the scene. A pane looked up at
    // construction is null forever after, and the zone then filled with
    // verbs behind a frame that was never told to open: the listing held a
    // stale answer to "where do I live" while the document held the true
    // one. The façade asks the document each time instead.
    const detached: HTMLElement = document.createElement('div');
    detached.className = 'workspace-pane';
    detached.innerHTML = `
      <span class="pane-state"></span>
      <div class="field">
        <aside class="mode-frame"><span class="mode-fill"></span></aside>
        <div class="mount"></div>
      </div>`;
    const mount: HTMLElement = detached.querySelector('.mount') as HTMLElement;
    const listing: Listing<Entry> = new Listing<Entry>({
      mount,
      traits: ENTRY_TRAITS,
      key: (entry: Entry): string => entry.name,
      chrome: { root: detached, prefix: 'files' },
      actions: { of: OPEN_FILES },
    });
    // Built while detached, then put on stage, exactly as the overlay does.
    document.body.appendChild(detached);
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    (mount.querySelector('.listing-row') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const zone: HTMLElement = zone_minted(detached);
    expect(zone.querySelectorAll('.listing-action').length).toBeGreaterThan(0);
    expect(detached.dataset['modes']).toBe('open');
  });

  it('mints no track: the grid has only the traits, and no row carries an action cell', () => {
    const { listing, mount } = framed_build({ actions: { of: OPEN_FILES } });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    expect(listing.template_get()).toBe('5.2rem 1.4em 1fr 6em');
    expect(mount.style.getPropertyValue('--roster-cols')).toBe('5.2rem 1.4em 1fr 6em');
    expect(mount.querySelector('.listing-actions')).toBeNull();
    expect(rows_onStage(mount).every((row: HTMLElement): boolean => row.children.length === 4)).toBe(true);
    expect(mount.classList.contains('listing-framed')).toBe(true);
  });

  it('a click puts the row\'s verbs in the zone and opens the frame; another row replaces them; standing down empties the zone and retracts the frame', () => {
    const run = jest.fn();
    const activate = jest.fn();
    const { listing, root, mount, zone } = framed_build({
      activate,
      actions: { of: (entry: Entry): ReadonlyArray<{ label: string; run: (entry: Entry) => void }> => (entry.kind === 'file' ? [{ label: `OPEN ${entry.name}`, run }] : []) },
    });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    expect(zone.hidden).toBe(true);
    expect(root.dataset['modes']).toBeUndefined();
    const beta: HTMLElement = rows_onStage(mount)[2] as HTMLElement;
    beta.click();
    expect(activate).not.toHaveBeenCalled();
    expect(listing.indicated_get()).toBe('beta');
    expect(beta.classList.contains('listing-indicated')).toBe(true);
    expect(beta.querySelector('.listing-action')).toBeNull();
    expect(zoneVerbs_of(zone)).toEqual(['OPEN beta']);
    expect(zone.hidden).toBe(false);
    expect(root.dataset['modes']).toBe('open');
    // The verb runs on the row it was offered for.
    (zone.querySelector<HTMLButtonElement>('.listing-action') as HTMLButtonElement).click();
    expect(run).toHaveBeenCalledWith(ENTRIES[0]);
    // Another row's verbs replace them; the frame stays open.
    (rows_onStage(mount)[3] as HTMLElement).click();
    expect(zoneVerbs_of(zone)).toEqual(['OPEN gamma']);
    expect(beta.classList.contains('listing-indicated')).toBe(false);
    expect(root.dataset['modes']).toBe('open');
    // Standing down empties the zone and retracts the frame the verbs opened.
    listing.row_indicate(null);
    expect(zone.hidden).toBe(true);
    expect(zoneVerbs_of(zone)).toEqual([]);
    expect(root.dataset['modes']).toBeUndefined();
  });

  it('a row offered no verbs keeps its single click', () => {
    const activate = jest.fn();
    const { listing, mount, zone } = framed_build({ activate, actions: { of: OPEN_FILES } });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    // alpha is a directory: one click activates, nothing is indicated.
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(activate).toHaveBeenCalledWith(ENTRIES[1]);
    expect(listing.indicated_get()).toBeNull();
    expect(zone.hidden).toBe(true);
  });

  it('the frame retracting stands the row down', async () => {
    const { listing, root, mount, zone } = framed_build({ actions: { of: OPEN_FILES } });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(listing.indicated_get()).toBe('beta');
    // Esc, the strip, a touch on the field: whatever retracts it.
    delete root.dataset['modes'];
    await observed();
    expect(listing.indicated_get()).toBeNull();
    expect(zone.hidden).toBe(true);
  });

  it('a frame the operator opened, or pressed something else on, is theirs to close', async () => {
    const { listing, root, mount } = framed_build({ actions: { of: OPEN_FILES } });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    root.dataset['modes'] = 'open';
    (rows_onStage(mount)[1] as HTMLElement).click();
    listing.row_indicate(null);
    expect(root.dataset['modes']).toBe('open');
    delete root.dataset['modes'];
    await observed();
    // Opened by the verbs, then a block on the frame is pressed: the
    // frame is the operator's now, and the row standing down leaves it.
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(root.dataset['modes']).toBe('open');
    (root.querySelector<HTMLElement>('.files-filter') as HTMLElement).click();
    listing.row_indicate(null);
    expect(root.dataset['modes']).toBe('open');
  });

  it('SELECT standing the indication down does not retract the frame', () => {
    const { listing, root, mount, zone } = framed_build({
      actions: { of: OPEN_FILES },
      selection: { verbs: (rows: ReadonlyArray<[string, Entry]>): ReadonlyArray<{ label: string; run: () => void }> => [{ label: `RM ${rows.length}`, run: (): void => {} }] },
    });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(root.dataset['modes']).toBe('open');
    listing.select_toggle(true);
    expect(listing.indicated_get()).toBeNull();
    expect(root.dataset['modes']).toBe('open');
    expect(zone.hidden).toBe(true);
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(zoneVerbs_of(zone)).toEqual(['RM 1']);
  });

  it('a readout lands beneath the zone\'s verbs', () => {
    const { listing, mount, zone } = framed_build({ actions: { of: OPEN_FILES } });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    listing.readout_show('beta', 'NOBODY');
    expect(zone.querySelector('.listing-readout')).toBeNull();
    (rows_onStage(mount)[1] as HTMLElement).click();
    listing.readout_show('beta', 'SHARED WITH x');
    expect(zone.querySelector('.listing-readout')?.textContent).toBe('SHARED WITH x');
    expect(zone.lastElementChild?.classList.contains('listing-readout')).toBe(true);
    listing.readout_show('gamma', 'STALE');
    expect(zone.querySelectorAll('.listing-readout')).toHaveLength(1);
  });

  it('the indication belongs to the field: it survives a re-listing of the same field, and a sort, and clears on another', async () => {
    const indicated = jest.fn();
    const { listing, root, mount, zone } = framed_build({ indicated, actions: { of: OPEN_FILES } });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    (rows_onStage(mount)[1] as HTMLElement).click();
    expect(listing.indicated_get()).toBe('beta');
    expect(indicated).toHaveBeenCalledTimes(1);
    // The same rows arrive again: the new row is indicated, the pane is
    // not told twice, the frame stays.
    listing.rows_set([{ key: '/x', rows: [...ENTRIES] }], { field: '/x' });
    expect(listing.indicated_get()).toBe('beta');
    expect(listing.row_element('beta')?.classList.contains('listing-indicated')).toBe(true);
    expect(zoneVerbs_of(zone)).toEqual(['OPEN']);
    expect(indicated).toHaveBeenCalledTimes(1);
    expect(root.dataset['modes']).toBe('open');
    // A sort repaints; the indication holds.
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'sort', key: 'size', dir: 'desc' } }));
    await frame();
    expect(listing.indicated_get()).toBe('beta');
    expect(mount.querySelectorAll('.listing-indicated')).toHaveLength(1);
    // The row leaves: the indication goes with it.
    listing.rows_set([{ key: '/x', rows: ENTRIES.filter((entry: Entry): boolean => entry.name !== 'beta') }], { field: '/x' });
    expect(listing.indicated_get()).toBeNull();
    expect(zone.hidden).toBe(true);
    expect(root.dataset['modes']).toBeUndefined();
    // Navigation clears it.
    (listing.row_element('gamma') as HTMLElement).click();
    expect(listing.indicated_get()).toBe('gamma');
    listing.rows_set([{ key: '/y', rows: ENTRIES }], { field: '/y' });
    expect(listing.indicated_get()).toBeNull();
    expect(mount.querySelector('.listing-indicated')).toBeNull();
  });

  it('a folding row\'s click folds AND indicates, the indication survives the repaint, and a level beneath takes the one indication over', async () => {
    interface Book { title: string; pages: string[] }
    const pull = jest.fn();
    const open = jest.fn();
    const { root, mount } = chrome_build('files', true);
    const listing: Listing<Book> = new Listing<Book>({
      mount,
      traits: [{ key: 'title', label: 'TITLE', className: 'title', width: '1fr', cell: (book: Book): string => book.title }],
      key: (book: Book): string => book.title,
      chrome: { root, prefix: 'files' },
      actions: { of: (book: Book): ReadonlyArray<{ label: string; run: (book: Book) => void }> => [{ label: `PULL ${book.title}`, run: pull }] },
      child: listingChild_declare(
        (book: Book): ReadonlyArray<string> => book.pages,
        {
          traits: [{ key: 'page', label: 'PAGE', className: 'page', width: '1fr', cell: (page: string): string => page }],
          key: (page: string): string => page,
          actions: { of: (page: string): ReadonlyArray<{ label: string; run: (page: string) => void }> => [{ label: `OPEN ${page}`, run: open }] },
        },
      ),
    });
    const zone: HTMLElement = zone_minted(root);
    listing.rows_set([{ key: 'shelf', rows: [{ title: 'a', pages: ['a1', 'a2'] }, { title: 'b', pages: ['b1'] }] }], { field: 'shelf' });
    const bookA: HTMLElement = listing.row_element('a') as HTMLElement;
    bookA.click();
    // Indicated at once, and folded open on the next frame; still indicated after.
    expect(listing.indicated_get()).toBe('a');
    expect(zoneVerbs_of(zone)).toEqual(['PULL a']);
    await frame();
    expect(mount.querySelector('.listing-group.listing-open')).not.toBeNull();
    expect(listing.indicated_get()).toBe('a');
    expect(listing.row_element('a')?.classList.contains('listing-indicated')).toBe(true);
    expect(zoneVerbs_of(zone)).toEqual(['PULL a']);
    expect(root.dataset['modes']).toBe('open');
    // A page beneath it: the book stands down, the page's verbs take the zone.
    const page: HTMLElement = mount.querySelector('.listing-level .listing-row') as HTMLElement;
    page.click();
    expect(listing.indicated_get()).toBe('a1');
    expect(zoneVerbs_of(zone)).toEqual(['OPEN a1']);
    expect(mount.querySelectorAll('.listing-indicated')).toHaveLength(1);
    expect(listing.row_element('a')?.classList.contains('listing-indicated')).toBe(false);
    // Standing down from the listing clears whichever level holds it.
    listing.row_indicate(null);
    expect(listing.indicated_get()).toBeNull();
    expect(mount.querySelector('.listing-indicated')).toBeNull();
    expect(zone.hidden).toBe(true);
    // Folding the book closed keeps it indicated (it is still on stage).
    bookA.click();
    await frame();
    expect(mount.querySelector('.listing-group.listing-open')).toBeNull();
    expect(listing.indicated_get()).toBe('a');
  });

  it('with a control declared, the control cell folds and selects nothing, and the row selects and folds nothing', async () => {
    interface Book { title: string; pages: string[] }
    const { root, mount } = chrome_build('files', true);
    const listing: Listing<Book> = new Listing<Book>({
      mount,
      traits: [
        { key: 'fold', label: '', className: 'fold', capped: false, width: '2.2em', cell: (): string => '▸' },
        { key: 'title', label: 'TITLE', className: 'title', width: '1fr', cell: (book: Book): string => book.title },
      ],
      key: (book: Book): string => book.title,
      chrome: { root, prefix: 'files' },
      control: 'fold',
      actions: { of: (book: Book): ReadonlyArray<{ label: string; run: () => void }> => [{ label: `PULL ${book.title}`, run: (): void => {} }] },
      child: listingChild_declare(
        (book: Book): ReadonlyArray<string> => book.pages,
        { traits: [{ key: 'page', label: 'PAGE', className: 'page', width: '1fr', cell: (page: string): string => page }], key: (page: string): string => page },
      ),
    });
    const zone: HTMLElement = zone_minted(root);
    listing.rows_set([{ key: 'shelf', rows: [{ title: 'a', pages: ['a1'] }] }], { field: 'shelf' });
    const row = (): HTMLElement => listing.row_element('a') as HTMLElement;
    const foldCell = (): HTMLElement => row().querySelector('.listing-control') as HTMLElement;
    expect(foldCell().classList.contains('fold')).toBe(true);
    // The fold cell: folds, indicates nothing, opens no frame.
    foldCell().click();
    await frame();
    expect(mount.querySelector('.listing-group.listing-open')).not.toBeNull();
    expect(listing.indicated_get()).toBeNull();
    expect(zone.hidden).toBe(true);
    expect(root.dataset['modes']).toBeUndefined();
    // The row body: indicates, does not fold.
    (row().querySelector('.title') as HTMLElement).click();
    await frame();
    expect(listing.indicated_get()).toBe('a');
    expect(zoneVerbs_of(zone)).toEqual(['PULL a']);
    expect(mount.querySelector('.listing-group.listing-open')).not.toBeNull();
    // The fold cell again, while indicated: folds closed, indication holds.
    foldCell().click();
    await frame();
    expect(mount.querySelector('.listing-group.listing-open')).toBeNull();
    expect(listing.indicated_get()).toBe('a');
  });

  it('a control naming no trait is a declaration error', () => {
    const { mount } = chrome_build('files');
    const listing: Listing<Entry> = new Listing<Entry>({
      mount, traits: ENTRY_TRAITS, key: (entry: Entry): string => entry.name, control: 'nope',
      child: listingChild_declare((): ReadonlyArray<Entry> => [], { traits: ENTRY_TRAITS, key: (entry: Entry): string => entry.name }),
    });
    expect((): void => listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' })).toThrow(/names no trait/);
  });

  it('on a replacing level the control cell activates and selects nothing, and the row body selects and does not activate', () => {
    const activate = jest.fn();
    const { listing, mount, zone } = framed_build({
      activate,
      control: 'glyph',
      actions: { of: (): ReadonlyArray<{ label: string; run: () => void }> => [{ label: 'RM', run: (): void => {} }] },
    });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    const alpha: HTMLElement = listing.row_element('alpha') as HTMLElement;
    // The control cell (the glyph column here): enters, indicates nothing.
    (alpha.querySelector('.listing-control') as HTMLElement).click();
    expect(activate).toHaveBeenCalledWith(ENTRIES[1]);
    expect(listing.indicated_get()).toBeNull();
    expect(zone.hidden).toBe(true);
    // The body: indicates, does not enter.
    (alpha.querySelector('.name') as HTMLElement).click();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(listing.indicated_get()).toBe('alpha');
    expect(zoneVerbs_of(zone)).toEqual(['RM']);
    // A lead row's control activates it too, and moving on stands the
    // indicated row down and retracts the frame it opened.
    ((listing.row_element('..') as HTMLElement).querySelector('.listing-control') as HTMLElement).click();
    expect(activate).toHaveBeenCalledWith(UP);
    expect(listing.indicated_get()).toBeNull();
    expect(zone.hidden).toBe(true);
    expect(mount.querySelector('.listing-indicated')).toBeNull();
  });

  it('a refresh redraws the indicated row\'s verbs from their live predicates', () => {
    let lit: boolean = false;
    const { listing, mount, zone } = framed_build({
      actions: { of: (): ReadonlyArray<{ label: string; run: () => void; selected: () => boolean }> => [{ label: 'IMAGE', run: (): void => {}, selected: (): boolean => lit }] },
    });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    (rows_onStage(mount)[0] as HTMLElement).click();
    expect(zone.querySelector('.listing-action')?.classList.contains('listing-action-selected')).toBe(false);
    lit = true;
    listing.indication_refresh();
    expect(zone.querySelector('.listing-action')?.classList.contains('listing-action-selected')).toBe(true);
    expect(mount.querySelectorAll('.listing-indicated')).toHaveLength(1);
  });
});

describe('order', () => {
  it('sorts by the compare value, not the displayed text', async () => {
    const { listing, root, mount } = listing_build();
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    expect(names_onStage(mount)).toEqual(['alpha', 'beta', 'gamma']);
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'sort', key: 'size', dir: 'desc' } }));
    await frame();
    // As text, '100B' < '20B'; as bytes, 100 > 20.
    expect(names_onStage(mount)).toEqual(['beta', 'gamma', 'alpha']);
  });

  it('the FILTER block reads the strip', () => {
    const { listing, root } = listing_build();
    const block: HTMLElement = root.querySelector<HTMLElement>('.files-filter') as HTMLElement;
    expect(block.classList.contains('rail-off')).toBe(true);
    block.click();
    expect(block.textContent).toBe('FILTER ON');
    expect(block.classList.contains('rail-off')).toBe(false);
    listing.filter_toggle(false);
    expect(block.textContent).toBe('FILTER OFF');
  });
});

describe('the state line', () => {
  it('composes the default line from typed parts', () => {
    const parts: ListingStateParts = { filter: 'FILTERED 1/3', selecting: false, selected: 0, shown: 0 };
    expect(listingState_compose(parts)).toBe('FILTERED 1/3');
    expect(listingState_compose({ ...parts, filter: '', selected: 2, shown: 2 })).toBe('2 SELECTED');
    // Columns set aside for want of room are said, never clipped silently.
    expect(listingState_compose({ ...parts, filter: '', shed: 1 })).toBe('1 COLUMN HIDDEN');
    expect(listingState_compose({ ...parts, shed: 4 })).toBe('FILTERED 1/3 · 4 COLUMNS HIDDEN');
  });

  it('a composer may prepend its own words or decline to write', () => {
    const state = jest.fn((parts: ListingStateParts): string | null => (parts.selected > 0 ? null : `CWD · ${parts.filter}`));
    const { listing, root } = listing_build({ state });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    expect(state).toHaveBeenCalledWith({ filter: '', selecting: false, selected: 0, shown: 0, shed: 0 });
    expect(root.querySelector('.pane-state')?.textContent).toBe('CWD · ');
  });
});

describe('a painter', () => {
  it('replaces the grid for a block and receives the rows in order', () => {
    const { listing, mount } = listing_build({ actions: { width: '21em', of: (): [] => [] } });
    const painted: string[][] = [];
    listing.painter_set((block: ListingBlock<Entry>, into: HTMLElement): void => {
      painted.push(block.rows.map((entry: Entry): string => entry.name));
      const cards: HTMLElement = document.createElement('div');
      cards.className = 'cards';
      into.appendChild(cards);
    });
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    expect(painted).toEqual([['alpha', 'beta', 'gamma']]);
    expect(mount.querySelector('.cards')).not.toBeNull();
    expect(mount.querySelector('.listing-row')).toBeNull();
    // The frame is still seated: the caps still sort what the painter draws.
    expect(mount.querySelector('.roster-caps')).not.toBeNull();
    listing.painter_set(null);
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    expect(rows_onStage(mount)).toHaveLength(4);
  });
});

describe('verbs declared after construction', () => {
  it('mint the track, rewrite the template and repaint; withdrawn, they take the track with them', () => {
    const { listing, mount } = listing_build();
    listing.rows_set([{ key: '/x', lead: [UP], rows: ENTRIES }], { field: '/x' });
    expect(rows_onStage(mount).every((row: HTMLElement): boolean => row.children.length === 4)).toBe(true);
    listing.actions_declare({ width: '21em', of: (): [] => [] });
    expect(mount.style.getPropertyValue('--roster-cols')).toBe('5.2rem 1.4em 1fr 6em 21em');
    expect(rows_onStage(mount).every((row: HTMLElement): boolean => row.children.length === 5)).toBe(true);
    expect(mount.querySelectorAll('.listing-actions')).toHaveLength(4);
    listing.actions_declare(null);
    expect(mount.style.getPropertyValue('--roster-cols')).toBe('5.2rem 1.4em 1fr 6em');
    expect(rows_onStage(mount).every((row: HTMLElement): boolean => row.children.length === 4)).toBe(true);
  });
});

describe('a level beneath a level', () => {
  const SERIES_TRAITS: ReadonlyArray<ListingTrait<Series>> = [
    { key: 'series', label: 'SERIES', className: 'series', width: '1fr', cell: (series: Series): string => series.uid },
    { key: 'modality', label: 'MODALITY', className: 'modality', width: '4em', cell: (series: Series): string => series.modality },
  ];
  const STUDY_TRAITS: ReadonlyArray<ListingTrait<Study>> = [
    { key: 'fold', label: '', className: 'fold', width: '1.4em', capped: false, cell: (): string => '▸' },
    { key: 'study', label: 'STUDY', className: 'study', width: '1fr', cell: (study: Study): string => study.description },
  ];
  const STUDIES: Study[] = [
    { uid: 's1', description: 'brain', series: [{ uid: 's1a', modality: 'MR' }, { uid: 's1b', modality: 'CT' }] },
    { uid: 's2', description: 'knee', series: [{ uid: 's2a', modality: 'MR' }] },
  ];

  function levels_build(): { listing: Listing<Study>; root: HTMLElement; mount: HTMLElement } {
    const { root, mount } = chrome_build('pacs');
    const listing: Listing<Study> = new Listing<Study>({
      mount,
      traits: STUDY_TRAITS,
      key: (study: Study): string => study.uid,
      chrome: { root, prefix: 'pacs' },
      child: listingChild_declare(
        (study: Study): ReadonlyArray<Series> => study.series,
        { traits: SERIES_TRAITS, key: (series: Series): string => series.uid },
      ),
    });
    return { listing, root, mount };
  }

  it('mints the child caps per open group, on the child grid, and reads the parent filter', async () => {
    const { listing, root, mount } = levels_build();
    listing.rows_set([{ key: 'q', rows: STUDIES }], { field: 'q' });
    expect(mount.querySelectorAll('.listing-level')).toHaveLength(0);
    // Activating a study folds it open: its series list beneath it with caps of its own.
    (listing.row_element('s1') as HTMLElement).click();
    await frame();
    const level: HTMLElement | null = mount.querySelector<HTMLElement>('.listing-level');
    expect(level).not.toBeNull();
    expect((level as HTMLElement).style.getPropertyValue('--roster-cols')).toBe('5.2rem 1fr 4em');
    expect((level as HTMLElement).querySelectorAll('.roster-caps')).toHaveLength(1);
    expect((level as HTMLElement).querySelectorAll('.listing-row')).toHaveLength(2);
    expect(mount.querySelectorAll('.roster-caps')).toHaveLength(2);
    expect(listing.row_element('s1')?.classList.contains('listing-open')).toBe(true);

    // One filter, read down the levels: the knee study does not match
    // 'CT' itself but its parent survives when a series does — and only
    // the matching series show under a parent that did not match.
    (listing.row_element('s2') as HTMLElement).click();
    await frame();
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'filter', text: 'CT' } }));
    await frame();
    const studies: string[] = [...mount.querySelectorAll<HTMLElement>('.listing-rows > .listing-group > .listing-row .study')]
      .map((cell: HTMLElement): string => cell.textContent ?? '');
    expect(studies).toEqual(['brain']);
    const series: string[] = [...mount.querySelectorAll<HTMLElement>('.listing-level .series')]
      .map((cell: HTMLElement): string => cell.textContent ?? '');
    expect(series).toEqual(['s1b']);
    expect(root.querySelector('.pane-state')?.textContent).toBe('FILTERED 1/2');
  });

  it('a filter that keeps every row off stage says so through filteredEmpty, given its text', async () => {
    const { root, mount } = chrome_build('pacs');
    const listing: Listing<Study> = new Listing<Study>({
      mount,
      traits: STUDY_TRAITS,
      key: (study: Study): string => study.uid,
      chrome: { root, prefix: 'pacs' },
      empty: (): HTMLElement => { const note: HTMLElement = document.createElement('p'); note.className = 'note'; note.textContent = 'NO STUDIES FOUND'; return note; },
      filteredEmpty: (text: string): HTMLElement => { const note: HTMLElement = document.createElement('p'); note.className = 'miss'; note.textContent = `NOTHING MATCHES ${text}`; return note; },
    });
    listing.rows_set([{ key: 'q', rows: STUDIES }], { field: 'q' });
    expect(mount.querySelector('.miss')).toBeNull();
    listing.filter_set('no-such-study');
    await frame();
    expect(mount.querySelector('.miss')?.textContent).toBe('NOTHING MATCHES no-such-study');
    expect(mount.querySelector('.note')).toBeNull();
    expect(root.querySelector('.pane-state')?.textContent).toBe('FILTERED 0/2');
    listing.filter_set('');
    await frame();
    expect(mount.querySelector('.miss')).toBeNull();
    // Rows set but empty is the other declaration's case, not this one's.
    listing.filter_set('x');
    await frame();
    listing.rows_set([{ key: 'q', rows: [] }], { field: 'q' });
    expect(mount.querySelector('.miss')).toBeNull();
    expect(mount.querySelector('.note')?.textContent).toBe('NO STUDIES FOUND');
  });

  it('wraps a row that heads a level in a group, opens rows programmatically, and gives the form the child template', async () => {
    const { root, mount } = chrome_build('pacs');
    const listing: Listing<Study> = new Listing<Study>({
      mount,
      traits: STUDY_TRAITS,
      key: (study: Study): string => study.uid,
      chrome: { root, prefix: 'pacs' },
      row: { groupClassName: (): string => 'pacs-study' },
      empty: (): HTMLElement => { const note: HTMLElement = document.createElement('p'); note.className = 'note'; note.textContent = 'NO STUDIES FOUND'; return note; },
      child: listingChild_declare(
        (study: Study): ReadonlyArray<Series> => study.series,
        { traits: SERIES_TRAITS, key: (series: Series): string => series.uid },
      ),
    });
    // A child level leads with the index too, so the levels stay aligned.
    expect(listing.template_get(1)).toBe('5.2rem 1fr 4em');
    expect((): string => listing.template_get(2)).toThrow(/no listing level/);
    // Blocks set but empty: the field says so. No blocks: it says nothing.
    listing.rows_set([], { field: 'q' });
    expect(mount.querySelector('.note')).toBeNull();
    listing.rows_set([{ key: 'q', rows: [] }], { field: 'q' });
    expect(mount.querySelector('.note')?.textContent).toBe('NO STUDIES FOUND');
    listing.rows_set([{ key: 'q', rows: STUDIES }], { field: 'q' });
    const groups: HTMLElement[] = [...mount.querySelectorAll<HTMLElement>('.listing-group')];
    expect(groups).toHaveLength(2);
    expect(groups.every((group: HTMLElement): boolean => group.classList.contains('pacs-study'))).toBe(true);
    expect(groups[0]?.querySelector('.listing-row')).not.toBeNull();
    expect(mount.querySelectorAll('.listing-open')).toHaveLength(0);
    listing.open_set(0, ['s2']);
    const opened: HTMLElement | null = mount.querySelector<HTMLElement>('.listing-group.listing-open');
    expect(opened?.querySelector('.listing-row .study')?.textContent).toBe('knee');
    expect(opened?.querySelector('.listing-level')?.getAttribute('data-depth')).toBe('1');
    expect(opened?.querySelectorAll('.listing-level .listing-row')).toHaveLength(1);
    listing.open_clear();
    listing.rows_set([{ key: 'q', rows: STUDIES }], { field: 'q' });
    expect(mount.querySelectorAll('.listing-open')).toHaveLength(0);
    expect(listing.field_get()).not.toBeNull();
  });

  it('a sort names its level and the other levels ignore it', async () => {
    const { listing, root, mount } = levels_build();
    listing.rows_set([{ key: 'q', rows: STUDIES }], { field: 'q' });
    (listing.row_element('s1') as HTMLElement).click();
    await frame();
    root.dispatchEvent(new CustomEvent('argus:roster', { detail: { op: 'sort', key: 'modality', dir: 'asc' } }));
    await frame();
    const series: string[] = [...mount.querySelectorAll<HTMLElement>('.listing-level .series')]
      .map((cell: HTMLElement): string => cell.textContent ?? '');
    expect(series).toEqual(['s1b', 's1a']);
    const lit: HTMLElement | null = mount.querySelector<HTMLElement>('.listing-level .roster-cap.roster-active');
    expect(lit?.dataset['key']).toBe('modality');
    expect(mount.querySelector('.listing-rows > .listing-group > .listing-row .study')?.textContent).toBe('brain');
  });
});

describe('the index pill', () => {
  /** A listing whose rows say how the kernel addresses them. */
  const numbered_build = (mount: HTMLElement): Listing<Entry> => new Listing<Entry>({
    mount,
    traits: ENTRY_TRAITS,
    key: (entry: Entry): string => entry.name,
    address: (entry: Entry): string => `/home/chris/${entry.name}`,
  });

  it('leads with a pill per row, and numbers only the rows the session counts', () => {
    const mount: HTMLElement = document.createElement('div');
    document.body.appendChild(mount);
    listingNumbering_set({
      source: 'ls /home/chris',
      handles: [
        { kind: 'FIL', ordinal: 1, address: '/home/chris/b' },
        { kind: 'FIL', ordinal: 2, address: '/home/chris/a' },
      ],
    });
    const listing: Listing<Entry> = numbered_build(mount);
    listing.rows_set([{ key: '/home/chris', rows: [
      { name: 'a', kind: 'file', size: 1 },
      { name: 'b', kind: 'file', size: 2 },
      { name: 'c', kind: 'file', size: 3 },
    ] }], { field: '/home/chris' });

    const pills: HTMLElement[] = [...mount.querySelectorAll<HTMLElement>('.listing-index')];
    expect(pills).toHaveLength(3);
    // The number is the one `@N` reaches — found by ADDRESS, so it follows
    // the row rather than counting down the screen.
    // Lit rows wear the HANDLE that reaches them — kind and place, padded
    // to three; a row the session does not reach still counts itself, dim.
    expect(pills.map((pill: HTMLElement): string => pill.textContent ?? '')).toEqual(['FIL002', 'FIL001', '3']);
    expect(pills.map((pill: HTMLElement): boolean => pill.classList.contains('numbered')))
      .toEqual([true, true, false]);
  });

  it('repaints every pill when the numbering moves to another listing', () => {
    const mount: HTMLElement = document.createElement('div');
    document.body.appendChild(mount);
    listingNumbering_set({ source: 'ls', handles: [{ kind: 'FIL', ordinal: 1, address: '/home/chris/a' }] });
    const listing: Listing<Entry> = numbered_build(mount);
    listing.rows_set([{ key: '/home/chris', rows: [{ name: 'a', kind: 'file', size: 1 }] }], { field: '/home/chris' });
    expect(mount.querySelector('.listing-index')?.textContent).toBe('FIL001');

    listingNumbering_set({ source: 'pacs query …', handles: [{ kind: 'SER', ordinal: 1, address: '/net/pacs/queries/q/Series_1' }] });
    // The numbers moved to another listing: this row counts itself again.
    expect(mount.querySelector('.listing-index')?.textContent).toBe('1');
    expect(mount.querySelector('.listing-index')?.classList.contains('numbered')).toBe(false);
  });

  it('counts a level that declares no address, without claiming the session reaches it', () => {
    const mount: HTMLElement = document.createElement('div');
    document.body.appendChild(mount);
    const listing: Listing<Entry> = new Listing<Entry>({
      mount,
      traits: ENTRY_TRAITS,
      key: (entry: Entry): string => entry.name,
    });
    listing.rows_set([{ key: '/home/chris', rows: [{ name: 'a', kind: 'file', size: 1 }] }], { field: '/home/chris' });
    const pill: HTMLElement | null = mount.querySelector('.listing-index');
    expect(pill?.textContent).toBe('1');
    expect(pill?.classList.contains('numbered')).toBe(false);
  });
});

describe('a-press-is-acknowledged', () => {
  it('lights the pressed row, says OPENING <name> on the bar, and stands down when the listing lands', () => {
    const activate = jest.fn();
    const { listing, mount, root } = listing_build({ activate, key: (entry: Entry): string => `/x/${entry.name}` });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    const state: HTMLElement = root.querySelector('.pane-state') as HTMLElement;
    const row: HTMLElement = rows_onStage(mount)[0] as HTMLElement;
    row.click();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(row.classList.contains('listing-activating')).toBe(true);
    expect(listing.activating_get()).toBe(`/x/${ENTRIES[1]?.name}`);
    expect(state.textContent).toBe(`OPENING ${ENTRIES[1]?.name}`);
    expect(state.classList.contains('state-wait')).toBe(true);
    // the same row again, while in flight: absorbed
    row.click();
    expect(activate).toHaveBeenCalledTimes(1);
    // the answer lands
    listing.rows_set([{ key: '/x/a', rows: [] }], { field: '/x/a' });
    expect(listing.activating_get()).toBeNull();
    expect(mount.querySelector('.listing-activating')).toBeNull();
    expect(state.classList.contains('state-wait')).toBe(false);
    expect(state.textContent).not.toMatch(/OPENING/);
  });

  it('a press on another row replaces the intent; a refusal stands the press down with the words on the bar', () => {
    const activate = jest.fn();
    const { listing, mount, root } = listing_build({ activate, key: (entry: Entry): string => `/x/${entry.name}` });
    listing.rows_set([{ key: '/x', rows: ENTRIES }], { field: '/x' });
    const state: HTMLElement = root.querySelector('.pane-state') as HTMLElement;
    const [first, second] = rows_onStage(mount) as [HTMLElement, HTMLElement];
    first.click();
    second.click();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(first.classList.contains('listing-activating')).toBe(false);
    expect(second.classList.contains('listing-activating')).toBe(true);
    listing.activation_refuse('cd: b: Not a directory');
    expect(listing.activating_get()).toBeNull();
    expect(second.classList.contains('listing-activating')).toBe(false);
    expect(state.textContent).toBe('CD: B: NOT A DIRECTORY');
    expect(state.classList.contains('state-refused')).toBe(true);
    expect(state.classList.contains('state-wait')).toBe(false);
    // nothing in flight: a refusal arriving late changes nothing
    listing.activation_refuse('cd: late');
    expect(state.textContent).toBe('CD: B: NOT A DIRECTORY');
  });
});

describe('listingRow_build with a cell that comes back with no fact', () => {
  it('draws undefined, null and a number as text, never throws', async () => {
    const { listingRow_build } = await import('../../src/features/roster/row.js');
    const traits: ReadonlyArray<ListingTrait<{ n: number }>> = [
      { key: 'gone', label: 'GONE', className: 'c-gone', width: '4em', cell: (): string => undefined as unknown as string },
      { key: 'nil', label: 'NIL', className: 'c-nil', width: '4em', cell: (): string => null as unknown as string },
      { key: 'num', label: 'NUM', className: 'c-num', width: '4em', cell: (row: { n: number }): string => row.n as unknown as string },
    ];
    const element: HTMLElement = listingRow_build({ n: 7 }, traits, { className: (): string => 'listing-row' });
    expect([...element.children].map((c) => [c.className, c.textContent])).toEqual([['c-gone', ''], ['c-nil', ''], ['c-num', '7']]);
  });
});
