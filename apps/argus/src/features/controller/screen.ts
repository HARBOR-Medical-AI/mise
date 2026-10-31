/**
 * @file The TD controller: the screen `cluster` takes over in a stratus
 * session, drawn from what the session says of its clusters and answering it
 * only with lines (docs/stratus.adoc, D13 and D14).
 *
 * Trek's layout under ARGUS's theme: the upper gutter carries the backend's
 * block and a pill per cluster with NEW; the header the cluster's condition,
 * where it is, what it costs, where its build stands and what changed since
 * the last command; the lower gutter the views, OVERVIEW, SIZE, BUILD,
 * CLUSTER, CHRIS and TEARDOWN, and LEAVE. A view changes the body; a control
 * sends a session line, which the log shows as typed, and a prompt at the
 * foot takes any line. The engine's questions stand on a strip over the
 * log, answered by a pill or a typed word, never skipped. Orange means money
 * runs; red means destroying.
 *
 * Pure of the wire: the host hands in the session's answers and events and
 * runs the lines the screen sends.
 *
 * @module
 */
import type { ClusterSizeModel, ClusterSpecModel, ClusterSummary, PromptKind } from '@fnndsc/menu';
import { takeoverFrame_build, type TakeoverFrame, type TakeoverView } from '../takeover/frame.js';
import {
  askForm_derive, CHRIS_STEPS, classBadge_render, conditionWhy_derive, CONTROLLER_VIEWS, duration_text, HOURS_PER_MONTH, LINES, money_text, nameRefusal_derive,
  newLine_build, planWords_render, since_build, sizeCost_compute, spec_copy, sizeFit_compute, stepLooks_build, stepsDone_count, summary_merge, verifyWords_render, zoneShort_format,
  type ControllerView, type SinceRow, type StepLook, type ZoneFitLook,
} from './model.js';

/** What the controller needs from its host. */
export interface ControllerHooks {
  /** Runs an operator's line (it may ask); its output arrives through `output_take`; resolves when it ends. */
  run: (line: string) => Promise<void>;
  /** Reads `cluster size` quietly; null when it did not answer the model. */
  size_read: (family?: string) => Promise<ClusterSizeModel | null>;
  /** Stops following the running line (the build goes on as its task). */
  stop: () => void;
  /** Gives the screen back. */
  leave: () => void;
  /** How the screen is heard. */
  voice: { pill: (label: string) => void; cue: (name: string) => void };
}

/** A question the engine put, standing on the strip. */
interface OpenAsk {
  message: string;
  kind: PromptKind;
  answer: (value: string | null) => void;
}

/** How many log lines are kept. */
const LOG_LIMIT: number = 400;

/** The NEW pill's key among the clusters. */
const NEW_KEY: string = '';

/** The view names as the gutter says them. */
const VIEW_LABELS: Readonly<Record<ControllerView, string>> = { overview: 'OVERVIEW', size: 'SIZE', build: 'BUILD', cluster: 'CLUSTER', chris: 'CHRIS', teardown: 'TEARDOWN' };

/**
 * Makes an element with a class and optional text.
 *
 * @param tag - The tag.
 * @param className - Its classes.
 * @param text - Its text.
 * @returns The element.
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Strips a terminal's colour codes from text the log shows.
 *
 * @param text - The text.
 * @returns It, plain.
 */
