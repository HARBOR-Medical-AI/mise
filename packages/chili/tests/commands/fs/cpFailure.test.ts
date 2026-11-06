/**
 * @file files_cp: a dispatcher that throws is a failure on the error stack.
 */
import { files_cp } from '../../../src/commands/fs/cp';
import * as cumin from '@fnndsc/cumin';
import * as salsa from '@fnndsc/salsa';

jest.mock('@fnndsc/salsa', () => ({ vfsDispatcher: { cp: jest.fn() } }));
jest.mock('@fnndsc/cumin', () => ({ errorStack: { stack_push: jest.fn() } }));

describe('files_cp when the dispatcher throws', () => {
  it('pushes an Error\'s message, or the thrown value', async () => {
    (salsa.vfsDispatcher.cp as jest.Mock).mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce('odd');
    expect(await files_cp('/a', '/b', {})).toBe(false);
    expect(await files_cp('/a', '/b', {})).toBe(false);
    expect(cumin.errorStack.stack_push).toHaveBeenNthCalledWith(1, 'error', 'cp command failed: disk full');
    expect(cumin.errorStack.stack_push).toHaveBeenNthCalledWith(2, 'error', 'cp command failed: odd');
  });
});
