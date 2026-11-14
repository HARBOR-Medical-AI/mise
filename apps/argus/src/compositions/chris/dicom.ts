/**
 * @file The ChRIS composition's DICOM panes: a series or a volume on a guest
 * engine's field, and the tags of the instance it shows, following its slice.
 *
 * Built from the frame's pieces, handed in as a context whose every member is
 * read when it is used.
 *
 * @module
 */
import { element_require, template_stamp, pane_find } from '../../frame/dom.js';
import { DICOM_MODEL_KINDS, dicomSeriesModelSchema, dicomTagsModelSchema, type DicomSeriesModel, type DicomTagsModel } from '@fnndsc/menu';
import type { ArgusClient, ExecuteOutcome } from '../../calypso/client.js';
import { paneInstance_dispose, type PaneInstance, type PaneKind, type PanelRoster } from '../../app/panes.js';
import type { SubjectBus } from '../../app/subjects.js';
import type { LayoutManager } from '../../app/layout.js';
import type { Desktop } from '../../app/desktop.js';
import type { ArgusTerminal } from '../../console/terminal.js';
import { ImagePanel, type SeriesChoice } from '../../features/image/panel.js';
import { TagsPanel } from '../../features/tags/panel.js';
import { DICOM_FILE_PATTERN, VOLUME_FILE_PATTERN } from '../../features/image/engine.js';

/** What the DICOM panes reach in the running surface. */
export interface ChrisDicomContext {
  client(): ArgusClient;
  terminal(): ArgusTerminal;
  panels(): PanelRoster;
  subjects(): SubjectBus;
  layout(): LayoutManager;
  desktop(): Desktop;
  /** Makes a new pane of a kind, perhaps inheriting a group. */
  instance_spawn(kind: PaneKind, inheritFrom?: string): PaneInstance;
  /** The pane an errand opens beside, when none is named. */
  errandHost_find(): string | null;
  /** Steps the dashboard aside when a pane takes the stage. */
  launcher_yield(): void;
  /** Records where a new pane was born beside its parent, for its group's restore. */
  birth_record(childId: string, parent: string, dir: 'row' | 'col', before: boolean, binding?: string): void;
  /** The URL that serves a CFS path to this surface. */
  vfsUrl_build(path: string): string;
}

// The image pane: a series or a volume on a guest engine's field, inside
// mise's frame (docs/aegis.adoc: an-instruments-field-is-foreign,
// focus-stays-in-the-field).
function imageInstance_build(ctx: ChrisDicomContext, id: string): PaneInstance {
  const mount: HTMLElement = template_stamp('tpl-pane-image');
  const panel: ImagePanel = new ImagePanel(mount, {
    source: { url_resolve: (path: string): string => ctx.vfsUrl_build(path) },
    note: (line: string): void => ctx.terminal().line_note(line),
    regard: (path: string): void => ctx.subjects().regard_write(id, { address: path, modelKind: 'dicom.instance' }),
    file_put: async (path: string, body: Blob): Promise<number> => {
      try {
        return (await fetch(ctx.vfsUrl_build(path), { method: 'POST', body })).status;
      } catch {
        return 0;
      }
    },
    // The overlay reads the header of the series on the field. Same ask
    // the tags pane makes, same silence: an instrument never interrupts.
    tags_read: (path: string): Promise<DicomTagsModel | null> => tags_ask(ctx, path),
    tags_open: (): void => {
      ctx.terminal().line_note(tagsPane_open(ctx, id));
    },
  });
  ctx.panels().set('image', id, panel);
  return {
    id,
    kind: 'image',
    mount,
    dispose: (): void => {
      panel.dispose();
      ctx.panels().delete(id);
      ctx.subjects().pane_leave(id);
    },
  };
}

// The tags pane: a DICOM instance's elements, following the image pane's
// slice through the group's regard (docs/aegis.adoc: tags-follow-the-image).
function tagsInstance_build(ctx: ChrisDicomContext, id: string): PaneInstance {
  const mount: HTMLElement = template_stamp('tpl-pane-tags');
  const panel: TagsPanel = new TagsPanel(mount, {
    note: (line: string): void => ctx.terminal().line_note(line),
  });
  ctx.panels().set('tags', id, panel);
  return {
    id,
    kind: 'tags',
    mount,
    dispose: (): void => {
      ctx.panels().delete(id);
      ctx.subjects().pane_leave(id);
    },
  };
}

