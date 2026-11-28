/**
 * @file chili's entry points: importing chili runs nothing and trusts no docker; only its command does.
 *
 * Read in a node of its own, as an engine imports the built package: the package is ESM, which this suite's
 * transform does not load whole.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ROOT: string = join(__dirname, '..');

describe('chili\'s root', () => {
  it('imported, as an engine imports it, runs no command and trusts no docker', () => {
    const script: string = [
      `const salsa = await import(${JSON.stringify(join(ROOT, '..', 'salsa', 'dist', 'index.js'))});`,
      `const root = await import(${JSON.stringify(join(ROOT, 'dist', 'index.js'))});`,
      'console.log(JSON.stringify({ main: typeof root.chiliCli_main, trusted: salsa.hostDocker_get() !== null }));',
    ].join('\n');
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', cwd: ROOT, timeout: 60000 });
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({ main: 'function', trusted: false });
  });

  it('its command, and only its command, trusts this process\'s docker', () => {
    const bin: string = require('fs').readFileSync(join(ROOT, 'src', 'bin.ts'), 'utf-8') as string;
    const index: string = require('fs').readFileSync(join(ROOT, 'src', 'index.ts'), 'utf-8') as string;
    expect(bin).toMatch(/^hostDocker_trust\(\);$/m);
    expect(index).not.toMatch(/hostDocker_trust/);
    expect(JSON.parse(require('fs').readFileSync(join(ROOT, 'package.json'), 'utf-8')).bin).toEqual({ chili: 'dist/bin.js' });
  });
});
