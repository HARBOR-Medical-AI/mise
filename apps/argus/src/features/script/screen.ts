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
  chrisPlanModelSchema, manifestStatusModelSchema, MANIFEST_STATUS_MODEL_KIND, netStatusModelSchema, STRATUS_CHRIS_PLAN_MODEL_KIND, STRATUS_NET_STATUS_MODEL_KIND, STRATUS_VM_COST_MODEL_KIND, STRATUS_CHRIS_STATUS_MODEL_KIND, STRATUS_VM_LIMITS_MODEL_KIND, STRATUS_VM_STATUS_MODEL_KIND, chrisStatusModelSchema, vmCostModelSchema, vmLimitsModelSchema, vmStatusModelSchema,
  type ChrisPlanModel, type ChrisStatusRow, type NetStatusRow, type LineStandingModel, type LineState, type PromptKind, type VmCostRate, type VmCostRow, type VmLimitsModel, type VmStatusRow,
} from '@fnndsc/menu';
import { HOURS_PER_MONTH, money_text } from '../controller/model.js';
import { saveLine_compose } from '../edit/line.js';
import { lockWhere_text, modePill_make, READ_ASKS, READ_HELD, readHold_derive, type ReadHold } from '../takeover/tier.js';
import { takeoverFrame_build, type TakeoverFrame, type TakeoverView } from '../takeover/frame.js';
import {
  askForm_derive, costLine_derive, counts_words, duration_words, line_parse, lineOption_get, lineOption_set, lines_build, memoryRange_derive, rate_words, rates_sum,
  buildWould_derive, ports_word, runningStep_find, words_split, script_render, scriptName_derive, scriptSource_derive, spec_words, states_count, stepBuildLine_get, stepKind_derive, stepKind_isTask, steps_build, userLine_build, vmLevers_read, vmSliders_build,
  word_quote, workingCopy_derive, type BuildWould, type ScriptLine, type ScriptStep, type SliderSpec, type StateCounts, type VmRuns,
} from './model.js';

/** An answer the session gave a quiet line: what the screen reads of it. */
/** Edits not saved, kept by the host while the screen is away. */
export interface ScriptDraft {
  /** The script the edits are of. */
  readonly path: string;
  /** Its text as edited. */
  readonly text: string;
  /** Its text as it was read, to say when it changed on the host since. */
  readonly read: string;
  /** How many lines differ from what was read. */
  readonly edits: number;
}

export interface QuietAnswer {
  envelopes: ReadonlyArray<{ rendered?: string; renderedErr?: string; status?: string; model?: { kind: string; data: unknown } }>;
}

/** What the screen needs from its host. */
export interface ScriptHooks {
  /** Runs an operator's line (it may ask); its output arrives through `output_take`; resolves when it ends, true when no answer was an error. */
  run: (line: string) => Promise<boolean>;
  /** Asks a line quietly, for a model; rejects when the session refused. */
  ask: (line: string) => Promise<QuietAnswer>;
  /** Stops following the running line. */
  stop: () => void;
  /** Gives the screen back. */
  leave: () => void;
  /** The answer at the cloud door: MANAGE (true), READ (false), or null when there is no door. */
  manage_is: () => boolean | null;
  /** Asks the person's password and raises a READ session for a line that would act; null when the session cannot be raised. */
  elevate_ask: ((line: string) => Promise<boolean>) | null;
  /** How the screen is heard. */
  voice: { pill: (label: string) => void; cue: (name: string) => void };
}

/** A question the engine put, standing on the strip. */
export interface OpenAsk {
  message: string;
  kind: PromptKind;
  answer: (value: string | null) => void;
  /** Answers the session alone, the screen untouched: for a question carried away when the screen is left. */
  settle: (value: string | null) => void;
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
  /** Where its clone stands (`<hash> <date> <subject>`), read from git; null when not said. */
  readonly head: string | null;
}

/** The library's view key on the rail. */
export const LIBRARY_VIEW: string = 'library';

/** What a screen built on this one sets over its frame: the VM controller wears its own brand, banner and strips. */
export interface ScreenLook {
  id: string;
  className: string;
  brand: { name: string; sub: string; mark: boolean };
  banner: string;
  stage: { title: string; note: string };
  log: { title: string; note: string };
  labels: { views: string; log: string };
  /** The `aria-label` of the seat under the brand. */
  seatLabel: string;
}

/** The script screen's own look. */
const SCRIPT_LOOK: ScreenLook = {
  id: 'script-screen',
  className: 'td-controller script-screen',
  brand: { name: 'STRATUS', sub: 'SCRIPT · OCI', mark: true },
  banner: 'STRATUS • SCRIPT',
  stage: { title: 'THE LIBRARY', note: 'SCRIPTS' },
  log: { title: 'SCRIPT LOG', note: 'THE SESSION\'S LINES · TYPE BELOW' },
  labels: { views: 'Steps', log: 'Script log' },
  seatLabel: 'The script',
};

/** How many log lines are kept. */
const LOG_LIMIT: number = 400;

/** What a line answered yes here reads while its task is not yet named. */
const ANSWERED_GOING: string = 'its answer is given: the act goes on';

/** How long a line answered yes here may read RUNNING with no task named: the build's next step starts well inside it. */
const ANSWERED_GOING_MS: number = 120_000;

