/**
 * @file Coverage ratchet: a workspace's test coverage may only rise.
 *
 * Reads the summary jest writes when a workspace's tests are run with
 * coverage (`<workspace>/coverage/coverage-summary.json`, the `json-summary`
 * reporter) and compares its four totals (lines, statements, branches,
 * functions, each a percentage) with the workspace's committed floors, the
 * `coverage` section of `scripts/ratchet-baseline.json`.
 *
 * A total below its floor is a regression and fails. A total that has
 * risen a tenth of a point or more above its floor fails too, with the
 * instruction to raise the floor in the same change, so the ratchet clicks
 * up and a gain is kept. Floors are held to one decimal place, rounded
 * down: a measure of 68.86 has a floor of 68.8.
 *
 * A workspace whose measure differs from one machine to the next carries an
 * `allowance` beside its floors (`{ below, above }`, in points). Its floors
 * are then the reference its gate measured: a measure may be `below` it by
 * that much and pass, asks for a raise only once it is more than `above`
 * it, and is raised to the measure less `below`. An allowance may narrow
 * against the base, never widen.
 *
 * The floors themselves cannot fall: they are compared with the same
 * section as it stood at the change's base (`scripts/lib/ratchetBase.mjs`
 * says which commit that is), and one lower here than there fails. A
 * workspace the base did not name had no floor, and may be given any.
 *
 * A workspace named in the section whose summary is not there has not had
 * its tests run with coverage, which is not a pass; nor is a workspace the
 * caller requires (`--require <workspace>`) that the section does not name.
 *
 * On a fall, the files of the workspace in which no line is covered are
 * named: a file that has lost its only test is among them.
 *
 * Run after a workspace's whole test suite by `scripts/jest-with-floor.mjs`,
 * which names the summary that run wrote (`--summary <workspace>=<file>`):
 * the workspace is then judged from that file and no other.
 * `--root <dir>` and `--baseline <file>` name another tree and baseline
 * file, as the check's own test does. The floors are compared with the
 * base whenever the baseline read is the tree's own
 * `scripts/ratchet-baseline.json`, however the tree was named. `--raise` rewrites the floors to what
 * was measured, where that is higher: it writes nothing when anything could
 * not be read, when a measure is below its floor, or when a floor it would
 * write is below the base's.
 *
 * @module
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base_resolve, fileAtCommit_read } from './lib/ratchetBase.mjs';

/** The baseline file, from the repository's root. */
const BASELINE_FILE = 'scripts/ratchet-baseline.json';

/** The four totals jest's summary carries. */
export const MEASURES = ['lines', 'statements', 'branches', 'functions'];

/**
 * A measured percentage as a floor: one decimal place, rounded down.
 *
 * @param {number} pct - The percentage measured.
 * @returns {number} The floor it stands for.
 */
export function floor_derive(pct) {
  return Math.floor(pct * 10 + 1e-9) / 10;
}

/**
 * Reads the `coverage` section of a baseline file: a map from a workspace
 * to its four floors, each a number from 0 to 100. Anything else is
 * refused: a floor that is not a number compares as neither above nor
 * below, and would pass everything.
 *
 * @param {string} text - The baseline file's text.
 * @param {string} where - What the text is, for the words.
 * @returns {Record<string, Record<string, number>>} The floors, by workspace.
 * @throws {Error} When the text is not JSON, the section is missing or is not a map, or a floor is missing or is not a percentage.
 */
export function floors_read(text, where) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`${where} is not JSON: ${error.message}`); }
  const section = parsed?.coverage;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) throw new Error(`${where} has no "coverage" section`);
  for (const [workspace, floors] of Object.entries(section)) {
    if (floors === null || typeof floors !== 'object' || Array.isArray(floors)) throw new Error(`${where}: the coverage floors of ${workspace} are not a map`);
    for (const measure of MEASURES) {
      const floor = floors[measure];
      if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 100) throw new Error(`${where}: the ${measure} floor of ${workspace} is not a percentage (${JSON.stringify(floor)})`);
    }
    const allowance = floors.allowance;
    if (allowance === undefined) continue;
    if (allowance === null || typeof allowance !== 'object' || Array.isArray(allowance)) throw new Error(`${where}: the allowance of ${workspace} is not a map of "below" and "above"`);
    for (const side of ['below', 'above']) {
      const points = allowance[side];
      if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > 5) throw new Error(`${where}: the allowance ${side} of ${workspace} is not a number of points from 0 to 5 (${JSON.stringify(points)})`);
    }
    // A raise is to the measure less `below`, and is asked for past `above`: were `below` the larger, a
    // raise could write a floor no higher than the one it replaces, and be asked for again.
    if (allowance.below > allowance.above) throw new Error(`${where}: the allowance of ${workspace} allows more below (${allowance.below}) than above (${allowance.above}); a raise would then not raise`);
    // With an allowance the comparison is in tenths: the reference is written in tenths.
    for (const measure of MEASURES) {
      if (Math.abs(floors[measure] * 10 - Math.round(floors[measure] * 10)) > 1e-9) throw new Error(`${where}: the ${measure} floor of ${workspace} carries an allowance and must be written to one decimal (${floors[measure]})`);
    }
  }
  return section;
}

