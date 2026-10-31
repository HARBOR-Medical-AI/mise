/**
 * @file The tenancy as a tree: `/net/<cloud>/<tenancy>/…` (docs/stratus.adoc, D4).
 *
 * A fond provider over the cloud driver. Under the mount: the tenancy by its
 * display name; inside it, its containers (compartments) nesting as the cloud
 * nests them, `regions/` with each region's zones, limits, shapes and prices,
 * and `clusters/`. Every container level, the tenancy's included, also holds
 * the resource kind folders for the session's region (`resources.ts`). A container lists its children and `info.json`; a fact
 * (a limit, a shape, a price) is a folder of field files, as `/proc` does it:
 * a field is a file when a shell line wants it, and `info.json` holds the
 * whole record.
 *
 * Names in paths are display names; a duplicate wears `~<id6>` and the plain
 * name refuses as ambiguous (`names.ts`). Kind folders and `info.json` are
 * reserved, so a container with such a name wears the suffix too. Every
 * answer is kept for a short life (`cache.ts`). The mount is read-only: the
 * substrate changes through `cluster` (D6).
 *
 * @module
 */
import { Err, Ok, errorStack, vfs_fail, vfs_ok, type CpOptions, type Result, type VFSItem, type VFSProvider, type VfsOutcome } from '@fnndsc/fond';
import type { CloudAvailability, CloudContainer, CloudDriver, CloudIdentity, CloudLimit, CloudPrice, CloudShape, CloudZone } from '../cloud/driver.js';
import { AnswerCache } from '../cache.js';
import { ambiguity_words, idSuffix_extract, segment_resolve, segments_assign, type Segment, type SegmentMatch } from '../names.js';
import { KIND_FOLDERS, kindFolder_is, ResourceTree, type ResourceNode } from './resources.js';
import { ClusterTree } from './clusters.js';

/** The folders a tenancy level reserves beside its containers. */
export const TENANCY_RESERVED: ReadonlyArray<string> = ['regions', 'clusters', 'info.json', ...KIND_FOLDERS];
/** The folders a container level reserves beside its children. */
export const CONTAINER_RESERVED: ReadonlyArray<string> = ['info.json', ...KIND_FOLDERS];
/** What a region holds. */
const REGION_FOLDERS: ReadonlyArray<string> = ['zones', 'limits', 'shapes', 'prices'];

/** The words a refusal of a write uses. */
export const READ_ONLY_REASON: string = 'the substrate is read-only here: a cluster changes through cluster';

/** A file in a folder of fields. */
interface Field {
  readonly name: string;
  readonly text: string;
}

/** A folder the tree resolved a path to, and what it holds. */
type Node =
  | { readonly kind: 'mount' }
  | { readonly kind: 'tenancy'; readonly identity: CloudIdentity; readonly root: CloudContainer }
  | { readonly kind: 'container'; readonly identity: CloudIdentity; readonly container: CloudContainer }
  | { readonly kind: 'regions' }
  | { readonly kind: 'region'; readonly region: string }
  | { readonly kind: 'zones'; readonly region: string }
  | { readonly kind: 'zone'; readonly region: string; readonly zone: CloudZone }
  | { readonly kind: 'services'; readonly region: string }
  | { readonly kind: 'service'; readonly region: string; readonly service: string }
  | { readonly kind: 'limit'; readonly region: string; readonly service: string; readonly name: string; readonly limits: CloudLimit[] }
  | { readonly kind: 'limitZone'; readonly region: string; readonly limit: CloudLimit }
  | { readonly kind: 'shapes'; readonly region: string }
  | { readonly kind: 'shape'; readonly region: string; readonly shape: CloudShape }
  | { readonly kind: 'prices'; readonly region: string }
  | { readonly kind: 'price'; readonly region: string; readonly price: CloudPrice }
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'listing'; readonly list: () => Promise<VFSItem[]> }
  | { readonly kind: 'bytes'; readonly size: number; readonly read: () => Promise<Buffer> }
  | { readonly kind: 'refused'; readonly reason: string; readonly errno?: 'EPERM' | 'EACCES' }
  | { readonly kind: 'missing'; readonly reason?: string };

