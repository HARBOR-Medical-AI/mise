/**
 * @file Unit tests for playing a manifest.
 *
 * The claims worth pinning: a manifest says what it needs and is refused
 * BEFORE it changes anything when it does not have it; a gathered path with
 * a space in it is one operand, not several; a refused line stops the play;
 * and a dry run touches nothing.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

/** Lines the fake session was asked to run. */
const ran: string[] = [];
/** What the next line_execute answers. */
let refuseAt: string | null = null;

/** The manifest the fake filesystem holds. */
let stored: string = '';
/** Whether the manifest is nowhere to be found. */
let missing: boolean = false;

/** The cohort the fake session holds. */
let members: Array<{ vfsPath: string; kind: string; folderPath?: string }> = [];

cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  listCache_get: () => ({ cache_invalidate: (): void => undefined }),
  // Reading a manifest asks CFS first and drains the miss when it is not there.
  errorStack: { checkpoint_mark: (): number => 0, checkpoint_drain: (): unknown[] => [] },
}));

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  fileContent_get: async (): Promise<{ ok: boolean; value?: string }> => (
    missing ? { ok: false } : { ok: true, value: stored }
  ),
  files_path_isDirectory: async (): Promise<boolean> => true,
}));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/touch.js', () => ({ files_touch: async (): Promise<boolean> => true }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/mkdir.js', () => ({ files_mkdir: async (): Promise<boolean> => true }));

jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  path_resolve: async (p: string): Promise<string> => p,
  commandArgs_process: (args: string[]) => ({ _: args }),
}));

/** Where the fake session stands; a manifest's `cd` moves it. */
let cwd: string = '/home/chris/uploads';
const mockSetCwd = jest.fn(async (place: string): Promise<void> => { cwd = place; });
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => cwd, setCWD: mockSetCwd },
}));

const output: string[] = [];
jest.unstable_mockModule('../src/core/sink.js', () => ({
  sink_dataLine: (line: string): void => { output.push(line); },
  sink_errLine: (line: string): void => { output.push(line); },
}));

/** Parameter scopes play opened, as entry lists. */
const scopes: Array<Array<[string, string]>> = [];
/** The parameters currently in scope, as the real resolver would see them. */
let scope: Map<string, string> = new Map();
/** The variables the fake session's lines set, by name. */
const variables: Map<string, { answer: { source: string; kind: string; rows: unknown[]; data: unknown }; readOnly: boolean }> = new Map();
jest.unstable_mockModule('../src/core/variables.js', () => ({
  VARIABLE_NAME: /^[A-Za-z_][A-Za-z0-9_]*$/,
  variableScope_run: async (params: Map<string, string>, operation: () => Promise<unknown>): Promise<unknown> => {
    scopes.push([...params.entries()]);
    scope = params;
    return await operation();
  },
  variable_get: (name: string) => variables.get(name),
  // The session's reading of an assignment line, as far as these lines need.
  assignment_parse: (line: string) => {
    const match: RegExpMatchArray | null = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match === null) return null;
    const value: string = match[2] as string;
    return value.startsWith('$(') && value.endsWith(')') ? { name: match[1], capture: value.slice(2, -1).trim() } : { name: match[1], literal: value };
  },
}));
jest.unstable_mockModule('../src/core/expansion.js', () => ({
  reference_isReserved: (name: string): boolean => ['gather', 'feed', 'run', 'query', 'cwd'].includes(name.split('.')[0]),
  // The cohort the session holds before the play; `gather` and `pull` change it.
  reference_changedBy: (name: string, passed: { count: number; verbs: ReadonlySet<string>; assigned: ReadonlySet<string> }): boolean =>
    passed.count > 0 && (name === 'gather' ? passed.verbs.has('gather') || passed.verbs.has('pull') : passed.assigned.has(name)),
  reference_resolve: async (name: string): Promise<{ values: string[] } | null> => {
    if (name === 'gather') return members.length === 0 ? null : { values: members.map((member: { vfsPath: string }): string => member.vfsPath) };
    const held: string | undefined = scope.get(name);
    return held === undefined ? null : { values: [held] };
  },
  unresolvedStands_run: async (operation: () => Promise<unknown>): Promise<unknown> => await operation(),
}));

