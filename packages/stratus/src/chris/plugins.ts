/**
 * @file A ChRIS's plugins, filled from the plugin index by the chell that runs
 * beside it (docs/stratus.adoc, D16; issue #1405).
 *
 * A stratus session holds the stratus backend, which has no `plugin` verb:
 * that verb belongs to a session connected to a CUBE. A VM deployed with a
 * porter runs such a chell, in porter's container, beside its CUBE; so
 * `chris plugin sync --on <vm>` runs `plugin sync` there, as a one-off chell
 * signed in as `chris`. The admin's password is read on the VM, from the
 * environment `cube.env` gives the CUBE container, and exchanged there for a
 * token, which reaches the chell on stdin: it never leaves the VM and never
 * stands on a command line.
 *
 * The sync runs twice. First `plugin sync --plan`, its plan read back in
 * marked lines (the plan's model, field by field, through the chell's own
 * variables), so stratus asks on its own side with the plan's counts; then,
 * on a yes, `plugin sync --yes` pinned to the commit the plan read, its lines
 * streamed into the task's log as each plugin lands.
 *
 * Key components:
 * - PLUGIN_SYNC_LINE: the VM line every run uses; its script comes on stdin.
 * - pluginSyncScript_render: the script for a plan or an apply.
 * - pluginSyncPlan_parse / pluginSyncReceipt_parse: what the chell printed, read back.
 * - chrisPluginPlanRun_make / chrisPluginApplyRun_make: the two jobs.
 * - pluginSyncQuestion_words: the question a plan asks.
 *
 * Typical usage:
 * ```ts
 * const read: PluginPlanResult = {};
 * await job_runFollowed(PLUGIN_JOBS.sync(vm), `read the plugin plan on ${vm}`, chrisPluginPlanRun_make(vm, ask, deps, read));
 * ```
 *
 * Dependencies: the VM's remote (`sh` on the VM, `docker compose` in the
 * ChRIS folder); porter's image carrying chell 5.20.0 or later; the CUBE
 * container's Python.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall } from '../cloud/builder.js';
import { vmRemote_open, type RemoteAnswer, type VmRemote } from '../vm/remote.js';
import type { DeployDeps } from './deploy.js';
import { CHRIS_DIR } from './compose.js';

/** The first chell with `plugin sync`. */
export const PLUGIN_SYNC_CHELL_MIN: string = '5.20.0';

/** The line every plugin run uses on the VM; the script it runs comes on stdin. */
export const PLUGIN_SYNC_LINE: string = `cd ${CHRIS_DIR} && sh -s`;

/** What every line the script prints for stratus starts with. */
export const PLUGIN_MARK: string = 'stratus-sync';

/** The script's exit when porter's chell is older than {@link PLUGIN_SYNC_CHELL_MIN}. */
export const EXIT_CHELL_OLD: number = 4;

/** The script's exit when porter's container does not answer. */
export const EXIT_NO_PORTER: number = 3;

/** The script's exit when CUBE gave no token for `chris`. */
export const EXIT_NO_TOKEN: number = 5;

/** A plugin index source word the script may carry: a GitHub `owner/repo[@ref]`, `cube:` or `host:` path. */
export const PLUGIN_SOURCE: RegExp = /^[A-Za-z0-9._/@:+-]+$/;

/** A ref the script may carry: a branch, a tag or a commit. */
export const PLUGIN_REF: RegExp = /^[A-Za-z0-9._/-]+$/;

/** What a sync is asked for. */
export interface PluginSyncAsk {
  /** The index source, as typed; the chell's own default index when absent. */
  readonly source?: string;
  /** The ref, overriding the source's own. */
  readonly ref?: string;
}

/** A plan, as the VM's chell read it. */
export interface PluginPlanRead {
  /** The chell that read it. */
  readonly chell: string;
  /** The index's short name (`chris-plugins @ 8c9a1f6`). */
  readonly label: string;
  /** The source as the chell read it (`FNNDSC/chris-plugins@main`). */
  readonly source: string;
  /** The full commit, when the source names one. */
  readonly commit: string | null;
  /** How many descriptors the index holds. */
  readonly indexed: number;
  /** The compute resources adds are registered on. */
  readonly computes: string[];
  /** Each plugin's group, by name, in the plan's order. */
  readonly entries: ReadonlyArray<{ readonly group: string; readonly name: string }>;
}

