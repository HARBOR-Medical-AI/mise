/**
 * @file help's sections: the table of contents `help` shows, a section's
 * page (`help PACS`), the Shell topics (`help pipes`), and `apropos`.
 *
 * Borrowed from man rather than reinvented: sections by topic (man's are by
 * number), a page per command, and `apropos` / `man -k` to search every
 * summary by a word, which is how anyone finds a command they cannot name.
 * A section is one capitalised word, so `help PACS` (the section) and
 * `help pacs` (the command) never collide; a section word that names no
 * command answers in lower case too.
 *
 * @module
 */
import chalk from 'chalk';

/** One section of help. */
export interface HelpSection {
  /** One capitalised word: what `help <Section>` takes, and the category commands declare. */
  name: string;
  /** What the section is for, a sentence or two. */
  blurb: string;
  /** Commands that show what it holds, the first runnable ones of which `help` lists. */
  examples: ReadonlyArray<string>;
}

/** The sections, in the order `help` lists them. */
export const HELP_SECTIONS: ReadonlyArray<HelpSection> = [
  { name: 'Navigation', blurb: "Move around ChRIS's filesystem, including the /proc and /net projections.", examples: ['cd', 'ls', 'tree', 'find', 'du', 'cubepath'] },
  { name: 'Files', blurb: 'Read, write, copy and move files and folders; upload from and download to this machine.', examples: ['cat', 'cp', 'mv', 'upload', 'download', 'grep'] },
  { name: 'Sharing', blurb: 'Who may see a folder or file, and links that open ARGUS where you are.', examples: ['chmod', 'setfacl', 'url'] },
  { name: 'Connection', blurb: 'Who you are, which CUBE you are on, and where the session stands.', examples: ['connect', 'whoami', 'context'] },
  { name: 'Monitoring', blurb: 'Live jobs as a filesystem, and jumping to one by number.', examples: ['proc'] },
  { name: 'Imaging', blurb: 'DICOM tags and image viewing.', examples: ['dcm', 'image'] },
  { name: 'Workflows', blurb: 'Gather a cohort, record what you do as a manifest, and replay it.', examples: ['gather', 'record', 'play', 'expect'] },
  { name: 'Resources', blurb: 'ChRIS resources one at a time or as lists: feeds, plugins, pipelines, jobs, tags, groups, compute, store.', examples: ['feed', 'feeds', 'plugins', 'jobs'] },
  { name: 'PACS', blurb: "Ask a PACS for a patient's studies and series, narrow the answer, and pull it into ChRIS.", examples: ['query', 'pull', 'pacs'] },
  { name: 'Admin', blurb: 'Administrative acts that need elevated rights.', examples: ['sudo', 'user'] },
  { name: 'Settings', blurb: 'How the shell behaves: prompt, timing, physical paths, debug output.', examples: ['prompt', 'timing', 'debug'] },
  { name: 'Games', blurb: 'The /usr/games shelf: text toys, small utilities and games.', examples: ['fortune', 'cowsay', 'tetris'] },
  { name: 'General', blurb: 'Help, finding a command by a word, release notes, versions, and leaving.', examples: ['help', 'apropos', 'notes', 'version', 'exit'] },
];

/** The section that is not a list of commands: what the shell does to a line. */
export const SHELL_SECTION: HelpSection = {
  name: 'Shell',
  blurb: 'What the shell does to a line: pipes, redirection, index handles (@SER3), variables (A=$(cmd), ${A.field}), run operands, listing-aware grep, command.',
  examples: ['help pipes', 'help handles', 'help variables'],
};

/** The view across sections: every command that mirrors a Unix utility. */
export const POSIX_SECTION: HelpSection = {
  name: 'POSIX',
  blurb: "chell's commands that mirror Unix utilities, and how each differs (most work on ChRIS's filesystem, not this machine's).",
  examples: ['ls', 'cat', 'grep', 'tac', 'md5sum'],
};

/** The groups `help POSIX` lists under, in order. */
const POSIX_GROUPS: ReadonlyArray<string> = ['Files', 'Text', 'System', 'Shell'];

/** A Shell topic: its one line, and its page (or the command whose page it is). */
interface ShellTopic {
  name: string;
  summary: string;
  page?: ReadonlyArray<string>;
}