/**
 * Places one measurement against its floor. Everything is compared in whole
 * tenths of a point. A workspace whose measure moves with the machine it is
 * measured on carries an allowance: its floor is then the reference its
 * gate measured, a measurement may be so far `below` it and still pass, and
 * only one more than `above` it asks for a raise. The raise is to the
 * measurement less `below`, so the same measurement then passes, and one
 * taken on the slower machine does too. Without an allowance the floor is
 * exact: below it falls, a tenth above it rises.
 *
 * @param {number} floor - The stored floor (with an allowance: the reference).
 * @param {{ below: number, above: number } | undefined} allowance - The allowance, in points.
 * @param {number} pct - What was measured.
 * @returns {{ kind: 'fall', least: number } | { kind: 'pass' } | { kind: 'rise', to: number }} Where it falls; `least` is the least that passes, `to` the floor a raise writes.
 */
export function measure_place(floor, allowance, pct) {
  // No allowance: the floor as it is written, compared with the measure as it is. Nothing is rounded before
  // the comparison, so a floor written to hundredths holds to hundredths.
  if (allowance === undefined) {
    if (pct < floor) return { kind: 'fall', least: floor };
    return floor_derive(pct) > floor ? { kind: 'rise', to: floor_derive(pct) } : { kind: 'pass' };
  }
  const tenths = (points) => Math.round(points * 10);
  const reference = tenths(floor);
  const measured = tenths(floor_derive(pct));
  const below = tenths(allowance?.below ?? 0);
  const above = tenths(allowance?.above ?? 0);
  if (measured < reference - below) return { kind: 'fall', least: (reference - below) / 10 };
  if (measured > reference + above) return { kind: 'rise', to: (measured - below) / 10 };
  return { kind: 'pass' };
}

/**
 * Reads the four totals from jest's coverage summary.
 *
 * @param {string} text - The summary file's text.
 * @param {string} where - What the text is, for the words.
 * @returns {Record<string, number>} The four percentages.
 * @throws {Error} When the text is not a summary with four totals.
 */
export function summary_read(text, where) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`${where} is not JSON: ${error.message}`); }
  const totals = {};
  for (const measure of MEASURES) {
    const pct = parsed?.total?.[measure]?.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) throw new Error(`${where} has no ${measure} total`);
    if (pct < 0 || pct > 100) throw new Error(`${where}: the ${measure} total is not a percentage (${pct})`);
    totals[measure] = pct;
  }
  return totals;
}

/**
 * Judges one workspace's measured coverage against its floors.
 *
 * @param {string} workspace - The workspace.
 * @param {Record<string, number>} floors - Its floors.
 * @param {Record<string, number>} measured - What was measured.
 * @returns {{ falls: string[], rises: string[] }} A line per measure below its floor, and a line per rise that has not been kept.
 */
export function coverage_judge(workspace, floors, measured) {
  const falls = [];
  const rises = [];
  for (const measure of MEASURES) {
    const floor = floors[measure];
    const now = measured[measure];
    const placed = measure_place(floor, floors.allowance, now);
    const allowed = floors.allowance === undefined ? '' : ` (reference ${floor}%, less the ${floors.allowance.below} allowed for the machine)`;
    if (placed.kind === 'fall') falls.push(`${workspace}: ${measure} coverage is ${now}%, below its floor of ${placed.least}%${allowed}. A change may not lower coverage: test what it added.`);
    else if (placed.kind === 'rise') rises.push(`${workspace}: ${measure} coverage rose to ${now}% (floor ${floor}%) — good. Raise the floor to ${placed.to} in ${BASELINE_FILE} as part of this change (node scripts/coverage-ratchet.mjs --raise), so the gain is kept.`);
  }
  return { falls, rises };
}

