// ATR trail from entry (trend-follow): when `sell.atrTrailing.fromEntry` is on,
// `highSinceBuy` is armed from the entry price on the very first held tick,
// independent of `triggerPercentage`. The ATR branch (gated on highSinceBuy !=
// null) is therefore live from entry, so a position that dips before ever
// reaching the sell trigger still trails out instead of waiting on the hard
// stop alone. Default-off ⇒ existing behaviour is byte-identical, so these
// tests pin both the new arming AND the no-regression guarantee.
//
// Numbers (trade-interval candles have a constant true range of 2 ⇒ ATR(14) = 2):
//   entry (avgEntryPrice) = 100, no highSinceBuy yet
//   trigger 1.05 ⇒ trigger price 105 (the position never reaches it here)
//   fromEntry seed ⇒ highSinceBuy = 100; ATR stop (×3) = 100 - 3*2 = 94

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import { evaluateSellGate } from '../src/branches/sell-gate.js';
import type { Candle, OpenOrder, TickInput } from '@app/strategy-core';

const NOW = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

const SYMBOL_INFO = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.0001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
} as const;

/**
 * `n` closed 1h candles with a constant true range of 2 ⇒ ATR(period) = 2. The
 * last candle's close defaults to 100; `lastClose` overrides it so a test can
 * drive the high-water ratchet (which reads the latest closed candle's close)
 * without disturbing the ATR window.
 */
const atrCandles = (n: number, lastClose = '100'): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: i * HOUR_MS,
    closeTimeMs: i * HOUR_MS + HOUR_MS - 1,
    open: '100',
    high: '101',
    low: '99',
    close: i === n - 1 ? lastClose : '100',
    volume: '1',
    isClosed: true,
  }));

interface FromEntryOpts {
  readonly fromEntry?: boolean;
  readonly atrEnabled?: boolean;
  readonly atrMultiplier?: string;
  readonly triggerPercentage?: string;
  readonly stopLossPercentage?: string;
}

const config = (o: FromEntryOpts = {}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: {
      enabled: true,
      stopLossPercentage: o.stopLossPercentage ?? '',
      triggerPercentage: o.triggerPercentage ?? '1.05',
      trailingStopPercentage: '0',
      atrTrailing: {
        enabled: o.atrEnabled ?? true,
        fromEntry: o.fromEntry ?? false,
        period: 14,
        multiplier: o.atrMultiplier ?? '3',
      },
    },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
  });

/** Freshly-held position: entry recorded, no high-water mark yet. */
const heldState = (cfg: TTConfig, overrides: Partial<TTState> = {}): TTState => ({
  ...trailingTrade.initialState(cfg),
  avgEntryPrice: '100',
  highSinceBuy: null,
  heldQuantity: '0.2',
  currentGridTradeIndex: 0,
  ...overrides,
});

const buildInput = (opts: {
  config: TTConfig;
  state: TTState;
  currentPrice: string;
  atrCandleCount?: number;
  // Close of the latest closed candle — the price the high-water mark ratchets
  // on. Defaults to 100; set it above the prior high to drive a ratchet.
  latestClose?: string;
}): TickInput<TTConfig, TTState, TTBundle> => {
  const bundle = TTBundleSchema.parse({
    technicals: { config: opts.config.technicals, signals: [] },
    override: null,
  });
  return {
    clock: { nowMs: () => NOW },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
    },
    config: opts.config,
    state: opts.state,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: opts.currentPrice,
      candlesByInterval: { '1h': atrCandles(opts.atrCandleCount ?? 16, opts.latestClose ?? '100') },
      symbolInfo: SYMBOL_INFO,
    },
    account: {
      balances: { BTC: { asset: 'BTC', free: new Decimal(1), locked: new Decimal(0) } },
      readable: true,
    },
    openOrders: [] as readonly OpenOrder[],
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

