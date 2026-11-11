/**
 * @file The resolved call of a `/bin` run, as lines: the node it attaches
 * to and the parameters it runs with, defaults marked. A run prints them
 * before it is dispatched; `whatif` prints them and dispatches nothing.
 *
 * @module
 */
import { path_extractPluginInstanceID, path_isInFeed } from '@fnndsc/cumin';

/** One parameter a plugin declares, as CUBE lists it. */
export interface DeclaredParameter {
  /** The parameter's name, the flag without its dashes. */
  name: string;
  /** The plugin's own default, when it declares one. */
  default?: unknown;
}

/**
 * Writes a value as the shell would read it back: bare when it is one plain word, quoted otherwise.
 *
 * @param value - A parameter's value.
 * @returns The word.
 */
export function echoValue_render(value: unknown): string {
  const text: string = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return /^[\w./:@%+,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line naming where a run attaches.
 *
 * @param place - The directory the run stands in, resolved.
 * @param title - The title a new feed would carry.
 * @returns `on   feed_N / pl-x_ID` inside the feeds tree; outside it, the new feed pl-dircopy roots.
 */
export function echoNode_render(place: string, title: string): string {
  if (!path_isInFeed(place)) return `  on   a new feed, rooted by pl-dircopy of ${place}, titled "${title}"`;
  const instanceID: number | null = path_extractPluginInstanceID(place);
  const segments: string[] = place.split('/');
  const feed: string = segments.find((segment: string): boolean => /^feed_\d+$/.test(segment)) ?? 'feed';
  const node: string | undefined = instanceID === null ? undefined : [...segments].reverse().find((segment: string): boolean => segment.endsWith(`_${instanceID}`));
  return `  on   ${feed} / ${node ?? '(no node)'}`;
}

/**
 * The line of a run's parameters: those the line gave, then the plugin's
 * other parameters at their defaults, each marked `(default)`.
 *
 * @param given - The parameters the line set, by name.
 * @param declared - The parameters the plugin declares, or null when CUBE did not say.
 * @returns `with --a 1  --b x (default)`, or `with no parameters`.
 */
export function echoParameters_render(given: Readonly<Record<string, unknown>>, declared: readonly DeclaredParameter[] | null): string {
  const words: string[] = Object.entries(given).map(([name, value]: [string, unknown]): string => `--${name} ${echoValue_render(value)}`);
  for (const parameter of declared ?? []) {
    if (parameter.name in given) continue;
    words.push(`--${parameter.name} ${echoValue_render(parameter.default ?? '')} (default)`);
  }
  if (words.length === 0) return '  with no parameters';
  return `  with ${words.join('  ')}${declared === null ? '  (defaults not read)' : ''}`;
}
