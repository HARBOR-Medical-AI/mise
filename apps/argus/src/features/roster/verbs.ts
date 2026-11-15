/**
 * @file The verb roster: which controls a row offers, and when.
 *
 * Every listing that gives its rows verbs declares them here, once, and the
 * panes read this rather than each carrying its own list. Two things follow
 * from that. A pane cannot quietly stop offering a verb, because the verb
 * is not the pane's to forget. And a verb cannot quietly arrive, because
 * adding one means editing this file, where what it displaces is visible.
 *
 * This is not a test fixture. The panes build their action tracks from
 * these rules, so what the roster says and what an operator is offered are
 * the same statement; the test then asks a real listing what it renders and
 * holds it to the roster, exhaustively, in order.
 *
 * The rule owns the label and the condition. It never owns the doing: what
 * a verb runs needs the pane's own hands (a terminal, a session, a
 * retrieve), so a pane supplies `run` by the verb's name.
 *
 * Written after a verb went missing. GATHER, the control a whole workflow
 * starts with, stopped being offered on every series already in CUBE and
 * every test stayed green, because no test had ever asked a listing what it
 * offers.
 *
 * @module
 */

/** Every listing that offers its rows verbs. */
export type VerbListing =
  | 'files.row'
  | 'files.selection'
  | 'runs.row'
  | 'pacs.patient'
  | 'pacs.study'
  | 'pacs.series'
  | 'gather.cohort'
  | 'gather.series';

/**
 * One verb a row may be offered.
 *
 * @property name - Stable identity, what a pane binds its `run` to. Never shown.
 * @property label - What the operator reads; a count or a feed number makes it vary.
 * @property offered - Whether this row is offered the verb at all.
 */
export interface VerbRule<F> {
  name: string;
  label: (facts: F) => string;
  offered: (facts: F) => boolean;
}

/**
 * One listing's verbs, in the order a row shows them, and the row states
 * worth holding it to.
 *
 * @property listing - Which listing this is.
 * @property rules - The verbs, in track order.
 * @property states - Representative rows, named. The test walks these; they
 *   live here so the roster is one statement rather than two that can drift.
 */
export interface VerbRoster<F> {
  listing: VerbListing;
  rules: ReadonlyArray<VerbRule<F>>;
  states: ReadonlyArray<{ name: string; facts: F }>;
}

/** What a browser row is, as far as its verbs are concerned. */
export interface FileRowFacts {
  /** A catalogue entry is a plugin or a pipeline: listed, not stored. */
  kind: 'file' | 'directory' | 'seriesFolder' | 'catalogue';
  /** The feed the path names, when it names one. */
  feed: number | null;
  /**
   * The plugin instance whose `data/` this row IS, when it is one: inside
   * a feed only a node's own output can be processed, never a directory
   * beneath it, since the kernel runs on the whole node whatever was named.
   */
  node?: number | null;
  /**
   * Whether the row stands in a catalogue BOUND to an input (a `/bin`
   * pane PROCESS opened): only then can an executable be RUN from it.
   */
  bound?: boolean;
  /**
   * Whether the row lives in a PROJECTION — `/proc`'s jobs, `/net`'s
   * servers — which the kernel renders and nothing writes. A projection
   * has no folder behind it to move a file into, copy within, or remove
   * from, so the verbs that would write are not offered there. Reading,
   * opening and processing remain: they are what a projection is for.
   */
  projection?: boolean;
  /**
   * Whether the row is a file the kernel's `edit` opens as text (the shared
   * list in @fnndsc/menu says which extensions are bytes).
   */
  editable?: boolean;
}

/** What a browser selection is. */
export interface FilesSelectionFacts {
  count: number;
  /** The feeds the selection touches; sharing grants a feed, never a file. */
  feeds: readonly number[];
}

/** What a feed row is. A feed offers the same verbs whatever state it is in. */
export interface RunsRowFacts {
  feedId: number;
}

/** What a PACS study row is. */
export interface PacsStudyFacts {
  /** The study resolves to a VFS path, so it can be pulled. */
  addressable: boolean;
  /** Every series is home and its folder known, so the study's folder can be processed. */
  allInCube: boolean;
  /** At least one series is home: kept for states that still say so. */
  anyInCube?: boolean;
}

/** What a PACS series row is. */
export interface PacsSeriesFacts {
  /** CUBE already holds it. */
  inCube: boolean;
  /** CUBE has named the folder it landed in, so it can be opened as an image. */
  folderKnown: boolean;
  /** The series resolves to a VFS path, so a pull can name it. */
  addressable: boolean;
}

