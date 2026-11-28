/**
 * @file Command dispatch for the ChELL shell.
 *
 * Turns one parsed command into an executed command with an envelope result:
 * - the built-in command table and dispatch to built-ins, simulated plugin exec, or `chili`
 * - output capture for the redirect/pipe paths
 * - envelope-producing execution used by the engine facade
 *
 * Line-level orchestration (shell escape, semicolon batching, redirect and
 * pipe detection) lives in `./engine.js`; the startup/connection/REPL glue
 * lives in `./boot.js`.
 *
 * @module
 */
import { commandCancellation_enable, commandCancellation_signalGet } from './cancellation.js';
import { commands_register, commandOrder_set, envelopeHandler_get, plainHandler_get, builtinCommand_has, type CommandHandler, type EnvelopeHandler } from './commandRegistry.js';
import { coreCommands } from './coreCommands.js';
import { ENVELOPE_ORDER, PLAIN_ORDER, HELP_ORDER } from './commandOrder.js';




import { stdinScope_run } from '../builtins/games/stdin.js';
import { listingInScope_run, type ListingModel } from './listing.js';
import { pipeHeadVariable_read, type PipeHeadReading } from './pipeHead.js';

import { writeFileSync, appendFileSync } from 'fs';
import chalk from 'chalk';
import { error_stripDebugPrefix } from './errorText.js';
import { exitCode_read, handler_runDirect, exitCode_set } from './handlerRun.js';
import { backendInstalled_get } from './backend.js';

import {
  help_render,
  helpMissing_render,
  verb_available,
  commandHelp_get,
  args_checkHasHelpFlag,
} from '../builtins/help.js';
import { envelopeHandler_wrap, envelope_deliver, sink_get, PipeCaptureSink, sinkScope_run } from './sink.js';
import { reference_refusal, reference_resolve, unresolvedStands_get, verbInHand_set } from './expansion.js';
import { answer_note, answerConsulted_take, answerRows_derive, type SessionAnswer } from '../session/answer.js';
import {
  shellWords_referencesExpand,
  shellWords_tokenize,
  shellWords_values,
  type ShellArguments,
  type ReferenceExpansion,
  type ShellWord,
} from '../lib/parser.js';
import { surface_get, capability_require } from './surface.js';
import { hostDisk_refusal } from './hostGate.js';
import { sudoCommand_run } from './elevation.js';
import {
  pipeSegment_word,
  redirectTarget_resolve,
  type RedirectInfo,
} from './preprocess.js';
import { envelope_error, type CommandEnvelope } from '@fnndsc/menu';
import { Result, errorStack, Ok, Err, StackMessage } from '@fnndsc/fond';



/**
 * Shape of a converted builtin: returns its outcome as an envelope instead
 * of printing. The engine layer will consume these directly; the dispatch
 * table below consumes them through {@link envelopeHandler_wrap}.
 */

// The engine registers its core commands and the order commands list in; a
// backend registers its own beside them (the ChRIS backend's from brasa's
// entry). Every lookup below goes through the registry.
commands_register(coreCommands);
commandOrder_set({ envelope: ENVELOPE_ORDER, plain: PLAIN_ORDER, help: HELP_ORDER });

export { ENVELOPE_HANDLERS, COMMAND_HANDLERS } from './commandRegistry.js';


/**
 * Prints elapsed time since startTime if timing is enabled.
 *
 * @param startTime - Timestamp from `performance.now()` at command start.
 * @param enabled - Whether timing display is active.
 */
export function command_timingMaybePrint(startTime: number, enabled: boolean): void {
  if (!enabled) return;
  const elapsed: number = performance.now() - startTime;
  sink_get().data_write(`${chalk.gray(`[${elapsed.toFixed(2)}ms]`)}\n`);
}





