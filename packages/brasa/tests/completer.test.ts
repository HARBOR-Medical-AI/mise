/**
 * @file Tests for tab completion functionality.
 */

import { jest } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// Mock salsa plugins_listAll and vfsDispatcher
const mockPlugins_listAll = jest.fn();
const mockVfsDispatcherList = jest.fn().mockResolvedValue({ ok: true, value: [] });
const mockPipelineManifestGet = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  plugins_listAll: mockPlugins_listAll,
  vfsDispatcher: {
    list: mockVfsDispatcherList,
  },
  context_getSingle: jest.fn(() => ({
    user: 'testuser',
    URL: 'http://localhost:8000'
  })),
  pipelineManifest_get: mockPipelineManifestGet,
}));

// A /bin entry's declaration, as the ChRIS fallback makes it from CUBE's parameters (#1306).
const mockBinDeclaration = jest.fn<(command: string) => Promise<unknown>>();

// Mock session
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: {
    getCWD: jest.fn().mockResolvedValue('/home/testuser'),
    setCWD: jest.fn(),
    connection: {
      client_get: jest.fn(),
      user_get: jest.fn().mockResolvedValue('testuser')
    }
  }
}));

// Mock cumin
const mockListCache = {
  cache_get: jest.fn(),
  cache_set: jest.fn(),
  cache_invalidate: jest.fn(),
};

cuminMock_install(() => ({
  feedTags_readByFeed: jest.fn(),
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  listCache_get: () => mockListCache,
  errorStack: { stack_push: jest.fn(), stack_pop: jest.fn(), stack_search: () => [] },
  Ok: (val) => ({ ok: true, value: val }),
  Err: (err) => ({ ok: false, error: err })
}));


const { input_complete } = await import('../src/lib/completer/index.js');
await (await import('./support/chrisPieces.js')).chrisPieces_install({ vfs: true, completion: true, declaration: mockBinDeclaration as never });
const { pluginDeclaration_make, pipelineDeclaration_make } = await import('../src/chris/binDeclarations.js');

/** What a stand-in /bin line runs: nothing. */
const binRun = async () => ({ status: 'ok' as const, rendered: '' });
/** pl-dircopy 2.0.0, as CUBE declares it: a path and a switch. */
const DIRCOPY = pluginDeclaration_make({
  name: 'pl-dircopy', version: '2.0.0', kind: 'fs',
  parameters: [{ name: 'dir', type: 'path', optional: false, flag: '--dir' }, { name: 'verbose', type: 'boolean', optional: true, flag: '--verbose' }],
}, binRun);
/** One pipeline node, as its manifest gives it. */
const segmentationNode = (title: string) => ({
  pipingID: 481, title, pluginName: 'pl-segmentation', pluginVersion: '2.4.0', parentID: null, computeResourceName: 'host',
  parameterDefaults: [], parameterDefinitions: [{ name: 'threshold', type: 'float', optional: true }],
});
// A ChRIS session: its help, and every verb it has.
const { chrisHelp_install, everyVerb_install } = await import('./support/chrisHelp.js');
chrisHelp_install();
everyVerb_install();

