// Defensive parse-failure / skip guards reachable through the full
// trailingTrade.tick() with raw (unvalidated) config or wire values. The live
// worker hands the strategy stored config without re-parsing, so a hand-edited
// db row or a malformed snapshot field can reach these branches; each must
// surface a typed warn or a skip rather than crash the tick.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import {
  trailingTrade,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';

const NOW_MS = 1_700_000_000_000;

const strongSellBundle = (): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: false,
            whenBuy: false,
            whenSell: false,
            whenStrongSell: true,
            whenNeutral: false,
          },
        ],
      },
      signals: [
        {
          interval: '1m',
          signal: {
            symbol: 'BTCUSDT',
            recommendation: 'STRONG_SELL',
            maRecommendation: null,
            oscRecommendation: null,
            receivedAtMs: NOW_MS,
            indicators: null,
          },
        },
      ],
    },
    override: null,
  });

// Raw config (cast, not schema-parsed) so a corrupted decimal field survives to
// the tick the way the live worker delivers stored config.
const rawConfig = (sell: Record<string, unknown>, buy: Record<string, unknown> = {}): TTConfig =>
  ({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      gridLevels: [],
      firstBuyTriggerBasis: 'immediate',
      autoTriggerBuy: { enabled: false, triggerAfterMinutes: 20, rescheduleWhileDisabled: false },
      indicatorGate: {},
      ...buy,
    },
    sell: {
      enabled: true,
      stopLossPercentage: '',
      triggerPercentage: '1.05',
      trailingStopPercentage: '0',
      atrTrailing: { enabled: false, period: 14, multiplier: '3' },
      ...sell,
    },
    forceBuyOverride: { checkTechnicals: true },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    regime: {},
  }) as unknown as TTConfig;

const input = (opts: {
  config: TTConfig;
  state: TTState;
  currentPrice?: string;
  minQty?: string;
  bundle?: TTBundle;
  balances?: Record<string, { asset: string; free: Decimal; locked: Decimal }>;
  openOrders?: readonly OpenOrder[];
}): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    clock: { nowMs: () => NOW_MS },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '2.0.0',
    },
    config: opts.config,
    state: opts.state,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: opts.currentPrice ?? '95',
      candlesByInterval: {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          minNotional: '10',
          tickSize: '0.01',
          stepSize: '0.0001',
          minQty: opts.minQty ?? '0.0001',
          maxQty: '9000',
          minPrice: '0.01',
          maxPrice: '1000000',
        },
      },
    },
    account: { balances: opts.balances ?? {}, readable: true },
    openOrders: opts.openOrders ?? [],
    bundle: opts.bundle ?? strongSellBundle(),
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const heldState = (overrides: Partial<TTState> = {}): TTState =>
  ({
    ...trailingTrade.initialState(rawConfig({})),
    avgEntryPrice: '90',
    heldQuantity: '0.2',
    currentGridTradeIndex: 0,
    ...overrides,
  }) as TTState;

describe('trailingTrade.tick — force-sell preamble parse guard', () => {
  it('emits a tt-sell-gate-parse-failed warn when the force-sell trigger is corrupted', () => {
    // Held position + corrupted sell.triggerPercentage: the force-sell
    // trigger-price computation fails and surfaces a warn before the gate runs.
    const config = rawConfig({ triggerPercentage: 'corrupt' });
    const out = trailingTrade.tick(input({ config, state: heldState() }));
    expect(
      out.logs.some(
        (l) =>
          l.message === 'tt-sell-gate-parse-failed' &&
          l.context?.['source'] === 'technicals-force-sell',
      ),
    ).toBe(true);
  });
});

describe('trailingTrade.tick — force-sell emission skip', () => {
  it('records the sell-sizing skip log when force-sell fires but the held qty is below min', () => {
    // Force-sell conditions met (held, in profit at 95 vs entry 90, below the
    // 1.05 trigger, fresh STRONG_SELL) but the wallet free balance is below
    // minQty so computeSellQuantity skips → the skip log is surfaced.
    // Entry 90, trigger 1.05 → trigger price 94.5. Price 93 is below the
    // trigger (force-sell can fire) and above entry (in profit).
    const config = rawConfig({ triggerPercentage: '1.05' });
    const out = trailingTrade.tick(
      input({
        config,
        state: heldState(),
        currentPrice: '93',
        minQty: '1000',
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.0001'), locked: new Decimal(0) } },
      }),
    );
    // No SELL order placed because sizing skipped; the tick still terminates
    // cleanly with a snapshot and records the force-sell skip log.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.logs.some((l) => l.message === 'tt-technicals-force-sell-skipped')).toBe(true);
  });
});

