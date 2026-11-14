/**
 * @file Builtin query command.
 *
 * Creates a PACS query, polls until the result is populated, displays the found
 * studies/series, and prints the VFS path for downstream `pull` or `cd` use.
 *
 * Also exports `pacsQuery_createAndWait` for reuse by `builtin_pull`.
 *
 * @module
 */

import chalk from 'chalk';
import { chrisContext, Context, pacsQuery_get, pacsQuery_resultDecode, pacsQueries_create, pacsServers_list, PACSQueryCreateData, PACSQueryDecodedResult, PACSQueryRecord, listCache_get, queryIndex_get, seriesStorage_resolveMany, type SeriesStorageFilter } from '@fnndsc/cumin';
import { queryFolderName_build, answer_standIn, criteria_standIn } from '@fnndsc/salsa';
import { PACS_QUERY_MODEL_KIND, type PacsPatient, type PacsProvenance, type PacsQueryModel, type PacsStudy, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import {
  PATIENT_KEY,
  QUERY_COHORT_MAX,
  QUERY_INLINE_FANOUT_MAX,
  fanout_permit,
  patients_read,
  queryTerms_expand,
  queryTerms_parse,
} from './query.fanout.js';
import { sink_get } from '../../core/sink.js';
import { pacsQueryModel_build } from './query.model.js';
import { pacsAnswer_render } from './query.view.js';
import { ignoredKeys_hint } from './query.ignored.js';
import { csvFile_write, pacsAnswer_renderCsv, pacsAnswer_renderTable, type CsvWrite, type PacsAnswerLevel } from './query.csv.js';
import { series_cubePathGet } from './pacsUtils.js';
import { screen } from '@fnndsc/chili/screen/screen.js';
import { spinner } from '../../lib/spinner.js';
import { pacsRefusal_hint, pacsRefusal_is } from './pacsAccess.js';
import { QUERY_GRAMMAR, type QueryLine } from './query.args.js';
import { command_declare } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';

const QUERY_POLL_INTERVAL_MS: number = 2_000;
const QUERY_TIMEOUT_MS: number = 60_000;

/**
 * Result of a successful query-create-and-wait operation.
 *
 * @property queryId - ID of the created PACSQuery.
 * @property vfsPath - Full `/net/pacs/queries/<id>_<desc>` path.
 * @property decoded - Decoded query result payload.
 */
export interface QueryCreateResult {
  queryId: number;
  vfsPath: string;
  decoded: PACSQueryDecodedResult;
}

/**
 * Parses a comma-separated `Key:Value[,Key:Value]` expression into an object.
 * Falls back to JSON parse if the string starts with `{`.
 *
 * @param expr - Query expression string.
 * @returns Parsed key-value record, or null if invalid.
 */
export function queryExpr_parse(expr: string): Record<string, string> | null {
  if (expr.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(expr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // fall through
    }
    return null;
  }

  const result: Record<string, string> = {};
  for (const part of expr.split(',')) {
    const colonIdx: number = part.indexOf(':');
    if (colonIdx < 1) return null;
    const key: string = part.slice(0, colonIdx).trim();
    const value: string = part.slice(colonIdx + 1).trim();
    if (!key || !value) return null;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Builds the VFS path for a query via the provider's one naming authority,
 * so the path handed back after `query` is the path `ls` will show once the
 * query has results.
 *
 * @param queryId - The numeric query ID.
 * @param queryObj - The parsed query key-value pairs.
 * @param username - Optional username to embed in the folder name.
 * @returns Absolute VFS path string.
 */
export function queryVfsPath_build(queryId: number, queryObj: Record<string, string>, username?: string): string {
  return `/net/pacs/queries/${queryFolderName_build({ queryId, queryObj, username, hasResult: true })}`;
}

/**
 * Creates a PACS query and blocks until the result is populated or timeout.
 *
 * @param queryExpr - Comma-separated `Key:Value` string or JSON object string.
 * @param title - Title for the new PACSQuery record.
 * @param pacsserver - PACS server ID or identifier string.
 * @param onStatus - Optional callback called each poll tick with a status message.
 * @returns QueryCreateResult on success, or null on failure/timeout.
 */
export async function pacsQuery_createAndWait(
  queryExpr: string,
  title: string,
  pacsserver: string,
  onStatus?: (msg: string) => void,
): Promise<QueryCreateResult | null> {
  const queryObj: Record<string, string> | null = queryExpr_parse(queryExpr);
  if (!queryObj) {
    errorStack.stack_push('error', `query: Invalid expression: "${queryExpr}". Use Key:Value or JSON.`);
    return null;
  }

  const payload: PACSQueryCreateData = {
    title,
    query: JSON.stringify(queryObj),
  };

  const createResult = await pacsQueries_create(pacsserver, payload);
  if (!createResult.ok) {
    return null;
  }

  // A new query changes the /net/pacs/queries listing; drop any cached copy
  // so an immediate `ls` shows the query instead of a stale directory.
  listCache_get().cache_invalidate('/net/pacs/queries');

  const queryId: number = createResult.value.id;
  // CUBE does not always name the owner on the create response, and the
  // index is keyed by it — a query filed under nobody is a query the next
  // identical ask cannot find. The session's own identity is the fallback,
  // since it is who just asked.
  const ownerUsername: string | undefined =
    (typeof createResult.value.owner_username === 'string' ? createResult.value.owner_username : undefined)
    ?? (await askingIdentity_get()) ?? undefined;
  const vfsPath: string = queryVfsPath_build(queryId, queryObj, ownerUsername);
  const deadline: number = Date.now() + QUERY_TIMEOUT_MS;

  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  let succeededWithoutPayload: number = 0;

  while (Date.now() < deadline) {
    const statusResult = await pacsQuery_get(queryId);
    const status: string = statusResult.ok ? (statusResult.value.status ?? 'pending') : 'pending';
    onStatus?.(`Query ${queryId} — ${status}`);

    const decodeResult = await pacsQuery_resultDecode(queryId);
    if (decodeResult.ok && decodeResult.value.json !== undefined) {
      queryIndex_file(queryId, queryObj, await pacsIdentifier_resolve(pacsserver), ownerUsername, true);
      return { queryId, vfsPath, decoded: decodeResult.value };
    }
    if (!decodeResult.ok) {
      // A missing payload is the expected state while polling; drop the
      // error the probe pushed so the stack doesn't fill with one copy
      // per poll tick.
      errorStack.stack_pop();
    }

    // A succeeded query with no stored payload means the PACS matched
    // nothing; a couple of grace polls cover result-write lag.
    if (status === 'succeeded' && ++succeededWithoutPayload >= 2) {
      // Filed as a no-hit. A replay must know this question was asked and
      // found nothing, so it can decline to serve the emptiness back.
      queryIndex_file(queryId, queryObj, await pacsIdentifier_resolve(pacsserver), ownerUsername, false);
      return { queryId, vfsPath, decoded: { raw: '' } };
    }

    await sleep(QUERY_POLL_INTERVAL_MS);
  }

  errorStack.stack_push('error', `query: Timed out waiting for query ${queryId} result.`);
  return null;
}

/**
 * Files a finished query in the replay index.
 *
 * Every query mise runs indexes itself, so the next identical question is
 * answered without waiting for the background sweep to have walked this far
 * back. The server is recorded because the same criteria asked of a
 * different PACS is a different question.
 *
 * @param queryId - The stored query's id.
 * @param criteria - The criteria as asked.
 * @param server - The PACS identifier it was asked of.
 * @param owner - Who asked, when CUBE said.
 * @param hasResult - Whether it found anything.
 */
function queryIndex_file(
  queryId: number,
  criteria: Record<string, string>,
  server: string,
  owner: string | undefined,
  hasResult: boolean,
): void {
  queryIndex_get().entry_note({
    queryId,
    server,
    criteria,
    owner: owner ?? '',
    answeredAt: new Date().toISOString(),
    hasResult,
  });
}

// The answer's model is built in its own module, so a verb that reads one
// answer (`gather add`) loads the projection without the whole query verb.
export { pacsQueryModel_build };

/**
 * What to ask CUBE, for an answer's held state.
 *
 * One filter per STUDY, which is the shape that matters: asking per series
 * costs two round trips each and a patient's history runs to hundreds,
 * while studies are counted in tens. A study the answer does not name is
 * left out, and its series are asked about one at a time instead.
 *
 * @param model - The answer.
 * @returns One filter per named study, in the answer's order.
 */
export function pulledFilters_build(model: PacsQueryModel): SeriesStorageFilter[] {
  return model.studies
    .filter((study): boolean => typeof study.studyUID === 'string' && study.studyUID !== '')
    .map((study): SeriesStorageFilter => ({ StudyInstanceUID: study.studyUID as string }));
}

/** How many already-in-CUBE checks run at once, on the per-series path. */
const PULLED_CHECK_CONCURRENCY: number = 4;

/**
 * Fills each series' `pulled` state by asking CUBE what it already holds.
 *
 * Asked by STUDY, not by series. The obvious shape — ask about each series
 * in turn — costs two round trips per series, and a patient's history runs
 * to hundreds: reconciling one stored answer of 299 series took twenty
 * seconds against a live CUBE, which is why a replayed query felt exactly
 * like a fresh one. CUBE indexes a stored series by its study, so the same
 * reconciliation is one page per study, and a study count is small.
 *
 * A study whose UID the answer does not carry falls back to asking about
 * its series one at a time, since a study that cannot be named in bulk is
 * still owed an answer.
 *
 * @param model - The query model to annotate in place.
 */
async function modelPulledState_fill(model: PacsQueryModel): Promise<void> {
  const named = model.studies.filter((study): boolean => typeof study.studyUID === 'string' && study.studyUID !== '');
  const unnamed = model.studies.filter((study): boolean => !(typeof study.studyUID === 'string' && study.studyUID !== ''));

  if (named.length > 0) {
    const held = await seriesStorage_resolveMany(pulledFilters_build(model));
    if (held.ok) {
      for (const study of named) {
        for (const series of study.series) {
          const state = series.seriesUID === undefined ? undefined : held.value.get(series.seriesUID);
          if (state === undefined || state.folderPath === null) continue;
          series.pulled = true;
          series.pulledFiles = state.fileCount;
          // Where the series landed, so a surface can open it as an image.
          series.folderPath = state.folderPath;
        }
      }
    } else {
      // CUBE would not answer in bulk. Ask the old way rather than report a
      // whole answer as unheld, which would offer PULL for series already in.
      await seriesPulledState_fillOneByOne(named.flatMap((study) => study.series));
    }
  }

  if (unnamed.length > 0) await seriesPulledState_fillOneByOne(unnamed.flatMap((study) => study.series));
}

/**
 * The per-series fallback: one lookup each, a few at a time.
 *
 * An unreachable check leaves the flag unset rather than guessing.
 *
 * @param allSeries - The series to ask about.
 */
async function seriesPulledState_fillOneByOne(allSeries: PacsQueryModel['studies'][number]['series']): Promise<void> {
  for (let start: number = 0; start < allSeries.length; start += PULLED_CHECK_CONCURRENCY) {
    const batch = allSeries.slice(start, start + PULLED_CHECK_CONCURRENCY);
    await Promise.all(batch.map(async (series): Promise<void> => {
      if (!series.seriesUID) return;
      const home = await series_cubePathGet(series.seriesUID, 1, 0);
      if (home !== null) {
        series.pulled = true;
        series.pulledFiles = home.fileCount;
        if (home.folderPath !== null && home.folderPath !== undefined) series.folderPath = home.folderPath;
      }
    }));
  }
}


/**
 * Who is asking, as the index keys it.
 *
 * `current_get(ChRISuser)` reads a per-session context snapshot, and a
 * surface attached to a running calypso does not necessarily have one —
 * which silently keyed every lookup under an empty owner and made the
 * whole stored back-catalogue unreachable from argus while chell found it
 * perfectly. `ChRISuser_get` reads the authenticated login instead, which
 * is the same thing the sweep files records under.
 *
 * @returns The CUBE username, or an empty string when nobody is logged in.
 */
async function askingIdentity_get(): Promise<string> {
  return (await chrisContext.ChRISuser_get()) ?? '';
}

/**
 * What each way of naming a server resolves to. Server identifiers do not
 * change under a session, and this is on the path of every query.
 */
const pacsIdentifiers: Map<string, string> = new Map();

/**
 * Resolves whatever names a PACS server into its canonical identifier.
 *
 * The context may hold a numeric id, a `--pacsserver` may be either, and
 * CUBE files a query under the identifier. The index is keyed on what CUBE
 * stores, so both the write and the lookup have to speak that.
 *
 * @param pacsserver - An id or an identifier.
 * @returns The identifier, or the input unchanged when it cannot be resolved.
 */
export async function pacsIdentifier_resolve(pacsserver: string): Promise<string> {
  const remembered: string | undefined = pacsIdentifiers.get(pacsserver);
  if (remembered !== undefined) return remembered;
  const servers = await pacsServers_list();
  // Best effort by design: this only decides what a lookup is filed under,
  // so an unreachable or unhelpful CUBE must never fail the query itself.
  if (!servers?.ok) return pacsserver;
  let resolved: string = pacsserver;
  for (const server of servers.value) {
    if (server.identifier === pacsserver) { resolved = pacsserver; break; }
    if (String(server.id) === pacsserver && server.identifier) { resolved = server.identifier; break; }
  }
  pacsIdentifiers.set(pacsserver, resolved);
  return resolved;
}

/**
 * Says how long ago something was answered, in the coarsest true unit.
 *
 * A replay states its age because mise refuses to decide staleness on the
 * operator's behalf: an accession names a study that will not change, an
 * MRN can gain one tomorrow, and no heuristic tells those apart reliably.
 *
 * @param at - An ISO timestamp.
 * @returns A phrase like `3 months ago`, or null when the stamp is unusable.
 */
export function age_describe(at: string): string | null {
  const then: number = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const seconds: number = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: ReadonlyArray<{ limit: number; size: number; name: string }> = [
    { limit: 60, size: 1, name: 'second' },
    { limit: 3600, size: 60, name: 'minute' },
    { limit: 86400, size: 3600, name: 'hour' },
    { limit: 2592000, size: 86400, name: 'day' },
    { limit: 31536000, size: 2592000, name: 'month' },
    { limit: Infinity, size: 31536000, name: 'year' },
  ];
  for (const unit of units) {
    if (seconds >= unit.limit) continue;
    const count: number = Math.max(1, Math.floor(seconds / unit.size));
    return `${count} ${unit.name}${count === 1 ? '' : 's'} ago`;
  }
  return null;
}

/**
 * Serves a stored answer when this exact question already has one.
 *
 * The rules were settled in #379 and each earns its place:
 *
 * - the criteria, the server AND the asking identity must match, because
 *   another identity's answer is not an answer to this question;
 * - a query that found NOTHING is never replayed. A hit is evidence that
 *   persists — the study existed and still does — while an absence decays,
 *   and "no imaging found" is the answer a clinician acts on;
 * - the index is advisory, so a hit is confirmed by actually decoding the
 *   stored result. Anything that fails — the query deleted, the payload
 *   unreadable — drops the entry and falls through to a fresh query.
 *
 * @param criteria - The criteria as asked.
 * @param identifier - The PACS being asked.
 * @param owner - The identity asking.
 * @returns The stored answer and its age, or null to ask the PACS.
 */
async function replay_attempt(
  criteria: Record<string, string>,
  identifier: string,
  owner: string,
): Promise<{ result: QueryCreateResult; answeredAt: string } | null> {
  const entry = queryIndex_get().entry_find(criteria, identifier, owner);
  if (entry === null || !entry.hasResult) return null;

  const decoded = await pacsQuery_resultDecode(entry.queryId);
  if (!decoded.ok || decoded.value.json === undefined) {
    // The index promised something CUBE no longer has. Forget it and ask.
    errorStack.stack_pop();
    queryIndex_get().entry_drop(criteria, identifier, owner);
    return null;
  }
  return {
    result: {
      queryId: entry.queryId,
      vfsPath: queryVfsPath_build(entry.queryId, entry.criteria, entry.owner || undefined),
      decoded: decoded.value,
    },
    answeredAt: entry.answeredAt,
  };
}

/**
 * Reads a JSON expression as single-valued terms.
 *
 * The JSON form predates multi-value and stays what it was: one question,
 * spelled as an object.
 *
 * @param expr - The expression, starting with `{`.
 * @returns Terms with one value each, or null when the JSON is not an object.
 */
function termsFromJson_read(expr: string): Record<string, string[]> | null {
  const parsed: Record<string, string> | null = queryExpr_parse(expr);
  if (parsed === null) return null;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]: [string, string]): [string, string[]] => [key, [value]]),
  );
}

