/**
 * @file The ChRIS backend's commands: everything that speaks CUBE — identity
 * and connection, sharing and attributes, the resources (feeds, plugins,
 * instances, workflows, compute, groups, users, tags), PACS and DICOM, `/proc`,
 * upload and download, and the store.
 *
 * Registered by brasa's package entry (`index.ts`), not by the engine's core:
 * the core dispatches whatever is registered and imports none of this.
 *
 * @module
 */
import { type CommandGroup, type CommandHandler, type EnvelopeHandler, type SessionPiece } from '../core/commandRegistry.js';
import { chrisfetchCommand, pingCommand } from '../builtins/games/chrislab.js';
import { builtin_config, builtin_pipeline, builtin_plugin, builtin_upload } from '../builtins/index.js';
import { chmodCommand, getfaclCommand, setfaclCommand } from '../builtins/fs/acl.js';
import { getfattrCommand, setfattrCommand } from '../builtins/fs/xattr.js';
import { pacsCommand } from '../builtins/net/pacs.js';
import { queryCommand } from '../builtins/net/query.js';
import { pullCommand } from '../builtins/fs/pull.js';
import { dcmCommand } from '../builtins/res/dicom.js';
import { imageCommand } from '../builtins/res/image.js';
import { pacsqueriesCommand, pacsretrieveCommand, pacsserversCommand } from './pacsResources.js';
import { netstatCommand } from '../builtins/net/netstat.js';
import { connectCommand } from '../builtins/net/connect.js';
import { logoutCommand } from '../builtins/net/logout.js';
import { cubepathCommand } from '../builtins/net/cubepath.js';
import { contextCommand } from '../builtins/sys/context.js';
import { physicalmodeCommand } from '../builtins/sys/physicalmode.js';
import { idCommand, whereamiCommand, whoamiCommand } from '../builtins/sys/whoami.js';
import { procCommand } from '../builtins/proc.js';
import { envelopeHandler_wrap } from '../core/sink.js';
import { builtin_file, md5sumCommand, sha256sumCommand, stringsCommand, xxdCommand } from '../builtins/games/bytes.js';
import { duCommand } from '../builtins/fs/du.js';
import { builtin_edit } from '../builtins/fs/edit.js';
import { treeCommand } from '../builtins/fs/tree.js';
import { recordCommand } from '../builtins/res/record.js';
import { gatherCommand } from '../builtins/res/gather.js';
import { userCommand } from '../builtins/res/user.js';
import { motdCommand } from '../builtins/sys/motd.js';
import { chrisHelp } from './help.js';
import { whatifCommand } from './commandFallback.js';
import { berthCommand } from '../builtins/berth/berth.js';
import { downloadCommand } from '../builtins/fs/download.js';
import { feedCommand } from '../builtins/res/feed.js';
import { computeCommand } from '../builtins/res/compute.js';
import { tagCommand } from '../builtins/res/tag.js';
import { groupCommand } from '../builtins/res/group.js';
import { pluginmetaCommand } from '../builtins/res/pluginmeta.js';
import { plugininstanceCommand } from '../builtins/res/plugininstance.js';
import { workflowCommand } from '../builtins/res/workflow.js';
import { dirsCommand, filesCommand, linksCommand } from '../builtins/res/files.js';
import { parametersofpluginCommand } from '../builtins/parametersofplugin.js';
import { storeCommand } from '../builtins/store.js';
import type { AnyCommandDeclaration } from '../core/commandDeclaration.js';

const envelope: Record<string, EnvelopeHandler> = {
  plugin: builtin_plugin,
  plugins: builtin_plugin,
  upload: builtin_upload,
  config: builtin_config,
  pipeline: builtin_pipeline,
  pipelines: builtin_pipeline,
  file: builtin_file,
  edit: builtin_edit,
};

const plain: Record<string, CommandHandler> = {
  upload: envelopeHandler_wrap(builtin_upload),
  pipeline: envelopeHandler_wrap(builtin_pipeline),
  pipelines: envelopeHandler_wrap(builtin_pipeline),
  config: envelopeHandler_wrap(builtin_config),
  plugin: envelopeHandler_wrap(builtin_plugin),
  plugins: envelopeHandler_wrap(builtin_plugin),
  edit: envelopeHandler_wrap(builtin_edit),
  file: envelopeHandler_wrap(builtin_file),
};


/** The ChRIS backend commands: their handlers. Their help is registered from `builtins/help.ts`, which holds it. */
/**
 * What the ChRIS commands hold of the session: a read holds nothing and
 * runs beside anything. A command not named holds the whole session; a
 * declared command says in its declaration (`gather` holds the cohort).
 */
const holds: Record<string, readonly SessionPiece[]> = {
  ...Object.fromEntries([
    'file', 'pipelines', 'plugins',
  ].map((name: string): [string, readonly SessionPiece[]] => [name, []])),
};

/** The ChRIS commands declared in one record each: grammar, kinds, handler, holds and help together. */
const declarations: ReadonlyArray<AnyCommandDeclaration> = [
  downloadCommand, berthCommand,
  netstatCommand, connectCommand, logoutCommand, contextCommand, whoamiCommand, idCommand, whereamiCommand,
  physicalmodeCommand, treeCommand, duCommand, cubepathCommand,
  feedCommand, computeCommand, tagCommand, groupCommand, pluginmetaCommand, plugininstanceCommand,
  workflowCommand, filesCommand, linksCommand, dirsCommand,
  parametersofpluginCommand, storeCommand, whatifCommand,
  setfaclCommand, getfaclCommand, chmodCommand, setfattrCommand, getfattrCommand,
  pacsCommand, queryCommand, pullCommand, pacsserversCommand, pacsqueriesCommand, pacsretrieveCommand,
  dcmCommand, imageCommand,
  // Admin, Monitoring, Workflows and the lab's games, in the order their handlers listed before they were declared.
  pingCommand, chrisfetchCommand, procCommand, gatherCommand, userCommand,
  xxdCommand, stringsCommand, sha256sumCommand, md5sumCommand, motdCommand, recordCommand,
];

export const chrisCommands: CommandGroup = {
  envelope,
  plain,
  help: chrisHelp,
  holds,
  declarations,
};
