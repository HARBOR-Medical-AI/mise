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
 * The floors themselves cannot fall: they are compared with the same
 * section as it stood at the change's base (`scripts/lib/ratchetBase.mjs`
 * says which commit that is), and one lower here than there fails. A
 * workspace the base did not name had no floor, and may be given any.
 *
 * A workspace named in the section whose summary is not there has not had
 * its tests run with coverage, which is not a pass.
 *
 * Run by the workspace's own `test` script, after jest. The tree to read
 * and the baseline file may be given as the first two arguments, as the
 * check's own test does; `--raise` rewrites the floors to what was
 * measured, where that is higher.
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
  }
  return section;
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
 * @returns {string[]} One line per fault: a fall, or a rise that has not been kept.
 */
export function coverage_judge(workspace, floors, measured) {
  const faults = [];
  for (const measure of MEASURES) {
    const floor = floors[measure];
    const now = measured[measure];
    if (now < floor) faults.push(`${workspace}: ${measure} coverage is ${now}%, below its floor of ${floor}%. A change may not lower coverage: test what it added.`);
    else if (floor_derive(now) > floor) faults.push(`${workspace}: ${measure} coverage rose to ${now}% (floor ${floor}%) — good. Raise the floor to ${floor_derive(now)} in ${BASELINE_FILE} as part of this change (node scripts/coverage-ratchet.mjs --raise), so the gain is kept.`);
  }
  return faults;
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
  }
  return faults;
}

/** Runs the check; the exit status is whether it passed. */
function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--raise');
  const raise = process.argv.includes('--raise');
  const root = resolve(args[0] ?? fileURLToPath(new URL('..', import.meta.url)));
  const baselinePath = resolve(args[1] ?? join(root, BASELINE_FILE));
  let floors;
  let baselineText;
  try {
    baselineText = readFileSync(baselinePath, 'utf8');
    floors = floors_read(baselineText, args[1] ?? BASELINE_FILE);
  } catch (error) {
    console.error(`coverage-ratchet: ${error.message}`);
    process.exit(1);
  }
  const faults = [];
  const measuredAll = {};
  for (const [workspace, own] of Object.entries(floors)) {
    const summaryPath = join(root, workspace, 'coverage', 'coverage-summary.json');
    if (!existsSync(summaryPath)) {
      faults.push(`${workspace}: no coverage summary at ${workspace}/coverage/coverage-summary.json. Run its tests with coverage first (npm test in ${workspace}).`);
      continue;
    }
    try {
      measuredAll[workspace] = summary_read(readFileSync(summaryPath, 'utf8'), `${workspace}/coverage/coverage-summary.json`);
    } catch (error) {
      faults.push(`${workspace}: ${error.message}`);
      continue;
    }
    faults.push(...coverage_judge(workspace, own, measuredAll[workspace]));
  }
  if (raise) {
    const whole = JSON.parse(baselineText);
    let raised = 0;
    for (const [workspace, measured] of Object.entries(measuredAll)) {
      for (const measure of MEASURES) {
        if (measured[measure] < floors[workspace][measure]) continue;
        const next = floor_derive(measured[measure]);
        if (next > whole.coverage[workspace][measure]) { whole.coverage[workspace][measure] = next; raised++; }
      }
    }
    const below = faults.filter((line) => line.includes('below its floor') || line.includes('no coverage summary') || line.includes('has no '));
    if (below.length > 0) {
      for (const line of below) console.error(`  ${line}`);
      console.error('coverage-ratchet: nothing raised: the tree does not pass as it is.');
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify(whole, null, 2)}\n`);
    console.log(`coverage-ratchet: raised ${raised} floor(s) in ${BASELINE_FILE}; none lowered.`);
    return;
  }
  // The floors against the base: only when the tree read is the repository itself.
  if (args[0] === undefined || process.env.COVERAGE_RATCHET_BASE === '1') {
    try {
      const base = base_resolve(process.env, root);
      const atBaseText = fileAtCommit_read(base.sha, BASELINE_FILE, root);
      if (atBaseText !== null) {
        const parsed = JSON.parse(atBaseText);
        // A base from before the ratchet has no section: there was no floor to hold to.
        if (parsed?.coverage !== undefined) faults.push(...floors_compare(floors, floors_read(atBaseText, `${BASELINE_FILE} at ${base.how}`)));
      }
    } catch (error) {
      faults.push(`the floors could not be compared with the base: ${error.message}`);
    }
  }
  if (faults.length > 0) {
    console.error(`coverage-ratchet: ${faults.length} fault(s):`);
    for (const line of faults) console.error(`  ${line}`);
    process.exit(1);
  }
  const said = Object.entries(measuredAll).map(([workspace, measured]) => `${workspace} ${MEASURES.map((measure) => `${measure} ${measured[measure]}%`).join(', ')}`).join('; ');
  console.log(`coverage-ratchet: ${Object.keys(measuredAll).length} workspace(s) at or above their floors (${said}).`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
