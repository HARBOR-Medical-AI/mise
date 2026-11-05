/**
 * @file Where a script's lines stand (docs/stratus.adoc, D17): `play
 * --status` asks each verb, for its own line, what it would do, read from
 * the kept records and never from the cloud. A step on the script screen
 * wears the answer; chell prints it. Four states: not yet (what it stands
 * on is missing), ready, done (the line replays to unchanged or nothing to
 * do), changed (what it built moved under it, so a replay plans and asks).
 * A line whose build runs now carries that task's path beside its state
 * (`/proc/steps/vm-store-apply-machine`), so a surface can follow it with
 * `wait`: the state is what the records hold, the run is what is happening
 * to them.
 *
 * @module
 */
import { runner_get, type JobRecord, type JobRunner, type LineStatus, type LineStatusProvider } from '@fnndsc/brasa/core';
import { taskState_isOver } from '@fnndsc/menu';
import { CHRIS_JOBS } from '../chris/deploy.js';
import { CHRIS_PROFILES } from '../chris/profiles.js';
import { USER_JOBS } from '../chris/users.js';
import { clusterSpec_diff, specOptions_apply, type ClusterSpec } from '../cluster/spec.js';
import type { ClusterRecord, ClusterStore, StepRecord } from '../cluster/state.js';
import { buildJob_id, FIRST_BILLING_STEP, stepNext_find, STEPS_SOURCE } from '../cluster/steps.js';
import { NET_JOBS } from '../net/build.js';
import { cidr_read, netSpec_diff, type NetSpec } from '../net/spec.js';
import type { NetRecord, NetStore } from '../net/state.js';
import { VM_JOBS } from '../vm/build.js';
import { vmSpec_diff, vmSpec_read, vmStands_diff } from '../vm/spec.js';
import type { VmRecord, VmStore } from '../vm/state.js';
import { NEW_OPTIONS, options_read, sizingOptions_pick } from './build.js';

/** What the providers read. */
export interface LineStatusDeps {
  readonly nets: NetStore;
  readonly vms: VmStore;
  /** The clusters kept here; absent, a `cluster` line has no state to read. */
  readonly clusters?: ClusterStore;
  /** The session's runner, for the step running now; the installed one when absent. */
  readonly runner?: () => JobRunner | null;
}

/**
 * The task running one of the given jobs now, as it is mounted.
 *
 * @param deps - The stores and the runner.
 * @param ids - The job ids the line's verb starts.
 * @param labelStart - What the job's label begins with, when one id serves many lines (a VM's user adds).
 * @returns `/proc/steps/<id>`, or undefined when none of them runs.
 */
function running_find(deps: LineStatusDeps, ids: ReadonlyArray<string>, labelStart?: string): string | undefined {
  const runner: JobRunner | null = (deps.runner ?? runner_get)();
  if (runner === null) return undefined;
  const record: JobRecord | undefined = runner.jobs_list(STEPS_SOURCE).find((job: JobRecord): boolean =>
    !taskState_isOver(job.state) && ids.includes(job.id) && (labelStart === undefined || job.label.startsWith(labelStart)));
  return record === undefined ? undefined : `/proc/${STEPS_SOURCE}/${record.id}`;
}

/**
 * A standing with the running task beside it, when one runs.
 *
 * @param standing - The standing from the records.
 * @param running - The task's path, or undefined.
 * @returns The standing, the run added when there is one.
 */
