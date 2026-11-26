/**
 * @file The published workspaces, one per line: folder, name, version.
 *
 * A workspace under `packages/` or `apps/` is published when its
 * `package.json` is not `private`. `make verify-npm` reads this list, so a
 * workspace added tomorrow is compared with npm without anyone
 * remembering to name it. Finding none is an error, not an empty list.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let found = 0;
for (const group of ['packages', 'apps']) {
  if (!existsSync(join(root, group))) continue;
  for (const entry of readdirSync(join(root, group), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, group, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.private !== true) {
      console.log(`${group}/${entry.name} ${manifest.name} ${manifest.version}`);
      found++;
    }
  }
}
// An inventory of nothing is a failure to take one, not an answer.
if (found === 0) {
  console.error(`published-workspaces: no published workspace under ${root}`);
  process.exit(1);
}
