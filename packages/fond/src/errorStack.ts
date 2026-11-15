/**
 * @file Process-wide error/message stack for deferred, structured reporting.
 *
 * The stack is a process singleton, but it is *async-context aware*: work run
 * inside {@link ErrorStack.scope_run} pushes to and pops from its own isolated
 * stack rather than the shared one. This lets fire-and-forget background work
 * (cache warming, background refreshes) keep its error traffic off the shared
 * stack, so a foreground command that checkpoints the stack and drains it
 * afterward (see {@link ErrorStack.checkpoint_mark} /
 * {@link ErrorStack.checkpoint_drain}) captures only its own messages and is
 * never corrupted by a background push landing in its drain window.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

type MessageType = "error" | "warning";

/**
 * Represents a single message in the error stack.
 */
export interface StackMessage {
  type: MessageType;
  message: string;
}

/**
 * Options for configuring the ErrorStack.
 */
interface ErrorStackOptions {
  functionNamePadWidth?: number;
}

/**
 * Pads a string to the right with spaces to a specified length.
 * If the string is longer than the length, it is truncated with ellipses.
 *
 * @param str - The string to pad.
 * @param length - The target length.
 * @returns The padded or truncated string.
 */
function str_padRight(str: string, length: number): string {
  if (str.length > length) {
    return str.substring(0, length - 3) + "...";
  }
  return str.padEnd(length);
}

/**
 * Retrieves the name of the function that called the current function.
 * Uses the error stack trace to parse the caller's name.
 *
 * @returns The name of the calling function, or a default string if not found.
 */
