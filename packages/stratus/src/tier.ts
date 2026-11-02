/**
 * @file The session's answer at the door, in the operator's words
 * (docs/stratus.adoc, D14). A stratus session is entered as READ or MANAGE:
 * the tier the daemon calls `tasks` is what MANAGE grants, and it is chosen
 * once, before the first line, never inside a session. So a verb that would
 * act outside this host says, when it cannot, what the operator chose and
 * where the other answer is given, rather than naming the tier.
 *
 * @module
 */

/** What READ means, said once: the half every refusal starts with. */
export const READ_WORDS: string = 'entered as READ, so nothing outside this host changes';

/** Where MANAGE is chosen: at the door (porter asks it; in chell, `stratus oci manage`), by entering again. */
export const MANAGE_WORDS: string = 'MANAGE is chosen at the door (porter asks it; in chell, stratus oci manage), so enter again';

/** The whole refusal a verb that would act gives in a READ session. */
export const TIER_REFUSAL: string = `${READ_WORDS}; ${MANAGE_WORDS}`;

/** The short form a readout carries beside a held verb. */
export const TIER_HELD: string = 'entered as READ; MANAGE is chosen at the door';
