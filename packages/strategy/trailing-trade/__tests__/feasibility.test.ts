import type { SymbolFilters } from '@app/strategy-core';
import { describe, expect, it } from 'vitest';
import { checkTTOrderFeasibility } from '../src/feasibility.js';
import { TTConfigSchema, type TTConfig } from '../src/schema.js';

// minQty 0.001 sits above stepSize 0.0001, so a small-but-nonzero budget can
// size below minQty without hitting zero — exercises both the min-qty and
// min-notional branches at a price of 100.
const FILTERS: SymbolFilters = {
  minNotional: '10',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.001',
  maxQty: '9000',
  minPrice: '0.01',
  maxPrice: '1000000',
};

const base = (over: Record<string, unknown> = {}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '20' } },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    ...over,
  });

const grid = (amounts: string[]): TTConfig =>
  base({
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '20' },
      gridLevels: amounts.map((maxPurchaseAmount, i) => ({
        triggerPercentage: i === 0 ? '1' : (0.99 - i * 0.02).toFixed(2),
        maxPurchaseAmount,
      })),
    },
  });

const run = (
  config: TTConfig,
  price = '100',
  availableQuote = '100000',
): readonly { level: string; code: string; path?: readonly string[] }[] =>
  checkTTOrderFeasibility({ config, filters: FILTERS, price, availableQuote });

const codes = (...args: Parameters<typeof run>): string[] => run(...args).map((d) => d.code);

describe('checkTTOrderFeasibility', () => {
  describe('inputs it cannot check', () => {
    it('returns nothing when the symbol filters are unreadable', () => {
      const bad: SymbolFilters = { ...FILTERS, stepSize: '0' };
      expect(
        checkTTOrderFeasibility({
          config: base(),
          filters: bad,
          price: '100',
          availableQuote: '100000',
        }),
      ).toEqual([]);
    });

    it('returns nothing when the price is unparseable', () => {
      expect(codes(base(), 'abc')).toEqual([]);
    });

    it('returns nothing when the available balance is unparseable', () => {
      expect(codes(base(), '100', 'xyz')).toEqual([]);
    });

    it('returns nothing when the price is not positive', () => {
      expect(codes(base(), '0')).toEqual([]);
    });

    it('returns nothing for percent-of-account entry sizing (risk-sized, unchecked)', () => {
      const c = base({
        buy: { enabled: true, entrySizing: { mode: 'percentOfAccount', percent: '0.5' } },
      });
      expect(run(c)).toEqual([]);
    });
  });

  describe('fixed no-grid entry', () => {
    it('is clean when the entry funds and clears the minimum', () => {
      expect(run(base())).toEqual([]);
    });

    it('blocks when the entry sizes below the minimum notional', () => {
      const c = base({ buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '5' } } });
      const d = run(c);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        level: 'block',
        code: 'order-below-min-notional',
        path: ['buy', 'entrySizing', 'amount'],
      });
    });

    it('blocks when the entry sizes below the minimum quantity at this price', () => {
      const c = base({ buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '0.05' } } });
      expect(codes(c)).toContain('order-below-min-qty');
      expect(run(c)[0]?.level).toBe('block');
    });

    it('skips the funding check when the balance is unknown but still checks minimums', () => {
      // No availableQuote: funding is unknowable, so a would-be shortfall must
      // NOT block, but a sub-minimum order still must.
      const fundOk = checkTTOrderFeasibility({ config: base(), filters: FILTERS, price: '100' });
      expect(fundOk).toEqual([]);
      const sub = checkTTOrderFeasibility({
        config: base({ buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '5' } } }),
        filters: FILTERS,
        price: '100',
      });
      expect(sub.map((d) => d.code)).toEqual(['order-below-min-notional']);
    });

    it('blocks when the balance cannot fund the entry', () => {
      const d = run(base(), '100', '10');
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        level: 'block',
        code: 'grid-underfunded',
        path: ['buy', 'entrySizing', 'amount'],
      });
      expect(d[0]?.message).toContain('0 of 1');
    });
  });

  describe('grid ladder', () => {
    it('is clean when every level funds and clears the minimum', () => {
      expect(run(grid(['20', '20', '20']))).toEqual([]);
    });

    it('blocks the specific level that sizes below the minimum notional', () => {
      const d = run(grid(['5', '20']));
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        level: 'block',
        code: 'order-below-min-notional',
        path: ['buy', 'gridLevels', '0', 'maxPurchaseAmount'],
      });
    });

    it('blocks with the funded-level count when the balance cannot fund the full grid', () => {
      const d = run(grid(['20', '20', '20']), '100', '50');
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        level: 'block',
        code: 'grid-underfunded',
        path: ['buy', 'gridLevels'],
      });
      expect(d[0]?.message).toContain('2 of 3');
      expect(d[0]?.message).toContain('all 3 levels');
    });

    it('reports both a per-level minimum block and an underfunded block together', () => {
      const codeset = codes(grid(['5', '20', '20']), '100', '10');
      expect(codeset).toContain('order-below-min-notional');
      expect(codeset).toContain('grid-underfunded');
    });
  });
});
