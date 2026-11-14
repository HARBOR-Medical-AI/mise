/**
 * @file Remote client host-mode tests.
 *
 * Verifies that `chell --remote -c` uses a one-shot surface, executes exactly
 * once, closes its transport, and never starts the interactive REPL.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/cumin';
import type { LocalEditRequest, LocalEditResult } from '@fnndsc/brasa';
import type { RemoteEngineOptions } from '../src/remote/remoteEngine.js';

interface TestBerth {
  identity: string;
  url: string;
  token: string;
}

interface TestRemoteEngine {
  close(): void;
  promptLine?: () => string;
  daemonStack?: () => { chell: string; calypso: string; build: string } | undefined;
  backend_get?: () => string | undefined;
}

const remoteClose_mock = jest.fn<() => void>();
/** The status the daemon sent with the last line; 0 unless a test says otherwise. */
const exitTake_mock = jest.fn<() => number>(() => 0);
const remoteConnect_mock = jest.fn<(options: RemoteEngineOptions) => Promise<TestRemoteEngine>>();
const replStart_mock = jest.fn(async (): Promise<void> => undefined);
const surfaceLineExecute_mock = jest.fn<(engine: unknown, line: string) => Promise<CommandEnvelope[]>>();
const sinkSet_mock = jest.fn<(sink: unknown) => void>();
const surfaceSet_mock = jest.fn<(surface: unknown) => void>();
const prompt_mock = jest.fn<(options: { message: string; hidden: boolean }) => Promise<string>>();
const pipeSegment_mock = jest.fn<(command: string, stdin: Buffer) => Promise<Buffer>>();
const shellCommand_mock = jest.fn<(command: string) => Promise<number>>();
const localEdit_mock = jest.fn<(request: LocalEditRequest) => Promise<LocalEditResult>>();
const resolverResolve_mock = jest.fn<(identity: string) => Promise<TestBerth | null>>();
const resolverList_mock = jest.fn<() => Promise<TestBerth[]>>();

const berth: TestBerth = {
  identity: 'chris@https://cube.example.org/api/v1/',
  url: 'ws://127.0.0.1:42000',
  token: 'token',
};

class MockLocalBerthResolver {
  public async resolve(_identity: string): Promise<TestBerth | null> {
    return resolverResolve_mock(_identity);
  }

  public async list(): Promise<Array<typeof berth>> {
    return resolverList_mock();
  }
}

class MockRemoteEngine {
  public static connect = remoteConnect_mock;
}

class MockRepl {
  public start = replStart_mock;
}

