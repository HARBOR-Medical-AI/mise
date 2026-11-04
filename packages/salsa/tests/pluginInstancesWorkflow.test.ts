/**
 * @file `workflowJobs_get`: one pipeline run's jobs and feeds, walked page by page from CUBE (#1364).
 */
const mockClientGet = jest.fn();
const mockPage = jest.fn();
jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  chrisConnection: { client_get: mockClientGet },
  pluginInstancesPage_get: (...args: unknown[]) => mockPage(...args),
}));

import { workflowJobs_get, pluginInstances_listAll, pluginInstanceFields_get } from '../src/plugininstances/index';

beforeEach(() => { jest.clearAllMocks(); });

describe('workflowJobs_get', () => {
  it('walks the run\'s instances page by page, naming each feed and job once', async () => {
    mockClientGet.mockResolvedValue({});
    const firstPage = Array.from({ length: 100 }, (_, index: number) => ({ id: index + 1, feed_id: index < 50 ? 7 : 8 }));
    mockPage
      .mockResolvedValueOnce({ data: firstPage, totalCount: 101 })
      .mockResolvedValueOnce({ data: [{ id: 101, feed_id: 8 }, { id: 101, feed_id: 8 }], totalCount: 101 });
    const run = await workflowJobs_get(126536);
    expect(run.feeds).toEqual([7, 8]);
    expect(run.jobs).toHaveLength(101);
    expect(run.jobs[0]).toBe(1);
    expect(run.jobs[100]).toBe(101);
    expect(mockPage).toHaveBeenCalledTimes(2);
    expect(mockPage).toHaveBeenNthCalledWith(1, {}, { workflow_id: 126536, limit: 100, offset: 0 });
    expect(mockPage).toHaveBeenNthCalledWith(2, {}, { workflow_id: 126536, limit: 100, offset: 100 });
  });

  it('answers nothing when not connected, and skips rows with no feed', async () => {
    mockClientGet.mockResolvedValueOnce(null);
    expect(await workflowJobs_get(1)).toEqual({ feeds: [], jobs: [] });
    mockClientGet.mockResolvedValue({});
    mockPage.mockResolvedValueOnce({ data: [{ id: 5 }, { id: 'x', feed_id: 9 }], totalCount: 2 });
    expect(await workflowJobs_get(2)).toEqual({ feeds: [9], jobs: [5] });
  });
});

describe('the plugin instance listing', () => {
  it('lists through the resource group, and answers no fields without a group answer', async () => {
    const resourcesGetAll = jest.fn().mockResolvedValue({ items: [] });
    const resourceFieldsGet = jest.fn().mockResolvedValue(null);
    const cumin = jest.requireMock('@fnndsc/cumin') as { ChRISPluginInstanceGroup: unknown };
    const Group = jest.fn().mockImplementation(() => ({ asset: { resources_getAll: resourcesGetAll, resourceFields_get: resourceFieldsGet } }));
    cumin.ChRISPluginInstanceGroup = Group;
    expect(await pluginInstances_listAll({ limit: 1 })).toEqual({ items: [] });
    expect(resourcesGetAll).toHaveBeenCalledWith({ limit: 1 });
    expect(await pluginInstanceFields_get()).toBeNull();
  });
});
