/**
 * @file The VM controller, as the host wires it: `vm` or `vm <name>` in a
 * stratus session, or a row on the VIRTUAL MACHINES tile, takes the display
 * as the VM controller (features/vm/screen.ts); LEAVE or Esc gives it back
 * (docs/stratus.adoc, D17 revised). Shaped as the script screen's host.
 */
import type { ExecuteOutcome, SurfaceAsk } from '../calypso/client.js';
import { STRATUS_VM_STATE_EVENT, vmStatusRowSchema } from '@fnndsc/menu';
import { VmScreen } from '../features/vm/screen.js';
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
export function vmController_wire(context: Pick<HostContext, 'client' | 'manage_is' | 'elevation_is' | 'elevate_ask'>, names_seen: (names: string[]) => void): VmControllerModule {
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
    if (screen.following_is()) context.client.stop_send();
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
      run: async (line: string): Promise<void> => {
        lineRunning = true;
        try {
          await context.client.line_execute(line, { operator: true });
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
    screen = opened;
    document.body.append(opened.root);
    document.body.dataset['takeover'] = 'vm';
    synthVoice.preload();
    synthVoice.cue_play('open');
    void opened.vm_open(name).then((): void => names_seen([...opened.vms_get()]));
    return `vm: the VM controller takes the display${name === '' ? ' on a new machine' : ` on ${name}`} (Esc or LEAVE gives it back)`;
  };

  return {
    open,
    active_is: (): boolean => screen !== null,
    running_is: (): boolean => screen !== null && lineRunning,
    ask: (request: SurfaceAsk): Promise<string | null> => screen === null ? Promise.resolve(null) : screen.ask_take(request.message, request.kind),
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
