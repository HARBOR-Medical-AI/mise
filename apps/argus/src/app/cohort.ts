/**
 * @file The session's cohort: ONE per session, the session's rather than
 * any pane's — it spans PACS series and will span directories, so it cannot
 * live in whichever pane started it. The header band shows it; a GATHER
 * pane on the main panel can show the same one at the same time. The band
 * and the pane are two reflections of one set, and their handlers are one
 * set of handlers, parameterised by where the work lands and where a
 * question stands.
 *
 * The cohort itself is the kernel's. A press here sends the `gather` verb
 * the operator could have typed, and the verb's answer — the whole cohort,
 * as `gather.cohort` — is what the views redraw from; so is the answer to a
 * line typed at any chell on the session. Nothing here writes the cohort.
 *
 * A module of the host: the host hands in its open verbs, its asks and its
 * stage as hooks; the module keeps the reflection and the band's panel.
 */
import { arg_quote } from '@fnndsc/menu';
import type { PaneAskRequest } from '../features/ask/paneAsk.js';
import { question_stand } from './asks.js';
import { Cohort } from '../features/gather/cohort.js';
import { GatherPanel, type GatherFeed, type GatherPanelHandlers, type GatherSeries } from '../features/gather/panel.js';
import type { WireEnvelope } from '@fnndsc/menu';
import type { ExecuteOutcome } from '../calypso/client.js';
import type { CatalogueBinding, ReplayPlace } from './desktop.js';
import type { HostContext } from './hostContext.js';
import { paneInstance_dispose, type PaneInstance, type PaneKind } from './panes.js';

/** The model kind every `gather` verb answers with: the whole cohort. */
export const GATHER_MODEL_KIND: string = 'gather.cohort';

/** One member as the kernel's cohort holds it. */
interface KernelMember {
  vfsPath: string;
  kind?: 'series' | 'dir' | 'file';
  seriesUID?: string;
  description?: string;
  modality?: string;
  patient?: string;
  study?: string;
  imagery?: boolean;
  folderPath?: string;
  files?: number;
}

/**
 * A kernel member as a row reads it.
 *
 * The row's key is the series UID, which is how a PACS row asks whether
 * its series is gathered; a place has none and is keyed by its path.
 *
 * @param member - The member as the kernel holds it.
 * @returns The row's entry.
 */
export function member_view(member: KernelMember): GatherSeries {
  const kind: 'series' | 'dir' | 'file' = member.kind ?? 'series';
  return {
    kind,
    seriesUID: member.seriesUID ?? member.vfsPath,
    description: member.description ?? member.vfsPath.split('/').filter(Boolean).pop() ?? member.vfsPath,
    modality: member.modality ?? '—',
    patient: member.patient ?? '',
    vfsPath: member.vfsPath,
    ...(member.study === undefined ? {} : { study: member.study }),
    ...(member.imagery === undefined ? {} : { imagery: member.imagery }),
    ...(member.folderPath === undefined ? {} : { folderPath: member.folderPath }),
    ...(member.files === undefined ? {} : { files: member.files }),
  };
}

/** What the cohort asks of the host. */
export interface CohortHooks {
  image_open: (fromId: string, path: string) => Promise<string>;
  process_open: (fromId: string, binding: CatalogueBinding) => void;
  feed_open: (fromId: string, feedId: number) => void;
  /** A question on a pane, where the press was. */
  askOnPane_await: (id: string, request: PaneAskRequest) => Promise<string | null>;
  /** A pane on stage where the band's work lands; null when none stands. */
  errandHost_find: () => string | null;
  instance_spawn: (kind: PaneKind, inheritFrom?: string) => PaneInstance;
  birth_record: (childId: string, parent: string, dir: 'row' | 'col', before: boolean) => void;
  /** The split a replayed open must use; null in normal use. */
  replayPlace_get: () => ReplayPlace | null;
  stage_relight: () => void;
  home_apply: () => void;
  orphans_dispose: () => void;
  template_stamp: (templateId: string) => HTMLElement;
  pane_find: (mount: HTMLElement, selector: string) => HTMLElement;
  element_require: (id: string) => HTMLElement;
}

