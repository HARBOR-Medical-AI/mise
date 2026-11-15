import { errorStack, errorStack_configure } from '../src/errorStack';

// Remove the mock for getCurrentFunctionName and allow the actual function to run.
// We will adjust expectations to match the dynamic output.

describe('ErrorStack', () => {
  beforeEach(() => {
    errorStack.stack_clear(); // Clear stack before each test
  });

  it('should be a singleton', () => {
    const instance1 = errorStack;
    errorStack_configure({}); // Call the configure function
    const instance2 = errorStack; // Get the instance again after potential re-configuration
    expect(instance1).toBe(instance2);
  });

  it('should push messages with dynamic function name', () => {
    errorStack.stack_push('error', 'Test error message');
    const allMessages = errorStack.stack_getAll();
    expect(allMessages).toHaveLength(1);
    expect(allMessages[0].type).toBe('error');
    // Expect the message to contain the dynamic function name format
    expect(allMessages[0].message).toMatch(/\[.*\] \| Test error message/);
  });

  it('should pop messages', () => {
    errorStack.stack_push('error', 'Message to pop');
    const popped = errorStack.stack_pop();
    expect(popped?.message).toContain('Message to pop');
    expect(errorStack.stack_getAll()).toHaveLength(0);
  });

  it('should return undefined when popping from an empty stack', () => {
    const popped = errorStack.stack_pop();
    expect(popped).toBeUndefined();
  });

  it('should search messages by substring (case-insensitive)', () => {
    errorStack.stack_push('error', 'This is a test message');
    errorStack.stack_push('warning', 'Another message');
    const results = errorStack.stack_search('TEST');
    expect(results).toHaveLength(1);
    // Expect the message to contain the dynamic function name format
    expect(results[0]).toMatch(/error: \[.*\] \| This is a test message/);
  });

  it('should get all messages of a specific type', () => {
    errorStack.stack_push('error', 'Error 1');
    errorStack.stack_push('warning', 'Warning 1');
    errorStack.stack_push('error', 'Error 2');
    
    const errors = errorStack.allOfType_get('error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Error 1');
    expect(errors[1]).toContain('Error 2');
  });

  it('should clear all messages', () => {
    errorStack.stack_push('error', 'Error');
    errorStack.stack_clear();
    expect(errorStack.stack_getAll()).toHaveLength(0);
  });

  it('should clear messages of a specific type', () => {
    errorStack.stack_push('error', 'Error 1');
    errorStack.stack_push('warning', 'Warning 1');
    errorStack.stack_push('error', 'Error 2');
    errorStack.type_clear('error');
    
    expect(errorStack.allOfType_get('error')).toHaveLength(0);
    expect(errorStack.allOfType_get('warning')).toHaveLength(1);
  });

  it('should check for existence of messages', () => {
    expect(errorStack.messages_has()).toBe(false);
    errorStack.stack_push('error', 'An error');
    expect(errorStack.messages_has()).toBe(true);
  });

  it('should check for existence of messages of a specific type', () => {
    errorStack.stack_push('error', 'An error');
    expect(errorStack.messagesOfType_has('error')).toBe(true);
    expect(errorStack.messagesOfType_has('warning')).toBe(false);
  });

  it('should configure function name padding width', () => {
    // Simply check that calling it doesn't throw and allows pushing messages
    errorStack_configure({ functionNamePadWidth: 10 });
    errorStack.stack_push('error', 'Test config with short width');
    const messages1 = errorStack.stack_getAll();
    expect(messages1.length).toBeGreaterThan(0);

    errorStack_configure({ functionNamePadWidth: 50 });
    errorStack.stack_push('error', 'Test config with large width');
    const messages2 = errorStack.stack_getAll();
    expect(messages2.length).toBeGreaterThan(messages1.length);
  });

  describe('checkpoint and drain', () => {
    it('drains only messages pushed since the checkpoint', () => {
      errorStack.stack_push('error', 'before checkpoint');
      const checkpoint: number = errorStack.checkpoint_mark();
      errorStack.stack_push('error', 'command error one');
      errorStack.stack_push('warning', 'command warning');
      const drained = errorStack.checkpoint_drain(checkpoint);
      expect(drained).toHaveLength(2);
      expect(drained[0].message).toContain('command error one');
      expect(drained[1].message).toContain('command warning');
      // The pre-checkpoint message survives; the drained ones are gone.
      const remaining = errorStack.stack_getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].message).toContain('before checkpoint');
    });

    it('drains empty when nothing was pushed since the checkpoint', () => {
      errorStack.stack_push('error', 'pre-existing');
      const checkpoint: number = errorStack.checkpoint_mark();
      expect(errorStack.checkpoint_drain(checkpoint)).toEqual([]);
    });
  });

  describe('stack_restore', () => {
    it('hands a scope\'s leftovers to the stack outside it, as they were', () => {
      const left = errorStack.scope_run(() => {
        errorStack.stack_push('warning', 'landed under another name');
        return errorStack.checkpoint_drain(0);
      });
      expect(errorStack.stack_getAll()).toHaveLength(0);
      errorStack.stack_restore(left);
      const restored = errorStack.stack_getAll();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toEqual(left[0]);
      // One caller prefix, not a second one for the restore.
      expect(restored[0].message.match(/\|/g)).toHaveLength(1);
    });
  });

  describe('scope_run isolation (background fencing)', () => {
    it('keeps scoped pushes off the shared stack', () => {
      errorStack.scope_run(() => {
        errorStack.stack_push('error', 'background-only message');
        expect(errorStack.stack_getAll()).toHaveLength(1);
      });
      // Nothing from the scope reached the shared stack.
      expect(errorStack.stack_getAll()).toHaveLength(0);
    });

    it('a background push interleaved in a foreground drain window does not corrupt the drain', async () => {
      // Reproduction of the hazard: a foreground command marks the stack and
      // awaits; a fire-and-forget background task (in its own scope) pushes an
      // error during that await. Without the scope the background message would
      // land above the checkpoint and be misattributed to the command; with it,
      // the drain sees only the command's own message.
      const checkpoint: number = errorStack.checkpoint_mark();

      // Fire-and-forget background work, fenced in its own scope.
      const background: Promise<void> = errorStack.scope_run(async () => {
        await Promise.resolve();
        errorStack.stack_push('error', 'background refresh failed');
      });

      // Foreground command runs across an await, then pushes its own error.
      await Promise.resolve();
      errorStack.stack_push('error', 'foreground command failed');
      await background;

      const drained = errorStack.checkpoint_drain(checkpoint);
      expect(drained).toHaveLength(1);
      expect(drained[0].message).toContain('foreground command failed');
      expect(drained.some((m) => m.message.includes('background refresh failed'))).toBe(false);
    });
  });
});