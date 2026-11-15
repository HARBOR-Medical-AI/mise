/**
 * @file A PACS answer as a table a spreadsheet can read.
 *
 * There has been a `--csv` on listings since chili, and it renders the same
 * way this does — headers uppercased, every cell quoted, embedded quotes
 * doubled — but it renders it inside a chili handler rather than from a
 * function anything else can call. Rather than grow a dependency on a
 * package the stack is trying to shed, the rule is stated here, once, and
 * the PACS answer is the first thing to use it.
 *
 * The shape is settled by doctrine rather than by convenience: a row per
 * STUDY (or, asked with `--series`, per series), and a row for every
 * patient that owns none. The MRNs that come
 * back are the ones with imaging, so a table built from studies alone
 * would quietly drop exactly the rows an audit is asking about.
 *
 * @module
 */
import { answerNumbering_derive, handleWords_map, numberedFooter_render } from '../../session/answer.js';
import type { PacsPatient, PacsQueryModel, PacsSeries, PacsStudy } from '@fnndsc/menu';

/**
 * How far down an answer's rows go: one per STUDY (the audit's grain, and
 * the default), or one per SERIES, each carrying its study's columns so a
 * row stands on its own in a spreadsheet.
 */
export type PacsAnswerLevel = 'study' | 'series';

/** The columns of a study-level table, in reading order. */
const STUDY_COLUMNS: ReadonlyArray<string> = [
  'MRN', 'PATIENT', 'SERVER', 'STATUS', 'STUDY', 'DATE',
  'ACCESSION', 'MODALITY', 'SERIES', 'ANSWERED',
];

/**
 * The columns of a series-level table. The study's own columns lead; the
 * series follows under names that cannot be read as the study's — SERIES
 * is a count at study level, so here the series is SERIES# and SERIES
 * DESCRIPTION, and MODALITY is the series' own.
 */
const SERIES_COLUMNS: ReadonlyArray<string> = [
  'MRN', 'PATIENT', 'SERVER', 'STATUS', 'STUDY', 'DATE', 'ACCESSION',
  'SERIES#', 'SERIES DESCRIPTION', 'MODALITY', 'FILES', 'PULLED', 'ANSWERED',
];

/**
 * Quotes one cell.
 *
 * Everything is quoted, including numbers: a study description carrying a
 * comma is the ordinary case, not the edge one, and a renderer that quotes
 * only when it thinks it must is a renderer that will one day think wrong.
 *
 * @param value - The cell's value.
 * @returns The quoted cell.
 */
function cell_quote(value: unknown): string {
  return `"${String(value ?? '').split('"').join('""')}"`;
}

/** The facts a row takes from its patient rather than its study. */
interface RowFacts {
  mrn: string;
  server: string;
  status: string;
  answeredAt: string;
}

/**
 * The rows of an answer at a level, header first — the one table every
 * rendering of the answer reads, so the CSV and the screen cannot differ.
 *
 * A patient who owns no study still has a row (the audit is usually about
 * exactly them), and at series level a study with no series still has
 * one: a row per series would otherwise drop the study in silence.
 *
 * @param model - The answer.
 * @param level - One row per study, or per series.
 * @returns The columns and the rows, cells as text.
 */
