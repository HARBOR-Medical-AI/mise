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
import { builtin_chrisfetch, builtin_ping } from '../builtins/games/chrislab.js';
import { builtin_config, builtin_gather, builtin_pipeline, builtin_plugin, builtin_upload, builtin_user } from '../builtins/index.js';
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
import { builtin_proc } from '../builtins/proc.js';
import { envelopeHandler_wrap } from '../core/sink.js';
import { builtin_file, builtin_md5sum, builtin_sha256sum, builtin_strings, builtin_xxd } from '../builtins/games/bytes.js';
import { duCommand } from '../builtins/fs/du.js';
import { builtin_edit } from '../builtins/fs/edit.js';
import { treeCommand } from '../builtins/fs/tree.js';
import { builtin_record } from '../builtins/res/record.js';
import { builtin_motd } from '../builtins/sys/motd.js';
import { chrisHelp } from './help.js';
import { whatifCommand } from './commandFallback.js';
import { berthCommand } from '../builtins/berth/berth.js';
import { downloadCommand } from '../builtins/fs/download.js';
import { feedCommand, feedsCommand } from '../builtins/res/feed.js';
import { computeCommand, computesCommand } from '../builtins/res/compute.js';
import { tagCommand, tagsCommand } from '../builtins/res/tag.js';
import { groupCommand, groupsCommand } from '../builtins/res/group.js';
import { metaCommand, metasCommand, pluginmetaCommand, pluginmetasCommand } from '../builtins/res/pluginmeta.js';
import { instanceCommand, instancesCommand, jobCommand, jobsCommand, plugininstanceCommand, plugininstancesCommand } from '../builtins/res/plugininstance.js';
import { workflowCommand, workflowsCommand } from '../builtins/res/workflow.js';
import { dirsCommand, filesCommand, linksCommand } from '../builtins/res/files.js';
import { parametersofpluginCommand } from '../builtins/parametersofplugin.js';
import { storeCommand } from '../builtins/store.js';
import type { AnyCommandDeclaration } from '../core/commandDeclaration.js';

const envelope: Record<string, EnvelopeHandler> = {
  ping: builtin_ping,
  chrisfetch: builtin_chrisfetch,
  proc: builtin_proc,
  gather: builtin_gather,
  user: builtin_user,
  users: builtin_user,
  plugin: builtin_plugin,
  plugins: builtin_plugin,
  upload: builtin_upload,
  config: builtin_config,
  pipeline: builtin_pipeline,
  pipelines: builtin_pipeline,
  file: builtin_file,
  xxd: builtin_xxd,
  strings: builtin_strings,
  sha256sum: builtin_sha256sum,
  md5sum: builtin_md5sum,
  motd: builtin_motd,
  record: builtin_record,
  edit: builtin_edit,
};

const plain: Record<string, CommandHandler> = {
  upload: envelopeHandler_wrap(builtin_upload),
  pipeline: envelopeHandler_wrap(builtin_pipeline),
  pipelines: envelopeHandler_wrap(builtin_pipeline),
  config: envelopeHandler_wrap(builtin_config),
  ping: envelopeHandler_wrap(builtin_ping),
  chrisfetch: envelopeHandler_wrap(builtin_chrisfetch),
  proc: envelopeHandler_wrap(builtin_proc),
  plugin: envelopeHandler_wrap(builtin_plugin),
  plugins: envelopeHandler_wrap(builtin_plugin),
  gather: envelopeHandler_wrap(builtin_gather),
  edit: envelopeHandler_wrap(builtin_edit),
  file: envelopeHandler_wrap(builtin_file),
  xxd: envelopeHandler_wrap(builtin_xxd),
  strings: envelopeHandler_wrap(builtin_strings),
  sha256sum: envelopeHandler_wrap(builtin_sha256sum),
  md5sum: envelopeHandler_wrap(builtin_md5sum),
  motd: envelopeHandler_wrap(builtin_motd),
  record:envelopeHandler_wrap(builtin_record),
};


/** The ChRIS backend commands: their handlers. Their help is registered from `builtins/help.ts`, which holds it. */
/**
 * What the ChRIS commands hold of the session: a read holds nothing and
 * runs beside anything; `gather` holds the cohort. A command not named
 * holds the whole session.
 */
const holds: Record<string, readonly SessionPiece[]> = {
  ...Object.fromEntries([
    'file', 'md5sum', 'motd', 'pipelines', 'plugins',
    'sha256sum', 'strings', 'xxd',
  ].map((name: string): [string, readonly SessionPiece[]] => [name, []])),
  gather: ['cohort'],
};

/** The ChRIS commands declared in one record each: grammar, kinds, handler, holds and help together. */
const declarations: ReadonlyArray<AnyCommandDeclaration> = [
  downloadCommand, berthCommand,
  netstatCommand, connectCommand, logoutCommand, contextCommand, whoamiCommand, idCommand, whereamiCommand,
  physicalmodeCommand, treeCommand, duCommand, cubepathCommand,
  feedCommand, feedsCommand, computeCommand, computesCommand, tagCommand, tagsCommand, groupCommand, groupsCommand,
  pluginmetaCommand, pluginmetasCommand, metaCommand, metasCommand,
  plugininstanceCommand, plugininstancesCommand, instanceCommand, instancesCommand, jobCommand, jobsCommand,
  workflowCommand, workflowsCommand, filesCommand, linksCommand, dirsCommand,
  parametersofpluginCommand, storeCommand, whatifCommand,
  setfaclCommand, getfaclCommand, chmodCommand, setfattrCommand, getfattrCommand,
  pacsCommand, queryCommand, pullCommand, pacsserversCommand, pacsqueriesCommand, pacsretrieveCommand,
  dcmCommand, imageCommand,
];

export const chrisCommands: CommandGroup = {
  envelope,
  plain,
  help: chrisHelp,
  holds,
  declarations,
};
