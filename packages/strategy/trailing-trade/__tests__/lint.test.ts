import { describe, expect, it } from 'vitest';
import { TTConfigSchema, type TTConfig } from '../src/schema.js';
import { lintTTConfig } from '../src/lint.js';

const SYMBOL = 'BTCUSDT';

// Minimal valid base config; tests override the slices each rule reads.
const base = (over: Record<string, unknown> = {}): TTConfig =>
  TTConfigSchema.parse({
    symbol: SYMBOL,
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '15' } },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    ...over,
  });

const codes = (c: TTConfig): string[] => lintTTConfig(c).map((d) => d.code);

describe('lintTTConfig', () => {
  it('is clean on a plain no-grid config', () => {
    expect(lintTTConfig(base())).toEqual([]);
  });

  describe('maker-offset-inert-market', () => {
    it('flags a non-zero maker offset while entry mode is market', () => {
      const c = base({ execution: { entryMode: 'market', makerOffsetBps: '5' } });
      expect(codes(c)).toContain('maker-offset-inert-market');
    });

    it('does not flag the default zero offset', () => {
      expect(codes(base())).not.toContain('maker-offset-inert-market');
    });

    it('does not flag the offset in maker mode (it is used there)', () => {
      const c = base({
        execution: { entryMode: 'maker', makerOffsetBps: '5' },
        fees: { makerBps: '7.5', takerBps: '10' },
      });
      expect(codes(c)).not.toContain('maker-offset-inert-market');
    });
  });

  describe('entry-timeout-inert-market', () => {
    it('flags a non-zero entry timeout while entry mode is market', () => {
      const c = base({ execution: { entryMode: 'market', entryTimeoutBars: 5 } });
      expect(codes(c)).toContain('entry-timeout-inert-market');
    });

    it('does not flag the default zero timeout', () => {
      expect(codes(base())).not.toContain('entry-timeout-inert-market');
    });

    it('does not flag the timeout in maker mode (it is used there)', () => {
      const c = base({
        execution: { entryMode: 'maker', entryTimeoutBars: 5 },
        fees: { makerBps: '7.5', takerBps: '10' },
      });
      expect(codes(c)).not.toContain('entry-timeout-inert-market');
    });
  });

  describe('maker-mode-zero-maker-fee', () => {
    it('warns when maker entry mode runs with a zero maker fee', () => {
      const c = base({ execution: { entryMode: 'maker' } });
      expect(codes(c)).toContain('maker-mode-zero-maker-fee');
    });

    it('does not warn once a maker fee is set', () => {
      const c = base({
        execution: { entryMode: 'maker' },
        fees: { makerBps: '7.5', takerBps: '10' },
      });
      expect(codes(c)).not.toContain('maker-mode-zero-maker-fee');
    });

    it('does not warn in market mode regardless of the maker fee', () => {
      expect(codes(base())).not.toContain('maker-mode-zero-maker-fee');
    });
  });

  describe('entry-sizing-ignored-in-grid', () => {
    it('flags a set entry size when a grid ladder is configured', () => {
      const c = base({
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '15' },
          gridLevels: [
            { triggerPercentage: '1', maxPurchaseAmount: '15' },
            { triggerPercentage: '0.99', maxPurchaseAmount: '15' },
          ],
        },
      });
      expect(codes(c)).toContain('entry-sizing-ignored-in-grid');
    });

    it('flags a percent entry size under grid too', () => {
      const c = base({
        buy: {
          enabled: true,
          entrySizing: { mode: 'percentOfAccount', percent: '0.05' },
          gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
        },
      });
      expect(codes(c)).toContain('entry-sizing-ignored-in-grid');
    });

    it('does not flag entry sizing with no grid', () => {
      expect(codes(base())).not.toContain('entry-sizing-ignored-in-grid');
    });
  });

  describe('candle-limit-inert-immediate', () => {
    it('flags a non-default candleLimit in immediate mode', () => {
      const c = base({
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '15' },
          firstBuyTriggerBasis: 'immediate',
          candleLimit: 120,
        },
      });
      expect(codes(c)).toContain('candle-limit-inert-immediate');
    });

    it('does not flag the default candleLimit in immediate mode', () => {
      const c = base({
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '15' },
          firstBuyTriggerBasis: 'immediate',
          candleLimit: 60,
        },
      });
      expect(codes(c)).not.toContain('candle-limit-inert-immediate');
    });

    it('does not flag candleLimit in lowest-price mode', () => {
      const c = base({
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '15' },
          firstBuyTriggerBasis: 'lowest-price',
          candleLimit: 120,
        },
      });
      expect(codes(c)).not.toContain('candle-limit-inert-immediate');
    });
  });

  describe('rearm inert', () => {
    it('flags rearm enabled while exitToCash is on', () => {
      const c = base({
        regime: { onBear: { exitToCash: true, rearm: { enabled: true } } },
      });
      expect(codes(c)).toContain('rearm-ignored-exit-to-cash');
    });

    it('flags rearm enabled while require-uptrend is on (no exitToCash)', () => {
      const c = base({
        regime: {
          onBear: { exitToCash: false, rearm: { enabled: true } },
          onBull: { requireEntry: true },
        },
      });
      expect(codes(c)).toContain('rearm-ignored-require-entry');
    });

    it('prefers the exit-to-cash cause when both gates are on', () => {
      const c = base({
        regime: {
          onBear: { exitToCash: true, rearm: { enabled: true } },
          onBull: { requireEntry: true },
        },
      });
      expect(codes(c)).toContain('rearm-ignored-exit-to-cash');
      expect(codes(c)).not.toContain('rearm-ignored-require-entry');
    });

    it('does not flag rearm enabled with neither gate on', () => {
      const c = base({
        regime: {
          onBear: { exitToCash: false, rearm: { enabled: true } },
          onBull: { requireEntry: false },
        },
      });
      expect(codes(c).filter((x) => x.startsWith('rearm-ignored'))).toEqual([]);
    });

    it('does not flag a gate on with rearm disabled', () => {
      const c = base({
        regime: { onBear: { exitToCash: true, rearm: { enabled: false } } },
      });
      expect(codes(c).filter((x) => x.startsWith('rearm-ignored'))).toEqual([]);
    });

    it('does not flag when regime is absent', () => {
      expect(codes(base()).filter((x) => x.startsWith('rearm-ignored'))).toEqual([]);
    });
  });

  describe('technicals-strong-buy-unchecked', () => {
    const row = (over: Record<string, unknown>) => ({
      interval: '15m',
      whenStrongBuy: true,
      whenBuy: true,
      whenSell: false,
      whenStrongSell: false,
      whenNeutral: false,
      ...over,
    });
    const withRows = (rows: unknown[]) => base({ technicals: { intervals: rows } });

    it('warns when a row allows Buy but not Strong Buy (the #534 trap)', () => {
      const c = withRows([row({ whenStrongBuy: false, whenBuy: true })]);
      expect(codes(c)).toContain('technicals-strong-buy-unchecked');
    });

    it('does not warn when only Strong Buy is allowed (intentional selectivity)', () => {
      const c = withRows([row({ whenStrongBuy: true, whenBuy: false })]);
      expect(codes(c)).not.toContain('technicals-strong-buy-unchecked');
    });

    it('does not warn when both Buy and Strong Buy are allowed', () => {
      const c = withRows([row({ whenStrongBuy: true, whenBuy: true })]);
      expect(codes(c)).not.toContain('technicals-strong-buy-unchecked');
    });

    it('points the path at the offending row whenStrongBuy box', () => {
      const c = withRows([row({ whenStrongBuy: false, whenBuy: true })]);
      const d = lintTTConfig(c).find((x) => x.code === 'technicals-strong-buy-unchecked');
      expect(d?.path).toEqual(['technicals', 'intervals', '0', 'whenStrongBuy']);
      expect(d?.level).toBe('warn');
    });
  });

  it('carries a field path on each diagnostic for the form to locate', () => {
    const c = base({
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
      },
    });
    const d = lintTTConfig(c).find((x) => x.code === 'entry-sizing-ignored-in-grid');
    expect(d?.path).toEqual(['buy', 'entrySizing']);
    expect(d?.level).toBe('warn');
  });
});
