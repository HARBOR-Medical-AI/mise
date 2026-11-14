/**
 * @file Powerlevel10k-inspired prompt theme.
 *
 * Two-line prompt:
 *   Line 1 — coloured segment bar with background fills and powerline separators
 *             [ pacs ❯]  host ❯  user ❯  path ❯ [proc ❯] [ HH:MM ❯] [ Xs ❯] [ N ❯]
 *   Line 2 — input line: ❯
 *
 * Font Awesome icons and the powerline separator require a Nerd Font.
 * readline uses only the last line's visible width for cursor and
 * tab-completion alignment, so line 1 never interferes with line editing.
 *
 * @module
 */

import chalk from 'chalk';
import { procPromptState_get, type ProcPromptState, type PromptSegment, type PromptSegmentTone } from '@fnndsc/menu';
import type { PromptContext, PromptTheme } from './index.js';
import {
  PROMPT_PALETTE,
  statusColor_get,
  type HexColor,
  type PromptColorPair,
} from './palette.js';
import {
  ansi_visibleLength,
  homePath_abbreviate,
  path_truncate,
  text_truncateLeft,
  procProgress_format,
  feedArrivals_format,
} from './utils.js';

/** Powerline right-arrow separator (Nerd Font U+E0B0). */
const POWERLINE: string = '';

/** Font Awesome cube icon (U+F1B2). */
const ICON_CUBE: string = '\uf1b2';

/** Font Awesome database icon (U+F1C0). */
const ICON_DATABASE: string = '\uf1c0';

/** Font Awesome microscope icon (U+F610). */
const ICON_MICROSCOPE: string = '\uf610';

/** Font Awesome user icon (U+F007). */
const ICON_USER: string = '\uf007';

/** Font Awesome open-folder icon (U+F07C). */
const ICON_FOLDER: string = '\uf07c';

/** Font Awesome clock icon (U+F017). */
const ICON_CLOCK: string = '\uf017';

/** Font Awesome bolt icon (U+F0E7). */
const ICON_BOLT: string = '\uf0e7';

/** Font Awesome circled-x icon (U+F057). */
const ICON_ERROR: string = '\uf057';

/** Font Awesome snowflake icon (U+F2DC). */
const ICON_SNOWFLAKE: string = '\uf2dc';

/** Font Awesome refresh icon (U+F021). */
const ICON_REFRESH: string = '\uf021';

/** Font Awesome warning icon (U+F071). */
const ICON_WARNING: string = '\uf071';

/** Font Awesome cloud icon (U+F0C2): a stratus prompt's leader. */
const ICON_CLOUD: string = '\uf0c2';

/** Font Awesome globe icon (U+F0AC): a region. */
const ICON_GLOBE: string = '\uf0ac';

/** Font Awesome sitemap icon (U+F0E8): a domain. */
const ICON_SITEMAP: string = '\uf0e8';

/**
 * The glyph a wire segment wears, by the key a backend gave it; a key the
 * theme does not know draws its value alone.
 */
const SEGMENT_ICONS: Readonly<Record<string, string>> = {
  cloud: ICON_CLOUD,
  tenancy: ICON_CUBE,
  region: ICON_GLOBE,
  user: ICON_USER,
  domain: ICON_SITEMAP,
  cwd: ICON_FOLDER,
};

/** The palette pair a wire segment's tone maps to. */
const TONE_COLORS: Readonly<Record<PromptSegmentTone, PromptColorPair>> = {
  leader: PROMPT_PALETTE.HOST,
  place: PROMPT_PALETTE.PACS,
  identity: PROMPT_PALETTE.USER,
  path: PROMPT_PALETTE.DIR,
  work: PROMPT_PALETTE.DURATION,
  note: PROMPT_PALETTE.TIME,
  alert: PROMPT_PALETTE.STATUS,
};

/** The fewest columns a path keeps before an identity yields columns to it. */
const PATH_FLOOR: number = 12;

/** The fewest columns an identity keeps, however tight the line. */
const IDENTITY_FLOOR: number = 16;

/** Theme-specific presentation for each process-index state. */
const PROC_STATE_SEGMENTS: Record<ProcPromptState, { icon: string; label: string; color: PromptColorPair }> = {
  cold: { icon: ICON_SNOWFLAKE, label: 'proc cold', color: PROMPT_PALETTE.DURATION },
  cached: { icon: ICON_REFRESH, label: 'proc cached, refreshing', color: PROMPT_PALETTE.TIME },
  failed: { icon: ICON_WARNING, label: 'proc failed', color: PROMPT_PALETTE.STATUS },
};

/** Fraction of terminal width the segment bar should not exceed. */
const FILL_RATIO: number = 0.95;

/** Minimum command duration (ms) before the duration segment appears. */
const DURATION_THRESHOLD_MS: number = 3_000;

