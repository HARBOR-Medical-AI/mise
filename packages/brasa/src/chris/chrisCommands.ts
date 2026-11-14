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
import { builtin_chmod, builtin_config, builtin_dcm, builtin_gather, builtin_getfacl, builtin_getfattr, builtin_image, builtin_pacs, builtin_pipeline, builtin_plugin, builtin_pull, builtin_query, builtin_setfacl, builtin_setfattr, builtin_upload, builtin_user } from '../builtins/index.js';
import { netstatCommand } from '../builtins/net/netstat.js';
import { connectCommand } from '../builtins/net/connect.js';
import { logoutCommand } from '../builtins/net/logout.js';
import { cubepathCommand } from '../builtins/net/cubepath.js';
import { contextCommand } from '../builtins/sys/context.js';
import { physicalmodeCommand } from '../builtins/sys/physicalmode.js';
import { idCommand, whereamiCommand, whoamiCommand } from '../builtins/sys/whoami.js';
import { builtin_proc } from '../builtins/proc.js';
import { chiliCommand_run } from './chiliDelegate.js';
import { envelopeHandler_wrap } from '../core/sink.js';
import type { CommandEnvelope } from '@fnndsc/menu';
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
  setfacl: builtin_setfacl,
  getfacl: builtin_getfacl,
  chmod: builtin_chmod,
  setfattr: builtin_setfattr,
  getfattr: builtin_getfattr,
  ping: builtin_ping,
  chrisfetch: builtin_chrisfetch,
  proc: builtin_proc,
  dcm: builtin_dcm,
  image: builtin_image,
  query: builtin_query,
  gather: builtin_gather,
  user: builtin_user,
  users: builtin_user,
  plugin: builtin_plugin,
  plugins: builtin_plugin,
  pacsservers: (args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsservers', ['-s', ...args]),
  pacsqueries: (args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsqueries', ['-s', ...args]),
  pacsretrieve: (args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsretrieve', ['-s', ...args]),
  upload: builtin_upload,
  config: builtin_config,
  pacs: builtin_pacs,
  pull: builtin_pull,
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
  setfacl:envelopeHandler_wrap(builtin_setfacl),
  getfacl: envelopeHandler_wrap(builtin_getfacl),
  chmod: envelopeHandler_wrap(builtin_chmod),
  setfattr: envelopeHandler_wrap(builtin_setfattr),
  getfattr: envelopeHandler_wrap(builtin_getfattr),
  upload: envelopeHandler_wrap(builtin_upload),
  pacs: envelopeHandler_wrap(builtin_pacs),
  pipeline: envelopeHandler_wrap(builtin_pipeline),
  pipelines: envelopeHandler_wrap(builtin_pipeline),
  pull: envelopeHandler_wrap(builtin_pull),
  query: envelopeHandler_wrap(builtin_query),
  dcm:envelopeHandler_wrap(builtin_dcm),
  image: envelopeHandler_wrap(builtin_image),
  config: envelopeHandler_wrap(builtin_config),
  ping: envelopeHandler_wrap(builtin_ping),
  chrisfetch: envelopeHandler_wrap(builtin_chrisfetch),
  proc: envelopeHandler_wrap(builtin_proc),
  plugin: envelopeHandler_wrap(builtin_plugin),
  plugins: envelopeHandler_wrap(builtin_plugin),
  gather: envelopeHandler_wrap(builtin_gather),
  pacsservers: envelopeHandler_wrap((args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsservers', ['-s', ...args])),
  pacsqueries: envelopeHandler_wrap((args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsqueries', ['-s', ...args])),
  pacsretrieve: envelopeHandler_wrap((args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsretrieve', ['-s', ...args])),
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
    'file', 'getfacl', 'getfattr', 'md5sum', 'motd', 'pacsservers', 'pipelines', 'plugins',
    'sha256sum', 'strings', 'xxd',
    // Reading a series' listing and header, or a file's tags, changes nothing
    // of the session: `image` answers with an intent a surface draws, `dcm`
    // with a model.
    'dcm', 'image',
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
];

export const chrisCommands: CommandGroup = {
  envelope,
  plain,
  help: chrisHelp,
  holds,
  declarations,
};