/** Asks the kernel for a file's tags, silently, and paints them on a tags pane. */
async function tags_ask(ctx: ChrisDicomContext, path: string): Promise<DicomTagsModel | null> {
  try {
    const outcome: ExecuteOutcome = await ctx.client().line_execute(`dcm tags "${path}"`, { silent: true, observe: false });
    for (const envelope of outcome.envelopes) {
      if (envelope.model?.kind !== DICOM_MODEL_KINDS.tags) continue;
      const parsed = dicomTagsModelSchema.safeParse(envelope.model.data);
      if (parsed.success) return parsed.data;
    }
  } catch {
    /* answered below */
  }
  return null;
}
function tagsPane_follow(ctx: ChrisDicomContext, id: string, path: string): void {
  const panel: TagsPanel | undefined = ctx.panels().get('tags', id);
  if (panel === undefined || panel.path_get() === path) return;
  void tags_ask(ctx, path).then((model: DicomTagsModel | null): void => {
    if (model === null) {
      ctx.terminal().line_note(`tags: ${path}: not a readable DICOM file`);
      return;
    }
    ctx.panels().get('tags', id)?.model_show(model);
  });
}

/**
 * Opens the tags pane that follows an image pane: the one already in its
 * link group, else a new one split beside it. It joins the group, so the
 * retained regard replays and the slice on screen is the first thing it
 * shows.
 */
function tagsPane_open(ctx: ChrisDicomContext, imageId: string): string {
  const shown: Set<string> = new Set(ctx.layout().panes_shown());
  const group: string = ctx.subjects().group_resolve(imageId);
  for (const id of ctx.panels().ids('tags')) {
    if (shown.has(id) && ctx.subjects().group_resolve(id) === group) {
      ctx.layout().focus_set(id);
      return 'image tags';
    }
  }
  if (!shown.has(imageId)) return 'image tags: the image pane is not on stage';
  const spawned: PaneInstance = ctx.instance_spawn('tags', imageId);
  if (!ctx.layout().leaf_split(imageId, ctx.desktop().replayPlace_get()?.dir ?? 'col', spawned.id, ctx.desktop().replayPlace_get()?.before ?? false)) {
    paneInstance_dispose(spawned.id);
    ctx.layout().mount_remove(spawned.id);
    return 'image tags: could not open beside the image pane';
  }
  ctx.birth_record(spawned.id, imageId, ctx.desktop().replayPlace_get()?.dir ?? 'col', ctx.desktop().replayPlace_get()?.before ?? false);
  return 'image tags';
}

/**
 * Asks the kernel what a folder is as a series. Silent: an instrument's
 * question, not a command the operator issued. A signal, aborted, cancels
 * the line in the session, and the answer is then no series.
 */
async function series_ask(ctx: ChrisDicomContext, path: string, signal?: AbortSignal): Promise<DicomSeriesModel | null> {
  try {
    const outcome: ExecuteOutcome = await ctx.client().line_execute(`dcm series "${path}"`, { silent: true, observe: false, ...(signal !== undefined ? { signal } : {}) });
    for (const envelope of outcome.envelopes) {
      if (envelope.model?.kind !== DICOM_MODEL_KINDS.series) continue;
      const parsed = dicomSeriesModelSchema.safeParse(envelope.model.data);
      if (parsed.success) return parsed.data;
    }
  } catch {
    /* a refusal is answered below */
  }
  return null;
}

/** The folders under a path, from a silent listing. */
async function subfolders_ask(ctx: ChrisDicomContext, path: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const outcome: ExecuteOutcome = await ctx.client().line_execute(`ls "${path}"`, { silent: true, observe: false, ...(signal !== undefined ? { signal } : {}) });
    for (const envelope of outcome.envelopes) {
      if (envelope.model?.kind !== 'fs.listing') continue;
      // One listing per path asked for, its entries under `items` — as the
      // launcher and the browser read it. Read as one object with
      // `entries`, this answered no folders for any path.
      const data: unknown = envelope.model.data;
      const listing = ((Array.isArray(data) ? data[0] : data) ?? {}) as { path?: string; items?: Array<{ name: string; type: string }> };
      const base: string = (listing.path ?? path).replace(/\/$/, '');
      return (listing.items ?? [])
        .filter((entry): boolean => entry.type === 'dir')
        .map((entry): string => `${base}/${entry.name}`);
    }
  } catch {
    /* no listing, no folders */
  }
  return [];
}

