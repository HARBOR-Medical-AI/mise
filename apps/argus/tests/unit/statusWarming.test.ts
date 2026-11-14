/**
 * @jest-environment jsdom
 */
/**
 * @file The status strip's warm-up readout: `WARMING PUBLIC QUERIES` while
 * the session still warms behind the prompt, gone once those steps settle.
 */
import { describe, it, expect } from '@jest/globals';
import type { PromptContext } from '@fnndsc/menu';
import { StatusBar } from '../../src/app/status.js';

/** A page holding the strip's fields. */
function page_make(): Document {
  document.body.innerHTML = ['identity', 'jobs', 'activity', 'latency', 'mismatch', 'lamp', 'host', 'questions']
    .map((name: string): string => `<span id="status-${name}" class="readout"></span>`).join('');
  return document;
}

/** A prompt context with nothing moving, plus what the test names. */
function context_make(extra: Partial<PromptContext> = {}): PromptContext {
  return { user: 'chris', uri: 'https://cube.example.org/api/v1/', cwd: '/', pacsserver: null, physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0, ...extra };
}

describe('StatusBar warm-up', () => {
  it('names the steps still warming, and says nothing once they settle', () => {
    const bar: StatusBar = new StatusBar(page_make());
    const field: HTMLElement = document.getElementById('status-jobs') as HTMLElement;
    bar.promptContext_show(context_make({ warmupPending: ['Public', 'Queries'] }));
    expect(field.textContent).toBe('WARMING PUBLIC QUERIES');
    expect(field.title).toContain('The session answers while these warm');
    bar.promptContext_show(context_make());
    expect(field.textContent).toBe('');
    expect(field.title).toBe('');
  });
});
