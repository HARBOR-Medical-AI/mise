/**
 * @file The GATHER pane: a cohort as a listing.
 *
 * What used to be a tray under the PACS results — checkboxes and a strip of
 * capsules — is a listing pane like every other: one block, the cohort row
 * over its series rows, declared into the listing façade. Membership IS the
 * row: a series is in the cohort because it is listed, and REMOVE takes it
 * out. The cohort's verbs (SAVE / EXPORT CSV / CREATE FEED / DISMISS) live
 * on the cohort row, a series' (REMOVE / IMAGE / PROCESS) on the series row,
 * both drawn in the frame's row zone as every listing's are.
 *
 * The pane is born beside the PACS workspace, joined to its group, when the
 * first series is gathered; it is the workspace's cohort made visible as a
 * place, so a viewer or a catalogue opened from a row here joins the same
 * group. DISMISS forgets the cohort on the surface only — a saved manifest
 * is a file in `~/gather`, removed from a browser like any file.
 *
 * @module
 */
import type { PacsSeries } from '@fnndsc/menu';
import { path_quote, arg_quote, home_path } from '@fnndsc/menu';
import { Cohort } from './cohort.js';
import { seriesBadge_build, seriesTraits_build } from '../pacs/panel.js';
import { Listing, listingChild_declare, type ListingStateParts } from '../roster/listing.js';
import type { ListingAction, ListingTrait } from '../roster/row.js';
import {
  GATHER_COHORT_ROSTER, GATHER_SERIES_ROSTER, verbRule_get,
  type GatherCohortFacts, type GatherSeriesFacts,
} from '../roster/verbs.js';

/**
 * Where a member IS, when it is a place rather than a series to fetch.
 *
 * @param entry - The member.
 * @returns Its path, or undefined for a series that has not landed.
 */
function placeOf_member(entry: GatherSeries): string | undefined {
  return (entry.kind ?? 'series') === 'series' ? undefined : entry.vfsPath;
}

/** One gathered series: the cohort's unit, as the PACS row handed it over. */
export interface GatherSeries {
  /**
   * Identity within the cohort, and what the member IS.
   *
   * A cohort spans what a session works on, not what one instrument
   * answers: a PACS series, a directory in ChRIS storage, a file. The kind
   * decides which verbs can act on it — PULL means nothing to a directory
   * that is already home, IMAGE means nothing to a folder of CSVs — and a
   * cohort holding several kinds offers each verb only where it can act
   * and says what it skipped. Absent means 'series', which is what every
   * member was before kinds existed.
   */
  kind?: 'series' | 'dir' | 'file';
  /** The member's key: a series UID, or the path for a place. */
  seriesUID: string;
  /**
   * Whether the member is imagery: a series always is, a gathered place
   * only when it is a series folder. IMAGE on a folder of CSVs is a verb
   * that cannot act.
   */
  imagery?: boolean;
  description: string;
  modality: string;
  /**
   * The series as the PACS answer holds it.
   *
   * A cohort is an ORGANIZED SUBSET of the answer, not a second kind of
   * thing, so its rows show what a series row shows — the same columns
   * from the same declaration, state badge included. Absent only for a
   * cohort restored from an older desktop, whose rows fall back to the
   * facts kept beside this one.
   */
  series?: PacsSeries;
  /** The patient it came from (MRN, else name), which the series alone does not know. */
  patient: string;
  /**
   * The study it came from, which the series alone does not know either.
   *
   * Gathering a STUDY puts its series in the cohort, and without this the
   * operator had no way to tell WHICH study they had just taken: a column
   * of series descriptions says what each one is and nothing about where
   * it came from.
   */
  study?: string;
  /** The series as the kernel addresses it (`pull` takes this). */
  vfsPath: string;
  /** Its CFS folder once CUBE has said where it landed (IMAGE and PROCESS need it). */
  folderPath?: string;
  /** How many files it holds, when the PACS said. */
  files?: number;
}

