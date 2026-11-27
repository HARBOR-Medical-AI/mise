/**
 * @file The PACS query vocabulary: search results as typed envelope payloads.
 *
 * A `pacs query` answers with studies containing series; the terminal renders
 * them as text while a graphical surface reads this model — the same
 * one-command-two-projections pattern as the DAG models. Series carry their
 * instance UIDs so a surface can lower a selection straight to
 * `pacs pull SeriesInstanceUID:<uid>`.
 *
 * @module
 */
import { z } from 'zod';

/** One series within a found study. */
export const pacsSeriesSchema = z.object({
  seriesUID: z.string(),
  description: z.string(),
  modality: z.string(),
  fileCount: z.number().optional(),
  /** The series' own VFS path under the query — the pull's argument. */
  vfsPath: z.string().optional(),
  /** True when CUBE already holds this series (a pull would just confirm). */
  pulled: z.boolean().optional(),
  /** How many files CUBE holds, when known. */
  pulledFiles: z.number().optional(),
  /** The folder CUBE keeps the pulled series in, when known: what an image pane opens. */
  folderPath: z.string().optional(),
});

/** One found study and its series. */
export const pacsStudySchema = z.object({
  studyUID: z.string().optional(),
  /**
   * The PACS that answered for this study, as its canonical identifier.
   *
   * Present when the answer could have come from more than one server —
   * which is when it matters, because two servers may hold the same study
   * and a row that cannot say which one it came from cannot be acted on.
   */
  server: z.string().optional(),
  /** The study's VFS path under the query — a study-level pull's argument. */
  vfsPath: z.string().optional(),
  description: z.string(),
  patientName: z.string(),
  patientId: z.string(),
  date: z.string(),
  modalities: z.string(),
  accession: z.string(),
  series: z.array(pacsSeriesSchema),
});

/**
 * Where an answer came from: the PACS just now, or a query already stored.
 *
 * CUBE keeps every query it has run, so a question asked before can be
 * answered without troubling the PACS. Which of the two happened is a fact
 * about the answer, and it belongs on the model rather than in each
 * surface's rendering: chell says it in a sentence, argus in a pill, and
 * anything later in whatever voice it has — but all of them from one
 * timestamp, said once by the kernel that knows it.
 */
export const pacsProvenanceSchema = z.object({
  /** True when this answer came from a stored query rather than the PACS. */
  replayed: z.boolean(),
  /**
   * When the PACS actually answered, as an ISO timestamp.
   *
   * The age is stated and never acted on. A query naming an accession is a
   * fact about a study that exists; one naming an MRN can gain a match
   * tomorrow. No heuristic separates those reliably, so the surface says
   * how old an answer is and leaves the judgement with the operator.
   */
  answeredAt: z.string(),
});


/**
 * What became of one patient in a query.
 *
 * Three states, not two. A query that could not be asked is not a query
 * that found nothing: rendering a timeout as `0` is exactly the confident
 * stale answer the replay work exists to refuse. The MRNs that come back
 * are by definition the ones WITH imaging, which makes the answer an
 * operator usually wants — the ones without — the invisible half unless
 * absence is a state the model can say.
 */
export const PACS_PATIENT_STATUSES = ['found', 'none', 'unasked'] as const;

/**
 * Open-world, degrading to `unasked`.
 *
 * A status this contract does not know is one this surface cannot claim an
 * answer for, and `unasked` is the only degrade that never reads as a
 * confident zero.
 */
export const pacsPatientStatusSchema = z.enum(PACS_PATIENT_STATUSES).catch('unasked');

/**
 * One patient the query asked about — found, empty-handed, or unreachable.
 *
 * The studies themselves stay where they are, on the model, each carrying
 * its own `patientId`. This level is not a container for them; it is the
 * record of what was ASKED, which is why it exists at all: a miss owns no
 * study, so a level derived from the studies could never mention it.
 */
