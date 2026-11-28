/**
 * @file The reader's recall, with a real readline: a line is clean in
 * recall the moment it is accepted, so two lines typed ahead of a running
 * command are both clean before either runs and stay so when the queue is
 * thrown away; and a hidden reply never enters recall.
 */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { PassThrough } from 'node:stream';

jest.unstable_mockModule('@fnndsc/brasa', () => ({
  // The private copy a local edit opens (cliSurface imports them; nothing here edits).
  privateTemp_write: jest.fn(),
  suffix_safe: jest.fn(),
  segment_pipeThrough: jest.fn(async (): Promise<Buffer> => Buffer.from('')),
  file_read: jest.fn(),
  wireName_place: jest.fn(),
}));

const readline = await import('readline');
const { cliSurface_create } = await import('../src/core/cliSurface.js');
const { recall_accept } = await import('../src/core/history.js');
const { typeahead_clear, typeahead_push, typeahead_take } = await import('../src/core/lineDiscipline.js');

/** Lets readline read what was written to it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('recall, as the shell wires it', () => {
  let rl: import('readline').Interface;
  afterEach(() => { rl.close(); typeahead_clear(); });

  /** A reader over a terminal that is not there, wired as repl.ts wires its `line` event; lines wait in the typeahead queue as behind a running command. */
  function reader_make(): { input: PassThrough; recall: () => string[] } {
    const input: PassThrough = new PassThrough();
    rl = readline.createInterface({ input, output: new PassThrough(), terminal: true, historySize: 100 });
    rl.on('line', (line: string): void => {
      recall_accept(Reflect.get(rl, 'history'), line);
      typeahead_push(line);
    });
    return { input, recall: (): string[] => [...(Reflect.get(rl, 'history') as string[])] };
  }

  it('two lines typed ahead of a running command are both clean in recall before either runs, and the lines to run are as typed', async () => {
    const { input, recall } = reader_make();
    input.write('connect --user r --password hunter2 https://cube/api/v1/\r');
    input.write('plugin add pl-x --adminPassword "chris 1234"\r');
    await settle();
    expect(recall()).toEqual(["plugin add pl-x --adminPassword '***'", "connect --user r --password '***' https://cube/api/v1/"]);
    // What waits to be run is what was typed: the command needs its password.
    expect(typeahead_take()).toBe('connect --user r --password hunter2 https://cube/api/v1/');
    expect(typeahead_take()).toBe('plugin add pl-x --adminPassword "chris 1234"');
  });

  it('a queue thrown away unrun leaves nothing raw behind in recall', async () => {
    const { input, recall } = reader_make();
    input.write('connect -p hunter2 rudolph@https://cube/\r');
    input.write('connect --password "half open\r');
    await settle();
    typeahead_clear();
    expect(recall()).toEqual(["connect -p '***' rudolph@https://cube/"]);
    expect(recall().join('\n')).not.toContain('hunter2');
    expect(recall().join('\n')).not.toContain('half open');
  });

  it('a hidden reply is read and is not in recall afterwards; a line before it stays', async () => {
    const { input, recall } = reader_make();
    input.write('ls\r');
    await settle();
    const asked: Promise<string> = cliSurface_create(rl).prompt({ message: 'Password: ', hidden: true });
    await settle();
    input.write('hunter2\r');
    expect(await asked).toBe('hunter2');
    expect(recall()).toEqual(['ls']);
  });
});
