/**
 * BRASA Runs Abstracted Shell Actions.
 *
 * The hostable ChRIS shell engine (kernel): parsing, dispatch, pipes, builtins,
 * session and output capture, with no terminal I/O of its own. Frontends
 * (the chell CLI, the calypso daemon, future web clients) host this engine and
 * supply their own output sink, surface and renderer implementations.
 *
 * @module
 */

export * from './core/engine.js';
// The typed chell API: the shell's vocabulary as function calls.
export * from './api/index.js';
export * from './core/dispatch.js';
// The ChRIS backend, installed for every consumer of this package: its
// commands registered beside the core's, and its session. The engine's core
// imports none of it.
import { commands_register as chrisCommands_registerInto } from './core/commandRegistry.js';
import { chrisCommands } from './chris/chrisCommands.js';
import { backend_install as chrisBackend_installInto } from './core/backend.js';
import { chrisBackend } from './chris/backend.js';
chrisCommands_registerInto(chrisCommands, 'backend');
chrisBackend_installInto(chrisBackend);
export * from './core/backend.js';
export { chrisBackend } from './chris/backend.js';
export { chiliCommand_run } from './chris/chiliDelegate.js';
export { fileRefusal_name } from './chris/files.js';
export * from './core/preprocess.js';
export * from './core/sink.js';
export * from './core/progress.js';
export * from './core/surface.js';
export * from './chris/promptContext.js';
export * from './core/warmupFailures.js';
export * from './chris/connect.js';
export * from './core/question.js';
export * from './core/elevation.js';
export * from './core/version.js';
export * from './session/index.js';
export * from './builtins/index.js';
export * from './config/storeConfig.js';
export * from './config/indexConfig.js';
export * from './lib/vfs/vfs.js';
export * from './lib/spinner.js';
export * from './logo/brain.js';
export * from './lib/prefetch.js';
export * from './lib/count.js';
export * from './lib/parser.js';
export * from './lib/pipe.js';
export * from './lib/semicolonParser.js';
export * from './lib/completer/index.js';
export { jobsState_derive, type JobsState } from './chris/jobsState.js';
export { universeLayouts_warm, universeLayout_underWay, universeLayoutInput_build, SESSION_GALAXY_NODES_MIN } from './chris/universeLayout.js';
export { procUniverseModel_build } from './builtins/proc.js';
