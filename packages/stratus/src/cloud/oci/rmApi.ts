/**
 * @file The Resource Manager calls the OCI builder makes: stacks made from
 * a zip, plan, apply, import-state and destroy jobs, and what a job leaves
 * (its state, its log, its plan as JSON, its outputs). Terraform runs inside
 * OCI; nothing here runs a host program (docs/stratus.adoc, D3).
 *
 * Every call answers plain records, so the builder maps records and its
 * tests replay recorded answers. One client per region. Only this folder
 * imports an `oci-*` package (`lint:stratus-deps`).
 *
 * @module
 */
import * as common from 'oci-common';
import * as resourcemanager from 'oci-resourcemanager';
import { notFound } from './errors.js';

/** The Terraform the stacks run: the newest Resource Manager offers. */
export const RM_TERRAFORM_VERSION: string = '1.5.x';

/** A job as Resource Manager reports it. */
export interface RmJobRecord {
  readonly id: string;
  /** `ACCEPTED`, `IN_PROGRESS`, `FAILED`, `SUCCEEDED`, `CANCELING`, `CANCELED`. */
  readonly state: string;
  /** Why it failed, in Resource Manager's words. */
  readonly failure?: string;
}

/** A stack as Resource Manager reports it. */
export interface RmStackRecord {
  readonly id: string;
  readonly displayName: string;
  readonly state: string;
  readonly compartmentId: string;
  /** Its variables, as set; a summary carries none. */
  readonly variables: Readonly<Record<string, string>>;
}

/** What a job is asked to do. */
export type RmOperation =
  | { readonly kind: 'plan' }
  | { readonly kind: 'apply'; readonly planJobId: string }
  | { readonly kind: 'import'; readonly stateBase64: string }
  | { readonly kind: 'destroy' };

/** The Resource Manager calls, in one region. */
export interface RmApi {
  stack_create(request: { compartmentId: string; displayName: string; description: string; zipBase64: string; variables: Record<string, string>; tags: Record<string, string> }): Promise<RmStackRecord>;
  stack_update(stackId: string, request: { zipBase64?: string; variables?: Record<string, string> }): Promise<void>;
  stack_get(stackId: string): Promise<RmStackRecord>;
  /** The stacks in a compartment carrying a freeform tag. */
  stacks_tagged(compartmentId: string, tagKey: string): Promise<Array<RmStackRecord & { tagValue: string }>>;
  job_create(stackId: string, operation: RmOperation, displayName: string): Promise<RmJobRecord>;
  job_get(jobId: string): Promise<RmJobRecord>;
  /** Asks a job to stop; never forced. */
  job_cancel(jobId: string): Promise<void>;
  /** The job's log lines, oldest first. */
  jobLog_read(jobId: string): Promise<string[]>;
  /** A plan job's plan, as Terraform's JSON. */
  jobPlan_read(jobId: string): Promise<unknown>;
  /** An apply job's outputs, by name. */
  jobOutputs_read(jobId: string): Promise<Record<string, string>>;
  /** How many resources a stack's Terraform state holds. */
  stackResources_count(stackId: string): Promise<number>;
  /** Removes a stack; one already gone is no error. Its resources must be destroyed first. */
  stack_delete(stackId: string): Promise<void>;
}

/** How the calls authenticate: an API-key profile, as the read driver does. */
export interface RmApiOptions {
  readonly configFile?: string;
  readonly profile?: string;
  readonly region: string;
}

/**
 * A readable stream's whole text.
 *
 * @param value - The stream the SDK answered with.
 * @returns Its text.
 */