/** How many patient queries are in flight at once. */
const QUERY_FANOUT_CONCURRENCY: number = 4;

/**
 * One question in a fan-out: the criteria to ask, and the patient it is
 * about when it is about one.
 *
 * @property criteria - The criteria for this single C-FIND.
 * @property patientId - The MRN this question asks after, when it names one.
 */
interface QueryAsk {
  criteria: Record<string, string>;
  patientId?: string;
  /** The server to ask, as CUBE names it in a create. */
  server: string;
  /**
   * That server's canonical identifier — what CUBE files the query under,
   * and therefore what the replay index is keyed by and what a row says it
   * came from.
   */
  identifier: string;
}

/** What one question came back with. */
interface QueryAnswer {
  ask: QueryAsk;
  result: QueryCreateResult | null;
  /** When the PACS answered, for a replayed row. */
  answeredAt: string | null;
  /** Why the question could not be asked, when it could not. */
  error?: string;
}

/**
 * Renders criteria back into the expression syntax they were parsed from,
 * so a single question inside a fan-out is asked exactly as one typed by
 * hand — the create path takes an expression, not a record.
 *
 * @param criteria - One question's criteria.
 * @returns The `Key:Value,Key:Value` form.
 */
function criteria_format(criteria: Record<string, string>): string {
  return Object.entries(criteria)
    .map(([key, value]: [string, string]): string => `${key}:${value}`)
    .join(',');
}

