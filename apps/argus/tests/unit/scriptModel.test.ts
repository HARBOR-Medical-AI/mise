/**
 * @file The script screen's model: lines into steps (the user lines gathered
 * under USERS), a line's options read, set and rendered back, the seat's
 * state from its lines', the sliders scaled to what `vm limits` said, the
 * `vm cost` line from a `vm new` line, and the working copy's path.
 */
import { describe, it, expect } from '@jest/globals';
import type { VmLimitsModel } from '@fnndsc/menu';
import {
  askForm_derive, costLine_derive, counts_words, duration_words, line_parse, line_render, lineOption_get, lineOption_set, lines_build, memoryRange_derive,
  rate_words, rates_sum, runningStep_find, scriptName_derive, scriptSource_derive, stepBuildLine_get, stepKind_derive, stepKind_isTask, stepLabel_derive, steps_build, states_count, userLine_build,
  vmLevers_read, vmSliders_build, words_split, workingCopy_derive, script_render, type ScriptStep,
} from '../../src/features/script/model.js';

const STORE: string = [
  '# the store',
  'net new chrisproject-services --cidr 10.20.0.0/16',
  'vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04',
  '',
  'vm build store',
  'chris deploy store --profile minimal --compute NERC --host cube.chrisproject.org --porter porter.chrisproject.org',
  'chris user add rudolph --email rudolph@example.org --password-file ~/.config/chrisproject/store/rudolph-password',
  'chris user add jennings --email jennings@example.org',
].join('\n');

const LIMITS: VmLimitsModel = { shape: 'VM.Standard.E5.Flex', family: 'E5', vcpu: { min: 2, max: 252, step: 2 }, memory: { min: 1, max: 2098, perVcpu: { min: 0.5, max: 32 } }, disk: { min: 50, max: 32768 }, data: { min: 50, max: 32768 } };

