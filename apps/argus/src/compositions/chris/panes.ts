/**
 * @file The ChRIS composition's own panes: RUNS (a feed's graph, the
 * roster of feeds) and the UNIVERSE (the space of everything run here).
 *
 * Each pane is built from the frame's pieces (its template, the session's
 * client and terminal, the panel roster, the regard) handed in as a context,
 * every member read when it is used: the client exists only once the session
 * is attached, after the builders are made.
 *
 * @module
 */
import { DAG_MODEL_KINDS, feedDagModelSchema, type FeedDagModel, path_quote } from '@fnndsc/menu';
import type { ArgusClient, ExecuteOutcome } from '../../calypso/client.js';
import { DagPanel } from '../../features/dag/panel.js';
import { UniversePanel } from '../../features/universe/panel.js';
import type { FilesPanel } from '../../features/files/panel.js';
import type { PaneInstance, PanelRoster } from '../../app/panes.js';
import type { SubjectBus } from '../../app/subjects.js';
import type { HostContext } from '../../app/hostContext.js';
import type { NodeOverlay } from '../../app/nodeOverlay.js';
import type { CatalogueBinding } from '../../app/desktop.js';
import type { ArgusTerminal } from '../../console/terminal.js';
import { localKeyStore } from '../../app/dormant.js';
import { feedRowHandlers_make, type FeedVerbs } from '../../app/feedRows.js';
import { feedOf_path } from '../../app/browser.js';
import { element_require, template_stamp, pane_find } from '../../frame/dom.js';

/** What the ChRIS panes reach in the running surface. */
export interface ChrisPaneContext {
  client(): ArgusClient;
  terminal(): ArgusTerminal;
  panels(): PanelRoster;
  subjects(): SubjectBus;
  context(): HostContext;
  feedVerbs(): FeedVerbs;
  nodeOverlay(): NodeOverlay;
  /** Opens a node's immersive view inside a pane. */
  nodeOverlay_open(paneId: string, root: string): void;
  /** Opens the catalogue bound to a place a run will start from. */
  process_open(fromId: string, binding: CatalogueBinding): void;
  /** The session's user, as the prompt last named it. */
  promptUser(): string | null;
  /** Raises RUNS. */
  runs_show(): void;
  /** The primary RUNS pane. */
  dag_primary(): DagPanel;
  /** Shows a /bin entry in a files pane. */
  binEntry_show(paneId: string, panel: FilesPanel, path: string, kind: 'plugin' | 'pipeline'): void;
  /** Raises RUNS when the primary RUNS pane shows a feed. */
  dag_summon(): void;
}

/** The ChRIS panes' builders. */
export interface ChrisPanes {
  /** A UNIVERSE pane. */
  universe_build(id: string): PaneInstance;
  /** A RUNS pane; the primary one summons RUNS when it shows a feed. */
  dag_build(id: string, primary: boolean): PaneInstance;
}

/**
 * Builds a UNIVERSE pane: the space of everything run here.
 *
 * @param ctx - What it reaches.
 * @param id - The pane's id.
 * @returns The pane.
 */
