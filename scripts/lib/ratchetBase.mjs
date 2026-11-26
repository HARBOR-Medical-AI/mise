/**
 * @file What a ratchet's ceilings are compared with: the same file as it
 * stood at the change's base.
 *
 * A ratchet fails when a count rises above its committed ceiling. That is
 * only a check if the ceiling cannot be raised in the same change as the
 * count. So the committed ceilings are themselves compared with the
 * ceilings at the commit this change starts from, and none here may be
 * higher than it was there.
 *
 * The base, per way a check is run:
 *
 * - `RATCHET_BASE` set: that ref or SHA (a person's word; a workflow's
 *   `workflow_dispatch` input arrives this way).
 * - a pull request (`GITHUB_EVENT_NAME=pull_request`): the merge base of
 *   `HEAD` and `origin/$GITHUB_BASE_REF`.
 * - a push (`GITHUB_EVENT_NAME=push`): the commit the branch was at before
 *   the push, `RATCHET_BEFORE` (the event's `before`).
 * - a manual run with no input (`workflow_dispatch`): `HEAD~1` on `main`,
 *   else the merge base with `origin/main`.
 * - anywhere else (a checkout on a desk): the merge base with `origin/main`.
 *
 * Whatever names the base, it must resolve to a commit that is here. A ref
 * that does not resolve, a `before` of all zeros, a fetch that did not
 * bring the commit: each fails the check. There is exactly one case in
 * which there are no ceilings to compare with, and it is not an error:
 * the base resolved, and the baseline file is not in its tree.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';

/** Runs git and returns what it printed, trimmed; throws with git's words when it fails. */
function git_run(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    const said = String(error.stderr ?? error.message).trim().split('\n')[0];
    throw new Error(`git ${args.join(' ')}: ${said}`);
  }
}

/**
 * Names the base for this run, before it is resolved.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} cwd - The repository.
 * @returns {{ how: string, ref: string, mergeBase: boolean }} What names it, the ref, and whether the base is the merge base with that ref.
 * @throws {Error} When the way the check is run gives no base.
 */
export function base_name(env, cwd) {
  if (env.RATCHET_BASE !== undefined && env.RATCHET_BASE !== '') return { how: 'RATCHET_BASE', ref: env.RATCHET_BASE, mergeBase: false };
  const event = env.GITHUB_EVENT_NAME ?? '';
  if (event === 'pull_request') {
    if (env.GITHUB_BASE_REF === undefined || env.GITHUB_BASE_REF === '') throw new Error('a pull request run with no GITHUB_BASE_REF: the base cannot be named');
    return { how: 'the pull request\'s base', ref: `origin/${env.GITHUB_BASE_REF}`, mergeBase: true };
  }
  if (event === 'push') {
    const before = env.RATCHET_BEFORE ?? '';
    if (!/^[0-9a-f]{40}$/.test(before) || /^0+$/.test(before)) throw new Error(`a push run whose before commit is "${before}": the base cannot be named`);
    return { how: 'the push\'s before commit', ref: before, mergeBase: false };
  }
  if (event === 'workflow_dispatch' && (env.GITHUB_REF_NAME ?? '') === 'main') return { how: 'the commit before this one on main', ref: 'HEAD~1', mergeBase: false };
  if (event !== '' && event !== 'workflow_dispatch') throw new Error(`a ${event} run: no base is defined for it`);
  void cwd;
  return { how: 'the merge base with origin/main', ref: 'origin/main', mergeBase: true };
}

/**
 * Resolves the base to a commit that is in this repository.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} cwd - The repository.
 * @returns {{ how: string, sha: string }} What named it and the commit.
 * @throws {Error} When it does not resolve to a commit that is here.
 */
export function base_resolve(env, cwd) {
  const named = base_name(env, cwd);
  let sha;
  try {
    sha = git_run(['rev-parse', '--verify', '--quiet', `${named.ref}^{commit}`], cwd);
    if (named.mergeBase) sha = git_run(['merge-base', 'HEAD', sha], cwd);
    git_run(['cat-file', '-e', `${sha}^{commit}`], cwd);
  } catch (error) {
    throw new Error(`the base (${named.how}: ${named.ref}) does not resolve to a commit that is here: ${error.message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the base (${named.how}: ${named.ref}) resolved to "${sha}", which is no commit`);
  return { how: named.how, sha };
}

/**
 * Reads a file as it stood at a commit.
 *
 * @param {string} sha - The commit, resolved.
 * @param {string} file - The file's path from the repository's root.
 * @param {string} cwd - The repository.
 * @returns {string | null} Its text; null only when the commit's tree does not have it.
 * @throws {Error} When the tree cannot be read, or the file is there and cannot be.
 */
export function fileAtCommit_read(sha, file, cwd) {
  const listed = git_run(['ls-tree', '--name-only', sha, '--', file], cwd);
  if (listed === '') return null;
  return git_run(['show', `${sha}:${file}`], cwd);
}

/**
 * Compares one section's ceilings with the same section at the base.
 *
 * @param {Record<string, number>} here - The ceilings committed in this change.
 * @param {Record<string, number> | undefined} atBase - The same section at the base; undefined when the base had no such section (it is new).
 * @param {string} what - The section's name, for the words.
 * @returns {string[]} One line per ceiling that is higher here than at the base; a key the base's section did not have had a ceiling of zero.
 */
export function ceilings_compare(here, atBase, what) {
  if (atBase === undefined) return [];
  const risen = [];
  for (const [key, count] of Object.entries(here)) {
    const was = atBase[key] ?? 0;
    if (count > was) risen.push(`${what}: ${key} is ${count} here and was ${was} at the base; a ceiling only falls`);
  }
  return risen;
}
