/**
 * @file Moving about a ChRIS session: entering a CUBE folder, the paths
 * that are always folders, and the titles a path's feed and plugin segments
 * show. What reaches CUBE is loaded when first asked, not with the backend.
 *
 * @module
 */
import chalk from 'chalk';
import type { Client, FilteredResourceData } from '@fnndsc/cumin';
import type { FolderEntry } from '../core/backend.js';
import { session } from '../session/index.js';

/** The ChRIS paths that are always folders: the root, and the projections' own places. */
export const CHRIS_STRUCTURAL_PATHS: ReadonlyArray<string> = ['/', '/net', '/net/pacs', '/net/pacs/queries', '/proc', '/proc/jobs'];

/**
 * Interface representing a FileBrowserFolder from ChRIS API.
 */
interface FileBrowserFolder {
  path?: string;
  data?: {
    path?: string;
  };
}

/**
 * Verifies if a given FileBrowserFolder object exactly matches the validation path.
 *
 * @param folder - The FileBrowserFolder object to verify.
 * @param validationPath - The path to match against.
 * @returns True if the folder path exactly matches validationPath, false otherwise.
 */
export function folder_verifyPathMatch(folder: FileBrowserFolder | null | undefined, validationPath: string): boolean {
  if (!folder) {
    return false;
  }
  const folderPath: string = folder.data?.path || folder.path || '';

  // Normalize both by removing all leading and trailing slashes to be robust against API inconsistencies
  const cleanFolder: string = folderPath.replace(/^\/+|\/+$/g, '');
  const cleanValidation: string = validationPath.replace(/^\/+|\/+$/g, '');

  return cleanFolder === cleanValidation;
}

/**
 * Enters a CUBE folder (`cd`): the path is mapped to the one CUBE stores
 * (`storePath_resolve`) and CUBE is asked for that folder; the session stands at the logical path, or the physical one
 * in physical mode.
 *
 * @param logicalPath - The folder, as the session names it.
 * @param pathArg - The path as typed, for what cd says.
 * @returns Where to stand, or why not.
 */
export async function chrisFolder_enter(logicalPath: string, pathArg: string): Promise<FolderEntry> {
  const client: Client | null = await session.connection.client_get();
  if (!client) {
    return { cwd: null, rendered: '', renderedErr: `${chalk.red('Not connected to ChRIS.')}\n` };
  }

  const debugEnabled: boolean = session.connection.config?.debug === true;
  let rendered: string = '';

  // Where the store keeps the folder: the one resolver every file command
  // asks, links followed at any depth.
  const { storePath_resolve } = await import('../core/paths.js');
  const validationPath: string = await storePath_resolve(logicalPath);

  if (debugEnabled) {
    rendered += `${chalk.gray(`cd: ${pathArg} → logical: ${logicalPath} → validation: ${validationPath}`)}\n`;
  }

  const cwdPath: string = session.physicalMode_get() ? validationPath : logicalPath;
  const currentCwd: string = await session.getCWD();

  if (currentCwd === cwdPath) {
    if (debugEnabled) {
      rendered += `${chalk.gray(`  Already in target directory, skipping validation`)}\n`;
    }
    return { cwd: cwdPath, rendered, renderedErr: '' };
  }

  try {
    const folder: FileBrowserFolder | null | undefined = (await client.getFileBrowserFolderByPath(validationPath)) as FileBrowserFolder | null | undefined;
    if (folder_verifyPathMatch(folder, validationPath)) {
      return { cwd: cwdPath, rendered, renderedErr: '' };
    }
    let renderedErr: string = `${chalk.red(`cd: ${pathArg}: No such file or directory`)}\n`;
    if (debugEnabled) {
      if (!folder) {
        renderedErr += `${chalk.gray(`  API returned null for path: ${validationPath}`)}\n`;
      } else {
        const folderPath: string | undefined = folder.data?.path || folder.path;
        renderedErr += `${chalk.gray(`  API returned mismatched folder path: ${folderPath} (expected: ${validationPath})`)}\n`;
      }
    }
    return { cwd: null, rendered, renderedErr };
  } catch (apiError: unknown) {
    let renderedErr: string = `${chalk.red(`cd: ${pathArg}: No such file or directory`)}\n`;
    if (debugEnabled) {
      const msg: string = apiError instanceof Error ? apiError.message : String(apiError);
      renderedErr += `${chalk.gray(`  API error: ${msg}`)}\n`;
    }
    return { cwd: null, rendered, renderedErr };
  }
}

/**
 * The title a path segment shows under `pwd --title`: a feed's name for
 * `feed_N`, a plugin's name and version for `pl-name_N`.
 *
 * @param segment - One segment of the path.
 * @returns Its title, or null when it has none.
 */
export async function chrisSegment_title(segment: string): Promise<string | null> {
  const titled: string = await segment_titled(segment);
  return titled === segment ? null : titled;
}

/**
 * A segment's title, or the segment itself when it names nothing CUBE titles.
 *
 * @param part - One segment of a path.
 * @returns Its title, or the segment.
 */
async function segment_titled(part: string): Promise<string> {
  // Pattern 1: feed_XXXX
  const feedMatch: RegExpMatchArray | null = part.match(/^feed_(\d+)$/);
  if (feedMatch) {
    const feedId: number = parseInt(feedMatch[1], 10);
    try {
      const { feeds_list } = await import('@fnndsc/salsa');
      const feedData: FilteredResourceData | null = await feeds_list({ id: feedId, limit: 1 });
      if (feedData && feedData.tableData && feedData.tableData.length > 0) {
        const feed: Record<string, unknown> = feedData.tableData[0];
        if (feed && typeof feed.name === 'string') {
          return feed.name;
        }
      }
    } catch (e: unknown) {
      // Silently ignore errors
    }
    return part;
  }

  // Pattern 2: pl-<name>_XXXX
  const pluginMatch: RegExpMatchArray | null = part.match(/^(pl-.+)_(\d+)$/);
  if (pluginMatch) {
    const pluginInstanceId: number = parseInt(pluginMatch[2], 10);
    try {
      const { pluginInstances_list } = await import('@fnndsc/salsa');
      const instanceData: FilteredResourceData | null = await pluginInstances_list({ id: pluginInstanceId, limit: 1 });
      if (instanceData && instanceData.tableData && instanceData.tableData.length > 0) {
        const instance: Record<string, unknown> = instanceData.tableData[0];
        if (instance) {
          const pluginName: string = typeof instance.plugin_name === 'string' ? instance.plugin_name : '';
          const pluginVersion: string = typeof instance.plugin_version === 'string' ? instance.plugin_version : '';
          return pluginVersion ? `${pluginName} v${pluginVersion}` : pluginName;
        }
      }
    } catch (e: unknown) {
      // Silently ignore errors
    }
    return part;
  }

  return part;
}