/** What applying a plan did, from the chell's summary. */
export interface PluginSyncReceipt {
  readonly added: number;
  readonly skipped: number;
  readonly reported: number;
  readonly failed: number;
  /** Whether a stop ended it before every add was sent. */
  readonly stopped: boolean;
}

/** The groups a plan adds from. */
const ADD_GROUPS: ReadonlyArray<string> = ['add', 'newer'];

/** How many names of one reported group the question names before it counts the rest. */
const NAMES_SHOWN: number = 5;

/**
 * A word as POSIX `sh` quotes it: inside single quotes, each quote closed,
 * escaped and opened again.
 *
 * @param word - The word.
 * @returns It, quoted.
 */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The node program, run in porter's container, that finds the chell porter
 * starts sessions with and says its version; it exits
 * {@link EXIT_CHELL_OLD} when that chell is older than the least that has
 * `plugin sync`.
 *
 * @returns The program, with double quotes only, for a single-quoted shell word.
 */
function chellLocateProgram_render(): string {
  return [
    'const path = require("path");',
    'const root = require("child_process").execSync("npm root -g").toString().trim();',
    'const entry = require.resolve("@fnndsc/chell", { paths: [path.join(root, "@fnndsc/porter")] });',
    'const version = require(path.join(path.dirname(path.dirname(entry)), "package.json")).version;',
    'const at = (v) => v.split(".").map((part) => parseInt(part, 10) || 0);',
    `const [a, b] = [at(version), at("${PLUGIN_SYNC_CHELL_MIN}")];`,
    'const old = a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];',
    'console.log(version + " " + entry);',
    `process.exit(old ? ${EXIT_CHELL_OLD} : 0);`,
  ].join(' ');
}

/**
 * The Python program, run in the CUBE container, that exchanges the admin's
 * password (from the environment `cube.env` gives it) for `chris`'s token.
 *
 * @returns The program, with double quotes only, for a single-quoted shell word.
 */
function tokenProgram_render(): string {
  return [
    'import json, os, urllib.request',
    'body = json.dumps({"username": "chris", "password": os.environ["CHRIS_SUPERUSER_PASSWORD"]}).encode()',
    'request = urllib.request.Request("http://127.0.0.1:8000/api/v1/auth-token/", data=body, headers={"Content-Type": "application/json"})',
    'print(json.load(urllib.request.urlopen(request))["token"])',
  ].join('\n');
}

/**
 * The chell line that reads a plan: `plugin sync … --plan` held in a
 * variable, then its fields printed one marked line each. A field the plan
 * leaves empty prints no line, which the parse reads as empty.
 *
 * @param ask - The source and ref.
 * @returns The line.
 */
function planLine_render(ask: PluginSyncAsk): string {
  const sync: string = ['plugin', 'sync', ...(ask.source !== undefined ? [ask.source] : []), ...(ask.ref !== undefined ? ['--ref', ask.ref] : []), '--plan'].join(' ');
  const fields: string[] = ['indexed', 'label', 'source', 'commit', 'computes', 'entries.group', 'entries.name'];
  return [`P=$(${sync})`, ...fields.map((field: string): string => `echo ${PLUGIN_MARK} ${field} \${P.${field}}`)].join('; ');
}

/**
 * The chell line that applies a plan, pinned to the commit it read.
 *
 * @param plan - The plan read.
 * @returns The line.
 */
function applyLine_render(plan: PluginPlanRead): string {
  return ['plugin', 'sync', plan.source, ...(plan.commit !== null ? ['--ref', plan.commit] : []), '--yes'].join(' ');
}

/**
 * The script a plugin run sends to the VM's `sh`: find porter's chell (and
 * refuse one too old), take `chris`'s token from CUBE on the VM, and run the
 * chell line with the token on its stdin, in a home of its own that goes
 * when it ends. Its first line carries the ask, so a fake VM can answer it.
 *
 * @param kind - A plan or an apply.
 * @param line - The chell line.
 * @param target - `chris@<CUBE's URL>`.
 * @param carried - What the first line carries.
 * @returns The script.
 */
