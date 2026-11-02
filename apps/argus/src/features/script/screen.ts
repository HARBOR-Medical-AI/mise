/**
 * @file The script screen: the takeover ARGUS opens over a `.mise` script in
 * a stratus session (docs/stratus.adoc, D17). It mirrors the script as trek's
 * bridge mirrors its console: the rail is the script's lines, one seat each
 * (NET NEW, NET BUILD, VM NEW, VM BUILD, CHRIS DEPLOY, the user lines under
 * USERS), each wearing the state `play --status` read for it; a step's body
 * is a form over its line, the line shown as it will run, RUN sending it as
 * the operator could have typed it, the console's output under it as the
 * proof. Nothing on the screen starts a step except by its line.
 *
 * The frame is ARGUS's own (features/takeover/frame.ts) and the content wears
 * the TD controller's classes (controller.css), since the two are one family
 * of screens: a readout over an engine, answering it only with lines. Orange
 * means money runs; red means destroying.
 *
 * Pure of the wire: the host hands in the session's answers and runs the
 * lines the screen sends.
 *
 * @module
 */
import {
  manifestStatusModelSchema, MANIFEST_STATUS_MODEL_KIND, STRATUS_VM_COST_MODEL_KIND, STRATUS_VM_LIMITS_MODEL_KIND, vmCostModelSchema, vmLimitsModelSchema,
  type LineState, type PromptKind, type VmCostRate, type VmCostRow, type VmLimitsModel,
} from '@fnndsc/menu';
import { HOURS_PER_MONTH } from '../controller/model.js';
import { saveLine_compose } from '../edit/line.js';
import { takeoverFrame_build, type TakeoverFrame, type TakeoverView } from '../takeover/frame.js';
import {
  askForm_derive, costLine_derive, counts_words, duration_words, line_parse, lineOption_get, lineOption_set, lines_build, memoryRange_derive, rate_words, rates_sum,
  script_render, scriptName_derive, scriptSource_derive, spec_words, states_count, steps_build, userLine_build, vmLevers_read, vmSliders_build, workingCopy_derive,
  type ScriptLine, type ScriptStep, type SliderSpec, type StateCounts,
} from './model.js';

/** An answer the session gave a quiet line: what the screen reads of it. */
export interface QuietAnswer {
  envelopes: ReadonlyArray<{ rendered?: string; renderedErr?: string; status?: string; model?: { kind: string; data: unknown } }>;
}

