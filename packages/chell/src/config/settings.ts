/**
 * @file ChELL Settings Configuration
 *
 * Manages application-level settings and preferences.
 * Config file location follows platform conventions:
 *   Linux:   $XDG_CONFIG_HOME/chell/settings.json  (default ~/.config/chell/settings.json)
 *   macOS:   ~/Library/Application Support/chell/settings.json
 *   Windows: %APPDATA%\chell\settings.json
 *
 * @module
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ThemeName, P10kSegmentConfig } from '../core/prompt/index.js';
import { THEME_NAMES, P10K_OPTIONAL_SEGMENTS } from '../core/prompt/index.js';
import {
  storeUrl_set,
  storeUrlOverride_get,
  storeConfigPersist_install,
  pluginIndex_set,
  pluginIndexOverride_get,
  indexConfigPersist_install,
} from '@fnndsc/brasa';

/**
 * User-configurable chell settings.
 *
 * This is the CLI surface's own configuration (history and prompt theming).
 * Engine configuration such as the peer store URL lives in the engine's store
 * config; this module owns only where it is persisted, not the value.
 */
export interface Settings {
  config: {
    historyFile: string;
    historySize: number;
    /** Prompt theme — 'default' (single-line smart truncation) or 'p10k' (two-line segment bar). */
    promptTheme: ThemeName;
    /** Which optional p10k segments are enabled. */
    p10kSegments: P10kSegmentConfig;
  };
}

/**
 * Returns the platform-appropriate config directory for chell.
 */
function configDir_get(): string {
  const platform: string = os.platform();
  const home: string = os.homedir();

  let base: string;
  if (platform === 'win32') {
    base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  }

  return path.join(base, 'chell');
}

const CONFIG_FILE: string = path.join(configDir_get(), 'settings.json');

/**
 * The active in-memory settings object.
 */
export const settings: Settings = {
  config: {
    historyFile: '.chell_history',
    historySize: 1000,
    promptTheme: 'default',
    p10kSegments: { pacs: true, time: false, duration: false, status: true },
  },
};

/**
 * Loads settings from disk into the active settings object.
 */
export async function settings_load(): Promise<void> {
  try {
    const raw: string = await fs.promises.readFile(CONFIG_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj: Record<string, unknown> = parsed as Record<string, unknown>;
      if (typeof obj.promptTheme === 'string' && THEME_NAMES.includes(obj.promptTheme as ThemeName)) {
        settings.config.promptTheme = obj.promptTheme as ThemeName;
      }
      if (obj.p10kSegments && typeof obj.p10kSegments === 'object') {
        const segs: Record<string, unknown> = obj.p10kSegments as Record<string, unknown>;
        for (const key of P10K_OPTIONAL_SEGMENTS) {
          if (typeof segs[key] === 'boolean') {
            settings.config.p10kSegments[key] = segs[key] as boolean;
          }
          // pacs defaults true if not present in older config files
        }
      }
      if (typeof obj.storeUrl === 'string') {
        storeUrl_set(obj.storeUrl);
      }
      if (typeof obj.pluginIndex === 'string') {
        pluginIndex_set(obj.pluginIndex);
      }
    }
  } catch (error: unknown) {
    // A missing file is the normal first-run state; any other failure
    // (corrupt JSON, permissions) means the user's settings were silently
    // NOT applied, which deserves a visible note.
    const code: string | undefined = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      const msg: string = error instanceof Error ? error.message : String(error);
      console.error(`[!] Could not load settings from ${CONFIG_FILE}: ${msg}. Using defaults.`);
    }
  }
}

/**
 * Persists the active settings object to disk.
 */
export async function settings_save(): Promise<void> {
  try {
    await fs.promises.mkdir(configDir_get(), { recursive: true });
    const storeUrl: string | undefined = storeUrlOverride_get();
    const pluginIndex: string | undefined = pluginIndexOverride_get();
    const data: Record<string, unknown> = {
      promptTheme: settings.config.promptTheme,
      p10kSegments: settings.config.p10kSegments,
      ...(storeUrl !== undefined ? { storeUrl } : {}),
      ...(pluginIndex !== undefined ? { pluginIndex } : {}),
    };
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n');
  } catch (error: unknown) {
    // A failed save means the user's change will not survive this session;
    // saying nothing would let them find out the hard way next boot.
    const msg: string = error instanceof Error ? error.message : String(error);
    console.error(`[!] Could not save settings to ${CONFIG_FILE}: ${msg}`);
  }
}

// The CLI persists engine store and plugin-index configuration into the same
// settings file, so a `store set`/`store reset` or a `plugin index` change is
// written through this module's saver.
storeConfigPersist_install(settings_save);
indexConfigPersist_install(settings_save);
