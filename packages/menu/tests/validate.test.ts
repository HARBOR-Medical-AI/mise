import {
  clientMessage_parse,
  serverMessage_parse,
  clientMessage_parseJson,
  attach_parse,
} from '../src/validate';
import { CONTRACT_VERSION } from '../src/version';

describe('clientMessage_parse', () => {
  it('accepts each client message shape', () => {
    expect(clientMessage_parse({
      type: 'attach',
      protocolVersion: CONTRACT_VERSION,
      token: 't',
      capabilities: { shellCommands: true },
    }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'execute', id: '1', line: 'ls' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'cancel', id: '1' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'complete', id: '2', prefix: 'l' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'pipeError', pipeId: 'p1', reason: 'failed' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'shellResult', shellId: 's1', exitCode: 0 }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'shellError', shellId: 's2', reason: 'failed' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'promptError', promptId: 'p1', reason: 'cannot prompt' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'editError', editId: 'e1', reason: 'cannot edit' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'watch', subject: '/proc/jobs/feed_7' }).ok).toBe(true);
    expect(clientMessage_parse({ type: 'unwatch', subject: '/proc/jobs/feed_7' }).ok).toBe(true);
  });

  it('a watched report names its subject and one of the known states', () => {
    expect(serverMessage_parse({ type: 'watched', subject: '/proc/jobs/feed_7', state: 'live' }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'watched', subject: '/proc/jobs/feed_7', state: 'sleeping' }).ok).toBe(false);
  });

  it('accepts hidden-input capability declaration without requiring it from older surfaces', () => {
    const declared = clientMessage_parse({
      type: 'attach',
      protocolVersion: CONTRACT_VERSION,
      token: 't',
      capabilities: { shellCommands: false, hiddenInput: true },
    });
    expect(declared.ok).toBe(true);
    if (declared.ok && declared.value?.type === 'attach') {
      expect(declared.value.capabilities?.hiddenInput).toBe(true);
    }

    expect(clientMessage_parse({
      type: 'attach',
      protocolVersion: CONTRACT_VERSION,
      token: 't',
      capabilities: { shellCommands: false },
    }).ok).toBe(true);
  });

  it('rejects an unknown message type with a reason', () => {
    const r = clientMessage_parse({ type: 'nope', id: '1' });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('rejects a message missing a required field, naming the path', () => {
    const r = clientMessage_parse({ type: 'execute', id: '1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('line');
  });

  it('tolerates an unknown additive field', () => {
    const r = clientMessage_parse({ type: 'execute', id: '1', line: 'ls', extra: true });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ type: 'execute', id: '1', line: 'ls' });
  });

  it('rejects a non-object input with a reason', () => {
    const r = clientMessage_parse('not a message');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

describe('serverMessage_parse', () => {
  it('accepts a result carrying envelopes', () => {
    const r = serverMessage_parse({
      type: 'result',
      id: '1',
      envelopes: [{ status: 'ok', rendered: 'x' }],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts output, session, complete reply, attached and error', () => {
    expect(serverMessage_parse({ type: 'output', id: '1', channel: 'status', chunk: '...' }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'progress', id: '1', operation: 'upload', phase: 'transferring', current: 1, total: 2, unit: 'files', status: 'running' }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'session', surface: 'cli', envelope: { status: 'ok', rendered: 'x' } }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'complete', id: '2', prefix: 'l', candidates: ['ls'] }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'attached', session: 's', protocolVersion: CONTRACT_VERSION }).ok).toBe(true);
    expect(serverMessage_parse({
      type: 'attached',
      session: 's',
      protocolVersion: CONTRACT_VERSION,
      stack: { chell: '5.3.0', calypso: '0.5.0', build: 'abc123' },
    }).ok).toBe(true);
    expect(serverMessage_parse({
      type: 'attached',
      session: 's',
      protocolVersion: CONTRACT_VERSION,
      stack: {
        chell: '5.3.0', calypso: '0.5.0', build: 'abc123',
        brasa: '0.10.0', chili: '3.5.0', salsa: '2.1.0', cumin: '3.9.0',
      },
    }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'error', reason: 'bad token' }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'shell', shellId: 's1', command: 'pwd' }).ok).toBe(true);
  });

  it('accepts semantic Pipeline inspection progress', () => {
    expect(serverMessage_parse({
      type: 'progress',
      id: '1',
      operation: 'pipeline',
      kind: 'inspection',
      phase: 'reading',
      label: 'Reading registered pipeline…',
      status: 'running',
    }).ok).toBe(true);
  });

  it('accepts additive proc totals and legacy loaded-only prompt progress', () => {
    const context = {
      user: 'chris', uri: 'http://cube/', cwd: '/', pacsserver: null,
      physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
    };
    expect(serverMessage_parse({
      type: 'promptline', context: { ...context, procWarmup: { loaded: 25, total: 100 } },
    }).ok).toBe(true);
    expect(serverMessage_parse({
      type: 'promptline', context: { ...context, procWarmup: { loaded: 25 } },
    }).ok).toBe(true);
  });

  it('preserves proc cache state across the prompt wire contract', (): void => {
    expect(serverMessage_parse({
      type: 'promptline',
      context: {
        user: 'chris', uri: 'http://cube/', cwd: '/', pacsserver: null,
        physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
        procWarmup: { loaded: 25, total: 100, restored: true, state: 'cached' },
      },
    }).value).toEqual({
      type: 'promptline',
      context: {
        user: 'chris', uri: 'http://cube/', cwd: '/', pacsserver: null,
        physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
        procWarmup: { loaded: 25, total: 100, restored: true, state: 'cached' },
      },
    });
  });

  it('carries a backend\'s prompt segments and refuses a tone it does not know', (): void => {
    const context = {
      user: 'rudolph', uri: 'fnndsc', cwd: '/net/oci/fnndsc/clusters', pacsserver: null,
      physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
    };
    const segments = [
      { key: 'cloud', label: 'cloud', value: 'OCI', tone: 'leader' },
      { key: 'cwd', label: 'working directory', value: '/net/oci/fnndsc/clusters', tone: 'path' },
    ];
    const parsed = serverMessage_parse({ type: 'promptline', context: { ...context, segments } });
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual({ type: 'promptline', context: { ...context, segments } });
    expect(serverMessage_parse({ type: 'promptline', context }).ok).toBe(true);
    expect(serverMessage_parse({ type: 'promptline', context: { ...context, segments: [{ key: 'x', label: 'x', value: 'x', tone: 'loud' }] } }).ok).toBe(false);
  });

  it('rejects an output on an unknown channel', () => {
    expect(serverMessage_parse({ type: 'output', id: '1', channel: 'sideband', chunk: 'x' }).ok).toBe(false);
  });

  it('rejects malformed progress counters', () => {
    expect(serverMessage_parse({ type: 'progress', id: '1', operation: 'upload', phase: 'transferring', current: -1 }).ok).toBe(false);
    expect(serverMessage_parse({ type: 'progress', id: '1', operation: 'upload', phase: 'transferring', percent: 101 }).ok).toBe(false);
  });

  it('degrades an unknown operation or phase instead of dropping the message', () => {
    // The contract promises additive change within a major. A surface built
    // against an older enum must therefore still show a newer peer's work,
    // generically, rather than failing the parse and discarding it.
    const parsed = serverMessage_parse({
      type: 'progress', id: '1', operation: 'teleport', phase: 'vibrating', label: 'Hmm',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual({
      type: 'progress', id: '1', operation: 'task', phase: 'working', label: 'Hmm',
    });
  });

  it('degrades the remaining progress enums rather than dropping the message', () => {
    // Half-tolerance is worse than either extreme: the message type would look
    // additive-safe while three of its five enums still failed the parse.
    const parsed = serverMessage_parse({
      type: 'progress', id: '1', operation: 'upload', phase: 'transferring',
      kind: 'divination', unit: 'furlongs', status: 'perplexed', current: 3, total: 10,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual({
      type: 'progress', id: '1', operation: 'upload', phase: 'transferring',
      status: 'unknown', current: 3, total: 10,
    });
  });
});

describe('clientMessage_parseJson', () => {
  it('parses valid JSON into a message', () => {
    const r = clientMessage_parseJson(JSON.stringify({ type: 'execute', id: '1', line: 'pwd' }));
    expect(r.ok).toBe(true);
  });

  it('rejects malformed JSON with a clear reason', () => {
    const r = clientMessage_parseJson('{ not json');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('malformed JSON');
  });
});

describe('attach_parse', () => {
  it('accepts an attach on the current contract version', () => {
    const r = attach_parse({ type: 'attach', protocolVersion: CONTRACT_VERSION, token: 't' });
    expect(r.ok).toBe(true);
  });

  it('refuses an attach on an incompatible version', () => {
    const r = attach_parse({ type: 'attach', protocolVersion: CONTRACT_VERSION + 1, token: 't' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('incompatible contract version');
  });

  it('rejects a structurally invalid attach before the version check', () => {
    const r = attach_parse({ type: 'attach', token: 't' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('protocolVersion');
  });
});