/** How the provider is made. */
export interface TenancyProviderOptions {
  readonly driver: CloudDriver;
  /** The cache; a fresh one with a minute's life when absent. */
  readonly cache?: AnswerCache;
  /** The clock for item dates the cloud does not give. */
  readonly now?: () => string;
  /** The session's region, whose resources the kind folders list; the credential's home region when absent or null. */
  readonly region?: () => string | null;
  /** The clusters the daemon was given; `clusters/` lists empty without them. */
  readonly clusters?: ClusterTree;
}

/** The tenancy as a tree under `/net/<cloud>`. */
export class TenancyProvider implements VFSProvider {
  readonly prefix: string;
  private readonly driver: CloudDriver;
  private readonly cache: AnswerCache;
  private readonly now: () => string;
  private readonly region: () => string | null;
  private readonly resources: ResourceTree;
  private readonly clusters: ClusterTree | null;

  constructor(options: TenancyProviderOptions) {
    this.driver = options.driver;
    this.prefix = `/net/${options.driver.cloud}`;
    this.cache = options.cache ?? new AnswerCache();
    this.now = options.now ?? ((): string => new Date().toISOString());
    this.region = options.region ?? ((): null => null);
    this.resources = new ResourceTree({ driver: this.driver, cache: this.cache, now: this.now });
    this.clusters = options.clusters ?? null;
  }

  /** The region the kind folders list. */
  private region_resolve(identity: CloudIdentity): string {
    return this.region() ?? identity.homeRegion;
  }

  /** A path below a container's kind folder, resolved by the resource tree. */
  private async resourceNode_resolve(identity: CloudIdentity, container: CloudContainer, segments: string[]): Promise<Node> {
    const node: ResourceNode = await this.resources.node_resolve(container.id, this.region_resolve(identity), segments, identity.user);
    return node;
  }

  /** Forgets every kept answer: the next listing asks the cloud. */
  cache_clear(): void {
    this.cache.clear();
  }

  // ---- the cloud, cached ----

  private identity_get(): Promise<CloudIdentity> {
    return this.cache.answer_get('identity', (): Promise<CloudIdentity> => this.driver.identity_get());
  }

  private root_get(): Promise<CloudContainer> {
    return this.cache.answer_get('root', (): Promise<CloudContainer> => this.driver.root_get());
  }

  private containers_list(parentId: string): Promise<CloudContainer[]> {
    return this.cache.answer_get(`containers/${parentId}`, (): Promise<CloudContainer[]> => this.driver.containers_list(parentId));
  }

  private regions_list(): Promise<string[]> {
    return this.cache.answer_get('regions', (): Promise<string[]> => this.driver.regions_list());
  }

  private zones_list(region: string): Promise<CloudZone[]> {
    return this.cache.answer_get(`zones/${region}`, (): Promise<CloudZone[]> => this.driver.zones_list(region));
  }

  private services_list(region: string): Promise<string[]> {
    return this.cache.answer_get(`services/${region}`, (): Promise<string[]> => this.driver.limitServices_list(region));
  }

  private limits_list(region: string, service: string): Promise<CloudLimit[]> {
    return this.cache.answer_get(`limits/${region}/${service}`, (): Promise<CloudLimit[]> => this.driver.limits_list(region, service));
  }

  private availability_get(region: string, limit: CloudLimit): Promise<CloudAvailability | null> {
    const key: string = `availability/${region}/${limit.service}/${limit.name}${limit.zone !== undefined ? `/${limit.zone}` : ''}`;
    return this.cache.answer_get(key, (): Promise<CloudAvailability | null> => this.driver.limitAvailability_get(region, limit.service, limit.name, limit.zone));
  }

  private shapes_list(region: string): Promise<CloudShape[]> {
    return this.cache.answer_get(`shapes/${region}`, (): Promise<CloudShape[]> => this.driver.shapes_list(region));
  }

  private prices_list(): Promise<CloudPrice[]> {
    return this.cache.answer_get('prices', (): Promise<CloudPrice[]> => this.driver.prices_list());
  }

  // ---- paths ----

