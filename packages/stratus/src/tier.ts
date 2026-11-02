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

/** How MANAGE is had: the person's password, asked once, by `stratus oci manage` or the held control pressed again. */
export const MANAGE_WORDS: string = 'MANAGE asks your password once (stratus oci manage, or the control pressed again), then this session acts';

/** The whole refusal a verb that would act gives in a READ session. */
export const TIER_REFUSAL: string = `${READ_WORDS}; ${MANAGE_WORDS}`;

/** The short form a readout carries beside a held verb. */
export const TIER_HELD: string = 'entered as READ; MANAGE asks your password once';
