/**
 * @file The PACS workspace: query, retrieve, gather, materialize.
 *
 * Pull is a FETCH, and gather is a CHOICE, and they are not the same
 * gesture. Pulling brings a series home to CUBE; gathering puts it in the
 * session's cohort, which the header band shows and a run is given. When
 * the cohort was this pane's own tray, pulling doubled as selecting; once
 * the cohort became the session's — shared by every pane and by the
 * kernel's own `gather` — a fetch that also selected was a cross-coupling
 * the operator caught ("PULLING something does not mean it's gathered").
 * The cohort is built only by GATHER: a row's, a study's, the table's, or
 * the kernel verb's. Materializing writes a `~/gather/<name>` manifest and
 * can root a new feed on the cohort in one command — PACS Q/R as the front
 * door of the data-state machine.
 *
 * Everything lowers to commands: the form regenerates an *editable*
 * `pacs query ...` line (run as edited); a series' PULL runs
 * `pull <series-vfs-path>`; CREATE FEED runs `pull --new-feed` over the
 * curated paths — idempotent, so already-retrieved series simply confirm.
 * Retrieve progress arrives on the typed progress channel, keyed by series
 * UID, and drives the row badges.
 *
 * A query's answer is a LISTING, and it is the same listing the file
 * browser and the runs roster are: columns declared once, a frame that
 * sorts and filters, actions outside the grid, progress at every level. It
 * differs only in mode — a study **folds** its series open in place rather
 * than replacing itself with them, which is what levels mean when the
 * level above is still worth seeing.
 *
 * @module
 */
import {
  pacsQueryModelSchema,
  pacsServersModelSchema,
  PACS_QUERY_MODEL_KIND,
  PACS_SERVERS_MODEL_KIND,
  type PacsPatient,
  type PacsProvenance,
  type PacsQueryModel,
  type PacsSeries,
  type PacsServer,
  type PacsStudy,
  type WireEnvelope,
  patientAddress_format,
} from '@fnndsc/menu';
import type { ProgressMessage } from '../../calypso/client.js';
import { Listing, listingChild_declare, type ListingStateParts } from '../roster/listing.js';
import { PACS_SERIES_ROSTER, PACS_STUDY_ROSTER, verbRule_get, type PacsSeriesFacts } from '../roster/verbs.js';
import type { GatherSeries } from '../gather/panel.js';
import {
  progress_aggregate, progressCell_build,
  type ListingAction, type ListingProgress, type ListingTrait,
} from '../roster/row.js';
import { PACS_LEAD_TRACKS } from './tracks.js';

/** What the workspace asks of its host. */
export interface PacsPanelHandlers {
  /** Runs an instrument command silently. */
  command_run: (line: string) => void;
  /** Runs a command visibly in the console (the big, auditable actions). */
  command_show: (line: string) => void;
  /**
   * Says something in the transcript that is not a command: what a set act
   * did, member by member. A readout on the frame would be wiped by the
   * repaint the act itself causes, and what became of a set is worth
   * keeping in the scrollback anyway.
   */
  note: (text: string) => void;
  /** The mars pill: dismiss this workspace. */
  workspace_close: () => void;
  /** Opens a pulled series' folder as an image beside the workspace. */
  image_open: (folderPath: string) => void;
  /** Opens the series' folder as a file browser, joined to its group. */
  dir_open: (folderPath: string) => void;
  /** Opens a catalogue bound to a folder (a series', or a whole study's), to run something on it. */
  process_open: (folderPath: string) => void;
  /** Gathers a series into the cohort: the GATHER pane beside the workspace takes it. */
  gather_add: (entry: GatherSeries) => void;
  /** Whether the cohort on stage holds this series (lights the row's GATHER). */
  gathered_is: (seriesUID: string) => boolean;
}

/**
 * A series as the verb roster sees it.
 *
 * @param series - The series as the model holds it.
 * @returns Its facts.
 */
export function seriesFacts_derive(series: PacsSeries): PacsSeriesFacts {
  return {
    inCube: series.pulled === true,
    folderKnown: series.folderPath !== undefined,
    addressable: series.vfsPath !== undefined,
  };
}

/**
 * Which verbs a series offers, as a fact about the series alone.
 *
 * Pure and exported because this is the thing that was wrong: a series the
 * wire had just landed kept offering PULL, because nothing turned it over
 * until the operator re-ran the query. A control that has already acted
 * must say so, and a rule this small deserves a test that does not need a
 * PACS to run.
 *
 * IMAGE needs the folder CUBE put the series in, which only the kernel can
 * name: the pull says it on the retrieve channel once CUBE has filed the
 * series, and the row takes it from there. A folder the pull could not
 * name arrives with the next answer. GATHER does not wait.
 *
 * @param series - The series as the model holds it.
 * @returns Which of the three verbs are offered.
 */
/**
 * The folder a whole study can be processed as: the parent every series'
 * folder shares, known only once every series is home with its folder named.
 *
 * @param study - The study.
 * @returns The folder, or null when any series is not yet home.
 */
export function studyFolder_derive(study: PacsStudy): string | null {
  if (study.series.length === 0) return null;
  const parents: string[] = [];
  for (const series of study.series) {
    if (series.pulled !== true || series.folderPath === undefined) return null;
    parents.push(series.folderPath.replace(/\/[^/]+\/?$/, ''));
  }
  const first: string = parents[0] ?? '';
  return parents.every((parent: string): boolean => parent === first) && first !== '' ? first : null;
}

export function seriesVerbs_offered(series: PacsSeries): { gather: boolean; image: boolean; dir: boolean; pull: boolean } {
  const facts: PacsSeriesFacts = seriesFacts_derive(series);
  const offers = (name: string): boolean => verbRule_get(PACS_SERIES_ROSTER, name).offered(facts);
  return { gather: offers('gather'), image: offers('image'), dir: offers('dir'), pull: offers('pull') };
}

/**
 * Records that a series has landed, in every row that shows it.
 *
 * The rows are built from `model.studies` at every level, so marking the
 * model is what makes a patient's, a study's and a series' row agree.
 *
 * The folder is what turns IMAGE on. A retrieve is confirmed by count and
 * filed by CUBE a beat later, so the wire says "done" twice: once without
 * the place and once with it. The second message changes the row even
 * though the series was already marked home.
 *
 * @param model - The answer on stage.
 * @param seriesUID - The series the wire reported done.
 * @param files - How many files landed, when the wire said.
 * @param folderPath - Where CUBE filed the series, when the wire said.
 * @returns Whether anything changed, so a caller can skip a needless repaint.
 */
export function seriesPulled_mark(
  model: PacsQueryModel,
  seriesUID: string,
  files: number | undefined,
  folderPath?: string,
): boolean {
  let changed: boolean = false;
  for (const study of model.studies) {
    for (const series of study.series) {
      if (series.seriesUID !== seriesUID) continue;
      if (folderPath !== undefined && series.folderPath !== folderPath) {
        series.folderPath = folderPath;
        changed = true;
      }
      if (series.pulled === true) continue;
      series.pulled = true;
      if (files !== undefined && files > 0) series.pulledFiles = files;
      changed = true;
    }
  }
  return changed;
}

/**
 * One CSV field, quoted when it has to be.
 *
 * A series description carries commas and the odd quotation mark, and a
 * table that splits on the wrong comma is worse than no table.
 *
 * @param value - The field.
 * @returns It, quoted if it holds a comma, a quote or a line break.
 */
function csvField_quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

/**
 * One row of the series listing: the series, and the study it belongs to.
 *
 * A row carries its parent because its verbs need it — gathering a series
 * records the patient it came from, which the series alone does not know.
 */
interface SeriesRow {
  study: PacsStudy;
  studyKey: string;
  series: PacsSeries;
}

/** One row of the study listing: the level above the series. */
interface StudyRow {
  study: PacsStudy;
  key: string;
}

/**
 * One row of the patient listing: the outermost level.
 *
 * The row exists whether or not the patient has studies, which is the whole
 * point of the level — the MRNs that come back are by definition the ones
 * WITH imaging, so an answer built only from studies cannot say which of
 * the asked patients had none.
 */
interface PatientRow {
  patient: PacsPatient;
  key: string;
  studies: PacsStudy[];
}

/** What a series' badge is currently saying. */
export interface BadgeState {
  status: string;
  current?: number;
  total?: number;
  /** Why it ended badly, when the kernel said (shown on hover, and in the console's summary). */
  reason?: string;
}

/**
 * The form fields and the query terms they lower to, in the STUDY caps'
 * order — the form stands where the answer will, so a term sits in the
 * column it fills and the generated line reads left to right as the
 * listing does.
 */
const FORM_TERMS: ReadonlyArray<{ id: string; term: string }> = [
  { id: 'pacs-f-name', term: 'PatientName' },
  { id: 'pacs-f-mrn', term: 'PatientID' },
  { id: 'pacs-f-date', term: 'StudyDate' },
  { id: 'pacs-f-accession', term: 'AccessionNumber' },
  { id: 'pacs-f-modality', term: 'Modality' },
];

/**
 * Badge text for the states that read the same whatever was counted. A pull
 * that ended without its files reads by what did arrive, which
 * {@link badgeText_compose} says.
 */
const BADGE_TEXT: Readonly<Record<string, string>> = {
  running: 'RETRIEVING',
  done: '✓ PULLED',
  error: '✗ ERROR',
  queued: 'QUEUED',
  idle: 'NOT RETRIEVED',
};

/** What a series reads when its pull ended and none of its files came. */
const NOT_RECEIVED_TEXT: string = 'NOT RECEIVED';

/** Why a series was settled by its pull's end rather than by its own last word. */
const PULL_ENDED_REASON: string = 'the pull ended without saying what became of this series';

/**
 * Whether a pull is in flight for a series: asked for and waiting its turn,
 * or being sent. A bar moves for these two states and for no other, since
 * motion on a row says something is still coming.
 *
 * @param state - The series' state.
 * @returns True while the pull is queued or running.
 *
 * @example
 * ```ts
 * badge_checkIsInFlight({ status: 'queued' }); // true
 * badge_checkIsInFlight({ status: 'unconfirmed' }); // false
 * ```
 */
export function badge_checkIsInFlight(state: BadgeState): boolean {
  return state.status === 'running' || state.status === 'queued';
}

