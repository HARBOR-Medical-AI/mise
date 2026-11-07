/**
 * @file The VM controller: the script screen keyed by one virtual machine
 * (docs/stratus.adoc, D17 revised). Its door is MACHINES: every VM the
 * tenancy runs, as `ls` shows a folder, with + NEW (the operator, 2026-11-03).
 * The gutter carries a pill per VM and + NEW; a machine opens on MACHINE, what
 * it is and what is on it, then its lines as seats, SIZE (its `vm new` with
 * the `vm build` after it: DECLARE and BUILD), CHRIS, USERS, and TEARDOWN,
 * which is no line but the VM's own undoing. A build line standing apart from
 * its declaration keeps a BUILD seat of its own. A VM this session
 * can only see (found in the tenancy, or taken over from it, its SSH key kept
 * by the session that built it) stands with MACHINE and TEARDOWN alone. The
 * header is the machine's facts. Underneath, the script stays the truth: a VM
 * opened from the library shows its script's lines; one the host keeps with
 * no script in the library gets its script synthesized from its record and
 * written under `/scripts/mine/` at the first act; one started from nothing
 * composes its lines as the operator goes, so what the screen leaves behind
 * replays to where they got to.
 *
 * Built on the script screen's bodies, which are the same forms over the
 * same lines; this file holds what differs.
 */
import type { ChrisStatusRow, PromptKind, VmCostRate, VmCostRow, VmLimitsModel, VmStatusRow } from '@fnndsc/menu';
import { HOURS_PER_MONTH, money_text } from '../controller/model.js';
import { chrisStatusModelSchema, STRATUS_CHRIS_STATUS_MODEL_KIND, STRATUS_VM_COST_MODEL_KIND, STRATUS_VM_STATUS_MODEL_KIND, vmCostModelSchema, vmStatusModelSchema } from '@fnndsc/menu';
import { lockWhere_text, modePill_make } from '../takeover/tier.js';
import type { TakeoverView } from '../takeover/frame.js';
import { saveLine_compose } from '../edit/line.js';
import { buildWould_derive, costLine_derive, line_parse, line_render, lineOption_get, lineOption_set, lines_build, ports_word, rate_words, runningStep_find, script_render, stepBuildLine_get, steps_build, vmLevers_read, vmSliders_build, workingCopy_derive, type BuildWould, type ScriptLine, type ScriptStep, type SliderSpec, type VmRuns } from '../script/model.js';
import { ScriptScreen, type OpenAsk, type QuietAnswer, type ScriptHooks } from '../script/screen.js';
import { FACTS_KEY, MACHINES_KEY, NEW_KEY, SERVICES_KEY, TEARDOWN_KEY, VM_SEAT_LABELS, vmServiceKind_derive, vmServices_change, vmServices_read, vmCondition_derive, vmKeyless_is, vmLines_filter, vmName_valid, vmNewLine_compose, vmScript_append, vmScript_complete, vmScript_synthesize } from './model.js';
import { BUILD_PHASES, buildQuestion_plain, buildRun_answer, buildRun_ask, buildRun_end, buildRun_start, buildRun_take, type BuildQuestion, type BuildRun } from './run.js';
import { Listing } from '../roster/listing.js';
import type { ListingTrait } from '../roster/row.js';

/** The order the VM's seats stand in, whatever order the script's lines come. */
const SEAT_ORDER: ReadonlyArray<string> = ['SPEC', 'BUILD', 'SERVICES', 'CHRIS', 'USERS', 'TEARDOWN'];

/** The seats the gutter does not show: a ChRIS's accounts stand on CHRIS (the operator, 2026-11-07). */
const SEATS_UNSHOWN: ReadonlyArray<string> = ['USERS'];

/** The name a new machine's line carries until one is typed: a plain word, so its price can be asked (`<name>` would be read as a redirect). */
const UNNAMED: string = 'unnamed';

/** The network a new machine starts on when the host keeps none to copy. */
const NET_DEFAULT: string = 'chrisproject-services';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A span of time, as the band says it.
 *
 * @param ms - Milliseconds.
 * @returns `42 s`, `3 m 05 s`.
 */
