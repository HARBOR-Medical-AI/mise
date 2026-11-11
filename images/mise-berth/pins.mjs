#!/usr/bin/env node
/**
 * @file What one build of the berth image is made from, read at the build:
 * the calypso and chell latest published on npm (the ones the latest porter
 * brings, so a berth and the porter a deploy installs speak the same wire),
 * the Node image a stratus deploy runs porter on (`CHRIS_IMAGES.node` in
 * packages/stratus/src/chris/profiles.ts), and the latest upstream Neovim
 * with the SHA-256 GitHub records for each Linux tarball, checked against
 * the download in the build. Nothing here is a version kept in source: each
 * build takes what is latest, and names it exactly so the image records it.
 *
 * Prints `NAME=value` lines, one build argument each, for `--build-arg` or
 * `$GITHUB_OUTPUT`.
 *
 * Usage: node images/mise-berth/pins.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const profiles = readFileSync(join(root, 'packages/stratus/src/chris/profiles.ts'), 'utf-8');

/**
 * One match from the profiles source, or a refusal naming what was missing.
 *
 * @param pattern - The pattern, its first group the value.
 * @param what - What it is, for the refusal.
 * @returns The value.
 */
function profileValue_read(pattern, what) {
  const found = pattern.exec(profiles);
  if (found === null) throw new Error(`pins: ${what} not found in packages/stratus/src/chris/profiles.ts`);
  return found[1];
}

/**
 * The latest published version of a package: what npm's `latest` names.
 *
 * @param name - The package.
 * @returns The exact version.
 */
function versionLatest_read(name) {
  const answer = JSON.parse(execFileSync('npm', ['view', name, 'version', '--json'], { encoding: 'utf-8' }));
  if (typeof answer !== 'string' || !/^\d+\.\d+\.\d+/.test(answer)) throw new Error(`pins: npm names no latest version of ${name}`);
  return answer;
}

const nodeImage = profileValue_read(/node: '([^']+)'/, 'CHRIS_IMAGES.node');
const nodeTag = /:([0-9.]+)-/.exec(nodeImage)?.[1];
if (nodeTag === undefined) throw new Error(`pins: no Node version in ${nodeImage}`);
const calypsoVersion = versionLatest_read('@fnndsc/calypso');
const chellVersion = versionLatest_read('@fnndsc/chell');
// A token, when the environment has one (CI's), keeps GitHub's API from rate-limiting a shared runner.
const auth = process.env['GH_TOKEN'] ? ['-H', `Authorization: Bearer ${process.env['GH_TOKEN']}`] : [];
const nvimRelease = JSON.parse(execFileSync('curl', ['-fsSL', ...auth, 'https://api.github.com/repos/neovim/neovim/releases/latest'], { encoding: 'utf-8' }));
const nvimVersion = nvimRelease.tag_name;
if (typeof nvimVersion !== 'string') throw new Error('pins: the latest Neovim release did not answer with a tag');

/**
 * The SHA-256 GitHub records for one of the release's assets.
 *
 * @param name - The asset's name.
 * @returns The hex digest.
 */
function nvimDigest_read(name) {
  const asset = (nvimRelease.assets ?? []).find((one) => one.name === name);
  const digest = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
  if (digest === undefined) throw new Error(`pins: Neovim ${nvimVersion} records no SHA-256 for ${name}`);
  return digest;
}

for (const [name, value] of [['NODE_VERSION', nodeTag], ['CALYPSO_VERSION', calypsoVersion], ['CHELL_VERSION', chellVersion], ['NVIM_VERSION', nvimVersion], ['NVIM_SHA256_X86_64', nvimDigest_read('nvim-linux-x86_64.tar.gz')], ['NVIM_SHA256_ARM64', nvimDigest_read('nvim-linux-arm64.tar.gz')]]) {
  process.stdout.write(`${name}=${value}\n`);
}
