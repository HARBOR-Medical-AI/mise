/**
 * @file The wire-contract message schemas.
 *
 * Two discriminated unions, one per direction, keyed on a `type` tag:
 * {@link clientMessageSchema} (surface → daemon) and
 * {@link serverMessageSchema} (daemon → surface). Every request carries a
 * correlation `id` so its reply and any streamed output can be matched to
 * it, and output events carry the sink channel they belong to. These schemas
 * are the single source of truth for the protocol; the human-readable
 * description in `docs/calypso.adoc` is checked against them.
 *
 * @module
 */
import { z } from 'zod';
import { PROC_PROMPT_STATES } from './proc.js';
import {
  PROGRESS_KINDS,
  PROGRESS_OPERATIONS,
  PROGRESS_PHASES,
  PROGRESS_STATUSES,
  PROGRESS_UNITS,
} from './progress.js';
import { commandEnvelopeSchema } from './envelope.js';

/** The sink channel an output event belongs to. */
export const channelSchema = z.enum(['data', 'err', 'status']);

// --- Surface → daemon ------------------------------------------------------

/**
 * Capabilities an attaching surface can safely execute on its own machine.
 *
 * Optional throughout, and absent means false: a surface built against an older
 * contract simply declares less, and the daemon refuses what it did not claim
 * rather than assuming.
 */
export const surfaceCapabilitiesMessageSchema = z.object({
  shellCommands: z.boolean(),
  hiddenInput: z.boolean().optional(),
  /** Renders ANSI colour, so a thumbnail can be half-blocks, not an ASCII ramp. */
  color: z.boolean().optional(),
  /** Can put a file where its operator can reach it. */
  fileDelivery: z.boolean().optional(),
  /**
   * Has a filesystem of its own, so it can receive many files as a directory
   * structure. A browser cannot, and needs a directory archived into one file
   * before it can be handed over.
   */
  localFilesystem: z.boolean().optional(),
  /**
   * The subjects this surface's own language answers for (a browser's `dag`,
   * `desktop`, `pane`). A subject the session also owns lists the verbs the
   * surface claims from it; any other verb stays the session's. A line any
   * surface types whose subject is claimed here is run by this surface.
   */
  claims: z.array(z.object({ subject: z.string(), verbs: z.array(z.string()).optional() })).optional(),
  /** Set by a terminal's chell: the terminal it draws, so the daemon knows which browser it belongs to. */
  terminal: z.string().optional(),
});

/** Attach to a session: declares the contract version, token, and surface capabilities. */
export const attachMessageSchema = z.object({
  type: z.literal('attach'),
  protocolVersion: z.number().int(),
  token: z.string(),
  session: z.string().optional(),
  capabilities: surfaceCapabilitiesMessageSchema.optional(),
});

/**
 * Execute one input line, correlated by `id`.
 *
 * `instrument` marks surface-internal traffic (a panel's silent refresh, an
 * ambient cycler) rather than something the operator said: the daemon runs
 * it normally but keeps it off the session bus and out of scrollback, so
 * sibling surfaces and reattach replays carry only operator activity.
 */
export const executeMessageSchema = z.object({
  type: z.literal('execute'),
  id: z.string(),
  line: z.string(),
  instrument: z.boolean().optional(),
  /**
   * The surface shows this command in its own consoles itself (a browser
   * mirroring a pressed verb into its terminal): its session echo skips them.
   */
  mirrored: z.boolean().optional(),
});

/** Requests cancellation of the caller's currently executing command. */
export const cancelMessageSchema = z.object({
  type: z.literal('cancel'),
  id: z.string(),
});

/**
 * The operator's STOP: ends the command running for this surface (its own,
 * or one typed in a terminal it owns), whatever it is. A command that does
 * not end when asked is abandoned and the session is free again.
 */
export const stopMessageSchema = z.object({
  type: z.literal('stop'),
});

/**
 * A surface asks to raise its session from READ to MANAGE with the person's
 * password: the daemon checks it at the door it was given and grants the
 * `tasks` tier to that surface alone, for as long as it is attached
 * (docs/stratus.adoc, D14).
 */
export const elevateMessageSchema = z.object({
  type: z.literal('elevate'),
  password: z.string(),
});

/** Request completion candidates for a partial line, correlated by `id`. */
export const completeRequestSchema = z.object({
  type: z.literal('complete'),
  id: z.string(),
  prefix: z.string(),
});