/** What the pane asks of its host. */
export interface GatherPanelHandlers {
  /** Runs an instrument command silently. */
  command_run: (line: string) => void;
  /** Runs a command visibly in the console (the big, auditable actions). */
  command_show: (line: string) => void;
  /** Says something in the transcript that is not a command: a refusal, a count. */
  note: (text: string) => void;
  /** Opens a series' folder as an image beside the pane. */
  image_open: (folderPath: string) => void;
  /** Opens a catalogue bound to a series' folder. */
  process_open: (folderPath: string) => void;
  /** Asks the cohort's name, once, with a suggestion to hand; null when abandoned. */
  name_ask: (suggest: string) => Promise<string | null>;
  /** Asks a yes-or-no on the band: 'y', 'n', or null when abandoned. */
  confirm_ask: (message: string) => Promise<'y' | 'n' | null>;
  /**
   * Sends a `gather` verb the operator could have typed: echoed, run, and
   * settled once the kernel's answer has redrawn the cohort. Refusals are
   * written either way; `answered` writes the whole answer too.
   */
  verb_send: (line: string, answered?: boolean) => Promise<void>;
  /** DISMISS: forget the cohort on the surface — the host closes the pane. */
  dismiss: () => void;
  /** PROCESS on a cohort with a feed: a catalogue bound to the feed's root, so a run appends to it. */
  cohort_process: (binding: { input: string; feed: number; node: number }) => void;
  /** Opens the cohort's feed as a graph beside the pane. */
  feed_open: (feedId: number) => void;
}

/** The feed a cohort was rooted in: its id, and the root a run appends to. */
export interface GatherFeed {
  feedId: number;
  rootInstanceId: number;
  /** The root's data folder — what a run on the cohort takes as input. */
  path: string;
}

/** The one cohort row: the level above the series. */
interface CohortRow {
  key: string;
}

/** One series row: the cohort's unit. */
interface SeriesRow {
  entry: GatherSeries;
}

/** The cohort row's key; one cohort per pane. */
const COHORT_KEY: string = 'cohort';

/**
 * Quotes one CSV field: as is, or wrapped when it holds a comma, a quote
 * or a line break.
 *
 * @param value - The field.
 * @returns It, quoted if it needs it.
 */
function csvField_quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

/**
 * A note the field shows when it holds nothing.
 *
 * @param text - What it says.
 * @returns The element.
 */
function element_note(text: string): HTMLElement {
  const note: HTMLParagraphElement = document.createElement('p');
  note.className = 'files-empty';
  note.textContent = text;
  return note;
}

/** The GATHER pane controller. */
export class GatherPanel {
  private readonly handlers: GatherPanelHandlers;
  private readonly title: HTMLElement | null;
  /**
   * The cohort this panel SHOWS. It does not own it: the band and a pane
   * on the main panel are two views of one set, and a view that owned its
   * members would make the other a copy.
   */
  private readonly cohort: Cohort<GatherSeries>;
  /** The cohort's name once SAVE has asked it; null until then. */

  /** The feed the cohort was rooted in, once CREATE FEED or PROCESS made one. */

  /**
   * Whether the cohort row has been indicated once, at the pane's arrival.
   * Only once: a later repaint must not re-open a frame the operator had
   * stood down, since motion is asked for and never ambient.
   */
  private greeted: boolean = false;
  private readonly listing: Listing<CohortRow>;
  private readonly cohortActions: ReadonlyArray<ListingAction<CohortRow>>;
  private readonly seriesActions: ReadonlyArray<ListingAction<SeriesRow>>;