/** Visible content and colour pair for one rendered prompt segment. */
interface SegmentSpec {
  text: string;
  color: PromptColorPair;
}

/**
 * Renders one segment: padded text on its background colour.
 *
 * @param text - Visible text content (may include a Font Awesome glyph).
 * @param c - Background/foreground hex pair.
 * @returns ANSI-coded segment string.
 */
function segment_render(text: string, c: PromptColorPair): string {
  return chalk.hex(c.fg).bgHex(c.bg)(` ${text} `);
}

/**
 * Renders the powerline separator transitioning from one segment bg to the next.
 *
 * @param from - Colour pair of the departing segment.
 * @param to - Colour pair of the arriving segment.
 * @returns ANSI-coded separator character.
 */
function separator_render(from: PromptColorPair, to: PromptColorPair): string {
  return chalk.hex(from.bg).bgHex(to.bg)(POWERLINE);
}

/**
 * Renders the final powerline separator: segment bg fading to terminal default.
 *
 * @param from - Colour pair of the last segment.
 * @returns ANSI-coded trailing separator character.
 */
function separator_final(from: PromptColorPair): string {
  return chalk.hex(from.bg)(POWERLINE);
}

/**
 * Strips the scheme and trailing `/api/v1/` from a CUBE URL, leaving
 * just `host:port`.
 *
 * @param uri - Full CUBE API URL string.
 * @returns Abbreviated host[:port] string.
 */
