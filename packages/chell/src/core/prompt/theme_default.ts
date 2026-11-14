/**
 * @file Default prompt theme.
 *
 * Single-line prompt that fits within 80% of the terminal width.
 * When the path causes overflow the oldest ancestors are dropped and
 * replaced with `...`; if even the leaf alone is too long it is
 * front-truncated to fit.
 *
 * Format: [PHYSICAL] user@uri:path$
 *
 * @module
 */

import chalk from 'chalk';
import { procPromptState_get, type ProcPromptState, type PromptSegment } from '@fnndsc/menu';
import type { PromptContext, PromptTheme } from './index.js';
import { PROMPT_PALETTE, statusColor_get, type HexColor } from './palette.js';
import {
  ansi_visibleLength,
  homePath_abbreviate,
  path_truncate,
  procProgress_format,
  feedArrivals_format,
  warmupFailures_format,
  warmupPending_format,
} from './utils.js';

/** Fraction of terminal width allowed before path truncation kicks in. */
const FILL_RATIO: number = 0.8;

/** Human-readable prompt label for each process-index state. */
const PROC_STATE_LABELS: Record<ProcPromptState, string> = {
  cold: 'cold',
  cached: 'cached, refreshing',
  failed: 'failed',
};

/**
 * Default single-line prompt theme with smart path truncation.
 */
export class ThemeDefault implements PromptTheme {
  render(ctx: PromptContext): string {
    const limit: number = Math.floor(ctx.terminalWidth * FILL_RATIO);
    const wire: ReadonlyArray<PromptSegment> = ctx.segments ?? [];
    if (wire.length > 0) {
      // A backend's segments, plainly: the leading ones space-separated, the
      // working directory after a colon, the glyph coloured by the last exit.
      const cwd: string = wire.find((segment: PromptSegment): boolean => segment.key === 'cwd')?.value ?? ctx.cwd;
      const head: string = wire.filter((segment: PromptSegment): boolean => segment.key !== 'cwd').map((segment: PromptSegment): string => segment.value).join(' ');
      const budget: number = limit - head.length - 3;
      const wirePath: string = path_truncate(cwd, Math.max(budget, 4));
      return `${head}:${wirePath}${chalk.hex(statusColor_get(ctx.lastExitCode))('$ ')}`;
    }
    const modePrefix: string = ctx.physicalMode
      ? chalk.hex(PROMPT_PALETTE.PHYSICAL.bg)('[PHYSICAL] ')
      : '';

    // Compute fixed visible length: modePrefix + user + '@' + uri + ':' + '$ '
    const fixedVisible: number =
      ansi_visibleLength(modePrefix) +
      ctx.user.length +
      1 + // '@'
      ctx.uri.length +
      1 + // ':'
      2;  // '$ '

    const pathBudget: number = limit - fixedVisible;
    const displayPath: string = homePath_abbreviate(ctx.cwd, ctx.user);
    const path: string = path_truncate(displayPath, pathBudget);

    const glyphColor: HexColor = statusColor_get(ctx.lastExitCode);
    const glyph: string = chalk.hex(glyphColor)('$ ');
    let warmup: string = '';
    if (ctx.procWarmup) {
      const state: ProcPromptState = procPromptState_get(ctx.procWarmup);
      const color: HexColor = state === 'failed'
        ? PROMPT_PALETTE.ERROR
        : PROMPT_PALETTE.WARMUP;
      if (ctx.procWarmup.sweeping !== false) {
        warmup += chalk.hex(color)(
          ` [proc ${PROC_STATE_LABELS[state]}: ${procProgress_format(ctx.procWarmup.loaded, ctx.procWarmup.total ?? 0)}]`,
        );
      }
      // A feed's first-visit load and roster arrivals: index movement no
      // command announces, so the prompt says it.
      for (const feed of ctx.procWarmup.feeds ?? (ctx.procWarmup.feed ? [ctx.procWarmup.feed] : [])) {
        warmup += feed.failed !== undefined
          ? chalk.hex(PROMPT_PALETTE.ERROR)(` [feed ${feed.id} indexing: FAILED at ${procProgress_format(feed.loaded, feed.total)}]`)
          : chalk.hex(PROMPT_PALETTE.WARMUP)(` [feed ${feed.id} indexing: ${procProgress_format(feed.loaded, feed.total)}]`);
      }
      if (ctx.procWarmup.roster !== undefined) {
        warmup += chalk.hex(PROMPT_PALETTE.WARMUP)(` [roster: ${ctx.procWarmup.roster === 'full' ? 'full walk' : 'delta'}]`);
      }
      if (ctx.procWarmup.arrived && ctx.procWarmup.arrived.length > 0) {
        warmup += chalk.hex(PROMPT_PALETTE.WARMUP)(feedArrivals_format(ctx.procWarmup.arrived));
      }
    }
    // A session still warming says so: a surface can attach before the
    // daemon's warm-up ends, and its lines are answered meanwhile.
    if (ctx.warmupPending && ctx.warmupPending.length > 0) {
      warmup += chalk.hex(PROMPT_PALETTE.WARMUP)(warmupPending_format(ctx.warmupPending));
    }
    // A warm-up that failed behind the prompt has no readout left to be
    // printed to, so it is said here until a later attempt clears it.
    if (ctx.warmupFailures && ctx.warmupFailures.length > 0) {
      warmup += chalk.hex(PROMPT_PALETTE.ERROR)(warmupFailures_format(ctx.warmupFailures));
    }
    // A question open somewhere in the session: its command is paused,
    // waiting on someone, and `who` says who asked what.
    if (ctx.questions !== undefined && ctx.questions > 0) {
      warmup += chalk.hex(PROMPT_PALETTE.HOSTCTL.bg)(` [? ${ctx.questions} waiting]`);
    }
    return (
      modePrefix +
      chalk.hex(PROMPT_PALETTE.USER.bg)(ctx.user) +
      '@' +
      chalk.hex(PROMPT_PALETTE.HOST.bg)(ctx.uri) +
      ':' +
      chalk.hex(PROMPT_PALETTE.DIR.bg)(path) +
      warmup +
      glyph
    );
  }
}
