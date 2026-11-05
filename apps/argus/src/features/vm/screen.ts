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
import type { ChrisStatusRow, VmCostRate, VmLimitsModel, VmStatusRow } from '@fnndsc/menu';
import { HOURS_PER_MONTH, money_text } from '../controller/model.js';
import { chrisStatusModelSchema, STRATUS_CHRIS_STATUS_MODEL_KIND, STRATUS_VM_COST_MODEL_KIND, STRATUS_VM_STATUS_MODEL_KIND, vmCostModelSchema, vmStatusModelSchema } from '@fnndsc/menu';
import { lockWhere_text, modePill_make } from '../takeover/tier.js';
import type { TakeoverView } from '../takeover/frame.js';
import { saveLine_compose } from '../edit/line.js';
import { counts_words, line_parse, line_render, lines_build, runningStep_find, script_render, states_count, steps_build, vmSliders_build, workingCopy_derive, type ScriptLine, type ScriptStep, type StateCounts, type VmRuns } from '../script/model.js';
import { ScriptScreen, type QuietAnswer, type ScriptHooks } from '../script/screen.js';
import { FACTS_KEY, MACHINES_KEY, NEW_KEY, TEARDOWN_KEY, VM_SEAT_LABELS, vmCondition_derive, vmKeyless_is, vmLines_filter, vmName_valid, vmNewLine_compose, vmScript_append, vmScript_complete, vmScript_synthesize } from './model.js';