  /**
   * @param root - The pane root, whose chrome (state span, FILTER pill) the façade finds.
   * @param mount - The `.gather-rows` element the listing renders into.
   * @param handlers - Host callbacks.
   */
  constructor(root: HTMLElement, mount: HTMLElement, handlers: GatherPanelHandlers, cohort: Cohort<GatherSeries>) {
    this.handlers = handlers;
    this.cohort = cohort;
    // A view repaints when the kernel's cohort changes, whoever changed it
    // — a press here, a line at a chell — so the band and a pane showing
    // the same cohort stay in step without either one telling the other.
    cohort.watch((): void => {
      // Anything the cohort does after a SAVE is unsaved again; CLEAR
      // asks before it throws that away.
      this.unsaved = true;
      this.render();
    });
    this.title = root.querySelector<HTMLElement>('.gather-title');
    this.cohortActions = this.cohortActions_declare();
    this.seriesActions = this.seriesActions_declare();
    this.listing = new Listing<CohortRow>({
      mount,
      traits: this.cohortTraits_declare(),
      key: (row: CohortRow): string => row.key,
      chrome: { root, prefix: 'gather' },
      // The fold cell folds the cohort; its body puts the cohort's verbs in
      // the frame. A level of one opens itself, so the series show at once.
      // Always activatable: a row the façade cannot activate gets no click
      // at all, and an emptied cohort still has DISMISS to offer.
      control: 'fold',
      actions: { of: (): ReadonlyArray<ListingAction<CohortRow>> => this.cohortActions },
      row: {
        className: (): string => 'gather-cohort-row',
        groupClassName: (): string => 'gather-cohort',
        decorate: (element: HTMLElement): void => {
          element.title = 'the cohort: click for its verbs, the fold cell folds its series';
        },
      },
      child: listingChild_declare(
        (): ReadonlyArray<SeriesRow> => [...this.cohort.members_get()].map((entry: GatherSeries): SeriesRow => ({ entry })),
        {
          traits: this.seriesTraits_declare(),
          key: (row: SeriesRow): string => row.entry.seriesUID,
          // `gather list` numbers the cohort by each member's address.
          address: (row: SeriesRow): string | undefined => row.entry.vfsPath,
          // A series is a leaf: a click indicates it and its verbs go to
          // the frame; activating it does nothing.
          actions: { of: (): ReadonlyArray<ListingAction<SeriesRow>> => this.seriesActions },
          row: {
            className: (): string => 'gather-series',
            decorate: (element: HTMLElement, row: SeriesRow): void => {
              element.dataset['seriesuid'] = row.entry.seriesUID;
            },
          },
        },
      ),
      state: (parts: ListingStateParts): string => this.stateLine_compose(parts),
      empty: (): HTMLElement => element_note('NOTHING GATHERED'),
    });
    // The frame's own verb acts on the WHOLE cohort: retrieve the members
    // CUBE does not hold yet, in ONE command over many operands.
    this.pullBlock = root.querySelector<HTMLButtonElement>('.gather-pull');
    this.pullBlock?.addEventListener('click', (): void => this.cohort_pull());
    // REMOVE on a row takes one series out; the frame's block is CLEAR, and
    // takes them all — the same word as the kernel's `gather clear`, so the
    // operator who read it on the frame can type it at a console.
    // Emptying a cohort one row at a time is not a gesture anyone wants,
    // and DISMISS is a different act — it forgets the cohort entirely.
    this.emptyBlock = root.querySelector<HTMLButtonElement>('.gather-remove');
    this.emptyBlock?.addEventListener('click', (): void => { void this.cohort_clear(); });
    // The whole listing's PROCESS, beside the whole listing's PULL.
    this.processBlock = root.querySelector<HTMLButtonElement>('.gather-process');
    this.processBlock?.addEventListener('click', (): void => { void this.cohort_process(); });
    this.render();
  }

  /** The frame's PULL block, when the pane's markup carries one. */
  private readonly pullBlock: HTMLButtonElement | null = null;

  /** The frame's CLEAR block: the whole cohort, not one row. */
  private readonly emptyBlock: HTMLButtonElement | null = null;

  /**
   * Whether the cohort has changed since it was last SAVEd as a manifest.
   *
   * The session's working file is not a save — it is what lets the cohort
   * outlive a reload — so a cohort that was never named is unsaved, and
   * CLEAR on it is a question before it is an act.
   */
  private unsaved: boolean = false;

  /** The frame's PROCESS block: the whole cohort. */
  private readonly processBlock: HTMLButtonElement | null = null;

  /**
   * CLEAR: empties the cohort as one visible line — `gather clear`, the
   * kernel's own verb; the pane empties when the answer comes back.
   *
   * Once cleared it is gone, so a cohort that has changed since it was last
   * SAVEd is asked about first: YES saves it (and a name abandoned there
   * abandons the clear too — nothing is thrown away on the way to a save
   * that did not happen), NO clears, Esc leaves everything standing.
   */
  private async cohort_clear(): Promise<void> {
    if (this.cohort.size() === 0) return;
    if (this.unsaved) {
      const answer: 'y' | 'n' | null = await this.handlers.confirm_ask(
        `Save the cohort first? (${this.cohort.size()} ${this.cohort.size() === 1 ? 'member' : 'members'}, unsaved)`,
      );
      if (answer === null) return;
      if (answer === 'y' && !await this.manifest_save()) return;
    }
    await this.handlers.verb_send('gather clear');
  }