/**
 * The words a series reads once its pull has ended without its files.
 *
 * Each says what was seen, never more: none of the files came (`NOT
 * RECEIVED`), some came and then stopped (`STOPPED AT 12/40`), they came for
 * too long without ending (`TIMED OUT AT 12/40`), the watch lost sight of a
 * series that was arriving (`? UNCONFIRMED 12/40`), or the retrieve failed
 * (`✗ ERROR`). The tick belongs to files in CUBE alone.
 *
 * @param state - The series' state, which is not in flight and not done.
 * @returns The badge's text. A status with no words of its own reads as its
 *   name in capitals.
 *
 * @example
 * ```ts
 * badgeText_compose({ status: 'unconfirmed', current: 0, total: 1 }); // 'NOT RECEIVED'
 * badgeText_compose({ status: 'stalled', current: 12, total: 40 }); // 'STOPPED AT 12/40'
 * ```
 */
export function badgeText_compose(state: BadgeState): string {
  const received: number = state.current ?? 0;
  const counted: string = state.total !== undefined && state.total > 0 ? `${received}/${state.total}` : String(received);
  switch (state.status) {
    case 'unconfirmed': return received === 0 ? NOT_RECEIVED_TEXT : `? UNCONFIRMED ${counted}`;
    case 'stalled': return received === 0 ? NOT_RECEIVED_TEXT : `STOPPED AT ${counted}`;
    case 'timeout': return received === 0 ? NOT_RECEIVED_TEXT : `TIMED OUT AT ${counted}`;
    default: return BADGE_TEXT[state.status] ?? state.status.toUpperCase();
  }
}

/**
 * What a series still in flight becomes when its pull ends without a last
 * word on it: ended, with whatever count it had reached, and a reason.
 *
 * @param held - The series' state when the pull's end arrived.
 * @returns The ended state, or null when the series was not in flight and
 *   its own last word stands.
 *
 * @example
 * ```ts
 * badgeState_settle({ status: 'queued' }); // { status: 'unconfirmed', current: 0, reason: '…' }
 * badgeState_settle({ status: 'done', total: 40 }); // null
 * ```
 */
export function badgeState_settle(held: BadgeState): BadgeState | null {
  if (!badge_checkIsInFlight(held)) return null;
  return {
    status: 'unconfirmed',
    current: held.current ?? 0,
    ...(held.total !== undefined ? { total: held.total } : {}),
    reason: PULL_ENDED_REASON,
  };
}

/** What re-asking lowers to. */
const FRESH_FLAG: string = '--fresh';

/** What standing in for an answer's people lowers to. */
const ANON_FLAG: string = '--anon';

/** Matches the flag anywhere on the line, so it is never doubled. */
const ANON_FLAG_PATTERN: RegExp = /\s*--anon\b/;

/** The form fields that name a person, masked while ANON is on. */
const IDENTIFYING_FIELDS: ReadonlyArray<string> = ['pacs-f-name', 'pacs-f-mrn', 'pacs-f-accession', 'pacs-f-date'];

/** Matches the flag anywhere on the line, so it is never doubled. */
const FRESH_FLAG_PATTERN: RegExp = /\s*--fresh\b/;

/**
 * How long ago something was, in the coarsest true unit.
 *
 * The elapsed time is the half an operator acts on — three months reaches
 * for RE-QUERY where four hours does not — while the date beside it is the
 * half worth quoting into a note. Neither is a judgement the surface makes.
 *
 * @param at - An ISO timestamp.
 * @returns A phrase like `3 MONTHS AGO`, or null when the stamp is unusable.
 */
function elapsed_describe(at: string): string | null {
  const then: number = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const seconds: number = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: ReadonlyArray<{ limit: number; size: number; name: string }> = [
    { limit: 60, size: 1, name: 'SECOND' },
    { limit: 3600, size: 60, name: 'MINUTE' },
    { limit: 86400, size: 3600, name: 'HOUR' },
    { limit: 2592000, size: 86400, name: 'DAY' },
    { limit: 31536000, size: 2592000, name: 'MONTH' },
    { limit: Infinity, size: 31536000, name: 'YEAR' },
  ];
  for (const unit of units) {
    if (seconds >= unit.limit) continue;
    const count: number = Math.max(1, Math.floor(seconds / unit.size));
    return `${count} ${unit.name}${count === 1 ? '' : 'S'} AGO`;
  }
  return null;
}

/**
 * A study keeps its place and opens its series inside it.
 *
 * The other two panes `replace`: entering a directory or a feed leaves the
 * level above behind. A PACS result cannot, because the operator is
 * comparing studies while reading one — so the parent stays on stage.
 */

/**
 * The PACS workspace controller.
 */
/**
 * A series' STATE cell, as the PACS listing paints it.
 *
 * Exported because a cohort shows the SAME series: GATHER is an organized
 * subset of the answer, not a second kind of thing, so it reads the same
 * columns from the same declaration rather than describing a series twice
 * in two vocabularies that drift apart.
 *
 * @param series - The series.
 * @returns The badge.
 */
/**
 * Every badge element on stage for a series, wherever it is shown.
 *
 * A cohort is a REFLECTION of the same truth, not a copy of it: the series
 * pulled from the PACS listing is the series in the cohort, so a retrieve
 * has to move both. Keyed by UID and holding a set, because the same
 * series legitimately appears in more than one pane at once; disconnected
 * elements are dropped as they are found rather than tracked.
 */
const badgeElements: Map<string, Set<HTMLElement>> = new Map();

/**
 * Registers a badge so the wire's progress repaints it.
 *
 * @param seriesUID - The series it belongs to.
 * @param badge - The element.
 */
function badgeElement_register(seriesUID: string, badge: HTMLElement): void {
  const held: Set<HTMLElement> = badgeElements.get(seriesUID) ?? new Set();
  held.add(badge);
  badgeElements.set(seriesUID, held);
}

/**
 * Runs a paint over every badge standing for a series, dropping the ones
 * that have left the document.
 *
 * @param seriesUID - The series.
 * @param paint - What to do to each badge.
 */
/**
 * The last state the wire reported per series. A row built after the pull
 * — the cohort rebuilt by SAVE, a listing redrawn — asks here, so a series
 * pulled a minute ago does not come back reading NOT RETRIEVED.
 */
const badgeStateLast: Map<string, BadgeState> = new Map();

/**
 * Paints a badge from what its series is doing.
 *
 * Done is a FULL BAR with the count beside it, the same drawing a series
 * already in CUBE gets when the answer arrives: it used to be the word
 * PULLED alone, so a series the operator had just watched fill read unlike
 * the one above it that had been home all along.
 *
 * A pull that ended without its files is one statement with no bar, its
 * reason on the badge's title: only a pull in flight has a bar that moves.
 *
 * @param badge - The badge element.
 * @param state - The series' state.
 *
 * @example
 * ```ts
 * badge_paint(badge, { status: 'unconfirmed', current: 0, total: 1, reason: 'the PACS sent nothing' });
 * badge.textContent; // 'NOT RECEIVED'
 * ```
 */
export function badge_paint(badge: HTMLElement, state: BadgeState): void {
  badge.replaceChildren();
  badge.dataset['state'] = state.status;
  if (state.reason !== undefined) badge.title = state.reason;
  else badge.removeAttribute('title');
  const note: HTMLSpanElement = document.createElement('span');
  note.className = 'pacs-badge-note';

  if (state.status === 'idle') {
    note.textContent = BADGE_TEXT['idle'] ?? 'NOT RETRIEVED';
    badge.append(progressCell_build({ done: 0, total: 0 }), note);
    return;
  }
  if (state.status === 'done') {
    const bar: HTMLSpanElement = document.createElement('span');
    bar.className = 'pacs-bar-full';
    note.textContent = state.total !== undefined && state.total > 0 ? `✓ ${state.total} IN CUBE` : '✓ IN CUBE';
    badge.append(bar, note);
    return;
  }
  if (!badge_checkIsInFlight(state)) {
    badge.textContent = badgeText_compose(state);
    return;
  }
  // A running pull shows how far it has got, not just that it is going.
  // Without a total there is no fraction to draw, and before the first file
  // there is nothing to fill: the bar paces instead — still motion, still
  // honest about knowing no better. (A fired pull says its total at once,
  // so a waiting series drew a still, empty bar that read as stuck.)
  const counted: string = state.total !== undefined ? ` ${state.current ?? 0}/${state.total}` : '';
  const fraction: number | null = badgeFraction_compute(state);
  const track: HTMLSpanElement = document.createElement('span');
  track.className = fraction === null ? 'pacs-bar pacs-bar-pacing' : 'pacs-bar';
  const fill: HTMLSpanElement = document.createElement('span');
  fill.className = 'pacs-bar-fill';
  if (fraction !== null) fill.style.width = `${Math.round(fraction * 100)}%`;
  track.appendChild(fill);
  note.textContent = state.status === 'queued'
    ? (BADGE_TEXT['queued'] ?? 'QUEUED')
    : `${BADGE_TEXT['running']}${counted}`;
  badge.append(track, note);
}

/**
 * How full a pull's bar is, or null when it should pace: queued, no total
 * to divide by, or fired and waiting on its first file.
 *
 * @param state - The series' state.
 * @returns The fraction, 0..1, or null to pace.
 */
export function badgeFraction_compute(state: BadgeState): number | null {
  if (state.status === 'queued' || state.total === undefined || state.total === 0 || (state.current ?? 0) === 0) return null;
  return Math.min(1, (state.current ?? 0) / state.total);
}

/**
 * Whether an answer finding a series home in CUBE outranks what the wire
 * last said of it: it does over a pull that ended badly (the files arrived,
 * whatever the watch saw), never over one still in flight.
 *
 * @param series - The series as the answer has it.
 * @param held - What the wire last said.
 * @returns True when the answer's word stands.
 */
export function answer_outranksBadge(series: Pick<PacsSeries, 'pulled'>, held: BadgeState): boolean {
  return series.pulled === true && held.status !== 'done' && held.status !== 'running' && held.status !== 'queued';
}

function badgeElements_paint(seriesUID: string, paint: (badge: HTMLElement) => void): void {
  const held: Set<HTMLElement> | undefined = badgeElements.get(seriesUID);
  if (held === undefined) return;
  for (const badge of [...held]) {
    if (!badge.isConnected) { held.delete(badge); continue; }
    paint(badge);
  }
  if (held.size === 0) badgeElements.delete(seriesUID);
}