  /** The path's segments under the mount; null when the path is not under it. */
  private segments_parse(pathStr: string): string[] | null {
    const absolute: string = pathStr.startsWith('/') ? pathStr : `/${pathStr}`;
    const clean: string = absolute.length > 1 && absolute.endsWith('/') ? absolute.slice(0, -1) : absolute;
    if (clean === this.prefix) return [];
    if (!clean.startsWith(`${this.prefix}/`)) return null;
    return clean.slice(this.prefix.length + 1).split('/');
  }

  /** Containers with their path segments: a reserved name or a duplicate wears the suffix. */
  private containerSegments_map(children: CloudContainer[], reserved: ReadonlyArray<string>): Segment<CloudContainer>[] {
    return segments_assign(children).map((entry: Segment<CloudContainer>): Segment<CloudContainer> =>
      reserved.includes(entry.segment) ? { segment: `${entry.item.name}~${idSuffix_extract(entry.item.id)}`, item: entry.item } : entry);
  }

  /** The child a segment names among containers, with the reserved rule. */
  private container_resolve(children: CloudContainer[], segment: string, reserved: ReadonlyArray<string>): SegmentMatch<CloudContainer> {
    const assigned: Segment<CloudContainer>[] = this.containerSegments_map(children, reserved);
    const exact: Segment<CloudContainer> | undefined = assigned.find((entry: Segment<CloudContainer>): boolean => entry.segment === segment);
    if (exact !== undefined) return { kind: 'one', item: exact.item };
    if (reserved.includes(segment)) return { kind: 'none' };
    return segment_resolve(children, segment);
  }

  /**
   * The node a path names.
   *
   * @param pathStr - The absolute path.
   * @returns The node, or `missing` with a reason to show.
   */
  private async node_resolve(pathStr: string): Promise<Node> {
    const segments: string[] | null = this.segments_parse(pathStr);
    if (segments === null) return { kind: 'missing' };
    if (segments.length === 0) return { kind: 'mount' };
    let identity: CloudIdentity;
    let root: CloudContainer;
    try {
      identity = await this.identity_get();
      root = await this.root_get();
    } catch (error: unknown) {
      return { kind: 'missing', reason: `not connected: ${error instanceof Error ? error.message : String(error)}` };
    }
    const [tenancy, ...rest] = segments;
    if (tenancy !== identity.tenancy) return { kind: 'missing' };
    if (rest.length === 0) return { kind: 'tenancy', identity, root };
    if (rest[0] === 'regions') return this.regionNode_resolve(rest.slice(1));
    if (rest[0] === 'clusters') {
      if (this.clusters === null) return rest.length === 1 ? { kind: 'listing', list: async (): Promise<VFSItem[]> => [] } : { kind: 'missing' };
      return this.clusters.node_resolve(rest.slice(1));
    }
    if (rest[0] === 'info.json') return rest.length === 1 ? { kind: 'file', text: json_text(root.raw) } : { kind: 'missing' };
    if (kindFolder_is(rest[0])) return this.resourceNode_resolve(identity, root, rest);
    return this.containerNode_resolve(identity, root, rest, TENANCY_RESERVED);
  }

  /** Walks container segments from a parent. */
  private async containerNode_resolve(identity: CloudIdentity, parent: CloudContainer, segments: string[], reserved: ReadonlyArray<string>): Promise<Node> {
    const [segment, ...rest] = segments;
    const children: CloudContainer[] = await this.containers_list(parent.id);
    const match: SegmentMatch<CloudContainer> = this.container_resolve(children, segment, reserved);
    if (match.kind === 'ambiguous') return { kind: 'missing', reason: ambiguity_words(segment, match.segments) };
    if (match.kind === 'none') return { kind: 'missing' };
    if (rest.length === 0) return { kind: 'container', identity, container: match.item };
    if (rest[0] === 'info.json' && rest.length === 1) return { kind: 'file', text: json_text(match.item.raw) };
    if (kindFolder_is(rest[0])) return this.resourceNode_resolve(identity, match.item, rest);
    return this.containerNode_resolve(identity, match.item, rest, CONTAINER_RESERVED);
  }

