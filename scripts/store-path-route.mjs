/**
 * @file Store-path route — one route from a typed path to the store.
 *
 * A path as typed (`~/x`, a relative path, `/proc/jobs/…/data/…`, a path
 * through a `.chrislink`) is not where CUBE keeps the file. One function
 * answers where it is: `storePath_resolve` in packages/brasa/src/core/paths.ts.
 * A read that skips it reads the wrong place: the `/proc` mount once read a
 * job's `data` path directly and never followed the links under it, so every
 * file behind a `pl-dircopy` link was unreadable there (#1509).
 *
 * The code is in three tiers, and the check holds each to its part, over
 * every TypeScript source under packages/*\/src and apps/*\/src (comments and
 * string contents blanked, tests left out):
 *
 * - The store: cumin, salsa outside its mounts, chili (the standalone CLI,
 *   which brasa depends on and so cannot ask brasa's resolver; its own
 *   command line resolves through salsa's link mapper in utils/cli.ts), and
 *   the dispatcher's own provider for CUBE files
 *   (salsa/src/vfs/providers/native.ts), which the dispatcher hands only a
 *   path the resolver answered. These take store paths and may call the store
 *   IO functions (`STORE_IO`) freely.
 * - The mounts (salsa/src/vfs/providers/*, but native.ts): a mount calls no
 *   store IO function. A mount that stands for a store folder says so
 *   (`storePath_resolve` on the provider, which the resolver asks) and hands
 *   the store path to the dispatcher, whose fallback resolves it again.
 * - Above the store (brasa, calypso, chell, stratus, menu, orrery, trek and
 *   the apps): each call of a store IO function stands in a function that
 *   asks `storePath_resolve` (calls it, or hands it on as a callback), or
 *   asks a function that does (one of the same module, or one another module
 *   exports); or in a function of its
 *   module's own, never exported nor handed on, that only such functions
 *   call. A call through the dispatcher (`vfsDispatcher.read`, `list`,
 *   `write`, …) is routed by construction: the dispatcher's path resolver is
 *   `storePath_resolve`.
 *
 * A call handed a store path CUBE gave (a listing's `fname`, a path built
 * from a feed's and a job's ids), in a mount or above the store, says so
 * with a `store-path:` comment on its line or the line above, and where the
 * path came from. That comment is the whole exemption, as `listing-bound:`
 * is for listings.
 *
 * Two anchors hold that last sentence true: the dispatcher's path resolver
 * is registered in one place (brasa/src/chris/mounts.ts) and it is
 * `storePath_resolve`; and the link mapper (`logicalPath_resolve`) and the
 * backend's link step (`vfs.path_physical`) are named only by the store and
 * the resolver.
 *
 * The rule is by name, not by data flow: it holds that the resolver is in
 * the function that reaches the store, not that the very value handed on is
 * its answer. That is what makes it simple enough to trust; review holds
 * the rest.
 *
 * Calls not yet routed are named in `UNROUTED`, a ratchet: its count may
 * only fall, and a routed one must leave the list in the same change.
 *
 * `--list` prints every store call above the store, routed or marked.
 *
 * Enforces "One route from a typed path to the store" in docs/principles.adoc.
 * Run via `npm run lint:store-paths`.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/**
 * The store's IO functions that take a path: salsa's files, its DICOM
 * readers, cumin's raw IO and by-path lookups, and the chili commands
 * brasa calls with a path.
 */
const STORE_IO = [
  // salsa/src/files
  'fileContent_get', 'fileContent_getBinary', 'fileContent_getBinaryStream',
  'fileContent_getRegular', 'fileContent_getRegularBinary', 'fileContent_getRegularStream',
  'fileContent_getPACS', 'fileContent_getPACSBinary', 'fileContent_getPipeline', 'fileContent_getPipelineBinary',
  'pathFileId_resolve',
  'files_listRecursive', 'files_copyRecursively', 'files_path_isDirectory', 'files_create', 'files_touch',
  'files_copy', 'files_move', 'files_uploadPath', 'pathHolders_find', 'folderPath_holder', 'files_mkdir',
  'files_getGroup', 'files_list', 'files_listAll', 'files_listOutcome', 'files_delete', 'folderByPath_delete',
  // salsa/src/dicom
  'dicomSlice_gray', 'dicomHeader_get', 'dicomHeaderPrefix_get', 'dicomFolder_list', 'dicomSeries_summarize',
  // cumin
  'chrisIO', 'ChRISinode_create', 'ChRISFileBrowser', 'pipelineFile_getByPath', 'pipelineFile_getTextByPath',
  // chili's commands, as brasa calls them
  'files_cat', 'files_catBinary', 'files_cp', 'files_mv', 'files_rm', 'files_upload', 'files_uploadWithProgress',
  'files_downloadWithProgress', 'files_downloadManyWithProgress', 'file_replaceContent', 'scan_do',
];

