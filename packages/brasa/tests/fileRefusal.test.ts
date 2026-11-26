/**
 * @file A refused read names its status and reason from the kernel's own
 * notes, so the byte route and the surface can say why.
 */
import { describe, it, expect } from '@jest/globals';
import { FileReadRefusal } from '../src/core/fileRefusal.js';
import { fileRefusal_name } from '../src/chris/files.js';

const note = (fn: string, message: string): string => `[${fn.padEnd(40)}] | ${message}`;

describe('fileRefusal_name', () => {
  it('reads a 403 from CUBE as not yours to read', () => {
    const refusal: FileReadRefusal = fileRefusal_name('/home/x/f.dcm', [note('file_download', 'File ID 12: CUBE refused access (403). It is listed but not readable by this identity — a feed shared with you grants the listing, not the contents.')]);
    expect(refusal.status).toBe(403);
    expect(refusal.reason).toBe('not yours to read: CUBE refused the bytes (403)');
    expect(refusal.message).toBe('cannot read /home/x/f.dcm: not yours to read: CUBE refused the bytes (403)');
  });

  it('reads a file the lookup could not find, or CUBE 404, as no such file', () => {
    expect(fileRefusal_name('/a', [note('pathFileId_resolve', 'File not found: f.dcm in /a')]).status).toBe(404);
    expect(fileRefusal_name('/a', [note('pathFileId_resolve', 'No files found in directory: /a')]).reason).toBe('no such file in CUBE (404)');
    expect(fileRefusal_name('/a', [note('file_download', 'File ID 9 does not exist (404).')]).status).toBe(404);
  });

  it('reads a CUBE failure as 502 with the status it answered, never as 404', () => {
    const refusal: FileReadRefusal = fileRefusal_name('/a', [note('file_download', 'File ID 9 could not be read: CUBE answered 500.')]);
    expect(refusal.status).toBe(502);
    expect(refusal.reason).toBe('CUBE could not serve it (500)');
  });

  it('lets a status CUBE gave decide before any words: a 5xx that says "not found" is an outage, not an absence', () => {
    const refusal: FileReadRefusal = fileRefusal_name('/a', [note('file_download', 'File ID 9 could not be read: CUBE answered 503.'), note('pathFileId_resolve', 'File not found: f.dcm in /a')]);
    expect(refusal.status).toBe(502);
    expect(refusal.reason).toBe('CUBE could not serve it (503)');
    expect(fileRefusal_name('/a', [note('folderIds_list', 'No files found in directory: /a (CUBE answered 502)')]).status).toBe(502);
  });

  it('passes the kernel\'s own last note through, stripped of its function tag, when no status is known', () => {
    const refusal: FileReadRefusal = fileRefusal_name('/a', [note('x', 'first'), note('file_download', 'File ID 9 is not in the file collections this client can read.')]);
    expect(refusal.status).toBe(502);
    expect(refusal.reason).toBe('File ID 9 is not in the file collections this client can read.');
    expect(fileRefusal_name('/a', []).reason).toBe('could not be read');
  });
});