  /** Walks `regions/…`. */
  private async regionNode_resolve(segments: string[]): Promise<Node> {
    if (segments.length === 0) return { kind: 'regions' };
    const [region, folder, ...rest] = segments;
    const regions: string[] = await this.regions_list();
    if (!regions.includes(region)) return { kind: 'missing' };
    if (folder === undefined) return { kind: 'region', region };
    if (!REGION_FOLDERS.includes(folder)) return { kind: 'missing' };
    if (folder === 'zones') return this.zoneNode_resolve(region, rest);
    if (folder === 'limits') return this.limitNode_resolve(region, rest);
    if (folder === 'shapes') return this.shapeNode_resolve(region, rest);
    return this.priceNode_resolve(region, rest);
  }

  private async zoneNode_resolve(region: string, segments: string[]): Promise<Node> {
    if (segments.length === 0) return { kind: 'zones', region };
    const zones: CloudZone[] = await this.zones_list(region);
    const zone: CloudZone | undefined = zones.find((entry: CloudZone): boolean => entry.name === segments[0]);
    if (zone === undefined) return { kind: 'missing' };
    if (segments.length === 1) return { kind: 'zone', region, zone };
    return this.fieldNode_resolve(zone_fields(zone), segments.slice(1));
  }

  private async limitNode_resolve(region: string, segments: string[]): Promise<Node> {
    if (segments.length === 0) return { kind: 'services', region };
    const [service, name, ...rest] = segments;
    const services: string[] = await this.services_list(region);
    if (!services.includes(service)) return { kind: 'missing' };
    if (name === undefined) return { kind: 'service', region, service };
    const limits: CloudLimit[] = (await this.limits_list(region, service)).filter((limit: CloudLimit): boolean => limit.name === name);
    if (limits.length === 0) return { kind: 'missing' };
    if (rest.length === 0) return { kind: 'limit', region, service, name, limits };
    const zoned: CloudLimit[] = limits.filter((limit: CloudLimit): boolean => limit.scope === 'zone');
    if (zoned.length > 0) {
      const limit: CloudLimit | undefined = zoned.find((entry: CloudLimit): boolean => entry.zone === rest[0]);
      if (limit === undefined) return { kind: 'missing' };
      if (rest.length === 1) return { kind: 'limitZone', region, limit };
      return this.fieldNode_resolve(await this.limit_fields(region, limit), rest.slice(1));
    }
    return this.fieldNode_resolve(await this.limit_fields(region, limits[0]), rest);
  }

  private async shapeNode_resolve(region: string, segments: string[]): Promise<Node> {
    if (segments.length === 0) return { kind: 'shapes', region };
    const shapes: CloudShape[] = await this.shapes_list(region);
    const shape: CloudShape | undefined = shapes.find((entry: CloudShape): boolean => entry.name === segments[0]);
    if (shape === undefined) return { kind: 'missing' };
    if (segments.length === 1) return { kind: 'shape', region, shape };
    return this.fieldNode_resolve(shape_fields(shape), segments.slice(1));
  }

  private async priceNode_resolve(region: string, segments: string[]): Promise<Node> {
    if (segments.length === 0) return { kind: 'prices', region };
    const prices: CloudPrice[] = await this.prices_list();
    const price: CloudPrice | undefined = prices.find((entry: CloudPrice): boolean => entry.shape === segments[0]);
    if (price === undefined) return { kind: 'missing' };
    if (segments.length === 1) return { kind: 'price', region, price };
    return this.fieldNode_resolve(price_fields(price), segments.slice(1));
  }

  /** A field file in a folder of fields, by its remaining segments. */
  private fieldNode_resolve(fields: Field[], segments: string[]): Node {
    if (segments.length !== 1) return { kind: 'missing' };
    const field: Field | undefined = fields.find((entry: Field): boolean => entry.name === segments[0]);
    return field === undefined ? { kind: 'missing' } : { kind: 'file', text: field.text };
  }

