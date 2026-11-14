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
import { type CommandGroup } from '../core/commandRegistry.js';
import { chrisfetchCommand, pingCommand } from '../builtins/games/chrislab.js';
import { pluginCommand } from '../builtins/res/plugin.js';
import { pipelineCommand } from '../builtins/res/pipeline.js';
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
import { fileCommand, md5sumCommand, sha256sumCommand, stringsCommand, xxdCommand } from '../builtins/games/bytes.js';
import { duCommand } from '../builtins/fs/du.js';
import { editCommand } from '../builtins/fs/edit.js';
import { uploadCommand } from '../builtins/fs/upload.js';
import { configCommand } from '../builtins/fs/configWrite.js';
import { treeCommand } from '../builtins/fs/tree.js';
import { recordCommand } from '../builtins/res/record.js';
import { gatherCommand } from '../builtins/res/gather.js';
import { userCommand } from '../builtins/res/user.js';
import { motdCommand } from '../builtins/sys/motd.js';
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
  // Files.
  editCommand, configCommand, uploadCommand, fileCommand,
  // Resources.
  pluginCommand, pipelineCommand,
];

/** The ChRIS backend's commands, every one declared in one record. */
export const chrisCommands: CommandGroup = {
  declarations,
};
