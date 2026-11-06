/**
 * @file The plugin verbs that register: `plugin add`, `sync`, `validate`, `index`.
 *
 * The logic is salsa's (`plugin_add`, the index reads, the plan, the checks);
 * this module is the verb: it reads the words, asks where a change needs a
 * yes, streams what lands, and answers with text and a typed model.
 *
 * `plugin sync` is a plan first. Anyone may see it (the plugin list is
 * public); applying it needs an administrator, so a session that is not one
 * sees the plan and the `sudo` line to run instead. After the plan comes one
 * question, `[y/N]`, unless `--yes`; `--plan` stops at the plan. Uploads
 * stream one line each as they land, and what landed stays when the job is
 * stopped (`kill %N`): a rerun plans only what is still missing.
 *
 * Paths: a sync source with no prefix is a CUBE path (an index uploaded
 * there, how a surface with no host access syncs); `plugin validate` and
 * `plugin add --json` need no CUBE, so theirs is a host path. `host:` and
 * `cube:` say which outright; `owner/repo[@ref]` is a GitHub repository.
 *
 * Key components:
 * - pluginAdd_run: `plugin add <name|image|url>` and `plugin add --json <file>`.
 * - pluginSync_run: `plugin sync [source] [--ref] [--plan] [--yes] [--compute]`.
 * - pluginValidate_run: `plugin validate <file|dir|source> [--offline]`.
 * - pluginIndexVerb_run: `plugin index [<source>] [--reset]`.
 * - syncPlan_render / validateReport_render: the text a plan and a report read as.
 *
 * Typical usage:
 * ```ts
 * const envelope: CommandEnvelope = await pluginSync_run(commandArgs_process(args, { booleanLongOptions: PLUGIN_BOOLEAN_FLAGS }), args);
 * ```
 *
 * Dependencies: salsa's plugin modules, the engine's question and sink, the
 * index configuration.
 *
 * @module
 */

import { promises as fs } from 'node:fs';

import chalk from 'chalk';
import type {
  PluginAddResult,
  PluginIndex,
  PluginIndexSource,
  SyncGroup,
  SyncPlan,
  SyncPlanEntry,
  SyncReceipt,
  SyncResult,
  SyncSeams,
  ValidateFinding,
  ValidateReport,
  ValidateRuleState,
} from '@fnndsc/salsa';
import {
  envelope_error,
  envelope_ok,
  PLUGIN_SYNC_MODEL_KIND,
  PLUGIN_VALIDATE_MODEL_KIND,
  type CommandEnvelope,
  type EnvelopeModel,
  type PluginSyncModel,
  type PluginValidateModel,
} from '@fnndsc/menu';
import { errorStack, type Result } from '@fnndsc/fond';

import { DEFAULT_PLUGIN_INDEX, indexConfig_persist, pluginIndex_clear, pluginIndex_get, pluginIndex_isDefault, pluginIndex_set } from '../../config/indexConfig.js';
import { storeUrl_get } from '../../config/storeConfig.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { authorizationFailure_is, sudoHint_build } from '../../core/elevation.js';
import { exitCode_set } from '../../core/handlerRun.js';
import { repl_confirm } from '../../core/question.js';
import { sink_dataLine } from '../../core/sink.js';
import { path_resolve, type ParsedArgs } from '../utils.js';

/** salsa, loaded when a verb runs (the engine's other builtins never need it). */
type Salsa = typeof import('@fnndsc/salsa');

/**
 * Loads salsa's plugin logic.
 *
 * @returns The salsa module.
 */
function salsa_load(): Promise<Salsa> {
  return import('@fnndsc/salsa');
}

/** Long flags of the plugin verbs that take no value. */
export const PLUGIN_BOOLEAN_FLAGS: readonly string[] = ['plan', 'yes', 'offline', 'reset'];

