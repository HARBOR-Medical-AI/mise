/**
 * @file The console language's host: what a typed sentence may do to the
 * stage. The host hands the language the same controls the mouse uses —
 * focus and the pane verbs, the opens, the image and tags verbs resolved
 * to the pane a target stands for, a desktop serialized as the lines that
 * put it back.
 *
 * A module of the host: the host hands in its verbs and opens as hooks;
 * the module builds the `ArgusHost` the language reads.
 */
import { session_switch } from './sessionSwitch.js';
import { feedModes_hold } from '../features/feed/view.js';
import type { DicomSeriesModel } from '@fnndsc/menu';
import type { ExecuteOutcome } from '../calypso/client.js';
import type { ChrisLangHost } from '../compositions/chris/lang.js';
import { IMAGE_COLORMAPS, IMAGE_LAYOUTS, type ImageColormap, type ImageLayout } from '../features/image/engine.js';
import type { ImagePanel, SeriesChoice } from '../features/image/panel.js';
import type { TagsPanel } from '../features/tags/panel.js';
import type { HostContext } from './hostContext.js';
import type { LayoutNode } from './layout.js';
import type { PaneKind, PanelKind, PanelKinds } from './panes.js';
import type { PaneVerbs } from './paneVerbs.js';
import type { RegardValue } from './subjects.js';

/** What the host asks of its owner. */
export interface ConsoleHostHooks {
  /** Keeps the stage as a PANES card (desktop.capture). */
  stage_keep: () => void;
  /** Lists a folder in a files pane, rooted there. */
  files_open: (paneId: string, path: string) => boolean;
  verbs: Pick<PaneVerbs, 'move' | 'flip' | 'resize'>;
  help_open: () => string;
  notes_open: () => string;
  capacity_open: (family: string) => string;
  launcher_enter: () => void;
  /** Opens the trek bridge with a `trek` line; answers what happened. */
  trek_open: (line: string) => string;
  /** The cloud door's answer for this session (D14): MANAGE, READ, or null with no door. */
  manage_is: () => boolean | null;
  /** Raises a READ session with the person's password, for a line that would act. */
  elevate_ask: (line: string) => Promise<boolean>;
  /** The session's identity, as the prompt last named it. */
  identity_get: () => string | null;
  /** Zooms the console to the whole stage and back. */
  consoleZoom_toggle: () => void;
  /** The primary DAG enters a feed. */
  feed_enter: (feedId: number) => void;
  file_save: (path: string) => void;
  image_open: (paneId: string | null, path: string, options: { force?: boolean }) => Promise<string>;
  /** A DICOM series read for `image series <n>`. */
  series_ask: (path: string) => Promise<DicomSeriesModel | null>;
  /** The TAGS pane beside an image pane, opened or focused. */
  tagsPane_open: (imageId: string) => string;
}

/**
 * Builds the host the console language reads.
 *
 * @param context - The layout, the panels, the pane mounts, the subjects, the console and the wire.
 * @param hooks - The owner's verbs and opens.
 * @returns The host.
 */
