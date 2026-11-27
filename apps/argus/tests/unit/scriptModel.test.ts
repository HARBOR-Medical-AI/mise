/**
 * @file The script screen's model: lines into steps (the user lines gathered
 * under USERS), a line's options read, set and rendered back, the seat's
 * state from its lines', the sliders scaled to what `vm limits` said, the
 * `vm cost` line from a `vm new` line, and the working copy's path.
 */
import { describe, it, expect } from '@jest/globals';
import type { VmLimitsModel } from '@fnndsc/menu';
import { buildWould_derive, ports_word, askForm_derive, costLine_derive, counts_words, duration_words, line_parse, line_render, lineOption_get, lineOption_set, lines_build, memoryRange_derive, rate_words, rates_sum, runningStep_find, scriptName_derive, scriptSource_derive, stepBuildLine_get, stepKind_derive, stepKind_isTask, stepLabel_derive, steps_build, states_count, userLine_build, vmLevers_read, vmSliders_build, words_split, workingCopy_derive, script_render, type ScriptStep } from '../../src/features/script/model.js';
import { args_tokenize } from '../../../../packages/brasa/src/lib/parser.js';

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
    // A yes-or-no is one by its kind, whatever it says; words that look like one, with another kind, are not.
    expect(askForm_derive('store: build it at this price', 'confirm')).toBe('yes-no');
    expect(askForm_derive('store: build it, $0.052 an hour? [y/N] ', 'text')).toBe('text');
    expect(askForm_derive('teardown --all removes the data too; type the name to go on: ', 'text')).toBe('name');
    expect(askForm_derive('admin password for chris (empty: generate one): ', 'text')).toBe('text');
    expect(duration_words(4000)).toBe('4 s');
    expect(duration_words(200_000)).toBe('3 m 20 s');
    expect(duration_words(3_720_000)).toBe('1 h 02 m');
  });
});

describe('what BUILD would do against what runs', () => {
  const RUNS = { vcpu: 2, memory: 8, disk: 50, data: 50, open: [80, 443], backup: 'daily', os: 'ubuntu-26.04' };
  const BASE: string = 'vm new store --net n --open 443,80 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04';
  const line = (more: string): string => {
    const words: string[] = more.split(' ').filter((word: string): boolean => word !== '');
    let text: string = BASE;
    for (let i = 0; i < words.length; i += 2) text = lineOption_set(text, words[i] as string, words[i + 1] as string);
    return text;
  };

  it('says nothing to change when every part runs as offered, the ports in any order', () => {
    expect(buildWould_derive(vmLevers_read(line('')), RUNS)).toEqual([]);
    expect(ports_word('443, 80,80')).toBe('80,443');
    expect(ports_word([])).toBe('none');
  });

  it('says a port, the backups and the OS against what runs, each with what it means', () => {
    const would = buildWould_derive(vmLevers_read(line('--open 80,443,8080 --data-backup none --os ubuntu-24.04')), RUNS);
    expect(would).toEqual([
      { change: 'open 80,443 → 80,443,8080', consequence: 'the security group changes in place, no reboot', tone: 'grow' },
      { change: 'backups daily → none', consequence: 'the daily backups stop; those already made stay until they age out', tone: 'grow' },
      { change: 'os ubuntu-26.04 → ubuntu-24.04', consequence: 'refused unless named (--allow-alter): a new OS is a new machine with a new host key; the data volume stays', tone: 'refused' },
    ]);
    // No machine runs: the build makes it again over its kept data, or anew.
    expect(buildWould_derive(vmLevers_read(line('')), { ...RUNS, vcpu: null, memory: null, disk: null })).toEqual([{ change: 'the machine made: 2 vCPU · 8 GiB · disk 50 GB', consequence: 'over its data volume (50 GB), which stands: its data and address are the machine\'s', tone: 'grow' }]);
    expect(buildWould_derive(vmLevers_read(line('')), { vcpu: null, memory: null, disk: null, data: null })[0]?.change).toBe('the machine and its data made: 2 vCPU · 8 GiB · disk 50 GB · data 50 GB');
    // A part the tenancy was not read for is not compared.
    expect(buildWould_derive(vmLevers_read(line('--os ubuntu-24.04')), { ...RUNS, os: null })).toEqual([]);
  });
});

describe('an option set on a line leaves the line\'s other words as their author spelled them', () => {
  const line: string = "chris user add 'O'\\''Brien' --note '$name' --email ob@example.org";

  it('reads an apostrophe written closed, escaped and opened again as one apostrophe', () => {
    expect(words_split(line)).toEqual(['chris', 'user', 'add', "O'Brien", '--note', '$name', '--email', 'ob@example.org']);
    expect(lineOption_get(line, '--note')).toBe('$name');
  });

  it('two fields changed one after the other: the name keeps its apostrophe and the quoted literal stays quoted', () => {
    const first: string = lineOption_set(line, '--email', 'o.brien@example.org');
    expect(first).toBe("chris user add 'O'\\''Brien' --note '$name' --email o.brien@example.org");
    const second: string = lineOption_set(first, '--groups', 'pacs users');
    expect(second).toBe("chris user add 'O'\\''Brien' --note '$name' --email o.brien@example.org --groups 'pacs users'");
    expect(words_split(second)).toEqual(['chris', 'user', 'add', "O'Brien", '--note', '$name', '--email', 'o.brien@example.org', '--groups', 'pacs users']);
    // The literal's own option changed: only then is it written anew.
    expect(lineOption_set(second, '--note', "it's")).toBe("chris user add 'O'\\''Brien' --note 'it'\\''s' --email o.brien@example.org --groups 'pacs users'");
    // And taken away, with its value.
    expect(lineOption_set(second, '--note', '')).toBe("chris user add 'O'\\''Brien' --email o.brien@example.org --groups 'pacs users'");
  });

  it('an option with no value gains one in place, and a value that is itself written like an option is its value', () => {
    expect(lineOption_set('vm new store --public --cidr 10.0.0.0/16', '--public', 'yes')).toBe('vm new store --public yes --cidr 10.0.0.0/16');
    expect(lineOption_set("vm new store --note '--not-an-option' --n 1", '--note', 'x')).toBe('vm new store --note x --n 1');
  });
});