function running_add(standing: LineStatus, running: string | undefined): LineStatus {
  return running === undefined ? standing : { ...standing, running };
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
    // What the change does to what stands, said with it: a built network's CIDR is its VCN's and its subnet's.
    const replaces: string = record.built !== undefined && (record.builtCidr ?? keptSpec.cidr) !== spec.cidr ? '; a new CIDR on a built network replaces its VCN and subnet, and every machine on them: net build refuses it unless --allow-alter' : '';
    return changes.length === 0 ? { state: 'done', detail: 'unchanged' } : { state: 'changed', detail: `${changes.join(', ')}${replaces}` };
  }
  if (verb === 'build') {
    const running: string | undefined = running_find(deps, [NET_JOBS.plan(name), NET_JOBS.apply(name)]);
    if (record === null || keptSpec === null) return running_add({ state: 'not yet', detail: `${name}: not declared (net new ${name})` }, running);
    if (record.gone !== undefined) return running_add({ state: 'ready', detail: 'torn down; a build brings it back' }, running);
    if (record.built === undefined) return running_add({ state: 'ready', detail: '' }, running);
    return running_add(record.declared !== undefined && record.declared > record.built ? { state: 'changed', detail: 'declared again since it was built' } : { state: 'done', detail: `built ${record.built.slice(0, 10)}` }, running);
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
    const running: string | undefined = running_find(deps, [VM_JOBS.plan(name, 'data'), VM_JOBS.plan(name, 'machine'), VM_JOBS.apply(name, 'data'), VM_JOBS.apply(name, 'machine')]);
    if (record === null || keptSpec === null) return running_add({ state: 'not yet', detail: `${name}: not declared (vm new ${name})` }, running);
    const net: NetRecord | null = deps.nets.record_read(keptSpec.net);
    if (net === null || net.built === undefined || net.gone !== undefined) return running_add({ state: 'not yet', detail: `the network ${keptSpec.net} is not built (net build ${keptSpec.net})` }, running);
    if (record.gone !== undefined || record.machineGone !== undefined) return running_add({ state: 'ready', detail: record.gone !== undefined ? 'torn down; a build makes it anew' : 'its machine is torn down; a build brings it back over its data' }, running);
    if (record.built === undefined) return running_add({ state: 'ready', detail: '' }, running);
    if (record.declared === undefined || record.declared <= record.built) return running_add({ state: 'done', detail: `built ${record.built.slice(0, 10)}` }, running);
    // What a build would change, when the record keeps what the last build made; a record from before that says only that it was declared again.
    // What runs, read from the tenancy, is the truth to compare with; the spec the last build kept stands in when the cloud was not read.
    // Each part from what runs when the listing read it (the sizes, the open ports, the backups, the OS); the spec the last build applied for a part it could not.
    const sizes: string[] | null = record.stands !== undefined ? vmStands_diff(record.stands, keptSpec) : null;
    const applied: string[] = record.builtSpec === undefined ? [] : vmSpec_diff(record.builtSpec, keptSpec);
    // A size the listing read is compared with what runs; one it could not read keeps the applied spec's word.
    const stands = record.stands;
    const read: ReadonlySet<string> = new Set(stands === undefined ? [] : [
      ...(['vcpu', 'memory', 'disk', 'data'] as const).filter((key): boolean => stands[key] !== null),
      ...(stands.open !== undefined && stands.open !== null ? ['open'] : []), ...(stands.backup !== undefined && stands.backup !== null ? ['dataBackup'] : []), ...(stands.os !== undefined && stands.os !== null ? ['os'] : []),
    ]);
    const owed: string[] = sizes === null ? applied : [...sizes, ...applied.filter((change: string): boolean => !read.has(change.split(' ')[0] ?? ''))];
    if ((record.stands !== undefined || record.builtSpec !== undefined) && owed.length === 0) return running_add({ state: 'done', detail: `built ${record.built.slice(0, 10)}; declared again unchanged` }, running);
    return running_add({ state: 'changed', detail: owed.length === 0 ? 'declared again since it was built; the build plans and asks' : `declared, not built: ${owed.join(', ')}; the build plans and asks` }, running);
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
    return running_add(chrisDeploy_read(deps, words, third), running_find(deps, [CHRIS_JOBS.deploy(third)]));
  }
  if (verb === 'user' && third === 'add') {
    const read = options_parse(words, 4, ['--email', '--password-file', '--on']);
    const on: string | undefined = read?.options.get('--on');
    const username: string | undefined = words[3];
    const deployed: VmRecord[] = (on !== undefined ? [on] : deps.vms.names_list()).map((name: string): VmRecord | null => deps.vms.record_read(name)).filter((record): record is VmRecord => record !== null && record.chris !== undefined);
    // One add job serves a VM's every user line; the job's label names the user it adds.
    const running: string | undefined = username === undefined ? undefined : running_find(deps, (on !== undefined ? [on] : deps.vms.names_list()).map((name: string): string => USER_JOBS.add(name)), `add ${username} `);
    if (deployed.length === 0) return running_add({ state: 'not yet', detail: on !== undefined ? `no ChRIS on ${on} (chris deploy ${on})` : 'no ChRIS deployed (chris deploy)' }, running);
    if (on === undefined && deployed.length > 1) return running_add({ state: 'ready', detail: `stratus runs ${deployed.length} ChRIS; the line needs --on` }, running);
    return running_add({ state: 'ready', detail: 'asks CUBE when it runs; a name already there is left as it is' }, running);
  }
  return null;
}