export function argusHost_build(context: Pick<HostContext, 'layout' | 'panels' | 'paneInstance_get' | 'subjects' | 'terminal' | 'client' | 'sound'>, hooks: ConsoleHostHooks): ChrisLangHost {
  const { layout, panels, paneInstance_get, subjects } = context;
  const paneKind_get = (id: string): PaneKind | null => paneInstance_get(id)?.kind ?? null;

  /**
   * The pane of a kind a target stands for: itself, the one in its link
   * group, or the only one on stage.
   */
  const panel_findForTarget = <K extends PanelKind>(kind: K, paneId: string): PanelKinds[K] | undefined => {
    const shown: Set<string> = new Set(layout.panes_shown());
    const group: string = subjects.group_resolve(paneId);
    const onStage: Array<[string, PanelKinds[K]]> = panels.entries(kind).filter(([id]: [string, PanelKinds[K]]): boolean => shown.has(id));
    return panels.get(kind, paneId)
      ?? onStage.find(([id]: [string, PanelKinds[K]]): boolean => subjects.group_resolve(id) === group)?.[1]
      ?? (onStage.length === 1 ? onStage[0]?.[1] : undefined);
  };

  /** The image verbs, on the pane a target stands for. */
  const imageVerb_run = async (panel: ImagePanel, verb: string, args: string[]): Promise<string> => {
    if (verb === 'state') {
      // A surface can be asked what it holds: the layout, the tool, the
      // slices, and each viewport's zoom, focus and live window — what a
      // drag on the field changed, read from the field itself.
      const state = panel.state_get();
      if (state === null) return 'image state: no image on the field';
      const views: string = (state.viewports ?? [])
        .map((v) => `${v.id.replace(/^.*-/, '')} scale=${v.scale.toFixed(3)} focus=${v.focus.map((n: number): string => n.toFixed(2)).join(',')} voi=${v.voi === null ? '-' : `${v.voi.lower.toFixed(1)}..${v.voi.upper.toFixed(1)}`}`)
        .join(' | ');
      return `image: layout=${state.layout} tool=${state.tool} primary=${state.primaryTool ?? '-'} slice=${state.slice}/${state.slices} refused=${state.refused} annotations=${state.annotations} filled=${state.filled}\nviewports: ${views || '(none)'}`;
    }
    if (verb === 'layout') {
      const layoutName: string = args[0] ?? '';
      if (!(IMAGE_LAYOUTS as readonly string[]).includes(layoutName)) return 'image layout single|mpr|3d|slab';
      if (await panel.layout_set(layoutName as ImageLayout)) return `image layout ${layoutName}`;
      return panel.state_get()?.waiting === layoutName ? `image layout ${layoutName}: waiting for LOAD` : `image layout ${layoutName}: not offered`;
    }
    if (verb === 'slice') {
      const slice: number = Number(args[0]);
      if (!Number.isInteger(slice) || slice < 1) return 'image slice <n>';
      return panel.slice_set(slice) ? `image slice ${slice}` : `image slice ${slice}: not offered`;
    }
    if (verb === 'series') {
      const n: number = Number(args[0]);
      const siblings: readonly SeriesChoice[] = panel.siblings_get();
      if (siblings.length === 0) return 'image series: this pane holds one series, not a study';
      const choice: SeriesChoice | undefined = siblings[n - 1];
      if (choice === undefined) return `image series <1..${siblings.length}>: ${siblings.map((sibling: SeriesChoice, index: number): string => `${index + 1} ${sibling.label}`).join(' · ')}`;
      const series: DicomSeriesModel | null = await hooks.series_ask(choice.path);
      if (series === null) return `image series ${n}: ${choice.path}: not a readable DICOM series`;
      void panel.series_show(series, { siblings: [...siblings] });
      return `image series ${n} ${choice.label}`;
    }
    if (verb === 'wl') {
      if ((args[0] ?? '').toLowerCase() === 'preset') {
        const name: string = args[1] ?? '';
        if (name === '') return 'image wl preset <brain|bone|lung|soft|liver>';
        return panel.wlPreset_set(name) ? `image wl preset ${name}` : `image wl preset ${name}: none for this modality`;
      }
      const lower: number = Number(args[0]);
      const upper: number = Number(args[1]);
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) return 'image wl <lower> <upper> | image wl preset <name>';
      return panel.wl_set(lower, upper) ? `image wl ${lower} ${upper}` : 'image wl: not offered';
    }
    if (verb === 'colormap') {
      const name: string = (args[0] ?? '').toLowerCase();
      if (!(IMAGE_COLORMAPS as readonly string[]).includes(name)) return 'image colormap gray|hot|jet|cool';
      return panel.colormap_set(name as ImageColormap) ? `image colormap ${name}` : `image colormap ${name}: not offered`;
    }
    if (verb === 'save') return (await panel.annotations_save()) ? 'image save' : 'image save: nothing saved (the console says why)';
    if (verb === 'load') return (await panel.load_press()) ? 'image load' : 'image load: nothing was waiting';
    // The frame's STOP block, as a line: the wait in flight on this pane.
    if (verb === 'stop') return panel.wait_stop() ? 'image stop' : 'image stop: nothing is opening or loading';
    if (verb === 'guard') {
      const word: string = (args[0] ?? '').toLowerCase();
      if (word === 'off') {
        panel.guard_set(null);
        return 'image guard off';
      }
      const bytes: number = Number(args[0]);
      if (!Number.isFinite(bytes) || bytes < 0) return `image guard <bytes>|off (now ${panel.guard_get() === null ? 'off' : panel.guard_get()})`;
      panel.guard_set(bytes);
      return `image guard ${bytes}`;
    }
    if (verb === 'ghost') {
      const word: string = (args[0] ?? '').toLowerCase();
      const level: number | null = word === 'off' ? null : Number(args[0]);
      if (level !== null && (!Number.isFinite(level) || level < 0 || level > 1)) return 'image ghost <0..1>|off (SLAB layout)';
      return panel.ghost_set(level) ? `image ghost ${level === null ? 'off' : level}` : 'image ghost: SLAB layout only';
    }
    if (verb === 'tags') {
      const imageId: string | null = panels.idOf('image', panel);
      return imageId === null ? 'image tags: no image pane' : hooks.tagsPane_open(imageId);
    }
    return 'image <path> · layout single|mpr|3d · slice <n> · series <n> · wl <lo> <hi> | wl preset <name> · colormap <name> · save';
  };

  /** The tags verbs, on the pane a target stands for. */
  const tagsVerb_run = (panel: TagsPanel, verb: string, args: string[]): string => {
    if (verb === 'redact') {
      const wanted: string = (args[0] ?? '').toLowerCase();
      if (wanted !== 'on' && wanted !== 'off') return 'tags redact on|off';
      panel.redact_set(wanted === 'on');
      return `tags redact ${wanted}`;
    }
    if (verb === 'filter') {
      const text: string = args.join(' ');
      if (text === '' || text.toLowerCase() === 'off') {
        panel.filter_set(null);
        return 'tags filter off';
      }
      panel.filter_set(text);
      return `tags filter ${text}`;
    }
    return 'tags redact on|off · filter <text>|off';
  };

  /** The stage as the lines that put it back: the view, the splits with their bindings, each pane's dress. */
  const desktop_serialize = (): string => {
    const tree: LayoutNode | null = layout.tree_get();
    if (tree === null) return '# empty desktop';
    const lines: string[] = [];
    const firstLeaf = (node: LayoutNode): string => ('pane' in node ? node.pane : firstLeaf(node.first));
    const anchorId: string = firstLeaf(tree);
    const anchorKind: string | null = paneKind_get(anchorId);
    lines.push(`view ${anchorKind === 'dag' ? 'runs' : anchorKind === 'pacs' ? 'pacs' : 'files'}`);
    let counter: number = 1;
    const dress = (paneId: string, ordinal: number): void => {
      const kind: string | null = paneKind_get(paneId);
      if (kind === 'dag' && paneId !== anchorId) lines.push(`pane %${ordinal} claim runs`);
      if (kind === 'files' && paneId !== anchorId && !(subjects.group_resolve(paneId) !== paneId)) lines.push(`pane %${ordinal} claim files`);
      // A files pane says the folder it shows (a view never moves the
      // receiver's working directory, so it is listed there, rooted).
      const folder: string | null = kind === 'files' ? panels.get('files', paneId)?.path_current() ?? null : null;
      if (folder !== null) lines.push(`file %${ordinal} open ${folder}`);
      // A graph on stage says its whole view and where it stands, as the
      // PANES cards do (DagPanel.view_lines).
      const graph = kind === 'dag' ? panels.get('dag', paneId) : undefined;
      if (graph !== undefined && graph.graph_isShown()) {
        for (const line of graph.view_lines()) lines.push(line.replace(/^dag /, `dag %${ordinal} `));
      } else if (kind === 'dag') {
        const mount: HTMLElement | undefined = paneInstance_get(paneId)?.mount;
        const strategy: string = mount?.querySelector('.dag-strategy')?.textContent?.toLowerCase() ?? 'ranked';
        const projection: string = mount?.querySelector('.dag-projection')?.textContent?.toLowerCase() ?? '3d';
        const hue: string = mount?.querySelector('.dag-hue')?.textContent?.toLowerCase() ?? 'status';
        if (strategy !== 'ranked') lines.push(`dag %${ordinal} layout ${strategy}`);
        if (projection !== '3d') lines.push(`dag %${ordinal} projection ${projection}`);
        if (hue !== 'status') lines.push(`dag %${ordinal} hue ${hue}`);
      }
    };
    const build = (node: LayoutNode, ordinal: number): void => {
      if ('pane' in node) {
        dress(node.pane, ordinal);
        return;
      }
      const secondAnchor: string = firstLeaf(node.second);
      const secondKind: string | null = paneKind_get(secondAnchor);
      const binding: string = secondKind === 'view'
        ? 'viewer'
        : secondKind === 'files' && subjects.group_resolve(secondAnchor) !== secondAnchor ? 'fs' : 'unlinked';
      lines.push(`pane %${ordinal} bind ${binding}`);
      lines.push(`pane %${ordinal} split ${node.dir === 'col' ? 'right' : 'below'}`);
      const newOrdinal: number = ++counter;
      build(node.first, ordinal);
      build(node.second, newOrdinal);
    };
    build(tree, counter);
    const headerFace: string | undefined = document.body.dataset['header'];
    if (headerFace !== undefined) lines.push(`header ${headerFace}`);
    const drawerEl: HTMLElement | null = document.getElementById('drawer');
    if (drawerEl?.classList.contains('drawer-closed')) lines.push('console close');
    return lines.join('\n');
  };

  return {
    focused_get: (): string | null => {
      const zoomed: string | undefined = document.body.dataset['zoom'];
      if (zoomed !== undefined && zoomed !== 'console') return zoomed;
      // Before any click nothing is focused; the first shown pane is the
      // sentence's natural default target.
      return layout.focused_get() ?? layout.panes_shown()[0] ?? null;
    },
    focus_set: (id: string): boolean => {
      if (paneInstance_get(id) === undefined) return false;
      layout.focus_set(id);
      return true;
    },
    panes_shown: (): string[] => layout.panes_shown(),
    pane_move: hooks.verbs.move,
    pane_flip: hooks.verbs.flip,
    pane_resize: hooks.verbs.resize,
    help_open: hooks.help_open,
    notes_open: hooks.notes_open,
    capacity_open: hooks.capacity_open,
    focus_last: (): string | null => {
      const back: string | null = layout.focus_last();
      if (back !== null) context.sound('audio3');
      return back === null ? null : `focused ${back}`;
    },
    paneRect_get: (id: string): DOMRect | null => document.querySelector<HTMLElement>(`.layout-leaf[data-leaf="${id}"]`)?.getBoundingClientRect() ?? null,
    paneMount_get: (id: string): HTMLElement | null => paneInstance_get(id)?.mount ?? null,
    paneKind_get,
    paneLinked_get: (id: string): boolean => subjects.group_resolve(id) !== id,
    feed_enter: hooks.feed_enter,
    consoleZoom_toggle: hooks.consoleZoom_toggle,
    launcher_enter: hooks.launcher_enter,
    trek_open: hooks.trek_open,
    manage_is: hooks.manage_is,
    elevate_ask: hooks.elevate_ask,
    // The door's, not the session's: the page asks the porter it came through.
    session_switch: session_switch,
    stage_keep: hooks.stage_keep,
    viewModes_hold: feedModes_hold,
    // The prompt already says who and where; `attach` repeats it rather
    // than asking the session a question it has just been told the answer to.
    identity_get: hooks.identity_get,
    dag_jump: (paneId: string, target: string, enter: boolean = false): boolean => {
      const panel = panels.get('dag', paneId) ?? panels.values('dag')[0];
      if (panel === undefined) return false;
      panel.target_jumpTo(target, enter);
      return true;
    },
    node_immerse: (paneId: string): boolean => {
      const regard: RegardValue | null = subjects.regard_get(paneId);
      const match: RegExpMatchArray | null = regard?.address.match(/_(\d+)(?:\/data)?\/?$/) ?? null;
      if (match === null) return false;
      return panels.get('dag', paneId)?.node_flyTo(parseInt(match[1] ?? '', 10)) ?? false;
    },
    // The two row verbs, as the surface's own capability: the console
    // language presses them and the row's action track presses the same pair.
    files_open: hooks.files_open,
    file_download: (paneId: string): boolean => {
      const regard: RegardValue | null = subjects.regard_get(paneId);
      if (regard === null || regard.modelKind !== 'fs.file') return false;
      hooks.file_save(regard.address);
      return true;
    },
    image_open: (paneId: string | null, path: string, options?: { force?: boolean }): Promise<string> => hooks.image_open(paneId, path, options ?? {}),
    image_control: async (paneId: string, verb: string, args: string[]): Promise<string> => {
      const panel: ImagePanel | undefined = panel_findForTarget('image', paneId);
      if (panel === undefined) return `image ${verb}: no image pane on stage for '${paneId}'`;
      return imageVerb_run(panel, verb, args);
    },
    universe_control: (paneId: string | null, verb: string, args: string[]): string => {
      // The universe in focus, or the one on stage: the console addresses
      // the space, not a pane number.
      const shown: Set<string> = new Set(layout.panes_shown());
      const panel = (paneId !== null ? panels.get('universe', paneId) : undefined)
        ?? panels.entries('universe').find(([id]): boolean => shown.has(id))?.[1];
      if (panel === undefined) return 'universe: no universe pane on stage (press the dashboard tile)';
      return panel.control(verb, args);
    },
    tags_control: (paneId: string, verb: string, args: string[]): string => {
      const panel: TagsPanel | undefined = panel_findForTarget('tags', paneId);
      if (panel === undefined) return `tags ${verb}: no tags pane on stage for '${paneId}'`;
      return tagsVerb_run(panel, verb, args);
    },
    file_delete: (paneId: string): boolean => {
      const regard: RegardValue | null = subjects.regard_get(paneId);
      if (regard === null || regard.modelKind !== 'fs.file') return false;
      // A destructive verb runs as a VISIBLE terminal command: auditable in
      // the transcript, never a silent mutation behind a control.
      context.terminal.line_run(`rm "${regard.address}"`);
      return true;
    },
    session_run: async (line: string): Promise<string> => {
      try {
        const outcome: ExecuteOutcome = await context.client.line_execute(line, { silent: true, observe: false });
        return outcome.envelopes.map((envelope): string => envelope.renderedErr ?? envelope.rendered).join('\n');
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    desktop_serialize,
  };
}
