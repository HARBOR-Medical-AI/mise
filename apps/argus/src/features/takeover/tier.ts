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
export const READ_HELD: string = 'entered as READ, so nothing outside this host changes; MANAGE asks your password once (press again, or stratus oci manage)';

/** Why a control that acts asks first in a READ session that can be raised. */
export const READ_ASKS: string = 'asks your password first: this session becomes MANAGE, then the line is sent';

/** How a control that would act is drawn in a READ session: asked for the password first, or held when the session cannot be raised. */
export type ReadHold = 'asks' | 'held' | null;

/**
 * Whether a control is to be held or to ask first.
 *
 * @param line - The line it sends.
 * @param manage - The door's answer (null: no door).
 * @param canElevate - Whether the session can be raised with a password.
 * @returns `asks`, `held`, or null when the control stands.
 */
export function readHold_derive(line: string, manage: boolean | null, canElevate: boolean): ReadHold {
  if (manage !== false || !line_acts(line)) return null;
  return canElevate ? 'asks' : 'held';
}

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
 * The MODE pill a takeover's header wears beside CONDITION: the door's answer,
 * in the register of a state that governs the whole screen.
 *
 * @param manage - True for MANAGE, false for READ, null when the session has no cloud door (not a stratus session, or not known yet).
 * @returns The pill, or null when there is none to wear.
 */
export function modePill_make(manage: boolean | null): HTMLElement | null {
  if (manage === null) return null;
  const pill: HTMLElement = document.createElement('div');
  pill.className = 'tdc-condition tdc-mode';
  pill.dataset['condition'] = manage ? 'MANAGE' : 'READ';
  const label: HTMLElement = document.createElement('span');
  label.className = 'tdc-condition-label';
  label.textContent = 'MODE';
  const name: HTMLElement = document.createElement('span');
  name.className = 'tdc-condition-name';
  name.textContent = manage ? 'MANAGE' : 'READ';
  pill.append(label, name);
  pill.title = manage ? 'Entered as MANAGE: a build, a teardown or a deploy may run, each after its own question.' : READ_HELD;
  return pill;
}
