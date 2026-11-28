// Runs consentTtyAsk.mjs on a pseudo-terminal: types `ahead` before the question and, with 'noisy' or
// 'withdraw', keeps typing every 10 ms; otherwise types `n` and Enter once the question shows. Prints the child's
// answer, or its failure, as JSON. Usage: node consentTty.mjs '<ahead JSON>' [answer|noisy|withdraw]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const ahead = JSON.parse(process.argv[2] ?? '""');
const mode = process.argv[3] ?? 'answer';
const child = fileURLToPath(new URL('./consentTtyAsk.mjs', import.meta.url));
const term = pty.spawn(process.execPath, [child, mode], { cols: 120, rows: 30, env: { PATH: process.env.PATH ?? '', TERM: 'xterm' } });
let seen = '';
let answered = false;
setTimeout(() => { term.write(ahead); }, 100);
if (mode !== 'answer') setInterval(() => { term.write('x'); }, 10);
const report = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); term.kill(); process.exit(0); };
term.onData((data) => {
  seen += data;
  if (mode === 'answer' && !answered && seen.includes('Allow? ')) {
    answered = true;
    setTimeout(() => { term.write('n\r'); }, 150);
  }
  const found = /ANSWER=(".*?")\r?\n/.exec(seen);
  if (found) report({ answer: JSON.parse(found[1]) });
  const failed = /FAILED=(\{.*?\})\r?\n/.exec(seen);
  if (failed) report({ failed: JSON.parse(failed[1]) });
});
setTimeout(() => { report({ answer: null, seen }); }, 8000);