/**
 * The image pane that answers for a pane: itself when it is one, else
 * the image pane in its link group, else a new one split beside it.
 */
function imagePane_resolve(ctx: ChrisDicomContext, fromId: string | null, anchor?: { address: string; modelKind: string }): ImagePanel | null {
  // A series is a group anchored on its own address. When an anchor is
  // given (a viewer opened from PACS, which has no host group of its own),
  // the group's regard is set to the series so it IS that series' group,
  // and a viewer already on stage regarding the same series is reused
  // rather than spawning a second viewer for it.
  const anchor_set = (id: string): void => { if (anchor !== undefined) ctx.subjects().regard_write(id, anchor); };
  if (fromId !== null && ctx.panels().has('image', fromId)) { anchor_set(fromId); return ctx.panels().get('image', fromId) ?? null; }
  const shown: Set<string> = new Set(ctx.layout().panes_shown());
  if (anchor !== undefined) {
    for (const [id, panel] of ctx.panels().entries('image')) {
      if (shown.has(id) && ctx.subjects().regard_get(id)?.address === anchor.address) { anchor_set(id); return panel; }
    }
  }
  const group: string | null = fromId !== null ? ctx.subjects().group_resolve(fromId) : null;
  for (const [id, panel] of ctx.panels().entries('image')) {
    if (shown.has(id) && group !== null && ctx.subjects().group_resolve(id) === group) return panel;
  }
  const host: string | null = fromId !== null && shown.has(fromId) ? fromId : ctx.errandHost_find();
  if (host === null) return null;
  const spawned: PaneInstance = ctx.instance_spawn('image', fromId ?? undefined);
  if (!ctx.layout().leaf_split(host, ctx.desktop().replayPlace_get()?.dir ?? 'col', spawned.id, ctx.desktop().replayPlace_get()?.before ?? false)) {
    paneInstance_dispose(spawned.id);
    ctx.layout().mount_remove(spawned.id);
    return null;
  }
  ctx.birth_record(spawned.id, host, ctx.desktop().replayPlace_get()?.dir ?? 'col', ctx.desktop().replayPlace_get()?.before ?? false);
  anchor_set(spawned.id);
  return ctx.panels().get('image', spawned.id) ?? null;
}

/**
 * Opens a path as an image: a series folder, a study folder (its first
 * series, the rest offered to `image series <n>`), one DICOM file (its
 * series, starting at that slice), or a NIfTI/MGZ volume. Never a blank
 * field: what could not open is said by name.
 *
 * @returns The console line to print.
 */