jest.unstable_mockModule('../src/core/engine.js', () => ({
  line_execute: async (line: string): Promise<Array<{ status: string; rendered: string }>> => {
    ran.push(line);
    const moved: RegExpMatchArray | null = line.match(/^cd (\S+)$/);
    if (moved !== null) cwd = moved[1] as string;
    if (line === 'interrupt') throw new Error('interrupted');
    const capture: RegExpMatchArray | null = line.match(/^([A-Z])=\$\((.*)\)$/);
    if (capture !== null) variables.set(capture[1] as string, { answer: { source: capture[2] as string, kind: 'run.scheduled', rows: [], data: { instanceId: 4813 } }, readOnly: false });
    return [{ status: refuseAt !== null && line.includes(refuseAt) ? 'error' : 'ok', rendered: '' }];
  },
}));

// The cohort is read for its pronouns; the store's own file path is mocked above.
jest.unstable_mockModule('../src/builtins/res/gather.store.js', () => ({
  cohort_read: async (): Promise<{ version: number; name: string | null; feed: null; series: typeof members }> =>
    ({ version: 1, name: 'sag cohort', feed: null, series: members }),
}));

const { builtin_play, manifest_parse, line_expand, playArgs_parse } = await import('../src/builtins/res/play.js');
// The session's files: the manifest is read through the backend, as CFS is.
const statusAsked: string[][] = [];
/** The task running `vm build store` now, when the fake backend says one does. */
let runningStore: string | null = null;
(await import('../src/core/backend.js')).backend_install({
  id: 'chris',
  session: {} as never,
  files: {
    read: async (): Promise<Buffer> => { if (missing) throw new Error('no such file'); return Buffer.from(stored); },
    write: async (): Promise<void> => undefined,
  },
  // A status reads each line's verb against what the backend keeps: here `vm` keeps one VM, `store`, declared and not built.
  lineStatuses: [{
    verb: 'vm',
    read: async (words: ReadonlyArray<string>) => {
      statusAsked.push([...words]);
      if (words[1] === 'cost') return null;
      if (words[2] !== 'store') return { state: 'not yet' as const, detail: `${words[2]}: not declared` };
      if (words[1] === 'build' && runningStore !== null) return { state: 'ready' as const, detail: '', running: runningStore };
      return words[1] === 'new' ? { state: 'done' as const, detail: 'unchanged' } : { state: 'ready' as const, detail: '' };
    },
  }],
});

beforeEach(() => {
  ran.length = 0;
  output.length = 0;
  refuseAt = null;
  stored = '';
  members = [];
  missing = false;
  scopes.length = 0;
  variables.clear();
  scope = new Map();
  cwd = '/home/chris/uploads';
  mockSetCwd.mockClear();
  process.exitCode = 0;
});