/**
 * Drains the errorStack from a checkpoint into an envelope's structured
 * `errors` field, and escalates status to `error` when an error-type message
 * was drained.
 *
 * This is the per-command error boundary: it captures exactly the messages a
 * command left on the stack, so a remote surface receives full error detail
 * with each result and stale errors cannot bleed into the next command.
 * Escalating status from a drained error is a reliable per-command failure
 * signal, independent of whether the command happened to change
 * `process.exitCode`.
 *
 * @param checkpoint - A checkpoint from `errorStack.checkpoint_mark()`.
 * @param envelope - The envelope to attach drained errors to.
 * @returns The same envelope, with errors and possibly status updated.
 */
function envelope_drainErrorsInto(checkpoint: number, envelope: CommandEnvelope): CommandEnvelope {
  const drained: StackMessage[] = errorStack.checkpoint_drain(checkpoint);
  if (drained.length > 0) {
    envelope.errors = drained;
    if (envelope.status === 'ok' && drained.some((message: StackMessage): boolean => message.type === 'error')) {
      envelope.status = 'error';
    }
  }
  return envelope;
}

/**
 * Dispatches a parsed command to its handler and returns its envelope, with
 * any errors the command left on the stack drained into the envelope.
 *
 * @param command - The command name.
 * @param args - Parsed arguments.
 * @returns The envelope of the executed command.
 */
export async function command_dispatchEnvelope(command: string, args: string[]): Promise<CommandEnvelope> {
  const checkpoint: number = errorStack.checkpoint_mark();
  const envelope: CommandEnvelope = await commandDispatchEnvelope_run(command, args);
  return envelope_drainErrorsInto(checkpoint, envelope);
}

/**
 * Runs the dispatch itself (without the error drain). Expands environment
 * references in the arguments, then checks the registry's envelope handlers,
 * then its plain handlers, then /bin plugin/pipeline names, then falls
 * back to chili through the capture bridge.
 *
 * Envelope-speaking handlers are delivered through the active sink here, so
 * direct execution prints exactly as it always has; unconverted handlers
 * print for themselves and yield a placeholder envelope.
 *
 * @param command - The command name.
 * @param args - Parsed arguments.
 * @returns The envelope of the executed command.
 */
async function commandDispatchEnvelope_run(command: string, args: string[]): Promise<CommandEnvelope> {
  if (command === 'exit') {
    process.exit(0);
  }

  if (command === 'sudo') {
    // The nested command delivers its own envelope; sudo's own refusals
    // (usage, nesting, no administrator, credentials) are delivered here.
    let nestedRan: boolean = false;
    const envelope: CommandEnvelope = await sudoCommand_run(args, async (nested: string, nestedArgs: string[]): Promise<CommandEnvelope> => {
      nestedRan = true;
      return commandDispatchEnvelope_run(nested, nestedArgs);
    });
    if (!nestedRan) envelope_deliver(envelope);
    return envelope;
  }

  const envelopeHandler: EnvelopeHandler | undefined = envelopeHandler_get(command);
  if (envelopeHandler) {
    // A handler that resolves without an envelope (as stubbed handlers in
    // tests do) is treated as having produced no output.
    const envelope: CommandEnvelope | undefined = await envelopeHandler(args);
    if (!envelope) {
      return { status: 'ok', rendered: '' };
    }
    envelope_deliver(envelope);
    return envelope;
  }

  const handler: CommandHandler | undefined = plainHandler_get(command);
  if (handler) {
    return handler_runDirect(handler, args);
  }

  return unknownCommand_handle(command, args, false);
}

/**
 * Hands a word nothing registered answers to the backend, and says
 * `command not found` when the backend does not know it either.
 *
 * @param command - The word.
 * @param args - Its arguments.
 * @param captured - Whether the line's output is being captured.
 * @returns The delivered envelope.
 */
async function unknownCommand_handle(command: string, args: string[], captured: boolean): Promise<CommandEnvelope> {
  const answered: CommandEnvelope | null = (await backendInstalled_get()?.fallback?.unknown?.(command, args, captured)) ?? null;
  if (answered !== null) return answered;
  const envelope: CommandEnvelope = envelope_error(
    '',
    undefined,
    `${chalk.red(`chell: command not found: ${command}`)}\n`,
  );
  envelope_deliver(envelope);
  return envelope;
}