async function image_open(ctx: ChrisDicomContext, fromId: string | null, path: string, options: { force?: boolean } = {}, onOpen?: (id: string) => void): Promise<string> {
  ctx.launcher_yield();
  // The pane is on stage before the kernel is asked. The ask is a header
  // read over a wire and can take seconds; a press that shows nothing for
  // those seconds is a press the operator repeats.
  // A viewer opened without a host group (from PACS) anchors its own group
  // on the series (or volume) it shows, so it is that series' group: the
  // pane drawer reaches it, and a second IMAGE on the same series reuses it.
  // A viewer opened from a pane that has a group (a files row) joins that
  // group as before, so no anchor is passed.
  const anchor: { address: string; modelKind: string } | undefined = fromId !== null ? undefined
    : VOLUME_FILE_PATTERN.test(path)
      ? { address: path, modelKind: 'image.volume' }
      : { address: DICOM_FILE_PATTERN.test(path) ? path.slice(0, path.lastIndexOf('/')) : path.replace(/\/$/, ''), modelKind: 'dicom.series' };
  const panel: ImagePanel | null = imagePane_resolve(ctx, fromId, anchor);
  if (panel === null) return 'image: no pane to open beside';
  // Structure-first: the pane exists now (spawned + split synchronously), so
  // hand its id back before the header read over the wire — a replay resolves
  // its next action's target against it without waiting for pixels to land.
  const openedId: string | null = ctx.panels().idOf('image', panel);
  if (openedId !== null) onOpen?.(openedId);
  if (VOLUME_FILE_PATTERN.test(path)) {
    panel.opening_show(path);
    void panel.volume_show(path);
    return `image ${path}`;
  }
  const isFile: boolean = DICOM_FILE_PATTERN.test(path);
  const folder: string = isFile ? path.slice(0, path.lastIndexOf('/')) : path.replace(/\/$/, '');
  // The frame's STOP ends the ask: the line running in the session is
  // cancelled, no further one is sent, and a late answer is not shown.
  const asking: AbortController = new AbortController();
  const stopped_say = (): string => `image: ${path}: stopped`;
  panel.opening_show(folder, (): void => asking.abort());
  let series: DicomSeriesModel | null = await series_ask(ctx, folder, asking.signal);
  if (asking.signal.aborted) return stopped_say();
  let siblings: SeriesChoice[] = [];
  if (series === null && !isFile) {
    // A study folder: hang its first series, list the rest.
    const folders: string[] = (await subfolders_ask(ctx, folder, asking.signal)).slice(0, 32);
    for (const candidate of folders) {
      if (asking.signal.aborted) break;
      const found: DicomSeriesModel | null = await series_ask(ctx, candidate, asking.signal);
      if (found === null) continue;
      siblings = folders.map((sibling: string): SeriesChoice => ({ path: sibling, label: sibling.split('/').pop() ?? sibling }));
      series = found;
      break;
    }
  }
  if (asking.signal.aborted) return stopped_say();
  if (series === null) {
    panel.opening_fail(path, 'NOT A READABLE SERIES');
    return `image: ${path}: not a readable DICOM series, study, or volume`;
  }
  const startAt: number = isFile ? Math.max(1, series.files.indexOf(path) + 1) : 1;
  void panel.series_show(series, { siblings, startAt, ...(options.force === true ? { force: true } : {}) });
  return `image ${series.path}${siblings.length > 1 ? ` (1 of ${siblings.length} series)` : ''}`;
}
/** The DICOM panes' builders and the verbs that open them, bound to a surface. */
export interface ChrisDicom {
  imageInstance_build(id: string): PaneInstance;
  tagsInstance_build(id: string): PaneInstance;
  tags_ask(path: string): Promise<DicomTagsModel | null>;
  tagsPane_follow(id: string, path: string): void;
  tagsPane_open(imageId: string): string;
  series_ask(path: string): Promise<DicomSeriesModel | null>;
  subfolders_ask(path: string): Promise<string[]>;
  imagePane_resolve(fromId: string | null, anchor?: { address: string; modelKind: string }): ImagePanel | null;
  image_open(fromId: string | null, path: string, options?: { force?: boolean }, onOpen?: (id: string) => void): Promise<string>;
}

/**
 * Binds the DICOM panes to a surface.
 *
 * @param ctx - What they reach.
 * @returns The builders and verbs.
 */
export function chrisDicom_make(ctx: ChrisDicomContext): ChrisDicom {
  return {
    imageInstance_build: (id: string): PaneInstance => imageInstance_build(ctx, id),
    tagsInstance_build: (id: string): PaneInstance => tagsInstance_build(ctx, id),
    tags_ask: (path: string): Promise<DicomTagsModel | null> => tags_ask(ctx, path),
    tagsPane_follow: (id: string, path: string): void => tagsPane_follow(ctx, id, path),
    tagsPane_open: (imageId: string): string => tagsPane_open(ctx, imageId),
    series_ask: (path: string): Promise<DicomSeriesModel | null> => series_ask(ctx, path),
    subfolders_ask: (path: string): Promise<string[]> => subfolders_ask(ctx, path),
    imagePane_resolve: (fromId: string | null, anchor?: { address: string; modelKind: string }): ImagePanel | null => imagePane_resolve(ctx, fromId, anchor),
    image_open: (fromId: string | null, path: string, options: { force?: boolean } = {}, onOpen?: (id: string) => void): Promise<string> =>
      image_open(ctx, fromId, path, options, onOpen),
  };
}