/**
 * A browser row's verbs. A catalogue entry gets none: `rm` on a plugin
 * cannot act.
 *
 * A directory is acted on like a file — moved, copied, removed, its feed
 * shared — since entering it is its own control (OPEN) and no longer the
 * row's click; a series folder adds IMAGE. What may be done to the
 * directory ON STAGE as a whole is done from its parent's listing (select
 * it there) or from the frame (MKDIR, UPLOAD, REFRESH act on the field).
 */
export const FILE_ROW_ROSTER: VerbRoster<FileRowFacts> = {
  listing: 'files.row',
  rules: [
    { name: 'image', label: (): string => 'IMAGE', offered: (f: FileRowFacts): boolean => f.kind === 'seriesFolder' },
    {
      // A cohort is what this session is working on, and that is not only
      // PACS: a directory of inputs belongs in it beside a series, and so
      // does a FILE. This was once a place-only verb on the belief that a
      // run is given a directory — but CUBE's own `unextpath` takes a
      // comma-separated list of paths, files included (proved live: three
      // files to pl-dircopy became three link files at the feed's root), so
      // three-and-only-three files is a cohort a run can be given. Not
      // offered on a projection: the kernel renders /proc and /net, and a
      // gathered view is a member nothing could hand over.
      name: 'gather',
      label: (): string => 'GATHER',
      offered: (f: FileRowFacts): boolean => f.kind !== 'catalogue' && f.projection !== true,
    },
    // PROCESS acts on a place: a directory outside a feed (a new feed roots
    // on it), or a node's own data inside one (the run appends to the node).
    {
      name: 'process',
      label: (): string => 'PROCESS',
      offered: (f: FileRowFacts): boolean =>
        (f.kind === 'directory' || f.kind === 'seriesFolder') && (f.feed === null || (f.node ?? null) !== null),
    },
    { name: 'run', label: (): string => 'RUN', offered: (f: FileRowFacts): boolean => f.kind === 'catalogue' && f.bound === true },
    // EDIT opens a text file in the editor pane, a projection's writable one
    // (a feed's note) included; the kernel refuses a read-only one's save.
    { name: 'edit', label: (): string => 'EDIT', offered: (f: FileRowFacts): boolean => f.kind === 'file' && f.editable === true },
    // DOWNLOAD on a folder is the kernel's `download`, which archives the
    // tree into one file a browser can save. Not on a projection: /proc and
    // /net are rendered by the kernel and hold nothing an archive run could read.
    {
      name: 'download',
      label: (): string => 'DOWNLOAD',
      offered: (f: FileRowFacts): boolean =>
        f.kind === 'file' || ((f.kind === 'directory' || f.kind === 'seriesFolder') && f.projection !== true),
    },
    // LINK: a web address that opens ARGUS here, for a colleague the feed is shared with.
    { name: 'link', label: (): string => 'LINK', offered: (f: FileRowFacts): boolean => f.kind !== 'catalogue' },
    { name: 'move', label: (): string => 'MOVE', offered: (f: FileRowFacts): boolean => f.kind !== 'catalogue' && f.projection !== true },
    { name: 'copy', label: (): string => 'COPY', offered: (f: FileRowFacts): boolean => f.kind !== 'catalogue' && f.projection !== true },
    { name: 'delete', label: (): string => 'DELETE', offered: (f: FileRowFacts): boolean => f.kind !== 'catalogue' && f.projection !== true },
    {
      name: 'share',
      // The capsule NAMES the feed: CUBE grants a feed and never a file, so
      // a bare SHARE on a file row would read as a lie about what happens.
      label: (f: FileRowFacts): string => `SHARE FEED ${f.feed ?? ''}`,
      offered: (f: FileRowFacts): boolean => f.kind !== 'catalogue' && f.feed !== null && f.projection !== true,
    },
  ],
  states: [
    { name: 'a plain file outside a feed', facts: { kind: 'file', feed: null } },
    { name: 'a file inside a feed', facts: { kind: 'file', feed: 12 } },
    { name: 'a directory', facts: { kind: 'directory', feed: null } },
    { name: 'a directory inside a feed that is not a node', facts: { kind: 'directory', feed: 12, node: null } },
    { name: "a node's data inside a feed", facts: { kind: 'directory', feed: 12, node: 456 } },
    { name: 'a DICOM series folder', facts: { kind: 'seriesFolder', feed: null } },
    { name: 'a catalogue entry', facts: { kind: 'catalogue', feed: null } },
    { name: 'a catalogue entry in a bound catalogue', facts: { kind: 'catalogue', feed: null, bound: true } },
    { name: "a node's data seen through /proc", facts: { kind: 'directory', feed: 12, node: 456, projection: true } },
    { name: 'a file seen through /proc', facts: { kind: 'file', feed: 12, projection: true } },
    { name: 'a text file', facts: { kind: 'file', feed: null, editable: true } },
    { name: "a feed's note seen through /proc", facts: { kind: 'file', feed: 12, projection: true, editable: true } },
  ],
};