function duration_text(ms: number): string {
  const seconds: number = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, '0')} s`;
}

/** What BUILD says in a READ session no password can raise. */
const READ_HELD_SHORT: string = 'this session can only read and cannot be raised here: enter through porter, or say stratus oci manage in the console';

/** One listed item of `ls`, as the screen reads it. */
interface Listed {
  readonly path: string;
  readonly items: ReadonlyArray<{ name: string; type: string }>;
}

/** The VM controller. */
export class VmScreen extends ScriptScreen {
  // The script screen's constructor draws before a field initializer here would run, so these are set after super().
  /** The VMs the host keeps, as `vm status` reads them. */
  private vms!: VmStatusRow[];
  /** The VM shown; `''` for one not yet named. */
  private vm!: string;
  /** The new machine's name and network, before it is declared. */
  private newForm!: { name: string; net: string };
  /** The new machine's line as the levers leave it, before anything is sent: its sizes kept across redraws and name edits. */
  private newDraft!: ScriptLine;
  /** Whether the script shown is not on the host yet (synthesized from the record, or composed here). */
  private unsaved!: boolean;
  /** What runs of the machine's ChRIS, as `chris status` read it from the ChRIS; null when none is deployed or it was not read. */
  private chrisRow!: ChrisStatusRow | null;
  /** What the machine shown bills, for TEARDOWN's guard: asked once per machine. */
  private teardownCost: { vm: string; rate: VmCostRate | null } | null = null;
  /** The machines as an ARGUS listing; its mount stays across redraws, so its caps, widths and order do. */
  private machineListing: Listing<VmStatusRow> | null = null;
  private machineListingMount: HTMLElement | null = null;
  /** The build in flight, or the one that just ended, drawn as one run on SIZE. */
  private run: BuildRun | null = null;
  /** Whether the operator stopped following a task: then the screen does not follow it again by itself. */
  private followDeclined: boolean = false;
  /** Each lever's share of the change, a month, priced against what runs: keyed by the line priced. */
  private leverCosts: { key: string; deltas: Map<string, number | null> } | null = null;
  private leverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hooks: ScriptHooks) {
    super(hooks, {
      id: 'vm-controller',
      className: 'td-controller script-screen vm-controller',
      brand: { name: 'STRATUS', sub: 'VM · OCI', mark: true },
      banner: 'STRATUS • VM',
      stage: { title: 'THE MACHINE', note: 'VM' },
      log: { title: 'VM LOG', note: 'THE SESSION\'S LINES · TYPE BELOW' },
      labels: { views: 'The machine', log: 'VM log' },
      seatLabel: 'The machines',
    });
    this.vms = [];
    this.vm = '';
    this.newForm = { name: '', net: '' };
    this.newDraft = { number: 1, text: vmNewLine_compose(UNNAMED, NET_DEFAULT), state: null, detail: '', running: null };
    this.unsaved = false;
    this.chrisRow = null;
    this.logFold_install();
    this.draw();
  }

  /** The label of the seat shown, so the view follows it when its key changes (a template seat gaining its line). */
  private viewLabel: string = '';

  /** Whether the VM LOG is open: shut by default to its newest line (the operator, 2026-11-07). */
  private logOpen: boolean = false;

  /** The VM LOG folds: its strip opens and shuts it; shut, it shows its newest line. */
  private logFold_install(): void {
    const strip: HTMLElement | null = this.frame.logTitle.parentElement;
    if (strip === null) return;
    strip.classList.add('vm-log-strip');
    strip.setAttribute('role', 'button');
    strip.tabIndex = 0;
    const toggle = (): void => { this.hooks.voice.pill(this.logOpen ? 'SHUT' : 'OPEN'); this.logOpen_set(!this.logOpen); };
    strip.addEventListener('click', toggle);
    strip.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    this.logOpen_set(false);
  }

  /**
   * Opens or shuts the VM LOG.
   *
   * @param open - Whether it is open.
   */
  private logOpen_set(open: boolean): void {
    this.logOpen = open;
    const stage: HTMLElement | null = this.frame.log.parentElement;
    if (stage !== null) stage.dataset['vmLog'] = open ? 'open' : 'shut';
    this.frame.logNote.textContent = open ? 'THE SESSION\'S LINES · TYPE BELOW · PRESS TO SHUT' : 'THE NEWEST LINE · PRESS TO OPEN';
    this.frame.logTitle.parentElement?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.parts.log.scrollTop = this.parts.log.scrollHeight;
  }

  /** The script screen's constructor draws before this screen's fields exist: that first draw waits for them. */
  protected override draw(): void {
    if (this.vms === undefined) return;
    super.draw();
  }

  /** The VM shown, or `''` for a new one. */
  public vm_get(): string {
    return this.vm;
  }

  /**
   * A VM's row as its teardown sends it, step by step: replaced in the list
   * and drawn, so the blocks go as the steps do without asking.
   *
   * @param row - The row.
   */
  public row_take(row: VmStatusRow): void {
    const at: number = this.vms.findIndex((each: VmStatusRow): boolean => each.name === row.name);
    if (at >= 0) this.vms[at] = row;
    else this.vms.push(row);
    this.draw();
  }

  /** The machines the host keeps, by name, as last read. */
  public vms_get(): ReadonlyArray<string> {
    return this.vms.map((row: VmStatusRow): string => row.name);
  }

  /**
   * Opens the controller on a VM, or on a new one.
   *
   * @param name - The VM, or `''` to start one.
   */
  public async vm_open(name: string): Promise<void> {
    await this.vms_read();
    this.vm = name;
    this.stepLogs.clear();
    if (name === '') {
      this.path = '';
      this.lines = [];
      this.unsaved = false;
      this.edited = false;
      this.newForm = { name: '', net: this.vms.find((row: VmStatusRow): boolean => row.spec !== null)?.spec?.net ?? NET_DEFAULT };
      this.newDraft = { number: 1, text: vmNewLine_compose(UNNAMED, this.newForm.net), state: null, detail: '', running: null };
      // The price shown is the new machine's, never the last machine's.
      this.stepCost = null;
      this.stepCostRefused = null;
      this.steps = this.steps_derive(this.lines);
      // The door shows what is there first, as a folder does; + NEW is beside it. With nothing there, the new one.
      this.view = this.vms.length > 0 ? MACHINES_KEY : NEW_KEY;
      this.draw();
      void this.limits_need();
      void this.standing_read();
      return;
    }
    const opened: VmStatusRow | undefined = this.vms.find((each: VmStatusRow): boolean => each.name === name);
    const path: string | null = vmKeyless_is(opened ?? null) ? null : await this.vmScript_find(name);
    if (vmKeyless_is(opened ?? null)) {
      // Seen, not built on from here: no script is made for it, so no act writes one that would declare it anew.
      this.path = '';
      this.lines = [];
      this.unsaved = false;
      this.edited = false;
    } else if (path !== null) {
      this.path = path;
      this.unsaved = false;
      this.edited = false;
      await this.script_read();
    } else {
      // No script declares it: its record is its script until the first act writes one.
      const row: VmStatusRow | undefined = this.vms.find((each: VmStatusRow): boolean => each.name === name);
      this.path = `/scripts/mine/${name}.mise`;
      const text: string = row === undefined ? `${vmNewLine_compose(name, NET_DEFAULT)}\nvm build ${name}\n` : vmScript_synthesize(row);
      // Read from its record, not edited: written at the first act, as the header's chip says; its lines' states are read from the text.
      this.unsaved = true;
      this.edited = false;
      this.lines = lines_build(text, (await this.status_read(this.path, text))?.lines ?? []);
    }
    this.steps = this.steps_derive(this.lines);
    // A machine opens on its SIZE; a line running takes the seat it runs in; one this session can only see, on what it is.
    this.view = runningStep_find(this.steps)?.key ?? this.steps.find((step: ScriptStep): boolean => step.label === 'SPEC')?.key ?? this.steps[0]?.key ?? FACTS_KEY;
    if (this.run !== null && this.run.vm !== name) this.run = null;
    this.followDeclined = false;
    this.chrisRow = null;
    this.draw();
    void this.limits_need();
    void this.standing_read();
    void this.chris_read();
    this.running_follow();
  }

  /** The title the tab wears. */
  public override title_get(): string {
    return `${vmCondition_derive(this.vmRow_get(), this.busy !== null)} · ${this.vm === '' ? 'NEW VM' : this.vm}`;
  }

  // ---------------------------------------------------------------- reading

  /** `chris status <vm>`, what runs of the machine's ChRIS, read from it: CHRIS and USERS render it. */
  private async chris_read(): Promise<void> {
    const row: VmStatusRow | null = this.vmRow_get();
    if (row === null || row.chris === null || row.chris === undefined || vmKeyless_is(row)) { this.chrisRow = null; return; }
    try {
      const model = this.model_take(await this.hooks.ask(`chris status ${this.vm}`), STRATUS_CHRIS_STATUS_MODEL_KIND, (data: unknown) => chrisStatusModelSchema.safeParse(data));
      this.chrisRow = model?.chris.find((one: ChrisStatusRow): boolean => one.vm === this.vm) ?? null;
    } catch {
      this.chrisRow = null;
    }
    // The accounts just read are a user line's receipt: its seat reads done once CUBE holds the account.
    this.lines = this.accountsHeld_apply(this.lines);
    this.steps = this.steps_derive(this.lines);
    this.draw();
  }

  /** The machine's own ChRIS is read by `chris_read`; the script screen's every-ChRIS read is not asked here. */
  protected override async chrisSeen_read(): Promise<void> {
    return;
  }

  /** What runs of the machine's ChRIS, for CHRIS and USERS. */
  protected override chrisRow_get(vm: string): ChrisStatusRow | null {
    return this.chrisRow !== null && this.chrisRow.vm === vm ? this.chrisRow : null;
  }

  /** No ChRIS on this machine, as `vm status` read its tag; unread, nothing is said. */
  protected override chrisAbsent_read(vm: string): { at: string | null } | null {
    const row: VmStatusRow | null = this.vmRow_get();
    if (row === null || vm !== this.vm || (row.chris !== null && row.chris !== undefined)) return null;
    return { at: row.stands?.at ?? null };
  }

  /** A user line on this machine is refused when `vm status` reads no ChRIS on it; unread, nothing is said. */
  protected override userAddChris_why(_on: string): string | null {
    const row: VmStatusRow | null = this.vmRow_get();
    if (row === null) return null;
    return row.chris === null || row.chris === undefined ? `NO CHRIS ON ${this.vm.toUpperCase()}` : null;
  }

  /** The machine's USERS are on the machine shown. */
  protected override usersVm_get(_step: ScriptStep): string {
    return this.vm;
  }

  /** `vm status`, for the pills and the header. */
  private async vms_read(): Promise<void> {
    try {
      const answer: QuietAnswer = await this.hooks.ask('vm status');
      const model = this.model_take(answer, STRATUS_VM_STATUS_MODEL_KIND, (data: unknown) => vmStatusModelSchema.safeParse(data));
      if (model !== null) this.vms = model.vms;
    } catch (error: unknown) {
      this.log_add(`vm status: ${error instanceof Error ? error.message : String(error)}`, 'note');
    }
  }

  private vmRow_get(): VmStatusRow | null {
    return this.vms.find((row: VmStatusRow): boolean => row.name === this.vm) ?? null;
  }

  /**
   * The script that declares a VM: its working copy under `/scripts/mine/`
   * first, then the first script in the library whose lines carry `vm new <name>`.
   *
   * @param name - The VM.
   * @returns The script's path, or null when none declares it.
   */
  private async vmScript_find(name: string): Promise<string | null> {
    const listed = async (path: string): Promise<Listed[]> => {
      try { return this.listings_take(await this.hooks.ask(`ls ${path}`)); } catch { return []; }
    };
    const top: Listed[] = await listed('/scripts');
    const folders: string[] = (top[0]?.items ?? []).map((item): string => item.name);
    const ordered: string[] = ['mine', ...folders.filter((folder: string): boolean => folder !== 'mine')];
    for (const folder of ordered) {
      if (!folders.includes(folder)) continue;
      const items: Listed[] = await listed(`/scripts/${folder}`);
      for (const item of items[0]?.items ?? []) {
        if (item.type !== 'script' && !item.name.endsWith('.mise')) continue;
        const path: string = `/scripts/${folder}/${item.name}`;
        const standings = await this.status_read(path);
        if (standings === null) continue;
        if (standings.lines.some((line): boolean => { const parts = line_parse(line.text); return parts.verb.join(' ') === 'vm new' && parts.subject === name; })) return path;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ steps

  /** The VM's lines as its seats, SIZE (with its build), CHRIS, USERS, in that order, then TEARDOWN; a build apart from its declaration is a BUILD seat after SIZE; a seat whose line the script lacks stands over a template line. */
  protected override steps_derive(lines: ReadonlyArray<ScriptLine>): ScriptStep[] {
    if (this.vm === '') return [];
    // A machine this session can only see: what it is, and its undoing; its size, build and ChRIS need its SSH key.
    // A machine it builds on has no MACHINE seat: what it is stands in the header and on SIZE (the operator, 2026-11-06).
    if (vmKeyless_is(this.vmRow_get())) return [{ key: FACTS_KEY, label: 'MACHINE', kind: 'other', lines: [], state: null, running: null, template: true }, { key: TEARDOWN_KEY, label: 'TEARDOWN', kind: 'other', lines: [], state: null, running: null, template: true }];
    const mine: ScriptLine[] = vmLines_filter(lines, this.vm);
    const built: ScriptStep[] = steps_build(mine).map((step: ScriptStep): ScriptStep => ({ ...step, label: VM_SEAT_LABELS[step.kind] ?? step.label }));
    const steps: ScriptStep[] = [];
    for (const label of SEAT_ORDER) {
      const found: ScriptStep | undefined = built.find((step: ScriptStep): boolean => step.label === label);
      if (found !== undefined) { steps.push(found); continue; }
      // SERVICES is the same `vm new` line as SPEC, its ports and public SSH, built with the same BUILD.
      const spec: ScriptStep | undefined = steps.find((step: ScriptStep): boolean => step.label === 'SPEC');
      if (label === 'SERVICES') { if (spec !== undefined) steps.push({ ...spec, key: SERVICES_KEY, label }); continue; }
      const number: number = (lines.at(-1)?.number ?? 0) + 1;
      if (label === 'CHRIS') steps.push({ key: 'chris', label, kind: 'chris deploy', lines: [{ number, text: `chris deploy ${this.vm} --profile minimal --compute ${this.vm}`, state: null, detail: 'not in the script yet: RUN appends it', running: null }], state: null, running: null, template: true });
      else if (label === 'USERS') steps.push({ key: 'users', label, kind: 'users', lines: [], state: null, running: null });
      else if (label === 'TEARDOWN') steps.push({ key: TEARDOWN_KEY, label, kind: 'other', lines: mine.filter((line: ScriptLine): boolean => line_parse(line.text).verb.join(' ') === 'vm build'), state: null, running: null, template: true });
    }
    return steps;
  }

  /** After a line ran, the machine's record is read again with the script's standing: its state, address and lock are the header's and TEARDOWN's. */
  protected override async standings_refresh(): Promise<void> {
    await Promise.all([super.standings_refresh(), this.vms_read()]);
    // What runs of its ChRIS is read again after any line: the receipt of a deploy or an account added.
    await this.chris_read();
    this.follow_auto();
  }

  /** The prices read: the listing's COST column follows them. */
  protected override async standing_read(): Promise<void> {
    await super.standing_read();
    if (this.view === MACHINES_KEY) this.machineRows_set();
  }

  /** The header prices the machine shown, never the tenancy's every machine. */
  protected override costScope_get(): ReadonlyArray<string> | null {
    return this.vm === '' ? null : [this.vm];
  }

  /** What runs of the machine shown, as `vm status` read it from the tenancy: the sizes SIZE renders and offers against. */
  protected override runs_get(name: string): (VmRuns & { at: string }) | null {
    const row: VmStatusRow | null = this.vmRow_get();
    if (row === null || row.name !== name || row.stands === null || row.stands === undefined) return null;
    return row.stands;
  }

  /** BUILD writes the machine's script before it acts, so an edit is never offered a SAVE of its own here. */
  protected override saveOffered(): boolean {
    return false;
  }

  /** On a machine's own screen BUILD is the one commit: a declaration that builds nothing is not offered beside it (a-change-is-a-loop, clause 3). */
  protected override declareOffered(): boolean {
    return false;
  }

  /** The machine's declaration is this host's alone when `vm status` says the tenancy does not keep it. */
  protected override declaredHere_is(_step: ScriptStep): boolean {
    const row: VmStatusRow | null = this.vmRow_get();
    return row !== null && row.declared !== null && row.declared !== undefined && row.declaredKept === false;
  }

  /** A script not on the host yet is read from the screen's lines. */
  protected override statusText_get(): string | null {
    return this.unsaved || this.edited ? script_render(this.lines) : null;
  }

  /** The stage strip names the machine; before it is named, the new one. */
  protected override stageTitle_get(): string {
    if (this.vm === '') return this.view === MACHINES_KEY ? 'THE MACHINES' : 'A NEW MACHINE';
    return this.vm.toUpperCase();
  }

  /** BUILD keeps RUN and the plan; the lock and the undoing are TEARDOWN's seat here. */
  protected override undoing_shown(): boolean {
    return false;
  }

  /**
   * Sends a line; a template seat's line (a CHRIS not in the script yet) is
   * appended to the script first, and a script not on the host yet, or one a
   * form changed, is written first (a script from git to its working copy
   * under `/scripts/mine/`), so the artifact is always ahead of the act and
   * what was declared reads done.
   */
  public override async line_send(line: string, step: string | null, keepLog: boolean = false): Promise<boolean> {
    const shown: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === step);
    if (shown?.template === true && shown.key !== TEARDOWN_KEY) {
      const text: string = vmScript_append(script_render(this.lines), this.vm, line);
      this.lines = lines_build(text, []);
      this.unsaved = true;
      this.edited = true;
    }
    if ((this.unsaved || this.edited) && this.path !== '' && !line.startsWith('touch ')) {
      const target: string = this.unsaved ? this.path : workingCopy_derive(this.path);
      if (!(await super.line_send(saveLine_compose(target, script_render(this.lines)), null))) return false;
      this.path = target;
      this.unsaved = false;
      this.edited = false;
      await this.script_read();
      this.steps = this.steps_derive(this.lines);
      this.draw();
    }
    const building: boolean = this.run !== null && this.run.outcome === null && line.startsWith(`vm build ${this.run.vm}`);
    const ok: boolean = await super.line_send(line, step, keepLog);
    if (building && this.run !== null) {
      // The line's end is the run's: a NO, a refusal, or the change made and read back.
      const declined: boolean = this.refusal?.declined === true && this.refusal.line === line;
      // The session's last word on why, once: its own `vm build:` sentence when it said one.
      const why: string = (this.refusal?.why ?? '').split(/(?=vm build: )/).at(-1)?.replace(/^vm build: /, '').trim() ?? '';
      this.run = buildRun_end(this.run, !ok ? { tone: 'failed', why } : declined ? { tone: 'declined', why: '' } : { tone: 'done', why: '' }, new Date().toISOString());
      // A failure opens the log: what the session said of it is there.
      if (!ok && !this.logOpen) this.logOpen_set(true);
      this.runTick_set(false);
      this.draw();
    }
    return ok;
  }

  /**
   * BUILD on a new machine, its one commit (a-change-is-a-loop, clause 3):
   * the session raised first when it must be, then the script written under
   * `/scripts/mine/` with the line as the levers left it and its build, the
   * line sent (it declares), and the build sent, whose plan, cost and
   * question come in place before anything bills. The machine then stands on
   * its SIZE seat, where the build runs and its receipt lands.
   */
  private async new_build(): Promise<void> {
    const name: string = this.newForm.name.trim();
    const net: string = this.newForm.net.trim();
    if (!vmName_valid(name) || net === '') return;
    const build: string = `vm build ${name}`;
    if (this.hold_derive(build) === 'asks' && this.hooks.elevate_ask !== null && !(await this.hooks.elevate_ask(build))) return;
    this.vm = name;
    this.path = `/scripts/mine/${name}.mise`;
    this.lines = lines_build(vmScript_complete(`${this.newLine_text()}\n`, name), []);
    this.unsaved = true;
    this.steps = this.steps_derive(this.lines);
    this.view = 'line-1';
    if (!(await this.line_send(this.lines[0]?.text ?? '', 'line-1'))) return;
    // The script just written is the machine's: kept as it is (never re-derived from a record), its seats read from it.
    await this.vms_read();
    this.steps = this.steps_derive(this.lines);
    this.view = 'line-1';
    this.draw();
    if (await this.line_send(build, 'line-1', true)) this.builtHere = 'line-1';
    this.draw();
  }

  // ---------------------------------------------------------------- drawing

  /** The gutter: a pill per machine and + NEW; the rail: the VM's seats. */
  protected override rail_draw(): void {
    const views: TakeoverView[] = this.steps.filter((step: ScriptStep): boolean => !SEATS_UNSHOWN.includes(step.label)).map((step: ScriptStep): TakeoverView => ({ key: step.key, label: step.label }));
    if (this.vm === '') {
      views.unshift({ key: NEW_KEY, label: 'NEW · SPEC' });
      if (this.vms.length > 0) views.unshift({ key: MACHINES_KEY, label: 'MACHINES' });
    }
    const shown: string[] = [...this.frame.views.keys()];
    if (shown.length !== views.length || views.some((view: TakeoverView, index: number): boolean => shown[index] !== view.key)) this.frame.views_set(views);
    for (const step of this.steps) {
      const seat: HTMLButtonElement | undefined = this.frame.views.get(step.key);
      if (seat === undefined) continue;
      seat.dataset['state'] = step.state ?? 'none';
      const running: boolean = step.running !== null || (this.busy !== null && this.busy.step === step.key);
      seat.classList.toggle('ss-seat-running', running);
    }
    const seat: HTMLElement = this.frame.seat;
    seat.replaceChildren();
    for (const name of [...this.vms.map((row: VmStatusRow): string => row.name), NEW_KEY]) {
      const pill: HTMLButtonElement = el('button', 'tdc-cluster takeover-seat-pill', name === NEW_KEY ? '+ NEW' : name.toUpperCase());
      pill.type = 'button';
      const row: VmStatusRow | undefined = this.vms.find((each: VmStatusRow): boolean => each.name === name);
      pill.dataset['condition'] = row === undefined ? 'NEW' : row.state.toUpperCase();
      if (row?.state === 'found') pill.title = `found in the tenancy: ${row.found?.state ?? ''}`;
      pill.setAttribute('aria-current', (name === NEW_KEY ? this.vm === '' : this.vm === name) ? 'true' : 'false');
      pill.disabled = this.busy !== null;
      pill.addEventListener('click', (): void => { this.hooks.voice.pill(pill.textContent ?? ''); void this.vm_open(name === NEW_KEY ? '' : name); });
      seat.append(pill);
    }
  }

  /**
   * The header is one band, the same on every seat of a machine: which
   * machine and its condition, the mode, what it costs now, what runs on it,
   * and its lock (the operator, 2026-11-06). What it is in detail is the
   * seat's: the size on SIZE, the ChRIS on CHRIS. On the listing the band is
   * the listing's: how many machines, what they all cost, what runs.
   */
  protected override header_draw(): void {
    const header: HTMLElement = this.parts.header;
    header.replaceChildren();
    header.classList.add('vm-band');
    const row: VmStatusRow | null = this.vmRow_get();
    const listing: boolean = this.vm === '' && this.view === MACHINES_KEY;
    const standing: number = this.vms.filter((one: VmStatusRow): boolean => one.state !== 'gone').length;
    const condition: HTMLElement = el('section', 'tdc-head-condition');
    const pill: HTMLElement = el('div', 'tdc-condition');
    const word: string = listing ? String(standing) : vmCondition_derive(row, this.busy !== null || this.run?.outcome === null);
    pill.dataset['condition'] = listing ? 'MACHINES' : word;
    if (word.length > 9) pill.classList.add('tdc-condition-long');
    pill.append(el('span', 'tdc-condition-label', listing ? `MACHINE${standing === 1 ? '' : 'S'} IN THE TENANCY` : this.vm === '' ? 'A NEW MACHINE' : this.vm.toUpperCase()), el('span', 'tdc-condition-name', word));
    const mode: HTMLElement | null = modePill_make(this.hooks.manage_is());
    condition.append(pill, ...(mode === null ? [] : [mode]));
    const chips: HTMLElement = el('div', 'tdc-chips');
    if (row !== null && vmKeyless_is(row)) chips.append(el('span', 'tdc-chip', row.state === 'found' ? (row.found?.tagged === true ? 'FOUND · NOT READ' : 'MADE OUTSIDE STRATUS') : 'NO SSH KEY IN THE TENANCY'));
    if (row !== null) chips.append(el('span', `tdc-chip tdc-lock${row.protected ? ' tdc-lock-on' : ' tdc-lock-off'}`, row.protected ? 'PROTECTED' : 'UNLOCKED'));
    // Said only while it is true: an edit not yet built is the screen's, and BUILD writes it first.
    if (this.vm !== '' && this.edited && !vmKeyless_is(row)) chips.append(el('span', 'tdc-chip vm-chip-edited', 'EDITED · NOT BUILT'));
    else if (this.vm !== '' && this.unsaved && !vmKeyless_is(row)) chips.append(el('span', 'tdc-chip', 'SCRIPT NOT WRITTEN YET'));
    if (chips.childElementCount > 0) condition.append(chips);
    header.append(condition, this.costSection_make(), this.bandRunning_make());
  }

  /** What it costs now, read from the tenancy with when: the machine shown, or on the listing every machine. What a change would cost is SIZE's. */
  protected override costSection_make(): HTMLElement {
    const now: string = this.standingAt === null ? 'not read from the tenancy yet' : this.standing === null ? 'not priced' : `${rate_words(this.standing, HOURS_PER_MONTH)} · READ ${this.standingAt.slice(11, 16)}`;
    return this.headSection_make(this.vm === '' ? 'COST · EVERY MACHINE · LIST PRICE' : 'COST · LIST PRICE', [['NOW', now]], 0);
  }

  /** What runs: the build in flight with its step and time, a task followed or not, or nothing; STOP FOLLOWING or FOLLOW beside it. */
  private bandRunning_make(): HTMLElement {
    const running: ScriptStep | undefined = runningStep_find(this.steps);
    const pills: HTMLElement[] = [];
    let rows: Array<[string, string]>;
    if (this.run !== null && this.run.outcome === null) {
      const going = BUILD_PHASES.find((phase): boolean => this.run?.phases[phase.key] === 'going');
      const at: number = going === undefined ? 0 : BUILD_PHASES.indexOf(going) + 1;
      // Before its first task the build writes the script and its declaration: said, never a bare `starting`.
      rows = [['BUILD', `${this.run.vm}${this.run.change === '' ? '' : ` · ${this.run.change}`}`], ['NOW', going === undefined ? 'starting' : going.key === 'prepare' ? `${going.label} · ${this.preparing_word()} · ${at} OF ${BUILD_PHASES.length}` : `${going.label} · ${at} OF ${BUILD_PHASES.length}`], ['FOR', duration_text(Date.now() - this.run.since)]];
    } else if (this.busy !== null) {
      rows = [['LINE', this.busy.line], ['FOR', duration_text(Date.now() - this.busy.since)]];
    } else if (running !== undefined && running.running !== null) {
      rows = [['TASK', running.running], ['FOR', this.followDeclined ? 'not followed: FOLLOW follows it' : 'following']];
    } else {
      rows = [['NOTHING', 'runs now']];
    }
    if (this.busy !== null && this.ask === null && this.following_is()) {
      const stop: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet', 'STOP FOLLOWING');
      stop.type = 'button';
      stop.title = 'frees the screen; the task goes on, and FOLLOW follows it again';
      stop.addEventListener('click', (): void => { this.hooks.voice.pill('STOP FOLLOWING'); this.followDeclined = true; this.log_add('^C (stops following, not the task)', 'note'); this.hooks.stop(); });
      pills.push(stop);
    } else if (this.busy === null && running?.running != null && this.followDeclined) {
      const follow: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', 'FOLLOW');
      follow.type = 'button';
      follow.title = `sends: wait ${running.running}`;
      follow.addEventListener('click', (): void => { this.hooks.voice.pill('FOLLOW'); this.followDeclined = false; this.running_follow(); });
      pills.push(follow);
    }
    return this.headSection_make('RUNNING', rows, -1, pills);
  }

  protected override body_draw(): void {
    const own: Record<string, () => HTMLElement[]> = {
      [MACHINES_KEY]: (): HTMLElement[] => this.machines_make(),
      [FACTS_KEY]: (): HTMLElement[] => this.facts_make(),
      [NEW_KEY]: (): HTMLElement[] => this.new_make(),
      [TEARDOWN_KEY]: (): HTMLElement[] => this.teardown_make(),
    };
    const make: (() => HTMLElement[]) | undefined = own[this.view];
    // A seat whose line the script lacked (CHRIS before its deploy line) gets the line's key once RUN appends it:
    // the view follows its seat by name, so RUN never leaves the screen on no step.
    const shownStep: ScriptStep | undefined = this.steps.find((step: ScriptStep): boolean => step.key === this.view);
    if (shownStep !== undefined) this.viewLabel = shownStep.label;
    else if (make === undefined && this.viewLabel !== '') {
      const same: ScriptStep | undefined = this.steps.find((step: ScriptStep): boolean => step.label === this.viewLabel);
      if (same !== undefined) { this.view = same.key; this.frame.view_mark(same.key); }
    }
    if (make === undefined) {
      super.body_draw();
      const panes: number = [...this.parts.body.children].filter((child: Element): boolean => child.tagName === 'SECTION').length;
      if (this.parts.body.dataset['view'] === 'step') this.parts.body.dataset['view'] = panes <= 1 ? 'vm-one' : 'vm-two';
      return;
    }
    const body: HTMLElement = this.parts.body;
    body.replaceChildren();
    const nodes: HTMLElement[] = make();
    // One pane, or two (TEARDOWN's blocks and its guard); never a log column: the VM LOG is the one log.
    body.dataset['view'] = nodes.length === 1 ? 'vm-one' : 'vm-two';
    body.append(...nodes);
    this.refusal_place();
    this.saved_place();
    this.errand_place();
  }

  /**
   * MACHINES: every VM the tenancy runs as an ARGUS listing, a row a machine
   * (its name, condition, address, size, data, ChRIS, cost and read time),
   * a press on the row opening it; + NEW MACHINE under it.
   */
  private machines_make(): HTMLElement[] {
    const list: HTMLElement = el('section', 'ss-col-wide vm-machines');
    if (this.machineListingMount === null) {
      this.machineListingMount = el('section', 'vm-machines-listing');
      this.machineListingMount.setAttribute('aria-label', 'The machines the tenancy runs');
      this.machineListing = new Listing<VmStatusRow>({
        mount: this.machineListingMount,
        traits: this.machineTraits_declare(),
        key: (row: VmStatusRow): string => row.name,
        caps: 'root',
        activate: (row: VmStatusRow): void => { if (this.busy === null) { this.hooks.voice.pill(row.name.toUpperCase()); void this.vm_open(row.name); } },
        row: { className: (row: VmStatusRow): string => `vm-row vm-row-${row.state.replace(/\s+/g, '-')}`, decorate: (element: HTMLElement, row: VmStatusRow): void => { element.title = `opens ${row.name}`; } },
        empty: (): HTMLElement => el('p', 'tdc-prose tdc-quiet', 'The tenancy runs no machine outside a cluster.'),
      });
    }
    list.append(this.machineListingMount);
    this.machineRows_set();
    const commands: HTMLElement = el('div', 'tdc-commands');
    const add: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain vm-new-open', '+ NEW MACHINE');
    add.type = 'button';
    add.disabled = this.busy !== null;
    add.addEventListener('click', (): void => { this.view_press(NEW_KEY); });
    commands.append(add);
    list.append(commands);
    return [list];
  }

  /**
   * The machines into the listing. Every ARGUS listing leads with an index
   * pill, the number `@N` takes for a row the session can name; no line
   * names a machine by its row, so the pill would be a bare count: its track
   * is folded to nothing here (the operator, 2026-11-06).
   */
  private machineRows_set(): void {
    const mount: HTMLElement | null = this.machineListingMount;
    this.machineListing?.rows_set([{ key: 'machines', rows: this.vms }], { field: 'machines' });
    if (mount === null) return;
    const cols: string = mount.style.getPropertyValue('--roster-cols');
    if (cols.startsWith('5.2rem ')) mount.style.setProperty('--roster-cols', `0px ${cols.slice('5.2rem '.length)}`);
  }

  /** The listing's columns: what each machine is, read from the tenancy. */
  private machineTraits_declare(): ReadonlyArray<ListingTrait<VmStatusRow>> {
    const size = (row: VmStatusRow): string => {
      const stands = row.stands ?? null;
      if (stands !== null) return stands.vcpu === null ? 'no machine' : `${stands.vcpu} vCPU · ${stands.memory ?? '?'} GiB · disk ${stands.disk ?? '?'} GB`;
      if (row.state === 'gone') return '—';
      if (row.spec !== null) return `${row.spec.vcpu} vCPU · ${row.spec.memory} GiB (declared)`;
      return row.found?.vcpus != null ? `${row.found.vcpus} vCPU${row.found.memoryGib != null ? ` · ${row.found.memoryGib} GiB` : ''}` : '—';
    };
    const chris = (row: VmStatusRow): string => row.chris?.host ?? (row.chris != null ? row.chris.url.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '') : row.found?.chris != null ? row.found.chris.url.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '') : '—');
    // What it bills as it runs, read from the tenancy; nothing read, nothing said.
    const cost = (row: VmStatusRow): string => { const rate: VmCostRate | null | undefined = this.costRows.get(row.name)?.runs?.rate; return rate == null ? '—' : `${money_text((rate.machineHour + rate.dataHour) * HOURS_PER_MONTH, rate.currency)}/MO`; };
    return [
      { key: 'name', label: 'NAME', className: 'vm-cell-name', width: 'minmax(6em, 1fr)', cell: (row: VmStatusRow): string => row.name },
      { key: 'state', label: 'STATE', className: 'vm-cell-state', width: 'minmax(6em, 9em)', cell: (row: VmStatusRow): string => (row.running != null ? `${row.running.what} · since ${row.running.since.slice(11, 16)}` : vmCondition_derive(row, false)) },
      { key: 'address', label: 'ADDRESS', className: 'vm-cell-address', width: 'minmax(8em, 10em)', shed: 3, cell: (row: VmStatusRow): string => row.address ?? '—' },
      { key: 'size', label: 'SIZE', className: 'vm-cell-size', width: 'minmax(12em, 16em)', shed: 2, cell: size },
      { key: 'data', label: 'DATA', className: 'vm-cell-data', width: 'minmax(5em, 6em)', shed: 4, cell: (row: VmStatusRow): string => (row.stands != null ? (row.stands.data === null ? 'none' : `${row.stands.data} GB`) : row.spec !== null ? `${row.spec.data} GB` : '—'), compare: (row: VmStatusRow): number => row.stands?.data ?? row.spec?.data ?? 0 },
      { key: 'chris', label: 'CHRIS', className: 'vm-cell-chris', width: 'minmax(10em, 14em)', shed: 1, cell: chris },
      { key: 'cost', label: 'COST', className: 'vm-cell-cost', width: 'minmax(6em, 7em)', shed: 5, cell: cost },
      { key: 'read', label: 'READ', className: 'vm-cell-read', width: 'minmax(4em, 5em)', shed: 6, cell: (row: VmStatusRow): string => row.stands?.at.slice(11, 16) ?? '—' },
    ];
  }

  /** MACHINE, for a machine this session can only see: what the tenancy says it is, and why nothing but its teardown is offered. */
  private facts_make(): HTMLElement[] {
    const row: VmStatusRow | null = this.vmRow_get();
    const facts: HTMLElement = this.section_make('THE MACHINE', 'ss-col-wide', row === null ? 'NOT KEPT HERE' : row.region.toUpperCase());
    if (row === null) {
      facts.append(el('p', 'tdc-prose', `The tenancy runs no machine called ${this.vm}.`));
      return [facts];
    }
    const size: string = row.found !== null && row.found !== undefined ? `${row.found.shape ?? '?'}${row.found.vcpus != null ? ` · ${row.found.vcpus} vCPU` : ''}${row.found.memoryGib != null ? ` · ${row.found.memoryGib} GiB` : ''}` : row.spec !== null ? `${row.spec.vcpu} vCPU · ${row.spec.memory} GiB · disk ${row.spec.disk} GB · data ${row.spec.data} GB` : '—';
    facts.append(this.pairs_make([
      ['DOING', row.state === 'found' ? (row.found?.state ?? '?') : row.state],
      ['SIZE', size],
      ['ADDRESS', `${row.address ?? '—'}${row.inside != null ? ` · inside ${row.inside}` : ''}`],
      ['INSTANCE', row.found?.instanceId ?? row.instance ?? '—'],
      ['CHRIS', row.found?.chris != null ? `${row.found.chris.url} (as its instance's tag says)` : row.chris != null ? row.chris.url : 'not said on the machine'],
    ]));
    const why: string = row.state === 'found'
      ? (row.found?.tagged === true ? 'found: built by stratus, and its stacks did not read into this host. TEARDOWN removes it.' : 'Made outside stratus: seen here, changed in the cloud\'s own console. TEARDOWN removes it.')
      : 'Read from the tenancy, which keeps no SSH key for it (built before stratus kept keys there): vm keep, on the host that holds the key, keeps it. Its size, build and ChRIS need that key; TEARDOWN removes it.';
    facts.append(el('p', 'tdc-prose', why));
    return [facts];
  }

  // -------------------------------------------------------------- SERVICES

  /** A service being added: its kind, port, and for public SSH the user and the key or key file. */
  private serviceDraft: { kind: 'WEB' | 'CUSTOM' | 'SSH'; port: string; user: string; key: string } = { kind: 'CUSTOM', port: '', user: 'ops', key: '' };

  /** What SERVICES' line would change against what runs, in words. */
  private servicesChange_get(): string[] {
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === SERVICES_KEY);
    const line: ScriptLine | undefined = step?.lines[0];
    const row: VmStatusRow | null = this.vmRow_get();
    if (line === undefined || row === null) return [];
    const runs = this.runs_get(line_parse(line.text).subject ?? '');
    return vmServices_change(vmServices_read(line.text, row.spec?.ssh ?? null), runs?.open ?? null, row.host);
  }

  /**
   * SERVICES, one pane (the operator, 2026-11-07): what the machine opens to
   * the internet, a row each, what answers there and whether the tenancy
   * opens it; public SSH with its user, key and warning; ADD SERVICE; the
   * change against what runs and BUILD saying it. A build in flight stands
   * at the top as one run, as on SPEC.
   */
  private services_make(step: ScriptStep): HTMLElement {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const built: ScriptLine | undefined = stepBuildLine_get(step);
    const row: VmStatusRow | null = this.vmRow_get();
    const runs = this.runs_get(line_parse(line.text).subject ?? '');
    const declared = vmServices_read(line.text, row?.spec?.ssh ?? null);
    const pane: HTMLElement = this.section_make('THE SERVICES', 'ss-col-wide vm-services', runs === null ? 'NOT BUILT YET' : `OPEN IN THE TENANCY · READ ${runs.at.slice(11, 16)} UTC`);
    const ours: boolean = this.run !== null && this.run.vm === this.vm;
    if (ours && this.run !== null) pane.append(this.run_make(this.run));
    const list: HTMLElement = el('div', 'vm-services-list');
    list.append(this.serviceHead_make());
    for (const port of declared.open) list.append(this.serviceRow_make(line, port, declared.open, runs?.open ?? null));
    if (declared.ssh !== null) list.append(this.sshRow_make(line, declared.ssh, row));
    if (declared.open.length === 0 && declared.ssh === null) list.append(el('p', 'tdc-prose tdc-quiet', 'Nothing is open to the internet: the network\'s bastion is the only way to the machine.'));
    pane.append(list, this.serviceAdd_make(line, declared.open, declared.ssh !== null));
    const words: string[] = this.servicesChange_get();
    if (!ours || (this.run?.outcome != null && words.length > 0)) pane.append(this.servicesCommit_make(step, line, built, words));
    // The line as it will run: SERVICES writes on the same `vm new` line as SPEC.
    const script: HTMLElement = el('div', 'vm-size-lines');
    script.append(el('span', 'tdc-section-title', `THE SCRIPT · ${this.path === '' ? 'NOT WRITTEN YET' : this.path}`), this.lineBoxNumbered_make(line));
    pane.append(script);
    return pane;
  }

  /** The services list's head row. */
  private serviceHead_make(): HTMLElement {
    const head: HTMLElement = el('div', 'vm-service vm-service-head');
    for (const word of ['KIND', 'PORT', 'WHAT ANSWERS', 'IN THE TENANCY', '']) head.append(el('span', 'tdc-pair-label', word));
    return head;
  }

  /** One port the line opens: its kind, what answers there (read live for the web's), whether the tenancy opens it, REMOVE. */
  private serviceRow_make(line: ScriptLine, port: number, open: ReadonlyArray<number>, runs: ReadonlyArray<number> | null): HTMLElement {
    const kind: 'WEB' | 'CUSTOM' = vmServiceKind_derive(port);
    const chris: ChrisStatusRow | null = this.chrisRow_get(this.vm);
    const live = chris?.live ?? null;
    const answers: string = kind === 'CUSTOM' || chris === null ? 'nothing stratus put up answers here'
      : `Caddy: CUBE ${live === null ? '(not read)' : live.cube.status === null ? 'does not answer' : `answers ${live.cube.status}`}${chris.porter !== null ? ` · porter ${live?.porter == null ? '(not read)' : live.porter.status === null ? 'does not answer' : `answers ${live.porter.status}`}` : ''}${live !== null ? ` · read ${live.at.slice(11, 16)}` : ''}`;
    const item: HTMLElement = el('div', 'vm-service');
    item.append(
      el('span', `vm-service-kind vm-service-${kind.toLowerCase()}`, kind),
      el('span', 'vm-service-port', String(port)),
      el('span', 'vm-service-answers', answers),
      el('span', 'ss-field-runs', runs === null ? '—' : runs.includes(port) ? 'OPEN' : 'NOT OPEN YET'),
    );
    const remove: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet vm-service-remove', 'REMOVE');
    remove.type = 'button';
    remove.disabled = this.busy !== null;
    remove.addEventListener('click', (): void => {
      this.hooks.voice.pill('REMOVE');
      const rest: number[] = open.filter((each: number): boolean => each !== port);
      line.text = lineOption_set(line.text, '--open', rest.length === 0 ? 'none' : rest.join(','));
      this.edited = true;
      this.draw();
    });
    item.append(remove);
    return item;
  }

  /** Public SSH: its port, user and key, open or closed as declared and as the machine was set up, the warning, OPEN or CLOSE. */
  private sshRow_make(line: ScriptLine, ssh: { port: number | null; user: string; key: string | null; keyFile: string | null; on: boolean }, row: VmStatusRow | null): HTMLElement {
    const box: HTMLElement = el('div', 'vm-service-ssh');
    const item: HTMLElement = el('div', 'vm-service');
    const host = row?.host?.ssh ?? null;
    const machine: string = host === null ? 'NOT SET UP YET' : host.on ? `SET UP · OPEN ON ${host.port}` : `SET UP · CLOSED (${host.user} KEPT)`;
    const key: string = ssh.keyFile !== null ? `key from ${ssh.keyFile}` : ssh.key === null ? 'no key' : `key …${(ssh.key.split(' ')[1] ?? '').slice(-10)}${ssh.key.split(' ')[2] !== undefined ? ` (${ssh.key.split(' ').slice(2).join(' ')})` : ''}`;
    item.append(
      el('span', 'vm-service-kind vm-service-ssh-kind', 'PUBLIC SSH'),
      el('span', 'vm-service-port', ssh.port === null ? '—' : String(ssh.port)),
      el('span', 'vm-service-answers', `${ssh.on ? 'open' : 'closed'} for ${ssh.user} · ${key} · password login off · sudo`),
      el('span', 'ss-field-runs', machine),
    );
    const toggle: HTMLButtonElement = el('button', `tdc-pill${ssh.on ? ' tdc-pill-quiet' : ''} vm-service-remove`, ssh.on ? 'CLOSE' : 'OPEN');
    toggle.type = 'button';
    toggle.disabled = this.busy !== null || (!ssh.on && ssh.port === null);
    toggle.addEventListener('click', (): void => {
      this.hooks.voice.pill(toggle.textContent ?? '');
      line.text = lineOption_set(line.text, '--ssh', ssh.on ? 'off' : String(ssh.port));
      this.edited = true;
      this.draw();
    });
    item.append(toggle);
    box.append(item, el('p', 'tdc-prose ss-would-reboot vm-service-warning', ssh.on
      ? `SSH answers the internet on port ${ssh.port ?? '?'}: anyone can knock, only ${ssh.user}'s key gets in, and ${ssh.user} has sudo. The network's bastion stays the operator's way in without it.`
      : `Closed: ${ssh.user} and its key stay on the machine; OPEN brings the port back.`));
    return box;
  }

  /** ADD SERVICE: a kind, a port, and for public SSH its user and public key (pasted, or a key file on this host); ADD writes it on the line. */
  private serviceAdd_make(line: ScriptLine, open: ReadonlyArray<number>, sshDeclared: boolean): HTMLElement {
    const box: HTMLElement = el('div', 'vm-service-add');
    box.append(el('span', 'tdc-section-title', 'ADD SERVICE'));
    const kinds: HTMLElement = el('div', 'tdc-families');
    const draft = this.serviceDraft;
    for (const kind of ['WEB', 'CUSTOM', 'SSH'] as const) {
      if (kind === 'SSH' && sshDeclared) continue;
      const pill: HTMLButtonElement = el('button', `tdc-family${draft.kind === kind ? ' tdc-family-on' : ''}`, kind === 'SSH' ? 'PUBLIC SSH' : kind);
      pill.type = 'button';
      pill.disabled = this.busy !== null;
      pill.addEventListener('click', (): void => { this.serviceDraft = { ...draft, kind, port: kind === 'WEB' ? (open.includes(80) ? '443' : '80') : kind === 'SSH' ? '2222' : '' }; this.draw(); });
      kinds.append(pill);
    }
    box.append(kinds);
    const field = (label: string, value: string, placeholder: string, set: (value: string) => void, wide: boolean = false): HTMLElement => {
      const row: HTMLElement = el('div', `tdc-name-row${wide ? ' vm-service-key' : ''}`);
      const tag: HTMLElement = el('label', 'tdc-pair-label', label);
      const input: HTMLInputElement = el('input', 'tdc-name-input');
      input.id = `vm-service-${label.toLowerCase().replace(/\s+/g, '-')}`;
      tag.setAttribute('for', input.id);
      input.value = value;
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.disabled = this.busy !== null;
      input.addEventListener('input', (): void => set(input.value));
      row.append(tag, input);
      return row;
    };
    box.append(field('PORT', draft.port, draft.kind === 'WEB' ? '80 or 443' : '1–65535', (value: string): void => { draft.port = value.trim(); }));
    if (draft.kind === 'SSH') {
      box.append(
        field('USER', draft.user, 'ops · a Linux user, not a ChRIS account', (value: string): void => { draft.user = value.trim(); }),
        field('PUBLIC KEY', draft.key, 'ssh-ed25519 AAAA… you@host, or a .pub file on this host (~/.ssh/id_ed25519.pub)', (value: string): void => { draft.key = value.trim(); }, true),
        el('p', 'tdc-prose ss-would-reboot', 'Public SSH opens a port to the internet for one administrative user, key-only, with sudo. Off by default; the network\'s bastion reaches the machine without it.'),
      );
    }
    const add: HTMLButtonElement = el('button', 'tdc-pill', 'ADD');
    add.type = 'button';
    add.disabled = this.busy !== null;
    add.addEventListener('click', (): void => {
      this.hooks.voice.pill('ADD');
      const port: number = Number(draft.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { this.refusal_say(line.text, 'a port is a whole number from 1 to 65535'); return; }
      if (open.includes(port)) { this.refusal_say(line.text, `${port} is open already`); return; }
      if (draft.kind === 'SSH') {
        if (draft.key === '') { this.refusal_say(line.text, 'public SSH needs the user\'s public key, pasted or as a .pub file'); return; }
        let text: string = lineOption_set(line.text, '--ssh', String(port));
        text = lineOption_set(text, '--ssh-user', draft.user === '' ? 'ops' : draft.user);
        text = draft.key.startsWith('ssh-') || draft.key.startsWith('ecdsa-') || draft.key.startsWith('sk-')
          ? lineOption_set(lineOption_set(text, '--ssh-key-file', ''), '--ssh-key', draft.key)
          : lineOption_set(lineOption_set(text, '--ssh-key', ''), '--ssh-key-file', draft.key);
        line.text = text;
      } else {
        line.text = lineOption_set(line.text, '--open', [...open, port].sort((a: number, b: number): number => a - b).join(','));
      }
      this.serviceDraft = { kind: 'CUSTOM', port: '', user: 'ops', key: '' };
      this.edited = true;
      this.draw();
    });
    box.append(add);
    return box;
  }

  /** SERVICES' change against what runs, and BUILD saying it; nothing to change, nothing offered. */
  private servicesCommit_make(step: ScriptStep, line: ScriptLine, built: ScriptLine | undefined, words: string[]): HTMLElement {
    const box: HTMLElement = el('div', 'vm-change vm-services-change');
    if (words.length === 0) {
      box.append(el('div', 'vm-change-word', 'NOTHING CHANGES'), el('p', 'tdc-prose tdc-quiet', 'What the line opens is what the tenancy opens.'));
      return box;
    }
    box.append(el('div', 'vm-change-word', words.join(' · ').toUpperCase()), el('p', 'tdc-prose', 'Nothing bills: a port is a rule in the tenancy and in the machine\'s own firewall. BUILD asks first, then opens or closes them and sets the machine up over the bastion.'));
    if (built !== undefined) {
      // loop: vm-services-build
      const build: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-bill ss-build vm-build', `BUILD · ${words.join(' · ')}`);
      build.type = 'button';
      build.disabled = this.busy !== null;
      build.addEventListener('click', (): void => { this.hooks.voice.pill('BUILD'); void this.declaredBuild_send(line.text, built.text, step.key); });
      box.append(build);
    }
    return box;
  }

  /**
   * Says why an edit was not made, where the control stands.
   *
   * @param line - The line edited.
   * @param why - Why not.
   */
  private refusal_say(line: string, why: string): void {
    this.refusal = { view: this.view, line, at: new Date().toISOString(), why, declined: false };
    this.draw();
  }

  // ------------------------------------------------------------------ CHRIS

  /**
   * CHRIS, one pane (the operator, 2026-11-07): each part of the ChRIS as the
   * line declares it beside what runs, the line's fields, RUN saying what a
   * replay does, then its accounts, each with its host access (berths, the
   * per-user shells, are the next step: said, never a control yet).
   */
  private chris_make(step: ScriptStep): HTMLElement {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const chris: ChrisStatusRow | null = this.chrisRow_get(this.vm);
    const live = chris?.live ?? null;
    const pane: HTMLElement = this.section_make('THE CHRIS', 'ss-col-wide vm-chris', live === null ? (chris === null ? 'NONE DEPLOYED' : 'NOT READ') : `READ FROM IT ${live.at.slice(11, 16)} UTC`);
    const running: HTMLElement | null = this.runningNote_make(step);
    if (running !== null) pane.append(running);
    const declared = (word: string, fallback: string): string => lineOption_get(line.text, word) ?? fallback;
    if (chris !== null) {
      const cube: string = live === null ? 'not read' : live.cube.status === null ? 'does not answer' : `answers ${live.cube.status}${live.cube.admin === true ? ' · chris signs in' : live.cube.admin === false ? ' · chris does not sign in' : ''}`;
      const porter: string = chris.porter === null ? 'none deployed' : live?.porter == null ? 'not read' : live.porter.status === null ? 'does not answer' : `answers ${live.porter.status}${live.porter.version !== null ? ` · ${live.porter.version}` : ''}${live.porter.sessions !== null ? ` · ${live.porter.sessions} open` : ''}`;
      pane.append(this.pairs_make([
        ['CUBE ANSWERS', `${chris.url} · ${cube}`], ['THE DOOR', porter],
        ...(chris.image !== null ? [['IMAGE', `${chris.image}${chris.porterVersion !== null ? ` · porter ${chris.porterVersion}` : ''}`] as [string, string]] : []),
        ['DEPLOYED', `${chris.deployed.slice(0, 16).replace('T', ' ')} UTC (the last deploy kept)`],
      ]));
    } else if (this.chrisAbsent_read(this.vm) !== null) {
      pane.append(this.pairs_make([['CUBE', `none deployed on ${this.vm}`], ['THE DOOR', 'no porter deployed']]));
    }
    const profiles: HTMLElement = el('div', 'tdc-families');
    profiles.append(el('span', 'tdc-pair-label', 'PROFILE'));
    const chosen: string = declared('--profile', 'minimal');
    for (const profile of [...new Set([chosen, 'minimal', 'complete'])]) {
      const pill: HTMLButtonElement = el('button', `tdc-family${profile === chosen ? ' tdc-family-on' : ''}`, profile.toUpperCase());
      pill.type = 'button';
      pill.disabled = this.busy !== null;
      pill.addEventListener('click', (): void => { this.hooks.voice.pill(profile); line.text = lineOption_set(line.text, '--profile', profile); this.edited = true; this.draw(); });
      profiles.append(pill);
    }
    // Each field with what runs beside it, as SPEC's levers: the line and the ChRIS read together, never twice.
    const runs = (node: HTMLElement, has: string | null): HTMLElement => { if (chris !== null) node.append(el('span', 'ss-field-runs', `RUNS ${(has ?? 'none').toUpperCase()}`)); return node; };
    pane.append(
      runs(profiles, chris?.profile ?? null),
      runs(this.optionField_make(line, '--compute', 'COMPUTE', `the pfcon resource's name (default ${this.vm})`), chris?.compute ?? null),
      runs(this.optionField_make(line, '--host', 'HOST', 'cube.example.org · empty: by address'), chris === null ? null : chris.host ?? 'by address'),
      runs(this.optionField_make(line, '--porter', 'PORTER', 'porter.example.org · the door to mise beside it'), chris?.porter ?? null),
      this.lineBoxNumbered_make(line),
      this.chrisPlanNote_make(line),
      // loop: ss-chris-deploy
      this.runRow_make(step, line, 'bill'),
    );
    const users: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.kind === 'users');
    const accounts: HTMLElement = el('div', 'vm-chris-users');
    accounts.append(el('span', 'tdc-section-title', 'ITS ACCOUNTS · EACH WITH ITS HOST ACCESS'));
    if (live?.accounts != null) {
      const lined: Set<string> = new Set((users?.lines ?? []).map((one: ScriptLine): string => line_parse(one.text).subject ?? '').filter((name: string): boolean => name !== ''));
      const held: Set<string> = new Set(live.accounts.map((one): string => one.username));
      const list: HTMLElement = el('div', 'vm-chris-accounts');
      for (const name of [...new Set([...lined, ...held])]) {
        list.append(el('span', 'vm-chris-account', name), el('span', 'ss-field-runs', held.has(name) ? (lined.has(name) ? 'IN CUBE · A LINE OF THE SCRIPT' : `IN CUBE · NO LINE${name === 'chris' ? ' (THE ADMIN)' : ''}`) : 'NOT IN CUBE YET · ITS LINE ADDS IT'), el('span', 'tdc-quiet vm-chris-access', 'HOST ACCESS · berths not built yet'));
      }
      accounts.append(list);
    } else if (chris !== null) {
      accounts.append(el('p', 'tdc-prose tdc-quiet', `CUBE's accounts were not read${live?.accountsWhy ? `: ${live.accountsWhy}` : ''}.`));
    }
    // The accounts as CUBE holds them first, then the script's user lines and THE NEXT USER.
    if (users !== undefined) accounts.append(...this.users_make(users));
    pane.append(accounts);
    return pane;
  }

  // ------------------------------------------------------------------ SIZE

  /** A machine's seats: SIZE is one pane of its own; the others are the script screen's, without the log column (the VM LOG is the one log). */
  protected override step_make(step: ScriptStep): HTMLElement[] {
    if (step.key === SERVICES_KEY) return [this.services_make(step)];
    if (step.kind === 'vm new') return [this.size_make(step)];
    if (step.kind === 'chris deploy') return [this.chris_make(step)];
    return super.step_make(step).filter((node: HTMLElement): boolean => !node.classList.contains('tdc-col-steplog'));
  }

  /**
   * SIZE, one pane (the operator, 2026-11-06): each lever with what runs, the
   * value offered and its share of the cost; under them the whole change in
   * money, what it means, and BUILD saying what it does and what it costs;
   * then the ports, the OS and the lines as they will run. A build in flight
   * or just ended stands at the top as one run.
   */
  private size_make(step: ScriptStep): HTMLElement {
    const line: ScriptLine = step.lines[0] as ScriptLine;
    const built: ScriptLine | undefined = stepBuildLine_get(step);
    const name: string = line_parse(line.text).subject ?? '';
    const runs = this.runs_get(name);
    const pane: HTMLElement = this.section_make('THE SPEC', 'ss-col-wide vm-size', runs === null ? 'NOT BUILT YET' : `RUNS AS READ FROM THE TENANCY ${runs.at.slice(11, 16)} UTC`);
    if (this.run !== null && this.run.vm === this.vm) pane.append(this.run_make(this.run));
    // The levers and the change they make side by side, so the change and BUILD stand in view with the run above them.
    const main: HTMLElement = el('div', 'vm-size-main');
    if (this.limits === null) {
      main.append(el('p', 'tdc-prose tdc-quiet', 'reading what the shape sells: vm limits'));
    } else {
      const limits: VmLimitsModel = this.limits;
      const group: HTMLElement = el('div', 'tdc-lever-group vm-levers');
      group.append(el('span', 'tdc-section-title', limits.shape));
      for (const spec of vmSliders_build(limits)) group.append(this.lever_make(line, spec, limits));
      group.append(this.backup_make(line, runs?.backup ?? null));
      main.append(group);
    }
    // The offer is spent once pressed: while its run runs only the run speaks, and after it the offer returns only if
    // something is still to build (the operator, 2026-11-07).
    const ours: boolean = this.run !== null && this.run.vm === this.vm;
    const offered: boolean = !ours || (this.run?.outcome != null && this.would_get().would.length > 0);
    if (offered) main.append(this.change_make(step, line, built));
    // While a run speaks the offer is not drawn: the levers take the whole width (the operator, 2026-11-07).
    else main.classList.add('vm-size-main-full');
    pane.append(main);
    // What else the machine is: its OS as a field with what runs beside it; where it stands. Its ports are SERVICES'.
    const os: HTMLElement = this.optionField_make(line, '--os', 'OS', 'ubuntu-26.04');
    if (runs?.os != null) os.append(el('span', 'ss-field-runs', `RUNS ${runs.os.toUpperCase()}`));
    const row: VmStatusRow | null = this.vmRow_get();
    const where: HTMLElement = this.pairs_make([
      ['NETWORK', lineOption_get(line.text, '--net') ?? '—'],
      ['ADDRESS', `${row?.address ?? '—'}${row?.inside != null ? ` · inside ${row.inside}` : ''}`],
    ]);
    const script: HTMLElement = el('div', 'vm-size-lines');
    script.append(el('span', 'tdc-section-title', `THE SCRIPT · ${this.path === '' ? 'NOT WRITTEN YET' : this.path}`), this.lineBoxNumbered_make(line), ...(built === undefined ? [] : [this.lineBoxNumbered_make(built)]));
    pane.append(os, where, script);
    this.sizeCost_need(line);
    return pane;
  }

  /** One lever: its slider (with what runs beside it), and its share of the change a month. */
  private lever_make(line: ScriptLine, spec: SliderSpec, limits: VmLimitsModel): HTMLElement {
    const row: HTMLElement = this.slider_make(line, spec, limits);
    row.classList.add('vm-lever');
    const delta: HTMLElement = el('span', 'vm-lever-delta', '');
    delta.dataset['word'] = spec.word;
    row.append(delta);
    return row;
  }

  /** DATA BACKUP as two pills, with what runs and its share of the change. */
  private backup_make(line: ScriptLine, runs: string | null): HTMLElement {
    const backup: HTMLElement = el('div', 'tdc-families vm-lever-backup');
    backup.append(el('span', 'tdc-pair-label', 'DATA BACKUP'));
    for (const choice of ['daily', 'none']) {
      const pill: HTMLButtonElement = el('button', `tdc-family${(vmLevers_read(line.text).dataBackup ?? 'none') === choice ? ' tdc-family-on' : ''}`, choice.toUpperCase());
      pill.type = 'button';
      pill.disabled = this.busy !== null;
      pill.addEventListener('click', (): void => { this.hooks.voice.pill(choice); line.text = lineOption_set(line.text, '--data-backup', choice); this.edited = true; this.stepCost_ask(line.text); this.draw(); });
      backup.append(pill);
    }
    if (runs !== null) backup.append(el('span', 'ss-field-runs', `RUNS ${runs.toUpperCase()}`));
    const delta: HTMLElement = el('span', 'vm-lever-delta', '');
    delta.dataset['word'] = '--data-backup';
    backup.append(delta);
    return backup;
  }

  /** The change as one block: what it costs a month against what runs, what it means, and BUILD saying both. */
  private change_make(step: ScriptStep, line: ScriptLine, built: ScriptLine | undefined): HTMLElement {
    const box: HTMLElement = el('div', 'vm-change');
    box.append(el('div', 'vm-change-total'), el('div', 'vm-change-means'));
    const commands: HTMLElement = el('div', 'tdc-commands vm-commit');
    if (built !== undefined) {
      // loop: ss-vm-build, vm-size-build
      const build: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-bill ss-build vm-build', 'BUILD');
      build.type = 'button';
      build.dataset['line'] = String(line.number);
      build.dataset['build'] = built.text;
      build.addEventListener('click', (): void => { this.hooks.voice.pill('BUILD'); void this.declaredBuild_send(line.text, built.text, step.key); });
      commands.append(build, el('span', 'tdc-commands-label vm-commit-says', ''));
    }
    box.append(commands);
    queueMicrotask((): void => this.change_redraw());
    return box;
  }

  /** What the levers offer against what runs, as words: `disk 100 → 150 GB`; empty when nothing changes. */
  private would_get(): { would: BuildWould[]; words: string } {
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.kind === 'vm new');
    const line: ScriptLine | undefined = step?.lines[0];
    const runs = this.runs_get(line_parse(line?.text ?? '').subject ?? '');
    if (line === undefined || runs === null) return { would: [], words: '' };
    // The ports are SERVICES' (public SSH's among them): SPEC offers its levers alone.
    const would: BuildWould[] = buildWould_derive(vmLevers_read(line.text), runs).filter((one: BuildWould): boolean => !/^open /.test(one.change));
    return { would, words: would.map((one: BuildWould): string => one.change).join(', ') };
  }

  /** The change block and the levers' shares, redrawn in place as a lever moves or a price arrives. */
  private change_redraw(): void {
    const body: HTMLElement = this.parts.body;
    const total: HTMLElement | null = body.querySelector('.vm-change-total');
    if (total === null) return;
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    const line: ScriptLine | undefined = step?.lines[0];
    if (step === undefined || line === undefined) return;
    const runs = this.runs_get(line_parse(line.text).subject ?? '');
    const { would, words } = this.would_get();
    const refused: BuildWould | undefined = would.find((one: BuildWould): boolean => one.tone === 'refused');
    const month: number | null = this.changeMonth_get(line, runs);
    const money = (value: number): string => `${value > 0 ? '+' : '−'}${money_text(Math.abs(value), this.stepCost?.cost?.currency ?? 'USD')} a month`;
    total.replaceChildren();
    if (runs === null) {
      total.append(el('span', 'vm-change-word', 'NOT BUILT YET'), el('span', 'vm-change-money', this.stepCost?.cost == null ? 'pricing…' : `${rate_words(this.stepCost.cost, HOURS_PER_MONTH)} once built`));
    } else if (would.length === 0) {
      total.append(el('span', 'vm-change-word', 'NOTHING CHANGES'), el('span', 'vm-change-money', 'what runs is what is sized'));
    } else {
      total.append(el('span', 'vm-change-word', words.toUpperCase()), el('span', `vm-change-money${month !== null && month > 0 ? ' tdc-bill' : ''}`, month === null ? 'pricing…' : Math.abs(month) < 0.005 ? 'no change in cost' : money(month)));
    }
    const means: HTMLElement | null = body.querySelector('.vm-change-means');
    if (means !== null) {
      means.replaceChildren();
      const plain: Readonly<Record<BuildWould['tone'], string>> = { grow: 'grows while it runs: no restart', reboot: 'the machine restarts: it, and the ChRIS on it, are down a few minutes', refused: '' };

      // A resize in place is said plainly; a machine made (none runs) keeps its own words: what it is made over.
      for (const one of would) {
        const said: string = one.tone === 'refused' || !one.change.includes('→') ? one.consequence : plain[one.tone];
        // One change is named large above: what it means is enough under it; several each say which.
        means.append(el('span', `tdc-prose ss-would-${one.tone}`, would.length === 1 ? said : `${one.change}: ${said}`));
      }
      // Declared before and not built (here or by another session): said, so the offer is not taken for a fresh edit.
      if (!this.edited && would.length > 0 && stepBuildLine_get(step)?.state === 'changed') means.append(el('span', 'tdc-prose tdc-quiet vm-change-declared', 'declared already, kept in the tenancy, and not built yet: BUILD applies it'));
    }
    // Each lever's share, beside it; a lever off what runs before its share is priced says so.
    const shares: Map<string, number | null> = this.leverCosts?.deltas ?? new Map();
    for (const cell of body.querySelectorAll<HTMLElement>('.vm-lever-delta')) {
      const word: string = cell.dataset['word'] ?? '';
      const share: number | null | undefined = shares.get(word);
      cell.textContent = share === undefined ? '' : share === null ? 'pricing…' : Math.abs(share) < 0.005 ? 'no cost' : money(share);
      cell.classList.toggle('tdc-bill', share != null && share > 0.005);
    }
    const build: HTMLButtonElement | null = body.querySelector('.vm-build');
    const says: HTMLElement | null = body.querySelector('.vm-commit-says');
    if (build === null || says === null) return;
    const hold = this.hold_derive(build.dataset['build'] ?? '');
    const priced: string = month === null || Math.abs(month) < 0.005 ? '' : ` · ${money(month)}`;
    build.textContent = hold === 'held' ? 'BUILD · REFUSED IN READ' : refused !== undefined ? `BUILD · ${refused.change.toUpperCase()} IS REFUSED` : would.length === 0 ? 'BUILD' : `BUILD · ${words}${priced}`;
    build.classList.toggle('tdc-pill-quiet', would.length === 0);
    build.classList.toggle('tdc-pill-asks', hold === 'asks');
    build.disabled = hold === 'held' || refused !== undefined || this.acting_is();
    build.title = `sends: ${line.text}, then ${build.dataset['build'] ?? ''}`;
    says.textContent = hold === 'held' ? READ_HELD_SHORT
      : `${hold === 'asks' ? 'asks your password first (this session can only read), then ' : ''}${would.length === 0 ? 'plans and says there is nothing to do' : 'plans, then asks with the cost before anything bills, then applies'}`;
  }

  /** The whole change a month against what runs, or null while either side is unpriced. */
  private changeMonth_get(line: ScriptLine, runs: (VmRuns & { at: string }) | null): number | null {
    const offered: VmCostRow | null = this.stepCost;
    if (runs === null || offered === null || offered.cost === null) return null;
    const key: string = `${line_parse(line.text).subject ?? ''}@${runs.at}`;
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.kind === 'vm new');
    if (this.runsCost?.key !== key && step !== undefined) this.runsCost_ask(key, step, runs);
    const now: VmCostRate | null = this.runsCost?.key === key ? this.runsCost.row?.cost ?? null : null;
    if (now === null) return null;
    return (offered.cost.machineHour + offered.cost.dataHour - now.machineHour - now.dataHour) * HOURS_PER_MONTH;
  }

  /** The price of the line shown, asked once per text; each lever's share asked after it. */
  private sizeCost_need(line: ScriptLine): void {
    if (this.stepCost === null && this.costTimer === null) this.stepCost_ask(line.text);
    this.leverCosts_ask(line);
  }

  /**
   * Each lever's share of the change: the line as it runs, with that lever
   * alone moved, priced against the line as it runs. The price list is the
   * session's, read once, so these are worked out, not fetched.
   */
  private leverCosts_ask(line: ScriptLine): void {
    const runs = this.runs_get(line_parse(line.text).subject ?? '');
    if (runs === null) { this.leverCosts = null; return; }
    const key: string = `${line.text}@${runs.at}`;
    if (this.leverCosts?.key === key) return;
    const levers = vmLevers_read(line.text);
    let asRuns: string = line.text;
    for (const [word, value] of [['--vcpu', runs.vcpu], ['--memory', runs.memory], ['--disk', runs.disk], ['--data', runs.data], ['--data-backup', runs.backup ?? null]] as const) if (value !== null) asRuns = lineOption_set(asRuns, word, String(value));
    const moved: Array<[string, string]> = ([['--vcpu', levers.vcpu, runs.vcpu], ['--memory', levers.memory, runs.memory], ['--disk', levers.disk, runs.disk], ['--data', levers.data, runs.data], ['--data-backup', levers.dataBackup, runs.backup ?? null]] as const)
      .filter(([, want, now]): boolean => want !== null && now !== null && String(want) !== String(now)).map(([word, want]): [string, string] => [word, String(want)]);
    this.leverCosts = { key, deltas: new Map(moved.map(([word]): [string, number | null] => [word, null])) };
    if (this.leverTimer !== null) clearTimeout(this.leverTimer);
    if (moved.length === 0) { this.change_redraw(); return; }
    this.leverTimer = setTimeout((): void => {
      this.leverTimer = null;
      const priced = async (text: string): Promise<number | null> => {
        const model = this.model_take(await this.hooks.ask(costLine_derive(text)), STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
        const cost: VmCostRate | null | undefined = model?.vms[0]?.cost;
        return cost == null ? null : (cost.machineHour + cost.dataHour) * HOURS_PER_MONTH;
      };
      void (async (): Promise<void> => {
        const base: number | null = await priced(asRuns);
        for (const [word, value] of moved) {
          if (this.leverCosts?.key !== key) return;
          const one: number | null = await priced(lineOption_set(asRuns, word, value));
          this.leverCosts.deltas.set(word, base === null || one === null ? null : one - base);
        }
        if (this.leverCosts?.key === key) this.change_redraw();
      })().catch((): void => undefined);
    }, 150);
  }

  /** A price arrived: SIZE's change block is redrawn in place; + NEW's price column as before. */
  protected override cost_redraw(): void {
    if (this.view === NEW_KEY) {
      const box: HTMLElement | null = this.parts.body.querySelector('.ss-cost');
      if (box !== null) this.cost_fill(box, this.newStep_get());
      const commit: HTMLButtonElement | null = this.parts.body.querySelector('.vm-new-commit');
      if (commit !== null) this.newCommit_redraw(commit);
      return;
    }
    const step: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === this.view);
    if (step?.kind === 'vm new' && step.lines[0] !== undefined) this.leverCosts_ask(step.lines[0]);
    this.change_redraw();
  }

  /** A slider moved: the change block follows the hand. */
  protected override lineShown_redraw(line: ScriptLine): void {
    super.lineShown_redraw(line);
    // The line's state is redrawn with its text: an edit reads EDITED the moment the hand moves.
    const shown: HTMLElement | null = this.parts.body.querySelector(`.vm-size-lines .ss-line[data-line="${line.number}"]`);
    if (shown !== null) shown.replaceWith(this.lineBoxNumbered_make(line));
    this.change_redraw();
    this.header_draw();
  }

  /** The script's line as it will run: an edit not built yet never reads as done (the operator, 2026-11-06). */
  protected override lineBox_make(line: ScriptLine): HTMLElement {
    const box: HTMLElement = super.lineBox_make(line);
    const edited: boolean = (this.edited || this.unsaved) && line.state === 'done' && line_parse(line.text).verb.join(' ') === 'vm new';
    if (edited && this.busy === null) {
      box.className = 'ss-line ss-line-changed';
      const state: Element | null = box.querySelector('.ss-line-state');
      if (state !== null) state.textContent = '~ EDITED · NOT BUILT: BUILD writes it, then builds it';
    }
    return box;
  }

  // ------------------------------------------------------------------ the run

  /** The build as one run: its steps with where each stands, how long, what it last said, and its outcome large. */
  private run_make(run: BuildRun): HTMLElement {
    const box: HTMLElement = el('div', `vm-run vm-run-${run.outcome === null ? 'going' : run.outcome.tone}`);
    const head: HTMLElement = el('div', 'vm-run-head');
    head.append(el('span', 'tdc-section-title', `THE BUILD · ${run.change === '' ? run.vm.toUpperCase() : run.change.toUpperCase()}`), el('span', 'vm-run-time', run.outcome === null ? `${duration_text(Date.now() - run.since)} SO FAR` : `ENDED ${run.outcome.at.slice(11, 16)} UTC · TOOK ${duration_text(Date.parse(run.outcome.at) - run.since)}`));
    const strip: HTMLElement = el('div', 'vm-run-strip');
    for (const phase of BUILD_PHASES) {
      const state = run.phases[phase.key];
      const tone: string = state === 'going' ? (phase.key === 'ask' ? 'tdc-step-asking' : 'tdc-step-going') : state === 'done' ? 'tdc-step-done' : state === 'skipped' ? 'tdc-step-skipped' : 'vm-step-waiting';
      const block: HTMLElement = el('div', `tdc-strip-step vm-run-step ${tone}`);
      // Once a run stopped short, a step it never reached is not done; a question it stopped at was answered no.
      const short: boolean = run.outcome !== null && run.outcome.tone !== 'done';
      const word: string = state === 'going' ? (phase.key === 'ask' ? 'ASKING' : phase.key === 'prepare' ? this.preparing_word().toUpperCase() : 'UNDER WAY') : state === 'done' ? (phase.key === 'ask' ? 'ANSWERED YES' : 'DONE')
        : short && phase.key === 'ask' && state === 'skipped' && run.phases['plan-machine'] !== 'waiting' ? 'ANSWERED NO' : short ? 'NOT DONE' : state === 'skipped' ? 'NOT NEEDED' : 'WAITING';
      block.append(el('span', 'tdc-strip-name', phase.label), el('span', 'tdc-strip-word', word));
      strip.append(block);
    }
    box.append(head, strip);
    if (run.outcome !== null) box.append(el('div', 'vm-run-outcome', run.outcome.words));
    // What a step last said of its work (a plan's counts), when it said something; never a hint about the screen.
    else if (run.said !== '' && run.phases.ask !== 'going') box.append(el('span', 'tdc-prose vm-run-said', run.said));
    return box;
  }

  /** What PREPARE does now, from the line it runs: the script, the declaration kept in the tenancy, then the stacks readied for the plan. */
  private preparing_word(): string {
    const line: string = this.busy?.line ?? '';
    return line.startsWith('touch ') ? 'writing the script' : line.startsWith('vm new ') ? 'writing the declaration' : line.startsWith('vm build ') ? 'keeping it, readying the stacks' : 'writing the declaration';
  }

  /**
   * The strip: a build's question in the screen's words, answered by buttons
   * that say what each answer does (the console keeps its `[y/N]`); every
   * other question as the script screen draws it.
   */
  protected override strip_draw(): void {
    super.strip_draw();
    const plain: BuildQuestion | null = this.ask === null ? null : buildQuestion_plain(this.ask.message);
    if (plain === null) return;
    const strip: HTMLElement = this.parts.strip;
    const title: Element | null = strip.querySelector('.tdc-strip-title');
    if (title !== null) title.textContent = 'THE BUILD ASKS';
    const text: Element | null = strip.querySelector('.tdc-strip-text');
    if (text !== null) text.textContent = plain.text;
    const [yes, no] = [...strip.querySelectorAll<HTMLButtonElement>(':scope > button')];
    if (yes !== undefined) yes.textContent = plain.yes;
    if (no !== undefined) no.textContent = plain.no;
  }

  /** The run block and the band, redrawn in place: the levers under the hand are never redrawn for a line printed. */
  private run_redraw(): void {
    const now: HTMLElement | null = this.parts.body.querySelector('.vm-run');
    if (now !== null && this.run !== null) now.replaceWith(this.run_make(this.run));
    this.header_draw();
  }

  private runTick: ReturnType<typeof setInterval> | null = null;

  /** The run's clock: the band and the block say how long, every second, while it runs. */
  private runTick_set(on: boolean): void {
    if (on && this.runTick === null) this.runTick = setInterval((): void => { if (this.run?.outcome === null) this.run_redraw(); else this.runTick_set(false); }, 1000);
    if (!on && this.runTick !== null) { clearInterval(this.runTick); this.runTick = null; }
  }

  /**
   * BUILD on SIZE: the password first when the session must be raised, then
   * the run stands at once with PREPARE under way (the script written, the
   * declaration written and kept in the tenancy, the stacks readied), so no
   * moment of the build is idle; the declaration, then the build.
   */
  protected override async declaredBuild_send(declared: string, built: string, step: string): Promise<void> {
    const building: boolean = built.startsWith(`vm build ${this.vm}`) && this.vm !== '';
    if (!building) { await super.declaredBuild_send(declared, built, step); return; }
    if (this.hold_derive(built) === 'asks' && this.hooks.elevate_ask !== null && !(await this.hooks.elevate_ask(built))) return;
    this.run = buildRun_start(this.vm, [this.would_get().words, this.servicesChange_get().join(', ')].filter((words: string): boolean => words !== '').join(', '), Date.now());
    this.runTick_set(true);
    this.draw();
    if (await this.line_send(declared, step) && await this.line_send(built, step, true)) this.builtHere = step;
    if (this.run !== null && this.run.outcome === null) {
      // Ended before its build line ran (the declaration refused): said where the run stands.
      this.run = buildRun_end(this.run, { tone: 'failed', why: this.refusal?.why ?? 'the declaration was refused' }, new Date().toISOString());
    }
    this.runTick_set(false);
    this.draw();
  }

  /** A build's NO or refusal is said once, as the run's outcome on SIZE; any other refusal stands where its control does. */
  protected override refusal_place(): void {
    if (this.run !== null && this.run.outcome !== null && this.refusal !== null && this.refusal.line.startsWith(`vm build ${this.run.vm}`)) return;
    super.refusal_place();
  }

  /** A line printed: the run moves on, in place. */
  protected override log_add(text: string, kind: 'sent' | 'out' | 'ask' | 'answer' | 'note'): void {
    // A question is shown once, on the strip where it is answered; the log carries the answer, named by its line.
    if (kind === 'ask') { this.askedHead = text.split(':')[0] ?? ''; return; }
    if (kind === 'answer' && this.askedHead !== '' && (text === 'y' || text === 'n')) {
      super.log_add(`${this.askedHead}: answered ${text === 'y' ? 'YES' : 'NO'}`, kind);
      // The base reads a NO from the bare answer: kept, so the line still ends declined.
      if (text === 'n' && this.busy !== null) this.busyDeclined = true;
      this.askedHead = '';
      return;
    }
    super.log_add(text, kind);
    if (this.run === null || this.run.outcome !== null) return;
    if (kind === 'out') {
      const moved: BuildRun = buildRun_take(this.run, text);
      if (moved !== this.run) { this.run = moved; this.run_redraw(); }
    }
  }

  /** The build's own question: the run says it asks; its answer moves it on. */
  public override ask_take(message: string, kind: PromptKind): Promise<string | null> {
    const before: string = this.view;
    const asked: Promise<string | null> = super.ask_take(message, kind);
    // SERVICES and SPEC are one line: a question asked for it stands where it was offered, never moved to SPEC.
    if (before === SERVICES_KEY && this.view !== SERVICES_KEY) { this.view = SERVICES_KEY; this.frame.view_mark(SERVICES_KEY); this.draw(); }
    // A question opens the log: what led to it is there.
    if (!this.logOpen) this.logOpen_set(true);
    if (this.run !== null && this.run.outcome === null && message.startsWith(`vm build ${this.run.vm}`)) {
      this.run = buildRun_ask(this.run);
      this.run_redraw();
      void asked.then((value: string | null): void => {
        if (this.run === null) return;
        this.run = buildRun_answer(this.run, value !== null && value !== '' && value.toLowerCase().startsWith('y'));
        this.run_redraw();
      });
    }
    return asked;
  }

  /** The line a standing question asks for (`vm build store`), for the answer's log line. */
  private askedHead: string = '';

  /** The last follow asked by the screen itself: one task is never followed again in a loop. */
  private followedLast: { task: string; at: number } | null = null;

  /** A task running with nothing following it is followed: its output runs in the VM LOG without a press, unless the operator stopped following. */
  private follow_auto(): void {
    const running: ScriptStep | undefined = runningStep_find(this.steps);
    const task: string | null = running?.running ?? null;
    if (task === null || this.busy !== null || this.followDeclined || this.ask !== null || !task.startsWith('/proc/')) return;
    if (this.followedLast?.task === task && Date.now() - this.followedLast.at < 10_000) return;
    this.followedLast = { task, at: Date.now() };
    this.running_follow();
  }

  /**
   * The password asked to raise a READ session, in plain words: what it is
   * for, that it is checked where the operator logged in and kept nowhere,
   * and a field wide enough to type in.
   */
  protected override errand_make(ask: OpenAsk): HTMLElement {
    const raise: RegExpMatchArray | null = ask.message.match(/^MANAGE · your password, for: (.+?) · /);
    if (raise === null) return super.errand_make(ask);
    const line: string = raise[1] as string;
    const bar: HTMLElement = el('div', 'errand-bar ss-errand vm-raise');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Your password, to act');
    const words: HTMLElement = el('div', 'vm-raise-words');
    words.append(el('span', 'vm-raise-title', `YOUR PASSWORD, TO ${line.split(' ').slice(0, 2).join(' ').toUpperCase()} ${line_parse(line).subject?.toUpperCase() ?? ''}`.trim()),
      el('span', 'tdc-prose', 'This session can only read. Your password lets it act until you leave: it is checked where you logged in, sent once, and kept nowhere.'));
    const field: HTMLInputElement = el('input', 'vm-raise-input ss-errand-input');
    field.id = 'ss-errand-input';
    field.type = 'password';
    field.autocomplete = 'current-password';
    field.spellcheck = false;
    field.placeholder = 'your password';
    field.setAttribute('aria-label', 'Your password');
    const go: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain errand-commit vm-raise-go', 'CONTINUE');
    go.type = 'button';
    const cancel: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-quiet ss-errand-stop', 'CANCEL');
    cancel.type = 'button';
    const answer = (): void => { const value: string = field.value; field.value = ''; this.hooks.voice.pill('CONTINUE'); this.log_add('(hidden)', 'answer'); ask.answer(value); };
    go.addEventListener('click', answer);
    field.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Enter') answer(); });
    cancel.addEventListener('click', (): void => { field.value = ''; this.hooks.voice.pill('CANCEL'); this.log_add('(declined)', 'answer'); ask.answer(''); });
    const row: HTMLElement = el('div', 'vm-raise-row');
    row.append(field, go, cancel);
    bar.append(words, row);
    queueMicrotask((): void => field.focus());
    return bar;
  }

  /** SIZE for a machine not yet named: its name, its network, its levers and its price, then BUILD, its one commit; nothing is sent before it. */
  private new_make(): HTMLElement[] {
    const form: HTMLElement = this.section_make('A NEW MACHINE', 'ss-col-form', 'NOTHING IS SENT BEFORE BUILD');
    const field = (key: 'name' | 'net', label: string, placeholder: string): HTMLElement => {
      const row: HTMLElement = el('div', 'tdc-name-row');
      const tag: HTMLElement = el('label', 'tdc-pair-label', label);
      const input: HTMLInputElement = el('input', 'tdc-name-input');
      input.id = `vm-new-${key}`;
      tag.setAttribute('for', input.id);
      input.value = this.newForm[key];
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.addEventListener('input', (): void => { this.newForm[key] = input.value.trim(); this.newLine_redraw(); });
      row.append(tag, input);
      return row;
    };
    form.append(field('name', 'NAME', 'a hostname label, as store'), field('net', 'NETWORK', NET_DEFAULT));
    if (this.limits === null) {
      form.append(el('p', 'tdc-prose tdc-quiet', 'reading what the shape sells: vm limits'));
    } else {
      const limits: VmLimitsModel = this.limits;
      const group: HTMLElement = el('div', 'tdc-lever-group');
      group.append(el('span', 'tdc-section-title', `SIZE · ${limits.shape}`));
      for (const spec of vmSliders_build(limits)) group.append(this.slider_make(this.newDraft, spec, limits));
      form.append(group);
    }
    // loop: vm-new-commit
    const commit: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-bill vm-new-commit', 'BUILD');
    commit.type = 'button';
    commit.addEventListener('click', (): void => { this.hooks.voice.pill('BUILD'); void this.new_build(); });
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(commit, el('span', 'tdc-commands-label', 'writes its script, declares it, then plans and asks before anything bills'));
    const lineBox: HTMLElement = el('div', 'ss-line ss-line-none');
    lineBox.dataset['line'] = '1';
    lineBox.append(el('span', 'ss-line-state', '—'), el('code', 'tdc-mono ss-line-text vm-new-line', this.newLine_text()));
    form.append(commands, lineBox,
      el('p', 'tdc-prose tdc-quiet ss-new-writes', `BUILD writes /scripts/mine/${this.newForm.name === '' ? '<name>' : this.newForm.name}.mise with this line and its build, declares the machine, then builds it: the plan, the cost and the question come here before anything bills, and the machine's own plan is asked again once its data stands. Nothing is sent before BUILD.`));
    this.newCommit_redraw(commit);
    const side: HTMLElement = this.section_make('COST · AS SIZED', 'ss-col-side tdc-col-cost', 'FROM THE PRICE LIST · vm cost');
    const box: HTMLElement = el('div', 'ss-cost');
    side.append(box);
    this.cost_fill(box, this.newStep_get());
    return [form, side];
  }

  /** The new machine's form as a seat, so the shared levers and price read it. */
  private newStep_get(): ScriptStep {
    return { key: NEW_KEY, label: 'NEW · SIZE', kind: 'vm new', lines: [this.newDraft], state: null, running: null };
  }

  /** The new machine's line: its name and network from the fields, its sizes from the levers. */
  private newLine_text(): string {
    const parts = line_parse(this.newDraft.text);
    const options: Array<[string, string]> = parts.options.map(([word, value]): [string, string] => [word, word === '--net' ? (this.newForm.net || NET_DEFAULT) : value]);
    return line_render({ ...parts, subject: this.newForm.name || UNNAMED, options });
  }

  private newLine_redraw(): void {
    this.newDraft.text = this.newLine_text();
    const text: HTMLElement | null = this.parts.body.querySelector('.vm-new-line');
    if (text !== null) text.textContent = this.newDraft.text;
    const commit: HTMLButtonElement | null = this.parts.body.querySelector('.vm-new-commit');
    if (commit !== null) this.newCommit_redraw(commit);
    this.header_draw();
  }

  private newCommit_redraw(commit: HTMLButtonElement): void {
    const name: string = this.newForm.name;
    // Held until priced: BUILD bills, so the offer's price stands before it can be pressed (a-change-is-a-loop, clause 2).
    const priced: boolean = this.stepCost !== null && this.stepCost.cost !== null;
    const refusal: string | null = name === '' ? 'NAME IT' : !vmName_valid(name) ? 'NAME IS A HOSTNAME' : this.vms.some((row: VmStatusRow): boolean => row.name === name) ? 'ALREADY IN THE TENANCY' : this.newForm.net === '' ? 'NETWORK' : !priced ? 'PRICING' : null;
    commit.textContent = refusal === null ? 'BUILD' : `BUILD · ${refusal}`;
    commit.disabled = refusal !== null || this.busy !== null;
  }

  /**
   * What a teardown stops billing and what it leaves billing, from `vm cost`,
   * asked once per machine shown: the machine's share goes with TEARDOWN, the
   * data's stays until TEARDOWN · ALL.
   *
   * @param name - The VM.
   * @returns The pairs, or a line saying the price is being read.
   */
  private teardownBill_make(name: string, machineStands: boolean = true): HTMLElement {
    if (this.teardownCost?.vm !== name) {
      this.teardownCost = { vm: name, rate: null };
      void this.hooks.ask(`vm cost ${name}`).then((answer: QuietAnswer): void => {
        const model = this.model_take(answer, STRATUS_VM_COST_MODEL_KIND, (data: unknown) => vmCostModelSchema.safeParse(data));
        if (this.teardownCost?.vm === name) this.teardownCost = { vm: name, rate: model?.vms[0]?.cost ?? null };
        this.draw();
      }, (): void => undefined);
    }
    const rate = this.teardownCost.rate;
    if (rate === null) return el('p', 'tdc-prose tdc-quiet', 'reading what it bills: vm cost');
    const month = (hourly: number): string => `${money_text(hourly * HOURS_PER_MONTH, rate.currency)} A MONTH`;
    // The machine gone, only its kept data bills: TEARDOWN · ALL stops that, and nothing else is left to stop.
    if (!machineStands) return this.pairs_make([['BILLS NOW', `${month(rate.dataHour)} · its data, backups and address, kept`], ['TEARDOWN · ALL STOPS', month(rate.dataHour)]]);
    return this.pairs_make([['TEARDOWN STOPS', `${month(rate.machineHour)} · the machine`], ['STILL BILLS', `${month(rate.dataHour)} · its data, backups and address, kept`], ['TEARDOWN · ALL STOPS', month(rate.machineHour + rate.dataHour)]]);
  }

  /** TEARDOWN: the lock, then the undoing, each a line of the VM's own. */
  private teardown_make(): HTMLElement[] {
    const row: VmStatusRow | null = this.vmRow_get();
    const name: string = this.vm;
    const goes: HTMLElement = this.section_make('WHAT GOES · IN THIS ORDER', 'ss-col-form', 'ONLY WHAT THIS MACHINE MADE · AS THE TENANCY ANSWERS');
    // Each part is a step the kernel keeps on the record, a block each: red while it stands, lit while it goes, gold
    // once gone; a default teardown keeps the data, said as STAYS. The cluster teardown's blocks, a machine's words.
    const kept = new Map((row?.teardown?.steps ?? []).map((step) => [step.name, step]));
    const strip: HTMLElement = el('div', 'tdc-teardown-strip');
    for (const [part, what, how] of [
      ['machine', 'the machine', 'its instance, boot disk and security group, and the data volume\'s attachment: TEARDOWN'],
      ['data', 'its data', 'the volume, its backups and the reserved address: TEARDOWN · ALL only; a TEARDOWN keeps them so a build brings the machine back over them'],
    ] as const) {
      const step = kept.get(part);
      // A step under way, or one that failed, is the act's own word; otherwise whether the part stands is read from the
      // tenancy (the listing's `stands`, with when), and the record speaks only where the tenancy was not read.
      const stands = row?.stands;
      const there: boolean | null = stands === null || stands === undefined ? null : part === 'machine' ? stands.vcpu !== null : stands.data !== null;
      const acting: boolean = step?.state === 'running' || step?.state === 'failed';
      const state: string = acting || there === null ? step?.state ?? 'not done' : there ? (step?.state === 'kept' ? 'kept' : 'not done') : 'done';
      const tone: string = state === 'running' ? 'going' : state === 'done' ? 'gone' : state === 'kept' ? 'skipped' : state === 'failed' ? 'failed' : 'stands';
      const word: string = state === 'running' ? 'GOING' : state === 'done' ? 'GONE' : state === 'kept' ? 'STAYS' : state === 'failed' ? 'FAILED' : 'STANDS';
      const block: HTMLElement = el('div', `tdc-strip-step tdc-teardown-step tdc-step-${tone}`);
      block.setAttribute('aria-label', `${what}, ${word}`);
      const at: string = acting || there === null ? (step?.ended != null ? ` · ${step.ended.slice(11, 16)}` : ' · THIS HOST\'S RECORD') : ` · READ ${(stands as { at: string }).at.slice(11, 16)}`;
      block.append(el('span', 'tdc-strip-name', what), el('span', 'tdc-teardown-how', step?.note ?? how), el('span', 'tdc-strip-word', `${word}${at}`));
      strip.append(block);
    }
    goes.append(strip);
    // What stands of it, as the tenancy answered: the undoings offered are only those with something left to undo (a-change-is-a-loop, clause 5).
    // A machine found in the tenancy (no record here) stands as the cloud listed it: its instance, or its data alone.
    const found: boolean = row?.state === 'found';
    const machineStands: boolean = row !== null && (found ? row.found?.instanceId != null : row.stands != null ? row.stands.vcpu !== null : row.state === 'built');
    const dataStands: boolean = row !== null && (found || (row.stands != null ? row.stands.data !== null : row.state === 'built' || row.state === 'data kept'));
    if (row !== null && !machineStands && !dataStands) {
      const none: HTMLElement = el('div', 'tdc-note tdc-note-found');
      none.append(el('span', 'tdc-note-title', 'NOTHING OF IT STANDS'), el('span', 'tdc-prose', `The tenancy holds nothing of ${name}${row.stands != null ? `, as read ${row.stands.at.slice(11, 16)} UTC` : ''}: nothing to tear down, nothing bills. BUILD on SIZE builds it again, empty.`));
      const guard: HTMLElement = this.section_make('THE GUARD', 'ss-col-side');
      guard.append(none);
      return [goes, guard];
    }
    const lock: HTMLElement = el('div', `tdc-note ${row === null || row.protected ? 'tdc-note-locked' : 'tdc-note-refused'}`);
    lock.append(el('span', 'tdc-note-title', row === null ? 'NOT KEPT HERE' : row.protected ? 'PROTECTED' : 'UNLOCKED'), el('span', 'tdc-prose', row === null
      ? 'The host keeps no record of this machine yet: declare and build it first.'
      : row.protected ? 'A machine is born protected. Lifting the lock is a line of its own, so no single slip removes it: PROTECT · OFF writes the lock off in the tenancy and removes nothing; TEARDOWN then asks first, with what goes and what still bills.'
        : machineStands ? 'The lock is off. TEARDOWN asks first, with what goes and what still bills; TEARDOWN · ALL asks for the name typed back. PROTECT · ON writes the lock on in the tenancy: teardown refuses until it is lifted.' : 'The lock is off. The machine is gone; its data stands. TEARDOWN · ALL takes the data too, asking for the name typed back.'));
    const where: string | null = lockWhere_text(row?.lock);
    if (where !== null) lock.append(el('span', 'tdc-prose tdc-quiet ss-lock-where', where.toUpperCase()));
    const commands: HTMLElement = el('div', 'tdc-commands');
    if (row !== null) {
      // loop: vm-protect
      if (row.protected) commands.append(this.linePill_make('PROTECT · OFF', `vm protect ${name} off`, TEARDOWN_KEY, 'quiet'));
      else {
        // loop: vm-teardown
        const machine: HTMLButtonElement = this.linePill_make('TEARDOWN', `vm teardown ${name}`, TEARDOWN_KEY, 'destroy');
        // loop: vm-teardown-all
        const all: HTMLButtonElement = this.linePill_make('TEARDOWN · ALL', `vm teardown ${name} --all`, TEARDOWN_KEY, 'destroy');
        all.classList.add('ss-pill-redder');
        // loop: vm-protect
        commands.append(this.linePill_make('PROTECT · ON', `vm protect ${name} on`, TEARDOWN_KEY, 'quiet'), el('span', 'tdc-flex'), ...(machineStands ? [machine] : []), all);
      }
    }
    lock.append(commands);
    const guard: HTMLElement = this.section_make('THE GUARD', 'ss-col-side');
    guard.append(lock);
    // What each undoing stops billing and what keeps billing, beside the pills (a-change-is-a-loop, clause 2).
    if (row !== null && row.state !== 'gone') guard.append(this.teardownBill_make(name, machineStands));
    return [goes, guard];
  }
}
