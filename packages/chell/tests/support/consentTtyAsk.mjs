// Asks one consent question the way a one-shot chell does, on its own terminal, after a pause in which the
// person may type ahead; prints what it read as the answer.
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { oneShotPrompt_ask, CONSENT_PURPOSE } = await import(`${root}dist/core/cliSurface.js`);
await new Promise((done) => setTimeout(done, 400));
const answer = await oneShotPrompt_ask({ message: 'Allow? ', purpose: CONSENT_PURPOSE });
process.stdout.write(`\nANSWER=${JSON.stringify(answer)}\n`);
process.exit(0);
