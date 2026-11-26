/**
 * @file What an answer from CUBE must look like before it is used as its type.
 *
 * The adapter hands back what the chrisapi client returns, and until now
 * handed it back as whatever type the caller named. A shape is the check
 * that goes with a type: the fields the callers read without looking, each
 * with the kind of value read, written once beside the type. The adapter's
 * helpers take a shape and return the shape's own type, so a caller cannot
 * name a type the answer was never held to.
 *
 * A field is one of:
 *
 * - required: `'number'`. It must be there and be that kind.
 * - optional: `'number?'`. It may be absent; present, it must be that kind,
 *   and null is not that kind.
 * - nullable: `'number|null'`. It must be there, and may be null.
 * - optional and nullable: `'number?|null'`.
 *
 * The kinds are `string`, `number`, `boolean`, `object` (not null, not an
 * array), `array`, `function`; for an object whose own fields are read,
 * another shape; and for a list whose rows are read, `{ rows: shape }`. A
 * field that is not in a shape is not checked, and is not to be read
 * without a check of the caller's own.
 *
 * A value that fails says which field of what, and what kind was found;
 * never the value.
 *
 * Key components:
 * - shape_build: the shape of an object, from the fields that are read.
 * - shape_object: the shape of a value only required to be an object.
 * - shape_nullable: a shape of an answer that may be nothing.
 * - rows_check: a list, each row held to a shape.
 * - ShapeError: what a value that fails is refused with.
 *
 * Typical usage:
 * ```ts
 * const FEED: Shape<Feed> = shape_build<Feed>('a feed')(['id', 'number'], ['name', 'string']);
 * const feed: Feed = FEED.value_check(answer);
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/** The kinds a field is checked to be. */
export type FieldKind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'function';

/** A kind with its allowances: absent (`?`), null (`|null`), or both. */
export type FieldSpec<K extends string = FieldKind> = K | `${K}?` | `${K}|null` | `${K}?|null`;

/**
 * What an answer was found to be, where it is not what is read.
 *
 * @example
 * throw new ShapeError('a feed', 'id', 'missing', 'a number');
 */
export class ShapeError extends Error {
  /** What the answer is (a feed, a plugin instance). */
  public readonly what: string;
  /** The field that is not what is read, by its path; empty for the value itself. */
  public readonly field: string;

  /**
   * @param what - What the answer is, in the words a person would use.
   * @param field - The field's path; empty for the value itself.
   * @param found - What was found there, as a kind.
   * @param wanted - What is read there.
   */
  constructor(what: string, field: string, found: string, wanted: string) {
    super(field === '' ? `CUBE answered with ${found} where ${what} (${wanted}) is read` : `CUBE answered ${what} whose ${field} is ${found}, where ${wanted} is read`);
    this.name = 'ShapeError';
    this.what = what;
    this.field = field;
  }
}

/**
 * A check that a value is a `T`, in the fields that are read.
 *
 * @example
 * const feed: Feed = FEED.value_check(answer);
 */
export interface Shape<T> {
  /** What the value is, in the words a person would use. */
  readonly what: string;
  /**
   * Checks a value.
   *
   * @param value - What CUBE answered.
   * @param path - Where the value stands in a larger answer; empty for the answer itself.
   * @param what - What the larger answer is, when this shape is a field of one.
   * @returns The value, as its type.
   * @throws {ShapeError} When a field that is read is not what is read.
   *
   * @example
   * const feed: Feed = FEED.value_check(answer);
   */
  value_check(value: unknown, path?: string, what?: string): T;
}

/**
 * A field that is a list whose rows are themselves read: an array, each row of a shape.
 *
 * @example
 * const ITEM: Shape<Item> = shape_build<Item>('an item')(['data', { rows: FIELD }]);
 */
export interface RowsOf<E> {
  /** The shape of each row. */
  readonly rows: Shape<E>;
}

/** A field that may be absent, and is an object of a shape when it is there. */
interface OptionalOf<S> {
  /** The shape when it is there. */
  readonly optional: S;
}

/** A field that may be null, and is an object of a shape when it is not. */
interface NullableOf<S> {
  /** The shape when it is not null. */
  readonly nullable: S;
}

/**
 * The name of a shape of `T`: text, when `T` is an object that is neither a
 * list nor callable, and nothing at all otherwise. A shape's check asks for
 * such an object, so a shape of a list or of a function has no name it can
 * be given, and does not compile.
 */
export type RecordName<T> = T extends readonly unknown[] ? never : T extends (...args: never[]) => unknown ? never : string;

