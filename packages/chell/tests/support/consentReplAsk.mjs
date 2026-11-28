// The REPL's persistent readline on a real terminal, as chell's REPL holds it while a remote line runs (lines typed
// meanwhile wait as typeahead). The event loop is stalled for <stallMs> (a large frame from the session being read),
// then a consent question is asked in the same turn through chell's own surface (built dist). Prints what the
// question read, or why it failed. With 'during', the stall begins just after the question is asked (while it waits
// for the terminal to go quiet) instead of before. Usage: node consentReplAsk.mjs <stallMs> [before|during]
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { cliSurface_create, CONSENT_PURPOSE } = await import(`${root}dist/core/cliSurface.js`);
const { typeahead_push } = await import(`${root}dist/core/lineDiscipline.js`);
const stall = Number(process.argv[2] ?? '0');
const when = process.argv[3] ?? 'before';
const loop_stall = () => { const until = Date.now() + stall; while (Date.now() < until) { /* the session's frame being read */ } };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '> ' });
rl.on('line', (line) => { typeahead_push(line); });
const surface = cliSurface_create(rl);
process.stdout.write('READY\n');
setTimeout(async () => {
  if (when === 'before') loop_stall();
  try {
    const asking = surface.prompt({ message: 'Allow? ', purpose: CONSENT_PURPOSE });
    // Stalled outside the timers (as a frame read from the socket is): the wait's next look then comes before the
    // keys typed meanwhile are read.
    if (when === 'during') setTimeout(() => { setImmediate(loop_stall); }, 5);
    const answer = await asking;
    process.stdout.write(`\nANSWER=${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stdout.write(`\nFAILED=${JSON.stringify(error.message)}\n`);
  }
  setTimeout(() => process.exit(0), 50);
}, 300);
