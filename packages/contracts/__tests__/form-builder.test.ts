import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  applyJsonSchemaDefaults,
  buildFormFieldsFromJsonSchema,
  WIDGET_TAG_PREFIX,
} from '../src/form-builder.js';

// The live export renders from JSON Schema over the wire. These cases are
// authored as zod schemas for brevity, so convert here exactly as the API
// registry does (`io: 'input'` so a `.default()` is optional, not required).
const buildFromZod = (schema: z.ZodType) =>
  buildFormFieldsFromJsonSchema(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));

describe('@app/contracts/form-builder', () => {
  it('extracts a flat object of primitive fields with labels and required flags', () => {
    const schema = z.object({
      symbol: z.string(),
      enabled: z.boolean(),
      maxPurchaseAmount: z.string().optional(),
    });
    const fields = buildFromZod(schema);
    expect(fields).toHaveLength(3);
    const [symbol, enabled, max] = fields;
    expect(symbol).toMatchObject({
      path: 'symbol',
      kind: 'string',
      required: true,
      label: 'Symbol',
    });
    expect(enabled).toMatchObject({ path: 'enabled', kind: 'boolean', required: true });
    expect(max).toMatchObject({
      path: 'maxPurchaseAmount',
      required: false,
      label: 'Max Purchase Amount',
    });
  });

  it('marks a field with a zod default as optional, not required', () => {
    // The form is an input surface: a `.default()` field may be omitted on
    // input, so it must not carry a required flag. (Output-mode conversion
    // would wrongly mark it required since the parsed value is always set.)
    const schema = z.object({
      symbol: z.string(),
      candleInterval: z.enum(['1m', '1h']).default('1h'),
      gridLevels: z.array(z.string()).default([]),
    });
    const fields = buildFromZod(schema);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f.required]));
    expect(byPath).toEqual({ symbol: true, candleInterval: false, gridLevels: false });
  });

  it('upper-cases domain acronyms in derived labels', () => {
    // Keys without a LABEL_OVERRIDES entry so the assertion exercises titleCase
    // acronym upper-casing, not the override map.
    const schema = z.object({
      rsiValue: z.string(),
      smaWindow: z.string(),
      emaSpan: z.string(),
      usdtAmount: z.string(),
      ttlSeconds: z.string(),
      ma: z.string(),
      atrTrailing: z.string(),
    });
    const fields = buildFromZod(schema);
    expect(fields.map((f) => f.label)).toEqual([
      'RSI Value',
      'SMA Window',
      'EMA Span',
      'USDT Amount',
      'TTL Seconds',
      'MA',
      'ATR Trailing',
    ]);
  });

  it('applies the trailingStopPct label override instead of the awkward auto-label', () => {
    // The auto-label would read "Trailing Stop Pct"; the override names the
    // operator-facing meaning (the field renders with the percent-converting
    // widget, so the operator types a plain percent).
    const schema = z.object({ trailingStopPct: z.string() });
    const fields = buildFromZod(schema);
    expect(fields[0]).toMatchObject({
      path: 'trailingStopPct',
      label: 'Trailing-stop distance (from peak)',
    });
  });

  it('matches the trailingStopPct override on a dotted suffix, not just the bare key', () => {
    // The field is always nested under the strategy config on the wire, so the
    // production path is `…trailingStopPct` — exercise the `endsWith('.key')`
    // branch of pickOverride, not only the exact-match branch above.
    const schema = z.object({ momentum: z.object({ trailingStopPct: z.string() }) });
    const [group] = buildFromZod(schema);
    expect(group).toMatchObject({ path: 'momentum', kind: 'object' });
    if (!group) throw new Error('buildFromZod returned no fields');
    const nested = group.kind === 'object' ? group.fields[0] : undefined;
    expect(nested).toMatchObject({
      path: 'momentum.trailingStopPct',
      label: 'Trailing-stop distance (from peak)',
    });
  });

  it('names the auto-discovery fields whose auto-labels read as jargon', () => {
    // Title-casing turns these into "Refresh Period Ms" / "Min24h Pair Volume Usd"
    // / "Rank Top Percent"; the overrides name the meaning + unit instead.
    const schema = z.object({
      refreshPeriodMs: z.number(),
      min24hPairVolumeUsd: z.string(),
      min24hAssetVolumeUsd: z.string(),
      maxSpreadRatio: z.string(),
      changeMinPercent: z.string(),
      rankTopPercent: z.number(),
      rankExcludeTopPercent: z.number(),
      minAgeDays: z.number(),
      minHoldMinutes: z.number(),
      blacklist: z.array(z.string()),
    });
    expect(buildFromZod(schema).map((f) => f.label)).toEqual([
      'Scan interval (ms)',
      'Min 24h volume on this market (USD)',
      'Min 24h volume for the coin (USD)',
      'Max bid/ask spread',
      'Min 24h gain (%)',
      'Consider top % of gainers',
      'Skip hottest % of gainers',
      'Min listing age (days)',
      'Min hold (minutes)',
      'Blocklist',
    ]);
  });

  it('renders a scalar-primitive union (string | number) as a string field', () => {
    const schema = z.object({
      chatId: z.union([z.string(), z.number()]),
    });
    const fields = buildFromZod(schema);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ path: 'chatId', kind: 'string', required: true });
  });

  it('drops a union with no unconstrained string member rather than collapsing it', () => {
    // enum | number has no free string variant — collapsing to a text input
    // would emit values ajv's anyOf rejects, so the field is dropped instead.
    const schema = z.object({
      kept: z.string(),
      tricky: z.union([z.enum(['a', 'b']), z.number()]),
    });
    const fields = buildFromZod(schema);
    expect(fields.map((f) => f.path)).toEqual(['kept']);
  });

  it('parses widget hints out of describe() and leaves the rest as description', () => {
    const schema = z.object({
      stopLoss: z.number().describe(`${WIDGET_TAG_PREFIX}percentage trigger as a fraction`),
      bare: z.number().describe(`${WIDGET_TAG_PREFIX}price`),
      plain: z.string().describe('just a description'),
    });
    const fields = buildFromZod(schema);
    expect(fields[0]).toMatchObject({ widget: 'percentage', description: 'trigger as a fraction' });
    expect(fields[1]).toMatchObject({ widget: 'price', description: null });
    expect(fields[2]).toMatchObject({ widget: null, description: 'just a description' });
  });

  it('parses the @ui:advanced tier flag alongside an optional widget hint', () => {
    const schema = z.object({
      // advanced + widget, advanced first
      tiered: z
        .number()
        .describe(`${WIDGET_TAG_PREFIX}advanced ${WIDGET_TAG_PREFIX}percentage how far`),
      // advanced + widget, widget first (order must not matter for either flag)
      reordered: z
        .number()
        .describe(`${WIDGET_TAG_PREFIX}percentage ${WIDGET_TAG_PREFIX}advanced how far`),
      // advanced only, no widget
      flagged: z.number().describe(`${WIDGET_TAG_PREFIX}advanced just advanced`),
      // advanced only, NO trailing text — exercises the `space === -1` break path
      // so `description` must be null, not the literal "advanced"
      bareAdvanced: z.number().describe(`${WIDGET_TAG_PREFIX}advanced`),
      // plain field defaults to not-advanced
      plain: z.number().describe('nothing special'),
    });
    const fields = buildFromZod(schema);
    expect(fields[0]).toMatchObject({
      advanced: true,
      widget: 'percentage',
      description: 'how far',
    });
    expect(fields[1]).toMatchObject({
      advanced: true,
      widget: 'percentage',
      description: 'how far',
    });
    expect(fields[2]).toMatchObject({ advanced: true, widget: null, description: 'just advanced' });
    expect(fields[3]).toMatchObject({ advanced: true, widget: null, description: null });
    expect(fields[4]).toMatchObject({
      advanced: false,
      widget: null,
      description: 'nothing special',
    });
  });

  it('renders nested objects as object fields with recursive `fields`', () => {
    const schema = z.object({
      buy: z.object({
        enabled: z.boolean(),
        maxPurchaseAmount: z.string(),
      }),
    });
    const fields = buildFromZod(schema);
    expect(fields[0]?.kind).toBe('object');
    if (fields[0]?.kind !== 'object') throw new Error('expected object');
    expect(fields[0].fields).toHaveLength(2);
    expect(fields[0].fields[0]?.path).toBe('buy.enabled');
    expect(fields[0].fields[1]?.path).toBe('buy.maxPurchaseAmount');
  });

  it('renders arrays with a template `element` describing one row', () => {
    const schema = z.object({
      gridTrade: z.array(
        z.object({
          triggerPercentage: z.number().describe(`${WIDGET_TAG_PREFIX}percentage`),
        }),
      ),
    });
    const fields = buildFromZod(schema);
    expect(fields[0]?.kind).toBe('array');
    if (fields[0]?.kind !== 'array') throw new Error('expected array');
    expect(fields[0].element.kind).toBe('object');
  });

  it('flattens enum into a string-options variant', () => {
    const schema = z.object({
      mode: z.enum(['live', 'testnet', 'demo']),
    });
    const fields = buildFromZod(schema);
    expect(fields[0]).toMatchObject({ kind: 'enum', options: ['live', 'testnet', 'demo'] });
  });

  it('captures numeric bounds and integer flag', () => {
    const schema = z.object({
      pct: z.number().min(0).max(1),
      count: z.number().int(),
    });
    const fields = buildFromZod(schema);
    const pct = fields[0];
    const count = fields[1];
    expect(pct).toMatchObject({ kind: 'number', minimum: 0, maximum: 1, integer: false });
    expect(count).toMatchObject({ kind: 'number', integer: true });
  });

  it('treats `string | null` as a plain string (nullable variant collapsed)', () => {
    const schema = z.object({ note: z.string().nullable() });
    const fields = buildFromZod(schema);
    expect(fields[0]?.kind).toBe('string');
  });

  it('throws when the root is not an object schema', () => {
    expect(() => buildFromZod(z.string() as unknown as z.ZodType)).toThrow();
  });

  it('builds fields directly from a JSON Schema object (the wire path)', () => {
    // The SPA receives JSON Schema over the wire, not a zod schema; this is
    // the entry point AutoForm uses. A nested object exercises the recursive
    // walk on raw JSON.
    const jsonSchema = {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        buy: {
          type: 'object',
          properties: { maxPurchaseAmount: { type: 'string' } },
        },
      },
      required: ['symbol'],
    };
    const fields = buildFormFieldsFromJsonSchema(jsonSchema);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ path: 'symbol', kind: 'string', required: true });
    expect(fields[1]?.kind).toBe('object');
    if (fields[1]?.kind !== 'object') throw new Error('expected object');
    expect(fields[1].fields[0]?.path).toBe('buy.maxPurchaseAmount');
  });
});

describe('applyJsonSchemaDefaults', () => {
  const schema = {
    type: 'object',
    properties: {
      candleInterval: { type: 'string', default: '1h' },
      buy: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          indicatorGate: { type: 'object', default: { smaBias: 'off' } },
        },
      },
    },
  };

  it('fills a field missing from the values with the schema default', () => {
    // A config saved before `indicatorGate` existed lacks `buy.indicatorGate`.
    expect(applyJsonSchemaDefaults(schema, { buy: { enabled: true } })).toEqual({
      candleInterval: '1h',
      buy: { enabled: true, indicatorGate: { smaBias: 'off' } },
    });
  });

  it('keeps a supplied value over the schema default', () => {
    expect(applyJsonSchemaDefaults(schema, { candleInterval: '5m' })['candleInterval']).toBe('5m');
  });

  it('returns the bare defaults when values is empty or not an object', () => {
    expect(applyJsonSchemaDefaults(schema, {})).toMatchObject({ candleInterval: '1h' });
    expect(applyJsonSchemaDefaults(schema, null)).toMatchObject({ candleInterval: '1h' });
  });
});