/** Names only the store and the resolver may say: the link mapper and the backend's link step. */
const RESOLVER_PARTS = ['logicalPath_resolve', 'path_physical'];

/** The resolver. */
const RESOLVER = 'storePath_resolve';

/** The marker that says a call is handed a store path CUBE gave, with where from. */
const MARKER = 'store-path:';

/** The store tier: may call the store IO functions with the store paths it is handed. */
const STORE_TIER = [/^packages\/cumin\//, /^packages\/chili\//, /^packages\/fond\//, /^packages\/salsa\/src\/(?!vfs\/providers\/)/, /^packages\/salsa\/src\/vfs\/providers\/native\.ts$/];

/** The mounts: name no store IO function. */
const MOUNT_TIER = /^packages\/salsa\/src\/vfs\/providers\//;

/** The resolver's own modules: the resolver, the backend's seam that names its link step, and that step. */
const RESOLVER_MODULES = ['packages/brasa/src/core/paths.ts', 'packages/brasa/src/core/backend.ts', 'packages/brasa/src/chris/filesystem.ts'];

/** Where the dispatcher's path resolver is registered, and with what. */
const HOOK_MODULE = 'packages/brasa/src/chris/mounts.ts';

/**
 * Calls above the store not yet routed, each `module:function` with its
 * reason. A ratchet: it may only shrink.
 */
const UNROUTED = [];

/** The committed count of `UNROUTED`. Lower it whenever a call is routed. */
const BASELINE = 0;

/**
 * Every TypeScript source under a folder, tests and builds left out.
 *
 * @param {string} folder - The folder.
 * @returns {string[]} The files.
 */
function sources_list(folder) {
  const found = [];
  for (const entry of readdirSync(folder)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) found.push(...sources_list(path));
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

/**
 * The `src` folders of every package and app.
 *
 * @returns {string[]} The folders.
 */
function sourceRoots_list() {
  const roots = [];
  for (const parent of ['packages', 'apps']) {
    let names = [];
    try { names = readdirSync(join(root, parent)); } catch { continue; }
    for (const name of names) {
      const src = join(root, parent, name, 'src');
      try { if (statSync(src).isDirectory()) roots.push(src); } catch { /* no src */ }
    }
  }
  return roots;
}

/**
 * A source with its comments and the contents of its strings, template
 * texts and regular expressions blanked, lines and offsets kept, so names
 * and braces are only the code's.
 *
 * @param {string} text - The source.
 * @returns {string} The code alone.
 */
function code_blank(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let at = from; at < to; at++) if (out[at] !== '\n') out[at] = ' '; };
  // Each open template expression remembers the brace depth it opened at.
  const templates = [];
  let depth = 0;
  let at = 0;
  let last = '';
  const template_read = () => {
    // From just after a backtick or a closing `}` of an expression: text to the next `${` or backtick.
    const start = at;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at] === '`') { blank(start, at); at++; last = '`'; return; }
      if (text[at] === '$' && text[at + 1] === '{') { blank(start, at); templates.push(depth); depth++; at += 2; last = '{'; return; }
      at++;
    }
    blank(start, at);
  };
  while (at < text.length) {
    const char = text[at];
    const next = text[at + 1];
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', at);
      blank(at, end === -1 ? text.length : end);
      at = end === -1 ? text.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2);
      blank(at, end === -1 ? text.length : end + 2);
      at = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"') {
      const start = at + 1;
      at++;
      while (at < text.length && text[at] !== char && text[at] !== '\n') at += text[at] === '\\' ? 2 : 1;
      blank(start, at);
      at++;
      last = char;
      continue;
    }
    if (char === '`') { at++; template_read(); continue; }
    if (char === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /\b(return|typeof|case|in|of|void|delete)$/.test(text.slice(Math.max(0, at - 8), at).trimEnd()))) {
      // A regular expression: to its closing slash, outside any class.
      const start = at + 1;
      at++;
      let inClass = false;
      while (at < text.length && text[at] !== '\n') {
        if (text[at] === '\\') { at += 2; continue; }
        if (text[at] === '[') inClass = true;
        else if (text[at] === ']') inClass = false;
        else if (text[at] === '/' && !inClass) break;
        at++;
      }
      blank(start, at);
      at++;
      last = '/';
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        at++;
        template_read();
        continue;
      }
    }
    if (!/\s/.test(char)) last = char;
    at++;
  }
  return out.join('');
}

