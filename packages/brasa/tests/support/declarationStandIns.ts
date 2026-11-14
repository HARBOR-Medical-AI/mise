/**
 * @file Stand-ins for the declared commands, for a suite that stubs their
 * modules: each has the shape of its real grammar (the operands and options
 * dispatch, help and completion read) and the handler the suite gives it,
 * so the suite meets them without loading the commands' modules. The real
 * declarations are tested in `commandDeclarations.test.ts`.
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import { command_declare, type AnyCommandDeclaration, type CommandGrammar } from '../../src/core/commandDeclaration.js';
import type { SessionPiece } from '../../src/core/commandRegistry.js';

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
 * @param aliases - The other words it answers to, as its declaration names them.
 * @returns The declaration.
 */
export function wordsStandIn_make(name: string, handler: StandInHandler, aliases: readonly string[] = []): AnyCommandDeclaration {
  const run: (args: unknown) => Promise<CommandEnvelope> = handler_wrap(handler);
  return {
    name,
    aliases,
    grammar: 'expression',
    help: { usage: name, summary: name, description: name, category: 'General' },
    handler: (args: string[]): Promise<CommandEnvelope> => run(args),
  };
}

/**
 * A command that takes any words and holds what it says: a name for a
 * suite that asks what a line holds.
 *
 * @param name - The command's name.
 * @param holds - What it holds of the session.
 * @returns The declaration.
 */
export function holdsStandIn_make(name: string, holds: readonly SessionPiece[]): AnyCommandDeclaration {
  return { ...wordsStandIn_make(name, async () => undefined), holds };
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
  urlCommand: standIn_maker('url', { operands: [{ name: 'path', kind: 'cfsPath', optional: true, summary: 'Where' }] }, 'Sharing', 'Print a link (a web address) that opens ARGUS at a path, to send to a colleague'),
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

/** The Resources commands not declared beside the others, standing in, by the name each module exports. */
export const RESOURCE_STAND_INS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  pluginCommand: (handler: StandInHandler): AnyCommandDeclaration => ({
    ...standIn_maker('plugin', { subcommands: { list: { summary: 'List' }, info: { summary: 'Info', operands: [{ name: 'plugin', kind: 'word', summary: 'Plugin' }] }, add: { summary: 'Add' } } }, 'Resources', 'The plugins registered in CUBE')(handler),
    aliases: [{ name: 'plugins', holds: [] }],
  }),
  pipelineCommand: (handler: StandInHandler): AnyCommandDeclaration => ({
    ...standIn_maker('pipeline', { bare: { summary: 'Usage' }, subcommands: { list: { summary: 'List' }, run: { summary: 'Run', operands: [{ name: 'pipeline', kind: 'word', summary: 'Pipeline' }] } } }, 'Resources', 'The registered ChRIS pipelines')(handler),
    aliases: [{ name: 'pipelines', holds: [] }],
  }),
};

/** Paths that glob, one or more. */
const PATHS: CommandGrammar['operands'] = [{ name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'Paths' }];
/** Files that glob, none or more (a pipe when none). */
const FILES: CommandGrammar['operands'] = [{ name: 'files', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'Files' }];

