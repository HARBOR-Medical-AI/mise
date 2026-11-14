/**
 * @file The Workflows, Admin and Monitoring commands, declared in one record
 * each: `play`, `expect`, `record`, `gather`, `user` and `proc` parse their
 * lines and refuse a bad one before the handler runs, list under their
 * category, write their usage, hold what they held, complete from their
 * grammar, and `users` answers as `user` does.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// The parse alone is under test: nothing here reaches CUBE or the disk.
cuminMock_install(() => Object.fromEntries([
  'listCache_get', 'seriesStorage_resolveMany', 'procLayout_get', 'procLayout_set', 'procCache_get', 'feedStatus_deriveFromCounts', 'feedTags_readByFeed', 'path_extractFeedID', 'path_extractPluginInstanceID', 'path_isInFeed', 'procLayoutName_check', 'procLayoutPositions_check',
].map((name: string): [string, unknown] => [name, jest.fn()])));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/touch.js', () => ({ files_touch: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/mkdir.js', () => ({ files_mkdir: jest.fn() }));

const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { commandTools_derive } = await import('../src/core/commandSchema.js');
const { CORE_KIND_NAMES } = await import('../src/core/argumentKinds.js');
const { declaredWord_complete } = await import('../src/lib/completer/declared.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { commands_register, commandDeclaration_get, commandHolds_get, commandHelpEntry_get, envelopeHandler_get } = await import('../src/core/commandRegistry.js');
const { playCommand, playArgs_parse } = await import('../src/builtins/res/play.js');
const { expectCommand } = await import('../src/builtins/res/expect.js');
const { recordCommand } = await import('../src/builtins/res/record.js');
const { gatherCommand } = await import('../src/builtins/res/gather.js');
const { userCommand } = await import('../src/builtins/res/user.js');
const { procCommand } = await import('../src/builtins/proc.js');

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;
type Parsable = Parameters<typeof commandLine_parse>[0];

/** The commands of the three categories, each declared. */
const DECLARED: Parsable[] = [playCommand, expectCommand, recordCommand, gatherCommand, userCommand, procCommand];

/**
 * Parses a line's words against a declaration.
 *
 * @param declaration - The command.
 * @param line - The words after the command, as typed.
 * @returns The parse.
 */
async function line_parse(declaration: Parsable, line: string): Promise<Parsed> {
  return commandLine_parse(declaration, shellWords_tokenize(line));
}

/**
 * The parsed subcommand, operands and options of a line, or its refusal.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns What the handler would read, or the refusal's words.
 */
async function line_read(declaration: Parsable, line: string): Promise<unknown> {
  const parsed: Parsed = await line_parse(declaration, line);
  return parsed.ok ? { subcommand: parsed.args.subcommand, operands: parsed.args.operands, options: parsed.args.options } : parsed.refusal;
}

beforeEach(() => {
  process.exitCode = 0;
});