export function seriesBadge_build(series: PacsSeries): HTMLElement {
  const badge: HTMLSpanElement = document.createElement('span');
  badge.className = 'pacs-badge';
  if (series.pulled === true) {
    const bar: HTMLSpanElement = document.createElement('span');
    bar.className = 'pacs-bar-full';
    const note: HTMLSpanElement = document.createElement('span');
    note.className = 'pacs-badge-note';
    note.textContent = series.pulledFiles !== undefined ? `✓ ${series.pulledFiles} IN CUBE` : '✓ IN CUBE';
    badge.append(bar, note);
    badge.dataset['state'] = 'done';
    return badge;
  }
  // Nothing asked of it yet: a dim track rather than an empty cell, which
  // would read as a column that does not apply here.
  const track: HTMLSpanElement = document.createElement('span');
  track.className = 'pacs-bar';
  const note: HTMLSpanElement = document.createElement('span');
  note.className = 'pacs-badge-note';
  note.textContent = 'NOT RETRIEVED';
  badge.append(track, note);
  badge.dataset['state'] = 'idle';
  // Registered wherever it stands: a cohort's row moves with the pull the
  // same as the answer's row does, because they are the same series — and
  // a row built after the pull reads what the pull last said.
  badgeElement_register(series.seriesUID, badge);
  const last: BadgeState | undefined = badgeStateLast.get(series.seriesUID);
  if (last !== undefined) badge_paint(badge, last);
  return badge;
}

/**
 * What a series row shows, wherever it is shown.
 *
 * @param series_of - Reads the series out of the pane's own row type.
 * @param badge_of - Builds the STATE cell; the PACS pane's registers its
 *   badge for live progress, a cohort's paints the state it can see.
 * @returns The traits, in cap order.
 */
export function seriesTraits_build<T>(
  series_of: (row: T) => PacsSeries,
  badge_of: (series: PacsSeries) => HTMLElement,
): Array<ListingTrait<T>> {
  return [
    {
      key: 'series',
      label: 'SERIES',
      className: 'pacs-series-desc',
      width: '35.5em',
      cell: (row: T): string => series_of(row).description ?? '',
    },
    {
      key: 'state',
      label: 'STATE',
      className: 'pacs-badge',
      width: '1fr',
      cell: (row: T): HTMLElement => badge_of(series_of(row)),
      compare: (row: T): string => (series_of(row).pulled === true ? 'done' : 'idle'),
    },
    {
      key: 'modality',
      label: 'MODALITY',
      className: 'pacs-series-modality',
      width: '4em',
      cell: (row: T): string => series_of(row).modality,
    },
    {
      key: 'files',
      label: 'FILES',
      className: 'pacs-series-files',
      width: '6em',
      cell: (row: T): string => {
        const count: number | undefined = series_of(row).fileCount;
        return count !== undefined ? `${count} FILES` : '';
      },
      compare: (row: T): number => series_of(row).fileCount ?? -1,
    },
  ];
}

export class PacsPanel {
  private readonly root: HTMLElement;
  private readonly command: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly handlers: PacsPanelHandlers;
  /**
   * The series folders that currently have a viewer or a browser on THIS
   * surface's stage, by folder path — the live source for lighting the IMAGE
   * and DIR verbs. Set by `stage_lit` on every stage change; empty means
   * nothing of that series is open here.
   */
  private litFolders: Map<string, { viewer: boolean; browser: boolean }> = new Map();

  private readonly badgeStates: Map<string, BadgeState> = new Map();
  /** The series each pull in flight has reported on, by the pull's command id. */
  private readonly pullSeries: Map<string, Set<string>> = new Map();
  /** Per-series progress, seeded from the model and driven by the wire. */
  private readonly seriesProgress: Map<string, ListingProgress> = new Map();
  /** Each study's progress mount and the series it sums over. */
  private readonly studyTracks: Map<string, { mount: HTMLElement; uids: string[] }> = new Map();
  private readonly traits: ReadonlyArray<ListingTrait<SeriesRow>>;
  private readonly actions: ReadonlyArray<ListingAction<SeriesRow>>;
  private readonly studyTraits: ReadonlyArray<ListingTrait<StudyRow>>;
  private readonly studyActions: ReadonlyArray<ListingAction<StudyRow>>;
  private readonly patientTraits: ReadonlyArray<ListingTrait<PatientRow>>;
  /** The three levels, declared once into the listing façade. */
  private readonly listing: Listing<PatientRow>;
  /** Each patient's progress mount and the series it sums over. */
  private readonly patientTracks: Map<string, { mount: HTMLElement; uids: string[] }> = new Map();
  /**
   * Says when an answer was answered, when it was not answered just now.
   *
   * A readout rather than a capsule: it sits beside a real control, and a
   * capsule shape here would promise a press it cannot answer.
   */
  private readonly provenance: HTMLElement;
  /** QUERY, or RE-QUERY while a replayed answer is on stage. */
  private readonly run: HTMLElement;
  private model: PacsQueryModel | null = null;
  /** Whether the answer on stage came from a stored query. */
  /**
   * True while the pane stands in for what an answer says about a person.
   *
   * A pre-query mode, not a view: the substitution happens in the kernel,
   * so an answer already on stage was fetched one way or the other and
   * cannot be turned. Toggling therefore clears what is shown rather
   * than leaving rows whose state nobody could name.
   */
  private anon: boolean = false;

  /** True while the operator is looking at what they typed. */
  private revealed: boolean = false;

  private readonly anonPill: HTMLButtonElement;

  private readonly revealPill: HTMLButtonElement;

  private replayed: boolean = false;
  /** The cell that reads which servers are chosen, and unfolds the strip. */
  private readonly serverCell: HTMLElement;
  /** The strip of server segments, one per registered PACS. */
  private readonly serverStrip: HTMLElement;
  /** Every registered server, once the session has been asked. */
  private servers: ReadonlyArray<PacsServer> = [];
  /** The identifiers currently chosen. Empty means the session's own. */
  private readonly chosen: Set<string> = new Set<string>();

