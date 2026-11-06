/**
 * @file Checking plugin descriptors before any CUBE sees them.
 *
 * Five rules, cheapest first, each failure naming the file and the rule:
 *
 * 1. the index's own JSON Schema (`schema/plugin.schema.json`), so the
 *    schema has one home and this check follows it without a release;
 * 2. CUBE's administrative upload rules (ChRIS_ultron_backEnd
 *    `plugins/admin.py`, `plugins/models.py`): a JSON object, required descriptors, text descriptors neither blank nor past their length, a dotted-number version,
 *    the upload's parameter types (`str|int|float|bool|path|unextpath`,
 *    not the read API's `string|integer|boolean`), an optional parameter
 *    carries a default and is never a path, a required one is exposed;
 * 3. the file is named for the plugin (`<name>.json`);
 * 4. no two names differ only in case;
 * 5. every `dock_image` resolves anonymously on its registry, digests too.
 *
 * Rules 1–4 read nothing but the descriptors. Rule 5 asks registries, four
 * at a time; a registry that cannot be reached is a failure, never a pass.
 * A rule that was not run says so (`not checked, no schema`; `not checked,
 * --offline`), so a clean report never hides an unchecked rule.
 *
 * Key components:
 * - ValidateFinding: one failure, its file, rule and reason.
 * - ValidateRuleState: whether a rule ran, and how many files it failed.
 * - ValidateReport: the findings and the rules' states for an index.
 * - DescriptorChecked: one descriptor, parsed, with its local findings.
 * - descriptors_checkLocal: rules 1–4 over an index's descriptors.
 * - pluginIndex_validate: all five rules over an index.
 * - imageReference_parse / image_resolve: rule 5's registry lookup.
 *
 * Typical usage:
 * ```ts
 * const report: ValidateReport = await pluginIndex_validate(index, { offline: false });
 * if (!report.ok) report.findings.forEach((f: ValidateFinding): void => console.log(f.file, f.message));
 * ```
 *
 * Dependencies: `ajv` (draft 2020-12 build) for rule 1; `fetch` for rule 5.
 *
 * @module
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

import type { IndexDescriptor, PluginIndex } from './plugin_index.js';
import { items_mapPooled, POOL_WIDTH } from './pool.js';

/** The rules, by number, as the report names them. */
export const VALIDATE_RULES: Readonly<Record<ValidateRuleNumber, string>> = {
  1: 'schema',
  2: "CUBE's upload rules",
  3: 'file name equals name',
  4: 'no names differ only in case',
  5: 'images resolve',
};

/** Descriptors CUBE's upload refuses a file without. */
const REQUIRED_DESCRIPTORS: readonly string[] = ['name', 'version', 'dock_image', 'execshell', 'selfpath', 'selfexec', 'parameters'];

/**
 * The text descriptors CUBE's models keep without `blank=True`, with their
 * `max_length` (`plugins/models.py`): the upload refuses a blank one ("This
 * field may not be blank.", as an empty `selfpath` met on 6.11.0) and a longer
 * one, after its own required-descriptor check has passed.
 */
const TEXT_DESCRIPTOR_LIMITS: Readonly<Record<string, number>> = {
  name: 100,
  version: 10,
  dock_image: 500,
  execshell: 50,
  selfpath: 512,
  selfexec: 50,
};

/** Parameter types CUBE's upload takes (its front-end spellings). */
const UPLOAD_PARAMETER_TYPES: readonly string[] = ['str', 'int', 'float', 'bool', 'path', 'unextpath'];

/** Parameter types that may never be optional. */
const PATH_TYPES: readonly string[] = ['path', 'unextpath'];

/** Docker Hub's registry, as image references name it and as it is reached. */
const DOCKER_HUB: { readonly named: string; readonly host: string } = { named: 'docker.io', host: 'registry-1.docker.io' };

/** Manifest media types a registry may answer a manifest lookup with. */
const MANIFEST_ACCEPT: string = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** A rule's number. */
export type ValidateRuleNumber = 1 | 2 | 3 | 4 | 5;

/**
 * One failure.
 *
 * @example
 * ```ts
 * const finding: ValidateFinding = { file: 'pl-x.json', rule: 3, message: "named 'pl-y'" };
 * ```
 */
