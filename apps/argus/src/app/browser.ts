/**
 * @file The browser: a files pane as the host builds it. The primary is
 * slaved to the session cwd and navigates by real `cd`; a rooted browser
 * (a split's instance) navigates by targeted silent listings and keeps its
 * own history. A file activation is an indication: it writes the pane's
 * group regard, and when the group holds a viewer the viewer renders it;
 * the browser overlays its own content only as the viewerless fallback.
 * Every row verb lowers to a session command the operator can read in the
 * transcript.
 *
 * A module of the host: the host hands in its byte routes, its opens, its
 * asks, the cohort and the /bin view as hooks; the module keeps each
 * browser's binding and history, the preview provider and the readers.
 */
import { DAG_MODEL_KINDS, EDIT_CONFIRM_BYTES, path_isEditable, pipelineDiagramModelSchema, type PipelineDiagramNode, path_quote, arg_quote } from '@fnndsc/menu';
import { editAsk_render, editLine_compose } from '../features/edit/line.js';
import type { ExecuteOutcome } from '../calypso/client.js';
import type { PaneAskRequest } from '../features/ask/paneAsk.js';
import { browserDownload_save, downloadId_make, type DownloadOutcome } from '../features/files/download.js';
import { refusalWords_extract } from '../features/files/answer.js';
import { transfer_watch, type TransferRow } from '../features/files/transfer.js';
import { FilesPanel, extension_isImage, type FileAction, type FsListingEntry, type GlimpseNode, type PreviewProvider } from '../features/files/panel.js';
import type { GatherSeries } from '../features/gather/panel.js';
import { DICOM_FILE_PATTERN, VOLUME_FILE_PATTERN, seriesFolder_is } from '../features/image/engine.js';
import type { ListingAction } from '../features/roster/row.js';
import { FILE_ROW_ROSTER, FILES_SELECTION_ROSTER, type FileRowFacts, type FilesSelectionFacts } from '../features/roster/verbs.js';
import type { CatalogueBinding } from './desktop.js';
import type { HostContext } from './hostContext.js';
import type { FileText } from './nodeOverlay.js';
import type { PaneInstance } from './panes.js';
import { link_compose } from './link.js';

/** Files the surface shows as a table: every table on this surface is a listing. */
export const TABLE_FILE_PATTERN: RegExp = /\.(csv|tsv)$/i;

/**
 * Strips ANSI escape sequences from rendered text.
 *
 * @param text - The ANSI-decorated text.
 * @returns The plain text.
 */
export function ansi_strip(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
}

/**
 * Whether a path names something an image pane draws rather than a text
 * view: a NIfTI/MGZ volume, or a DICOM slice. One rule, asked by every
 * surface that answers a file click.
 *
 * @param path - The file's path.
 * @returns True when an image pane is what opens it.
 */
export function imagery_is(path: string): boolean {
  return VOLUME_FILE_PATTERN.test(path) || DICOM_FILE_PATTERN.test(path);
}

/**
 * The plugin instance whose own `data/` a path is, when it is one:
 * `…/<plugin>_<id>/data` (with or without a trailing slash).
 *
 * @param path - The path.
 * @returns The instance id, or null.
 */
export function nodeOf_path(path: string): number | null {
  const match: RegExpMatchArray | null = /_(\d+)\/data\/?$/.exec(path);
  return match === null ? null : parseInt(match[1] ?? '', 10);
}

/**
 * The feed a path names, by the kernel's own rule: a feed has two
 * addresses, the folder it stores its output in and the projection the
 * graph renders it as, and both name the same feed.
 *
 * @param path - The row's path.
 * @returns The feed id, or null when nothing in the path names one.
 */
export function feedOf_path(path: string): number | null {
  const held: RegExpMatchArray | null = path.match(/\/(?:feeds|jobs)\/feed_(\d+)(?:\/|$)/);
  return held === null ? null : Number(held[1]);
}

/**
 * Whether a path is a projection: the kernel renders it and nothing writes
 * it, so the verbs that would write have nothing to act on.
 *
 * @param path - The path a row or a field names.
 * @returns True for `/proc`, `/net`, `/etc` and `/usr/share`.
 */