/** The Files commands, standing in, by the name each module exports. */
export const FILES_STAND_INS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  catCommand: standIn_maker('cat', { operands: FILES, options: { binary: { long: 'binary', summary: 'Bytes' }, noHighlight: { long: 'no-highlight', summary: 'Plain' } } }, 'Files'),
  cpCommand: standIn_maker('cp', { operands: PATHS, options: { recursive: { short: 'r', long: 'recursive', summary: 'Folders' }, askTarget: { short: 't', summary: 'Ask where' } } }, 'Files'),
  mvCommand: standIn_maker('mv', { operands: PATHS, options: { askTarget: { short: 't', summary: 'Ask where' } } }, 'Files'),
  rmCommand: standIn_maker('rm', { operands: PATHS, options: { recursive: { short: 'r', long: 'recursive', summary: 'Folders' }, force: { short: 'f', long: 'force', summary: 'Force' } } }, 'Files'),
  rmdirCommand: standIn_maker('rmdir', { operands: PATHS }, 'Files'),
  mkdirCommand: standIn_maker('mkdir', { operands: PATHS, options: { parents: { short: 'p', long: 'parents', summary: 'Parents' } } }, 'Files'),
  touchCommand: standIn_maker('touch', { operands: PATHS, options: { withContents: { long: 'withContents', summary: 'Text', value: { name: 'text', kind: 'word' } } } }, 'Files'),
  grepCommand: standIn_maker('grep', { operands: [{ name: 'pattern', kind: 'word', optional: true, summary: 'Pattern' }, ...(FILES ?? [])], options: { insensitive: { short: 'i', summary: 'Case' } } }, 'Files'),
  wcCommand: standIn_maker('wc', { operands: FILES, options: { lines: { short: 'l', long: 'lines', summary: 'Lines' } } }, 'Files'),
  headCommand: standIn_maker('head', { operands: FILES, options: { lines: { short: 'n', long: 'lines', summary: 'Count', value: { name: 'count', kind: 'word' }, numeral: true } } }, 'Files'),
  tailCommand: standIn_maker('tail', { operands: FILES, options: { lines: { short: 'n', long: 'lines', summary: 'Count', value: { name: 'count', kind: 'word' }, numeral: true } } }, 'Files'),
  sortCommand: standIn_maker('sort', { operands: FILES, options: { reverse: { short: 'r', long: 'reverse', summary: 'Reverse' } } }, 'Files'),
  uniqCommand: standIn_maker('uniq', { operands: [{ name: 'file', kind: 'cfsPath', optional: true, glob: true, summary: 'File' }], options: { count: { short: 'c', long: 'count', summary: 'Count' } } }, 'Files'),
  cutCommand: standIn_maker('cut', { operands: FILES, options: { fields: { short: 'f', long: 'fields', summary: 'Fields', value: { name: 'list', kind: 'word' } } } }, 'Files'),
  findCommand: (handler: StandInHandler): AnyCommandDeclaration => ({ ...wordsStandIn_make('find', handler), help: { usage: 'find [path...] [expression]', summary: 'find', description: 'find', category: 'Files' } }),
  editCommand: standIn_maker('edit', { operands: [{ name: 'file', kind: 'cfsPath', glob: true, summary: 'File' }] }, 'Files'),
  configCommand: standIn_maker('config', { subcommands: { write: { summary: 'Write', operands: [{ name: 'path', kind: 'cfsPath', summary: 'Path' }, { name: 'content', kind: 'word', summary: 'Content' }] } } }, 'Files'),
  uploadCommand: standIn_maker('upload', { operands: [{ name: 'source', kind: 'hostPath', summary: 'Source' }, { name: 'destination', kind: 'cfsPath', summary: 'Destination' }] }, 'Files'),
  fileCommand: standIn_maker('file', { operands: PATHS }, 'Files'),
};

/** Each declared command's stand-in maker, by the name its module exports it under. */
export const STAND_IN_MAKERS: Readonly<Record<string, (handler: StandInHandler) => AnyCommandDeclaration>> = {
  lsCommand: lsStandIn_make,
  downloadCommand: downloadStandIn_make,
  berthCommand: berthStandIn_make,
  ...NAVIGATION_STAND_INS,
  ...FILES_STAND_INS,
};

/** The core's stand-ins among them, by the name each module exports; the rest are the ChRIS backend's. */
export const CORE_STAND_IN_NAMES: ReadonlyArray<string> = [
  'cdCommand', 'pwdCommand', 'timingCommand', 'debugCommand', 'urlCommand',
  'catCommand', 'cpCommand', 'mvCommand', 'rmCommand', 'rmdirCommand', 'mkdirCommand', 'touchCommand', 'findCommand',
  'grepCommand', 'wcCommand', 'headCommand', 'tailCommand', 'sortCommand', 'uniqCommand', 'cutCommand',
];
