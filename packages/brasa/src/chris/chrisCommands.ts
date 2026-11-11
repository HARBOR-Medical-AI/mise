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
import { builtin_chmod, builtin_compute, builtin_config, builtin_connect, builtin_context, builtin_cubepath, builtin_dcm, builtin_dirs, builtin_download, builtin_feed, builtin_files, builtin_gather, builtin_getfacl, builtin_getfattr, builtin_group, builtin_id, builtin_image, builtin_links, builtin_logout, builtin_pacs, builtin_parametersofplugin, builtin_physicalmode, builtin_pipeline, builtin_plugin, builtin_plugininstance, builtin_pluginmeta, builtin_pull, builtin_query, builtin_setfacl, builtin_setfattr, builtin_store, builtin_tag, builtin_upload, builtin_user, builtin_whereami, builtin_whoami, builtin_workflow } from '../builtins/index.js';
import { builtin_netstat } from '../builtins/net/netstat.js';
import { builtin_proc } from '../builtins/proc.js';
import { chiliCommand_run } from './chiliDelegate.js';
import { envelopeHandler_wrap } from '../core/sink.js';
import type { CommandEnvelope } from '@fnndsc/menu';
import { builtin_file, builtin_md5sum, builtin_sha256sum, builtin_strings, builtin_xxd } from '../builtins/games/bytes.js';
import { builtin_du } from '../builtins/fs/du.js';
import { builtin_edit } from '../builtins/fs/edit.js';
import { builtin_tree } from '../builtins/fs/tree.js';
import { builtin_record } from '../builtins/res/record.js';
import { builtin_motd } from '../builtins/sys/motd.js';
import { chrisHelp } from './help.js';
import { builtin_whatif } from './commandFallback.js';

