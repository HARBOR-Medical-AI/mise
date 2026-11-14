/**
 * @file The ChRIS composition's words in the ARGUS language: RUNS (`runs`,
 * `dag`, `node`), the UNIVERSE, PACS's listing, and the DICOM panes' verbs
 * (`image`, `tags`); the views and claims it adds; chords 2 and 3.
 *
 * @module
 */
import {
  control_click,
  drawerChild_click,
  modePill_setTo,
  type ArgusHost,
  type LanguageExtension,
} from '../../console/argusLang.js';

/** The ChRIS verbs the surface's host answers, beside the frame's. */
export interface ChrisHostVerbs {
  /** Enters a feed on the primary DAG pane (pin + fetch). */
  feed_enter(id: number): void;
  /** Dives into the node the pane currently regards; false when none. */
  node_immerse(paneId: string): boolean;
  /** Lands the RUNS pane on a feed or a job, as JUMP TO does; false without a RUNS pane. */
  dag_jump(paneId: string, target: string, enter?: boolean): boolean;
  /** Drives an image pane's verbs (layout, slice, series, wl, colormap, save, tags, ghost); returns the console line. */
  image_control(paneId: string, verb: string, args: string[]): Promise<string>;
  /** Drives a tags pane's verbs (redact, filter); returns the console line. */
  tags_control(paneId: string, verb: string, args: string[]): string;
  /** The descent by word: enter a feed, climb back, open the feed in RUNS. */
  universe_control(paneId: string | null, verb: string, args: string[]): string;
}

/** The host the ChRIS words reach. */
export type ChrisLangHost = ArgusHost & ChrisHostVerbs;

/**
 * The image subverbs the surface owns: they drive a pane already on the
 * field. Opening an image (`image <path>`, `image --help`, `image` alone) is
 * the kernel's `image` command, so those lines fall through to the session.
 */
const IMAGE_SURFACE_VERBS: ReadonlySet<string> = new Set(['layout', 'slice', 'series', 'wl', 'colormap', 'save', 'tags', 'load', 'stop', 'guard', 'ghost', 'state']);

/**
 * The `dag` verbs: the RUNS pane's mode frame and physics.
 *
 * @param host - The surface.
 * @param paneId - The pane.
 * @param verb - The verb.
 * @param arg - Its first word.
 * @param words - Every word after the subject.
 * @returns What happened.
 */
function dag_run(host: ChrisLangHost, paneId: string, verb: string, arg: string, words: string[]): string {
  if (verb === 'layout') return modePill_setTo(host, paneId, '.dag-strategy', arg.toUpperCase()) ? `layout ${arg}` : 'dag layout ranked|molecule';
  if (verb === 'projection') return modePill_setTo(host, paneId, '.dag-projection', arg.toUpperCase()) ? `projection ${arg}` : 'dag projection 2d|3d';
  if (verb === 'scale') return modePill_setTo(host, paneId, '.dag-scale', arg.toUpperCase()) ? `scale ${arg}` : 'dag scale time|size';
  if (verb === 'hue') return modePill_setTo(host, paneId, '.dag-hue', arg.toUpperCase()) ? `hue ${arg}` : 'dag hue status|compute';
  // A mode named both ways sets it (a script says what it wants); bare, it
  // toggles, as the pill does.
  const toggle = (selector: string, name: string, on: string, off: string): string => {
    const asked: string = arg.toLowerCase();
    if (asked === 'on' || asked === 'off') {
      return modePill_setTo(host, paneId, selector, asked === 'on' ? on : off) ? `${name} ${asked}` : `dag ${name}: no mode frame`;
    }
    if (asked !== '') return `dag ${name} on|off`;
    return control_click(host, paneId, selector) ? `${name} toggled` : `dag ${name}: no mode frame`;
  };
  if (verb === 'pulse') return toggle('.dag-pulse', 'pulse', 'PULSE ON', 'PULSE OFF');
  if (verb === 'census') return toggle('.dag-census', 'census', 'CENSUS', 'SHAPE');
  if (verb === 'gravity') return toggle('.dag-gravity', 'gravity', 'GRAVITY ON', 'GRAVITY OFF');
  if (verb === 'draw') return modePill_setTo(host, paneId, '.dag-draw', arg.toUpperCase()) ? `draw ${arg}` : 'dag draw spheres|stars';
  // The JUMP TO fly-to by name: a feed or a job, by number or `/proc` name.
  if (verb === 'select') {
    if (arg === '') return 'dag select <feed or job>';
    return host.dag_jump(paneId, arg) ? `selecting ${arg}` : 'dag select: no RUNS pane (view runs)';
  }
  // The same, then ENTER NODE on it.
  if (verb === 'enter') {
    if (arg === '') return 'dag enter <job>';
    return host.dag_jump(paneId, arg, true) ? `entering ${arg}` : 'dag enter: no RUNS pane (view runs)';
  }
  if (verb === 'refresh') return drawerChild_click(host, paneId, 'REFRESH') ? 'refreshing' : 'dag refresh: no DAG pane';
  if (verb === 'physics') {
    const term: string = arg;
    const mount: HTMLElement | null = host.paneMount_get(paneId);
    const pane: HTMLElement | null = mount?.querySelector<HTMLElement>('.pane-dag') ?? mount;
    if (pane === null) return 'dag physics: no DAG pane';
    if (term === 'reset') {
      pane.dispatchEvent(new CustomEvent('argus:dag-physics', { detail: 'reset' }));
      return 'physics reset';
    }
    const on: boolean = (words[2] ?? 'on').toLowerCase() !== 'off';
    if (!['charge', 'link', 'collide', 'gravity'].includes(term)) return `dag physics: unknown term '${term}' (charge|link|collide|gravity|reset)`;
    pane.dispatchEvent(new CustomEvent('argus:dag-physics', { detail: { term, on } }));
    return `physics ${term} ${on ? 'on' : 'off'}`;
  }
  return `dag: unknown verb '${verb}' (layout|projection|scale|hue|draw|pulse|census|gravity|select|enter|physics|refresh)`;
}