/** Answers a prompt the daemon requested during a command, correlated by `promptId`. */
export const promptAnswerMessageSchema = z.object({
  type: z.literal('promptAnswer'),
  promptId: z.string(),
  answer: z.string(),
});

/** Reports a prompt failure to the daemon (surface cannot or did not answer), correlated by `promptId`. */
export const promptErrorMessageSchema = z.object({
  type: z.literal('promptError'),
  promptId: z.string(),
  reason: z.string(),
});

/** Returns the output of a pipeline segment the daemon asked the surface to run, correlated by `pipeId`. */
export const pipeResultMessageSchema = z.object({
  type: z.literal('pipeResult'),
  pipeId: z.string(),
  output: z.string(),
});

/** Returns a pipeline-segment failure to the daemon, correlated by `pipeId`. */
export const pipeErrorMessageSchema = z.object({
  type: z.literal('pipeError'),
  pipeId: z.string(),
  reason: z.string(),
});

/** Returns the exit code of a shell command the daemon asked the surface to run. */
export const shellResultMessageSchema = z.object({
  type: z.literal('shellResult'),
  shellId: z.string(),
  exitCode: z.number().int(),
});

/** Returns a surface shell-launch failure to the daemon, correlated by `shellId`. */
export const shellErrorMessageSchema = z.object({
  type: z.literal('shellError'),
  shellId: z.string(),
  reason: z.string(),
});

/** Returns the edited content from a local-edit the daemon requested, correlated by `editId`. */
export const editResultMessageSchema = z.object({
  type: z.literal('editResult'),
  editId: z.string(),
  content: z.string(),
  changed: z.boolean(),
  /**
   * The surface took the content into an editor that stays open (a browser's
   * editor pane). Nothing comes back to save here: each save the operator
   * makes there runs as its own command line.
   */
  opened: z.boolean().optional(),
});

/** Reports a local-edit failure to the daemon, correlated by `editId`. */
export const editErrorMessageSchema = z.object({
  type: z.literal('editError'),
  editId: z.string(),
  reason: z.string(),
});

/**
 * Reports a completed file delivery, correlated by `deliverId`.
 *
 * `location` is wherever the surface can honestly say the file went — an
 * absolute path for a filesystem, a bare filename for a browser that handed it
 * to the download manager.
 */
export const deliverResultMessageSchema = z.object({
  type: z.literal('deliverResult'),
  deliverId: z.string(),
  location: z.string(),
  bytes: z.number().nonnegative(),
});

/** Reports a failed file delivery to the daemon, correlated by `deliverId`. */
export const deliverErrorMessageSchema = z.object({
  type: z.literal('deliverError'),
  deliverId: z.string(),
  reason: z.string(),
});

/**
 * The operator's regard: the addressable thing most recently indicated on a
 * surface — a file clicked in a browser, a DAG node selected.
 *
 * The value is an address in the namespace (plus the model kind it was
 * indicated through), never view-space coordinates: what has no address is
 * view state and stays surface-side. `groupId` and `paneId` are provenance —
 * which link group and pane the indication happened in — so session-level
 * consumers know where regard came from without the surface's geometry ever
 * crossing the wire.
 */
export const regardSchema = z.object({
  address: z.string(),
  modelKind: z.string().optional(),
  groupId: z.string(),
  paneId: z.string(),
});

/** The session's retained regard value. */
export type Regard = z.infer<typeof regardSchema>;

/**
 * A regard write, travelling both directions under one shape: a surface
 * reports an indication to the daemon, and the daemon pushes the retained
 * session regard to every surface (last write wins; a late attacher receives
 * the retained value on attach).
 */
export const regardMessageSchema = z.object({
  type: z.literal('regard'),
  regard: regardSchema,
});

/**
 * A liveness subscription: the surface asks the session to keep one subject
 * fresh while the surface is looking at it. The subject is an address in
 * the namespace (`/proc/jobs/feed_N`), never a view. Regard is what the
 * operator indicates; a watch is what a surface keeps open — a different
 * noun, so it has its own message. Watches are owned per surface and
 * released when the surface detaches.
 */
export const watchMessageSchema = z.object({
  type: z.literal('watch'),
  subject: z.string(),
});

/** Ends a surface's liveness subscription for one subject. */
export const unwatchMessageSchema = z.object({
  type: z.literal('unwatch'),
  subject: z.string(),
});

/**
 * Opens a terminal: the session's console as a real terminal, a chell the
 * daemon runs under a pseudo-terminal. `terminalId` names one opened before
 * (a reload reattaches); absent or no longer running, a new one starts.
 * The size is the viewer's grid, in cells.
 */
