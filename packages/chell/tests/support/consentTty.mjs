// Runs consentTtyAsk.mjs on a pseudo-terminal: types `ahead` before the question, then `n` and Enter once the
// question shows; prints the child's answer as JSON. Usage: node consentTty.mjs '<ahead JSON>'
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const ahead = JSON.parse(process.argv[2] ?? '""');
const child = fileURLToPath(new URL('./consentTtyAsk.mjs', import.meta.url));
const term = pty.spawn(process.execPath, [child], { cols: 120, rows: 30, env: { PATH: process.env.PATH ?? '', TERM: 'xterm' } });
let seen = '';
let answered = false;
setTimeout(() => { term.write(ahead); }, 100);
term.onData((data) => {
  seen += data;
  if (!answered && seen.includes('Allow? ')) {
    answered = true;
    setTimeout(() => { term.write('n\r'); }, 150);
  }
  const found = /ANSWER=(".*?")/.exec(seen);
  if (found) {
    process.stdout.write(`${JSON.stringify({ answer: JSON.parse(found[1]) })}\n`);
    term.kill();
    process.exit(0);
  }
});
setTimeout(() => { process.stdout.write(`${JSON.stringify({ answer: null, seen })}\n`); term.kill(); process.exit(0); }, 8000);