function universe_build(ctx: ChrisPaneContext, id: string): PaneInstance {
    const mount: HTMLElement = template_stamp('tpl-pane-universe');
    const panel: UniversePanel = new UniversePanel(
      {
        canvas: pane_find(mount, '.universe-canvas'),
        title: pane_find(mount, '.universe-title'),
        state: mount.querySelector<HTMLElement>('.pane-state'),
        empty: pane_find(mount, '.universe-empty'),
        projectionPill: mount.querySelector<HTMLElement>('.universe-projection'),
        refreshPill: mount.querySelector<HTMLElement>('.universe-refresh'),
        replayPill: mount.querySelector<HTMLElement>('.universe-replay'),
        scalePill: mount.querySelector<HTMLElement>('.universe-scale'),
        viewPill: mount.querySelector<HTMLElement>('.universe-view'),
        gravityPill: mount.querySelector<HTMLElement>('.universe-gravity'),
        densityPill: mount.querySelector<HTMLElement>('.universe-density'),
        drawPill: mount.querySelector<HTMLElement>('.universe-draw'),
        captionsPill: mount.querySelector<HTMLElement>('.universe-captions'),
        arrangementPill: mount.querySelector<HTMLElement>('.universe-arrangement'),
        facts: mount.querySelector<HTMLElement>('.universe-facts'),
        backPill: mount.querySelector<HTMLElement>('.universe-back'),
        openPill: mount.querySelector<HTMLElement>('.universe-open'),
        frame: mount.querySelector<HTMLElement>('.mode-frame'),
      },
      {
        // The entered feed is watched, as a RUNS pane watches the feed it shows.
        watch_set: (subject: string, on: boolean): void => {
          if (on) ctx.client().watch_send(subject);
          else ctx.client().unwatch_send(subject);
        },
        // The entered feed's note, tags and name, as a RUNS pane's (a-feed-has-one-view).
        ...(({ feed_entered, feed_note, feed_tag, feed_rename, feed_untag }) => ({ feed_entered, feed_note, feed_tag, feed_rename, feed_untag }))(feedRowHandlers_make(ctx.context(), id, ctx.feedVerbs())),
        command_run: (line: string): void => {
          void ctx.client()
            .line_execute(line, { silent: true, observe: false })
            .then((outcome: ExecuteOutcome): void => {
              for (const envelope of outcome.envelopes) panel.envelope_observe(envelope);
            });
        },
        // The descent asks the kernel for the feed's graph: the same
        // `feed diagram` the RUNS pane draws, taken silently here.
        feed_dag: async (feedId: number): Promise<FeedDagModel | null> => {
          const outcome: ExecuteOutcome = await ctx.client().line_execute(`feed diagram feed_${feedId}`, { silent: true, observe: false });
          for (const envelope of outcome.envelopes) {
            if (envelope.model?.kind !== DAG_MODEL_KINDS.feedDag) continue;
            const parsed = feedDagModelSchema.safeParse(envelope.model.data);
            if (parsed.success) return parsed.data;
          }
          return null;
        },
        node_enter: (vfsPath: string): void => {
          ctx.terminal().line_run(`cd ${path_quote(vfsPath)}`);
        },
        // ENTER NODE flies in: the camera into the sphere, a rooted browser
        // of the node's data inside it, Esc back out — the DAG pane's dive.
        node_dive: (vfsPath: string): void => {
          ctx.nodeOverlay_open(id, vfsPath.replace(/\/data$/, ''));
        },
        node_process: (node: { vfsPath: string; instanceId: number; label: string }): void => {
          const feed: number | null = feedOf_path(node.vfsPath)
            ?? (/\/feed_(\d+)(?:\/|$)/.exec(node.vfsPath) === null
              ? null
              : Number((/\/feed_(\d+)(?:\/|$)/.exec(node.vfsPath) as RegExpExecArray)[1]));
          const input: string = ctx.promptUser() === null
            ? node.vfsPath
            : node.vfsPath.replace(/^\/proc\/jobs\//, `/home/${ctx.promptUser()}/feeds/`);
          ctx.process_open(id, { input, feed, node: node.instanceId });
        },
        feed_open: (feedId: number): void => {
          ctx.runs_show();
          ctx.dag_primary().feed_enter(feedId);
        },
        // OPEN IN /BIN: the plugin's newest entry, opened in the browser as
        // every /bin entry opens — its one-node graph.
        plugin_open: (plugin: string): void => {
          void (async (): Promise<void> => {
            const outcome: ExecuteOutcome = await ctx.client().line_execute('ls /bin', { silent: true, observe: false });
            const names: string[] = [];
            for (const envelope of outcome.envelopes) {
              if (envelope.model?.kind !== 'fs.listing') continue;
              // One listing per path asked for.
              const data: unknown = envelope.model.data;
              const listings = (Array.isArray(data) ? data : [data]) as Array<{ items?: Array<{ name: string }> }>;
              for (const listing of listings) for (const item of listing.items ?? []) names.push(item.name);
            }
            const entry: string | undefined = names
              .filter((name: string): boolean => name.startsWith(`${plugin}-v`))
              .sort((a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true }))
              .pop();
            if (entry === undefined) {
              ctx.terminal().line_note(`universe: ${plugin} is not in /bin`);
              return;
            }
            element_require('gutter-files').click();
            ctx.binEntry_show('files', ctx.panels().get('files', 'files') as FilesPanel, `/bin/${entry}`, 'plugin');
          })().catch((error: unknown): void => {
            ctx.terminal().line_note(`universe: could not open ${plugin} in /bin: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
        note: (line: string): void => ctx.terminal().line_note(line),
      },
      localKeyStore(),
    );
    ctx.panels().set('universe', id, panel);
    return {
      id,
      kind: 'universe',
      mount,
      dispose: (): void => {
        ctx.panels().delete(id);
        ctx.subjects().pane_leave(id);
        panel.dispose();
      },
    };
  }

/**
 * Builds a RUNS pane; the primary one summons RUNS when it shows a feed.
 *
 * @param ctx - What it reaches.
 * @param id - The pane's id.
 * @param primary - Whether it is the primary RUNS pane.
 * @returns The pane.
 */
function dag_build(ctx: ChrisPaneContext, id: string, primary: boolean): PaneInstance {
    const mount: HTMLElement = template_stamp('tpl-pane-dag');
    const panel: DagPanel = new DagPanel(
      pane_find(mount, '.dag-canvas'),
      pane_find(mount, '.dag-title'),
      pane_find(mount, '.dag-facts'),
      pane_find(mount, '.dag-empty'),
      pane_find(mount, '.dag-strategy'),
      pane_find(mount, '.dag-feedlist'),
      {
        command_run: (line: string): void => {
          // The claim rule: a pane's own requests resolve to it alone.
          void ctx.client()
            .line_execute(line, { silent: true, observe: false })
            .then((outcome: ExecuteOutcome): void => {
              for (const envelope of outcome.envelopes) {
                panel.envelope_observe(envelope);
              }
            });
        },
        watch_set: (subject: string, on: boolean): void => {
          if (on) ctx.client().watch_send(subject);
          else ctx.client().unwatch_send(subject);
        },
        node_enter: (vfsPath: string): void => {
          ctx.terminal().line_run(`cd ${path_quote(vfsPath)}`);
        },
        node_dive: (vfsPath: string): void => {
          // The immersive root is the node itself — status, params, log,
          // data, children — not its data link; the label stays honest.
          ctx.nodeOverlay_open(id, vfsPath.replace(/\/data$/, ''));
        },
        node_regard: (vfsPath: string): void => {
          ctx.subjects().regard_write(id, { address: vfsPath, modelKind: 'feed.node' });
        },
        node_process: (node: { vfsPath: string; instanceId: number; label: string }): void => {
          // The graph addresses a node by its projection; the catalogue is
          // bound to the place a run will `cd` into, which is the node's own
          // data under the session's home. Same place, two names — and the
          // kernel appends to the instance it finds at the path.
          const feed: number | null = feedOf_path(node.vfsPath)
            ?? (/\/feed_(\d+)(?:\/|$)/.exec(node.vfsPath) === null
              ? null
              : Number((/\/feed_(\d+)(?:\/|$)/.exec(node.vfsPath) as RegExpExecArray)[1]));
          const input: string = ctx.promptUser() === null
            ? node.vfsPath
            : node.vfsPath.replace(/^\/proc\/jobs\//, `/home/${ctx.promptUser()}/feeds/`);
          ctx.process_open(id, { input, feed, node: node.instanceId });
        },
        feed_regard: (procPath: string): void => {
          ctx.subjects().regard_write(id, { address: procPath, modelKind: 'feed' });
        },
        ...feedRowHandlers_make(ctx.context(), id, ctx.feedVerbs()),
        ...(primary ? { feed_shown: (): void => ctx.dag_summon() } : {}),
      },
    );
    ctx.panels().set('dag', id, panel);
    return {
      id,
      kind: 'dag',
      mount,
      dispose: (): void => {
        ctx.nodeOverlay().dispose(id);
        ctx.panels().delete(id);
        ctx.subjects().pane_leave(id);
        panel.dispose();
      },
    };
  }

/**
 * Makes the ChRIS panes' builders.
 *
 * @param ctx - What they reach.
 * @returns The builders.
 */
export function chrisPanes_make(ctx: ChrisPaneContext): ChrisPanes {
  return {
    universe_build: (id: string): PaneInstance => universe_build(ctx, id),
    dag_build: (id: string, primary: boolean): PaneInstance => dag_build(ctx, id, primary),
  };
}
