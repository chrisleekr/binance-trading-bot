// Direct coverage for the forced-first-entry guards that the behavioural
// suites reach only indirectly: the disabled-until short-circuit on
// emitFirstBuyTvForced and the wait/skip-filter arms of emitForcedFirstEntry.

import { describe, expect, it } from 'vitest';
import { emitFirstBuyTvForced, emitForcedFirstEntry } from '../src/branches/first-entry.js';
import { handleOverride } from '../src/branches/override.js';
import { initialTTState, type TTConfig, type TTState, type TTBundle } from '../src/schema.js';
import { trailingTrade } from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

const config = (gridLevels: unknown[] = []): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'lowest-price',
      gridLevels,
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  }) as TTConfig;

const makeInput = (
  cfg: TTConfig,
  opts: { currentPrice?: string; openOrders?: readonly OpenOrder[]; candles1h?: unknown[] } = {},
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: cfg,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: opts.currentPrice ?? '100',
      candlesByInterval: opts.candles1h ? { '1h': opts.candles1h } : {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: FILTERS,
      },
    },
    openOrders: opts.openOrders ?? [],
    profile: { id: 'p1' },
    bundle: { technicals: {}, override: null },
    account: { balances: {}, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const disabledState = (): TTState => ({ ...initialTTState(), disabledUntilMs: 9_999_999_999_999 });

describe('emitFirstBuyTvForced', () => {
  it('skips with disabled-until when the symbol is paused', () => {
    const out = emitFirstBuyTvForced(makeInput(config()), disabledState());
    expect(out).toEqual({ kind: 'skip', reason: 'disabled-until' });
  });

  it('skips with cap-reached when the account is already at the reserve cap', () => {
    const cfg = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        accountCap: { mode: 'amount', amount: '100' },
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    }) as TTConfig;
    const input = {
      ...makeInput(cfg),
      account: { balances: {}, deployedQuoteAcrossProfiles: '100', readable: true },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;
    expect(emitFirstBuyTvForced(input, initialTTState())).toEqual({
      kind: 'skip',
      reason: 'cap-reached',
    });
  });

  it('skips with open-buy when a BUY is already resting', () => {
    const openBuy: OpenOrder = {
      orderId: 1,
      clientOrderId: 'x',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      status: 'NEW',
      price: '100',
      origQty: '0.1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      transactTimeMs: 0,
      updateTimeMs: 0,
    };
    const out = emitFirstBuyTvForced(
      makeInput(config(), { openOrders: [openBuy] }),
      initialTTState(),
    );
    expect(out).toEqual({ kind: 'skip', reason: 'open-buy' });
  });
});

describe('emitForcedFirstEntry', () => {
  it('skips with disabled-until when the symbol is paused', () => {
    const out = emitForcedFirstEntry(makeInput(config()), disabledState(), 0);
    expect(out).toEqual({ kind: 'skip', reason: 'disabled-until' });
  });

  it('waits when a lowest-price grid entry has not reached the window low', () => {
    // A lowest-price basis with no resting order and price above the window low
    // returns wait, not a skip, so the timer keeps re-checking.
    const candles = Array.from({ length: 5 }, (_, i) => ({
      openTimeMs: i,
      closeTimeMs: i + 1,
      open: '100',
      high: '100',
      low: '90',
      close: '100',
      volume: '1',
      isClosed: true,
    }));
    const cfg = config([{ triggerPercentage: '1', maxPurchaseAmount: '15' }]);
    const out = emitForcedFirstEntry(
      makeInput(cfg, { currentPrice: '150', candles1h: candles }),
      initialTTState(),
      0,
    );
    expect(out.kind).toBe('wait');
  });
});

describe('handleOverride — trigger-buy awaiting-entry', () => {
  it('reports awaiting-entry (noop) when a lowest-price entry has not reached the window low', () => {
    const candles = Array.from({ length: 5 }, (_, i) => ({
      openTimeMs: i,
      closeTimeMs: i + 1,
      open: '100',
      high: '100',
      low: '90',
      close: '100',
      volume: '1',
      isClosed: true,
    }));
    const cfg = config([{ triggerPercentage: '1', maxPurchaseAmount: '15' }]);
    const input = makeInput(cfg, { currentPrice: '150', candles1h: candles });
    const override = { kind: 'trigger-buy', overrideActionId: 'a1' };
    const withTriggerBuy = {
      ...input,
      bundle: { ...input.bundle, override },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;
    const out = handleOverride(
      withTriggerBuy,
      initialTTState(),
      0,
      override as unknown as NonNullable<TTBundle['override']>,
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs.some((l) => l.context?.['reason'] === 'awaiting-entry')).toBe(true);
  });
});
