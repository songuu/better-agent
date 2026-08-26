import { z } from 'zod';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * JSON Schema and architecture-owned opaque subcontracts are maps by definition.
 * Their own registries close their vocabulary; containing domain objects stay strict.
 */
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

export const NonEmptyStringSchema = z.string().min(1);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const PositiveMillisecondsSchema = z.number().int().positive();
export const ContractHashSchema = NonEmptyStringSchema;

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
