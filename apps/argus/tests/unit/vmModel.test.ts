/**
 * @file The VM controller's model: a VM's lines picked out of a script, the
 * script a kept VM synthesizes when none declares it, the build line added
 * where a script lacks it, the deploy line placed after the build, and the
 * machine's condition word.
 */
import { describe, it, expect } from '@jest/globals';
import type { VmStatusRow } from '@fnndsc/menu';
import { lines_build } from '../../src/features/script/model.js';
import { berthsHold_words, lineBerthLimits_read, lineBerths_read, settingRows_derive, settingValue_why, vmCondition_derive, vmLines_filter, vmName_valid, vmNewLine_compose, vmScript_append, vmScript_complete, vmScript_synthesize } from '../../src/features/vm/model.js';

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
  describe('the CHRIS settings rows', () => {
    const DEPLOY: string = 'chris deploy store --profile minimal --host cube.example.org --porter porter.example.org';
    const rows = (text: string, runs: Parameters<typeof settingRows_derive>[2]): string[][] => settingRows_derive(text, 'store', runs).map((row) => [row.field, row.setTo, row.runs, row.edited ? 'changes' : '']);

    it('reads BERTHS, BERTH CPU and BERTH MEMORY off the line: on with a porter and the defaults for what it does not name, and nothing running as a dash', () => {
      expect(rows(DEPLOY, null).slice(3)).toEqual([['BERTHS', 'on', '—', ''], ['BERTH CPU', '1', '—', ''], ['BERTH MEMORY', '2 GiB', '—', '']]);
      expect(rows(`${DEPLOY} --berth-cpus 1.50 --berth-memory 4.0`, null).slice(4)).toEqual([['BERTH CPU', '1.5', '—', ''], ['BERTH MEMORY', '4 GiB', '—', '']]);
    });

    it('shows BERTHS off with no porter, and no limits where berths are off', () => {
      expect(rows('chris deploy store --profile minimal', null).slice(3)).toEqual([['BERTHS', 'off', '—', ''], ['BERTH CPU', '—', '—', ''], ['BERTH MEMORY', '—', '—', '']]);
      expect(rows(`${DEPLOY} --berths off`, null).slice(3)).toEqual([['BERTHS', 'off', '—', ''], ['BERTH CPU', '—', '—', ''], ['BERTH MEMORY', '—', '—', '']]);
    });

    it('sets the line beside what runs: a record from before limits ran the defaults, and a changed limit is marked', () => {
      const runs = { compute: 'store', host: 'cube.example.org', porter: 'porter.example.org', berths: true, berthLimits: null };
      expect(rows(DEPLOY, runs).slice(3)).toEqual([['BERTHS', 'on', 'on', ''], ['BERTH CPU', '1', '1', ''], ['BERTH MEMORY', '2 GiB', '2 GiB', '']]);
      expect(rows(`${DEPLOY} --berth-cpus 2 --berth-memory 4`, { ...runs, berthLimits: { cpus: 1, memoryGib: 2 } }).slice(4)).toEqual([['BERTH CPU', '2', '1', 'changes'], ['BERTH MEMORY', '4 GiB', '2 GiB', 'changes']]);
      expect(rows(`${DEPLOY} --berths off`, runs).slice(3)).toEqual([['BERTHS', 'off', 'on', 'changes'], ['BERTH CPU', '—', '1', ''], ['BERTH MEMORY', '—', '2 GiB', '']]);
      expect(rows(DEPLOY, { ...runs, berths: false }).slice(3)).toEqual([['BERTHS', 'on', 'off', 'changes'], ['BERTH CPU', '1', '—', ''], ['BERTH MEMORY', '2 GiB', '—', '']]);
      expect(rows(DEPLOY, { ...runs, berths: null }).slice(3, 4)).toEqual([['BERTHS', 'on', '—', '']]);
    });

    it('refuses what the engine would: cpus positive with two decimals, memory positive with one, both and BERTHS on needing a PORTER', () => {
      expect(settingValue_why('--berth-cpus', '1.25', DEPLOY)).toBeNull();
      expect(settingValue_why('--berth-cpus', '1.255', DEPLOY)).toBe('a positive number of CPUs, at most two decimals');
      expect(settingValue_why('--berth-cpus', '0', DEPLOY)).toBe('a positive number of CPUs, at most two decimals');
      expect(settingValue_why('--berth-cpus', '-1', DEPLOY)).toBe('a positive number of CPUs, at most two decimals');
      expect(settingValue_why('--berth-cpus', 'two', DEPLOY)).toBe('a positive number of CPUs, at most two decimals');
      expect(settingValue_why('--berth-memory', '2.5', DEPLOY)).toBeNull();
      expect(settingValue_why('--berth-memory', '2.55', DEPLOY)).toBe('a positive number of GiB, at most one decimal');
      expect(settingValue_why('--berth-memory', '0.0', DEPLOY)).toBe('a positive number of GiB, at most one decimal');
      expect(settingValue_why('--berth-memory', '4', 'chris deploy store --profile minimal')).toBe('berths need a PORTER first');
      expect(settingValue_why('--berth-cpus', '2', 'chris deploy store --profile minimal')).toBe('berths need a PORTER first');
      expect(settingValue_why('--berth-cpus', '2', `${DEPLOY} --berths off`)).toBe('berths are off: set BERTHS on, or leave this empty');
      expect(settingValue_why('--berths', 'on', DEPLOY)).toBeNull();
      expect(settingValue_why('--berths', 'on', 'chris deploy store --profile minimal')).toBe('berths need a PORTER first');
      expect(settingValue_why('--berths', 'off', 'chris deploy store --profile minimal')).toBeNull();
      expect(settingValue_why('--berths', 'maybe', DEPLOY)).toBe('on or off');
      expect(settingValue_why('--berth-cpus', '', DEPLOY)).toBeNull();
      expect(settingValue_why('--berths', '', DEPLOY)).toBeNull();
      expect(settingValue_why('--berths', 'off', `${DEPLOY} --berth-cpus 2`)).toBe('clear BERTH CPU and BERTH MEMORY first');
      expect(settingValue_why('--berths', 'off', `${DEPLOY} --berth-memory 4`)).toBe('clear BERTH CPU and BERTH MEMORY first');
      expect(settingValue_why('--berths', 'off', DEPLOY)).toBeNull();
      expect(settingValue_why('--porter', '', `${DEPLOY} --berth-cpus 2`)).toBe('berths need a porter: clear BERTHS, BERTH CPU and BERTH MEMORY first');
    });

    it('refuses limits the machine cannot hold above the profile\'s floor, when its shape is known', () => {
      const shape = { vcpu: 4, memory: 16 };
      expect(settingValue_why('--berth-cpus', '4', DEPLOY, shape)).toBe('berths of 4 vCPU · 2 GiB do not fit this machine above the minimal profile\'s floor (4 vCPU, 16 GiB; the floor takes 2 vCPU, 4 GiB)');
      expect(settingValue_why('--berth-cpus', '2', DEPLOY, shape)).toBeNull();
      expect(settingValue_why('--berth-memory', '12.5', DEPLOY, shape)).toBe('berths of 1 vCPU · 12.5 GiB do not fit this machine above the minimal profile\'s floor (4 vCPU, 16 GiB; the floor takes 2 vCPU, 4 GiB)');
      // The other limit is the line's own.
      expect(settingValue_why('--berth-memory', '4', `${DEPLOY} --berth-cpus 3`, shape)).toBe('berths of 3 vCPU · 4 GiB do not fit this machine above the minimal profile\'s floor (4 vCPU, 16 GiB; the floor takes 2 vCPU, 4 GiB)');
      expect(settingValue_why('--berth-cpus', '4', DEPLOY, null)).toBeNull();
      expect(settingValue_why('--berth-cpus', '4', DEPLOY, { vcpu: null, memory: 16 })).toBeNull();
    });

    it('reads whether berths are on and what one may use, off the line', () => {
      expect(lineBerths_read(DEPLOY)).toBe(true);
      expect(lineBerths_read(`${DEPLOY} --berths off`)).toBe(false);
      expect(lineBerths_read('chris deploy store --profile minimal')).toBe(false);
      expect(lineBerthLimits_read(DEPLOY)).toEqual({ cpus: 1, memoryGib: 2 });
      expect(lineBerthLimits_read(`${DEPLOY} --berth-cpus 0.5 --berth-memory 1.5`)).toEqual({ cpus: 0.5, memoryGib: 1.5 });
      expect(lineBerthLimits_read(`${DEPLOY} --berth-cpus 0`)).toBeNull();
    });
  });

  describe('the berths a machine holds', () => {
    const DEPLOY: string = 'chris deploy store --profile minimal --host cube.example.org --porter porter.example.org';
    const RUNS = { compute: 'store', host: 'cube.example.org', porter: 'porter.example.org', berths: true, berthLimits: { cpus: 2, memoryGib: 4 } };

    it('counts the host above the profile\'s floor over the limits that run, the scarcer of CPU and memory deciding', () => {
      expect(berthsHold_words({ vcpu: 6, memory: 16 }, DEPLOY, RUNS, 'minimal')).toBe('holds 2 berths');
      expect(berthsHold_words({ vcpu: 4, memory: 8 }, DEPLOY, RUNS, 'minimal')).toBe('holds 1 berth');
      expect(berthsHold_words({ vcpu: 2, memory: 8 }, DEPLOY, RUNS, 'minimal')).toBe('holds 0 berths');
    });

    it('takes the limits of the line when nothing runs, and the defaults for a record from before limits', () => {
      expect(berthsHold_words({ vcpu: 4, memory: 8 }, DEPLOY, null, 'minimal')).toBe('holds 2 berths');
      expect(berthsHold_words({ vcpu: 4, memory: 8 }, `${DEPLOY} --berth-cpus 2`, null, 'minimal')).toBe('holds 1 berth');
      expect(berthsHold_words({ vcpu: 4, memory: 8 }, `${DEPLOY} --berth-cpus 2`, { ...RUNS, berthLimits: null }, 'minimal')).toBe('holds 2 berths');
    });

    it('adds the count at the line\'s limits when they differ from what runs, only when asked', () => {
      const host = { vcpu: 6, memory: 16 };
      expect(berthsHold_words(host, `${DEPLOY} --berth-cpus 1 --berth-memory 4`, RUNS, 'minimal', true)).toBe('holds 2 berths · 3 after the change');
      expect(berthsHold_words(host, `${DEPLOY} --berth-cpus 1 --berth-memory 4`, RUNS, 'minimal')).toBe('holds 2 berths');
      expect(berthsHold_words(host, `${DEPLOY} --berth-cpus 5`, RUNS, 'minimal', true)).toBe('holds 2 berths · 0 after the change');
      expect(berthsHold_words({ vcpu: 4, memory: 8 }, `${DEPLOY} --berth-cpus 2 --berth-memory 4`, { ...RUNS, berthLimits: { cpus: 1, memoryGib: 2 } }, 'minimal', true)).toBe('holds 2 berths · 1 after the change');
      // The same limits, a line with berths off, an invalid limit or nothing running: nothing is added.
      expect(berthsHold_words(host, `${DEPLOY} --berth-cpus 2 --berth-memory 4`, RUNS, 'minimal', true)).toBe('holds 2 berths');
      expect(berthsHold_words(host, `${DEPLOY} --berths off`, RUNS, 'minimal', true)).toBe('holds 2 berths');
      expect(berthsHold_words(host, `${DEPLOY} --berth-cpus 0`, RUNS, 'minimal', true)).toBe('holds 2 berths');
      expect(berthsHold_words(host, `${DEPLOY} --berth-cpus 1`, null, 'minimal', true)).toBe('holds 4 berths');
    });

    it('says nothing when berths are off, the shape is unknown, or the line names no limits it can read', () => {
      expect(berthsHold_words({ vcpu: 6, memory: 16 }, DEPLOY, { ...RUNS, berths: false }, 'minimal')).toBeNull();
      expect(berthsHold_words({ vcpu: 6, memory: 16 }, `${DEPLOY} --berths off`, null, 'minimal')).toBeNull();
      expect(berthsHold_words({ vcpu: 6, memory: 16 }, 'chris deploy store --profile minimal', null, 'minimal')).toBeNull();
      expect(berthsHold_words({ vcpu: 6, memory: 16 }, null, null, 'minimal')).toBeNull();
      expect(berthsHold_words({ vcpu: 6, memory: 16 }, `${DEPLOY} --berth-cpus 0`, null, 'minimal')).toBeNull();
      expect(berthsHold_words(null, DEPLOY, RUNS, 'minimal')).toBeNull();
      expect(berthsHold_words({ vcpu: null, memory: 16 }, DEPLOY, RUNS, 'minimal')).toBeNull();
      expect(berthsHold_words({ vcpu: 6, memory: null }, DEPLOY, RUNS, 'minimal')).toBeNull();
    });
  });
});
