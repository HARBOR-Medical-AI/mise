/**
 * @file Tests for pipeline listing, resolution and workflow creation.
 *
 * The connection is mocked at the client boundary. List responses are built
 * on ListResource.prototype so the real resource spine (instanceof guard,
 * collection walking, field filtering) runs against fixtures.
 */

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));

import { ListResource } from '@fnndsc/chrisapi';
import { chrisConnection } from '../src/connect/chrisConnection';
import {
  pipelines_list,
  pipeline_resolve,
  pipeline_createWorkflow,
  PipelineRecord,
  WorkflowResult,
} from '../src/pipelines/chrisPipeline';
import { errorStack } from '../src/error/errorStack';
import { pipelineResource_recall } from '../src/pipelines/pipelineMemo';
import { Result } from '../src/utils/result';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;

/**
 * Builds a collection+json list response on ListResource.prototype so the
 * spine's instanceof narrowing accepts it.
 */
function listResource_make(rows: Array<Record<string, unknown>>): ListResource {
  const list: ListResource = Object.create(ListResource.prototype) as ListResource;
  // Own value properties shadow the prototype's getter-only accessors.
  Object.defineProperties(list, {
    collection: {
      value: {
        items: rows.map((row: Record<string, unknown>) => ({
          data: Object.entries(row).map(([name, value]: [string, unknown]) => ({ name, value })),
          href: `https://cube/api/v1/pipelines/${String(row.id)}/`,
          links: [],
        })),
      },
    },
    // Each served item carries its row, as chrisapi's do.
    getItems: { value: (): unknown[] => rows.map((row: Record<string, unknown>) => ({ data: row })), configurable: true },
    totalCount: { value: rows.length },
    hasNext: { value: false },
  });
  return list;
}

let pushSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  pushSpy = jest.spyOn(errorStack, 'stack_push').mockImplementation(() => undefined);
});
afterEach(() => {
  pushSpy.mockRestore();
});

describe('pipelines_list', () => {
  it('lists pipelines through the real resource spine', async () => {
    mockClientGet.mockResolvedValue({
      getPipelines: jest.fn(async () => listResource_make([
        { id: 1, name: 'Brain Analysis', category: 'MRI' },
        { id: 2, name: 'Hip Screening', category: 'US' },
      ])),
    });
    const result: Result<PipelineRecord[]> = await pipelines_list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].name).toBe('Brain Analysis');
    }
  });

  it('returns an empty list when nothing matches', async () => {
    mockClientGet.mockResolvedValue({ getPipelines: jest.fn(async () => listResource_make([])) });
    const result: Result<PipelineRecord[]> = await pipelines_list('nope');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('errors when the fetch throws', async () => {
    mockClientGet.mockResolvedValue({
      getPipelines: jest.fn(async () => { throw new Error('502'); }),
    });
    expect((await pipelines_list()).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('502'));
  });
});