describe('an option is read, set and cleared by one rule', () => {
  it('a line that names an option twice is left naming it once when set, and not at all when cleared', () => {
    const twice: string = 'vm new store --memory 8 --vcpu 2 --memory 16';
    expect(lineOption_set(twice, '--memory', '32')).toBe('vm new store --memory 32 --vcpu 2');
    expect(lineOption_get(lineOption_set(twice, '--memory', '32'), '--memory')).toBe('32');
    expect(lineOption_set(twice, '--memory', '')).toBe('vm new store --vcpu 2');
    expect(line_parse(lineOption_set(twice, '--memory', '')).options).toEqual([['--vcpu', '2']]);
  });

  it('a quoted word that looks like an option is a value: the getter reads it, the setter replaces it, and it never names an option', () => {
    const line: string = "vm new store --note '--example' --n 1";
    expect(lineOption_get(line, '--note')).toBe('--example');
    expect(lineOption_get(line, '--example')).toBeNull();
    expect(line_parse(line).options).toEqual([['--note', '--example'], ['--n', '1']]);
    expect(lineOption_set(line, '--note', 'x')).toBe('vm new store --note x --n 1');
    expect(lineOption_set(line, '--example', 'y')).toBe("vm new store --note '--example' --n 1 --example y");
    // A quoted word standing where a subject does is the subject, though it begins with dashes.
    expect(line_parse("vm new '--odd-name' --n 1").subject).toBe('--odd-name');
  });

  it('a value set from a field that reads like an option is the value: set, read back and cleared as one option', () => {
    for (const value of ['--example', '--key=value', '--n']) {
      const set: string = lineOption_set('vm new store --n 1', '--note', value);
      expect(lineOption_get(set, '--note')).toBe(value);
      expect(line_parse(set).options).toEqual([['--n', '1'], ['--note', value]]);
      // Cleared, nothing of it is left behind.
      expect(lineOption_set(set, '--note', '')).toBe('vm new store --n 1');
      // Set again over itself, still one of it.
      expect(lineOption_set(set, '--note', 'plain')).toBe('vm new store --n 1 --note plain');
    }
    expect(lineOption_set('vm new store', '--note', '--example')).toBe("vm new store --note '--example'");
  });

  it('the --key=value spelling is the same option: read, replaced in place, and cleared', () => {
    const line: string = "vm new store --memory=8 --note='two words' --vcpu 2";
    expect(lineOption_get(line, '--memory')).toBe('8');
    expect(lineOption_get(line, '--note')).toBe('two words');
    expect(lineOption_set(line, '--memory', '16')).toBe("vm new store --memory 16 --note='two words' --vcpu 2");
    expect(lineOption_set(line, '--note', '')).toBe('vm new store --memory=8 --vcpu 2');
    expect(lineOption_set('vm new store --memory=8 --memory 16', '--memory', '')).toBe('vm new store');
  });
});

describe('a line made from another keeps what it does not change', () => {
  it('the price request is the declaration with its verb changed, every other word as spelled', () => {
    const declared: string = "vm new 'O'\\''Brien' --note '$name' --memory=8 --disk 50";
    expect(costLine_derive(declared)).toBe("vm cost 'O'\\''Brien' --note '$name' --memory=8 --disk 50");
    // Read by the kernel, the two carry the same operands: the literal stays a literal.
    expect([...args_tokenize(costLine_derive(declared))].slice(2)).toEqual([...args_tokenize(declared)].slice(2));
    // A line that is not a declaration has no price request; one whose verb is quoted is still a declaration.
    expect(costLine_derive('vm build store')).toBeNull();
    expect(costLine_derive("vm 'new' store --disk 50")).toBe('vm cost store --disk 50');
    expect(costLine_derive("'vm' \"new\" 'O'\\''Brien' --note '$name'")).toBe("vm cost 'O'\\''Brien' --note '$name'");
  });

  it('a user line built from a form carries each field as the value it is, to the kernel', () => {
    const line: string = userLine_build("o'brien", 'ops$team@example.org', '/keys/pass word $1', 'store');
    expect([...args_tokenize(line)]).toEqual(['chris', 'user', 'add', "o'brien", '--email', 'ops$team@example.org', '--password-file', '/keys/pass word $1', '--on', 'store']);
    // A file named under the home stays under the home; a plain form reads as it always did.
    expect(userLine_build('jennings', 'j@example.org', '~/p', 'store')).toBe('chris user add jennings --email j@example.org --password-file ~/p --on store');
    expect([...args_tokenize(userLine_build('jennings', 'j@example.org', '~/my keys/p', ''))]).toEqual(['chris', 'user', 'add', 'jennings', '--email', 'j@example.org', '--password-file', '~/my keys/p']);
  });
});
