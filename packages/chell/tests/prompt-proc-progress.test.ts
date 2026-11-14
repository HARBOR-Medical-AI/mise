/**
 * @file Prompt rendering tests for deterministic `/proc` warm-up progress.
 *
 * @module
 */
import { describe, expect, it } from '@jest/globals';
import { prompt_render, type PromptContext } from '../src/core/prompt/index.js';

function promptContext_createWithProgress(loaded: number, total: number): PromptContext {
  return {
    user: 'chris',
    uri: 'https://cube.example.org/api/v1/',
    cwd: '/proc/jobs',
    pacsserver: null,
    physicalMode: false,
    terminalWidth: 160,
    lastExitCode: 0,
    lastCommandDurationMs: 0,
    p10kSegments: { pacs: false, time: false, duration: false, status: false },
    procWarmup: { loaded, total },
  };
}

describe('prompt /proc progress', () => {
  it('renders loaded, total, and percentage in the default prompt', () => {
    const rendered: string = prompt_render('default', promptContext_createWithProgress(25, 100));
    expect(rendered).toContain('proc cold: 25/100 25%');
  });

  it('renders the same progress semantics in the p10k prompt', () => {
    const rendered: string = prompt_render('p10k', promptContext_createWithProgress(25, 100));
    expect(rendered).toContain('proc cold: 25/100 25%');
  });

  it('does not show 100% while warm-up remains active', () => {
    const rendered: string = prompt_render('default', promptContext_createWithProgress(100, 100));
    expect(rendered).toContain('proc cold: 100/100 99%');
  });

  it('says which feed is indexing on a first visit, in both themes', () => {
    const ctx: PromptContext = promptContext_createWithProgress(0, 0);
    ctx.procWarmup = { loaded: 0, sweeping: false, feed: { id: 812, loaded: 3400, total: 20000 } };
    const plain: string = prompt_render('default', ctx);
    expect(plain).toContain('feed 812 indexing: 3400/20000 17%');
    expect(plain).not.toContain('proc cold');
    const p10k: string = prompt_render('p10k', ctx);
    expect(p10k).toContain('feed 812: 3400/20000 17%');
    expect(p10k).not.toContain('proc cold');
  });

  it('annunciates roster arrivals by id when few and by count when many', () => {
    const ctx: PromptContext = promptContext_createWithProgress(0, 0);
    ctx.procWarmup = { loaded: 0, sweeping: false, arrived: [812] };
    expect(prompt_render('default', ctx)).toContain('[+feed 812]');
    ctx.procWarmup = { loaded: 0, sweeping: false, arrived: [1, 2, 3] };
    expect(prompt_render('default', ctx)).toContain('[+3 feeds]');
    expect(prompt_render('p10k', ctx)).toContain('+3 feeds');
  });

  it('names the steps still warming behind the prompt, in both themes, and says nothing once they settle', () => {
    const ctx: PromptContext = promptContext_createWithProgress(0, 0);
    delete ctx.procWarmup;
    ctx.warmupPending = ['Public', 'Queries'];
    expect(prompt_render('default', ctx)).toContain('[warming: public queries]');
    expect(prompt_render('p10k', ctx)).toContain('warming: public queries');
    ctx.warmupPending = [];
    expect(prompt_render('default', ctx)).not.toContain('warming');
    expect(prompt_render('p10k', ctx)).not.toContain('warming');
  });

  it('marks restored data as usable while reconciliation continues', () => {
    const context: PromptContext = promptContext_createWithProgress(25, 100);
    context.procWarmup = { loaded: 25, total: 100, restored: true };
    expect(prompt_render('default', context)).toContain('proc cached, refreshing: 25/100 25%');
    expect(prompt_render('p10k', context)).toContain('proc cached, refreshing: 25/100 25%');
  });
});