  /** The cohort's members CUBE does not hold yet. */
  private away(): ReadonlyArray<GatherSeries> {
    return [...this.cohort.members_get()].filter(
      (entry: GatherSeries): boolean => entry.folderPath === undefined && entry.series?.pulled !== true,
    );
  }

  /** Retrieves the members not yet home, as one visible command. */
  private cohort_pull(): void {
    const taking: ReadonlyArray<GatherSeries> = this.away();
    if (taking.length === 0) return;
    const paths: string = taking.map((entry: GatherSeries): string => path_quote(entry.vfsPath)).join(' ');
    // A retrieve runs as a joblet: its badges follow it, the console is free (#1273).
    this.handlers.command_show(`pull ${paths} &`);
  }

  /** Paints now, for a view that has just joined the stage. */
  public render_now(): void {
    this.render();
  }

  /** Whether the cohort holds this series. */
  public has(seriesUID: string): boolean {
    return this.cohort.has(seriesUID);
  }

  /** The cohort, in gather order. */
  public entries_get(): ReadonlyArray<GatherSeries> {
    return [...this.cohort.members_get()];
  }

  /** The cohort's name, when SAVE has asked it. */
  public name_get(): string | null {
    return this.cohort.name_get();
  }

  /** The feed the cohort was rooted in, when it was. */
  public feed_get(): GatherFeed | null {
    return this.cohort.feed_get();
  }

  /**
   * Names the cohort without asking (a desktop restoring what was named):
   * `gather name`, so the kernel's cohort carries it.
   *
   * @param name - The name, or null for unnamed.
   */
  public async name_set(name: string | null): Promise<void> {
    if (name === null || name === this.cohort.name_get()) return;
    await this.handlers.verb_send(`gather name ${arg_quote(name)}`);
  }

  /**
   * Takes a member out of the cohort: `gather remove` on its path.
   *
   * @param entry - The member.
   */
  private member_remove(entry: GatherSeries): void {
    void this.handlers.verb_send(`gather remove ${arg_quote(entry.vfsPath)}`);
  }

  /** Paints the cohort as one block, its series open beneath it. */
  private render(): void {
    if (this.title !== null) {
      this.title.textContent = this.cohort.name_get() === null ? 'GATHER' : `GATHER · ${this.cohort.name_get() ?? ''}`.toUpperCase();
    }
    this.listing.rows_set([{ key: 'gather', rows: [{ key: COHORT_KEY }] }], { field: 'gather' });
    if (this.cohort.size() > 0) this.listing.open_set(0, [COHORT_KEY]);
    // A pane whose listing holds exactly one row has nothing to choose
    // between: it indicates that row itself, so the cohort's verbs stand
    // in the frame the moment the pane arrives. The operator reasonably
    // read the fold capsule as the only control there was and pressed it
    // to find them, which is a listing asking to be interrogated before it
    // will say what it can do.
    // What PULL would fetch, said on the block itself; nothing to fetch
    // stands it down rather than offering an act that cannot happen.
    if (this.pullBlock !== null) {
      const away: number = this.away().length;
      this.pullBlock.hidden = away === 0;
      this.pullBlock.textContent = `PULL ${away}`;
    }
    if (this.emptyBlock !== null) {
      this.emptyBlock.hidden = this.cohort.size() === 0;
      this.emptyBlock.textContent = `CLEAR ${this.cohort.size()}`;
    }
    if (this.processBlock !== null) this.processBlock.hidden = this.cohort.size() === 0;
    if (!this.greeted) {
      this.greeted = true;
      this.listing.row_indicate(COHORT_KEY);
    }
  }

