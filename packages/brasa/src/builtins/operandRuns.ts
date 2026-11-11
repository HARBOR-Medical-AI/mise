/**
 * @file The runs of a `/bin` line: several directory operands are several runs.
 *
 * @module
 */
import { path_extractPluginInstanceID, path_isInFeed } from '@fnndsc/cumin';
import { OperandRefusal, operands_read, pathKind_read, type BinOperands, type PathKind_read } from './operands.js';

/**
 * Splits a line into its runs: several directory operands are several runs,
 * one per directory, as POSIX `tool a b` is; any other line is one run.
 * Every operand is checked before any run starts, so a line never fans out
 * in part.
 *
 * @param args - The words after the executable's name.
 * @param kind_read - How a path is looked at (the dispatcher, or a test's).
 * @returns One word list per run: the line itself, or `<dir> <rest>` for each directory.
 * @throws OperandRefusal as `operands_read` does, and for a directory in a feed but not at a node.
 */
export async function operandRuns_split(args: readonly string[], kind_read: PathKind_read = pathKind_read): Promise<string[][]> {
  const operands: BinOperands = await operands_read(args, kind_read);
  if (operands.directories.length < 2) return [[...args]];
  for (const [index, directory] of operands.directories.entries()) {
    if (path_isInFeed(directory) && path_extractPluginInstanceID(directory) === null) {
      throw new OperandRefusal(`${operands.typed[index]} is in a feed but not at a node (…/feeds/feed_N/pl-x_ID)`);
    }
  }
  return operands.typed.map((directory: string): string[] => [directory, ...operands.rest]);
}