/** A browser selection's verbs. */
export const FILES_SELECTION_ROSTER: VerbRoster<FilesSelectionFacts> = {
  listing: 'files.selection',
  rules: [
    { name: 'delete', label: (f: FilesSelectionFacts): string => `DELETE ${f.count}`, offered: (): boolean => true },
    { name: 'move', label: (f: FilesSelectionFacts): string => `MOVE ${f.count}`, offered: (): boolean => true },
    { name: 'copy', label: (f: FilesSelectionFacts): string => `COPY ${f.count}`, offered: (): boolean => true },
    {
      name: 'share',
      label: (f: FilesSelectionFacts): string =>
        (f.feeds.length === 1 ? `SHARE FEED ${f.feeds[0]}` : `SHARE ${f.feeds.length} FEEDS`),
      offered: (f: FilesSelectionFacts): boolean => f.feeds.length > 0,
    },
  ],
  states: [
    { name: 'a selection outside any feed', facts: { count: 3, feeds: [] } },
    { name: 'a selection in one feed', facts: { count: 2, feeds: [12] } },
    { name: 'a selection spanning feeds', facts: { count: 5, feeds: [12, 13] } },
  ],
};

/**
 * A feed row's verbs. NOTE opens the feed's note in the editor (read then,
 * never for the roster); TAG asks which tags to hang. Sharing grants the
 * feed; removal is the kernel's, and it asks.
 */
export const RUNS_ROW_ROSTER: VerbRoster<RunsRowFacts> = {
  listing: 'runs.row',
  rules: [
    { name: 'note', label: (): string => 'NOTE', offered: (): boolean => true },
    { name: 'tag', label: (): string => 'TAG', offered: (): boolean => true },
    { name: 'rename', label: (): string => 'RENAME', offered: (): boolean => true },
    { name: 'share', label: (): string => 'SHARE', offered: (): boolean => true },
    { name: 'delete', label: (): string => 'DELETE', offered: (): boolean => true },
  ],
  states: [{ name: 'any feed', facts: { feedId: 12 } }],
};

/** What a PACS patient row is. */
export interface PacsPatientFacts {
  /** At least one of the patient's studies resolves to a VFS path, so the patient can be pulled. */
  addressable: boolean;
}

/**
 * A PACS patient row's verbs. Each level's pull names its level, so the
 * capsule says how much it fetches: PULL PATIENT, PULL STUDY, PULL SERIES.
 */
export const PACS_PATIENT_ROSTER: VerbRoster<PacsPatientFacts> = {
  listing: 'pacs.patient',
  rules: [
    { name: 'pullPatient', label: (): string => 'PULL PATIENT', offered: (f: PacsPatientFacts): boolean => f.addressable },
  ],
  states: [
    { name: 'a patient with studies', facts: { addressable: true } },
    { name: 'a patient with none', facts: { addressable: false } },
  ],
};

/** A PACS study row's verbs. */
export const PACS_STUDY_ROSTER: VerbRoster<PacsStudyFacts> = {
  listing: 'pacs.study',
  rules: [
    { name: 'pullStudy', label: (): string => 'PULL STUDY', offered: (f: PacsStudyFacts): boolean => f.addressable },
    {
      name: 'gather',
      label: (): string => 'GATHER',
      offered: (f: PacsStudyFacts): boolean => f.addressable,
    },
    { name: 'process', label: (): string => 'PROCESS', offered: (f: PacsStudyFacts): boolean => f.allInCube },
  ],
  states: [
    { name: 'a study with a path', facts: { addressable: true, allInCube: false } },
    { name: 'a study with none', facts: { addressable: false, allInCube: false } },
    { name: 'a study wholly home', facts: { addressable: true, allInCube: true, anyInCube: true } },
    { name: 'a study partly home', facts: { addressable: true, allInCube: false, anyInCube: true } },
  ],
};

