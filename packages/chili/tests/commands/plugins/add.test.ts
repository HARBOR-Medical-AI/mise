/**
 * @file Tests for `chili plugins add`: the words go to salsa, its lines come back.
 */
import { plugin_add } from '../../../src/commands/plugins/add.js';
import * as salsa from '@fnndsc/salsa';
import * as output from '../../../src/screen/output.js';

jest.mock('@fnndsc/salsa', () => ({ plugin_add: jest.fn() }));
jest.mock('../../../src/screen/output.js', () => ({ chiliLog: jest.fn(), chiliErrLog: jest.fn() }));

describe('plugin_add', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hands the options to salsa and returns its outcome', async () => {
    (salsa.plugin_add as jest.Mock).mockResolvedValue({ outcome: 'installed' });
    const outcome = await plugin_add('pl-x', { compute: 'host', store: 's', adminUser: 'u', adminPassword: 'p', public_repo: 'r' });
    expect(outcome).toBe('installed');
    expect(salsa.plugin_add).toHaveBeenCalledWith('pl-x', { compute: 'host', store: 's', adminUser: 'u', adminPassword: 'p', publicRepo: 'r' }, output.chiliLog);
  });

  it('prints salsa\'s reason on a failure', async () => {
    (salsa.plugin_add as jest.Mock).mockResolvedValueOnce({ outcome: 'failed', reason: 'no docker' }).mockResolvedValueOnce({ outcome: 'failed' });
    expect(await plugin_add('pl-x', {})).toBe('failed');
    expect(output.chiliErrLog).toHaveBeenCalledWith('no docker');
    await plugin_add('pl-x', {});
    expect(output.chiliErrLog).toHaveBeenCalledTimes(1);
  });
});
