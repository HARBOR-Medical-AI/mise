/**
 * @file The script screen's models (docs/stratus.adoc, D17): what `play
 * --status`, `vm limits` and `vm cost` answer beneath their rendered text, so
 * a surface lays a script out as its rail, scales its sliders to what the
 * cloud sells and prices a step as its levers move. The page never reads
 * stratus's records: it asks these lines, as chell does.
 *
 * @module
 */
import { z } from 'zod';

/** The model kind `play --status` carries. */
export const MANIFEST_STATUS_MODEL_KIND = 'manifest.status' as const;

/** The four states a line stands in, read from what the backend keeps. */
export const LINE_STATES = ['not yet', 'ready', 'done', 'changed'] as const;

/** One line's standing, as `play --status` reads it. */
export const lineStandingSchema = z.object({
  /** The line's number in the script, from one. */
  number: z.number(),
  /** The line as it would run, its references filled. */
  text: z.string(),
  /** Its state; null when no verb reads it. */
  state: z.enum(LINE_STATES).nullable(),
  detail: z.string(),
});

/** What `play --status` answers: the manifest's name and a row per line. */
export const manifestStatusModelSchema = z.object({
  manifest: z.string(),
  lines: z.array(lineStandingSchema),
});

/** The model kind `vm limits` carries. */
export const STRATUS_VM_LIMITS_MODEL_KIND = 'stratus.vm.limits' as const;

/** A range a slider takes: from the least to the most. */
export const limitRangeSchema = z.object({ min: z.number(), max: z.number() });

/** What `vm limits` answers: what the shape sells, in the spec's words. */
export const vmLimitsModelSchema = z.object({
  /** The shape (`VM.Standard.E5.Flex`) and its family (`E5`). */
  shape: z.string(),
  family: z.string(),
  /** vCPUs: the ends, in steps of the cloud's core unit. */
  vcpu: limitRangeSchema.extend({ step: z.number() }),
  /** Memory in GiB: the shape's range, and per vCPU when the cloud bounds it. */
  memory: limitRangeSchema.extend({ perVcpu: limitRangeSchema.nullable() }),
  /** The boot disk and the data volume, in GB. */
  disk: limitRangeSchema,
  data: limitRangeSchema,
});

/** The model kind `vm cost` carries. */
export const STRATUS_VM_COST_MODEL_KIND = 'stratus.vm.cost' as const;

/** A VM's spec, as `vm new` declares it. */
export const vmSpecModelSchema = z.object({
  net: z.string(),
  open: z.array(z.number()),
  vcpu: z.number(),
  memory: z.number(),
  disk: z.number(),
  data: z.number(),
  dataBackup: z.enum(['daily', 'none']),
  os: z.string(),
});

/** What a spec bills an hour at list price: the machine and the data apart, since a default teardown keeps the data. */
export const vmCostRateSchema = z.object({
  machineHour: z.number(),
  dataHour: z.number(),
  currency: z.string(),
});

/** One VM as `vm cost` priced it. */
export const vmCostRowSchema = z.object({
  name: z.string(),
  /** Whether the VM is declared (`vm new`); a priced name not declared is a what-if. */
  declared: z.boolean(),
  /** The spec priced: the declared one with the line's options over it. */
  spec: vmSpecModelSchema,
  /** Its cost, or null when the cloud gave no list price. */
  cost: vmCostRateSchema.nullable(),
  /** What the line changed from the declared spec (`memory 8 → 16`), empty when nothing or not declared. */
  changes: z.array(z.string()),
  /** The declared spec's cost when the line changed it, so a surface shows the difference. */
  before: vmCostRateSchema.nullable(),
});

/** What `vm cost` answers: a row per VM priced. */
export const vmCostModelSchema = z.object({
  vms: z.array(vmCostRowSchema),
});

export type LineState = (typeof LINE_STATES)[number];
export type LineStandingModel = z.infer<typeof lineStandingSchema>;
export type ManifestStatusModel = z.infer<typeof manifestStatusModelSchema>;
export type VmLimitsModel = z.infer<typeof vmLimitsModelSchema>;
export type VmSpecModel = z.infer<typeof vmSpecModelSchema>;
export type VmCostRate = z.infer<typeof vmCostRateSchema>;
export type VmCostRow = z.infer<typeof vmCostRowSchema>;
export type VmCostModel = z.infer<typeof vmCostModelSchema>;