/**
 * The module's top-level declarations, and a class's members, each with its
 * name, span and text.
 *
 * @param {string} code - The blanked source.
 * @returns {{ chunks: Array<{ name: string, from: number, to: number, exported: boolean }>, balanced: boolean }}
 */
function chunks_find(code) {
  const chunks = [];
  const split = (from, to, prefix, classExported) => {
    let depth = 0;
    let start = from;
    const close = (end) => {
      const text = code.slice(start, end);
      if (text.trim() !== '') {
        const header = text.slice(0, Math.max(0, text.search(/[{=(]/)) || text.length);
        // A module's declaration, or a class's member; any other statement is the module's own.
        const named = prefix === ''
          ? text.match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?\s*|class\s+|interface\s+|type\s+|enum\s+|namespace\s+|(?:const|let|var)\s+)([\w$]+)/)
          : text.match(/^\s*(?:@[\w$.]+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|readonly|override|abstract|declare|async|get|set)\s+)*\*?([\w$]+)/);
        const name = named?.[1] ?? '<top>';
        const exported = /^\s*export\b/.test(text);
        if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s/.test(header) || /^\s*(?:export\s+)?(?:abstract\s+)?class\s/.test(text)) {
          const open = code.indexOf('{', start);
          split(open + 1, end - 1, `${name}.`, exported);
        } else if (!/^\s*(?:import|export\s*(?:\{|\*|type\b))/.test(text)) {
          // A class's member is reached from wherever its class is.
          chunks.push({ name: `${prefix}${name}`, from: start, to: end, exported: prefix === '' ? exported : classExported });
        }
      }
      start = end;
    };
    for (let at = from; at < to; at++) {
      const char = code[at];
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          // A block ends a declaration when a new statement follows it, not
          // a type's or an expression's next part (`} | {`, `}) {`, `} else`).
          const after = code.slice(at + 1).match(/^\s*(\S+)/)?.[1] ?? '';
          if (after === '' || (/^[\w$@]/.test(after) && !/^(else|catch|finally|as|satisfies|extends|implements|instanceof|in|of)\b/.test(after))) close(at + 1);
        }
      } else if (char === ';' && depth === 0) close(at + 1);
    }
    close(to);
    return depth === 0;
  };
  const balanced = split(0, code.length, '', false);
  return { chunks, balanced };
}

/**
 * The line a position stands on.
 *
 * @param {string} text - The source.
 * @param {number} at - The position.
 * @returns {number} The line, from 1.
 */
function line_at(text, at) {
  return text.slice(0, at).split('\n').length;
}

/**
 * The names a module binds to store IO functions: the functions themselves,
 * and each local name an import or a destructure gives one (`files_touch as
 * chefs_touch_cmd`, `{ files_create: create }`).
 *
 * @param {string} code - The blanked source.
 * @returns {Set<string>} The names.
 */
function storeNames_bind(code) {
  const names = new Set(STORE_IO);
  for (const block of code.matchAll(/(?:import\s*(?:type\s*)?\{|(?:const|let)\s*\{)([^}]*)\}/g)) {
    for (const piece of block[1].split(',')) {
      const alias = piece.trim().match(/^(?:type\s+)?([\w$]+)\s*(?:as|:)\s*([\w$]+)$/);
      if (alias !== null && names.has(alias[1])) names.add(alias[2]);
    }
  }
  return names;
}

const tierOf = (where) => {
  if (RESOLVER_MODULES.includes(where)) return 'resolver';
  if (STORE_TIER.some((pattern) => pattern.test(where))) return 'store';
  if (MOUNT_TIER.test(where)) return 'mount';
  return 'session';
};

