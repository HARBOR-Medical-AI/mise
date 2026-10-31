/**
 * @file The TD controller, as the host wires it: the screen `cluster` takes
 * in a stratus session, given back on LEAVE (docs/stratus.adoc, D13).
 *
 * `cluster` (or `cluster <name>`) typed at either console, or a row pressed on
 * the CLUSTERS tile, opens the controller over ARGUS. It reads `cluster
 * status` when it opens and after each line it sends, and takes the
 * `stratus.cluster.state` events a build shows between; while it is up, the
 * lines it runs print to its log and the session's questions stand on its
 * strip. A build is not a game: leaving never stops one, and opening again
 * finds it by its task. Under about 1250 px the controller does not take the
 * screen and says so; the line runs as text.
 *
 * A module of the host, shaped as the trek bridge's.
 */
import {
  clusterSizeModelSchema, clustersModelSchema, clusterSummarySchema, STRATUS_CLUSTER_SIZE_MODEL_KIND, STRATUS_CLUSTER_STATE_EVENT, STRATUS_CLUSTERS_MODEL_KIND,
  type ClusterSizeModel, type ClusterSummary,
} from '@fnndsc/menu';
import type { ExecuteOutcome, SurfaceAsk } from '../calypso/client.js';
import { TdController } from '../features/controller/screen.js';
import { synthVoice } from '../lcars/synth.js';
import type { HostContext } from './hostContext.js';

/** The narrowest screen the controller takes. */
export const CONTROLLER_MIN_WIDTH: number = 1250;

/** The controller verbs a wired host has. */
export interface TdControllerModule {
  /** Opens the controller on a cluster (`''` for the first); answers what happened, for the console (on a narrow screen, the line's own answer as text). */
  open: (name: string) => Promise<string>;
  /** Whether the controller is on the screen. */
  active_is: () => boolean;
  /** Whether a line of the controller's own is running (its output and questions are the controller's). */
  running_is: () => boolean;
  /** A question the session put to this surface, while one of the controller's lines runs. */
  ask: (request: SurfaceAsk) => Promise<string | null>;
  /** A live output chunk, while one of the controller's lines runs. */
  output_take: (chunk: string) => void;
  /** A typed event from the session. */
  event_take: (kind: string, data: unknown) => void;
  /** The clusters last read, for the console's `cluster <name>`. */
  names_get: () => string[];
}

/**
 * The model of a kind an answer carries, parsed; null when it carries none.
 *
 * @param answer - The answer.
 * @param kind - The model kind.
 * @param parse - The schema's safe parse.
 * @returns The model.
 */
function model_extract<T>(answer: ExecuteOutcome, kind: string, parse: (data: unknown) => { success: boolean; data?: T }): T | null {
  for (const envelope of answer.envelopes) {
    if (envelope.model?.kind !== kind) continue;
    const parsed = parse(envelope.model.data);
    if (parsed.success && parsed.data !== undefined) return parsed.data;
  }
  return null;
}

/**
 * Wires the controller to a host.
 *
 * @param context - The client, read when needed.
 * @param names_seen - Told the clusters each read finds, so the language can claim `cluster <name>`.
 * @returns The controller verbs.
 */
