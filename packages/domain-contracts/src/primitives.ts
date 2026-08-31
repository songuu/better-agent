import { z } from 'zod';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function isPostgresText(value: string): boolean {
  return (
    !value.includes('\u0000') &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 0xd800 || codePoint > 0xdfff);
    })
  );
}

export const PostgresTextV1Schema = z
  .string()
  .refine(isPostgresText, 'string must be representable as PostgreSQL text');

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    PostgresTextV1Schema,
    z.array(JsonValueSchema),
    z.record(PostgresTextV1Schema, JsonValueSchema),
  ]),
);

/**
 * JSON Schema and architecture-owned opaque subcontracts are maps by definition.
 * Their own registries close their vocabulary; containing domain objects stay strict.
 */
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  PostgresTextV1Schema,
  JsonValueSchema,
);

export const NonEmptyStringSchema = z.string().min(1);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const PositiveMillisecondsSchema = z.number().int().positive();
export const ContractHashSchema = NonEmptyStringSchema;

type ComparablePostgresInstant = {
  wholeSecondMilliseconds: number;
  fractionalSecond: string;
};

const PostgresInstantPattern =
  /^(?<wholeSecond>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fractionalSecond>\d+))?(?<offset>Z|[+-]\d{2}:\d{2})$/u;
const PostgresMinimumIsoYear = 1;
const PostgresMaximumIsoYear = 9_999;
const PostgresMaximumNumericOffsetMinutes = 15 * 60 + 59;

function readComparablePostgresInstant(value: string): ComparablePostgresInstant | undefined {
  const groups = PostgresInstantPattern.exec(value)?.groups;
  const wholeSecond = groups?.wholeSecond;
  const offset = groups?.offset;
  if (wholeSecond === undefined || offset === undefined) {
    return undefined;
  }
  const year = Number(wholeSecond.slice(0, 4));
  if (!Number.isInteger(year) || year < PostgresMinimumIsoYear || year > PostgresMaximumIsoYear) {
    return undefined;
  }
  const fractionalSecond = groups?.fractionalSecond ?? '';
  if (fractionalSecond.length > 6) {
    return undefined;
  }
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (
      !Number.isInteger(offsetHours) ||
      !Number.isInteger(offsetMinutes) ||
      offsetMinutes > 59 ||
      offsetHours * 60 + offsetMinutes > PostgresMaximumNumericOffsetMinutes
    ) {
      return undefined;
    }
  }

  // Date.parse is exact at whole-second precision; parsing the fraction separately avoids its
  // millisecond truncation when PostgreSQL serializes microsecond timestamps.
  const wholeSecondMilliseconds = Date.parse(`${wholeSecond}${offset}`);
  if (!Number.isFinite(wholeSecondMilliseconds) || wholeSecondMilliseconds % 1_000 !== 0) {
    return undefined;
  }

  return {
    wholeSecondMilliseconds,
    fractionalSecond,
  };
}

export const PostgresInstantV1Schema = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => readComparablePostgresInstant(value) !== undefined,
    'instant must fit PostgreSQL ISO year, microsecond precision, and numeric UTC offset range',
  );

export function comparePostgresInstants(left: string, right: string): -1 | 0 | 1 | undefined {
  const leftInstant = readComparablePostgresInstant(left);
  const rightInstant = readComparablePostgresInstant(right);
  if (leftInstant === undefined || rightInstant === undefined) {
    return undefined;
  }
  if (leftInstant.wholeSecondMilliseconds !== rightInstant.wholeSecondMilliseconds) {
    return leftInstant.wholeSecondMilliseconds < rightInstant.wholeSecondMilliseconds ? -1 : 1;
  }

  const precision = Math.max(
    leftInstant.fractionalSecond.length,
    rightInstant.fractionalSecond.length,
  );
  const leftFraction = leftInstant.fractionalSecond.padEnd(precision, '0');
  const rightFraction = rightInstant.fractionalSecond.padEnd(precision, '0');
  if (leftFraction === rightFraction) {
    return 0;
  }
  return leftFraction < rightFraction ? -1 : 1;
}

/**
 * Mirrors PostgreSQL text: valid Unicode scalar values (without U+0000),
 * code-point length, and the persistence guards' explicit ECMAScript TrimString
 * character set. The raw maximum is separate so padding cannot cross layers.
 */
export function boundedNonBlankStringSchema(maxLength: number, label: string) {
  return PostgresTextV1Schema.refine(
    (value) => {
      const length = [...value].length;
      return length >= 1 && length <= maxLength;
    },
    `${label} must contain between 1 and ${String(maxLength)} Unicode code points`,
  ).refine((value) => value.trim().length > 0, `${label} must contain a non-whitespace character`);
}

export const Sha256HexV1Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, 'expected sha256 followed by 64 lowercase hex characters');

export const CanonicalBindingPathV1Schema = z
  .string()
  .regex(/^bp1\.[A-Za-z0-9_-]{43}$/, 'expected a binding-path-lp-utf8/1 SHA-256 digest');

export const ClosureResourceNodeIdV1Schema = z
  .string()
  .regex(/^rn1\.[A-Za-z0-9_-]{43}$/, 'expected a canonical full-pin SHA-256 digest');

export function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function hasUniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

export function addCustomIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({
    code: 'custom',
    message,
    path,
  });
}
