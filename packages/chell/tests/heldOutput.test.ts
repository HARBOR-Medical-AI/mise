/**
 * @file The hold for what a session says while a question is open: its bound in encoded bytes and in items, and
 * nothing handled once the connection has closed.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { HeldOutput } from '../src/remote/heldOutput.js';

/** A hold whose question is open while `open` says so, recording what it hands back. */
function hold_make(): { hold: HeldOutput; handled: string[]; state: { open: boolean } } {
  const handled: string[] = [];
  const state: { open: boolean } = { open: true };
  const hold: HeldOutput = new HeldOutput({
    question_isOpen: (): boolean => state.open,
    message_handle: (payload: Buffer): void => { handled.push(payload.toString()); },
    overflow_answer: (): boolean => false,
  });
  return { hold, handled, state };
}

describe('HeldOutput', () => {
  it('counts a note in encoded bytes: one of fewer characters than the bound but more bytes is not held', () => {
    const { hold, state } = hold_make();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    hold.notice_show('é'.repeat(600_000));
    hold.notice_show('small');
    state.open = false;
    hold.items_flush();
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(['small', expect.stringContaining('more than this chell holds')]);
    errors.mockRestore();
  });

  it('bounds the count of items too: empty frames are not free', () => {
    const { hold, handled, state } = hold_make();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let at = 0; at < 5000; at++) hold.message_take(Buffer.from(''), { type: 'output' });
    state.open = false;
    hold.items_flush();
    expect(handled).toHaveLength(4096);
    errors.mockRestore();
  });

  it('once closed, holds nothing more (what arrives settles at once), hands back nothing held, and shows no note', () => {
    const { hold, handled, state } = hold_make();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(hold.message_take(Buffer.from('{"type":"output"}'), { type: 'output' })).toBe(true);
    hold.hold_close();
    expect(hold.message_take(Buffer.from('{"type":"output"}'), { type: 'output' })).toBe(false);
    state.open = false;
    hold.notice_show('late');
    hold.items_flush();
    expect(handled).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a held message that closes the connection ends the flush: nothing after it is shown', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const state: { open: boolean } = { open: true };
    const handled: string[] = [];
    const hold: HeldOutput = new HeldOutput({
      question_isOpen: (): boolean => state.open,
      message_handle: (payload: Buffer): void => { handled.push(payload.toString()); hold.hold_close(); },
      overflow_answer: (): boolean => false,
    });
    hold.message_take(Buffer.from('{"type":"closing"}'), { type: 'closing' });
    hold.notice_show('after the close');
    hold.message_take(Buffer.from('{"type":"output"}'), { type: 'output' });
    state.open = false;
    hold.items_flush();
    expect(handled).toEqual(['{"type":"closing"}']);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a held message that opens a question again holds what follows it, in order', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const state: { open: boolean } = { open: true };
    const handled: string[] = [];
    const hold: HeldOutput = new HeldOutput({
      question_isOpen: (): boolean => state.open,
      message_handle: (payload: Buffer): void => {
        handled.push(payload.toString());
        if (payload.toString() === 'asks') state.open = true;
      },
      overflow_answer: (): boolean => false,
    });
    hold.message_take(Buffer.from('asks'), { type: 'output' });
    hold.notice_show('note');
    state.open = false;
    hold.items_flush();
    expect(handled).toEqual(['asks']);
    expect(errors).not.toHaveBeenCalled();
    state.open = false;
    hold.items_flush();
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(['note']);
    errors.mockRestore();
  });
});