jest.unstable_mockModule('@fnndsc/calypso', () => ({
  LocalBerthResolver: MockLocalBerthResolver,
  identity_normalise: (user: string, url: string): string => `${user}@${url}`,
}));
jest.unstable_mockModule('@fnndsc/brasa', () => ({
  sink_set: sinkSet_mock,
  sinkScope_run: <T>(_sink: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  surface_get: jest.fn(() => ({
    prompt: prompt_mock,
    pipeSegment: pipeSegment_mock,
    shellCommand: shellCommand_mock,
    localEdit: localEdit_mock,
  })),
  surface_set: surfaceSet_mock,
  StdoutSink: class MockStdoutSink {},
  welcomeLine_build: jest.fn(() => 'ChELL Executes Layered Logic, v 0.0.0 (dev). Welcome.'),
  welcomeLine_compose: jest.fn(
    (pkg: string, version: string, build: string) => `ChELL Executes Layered Logic, v ${version} (${build}). Welcome.`,
  ),
  fortune_random: jest.fn(() => 'A test fortune.'),
  // The banner names each package in full; the words the test looks for
  // are the short names, which every full name carries.
  stackBanner_rows: jest.fn((versions: Record<string, string | undefined>) =>
    Object.entries(versions)
      .filter(([pkg]: [string, string | undefined]): boolean => pkg !== 'build')
      .map(([pkg, version]: [string, string | undefined]) => ({ pkg, name: `${pkg.toUpperCase()} written out`, version, nameWidth: 20 })),
  ),
  stackBannerRow_paint: jest.fn((row: { name: string; version: string }): string => `${row.name}  ${row.version}`),
  buildHash_get: jest.fn((): string => 'dev'),
}));
jest.unstable_mockModule('../src/remote/remoteEngine.js', () => ({
  RemoteEngine: MockRemoteEngine,
}));
jest.unstable_mockModule('../src/core/repl.js', () => ({ REPL: MockRepl }));
jest.unstable_mockModule('../src/core/cliSurface.js', () => ({
  cliSurface_create: jest.fn(() => ({ capabilities: {} })),
}));
jest.unstable_mockModule('../src/core/progressRenderer.js', () => ({
  TerminalProgressRenderer: class MockTerminalProgressRenderer {
    write(): void {}
    clear(): void {}
  },
}));
jest.unstable_mockModule('../src/core/surfaceDispatch.js', () => ({
  surfaceLine_execute: surfaceLineExecute_mock,
}));

const { berth_probeLive, remote_run, berth_parse, commands_split } = await import('../src/remote/client.js');

describe('berth_probeLive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('closes a successful probe connection', async () => {
    remoteConnect_mock.mockResolvedValue({ close: remoteClose_mock });

    await expect(berth_probeLive(berth)).resolves.toBe(true);
    expect(remoteClose_mock).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected probe as not live', async () => {
    remoteConnect_mock.mockRejectedValue(new Error('connection refused'));

    await expect(berth_probeLive(berth)).resolves.toBe(false);
  });
});

