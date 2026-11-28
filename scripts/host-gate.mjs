#!/usr/bin/env node
/**
 * @file The host gate: which engine source files may touch the engine's host,
 * and by which effect.
 *
 * An engine (brasa and the packages it runs: salsa, cumin, stratus, fond,
 * chili, and calypso's daemon) may be attended from elsewhere, by a surface
 * that does not own the machine it runs on. Its host is reached by two
 * effects: the disk (`fs`, `fs/promises`) and programs (`child_process`).
 * Every engine source file that imports either is listed in
 * `scripts/host-gate.json`, per effect, with the one reason it may: the
 * runtime gate it asks first (`hostDisk_refusal`, `hostProcess_refusal`, a
 * daemon tier), or the engine's own state (its config, history and caches).
 *
 * The lint fails:
 *
 * - a file that imports an effect it is not listed for, even one listed for
 *   the other effect;
 * - a listed effect the file no longer imports (the list never rots);
 * - an entry the change's base did not have (the list may shrink, never grow
 *   unreviewed: `scripts/lib/ratchetBase.mjs`);
 * - a pin (a gate call a listed file must hold, by its exact text) that the
 *   file no longer holds, or that the base had and the change dropped.
 *
 * An effect is imported by a static import, an `export … from`, an
 * `import x = require()`, a literal `require()` or `import()`, and through a
 * module that re-exports an effect's bindings (`export { readFile } from
 * 'node:fs'`, `export * as fs from 'fs'`, `export { fs }` of an imported
 * binding), followed through relative imports and through workspace package
 * names and their exported subpaths. Node's prefixed and bare names are one.
 *
 * Usage: node scripts/host-gate.mjs [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { base_resolve, fileAtCommit_read } from './lib/ratchetBase.mjs';

/** The list, from the repository's root. */
export const GATE_FILE = 'scripts/host-gate.json';

/** The engine workspaces whose sources are held. */
export const ENGINE_WORKSPACES = ['packages/brasa', 'packages/salsa', 'packages/cumin', 'packages/stratus', 'packages/fond', 'packages/chili', 'packages/calypso'];

/** The sources read. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Node's effect modules, by every name they go by, to the effect. */
const EFFECT_MODULES = new Map([
  ['fs', 'fs'], ['node:fs', 'fs'], ['fs/promises', 'fs'], ['node:fs/promises', 'fs'],
  ['child_process', 'child_process'], ['node:child_process', 'child_process'],
]);

/** The effects, in the order they are told. */
export const EFFECTS = ['fs', 'child_process'];

/**
 * Lists the source files under a folder.
 *
 * @param {string} dir - The folder.
 * @returns {string[]} The files; none when the folder is not there.
 */
function sources_list(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...sources_list(path)); }
    else if (SOURCE_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Reads the workspace packages: name to folder and exported subpaths.
 *
 * @param {string} root - The repository.
 * @returns {Map<string, { dir: string, exports: Map<string, string> }>} By package name.
 */
function workspaces_read(root) {
  const found = new Map();
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifest = join(base, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof pkg.name !== 'string') continue;
      const exports = new Map();
      const add = (sub, target) => {
        const file = typeof target === 'string' ? target : target?.import ?? target?.default ?? target?.types;
        if (typeof file === 'string') exports.set(sub, file);
      };
      if (typeof pkg.exports === 'string' || (pkg.exports && !Object.keys(pkg.exports).some((k) => k.startsWith('.')))) add('.', pkg.exports);
      else if (pkg.exports) for (const [sub, target] of Object.entries(pkg.exports)) add(sub, target);
      if (!exports.has('.') && typeof pkg.main === 'string') exports.set('.', pkg.main);
      found.set(pkg.name, { dir: join(base, entry.name), exports });
    }
  }
  return found;
}

/**
 * Finds the source file a built path or a relative specifier names.
 *
 * @param {string} base - The path, without its resolution.
 * @returns {string | null} The source file, or null.
 */