/**
 * A PACS series row's verbs.
 *
 * A series is GATHERED whether or not it is home. A cohort is a set of
 * targets, and the feed it roots is made by a pull over its members, so a
 * series that has not been retrieved is exactly the kind of thing worth
 * gathering — that is the ordinary way to build one: query, filter, take
 * what matched, fetch it as a set. Requiring it to be home first left the
 * whole gesture unavailable on a fresh answer, where nothing is home yet.
 *
 * PULL stays beside it and means something else: bring this one now. IMAGE
 * and DIR and PROCESS still wait for CUBE to say where it landed. One that
 * carries no path is offered the pull and refused it, which says more than
 * hiding it would.
 */
export const PACS_SERIES_ROSTER: VerbRoster<PacsSeriesFacts> = {
  listing: 'pacs.series',
  rules: [
    {
      name: 'gather',
      label: (): string => 'GATHER',
      // Gatherable when the cohort can NAME it: a PACS path to pull it by,
      // or the fact that it is already home. Not gatherable when it is
      // neither, which is a series nothing can address.
      offered: (f: PacsSeriesFacts): boolean => f.addressable || f.inCube,
    },
    { name: 'image', label: (): string => 'IMAGE', offered: (f: PacsSeriesFacts): boolean => f.inCube && f.folderKnown },
    // DIR opens the series' own folder as a browser, the same face of a
    // landed series as IMAGE, so it stands beside it under the same gate.
    { name: 'dir', label: (): string => 'DIR', offered: (f: PacsSeriesFacts): boolean => f.inCube && f.folderKnown },
    { name: 'process', label: (): string => 'PROCESS', offered: (f: PacsSeriesFacts): boolean => f.inCube && f.folderKnown },
    { name: 'pull', label: (): string => 'PULL SERIES', offered: (f: PacsSeriesFacts): boolean => !f.inCube },
  ],
  states: [
    { name: 'not yet retrieved', facts: { inCube: false, folderKnown: false, addressable: true } },
    { name: 'not retrieved and unaddressable', facts: { inCube: false, folderKnown: false, addressable: false } },
    { name: 'home, folder not yet named', facts: { inCube: true, folderKnown: false, addressable: true } },
    { name: 'home, folder named', facts: { inCube: true, folderKnown: true, addressable: true } },
  ],
};

/** What a gathered series is, as far as its verbs are concerned. */
export interface GatherSeriesFacts {
  /** Whether CUBE has said where the series landed (IMAGE and PROCESS need a folder). */
  folderKnown: boolean;
  /** Whether the member is imagery at all: IMAGE on a folder of tables cannot act. */
  imagery?: boolean;
  /**
   * Whether the cohort can still fetch it: it is not home, and it carries
   * the path a pull takes. The cohort's own frame pulls the whole set;
   * a row that is not home is offered the same act for itself, since
   * gathering something not yet retrieved is the ordinary way to build a
   * cohort and the row is where the operator is looking at that one.
   */
  pullable?: boolean;
}

/**
 * A gathered series: membership is the row, so REMOVE is its first verb;
 * the landed series is an image and an input, as it is on the PACS row.
 */
export const GATHER_SERIES_ROSTER: VerbRoster<GatherSeriesFacts> = {
  listing: 'gather.series',
  rules: [
    { name: 'remove', label: (): string => 'REMOVE', offered: (): boolean => true },
    { name: 'pull', label: (): string => 'PULL SERIES', offered: (f: GatherSeriesFacts): boolean => f.pullable === true },
    {
      name: 'image',
      label: (): string => 'IMAGE',
      offered: (f: GatherSeriesFacts): boolean => f.folderKnown && f.imagery !== false,
    },
    {
      // Every member offers PROCESS, because that is what a cohort is FOR
      // and a verb that appears only on the rows that happen to be home
      // reads as a listing that changes its mind. One not yet in CUBE is
      // refused BY NAME when pressed, which says what to do about it;
      // hiding the verb says nothing at all.
      name: 'process',
      label: (): string => 'PROCESS',
      offered: (): boolean => true,
    },
  ],
  states: [
    { name: 'folder named', facts: { folderKnown: true } },
    { name: 'a place that is not imagery', facts: { folderKnown: true, imagery: false } },
    { name: 'folder not yet named', facts: { folderKnown: false } },
    { name: 'not retrieved yet', facts: { folderKnown: false, pullable: true } },
  ],
};

