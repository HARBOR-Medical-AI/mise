/**
 * @file Engine plugin-index configuration: which index `plugin sync` reads.
 *
 * Built the way the peer store's configuration is (`./storeConfig.ts`), as
 * its own setting: an index is a list of descriptors in git, not a store a
 * plugin is looked up in by name. The value lives here; where it is
 * persisted is the host's concern, through the hook it installs. With none
 * installed the override lives for the process.
 *
 * Key components:
 * - DEFAULT_PLUGIN_INDEX: the index read when the operator has set none.
 * - pluginIndex_get / pluginIndex_isDefault / pluginIndexOverride_get: read it.
 * - pluginIndex_set / pluginIndex_clear: change it.
 * - indexConfigPersist_install / indexConfig_persist: the host's persistence.
 *
 * Typical usage:
 * ```ts
 * pluginIndex_set('FNNDSC/chris-plugins@v2026.11');
 * await indexConfig_persist();
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/** The index read when the operator has set no override. */
export const DEFAULT_PLUGIN_INDEX: string = 'FNNDSC/chris-plugins@main';

/** The operator's override, or undefined to use {@link DEFAULT_PLUGIN_INDEX}. */
let pluginIndex: string | undefined;

/** Host-installed persistence hook; the default keeps the value in memory. */
let persist: () => Promise<void> = async (): Promise<void> => {
  // Headless default: the override lives for the process and is not persisted.
};

/**
 * Returns the index in effect, falling back to the default.
 *
 * @returns The index source word.
 *
 * @example
 * ```ts
 * pluginIndex_get(); // 'FNNDSC/chris-plugins@main'
 * ```
 */
export function pluginIndex_get(): string {
  return pluginIndex ?? DEFAULT_PLUGIN_INDEX;
}

/**
 * Reports whether the index in effect is the default.
 *
 * @returns True when no override is set.
 *
 * @example
 * ```ts
 * pluginIndex_isDefault(); // true
 * ```
 */
export function pluginIndex_isDefault(): boolean {
  return pluginIndex === undefined;
}

/**
 * Returns the operator's override without applying the default.
 *
 * The persistence layer uses this so it writes only an explicit override.
 *
 * @returns The override, or undefined when none is set.
 *
 * @example
 * ```ts
 * pluginIndexOverride_get(); // undefined
 * ```
 */
export function pluginIndexOverride_get(): string | undefined {
  return pluginIndex;
}

/**
 * Sets the index override.
 *
 * @param source - The index source word (`owner/repo[@ref]`, `cube:<path>`, `host:<path>`).
 *
 * @example
 * ```ts
 * pluginIndex_set('FNNDSC/chris-plugins@v2026.11');
 * ```
 */
export function pluginIndex_set(source: string): void {
  pluginIndex = source;
}

/**
 * Clears the index override, restoring the default.
 *
 * @example
 * ```ts
 * pluginIndex_clear();
 * ```
 */
export function pluginIndex_clear(): void {
  pluginIndex = undefined;
}

/**
 * Installs the host's persistence hook.
 *
 * @param fn - Callback invoked to persist the current index configuration.
 *
 * @example
 * ```ts
 * indexConfigPersist_install(settings_save);
 * ```
 */
export function indexConfigPersist_install(fn: () => Promise<void>): void {
  persist = fn;
}

/**
 * Persists the current index configuration through the installed hook.
 *
 * @returns A promise resolving once persistence completes.
 *
 * @example
 * ```ts
 * await indexConfig_persist();
 * ```
 */
export async function indexConfig_persist(): Promise<void> {
  await persist();
}
