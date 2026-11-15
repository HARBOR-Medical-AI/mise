/**
 * @file The declaration of a `/bin` line, made from what CUBE declares: a
 * plugin's parameters (each type, optional and default, short flags, path
 * parameters) and a pipeline's per-node options; the line parsed against
 * it, refused before anything runs, completed and described as a schema;
 * and the declaration kept by its entry and version.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { PluginSpec } from '../src/chris/binDeclarations.js';

/** The plugin versions CUBE has: their parameters, by `name@version`. */
const mockPluginFind = jest.fn(async (_client: unknown, name: string, version: string) => ({ data: { name, version, type: 'ds', title: `${name} title` }, handle: { of: `${name}@${version}` } }));
const mockParametersDrain = jest.fn(async (_handle: unknown) => [
  { name: 'threads', type: 'int', optional: true, default: 1, help: 'How many threads', flag: '--threads', short_flag: '-t' },
]);
cuminMock_install(() => ({
  plugin_find: mockPluginFind,
  pluginParameters_drain: mockParametersDrain,
  errorStack: { stack_pop: () => undefined, stack_push: () => undefined, checkpoint_mark: () => 0, checkpoint_drain: () => [] },
}));
const mockManifestGet = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({ pipelineManifest_get: mockManifestGet }));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { connection: { client_get: async () => ({}) }, getCWD: async () => '/home/u' } }));
/** What `/bin` lists. */
let binListing: Array<{ name: string; type: string; title?: string }> = [];
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({ vfs: { data_get: async () => ({ ok: true, value: binListing }) } }));
const mockPluginRun = jest.fn(async () => ({ status: 'ok' as const, rendered: '' }));
jest.unstable_mockModule('../src/builtins/pluginExecute.js', () => ({ pluginParsed_run: mockPluginRun }));

