/**
 * @file The published workspaces, one per line: folder, name, version.
 *
 * A workspace under `packages/` or `apps/` is published when its
 * `package.json` is not `private`. `make verify-npm` reads this list, so a
 * workspace added tomorrow is compared with npm without anyone
 * remembering to name it.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
for (const group of ['packages', 'apps']) {
  if (!existsSync(join(root, group))) continue;
  for (const entry of readdirSync(join(root, group), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, group, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.private !== true) console.log(`${group}/${entry.name} ${manifest.name} ${manifest.version}`);
  }
}
