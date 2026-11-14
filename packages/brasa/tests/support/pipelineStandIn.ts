/**
 * @file The pipeline module, standing in for a suite that stubs it: each
 * typed entry the ChRIS fallback calls is recorded as the `pipeline` line it
 * stands for (`['run', 'myPipe', '--previous', '12']`), so a suite reads
 * what ran as one recorded call.
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import { wordsStandIn_make } from './declarationStandIns.js';

/** A run, as the fallback asks for one. */
interface RunRequest {
  readonly pipeline: string;
  readonly previous?: number;
  readonly compute?: string;
  readonly detach: boolean;
  readonly dry: boolean;
  readonly dryNewFeed: boolean;
}

/** What records a line: the suite's mock of `builtin_pipeline`. */
type LineRecorder = (args: string[]) => Promise<CommandEnvelope> | unknown;

/**
 * The module's exports, each recording the line it stands for.
 *
 * @param record - The suite's mock.
 * @returns The exports.
 */
export function pipelineModule_standIn(record: LineRecorder): Record<string, unknown> {
  return {
    builtin_pipeline: record,
    pipelineCommand: wordsStandIn_make('pipeline', record, ['pipelines']),
    pipelineRun_execute: (request: RunRequest) => record([
      'run', request.pipeline,
      ...(request.previous !== undefined ? ['--previous', String(request.previous)] : []),
      ...(request.dryNewFeed ? ['--whatif-new-feed'] : []),
      ...(request.compute !== undefined ? ['--compute', request.compute] : []),
      ...(request.detach ? ['--detach'] : []),
      ...(request.dry && !request.dryNewFeed ? ['--whatif'] : []),
    ]),
    pipelineDiagramCommand_handle: (name: string, withArguments: boolean, signalflow: boolean) => record(['diagram', name, ...(withArguments ? ['--withargs'] : []), ...(signalflow ? ['--signalflow'] : [])]),
    pipelineInfo_handle: (name: string) => record(['info', name]),
    pipelineManifestCommand_handle: (name: string) => record(['manifest', name]),
    pipelineSource_handle: (name: string) => record(['source', name]),
  };
}

/**
 * A pipeline's manifest as salsa answers it: no nodes, so its `/bin` line
 * takes the session's options alone.
 *
 * @param name - The pipeline.
 * @returns The manifest.
 */
export async function pipelineManifest_standIn(name: string): Promise<{ ok: true; value: unknown }> {
  return { ok: true, value: { pipelineID: 3, name, rootIDs: [], nodes: [] } };
}