  /** A limit's fields: its value and scope, and what is used and left when the cloud says. */
  private async limit_fields(region: string, limit: CloudLimit): Promise<Field[]> {
    const fields: Field[] = [
      { name: 'value', text: `${limit.value}\n` },
      { name: 'scope', text: `${limit.scope}\n` },
      { name: 'service', text: `${limit.service}\n` },
    ];
    if (limit.zone !== undefined) fields.push({ name: 'zone', text: `${limit.zone}\n` });
    const availability: CloudAvailability | null = await this.availability_get(region, limit);
    if (availability !== null) {
      fields.push({ name: 'used', text: `${availability.used}\n` }, { name: 'available', text: `${availability.available}\n` });
    }
    return fields;
  }

  // ---- items ----

  private folder_item(name: string, type: string = 'dir', more: Partial<VFSItem> = {}): VFSItem {
    return { name, type, size: 0, owner: 'cloud', date: this.now(), ...more };
  }

  private file_item(field: Field): VFSItem {
    return { name: field.name, type: 'file', size: Buffer.byteLength(field.text), owner: 'cloud', date: this.now() };
  }

  private container_item(entry: Segment<CloudContainer>, owner: string): VFSItem {
    const container: CloudContainer = entry.item;
    return {
      name: entry.segment,
      type: container.noun,
      size: 0,
      owner,
      date: container.created !== '' ? container.created : this.now(),
      status: container.state,
      title: container.description,
      tags: Object.entries(container.tags).map(([key, value]: [string, string]): string => `${key}=${value}`),
    };
  }

  /** What a container level lists: its children, its kind folders, the reserved folders, `info.json`. */
  private async containerLevel_list(identity: CloudIdentity, container: CloudContainer, reserved: ReadonlyArray<string>, extraFolders: ReadonlyArray<string>): Promise<VFSItem[]> {
    const children: CloudContainer[] = await this.containers_list(container.id);
    const items: VFSItem[] = this.containerSegments_map(children, reserved).map((entry: Segment<CloudContainer>): VFSItem => this.container_item(entry, identity.user));
    items.push(...(await this.resources.kindFolders_items(container.id, this.region_resolve(identity))));
    for (const folder of extraFolders) items.push(this.folder_item(folder));
    items.push(this.file_item({ name: 'info.json', text: json_text(container.raw) }));
    return items;
  }

  /** What a node lists. */
  private async node_list(node: Node): Promise<Result<VFSItem[]>> {
    switch (node.kind) {
      case 'mount': {
        try {
          const identity: CloudIdentity = await this.identity_get();
          return Ok([this.folder_item(identity.tenancy, 'tenancy', { owner: identity.user, status: 'active' })]);
        } catch {
          return Ok([]);
        }
      }
      case 'tenancy':
        return Ok(await this.containerLevel_list(node.identity, node.root, TENANCY_RESERVED, ['regions', 'clusters']));
      case 'container':
        return Ok(await this.containerLevel_list(node.identity, node.container, CONTAINER_RESERVED, []));
      case 'regions':
        return Ok((await this.regions_list()).map((region: string): VFSItem => this.folder_item(region, 'region')));
      case 'region':
        return Ok(REGION_FOLDERS.map((folder: string): VFSItem => this.folder_item(folder)));
      case 'zones':
        return Ok((await this.zones_list(node.region)).map((zone: CloudZone): VFSItem => this.folder_item(zone.name, 'zone')));
      case 'zone':
        return Ok(zone_fields(node.zone).map((field: Field): VFSItem => this.file_item(field)));
      case 'services':
        return Ok((await this.services_list(node.region)).map((service: string): VFSItem => this.folder_item(service, 'service')));
      case 'service': {
        const names: string[] = [...new Set((await this.limits_list(node.region, node.service)).map((limit: CloudLimit): string => limit.name))].sort();
        return Ok(names.map((name: string): VFSItem => this.folder_item(name, 'limit')));
      }
      case 'limit': {
        const zoned: CloudLimit[] = node.limits.filter((limit: CloudLimit): boolean => limit.scope === 'zone');
        if (zoned.length > 0) {
          return Ok(zoned.map((limit: CloudLimit): VFSItem => this.folder_item(limit.zone ?? '', 'zone')));
        }
        return Ok((await this.limit_fields(node.region, node.limits[0])).map((field: Field): VFSItem => this.file_item(field)));
      }
      case 'limitZone':
        return Ok((await this.limit_fields(node.region, node.limit)).map((field: Field): VFSItem => this.file_item(field)));
      case 'shapes':
        return Ok((await this.shapes_list(node.region)).map((shape: CloudShape): VFSItem => this.folder_item(shape.name, 'shape', { title: shape.processor })));
      case 'shape':
        return Ok(shape_fields(node.shape).map((field: Field): VFSItem => this.file_item(field)));
      case 'prices':
        return Ok((await this.prices_list()).map((price: CloudPrice): VFSItem => this.folder_item(price.shape, 'price')));
      case 'price':
        return Ok(price_fields(node.price).map((field: Field): VFSItem => this.file_item(field)));
      case 'listing':
        return Ok(await node.list());
      case 'file':
      case 'bytes':
      case 'refused':
      case 'missing':
        return Err();
    }
  }