/**
 * Names the files of a summary in which no line is covered.
 *
 * @param {string} text - The summary file's text.
 * @param {string} workspaceDir - The workspace's folder, to say each file from.
 * @returns {string[]} The files, from the workspace's folder, in order.
 */
export function uncovered_list(text, workspaceDir) {
  const parsed = JSON.parse(text);
  const files = [];
  for (const [file, totals] of Object.entries(parsed)) {
    if (file === 'total') continue;
    if (totals?.lines?.total > 0 && totals.lines.covered === 0) files.push(file.startsWith(`${workspaceDir}/`) ? file.slice(workspaceDir.length + 1) : file);
  }
  return files.sort();
}

/**
 * Compares the floors with the same section at the base.
 *
 * @param {Record<string, Record<string, number>>} here - The floors committed in this change.
 * @param {Record<string, Record<string, number>>} atBase - The same section at the base.
 * @returns {string[]} One line per floor that is lower here than at the base, or that the base had and this change dropped.
 */
export function floors_compare(here, atBase) {
  const faults = [];
  for (const [workspace, was] of Object.entries(atBase)) {
    const now = here[workspace];
    if (now === undefined) { faults.push(`${workspace}: its coverage floors were removed; a floor may only rise.`); continue; }
    for (const measure of MEASURES) {
      if (now[measure] < was[measure]) faults.push(`${workspace}: the ${measure} floor was lowered from ${was[measure]} to ${now[measure]}; a floor may only rise.`);
    }
    // The allowance is part of the floor: wider below lets less pass as enough, wider above puts off a
    // raise. None at the base is an allowance of nothing.
    for (const side of ['below', 'above']) {
      const before = was.allowance?.[side] ?? 0;
      const after = now.allowance?.[side] ?? 0;
      if (after > before) faults.push(`${workspace}: the allowance ${side} was widened from ${before} to ${after}; an allowance may only narrow.`);
    }
  }
  return faults;
}

/**
 * Reads the command line.
 *
 * @param {string[]} argv - The arguments after the script's name.
 * @returns {{ root: string | null, baseline: string | null, raise: boolean, required: string[], summaries: Record<string, string> }} What was asked.
 * @throws {Error} When an argument is not one of the check's own.
 */
