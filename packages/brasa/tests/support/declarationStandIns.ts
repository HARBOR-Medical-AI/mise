/**
 * @file Stand-ins for the declared commands, for a suite that stubs their
 * modules: each has the shape of its real grammar (the operands and options
 * dispatch, help and completion read) and the handler the suite gives it,
 * so the suite meets them without loading the commands' modules. The real
 * declarations are tested in `commandDeclarations.test.ts`.
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import { command_declare, type AnyCommandDeclaration, type CommandGrammar } from '../../src/core/commandDeclaration.js';

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

/**
 * A stand-in maker for a command of a simple grammar: its name, its grammar
 * and its help section, whatever the suite's handler.
 *
 * @param name - The command's name.
 * @param grammar - Its grammar, as the real one has it in shape.
 * @param category - Its help section.
 * @returns The maker.
 */
function standIn_maker(name: string, grammar: CommandGrammar, category: string, summary: string = name): (handler: StandInHandler) => AnyCommandDeclaration {
  return (handler: StandInHandler): AnyCommandDeclaration => command_declare({
    name,
    grammar,
    help: { summary, description: summary, category },
    handler: handler_wrap(handler),
  });
}

/** `on` and `off`, or neither: the switches of a setting. */
const SETTING_GRAMMAR: CommandGrammar = { bare: { summary: 'Show it' }, subcommands: { on: { summary: 'On' }, off: { summary: 'Off' } } };

/** The Connection, Navigation and Settings commands, standing in, by the name each module exports. */
export const NAVIGATION_STAND_INS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  cdCommand: standIn_maker('cd', { operands: [{ name: 'path', kind: 'cfsPath', optional: true, glob: true, summary: 'Where' }] }, 'Navigation'),
  pwdCommand: standIn_maker('pwd', { options: { title: { long: 'title', summary: 'Titles' } } }, 'Navigation'),
  timingCommand: standIn_maker('timing', SETTING_GRAMMAR, 'Settings'),
  debugCommand: standIn_maker('debug', SETTING_GRAMMAR, 'Settings'),
  physicalmodeCommand: standIn_maker('physicalmode', SETTING_GRAMMAR, 'Settings'),
  netstatCommand: standIn_maker('netstat', { options: { reset: { short: 'r', long: 'reset', summary: 'Reset' }, count: { short: 'n', summary: 'Count', value: { name: 'count', kind: 'int' } } } }, 'Connection'),
  connectCommand: standIn_maker('connect', {
    operands: [{ name: 'url', kind: 'word', summary: 'The URL' }],
    options: { user: { long: 'user', summary: 'User', value: { name: 'username', kind: 'word' } }, password: { long: 'password', summary: 'Password', value: { name: 'password', kind: 'word' } } },
  }, 'Connection'),
  logoutCommand: standIn_maker('logout', {}, 'Connection'),
  contextCommand: standIn_maker('context', {}, 'Connection'),
  whoamiCommand: standIn_maker('whoami', {}, 'Connection'),
  idCommand: standIn_maker('id', {}, 'Connection'),
  whereamiCommand: standIn_maker('whereami', {}, 'Connection'),
  treeCommand: standIn_maker('tree', {
    operands: [{ name: 'path', kind: 'cfsPath', optional: true, glob: true, summary: 'Where' }],
    options: { follow: { long: 'follow', summary: 'Follow' }, listPaths: { long: 'path', summary: 'Paths' }, dirs: { long: 'dirs', summary: 'Dirs' }, dirpath: { long: 'dirpath', summary: 'Dir paths' } },
  }, 'Navigation'),
  duCommand: standIn_maker('du', {
    operands: [{ name: 'path', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'What' }],
    options: { humanReadable: { short: 'h', long: 'human-readable', summary: 'Human' }, summarize: { short: 's', long: 'summarize', summary: 'Summary' } },
  }, 'Navigation'),
  cubepathCommand: standIn_maker('cubepath', {
    operands: [{ name: 'path', kind: 'cfsPath', repeat: true, glob: true, summary: 'PACS paths' }],
    options: { pacsserver: { long: 'pacsserver', summary: 'Server', value: { name: 'id', kind: 'word' } }, retry: { long: 'retry', summary: 'Retry' } },
  }, 'Navigation'),
};

/** The feeds a Sharing command takes. */
const FEEDS_STAND_IN = [{ name: 'path', kind: 'cfsPath', repeat: true, glob: true, summary: 'Feeds' }] as const;

/**
 * The Sharing, PACS and Imaging commands, standing in for the help a suite
 * reads (their modules are stubbed by name elsewhere, their words handed on),
 * by the name each module exports.
 */
export const SHARING_PACS_IMAGING_STAND_INS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  setfaclCommand: standIn_maker('setfacl', { operands: FEEDS_STAND_IN, options: { modify: { short: 'm', summary: 'Grant', value: { name: 'entry', kind: 'word' } } } }, 'Sharing'),
  getfaclCommand: standIn_maker('getfacl', { operands: FEEDS_STAND_IN }, 'Sharing'),
  chmodCommand: standIn_maker('chmod', { operands: [{ name: 'mode', kind: 'enum', values: ['o+r', 'o-r'], summary: 'Mode' }, ...FEEDS_STAND_IN] }, 'Sharing'),
  setfattrCommand: standIn_maker('setfattr', { operands: FEEDS_STAND_IN, options: { name: { short: 'n', summary: 'Name', value: { name: 'name', kind: 'enum', values: ['tag', 'user.tag'] } } } }, 'Sharing'),
  getfattrCommand: standIn_maker('getfattr', { operands: FEEDS_STAND_IN }, 'Sharing'),
  pacsCommand: standIn_maker('pacs', { bare: { summary: 'Active' }, subcommands: { connect: { summary: 'Connect' }, list: { summary: 'List' } } }, 'PACS'),
  queryCommand: standIn_maker('query', { operands: [{ name: 'expression', kind: 'word', optional: true, repeat: true, summary: 'Question' }] }, 'PACS'),
  pullCommand: standIn_maker('pull', { operands: [{ name: 'target', kind: 'cfsPath', repeat: true, summary: 'Targets' }] }, 'PACS'),
  pacsserversCommand: standIn_maker('pacsservers', { subcommands: { list: { summary: 'List' } } }, 'PACS'),
  pacsqueriesCommand: standIn_maker('pacsqueries', { subcommands: { list: { summary: 'List' } } }, 'PACS'),
  pacsretrieveCommand: standIn_maker('pacsretrieve', { subcommands: { report: { summary: 'Report' } } }, 'PACS'),
  dcmCommand: standIn_maker('dcm', { subcommands: { series: { summary: 'Series', operands: [{ name: 'folder', kind: 'cfsPath', summary: 'Folder' }] } } }, 'Imaging', 'DICOM as the kernel sees it'),
  imageCommand: standIn_maker('image', { operands: [{ name: 'path', kind: 'cfsPath', optional: true, summary: 'What' }] }, 'Imaging', 'Show a DICOM series or a volume — a browser draws it, a terminal reflects it'),
};

/** Each declared command's stand-in maker, by the name its module exports it under. */
export const STAND_IN_MAKERS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  lsCommand: lsStandIn_make,
  downloadCommand: downloadStandIn_make,
  berthCommand: berthStandIn_make,
  ...NAVIGATION_STAND_INS,
};

/** The core's stand-ins among them, by the name each module exports; the rest are the ChRIS backend's. */
export const CORE_STAND_IN_NAMES: ReadonlyArray<string> = ['cdCommand', 'pwdCommand', 'timingCommand', 'debugCommand'];
