/**
 * @file The top-panel status instrument: live session telemetry.
 *
 * The bar carries what changes. It used to carry a session id and three
 * version numbers — facts nobody acts on, occupying the one part of the page
 * always in view. Versions matter exactly when they disagree, so they appear
 * only then, and `version` reports them in full on demand.
 *
 * What replaces them was already on the wire and discarded: the daemon pushes
 * its process-index warm-up state with every prompt context, which is a live
 * count of the jobs this session knows about. The activity readout comes from
 * the typed progress channel, so the bar knows work is happening without the
 * console having to say so.
 *
 * Everything here is read-only projection; the bar issues no commands.
 *
 * @module
 */
import { CONTRACT_VERSION, type PromptContext } from '@fnndsc/menu';
import type { AttachInfo, ProgressMessage } from '../calypso/client.js';

/** The ids of the status fields the bar owns, as they appear in index.html. */
interface StatusFields {
  identity: HTMLElement;
  jobs: HTMLElement;
  activity: HTMLElement;
  latency: HTMLElement;
  mismatch: HTMLElement;
  lamp: HTMLElement;
  host: HTMLElement;
  questions: HTMLElement;
}

/** Frames for the activity indicator, matching the console's spinner. */
const ACTIVITY_FRAMES: readonly [string, ...string[]] = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

/** The item states that mean an item is finished, however it finished. */
const TERMINAL_ITEM_STATUSES: ReadonlySet<string> = new Set<string>([
  'done', 'error', 'unconfirmed', 'stalled', 'timeout',
]);

/** What each host-control tier hands the daemon, as the HOST lamp's title says it. */
const HOST_TIER_WORDS: Readonly<Record<string, string>> = {
  shell: '`!` runs on its host',
  pipes: 'pipes run on its host',
  files: 'upload/download reach its disk',
  tasks: 'jobs may change the cloud and bill',
};

/**
 * The HOST lamp's title: what the daemon's host-control tiers hand it.
 *
 * @param tiers - The tiers the attach ack carried.
 * @returns The title, or empty when there are none.
 */
export function hostTiers_title(tiers: ReadonlyArray<string>): string {
  if (tiers.length === 0) return '';
  return `Calypso was started with --host-control: ${tiers.map((tier: string): string => HOST_TIER_WORDS[tier] ?? tier).join('; ')}.`;
}

/**
 * Folds one progress message into the set of live keys.
 *
 * Pure, and exported for a test, because this is where "1 RUNNING" once
 * stuck forever: a pull reports each series under `pull:<uid>` and closes
 * the operation under `pull:` with no item id, so the closing message never
 * matched the keys it was meant to clear. Two things end a key now — the
 * operation saying it is complete or failed (which clears every key it
 * owns, id or no id), and an item reaching a terminal status (which clears
 * that one) — because a per-series retrieve carries its ending in `status`,
 * never in `phase`.
 *
 * @param running - The live-key set, mutated in place.
 * @param message - The progress event.
 */
export function running_reconcile(
  running: Set<string>,
  message: { operation: string; itemId?: string; phase?: string; status?: string },
): void {
  const key: string = `${message.operation}:${message.itemId ?? ''}`;
  if (message.phase === 'complete' || message.phase === 'failed') {
    // The operation is over: clear it and every item it owns.
    const prefix: string = `${message.operation}:`;
    for (const held of [...running]) {
      if (held === key || held.startsWith(prefix)) running.delete(held);
    }
    return;
  }
  if (message.itemId !== undefined && message.status !== undefined
      && TERMINAL_ITEM_STATUSES.has(message.status)) {
    running.delete(key);
    return;
  }
  running.add(key);
}

/** How often the activity indicator advances, in milliseconds. */
const ACTIVITY_FRAME_MS: number = 100;

/**
 * The status bar: paints live session telemetry into the LCARS top panel.
 */
export class StatusBar {
  private readonly fields: StatusFields;
  /** Whether the mismatch field holds the build readout (and may replace it). */
  private buildShown: boolean = false;
  private readonly running: Set<string> = new Set<string>();
  private activityTimer: number | null = null;
  private activityFrame: number = 0;

