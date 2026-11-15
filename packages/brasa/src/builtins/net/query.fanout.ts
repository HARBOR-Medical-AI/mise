import { Err, Ok, errorStack, type Result } from '@fnndsc/fond';
/**
 * @file A PACS question that names several patients is several questions.
 *
 * A PACS will not match a list. `PatientID:4356325\4433255` — the DICOM
 * multi-value form — returns nothing from PACSDCM, and the standard agrees:
 * *List of UID Matching* is defined only for attributes whose VR is `UI`,
 * and `PatientID` is `LO`. So two hundred MRNs is two hundred C-FINDs. The
 * fan-out is forced, not chosen.
 *
 * This module is the arithmetic of that: reading a cohort out of what the
 * operator typed (or out of a file in CFS), turning multi-valued terms into
 * the individual questions they stand for, and refusing by name when the
 * cross-product would launch hundreds.
 *
 * @module
 */

/** The DICOM key a cohort is expressed in. */
export const PATIENT_KEY: string = 'PatientID';

/**
 * The most questions one inline expression may stand for.
 *
 * A handful of MRNs typed on a line is the case this serves; a real cohort
 * belongs in `--patients`, which is why the refusal names that flag. The
 * cross-product of several multi-valued terms grows fast enough that a typo
 * could otherwise launch hundreds of C-FINDs at a shared clinical system.
 */
export const QUERY_INLINE_FANOUT_MAX: number = 32;

/**
 * The most questions `--patients` may stand for.
 *
 * Deliberately generous — a two-hundred-MRN audit is the point of the flag —
 * but not unbounded: a file of the wrong kind should be refused rather than
 * walked.
 */
export const QUERY_COHORT_MAX: number = 500;

/** Marks a `--patients` value as naming a file rather than listing MRNs. */
const FILE_SIGIL: string = '@';

/**
 * Parses a query expression into terms, each of which may carry several
 * values.
 *
 * The operator's own syntax, accepted as written:
 *
 * ```
 * PatientID:1234,4532,6654          one key, three values  → three questions
 * PatientID:1234,StudyDate:20240101 two keys, one value each → one question
 * ```
 *
 * There is no ambiguity to resolve: every genuine term carries a colon, so a
 * bare segment can only be another value for the key before it.
 *
 * @param expr - The expression as typed.
 * @returns Each key with its values in order, or null when the expression is
 *   malformed.
 */
export function queryTerms_parse(expr: string): Record<string, string[]> | null {
  const terms: Record<string, string[]> = {};
  let current: string | null = null;
  for (const raw of expr.split(',')) {
    const part: string = raw.trim();
    if (part === '') return null;
    const colon: number = part.indexOf(':');
    if (colon < 1) {
      // A bare segment before any key names nothing.
      if (current === null) return null;
      terms[current].push(part);
      continue;
    }
    const key: string = part.slice(0, colon).trim();
    const value: string = part.slice(colon + 1).trim();
    if (key === '' || value === '') return null;
    current = key;
    terms[key] = [...(terms[key] ?? []), value];
  }
  return Object.keys(terms).length > 0 ? terms : null;
}

/**
 * Expands multi-valued terms into the individual questions they stand for.
 *
 * Several multi-valued keys fan out over their cross-product, in the order
 * the keys were written, so the questions come out in the order an operator
 * would have listed them.
 *
 * @param terms - Parsed terms.
 * @returns One criteria record per question.
 */
export function queryTerms_expand(terms: Record<string, string[]>): Array<Record<string, string>> {
  let expanded: Array<Record<string, string>> = [{}];
  for (const [key, values] of Object.entries(terms)) {
    const grown: Array<Record<string, string>> = [];
    for (const partial of expanded) {
      for (const value of values) grown.push({ ...partial, [key]: value });
    }
    expanded = grown;
  }
  return expanded;
}

/**
 * Reads a `--patients` value: MRNs listed inline, or `@` and a CFS path.
 *
 * The file is read through the session's own CFS path, never the engine's
 * host filesystem, so the flag behaves identically from a local shell, a
 * remote shell and a browser — and a list sitting on somebody's own machine
 * reaches it through `upload`, which is the gated door, rather than through
 * a second ungated one.
 *
 * One MRN per line; blank lines and `#` comments are ignored. An inline
 * value is comma-separated, which is what a handful of MRNs looks like.
 *
 * @param value - The flag's value.
 * @returns The MRNs in the order given, or a failure with the reason on the
 *   error stack.
 */
export async function patients_read(value: string): Promise<Result<string[]>> {
  if (!value.startsWith(FILE_SIGIL)) {
    const listed: string[] = value.split(',')
      .map((entry: string): string => entry.trim())
      .filter((entry: string): boolean => entry !== '');
    if (listed.length === 0) {
      errorStack.stack_push('error', 'query: --patients names no patients.');
      return Err();
    }
    return Ok(listed);
  }

  const named: string = value.slice(FILE_SIGIL.length);
  if (named === '') {
    errorStack.stack_push('error', 'query: --patients @ names no file.');
    return Err();
  }
  // Imported where they are used: a cohort file is a rare path, and
  // pulling the session and storage stacks into this module's graph would
  // load both for every query that never names one.
  const { storePath_resolve } = await import('../utils.js');
  const { fileContent_get } = await import('@fnndsc/salsa');
  const resolved: string = await storePath_resolve(named);
  const content: Result<string> = await fileContent_get(resolved);
  if (!content.ok) {
    const problem: { message: string } | undefined = errorStack.stack_pop();
    errorStack.stack_push('error', `query: cannot read ${resolved}: ${problem?.message ?? 'unreadable'}`);
    return Err();
  }
  const mrns: string[] = content.value
    .split('\n')
    .map((line: string): string => line.trim())
    .filter((line: string): boolean => line !== '' && !line.startsWith('#'));
  if (mrns.length === 0) {
    errorStack.stack_push('error', `query: ${resolved} lists no patients.`);
    return Err();
  }
  return Ok(mrns);
}

/**
 * Guards a fan-out's size, refusing by name rather than launching it.
 *
 * @param count - How many questions the expansion came to.
 * @param limit - The ceiling that applies to how they were asked.
 * @returns True when the fan-out may proceed; otherwise the reason is on the
 *   error stack.
 */
export function fanout_permit(count: number, limit: number): boolean {
  if (count <= limit) return true;
  errorStack.stack_push(
    'error',
    `query: refusing: ${count} queries; use --patients with a file, or narrow the terms.`,
  );
  return false;
}