/** The Shell section's topics, each `help <topic>`. */
export const SHELL_TOPICS: ReadonlyArray<ShellTopic> = [
  {
    name: 'pipes',
    summary: 'cmd | cmd: text between programs, a numbered listing between builtins; also ; && ||',
    page: [
      'A pipe hands one command\'s output to the next: cat notes.txt | wc -l.',
      '',
      'Between two builtins a numbered listing travels beside the text, so the',
      'next builtin receives rows, not words:',
      '  query PatientID:1234567 | grep -i t1 | gather add',
      'A program that is not a builtin (awk, sed, a system grep) receives the',
      'text alone. The last listing a pipe produces becomes the held listing:',
      '@SER3 and ${listing} name its rows afterwards.',
      '',
      'The filters a pipe ends in are builtins, run in the session on every',
      'surface: wc, head, tail, sort, uniq, cut, grep.',
      '  find /proc/jobs -plugin pl-dylld | wc -l',
      'A program that is not one runs where the surface runs programs: a chell',
      'on your machine, or a daemon started with --host-control pipes.',
      '',
      'Several commands on one line, as in sh: a ; b runs both; a && b runs b',
      'only when a succeeded; a || b runs b only when a failed. Inside quotes',
      'each is text.',
      '  cd ~/uploads && ls',
      '  ls ~/uploads/scans || mkdir ~/uploads/scans',
    ],
  },
  {
    name: 'redirection',
    summary: '> and >>: write or append a command\'s output to a file on this machine',
    page: [
      'cmd > file writes the output to a file; cmd >> file appends to it.',
      '',
      'The file is on the machine chell runs on, not in ChRIS: to put text in',
      'ChRIS use touch --withContents or upload.',
      '  query PatientID:1234567 --table > answer.txt',
    ],
  },
  {
    name: 'handles',
    summary: '@SER3 @STD1-4 @FIL2,5,7: name rows of the last numbered listing',
    page: [
      'A listing that numbers its rows (query, query --table, gather list,',
      'ls -l) prints a handle beside each: @PAT1, @STD3, @SER12, @DIR4, @FIL2.',
      'Typed in a later line, a handle stands for its row:',
      '  gather add @SER3        one row',
      '  gather add @SER1-4      a range',
      '  gather add @SER2,5,7    a list',
      '',
      'The listing\'s footer says what is numbered now:',
      '  numbered: @PAT1, @STD1-9, @SER1-235',
      'The next listing replaces it, so @SER3 always means the last listing\'s',
      'row. grep keeps the handles rows already wore (@SER41 stays @SER41).',
    ],
  },
  { name: 'variables', summary: 'A=$(cmd), ${A.field}, set: naming what a command answered' },
  {
    name: 'operands',
    summary: 'pl-x <dir> | <file> as <subject>: the input operand of a plugin or Pipeline run, the stage, whatif',
    page: [
      'A plugin or Pipeline in /bin takes its input as operands, first on the',
      'line; the plugin\'s own flags come after. A flag before an operand is',
      'written with =.',
      '  pl-freesurfer ~/uploads/subjects --threads 2',
      '  pl-freesurfer --threads=2 ~/uploads/subjects',
      '',
      'No operand: the working directory is the input.',
      '',
      'A directory: that tree is the input.',
      '  Inside the feeds tree the run attaches at the node the path names',
      '  (~/feeds/feed_N/pl-x_ID/data) and its results join that feed.',
      '  Outside it, pl-dircopy roots a new feed of the directory, titled by',
      '  its name, and the run goes on from that root.',
      '  Several directories are several runs, one each; every operand is',
      '  checked before any run starts.',
      '    Mriconvert ~/uploads/sub-01 ~/uploads/sub-02',
      '',
      'Files: one subject per file, named by the file name up to its first',
      'extension, two for a compressed file (t1.nii.gz is t1, scan.v2.gz is',
      'scan). as <name> makes the files since the last as one subject.',
      '  pl-freesurfer t1.nii t2.nii as sub-01',
      '  The files are copied to a stage, ~/.mise/stage/<id>/<subject>/, which',
      '  pl-dircopy roots a new feed with. The stage stays, as the record.',
      '',
      'Wildcards expand in any part of a path, sorted:',
      '  Mriconvert ~/feeds/feed_*/pl-dircopy_*/data',
      '',
      'What refuses, before anything is made:',
      '  a path that is not there, or a pattern matching nothing',
      '  a directory beside files',
      '  files from two feed nodes, or from a node and outside the feeds tree',
      '  two subjects of one name (name one with as)',
      '  a directory in a feed but not at a node',
      '  a word with = and no / reads as an assignment; a file named',
      '  sub=01.nii is written ./sub=01.nii',
      '',
      'To an fs plugin (pl-dircopy) every operand is its dir, untranslated.',
      '',
      'Before a run is dispatched chell prints the resolved call: the node it',
      'attaches to (or the feed it roots) and the parameters, defaults marked;',
      'for a Pipeline one line per piping, every parameter under --verbose.',
      '',
      'whatif <line> prints that resolution in full and stops: nothing staged,',
      'no feed, no job. A prefix, as time, nice and env are, since every flag',
      'after a /bin name is the plugin\'s.',
      '  whatif pl-freesurfer ~/uploads/t1.nii as sub-01',
    ],
  },
  { name: 'grep', summary: 'filter text, or a numbered listing keeping its handles' },
  { name: 'command', summary: 'run the system program, not the builtin' },
];