/** What each plan group reads as, in the order a plan lists them. */
const GROUP_TITLES: Readonly<Record<SyncGroup, string>> = {
  add: 'add · not in this CUBE',
  newer: 'add beside · the index has a newer version',
  skip: 'skip · already here, the same',
  cubeNewer: 'report · this CUBE has a newer version',
  drift: 'report, never touched · same version, different descriptor',
  imageTaken: 'report · the image is registered under another version; CUBE would refuse it',
  cubeOnly: 'report · in this CUBE, not in the index',
  invalid: 'report, never uploaded · fails plugin validate (rules 1–4)',
};

/**
 * `plugin add <name|image|url>` and `plugin add --json <file>`.
 *
 * @param parsed - The parsed words (`_[0]` is `add`).
 * @param words - The words as typed after `plugin`, for the sudo line.
 * @returns The add's outcome as text.
 *
 * @example
 * ```ts
 * await pluginAdd_run(commandArgs_process(['add', 'pl-dircopy']), ['add', 'pl-dircopy']);
 * ```
 */
export async function pluginAdd_run(parsed: ParsedArgs, words: readonly string[]): Promise<CommandEnvelope> {
  const input: string | undefined = parsed._[1];
  const jsonFile: string | undefined = typeof parsed['json'] === 'string' ? parsed['json'] : undefined;
  if (input === undefined && jsonFile === undefined) {
    return envelope_ok(`${chalk.red('Usage: plugin add <name|image|url> [--compute <resources>] [--store <url>] | plugin add --json <file>')}\n`);
  }
  errorStack.stack_clear();
  const lines: string[] = [];
  const note = (line: string): void => { lines.push(line); };
  const options = {
    ...(typeof parsed['compute'] === 'string' ? { compute: parsed['compute'] } : {}),
    store: typeof parsed['store'] === 'string' ? parsed['store'] : storeUrl_get(),
    ...(typeof parsed['adminUser'] === 'string' ? { adminUser: parsed['adminUser'] } : {}),
    ...(typeof parsed['adminPassword'] === 'string' ? { adminPassword: parsed['adminPassword'] } : {}),
    ...(typeof parsed['publicRepo'] === 'string' ? { publicRepo: parsed['publicRepo'] } : {}),
  };

  const salsa: Salsa = await salsa_load();
  let result: PluginAddResult;
  if (jsonFile !== undefined) {
    const text: string | null = await fileText_read(jsonFile, salsa);
    if (text === null) return verb_fail(`plugin add: could not read ${jsonFile}: ${errorStack.stack_pop()?.message ?? 'no such file'}`);
    result = await salsa.plugin_addJson(text, options, note);
  } else {
    result = await salsa.plugin_add(input ?? '', options, note);
  }
  return addResult_render(result, input ?? jsonFile ?? '', lines, words);
}

/**
 * `plugin add` for a caller holding parsed words only (`store install`).
 *
 * @param parsed - The parsed words (`_[0]` is the subcommand, `_[1]` the plugin).
 * @returns The add's outcome as text.
 *
 * @example
 * ```ts
 * await plugin_addInteractive({ _: ['install', 'pl-dircopy'] });
 * ```
 */
export async function plugin_addInteractive(parsed: ParsedArgs): Promise<CommandEnvelope> {
  return pluginAdd_run(parsed, ['add', ...parsed._.slice(1)]);
}

/**
 * `plugin sync [source] [--ref <ref>] [--plan] [--yes] [--compute a,b]`.
 *
 * @param parsed - The parsed words (`_[0]` is `sync`).
 * @param words - The words as typed after `plugin`, for the sudo line.
 * @param seams - The CUBE reads and the upload; the connected CUBE's by default.
 * @returns The plan, or the plan with what applying it did, as text and a `plugin.sync` model.
 *
 * @example
 * ```ts
 * await pluginSync_run(commandArgs_process(['sync', '--plan'], { booleanLongOptions: PLUGIN_BOOLEAN_FLAGS }), ['sync', '--plan']);
 * ```
 */
