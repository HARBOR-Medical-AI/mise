import { files_mkdir } from '../../../src/commands/fs/mkdir';
import { files_mkdir as salsaFiles_mkdir } from '@fnndsc/salsa';
import * as salsa from '@fnndsc/salsa';

jest.mock('@fnndsc/salsa');
// The link walk lives in salsa: here it leaves every path where it stands.
(salsa.logicalPath_resolve as jest.Mock).mockImplementation(async (p: string) => ({ ok: true, value: p }));

describe('fs mkdir command', () => {
  it('should call salsa files_mkdir', async () => {
    (salsaFiles_mkdir as jest.Mock).mockResolvedValue(true);
    const result = await files_mkdir('/some/path');
    expect(salsaFiles_mkdir).toHaveBeenCalledWith('/some/path');
    expect(result).toBe(true);
  });
});
