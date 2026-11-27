/**
 * @file The run line is the form's only state: values are written into it
 * and read back from it, and a hand edit stands.
 */
import { describe, it, expect } from '@jest/globals';
import {
  runLine_compose,
  runLine_flagGet,
  runLine_flagSet,
  runLine_hasTitle,
  runLine_titleAppend,
  runLine_executable,
  pipelineNode_selector,
} from '../../src/features/files/runLine.js';

describe('runLine', () => {
  const base: string = runLine_compose('/home/me/data a', 'pl-simpledsapp-v2.1.5');

  it('composes the console line: cd into the input, then the executable', () => {
    expect(base).toBe("cd '/home/me/data a'; pl-simpledsapp-v2.1.5");
    expect(runLine_executable(base)).toBe('pl-simpledsapp-v2.1.5');
  });

  it('writes a value as the flag the console takes, and reads it back', () => {
    const line: string = runLine_flagSet(base, '--prefix', 'run-');
    expect(line).toBe("cd '/home/me/data a'; pl-simpledsapp-v2.1.5 --prefix run-");
    expect(runLine_flagGet(line, '--prefix')).toBe('run-');
    expect(runLine_flagGet(line, '--dummyInt')).toBeNull();
  });

  it('replaces a flag where it stands and leaves hand edits alone', () => {
    const typed: string = 'cd "/x"; pl-a --prefix old --dummyInt 3 -- feed_title="T"';
    const line: string = runLine_flagSet(typed, '--prefix', 'new one');
    expect(line).toBe('cd "/x"; pl-a --prefix \'new one\' --dummyInt 3 -- feed_title="T"');
    expect(runLine_flagGet(line, '--prefix')).toBe('new one');
    expect(runLine_hasTitle(line)).toBe(true);
  });

  it('removes a flag on an empty value, and writes a boolean bare', () => {
    const line: string = runLine_flagSet(runLine_flagSet(base, '--prefix', 'p'), '--prefix', '');
    expect(line).toBe(base);
    const bare: string = runLine_flagSet(base, '--ignoreInputDir', true);
    expect(bare).toBe(`${base} --ignoreInputDir`);
    expect(runLine_flagGet(bare, '--ignoreInputDir')).toBe(true);
    expect(runLine_flagSet(bare, '--ignoreInputDir', null)).toBe(base);
  });

  it('reads --flag=value as the console does, and a negative number as a value', () => {
    const line: string = 'cd "/x"; pl-a --prefix=q --dummyInt -3';
    expect(runLine_flagGet(line, '--prefix')).toBe('q');
    expect(runLine_flagGet(line, '--dummyInt')).toBe('-3');
    expect(runLine_flagSet(line, '--prefix', 'r')).toBe('cd "/x"; pl-a --prefix r --dummyInt -3');
  });

  it('appends the title the kernel takes, once', () => {
    expect(runLine_hasTitle(base)).toBe(false);
    const titled: string = runLine_titleAppend(base, 'say "hi"');
    expect(titled).toBe(`${base} -- feed_title='say "hi"'`);
    expect(runLine_hasTitle(titled)).toBe(true);
  });

  it('selects a pipeline node by title when shell-safe and unique, else by @id', () => {
    expect(pipelineNode_selector('convert', '7', ['convert', 'report'])).toBe('convert');
    expect(pipelineNode_selector('convert', '7', ['convert', 'convert'])).toBe('@7');
    expect(pipelineNode_selector('to nifti', '9', ['to nifti'])).toBe('@9');
    expect(runLine_flagSet('cd "/f/n_1/data"; my-pipe', '--convert.outputdir', 'out'))
      .toBe('cd "/f/n_1/data"; my-pipe --convert.outputdir out');
  });
});
