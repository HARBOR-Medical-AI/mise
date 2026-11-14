/**
 * @file `config write <cfs-path> <base64>` — writes small configuration
 * documents into the user's CUBE home.
 *
 * The durable layer (AEGIS: config-in-CFS) stores per-user surface state —
 * argus desktops, prompt choices — as files under `~/.config/...` on CFS.
 * Surfaces hold no upload credentials of their own, so the write travels
 * the session: content arrives base64-encoded, lands in a host temp file,
 * and rides the same upload path the edit-in-place flow already uses. The
 * document is written where the store keeps its path (`storePath_resolve`).
 *
 * Declared in one record (`configCommand`): one subcommand, `write`, with a
 * CFS path and the content as a word.
 *
 * Key components:
 * - configCommand: the declaration.
 * - builtin_config: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_config(['write', '~/.config/argus/desktops/quad.desk', 'dmlldyBmaWxlcwo=']);
 * ```
 *
 * Dependencies: salsa's upload and chili's replace-in-place; the session's
 * listing cache.
 *
 * @module
 */
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, posix } from 'path';
import chalk from 'chalk';
import { files_uploadPath } from '@fnndsc/salsa';
import { file_replaceContent, type EditResult } from '@fnndsc/chili/commands/fs/edit.js';
import { path_resolve, storePath_resolve } from '../utils.js';
import { command_declare, type CommandArguments, type CommandGrammar, type SubcommandArguments } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { listingCache_get } from '../../core/filesystem.js';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** A config document is a note, not a dataset. */
const CONFIG_WRITE_LIMIT: number = 256 * 1024;

/** What a `config` line may hold: `write`, a CFS path, and the document as base64. */
const CONFIG_GRAMMAR = {
  subcommands: {
    write: {
      summary: 'Write a configuration document',
      operands: [
        { name: 'path', kind: 'cfsPath', summary: 'Where the document goes in ChRIS' },
        { name: 'content', kind: 'word', summary: 'The document, base64-encoded' },
      ],
    },
  },
} as const satisfies CommandGrammar;

/**
 * `config write <path> <content>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [configCommand] }, 'backend');
 * ```
 */
export const configCommand = command_declare({
  name: 'config',
  grammar: CONFIG_GRAMMAR,
  help: {
    summary: "Write a small configuration document into the user's CUBE home",
    description: 'Write a small configuration document into the user\'s CUBE home (the durable layer: argus desktops, surface preferences). Reads travel the ordinary cat. Documents are notes, not datasets: 256KB limit.',
    category: 'Files',
    examples: [
      'config write ~/.config/argus/desktops/quad.desk dmlldyBmaWxlcwo=   # a saved argus desktop',
      'cat ~/.config/argus/desktops/quad.desk                             # reading one back',
    ],
  },
  handler: async (args: CommandArguments<typeof CONFIG_GRAMMAR>): Promise<CommandEnvelope> => configWrite_run(args),
});

/**
 * `config` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `config`.
 * @returns The subcommand's envelope, or the refusal of a bad line.
 */
export async function builtin_config(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(configCommand, args);
}

/**
 * Runs `config write <path> <base64>`.
 *
 * @param args - The line, parsed.
 * @returns An envelope reporting the written path.
 */
async function configWrite_run(args: SubcommandArguments<typeof CONFIG_GRAMMAR, 'write'>): Promise<CommandEnvelope> {
  const rawPath: string = args.operands.path;
  const content: Buffer = Buffer.from(args.operands.content, 'base64');
  if (content.length > CONFIG_WRITE_LIMIT) {
    exitCode_set(1);
    return envelope_error('', undefined, 'config write: a config document is a note, not a dataset (256KB limit).\n');
  }

  const shown: string = await path_resolve(rawPath);
  const remotePath: string = await storePath_resolve(rawPath);
  const tmpPath: string = join(tmpdir(), `chell-config-${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    // A fresh document uploads; an existing one is replaced in place (the
    // edit idiom: CFS files are immutable, so replace = delete + upload).
    let uploaded: boolean = await files_uploadPath(tmpPath, remotePath);
    if (!uploaded) {
      const replaced: EditResult = await file_replaceContent(remotePath, tmpPath);
      uploaded = replaced.success;
    }
    if (!uploaded) {
      exitCode_set(1);
      return envelope_error('', undefined, `config write: upload to ${shown} failed.\n`);
    }
    // The folder's listing is stale by both its names.
    listingCache_get().cache_invalidate?.(posix.dirname(remotePath));
    listingCache_get().cache_invalidate?.(posix.dirname(shown));
    return envelope_ok(`${chalk.green('[+]')} wrote ${shown} (${content.length} bytes)\n`);
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}
