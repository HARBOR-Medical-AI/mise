/**
 * @file The ambient pipeline cycler: registered pipelines take turns as a
 * slowly rotating miniature DAG in the header's left field.
 *
 * Ambient chrome in the cascade's spirit — but every shape shown is a real
 * registered pipeline's authored topology, fetched silently through the
 * same `pipeline diagram` command an operator could type. No interaction;
 * the full DAG pane is where engagement lives.
 *
 * @module
 */
import { pipelineDiagramModelSchema, DAG_MODEL_KINDS, type PipelineDiagramModel, type PipelineDiagramNode, type WireEnvelope, arg_quote } from '@fnndsc/menu';
import { ChrisSpace, type SceneNode } from '../scene/chrisSpace.js';
import type { ArgusClient, ExecuteOutcome } from '../calypso/client.js';
import type { FsListing } from '../features/files/panel.js';

/** How long each pipeline holds the stage. */
const CYCLE_MS: number = 20000;

/**
 * The cycler: feeds pipeline names through silent diagram fetches and
 * renders each arriving model in an ambient miniature scene.
 */
export class PipelineCycler {
  private readonly scene: ChrisSpace;
  private readonly nameplate: HTMLElement;
  private readonly command_run: (line: string) => void;
  private names: string[] = [];
  private cursor: number = 0;
  private timer: number | null = null;
  /** Models already received, by pipeline name — repainted without a fetch. */
  private readonly seen: Map<string, PipelineDiagramModel> = new Map();

  /**
   * @param mount - The header element the miniature renders into.
   * @param nameplate - The element naming the pipeline on stage.
   * @param command_run - Runs a session command silently.
   */
  constructor(mount: HTMLElement, nameplate: HTMLElement, command_run: (line: string) => void) {
    this.nameplate = nameplate;
    this.command_run = command_run;
    this.scene = new ChrisSpace(mount, {}, { ambient: true });
    new MutationObserver((): void => this.scene.palette_refresh()).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] },
    );
    // The cycler is a header face now: returning to it after another face
    // (or a slid-away header) leaves the canvas at whatever size the hidden
    // box had, so refit whenever the face changes.
    new MutationObserver((): void => {
      window.setTimeout((): void => this.scene.size_fit(), 60);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-header'] });
    window.addEventListener('resize', (): void => this.scene.size_fit());
  }

  /**
   * Starts cycling over the given pipeline names.
   *
   * @param names - Registered pipeline names, in display order.
   */
  public names_set(names: string[]): void {
    this.names = names;
    this.cursor = 0;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (names.length === 0) {
      return;
    }
    this.next_request();
    if (names.length > 1) {
      this.timer = window.setInterval((): void => this.next_request(), CYCLE_MS);
    }
  }

  /**
   * Observes envelopes for arriving pipeline diagrams and puts them on
   * stage. The pane and the cycler share the model; whichever asked, the
   * miniature shows the latest authored topology seen.
   *
   * @param envelope - Any envelope crossing the session.
   */
  public envelope_observe(envelope: WireEnvelope): void {
    if (envelope.model?.kind !== DAG_MODEL_KINDS.pipelineDiagram) {
      return;
    }
    const parsed = pipelineDiagramModelSchema.safeParse(envelope.model.data);
    if (!parsed.success) {
      return;
    }
    const model: PipelineDiagramModel = parsed.data;
    // A registered pipeline is immutable: remember its model, and every
    // later visit repaints from memory — the session queue never carries
    // a cycler fetch for a pipeline already seen.
    this.seen.set(model.name, model);
    this.model_stage(model);
  }

  /** Puts one remembered or arriving model on stage. */
  private model_stage(model: PipelineDiagramModel): void {
    this.nameplate.textContent = model.name;
    this.scene.graph_set({
      nodes: model.nodes.map((node: PipelineDiagramNode): SceneNode => ({
        id: node.id,
        label: node.label,
        parentIds: node.parentIds,
        joinParentIds: node.joinParentIds,
      })),
    });
    this.scene.size_fit();
  }

  /** Advances the cycle: remembered models repaint locally, new ones fetch. */
  private next_request(): void {
    const name: string | undefined = this.names[this.cursor % this.names.length];
    this.cursor++;
    if (name === undefined) {
      return;
    }
    const remembered: PipelineDiagramModel | undefined = this.seen.get(name);
    if (remembered !== undefined) {
      this.model_stage(remembered);
      return;
    }
    this.command_run(`pipeline diagram ${arg_quote(name)}`);
  }
}

/**
 * Seeds the ambient cycler: the registered pipelines are already listed in
 * /bin, so one silent ls names them all. Unobserved: this is an
 * instrument's read, and a browser that follows the session must not be
 * steered to /bin by it — which is how every boot used to open there.
 *
 * @param client - The wire.
 * @param cycler - The cycler to name the pipelines to.
 */
export function cyclerNames_seed(client: Pick<ArgusClient, 'line_execute'>, cycler: Pick<PipelineCycler, 'names_set'>): void {
  void client.line_execute('ls /bin', { silent: true, observe: false }).then((outcome: ExecuteOutcome): void => {
    const listing: WireEnvelope | undefined = outcome.envelopes.find(
      (envelope: WireEnvelope): boolean => envelope.model?.kind === 'fs.listing',
    );
    const data: FsListing[] | undefined = listing?.model?.data as FsListing[] | undefined;
    const names: string[] = (data ?? [])
      .flatMap((entry: FsListing) => entry.items)
      .filter((item): boolean => item.type === 'pipeline')
      .map((item): string => item.name);
    cycler.names_set(names);
  });
}
