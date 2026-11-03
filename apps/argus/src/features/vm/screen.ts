/**
 * @file The VM controller: the script screen keyed by one virtual machine
 * (docs/stratus.adoc, D17 revised). The gutter carries a pill per VM the
 * host keeps and + NEW; the rail is that VM's lines as seats, SIZE, BUILD,
 * CHRIS, USERS, and TEARDOWN, which is no line but the VM's own undoing. The
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
import type { VmStatusRow } from '@fnndsc/menu';
import { STRATUS_VM_STATUS_MODEL_KIND, vmStatusModelSchema } from '@fnndsc/menu';
import { modePill_make } from '../takeover/tier.js';
import type { TakeoverView } from '../takeover/frame.js';
import { saveLine_compose } from '../edit/line.js';
import { counts_words, line_parse, lines_build, runningStep_find, script_render, states_count, steps_build, type ScriptLine, type ScriptStep, type StateCounts } from '../script/model.js';
import { ScriptScreen, type QuietAnswer, type ScriptHooks } from '../script/screen.js';
import { NEW_KEY, TEARDOWN_KEY, VM_SEAT_LABELS, vmCondition_derive, vmLines_filter, vmName_valid, vmNewLine_compose, vmScript_append, vmScript_complete, vmScript_synthesize } from './model.js';

/** The order the VM's seats stand in, whatever order the script's lines come. */
const SEAT_ORDER: ReadonlyArray<string> = ['SIZE', 'BUILD', 'CHRIS', 'USERS', 'TEARDOWN'];

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
  /** Whether the script shown is not on the host yet (synthesized from the record, or composed here). */
  private unsaved!: boolean;

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
    this.unsaved = false;
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
      this.newForm = { name: '', net: this.vms[0]?.spec?.net ?? NET_DEFAULT };
      this.steps = this.steps_derive(this.lines);
      this.view = NEW_KEY;
      this.draw();
      void this.limits_need();
      void this.standing_read();
      return;
    }
    const path: string | null = await this.vmScript_find(name);
    if (path !== null) {
      this.path = path;
      this.unsaved = false;
      this.edited = false;
      await this.script_read();
    } else {
      // No script declares it: its record is its script until the first act writes one.
      const row: VmStatusRow | undefined = this.vms.find((each: VmStatusRow): boolean => each.name === name);
      this.path = `/scripts/mine/${name}.mise`;
      this.lines = lines_build(row === undefined ? `${vmNewLine_compose(name, NET_DEFAULT)}\nvm build ${name}\n` : vmScript_synthesize(row), []);
      this.unsaved = true;
      this.edited = true;
    }
    this.steps = this.steps_derive(this.lines);
    const first: ScriptStep | undefined = runningStep_find(this.steps) ?? this.steps.find((step: ScriptStep): boolean => step.state === 'changed' || step.state === 'ready') ?? this.steps[0];
    this.view = first?.key ?? NEW_KEY;
    this.draw();
    void this.limits_need();
    void this.standing_read();
    this.running_follow();
  }

  /** The title the tab wears. */
  public override title_get(): string {
    return `${vmCondition_derive(this.vmRow_get(), this.busy !== null)} · ${this.vm === '' ? 'NEW VM' : this.vm}`;
  }

  // ---------------------------------------------------------------- reading

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

  /** The VM's lines as its seats, SIZE, BUILD, CHRIS, USERS, in that order, then TEARDOWN; a seat whose line the script lacks stands over a template line. */
  protected override steps_derive(lines: ReadonlyArray<ScriptLine>): ScriptStep[] {
    if (this.vm === '') return [];
    const mine: ScriptLine[] = vmLines_filter(lines, this.vm);
    const built: ScriptStep[] = steps_build(mine).map((step: ScriptStep): ScriptStep => ({ ...step, label: VM_SEAT_LABELS[step.kind] ?? step.label }));
    const steps: ScriptStep[] = [];
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
  }

  /** The stage strip names the machine; before it is named, the new one. */
  protected override stageTitle_get(): string {
    return this.vm === '' ? 'A NEW MACHINE' : this.vm.toUpperCase();
  }

  /** BUILD keeps RUN and the plan; the lock and the undoing are TEARDOWN's seat here. */
  protected override undoing_shown(): boolean {
    return false;
  }

  /**
   * Sends a line; a template seat's line (a CHRIS not in the script yet) is
   * appended to the script first, and a script not on the host yet is written
   * first, so the artifact is always ahead of the act.
   */
  public override async line_send(line: string, step: string | null): Promise<void> {
    const shown: ScriptStep | undefined = this.steps.find((each: ScriptStep): boolean => each.key === step);
    if (shown?.template === true && shown.key !== TEARDOWN_KEY) {
      const text: string = vmScript_append(script_render(this.lines), this.vm, line);
      this.lines = lines_build(text, []);
      this.unsaved = true;
      this.edited = true;
    }
    if (this.unsaved && this.path !== '' && !line.startsWith('touch ')) {
      await super.line_send(saveLine_compose(this.path, script_render(this.lines)), null);
      this.unsaved = false;
      this.edited = false;
      await this.script_read();
      this.steps = this.steps_derive(this.lines);
      this.draw();
    }
    await super.line_send(line, step);
  }

  /** Declares the new machine: its script written under `/scripts/mine/`, then `vm new` sent. */
  private async new_commit(): Promise<void> {
    const name: string = this.newForm.name.trim();
    const net: string = this.newForm.net.trim();
    if (!vmName_valid(name) || net === '') return;
    this.vm = name;
    this.path = `/scripts/mine/${name}.mise`;
    this.lines = lines_build(vmScript_complete(`${vmNewLine_compose(name, net)}\n`, name), []);
    this.unsaved = true;
    this.steps = this.steps_derive(this.lines);
    this.view = 'line-1';
    await this.line_send(this.lines[0]?.text ?? '', 'line-1');
    await this.vms_read();
    await this.vm_open(name);
  }

  // ---------------------------------------------------------------- drawing

  /** The gutter: a pill per machine and + NEW; the rail: the VM's seats. */
  protected override rail_draw(): void {
    const views: TakeoverView[] = this.steps.map((step: ScriptStep): TakeoverView => ({ key: step.key, label: step.label }));
    if (this.vm === '') views.unshift({ key: NEW_KEY, label: 'SIZE' });
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
    const word: string = vmCondition_derive(row, this.busy !== null);
    pill.dataset['condition'] = word;
    pill.append(el('span', 'tdc-condition-label', 'THE MACHINE'), el('span', 'tdc-condition-name', word));
    const mode: HTMLElement | null = modePill_make(this.hooks.manage_is());
    condition.append(pill, ...(mode === null ? [] : [mode]), el('div', 'tdc-condition-why', this.vm === '' ? 'NAME IT ON SIZE' : counts_words(counts)));
    const chips: HTMLElement = el('div', 'tdc-chips');
    if (this.vm !== '') chips.append(el('span', 'tdc-chip', this.unsaved ? 'SCRIPT NOT WRITTEN YET' : this.edited ? 'EDITED · NOT SAVED' : this.path.startsWith('/scripts/mine/') ? 'WORKING COPY' : 'FROM GIT · READ-ONLY'));
    if (row !== null) chips.append(el('span', `tdc-chip tdc-lock${row.protected ? ' tdc-lock-on' : ' tdc-lock-off'}`, row.protected ? 'PROTECTED' : 'UNLOCKED'));
    condition.append(chips);
    header.append(condition);
    header.append(this.headSection_make('MACHINE', [
      ['NAME', this.vm === '' ? (this.newForm.name || '[NAME IT ON SIZE]') : this.vm],
      ['STATE', row === null ? (this.vm === '' ? 'not declared' : 'not kept here') : row.state],
      ['ADDRESS', row?.address ?? '—'],
      ['INSIDE', row?.inside ?? '—'],
    ]));
    header.append(this.headSection_make('CHRIS', row?.chris === null || row?.chris === undefined ? [['DEPLOYED', 'none']] : [['HOST', row.chris.host ?? '(by address)'], ['URL', row.chris.url], ['PORTER', row.chris.porter ?? '—']]));
    header.append(this.costSection_make());
    header.append(this.runningSection_make());
    header.append(this.headSection_make('SCRIPT', [['PATH', this.path === '' ? '—' : this.path], ['STANDING', counts_words(counts)]]));
  }

  protected override body_draw(): void {
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

  /** SIZE for a machine not yet named: its name, its network, and the sliders over the line that will declare it. */
  private new_make(): HTMLElement[] {
    const form: HTMLElement = this.section_make('A NEW MACHINE', 'ss-col-form', 'DECLARES; NOTHING IS BUILT');
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
    const lineBox: HTMLElement = el('div', 'ss-line ss-line-none');
    lineBox.append(el('span', 'ss-line-state', '—'), el('code', 'tdc-mono ss-line-text vm-new-line', this.newLine_text()));
    const commit: HTMLButtonElement = el('button', 'tdc-pill tdc-pill-plain vm-new-commit', 'COMMIT');
    commit.type = 'button';
    commit.addEventListener('click', (): void => { this.hooks.voice.pill('COMMIT'); void this.new_commit(); });
    const commands: HTMLElement = el('div', 'tdc-commands');
    commands.append(commit, el('span', 'tdc-commands-label', 'writes the script, then declares'));
    form.append(field('name', 'NAME', 'a hostname label, as store'), field('net', 'NETWORK', NET_DEFAULT), lineBox, commands,
      el('p', 'tdc-prose tdc-quiet', 'COMMIT writes /scripts/mine/<name>.mise with this line and its build, then sends the line: the machine is declared and nothing is made. SIZE then shows its sliders; BUILD builds it.'));
    this.newCommit_redraw(commit);
    const side: HTMLElement = this.section_make('WHAT A MACHINE IS', 'ss-col-side');
    side.append(this.pairs_make([['SCRIPT', 'one .mise file under /scripts/mine/, yours to keep'], ['LINES', 'vm new · vm build · chris deploy · chris user add'], ['REPLAY', 'played again, a line reads unchanged or asks before it changes anything']]));
    const log: HTMLElement = this.section_make('THE STEP\'S OUTPUT', 'tdc-col-steplog');
    log.append(el('div', 'tdc-steplog'));
    return [form, side, log];
  }

  private newLine_text(): string {
    return vmNewLine_compose(this.newForm.name || '<name>', this.newForm.net || NET_DEFAULT);
  }

  private newLine_redraw(): void {
    const text: HTMLElement | null = this.parts.body.querySelector('.vm-new-line');
    if (text !== null) text.textContent = this.newLine_text();
    const commit: HTMLButtonElement | null = this.parts.body.querySelector('.vm-new-commit');
    if (commit !== null) this.newCommit_redraw(commit);
    this.header_draw();
  }

  private newCommit_redraw(commit: HTMLButtonElement): void {
    const name: string = this.newForm.name;
    const refusal: string | null = name === '' ? 'NAME IT' : !vmName_valid(name) ? 'NAME IS A HOSTNAME' : this.vms.some((row: VmStatusRow): boolean => row.name === name) ? 'ALREADY KEPT' : this.newForm.net === '' ? 'NETWORK' : null;
    commit.textContent = refusal === null ? 'COMMIT' : `COMMIT · ${refusal}`;
    commit.disabled = refusal !== null || this.busy !== null;
  }

  /** TEARDOWN: the lock, then the undoing, each a line of the VM's own. */
  private teardown_make(): HTMLElement[] {
    const row: VmStatusRow | null = this.vmRow_get();
    const name: string = this.vm;
    const goes: HTMLElement = this.section_make('WHAT GOES', 'ss-col-form', 'ONLY WHAT THIS MACHINE MADE');
    goes.append(this.pairs_make([
      ['TEARDOWN', 'the machine: its instance, boot disk and security group; the data volume, its backups and the address stay, so a build brings it back over its data'],
      ['TEARDOWN · ALL', 'the data too: the volume, its backups and the reserved address; the engine asks for the name typed back'],
    ]));
    const lock: HTMLElement = el('div', `tdc-note ${row === null || row.protected ? 'tdc-note-locked' : 'tdc-note-refused'}`);
    lock.append(el('span', 'tdc-note-title', row === null ? 'NOT KEPT HERE' : row.protected ? 'PROTECTED' : 'UNLOCKED'), el('span', 'tdc-prose', row === null
      ? 'The host keeps no record of this machine yet: declare and build it first.'
      : row.protected ? 'A machine is born protected. Lifting the lock is a line of its own, so no single slip removes it.' : 'The lock is off. TEARDOWN sends the line; TEARDOWN · ALL asks for the name typed back.'));
    const commands: HTMLElement = el('div', 'tdc-commands');
    if (row !== null) {
      if (row.protected) commands.append(this.linePill_make('PROTECT · OFF', `vm protect ${name} off`, TEARDOWN_KEY, 'quiet'));
      else {
        const machine: HTMLButtonElement = this.linePill_make('TEARDOWN', `vm teardown ${name}`, TEARDOWN_KEY, 'destroy');
        const all: HTMLButtonElement = this.linePill_make('TEARDOWN · ALL', `vm teardown ${name} --all`, TEARDOWN_KEY, 'destroy');
        all.classList.add('ss-pill-redder');
        commands.append(this.linePill_make('PROTECT · ON', `vm protect ${name} on`, TEARDOWN_KEY, 'quiet'), el('span', 'tdc-flex'), machine, all);
      }
    }
    lock.append(commands);
    const guard: HTMLElement = this.section_make('THE GUARD', 'ss-col-side');
    guard.append(lock);
    return [goes, guard, this.stepLog_make({ key: TEARDOWN_KEY, label: 'TEARDOWN', kind: 'other', lines: [], state: null, running: null })];
  }
}