export const terminalOpenMessageSchema = z.object({
  type: z.literal('terminalOpen'),
  terminalId: z.string().optional(),
  cols: z.number().int(),
  rows: z.number().int(),
});

/** Keystrokes typed into a terminal, as the terminal emulator encodes them. */
export const terminalInputMessageSchema = z.object({
  type: z.literal('terminalInput'),
  terminalId: z.string(),
  data: z.string(),
});

/** A terminal's new size, in cells. */
export const terminalResizeMessageSchema = z.object({
  type: z.literal('terminalResize'),
  terminalId: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
});

/** Ends a terminal its viewer is done with. */
export const terminalCloseMessageSchema = z.object({
  type: z.literal('terminalClose'),
  terminalId: z.string(),
});

/** The answer to a `surfaceLine`: what the surface's own language said, as text to print. */
export const surfaceLineResultMessageSchema = z.object({
  type: z.literal('surfaceLineResult'),
  lineId: z.string(),
  rendered: z.string(),
  status: z.enum(['ok', 'error']),
});

/** A `surfaceLine` the surface could not run (it no longer answers for the subject, or it failed). */
export const surfaceLineErrorMessageSchema = z.object({
  type: z.literal('surfaceLineError'),
  lineId: z.string(),
  reason: z.string(),
});

/** A surface's claims, declared or changed after attach (a composition extends the language once the backend is known). */
export const surfaceClaimsMessageSchema = z.object({
  type: z.literal('surfaceClaims'),
  claims: z.array(z.object({ subject: z.string(), verbs: z.array(z.string()).optional() })),
});

/** A note from a surface for its console: printed above the line being typed there. */
export const noteMessageSchema = z.object({
  type: z.literal('note'),
  text: z.string(),
});

/** What a watched subject is doing: sampled live, settled for good, or last sample failed. */
export const WATCH_STATES = ['live', 'settled', 'stale'] as const;
export const watchStateSchema = z.enum(WATCH_STATES);
export type WatchState = z.infer<typeof watchStateSchema>;

/**
 * The daemon's report on a watched subject's liveness, pushed to every
 * surface whenever it changes (a subject settling is news to all of them).
 */
/**
 * The daemon's own code on disk changed (or changed back) since it started:
 * pushed to every surface when the answer flips, so an open page learns of
 * an upgrade without reattaching.
 */
export const staleMessageSchema = z.object({
  type: z.literal('stale'),
  stale: z.boolean(),
});

/** The daemon's answer to `elevate`: granted, or why not (a wrong password; a session with no door to ask). */
export const elevatedMessageSchema = z.object({
  type: z.literal('elevated'),
  granted: z.boolean(),
  reason: z.string().optional(),
});

/** Why a daemon is going away, as it tells its surfaces before it does. */
export const CLOSING_CAUSES = ['restart', 'end', 'stop'] as const;

/**
 * The daemon is going away: sent to every surface just before it exits.
 * `restart` — a door restarts it and a fresh one follows; `end` — an
 * administrator ended it; `stop` — it was stopped, for no reason it was told.
 */
export const closingMessageSchema = z.object({
  type: z.literal('closing'),
  cause: z.enum(CLOSING_CAUSES),
});

/** Why the daemon is going away. */
export type ClosingCause = (typeof CLOSING_CAUSES)[number];

/** A pushed change in whether the daemon's own code still matches its disk. */
export type StaleMessage = z.infer<typeof staleMessageSchema>;

export const watchedMessageSchema = z.object({
  type: z.literal('watched'),
  subject: z.string(),
  state: watchStateSchema,
});
export type WatchedMessage = z.infer<typeof watchedMessageSchema>;

/**
 * Which listing the session's numbers currently count.
 *
 * A row can be named by the number beside it (`gather add @2,3`), and the
 * numbers belong to the session's most recent ANSWER. A surface has to know
 * WHICH listing that is, or it would light the index pills on a pane whose
 * rows are no longer the ones `@2` would reach — and pills that lie are
 * worse than no pills. Pushed to the surface whose line listed whenever its
 * answer changes: each surface keeps its own last answer.
 */