/**
 * One answer with a stand-in for everything it says about a person.
 *
 * Substituted in the DECODED payload, which is what the model, the table,
 * the CSV and the console line are all built from — so one substitution
 * reaches every one of them and none of them has to know.
 *
 * @param answer - What came back.
 * @returns The same answer, saying nothing identifying.
 */
function answer_stoodIn(answer: QueryAnswer): QueryAnswer {
  if (answer.result === null) return answer;
  return {
    ...answer,
    result: {
      ...answer.result,
      decoded: { ...answer.result.decoded, json: answer_standIn(answer.result.decoded.json) },
    },
  };
}

/**
 * The typed line, with stand-ins for the values in it.
 *
 * The line an operator typed is the first identifying thing on a screen,
 * and it is echoed above the answer. Rewriting the VALUES rather than
 * starring them out keeps the line honest — a PACS reads `*` as a wildcard,
 * so a starred line is one an onlooker could run to mean something else
 * entirely — and ties the line to the rows below it, which carry the same
 * tokens.
 *
 * @param expression - The line as typed.
 * @param asks - The questions it lowered to, holding the real values.
 * @returns The line with each value stood in for.
 */
function expression_standIn(expression: string, asks: ReadonlyArray<QueryAsk>): string {
  let out: string = expression;
  const seen: Array<[string, string]> = [];
  for (const ask of asks) {
    for (const [field, value] of Object.entries(ask.criteria)) seen.push([field, value]);
  }
  // Longest first: a short value that is a substring of a longer one must
  // not be replaced inside it.
  seen.sort((a: [string, string], b: [string, string]): number => b[1].length - a[1].length);
  for (const [field, value] of seen) {
    if (value === '') continue;
    const stoodIn: string = criteria_standIn({ [field]: value })[field] ?? value;
    out = out.split(value).join(stoodIn);
  }
  return out;
}