function script_render(kind: 'plan' | 'apply', line: string, target: string, carried: unknown): string {
  const inner: string = 'H=$(mktemp -d) && export HOME="$H" XDG_CONFIG_HOME="$H/config" XDG_STATE_HOME="$H/state" XDG_CACHE_HOME="$H/cache" XDG_RUNTIME_DIR="$H/run" && mkdir -p -m 700 "$XDG_RUNTIME_DIR" && node "$1" --no-door --auth-token-stdin -c "$2" "$3"; rc=$?; rm -rf "$H"; exit $rc';
  return [
    `# ${PLUGIN_MARK} ${kind} ${Buffer.from(JSON.stringify(carried), 'utf-8').toString('base64')}`,
    `cd ${CHRIS_DIR} || exit 1`,
    `found=$(docker compose exec -T porter node -e ${shQuote(chellLocateProgram_render())}); located=$?`,
    `[ -n "$found" ] || { echo "${PLUGIN_MARK} no-porter"; exit ${EXIT_NO_PORTER}; }`,
    'set -- $found',
    `echo "${PLUGIN_MARK} chell $1"`,
    `[ "$located" -eq 0 ] || exit ${EXIT_CHELL_OLD}`,
    'CHELL=$2',
    `TOKEN=$(docker compose exec -T chris python -c ${shQuote(tokenProgram_render())}) && [ -n "$TOKEN" ] || { echo "${PLUGIN_MARK} no-token"; exit ${EXIT_NO_TOKEN}; }`,
    `printf '%s\\n' "$TOKEN" | docker compose exec -T porter sh -c ${shQuote(inner)} sh "$CHELL" ${shQuote(line)} ${shQuote(target)}`,
    '',
  ].join('\n');
}

/**
 * The script that reads a plan.
 *
 * @param ask - The source and ref.
 * @param url - CUBE's URL, as porter's sessions reach it.
 * @returns The script.
 */
export function pluginPlanScript_render(ask: PluginSyncAsk, url: string): string {
  return script_render('plan', planLine_render(ask), `chris@${url}`, ask);
}

/**
 * The script that applies a plan, pinned to the commit it read.
 *
 * @param plan - The plan read.
 * @param url - CUBE's URL, as porter's sessions reach it.
 * @returns The script.
 */
export function pluginApplyScript_render(plan: PluginPlanRead, url: string): string {
  return script_render('apply', applyLine_render(plan), `chris@${url}`, { source: plan.source, ...(plan.commit !== null ? { ref: plan.commit } : {}) });
}

/**
 * Text without its terminal colours.
 *
 * @param text - The text.
 * @returns It, plain.
 */