  /**
   * @param root - The document to query the status fields from.
   * @throws {Error} When a required status element is missing from the page.
   */
  constructor(private readonly root: Document) {
    this.fields = {
      identity: element_require(root, 'status-identity'),
      jobs: element_require(root, 'status-jobs'),
      activity: element_require(root, 'status-activity'),
      latency: element_require(root, 'status-latency'),
      mismatch: element_require(root, 'status-mismatch'),
      lamp: element_require(root, 'status-lamp'),
      host: element_require(root, 'status-host'),
      questions: element_require(root, 'status-questions'),
    };
  }

  /**
   * Records the attach facts, surfacing them only where they disagree.
   *
   * A matching contract and a healthy stack are the expected case and say
   * nothing worth a permanent readout. A mismatch is the one time these
   * numbers change what an operator should do, so that is when they appear.
   *
   * @param attach - The attach ack facts.
   */
  public attach_show(attach: AttachInfo): void {
    if (attach.protocolVersion !== CONTRACT_VERSION) {
      this.fields.mismatch.textContent =
        `WIRE V${attach.protocolVersion} ≠ V${CONTRACT_VERSION}`;
      this.fields.mismatch.title =
        'This surface and the daemon speak different contract versions. Some messages may be dropped.';
      this.hostControl_show(attach.hostControl ?? []);
      return;
    }
    this.fields.mismatch.textContent = '';
    this.fields.mismatch.title = attach.stack !== undefined
      ? `chell ${attach.stack.chell} · calypso ${attach.stack.calypso} · build ${attach.stack.build}`
      : '';
    this.hostControl_show(attach.hostControl ?? []);
  }

  /**
   * Reads out ARGUS and the calypso daemon as different builds on the
   * mismatch field, or takes that readout down; never over a contract
   * mismatch, which is graver.
   *
   * @param readout - What the field says; null takes the build readout down.
   * @param title - The whole sentence, on hover.
   */
  public build_show(readout: string | null, title: string = ''): void {
    if (this.fields.mismatch.textContent !== '' && !this.buildShown) return;
    this.buildShown = readout !== null;
    this.fields.mismatch.textContent = readout ?? '';
    this.fields.mismatch.title = title;
  }

  /**
   * The HOST lamp: amber while calypso acts on its own host, absent
   * otherwise — an annunciation, not an alert, and never at rest.
   *
   * @param tiers - Calypso's declared host-control tiers.
   */
  public hostControl_show(tiers: string[]): void {
    this.fields.host.textContent = tiers.length > 0 ? `HOST ${tiers.join(' ')}` : '';
    this.fields.host.title = hostTiers_title(tiers);
  }

  /**
   * The MODE readout: READ or MANAGE for a cloud session (D14); nothing for
   * a session with no such door. A page without the readout shows nothing.
   *
   * @param manage - True for MANAGE, false for READ, null for no door.
   */
  public mode_show(manage: boolean | null): void {
    const field: HTMLElement | null = this.root.querySelector<HTMLElement>('#status-mode');
    if (field === null) return;
    field.textContent = manage === null ? '' : `MODE ${manage ? 'MANAGE' : 'READ'}`;
    if (manage === null) delete field.dataset['mode']; else field.dataset['mode'] = manage ? 'MANAGE' : 'READ';
    field.title = manage === null ? '' : manage ? 'Entered as MANAGE: a build, a teardown or a deploy may run, each after its own question.' : 'Entered as READ: nothing outside this host changes; the first line that would act asks your password once.';
  }

  /**
   * Shows the questions open in the session: `? N WAITING`, each named in the
   * title (which surface asked what, and for how long); nothing when none is.
   *
   * @param questions - The open questions, from the heartbeat.
   */
  public questions_show(questions: ReadonlyArray<{ surface: string; message: string; sinceMs: number }>): void {
    this.fields.questions.textContent = questions.length > 0 ? `? ${questions.length} WAITING` : '';
    this.fields.questions.title = questions
      .map((open): string => `surface ${open.surface.slice(0, 6)} asks "${open.message.trim()}" (${Math.round(open.sinceMs / 1000)} s); its command is paused until answered there`)
      .join('\n');
  }