describe('remote_run', () => {
  const previousExitCode: number | string | undefined = process.exitCode;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    resolverResolve_mock.mockResolvedValue(berth);
    resolverList_mock.mockResolvedValue([berth]);
    remoteConnect_mock.mockResolvedValue({
      close: remoteClose_mock,
      exitCode_take: exitTake_mock,
      promptLine: jest.fn((): string => ''),
      daemonStack: jest.fn(() => undefined),
    });
    surfaceLineExecute_mock.mockResolvedValue([{ status: 'ok', rendered: '/proc/jobs\n' }]);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    jest.restoreAllMocks();
  });

  it('says the daemon is out of date when it attaches to one, and again when the daemon says so mid-session', async () => {
    remoteConnect_mock.mockResolvedValue({
      close: remoteClose_mock,
      exitCode_take: exitTake_mock,
      promptLine: jest.fn((): string => ''),
      daemonStack: jest.fn(() => undefined),
      daemonStale: true,
    });
    const logged: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown): void => { logged.push(String(line)); });
    const written: string[] = [];
    // The mid-session notice is a diagnostic: stderr, never mixed into output.
    const writeSpy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => { written.push(String(chunk)); return true; }) as never);
    // Interactive: the greeting and its warnings print; a one-shot command prints only its answer.
    await remote_run(berth.identity);
    expect(logged.some((line: string): boolean => /out of date/.test(line))).toBe(true);
    const options = remoteConnect_mock.mock.calls[0]?.[0] as { onStale?: (stale: boolean) => void } | undefined;
    options?.onStale?.(false);
    expect(written.some((line: string): boolean => /out of date/.test(line))).toBe(false);
    options?.onStale?.(true);
    expect(written.some((line: string): boolean => /out of date/.test(line))).toBe(true);
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('executes a one-shot command, closes, and does not start the REPL', async () => {
    await remote_run(berth.identity, 'pwd');

    expect(remoteConnect_mock).toHaveBeenCalledWith(expect.objectContaining({ onSession: undefined }));
    expect(surfaceLineExecute_mock).toHaveBeenCalledWith(expect.any(Object), 'pwd');
    expect(remoteClose_mock).toHaveBeenCalledTimes(1);
    expect(replStart_mock).not.toHaveBeenCalled();
    expect(sinkSet_mock).toHaveBeenCalledTimes(1);
    expect(surfaceSet_mock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it('looks a tenancy berth up by the identity as typed', async () => {
    await remote_run('rudolph@fnndsc', 'pwd');

    expect(resolverResolve_mock.mock.calls[0]?.[0]).toBe('rudolph@fnndsc');
    expect(remoteConnect_mock).toHaveBeenCalledWith(expect.objectContaining({ url: berth.url }));
  });

  it('draws the session\'s splash after the attach answer, by backend', async () => {
    const { tdMark_linesRender } = await import('@fnndsc/menu/logo/td');
    const mark: string = tdMark_linesRender(false)[5] as string;
    const run = async (backend: string): Promise<string[]> => {
      remoteConnect_mock.mockResolvedValue({
        close: remoteClose_mock,
      exitCode_take: exitTake_mock,
        promptLine: jest.fn((): string => ''),
        daemonStack: jest.fn(() => undefined),
        backend_get: jest.fn((): string => backend),
      });
      const logged: string[] = [];
      const logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown): void => { logged.push(String(line)); });
      await remote_run(berth.identity, undefined, undefined, { splash: { colorize: false } });
      logSpy.mockRestore();
      return logged;
    };
    const stratus: string[] = await run('stratus');
    expect(stratus).toContain(mark);
    // Art first, then the attach line beneath it.
    expect(stratus.indexOf(mark)).toBeLessThan(stratus.findIndex((line: string): boolean => /Attached to CALYPSO/.test(line)));
    expect(await run('null')).not.toContain(mark);
  });

  it('draws no splash for a one-shot command', async () => {
    const logged: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown): void => { logged.push(String(line)); });
    await remote_run(berth.identity, 'pwd', undefined, { splash: { colorize: false } });
    logSpy.mockRestore();
    expect(logged.join('\n')).not.toMatch(/\+\+\+|xxxx/);
  });

  it('uses the sole live berth when no identity is specified', async () => {
    await remote_run(undefined, 'pwd');

    expect(resolverList_mock).toHaveBeenCalledTimes(1);
    expect(remoteConnect_mock).toHaveBeenCalledWith(expect.objectContaining({ url: berth.url }));
    expect(remoteClose_mock).toHaveBeenCalledTimes(1);
  });

  it('attaches by address without consulting this host\'s berths', async () => {
    await remote_run(undefined, 'pwd', { address: 'http://pangea:41234/?token=abc123' });

    // A daemon on another machine leaves no berth in this host's runtime
    // directory, so discovery must not be reached at all — asking it would
    // find nothing and refuse an attach that is perfectly possible.
    expect(resolverList_mock).not.toHaveBeenCalled();
    expect(resolverResolve_mock).not.toHaveBeenCalled();
    expect(remoteConnect_mock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'ws://pangea:41234', token: 'abc123' }),
    );
  });

  it('exits unsuccessfully when no daemon berth is available', async () => {
    const error_spy = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    const exit_spy = jest.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit 1');
    }) as typeof process.exit);
    resolverList_mock.mockResolvedValue([]);

    await expect(remote_run(undefined, 'pwd')).rejects.toThrow('exit 1');
    expect(error_spy).toHaveBeenCalledWith(expect.stringContaining('No calypso found'));
    expect(exit_spy).toHaveBeenCalledWith(1);
  });

  it('with -e, runs a one-shot a segment at a time and stops at the first error; without it, the kernel takes the whole line', async () => {
    surfaceLineExecute_mock.mockImplementation(async (_engine: unknown, line: string): Promise<CommandEnvelope[]> =>
      [{ status: line.startsWith('cd nowhere') ? 'error' : 'ok', rendered: `${line}\n` }]);
    await remote_run(berth.identity, 'pwd; cd nowhere; rm -r "a;b"', undefined, { stopOnError: true });
    expect(surfaceLineExecute_mock.mock.calls.map((call: unknown[]) => call[1])).toEqual(['pwd', 'cd nowhere']);
    expect(process.exitCode).toBe(1);
    surfaceLineExecute_mock.mockReset();
    surfaceLineExecute_mock.mockResolvedValue([{ status: 'ok', rendered: '' }]);
    await remote_run(berth.identity, 'pwd; cd nowhere; rm -r "a;b"', undefined, { stopOnError: false });
    expect(surfaceLineExecute_mock.mock.calls.map((call: unknown[]) => call[1])).toEqual(['pwd; cd nowhere; rm -r "a;b"']);
  });

  it('exits with the status the daemon sent, though every envelope was ok, as `berth close` that closed nothing ends', async () => {
    surfaceLineExecute_mock.mockResolvedValue([{ status: 'ok', rendered: 'berth: close: nothing closed\n' }]);
    // Taken once to clear what an earlier line left, once for this line.
    exitTake_mock.mockReturnValueOnce(0).mockReturnValueOnce(1);
    await remote_run(berth.identity, 'berth close');
    expect(process.exitCode).toBe(1);
    // A status of its own travels as it is.
    exitTake_mock.mockReturnValueOnce(0).mockReturnValueOnce(2);
    await remote_run(berth.identity, 'cd "a');
    expect(process.exitCode).toBe(2);
    // An error envelope with no status sent is still a failure.
    surfaceLineExecute_mock.mockResolvedValue([{ status: 'error', rendered: '' }]);
    await remote_run(berth.identity, 'cd nowhere');
    expect(process.exitCode).toBe(1);
  });

  it('with -e, stops at a segment that ends with a status other than 0 though it answered ok', async () => {
    surfaceLineExecute_mock.mockImplementation(async (_engine: unknown, line: string): Promise<CommandEnvelope[]> => [{ status: 'ok', rendered: `${line}\n` }]);
    exitTake_mock.mockImplementation(((): (() => number) => { let calls: number = 0; return (): number => { calls += 1; return calls === 4 ? 1 : 0; }; })());
    await remote_run(berth.identity, 'pwd; berth close; ls', undefined, { stopOnError: true });
    expect(surfaceLineExecute_mock.mock.calls.map((call: unknown[]) => call[1])).toEqual(['pwd', 'berth close']);
    expect(process.exitCode).toBe(1);
    exitTake_mock.mockReset();
    exitTake_mock.mockReturnValue(0);
  });

  it('splits a line on semicolons outside quotes', () => {
    expect(commands_split('pwd; cd "a;b"; echo \'x;y\' ;; ls')).toEqual(['pwd', 'cd "a;b"', "echo 'x;y'", 'ls']);
    expect(commands_split('say "a\\"b;c"; pwd')).toEqual(['say "a\\"b;c"', 'pwd']);
    expect(commands_split('  ')).toEqual([]);
  });

  it('with several sessions and no terminal to pick on, names them and exits 1', async () => {
    const errors: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { errors.push(String(line)); });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('exit 1'); }) as typeof process.exit);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    resolverResolve_mock.mockResolvedValue(null);
    resolverList_mock.mockResolvedValue([berth, { ...berth, identity: 'kim@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:5555' }]);
    await expect(remote_run(undefined)).rejects.toThrow('exit 1');
    expect(errors.join('\n')).toContain('Several calypso sessions are running');
    expect(errors.join('\n')).toContain('kim@https://cube.example.org/api/v1/');
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    errSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('returns failure status and still closes when an envelope reports error', async () => {
    const envelopes: CommandEnvelope[] = [{ status: 'error', rendered: 'failed\n' }];
    surfaceLineExecute_mock.mockResolvedValue(envelopes);

    await remote_run(berth.identity, 'bad-command');

    expect(process.exitCode).toBe(1);
    expect(remoteClose_mock).toHaveBeenCalledTimes(1);
  });

  it('returns failure status and still closes when execution rejects', async () => {
    const error_spy = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    surfaceLineExecute_mock.mockRejectedValue(new Error('daemon rejected command'));

    await remote_run(berth.identity, 'bad-command');

    expect(process.exitCode).toBe(1);
    expect(remoteClose_mock).toHaveBeenCalledTimes(1);
    expect(error_spy).toHaveBeenCalledWith(expect.stringContaining('daemon rejected command'));
  });

  it('keeps the existing interactive REPL path when no command is given, greeting first', async () => {
    const log_spy = jest.spyOn(console, 'log').mockImplementation((): void => undefined);
    surfaceLineExecute_mock.mockResolvedValue([{ status: 'ok', rendered: 'Welcome to chell, chris.\n412 feeds\n' }]);
    await remote_run(berth.identity);

    expect(replStart_mock).toHaveBeenCalledTimes(1);
    // The one line executed before the REPL is the session's greeting, the
    // kernel's `motd` naming this surface; no operator command ran.
    expect(surfaceLineExecute_mock).toHaveBeenCalledTimes(1);
    expect(surfaceLineExecute_mock.mock.calls[0]?.[1]).toBe('motd chell');
    expect(log_spy.mock.calls.some((call) => String(call[0]).includes('Welcome to chell, chris.'))).toBe(true);
    expect(remoteClose_mock).not.toHaveBeenCalled();
    log_spy.mockRestore();
  });

  it('greets nothing, and says nothing, when the session cannot answer motd', async () => {
    const log_spy = jest.spyOn(console, 'log').mockImplementation((): void => undefined);
    surfaceLineExecute_mock.mockRejectedValue(new Error('unknown command: motd'));
    await remote_run(berth.identity);

    expect(replStart_mock).toHaveBeenCalledTimes(1);
    // The surface's own welcome line still prints; the session's greeting does not.
    expect(log_spy.mock.calls.some((call) => String(call[0]).includes('Welcome to chell'))).toBe(false);
    log_spy.mockRestore();
  });

  it('banners the daemon-reported stack on interactive attach', async () => {
    const log_spy = jest.spyOn(console, 'log').mockImplementation((): void => undefined);
    remoteConnect_mock.mockResolvedValue({
      close: remoteClose_mock,
      exitCode_take: exitTake_mock,
      promptLine: jest.fn((): string => ''),
      daemonStack: jest.fn(() => ({
        chell: '5.3.0', calypso: '0.5.0', build: 'abc123',
        brasa: '0.10.0', chili: '3.5.0', salsa: '2.1.0', cumin: '3.9.0',
      })),
    });

    await remote_run(berth.identity);

    const printed: string = log_spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    log_spy.mockRestore();
    expect(printed).toContain('v 5.3.0 (abc123)');
    // Every layer the daemon reported is written out in full, its version beside it.
    for (const [layer, version] of [['CHELL', '5.3.0'], ['BRASA', '0.10.0'], ['CHILI', '3.5.0'], ['SALSA', '2.1.0'], ['CUMIN', '3.9.0'], ['CALYPSO', '0.5.0']]) {
      expect(printed).toContain(`${layer} written out  ${version}`);
    }
    expect(replStart_mock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the local welcome line when the daemon reports no stack', async () => {
    const log_spy = jest.spyOn(console, 'log').mockImplementation((): void => undefined);
    await remote_run(berth.identity);
    const printed: string = log_spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    log_spy.mockRestore();
    expect(printed).toContain('Welcome.');
    expect(printed).toContain('Attached to CALYPSO daemon');
  });

  it('wires interactive daemon callbacks to the local surface', async () => {
    const stdout_spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit_spy = jest.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('daemon disconnected');
    }) as typeof process.exit);
    prompt_mock.mockResolvedValue('answer');
    pipeSegment_mock.mockResolvedValue(Buffer.from('output'));
    shellCommand_mock.mockResolvedValue(0);
    localEdit_mock.mockResolvedValue({ content: 'edited', changed: true });

    await remote_run(berth.identity);
    const options: RemoteEngineOptions = remoteConnect_mock.mock.calls[0][0];
    const session_dispatch = options.onSession;
    const prompt_dispatch = options.onPrompt;
    const pipe_dispatch = options.onPipe;
    const shell_dispatch = options.onShell;
    const edit_dispatch = options.onEdit;
    const close_dispatch = options.onClose;
    if (!session_dispatch || !prompt_dispatch || !pipe_dispatch || !shell_dispatch || !edit_dispatch || !close_dispatch) {
      throw new Error('interactive callbacks were not connected');
    }

    session_dispatch('abcdef123', { status: 'ok', rendered: 'background output\n' });
    session_dispatch('abcdef123', { status: 'ok', rendered: '' });
    await expect(prompt_dispatch('Question?', false)).resolves.toBe('answer');
    await expect(pipe_dispatch('wc -l', Buffer.from('input'))).resolves.toEqual(Buffer.from('output'));
    await expect(shell_dispatch('pwd')).resolves.toBe(0);
    await expect(edit_dispatch('before', '.txt')).resolves.toEqual({ content: 'edited', changed: true });
    expect(() => close_dispatch()).toThrow('daemon disconnected');

    expect(stdout_spy).toHaveBeenCalledWith(expect.stringContaining('background output'));
    expect(prompt_mock).toHaveBeenCalledWith({ message: 'Question?', hidden: false });
    expect(pipeSegment_mock).toHaveBeenCalledWith('wc -l', Buffer.from('input'));
    expect(shellCommand_mock).toHaveBeenCalledWith('pwd');
    expect(localEdit_mock).toHaveBeenCalledWith({ content: 'before', extension: '.txt' });
    expect(exit_spy).toHaveBeenCalledWith(0);
  });

  it('reports an attach failure and exits unsuccessfully', async () => {
    const error_spy = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    const exit_spy = jest.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit 1');
    }) as typeof process.exit);
    remoteConnect_mock.mockRejectedValue(new Error('handshake failed'));

    await expect(remote_run(berth.identity)).rejects.toThrow('exit 1');
    expect(error_spy).toHaveBeenCalledWith(expect.stringContaining('handshake failed'));
    expect(exit_spy).toHaveBeenCalledWith(1);
  });
});