  // ---- the provider ----

  async list(pathStr: string): Promise<Result<VFSItem[]>> {
    const node: Node = await this.node_resolve(pathStr);
    if (node.kind === 'missing') {
      errorStack.stack_push('error', `Cannot list ${pathStr}: ${node.reason ?? 'No such file or directory'}`);
      return Err();
    }
    if (node.kind === 'file' || node.kind === 'bytes' || node.kind === 'refused') {
      errorStack.stack_push('error', `Cannot list ${pathStr}: Not a directory`);
      return Err();
    }
    return this.node_list(node);
  }

  async read(pathStr: string): Promise<VfsOutcome<string>> {
    const bytes: VfsOutcome<Buffer> = await this.readBinary(pathStr);
    return bytes.ok ? vfs_ok(bytes.value.toString('utf-8')) : bytes;
  }

  async readBinary(pathStr: string): Promise<VfsOutcome<Buffer>> {
    const node: Node = await this.node_resolve(pathStr);
    if (node.kind === 'missing') return vfs_fail('ENOENT', node.reason);
    if (node.kind === 'refused') return vfs_fail(node.errno ?? 'EPERM', node.reason);
    if (node.kind === 'file') return vfs_ok(Buffer.from(node.text, 'utf-8'));
    if (node.kind === 'bytes') {
      try {
        return vfs_ok(await node.read());
      } catch (error: unknown) {
        return vfs_fail('EIO', error instanceof Error ? error.message : String(error));
      }
    }
    return vfs_fail('EISDIR');
  }

  async cp(): Promise<VfsOutcome> {
    return vfs_fail('EROFS', READ_ONLY_REASON);
  }
}

/** A record as `info.json` shows it. */
function json_text(raw: unknown): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

function zone_fields(zone: CloudZone): Field[] {
  return [{ name: 'name', text: `${zone.name}\n` }];
}

function shape_fields(shape: CloudShape): Field[] {
  const range = (bounds: { readonly min: number; readonly max: number }): string => (bounds.min === bounds.max ? `${bounds.min}` : `${bounds.min}-${bounds.max}`);
  return [
    { name: 'family', text: `${shape.family}\n` },
    { name: 'flexible', text: `${shape.flexible ? 'yes' : 'no'}\n` },
    { name: 'vcpus', text: `${range(shape.cores)}\n` },
    { name: 'memory', text: `${range(shape.memoryGib)} GiB\n` },
    { name: 'processor', text: `${shape.processor}\n` },
    { name: 'gpus', text: `${shape.gpus}\n` },
    { name: 'quotas', text: `${shape.quotaNames.join('\n')}\n` },
    { name: 'info.json', text: json_text(shape.raw) },
  ];
}

function price_fields(price: CloudPrice): Field[] {
  return [
    { name: 'vcpuHour', text: `${price.vcpuHour}\n` },
    { name: 'gibHour', text: `${price.gibHour}\n` },
    { name: 'currency', text: `${price.currency}\n` },
  ];
}

/** A `cp` the provider refuses, typed for the interface. */
export type ReadOnlyCp = (src: string, dest: string, options: CpOptions) => Promise<VfsOutcome>;
