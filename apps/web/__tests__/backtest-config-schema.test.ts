// Backtest config-form schema shaping — apps/web/src/features/backtest/lib/config-schema.ts.

import { describe, expect, it } from 'vitest';

import { omitKey, omitSchemaProperty } from '../src/features/backtest/lib/config-schema.js';

describe('omitSchemaProperty', () => {
  it('removes the property from both properties and required', () => {
    const schema = {
      type: 'object',
      properties: { symbol: { type: 'string' }, candleInterval: { type: 'string' } },
      required: ['symbol', 'candleInterval'],
      additionalProperties: false,
    };
    const out = omitSchemaProperty(schema, 'symbol');
    expect(out.properties).toEqual({ candleInterval: { type: 'string' } });
    expect(out.required).toEqual(['candleInterval']);
    expect(out.additionalProperties).toBe(false);
  });

  it('does not mutate the input', () => {
    const schema = {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    };
    omitSchemaProperty(schema, 'symbol');
    expect(schema.properties).toHaveProperty('symbol');
    expect(schema.required).toEqual(['symbol']);
  });

  it('is a no-op in shape when the property is absent', () => {
    const schema = { type: 'object', properties: { candleInterval: { type: 'string' } } };
    const out = omitSchemaProperty(schema, 'symbol');
    expect(out.properties).toEqual({ candleInterval: { type: 'string' } });
  });

  it('tolerates a schema with no required array', () => {
    const schema = { type: 'object', properties: { symbol: { type: 'string' } } };
    const out = omitSchemaProperty(schema, 'symbol');
    expect(out.properties).toEqual({});
    expect(out.required).toBeUndefined();
  });
});

describe('omitKey', () => {
  it('removes the key without mutating the input', () => {
    const config = { symbol: 'BTCUSDT', candleInterval: '1h' };
    const out = omitKey(config, 'symbol');
    expect(out).toEqual({ candleInterval: '1h' });
    expect(config).toHaveProperty('symbol', 'BTCUSDT');
  });
});