const envelope: Record<string, EnvelopeHandler> = {
  setfacl: builtin_setfacl,
  getfacl: builtin_getfacl,
  chmod: builtin_chmod,
  setfattr: builtin_setfattr,
  getfattr: builtin_getfattr,
  netstat: builtin_netstat,
  id: builtin_id,
  whoami: builtin_whoami,
  whereami: builtin_whereami,
  physicalmode: builtin_physicalmode,
  ping: builtin_ping,
  chrisfetch: builtin_chrisfetch,
  proc: builtin_proc,
  logout: builtin_logout,
  cubepath: builtin_cubepath,
  dcm: builtin_dcm,
  image: builtin_image,
  query: builtin_query,
  feed: builtin_feed,
  feeds: builtin_feed,
  compute: builtin_compute,
  computes: builtin_compute,
  tag: builtin_tag,
  tags: builtin_tag,
  gather: builtin_gather,
  group: builtin_group,
  groups: builtin_group,
  user: builtin_user,
  users: builtin_user,
  pluginmeta: builtin_pluginmeta,
  pluginmetas: builtin_pluginmeta,
  meta: builtin_pluginmeta,
  metas: builtin_pluginmeta,
  plugininstance: builtin_plugininstance,
  plugininstances: builtin_plugininstance,
  instance: builtin_plugininstance,
  instances: builtin_plugininstance,
  job: builtin_plugininstance,
  jobs: builtin_plugininstance,
  workflow: builtin_workflow,
  workflows: builtin_workflow,
  files: builtin_files,
  links: builtin_links,
  dirs: builtin_dirs,
  context: builtin_context,
  parametersofplugin: builtin_parametersofplugin,
  plugin: builtin_plugin,
  plugins: builtin_plugin,
  pacsservers: (args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsservers', ['-s', ...args]),
  pacsqueries: (args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsqueries', ['-s', ...args]),
  pacsretrieve: (args: string[]): Promise<CommandEnvelope> => chiliCommand_run('pacsretrieve', ['-s', ...args]),
  connect: builtin_connect,
  upload: builtin_upload,
  download: builtin_download,
  store: builtin_store,
  config: builtin_config,
  pacs: builtin_pacs,
  pull: builtin_pull,
  pipeline: builtin_pipeline,
  whatif: builtin_whatif,
  pipelines: builtin_pipeline,
  file: builtin_file,
  xxd: builtin_xxd,
  strings: builtin_strings,
  sha256sum: builtin_sha256sum,
  md5sum: builtin_md5sum,
  motd: builtin_motd,
  tree: builtin_tree,
  du: builtin_du,
  record: builtin_record,
  edit: builtin_edit,
};

const plain: Record<string, CommandHandler> = {
  connect: envelopeHandler_wrap(builtin_connect),
  logout: envelopeHandler_wrap(builtin_logout),
  netstat: envelopeHandler_wrap(builtin_netstat),
  setfacl: envelopeHandler_wrap(builtin_setfacl),
  getfacl: envelopeHandler_wrap(builtin_getfacl),
  chmod: envelopeHandler_wrap(builtin_chmod),
  setfattr: envelopeHandler_wrap(builtin_setfattr),
  getfattr: envelopeHandler_wrap(builtin_getfattr),
  upload: envelopeHandler_wrap(builtin_upload),
  pacs: envelopeHandler_wrap(builtin_pacs),
  pipeline: envelopeHandler_wrap(builtin_pipeline),
  whatif: envelopeHandler_wrap(builtin_whatif),
  pipelines: envelopeHandler_wrap(builtin_pipeline),
  pull: envelopeHandler_wrap(builtin_pull),
  query: envelopeHandler_wrap(builtin_query),
  cubepath: envelopeHandler_wrap(builtin_cubepath),
  dcm: envelopeHandler_wrap(builtin_dcm),
  image: envelopeHandler_wrap(builtin_image),
  download: envelopeHandler_wrap(builtin_download),
  config: envelopeHandler_wrap(builtin_config),
  context: envelopeHandler_wrap(builtin_context),
  parametersofplugin: envelopeHandler_wrap(builtin_parametersofplugin),
  physicalmode: envelopeHandler_wrap(builtin_physicalmode),
  id: envelopeHandler_wrap(builtin_id),
  whoami: envelopeHandler_wrap(builtin_whoami),
  whereami: envelopeHandler_wrap(builtin_whereami),
  ping: envelopeHandler_wrap(builtin_ping),
  chrisfetch: envelopeHandler_wrap(builtin_chrisfetch),
  proc: envelopeHandler_wrap(builtin_proc),
  store: envelopeHandler_wrap(builtin_store),
  plugin: envelopeHandler_wrap(builtin_plugin),
  plugins: envelopeHandler_wrap(builtin_plugin),
  feed: envelopeHandler_wrap(builtin_feed),
  feeds: envelopeHandler_wrap(builtin_feed),
  compute: envelopeHandler_wrap(builtin_compute),
  computes: envelopeHandler_wrap(builtin_compute),
  tag: envelopeHandler_wrap(builtin_tag),
  tags: envelopeHandler_wrap(builtin_tag),
  gather: envelopeHandler_wrap(builtin_gather),
  group: envelopeHandler_wrap(builtin_group),
  groups: envelopeHandler_wrap(builtin_group),
  pluginmeta: envelopeHandler_wrap(builtin_pluginmeta),
  pluginmetas: envelopeHandler_wrap(builtin_pluginmeta),
  meta: envelopeHandler_wrap(builtin_pluginmeta),
  metas: envelopeHandler_wrap(builtin_pluginmeta),
  plugininstance: envelopeHandler_wrap(builtin_plugininstance),
  plugininstances: envelopeHandler_wrap(builtin_plugininstance),
  instance: envelopeHandler_wrap(builtin_plugininstance),
  instances: envelopeHandler_wrap(builtin_plugininstance),
  job: envelopeHandler_wrap(builtin_plugininstance),
  jobs: envelopeHandler_wrap(builtin_plugininstance),
  workflow: envelopeHandler_wrap(builtin_workflow),
  workflows: envelopeHandler_wrap(builtin_workflow),
  files: envelopeHandler_wrap(builtin_files),
  links: envelopeHandler_wrap(builtin_links),
  dirs: envelopeHandler_wrap(builtin_dirs),
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
  tree: envelopeHandler_wrap(builtin_tree),
  du: envelopeHandler_wrap(builtin_du),
  record: envelopeHandler_wrap(builtin_record),
};


/** The ChRIS backend commands: their handlers. Their help is registered from `builtins/help.ts`, which holds it. */
/**
 * What the ChRIS commands hold of the session: a read holds nothing and
 * runs beside anything; `gather` holds the cohort. A command not named
 * holds the whole session.
 */
const holds: Record<string, readonly SessionPiece[]> = {
  ...Object.fromEntries([
    'du', 'feeds', 'file', 'getfacl', 'getfattr', 'groups', 'id', 'md5sum', 'motd', 'pacsservers',
    'pipelines', 'plugininstances', 'plugins', 'sha256sum', 'strings', 'tree', 'whatif', 'whereami', 'whoami', 'xxd',
  ].map((name: string): [string, readonly SessionPiece[]] => [name, []])),
  gather: ['cohort'],
};

export const chrisCommands: CommandGroup = {
  envelope,
  plain,
  help: chrisHelp,
  holds,
};