function ansi_strip(text: string): string {
  // eslint-disable-next-line no-control-regex -- the colour codes start with ESC
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * The marked lines a run printed, by field: the words after the field.
 *
 * @param stdout - What the run printed.
 * @returns Each field's value.
 */
function marks_read(stdout: string): Map<string, string> {
  const marks: Map<string, string> = new Map();
  for (const line of ansi_strip(stdout).split('\n')) {
    if (!line.startsWith(`${PLUGIN_MARK} `)) continue;
    const rest: string = line.slice(PLUGIN_MARK.length + 1);
    const space: number = rest.indexOf(' ');
    marks.set(space < 0 ? rest : rest.slice(0, space), space < 0 ? '' : rest.slice(space + 1).trim());
  }
  return marks;
}

/**
 * The chell version a run printed, when it printed one.
 *
 * @param stdout - What the run printed.
 * @returns The version, or null.
 */
export function pluginChell_parse(stdout: string): string | null {
  return marks_read(stdout).get('chell') ?? null;
}

/**
 * A plan, from what its run printed.
 *
 * @param stdout - What the run printed.
 * @returns The plan, or null when the chell printed none (the plan failed).
 */
export function pluginSyncPlan_parse(stdout: string): PluginPlanRead | null {
  const marks: Map<string, string> = marks_read(stdout);
  const indexed: string | undefined = marks.get('indexed');
  const label: string | undefined = marks.get('label');
  const source: string | undefined = marks.get('source');
  if (indexed === undefined || label === undefined || source === undefined || !/^\d+$/.test(indexed)) return null;
  const words = (field: string): string[] => (marks.get(field) ?? '').split(/\s+/).filter((word: string): boolean => word !== '');
  const groups: string[] = words('entries.group');
  const names: string[] = words('entries.name');
  if (groups.length !== names.length) return null;
  return {
    chell: marks.get('chell') ?? '?',
    label,
    source,
    commit: marks.get('commit') ?? null,
    indexed: Number(indexed),
    computes: words('computes'),
    entries: groups.map((group: string, at: number): { group: string; name: string } => ({ group, name: names[at] as string })),
  };
}

/**
 * What applying did, from the chell's summary line.
 *
 * @param stdout - What the run printed.
 * @returns The receipt, or null when no summary was printed.
 */
export function pluginSyncReceipt_parse(stdout: string): PluginSyncReceipt | null {
  const line: string | undefined = ansi_strip(stdout).split('\n').reverse().find((each: string): boolean => /\d+ added, \d+ skipped, \d+ reported, \d+ failed\./.test(each));
  if (line === undefined) return null;
  const found: RegExpExecArray = /(\d+) added, (\d+) skipped, (\d+) reported, (\d+) failed\./.exec(line) as RegExpExecArray;
  return { added: Number(found[1]), skipped: Number(found[2]), reported: Number(found[3]), failed: Number(found[4]), stopped: line.trimStart().startsWith('Stopped:') };
}

/**
 * How many a plan adds.
 *
 * @param plan - The plan.
 * @returns The adds: plugins not in CUBE, and newer versions of ones that are.
 */
export function pluginPlanAdds_count(plan: PluginPlanRead): number {
  return plan.entries.filter((entry): boolean => ADD_GROUPS.includes(entry.group)).length;
}

/**
 * The reported entries, in words: each group with its names, a few named
 * and the rest counted.
 *
 * @param plan - The plan.
 * @returns `invalid: pl-s3path; drift: pl-a, pl-b`, or empty when none is reported.
 */
function reported_words(plan: PluginPlanRead): string {
  const byGroup: Map<string, string[]> = new Map();
  for (const entry of plan.entries) {
    if (ADD_GROUPS.includes(entry.group) || entry.group === 'skip') continue;
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry.name]);
  }
  return [...byGroup.entries()].map(([group, names]: [string, string[]]): string => {
    const shown: string = names.slice(0, NAMES_SHOWN).join(', ');
    return `${group}: ${shown}${names.length > NAMES_SHOWN ? ` and ${names.length - NAMES_SHOWN} more` : ''}`;
  }).join('; ');
}

/**
 * What stands besides the adds: how many are there already, and the
 * reported ones by group.
 *
 * @param plan - The plan.
 * @returns `174 already there, 1 reported (invalid: pl-s3path)`.
 */
export function pluginPlanStanding_words(plan: PluginPlanRead): string {
  const adds: number = pluginPlanAdds_count(plan);
  const skipped: number = plan.entries.filter((entry): boolean => entry.group === 'skip').length;
  const reportedCount: number = plan.entries.length - adds - skipped;
  return `${skipped} already there, ${reportedCount === 0 ? '0 reported' : `${reportedCount} reported (${reported_words(plan)})`}`;
}

/**
 * The question a plan asks, with its counts.
 *
 * @param vm - The VM.
 * @param plan - The plan.
 * @returns The question.
 */
export function pluginSyncQuestion_words(vm: string, plan: PluginPlanRead): string {
  return `chris plugin sync ${vm}: adds ${pluginPlanAdds_count(plan)} from ${plan.label} on ${plan.computes.join(', ') || 'its computes'}, ${pluginPlanStanding_words(plan)}. Nothing is removed or changed. Continue? [y/N]`;
}

/** The plugin job's id. */
export const PLUGIN_JOBS = { sync: (vm: string): string => `chris-${vm}-plugin-sync` } as const;

/** Where the plan job leaves what it read. */
export interface PluginPlanResult {
  plan?: PluginPlanRead;
  /** The VM's chell, when it is too old to sync. */
  old?: string;
}

/** Where the apply job leaves what it did. */
export interface PluginApplyResult {
  receipt?: PluginSyncReceipt;
}