const {
  binDeclaration_get, binDeclarations_forget, pipelineDeclaration_make, pipelineNodeOptions_list, pipelineWords_parse, pluginDeclaration_make, pluginWords_parse,
} = await import('../src/chris/binDeclarations.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { backend_install } = await import('../src/core/backend.js');
const { chrisArgumentKinds } = await import('../src/chris/kinds.js');
backend_install({ id: 'chris', session: {} as never, argumentKinds: chrisArgumentKinds });

/** What a stand-in line runs: nothing. */
const run = async () => ({ status: 'ok' as const, rendered: '' });

/** A plugin with a parameter of every type CUBE has, as its API serves them. */
const EVERY_TYPE: PluginSpec = {
  name: 'pl-every',
  version: '1.2.0',
  kind: 'ds',
  title: 'Every type',
  parameters: [
    { name: 'label', type: 'str', optional: true, default: 'T1', help: 'A label', flag: '--label' },
    { name: 'threads', type: 'int', optional: true, default: 1, help: 'Threads', flag: '--threads', shortFlag: '-t' },
    { name: 'threshold', type: 'float', optional: false, help: 'The threshold', flag: '--threshold' },
    { name: 'verbose', type: 'bool', optional: true, default: false, help: 'Say more', flag: '--verbose', shortFlag: '-v' },
    { name: 'inputFile', type: 'path', optional: true, help: 'A file in CUBE', flag: '--inputFile' },
    { name: 'outputDir', type: 'unextpath', optional: true, help: 'A folder in CUBE', flag: '--outputDir' },
    // The session's own options win a name both claim: this one is never posted to CUBE.
    { name: 'detach', type: 'bool', optional: true, flag: '--detach' },
    // A short flag the session takes (`-h`, help) is the session's; the long one stands.
    { name: 'height', type: 'integer', optional: true, flag: '--height', shortFlag: '-h' },
  ],
};

/** A pipeline of two nodes: one with a usable title, one whose title is not a shell word. */
const PIPELINE = {
  pipelineID: 12,
  name: 'Brain segmentation',
  rootIDs: [41],
  nodes: [
    {
      pipingID: 41, title: 'segment', pluginName: 'pl-segment', pluginVersion: '1.0', parentID: null, computeResourceName: 'host', parameterDefaults: [],
      parameterDefinitions: [
        { name: 'threshold', type: 'float', optional: true, default: 0.5 },
        { name: 'normalize', type: 'boolean', optional: true },
        { name: 'plugininstances', type: 'string', optional: true },
      ],
    },
    {
      pipingID: 42, title: 'surface stage', pluginName: 'pl-surface', pluginVersion: '2.0', parentID: 41, computeResourceName: 'host', parameterDefaults: [],
      parameterDefinitions: [{ name: 'smooth', type: 'integer', optional: true }],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  binDeclarations_forget();
  binListing = [];
});

describe('a plugin\'s declaration, from its parameters', () => {
  const declaration = pluginDeclaration_make(EVERY_TYPE, run);

  it('names its /bin entry and takes its input as CFS paths that glob', () => {
    expect(declaration.name).toBe('pl-every-v1.2.0');
    expect(declaration.grammar.operands).toEqual([expect.objectContaining({ name: 'input', kind: 'cfsPath', optional: true, repeat: true, glob: true })]);
    expect(declaration.help.category).toBe('Resources');
    expect(declaration.help.summary).toBe('Every type');
  });

  it('gives each parameter the kind of its type: a word, a number, a switch, a CFS path', () => {
    const options = declaration.grammar.options ?? {};
    expect(options['label']?.value?.kind).toBe('word');
    expect(options['threads']).toEqual(expect.objectContaining({ short: 't', long: 'threads', value: { name: 'threads', kind: 'int' } }));
    expect(options['threshold']?.value?.kind).toBe('number');
    expect(options['verbose']).toEqual(expect.objectContaining({ short: 'v', long: 'verbose' }));
    expect(options['verbose']?.value).toBeUndefined();
    expect(options['inputFile']?.value?.kind).toBe('cfsPath');
    expect(options['outputDir']?.value?.kind).toBe('cfsPath');
    expect(options['height']).toEqual(expect.objectContaining({ long: 'height', value: { name: 'height', kind: 'int' } }));
    expect(options['height']?.short).toBeUndefined();
  });

  it('says a parameter\'s default and whether a run needs it', () => {
    const options = declaration.grammar.options ?? {};
    expect(options['label']?.summary).toBe('A label (default T1)');
    expect(options['threshold']?.summary).toBe('The threshold (required)');
  });

  it('keeps the session\'s own options, which win a name a parameter also claims', () => {
    const options = declaration.grammar.options ?? {};
    expect(options['detach']?.summary).toContain('without waiting');
    expect(Object.keys(options)).toEqual(expect.arrayContaining(['parameters', 'readme', 'raw', 'help']));
    expect(commandUsage_render(declaration)).toContain('pl-every-v1.2.0 [-hv] [--detach] [--parameters] [--readme] [--raw] [--label <label>] [--threads <threads>]');
  });

  it('reads a line typed: each parameter by its flag name, its value of its kind; the run\'s context after a lone --', async () => {
    const parsed = await pluginWords_parse(declaration, ['~/uploads', '--threads', '4', '-v', '--label=T2', '--inputFile', 'a.nii', '--detach', '--', 'feed_title=Brain MRI']);
    expect(parsed).toEqual({
      ok: true,
      line: {
        operands: ['~/uploads'],
        parameters: { threads: 4, verbose: true, label: 'T2', inputFile: 'a.nii' },
        run: {},
        context: ['feed_title=Brain MRI'],
        detach: true,
        inspect: null,
      },
    });
    const look = await pluginWords_parse(declaration, ['--readme', '--raw']);
    expect(look.ok && look.line.inspect).toBe('readmeRaw');
  });

  it('refuses an unknown option, a value not of its kind and a value given a switch, before anything runs', async () => {
    const unknown = await pluginWords_parse(declaration, ['--nosuch', 'x']);
    expect(unknown).toEqual({ ok: false, refusal: expect.stringMatching(/^pl-every-v1\.2\.0: unrecognized option '--nosuch'; usage: pl-every-v1\.2\.0 /) });
    const notInt = await pluginWords_parse(declaration, ['--threads', 'two']);
    expect(!notInt.ok && notInt.refusal).toContain("invalid argument 'two' for '--threads'");
    const switchValue = await pluginWords_parse(declaration, ['--verbose=yes']);
    expect(!switchValue.ok && switchValue.refusal).toContain("option '--verbose' takes no value");
    expect(mockPluginRun).not.toHaveBeenCalled();
  });

  it('completes its options, the session\'s and the plugin\'s, and a path parameter\'s value as a path', async () => {
    expect(await declaredWord_complete(declaration, [], '--th')).toEqual(['--threads', '--threshold']);
    expect(await declaredWord_complete(declaration, [], '-')).toEqual(expect.arrayContaining(['-h', '-v', '-t', '--detach', '--label']));
  });

  it('takes the run\'s own fields CUBE reads beside the parameters: a title, the compute resource, the limits', () => {
    const options = declaration.grammar.options ?? {};
    expect(options['run.title']).toEqual(expect.objectContaining({ long: 'title', value: { name: 'title', kind: 'word' } }));
    expect(options['run.compute']).toEqual(expect.objectContaining({ long: 'compute', value: { name: 'resource', kind: 'compute' } }));
    expect(options['run.compute_resource_name']?.value?.kind).toBe('compute');
    expect(options['run.cpu_limit']?.value?.kind).toBe('cpu');
    expect(options['run.memory_limit']?.value?.kind).toBe('memory');
    expect(options['run.gpu_limit']?.value).toEqual(expect.objectContaining({ kind: 'int', min: 0 }));
    expect(options['run.number_of_workers']?.value).toEqual(expect.objectContaining({ kind: 'int', min: 1 }));
  });

  it('reads the run\'s fields apart from the parameters, by the field CUBE takes, each value of its kind', async () => {
    const parsed = await pluginWords_parse(declaration, [
      '--title', 'T1 run', '--compute', 'host', '--cpu_limit', '2000m', '--memory_limit', '8Gi', '--gpu_limit', '0', '--number_of_workers', '2', '--threads', '4',
    ]);
    expect(parsed.ok && parsed.line.run).toEqual({ title: 'T1 run', compute_resource_name: 'host', cpu_limit: '2000m', memory_limit: '8Gi', gpu_limit: 0, number_of_workers: 2 });
    expect(parsed.ok && parsed.line.parameters).toEqual({ threads: 4 });
    // A bare number is CUBE's own unit, posted as a number, as the line before declarations did.
    const bare = await pluginWords_parse(declaration, ['--cpu_limit', '1000', '--memory_limit', '512']);
    expect(bare.ok && bare.line.run).toEqual({ cpu_limit: 1000, memory_limit: 512 });
    // Both spellings of the compute resource: --compute_resource_name counts.
    const both = await pluginWords_parse(declaration, ['--compute_resource_name', 'gpu', '--compute', 'host']);
    expect(both.ok && both.line.run).toEqual({ compute_resource_name: 'gpu' });
  });

  it('refuses a run field\'s value not of its kind, before anything runs', async () => {
    for (const [option, value, said] of [
      ['--cpu_limit', 'x', 'millicores'], ['--cpu_limit', '2Gi', 'millicores'], ['--memory_limit', '8G', 'memory size'], ['--memory_limit', '0', 'memory size'],
      ['--number_of_workers', '0', 'at least 1'], ['--gpu_limit', 'one', 'not a whole number'],
    ] as const) {
      const refused = await pluginWords_parse(declaration, [option, value]);
      expect(!refused.ok && refused.refusal).toContain(`invalid argument '${value}' for '${option}'`);
      expect(!refused.ok && refused.refusal).toContain(said);
    }
    const noTitle = await pluginWords_parse(declaration, ['--title']);
    expect(!noTitle.ok && noTitle.refusal).toContain("option '--title' wants a value");
    expect(mockPluginRun).not.toHaveBeenCalled();
  });

  it('leaves a run field\'s name to a parameter that claims it, whose value goes to CUBE as the parameter', async () => {
    const clashing = pluginDeclaration_make({
      name: 'pl-titled', version: '1.0.0', kind: 'ds',
      parameters: [{ name: 'title', type: 'int', optional: true, help: 'A numbered title', flag: '--title' }, { name: 'compute', type: 'str', optional: true, flag: '--compute' }],
    }, run);
    const options = clashing.grammar.options ?? {};
    expect(options['title']?.value?.kind).toBe('int');
    expect(options['run.title']).toBeUndefined();
    expect(options['run.compute']).toBeUndefined();
    expect(options['run.compute_resource_name']?.long).toBe('compute_resource_name');
    const parsed = await pluginWords_parse(clashing, ['--title', '3', '--compute', 'x']);
    expect(parsed.ok && [parsed.line.parameters, parsed.line.run]).toEqual([{ title: 3, compute: 'x' }, {}]);
  });

  it('completes the run\'s fields among its options, and a compute resource by name', async () => {
    expect(await declaredWord_complete(declaration, [], '--ti')).toEqual(['--title']);
    expect(await declaredWord_complete(declaration, [], '--comp')).toEqual(['--compute', '--compute_resource_name']);
    expect(await declaredWord_complete(declaration, [], '--')).toEqual(expect.arrayContaining(['--cpu_limit', '--memory_limit', '--gpu_limit', '--number_of_workers']));
  });

  it('is described as a tool: its input and each parameter typed in JSON Schema', () => {
    const [tool] = commandTools_derive(declaration);
    expect(tool?.name).toBe('pl-every-v1.2.0');
    const properties = (tool?.inputSchema as { properties: Record<string, { type?: string; items?: { type?: string } }> }).properties;
    expect(properties['input']?.type).toBe('array');
    expect(properties['threads']?.type).toBe('integer');
    expect(properties['threshold']?.type).toBe('number');
    expect(properties['verbose']?.type).toBe('boolean');
    expect(properties['label']?.type).toBe('string');
  });
});

describe('a pipeline\'s declaration, from its manifest', () => {
  const declaration = pipelineDeclaration_make('Brain_segmentation_id12', PIPELINE as never, run);

  it('takes --<node>.<field> for every field of every node: a usable title and @<piping id>, never plugininstances', () => {
    const options: string[] = Object.keys(declaration.grammar.options ?? {});
    expect(options).toEqual(expect.arrayContaining([
      'segment.threshold', '@41.threshold', 'segment.normalize', 'segment.cpu_limit', 'segment.compute_resource_name', '@41.number_of_workers',
      '@42.smooth', '@42.memory_limit',
    ]));
    expect(options.some((option: string): boolean => option.includes('plugininstances'))).toBe(false);
    expect(options.some((option: string): boolean => option.startsWith('surface stage'))).toBe(false);
    expect(declaration.grammar.options?.['segment.normalize']?.value).toBeUndefined();
    expect(declaration.grammar.options?.['@42.smooth']?.value?.kind).toBe('int');
    expect(declaration.grammar.options?.['segment.compute_resource_name']?.value?.kind).toBe('compute');
    expect(declaration.grammar.options?.['segment.cpu_limit']?.value?.kind).toBe('cpu');
    expect(declaration.grammar.options?.['@42.memory_limit']?.value?.kind).toBe('memory');
  });

  it('reads a node\'s limits as CUBE takes them, and refuses one it would not', async () => {
    const parsed = await pipelineWords_parse(declaration, ['--segment.cpu_limit', '2000', '--@42.memory_limit', '8Gi']);
    expect(parsed.ok && parsed.line.bindings).toEqual([{ node: 'segment', field: 'cpu_limit', value: 2000 }, { node: '@42', field: 'memory_limit', value: '8Gi' }]);
    const refused = await pipelineWords_parse(declaration, ['--segment.memory_limit', 'lots']);
    expect(!refused.ok && refused.refusal).toContain("invalid argument 'lots' for '--segment.memory_limit'");
  });

  it('reads a line: its node overrides typed, its run options, or the look it asks for', async () => {
    const parsed = await pipelineWords_parse(declaration, ['--segment.threshold', '0.7', '--segment.normalize', '--@42.smooth=3', '--previous', '9', '--compute', 'gpu']);
    expect(parsed.ok && parsed.line).toEqual(expect.objectContaining({
      look: null, previous: 9, compute: 'gpu',
      bindings: [{ node: 'segment', field: 'threshold', value: 0.7 }, { node: 'segment', field: 'normalize', value: true }, { node: '@42', field: 'smooth', value: 3 }],
    }));
    const diagram = await pipelineWords_parse(declaration, ['--diagram', '--signalflow']);
    expect(diagram.ok && [diagram.line.look, diagram.line.signalflow]).toEqual(['diagram', true]);
  });

  it('refuses a node or field the manifest does not have', async () => {
    const refused = await pipelineWords_parse(declaration, ['--segment.nosuch', '1']);
    expect(!refused.ok && refused.refusal).toContain("Brain_segmentation_id12: unrecognized option '--segment.nosuch'");
  });
});

describe('the declaration of a word /bin answers', () => {
  it('is made from CUBE the first time and kept by its plugin and version: a new version is a new declaration', async () => {
    binListing = [{ name: 'pl-x-v1.0.0', type: 'plugin' }, { name: 'pl-x-v1.1.0', type: 'plugin' }];
    const bare = await binDeclaration_get('pl-x');
    expect(bare?.name).toBe('pl-x-v1.1.0');
    expect((await binDeclaration_get('pl-x-v1.1.0'))?.name).toBe('pl-x-v1.1.0');
    expect(mockPluginFind).toHaveBeenCalledTimes(1);
    expect(mockPluginFind).toHaveBeenCalledWith({}, 'pl-x', '1.1.0');
    expect((await binDeclaration_get('pl-x-v1.0.0'))?.name).toBe('pl-x-v1.0.0');
    expect(mockPluginFind).toHaveBeenCalledTimes(2);
    expect(bare?.grammar.options?.['threads']?.short).toBe('t');
  });

  it('runs a parsed line through the plugin run, typed', async () => {
    binListing = [{ name: 'pl-x-v1.0.0', type: 'plugin' }];
    const declaration = await binDeclaration_get('pl-x-v1.0.0');
    await declaration?.handler({ subcommand: null, operands: { input: ['~/a'] }, options: { threads: 2, detach: false }, expanded: { input: false } } as never);
    expect(mockPluginRun).toHaveBeenCalledWith('pl-x-v1.0.0', expect.objectContaining({ operands: ['~/a'], parameters: { threads: 2 } }));
    await declaration?.handler({ subcommand: null, operands: { input: [] }, options: { 'run.title': 'T', 'run.compute': 'host', detach: false }, expanded: { input: false } } as never);
    expect(mockPluginRun).toHaveBeenLastCalledWith('pl-x-v1.0.0', expect.objectContaining({ parameters: {}, run: { title: 'T', compute_resource_name: 'host' } }));
  });

  it('makes a pipeline\'s from its manifest, by its /bin name or its own, and names its node options for pipeline run', async () => {
    binListing = [{ name: 'Brain_segmentation_id12', type: 'pipeline', title: 'Brain segmentation' }];
    mockManifestGet.mockResolvedValue({ ok: true, value: PIPELINE });
    expect((await binDeclaration_get('Brain segmentation'))?.name).toBe('Brain_segmentation_id12');
    expect(await pipelineNodeOptions_list('Brain_segmentation_id12')).toContain('segment.threshold');
    expect(mockManifestGet).toHaveBeenCalledTimes(1);
  });

  it('is none for a word /bin does not list, or one CUBE cannot say', async () => {
    expect(await binDeclaration_get('frobnicate')).toBeNull();
    binListing = [{ name: 'pl-gone-v1.0.0', type: 'plugin' }];
    mockPluginFind.mockResolvedValueOnce(null as never);
    expect(await binDeclaration_get('pl-gone-v1.0.0')).toBeNull();
  });
});
