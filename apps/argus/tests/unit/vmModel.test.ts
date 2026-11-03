/**
 * @file The VM controller's model: a VM's lines picked out of a script, the
 * script a kept VM synthesizes when none declares it, the build line added
 * where a script lacks it, the deploy line placed after the build, and the
 * machine's condition word.
 */
import { describe, it, expect } from '@jest/globals';
import type { VmStatusRow } from '@fnndsc/menu';
import { lines_build } from '../../src/features/script/model.js';
import { vmCondition_derive, vmLines_filter, vmName_valid, vmNewLine_compose, vmScript_append, vmScript_complete, vmScript_synthesize } from '../../src/features/vm/model.js';

const SCRIPT: string = [
  'net new n --cidr 10.20.0.0/16',
  'net build n',
  'vm new store --net n --vcpu 2 --memory 8 --disk 50 --data 50 --os ubuntu-26.04',
  'vm new blt --net n --vcpu 4 --memory 16 --disk 50 --data 1024 --os ubuntu-26.04',
  'vm build store',
  'vm build blt',
  'chris deploy store --profile minimal --compute NERC',
  'chris user add rudolph --email r@example.org --on store',
  'chris user add jen --email j@example.org --on blt',
].join('\n');

const ROW: VmStatusRow = { name: 'kept', state: 'built', region: 'us-ashburn-1', spec: { net: 'n', open: [80, 443], vcpu: 2, memory: 8, disk: 50, data: 50, dataBackup: 'daily', os: 'ubuntu-26.04' }, address: '203.0.113.9', inside: '10.20.0.9', protected: true, built: '2026-11-01T00:00:00Z', chris: { profile: 'minimal', compute: 'NERC', host: 'cube.example.org', url: 'https://cube.example.org/api/v1/', porter: null } };

describe('the VM controller model', () => {
  it('picks one VM\'s lines out of a script: its vm lines, its deploy, the users added on it', () => {
    const lines = lines_build(SCRIPT, []);
    expect(vmLines_filter(lines, 'store').map((line) => line.text)).toEqual([
      'vm new store --net n --vcpu 2 --memory 8 --disk 50 --data 50 --os ubuntu-26.04', 'vm build store', 'chris deploy store --profile minimal --compute NERC', 'chris user add rudolph --email r@example.org --on store',
    ]);
    expect(vmLines_filter(lines, 'blt').map((line) => line.number)).toEqual([4, 6, 9]);
    // A script declaring one VM alone: its user lines need no --on.
    const alone = lines_build('vm new one --net n --vcpu 2 --memory 8 --disk 50 --data 50 --os u\nvm build one\nchris user add a --email a@x.org', []);
    expect(vmLines_filter(alone, 'one').map((line) => line.number)).toEqual([1, 2, 3]);
    expect(vmLines_filter(alone, 'other')).toEqual([]);
  });

  it('synthesizes a kept VM\'s script from its record, completes a build line, and places a deploy after it', () => {
    expect(vmScript_synthesize(ROW)).toBe('vm new kept --net n --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04\nvm build kept\nchris deploy kept --profile minimal --compute NERC --host cube.example.org\n');
    expect(vmScript_synthesize({ ...ROW, spec: null, chris: null })).toBe(`${vmNewLine_compose('kept', 'chrisproject-services')}\nvm build kept\n`);
    expect(vmScript_complete('vm new x --net n\n', 'x')).toBe('vm new x --net n\nvm build x\n');
    expect(vmScript_complete('vm new x --net n\nvm build x\n', 'x')).toBe('vm new x --net n\nvm build x\n');
    expect(vmScript_append('vm new x --net n\nvm build x\nchris user add a --email a@x.org\n', 'x', 'chris deploy x --profile minimal')).toBe('vm new x --net n\nvm build x\nchris deploy x --profile minimal\nchris user add a --email a@x.org\n');
    expect(vmScript_append('net new n --cidr 10.0.0.0/16\n', 'x', 'vm new x --net n')).toBe('net new n --cidr 10.0.0.0/16\nvm new x --net n\n');
  });

  it('takes a hostname label as a name, and words the machine\'s condition', () => {
    expect(['store', 'blt-2', 'a1'].every(vmName_valid)).toBe(true);
    expect(['Store', '1a', '-a', 'a'.repeat(33), ''].some(vmName_valid)).toBe(false);
    expect(vmCondition_derive(null, false)).toBe('NEW');
    expect(vmCondition_derive(ROW, false)).toBe('BUILT');
    expect(vmCondition_derive({ ...ROW, state: 'data only' }, false)).toBe('DATA ONLY');
    expect(vmCondition_derive(ROW, true)).toBe('RUNNING');
  });
});