export const numberedMessageSchema = z.object({
  type: z.literal('numbered'),
  /** Rises with each answer, so a surface can tell newer from older. */
  id: z.number(),
  /** The line that produced the answer, which is how a pane recognises its own. */
  source: z.string(),
  /** How many rows are numbered. */
  rows: z.number(),
  /**
   * Each numbered row's handle beside its address.
   *
   * An index says what it counts — `@SER003`, `@STD001`, `@FIL012`,
   * `@DIR004` — one sequence per kind across the answer. A surface finds
   * each of its rows by address and draws the code, rather than counting
   * down the screen, so a sorted or filtered listing still shows each row
   * the handle that reaches it. Capped: a listing of thousands is numbered
   * in the kernel and simply unnumbered on screen.
   */
  handles: z.array(z.object({
    kind: z.string(),
    ordinal: z.number(),
    address: z.string(),
  })),
});
export type NumberedMessage = z.infer<typeof numberedMessageSchema>;

/**
 * An event the engine originates on its own — a sampler's refreshed model,
 * a watch changing state, the numbering moving to another listing — rather
 * than in answer to a command. The daemon relays it to every surface; it
 * never enters scrollback.
 */
export type AmbientEvent =
  // `origin` names the surface a line came from, when the envelope is for it
  // (a joblet's notice): an absent origin, or one no longer attached, is everyone's.
  | { kind: 'envelope'; envelope: z.infer<typeof commandEnvelopeSchema>; origin?: string }
  | { kind: 'watched'; subject: string; state: WatchState }
  // A joblet's progress, for the surface it came from: its views follow it
  // as they follow a line in front (a pull's badges).
  | { kind: 'progress'; origin: string; id: string; progress: ProgressEvent }
  // `origin` names the surface whose line listed: only it is told.
  | { kind: 'numbered'; origin: string; id: number; source: string; rows: number; handles: Array<{ kind: string; ordinal: number; address: string }> };

/** Any message a surface may send to the daemon. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  attachMessageSchema,
  executeMessageSchema,
  cancelMessageSchema,
  stopMessageSchema,
  elevateMessageSchema,
  completeRequestSchema,
  promptAnswerMessageSchema,
  promptErrorMessageSchema,
  pipeResultMessageSchema,
  pipeErrorMessageSchema,
  shellResultMessageSchema,
  shellErrorMessageSchema,
  editResultMessageSchema,
  editErrorMessageSchema,
  deliverResultMessageSchema,
  deliverErrorMessageSchema,
  regardMessageSchema,
  watchMessageSchema,
  unwatchMessageSchema,
  terminalOpenMessageSchema,
  terminalInputMessageSchema,
  terminalResizeMessageSchema,
  terminalCloseMessageSchema,
  surfaceLineResultMessageSchema,
  surfaceLineErrorMessageSchema,
  noteMessageSchema,
  surfaceClaimsMessageSchema,
]);

/** A message a surface sends to the daemon. */
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// --- Daemon → surface ------------------------------------------------------

/**
 * Acknowledges a successful attach. The optional `stack` block reports the
 * daemon's own installed versions and build hash, so a remote surface can
 * greet with the truth of the process it attached to rather than whatever is
 * installed client-side; older daemons simply omit it.
 */
export const attachedMessageSchema = z.object({
  type: z.literal('attached'),
  session: z.string(),
  /** This surface's own id on the daemon; absent from older daemons. */
  surface: z.string().optional(),
  /**
   * The session's backend (`chris`, `null`): which composition a surface
   * draws. Absent from older daemons, which are all ChRIS.
   */
  backend: z.string().optional(),
  protocolVersion: z.number().int(),
  stack: z
    .object({
      chell: z.string(),
      calypso: z.string(),
      build: z.string(),
      /** The web bundle's build stamp as it stood when the daemon started. */
      surface: z.object({ git: z.string(), built: z.string() }).optional(),
      brasa: z.string().optional(),
      chili: z.string().optional(),
      salsa: z.string().optional(),
      cumin: z.string().optional(),
    })
    .optional(),
  /** The host-control tiers the daemon declared (`shell`, `files`, `pipes`); empty or absent when off. */
  hostControl: z.array(z.string()).optional(),
  /** Whether the daemon's own code on disk has moved on since it started; absent from older daemons. */
  stale: z.boolean().optional(),
  /** Whether this session can be raised to MANAGE with the person's password (`elevate`); absent from daemons without a door. */
  elevation: z.boolean().optional(),
  /** Whether the daemon offers terminals (`terminalOpen`); absent from older daemons, which do not. */
  terminals: z.boolean().optional(),
});

/** The final result of one executed line: one envelope per command. */
export const resultMessageSchema = z.object({
  type: z.literal('result'),
  id: z.string(),
  envelopes: z.array(commandEnvelopeSchema),
});