/**
 * A word the backend claims ahead of the registry (ChRIS: a plugin named
 * with its version).
 *
 * @param command - The word.
 * @param args - Its arguments.
 * @returns The backend's envelope, or null when it does not claim the word.
 */
async function commandClaim_try(command: string, args: string[]): Promise<CommandEnvelope | null> {
  return (await backendInstalled_get()?.fallback?.claim?.(command, args)) ?? null;
}

/**
 * Dispatches a parsed command to its handler.
 *
 * Compatibility shape over {@link command_dispatchEnvelope} for callers that
 * do not consume envelopes.
 *
 * @param command - The command name.
 * @param args - Parsed arguments.
 * @returns A Promise that resolves once the command has been dispatched.
 */
export async function command_dispatch(command: string, args: string[]): Promise<void> {
  await command_dispatchEnvelope(command, args);
}

/**
 * Executes a redirected command (`>` / `>>`): captures the command's output
 * and writes it to the target file.
 *
 * @param redirectInfo - The parsed redirection (command, operator, target).
 * @returns An envelope recording the outcome; rendered text stays empty
 *   because the output went to the file, not the terminal.
 */
export async function redirect_execute(redirectInfo: RedirectInfo): Promise<CommandEnvelope> {
  // `>` writes the engine's own disk. Where that disk is nobody's the line
  // is refused before its command runs, so a refused line did nothing.
  const refused: string | null = hostDisk_refusal(`redirect (${redirectInfo.operator} ${redirectInfo.filePath})`);
  if (refused !== null) {
    sink_get().err_write(`${chalk.red(refused)}\n`);
    exitCode_set(1);
    return { status: 'error', rendered: '' };
  }
  const { buffer, model } = await chellCommand_executeAndCapture(redirectInfo.command);
  // The rows went to a file, but the command still answered with them: an
  // index after `ls > listing.txt` counts them as it would after `ls`.
  if (model !== undefined) {
    answer_note(model.kind, model.data, redirectInfo.command.trim());
  }
  const targetResult: Result<string> = redirectTarget_resolve(redirectInfo.filePath, redirectInfo.command);
  if (!targetResult.ok) {
    const lastError: StackMessage | undefined = errorStack.stack_pop();
    sink_get().err_write(`${chalk.red(lastError ? lastError.message : 'Redirect error')}\n`);
    return { status: 'error', rendered: '' };
  }
  if (redirectInfo.operator === '>') {
    writeFileSync(targetResult.value, buffer);
  } else {
    appendFileSync(targetResult.value, buffer);
  }
  return { status: 'ok', rendered: '' };
}

/**
 * Builds a help envelope for a command if `--help` or `-h` is present in its
 * args, delivering it through the sink so the output reaches the active surface
 * (a remote client over the daemon) rather than the daemon's own terminal.
 *
 * @param command - The command name (used to look up help text).
 * @param args - Parsed argument list.
 * @returns The delivered help envelope, or null if no help flag was present.
 * The promise resolves after dynamic `/bin` pipeline discovery when needed.
 */
async function helpEnvelope_maybe(command: string, args: string[]): Promise<CommandEnvelope | null> {
  if (!args_checkHasHelpFlag(args, command)) {
    return null;
  }
  let rendered: string;
  if (commandHelp_get(command) !== undefined && verb_available(command)) {
    rendered = help_render(command);
  } else {
    const backendHelp: string | null = (await backendInstalled_get()?.fallback?.help?.(command)) ?? null;
    rendered = backendHelp ?? helpMissing_render(command);
  }
  const envelope: CommandEnvelope = { status: 'ok', rendered };
  envelope_deliver(envelope);
  return envelope;
}

/**
 * Resolves the references in a whole command line, the command word included.
 *
 * A shell runs `$CMD arg`, and a manifest names its plugin as a parameter
 * (`@param ANON = pl-pfdicom_tagSub-v3.3.4`) for exactly that reason: the
 * same workflow on another CUBE supplies its own build. Expanding only the
 * arguments left the command word as written, and the line refused with
 * "command not found: ${ANON}".
 *
 * @param words - The line's tokenized words.
 * @returns The words with references resolved, or a refusal naming the one
 *   nothing could answer.
 */