describe('Tab Completion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [] });
    mockPipelineManifestGet.mockResolvedValue({ ok: false });
  });

  describe('Command Completion', () => {
    it('should complete builtin commands', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('c', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('c');
        expect(hits).toContain('cd');
        expect(hits).toContain('connect');
        expect(hits).toContain('cat');
        done();
      });
    });

    it('should complete plugin names from /bin with version suffixes', (done) => {
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'pl-dircopy', version: '1.0.0' },
          { name: 'pl-dircopy', version: '2.0.0' },
          { name: 'pl-topologicalcopy', version: '1.5.2' },
          { name: 'pl-mri_convert', version: '3.1.0' }
        ]
      });

      input_complete('pl-', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('pl-');
        expect(hits).toContain('pl-dircopy-v1.0.0');
        expect(hits).toContain('pl-dircopy-v2.0.0');
        expect(hits).toContain('pl-topologicalcopy-v1.5.2');
        expect(hits).toContain('pl-mri_convert-v3.1.0');
        done();
      });
    });

    it('should combine builtins and plugins for completion', (done) => {
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'custom-app', version: '1.0.0' },
          { name: 'another-plugin', version: '2.0.0' }
        ]
      });

      input_complete('c', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('c');
        // Should include builtins starting with 'c'
        expect(hits).toContain('cd');
        expect(hits).toContain('connect');
        expect(hits).toContain('cat');
        // Should include plugin starting with 'c'
        expect(hits).toContain('custom-app-v1.0.0');
        // Should NOT include plugin not starting with 'c'
        expect(hits).not.toContain('another-plugin-v2.0.0');
        done();
      });
    });

    it('should complete multiple versions of same plugin', (done) => {
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'pl-dircopy', version: '1.0.0' },
          { name: 'pl-dircopy', version: '1.5.0' },
          { name: 'pl-dircopy', version: '2.0.0' },
          { name: 'pl-dircopy', version: '2.1.0' }
        ]
      });

      input_complete('pl-dircopy', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('pl-dircopy');
        // All versions should be available for completion
        expect(hits).toContain('pl-dircopy-v1.0.0');
        expect(hits).toContain('pl-dircopy-v1.5.0');
        expect(hits).toContain('pl-dircopy-v2.0.0');
        expect(hits).toContain('pl-dircopy-v2.1.0');
        expect(hits).toHaveLength(4);
        done();
      });
    });

    it('should handle plugin fetch errors gracefully', (done) => {
      mockPlugins_listAll.mockRejectedValue(new Error('Network error'));

      input_complete('c', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('c');
        // Should still return builtin completions
        expect(hits).toContain('cd');
        expect(hits).toContain('connect');
        done();
      });
    });

    it('should return empty array when no matches', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('xyz', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('xyz');
        expect(hits).toHaveLength(0);
        done();
      });
    });

    it('should handle empty plugin list', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: null });

      input_complete('p', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(original).toBe('p');
        expect(hits).toContain('pwd');
        done();
      });
    });

    it('should complete PACS commands exposed by builtin help', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('pacs', (err, result) => {
        expect(err).toBeNull();
        expect(result[0]).toContain('pacsqueries');
        expect(result[0]).toContain('pacsretrieve');
        expect(result[0]).toContain('pacsservers');
        done();
      });
    });
  });

  describe('Pipeline Parameter Completion', () => {
    it('completes a plugin\'s parameters and the session\'s options from its declaration, by its full name or its bare name (#1306)', (done) => {
      mockBinDeclaration.mockImplementation(async (command: string) => (command === 'pl-dircopy' || command === 'pl-dircopy-v2.0.0' ? DIRCOPY : null));
      input_complete('pl-dircopy-v2.0.0 --d', (err, full) => {
        expect(err).toBeNull();
        expect(full).toEqual([['--detach', '--dir'], '--d']);
        input_complete('pl-dircopy --', (bareErr, bare) => {
          expect(bareErr).toBeNull();
          expect(bare[0]).toEqual(expect.arrayContaining(['--dir', '--verbose', '--detach', '--parameters', '--readme']));
          expect(mockBinDeclaration).toHaveBeenCalledWith('pl-dircopy');
          done();
        });
      });
    });

    it('completes hosted parameters and execution controls from the registered manifest', (done) => {
      const pipeline = pipelineDeclaration_make('brain-preprocessing', { pipelineID: 27, name: 'brain-preprocessing', rootIDs: [481], nodes: [segmentationNode('segmentation')] } as never, binRun);
      mockBinDeclaration.mockImplementation(async (command: string) => (command === 'brain-preprocessing' ? pipeline : null));
      input_complete('brain-preprocessing --seg', (err, result) => {
        expect(err).toBeNull();
        expect(result[0]).toContain('--segmentation.threshold');
        expect(result[0]).toContain('--segmentation.memory_limit');
        done();
      });
    });

    it('uses exact piping IDs instead of unsafe authored titles', (done) => {
      const pipeline = pipelineDeclaration_make('brain-preprocessing', { pipelineID: 27, name: 'brain-preprocessing', rootIDs: [481], nodes: [segmentationNode('segmentation stage')] } as never, binRun);
      mockBinDeclaration.mockImplementation(async (command: string) => (command === 'brain-preprocessing' ? pipeline : null));
      input_complete('brain-preprocessing --@481', (err, result) => {
        expect(err).toBeNull();
        expect(result[0]).toContain('--@481.threshold');
        expect(result[0]).not.toContain('--segmentation stage.threshold');
        done();
      });
    });
  });

  describe('Path Completion', () => {
    it('should not trigger command completion when typing arguments', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      // When we have a space after the command, we're in argument mode
      input_complete('cd ', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        // Should return path completions, not command completions
        // In this case, empty because we mocked files_list to return []
        expect(hits).toEqual([]);
        done();
      });
    });

    it('completes a path after a /bin plugin name, full or bare: its input operand is a CFS path (#1305)', (done) => {
      mockBinDeclaration.mockImplementation(async (command: string) => (command.startsWith('pl-dircopy') ? DIRCOPY : null));
      mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [{ name: 'data', type: 'dir', size: 0, owner: 'testuser', date: '' }] });
      input_complete('pl-dircopy-v1.0.0 da', (err, full) => {
        expect(err).toBeNull();
        expect(full).toEqual([['data/'], 'da']);
        input_complete('pl-dircopy da', (bareErr, bare) => {
          expect(bareErr).toBeNull();
          expect(bare).toEqual([['data/'], 'da']);
          // A path parameter's value is a path too.
          input_complete('pl-dircopy --dir da', (valueErr, value) => {
            expect(valueErr).toBeNull();
            expect(value).toEqual([['data/'], 'da']);
            done();
          });
        });
      });
    });

    it('completes no path for an option word, and nothing for a word /bin does not list', (done) => {
      mockBinDeclaration.mockImplementation(async (command: string) => (command.startsWith('pl-dircopy') ? DIRCOPY : null));
      mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [{ name: 'data', type: 'dir', size: 0, owner: 'testuser', date: '' }] });
      input_complete('pl-dircopy-v1.0.0 --x', (err, option) => {
        expect(err).toBeNull();
        expect(option[0]).toEqual([]);
        input_complete('frobnicate da', (otherErr, other) => {
          expect(otherErr).toBeNull();
          expect(other).toEqual([[], 'frobnicate da']);
          done();
        });
      });
    });

    it('should provide path completion for cp command', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('cp ', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        // Should return path completions (empty in this case due to mock)
        expect(hits).toEqual([]);
        expect(original).toBe('');
        done();
      });
    });

    it('should provide path completion for rm command', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('rm ', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(hits).toEqual([]);
        expect(original).toBe('');
        done();
      });
    });

    it('should provide path completion for image command (its argument is a path)', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('image ', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(hits).toEqual([]);
        expect(original).toBe('');
        done();
      });
    });

    it('should provide path completion for upload command', (done) => {
      mockPlugins_listAll.mockResolvedValue({ tableData: [] });

      input_complete('upload ', (err, result) => {
        expect(err).toBeNull();
        const [hits, original] = result;
        expect(hits).toEqual([]);
        expect(original).toBe('');
        done();
      });
    });

    it('should append a slash when completing a directory for ls', (done) => {
      mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [
        { name: 'data', type: 'dir', size: 0, owner: 'testuser', date: '' }
      ]});

      input_complete('ls da', (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual([['data/'], 'da']);
        done();
      });
    });

    it('should preserve escaped spaces while completing ls operands', (done) => {
      mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [
        { name: 'Patient Data', type: 'dir', size: 0, owner: 'testuser', date: '' }
      ]});

      input_complete('ls Patient\\ D', (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual([['Patient\\ Data/'], 'Patient\\ D']);
        done();
      });
    });

    it('should preserve double quotes while completing ls operands', (done) => {
      mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [
        { name: 'Patient Data', type: 'dir', size: 0, owner: 'testuser', date: '' }
      ]});

      input_complete('ls "Patient ', (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual([['"Patient Data/'], '"Patient ']);
        done();
      });
    });
  });
});