/** The reply to a completion request. */
export const completeReplySchema = z.object({
  type: z.literal('complete'),
  id: z.string(),
  prefix: z.string(),
  candidates: z.array(z.string()),
});

/**
 * A typed event from the executing command to its origin surface, correlated
 * to the command.
 *
 * Output is text and progress is a fixed vocabulary; an event is whatever a
 * command has to show while it runs, named by a kind the surface may know
 * (`games.trek.state`) and shaped by that kind. A surface that does not know
 * the kind drops it. Like output, an event is live only: nothing retains it.
 */
export const eventMessageSchema = z.object({
  type: z.literal('event'),
  id: z.string(),
  kind: z.string(),
  data: z.unknown(),
});

/** A typed event as it appears on the wire, correlated to its command. */
export type EventMessage = z.infer<typeof eventMessageSchema>;

/** A streamed output event on one channel, correlated to its command. */
export const outputMessageSchema = z.object({
  type: z.literal('output'),
  id: z.string(),
  channel: channelSchema,
  chunk: z.string(),
});

/**
 * The operation producing structured progress.
 *
 * Within a major, the contract promises additive change only, which is a
 * promise a bare enum cannot keep: an unknown value fails the whole message,
 * and a failed parse drops it. An operation a peer names but this build does
 * not know is therefore read as `task` — none of the above — so the work still
 * shows, generically, instead of vanishing.
 */
export const progressOperationSchema = z.enum(PROGRESS_OPERATIONS).catch('task');

/**
 * Broad class of progress producer.
 *
 * Optional, so an unknown class degrades to absent: the event still renders
 * from its operation and phase, one axis poorer.
 */
export const progressKindSchema = z.enum(PROGRESS_KINDS).catch(undefined as never);

/**
 * Lifecycle phase of a progress operation.
 *
 * An unknown phase degrades to `working` for the reason given on
 * {@link progressOperationSchema}: an unrecognised phase still means work is
 * under way, and that much is worth showing. `complete` and `failed` are
 * terminal and will not be inferred, so a surface that cannot read a newer
 * peer's terminal phase leaves the announcement open rather than closing it
 * wrongly.
 */
export const progressPhaseSchema = z.enum(PROGRESS_PHASES).catch('working');

/**
 * Unit used by the primary progress counter.
 *
 * Optional, so an unknown unit degrades to absent and the counter renders
 * unqualified — 3/10 rather than nothing at all.
 */
export const progressUnitSchema = z.enum(PROGRESS_UNITS).catch(undefined as never);

/**
 * State of the operation or item being reported.
 *
 * An unknown state degrades to `unknown`, which the vocabulary already carries
 * for precisely this: a state that cannot be named is still a state.
 */
export const progressStatusSchema = z.enum(PROGRESS_STATUSES).catch('unknown');

/** A structured progress event correlated to a command. */
export const progressMessageSchema = z.object({
  type: z.literal('progress'),
  id: z.string(),
  operation: progressOperationSchema,
  kind: progressKindSchema.optional(),
  phase: progressPhaseSchema,
  label: z.string().optional(),
  itemId: z.string().optional(),
  current: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  percent: z.number().min(0).max(100).optional(),
  unit: progressUnitSchema.optional(),
  status: progressStatusSchema.optional(),
  /**
   * Where the item landed, when the kernel can name it.
   *
   * A retrieve is confirmed by count and filed by CUBE a beat later, so the
   * message that says a series is home may not yet know where. This is the
   * one that does: a surface offering a verb on the landed thing (IMAGE on a
   * PACS row) needs the place, and only the kernel can say it.
   */
  path: z.string().optional(),
  /**
   * Why an item ended badly, in words a surface can show: an ERROR that
   * cannot say why reads as a mystery and is answered by pulling again.
   */
  reason: z.string().optional(),
});

/** A progress event as it appears on the wire, correlated to its command. */
export type ProgressMessage = z.infer<typeof progressMessageSchema>;

/** The progress payload before command correlation is added by the daemon. */
export type ProgressEvent = Omit<ProgressMessage, 'type' | 'id'>;

/** A session-bus broadcast: an envelope tagged with its originating surface. */
export const sessionMessageSchema = z.object({
  type: z.literal('session'),
  surface: z.string(),
  envelope: commandEnvelopeSchema,
  /** The terminal the command was typed in, when its surface was a browser's terminal: that browser treats it as its own console's. */
  terminal: z.string().optional(),
});

