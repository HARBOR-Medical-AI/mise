/**
 * @file The session's answer at the cloud door, worn by every stratus
 * takeover (docs/stratus.adoc, D14): READ, where nothing outside this host
 * changes, or MANAGE. The answer is given once, entering, and never inside a
 * session, so a screen says it in a chip and holds the controls that would
 * act, saying where MANAGE is chosen, rather than let a press read as a
 * request to escalate.
 *
 * @module
 */

/** Why a control that acts is held in a READ session. */
export const READ_HELD: string = 'entered as READ, so nothing outside this host changes; MANAGE is chosen at the door (porter asks it), so enter again';

/** The lines that act outside this host: a build, a teardown, an adoption, a deploy, a user added. */
const ACTING_LINE: RegExp = /^(cluster (build|adopt|teardown)|net (build|teardown)|vm (build|teardown)|chris (deploy|user add)|play )\b/;

/**
 * Whether a session line would act outside this host, and so needs MANAGE.
 *
 * @param line - The line a control sends.
 * @returns True for a build, a teardown, an adoption, a deploy, a user add, a play.
 */
export function line_acts(line: string): boolean {
  return ACTING_LINE.test(line.trim());
}

/**
 * The chip a takeover's header wears for the door's answer.
 *
 * @param manage - True for MANAGE, false for READ, null when the session has no cloud door (not a stratus session, or not known yet).
 * @returns The chip, or null when there is none to wear.
 */
export function tierChip_make(manage: boolean | null): HTMLElement | null {
  if (manage === null) return null;
  const chip: HTMLElement = document.createElement('span');
  chip.className = `tdc-chip tdc-chip-tier tdc-chip-tier-${manage ? 'manage' : 'read'}`;
  chip.textContent = manage ? 'MANAGE' : 'READ · NOTHING OUTSIDE THIS HOST CHANGES';
  chip.title = manage ? 'Entered as MANAGE: a build, a teardown or a deploy may run, each after its own question.' : READ_HELD;
  return chip;
}
