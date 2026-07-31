import { describe, it, expect } from 'vitest';
import type { FieldValues, ResolverOptions } from 'react-hook-form';

import { jsonSchemaResolver } from '@/shared/forms/json-schema-resolver';

// Minimal ResolverOptions; toNestErrors only reads criteriaMode / native flag.
const opts = {
  fields: {},
  shouldUseNativeValidation: false,
} as unknown as ResolverOptions<FieldValues>;

const schema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['sym', 'amt'],
  properties: {
    sym: { type: 'string' },
    amt: { type: 'integer', minimum: 0 },
    buy: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
  },
};

describe('jsonSchemaResolver', () => {
  it('passes valid values through with no errors', async () => {
    const resolve = jsonSchemaResolver(schema);
    const values = { sym: 'BTCUSDT', amt: 5, buy: { n: 1 } };
    const result = await resolve(values, undefined, opts);
    expect(result.errors).toEqual({});
    expect(result.values).toEqual(values);
  });

  it('binds a range violation to its field and clears values', async () => {
    const resolve = jsonSchemaResolver(schema);
    const result = await resolve({ sym: 'X', amt: -3, buy: { n: 1 } }, undefined, opts);
    expect(result.values).toEqual({});
    expect(result.errors.amt).toBeDefined();
    expect(String(result.errors.amt?.message)).toContain('less than 0');
    // The parent aggregate ("properties"/"additionalProperties") is filtered,
    // so a single field error never also spawns a phantom root banner.
    expect(result.errors.root).toBeUndefined();
  });

  it('binds a missing required field to that field, including nested', async () => {
    const resolve = jsonSchemaResolver(schema);
    const result = await resolve({ amt: 1, buy: {} }, undefined, opts);
    expect(result.errors.sym).toBeDefined();
    expect((result.errors.buy as Record<string, unknown> | undefined)?.n).toBeDefined();
  });

  it('treats an undefined field as absent instead of throwing', async () => {
    const resolve = jsonSchemaResolver(schema);
    // react-hook-form emits `undefined` for unset fields; cfworker would throw
    // on that raw. It must be handled as a missing required field.
    const result = await resolve({ sym: undefined, amt: 1, buy: { n: 1 } }, undefined, opts);
    expect(result.errors.sym).toBeDefined();
  });

  it('still blocks when the only failure is a stray extra property', async () => {
    const resolve = jsonSchemaResolver(schema);
    const result = await resolve({ sym: 'X', amt: 1, extra: true }, undefined, opts);
    expect(result.errors.root).toBeDefined();
  });

  const arraySchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      nums: { type: 'array', items: { type: 'integer' } },
      // A property name containing '/' exercises JSON-Pointer (~1) unescaping.
      'a/b': { type: 'string' },
    },
  };

  it('binds an array-element error to its indexed path', async () => {
    const resolve = jsonSchemaResolver(arraySchema);
    const result = await resolve({ nums: ['x'] }, undefined, opts);
    expect((result.errors.nums as unknown as unknown[] | undefined)?.[0]).toBeDefined();
  });

  it('maps an undefined array hole to null and reports it at that index', async () => {
    const resolve = jsonSchemaResolver(arraySchema);
    // toJsonSafe turns the undefined hole into null; null fails the integer
    // item schema at index 0 rather than throwing.
    const result = await resolve({ nums: [undefined] }, undefined, opts);
    expect((result.errors.nums as unknown as unknown[] | undefined)?.[0]).toBeDefined();
  });

  it('unescapes a JSON-Pointer key containing a slash', async () => {
    const resolve = jsonSchemaResolver(arraySchema);
    const result = await resolve({ 'a/b': 123 }, undefined, opts);
    expect(result.errors['a/b']).toBeDefined();
  });
});
