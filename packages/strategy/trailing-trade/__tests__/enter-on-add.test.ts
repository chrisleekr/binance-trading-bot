// Discovery `enterOnAdd` first-entry mechanism (issue #434). Two layers:
//   1. `evaluateEnterOnAddFloor` — the relaxed gate: pass UNLESS a participating
//      interval reads a fresh STRONG_SELL.
//   2. `evaluateGridBuy` — the floor is consulted ONLY on a flat first entry and
//      ONLY when `bundle.entryHint.enterOnAdd` is armed; otherwise the normal
//      technicals gate runs unchanged (so the default-off path is identical).

import { describe, expect, it } from 'vitest';
import type { Candle, TickInput } from '@app/strategy-core';
import type { TechnicalsBundle } from '@app/contracts';

import { evaluateEnterOnAddFloor } from '../src/technicals-gate.js';
import { evaluateGridBuy } from '../src/branches/grid-buy.js';
import { trailingTrade } from '../src/index.js';
import {
  initialTTState,
  type TTBundle,
  type TTConfig,
  type TTEntryHintBundle,
  type TTState,
} from '../src/schema.js';

const NOW_MS = 1_700_000_000_000;
const override = { checkTechnicals: true } as const;

const intervalRow = (interval: string, overrides?: { mode?: 'block' | 'advisory' }) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  mode: 'block' as const,
  ...overrides,
});

const sig = (
  recommendation: 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL' | 'STRONG_BUY',
  ageMs = 0,
): TechnicalsBundle['signals'][number]['signal'] => ({
  symbol: 'BTCUSDT',
  recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: NOW_MS - ageMs,
  indicators: null,
});

const tv = (
  rows: ReturnType<typeof intervalRow>[],
  signals: { interval: string; signal: TechnicalsBundle['signals'][number]['signal'] }[],
  useOnlyWithinMin = 2,
  ifExpires: 'do-not-buy' | 'allow-anyway' = 'do-not-buy',
): TechnicalsBundle => ({ config: { useOnlyWithinMin, ifExpires, intervals: rows }, signals });