export const pacsPatientSchema = z.object({
  /** The identifier as the operator asked it, never normalized. */
  patientId: z.string(),
  /**
   * The PACS this row asked. One patient asked of two servers is two rows,
   * because the answers are two facts and one of them may be a miss.
   */
  server: z.string().optional(),
  /** The name the PACS answered with, when it answered at all. */
  patientName: z.string().optional(),
  status: pacsPatientStatusSchema,
  /** How many studies this patient owns in the answer; 0 for a miss. */
  studyCount: z.number(),
  /** How many series across those studies; 0 for a miss. */
  seriesCount: z.number(),
  /**
   * The CUBE query that answered for this patient. A cohort is N queries,
   * so the id belongs per row rather than on the model.
   */
  queryId: z.number().optional(),
  /**
   * Where this row's answer came from. A fan-out replays some rows and
   * troubles the PACS for others, so provenance is per patient as well as
   * per answer.
   */
  provenance: pacsProvenanceSchema.optional(),
  /**
   * Why a patient went unasked, when something said why.
   *
   * Carried so a surface can name the failure rather than showing an
   * unexplained dash; never set for `found` or `none`, where there is
   * nothing to explain.
   */
  error: z.string().optional(),
});

/**
 * The `pacs.query` model: one query's decoded result. `vfsPath` is where the
 * query lives under `/net/pacs/queries` — a query is a persistent CUBE
 * object, re-checkable later.
 */
export const pacsQueryModelSchema = z.object({
  queryId: z.number(),
  vfsPath: z.string(),
  pacsName: z.string(),
  expression: z.string(),
  studies: z.array(pacsStudySchema),
  /**
   * Optional so an envelope from a daemon that predates replay still
   * parses: a surface reads its absence as "freshly queried, age unknown",
   * which is what such a daemon could only ever have meant.
   */
  provenance: pacsProvenanceSchema.optional(),
  /**
   * Where the answer's table was written, when the query was asked to
   * write one (`--csv-to`): the file's path in the store. Absent when
   * nothing was written. A surface reads this, never the words printed.
   */
  written: z.string().optional(),
  /**
   * Every patient the query asked about, hits and misses alike.
   *
   * Optional, like `provenance`: an envelope from a daemon that predates
   * the fan-out still parses, and a surface reads its absence as the
   * single-question case it could only have been.
   */
  patients: z.array(pacsPatientSchema).optional(),
});

export type PacsProvenance = z.infer<typeof pacsProvenanceSchema>;
export type PacsPatientStatus = z.infer<typeof pacsPatientStatusSchema>;
export type PacsPatient = z.infer<typeof pacsPatientSchema>;
export type PacsSeries = z.infer<typeof pacsSeriesSchema>;
export type PacsStudy = z.infer<typeof pacsStudySchema>;
export type PacsQueryModel = z.infer<typeof pacsQueryModelSchema>;


/**
 * One registered PACS server, as a surface needs it.
 *
 * The identifier is what CUBE files a query under and what `--pacsserver`
 * names, so it is the value a control lowers to; the numeric id is what
 * `pacs connect` has always accepted and is kept for that. Liveness is NOT
 * carried: CUBE registers servers, it does not test them, and a field that
 * looked like health would be a claim nobody checked.
 */
export const pacsServerSchema = z.object({
  id: z.number(),
  identifier: z.string(),
  /** True for the server this session is currently connected to. */
  active: z.boolean(),
});

/**
 * The `pacs.servers` model: every PACS registered on this CUBE.
 *
 * A surface offering a choice of servers has to know what there is to
 * choose from, and asking CUBE directly would reach around the session
 * that owns the connection. `pacs list` already asks; it now says so in
 * data as well as in text.
 */
export const pacsServersModelSchema = z.object({
  servers: z.array(pacsServerSchema),
});

export type PacsServer = z.infer<typeof pacsServerSchema>;
export type PacsServersModel = z.infer<typeof pacsServersModelSchema>;

/** The servers model's envelope kind. */
export const PACS_SERVERS_MODEL_KIND = 'pacs.servers' as const;

/** The model's envelope kind. */
export const PACS_QUERY_MODEL_KIND = 'pacs.query' as const;

/**
 * The address a patient row answers to: what a surface matches a numbered
 * handle on, and what the kernel puts on a `PAT` row. A patient has no
 * path of its own — its series do — so the address is minted from what
 * names it in the answer: the identifier as asked, and the PACS asked.
 *
 * @param patient - The patient, as the answer carries it.
 * @returns A stable string no path could be.
 */
export function patientAddress_format(patient: { patientId: string; server?: string | undefined }): string {
  return `pacs:patient:${patient.server ?? '-'}:${patient.patientId}`;
}