async function stream_text(value: unknown): Promise<string> {
  if (typeof value === 'string') return value;
  const chunks: Buffer[] = [];
  if (value !== null && typeof value === 'object' && Symbol.asyncIterator in value) {
    for await (const chunk of value as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }
  if (value !== null && typeof value === 'object' && 'getReader' in value) {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      chunks.push(Buffer.from(read.value));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
  return String(value);
}

/**
 * The Resource Manager calls over the SDK.
 *
 * @param options - The profile and the region.
 * @returns The calls.
 */
export function rmApi_make(options: RmApiOptions): RmApi {
  const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(options.configFile, options.profile);
  const client: resourcemanager.ResourceManagerClient = new resourcemanager.ResourceManagerClient({ authenticationDetailsProvider: provider });
  client.regionId = options.region;
  const job_convert = (job: resourcemanager.models.Job): RmJobRecord => ({
    id: job.id ?? '',
    state: String(job.lifecycleState ?? 'UNKNOWN'),
    ...(job.failureDetails?.message !== undefined ? { failure: job.failureDetails.message } : {}),
  });
  const stack_convert = (stack: resourcemanager.models.Stack | resourcemanager.models.StackSummary): RmStackRecord => ({
    id: stack.id ?? '', displayName: stack.displayName ?? '', state: String(stack.lifecycleState ?? 'UNKNOWN'), compartmentId: stack.compartmentId ?? '',
    variables: 'variables' in stack ? { ...(stack.variables ?? {}) } : {},
  });
  return {
    async stack_create(request) {
      const response = await client.createStack({
        createStackDetails: {
          compartmentId: request.compartmentId,
          displayName: request.displayName,
          description: request.description,
          configSource: { configSourceType: 'ZIP_UPLOAD', zipFileBase64Encoded: request.zipBase64 } as resourcemanager.models.CreateZipUploadConfigSourceDetails,
          variables: request.variables,
          terraformVersion: RM_TERRAFORM_VERSION,
          freeformTags: request.tags,
        },
      });
      return stack_convert(response.stack);
    },
    async stack_update(stackId, request) {
      await client.updateStack({
        stackId,
        updateStackDetails: {
          ...(request.zipBase64 !== undefined ? { configSource: { configSourceType: 'ZIP_UPLOAD', zipFileBase64Encoded: request.zipBase64 } as resourcemanager.models.UpdateZipUploadConfigSourceDetails } : {}),
          ...(request.variables !== undefined ? { variables: request.variables } : {}),
        },
      });
    },
    async stack_get(stackId) {
      return stack_convert((await client.getStack({ stackId })).stack);
    },
    async stacks_tagged(compartmentId, tagKey) {
      const found: Array<RmStackRecord & { tagValue: string }> = [];
      for await (const stack of client.listAllStacks({ compartmentId })) {
        const value: string | undefined = stack.freeformTags?.[tagKey];
        if (value !== undefined) found.push({ ...stack_convert(stack), tagValue: value });
      }
      return found;
    },
    async job_create(stackId, operation, displayName) {
      const details: resourcemanager.models.CreateJobDetails['jobOperationDetails'] =
        operation.kind === 'plan' ? { operation: 'PLAN' } as resourcemanager.models.CreatePlanJobOperationDetails
          : operation.kind === 'apply' ? { operation: 'APPLY', executionPlanStrategy: 'FROM_PLAN_JOB_ID', executionPlanJobId: operation.planJobId } as resourcemanager.models.CreateApplyJobOperationDetails
            : operation.kind === 'import' ? { operation: 'IMPORT_TF_STATE', tfStateBase64Encoded: operation.stateBase64 } as resourcemanager.models.CreateImportTfStateJobOperationDetails
              : { operation: 'DESTROY', executionPlanStrategy: 'AUTO_APPROVED' } as resourcemanager.models.CreateDestroyJobOperationDetails;
      const response = await client.createJob({ createJobDetails: { stackId, displayName, jobOperationDetails: details } });
      return job_convert(response.job);
    },
    async job_get(jobId) {
      return job_convert((await client.getJob({ jobId })).job);
    },
    async job_cancel(jobId) {
      await client.cancelJob({ jobId, isForced: false });
    },
    async jobLog_read(jobId) {
      // The log as one text, not paged: the paged read answers `invalid pagination token` a few thousand lines in (a
      // 79-resource destroy), on every poll, so nothing of the job was ever passed on.
      const text: string = await stream_text((await client.getJobLogsContent({ jobId })).value);
      return text.split('\n').filter((line: string): boolean => line !== '');
    },
    async jobPlan_read(jobId) {
      const response = await client.getJobTfPlan({ jobId, tfPlanFormat: resourcemanager.requests.GetJobTfPlanRequest.TfPlanFormat.Json });
      return JSON.parse(await stream_text(response.value)) as unknown;
    },
    async stackResources_count(stackId) {
      const state = JSON.parse(await stream_text((await client.getStackTfState({ stackId })).value)) as { resources?: Array<{ mode?: string; instances?: unknown[] }> };
      return (state.resources ?? []).filter((resource): boolean => resource.mode !== 'data').reduce((sum: number, resource): number => sum + (resource.instances?.length ?? 1), 0);
    },
    async stack_delete(stackId) {
      try {
        await client.deleteStack({ stackId });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
      }
    },
    async jobOutputs_read(jobId) {
      const outputs: Record<string, string> = {};
      let page: string | undefined;
      do {
        const response = await client.listJobOutputs({ jobId, ...(page !== undefined ? { page } : {}) });
        for (const output of response.jobOutputsCollection.items ?? []) {
          if (output.outputName !== undefined) outputs[output.outputName] = output.outputValue ?? '';
        }
        page = response.opcNextPage || undefined;
      } while (page !== undefined);
      return outputs;
    },
  };
}