const problems = [];
const modules = [];
for (const folder of sourceRoots_list()) {
  for (const path of sources_list(folder)) {
    const text = readFileSync(path, 'utf8');
    const where = relative(root, path);
    const code = code_blank(text);
    modules.push({ where, text, code, tier: tierOf(where) });
  }
}

// The resolver, and every function above the store that asks it, by name:
// those another module exports reach every module; the rest, their own.
const RESOLVING_EXPORTED = new Set([RESOLVER]);
const sessionChunks = [];
for (const module of modules) {
  if (module.tier !== 'session') continue;
  const { chunks, balanced } = chunks_find(module.code);
  if (!balanced) problems.push(`${module.where}: its braces do not balance as read — the check cannot place its calls`);
  module.chunks = chunks.map((chunk) => ({ ...chunk, body: module.code.slice(chunk.from, chunk.to) }));
  module.resolving = new Set([RESOLVER]);
  sessionChunks.push(module);
}
const name_escape = (name) => name.replace(/\$/g, '\\$');
/** Whether a body names one of the names. */
const names_said = (body, names) => [...names].some((name) => new RegExp(`(?<![\\w$])${name_escape(name)}(?![\\w$])`).test(body));
/** Whether a body calls one of the names (a mention that hands a function on is not a call). */
const names_called = (body, names) => [...names].some((name) => new RegExp(`(?<![\\w$])${name_escape(name)}\\s*(?:<[^<>()]*>)?\\s*\\(`).test(body));
/** Whether a body names a function without calling it: hands it on, or registers it. */
const name_handedOn = (body, name) => [...body.matchAll(new RegExp(`(?<![\\w$])${name_escape(name)}(?![\\w$])`, 'g'))]
  .some((found) => !/^\s*(?:<[^<>()]*>)?\s*\(/.test(body.slice(found.index + name.length)));
for (let moved = true; moved;) {
  moved = false;
  for (const module of sessionChunks) {
    for (const chunk of module.chunks) {
      const bare = chunk.name.replace(/^.*\./, '');
      if (module.resolving.has(bare)) continue;
      const body = chunk.body.slice(chunk.body.indexOf(bare) + bare.length);
      // Asking is calling it or handing it on (`sources.map(source_resolve)`).
      if (names_said(body, module.resolving) || names_said(body, RESOLVING_EXPORTED)) {
        module.resolving.add(bare);
        // Only a module's own exported functions are known by name elsewhere; a member is called on its object.
        if (chunk.exported && !chunk.name.includes('.')) RESOLVING_EXPORTED.add(bare);
        moved = true;
      }
    }
  }
}

/**
 * Whether a function is reached only through functions that ask the
 * resolver: it is not exported, nothing hands it on (a registry, a callback),
 * something in its module calls it, and every caller asks or is itself
 * reached only so.
 *
 * @param {object} module - The module, its declarations read.
 * @param {string} bare - The function's name.
 * @param {Set<string>} path - The names on the way here, so a cycle answers no.
 * @returns {boolean} True when every way in has asked.
 */
function reached_routed(module, bare, path = new Set()) {
  const own = module.chunks.find((chunk) => chunk.name.replace(/^.*\./, '') === bare);
  if (own === undefined || own.exported || path.has(bare)) return false;
  const on = new Set([...path, bare]);
  const others = module.chunks.filter((chunk) => chunk !== own);
  if (others.some((chunk) => name_handedOn(chunk.body, bare))) return false;
  const callers = others.filter((chunk) => names_called(chunk.body, [bare]));
  return callers.length > 0 && callers.every((chunk) => {
    const caller = chunk.name.replace(/^.*\./, '');
    return module.resolving.has(caller) || reached_routed(module, caller, on);
  });
}

/** Every store call above the store, for `--list`. */
const listed = [];
let routedCalls = 0;
let markedCalls = 0;
const unrouted = [];
for (const module of modules) {
  const { where, text, code, tier } = module;
  if (tier === 'store') continue;
  const lines = text.split('\n');
  if (tier !== 'resolver') {
    for (const name of RESOLVER_PARTS) {
      // A backend's link step is reached only through the resolver.
      for (const found of code.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g'))) {
        problems.push(`${where}:${line_at(code, found.index)}: names '${name}', a part of the resolver; ask storePath_resolve`);
      }
    }
  }
  if (tier === 'resolver') continue;
  const names = storeNames_bind(code);
  const pattern = new RegExp(`(?<![\\w$])(${[...names].join('|')})(?![\\w$])`, 'g');
  // Naming it in an import or a destructure of one is not a call.
  const bindings = [...code.matchAll(/(?:import\s*(?:type\s*)?\{[^}]*\}\s*from|(?:const|let)\s*\{[^}]*\}\s*=\s*(?:await\s+)?import\()/g)]
    .map((found) => [found.index, found.index + found[0].length]);
  for (const found of code.matchAll(pattern)) {
    const line = line_at(code, found.index);
    if (bindings.some(([from, to]) => from <= found.index && found.index < to)) continue;
    const marked = (lines[line - 1] ?? '').includes(MARKER) || (lines[line - 2] ?? '').includes(MARKER);
    if (tier === 'mount') {
      if (marked) { markedCalls++; listed.push(`marked  ${where}:${line} (mount) → ${found[1]}`); continue; }
      problems.push(`${where}:${line}: a mount calls '${found[1]}'; hand the store path to the dispatcher, which resolves it`);
      continue;
    }
    const chunk = module.chunks.find((c) => c.from <= found.index && found.index < c.to);
    const name = chunk?.name ?? '<top>';
    const bare = name.replace(/^.*\./, '');
    if (module.resolving.has(bare)) { routedCalls++; listed.push(`routed  ${where}:${line} ${name} → ${found[1]}`); continue; }
    if (reached_routed(module, bare)) { routedCalls++; listed.push(`routed  ${where}:${line} ${name} → ${found[1]} (through its callers)`); continue; }
    if (marked) { markedCalls++; listed.push(`marked  ${where}:${line} ${name} → ${found[1]}`); continue; }
    unrouted.push({ key: `${where}:${name}`, text: `${where}:${line}: ${name} calls '${found[1]}' and never asks storePath_resolve` });
  }
}