/** The kind a field's type is checked as, or a shape of it when it is an object. */
type KindOf<V> =
  V extends string ? 'string'
    : V extends number ? 'number'
      : V extends boolean ? 'boolean'
        : V extends (...args: never[]) => unknown ? 'function'
          : V extends readonly (infer E)[] ? 'array' | RowsOf<E>
            : V extends object ? 'object' | Shape<V>
              : never;

/** What may be written for a field of type `V`: its kind, with `?` only where the type allows absence and `|null` only where it allows null. */
type SpecOf<V> =
  // A field the type itself calls unknown may be held to any kind: the shape then says more than the type.
  unknown extends V ? FieldSpec | Shape<unknown> | OptionalOf<Shape<unknown>> | NullableOf<Shape<unknown>> | RowsOf<unknown> :
    KindOf<NonNullable<V>> extends infer K
      ? K extends string
        ? K | (undefined extends V ? `${K}?` : never) | (null extends V ? `${K}|null` : never) | (undefined extends V ? (null extends V ? `${K}?|null` : never) : never)
        : K extends Shape<unknown>
          ? K | (undefined extends V ? OptionalOf<K> : never) | (null extends V ? NullableOf<K> : never)
          : K extends RowsOf<unknown> ? K : never
      : never;

/** The names a type declares itself, leaving out an index signature (`[key: string]: unknown`), which names nothing. */
type DeclaredKey<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] } & string;

/**
 * One field of a shape of `T`: the field's name as CUBE spells it, and what
 * its type allows to be read there. Written as a pair so that a name with
 * an underscore is a string, as it is on the wire, and not an identifier.
 */
export type ShapeField<T> = { [K in DeclaredKey<T>]: readonly [K, SpecOf<T[K]>] }[DeclaredKey<T>];

/**
 * The kind a value is, as the checks name kinds.
 *
 * @param value - Any value.
 * @returns `missing`, `null`, `an array`, `an object`, or its `typeof` with its article.
 *
 * @example
 * kind_name([]); // 'an array'
 */
function kind_name(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const kind: string = typeof value;
  return kind === 'object' ? 'an object' : `a ${kind}`;
}

/**
 * Whether a value is of a kind.
 *
 * @param value - The value, neither undefined nor null.
 * @param kind - The kind.
 * @returns True when it is.
 *
 * @example
 * kind_matches(3, 'number'); // true
 */
function kind_matches(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (kind === 'number') return typeof value === 'number' && !Number.isNaN(value);
  return typeof value === kind;
}

/** One field's check, read from its spec. */
interface FieldCheck {
  /** The field's name. */
  readonly name: string;
  /** The kind, or the shape of the object there. */
  readonly kind: FieldKind | Shape<unknown>;
  /** Whether it may be absent. */
  readonly optional: boolean;
  /** Whether it may be null. */
  readonly nullable: boolean;
  /** For a list whose rows are read: the shape of a row. */
  readonly rows?: Shape<unknown>;
}

/**
 * Reads a field's spec.
 *
 * @param name - The field's name.
 * @param spec - What was written for it.
 * @returns The check.
 *
 * @example
 * fieldCheck_read('id', 'number?'); // { name: 'id', kind: 'number', optional: true, nullable: false }
 */
function fieldCheck_read(name: string, spec: unknown): FieldCheck {
  if (typeof spec === 'string') {
    const nullable: boolean = spec.endsWith('|null');
    const rest: string = nullable ? spec.slice(0, -'|null'.length) : spec;
    const optional: boolean = rest.endsWith('?');
    return { name, kind: (optional ? rest.slice(0, -1) : rest) as FieldKind, optional, nullable };
  }
  const wrapped = spec as Partial<OptionalOf<Shape<unknown>>> & Partial<NullableOf<Shape<unknown>>> & Partial<RowsOf<unknown>>;
  if (wrapped.rows !== undefined) return { name, kind: 'array', optional: false, nullable: false, rows: wrapped.rows };
  if (wrapped.optional !== undefined) return { name, kind: wrapped.optional, optional: true, nullable: false };
  if (wrapped.nullable !== undefined) return { name, kind: wrapped.nullable, optional: false, nullable: true };
  return { name, kind: spec as Shape<unknown>, optional: false, nullable: false };
}

/**
 * What a field's check reads there, in words.
 *
 * @param check - The field's check.
 * @returns The kind with its article, or the shape's own name.
 *
 * @example
 * wanted_say({ name: 'id', kind: 'number', optional: false, nullable: false }); // 'a number'
 */
function wanted_say(check: FieldCheck): string {
  if (typeof check.kind !== 'string') return `an object (${check.kind.what})`;
  return check.kind === 'array' || check.kind === 'object' ? `an ${check.kind}` : `a ${check.kind}`;
}

