/**
 * @file A Resource Manager job's log, as a step's log carries it: the
 * Terraform line without its console prefix, and only what says what the job
 * does to the stack. Terraform's set-up (provider install, signing notes,
 * "you may now begin working", the variables file, refreshing each
 * resource's state) is said on every job and says nothing about this one;
 * the plan's changes, its count, an apply's resources as they complete, and
 * any error stay. The whole log stays in Resource Manager.
 *
 * Key components:
 * - jobLogLine_keep: one line of a job's log, as the step's log carries it, or null.
 *
 * Typical usage:
 * ```ts
 * const kept: string | null = jobLogLine_keep('2026/11/06 21:42:45[TERRAFORM_CONSOLE] [INFO] Plan: 0 to add, 1 to change, 0 to destroy.');
 * ```
 *
 * Dependencies: none; the prefix is Resource Manager's (`<date> <time>[TERRAFORM_CONSOLE] [INFO] `).
 *
 * @module
 */

/** Resource Manager's prefix on each Terraform line: its date and time, the console tag and the level. */
const CONSOLE_PREFIX: RegExp = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s*\[TERRAFORM_CONSOLE\]\s*\[(INFO|WARN|ERROR)\]\s?/;

/** Terraform's set-up and closing words, said on every job, matched at the line's start. */
const SAID_EVERY_JOB: ReadonlyArray<RegExp> = [
  /^Initializing (the backend|provider plugins|modules)/,
  /^- (Reusing previous version|Installing|Installed|Finding|Using previously-installed)/,
  /^Partner and community providers are signed/,
  /^If you'd like to know more about provider signing/,
  /^https:\/\/www\.terraform\.io\/docs\/cli\/plugins\/signing\.html/,
  /^Terraform has been successfully initialized/,
  /^You may now begin working with Terraform/,
  /^any changes that are required for your infrastructure/,
  /^should now work\.?$/,
  /^If you ever set or change modules or backend configuration/,
  /^rerun this command to reinitialize your working directory/,
  /^commands will detect it and remind you to do so if necessary/,
  /^Loading Environment variables from/,
  /: Refreshing state\.\.\./,
  /: Reading\.\.\.$/,
  /: Read complete after/,
  /^Saved the plan to:/,
  /^To perform exactly these actions, run the following command/,
  /^terraform apply "/,
  /^Terraform used the selected providers to generate the following execution/,
  /^plan\. Resource actions are indicated with the following symbols:/,
  /^─+$/,
  /^Note: You didn't use the -out option/,
  /^Getting providers from registry/,
  /^Terraform has compared your real infrastructure against your configuration/,
  /^and found no differences, so no changes are needed\.?$/,
];

/**
 * One line of a job's log, as a step's log carries it: the console prefix
 * gone, and nothing for a line every job says, or a blank one.
 *
 * @param raw - The line as Resource Manager returns it.
 * @returns The line to show, or null to leave out.
 * @example
 * ```ts
 * jobLogLine_keep('2026/11/06 21:41:57[TERRAFORM_CONSOLE] [INFO] Terraform has been successfully initialized!'); // null
 * jobLogLine_keep('2026/11/06 21:42:45[TERRAFORM_CONSOLE] [INFO] Plan: 0 to add, 1 to change, 0 to destroy.'); // 'Plan: 0 to add, 1 to change, 0 to destroy.'
 * ```
 */
export function jobLogLine_keep(raw: string): string | null {
  const text: string = raw.replace(CONSOLE_PREFIX, '').trimEnd();
  const plain: string = text.trim();
  if (plain === '' || plain === 'undefined') return null;
  if (SAID_EVERY_JOB.some((said: RegExp): boolean => said.test(plain))) return null;
  return text;
}