export function pacsAnswer_rows(model: PacsQueryModel, level: PacsAnswerLevel = 'study'): { columns: ReadonlyArray<string>; rows: string[][]; keys: Array<string | null> } {
  const rows: string[][] = [];
  // What each row is, for the handle a screen prints beside it (`STD:<path>`,
  // `SER:<path>`); null for a row nothing numbers. Never in the CSV.
  const keys: Array<string | null> = [];
  const patients: ReadonlyArray<PacsPatient> = model.patients ?? [];
  const studiesOf = (patient: PacsPatient): PacsStudy[] =>
    model.studies.filter((study: PacsStudy): boolean =>
      study.patientId === patient.patientId
      && (patient.server === undefined || study.server === undefined || study.server === patient.server));

  const study_rows = (study: PacsStudy, facts: RowFacts): string[][] => {
    if (level === 'study') {
      keys.push(study.vfsPath === undefined ? null : `STD:${study.vfsPath}`);
      return [[
        facts.mrn, study.patientName, facts.server, facts.status, study.description, study.date,
        study.accession, study.modalities, String(study.series.length), facts.answeredAt,
      ]];
    }
    const lead: string[] = [facts.mrn, study.patientName, facts.server, facts.status, study.description, study.date, study.accession];
    if (study.series.length === 0) {
      keys.push(null);
      return [[...lead, '', '', '', '', '', facts.answeredAt]];
    }
    for (const series of study.series) keys.push(series.vfsPath === undefined ? null : `SER:${series.vfsPath}`);
    return study.series.map((series: PacsSeries, index: number): string[] => [
      ...lead,
      String(index + 1),
      series.description,
      series.modality,
      series.fileCount === undefined ? '' : String(series.fileCount),
      series.pulled === undefined ? '' : (series.pulled ? 'yes' : 'no'),
      facts.answeredAt,
    ]);
  };

  const patient_row = (patient: PacsPatient, server: string, answeredAt: string): string[] =>
    level === 'study'
      ? [patient.patientId, patient.patientName ?? '', server, patient.status, '', '', '', '', '0', answeredAt]
      : [patient.patientId, patient.patientName ?? '', server, patient.status, '', '', '', '', '', '', '', '', answeredAt];

  if (patients.length > 0) {
    for (const patient of patients) {
      const server: string = patient.server ?? model.pacsName;
      const answeredAt: string = patient.provenance?.answeredAt ?? '';
      const owned: PacsStudy[] = studiesOf(patient);
      if (owned.length === 0) {
        // The row that cannot be derived from studies, and the one an
        // audit is usually about: a patient with no imaging, or one whose
        // question could not be asked at all.
        rows.push(patient_row(patient, server, answeredAt));
        keys.push(null);
        continue;
      }
      for (const study of owned) {
        rows.push(...study_rows(study, { mrn: patient.patientId, server, status: patient.status, answeredAt }));
      }
    }
  } else {
    for (const study of model.studies) {
      rows.push(...study_rows(study, {
        mrn: study.patientId,
        server: study.server ?? model.pacsName,
        status: 'found',
        answeredAt: model.provenance?.answeredAt ?? '',
      }));
    }
  }
  return { columns: level === 'study' ? STUDY_COLUMNS : SERIES_COLUMNS, rows, keys };
}

/**
 * Renders one answer as CSV.
 *
 * ANSWERED carries the ISO timestamp rather than `3 MONTHS AGO`: a
 * spreadsheet sorts and subtracts dates, and the phrase a surface reads out
 * is for a human glance, not for a column of data.
 *
 * @param model - The answer.
 * @param level - One row per study (the default), or per series.
 * @returns The CSV text, header row first.
 */
export function pacsAnswer_renderCsv(model: PacsQueryModel, level: PacsAnswerLevel = 'study'): string {
  const { columns, rows } = pacsAnswer_rows(model, level);
  const lines: string[] = [columns.map(cell_quote).join(',')];
  for (const row of rows) lines.push(row.map(cell_quote).join(','));
  return `${lines.join('\n')}\n`;
}

/**
 * Renders one answer as an aligned table: the CSV's rows and columns, for
 * a screen. Nothing is cut: a column is as wide as its widest cell, and a
 * narrow terminal wraps rather than loses a description. ANSWERED is left
 * off — the line above the table already says when the PACS answered, and
 * an ISO stamp on every row would push the rest off the screen.
 *
 * @param model - The answer.
 * @param level - One row per study (the default), or per series.
 * @returns The table, header and rule first, uncoloured.
 */
export function pacsAnswer_renderTable(model: PacsQueryModel, level: PacsAnswerLevel = 'study'): string {
  const table = pacsAnswer_rows(model, level);
  // The handle each row answers to leads the screen's table (#1099); the
  // CSV, a record of the answer, does not carry it.
  const numbered = answerNumbering_derive('pacs.query', model) ?? [];
  const words: Map<string, string> = handleWords_map(numbered);
  // A column is earned: an answer nothing numbers (no paths yet) keeps the
  // table it always had.
  const lead: boolean = table.keys.some((key: string | null): boolean => key !== null && words.has(key));
  const columns: ReadonlyArray<string> = lead ? ['@', ...table.columns] : table.columns;
  const rows: string[][] = lead ? table.rows.map((row: string[], at: number): string[] => [words.get(table.keys[at] ?? '') ?? '', ...row]) : table.rows;
  const shown: number[] = columns.map((_: string, index: number): number => index).filter((index: number): boolean => columns[index] !== 'ANSWERED');
  const widths: number[] = shown.map((index: number): number =>
    Math.max(columns[index]?.length ?? 0, ...rows.map((row: string[]): number => (row[index] ?? '').length)));
  const line = (cells: ReadonlyArray<string>): string =>
    `  ${shown.map((index: number, at: number): string => (cells[index] ?? '').padEnd(widths[at] ?? 0)).join('  ').trimEnd()}`;
  const out: string[] = [line(columns), `  ${widths.map((width: number): string => '─'.repeat(width)).join('  ')}`];
  for (const row of rows) out.push(line(row));
  out.push('', `  ${rows.length} row${rows.length === 1 ? '' : 's'}, one per ${level}`);
  const footer: string = numberedFooter_render(numbered);
  if (footer !== '') out.push(`  ${footer}`);
  return `${out.join('\n')}\n`;
}