  /**
   * @param root - The `#pacs-workspace` element.
   * @param handlers - Host callbacks.
   */
  constructor(root: HTMLElement, handlers: PacsPanelHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.command = element_input(root, '#pacs-command');
    this.results = element_query(root, '#pacs-results');
    this.traits = this.traits_declare();
    this.actions = this.actions_declare();
    this.studyTraits = this.studyTraits_declare();
    this.studyActions = this.studyActions_declare();
    this.patientTraits = this.patientTraits_declare();
    // Three levels, one declaration each, one frame: the PATIENT caps head
    // the region; a patient's STUDY caps are minted inside it when it opens,
    // and a study's SERIES caps inside that. One filter strip reads down
    // the levels, one sort names its level, and the bar is written by the
    // façade through a composer that puts the answer's tally ahead of the
    // view's summary. The fold glyph is each folding row's own leading
    // cell, drawn by the stylesheet from the group's open state.
    this.listing = new Listing<PatientRow>({
      mount: this.results,
      traits: this.patientTraits,
      key: (row: PatientRow): string => row.key,
      chrome: { root, prefix: 'pacs' },
      // A row's verbs live in the frame: a study's PULL STUDY and a
      // series' GATHER / IMAGE / DIR / PULL are drawn in the row zone the
      // façade mints into the listing's frame; no level reserves a track.
      // A patient with no studies has nothing to unfold, and a glyph
      // promising otherwise is a control that cannot act.
      activatable: (row: PatientRow): boolean => row.studies.length > 0,
      // A patient is numbered in its own sequence (`@PAT001`) and hands a
      // verb every series of theirs; one the PACS answered nothing for has
      // nothing to hand and counts itself dim.
      address: (row: PatientRow): string | undefined => (row.studies.length > 0 ? patientAddress_format(row.patient) : undefined),
      // Navigating is not selecting: the fold cell folds, the row selects.
      control: 'fold',
      row: {
        className: (): string => 'pacs-patient-row',
        groupClassName: (row: PatientRow): string =>
          row.patient.status === 'unasked' ? 'pacs-patient pacs-patient-unasked' : 'pacs-patient',
        decorate: (element: HTMLElement, row: PatientRow): void => {
          if (row.studies.length > 0) element.title = 'unfold this patient\'s studies (the patient keeps its place)';
        },
      },
      child: listingChild_declare(
        (row: PatientRow): ReadonlyArray<StudyRow> =>
          row.studies.map((study: PacsStudy, index: number): StudyRow => ({ study, key: study_key(study, index) })),
        {
          traits: this.studyTraits,
          key: (row: StudyRow): string => row.key,
          // A study is numbered in its own sequence (`@STD001`) and hands a
          // verb its series, as the row's own GATHER does.
          address: (row: StudyRow): string | undefined => row.study.vfsPath,
          // Two intents, two targets: the fold cell unfolds the series (no
          // selection, the field stays lit); the rest of the row indicates
          // the study and puts PULL STUDY in the frame, without folding.
          control: 'fold',
          actions: { of: (): ReadonlyArray<ListingAction<StudyRow>> => this.studyActions },
          row: {
            className: (): string => 'pacs-study-row',
            groupClassName: (): string => 'pacs-study',
            decorate: (element: HTMLElement): void => {
              element.title = 'unfold this study\'s series (the study keeps its place)';
            },
          },
          child: listingChild_declare(
            (row: StudyRow): ReadonlyArray<SeriesRow> =>
              row.study.series.map((series: PacsSeries): SeriesRow => ({ study: row.study, studyKey: row.key, series })),
            {
              traits: this.traits,
              key: (row: SeriesRow): string => row.series.seriesUID,
              // The kernel numbers a PACS answer by its SERIES, addressed
              // by VFS path; the patient and study levels above carry no
              // pill, because a number nothing answers to is a lie.
              address: (row: SeriesRow): string | undefined => row.series.vfsPath,
              // A series is a leaf: a click indicates it and its verbs
              // (gather it, open it, browse it, pull it) go to the frame;
              // activating it does nothing, since its verbs are the whole
              // of what it does.
              actions: { of: (): ReadonlyArray<ListingAction<SeriesRow>> => this.actions },
              row: {
                className: (): string => 'pacs-series',
                decorate: (element: HTMLElement, row: SeriesRow): void => {
                  element.dataset['seriesuid'] = row.series.seriesUID;
                },
              },
            },
          ),
        },
      ),
      state: (parts: ListingStateParts): string => this.stateLine_compose(parts),
      empty: (): HTMLElement => element_note('NO STUDIES FOUND'),
    });
    // The form stands on the STUDY grid (a-form-stands-where-its-answer-will):
    // the workspace carries that level's template, computed by the façade.
    root.style.setProperty('--roster-cols', this.listing.template_get(1));
    // The frame is seated before the first query, so FILTER means something
    // the moment the pane is on stage rather than only after an answer.
    this.listing.rows_set([], { field: 'pacs' });

    for (const { id } of FORM_TERMS) {
      const field: HTMLInputElement = element_input(root, `#${id}`);
      field.addEventListener('input', (): void => this.command_regenerate());
      // Enter in any term runs the query. Filling a field and pressing
      // return is what a form means; making the operator reach for the
      // button afterwards is a step the gesture already stated.
      field.addEventListener('keydown', (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.query_run();
        }
      });
    }
    this.serverCell = element_query(root, '#pacs-f-server');
    this.serverStrip = element_query(root, '#pacs-server-strip');
    this.serverCell.addEventListener('click', (): void => this.serverStrip_toggle());
    this.serverCell_sync();
    this.provenance = element_query(root, '#pacs-provenance');
    this.anonPill = element_query(root, '#pacs-anon') as HTMLButtonElement;
    this.revealPill = element_query(root, '#pacs-reveal') as HTMLButtonElement;
    this.anonPill.addEventListener('click', (): void => this.anon_set(!this.anon));
    this.revealPill.addEventListener('click', (): void => this.reveal_set(!this.revealed));
    this.run = element_query(root, '#pacs-run');
    // The control carries the intent; the line carries the command.
    this.run.addEventListener('click', (): void => this.query_run(this.replayed));
    this.command.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key === 'Enter') this.query_run();
    });
    element_query(root, '#pacs-export').addEventListener('click', (): void => this.answer_export());
    // GATHER acts on the FIELD, so it rides the frame that answers to the
    // field. What the listing is showing IS the filtered set, so filtering
    // to `sag` and pressing this gathers the sag series and nothing else.
    // It takes the SERIES the filter left standing, never the studies they
    // hang under: a study survives because a child matched, and sweeping
    // its other series in would gather exactly what the filter excluded.
    element_query(root, '#pacs-gather-shown').addEventListener('click', (): void => this.shown_gather());
    // The frame's own verb: retrieve everything the listing is showing.
    element_query(root, '#pacs-pull-shown').addEventListener('click', (): void => this.shown_pull());
  }

  /**
   * The patient listing's columns: the outermost level.
   *
   * The level exists for the rows that carry no studies. A cohort's useful
   * answer is usually the MRNs WITHOUT imaging, and those rows can only
   * come from the record of what was asked — nothing derived from studies
   * can mention a patient who has none.
   *
   * ANSWERED carries the row's own age, since a fan-out replays some rows
   * and troubles the PACS for others; sorting by it lifts the stale rows to
   * the top. A row that could not be asked reads UNASKED there, in the
   * error hue, because a dash alone would read as "no answer yet" and a
   * zero would read as "no imaging" — which is the one thing it must never
   * be mistaken for.
   *
   * @returns The traits, in cap order.
   */
  private patientTraits_declare(): ReadonlyArray<ListingTrait<PatientRow>> {
    return [
      {
        // The fold glyph is the row's own leading cell: it sits in the grid
        // so every cap keeps its column, and the stylesheet draws it from
        // the group's open state. A patient with no studies shows none.
        key: 'fold',
        label: '',
        className: 'pacs-fold',
        capped: false,
        // The cell is the fold CONTROL, drawn as a capsule that reads what
        // it will do next (OPEN, CLOSE); the track holds the longer word.
        width: PACS_LEAD_TRACKS.fold,
        cell: (row: PatientRow): HTMLElement => {
          const fold: HTMLSpanElement = document.createElement('span');
          fold.className = row.studies.length === 0 ? 'pacs-fold pacs-fold-none' : 'pacs-fold';
          return fold;
        },
      },
      {
        key: 'patient',
        label: 'PATIENT',
        className: 'pacs-patient-name',
        width: PACS_LEAD_TRACKS.patient,
        cell: (row: PatientRow): string => row.patient.patientName || '(unknown)',
      },
      {
        key: 'mrn',
        label: 'MRN',
        className: 'pacs-patient-mrn',
        width: PACS_LEAD_TRACKS.mrn,
        cell: (row: PatientRow): string => row.patient.patientId || '—',
      },
      {
        key: 'answered',
        label: 'ANSWERED',
        className: 'pacs-patient-answered',
        width: '12em',
        cell: (row: PatientRow): HTMLElement => {
          const said: HTMLSpanElement = document.createElement('span');
          said.className = row.patient.status === 'unasked'
            ? 'pacs-patient-answered pacs-unasked'
            : 'pacs-patient-answered';
          if (row.patient.status === 'unasked') {
            said.textContent = 'UNASKED';
            // The reason is the operator's next move; the row states the
            // fact and the title carries what went wrong.
            if (row.patient.error !== undefined) said.title = row.patient.error;
            return said;
          }
          const at: string | undefined = row.patient.provenance?.answeredAt;
          said.textContent = at === undefined ? '—' : (elapsed_describe(at) ?? '—');
          if (at !== undefined) said.title = at;
          return said;
        },
        // Ascending puts the oldest first, which is what sorting on this
        // column is for. A row with no answer is not old — it is absent —
        // so it sorts to the far end rather than pretending to be stale.
        compare: (row: PatientRow): number => {
          const at: string | undefined = row.patient.provenance?.answeredAt;
          if (at === undefined) return Number.MAX_SAFE_INTEGER;
          const when: number = Date.parse(at);
          return Number.isNaN(when) ? Number.MAX_SAFE_INTEGER : when;
        },
      },
      {
        key: 'progress',
        label: 'PROGRESS',
        className: 'pacs-patient-progress',
        width: '1fr',
        cell: (row: PatientRow): HTMLElement => {
          const holder: HTMLSpanElement = document.createElement('span');
          holder.className = 'pacs-patient-progress';
          this.patientTracks.set(row.key, {
            mount: holder,
            uids: row.studies.flatMap((study: PacsStudy): string[] =>
              study.series.map((series: PacsSeries): string => series.seriesUID)),
          });
          this.patientTrack_paint(row.key);
          return holder;
        },
        compare: (row: PatientRow): number => {
          const progress: ListingProgress = this.patientProgress_compute(row);
          return progress.total === 0 ? -1 : progress.done / progress.total;
        },
      },
      {
        key: 'studies',
        shed: 3,
        label: 'STUDIES',
        className: 'pacs-patient-count',
        width: '6em',
        cell: (row: PatientRow): string =>
          row.patient.status === 'unasked' ? '—' : String(row.patient.studyCount),
        compare: (row: PatientRow): number =>
          row.patient.status === 'unasked' ? -1 : row.patient.studyCount,
      },
      {
        key: 'series',
        shed: 2,
        label: 'SERIES',
        className: 'pacs-patient-count',
        width: '5em',
        cell: (row: PatientRow): string =>
          row.patient.status === 'unasked' ? '—' : String(row.patient.seriesCount),
        compare: (row: PatientRow): number =>
          row.patient.status === 'unasked' ? -1 : row.patient.seriesCount,
      },
      {
        key: 'server',
        shed: 1,
        label: 'SERVER',
        className: 'pacs-patient-server',
        width: '9em',
        cell: (row: PatientRow): string => row.patient.server ?? this.model?.pacsName ?? '—',
      },
    ];
  }

  /** A patient's progress: every series under it, summed and never averaged. */
  private patientProgress_compute(row: PatientRow): ListingProgress {
    return progress_aggregate(
      row.studies.flatMap((study: PacsStudy): ListingProgress[] =>
        study.series.map((series: PacsSeries): ListingProgress =>
          this.seriesProgress.get(series.seriesUID) ?? { done: 0, total: 0 })),
    );
  }

  /** Re-sums a patient's progress from its series and repaints its track. */
  private patientTrack_paint(patientKey: string): void {
    const track: { mount: HTMLElement; uids: string[] } | undefined = this.patientTracks.get(patientKey);
    if (track === undefined) return;
    const parts: ListingProgress[] = track.uids.map(
      (uid: string): ListingProgress => this.seriesProgress.get(uid) ?? { done: 0, total: 0 },
    );
    track.mount.replaceChildren(progressCell_build(progress_aggregate(parts)));
  }

  /**
   * The patients this answer is about, and the studies each owns.
   *
   * An answer that names its patients is taken at its word — it knows what
   * was asked, including of whom nothing came back. An older answer, or a
   * single question, carries no patient level, so one is derived from the
   * studies: every patient there is a patient with imaging, which is all
   * such an answer can honestly claim.
   *
   * @param model - The answer on stage.
   * @returns One row per patient, in the answer's own order.
   */
  private patientRows_build(model: PacsQueryModel): PatientRow[] {
    const owned = (patientId: string, server?: string): PacsStudy[] =>
      model.studies.filter((study: PacsStudy): boolean =>
        study.patientId === patientId && (server === undefined || study.server === undefined || study.server === server));

    if (model.patients !== undefined && model.patients.length > 0) {
      return model.patients.map((patient: PacsPatient, index: number): PatientRow => ({
        patient,
        key: `${patient.patientId}::${patient.server ?? ''}::${index}`,
        studies: owned(patient.patientId, patient.server),
      }));
    }

    const order: string[] = [];
    const grouped: Map<string, PacsStudy[]> = new Map();
    for (const study of model.studies) {
      const id: string = study.patientId;
      if (!grouped.has(id)) { grouped.set(id, []); order.push(id); }
      (grouped.get(id) as PacsStudy[]).push(study);
    }
    return order.map((id: string, index: number): PatientRow => {
      const studies: PacsStudy[] = grouped.get(id) ?? [];
      return {
        key: `${id}::${index}`,
        studies,
        patient: {
          patientId: id,
          ...(studies[0]?.patientName ? { patientName: studies[0].patientName } : {}),
          status: 'found',
          studyCount: studies.length,
          seriesCount: studies.reduce(
            (total: number, study: PacsStudy): number => total + study.series.length, 0),
          ...(model.provenance === undefined ? {} : { provenance: model.provenance }),
        },
      };
    });
  }

  /**
   * The study listing's columns: the level above the series.
   *
   * ACCESSION earns a column of its own. It is the number a radiologist
   * quotes and a report is filed under, so it is the field an operator
   * arrives holding — a study's identity in the hospital, not a detail to
   * be read out of a run-on label.
   *
   * @returns The traits, in cap order.
   */
  private studyTraits_declare(): ReadonlyArray<ListingTrait<StudyRow>> {
    return [
      {
        key: 'fold',
        label: '',
        className: 'pacs-fold',
        capped: false,
        width: PACS_LEAD_TRACKS.fold,
        cell: (): HTMLElement => {
          const fold: HTMLSpanElement = document.createElement('span');
          fold.className = 'pacs-fold';
          return fold;
        },
      },
      {
        key: 'patient',
        label: 'PATIENT',
        className: 'pacs-study-patient',
        width: PACS_LEAD_TRACKS.patient,
        cell: (row: StudyRow): string => row.study.patientName || '(unknown)',
      },
      {
        key: 'mrn',
        label: 'MRN',
        className: 'pacs-study-mrn',
        width: PACS_LEAD_TRACKS.mrn,
        cell: (row: StudyRow): string => row.study.patientId || '—',
      },
      {
        key: 'study',
        label: 'STUDY',
        className: 'pacs-study-desc',
        width: '12em',
        cell: (row: StudyRow): string => row.study.description || '(no description)',
      },
      {
        key: 'progress',
        label: 'PROGRESS',
        className: 'pacs-study-progress',
        width: '1fr',
        // The study's bar is its series' summed. The mount is remembered so
        // a retrieve in flight moves it without a re-render.
        cell: (row: StudyRow): HTMLElement => {
          const holder: HTMLSpanElement = document.createElement('span');
          holder.className = 'pacs-study-progress';
          this.studyTracks.set(row.key, {
            mount: holder,
            uids: row.study.series.map((series: PacsSeries): string => series.seriesUID),
          });
          this.studyTrack_paint(row.key);
          return holder;
        },
        compare: (row: StudyRow): number => {
          const progress: ListingProgress = this.studyProgress_compute(row);
          return progress.total === 0 ? -1 : progress.done / progress.total;
        },
      },
      {
        key: 'date',
        label: 'DATE',
        className: 'pacs-study-date',
        width: '7.5em',
        cell: (row: StudyRow): string => row.study.date,
      },
      {
        key: 'accession',
        label: 'ACCESSION',
        className: 'pacs-study-accession',
        width: '9em',
        cell: (row: StudyRow): string => row.study.accession || '—',
      },
      {
        key: 'modality',
        label: 'MODALITY',
        className: 'pacs-study-modalities',
        width: '6.5em',
        cell: (row: StudyRow): string => row.study.modalities,
      },
      {
        key: 'server',
        label: 'SERVER',
        className: 'pacs-study-server',
        width: '9em',
        // A study says which PACS holds it. On a single-server answer that
        // is the server the question was put to, which is still the fact —
        // the column exists so the FORM has one to stand its field in.
        cell: (row: StudyRow): string => row.study.server ?? this.model?.pacsName ?? '—',
      },
      {
        key: 'series',
        label: 'SERIES',
        className: 'pacs-study-count',
        // Wide enough for the form's control, which stands in this column
        // (the last one, which a query cannot fill) and reads RE-QUERY on
        // a replayed answer: at 5em that wrapped to two lines.
        width: '6.5em',
        cell: (row: StudyRow): string => String(row.study.series.length),
        compare: (row: StudyRow): number => row.study.series.length,
      },
    ];
  }

  /** A study's verbs. Pulling a study queues every series it holds. */
  private studyActions_declare(): ReadonlyArray<ListingAction<StudyRow>> {
    return [
      {
        label: verbRule_get(PACS_STUDY_ROSTER, 'pullStudy').label({ addressable: true, allInCube: false }),
        offered: (row: StudyRow): boolean =>
          verbRule_get(PACS_STUDY_ROSTER, 'pullStudy').offered({ addressable: row.study.vfsPath !== undefined, allInCube: false }),
        run: (row: StudyRow): void => {
          const vfsPath: string | undefined = row.study.vfsPath;
          if (vfsPath === undefined) return;
          // A retrieve runs as a joblet: the session is the operator's meanwhile (#1273).
          this.handlers.command_run(`pull ${vfsPath} &`);
          // Pulling FETCHES; it does not choose. The series are queued on
          // their badges and nothing enters the cohort — that is GATHER's.
          for (const series of row.study.series) {
            if (series.vfsPath !== undefined && series.pulled !== true) {
              this.badgeState_set(series.seriesUID, { status: 'queued' });
            }
          }
        },
      },
      {
        // A study is gathered by gathering the series CUBE already holds.
        // The ones that are not home are not swept up silently: the row
        // says what it took and what it could not, because a set says what
        // became of every member. Pulling is the other verb, and it is a
        // fetch, not a choice: it puts nothing in the cohort.
        label: verbRule_get(PACS_STUDY_ROSTER, 'gather').label({ addressable: true, allInCube: false, anyInCube: true }),
        offered: (row: StudyRow): boolean => row.study.series.some(
          (series: PacsSeries): boolean => seriesVerbs_offered(series).gather,
        ),
        run: (row: StudyRow): void => {
          const taken: PacsSeries[] = row.study.series.filter(
            (series: PacsSeries): boolean => seriesVerbs_offered(series).gather,
          );
          for (const series of taken) this.gather_note(row.study, series);
          const away: number = row.study.series.length - taken.length;
          this.handlers.note(
            `gather: ${taken.length} series gathered${away > 0 ? `, ${away} not in CUBE (pull them first)` : ''}`,
          );
        },
      },
      {
        // A study whose every series is home can be processed as one folder:
        // the series folders share a parent, and that parent is the input.
        label: verbRule_get(PACS_STUDY_ROSTER, 'process').label({ addressable: true, allInCube: true }),
        offered: (row: StudyRow): boolean => studyFolder_derive(row.study) !== null,
        run: (row: StudyRow): void => {
          const folder: string | null = studyFolder_derive(row.study);
          if (folder !== null) this.handlers.process_open(folder);
        },
      },
    ];
  }

  /** A study's progress: its series' summed, never averaged. */
  private studyProgress_compute(row: StudyRow): ListingProgress {
    return progress_aggregate(
      row.study.series.map(
        (series: PacsSeries): ListingProgress =>
          this.seriesProgress.get(series.seriesUID) ?? { done: 0, total: 0 },
      ),
    );
  }

  /**
   * The series listing's columns, declared once for caps, cells and order.
   *
   * STATE holds a badge rather than text, because a retrieve in flight is a
   * picture and a fraction at once; it still sorts and filters, by the name
   * of what it is doing.
   *
   * @returns The traits, in cap order.
   */
  private traits_declare(): ReadonlyArray<ListingTrait<SeriesRow>> {
    return seriesTraits_build<SeriesRow>(
      (row: SeriesRow): PacsSeries => row.series,
      (series: PacsSeries): HTMLElement => this.badge_build(series),
    );
  }

  /**
   * A series' verbs. A series already in CUBE is gathered, not pulled; one
   * that carries no UID is offered PULL and refused it, which says more
   * than hiding the capsule would.
   *
   * @returns The actions, in capsule order.
   */
  private actions_declare(): ReadonlyArray<ListingAction<SeriesRow>> {
    return [
      {
        label: verbRule_get(PACS_SERIES_ROSTER, 'gather').label({ inCube: true, folderKnown: true, addressable: true }),
        offered: (row: SeriesRow): boolean => seriesVerbs_offered(row.series).gather,
        selected: (row: SeriesRow): boolean => this.handlers.gathered_is(row.series.seriesUID),
        run: (row: SeriesRow): void => this.gather_note(row.study, row.series),
      },
      {
        // A series CUBE holds is an image: the verb rides the row it acts
        // on, and only once the kernel can say where the series landed.
        label: verbRule_get(PACS_SERIES_ROSTER, 'image').label({ inCube: true, folderKnown: true, addressable: true }),
        offered: (row: SeriesRow): boolean => seriesVerbs_offered(row.series).image,
        selected: (row: SeriesRow): boolean => row.series.folderPath !== undefined && (this.litFolders.get(folderKey(row.series.folderPath))?.viewer ?? false),
        run: (row: SeriesRow): void => {
          if (row.series.folderPath !== undefined) this.handlers.image_open(row.series.folderPath);
        },
      },
      {
        // The same landed series as a browser: its own CFS folder, opened
        // into the series' group so it stands beside the viewer.
        label: verbRule_get(PACS_SERIES_ROSTER, 'dir').label({ inCube: true, folderKnown: true, addressable: true }),
        offered: (row: SeriesRow): boolean => seriesVerbs_offered(row.series).dir,
        selected: (row: SeriesRow): boolean => row.series.folderPath !== undefined && (this.litFolders.get(folderKey(row.series.folderPath))?.browser ?? false),
        run: (row: SeriesRow): void => {
          if (row.series.folderPath !== undefined) this.handlers.dir_open(row.series.folderPath);
        },
      },
      {
        label: verbRule_get(PACS_SERIES_ROSTER, 'process').label({ inCube: true, folderKnown: true, addressable: true }),
        offered: (row: SeriesRow): boolean => seriesVerbs_offered(row.series).image,
        run: (row: SeriesRow): void => {
          if (row.series.folderPath !== undefined) this.handlers.process_open(row.series.folderPath);
        },
      },
      {
        label: verbRule_get(PACS_SERIES_ROSTER, 'pull').label({ inCube: false, folderKnown: false, addressable: true }),
        offered: (row: SeriesRow): boolean => seriesVerbs_offered(row.series).pull,
        disabled: (row: SeriesRow): boolean => row.series.vfsPath === undefined,
        run: (row: SeriesRow): void => {
          const vfsPath: string | undefined = row.series.vfsPath;
          if (vfsPath === undefined) return;
          this.handlers.command_run(`pull ${vfsPath} &`);
          // A fetch, not a choice: the badge queues, the cohort is untouched.
          this.badgeState_set(row.series.seriesUID, { status: 'queued' });
        },
      },
    ];
  }

  /** The state a series is in, as a word: what STATE sorts and filters by. */
  private state_name(series: PacsSeries): string {
    if (series.pulled === true) return 'pulled';
    return this.badgeStates.get(series.seriesUID)?.status ?? 'idle';
  }

  /** Regenerates the editable command line from the form's filled terms. */
  private command_regenerate(): void {
    const terms: string[] = [];
    for (const { id, term } of FORM_TERMS) {
      const value: string = element_input(this.root, `#${id}`).value.trim();
      if (value.length > 0) terms.push(`${term}:${value}`);
    }
    // One server is the session's context and needs no flag; several is a
    // fan-out, which the line must say so the operator can read what will
    // run before it runs.
    const fanout: string = this.chosen.size > 1
      ? ` --pacsserver ${[...this.chosen].join(',')}`
      : '';
    const stoodIn: string = this.anon ? ` ${ANON_FLAG}` : '';
    this.command.value = terms.length > 0 || fanout !== ''
      ? `pacs query ${terms.join(',')}${fanout}${stoodIn}`
      : '';
  }

  /**
   * Arms or disarms standing in for what an answer says about a person.
   *
   * Three things move together, and they have to: the line gains the flag,
   * every field that names a person is masked — including the command line
   * itself, which carries what was typed and is as readable off a screen as
   * the form is — and the answer on stage is cleared. That last is not
   * tidiness. The substitution happens in the kernel, so rows already here
   * were fetched one way or the other; turning the pill cannot turn them,
   * and rows whose state nobody could name are worse than none.
   *
   * @param on - True to stand in.
   */
  private anon_set(on: boolean): void {
    if (on === this.anon) return;
    this.anon = on;
    this.revealed = false;
    this.anonPill.textContent = on ? 'ANON ON' : 'ANON OFF';
    this.anonPill.classList.toggle('pacs-capsule-off', !on);
    this.revealPill.hidden = !on;
    this.model = null;
    this.listing.rows_set([], { field: 'pending' });
    this.provenance_show(undefined);
    this.command.value = on
      ? `${this.command.value.trim()} ${ANON_FLAG}`.trim()
      : this.command.value.replace(ANON_FLAG_PATTERN, '').trimEnd();
    this.masking_apply();
  }

  /**
   * Shows or hides what is typed, while standing in is armed.
   *
   * Masking a field the operator is filling in hides their own typing
   * mistakes from them, and a query put to a hospital PACS for the wrong
   * record number is worse than a visible one. So the mask lifts on
   * request, the way a password field's does.
   *
   * @param on - True to show what was typed.
   */
  private reveal_set(on: boolean): void {
    this.revealed = on;
    this.revealPill.textContent = on ? 'HIDE' : 'REVEAL';
    this.revealPill.classList.toggle('pacs-capsule-off', !on);
    this.masking_apply();
  }

  /** Masks, or stops masking, every field that carries what was typed. */
  private masking_apply(): void {
    const mask: boolean = this.anon && !this.revealed;
    for (const id of IDENTIFYING_FIELDS) {
      element_input(this.root, `#${id}`).type = mask ? 'password' : 'text';
    }
    // The command line spells the same values back. It stays the line that
    // runs — the pane's claim is that what is shown is what runs — but it
    // is not readable from across a room.
    this.command.type = mask ? 'password' : 'text';
  }


  /**
   * Unfolds or retracts the strip of servers.
   *
   * The FILTER gesture, not a dropdown: LCARS has no popup layer and should
   * not grow one, since a floating menu is exactly the window chrome the
   * grammar rejects. The strip is a band of the pane's own width, which
   * also means it carries thirteen servers where a grid track could not
   * carry three.
   *
   * @param open - Force a state; omitted, it toggles.
   */
  private serverStrip_toggle(open?: boolean): void {
    const nowOpen: boolean = open ?? this.serverStrip.hidden;
    this.serverStrip.hidden = !nowOpen;
    this.serverCell.classList.toggle('pacs-server-open', nowOpen);
    if (nowOpen && this.servers.length === 0) this.servers_ask();
    if (nowOpen) this.serverStrip_paint();
  }

  /** Whether the strip of servers is unfolded. */
  /**
   * The query line that reproduces the current results, for a desktop replay,
   * or null when the workspace holds no answer yet.
   *
   * @returns `pacs query <expression>`, or null.
   */
  public query_get(): string | null {
    return this.model === null ? null : `pacs query ${this.model.expression}`;
  }

  public serverStrip_isOpen(): boolean {
    return !this.serverStrip.hidden;
  }

  /** Retracts the strip — the field's touch, and Esc, both land here. */
  public serverStrip_close(): void {
    this.serverStrip_toggle(false);
  }

  /**
   * Asks the session what PACS servers exist.
   *
   * Through the session's own `pacs list`, never CUBE directly: the session
   * owns the connection, and a surface that reached around it would be
   * reading a different CUBE from the one its commands run against.
   */
  private servers_ask(): void {
    this.handlers.command_run('pacs list');
  }

  /** Takes the registered servers from an envelope and repaints. */
  private servers_take(servers: ReadonlyArray<PacsServer>): void {
    this.servers = servers;
    // Painted whether or not the strip is showing: the answer can arrive
    // after a retraction, and an unfolded-again strip must not have to ask
    // twice for what it already has.
    this.serverStrip_paint();
    this.serverCell_sync();
  }

  /**
   * Paints one segment per registered server, lit when chosen.
   *
   * There is no ALL. Thirteen registrations of unknown liveness would mean
   * thousands of queries mostly into the void, and no control should imply
   * that a sweep is a thing to press: a fan-out is always something the
   * operator named.
   */
  private serverStrip_paint(): void {
    this.serverStrip.replaceChildren();
    if (this.servers.length === 0) {
      this.serverStrip.appendChild(element_note('ASKING THE SESSION FOR REGISTERED SERVERS'));
      return;
    }
    for (const server of this.servers) {
      const segment: HTMLButtonElement = document.createElement('button');
      segment.className = this.chosen.has(server.identifier)
        ? 'pacs-server-segment pacs-server-chosen'
        : 'pacs-server-segment';
      segment.dataset['server'] = server.identifier;
      segment.textContent = server.identifier;
      if (server.active) segment.title = 'the session is connected to this server';
      segment.addEventListener('click', (): void => this.server_choose(server.identifier));
      this.serverStrip.appendChild(segment);
    }
  }

  /**
   * Includes or excludes one server.
   *
   * One chosen is a CONTEXT: it lowers to `pacs connect`, the session moves,
   * and the linked terminal's prompt follows. Several is a QUERY: nothing
   * moves and the line carries the fan-out. The prompt changing, or not, is
   * the honest tell for which of the two just happened.
   *
   * @param identifier - The server's canonical identifier.
   */
  private server_choose(identifier: string): void {
    if (this.chosen.has(identifier)) this.chosen.delete(identifier);
    else this.chosen.add(identifier);
    if (this.chosen.size === 1) {
      const only: string = [...this.chosen][0] as string;
      // Visible, not silent: moving the session is the operator's own act
      // and belongs in the console where they can read it.
      this.handlers.command_show(`pacs connect ${only}`);
    }
    this.serverStrip_paint();
    this.serverCell_sync();
    this.command_regenerate();
  }

  /**
   * The cell reads its own state, as every mode block does.
   *
   * `PACSDCM` for one, `PACSDCM +2` for several, and the session's own
   * server when nothing has been chosen — a control that says nothing about
   * what it will do is a control an operator has to guess at.
   */
  private serverCell_sync(): void {
    const chosen: string[] = [...this.chosen];
    if (chosen.length === 0) {
      const active: PacsServer | undefined = this.servers.find(
        (server: PacsServer): boolean => server.active);
      this.serverCell.textContent = active?.identifier ?? '—';
      this.serverCell.classList.remove('pacs-server-many');
      return;
    }
    this.serverCell.textContent = chosen.length === 1
      ? (chosen[0] as string)
      : `${chosen[0] as string} +${chosen.length - 1}`;
    this.serverCell.classList.toggle('pacs-server-many', chosen.length > 1);
  }



  /**
   * States the path a table was written to, on the pane that produced it.
   *
   * Beside the gather tray's own verbs, where EXPORT CSV was pressed: an
   * operator who asked this pane for a file should be told by this pane
   * where it is, rather than having to read the console for it.
   *
   * @param path - The CFS path the kernel reported writing.
   */
  private wrote_show(path: string): void {
    const said: HTMLElement | null = this.root.querySelector<HTMLElement>('#pacs-wrote');
    if (said === null) return;
    said.textContent = `WROTE ${path}`;
    // A file written where nobody can see it is a file the operator has to
    // go hunting for: the export says WROTE and nothing on stage changes,
    // which reads exactly like nothing happened. The readout acts — it
    // opens a browser on the folder the table landed in — and says so.
    said.title = 'open the folder this landed in';
    said.classList.add('pacs-wrote-opens');
    said.onclick = (): void => {
      const cut: number = path.lastIndexOf('/');
      this.handlers.dir_open(cut <= 0 ? path : path.slice(0, cut));
    };
    said.hidden = false;
  }

  /**
   * Writes the answer on stage into ChRIS storage as CSV.
   *
   * Visibly, in the console, as GATHER's SAVE already is: it lowers to the
   * same `--csv-to` an operator could have typed, and the line says where
   * the table went. A browser cannot be handed a file the engine wrote —
   * the engine is on the daemon's host — so the answer lands in CFS, where
   * the file browser and `download` can both reach it, and a cohort's MRNs
   * stay inside ChRIS.
   */
  private answer_export(): void {
    if (this.model === null) return;
    const line: string = this.command.value.trim();
    // The destination is ASKED for, not invented: `--csv-to` with no value
    // raises a location question, which opens an errand beside this pane.
    // The surface used to name a file the operator never chose and make a
    // folder behind their back to put it in.
    const base: string = line === '' ? `pacs query ${this.model.expression}` : line;
    this.handlers.command_show(`${base} --csv-to`);
  }

  /**
   * Runs the command line as edited.
   *
   * Only pressing RE-QUERY adds `--fresh`, and it is written into the
   * visible line before it runs. Enter on the command line runs the line
   * exactly as it reads — the pane's whole claim is that the line is what
   * runs, and silently appending a flag to it because the pane happens to
   * be showing a replay would make that claim false.
   *
   * @param fresh - True when the operator asked to bypass the stored answer.
   */
  private query_run(fresh: boolean = false): void {
    if (fresh && !FRESH_FLAG_PATTERN.test(this.command.value)) {
      this.command.value = `${this.command.value.trim()} ${FRESH_FLAG}`;
    }
    const line: string = this.command.value.trim();
    if (line.length === 0) return;
    this.model = null;
    this.listing.rows_set([], { field: 'pending' });
    this.listing.field_get()?.appendChild(this.waiting_build());
    this.handlers.command_run(line);
  }

  /**
   * Says where the answer on stage came from, and what the control does next.
   *
   * A fresh answer says nothing: the absence is the statement. A replayed
   * one names the date — the fact worth quoting — and the elapsed time,
   * which is the judgement worth acting on, and the control becomes the
   * thing that would replace it.
   *
   * @param provenance - The model's provenance, when it carries one.
   */
  private provenance_show(provenance: PacsProvenance | undefined): void {
    this.replayed = provenance?.replayed === true;
    this.run.textContent = this.replayed ? 'RE-QUERY' : 'QUERY';
    this.run.classList.toggle('pacs-capsule-requery', this.replayed);
    this.provenance.hidden = !this.replayed;
    if (!this.replayed) {
      this.provenance.textContent = '';
      // The line and the control must agree: once the answer is fresh,
      // a further press means what QUERY means.
      this.command.value = this.command.value.replace(FRESH_FLAG_PATTERN, '').trimEnd();
      return;
    }
    const at: string = provenance?.answeredAt ?? '';
    const elapsed: string | null = elapsed_describe(at);
    const day: string = at.slice(0, 10);
    this.provenance.textContent = elapsed === null
      ? `RESULTS ${day}`
      : `RESULTS ${day} · ${elapsed}`;
    this.provenance.title = at;
  }

  /**
   * The waiting state for a query in flight.
   *
   * A PACS query can take many seconds, and a single line of text is easy
   * to mistake for a finished answer that happens to be empty. This says
   * the pane is working, and keeps saying it.
   *
   * @returns The element to stand in for results.
   */
  private waiting_build(): HTMLElement {
    const wait: HTMLElement = document.createElement('div');
    wait.className = 'pacs-waiting';
    const track: HTMLSpanElement = document.createElement('span');
    track.className = 'pacs-bar pacs-bar-pacing';
    const fill: HTMLSpanElement = document.createElement('span');
    fill.className = 'pacs-bar-fill';
    track.appendChild(fill);
    const said: HTMLSpanElement = document.createElement('span');
    said.className = 'pacs-waiting-note';
    said.textContent = 'QUERYING THE PACS…';
    wait.append(track, said);
    return wait;
  }

  /**
   * Observes envelopes; a `pacs.query` model repaints the results.
   *
   * @param envelope - Any envelope crossing the session.
   */
  public envelope_observe(envelope: WireEnvelope): void {
    // Where a table went is a fact about this pane's answer, so this pane
    // says it — the console carries the command, which is a different
    // thing from the result of it.
    // The kernel's line is coloured; the path it names is not. Taking the
    // match raw carried the trailing reset sequence into the readout, where
    // it showed as stray glyphs after the filename.
    const wrote: RegExpMatchArray | null = /✓ wrote (\S+)/.exec((envelope.rendered ?? '').replace(/\x1b\[[0-9;]*m/g, ''));
    if (wrote !== null) this.wrote_show(wrote[1] as string);
    if (envelope.model?.kind === PACS_SERVERS_MODEL_KIND) {
      // What `pacs list` says, whoever asked it: the operator typing it in
      // the console fills the strip exactly as the strip's own ask does.
      const listed = pacsServersModelSchema.safeParse(envelope.model.data);
      if (listed.success) this.servers_take(listed.data.servers);
      return;
    }
    if (envelope.model?.kind !== PACS_QUERY_MODEL_KIND) return;
    const parsed = pacsQueryModelSchema.safeParse(envelope.model.data);
    if (!parsed.success) return;
    this.results_render(parsed.data);
  }

  /**
   * Drives the per-series badges and the level progress from typed
   * retrieve progress.
   *
   * @param message - A progress message; pull messages carry the series UID.
   */
  public progress_observe(message: ProgressMessage): void {
    if (message.operation !== 'pull') return;
    if (message.itemId === undefined) {
      this.pullEnd_observe(message);
      return;
    }
    // Per-series messages stay in the 'watching' phase for their whole
    // life; the terminal states arrive in `status`, so that is the truth
    // the badge follows.
    const status: string = message.status ?? 'running';
    const state: BadgeState = { status };
    if (message.current !== undefined) state.current = message.current;
    if (message.total !== undefined) state.total = message.total;
    if (message.reason !== undefined) state.reason = message.reason;
    const followed: Set<string> = this.pullSeries.get(message.id) ?? new Set();
    followed.add(message.itemId);
    this.pullSeries.set(message.id, followed);
    this.end_note(message.itemId, state);
    this.badgeState_set(message.itemId, state);
    // A retrieve that finished has changed what the row can do. Repaint it
    // now rather than waiting for the operator to ask the same question
    // again, which is what the verbs used to require. The folder, when the
    // kernel names it, is what puts IMAGE on the row.
    if (status === 'done' && this.model !== null
      && seriesPulled_mark(this.model, message.itemId, message.current ?? message.total, message.path)) {
      this.results_repaint();
    }
  }

  /**
   * Takes a pull's own end: the message that carries no series.
   *
   * Every series a pull followed has its own last word by then. One the
   * pane still holds as in flight has not, and nothing further will come
   * for it, so it is settled as ended here: a bar never moves for a pull
   * that is over.
   *
   * @param message - A pull progress message with no series.
   */
  private pullEnd_observe(message: ProgressMessage): void {
    if (message.phase !== 'complete' && message.phase !== 'failed') return;
    const followed: Set<string> | undefined = this.pullSeries.get(message.id);
    if (followed === undefined) return;
    this.pullSeries.delete(message.id);
    for (const seriesUID of followed) {
      const held: BadgeState | undefined = this.badgeStates.get(seriesUID);
      const settled: BadgeState | null = held === undefined ? null : badgeState_settle(held);
      if (settled === null) continue;
      this.end_note(seriesUID, settled);
      this.badgeState_set(seriesUID, settled);
    }
  }

  /**
   * Says in the console why a series' pull ended without its files, once:
   * a badge's title is out of reach of a finger, and the reason is the
   * operator's next move.
   *
   * @param seriesUID - The series.
   * @param state - The state about to be recorded for it.
   */
  private end_note(seriesUID: string, state: BadgeState): void {
    if (state.reason === undefined || state.status === 'done' || badge_checkIsInFlight(state)) return;
    const held: BadgeState | undefined = this.badgeStates.get(seriesUID);
    if (held !== undefined && held.status === state.status && held.reason === state.reason) return;
    let described: string = seriesUID;
    for (const study of this.model?.studies ?? []) {
      for (const series of study.series) {
        if (series.seriesUID === seriesUID && series.description !== '') described = series.description;
      }
    }
    this.handlers.note(`pull: ${described}: ${badgeText_compose(state)}, ${state.reason}`);
  }

  /**
   * Records what a series is doing, repaints its badge, and re-sums the
   * study it belongs to.
   *
   * The record is what survives a re-render: sorting the listing rebuilds
   * every badge, and a badge rebuilt from nothing would forget a retrieve
   * still in flight.
   *
   * @param seriesUID - The series.
   * @param state - What it is doing now.
   */
  private badgeState_set(seriesUID: string, state: BadgeState): void {
    this.badgeStates.set(seriesUID, state);
    badgeStateLast.set(seriesUID, state);
    this.seriesProgress.set(seriesUID, progress_deriveFromState(state, this.seriesProgress.get(seriesUID)));
    // Every badge for this series, in every pane showing it.
    badgeElements_paint(seriesUID, (badge: HTMLElement): void => this.badge_paint(badge, state));
    for (const [key, track] of this.studyTracks) {
      if (track.uids.includes(seriesUID)) this.studyTrack_paint(key);
    }
    for (const [key, track] of this.patientTracks) {
      if (track.uids.includes(seriesUID)) this.patientTrack_paint(key);
    }
  }

  /**
   * Builds a series' STATE cell.
   *
   * @param series - The series.
   * @returns The badge element, registered so the wire can repaint it.
   */
  private badge_build(series: PacsSeries): HTMLElement {
    const badge: HTMLSpanElement = document.createElement('span');
    badge.className = 'pacs-badge';
    if (series.pulled === true) {
      // Already home: a filled bar says so, and the action is gather, not pull.
      const bar: HTMLSpanElement = document.createElement('span');
      bar.className = 'pacs-bar-full';
      const note: HTMLSpanElement = document.createElement('span');
      note.className = 'pacs-badge-note';
      note.textContent = series.pulledFiles !== undefined
        ? `✓ ${series.pulledFiles} IN CUBE`
        : '✓ IN CUBE';
      badge.append(bar, note);
      badge.dataset['state'] = 'done';
      return badge;
    }
    badgeElement_register(series.seriesUID, badge);
    // A series nothing has been asked of still gets a track, dimmed. An
    // empty cell reads as a column that does not apply here; a dim track
    // reads as nothing has happened yet, which is the truth.
    this.badge_paint(badge, this.badgeStates.get(series.seriesUID) ?? { status: 'idle' });
    return badge;
  }

  /** Paints a badge from what its series is doing (the module's painter). */
  private badge_paint(badge: HTMLElement, state: BadgeState): void {
    badge_paint(badge, state);
  }

  /**
   * Takes a query's answer: seeds what is known, then paints.
   *
   * The same query's model can arrive more than once, and a repeat must not
   * undo what the operator has done since the first — a study they unfolded
   * stays unfolded, a retrieve in flight keeps its count. Only a NEW query
   * (a different id, or a query just sent) resets the pane.
   *
   * @param model - The decoded answer.
   */
  private results_render(model: PacsQueryModel): void {
    const sameQuery: boolean = this.model !== null && this.model.queryId === model.queryId;
    this.model = model;
    this.provenance_show(model.provenance);
    if (!sameQuery) {
      this.listing.open_clear();
      this.badgeStates.clear();
      // A level holding one row opens itself, at every level: an accession
      // query costs no extra gesture while a cohort still arrives folded.
      const patients: PatientRow[] = this.patientRows_build(model);
      const lone: PatientRow | undefined = patients.length === 1 ? patients[0] : undefined;
      if (lone !== undefined && lone.studies.length > 0) {
        this.listing.open_set(0, [lone.key]);
      }
      if (model.studies.length === 1) {
        this.listing.open_set(1, [study_key(model.studies[0] as PacsStudy, 0)]);
      }
    }
    for (const study of model.studies) {
      for (const series of study.series) {
        // What the wire has said outranks what the answer said: a retrieve
        // reported since the query would otherwise be erased by a repeat.
        // Except that an answer finding the series home in CUBE outranks a
        // pull that ended badly: the files arrived, whatever the watch saw.
        const held: BadgeState | undefined = this.badgeStates.get(series.seriesUID);
        if (held !== undefined && answer_outranksBadge(series, held)) {
          this.badgeState_set(series.seriesUID, { status: 'done', ...(series.pulledFiles !== undefined ? { total: series.pulledFiles } : {}) });
          continue;
        }
        if (sameQuery && held !== undefined) continue;
        this.seriesProgress.set(series.seriesUID, progress_deriveFromSeries(series));
      }
    }
    this.results_repaint();
  }

  /**
   * Puts the answer on stage: one block of patients, keyed by the query, so
   * a repeat of the same answer is the same field and a new query is not.
   * The levels beneath — a patient's studies, a study's series — are the
   * façade's to draw from the child declarations; the tracks their cells
   * register are cleared first, since the rows are rebuilt. The badge
   * registry needs no clearing: it drops elements as it finds them gone,
   * and it holds other panes' badges as well as this one's.
   */
  private results_repaint(): void {
    const model: PacsQueryModel | null = this.model;
    this.studyTracks.clear();
    this.patientTracks.clear();
    if (model === null) {
      this.listing.rows_set([], { field: 'pacs' });
      return;
    }
    this.listing.rows_set(
      [{ key: String(model.queryId), rows: this.patientRows_build(model) }],
      { field: String(model.queryId) },
    );
  }

  /** Re-sums a study's progress from its series and repaints its track. */
  private studyTrack_paint(studyKey: string): void {
    const track: { mount: HTMLElement; uids: string[] } | undefined = this.studyTracks.get(studyKey);
    if (track === undefined) return;
    const parts: ListingProgress[] = track.uids.map(
      (uid: string): ListingProgress => this.seriesProgress.get(uid) ?? { done: 0, total: 0 },
    );
    track.mount.replaceChildren(progressCell_build(progress_aggregate(parts)));
  }

  /**
   * Composes the bar: the answer's tally ahead of the view's summary.
   *
   * A listing that reports on a set says what happened to every member of
   * it: found, none, and could-not-ask are three answers, not two. The
   * counts describe the answer; the façade's summary describes the view.
   *
   * @param parts - The façade's parts.
   * @returns The line.
   */
  private stateLine_compose(parts: ListingStateParts): string {
    // The state line is composed on every repaint, which is exactly when
    // the frame's GATHER block has to say a new number: a filter narrowing
    // the field narrows what that block would take.
    queueMicrotask((): void => { this.shownGather_render(); this.shownPull_render(); });
    const words: string[] = [];
    const patients: ReadonlyArray<PacsPatient> = this.model?.patients ?? [];
    if (patients.length > 0) {
      const tally = (state: PacsPatient['status']): number =>
        patients.filter((patient: PacsPatient): boolean => patient.status === state).length;
      words.push(`FOUND ${tally('found')} · NONE ${tally('none')} · UNASKED ${tally('unasked')}`);
    }
    if (parts.filter !== '') words.push(parts.filter);
    return words.join('  ·  ');
  }

  /** Shows or hides the results filter strip (the drawer's FILTER). */
  public filter_toggle(open?: boolean): void {
    this.listing.filter_toggle(open);
  }

  /**
   * Hands one series to the cohort: the GATHER pane beside the workspace
   * lists it, and this row's GATHER lights from the cohort's answer.
   */
  /**
   * The series the listing is showing that can still be gathered, in the
   * order they stand.
   *
   * Read from the rows on stage rather than from the model: the rows ARE
   * what the filter left, and asking the field what it holds keeps one
   * answer to "what is shown" rather than a second rule that can drift
   * from the first.
   *
   * @returns The series, with the study each hangs under.
   */
  private shown_candidates(): Array<{ study: PacsStudy; series: PacsSeries }> {
    // With a filter on, what is shown IS the filtered set: the listing
    // opens what the filter kept, so the painted series rows are it. With
    // NO filter, what is shown is the whole answer — a study left folded
    // is a way of looking, not a way of choosing, and reading the fold
    // state as a choice withdrew the verb entirely on a fresh answer,
    // where nothing is unfolded yet. The surface does not get to decide
    // that an unfiltered table cannot be acted on.
    const found: Array<{ study: PacsStudy; series: PacsSeries }> = [];
    if (!this.filtering()) {
      for (const study of this.model?.studies ?? []) {
        for (const series of study.series) found.push({ study, series });
      }
      return found;
    }
    for (const element of this.root.querySelectorAll<HTMLElement>('#pacs-results .pacs-series')) {
      const uid: string | undefined = element.dataset['seriesuid'];
      if (uid === undefined) continue;
      for (const study of this.model?.studies ?? []) {
        const series: PacsSeries | undefined = study.series.find(
          (candidate: PacsSeries): boolean => candidate.seriesUID === uid,
        );
        if (series !== undefined) found.push({ study, series });
      }
    }
    return found;
  }

  /** Whether a filter is narrowing the field, for what a block says. */
  private filtering(): boolean {
    return this.listing.filterText_get() !== '';
  }

  /** What the cohort can still take from what is shown. */
  private shown_gatherable(): Array<{ study: PacsStudy; series: PacsSeries }> {
    return this.shown_candidates().filter(({ series }: { study: PacsStudy; series: PacsSeries }): boolean =>
      seriesVerbs_offered(series).gather && !this.handlers.gathered_is(series.seriesUID));
  }

  /** Repaints the frame's GATHER block: what it would take, or nothing. */
  private shownGather_render(): void {
    const block: HTMLElement | null = this.root.querySelector<HTMLElement>('#pacs-gather-shown');
    if (block === null) return;
    const count: number = this.shown_gatherable().length;
    // A control that cannot act stands down rather than misleading, and a
    // readout that acts says what it will do: the count is the promise.
    block.hidden = count === 0;
    block.textContent = this.filtering() ? `GATHER ${count} SHOWN` : `GATHER ${count}`;
  }

  /**
   * The series the listing is showing that are not home yet.
   *
   * @returns The series, in the order they stand.
   */
  private shown_pullable(): PacsSeries[] {
    return this.shown_candidates()
      .map(({ series }: { study: PacsStudy; series: PacsSeries }): PacsSeries => series)
      .filter((series: PacsSeries): boolean =>
        seriesVerbs_offered(series).pull && series.vfsPath !== undefined);
  }

  /** Repaints the frame's PULL block: what it would fetch, or nothing. */
  private shownPull_render(): void {
    const block: HTMLElement | null = this.root.querySelector<HTMLElement>('#pacs-pull-shown');
    if (block === null) return;
    const count: number = this.shown_pullable().length;
    block.hidden = count === 0;
    block.textContent = this.filtering() ? `PULL ${count} SHOWN` : `PULL ${count}`;
  }

  /**
   * Retrieves every series the listing is showing.
   *
   * ONE command over many operands, as a set act must be: twenty pulls is
   * twenty lines the operator has to audit, and the kernel already takes
   * a list. Each series is marked queued so its own row says so.
   */
  private shown_pull(): void {
    const taking: PacsSeries[] = this.shown_pullable();
    if (taking.length === 0) return;
    const paths: string = taking
      .map((series: PacsSeries): string => `"${series.vfsPath as string}"`)
      .join(' ');
    this.handlers.command_show(`pull ${paths} &`);
    for (const series of taking) this.badgeState_set(series.seriesUID, { status: 'queued' });
    this.handlers.note(`pull: ${taking.length} series asked for`);
    this.shownPull_render();
  }

  /** Takes every series the listing is showing into the cohort. */
  private shown_gather(): void {
    const taking: Array<{ study: PacsStudy; series: PacsSeries }> = this.shown_gatherable();
    if (taking.length === 0) return;
    for (const { study, series } of taking) this.gather_note(study, series);
    this.handlers.note(this.filtering()
      ? `gather: ${taking.length} series gathered from what the filter left showing`
      : `gather: ${taking.length} series gathered from the whole answer`);
    this.shownGather_render();
  }

  private gather_note(study: PacsStudy, series: PacsSeries): void {
    if (series.vfsPath === undefined) return;
    this.handlers.gather_add({
      seriesUID: series.seriesUID,
      description: series.description,
      modality: series.modality,
      // The row itself travels: the cohort shows what the answer shows.
      series,
      patient: study.patientId || study.patientName,
      // And where it came from, which the series alone does not know.
      ...(study.description === undefined || study.description === '' ? {} : { study: study.description }),
      vfsPath: series.vfsPath,
      ...(series.folderPath !== undefined ? { folderPath: series.folderPath } : {}),
      ...(series.fileCount !== undefined ? { files: series.fileCount } : {}),
    });
    this.selected_refresh();
  }

  /**
   * Records which series folders have a viewer or a browser on stage and
   * re-lights the rows' verbs to match — called by the surface on every stage
   * change (a pane opened or closed, a regard written, a domain entered, a
   * desktop restored). A verb lights when its result is present and goes dark
   * when it leaves, so the row's verbs read as a live trace of what is open.
   *
   * @param litFolders - Folder path to whether a viewer/browser regards it.
   */
  public stage_lit(litFolders: Map<string, { viewer: boolean; browser: boolean }>): void {
    this.litFolders = litFolders;
    this.selected_refresh();
  }

  /**
   * Re-derives the lit hue on the indicated series' verbs from the live
   * stage (IMAGE/DIR) and the cohort (GATHER): the verbs in the frame are
   * redrawn from their `selected` predicates, and the listing itself never
   * re-renders or jogs.
   */
  private selected_refresh(): void {
    this.listing.indication_refresh();
  }
}