/** The order the VM's seats stand in, whatever order the script's lines come. */
const SEAT_ORDER: ReadonlyArray<string> = ['SIZE', 'BUILD', 'CHRIS', 'USERS', 'TEARDOWN'];

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
    this.draw();
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
    // A machine opens on what it is; a line running takes the seat it runs in.
    this.view = runningStep_find(this.steps)?.key ?? FACTS_KEY;
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

  /** What runs of the machine's ChRIS, for CHRIS and USERS. */
  protected override chrisRow_get(vm: string): ChrisStatusRow | null {
    return this.chrisRow !== null && this.chrisRow.vm === vm ? this.chrisRow : null;
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
    const facts: ScriptStep = { key: FACTS_KEY, label: 'MACHINE', kind: 'other', lines: [], state: null, running: null, template: true };
    // A machine this session can only see: what it is, and its undoing; its size, build and ChRIS need its SSH key.
    if (vmKeyless_is(this.vmRow_get())) return [facts, { key: TEARDOWN_KEY, label: 'TEARDOWN', kind: 'other', lines: [], state: null, running: null, template: true }];
    const mine: ScriptLine[] = vmLines_filter(lines, this.vm);
    const built: ScriptStep[] = steps_build(mine).map((step: ScriptStep): ScriptStep => ({ ...step, label: VM_SEAT_LABELS[step.kind] ?? step.label }));
    const steps: ScriptStep[] = [facts];
    for (const label of SEAT_ORDER) {
      const found: ScriptStep | undefined = built.find((step: ScriptStep): boolean => step.label === label);
      if (found !== undefined) { steps.push(found); continue; }
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
  }

  /** The header prices the machine shown, never the tenancy's every machine. */
  protected override costScope_get(): string | null {
    return this.vm === '' ? null : this.vm;
  }

  /** What runs of the machine shown, as `vm status` read it from the tenancy: the sizes SIZE renders and offers against. */
  protected override runs_get(name: string): (VmRuns & { at: string }) | null {
    const row: VmStatusRow | null = this.vmRow_get();
    if (row === null || row.name !== name || row.stands === null || row.stands === undefined) return null;
    return row.stands;
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
    return this.unsaved ? script_render(this.lines) : null;
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
    return await super.line_send(line, step, keepLog);
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
    const views: TakeoverView[] = this.steps.map((step: ScriptStep): TakeoverView => ({ key: step.key, label: step.label }));
    if (this.vm === '') {
      views.unshift({ key: NEW_KEY, label: 'NEW · SIZE' });
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

  /** The machine's facts: condition and mode, the machine, the ChRIS on it, the cost, the line running, the standing. */
  protected override header_draw(): void {
    const header: HTMLElement = this.parts.header;
    header.replaceChildren();
    const row: VmStatusRow | null = this.vmRow_get();
    const counts: StateCounts = states_count(this.lines);
    const condition: HTMLElement = el('section', 'tdc-head-condition');
    const pill: HTMLElement = el('div', 'tdc-condition');
    // On the listing the header names the listing, not a machine.
    const word: string = this.vm === '' && this.view === MACHINES_KEY ? 'MACHINES' : vmCondition_derive(row, this.busy !== null);
    pill.dataset['condition'] = word;
    if (word.length > 9) pill.classList.add('tdc-condition-long');
    pill.append(el('span', 'tdc-condition-label', 'THE MACHINE'), el('span', 'tdc-condition-name', word));
    const mode: HTMLElement | null = modePill_make(this.hooks.manage_is());
    const why: string = this.vm === '' ? (this.view === MACHINES_KEY ? `${this.vms.length} IN THE TENANCY · + NEW TO ADD ONE` : 'NAME IT ON SIZE') : vmKeyless_is(row) ? (row?.state === 'found' ? 'READ FROM THE TENANCY' : 'NO SSH KEY IN THE TENANCY') : counts_words(counts);
    condition.append(pill, ...(mode === null ? [] : [mode]), el('div', 'tdc-condition-why', why));
    const chips: HTMLElement = el('div', 'tdc-chips');
    if (this.vm !== '') chips.append(el('span', 'tdc-chip', vmKeyless_is(row) ? (row?.state === 'found' ? (row.found?.tagged === true ? 'FOUND · NOT READ' : 'MADE OUTSIDE STRATUS') : 'NO SSH KEY IN THE TENANCY') : this.unsaved ? 'SCRIPT NOT WRITTEN YET' : this.edited ? 'EDITED · NOT SAVED' : this.path.startsWith('/scripts/mine/') ? 'WORKING COPY' : 'FROM GIT · READ-ONLY'));
    if (row !== null) chips.append(el('span', `tdc-chip tdc-lock${row.protected ? ' tdc-lock-on' : ' tdc-lock-off'}`, row.protected ? 'PROTECTED' : 'UNLOCKED'));
    condition.append(chips);
    header.append(condition);
    header.append(this.headSection_make('MACHINE', [
      ['NAME', this.vm === '' ? (this.newForm.name || '[NAME IT ON SIZE]') : this.vm],
      ['STATE', row === null ? (this.vm === '' ? (this.view === MACHINES_KEY ? `${this.vms.length} in the tenancy` : 'not declared') : 'not kept here') : row.state === 'found' ? `found · ${row.found?.state ?? '?'}` : row.state],
      ['ADDRESS', row?.address ?? '—'],
      ['INSIDE', row?.inside ?? '—'],
    ]));
    header.append(this.headSection_make('CHRIS', row?.found?.chris != null ? [['URL', row.found.chris.url], ['PORTER', row.found.chris.porter ?? '—']] : vmKeyless_is(row) && (row?.chris === null || row?.chris === undefined) ? [['DEPLOYED', 'not said on the machine']] : row?.chris === null || row?.chris === undefined ? [['DEPLOYED', 'none']] : [['HOST', row.chris.host ?? '(by address)'], ['URL', row.chris.url], ['PORTER', row.chris.porter ?? '—']]));
    header.append(this.costSection_make());
    header.append(this.runningSection_make());
    header.append(this.headSection_make('SCRIPT', [['PATH', this.path === '' ? '—' : this.path], ['STANDING', counts_words(counts)]]));
  }

  protected override body_draw(): void {
    if (this.view === MACHINES_KEY || this.view === FACTS_KEY) {
      const body: HTMLElement = this.parts.body;
      body.replaceChildren();
      body.dataset['view'] = 'step';
      body.append(...(this.view === MACHINES_KEY ? this.machines_make() : this.facts_make()));
      this.errand_place();
      return;
    }
    if (this.view === NEW_KEY) {
      const body: HTMLElement = this.parts.body;
      body.replaceChildren();
      body.dataset['view'] = 'step';
      body.append(...this.new_make());
      this.errand_place();
      return;
    }
    if (this.view === TEARDOWN_KEY) {
      const body: HTMLElement = this.parts.body;
      body.replaceChildren();
      body.dataset['view'] = 'step';
      body.append(...this.teardown_make());
      this.errand_place();
      return;
    }
    super.body_draw();
  }

  /**
   * MACHINES: every VM the tenancy runs, one row each (what it is doing, its
   * address, its size, what runs on it), each opening that machine, and + NEW.
   * The library's rows, in the machine's words.
   */
  private machines_make(): HTMLElement[] {
    const list: HTMLElement = this.section_make('MACHINES', 'ss-col-wide', `${this.vms.length} IN THE TENANCY`);
    const rows: HTMLElement = el('div', 'ss-scripts');
    for (const row of this.vms) {
      const line: HTMLElement = el('div', 'ss-script vm-row');
      const size: string = row.spec !== null ? `${row.spec.vcpu} vCPU · ${row.spec.memory} GiB` : row.found?.vcpus != null ? `${row.found.vcpus} vCPU${row.found.memoryGib != null ? ` · ${row.found.memoryGib} GiB` : ''}` : '—';
      const tagged: string | null = row.found?.chris != null ? row.found.chris.url.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '') : null;
      const on: string = row.chris?.host ?? (row.chris !== null && row.chris !== undefined ? row.chris.url : tagged !== null ? `CUBE at ${tagged}` : vmKeyless_is(row) ? 'what runs on it is not said' : 'nothing deployed');
      line.append(
        el('span', 'ss-script-name', row.name),
        el('span', 'ss-script-source', vmCondition_derive(row, false)),
        el('span', 'ss-script-standing', `${row.address ?? 'no address'} · ${size} · ${on}`),
      );
      const open: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain', 'OPEN');
      open.type = 'button';
      open.title = `opens ${row.name}: what it is, then what can be done with it`;
      open.disabled = this.busy !== null;
      open.addEventListener('click', (): void => { this.hooks.voice.pill('OPEN'); void this.vm_open(row.name); });
      line.append(open);
      rows.append(line);
    }
    list.append(rows);
    const commands: HTMLElement = el('div', 'tdc-commands');
    const add: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain vm-new-open', '+ NEW MACHINE');
    add.type = 'button';
    add.disabled = this.busy !== null;
    add.addEventListener('click', (): void => { this.view_press(NEW_KEY); });
    commands.append(el('span', 'tdc-flex'), add);
    list.append(commands, el('p', 'tdc-prose tdc-quiet', 'Every machine the tenancy runs outside a cluster, as vm status reads it from the cloud. One stratus built shows its state, whichever session or host built it: its records and its SSH key are read from the tenancy. One FOUND was made outside stratus: it is seen, never built on.'));
    const side: HTMLElement = this.section_make('WHAT A ROW OPENS', 'ss-col-side');
    side.append(this.pairs_make([['MACHINE', 'what it is and what runs on it'], ['SIZE · CHRIS · USERS', 'its lines: size it and build it, its ChRIS, its accounts'], ['TEARDOWN', 'its undoing, behind its lock']]));
    return [list, side];
  }

  /** MACHINE: what the opened machine is, where it stands, and what is on it; for one seen only, why it can only be seen. */
  private facts_make(): HTMLElement[] {
    const row: VmStatusRow | null = this.vmRow_get();
    const facts: HTMLElement = this.section_make('THE MACHINE', 'ss-col-wide', row === null ? 'NOT KEPT HERE' : row.region.toUpperCase());
    if (row === null) {
      facts.append(el('p', 'tdc-prose', `The tenancy runs no machine called ${this.vm}, and this session keeps none: declare it on SIZE.`));
      return [facts];
    }
    const size: string = row.spec !== null
      ? `${row.spec.vcpu} vCPU · ${row.spec.memory} GiB · disk ${row.spec.disk} GB · data ${row.spec.data} GB${row.spec.dataBackup === 'daily' ? ' (daily backups)' : ''} · ${row.spec.os}`
      : row.found !== null && row.found !== undefined ? `${row.found.shape ?? '?'}${row.found.vcpus != null ? ` · ${row.found.vcpus} vCPU` : ''}${row.found.memoryGib != null ? ` · ${row.found.memoryGib} GiB` : ''}` : '—';
    const kept: string = row.state === 'found'
      ? (row.found?.tagged === true ? 'found: built by stratus, and its stacks did not read into this host' : 'found: made outside stratus')
      : row.keyless === true ? 'read from the tenancy, which keeps no SSH key for it (built before stratus kept keys there): vm keep, on the host that holds the key, keeps it'
        : row.takenFrom !== undefined && row.takenFrom !== null ? `read from the tenancy ${row.takenFrom.slice(0, 16).replace('T', ' ')}: its stacks and the secrets its vault keeps` : 'its records and its SSH key held here';
    // What runs, read from the tenancy, beside what is declared: never one drawn for the other (a-change-is-a-loop, clause 1).
    const stands = row.stands ?? null;
    const rest: string = stands === null ? '' : `${stands.backup != null ? ` (${stands.backup === 'none' ? 'no backups' : `${stands.backup} backups`})` : ''}${stands.os != null ? ` · ${stands.os}` : ''}`;
    const runs: string = stands === null ? '—' : `${stands.vcpu ?? '?'} vCPU · ${stands.memory ?? '?'} GiB · disk ${stands.disk ?? '?'} GB · data ${stands.data ?? '?'} GB${rest} (read from the tenancy ${stands.at.slice(11, 16)} UTC)`;
    facts.append(this.pairs_make([
      ['DOING', row.state === 'found' ? (row.found?.state ?? '?') : row.state],
      ['RUNS', runs],
      ['DECLARED', `${size}${row.declared != null ? (row.declaredKept === true ? ' · kept in the tenancy' : ' · on this host only') : ''}`],
      ['ADDRESS', row.address ?? '—'],
      ['INSIDE', row.inside ?? '—'],
      ['NETWORK', row.spec?.net ?? '—'],
      // The ports its security group opens now, read from the tenancy; the declaration's only where the tenancy was not read.
      ['OPEN', stands?.open != null ? `${stands.open.length === 0 ? 'none' : stands.open.join(', ')} (read from the tenancy)` : row.spec !== null ? `${row.spec.open.length === 0 ? 'none' : row.spec.open.join(', ')} (as declared)` : '—'],
      ['INSTANCE', row.found?.instanceId ?? row.instance ?? '—'],
      ['BUILT', row.built?.slice(0, 16).replace('T', ' ') ?? '—'],
      ['CHRIS', row.chris !== null && row.chris !== undefined ? `${row.chris.url}${row.chris.porter !== null ? ` · porter ${row.chris.porter}` : ''}`
        : row.found?.chris != null ? `${row.found.chris.url}${row.found.chris.porter !== null ? ` · porter ${row.found.chris.porter}` : ''} (as its instance's tag says)`
          : vmKeyless_is(row) ? 'not said on the machine (deployed before deploys tagged it)' : 'none deployed'],
      ['LOCK', `${row.protected ? 'protected: teardown refuses until lifted' : 'unlocked'}${lockWhere_text(row.lock) !== null ? ` · ${lockWhere_text(row.lock) as string}` : ''}`],
      ['KEPT', kept],
    ]));
    const side: HTMLElement = this.section_make('WHAT CAN BE DONE', 'ss-col-side');
    side.append(vmKeyless_is(row)
      ? el('p', 'tdc-prose', row.state === 'found' && row.found?.tagged !== true ? 'Made outside stratus: seen here, acted on in the cloud\'s own console.' : 'Its size, build and ChRIS need its SSH key, which the tenancy does not keep. TEARDOWN removes it, behind its lock and the name typed back.')
      : this.pairs_make([['SIZE', 'its vCPUs, memory, disks and ports: DECLARE saves them, BUILD plans and applies what changed, asking first'], ['CHRIS', 'deploys ChRIS on it'], ['USERS', 'its ChRIS accounts'], ['TEARDOWN', 'its undoing, behind its lock']]));
    return [facts, side];
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
      el('p', 'tdc-prose tdc-quiet', 'BUILD writes /scripts/mine/<name>.mise with this line and its build, declares the machine, then builds it: the plan, the cost and the question come here before anything bills. Nothing is sent before BUILD.'));
    this.newCommit_redraw(commit);
    const side: HTMLElement = this.section_make('COST · AS SIZED', 'ss-col-side tdc-col-cost', 'FROM THE PRICE LIST · vm cost');
    const box: HTMLElement = el('div', 'ss-cost');
    side.append(box);
    this.cost_fill(box, this.newStep_get());
    const log: HTMLElement = this.section_make('THE STEP\'S OUTPUT', 'tdc-col-steplog');
    log.append(el('div', 'tdc-steplog'));
    return [form, side, log];
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
    const refusal: string | null = name === '' ? 'NAME IT' : !vmName_valid(name) ? 'NAME IS A HOSTNAME' : this.vms.some((row: VmStatusRow): boolean => row.name === name) ? 'ALREADY IN THE TENANCY' : this.newForm.net === '' ? 'NETWORK' : null;
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
  private teardownBill_make(name: string): HTMLElement {
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
    const lock: HTMLElement = el('div', `tdc-note ${row === null || row.protected ? 'tdc-note-locked' : 'tdc-note-refused'}`);
    lock.append(el('span', 'tdc-note-title', row === null ? 'NOT KEPT HERE' : row.protected ? 'PROTECTED' : 'UNLOCKED'), el('span', 'tdc-prose', row === null
      ? 'The host keeps no record of this machine yet: declare and build it first.'
      : row.protected ? 'A machine is born protected. Lifting the lock is a line of its own, so no single slip removes it.' : 'The lock is off. TEARDOWN sends the line; TEARDOWN · ALL asks for the name typed back.'));
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
        commands.append(this.linePill_make('PROTECT · ON', `vm protect ${name} on`, TEARDOWN_KEY, 'quiet'), el('span', 'tdc-flex'), machine, all);
      }
    }
    lock.append(commands);
    const guard: HTMLElement = this.section_make('THE GUARD', 'ss-col-side');
    guard.append(lock);
    // What each undoing stops billing and what keeps billing, beside the pills (a-change-is-a-loop, clause 2).
    if (row !== null && row.state !== 'gone') guard.append(this.teardownBill_make(name));
    return [goes, guard, this.stepLog_make({ key: TEARDOWN_KEY, label: 'TEARDOWN', kind: 'other', lines: [], state: null, running: null })];
  }
}