/** What a cohort is, as far as its verbs are concerned. */
export interface GatherCohortFacts {
  /** How many series it holds; an emptied cohort keeps only DISMISS. */
  count: number;
  /** The feed the cohort was rooted in, once PROCESS or CREATE FEED made one. */
  feed: number | null;
}

/**
 * The cohort row's verbs: what the gather tray's head used to carry, now
 * on the row they act on. SAVE writes the manifest, EXPORT CSV the table,
 * CREATE FEED roots a feed on the cohort; DISMISS sends the band's FACE
 * away and forgets nothing — the cohort is the session's, and emptying it
 * is the frame's CLEAR block, which is `gather clear`.
 */
export const GATHER_COHORT_ROSTER: VerbRoster<GatherCohortFacts> = {
  listing: 'gather.cohort',
  rules: [
    { name: 'save', label: (): string => 'SAVE', offered: (f: GatherCohortFacts): boolean => f.count > 0 },
    { name: 'export', label: (): string => 'EXPORT CSV', offered: (f: GatherCohortFacts): boolean => f.count > 0 },
    // CREATE FEED roots the cohort's feed and stops there; once it has one
    // the verb is spent, and PROCESS appends to it.
    { name: 'feed', label: (): string => 'CREATE FEED', offered: (f: GatherCohortFacts): boolean => f.count > 0 && f.feed === null },
    // PROCESS: the cohort's feed (made first when there is none), then a
    // catalogue bound to its root — a run appends to the cohort.
    { name: 'process', label: (): string => 'PROCESS', offered: (f: GatherCohortFacts): boolean => f.count > 0 },
    { name: 'dismiss', label: (): string => 'DISMISS', offered: (): boolean => true },
  ],
  states: [
    { name: 'holding series', facts: { count: 2, feed: null } },
    { name: 'holding series, rooted in a feed', facts: { count: 2, feed: 4501 } },
    { name: 'emptied', facts: { count: 0, feed: null } },
  ],
};

/**
 * A roster whose row type is its own business, so they can be held in one
 * list and walked together. The same visitor idiom the listing façade uses
 * for a child level, and for the same reason: neither side needs to name
 * the other's rows.
 */
export interface AnyVerbRoster {
  listing: VerbListing;
  visit<R>(visitor: <F>(roster: VerbRoster<F>) => R): R;
}

/**
 * Hides a roster's row type behind a visitor.
 *
 * @param roster - The roster.
 * @returns It, walkable beside the others.
 */
export function verbRoster_any<F>(roster: VerbRoster<F>): AnyVerbRoster {
  return {
    listing: roster.listing,
    visit<R>(visitor: <X>(one: VerbRoster<X>) => R): R {
      return visitor(roster);
    },
  };
}

/** Every roster, for a test that means to hold the whole surface to them. */
export const VERB_ROSTERS: ReadonlyArray<AnyVerbRoster> = [
  verbRoster_any(FILE_ROW_ROSTER),
  verbRoster_any(FILES_SELECTION_ROSTER),
  verbRoster_any(RUNS_ROW_ROSTER),
  verbRoster_any(PACS_PATIENT_ROSTER),
  verbRoster_any(PACS_STUDY_ROSTER),
  verbRoster_any(PACS_SERIES_ROSTER),
  verbRoster_any(GATHER_COHORT_ROSTER),
  verbRoster_any(GATHER_SERIES_ROSTER),
];

/**
 * The labels a row in this state is offered, in track order.
 *
 * @param roster - The listing's roster.
 * @param facts - The row.
 * @returns The labels, in the order the row shows them.
 */
export function verbs_offered<F>(roster: VerbRoster<F>, facts: F): string[] {
  return roster.rules
    .filter((rule: VerbRule<F>): boolean => rule.offered(facts))
    .map((rule: VerbRule<F>): string => rule.label(facts));
}

/**
 * One rule by name, for a pane binding what the verb does.
 *
 * @param roster - The listing's roster.
 * @param name - The verb's stable name.
 * @returns The rule.
 * @throws {Error} When the roster does not declare that verb, which is a
 *   pane offering something the surface never agreed to.
 */
export function verbRule_get<F>(roster: VerbRoster<F>, name: string): VerbRule<F> {
  const rule: VerbRule<F> | undefined = roster.rules.find((one: VerbRule<F>): boolean => one.name === name);
  if (rule === undefined) throw new Error(`${roster.listing} declares no verb '${name}'`);
  return rule;
}