/**
 * Asks one question, replaying it when the same question has been asked
 * before.
 *
 * @param ask - The question.
 * @param title - Title for the PACSQuery record this may create.
 * @param pacsserver - The server to ask.
 * @param identifier - That server as the replay index keys it.
 * @param owner - The identity asking.
 * @param fresh - True to skip the stored answer and trouble the PACS.
 * @returns What came back, including the reason when nothing did.
 */
async function ask_run(
  ask: QueryAsk,
  title: string,
  owner: string,
  fresh: boolean,
): Promise<QueryAnswer> {
  if (!fresh) {
    const replayed = await replay_attempt(ask.criteria, ask.identifier, owner);
    if (replayed !== null) {
      return { ask, result: replayed.result, answeredAt: replayed.answeredAt };
    }
  }
  const checkpoint: number = errorStack.checkpoint_mark();
  const expression: string = criteria_format(ask.criteria);
  // Each question gets its own title. CUBE refuses a second PACSQuery with
  // a title it already holds for that server — measured live, where a
  // fan-out under one title had every question after the first come back
  // "You have already registered a PACS query with title=..." — so a
  // cohort sharing one title would report a room full of unasked patients.
  const result: QueryCreateResult | null = await pacsQuery_createAndWait(
    expression,
    `${title} · ${expression}`,
    ask.server,
  );
  if (result !== null) return { ask, result, answeredAt: null };
  // A question that could not be asked has told us nothing. Its reason is
  // carried onto the row rather than left on the stack, where a later
  // question's success would bury it.
  const reasons: StackMessage[] = errorStack.checkpoint_drain(checkpoint);
  const reason: string | undefined = reasons[reasons.length - 1]?.message;
  // Stripped where the reason becomes data: this message is read in a
  // table and on a graphical surface, and `[pacsServer_resolve ] |` is a
  // debugging artefact in both. Imported here rather than at the top so
  // this module keeps its narrow graph.
  const { error_stripDebugPrefix } = await import('../utils.js');
  return {
    ask,
    result: null,
    answeredAt: null,
    error: reason === undefined ? 'the query could not be completed' : error_stripDebugPrefix(reason),
  };
}

/**
 * Runs a fan-out, at most four questions in flight.
 *
 * Not operator-settable: nobody inside mise knows the right number for a
 * given hospital, and a flag that can hurt a shared clinical system will
 * eventually be set to fifty.
 *
 * @param asks - Every question to ask, each naming its own server.
 * @param title - Title for the PACSQuery records created.
 * @param owner - The identity asking.
 * @param fresh - True to skip stored answers.
 * @returns The answers, in the order the questions were given.
 */
async function fanout_run(
  asks: QueryAsk[],
  title: string,
  owner: string,
  fresh: boolean,
): Promise<QueryAnswer[]> {
  const answers: QueryAnswer[] = new Array<QueryAnswer>(asks.length);
  let done: number = 0;
  // What is being counted: patients when every question names one, plain
  // questions otherwise — a fan-out over servers or dates is not MRNs.
  const label: string = asks.every((ask: QueryAsk): boolean => ask.patientId !== undefined)
    ? 'MRNS QUERIED'
    : 'QUERIES';
  const progress_say = (phase: 'working' | 'complete'): void => {
    sink_get().progress_write({
      operation: 'task',
      kind: 'inspection',
      phase,
      label,
      current: done,
      total: asks.length,
      percent: asks.length > 0 ? Math.min(100, (done / asks.length) * 100) : undefined,
      status: phase === 'complete' ? 'done' : 'running',
    });
  };

  progress_say('working');
  let next: number = 0;
  const worker = async (): Promise<void> => {
    while (next < asks.length) {
      const index: number = next++;
      answers[index] = await ask_run(asks[index], title, owner, fresh);
      done++;
      progress_say('working');
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(QUERY_FANOUT_CONCURRENCY, asks.length) }, worker),
  );
  progress_say('complete');
  return answers;
}

/**
 * Unions a fan-out's answers into one model.
 *
 * The studies keep their own identities and paths, each already built
 * against the query that found it. The patient level records what was
 * ASKED — including the questions that found nothing and the ones that
 * could not be asked at all, which is the half of a cohort answer that
 * cannot be derived from studies nobody has.
 *
 * @param answers - What every question came back with.
 * @param facts - The command's identity facts.
 * @returns The union model.
 */
function fanoutModel_build(
  answers: QueryAnswer[],
  facts: { pacsName: string; expression: string },
): PacsQueryModel {
  // A row says which PACS answered only when more than one could have. On
  // a single-server query the column would repeat one value down the page
  // and tell an operator nothing.
  const manyServers: boolean = new Set(
    answers.map((answer: QueryAnswer): string => answer.ask.identifier),
  ).size > 1;
  const studies: PacsStudy[] = [];
  const patients: PacsPatient[] = [];
  let anchor: QueryCreateResult | null = null;
  let oldest: string | null = null;
  let allReplayed: boolean = true;

  for (const answer of answers) {
    const found: PacsStudy[] = answer.result === null ? [] : pacsQueryModel_build(answer.result.decoded, {
      queryId: answer.result.queryId,
      vfsPath: answer.result.vfsPath,
      pacsName: answer.ask.server,
      expression: criteria_format(answer.ask.criteria),
    }).studies.map((study: PacsStudy): PacsStudy => (
      manyServers ? { ...study, server: answer.ask.identifier } : study
    ));
    studies.push(...found);
    if (answer.result !== null && (anchor === null || found.length > 0)) {
      if (anchor === null || anchor.decoded.json === undefined) anchor = answer.result;
    }

    const answeredAt: string = answer.answeredAt ?? new Date().toISOString();
    if (answer.answeredAt === null) allReplayed = false;
    if (answer.result !== null && (oldest === null || answeredAt < oldest)) oldest = answeredAt;

    if (answer.ask.patientId === undefined) continue;
    const seriesCount: number = found.reduce(
      (total: number, study: PacsStudy): number => total + study.series.length, 0,
    );
    patients.push({
      patientId: answer.ask.patientId,
      ...(manyServers ? { server: answer.ask.identifier } : {}),
      ...(found[0]?.patientName ? { patientName: found[0].patientName } : {}),
      status: answer.result === null ? 'unasked' : (found.length > 0 ? 'found' : 'none'),
      studyCount: found.length,
      seriesCount,
      ...(answer.result === null ? {} : { queryId: answer.result.queryId }),
      ...(answer.result === null ? {} : {
        provenance: { replayed: answer.answeredAt !== null, answeredAt },
      }),
      ...(answer.error === undefined ? {} : { error: answer.error }),
    });
  }

  return {
    queryId: anchor?.queryId ?? 0,
    vfsPath: anchor?.vfsPath ?? '',
    pacsName: facts.pacsName,
    expression: facts.expression,
    studies,
    // The set's provenance is its OLDEST row: the worst row is what decides
    // whether an audit table can be trusted, and a set is only "replayed"
    // when nothing in it troubled the PACS.
    ...(oldest === null ? {} : { provenance: { replayed: allReplayed, answeredAt: oldest } }),
    ...(patients.length > 0 ? { patients } : {}),
  };
}

