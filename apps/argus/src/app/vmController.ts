/**
 * @file The VM controller, as the host wires it: `vm` or `vm <name>` in a
 * stratus session, or a row on the VIRTUAL MACHINES tile, takes the display
 * as the VM controller (features/vm/screen.ts); LEAVE or Esc gives it back
 * (docs/stratus.adoc, D17 revised). Shaped as the script screen's host.
 */
import type { ExecuteOutcome, SurfaceAsk } from '../calypso/client.js';
import { STRATUS_VM_STATE_EVENT, vmStatusRowSchema } from '@fnndsc/menu';
import { VmScreen } from '../features/vm/screen.js';
import type { ScriptDraft } from '../features/script/screen.js';
import { synthVoice } from '../lcars/synth.js';
import type { HostContext } from './hostContext.js';
import { CONTROLLER_MIN_WIDTH } from './tdController.js';

/** The VM controller's verbs a wired host has. */
export interface VmControllerModule {
  /** Opens the controller on a VM, or on a new one (`''`); answers what happened, for the console. */
  open: (name: string) => Promise<string>;
  /** Whether the controller is up. */
  active_is: () => boolean;
  /** Whether a line of the controller's own runs (its output and questions are the controller's). */
  running_is: () => boolean;
  /** A question the session put to this surface, while one of the controller's lines runs. */
  ask: (request: SurfaceAsk) => Promise<string | null>;
  /** A live output chunk, while one of the controller's lines runs. */
  output_take: (chunk: string) => void;
  /** A task of the session ended: the controller, when up, reads its script's standing again. */
  task_ended: () => void;
  /** A session event: a VM's row, sent as its teardown's steps begin and end. */
  event_take: (kind: string, data: unknown) => void;
  /** The door's answer changed (the session was raised): the controller, when up, draws it. */
  mode_refresh: () => void;
}

/**
 * Wires the VM controller to a host.
 *
 * @param context - The client and the door's answer, read when needed.
 * @param names_seen - Told the VMs each open finds, so the language can claim `vm <name>`.
 * @returns The controller's verbs.
 */
/** How long a screen left with a line in flight keeps that line's question for itself. */
const LEFT_LINE_MS: number = 30 * 60 * 1000;