/** A boundary error: a refused attach, a malformed message, correlated when possible. */
export const errorMessageSchema = z.object({
  type: z.literal('error'),
  id: z.string().optional(),
  reason: z.string(),
});

/**
 * What a question is asking FOR.
 *
 * A surface chooses its instrument from this rather than by reading the
 * wording: a location wants a browser to walk, a secret wants a masked
 * field, a yes/no wants two capsules. Open-world, degrading to `text` —
 * every surface can answer text, so a kind from a newer daemon leaves the
 * question answerable rather than refused.
 */
export const PROMPT_KINDS = ['text', 'secret', 'confirm', 'path'] as const;

export const promptKindSchema = z.enum(PROMPT_KINDS).catch('text');

/**
 * What a location ask needs beyond its wording.
 *
 * @property anchor - Where browsing starts. A fact the kernel knows (the
 *   session's own cwd), never a directory invented for the occasion.
 * @property wantsDirectory - True when a directory is the answer; false
 *   when a file is, in which case `suggest` names it.
 * @property suggest - A basename to offer, so committing on a directory
 *   composes a complete path and renaming is one gesture rather than
 *   typing the whole thing.
 */
export const promptPathSchema = z.object({
  anchor: z.string().optional(),
  wantsDirectory: z.boolean(),
  suggest: z.string().optional(),
});

/**
 * A prompt request the daemon raises during a command: the surface that
 * submitted the command must answer it (with `promptAnswer`) before the
 * command can proceed. `hidden` requests no-echo entry (password).
 *
 * `wants`, `path` and `commit` are optional so a daemon or a surface that
 * predates typed asks still parses this message and still answers it —
 * such a daemon could only ever have meant `text`, or `secret` when it set
 * `hidden`.
 */
export const promptMessageSchema = z.object({
  type: z.literal('prompt'),
  promptId: z.string(),
  message: z.string(),
  hidden: z.boolean(),
  /** What kind of value answers this. Absent means text, or secret when hidden. */
  wants: promptKindSchema.optional(),
  /** Present when `wants` is `path`: where to start, and what to compose. */
  path: promptPathSchema.optional(),
  /**
   * The word the committing control should read — `EXPORT HERE`, `UPLOAD
   * HERE`. A control reads as what it will do next; a prompt that supplies
   * none leaves the surface to say `USE THIS`.
   */
  commit: z.string().optional(),
});

export type PromptKind = z.infer<typeof promptKindSchema>;
export type PromptPath = z.infer<typeof promptPathSchema>;
export type PromptMessage = z.infer<typeof promptMessageSchema>;

/**
 * The kind a prompt is asking for, derived once for every surface.
 *
 * `hidden` predates `wants` and remains the older wire's only way to say
 * "secret", so the two are reconciled here rather than in each surface —
 * two readings of one message is how a terminal and a browser end up
 * masking different things.
 *
 * @param prompt - The prompt as it arrived.
 * @returns The kind of value that answers it.
 */
export function promptKind_derive(prompt: {
  hidden?: boolean;
  wants?: PromptKind;
}): PromptKind {
  if (prompt.wants !== undefined) return prompt.wants;
  return prompt.hidden === true ? 'secret' : 'text';
}

/**
 * The engine-known facts a prompt reflects, independent of any theme.
 *
 * The daemon knows the session context but not how a given surface renders it,
 * so it ships these facts and each surface themes them with its own settings.
 * Rendering inputs a surface owns (theme, segments, terminal width) are not
 * carried here.
 */
/**
 * The tones a prompt segment may wear. A backend says what a segment is for;
 * each surface maps a tone to its own palette, so no colour crosses the wire.
 */
export const PROMPT_SEGMENT_TONES = ['leader', 'place', 'identity', 'path', 'work', 'note', 'alert'] as const;

export type PromptSegmentTone = typeof PROMPT_SEGMENT_TONES[number];

/**
 * One backend-neutral prompt segment (docs/stratus.adoc, D9): a key the
 * surface may recognise for a glyph, a label for a reader who meets the key
 * cold, the value, and a tone. A backend fills them in display order and a
 * surface draws them in that order; a surface older than the field ignores
 * them and draws the ChRIS-shaped fields it knows.
 */
export const promptSegmentSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  tone: z.enum(PROMPT_SEGMENT_TONES),
});

export type PromptSegment = z.infer<typeof promptSegmentSchema>;

