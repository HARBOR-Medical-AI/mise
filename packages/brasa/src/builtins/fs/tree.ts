/**
 * @file `tree`: a folder of ChRIS's filesystem (CFS) drawn as a tree, or
 * listed one path per line.
 *
 * Declared in one record (`treeCommand`): one path, and its switches.
 *
 * Key components:
 * - treeCommand: the declaration.
 * - builtin_tree: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_tree(['--dirs', '~/feeds']);
 * ```
 *
 * Dependencies: chili's scan for the walk; the listing for whether a path
 * is there.
 *
 * @module
 */
import chalk from 'chalk';
import { path_resolve, error_stripDebugPrefix } from '../utils.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { vfs } from '../../lib/vfs/vfs.js';
import { session } from '../../session/index.js';
import { spinner } from '../../lib/spinner.js';
import { scan_do, archyTree_create, type CLIscan, type ScanRecord } from '@fnndsc/chili/path/pathCommand.js';
import { bytes_format } from '@fnndsc/chili/commands/fs/upload.js';
import { errorStack } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error, type ListingItem } from '@fnndsc/menu';
import type { Result } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';

/**
 * What a `tree` line may hold. An option it does not have is refused, not
 * skipped: `tree -L 1 x` once scanned a folder named `1`, and
 * `tree --bogus x` the whole home.
 */
const TREE_GRAMMAR = {
  operands: [
    { name: 'path', kind: 'cfsPath', optional: true, glob: true, summary: 'The folder to draw; the working directory when none is given' },
  ],
  options: {
    follow: { long: 'follow', summary: 'Follow symbolic links when traversing' },
    listPaths: { long: 'path', summary: 'Emit one full path per entry (grep-friendly, no tree art)' },
    dirs: { long: 'dirs', summary: 'Show directories only' },
    dirpath: { long: 'dirpath', summary: 'Emit one full directory path per line' },
  },
} as const satisfies CommandGrammar;

/**
 * `tree [--follow] [--path] [--dirs] [--dirpath] [path]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [treeCommand] }, 'backend');
 * ```
 */
export const treeCommand = command_declare({
  name: 'tree',
  grammar: TREE_GRAMMAR,
  help: {
    summary: 'Display directory tree structure',
    description: "Draws a folder of ChRIS's filesystem and everything under it as a tree, with the total size and the number of items; or, with --path or --dirpath, lists one full path per line. The working directory when no path is given.",
    category: 'Navigation',
    posix: { group: 'Files', differs: 'a CFS tree' },
    examples: [
      'tree                  # Tree of current directory',
      'tree /home/user/data  # Tree of specific path',
      'tree --follow         # Follow symbolic links',
      'tree --path           # One path per line, no decoration',
      'tree --dirs           # Directory hierarchy only',
      'tree --dirpath        # One directory path per line',
    ],
  },
  holds: [],
  handler: tree_run,
});

/**
 * `tree` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `tree`.
 * @returns The tree, or the refusal of a bad line.
 */
export async function builtin_tree(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(treeCommand, args);
}

/**
 * Displays a directory tree of the ChRIS filesystem.
 * Uses chili's scan_do machinery for recursive filesystem traversal.
 *
 * @param args - The line, parsed.
 * @returns The tree and its summary, or why it could not be drawn.
 */
async function tree_run(args: CommandArguments<typeof TREE_GRAMMAR>): Promise<CommandEnvelope> {
  const pathArg: string | undefined = args.operands.path;
  const dirpathMode: boolean = args.options.dirpath;
  const pathMode: boolean = args.options.listPaths || dirpathMode;
  const dirsOnly: boolean = args.options.dirs || dirpathMode;

  // Determine target path
  let targetPath: string | undefined;
  if (pathArg !== undefined) {
    targetPath = await path_resolve(pathArg);
    // A path that is not there is said to be not there, as tree says it,
    // rather than scanned into an empty tree.
    const entry: Result<ListingItem[]> = await vfs.data_get(targetPath, { directory: true });
    if (!entry.ok) {
      errorStack.stack_pop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`tree: ${pathArg}: No such file or directory`)}\n`);
    }
  }

  // Build scan options
  const scanOptions: CLIscan = {
    silent: true,
    tree: false,  // We'll format it ourselves
    follow: args.options.follow,
    dirsOnly,
    // A named folder is scanned where it stands: the shared directory stays put.
    ...(targetPath ? { folder: targetPath } : {}),
  };
  const originalFolder: string = await session.getCWD();

  spinner.start(`Scanning ${targetPath || 'current directory'}...`);
  const scanResult: ScanRecord | null = await scan_do(scanOptions);

  if (!scanResult) {
    spinner.stop();
    const lastError = errorStack.stack_pop();
    exitCode_set(1);
    const message: string = lastError ? error_stripDebugPrefix(lastError.message) : 'Failed to scan directory tree.';
    return envelope_error('', undefined, `${chalk.red(message)}\n`);
  }

  spinner.stop();

  let rendered: string = '';
  if (pathMode) {
    // --path: emit one full chrisPath per entry — grep-friendly
    for (const item of scanResult.fileInfo) {
      rendered += `${item.chrisPath}\n`;
    }
  } else if (scanResult.fileInfo.length === 0) {
    // An empty folder is its own tree: its name, and nothing under it.
    rendered += `${targetPath ?? originalFolder}\n`;
  } else {
    // Default: ASCII tree
    rendered += `${archyTree_create(scanResult.fileInfo)}\n`;
  }

  // Display summary
  rendered += `${chalk.green(`Total size: ${bytes_format(scanResult.totalSize)}`)}\n`;
  rendered += `${chalk.gray(`${scanResult.fileInfo.length} items`)}\n`;
  return envelope_ok(rendered);
}