  /**
   * Paints the identity, the process-index count, and the last round-trip.
   *
   * @param context - The engine-known prompt facts.
   */
  public promptContext_show(context: PromptContext): void {
    const host: string = context.uri.replace(/^https?:\/\//, '');
    this.fields.identity.textContent = `${context.user}@${host}`.toUpperCase();

    // Index movement no command announces: the global sweep, one feed's
    // first-visit load, and roster arrivals share the JOBS readout.
    const warmup = context.procWarmup;
    const parts: string[] = [];
    if (warmup !== undefined && warmup.sweeping !== false) {
      const total: string = warmup.total !== undefined ? `/${warmup.total}` : '';
      const state: string = warmup.state !== undefined ? ` ${warmup.state.toUpperCase()}` : '';
      parts.push(`JOBS ${warmup.loaded}${total}${state}`);
    }
    // Every walk in flight, earliest first (older daemons send only the first).
    const walks = warmup?.feeds ?? (warmup?.feed !== undefined ? [warmup.feed] : []);
    for (const walk of walks) {
      const total: string = walk.total > 0 ? `/${walk.total}` : '';
      parts.push(walk.failed !== undefined ? `FEED ${walk.id} FAILED ${walk.loaded}${total}` : `FEED ${walk.id} ${walk.loaded}${total}`);
    }
    if (warmup?.roster !== undefined) parts.push(warmup.roster === 'full' ? 'ROSTER WALK' : 'ROSTER DELTA');
    if (warmup?.arrived !== undefined && warmup.arrived.length > 0) {
      parts.push(warmup.arrived.length <= 2
        ? `+FEED ${warmup.arrived.join(' ')}`
        : `+${warmup.arrived.length} FEEDS`);
    }
    // A warm-up that failed behind the prompt has no boot readout left to
    // be printed to. It stays here, named, until a later attempt clears
    // it: a message that vanishes is one nobody acts on.
    const failed = context.warmupFailures ?? [];
    if (failed.length > 0) {
      parts.push(`WARM-UP FAILED: ${failed.map((f) => f.label.toUpperCase()).join(' ')}`);
    }
    this.fields.jobs.textContent = parts.join(' \u00b7 ');
    this.fields.jobs.classList.toggle('status-degraded', failed.length > 0);
    this.fields.jobs.title = failed.length > 0
      ? failed.map((f) => `${f.label}: ${f.message}`).join('\n')
      : walks.length > 0
        ? 'A feed is being indexed on its first visit; it opens when the walk completes.'
        : '';

    this.fields.latency.textContent = context.lastCommandDurationMs > 0
      ? `${context.lastCommandDurationMs}MS`
      : '';
  }

  /**
   * Tracks live work so the bar shows that something is happening.
   *
   * Keyed the same way the console's progress rows are keyed, so one operation
   * reporting many items counts once rather than once per item.
   *
   * @param message - A progress event from the daemon.
   */
  public progress_observe(message: ProgressMessage): void {
    running_reconcile(this.running, message);
    this.activity_paint();
  }

  /** Clears live work, at the boundary of the command that announced it. */
  public activity_clear(): void {
    this.running.clear();
    this.activity_paint();
  }

  /**
   * Sets the connection lamp.
   *
   * @param connected - Whether the session socket is open.
   */
  public connection_show(connected: boolean): void {
    this.fields.lamp.textContent = connected ? 'ONLINE' : 'OFFLINE';
    this.fields.lamp.classList.toggle('lamp-online', connected);
    this.fields.lamp.classList.toggle('lamp-offline', !connected);
    if (!connected) {
      this.activity_clear();
    }
  }

  /** Starts, stops, and repaints the activity readout to match live work. */
  private activity_paint(): void {
    if (this.running.size === 0) {
      if (this.activityTimer !== null) {
        clearInterval(this.activityTimer);
        this.activityTimer = null;
      }
      this.fields.activity.textContent = '';
      return;
    }
    const draw = (): void => {
      const frame: string = ACTIVITY_FRAMES[this.activityFrame] ?? ACTIVITY_FRAMES[0];
      this.fields.activity.textContent = `${frame} ${this.running.size} RUNNING`;
    };
    draw();
    if (this.activityTimer === null) {
      this.activityTimer = window.setInterval((): void => {
        this.activityFrame = (this.activityFrame + 1) % ACTIVITY_FRAMES.length;
        draw();
      }, ACTIVITY_FRAME_MS);
    }
  }
}

/**
 * Fetches a required element by id.
 *
 * @param root - The document to query.
 * @param id - The element id.
 * @returns The element.
 * @throws {Error} When the element is absent.
 */
function element_require(root: Document, id: string): HTMLElement {
  const element: HTMLElement | null = root.getElementById(id);
  if (element === null) {
    throw new Error(`status bar: no element with id '${id}'`);
  }
  return element;
}
