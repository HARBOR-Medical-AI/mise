/**
 * @file Where a script's lines stand (docs/stratus.adoc, D17): `play
 * --status` asks each verb, for its own line, what it would do, read from
 * the kept records and never from the cloud. A step on the script screen
 * wears the answer; chell prints it. Four states: not yet (what it stands
 * on is missing), ready, done (the line replays to unchanged or nothing to
 * do), changed (what it built moved under it, so a replay plans and asks).
 *
 * @module
 */
import type { LineStatus, LineStatusProvider } from '@fnndsc/brasa/core';
import { CHRIS_PROFILES } from '../chris/profiles.js';
import { cidr_read, netSpec_diff, type NetSpec } from '../net/spec.js';
import type { NetRecord, NetStore } from '../net/state.js';
import { vmSpec_diff, vmSpec_read } from '../vm/spec.js';
import type { VmRecord, VmStore } from '../vm/state.js';
import { options_read } from './build.js';

/** What the providers read. */
export interface LineStatusDeps {
  readonly nets: NetStore;
  readonly vms: VmStore;
}

/** The words of a line after its verb and its subject: `--vcpu 2 …` as a map. */
function options_parse(words: ReadonlyArray<string>, from: number, known: ReadonlyArray<string>): { options: Map<string, string>; rest: string[] } | null {
  const read = options_read(words.slice(from), known);
  return 'error' in read ? null : { options: read.options, rest: read.rest };
}

/**
 * `net new <name> …` and `net build <name>`.
 *
 * @param deps - The stores.
 * @param words - The line's words.
 * @returns Its standing, or null for a verb with no state.
 */
async function net_read(deps: LineStatusDeps, words: ReadonlyArray<string>): Promise<LineStatus | null> {
  const [, verb, name] = words;
  if (name === undefined) return null;
  const record: NetRecord | null = deps.nets.record_read(name);
  const kept = deps.nets.spec_read(name);
  const keptSpec = kept !== null && 'spec' in kept ? kept.spec : null;
  if (verb === 'new') {
    const read = options_parse(words, 3, ['--cidr']);
    const cidrText: string | undefined = read?.options.get('--cidr');
    const cidr = cidrText === undefined ? null : cidr_read(cidrText);
    if (cidr === null || 'error' in cidr) return { state: 'ready', detail: cidr === null ? '--cidr <range> is needed' : `--cidr ${cidr.error}` };
    const spec: NetSpec = { cidr: cidr.cidr };
    if (keptSpec === null || record === null) return { state: 'ready', detail: '' };
    const changes: string[] = netSpec_diff(keptSpec, spec);
    return changes.length === 0 ? { state: 'done', detail: 'unchanged' } : { state: 'changed', detail: changes.join(', ') };
  }
  if (verb === 'build') {
    if (record === null || keptSpec === null) return { state: 'not yet', detail: `${name}: not declared (net new ${name})` };
    if (record.gone !== undefined) return { state: 'ready', detail: 'torn down; a build brings it back' };
    if (record.built === undefined) return { state: 'ready', detail: '' };
    return record.declared !== undefined && record.declared > record.built ? { state: 'changed', detail: 'declared again since it was built' } : { state: 'done', detail: `built ${record.built.slice(0, 10)}` };
  }
  return null;
}

/**
 * `vm new <name> …` and `vm build <name>`.
 *
 * @param deps - The stores.
 * @param words - The line's words.
 * @returns Its standing, or null for a verb with no state (`vm cost`).
 */
async function vm_read(deps: LineStatusDeps, words: ReadonlyArray<string>): Promise<LineStatus | null> {
  const [, verb, name] = words;
  if (name === undefined) return null;
  const record: VmRecord | null = deps.vms.record_read(name);
  const kept = deps.vms.spec_read(name);
  const keptSpec = kept !== null && 'spec' in kept ? kept.spec : null;
  if (verb === 'new') {
    const read = options_parse(words, 3, ['--net', '--open', '--vcpu', '--memory', '--disk', '--data', '--data-backup', '--os']);
    if (read === null) return { state: 'ready', detail: '' };
    const spec = vmSpec_read(read.options, keptSpec);
    if ('error' in spec) return { state: 'ready', detail: spec.error };
    if (keptSpec === null || record === null) {
      const net: NetRecord | null = deps.nets.record_read(spec.spec.net);
      return net === null ? { state: 'not yet', detail: `the network ${spec.spec.net} is not declared (net new ${spec.spec.net})` } : { state: 'ready', detail: '' };
    }
    const changes: string[] = vmSpec_diff(keptSpec, spec.spec);
    return changes.length === 0 ? { state: 'done', detail: 'unchanged' } : { state: 'changed', detail: changes.join(', ') };
  }
  if (verb === 'build') {
    if (record === null || keptSpec === null) return { state: 'not yet', detail: `${name}: not declared (vm new ${name})` };
    const net: NetRecord | null = deps.nets.record_read(keptSpec.net);
    if (net === null || net.built === undefined || net.gone !== undefined) return { state: 'not yet', detail: `the network ${keptSpec.net} is not built (net build ${keptSpec.net})` };
    if (record.gone !== undefined || record.machineGone !== undefined) return { state: 'ready', detail: record.gone !== undefined ? 'torn down; a build makes it anew' : 'its machine is torn down; a build brings it back over its data' };
    if (record.built === undefined) return { state: 'ready', detail: '' };
    return record.declared !== undefined && record.declared > record.built ? { state: 'changed', detail: 'declared again since it was built; the build plans and asks' } : { state: 'done', detail: `built ${record.built.slice(0, 10)}` };
  }
  return null;
}

