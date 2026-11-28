// The REPL's persistent readline on a real terminal, as chell's REPL holds it while a remote line runs (lines typed
// meanwhile wait as typeahead). The event loop is stalled for <stallMs> (a large frame from the session being read),
// then a consent question is asked in the same turn through chell's own surface (built dist). Prints what the
// question read, or why it failed. Usage: node consentReplAsk.mjs <stallMs>
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { cliSurface_create, CONSENT_PURPOSE } = await import(`${root}dist/core/cliSurface.js`);
const { typeahead_push } = await import(`${root}dist/core/lineDiscipline.js`);
const stall = Number(process.argv[2] ?? '0');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '> ' });
rl.on('line', (line) => { typeahead_push(line); });
const surface = cliSurface_create(rl);
process.stdout.write('READY\n');
setTimeout(async () => {
  const until = Date.now() + stall;
  while (Date.now() < until) { /* the session's frame being read */ }
  try {
    const answer = await surface.prompt({ message: 'Allow? ', purpose: CONSENT_PURPOSE });
    process.stdout.write(`\nANSWER=${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stdout.write(`\nFAILED=${JSON.stringify(error.message)}\n`);
  }
  setTimeout(() => process.exit(0), 50);
}, 300);