/** What the renderers read of the commands: a summary, whether it runs, its section. */
export interface HelpLookup {
  /** The commands this session can run, with help, in listing order. */
  commands(): ReadonlyArray<string>;
  /** A command's one line. */
  summary(name: string): string | undefined;
  /** A command's description and options, for apropos. */
  text(name: string): string;
  /** A command's section. */
  section(name: string): string | undefined;
  /** The games shelf's commands, for the Games section. */
  games(): ReadonlyArray<string>;
  /** How a command mirrors a Unix utility, when it does. */
  posix(name: string): { group: string; differs: string } | undefined;
}

/** Wraps a paragraph to a width, each line indented. */
function paragraph_wrap(text: string, indent: string, width: number = 78): string[] {
  const lines: string[] = [];
  let line: string = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && indent.length + line.length + 1 + word.length > width) {
      lines.push(`${indent}${line}`);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(`${indent}${line}`);
  return lines;
}

/**
 * A section's commands: those that declare it, and for Games the shelf.
 *
 * @param section - The section's name.
 * @param lookup - The commands.
 * @returns Its runnable commands.
 */
export function sectionCommands_list(section: string, lookup: HelpLookup): string[] {
  const declared: string[] = lookup.commands().filter((name: string): boolean => lookup.section(name) === section);
  if (section !== 'Games') return declared;
  return [...new Set([...declared, ...lookup.games()])];
}

/**
 * `help`: the table of contents. A section with nothing this session can
 * run is left out, as are examples it cannot run.
 *
 * @param lookup - The commands.
 * @returns The page.
 */
export function helpToc_render(lookup: HelpLookup): string {
  const runnable: Set<string> = new Set(lookup.commands());
  const out: string[] = [
    '',
    chalk.bold.yellow('chell — the ChRIS shell'),
    chalk.gray('Type help <Section> for a section, help <command> for a command, apropos <word> to search.'),
    '',
  ];
  const entry = (section: HelpSection, count: number | null): void => {
    out.push(`${chalk.bold.cyan(section.name)}${count === null ? '' : chalk.gray(`  (${count})`)}`);
    out.push(...paragraph_wrap(section.blurb, '    '));
    const shown: string[] = section === SHELL_SECTION ? [...section.examples] : section.examples.filter((name: string): boolean => runnable.has(name) || lookup.games().includes(name));
    if (shown.length > 0) out.push(`    ${chalk.gray('e.g.')}  ${shown.map((name: string): string => chalk.yellow(name)).join('  ')}`);
    out.push('');
  };
  for (const section of HELP_SECTIONS) {
    const count: number = sectionCommands_list(section.name, lookup).length;
    if (count > 0) entry(section, count);
  }
  entry(SHELL_SECTION, null);
  if (lookup.commands().some((name: string): boolean => lookup.posix(name) !== undefined)) entry(POSIX_SECTION, null);
  if (runnable.has('query') && runnable.has('gather')) {
    out.push(`${chalk.gray('Start here:')}  ${chalk.yellow('query PatientID:1234567 | grep -i t1 | gather add')}`, '');
  }
  return `${out.join('\n')}\n`;
}

/**
 * The section a word names: exactly (`PACS`), or in any case when no command
 * has that name (`navigation`).
 *
 * @param word - What followed `help`.
 * @param isCommand - Whether a command has that name.
 * @returns The section, or undefined.
 */
export function section_find(word: string, isCommand: (name: string) => boolean): HelpSection | undefined {
  const all: HelpSection[] = [...HELP_SECTIONS, SHELL_SECTION, POSIX_SECTION];
  const exact: HelpSection | undefined = all.find((section: HelpSection): boolean => section.name === word);
  if (exact !== undefined) return exact;
  if (isCommand(word)) return undefined;
  return all.find((section: HelpSection): boolean => section.name.toLowerCase() === word.toLowerCase());
}

/**
 * A section's page: what it is for, then each command with its line.
 *
 * @param section - The section.
 * @param lookup - The commands.
 * @returns The page.
 */