function source_find(base) {
  const stem = base.replace(/\.(?:m|c)?js$/, '');
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, join(stem, 'index.ts'), join(stem, 'index.js')]) {
    if (existsSync(candidate) && SOURCE_FILE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves a module specifier to a workspace source file.
 *
 * @param {string} spec - The specifier.
 * @param {string} from - The importing file.
 * @param {Map<string, { dir: string, exports: Map<string, string> }>} packages - The workspace packages.
 * @returns {string | null} The source file, or null when it is outside the workspaces.
 */
function specifier_resolve(spec, from, packages) {
  if (spec.startsWith('.')) return source_find(resolve(dirname(from), spec));
  const match = /^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/.exec(spec);
  if (match === null) return null;
  const pkg = packages.get(match[1]);
  if (pkg === undefined) return null;
  const sub = match[2] === undefined ? '.' : `.${match[2]}`;
  const built = pkg.exports.get(sub);
  if (built === undefined) return null;
  // A built path (dist/x.js) is its source (src/x.ts).
  return source_find(join(pkg.dir, built.replace(/^\.?\/?dist\//, 'src/').replace(/\.d\.ts$/, '.ts')));
}

/**
 * Reads what a file imports and re-exports.
 *
 * @param {string} file - The file.
 * @returns {{ imports: Array<{ spec: string, names: string[] | '*' }>, reexports: Array<{ spec: string, names: Map<string, string> | '*' }>, local: Map<string, string> }}
 *   What it imports (names it takes, or every name), what it re-exports (exported name to the imported one, or every name),
 *   and the bindings it exports of its own imports (exported name to the specifier and imported name, as `spec#name`).
 */
export function moduleLinks_read(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const reexports = [];
  const bound = new Map();
  const local = new Map();
  const literal = (node) => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : null);
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null) {
        const clause = node.importClause;
        let names = [];
        if (clause === undefined) names = [];
        else {
          if (clause.name !== undefined) { names.push('default'); bound.set(clause.name.text, `${spec}#default`); }
          const named = clause.namedBindings;
          if (named !== undefined && ts.isNamespaceImport(named)) { names = '*'; bound.set(named.name.text, `${spec}#*`); }
          else if (named !== undefined) for (const element of named.elements) {
            const original = (element.propertyName ?? element.name).text;
            if (names !== '*') names.push(original);
            bound.set(element.name.text, `${spec}#${original}`);
          }
        }
        // A bare `import 'x'` runs the module: for an effect module that is no binding, but it is counted.
        imports.push({ spec, names: clause === undefined ? '*' : names });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== null) { imports.push({ spec, names: '*' }); bound.set(node.name.text, `${spec}#*`); }
    } else if (ts.isExportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null) {
        const clause = node.exportClause;
        if (clause === undefined) reexports.push({ spec, names: '*' });
        else if (ts.isNamespaceExport(clause)) reexports.push({ spec, names: new Map([[clause.name.text, '*']]) });
        else reexports.push({ spec, names: new Map(clause.elements.map((element) => [element.name.text, (element.propertyName ?? element.name).text])) });
        imports.push({ spec, names: '*' });
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) local.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const spec = (isRequire || isImport) ? literal(node.arguments[0]) : null;
      if (spec !== null) imports.push({ spec, names: '*' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const exportedBindings = new Map();
  for (const [exported, name] of local) { const from = bound.get(name); if (from !== undefined) exportedBindings.set(exported, from); }
  return { imports, reexports, local: exportedBindings };
}

/**
 * Works out the effects each file in scope imports, directly and through re-exports.
 *
 * @param {string} root - The repository.
 * @param {string[]} [workspaces] - The workspaces held.
 * @returns {Map<string, Set<string>>} Effects by file, from the repository's root.
 */
export function effects_find(root, workspaces = ENGINE_WORKSPACES) {
  const packages = workspaces_read(root);
  const links = new Map();
  const link_get = (file) => {
    if (!links.has(file)) links.set(file, moduleLinks_read(file));
    return links.get(file);
  };
  // What a module carries: exported name ('*' for every name) to the effect it gives.
  const carried = new Map();
  const carries_get = (file, seen = new Set()) => {
    if (carried.has(file)) return carried.get(file);
    if (seen.has(file)) return new Map();
    seen.add(file);
    const out = new Map();
    const { reexports, local } = link_get(file);
    const target_carries = (spec) => {
      const effect = EFFECT_MODULES.get(spec);
      if (effect !== undefined) return new Map([['*', effect]]);
      const target = specifier_resolve(spec, file, packages);
      return target === null ? new Map() : carries_get(target, seen);
    };
    for (const { spec, names } of reexports) {
      const theirs = target_carries(spec);
      if (theirs.size === 0) continue;
      if (names === '*') for (const [name, effect] of theirs) out.set(name, effect);
      else for (const [exported, original] of names) {
        const effect = original === '*' ? [...theirs.values()][0] : theirs.get(original) ?? theirs.get('*');
        if (effect !== undefined) out.set(exported, effect);
      }
    }
    for (const [exported, from] of local) {
      const [spec, original] = from.split('#');
      const theirs = target_carries(spec);
      const effect = original === '*' ? [...theirs.values()][0] : theirs.get(original) ?? theirs.get('*');
      if (effect !== undefined) out.set(exported, effect);
    }
    carried.set(file, out);
    return out;
  };
  const found = new Map();
  for (const workspace of workspaces) {
    for (const file of sources_list(join(root, workspace, 'src'))) {
      const effects = new Set();
      for (const { spec, names } of link_get(file).imports) {
        const effect = EFFECT_MODULES.get(spec);
        if (effect !== undefined) { effects.add(effect); continue; }
        const target = specifier_resolve(spec, file, packages);
        if (target === null) continue;
        const theirs = carries_get(target);
        if (names === '*') for (const given of theirs.values()) effects.add(given);
        else for (const name of names) { const given = theirs.get(name) ?? theirs.get('*'); if (given !== undefined) effects.add(given); }
      }
      if (effects.size > 0) found.set(relative(root, file), effects);
    }
  }
  return found;
}

/**
 * Reads a gate list.
 *
 * @param {string} text - The list's text.
 * @param {string} where - Where it was read, for the error.
 * @returns {{ files: Record<string, Record<string, string>>, pins: Array<{ file: string, text: string, why: string }> }} The list.
 * @throws {Error} When it is not one.
 */
export function gate_parse(text, where) {
  const list = JSON.parse(text);
  if (typeof list !== 'object' || list === null || typeof list.files !== 'object' || !Array.isArray(list.pins)) throw new Error(`${where} is not a host gate list (files and pins)`);
  for (const [file, effects] of Object.entries(list.files)) {
    for (const [effect, reason] of Object.entries(effects)) {
      if (!EFFECTS.includes(effect)) throw new Error(`${where}: ${file} lists ${effect}, which is no effect (${EFFECTS.join(', ')})`);
      if (typeof reason !== 'string' || reason.trim().length < 12) throw new Error(`${where}: ${file} ${effect} gives no reason`);
    }
  }
  for (const pin of list.pins) if (typeof pin?.file !== 'string' || typeof pin?.text !== 'string' || typeof pin?.why !== 'string') throw new Error(`${where}: a pin needs a file, a text and a why`);
  return list;
}

/**
 * Judges the effects found against the list, and the list against its base.
 *
 * @param {Map<string, Set<string>>} found - Effects by file.
 * @param {ReturnType<typeof gate_parse>} list - The list.
 * @param {ReturnType<typeof gate_parse> | null} atBase - The list at the base; null when the base had none.
 * @param {(file: string) => string | null} file_read - Reads a file from the repository's root (null when it is not there).
 * @returns {string[]} The faults; none means it holds.
 */
export function gate_judge(found, list, atBase, file_read) {
  const faults = [];
  for (const [file, effects] of found) {
    for (const effect of effects) if (list.files[file]?.[effect] === undefined) faults.push(`${file} imports ${effect}, and ${GATE_FILE} does not list it for that: ask the host gate first (hostDisk_refusal, hostProcess_refusal) and list it with its reason, or reach the host through a module that does`);
  }
  for (const [file, effects] of Object.entries(list.files)) {
    for (const effect of Object.keys(effects)) if (!found.get(file)?.has(effect)) faults.push(`${GATE_FILE} lists ${file} for ${effect}, which it no longer imports: drop the entry`);
  }
  for (const pin of list.pins) {
    const text = file_read(pin.file);
    if (text === null || !text.replace(/\s+/g, ' ').includes(pin.text.replace(/\s+/g, ' '))) faults.push(`${pin.file} no longer holds its gate \`${pin.text}\` (${pin.why})`);
  }
  if (atBase !== null) {
    for (const [file, effects] of Object.entries(list.files)) {
      for (const effect of Object.keys(effects)) if (atBase.files[file]?.[effect] === undefined) faults.push(`${GATE_FILE} gains ${file} for ${effect}, which the base did not list: a new reach into the host is reviewed on its own, not admitted by growing the list`);
    }
    const kept = new Set(list.pins.map((pin) => `${pin.file}\u0000${pin.text}`));
    for (const pin of atBase.pins) if (!kept.has(`${pin.file}\u0000${pin.text}`)) faults.push(`${GATE_FILE} drops the pin on ${pin.file} (\`${pin.text}\`) that the base had`);
  }
  return faults;
}

/** Runs the lint. */
function main() {
  const argv = process.argv.slice(2);
  const root = resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : fileURLToPath(new URL('..', import.meta.url)));
  const listPath = join(root, GATE_FILE);
  if (!existsSync(listPath)) { console.error(`host-gate: ${GATE_FILE} is missing`); process.exit(2); }
  let list;
  let atBase = null;
  let baseNote;
  try {
    list = gate_parse(readFileSync(listPath, 'utf8'), GATE_FILE);
    const base = base_resolve(process.env, root);
    const text = fileAtCommit_read(base.sha, GATE_FILE, root);
    atBase = text === null ? null : gate_parse(text, `${GATE_FILE} at the base (${base.sha.slice(0, 8)})`);
    baseNote = text === null ? `the base (${base.how}, ${base.sha.slice(0, 8)}) has no list yet: this change brings it` : `held to the base (${base.how}, ${base.sha.slice(0, 8)})`;
  } catch (error) {
    console.error(`host-gate: ${error.message}`);
    process.exit(2);
  }
  const found = effects_find(root);
  const faults = gate_judge(found, list, atBase, (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null));
  if (faults.length > 0) {
    console.error(`host-gate: ${faults.length} fault(s):`);
    for (const fault of faults) console.error(`  ${fault}`);
    process.exit(1);
  }
  console.log(`host-gate: ${found.size} engine file(s) reach the host, each listed with its reason; ${list.pins.length} gate pin(s) hold; ${baseNote}.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