export function tdController_wire(context: Pick<HostContext, 'client'>, names_seen: (names: string[]) => void): TdControllerModule {
  let controller: TdController | null = null;
  let lineRunning: boolean = false;
  let names: string[] = [];
  let titleBefore: string = document.title;
  // What the controller has heard: for the smoke suite and a diagnosis.
  const heard: { events: number; reads: number; lastError: string | null } = { events: 0, reads: 0, lastError: null };
  (window as unknown as { __argusController?: unknown }).__argusController = {
    view: (): string | null => controller?.view_get() ?? null,
    cluster: (): ClusterSummary | null => controller?.cluster_get() ?? null,
    asking: (): boolean => controller?.asking_is() ?? false,
    heard: (): typeof heard => ({ ...heard }),
  };

  const status_read = async (): Promise<void> => {
    try {
      const answer: ExecuteOutcome = await context.client.line_execute('cluster status', { silent: true, observe: false });
      const model = model_extract(answer, STRATUS_CLUSTERS_MODEL_KIND, (data: unknown) => clustersModelSchema.safeParse(data));
      heard.reads++;
      if (model === null) return;
      names = model.clusters.map((cluster: ClusterSummary): string => cluster.name);
      names_seen(names);
      controller?.clusters_take(model.clusters);
      controller?.since_refresh();
    } catch (error: unknown) {
      heard.lastError = error instanceof Error ? error.message : String(error);
    }
  };

  const size_read = async (family?: string): Promise<ClusterSizeModel | null> => {
    try {
      const answer: ExecuteOutcome = await context.client.line_execute(family === undefined ? 'cluster size' : `cluster size --family ${family}`, { silent: true, observe: false });
      return model_extract(answer, STRATUS_CLUSTER_SIZE_MODEL_KIND, (data: unknown) => clusterSizeModelSchema.safeParse(data));
    } catch {
      return null;
    }
  };

  const close = (): void => {
    if (controller === null) return;
    controller.dispose();
    controller.root.remove();
    controller = null;
    delete document.body.dataset['takeover'];
    document.title = titleBefore;
    synthVoice.cue_play('close');
  };

  // Esc gives the screen back, ahead of every other Esc listener; a question on the strip is declined first.
  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (controller === null || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    close();
  }, true);

  const open = async (name: string): Promise<string> => {
    if (window.innerWidth < CONTROLLER_MIN_WIDTH) {
      // The controller does not take a narrow screen; the line runs as text, as in chell.
      const said: string = `cluster: the controller needs a screen at least ${CONTROLLER_MIN_WIDTH} px wide; this one is ${window.innerWidth}, so the line runs as text`;
      try {
        const answer: ExecuteOutcome = await context.client.line_execute(name === '' ? 'cluster status' : `cluster ${name}`, { silent: true, observe: false });
        return [said, ...answer.envelopes.map((envelope) => `${envelope.rendered ?? ''}${envelope.renderedErr ?? ''}`.trimEnd())].join('\n');
      } catch (error: unknown) {
        return `${said}\n${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (controller !== null) {
      controller.cluster_choose(name);
      return `cluster: the controller is up${name === '' ? '' : `, on ${name}`}`;
    }
    titleBefore = document.title;
    const opened: TdController = new TdController({
      run: async (line: string): Promise<void> => {
        lineRunning = true;
        try {
          // The operator's own line, never instrument traffic: the session may ask its questions.
          await context.client.line_execute(line, { operator: true });
        } catch (error: unknown) {
          opened.output_take(`${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          lineRunning = false;
        }
        await status_read();
      },
      size_read,
      stop: (): void => context.client.stop_send(),
      leave: close,
      voice: { pill: (label: string): void => synthVoice.pill_play(label), cue: (cue: string): void => synthVoice.cue_play(cue) },
    });
    controller = opened;
    document.body.append(opened.root);
    document.body.dataset['takeover'] = 'controller';
    synthVoice.preload();
    synthVoice.cue_play('open');
    void status_read().then((): void => opened.cluster_choose(name));
    return `cluster: the TD controller takes the screen${name === '' ? '' : ` on ${name}`} (Esc or LEAVE gives it back)`;
  };

  return {
    open,
    active_is: (): boolean => controller !== null,
    running_is: (): boolean => controller !== null && lineRunning,
    ask: (request: SurfaceAsk): Promise<string | null> => controller === null ? Promise.resolve(null) : controller.ask_take(request.message, request.kind),
    output_take: (chunk: string): void => { controller?.output_take(chunk); },
    event_take: (kind: string, data: unknown): void => {
      if (kind !== STRATUS_CLUSTER_STATE_EVENT || controller === null) return;
      heard.events++;
      const parsed = clusterSummarySchema.safeParse(data);
      if (!parsed.success) { heard.lastError = parsed.error.message; return; }
      controller.cluster_take(parsed.data);
    },
    names_get: (): string[] => [...names],
  };
}
