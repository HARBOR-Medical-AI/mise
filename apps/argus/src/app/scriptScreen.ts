/**
 * @file The script screen, as the host wires it: the takeover `scripts`
 * opens in a stratus session over the library, or over one script, given
 * back on LEAVE (docs/stratus.adoc, D17).
 *
 * `scripts` typed at either console, or the SCRIPTS tile, opens the library;
 * `scripts open <path>` and a row on the tile open a script on the rail. The
 * screen asks `play <script> --status`, `vm limits`, `vm cost` and `ls`
 * quietly, for their models, and runs the lines its forms send as the
 * operator's own; while one runs, its output prints to the screen's log and
 * the session's questions stand on its strip. Under about 1250 px the screen
 * does not take over and says so; the line runs as text.
 *
 * A module of the host, shaped as the TD controller's.
 */
import type { ExecuteOutcome, SurfaceAsk } from '../calypso/client.js';
import { ScriptScreen } from '../features/script/screen.js';
import { synthVoice } from '../lcars/synth.js';
import type { HostContext } from './hostContext.js';
import { CONTROLLER_MIN_WIDTH } from './tdController.js';

/** The script screen's verbs a wired host has. */
export interface ScriptScreenModule {
  /** Opens the screen on the library (`''`) or a script; answers what happened, for the console. */
  open: (path: string) => Promise<string>;
  /** Whether the screen is up. */
  active_is: () => boolean;
  /** Whether a line of the screen's own is running (its output and questions are the screen's). */
  running_is: () => boolean;
  /** A question the session put to this surface, while one of the screen's lines runs. */
  ask: (request: SurfaceAsk) => Promise<string | null>;
  /** A live output chunk, while one of the screen's lines runs. */
  output_take: (chunk: string) => void;
  /** A task of the session ended: the screen, when up, reads its script's standing again. */
  task_ended: () => void;
  /** The door's answer changed (the session was raised): the screen, when up, draws it. */
  mode_refresh: () => void;
}

/**
 * Wires the screen to a host.
 *
 * @param context - The client, read when needed.
 * @returns The screen's verbs.
 */
/** How long a screen left with a line in flight keeps that line's question for itself. */
const LEFT_LINE_MS: number = 30 * 60 * 1000;

export function scriptScreen_wire(context: Pick<HostContext, 'client' | 'manage_is' | 'elevation_is' | 'elevate_ask'>): ScriptScreenModule {
  let screen: ScriptScreen | null = null;
  let lineRunning: boolean = false;
  let titleBefore: string = document.title;
  (window as unknown as { __argusScript?: unknown }).__argusScript = {
    view: (): string | null => screen?.view_get() ?? null,
    path: (): string | null => screen?.path_get() ?? null,
    steps: (): unknown => screen?.steps_get() ?? null,
    asking: (): boolean => screen?.asking_is() ?? false,
  };

  const close = (): void => {
    if (screen === null) return;
    // Left with a line in flight: its question, if it asks one before the line ends, is this screen's to show when it opens again.
    leftWithLine = lineRunning || screen.following_is() ? Date.now() + LEFT_LINE_MS : 0;
    // A step that runs as a task goes on without the screen: leaving stops following it, never the task.
    if (screen.following_is()) context.client.stop_send();
    screen.dispose();
    screen.root.remove();
    screen = null;
    delete document.body.dataset['takeover'];
    document.title = titleBefore;
    synthVoice.cue_play('close');
  };

  // Esc gives the screen back, ahead of every other Esc listener; a question on the strip is declined first.
  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (screen === null || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    // One layer at a time: a gutter sent away comes back first; the next Esc gives the screen back.
    if (screen.frame_restore()) return;
    close();
  }, true);

  /** Until when a question is the left screen's: it was left with a line in flight, whose question waits for it to open again (a bound, so a forgotten screen never holds the console's questions). */
  let leftWithLine: number = 0;
  /** A question the screen's line asked while the screen was away, held for the screen when it opens again. */
  let held: { request: SurfaceAsk; resolve: (value: string | null) => void } | null = null;

  const open = async (path: string): Promise<string> => {
    if (window.innerWidth < CONTROLLER_MIN_WIDTH) {
      const said: string = `scripts: the screen needs a display at least ${CONTROLLER_MIN_WIDTH} px wide; this one is ${window.innerWidth}, so the line runs as text`;
      try {
        const answer: ExecuteOutcome = await context.client.line_execute(path === '' ? 'scripts' : `play ${path} --status`, { silent: true, observe: false });
        return [said, ...answer.envelopes.map((envelope) => `${envelope.rendered ?? ''}${envelope.renderedErr ?? ''}`.trimEnd())].join('\n');
      } catch (error: unknown) {
        return `${said}\n${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (screen !== null) {
      void screen.open(path);
      return `scripts: the screen is up${path === '' ? '' : `, on ${path}`}`;
    }
    titleBefore = document.title;
    const opened: ScriptScreen = new ScriptScreen({
      run: async (line: string): Promise<boolean> => {
        lineRunning = true;
        try {
          // The operator's own line, never instrument traffic: the session may ask its questions.
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
    screen = opened;
    document.body.append(opened.root);
    document.body.dataset['takeover'] = 'script';
    synthVoice.preload();
    synthVoice.cue_play('open');
    void opened.open(path).then((): void => {
      // A question the screen's line asked while the screen was away stands on the strip again, over its seat (a-change-is-a-loop, clauses 4 and 6).
      const waiting = held;
      leftWithLine = 0;
      if (waiting !== null && screen === opened) { held = null; void opened.ask_take(waiting.request.message, waiting.request.kind).then(waiting.resolve); }
    });
    return `scripts: the script screen takes the display${path === '' ? ', on the library' : ` on ${path}`} (Esc or LEAVE gives it back)`;
  };

  return {
    open,
    active_is: (): boolean => screen !== null,
    // The screen's line runs on after the screen is left: its question is the screen's still, held until it opens again.
    running_is: (): boolean => lineRunning || Date.now() < leftWithLine,
    ask: (request: SurfaceAsk): Promise<string | null> => {
      if (screen !== null) return screen.ask_take(request.message, request.kind);
      return new Promise((resolve: (value: string | null) => void): void => { held = { request, resolve }; });
    },
    output_take: (chunk: string): void => { screen?.output_take(chunk); },
    task_ended: (): void => { screen?.taskEnded_take(); },
    mode_refresh: (): void => { screen?.mode_refresh(); },
  };
}
