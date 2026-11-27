/**
 * @file A /bin entry as the graph it is. Both kinds take this path: a
 * pipeline is many nodes, a plugin is one, and there is no third
 * rendering — the same stage, the same mode frame and the same dive-in
 * gesture. A node's substance arrives with the graph, so a touch reads it
 * out and a dive goes in, and nothing is fetched for either. In a bound
 * catalogue the graph is a form: each argument a VALUE cell writing its
 * flag into the strip's line.
 *
 * A module of the host: the host hands in the catalogue bindings and RUN
 * as hooks; the module keeps the dive in progress.
 */
import { DAG_MODEL_KINDS, PLUGIN_INFO_MODEL_KIND, pipelineDiagramModelSchema, pluginInfoModelSchema, type PipelineDiagramNode, type PluginInfoModel, type PluginParameter, path_quote, arg_quote } from '@fnndsc/menu';
import type { ExecuteOutcome } from '../calypso/client.js';
import { ansi_renderHtml, html_escape } from '../console/ansi.js';
import type { FilesPanel } from '../features/files/panel.js';
import { more_wire } from '../features/roster/more.js';
import { pipelineNode_selector, runLine_compose, runLine_executable, runLine_flagGet, runLine_flagSet, type RunFlagValue } from '../features/files/runLine.js';
import { ChrisSpace, type SceneNode } from '../scene/chrisSpace.js';
import type { CatalogueBinding } from './desktop.js';
import type { HostContext } from './hostContext.js';

/** How long the PULSE pill stays lit after a press. */
export const DIAGRAM_PULSE_LIT_MS: number = 2200;

/**
 * What a /bin entry contributes to the one graph view: a summary above the
 * stage (empty when the graph says it all), the graph itself, and how one
 * of its nodes reads out.
 */
export interface BinGraph {
  /** Summary HTML shown above the stage; '' for none. */
  text: string;
  /** The graph, as the scene wants it. */
  nodes: SceneNode[];
  /** Fills the overlay for one node, selected or immersed, writing into the form's line when the view is a form. */
  facts_show: (facts: HTMLElement, nodeId: string, immersed: boolean, form: BinForm | null) => void;
}

/**
 * The graph as a form: the line a bound catalogue holds, read and written
 * by the dive's VALUE cells. The line is the only state — a value typed
 * here is a flag there, and a hand edit there is what a cell reads here.
 */
export interface BinForm {
  line_get: () => string;
  line_set: (line: string) => void;
  /** Runs the line, as RUN in the row zone does. */
  run: () => void;
}

/** One row of a node's readout: a label and what it says, and — in a form — the flag the row edits. */
export interface FactRow {
  label: string;
  value: string;
  edit?: { flag: string; type: string; placeholder: string };
}

/** What the /bin view asks of the host. */
export interface BinViewHooks {
  /** A catalogue pane's binding, when the pane is one. */
  catalogue_find: (paneId: string) => CatalogueBinding | undefined;
  /** RUN on a bound catalogue: the line as it reads, for this executable. */
  run_press: (paneId: string, executable: string, kind: 'plugin' | 'pipeline') => void;
}

/** The /bin view verbs a wired host has. */
export interface BinView {
  /** Opens a /bin entry as context in a pane. */
  entry_show: (id: string, panel: FilesPanel, path: string, kind: 'plugin' | 'pipeline') => void;
  /**
   * Leaves a /bin node, flying the camera back to where it was.
   *
   * @returns True when a dive was in progress and this ended it.
   */
  dive_leave: () => boolean;
}

/**
 * Highlights a /bin entry's summary: ANSI as it comes, else the manual's
 * strings, flags, keys and headings. Passes run inline-first, line-anchored
 * last, so the later patterns cannot match inside markup the earlier ones
 * inserted.
 *
 * @param text - The summary.
 * @returns HTML.
 */