describe('berth_parse', () => {
  it('takes the ARGUS link the daemon prints, token and all', () => {
    // One thing to copy: the same URL that opens the web surface also names
    // the wire, because the daemon serves both on one port.
    const berth = berth_parse('http://pangea:41234/?token=abc123');

    expect(berth).toEqual({
      identity: 'ws://pangea:41234 (attached by address)',
      url: 'ws://pangea:41234',
      token: 'abc123',
    });
  });

  it('takes a bare wire URL with the token beside it', () => {
    const berth = berth_parse('ws://pangea:41234', 'abc123');

    expect(berth?.url).toBe('ws://pangea:41234');
    expect(berth?.token).toBe('abc123');
  });

  it('prefers an explicit token over one carried in the URL', () => {
    const berth = berth_parse('http://pangea:41234/?token=stale', 'fresh');

    expect(berth?.token).toBe('fresh');
  });

  it('keeps TLS when the address is secure', () => {
    expect(berth_parse('https://pangea/?token=t')?.url).toBe('wss://pangea');
    expect(berth_parse('wss://pangea:9/?token=t')?.url).toBe('wss://pangea:9');
  });

  it('refuses an address with no token rather than attaching anonymously', () => {
    expect(berth_parse('ws://pangea:41234')).toBeNull();
  });

  it('refuses something that is not a URL', () => {
    expect(berth_parse('pangea:41234', 't')).toBeNull();
  });
});
