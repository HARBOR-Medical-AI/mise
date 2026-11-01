/**
 * @file Where a ChRIS's name is kept, when it is not in the tenancy
 * (docs/stratus.adoc, D16): the registrar's records, read and written
 * through its API, so pointing the name at the VM is part of the deploy,
 * asked first, never a page clicked by hand. GoDaddy's Domains v3 API with a
 * Personal Access Token (`domains.dns:update`, `domains.domain:read`) kept
 * on this host in `~/.config/stratus/godaddy`, mode 600, one line.
 *
 * @module
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A record at the registrar. */
export interface RegistrarRecord {
  readonly id: string;
  readonly type: string;
  /** Its name in the zone (`cube`, `@`). */
  readonly name: string;
  readonly data: string;
  readonly ttl: number;
}

/** A registrar's records, by zone. */
export interface Registrar {
  /** Its name, for the question (`GoDaddy`). */
  readonly id: string;
  /** Whether a zone's name servers are this registrar's. */
  serves(nameservers: ReadonlyArray<string>): boolean;
  records_list(zone: string, name: string): Promise<RegistrarRecord[]>;
  record_delete(zone: string, id: string): Promise<void>;
  record_create(zone: string, record: { name: string; type: string; data: string; ttl: number }): Promise<void>;
}

/** What pointing a name at an address changes. */
export interface PointPlan {
  /** The records in the way: a CNAME, or an A to another address. */
  readonly remove: ReadonlyArray<RegistrarRecord>;
  /** Whether an A record to the address is to be made. */
  readonly create: boolean;
}

/** The TTL a pointed name gets: ten minutes, so a rebuild elsewhere moves quickly. */
export const POINT_TTL: number = 600;

/**
 * A host's zone and its name in it: the last two labels are the zone.
 *
 * @param host - `cube.chrisproject.org`.
 * @returns `{ zone: 'chrisproject.org', name: 'cube' }`; the zone's own name is `@`.
 */
export function host_split(host: string): { zone: string; name: string } {
  const labels: string[] = host.split('.');
  const zone: string = labels.slice(-2).join('.');
  const name: string = labels.slice(0, -2).join('.');
  return { zone, name: name === '' ? '@' : name };
}

/**
 * What it takes to point a name at an address.
 *
 * @param records - The name's records now.
 * @param address - The address.
 * @returns What goes and whether an A record is made.
 */
export function point_plan(records: ReadonlyArray<RegistrarRecord>, address: string): PointPlan {
  const remove: RegistrarRecord[] = records.filter((record: RegistrarRecord): boolean => record.type === 'CNAME' || (record.type === 'A' && record.data !== address) || record.type === 'AAAA');
  const create: boolean = !records.some((record: RegistrarRecord): boolean => record.type === 'A' && record.data === address);
  return { remove, create };
}

/**
 * A plan in words, for the question.
 *
 * @param plan - The plan.
 * @param name - The name in the zone.
 * @param address - The address.
 * @returns `remove CNAME cube → router-default…, add A cube → 129.80.133.219 (TTL 600)`.
 */
export function pointPlan_words(plan: PointPlan, name: string, address: string): string {
  const words: string[] = plan.remove.map((record: RegistrarRecord): string => `remove ${record.type} ${record.name} → ${record.data}`);
  if (plan.create) words.push(`add A ${name} → ${address} (TTL ${POINT_TTL})`);
  return words.join(', ');
}

/**
 * Where the GoDaddy token is kept.
 *
 * @param env - The environment.
 * @returns `$XDG_CONFIG_HOME/stratus/godaddy`, or under `~/.config`.
 */
export function goDaddyToken_path(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'stratus', 'godaddy');
}

/**
 * GoDaddy, when its token is kept on this host.
 *
 * @param tokenFile - The token's file.
 * @param fetcher - The fetch to ask with.
 * @returns The registrar, or null when there is no token.
 */
export function goDaddy_make(tokenFile: string = goDaddyToken_path(), fetcher: typeof fetch = fetch): Registrar | null {
  if (!fs.existsSync(tokenFile)) return null;
  const base: string = 'https://api.godaddy.com/v3/domains/zones';
  const ask = async (method: string, url: string, body?: unknown): Promise<Response> => {
    const token: string = fs.readFileSync(tokenFile, 'utf-8').trim();
    const response: Response = await fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GoDaddy ${method} ${url.slice(base.length)}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  return {
    id: 'GoDaddy',
    serves: (nameservers: ReadonlyArray<string>): boolean => nameservers.length > 0 && nameservers.every((server: string): boolean => /\.domaincontrol\.com\.?$/i.test(server)),
    async records_list(zone: string, name: string): Promise<RegistrarRecord[]> {
      const answer = await (await ask('GET', `${base}/${encodeURIComponent(zone)}/dns-records?name=${encodeURIComponent(name)}&pageSize=100`)).json() as { items?: Array<{ recordId: string; type: string; name: string; data: string; ttl: number }> };
      return (answer.items ?? []).filter((item): boolean => item.name === name).map((item): RegistrarRecord => ({ id: item.recordId, type: item.type, name: item.name, data: item.data, ttl: item.ttl }));
    },
    async record_delete(zone: string, id: string): Promise<void> {
      await ask('DELETE', `${base}/${encodeURIComponent(zone)}/dns-records/${encodeURIComponent(id)}`);
    },
    async record_create(zone: string, record: { name: string; type: string; data: string; ttl: number }): Promise<void> {
      await ask('POST', `${base}/${encodeURIComponent(zone)}/dns-records`, record);
    },
  };
}
