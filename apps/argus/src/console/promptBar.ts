/**
 * @file The console's prompt bar: the Powerlevel10k segment bar as HTML.
 *
 * Pure: the terminal hands it the daemon's prompt context and its own glyphs
 * and palette (kept in `terminal.ts`, where `lint:prompt` compares them by
 * value against chell's), and it returns the bar's inner HTML. A backend that
 * sends segments (stratus) is drawn from them, in its order; a daemon that
 * sends none (ChRIS) is drawn from the named fields, as it always was.
 *
 * @module
 */
import { procPromptState_get, type ProcPromptState, type PromptContext, type PromptSegment, type PromptSegmentTone } from '@fnndsc/menu';
import { html_escape } from './ansi.js';

/** Foreground/background hex pair for one powerline segment. */
export interface SegmentColor {
  bg: string;
  fg: string;
}

/** What the bar draws with: the terminal's glyphs and palette, by name. */
export interface PromptBarParts {
  readonly glyphs: Readonly<Record<'powerline' | 'cube' | 'database' | 'user' | 'folder' | 'microscope' | 'bolt' | 'error' | 'cloud' | 'globe' | 'sitemap', string>>;
  readonly palette: Readonly<Record<'pacs' | 'host' | 'user' | 'dir' | 'physical' | 'duration' | 'status' | 'time', SegmentColor>>;
  readonly procStates: Readonly<Record<ProcPromptState, { icon: string; label: string; color: SegmentColor }>>;
}

/** One segment as the bar draws it. */
interface BarSegment {
  text: string;
  color: SegmentColor;
  /** The whole value, when the text shows less of it. */
  title?: string;
}

/** Minimum command duration (ms) before the duration segment appears. */
const DURATION_THRESHOLD_MS: number = 3_000;

/**
 * Longest an identity segment is drawn whole. The bar has no column budget
 * (it wraps), so a long identity, an e-mail address at a tenancy, is cut
 * from the left at a fixed width and carries its whole value as a title.
 */
const IDENTITY_MAX: number = 28;

/**
 * Renders the bar's inner HTML from the stored context.
 *
 * @param context - The daemon's prompt context, or null before the first push.
 * @param parts - The terminal's glyphs, palette and proc-state presentations.
 * @returns The prompt bar's inner HTML.
 */
export function promptBar_render(context: PromptContext | null, parts: PromptBarParts): string {
  if (context === null) {
    return '<span class="dim">argus</span>';
  }
  const wire: ReadonlyArray<PromptSegment> = context.segments ?? [];
  const segments: BarSegment[] = wire.length > 0 ? wireSegments_build(wire, parts) : chrisSegments_build(context, parts);
  segments.push(...trailing_build(context, parts));
  return bar_assemble(segments, parts);
}

/**
 * The segments a backend sent, in its order: a glyph by key when the bar
 * knows the key, a colour by tone, the identity cut from the left when long.
 */
function wireSegments_build(wire: ReadonlyArray<PromptSegment>, parts: PromptBarParts): BarSegment[] {
  const icons: Readonly<Record<string, string>> = {
    cloud: parts.glyphs.cloud,
    tenancy: parts.glyphs.cube,
    region: parts.glyphs.globe,
    user: parts.glyphs.user,
    cluster: parts.glyphs.sitemap,
    cwd: parts.glyphs.folder,
  };
  const tones: Readonly<Record<PromptSegmentTone, SegmentColor>> = {
    leader: parts.palette.host,
    place: parts.palette.pacs,
    identity: parts.palette.user,
    path: parts.palette.dir,
    work: parts.palette.duration,
    note: parts.palette.time,
    alert: parts.palette.status,
  };
  return wire.map((segment: PromptSegment): BarSegment => {
    const icon: string | undefined = icons[segment.key];
    const shown: string = segment.tone === 'identity' ? identity_shorten(segment.value) : segment.value;
    return {
      text: icon !== undefined ? `${icon} ${shown}` : shown,
      color: tones[segment.tone],
      ...(shown !== segment.value ? { title: segment.value } : {}),
    };
  });
}

