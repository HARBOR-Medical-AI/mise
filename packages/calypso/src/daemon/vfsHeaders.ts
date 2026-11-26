/**
 * @file The headers `/vfs` sends with a file's bytes.
 *
 * The bytes are a file somebody put in the store. Served from the daemon's
 * own address, a file that says it is a page or a script would run there
 * with the session's standing, were a browser ever led to it. So a file is
 * never offered as something a browser runs:
 *
 * - a type a browser executes (a page, a script, a stylesheet, a module of
 *   WebAssembly, XML with its transforms) is sent as plain bytes, to save;
 * - a type that is safe drawn in an `img` and active opened as a document
 *   (SVG) keeps its type, so a surface can draw it, and is an attachment,
 *   so a navigation saves it;
 * - every file carries `nosniff`, so the type sent is the type used, and a
 *   policy that sandboxes it and loads nothing, should it be shown as a
 *   document after all.
 *
 * A surface reads these files by `fetch`, draws them in an `img`, or saves
 * them; none of the three is changed by any of this.
 *
 * @module
 */
import * as path from 'node:path';
import { contentDisposition_format, contentType_derive } from './static.js';

/** The type a file is sent as when its own would run in a browser. */
const INERT_TYPE: string = 'application/octet-stream';

/** Extensions a browser executes, as a document or as a subresource. */
const EXECUTED: ReadonlySet<string> = new Set([
  '.html', '.htm', '.shtml', '.xhtml', '.xht',
  '.js', '.mjs', '.cjs', '.css', '.wasm',
  '.xml', '.xsl', '.xslt',
]);

/** Extensions that keep their type and are saved when navigated to. */
const SAVED: ReadonlySet<string> = new Set(['.svg', '.svgz', '.pdf']);

/** What a document made of these bytes may do: nothing. */
export const VFS_CONTENT_POLICY: string = "sandbox; default-src 'none'";

/**
 * The headers for one file's bytes on `/vfs`.
 *
 * @param filePath - The path served; its extension decides.
 * @param download - Whether the surface asked for a save (`download=1`).
 * @param size - The length in bytes, when it is known.
 * @returns The response headers.
 */
export function vfsHeaders_build(filePath: string, download: boolean, size?: number): Record<string, string | number> {
  const extension: string = path.extname(filePath).toLowerCase();
  const executed: boolean = EXECUTED.has(extension);
  const headers: Record<string, string | number> = {
    'content-type': executed ? INERT_TYPE : contentType_derive(filePath),
    'x-content-type-options': 'nosniff',
    'content-security-policy': VFS_CONTENT_POLICY,
  };
  if (size !== undefined) headers['content-length'] = size;
  if (download || executed || SAVED.has(extension)) {
    headers['content-disposition'] = contentDisposition_format(filePath);
  }
  return headers;
}