  /**
   * The cohort row's columns: what it is called, how much it holds.
   *
   * @returns The traits, in cap order.
   */
  private cohortTraits_declare(): ReadonlyArray<ListingTrait<CohortRow>> {
    return [
      {
        key: 'fold',
        label: '',
        className: 'pacs-fold',
        capped: false,
        width: '5.2em',
        cell: (): HTMLElement => {
          const fold: HTMLSpanElement = document.createElement('span');
          fold.className = 'pacs-fold';
          return fold;
        },
      },
      {
        key: 'name',
        label: 'COHORT',
        className: 'gather-cohort-name',
        width: '1fr',
        cell: (): string => this.cohort.name_get() ?? '(unnamed — SAVE names it)',
      },
      {
        key: 'series',
        label: 'SERIES',
        className: 'gather-cohort-count',
        width: '6em',
        // SERIES counts series. A gathered PLACE is not one, and counting
        // it here said `2 SERIES` over a cohort holding one series and one
        // directory, while the bar beneath said `1 SERIES · 1 PLACE`.
        cell: (): string => String(this.series_count()),
        compare: (): number => this.series_count(),
      },
      {
        key: 'patients',
        label: 'PATIENTS',
        className: 'gather-cohort-patients',
        width: '7em',
        cell: (): string => String(this.patients_count()),
        compare: (): number => this.patients_count(),
      },
      {
        // The feed the cohort landed in, as the catalogue's strip wears it:
        // a lit capsule that opens the feed's graph beside the pane.
        key: 'feed',
        label: 'FEED',
        className: 'gather-cohort-feed',
        width: '7em',
        cell: (): HTMLElement | string => {
          if (this.cohort.feed_get() === null) return '—';
          const capsule: HTMLButtonElement = document.createElement('button');
          capsule.className = 'gather-feed listing-capsule listing-action-selected';
          capsule.textContent = `FEED ${this.cohort.feed_get()?.feedId ?? 0}`;
          capsule.title = 'open the feed\'s graph beside the cohort';
          const feedId: number = this.cohort.feed_get()?.feedId ?? 0;
          capsule.addEventListener('click', (event: Event): void => {
            event.stopPropagation();
            this.handlers.feed_open(feedId);
          });
          return capsule;
        },
        compare: (): number => this.cohort.feed_get()?.feedId ?? -1,
      },
    ];
  }

  /**
   * A series row's columns: what it is, whose, how big.
   *
   * @returns The traits, in cap order.
   */
  private seriesTraits_declare(): ReadonlyArray<ListingTrait<SeriesRow>> {
    // The SAME declaration the PACS listing uses, because these are the
    // same series: a cohort is an organized subset of the answer, not a
    // second kind of thing, and two vocabularies for one row drift apart.
    // MRN rides along, since a cohort may span patients where a study's
    // series never do.
    const shared: Array<ListingTrait<SeriesRow>> = seriesTraits_build<SeriesRow>(
      (row: SeriesRow): PacsSeries => row.entry.series ?? {
        // A cohort restored from an older desktop kept facts but not the
        // series; the row still reads, from what was kept.
        seriesUID: row.entry.seriesUID,
        // A gathered PLACE (\`gather add <dir>\`) has no description: it
        // reads as its path. Without one its row's first cell was undefined,
        // and the throw took every later GATHER down with it.
        description: row.entry.description ?? row.entry.vfsPath ?? '',
        modality: row.entry.modality,
        ...(row.entry.files === undefined ? {} : { fileCount: row.entry.files }),
        ...(row.entry.folderPath === undefined ? {} : { pulled: true, folderPath: row.entry.folderPath }),
      } as PacsSeries,
      seriesBadge_build,
    );
    const mrn: ListingTrait<SeriesRow> = {
      key: 'patient',
      label: 'MRN',
      className: 'gather-series-patient',
      width: '8em',
      cell: (row: SeriesRow): string => row.entry.patient || '—',
    };
    const study: ListingTrait<SeriesRow> = {
      key: 'study',
      label: 'STUDY',
      className: 'gather-series-study',
      width: '14em',
      cell: (row: SeriesRow): string => row.entry.study ?? '—',
    };
    return [...shared.slice(0, 1), study, mrn, ...shared.slice(1)];
  }

