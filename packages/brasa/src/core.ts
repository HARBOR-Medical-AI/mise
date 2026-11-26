/**
 * @file `@fnndsc/brasa/core`: the engine with no backend installed.
 *
 * The package root installs ChRIS for every consumer. This entry installs
 * nothing: a host hands `engine_create` the backend its session runs over
 * (the null backend here, or its own), and none of the ChRIS packages load
 * unless that backend loads them.
 *
 * @module
 */
export * from './core/engine.js';
export * from './core/dispatch.js';
export * from './core/backend.js';
export * from './core/sink.js';
export * from './core/surface.js';
export { manifestText_read, type DiskRead, type ManifestRead } from './builtins/res/manifestRead.js';
export * from './core/question.js';
export * from './core/progress.js';
export * from './core/commandRegistry.js';
export * from './core/commandDeclaration.js';
export { commandLine_parse, declaredCommand_run, lineWords_read, type LineParse, type ParsedArguments } from './core/commandParse.js';
export { argumentKind_get, candidates_filter, namedKind_make, type ArgumentCheck, type ArgumentKind } from './core/argumentKinds.js';
export { commandTools_derive, type CommandTool } from './core/commandSchema.js';
export type { ShellWordDeclaration } from './core/shellWords.js';
export * from './core/tasks.js';
export * from './core/runner.js';
export * from './core/version.js';
export * from './logo/brain.js';
export { nullBackend_make, type NullBackendOptions } from './null/backend.js';
export { commandCancellation_enable, commandCancellation_signalGet, commandCancellation_stopped } from './core/cancellation.js';