/**
 * Renders a cohort as the audit table it is: one row per patient asked.
 *
 * A miss reads as a zero and a failure reads as a dash in an error hue,
 * because a server that timed out has told us nothing while a PACS that
 * answered with nothing has told us something, and a clinician acts on the
 * difference.
 *
 * @param patients - Every patient asked.
 * @returns The rendered table.
 */
function cohort_render(patients: ReadonlyArray<PacsPatient>): string {
  const server_extract = (patient: PacsPatient): string => patient.server ?? '';
  const manyServers: boolean = new Set(patients.map(server_extract)).size > 1;
  const serverWidth: number = 14;
  const lines: string[] = [''];
  const serverCap: string = manyServers ? chalk.bold.white('SERVER'.padEnd(serverWidth)) : '';
  lines.push(`  ${chalk.bold.white('MRN'.padEnd(18))}${serverCap}${chalk.bold.white('STUDIES'.padEnd(10))}${chalk.bold.white('SERIES'.padEnd(9))}${chalk.bold.white('ANSWERED')}`);
  lines.push(`  ${chalk.gray('─'.repeat(manyServers ? 74 : 60))}`);
  for (const patient of patients) {
    const answered: string | null = patient.provenance === undefined
      ? null
      : age_describe(patient.provenance.answeredAt);
    const counts: [string, string] = patient.status === 'unasked'
      ? ['—', '—']
      : [String(patient.studyCount), String(patient.seriesCount)];
    const hue = patient.status === 'unasked'
      ? chalk.red
      : (patient.status === 'none' ? chalk.gray : chalk.white);
    const note: string = patient.status === 'unasked'
      ? chalk.red(patient.error ?? 'unasked')
      : chalk.gray(answered ?? 'just now');
    const server: string = manyServers ? server_extract(patient).padEnd(serverWidth) : '';
    lines.push(`  ${hue(patient.patientId.padEnd(18))}${server}${counts[0].padEnd(10)}${counts[1].padEnd(9)}${note}`);
  }
  return `${lines.join('\n')}\n${cohortTally_render(patients)}`;
}

/**
 * The cohort's closing tally: found, none, unasked.
 *
 * @param patients - Every patient asked.
 * @returns The tally line with a blank line either side, or '' when no patient was asked.
 */
function cohortTally_render(patients: ReadonlyArray<PacsPatient>): string {
  if (patients.length === 0) return '';
  const tally = (state: PacsPatient['status']): number =>
    patients.filter((patient: PacsPatient): boolean => patient.status === state).length;
  return `  ${chalk.green(`FOUND ${tally('found')}`)} ${chalk.gray('·')} ${chalk.gray(`NONE ${tally('none')}`)} ${chalk.gray('·')} ${chalk.red(`UNASKED ${tally('unasked')}`)}\n\n`;
}



/**
 * Renders an answer as CSV, and writes it into ChRIS storage when asked.
 *
 * Two flags rather than one with an optional value: `--csv PatientID:1234`
 * could not tell a destination from a query expression, and guessing wrong
 * writes a file named after a patient.
 *
 * A local terminal needs no destination — `--csv > audit.csv` writes the
 * operator's own disk, because engine and operator share a filesystem. A
 * detached surface does not: the engine runs on the daemon's host, so a
 * redirect lands on somebody else's machine. `--csv-to` puts the table in
 * CFS instead, where a cohort's MRNs and study descriptions stay inside
 * ChRIS rather than on whatever laptop the operator is sitting at.
 *
 * @param model - The answer.
 * @param destination - A CFS path to write to, or null to render only.
 * @returns The CSV text and where it went, or a failure already explained.
 */
async function csv_deliver(
  model: PacsQueryModel,
  destination: string | null,
  ask: boolean = false,
  force: boolean = false,
  level: PacsAnswerLevel = 'study',
  table: boolean = false,
): Promise<{ ok: true; rendered: string } | { ok: false; message: string }> {
  const csv: string = pacsAnswer_renderCsv(model, level);
  let target: string | null = destination;
  if (target === null && ask) {
    // Asked only once there is something to write: a question raised before
    // the PACS answered would be a question about a file that may never
    // exist.
    const chosen: string = await csvDestination_ask();
    if (chosen === '') return { ok: false, message: 'query: no destination given; nothing written.' };
    target = chosen;
  }
  if (target === null) return { ok: true, rendered: csv };

  const written: CsvWrite = await csvFile_write(csv, target, force);
  if (!written.ok) return { ok: false, message: `query: ${written.message}` };
  // A folder that had to be made is said, not discovered later.
  const made: string = written.created === undefined
    ? ''
    : `${chalk.gray(`  made ${written.created}`)}\n`;
  // A file that was there and is not any more is said, for the same reason
  // the folder is: an act nobody reported is an act nobody can check.
  const gone: string = written.replaced === true
    ? `${chalk.gray(`  replaced the table that was there`)}\n`
    : '';
  // The file went where it was sent; the screen, asked for the table,
  // shows the same rows beside the word that they were written.
  const shown: string = table ? `\n${pacsAnswer_renderTable(model, level)}` : '';
  return { ok: true, rendered: `${made}${gone}${chalk.green(`✓ wrote ${written.path}`)}\n${shown}` };
}


/**
 * Asks where the table should go.
 *
 * The anchor is the session's own cwd — a fact, not a guess. Inventing a
 * directory here would mean creating one behind the operator's back, which
 * is what the surface used to do.
 *
 * @returns The location given, absolute, or '' when the operator abandoned the ask.
 */
