/**
 * @file The AEGIS doctrine gate.
 *
 * Statically enforces the machine-checkable laws of apps/argus/docs/aegis.adoc
 * ("The laws" table) against the argus surface, and enforces the table itself:
 * every law must name an enforcement that exists (a check in this file, or a
 * scenario string present in the smoke suite). Doctrine cannot be written
 * without teeth.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const html = readFileSync('apps/argus/index.html', 'utf8');
const css = readFileSync('apps/argus/src/lcars/argus.css', 'utf8');
const aegis = readFileSync('apps/argus/docs/aegis.adoc', 'utf8');
const smoke = readFileSync('apps/argus/tests/smoke/smoke.mjs', 'utf8');
const sources = ['apps/argus/src/app/main.ts', 'apps/argus/src/console/argusLang.ts']
  .map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

/** Every feature panel's source, by path. */
const features = readdirSync('apps/argus/src/features', { recursive: true })
  .filter((name) => String(name).endsWith('.ts'))
  .map((name) => `apps/argus/src/features/${String(name).replaceAll('\\', '/')}`)
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

const failures = [];
const fail = (law, detail) => failures.push(`${law}: ${detail}`);

/** All checks this file implements, by law id. */
const LINT_CHECKS = {};

// ------------------------------------------------------------------ helpers

/** Extracts each workspace pane's markup (templates and static panes). */
function panes_extract() {
  const panes = [];
  for (const m of html.matchAll(/<template id="(tpl-pane-[a-z]+)">([\s\S]*?)<\/template>/g)) {
    panes.push({ name: m[1], body: m[2] });
  }
  const staticPane = html.match(/<div class="workspace-pane" id="pacs-workspace">([\s\S]*?)\n {12}<\/div>\n/);
  if (staticPane) panes.push({ name: 'pacs-workspace', body: staticPane[1] });
  return panes;
}

/** Extracts the inner markup of every terminal-header bar. */
function bars_extract() {
  // A header bar always terminates in its end-cap; capture through the cap
  // rather than guessing at the next sibling (a comment between siblings
  // once made this swallow a drawer's buttons into the "bar").
  return [...html.matchAll(/<div class="lcars-terminal-header-bar[^"]*"[^>]*>([\s\S]*?<div class="lcars-bar-end[^"]*"[^>]*>[^<]*<\/div>)/g)]
    .map((m) => m[1]);
}

// ------------------------------------------------------------------- checks

LINT_CHECKS['drawer-everywhere'] = () => {
  for (const pane of panes_extract()) {
    if (!pane.body.includes('pane-handle')) fail('drawer-everywhere', `${pane.name} has no pane-handle`);
    if (!pane.body.includes('pane-drawer')) fail('drawer-everywhere', `${pane.name} has no pane-drawer`);
    for (const group of ['drawer-structure', 'drawer-binding']) {
      if (!pane.body.includes(group)) fail('drawer-everywhere', `${pane.name} drawer lacks ${group}`);
    }
    for (const verb of ['drawer-zoom', 'drawer-close']) {
      if (!pane.body.includes(verb)) fail('drawer-everywhere', `${pane.name} drawer lacks ${verb}`);
    }
  }
};

LINT_CHECKS['bar-no-machinery'] = () => {
  for (const bar of bars_extract()) {
    if (/<button/.test(bar)) fail('bar-no-machinery', `a bar carries a <button>: ${bar.trim().slice(0, 60)}…`);
    if (/role="button"/.test(bar)) fail('bar-no-machinery', `a bar element carries role="button": ${bar.trim().slice(0, 60)}…`);
  }
};

LINT_CHECKS['caps-are-punctuation'] = () => {
  for (const m of html.matchAll(/<div class="(lcars-bar-end[^"]*)"([^>]*)>([^<]*)<\/div>/g)) {
    const [, cls, attrs, text] = m;
    if (!cls.includes('bar-punctuation')) fail('caps-are-punctuation', `end-cap without bar-punctuation: class="${cls}"`);
    if (text.trim() !== '') fail('caps-are-punctuation', `end-cap carries text "${text.trim()}"`);
    if (attrs.includes('role=')) fail('caps-are-punctuation', `end-cap carries a role: ${attrs.trim()}`);
  }
};

LINT_CHECKS['lid-is-mute'] = () => {
  const lid = html.match(/<div class="bar-panel" id="drawer-toggle"[^>]*>([\s\S]*?)<\/div>\n\s*<main>/);
  if (!lid) { fail('lid-is-mute', 'lid bar-panel not found'); return; }
  for (const seg of lid[1].matchAll(/<div class="(bar-\d+)"[^>]*>([^<]*)<\/div>/g)) {
    if (seg[2].trim() !== '') fail('lid-is-mute', `${seg[1]} carries text "${seg[2].trim()}"`);
  }
};

LINT_CHECKS['single-animation-author'] = () => {
  // A class is animation-bearing only when the animation is declared on a
  // selector whose SUBJECT (last compound) carries that class. A state
  // class an ancestor selector reacts to (e.g. .drawer-closed gating a
  // descendant's beckon) is the correct single-author pattern: CSS decides
  // what animates under the state.
  const animated = new Set();
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selectors, block] = m;
    if (!/animation:\s*(?!none)[a-z]/.test(block)) continue;
    for (const selector of selectors.split(',')) {
      const subject = selector.trim().split(/[\s>+~]+/).pop() ?? '';
      for (const cls of subject.matchAll(/\.([a-z-]+)/g)) animated.add(cls[1]);
    }
  }
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/classList\.(?:add|toggle)\(\s*'([^']+)'/g)) {
      if (animated.has(m[1])) {
        fail('single-animation-author', `${path} stamps animation-bearing class '${m[1]}'`);
      }
    }
  }
};

