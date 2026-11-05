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
  /** The task running this line now, as it is mounted (`/proc/steps/<id>`); absent when none does. */
  running: z.string().optional(),
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

/** The model kind `vm status` carries. */
export const STRATUS_VM_STATUS_MODEL_KIND = 'stratus.vm.status' as const;

/** The event a VM's teardown sends as each step begins and ends: its row, as `vm status` reads it. */
export const STRATUS_VM_STATE_EVENT = 'stratus.vm.state' as const;

/** The states a VM stands in, as `vm status` words them: a kept VM's, or `found` for one the tenancy runs that this session keeps no record of. */
export const VM_STATES = ['declared', 'data only', 'data kept', 'built', 'gone', 'found'] as const;

/** One VM as `vm status` reads it: from the host's records, or found in the tenancy (state `found`, `found` set, no spec). */
export const vmStatusRowSchema = z.object({
  name: z.string(),
  state: z.enum(VM_STATES),
  /** What the tenancy says of a VM this session keeps no record of; absent on a kept one and from an older daemon. */
  found: z.object({
    /** The instance's lifecycle state, lower case (`running`, `stopped`), or `data only` when only its tagged data stack stands. */
    state: z.string(),
    instanceId: z.string().nullable(),
    shape: z.string().nullable(),
    vcpus: z.number().nullable(),
    memoryGib: z.number().nullable(),
    /** Whether it carries stratus's VM tag: built by a stratus session, not this one; else made outside stratus. */
    tagged: z.boolean(),
    /** What runs on it, as `chris deploy` tagged its instance: the CUBE API's address and porter's name; null when untagged. */
    chris: z.object({ url: z.string(), porter: z.string().nullable() }).nullable().optional(),
  }).nullable().optional(),
  /** Its last teardown, once one has started: when, and each step (`machine`, `data`) where it stands; absent from an older daemon. */
  teardown: z.object({
    started: z.string(),
    steps: z.array(z.object({ name: z.string(), state: z.string(), started: z.string().nullable(), ended: z.string().nullable(), note: z.string().nullable() })),
  }).nullable().optional(),
  /** When this host's cache of it was read from the tenancy (built by a session that left no record here), or null; absent from an older daemon. */
  takenFrom: z.string().nullable().optional(),
  /** Whether the tenancy keeps no SSH key for it and this host holds none either: it is read and torn down, never reached; absent from an older daemon. */
  keyless: z.boolean().optional(),
  region: z.string(),
  /** Its spec, or null when spec.yaml does not read. */
  spec: vmSpecModelSchema.nullable(),
  /** Its reserved public address, kept by a default teardown; null before the data stack applies. */
  address: z.string().nullable(),
  /** The machine's private address, null without a machine. */
  inside: z.string().nullable(),
  protected: z.boolean(),
  /** When its machine was last built, ISO 8601; null when it stands without one. */
  built: z.string().nullable(),
  /** The ChRIS deployed on it, or null. */
  chris: z.object({ profile: z.string(), compute: z.string(), host: z.string().nullable(), url: z.string(), porter: z.string().nullable() }).nullable(),
});

/** What `vm status` answers: a row per VM kept here. */
export const vmStatusModelSchema = z.object({ vms: z.array(vmStatusRowSchema) });

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
  /** When the session read the cloud's price list (once, kept for the session), or null before; absent from an older session. */
  pricesRead: z.string().nullable().optional(),
});

export type LineState = (typeof LINE_STATES)[number];
export type LineStandingModel = z.infer<typeof lineStandingSchema>;
export type ManifestStatusModel = z.infer<typeof manifestStatusModelSchema>;
export type VmLimitsModel = z.infer<typeof vmLimitsModelSchema>;
export type VmSpecModel = z.infer<typeof vmSpecModelSchema>;
export type VmCostRate = z.infer<typeof vmCostRateSchema>;
export type VmCostRow = z.infer<typeof vmCostRowSchema>;
export type VmCostModel = z.infer<typeof vmCostModelSchema>;
export type VmState = (typeof VM_STATES)[number];
export type VmStatusRow = z.infer<typeof vmStatusRowSchema>;
export type VmStatusModel = z.infer<typeof vmStatusModelSchema>;