export function args_read(argv) {
  const asked = { root: null, baseline: null, raise: false, required: [], summaries: {} };
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--raise') asked.raise = true;
    else if (arg === '--root' || arg === '--baseline' || arg === '--require' || arg === '--summary') {
      const value = argv[++at];
      if (value === undefined) throw new Error(`${arg} wants a value`);
      if (arg === '--root') asked.root = value;
      else if (arg === '--baseline') asked.baseline = value;
      else if (arg === '--require') asked.required.push(value);
      else {
        // `<workspace>=<file>`: this workspace is judged from this summary, and no other.
        const cut = value.indexOf('=');
        if (cut <= 0 || cut === value.length - 1) throw new Error(`--summary wants <workspace>=<file>, and was given ${JSON.stringify(value)}`);
        asked.summaries[value.slice(0, cut)] = value.slice(cut + 1);
      }
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}: the check takes --root, --baseline, --require, --summary and --raise`);
    }
  }
  return asked;
}

/**
 * Reads the floors as they stood at the change's base.
 *
 * @param {string} root - The repository.
 * @returns {Record<string, Record<string, number>> | null} The base's floors; null when the base's baseline file is from before this ratchet, or its tree has none.
 * @throws {Error} When the base cannot be resolved or its file cannot be read as floors.
 */
function baseFloors_read(root) {
  const base = base_resolve(process.env, root);
  const text = fileAtCommit_read(base.sha, BASELINE_FILE, root);
  if (text === null) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`${BASELINE_FILE} at ${base.how} is not JSON: ${error.message}`); }
  if (parsed?.coverage === undefined) return null;
  return floors_read(text, `${BASELINE_FILE} at ${base.how}`);
}

/** Runs the check; the exit status is whether it passed. */
function main() {
  let asked;
  try { asked = args_read(process.argv.slice(2)); } catch (error) { console.error(`coverage-ratchet: ${error.message}`); process.exit(2); }
  const root = resolve(asked.root ?? fileURLToPath(new URL('..', import.meta.url)));
  const baselinePath = resolve(asked.baseline ?? join(root, BASELINE_FILE));
  // The floors are held to the base wherever the file read is the tree's own committed baseline, however
  // the tree was named (by default, or by --root). A baseline file from somewhere else has no base.
  const committed = baselinePath === resolve(root, BASELINE_FILE);
  let floors;
  let baselineText;
  try {
    baselineText = readFileSync(baselinePath, 'utf8');
    floors = floors_read(baselineText, asked.baseline ?? BASELINE_FILE);
  } catch (error) {
    console.error(`coverage-ratchet: ${error.message}`);
    process.exit(1);
  }
  // What could not be read or is not there: nothing can be judged, or raised, past one of these.
  const errors = [];
  const falls = [];
  const rises = [];
  const measuredAll = {};
  for (const workspace of asked.required) {
    if (floors[workspace] === undefined) errors.push(`${workspace}: it has no coverage floors in ${BASELINE_FILE}, and its tests are held to them. Give it floors (measure, then --raise from floors of 0).`);
  }
  for (const [workspace, own] of Object.entries(floors)) {
    // The summary a run names for the workspace is the one judged: a run is held to what it wrote itself,
    // not to whatever stands in the workspace's shared folder by the time this reads it.
    const named = asked.summaries[workspace];
    const summaryPath = named !== undefined ? resolve(named) : join(root, workspace, 'coverage', 'coverage-summary.json');
    if (!existsSync(summaryPath)) {
      errors.push(named !== undefined ? `${workspace}: no coverage summary at ${named}.` : `${workspace}: no coverage summary at ${workspace}/coverage/coverage-summary.json. Run its tests with coverage first (npm test in ${workspace}).`);
      continue;
    }
    let text;
    try {
      text = readFileSync(summaryPath, 'utf8');
      measuredAll[workspace] = summary_read(text, `${workspace}/coverage/coverage-summary.json`);
    } catch (error) {
      errors.push(`${workspace}: ${error.message}`);
      continue;
    }
    const judged = coverage_judge(workspace, own, measuredAll[workspace]);
    rises.push(...judged.rises);
    if (judged.falls.length > 0) {
      falls.push(...judged.falls);
      const bare = uncovered_list(text, join(root, workspace));
      if (bare.length > 0) falls.push(`${workspace}: ${bare.length} file(s) in which no line is covered: ${bare.join(', ')}`);
    }
  }
  // The floors as they would stand: as committed, or (for --raise) raised to what was measured.
  const next = JSON.parse(baselineText);
  let raised = 0;
  if (asked.raise) {
    for (const [workspace, measured] of Object.entries(measuredAll)) {
      for (const measure of MEASURES) {
        // The same placing the check makes: only a measurement the check would call a rise raises a floor.
        const placed = measure_place(next.coverage[workspace][measure], next.coverage[workspace].allowance, measured[measure]);
        if (placed.kind === 'rise') { next.coverage[workspace][measure] = placed.to; raised++; }
      }
    }
  }
  // Against the base: the floors as they would stand (after a raise, for --raise) may not be below it.
  const lowered = [];
  if (committed) {
    try {
      const atBase = baseFloors_read(root);
      if (atBase !== null) lowered.push(...floors_compare(next.coverage, atBase));
    } catch (error) {
      errors.push(`the floors could not be compared with the base: ${error.message}`);
    }
  }
  if (asked.raise) {
    const stops = [...errors, ...falls, ...lowered];
    if (stops.length > 0) {
      for (const line of stops) console.error(`  ${line}`);
      console.error(`coverage-ratchet: nothing raised and ${BASELINE_FILE} not touched: the tree does not pass as it is.`);
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`coverage-ratchet: raised ${raised} floor(s) in ${BASELINE_FILE}; none lowered.`);
    return;
  }
  const faults = [...errors, ...falls, ...rises, ...lowered];
  if (faults.length > 0) {
    console.error(`coverage-ratchet: ${faults.length} fault(s):`);
    for (const line of faults) console.error(`  ${line}`);
    process.exit(1);
  }
  const said = Object.entries(measuredAll).map(([workspace, measured]) => `${workspace} ${MEASURES.map((measure) => `${measure} ${measured[measure]}%`).join(', ')}`).join('; ');
  console.log(`coverage-ratchet: ${Object.keys(measuredAll).length} workspace(s) at or above their floors (${said}).`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