describe('evaluateSellGate — ATR trail fromEntry', () => {
  it('fromEntry on: a freshly-held position below the trigger seeds highSinceBuy from entry', () => {
    // price 101 is below the 105 trigger, so the trigger-arm block does NOT
    // fire. Without fromEntry, highSinceBuy stays null and the ATR branch never
    // engages. With fromEntry, the gate seeds highSinceBuy from entry (100).
    // currentPrice 101 is a live print above the closed close (100); the seed
    // must NOT inflate past the closed close — it stays at the entry/closed 100.
    const cfg = config({ fromEntry: true });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state: heldState(cfg), currentPrice: '101' }),
      heldState(cfg),
    );
    expect(result.kind).toBe('bump-high');
    if (result.kind === 'bump-high') {
      // Seeded from the closed-candle reference (100), NOT the live price 101.
      expect(result.state.highSinceBuy).toBe('100');
    }
  });

  it('fromEntry on: seeds at the entry price when price is below entry', () => {
    // price 98 < entry 100: the seed is the entry, not the lower price, so the
    // trail measures the drawdown from the cost basis.
    const cfg = config({ fromEntry: true });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state: heldState(cfg), currentPrice: '98' }),
      heldState(cfg),
    );
    expect(result.kind).toBe('bump-high');
    if (result.kind === 'bump-high') {
      expect(result.state.highSinceBuy).toBe('100');
    }
  });

  it('fromEntry on: ratchets highSinceBuy up on a new CLOSED high above the prior mark', () => {
    // Already armed at 100; the latest candle CLOSES at 108 ⇒ ratchet to 108.
    // The ratchet keys on the closed close, so the candle close (not just the
    // live price) must be the new high.
    const cfg = config({ fromEntry: true });
    const state = heldState(cfg, { highSinceBuy: '100' });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state, currentPrice: '108', latestClose: '108' }),
      state,
    );
    expect(result.kind).toBe('bump-high');
    if (result.kind === 'bump-high') {
      expect(result.state.highSinceBuy).toBe('108');
    }
  });

  it('fromEntry on: a live price spike above the closed close does NOT ratchet the high (wick-immune)', () => {
    // The #672 regression: currentPrice is the sub-second live print, so a
    // transient up-wick (110) on an armed-at-100 position would inflate
    // highSinceBuy and clip the winner on the next pullback. With the ratchet on
    // the closed close (still 100), the wick is ignored: no bump, and the ATR
    // trail (stop 100 - 3*2 = 94) does not fire at 110.
    const cfg = config({ fromEntry: true });
    const state = heldState(cfg, { highSinceBuy: '100' });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state, currentPrice: '110', latestClose: '100' }),
      state,
    );
    expect(result.kind).toBe('noop');
  });

  it('fromEntry on: a non-new-high tick falls through so the ATR trail can fire', () => {
    // Armed at 100; price 94 ≤ ATR stop (100 - 3*2 = 94) ⇒ the ATR branch must
    // own this tick and SELL, not return another bump-high.
    const cfg = config({ fromEntry: true });
    const state = heldState(cfg, { highSinceBuy: '100' });
    const result = evaluateSellGate(buildInput({ config: cfg, state, currentPrice: '94' }), state);
    expect(result.kind).toBe('emit');
    if (result.kind === 'emit') {
      expect(result.decision).toMatchObject({ intent: { side: 'SELL', reason: 'grid-sell' } });
    }
  });

  it('fromEntry off: a below-trigger held position does NOT seed highSinceBuy', () => {
    // Same below-trigger position; with fromEntry off highSinceBuy stays null
    // (the legacy behaviour — only the hard stop protects pre-trigger).
    const cfg = config({ fromEntry: false });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state: heldState(cfg), currentPrice: '101' }),
      heldState(cfg),
    );
    expect(result.kind).toBe('noop');
  });

  it('fromEntry on but atrTrailing.enabled off: the flag is inert (no seed)', () => {
    // fromEntry only applies when the ATR trail is enabled; with ATR off there
    // is no trail to arm, so the gate must not seed highSinceBuy.
    const cfg = config({ fromEntry: true, atrEnabled: false });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state: heldState(cfg), currentPrice: '101' }),
      heldState(cfg),
    );
    expect(result.kind).toBe('noop');
  });

  it('fromEntry on: a corrupted stored highSinceBuy falls through (no re-seed, no crash)', () => {
    // The live worker passes raw stored state; a hand-edited row could carry an
    // unparseable highSinceBuy. The from-entry arm must not crash or re-seed —
    // it falls through, and the ATR branch (which also parses highSinceBuy)
    // owns the tick. price 101 is well above any trail, so the result is noop.
    const cfg = config({ fromEntry: true });
    const state = heldState(cfg, { highSinceBuy: 'not-a-number' });
    const result = evaluateSellGate(buildInput({ config: cfg, state, currentPrice: '101' }), state);
    expect(result.kind).toBe('noop');
  });

  it('fromEntry on: the seed tick only bumps, never sells, even if price is already below the ATR stop', () => {
    // Entry 100, fresh (highSinceBuy null), price 94 — already at the level the
    // ATR trail would fire from a 100 high. The seed tick must SEED, not sell:
    // the trail evaluates from the next tick. Pins "the seed tick never sells".
    const cfg = config({ fromEntry: true });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state: heldState(cfg), currentPrice: '94' }),
      heldState(cfg),
    );
    expect(result.kind).toBe('bump-high');
    if (result.kind === 'bump-high') {
      expect(result.state.highSinceBuy).toBe('100'); // seeded at entry, not at 94
    }
  });

  it('fromEntry on but ATR not yet computable (cold start): no spurious fire, falls through to noop', () => {
    // Armed at 100, price dips to 94, but only 5 candles exist (< period+1) so
    // computeAtr returns null → ATR branch falls through; the fixed-% trail is
    // off ('0') → noop. Pins the cold-start fallback for a fromEntry-armed position.
    const cfg = config({ fromEntry: true });
    const state = heldState(cfg, { highSinceBuy: '100' });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state, currentPrice: '94', atrCandleCount: 5 }),
      state,
    );
    expect(result.kind).toBe('noop');
  });

  it('fromEntry on: stop-loss still fires first (loss precedence preserved)', () => {
    // stop-loss 0.97 ⇒ 97; price 96 ≤ 97 must emit grid-stop-loss BEFORE the
    // fromEntry arming block runs, so a hard loss is never masked as a trail seed.
    const cfg = config({ fromEntry: true, stopLossPercentage: '0.97' });
    const result = evaluateSellGate(
      buildInput({ config: cfg, state: heldState(cfg), currentPrice: '96' }),
      heldState(cfg),
    );
    expect(result.kind).toBe('emit');
    if (result.kind === 'emit') {
      expect(result.decision).toMatchObject({ intent: { side: 'SELL', reason: 'grid-stop-loss' } });
    }
  });
});