/** Where a written table landed, or why it did not. */
export type CsvWrite =
  | { ok: true; path: string; created?: string; replaced?: boolean }
  | { ok: false; message: string };

/**
 * Paths a file cannot be written to.
 *
 * These are providers — commands, processes, PACS queries — not storage. A
 * write into one fails inside CUBE with a message about an upload, which
 * tells an operator nothing about why the place they chose was never a
 * place at all.
 */
const VIRTUAL_PREFIXES: ReadonlyArray<string> = ['/bin', '/usr', '/etc', '/proc', '/net'];

/** How long to wait for a removed file to actually stop resolving. */
const GONE_TIMEOUT_MS: number = 10_000;
/** How often to ask whether it has. */
const GONE_POLL_MS: number = 400;

/**
 * Whether a resolved path names a provider rather than storage.
 *
 * @param resolved - An absolute CFS path.
 * @returns True when nothing can be written there.
 */
function path_isVirtual(resolved: string): boolean {
  return VIRTUAL_PREFIXES.some(
    (prefix: string): boolean => resolved === prefix || resolved.startsWith(`${prefix}/`),
  );
}

/**
 * Writes a rendered table into ChRIS storage.
 *
 * The path plumbing lives here rather than in the command: rendering a
 * table and putting it somewhere are one job, and the command should read
 * as the decision it makes rather than as the mechanics it performs.
 *
 * Imported where they are used — a CSV destination is a rare path, and
 * pulling the session and storage stacks into this module's graph would
 * load both for every query that never names one.
 *
 * The reason travels in the result rather than on the error stack, which
 * keeps this module free of any runtime import — so the renderer beside it
 * can be tested without loading the storage stack to do it.
 *
 * Four things are checked before anything is written, because a chooser
 * can hand this a place that cannot be used:
 *
 * 1. A provider path is refused BY NAME. `/net/pacs/x.csv` fails inside
 *    CUBE with a message about an upload, which says nothing about why.
 * 2. A missing parent is created, and the result says so — an operator
 *    reads what happened rather than discovering a folder later.
 * 3. An existing file is never overwritten in silence: an audit table
 *    quietly replacing another audit table is the workaround the
 *    principles forbid, so it takes `--force` to say it twice.
 * 4. The path that was actually written is returned, so a surface can
 *    state it rather than repeat what the operator typed.
 *
 * @param csv - The rendered table.
 * @param destination - Where the operator said to put it.
 * @param force - True when the operator asked to overwrite.
 * @returns The resolved path it landed on, or why it did not.
 */
