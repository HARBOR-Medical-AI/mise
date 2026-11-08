#!/usr/bin/env node
/**
 * @file The berth image's pin: the digest the launcher starts berths from,
 * one constant in apps/porter/src/launcher/launcher.ts, and beside it the
 * SHA-256 of this folder's source the digest was built from.
 *
 *   node images/mise-berth/pin.mjs                       prints the source hash and whether the pin matches it
 *   node images/mise-berth/pin.mjs ghcr.io/…@sha256:…    moves the pin to that digest and records the source hash
 *
 * `lint:berth-pin` runs the first form and fails when the source changed
 * and the pin did not, so a stale default never ships silently. The Berth
 * image workflow builds a branch that changes this folder as soon as it is
 * pushed and names the digest in its run summary; the second form records
 * it, and that commit makes the branch mergeable.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const launcher = join(root, 'apps/porter/src/launcher/launcher.ts');

/** The files the image is built from: everything in this folder but this script and the README. */
const SOURCE = readdirSync(here).filter((name) => !['pin.mjs', 'README.md'].includes(name)).sort();

/**
 * The SHA-256 of the image's source, file names and contents in order.
 *
 * @returns The hex digest.
 */
function source_hash() {
  const hash = createHash('sha256');
  for (const name of SOURCE) {
    hash.update(`${name}\n`);
    hash.update(readFileSync(join(here, name)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

const text = readFileSync(launcher, 'utf-8');
const pinned = /BERTH_IMAGE_DEFAULT: string = '([^']+)'/.exec(text)?.[1];
const recorded = /BERTH_IMAGE_SOURCE: string = '([0-9a-f]{64})'/.exec(text)?.[1];
if (pinned === undefined || recorded === undefined) {
  console.error('pin: launcher.ts carries no BERTH_IMAGE_DEFAULT or BERTH_IMAGE_SOURCE');
  process.exit(2);
}
const now = source_hash();
const digest = process.argv[2];

if (digest !== undefined) {
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(digest)) {
    console.error(`pin: ${digest} is not an image pinned by digest (ghcr.io/<owner>/mise-berth@sha256:…)`);
    process.exit(2);
  }
  const moved = text
    .replace(/BERTH_IMAGE_DEFAULT: string = '[^']+'/, `BERTH_IMAGE_DEFAULT: string = '${digest}'`)
    .replace(/BERTH_IMAGE_SOURCE: string = '[0-9a-f]{64}'/, `BERTH_IMAGE_SOURCE: string = '${now}'`);
  writeFileSync(launcher, moved);
  console.log(`pin: ${digest}\n     source ${now}`);
  process.exit(0);
}

if (now === recorded) {
  console.log(`berth-pin: images/mise-berth is the source of the pinned image (${pinned.split('@')[1]}).`);
  process.exit(0);
}
console.error(`berth-pin: images/mise-berth changed (source ${now.slice(0, 12)}…, the pin was built from ${recorded.slice(0, 12)}…) and BERTH_IMAGE_DEFAULT did not move.`);
console.error('           Push the branch, take the digest from the Berth image workflow\'s run summary, and run: node images/mise-berth/pin.mjs <image@sha256:…>');
process.exit(1);