export function binText_highlight(text: string): string {
  if (/\x1b\[/.test(text)) return ansi_renderHtml(text);
  return html_escape(text)
    .replace(/(&quot;[^&]*&quot;)/g, '<span class="man-str">$1</span>')
    .replace(/(^|\s)(--?[a-zA-Z][\w-]*)/g, '$1<span class="man-flag">$2</span>')
    .replace(/^(\s{0,2})([A-Za-z_ ]+):(\s)/gm, '$1<span class="man-key">$2:</span>$3')
    .replace(/^([A-Z][A-Z ]{2,})$/gm, '<span class="man-head">$1</span>');
}

/**
 * What a pipeline node has to say: what it WILL run with — a plugin, a
 * version, and the arguments the author fixed. Immersed, every argument is
 * listed; selected, the node says what it is plus how much there is to see.
 * As a form, each authored argument is a VALUE cell writing
 * `--<node>.<param>` — the node its title when shell-safe and unique, else
 * `@<pipingId>`, as the kernel resolves it.
 *
 * @param node - The authored node, when the model carried one.
 * @param immersed - Whether the camera has flown into it.
 * @param form - Whether the view is a form.
 * @param titles - Every node title in the pipeline, for the selector.
 * @returns The rows to paint.
 */
export function pipelineNodeRows_build(node: PipelineDiagramNode | undefined, immersed: boolean, form: boolean, titles: ReadonlyArray<string>): FactRow[] {
  if (node === undefined) return [];
  const args: ReadonlyArray<{ name: string; value?: unknown }> = node.arguments ?? [];
  const rows: FactRow[] = [
    { label: 'NODE', value: `${node.label} · @${node.id}` },
    { label: 'PLUGIN', value: node.pluginName },
    ...(node.pluginVersion !== undefined ? [{ label: 'VERSION', value: node.pluginVersion }] : []),
  ];
  if (immersed) {
    // An authored node with nothing fixed says so: an empty panel would
    // read as a failure to load rather than as a plugin run on defaults.
    const selector: string = pipelineNode_selector(node.label, node.id, titles);
    rows.push(...(args.length === 0
      ? [{ label: 'ARGUMENTS', value: 'none — this node runs on the plugin\'s defaults' }]
      : args.map((argument): FactRow => ({
        label: argument.name,
        value: String(argument.value ?? ''),
        ...(form ? { edit: { flag: `--${selector}.${argument.name}`, type: typeof argument.value === 'boolean' ? 'boolean' : 'string', placeholder: String(argument.value ?? '') } } : {}),
      }))));
  } else {
    rows.push({ label: 'ARGUMENTS', value: args.length === 0 ? 'none' : `${args.length} — open the node to read them` });
  }
  return rows;
}

/**
 * What a plugin has to say: what it CAN run with — every parameter it
 * declares, with the flag as an operator types it. As a form, every
 * parameter is a VALUE cell writing its flag into the line; what the
 * readout said (type, required, default, help) stays as the cell's hint.
 *
 * @param model - The plugin model.
 * @param immersed - Whether the camera has flown into the node.
 * @param form - Whether the view is a form.
 * @returns The rows to paint.
 */
export function pluginRows_build(model: PluginInfoModel, immersed: boolean, form: boolean): FactRow[] {
  const rows: FactRow[] = [
    { label: 'PLUGIN', value: model.name },
    { label: 'VERSION', value: model.version },
    { label: 'TYPE', value: model.type.toUpperCase() },
  ];
  const parameters: ReadonlyArray<PluginParameter> = model.parameters;
  if (!immersed) {
    rows.push({ label: 'PARAMETERS', value: parameters.length === 0 ? 'none' : `${parameters.length} — open the node to read them` });
    return rows;
  }
  if (parameters.length === 0) {
    rows.push({ label: 'PARAMETERS', value: 'none — this plugin takes no arguments' });
    return rows;
  }
  for (const parameter of parameters) {
    const parts: string[] = [parameter.type];
    if (!parameter.optional) parts.push('required');
    const fallback: string = parameter.default === undefined || parameter.default === null ? '' : String(parameter.default);
    if (fallback !== '') parts.push(`default ${fallback}`);
    const meta: string = parts.join(' · ');
    rows.push({
      label: parameter.flag,
      value: parameter.help === undefined ? meta : `${meta} — ${parameter.help}`,
      // The cell's ghost is the default alone: the hint beside it says the rest.
      ...(form ? { edit: { flag: parameter.flag, type: parameter.type, placeholder: fallback } } : {}),
    });
  }
  return rows;
}

/**
 * Paints a node's readout as `text : detail` pairs. One painter for every
 * /bin entry: a pipeline's node and a plugin differ in what they have to
 * say, never in how it is said. In a form, a row that edits a flag carries
 * a VALUE cell written back to the line on every keystroke; a boolean is a
 * check, since the console takes it bare.
 *
 * @param facts - The overlay to fill.
 * @param rows - The rows, in reading order.
 * @param immersed - Whether the camera has flown into the node.
 * @param form - The line the cells read and write, or null for a readout.
 */
export function facts_paint(facts: HTMLElement, rows: ReadonlyArray<FactRow>, immersed: boolean, form: BinForm | null): void {
  facts.replaceChildren();
  facts.classList.toggle('dag-facts-immersed', immersed);
  for (const { label, value, edit } of rows) {
    const row: HTMLDivElement = document.createElement('div');
    row.className = 'telemetry-row';
    const name: HTMLSpanElement = document.createElement('span');
    name.className = 'telemetry-label';
    name.textContent = label;
    row.appendChild(name);
    if (edit === undefined || form === null) {
      const figure: HTMLSpanElement = document.createElement('span');
      figure.className = 'telemetry-value';
      figure.textContent = value;
      row.appendChild(figure);
    } else {
      const current: RunFlagValue = runLine_flagGet(form.line_get(), edit.flag);
      const input: HTMLInputElement = document.createElement('input');
      input.className = 'telemetry-input';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.title = `${edit.flag} — ${value}`;
      if (edit.type === 'boolean') {
        input.type = 'checkbox';
        input.checked = current === true;
        input.addEventListener('change', (): void => {
          form.line_set(runLine_flagSet(form.line_get(), edit.flag, input.checked ? true : null));
        });
      } else {
        input.type = 'text';
        input.placeholder = edit.placeholder;
        input.value = current === null || current === true ? '' : current;
        input.addEventListener('input', (): void => {
          form.line_set(runLine_flagSet(form.line_get(), edit.flag, input.value));
        });
      }
      const hint: HTMLSpanElement = document.createElement('span');
      hint.className = 'telemetry-hint';
      hint.textContent = value;
      row.append(input, hint);
    }
    facts.appendChild(row);
  }
}

/**
 * Wires the pane's mode frame to a diagram on stage. A pane has ONE frame,
 * and its blocks answer to what the field holds: the listing's projection
 * and filter step aside for the modes a graph has. PULSE is a verb, not a
 * state: the wave runs once, when a hand asks for it, and what it replays
 * is dependency order, since a registered pipeline has never run.
 *
 * @param mount - The diagram's mount, used to find the pane's frame.
 * @param scene - The scene the blocks act on.
 * @param panel - The panel whose bar annunciates the modes in force.
 * @param run - RUN, when the graph is a form.
 * @returns A function releasing the listeners when the view closes.
 */
export function diagramModes_wire(mount: HTMLElement, scene: ChrisSpace, panel: FilesPanel, run?: () => void): () => void {
  const body: HTMLElement | null = mount.closest<HTMLElement>('.files-body');
  const strategyPill: HTMLElement | null = body?.querySelector<HTMLElement>('.diagram-strategy') ?? null;
  const projectionPill: HTMLElement | null = body?.querySelector<HTMLElement>('.diagram-projection') ?? null;
  const pulsePill: HTMLElement | null = body?.querySelector<HTMLElement>('.diagram-pulse') ?? null;
  // RUN rides the graph's frame only when the graph is a form.
  const runPill: HTMLElement | null = run === undefined ? null : body?.querySelector<HTMLElement>('.diagram-run') ?? null;
  const run_press = (): void => run?.();
  const modes_annunciate = (): void => {
    // Only what is NOT the default is worth saying; a bar that repeats the
    // resting state says nothing and costs a glance.
    const parts: string[] = [];
    if (scene.strategy_get() !== 'ranked') parts.push('MOLECULE');
    if (scene.projection_get() !== '3d') parts.push('2D');
    panel.mode_annunciate(parts.join(' · '));
  };
  const strategy_flip = (): void => {
    scene.strategy_set(scene.strategy_get() === 'ranked' ? 'molecule' : 'ranked');
    if (strategyPill !== null) strategyPill.textContent = scene.strategy_get().toUpperCase();
    modes_annunciate();
  };
  const projection_flip = (): void => {
    scene.projection_set(scene.projection_get() === '3d' ? '2d' : '3d');
    if (projectionPill !== null) projectionPill.textContent = scene.projection_get().toUpperCase();
    modes_annunciate();
  };
  const pulse_fire = (): void => {
    scene.wave_start();
    pulsePill?.classList.add('pulse-running');
    window.setTimeout((): void => pulsePill?.classList.remove('pulse-running'), DIAGRAM_PULSE_LIT_MS);
  };
  if (strategyPill !== null) strategyPill.textContent = scene.strategy_get().toUpperCase();
  if (projectionPill !== null) projectionPill.textContent = scene.projection_get().toUpperCase();
  strategyPill?.addEventListener('click', strategy_flip);
  projectionPill?.addEventListener('click', projection_flip);
  pulsePill?.addEventListener('click', pulse_fire);
  runPill?.addEventListener('click', run_press);
  modes_annunciate();
  return (): void => {
    strategyPill?.removeEventListener('click', strategy_flip);
    projectionPill?.removeEventListener('click', projection_flip);
    pulsePill?.removeEventListener('click', pulse_fire);
    runPill?.removeEventListener('click', run_press);
    pulsePill?.classList.remove('pulse-running');
  };
}

/**
 * Wires the /bin view to a host.
 *
 * @param context - The wire the entries are read over.
 * @param hooks - The catalogue bindings and RUN.
 * @returns The view verbs.
 */
export function binView_wire(context: Pick<HostContext, 'client'>, hooks: BinViewHooks): BinView {
  /** The diagram currently flown into, if any: the scene holding the camera and the overlay to clear when it comes home. */
  let dive: { scene: ChrisSpace; facts: HTMLElement } | null = null;

  /** Opens a /bin entry as the graph it is; the entry is read once the view is up. */
  const graph_show = (panel: FilesPanel, path: string, graph_fetch: () => Promise<BinGraph | null>, form: BinForm | null): void => {
    let scene: ChrisSpace | null = null;
    let modeRelease: (() => void) | null = null;
    const mount: HTMLElement | null = panel.contentHtml_show(path, '', {
      diagram: true,
      release: (): void => {
        dive = null;
        modeRelease?.();
        modeRelease = null;
        panel.mode_annunciate('');
        scene?.dispose();
        scene = null;
      },
    });
    if (mount === null) return;
    void graph_fetch().then((graph: BinGraph | null): void => {
      if (!mount.isConnected) return;
      if (graph === null || graph.nodes.length === 0) {
        mount.textContent = 'NOTHING TO DRAW FOR THIS ENTRY';
        mount.classList.add('files-diagram-empty');
        return;
      }
      if (graph.text !== '') panel.contentText_set(graph.text);
      const facts: HTMLElement = document.createElement('div');
      facts.className = 'dag-facts';
      // Immersed in a node (dag-facts-immersed) the readout scrolls; it says what it holds.
      more_wire(facts);
      mount.appendChild(facts);
      const built: ChrisSpace = new ChrisSpace(mount, {
        select: (node: SceneNode): void => graph.facts_show(facts, node.id, false, form),
        activate: (node: SceneNode): void => node_dive(node),
        deselect: (): void => facts.replaceChildren(),
      }, {});
      const node_dive = (node: SceneNode): void => {
        built.flight_into(node.id, (): void => {
          dive = { scene: built, facts };
          graph.facts_show(facts, node.id, true, form);
        });
      };
      scene = built;
      built.graph_set({ nodes: graph.nodes }, { wave: false });
      built.size_fit();
      modeRelease = diagramModes_wire(mount, built, panel, form === null ? undefined : form.run);
      // A level of one opens itself: a plugin is one node, and the only
      // thing to do on its stage is go in. The camera still flies, so the
      // dive reads as the same gesture a pipeline's node answers to.
      const only: SceneNode | undefined = graph.nodes.length === 1 ? graph.nodes[0] : undefined;
      if (only !== undefined) node_dive(only);
    });
  };

  /** Reads a registered pipeline as its authored graph, or null when it has no diagram. */
  const pipelineGraph_fetch = async (path: string): Promise<BinGraph | null> => {
    const specifier: string = /_id(\d+)$/.exec(path)?.[1] ?? path.replace(/^.*\//, '');
    // Asked together: the summary is a cache-only read and the diagram a
    // slow one, and making the stage wait on the text buys nothing.
    const [summary, diagram]: [ExecuteOutcome, ExecuteOutcome] = await Promise.all([
      context.client.line_execute(`cat ${path_quote(path)}`, { silent: true, observe: false }),
      context.client.line_execute(`pipeline diagram ${specifier}`, { silent: true, observe: false }),
    ]);
    const text: string = summary.envelopes.map((envelope): string => envelope.rendered).join('\n');
    for (const envelope of diagram.envelopes) {
      if (envelope.model?.kind !== DAG_MODEL_KINDS.pipelineDiagram) continue;
      const parsed = pipelineDiagramModelSchema.safeParse(envelope.model.data);
      if (!parsed.success) continue;
      const authored: Map<string, PipelineDiagramNode> = new Map(
        parsed.data.nodes.map((node: PipelineDiagramNode): [string, PipelineDiagramNode] => [node.id, node]),
      );
      return {
        text: binText_highlight(text),
        nodes: parsed.data.nodes.map((node: PipelineDiagramNode): SceneNode => ({
          id: node.id,
          label: node.label,
          parentIds: node.parentIds,
          joinParentIds: node.joinParentIds,
        })),
        facts_show: (facts: HTMLElement, nodeId: string, immersed: boolean, shown: BinForm | null): void => {
          const titles: string[] = parsed.data.nodes.map((node: PipelineDiagramNode): string => node.label);
          facts_paint(facts, pipelineNodeRows_build(authored.get(nodeId), immersed, shown !== null, titles), immersed, shown);
        },
      };
    }
    return null;
  };

  /** Reads a registered plugin as the one-node graph it is, or null when the kernel could not read it. */
  const pluginGraph_fetch = async (path: string): Promise<BinGraph | null> => {
    const entry: string = path.replace(/^.*\//, '');
    const outcome: ExecuteOutcome = await context.client.line_execute(`plugin info ${arg_quote(entry)}`, { silent: true, observe: false });
    for (const envelope of outcome.envelopes) {
      if (envelope.model?.kind !== PLUGIN_INFO_MODEL_KIND) continue;
      const parsed = pluginInfoModelSchema.safeParse(envelope.model.data);
      if (!parsed.success) continue;
      const model: PluginInfoModel = parsed.data;
      return {
        text: '',
        nodes: [{ id: entry, label: model.name, parentIds: [], joinParentIds: [] }],
        facts_show: (facts: HTMLElement, _nodeId: string, immersed: boolean, shown: BinForm | null): void => {
          facts_paint(facts, pluginRows_build(model, immersed, shown !== null), immersed, shown);
        },
      };
    }
    return null;
  };

  /**
   * The form a /bin entry's graph is, when the pane is a catalogue bound to
   * an input: the strip's line, started afresh for this executable unless
   * it already runs it (a hand edit stands; another entry's line does not).
   */
  const form_build = (id: string, panel: FilesPanel, path: string, kind: 'plugin' | 'pipeline'): BinForm | null => {
    const binding: CatalogueBinding | undefined = hooks.catalogue_find(id);
    if (binding === undefined) return null;
    const executable: string = path.replace(/^.*\//, '');
    if (runLine_executable(panel.commandLine_get()) !== executable) {
      panel.commandLine_set(runLine_compose(binding.input, executable));
    }
    return {
      line_get: (): string => panel.commandLine_get(),
      line_set: (line: string): void => panel.commandLine_set(line),
      run: (): void => hooks.run_press(id, executable, kind),
    };
  };

  const entry_show = (id: string, panel: FilesPanel, path: string, kind: 'plugin' | 'pipeline'): void => {
    graph_show(panel, path, (): Promise<BinGraph | null> => (kind === 'plugin' ? pluginGraph_fetch(path) : pipelineGraph_fetch(path)), form_build(id, panel, path, kind));
  };

  const dive_leave = (): boolean => {
    const held: { scene: ChrisSpace; facts: HTMLElement } | null = dive;
    if (held === null) return false;
    dive = null;
    held.scene.flight_back((): void => {
      held.facts.classList.remove('dag-facts-immersed');
      held.facts.replaceChildren();
    });
    return true;
  };

  return { entry_show, dive_leave };
}
