/**
 * @file Migration ratchet — the builtins not yet declared in one record may
 * only fall in number.
 *
 * A declared command (packages/brasa/src/core/commandDeclaration.ts) holds its
 * grammar, kinds, handler, holds and help in one record; the engine parses its
 * line against the grammar, and help, completion and the tool schema read the
 * same record. A command not yet declared is still a name in its group's
 * `envelope` and `plain` records (`core/coreCommands.ts`,
 * `chris/chrisCommands.ts`), handed raw words, with its help in a table
 * beside it.
 *
 * This counts those commands, aliases resolved: names bound to one handler
 * (`feed` and `feeds`) are one command. More than the baseline is a
 * regression and fails. Fewer also fails, with the instruction to lower the
 * baseline in the same change, so each migration locks in.
 *
 * Enforces "One declaration per command" in docs/principles.adoc. Run via
 * `npm run lint:migration`.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

/** Commands not yet declared in one record, aliases resolved. Lower it whenever it drops. */
const BASELINE = 3;

/** The engine's command groups: the core's and the ChRIS backend's. */
const groupPaths = [
  new URL('../packages/brasa/src/core/coreCommands.ts', import.meta.url).pathname,
  new URL('../packages/brasa/src/chris/chrisCommands.ts', import.meta.url).pathname,
];

/** The records of a group that bind a name to a handler of raw words. */
const RECORD_OPENERS = [
  /const envelope: Record<string, EnvelopeHandler> = \{/,
  /const plain: Record<string, CommandHandler> = \{/,
];

/**
 * Maps each name in one record to the handler it binds, the plain record's
 * wrapper taken off, so a name in both records is one binding.
 *
 * @param {string} text - The group's source.
 * @param {RegExp} opener - Matches the record up to its opening brace.
 * @returns {Array<[string, string]>} Name and handler, in order.
 */
function bindings_extract(text, opener) {
  const start = text.match(opener);
  if (start === null) {
    console.error(`command-migration: could not locate ${opener} — has the source moved?`);
    process.exit(1);
  }
  const body = text.slice(start.index + start[0].length);
  const end = body.indexOf('\n};');
  const block = end === -1 ? body : body.slice(0, end);
  return [...block.matchAll(/^\s{2}'?([\w-]+)'?:\s*(.+?),\s*$/gm)].map((match) => {
    const bound = match[2].trim();
    const unwrapped = bound.match(/^envelopeHandler_wrap\((.*)\)$/);
    return [match[1], unwrapped === null ? bound : unwrapped[1]];
  });
}

/** Each name to the command it belongs to: a name, then its aliases joined to it. */
const parent = new Map();

/**
 * The name standing for a name's command.
 *
 * @param {string} name - A command name.
 * @returns {string} The name its command is known by here.
 */
function command_find(name) {
  if (!parent.has(name)) parent.set(name, name);
  const up = parent.get(name);
  if (up === name) return name;
  const root = command_find(up);
  parent.set(name, root);
  return root;
}

// A name is one command in both records, however each binds it; names
// sharing a handler in a record are one command too.
const namesByHandler = new Map();
for (const path of groupPaths) {
  const text = readFileSync(path, 'utf8');
  for (const opener of RECORD_OPENERS) {
    for (const [name, handler] of bindings_extract(text, opener)) {
      command_find(name);
      const key = `${opener.source}\u0000${handler}`;
      const first = namesByHandler.get(key);
      if (first === undefined) namesByHandler.set(key, name);
      else parent.set(command_find(name), command_find(first));
    }
  }
}

const byCommand = new Map();
for (const name of parent.keys()) {
  const root = command_find(name);
  byCommand.set(root, [...(byCommand.get(root) ?? []), name]);
}
const bindings = parent;
const byHandler = byCommand;
const total = byCommand.size;

if (total > BASELINE) {
  console.error(`command-migration: ${total} commands are not declared in one record, baseline is ${BASELINE}.`);
  console.error('A new command declares itself with command_declare (core/commandDeclaration.ts)');
  console.error('and registers through its group\'s declarations, never as a name in the');
  console.error('envelope or plain record. See "One declaration per command" in docs/principles.adoc.');
  console.error([...byHandler.values()].map((names) => `  ${names.join('/')}`).sort().join('\n'));
  process.exit(1);
}

if (total < BASELINE) {
  console.error(`command-migration: undeclared count fell to ${total} (baseline ${BASELINE}) — good.`);
  console.error(`Lower BASELINE to ${total} in scripts/command-migration.mjs as part of this`);
  console.error('change so the improvement locks in.');
  process.exit(1);
}

console.log(`command-migration: ${total} commands not yet declared in one record (${bindings.size} names incl. aliases), at baseline.`);