export function vmController_wire(context: Pick<HostContext, 'client' | 'manage_is' | 'elevation_is' | 'elevate_ask' | 'terminal'>, names_seen: (names: string[]) => void): VmControllerModule {
  let screen: VmScreen | null = null;
  let lineRunning: boolean = false;
  let titleBefore: string = document.title;
  (window as unknown as { __argusVm?: unknown }).__argusVm = {
    view: (): string | null => screen?.view_get() ?? null,
    vm: (): string | null => screen?.vm_get() ?? null,
    vms: (): ReadonlyArray<string> => screen?.vms_get() ?? [],
    steps: (): unknown => screen?.steps_get() ?? null,
    asking: (): boolean => screen?.asking_is() ?? false,
  };

  const close = (): void => {
    if (screen === null) return;
    // Left with a line in flight: its question, if it asks one before the line ends, is this screen's to show when it opens again.
    leftWithLine = lineRunning || screen.following_is() ? Date.now() + LEFT_LINE_MS : 0;
    if (screen.following_is()) context.client.stop_send();
    // A question standing on the strip is carried, not answered: it stands again when the screen opens (a-change-is-a-loop, clause 6).
    const standing = screen.ask_detach();
    if (standing !== null) heldKeep({ request: { message: standing.message, kind: standing.kind }, resolve: standing.resolve });
    // Edits not saved are kept, never dropped silently: they stand again when the machine's script opens (a-change-is-a-loop, clause 6d).
    draft = screen.draft_detach();
    if (draft !== null) context.terminal.line_note(`vm: ${draft.path}: ${draft.edits === 1 ? 'an edit' : `${draft.edits} edits`} not saved, kept: they stand again when it opens, until SAVE`);
    screen.dispose();
    screen.root.remove();
    screen = null;
    delete document.body.dataset['takeover'];
    document.title = titleBefore;
    synthVoice.cue_play('close');
  };

  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (screen === null || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    // One layer at a time: a gutter sent away comes back first; the next Esc gives the screen back.
    if (screen.frame_restore()) return;
    close();
  }, true);

  const open = async (name: string): Promise<string> => {
    if (window.innerWidth < CONTROLLER_MIN_WIDTH) {
      const said: string = `vm: the controller needs a display at least ${CONTROLLER_MIN_WIDTH} px wide; this one is ${window.innerWidth}, so the line runs as text`;
      try {
        const answer: ExecuteOutcome = await context.client.line_execute(name === '' ? 'vm status' : `vm status ${name}`, { silent: true, observe: false });
        return [said, ...answer.envelopes.map((envelope) => `${envelope.rendered ?? ''}${envelope.renderedErr ?? ''}`.trimEnd())].join('\n');
      } catch (error: unknown) {
        return `${said}\n${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (screen !== null) {
      void screen.vm_open(name).then((): void => names_seen([...(screen?.vms_get() ?? [])]));
      return `vm: the controller is up${name === '' ? ', on a new machine' : `, on ${name}`}`;
    }
    titleBefore = document.title;
    const opened: VmScreen = new VmScreen({
      run: async (line: string): Promise<boolean> => {
        lineRunning = true;
        try {
          const outcome: ExecuteOutcome = await context.client.line_execute(line, { operator: true });
          // An answer the session refused stops what was to follow it (BUILD after its DECLARE).
          return !outcome.envelopes.some((envelope): boolean => envelope.status === 'error');
        } finally {
          lineRunning = false;
        }
      },
      ask: (line: string): Promise<ExecuteOutcome> => context.client.line_execute(line, { silent: true, observe: false }),
      stop: (): void => context.client.stop_send(),
      leave: close,
      manage_is: (): boolean | null => context.manage_is(),
      elevate_ask: context.elevation_is() ? (line: string): Promise<boolean> => context.elevate_ask(line) : null,
      voice: { pill: (label: string): void => synthVoice.pill_play(label), cue: (cue: string): void => synthVoice.cue_play(cue) },
    });
    if (draft !== null) { opened.draft_offer(draft); draft = null; }
    screen = opened;
    document.body.append(opened.root);
    document.body.dataset['takeover'] = 'vm';
    synthVoice.preload();
    synthVoice.cue_play('open');
    void opened.vm_open(name).then((): void => {
      names_seen([...opened.vms_get()]);
      // A question the screen's line asked while the screen was away stands on the strip again (a-change-is-a-loop, clauses 4 and 6).
      const waiting = held;
      leftWithLine = 0;
      if (waiting !== null && screen === opened) { held = null; void opened.ask_take(waiting.request.message, waiting.request.kind).then(waiting.resolve); }
    });
    return `vm: the VM controller takes the display${name === '' ? ' on a new machine' : ` on ${name}`} (Esc or LEAVE gives it back)`;
  };

  /** Until when a question is the left screen's: it was left with a line in flight, whose question waits for it to open again (a bound, so a forgotten screen never holds the console's questions). */
  let leftWithLine: number = 0;
  /** A question the screen's line asked while the screen was away, held for the screen when it opens again. */
  let held: { request: SurfaceAsk; resolve: (value: string | null) => void } | null = null;
  /** The bound on a held question: unanswered by then, it is abandoned, so a forgotten screen never holds the session. */
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  /** Edits not saved when the screen was left, offered to it when it opens again. */
  let draft: ScriptDraft | null = null;
  const heldKeep = (one: { request: SurfaceAsk; resolve: (value: string | null) => void }): void => {
    held?.resolve(null);
    held = one;
    if (heldTimer !== null) clearTimeout(heldTimer);
    heldTimer = setTimeout((): void => { if (held === one) { held = null; one.resolve(null); } }, LEFT_LINE_MS);
  };

  return {
    open,
    active_is: (): boolean => screen !== null,
    // The screen's line runs on after the screen is left: its question is the screen's still, held until it opens again.
    running_is: (): boolean => lineRunning || Date.now() < leftWithLine,
    ask: (request: SurfaceAsk): Promise<string | null> => {
      if (screen !== null) return screen.ask_take(request.message, request.kind);
      return new Promise((resolve: (value: string | null) => void): void => { heldKeep({ request, resolve }); });
    },
    output_take: (chunk: string): void => { screen?.output_take(chunk); },
    task_ended: (): void => { screen?.taskEnded_take(); },
    // A VM's teardown sends its row as each step begins and ends: the controller draws it without asking.
    event_take: (kind: string, data: unknown): void => {
      if (kind !== STRATUS_VM_STATE_EVENT || screen === null) return;
      const parsed = vmStatusRowSchema.safeParse(data);
      if (parsed.success) screen.row_take(parsed.data);
    },
    mode_refresh: (): void => { screen?.mode_refresh(); },
  };
}
