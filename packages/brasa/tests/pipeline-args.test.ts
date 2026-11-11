/**
 * @file Unit tests for the pure `pipeline run` argument parser.
 *
 * @module
 */
import { describe, it, expect } from '@jest/globals';
import { pipelineRunArgs_parse } from '../src/builtins/res/pipeline.args.js';

describe('pipelineRunArgs_parse', () => {
  it('returns undefined overrides when none given', () => {
    expect(pipelineRunArgs_parse(['run', 'myPipe'])).toEqual({
      computeOverride: undefined,
      previousOverride: undefined,
      paramFile: undefined,
      bindings: [],
      detach: false,
      verbose: false,
      dry: false,
      dryNewFeed: false,
      parseError: null,
    });
  });
  it('parses --compute and --previous', () => {
    expect(pipelineRunArgs_parse(['run', 'myPipe', '--compute', 'host', '--previous', '42'])).toEqual({
      computeOverride: 'host',
      previousOverride: 42,
      paramFile: undefined,
      bindings: [],
      detach: false,
      verbose: false,
      dry: false,
      dryNewFeed: false,
      parseError: null,
    });
  });
  it('rejects a trailing utility flag with no value', () => {
    expect(pipelineRunArgs_parse(['run', 'myPipe', '--compute']).parseError).toBe('--compute requires a resource');
  });
  it('parses compound bindings, equals values, and one parameter file', () => {
    expect(pipelineRunArgs_parse([
      'run', 'myPipe',
      '--paramFile', '~/experiments/run-1.yaml',
      '--segmentation.threshold', '-0.5',
      '--@481.memory_limit=8Gi',
      '--segmentation.enabled',
    ])).toEqual({
      computeOverride: undefined,
      previousOverride: undefined,
      paramFile: '~/experiments/run-1.yaml',
      bindings: [
        { node: 'segmentation', field: 'threshold', value: -0.5 },
        { node: '@481', field: 'memory_limit', value: '8Gi' },
        { node: 'segmentation', field: 'enabled', value: true },
      ],
      detach: false,
      verbose: false,
      dry: false,
      dryNewFeed: false,
      parseError: null,
    });
  });
  it('rejects repeated parameter files', () => {
    expect(pipelineRunArgs_parse([
      'run', 'myPipe', '--paramFile', 'one.yaml', '--paramFile', 'two.yaml',
    ]).parseError).toBe('--paramFile may be supplied only once');
  });
});

describe('pipelineRunArgs_parse echo and whatif words', () => {
  it('reads --verbose, --whatif and the new-feed form of it', () => {
    expect(pipelineRunArgs_parse(['run', 'myPipe', '--verbose'])).toMatchObject({ verbose: true, dry: false, parseError: null });
    expect(pipelineRunArgs_parse(['run', 'myPipe', '--whatif'])).toMatchObject({ dry: true, dryNewFeed: false });
    expect(pipelineRunArgs_parse(['run', 'myPipe', '--whatif-new-feed'])).toMatchObject({ dry: true, dryNewFeed: true });
  });
});
