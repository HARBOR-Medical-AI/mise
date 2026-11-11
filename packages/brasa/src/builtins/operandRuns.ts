/**
 * @file The runs of a `/bin` line: several directory operands are several
 * runs, and the files of one run stand in one place.
 *
 * @module
 */
import { path_extractPluginInstanceID, path_isInFeed } from '@fnndsc/cumin';
import { OperandRefusal, operands_read, pathKind_read, type BinOperands, type PathKind_read } from './operands.js';

/**
 * Where a file operand stands: the node of the feeds tree holding it.
 *
 * @param file - A resolved path.
 * @returns The node's folder name (`pl-dircopy_741000`), the feed's when the path is at no node, or null outside the tree.
 */
function operandNode_name(file: string): string | null {
  if (!path_isInFeed(file)) return null;
  const instanceID: number | null = path_extractPluginInstanceID(file);
  const segments: string[] = file.split('/');
  const named: string | undefined = instanceID === null
    ? segments.find((segment: string): boolean => /^feed_\d+$/.test(segment))
    : [...segments].reverse().find((segment: string): boolean => segment.endsWith(`_${instanceID}`));
  return named ?? file;
}

/**
 * Refuses file operands that stand in more than one place: a CUBE run
 * attaches at exactly one node, so files of two nodes, or of a node and a
 * folder outside the feeds tree, cannot be one input.
 *
 * @param operands - The operands as read.
 * @throws OperandRefusal naming the two places.
 */
export function operandNodes_check(operands: BinOperands): void {
  const typed: string[] = operands.subjects.flatMap((subject): string[] => subject.typed);
  const nodes: Array<string | null> = operands.subjects.flatMap((subject): string[] => subject.files).map(operandNode_name);
  const inside: string[] = [...new Set(nodes.filter((node: string | null): node is string => node !== null))];
  if (inside.length > 1) throw new OperandRefusal(`the operands are in two nodes, ${inside[0]} and ${inside[1]}; a run attaches at one`);
  const outsideAt: number = nodes.indexOf(null);
  if (inside.length === 1 && outsideAt !== -1) {
    throw new OperandRefusal(`the operands are in the node ${inside[0]} and outside the feeds tree (${typed[outsideAt]}); a run attaches at one`);
  }
}

/**
 * Splits a line into its runs: several directory operands are several runs,
 * one per directory, as POSIX `tool a b` is; any other line is one run.
 * Every operand is checked before any run starts, so a line never fans out
 * in part.
 *
 * @param args - The words after the executable's name.
 * @param kind_read - How a path is looked at (the dispatcher, or a test's).
 * @returns One word list per run: the line itself, or `<dir> <rest>` for each directory.
 * @throws OperandRefusal as `operands_read` and `operandNodes_check` do, and for a directory in a feed but not at a node.
 */
export async function operandRuns_split(args: readonly string[], kind_read: PathKind_read = pathKind_read): Promise<string[][]> {
  const operands: BinOperands = await operands_read(args, kind_read);
  operandNodes_check(operands);
  if (operands.directories.length < 2) return [[...args]];
  for (const [index, directory] of operands.directories.entries()) {
    if (path_isInFeed(directory) && path_extractPluginInstanceID(directory) === null) {
      throw new OperandRefusal(`${operands.typed[index]} is in a feed but not at a node (…/feeds/feed_N/pl-x_ID)`);
    }
  }
  return operands.typed.map((directory: string): string[] => [directory, ...operands.rest]);
}
