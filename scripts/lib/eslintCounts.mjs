/**
 * @file ESLint's findings as counts, and those counts against ceilings.
 *
 * The lint ratchet (`scripts/eslint-ratchet.mjs`) holds each workspace to
 * a ceiling per rule. The judging is here, apart from the running of
 * ESLint, so that it can be held to cases of its own.
 *
 * A baseline is a map from a workspace (`packages/cumin`) to a map from a
 * rule to a count, each a whole number above zero: a rule with nothing
 * found is not written down, and a workspace or rule that is not written
 * down has a ceiling of zero.
 *
 * @module
 */

/** What a finding with no rule of its own is counted under: a comment that disables a rule nothing broke. */
export const DIRECTIVE_RULE = 'eslint/unused-disable-directive';

/**
 * Reads a baseline's text.
 *
 * @param {string} text - The file's text.
 * @param {string} where - What the text is, for the words.
 * @returns {Record<string, Record<string, number>>} The ceilings.
 * @throws {Error} When it is not JSON, not a map of maps, or holds a ceiling that is not a whole number above zero.
 */
export function baseline_read(text, where) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${where} is not a map of workspaces`);
  for (const [workspace, rules] of Object.entries(parsed)) {
    if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) throw new Error(`${where}: ${workspace} is not a map of rules to counts`);
    for (const [rule, count] of Object.entries(rules)) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error(`${where}: the ceiling of ${rule} in ${workspace} is ${JSON.stringify(count)}, which is not a whole number above zero`);
    }
  }
  return parsed;
}

/**
 * Writes a baseline as text: workspaces and rules in order, so that a change to it reads as the change it is.
 *
 * @param {Record<string, Record<string, number>>} counts - Counts per workspace and rule.
 * @returns {string} The text, zero counts and empty workspaces left out.
 */
export function baseline_write(counts) {
  const sorted = {};
  for (const workspace of Object.keys(counts).sort()) {
    const rules = {};
    for (const rule of Object.keys(counts[workspace]).sort()) if (counts[workspace][rule] > 0) rules[rule] = counts[workspace][rule];
    if (Object.keys(rules).length > 0) sorted[workspace] = rules;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Every workspace and rule named in any of several maps.
 *
 * @param {...Record<string, Record<string, number>>} maps - Counts or ceilings.
 * @returns {Array<[string, string]>} Each pair once, in order.
 */
function pairs_list(...maps) {
  const pairs = new Map();
  for (const map of maps) for (const [workspace, rules] of Object.entries(map)) for (const rule of Object.keys(rules)) pairs.set(`${workspace}\u0000${rule}`, [workspace, rule]);
  return [...pairs.keys()].sort().map((key) => pairs.get(key));
}

/**
 * Judges counts against ceilings.
 *
 * @param {Record<string, Record<string, number>>} counts - What was found, per workspace and rule.
 * @param {Record<string, Record<string, number>>} ceilings - The committed ceilings.
 * @returns {{ risen: Array<{ workspace: string, rule: string, count: number, ceiling: number }>, fallen: Array<{ workspace: string, rule: string, count: number, ceiling: number }> }} Where a count is above its ceiling, and where it is below.
 */
export function counts_judge(counts, ceilings) {
  const risen = [];
  const fallen = [];
  for (const [workspace, rule] of pairs_list(counts, ceilings)) {
    const count = counts[workspace]?.[rule] ?? 0;
    const ceiling = ceilings[workspace]?.[rule] ?? 0;
    if (count > ceiling) risen.push({ workspace, rule, count, ceiling });
    else if (count < ceiling) fallen.push({ workspace, rule, count, ceiling });
  }
  return { risen, fallen };
}

/**
 * Compares the ceilings committed here with those at the change's base.
 *
 * @param {Record<string, Record<string, number>>} here - The ceilings in this change.
 * @param {Record<string, Record<string, number>>} atBase - The ceilings at the base.
 * @returns {string[]} One line per ceiling that is higher here than there; one not written down at the base was zero.
 */
export function ceilings_risen(here, atBase) {
  const lines = [];
  for (const [workspace, rule] of pairs_list(here)) {
    const now = here[workspace][rule];
    const was = atBase[workspace]?.[rule] ?? 0;
    if (now > was) lines.push(`${workspace}: the ceiling of ${rule} is ${now} here and was ${was} at the base; a ceiling only falls`);
  }
  return lines;
}

/**
 * Lowers ceilings to what was found, raising none.
 *
 * @param {Record<string, Record<string, number>>} counts - What was found.
 * @param {Record<string, Record<string, number>>} ceilings - The ceilings as committed.
 * @returns {Record<string, Record<string, number>>} New ceilings: each the lower of its count and its old ceiling.
 */
export function ceilings_lower(counts, ceilings) {
  const lowered = {};
  for (const [workspace, rule] of pairs_list(ceilings)) {
    const next = Math.min(counts[workspace]?.[rule] ?? 0, ceilings[workspace][rule]);
    if (next > 0) (lowered[workspace] ??= {})[rule] = next;
  }
  return lowered;
}
