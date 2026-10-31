/**
 * @file How a stratus listing shows: its item kinds and the colour of a name.
 *
 * Every row is a folder or a file to the shell (docs/stratus.adoc, D5); the
 * kind is how `ls -l` draws it: the container nouns, the resource kinds, the
 * facts under `regions/`. A name is coloured by its kind; a row with a
 * lifecycle state shows it in the size column, coloured as jobs are by
 * status: running green, stopped dim, provisioning amber, failed red. A kind
 * folder (`instances/`) shows how many live resources it holds.
 *
 * @module
 */
import chalk from 'chalk';
import { LISTING_CORE_KINDS, type ItemKindLook, type ListingLook, type VFSItem } from '@fnndsc/fond';

/** The container nouns every cloud maps onto (docs/stratus.adoc, D4). */
export const CONTAINER_TYPES: ReadonlyArray<string> = ['tenancy', 'compartment', 'account', 'organization', 'project', 'folder', 'subscription', 'resourcegroup', 'managementgroup'];

/** The kinds stratus lists beside the core's. */
export const STRATUS_ITEM_KINDS: ReadonlyArray<ItemKindLook> = [
  ...CONTAINER_TYPES.map((type: string): ItemKindLook => ({ type, mark: 'c', container: true, sizeColumn: state_column })),
  { type: 'region', mark: 'r', container: true },
  { type: 'zone', mark: 'z', container: true },
  { type: 'service', mark: 'd', container: true },
  { type: 'limit', mark: 'L', container: true },
  { type: 'shape', mark: 's', container: true },
  { type: 'price', mark: '$', container: true },
  { type: 'cluster', mark: 'D', container: true, sizeColumn: state_column },
  { type: 'kind', mark: 'k', container: true, sizeColumn: count_column },
  { type: 'instance', mark: 'i', container: true, sizeColumn: state_column },
  { type: 'network', mark: 'n', container: true, sizeColumn: state_column },
  { type: 'subnet', mark: 'u', container: true, sizeColumn: state_column },
  { type: 'securitygroup', mark: 'g', container: true, sizeColumn: state_column },
  { type: 'loadbalancer', mark: 'b', container: true, sizeColumn: state_column },
  { type: 'volume', mark: 'V', container: true, sizeColumn: state_column },
  { type: 'bucket', mark: 'B', container: true, sizeColumn: state_column },
  { type: 'dnszone', mark: 'Z', container: true, sizeColumn: state_column },
  { type: 'step', mark: 'S', container: true, sizeColumn: state_column },
  { type: 'secret', mark: '!' },
  { type: 'object', mark: 'o' },
  { type: 'record', mark: 'R' },
];

/** The width a state takes in the size column, the longest state padded. */
const STATE_WIDTH: number = 12;

/** The long view's size column for an item with a state: the state, coloured by it. */
function state_column(item: VFSItem): string | null {
  if (item.status === undefined || item.status === '') return null;
  return stateTone_paint(item.status, item.status.padEnd(STATE_WIDTH));
}

/** The size column of a kind folder: how many it holds, or `-` when the count could not be asked. */
function count_column(item: VFSItem): string | null {
  return item.status === UNCOUNTED ? '-'.padEnd(8) : null;
}

/** The status a kind folder wears when its count could not be asked. */
export const UNCOUNTED: string = 'uncounted';

/**
 * Paints text in the tone of a lifecycle state; text in a state with no tone is left plain.
 *
 * @param state - The state.
 * @param text - What to paint.
 * @returns The painted text.
 */
export function stateTone_paint(state: string, text: string): string {
  const tone = STATE_TONES.find((entry): boolean => entry.matches.test(state.toLowerCase()));
  return tone !== undefined ? tone.paint(text) : text;
}

/** States and the tone each is drawn in. */
const STATE_TONES: ReadonlyArray<{ readonly matches: RegExp; readonly paint: (text: string) => string }> = [
  { matches: /^(running|active|available|attached|ready|done)$/, paint: chalk.green },
  { matches: /^(stopped|inactive|terminated|deleted|detached|unknown|empty)$/, paint: chalk.dim },
  { matches: /^(provisioning|creating|starting|stopping|updating|deleting|terminating|moving|queued|pending)$/, paint: chalk.yellow },
  { matches: /^(failed|faulted|error|unknown_value|expired)$/, paint: chalk.red },
];

/** Colours a name by the item's kind and state. */
export function stratusName_colorize(name: string, type: string, status?: string): string {
  if (status !== undefined) {
    const tone = STATE_TONES.find((entry): boolean => entry.matches.test(status.toLowerCase()));
    if (tone !== undefined) return tone.paint(name);
  }
  if (CONTAINER_TYPES.includes(type) || type === 'dir' || type === 'kind') return chalk.blue(name);
  if (type === 'region' || type === 'zone') return chalk.cyan(name);
  if (type === 'cluster') return chalk.magenta(name);
  if (type === 'shape' || type === 'price' || type === 'limit' || type === 'service') return chalk.white(name);
  return name;
}

/** The look of a stratus listing. */
export const stratusListingLook: ListingLook = {
  kinds: [...LISTING_CORE_KINDS, ...STRATUS_ITEM_KINDS],
  name_colorize: (name: string, type: string): string => stratusName_colorize(name, type),
};
