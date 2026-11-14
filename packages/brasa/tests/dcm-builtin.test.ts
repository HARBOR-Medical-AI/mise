/**
 * `dcm series` and `dcm tags`: the kernel's DICOM answers rendered as text
 * and carried as models. salsa's parser is mocked; what is under test is the
 * command's grammar, its path handling, the sampling cap, the honesty of the
 * rendered text (read of how many, refused, hidden, shortened) and the
 * models it carries.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { chrisHelp_install } from './support/chrisHelp.js';

chrisHelp_install();
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';

const mockSeries = jest.fn();
const mockFolderList = jest.fn();
const mockHeaderGet = jest.fn();
const mockSummarize = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', folder: '/home/chris' })),
  dicomSeries_summarize: mockSeries,
  dicomFolder_list: mockFolderList,
  dicomHeader_get: mockHeaderGet,
  dicomTags_summarize: mockSummarize,
  dicomFiles_sample: <T>(files: T[], cap: number): T[] => (files.length <= cap ? files : [files[0], files[files.length - 1]]),
}));
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown): CommandEnvelope => (model === undefined ? { status: 'ok', rendered } : ({ status: 'ok', rendered, model } as CommandEnvelope)),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string): CommandEnvelope => {
    const envelope: CommandEnvelope = { status: 'error', rendered };
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: jest.fn(async () => '/home/chris/feeds/feed_1/pl-dircopy_2/data') },
}));

const { builtin_dcm, bytes_format, DCM_TAGS_FILE_CAP } = await import('../src/builtins/res/dicom.js');

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

function tag_make(name: string, value: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag: '(0008,0060)', name, vr: 'CS', value, group: 'series', phi: false, ...extra };
}

const seriesSummary = {
  path: '/SERVICES/PACS/X/p/s/00005-T1-abcdef0',
  seriesInstanceUID: '1.2.3',
  studyInstanceUID: '1.2',
  modality: 'MR',
  seriesDescription: 'T1',
  seriesNumber: 5,
  instances: 16,
  frames: 1,
  order: 'filename',
  geometry: { rows: 256, columns: 256, pixelSpacing: [0.9, 0.9], sliceThickness: 1.5 },
  transferSyntax: { uid: '1.2.840.10008.1.2.1', name: 'Explicit VR Little Endian' },
  bytes: 2_500_000,
  header: '/SERVICES/PACS/X/p/s/00005-T1-abcdef0/0001-1.2.3.1.dcm',
  files: ['/SERVICES/PACS/X/p/s/00005-T1-abcdef0/0001-1.2.3.1.dcm'],
  annotations: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
});

describe('builtin_dcm grammar', () => {
  it('returns help for --help', async () => {
    const envelope: CommandEnvelope = await builtin_dcm(['--help']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('USAGE');
  });

  it('refuses a missing or unknown subcommand by name with the usage line', async () => {
    const none: CommandEnvelope = await builtin_dcm([]);
    expect(none.status).toBe('error');
    expect(none.renderedErr).toContain('a subcommand is required');
    const unknown: CommandEnvelope = await builtin_dcm(['view', 'x']);
    expect(unknown.renderedErr).toContain("unknown subcommand 'view'");
    expect(unknown.renderedErr).toContain('Usage: dcm series');
    expect(process.exitCode).toBe(1);
  });

  it('requires a path for each subcommand', async () => {
    expect((await builtin_dcm(['series'])).renderedErr).toContain('a folder is required');
    expect((await builtin_dcm(['tags'])).renderedErr).toContain('a file or folder is required');
  });
});

describe('dcm series, stopped', () => {
  it('ends after the read in flight and answers no model', async () => {
    const { commandCancellation_run, commandCancellation_abort } = await import('../src/core/cancellation.js');
    mockSeries.mockImplementation(async () => {
      commandCancellation_abort('line-stop');
      return ok(seriesSummary);
    });
    const envelope: CommandEnvelope = await commandCancellation_run((): Promise<CommandEnvelope> => builtin_dcm(['series', '.']), 'line-stop');
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toBe('dcm series: stopped\n');
    expect(envelope.model).toBeUndefined();
  });
});

describe('dcm series', () => {
  it('resolves the folder against the cwd, looks for annotations under the user home, and carries the model', async () => {
    mockSeries.mockResolvedValue(ok(seriesSummary));
    const envelope: CommandEnvelope = await builtin_dcm(['series', '.']);
    expect(mockSeries).toHaveBeenCalledWith('/home/chris/feeds/feed_1/pl-dircopy_2/data', { annotationRoot: '/home/chris/annotations' });
    expect(envelope.status).toBe('ok');
    expect(envelope.model).toEqual({ kind: 'dicom.series', data: seriesSummary });
    expect(envelope.rendered).toContain('SERIES');
    expect(envelope.rendered).toContain('1.2.3');
    expect(envelope.rendered).toContain('MR');
    expect(envelope.rendered).toContain('16');
    expect(envelope.rendered).toContain('order: filename');
    expect(envelope.rendered).toContain('256 x 256, 0.9 x 0.9 mm, 1.5 mm thick');
    expect(envelope.rendered).toContain('Explicit VR Little Endian');
    expect(envelope.rendered).toContain('2.4 MB');
    expect(envelope.rendered).toContain('none');
  });

  it('names annotations, frames, and an unknown transfer syntax by its UID', async () => {
    mockSeries.mockResolvedValue(
      ok({
        ...seriesSummary,
        frames: 40,
        seriesInstanceUID: undefined,
        studyInstanceUID: undefined,
        seriesNumber: undefined,
        seriesDescription: '',
        geometry: undefined,
        transferSyntax: { uid: '1.2.3.4.5' },
        annotations: ['/home/chris/annotations/1.2.3/measurements.dcm', '/home/chris/annotations/1.2.3/seg.dcm'],
      }),
    );
    const envelope: CommandEnvelope = await builtin_dcm(['series', '/x']);
    expect(envelope.rendered).toContain('40 frames each');
    expect(envelope.rendered).toContain('unknown 1.2.3.4.5');
    expect(envelope.rendered).toContain('measurements.dcm');
    expect(envelope.rendered).toContain('seg.dcm');
    expect(envelope.rendered).not.toContain('GEOMETRY');
  });

  it('fails by name when the folder is not a readable series', async () => {
    mockSeries.mockResolvedValue(err());
    const envelope: CommandEnvelope = await builtin_dcm(['series', '/nope']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('/nope: not a readable DICOM folder');
    expect(process.exitCode).toBe(1);
  });
});

describe('dcm tags on a file', () => {
  const tags = [
    tag_make('PatientName', 'SYNTH^ONE', { tag: '(0010,0010)', vr: 'PN', group: 'patient', phi: true }),
    tag_make('Modality', 'MR', { decoded: 'Magnetic Resonance' }),
    tag_make('TransferSyntaxUID', '1.2.840.10008.1.2.1', { tag: '(0002,0010)', vr: 'UI', group: 'meta' }),
    tag_make('PrivateTag', 'vendor', { tag: '(0009,1001)', vr: 'LO', group: 'private' }),
    tag_make('ReferencedImageSequence', '1 item', {
      tag: '(0008,1140)',
      vr: 'SQ',
      group: 'image',
      items: [[tag_make('ReferencedSOPClassUID', '1.2', { tag: '(0008,1150)', vr: 'UI', group: 'image' })]],
    }),
    tag_make('ImageComments', 'x'.repeat(100), { tag: '(0020,4000)', vr: 'LT', group: 'image' }),
  ];

  it('reads one header, groups by module, marks PHI, shows decoded words and nested items, hides meta and private', async () => {
    mockHeaderGet.mockResolvedValue(ok({ tags, transferSyntaxUID: '1.2.840.10008.1.2.1' }));
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm']);
    expect(mockHeaderGet).toHaveBeenCalledWith('/s/0001-x.dcm');
    expect(mockFolderList).not.toHaveBeenCalled();
    expect(envelope.rendered).toContain('PATIENT');
    expect(envelope.rendered).toContain('PHI');
    expect(envelope.rendered).toContain('Magnetic Resonance');
    expect(envelope.rendered).toContain('item 1');
    expect(envelope.rendered).toContain('ReferencedSOPClassUID');
    expect(envelope.rendered).not.toContain('TransferSyntaxUID');
    expect(envelope.rendered).not.toContain('vendor');
    expect(envelope.rendered).toContain('2 meta/private tags hidden; --all shows them');
    expect(envelope.model).toMatchObject({ kind: 'dicom.tags', data: { path: '/s/0001-x.dcm', subject: 'file', read: 1, of: 1, refused: [], varying: [] } });
  });

  it('shortens a long value on screen and says by how much, while the model keeps it whole', async () => {
    mockHeaderGet.mockResolvedValue(ok({ tags }));
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm']);
    expect(envelope.rendered).toContain('… (+36)');
    const model = envelope.model?.data as { constant: Array<{ name: string; value: string }> };
    expect(model.constant.find((tag): boolean => tag.name === 'ImageComments')?.value).toHaveLength(100);
  });

  it('shows meta and private with --all', async () => {
    mockHeaderGet.mockResolvedValue(ok({ tags }));
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm', '--all']);
    expect(envelope.rendered).toContain('TransferSyntaxUID');
    expect(envelope.rendered).toContain('vendor');
    expect(envelope.rendered).not.toContain('hidden');
  });

  it('narrows to tags matching --filter by tag, name, value or decoding, and says when nothing matches', async () => {
    mockHeaderGet.mockResolvedValue(ok({ tags }));
    const byDecoded: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm', '--filter', 'magnetic']);
    expect(byDecoded.rendered).toContain('Modality');
    expect(byDecoded.rendered).not.toContain('PatientName');
    const byTag: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm', '--filter', '0010,0010']);
    expect(byTag.rendered).toContain('PatientName');
    // A needle found inside a sequence item keeps the sequence: the filter descends.
    const inItems: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm', '--filter', 'ReferencedSOPClass']);
    expect(inItems.rendered).toContain('ReferencedImageSequence');
    expect(inItems.rendered).not.toContain('PatientName');
    const none: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm', '--filter', 'zzz']);
    expect(none.rendered).toContain("no tags match 'zzz'");
    expect(none.rendered).not.toContain('hidden');
    const hiddenMatch: CommandEnvelope = await builtin_dcm(['tags', '/s/0001-x.dcm', '--filter', 'vendor']);
    expect(hiddenMatch.rendered).toContain('1 meta/private tag hidden');
  });

  it('fails by name when the file cannot be read', async () => {
    mockHeaderGet.mockResolvedValue(err());
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/s/broken.DCM']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('/s/broken.DCM: not a readable DICOM file or folder');
  });
});

describe('dcm tags on a folder', () => {
  const files = (count: number) => Array.from({ length: count }, (_, i): { path: string; size: number } => ({ path: `/f/${String(i + 1).padStart(4, '0')}-x.dcm`, size: 10 }));
  const summary = {
    constant: [tag_make('Modality', 'MR')],
    varying: [
      {
        tag: '(0020,0013)',
        name: 'InstanceNumber',
        vr: 'IS',
        group: 'image',
        phi: false,
        distinct: 3,
        first: '1',
        last: '3',
        values: [
          { path: '/f/0001-x.dcm', value: '1' },
          { path: '/f/0002-x.dcm', value: null },
          { path: '/f/0003-x.dcm', value: '3' },
        ],
      },
    ],
  };

  it('reads every file under the cap, splits constant from varying, and shows first..last with distinct and missing counts', async () => {
    mockFolderList.mockResolvedValue(ok({ files: files(3), order: 'filename' }));
    mockHeaderGet.mockResolvedValue(ok({ tags: [] }));
    mockSummarize.mockReturnValue(summary);
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/f']);
    expect(mockHeaderGet).toHaveBeenCalledTimes(3);
    expect(mockSummarize).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ path: '/f/0001-x.dcm' })]));
    expect(envelope.rendered).toContain('3 files');
    expect(envelope.rendered).toContain('CONSTANT');
    expect(envelope.rendered).toContain('VARYING');
    expect(envelope.rendered).toContain('1 .. 3');
    expect(envelope.rendered).toContain('(3 distinct, 1 without)');
    expect(envelope.model).toMatchObject({ kind: 'dicom.tags', data: { subject: 'folder', read: 3, of: 3, refused: [] } });
  });

  it('samples evenly past the cap and says so', async () => {
    mockFolderList.mockResolvedValue(ok({ files: files(DCM_TAGS_FILE_CAP + 100), order: 'filename' }));
    mockHeaderGet.mockResolvedValue(ok({ tags: [] }));
    mockSummarize.mockReturnValue({ constant: [], varying: [] });
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/f']);
    expect(mockHeaderGet).toHaveBeenCalledTimes(2);
    expect(envelope.rendered).toContain(`2 of ${DCM_TAGS_FILE_CAP + 100} files, sampled evenly`);
    expect(envelope.model).toMatchObject({ data: { read: 2, of: DCM_TAGS_FILE_CAP + 100 } });
  });

  it('names refused files and still answers from the rest', async () => {
    mockFolderList.mockResolvedValue(ok({ files: files(2), order: 'filename' }));
    mockHeaderGet.mockResolvedValueOnce(err()).mockResolvedValueOnce(ok({ tags: [] }));
    mockSummarize.mockReturnValue({ constant: [], varying: [] });
    const envelope: CommandEnvelope = await builtin_dcm(['tags', '/f']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('REFUSED 1');
    expect(envelope.rendered).toContain('/f/0001-x.dcm');
    expect(envelope.rendered).toContain('no tags');
    expect(envelope.model).toMatchObject({ data: { read: 1, of: 2, refused: ['/f/0001-x.dcm'] } });
  });

  it('fails when the folder is empty of DICOM, unlistable, or nothing could be read', async () => {
    mockFolderList.mockResolvedValue(ok({ files: [], order: 'unknown' }));
    expect((await builtin_dcm(['tags', '/f'])).status).toBe('error');
    mockFolderList.mockResolvedValue(err());
    expect((await builtin_dcm(['tags', '/f'])).status).toBe('error');
    mockFolderList.mockResolvedValue(ok({ files: files(1), order: 'filename' }));
    mockHeaderGet.mockResolvedValue(err());
    expect((await builtin_dcm(['tags', '/f'])).status).toBe('error');
  });
});

describe('bytes_format', () => {
  it('names the nearest unit', () => {
    expect(bytes_format(512)).toBe('512 B');
    expect(bytes_format(2048)).toBe('2.0 KB');
    expect(bytes_format(2_500_000)).toBe('2.4 MB');
    expect(bytes_format(3 * 1024 ** 4)).toBe('3.0 TB');
  });
});