async function csvDestination_ask(): Promise<string> {
  const { session } = await import('../../session/index.js');
  const { repl_questionPath } = await import('../../core/question.js');
  const stamp: string = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Where the operator is, unless they are somewhere nothing can be
  // written: a session sitting in `/bin` or `/proc` is browsing a provider,
  // not a place a file lands, and an errand that opens there offers a
  // destination that is refused the moment it is committed.
  const cwd: string = await session.getCWD();
  const virtual: boolean = ['/bin', '/usr', '/etc', '/proc', '/net']
    .some((prefix: string): boolean => cwd === prefix || cwd.startsWith(`${prefix}/`));
  try {
    const answer: string = await repl_questionPath(
      'Where should the table go? ',
      {
        anchor: virtual ? '~' : cwd,
        wantsDirectory: false,
        suggest: `pacs-${stamp}.csv`,
      },
      'EXPORT HERE',
    );
    // Absolute, against the place the question showed: other commands run
    // while it is open, and a `cd` among them must not move the file.
    const given: string = answer.trim();
    if (given === '') return '';
    const { path_resolve } = await import('../utils.js');
    if (given.startsWith('/') || given.startsWith('~')) return await path_resolve(given);
    const base: string = virtual ? '~' : cwd;
    return await path_resolve(`${base === '/' ? '' : base}/${given}`);
  } catch {
    // A refused or abandoned ask is not a failure of the query: the answer
    // stands, and only the writing of it does not happen.
    return '';
  }
}

/**
 * Answers a cohort: many questions, one model, one table.
 *
 * @param asks - The questions.
 * @param facts - Title, server, identity and how the answer should read.
 * @returns One envelope carrying every answer.
 */
async function cohort_answer(
  asks: QueryAsk[],
  facts: {
    title: string;
    /** The server named on the model when one answered; the first otherwise. */
    pacsserver: string;
    owner: string;
    fresh: boolean;
    expression: string;
    /** Render the answer as CSV instead of as a table. */
    csv: boolean;
    /** A CFS path to write that CSV to, when one was named. */
    csvTo: string | null;
    /** True when `--csv-to` was given no value and the destination is asked for. */
    csvToAsk: boolean;
    /** True when the operator said to overwrite an existing table. */
    force: boolean;
    /** True to stand in for what the answers say about a person. */
    anon: boolean;
    /** One row per study, or per series. */
    level: PacsAnswerLevel;
    /** True to show the answer's rows as an aligned table. */
    table: boolean;
  },
): Promise<CommandEnvelope> {
  spinner.start(`Querying PACS for ${asks.length} questions...`, true);
  const answers: QueryAnswer[] = await fanout_run(asks, facts.title, facts.owner, facts.fresh);
  spinner.stop();

  const model: PacsQueryModel = fanoutModel_build(
    facts.anon ? answers.map(answer_stoodIn) : answers,
    {
      pacsName: facts.pacsserver,
      expression: facts.expression,
    },
  );
  await modelPulledState_fill(model);

  const patients: ReadonlyArray<PacsPatient> = model.patients ?? [];
  const unasked: number = patients.filter(
    (patient: PacsPatient): boolean => patient.status === 'unasked',
  ).length;

  if (facts.csv || facts.csvTo !== null || facts.csvToAsk) {
    const delivered = await csv_deliver(model, facts.csvTo, facts.csvToAsk, facts.force, facts.level, facts.table);
    if (!delivered.ok) {
      exitCode_set(1);
      // The ANSWER stands: only the writing of it did not happen. An
      // abandoned question, or a refused destination, is no reason to
      // throw away a PACS answer the operator waited for — the model
      // crosses either way, and a surface still shows what was found.
      return {
        ...envelope_error('', undefined, `${chalk.red(delivered.message)}\n`),
        model: { kind: PACS_QUERY_MODEL_KIND, data: model },
      };
    }
    return envelope_ok(delivered.rendered, { kind: PACS_QUERY_MODEL_KIND, data: model });
  }
  // A fan-out over something other than patients has no audit table to
  // show; its studies are the answer, and they are already in the model.
  // Asked for the table, the cohort shows its rows — the audit's own
  // facts (a patient with none, a question unasked) ride them as rows with
  // their STATUS, and the tally still closes it.
  const rendered: string = facts.table
    ? `\n${pacsAnswer_renderTable(model, facts.level)}${cohortTally_render(patients)}`
    : patients.length > 0
      ? cohort_render(patients)
      : `${chalk.green(`✓ ${asks.length} queries complete — ${model.studies.length} studies`)}\n`;

  // Every question failing is a failure of the command; some failing is an
  // answer with holes in it, which the table states and the operator reads.
  if (unasked > 0 && unasked === patients.length) {
    exitCode_set(1);
    // The model still crosses. A surface showing which MRNs went unasked,
    // and why, is more use than an empty pane beside a red line.
    const reasons: string[] = answers.flatMap((answer: QueryAnswer): string[] => (answer.error !== undefined ? [answer.error] : []));
    const hint: string = pacsRefusal_is(reasons) ? pacsRefusal_hint() : '';
    return {
      ...envelope_error(rendered, undefined, `${chalk.red(`query: none of the ${unasked} questions could be asked.`)}\n${hint}`),
      model: { kind: PACS_QUERY_MODEL_KIND, data: model },
    };
  }
  return envelope_ok(rendered, { kind: PACS_QUERY_MODEL_KIND, data: model });
}

/**
 * `query <Key:Value…> [options]`: the declaration. `pacs query` takes the
 * same line (`QUERY_GRAMMAR`) and runs the same handler.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [queryCommand] }, 'backend');
 * ```
 */
export const queryCommand = command_declare({
  name: 'query',
  grammar: QUERY_GRAMMAR,
  help: {
    summary: 'Create a PACS query, wait for results, and print the VFS path',
    description: 'Create a PACS query, wait for its answer, show it, and print the VFS path a pull or a cd takes. '
      + 'A question already answered is replayed from the index, its age said; --fresh asks again. '
      + 'A PACS matches one patient at a time, so several MRNs (PatientID:1,2,3 or --patients) is several queries, one table. '
      + 'Some PACS ignore keys: PACSDCM answers SeriesDescription and StudyDescription as if they were not asked (query says so); '
      + 'narrow the answer with grep. The keys each server ignores are in ~/.config/mise/pacs.json, as '
      + '{"ignoredKeys": {"PACSDCM": ["SeriesDescription", "StudyDescription"]}}.',
    category: 'PACS',
    examples: [
      'query PatientID:1234',
      'query PatientID:1234 --fresh           # ignore the stored answer',
      'query AccessionNumber:12345678 --title "Hip DDH workup"',
      'query PatientID:1234,StudyDate:20240101',
      'query PatientID:1234567,Modality:MR | grep -i t1 | grep -vi gadavist',
      '',
      '# A PACS matches one patient at a time, so several MRNs is several queries',
      'query PatientID:1234,4532,6654         # three questions, one table',
      'query --patients @~/cohorts/ddh.txt    # a cohort from a file in ChRIS',
      'query StudyDate:20240101 --patients 1234,4532   # narrowed, per patient',
      'query PatientID:1234 --pacsserver PACSDCM,ORTHANC   # ask both, one listing',
      '',
      '# A cohort audit, as a table a spreadsheet reads',
      'query --patients @~/cohorts/ddh.txt --csv > audit.csv    # a local terminal',
      'query --patients @~/cohorts/ddh.txt --csv-to ~/audits/ddh.csv   # any surface',
      'query PatientID:1234 --csv-to ~/audit.csv --table --series',
      '',
      '# Use output path directly with pull',
      'pull $(query PatientID:1234 | grep "VFS path" | awk \'{print $3}\')',
    ],
  },
  handler: queryLine_run,
});