export function path_isProjection(path: string): boolean {
  return /^\/(proc|net|etc|usr)(\/|$)/.test(path);
}

/**
 * Reads an access list out of a silent `getfacl`: the envelope's own model
 * carries the users, the groups and the public flag. A feed shared with
 * nobody says so.
 *
 * @param outcome - What the silent command returned.
 * @returns The readout for the row.
 */
export function shares_read(outcome: ExecuteOutcome): string {
  for (const envelope of outcome.envelopes) {
    const model: unknown = envelope.model;
    if (typeof model !== 'object' || model === null) continue;
    const data: unknown = (model as { kind?: unknown; data?: unknown }).data;
    if ((model as { kind?: unknown }).kind !== 'fs.acl' || !Array.isArray(data)) continue;
    const names: string[] = [];
    for (const held of data as Array<{ usernames?: unknown; groups?: unknown; public?: unknown }>) {
      if (Array.isArray(held.usernames)) names.push(...held.usernames.map(String));
      if (Array.isArray(held.groups)) names.push(...held.groups.map((group: unknown): string => `group ${String(group)}`));
      if (held.public === true) names.push('PUBLIC');
    }
    return names.length === 0 ? 'SHARED WITH NOBODY' : `SHARED WITH ${names.join(', ')}`;
  }
  return 'ACCESS UNREAD';
}

/** What the browser asks of the host. */
export interface BrowserHooks {
  /** The byte route for a path, from where this page was served. */
  vfsUrl_build: (path: string) => string;
  downloadUrl_build: (path: string) => string;
  image_open: (fromId: string, path: string) => Promise<string>;
  process_open: (fromId: string, binding: CatalogueBinding) => void;
  run_press: (paneId: string, executable: string, kind: 'plugin' | 'pipeline') => void;
  cohort_gather: (entries: ReadonlyArray<GatherSeries>) => void;
  verbLine_run: (paneId: string, line: string) => void;
  askOnPane_await: (paneId: string, request: PaneAskRequest) => Promise<string | null>;
  /** A /bin entry opened as its graph. */
  binEntry_show: (paneId: string, panel: FilesPanel, path: string, kind: 'plugin' | 'pipeline') => void;
  catalogue_find: (paneId: string) => CatalogueBinding | undefined;
  /** The session's user, as the prompt last named it; null before the first. */
  promptUser: () => string | null;
  template_stamp: (templateId: string) => HTMLElement;
  pane_find: (mount: HTMLElement, selector: string) => HTMLElement;
}

/** The browser verbs a wired host has. */
export interface Browser {
  /** What a files pane's PREVIEW projection fetches through. */
  previewProvider: PreviewProvider;
  /** Fetches a file's text through a silent, pane-local cat; a refusal is an answer. */
  fileText_fetch: (path: string) => Promise<FileText>;
  /** Brings one file down to the operator's disk and says how it went. */
  file_save: (path: string) => void;
  /** Downloads the row a browser indicates: a file saved, a folder archived by the kernel's `download`. */
  indicated_download: (id: string, path: string) => boolean;
  /** Shows a listing in a pane's browser, rooted (a silent `ls`). */
  rootedListing_show: (id: string, panel: FilesPanel, path: string) => void;
  /** Asks a browser for its place again, after something changed it. */
  listing_refresh: (id: string, place: string) => void;
  /** Asks a name and makes a directory in a place. */
  directory_make: (id: string, place: string) => void;
  /** Delivers files the operator picked into the folder on stage, over the /vfs route. */
  files_deliver: (id: string, place: string, chosen: File[]) => Promise<void>;
  /** Whether a browser follows the session cwd. */
  follows: (id: string) => boolean;
  /** Binds a browser to the cwd, or roots it. */
  follow_set: (id: string, on: boolean) => void;
  /** Registers the control that states a browser's binding, so a change anywhere is read back. */
  cwdBind_sync_register: (id: string, sync: () => void) => void;
  cwdBind_sync: (id: string) => void;
  /** A rooted browser walks to a place, remembering where it stood. */
  rooted_walk: (id: string, panel: FilesPanel, path: string) => void;
  /** A rooted browser's BACK: the previous listing, when there is one. */
  rooted_back: (id: string, panel: FilesPanel) => void;
  /** Stamps a files body (frame members + panel) from the files template. */
  filesBody_stamp: () => HTMLElement;
  /** The verbs a row is offered. */
  rowVerbs_build: (id: string, entry: FsListingEntry, path: string) => ReadonlyArray<ListingAction<FsListingEntry>>;
  /** Builds one files pane instance; a catalogue is the same pane wearing catalogue traits. */
  instance_build: (id: string, primary: boolean, catalogue?: boolean) => PaneInstance;
}