export interface ValidateFinding {
  /** The descriptor file. */
  readonly file: string;
  /** The rule it fails. */
  readonly rule: ValidateRuleNumber;
  /** Why, in a line. */
  readonly message: string;
}

/**
 * What one rule did.
 *
 * @example
 * ```ts
 * const state: ValidateRuleState = { rule: 5, title: 'images resolve', checked: false, note: '--offline', failed: 0 };
 * ```
 */
export interface ValidateRuleState {
  /** The rule. */
  readonly rule: ValidateRuleNumber;
  /** Its title. */
  readonly title: string;
  /** Whether it ran. */
  readonly checked: boolean;
  /** Why it did not run, when it did not. */
  readonly note?: string;
  /** How many files it failed. */
  readonly failed: number;
}

/**
 * The report on an index.
 *
 * @example
 * ```ts
 * const report: ValidateReport = await pluginIndex_validate(index, { offline: true });
 * report.ok;
 * ```
 */
export interface ValidateReport {
  /** The index's short name. */
  readonly label: string;
  /** The commit read, when known. */
  readonly commit: string | null;
  /** How many descriptor files were read. */
  readonly descriptors: number;
  /** Every failure, by file then rule. */
  readonly findings: ValidateFinding[];
  /** Each rule's state, in order. */
  readonly rules: ValidateRuleState[];
  /** True when no rule that ran failed a file. */
  readonly ok: boolean;
}

/**
 * One descriptor, parsed, with what rules 1–4 found in it.
 *
 * @example
 * ```ts
 * const [checked] = descriptors_checkLocal(index).descriptors;
 * checked.findings.length === 0;
 * ```
 */
export interface DescriptorChecked {
  /** The file. */
  readonly file: string;
  /** The file's text. */
  readonly text: string;
  /** The parsed descriptor, or null when the file is not a JSON object. */
  readonly data: Record<string, unknown> | null;
  /** Rules 1–4's failures for this file. */
  readonly findings: ValidateFinding[];
}

/**
 * Rules 1–4 over an index.
 *
 * @example
 * ```ts
 * const local: LocalCheck = descriptors_checkLocal(index);
 * local.schemaChecked;
 * ```
 */
export interface LocalCheck {
  /** Each descriptor with its findings, in file order. */
  readonly descriptors: DescriptorChecked[];
  /** Whether rule 1 ran (the index carried a schema). */
  readonly schemaChecked: boolean;
}

/**
 * What rule 5 needs to know.
 *
 * @example
 * ```ts
 * const options: ValidateOptions = { offline: false };
 * ```
 */
export interface ValidateOptions {
  /** Skip rule 5, saying so. */
  readonly offline: boolean;
  /** The fetch rule 5 uses; the global one by default. */
  readonly fetcher?: typeof fetch;
}

/**
 * A parsed image reference.
 *
 * @example
 * ```ts
 * imageReference_parse('fnndsc/pl-dircopy:2.1.1');
 * // { registry: 'registry-1.docker.io', repository: 'fnndsc/pl-dircopy', reference: '2.1.1' }
 * ```
 */
export interface ImageReference {
  /** The registry host to ask. */
  readonly registry: string;
  /** The repository path on it. */
  readonly repository: string;
  /** The digest when the reference pins one, else the tag. */
  readonly reference: string;
}

/**
 * Runs rules 1–4 over an index's descriptors.
 *
 * @param index - The index.
 * @returns Each descriptor parsed, with its findings, and whether rule 1 ran.
 * @throws {Error} When the index's schema does not compile.
 *
 * @example
 * ```ts
 * const local: LocalCheck = descriptors_checkLocal(index);
 * local.descriptors.filter((d: DescriptorChecked): boolean => d.findings.length > 0);
 * ```
 */
export function descriptors_checkLocal(index: PluginIndex): LocalCheck {
  const schemaValidate: ValidateFunction | null = index.schema === null ? null : schema_compile(index.schema);
  const checked: DescriptorChecked[] = index.descriptors.map((descriptor: IndexDescriptor): DescriptorChecked =>
    descriptor_checkAlone(descriptor, schemaValidate));
  const byLower: Map<string, string[]> = new Map();
  for (const entry of checked) {
    const name: unknown = entry.data?.['name'];
    if (typeof name !== 'string') continue;
    byLower.set(name.toLowerCase(), [...(byLower.get(name.toLowerCase()) ?? []), name]);
  }
  const descriptors: DescriptorChecked[] = checked.map((entry: DescriptorChecked): DescriptorChecked => {
    const name: unknown = entry.data?.['name'];
    if (typeof name !== 'string') return entry;
    const others: string[] = (byLower.get(name.toLowerCase()) ?? []).filter((other: string): boolean => other !== name);
    if (others.length === 0) return entry;
    return { ...entry, findings: [...entry.findings, { file: entry.file, rule: 4, message: `'${name}' differs only in case from ${others.map((o: string): string => `'${o}'`).join(', ')}` }] };
  });
  return { descriptors, schemaChecked: schemaValidate !== null };
}

