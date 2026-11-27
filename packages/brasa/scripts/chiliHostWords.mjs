/**
 * The kernel's table of chili's host-file words, held to what the built
 * chili actually registers.
 *
 * `chris/chiliDelegate.ts` names, for `path`, `chefs` and `man`, every
 * subcommand and whether a line of it reads or writes a file on the
 * machine it runs on. A unit test cannot show that the table matches
 * chili, because it stands in for chili. This asks the real chili for its
 * own help and compares: the subcommands each word registers are exactly
 * the table's, the options that take a value are the ones the table says,
 * every option the table calls touching exists, and the group words
 * (`files`, `links`, `dirs`) register no `create`.
 *
 * Run after the build: `npm run test:chili-words --workspace @fnndsc/brasa`.
 * Exits 1 on any difference.
 */
const { run_capture } = await import('@fnndsc/chili/run.js');
const { CHILI_HOST_WORDS, chiliLine_read } = await import('../dist/chris/chiliDelegate.js');

/** The help chili prints for a command line, as text without colour. */
async function help_read(argv) {
  // Commander writes help straight to the process's output, past chili's own capture: it is gathered here for the length of the call.
  const written = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  let said = { out: '', err: '' };
  try {
    said = await run_capture([...argv, '--help']);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return `${said.out}${said.err}${written.join('')}`.replace(/\x1b\[[0-9;]*m/g, '');
}

/** The entries of one section of a help page (`Commands:`, `Options:`): the first word of each entry's line. */
function section_read(help, title) {
  const lines = help.split('\n');
  const start = lines.findIndex((line) => line.trim() === title);
  if (start === -1) return [];
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    // An entry starts two spaces in; a wrapped description is indented further.
    if (/^ {2}\S/.test(line)) entries.push(line.trim());
  }
  return entries;
}

let failed = 0;
const fail = (words) => { console.log(`FAIL  ${words}`); failed++; };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

for (const [word, subcommands] of Object.entries(CHILI_HOST_WORDS)) {
  const registered = section_read(await help_read([word]), 'Commands:').map((entry) => entry.split(/\s+/)[0]);
  if (!same(registered, Object.keys(subcommands))) {
    fail(`${word}: chili registers [${registered.sort().join(', ')}], the table names [${Object.keys(subcommands).sort().join(', ')}]`);
    continue;
  }
  console.log(`ok    ${word}: ${registered.length} subcommands, each classified`);
  for (const [name, sub] of Object.entries(subcommands)) {
    if (name === 'help') continue;
    const options = section_read(await help_read([word, name]), 'Options:');
    // An option that takes a value shows it in angle brackets; its names are every dash-word before it.
    const valued = options.filter((entry) => /<[^>]+>/.test(entry.split(/\s{2,}/)[0])).flatMap((entry) => entry.split(/\s{2,}/)[0].split(/[ ,]+/).filter((part) => part.startsWith('-')))
      .map((option) => (option.startsWith('--') ? option : option.slice(1)));
    const all = options.flatMap((entry) => entry.split(/\s{2,}/)[0].split(/[ ,]+/).filter((part) => part.startsWith('-')));
    if (!same(valued, sub.valued ?? [])) fail(`${word} ${name}: chili's valued options are [${valued.sort().join(', ')}], the table says [${[...(sub.valued ?? [])].sort().join(', ')}]`);
    for (const option of Array.isArray(sub.touches) ? sub.touches : []) {
      if (!all.includes(option)) fail(`${word} ${name}: the table calls ${option} touching, and chili has no such option`);
    }
  }
}

for (const group of ['files', 'links', 'dirs']) {
  const registered = section_read(await help_read([group]), 'Commands:').map((entry) => entry.split(/\s+/)[0]);
  if (registered.length === 0) fail(`${group}: chili's help lists no commands; the check cannot see what it registers`);
  else if (registered.includes('create')) fail(`${group}: chili registers create here; the table knows it only under inode`);
  else console.log(`ok    ${group}: no create (${registered.join(', ')})`);
}

// The kernel's reading of a line against chili's own parser. Asked for help at its end, a line makes Commander
// print the usage of the command it resolved the line to; that is compared with the word and subcommand the
// kernel read. No line here carries a context (a word with `=`): chili acts on one before it parses, by
// changing the session's context, which this check must not do; that rule is held to chili's source in the
// unit test.
const LINES = [
  ['path', 'scan'],
  ['path', 'scan', '--filter', 'download'],
  ['path', 'scan', '--endsWith', 'upload', '--tree'],
  ['path', 'upload', '/etc'],
  ['path', '-s', 'upload', '/etc'],
  ['path', '-c', 'upload', 'scan'],
  ['path', '--config', 'scan', 'upload', '/etc'],
  ['path', 'download', '-f', '/tmp/out'],
  ['chefs', 'ls', 'upload'],
  ['chefs', '-s', 'cat', 'upload'],
  ['chefs', 'upload', '/etc/passwd', '/home/x'],
  ['chefs', '-c', 'ls', 'upload', '/etc/passwd', '/home/x'],
  ['chefs', '--config=upload', 'ls', '/home/x'],
  ['man', 'doc', 'chell'],
  ['man', 'doc', '--style', '../figlet', 'chell'],
  ['man', 'topics'],
  ['path'],
  ['chefs', '-s'],
];
for (const line of LINES) {
  const usage = (/^Usage: chili ?(.*?)(?: \[options\])?(?: \[command\])?(?: [<[].*)?$/m.exec(await help_read(line)) ?? [])[1];
  const read = chiliLine_read(line[0], line.slice(1));
  const expected = [read.word, read.sub].filter((part) => part !== undefined).join(' ');
  if (usage === undefined) fail(`${line.join(' ')}: chili printed no usage to compare with`);
  else if (usage.trim() !== expected) fail(`${line.join(' ')}: chili resolves it to "${usage.trim()}", the kernel reads "${expected}"`);
  else console.log(`ok    ${line.join(' ')}  ->  ${expected}`);
}

console.log(failed === 0 ? 'chili host words: the table matches what chili registers' : `chili host words: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