/** A study's key: its UID, or its place when the PACS sent none. */
function study_key(study: PacsStudy, index: number): string {
  return study.studyUID ?? `study-${index}`;
}

/**
 * A series folder's lighting key: its path with any trailing slash stripped,
 * so a viewer (which anchors on the stripped folder) and a browser (which
 * keeps the slash) light the same row.
 */
function folderKey(path: string): string {
  return path.replace(/\/$/, '');
}

/** What a series' progress is before anything has been asked of it. */
function progress_deriveFromSeries(series: PacsSeries): ListingProgress {
  const held: number = series.pulledFiles ?? 0;
  const total: number = Math.max(series.fileCount ?? 0, held);
  if (series.pulled === true) return { done: total, total };
  return { done: held, total };
}

/**
 * What a wire state says about progress.
 *
 * A terminal state settles the bar at whatever total was known: a finished
 * retrieve that never reported a count still reads as finished, not as
 * nothing scheduled.
 *
 * @param state - The badge state just recorded.
 * @param known - What was known before, whose total stands when the wire
 *   sends none.
 * @returns The series' progress.
 */
function progress_deriveFromState(state: BadgeState, known: ListingProgress | undefined): ListingProgress {
  const total: number = state.total ?? known?.total ?? 0;
  if (state.status === 'error') return { done: state.current ?? known?.done ?? 0, total, failed: true };
  if (state.status === 'done') return { done: total, total };
  return { done: state.current ?? known?.done ?? 0, total };
}

/** Fetches a required element within the workspace. */
function element_query(root: HTMLElement, selector: string): HTMLElement {
  const found: HTMLElement | null = root.querySelector(selector);
  if (found === null) throw new Error(`PACS workspace is missing '${selector}'`);
  return found;
}

/** Fetches a required input within the workspace. */
function element_input(root: HTMLElement, selector: string): HTMLInputElement {
  const found: HTMLElement = element_query(root, selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`'${selector}' is not an input`);
  return found;
}

/** A small dim note element. */
function element_note(text: string): HTMLElement {
  const note: HTMLParagraphElement = document.createElement('p');
  note.className = 'files-empty';
  note.textContent = text;
  return note;
}