/**
 * Holds one field of a record to its check.
 *
 * @param found - What the record has there.
 * @param check - The field's check.
 * @param at - The field's path in the answer.
 * @param outer - What the answer is.
 * @throws {ShapeError} When the field is not what is read.
 *
 * @example
 * field_check(record['id'], check, 'data.id', 'a feed');
 */
function field_check(found: unknown, check: FieldCheck, at: string, outer: string): void {
  if (found === undefined) {
    if (check.optional) return;
    throw new ShapeError(outer, at, 'missing', wanted_say(check));
  }
  if (found === null) {
    if (check.nullable) return;
    throw new ShapeError(outer, at, 'null', wanted_say(check));
  }
  if (typeof check.kind !== 'string') {
    check.kind.value_check(found, at, outer);
    return;
  }
  if (!kind_matches(found, check.kind)) throw new ShapeError(outer, at, kind_name(found), wanted_say(check));
  const rows: Shape<unknown> | undefined = check.rows;
  if (rows !== undefined) {
    // Every place in the list by its number, a place nothing was put in included: such a hole is a missing row.
    const list = found as unknown[];
    for (let index: number = 0; index < list.length; index++) rows.value_check(list[index], `${at}[${String(index)}]`, outer);
  }
}

/**
 * Makes the shape of an object: a value that is an object (not null, not
 * an array) whose named fields are each what is read.
 *
 * The type is named once, here, and must be an object's (a shape of a
 * number or of text would promise a type its check, which asks for an
 * object, never holds a value to). Each field's spec is held to what the
 * type says of that field, so a shape cannot say `string` of a field the
 * type calls a number, nor allow an absence the type does not.
 *
 * @param what - What the value is, in the words a person would use ("a feed").
 * @returns A function from the fields, each a pair of name and spec, to the shape.
 *
 * @example
 * const FEED: Shape<Feed> = shape_build<Feed>('a feed')(['id', 'number'], ['name', 'string?']);
 */
export function shape_build<T extends object>(what: RecordName<T>): (...fields: ShapeField<T>[]) => Shape<T> {
  return (...fields: ShapeField<T>[]): Shape<T> => {
    const checks: FieldCheck[] = (fields as ReadonlyArray<readonly [string, unknown]>).map(([name, spec]: readonly [string, unknown]): FieldCheck => fieldCheck_read(name, spec));
    return {
      what,
      value_check(value: unknown, path: string = '', outer: string = what): T {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ShapeError(outer, path, kind_name(value), path === '' ? 'an object' : `an object (${what})`);
        const record = value as Record<string, unknown>;
        for (const check of checks) field_check(record[check.name], check, path === '' ? check.name : `${path}.${check.name}`, outer);
        return value as T;
      },
    };
  };
}

/**
 * The shape of a value that is only required to be an object: its fields
 * are the caller's to check before reading.
 *
 * @param what - What the value is.
 * @returns The shape.
 *
 * @example
 * const ROW: Shape<Record<string, unknown>> = shape_object('a permission row');
 */
export function shape_object<T extends object = Record<string, unknown>>(what: RecordName<T>): Shape<T> {
  return shape_build<T>(what)();
}

/**
 * The shape of an answer that may be nothing at all: null or undefined is
 * taken as null; anything else is held to the shape.
 *
 * @param shape - The shape of the answer when there is one.
 * @returns A shape of that, or null.
 *
 * @example
 * const FILE_OR_NONE: Shape<UserFile | null> = shape_nullable(FILE);
 */
export function shape_nullable<T>(shape: Shape<T>): Shape<T | null> {
  return {
    what: shape.what,
    value_check(value: unknown, path: string = '', what: string = shape.what): T | null {
      return value === undefined || value === null ? null : shape.value_check(value, path, what);
    },
  };
}

/**
 * Checks a list: a value that is an array, each of whose rows is a `T`.
 *
 * @param value - What CUBE answered where a list is read.
 * @param shape - The shape of a row.
 * @param field - What holds the list (`data`, `items`), for the words.
 * @returns The rows.
 * @throws {ShapeError} When the value is not an array, or a row is not what is read; the row's place is in the field's path.
 *
 * @example
 * const feeds: Feed[] = rows_check(page.data, FEED, 'data');
 */
export function rows_check<T>(value: unknown, shape: Shape<T>, field: string): T[] {
  if (!Array.isArray(value)) throw new ShapeError(`a list of ${shape.what}`, field, kind_name(value), 'an array');
  // Every place in the list by its number: a list with a hole in it has a missing row there, and a walk that
  // skipped holes would hand back a list typed as rows with nothing in that place.
  const list = value as unknown[];
  const rows: T[] = [];
  for (let at: number = 0; at < list.length; at++) rows.push(shape.value_check(list[at], `${field}[${String(at)}]`, `a list of ${shape.what}`));
  return rows;
}