LINT_CHECKS['ordinals-mark-channels'] = () => {
  const gutter = html.match(/<div class="left-frame">([\s\S]*?)<\/div>\n\s*<div class="right-frame">/);
  if (!gutter) { fail('ordinals-mark-channels', 'left-frame gutter not found'); return; }
  const buttons = [...gutter[1].matchAll(/<button class="([^"]*)"[^>]*>([A-Z]+)(?:<span class="hop">([^<]*)<\/span>)?<\/button>/g)];
  if (buttons.length === 0) { fail('ordinals-mark-channels', 'no gutter buttons parsed'); return; }
  let expected = 1;
  for (const [, cls, label, hop] of buttons) {
    const isMeta = cls.includes('panel-lang');
    if (isMeta) {
      if (hop !== undefined) fail('ordinals-mark-channels', `meta given ${label} carries an ordinal '${hop}'`);
      continue;
    }
    const m = (hop ?? '').match(/^-(\d\d)$/);
    if (!m) { fail('ordinals-mark-channels', `channel ${label} lacks a -0N ordinal`); continue; }
    if (Number(m[1]) !== expected) {
      fail('ordinals-mark-channels', `channel ${label} is -${m[1]}, expected -${String(expected).padStart(2, '0')} (sequential down the column)`);
    }
    expected += 1;
  }
};

