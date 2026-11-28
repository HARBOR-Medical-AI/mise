// Runs consentReplAsk.mjs on a pseudo-terminal: types `ahead` <aheadAtMs> after READY (during the stall, before the
// question is drawn), then `n` and Enter 300 ms after the question shows. Prints the answer as JSON.
// Usage: node consentReplTty.mjs '<ahead JSON>' <aheadAtMs> <stallMs>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const ahead = JSON.parse(process.argv[2] ?? '""');
const aheadAt = Number(process.argv[3] ?? '400');
const stall = process.argv[4] ?? '0';
const child = fileURLToPath(new URL('./consentReplAsk.mjs', import.meta.url));
const term = pty.spawn(process.execPath, [child, stall], { cols: 200, rows: 30, env: { PATH: process.env.PATH ?? '', TERM: 'xterm' } });
let seen = '';
let ready = false;
let asked = false;
const report = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); term.kill(); process.exit(0); };
term.onData((data) => {
  seen += data;
  if (!ready && seen.includes('READY')) {
    ready = true;
    setTimeout(() => { term.write(ahead); }, aheadAt);
  }
  if (!asked && seen.includes('Allow? ')) {
    asked = true;
    setTimeout(() => { term.write('n\r'); }, 300);
  }
  const found = /ANSWER=(".*?")\r?\n/.exec(seen);
  if (found) report({ answer: JSON.parse(found[1]) });
  const failed = /FAILED=(".*?")\r?\n/.exec(seen);
  if (failed) report({ failed: JSON.parse(failed[1]) });
});
setTimeout(() => { report({ answer: null }); }, 8000);