/** What the screen needs from its host. */
export interface ScriptHooks {
  /** Runs an operator's line (it may ask); its output arrives through `output_take`; resolves when it ends. */
  run: (line: string) => Promise<void>;
  /** Asks a line quietly, for a model; rejects when the session refused. */
  ask: (line: string) => Promise<QuietAnswer>;
  /** Stops following the running line. */
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

/** One script the library lists. */
interface LibraryScript {
  readonly path: string;
  readonly source: string;
  readonly name: string;
  counts: StateCounts | null;
}

/** One source the library lists. */
interface LibrarySource {
  readonly name: string;
  readonly repo: string;
  readonly cloned: boolean;
}

/** The library's view key on the rail. */
export const LIBRARY_VIEW: string = 'library';

/** How many log lines are kept. */
const LOG_LIMIT: number = 400;

/** The ChRIS profiles a deploy may name; the session refuses any other by name. */
const CHRIS_PROFILES: ReadonlyArray<string> = ['minimal', 'complete'];

/** The word a seat wears for each state. */
const STATE_MARKS: Readonly<Record<LineState, string>> = { 'not yet': '·', ready: '▸', done: '✓', changed: '~' };

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
  if (className !== '') node.className = className;
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

/**
 * The model of a kind an answer carries, parsed; null when it carries none.
 *
 * @param answer - The answer.
 * @param kind - The kind.
 * @param parse - The schema's safe parse.
 * @returns The model.
 */
function model_extract<T>(answer: QuietAnswer, kind: string, parse: (data: unknown) => { success: boolean; data?: T }): T | null {
  for (const envelope of answer.envelopes) {
    if (envelope.model?.kind !== kind) continue;
    const parsed = parse(envelope.model.data);
    if (parsed.success && parsed.data !== undefined) return parsed.data;
  }
  return null;
}

/** A listing as `ls` answers it. */
interface Listed {
  readonly path: string;
  readonly items: ReadonlyArray<{ name: string; type: string; status?: string; title?: string }>;
}

/**
 * The listings an `ls` answered.
 *
 * @param answer - The answer.
 * @returns Them, or none.
 */
function listings_extract(answer: QuietAnswer): Listed[] {
  for (const envelope of answer.envelopes) {
    if (envelope.model?.kind !== 'fs.listing' || !Array.isArray(envelope.model.data)) continue;
    return (envelope.model.data as unknown[]).filter((one: unknown): one is Listed => typeof one === 'object' && one !== null && typeof (one as { path?: unknown }).path === 'string' && Array.isArray((one as { items?: unknown }).items));
  }
  return [];
}

/**
 * The text an answer rendered, plain.
 *
 * @param answer - The answer.
 * @returns Its rendered text, every envelope's together.
 */
function text_extract(answer: QuietAnswer): string {
  return plain_extract(answer.envelopes.map((envelope): string => envelope.rendered ?? '').join(''));
}

/** The script screen over a stratus session. */
export class ScriptScreen {
  /** The screen's root, appended to the body by the host while it is up. */
  public readonly root: HTMLElement;
  private readonly frame: TakeoverFrame;
  /** The script open, or `''` for the library alone. */
  private path: string = '';
  private lines: ScriptLine[] = [];
  private steps: ScriptStep[] = [];
  private view: string = LIBRARY_VIEW;
  /** Whether a form changed a line since the file was read. */
  private edited: boolean = false;
  private scripts: LibraryScript[] = [];
  private sources: LibrarySource[] = [];
  private libraryRead: boolean = false;
  private limits: VmLimitsModel | null = null;
  private limitsAsked: boolean = false;
  /** What the declared VMs bill together, from `vm cost` bare. */
  private standing: VmCostRate | null = null;
  /** The VM NEW step's own price as its levers move. */
  private stepCost: VmCostRow | null = null;
  /** Why the last `vm cost` for the step did not answer, or null. */
  private stepCostRefused: string | null = null;
  private costTimer: ReturnType<typeof setTimeout> | null = null;
  /** The line running, and since when. */
  private busy: { line: string; step: string | null; since: number } | null = null;
  private ask: OpenAsk | null = null;
  private partial: string = '';
  /** What each step's lines printed, for its body. */
  private readonly stepLogs: Map<string, string[]> = new Map();
  /** The USERS form's words, kept across redraws. */
  private userForm: { name: string; email: string; passwordFile: string } = { name: '', email: '', passwordFile: '' };
  private readonly parts: { header: HTMLElement; body: HTMLElement; strip: HTMLElement; log: HTMLElement; input: HTMLInputElement; promptLabel: HTMLElement };
  private ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * Builds the screen.
   *
   * @param hooks - The host's verbs.
   */
  constructor(private readonly hooks: ScriptHooks) {
    this.frame = takeoverFrame_build({
      id: 'script-screen',
      className: 'td-controller script-screen',
      brand: { name: 'STRATUS', sub: 'SCRIPT · OCI', mark: true },
      banner: 'STRATUS • SCRIPT',
      views: [{ key: LIBRARY_VIEW, label: 'LIBRARY' }],
      leave: { label: 'LEAVE' },
      stage: { title: 'THE LIBRARY', note: 'SCRIPTS' },
      log: { title: 'SCRIPT LOG', note: 'THE SESSION\'S LINES · TYPE BELOW' },
      labels: { views: 'Steps', log: 'Script log' },
    }, (key: string): void => this.view_press(key), (): void => { this.hooks.voice.pill('LEAVE'); this.hooks.leave(); });
    this.root = this.frame.root;
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-label', 'Script screen');
    this.frame.seat.setAttribute('aria-label', 'The script');

    const header: HTMLElement = el('header', 'tdc-header ss-header');
    this.frame.face.append(header);
    const body: HTMLElement = el('div', 'tdc-body ss-body');
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
    input.id = 'ss-prompt-input';
    promptLabel.setAttribute('for', input.id);
    input.placeholder = 'any session line · play <script> --status · vm cost · scripts pull';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') return;
      const typed: string = input.value.trim();
      if (typed === '') return;
      input.value = '';
      void this.line_send(typed, null);
    });
    line.append(promptLabel, input);
    const logColumn: HTMLElement = el('div', 'tdc-log-column');
    logColumn.append(log, line);
    foot.append(logColumn);
    this.frame.log.append(foot);
    this.parts = { header, body, strip, log, input, promptLabel };
    this.ticker = setInterval((): void => { if (this.busy !== null) this.header_draw(); }, 5_000);
    this.draw();
  }

  /** Stops the screen's clock; the host calls it on leaving. */
  public dispose(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    if (this.costTimer !== null) clearTimeout(this.costTimer);
    this.costTimer = null;
    this.ask?.answer(null);
    this.ask = null;
  }

  // ---------------------------------------------------------------- opening

  /**
   * Opens the library, or a script in it: its text and where its lines
   * stand are read, and the rail becomes its lines.
   *
   * @param path - The script, or `''` for the library.
   */
  public async open(path: string): Promise<void> {
    if (path === '') {
      this.view = LIBRARY_VIEW;
      this.draw();
      void this.standing_read();
      await this.library_read();
      return;
    }
    this.path = path;
    this.edited = false;
    this.stepLogs.clear();
    await this.script_read();
    const first: ScriptStep | undefined = this.steps.find((step: ScriptStep): boolean => step.state === 'changed' || step.state === 'ready') ?? this.steps[0];
    this.view = first?.key ?? LIBRARY_VIEW;
    this.draw();
    void this.standing_read();
    if (this.steps.some((step: ScriptStep): boolean => step.kind === 'vm new')) void this.limits_need();
  }

  /** The script open, or `''`. */
  public path_get(): string {
    return this.path;
  }

  /** The view on the screen: the library, or a step's key. */
  public view_get(): string {
    return this.view;
  }

  /** The steps drawn, each with its state. */
  public steps_get(): ReadonlyArray<{ key: string; label: string; state: LineState | null }> {
    return this.steps.map((step: ScriptStep) => ({ key: step.key, label: step.label, state: step.state }));
  }

  /** Whether a question stands on the strip. */
  public asking_is(): boolean {
    return this.ask !== null;
  }

  /** Whether one of the screen's lines runs. */
  public running_is(): boolean {
    return this.busy !== null;
  }

  /** The tab title while the screen is up: the script and what runs or stands. */
  public title_get(): string {
    if (this.path === '') return 'LIBRARY · SCRIPTS';
    if (this.busy !== null) return `RUNNING · ${scriptName_derive(this.path)}`;
    return `${counts_words(states_count(this.lines))} · ${scriptName_derive(this.path)}`;
  }

  /**
   * Output from the running line: the log, and the step's own.
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
      this.ask = { message, kind, answer: (value: string | null): void => { this.ask = null; this.strip_draw(); this.body_draw(); resolve(value); } };
      this.log_add(message, 'ask');
      this.strip_draw();
      this.body_draw();
    });
  }

  // ---------------------------------------------------------------- reading

  private async script_read(): Promise<void> {
    let text: string = '';
    try {
      text = text_extract(await this.hooks.ask(`cat ${this.path}`));
    } catch (error: unknown) {
      this.log_add(`cat ${this.path}: ${error instanceof Error ? error.message : String(error)}`, 'note');
    }
    const standings = await this.status_read(this.path);
    this.lines = lines_build(text, standings?.lines ?? []);
    this.steps = steps_build(this.lines);
  }

  /**
   * Where a script's lines stand: `play <path> --status`, each verb answering for its own line.
   *
   * @param path - The script.
   * @returns The model, or null when the session did not answer it.
   */
  private async status_read(path: string): Promise<{ lines: Array<{ number: number; text: string; state: LineState | null; detail: string }> } | null> {
    try {
      const answer: QuietAnswer = await this.hooks.ask(`play ${path} --status`);
      return model_extract(answer, MANIFEST_STATUS_MODEL_KIND, (data: unknown) => manifestStatusModelSchema.safeParse(data));
    } catch (error: unknown) {
      this.log_add(`play ${path} --status: ${error instanceof Error ? error.message : String(error)}`, 'note');
      return null;
    }
  }

  /** Reads the script's standing again, after a line ran. */
  private async standings_refresh(): Promise<void> {
    if (this.path === '') return;
    const standings = await this.status_read(this.path);
    if (standings === null) return;
    const fresh: ScriptLine[] = lines_build(script_render(this.lines), standings.lines);
    this.lines = fresh;
    this.steps = steps_build(this.lines);
    void this.standing_read();
  }

  private async library_read(): Promise<void> {
    const sources: LibrarySource[] = [];
    const scripts: LibraryScript[] = [];
    try {
      const top: Listed[] = listings_extract(await this.hooks.ask('ls /scripts'));
      const folders: string[] = [];
      for (const item of top[0]?.items ?? []) {
        if (item.type === 'source') sources.push({ name: item.name, repo: (item.title ?? '').split(' ')[0] ?? '', cloned: item.status === 'cloned' });
        folders.push(item.name);
      }
      for (const folder of folders) {
        let listed: Listed[] = [];
        try { listed = listings_extract(await this.hooks.ask(`ls /scripts/${folder}`)); } catch { continue; }
        for (const item of listed[0]?.items ?? []) {
          if (item.type !== 'script' && !item.name.endsWith('.mise')) continue;
          scripts.push({ path: `/scripts/${folder}/${item.name}`, source: folder, name: scriptName_derive(item.name), counts: null });
        }
      }
    } catch (error: unknown) {
      this.log_add(`ls /scripts: ${error instanceof Error ? error.message : String(error)}`, 'note');
    }
    this.sources = sources;
    this.scripts = scripts;
    this.libraryRead = true;
    this.draw();
    for (const script of scripts) {
      const standings = await this.status_read(script.path);
      script.counts = standings === null ? null : states_count(lines_build(standings.lines.map((line): string => line.text).join('\n'), standings.lines));
      if (this.view === LIBRARY_VIEW) this.body_draw();
    }
  }

  private async limits_need(): Promise<void> {
    if (this.limitsAsked) return;
    this.limitsAsked = true;
    try {
      this.limits = model_extract(await this.hooks.ask('vm limits'), STRATUS_VM_LIMITS_MODEL_KIND, (data: unknown) => vmLimitsModelSchema.safeParse(data));
    } catch (error: unknown) {
      this.log_add(`vm limits: ${error instanceof Error ? error.message : String(error)}`, 'note');
    }
    this.draw();
  }

  /** What stands now: every declared VM's rate, from `vm cost` bare. */
  private async standing_read(): Promise<void> {
    try {
      const model = model_extract(await this.hooks.ask('vm cost'), STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
      this.standing = model === null ? null : rates_sum(model.vms.map((row: VmCostRow): VmCostRate | null => row.cost));
    } catch {
      this.standing = null;
    }
    this.header_draw();
  }

  /**
   * Prices the VM NEW line as it stands, a moment after the last lever moved.
   *
   * @param line - The `vm new` line.
   */
  private stepCost_ask(line: string): void {
    if (this.costTimer !== null) clearTimeout(this.costTimer);
    this.costTimer = setTimeout((): void => {
      this.costTimer = null;
      void this.hooks.ask(costLine_derive(line)).then((answer: QuietAnswer): void => {
        const model = model_extract(answer, STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
        this.stepCost = model?.vms[0] ?? null;
        this.stepCostRefused = model === null ? (plain_extract(answer.envelopes.map((envelope): string => envelope.renderedErr ?? '').join('')).trim() || 'the session answered no price') : null;
        this.cost_redraw();
        this.header_draw();
      }, (error: unknown): void => {
        this.stepCost = null;
        this.stepCostRefused = error instanceof Error ? error.message : String(error);
        this.cost_redraw();
      });
    }, 250);
  }

  // ---------------------------------------------------------------- sending

  /**
   * Sends a line: shown in the log as typed, run by the host, the script's
   * standing read again after.
   *
   * @param line - The line.
   * @param step - The step it belongs to, whose body shows its output; null for a typed line.
   */
  public async line_send(line: string, step: string | null): Promise<void> {
    if (this.busy !== null) {
      this.log_add(`the lane is held by: ${this.busy.line} (STOP FOLLOWING frees it; the line goes on)`, 'note');
      return;
    }
    this.busy = { line, step, since: Date.now() };
    this.log_add(`stratus> ${line}`, 'sent');
    if (step !== null) this.stepLogs.set(step, []);
    this.draw();
    let failed: boolean = false;
    try {
      await this.hooks.run(line);
    } catch (error: unknown) {
      failed = true;
      this.log_add(error instanceof Error ? error.message : String(error), 'note');
    } finally {
      if (this.partial !== '') { this.log_add(this.partial, 'out'); this.partial = ''; }
      this.busy = null;
      this.hooks.voice.cue(failed ? 'redalert' : 'ack');
      await this.standings_refresh();
      this.draw();
      // A line run from the library (PULL, a touch into mine) may have changed what it lists.
      if (this.view === LIBRARY_VIEW) void this.library_read();
    }
  }

  /** Writes the working copy under `/scripts/mine/`, as the editor saves: a line, echoed and run. */
  private async save_send(): Promise<void> {
    const copy: string = workingCopy_derive(this.path);
    await this.line_send(saveLine_compose(copy, script_render(this.lines)), null);
    this.path = copy;
    this.edited = false;
    await this.script_read();
    this.draw();
    this.libraryRead = false;
  }

  // ---------------------------------------------------------------- drawing

  private view_press(key: string): void {
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === key);
    this.hooks.voice.pill(key === LIBRARY_VIEW ? 'LIBRARY' : step?.label ?? key);
    this.view = key;
    if (key === LIBRARY_VIEW && !this.libraryRead) void this.library_read();
    if (step?.kind === 'vm new') { void this.limits_need(); this.stepCost_ask(step.lines[0]?.text ?? ''); }
    this.draw();
  }

  private draw(): void {
    this.rail_draw();
    this.header_draw();
    this.frame.view_mark(this.view);
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    this.frame.stageTitle.textContent = this.path === '' ? 'THE LIBRARY' : scriptName_derive(this.path).toUpperCase();
    this.frame.stageNote.textContent = step === undefined ? (this.view === LIBRARY_VIEW ? 'SCRIPTS' : '') : `${step.label}${step.state === null ? '' : ` · ${step.state.toUpperCase()}`}`;
    this.body_draw();
    this.strip_draw();
    this.parts.promptLabel.textContent = this.path === '' ? 'stratus ›' : `stratus ${scriptName_derive(this.path)} ›`;
    this.parts.input.disabled = this.busy !== null;
    this.root.dataset['busy'] = this.busy === null ? 'no' : 'yes';
    document.title = this.title_get();
  }

  /** The rail: LIBRARY, then a seat per step wearing its state. */
  private rail_draw(): void {
    const views: TakeoverView[] = [{ key: LIBRARY_VIEW, label: 'LIBRARY' }, ...this.steps.map((step: ScriptStep): TakeoverView => ({ key: step.key, label: step.label }))];
    const shown: string[] = [...this.frame.views.keys()];
    if (shown.length !== views.length || views.some((view: TakeoverView, index: number): boolean => shown[index] !== view.key)) this.frame.views_set(views);
    for (const step of this.steps) {
      const seat: HTMLButtonElement | undefined = this.frame.views.get(step.key);
      if (seat === undefined) continue;
      seat.dataset['state'] = step.state ?? 'none';
      seat.classList.toggle('ss-seat-running', this.busy !== null && this.busy.step === step.key);
      seat.querySelector('.ss-seat-mark')?.remove();
      const mark: HTMLElement = el('span', 'ss-seat-mark', step.state === null ? '' : STATE_MARKS[step.state]);
      mark.setAttribute('aria-label', step.state ?? '');
      seat.append(mark);
    }
    // The seat under the brand: the script's name and source, as the controller shows its clusters.
    const seat: HTMLElement = this.frame.seat;
    seat.replaceChildren();
    if (this.path !== '') {
      const pill: HTMLElement = el('span', 'takeover-seat-pill', scriptName_derive(this.path).toUpperCase());
      pill.setAttribute('aria-current', 'true');
      seat.append(pill, el('span', 'ss-seat-source', scriptSource_derive(this.path).toUpperCase() || 'OUTSIDE THE LIBRARY'));
    }
  }

  private header_draw(): void {
    const header: HTMLElement = this.parts.header;
    header.replaceChildren();
    const counts: StateCounts = states_count(this.lines);
    const standingWord: string = this.path === '' ? 'LIBRARY' : this.busy !== null ? 'RUNNING' : counts.changed > 0 ? 'CHANGED' : counts.notYet > 0 ? 'NOT YET' : counts.ready > 0 ? 'READY' : counts.total > 0 ? 'DONE' : 'READING';
    const condition: HTMLElement = el('section', 'tdc-head-condition');
    const pill: HTMLElement = el('div', 'tdc-condition');
    pill.dataset['condition'] = standingWord;
    pill.append(el('span', 'tdc-condition-label', 'THE SCRIPT'), el('span', 'tdc-condition-name', standingWord));
    condition.append(pill, el('div', 'tdc-condition-why', this.path === '' ? `${this.scripts.length} SCRIPT${this.scripts.length === 1 ? '' : 'S'} · ${this.sources.length} SOURCE${this.sources.length === 1 ? '' : 'S'}` : counts_words(counts)));
    const chips: HTMLElement = el('div', 'tdc-chips');
    if (this.path !== '') chips.append(el('span', 'tdc-chip', this.edited ? 'EDITED · NOT SAVED' : scriptSource_derive(this.path) === 'mine' ? 'WORKING COPY' : 'FROM GIT · READ-ONLY'));
    condition.append(chips);
    header.append(condition);

    header.append(this.headSection_make('SCRIPT', this.path === '' ? [['LIBRARY', '/scripts'], ['MINE', '/scripts/mine']] : [['NAME', scriptName_derive(this.path)], ['SOURCE', scriptSource_derive(this.path) || '—'], ['PATH', this.path]]));
    const standing: string = this.standing === null ? 'NOT PRICED' : rate_words(this.standing, HOURS_PER_MONTH);
    const stepRate: VmCostRate | null = this.stepCost?.cost ?? null;
    const costRows: Array<[string, string]> = [['STANDS NOW', standing]];
    const stepShown: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (stepShown?.kind === 'vm new') costRows.push([this.stepCost?.declared === true ? 'THIS STEP' : 'WOULD ADD', stepRate === null ? '…' : rate_words(stepRate, HOURS_PER_MONTH)]);
    header.append(this.headSection_make('COST · LIST PRICE', costRows, 0));
    const running: Array<[string, string]> = this.busy === null ? [['LINE', 'nothing'], ['FOR', '—']] : [['LINE', this.busy.line], ['FOR', duration_words(Date.now() - this.busy.since)]];
    header.append(this.headSection_make('RUNNING', running));
    header.append(this.headSection_make('STANDING', [['DONE', String(counts.done)], ['READY', String(counts.ready)], ['CHANGED', String(counts.changed)], ['NOT YET', String(counts.notYet)]]));
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

  private body_draw(): void {
    const body: HTMLElement = this.parts.body;
    body.replaceChildren();
    if (this.view === LIBRARY_VIEW) {
      body.dataset['view'] = 'library';
      body.append(...this.library_make());
      return;
    }
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (step === undefined) {
      body.dataset['view'] = 'library';
      body.append(this.empty_make('NO STEP', 'Open a script from the LIBRARY; its lines become the rail.'));
      return;
    }
    body.dataset['view'] = 'step';
    body.append(...this.step_make(step));
    const log: HTMLElement | null = body.querySelector('.tdc-steplog');
    if (log !== null) log.scrollTop = log.scrollHeight;
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

  private pairs_make(rows: ReadonlyArray<[string, string]>): HTMLElement {
    const grid: HTMLElement = el('div', 'tdc-pairs');
    for (const [label, value] of rows) grid.append(el('span', 'tdc-pair-label', label), el('span', 'tdc-pair-value', value));
    return grid;
  }

  /**
   * A pill that sends a line.
   *
   * @param label - Its word.
   * @param line - The line it sends.
   * @param step - The step whose body shows the output.
   * @param tone - How it is drawn.
   * @returns The pill.
   */
  private linePill_make(label: string, line: string, step: string | null, tone: 'plain' | 'bill' | 'destroy' | 'quiet' = 'plain'): HTMLButtonElement {
    const pill: HTMLButtonElement = el('button', `tdc-pill tdc-pill-${tone}`, label);
    pill.type = 'button';
    pill.title = `sends: ${line}`;
    pill.disabled = this.busy !== null || this.ask !== null;
    pill.addEventListener('click', (): void => { this.hooks.voice.pill(label); void this.line_send(line, step); });
    return pill;
  }

  // ---------------------------------------------------------------- library

  private library_make(): HTMLElement[] {
    const scripts: HTMLElement = this.section_make('SCRIPTS', 'ss-col-wide', `${this.scripts.length} IN THE LIBRARY`);
    if (!this.libraryRead) {
      scripts.append(el('p', 'tdc-prose tdc-quiet', 'reading the library: ls /scripts'));
    } else if (this.scripts.length === 0) {
      scripts.append(el('p', 'tdc-prose', 'No scripts yet. A source is a git repository: scripts add <name> <repo> [--folder <folder>] names one and clones it; /scripts/mine/ is this host\'s own folder.'));
    } else {
      const rows: HTMLElement = el('div', 'ss-scripts');
      for (const script of this.scripts) {
        const row: HTMLElement = el('div', `ss-script${script.path === this.path ? ' ss-script-open' : ''}`);
        row.append(el('span', 'ss-script-name', script.name), el('span', 'ss-script-source', script.source.toUpperCase()), el('span', 'ss-script-standing', script.counts === null ? 'READING' : counts_words(script.counts)));
        const open: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', script.path === this.path ? 'OPEN · SHOWN' : 'OPEN');
        open.type = 'button';
        open.title = `opens ${script.path} on the rail`;
        open.disabled = this.busy !== null;
        open.addEventListener('click', (): void => { this.hooks.voice.pill('OPEN'); void this.open(script.path); });
        row.append(open);
        rows.append(row);
      }
      scripts.append(rows);
    }
    scripts.append(el('p', 'tdc-prose tdc-quiet', 'A script states what should exist. Opening one makes its lines the rail; each wears what play --status read for it, from the host\'s records and never the cloud. A step\'s edits land in a working copy under /scripts/mine/; the way back into a repository is git.'));

    const sources: HTMLElement = this.section_make('SOURCES', 'ss-col-side', 'GIT REPOSITORIES');
    if (this.sources.length === 0) {
      sources.append(el('p', 'tdc-prose tdc-quiet', this.libraryRead ? 'no sources named (scripts add)' : '…'));
    } else {
      const rows: Array<[string, string]> = this.sources.map((source: LibrarySource): [string, string] => [source.name.toUpperCase(), `${source.repo}${source.cloned ? '' : ' · NOT CLONED'}`]);
      sources.append(this.pairs_make(rows));
    }
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(this.linePill_make('PULL', 'scripts pull', null, 'quiet'), el('span', 'tdc-commands-label', 'FAST-FORWARD EVERY CLONE'));
    sources.append(commands);
    sources.append(el('p', 'tdc-prose tdc-quiet', 'MINE holds this host\'s working copies, written by SAVE on a step.'));
    return [scripts, sources];
  }

  // ---------------------------------------------------------------- steps

  private step_make(step: ScriptStep): HTMLElement[] {
    const form: HTMLElement = this.section_make(`THE LINE · ${step.label}`, 'ss-col-form', step.lines.length === 1 ? `LINE ${step.lines[0]?.number ?? ''}` : `${step.lines.length} LINES`);
    const bodies: Record<ScriptStep['kind'], () => HTMLElement[]> = {
      'net new': (): HTMLElement[] => this.netNew_make(step),
      'net build': (): HTMLElement[] => this.netBuild_make(step),
      'vm new': (): HTMLElement[] => this.vmNew_make(step),
      'vm build': (): HTMLElement[] => this.vmBuild_make(step),
      'chris deploy': (): HTMLElement[] => this.chrisDeploy_make(step),
      users: (): HTMLElement[] => this.users_make(step),
      other: (): HTMLElement[] => this.other_make(step),
    };
    form.append(...bodies[step.kind]());
    const side: HTMLElement = step.kind === 'vm new' ? this.cost_make(step) : this.state_make(step);
    const log: HTMLElement = this.stepLog_make(step);
    return [form, side, log];
  }

  /** The line as it will run, and its state. */
  private lineBox_make(line: ScriptLine): HTMLElement {
    const box: HTMLElement = el('div', `ss-line ss-line-${(line.state ?? 'none').replace(' ', '-')}`);
    box.append(el('span', 'ss-line-state', line.state === null ? '—' : `${STATE_MARKS[line.state]} ${line.state.toUpperCase()}`), el('code', 'tdc-mono ss-line-text', line.text));
    if (line.detail !== '') box.append(el('span', 'tdc-prose tdc-quiet ss-line-detail', line.detail));
    return box;
  }

  /** The step's state and what it says, as a side column. */
  private state_make(step: ScriptStep): HTMLElement {
    const side: HTMLElement = this.section_make('WHERE IT STANDS', 'ss-col-side');
    const words: Readonly<Record<LineState, string>> = {
      'not yet': 'What this line stands on is not built yet: the step before it runs first.',
      ready: 'The line may run. Nothing it needs is missing.',
      done: 'The line has run and would replay to unchanged or nothing to do.',
      changed: 'An earlier line changed under it: replaying it plans, prices and asks before anything is made.',
    };
    side.append(el('p', 'tdc-prose', step.state === null ? 'No verb reads this line\'s state; it runs when sent.' : words[step.state]));
    if (step.lines.length === 1 && (step.lines[0]?.detail ?? '') !== '') side.append(this.pairs_make([['SAID', step.lines[0]?.detail ?? '']]));
    if (this.edited) {
      const note: HTMLElement = el('div', 'tdc-note tdc-note-bill');
      note.append(el('span', 'tdc-note-title', 'EDITED · NOT SAVED'), el('span', 'tdc-prose', `A form changed a line. RUN sends the line as shown; SAVE writes the whole script to ${workingCopy_derive(this.path)} and opens it from there.`));
      const save: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'SAVE');
      save.type = 'button';
      save.title = `sends: touch --withContents=… ${workingCopy_derive(this.path)}`;
      save.disabled = this.busy !== null;
      save.addEventListener('click', (): void => { this.hooks.voice.pill('SAVE'); void this.save_send(); });
      const commands: HTMLElement = el('div', 'tdc-commands');
      commands.append(save);
      note.append(commands);
      side.append(note);
    }
    return side;
  }

  private stepLog_make(step: ScriptStep): HTMLElement {
    const box: HTMLElement = this.section_make('THE STEP\'S OUTPUT', 'tdc-col-steplog', this.busy?.step === step.key ? this.busy.line : undefined);
    const lines: HTMLElement = el('div', 'tdc-steplog');
    const shown: string[] = (this.stepLogs.get(step.key) ?? []).slice(-80);
    if (shown.length === 0) lines.append(el('span', 'tdc-quiet', 'what the line prints lands here when RUN sends it'));
    for (const one of shown) lines.append(el('span', 'tdc-steplog-line', one));
    box.append(lines);
    return box;
  }

  /**
   * A field over one of the line's options: typing rewrites the line.
   *
   * @param line - The line.
   * @param word - The option.
   * @param label - The field's label.
   * @param placeholder - A hint.
   * @returns The row.
   */
  private optionField_make(line: ScriptLine, word: string, label: string, placeholder: string): HTMLElement {
    const row: HTMLElement = el('div', 'tdc-name-row');
    const field: HTMLElement = el('label', 'tdc-pair-label', label);
    const input: HTMLInputElement = el('input', 'tdc-name-input');
    input.id = `ss-${word.slice(2)}-${line.number}`;
    field.setAttribute('for', input.id);
    input.value = lineOption_get(line.text, word) ?? '';
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.disabled = this.busy !== null;
    input.addEventListener('input', (): void => {
      line.text = lineOption_set(line.text, word, input.value.trim());
      this.edited = true;
      this.lineShown_redraw(line);
    });
    row.append(field, input);
    return row;
  }

  /** Redraws the line's box and the header after an edit, without losing the field's focus. */
  private lineShown_redraw(line: ScriptLine): void {
    const text: HTMLElement | null = this.parts.body.querySelector(`.ss-line[data-line='${line.number}'] .ss-line-text`);
    if (text !== null) text.textContent = line.text;
    const run: HTMLButtonElement | null = this.parts.body.querySelector(`.ss-run[data-line='${line.number}']`);
    if (run !== null) run.title = `sends: ${line.text}`;
    this.header_draw();
  }

  private runRow_make(step: ScriptStep, line: ScriptLine, tone: 'plain' | 'bill' = 'plain', extra: HTMLElement[] = []): HTMLElement {
    const commands: HTMLElement = el('div', 'tdc-commands');
    // The line is read when pressed, so an edit after the pill was drawn is what runs.
    const run: HTMLButtonElement = el('button', `tdc-pill tdc-pill-${tone} ss-run`, 'RUN');
    run.type = 'button';
    run.dataset['line'] = String(line.number);
    run.title = `sends: ${line.text}`;
    run.disabled = this.busy !== null || this.ask !== null;
    run.addEventListener('click', (): void => { this.hooks.voice.pill('RUN'); void this.line_send(line.text, step.key); });
    commands.append(run, ...extra);
    return commands;
  }

  private lineBoxNumbered_make(line: ScriptLine): HTMLElement {
    const box: HTMLElement = this.lineBox_make(line);
    box.dataset['line'] = String(line.number);
    return box;
  }

  private netNew_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const parts = line_parse(line.text);
    return [
      this.lineBoxNumbered_make(line),
      this.runRow_make(step, line),
      this.pairs_make([['NETWORK', parts.subject ?? '—'], ['ON OCI', 'a compartment of that name, its VCN, subnet, gateway, route and bastion']]),
      this.optionField_make(line, '--cidr', 'CIDR', '10.20.0.0/16'),
      el('p', 'tdc-prose tdc-quiet', 'Declares the network; nothing is built. The same values replay to unchanged.'),
    ];
  }

  private netBuild_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const name: string = line_parse(line.text).subject ?? '';
    const teardown: HTMLButtonElement = this.linePill_make('TEARDOWN', `net teardown ${name}`, step.key, 'destroy');
    teardown.title = `sends: net teardown ${name} (refused while anything stands on it)`;
    return [
      this.lineBoxNumbered_make(line),
      this.runRow_make(step, line, 'bill', [el('span', 'tdc-flex'), teardown]),
      this.pairs_make([['NETWORK', name], ['BUILDS', 'the compartment, VCN, subnet, gateway, route, security list and bastion; asks before the apply']]),
      el('p', 'tdc-prose tdc-quiet', 'A build plans first and asks; a second build reads nothing to do. The bastion admits this host\'s address alone.'),
    ];
  }

  private vmNew_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const name: string = line_parse(line.text).subject ?? '';
    const nodes: HTMLElement[] = [this.lineBoxNumbered_make(line), this.runRow_make(step, line), this.pairs_make([['VM', name], ['NETWORK', lineOption_get(line.text, '--net') ?? '—']])];
    if (this.limits === null) {
      nodes.push(el('p', 'tdc-prose tdc-quiet', 'reading what the shape sells: vm limits'));
    } else {
      const limits: VmLimitsModel = this.limits;
      const group: HTMLElement = el('div', 'tdc-lever-group');
      group.append(el('span', 'tdc-section-title', `SIZE · ${limits.shape}`));
      for (const spec of vmSliders_build(limits)) group.append(this.slider_make(line, spec, limits));
      nodes.push(group);
      const backup: HTMLElement = el('div', 'tdc-families');
      backup.append(el('span', 'tdc-pair-label', 'DATA BACKUP'));
      for (const choice of ['daily', 'none']) {
        const pill: HTMLButtonElement = el('button', `tdc-family${(vmLevers_read(line.text).dataBackup ?? 'none') === choice ? ' tdc-family-on' : ''}`, choice.toUpperCase());
        pill.type = 'button';
        pill.disabled = this.busy !== null;
        pill.addEventListener('click', (): void => { this.hooks.voice.pill(choice); line.text = lineOption_set(line.text, '--data-backup', choice); this.edited = true; this.stepCost_ask(line.text); this.draw(); });
        backup.append(pill);
      }
      nodes.push(backup);
    }
    nodes.push(this.optionField_make(line, '--open', 'OPEN PORTS', '80,443'), this.optionField_make(line, '--os', 'OS', 'ubuntu-26.04'));
    nodes.push(el('p', 'tdc-prose tdc-quiet', 'Declares the VM; nothing is built. On a built VM a changed size is planned and asked by VM BUILD; a smaller data volume is refused unless named.'));
    return nodes;
  }

  private slider_make(line: ScriptLine, spec: SliderSpec, limits: VmLimitsModel): HTMLElement {
    const row: HTMLElement = el('div', 'tdc-slider');
    const label: HTMLElement = el('label', 'tdc-slider-label', spec.label);
    const input: HTMLInputElement = el('input', 'tdc-slider-input');
    input.type = 'range';
    input.id = `ss-slider-${spec.word.slice(2)}`;
    label.setAttribute('for', input.id);
    const levers = vmLevers_read(line.text);
    const current: number | null = { '--vcpu': levers.vcpu, '--memory': levers.memory, '--disk': levers.disk, '--data': levers.data }[spec.word] ?? null;
    let min: number = spec.min;
    let max: number = spec.max;
    if (spec.word === '--memory' && levers.vcpu !== null) {
      const range = memoryRange_derive(limits, levers.vcpu);
      min = range.min;
      max = Math.min(range.max, spec.max);
    }
    input.min = String(min);
    input.max = String(max);
    input.step = String(spec.step);
    input.value = String(current ?? min);
    input.disabled = this.busy !== null;
    const shown: HTMLElement = el('span', 'tdc-slider-value', `${current ?? '—'}${spec.unit === '' ? '' : ` ${spec.unit}`}`);
    input.addEventListener('input', (): void => {
      line.text = lineOption_set(line.text, spec.word, input.value);
      this.edited = true;
      shown.textContent = `${input.value}${spec.unit === '' ? '' : ` ${spec.unit}`}`;
      this.lineShown_redraw(line);
      this.stepCostRefused = null;
      this.stepCost_ask(line.text);
    });
    // The vCPUs bound the memory: a change redraws the memory's ends.
    if (spec.word === '--vcpu') input.addEventListener('change', (): void => this.draw());
    const track: HTMLElement = el('div', 'tdc-slider-track');
    const ends: HTMLElement = el('div', 'tdc-slider-ends');
    ends.append(el('span', '', String(min)), el('span', 'tdc-slider-note', spec.word === '--memory' && limits.memory.perVcpu !== null ? `${limits.memory.perVcpu.min} TO ${limits.memory.perVcpu.max} GiB PER vCPU` : spec.word === '--data' ? 'KEPT BY A TEARDOWN' : ''), el('span', '', String(max)));
    track.append(input, ends);
    row.append(label, track, shown);
    return row;
  }

  /** VM NEW's side column: the price as the levers stand. */
  private cost_make(step: ScriptStep): HTMLElement {
    const side: HTMLElement = this.section_make('COST · AS SIZED', 'ss-col-side tdc-col-cost', 'FROM THE PRICE LIST · vm cost');
    const box: HTMLElement = el('div', 'ss-cost');
    side.append(box);
    this.cost_fill(box, step);
    if (this.edited) side.append(this.state_make(step).querySelector('.tdc-note') ?? el('span', ''));
    return side;
  }

  private cost_redraw(): void {
    const box: HTMLElement | null = this.parts.body.querySelector('.ss-cost');
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (box !== null && step !== undefined) this.cost_fill(box, step);
  }

  private cost_fill(box: HTMLElement, step: ScriptStep): void {
    box.replaceChildren();
    const row: VmCostRow | null = this.stepCost;
    if (row === null) {
      if (this.stepCostRefused !== null) {
        box.append(el('p', 'tdc-prose tdc-quiet', `not priced: ${this.stepCostRefused}`));
        return;
      }
      box.append(el('p', 'tdc-prose tdc-quiet', 'pricing the line as it stands…'));
      if (this.costTimer === null) this.stepCost_ask(step.lines[0]?.text ?? '');
      return;
    }
    const rows: HTMLElement = el('div', 'tdc-cost-rows');
    const rate = (label: string, value: VmCostRate | null, cls: string = ''): void => {
      rows.append(el('span', `tdc-pair-label ${cls}`.trim(), label), el('span', `tdc-cost-rate ${cls}`.trim(), value === null ? 'NOT PRICED' : rate_words(value, HOURS_PER_MONTH)));
    };
    rate('AS SIZED', row.cost, 'tdc-bill');
    if (row.cost !== null) rate('THE DATA ALONE', { machineHour: 0, dataHour: row.cost.dataHour, currency: row.cost.currency });
    if (row.before !== null) rate('AS DECLARED', row.before);
    box.append(this.pairs_make([['SPEC', spec_words(row.spec)], ['DECLARED', row.declared ? (row.changes.length === 0 ? 'YES · UNCHANGED' : `YES · ${row.changes.join(', ')}`) : 'NOT YET']]), rows);
    box.append(el('p', 'tdc-prose tdc-quiet', 'The data volume is kept by a default teardown, so its share is said apart. List price; nothing here bills until VM BUILD applies.'));
  }

  private vmBuild_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const name: string = line_parse(line.text).subject ?? '';
    const protect: HTMLElement = el('div', 'tdc-commands');
    protect.append(el('span', 'tdc-commands-label', 'THE LOCK'), this.linePill_make('PROTECT · ON', `vm protect ${name} on`, step.key, 'quiet'), this.linePill_make('PROTECT · OFF', `vm protect ${name} off`, step.key, 'quiet'));
    const teardown: HTMLElement = el('div', 'tdc-commands');
    const machine: HTMLButtonElement = this.linePill_make('TEARDOWN', `vm teardown ${name}`, step.key, 'destroy');
    machine.title = `sends: vm teardown ${name} (the machine; the data, its backups and the address stay)`;
    const all: HTMLButtonElement = this.linePill_make('TEARDOWN · ALL', `vm teardown ${name} --all`, step.key, 'destroy');
    all.classList.add('ss-pill-redder');
    all.title = `sends: vm teardown ${name} --all (the data too; asks for the name typed back)`;
    teardown.append(el('span', 'tdc-commands-label', 'UNDOING'), machine, all);
    return [
      this.lineBoxNumbered_make(line),
      this.runRow_make(step, line, 'bill'),
      this.pairs_make([['VM', name], ['BUILDS', 'the data volume, its backups and the address, then the machine; asks before the apply with the cost'], ['OVER', 'kept data, when the machine alone was torn down']]),
      el('p', 'tdc-prose tdc-quiet', 'A VM is born protected: teardown refuses until PROTECT · OFF, a line of its own. A teardown returns this step to ready.'),
      protect,
      teardown,
    ];
  }

  private chrisDeploy_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const name: string = line_parse(line.text).subject ?? '';
    const profiles: HTMLElement = el('div', 'tdc-families');
    profiles.append(el('span', 'tdc-pair-label', 'PROFILE'));
    const chosen: string = lineOption_get(line.text, '--profile') ?? 'minimal';
    for (const profile of [...new Set([chosen, ...CHRIS_PROFILES])]) {
      const pill: HTMLButtonElement = el('button', `tdc-family${profile === chosen ? ' tdc-family-on' : ''}`, profile.toUpperCase());
      pill.type = 'button';
      pill.disabled = this.busy !== null;
      pill.addEventListener('click', (): void => { this.hooks.voice.pill(profile); line.text = lineOption_set(line.text, '--profile', profile); this.edited = true; this.draw(); });
      profiles.append(pill);
    }
    return [
      this.lineBoxNumbered_make(line),
      this.runRow_make(step, line, 'bill'),
      this.pairs_make([['ON', name], ['PUTS UP', 'CUBE with its workers, Postgres, dragonfly, nats and pfcon, over the bastion path; the admin password asked once, hidden']]),
      profiles,
      this.optionField_make(line, '--compute', 'COMPUTE', `the pfcon resource's name (default ${name})`),
      this.optionField_make(line, '--host', 'HOST', 'cube.example.org · writes the A record or waits on the registrar'),
      this.optionField_make(line, '--porter', 'PORTER', 'porter.example.org · the door to mise beside it'),
      this.optionField_make(line, '--admin-password-file', 'PASSWORD FILE', 'a file on the host; empty: asked hidden'),
      el('p', 'tdc-prose tdc-quiet', 'Replays resume where they stopped: a deploy waiting on DNS reads ready and goes on from there.'),
    ];
  }

  private users_make(step: ScriptStep): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const list: HTMLElement = el('div', 'ss-users');
    for (const line of step.lines) {
      const row: HTMLElement = this.lineBoxNumbered_make(line);
      const commands: HTMLElement = el('div', 'tdc-commands');
      const run: HTMLButtonElement = this.linePill_make('RUN', line.text, step.key, 'quiet');
      run.classList.add('ss-run');
      run.dataset['line'] = String(line.number);
      commands.append(run);
      row.append(commands);
      list.append(row);
    }
    nodes.push(list);
    const form: HTMLElement = el('div', 'tdc-lever-group ss-user-form');
    form.append(el('span', 'tdc-section-title', 'THE NEXT USER'));
    const field = (key: 'name' | 'email' | 'passwordFile', label: string, placeholder: string): HTMLElement => {
      const row: HTMLElement = el('div', 'tdc-name-row');
      const tag: HTMLElement = el('label', 'tdc-pair-label', label);
      const input: HTMLInputElement = el('input', 'tdc-name-input');
      input.id = `ss-user-${key}`;
      tag.setAttribute('for', input.id);
      input.value = this.userForm[key];
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.disabled = this.busy !== null;
      input.addEventListener('input', (): void => { this.userForm[key] = input.value.trim(); this.userAdd_redraw(step); });
      row.append(tag, input);
      return row;
    };
    form.append(field('name', 'NAME', 'a login, as rudolph'), field('email', 'EMAIL', 'where CUBE writes to'), field('passwordFile', 'PASSWORD FILE', 'a file on the host; empty: asked hidden when the line runs'));
    const on: string = step.lines.map((line: ScriptLine): string | null => lineOption_get(line.text, '--on')).find((value): value is string => value !== null) ?? '';
    const commands: HTMLElement = el('div', 'tdc-commands ss-user-add');
    form.append(commands);
    nodes.push(form, el('p', 'tdc-prose tdc-quiet', 'Each user is a line, so a ChRIS\'s accounts are declared, not remembered. ADD appends the line to the working copy and runs it; a name already there is left as it is. The password never shows here: it is asked hidden, or read from the file the line names.'));
    this.userAdd_fill(commands, step, on);
    return nodes;
  }

  private userAdd_redraw(step: ScriptStep): void {
    const commands: HTMLElement | null = this.parts.body.querySelector('.ss-user-add');
    if (commands === null) return;
    const on: string = step.lines.map((line: ScriptLine): string | null => lineOption_get(line.text, '--on')).find((value): value is string => value !== null) ?? '';
    this.userAdd_fill(commands, step, on);
  }

  private userAdd_fill(commands: HTMLElement, step: ScriptStep, on: string): void {
    commands.replaceChildren();
    const { name, email, passwordFile } = this.userForm;
    const refusal: string | null = name === '' ? 'NAME' : !/^[a-z][a-z0-9_-]{1,31}$/.test(name) ? 'NAME IS A LOGIN' : email === '' ? 'EMAIL' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'EMAIL IS AN ADDRESS' : step.lines.some((line: ScriptLine): boolean => line_parse(line.text).subject === name) ? 'ALREADY A LINE' : null;
    const line: string = userLine_build(name || '<name>', email || '<email>', passwordFile, on);
    const add: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', refusal === null ? 'ADD' : `ADD · ${refusal}`);
    add.type = 'button';
    add.title = `appends and sends: ${line}`;
    add.disabled = refusal !== null || this.busy !== null;
    add.addEventListener('click', (): void => {
      this.hooks.voice.pill('ADD');
      const number: number = (this.lines.at(-1)?.number ?? 0) + 1;
      const added: ScriptLine = { number, text: line, state: 'ready', detail: '' };
      this.lines.push(added);
      this.steps = steps_build(this.lines);
      this.edited = true;
      this.userForm = { name: '', email: '', passwordFile: '' };
      void this.line_send(line, 'users');
    });
    commands.append(add, el('span', 'tdc-mono ss-user-line', line));
  }

  private other_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    return [this.lineBoxNumbered_make(line), this.runRow_make(step, line), el('p', 'tdc-prose tdc-quiet', 'The screen has no form for this verb: the line runs as written.')];
  }

  // -------------------------------------------------------------- the strip

  private strip_draw(): void {
    const strip: HTMLElement = this.parts.strip;
    strip.replaceChildren();
    strip.hidden = this.ask === null;
    if (this.ask === null) return;
    const ask: OpenAsk = this.ask;
    const form = askForm_derive(ask.message);
    const destroying: boolean = /teardown|destroy|remove/i.test(ask.message) || form === 'name';
    const billing: boolean = /an hour|a month|\$|bill/i.test(ask.message);
    strip.dataset['tone'] = destroying ? 'destroy' : billing ? 'bill' : 'plain';
    const words: HTMLElement = el('div', 'tdc-strip-words');
    words.append(el('span', 'tdc-strip-title', 'THE ENGINE ASKS'), el('span', 'tdc-strip-text', ask.message));
    strip.append(words);
    if (form === 'yes-no') {
      const go: HTMLButtonElement = el('button', `tdc-pill ${destroying ? 'tdc-pill-destroy' : billing ? 'tdc-pill-bill' : 'tdc-pill-plain'}`, 'CONTINUE');
      go.type = 'button';
      go.addEventListener('click', (): void => { this.hooks.voice.pill('CONTINUE'); this.log_add('y', 'answer'); ask.answer('y'); });
      const stop: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'STOP');
      stop.type = 'button';
      stop.addEventListener('click', (): void => { this.hooks.voice.pill('STOP'); this.log_add('n', 'answer'); ask.answer('n'); });
      strip.append(go, stop);
      return;
    }
    const input: HTMLInputElement = el('input', 'tdc-strip-input');
    input.id = 'ss-strip-input';
    input.type = ask.kind === 'secret' ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const label: HTMLElement = el('label', 'tdc-pair-label', form === 'name' ? 'NAME' : ask.kind === 'secret' ? 'HIDDEN' : 'ANSWER');
    label.setAttribute('for', input.id);
    const send: HTMLButtonElement = el('button', `tdc-pill ${destroying ? 'tdc-pill-destroy' : 'tdc-pill-plain'}`, form === 'name' ? 'DESTROY' : 'SEND');
    send.type = 'button';
    const answer = (): void => {
      if (send.disabled) return;
      this.hooks.voice.pill(send.textContent ?? '');
      this.log_add(ask.kind === 'secret' ? '(hidden)' : input.value, 'answer');
      ask.answer(input.value);
    };
    if (form === 'name') {
      send.disabled = true;
      input.addEventListener('input', (): void => { send.disabled = input.value.trim() === ''; });
    }
    send.addEventListener('click', answer);
    input.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Enter') answer(); });
    const stop: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'STOP');
    stop.type = 'button';
    stop.addEventListener('click', (): void => { this.hooks.voice.pill('STOP'); this.log_add('(declined)', 'answer'); ask.answer(''); });
    strip.append(label, input, send, stop);
    queueMicrotask((): void => input.focus());
  }

  // ---------------------------------------------------------------- the log

  private log_add(text: string, kind: 'sent' | 'out' | 'ask' | 'answer' | 'note'): void {
    const row: HTMLElement = el('span', `tdc-log-line tdc-log-${kind}`, text);
    this.parts.log.append(row);
    while (this.parts.log.childElementCount > LOG_LIMIT) this.parts.log.firstElementChild?.remove();
    this.parts.log.scrollTop = this.parts.log.scrollHeight;
    if (kind === 'out' && this.busy !== null && this.busy.step !== null) {
      const lines: string[] = this.stepLogs.get(this.busy.step) ?? [];
      lines.push(text);
      this.stepLogs.set(this.busy.step, lines);
      if (this.view === this.busy.step) {
        const box: HTMLElement | null = this.parts.body.querySelector('.tdc-steplog');
        if (box !== null) {
          box.querySelector('.tdc-quiet')?.remove();
          box.append(el('span', 'tdc-steplog-line', text));
          while (box.childElementCount > 80) box.firstElementChild?.remove();
          box.scrollTop = box.scrollHeight;
        }
      }
    }
  }
}
