// Asks one consent question the way a one-shot chell does, on its own terminal, after a pause in which the
// person may type ahead; prints what it read as the answer, or why it failed. With 'withdraw', the question is
// withdrawn 200 ms after it is asked. Usage: node consentTtyAsk.mjs [mode]
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { oneShotPrompt_ask, CONSENT_PURPOSE } = await import(`${root}dist/core/cliSurface.js`);
const mode = process.argv[2] ?? 'answer';
await new Promise((done) => setTimeout(done, 400));
const gone = new AbortController();
if (mode === 'withdraw') setTimeout(() => { gone.abort(); }, 200);
const asked = Date.now();
try {
  const answer = await oneShotPrompt_ask({ message: 'Allow? ', purpose: CONSENT_PURPOSE, signal: gone.signal });
  process.stdout.write(`\nANSWER=${JSON.stringify(answer)}\n`);
} catch (error) {
  process.stdout.write(`\nFAILED=${JSON.stringify({ reason: error.message, ms: Date.now() - asked, raw: process.stdin.isRaw })}\n`);
}
process.exit(0);
