/** A worker that ends cleanly on its first message, without answering. */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => process.exit(0));