// The dispatcher's resolver: registered once, and it is the one resolver.
for (const module of modules) {
  if (/(?<![\w$])pathResolver_register\(/.test(module.code) && module.where !== HOOK_MODULE && !module.where.startsWith('packages/fond/')) {
    problems.push(`${module.where}: registers a path resolver on the dispatcher; the one resolver is registered in ${HOOK_MODULE}`);
  }
}
const hook = modules.find((module) => module.where === HOOK_MODULE);
if (hook === undefined || !/pathResolver_register\([\s\S]{0,200}?storePath_resolve\(/.test(hook.code)) {
  problems.push(`${HOOK_MODULE}: the dispatcher's path resolver is not storePath_resolve — has the source moved?`);
}

const allowed = new Set(UNROUTED.map((entry) => entry.split(' ')[0]));
const unroutedKeys = new Set(unrouted.map((call) => call.key));
for (const call of unrouted) if (!allowed.has(call.key)) problems.push(call.text);
for (const key of allowed) if (!unroutedKeys.has(key)) problems.push(`${key}: listed in UNROUTED but routed now; remove it and lower BASELINE`);
if (UNROUTED.length !== BASELINE) problems.push(`UNROUTED holds ${UNROUTED.length}, BASELINE says ${BASELINE}; they move together`);
if (routedCalls === 0) problems.push('found no routed store call anywhere — has the source moved?');

if (process.argv.includes('--list')) console.log(listed.join('\n'));

if (problems.length > 0) {
  console.error('store-path-route: a typed path reaches the store only through storePath_resolve (packages/brasa/src/core/paths.ts).');
  console.error('Ask it in the function that reaches the store, or hand the path to the dispatcher; a path CUBE gave says so with');
  console.error(`\`// ${MARKER} <where it came from>\`. See "One route from a typed path to the store" in docs/principles.adoc.`);
  console.error(problems.map((problem) => `  ${problem}`).join('\n'));
  process.exit(1);
}

console.log(`store-path-route: ${routedCalls} store calls above the store ask storePath_resolve, ${markedCalls} say they are handed a store path, ${UNROUTED.length} unrouted (baseline ${BASELINE}); the dispatcher's one resolver is storePath_resolve.`);