function functionName_getCurrent(): string {
  const error: Error = new Error();
  const stack: string[] | undefined = error.stack?.split("\n");

  if (!stack || stack.length < 4) {
    return "Unknown Function";
  }

  const callerLine: string = stack[3];
  const functionNameMatch: RegExpMatchArray | null = callerLine.match(/at\s+([\w\.<>]+)\s*\(/);

  return functionNameMatch ? functionNameMatch[1] : "Anonymous Function";
}

/**
 * Singleton class for managing a stack of error and warning messages.
 * Provides methods to push, pop, search, and filter messages.
 */
class ErrorStack {
  private static instance: ErrorStack;
  private stack: StackMessage[] = [];
  private functionNamePadWidth: number;

  /**
   * Holds the isolated stack for work running inside {@link scope_run}. When
   * a store is present, all operations target it instead of the shared stack.
   */
  private scopeStorage: AsyncLocalStorage<StackMessage[]> = new AsyncLocalStorage<StackMessage[]>();

  private constructor(options: ErrorStackOptions = {}) {
    this.functionNamePadWidth = options.functionNamePadWidth || 45; // Default to 45 if not specified
  }

  /**
   * Returns the stack the current async context should operate on: the
   * isolated stack when inside a {@link scope_run}, otherwise the shared one.
   *
   * @returns The active stack array.
   */
  private stack_active(): StackMessage[] {
    return this.scopeStorage.getStore() ?? this.stack;
  }

  /**
   * Runs a function with an isolated error stack that the shared stack — and
   * any foreground command draining it — never sees. Fire-and-forget
   * background work wraps its body in this so its error traffic cannot land
   * in a concurrent foreground command's drain window. The isolation follows
   * the whole async causal chain started inside `fn`.
   *
   * @param fn - The work to run against a fresh, isolated stack.
   * @returns Whatever `fn` returns.
   */
  public scope_run<T>(fn: () => T): T {
    return this.scopeStorage.run([], fn);
  }

  /**
   * Marks the current depth of the active stack, for a later
   * {@link checkpoint_drain}.
   *
   * @returns An opaque checkpoint (the current stack depth).
   */
  public checkpoint_mark(): number {
    return this.stack_active().length;
  }

  /**
   * Removes and returns every message pushed above a checkpoint, so a command
   * boundary can drain exactly the messages produced since it marked the
   * stack. Messages the command's own code already popped are simply absent.
   *
   * @param checkpoint - A checkpoint from {@link checkpoint_mark}.
   * @returns The drained messages, oldest first.
   */
  public checkpoint_drain(checkpoint: number): StackMessage[] {
    return this.stack_active().splice(checkpoint);
  }

  /**
   * Puts messages on the active stack as they are, without a second caller
   * prefix: what a {@link scope_run} left behind, handed to the stack outside
   * it once that work ends. Work run side by side, each in a scope of its
   * own, drains its own checkpoints without taking another's messages, and
   * what it means the caller to read still reaches the caller.
   *
   * @param messages - Messages taken from another stack, oldest first.
   */
  public stack_restore(messages: readonly StackMessage[]): void {
    this.stack_active().push(...messages.map((message: StackMessage): StackMessage => ({ ...message })));
  }

  /**
   * Get the singleton instance of the ErrorStack.
   *
   * @param options - Optional configuration options for the stack.
   * @returns The singleton ErrorStack instance.
   */
  public static instance_get(options?: ErrorStackOptions): ErrorStack {
    if (!ErrorStack.instance) {
      ErrorStack.instance = new ErrorStack(options);
    }
    return ErrorStack.instance;
  }

  /**
   * Push a new message onto the stack.
   *
   * Captures the calling function name and formats the message.
   *
   * @param type - The type of message ("error" or "warning").
   * @param message - The message string.
   */
  public stack_push(type: MessageType, message: string): void {
    const functionName: string = functionName_getCurrent();
    const paddedFunctionName: string = str_padRight(
      functionName,
      this.functionNamePadWidth
    );
    const enhancedMessage: string = `[${paddedFunctionName}] | ${message}`;
    this.stack_active().push({ type, message: enhancedMessage });
  }

  /**
   * Pop the last message from the stack.
   *
   * @returns The last message object or undefined if the stack is empty.
   */
  public stack_pop(): StackMessage | undefined {
    return this.stack_active().pop();
  }

  /**
   * Search the stack for messages containing a substring.
   *
   * @param substring - The string to search for (case-insensitive).
   * @returns An array of formatted strings matching the search.
   */
  public stack_getAll(): StackMessage[] {
    return [...this.stack_active()];
  }

  public stack_search(substring: string): string[] {
    return this.stack_active()
      .filter((item) =>
        item.message.toLowerCase().includes(substring.toLowerCase())
      )
      .map((item) => `${item.type}: ${item.message}`);
  }

  /**
   * Get all messages of a specific type.
   *
   * @param type - The message type to filter by.
   * @returns An array of message strings.
   */
  public allOfType_get(type: MessageType): string[] {
    return this.stack_active()
      .filter((item) => item.type === type)
      .map((item) => item.message);
  }

  /**
   * Search for messages of a specific type containing a substring.
   *
   * @param type - The message type to filter by.
   * @param substring - The string to search for (case-insensitive).
   * @returns An array of matching message strings.
   */
  public messagesOfType_search(type: MessageType, substring: string): string[] {
    return this.stack_active()
      .filter(
        (item) =>
          item.type === type &&
          item.message.toLowerCase().includes(substring.toLowerCase())
      )
      .map((item) => item.message);
  }

  /**
   * Clear all messages from the stack.
   */
  public stack_clear(): void {
    const active: StackMessage[] = this.stack_active();
    active.length = 0;
  }

  /**
   * Clear all messages of a specific type from the stack.
   *
   * @param type - The message type to clear.
   */
  public type_clear(type: MessageType): void {
    const active: StackMessage[] = this.stack_active();
    const kept: StackMessage[] = active.filter((item) => item.type !== type);
    active.length = 0;
    active.push(...kept);
  }

  /**
   * Check if the stack contains any messages.
   *
   * @returns True if the stack is not empty, false otherwise.
   */
  public messages_has(): boolean {
    return this.stack_active().length > 0;
  }

  /**
   * Check if the stack contains any messages of a specific type.
   *
   * @param type - The message type to check for.
   * @returns True if messages of the given type exist, false otherwise.
   */
  public messagesOfType_has(type: MessageType): boolean {
    return this.stack_active().some((item) => item.type === type);
  }
}

/**
 * The global singleton instance of the ErrorStack.
 */
export const errorStack: ErrorStack = ErrorStack.instance_get({ functionNamePadWidth: 40 });

/**
 * Reconfigures the error stack with new options.
 *
 * @param options - The new configuration options.
 */
export function errorStack_configure(options: ErrorStackOptions): void {
  ErrorStack.instance_get(options);
}

/**
 * Get all messages of a specific type from the global error stack.
 *
 * @param type - The message type to filter by.
 * @returns An array of message strings.
 */
export function errorStack_getAllOfType(type: MessageType): string[] {
  return errorStack.allOfType_get(type);
}
