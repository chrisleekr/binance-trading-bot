import { describe, expect, it } from 'vitest';
import {
  RebalanceConfigSchema,
  RebalanceOverrideConfigSchema,
  RebalanceStateSchema,
  defaultRebalanceConfig,
  initialRebalanceState,
} from '../src/schema.js';

describe('rebalance schema', () => {
  it('default config is disabled with an empty basket and schema defaults', () => {
    const c = defaultRebalanceConfig();
    expect(c.enabled).toBe(false);
    expect(c.targets).toEqual([]);
    expect(c.driftThreshold).toBe('0.05');
    expect(c.minTradeQuote).toBe('10');
    expect(c.candleInterval).toBe('1h');
    expect(c.basketBudgetQuote).toBe('0'); // maintain-only until the operator funds a budget
    // Weight mode defaults to fixed; momentum tuning carries its own defaults.
    expect(c.weightMode).toBe('fixed');
    expect(c.momentum).toEqual({ lookbackCandles: 30, topK: 3 });
  });

  it('parses a momentum-mode config with custom tuning', () => {
    const c = RebalanceConfigSchema.parse({
      enabled: true,
      weightMode: 'momentum',
      momentum: { lookbackCandles: 14, topK: 5 },
    });
    expect(c.weightMode).toBe('momentum');
    expect(c.momentum).toEqual({ lookbackCandles: 14, topK: 5 });
  });

  it('rejects an unknown weight mode and out-of-range momentum tuning', () => {
    expect(RebalanceConfigSchema.safeParse({ weightMode: 'random' }).success).toBe(false);
    expect(RebalanceConfigSchema.safeParse({ momentum: { topK: 0 } }).success).toBe(false);
    expect(RebalanceConfigSchema.safeParse({ momentum: { lookbackCandles: 1 } }).success).toBe(
      false,
    );
  });

  it('parses a configured basket', () => {
    const c = RebalanceConfigSchema.parse({
      enabled: true,
      targets: [
        { symbol: 'BTCUSDT', weight: '0.6' },
        { symbol: 'ETHUSDT', weight: '0.4' },
      ],
    });
    expect(c.targets).toHaveLength(2);
    expect(c.enabled).toBe(true);
  });

  it('rejects a weight outside (0, 1]', () => {
    expect(
      RebalanceConfigSchema.safeParse({ targets: [{ symbol: 'X', weight: '1.5' }] }).success,
    ).toBe(false);
  });

  it('rejects a basket whose weights sum above 1', () => {
    // Each weight is individually valid (<=1) but together they over-allocate
    // the budget, so the basket is rejected.
    expect(
      RebalanceConfigSchema.safeParse({
        targets: [
          { symbol: 'BTCUSDT', weight: '0.6' },
          { symbol: 'ETHUSDT', weight: '0.6' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a negative basketBudgetQuote', () => {
    expect(RebalanceConfigSchema.safeParse({ basketBudgetQuote: '-1' }).success).toBe(false);
  });

  it('override accepts a partial targets list and rejects unknown keys', () => {
    expect(
      RebalanceOverrideConfigSchema.parse({ targets: [{ symbol: 'X', weight: '0.5' }] }).targets,
    ).toHaveLength(1);
    expect(RebalanceOverrideConfigSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('initial state is flat at the current schema version', () => {
    const s = initialRebalanceState();
    expect(s).toEqual({ schemaVersion: '1.0.0', avgEntryPrice: null, heldQuantity: null });
    expect(RebalanceStateSchema.parse(s)).toEqual(s);
  });
});
