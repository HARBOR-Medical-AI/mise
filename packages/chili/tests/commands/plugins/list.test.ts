import { plugins_fetchList } from '../../../src/commands/plugins/list';
import * as salsa from '@fnndsc/salsa';
import { FilteredResourceData } from '@fnndsc/cumin';

jest.mock('@fnndsc/salsa');

describe('commands/plugins/list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call salsa.plugins_list with correct options', async () => {
    (salsa.plugins_list as jest.Mock).mockResolvedValue({
      tableData: [{ id: 1, name: 'pl-test' }],
      selectedFields: ['id', 'name']
    });

    const options = { page: '5', search: 'name:test' };
    const result = await plugins_fetchList(options);

    expect(salsa.plugins_list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 5,
      offset: 0,
      name: 'test'
    }));
    expect(result).toEqual({ plugins: [{ id: 1, name: 'pl-test' }], selectedFields: ['id', 'name'] });
  });

  it('should return empty result if salsa.plugins_list returns no data', async () => {
    (salsa.plugins_list as jest.Mock).mockResolvedValue({ tableData: [], selectedFields: [] });

    const options = {};
    const result = await plugins_fetchList(options);

    expect(result).toEqual({ plugins: [], selectedFields: [] });
  });

  it('lists every plugin with --all, sorted, and reports the total', async () => {
    (salsa.plugins_listAll as jest.Mock).mockResolvedValue({
      tableData: [{ id: 1, name: 'pl-b' }, { id: 2, name: 'pl-a' }],
      totalCount: 2,
    });
    const result = await plugins_fetchList({ all: true, sort: 'name', reverse: true });
    expect(salsa.plugins_listAll).toHaveBeenCalled();
    expect(result.plugins.map((p) => p.name)).toEqual(['pl-b', 'pl-a']);
    expect(result.selectedFields).toEqual([]);
    expect(result.totalCount).toBe(2);
  });

  it('returns nothing when salsa answers with nothing', async () => {
    (salsa.plugins_list as jest.Mock).mockResolvedValue(null);
    expect(await plugins_fetchList({})).toEqual({ plugins: [], selectedFields: [] });
  });
});
