/**
 * @file Why a read was refused, asked of the route that refused it.
 *
 * An image loader reports that a slice failed and little else; the daemon's
 * `/vfs` route answers a refused read with a status and one line saying
 * why (not yours to read, no such file, CUBE could not serve it), and the
 * porter in front of it answers for itself with `{"error": "…"}`. Asked
 * again after the failure, that line is the readout, in plain words either
 * way. A route that answers 200 is read to the end: a body that stops part
 * way is a file that stopped arriving, not one that will not decode.
 */
import { bytes_words } from '../files/transfer.js';

/**
 * Asks the byte route why it refused a URL.
 *
 * @param url - The bytes' URL, as the loader used it (a `wadouri:` prefix
 *   and a `&frame=` suffix are stripped).
 * @returns The route's reason in capitals with its status;
 *   `THE FILE STOPPED ARRIVING PART WAY (…)` when a 200's body stops short;
 *   `COULD NOT BE DECODED` when the whole file came; a plain
 *   `COULD NOT BE READ` when the route itself does not answer.
 */
export async function refusal_explain(url: string): Promise<string> {
  const plain: string = url.replace(/^wadouri:/, '').replace(/&frame=\d+$/, '');
  let response: Response;
  try {
    response = await fetch(plain, { cache: 'no-store' });
  } catch {
    return 'COULD NOT BE READ';
  }
  if (response.ok) return await answerWhole_check(response);
  let body: string = '';
  try {
    body = await response.text();
  } catch {
    // A refusal whose own words broke off says its status alone.
  }
  // The route's line carries CUBE's status when it has one; the route's
  // own is added only when the line does not already say it.
  const line: string = refusalLine_read(body);
  const said: string = (line === '' ? 'REFUSED' : line).toUpperCase();
  return said.includes(`(${response.status})`) ? said : `${said} (${response.status})`;
}

/**
 * The words in a refusal's body: the porter's `{"error": "…"}` unwrapped,
 * else the body's first line.
 *
 * @param body - The refusal's body, as text.
 * @returns The line, trimmed; empty when the body says nothing.
 */
function refusalLine_read(body: string): string {
  const first: string = body.split('\n')[0]?.trim() ?? '';
  if (!first.startsWith('{')) return first;
  try {
    const parsed: unknown = JSON.parse(body);
    const error: unknown = (parsed as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error.trim() : first;
  } catch {
    return first;
  }
}

/**
 * Reads a 200's body to its end, to tell a file that stopped arriving from
 * one that came whole and would not decode.
 *
 * @param response - The route's 200.
 * @returns `THE FILE STOPPED ARRIVING PART WAY (…)` with how much came, when
 *   the body broke off or fell short of its stated length; otherwise
 *   `COULD NOT BE DECODED`.
 */
async function answerWhole_check(response: Response): Promise<string> {
  const stated: number = Number(response.headers.get('content-length') ?? Number.NaN);
  let received: number = 0;
  let broke: boolean = false;
  try {
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (reader === undefined) {
      received = (await response.arrayBuffer()).byteLength;
    } else {
      for (let step: ReadableStreamReadResult<Uint8Array> = await reader.read(); !step.done; step = await reader.read()) {
        received += step.value.byteLength;
      }
    }
  } catch {
    broke = true;
  }
  const short: boolean = Number.isFinite(stated) && received < stated;
  if (!broke && !short) return 'COULD NOT BE DECODED';
  const howFar: string = Number.isFinite(stated) ? `${bytes_words(received)} OF ${bytes_words(stated)}` : `AFTER ${bytes_words(received)}`;
  return `THE FILE STOPPED ARRIVING PART WAY (${howFar})`;
}
