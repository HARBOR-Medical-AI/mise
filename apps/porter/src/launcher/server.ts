/**
 * @file The berth launcher's API, for porter alone: local (a unix socket, or
 * loopback), every call carrying the secret both read from one file. It is
 * exactly start, stop and status of the berth for an identity; the launcher
 * fixes everything else.
 *
 *   POST /berths/start   {user, uid, gid, cubeUrl, token, cohort?}  → the berth, running
 *   POST /berths/stop    {user, cubeUrl}                   → {stopped}
 *   GET  /berths/status  [?user=…&cubeUrl=…]               → {berths: […]}
 *   GET  /berths/access?cubeUrl=…                          → {berths: […]}, each person's berth or kept home with its usage
 *
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BerthRefusal, type BerthLauncher, type BerthState } from './launcher.js';

const startSchema = z.object({
  user: z.string().min(1),
  uid: z.number().int(),
  gid: z.number().int(),
  cubeUrl: z.string().min(1),
  token: z.string().min(1).nullable(),
  cohort: z.number().int().positive().nullable().optional(),
}).strict();

const stopSchema = z.object({ user: z.string().min(1), cubeUrl: z.string().min(1) }).strict();

/**
 * Whether a request carries the secret, compared in constant time.
 *
 * @param header - Its `Authorization` header.
 * @param secret - The secret.
 * @returns True when it is `Bearer <secret>`.
 */
export function secret_matches(header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given: Buffer = Buffer.from(header.slice('Bearer '.length), 'utf-8');
  const held: Buffer = Buffer.from(secret, 'utf-8');
  return given.length === held.length && timingSafeEqual(given, held);
}

/**
 * A berth as the API answers it.
 *
 * @param berth - The berth.
 * @returns Its fields.
 */
function berth_render(berth: BerthState): Record<string, unknown> {
  return { identity: berth.identity, user: berth.user, state: berth.state, url: berth.url, token: berth.token, container: berth.container, cohort: berth.cohort };
}

/**
 * A request's JSON body.
 *
 * @param req - The request.
 * @returns The parsed body.
 */
function body_read(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve: (value: unknown) => void, reject: (error: Error) => void): void => {
    const chunks: Buffer[] = [];
    let size: number = 0;
    req.on('data', (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new BerthRefusal(413, 'the ask is too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', (): void => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { reject(new BerthRefusal(400, 'the ask is not JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * The launcher's API server.
 *
 * @param launcher - The launcher.
 * @param secret - What every call carries.
 * @param log - One line per act.
 * @returns The server, not yet listening.
 */
export function launcherServer_create(launcher: BerthLauncher, secret: string, log: (line: string) => void = (): void => undefined): Server {
  return createServer((req: IncomingMessage, res: ServerResponse): void => {
    const answer = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!secret_matches(req.headers.authorization, secret)) { answer(401, { error: 'the launcher answers porter alone' }); return; }
    const url: URL = new URL(req.url ?? '/', 'http://launcher');
    void (async (): Promise<void> => {
      try {
        if (req.method === 'POST' && url.pathname === '/berths/start') {
          const ask = startSchema.safeParse(await body_read(req));
          if (!ask.success) throw new BerthRefusal(400, 'start wants {user, uid, gid, cubeUrl, token} and at most a cohort');
          const berth: BerthState = await launcher.start(ask.data);
          log(`${berth.user}: berth running at ${berth.url ?? '?'} (cohort ${berth.cohort})`);
          answer(200, berth_render(berth));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/berths/stop') {
          const ask = stopSchema.safeParse(await body_read(req));
          if (!ask.success) throw new BerthRefusal(400, 'stop wants {user, cubeUrl}');
          const stopped: boolean = await launcher.stop(ask.data.user, ask.data.cubeUrl);
          log(`${ask.data.user}: berth ${stopped ? 'stopped; its volumes kept' : 'was not running'}`);
          answer(200, { stopped });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/berths/status') {
          const user: string | null = url.searchParams.get('user');
          const cubeUrl: string | null = url.searchParams.get('cubeUrl');
          const berths: BerthState[] = await launcher.status(user !== null && cubeUrl !== null ? { user, cubeUrl } : null);
          answer(200, { berths: berths.map(berth_render), capacity: await launcher.capacity_get() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/berths/access') {
          const cubeUrl: string | null = url.searchParams.get('cubeUrl');
          if (cubeUrl === null || cubeUrl === '') throw new BerthRefusal(400, 'access wants ?cubeUrl=<the CUBE whose people are read>');
          answer(200, { berths: await launcher.access_read(cubeUrl) });
          return;
        }
        answer(404, { error: 'the launcher knows start, stop, status and access' });
      } catch (error: unknown) {
        const status: number = error instanceof BerthRefusal ? error.status : 500;
        const message: string = error instanceof Error ? error.message : String(error);
        log(`refused: ${message}`);
        answer(status, { error: message });
      }
    })();
  });
}
