/**
 * @file Words for the two grammars a VM is reached through, neither of which
 * is the mise shell's: a POSIX `sh` (the VM's, and the operator's own for a
 * printed line), and OpenSSH's reading of an option.
 *
 * OpenSSH reads an option's value as words of its own (double quotes hold a
 * space; a backslash escapes a quote or a backslash), then expands `%`
 * tokens in most of them (`%%` is one percent). `ProxyCommand` is expanded
 * the same way and then handed whole to the operator's shell, so a word
 * inside it passes through three readers: the percent expansion, the shell,
 * and the `ssh` the shell starts.
 *
 * Key components:
 * - shWord_quote, shWord_write: a word for `sh`, always quoted, or bare when plain.
 * - sshOption_write: `Name=value` as OpenSSH reads one value back.
 * - sshProxy_compose: a `ProxyCommand` whose words survive all three readers.
 *
 * Typical usage:
 * ```ts
 * ['-o', sshOption_write('UserKnownHostsFile', known)];
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/** A word `sh` reads as itself with no quotes. */
const SH_PLAIN: RegExp = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A value OpenSSH reads as itself with no quotes, and expands nothing in. */
const SSH_PLAIN: RegExp = /^[A-Za-z0-9_@+=:,./-]+$/;

/**
 * A word as a POSIX `sh` reads it back, always quoted: inside single quotes,
 * each quote closed, escaped and opened again.
 *
 * @param word - The word.
 * @returns It, as one word of a shell line.
 *
 * @example
 * ```ts
 * shWord_quote("it's"); // 'it'\''s'
 * ```
 */
export function shWord_quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * A word for a shell line a person will read: bare when it is plainly one
 * word, quoted by `shWord_quote` otherwise. The shell reads the same word
 * either way.
 *
 * @param word - The word.
 * @returns It, as one word of a shell line.
 *
 * @example
 * ```ts
 * shWord_write('/keys/id');  // /keys/id
 * shWord_write('/my keys');  // '/my keys'
 * ```
 */
export function shWord_write(word: string): string {
  return SH_PLAIN.test(word) ? word : shWord_quote(word);
}

/**
 * An OpenSSH option, written so its value is read back as one value, itself:
 * bare when plain; otherwise in double quotes, a backslash and a double
 * quote escaped, and a percent doubled so no token is expanded in it.
 *
 * @param name - The option's name (`UserKnownHostsFile`).
 * @param value - Its value, a path as a rule.
 * @returns `Name=value`, for `ssh -o`.
 * @throws {Error} When the value holds `${`, which OpenSSH expands from the environment and offers no way to write literally.
 *
 * @example
 * ```ts
 * sshOption_write('IdentityFile', '/keys/my key 50%/id'); // IdentityFile="/keys/my key 50%%/id"
 * ```
 */
export function sshOption_write(name: string, value: string): string {
  if (value.includes('${')) throw new Error(`${name}: OpenSSH would expand "\${" in ${value}; it cannot be given this path`);
  if (SSH_PLAIN.test(value)) return `${name}=${value}`;
  return `${name}="${value.replace(/([\\"])/g, '\\$1').replace(/%/g, '%%')}"`;
}

/**
 * A `ProxyCommand` value: a command's words for the shell OpenSSH hands it
 * to, each quoted for that shell and its percents doubled, since OpenSSH
 * expands the whole value before the shell sees it. Tokens that are meant
 * (`%h:%p`) are given apart and stand as they are.
 *
 * @param words - The command's words before the tokens, as values.
 * @param tokens - Words holding tokens OpenSSH is to expand, as they are to stand.
 * @param rest - The words after them, as values.
 * @returns The command.
 *
 * @example
 * ```ts
 * sshProxy_compose(['ssh', '-o', 'IdentityFile="/k 1/id"'], ['-W', '%h:%p'], ['s@bastion']);
 * // ssh -o 'IdentityFile="/k 1/id"' -W %h:%p s@bastion
 * ```
 */
export function sshProxy_compose(words: ReadonlyArray<string>, tokens: ReadonlyArray<string>, rest: ReadonlyArray<string>): string {
  const literal = (word: string): string => shWord_write(word).replace(/%/g, '%%');
  return [...words.map(literal), ...tokens, ...rest.map(literal)].join(' ');
}