/**
 * Wires the browser to a host.
 *
 * @param context - The panels, the subjects, the console and the wire.
 * @param hooks - The host's routes, opens, asks, cohort and /bin view.
 * @returns The browser verbs.
 */
export function browser_wire(context: Pick<HostContext, 'panels' | 'subjects' | 'terminal' | 'client'>, hooks: BrowserHooks): Browser {
  const { panels, subjects } = context;
  /** A rooted browser's own navigation history, for its BACK verb. */
  const rootedHistory: Map<string, string[]> = new Map();
  /** Which browsers follow the session cwd. */
  const filesFollow: Map<string, boolean> = new Map();
  /** Each browser's binding pair, so a change made anywhere is read back by the control that states it. */
  const cwdBindSyncs: Map<string, () => void> = new Map();

  // A download stands a transfer row at once and keeps it current from the
  // daemon's own count (features/files/transfer.ts); the console notes its
  // start and how the hand-off went.
  const file_save = (path: string): void => {
    const url: string = hooks.downloadUrl_build(path);
    const id: string = downloadId_make();
    const name: string = path.split('/').filter((part: string): boolean => part.length > 0).pop() ?? path;
    const row: TransferRow = transfer_watch(name, url, id);
    context.terminal.line_note(`download: asking the session for ${name}`);
    void browserDownload_save(url, path, fetch, id).then((outcome: DownloadOutcome): void => {
      if (!outcome.ok) row.fail(outcome.reason);
      context.terminal.line_note(outcome.ok
        ? `download: ${outcome.name}${outcome.streamed ? ' — handed to the browser; its progress is on the transfer row' : ''}`
        : `download: ${path}: ${outcome.reason}`);
    });
  };

  /** Each browser's indicated row, and whether it is a folder: what `file download` acts on. */
  const indicated: Map<string, { path: string; directory: boolean }> = new Map();

  /**
   * Brings a row down to the operator's disk. A file is saved straight from
   * the session; a folder has no bytes of its own, so it is the kernel's
   * `download`, which archives the tree into one file and hands that over.
   * That run makes a feed and takes a while, so it goes through the console
   * as a line the operator can read and follow. The kernel's `download`
   * always takes a destination; a browser has no folder to name and ignores
   * it, so the line names the working directory, as a person would type it.
   */
  const download_press = (id: string, path: string, directory: boolean): void => {
    if (directory) hooks.verbLine_run(id, `download ${path_quote(path)} .`);
    else file_save(path);
  };

  /** Downloads a browser's indicated row, when it is the one the regard names. */
  const indicated_download = (id: string, path: string): boolean => {
    const row: { path: string; directory: boolean } | undefined = indicated.get(id);
    download_press(id, path, row !== undefined && row.path === path && row.directory);
    return true;
  };

  const fileText_fetch = (path: string): Promise<FileText> =>
    context.client
      .line_execute(`cat ${path_quote(path)}`, { silent: true, observe: false })
      .then((outcome: ExecuteOutcome): FileText => {
        // A refusal is an answer: CUBE lists files a shared feed's guest may
        // not read, and joining the rendered text alone turned a 403 into an
        // empty pane, which reads as an empty file.
        const refused: boolean = outcome.envelopes.some((envelope): boolean => envelope.status === 'error');
        if (!refused) {
          return { ok: true, text: ansi_strip(outcome.envelopes.map((envelope): string => envelope.rendered).join('\n')) };
        }
        const said: string = outcome.envelopes
          .flatMap((envelope): string[] => (envelope.errors ?? []).map((entry): string => entry.message))
          .concat(outcome.envelopes.map((envelope): string => envelope.renderedErr ?? ''))
          .map((line): string => ansi_strip(line).trim())
          .filter((line): boolean => line !== '')
          .join('\n');
        return { ok: false, text: said === '' ? 'the session refused this read and said nothing further' : said };
      });

  /**
   * Reads at most `maxBytes` of a file's head through the /vfs route,
   * cancelling the body as soon as enough has arrived. The route serves
   * what CUBE stores; a file a VFS provider makes is unknown to it, so a
   * miss asks the session, which can read anything it can list.
   */
  const fileHead_fetch = async (path: string, maxBytes: number): Promise<string> => {
    const response: Response = await fetch(hooks.vfsUrl_build(path));
    if (!response.ok || response.body === null) {
      const read: FileText = await fileText_fetch(path);
      return read.text.slice(0, maxBytes);
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder: TextDecoder = new TextDecoder();
    let text: string = '';
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    void reader.cancel().catch((): void => { /* the body is already released */ });
    return text.slice(0, maxBytes);
  };

  /** A pipeline's authored graph, for a card-sized glimpse; a plugin is one node whatever it declares. */
  const pipelineGlimpse_fetch = async (path: string): Promise<GlimpseNode[] | null> => {
    const specifier: string = /_id(\d+)$/.exec(path)?.[1] ?? path.replace(/^.*\//, '');
    const outcome: ExecuteOutcome = await context.client.line_execute(`pipeline diagram ${arg_quote(specifier)}`, { silent: true, observe: false });
    for (const envelope of outcome.envelopes) {
      if (envelope.model?.kind !== DAG_MODEL_KINDS.pipelineDiagram) continue;
      const parsed = pipelineDiagramModelSchema.safeParse(envelope.model.data);
      if (!parsed.success) continue;
      return parsed.data.nodes.map((node: PipelineDiagramNode): GlimpseNode => ({
        id: node.id,
        parentIds: [...node.parentIds, ...(node.joinParentIds ?? [])],
      }));
    }
    return null;
  };

  const previewProvider: PreviewProvider = {
    imageUrl: hooks.vfsUrl_build,
    download: file_save,
    textHead: fileHead_fetch,
    pipelineGlimpse: pipelineGlimpse_fetch,
  };

  const rootedListing_show = (id: string, panel: FilesPanel, path: string): void => {
    // A bare `~` must reach the shell unquoted or it would not expand.
    const line: string = path === '~' ? 'ls ~' : `ls ${path_quote(path)}`;
    void context.client
      .line_execute(line, { silent: true, observe: false })
      .then((outcome: ExecuteOutcome): void => {
        for (const envelope of outcome.envelopes) panel.envelope_observe(envelope);
        // The place did not come: the pane says so rather than standing blank.
        if (path !== '~' && panel.path_current() !== path.replace(/\/+$/, '')) {
          const refused = outcome.envelopes.find((envelope): boolean => envelope.status === 'error');
          const reason: string = refused !== undefined ? refusalWords_extract(refused) : 'the session answered no listing';
          panel.listing_fail(reason);
          context.terminal.line_note(`files: ${path}: ${reason}`);
        }
      }, (error: unknown): void => {
        const reason: string = error instanceof Error ? error.message : String(error);
        panel.listing_fail(reason);
        context.terminal.line_note(`files: ${path}: ${reason}`);
      });
  };

  const rooted_walk = (id: string, panel: FilesPanel, path: string): void => {
    const previous: string | null = panel.path_current();
    if (previous !== null) rootedHistory.get(id)?.push(previous);
    rootedListing_show(id, panel, path);
  };

  const rooted_back = (id: string, panel: FilesPanel): void => {
    const previous: string | undefined = rootedHistory.get(id)?.pop();
    if (previous !== undefined) rootedListing_show(id, panel, previous);
  };

  const cwdBind_sync = (id: string): void => { cwdBindSyncs.get(id)?.(); };

  const follow_set = (id: string, on: boolean): void => {
    filesFollow.set(id, on);
    cwdBind_sync(id);
    const panel: FilesPanel | undefined = panels.get('files', id);
    panel?.follow_set(on);
    if (on && panel !== undefined) {
      // A browser that starts following shows the cwd at once.
      void context.client
        .line_execute('ls', { silent: true, observe: false })
        .then((outcome: ExecuteOutcome): void => {
          for (const envelope of outcome.envelopes) panel.envelope_observe(envelope);
        });
    }
  };

  /**
   * A following browser re-lists through the session, so the transcript
   * shows the same `ls` an operator would have typed; a rooted one asks for
   * its own place silently, which is how it navigates already.
   */
  const listing_refresh = (id: string, place: string): void => {
    const panel: FilesPanel | undefined = panels.get('files', id);
    if (panel === undefined) return;
    if (filesFollow.get(id) === true) context.terminal.line_run('ls');
    else rootedListing_show(id, panel, place);
  };

  const directory_make = (id: string, place: string): void => {
    void hooks.askOnPane_await(id, { message: `New directory in ${place}: `, kind: 'text', commit: 'MAKE IT' })
      .then((name: string | null): void => {
        const wanted: string = (name ?? '').trim();
        // An abandoned question makes nothing, and says nothing.
        if (wanted === '') return;
        context.terminal.line_run(`mkdir ${path_quote(`${place}/${wanted}`)}`);
        // `mkdir` renders what it made; it does not re-list the folder.
        listing_refresh(id, place);
      });
  };

  /**
   * A browser cannot reach the machine the daemon runs on, so `upload` is
   * not a verb this surface can speak: the bytes go over the daemon's own
   * `/vfs` route, which writes them through the kernel. The console says
   * what is being put where, and what became of each file.
   */
  const files_deliver = async (id: string, place: string, chosen: File[]): Promise<void> => {
    for (const file of chosen) {
      const target: string = `${place}/${file.name}`;
      context.terminal.line_note(`putting ${file.name} in ${place}…`);
      try {
        const response: Response = await fetch(hooks.vfsUrl_build(target), { method: 'POST', body: file });
        if (!response.ok) {
          context.terminal.line_note(`upload: ${file.name}: ${(await response.text()).trim() || response.statusText}`);
          continue;
        }
        context.terminal.line_note(`✓ ${target}`);
      } catch (error: unknown) {
        context.terminal.line_note(`upload: ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The listing must show what landed in it.
    listing_refresh(id, place);
  };

  /** Lowers a file activation: a walk (by `cd` or rooted), a /bin entry, an image, or a file shown. */
  const action_take = (id: string, panel: FilesPanel, action: FileAction): void => {
    if (action.kind === 'dir') {
      if (filesFollow.get(id) === true) context.terminal.line_run(`cd ${path_quote(action.path)}`);
      else rooted_walk(id, panel, action.path);
      return;
    }
    if (action.kind === 'plugin' || action.kind === 'pipeline') {
      hooks.binEntry_show(id, panel, action.path, action.kind);
      return;
    }
    // A volume or a DICOM slice is an image: it opens beside the browser,
    // never as bytes in a text view.
    if (imagery_is(action.path)) {
      void hooks.image_open(id, action.path).then((line: string): void => context.terminal.line_note(line));
      return;
    }
    subjects.regard_write(id, { address: action.path, modelKind: 'fs.file' });
    if (subjects.groupHasViewer(id)) return;
    if (extension_isImage(action.path)) {
      // Images render natively from the daemon's token-gated /vfs route.
      panel.contentImage_show(action.path, hooks.vfsUrl_build(action.path));
      return;
    }
    // Text renders from a silent cat, so a large file does not flood the transcript.
    void fileText_fetch(action.path).then((read: FileText): void => {
      if (!read.ok) {
        panel.contentRefused_show(action.path, read.text);
        return;
      }
      if (TABLE_FILE_PATTERN.test(action.path)) panel.contentTable_show(action.path, read.text);
      else panel.content_show(action.path, read.text);
    });
  };

  const filesBody_stamp = (): HTMLElement => {
    const body: HTMLElement | null = hooks.template_stamp('tpl-pane-files').querySelector<HTMLElement>('.files-body');
    if (body === null) throw new Error('tpl-pane-files has no files-body');
    return body;
  };

  /**
   * What a row may be told to do. Every verb lowers to a session command
   * the operator can read in the transcript — never a silent mutation
   * behind a capsule. DELETE lowers to `rm -i`, so the KERNEL raises the
   * confirmation; MOVE and COPY lower to a one-operand `mv` and `cp`, whose
   * missing destination is the ask that opens the errand.
   */
  const rowVerbs_build = (id: string, entry: FsListingEntry, path: string): ReadonlyArray<ListingAction<FsListingEntry>> => {
    const quoted: string = path_quote(path);
    const directory: boolean = entry.type === 'dir' || entry.type === 'vfs' || entry.type === 'job';
    // Which verbs a row is offered is the roster's to say (features/roster/verbs.ts); what each one does is this pane's.
    const feed: number | null = feedOf_path(path);
    const facts: FileRowFacts = {
      kind: entry.type === 'plugin' || entry.type === 'pipeline'
        ? 'catalogue'
        : directory && seriesFolder_is(path, entry.name)
          ? 'seriesFolder'
          : entry.type === 'file' ? 'file' : 'directory',
      feed,
      node: feed === null ? null : nodeOf_path(path),
      bound: hooks.catalogue_find(id) !== undefined,
      projection: path_isProjection(path),
      editable: entry.type === 'file' && path_isEditable(path),
    };
    const runs: Record<string, () => void> = {
      image: (): void => { void hooks.image_open(id, path).then((line: string): void => context.terminal.line_note(line)); },
      // A file is the browser's own save; a folder is the kernel's `download`, run where the operator can read it.
      download: (): void => download_press(id, path, directory),
      // LINK copies a web address that opens ARGUS at this path (`url` in chell).
      // The line under the trail shows what was copied, and the console notes it.
      link: (): void => {
        const link: string = link_compose(window.location.origin, path);
        const copied: Promise<boolean> = panels.get('files', id)?.link_copy(path)
          ?? navigator.clipboard.writeText(link).then((): boolean => true, (): boolean => false);
        void copied.then((took: boolean): void => context.terminal.line_note(took ? `link copied: ${link}` : `link (copy it): ${link}`));
      },
      // PROCESS acts on the place: a bound catalogue opens beside this pane.
      process: (): void => hooks.process_open(id, { input: path, feed, node: feed === null ? null : nodeOf_path(path) }),
      // GATHER takes the row into the session's cohort, keyed by its path,
      // since a directory or a file has no series UID and the path is what
      // a run would be given.
      gather: (): void => hooks.cohort_gather([{
        kind: directory ? 'dir' : 'file',
        seriesUID: path,
        description: entry.name,
        imagery: seriesFolder_is(path, entry.name),
        modality: seriesFolder_is(path, entry.name) ? 'MR' : '—',
        patient: hooks.promptUser() ?? '',
        vfsPath: path,
        folderPath: path,
      }]),
      // RUN runs the line on the catalogue's input, as the console would.
      run: (): void => hooks.run_press(id, entry.name, entry.type === 'pipeline' ? 'pipeline' : 'plugin'),
      // EDIT is the kernel's `edit`, which opens the editor pane; a file of a
      // megabyte or more is asked about first, since the field holds it whole.
      edit: (): void => {
        const line: string = editLine_compose(path);
        const question: string | null = editAsk_render(entry.name, entry.size, EDIT_CONFIRM_BYTES);
        if (question === null) { hooks.verbLine_run(id, line); return; }
        void hooks.askOnPane_await(id, { kind: 'confirm', message: question })
          .then((answer: string | null): void => { if (answer === 'y') hooks.verbLine_run(id, line); });
      },
      move: (): void => hooks.verbLine_run(id, `mv ${quoted}`),
      copy: (): void => hooks.verbLine_run(id, `cp ${quoted}`),
      delete: (): void => hooks.verbLine_run(id, `rm ${directory ? '-ri' : '-i'} ${quoted}`),
      share: (): void => hooks.verbLine_run(id, `setfacl ${quoted}`),
    };
    return FILE_ROW_ROSTER.rules
      .filter((rule): boolean => rule.offered(facts))
      .map((rule): ListingAction<FsListingEntry> => ({ label: rule.label(facts), run: (): void => runs[rule.name]?.() }));
  };

  /**
   * A selection's verbs are the row's verbs over many rows, and the kernel
   * already takes many operands — so each is ONE line the operator could
   * have typed, not twenty lines they must audit.
   */
  const selectionVerbs_build = (id: string, rows: ReadonlyArray<[string, FsListingEntry]>): ReadonlyArray<ListingAction<void>> => {
    const paths: string[] = rows.map(([path]): string => path);
    const quoted: string = paths.map((path: string): string => path_quote(path)).join(' ');
    const feeds: number[] = [];
    for (const path of paths) {
      const feed: number | null = feedOf_path(path);
      if (feed !== null && !feeds.includes(feed)) feeds.push(feed);
    }
    const facts: FilesSelectionFacts = { count: paths.length, feeds };
    const runs: Record<string, () => void> = {
      // -I asks ONCE for the whole list: twenty questions to remove twenty files is a confirmation an operator learns to dismiss.
      delete: (): void => hooks.verbLine_run(id, `rm -rI ${quoted}`),
      // `-t` with no value: every operand is a SOURCE and the target is asked for.
      move: (): void => context.terminal.line_run(`mv -t ${quoted}`),
      copy: (): void => context.terminal.line_run(`cp -t ${quoted}`),
      // A grant is per feed, so a selection of twenty files in one feed is ONE grant.
      share: (): void => context.terminal.line_run(`setfacl ${feeds.map((feed: number): string => `feed_${feed}`).join(' ')}`),
    };
    return FILES_SELECTION_ROSTER.rules
      .filter((rule): boolean => rule.offered(facts))
      .map((rule): ListingAction<void> => ({ label: rule.label(facts), run: (): void => runs[rule.name]?.() }));
  };

  const instance_build = (id: string, primary: boolean, catalogue: boolean = false): PaneInstance => {
    const mount: HTMLElement = hooks.template_stamp('tpl-pane-files');
    const panel: FilesPanel = new FilesPanel(
      hooks.pane_find(mount, '.files-panel'),
      (action: FileAction): void => action_take(id, panel, action),
      previewProvider,
      { catalogue },
    );
    panel.selectionVerbs_declare((rows) => selectionVerbs_build(id, rows));
    panel.rowVerbs_declare(
      (entry, path: string) => rowVerbs_build(id, entry, path),
      (entry, path: string): void => {
        indicated.set(id, { path, directory: entry.type === 'dir' || entry.type === 'vfs' || entry.type === 'job' });
        // Indicating IS the regard: a viewer in the group renders what the
        // operator pointed at, without their having to open it first.
        subjects.regard_write(id, { address: path, modelKind: 'fs.file' });
        // A verb that grants access says what is already granted. The read
        // is silent and lands beside the verbs when it arrives.
        if (feedOf_path(path) === null) return;
        void context.client
          .line_execute(`getfacl ${path_quote(path)}`, { silent: true, observe: false })
          .then((outcome: ExecuteOutcome): void => { panel.rowReadout_show(path, shares_read(outcome)); })
          .catch((): void => { panel.rowReadout_show(path, 'ACCESS UNREAD'); });
      },
    );
    panels.set('files', id, panel);
    // Home is the session's: the trail starts at `~` under it and the `~`
    // row goes there. A pane opened after the prompt arrived learns it here.
    const user: string | null = hooks.promptUser();
    if (user !== null && user !== '') panel.home_set(`/home/${user}`);
    rootedHistory.set(id, []);
    filesFollow.set(id, primary);
    cwdBind_sync(id);
    panel.follow_set(primary);
    return {
      id,
      kind: 'files',
      mount,
      dispose: (): void => {
        panels.delete(id);
        rootedHistory.delete(id);
        indicated.delete(id);
        subjects.pane_leave(id);
      },
    };
  };

  return {
    previewProvider,
    fileText_fetch,
    indicated_download,
    file_save,
    rootedListing_show,
    listing_refresh,
    directory_make,
    files_deliver,
    follows: (id: string): boolean => filesFollow.get(id) === true,
    follow_set,
    cwdBind_sync_register: (id: string, sync: () => void): void => { cwdBindSyncs.set(id, sync); },
    cwdBind_sync,
    rooted_walk,
    rooted_back,
    filesBody_stamp,
    rowVerbs_build,
    instance_build,
  };
}