/**
 * The `node` verbs: the indicated node of a RUNS pane.
 *
 * @param host - The surface.
 * @param paneId - The pane.
 * @param verb - The verb.
 * @returns What happened.
 */
function node_run(host: ChrisLangHost, paneId: string, verb: string): string {
  if (verb === 'enter') return drawerChild_click(host, paneId, 'ENTER NODE') ? 'entering node' : 'node enter: no DAG drawer';
  if (verb === 'back') return drawerChild_click(host, paneId, 'BACK') ? 'node back' : 'node back: no DAG drawer';
  if (verb === 'immerse') return host.node_immerse(paneId) ? 'immersing' : 'node immerse: nothing indicated';
  if (verb === 'clear') return drawerChild_click(host, paneId, 'CLEAR DETAIL') ? 'detail cleared' : 'node clear: no DAG drawer';
  return `node: unknown verb '${verb}' (enter|immerse|back|clear)`;
}

/**
 * The ChRIS composition's language extension.
 *
 * @param host - The surface's host, with the ChRIS verbs.
 * @returns The extension.
 */
export function chrisLanguage(host: () => ChrisLangHost): LanguageExtension {
  return {
    subjects: {
      runs: null, node: null, dag: null, universe: null,
      pacs: new Set(['sort', 'filter']),
      // `tags` is the kernel's tag resource; the surface claims only the two
      // verbs its tags pane has and the session lacks.
      tags: new Set(['redact', 'filter']),
      // `image` is a kernel command; the surface claims only the subverbs that
      // drive a pane on the field, and lets `image <path>` reach the wire.
      image: IMAGE_SURFACE_VERBS,
    },
    views: { runs: { button: 'gutter-runs', primary: 'dag' }, pacs: { button: 'gutter-tools', primary: 'pacs' } },
    claims: { runs: '.empty-go-dag', pacs: '.empty-go-pacs' },
    listings: { runs: { selector: '.pane-dag', named: 'DAG' }, pacs: { selector: '#pacs-workspace', named: 'PACS' } },
    chords: [
      { after: '1', key: '2', topic: 'claim', selector: '.empty-go-dag', does: 'claim an empty pane as RUNS' },
      { after: '1', key: '3', topic: 'claim', selector: '.empty-go-pacs', does: 'claim an empty pane as PACS' },
    ],
    lines: [
      { after: 'view', line: 'runs enter <feedId> · sort <col> [asc|desc] · filter <text>|off' },
      { after: 'view', line: 'node enter · immerse · back · clear (the indicated node)' },
      { after: 'view', line: 'dag [@id] layout ranked|molecule · projection 2d|3d · scale time|size · hue status|compute · draw spheres|stars · pulse [on|off] · census [on|off] · gravity [on|off] · select <feed or job> · enter <job> · physics charge|link|collide|gravity on|off · physics reset · refresh' },
      { after: 'file', line: 'pacs sort <col> [asc|desc] · filter <text>|off   (the results listing; every other pacs verb is the session\'s)' },
      { after: 'file', line: 'image [@id] [--force] <path> · layout single|mpr|3d|slab · slice <n> · series <n> · wl <lo> <hi> · wl preset <name> · colormap gray|hot|jet|cool · save · tags · load · stop · guard <bytes>|off · ghost <0..1>|off · state' },
      { after: 'file', line: 'tags [@id] redact on|off · filter <text>|off   (the pane that follows an image pane\'s slice)' },
    ],
    run: (_frame: ArgusHost, sentence: { subject: string; target: string | null; words: string[] }, pane: () => string | null): Promise<string | null> | string | null | undefined => {
      const surface: ChrisLangHost = host();
      const { subject, words } = sentence;
      const verb: string = (words[0] ?? '').toLowerCase();
      const arg: string = (words[1] ?? '').toLowerCase();
      if (subject === 'runs') {
        if (verb === 'enter') {
          const feedId: number = parseInt(arg.replace(/^feed_/, ''), 10);
          if (Number.isNaN(feedId)) return 'runs enter <feedId>';
          surface.feed_enter(feedId);
          return `entering feed_${feedId}`;
        }
        return `runs: unknown verb '${verb}' (enter)`;
      }
      if (!['dag', 'image', 'tags', 'universe', 'node'].includes(subject)) return undefined;
      // Everything below acts on a pane.
      const paneId: string | null = pane();
      if (paneId === null) return `${subject}: no target pane (nothing focused?)`;
      if (subject === 'dag') return dag_run(surface, paneId, verb, arg, words);
      if (subject === 'image') {
        // The pane's live controls are the surface's; opening an image is the
        // kernel's (`image <path>` emits an `image.view` intent this surface
        // renders). Only the subverbs that drive a pane on the field are here.
        const plain: string[] = words.filter((word: string): boolean => word !== '--force');
        if (!IMAGE_SURFACE_VERBS.has((plain[0] ?? '').toLowerCase())) return null;
        return surface.image_control(paneId, verb, words.slice(1));
      }
      if (subject === 'tags') return surface.tags_control(paneId, verb, words.slice(1));
      if (subject === 'universe') return surface.universe_control(paneId, verb, words.slice(1));
      return node_run(surface, paneId, verb);
    },
  };
}