async function commandLine_referencesExpand(words: readonly ShellWord[]): Promise<Result<ShellWord[]>> {
  // The verb is known before its operands expand, so an index can be
  // refused by KIND: IMAGE given a study says so, instead of resolving to
  // a path and failing later for a reason that names nothing typed. A
  // `sudo` line's verb is the one after it.
  const verb: string | undefined = words[0]?.value === 'sudo' ? words[1]?.value : words[0]?.value;
  verbInHand_set(verb ?? null);
  const expanded: ReferenceExpansion = await shellWords_referencesExpand(
    words,
    reference_resolve,
    unresolvedStands_get(),
  );
  verbInHand_set(null);
  if (!expanded.ok) {
    errorStack.stack_push('error', reference_refusal(expanded.missing));
    return Err();
  }
  return Ok(expanded.words);
}

/**
 * A line's words as dispatch hands them on: unglobbed, quoting kept. Every
 * command's line is parsed against its declaration first, a `/bin` line's
 * against the one CUBE's parameters make, and only an operand whose kind
 * expands pathnames has its wildcards matched (core/commandParse.ts), so a
 * glob never turns into an option.
 *
 * @param args - The words after the command, references expanded.
 * @returns The arguments, carrying their words.
 */
function commandWords_carry(args: readonly ShellWord[]): ShellArguments {
  return shellWords_values(args);
}

/**
 * What a captured command produced: its output, and the model it answered
 * with, when it answered with one.
 */
interface CapturedOutput {
  text: string;
  buffer: Buffer;
  model?: CommandEnvelope['model'];
}

/**
 * Executes a chell command and captures its output.
 * Consults the command registry — the single source of truth — so the pipe path
 * is always consistent with the direct-execution path.
 *
 * @param commandLine - The command line to execute.
 * @returns The captured output as text and raw buffer.
 */
async function chellCommand_executeAndCapture(commandLine: string): Promise<CapturedOutput> {
  const trimmedLine: string = commandLine.trim();
  if (!trimmedLine) return { text: '', buffer: Buffer.alloc(0) };

  const tokenized: ShellWord[] = shellWords_tokenize(trimmedLine);
  if (tokenized.length === 0) {
    return { text: '', buffer: Buffer.alloc(0) };
  }
  const referenced: Result<ShellWord[]> = await commandLine_referencesExpand(tokenized);
  if (!referenced.ok) {
    const lastError: StackMessage | undefined = errorStack.stack_pop();
    const message: string = lastError === undefined
      ? 'unresolved reference'
      : error_stripDebugPrefix(lastError.message);
    return { text: chalk.red(`${message}\n`), buffer: Buffer.from('') };
  }
  const words: ShellWord[] = referenced.value;
  const [commandWord, ...argumentWords]: ShellWord[] = words;
  const command: string = commandWord.value;

  const args: ShellArguments = commandWords_carry(argumentWords);

  if (command === 'exit') {
    process.exit(0);
  }

  // The command runs with its output captured into a pipe sink scoped to this
  // async context — no console monkeypatch. Envelope handlers deliver their
  // rendered text through the sink (ANSI-stripped for the plain-pipe contract);
  // streaming commands and binary cat write to the same sink directly (raw
  // bytes kept byte-for-byte). The err channel passes through to stderr live.
  const pipeSink: PipeCaptureSink = new PipeCaptureSink(sink_get());
  let model: CommandEnvelope['model'];
  await sinkScope_run(pipeSink, async (): Promise<void> => {
    const helpEnvelope: CommandEnvelope | null = await helpEnvelope_maybe(command, args);
    if (helpEnvelope) return;

    const envelopeHandler: EnvelopeHandler | undefined = envelopeHandler_get(command);
    if (envelopeHandler) {
      const envelope: CommandEnvelope | undefined = await envelopeHandler(args);
      if (envelope) {
        envelope_deliver(envelope);
        model = envelope.model;
      }
      return;
    }

    const claimed: CommandEnvelope | null = await commandClaim_try(command, args);
    if (claimed) {
      envelope_deliver(claimed);
      model = claimed.model;
      return;
    }

    const handler: CommandHandler | undefined = plainHandler_get(command);
    if (handler) {
      await handler(args);
      return;
    }

    const answered: CommandEnvelope = await unknownCommand_handle(command, args, true);
    model = answered.model;
  });

  const buffer: Buffer = pipeSink.buffer_get();
  return { text: buffer.toString('utf-8'), buffer, ...(model !== undefined ? { model } : {}) };
}