export async function csvFile_write(
  csv: string,
  destination: string,
  force: boolean = false,
): Promise<CsvWrite> {
  try {
    return await csvFile_put(csv, destination, force);
  } catch (error: unknown) {
    // CUBE's failures arrive as thrown axios errors, and a throw out of a
    // builtin does not stop at the command: under a daemon it takes the
    // process, and every surface attached to it, with it. Measured — a
    // re-upload over an existing path answers 500 and threw straight
    // through this call. A store's bad day is a refusal, not an outage.
    const why: string = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${destination} could not be written: ${why}` };
  }
}

/**
 * The write itself, once the guard above owns the failures.
 *
 * @param csv - The rendered table.
 * @param destination - Where the operator said to put it.
 * @param force - True when the operator asked to replace what is there.
 * @returns The resolved path it landed on, or why it did not.
 */
async function csvFile_put(
  csv: string,
  destination: string,
  force: boolean,
): Promise<CsvWrite> {
  const { errorStack } = await import('@fnndsc/fond');
  const { storePath_resolve, error_stripDebugPrefix } = await import('../utils.js');
  const { files_create, files_delete, files_listAll, files_mkdir, files_path_isDirectory } =
    await import('@fnndsc/salsa');
  // Where the store keeps it: through a `/proc` job's `data` and any link.
  const resolved: string = await storePath_resolve(destination);

  if (path_isVirtual(resolved)) {
    return {
      ok: false,
      message: `${resolved} is a provider, not storage: nothing can be written there`,
    };
  }

  const cut: number = resolved.lastIndexOf('/');
  const parent: string = cut <= 0 ? '/' : resolved.slice(0, cut);
  const name: string = resolved.slice(cut + 1);
  if (name === '') return { ok: false, message: `${resolved} names a folder, not a file` };

  /**
   * Whether the folder already holds a file of that name.
   *
   * A null listing means the folder holds no files — `files_listAll`
   * answers null both for an empty folder and for one that is not there,
   * so existence is asked of `files_path_isDirectory` instead and never
   * inferred from this.
   */
  const taken_find = async (): Promise<{ id?: number } | null> => {
    const listed = await files_listAll({ limit: 1000, offset: 0 }, 'files', parent);
    const rows: Array<{ path?: string; fname?: string; id?: number }> = listed?.tableData ?? [];
    return rows.find((row: { path?: string; fname?: string }): boolean => {
      const candidate: string = row.path ?? row.fname ?? '';
      return candidate === resolved || candidate.slice(candidate.lastIndexOf('/') + 1) === name;
    }) ?? null;
  };

  let created: string | undefined;
  let replaced: boolean = false;
  if (!await files_path_isDirectory(parent)) {
    // The folder the operator named is not there. Making it is the ordinary
    // thing to want, so it is made — and said, since a directory appearing
    // without a word is the silent side effect this replaces.
    if (!await files_mkdir(parent)) {
      return { ok: false, message: `${parent} does not exist and could not be created` };
    }
    created = parent;
  } else {
    const standing: { id?: number } | null = await taken_find();
    if (standing !== null && !force) {
      // An audit table quietly replacing another audit table is the silent
      // workaround the principles forbid: it takes saying so twice.
      return { ok: false, message: `${resolved} already exists; pass --force to overwrite it` };
    }
    if (standing !== null) {
      // Removed, then written. CUBE answers a re-upload of a path it
      // already holds with a 500 — measured — so "overwrite" has to be
      // spelled out rather than left to the store, and the removal is
      // reported because a file disappearing unremarked is the silent act
      // this whole check exists to prevent.
      const id: number | undefined = standing.id;
      if (id === undefined || !await files_delete(id, 'files', parent)) {
        return { ok: false, message: `${resolved} exists and could not be replaced` };
      }
      // Deletion in CUBE is asynchronous — salsa's folder delete documents
      // the same thing — and writing into a path the store still holds
      // answers 500. So the removal is waited out rather than assumed,
      // which is what turned a replacement into a lost file and an error.
      let gone: boolean = false;
      for (let waited: number = 0; waited < GONE_TIMEOUT_MS; waited += GONE_POLL_MS) {
        if (await taken_find() === null) { gone = true; break; }
        await new Promise((settle: (value: unknown) => void): void => {
          setTimeout(settle, GONE_POLL_MS);
        });
      }
      if (!gone) {
        return {
          ok: false,
          message: `${resolved} was removed but the store still holds it; nothing was written`,
        };
      }
      replaced = true;
    }
  }

  const written: boolean = await files_create(csv, resolved);
  if (written) {
    // Confirmed, not assumed. A create straight after making its folder has
    // been seen to report success and leave nothing behind, and a table an
    // operator believes they have is worse than one they know they lack.
    if (await taken_find() === null) {
      return {
        ok: false,
        message: `${resolved} was reported written but is not there; try again`,
      };
    }
    // The folder's cached listing is now wrong, and nothing else will say
    // so: the write went straight to CUBE, while `ls` and every browser
    // read the cache. The operator exported a table, opened the folder it
    // named, and saw everything except the file they had just written —
    // which reads exactly like the export doing nothing. Every fs verb
    // invalidates what it changed; this one now does too.
    const { listCache_get } = await import('@fnndsc/cumin');
    listCache_get().cache_invalidate(parent);
    if (created !== undefined) {
      // The folder itself is new, so the listing that would show IT is
      // stale as well.
      const above: number = parent.lastIndexOf('/');
      listCache_get().cache_invalidate(above <= 0 ? '/' : parent.slice(0, above));
    }
    return {
      ok: true,
      path: resolved,
      ...(created === undefined ? {} : { created }),
      ...(replaced ? { replaced: true } : {}),
    };
  }
  const problem: { message: string } | undefined = errorStack.stack_pop();
  // Stripped where it is read: a refusal an operator acts on should not
  // arrive wearing the stack's debugging prefix.
  const why: string = problem === undefined ? 'refused' : error_stripDebugPrefix(problem.message);
  return { ok: false, message: `could not write ${resolved}: ${why}` };
}