/** The cohort verbs a wired host has. */
export interface CohortModule {
  /** The set itself, which neither view owns. */
  cohort: Cohort<GatherSeries>;
  /** Builds a GATHER pane showing the session's cohort. */
  instance_build: (id: string) => PaneInstance;
  /** Whether the band holds a series. */
  has: (seriesUID: string) => boolean;
  /** Takes series into the session's cohort; the band reveals itself the first time. */
  gather: (entries: ReadonlyArray<GatherSeries>) => void;
  /** Gathers into the GATHER pane on stage, opening one beside the host when there is none. */
  open: (entries: ReadonlyArray<GatherSeries>, host?: string) => string | null;
  /** Puts the cohort on the main panel as a pane; the band retracts. */
  stage: () => void;
  /** The header block says whether the session is holding anything. */
  annunciate: () => void;
  /** Reads back the cohort the session was working on, at boot. */
  restore: () => Promise<void>;
  /** Takes an envelope seen on the session: a `gather.cohort` model redraws the cohort. */
  envelope_observe: (envelope: WireEnvelope) => void;
}

/**
 * Wires the cohort to a host.
 *
 * @param context - The layout, the panels, the subjects, the console and the wire.
 * @param hooks - The host's open verbs, asks and stage.
 * @returns The cohort verbs.
 */