describe('the script screen model', () => {
  it('splits words as a shell does and quotes what needs it', () => {
    expect(words_split("chris user add x --email 'a b@c.org' --note \"two words\"")).toEqual(['chris', 'user', 'add', 'x', '--email', 'a b@c.org', '--note', 'two words']);
    expect(line_render(line_parse("vm new s --os 'ubuntu 26'"))).toBe("vm new s --os 'ubuntu 26'");
  });

  it('knows each line\'s kind and label, and takes a line apart and puts it back the same', () => {
    expect(stepKind_derive('vm build store')).toBe('vm build');
    expect(stepKind_derive('chris user add x --email y')).toBe('users');
    expect(stepKind_derive('chris deploy store')).toBe('chris deploy');
    expect(stepKind_derive('echo hello')).toBe('other');
    expect(stepLabel_derive('chris deploy store --profile minimal')).toBe('CHRIS DEPLOY');
    expect(stepLabel_derive('chris user add x')).toBe('USERS');
    expect(stepLabel_derive('cluster build quay')).toBe('CLUSTER BUILD');
    const line: string = 'vm new store --net n --open 80,443 --vcpu 2 --memory 8';
    expect(line_parse(line)).toEqual({ verb: ['vm', 'new'], subject: 'store', options: [['--net', 'n'], ['--open', '80,443'], ['--vcpu', '2'], ['--memory', '8']] });
    expect(line_render(line_parse(line))).toBe(line);
    expect(lineOption_get(line, '--memory')).toBe('8');
    expect(lineOption_get(line, '--disk')).toBeNull();
    // Set in place, appended when new, removed when empty.
    expect(lineOption_set(line, '--memory', '16')).toBe('vm new store --net n --open 80,443 --vcpu 2 --memory 16');
    expect(lineOption_set(line, '--disk', '50')).toBe(`${line} --disk 50`);
    expect(lineOption_set(line, '--open', '')).toBe('vm new store --net n --vcpu 2 --memory 8');
  });

  it('builds the lines from the file and the standings, and the steps with the user lines gathered', () => {
    const standings = [
      { number: 1, text: 'net new chrisproject-services --cidr 10.20.0.0/16', state: 'done' as const, detail: 'unchanged' },
      { number: 2, text: 'vm new store …', state: 'done' as const, detail: 'unchanged' },
      { number: 3, text: 'vm build store', state: 'changed' as const, detail: 'declared again since it was built' },
      { number: 4, text: 'chris deploy store …', state: 'done' as const, detail: 'deployed 2026-11-01' },
      { number: 5, text: 'chris user add rudolph …', state: 'ready' as const, detail: 'asks CUBE when it runs' },
      { number: 6, text: 'chris user add jennings …', state: 'not yet' as const, detail: 'no ChRIS' },
    ];
    const lines = lines_build(STORE, standings);
    expect(lines.map((line) => [line.number, line.state])).toEqual([[1, 'done'], [2, 'done'], [3, 'changed'], [4, 'done'], [5, 'ready'], [6, 'not yet']]);
    // The file's own words are kept, not the status's filled text.
    expect(lines[1]?.text.startsWith('vm new store --net chrisproject-services')).toBe(true);
    const steps = steps_build(lines);
    // The build is gathered under the declaration before it: a size declared and not built reads changed on its one seat.
    expect(steps.map((step) => [step.key, step.label, step.state])).toEqual([
      ['line-1', 'NET NEW', 'done'], ['line-2', 'VM NEW', 'changed'], ['line-4', 'CHRIS DEPLOY', 'done'], ['users', 'USERS', 'not yet'],
    ]);
    expect(steps[1]?.lines.map((line) => line.number)).toEqual([2, 3]);
    expect(stepBuildLine_get(steps[1] as ScriptStep)?.text).toBe('vm build store');
    expect(stepBuildLine_get(steps[0] as ScriptStep)).toBeUndefined();
    expect(steps[3]?.lines.map((line) => line.number)).toEqual([5, 6]);
    expect(counts_words(states_count(lines))).toBe('3 DONE · 1 READY · 1 CHANGED · 1 NOT YET');
    expect(counts_words(states_count([]))).toBe('NOTHING READ');
    expect(script_render(lines).split('\n').length).toBe(7);
    // No standings: every line stands unread.
    expect(lines_build(STORE, []).every((line) => line.state === null)).toBe(true);
    // A line whose task runs now carries the task; its step does; no other does.
    expect(lines.every((line) => line.running === null)).toBe(true);
    expect(runningStep_find(steps)).toBeUndefined();
    const building = lines_build(STORE, standings.map((standing, index) => index === 2 ? { ...standing, running: '/proc/steps/vm-store-apply-machine' } : standing));
    expect(building[2]?.running).toBe('/proc/steps/vm-store-apply-machine');
    const buildingSteps = steps_build(building);
    expect(buildingSteps.map((step) => step.running)).toEqual([null, '/proc/steps/vm-store-apply-machine', null, null]);
    expect(runningStep_find(buildingSteps)?.key).toBe('line-2');
    // The steps whose lines run as tasks, whose run the screen follows rather than holds.
    expect((['net new', 'net build', 'vm new', 'vm build', 'chris deploy', 'users', 'other'] as const).filter(stepKind_isTask)).toEqual(['net build', 'vm build', 'chris deploy', 'users']);
  });

  it('gathers a build under the declaration just before it of the same name, and wears the declaration\'s state until it is done', () => {
    const lines = (texts: string[], states: Array<'done' | 'ready' | 'changed' | 'not yet'>) => texts.map((text, index) => ({ number: index + 1, text, state: states[index] ?? null, detail: '', running: null }));
    const pair = ['net new n --cidr 10.0.0.0/16', 'net build n', 'vm new s --net n', 'vm build s'];
    expect(steps_build(lines(pair, ['done', 'done', 'ready', 'not yet'])).map((step) => [step.key, step.label, step.state, step.lines.length])).toEqual([['line-1', 'NET NEW', 'done', 2], ['line-3', 'VM NEW', 'ready', 2]]);
    expect(steps_build(lines(pair, ['changed', 'done', 'done', 'changed'])).map((step) => step.state)).toEqual(['changed', 'changed']);
    // A build of another name, or one not right after its declaration, keeps a seat of its own.
    expect(steps_build(lines(['vm new s --net n', 'vm build t'], ['done', 'done'])).map((step) => step.label)).toEqual(['VM NEW', 'VM BUILD']);
    expect(steps_build(lines(['vm new s --net n', 'echo hi', 'vm build s'], ['done', null as never, 'done'])).map((step) => step.label)).toEqual(['VM NEW', 'ECHO HI', 'VM BUILD']);
    expect(steps_build(lines(['vm new s --net n', 'vm build s', 'vm build s'], ['done', 'done', 'done'])).map((step) => step.lines.length)).toEqual([2, 1]);
  });

  it('scales the sliders to what the shape sells and bounds the memory by the vCPUs', () => {
    const sliders = vmSliders_build(LIMITS);
    expect(sliders.map((slider) => [slider.word, slider.min, slider.max, slider.step])).toEqual([['--vcpu', 2, 64, 2], ['--memory', 1, 512, 1], ['--disk', 50, 2048, 10], ['--data', 50, 2048, 10]]);
    expect(memoryRange_derive(LIMITS, 2)).toEqual({ min: 1, max: 64 });
    expect(memoryRange_derive(LIMITS, 16)).toEqual({ min: 8, max: 512 });
    expect(memoryRange_derive({ ...LIMITS, memory: { min: 1, max: 100, perVcpu: null } }, 2)).toEqual({ min: 1, max: 100 });
    expect(vmLevers_read('vm new store --net n --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04')).toEqual({ net: 'n', open: null, vcpu: 2, memory: 8, disk: 50, data: 50, dataBackup: 'daily', os: 'ubuntu-26.04' });
  });

  it('prices a vm new line with the same words, cost for new, and sums the rates', () => {
    expect(costLine_derive('vm new store --net n --vcpu 2 --memory 8')).toBe('vm cost store --net n --vcpu 2 --memory 8');
    expect(rate_words({ machineHour: 0.05, dataHour: 0.002, currency: 'USD' }, 730)).toBe('$0.052/H · $37.96 A MONTH');
    expect(rate_words(null, 730)).toBe('NOT PRICED');
    expect(rates_sum([{ machineHour: 1, dataHour: 1, currency: 'USD' }, null, { machineHour: 2, dataHour: 0, currency: 'USD' }])).toEqual({ machineHour: 3, dataHour: 1, currency: 'USD' });
    expect(rates_sum([null])).toBeNull();
  });

  it('names a script, its source and its working copy, and builds a user line', () => {
    expect(scriptName_derive('/scripts/chrisproject/store.mise')).toBe('store');
    expect(scriptSource_derive('/scripts/chrisproject/store.mise')).toBe('chrisproject');
    expect(scriptSource_derive('~/x.mise')).toBe('');
    expect(workingCopy_derive('/scripts/chrisproject/store.mise')).toBe('/scripts/mine/store.mise');
    expect(workingCopy_derive('/scripts/mine/store.mise')).toBe('/scripts/mine/store.mise');
    expect(userLine_build('jennings', 'j@example.org', '', '')).toBe('chris user add jennings --email j@example.org');
    expect(userLine_build('jennings', 'j@example.org', '~/p', 'store')).toBe('chris user add jennings --email j@example.org --password-file ~/p --on store');
  });

  it('reads the form of a question and says a duration', () => {
    expect(askForm_derive('store: build it, $0.052 an hour? [y/N] ')).toBe('yes-no');
    expect(askForm_derive('teardown --all removes the data too; type the name to go on: ')).toBe('name');
    expect(askForm_derive('admin password for chris (empty: generate one): ')).toBe('text');
    expect(duration_words(4000)).toBe('4 s');
    expect(duration_words(200_000)).toBe('3 m 20 s');
    expect(duration_words(3_720_000)).toBe('1 h 02 m');
  });
});