/**
 * Opens the VM for a job.
 *
 * @param vm - The VM.
 * @param deps - What it runs over.
 * @param call - The job's log and stop.
 * @returns The remote.
 */
async function remote_open(vm: string, deps: DeployDeps, call: BuildCall): Promise<VmRemote> {
  return await (deps.remote_open ?? ((name: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(name, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(vm, call);
}

/**
 * Why a run failed, in a line.
 *
 * @param vm - The VM.
 * @param answer - What the run answered.
 * @returns The reason.
 */
function failure_words(vm: string, answer: RemoteAnswer): string {
  const marks: Map<string, string> = marks_read(answer.stdout);
  if (marks.has('no-porter')) return `${vm}: porter's container does not answer (chris status ${vm})`;
  if (marks.has('no-token')) return `${vm}: CUBE gave chris no token with the password in cube.env (chris passwd --on ${vm})`;
  const said: string = ansi_strip(answer.stderr || answer.stdout).trim().split('\n').filter((line: string): boolean => !line.startsWith(`${PLUGIN_MARK} `)).slice(-3).join(' / ');
  return `${vm}: plugin sync exit ${answer.code}${said !== '' ? `: ${said}` : ''}`;
}

/**
 * The job that reads a sync's plan on a VM.
 *
 * @param vm - The VM.
 * @param url - CUBE's URL.
 * @param ask - The source and ref.
 * @param deps - What it runs over (the deploy's).
 * @param result - Given the plan, or the too-old chell.
 * @returns The job's work.
 */
export function chrisPluginPlanRun_make(vm: string, url: string, ask: PluginSyncAsk, deps: DeployDeps, result: PluginPlanResult): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    const remote: VmRemote = await remote_open(vm, deps, call);
    context.log_write(`reading the plugin plan on ${vm} with porter's chell`);
    const answer: RemoteAnswer = await remote.run(PLUGIN_SYNC_LINE, pluginPlanScript_render(ask, url));
    const chell: string | null = pluginChell_parse(answer.stdout);
    if (answer.code === EXIT_CHELL_OLD && chell !== null) { result.old = chell; context.log_write(`porter's chell on ${vm} is ${chell}`); return; }
    const plan: PluginPlanRead | null = pluginSyncPlan_parse(answer.stdout);
    if (plan === null) throw new Error(failure_words(vm, answer));
    result.plan = plan;
    context.log_write(`${plan.label}: ${pluginPlanAdds_count(plan)} to add, read by chell ${plan.chell}`);
  };
}

/**
 * The job that applies a plan on a VM, its lines streamed into the log as
 * each plugin lands.
 *
 * @param vm - The VM.
 * @param url - CUBE's URL.
 * @param plan - The plan read, whose commit pins the apply.
 * @param deps - What it runs over (the deploy's).
 * @param result - Given the receipt.
 * @returns The job's work.
 */
export function chrisPluginApplyRun_make(vm: string, url: string, plan: PluginPlanRead, deps: DeployDeps, result: PluginApplyResult): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    const remote: VmRemote = await remote_open(vm, deps, call);
    context.log_write(`syncing plugins on ${vm} from ${plan.label}${plan.commit !== null ? ` (${plan.commit})` : ''}`);
    let pending: string = '';
    const watch = (chunk: string): void => {
      pending += ansi_strip(chunk);
      const lines: string[] = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (/^(added|failed)\s/.test(line.trim())) context.log_write(line.trim());
    };
    const answer: RemoteAnswer = await remote.run(PLUGIN_SYNC_LINE, pluginApplyScript_render(plan, url), watch);
    const receipt: PluginSyncReceipt | null = pluginSyncReceipt_parse(answer.stdout);
    if (receipt === null && context.signal.aborted) throw new Error(`stopped; what was added on ${vm} stays, and chris plugin sync --on ${vm} plans only what is still missing`);
    if (receipt === null) throw new Error(failure_words(vm, answer));
    result.receipt = receipt;
    context.log_write(`${receipt.added} added, ${receipt.skipped} skipped, ${receipt.reported} reported, ${receipt.failed} failed${receipt.stopped ? ' (stopped)' : ''}`);
  };
}