export function cohort_wire(context: Pick<HostContext, 'layout' | 'panels' | 'subjects' | 'terminal' | 'client'>, hooks: CohortHooks): CohortModule {
  const { panels, subjects } = context;
  const cohort: Cohort<GatherSeries> = new Cohort<GatherSeries>();
  /** The band's panel, built the first time something is gathered. */
  let header: GatherPanel | null = null;
  /** Whether the operator sent the band away since the last gather. */
  let bandDismissed: boolean = false;

  /**
   * Shows the kernel's cohort: the views redraw from it, and the band is
   * built the first time there is something to show.
   *
   * @param data - A `gather.cohort` model's data.
   */
  const adopt = (data: unknown): void => {
    if (data === null || typeof data !== 'object') return;
    const held = data as { name?: unknown; feed?: unknown; series?: unknown };
    const members: GatherSeries[] = Array.isArray(held.series)
      ? (held.series as KernelMember[]).filter((m: KernelMember): boolean => typeof m?.vfsPath === 'string').map(member_view)
      : [];
    const feed = held.feed as GatherFeed | null | undefined;
    if (header === null && members.length > 0) header = header_build();
    cohort.state_adopt(members, typeof held.name === 'string' ? held.name : null, feed ?? null);
    annunciate();
    hooks.stage_relight();
  };

  /**
   * Adopts every cohort an outcome carries.
   *
   * @param outcome - A line's result.
   */
  const outcome_adopt = (outcome: ExecuteOutcome): void => {
    for (const envelope of outcome.envelopes) {
      if (envelope.model?.kind === GATHER_MODEL_KIND) adopt(envelope.model.data);
    }
  };

  /**
   * Sends a `gather` verb as the operator could have typed it: echoed, run
   * silently, its cohort adopted before the promise settles — so a caller
   * that awaits it reads the kernel's answer (a name, a feed) straight
   * after. A refusal is written; the whole answer only when asked for.
   */
  const verb_send = async (line: string, answered: boolean = false): Promise<void> => {
    const { terminal, client } = context;
    terminal.line_echo(line);
    let outcome: ExecuteOutcome;
    try {
      // The operator's own act, not a pane's housekeeping: it reaches the
      // session bus (another surface redraws), may ask (a pull's "keep
      // waiting?"), and STOP reaches it.
      outcome = await client.line_execute(line, { silent: true, operator: true });
    } catch (error: unknown) {
      terminal.output_write('err', `\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\n`);
      return;
    }
    if (answered || outcome.envelopes.some((envelope: WireEnvelope): boolean => envelope.status === 'error')) {
      terminal.outcome_write(outcome);
    }
    outcome_adopt(outcome);
  };

  /** Paths pressed into the cohort since the last send: one `gather add` carries them all. */
  const pressed: string[] = [];

  /**
   * Gathers what was pressed: a study's twenty series are twenty presses in
   * one tick and one verb, not twenty.
   *
   * @param entries - What was pressed.
   */
  const press_gather = (entries: ReadonlyArray<GatherSeries>): void => {
    const first: boolean = pressed.length === 0;
    for (const entry of entries) if (entry.vfsPath !== '' && !pressed.includes(entry.vfsPath)) pressed.push(entry.vfsPath);
    if (!first || pressed.length === 0) return;
    queueMicrotask((): void => {
      const paths: string[] = pressed.splice(0);
      if (paths.length > 0) void verb_send(`gather add ${paths.map(arg_quote).join(' ')}`);
    });
  };

  /**
   * The handlers both reflections share, parameterised by where the work
   * lands (`hostOf`), how a question is asked, and what DISMISS means for
   * that reflection.
   */
  const handlers_make = (
    hostOf: () => string,
    asks: Pick<GatherPanelHandlers, 'name_ask' | 'confirm_ask'>,
    own: Pick<GatherPanelHandlers, 'dismiss'>,
  ): GatherPanelHandlers => ({
    command_run: (line: string): void => { void context.client.line_execute(line, { silent: true }); },
    command_show: (line: string): void => context.terminal.line_run(line),
    note: (text: string): void => context.terminal.line_note(text),
    image_open: (folderPath: string): void => {
      void hooks.image_open(hostOf(), folderPath).then((line: string): void => context.terminal.line_note(line));
    },
    process_open: (folderPath: string): void => hooks.process_open(hostOf(), { input: folderPath, feed: null, node: null }),
    ...asks,
    ...own,
    verb_send,
    cohort_process: (binding: { input: string; feed: number; node: number }): void => hooks.process_open(hostOf(), binding),
    feed_open: (feedId: number): void => hooks.feed_open(hostOf(), feedId),
  });

  /**
   * The block says whether the session is holding anything, and no more. A
   * plate is a NAME — `01-GATHER`, as `02-CALYPSO` is — so the count does
   * not get glued to it; how many, and which, the face itself says.
   */
  const annunciate = (): void => {
    const pill: HTMLElement | null = document.querySelector<HTMLElement>('#header-gather-pill');
    if (pill === null) return;
    pill.classList.toggle('panel-gather-empty', (header?.entries_get().length ?? 0) === 0);
  };

  /**
   * Builds the cohort into the header's third face. Its handlers are the
   * pane's, with the two that were about a pane made honest: a cohort in
   * the band has no pane to close, so DISMISS sends the face away instead
   * (and forgets nothing), and what it opens lands in the BODY — on a pane
   * actually on stage, resolved at the press, not when the band was built.
   */
  const header_build = (): GatherPanel => {
    const face: HTMLElement = hooks.element_require('header-gather');
    const host = (): string => hooks.errandHost_find() ?? 'pacs';
    // The question stands where the press was, and the press was in the
    // BAND; the console still records the exchange.
    // The question stands where the press was — the BAND — and on the
    // console's line as well; either answers it (#826).
    const askOnBand = (request: PaneAskRequest): Promise<string | null> =>
      question_stand(context.terminal, hooks.element_require('header-gather'), request);
    return new GatherPanel(face, hooks.pane_find(face, '.gather-rows'), handlers_make(host, {
      name_ask: (suggest: string): Promise<string | null> => askOnBand({ message: 'Cohort name: ', kind: 'text', suggest, commit: 'NAME IT' }),
      confirm_ask: async (message: string): Promise<'y' | 'n' | null> => {
        const answered: string | null = await askOnBand({ message, kind: 'confirm' });
        return answered === 'y' || answered === 'n' ? answered : null;
      },
    }, {
      dismiss: (): void => {
        document.body.dataset['header'] = 'away';
        bandDismissed = true;
        annunciate();
      },
    }), cohort);
  };

  const instance_build = (id: string): PaneInstance => {
    const mount: HTMLElement = hooks.template_stamp('tpl-pane-gather');
    const panel: GatherPanel = new GatherPanel(mount, hooks.pane_find(mount, '.gather-rows'), handlers_make((): string => id, {
      name_ask: (suggest: string): Promise<string | null> => hooks.askOnPane_await(id, { message: 'Cohort name: ', kind: 'text', suggest, commit: 'NAME IT' }),
      // On the pane, where the press was: CLEAR asks before throwing away
      // a cohort that was never saved.
      confirm_ask: async (message: string): Promise<'y' | 'n' | null> => {
        const answered: string | null = await hooks.askOnPane_await(id, { message, kind: 'confirm' });
        return answered === 'y' || answered === 'n' ? answered : null;
      },
    }, {
      dismiss: (): void => {
        if (!context.layout.leaf_close(id)) hooks.home_apply();
        hooks.orphans_dispose();
        hooks.stage_relight();
      },
    }), cohort);
    panels.set('gather', id, panel);
    return {
      id,
      kind: 'gather',
      mount,
      dispose: (): void => {
        panels.delete(id);
        subjects.pane_leave(id);
      },
    };
  };

  /** The cohort the session holds, asked of the kernel at boot. */
  const restore = async (): Promise<void> => {
    try {
      outcome_adopt(await context.client.line_execute('gather', { silent: true, observe: false }));
    } catch {
      // No session to ask is no cohort to show, not a reason to refuse the surface.
    }
  };

  /**
   * A band is right for reading and curating; a cohort of two hundred
   * members with a filter on wants a whole field. It is the SAME cohort —
   * nothing is copied and nothing can drift. The band retracts as it goes.
   */
  const stage = (): void => {
    const { layout } = context;
    const shown: Set<string> = new Set(layout.panes_shown());
    const standing: string | null = panels.ids('gather').find((id: string): boolean => shown.has(id)) ?? null;
    if (standing !== null) {
      layout.focus_set(standing);
    } else {
      const host: string = hooks.errandHost_find() ?? 'pacs';
      const spawned: PaneInstance = hooks.instance_spawn('gather', 'pacs');
      if (!layout.leaf_split(host, 'col', spawned.id, false)) {
        paneInstance_dispose(spawned.id);
        layout.mount_remove(spawned.id);
        return;
      }
      hooks.birth_record(spawned.id, host, 'col', false);
      panels.get('gather', spawned.id)?.render_now();
    }
    document.body.dataset['header'] = 'away';
    bandDismissed = true;
  };

  /**
   * The band reveals itself the first time, so the operator sees where the
   * thing they gathered went; after they have deliberately sent it away it
   * stays away and only the count moves, until they open it again.
   */
  const gather = (entries: ReadonlyArray<GatherSeries>): void => {
    if (header === null) header = header_build();
    press_gather(entries);
    const away: boolean = document.body.dataset['header'] === 'away';
    if (!bandDismissed || !away) {
      document.body.dataset['header'] = 'gather';
      bandDismissed = false;
    }
    annunciate();
  };

  const open = (entries: ReadonlyArray<GatherSeries>, host: string = 'pacs'): string | null => {
    const { layout } = context;
    const shown: Set<string> = new Set(layout.panes_shown());
    let id: string | null = panels.ids('gather').find((paneId: string): boolean => shown.has(paneId)) ?? null;
    if (id === null) {
      const from: string = shown.has(host) ? host : (hooks.errandHost_find() ?? host);
      const spawned: PaneInstance = hooks.instance_spawn('gather', 'pacs');
      const place: ReplayPlace | null = hooks.replayPlace_get();
      if (!layout.leaf_split(from, place?.dir ?? 'row', spawned.id, place?.before ?? false)) {
        paneInstance_dispose(spawned.id);
        layout.mount_remove(spawned.id);
        return null;
      }
      hooks.birth_record(spawned.id, from, place?.dir ?? 'row', place?.before ?? false);
      id = spawned.id;
    }
    if (panels.get('gather', id) === undefined) return null;
    press_gather(entries);
    return id;
  };

  return {
    cohort,
    instance_build,
    has: (seriesUID: string): boolean => cohort.has(seriesUID),
    gather,
    open,
    stage,
    annunciate,
    restore,
    envelope_observe: (envelope: WireEnvelope): void => {
      if (envelope.model?.kind === GATHER_MODEL_KIND) adopt(envelope.model.data);
    },
  };
}