/**
 * Runs all five rules over an index.
 *
 * @param index - The index.
 * @param options - Whether to skip rule 5, and the fetch it uses.
 * @returns The report.
 * @throws {Error} When the index's schema does not compile.
 *
 * @example
 * ```ts
 * const report: ValidateReport = await pluginIndex_validate(index, { offline: false });
 * ```
 */
export async function pluginIndex_validate(index: PluginIndex, options: ValidateOptions): Promise<ValidateReport> {
  const local: LocalCheck = descriptors_checkLocal(index);
  const findings: ValidateFinding[] = local.descriptors.flatMap((entry: DescriptorChecked): ValidateFinding[] => entry.findings);
  if (!options.offline) {
    const fetcher: typeof fetch = options.fetcher ?? fetch;
    const images: Array<{ file: string; image: string }> = local.descriptors.flatMap((entry: DescriptorChecked): Array<{ file: string; image: string }> => {
      const image: unknown = entry.data?.['dock_image'];
      return typeof image === 'string' && image !== '' ? [{ file: entry.file, image }] : [];
    });
    const failures: Array<string | null> = await items_mapPooled(images, POOL_WIDTH,
      (item: { file: string; image: string }): Promise<string | null> => image_resolve(item.image, fetcher));
    images.forEach((item: { file: string; image: string }, at: number): void => {
      const failure: string | null | undefined = failures[at];
      if (failure) findings.push({ file: item.file, rule: 5, message: `${item.image}: ${failure}` });
    });
  }
  findings.sort((a: ValidateFinding, b: ValidateFinding): number => a.file.localeCompare(b.file) || a.rule - b.rule);
  const rules: ValidateRuleState[] = ([1, 2, 3, 4, 5] as const).map((rule: ValidateRuleNumber): ValidateRuleState => {
    const failed: number = new Set(findings.filter((f: ValidateFinding): boolean => f.rule === rule).map((f: ValidateFinding): string => f.file)).size;
    if (rule === 1 && !local.schemaChecked) return { rule, title: VALIDATE_RULES[rule], checked: false, note: 'no schema', failed };
    if (rule === 5 && options.offline) return { rule, title: VALIDATE_RULES[rule], checked: false, note: '--offline', failed };
    return { rule, title: VALIDATE_RULES[rule], checked: true, failed };
  });
  return {
    label: index.label,
    commit: index.commit,
    descriptors: index.descriptors.length,
    findings,
    rules,
    ok: findings.length === 0,
  };
}

/**
 * Parses an image reference into what a registry lookup needs.
 *
 * @param image - The reference (`[registry/]repo[:tag][@sha256:…]`).
 * @returns The registry host, repository and reference; null when unreadable.
 *
 * @example
 * ```ts
 * imageReference_parse('ghcr.io/fnndsc/pl-x:1.0@sha256:ab…'); // reference is the digest
 * ```
 */
export function imageReference_parse(image: string): ImageReference | null {
  const at: number = image.indexOf('@');
  const digest: string | null = at === -1 ? null : image.slice(at + 1);
  const named: string = at === -1 ? image : image.slice(0, at);
  const slash: number = named.indexOf('/');
  const first: string = slash === -1 ? '' : named.slice(0, slash);
  const hasRegistry: boolean = first.includes('.') || first.includes(':') || first === 'localhost';
  const registryNamed: string = hasRegistry ? first : DOCKER_HUB.named;
  let rest: string = hasRegistry ? named.slice(slash + 1) : named;
  const colon: number = rest.lastIndexOf(':');
  const tag: string = colon === -1 ? 'latest' : rest.slice(colon + 1);
  if (colon !== -1) rest = rest.slice(0, colon);
  if (rest === '' || /\s/.test(image)) return null;
  const registry: string = registryNamed === DOCKER_HUB.named ? DOCKER_HUB.host : registryNamed;
  const repository: string = registry === DOCKER_HUB.host && !rest.includes('/') ? `library/${rest}` : rest;
  return { registry, repository, reference: digest ?? tag };
}