/**
 * `query` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `query`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_query(['PatientID:1234', '--table']);
 * ```
 */
export async function builtin_query(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(queryCommand, args);
}

/**
 * Creates a PACS query, waits for results, displays findings, and prints the
 * VFS path: the handler of `query` and of `pacs query`.
 *
 * @param args - The line, parsed.
 * @returns The answer, its model beside it.
 *
 * @example
 * ```ts
 * await queryLine_run({ operands: { expression: ['PatientID:1234'] }, options: { …, table: true } });
 * ```
 */
export async function queryLine_run(args: QueryLine): Promise<CommandEnvelope> {
  const { options } = args;
  const title: string = options.title ?? `Query ${Date.now()}`;
  const pacsserverOverride: string | null = options.pacsserver ?? null;
  let tableMode: boolean = options.table;
  const fresh: boolean = options.fresh;
  const patientsArg: string | null = options.patients ?? null;
  const csv: boolean = options.csv;
  // A value-taking flag given no value is an ASK: `--csv-to` with nothing
  // after it means "ask me where", which is how a graphical surface opens
  // its errand and how a terminal gets a prompt.
  const csvTo: string | null = options.csvTo ?? null;
  const csvToAsk: boolean = options.csvTo === null;
  const force: boolean = options.force;
  // Standing in for what the answer says about a person is for
  // demonstrating against a live hospital PACS, where every answer carries
  // somebody's name and record number onto the screen.
  const anon: boolean = options.anon;
  const level: PacsAnswerLevel = options.series ? 'series' : 'study';
  const positional: string[] = args.operands.expression;

  // Two renderings for one screen: CSV is the answer's text, the table is
  // its rows aligned. Asked for both, neither is guessed; writing the CSV
  // to a file (`--csv-to`) leaves the screen free for the table.
  if (csv && tableMode) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('query: --csv and --table are two formats for one screen; pick one (or --csv-to <cfs-path> --table: the file gets the CSV, the screen the table)')}\n`);
  }
  // A level is a property of rows: asked for series with no format named,
  // the answer is the series table.
  if (level === 'series' && !csv) tableMode = true;

  if (positional.length === 0 && patientsArg === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('query: Missing query expression. Usage: query <Key:Value[,...]> [--patients <list|@file>] [--title <title>]')}\n`);
  }

  const queryExpr: string = positional.join(' ');

  // Validate expression early. A cohort may narrow with terms or with none
  // at all — `--patients @mrns.txt` is a complete question.
  const terms: Record<string, string[]> | null =
    queryExpr === '' ? {} : (queryExpr.trimStart().startsWith('{')
      ? termsFromJson_read(queryExpr)
      : queryTerms_parse(queryExpr));
  if (terms === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`query: Invalid expression: "${queryExpr}". Use Key:Value pairs (e.g. PatientID:1234) or JSON.`)}\n`);
  }

  // Resolve the PACS servers. Several is a QUERY across them; one is the
  // ordinary case. There is no sweep-everything: a fan-out is always
  // something the operator named, because thirteen registrations of
  // unknown liveness is thousands of C-FINDs mostly into the void.
  const named: string[] = (pacsserverOverride ?? '')
    .split(',')
    .map((entry: string): string => entry.trim())
    .filter((entry: string): boolean => entry !== '');
  let servers: string[] = named;
  if (servers.length === 0) {
    const inContext: string | null = await chrisContext.current_get(Context.PACSserver);
    if (inContext) {
      servers = [inContext];
    } else {
      const serversResult = await pacsServers_list();
      if (serversResult.ok && serversResult.value.length > 0) {
        servers = [String(serversResult.value[0].id)];
      } else {
        exitCode_set(1);
        return envelope_error('', undefined, `${chalk.red('query: No PACS server available. Set one with: pacs connect <id>')}\n`);
      }
    }
  }
  const pacsserver: string = servers[0];

  // The index is keyed on what CUBE stores, which is the identifier.
  const identifiers: string[] = await Promise.all(
    servers.map((server: string): Promise<string> => pacsIdentifier_resolve(server)),
  );
  const identifier: string = identifiers[0];
  const owner: string = await askingIdentity_get();
  // A key the PACS ignores narrows nothing: said once, on the err channel,
  // before the question goes out; the query runs as asked (#1105).
  for (const server of [...new Set(identifiers)]) {
    const hint: string | null = ignoredKeys_hint(terms, server);
    if (hint !== null) sink_get().err_write(`${chalk.yellow(hint)}\n`);
  }

  // What the operator asked for, as the questions it stands for. A PACS
  // will not match a list, so several patients is several C-FINDs.
  const asks: QueryAsk[] = [];
  if (patientsArg !== null) {
    const cohort = await patients_read(patientsArg);
    if (!cohort.ok) {
      const problem: StackMessage | undefined = errorStack.stack_pop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(problem?.message ?? 'query: --patients could not be read.')}\n`);
    }
    if (!fanout_permit(cohort.value.length, QUERY_COHORT_MAX)) {
      const problem: StackMessage | undefined = errorStack.stack_pop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(problem?.message ?? 'query: too many patients.')}\n`);
    }
    const base: Record<string, string> = Object.fromEntries(
      Object.entries(terms).map(([key, values]: [string, string[]]): [string, string] => [key, values[0]]),
    );
    if (!fanout_permit(cohort.value.length * servers.length, QUERY_COHORT_MAX)) {
      const problem: StackMessage | undefined = errorStack.stack_pop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(problem?.message ?? 'query: too many questions.')}\n`);
    }
    for (const mrn of cohort.value) {
      for (let index: number = 0; index < servers.length; index++) {
        asks.push({
          criteria: { ...base, [PATIENT_KEY]: mrn },
          patientId: mrn,
          server: servers[index],
          identifier: identifiers[index],
        });
      }
    }
  } else {
    const expanded: Array<Record<string, string>> = queryTerms_expand(terms);
    if (!fanout_permit(expanded.length * servers.length, QUERY_INLINE_FANOUT_MAX)) {
      const problem: StackMessage | undefined = errorStack.stack_pop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(problem?.message ?? 'query: too many queries.')}\n`);
    }
    const asksPerServer: number = expanded.length * servers.length;
    for (const one of expanded) {
      for (let index: number = 0; index < servers.length; index++) {
        asks.push({
          criteria: one,
          // A single question put to a single server is not a cohort: it
          // needs no patient level, and inventing one would put an audit
          // table where a study list belongs.
          ...(one[PATIENT_KEY] === undefined || asksPerServer === 1
            ? {}
            : { patientId: one[PATIENT_KEY] }),
          server: servers[index],
          identifier: identifiers[index],
        });
      }
    }
  }

  if (asks.length > 1) {
    return await cohort_answer(asks, {
      // The model names the server the way CUBE does. `--pacsserver 1` and
      // `--pacsserver PACSDCM` are the same server, and a table that says
      // "1" tells an operator nothing about which PACS answered.
      title, pacsserver: identifier, owner, fresh, csv, csvTo, csvToAsk, force, anon, level, table: tableMode,
      expression: anon ? expression_standIn(patientsArg === null ? queryExpr : `${queryExpr} --patients ${patientsArg}`.trim(), asks)
        : (patientsArg === null ? queryExpr : `${queryExpr} --patients ${patientsArg}`.trim()),
    });
  }

  const criteria: Record<string, string> = asks[0]?.criteria ?? {};
  // One question, spelled as the create path wants it — which is not
  // necessarily what was typed: `--patients 1234` names a patient without
  // an expression to carry it.
  const askExpr: string = criteria_format(criteria);

  let result: QueryCreateResult | null = null;
  let answeredAt: string | null = null;

  if (!fresh) {
    const replayed = await replay_attempt(criteria, identifier, owner);
    if (replayed !== null) {
      result = replayed.result;
      answeredAt = replayed.answeredAt;
    }
  }

  if (result === null) {
    spinner.start(`Querying PACS for ${askExpr}...`, true);
    result = await pacsQuery_createAndWait(
      askExpr,
      title,
      pacsserver,
      (msg: string) => spinner.updateMessage(msg),
    );
    spinner.stop();
  }

  if (!result) {
    let errOut: string = '';
    const errs = errorStack.stack_getAll?.() ?? [];
    if (errs.length) {
      // Carry the stack directly: in -c/-f mode nothing else will.
      errs.forEach((err: unknown) => {
        const msg: string = typeof err === 'string' ? err : ((err as { message?: string }).message ?? String(err));
        errOut += `${chalk.red(msg)}\n`;
      });
    } else {
      errOut += `${chalk.red('query: Failed — check connection and PACS server context.')}\n`;
    }
    // A refusal says what to do about it: PACS is a group CUBE grants.
    const said: string[] = errs.map((err: unknown): string => typeof err === 'string' ? err : ((err as { message?: string }).message ?? String(err)));
    if (pacsRefusal_is(said)) errOut += pacsRefusal_hint();
    exitCode_set(1);
    return envelope_error('', undefined, errOut);
  }

  // Everything below reads from `decoded`, so standing in here reaches the
  // table, the model a surface renders, and any CSV, all at once. The
  // DICOM identifiers are left alone: they are never shown, and they are
  // what the held-state reconciliation matches on.
  if (anon) {
    result = { ...result, decoded: { ...result.decoded, json: answer_standIn(result.decoded.json) } };
  }
  // What the operator typed, said in the same tokens the rows carry.
  const shownExpr: string = anon ? criteria_format(criteria_standIn(criteria)) : askExpr;

  let renderedResult: string | null = null;


  const model: PacsQueryModel = pacsQueryModel_build(result.decoded, {
    queryId: result.queryId,
    vfsPath: result.vfsPath,
    pacsName: identifier,
    expression: shownExpr,
    provenance: {
      replayed: answeredAt !== null,
      answeredAt: answeredAt ?? new Date().toISOString(),
    },
  });
  // Mark what CUBE already holds: a surface then offers gather instead of
  // pull for series that are already home. One bounded sweep, no retries.
  await modelPulledState_fill(model);
  // The table reads the model, pulled state and all, so it is rendered
  // once the model knows what CUBE already holds.
  if (tableMode && model.studies.length > 0) renderedResult = `\n${pacsAnswer_renderTable(model, level)}`;
  // The default view reads the model too, so the handles it prints are the
  // ones an index expands to (#1099).
  if (!tableMode) renderedResult = pacsAnswer_render(model);

  if (csv || csvTo !== null || csvToAsk) {
    const delivered = await csv_deliver(model, csvTo, csvToAsk, force, level, tableMode);
    if (!delivered.ok) {
      exitCode_set(1);
      // The answer stands; only the writing of it did not happen.
      return {
        ...envelope_error('', undefined, `${chalk.red(delivered.message)}\n`),
        model: { kind: PACS_QUERY_MODEL_KIND, data: model },
      };
    }
    return envelope_ok(delivered.rendered, { kind: PACS_QUERY_MODEL_KIND, data: model });
  }

  if (!renderedResult) {
    // Nothing matched: browsing or pulling the empty query would be
    // meaningless, so no hints. The empty model still crosses, so a
    // graphical surface can say "no studies" in its own voice.
    return envelope_ok(
      `${chalk.yellow(`⚠ Query ${result.queryId} complete — no studies found.`)}\n`,
      { kind: PACS_QUERY_MODEL_KIND, data: model },
    );
  }

  // Rendered FROM the model's provenance, not from a second copy of the
  // same fact: one timestamp, one claim, however many surfaces say it.
  const replayed: PacsProvenance | undefined =
    model.provenance?.replayed === true ? model.provenance : undefined;
  const age: string | null = replayed === undefined ? null : age_describe(replayed.answeredAt);
  let rendered: string = replayed === undefined
    ? `${chalk.green(`✓ Query ${result.queryId} complete`)}\n`
    : `${chalk.green(`✓ Query ${result.queryId} — answered ${age ?? 'earlier'}`)}\n`;
  rendered += `${renderedResult}\n`;
  if (anon) {
    // The path spells the question, record number and all, and these three
    // lines exist to be read off a screen — which is the one thing that
    // must not happen here. The row's own controls still act on the real
    // path, which the surface holds and never shows.
    rendered += `${chalk.gray('  the path is held back while standing in for this answer')}\n`;
  } else {
    rendered += `${chalk.bold(`  VFS path: ${chalk.cyan(result.vfsPath)}`)}\n`;
    rendered += `${chalk.gray(`  cd ${result.vfsPath}`)}\n`;
    rendered += `${chalk.gray(`  pull ${result.vfsPath}`)}\n`;
  }
  if (replayed !== undefined) {
    // Said, never decided: mise states the age and leaves the judgement
    // with the operator, who knows whether this question can gain an
    // answer between then and now.
    rendered += `${chalk.gray(`  query ${shownExpr}${anon ? ' --anon' : ''} --fresh   # ask the PACS again`)}\n`;
  }
  return envelope_ok(rendered, { kind: PACS_QUERY_MODEL_KIND, data: model });
}