describe('evaluateEnterOnAddFloor', () => {
  it('passes on SELL — the relaxation (the normal gate would veto)', () => {
    const out = evaluateEnterOnAddFloor(
      tv([intervalRow('5m')], [{ interval: '5m', signal: sig('SELL') }]),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('vetoes on a fresh STRONG_SELL — the downside floor still holds', () => {
    const out = evaluateEnterOnAddFloor(
      tv([intervalRow('5m')], [{ interval: '5m', signal: sig('STRONG_SELL') }]),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '5m' });
  });

  it('passes a STRONG_SELL that is stale under do-not-buy (no reliable collapsing-now read)', () => {
    const out = evaluateEnterOnAddFloor(
      tv([intervalRow('5m')], [{ interval: '5m', signal: sig('STRONG_SELL', 5 * 60_000) }], 2),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('passes on a missing signal and on NEUTRAL/BUY (no short-interval confirmation required)', () => {
    expect(
      evaluateEnterOnAddFloor(
        tv([intervalRow('5m')], [{ interval: '5m', signal: null }]),
        override,
        NOW_MS,
      ).ok,
    ).toBe(true);
    expect(
      evaluateEnterOnAddFloor(
        tv([intervalRow('5m')], [{ interval: '5m', signal: sig('NEUTRAL') }]),
        override,
        NOW_MS,
      ).ok,
    ).toBe(true);
  });

  it('vetoes if ANY participating interval reads a fresh STRONG_SELL', () => {
    const out = evaluateEnterOnAddFloor(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('BUY') },
          { interval: '1h', signal: sig('STRONG_SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '1h' });
  });

  it('does not promote an advisory STRONG_SELL to a veto', () => {
    const out = evaluateEnterOnAddFloor(
      tv(
        [intervalRow('1h', { mode: 'advisory' })],
        [{ interval: '1h', signal: sig('STRONG_SELL') }],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
    expect(out.intervalsConsulted).toEqual([
      { interval: '1h', recommendation: 'STRONG_SELL', verdict: 'technicals-sell', advisory: true },
    ]);
  });

  it('clamps a future-dated STRONG_SELL signal age to zero and still vetoes', () => {
    // Clock skew can place receivedAtMs ahead of nowMs (negative raw age).
    // The age clamps to 0 (treated as fresh), so the downside floor holds.
    const out = evaluateEnterOnAddFloor(
      tv([intervalRow('5m')], [{ interval: '5m', signal: sig('STRONG_SELL', -60_000) }], 2),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '5m' });
  });

  it('opens fully when Technicals is off (checkTechnicals=false) or no intervals configured', () => {
    expect(
      evaluateEnterOnAddFloor(
        tv([intervalRow('5m')], [{ interval: '5m', signal: sig('STRONG_SELL') }]),
        { checkTechnicals: false },
        NOW_MS,
      ).ok,
    ).toBe(true);
    expect(evaluateEnterOnAddFloor(tv([], []), override, NOW_MS).ok).toBe(true);
  });
});

// ── Integration: the floor is consulted only on a flat first entry with the hint ──

const candle = (px: string): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 0,
  open: px,
  high: px,
  low: px,
  close: px,
  volume: '1',
  isClosed: true,
});

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

// A profile whose buy gate consults a single 5m technicals interval.
const entryConfig = (): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [intervalRow('5m')],
    },
  }) as TTConfig;

const makeInput = (
  config: TTConfig,
  technicals: TechnicalsBundle,
  entryHint: TTEntryHintBundle | undefined,
  currentPrice = '100',
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config,
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: { '1h': [candle('100'), candle('100'), candle('100')] },
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: FILTERS,
      },
    },
    openOrders: [],
    profile: { id: 'p1' },
    account: { balances: { USDT: { free: '1000', locked: '0' } }, readable: true },
    bundle: { technicals, override: null, entryHint },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

describe('evaluateGridBuy — enterOnAdd entry relaxation (issue #434)', () => {
  const sellTv = tv([intervalRow('5m')], [{ interval: '5m', signal: sig('SELL') }]);
  const strongSellTv = tv([intervalRow('5m')], [{ interval: '5m', signal: sig('STRONG_SELL') }]);

  it('default off (no hint): a SELL signal vetoes the first entry (unchanged behavior)', () => {
    const result = evaluateGridBuy(
      makeInput(entryConfig(), sellTv, undefined),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'skip-tv', veto: 'technicals-sell' });
  });

  it('hint armed: the SELL veto is lifted and the first entry is placed', () => {
    const result = evaluateGridBuy(
      makeInput(entryConfig(), sellTv, { enterOnAdd: true }),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
  });

  it('hint armed but STRONG_SELL: the floor still vetoes the entry', () => {
    const result = evaluateGridBuy(
      makeInput(entryConfig(), strongSellTv, { enterOnAdd: true }),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'skip-tv', veto: 'technicals-sell' });
  });

  it('hint present but enterOnAdd=false is treated as not armed (normal gate vetoes SELL)', () => {
    const result = evaluateGridBuy(
      makeInput(entryConfig(), sellTv, { enterOnAdd: false }),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'skip-tv', veto: 'technicals-sell' });
  });

  it('is inert on a promotion (averaging-down add): an armed hint does not relax a non-first-entry', () => {
    // Two-level grid; a held position sitting at the level-1 trigger (100 × 0.95).
    // Promotions never consult the TV gate, so the floor must not change the
    // outcome — this locks the entry-only scope against a future refactor.
    const config = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '15' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
        ],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
    }) as TTConfig;
    const heldState = {
      ...initialTTState(),
      avgEntryPrice: '100',
      heldQuantity: '0.1',
      currentGridTradeIndex: 0,
    } as TTState;
    const withHint = evaluateGridBuy(
      makeInput(config, strongSellTv, { enterOnAdd: true }, '95'),
      heldState,
      NOW_MS,
    );
    const withoutHint = evaluateGridBuy(
      makeInput(config, strongSellTv, undefined, '95'),
      heldState,
      NOW_MS,
    );
    // Identical outcome with and without the hint, and never a TV-gate veto (the
    // promotion path does not consult Technicals at all).
    expect(withHint.kind).toBe(withoutHint.kind);
    expect(withHint.kind).not.toBe('skip-tv');
  });
});

describe('evaluateGridBuy — general time-stop entry stamp', () => {
  const buyTv = tv([intervalRow('5m')], [{ interval: '5m', signal: sig('BUY') }]);
  const timeStopEntryConfig = (timeStopBars: number): TTConfig =>
    trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05', timeStopBars },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
    }) as TTConfig;

  it('stamps entryAtMs on a non-discovery first entry when timeStopBars > 0', () => {
    const result = evaluateGridBuy(
      makeInput(timeStopEntryConfig(5), buyTv, undefined),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.state.entryAtMs).toBe(NOW_MS);
    // Not a discovery entry — the general time-stop owns this, not discovery.
    expect(result.state.discoveryEntry).not.toBe(true);
  });

  it('leaves entryAtMs null on a first entry when timeStopBars is 0 (byte-identical default)', () => {
    const result = evaluateGridBuy(
      makeInput(timeStopEntryConfig(0), buyTv, undefined),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.state.entryAtMs).toBeNull();
  });

  it('does NOT re-stamp entryAtMs on a promotion (clock runs from the open)', () => {
    // Two-level grid; held at level 0 with an original entry stamp. A promotion
    // (average-down) at the level-1 trigger must leave entryAtMs unchanged so
    // averaging down does not defer the time-stop clock.
    const promoConfig = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '15' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
        ],
      },
      sell: {
        enabled: true,
        stopLossPercentage: '0.97',
        triggerPercentage: '1.05',
        timeStopBars: 5,
      },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
    }) as TTConfig;
    const heldAtEntry = {
      ...initialTTState(),
      avgEntryPrice: '100',
      heldQuantity: '0.1',
      currentGridTradeIndex: 0,
      entryAtMs: 111,
    } as TTState;
    const result = evaluateGridBuy(
      makeInput(promoConfig, buyTv, undefined, '95'),
      heldAtEntry,
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.state.currentGridTradeIndex).toBe(1);
    expect(result.state.entryAtMs).toBe(111);
  });
});