/**
 * Asks an image's registry, anonymously, whether its manifest is there.
 *
 * Follows the registry's anonymous bearer-token challenge when it sends one.
 *
 * @param image - The image reference.
 * @param fetcher - The fetch to use.
 * @returns Null when the manifest resolves; else why not, in a few words.
 *
 * @example
 * ```ts
 * await image_resolve('docker.io/library/alpine:3.20', fetch); // null
 * ```
 */
export async function image_resolve(image: string, fetcher: typeof fetch): Promise<string | null> {
  const reference: ImageReference | null = imageReference_parse(image);
  if (reference === null) return 'not an image reference';
  const url: string = `https://${reference.registry}/v2/${reference.repository}/manifests/${reference.reference}`;
  try {
    let response: Response = await fetcher(url, { method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT } });
    if (response.status === 401) {
      const token: string | null = await registryToken_get(response.headers.get('www-authenticate'), fetcher);
      if (token === null) return `${reference.registry} refuses anonymous reads`;
      response = await fetcher(url, { method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` } });
    }
    if (response.ok) return null;
    if (response.status === 404) return `not found on ${reference.registry}`;
    if (response.status === 401 || response.status === 403) return `${reference.registry} refuses anonymous reads (HTTP ${response.status})`;
    return `${reference.registry} answered HTTP ${response.status}`;
  } catch (error: unknown) {
    return `${reference.registry} could not be reached (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Gets an anonymous token from a registry's bearer challenge.
 *
 * @param challenge - The `WWW-Authenticate` header, when sent.
 * @param fetcher - The fetch to use.
 * @returns The token, or null when there is no bearer challenge or no token.
 */
async function registryToken_get(challenge: string | null, fetcher: typeof fetch): Promise<string | null> {
  if (challenge === null || !/^bearer\s/i.test(challenge)) return null;
  const fields: Record<string, string> = {};
  for (const match of challenge.matchAll(/(\w+)="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2];
  }
  const realm: string | undefined = fields['realm'];
  if (realm === undefined) return null;
  const query: URLSearchParams = new URLSearchParams();
  if (fields['service'] !== undefined) query.set('service', fields['service']);
  if (fields['scope'] !== undefined) query.set('scope', fields['scope']);
  const response: Response = await fetcher(`${realm}?${query.toString()}`);
  if (!response.ok) return null;
  const body: { token?: unknown; access_token?: unknown } = (await response.json()) as { token?: unknown; access_token?: unknown };
  const token: unknown = body.token ?? body.access_token;
  return typeof token === 'string' ? token : null;
}

/**
 * Compiles the index's schema.
 *
 * @param schema - The parsed schema.
 * @returns The validator.
 * @throws {Error} When the schema does not compile.
 */
function schema_compile(schema: unknown): ValidateFunction {
  // Strict mode refuses keywords it does not know; the schema belongs to the
  // index and may grow annotations this check has no business refusing.
  const ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: false });
  try {
    return ajv.compile(schema as object);
  } catch (error: unknown) {
    throw new Error(`the index's schema does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Runs rules 1–3 over one descriptor.
 *
 * @param descriptor - The file.
 * @param schemaValidate - Rule 1's validator, or null when there is no schema.
 * @returns The descriptor parsed, with its findings.
 */
function descriptor_checkAlone(descriptor: IndexDescriptor, schemaValidate: ValidateFunction | null): DescriptorChecked {
  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptor.text) as unknown;
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    return { file: descriptor.file, text: descriptor.text, data: null, findings: [{ file: descriptor.file, rule: 2, message: `not JSON: ${reason}` }] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file: descriptor.file, text: descriptor.text, data: null, findings: [{ file: descriptor.file, rule: 2, message: 'not a JSON object' }] };
  }
  const data: Record<string, unknown> = parsed as Record<string, unknown>;
  const findings: ValidateFinding[] = [];
  if (schemaValidate !== null && !schemaValidate(data)) {
    for (const problem of schemaValidate.errors ?? []) {
      findings.push({ file: descriptor.file, rule: 1, message: schemaError_render(problem) });
    }
  }
  for (const message of uploadRules_check(data)) findings.push({ file: descriptor.file, rule: 2, message });
  const name: unknown = data['name'];
  if (typeof name === 'string' && descriptor.file !== `${name}.json`) {
    findings.push({ file: descriptor.file, rule: 3, message: `names the plugin '${name}': the file should be ${name}.json` });
  }
  return { file: descriptor.file, text: descriptor.text, data, findings };
}

/**
 * Renders one schema error as a line.
 *
 * @param problem - The ajv error.
 * @returns `<where> <what>` (`/parameters/0 must have required property 'type'`).
 */
function schemaError_render(problem: ErrorObject): string {
  const where: string = problem.instancePath === '' ? 'the descriptor' : problem.instancePath;
  const extra: string = problem.keyword === 'additionalProperties'
    ? ` ('${String((problem.params as { additionalProperty?: unknown }).additionalProperty)}')`
    : '';
  return `${where} ${problem.message ?? 'is invalid'}${extra}`;
}

/**
 * Checks CUBE's administrative upload rules (rule 2).
 *
 * @param data - The parsed descriptor.
 * @returns One line per rule broken; empty when CUBE's upload would take it.
 */
function uploadRules_check(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const required of REQUIRED_DESCRIPTORS) {
    if (!(required in data)) problems.push(`descriptor ${required} is required`);
  }
  for (const [field, limit] of Object.entries(TEXT_DESCRIPTOR_LIMITS)) {
    const value: unknown = data[field];
    if (typeof value !== 'string') continue;
    if (value.trim() === '') problems.push(`${field} may not be blank`);
    else if (value.length > limit) problems.push(`${field} is longer than ${limit} characters`);
  }
  const version: unknown = data['version'];
  if ('version' in data && (typeof version !== 'string' || !/^[0-9.]+$/.test(version))) {
    problems.push(`version ${JSON.stringify(version)} is not a dotted number`);
  }
  for (const field of ['min_number_of_workers', 'max_number_of_workers']) {
    if (field in data && data[field] !== '' && !integer_isAtLeast(data[field], 1)) problems.push(`${field} must be a positive integer`);
  }
  for (const field of ['min_gpu_limit', 'max_gpu_limit']) {
    if (field in data && data[field] !== '' && !integer_isAtLeast(data[field], 0)) problems.push(`${field} must be a non-negative integer`);
  }
  const parameters: unknown = data['parameters'];
  if ('parameters' in data && !Array.isArray(parameters)) problems.push('parameters must be a list');
  if (Array.isArray(parameters)) {
    parameters.forEach((parameter: unknown, at: number): void => {
      problems.push(...parameterRules_check(parameter, at));
    });
  }
  return problems;
}

/**
 * Checks one parameter against CUBE's upload rules.
 *
 * @param parameter - The parameter as declared.
 * @param at - Its position, for the message.
 * @returns One line per rule broken.
 */
function parameterRules_check(parameter: unknown, at: number): string[] {
  if (parameter === null || typeof parameter !== 'object') return [`parameter ${at} is not an object`];
  const declared: Record<string, unknown> = parameter as Record<string, unknown>;
  const label: string = typeof declared['name'] === 'string' ? `parameter '${declared['name']}'` : `parameter ${at}`;
  const type: unknown = declared['type'];
  if (type === undefined) return [`${label}: type is required`];
  if (typeof type !== 'string' || !UPLOAD_PARAMETER_TYPES.includes(type)) {
    return [`${label}: type ${JSON.stringify(type)} is not one the upload takes (${UPLOAD_PARAMETER_TYPES.join('|')})`];
  }
  if (declared['optional'] === true) {
    if (PATH_TYPES.includes(type)) return [`${label}: a ${type} parameter cannot be optional`];
    if (declared['default'] === undefined || declared['default'] === null) return [`${label}: an optional parameter needs a default`];
    return [];
  }
  if (declared['ui_exposed'] === false) return [`${label}: a required parameter must be exposed to the UI`];
  return [];
}

/**
 * Reports whether a value is an integer no smaller than a floor.
 *
 * @param value - The value.
 * @param floor - The least integer allowed.
 * @returns True for an integer (or an integer string) at or above the floor.
 */
function integer_isAtLeast(value: unknown, floor: number): boolean {
  const number: number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(number) && number >= floor;
}
