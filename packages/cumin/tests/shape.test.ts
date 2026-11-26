/**
 * @file A shape: what an answer must be in the fields that are read, and
 * what it says when the answer is not.
 */
import { rows_check, shape_object, shape_build, ShapeError, type Shape } from '../src/chrisapi/shape';

interface Piping { id: number; previous_id?: number | null }
interface Sample {
  id: number;
  name?: string;
  note: string | null;
  both?: string | null;
  piping: Piping;
  maybe?: Piping;
  held: Piping | null;
  tags: string[];
  getItems: () => unknown[];
  flag: boolean;
}

const piping: Shape<Piping> = shape_build<Piping>('a piping')(['id', 'number'], ['previous_id', 'number?|null']);
const sample: Shape<Sample> = shape_build<Sample>('a sample')(
  ['id', 'number'], ['name', 'string?'], ['note', 'string|null'], ['both', 'string?|null'], ['piping', piping], ['maybe', { optional: piping }], ['held', { nullable: piping }], ['tags', 'array'], ['getItems', 'function'], ['flag', 'boolean'],
);

/** A value every field of which is what is read. */
function good_make(): Record<string, unknown> {
  return { id: 7, name: 'n', note: null, piping: { id: 1 }, held: null, tags: ['a'], getItems: (): unknown[] => [], flag: false, extra: 'not checked' };
}

/** The message a check fails with, or null when it passes. */
function failure_read(value: unknown, shape: Shape<unknown> = sample as Shape<unknown>): string | null {
  try {
    shape.value_check(value);
    return null;
  } catch (error: unknown) {
    if (!(error instanceof ShapeError)) throw error;
    return error.message;
  }
}

describe('a shape', () => {
  it('passes a value whose read fields are what is read, and returns that very value', () => {
    const value = good_make();
    expect(sample.value_check(value)).toBe(value);
    expect(failure_read({ ...good_make(), name: undefined, both: null, maybe: { id: 2, previous_id: null }, held: { id: 3 } })).toBeNull();
  });

  it('refuses a required field that is missing, null, or of another kind, naming the field and what was found', () => {
    const without = good_make(); delete without['id'];
    expect(failure_read(without)).toBe('CUBE answered a sample whose id is missing, where a number is read');
    expect(failure_read({ ...good_make(), id: null })).toBe('CUBE answered a sample whose id is null, where a number is read');
    expect(failure_read({ ...good_make(), id: '7' })).toBe('CUBE answered a sample whose id is a string, where a number is read');
    expect(failure_read({ ...good_make(), id: Number.NaN })).toBe('CUBE answered a sample whose id is a number, where a number is read');
    expect(failure_read({ ...good_make(), flag: 0 })).toBe('CUBE answered a sample whose flag is a number, where a boolean is read');
    expect(failure_read({ ...good_make(), tags: {} })).toBe('CUBE answered a sample whose tags is an object, where an array is read');
    expect(failure_read({ ...good_make(), getItems: [] })).toBe('CUBE answered a sample whose getItems is an array, where a function is read');
  });

  it('tells optional from nullable: an optional field may be absent and not null; a nullable one may be null and not absent', () => {
    // Optional: absent passes, null fails, the wrong kind fails.
    expect(failure_read({ ...good_make(), name: null })).toBe('CUBE answered a sample whose name is null, where a string is read');
    expect(failure_read({ ...good_make(), name: 3 })).toBe('CUBE answered a sample whose name is a number, where a string is read');
    // Nullable: null passes, absent fails.
    const noNote = good_make(); delete noNote['note'];
    expect(failure_read(noNote)).toBe('CUBE answered a sample whose note is missing, where a string is read');
    expect(failure_read({ ...good_make(), note: 3 })).toBe('CUBE answered a sample whose note is a number, where a string is read');
    // Both: either passes; present, it is still held to its kind.
    expect(failure_read({ ...good_make(), both: 3 })).toBe('CUBE answered a sample whose both is a number, where a string is read');
  });

  it('checks a nested shape by its path, optional and nullable ones when they are there', () => {
    expect(failure_read({ ...good_make(), piping: { id: 'x' } })).toBe('CUBE answered a sample whose piping.id is a string, where a number is read');
    expect(failure_read({ ...good_make(), piping: 5 })).toBe('CUBE answered a sample whose piping is a number, where an object (a piping) is read');
    expect(failure_read({ ...good_make(), piping: null })).toBe('CUBE answered a sample whose piping is null, where an object (a piping) is read');
    expect(failure_read({ ...good_make(), maybe: { id: 'x' } })).toBe('CUBE answered a sample whose maybe.id is a string, where a number is read');
    expect(failure_read({ ...good_make(), maybe: null })).toBe('CUBE answered a sample whose maybe is null, where an object (a piping) is read');
    expect(failure_read({ ...good_make(), held: { id: 1, previous_id: 'x' } })).toBe('CUBE answered a sample whose held.previous_id is a string, where a number is read');
    const noHeld = good_make(); delete noHeld['held'];
    expect(failure_read(noHeld)).toBe('CUBE answered a sample whose held is missing, where an object (a piping) is read');
  });

  it('refuses what is not an object at all, and never puts the value in its words', () => {
    expect(failure_read(null)).toBe('CUBE answered with null where a sample (an object) is read');
    expect(failure_read('a secret token')).toBe('CUBE answered with a string where a sample (an object) is read');
    expect(failure_read([good_make()])).toBe('CUBE answered with an array where a sample (an object) is read');
    expect(failure_read({ ...good_make(), id: 'a secret token' })).not.toContain('secret');
  });

  it('asks only that a value be an object when no field is named', () => {
    const anything: Shape<Record<string, unknown>> = shape_object('a record');
    expect(anything.value_check({ whatever: 1 })).toEqual({ whatever: 1 });
    expect(failure_read(3, anything as Shape<unknown>)).toBe('CUBE answered with a number where a record (an object) is read');
  });

  it('carries what it is and which field, for a caller that wants them', () => {
    try {
      sample.value_check({ ...good_make(), piping: { id: null } });
      throw new Error('it passed');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ShapeError);
      expect((error as ShapeError).what).toBe('a sample');
      expect((error as ShapeError).field).toBe('piping.id');
    }
  });
});