export const promptContextSchema = z.object({
  user: z.string(),
  uri: z.string(),
  cwd: z.string(),
  pacsserver: z.string().nullable(),
  physicalMode: z.boolean(),
  lastExitCode: z.number(),
  lastCommandDurationMs: z.number(),
  procWarmup: z.object({
    loaded: z.number(),
    total: z.number().optional(),
    restored: z.boolean().optional(),
    state: z.enum(PROC_PROMPT_STATES).optional(),
    sweeping: z.boolean().optional(),
    feed: z.object({
      id: z.number(),
      loaded: z.number(),
      total: z.number(),
      failed: z.string().optional(),
    }).optional(),
    feeds: z.array(z.object({
      id: z.number(),
      loaded: z.number(),
      total: z.number(),
      failed: z.string().optional(),
    })).optional(),
    arrived: z.array(z.number()).optional(),
    landed: z.array(z.object({
      id: z.number(),
      title: z.string().default(''),
      jobs: z.number(),
      status: z.string(),
      chain: z.array(z.string()),
      groups: z.array(z.object({ plugin: z.string(), count: z.number(), errored: z.number().default(0), status: z.string(), parent: z.number().nullable() })).default([]),
    })).optional(),
    roster: z.enum(['delta', 'full']).optional(),
  }).optional(),
  procIndex: z.object({
    jobs: z.number(),
    feeds: z.number(),
  }).optional(),
  /**
   * Warm-up steps that failed behind the prompt and have not since
   * succeeded. Optional, so an older daemon still parses here.
   */
  warmupFailures: z.array(z.object({
    label: z.string(),
    message: z.string(),
  })).optional(),
  /** How many questions are open in the session, on any surface. Optional, so an older daemon still parses here. */
  questions: z.number().optional(),
  /**
   * Backend-neutral segments a surface draws in order, when a backend sends
   * them; absent from a ChRIS daemon, whose prompt is the named fields above.
   */
  segments: z.array(promptSegmentSchema).optional(),
});

export type PromptContext = z.infer<typeof promptContextSchema>;

/**
 * The prompt context, pushed by the daemon with each result and on any context
 * change. The daemon knows the session context; each surface renders it with
 * its own theme, so prompt themes are a per-surface choice rather than the
 * daemon's.
 */
export const promptLineMessageSchema = z.object({
  type: z.literal('promptline'),
  context: promptContextSchema,
});

/**
 * Asks the surface to run a pipeline segment on its own machine (never on the
 * daemon host) and return the output. `input` and the reply's `output` are
 * base64, since segment data is arbitrary bytes.
 */
export const pipeMessageSchema = z.object({
  type: z.literal('pipe'),
  pipeId: z.string(),
  command: z.string(),
  input: z.string(),
});

/** Asks the surface to run a shell command on its own machine, never on the daemon host. */
export const shellMessageSchema = z.object({
  type: z.literal('shell'),
  shellId: z.string(),
  command: z.string(),
});

/**
 * Asks the surface to open content in its local editor (never on the daemon
 * host) and return the edited result.
 */
export const editMessageSchema = z.object({
  type: z.literal('edit'),
  editId: z.string(),
  content: z.string(),
  extension: z.string().optional(),
  /** The file being edited, so an editor that stays open knows where its saves go. */
  path: z.string().optional(),
});

/**
 * Asks the surface running the current command to place a file where its
 * operator can reach it.
 *
 * The message names what to deliver, never the bytes. A surface fetches those
 * itself from the daemon's token-gated byte route, so a large file does not
 * cross the session bus base64-encoded — the intent travels through the
 * vocabulary and the bytes travel through the byte route.
 */
export const deliverMessageSchema = z.object({
  type: z.literal('deliver'),
  deliverId: z.string(),
  path: z.string(),
  filename: z.string(),
  destination: z.string().optional(),
  size: z.number().nonnegative().optional(),
  contentType: z.string().optional(),
});

/** What to deliver, before the daemon adds the correlation id. */
export type FileDeliverRequest = Omit<z.infer<typeof deliverMessageSchema>, 'type' | 'deliverId'>;

/** Where a delivered file landed, as the surface reports it. */
export type FileDeliverResult = Omit<
  z.infer<typeof deliverResultMessageSchema>,
  'type' | 'deliverId'
>;

/**
 * The daemon's heartbeat, pushed roughly once a second while any surface is
 * attached: the live process-index counts. Event-driven facts (progress,
 * command latency) travel on their own messages; this carries only what
 * changes without a command.
 */
