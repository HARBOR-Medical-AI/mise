/**
 * @file The Docker Engine API, as the berth launcher speaks it: plain HTTP
 * over the engine's unix socket, and a command run in a container with its
 * input on stdin (a hijacked exec stream), so a token handed to a berth is
 * never a command line or an environment variable.
 *
 * Only the launcher holds this: porter and the berths never see the socket
 * (docs/dev-bastion.adoc, stand-in, Q1).
 *
 * @module
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

/** The API version the launcher asks for; Docker 26 and later speak it (a volume's subpath mount needs 1.45). */
export const DOCKER_API: string = '/v1.45';

/** An engine's answer: its status and its parsed body (null when empty, the text when not JSON). */
export interface DockerAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** A command's end in a container: its exit code and what it wrote. */
export interface ExecAnswer {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What the launcher needs of an engine; a test gives a fake. */
export interface DockerApi {
  /**
   * One API call.
   *
   * @param method - The HTTP method.
   * @param path - The path under the API version, with its query.
   * @param body - The JSON body, when there is one.
   * @returns The answer.
   */
  call(method: string, path: string, body?: unknown): Promise<DockerAnswer>;
  /**
   * Runs a command in a running container as a user, its input on stdin.
   *
   * @param container - The container's name or id.
   * @param cmd - The command and its words.
   * @param user - `uid:gid`.
   * @param stdin - What it reads, or null for nothing.
   * @returns Its exit code and output.
   */
  exec(container: string, cmd: ReadonlyArray<string>, user: string, stdin: string | null): Promise<ExecAnswer>;
}

/**
 * Splits Docker's multiplexed stream (an 8-byte header a frame: the stream, three zeros, the length) into stdout and stderr.
 *
 * @param data - The raw stream.
 * @returns The two streams' text.
 */
export function dockerStream_demux(data: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let at: number = 0;
  while (at + 8 <= data.length) {
    const kind: number = data[at] as number;
    const size: number = data.readUInt32BE(at + 4);
    const frame: Buffer = data.subarray(at + 8, at + 8 + size);
    if (kind === 2) err.push(frame); else out.push(frame);
    at += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') };
}

/** The engine on its unix socket. */
export class DockerSocket implements DockerApi {
  private readonly socketPath: string;

  /**
   * @param socketPath - The engine's socket (`/var/run/docker.sock`).
   */
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** @inheritdoc */
  public call(method: string, path: string, body?: unknown): Promise<DockerAnswer> {
    return new Promise((resolve: (answer: DockerAnswer) => void, reject: (error: Error) => void): void => {
      const payload: string | null = body === undefined ? null : JSON.stringify(body);
      const req: ClientRequest = httpRequest({
        socketPath: this.socketPath,
        method,
        path: `${DOCKER_API}${path}`,
        headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
        res.on('end', (): void => {
          const text: string = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = text.length === 0 ? null : text;
          try { parsed = text.length === 0 ? null : JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  /**
   * The raw bytes of a call's answer (a container's log stream).
   *
   * @param path - The path under the API version.
   * @returns The bytes.
   */
  public bytes_get(path: string): Promise<Buffer> {
    return new Promise((resolve: (data: Buffer) => void, reject: (error: Error) => void): void => {
      const req: ClientRequest = httpRequest({ socketPath: this.socketPath, method: 'GET', path: `${DOCKER_API}${path}` }, (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
        res.on('end', (): void => { resolve(Buffer.concat(chunks)); });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** @inheritdoc */
  public async exec(container: string, cmd: ReadonlyArray<string>, user: string, stdin: string | null): Promise<ExecAnswer> {
    const made: DockerAnswer = await this.call('POST', `/containers/${encodeURIComponent(container)}/exec`, {
      AttachStdin: stdin !== null, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: [...cmd], User: user,
    });
    const id: unknown = typeof made.body === 'object' && made.body !== null ? (made.body as Record<string, unknown>)['Id'] : undefined;
    if (made.status !== 201 || typeof id !== 'string') throw new Error(`exec in ${container}: the engine answered ${made.status}`);
    const raw: Buffer = await this.execStream_run(id, stdin);
    const inspected: DockerAnswer = await this.call('GET', `/exec/${id}/json`);
    const code: unknown = typeof inspected.body === 'object' && inspected.body !== null ? (inspected.body as Record<string, unknown>)['ExitCode'] : undefined;
    return { code: typeof code === 'number' ? code : -1, ...dockerStream_demux(raw) };
  }

  /**
   * Starts an exec on a hijacked stream: its input written and closed, its output read to the end.
   *
   * @param id - The exec's id.
   * @param stdin - Its input, or null.
   * @returns The multiplexed output.
   */
  private execStream_run(id: string, stdin: string | null): Promise<Buffer> {
    return new Promise((resolve: (data: Buffer) => void, reject: (error: Error) => void): void => {
      const payload: string = JSON.stringify({ Detach: false, Tty: false });
      const req: ClientRequest = httpRequest({
        socketPath: this.socketPath,
        method: 'POST',
        path: `${DOCKER_API}/exec/${id}/start`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const chunks: Buffer[] = [];
      const stream_read = (socket: Socket, head: Buffer): void => {
        if (head.length > 0) chunks.push(head);
        socket.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
        socket.on('end', (): void => { resolve(Buffer.concat(chunks)); });
        socket.on('close', (): void => { resolve(Buffer.concat(chunks)); });
        socket.on('error', reject);
        // The input, then its end: the command reads to EOF.
        if (stdin !== null) socket.write(stdin);
        socket.end();
      };
      req.on('upgrade', (_res: IncomingMessage, socket: Socket, head: Buffer): void => { stream_read(socket, head); });
      // An engine that answers without upgrading sends the stream as the body.
      req.on('response', (res: IncomingMessage): void => {
        res.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
        res.on('end', (): void => { resolve(Buffer.concat(chunks)); });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