describe('pipeline_resolve', () => {
  it('resolves a numeric id directly', async () => {
    mockClientGet.mockResolvedValue({
      getPipeline: jest.fn(async () => ({ data: { id: 9, name: 'Direct' } })),
    });
    const result: Result<PipelineRecord> = await pipeline_resolve('9');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Direct');
  });

  it('errors on a numeric id whose response has no data', async () => {
    mockClientGet.mockResolvedValue({ getPipeline: jest.fn(async () => ({})) });
    expect((await pipeline_resolve('9')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('not found'));
  });

  it('errors on a numeric id when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await pipeline_resolve('9')).ok).toBe(false);
  });

  it('resolves an exact name match', async () => {
    mockClientGet.mockResolvedValue({
      getPipelines: jest.fn(async () => listResource_make([
        { id: 1, name: 'Foo' },
        { id: 2, name: 'Foo extended' },
      ])),
    });
    const result: Result<PipelineRecord> = await pipeline_resolve('Foo');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Foo');
  });

  it('searches a numeric-leading name instead of treating it as an ID', async () => {
    const getPipeline: jest.Mock = jest.fn();
    mockClientGet.mockResolvedValue({
      getPipeline,
      getPipelines: jest.fn(async () => listResource_make([
        { id: 3, name: '3D segmentation' },
      ])),
    });

    const result: Result<PipelineRecord> = await pipeline_resolve('3D segmentation');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(3);
    expect(getPipeline).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous name', async () => {
    mockClientGet.mockResolvedValue({
      getPipelines: jest.fn(async () => listResource_make([
        { id: 1, name: 'Foo one' },
        { id: 2, name: 'Foo two' },
      ])),
    });
    expect((await pipeline_resolve('Foo')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Ambiguous'));
  });

  it('falls back to the id-suffix slug when the list is empty', async () => {
    mockClientGet.mockResolvedValue({
      getPipelines: jest.fn(async () => listResource_make([])),
      getPipeline: jest.fn(async () => ({ data: { id: 7, name: 'MyPipe' } })),
      getPipelineSourceFiles: jest.fn(async () => ({ getItems: (): unknown[] => [] })),
    });
    const result: Result<PipelineRecord> = await pipeline_resolve('mypipe_id7');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(7);
  });

  it('falls back to the source-file slug lookup', async () => {
    const getPipelines = jest.fn(async (params: { name?: string }) =>
      params.name === 'PHI Pipeline'
        ? listResource_make([{ id: 3, name: 'PHI Pipeline' }])
        : listResource_make([]),
    );
    mockClientGet.mockResolvedValue({
      getPipelines,
      getPipelineSourceFiles: jest.fn(async () => ({
        getItems: (): unknown[] => [
          { data: { fname: 'PIPELINES/u/PHI_detection.yml', pipeline_name: 'PHI Pipeline' } },
        ],
      })),
    });
    const result: Result<PipelineRecord> = await pipeline_resolve('PHI_detection');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('PHI Pipeline');
  });

  it('errors when nothing matches at all', async () => {
    mockClientGet.mockResolvedValue({
      getPipelines: jest.fn(async () => listResource_make([])),
      getPipelineSourceFiles: jest.fn(async () => ({ getItems: (): unknown[] => [] })),
    });
    expect((await pipeline_resolve('ghost')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining("No pipeline matching 'ghost'"));
  });


  it('refuses a search whose second row is malformed, by its place, and keeps none of it', async () => {
    const client = {
      getPipelines: jest.fn(async () => {
        const list: ListResource = listResource_make([{ id: 41, name: 'Foo' }, { id: 'forty-two', name: 'Foo two' }]);
        Object.defineProperty(list, 'getItems', { value: (): unknown[] => [{ data: { id: 41, name: 'Foo' } }, { data: { id: 'forty-two' } }] });
        return list;
      }),
    };
    mockClientGet.mockResolvedValue(client);
    const result: Result<PipelineRecord> = await pipeline_resolve('Foo');
    expect(result.ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringMatching(/^pipelines_list: CUBE answered a list of a pipeline whose \S*\[1\]\S*id is a string, where a number is read$/));
    // The first row was good, and still nothing of the page went into the memo.
    expect(pipelineResource_recall(client, 41)).toBeNull();
  });

  it('refuses a search whose served items are not a list, and keeps none of it', async () => {
    const client = {
      getPipelines: jest.fn(async () => {
        const list: ListResource = listResource_make([{ id: 43, name: 'Bar' }]);
        Object.defineProperty(list, 'getItems', { value: (): unknown => ({ not: 'a list' }) });
        return list;
      }),
    };
    mockClientGet.mockResolvedValue(client);
    expect((await pipeline_resolve('Bar')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('pipelines_list: CUBE answered'));
    expect(pipelineResource_recall(client, 43)).toBeNull();
  });

  it('refuses a search whose rows hold and whose served item is not a pipeline, and keeps none of it', async () => {
    const client = {
      getPipelines: jest.fn(async () => {
        const list: ListResource = listResource_make([{ id: 45, name: 'Qux' }]);
        Object.defineProperty(list, 'getItems', { value: (): unknown[] => [{ data: { id: 45, name: 4500 } }] });
        return list;
      }),
    };
    mockClientGet.mockResolvedValue(client);
    expect((await pipeline_resolve('Qux')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('name is a number, where a string is read'));
    expect(pipelineResource_recall(client, 45)).toBeNull();
  });

  it('refuses a search that served an item with nothing in it, at its place, and keeps none of it', async () => {
    const client = {
      getPipelines: jest.fn(async () => {
        const list: ListResource = listResource_make([{ id: 46, name: 'Quux' }, { id: 47, name: 'Quux two' }]);
        Object.defineProperty(list, 'getItems', { value: (): unknown[] => [{ data: { id: 46, name: 'Quux' } }, {}] });
        return list;
      }),
    };
    mockClientGet.mockResolvedValue(client);
    expect((await pipeline_resolve('Quux')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', 'pipelines_list: CUBE answered a list of a pipeline whose items[1].data is missing, where an object is read');
    expect(pipelineResource_recall(client, 46)).toBeNull();
    // Nothing of the failed answer is remembered: the next ask reads CUBE again, and a good answer is taken.
    client.getPipelines.mockImplementation(async () => listResource_make([{ id: 46, name: 'Quux' }]));
    expect((await pipeline_resolve('Quux')).ok).toBe(true);
    expect(client.getPipelines).toHaveBeenCalledTimes(2);
  });

  it('refuses a pipeline read by id, or by a slug that names an id, that is another pipeline\'s, and keeps nothing', async () => {
    const getPipeline = jest.fn(async () => ({ data: { id: 20, name: 'Twenty' } }));
    const client = { getPipeline, getPipelines: jest.fn(async () => listResource_make([])), getPipelineSourceFiles: jest.fn(async () => ({ getItems: (): unknown[] => [] })) };
    mockClientGet.mockResolvedValue(client);
    expect((await pipeline_resolve('19')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining("whose data.id is another pipeline's, where pipeline 19's is read"));
    expect((await pipeline_resolve('thing_id19')).ok).toBe(false);
    expect(pipelineResource_recall(client, 19)).toBeNull();
    expect(pipelineResource_recall(client, 20)).toBeNull();
    // Corrected, the answer is taken and then kept: asked for once more, and not again.
    getPipeline.mockImplementation(async () => ({ data: { id: 19, name: 'Nineteen' } }));
    const before: number = getPipeline.mock.calls.length;
    const again: Result<PipelineRecord> = await pipeline_resolve('19');
    expect(again.ok && again.value.name).toBe('Nineteen');
    expect((await pipeline_resolve('19')).ok).toBe(true);
    expect(getPipeline.mock.calls.length).toBe(before + 1);
    expect(pipelineResource_recall(client, 19)).not.toBeNull();
  });

  it('keeps the items of a search that holds, so the good path is unchanged', async () => {
    const client = {
      getPipelines: jest.fn(async () => {
        const list: ListResource = listResource_make([{ id: 44, name: 'Baz' }]);
        Object.defineProperty(list, 'getItems', { value: (): unknown[] => [{ data: { id: 44, name: 'Baz' } }] });
        return list;
      }),
    };
    mockClientGet.mockResolvedValue(client);
    expect((await pipeline_resolve('Baz')).ok).toBe(true);
    expect(pipelineResource_recall(client, 44)).not.toBeNull();
  });
});

describe('pipeline_createWorkflow', () => {
  const workflowResponse = {
    data: { id: 55 },
    getPluginInstances: jest.fn(async () => ({
      getItems: (): unknown[] => [{ data: { id: 101 } }, { data: { id: 102 } }],
    })),
  };

  it('creates a workflow with explicit node overrides', async () => {
    const createWorkflow = jest.fn(async () => workflowResponse);
    mockClientGet.mockResolvedValue({ createWorkflow });
    const result: Result<WorkflowResult> = await pipeline_createWorkflow(4, {
      previousPluginInstId: 20,
      nodeOverrides: [{ piping_id: 1, compute_resource_name: 'gpu' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ workflowId: 55, pluginInstanceIds: [101, 102] });
    expect(createWorkflow).toHaveBeenCalledWith(4, {
      previous_plugin_inst_id: 20,
      nodes_info: JSON.stringify([{ piping_id: 1, compute_resource_name: 'gpu' }]),
    });
  });

  it('derives default nodes from the pipeline pipings when no overrides are given', async () => {
    const createWorkflow = jest.fn(async () => workflowResponse);
    mockClientGet.mockResolvedValue({
      createWorkflow,
      getPipeline: jest.fn(async () => ({
        data: { id: 4 },
        getPluginPipings: jest.fn(async () => ({
          getItems: (): unknown[] => [{ data: { id: 31 } }, { data: { id: 32 } }],
        })),
      })),
    });
    const result: Result<WorkflowResult> = await pipeline_createWorkflow(4, { previousPluginInstId: 20 });
    expect(result.ok).toBe(true);
    expect(createWorkflow).toHaveBeenCalledWith(4, {
      previous_plugin_inst_id: 20,
      nodes_info: JSON.stringify([{ piping_id: 31 }, { piping_id: 32 }]),
    });
  });

  it('errors when the pipeline for default nodes is missing', async () => {
    mockClientGet.mockResolvedValue({ getPipeline: jest.fn(async () => null) });
    expect((await pipeline_createWorkflow(4, { previousPluginInstId: 20 })).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Pipeline 4 not found'));
  });

  it('errors when createWorkflow returns nothing', async () => {
    mockClientGet.mockResolvedValue({ createWorkflow: jest.fn(async () => null) });
    expect((await pipeline_createWorkflow(4, {
      previousPluginInstId: 20,
      nodeOverrides: [{ piping_id: 1 }],
    })).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('empty response'));
  });

  it('errors when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await pipeline_createWorkflow(4, { previousPluginInstId: 20 })).ok).toBe(false);
  });
});