describe('trailingTrade.tick — buy-gate skip dispatch', () => {
  const sellSignalBundle = (): TTBundle =>
    TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [
          {
            interval: '1m',
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'SELL',
              maRecommendation: null,
              oscRecommendation: null,
              receivedAtMs: NOW_MS,
              indicators: null,
            },
          },
        ],
      },
      override: null,
    });

  // A single grid level (length > 0) routes the buy through the grid path so the
  // skip-tv / skip-filter dispatch arms (not the non-grid single-buy path) fire.
  const gridLevels = [{ triggerPercentage: '1', maxPurchaseAmount: '50' }];

  it('records a technicals veto (skip-tv) on a grid flat-entry SELL signal', () => {
    // Flat profile, immediate grid entry, technicals SELL → the entry buy gate
    // vetoes (skip-tv) and the tick surfaces the gate-veto log.
    const config = rawConfig({}, { firstBuyTriggerBasis: 'immediate', gridLevels });
    const out = trailingTrade.tick(
      input({ config, state: trailingTrade.initialState(config), bundle: sellSignalBundle() }),
    );
    expect(out.logs.some((l) => l.message === 'tt-technicals-gate-veto')).toBe(true);
  });

  it('clamps a future-dated veto signal age to zero in the gate-veto log', () => {
    // The veto signal's receivedAtMs is ahead of now (clock skew) so the logged
    // ageMs clamps to 0 rather than going negative.
    const futureBundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'allow-anyway',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [
          {
            interval: '1m',
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'SELL',
              maRecommendation: null,
              oscRecommendation: null,
              receivedAtMs: NOW_MS + 60_000,
              indicators: null,
            },
          },
        ],
      },
      override: null,
    });
    const config = rawConfig({}, { firstBuyTriggerBasis: 'immediate' });
    const out = trailingTrade.tick(
      input({ config, state: trailingTrade.initialState(config), bundle: futureBundle }),
    );
    const veto = out.logs.find((l) => l.message === 'tt-technicals-gate-veto');
    expect(veto?.context?.['ageMs']).toBe(0);
  });

  it('records a filter skip (skip-filter) when the first-buy notional is below the symbol minimum', () => {
    // Flat profile, immediate entry, technicals gate open (empty intervals), but
    // maxPurchaseAmount is below minNotional so the sized order is rejected.
    const openBundle = TTBundleSchema.parse({
      technicals: {
        config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
        signals: [],
      },
      override: null,
    });
    // Schema-parsed so the indicator gate carries its 'off' defaults (a raw {}
    // would leave them undefined and veto before the filter check).
    const config = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '1' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '1' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    }) as TTConfig;
    const out = trailingTrade.tick(
      input({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '50000',
        bundle: openBundle,
      }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });
});

describe('trailingTrade.tick — avgEntryPrice-clear parse guards', () => {
  const clearBundle = (): TTBundle =>
    TTBundleSchema.parse({
      technicals: {
        config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
        signals: [],
      },
      override: null,
    });

  it('warns tt-lbp-clear-parse-failed on a corrupted avgEntryPriceRemoveThreshold', () => {
    // Held position, clear armed via a non-empty threshold, but the value is
    // unparseable → warn, state unchanged.
    const config = rawConfig({}, { avgEntryPriceRemoveThreshold: 'corrupt' });
    const out = trailingTrade.tick(
      input({ config, state: heldState(), currentPrice: '95', bundle: clearBundle() }),
    );
    expect(out.logs.some((l) => l.message === 'tt-lbp-clear-parse-failed')).toBe(true);
  });

  it('does not clear when the threshold is outside the (0,1] range', () => {
    // A raw config threshold above 1 is degenerate; the clear is skipped
    // (returns null) rather than firing, and no clear log is emitted.
    const config = rawConfig({}, { avgEntryPriceRemoveThreshold: '1.5' });
    const out = trailingTrade.tick(
      input({ config, state: heldState(), currentPrice: '95', bundle: clearBundle() }),
    );
    expect(out.logs.some((l) => l.message.startsWith('tt-lbp-clear'))).toBe(false);
  });

  it('does not clear when avgEntryPrice or current price is non-positive', () => {
    // A held state whose avgEntryPrice is 0 passes the threshold range check but
    // trips the non-positive guard, so the clear is skipped (no clear log).
    const config = rawConfig({}, { avgEntryPriceRemoveThreshold: '0.99' });
    const out = trailingTrade.tick(
      input({
        config,
        state: heldState({ avgEntryPrice: '0' }),
        currentPrice: '95',
        bundle: clearBundle(),
      }),
    );
    expect(out.logs.some((l) => l.message.startsWith('tt-lbp-clear'))).toBe(false);
  });

  it('warns tt-lbp-clear-balance-parse-failed on a corrupted minQty filter', () => {
    // The clear conditions are met (price well below entry × threshold, no open
    // buy) so control reaches the balance check, where a corrupted minQty wire
    // value surfaces its own warn.
    const config = rawConfig({}, { avgEntryPriceRemoveThreshold: '0.99' });
    const out = trailingTrade.tick(
      input({
        config,
        state: heldState(),
        currentPrice: '50',
        minQty: 'corrupt',
        bundle: clearBundle(),
      }),
    );
    expect(out.logs.some((l) => l.message === 'tt-lbp-clear-balance-parse-failed')).toBe(true);
  });

  it('warns tt-lbp-clear-parse-failed on a corrupted avgEntryPrice (held row)', () => {
    // Threshold parses but the stored avgEntryPrice is unparseable: the
    // second parse in declared order surfaces the warn, state unchanged.
    const config = rawConfig({}, { avgEntryPriceRemoveThreshold: '0.99' });
    const out = trailingTrade.tick(
      input({
        config,
        state: heldState({ avgEntryPrice: 'corrupt' }),
        currentPrice: '95',
        bundle: clearBundle(),
      }),
    );
    expect(out.logs.some((l) => l.message === 'tt-lbp-clear-parse-failed')).toBe(true);
  });

  it('warns tt-lbp-clear-parse-failed on a corrupted currentPrice', () => {
    // Threshold and avgEntryPrice parse but currentPrice does not: the third
    // parse in declared order surfaces the same warn.
    const config = rawConfig({}, { avgEntryPriceRemoveThreshold: '0.99' });
    const out = trailingTrade.tick(
      input({ config, state: heldState(), currentPrice: 'corrupt', bundle: clearBundle() }),
    );
    expect(out.logs.some((l) => l.message === 'tt-lbp-clear-parse-failed')).toBe(true);
  });
});