LINT_CHECKS['field-is-content'] = () => {
  // A pane's field carries content only. Display modes live on the mode
  // frame (a strip at rest); nothing floats over the field.
  const frames = [...html.matchAll(/<aside class="mode-frame">[\s\S]*?<\/aside>/g)].map((m) => m[0]).join('\n');
  const pills = [...html.matchAll(/<button class="strategy-pill[^"]*"/g)].length;
  const framed = [...frames.matchAll(/<button class="strategy-pill[^"]*"/g)].length;
  if (pills !== framed) fail('field-is-content', `${pills - framed} mode pill(s) live outside a mode frame`);
  for (const pane of panes_extract()) {
    if (pane.name !== 'tpl-pane-dag' && pane.name !== 'tpl-pane-files') continue;
    if (!pane.body.includes('class="mode-strip"')) fail('field-is-content', `${pane.name} has modes but no mode strip`);
    const field = pane.body
      .replace(/<div class="pane-drawer"[\s\S]*?<\/div>/, '')
      .replace(/<aside class="mode-frame">[\s\S]*?<\/aside>/g, '')
      .replace(/<button class="mode-strip"[^>]*><\/button>/g, '');
    for (const m of field.matchAll(/<button[^>]*>/g)) {
      fail('field-is-content', `${pane.name} field carries a control: ${m[0].slice(0, 60)}`);
    }
  }
  // A repealed law's enforcement must be deleted with it: the floating rail
  // (2026-08-31) was repealed 2026-09-03, and its CSS must not survive to
  // enforce the repeal's opposite.
  if (/\.(dag|files)-rail\b/.test(css)) fail('field-is-content', 'a floating-rail rule survives in argus.css');
  if (/\b(dag|files)-rail\b/.test(html)) fail('field-is-content', 'a floating-rail element survives in index.html');
};

LINT_CHECKS['hover-never-glares'] = () => {
  // A hover brightens a control in its own hue; it never flips it to the
  // palette's near-white (butter), which reads as a glare on the frame.
  for (const m of css.matchAll(/([^{}]+):hover[^{]*\{([^}]*)\}/g)) {
    if (/--butter/.test(m[2])) fail('hover-never-glares', `hover rule on '${m[1].trim().split(/\s*,\s*/).pop()}' uses --butter`);
  }
};

LINT_CHECKS['roster-grid-single-source'] = () => {
  // Caps and rows read one declaration: any roster grid that spells its own
  // template has drifted from the caps (or will).
  // The façade's row grid, the caps, and the PACS grids that S4 will fold in.
  for (const selector of ['.roster-caps', '.listing-row', '#pacs-form']) {
    const m = css.match(new RegExp(`\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`));
    if (!m) { fail('roster-grid-single-source', `${selector} rule not found`); continue; }
    if (!/grid-template-columns:\s*var\(--roster-cols\)/.test(m[1])) fail('roster-grid-single-source', `${selector} does not read --roster-cols`);
  }
  for (const m of css.matchAll(/grid-template-columns:\s*([^;]+);/g)) {
    if (/\d(em|px|fr)\b/.test(m[1]) && /1fr/.test(m[1]) && /em/.test(m[1]) && !/var\(--roster-cols\)/.test(m[1])) {
      // a hand-spelled roster-shaped template outside the single source
      const before = css.slice(0, m.index);
      const host = before.slice(before.lastIndexOf('\n\n')).trim().split('\n')[0];
      if (/--roster-cols:/.test(m[0])) continue;
      if (/roster-cols/.test(before.slice(-200))) continue;
      if (/(listing-row|files-grid|feedlist-row|roster-caps)/.test(host)) fail('roster-grid-single-source', `${host} spells its own roster template`);
    }
  }
};

LINT_CHECKS['surface-never-shadows-the-session'] = () => {
  // The language runs client-side BEFORE a line reaches the session, so a
  // subject that is also a kernel command silently swallows it. A shared
  // subject must claim only the verbs the session does not have, and say so
  // in SHARED_SUBJECTS; every other subject must collide with nothing.
  const lang = sources.find((s) => s.path.endsWith('argusLang.ts'));
  if (lang === undefined) { fail('surface-never-shadows-the-session', 'argusLang.ts not read'); return; }
  const subjects = lang.text.match(/const SUBJECTS: (?:Readonly)?Set<string> = new Set\(\[([\s\S]*?)\]\)/);
  if (subjects === null) { fail('surface-never-shadows-the-session', 'SUBJECTS set not found'); return; }
  const names = [...subjects[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const shared = lang.text.match(/const SHARED_SUBJECTS[\s\S]*?\n\};/);
  const sharedNames = shared === null ? [] : [...shared[0].matchAll(/^  ([a-z]+):/gm)].map((m) => m[1]);
  // A composition's subjects (compositions/<backend>/lang.ts): `name: null`
  // is its own; a set claims only those verbs of a subject the session owns.
  const extensions = readdirSync('apps/argus/src/compositions', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/argus/src/compositions/${entry.name}/lang.ts`)
    .filter((path) => existsSync(path))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  if (extensions.length === 0) { fail('surface-never-shadows-the-session', 'no composition language read'); return; }
  for (const extension of extensions) {
    const block = extension.text.match(/subjects: \{([\s\S]*?)\n    \},/);
    if (block === null) { fail('surface-never-shadows-the-session', `${extension.path}: subjects not found`); return; }
    for (const m of block[1].matchAll(/([a-z]+): (null|new Set|IMAGE_SURFACE_VERBS|[A-Z_]+)/g)) {
      names.push(m[1]);
      if (m[2] !== 'null') sharedNames.push(m[1]);
    }
  }
  // The session's own vocabulary, from the command groups that declare it.
  const commands = new Set();
  for (const group of ['packages/brasa/src/core/coreCommands.ts', 'packages/brasa/src/chris/chrisCommands.ts']) {
    const text = readFileSync(group, 'utf8');
    const start = text.indexOf('const envelope: Record<string, EnvelopeHandler> = {');
    if (start < 0) { fail('surface-never-shadows-the-session', `${group}: envelope table not found`); return; }
    const block = text.slice(start);
    for (const m of block.slice(0, block.indexOf('\n};')).matchAll(/^\s{2}'?([a-z][\w-]*)'?:/gm)) commands.add(m[1]);
  }
  if (commands.size < 100) { fail('surface-never-shadows-the-session', `session vocabulary read only ${commands.size} names`); return; }
  for (const name of names) {
    if (!commands.has(name)) continue;
    if (!sharedNames.includes(name)) {
      fail('surface-never-shadows-the-session', `subject '${name}' shadows the session command of the same name and is not declared shared`);
    }
  }
};

LINT_CHECKS['a-preview-is-the-same-drawing'] = () => {
  // A card and the stage draw the same graph, so they read one placement.
  // They did not always: the card spread each tier evenly while the scene
  // hung a tree of leaf slots, and nobody chose that — the two were written
  // separately and could not help but differ.
  // The placement lives in orrery's layout layer; the scene reads it in
  // scene units (ranked_layout), a card in layout units (rankedLayout_compute),
  // and both come from the one module.
  const layout = 'packages/orrery/src/layout/ranked.ts';
  if (!existsSync(layout)) {
    fail('a-preview-is-the-same-drawing', 'the shared ranked layout is gone');
    return;
  }
  // The stage is orrery's own scene, which reads its layout layer from
  // inside the package; a card reads it through the package's entry.
  const drawers = [
    ['packages/orrery/src/scene/settle.ts', /from '\.\.\/layout\/index\.js'/],
    ['apps/argus/src/features/files/panel.ts', /from '@fnndsc\/orrery(\/layout)?'/],
  ];
  for (const [path, reads] of drawers) {
    const text = readFileSync(path, 'utf8');
    if (!/\b(rankedLayout_compute|ranked_layout)\(/.test(text) || !reads.test(text)) {
      fail('a-preview-is-the-same-drawing', `${path} draws a ranked graph without reading the shared layout`);
    }
    // The tell of a second layout: computing depth or tiers locally.
    if (/const\s+(depths|tiers)\s*:\s*Map</.test(text)) {
      fail('a-preview-is-the-same-drawing', `${path} computes its own tiers`);
    }
  }
};

LINT_CHECKS['listing-is-one-abstraction'] = () => {
  // The listing is the Listing façade in features/roster: a pane DECLARES
  // its listing and never builds one. Reaching past the façade to the parts
  // — the order, the host, the row and capsule builders — is the violation,
  // because that is how three panes came to spell the same table three
  // ways, and then the same action track, indication and readout twice.
  //
  // No allowances: every pane declares. The PACS pane's, which expired
  // with S4, was the last.
  const ALLOWED_UNTIL_S4 = new Set([]);
  const REACHING = [
    [/new RosterOrder</, 'builds a RosterOrder itself'],
    [/new ListingHost</, 'builds a ListingHost itself'],
    [/\blistingRow_build\(/, 'builds rows itself (listingRow_build)'],
    [/\bactionCell_build\(/, 'builds action capsules itself (actionCell_build)'],
    [/\btraitColumns_of\(|\btraitValue_of\(/, 'derives caps or comparators itself (traitColumns_map / traitValue_make)'],
    [/from '\.\.\/roster\/(order|host)\.js'/, 'imports the order or the host, which only the façade may'],
  ];
  for (const { path, text } of features) {
    if (path.startsWith('apps/argus/src/features/roster/')) continue;
    if (/'roster-caps?'/.test(text)) fail('listing-is-one-abstraction', `${path} builds its own column caps`);
    if (/'roster-filter/.test(text)) fail('listing-is-one-abstraction', `${path} builds its own filter strip`);
    const reaches = REACHING.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
    if (reaches.length === 0) continue;
    if (ALLOWED_UNTIL_S4.has(path)) {
      console.log(`aegis-lint: debt — ${path} still reaches past the Listing façade (${reaches.join('; ')}); allowed until S4 converts it`);
      continue;
    }
    for (const what of reaches) fail('listing-is-one-abstraction', `${path} reaches past the Listing façade: ${what}`);
  }
  // The stylesheet reaches past it too when it spells a track list by
  // hand: `--roster-cols` is the façade's to write, computed from the
  // traits. No selector may declare one.
  const ALLOWED_TRACK_HOSTS_UNTIL_S4 = [];
  for (const m of css.matchAll(/--roster-cols:/g)) {
    const before = css.slice(0, m.index);
    const host = before.slice(before.lastIndexOf('\n\n')).trim().split('\n')[0].replace(/\s*\{.*$/, '').trim();
    if (host.startsWith('*') || host.startsWith('/*')) continue; // a comment mentioning the property
    if (ALLOWED_TRACK_HOSTS_UNTIL_S4.some((allowed) => host === allowed)) continue;
    fail('listing-is-one-abstraction', `${host} declares --roster-cols by hand; the façade computes it from the traits`);
  }
};

LINT_CHECKS['a-component-lands-with-its-reference'] = () => {
  // The reference beneath the doctrine: one section per component a pane
  // declares into. Every section names a source that exists, and every
  // source that IS a component has a section — so a component cannot land
  // without its reference, and a reference cannot outlive its component.
  const COMPONENT_SOURCES = [
    'apps/argus/src/features/roster/listing.ts',
    'apps/argus/src/features/image/panel.ts',
    'apps/argus/src/features/universe/panel.ts',
    'apps/argus/src/features/edit/panel.ts',
    'apps/argus/src/features/games/panel.ts',
    'apps/argus/src/features/notes/panel.ts',
    'apps/argus/src/app/restart.ts',
    'apps/argus/src/features/feed/view.ts',
  ];
  if (!existsSync('apps/argus/docs/components.adoc')) {
    fail('a-component-lands-with-its-reference', 'apps/argus/docs/components.adoc is missing');
    return;
  }
  const reference = readFileSync('apps/argus/docs/components.adoc', 'utf8');
  const sections = [...reference.matchAll(/^== (.+)$\n([\s\S]*?)(?=^== |(?![\s\S]))/gm)]
    .map(([, title, body]) => ({ title: title.trim(), body }))
    .filter(({ title }) => title !== 'Abstract' && title !== 'Reading a section');
  if (sections.length === 0) fail('a-component-lands-with-its-reference', 'components.adoc has no component sections');
  const named = new Set();
  for (const { title, body } of sections) {
    const source = body.match(/^Source: `([^`]+)`/m);
    if (!source) { fail('a-component-lands-with-its-reference', `section '${title}' names no Source`); continue; }
    if (!existsSync(source[1])) fail('a-component-lands-with-its-reference', `section '${title}' names a source that does not exist: ${source[1]}`);
    named.add(source[1]);
    for (const part of ['=== Purpose', '=== Anatomy', '=== Declaration', '=== States', '=== Laws', '=== Stylesheet', '=== Do not']) {
      if (!body.includes(part)) fail('a-component-lands-with-its-reference', `section '${title}' lacks '${part}'`);
    }
    // The anatomy is drawn, not only described: a picture a reader can
    // point at, checked into the tree beside the words.
    const anatomy = body.match(/^=== Anatomy$\n([\s\S]*?)(?=^=== )/m);
    const image = anatomy?.[1].match(/^image::([^\[]+)\[/m);
    if (!image) fail('a-component-lands-with-its-reference', `section '${title}' has no anatomy drawing (image:: under === Anatomy)`);
    else if (!existsSync(`apps/argus/docs/${image[1]}`)) fail('a-component-lands-with-its-reference', `section '${title}' names a drawing that does not exist: ${image[1]}`);
  }
  for (const source of COMPONENT_SOURCES) {
    if (!existsSync(source)) fail('a-component-lands-with-its-reference', `component source missing: ${source}`);
    if (!named.has(source)) fail('a-component-lands-with-its-reference', `${source} is a component with no section in components.adoc`);
  }
};

LINT_CHECKS['a-component-names-no-theme'] = () => {
  // A component and its reference speak the component's own vocabulary —
  // caps, strip, frame, field, track, expanse, level, group — and name no
  // theme. Colour reaches them as tokens, never as LCARS by name, so
  // another theme can sit on the same declaration without a rename. AEGIS
  // is where the theme is named, as the origin of the grammar; the parts
  // beneath it describe a listing, not a look.
  const THEME = /lcars/i;
  const componentSources = readdirSync('apps/argus/src/features/roster', { recursive: true })
    .filter((name) => String(name).endsWith('.ts'))
    .map((name) => `apps/argus/src/features/roster/${String(name).replaceAll('\\', '/')}`);
  for (const path of [...componentSources, 'apps/argus/docs/components.adoc']) {
    const text = readFileSync(path, 'utf8');
    const line = text.split('\n').findIndex((l) => THEME.test(l));
    if (line >= 0) fail('a-component-names-no-theme', `${path}:${line + 1} names the theme; a component speaks its own vocabulary`);
  }
};

LINT_CHECKS['an-instruments-field-is-foreign'] = () => {
  // An image pane's field is a guest engine's and the frame is mise's:
  // every control the pane offers rides the mode frame, and nothing sits
  // over the image. The template is the declaration: its field section
  // carries no button, input or block.
  const template = html.match(/<template id="tpl-pane-image">([\s\S]*?)<\/template>/);
  if (!template) { fail('an-instruments-field-is-foreign', 'index.html has no tpl-pane-image template'); return; }
  const field = template[1].match(/<section class="image-field"[^>]*>([\s\S]*?)<\/section>/);
  if (!field) { fail('an-instruments-field-is-foreign', 'tpl-pane-image has no .image-field section'); return; }
  if (/<(button|input|select|textarea)\b|strategy-pill|pacs-capsule/.test(field[1])) {
    fail('an-instruments-field-is-foreign', 'a control sits inside .image-field; what acts on the field rides the frame');
  }
  if (!/class="mode-frame"[\s\S]*?image-tool/.test(template[1])) {
    fail('an-instruments-field-is-foreign', 'the image pane\'s tool blocks are not on its mode frame');
  }
};

LINT_CHECKS['an-editors-save-is-a-line'] = () => {
  // The EDIT pane's field is CodeMirror's and the frame is mise's, as an
  // image pane's is; and a save is the line the operator could have typed,
  // echoed and run through the kernel. The template declares the first; the
  // pane's sources, which reach no byte route and save through the one line
  // composer, hold the second.
  const law = 'an-editors-save-is-a-line';
  const template = html.match(/<template id="tpl-pane-edit">([\s\S]*?)<\/template>/);
  if (!template) { fail(law, 'index.html has no tpl-pane-edit template'); return; }
  const field = template[1].match(/<section class="edit-field"[^>]*>([\s\S]*?)<\/section>/);
  if (!field) { fail(law, 'tpl-pane-edit has no .edit-field section'); return; }
  if (/<(button|input|select|textarea)\b|strategy-pill|pacs-capsule/.test(field[1])) {
    fail(law, 'a control sits inside .edit-field; what acts on the field rides the frame');
  }
  if (!/class="mode-frame"[\s\S]*?edit-save[\s\S]*?edit-revert/.test(template[1])) {
    fail(law, "the edit pane's SAVE and REVERT are not on its mode frame");
  }
  const sources = ['apps/argus/src/app/editor.ts', ...readdirSync('apps/argus/src/features/edit').map((name) => `apps/argus/src/features/edit/${name}`)];
  for (const path of sources) {
    if (/\bfetch\(|XMLHttpRequest|vfsUrl_build|method: 'POST'/.test(readFileSync(path, 'utf8'))) {
      fail(law, `${path} reaches a byte route; an editor writes only by the touch line`);
    }
  }
  const host = readFileSync('apps/argus/src/app/editor.ts', 'utf8');
  if (!/lineVisible_run\(context, saveLine_compose\(path, text\)\)/.test(host)) {
    fail(law, 'app/editor.ts does not save by running the line saveLine_compose made, visibly');
  }
  const lines = readFileSync('apps/argus/src/app/lines.ts', 'utf8');
  if (!/terminal\.line_echo\(line\)/.test(lines) || /line_execute\(line, \{ silent: true/.test(lines)) {
    fail(law, 'app/lines.ts does not echo the line and run it as a typed line runs');
  }
};

LINT_CHECKS['a-holder-is-a-mark-and-a-line'] = () => {
  // A feed's access changes only by visible setfacl lines and the title file,
  // and a holder is never withdrawn without the question first.
  const law = 'a-holder-is-a-mark-and-a-line';
  const access = readFileSync('apps/argus/src/app/access.ts', 'utf8');
  if (!/kind: 'confirm', message: `Stop sharing/.test(access)) fail(law, 'app/access.ts withdraws a holder without asking first');
  if (!/lineVisible_run\(context, holderLine_format\(/.test(access) || !/lineVisible_run\(context, `setfacl -m \$\{shareEntry_derive/.test(access)) {
    fail(law, 'app/access.ts changes access some other way than a visible setfacl line');
  }
  if (/line_execute\([^)]*setfacl|fetch\(/.test(access)) fail(law, 'app/access.ts runs setfacl quietly or reaches a byte route');
};

LINT_CHECKS['a-tag-is-a-mark-and-a-line'] = () => {
  // A feed's tags change only by the lines an operator could type, run
  // visibly; the marks are one theme hue; a note is never read for a listing.
  const law = 'a-tag-is-a-mark-and-a-line';
  const tags = readFileSync('apps/argus/src/app/tags.ts', 'utf8');
  if (!/lineVisible_run\(context, line\)/.test(tags) || !/lineVisible_run\(context, `setfattr -x tag/.test(tags)) {
    fail(law, 'app/tags.ts does not change a tag by a visible setfattr line');
  }
  if (/line_execute\([^)]*setfattr|line_execute\([^)]*mkdir|fetch\(/.test(tags)) {
    fail(law, 'app/tags.ts changes a tag some other way than a visible line');
  }
  const css = readFileSync('apps/argus/src/lcars/argus.css', 'utf8');
  const mark = css.match(/\.feedlist-tag \{([^}]*)\}/);
  if (!mark || !/--tag-hue: var\(--[a-z-]+\)/.test(mark[1])) fail(law, '.feedlist-tag does not wear one theme token as its hue');
  const roster = readFileSync('apps/argus/src/features/dag/roster.ts', 'utf8') + readFileSync('apps/argus/src/app/feedRows.ts', 'utf8');
  if (/feed_verbs[\s\S]{0,400}\/note`, \{ silent/.test(roster)) fail(law, 'a roster row reads a note; a note is read only when its feed is entered');
};

LINT_CHECKS['a-fact-has-one-source'] = () => {
  // Four facts the surface spelled in many places now have one source each,
  // and every other file is held to it: the sides (app/sides.ts), the bar's
  // states (features/roster/bar.ts), the primaries and the pane kinds
  // (app/panes.ts). A re-spelling fails here, not in review.
  const argusFiles = readdirSync('apps/argus/src', { recursive: true })
    .map((name) => `apps/argus/src/${String(name).replaceAll('\\', '/')}`)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  const rules = [
    { source: 'apps/argus/src/app/sides.ts', what: 'a side', pattern: /'(leftmost|rightmost|topmost|bottommost)'|\[data-split="|=== 'before' \?|\? 'before' : 'after'|ArrowLeft: 'left'|ArrowUp: 'up'/ },
    { source: 'apps/argus/src/features/roster/bar.ts', what: "the bar's state", pattern: /classList\.(add|remove|toggle|contains)\(\s*['`]state-|'state-(live|settled|stale|wait|note|refused)'/ },
    { source: 'apps/argus/src/app/panes.ts', what: 'the primaries', pattern: /\b(id|instance\.id|paneId) === '(files|dag|pacs)' \|\| [^\n]*=== '(files|dag|pacs)'|\['files', 'dag', 'pacs'\]|\['pacs', 'files', 'dag'\]/ },
  ];
  for (const path of argusFiles) {
    const text = readFileSync(path, 'utf8');
    for (const rule of rules) {
      if (path === rule.source) continue;
      const m = text.match(rule.pattern);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        fail('a-fact-has-one-source', `${path}:${line} spells ${rule.what} itself (${m[0].slice(0, 40)}); read ${rule.source}`);
      }
    }
  }
  // The PACS levels and the query form share their leading tracks (the
  // fold, PATIENT, MRN): each level reads them from PACS_LEAD_TRACKS, and
  // the form has a cell for every track before them, the listing's control
  // column included (#825: the form fell a column off its caps when the
  // facade minted a control track the form had no cell for).
  {
    const pacs = readFileSync('apps/argus/src/features/pacs/panel.ts', 'utf8');
    for (const key of ['fold', 'patient', 'mrn']) {
      const pattern = new RegExp(`key: '${key}',[\\s\\S]*?width: ([^,\\n]+),`, 'g');
      for (const match of pacs.matchAll(pattern)) {
        if (match[1].trim() !== `PACS_LEAD_TRACKS.${key}`) fail('a-fact-has-one-source', `apps/argus/src/features/pacs/panel.ts: the '${key}' trait spells its own width (${match[1].trim()}); read PACS_LEAD_TRACKS.${key}`);
      }
    }
    const html = readFileSync('apps/argus/index.html', 'utf8');
    const form = html.slice(html.indexOf('id="pacs-form"'), html.indexOf('</div>', html.indexOf('id="pacs-form"')));
    const keys = [...form.matchAll(/data-key="([a-z]+)"/g)].map((m) => m[1]);
    if (keys[0] !== 'control' || keys[1] !== 'fold' || keys[2] !== 'patient' || keys[3] !== 'mrn') {
      fail('a-fact-has-one-source', `apps/argus/index.html: the PACS form's leading cells are ${keys.slice(0, 4).join(', ')}; they must be control, fold, patient, mrn — one cell per leading track of the levels`);
    }
  }
};

/**
 * Every function and method a file declares, with where it opens and
 * closes: a declaration (`name(...) {`, `function name(...) {`) or an arrow
 * bound to a name (`const name = (...) => {`). Braces are counted with
 * strings, template literals and comments blanked.
 */
function functions_of(text) {
  const blank = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => ' '.repeat(m.length));
  const lines = blank.split('\n');
  const decl = /^\s*(?:export\s+)?(?:(?:public|private|protected|static|async|readonly|get|set|override)\s+)*(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*\{\s*$/;
  const arrow = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^=]+)?=>\s*\{\s*$/;
  const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try']);
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = decl.exec(lines[i]) ?? arrow.exec(lines[i]);
    if (match === null || skip.has(match[1])) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
      if (depth === 0) { found.push({ name: match[1], from: i + 1, to: j + 1 }); break; }
    }
  }
  return found;
}

LINT_CHECKS['a-part-stays-a-part'] = () => {
  // A function runs at most 150 lines: about what one tall screen shows
  // whole (#814). A module factory (`*_wire`, `*_build`) is a module
  // boundary: it is measured by the named functions inside it, each under
  // the ceiling, not as one function. A function that still stands past the
  // ceiling is named below with its reason and the length it stood at when
  // the ceiling arrived: it may shrink, never grow, and a new one fails.
  // A file past 1,200 lines is named as a warning, never a failure: a long
  // file is a hint to look for a part, and squeezing lines to meet a count
  // improves nothing.
  const FUNCTION_LINES = 150;
  const FILE_LINES = 1200;
  const allowed = new Map([
    ['apps/argus/src/app/main.ts#surface_start', [1931, 'the host closure itself; it shrinks as the file does']],
    ['apps/argus/src/console/argusLang.ts#argusLine_run', [266, 'the language dispatcher: one branch per subject; a verb table is the next cut']],
    ['apps/argus/src/features/image/slabScene.ts#slabScene_open', [155, 'the slab scene setup: one WebGL program; split when it next changes']],
  ]);
  const files = readdirSync('apps/argus/src', { recursive: true })
    .map((name) => `apps/argus/src/${String(name).replaceAll('\\', '/')}`)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const lineCount = text.split('\n').length;
    if (lineCount > FILE_LINES) console.warn(`aegis-lint: warning: ${path} runs ${lineCount} lines (past ${FILE_LINES}): look for a part to take out`);
    for (const fn of functions_of(text)) {
      if (/_(wire|build)$/.test(fn.name)) continue;
      const key = `${path}#${fn.name}`;
      const length = fn.to - fn.from + 1;
      if (length <= FUNCTION_LINES) continue;
      const allow = allowed.get(key);
      if (allow === undefined) fail('a-part-stays-a-part', `${key} function runs ${length} lines; the ceiling is ${FUNCTION_LINES}: split it into steps`);
      else if (length > allow[0]) fail('a-part-stays-a-part', `${key} function grew to ${length} lines past its allowance of ${allow[0]} (${allow[1]})`);
    }
  }
};

LINT_CHECKS['keys-are-documented'] = () => {
  // The keys reference is generated from DRAWER_CHORDS; the written file
  // and the table may never disagree (scripts/keys-doc.mjs --check).
  try {
    execFileSync('node', ['scripts/keys-doc.mjs', '--check'], { stdio: 'pipe' });
  } catch (error) {
    fail('keys-are-documented', String(error.stderr ?? error.message).trim().split('\n')[0]);
  }
};

LINT_CHECKS['a-field-says-it-holds-more'] = () => {
  // Every scrolling field wears the chip: each `overflow: auto|scroll` rule
  // in the stylesheet names a class in MORE_FIELDS (features/roster/more.ts),
  // and each name there is wired by a `more_wire` call in a source that
  // names the field. The console's scrollback keeps its own idiom by name.
  const more = features.find((f) => f.path.endsWith('/roster/more.ts'));
  if (!more) { fail('a-field-says-it-holds-more', 'features/roster/more.ts not read'); return; }
  const list = (name) => {
    const m = more.text.match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]) : null;
  };
  const fields = list('MORE_FIELDS');
  const scrollback = list('SCROLLBACK_FIELDS') ?? [];
  if (!fields) { fail('a-field-says-it-holds-more', 'MORE_FIELDS not found in more.ts'); return; }
  const allowed = new Set([...fields, ...scrollback]);
  const sheet = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/overflow(?:-y)?\s*:\s*(?:auto|scroll)\b/.test(rule[2])) continue;
    for (const selector of rule[1].split(',')) {
      // The field is the last class the selector names, or its id when it names none.
      const classes = [...selector.matchAll(/[.#]([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
      const field = classes.at(-1);
      if (field === undefined) { fail('a-field-says-it-holds-more', `a scrolling rule names no class or id: ${selector.trim()}`); continue; }
      if (!allowed.has(field)) fail('a-field-says-it-holds-more', `'.${field}' scrolls but is not in MORE_FIELDS (wire more_wire, or make the mount overflow: hidden): ${selector.trim()}`);
    }
  }
  for (const field of fields) {
    const wired = [...features, ...sources].some((f) => f.text.includes('more_wire(') && f.text.includes(field));
    if (!wired) fail('a-field-says-it-holds-more', `MORE_FIELDS names '${field}' but no source wires it (a file with more_wire( that names '${field}')`);
  }
};

LINT_CHECKS['a-program-gives-the-screen-back'] = () => {
  // A program that takes the screen (trek's bridge) hides the page behind
  // it with one body attribute and gives it back however the game ends:
  // the host sets `data-takeover` when it opens, removes it in a `finally`
  // around the command, and the stylesheet hides everything but the
  // bridge under that attribute, so no other path can leave ARGUS hidden.
  const host = readFileSync('apps/argus/src/app/trekBridge.ts', 'utf8');
  const css = readFileSync('apps/argus/src/features/trek/trek.css', 'utf8');
  if (!/document\.body\.dataset\['takeover'\] = 'trek'/.test(host)) fail('a-program-gives-the-screen-back', 'trekBridge.ts does not set body[data-takeover] when the bridge opens');
  if (!/delete document\.body\.dataset\['takeover'\]/.test(host)) fail('a-program-gives-the-screen-back', 'trekBridge.ts does not remove body[data-takeover] when the bridge closes');
  if (!/finally \{\s*if \(bridge === opened\) close\(\);/.test(host)) fail('a-program-gives-the-screen-back', 'trekBridge.ts does not close the bridge in a finally around the command: a thrown run would leave the page hidden');
  if (!/body\[data-takeover='trek'\] > \*:not\(#trek-bridge\) \{ visibility: hidden; \}/.test(css)) fail('a-program-gives-the-screen-back', "trek.css does not hide the page behind the bridge under body[data-takeover='trek']");
  const takeovers = [...readFileSync('apps/argus/src/app/main.ts', 'utf8').matchAll(/dataset\['takeover'\]/g)].length;
  if (takeovers > 0) fail('a-program-gives-the-screen-back', `main.ts touches body[data-takeover] (${takeovers}): the bridge module owns it`);
};

LINT_CHECKS['a-mark-means-one-thing-everywhere'] = () => {
  // One symbol table (features/trek/marks.ts) draws every mark the bridge
  // shows: the scan, the wheels' rims, the target pills and the legend all
  // take a kind's symbol from it, never a glyph or a drawing of their own.
  const marks = readFileSync('apps/argus/src/features/trek/marks.ts', 'utf8');
  const names = [...marks.matchAll(/^\s+'([a-z-]+)': '<[^\n]*$/gm)].map((m) => m[1]);
  for (const kind of ['ship', 'base', 'inhabited', 'star', 'hole', 'supernova', 'klingon-cruiser', 'klingon-raptor', 'klingon-talon', 'klingon-warbird']) {
    if (!names.includes(kind)) fail('a-mark-means-one-thing-everywhere', `marks.ts has no symbol '${kind}'`);
  }
  const trek = 'apps/argus/src/features/trek/';
  for (const file of ['bridge.ts', 'controls.ts', 'stations.ts']) {
    const text = readFileSync(trek + file, 'utf8');
    if (!/from '\.\/marks\.js'/.test(text)) fail('a-mark-means-one-thing-everywhere', `${file} draws no mark from marks.ts`);
    if (/['"`]#tm-/.test(text)) fail('a-mark-means-one-thing-everywhere', `${file} refers to a symbol by its id: ask marks.ts for it`);
    if (/SECTOR_GLYPHS|textContent = (?:glyph|cell\.glyph)/.test(text)) fail('a-mark-means-one-thing-everywhere', `${file} draws a sector as its glyph: the glyph belongs to titles, the legend and the log`);
  }
  const controls = readFileSync(trek + 'controls.ts', 'utf8');
  if (!/mark_use\(mark\.kind/.test(controls)) fail('a-mark-means-one-thing-everywhere', "controls.ts draws a wheel's rim marks as something other than the kind's symbol");
  const stations = readFileSync(trek + 'stations.ts', 'utf8');
  if (!/markIcon_make\('klingon', k\.mark\)/.test(stations)) fail('a-mark-means-one-thing-everywhere', "stations.ts leads a target pill with something other than the Klingon's own mark");
  const bridge = readFileSync(trek + 'bridge.ts', 'utf8');
  if (!/markIcon_make\(row\.kind, variant\)/.test(bridge)) fail('a-mark-means-one-thing-everywhere', "bridge.ts draws the legend from something other than the symbol table");
};

// -------------------------------------------------- the table enforces itself

// A change is a loop (aegis.adoc, a-change-is-a-loop): every control a takeover
// screen makes to send a line carries a `// loop: <id>` mark at the line that
// makes it or on one of the three lines above; every id is a row of the loop
// ledger and every row is marked somewhere; a held row names a smoke scenario
// that exists, an owed row the clauses it owes. A control made by hand (not
// through the line-sending makers) is found when it wears a billing or
// destroying pill or a commit's word; the rest are held to by review.
LINT_CHECKS['a-change-is-a-loop'] = () => {
  const law = 'a-change-is-a-loop';
  const ledger = aegis.match(/\[\[loop-ledger\]\][\s\S]*?\| Loop \| Screen \| Control \| Sends \| Changes \| Standing\n([\s\S]*?)\n\|===/);
  if (!ledger) { fail(law, 'no loop ledger ([[loop-ledger]]) in aegis.adoc'); return; }
  const rows = new Map();
  for (const line of ledger[1].split('\n').filter((each) => each.startsWith('| '))) {
    const m = line.match(/^\| ([a-z0-9-]+) \| .* \| (held|owes|reads)(.*)$/);
    if (!m) { fail(law, `ledger row unreadable: ${line.slice(0, 80)}`); continue; }
    const [, id, standing, rest] = m;
    if (rows.has(id)) fail(law, `ledger row '${id}' appears twice`);
    rows.set(id, standing);
    if (standing === 'owes' && !/^ [1-6](, [1-6])*: \S/.test(rest)) fail(law, `ledger row '${id}' owes without naming its clauses (owes 1, 5: why)`);
    if (standing === 'held') {
      const scenario = rest.match(/smoke:(.+)$/)?.[1]?.trim();
      if (scenario === undefined) fail(law, `ledger row '${id}' is held without naming its smoke scenario`);
      else if (!smoke.includes(scenario)) fail(law, `ledger row '${id}' names a smoke scenario not in smoke.mjs: "${scenario}"`);
    }
  }
  const screens = ['apps/argus/src/features/script/screen.ts', 'apps/argus/src/features/vm/screen.ts', 'apps/argus/src/features/controller/screen.ts'];
  const maker = /\b(?:linePill_make|runRow_make|declareRow_make)\(/;
  const definition = /^\s*(?:protected|private|public)\s+(?:async\s+)?(?:linePill_make|runRow_make|declareRow_make)\(/;
  const byHand = /el\('button',[^;]*(?:'(?:KILL|COMMIT|SAVE)'|tdc-pill-(?:bill|destroy))/;
  const marked = new Set();
  for (const path of screens) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const m of line.matchAll(/\/\/ loop: ([a-z0-9-]+(?:, [a-z0-9-]+)*)/g)) {
        for (const id of m[1].split(', ')) {
          marked.add(id);
          if (!rows.has(id)) fail(law, `${path}:${index + 1} marks loop '${id}', which has no row in the ledger`);
        }
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || definition.test(line)) return;
      if (!maker.test(line) && !byHand.test(line)) return;
      const near = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
      if (!/\/\/ loop: /.test(near)) fail(law, `${path}:${index + 1} makes a control that sends a line with no // loop: <id> mark: ${trimmed.slice(0, 90)}`);
    });
  }
  for (const id of rows.keys()) if (!marked.has(id)) fail(law, `ledger row '${id}' is marked by no control in the takeover screens`);
};

const lawsTable = aegis.match(/\| Law \| Statement \| Enforcement\n([\s\S]*?)\n\|===/);
if (!lawsTable) {
  fail('laws-table', 'no "The laws" table found in aegis.adoc');
} else {
  const rows = [...lawsTable[1].matchAll(/^\| ([a-z-]+) \| .*? \| (lint|smoke):(.+)$/gm)];
  if (rows.length === 0) fail('laws-table', 'laws table has no parseable rows');
  for (const [, law, kind, ref] of rows) {
    if (kind === 'lint') {
      if (!(ref.trim() in LINT_CHECKS)) fail('laws-table', `law '${law}' names missing lint check '${ref.trim()}'`);
    } else if (!smoke.includes(ref.trim())) {
      fail('laws-table', `law '${law}' names a smoke scenario not found in smoke.mjs: "${ref.trim()}"`);
    }
  }
}

// A merge that left its markers behind is not a design decision. The doc
// is prose in a table, so nothing else here trips on `<<<<<<<`: PR #666
// merged four marker lines through a green run.
LINT_CHECKS['doc-carries-no-markers'] = () => {
  const marker = /^(<<<<<<< |=======$|>>>>>>> |\|\|\|\|\|\|\| )/;
  for (const [path, text] of [
    ['apps/argus/docs/aegis.adoc', aegis],
    ['apps/argus/docs/components.adoc', readFileSync('apps/argus/docs/components.adoc', 'utf8')],
  ]) {
    text.split('\n').forEach((line, index) => {
      if (marker.test(line)) fail('doc-carries-no-markers', `${path}:${index + 1} is a merge conflict marker`);
    });
  }
};

for (const [name, run] of Object.entries(LINT_CHECKS)) {
  try { run(); } catch (error) { fail(name, `check crashed: ${error.message}`); }
}

if (failures.length > 0) {
  console.error(`aegis-lint: ${failures.length} violation(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`aegis-lint: all laws hold (${Object.keys(LINT_CHECKS).length} lint checks, table verified)`);