describe('play --status reads each line against what is kept, running none', () => {
  it('says not yet, ready, done or a dash per line, expanded first, and counts them', async () => {
    stored = 'vm new store --vcpu 2\nvm build store\nvm cost store --memory 16\nvm build ${WHICH}\nls /\n';
    statusAsked.length = 0;
    const result = await builtin_play(['f.mise', '--status', '--param', 'WHICH=blt']);
    expect(result.status).toBe('ok');
    expect(ran).toEqual([]);
    expect(statusAsked.map((words: string[]): string => words.join(' '))).toEqual(['vm new store --vcpu 2', 'vm build store', 'vm cost store --memory 16', 'vm build blt']);
    const plain = output.map((line: string): string => line.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(plain).toEqual([
      'done    ▸ vm new store --vcpu 2  unchanged',
      'ready   ▸ vm build store',
      '—       ▸ vm cost store --memory 16',
      'not yet ▸ vm build blt  blt: not declared',
      '—       ▸ ls /',
    ]);
    expect(result.rendered.replace(/\x1b\[[0-9;]*m/g, '')).toBe('play: f.mise: 1 done, 1 ready, 0 changed, 1 not yet, of 5 lines\n');
    expect((result.model as { kind: string; data: { lines: Array<{ number: number; state: string | null }> } }).kind).toBe('manifest.status');
    expect((result.model as { data: { lines: Array<{ number: number; state: string | null }> } }).data.lines.map((line): string => `${line.number}:${line.state}`)).toEqual(['1:done', '2:ready', '3:null', '4:not yet', '5:null']);
    expect(mockSetCwd).not.toHaveBeenCalled();
  });

  it('names the task running a line now after its state, and carries it in the model', async () => {
    stored = 'vm new store --vcpu 2\nvm build store\n';
    runningStore = '/proc/steps/vm-store-apply-machine';
    try {
      const result = await builtin_play(['f.mise', '--status']);
      expect(result.status).toBe('ok');
      const plain = output.map((line: string): string => line.replace(/\x1b\[[0-9;]*m/g, ''));
      expect(plain[1]).toBe('ready   ▸ vm build store  ▶ running: /proc/steps/vm-store-apply-machine (wait /proc/steps/vm-store-apply-machine follows it)');
      const lines = (result.model as { data: { lines: Array<{ number: number; running?: string }> } }).data.lines;
      expect(lines.map((line): string | undefined => line.running)).toEqual([undefined, '/proc/steps/vm-store-apply-machine']);
    } finally {
      runningStore = null;
    }
  });
});

describe('a play gives back the working directory it began in (#1264)', () => {
  it('when it runs to its end', async () => {
    stored = ['cd /home/chris/feeds/feed_5/pl-dircopy_6/data', 'pwd'].join('\n');
    await builtin_play(['f.mise']);
    expect(cwd).toBe('/home/chris/uploads');
  });

  it('when a line refuses and the play stops there', async () => {
    refuseAt = 'boom';
    stored = ['cd /home/chris/feeds/feed_5', 'boom', 'pwd'].join('\n');
    await builtin_play(['f.mise']);
    expect(ran).toEqual(['cd /home/chris/feeds/feed_5', 'boom']);
    expect(cwd).toBe('/home/chris/uploads');
  });

  it('when it is interrupted', async () => {
    stored = ['cd /home/chris/feeds/feed_5', 'interrupt'].join('\n');
    await expect(builtin_play(['f.mise'])).rejects.toThrow('interrupted');
    expect(cwd).toBe('/home/chris/uploads');
  });

  it('says, and does not throw, when the place it began in cannot be given back', async () => {
    mockSetCwd.mockRejectedValueOnce(new Error('No such file or directory'));
    stored = ['cd /home/chris/feeds/feed_5', 'pwd'].join('\n');
    const envelope = await builtin_play(['f.mise']);
    expect(envelope.status).toBe('ok');
    expect(output.some((line: string): boolean => line.includes('could not go back to /home/chris/uploads'))).toBe(true);
  });

  it('touches nothing when nothing moved it, or in a dry run', async () => {
    stored = ['pwd'].join('\n');
    await builtin_play(['f.mise']);
    stored = ['cd /home/chris/feeds/feed_5'].join('\n');
    await builtin_play(['f.mise', '--dry-run']);
    expect(mockSetCwd).not.toHaveBeenCalled();
    expect(cwd).toBe('/home/chris/uploads');
  });
});

describe('manifest_parse', () => {
  it('reads what the file says about itself, and keeps the line numbers', () => {
    const manifest = manifest_parse([
      '# a workflow',
      '@name  sag cohort',
      '@description  gather and process',
      '@param MRN',
      '@param LABEL = draft',
      '',
      'pacs query PatientID:${MRN}',
      'gather add --shown',
    ].join('\n'));
    expect(manifest.name).toBe('sag cohort');
    expect(manifest.description).toBe('gather and process');
    expect(manifest.params).toEqual([{ name: 'MRN' }, { name: 'LABEL', fallback: 'draft' }]);
    expect(manifest.lines.map((line) => line.number)).toEqual([7, 8]);
  });
});

describe('playArgs_parse', () => {
  it('keeps EVERY --param, which a generic parser would not', () => {
    const parsed = playArgs_parse(['f.mise', '--param', 'MRN=1', '--param', 'LABEL=two words']);
    expect(parsed.params.get('MRN')).toBe('1');
    expect(parsed.params.get('LABEL')).toBe('two words');
  });

  it('refuses --step, which needs a terminal, by name', () => {
    expect(playArgs_parse(['f.mise', '--step']).parseError).toContain('terminal');
    // A script's text read in place of its file, for a standing only: a surface reads lines it has not written yet.
    expect(playArgs_parse(['f.mise', '--status', '--text=vm new s\nvm build s']).text).toBe('vm new s\nvm build s');
    expect(playArgs_parse(['f.mise', '--status', '--text', '-x']).text).toBe('-x');
    expect(playArgs_parse(['f.mise', '--text=vm new s']).parseError).toContain('with --status');
    expect(playArgs_parse(['f.mise', '--status', '--text']).parseError).toContain('--text takes');
  });
});

describe('playArgs_parse, the rest', () => {
  it('reads a pace in seconds and in milliseconds', () => {
    expect(playArgs_parse(['f.mise', '--pace', '2s']).paceMs).toBe(2000);
    expect(playArgs_parse(['f.mise', '--pace', '250ms']).paceMs).toBe(250);
  });

  it('refuses what it cannot make sense of', () => {
    expect(playArgs_parse(['f.mise', '--pace', 'soon']).parseError).toContain('--pace');
    expect(playArgs_parse(['f.mise', '--param', 'MRN']).parseError).toContain('--param');
    expect(playArgs_parse(['f.mise', '--sideways']).parseError).toContain('--sideways');
    expect(playArgs_parse(['one.mise', 'two.mise']).parseError).toContain('two.mise');
  });
});

describe('play', () => {
  it('refuses when there is no manifest to play, and when neither filesystem has it', async () => {
    const noName = await builtin_play([]);
    expect(noName.status).toBe('error');
    expect(noName.renderedErr).toContain('Usage: play');

    missing = true;
    const notThere = await builtin_play(['nowhere.mise']);
    expect(notThere.status).toBe('error');
    expect(notThere.renderedErr).toContain('nowhere.mise');
    missing = false;
  });

  it('paces the lines when asked', async () => {
    stored = ['pwd', 'pwd'].join('\n');
    const started: number = Date.now();
    await builtin_play(['f.mise', '--pace', '60ms']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(ran).toEqual(['pwd', 'pwd']);
  });

  it('refuses a manifest it cannot fill in, BEFORE running any line', async () => {
    stored = ['@param MRN', 'pacs query PatientID:${MRN}'].join('\n');
    const envelope = await builtin_play(['f.mise']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('--param MRN=');
    expect(ran).toEqual([]);
  });

  // play hands the line over as written: the session expands it, the same
  // way it expands a typed one. What play owns is that the parameter is IN
  // SCOPE while the line runs.
  it('runs the line as written, with the manifest\'s parameters in scope', async () => {
    stored = ['@param LABEL = draft', 'feed create ${LABEL}'].join('\n');
    await builtin_play(['f.mise']);
    expect(ran).toEqual(['feed create ${LABEL}']);
    expect(scopes).toEqual([[['LABEL', 'draft']]]);
  });

  it('refuses a manifest that takes a name the session answers for', async () => {
    stored = ['@param feed', 'pwd'].join('\n');
    const envelope = await builtin_play(['f.mise', '--param', 'feed=1']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('@param feed');
    expect(ran).toEqual([]);
  });

  it('runs the lines in order, showing each one before it runs', async () => {
    stored = ['pwd', 'ls'].join('\n');
    const envelope = await builtin_play(['f.mise']);
    expect(ran).toEqual(['pwd', 'ls']);
    expect(output.some((line: string): boolean => line.includes('▸ pwd'))).toBe(true);
    expect(envelope.status).toBe('ok');
  });

  it('stops where the trouble is, and says which line', async () => {
    stored = ['pwd', 'ls /nowhere', 'pwd'].join('\n');
    refuseAt = '/nowhere';
    const envelope = await builtin_play(['f.mise']);
    expect(ran).toEqual(['pwd', 'ls /nowhere']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('line 2');
    expect(process.exitCode).toBe(1);
  });

  it('leaves a variable a dry run cannot know as it was written', async () => {
    // Nothing has run, so ${A.feedId} has no value — refusing there would
    // make --dry-run useless for exactly the manifests that chain.
    stored = ['pwd', 'expect feed ${A.feedId} status eq finishedSuccessfully'].join('\n');
    const envelope = await builtin_play(['f.mise', '--dry-run']);
    expect(envelope.status).toBe('ok');
    expect(output.some((line: string): boolean => line.includes('expect feed ${A.feedId} status'))).toBe(true);
  });

  it('previews a capture around the command it holds, not through its parenthesis (#1241)', async () => {
    stored = ['@param LABEL', 'R=$(gather process "FS 8.2.0" --title "${LABEL}")'].join('\n');
    await builtin_play(['f.mise', '--param', 'LABEL=t1 cohort', '--dry-run']);
    expect(output).toContainEqual(expect.stringContaining("R=$(gather process 'FS 8.2.0' --title 't1 cohort')"));
  });

  it('leaves the cohort as written once the manifest has changed it (#1241)', async () => {
    members = [{ vfsPath: '/home/chris/uploads/old', kind: 'dir' }];
    stored = ['pull ${gather}', 'gather clear', 'query x | gather add', 'pull ${gather}', 'R=$(pwd)', 'cat ${R}'].join('\n');
    // R as the session held it before the play: the manifest assigns it anew.
    await builtin_play(['f.mise', '--param', 'R=/stale', '--dry-run']);
    const previews: string[] = output.filter((line: string): boolean => line.includes('▸'));
    // Before any line ran, the session's cohort IS what pull would take.
    expect(previews[0]).toContain('pull /home/chris/uploads/old');
    expect(previews[3]).toContain('pull ${gather}');
    expect(previews[3]).not.toContain('/old');
    expect(previews[5]).toContain('cat ${R}');
    expect(previews[5]).not.toContain('/stale');
  });

  it('shows a dry run without running anything', async () => {
    stored = ['@param MRN', 'pacs query PatientID:${MRN}'].join('\n');
    const envelope = await builtin_play(['f.mise', '--param', 'MRN=1279049', '--dry-run']);
    expect(ran).toEqual([]);
    expect(output.some((line: string): boolean => line.includes('pacs query PatientID:1279049'))).toBe(true);
    expect(envelope.status).toBe('ok');
  });
});

describe('a manifest that declares what it answers', () => {
  it('answers with that variable\'s model, so X=$(play f) holds what the flow made', async () => {
    stored = ['@answers C', 'C=$(pl-dcm2niix)'].join('\n');
    const envelope = await builtin_play(['f.mise']);
    expect(envelope.status).toBe('ok');
    expect(envelope.model).toEqual({ kind: 'run.scheduled', data: { instanceId: 4813 } });
  });

  it('refuses a play that ends without setting what it answers', async () => {
    stored = ['@answers C', 'ls'].join('\n');
    const envelope = await builtin_play(['f.mise']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('f.mise answers C, and C was never set');
  });

  it('refuses an answer that is not a name, before a line runs', async () => {
    stored = ['@answers C.instanceId', 'ls'].join('\n');
    const envelope = await builtin_play(['f.mise']);
    expect(envelope.status).toBe('error');
    expect(ran).toEqual([]);
  });

  it('shows the answer it would give in a dry run, and sets nothing', async () => {
    stored = ['@answers C', 'C=$(pl-dcm2niix)'].join('\n');
    const envelope = await builtin_play(['f.mise', '--dry-run']);
    expect(envelope.status).toBe('ok');
    expect(output.some((line: string): boolean => line.includes('@answers C'))).toBe(true);
    expect(ran).toEqual([]);
  });
});

describe('a play judges its own lines', () => {
  it('runs through in a session an earlier command left failed, and leaves that status as it found it', async () => {
    stored = ['pwd', 'ls'].join('\n');
    process.exitCode = 1;
    const envelope = await builtin_play(['f.mise']);
    expect(envelope.status).toBe('ok');
    expect(ran).toEqual(['pwd', 'ls']);
    expect(process.exitCode).toBe(1);
  });
});