/**
 * Whether a model is a numbered listing (its kind has rows to number).
 *
 * @param model - An envelope's model.
 * @returns True for a listing.
 */
function listing_is(model: CommandEnvelope['model']): model is NonNullable<CommandEnvelope['model']> {
  return model !== undefined && answerRows_derive(model.kind, model.data) !== null;
}

/**
 * Executes a pipe chain by running the first command in chell and piping
 * through local tools, delivering the final output on the data channel.
 *
 * @param segments - Array of command segments separated by pipes.
 * @returns An envelope whose rendered text is the chain's final output.
 */
export async function pipe_execute(segments: string[]): Promise<CommandEnvelope> {
  if (segments.length === 0) {
    return { status: 'ok', rendered: '' };
  }

  // The first segment is a chell command run in-engine. A later segment
  // that names a builtin runs in-engine too, reading what came before it
  // (`fortune | cowsay` is the kernel's own, in a browser as in a terminal);
  // any other goes through the surface's host shell, so nothing spawns on a
  // daemon host — a surface without the capability (a browser) fails that
  // segment with a clear message.
  const firstCommand: string = segments[0];
  // A variable heading the pipe hands on what it holds, model and all.
  const head: PipeHeadReading = pipeHeadVariable_read(firstCommand);
  if (head !== null && 'refused' in head) {
    sink_get().err_write(`${chalk.red(head.refused)}\n`);
    exitCode_set(1);
    return { status: 'error', rendered: '' };
  }
  const first: CapturedOutput = head !== null ? head.output : await chellCommand_executeAndCapture(firstCommand);

  // Between builtins a numbered listing travels beside the text (#1103):
  // `query … | gather add` hands over rows. An operating-system segment
  // gets the text alone, and what comes after it has no listing.
  let currentInput: Buffer = first.buffer;
  let currentModel: CommandEnvelope['model'] = first.model;
  // The last listing the chain produced becomes the held one, so its
  // handles are what `@SER3` names after the line.
  let lastListing: CommandEnvelope['model'] = listing_is(first.model) ? first.model : undefined;
  for (let i: number = 1; i < segments.length; i++) {
    const segment: string = segments[i];
    const word: string = pipeSegment_word(segment);
    if (word !== '' && builtinCommand_has(word)) {
      // The segment reads its input from slots of its own, so a line that
      // runs beside this one never takes this pipe's text or listing (#1273).
      const captured: CapturedOutput = await stdinScope_run(currentInput.toString('utf-8'), async (): Promise<CapturedOutput> =>
        await listingInScope_run(listing_is(currentModel) ? currentModel as ListingModel : null, async (): Promise<CapturedOutput> =>
          await chellCommand_executeAndCapture(segment)));
      currentInput = captured.buffer;
      currentModel = captured.model;
      if (listing_is(captured.model)) lastListing = captured.model;
      continue;
    }
    capability_require('pipeSegments', 'this surface cannot run pipeline segments');
    // A segment run as a process is cancellable: Ctrl-C (or STOP) kills it.
    commandCancellation_enable();
    currentInput = await surface_get().pipeSegment(segment, currentInput, commandCancellation_signalGet());
    currentModel = undefined;
  }

  if (lastListing !== undefined) answer_note(lastListing.kind, lastListing.data, segments.map((one: string): string => one.trim()).join(' | '));
  // Output final result
  sink_get().data_write(currentInput);
  // The chain's final listing reaches the surface too, so its pills follow.
  return { status: 'ok', rendered: currentInput.toString('utf-8'), ...(currentModel !== undefined ? { model: currentModel } : {}) };
}

