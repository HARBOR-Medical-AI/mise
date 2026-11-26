/** A worker that stays alive and never answers. */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => undefined);
setInterval(() => undefined, 1000);
