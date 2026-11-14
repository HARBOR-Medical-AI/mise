import { files_touch } from '../../../src/commands/fs/touch';
import { files_touch as salsaFiles_touch } from '@fnndsc/salsa';
import * as salsa from '@fnndsc/salsa';

jest.mock('@fnndsc/salsa');
// The link walk lives in salsa: here it leaves every path where it stands.
(salsa.logicalPath_resolve as jest.Mock).mockImplementation(async (p: string) => ({ ok: true, value: p }));

describe('fs touch command', () => {
  it('should call salsa files_touch', async () => {
    (salsaFiles_touch as jest.Mock).mockResolvedValue(true);
    const result = await files_touch('/some/path');
    expect(salsaFiles_touch).toHaveBeenCalledWith('/some/path');
    expect(result).toBe(true);
  });
});