/**
 * Executes one plain command line (no shell escape, batch, redirect or pipe)
 * and returns its envelope.
 *
 * Mirrors the historical direct-execution order exactly: help flag
 * short-circuit, wildcard expansion, simulated plugin execution, then table
 * dispatch. Timing is printed at the same points the shell always printed
 * it (after plugin execution or dispatch; never after help or a wildcard
 * failure).
 *
 * @param trimmedLine - The trimmed command line.
 * @param startTime - Timing reference from `performance.now()`.
 * @param timingEnabled - Whether to print elapsed time after execution.
 * @returns The command's envelope, or null when the line held no tokens.
 */
export async function command_executeToEnvelope(
  trimmedLine: string,
  startTime: number,
  timingEnabled: boolean,
): Promise<CommandEnvelope | null> {
  const tokenized: ShellWord[] = shellWords_tokenize(trimmedLine);
  if (tokenized.length === 0) return null;
  const referenced: Result<ShellWord[]> = await commandLine_referencesExpand(tokenized);
  if (!referenced.ok) {
    const lastError: StackMessage | undefined = errorStack.stack_pop();
    // The refusal is the operator's to read, not the stack's: the debug
    // prefix names the function that pushed it, which tells them nothing.
    if (lastError) sink_get().err_write(`${chalk.red(error_stripDebugPrefix(lastError.message))}\n`);
    exitCode_set(1);
    return { status: 'error', rendered: '' };
  }
  const words: ShellWord[] = referenced.value;
  // A line that acted on a number says which listing it counted: the rule
  // that a readout which acts says so, applied to the rows it acted on.
  const counted: SessionAnswer | null = answerConsulted_take();
  if (counted !== null) {
    sink_get().data_write(chalk.gray(`  from: ${counted.source} · ${counted.rows.length} rows\n`));
  }
  const [commandWord, ...argumentWords]: ShellWord[] = words;
  const command: string = commandWord.value;
  const args: ShellArguments = commandWords_carry(argumentWords);

  // Help travels through the same expanded-word path as a pipe's first
  // ChELL segment, ensuring that structural execution forms agree.
  const helpEnvelope: CommandEnvelope | null = await helpEnvelope_maybe(command, args);
  if (helpEnvelope) return helpEnvelope;

  // Attempt to handle as a simulated plugin execution. This path bypasses
  // command_dispatchEnvelope, so it drains the errorStack itself.
  const checkpoint: number = errorStack.checkpoint_mark();
  const exitCodeBefore: number = exitCode_read();
  const pluginEnvelope: CommandEnvelope | null = await commandClaim_try(command, args);
  if (pluginEnvelope) {
    envelope_deliver(pluginEnvelope);
    command_timingMaybePrint(startTime, timingEnabled);
    const exitCodeAfter: number = exitCode_read();
    const failed: boolean = exitCodeAfter !== 0 && exitCodeAfter !== exitCodeBefore;
    const result: CommandEnvelope = failed
      ? { ...pluginEnvelope, status: 'error' }
      : pluginEnvelope;
    if (result.model !== undefined) {
      answer_note(result.model.kind, result.model.data, trimmedLine);
    }
    return envelope_drainErrorsInto(checkpoint, result);
  }

  const envelope: CommandEnvelope = await command_dispatchEnvelope(command, args);
  command_timingMaybePrint(startTime, timingEnabled);
  // An answer with rows becomes the thing `@3` counts. Recorded from the
  // MODEL, not from the rendering, so a console table and a graphical pane
  // number the same rows — an index that meant different things on
  // different surfaces would be worse than no index at all.
  if (envelope.model !== undefined) {
    answer_note(envelope.model.kind, envelope.model.data, trimmedLine);
  }
  return envelope;
}
