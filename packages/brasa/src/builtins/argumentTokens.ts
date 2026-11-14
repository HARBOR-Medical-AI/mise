/**
 * @file Shared token-preserving parsing for executable options.
 *
 * Plugin execution, PACS attachment, and pipeline bindings use this module so
 * quoted values and scalar coercion remain identical across command surfaces.
 *
 * @module
 */

/** Parsed executable option names and their scalar values. */
export type ExecutableArguments = Record<string, string | boolean | number>;

/**
 * Reads one value as CUBE reads a scalar: `true` and `false`, a number, or
 * the text as typed.
 *
 * @param value - The word.
 * @returns The value.
 *
 * @example
 * ```ts
 * argumentValue_coerce('0.5'); // 0.5
 * ```
 */
export function argumentValue_coerce(value: string): string | boolean | number {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.trim() !== '') {
    const numeric: number = Number(value);
    if (!Number.isNaN(numeric)) return numeric;
  }
  return value;
}

/**
 * Parse already-tokenized options and context assignments.
 *
 * @param tokens - `--name value`, `--name=value`, or bare `name=value` tokens.
 * @returns Dictionary containing scalar-coerced option values.
 * @throws {Error} When a token is not an option or assignment.
 */
export function executableArguments_parse(tokens: readonly string[]): ExecutableArguments {
  const result: ExecutableArguments = {};
  for (let index: number = 0; index < tokens.length; index++) {
    const token: string = tokens[index];
    const prefixed: boolean = token.startsWith('-') && token !== '-';
    const bareAssignment: boolean = !prefixed && token.indexOf('=') > 0;
    if (!prefixed && !bareAssignment) throw new Error(`Unexpected value without an option: ${token}`);
    const option: string = prefixed ? token.replace(/^-+/, '') : token;
    const equalsIndex: number = option.indexOf('=');
    if (equalsIndex >= 0) {
      const name: string = option.slice(0, equalsIndex);
      if (!name) throw new Error(`Invalid option: ${token}`);
      result[name] = argumentValue_coerce(option.slice(equalsIndex + 1));
      continue;
    }
    if (!option) throw new Error(`Invalid option: ${token}`);
    const next: string | undefined = tokens[index + 1];
    if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
      result[option] = argumentValue_coerce(next);
      index++;
    } else {
      result[option] = true;
    }
  }
  return result;
}