function plain_extract(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

/** The TD controller over a stratus session. */
export class TdController {
  /** The screen's root, appended to the body by the host while the controller is up. */
  public readonly root: HTMLElement;
  /** The ARGUS frame the controller is drawn in. */
  private readonly frame: TakeoverFrame;
  private readonly clusters: Map<string, ClusterSummary> = new Map();
  private current: string = NEW_KEY;
  private view: ControllerView = 'overview';
  /** The cluster as it stood when the last command was sent, for SINCE LAST COMMAND. */
  private before: ClusterSummary | null = null;
  private since: SinceRow[] = [{ label: '', text: 'FIRST READ' }];
  private size: ClusterSizeModel | null = null;
  private sizeAsked: boolean = false;
  private levers: ClusterSpecModel | null = null;
  private newName: string = '';
  /** The DNS zone a new cluster's names go under: the session's default until another is pressed. */
  private zone: string | null = null;
  private busy: string | null = null;
  private ask: OpenAsk | null = null;
  private partial: string = '';
  /** The lines of the build or plan running, for BUILD's log. */
  private stepLog: string[] = [];
  private stepLogLine: string | null = null;
  private readonly parts: {
    pills: HTMLElement; header: HTMLElement; views: Map<ControllerView, HTMLButtonElement>; body: HTMLElement;
    strip: HTMLElement; log: HTMLElement; input: HTMLInputElement; promptLabel: HTMLElement;
  };
  private ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * Builds the controller.
   *
   * @param hooks - The host's verbs.
   */
  constructor(private readonly hooks: ControllerHooks) {
    // The frame is ARGUS's own (features/takeover/frame.ts): the controller
    // fills its seat with the clusters' pills, its face with the readouts, its
    // stage with the views and its log with the session's lines.
    this.frame = takeoverFrame_build({
      id: 'td-controller',
      className: 'td-controller',
      brand: { name: 'STRATUS', sub: 'TD CONTROLLER · OCI', mark: true },
      banner: 'STRATUS • TD CONTROLLER',
      views: CONTROLLER_VIEWS.map((view: ControllerView): TakeoverView => ({ key: view, label: VIEW_LABELS[view], destroy: view === 'teardown' })),
      leave: { label: 'LEAVE' },
      stage: { title: 'NEW TRUSTED DOMAIN', note: VIEW_LABELS['size'] },
      log: { title: 'TRUSTED DOMAIN LOG', note: 'THE SESSION\'S LINES · TYPE BELOW' },
      labels: { views: 'Views', log: 'Cluster log' },
    }, (key: string): void => {
      const view: ControllerView | undefined = CONTROLLER_VIEWS.find((each: ControllerView): boolean => each === key);
      if (view === undefined) return;
      this.hooks.voice.pill(VIEW_LABELS[view]);
      this.view_show(view);
    }, (): void => { this.hooks.voice.pill('LEAVE'); this.hooks.leave(); });
    this.frame.leave.classList.add('tdc-leave');
    this.root = this.frame.root;
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-label', 'TD controller');

    const pills: HTMLElement = this.frame.seat;
    pills.setAttribute('aria-label', 'Clusters');
    const header: HTMLElement = el('header', 'tdc-header');
    this.frame.face.append(header);
    const views: Map<ControllerView, HTMLButtonElement> = new Map();
    for (const view of CONTROLLER_VIEWS) {
      const button: HTMLButtonElement | undefined = this.frame.views.get(view);
      if (button === undefined) continue;
      button.classList.add('tdc-view', `tdc-view-${view}`);
      views.set(view, button);
    }

    const body: HTMLElement = el('div', 'tdc-body');
    this.frame.body.append(body);
    const strip: HTMLElement = el('section', 'tdc-strip');
    strip.setAttribute('aria-label', 'The engine asks');
    strip.hidden = true;
    this.frame.aside.append(strip);

    const foot: HTMLElement = el('section', 'tdc-foot');
    const log: HTMLElement = el('div', 'tdc-log');
    log.setAttribute('aria-live', 'polite');
    const line: HTMLElement = el('div', 'tdc-prompt');
    const promptLabel: HTMLElement = el('label', 'tdc-prompt-label', 'stratus ›');
    const input: HTMLInputElement = el('input', 'tdc-prompt-input');
    input.id = 'tdc-prompt-input';
    promptLabel.setAttribute('for', input.id);
    input.placeholder = 'any session line · cluster plan · ls clusters/ · spend';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') return;
      const typed: string = input.value.trim();
      if (typed === '') return;
      input.value = '';
      void this.line_send(typed);
    });
    line.append(promptLabel, input);
    const logColumn: HTMLElement = el('div', 'tdc-log-column');
    logColumn.append(log, line);
    foot.append(logColumn);
    this.frame.log.append(foot);
    this.parts = { pills, header, views, body, strip, log, input, promptLabel };
    // The header's clock: time in the running step, and the cost so far, move between reads.
    this.ticker = setInterval((): void => { if (this.cluster_get()?.running) this.header_draw(); }, 15_000);
    this.draw();
  }

  /** Stops the controller's clock; the host calls it on leaving. */
  public dispose(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    this.ask?.answer(null);
    this.ask = null;
  }

  /**
   * The clusters as `cluster status` read them: every cluster replaced, the
   * chosen one kept (or the first when it is gone).
   *
   * @param clusters - The clusters.
   */
  public clusters_take(clusters: ReadonlyArray<ClusterSummary>): void {
    const was: ClusterSummary | null = this.cluster_get();
    this.clusters.clear();
    for (const cluster of clusters) this.clusters.set(cluster.name, cluster);
    if (this.current !== NEW_KEY && !this.clusters.has(this.current)) this.current = clusters[0]?.name ?? NEW_KEY;
    this.cues_play(was, this.cluster_get());
    this.draw();
  }

  /**
   * A cluster a build showed: merged over what was read.
   *
   * @param shown - The event's summary.
   */
  public cluster_take(shown: ClusterSummary): void {
    const was: ClusterSummary | undefined = this.clusters.get(shown.name);
    this.clusters.set(shown.name, summary_merge(was, shown));
    if (shown.name === this.current) this.cues_play(was ?? null, this.cluster_get());
    this.draw();
  }

  /**
   * Opens on a cluster: its name, or the first (NEW when there are none).
   *
   * @param name - The cluster, or `''` for the first.
   */
  public cluster_choose(name: string): void {
    this.current = name !== '' && this.clusters.has(name) ? name : this.clusters.keys().next().value ?? NEW_KEY;
    // NEW opens on SIZE, which needs what a cluster is sized against: ask for it here, as a press on SIZE does.
    if (this.current === NEW_KEY) { this.view = 'size'; void this.size_need(); }
    this.draw();
  }

  /** The cluster on the screen, or null on NEW. */
  public cluster_get(): ClusterSummary | null {
    return this.clusters.get(this.current) ?? null;
  }

  /** The view on the screen. */
  public view_get(): ControllerView {
    return this.view;
  }

  /** The names of the clusters drawn. */
  public names_get(): string[] {
    return [...this.clusters.keys()];
  }

  /**
   * Output from the running line: the log, and BUILD's log while a build or plan runs.
   *
   * @param chunk - The text.
   */
  public output_take(chunk: string): void {
    const text: string = this.partial + plain_extract(chunk);
    const lines: string[] = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const one of lines) this.log_add(one, 'out');
  }

  /**
   * The engine asks: the strip stands until it is answered.
   *
   * @param message - The question.
   * @param kind - What answers it.
   * @returns The answer, or null when abandoned.
   */
  public ask_take(message: string, kind: PromptKind): Promise<string | null> {
    this.ask?.answer(null);
    this.hooks.voice.cue('hail');
    return new Promise((resolve: (value: string | null) => void): void => {
      this.ask = { message, kind, answer: (value: string | null): void => { this.ask = null; this.strip_draw(); resolve(value); } };
      this.log_add(message, 'ask');
      this.strip_draw();
    });
  }

  /** Whether a question stands on the strip. */
  public asking_is(): boolean {
    return this.ask !== null;
  }

  /**
   * Sends a line: shown in the log as typed, run by the host, and the
   * cluster remembered as it stood, for SINCE LAST COMMAND.
   *
   * @param line - The line.
   */
  public async line_send(line: string): Promise<void> {
    if (this.busy !== null) {
      this.log_add(`the lane is held by: ${this.busy} (STOP FOLLOWING frees it; the build goes on)`, 'note');
      return;
    }
    this.before = this.cluster_get();
    this.busy = line;
    this.log_add(`stratus> ${line}`, 'sent');
    if (/^(cluster (build|plan)|play) /.test(line)) { this.stepLog = []; this.stepLogLine = line; }
    this.draw();
    try {
      await this.hooks.run(line);
    } finally {
      if (this.partial !== '') { this.log_add(this.partial, 'out'); this.partial = ''; }
      this.busy = null;
      const now: ClusterSummary | null = this.cluster_get();
      if (now !== null) this.since = since_build(this.before, now);
      this.draw();
    }
  }

  /**
   * After a line's read: SINCE LAST COMMAND against the cluster as it stood when the line was sent.
   */
  public since_refresh(): void {
    const now: ClusterSummary | null = this.cluster_get();
    if (now !== null) this.since = since_build(this.before?.name === now.name ? this.before : null, now);
    this.header_draw();
  }

  /** The tab title while the controller is up: the condition and the cluster (`ASKING · quay`). */
  public title_get(): string {
    const cluster: ClusterSummary | null = this.cluster_get();
    return cluster === null ? 'SIZING · NEW TRUSTED DOMAIN' : `${cluster.condition ?? 'READING'} · ${cluster.name}`;
  }

  /**
   * Shows a view.
   *
   * @param view - The view.
   */
  public view_show(view: ControllerView): void {
    this.view = view;
    if (view === 'size') void this.size_need();
    this.draw();
  }

  // ---------------------------------------------------------------- drawing

  private draw(): void {
    this.pills_draw();
    this.header_draw();
    this.frame.view_mark(this.view);
    for (const [view, button] of this.parts.views) button.classList.toggle('tdc-view-on', view === this.view);
    this.frame.stageTitle.textContent = this.current === NEW_KEY ? 'NEW TRUSTED DOMAIN' : this.current.toUpperCase();
    this.frame.stageNote.textContent = VIEW_LABELS[this.view];
    this.body_draw();
    this.strip_draw();
    this.parts.promptLabel.textContent = this.current === NEW_KEY ? 'stratus ›' : `stratus ~/${this.current} ›`;
    this.parts.input.disabled = this.busy !== null;
    this.root.dataset['busy'] = this.busy === null ? 'no' : 'yes';
    document.title = this.title_get();
  }

  private pills_draw(): void {
    const pills: HTMLElement = this.parts.pills;
    pills.replaceChildren();
    for (const name of [...this.clusters.keys(), NEW_KEY]) {
      const cluster: ClusterSummary | undefined = this.clusters.get(name);
      const pill: HTMLButtonElement = el('button', 'tdc-cluster takeover-seat-pill', name === NEW_KEY ? '+ NEW' : name.toUpperCase());
      pill.type = 'button';
      pill.dataset['condition'] = cluster?.condition ?? 'SIZING';
      if (cluster?.billing === true) pill.classList.add('tdc-billing');
      pill.setAttribute('aria-current', name === this.current ? 'true' : 'false');
      pill.addEventListener('click', (): void => {
        this.hooks.voice.pill(pill.textContent ?? '');
        if (name === NEW_KEY) { this.current = NEW_KEY; this.view_show('size'); return; }
        // A cluster's pill sends its line, as typing it would.
        this.current = name;
        if (this.view === 'size' && this.levers !== null) this.levers = null;
        void this.line_send(LINES.status(name));
      });
      pills.append(pill);
    }
  }

  private header_draw(): void {
    const header: HTMLElement = this.parts.header;
    header.replaceChildren();
    const cluster: ClusterSummary | null = this.cluster_get();
    header.append(this.condition_make(cluster));
    if (cluster === null) {
      header.append(
        this.headSection_make('TRUSTED DOMAIN', [['NAME', this.newName === '' ? '[NAME IT ON SIZE]' : this.newName], ['REGION', this.size?.region ?? '…'], ['ADDRESS', this.size === null ? '…' : this.zone === null ? 'NO ZONE · CHOOSE ONE ON SIZE' : `${this.newName || '<name>'}.${this.zone}`]]),
        this.headSection_make('COST · AS SIZED', this.sizedCost_rows()),
        this.headSection_make('FIT', this.fit_rows()),
        this.headSection_make('SINCE LAST CHANGE', [['', 'NOTHING WRITTEN YET']]),
      );
      return;
    }
    const tenancy: string = cluster.path.match(/^\/net\/[^/]+\/([^/]+)\//)?.[1] ?? '?';
    header.append(
      this.headSection_make('TRUSTED DOMAIN', [['TENANCY', tenancy], ['REGION', cluster.region ?? '?'], ['ADDRESS', cluster.cluster ?? (cluster.origin === 'found' ? 'NO ZONE KNOWN' : '?')]]),
      this.headSection_make('COST', this.cost_rows(cluster), cluster.billing === true ? 0 : -1),
      this.headSection_make('BUILD', this.build_rows(cluster)),
      this.since_make(),
    );
  }

  private condition_make(cluster: ClusterSummary | null): HTMLElement {
    const section: HTMLElement = el('section', 'tdc-head-condition');
    section.setAttribute('aria-label', 'Condition');
    const pill: HTMLElement = el('div', 'tdc-condition');
    const condition: string = cluster?.condition ?? 'SIZING';
    pill.dataset['condition'] = condition;
    pill.append(el('span', 'tdc-condition-label', 'CONDITION'), el('span', 'tdc-condition-name', condition));
    const why = cluster === null ? { text: 'NOTHING BUILT · NOTHING BILLED', billing: false } : conditionWhy_derive(cluster);
    const whyLine: HTMLElement = el('div', `tdc-condition-why${why.billing ? ' tdc-bill' : ''}`, why.text);
    const chips: HTMLElement = el('div', 'tdc-chips');
    if (cluster !== null) {
      const steps = stepsDone_count(cluster);
      chips.append(el('span', 'tdc-chip', `${steps.done} OF ${steps.total} DONE${cluster.origin === 'found' ? ' · FROM THE CLOUD' : ''}`), el('span', 'tdc-chip tdc-chip-class', classBadge_render(cluster)));
      // A found cluster with nothing left of it has nothing a lock would keep.
      if (!(cluster.origin === 'found' && cluster.condition === 'GONE')) chips.append(this.lock_make(cluster));
    } else {
      chips.append(el('span', 'tdc-chip', 'NO SPEC YET'));
    }
    section.append(pill, whyLine, chips);
    return section;
  }

  private lock_make(cluster: ClusterSummary): HTMLElement {
    const on: boolean = cluster.protected !== false;
    const chip: HTMLElement = el('span', `tdc-chip tdc-lock${on ? ' tdc-lock-on' : ' tdc-lock-off'}`);
    chip.append(this.lockIcon_make(on), document.createTextNode(on ? 'PROTECTED' : 'UNLOCKED'));
    chip.title = on ? `teardown refused until: cluster protect ${cluster.name} off` : 'teardown may run; it still asks for the name typed back';
    return chip;
  }

  private lockIcon_make(on: boolean): SVGElement {
    const ns: 'http://www.w3.org/2000/svg' = 'http://www.w3.org/2000/svg';
    const icon: SVGElement = document.createElementNS(ns, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('width', '12');
    icon.setAttribute('height', '12');
    icon.setAttribute('aria-hidden', 'true');
    const shackle: SVGElement = document.createElementNS(ns, 'path');
    shackle.setAttribute('d', on ? 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2' : 'M4.5 7V5a3.5 3.5 0 0 1 6.8-1.2');
    shackle.setAttribute('fill', 'none');
    shackle.setAttribute('stroke', 'currentColor');
    shackle.setAttribute('stroke-width', '1.8');
    const body: SVGElement = document.createElementNS(ns, 'rect');
    for (const [key, value] of [['x', '3'], ['y', '7'], ['width', '10'], ['height', '7'], ['rx', '1.5'], ['fill', 'currentColor']]) body.setAttribute(key as string, value as string);
    icon.append(shackle, body);
    return icon;
  }

  private headSection_make(title: string, rows: ReadonlyArray<[string, string]>, billingRow: number = -1): HTMLElement {
    const section: HTMLElement = el('section', 'tdc-head-section');
    section.setAttribute('aria-label', title);
    section.append(el('span', 'tdc-head-title', title));
    const grid: HTMLElement = el('div', 'tdc-head-grid');
    rows.forEach(([label, value]: [string, string], index: number): void => {
      grid.append(el('span', `tdc-head-label${index === billingRow ? ' tdc-head-label-bill' : ''}`, label), el('span', 'tdc-head-value', value));
    });
    section.append(grid);
    return section;
  }

  private since_make(): HTMLElement {
    const section: HTMLElement = el('section', 'tdc-head-section');
    section.setAttribute('aria-label', 'Since the last command');
    section.append(el('span', 'tdc-head-title', 'SINCE LAST COMMAND'));
    const grid: HTMLElement = el('div', 'tdc-since');
    for (const row of this.since) grid.append(el('span', 'tdc-since-label', row.label), el('span', 'tdc-since-value', row.text));
    section.append(grid);
    return section;
  }

  private cost_rows(cluster: ClusterSummary): Array<[string, string]> {
    if (cluster.cost === null || cluster.cost === undefined) return [['PER HOUR', cluster.billing === true ? 'NOT PRICED' : '0'], ['SO FAR', '—'], ['A MONTH', '—']];
    const { hourly, soFar, currency } = cluster.cost;
    return [['PER HOUR', `${money_text(hourly, currency)} · EST`], ['SO FAR', money_text(soFar, currency)], ['A MONTH', `${money_text(hourly * HOURS_PER_MONTH, currency, 0)} · AT THIS RATE`]];
  }

  private build_rows(cluster: ClusterSummary): Array<[string, string]> {
    const last: string = cluster.lastDone === null ? 'nothing' : cluster.lastDone.replace(/^\d+-/, '');
    const running: string = cluster.running === null || cluster.running === undefined ? 'nothing'
      : `${cluster.running.step ?? 'between steps'}${cluster.running.since !== null ? ` · ${duration_text(Date.now() - Date.parse(cluster.running.since))}` : ''}`;
    const plan: string = cluster.plan === null || cluster.plan === undefined ? 'none kept' : planWords_render(cluster.plan);
    return [['LAST DONE', last], ['RUNNING', running], ['LAST PLAN', plan]];
  }

  private sizedCost_rows(): Array<[string, string]> {
    if (this.size === null || this.levers === null) return [['PER HOUR', '…'], ['A MONTH', '…'], ['SO FAR', '0']];
    const cost = sizeCost_compute(this.size, this.levers);
    return [['PER HOUR', cost.hourly === null ? 'NOT PRICED' : `${money_text(cost.hourly, cost.currency)} · EST`], ['A MONTH', cost.hourly === null ? '—' : `${money_text(cost.hourly * HOURS_PER_MONTH, cost.currency, 0)} · EST`], ['SO FAR', '0']];
  }

  private fit_rows(): Array<[string, string]> {
    if (this.size === null || this.levers === null) return [['ZONES', '…']];
    const fits: ZoneFitLook[] = sizeFit_compute(this.size, this.levers, this.newName || 'new');
    const fitting: number = fits.filter((fit: ZoneFitLook): boolean => fit.fits === true).length;
    const tight: ZoneFitLook | undefined = fits.find((fit: ZoneFitLook): boolean => fit.tightest);
    return [['ZONES', `${fitting} OF ${fits.length} FIT`], ['TIGHTEST', tight === undefined ? '—' : zoneShort_format(tight.zone)], ['FAMILY', this.levers.family]];
  }

  private body_draw(): void {
    const body: HTMLElement = this.parts.body;
    body.replaceChildren();
    body.dataset['view'] = this.view;
    const cluster: ClusterSummary | null = this.cluster_get();
    if (this.view === 'size') { body.append(...this.size_make(cluster)); return; }
    if (cluster === null) {
      body.append(this.empty_make('NO CLUSTER CHOSEN', 'Press + NEW and size one on SIZE, or a cluster\'s pill above.'));
      return;
    }
    const views: Record<Exclude<ControllerView, 'size'>, () => HTMLElement[]> = {
      overview: (): HTMLElement[] => this.overview_make(cluster),
      build: (): HTMLElement[] => this.build_make(cluster),
      cluster: (): HTMLElement[] => this.cluster_make(cluster),
      chris: (): HTMLElement[] => this.chris_make(cluster),
      teardown: (): HTMLElement[] => this.teardown_make(cluster),
    };
    body.append(...views[this.view as Exclude<ControllerView, 'size'>]());
    // A log drawn anew opens at its end, where the step is.
    const steplog: HTMLElement | null = body.querySelector('.tdc-steplog');
    if (steplog !== null) steplog.scrollTop = steplog.scrollHeight;
  }

  private empty_make(title: string, text: string): HTMLElement {
    const box: HTMLElement = el('section', 'tdc-empty');
    box.append(el('span', 'tdc-section-title', title), el('p', 'tdc-prose', text));
    return box;
  }

  private section_make(title: string, className: string = '', aside?: string): HTMLElement {
    const section: HTMLElement = el('section', `tdc-section ${className}`.trim());
    section.setAttribute('aria-label', title);
    const head: HTMLElement = el('div', 'tdc-section-head');
    head.append(el('span', 'tdc-section-title', title));
    if (aside !== undefined) head.append(el('span', 'tdc-section-aside', aside));
    section.append(head);
    return section;
  }

  private pairs_make(rows: ReadonlyArray<[string, string]>, className: string = ''): HTMLElement {
    const grid: HTMLElement = el('div', `tdc-pairs ${className}`.trim());
    for (const [label, value] of rows) grid.append(el('span', 'tdc-pair-label', label), el('span', 'tdc-pair-value', value));
    return grid;
  }

  /**
   * A pill that sends a line; refused (drawn, never pressed) with why when the verb is refused.
   *
   * @param label - Its word.
   * @param line - The line it sends.
   * @param tone - How it is drawn.
   * @param refused - Why it is refused, if it is.
   * @returns The pill, and the line it sends beneath.
   */
  private linePill_make(label: string, line: string, tone: 'plain' | 'bill' | 'destroy' | 'quiet' = 'plain', refused?: string): HTMLButtonElement {
    const pill: HTMLButtonElement = el('button', `tdc-pill tdc-pill-${tone}`, refused === undefined ? label : `${label} · REFUSED`);
    pill.type = 'button';
    pill.title = refused === undefined ? `sends: ${line}` : `refused: ${refused}`;
    pill.disabled = refused !== undefined || this.busy !== null;
    pill.addEventListener('click', (): void => { this.hooks.voice.pill(label); void this.line_send(line); });
    return pill;
  }

  private spec_make(spec: ClusterSpecModel | null | undefined, found: boolean = false): HTMLElement[] {
    if (spec === null || spec === undefined) return [el('p', 'tdc-prose', found ? 'No spec here: ADOPT reads the spec its stack says.' : 'No spec kept: a cluster read from a checkout says its spec in its own files (cat spec.yaml).')];
    const pool = (one: ClusterSpecModel['controlPlane']): string => `${one.count} × ${one.vcpu} vCPU · ${one.ramGib} GiB · ${one.bootGib} GiB ${one.bootTier.toUpperCase()}`;
    return [
      this.pairs_make([['FAMILY', spec.family], ['CONTROL PLANE', pool(spec.controlPlane)], ['WORKERS', spec.workers.count === 0 ? '0 · COMPACT, PLANE SCHEDULABLE' : pool(spec.workers)]]),
    ];
  }

  private chrisSpec_make(spec: ClusterSpecModel | null | undefined): HTMLElement {
    if (spec === null || spec === undefined) return el('p', 'tdc-prose', '—');
    return this.pairs_make([['DATA', `${spec.chris.dataGib} GiB · GROWS, NEVER SHRINKS`], ['DATABASE · QUEUE', `${spec.chris.databaseGib} GiB · ${spec.chris.queueGib} GiB · FIXED`]]);
  }

  private classNote_make(cluster: ClusterSummary): HTMLElement {
    const note: HTMLElement = el('div', `tdc-note tdc-note-${cluster.origin ?? 'built'}`);
    const badge: string = classBadge_render(cluster);
    note.append(el('span', 'tdc-note-title', badge));
    if (cluster.origin === 'adopted') {
      note.append(el('span', 'tdc-prose', 'Built by harbor-oci. Its installer ids and its Terraform state are kept by stratus; it is planned against, never built on.'));
      note.append(el('span', 'tdc-prose tdc-quiet', `build refused: ${cluster.refused?.['build'] ?? 'adopted'}`));
    } else if (cluster.origin === 'found' && cluster.condition === 'GONE') {
      // Nothing of it is left in the tenancy but what carries its tag: its stack and its compartment (docs/stratus.adoc, D15).
      note.append(el('span', 'tdc-prose', `Torn down, or never built: nothing of it lives, and its stack holds nothing. What is left carries its tag: ${this.leftovers_words(cluster)}. REMOVE WHAT IS LEFT takes those away, after the name typed back; no adoption first.`));
      note.append(this.linePill_make('REMOVE WHAT IS LEFT', LINES.teardown(cluster.name), 'destroy', cluster.refused?.['teardown']));
    } else if (cluster.origin === 'found') {
      // Found in the tenancy by its tag and read from the cloud: address, spec and condition shown; acting on it waits on ADOPT (docs/stratus.adoc, D15).
      note.append(el('span', 'tdc-prose', 'Found in the tenancy by its tag. What is shown is what the cloud says of it: its address and spec from its stack, its condition from what lives in its compartment. ADOPT keeps it here, which is what PLAN, VERIFY, BUILD and TEAR DOWN wait on; its kubeconfig and CUBE token are then copied by hand.'));
      note.append(this.linePill_make('ADOPT', LINES.adopt(cluster.name)));
    } else if (cluster.origin === 'checkout') {
      note.append(el('span', 'tdc-prose', 'Read from a harbor-oci checkout. Adopting it keeps it here: cluster adopt <name> --from <checkout>.'));
    } else if (cluster.gone !== null && cluster.gone !== undefined) {
      note.append(el('span', 'tdc-prose', `Torn down ${cluster.gone.slice(0, 16).replace('T', ' ')}. Its spec and its record are kept.`));
    } else {
      note.append(el('span', 'tdc-prose', cluster.protected !== false ? 'Built by this daemon, and protected: teardown is refused until the lock is lifted, as a line of its own.' : 'Built by this daemon. The lock is off: teardown may run, and still asks for the name typed back.'));
    }
    return note;
  }

  private overview_make(cluster: ClusterSummary): HTMLElement[] {
    const spec: HTMLElement = this.section_make('SPEC · THE CLUSTER', 'tdc-col-spec');
    // What the cluster is comes first; for one found in the tenancy, that is what the cloud said of it.
    spec.append(this.classNote_make(cluster), ...this.spec_make(cluster.spec, cluster.origin === 'found'), el('span', 'tdc-section-title tdc-gap', 'SPEC · CHRIS ON IT'), this.chrisSpec_make(cluster.spec));

    const steps: HTMLElement = this.section_make(cluster.origin === 'found' ? 'STEPS · AS FAR AS THE CLOUD ATTESTS THEM' : 'STEPS · THE MACHINE, THEN CHRIS', 'tdc-col-steps', 'PRESS A STEP · BUILD OPENS ON IT');
    const grid: HTMLElement = el('div', 'tdc-step-grid');
    for (const look of stepLooks_build(cluster)) {
      const cell: HTMLButtonElement = el('button', `tdc-step tdc-step-${look.tone}${look.billFrom ? ' tdc-step-billfrom' : ''}`);
      cell.type = 'button';
      cell.setAttribute('aria-label', `${look.name}, ${look.word}`);
      cell.title = look.note;
      cell.append(el('span', 'tdc-step-n', look.n), el('span', 'tdc-step-name', look.name), el('span', 'tdc-step-note', look.note), el('span', 'tdc-step-word', look.word));
      cell.addEventListener('click', (): void => { this.hooks.voice.pill(look.name); this.view_show('build'); });
      grid.append(cell);
    }
    steps.append(grid, el('div', 'tdc-billing-line', `BILLING STARTS AT ${(cluster.billingStep ?? 'infra-apply').toUpperCase()} · EVERY STEP AFTER IT RUNS ON PAID MACHINES`));
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(el('span', 'tdc-commands-label', 'CLUSTER'),
      this.linePill_make('PLAN', LINES.plan(cluster.name), 'plain', cluster.refused?.['plan']),
      this.linePill_make('VERIFY', LINES.verify(cluster.name), 'plain', cluster.refused?.['verify']),
      this.linePill_make('SPEND', LINES.spend(cluster.name)),
      el('span', 'tdc-flex'),
      this.linePill_make('BUILD', LINES.build(cluster.name), 'bill', cluster.refused?.['build']));
    steps.append(commands);

    const glance: HTMLElement = this.section_make('THE CLUSTER AT A GLANCE', 'tdc-col-glance');
    const verify: string = cluster.verify === null || cluster.verify === undefined ? this.verifyUnkept_render(cluster) : `${verifyWords_render(cluster.verify.checks)} · ${(cluster.verify.at ?? '').slice(0, 16).replace('T', ' ')}`;
    glance.append(this.pairs_make([['ADDRESS', cluster.cluster ?? '?'], ['VERIFY', verify], ['RUNNING', cluster.running === null || cluster.running === undefined ? 'nothing' : cluster.running.step ?? 'between steps']]));
    glance.append(el('span', 'tdc-section-title tdc-gap', 'IN ITS COMPARTMENT'));
    glance.append(this.resources_make(cluster));
    glance.append(el('p', 'tdc-prose tdc-quiet', 'Nodes per zone and projects come with the cluster in the tree (cluster/).'));
    return [spec, steps, glance];
  }

  /**
   * What verify says when no checks are kept: the step's own line, or that it has not run.
   *
   * @param cluster - The cluster.
   * @returns The words.
   */
  private verifyUnkept_render(cluster: ClusterSummary): string {
    const step = cluster.steps.find((one): boolean => one.name === 'verify');
    return step !== undefined && step.state !== 'not done' ? `${(step.evidence ?? step.state).toUpperCase()} · CHECKS NOT KEPT` : 'NOT RUN';
  }

  private resources_make(cluster: ClusterSummary): HTMLElement {
    if (cluster.resources === null) return el('p', 'tdc-prose tdc-quiet', 'not counted');
    const rows: Array<[string, string]> = Object.entries(cluster.resources).filter(([, count]): boolean => count > 0).map(([kind, count]): [string, string] => [kind.toUpperCase(), String(count)]);
    return rows.length === 0 ? el('p', 'tdc-prose', 'nothing live') : this.pairs_make(rows, 'tdc-pairs-narrow');
  }

  private strip_make(cluster: ClusterSummary): HTMLElement {
    const strip: HTMLElement = this.section_make('STEPS', 'tdc-col-strip');
    for (const look of stepLooks_build(cluster)) {
      if (look.billFrom) strip.append(el('div', 'tdc-billing-from', 'BILLING FROM HERE'));
      const row: HTMLElement = el('div', `tdc-strip-step tdc-step-${look.tone}`);
      row.setAttribute('aria-label', `${look.name}, ${look.word}`);
      row.title = look.note;
      row.append(el('span', 'tdc-strip-name', look.name), el('span', 'tdc-strip-word', look.word));
      strip.append(row);
    }
    return strip;
  }

  private build_make(cluster: ClusterSummary): HTMLElement[] {
    const middle: HTMLElement = el('div', 'tdc-col-middle');
    const running = cluster.running;
    if (running !== null && running !== undefined) {
      const now: HTMLElement = this.section_make(`RUNNING · ${(running.step ?? 'between steps').toUpperCase()}`, 'tdc-running', `/proc/steps/${running.job}`);
      now.append(this.pairs_make([['SINCE', running.since === null ? '?' : `${running.since.slice(11, 16)} · ${duration_text(Date.now() - Date.parse(running.since))}`], ['THE TASK', 'goes on with every surface closed, and after a daemon restart']]));
      const controls: HTMLElement = el('div', 'tdc-commands');
      const following: boolean = this.busy !== null && this.busy.startsWith(`cluster build ${cluster.name}`);
      const kill: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-destroy', 'KILL');
      kill.type = 'button';
      kill.title = `stops following, then sends: ${LINES.kill(running.job)}`;
      kill.addEventListener('click', (): void => { this.hooks.voice.pill('KILL'); void this.kill_send(running.job); });
      const follow: HTMLButtonElement = following ? el('button', 'tdc-pill tdc-pill-quiet', 'STOP FOLLOWING') : this.linePill_make('FOLLOW', LINES.follow(cluster.name), 'quiet');
      if (following) {
        follow.type = 'button';
        follow.title = 'Ctrl-C: stops following; the build goes on';
        follow.addEventListener('click', (): void => { this.hooks.voice.pill('STOP FOLLOWING'); this.hooks.stop(); });
      }
      controls.append(kill, el('span', 'tdc-commands-label', 'ASKS THE STEP TO STOP · NEVER FORCES'), el('span', 'tdc-flex'), follow);
      now.append(controls);
      middle.append(now);
    }
    const plan: HTMLElement = this.section_make('THE PLAN', 'tdc-plan', cluster.plan?.at ? `MADE ${cluster.plan.at.slice(0, 16).replace('T', ' ')}` : undefined);
    if (cluster.plan === null || cluster.plan === undefined) {
      plan.append(el('p', 'tdc-prose', cluster.origin === 'adopted' ? 'No plan kept here. PLAN, under the tasks tier, plans against the adopted state; an apply is refused.' : 'No plan yet. BUILD makes it at infra-plan, and nothing it makes bills.'));
    } else {
      const counts: HTMLElement = el('div', 'tdc-plan-counts');
      const count = (label: string, value: number, tone: string, note?: string): HTMLElement => {
        const box: HTMLElement = el('div', `tdc-plan-count tdc-plan-${tone}`);
        box.append(el('span', 'tdc-plan-count-label', label), el('span', 'tdc-plan-count-value', String(value)));
        if (note !== undefined) box.append(el('span', 'tdc-plan-count-note', note));
        return box;
      };
      counts.append(count('TO CREATE', cluster.plan.create, 'create'), count('TO CHANGE', cluster.plan.change + cluster.plan.replace + cluster.plan.drift, 'change', cluster.plan.drift > 0 ? `${cluster.plan.drift} ORACLE-TAGS DRIFT · ${cluster.plan.change + cluster.plan.replace} REAL` : undefined), count('TO DESTROY', cluster.plan.destroy, 'destroy'));
      const rows: HTMLElement = el('div', 'tdc-plan-rows');
      const marks: Readonly<Record<string, string>> = { create: '+', change: '~', drift: '~', replace: '±', destroy: '−' };
      for (const group of cluster.plan.groups.slice(0, 14)) {
        rows.append(el('span', `tdc-plan-mark tdc-plan-${group.action}`, marks[group.action] ?? '?'), el('span', 'tdc-plan-kind', `${group.kind}${group.action === 'drift' ? ' · tag drift' : group.action === 'replace' ? ' · replaced' : ''}`), el('span', 'tdc-plan-n', String(group.count)), el('span', 'tdc-plan-names', group.names.slice(0, 4).join(' · ') + (group.names.length > 4 ? ` … ${group.names.length - 4} more` : '')));
      }
      plan.append(counts, rows);
    }
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(this.linePill_make('PLAN', LINES.plan(cluster.name), 'plain', cluster.refused?.['plan']), el('span', 'tdc-flex'), this.linePill_make('BUILD · THROUGH RUN', LINES.build(cluster.name), 'bill', cluster.refused?.['build']));
    plan.append(commands);
    middle.append(plan);

    const logBox: HTMLElement = this.section_make('THE STEP\'S LOG', 'tdc-col-steplog', this.stepLogLine ?? (running ? `/proc/steps/${running.job}/log` : undefined));
    const lines: HTMLElement = el('div', 'tdc-steplog');
    const shown: string[] = this.stepLog.slice(-60);
    if (shown.length === 0) lines.append(el('span', 'tdc-quiet', running ? `following shows it here (FOLLOW, or: cat /proc/steps/${running.job}/log)` : 'nothing run from here yet'));
    for (const one of shown) lines.append(el('span', 'tdc-steplog-line', one));
    logBox.append(lines);
    return [this.strip_make(cluster), middle, logBox];
  }

  private cluster_make(cluster: ClusterSummary): HTMLElement[] {
    const checks: HTMLElement = this.section_make('VERIFY · TEN CHECKS', 'tdc-col-wide', cluster.verify?.at ? `LAST RUN ${cluster.verify.at.slice(0, 16).replace('T', ' ')}` : 'NOT RUN HERE');
    if (cluster.verify === null || cluster.verify === undefined) {
      checks.append(el('p', 'tdc-prose', `${this.verifyUnkept_render(cluster)}. VERIFY runs the checks through the cluster's kubeconfig, which stays on the host, and keeps them.`));
    } else {
      const grid: HTMLElement = el('div', 'tdc-checks');
      for (const check of cluster.verify.checks) {
        const tone: string = check.ok === true ? 'pass' : check.ok === false ? 'fail' : 'skip';
        grid.append(el('span', `tdc-check-mark tdc-check-${tone}`, check.ok === true ? '✓' : check.ok === false ? '✗' : '–'), el('span', 'tdc-check-name', check.name), el('span', 'tdc-check-detail', check.detail), el('span', `tdc-check-how${check.how === 'writes' ? ' tdc-bill' : ''}`, check.how.toUpperCase()));
      }
      checks.append(grid);
    }
    const note: HTMLElement = el('div', 'tdc-note tdc-note-bill');
    note.append(el('span', 'tdc-note-title', 'ONE CHECK WRITES'), el('span', 'tdc-prose', 'The block-volume probe makes a claim and a pod, writes, reads back and removes both: it runs only under the tasks tier; without it verify says so and runs the other nine.'));
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(this.linePill_make('VERIFY', LINES.verify(cluster.name), 'plain', cluster.refused?.['verify']));
    checks.append(note, commands);
    const side: HTMLElement = this.section_make('IN ITS COMPARTMENT', 'tdc-col-side');
    side.append(this.resources_make(cluster), el('span', 'tdc-section-title tdc-gap', 'ACCESS'), this.pairs_make([['KUBECONFIG', 'ON THE HOST · NEVER SHOWN HERE'], ['KUBEADMIN', 'ON THE HOST · NEVER SHOWN HERE']]), el('p', 'tdc-prose tdc-quiet', 'Nodes per zone and the cluster\'s projects come with the cluster in the tree (cluster/).'));
    return [checks, side];
  }

  private chris_make(cluster: ClusterSummary): HTMLElement[] {
    const storage: HTMLElement = this.section_make('STORAGE · THE SPEC\'S CHRIS HALF', 'tdc-col-spec');
    storage.append(this.chrisSpec_make(cluster.spec), el('p', 'tdc-prose tdc-bill', 'DATA grows with a new spec and a plan; it never shrinks. DATABASE and QUEUE are fixed from the first deploy.'));
    const steps: HTMLElement = this.section_make('THE APPLICATION\'S STEPS', 'tdc-col-steps');
    const looks: StepLook[] = stepLooks_build(cluster).filter((look: StepLook): boolean => CHRIS_STEPS.includes(look.name));
    for (const look of looks) {
      const row: HTMLElement = el('div', `tdc-chris-step tdc-step-${look.tone}`);
      const head: HTMLElement = el('div', 'tdc-chris-step-head');
      head.append(el('span', 'tdc-chris-step-name', look.name.toUpperCase()), el('span', 'tdc-chris-step-word', look.word));
      row.append(head, el('span', 'tdc-prose', look.note === '' ? '—' : look.note));
      steps.append(row);
    }
    const commands: HTMLElement = el('div', 'tdc-commands');
    const smoke: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', 'SMOKE AGAIN · LATER');
    smoke.type = 'button';
    smoke.disabled = true;
    smoke.title = 'the build runs the smoke journey once, as its last step; running it again is a line of its own, not written yet';
    commands.append(smoke);
    steps.append(commands);
    const cube: HTMLElement = this.section_make('THE CUBE', 'tdc-col-glance');
    const attach: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', 'ATTACH · LATER');
    attach.type = 'button';
    attach.disabled = true;
    attach.title = 'cluster attach starts the cluster session; it comes after the ChRIS steps';
    cube.append(this.pairs_make([['SIGN-IN', 'THE TRUSTED DOMAIN\'S OWN'], ['CUBE', cluster.steps.some((step): boolean => step.name === 'chris-deploy' && step.state === 'done') ? `cube.apps.${cluster.cluster ?? ''}` : 'NOT DEPLOYED']]),
      el('p', 'tdc-prose', 'ATTACH starts the cluster session: a second daemon on the ChRIS backend, signed in through the cluster\'s own sign-in. This session never holds the CUBE token; that one never holds a cloud key.'), attach);
    return [storage, steps, cube];
  }

  /** What a found cluster with nothing left still carries: its stack, its compartment, what the compartment holds. */
  private leftovers_words(cluster: ClusterSummary): string {
    const held: string[] = Object.entries(cluster.resources ?? {}).filter(([, count]): boolean => count > 0).map(([kind, count]): string => `${count} ${kind}`);
    const parts: string[] = [];
    if (cluster.compartment !== null && cluster.compartment !== undefined) parts.push(`its compartment${held.length > 0 ? ` (holding ${held.join(', ')})` : ' (empty)'}`);
    parts.push('its stack, when one stands');
    return parts.join(' and ');
  }

  private teardown_make(cluster: ClusterSummary): HTMLElement[] {
    const gone: boolean = cluster.origin === 'found' && cluster.condition === 'GONE';
    const goes: HTMLElement = this.section_make(gone ? 'WHAT IS LEFT · AND GOES' : 'WHAT GOES · IN THIS ORDER', 'tdc-col-wide', 'ONLY WHAT THIS TRUSTED DOMAIN MADE');
    const rows: Array<[string, string]> = gone ? [
      ['the stack itself', 'emptied by an earlier teardown; it carried the tag, so the cluster was found again'],
      ['its compartment and the image bucket', 'when stratus made them (clusters/<name>); another\'s keeps itself and loses the tag'],
    ] : [
      ['the stack\'s resources', 'a destroy job on the cluster\'s Resource Manager stack'],
      ['the DNS records', 'api, api-int and *.apps in the zone'],
      ['the image and its link', 'the discovery ISO and its pre-authenticated request'],
      ['the cluster\'s volumes', 'the block volumes the CSI driver made for its claims, found through the cluster, and any left in the compartment with the attribution tag'],
      ['the installer\'s records', 'the cluster and the infra-env at Red Hat'],
      ['the stack itself', 'it carried the tag; left, the cluster would be found again'],
      ['its compartment and the image bucket', 'when stratus made them (clusters/<name>); another\'s keeps itself and loses the tag'],
    ];
    const list: HTMLElement = el('div', 'tdc-teardown-rows');
    for (const [what, how] of rows) list.append(el('span', 'tdc-destroy-mark', '−'), el('span', 'tdc-teardown-what', what), el('span', 'tdc-teardown-how', how));
    goes.append(list, el('p', 'tdc-prose tdc-quiet', 'Nothing else is touched: the zone, the tag namespace and what other clusters made stay. The engine counts the stack and the volumes when the line runs, and asks for the name typed back.'));

    const guard: HTMLElement = this.section_make('THE GUARD', 'tdc-col-side');
    const refused: string | undefined = cluster.refused?.['teardown'];
    const protectedOnly: boolean = refused !== undefined && refused.startsWith('protected');
    if (refused !== undefined && !protectedOnly) {
      const box: HTMLElement = el('div', 'tdc-note tdc-note-refused');
      box.append(el('span', 'tdc-note-title', 'REFUSED BY NAME'), el('span', 'tdc-mono', `cluster teardown: ${cluster.name}: Operation not permitted: ${refused}`));
      guard.append(box);
      return [goes, guard];
    }
    if (gone) {
      // Nothing a lock would keep: the line goes straight to the name typed back.
      const box: HTMLElement = el('div', 'tdc-note tdc-note-found');
      box.append(el('span', 'tdc-note-title', 'NOTHING TO PROTECT'), el('span', 'tdc-prose', `Nothing of ${cluster.name} lives and its stack holds nothing, so there is no lock. The engine still asks for the name typed back.`));
      const commands: HTMLElement = el('div', 'tdc-commands');
      commands.append(el('span', 'tdc-flex'), this.linePill_make('REMOVE WHAT IS LEFT', LINES.teardown(cluster.name), 'destroy'));
      box.append(commands);
      guard.append(box);
      return [goes, guard];
    }
    const lock: HTMLElement = el('div', `tdc-note ${cluster.protected !== false ? 'tdc-note-locked' : 'tdc-note-refused'}`);
    lock.append(el('span', 'tdc-note-title', cluster.protected !== false ? 'PROTECTED' : 'UNLOCKED'), el('span', 'tdc-prose', cluster.protected !== false
      ? 'A cluster is born protected. Lifting the lock is a line of its own, so no single slip or replayed line removes a tenant.'
      : 'The lock is off. TEAR DOWN sends the line; the engine lists what goes and asks for the name typed back.'));
    const commands: HTMLElement = el('div', 'tdc-commands');
    if (cluster.protected !== false) commands.append(this.linePill_make('LIFT THE LOCK', LINES.protect(cluster.name, false), 'quiet'));
    else commands.append(this.linePill_make('LOCK AGAIN', LINES.protect(cluster.name, true), 'quiet'), el('span', 'tdc-flex'), this.linePill_make('TEAR DOWN', LINES.teardown(cluster.name), 'destroy', cluster.refused?.['teardown']));
    lock.append(commands);
    guard.append(lock);
    return [goes, guard];
  }

  // ------------------------------------------------------------------ SIZE

  private async size_need(family?: string): Promise<void> {
    if (this.sizeAsked && family === undefined) return;
    this.sizeAsked = true;
    const read: ClusterSizeModel | null = await this.hooks.size_read(family);
    if (read === null) return;
    this.size = read;
    if (this.zone === null || !(read.dnsZones ?? [this.zone]).includes(this.zone)) this.zone = read.baseDomain;
    const keep: ClusterSpecModel | null = this.levers;
    this.levers = keep === null ? spec_copy(read.start) : { ...keep, family: read.family };
    this.draw();
  }

  /** The DNS zones a new cluster's names may go under: a pill each, the chosen one lit. */
  private zones_make(size: ClusterSizeModel): HTMLElement {
    const row: HTMLElement = el('div', 'tdc-families tdc-zones');
    row.append(el('span', 'tdc-pair-label', 'ZONE'));
    const zones: string[] = size.dnsZones ?? (size.baseDomain === null ? [] : [size.baseDomain]);
    if (zones.length === 0) row.append(el('span', 'tdc-quiet', 'THE TENANCY HOLDS NO DNS ZONE'));
    for (const zone of zones) {
      const pill: HTMLButtonElement = el('button', `tdc-family${zone === this.zone ? ' tdc-family-on' : ''}`, zone);
      pill.type = 'button';
      pill.addEventListener('click', (): void => { this.hooks.voice.pill('ZONE'); this.zone = zone; this.draw(); });
      row.append(pill);
    }
    return row;
  }

  private size_make(cluster: ClusterSummary | null): HTMLElement[] {
    const existing: boolean = cluster !== null;
    if (existing && cluster?.spec !== null && cluster?.spec !== undefined && (this.levers === null || this.current !== NEW_KEY)) this.levers = spec_copy(cluster.spec);
    const levers: HTMLElement = this.section_make(existing ? `THE SPEC OF ${cluster?.name.toUpperCase()}` : 'A NEW TRUSTED DOMAIN', 'tdc-col-levers');
    if (this.size === null || this.levers === null) {
      levers.append(el('p', 'tdc-prose tdc-quiet', 'reading what a cluster is sized against: cluster size'));
      return [levers];
    }
    const spec: ClusterSpecModel = this.levers;
    const size: ClusterSizeModel = this.size;
    if (!existing) {
      const nameRow: HTMLElement = el('div', 'tdc-name-row');
      const label: HTMLElement = el('label', 'tdc-pair-label', 'NAME');
      const input: HTMLInputElement = el('input', 'tdc-name-input');
      input.id = 'tdc-new-name';
      label.setAttribute('for', input.id);
      input.value = this.newName;
      input.placeholder = 'a DNS label, as quay';
      input.spellcheck = false;
      input.addEventListener('input', (): void => { this.newName = input.value.trim(); this.sized_redraw(); });
      nameRow.append(label, input);
      levers.append(nameRow);
    } else {
      levers.append(el('p', 'tdc-prose tdc-quiet', 'A cluster\'s spec is written once, by cluster new. These are its sizes, against the region now; + NEW sizes another.'));
    }
    const families: HTMLElement = el('div', 'tdc-families');
    families.append(el('span', 'tdc-pair-label', 'FAMILY'));
    const offered: string[] = [...new Set([spec.family, 'E5', 'E4', 'E6', 'A1'].filter((family: string): boolean => size.families.includes(family)))];
    for (const family of offered) {
      const pill: HTMLButtonElement = el('button', `tdc-family${family === spec.family ? ' tdc-family-on' : ''}`, family);
      pill.type = 'button';
      pill.disabled = existing;
      pill.addEventListener('click', (): void => { this.hooks.voice.pill(family); if (this.levers !== null) this.levers.family = family; void this.size_need(family); });
      families.append(pill);
    }
    levers.append(families);
    if (!existing) levers.append(this.zones_make(size));
    const slider = (id: string, name: string, min: number, max: number, step: number, read: () => number, write: (value: number) => void, note?: string): HTMLElement => {
      const row: HTMLElement = el('div', 'tdc-slider');
      const label: HTMLElement = el('label', 'tdc-slider-label', name);
      const input: HTMLInputElement = el('input', 'tdc-slider-input');
      input.type = 'range';
      input.id = `tdc-${id}`;
      label.setAttribute('for', input.id);
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(read());
      input.disabled = existing || min === max;
      const shown: HTMLElement = el('span', 'tdc-slider-value', String(read()));
      input.addEventListener('input', (): void => { write(Number(input.value)); shown.textContent = input.value; this.sized_redraw(); });
      const track: HTMLElement = el('div', 'tdc-slider-track');
      const ends: HTMLElement = el('div', 'tdc-slider-ends');
      ends.append(el('span', '', String(min)), el('span', 'tdc-slider-note', note ?? ''), el('span', '', String(max)));
      track.append(input, ends);
      row.append(label, track, shown);
      return row;
    };
    const maxVcpu: number = size.cores === null ? 64 : Math.min(size.cores.max * size.vcpuPerCore, 128);
    const maxGib: number = size.memoryGib === null ? 512 : Math.min(size.memoryGib.max, 1024);
    const group = (title: string, rows: HTMLElement[]): HTMLElement => {
      const box: HTMLElement = el('div', 'tdc-lever-group');
      box.append(el('span', 'tdc-section-title', title), ...rows);
      return box;
    };
    levers.append(
      group('CONTROL PLANE', [
        slider('pc', 'NODES', 3, 3, 1, (): number => spec.controlPlane.count, (): void => {}, 'ONE PER ZONE · FIXED'),
        slider('pv', 'vCPU EACH', 4, maxVcpu, 2, (): number => spec.controlPlane.vcpu, (value: number): void => { spec.controlPlane.vcpu = value; }),
        slider('pr', 'GiB EACH', 16, maxGib, 4, (): number => spec.controlPlane.ramGib, (value: number): void => { spec.controlPlane.ramGib = value; }),
      ]),
      group('WORKERS', [
        slider('wc', 'NODES', 0, 12, 1, (): number => spec.workers.count, (value: number): void => { spec.workers.count = value; }, '0 · COMPACT'),
        slider('wv', 'vCPU EACH', 4, maxVcpu, 2, (): number => spec.workers.vcpu, (value: number): void => { spec.workers.vcpu = value; }),
        slider('wr', 'GiB EACH', 16, maxGib, 8, (): number => spec.workers.ramGib, (value: number): void => { spec.workers.ramGib = value; }),
      ]),
      group('CHRIS', [
        slider('cd', 'DATA GiB', 20, 2000, 10, (): number => spec.chris.dataGib, (value: number): void => { spec.chris.dataGib = value; }, 'GROWS LATER · NEVER SHRINKS'),
        slider('cb', 'DATABASE GiB', 5, 200, 5, (): number => spec.chris.databaseGib, (value: number): void => { spec.chris.databaseGib = value; }, 'FIXED AFTER THE FIRST DEPLOY'),
      ]),
    );
    const fit: HTMLElement = this.section_make(`FIT · ${spec.family} PER ZONE, AS SIZED`, 'tdc-col-fit', `FROM ${size.region} · READ ONCE`);
    const cost: HTMLElement = this.section_make('COST · PER HOUR, FROM THE PRICE LIST', 'tdc-col-cost');
    this.fit_fill(fit);
    this.cost_fill(cost, !existing);
    return [levers, fit, cost];
  }

  private sized_redraw(): void {
    const fit: HTMLElement | null = this.parts.body.querySelector('.tdc-col-fit');
    const cost: HTMLElement | null = this.parts.body.querySelector('.tdc-col-cost');
    if (fit !== null) this.fit_fill(fit);
    if (cost !== null) this.cost_fill(cost, this.current === NEW_KEY);
    this.header_draw();
  }

  private fit_fill(section: HTMLElement): void {
    section.querySelectorAll('.tdc-zone').forEach((node: Element): void => node.remove());
    if (this.size === null || this.levers === null) return;
    for (const zone of sizeFit_compute(this.size, this.levers, this.newName || this.current || 'new')) {
      const box: HTMLElement = el('div', `tdc-zone${zone.fits === false ? ' tdc-zone-bad' : zone.tightest ? ' tdc-zone-tight' : ''}`);
      const head: HTMLElement = el('div', 'tdc-zone-head');
      head.append(el('span', 'tdc-zone-name', zoneShort_format(zone.zone)), el('span', 'tdc-zone-verdict', zone.fits === null ? 'NOT SAID' : zone.fits ? (zone.tightest ? 'FITS · TIGHTEST' : 'FITS') : 'DOES NOT FIT'));
      const bar = (needed: number, free: number | null, unit: string): HTMLElement => {
        const row: HTMLElement = el('div', 'tdc-zone-bar');
        const track: HTMLElement = el('div', 'tdc-zone-track');
        const take: HTMLElement = el('div', 'tdc-zone-take');
        take.style.width = free === null || free <= 0 ? '0%' : `${Math.min(100, (needed / free) * 100)}%`;
        track.append(take);
        row.append(el('span', 'tdc-zone-unit', unit), track, el('span', 'tdc-zone-text', `${needed} OF ${free ?? '?'}`));
        return row;
      };
      box.append(head, bar(zone.coresNeeded, zone.coresFree, 'CORES'), bar(zone.memoryNeeded, zone.memoryFree, 'GiB'), el('span', 'tdc-zone-nodes', zone.nodes.join(' · ') || 'nothing placed'));
      section.append(box);
    }
  }

  private cost_fill(section: HTMLElement, committing: boolean): void {
    section.querySelectorAll('.tdc-cost-rows, .tdc-commit').forEach((node: Element): void => node.remove());
    if (this.size === null || this.levers === null) return;
    const cost = sizeCost_compute(this.size, this.levers);
    const rows: HTMLElement = el('div', 'tdc-cost-rows');
    for (const row of cost.rows) rows.append(el('span', 'tdc-pair-label', row.what), el('span', 'tdc-cost-rate', row.hourly === null ? 'NOT PRICED' : money_text(row.hourly, cost.currency, 3)));
    rows.append(el('span', 'tdc-pair-label tdc-bill', 'TOTAL · EST'), el('span', 'tdc-cost-rate tdc-bill', cost.hourly === null ? '—' : `${money_text(cost.hourly, cost.currency)} · ${money_text(cost.hourly * HOURS_PER_MONTH, cost.currency, 0)} A MONTH`));
    section.append(rows);
    if (committing) {
      const commit: HTMLElement = el('div', 'tdc-commit');
      section.append(commit);
      this.commit_fill(commit);
    }
  }

  private commit_fill(commit: HTMLElement): void {
    if (this.size === null || this.levers === null) return;
    commit.replaceChildren();
    const refusal: string | null = nameRefusal_derive(this.newName, this.names_get()) ?? (this.zone === null ? 'NO ZONE' : null);
    // The zone goes on the line only when it is not the one the session would take.
    const line: string = newLine_build(this.newName || '<name>', this.levers, this.size.start, this.zone !== this.size.baseDomain ? this.zone : null);
    const tenant: string = LINES.tenant(this.newName || '<name>');
    commit.append(el('span', 'tdc-section-title', 'THE LINES COMMIT SENDS'), el('div', 'tdc-mono tdc-commit-line', line), el('div', 'tdc-mono tdc-commit-line', tenant),
      el('p', 'tdc-prose tdc-quiet', 'The first writes the spec. The second plays the tenant: the build through the install, which asks before billing, then verify. A NO leaves the spec written and nothing made.'));
    const pills: HTMLElement = el('div', 'tdc-commands');
    const button: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', refusal === null ? 'COMMIT' : `COMMIT · ${refusal}`);
    button.type = 'button';
    button.disabled = refusal !== null || this.busy !== null;
    button.addEventListener('click', (): void => {
      this.hooks.voice.pill('COMMIT');
      const name: string = this.newName;
      void this.line_send(line).then(async (): Promise<void> => {
        // The spec written, the tenant plays on BUILD; a refused spec leaves SIZE as it was.
        if (!this.clusters.has(name)) return;
        this.current = name;
        this.newName = '';
        this.view = 'build';
        this.draw();
        await this.line_send(LINES.tenant(name));
      });
    });
    const reset: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'RESET');
    reset.type = 'button';
    reset.addEventListener('click', (): void => { this.hooks.voice.pill('RESET'); if (this.size !== null) this.levers = spec_copy(this.size.start); this.draw(); });
    pills.append(button, el('span', 'tdc-flex'), reset);
    commit.append(pills);
  }

  // -------------------------------------------------------------- the strip

  private strip_draw(): void {
    const strip: HTMLElement = this.parts.strip;
    strip.replaceChildren();
    strip.hidden = this.ask === null;
    if (this.ask === null) return;
    const ask: OpenAsk = this.ask;
    const destroying: boolean = /destroy/i.test(ask.message);
    const billing: boolean = /billing starts/i.test(ask.message);
    strip.dataset['tone'] = destroying ? 'destroy' : billing ? 'bill' : 'plain';
    const words: HTMLElement = el('div', 'tdc-strip-words');
    words.append(el('span', 'tdc-strip-title', 'THE ENGINE ASKS'), el('span', 'tdc-strip-text', ask.message));
    strip.append(words);
    if (askForm_derive(ask.message) === 'yes-no') {
      const yes: HTMLButtonElement = el('button', `tdc-pill ${billing ? 'tdc-pill-bill' : 'tdc-pill-plain'}`, billing ? 'YES · BILL' : 'YES');
      yes.type = 'button';
      yes.addEventListener('click', (): void => { this.hooks.voice.pill('YES'); this.log_add('y', 'answer'); ask.answer('y'); });
      const no: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'NO');
      no.type = 'button';
      no.addEventListener('click', (): void => { this.hooks.voice.pill('NO'); this.log_add('n', 'answer'); ask.answer('n'); });
      strip.append(yes, no);
      return;
    }
    const input: HTMLInputElement = el('input', 'tdc-strip-input');
    input.id = 'tdc-strip-input';
    input.type = ask.kind === 'secret' ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const label: HTMLElement = el('label', 'tdc-pair-label', destroying ? 'NAME' : 'ANSWER');
    label.setAttribute('for', input.id);
    const send: HTMLButtonElement = el('button', `tdc-pill ${destroying ? 'tdc-pill-destroy' : 'tdc-pill-plain'}`, destroying ? 'DESTROY' : 'SEND');
    send.type = 'button';
    const name: string = this.current;
    if (destroying) {
      send.disabled = true;
      input.addEventListener('input', (): void => { send.disabled = input.value.trim() !== name; });
    }
    const answer = (): void => {
      if (send.disabled) return;
      this.hooks.voice.pill(send.textContent ?? '');
      this.log_add(ask.kind === 'secret' ? '(hidden)' : input.value, 'answer');
      ask.answer(input.value);
    };
    send.addEventListener('click', answer);
    input.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Enter') answer(); });
    const no: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'NO');
    no.type = 'button';
    no.addEventListener('click', (): void => { this.hooks.voice.pill('NO'); this.log_add('(declined)', 'answer'); ask.answer(''); });
    strip.append(label, input, send, no);
    queueMicrotask((): void => input.focus());
  }

  // ---------------------------------------------------------------- the log

  private log_add(text: string, kind: 'sent' | 'out' | 'ask' | 'answer' | 'note'): void {
    const row: HTMLElement = el('span', `tdc-log-line tdc-log-${kind}`, text);
    this.parts.log.append(row);
    while (this.parts.log.childElementCount > LOG_LIMIT) this.parts.log.firstElementChild?.remove();
    this.parts.log.scrollTop = this.parts.log.scrollHeight;
    if (kind === 'out' && this.stepLogLine !== null && this.busy === this.stepLogLine) {
      this.stepLog.push(text);
      if (this.view === 'build') {
        const box: HTMLElement | null = this.parts.body.querySelector('.tdc-steplog');
        if (box !== null) {
          box.querySelector('.tdc-quiet')?.remove();
          box.append(el('span', 'tdc-steplog-line', text));
          while (box.childElementCount > 60) box.firstElementChild?.remove();
          box.scrollTop = box.scrollHeight;
        }
      }
    }
  }

  private async kill_send(job: string): Promise<void> {
    // The build's line holds the lane while it follows: stop following first, then ask the task to stop.
    if (this.busy !== null) {
      this.hooks.stop();
      for (let i: number = 0; i < 50 && this.busy !== null; i++) await new Promise((resolve): void => { setTimeout(resolve, 100); });
    }
    await this.line_send(LINES.kill(job));
  }

  private cues_play(was: ClusterSummary | null, now: ClusterSummary | null): void {
    if (was === null || now === null || was.name !== now.name) return;
    if (was.condition !== 'FAILED' && now.condition === 'FAILED') { this.hooks.voice.cue('redalert'); return; }
    const doneBefore: number = stepsDone_count(was).done;
    if (stepsDone_count(now).done > doneBefore) this.hooks.voice.cue('ack');
  }
}
