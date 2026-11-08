/**
 * @file The secret porter carries to the berth launcher: one file both read,
 * only its owner may.
 *
 * @module
 */
import { readFileSync, statSync } from 'node:fs';

/**
 * Reads the shared secret: a file only its owner can read.
 *
 * @param path - The file.
 * @returns The secret.
 * @throws {Error} When it is missing, open to others, or too short.
 */
export function launcherSecret_read(path: string | undefined): string {
  if (path === undefined || path === '') throw new Error('the launcher\'s secret file is required: the secret porter carries to it');
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path}: readable by others; give it mode 0600`);
  const secret: string = readFileSync(path, 'utf-8').trim();
  if (secret.length < 32) throw new Error(`${path}: the secret is shorter than 32 characters`);
  return secret;
}