/**
 * Cuts an identity from the left, keeping its ending.
 *
 * @param value - The identity as the cloud writes it.
 * @returns The value, or its tail behind `…` when longer than the bar allows.
 */
export function identity_shorten(value: string): string {
  return value.length <= IDENTITY_MAX ? value : `…${value.slice(-(IDENTITY_MAX - 1))}`;
}

/** The ChRIS-shaped bar: [pacs] host user dir [proc], as it always was. */
function chrisSegments_build(context: PromptContext, parts: PromptBarParts): BarSegment[] {
  const host: string = context.uri.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '');
  const homePrefix: string = `/home/${context.user}`;
  const displayPath: string = context.cwd.startsWith(homePrefix)
    ? `~${context.cwd.slice(homePrefix.length)}`
    : context.cwd;
  const segments: BarSegment[] = [];
  if (context.pacsserver !== null && context.pacsserver.length > 0) {
    segments.push({ text: `${parts.glyphs.database} ${context.pacsserver}`, color: parts.palette.pacs });
  }
  segments.push(
    { text: `${parts.glyphs.cube} ${host}`, color: parts.palette.host },
    { text: `${parts.glyphs.user} ${context.user}`, color: parts.palette.user },
    { text: `${parts.glyphs.folder} ${displayPath}`, color: parts.palette.dir },
  );
  if (context.procWarmup !== undefined) {
    const state: ProcPromptState = procPromptState_get(context.procWarmup);
    const presentation = parts.procStates[state];
    segments.push({
      text: `${presentation.icon} ${presentation.label}: ${procProgress_format(context.procWarmup.loaded, context.procWarmup.total ?? 0)}`,
      color: presentation.color,
    });
  }
  return segments;
}

/** The surface's own telemetry, after any backend's segments. */
function trailing_build(context: PromptContext, parts: PromptBarParts): BarSegment[] {
  const segments: BarSegment[] = [];
  if (context.physicalMode) {
    segments.push({ text: `${parts.glyphs.microscope} PHYSICAL`, color: parts.palette.physical });
  }
  if (context.lastCommandDurationMs >= DURATION_THRESHOLD_MS) {
    const seconds: number = Math.floor(context.lastCommandDurationMs / 1000);
    segments.push({ text: `${parts.glyphs.bolt} ${seconds}s`, color: parts.palette.duration });
  }
  if (context.lastExitCode !== 0) {
    segments.push({ text: `${parts.glyphs.error} ${context.lastExitCode}`, color: parts.palette.status });
  }
  return segments;
}

/** Joins the segments with powerline separators, the last fading out. */
function bar_assemble(segments: ReadonlyArray<BarSegment>, parts: PromptBarParts): string {
  let bar: string = '';
  for (let index: number = 0; index < segments.length; index++) {
    const segment: BarSegment | undefined = segments[index];
    if (segment === undefined) continue;
    const title: string = segment.title !== undefined ? ` title="${html_escape(segment.title)}"` : '';
    bar += `<span style="color:${segment.color.fg};background-color:${segment.color.bg}"${title}> ${html_escape(segment.text)} </span>`;
    const next: BarSegment | undefined = segments[index + 1];
    bar += next !== undefined
      ? `<span style="color:${segment.color.bg};background-color:${next.color.bg}">${parts.glyphs.powerline}</span>`
      : `<span style="color:${segment.color.bg}">${parts.glyphs.powerline}</span>`;
  }
  return bar;
}

/**
 * Formats warm-up progress for the proc segment, mirroring chell's prompt
 * utils (duplicated by value: argus may not import the execution stack).
 *
 * @param loaded - Plugin instances currently indexed.
 * @param total - Authoritative total, or 0 when CUBE has not reported one.
 * @returns `loaded/total percent%`, or `loaded/?` without a total.
 */
export function procProgress_format(loaded: number, total: number): string {
  if (total <= 0) return `${loaded}/?`;
  const percent: number = Math.min(99, Math.floor((loaded / total) * 100));
  return `${loaded}/${total} ${percent}%`;
}