/**
 * `chris deploy <vm> …`, from the records.
 *
 * @param deps - The stores.
 * @param words - The line's words.
 * @param third - The VM.
 * @returns Its standing.
 */
function chrisDeploy_read(deps: LineStatusDeps, words: ReadonlyArray<string>, third: string): LineStatus {
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

/**
 * `cluster new <name> …`, `cluster plan <name>`, `cluster build <name>` and
 * `cluster verify <name>`, from the kept record: a spec declared again after
 * a plan, a build or a verify leaves that line changed; an adopted cluster's
 * build reads done through what its checkout did.
 *
 * @param deps - The stores.
 * @param words - The line's words.
 * @returns Its standing, or null for a verb with no state (`cluster status`).
 */
async function cluster_read(deps: LineStatusDeps, words: ReadonlyArray<string>): Promise<LineStatus | null> {
  const [, verb, name] = words;
  if (name === undefined || deps.clusters === undefined) return null;
  const store: ClusterStore = deps.clusters;
  const record: ClusterRecord | null = store.record_read(name);
  const keptSpec: ClusterSpec | null = store.spec_read(name)?.spec ?? null;
  const notDeclared: LineStatus = { state: 'not yet', detail: `${name}: not declared (cluster new ${name})` };
  // Declared again after a step ended: that step has a change to plan.
  const since = (step: StepRecord | undefined): boolean => record?.declared !== undefined && (step?.ended === undefined || record.declared > step.ended);
  if (verb === 'new') {
    const read = options_parse(words, 3, NEW_OPTIONS);
    if (read === null) return { state: 'ready', detail: '' };
    if (record === null || keptSpec === null) return { state: 'ready', detail: '' };
    const zone: string | undefined = read.options.get('--base-domain');
    if (zone !== undefined && zone !== record.baseDomain) return { state: 'ready', detail: `--base-domain ${zone}: its names live under ${record.baseDomain}; the line is refused` };
    const compartment: string | undefined = read.options.get('--compartment');
    if (compartment !== undefined && compartment !== record.compartmentId) return { state: 'ready', detail: `--compartment ${compartment}: it lives in ${record.compartmentId ?? 'a compartment of its own'}; the line is refused` };
    const sized = specOptions_apply(keptSpec, sizingOptions_pick(read.options));
    if ('error' in sized) return { state: 'ready', detail: sized.error };
    const changes: string[] = clusterSpec_diff(keptSpec, sized.spec);
    return changes.length === 0 ? { state: 'done', detail: 'unchanged' } : { state: 'changed', detail: changes.join(', ') };
  }
  if (verb === 'plan') {
    if (record === null) return notDeclared;
    const running: string | undefined = running_find(deps, [`${name}-plan`]);
    const planned: StepRecord | undefined = record.steps['infra-plan'];
    if (store.file_read(name, 'plan.json') === null) return running_add({ state: 'ready', detail: '' }, running);
    return running_add(since(planned) ? { state: 'changed', detail: 'declared again since it was planned' } : { state: 'done', detail: `planned${planned?.ended !== undefined ? ` ${planned.ended.slice(0, 10)}` : ''}` }, running);
  }
  if (verb === 'build') {
    if (record === null) return notDeclared;
    const running: string | undefined = running_find(deps, [buildJob_id(name)]);
    const next: string | null = stepNext_find(record);
    if (next === null) return running_add(since(record.steps['run']) ? { state: 'changed', detail: 'declared again since it was built; the build plans and asks' } : { state: 'done', detail: 'every step done' }, running);
    if (record.adopted !== undefined) return running_add({ state: 'ready', detail: `adopted from ${record.adopted.from}: building on it is refused until it is allowed by name` }, running);
    return running_add({ state: 'ready', detail: `next: ${next}${next === FIRST_BILLING_STEP ? ' (bills; asks first)' : ''}` }, running);
  }
  if (verb === 'verify') {
    if (record === null) return notDeclared;
    if (record.steps['run']?.state !== 'done') return { state: 'not yet', detail: `${name}: not installed (cluster build ${name})` };
    const verified: StepRecord | undefined = record.steps['verify'];
    if (verified?.state === 'done') return since(verified) ? { state: 'changed', detail: 'declared again since it was verified' } : { state: 'done', detail: verified.note ?? '' };
    return { state: 'ready', detail: verified?.state === 'failed' ? `last verify failed: ${verified.note ?? ''}` : '' };
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
    { verb: 'cluster', read: (words: ReadonlyArray<string>): Promise<LineStatus | null> => cluster_read(deps, words) },
  ];
}
