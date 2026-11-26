/**
 * @file A content write is routed by one name, however the path is spelt.
 *
 * The session's dispatcher and its mounts are real, so whether a path is a
 * projection's is decided as it is in a session. cumin's file calls are
 * stand-ins that only record: a projected target must reach none of them.
 */
const mockIO = {
  file_upload: jest.fn(async (): Promise<boolean> => true),
  file_uploadReceipted: jest.fn(),
  file_moveById: jest.fn(),
  file_deleteById: jest.fn(),
  file_locate: jest.fn(),
};
const mockObjCreate = jest.fn();

jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  objContext_create: mockObjCreate,
  chrisContext: { current_get: jest.fn() },
  chrisIO: mockIO,
}));

import { files_touch } from '../src/files/index';
import { vfsDispatcher } from '../src/vfs/dispatcher';

const PROJECTED: string = '/proc/jobs/7/note';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('a content write to a projection\'s file', () => {
  it.each([PROJECTED, 'proc/jobs/7/note', './proc/jobs/7/note', '/proc//jobs/./7/note'])('written as %s goes to the projection, by its name from the root, and nothing is uploaded', async (spelling: string) => {
    const write = jest.spyOn(vfsDispatcher, 'write').mockResolvedValue({ ok: true } as never);
    await files_touch(spelling, 'a note');
    expect(write).toHaveBeenCalledWith(PROJECTED, 'a note');
    expect(mockIO.file_upload).not.toHaveBeenCalled();
    expect(mockIO.file_uploadReceipted).not.toHaveBeenCalled();
    expect(mockObjCreate).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