export const telemetryMessageSchema = z.object({
  type: z.literal('telemetry'),
  index: z.object({
    jobs: z.number(),
    feeds: z.number(),
  }),
  /** The serialized lane: the command holding it and how many wait behind it. Absent on older daemons. */
  lane: z.object({
    running: z.object({
      line: z.string(),
      sinceMs: z.number(),
      surface: z.string(),
    }).nullable(),
    waiting: z.number(),
    /**
     * The questions open now: which surface asked, what, and for how long. A
     * command waiting on one has stepped out of the lane. Absent on older daemons.
     */
    questions: z.array(z.object({ surface: z.string(), message: z.string(), sinceMs: z.number() })).optional(),
    /** The joblets running (`line &`): what a restart would end. Absent on older daemons. */
    joblets: z.array(z.object({ number: z.number(), line: z.string(), waiting: z.boolean() })).optional(),
  }).optional(),
  /** Every surface attached now, by id: a terminal (`chell`) or a `browser`. Absent on older daemons. */
  surfaces: z.array(z.object({ id: z.string(), kind: z.enum(['chell', 'browser']) })).optional(),
  /** CUBE's pace: the median page fetch over the last twenty, or absent before any was timed. */
  cube: z.object({
    msPerPage: z.number(),
    samples: z.number(),
  }).optional(),
  /** The lab's pulse from the roster's counters: jobs running and waiting, and the feeds that errored. */
  state: z.object({
    running: z.number(),
    runningFeeds: z.number(),
    scheduled: z.number(),
    errored: z.number(),
    erroredFeeds: z.number(),
  }).optional(),
});

/** What a telemetry heartbeat says about the lane. */
export type LaneTelemetry = z.infer<typeof telemetryMessageSchema>['lane'];
/** What a telemetry heartbeat says about CUBE's pace. */
export type CubeTelemetry = z.infer<typeof telemetryMessageSchema>['cube'];
/** What a telemetry heartbeat says about the lab's pulse. */
export type JobsStateTelemetry = z.infer<typeof telemetryMessageSchema>['state'];

/**
 * A terminal is open: its id, kept by the viewer to reattach, and the recent
 * output to draw before anything new (empty for a new terminal). `refused`
 * instead says why none could be opened (the daemon offers no terminals).
 */
export const terminalOpenedMessageSchema = z.object({
  type: z.literal('terminalOpened'),
  terminalId: z.string(),
  replay: z.string(),
  refused: z.string().optional(),
});

/** Output a terminal's program wrote, raw (escape sequences and all). */
export const terminalDataMessageSchema = z.object({
  type: z.literal('terminalData'),
  terminalId: z.string(),
  data: z.string(),
});

/** A terminal's program has exited; the terminal is gone. */
export const terminalExitMessageSchema = z.object({
  type: z.literal('terminalExit'),
  terminalId: z.string(),
  code: z.number().int(),
});

/**
 * A line typed in a chell whose subject this surface claims: run it in the
 * surface's own language and answer with `surfaceLineResult`. `terminal` names
 * the terminal it was typed in, when it was one of this surface's.
 */
export const surfaceLineMessageSchema = z.object({
  type: z.literal('surfaceLine'),
  lineId: z.string(),
  line: z.string(),
  terminal: z.string().optional(),
});

/** A note for this console, from the browser it belongs to: printed above the line being typed. */
export const consoleNoteMessageSchema = z.object({
  type: z.literal('consoleNote'),
  text: z.string(),
});

/** Any message the daemon may send to a surface. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  attachedMessageSchema,
  elevatedMessageSchema,
  resultMessageSchema,
  completeReplySchema,
  outputMessageSchema,
  progressMessageSchema,
  eventMessageSchema,
  sessionMessageSchema,
  errorMessageSchema,
  promptMessageSchema,
  promptLineMessageSchema,
  telemetryMessageSchema,
  pipeMessageSchema,
  shellMessageSchema,
  editMessageSchema,
  deliverMessageSchema,
  regardMessageSchema,
  watchedMessageSchema,
  staleMessageSchema,
  closingMessageSchema,
  numberedMessageSchema,
  terminalOpenedMessageSchema,
  terminalDataMessageSchema,
  terminalExitMessageSchema,
  surfaceLineMessageSchema,
  consoleNoteMessageSchema,
]);

/** A message the daemon sends to a surface. */
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * The message types this contract build knows. A surface receiving a typed
 * message outside this set is talking to a newer daemon: the open-world rule
 * is to skip it quietly, not to warn on every arrival.
 */
export const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  serverMessageSchema.options.map((option): string => option.shape.type.value),
);