  /**
   * The cohort's verbs, from its roster.
   *
   * @returns The actions, in capsule order.
   */
  private cohortActions_declare(): ReadonlyArray<ListingAction<CohortRow>> {
    const facts = (): GatherCohortFacts => ({ count: this.cohort.size(), feed: this.cohort.feed_get()?.feedId ?? null });
    const runs: Record<string, () => void> = {
      save: (): void => { void this.manifest_save(); },
      export: (): void => { void this.cohort_export(); },
      feed: (): void => { void this.feed_ensure(); },
      process: (): void => { void this.cohort_process(); },
      dismiss: (): void => this.handlers.dismiss(),
    };
    return GATHER_COHORT_ROSTER.rules.map((rule): ListingAction<CohortRow> => ({
      label: rule.label(facts()),
      offered: (): boolean => rule.offered(facts()),
      run: (): void => runs[rule.name]?.(),
    }));
  }

  /**
   * A series' verbs, from its roster.
   *
   * @returns The actions, in capsule order.
   */
  private seriesActions_declare(): ReadonlyArray<ListingAction<SeriesRow>> {
    const facts = (row: SeriesRow): GatherSeriesFacts => ({
      // A place is already where it lives, so its folder is known; only a
      // SERIES has to be fetched before anything can be done with it.
      folderKnown: (row.entry.kind ?? 'series') !== 'series' || row.entry.folderPath !== undefined,
      // IMAGE needs imagery. A series is; a gathered place only when it
      // is a series folder, so a folder of tables is not offered a viewer.
      imagery: (row.entry.kind ?? 'series') === 'series' || row.entry.imagery === true,
      // Not home, and it carries the path a pull takes. The frame pulls
      // the whole cohort; the row pulls the one the operator is looking
      // at. A directory or a file is already in ChRIS: there is nothing
      // to pull, and offering it would be a promise nothing can keep.
      pullable: (row.entry.kind ?? 'series') === 'series'
        && row.entry.folderPath === undefined
        && row.entry.series?.pulled !== true
        && row.entry.vfsPath !== '',
    });
    const runs: Record<string, (row: SeriesRow) => void> = {
      remove: (row: SeriesRow): void => this.member_remove(row.entry),
      pull: (row: SeriesRow): void => this.handlers.command_show(`pull ${path_quote(row.entry.vfsPath)} &`),
      image: (row: SeriesRow): void => {
        const place: string | undefined = row.entry.folderPath ?? placeOf_member(row.entry);
        if (place !== undefined) this.handlers.image_open(place);
      },
      process: (row: SeriesRow): void => {
        const place: string | undefined = row.entry.folderPath ?? placeOf_member(row.entry);
        if (place !== undefined) { this.handlers.process_open(place); return; }
        // Offered on every member, and honest on the ones that are not
        // there yet: a run takes a PLACE, and a series still at the PACS
        // has none until it is fetched.
        this.handlers.note(
          `gather: ${row.entry.description || row.entry.seriesUID} is not in CUBE yet — PULL it first, then PROCESS it.`,
        );
      },
    };
    return GATHER_SERIES_ROSTER.rules.map((rule): ListingAction<SeriesRow> => ({
      label: rule.label({ folderKnown: true, pullable: true }),
      offered: (row: SeriesRow): boolean => rule.offered(facts(row)),
      run: (row: SeriesRow): void => runs[rule.name]?.(row),
    }));
  }

  /** How many distinct patients the cohort spans. */
  private patients_count(): number {
    // Patients are a fact about SERIES. A place carries its owner in the
    // same field, and counting that made a cohort of one series and one
    // directory read as two patients.
    return new Set(this.cohort.members_get()
      .filter((entry: GatherSeries): boolean => (entry.kind ?? 'series') === 'series')
      .map((entry: GatherSeries): string => entry.patient)).size;
  }

  /** How many of the cohort's members are series. */
  private series_count(): number {
    return this.cohort.members_get()
      .filter((entry: GatherSeries): boolean => (entry.kind ?? 'series') === 'series').length;
  }