export async function pluginSync_run(parsed: ParsedArgs, words: readonly string[], seamsGiven?: SyncSeams): Promise<CommandEnvelope> {
  errorStack.stack_clear();
  const salsa: Salsa = await salsa_load();
  const {
    computeNames_resolve, localAccount_adminAccessEnsure, pluginIndex_load,
    syncPlan_apply, syncPlan_build, syncPlanAdds_list, syncSeams_cube,
  }: Salsa = salsa;
  const seams: SyncSeams = seamsGiven ?? syncSeams_cube;
  const source: PluginIndexSource | null = await syncSource_resolve(parsed, salsa);
  if (source === null) return verb_fail('plugin sync: no index to read.');
  const index: Result<PluginIndex> = await pluginIndex_load(source);
  if (!index.ok) return verb_fail(errorStack.stack_pop()?.message ?? 'plugin sync: the index could not be read.');

  const computes: Result<string[]> = await computeNames_resolve(typeof parsed['compute'] === 'string' ? parsed['compute'] : undefined);
  if (!computes.ok) return verb_fail(`plugin sync: ${errorStack.stack_pop()?.message ?? 'no compute resources'}`);

  let plan: SyncPlan;
  try {
    plan = await syncPlan_build(index.value, computes.value, seams);
  } catch (error: unknown) {
    return verb_fail(`plugin sync: this CUBE could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const planText: string = syncPlan_render(plan);
  const adds: SyncPlanEntry[] = syncPlanAdds_list(plan);
  if (parsed['plan'] === true || adds.length === 0) {
    const closing: string = adds.length === 0 ? `${chalk.green('Nothing to add.')}\n` : `${chalk.cyan(`--plan: ${adds.length} to add; nothing was registered.`)}\n`;
    return envelope_ok(`${planText}${closing}`, syncModel_build(plan));
  }

  const access: Result<void> = await localAccount_adminAccessEnsure();
  if (!access.ok) {
    errorStack.stack_pop();
    exitCode_set(1);
    return envelopeModel_attach(
      envelope_error(planText, undefined, `${chalk.yellow('Registering plugins needs an administrator; nothing was registered.')}\n${sudoHint_build('plugin', [...words])}`),
      syncModel_build(plan));
  }

  sink_dataLine(planText.replace(/\n$/, ''));
  const question: string = `Register ${adds.length} plugin${adds.length === 1 ? '' : 's'} from ${plan.label} on ${plan.computes.join(', ')}? Nothing already here is changed or deleted. [y/N]`;
  if (parsed['yes'] !== true && !await repl_confirm(question)) {
    return envelope_ok(`${chalk.yellow('No: nothing was registered.')}\n`, syncModel_build(plan));
  }

  commandCancellation_enable();
  const receipt: SyncReceipt = await syncPlan_apply(plan, seams, (result: SyncResult): void => {
    sink_dataLine(result.ok
      ? `${chalk.green('added')}  ${result.name} ${result.version}`
      : `${chalk.red('failed')} ${result.name} ${result.version}: ${result.reason ?? 'no reason given'}`);
  }, commandCancellation_signalGet());
  const summary: string = `${receipt.added} added, ${receipt.skipped} skipped, ${receipt.reported} reported, ${receipt.failed} failed.`;
  if (receipt.stopped) {
    exitCode_set(1);
    return envelopeModel_attach(
      envelope_error(`${chalk.yellow(`Stopped: ${summary} ${receipt.unsent} never sent; what was added stays, and a rerun continues from it.`)}\n`, undefined, ''),
      syncModel_build(plan, receipt));
  }
  if (receipt.failed > 0) {
    exitCode_set(1);
    const failedNames: string = receipt.results.filter((r: SyncResult): boolean => !r.ok).map((r: SyncResult): string => `${r.name} ${r.version}`).join(', ');
    return envelopeModel_attach(
      envelope_error(`${chalk.red(summary)}\n`, undefined, `${chalk.red(`Not registered: ${failedNames}`)}\n`),
      syncModel_build(plan, receipt));
  }
  return envelope_ok(`${chalk.green(summary)}\n`, syncModel_build(plan, receipt));
}

/**
 * `plugin validate <file|dir|source> [--offline]`.
 *
 * @param parsed - The parsed words (`_[0]` is `validate`).
 * @param fetcher - The fetch rule 5 and a GitHub source use.
 * @returns The report, as text and a `plugin.validate` model; exit 1 when a rule that ran failed.
 *
 * @example
 * ```ts
 * await pluginValidate_run(commandArgs_process(['validate', './plugins', '--offline'], { booleanLongOptions: PLUGIN_BOOLEAN_FLAGS }));
 * ```
 */
export async function pluginValidate_run(parsed: ParsedArgs, fetcher: typeof fetch = fetch): Promise<CommandEnvelope> {
  const word: string | undefined = parsed._[1];
  if (word === undefined) return envelope_ok(`${chalk.red('Usage: plugin validate <file|dir|owner/repo[@ref]|cube:<path>> [--offline]')}\n`);
  errorStack.stack_clear();
  const salsa: Salsa = await salsa_load();
  const { pluginIndex_load, pluginIndex_validate, pluginIndexSource_parse }: Salsa = salsa;
  const ref: string | undefined = typeof parsed['ref'] === 'string' ? parsed['ref'] : undefined;
  const single: boolean = word.endsWith('.json');
  const source: PluginIndexSource | null = single ? null : await sourcePath_resolve(pluginIndexSource_parse(word, 'host', ref));
  const index: Result<PluginIndex> = single ? await singleFileIndex_read(word, salsa) : source === null ? { ok: false } : await pluginIndex_load(source, fetcher);
  if (!index.ok) return verb_fail(errorStack.stack_pop()?.message ?? `plugin validate: could not read ${word}`);
  let report: ValidateReport;
  try {
    report = await pluginIndex_validate(index.value, { offline: parsed['offline'] === true, fetcher });
  } catch (error: unknown) {
    return verb_fail(`plugin validate: ${error instanceof Error ? error.message : String(error)}`);
  }
  const model: { kind: typeof PLUGIN_VALIDATE_MODEL_KIND; data: PluginValidateModel } = { kind: PLUGIN_VALIDATE_MODEL_KIND, data: { ...report, rules: report.rules.map((r: ValidateRuleState): ValidateRuleState => ({ ...r })) } };
  if (!report.ok) {
    exitCode_set(1);
    return envelopeModel_attach(envelope_error(validateReport_render(report)), model);
  }
  return envelope_ok(validateReport_render(report), model);
}

/**
 * `plugin index [<owner/repo[@ref]>|cube:<path>|host:<path>] [--reset]`.
 *
 * @param parsed - The parsed words (`_[0]` is `index`).
 * @returns The index in effect, or what it was set to.
 *
 * @example
 * ```ts
 * await pluginIndexVerb_run({ _: ['index', 'FNNDSC/chris-plugins@v1'] });
 * ```
 */
export async function pluginIndexVerb_run(parsed: ParsedArgs): Promise<CommandEnvelope> {
  if (parsed['reset'] === true) {
    pluginIndex_clear();
    await indexConfig_persist();
    return envelope_ok(`${chalk.green(`Plugin index reset to the default: ${chalk.blue(DEFAULT_PLUGIN_INDEX)}`)}\n`);
  }
  const word: string | undefined = parsed._[1];
  if (word === undefined) {
    return envelope_ok(`${chalk.bold('Plugin index:')} ${chalk.blue(pluginIndex_get())}${pluginIndex_isDefault() ? chalk.gray(' (default)') : chalk.yellow(' (set)')}\n`);
  }
  const { pluginIndexSource_format, pluginIndexSource_parse }: Salsa = await salsa_load();
  const source: PluginIndexSource | null = pluginIndexSource_parse(word, 'cube');
  if (source === null) return verb_fail('Usage: plugin index [<owner/repo[@ref]>|cube:<path>|host:<path>] [--reset]');
  const written: string = source.kind === 'cube' ? `cube:${await path_resolve(source.path)}` : pluginIndexSource_format(source);
  pluginIndex_set(written);
  await indexConfig_persist();
  return envelope_ok(`${chalk.green(`Plugin index set to: ${chalk.blue(written)}`)}\n`);
}

/**
 * Renders a plan as the operator reads it.
 *
 * @param plan - The plan.
 * @returns Its header, then each group with its plugins (skip as a count).
 *
 * @example
 * ```ts
 * syncPlan_render(plan); // 'plugin sync: chris-plugins @ 8c9a1f6, 175 plugins → this CUBE, on host\n…'
 * ```
 */
export function syncPlan_render(plan: SyncPlan): string {
  const lines: string[] = [chalk.bold(`plugin sync: ${plan.label}, ${plan.indexed} plugins → this CUBE, on ${plan.computes.join(', ')}`)];
  for (const group of Object.keys(GROUP_TITLES) as SyncGroup[]) {
    const entries: SyncPlanEntry[] = plan.entries.filter((entry: SyncPlanEntry): boolean => entry.group === group);
    if (entries.length === 0) continue;
    lines.push(`  ${chalk.cyan(String(entries.length).padStart(4))}  ${GROUP_TITLES[group]}`);
    if (group === 'skip') continue;
    for (const entry of entries) lines.push(`          ${planEntry_render(entry)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Renders a validation report as the operator reads it.
 *
 * @param report - The report.
 * @returns Each rule's state, then every finding, then the verdict.
 *
 * @example
 * ```ts
 * validateReport_render(report); // 'plugin validate: chris-plugins @ 8c9a1f6, 175 descriptors\n…'
 * ```
 */
export function validateReport_render(report: ValidateReport): string {
  const lines: string[] = [chalk.bold(`plugin validate: ${report.label}, ${report.descriptors} descriptor${report.descriptors === 1 ? '' : 's'}`)];
  for (const rule of report.rules) {
    const state: string = !rule.checked
      ? chalk.yellow(`not checked, ${rule.note ?? 'skipped'}`)
      : rule.failed === 0 ? chalk.green('pass') : chalk.red(`${rule.failed} failed`);
    lines.push(`  rule ${rule.rule} (${rule.title}): ${state}`);
  }
  for (const finding of report.findings) lines.push(`  ${chalk.red(finding.file)} rule ${finding.rule}: ${finding.message}`);
  const files: number = new Set(report.findings.map((f: ValidateFinding): string => f.file)).size;
  lines.push(report.ok
    ? chalk.green(`${report.descriptors} descriptor${report.descriptors === 1 ? '' : 's'}: every rule that ran passes.`)
    : chalk.red(`${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.`));
  return `${lines.join('\n')}\n`;
}

/**
 * Renders one plan entry's line.
 *
 * @param entry - The entry.
 * @returns `name version` with the CUBE's versions and why, where they say something.
 */
function planEntry_render(entry: SyncPlanEntry): string {
  const version: string = entry.version === undefined ? '' : ` ${entry.version}`;
  const held: string = entry.cubeVersions !== undefined && entry.cubeVersions.length > 0 ? chalk.gray(` (here: ${entry.cubeVersions.join(', ')})`) : '';
  const detail: string = entry.detail === undefined ? '' : chalk.gray(` · ${entry.detail}`);
  return `${entry.name}${version}${held}${detail}`;
}

/**
 * Builds the `plugin.sync` model.
 *
 * @param plan - The plan.
 * @param receipt - What applying it did, when it was applied.
 * @returns The model, in its envelope slot.
 */
function syncModel_build(plan: SyncPlan, receipt?: SyncReceipt): { kind: typeof PLUGIN_SYNC_MODEL_KIND; data: PluginSyncModel } {
  return {
    kind: PLUGIN_SYNC_MODEL_KIND,
    data: {
      label: plan.label,
      source: plan.source,
      commit: plan.commit,
      indexed: plan.indexed,
      computes: plan.computes,
      entries: plan.entries.map(({ descriptor: _descriptor, ...entry }: SyncPlanEntry) => entry),
      ...(receipt === undefined ? {} : { results: receipt.results }),
      applied: receipt !== undefined,
      ...(receipt?.stopped === true ? { stopped: true } : {}),
    },
  };
}

/**
 * Resolves the index a sync reads: the word typed, or the configured one.
 *
 * @param parsed - The parsed words.
 * @param salsa - The salsa module.
 * @returns The source with its CUBE path made absolute, or null when none.
 */
async function syncSource_resolve(parsed: ParsedArgs, salsa: Salsa): Promise<PluginIndexSource | null> {
  const ref: string | undefined = typeof parsed['ref'] === 'string' ? parsed['ref'] : undefined;
  return sourcePath_resolve(salsa.pluginIndexSource_parse(parsed._[1] ?? pluginIndex_get(), 'cube', ref));
}

/**
 * Makes a CUBE source's path absolute against where the session stands.
 *
 * @param source - The parsed source.
 * @returns The source, its CUBE path resolved.
 */
async function sourcePath_resolve(source: PluginIndexSource | null): Promise<PluginIndexSource | null> {
  if (source === null || source.kind !== 'cube') return source;
  return { kind: 'cube', path: await path_resolve(source.path) };
}

/**
 * Reads one descriptor file as a one-descriptor index (no schema).
 *
 * @param word - The file (a host path, or `cube:<path>`).
 * @param salsa - The salsa module.
 * @returns The index, or an error on the error stack.
 */
async function singleFileIndex_read(word: string, salsa: Salsa): Promise<Result<PluginIndex>> {
  const text: string | null = await fileText_read(word, salsa);
  if (text === null) return { ok: false };
  const file: string = word.split('/').pop() ?? word;
  return { ok: true, value: { source: word, label: file, commit: null, descriptors: [{ file, text }], schema: null } };
}

/**
 * Reads a file's text: a host path, or `cube:<path>` on CUBE.
 *
 * @param word - The file as typed.
 * @param salsa - The salsa module.
 * @returns Its text, or null with the reason on the error stack.
 */
async function fileText_read(word: string, salsa: Salsa): Promise<string | null> {
  if (word.startsWith('cube:')) {
    const text: Result<string> = await salsa.fileContent_get(await path_resolve(word.slice('cube:'.length)));
    return text.ok ? text.value : null;
  }
  const path: string = word.startsWith('host:') ? word.slice('host:'.length) : word;
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error: unknown) {
    errorStack.stack_push('error', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Renders an add's outcome.
 *
 * @param result - What the add did.
 * @param input - What was added, as typed.
 * @param lines - The progress lines it wrote.
 * @param words - The words after `plugin`, for the sudo line.
 * @returns The outcome envelope.
 */
function addResult_render(result: PluginAddResult, input: string, lines: readonly string[], words: readonly string[]): CommandEnvelope {
  const progress: string = lines.map((line: string): string => `${chalk.gray(line)}\n`).join('');
  const named: string = result.name === undefined ? input : `${result.name}${result.version === undefined ? '' : ` ${result.version}`}`;
  if (result.outcome === 'installed') return envelope_ok(`${progress}${chalk.green(`Registered ${named}.`)}\n`);
  if (result.outcome === 'already_exists') return envelope_ok(`${progress}${chalk.yellow(`${named} is already registered in this CUBE; nothing changed.`)}\n`);

  exitCode_set(1);
  const errors: string[] = errorStack.allOfType_get('error').map((error: string): string => error.replace(/^\[.*?\]\s+\|\s+/, ''));
  const warnings: string[] = errorStack.allOfType_get('warning').map((warning: string): string => warning.replace(/^\[.*?\]\s+\|\s+/, ''));
  let rendered: string = `${progress}${chalk.red(`Not registered: ${named}.`)}\n`;
  for (const error of errors) rendered += `${chalk.red(`  - ${error}`)}\n`;
  for (const warning of warnings) rendered += `${chalk.yellow(`  [WARNING] ${warning}`)}\n`;
  if (errors.some(authorizationFailure_is)) rendered += sudoHint_build('plugin', [...words]);
  return envelope_error('', undefined, rendered);
}

/**
 * Attaches a model to an envelope (an error envelope carries one too).
 *
 * @param envelope - The envelope.
 * @param model - The model.
 * @returns The envelope, carrying the model.
 */
function envelopeModel_attach(envelope: CommandEnvelope, model: EnvelopeModel): CommandEnvelope {
  envelope.model = model;
  return envelope;
}

/**
 * Fails a verb with a message.
 *
 * @param message - What went wrong.
 * @returns An error envelope; exit code 1.
 */
function verb_fail(message: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(message)}\n`);
}
