/**
 * @file Pure argument parsing for the `pipeline run` subcommand.
 *
 * Dependency-free for easy unit testing.
 *
 * @module
 */
import type { PipelineInvocationBinding } from '@fnndsc/salsa';
import { executableArguments_parse } from '../argumentTokens.js';

/**
 * Optional overrides parsed from `pipeline run` arguments.
 */
export interface PipelineRunOverrides {
  computeOverride: string | undefined;
  previousOverride: number | undefined;
  paramFile: string | undefined;
  bindings: PipelineInvocationBinding[];
  /** Whether the operator asked for the handle rather than the outcome. */
  detach: boolean;
  /** Whether the echo of the resolved call lists every parameter of every piping. */
  verbose: boolean;
  /** Whether the run is resolved and printed only (`whatif`). */
  dry: boolean;
  /** A dry run on a feed that would be rooted first, so no node exists to attach to. */
  dryNewFeed: boolean;
  parseError: string | null;
}

/**
 * Parses `--compute <resource>`, `--previous <inst_id>`, `--paramFile <path>`
 * `--detach`, `--verbose` and `--whatif` from `pipeline run <name|id> ...` arguments (scanning from
 * index 2). Anything else in `--node.field value` form is a binding.
 *
 * @param args - The full `pipeline run` argument list.
 * @returns The parsed overrides.
 */
export function pipelineRunArgs_parse(args: string[]): PipelineRunOverrides {
  let computeOverride: string | undefined;
  let previousOverride: number | undefined;
  let paramFile: string | undefined;
  const bindings: PipelineInvocationBinding[] = [];
  let detach: boolean = false;
  let verbose: boolean = false;
  let dry: boolean = false;
  let dryNewFeed: boolean = false;
  let parseError: string | null = null;

  for (let i = 2; i < args.length; i++) {
    const token: string = args[i];
    if (token === '--compute') {
      const value: string | undefined = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        parseError = '--compute requires a resource';
        break;
      }
      computeOverride = value;
      i++;
    } else if (token === '--previous') {
      const value: string | undefined = args[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        parseError = '--previous requires a positive plugin instance ID';
        break;
      }
      previousOverride = Number(value);
      i++;
    } else if (token === '--detach') {
      detach = true;
    } else if (token === '--verbose') {
      verbose = true;
    } else if (token === '--whatif' || token === '--whatif-new-feed') {
      dry = true;
      dryNewFeed ||= token === '--whatif-new-feed';
    } else if (token === '--paramFile') {
      const value: string | undefined = args[i + 1];
      if (paramFile !== undefined) {
        parseError = '--paramFile may be supplied only once';
        break;
      }
      if (value === undefined || value.startsWith('--')) {
        parseError = '--paramFile requires a CFS path';
        break;
      }
      paramFile = value;
      i++;
    } else if (token.startsWith('--')) {
      const option: string = token.slice(2);
      const equalsIndex: number = option.indexOf('=');
      const compound: string = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
      const separator: number = compound.lastIndexOf('.');
      if (separator <= 0 || separator === compound.length - 1) {
        parseError = `unsupported pipeline option: ${token}`;
        break;
      }
      const node: string = compound.slice(0, separator);
      const field: string = compound.slice(separator + 1);
      let value: unknown;
      if (equalsIndex >= 0) {
        value = executableArguments_parse([`--${field}=${option.slice(equalsIndex + 1)}`])[field];
      } else {
        const next: string | undefined = args[i + 1];
        const consumesNext: boolean = next !== undefined && (!next.startsWith('--') || /^-\d/.test(next));
        value = executableArguments_parse(consumesNext ? [`--${field}`, next as string] : [`--${field}`])[field];
        if (consumesNext) i++;
      }
      bindings.push({ node, field, value });
    } else {
      parseError = `unexpected pipeline argument: ${token}`;
      break;
    }
  }

  return { computeOverride, previousOverride, paramFile, bindings, detach, verbose, dry, dryNewFeed, parseError };
}