function uri_abbreviate(uri: string): string {
  return uri
    .replace(/^https?:\/\//, '')
    .replace(/\/api\/v1\/?$/, '');
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 * Examples: "2s", "1m 5s"
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted duration string.
 */
function duration_format(ms: number): string {
  const totalSeconds: number = Math.floor(ms / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${totalSeconds}s`;
}

/**
 * Returns the current time as HH:MM (24-hour).
 *
 * @returns Time string in HH:MM format.
 */
function time_now(): string {
  const now: Date = new Date();
  const hh: string = String(now.getHours()).padStart(2, '0');
  const mm: string = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Powerlevel10k-inspired two-line prompt theme with background-coloured segments.
 * Segment order: [pacs] host user dir [proc] [physical] [time] [duration] [status]
 */
export class ThemeP10k implements PromptTheme {
  render(ctx: PromptContext): string {
    const wire: ReadonlyArray<PromptSegment> = ctx.segments ?? [];
    if (wire.length > 0) return this.segments_render(ctx, wire);
    const host: string = uri_abbreviate(ctx.uri);

    // Core segments: [pacs] → host → user → dir → [proc]
    const fixed: SegmentSpec[] = [];

    if (ctx.pacsserver && ctx.p10kSegments.pacs) {
      fixed.push({ text: `${ICON_DATABASE} ${ctx.pacsserver}`, color: PROMPT_PALETTE.PACS });
    }

    fixed.push({ text: `${ICON_CUBE} ${host}`, color: PROMPT_PALETTE.HOST });

    fixed.push({ text: `${ICON_USER} ${ctx.user}`, color: PROMPT_PALETTE.USER });

    // Optional auxiliary state and command telemetry follow the core sequence.
    const trailing: SegmentSpec[] = [];

    if (ctx.physicalMode) {
      trailing.push({ text: `${ICON_MICROSCOPE} PHYSICAL`, color: PROMPT_PALETTE.PHYSICAL });
    }

    if (ctx.hostControl !== undefined && ctx.hostControl.length > 0) {
      // Every `!` line says where it lands: on the daemon host.
      trailing.push({ text: `⚠ HOST ${ctx.hostControl.join(',')}`, color: PROMPT_PALETTE.HOSTCTL });
    }

    if (ctx.questions !== undefined && ctx.questions > 0) {
      // A question open somewhere in the session; `who` says who asked what.
      trailing.push({ text: `? ${ctx.questions} waiting`, color: PROMPT_PALETTE.HOSTCTL });
    }

    if (ctx.p10kSegments.time) {
      trailing.push({ text: `${ICON_CLOCK} ${time_now()}`, color: PROMPT_PALETTE.TIME });
    }

    if (ctx.p10kSegments.duration && ctx.lastCommandDurationMs >= DURATION_THRESHOLD_MS) {
      trailing.push({
        text: `${ICON_BOLT} ${duration_format(ctx.lastCommandDurationMs)}`,
        color: PROMPT_PALETTE.DURATION,
      });
    }

    if (ctx.p10kSegments.status && ctx.lastExitCode !== 0) {
      trailing.push({ text: `${ICON_ERROR} ${ctx.lastExitCode}`, color: PROMPT_PALETTE.STATUS });
    }

    const procSegments: SegmentSpec[] = [];
    if (ctx.procWarmup) {
      if (ctx.procWarmup.sweeping !== false) {
        const progress: string = procProgress_format(
          ctx.procWarmup.loaded,
          ctx.procWarmup.total ?? 0,
        );
        const state: ProcPromptState = procPromptState_get(ctx.procWarmup);
        const presentation = PROC_STATE_SEGMENTS[state];
        procSegments.push({
          text: `${presentation.icon} ${presentation.label}: ${progress}`,
          color: presentation.color,
        });
      }
      // A feed's first-visit load and roster arrivals: index movement no
      // command announces, so the prompt says it.
      for (const feed of ctx.procWarmup.feeds ?? (ctx.procWarmup.feed ? [ctx.procWarmup.feed] : [])) {
        procSegments.push({
          text: feed.failed !== undefined
            ? `${ICON_ERROR} feed ${feed.id}: FAILED at ${procProgress_format(feed.loaded, feed.total)}`
            : `${ICON_REFRESH} feed ${feed.id}: ${procProgress_format(feed.loaded, feed.total)}`,
          color: feed.failed !== undefined ? PROC_STATE_SEGMENTS.failed.color : PROMPT_PALETTE.TIME,
        });
      }
      if (ctx.procWarmup.roster !== undefined) {
        procSegments.push({ text: `${ICON_REFRESH} roster: ${ctx.procWarmup.roster === 'full' ? 'full walk' : 'delta'}`, color: PROMPT_PALETTE.TIME });
      }
      if (ctx.procWarmup.arrived && ctx.procWarmup.arrived.length > 0) {
        procSegments.push({
          text: feedArrivals_format(ctx.procWarmup.arrived).trim(),
          color: PROMPT_PALETTE.TIME,
        });
      }
    }

    // A session still warming says so: a surface can attach before the
    // daemon's warm-up ends, and its lines are answered meanwhile.
    if (ctx.warmupPending && ctx.warmupPending.length > 0) {
      procSegments.push({
        text: `${ICON_REFRESH} warming: ${ctx.warmupPending.map((label: string): string => label.toLowerCase()).join(' ')}`,
        color: PROMPT_PALETTE.TIME,
      });
    }

    const rightSegments: SegmentSpec[] = [...procSegments, ...trailing];

    // Compute path budget: terminal limit minus fixed + trailing segment overhead + dir overhead
    const limit: number = Math.floor(ctx.terminalWidth * FILL_RATIO);

    const fixedRendered: string = fixed
      .map((segment: SegmentSpec) => segment_render(segment.text, segment.color))
      .join('');
    const trailingRendered: string = rightSegments
      .map((segment: SegmentSpec) => segment_render(segment.text, segment.color))
      .join('');
    const fixedOverhead: number = ansi_visibleLength(fixedRendered) + fixed.length;
    const trailingOverhead: number = ansi_visibleLength(trailingRendered) + rightSegments.length;
    // dir: +2 padding, +1 sep before, +1 final sep (or sep to first trailing)
    const dirOverhead: number = 4;
    const pathBudget: number = limit - fixedOverhead - trailingOverhead - dirOverhead;
    const displayPath: string = homePath_abbreviate(ctx.cwd, ctx.user);
    const dirPath: string = path_truncate(displayPath, Math.max(pathBudget, 4));

    const defs: SegmentSpec[] = [
      ...fixed,
      { text: `${ICON_FOLDER} ${dirPath}`, color: PROMPT_PALETTE.DIR },
      ...rightSegments,
    ];

    let line1: string = '';
    for (let i: number = 0; i < defs.length; i++) {
      const def: SegmentSpec = defs[i];
      line1 += segment_render(def.text, def.color);
      if (i < defs.length - 1) {
        line1 += separator_render(def.color, defs[i + 1].color);
      } else {
        line1 += separator_final(def.color);
      }
    }

    const glyphColor: HexColor = statusColor_get(ctx.lastExitCode);
    const line2: string = chalk.hex(glyphColor)('❯') + ' ';
    return `${line1}\n${line2}`;
  }

  /**
   * Renders a prompt from the segments a backend sent, in their order: the
   * leading ones as they came, the `cwd` one budgeted like a path, and the
   * theme's own telemetry trailing. When the line is tight the identity
   * yields columns first, truncated from the left so its ending stays.
   *
   * @param ctx - The prompt context.
   * @param wire - The backend's segments, at least one.
   * @returns The two-line prompt.
   */
  private segments_render(ctx: PromptContext, wire: ReadonlyArray<PromptSegment>): string {
    const trailing: SegmentSpec[] = trailing_build(ctx);
    const cwdSegment: PromptSegment | undefined = wire.find((segment: PromptSegment): boolean => segment.key === 'cwd');
    const leading: PromptSegment[] = wire.filter((segment: PromptSegment): boolean => segment.key !== 'cwd');
    const limit: number = Math.floor(ctx.terminalWidth * FILL_RATIO);
    const trailingOverhead: number = overhead_measure(trailing);
    const dirOverhead: number = 4;

    const specs_make = (identityMax: number | null): SegmentSpec[] => leading.map((segment: PromptSegment): SegmentSpec => {
      const icon: string | undefined = SEGMENT_ICONS[segment.key];
      const value: string = identityMax !== null && segment.tone === 'identity' ? text_truncateLeft(segment.value, identityMax) : segment.value;
      return { text: icon !== undefined ? `${icon} ${value}` : value, color: TONE_COLORS[segment.tone] };
    });

    let fixed: SegmentSpec[] = specs_make(null);
    let pathBudget: number = limit - overhead_measure(fixed) - trailingOverhead - dirOverhead;
    const identity: PromptSegment | undefined = leading.find((segment: PromptSegment): boolean => segment.tone === 'identity');
    if (pathBudget < PATH_FLOOR && identity !== undefined && identity.value.length > IDENTITY_FLOOR) {
      const identityMax: number = Math.max(IDENTITY_FLOOR, identity.value.length - (PATH_FLOOR - pathBudget));
      fixed = specs_make(identityMax);
      pathBudget = limit - overhead_measure(fixed) - trailingOverhead - dirOverhead;
    }
    const dirPath: string = path_truncate(cwdSegment?.value ?? ctx.cwd, Math.max(pathBudget, 4));
    const dirColor: PromptColorPair = cwdSegment !== undefined ? TONE_COLORS[cwdSegment.tone] : PROMPT_PALETTE.DIR;
    const defs: SegmentSpec[] = [...fixed, { text: `${ICON_FOLDER} ${dirPath}`, color: dirColor }, ...trailing];
    const glyphColor: HexColor = statusColor_get(ctx.lastExitCode);
    return `${bar_assemble(defs)}\n${chalk.hex(glyphColor)('❯')} `;
  }
}

/**
 * Measures what a run of segments costs in columns once rendered: their
 * visible text plus one separator each.
 *
 * @param specs - The segments.
 * @returns The columns they take.
 */
function overhead_measure(specs: ReadonlyArray<SegmentSpec>): number {
  const rendered: string = specs.map((segment: SegmentSpec): string => segment_render(segment.text, segment.color)).join('');
  return ansi_visibleLength(rendered) + specs.length;
}

/**
 * Joins segments into the bar: each on its background, a powerline separator
 * between neighbours and a final one fading to the terminal.
 *
 * @param defs - The segments in order.
 * @returns The bar's ANSI string.
 */
function bar_assemble(defs: ReadonlyArray<SegmentSpec>): string {
  let line: string = '';
  for (let i: number = 0; i < defs.length; i++) {
    const def: SegmentSpec = defs[i];
    line += segment_render(def.text, def.color);
    line += i < defs.length - 1 ? separator_render(def.color, defs[i + 1].color) : separator_final(def.color);
  }
  return line;
}

/**
 * The theme's own telemetry, trailing any backend's segments: physical mode,
 * host control, open questions, the time, the last command's duration and
 * exit status.
 *
 * @param ctx - The prompt context.
 * @returns The trailing segments, possibly none.
 */
function trailing_build(ctx: PromptContext): SegmentSpec[] {
  const trailing: SegmentSpec[] = [];
  if (ctx.physicalMode) {
    trailing.push({ text: `${ICON_MICROSCOPE} PHYSICAL`, color: PROMPT_PALETTE.PHYSICAL });
  }
  if (ctx.hostControl !== undefined && ctx.hostControl.length > 0) {
    trailing.push({ text: `⚠ HOST ${ctx.hostControl.join(',')}`, color: PROMPT_PALETTE.HOSTCTL });
  }
  if (ctx.questions !== undefined && ctx.questions > 0) {
    trailing.push({ text: `? ${ctx.questions} waiting`, color: PROMPT_PALETTE.HOSTCTL });
  }
  if (ctx.p10kSegments.time) {
    trailing.push({ text: `${ICON_CLOCK} ${time_now()}`, color: PROMPT_PALETTE.TIME });
  }
  if (ctx.p10kSegments.duration && ctx.lastCommandDurationMs >= DURATION_THRESHOLD_MS) {
    trailing.push({ text: `${ICON_BOLT} ${duration_format(ctx.lastCommandDurationMs)}`, color: PROMPT_PALETTE.DURATION });
  }
  if (ctx.p10kSegments.status && ctx.lastExitCode !== 0) {
    trailing.push({ text: `${ICON_ERROR} ${ctx.lastExitCode}`, color: PROMPT_PALETTE.STATUS });
  }
  return trailing;
}
