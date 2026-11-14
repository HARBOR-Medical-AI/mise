/**
 * @file Stand-ins for the declared commands, for a suite that stubs their
 * modules: each has the shape of its real grammar (the operands and options
 * dispatch, help and completion read) and the handler the suite gives it,
 * so the suite meets them without loading the commands' modules. The real
 * declarations are tested in `commandDeclarations.test.ts`.
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import { command_declare, type AnyCommandDeclaration } from '../../src/core/commandDeclaration.js';

/** A stand-in's handler: what the suite records the typed line with. */
export type StandInHandler = (args: never) => Promise<CommandEnvelope | void> | unknown;

/**
 * Wraps a suite's handler as a declaration's: one that answers nothing
 * answers a fresh empty envelope, since dispatch writes into what it is given.
 *
 * @param handler - The suite's handler.
 * @returns The declaration's handler.
 */
function handler_wrap(handler: StandInHandler): (args: unknown) => Promise<CommandEnvelope> {
  return async (args: unknown): Promise<CommandEnvelope> => ((await (handler as (a: unknown) => unknown)(args)) as CommandEnvelope | undefined) ?? { status: 'ok', rendered: '' };
}

/**
 * `ls`, standing in: a path operand that globs, and its options.
 *
 * @param handler - What runs it.
 * @returns The declaration.
 */
export function lsStandIn_make(handler: StandInHandler): AnyCommandDeclaration {
  return command_declare({
    name: 'ls',
    grammar: {
      operands: [{ name: 'path', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'What to list' }],
      options: {
        long: { short: 'l', summary: 'Long format' },
        oneColumn: { short: '1', summary: 'One entry per line' },
        human: { short: 'h', summary: 'Human-readable sizes' },
        refresh: { short: 'f', long: 'refresh', summary: 'Read afresh' },
        reverse: { short: 'r', long: 'reverse', summary: 'Reverse the sort' },
        directory: { short: 'd', summary: 'The folder itself' },
        sort: { long: 'sort', summary: 'Sort by', value: { name: 'field', kind: 'enum', values: ['name', 'size', 'date', 'owner'] } },
      },
    },
    help: { summary: 'List directory contents', description: 'List directory contents', category: 'Navigation', posix: { group: 'Files', differs: 'lists CFS' } },
    holds: [],
    handler: handler_wrap(handler),
  });
}

/**
 * `download`, standing in: CFS sources that glob, a host destination.
 *
 * @param handler - What runs it.
 * @returns The declaration.
 */
export function downloadStandIn_make(handler: StandInHandler): AnyCommandDeclaration {
  return command_declare({
    name: 'download',
    grammar: {
      operands: [
        { name: 'source', kind: 'cfsPath', repeat: true, glob: true, summary: 'What to download' },
        { name: 'destination', kind: 'hostPath', summary: 'Where it goes' },
      ],
      options: { force: { short: 'f', long: 'force', summary: 'Overwrite' } },
    },
    help: { summary: 'Download ChRIS files or folders to this machine', description: 'Download a ChRIS file, directory, or CFS glob to the local filesystem', category: 'Files' },
    handler: handler_wrap(handler),
  });
}

/**
 * `berth`, standing in: its subcommands.
 *
 * @param handler - What runs it.
 * @returns The declaration.
 */
export function berthStandIn_make(handler: StandInHandler): AnyCommandDeclaration {
  return command_declare({
    name: 'berth',
    grammar: {
      bare: { summary: 'List the anchors' },
      subcommands: {
        anchor: { summary: 'Download a ChRIS path', operands: [{ name: 'path', kind: 'cfsPath', summary: 'The path' }, { name: 'name', kind: 'word', optional: true, summary: 'Its name' }] },
        close: { summary: 'Return the work' },
        drop: { summary: 'Remove one anchor', operands: [{ name: 'name', kind: 'word', summary: 'The anchor' }] },
        clear: { summary: 'Remove every anchor' },
      },
    },
    help: { summary: "The ChRIS paths downloaded into this session's berth", description: "Anchor ChRIS paths in this session's berth", category: 'Workflows' },
    holds: [],
    handler: handler_wrap(handler),
  });
}

/**
 * Any other declared command, standing in: its words handed to the suite's
 * handler as they came, as the command's name in a group's records was
 * handed them, for a suite that meets the command only by name.
 *
 * @param name - The command's name.
 * @param handler - What runs it.
 * @returns The declaration.
 */
export function wordsStandIn_make(name: string, handler: StandInHandler): AnyCommandDeclaration {
  const run: (args: unknown) => Promise<CommandEnvelope> = handler_wrap(handler);
  return {
    name,
    grammar: 'expression',
    help: { usage: name, summary: name, description: name, category: 'General' },
    handler: (args: string[]): Promise<CommandEnvelope> => run(args),
  };
}

/** Each declared command's stand-in maker, by the name its module exports it under. */
export const STAND_IN_MAKERS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  lsCommand: lsStandIn_make,
  downloadCommand: downloadStandIn_make,
  berthCommand: berthStandIn_make,
};
