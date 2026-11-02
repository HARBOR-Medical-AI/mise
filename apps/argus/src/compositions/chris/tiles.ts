/**
 * @file The ChRIS composition's dashboard tiles: ANALYSES (the roster of
 * feeds), PACS, the UNIVERSE, and through a porter, CLOUD (the door into
 * the person's cloud session, docs/stratus.adoc D14).
 *
 * @module
 */
import { feedListModelSchema, FEED_LIST_MODEL_KIND } from '@fnndsc/menu';
import type { ExecuteOutcome } from '../../calypso/client.js';
import { TILE_ABOUT } from '../../features/launcher/about.js';
import type { LauncherRow, LauncherTile } from '../../features/launcher/panel.js';
import type { TileContribution } from '../../app/dashboardTiles.js';

/** What the ChRIS tiles ask of the surface. */
export interface ChrisTileHooks {
  /** Asks the session a line, quietly. */
  ask: (line: string) => Promise<ExecuteOutcome>;
  universe_show: () => void;
  /** Opens the roster, optionally filtered. */
  runs_show: (filter?: string) => void;
  /** Opens the roster at one feed. */
  feed_enter: (feedId: number) => void;
  /** Drops a line into the console, ready to finish. */
  line_offer: (line: string) => void;
  /** What the PACS pane last asked, or empty. */
  pacs_query: () => string;
  pacs_open: () => void;
  /** Enters the cloud session through the porter this page came by (it runs `stratus oci`, which enters as READ); null when it came by none. */
  cloud_enter: (() => void) | null;
}

/**
 * Makes the ChRIS tiles' source: asked each time the dashboard paints.
 *
 * @param hooks - What the tiles reach.
 * @returns The source.
 */
export function chrisTiles_make(hooks: ChrisTileHooks): () => Promise<TileContribution> {
  return async (): Promise<TileContribution> => {
    const roster: ExecuteOutcome = await hooks.ask('proc feeds');
    interface RosterFeed { id: number; title: string; status: string }
    let feeds: RosterFeed[] = [];
    for (const envelope of roster.envelopes) {
      const model = envelope.model;
      if (model === undefined || model.kind !== FEED_LIST_MODEL_KIND) continue;
      const parsed = feedListModelSchema.safeParse(model.data);
      if (parsed.success) feeds = parsed.data.feeds as RosterFeed[];
    }
    // A roster refused for warming is not an empty roster: the tiles say
    // the index is warming rather than counting feeds that are not yet known.
    const rosterWarming: boolean = feeds.length === 0 && roster.envelopes.some((envelope): boolean => envelope.status === 'error');
    const feedsFigure: string = rosterWarming ? 'INDEX WARMING' : `${feeds.length} FEEDS`;
    const errored: number = feeds.filter((feed: RosterFeed): boolean => /error/i.test(feed.status)).length;
    const live: number = feeds.filter((feed: RosterFeed): boolean => /running|scheduled|created|started/i.test(feed.status)).length;

    const universe: LauncherTile = {
      key: 'universe', name: 'UNIVERSE', hue: '--honey', numeral: '',
      figures: [{ text: feedsFigure }],
      rows: [],
      verb: 'SEE THE SPACE',
      about: TILE_ABOUT['universe'],
      enter: (): void => hooks.universe_show(),
    };
    const analyses: LauncherTile = {
      key: 'analyses', name: 'ANALYSES', hue: '--october-sunset', numeral: '3',
      figures: [
        { text: feedsFigure },
        ...(live > 0 ? [{ text: `${live} RUNNING` }] : []),
        ...(errored > 0 ? [{ text: `${errored} ERRORED`, errored: true, open: (): void => hooks.runs_show('status:error') }] : []),
      ],
      rows: feeds.slice(0, 6).map((feed: RosterFeed): LauncherRow => ({
        text: `${feed.id}  ${feed.title}`,
        errored: /error/i.test(feed.status),
        open: (): void => hooks.feed_enter(feed.id),
      })),
      verb: 'OPEN THE ROSTER',
      about: TILE_ABOUT['analyses'],
      enter: (): void => hooks.runs_show(),
    };
    const pacsAnswer: string = hooks.pacs_query();
    const pacs: LauncherTile = {
      key: 'pacs', name: 'PACS', hue: '--daybreak', numeral: '4',
      figures: [{ text: pacsAnswer === '' ? 'NO ANSWER' : 'ANSWERED' }],
      // With nothing asked yet the block teaches instead of apologising:
      // the line it would take, dropped into the console ready to finish.
      rows: pacsAnswer === ''
        ? [
          { text: 'pacs query PatientID:…', open: (): void => hooks.line_offer('pacs query PatientID:') },
          { text: 'pacs query AccessionNumber:…', open: (): void => hooks.line_offer('pacs query AccessionNumber:') },
        ]
        : [{ text: pacsAnswer.slice(0, 48) }],
      verb: 'ASK A PACS',
      about: TILE_ABOUT['pacs'],
      enter: (): void => hooks.pacs_open(),
    };
    // The door into the person's cloud session, where there is a porter to
    // ask: the tile runs the console's own line, which enters as READ; the
    // first line that would act asks the password (D14).
    const cloud: LauncherTile | null = hooks.cloud_enter === null ? null : {
      key: 'cloud', name: 'CLOUD', hue: '--daybreak', numeral: '',
      figures: [{ text: 'OCI' }],
      rows: [
        { text: 'enter as READ · look only', open: hooks.cloud_enter },
        { text: 'a line that would act asks your password · MANAGE then', open: hooks.cloud_enter },
      ],
      verb: 'ENTER YOUR CLOUD SESSION',
      about: TILE_ABOUT['cloud'],
      enter: hooks.cloud_enter,
    };
    return {
      lead: { tile: analyses, weight: feeds.length },
      afterFiles: [pacs],
      afterPanes: cloud === null ? [universe] : [universe, cloud],
      about: { files: { text: 'Your ChRIS home: uploads, results and what others shared with you.' } },
    };
  };
}
