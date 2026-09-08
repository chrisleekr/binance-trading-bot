import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, ProfileSnapshot, SymbolInfo, TickInput } from '@app/strategy-core';

import {
  momentum,
  MomentumConfigSchema,
  MOMENTUM_STATE_SCHEMA_VERSION,
  type MomentumBundle,
  type MomentumConfig,
  type MomentumState,
} from '../src/index.js';

// No `percentPriceBySide`: the exchange band clamp would move the resting stop off the level the trail resolved, and these tests are about that level, not about the clamp.
const SYMBOL_INFO: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.001',
    minQty: '0.001',
    maxQty: '100000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
};

const PROFILE: ProfileSnapshot = {
  id: 'p1',
  userId: 'u1',
  binanceMode: 'test',
  status: 'running',
  strategyVersion: '1.0.0',
};

const mkCandles = (closes: readonly string[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

const cfg = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    trailingStopPct: '0.05',
    ...over,
  });

// The arm reads an asset absent from a populated balance map as a hard zero, so a quote-only wallet would model the 1 BTC position as not held and refuse to arm at all.
const BALANCES = {
  USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal('0') },
  BTC: { asset: 'BTC', free: new Decimal('1'), locked: new Decimal('0') },
};

const longState = (over: Partial<MomentumState> = {}): MomentumState => ({
  schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
  entryPrice: '100',
  highSinceEntry: '100',
  profitHigh: null,
  heldQuantity: '1',
  lastEntryCandleMs: null,
  profitTrailSinceMs: null,
  entryBlocker: null,
  protectiveStopBlocker: null,
  ...over,
});

// Close time of the newest closed candle in the 4-bar series below — the value an entry tick stamps into `lastEntryCandleMs`.
const LAST_CLOSE_MS = 4 * 3_600_000;

// The shared `hold()` helper returns the same `[{type: 'noop'}]` and passes state through for EVERY early return — warm-up, flat-with-no-signal, an entry skip — so a mark assertion whose expected value equals its input would still pass if the tick never reached the held-long branch. This log is emitted only on that branch, so asserting it pins which path produced the mark.
const HELD_LONG_LOG = 'momentum: holding long';

// The newest closed close (120) is above the prior high (100) and the EMAs stay above, so nothing but the high-water ratchet can move. currentPrice 120 sits above both candidate stop levels (100*0.95 = 95 and 120*0.95 = 114), which is what isolates the mark from a spurious sell: a test that exits would pass for the wrong reason.
const CLOSES = mkCandles(['100', '100', '100', '120']);
const CURRENT_PRICE = '120';

const runTick = (
  lastEntryCandleMs: number | null,
  config: MomentumConfig = cfg(),
  stateOver: Partial<MomentumState> = {},
  currentPrice: string = CURRENT_PRICE,
): ReturnType<typeof momentum.tick> => {
  const input: TickInput<MomentumConfig, MomentumState, MomentumBundle> = {
    clock: { nowMs: () => 0 },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: PROFILE,
    config,
    state: longState({ lastEntryCandleMs, ...stateOver }),
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: { '1h': CLOSES },
      symbolInfo: SYMBOL_INFO,
      indicatorsByInterval: {},
    },
    account: { balances: BALANCES, readable: true },
    openOrders: [],
    bundle: { override: null },
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10_000 },
  };
  return momentum.tick(input);
};

describe('momentum hard trailing leg — candles that closed before the entry', () => {
  it('does not ratchet on the candle the entry cross fired on', () => {
    // The live `1d` shape: the cross stays live for the rest of the candle it fired on, so the buy lands hours into the day and the newest CLOSED candle is the one that stamp names. Its close is a price this position never held, and folding it in rests the first protective stop far below the configured distance from entry.
    const out = runTick(LAST_CLOSE_MS);
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('100');
    expect(out.logs).toContainEqual(expect.objectContaining({ message: HELD_LONG_LOG }));
  });

  it('does not ratchet on a candle that closed before the entry stamp', () => {
    const out = runTick(LAST_CLOSE_MS + 3_600_000);
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('100');
    expect(out.logs).toContainEqual(expect.objectContaining({ message: HELD_LONG_LOG }));
  });

  it('still ratchets on a candle that closed strictly after the entry', () => {
    // The narrowing must leave the ordinary trail untouched: a close the position actually lived through still advances the mark.
    const out = runTick(3 * 3_600_000);
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('120');
  });

  it('fails open and ratchets when the position carries no entry stamp', () => {
    // A wallet-reconciled position and an adopted fill both arrive with a null stamp. With no entry candle to compare against there is nothing to gate on, so the trail keeps its pre-existing behaviour rather than freezing the mark for the life of the position.
    const out = runTick(null);
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('120');
  });

  it('rests the protective stop at the configured distance from entry, not from the pre-entry close', () => {
    const out = runTick(LAST_CLOSE_MS, cfg({ protectiveStop: { enabled: true } }));
    const place = out.decisions[0];
    if (
      place?.type !== 'place-order' ||
      place.params.type !== 'STOP_LOSS_LIMIT' ||
      place.params.stopPrice === undefined
    ) {
      throw new Error('expected a STOP_LOSS_LIMIT place-order carrying a stop price');
    }
    // 100*0.95 is the only passing value: the un-gated fold would rest this stop at 120*0.95 = 114, a level 14% above the entry the operator's 5% was measured from.
    const stop = new Decimal(place.params.stopPrice);
    expect(stop.eq(new Decimal('100').mul('0.95'))).toBe(true);
  });

  it('holds the existing mark, not the entry price, when the gate blocks', () => {
    // Every other case here carries an entry price and a mark of the same 100, so asserting '100' cannot tell the two operands of `state.highSinceEntry ?? entryPrice` apart: a blocked ratchet that wrongly collapsed the mark to the entry price would read identically. Separating them is the only way to pin that the gate holds the mark it was given rather than resetting it. '110' is therefore the only passing value: '120' would be the un-gated fold of the pre-entry close, and '100' a wrong fallback to `entryPrice`.
    const out = runTick(LAST_CLOSE_MS, cfg(), { highSinceEntry: '110' });
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('110');
    expect(out.logs).toContainEqual(expect.objectContaining({ message: HELD_LONG_LOG }));
  });

  it('holds a live price the un-gated trail would have stopped out', () => {
    // The harm the gate prevents is a premature stop-out, not a wrong number in state. 110 sits BETWEEN the two candidate stops: above the gated 95, at-or-below the un-gated 114. Gated the position holds; un-gated `trailHit` fires and sells a position still 10% above its entry. 1 * 110 = 110 clears `minNotional` and `stepSize` sizes the quantity, so the un-gated path really does emit the sell rather than skipping it as dust.
    const out = runTick(LAST_CLOSE_MS, cfg(), {}, '110');
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('100');
    expect(out.logs).toContainEqual(expect.objectContaining({ message: HELD_LONG_LOG }));
    // An exit would stamp `momentum.exit` here, so an empty series is the exit's absence stated positively.
    expect(out.metrics).toEqual([]);
  });
});