/** How often the standing is read again while that line waits to be seen running. */
const ANSWERED_POLL_MS: number = 1_500;

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
  protected readonly frame: TakeoverFrame;
  /** The script open, or `''` for the library alone. */
  protected path: string = '';
  protected lines: ScriptLine[] = [];
  protected steps: ScriptStep[] = [];
  protected view: string = LIBRARY_VIEW;
  /** Whether a form changed a line since the file was read. */
  protected edited: boolean = false;
  protected scripts: LibraryScript[] = [];
  protected sources: LibrarySource[] = [];
  protected libraryRead: boolean = false;
  protected limits: VmLimitsModel | null = null;
  protected limitsAsked: boolean = false;
  /** What the declared VMs bill together, from `vm cost` bare. */
  protected standing: VmCostRate | null = null;
  /** Each VM as `vm cost` bare priced it (as declared, and as it runs): what an undoing stops billing. */
  protected costRows: Map<string, VmCostRow> = new Map();
  /** When what stands was read from the tenancy (the oldest of the VMs priced), or null when none was. */
  protected standingAt: string | null = null;
  /** What every declared VM would cost as declared, beside what stands; null when not priced. */
  protected declaredRate: VmCostRate | null = null;
  /** The VM NEW step's own price as its levers move. */
  protected stepCost: VmCostRow | null = null;
  /** Why the last `vm cost` for the step did not answer, or null. */
  protected stepCostRefused: string | null = null;
  protected costTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last `vm cost` sent for the step: an answer to an older one is dropped, so a slow price never overwrites a newer. */
  protected costAsked: number = 0;
  /** When the session read the price list, as `vm cost` last said; null before the first price. */
  protected pricesRead: string | null = null;
  /** What runs, priced: asked once per read of what runs (its VM and when it was read), so the offer's price is said against it. */
  protected runsCost: { key: string; row: VmCostRow | null } | null = null;
  /** The seat a BUILD ended on in this screen, so its receipt says it was built here and read back. */
  protected builtHere: string | null = null;
  /** What stands of each network, by name, as `net status` answered it with when it read the tenancy (null while asked). */
  protected readonly nets: Map<string, { row: NetStatusRow | null; read: string | null } | null> = new Map();
  /** What a `chris deploy` line would do, by the line's text, as `--plan` answered it (null while asked or when it did not answer). */
  protected readonly chrisPlans: Map<string, ChrisPlanModel | null> = new Map();
  /** The line running, and since when. */
  protected busy: { line: string; step: string | null; since: number } | null = null;
  /** The standing read again a moment after a task-starting line was sent, so the seat wears the run while the line still holds the lane. */
  protected refreshTimer: ReturnType<typeof setTimeout> | null = null;
  protected ask: OpenAsk | null = null;
  protected partial: string = '';
  /** What each step's lines printed, for its body. */
  protected readonly stepLogs: Map<string, string[]> = new Map();
  /** Which line printed each seat's output, and when. */
  protected readonly stepLogFrom: Map<string, { line: string; at: string }> = new Map();
  /** The last line the session refused, on the seat it was pressed on, with when and why; kept until a line is sent from that seat again. */
  protected refusal: { view: string; line: string; at: string; why: string; declined: boolean } | null = null;
  /** The seat whose task this screen follows with no line in its lane (its question answered here), until it no longer runs. */
  protected followStep: string | null = null;
  /** Edits the host kept from before the screen was left, laid over the script when it opens on their path. */
  protected draftOffered: ScriptDraft | null = null;
  /** The kept edits laid over the script, with when: said on the seat until SAVE or the next read. */
  protected draftRestored: { at: string; edits: number; moved: boolean } | null = null;
  /**
   * A line whose question was answered yes here with no line in this lane:
   * it reads RUNNING until a standing names its task (then followed), its
   * state moves from what it was at the answer, or the bound passes; a
   * standing read before the task starts never draws it idle.
   */
  protected answeredGoing: { line: string; state: LineState | null; until: number } | null = null;
  /** The line the standing question was asked for, when it is one of the script's: it reads ASKING. */
  protected askLine: string | null = null;

  /** Whether an act is under way here: a line in the lane, a question standing, or a step's task running; commits wait. */
  protected acting_is(): boolean {
    return this.busy !== null || this.ask !== null || runningStep_find(this.steps) !== undefined;
  }

  /** What the line in flight has printed, for the refusal's why. */
  protected busyOut: string[] = [];
  /** The last answer of a line that changes only this host's clones (PULL), with when: its receipt stands in the library, not only in the log. */
  protected pulled: { at: string; said: string[] } | null = null;
  /** Whether the operator answered no to the line in flight's question: its stop is a choice, said as declined, never as refused. */
  protected busyDeclined: boolean = false;
  /** The USERS form's words, kept across redraws. */
  protected userForm: { name: string; email: string; passwordFile: string } = { name: '', email: '', passwordFile: '' };
  /** Each line's text as its standing was last read for: a line edited since wears no stale standing. */
  protected stoodFor: Map<number, string> = new Map();
  /** The script as it was read (or last saved): an edit is said against it. */
  protected readText: string = '';
  /** The last SAVE, where and when: its receipt stands on the seat until the next edit. */
  protected saved: { path: string; at: string; view: string } | null = null;
  protected readonly parts: { header: HTMLElement; body: HTMLElement; strip: HTMLElement; log: HTMLElement; input: HTMLInputElement; promptLabel: HTMLElement };
  protected ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * Builds the screen.
   *
   * @param hooks - The host's verbs.
   */
  constructor(protected readonly hooks: ScriptHooks, look: ScreenLook = SCRIPT_LOOK) {
    this.frame = takeoverFrame_build({
      id: look.id,
      className: look.className,
      brand: look.brand,
      banner: look.banner,
      views: look === SCRIPT_LOOK ? [{ key: LIBRARY_VIEW, label: 'LIBRARY' }] : [],
      leave: { label: 'LEAVE' },
      stage: look.stage,
      log: look.log,
      labels: look.labels,
    }, (key: string): void => this.view_press(key), (): void => { this.hooks.voice.pill('LEAVE'); this.hooks.leave(); });
    this.root = this.frame.root;
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-label', look === SCRIPT_LOOK ? 'Script screen' : look.brand.sub);
    this.frame.seat.setAttribute('aria-label', look.seatLabel);

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

  /**
   * Brings back what a press sent away, one layer at a time: the gutter first, then the head; true when something
   * came back (Esc restores before it leaves).
   */
  public frame_restore(): boolean {
    return this.frame.gutter_restore() || this.frame.header_restore();
  }

  /** Stops the screen's clock; the host calls it on leaving. */
  public dispose(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    if (this.costTimer !== null) clearTimeout(this.costTimer);
    this.costTimer = null;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
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
    // The rail opens on the step running now, else on the first that needs the operator.
    const first: ScriptStep | undefined = runningStep_find(this.steps) ?? this.steps.find((step: ScriptStep): boolean => step.state === 'changed' || step.state === 'ready') ?? this.steps[0];
    this.view = first?.key ?? LIBRARY_VIEW;
    this.draw();
    void this.standing_read();
    if (this.steps.some((step: ScriptStep): boolean => step.kind === 'vm new')) void this.limits_need();
    this.running_follow();
  }

  /** The door's answer changed (the session was raised): drawn again with it. */
  public mode_refresh(): void {
    this.draw();
  }

  /** A task of the session ended (heard on the ambient channel): the standing is read again, so a seat that ran reads what it is now. */
  public taskEnded_take(): void {
    if (this.path === '' || this.busy !== null) return;
    void this.standings_refresh().then((): void => this.draw());
  }

  /** Whether the line running is a task's follow: `wait`, or a step whose task the standing names. */
  public following_is(): boolean {
    if (this.busy === null) return false;
    if (this.busy.line.startsWith('wait ')) return true;
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.busy?.step);
    return step !== undefined && step.running !== null;
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

  /**
   * Takes the standing question off the strip unanswered, for the host to
   * keep while the screen is away: leaving never answers it (a-change-is-a-loop,
   * clause 6: returning finds the question where it was).
   *
   * @returns The question and how it is answered, or null when none stands.
   */
  public ask_detach(): { message: string; kind: PromptKind; resolve: (value: string | null) => void } | null {
    const open: OpenAsk | null = this.ask;
    if (open === null) return null;
    this.ask = null;
    this.askLine = null;
    return { message: open.message, kind: open.kind, resolve: open.settle };
  }

  /**
   * The edits not saved, for the host to keep while the screen is away:
   * leaving never drops them silently (a-change-is-a-loop, clause 6d).
   *
   * @returns The script's path, its text as edited and as it was read, or null when nothing is unsaved (kept edits
   *   offered and not laid over a script are handed back).
   */
  public draft_detach(): ScriptDraft | null {
    // Kept edits offered and never laid over a script (the screen opened elsewhere) go back to the host as they came.
    const pending: ScriptDraft | null = this.draftOffered;
    this.draftOffered = null;
    if (!this.edited || this.path === '') return pending;
    const draft: ScriptDraft = { path: this.path, text: script_render(this.lines), read: this.readText, edits: this.lines.filter((line: ScriptLine): boolean => this.stoodFor.get(line.number) !== line.text).length };
    this.edited = false;
    return draft;
  }

  /**
   * Edits kept from before the screen was left, laid over the script when
   * it opens on the same path: they stand again unsaved, said as kept.
   *
   * @param draft - The edits the host kept.
   */
  public draft_offer(draft: ScriptDraft): void {
    this.draftOffered = draft;
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
      this.askLine = this.lines.find((line: ScriptLine): boolean => message.startsWith(`${line.text}:`) || message.startsWith(`${line.text} `))?.text ?? null;
      // The question stands over its own offer: the seat of the line it asks for is shown (a-change-is-a-loop, clause 4).
      const seat: ScriptStep | undefined = this.askLine === null ? undefined : this.steps.find((step: ScriptStep): boolean => step.lines.some((line: ScriptLine): boolean => line.text === this.askLine));
      if (seat !== undefined) this.view = seat.key;
      this.ask = { message, kind, settle: resolve, answer: (value: string | null): void => {
        const answeredLine: string | null = this.askLine;
        this.ask = null;
        this.askLine = null;
        this.draw();
        resolve(value);
        // A question this screen did not send the line for (asked while it was away): from the answer on, the line reads
        // RUNNING, its commits wait, and what its task prints lands under its seat; its standing is read again after.
        if (this.busy === null && answeredLine !== null && value !== null && value !== '' && value.toLowerCase() !== 'n') {
          this.answeredGoing = { line: answeredLine, state: this.lines.find((line: ScriptLine): boolean => line.text === answeredLine)?.state ?? null, until: Date.now() + ANSWERED_GOING_MS };
          this.followStep = this.steps.find((step: ScriptStep): boolean => step.lines.some((line: ScriptLine): boolean => line.text === answeredLine))?.key ?? null;
          this.lines = this.lines.map((line: ScriptLine): ScriptLine => (line.text === answeredLine ? { ...line, running: ANSWERED_GOING } : line));
          this.steps = this.steps_derive(this.lines);
          this.draw();
        }
        if (this.answeredGoing !== null && this.answeredGoing.line === answeredLine) {
          this.answeredGoing_poll();
        } else if (this.busy === null) void this.standings_refresh().then((): void => this.draw());
      } };
      this.log_add(message, 'ask');
      // What stands is read again while the question stands: a plan may have made free things (a stack) to plan it.
      this.nets.clear();
      this.draw();
      void this.vmsSeen_read();
    });
  }

  // ---------------------------------------------------------------- reading

  protected async script_read(): Promise<void> {
    let text: string = '';
    try {
      text = text_extract(await this.hooks.ask(`cat ${this.path}`));
    } catch (error: unknown) {
      this.log_add(`cat ${this.path}: ${error instanceof Error ? error.message : String(error)}`, 'note');
    }
    const standings = await this.status_read(this.path);
    this.lines = this.accountsHeld_apply(lines_build(text, standings?.lines ?? []));
    this.readText = text;
    this.stoodFor = new Map(this.lines.map((line: ScriptLine): [number, string] => [line.number, line.text]));
    this.draftRestored = null;
    // Edits kept from before the screen was left stand again, unsaved, over the script as read now (clause 6d).
    const draft: ScriptDraft | null = this.draftOffered;
    if (draft !== null && draft.path === this.path) {
      this.draftOffered = null;
      const edited = await this.status_read(this.path, draft.text);
      this.lines = this.accountsHeld_apply(lines_build(draft.text, edited?.lines ?? []));
      this.edited = true;
      this.draftRestored = { at: new Date().toISOString(), edits: draft.edits, moved: draft.read !== text };
    }
    this.steps = this.steps_derive(this.lines);
    void this.vmsSeen_read();
    void this.chrisSeen_read();
  }

  /**
   * A user line stands done once CUBE holds its account, as its accounts were
   * read from it (a-change-is-a-loop, clause 5: the receipt is the render);
   * the host's records cannot say, so its standing alone reads ready. A
   * screen that reads no ChRIS leaves the lines as they stand.
   *
   * @param lines - The lines.
   * @returns The lines, a user line whose account CUBE holds standing done; the others as they were.
   */
  protected accountsHeld_apply(lines: ScriptLine[]): ScriptLine[] {
    return lines.map((line: ScriptLine): ScriptLine => {
      const parts = line_parse(line.text);
      if (parts.verb.join(' ') !== 'chris user add' || parts.subject === null || line.running !== null || line.state === 'done') return line;
      const live = this.chrisRow_get(lineOption_get(line.text, '--on') ?? '')?.live ?? null;
      if (live?.accounts == null || !live.accounts.some((one): boolean => one.username === parts.subject)) return line;
      return { ...line, state: 'done', detail: `in CUBE, read from it ${live.at.slice(11, 16)} UTC` };
    });
  }

  /**
   * The rail's steps from the lines: one per line, the user lines gathered.
   * A screen keyed by one machine narrows them to its lines and names them its way.
   *
   * @param lines - The script's lines.
   * @returns The steps.
   */
  protected steps_derive(lines: ReadonlyArray<ScriptLine>): ScriptStep[] {
    return steps_build(lines);
  }

  /** Whether VM BUILD's body carries the lock and the undoing (a screen with a TEARDOWN seat of its own says no). */
  protected undoing_shown(): boolean {
    return true;
  }

  /** A model from a quiet answer, for a screen built on this one. */
  protected model_take<T>(answer: QuietAnswer, kind: string, parse: (data: unknown) => { success: boolean; data?: T }): T | null {
    return model_extract(answer, kind, parse);
  }

  /** The listings in a quiet answer, for a screen built on this one. */
  protected listings_take(answer: QuietAnswer): Listed[] {
    return listings_extract(answer);
  }

  /**
   * Where a script's lines stand: `play <path> --status`, each verb answering for its own line.
   *
   * @param path - The script.
   * @returns The model, or null when the session did not answer it.
   */
  protected async status_read(path: string, text: string | null = null): Promise<{ lines: LineStandingModel[] } | null> {
    try {
      // A script not written yet is read from the screen's own lines (`--text`), so its seats wear their states before the first act.
      const answer: QuietAnswer = await this.hooks.ask(`play ${path} --status${text === null ? '' : ` --text=${word_quote(text)}`}`);
      return model_extract(answer, MANIFEST_STATUS_MODEL_KIND, (data: unknown) => manifestStatusModelSchema.safeParse(data));
    } catch (error: unknown) {
      this.log_add(`play ${path} --status: ${error instanceof Error ? error.message : String(error)}`, 'note');
      return null;
    }
  }

  /**
   * What runs of a VM, read from the tenancy, with when; null on a screen
   * that reads none (the script screen, which shows a script's lines and
   * nothing of a machine).
   *
   * @param _name - The VM.
   * @returns What runs, or null.
   */
  protected runs_get(name: string): (VmRuns & { at: string }) | null {
    return this.vmsSeen.get(name)?.stands ?? null;
  }

  /**
   * What runs of a VM's ChRIS, as `chris status` read it from the ChRIS;
   * null on a screen that reads none (the script screen).
   *
   * @param _vm - The VM.
   * @returns The row, or null.
   */
  protected chrisRow_get(vm: string): ChrisStatusRow | null {
    return this.chrisSeen.get(vm) ?? null;
  }

  /** Whether a declaring seat offers DECLARE beside BUILD: the script screen does (declaring is authoring there); a machine's own screen offers BUILD alone (a-change-is-a-loop, clause 3). */
  protected declareOffered(): boolean {
    return true;
  }

  /** The script's text when it is not on the host yet, to read its standing from; null when the file is the script. */
  protected statusText_get(): string | null {
    // An edit not saved is the screen's own text: the standing is read of what the screen shows, so a difference is said
    // against what was declared in the operator's direction, never the file's.
    return this.edited ? script_render(this.lines) : null;
  }

  /** Reads the script's standing again, after a line ran. */
  protected async standings_refresh(): Promise<void> {
    if (this.path === '') return;
    const standings = await this.status_read(this.path, this.statusText_get());
    if (standings === null) return;
    let fresh: ScriptLine[] = lines_build(script_render(this.lines), standings.lines);
    // A line answered yes here stays RUNNING until its task is named, its state moves, or the bound passes (a-change-is-a-loop, clause 5c).
    let follow: boolean = false;
    const going = this.answeredGoing;
    if (going !== null) {
      const stood: ScriptLine | undefined = fresh.find((line: ScriptLine): boolean => line.text === going.line);
      if (stood === undefined || stood.running !== null || stood.state !== going.state || Date.now() > going.until) {
        this.answeredGoing = null;
        follow = stood?.running != null;
      } else {
        fresh = fresh.map((line: ScriptLine): ScriptLine => (line.text === going.line ? { ...line, running: ANSWERED_GOING } : line));
      }
    }
    this.lines = this.accountsHeld_apply(fresh);
    // What a deploy would do, and what stands of a network, are read again after any line: the line that ran may have changed them.
    this.chrisPlans.clear();
    this.nets.clear();
    this.steps = this.steps_derive(this.lines);
    this.stoodFor = new Map(this.lines.map((line: ScriptLine): [number, string] => [line.number, line.text]));
    if (this.followStep !== null && runningStep_find(this.steps) === undefined) this.followStep = null;
    // Its task named, the screen follows it as it does on opening: what it prints lands under its seat, and the lane says it runs.
    if (follow) this.running_follow();
    void this.standing_read();
    void this.vmsSeen_read();
    void this.chrisSeen_read();
  }

  /** What runs of each ChRIS the script names, as `chris status` read it from the ChRIS: USERS' accounts and CHRIS's runs, beside their lines, as on the VM controller. */
  protected chrisSeen: Map<string, ChrisStatusRow> = new Map();
  /** Whether `chris status` has answered once, so a ChRIS absent from it is known absent, not unread. */
  protected chrisSeenRead: boolean = false;
  /** When `chris status` last answered. */
  protected chrisSeenAt: string | null = null;

  /** Reads `chris status` when the script names a ChRIS, then redraws; a user line CUBE now holds reads done. */
  protected async chrisSeen_read(): Promise<void> {
    if (!this.lines.some((line: ScriptLine): boolean => line_parse(line.text).verb[0] === 'chris')) return;
    try {
      const model = model_extract(await this.hooks.ask('chris status'), STRATUS_CHRIS_STATUS_MODEL_KIND, (data: unknown) => chrisStatusModelSchema.safeParse(data));
      if (model === null) return;
      this.chrisSeen = new Map(model.chris.map((row: ChrisStatusRow): [string, ChrisStatusRow] => [row.vm, row]));
      this.chrisSeenRead = true;
      this.chrisSeenAt = new Date().toISOString();
    } catch {
      return;
    }
    this.lines = this.accountsHeld_apply(this.lines);
    this.steps = this.steps_derive(this.lines);
    this.draw();
  }

  /** What runs of each VM the script declares, as `vm status` read it from the tenancy: the script screen renders what runs beside its VM seats as the VM controller does. */
  protected vmsSeen: Map<string, VmStatusRow> = new Map();
  /** Whether `vm status` has answered once, so a VM absent from it is known absent, not unread. */
  protected vmsSeenRead: boolean = false;

  /** Reads `vm status` when the script declares a VM, then redraws. */
  protected async vmsSeen_read(): Promise<void> {
    if (!this.lines.some((line: ScriptLine): boolean => line_parse(line.text).verb[0] === 'vm')) return;
    try {
      const model = model_extract(await this.hooks.ask('vm status'), STRATUS_VM_STATUS_MODEL_KIND, (data: unknown) => vmStatusModelSchema.safeParse(data));
      this.vmsSeen = new Map((model?.vms ?? []).map((row: VmStatusRow): [string, VmStatusRow] => [row.name, row]));
      this.vmsSeenRead = model !== null;
    } catch {
      return;
    }
    this.draw();
  }

  /** Reads the standing again until the line answered yes here is seen running, moved, or past its bound. */
  protected answeredGoing_poll(): void {
    setTimeout((): void => {
      if (this.answeredGoing === null || this.path === '') return;
      void this.standings_refresh().then((): void => {
        this.draw();
        if (this.answeredGoing !== null) this.answeredGoing_poll();
      });
    }, ANSWERED_POLL_MS);
  }

  /**
   * Follows the step whose task runs now with the session's own `wait`: its
   * log lands under the step as a RUN's would. Asked when a script opens and
   * by FOLLOW, never after a line ends, so a follow the operator stopped
   * stays stopped until they ask again.
   */
  protected running_follow(): void {
    const step: ScriptStep | undefined = runningStep_find(this.steps);
    if (step === undefined || step.running === null || step.running === ANSWERED_GOING || this.busy !== null) return;
    void this.line_send(`wait ${step.running}`, step.key);
  }

  /**
   * Reads the standing again a moment after a task-starting line was sent,
   * while it still holds the lane, so the seat wears the run.
   *
   * @param line - The line sent.
   */
  protected refresh_schedule(line: string): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout((): void => {
      this.refreshTimer = null;
      if (this.busy?.line === line) void this.standings_refresh();
    }, 3_000);
  }

  protected async library_read(): Promise<void> {
    const sources: LibrarySource[] = [];
    const scripts: LibraryScript[] = [];
    try {
      const top: Listed[] = listings_extract(await this.hooks.ask('ls /scripts'));
      const folders: string[] = [];
      for (const item of top[0]?.items ?? []) {
        if (item.type === 'source') sources.push({ name: item.name, repo: (item.title ?? '').split(' ')[0] ?? '', cloned: (item.status ?? '').startsWith('cloned'), head: /^cloned · at (.+)$/.exec(item.status ?? '')?.[1] ?? null });
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

  protected async limits_need(): Promise<void> {
    if (this.limitsAsked) return;
    this.limitsAsked = true;
    try {
      this.limits = model_extract(await this.hooks.ask('vm limits'), STRATUS_VM_LIMITS_MODEL_KIND, (data: unknown) => vmLimitsModelSchema.safeParse(data));
    } catch (error: unknown) {
      this.log_add(`vm limits: ${error instanceof Error ? error.message : String(error)}`, 'note');
    }
    this.draw();
  }

  /** Whose cost the header prices: the VMs the script declares (every VM before a script is open); a machine's own screen prices that machine. */
  protected costScope_get(): ReadonlyArray<string> | null {
    if (this.path === '') return null;
    return this.lines.map((line: ScriptLine) => line_parse(line.text)).filter((parts): boolean => parts.verb.join(' ') === 'vm new' && parts.subject !== null).map((parts): string => parts.subject as string);
  }

  /** What stands now: every declared VM's rate, from `vm cost` bare. */
  protected async standing_read(): Promise<void> {
    try {
      const model = model_extract(await this.hooks.ask('vm cost'), STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
      // What stands is what runs, priced from what the tenancy answered; what is declared is its own row (a-change-is-a-loop, clause 1).
      this.costRows = new Map((model?.vms ?? []).map((row: VmCostRow): [string, VmCostRow] => [row.name, row]));
      const scope: ReadonlyArray<string> | null = this.costScope_get();
      const rows: VmCostRow[] = (model?.vms ?? []).filter((row: VmCostRow): boolean => scope === null || scope.includes(row.name));
      const read: VmCostRow[] = rows.filter((row: VmCostRow): boolean => row.runs !== null && row.runs !== undefined);
      this.standing = read.length === 0 ? null : rates_sum(read.map((row: VmCostRow): VmCostRate | null => row.runs?.rate ?? null));
      this.standingAt = read.length === 0 ? null : read.map((row: VmCostRow): string => (row.runs as { at: string }).at).sort()[0] ?? null;
      this.declaredRate = model === null ? null : rates_sum(rows.map((row: VmCostRow): VmCostRate | null => row.cost));
    } catch {
      this.standing = null;
      this.standingAt = null;
      this.declaredRate = null;
    }
    this.header_draw();
  }

  /**
   * Prices the VM NEW line as it stands, a moment after the last lever moved.
   *
   * @param line - The `vm new` line.
   */
  protected stepCost_ask(line: string): void {
    if (this.costTimer !== null) clearTimeout(this.costTimer);
    this.costTimer = setTimeout((): void => {
      this.costTimer = null;
      this.costAsked += 1;
      const asked: number = this.costAsked;
      void this.hooks.ask(costLine_derive(line)).then((answer: QuietAnswer): void => {
        if (asked !== this.costAsked) return;
        const model = model_extract(answer, STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
        this.stepCost = model?.vms[0] ?? null;
        this.pricesRead = model?.pricesRead ?? this.pricesRead;
        this.stepCostRefused = model === null ? (plain_extract(answer.envelopes.map((envelope): string => envelope.renderedErr ?? '').join('')).trim() || 'the session answered no price') : null;
        this.cost_redraw();
        this.header_draw();
      }, (error: unknown): void => {
        if (asked !== this.costAsked) return;
        this.stepCost = null;
        this.stepCostRefused = error instanceof Error ? error.message : String(error);
        this.cost_redraw();
      });
    }, 100);
  }

  // ---------------------------------------------------------------- sending

  /**
   * Sends a line: shown in the log as typed, run by the host, the script's
   * standing read again after.
   *
   * @param line - The line.
   * @param step - The step it belongs to, whose body shows its output; null for a typed line.
   * @param keepLog - Whether the step's output so far stays (the second line of a seat sent as one).
   * @returns Whether the line ended with no error.
   */
  public async line_send(line: string, step: string | null, keepLog: boolean = false): Promise<boolean> {
    if (this.busy !== null) {
      this.log_add(`the lane is held by: ${this.busy.line} (STOP FOLLOWING frees it; the line goes on)`, 'note');
      return false;
    }
    this.busy = { line, step, since: Date.now() };
    this.busyOut = [];
    this.busyDeclined = false;
    const seat: string = step ?? this.view;
    // A line sent after a SAVE moves the seat on: SAVE's receipt is not what the seat now says.
    if (this.saved !== null && !line.startsWith('touch ')) this.saved = null;
    if (this.refusal?.view === seat) this.refusal = null;
    this.log_add(`stratus> ${line}`, 'sent');
    if (step !== null && !keepLog) this.stepLogs.set(step, []);
    if (step !== null) this.stepLogFrom.set(step, { line, at: new Date().toISOString() });
    this.draw();
    // The line's own kind, not its seat's: a seat that declares and builds starts a task only with its build.
    if (step !== null && stepKind_isTask(stepKind_derive(line)) && !line.startsWith('wait ')) this.refresh_schedule(line);
    let failed: boolean = false;
    try {
      failed = !(await this.hooks.run(line));
    } catch (error: unknown) {
      failed = true;
      const said: string = error instanceof Error ? error.message : String(error);
      this.log_add(said, 'note');
      // The session's own reason is the refusal's why, on the seat, not only in the log.
      this.busyOut.push(said);
    } finally {
      if (this.partial !== '') { this.log_add(this.partial, 'out'); this.partial = ''; }
      this.busy = null;
      // A refusal is said where its control stands, with why, and stays there until that seat sends again (a-change-is-a-loop, clauses 5 and 6).
      if (line === 'scripts pull') this.pulled = { at: new Date().toISOString(), said: this.busyOut.filter((one: string): boolean => one.trim() !== '').slice(-6) };
      if (failed || this.busyDeclined) this.refusal = { view: step ?? this.view, line, at: new Date().toISOString(), declined: this.busyDeclined, why: this.busyOut.filter((one: string): boolean => one.trim() !== '').slice(-2).join(' ') || 'the session refused it' };
      this.hooks.voice.cue(failed ? 'redalert' : 'ack');
      await this.standings_refresh();
      // A declaration sent moves what the price compares with: VM NEW's price is asked again of what now stands.
      const shown: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
      if (shown?.kind === 'vm new') this.stepCost_ask(shown.lines[0]?.text ?? '');
      this.draw();
      // A line run from the library (PULL, a touch into mine) may have changed what it lists.
      if (this.view === LIBRARY_VIEW) void this.library_read();
    }
    return !failed;
  }

  /**
   * BUILD on a seat that declares and builds: the declaration as the form
   * shows it, then the build, one after the other. A session that must be
   * raised for the build is raised first, so the password is asked before
   * anything is sent; a declaration the session refused builds nothing.
   *
   * @param declared - The `vm new` or `net new` line, as shown.
   * @param built - Its build line.
   * @param step - The seat.
   */
  protected async declaredBuild_send(declared: string, built: string, step: string): Promise<void> {
    if (this.hold_derive(built) === 'asks' && this.hooks.elevate_ask !== null) {
      const raised: boolean = await this.hooks.elevate_ask(built);
      if (!raised) return;
    }
    if (!(await this.line_send(declared, step))) return;
    if (await this.line_send(built, step, true)) this.builtHere = step;
    this.draw();
  }

  /** Writes the working copy under `/scripts/mine/`, as the editor saves: a line, echoed and run. */
  protected async save_send(): Promise<void> {
    const copy: string = workingCopy_derive(this.path);
    if (!(await this.line_send(saveLine_compose(copy, script_render(this.lines)), null))) return;
    this.saved = { path: copy, at: new Date().toISOString(), view: this.view };
    this.path = copy;
    this.edited = false;
    await this.script_read();
    this.draw();
    this.libraryRead = false;
  }

  // ---------------------------------------------------------------- drawing

  protected view_press(key: string): void {
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === key);
    this.hooks.voice.pill(key === LIBRARY_VIEW ? 'LIBRARY' : step?.label ?? key);
    this.view = key;
    if (key === LIBRARY_VIEW && !this.libraryRead) void this.library_read();
    if (step?.kind === 'vm new') { void this.limits_need(); this.stepCost_ask(step.lines[0]?.text ?? ''); }
    this.draw();
  }

  /** The stage strip's title: the script's name; a screen keyed by a machine names the machine. */
  protected stageTitle_get(): string {
    return this.path === '' ? 'THE LIBRARY' : scriptName_derive(this.path).toUpperCase();
  }

  protected draw(): void {
    this.rail_draw();
    this.header_draw();
    this.frame.view_mark(this.view);
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    this.frame.stageTitle.textContent = this.stageTitle_get();
    this.frame.stageNote.textContent = step === undefined ? (this.view === LIBRARY_VIEW ? 'SCRIPTS' : '') : `${step.label}${step.state === null ? '' : ` · ${step.state.toUpperCase()}`}`;
    this.body_draw();
    this.strip_draw();
    this.parts.promptLabel.textContent = this.path === '' ? 'stratus ›' : `stratus ${scriptName_derive(this.path)} ›`;
    this.parts.input.disabled = this.busy !== null;
    this.root.dataset['busy'] = this.busy === null ? 'no' : 'yes';
    document.title = this.title_get();
  }

  /** The rail: LIBRARY, then a seat per step wearing its state. */
  protected rail_draw(): void {
    const views: TakeoverView[] = [{ key: LIBRARY_VIEW, label: 'LIBRARY' }, ...this.steps.map((step: ScriptStep): TakeoverView => ({ key: step.key, label: step.label }))];
    const shown: string[] = [...this.frame.views.keys()];
    if (shown.length !== views.length || views.some((view: TakeoverView, index: number): boolean => shown[index] !== view.key)) this.frame.views_set(views);
    for (const step of this.steps) {
      const seat: HTMLButtonElement | undefined = this.frame.views.get(step.key);
      if (seat === undefined) continue;
      seat.dataset['state'] = step.state ?? 'none';
      // The seat runs when its task does, followed or not, and while a line of its own holds the lane.
      const running: boolean = step.running !== null || (this.busy !== null && this.busy.step === step.key);
      // A seat whose line's question stands reads ASKING, never its last standing.
      const asking: boolean = this.ask !== null && this.askLine !== null && step.lines.some((line: ScriptLine): boolean => line.text === this.askLine);
      seat.classList.toggle('ss-seat-running', running || asking);
      seat.querySelector('.ss-seat-mark')?.remove();
      const mark: HTMLElement = el('span', 'ss-seat-mark', asking ? '?' : running ? '▶' : step.state === null ? '' : STATE_MARKS[step.state]);
      mark.setAttribute('aria-label', asking ? 'asking' : running ? 'running' : step.state ?? '');
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

  protected header_draw(): void {
    const header: HTMLElement = this.parts.header;
    header.replaceChildren();
    const counts: StateCounts = states_count(this.lines);
    const runningStep: ScriptStep | undefined = runningStep_find(this.steps);
    const standingWord: string = this.path === '' ? 'LIBRARY' : this.ask !== null ? 'ASKING' : this.busy !== null || runningStep !== undefined ? 'RUNNING' : counts.changed > 0 ? 'CHANGED' : counts.notYet > 0 ? 'NOT YET' : counts.ready > 0 ? 'READY' : counts.total > 0 ? 'DONE' : 'READING';
    const condition: HTMLElement = el('section', 'tdc-head-condition');
    const pill: HTMLElement = el('div', 'tdc-condition');
    pill.dataset['condition'] = standingWord;
    pill.append(el('span', 'tdc-condition-label', 'THE SCRIPT'), el('span', 'tdc-condition-name', standingWord));
    const mode: HTMLElement | null = modePill_make(this.hooks.manage_is());
    condition.append(pill, ...(mode === null ? [] : [mode]), el('div', 'tdc-condition-why', this.path === '' ? `${this.scripts.length} SCRIPT${this.scripts.length === 1 ? '' : 'S'} · ${this.sources.length} SOURCE${this.sources.length === 1 ? '' : 'S'}` : counts_words(counts)));
    const chips: HTMLElement = el('div', 'tdc-chips');
    if (this.path !== '') chips.append(el('span', 'tdc-chip', this.edited ? 'EDITED · NOT SAVED' : scriptSource_derive(this.path) === 'mine' ? 'WORKING COPY' : 'FROM GIT · READ-ONLY'));
    condition.append(chips);
    header.append(condition);

    header.append(this.headSection_make('SCRIPT', this.path === '' ? [['LIBRARY', '/scripts'], ['MINE', '/scripts/mine']] : [['NAME', scriptName_derive(this.path)], ['SOURCE', scriptSource_derive(this.path) || '—'], ['PATH', this.path]]));
    header.append(this.costSection_make());
    header.append(this.runningSection_make());
    header.append(this.headSection_make('STANDING', [['DONE', String(counts.done)], ['READY', String(counts.ready)], ['CHANGED', String(counts.changed)], ['NOT YET', String(counts.notYet)]]));
  }

  /** The cost section: what stands now, and what the VM NEW step shown would add. */
  protected costSection_make(): HTMLElement {
    const standing: string = this.standingAt === null ? 'NOT READ FROM THE TENANCY' : this.standing === null ? 'NOT PRICED' : `${rate_words(this.standing, HOURS_PER_MONTH)} · READ ${this.standingAt.slice(11, 16)}`;
    const stepRate: VmCostRate | null = this.stepCost?.cost ?? null;
    const costRows: Array<[string, string]> = [['STANDS NOW', standing]];
    // What is declared, apart, when it is not what stands: declared, not built, it bills nothing yet.
    const declared: string = rate_words(this.declaredRate, HOURS_PER_MONTH);
    if (this.declaredRate !== null && declared !== rate_words(this.standing, HOURS_PER_MONTH)) costRows.push(['AS DECLARED', `${declared} · NOT WHAT RUNS`]);
    const stepShown: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (stepShown?.kind === 'vm new') costRows.push([this.stepCost?.declared === true ? 'THIS STEP' : 'WOULD ADD', stepRate === null ? '…' : rate_words(stepRate, HOURS_PER_MONTH)]);
    // Whose cost it is, named: the machine shown, the script's own machines, or every machine the tenancy runs.
    const scope: ReadonlyArray<string> | null = this.costScope_get();
    const whose: string = scope === null ? 'EVERY MACHINE' : scope.length === 0 ? 'NO MACHINE IN THIS SCRIPT' : scope.join(', ').toUpperCase();
    return this.headSection_make(`COST · LIST PRICE · ${whose}`, costRows, 0);
  }

  /** The running section: the line the lane holds, or the task running unfollowed, with STOP FOLLOWING or FOLLOW. */
  protected runningSection_make(): HTMLElement {
    const runningStep: ScriptStep | undefined = runningStep_find(this.steps);
    // The lane: the line it holds, or the task running unfollowed, which FOLLOW follows again; following is stopped, the task never.
    const running: Array<[string, string]> = this.busy !== null
      ? [['LINE', this.busy.line], ['FOR', duration_words(Date.now() - this.busy.since)]]
      // A question that stands with no line in this screen's lane (asked while the screen was away) is what runs: a line waiting on its answer.
      : this.ask !== null ? [['LINE', 'waiting on the question above'], ['FOR', 'until it is answered']]
      : runningStep !== undefined && runningStep.running === ANSWERED_GOING
        ? [['LINE', `${this.answeredGoing?.line ?? runningStep.lines[0]?.text ?? ''}: answered yes, the act goes on`], ['FOR', 'its task is read as it starts']]
      : runningStep !== undefined
        ? [['TASK', runningStep.running ?? ''], ['FOR', 'not followed']]
        : [['LINE', 'nothing'], ['FOR', '—']];
    const lanePills: HTMLElement[] = [];
    // While a question stands, the strip's STOP is the answer; the follow's stop waits for the line to go on.
    if (this.busy !== null && this.ask === null && this.following_is()) {
      const stop: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'STOP FOLLOWING');
      stop.type = 'button';
      stop.title = 'Ctrl-C at the console: the lane is freed, the task goes on';
      stop.addEventListener('click', (): void => { this.hooks.voice.pill('STOP FOLLOWING'); this.log_add('^C (stops following, not the task)', 'note'); this.hooks.stop(); });
      lanePills.push(stop);
    } else if (this.busy === null && runningStep !== undefined && runningStep.running !== null && runningStep.running !== ANSWERED_GOING) {
      const path: string = runningStep.running;
      const follow: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', 'FOLLOW');
      follow.type = 'button';
      follow.title = `sends: wait ${path}`;
      follow.addEventListener('click', (): void => { this.hooks.voice.pill('FOLLOW'); this.running_follow(); });
      lanePills.push(follow);
    }
    return this.headSection_make('RUNNING', running, -1, lanePills);
  }

  protected headSection_make(title: string, rows: ReadonlyArray<[string, string]>, billingRow: number = -1, pills: ReadonlyArray<HTMLElement> = []): HTMLElement {
    const section: HTMLElement = el('section', 'tdc-head-section');
    section.setAttribute('aria-label', title);
    section.append(el('span', 'tdc-head-title', title));
    const grid: HTMLElement = el('div', 'tdc-head-grid');
    rows.forEach(([label, value]: [string, string], index: number): void => {
      grid.append(el('span', `tdc-head-label${index === billingRow ? ' tdc-head-label-bill' : ''}`, label), el('span', 'tdc-head-value', value));
    });
    section.append(grid);
    if (pills.length > 0) {
      const commands: HTMLElement = el('div', 'tdc-commands ss-head-commands');
      commands.append(...pills);
      section.append(commands);
    }
    return section;
  }

  protected body_draw(): void {
    const body: HTMLElement = this.parts.body;
    body.replaceChildren();
    if (this.view === LIBRARY_VIEW) {
      body.dataset['view'] = 'library';
      body.append(...this.library_make());
      this.refusal_place();
      this.saved_place();
      this.errand_place();
      return;
    }
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (step === undefined) {
      body.dataset['view'] = 'library';
      body.append(this.empty_make('NO STEP', 'Open a script from the LIBRARY; its lines become the rail.'));
      this.errand_place();
      return;
    }
    body.dataset['view'] = 'step';
    body.append(...this.step_make(step));
    const log: HTMLElement | null = body.querySelector('.tdc-steplog');
    if (log !== null) log.scrollTop = log.scrollHeight;
    this.refusal_place();
    this.saved_place();
    this.draft_place();
    this.errand_place();
  }

  /** The edits kept from before the screen was left, said on every seat while they stand unsaved. */
  protected draft_place(): void {
    const kept = this.draftRestored;
    if (kept === null || !this.edited) return;
    const note: HTMLElement = el('div', 'tdc-note tdc-note-bill ss-note-draft');
    note.append(el('span', 'tdc-note-title', `UNSAVED EDITS KEPT · ${kept.at.slice(11, 16)}`), el('span', 'tdc-prose', `The ${kept.edits === 1 ? 'edit' : `${kept.edits} edits`} you left with ${kept.edits === 1 ? 'stands' : 'stand'} again, not saved: SAVE writes ${kept.edits === 1 ? 'it' : 'them'} to ${workingCopy_derive(this.path)}; nothing was built or billed.${kept.moved ? ' The script changed on the host since you left: the edits are laid over what you left, not over its new text; SAVE writes them as shown.' : ''}`));
    const first: Element | null = this.parts.body.querySelector('section');
    if (first === null) this.parts.body.prepend(note);
    else first.insertBefore(note, first.children[1] ?? null);
  }

  /** SAVE's receipt on whichever seat it was pressed from: the copy written, where and when, until the next edit. */
  protected saved_place(): void {
    if (this.edited || this.saved === null || this.saved.path !== this.path || this.saved.view !== this.view) return;
    const note: HTMLElement = el('div', 'tdc-note tdc-note-found ss-note-saved');
    note.append(el('span', 'tdc-note-title', `SAVED · ${this.saved.at.slice(11, 16)}`), el('span', 'tdc-prose', `${this.saved.path}: this host's working copy, opened from there; nothing was built or billed.`));
    const first: Element | null = this.parts.body.querySelector('section');
    if (first === null) this.parts.body.prepend(note);
    else first.insertBefore(note, first.children[1] ?? null);
  }

  /** The last refusal, on the seat it was pressed on: at the head of the seat's first section, beside what it refused. */
  protected refusal_place(): void {
    const refused = this.refusal;
    if (refused === null || refused.view !== this.view) return;
    const note: HTMLElement = el('div', 'tdc-note tdc-note-refused ss-note-refusal');
    if (refused.declined) {
      note.className = 'tdc-note tdc-note-found ss-note-refusal';
      note.append(el('span', 'tdc-note-title', `DECLINED · ${refused.at.slice(11, 16)}`), el('span', 'tdc-prose', 'You answered no: the line stopped at its question, and nothing it asked about was made or changed.'), el('span', 'tdc-prose tdc-quiet', refused.line));
    } else {
      note.append(el('span', 'tdc-note-title', `REFUSED · ${refused.at.slice(11, 16)}`), el('span', 'tdc-prose', refused.why), el('span', 'tdc-prose tdc-quiet', `${refused.line}: nothing it would have changed was changed`));
    }
    const first: Element | null = this.parts.body.querySelector('section');
    if (first === null) this.parts.body.prepend(note);
    else first.insertBefore(note, first.children[1] ?? null);
  }

  /** A hidden word asked stands as an errand bar across the top of the body, whichever view shows; the strip is for words seen. */
  protected errand_place(): void {
    if (this.ask === null || this.ask.kind !== 'secret') return;
    this.parts.body.prepend(this.errand_make(this.ask));
  }

  /**
   * The errand's own bar, as a `path` ask borrows it beside a pane: the
   * question as its caption, one field, the verb that commits. The field is
   * hidden and emptied as it is read; the step never shows or keeps the word.
   *
   * @param ask - The hidden word asked.
   * @returns The bar.
   */
  protected errand_make(ask: OpenAsk): HTMLElement {
    const bar: HTMLElement = el('div', 'errand-bar ss-errand');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'A hidden word is asked');
    const caption: HTMLElement = el('span', 'errand-caption', ask.message.trim());
    const field: HTMLInputElement = el('input', 'errand-path ss-errand-input');
    field.id = 'ss-errand-input';
    field.type = 'password';
    field.autocomplete = 'new-password';
    field.spellcheck = false;
    field.setAttribute('aria-label', 'The hidden word');
    const commit: HTMLButtonElement = el('button', 'pacs-capsule errand-commit', 'SEND');
    commit.type = 'button';
    const stop: HTMLButtonElement = el('button', 'pacs-capsule ss-errand-stop', 'STOP');
    stop.type = 'button';
    const answer = (): void => {
      const value: string = field.value;
      field.value = '';
      this.hooks.voice.pill('SEND');
      this.log_add('(hidden)', 'answer');
      ask.answer(value);
    };
    commit.addEventListener('click', answer);
    field.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Enter') answer(); });
    stop.addEventListener('click', (): void => { field.value = ''; this.hooks.voice.pill('STOP'); this.log_add('(declined)', 'answer'); ask.answer(''); });
    bar.append(caption, field, commit, stop);
    queueMicrotask((): void => field.focus());
    return bar;
  }

  protected empty_make(title: string, text: string): HTMLElement {
    const box: HTMLElement = el('section', 'tdc-empty');
    box.append(el('span', 'tdc-section-title', title), el('p', 'tdc-prose', text));
    return box;
  }

  protected section_make(title: string, className: string = '', aside?: string): HTMLElement {
    const section: HTMLElement = el('section', `tdc-section ${className}`.trim());
    section.setAttribute('aria-label', title);
    const head: HTMLElement = el('div', 'tdc-section-head');
    head.append(el('span', 'tdc-section-title', title));
    if (aside !== undefined) head.append(el('span', 'tdc-section-aside', aside));
    section.append(head);
    return section;
  }

  protected pairs_make(rows: ReadonlyArray<[string, string]>): HTMLElement {
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
  protected linePill_make(label: string, line: string, step: string | null, tone: 'plain' | 'bill' | 'destroy' | 'quiet' = 'plain'): HTMLButtonElement {
    // A line that would act, in a READ session: asked for the password first when the session can be raised, held when it cannot.
    const hold: ReadHold = this.hold_derive(line);
    const pill: HTMLButtonElement = el('button', `tdc-pill tdc-pill-${tone}${hold === 'asks' ? ' tdc-pill-asks' : ''}`, hold === 'held' ? `${label} · REFUSED` : label);
    pill.type = 'button';
    pill.title = hold === 'held' ? `refused: ${READ_HELD}` : hold === 'asks' ? `${READ_ASKS}: ${line}` : `sends: ${line}`;
    pill.disabled = hold === 'held' || this.acting_is();
    pill.addEventListener('click', (): void => { this.hooks.voice.pill(label); void this.line_sendRaised(line, step); });
    return pill;
  }

  /** How a line that would act is drawn in this session: asked, held, or standing. */
  protected hold_derive(line: string): ReadHold {
    return readHold_derive(line, this.hooks.manage_is(), this.hooks.elevate_ask !== null);
  }

  /**
   * Sends a line, raising a READ session first when the line would act: the
   * password asked once, and the line sent only once the session is MANAGE.
   *
   * @param line - The line.
   * @param step - The step whose body shows the output.
   */
  protected async line_sendRaised(line: string, step: string | null): Promise<void> {
    if (this.hold_derive(line) === 'asks' && this.hooks.elevate_ask !== null) {
      const raised: boolean = await this.hooks.elevate_ask(line);
      if (!raised) return;
    }
    await this.line_send(line, step);
  }

  // ---------------------------------------------------------------- library

  protected library_make(): HTMLElement[] {
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
      const rows: Array<[string, string]> = this.sources.map((source: LibrarySource): [string, string] => [source.name.toUpperCase(), `${source.repo}${!source.cloned ? ' · NOT CLONED' : source.head !== null ? ` · AT ${source.head}` : ''}`]);
      sources.append(this.pairs_make(rows));
    }
    const commands: HTMLElement = el('div', 'tdc-commands');
    // loop: ss-pull
    commands.append(this.linePill_make('PULL', 'scripts pull', null, 'quiet'), el('span', 'tdc-commands-label', 'FAST-FORWARD EVERY CLONE · THIS HOST\'S CLONES ONLY; NOTHING IN THE CLOUD CHANGES'));
    // What the last PULL did, with when: its receipt, here beside PULL (a-change-is-a-loop, clause 5).
    if (this.pulled !== null) sources.append(this.pairs_make([[`PULLED · ${this.pulled.at.slice(11, 16)}`, this.pulled.said.length === 0 ? 'nothing said' : this.pulled.said.join(' · ')]]));
    sources.append(commands);
    sources.append(el('p', 'tdc-prose tdc-quiet', 'MINE holds this host\'s working copies, written by SAVE on a step.'));
    return [scripts, sources];
  }

  // ---------------------------------------------------------------- steps

  protected step_make(step: ScriptStep): HTMLElement[] {
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
    const vm: string = line_parse(step.lines[0]?.text ?? '').subject ?? '';
    const chris: ChrisStatusRow | null = step.kind === 'chris deploy' ? this.chrisRow_get(vm) : step.kind === 'users' ? this.chrisRow_get(this.usersVm_get(step)) : null;
    const side: HTMLElement = step.kind === 'vm new' ? this.cost_make(step)
      : step.kind === 'net new' || step.kind === 'net build' ? this.netSide_make(step, vm)
      : step.kind === 'chris deploy' && chris !== null ? this.chrisSide_make(step, chris)
        : step.kind === 'chris deploy' && this.chrisAbsent_read(vm) !== null ? this.chrisFirstSide_make(step, vm, this.chrisAbsent_read(vm) as { at: string | null })
        : step.kind === 'users' && chris !== null ? this.usersSide_make(step, chris) : this.state_make(step);
    const log: HTMLElement = this.stepLog_make(step);
    return [form, side, log];
  }

  /** The line as it will run, and its state. */
  protected lineBox_make(line: ScriptLine): HTMLElement {
    // A line whose task runs, or the line in the lane, is RUNNING: its last standing waits for the run to end.
    const running: boolean = line.running !== null || this.busy?.line === line.text;
    const asking: boolean = this.ask !== null && this.askLine === line.text;
    // A line edited since its standing was read: its old standing is not its own; said as such.
    const edited: boolean = this.stoodFor.has(line.number) && this.stoodFor.get(line.number) !== line.text;
    const box: HTMLElement = el('div', `ss-line ss-line-${asking ? 'asking' : running ? 'running' : (line.state ?? 'none').replace(' ', '-')}`);
    box.append(el('span', 'ss-line-state', asking ? '? ASKING · ITS QUESTION STANDS ABOVE' : running ? '▶ RUNNING' : edited ? '~ EDITED · NOT DECLARED (BUILD declares and builds it)' : line.state === null ? '—' : `${STATE_MARKS[line.state]} ${line.state.toUpperCase()}`), el('code', 'tdc-mono ss-line-text', line.text));
    // An edited line's standing was read for its text before the edit: never said under it (it would read unchanged).
    if (line.detail !== '' && !edited) box.append(el('span', 'tdc-prose tdc-quiet ss-line-detail', line.detail));
    return box;
  }

  /** The step's state and what it says, as a side column. */
  protected state_make(step: ScriptStep): HTMLElement {
    const side: HTMLElement = this.section_make('WHERE IT STANDS', 'ss-col-side');
    const words: Readonly<Record<LineState, string>> = {
      'not yet': 'What this line stands on is not built yet: the step before it runs first.',
      ready: 'The line may run. Nothing it needs is missing.',
      done: 'The line has run and would replay to unchanged or nothing to do.',
      changed: 'An earlier line changed under it: replaying it plans, prices and asks before anything is made.',
    };
    const declares: boolean = step.kind === 'net new' || step.kind === 'vm new';
    side.append(el('p', 'tdc-prose', step.state === null ? 'No verb reads this line\'s state; it runs when sent.'
      : declares && step.state === 'changed' ? 'This line differs from what is declared: DECLARE declares it as shown, and the build plans and asks before anything is made.' : words[step.state]));
    if (step.lines.length === 1 && (step.lines[0]?.detail ?? '') !== '') side.append(this.pairs_make([['SAID', step.lines[0]?.detail ?? '']]));
    const running: HTMLElement | null = this.runningNote_make(step);
    if (running !== null) side.append(running);
    if (this.edited && this.saveOffered()) {
      const note: HTMLElement = el('div', 'tdc-note tdc-note-bill');
      note.append(el('span', 'tdc-note-title', 'EDITED · NOT SAVED'), el('span', 'tdc-prose', `A form changed a line. Its pills send the line as shown; SAVE writes the whole script to ${workingCopy_derive(this.path)} (this host's copy; it builds and bills nothing) and opens it from there.`));
      // What changed, line by line, against the copy as it was read: the offer as a difference (a-change-is-a-loop, clause 2).
      const before: string[] = this.readText.split('\n').filter((line: string): boolean => line.trim() !== '' && !line.trim().startsWith('#'));
      const changed: Array<[string, string]> = this.lines.map((line: ScriptLine, index: number): [string, string] => [before[index] ?? '', line.text]).filter(([was, now]): boolean => was !== now).slice(0, 4);
      for (const [was, now] of changed) note.append(el('span', 'tdc-mono ss-edit-was', `− ${was === '' ? '(no line)' : was}`), el('span', 'tdc-mono ss-edit-now', `+ ${now}`));
      // loop: ss-save
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

  /** The note a step whose task runs now wears, or null. */
  protected runningNote_make(step: ScriptStep): HTMLElement | null {
    if (step.running === null) return null;
    const note: HTMLElement = el('div', 'tdc-note ss-note-running');
    note.append(el('span', 'tdc-note-title', 'RUNNING NOW'), this.pairs_make([['TASK', step.running]]), el('span', 'tdc-prose', 'The line runs as a task of the session: LEAVE and STOP FOLLOWING free the lane and the task goes on; the screen follows it again when the script opens, and FOLLOW in the header follows it now.'));
    return note;
  }

  protected stepLog_make(step: ScriptStep): HTMLElement {
    // What printed is dated with the line that printed it: an old answer never reads as what stands now.
    const from = this.stepLogFrom.get(step.key);
    const subtitle: string | undefined = this.busy?.step === step.key ? this.busy.line : from !== undefined ? `${from.line} · AT ${from.at.slice(11, 16)}` : undefined;
    const box: HTMLElement = this.section_make('THE STEP\'S OUTPUT', 'tdc-col-steplog', subtitle);
    const lines: HTMLElement = el('div', 'tdc-steplog');
    const shown: string[] = (this.stepLogs.get(step.key) ?? []).slice(-80);
    if (shown.length === 0) lines.append(el('span', 'tdc-quiet', step.running !== null ? `its task runs (${step.running}): what it prints lands here as FOLLOW in the header follows it` : 'what the line prints lands here when RUN sends it'));
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
  protected optionField_make(line: ScriptLine, word: string, label: string, placeholder: string): HTMLElement {
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
      // The seat is drawn again at each edit, so SAVE and the difference against what stands follow the hand; the field keeps it.
      const at: number | null = input.selectionStart;
      this.draw();
      const again: HTMLInputElement | null = this.parts.body.querySelector<HTMLInputElement>(`#${input.id}`);
      again?.focus();
      if (at !== null) again?.setSelectionRange(at, at);
    });
    row.append(field, input);
    return row;
  }

  /** Redraws the line's box and the header after an edit, without losing the field's focus. */
  protected lineShown_redraw(line: ScriptLine): void {
    const text: HTMLElement | null = this.parts.body.querySelector(`.ss-line[data-line='${line.number}'] .ss-line-text`);
    if (text !== null) text.textContent = line.text;
    const run: HTMLButtonElement | null = this.parts.body.querySelector(`.ss-run[data-line='${line.number}']`);
    if (run !== null) run.title = `sends: ${line.text}`;
    const build: HTMLButtonElement | null = this.parts.body.querySelector(`.ss-build[data-line='${line.number}']`);
    if (build !== null) build.title = `sends: ${line.text}, then ${build.dataset['build'] ?? ''}`;
    this.header_draw();
  }

  protected runRow_make(step: ScriptStep, line: ScriptLine, tone: 'plain' | 'bill' = 'plain', extra: HTMLElement[] = [], word: string = 'RUN'): HTMLElement {
    const commands: HTMLElement = el('div', 'tdc-commands');
    // The line is read when pressed, so an edit after the pill was drawn is what runs.
    const hold: ReadHold = this.hold_derive(line.text);
    const run: HTMLButtonElement = el('button', `tdc-pill tdc-pill-${tone} ss-run${hold === 'asks' ? ' tdc-pill-asks' : ''}`, hold === 'held' ? `${word} · REFUSED` : word);
    run.type = 'button';
    run.dataset['line'] = String(line.number);
    run.title = hold === 'held' ? `refused: ${READ_HELD}` : hold === 'asks' ? `${READ_ASKS}: ${line.text}` : `sends: ${line.text}`;
    run.disabled = hold === 'held' || this.acting_is();
    run.addEventListener('click', (): void => { this.hooks.voice.pill(word); void this.line_sendRaised(line.text, step.key); });
    commands.append(run, ...extra);
    return commands;
  }

  /**
   * A declaring seat's pills: DECLARE sends the declaration alone, which
   * builds nothing; BUILD, in the billing tone, sends it and then its build,
   * whose plan, cost and question come before anything bills. Without a
   * build line under the seat, DECLARE alone.
   *
   * @param step - The seat.
   * @param declared - The declaration.
   * @param built - Its build line, or undefined.
   * @param extra - What stands after the pills (a teardown).
   * @returns The row.
   */
  protected declareRow_make(step: ScriptStep, declared: ScriptLine, built: ScriptLine | undefined, extra: HTMLElement[] = []): HTMLElement {
    // DECLARE writes a record only: its own quiet row, saying so, never beside the commit (the operator, 2026-11-05).
    const recordRow = (): HTMLElement => {
      // loop: ss-net-declare, ss-vm-declare
      const row: HTMLElement = this.runRow_make(step, declared, 'plain', [], 'DECLARE');
      row.classList.add('ss-record-only');
      row.prepend(el('span', 'tdc-commands-label', 'RECORD ONLY'));
      row.append(el('span', 'tdc-prose tdc-quiet', `writes the declaration; builds and bills nothing${built !== undefined ? ': BUILD asks before it does' : ''}`));
      return row;
    };
    if (built === undefined) {
      const row: HTMLElement = recordRow();
      row.append(...extra);
      return row;
    }
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(el('span', 'tdc-commands-label', 'THE COMMIT'));
    const hold: ReadHold = this.hold_derive(built.text);
    // loop: ss-net-build, ss-vm-build, vm-size-build
    const build: HTMLButtonElement = el('button', `tdc-pill tdc-pill-bill ss-build${hold === 'asks' ? ' tdc-pill-asks' : ''}`, hold === 'held' ? 'BUILD · REFUSED' : 'BUILD');
    build.type = 'button';
    build.dataset['line'] = String(declared.number);
    build.dataset['build'] = built.text;
    build.title = hold === 'held' ? `refused: ${READ_HELD}` : `sends: ${declared.text}, then ${built.text}${hold === 'asks' ? ` (${READ_ASKS})` : ''}`;
    build.disabled = hold === 'held' || this.acting_is();
    build.addEventListener('click', (): void => { this.hooks.voice.pill('BUILD'); void this.declaredBuild_send(declared.text, built.text, step.key); });
    commands.append(build, ...extra);
    if (!this.declareOffered()) return commands;
    const both: HTMLElement = el('div', 'ss-commit-rows');
    both.append(commands, recordRow());
    return both;
  }

  protected lineBoxNumbered_make(line: ScriptLine): HTMLElement {
    const box: HTMLElement = this.lineBox_make(line);
    box.dataset['line'] = String(line.number);
    return box;
  }

  protected netNew_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const built: ScriptLine | undefined = stepBuildLine_get(step);
    const parts = line_parse(line.text);
    const name: string = parts.subject ?? '';
    const extra: HTMLElement[] = [];
    if (built !== undefined) {
      // loop: ss-net-teardown
      const teardown: HTMLButtonElement = this.linePill_make('TEARDOWN', `net teardown ${name}`, step.key, 'destroy');
      teardown.title = `sends: net teardown ${name} (refused while anything stands on it)`;
      // Nothing of it built (as net status last read it): there is nothing to tear down, so the pill is held and says why.
      const row: NetStatusRow | null = this.nets.get(name)?.row ?? null;
      // VMs whose data or machine still stand on it, as `vm status` read them: the engine refuses while they do, so the pill says so first.
      const standing: string[] = [...this.vmsSeen.values()].filter((vm: VmStatusRow): boolean => vm.spec?.net === name && vm.state !== 'gone').map((vm: VmStatusRow): string => vm.name);
      if (this.nets.has(name) && (row === null || (row.state !== 'built' && row.stack === null))) {
        teardown.disabled = true;
        teardown.textContent = 'TEARDOWN · NOTHING BUILT';
        teardown.title = 'nothing of this network is built: there is nothing to tear down';
      } else if (standing.length > 0) {
        teardown.disabled = true;
        teardown.textContent = 'TEARDOWN · REFUSED';
        teardown.title = `${standing.join(', ')} still stand${standing.length === 1 ? 's' : ''} on it: TEARDOWN · ALL on ${standing.length === 1 ? 'its' : 'their'} VM NEW seat first`;
      }
      extra.push(el('span', 'tdc-flex'), teardown);
      // What TEARDOWN removes, beside it; and, refused, why, beside it too (never beside BUILD).
      const why: string = standing.length > 0 ? `refused while ${standing.join(', ')} stand${standing.length === 1 ? 's' : ''} on it: TEARDOWN · ALL on ${standing.length === 1 ? 'its' : 'their'} VM NEW seat first. ` : '';
      extra.push(el('span', 'tdc-prose tdc-quiet ss-teardown-says', `${why}TEARDOWN removes its gateway, subnet and bastion, then its compartment, asking the name typed back; nothing a network is made of bills.`));
    }
    return [
      this.lineBoxNumbered_make(line),
      ...(built === undefined ? [] : [this.lineBoxNumbered_make(built)]),
      // loop: ss-net-declare, ss-net-build
      this.declareRow_make(step, line, built, extra),
      this.pairs_make([['NETWORK', name || '—'], ['ON OCI', 'a compartment of that name, its VCN, subnet, gateway, route and bastion']]),
      this.optionField_make(line, '--cidr', 'CIDR', '10.20.0.0/16'),
      el('p', 'tdc-prose tdc-quiet', built === undefined
        ? 'DECLARE declares the network; nothing is built. The same values replay to unchanged.'
        : 'DECLARE declares the network and builds nothing. BUILD declares it and builds it: the plan comes first and asks before the apply; a second build reads nothing to do. The bastion admits this host\'s address alone.'),
    ];
  }

  protected netBuild_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const name: string = line_parse(line.text).subject ?? '';
    // loop: ss-net-teardown
    const teardown: HTMLButtonElement = this.linePill_make('TEARDOWN', `net teardown ${name}`, step.key, 'destroy');
    teardown.title = `sends: net teardown ${name} (refused while anything stands on it)`;
    return [
      this.lineBoxNumbered_make(line),
      // loop: ss-net-build
      this.runRow_make(step, line, 'bill', [el('span', 'tdc-flex'), teardown]),
      this.pairs_make([['NETWORK', name], ['BUILDS', 'the compartment, VCN, subnet, gateway, route, security list and bastion; asks before the apply']]),
      el('p', 'tdc-prose tdc-quiet', 'A build plans first and asks; a second build reads nothing to do. The bastion admits this host\'s address alone.'),
    ];
  }

  protected vmNew_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const built: ScriptLine | undefined = stepBuildLine_get(step);
    const name: string = line_parse(line.text).subject ?? '';
    // The levers first, so the offer opens in view; the commit right under them; the lines as they will run after.
    const nodes: HTMLElement[] = [];
    if (this.limits === null) {
      nodes.push(el('p', 'tdc-prose tdc-quiet', 'reading what the shape sells: vm limits'));
    } else {
      const limits: VmLimitsModel = this.limits;
      const group: HTMLElement = el('div', 'tdc-lever-group');
      const runs = this.runs_get(name);
      group.append(el('span', 'tdc-section-title', `SIZE · ${limits.shape}${runs === null ? '' : ` · RUNS AS READ FROM THE TENANCY ${runs.at.slice(11, 16)} UTC`}`));
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
      if (runs?.backup !== undefined && runs.backup !== null) backup.append(el('span', 'ss-field-runs', `RUNS ${runs.backup.toUpperCase()}`));
      nodes.push(backup);
    }
    // loop: ss-vm-declare, ss-vm-build, vm-size-build
    nodes.push(this.declareRow_make(step, line, built));
    nodes.push(this.lineBoxNumbered_make(line), ...(built === undefined ? [] : [this.lineBoxNumbered_make(built)]), this.pairs_make([['VM', name], ['NETWORK', lineOption_get(line.text, '--net') ?? '—']]));
    // What runs beside each field, read from the tenancy, so a change typed is seen against it (a-change-is-a-loop, clause 1).
    const standing = this.runs_get(name);
    const ports: HTMLElement = this.optionField_make(line, '--open', 'OPEN PORTS', '80,443');
    if (standing?.open !== undefined && standing.open !== null) ports.append(el('span', 'ss-field-runs', `RUNS ${ports_word(standing.open).toUpperCase()}`));
    const os: HTMLElement = this.optionField_make(line, '--os', 'OS', 'ubuntu-26.04');
    if (standing?.os !== undefined && standing.os !== null) os.append(el('span', 'ss-field-runs', `RUNS ${standing.os.toUpperCase()}`));
    nodes.push(ports, os);
    nodes.push(el('p', 'tdc-prose tdc-quiet', built === undefined
      ? 'DECLARE declares the VM; nothing is built. On a built VM a changed size is planned and asked by its build line; a smaller data volume is refused unless named.'
      : this.declareOffered()
        ? 'DECLARE saves the size and builds nothing. BUILD declares it and builds it: on a built VM the change is planned, priced and asked before anything bills, and a reboot is said first; a smaller data volume is refused unless named.'
        : 'BUILD declares the size and builds it: the change is planned, priced and asked in place before anything bills, and what runs is read back after.'));
    if (built !== undefined) nodes.push(this.vmBuilds_make(name), ...this.vmUndoing_make(name, step.key));
    return nodes;
  }


  protected slider_make(line: ScriptLine, spec: SliderSpec, limits: VmLimitsModel): HTMLElement {
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
    // What runs of this lever, read from the tenancy, beside the offer: the slider moves from it, never from the declaration alone.
    const key = ({ '--vcpu': 'vcpu', '--memory': 'memory', '--disk': 'disk', '--data': 'data' } as const)[spec.word as '--vcpu' | '--memory' | '--disk' | '--data'];
    const runs: number | null = key === undefined ? null : this.runs_get(line_parse(line.text).subject ?? '')?.[key] ?? null;
    const runsMark: HTMLElement | null = runs === null ? null : el('span', 'ss-slider-runs', `RUNS ${runs}${spec.unit === '' ? '' : ` ${spec.unit}`}`);
    const runsMark_redraw = (): void => { runsMark?.classList.toggle('ss-slider-differs', runs !== null && Number(input.value) !== runs); };
    runsMark_redraw();
    input.addEventListener('input', (): void => {
      line.text = lineOption_set(line.text, spec.word, input.value);
      this.edited = true;
      shown.textContent = `${input.value}${spec.unit === '' ? '' : ` ${spec.unit}`}`;
      runsMark_redraw();
      this.lineShown_redraw(line);
      this.wouldNote_redraw(line);
      this.stepCostRefused = null;
      this.stepCost_ask(line.text);
    });
    // The vCPUs bound the memory: a change redraws the memory's ends.
    if (spec.word === '--vcpu') input.addEventListener('change', (): void => this.draw());
    const track: HTMLElement = el('div', 'tdc-slider-track');
    const ends: HTMLElement = el('div', 'tdc-slider-ends');
    ends.append(el('span', '', String(min)), el('span', 'tdc-slider-note', spec.word === '--memory' && limits.memory.perVcpu !== null ? `${limits.memory.perVcpu.min} TO ${limits.memory.perVcpu.max} GiB PER vCPU` : spec.word === '--data' ? 'KEPT BY A TEARDOWN' : ''), el('span', '', String(max)));
    track.append(input, ends);
    row.append(label, track, shown, ...(runsMark === null ? [] : [runsMark]));
    return row;
  }

  /** VM NEW's side column: the price as the levers stand. */
  protected cost_make(step: ScriptStep): HTMLElement {
    const side: HTMLElement = this.section_make('COST · AS SIZED', 'ss-col-side tdc-col-cost', 'FROM THE PRICE LIST · vm cost');
    const box: HTMLElement = el('div', 'ss-cost');
    // What the seat owes comes first, above the price, where the eye lands after a DECLARE.
    const running: HTMLElement | null = this.runningNote_make(step);
    const runs = this.runs_get(line_parse(step.lines[0]?.text ?? '').subject ?? '');
    const declared: HTMLElement | null = running !== null ? null : runs !== null ? this.wouldNote_make(step) : this.declaredNote_make(step);
    if (running !== null) side.append(running);
    if (declared !== null) side.append(declared);
    side.append(box);
    this.cost_fill(box, step);
    if (this.edited) side.append(this.state_make(step).querySelector('.tdc-note') ?? el('span', ''));
    return side;
  }

  /**
   * What BUILD would do, as the levers stand, against what runs (read from
   * the tenancy): each change and its consequence (a reboot, an online grow,
   * a refusal), or, once a build here left what runs equal to the offer, the
   * receipt read back. The note is the offer's options and the commit's
   * receipt in one place (a-change-is-a-loop, clauses 2 and 5).
   *
   * @param step - The seat.
   * @returns The note.
   */
  protected wouldNote_make(step: ScriptStep): HTMLElement | null {
    const line: ScriptLine | undefined = step.lines[0];
    const runs = this.runs_get(line_parse(line?.text ?? '').subject ?? '');
    if (line === undefined || runs === null) return null;
    const would: BuildWould[] = buildWould_derive(vmLevers_read(line.text), runs);
    const read: string = `read from the tenancy ${runs.at.slice(11, 16)} UTC`;
    const note: HTMLElement = el('div', `tdc-note ss-note-would${would.length === 0 ? '' : would.some((one: BuildWould): boolean => one.tone === 'refused') ? ' tdc-note-refused' : ' tdc-note-bill'}`);
    if (would.length === 0) {
      note.append(el('span', 'tdc-note-title', this.builtHere === step.key ? 'BUILT · WHAT RUNS IS WHAT WAS OFFERED' : 'WHAT RUNS IS WHAT IS OFFERED'), el('span', 'tdc-prose tdc-quiet', `${read}; BUILD has nothing to change`));
      return note;
    }
    note.append(el('span', 'tdc-note-title', 'BUILD WOULD'));
    for (const one of would) note.append(el('span', `tdc-prose ss-would-${one.tone}`, `${one.change}: ${one.consequence}`));
    const declaredHere: boolean = this.declaredHere_is(step);
    note.append(el('span', 'tdc-prose tdc-quiet', `against what runs, ${read}${declaredHere ? '; this size is declared on this host only until a MANAGE session keeps it' : ''}. BUILD plans it, says the cost and asks here before anything bills.`));
    return note;
  }

  /** Whether an edit is offered SAVE apart (the script screen); a screen whose commit writes the script first offers none. */
  protected saveOffered(): boolean {
    return true;
  }

  /** Whether the seat's declaration is held by this host alone (the VM controller reads it from the row); false where nothing says. */
  protected declaredHere_is(_step: ScriptStep): boolean {
    return false;
  }

  /** Redraws BUILD WOULD as a lever moves, without redrawing the levers under the hand. */
  protected wouldNote_redraw(line: ScriptLine): void {
    const now: HTMLElement | null = this.parts.body.querySelector('.ss-note-would');
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.lines[0] === line);
    if (now === null || step === undefined) return;
    const fresh: HTMLElement | null = this.wouldNote_make(step);
    if (fresh !== null) now.replaceWith(fresh);
  }

  /**
   * The note a declaration not built yet wears, beside its price: what was
   * declared and what a build would change, and that BUILD does it. Only on
   * a seat that holds the build, and only while the build has something to
   * do: a declaration builds nothing, and the screen says so where the
   * operator is looking.
   *
   * @param step - The seat.
   * @returns The note, or null.
   */
  protected declaredNote_make(step: ScriptStep): HTMLElement | null {
    const built: ScriptLine | undefined = stepBuildLine_get(step);
    if (built === undefined || step.lines[0]?.state !== 'done' || (built.state !== 'changed' && built.state !== 'ready')) return null;
    const note: HTMLElement = el('div', 'tdc-note tdc-note-bill ss-note-declared');
    const owed: string = built.detail.replace(/^declared, not built: /, '').replace(/; the build plans and asks$/, '');
    note.append(
      el('span', 'tdc-note-title', 'DECLARED · NOT BUILT'),
      el('span', 'tdc-prose', built.state === 'ready' && built.detail === '' ? `Declared; nothing that bills is made yet${this.ask !== null ? ': the question names what its plan made, free, to plan it' : ''}.` : owed),
      el('span', 'tdc-prose tdc-quiet', 'BUILD applies it: it plans, says the cost and asks before anything bills.'),
    );
    return note;
  }

  protected cost_redraw(): void {
    const box: HTMLElement | null = this.parts.body.querySelector('.ss-cost');
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (box !== null && step !== undefined) this.cost_fill(box, step);
  }

  protected cost_fill(box: HTMLElement, step: ScriptStep): void {
    box.replaceChildren();
    const row: VmCostRow | null = this.stepCost;
    if (row === null) {
      if (this.stepCostRefused !== null) {
        box.append(el('p', 'tdc-prose tdc-quiet', `not priced: ${this.stepCostRefused}`));
        return;
      }
      box.append(el('p', 'tdc-prose tdc-quiet', this.pricesRead === null ? 'reading Oracle\'s price list, once for this session; every price after it is worked out from it…' : 'pricing the line as it stands…'));
      if (this.costTimer === null) this.stepCost_ask(step.lines[0]?.text ?? '');
      return;
    }
    const rows: HTMLElement = el('div', 'tdc-cost-rows');
    const rate = (label: string, value: VmCostRate | null, cls: string = ''): void => {
      rows.append(el('span', `tdc-pair-label ${cls}`.trim(), label), el('span', `tdc-cost-rate ${cls}`.trim(), value === null ? 'NOT PRICED' : rate_words(value, HOURS_PER_MONTH)));
    };
    rate('AS SIZED', row.cost, 'tdc-bill');
    // What runs, priced, and the offer's difference from it: the change is priced against what stands, not against the declaration.
    const runs = this.runs_get(row.name);
    if (runs !== null) {
      const key: string = `${row.name}@${runs.at}`;
      if (this.runsCost?.key !== key) this.runsCost_ask(key, step, runs);
      const running: VmCostRate | null = this.runsCost?.key === key ? this.runsCost.row?.cost ?? null : null;
      rate('AS IT RUNS', running);
      if (running !== null && row.cost !== null) {
        const delta: number = (row.cost.machineHour + row.cost.dataHour - running.machineHour - running.dataHour) * HOURS_PER_MONTH;
        rows.append(el('span', 'tdc-pair-label', 'THE CHANGE'), el('span', `tdc-cost-rate${delta > 0 ? ' tdc-bill' : ''}`, Math.abs(delta) < 0.005 ? 'NONE' : `${delta > 0 ? '+' : '−'}${money_text(Math.abs(delta), row.cost.currency)} A MONTH`));
      }
    }
    if (row.cost !== null) rate('THE DATA ALONE', { machineHour: 0, dataHour: row.cost.dataHour, currency: row.cost.currency });
    if (row.before !== null && runs === null) rate('AS DECLARED', row.before);
    box.append(this.pairs_make([['SPEC', spec_words(row.spec)], ['DECLARED', row.declared ? (row.changes.length === 0 ? 'YES · UNCHANGED' : `YES · ${row.changes.join(', ')}`) : 'NOT YET'], ['PRICE LIST', this.pricesRead === null ? 'ORACLE\'S' : `ORACLE'S · READ ${this.pricesRead.slice(11, 16)} UTC · KEPT FOR THE SESSION`]]), rows);
    box.append(el('p', 'tdc-prose tdc-quiet', `The data volume is kept by a default teardown, so its share is said apart. List price${this.runs_get(line_parse(step.lines[0]?.text ?? '').subject ?? '') === null ? '; nothing here bills until BUILD applies' : '; AS IT RUNS is what bills now'}.`));
  }

  /** What a VM's build makes, as pairs. */
  protected vmBuilds_make(name: string): HTMLElement {
    return this.pairs_make([['VM', name], ['BUILDS', 'the data volume, its backups and the address, then the machine; asks before the apply with the cost'], ['OVER', 'kept data, when the machine alone was torn down']]);
  }

  /** A VM's lock and undoing, each a line of its own, when this screen shows them under the build. */
  /**
   * What each undoing of a VM removes and what it stops billing, as what runs
   * is priced (a-change-is-a-loop, clause 2); on its seat and on a teardown line's.
   *
   * @param name - The VM.
   * @param machineStands - Whether its machine stands.
   * @param anyStands - Whether anything of it stands.
   * @returns The rows.
   */
  protected vmGoes_make(name: string, machineStands: boolean, anyStands: boolean): HTMLElement {
    const rate = this.costRows.get(name)?.runs?.rate ?? null;
    const month = (hourly: number): string => rate === null ? '' : ` · STOPS ${money_text(hourly * HOURS_PER_MONTH, rate.currency)} A MONTH`;
    if (!anyStands) return this.pairs_make([['NOTHING STANDS', `nothing of ${name} is left to tear down`]]);
    return this.pairs_make([
      ...(machineStands ? [['TEARDOWN', `the machine and its boot disk; the data, its backups and the address stay${month(rate?.machineHour ?? 0)}`] as [string, string]] : []),
      ['TEARDOWN · ALL', `the machine, the data volume and its backups, the address: the data cannot be had back${month((rate?.machineHour ?? 0) + (rate?.dataHour ?? 0))}`],
      ['EITHER', 'asks first, with what goes and what still bills; ALL asks for the name typed back'],
    ]);
  }

  protected vmUndoing_make(name: string, step: string): HTMLElement[] {
    if (!this.undoing_shown()) return [];
    // The lock and what stands, as `vm status` read them: the lock drawn, only its other setting offered, an undoing only of what stands.
    const row: VmStatusRow | null = this.vmsSeen.get(name) ?? null;
    const protect: HTMLElement = el('div', 'tdc-commands');
    const lockWord: string = row === null ? 'THE LOCK · NOT READ' : row.state === 'gone' ? 'THE LOCK · NOTHING STANDS TO LOCK' : `THE LOCK · ${row.protected ? 'PROTECTED' : 'UNLOCKED'}${lockWhere_text(row.lock) !== null ? ` · ${(lockWhere_text(row.lock) as string).toUpperCase()}` : ''}`;
    // loop: ss-vm-protect
    const on: HTMLButtonElement = this.linePill_make('PROTECT · ON', `vm protect ${name} on`, step, 'quiet');
    // loop: ss-vm-protect
    const off: HTMLButtonElement = this.linePill_make('PROTECT · OFF', `vm protect ${name} off`, step, 'quiet');
    protect.append(el('span', 'tdc-commands-label', lockWord), ...(row === null ? [on, off] : row.protected ? [off] : [on]));
    const teardown: HTMLElement = el('div', 'tdc-commands');
    // loop: ss-vm-teardown
    const machine: HTMLButtonElement = this.linePill_make('TEARDOWN', `vm teardown ${name}`, step, 'destroy');
    machine.title = `sends: vm teardown ${name} (the machine; the data, its backups and the address stay)`;
    // loop: ss-vm-teardown
    const all: HTMLButtonElement = this.linePill_make('TEARDOWN · ALL', `vm teardown ${name} --all`, step, 'destroy');
    all.classList.add('ss-pill-redder');
    all.title = `sends: vm teardown ${name} --all (the data too; asks for the name typed back)`;
    const machineStands: boolean = row === null || (row.stands != null ? row.stands.vcpu !== null : row.state === 'built');
    const anyStands: boolean = row === null || row.state !== 'gone';
    const what: string = row?.stands != null ? `UNDOING · ${row.stands.vcpu !== null ? 'MACHINE STANDS' : 'NO MACHINE'} · ${row.stands.data !== null ? 'DATA STANDS' : 'NO DATA'} · READ ${row.stands.at.slice(11, 16)}` : row?.state === 'gone' ? 'UNDOING · NOTHING OF IT STANDS' : 'UNDOING';
    // Held, and saying why, where the act cannot run: the lock is on, or nothing of the VM is known to the tenancy.
    const hold = (pill: HTMLButtonElement, why: string, word: string): void => { if (pill.disabled) return; pill.disabled = true; pill.textContent = `${pill.textContent ?? ''} · ${word}`; pill.title = why; };
    if (this.vmsSeenRead && (row === null || row.state === 'gone')) {
      for (const pill of [on, off, machine, all]) hold(pill, row === null ? `${name} is not in the tenancy nor kept here: declare and build it first` : `nothing of ${name} stands: there is nothing to lock or tear down`, 'NOTHING BUILT');
    } else if (row?.protected === true) {
      for (const pill of [machine, all]) hold(pill, `${name} is protected: PROTECT · OFF lifts the lock, as a line of its own`, 'LOCKED');
    }
    teardown.append(el('span', 'tdc-commands-label', what), ...(machineStands ? [machine] : []), ...(anyStands ? [all] : []));
    const goes: HTMLElement = this.vmGoes_make(name, machineStands, anyStands);
    return [el('p', 'tdc-prose tdc-quiet', 'A VM is born protected: teardown refuses until PROTECT · OFF, a line of its own. A teardown returns the build to ready.'), protect, teardown, goes];
  }

  /**
   * Prices what runs once per read of it: the line with its levers set to
   * what the tenancy runs, asked of `vm cost`.
   *
   * @param key - The VM and when what runs was read.
   * @param step - The seat.
   * @param runs - What runs.
   */
  protected runsCost_ask(key: string, step: ScriptStep, runs: VmRuns): void {
    this.runsCost = { key, row: null };
    let line: string = step.lines[0]?.text ?? '';
    for (const [word, value] of [['--vcpu', runs.vcpu], ['--memory', runs.memory], ['--disk', runs.disk], ['--data', runs.data]] as const) if (value !== null) line = lineOption_set(line, word, String(value));
    void this.hooks.ask(costLine_derive(line)).then((answer: QuietAnswer): void => {
      if (this.runsCost?.key !== key) return;
      const model = model_extract(answer, STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
      // Only the parts that stand bill: a machine torn down is priced at nothing, its kept data at its own.
      const row: VmCostRow | null = model?.vms[0] ?? null;
      const standing: VmCostRow | null = row === null || row.cost === null ? row
        : { ...row, cost: { ...row.cost, machineHour: runs.vcpu === null ? 0 : row.cost.machineHour, dataHour: runs.data === null ? 0 : row.cost.dataHour } };
      this.runsCost = { key, row: standing };
      this.cost_redraw();
    }, (): void => undefined);
  }

  protected vmBuild_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const name: string = line_parse(line.text).subject ?? '';
    return [
      this.lineBoxNumbered_make(line),
      // loop: ss-vm-build
      this.runRow_make(step, line, 'bill'),
      this.vmBuilds_make(name),
      ...this.vmUndoing_make(name, step.key),
    ];
  }

  protected chrisDeploy_make(step: ScriptStep): HTMLElement[] {
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
      // loop: ss-chris-deploy
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

  /**
   * What stands of a network beside its lines (a-change-is-a-loop, clauses
   * 1 and 2): its state, the CIDR declared against the one its last build
   * made, its stack as the tenancy answers it, its bastion and the address it
   * admits, with when the tenancy was read; the line's own standing said under it.
   *
   * @param step - The seat.
   * @param net - The network.
   * @returns The side column.
   */
  protected netSide_make(step: ScriptStep, net: string): HTMLElement {
    if (!this.nets.has(net)) this.net_ask(net);
    const read = this.nets.get(net) ?? null;
    const side: HTMLElement = this.section_make('THE NETWORK · AS IT STANDS', 'ss-col-side', read?.read == null ? 'NOT READ' : `READ FROM THE TENANCY ${read.read.slice(11, 16)} UTC`);
    const row: NetStatusRow | null = read?.row ?? null;
    if (read === null) side.append(el('p', 'tdc-prose tdc-quiet', 'reading what stands: net status'));
    else if (row === null) side.append(el('p', 'tdc-prose', read.read == null ? 'The tenancy was not searched, and this host keeps no record of a network by that name: what stands there is not known.' : 'Nothing of it stands: neither this host nor the tenancy holds a network by that name.'));
    else side.append(this.pairs_make([
      ['STATE', row.state.toUpperCase()],
      // The range it stands with is the VCN's, read from the tenancy; this host's record of the last build speaks only where the VCN was not read.
      ['CIDR', ((): string => {
        const stands = row.stands ?? null;
        const runs: string | null = stands !== null ? stands.cidr : row.builtCidr;
        const how: string = stands !== null ? 'the VCN, read from the tenancy' : 'as built, this host\'s record';
        if (stands !== null && stands.cidr === null) return `the tenancy holds no VCN of it${row.cidr !== null ? ` · ${row.cidr} declared` : ''}`;
        // Torn down, nothing of it stands: the range it was built with is history, not what stands.
        if (row.state === 'gone') return `none stands: torn down${row.builtCidr !== null ? ` (it was built with ${row.builtCidr})` : ''}${row.cidr !== null ? ` · ${row.cidr} declared` : ''}`;
        if (runs === null) return row.cidr ?? '—';
        return row.cidr === null || row.cidr === runs ? `${runs} (${how})` : `${runs} (${how}) · ${row.cidr} declared`;
      })()],
      // The line's range against what stands (the VCN's) or, unbuilt, what is declared: the change the line would make, in the operator's direction.
      ...((): Array<[string, string]> => {
        const asked: string | null = lineOption_get(step.lines[0]?.text ?? '', '--cidr');
        const against: string | null = row.stands?.cidr ?? (row.state === 'built' ? row.builtCidr : row.cidr);
        if (asked === null || against === null || asked === against) return [];
        return [['THIS LINE', `${against} → ${asked}${row.state === 'built' ? ': replaces the VCN and subnet and every machine on them (refused unless --allow-alter)' : ': declares the new range; nothing is built yet'}`]];
      })(),
      ['STACK', row.stack === null ? 'none found in the tenancy' : `${row.stack.state.toUpperCase()} · ${row.stack.id}`],
      ['BASTION', row.bastion === null ? '—' : `${row.bastion}${row.admits !== null ? ` · admits ${row.admits}` : ''}`],
    ]));
    const said: string = step.lines.map((line: ScriptLine): string => line.detail).filter((detail: string): boolean => detail !== '').join('; ');
    if (said !== '') side.append(this.pairs_make([['SAID', said]]));
    const running: HTMLElement | null = this.runningNote_make(step);
    if (running !== null) side.append(running);
    // An edit not saved is said here as on any seat, with SAVE.
    const edited: Element | undefined = this.edited ? [...this.state_make(step).querySelectorAll('.tdc-note')].find((note: Element): boolean => (note.textContent ?? '').includes('EDITED')) : undefined;
    if (edited !== undefined) side.append(edited);
    return side;
  }

  /**
   * Asks what stands of a network, once per name until a line runs.
   *
   * @param net - The network.
   */
  protected net_ask(net: string): void {
    this.nets.set(net, null);
    // Every network, so one this host and the tenancy hold nothing of is read as absent (with when), never as unread.
    void this.hooks.ask('net status').then((answer: QuietAnswer): void => {
      const model = model_extract(answer, STRATUS_NET_STATUS_MODEL_KIND, (data: unknown) => netStatusModelSchema.safeParse(data));
      this.nets.set(net, { row: model?.nets.find((one: NetStatusRow): boolean => one.name === net) ?? null, read: model?.read ?? null });
      this.draw();
    }, (): void => { this.nets.set(net, { row: null, read: null }); });
  }

  /** The VM a USERS seat's accounts are on: its lines' `--on`, else the one the screen shows. */
  protected usersVm_get(step: ScriptStep): string {
    return step.lines.map((line: ScriptLine): string | null => lineOption_get(line.text, '--on')).find((on): on is string => on !== null && on !== '') ?? '';
  }

  /**
   * What runs of the ChRIS, beside its deploy line (a-change-is-a-loop,
   * clauses 1, 2 and 5): CUBE's answer and the admin's sign-in, porter's
   * health, sessions and version, the image deployed, CUBE's accounts, with
   * when they were read; then what the line would do as `chris deploy
   * --plan` says it (the changes, the restarts, the sessions a porter
   * restart ends). After a deploy both are read again: the render is the receipt.
   *
   * @param step - The seat.
   * @param chris - What runs, as `chris status` read it.
   * @returns The side column.
   */
  protected chrisSide_make(step: ScriptStep, chris: ChrisStatusRow): HTMLElement {
    const side: HTMLElement = this.section_make('THE CHRIS · AS IT RUNS', 'ss-col-side', chris.live === null ? 'NOT READ' : `READ FROM IT ${chris.live.at.slice(11, 16)} UTC`);
    const running: HTMLElement | null = this.runningNote_make(step);
    if (running !== null) side.append(running);
    const live = chris.live;
    const cube: string = live === null ? '—' : live.cube.status === null ? 'DOES NOT ANSWER' : `ANSWERS ${live.cube.status}${live.cube.admin === true ? ' · CHRIS SIGNS IN' : live.cube.admin === false ? ' · CHRIS DOES NOT SIGN IN' : ''}`;
    const porter: string = live?.porter == null ? (chris.porter === null ? 'none deployed' : '—') : live.porter.status === null ? 'DOES NOT ANSWER' : `ANSWERS ${live.porter.status}${live.porter.sessions !== null ? ` · ${live.porter.sessions} OPEN` : ''}${live.porter.version !== null ? ` · ${live.porter.version}` : ''}`;
    side.append(this.pairs_make([
      ['CUBE', cube], ['PORTER', porter], ['IMAGE', chris.image === null ? 'not kept by the deploy that put it up' : `${chris.image}${chris.porterVersion !== null ? ` · porter ${chris.porterVersion}` : ''} (as deployed)`],
      ['ACCOUNTS', live?.accounts == null ? `not read${live?.accountsWhy ? `: ${live.accountsWhy}` : ''}` : String(live.accounts.length)], ['DEPLOYED', chris.deployed.slice(0, 16).replace('T', ' ')],
    ]));
    const line: ScriptLine | undefined = step.lines[0];
    if (line === undefined) return side;
    side.append(this.chrisPlanNote_make(line));
    return side;
  }

  /**
   * Whether no ChRIS is deployed on a VM, as read: when, or null when one
   * stands or nothing was read yet.
   *
   * @param vm - The VM.
   * @returns When it was read absent, or null.
   */
  protected chrisAbsent_read(vm: string): { at: string | null } | null {
    if (!this.chrisSeenRead || this.chrisSeen.has(vm)) return null;
    return { at: this.chrisSeenAt };
  }

  /**
   * A deploy seat where nothing is deployed yet (a-change-is-a-loop, clauses
   * 1 and 2): no ChRIS stands on the machine, as `chris status` read it, with
   * when; then what the first deploy would put up, as `--plan` says it.
   *
   * @param step - The seat.
   * @param vm - The VM.
   * @param absent - When it was read absent.
   * @returns The side column.
   */
  protected chrisFirstSide_make(step: ScriptStep, vm: string, absent: { at: string | null }): HTMLElement {
    const side: HTMLElement = this.section_make('THE CHRIS · AS IT RUNS', 'ss-col-side', absent.at === null ? 'READ' : `READ ${absent.at.slice(11, 16)} UTC`);
    const running: HTMLElement | null = this.runningNote_make(step);
    if (running !== null) side.append(running);
    side.append(this.pairs_make([['CUBE', `none deployed on ${vm}`], ['PORTER', 'none deployed'], ['ACCOUNTS', 'none: CUBE is not there']]));
    const line: ScriptLine | undefined = step.lines[0];
    if (line !== undefined) side.append(this.chrisPlanNote_make(line));
    return side;
  }

  /**
   * What a deploy line would do, as `chris deploy … --plan` says it.
   *
   * @param line - The deploy line.
   * @returns The note.
   */
  protected chrisPlanNote_make(line: ScriptLine): HTMLElement {
    if (!this.chrisPlans.has(line.text)) this.chrisPlan_ask(line.text);
    const plan: ChrisPlanModel | null | undefined = this.chrisPlans.get(line.text);
    const note: HTMLElement = el('div', `tdc-note ss-note-deploy${plan?.asks === true ? ' tdc-note-bill' : ''}`);
    if (plan === null || plan === undefined) {
      note.append(el('span', 'tdc-note-title', 'DEPLOY WOULD'), el('span', 'tdc-prose tdc-quiet', 'reading what a deploy would do: chris deploy … --plan'));
    } else if (!plan.asks) {
      note.append(el('span', 'tdc-note-title', 'WHAT RUNS IS WHAT THIS DEPLOYS'), el('span', 'tdc-prose tdc-quiet', 'a replay changes nothing and restarts nothing: it checks again what is there'));
    } else {
      note.append(el('span', 'tdc-note-title', 'DEPLOY WOULD'));
      for (const change of plan.changes) note.append(el('span', 'tdc-prose', change));
      for (const restart of plan.restarts) note.append(el('span', 'tdc-prose ss-would-reboot', `restarts ${restart}`));
      if (plan.sessions !== null && plan.restarts.some((one: string): boolean => one.startsWith('porter (') || one.startsWith('CUBE and porter'))) note.append(el('span', `tdc-prose${plan.sessions > 0 ? ' ss-would-reboot' : ' tdc-quiet'}`, plan.sessions === 0 ? 'no porter session is open now' : `${plan.sessions} porter session${plan.sessions === 1 ? '' : 's'} open now ${plan.sessions === 1 ? 'ends' : 'end'}`));
      note.append(el('span', 'tdc-prose tdc-quiet', plan.first === true
        ? `RUN asks here with all of it before anything is put up; the admin password is asked after the yes${lineOption_get(line.text, '--admin-password-file') !== null ? ', unless the line names its file' : ''}.`
        : 'RUN asks here with all of it before anything restarts.'));
    }
    return note;
  }

  /**
   * Asks what a deploy line would do, once per text of it.
   *
   * @param text - The `chris deploy` line.
   */
  protected chrisPlan_ask(text: string): void {
    this.chrisPlans.set(text, null);
    void this.hooks.ask(`${text} --plan`).then((answer: QuietAnswer): void => {
      this.chrisPlans.set(text, model_extract(answer, STRATUS_CHRIS_PLAN_MODEL_KIND, (data: unknown) => chrisPlanModelSchema.safeParse(data)));
      this.draw();
    }, (): void => undefined);
  }

  /**
   * CUBE's accounts beside the script's user lines (a-change-is-a-loop,
   * clause 1): each line wears whether CUBE holds its account, and an account
   * CUBE holds with no line is said too; after ADD they are read again, so
   * the new account appearing is the receipt.
   *
   * @param step - The USERS seat.
   * @param chris - What runs, as `chris status` read it.
   * @returns The side column.
   */
  protected usersSide_make(step: ScriptStep, chris: ChrisStatusRow): HTMLElement {
    const live = chris.live;
    const side: HTMLElement = this.section_make('IN THE CHRIS · ITS ACCOUNTS', 'ss-col-side', live === null ? 'NOT READ' : `READ FROM IT ${live.at.slice(11, 16)} UTC`);
    if (live?.accounts == null) {
      side.append(el('p', 'tdc-prose tdc-quiet', `CUBE's accounts were not read${live?.accountsWhy ? `: ${live.accountsWhy}` : ''}.`));
      return side;
    }
    const lined: Set<string> = new Set(step.lines.map((line: ScriptLine): string => line_parse(line.text).subject ?? '').filter((name: string): boolean => name !== ''));
    const held: Set<string> = new Set(live.accounts.map((one): string => one.username));
    const rows: Array<[string, string]> = [
      ...[...lined].map((name: string): [string, string] => [name.toUpperCase(), held.has(name) ? 'IN CUBE · A LINE OF THE SCRIPT' : 'NOT IN CUBE YET · ITS LINE ADDS IT']),
      ...live.accounts.filter((one): boolean => !lined.has(one.username)).map((one): [string, string] => [one.username.toUpperCase(), `IN CUBE · NO LINE${one.username === 'chris' ? ' (the admin)' : ''}`]),
    ];
    side.append(this.pairs_make(rows), el('p', 'tdc-prose tdc-quiet', `${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'} in CUBE, from its all_users group; a name already there is left as it is.`));
    return side;
  }

  protected users_make(step: ScriptStep): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const list: HTMLElement = el('div', 'ss-users');
    for (const line of step.lines) {
      const row: HTMLElement = this.lineBoxNumbered_make(line);
      const commands: HTMLElement = el('div', 'tdc-commands');
      // loop: ss-user-add
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
    // The ChRIS the account goes to: the seat's lines' own, else the machine the screen is on (never left to the kernel to pick).
    const on: string = step.lines.map((line: ScriptLine): string | null => lineOption_get(line.text, '--on')).find((value): value is string => value !== null) ?? this.usersVm_get(step);
    const commands: HTMLElement = el('div', 'tdc-commands ss-user-add');
    form.append(commands);
    nodes.push(form, el('p', 'tdc-prose tdc-quiet', 'Each user is a line, so a ChRIS\'s accounts are declared, not remembered. ADD appends the line, saves the working copy, then runs it: the engine asks first, on the strip, naming the account and the ChRIS it is made on; a NO makes nothing and the line stays declared; a name CUBE already holds is left as it is, unasked. The password never shows here: it is asked hidden, or read from the file the line names.'));
    this.userAdd_fill(commands, step, on);
    return nodes;
  }

  protected userAdd_redraw(step: ScriptStep): void {
    const commands: HTMLElement | null = this.parts.body.querySelector('.ss-user-add');
    if (commands === null) return;
    // The ChRIS the account goes to: the seat's lines' own, else the machine the screen is on (never left to the kernel to pick).
    const on: string = step.lines.map((line: ScriptLine): string | null => lineOption_get(line.text, '--on')).find((value): value is string => value !== null) ?? this.usersVm_get(step);
    this.userAdd_fill(commands, step, on);
  }

  /**
   * Why a user line would be refused for its ChRIS, as `chris status` read
   * it: none deployed where the account would go, or more than one with no
   * `--on`; null when one stands or nothing was read yet.
   *
   * @param on - The line's `--on`, or empty.
   * @returns The refusal's words for ADD, or null.
   */
  protected userAddChris_why(on: string): string | null {
    if (!this.chrisSeenRead) return null;
    if (on !== '') return this.chrisSeen.has(on) ? null : `NO CHRIS ON ${on.toUpperCase()}`;
    return this.chrisSeen.size === 0 ? 'NO CHRIS' : this.chrisSeen.size > 1 ? 'WHICH CHRIS' : null;
  }

  protected userAdd_fill(commands: HTMLElement, step: ScriptStep, on: string): void {
    commands.replaceChildren();
    const { name, email, passwordFile } = this.userForm;
    // A refusal the line would meet, when the screen can know it, is said on ADD before the press (a-change-is-a-loop, clause 2).
    const chrisWhy: string | null = this.userAddChris_why(on);
    const refusal: string | null = name === '' ? 'NAME' : !/^[a-z][a-z0-9_-]{1,31}$/.test(name) ? 'NAME IS A LOGIN' : email === '' ? 'EMAIL' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'EMAIL IS AN ADDRESS' : step.lines.some((line: ScriptLine): boolean => line_parse(line.text).subject === name) ? 'ALREADY A LINE' : chrisWhy;
    const line: string = userLine_build(name || '<name>', email || '<email>', passwordFile, on);
    // The door's hold comes before the form's: in a READ session that cannot be raised ADD is refused whatever the form holds; one that can asks first.
    const doorHold: ReadHold = this.hold_derive('chris user add');
    const heldByDoor: boolean = doorHold === 'held';
    // loop: ss-user-add
    const add: HTMLButtonElement = el('button', `tdc-pill tdc-pill-plain${doorHold === 'asks' && refusal === null ? ' tdc-pill-asks' : ''}`, heldByDoor ? 'ADD · REFUSED' : refusal === null ? 'ADD' : `ADD · ${refusal}`);
    if (heldByDoor) add.title = `refused: ${READ_HELD}`;
    else if (doorHold === 'asks' && refusal === null) add.title = `${READ_ASKS}: the user line`;
    add.type = 'button';
    if (!heldByDoor && !(doorHold === 'asks' && refusal === null)) add.title = `appends, saves, then sends; the engine asks first: ${line}`;
    add.disabled = heldByDoor || refusal !== null || this.busy !== null;
    add.addEventListener('click', (): void => {
      this.hooks.voice.pill('ADD');
      void (async (): Promise<void> => {
        // A READ session that can be raised asks the password first; the line is appended only once it may run.
        if (this.hold_derive(line) === 'asks' && this.hooks.elevate_ask !== null && !(await this.hooks.elevate_ask(line))) return;
        const number: number = (this.lines.at(-1)?.number ?? 0) + 1;
        const added: ScriptLine = { number, text: line, state: 'ready', detail: '', running: null };
        this.lines.push(added);
        this.steps = this.steps_derive(this.lines);
        this.edited = true;
        this.userForm = { name: '', email: '', passwordFile: '' };
        // The line is written before it runs, so the account it makes is always declared (a-change-is-a-loop, clause 3):
        // a save refused runs nothing. The engine's question, naming the account and the ChRIS, is the confirm (clause 4).
        await this.save_send();
        if (this.edited) return;
        await this.line_send(line, 'users');
      })();
    });
    commands.append(add, el('span', 'tdc-mono ss-user-line', line));
    // What ADD would do, or why it is refused, stands under it before the press (clause 2).
    const host: string = ((): string => { try { return new URL(this.chrisRow_get(on === '' ? [...this.chrisSeen.keys()][0] ?? '' : on)?.url ?? '').host; } catch { return on === '' ? 'the ChRIS' : `${on}'s ChRIS`; } })();
    if (chrisWhy !== null && refusal === chrisWhy) {
      commands.append(el('p', 'tdc-prose ss-user-offer', chrisWhy === 'WHICH CHRIS'
        ? `stratus runs ${this.chrisSeen.size} ChRIS (${[...this.chrisSeen.keys()].join(', ')}): the line needs --on to say which; nothing is made until it does.`
        : `${on === '' ? 'No ChRIS is deployed' : `No ChRIS is deployed on ${on}`}, as chris status read it: the line would be refused. Deploy one first, on the CHRIS DEPLOY seat.`));
    } else if (refusal === null && !heldByDoor) {
      commands.append(el('p', 'tdc-prose ss-user-offer', `ADD makes ${name} (${email}) on ${host}: a login that can sign in. Its line is saved to ${workingCopy_derive(this.path)} first${this.edited ? ', with the script\'s other edits' : ''}, then run, and the engine asks before the account is made. stratus has no verb to remove an account; CUBE's admin does.`));
    }
  }

  protected other_make(step: ScriptStep): HTMLElement[] {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    // A line with no form parses its verb as one word: a VM's teardown line is read by its words.
    const words: string[] = words_split(line.text);
    // A VM's teardown line says what it would undo and what it stops billing, as its VM NEW seat does.
    if (words[0] === 'vm' && words[1] === 'teardown' && words[2] !== undefined) {
      const vm: string = words[2];
      const row: VmStatusRow | null = this.vmsSeen.get(vm) ?? null;
      const machineStands: boolean = row === null || (row.stands != null ? row.stands.vcpu !== null : row.state === 'built');
      // loop: ss-vm-teardown
      return [this.lineBoxNumbered_make(line), this.runRow_make(step, line), this.vmGoes_make(vm, machineStands, row === null || row.state !== 'gone')];
    }
    // A VM's lock line says what it writes: the lock, kept in the tenancy; nothing is removed, and the teardown after it asks.
    if (words[0] === 'vm' && words[1] === 'protect' && words[2] !== undefined) {
      const off: boolean = words[3] === 'off';
      // loop: ss-vm-protect
      return [this.lineBoxNumbered_make(line), this.runRow_make(step, line), el('p', 'tdc-prose', off ? `Writes ${words[2]}'s lock off in the tenancy and removes nothing; a teardown after it still asks first, with what goes and what still bills.` : `Writes ${words[2]}'s lock on in the tenancy: a teardown refuses until the lock is lifted. Nothing else changes.`)];
    }
    // loop: ss-line-run
    return [this.lineBoxNumbered_make(line), this.runRow_make(step, line), el('p', 'tdc-prose tdc-quiet', 'The screen has no form for this verb: the line runs as written. A line that would act asks first where its verb asks; one that only reads answers in THE STEP\'S OUTPUT.')];
  }

  // -------------------------------------------------------------- the strip

  protected strip_draw(): void {
    const strip: HTMLElement = this.parts.strip;
    strip.replaceChildren();
    // A hidden word is asked on the errand bar (body_draw), never on the strip.
    strip.hidden = this.ask === null || this.ask.kind === 'secret';
    if (this.ask === null || this.ask.kind === 'secret') return;
    const ask: OpenAsk = this.ask;
    const form = askForm_derive(ask.message);
    const destroying: boolean = /teardown|destroy|remove/i.test(ask.message) || form === 'name';
    const billing: boolean = /an hour|a month|\$|bill/i.test(ask.message);
    strip.dataset['tone'] = destroying ? 'destroy' : billing ? 'bill' : 'plain';
    const words: HTMLElement = el('div', 'tdc-strip-words');
    words.append(el('span', 'tdc-strip-title', 'THE ENGINE ASKS'), el('span', 'tdc-strip-text', ask.message));
    strip.append(words);
    if (form === 'yes-no') {
      // loop: confirm
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
    // loop: confirm
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

  protected log_add(text: string, kind: 'sent' | 'out' | 'ask' | 'answer' | 'note'): void {
    const row: HTMLElement = el('span', `tdc-log-line tdc-log-${kind}`, text);
    this.parts.log.append(row);
    while (this.parts.log.childElementCount > LOG_LIMIT) this.parts.log.firstElementChild?.remove();
    this.parts.log.scrollTop = this.parts.log.scrollHeight;
    if (kind === 'out' && this.busy !== null) this.busyOut.push(text);
    // A task followed with no line in this lane (its question answered here): what it prints lands under its seat.
    if (kind === 'out' && this.busy === null && this.followStep !== null) this.stepLogs.set(this.followStep, [...(this.stepLogs.get(this.followStep) ?? []), text].slice(-200));
    if (kind === 'answer' && this.busy !== null && (text === 'n' || text === '(declined)')) this.busyDeclined = true;
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
