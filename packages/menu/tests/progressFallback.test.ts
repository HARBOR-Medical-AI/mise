/**
 * @file The two progress enums that fall back to nothing: what they yield
 * for a value they do not know is `undefined`, and their types say so.
 */
import type { z } from 'zod';
import { progressKindSchema, progressMessageSchema, progressUnitSchema } from '../src/messages.js';
import type { ProgressKind, ProgressUnit } from '../src/progress.js';

describe('a progress class or unit this side does not know', () => {
  it('parses to undefined, alone as well as inside a message', () => {
    expect(progressKindSchema.parse('transfer')).toBe('transfer');
    expect(progressKindSchema.parse('a-class-from-a-newer-daemon')).toBeUndefined();
    expect(progressKindSchema.parse(7)).toBeUndefined();
    expect(progressKindSchema.parse(undefined)).toBeUndefined();
    expect(progressUnitSchema.parse('files')).toBe('files');
    expect(progressUnitSchema.parse('parsecs')).toBeUndefined();
  });

  it('is typed as what it yields: the enum or undefined, never the enum alone', () => {
    // The assignments are the test: each compiles only if the schema's own type admits undefined.
    const kind: z.infer<typeof progressKindSchema> = undefined;
    const unit: z.infer<typeof progressUnitSchema> = undefined;
    const known: ProgressKind | undefined = progressKindSchema.parse('retrieve');
    const counted: ProgressUnit | undefined = progressUnitSchema.parse('bytes');
    // @ts-expect-error what is parsed may be undefined, and is not a ProgressKind until it is looked at
    const assumed: ProgressKind = progressKindSchema.parse('retrieve');
    // @ts-expect-error likewise a unit
    const assumedUnit: ProgressUnit = progressUnitSchema.parse('bytes');
    expect([kind, unit, known, counted, assumed, assumedUnit]).toEqual([undefined, undefined, 'retrieve', 'bytes', 'retrieve', 'bytes']);
  });

  it('leaves a message with an unknown class or unit one axis poorer, not refused', () => {
    const shape = progressMessageSchema.shape as Record<string, { parse(value: unknown): unknown }>;
    expect(shape['kind']?.parse('a-class-from-a-newer-daemon')).toBeUndefined();
    expect(shape['unit']?.parse('parsecs')).toBeUndefined();
  });
});
