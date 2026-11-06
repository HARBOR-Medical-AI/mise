/**
 * @file The plugin vocabulary: a registered plugin as a typed envelope payload.
 *
 * A plugin is the one-node case of the compute graph — everything a pipeline
 * node is, without the pipeline around it. Its substance reached surfaces as
 * a rendered manual for as long as `cat /bin/<plugin>` was the only way to
 * ask, which meant nothing downstream could do anything with it: not a card,
 * not a parameter list, not a form, not an export. This model is that same
 * substance as data; the manual becomes one projection of it.
 *
 * Parameters are the payload that matters. They arrive complete or the model
 * is wrong: a parameter list that quietly stops at a page boundary is worse
 * than the paragraph it replaces, because a paragraph does not look
 * authoritative.
 *
 * @module
 */
import { z } from 'zod';

/**
 * One declared parameter of a plugin.
 *
 * `default` is `unknown` because CUBE serves whatever the plugin declared —
 * a string, a number, a boolean, or null for "no default" — and a surface
 * renders it rather than computing on it.
 */
export const pluginParameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
  default: z.unknown().optional(),
  help: z.string().optional(),
  /** The flag as it is typed: `--name`, or the bare name for a positional. */
  flag: z.string(),
});

/**
 * The `plugin.info` model: one registered plugin, whole.
 *
 * Identity, the authoring facts, and every declared parameter. What a
 * surface draws from it — a one-node graph, a parameter table, an argument
 * form — is the surface's business; the model carries no layout and no
 * rendering.
 */
export const pluginInfoModelSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  version: z.string(),
  /** `ds`, `fs`, or `ts` — what the node consumes and produces. */
  type: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  authors: z.string().optional(),
  /** Where the plugin's source or docs live, when it declared them. */
  documentation: z.string().optional(),
  category: z.string().optional(),
  /**
   * Every declared parameter, in the order CUBE serves them.
   *
   * Complete, always: the builder drains the collection rather than asking
   * for a page and calling it the answer.
   */
  parameters: z.array(pluginParameterSchema),
  /** The `/bin` entry that runs it, so a surface can lower a click to a command. */
  command: z.string().optional(),
});

export type PluginParameter = z.infer<typeof pluginParameterSchema>;
export type PluginInfoModel = z.infer<typeof pluginInfoModelSchema>;

/** The model's envelope kind. */
export const PLUGIN_INFO_MODEL_KIND = 'plugin.info' as const;

/** One plugin's place in a `plugin sync` plan. */
export const pluginSyncEntrySchema = z.object({
  /** add, newer, skip, cubeNewer, drift, imageTaken, cubeOnly or invalid. */
  group: z.enum(['add', 'newer', 'skip', 'cubeNewer', 'drift', 'imageTaken', 'cubeOnly', 'invalid']),
  name: z.string(),
  /** The index's version, when the entry comes from the index. */
  version: z.string().optional(),
  /** The versions the CUBE holds of this name. */
  cubeVersions: z.array(z.string()).optional(),
  /** The index file it comes from. */
  file: z.string().optional(),
  /** Why it is in a report group. */
  detail: z.string().optional(),
});

/** One upload a `plugin sync` made. */
export const pluginSyncResultSchema = z.object({
  name: z.string(),
  version: z.string(),
  ok: z.boolean(),
  /** CUBE's reason, when it refused. */
  reason: z.string().optional(),
});

/**
 * The `plugin.sync` model: a plan, and what applying it did once it ran.
 *
 * The plan alone answers `--plan`, a NO, and a session that may not apply;
 * `results` and the counts arrive when the adds were uploaded.
 */
export const pluginSyncModelSchema = z.object({
  /** The index's short name (`chris-plugins @ 8c9a1f6`). */
  label: z.string(),
  /** The source as typed (`FNNDSC/chris-plugins@main`). */
  source: z.string(),
  /** The full commit read, when the source names one. */
  commit: z.string().nullable(),
  /** How many descriptors the index holds. */
  indexed: z.number(),
  /** Compute resources adds are registered on. */
  computes: z.array(z.string()),
  entries: z.array(pluginSyncEntrySchema),
  /** Each upload's outcome, once applied. */
  results: z.array(pluginSyncResultSchema).optional(),
  /** Whether the adds were applied. */
  applied: z.boolean(),
});

/** One failure `plugin validate` found. */
export const pluginValidateFindingSchema = z.object({
  file: z.string(),
  rule: z.number(),
  message: z.string(),
});

/** What one validation rule did. */
export const pluginValidateRuleSchema = z.object({
  rule: z.number(),
  title: z.string(),
  checked: z.boolean(),
  /** Why it did not run (`no schema`, `--offline`). */
  note: z.string().optional(),
  failed: z.number(),
});

/** The `plugin.validate` model: every finding, and each rule's state. */
export const pluginValidateModelSchema = z.object({
  label: z.string(),
  commit: z.string().nullable(),
  descriptors: z.number(),
  findings: z.array(pluginValidateFindingSchema),
  rules: z.array(pluginValidateRuleSchema),
  ok: z.boolean(),
});

export type PluginSyncEntry = z.infer<typeof pluginSyncEntrySchema>;
export type PluginSyncResult = z.infer<typeof pluginSyncResultSchema>;
export type PluginSyncModel = z.infer<typeof pluginSyncModelSchema>;
export type PluginValidateModel = z.infer<typeof pluginValidateModelSchema>;

/** The `plugin sync` model's envelope kind. */
export const PLUGIN_SYNC_MODEL_KIND = 'plugin.sync' as const;

/** The `plugin validate` model's envelope kind. */
export const PLUGIN_VALIDATE_MODEL_KIND = 'plugin.validate' as const;