describe('a list of a shape', () => {
  it('passes rows that are each what is read, and returns them', () => {
    const rows = [{ id: 1 }, { id: 2, previous_id: null }];
    expect(rows_check(rows, piping, 'data')).toEqual(rows);
    expect(rows_check([], piping, 'data')).toEqual([]);
  });

  it('refuses a value that is there and is not a list', () => {
    for (const [value, found] of [[{}, 'an object'], ['x', 'a string'], [3, 'a number'], [null, 'null']] as Array<[unknown, string]>) {
      expect(() => rows_check(value, piping, 'data')).toThrow(`CUBE answered a list of a piping whose data is ${found}, where an array is read`);
    }
  });

  it('fails as a whole on its first bad row, naming the row', () => {
    expect(() => rows_check([{ id: 1 }, { id: 'x' }, { id: null }], piping, 'data')).toThrow('CUBE answered a list of a piping whose data[1].id is a string, where a number is read');
    expect(() => rows_check([{ id: 1 }, 'not a row'], piping, 'data')).toThrow('CUBE answered a list of a piping whose data[1] is a string, where an object (a piping) is read');
  });
});

describe('a list with a place nothing was put in', () => {
  interface Holder { rows: Piping[] }
  const holder: Shape<Holder> = shape_build<Holder>('a holder')(['rows', { rows: piping }]);

  it('is refused at that place, by its number, and never handed on with nothing there', () => {
    const holed: unknown[] = new Array<unknown>(2);
    holed[1] = { id: 2 };
    expect(() => rows_check(holed, piping, 'data')).toThrow('CUBE answered a list of a piping whose data[0] is missing, where an object (a piping) is read');
    expect(() => holder.value_check({ rows: holed })).toThrow('CUBE answered a holder whose rows[0] is missing, where an object (a piping) is read');
    const tail: unknown[] = [{ id: 1 }];
    tail.length = 3;
    expect(() => rows_check(tail, piping, 'data')).toThrow('whose data[1] is missing');
  });
});

describe('what a shape may be of', () => {
  it('is an object: a shape of a number or of text does not compile', () => {
    // @ts-expect-error a shape's check asks for an object, so it cannot promise a number
    const ofNumber: unknown = shape_build<number>('a number');
    // @ts-expect-error nor text
    const ofText: unknown = shape_build<string>('text');
    // @ts-expect-error a field is held to its type's kind: an id that is a number is not read as text
    const wrongKind: unknown = shape_build<Piping>('a piping')(['id', 'string']);
    // @ts-expect-error a field the type requires may not be called optional
    const wrongAbsence: unknown = shape_build<Piping>('a piping')(['id', 'number?']);
    expect([ofNumber, ofText, wrongKind, wrongAbsence]).toHaveLength(4);
  });
});