describe('the Workflows, Admin and Monitoring commands are declared', () => {
  it('each under its category, with the kinds a ChRIS command may use', () => {
    const categories: Record<string, string> = { play: 'Workflows', expect: 'Workflows', record: 'Workflows', gather: 'Workflows', user: 'Admin', proc: 'Monitoring' };
    for (const declaration of DECLARED) {
      expect(declaration.help.category).toBe(categories[declaration.name]);
      const lines = [declaration.grammar, ...Object.values(declaration.grammar.subcommands ?? {})];
      for (const line of lines) {
        const kinds: string[] = [
          ...(line.operands ?? []).map((operand) => operand.kind),
          ...Object.values(line.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
        ];
        for (const kind of kinds) expect(CORE_KIND_NAMES).toContain(kind);
      }
    }
  });

  it('writes each usage line from the grammar', () => {
    expect(commandUsage_render(playCommand)).toBe('play [--dry-run] [--status] [--step] [--param <NAME=value>] [--pace <duration>] [--text <script>] <manifest>');
    expect(commandUsage_render(expectCommand)).toBe('expect [--deep] [--within <duration>] [--matching <glob>] [subject] [claim…]');
    expect(commandUsage_render(recordCommand)).toBe('record [start <manifest> | stop | status]');
    expect(commandUsage_render(userCommand, 'add')).toBe('user add <username>');
    expect(commandUsage_render(gatherCommand, 'process')).toBe('gather process [--detach] [--title <title>] <executable> [arguments…]');
    expect(commandUsage_render(procCommand, 'jump')).toBe('proc jump [--where] <target>');
  });

  it('writes a tool for each subcommand', () => {
    expect(commandTools_derive(procCommand).length).toBeGreaterThan(Object.keys(procCommand.grammar.subcommands).length);
    expect(commandTools_derive(userCommand)).toHaveLength(5);
  });
});

describe('each parses its line as it did', () => {
  it('play: every --param kept, --text as a value however it starts, --step refused by name', async () => {
    expect(await line_read(playCommand, 'f.mise --param MRN=1 --param "LABEL=two words" --pace 2s')).toEqual({
      subcommand: null,
      operands: { manifest: 'f.mise' },
      options: { param: ['MRN=1', 'LABEL=two words'], pace: '2s', dryRun: false, status: false, text: undefined, step: false },
    });
    expect((await playArgs_parse(['f.mise', '--status', '--text', '-x'])).text).toBe('-x');
    expect((await playArgs_parse(['f.mise', '--step'])).parseError).toContain('needs a terminal');
    expect(await line_read(playCommand, '')).toContain("play: missing operand <manifest>; usage: play");
    expect(await line_read(playCommand, 'f.mise --sideways')).toContain("unrecognized option '--sideways'");
  });

  it('expect: the claim\'s words in order, its options anywhere among them', async () => {
    expect(await line_read(expectCommand, 'path /out count --matching "*.nii*" --deep gt 0')).toEqual({
      subcommand: null,
      operands: { subject: 'path', claim: ['/out', 'count', 'gt', '0'] },
      options: { within: undefined, matching: '*.nii*', deep: true },
    });
    expect(await line_read(expectCommand, 'run 1 status eq finishedSuccessfully --within=10s')).toMatchObject({ options: { within: '10s' } });
    expect(await line_read(expectCommand, 'path /x exists --soon')).toContain("unrecognized option '--soon'");
  });

  it('record: a subcommand, bare as status, start needing its manifest', async () => {
    expect(await line_read(recordCommand, '')).toMatchObject({ subcommand: null });
    expect(await line_read(recordCommand, 'start ~/flows/a.mise')).toMatchObject({ subcommand: 'start', operands: { manifest: '~/flows/a.mise' } });
    expect(await line_read(recordCommand, 'start')).toContain('record: start: missing operand <manifest>');
    expect(await line_read(recordCommand, 'rewind')).toContain("unknown subcommand 'rewind'");
  });

  it('gather: process hands what follows -- to the run, feed takes a title, an unknown option is refused', async () => {
    expect(await line_read(gatherCommand, 'process pl-x --title T --detach -- --threshold 0.5')).toEqual({
      subcommand: 'process',
      operands: { executable: 'pl-x', arguments: ['--threshold', '0.5'] },
      options: { title: 'T', detach: true },
    });
    expect(await line_read(gatherCommand, 'feed --title "sag nifti"')).toMatchObject({ subcommand: 'feed', options: { title: 'sag nifti' } });
    expect(await line_read(gatherCommand, 'name sag cohort')).toMatchObject({ operands: { name: ['sag', 'cohort'] } });
    expect(await line_read(gatherCommand, 'rm 2')).toMatchObject({ subcommand: 'rm', operands: { members: ['2'] } });
    expect(await line_read(gatherCommand, 'process pl-x --threshold 1')).toContain("unrecognized option '--threshold'");
    expect(await line_read(gatherCommand, 'process')).toContain('missing operand <executable>');
    expect(await line_read(gatherCommand, 'frobnicate')).toContain("unknown subcommand 'frobnicate'");
  });

  it('user: one operation on one account', async () => {
    expect(await line_read(userCommand, 'disable jack.bivowac')).toEqual({ subcommand: 'disable', operands: { username: 'jack.bivowac' }, options: {} });
    expect(await line_read(userCommand, '')).toContain('user: missing subcommand (add, inspect, disable, enable, remove)');
    expect(await line_read(userCommand, 'add')).toContain('user: add: missing operand <username>');
    expect(await line_read(userCommand, 'add a b')).toContain("unexpected operand 'b'");
  });

  it('proc: bare as refresh, jobs with its view and options, a layout put, --where as a switch', async () => {
    expect(await line_read(procCommand, '')).toMatchObject({ subcommand: null });
    expect(await line_read(procCommand, 'jobs list --sort erroredJobs --reverse --limit 5')).toMatchObject({
      subcommand: 'jobs', operands: { view: 'list' }, options: { sort: 'erroredJobs', reverse: true, limit: 5, force: false },
    });
    expect(await line_read(procCommand, 'jobs --limit 0')).toContain("invalid argument '0' for '--limit' (at least 1)");
    expect(await line_read(procCommand, 'jobs show')).toContain("invalid argument 'show' for <view>");
    expect(await line_read(procCommand, `layout put galaxy '{"1":[0,0,0]}'`)).toMatchObject({ operands: { layout: 'put', name: 'galaxy', places: '{"1":[0,0,0]}' } });
    expect(await line_read(procCommand, 'jump --where feed_12')).toMatchObject({ operands: { target: 'feed_12' }, options: { where: true } });
    expect(await line_read(procCommand, 'seen all')).toMatchObject({ operands: { feeds: ['all'] } });
    expect(await line_read(procCommand, 'unwatch')).toContain('proc: unwatch: missing operand <feed>');
    expect(await line_read(procCommand, 'here now')).toContain("unexpected operand 'now'");
  });
});

describe('the registry answers them as their records say', () => {
  it('gather holds the cohort, the rest the whole session', () => {
    commands_register({ declarations: DECLARED });
    expect(commandHolds_get('gather')).toEqual(['cohort']);
    for (const name of ['play', 'expect', 'record', 'user', 'proc']) expect(commandHolds_get(name)).toBeNull();
  });

  it('answers users as user: one declaration, one handler, no help entry of its own', () => {
    commands_register({ declarations: [userCommand] });
    expect(commandDeclaration_get('users')).toBe(userCommand);
    expect(envelopeHandler_get('users')).toBe(envelopeHandler_get('user'));
    expect(commandHelpEntry_get('users')).toBeUndefined();
    expect(commandHelpEntry_get('user')?.category).toBe('Admin');
  });

  it('completes subcommands, options and enum values from the grammar', async () => {
    expect(await declaredWord_complete(userCommand, [], 'd')).toEqual(['disable']);
    expect(await declaredWord_complete(procCommand, ['jobs'], 'i')).toEqual(['inspect']);
    expect(await declaredWord_complete(procCommand, ['feeds'], '--f')).toEqual(expect.arrayContaining(['--fresh', '--force']));
    expect(await declaredWord_complete(gatherCommand, ['process', 'pl-x'], '--d')).toEqual(['--detach']);
    expect(await declaredWord_complete(recordCommand, [], 's')).toEqual(expect.arrayContaining(['start', 'stop', 'status']));
  });
});