  /**
   * The bar's summary: how much is gathered, then the façade's filter word.
   *
   * @param parts - The façade's typed state parts.
   * @returns The line.
   */
  private stateLine_compose(parts: ListingStateParts): string {
    // A cohort of series says patients, because that is what a set of
    // series is about. Once it holds PLACES as well, saying `28 SERIES`
    // would be a count of something the cohort does not only hold — so a
    // mixed set counts what it actually has, each kind by name.
    const members: ReadonlyArray<GatherSeries> = this.cohort.members_get();
    const places: number = members.filter(
      (entry: GatherSeries): boolean => (entry.kind ?? 'series') !== 'series',
    ).length;
    const series: number = members.length - places;
    const counted: string[] = [];
    if (series > 0 || places === 0) counted.push(`${series} SERIES`);
    if (places > 0) counted.push(`${places} ${places === 1 ? 'PLACE' : 'PLACES'}`);
    if (places === 0) counted.push(`${this.patients_count()} PATIENTS`);
    const words: string[] = [counted.join(' · ')];
    if (parts.filter !== '') words.push(parts.filter);
    return words.join('  ·  ');
  }

  /**
   * The cohort's name, asked once (pre-filled with the name it has, else a
   * dated one) and kept; null when the operator abandoned the ask.
   *
   * @returns The name.
   */
  private async name_ensure(): Promise<string | null> {
    if (this.cohort.name_get() !== null) return this.cohort.name_get();
    const answered: string | null = await this.handlers.name_ask(`gather-${new Date().toISOString().slice(0, 10)}`);
    const wanted: string = (answered ?? '').trim();
    if (wanted === '') return null;
    await this.handlers.verb_send(`gather name ${arg_quote(wanted)}`);
    return wanted;
  }

  /** Writes the cohort manifest to `~/gather/<name>.json`, one visible command. */
  private async manifest_save(): Promise<boolean> {
    if (this.cohort.size() === 0) return false;
    const name: string | null = await this.name_ensure();
    if (name === null) return false;
    const manifest: string = JSON.stringify({
      name,
      gatheredAt: new Date().toISOString(),
      series: [...this.cohort.members_get()].map((entry: GatherSeries) => ({
        seriesUID: entry.seriesUID,
        description: entry.description,
        modality: entry.modality,
        patient: entry.patient,
        vfsPath: entry.vfsPath,
      })),
    });
    this.handlers.command_run('mkdir -p ~/gather');
    this.handlers.command_show(`touch --withContents ${arg_quote(manifest)} ${home_path(`gather/${name}.json`)}`);
    this.unsaved = false;
    return true;
  }

  /**
   * Writes the cohort as a table a spreadsheet reads, into CFS (the engine
   * is elsewhere; a redirect would write somebody else's disk).
   */
  private async cohort_export(): Promise<void> {
    if (this.cohort.size() === 0) return;
    const name: string | null = await this.name_ensure();
    if (name === null) return;
    const rows: string[] = [
      ['patient', 'series', 'modality', 'seriesUID', 'path'].join(','),
      ...[...this.cohort.members_get()].map((entry: GatherSeries): string => [
        entry.patient, entry.description, entry.modality, entry.seriesUID, entry.vfsPath,
      ].map(csvField_quote).join(',')),
    ];
    this.handlers.command_run('mkdir -p ~/gather');
    this.handlers.command_show(`touch --withContents ${arg_quote(rows.join('\n'))} ${home_path(`gather/${name}.csv`)}`);
  }

  /**
   * The cohort's feed: the one it has, else one made now by one visible,
   * auditable command — `gather feed`, which pulls any series still at the
   * PACS and roots one feed on every member, places included — named at
   * the ask if it was not yet. The kernel notes the feed on the cohort, and
   * its answer is where this reads it from.
   *
   * @returns The feed, or null when none was made.
   */
  private async feed_ensure(): Promise<GatherFeed | null> {
    const standing: GatherFeed | null = this.cohort.feed_get();
    if (standing !== null) return standing;
    if (this.cohort.size() === 0) return null;
    const name: string | null = await this.name_ensure();
    if (name === null) return null;
    await this.handlers.verb_send('gather feed', true);
    return this.cohort.feed_get();
  }

  /**
   * PROCESS on the cohort: its feed first (made if there is none), then a
   * catalogue bound to the feed's root — a run appends to the cohort.
   */
  private async cohort_process(): Promise<void> {
    const feed: GatherFeed | null = await this.feed_ensure();
    if (feed === null) return;
    this.handlers.cohort_process({ input: feed.path, feed: feed.feedId, node: feed.rootInstanceId });
  }
}
