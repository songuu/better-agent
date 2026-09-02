import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareJsonSchemaContract as prepare,
  verifyJsonSchemaContract as verify,
  validateJsonSchemaInstance as validate,
} from '../src/index.js';

const dialect = 'https://json-schema.org/draft/2020-12/schema';
function objectSchema() {
  return {
    $schema: dialect,
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1 }, label: { type: 'string', minLength: 1 } },
    required: ['count'],
    additionalProperties: false,
  };
}
function independentHash(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

describe('bounded JSON Schema contracts and real instance validation', () => {
  it('binds the exact source and versioned validator profile, freezes results and verifies whole artifacts', async () => {
    const schema = objectSchema();
    const before = structuredClone(schema);
    const result = await prepare(schema);
    expect(schema).toEqual(before);
    expect(result.schema_version).toBe('prepared-json-schema-contract/1');
    expect(result.document).toEqual(schema);
    expect(result.schema_hash).toBe(independentHash(schema));
    expect(result.validator_profile).toMatchObject({
      schema_version: 'json-schema-validator-profile/1',
      dialect,
      ajv_version: '8.20.0',
      formats_version: '3.0.1',
      references: 'same-document-fragment-only',
      data_mutation: 'forbidden',
    });
    expect(result.validator_profile_hash).toBe(independentHash(result.validator_profile));
    expect(result.contract_hash).toBe(
      independentHash({
        schema_version: 'json-schema-validation-contract/1',
        schema_hash: result.schema_hash,
        validator_profile_hash: result.validator_profile_hash,
      }),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(await verify(result, schema)).toEqual(result);
    for (const patch of [
      { schema_hash: `sha256:${'0'.repeat(64)}` },
      { document: {} },
      { validator_profile: {} },
      { validator_profile_hash: 'wrong' },
      { contract_hash: 'wrong' },
      { extra: true },
    ])
      await expect(verify({ ...result, ...patch }, schema)).rejects.toThrow(
        'JSON_SCHEMA_CONTRACT_MISMATCH',
      );
  });
  it.each([true, false, {}, { $schema: dialect }])(
    'accepts legal boolean/empty schema %j',
    async (schema) => {
      expect((await prepare(schema)).document).toEqual(schema);
    },
  );
  it.each([
    null,
    1,
    [[]],
    'string',
    { type: 'unknown' },
    { minimum: '1' },
    { enum: [] },
    { required: ['x', 'x'] },
    { minItems: -1 },
    { unknown_keyword: true },
    { $async: true },
    { $data: '1/foo' },
    { $schema: 'http://json-schema.org/draft-07/schema#' },
  ])('rejects invalid or unsupported schema %j', async (schema) => {
    await expect(prepare(schema)).rejects.toThrow('JSON_SCHEMA_INVALID');
  });
  it('checks unused definitions and nested applicators without treating annotation data as schemas', async () => {
    for (const schema of [
      { $defs: { ignored: { type: 'invalid' } } },
      { $defs: { ignored: { surprise: true } } },
      { properties: { nested: { $async: true } } },
      { allOf: [{}, { properties: { bad: { unknown_keyword: true } } }] },
      { contentSchema: { unknown_keyword: true } },
    ])
      await expect(prepare(schema)).rejects.toThrow('JSON_SCHEMA_INVALID');
    await expect(
      prepare({
        const: { $ref: 'https://example.test/not-a-schema', type: 'business' },
        default: { $async: true },
        examples: [{ unknown_keyword: true }],
      }),
    ).resolves.toBeDefined();
  });
  it.each([
    'https://example.test/schema',
    'file:///etc/passwd',
    '../other.json',
    '//example.test/schema',
    'other#/$defs/a',
  ])('rejects external reference %s even if unreferenced', async ($ref) => {
    await expect(prepare({ $defs: { ignored: { $ref } } })).rejects.toThrow('JSON_SCHEMA_INVALID');
  });
  it('supports local pointers, anchors, sibling constraints and recursive data', async () => {
    const schema = {
      $schema: dialect,
      $defs: {
        'a/b~c': { type: 'integer', minimum: 0 },
        node: {
          $anchor: 'node',
          type: 'object',
          properties: {
            value: { $ref: '#/$defs/a~1b~0c', maximum: 4 },
            next: { anyOf: [{ type: 'null' }, { $ref: '#node' }] },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
      $ref: '#node',
    };
    await prepare(schema);
    const input = { value: 2, next: { value: 3, next: null } };
    expect(await validate(schema, input)).toEqual(input);
    await expect(validate(schema, { value: 5 })).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    await expect(validate(schema, { value: 2, next: { value: -1 } })).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
    for (const invalid of [
      { $ref: '#/$defs/missing' },
      { $ref: '#noAnchor' },
      { $defs: { a: { $anchor: 'same' }, b: { $anchor: 'same' } } },
      { $defs: { a: { $id: 'https://example.test/other', type: 'string' } } },
    ])
      await expect(prepare(invalid)).rejects.toThrow('JSON_SCHEMA_INVALID');
  });
  it('enforces combinators, conditionals, dependent schemas and unevaluated properties', async () => {
    const schema = {
      type: 'object',
      properties: { kind: { enum: ['a', 'b'] }, extra: { type: 'boolean' } },
      required: ['kind'],
      if: { properties: { kind: { const: 'a' } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is data, not a thenable.
      then: { properties: { a: { type: 'number' } }, required: ['a'] },
      else: { properties: { b: { type: 'string' } }, required: ['b'] },
      dependentSchemas: { extra: { required: ['a'] } },
      unevaluatedProperties: false,
    };
    expect(await validate(schema, { kind: 'a', a: 1 })).toEqual({ kind: 'a', a: 1 });
    expect(await validate(schema, { kind: 'b', b: 'x' })).toEqual({ kind: 'b', b: 'x' });
    for (const value of [
      { kind: 'a' },
      { kind: 'b', b: 'x', extra: true },
      { kind: 'a', a: 1, leaked: true },
    ])
      await expect(validate(schema, value)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    await expect(validate({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1)).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
    await expect(validate({ not: { const: 2 } }, 2)).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
  });
  it('supports tuple/contains/unique/numeric/string validation with Unicode code points', async () => {
    const schema = {
      type: 'array',
      prefixItems: [
        { type: 'integer', multipleOf: 2 },
        { type: 'string', minLength: 1, maxLength: 1 },
      ],
      items: { type: 'number', exclusiveMinimum: 3 },
      minItems: 3,
      uniqueItems: true,
      contains: { const: 4 },
      minContains: 1,
      maxContains: 1,
    };
    expect(await validate(schema, [2, '🚀', 4])).toEqual([2, '🚀', 4]);
    for (const value of [
      [3, 'x', 4],
      [2, 'xy', 4],
      [2, 'x', 3],
      [2, 'x', 5],
      [2, 'x', 4, 4],
    ])
      await expect(validate(schema, value)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    await expect(
      validate(
        {
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          patternProperties: { '^x': { type: 'integer' } },
          additionalProperties: false,
        },
        { x: 'bad' },
      ),
    ).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
  });
  it('does not coerce, insert defaults, remove extra properties or mutate data', async () => {
    const schema = {
      ...objectSchema(),
      properties: { ...objectSchema().properties, defaulted: { type: 'number', default: 1 } },
    };
    const input = { count: 2 };
    const result = await validate(schema, input);
    expect(result).toEqual({ count: 2 });
    expect(input).toEqual({ count: 2 });
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    await expect(validate(schema, { count: '2' })).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    await expect(validate(schema, { count: 2, hidden: true })).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
    await expect(validate(false, {})).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    expect(await validate(true, null)).toBeNull();
    await expect(
      validate(
        {
          type: 'object',
          properties: { count: { type: 'integer', default: 1 } },
          required: ['count'],
          additionalProperties: false,
        },
        {},
      ),
    ).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
  });
  it.each([
    ['date', '2024-02-29', '2023-02-29'],
    ['date-time', '2024-01-01T12:00:00Z', '2024-01-01'],
    ['email', 'a@example.test', 'not-mail'],
    ['uuid', '10000000-0000-4000-8000-000000000001', 'bad'],
    ['ipv4', '192.0.2.1', '300.0.0.1'],
    ['json-pointer', '/a~1b', '/a~2b'],
  ])('asserts full format %s', async (format, valid, invalid) => {
    const schema = { type: 'string', format };
    expect(await validate(schema, valid)).toBe(valid);
    await expect(validate(schema, invalid)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
  });
  it('rejects unknown formats rather than ignoring them', async () => {
    await expect(prepare({ type: 'string', format: 'unknown-company-format' })).rejects.toThrow(
      'JSON_SCHEMA_INVALID',
    );
    await expect(
      prepare({ $defs: { hidden: { format: 'unknown-company-format' } } }),
    ).rejects.toThrow('JSON_SCHEMA_INVALID');
  });

  it('supports dynamic recursive anchors and keeps root identifiers local', async () => {
    const schema = {
      $id: 'https://example.test/tree',
      $dynamicAnchor: 'node',
      type: 'object',
      properties: {
        value: { type: 'string' },
        children: { type: 'array', items: { $dynamicRef: '#node' } },
      },
      required: ['value'],
      additionalProperties: false,
    };
    expect(await validate(schema, { value: 'a', children: [{ value: 'b' }] })).toEqual({
      value: 'a',
      children: [{ value: 'b' }],
    });
    await expect(validate(schema, { value: 'a', children: [{ value: 1 }] })).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
    await expect(prepare({ $dynamicRef: 'https://example.test/other#node' })).rejects.toThrow(
      'JSON_SCHEMA_INVALID',
    );
  });

  it.each(['pointer', 'anchor', 'dynamic-anchor'])(
    'resolves dynamic references to a nested %s target',
    async (kind) => {
      const target = {
        type: 'integer',
        ...(kind === 'anchor' ? { $anchor: 'value' } : {}),
        ...(kind === 'dynamic-anchor' ? { $dynamicAnchor: 'value' } : {}),
      };
      const schema = {
        $defs: { value: target },
        type: 'object',
        properties: {
          item: { $dynamicRef: kind === 'pointer' ? '#/$defs/value' : '#value', minimum: 2 },
        },
        required: ['item'],
      };
      const before = structuredClone(schema);
      expect((await prepare(schema)).document).toEqual(before);
      expect(await validate(schema, { item: 2 })).toEqual({ item: 2 });
      for (const item of [{}, '2', 1])
        await expect(validate(schema, { item })).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
      expect(schema).toEqual(before);
    },
  );

  it('preserves simultaneous static/dynamic references, siblings, existing allOf and pointer positions', async () => {
    const schema = {
      $defs: { integer: { type: 'integer' }, minimum: { minimum: 2 } },
      type: 'object',
      properties: {
        item: {
          $ref: '#/$defs/integer',
          $dynamicRef: '#/$defs/minimum',
          maximum: 8,
          allOf: [{ not: { const: 4 } }],
        },
        other: { $ref: '#/properties/item/allOf/0' },
      },
    };
    expect(await validate(schema, { item: 2, other: 3 })).toEqual({ item: 2, other: 3 });
    for (const item of [2.5, 1, 9, 4])
      await expect(validate(schema, { item })).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    await expect(validate(schema, { item: 2, other: 4 })).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
  });

  it('requires canonical reference spelling and schema-bearing targets', async () => {
    const definitions = { $defs: { 'a/b': { type: 'string' }, 知识: { type: 'number' } } };
    await expect(prepare({ ...definitions, $ref: '#/$defs/a~1b' })).resolves.toBeDefined();
    await expect(
      prepare({ ...definitions, $ref: '#/$defs/%E7%9F%A5%E8%AF%86' }),
    ).resolves.toBeDefined();
    for (const $ref of [
      '#/%24defs/a~1b',
      '#/$defs/a%7e1b',
      '#/$defs/%e7%9f%a5%e8%af%86',
      '#/$defs/a~2b',
      '#/%',
      '#/$defs/a%2Fb',
    ])
      await expect(prepare({ ...definitions, $ref })).rejects.toThrow('JSON_SCHEMA_INVALID');
    await expect(prepare({ default: { type: 'string' }, $ref: '#/default' })).rejects.toThrow(
      'JSON_SCHEMA_INVALID',
    );
  });

  it('resolves a root plain anchor with a resource ID and both refs without an existing allOf', async () => {
    const schema = {
      $id: 'https://example.test/root',
      $anchor: 'root',
      type: 'object',
      $defs: { integer: { type: 'integer' }, positive: { minimum: 1 } },
      properties: {
        item: { $ref: '#/$defs/integer', $dynamicRef: '#/$defs/positive' },
        next: { $ref: '#root' },
      },
      required: ['item'],
    };
    expect(await validate(schema, { item: 1, next: { item: 2 } })).toEqual({
      item: 1,
      next: { item: 2 },
    });
    for (const input of [{ item: 0 }, { item: 1.5 }, { item: 1, next: { item: 0 } }])
      await expect(validate(schema, input)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
  });

  it('rejects schema map keys the engine omits and validates own prototype-named data safely', async () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"integer"},"constructor":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}',
    );
    await expect(prepare(schema)).rejects.toThrow('JSON_SCHEMA_INVALID');
    for (const keyword of [
      '$defs',
      'properties',
      'patternProperties',
      'dependentSchemas',
      'dependentRequired',
    ]) {
      await expect(
        prepare(
          JSON.parse(
            `{"${keyword}":{"__proto__":${keyword === 'dependentRequired' ? '["x"]' : '{}'}}}`,
          ),
        ),
      ).rejects.toThrow('JSON_SCHEMA_INVALID');
    }
    const safeSchema = {
      type: 'object',
      properties: { constructor: { type: 'string' } },
      patternProperties: { '^__proto__$': { type: 'integer' } },
      required: ['__proto__'],
      additionalProperties: false,
    };
    const value = JSON.parse('{"__proto__":2,"constructor":"data"}');
    expect(await validate(safeSchema, value)).toEqual(value);
    await expect(validate(safeSchema, {})).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    await expect(validate(safeSchema, JSON.parse('{"__proto__":"wrong"}'))).rejects.toThrow(
      'JSON_SCHEMA_INSTANCE_INVALID',
    );
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('terminates excessive regex work without blocking the parent event loop and recovers', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    try {
      await expect(
        validate({ type: 'string', pattern: '^(a+)+$' }, `${'a'.repeat(100)}!`),
      ).rejects.toThrow('JSON_SCHEMA_LIMIT_EXCEEDED');
      expect(ticks).toBeGreaterThan(5);
      expect(await validate({ type: 'integer' }, 2)).toBe(2);
    } finally {
      clearInterval(timer);
    }
  }, 12_000);

  it('bounds simultaneous worker admission and recovers each slot after exit', async () => {
    const pending = Array.from({ length: 4 }, () => validate({ type: 'integer' }, 1));
    await expect(validate({}, {})).rejects.toThrow('JSON_SCHEMA_VALIDATOR_BUSY');
    expect(await Promise.all(pending)).toEqual([1, 1, 1, 1]);
    expect(await validate({}, {})).toEqual({});
  });
  it('enforces the independent schema-node budget at 4096 and rejects 4097', async () => {
    const schema = (delta: number) => ({
      allOf: [0, 1, 2, 3].map((index) => ({
        anyOf: Array.from({ length: index < 3 ? 1024 : 1019 + delta }, () => true),
      })),
    });
    await expect(prepare(schema(0))).resolves.toBeDefined();
    await expect(prepare(schema(1))).rejects.toThrow('JSON_SCHEMA_LIMIT_EXCEEDED');
    expect(await validate({ type: 'integer' }, 2)).toBe(2);
  });
  it('rejects hostile data and schema before invoking getters or Proxy traps', async () => {
    const trap = vi.fn();
    const proxy = new Proxy({}, { get: trap, ownKeys: trap });
    await expect(prepare(proxy)).rejects.toThrow('JSON_SCHEMA_INVALID');
    await expect(validate({}, proxy)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    const getter = Object.defineProperty({}, 'type', { enumerable: true, get: trap });
    await expect(prepare(getter)).rejects.toThrow('JSON_SCHEMA_INVALID');
    expect(trap).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {};
    cyclic.child = cyclic;
    await expect(validate({}, cyclic)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
  });
  it('snapshots before asynchronous validation and never accepts post-call mutation', async () => {
    const schema = objectSchema();
    const input = { count: 3 };
    const pending = validate(schema, input);
    input.count = -1;
    schema.required.push('label');
    expect(await pending).toEqual({ count: 3 });
    await expect(validate(schema, input)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
  });
  it('bounds schema and instance data independently and recovers after rejection', async () => {
    await expect(prepare({ title: 'a'.repeat(65_537) })).rejects.toThrow(
      'JSON_SCHEMA_LIMIT_EXCEEDED',
    );
    await expect(validate({}, 'a'.repeat(65_537))).rejects.toThrow('JSON_SCHEMA_LIMIT_EXCEEDED');
    await expect(prepare({ enum: Array.from({ length: 1025 }, (_, i) => i) })).rejects.toThrow(
      'JSON_SCHEMA_LIMIT_EXCEEDED',
    );
    expect(await validate({ type: 'string', maxLength: 65_536 }, 'a'.repeat(65_536))).toHaveLength(
      65_536,
    );
    expect(await validate(objectSchema(), { count: 1 })).toEqual({ count: 1 });
  });
  it('rejects a prepared contract that exceeds the output budget although its schema fits', async () => {
    const schema = { title: '', examples: Array.from({ length: 128 }, () => 'a'.repeat(65_500)) };
    const padding = 8_388_608 - 500 - Buffer.byteLength(JSON.stringify(schema), 'utf8');
    schema.title = 'x'.repeat(padding);
    expect(Buffer.byteLength(JSON.stringify(schema), 'utf8')).toBe(8_388_608 - 500);
    // The same schema compiles for validation; only prepare's larger return artifact fails.
    expect(await validate(schema, 2)).toBe(2);
    await expect(prepare(schema)).rejects.toThrow('JSON_SCHEMA_LIMIT_EXCEEDED');
    schema.title = schema.title.slice(2000);
    const contract = await prepare(schema);
    expect(await verify(contract, schema)).toEqual(contract);
  }, 20_000);
  it('rejects malformed schema without leaking its contents or compiler diagnostics', async () => {
    const secret = 'private-source-marker';
    try {
      await prepare({ type: secret });
      throw new Error('must reject');
    } catch (error) {
      expect(String(error)).toContain('JSON_SCHEMA_INVALID');
      expect(String(error)).not.toContain(secret);
    }
  });
});