/**
 * `chris deploy <vm> …` and `chris user add <name> …`.
 *
 * @param deps - The stores.
 * @param words - The line's words.
 * @returns Its standing, or null for a verb with no state (`chris status`).
 */
async function chris_read(deps: LineStatusDeps, words: ReadonlyArray<string>): Promise<LineStatus | null> {
  const [, verb, third] = words;
  if (verb === 'deploy') {
    if (third === undefined) return null;
    const record: VmRecord | null = deps.vms.record_read(third);
    if (record === null) return { state: 'not yet', detail: `${third}: not declared (vm new ${third})` };
    if (record.built === undefined || record.gone !== undefined || record.machineGone !== undefined) return { state: 'not yet', detail: `${third}: not built (vm build ${third})` };
    const read = options_parse(words, 3, ['--profile', '--compute', '--host', '--porter', '--admin-password-file']);
    if (read === null) return { state: 'ready', detail: '' };
    const profile: string | undefined = read.options.get('--profile');
    if (profile !== undefined && CHRIS_PROFILES[profile] === undefined) return { state: 'ready', detail: `--profile ${profile}: one of ${Object.keys(CHRIS_PROFILES).join(', ')}` };
    if (record.chris === undefined) return { state: 'ready', detail: '' };
    const changes: string[] = [];
    const want = (word: string, kept: string | null | undefined, fallback: string | null): void => {
      const asked: string | null = read.options.get(word) ?? fallback;
      if ((asked ?? null) !== (kept ?? null)) changes.push(`${word.slice(2)} ${kept ?? 'none'} → ${asked ?? 'none'}`);
    };
    want('--profile', record.chris.profile, null);
    want('--compute', record.chris.compute, third);
    want('--host', record.chris.host, null);
    want('--porter', record.chris.porter, null);
    if (changes.length > 0) return { state: 'changed', detail: changes.join(', ') };
    if (record.chris.dns === 'waiting') return { state: 'ready', detail: `waiting on DNS for ${record.chris.host ?? ''}; a replay resumes there` };
    if (record.declared !== undefined && record.declared > record.chris.deployed) return { state: 'changed', detail: 'the VM was declared again since the deploy' };
    return { state: 'done', detail: `deployed ${record.chris.deployed.slice(0, 10)}` };
  }
  if (verb === 'user' && third === 'add') {
    const read = options_parse(words, 4, ['--email', '--password-file', '--on']);
    const on: string | undefined = read?.options.get('--on');
    const deployed: VmRecord[] = (on !== undefined ? [on] : deps.vms.names_list()).map((name: string): VmRecord | null => deps.vms.record_read(name)).filter((record): record is VmRecord => record !== null && record.chris !== undefined);
    if (deployed.length === 0) return { state: 'not yet', detail: on !== undefined ? `no ChRIS on ${on} (chris deploy ${on})` : 'no ChRIS deployed (chris deploy)' };
    if (on === undefined && deployed.length > 1) return { state: 'ready', detail: `stratus runs ${deployed.length} ChRIS; the line needs --on` };
    return { state: 'ready', detail: 'asks CUBE when it runs; a name already there is left as it is' };
  }
  return null;
}

/**
 * The providers `play --status` asks for stratus's verbs.
 *
 * @param deps - The stores.
 * @returns One per verb.
 */
export function lineStatusProviders_make(deps: LineStatusDeps): LineStatusProvider[] {
  return [
    { verb: 'net', read: (words: ReadonlyArray<string>): Promise<LineStatus | null> => net_read(deps, words) },
    { verb: 'vm', read: (words: ReadonlyArray<string>): Promise<LineStatus | null> => vm_read(deps, words) },
    { verb: 'chris', read: (words: ReadonlyArray<string>): Promise<LineStatus | null> => chris_read(deps, words) },
  ];
}