export function helpSection_render(section: HelpSection, lookup: HelpLookup): string {
  const out: string[] = ['', `${chalk.bold.cyan(section.name)} ${chalk.gray('—')} ${section.blurb}`, ''];
  const rows: Array<{ name: string; line: string }> = section === SHELL_SECTION
    ? SHELL_TOPICS.map((topic: ShellTopic): { name: string; line: string } => ({ name: topic.name, line: topic.summary }))
    : sectionCommands_list(section.name, lookup).map((name: string): { name: string; line: string } => ({ name, line: lookup.summary(name) ?? '' }));
  const width: number = Math.max(12, ...rows.map((row): number => row.name.length + 2));
  for (const row of rows) out.push(`  ${chalk.cyan(row.name.padEnd(width))}${row.line}`);
  out.push('', chalk.gray(`help <${section === SHELL_SECTION ? 'topic' : 'command'}> for each.`), '');
  return `${out.join('\n')}\n`;
}

/**
 * `help POSIX`: every command that mirrors a Unix utility, by group, each
 * with how chell's differs.
 *
 * @param lookup - The commands.
 * @returns The page.
 */
export function helpPosix_render(lookup: HelpLookup): string {
  const out: string[] = ['', `${chalk.bold.cyan(POSIX_SECTION.name)} ${chalk.gray('—')} ${POSIX_SECTION.blurb}`, ''];
  const mirrored: string[] = lookup.commands().filter((name: string): boolean => lookup.posix(name) !== undefined);
  const width: number = Math.max(10, ...mirrored.map((name: string): number => name.length + 2));
  for (const group of POSIX_GROUPS) {
    const members: string[] = mirrored.filter((name: string): boolean => lookup.posix(name)?.group === group).sort();
    if (members.length === 0) continue;
    out.push(`  ${chalk.bold(group)}`);
    for (const name of members) out.push(`    ${chalk.cyan(name.padEnd(width))}${lookup.posix(name)?.differs ?? ''}`);
    out.push('');
  }
  if (mirrored.length > 0) out.push(`  ${chalk.bold('Shell syntax')}`, `    ${chalk.cyan('|'.padEnd(width))}between builtins it carries numbered listings (help pipes)`, `    ${chalk.cyan('> >>'.padEnd(width))}write to this machine's disk, not ChRIS's (help redirection)`, '');
  out.push(chalk.gray('help <command> for each · command <name> runs the system\'s own'), '');
  return `${out.join('\n')}\n`;
}

/**
 * A Shell topic's own page, or undefined when it is not one (or is a
 * command, whose own page answers).
 *
 * @param word - What followed `help`.
 * @returns The page.
 */
export function shellTopic_render(word: string): string | undefined {
  const topic: ShellTopic | undefined = SHELL_TOPICS.find((one: ShellTopic): boolean => one.name === word && one.page !== undefined);
  if (topic === undefined || topic.page === undefined) return undefined;
  return `\n${chalk.bold.yellow(topic.name.toUpperCase())}\n${chalk.gray('─'.repeat(60))}\n${topic.page.join('\n')}\n\n${chalk.gray('help Shell for the other topics.')}\n`;
}

/**
 * `apropos <word>` (`man -k`): what holds the word, strongest first. A
 * section, a command or a Shell topic whose name or one line holds it leads;
 * one that only mentions it further in (its description, its options)
 * follows, under "also mentioned in", so `apropos dicom` leads with dcm and
 * image rather than a game that happens to name DICOM.
 *
 * @param word - What to look for.
 * @param lookup - The commands.
 * @returns The lines, empty when nothing holds the word.
 */
export function apropos_search(word: string, lookup: HelpLookup): string[] {
  const needle: string = word.toLowerCase();
  const holds = (text: string): boolean => text.toLowerCase().includes(needle);
  const strong: string[] = [];
  const mentioned: string[] = [];
  for (const section of [...HELP_SECTIONS, SHELL_SECTION, POSIX_SECTION]) {
    if (holds(`${section.name} ${section.blurb}`)) strong.push(`${chalk.cyan(section.name)} ${chalk.gray('(section)')} — ${section.blurb}`);
  }
  for (const name of lookup.commands()) {
    const line: string = `${chalk.cyan(name)} ${chalk.gray(`(${lookup.section(name) ?? 'General'})`)} — ${lookup.summary(name) ?? ''}`;
    if (holds(`${name} ${lookup.summary(name) ?? ''}`)) strong.push(line);
    else if (holds(lookup.text(name))) mentioned.push(line);
  }
  for (const topic of SHELL_TOPICS) {
    if (lookup.commands().includes(topic.name)) continue;
    const line: string = `${chalk.cyan(topic.name)} ${chalk.gray('(Shell)')} — ${topic.summary}`;
    if (holds(`${topic.name} ${topic.summary}`)) strong.push(line);
    else if (holds((topic.page ?? []).join(' '))) mentioned.push(line);
  }
  if (mentioned.length === 0) return strong;
  return [...strong, ...(strong.length > 0 ? [''] : []), chalk.gray('also mentioned in:'), ...mentioned];
}
