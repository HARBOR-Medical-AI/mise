import { describe, it, expect } from '@jest/globals';
import { commandList_parse, semicolons_parse } from '../src/lib/semicolonParser.js';

describe('semicolons_parse', () => {
  it('should return single command unchanged', () => {
    expect(semicolons_parse('ls /home')).toEqual(['ls /home']);
  });

  it('should split semicolon-separated commands', () => {
    expect(semicolons_parse('ls; pwd')).toEqual(['ls', 'pwd']);
  });

  it('should split multiple commands with semicolons', () => {
    expect(semicolons_parse('cd /tmp; ls; pwd')).toEqual(['cd /tmp', 'ls', 'pwd']);
  });

  it('should trim whitespace around commands', () => {
    expect(semicolons_parse('ls  ;  pwd  ;  cd /tmp')).toEqual(['ls', 'pwd', 'cd /tmp']);
  });

  it('should preserve semicolons inside single quotes', () => {
    expect(semicolons_parse("echo 'a;b'; pwd")).toEqual(["echo 'a;b'", "pwd"]);
  });

  it('should preserve semicolons inside double quotes', () => {
    expect(semicolons_parse('echo "a;b"; pwd')).toEqual(['echo "a;b"', 'pwd']);
  });

  it('should handle mixed quotes and semicolons', () => {
    expect(semicolons_parse('echo "hello;world"; ls; echo \'foo;bar\'')).toEqual([
      'echo "hello;world"',
      'ls',
      "echo 'foo;bar'"
    ]);
  });

  it('should handle nested quotes', () => {
    expect(semicolons_parse('echo "it\'s;ok"; pwd')).toEqual(['echo "it\'s;ok"', 'pwd']);
  });

  it('should ignore empty commands from consecutive semicolons', () => {
    expect(semicolons_parse('ls;; pwd')).toEqual(['ls', 'pwd']);
  });

  it('should ignore trailing semicolons', () => {
    expect(semicolons_parse('ls; pwd;')).toEqual(['ls', 'pwd']);
  });

  it('should ignore leading semicolons', () => {
    expect(semicolons_parse('; ls; pwd')).toEqual(['ls', 'pwd']);
  });

  it('should handle empty string', () => {
    expect(semicolons_parse('')).toEqual([]);
  });

  it('should handle only semicolons', () => {
    expect(semicolons_parse(';;;')).toEqual([]);
  });

  it('should handle complex command with pipes and semicolons', () => {
    expect(semicolons_parse('cat file.txt | grep test; ls -la')).toEqual([
      'cat file.txt | grep test',
      'ls -la'
    ]);
  });

  it('should handle quotes with special characters', () => {
    expect(semicolons_parse('echo "line1;line2"; echo \'line3;line4\'')).toEqual([
      'echo "line1;line2"',
      "echo 'line3;line4'"
    ]);
  });

  it('reads an escaped quote in double quotes as text, so a later semicolon inside them does not split', () => {
    expect(semicolons_parse('touch --withContents "it\\"s a\\\\b; x | y > z" f.txt; cat f.txt')).toEqual([
      'touch --withContents "it\\"s a\\\\b; x | y > z" f.txt',
      'cat f.txt',
    ]);
  });

  it('reads a backslash in single quotes as a character, as POSIX does (#1258)', () => {
    // The quote after the backslash closes the quoted text: the semicolon splits.
    expect(semicolons_parse("echo 'a\\'; pwd")).toEqual(["echo 'a\\'", 'pwd']);
  });

  it('reads an escaped semicolon outside quotes as text', () => {
    expect(semicolons_parse('echo a\\;b; pwd')).toEqual(['echo a\\;b', 'pwd']);
  });
});

describe('commandList_parse', () => {
  it('reads ;, && and || as joiners, each putting its condition on the command after it', () => {
    expect(commandList_parse('cd ~/uploads && pwd')).toEqual([{ command: 'cd ~/uploads', when: 'always' }, { command: 'pwd', when: 'success' }]);
    expect(commandList_parse('ls x || echo none; pwd')).toEqual([
      { command: 'ls x', when: 'always' }, { command: 'echo none', when: 'failure' }, { command: 'pwd', when: 'always' },
    ]);
    expect(commandList_parse('a&&b||c')).toEqual([{ command: 'a', when: 'always' }, { command: 'b', when: 'success' }, { command: 'c', when: 'failure' }]);
  });

  it('keeps a quoted or escaped joiner as text', () => {
    expect(commandList_parse("echo '&&' \"a || b\"")).toEqual([{ command: "echo '&&' \"a || b\"", when: 'always' }]);
    expect(commandList_parse('echo a \\&& b')).toHaveLength(1);
  });

  it('leaves a pipe and a background mark to their own parsers', () => {
    expect(commandList_parse('ls | grep x && pwd')).toEqual([{ command: 'ls | grep x', when: 'always' }, { command: 'pwd', when: 'success' }]);
    expect(commandList_parse('pwd && ls | grep x')).toEqual([{ command: 'pwd', when: 'always' }, { command: 'ls | grep x', when: 'success' }]);
    expect(commandList_parse('sleep 5 &')).toEqual([{ command: 'sleep 5 &', when: 'always' }]);
  });

  it('gives semicolons_parse every command of the list', () => {
    expect(semicolons_parse('cd /tmp && ls; pwd || id')).toEqual(['cd /tmp', 'ls', 'pwd', 'id']);
  });
});
