import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, OpenOrder, SymbolInfo } from '@app/strategy-core';

import {
  initialMomentumState,
  momentum,
  MomentumConfigSchema,
  type MomentumConfig,
  type MomentumState,
} from '../src/index.js';
import { protectiveStopClientOrderId } from '../src/client-order-id.js';
import type { MomentumBundle } from '../src/schema.js';
import type { TickInput } from '@app/strategy-core';

const SYMBOL = 'BTCUSDT';
const PROFILE_ID = 'p1';
const PROTECTIVE_ID = protectiveStopClientOrderId(PROFILE_ID, SYMBOL);

const FILTERS: SymbolInfo['filters'] = {
  minNotional: '10',
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '100000',
  minPrice: '0.01',
  maxPrice: '1000000',
};

const TRAILING_FILTERS = {
  ...FILTERS,
  trailingDelta: {
    minTrailingAboveDelta: 10,
    maxTrailingAboveDelta: 2000,
    minTrailingBelowDelta: 10,
    maxTrailingBelowDelta: 2000,
  },
};

// A symbol that refuses a small trailing delta but accepts the fixed 10% one, and whose price band refuses a priced stop below its floor. Together these are the only conditions under which the band escape rests an exchange trail at a distance the PRIMARY leg could not use.
const BAND_ESCAPE_FILTERS = {
  ...TRAILING_FILTERS,
  trailingDelta: { ...TRAILING_FILTERS.trailingDelta, minTrailingBelowDelta: 800 },
  percentPriceBySide: {
    askMultiplierUp: '1.05',
    askMultiplierDown: '0.97',
    bidMultiplierUp: '1.05',
    bidMultiplierDown: '0.97',
    avgPriceMins: 5,
  },
};

// The ATR leg overrides `trailingStopPct` in force but not in the band settings, so the primary wanted distance and the escape's distance are two different numbers on the same tick.
const BAND_ESCAPE_CLOSES = ['96', '97', '98', '99', '100', '100'] as const;

const mkCandles = (closes: readonly string[]): Candle[] =>
  closes.map((close, index) => ({
    openTimeMs: index * 3_600_000,
    closeTimeMs: (index + 1) * 3_600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  }));

const candle = (over: Partial<Candle> = {}): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 60_000,
  open: '100',
  high: '100',
  low: '100',
  close: '100',
  volume: '1',
  isClosed: true,
  ...over,
});

const baseConfig = (): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    trailingStopPct: '0.10',
    profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
    protectiveStop: { enabled: true },
  });

const config = (
  mode: 'priced' | 'native-trail',
  over: Record<string, unknown> = {},
): MomentumConfig => {
  const parsed = baseConfig();
  const { protectiveStop: protectiveStopOver, ...topLevel } = over;
  return {
    ...parsed,
    ...topLevel,
    protectiveStop: {
      ...parsed.protectiveStop,
      mode,
      ...(protectiveStopOver as Record<string, unknown> | undefined),
    },
  } as unknown as MomentumConfig;
};

const held = (over: Record<string, unknown> = {}): MomentumState =>
  ({
    ...initialMomentumState(),
    entryPrice: '100',
    highSinceEntry: '100',
    heldQuantity: '1',
    ...over,
  }) as MomentumState;

const nativeOrder = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 7001,
  clientOrderId: PROTECTIVE_ID,
  symbol: SYMBOL,
  side: 'SELL',
  type: 'STOP_LOSS',
  status: 'NEW',
  price: '0',
  origQty: '1',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  stopPrice: undefined,
  trailingDelta: 1000,
  transactTimeMs: 0,
  updateTimeMs: 0,
  ...over,
});

const pricedOrder = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 7002,
  clientOrderId: PROTECTIVE_ID,
  symbol: SYMBOL,
  side: 'SELL',
  type: 'STOP_LOSS_LIMIT',
  status: 'NEW',
  price: '93.10',
  origQty: '1',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  stopPrice: '95',
  timeInForce: 'GTC',
  transactTimeMs: 0,
  updateTimeMs: 0,
  ...over,
});

interface InputOver {
  readonly config?: MomentumConfig;
  readonly state?: MomentumState;
  readonly currentPrice?: string;
  readonly closes?: readonly string[];
  readonly openOrders?: readonly OpenOrder[];
  readonly filters?: SymbolInfo['filters'];
  readonly oneMinute?: readonly Candle[];
}

const input = (over: InputOver = {}): TickInput<MomentumConfig, MomentumState, MomentumBundle> => ({
  clock: { nowMs: () => 0 },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: PROFILE_ID,
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '1.0.0',
  },
  config: over.config ?? config('native-trail'),
  state: over.state ?? held(),
  market: {
    symbol: SYMBOL,
    currentPrice: over.currentPrice ?? '100',
    candlesByInterval: {
      '1h': mkCandles(over.closes ?? ['100', '100', '100', '100']),
      ...(over.oneMinute === undefined ? {} : { '1m': over.oneMinute }),
    },
    symbolInfo: {
      symbol: SYMBOL,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filters: over.filters ?? TRAILING_FILTERS,
    },
    indicatorsByInterval: {},
  },
  account: {
    balances: {
      BTC: { asset: 'BTC', free: new Decimal('1'), locked: new Decimal('0') },
      USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal('0') },
    },
    readable: true,
  },
  openOrders: over.openOrders ?? [],
  bundle: { override: null },
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10_000 },
});

describe('momentum native-trail protective stop', () => {
  // Guard: native mode must place one STOP_LOSS carrying only the exchange trailing delta.
  it('places a native trailing stop when none is resting', () => {
    const out = momentum.tick(input({ currentPrice: '100' }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'STOP_LOSS', trailingDelta: 1000 },
    });
    if (out.decisions[0]?.type !== 'place-order') throw new Error('expected place-order');
    expect(out.decisions[0].params.stopPrice).toBeUndefined();
    expect(out.decisions[0].params.price).toBeUndefined();
  });

  // Guard: native tightening must be atomic, guarded by the tracked high, and stable on the next tick.
  it('replaces a native order for a tightened profit delta and then settles', () => {
    const resting = nativeOrder({ transactTimeMs: 0 });
    const first = momentum.tick(
      input({
        currentPrice: '110',
        state: held({ profitHigh: '110' }),
        openOrders: [resting],
        oneMinute: [candle({ high: '110', close: '110' })],
      }),
    );
    expect(first.decisions).toHaveLength(1);
    expect(first.decisions[0]).toMatchObject({
      type: 'replace-order',
      cancelOrderId: resting.orderId,
      params: { trailingDelta: 300 },
    });

    const second = momentum.tick(
      input({
        currentPrice: '110',
        state: first.nextState,
        openOrders: [nativeOrder({ trailingDelta: 300 })],
        oneMinute: [candle({ high: '110', close: '110' })],
      }),
    );
    expect(second.decisions).toEqual([{ type: 'noop' }]);
  });

  // Guard: an ATR-derived wider candidate must not loosen an already tighter native trail.
  it('does not replace a native order when ATR widens the candidate distance', () => {
    const out = momentum.tick(
      input({
        state: held({ profitHigh: null }),
        currentPrice: '100',
        openOrders: [nativeOrder({ trailingDelta: 300 })],
        closes: ['80', '85', '90', '95', '100', '105'],
        config: config('native-trail', {
          profitTrail: { enabled: false },
          atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
        }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
  });

  // Guard: the native high-water guard must reject a tightening that would sit below the tracked high.
  it('does not replace when the mark is eight percent below the tracked high', () => {
    const out = momentum.tick(
      input({
        config: config('native-trail', {
          trailingStopPct: '0.05',
          profitTrail: { enabled: false },
        }),
        currentPrice: '100',
        state: held({ highSinceEntry: '100' }),
        openOrders: [nativeOrder({ trailingDelta: 1000, transactTimeMs: 0 })],
        oneMinute: [candle({ high: '110', close: '100' })],
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);

    const control = momentum.tick(
      input({
        config: config('native-trail', {
          trailingStopPct: '0.05',
          profitTrail: { enabled: false },
        }),
        currentPrice: '100',
        state: held({ highSinceEntry: '100' }),
        openOrders: [nativeOrder({ trailingDelta: 1000, transactTimeMs: 0 })],
        oneMinute: [candle({ high: '100', close: '100' })],
      }),
    );
    expect(control.decisions).toHaveLength(1);
    expect(control.decisions[0]).toMatchObject({
      type: 'replace-order',
      params: { trailingDelta: 500 },
    });
  });

  // Guard: an unavailable native delta must fall back to priced protection and remain attributable once that fallback rests.
  it('falls back to a priced stop when TRAILING_DELTA rejects the wanted distance', () => {
    const filters = {
      ...TRAILING_FILTERS,
      trailingDelta: { ...TRAILING_FILTERS.trailingDelta, minTrailingBelowDelta: 2000 },
    };
    const out = momentum.tick(input({ filters, openOrders: [pricedOrder()] }));
    expect(out.nextState.exitBlocker).toMatchObject({
      reason: 'native-trail-unavailable',
      changeKey: 'native-trail-unavailable',
      detail: { distancePct: '0.1', fallback: 'priced' },
    });

    const placing = momentum.tick(input({ filters }));
    expect(placing.decisions).toHaveLength(1);
    expect(placing.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'STOP_LOSS_LIMIT' },
    });
  });

  // Guard: a refused native distance whose priced fallback has not landed leaves the position naked, and only the unplaced reason opens the span that is watched for it. Reporting the cause here claims a priced stop is protecting the coin when nothing is.
  it('reports protective-stop-unplaced, not the native cause, while nothing rests', () => {
    const filters = {
      ...TRAILING_FILTERS,
      trailingDelta: { ...TRAILING_FILTERS.trailingDelta, minTrailingBelowDelta: 2000 },
    };
    const out = momentum.tick(input({ filters }));
    expect(out.nextState.exitBlocker).toMatchObject({
      reason: 'protective-stop-unplaced',
      changeKey: 'unplaced|native-unavailable',
      detail: { nativeUnavailable: true, distancePct: '0.1', stop: '90' },
    });
  });

  // Guard: the native cause is derived from the PRIMARY wanted distance alone, so it stays true while the band escape rests a trail at the fixed distance the same filter accepts. Reading the cause instead of the resting order there calls an exchange trail a priced fallback — the one thing it is not.
  it('reports the resting exchange trail the band escape placed, not the native cause', () => {
    const bandEscape = config('native-trail', {
      profitTrail: { enabled: false },
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
      protectiveStop: { onBandBlock: 'native-trail' },
    });
    const placing = momentum.tick(
      input({
        config: bandEscape,
        filters: BAND_ESCAPE_FILTERS,
        closes: BAND_ESCAPE_CLOSES,
      }),
    );
    expect(placing.decisions).toHaveLength(1);
    expect(placing.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'STOP_LOSS', trailingDelta: 1000 },
    });
    expect(placing.nextState.exitBlocker).toMatchObject({
      reason: 'protective-stop-unplaced',
      detail: { nativeUnavailable: true },
    });

    const resting = momentum.tick(
      input({
        config: bandEscape,
        filters: BAND_ESCAPE_FILTERS,
        closes: BAND_ESCAPE_CLOSES,
        openOrders: [nativeOrder({ trailingDelta: 1000 })],
      }),
    );
    expect(resting.nextState.exitBlocker).toMatchObject({
      reason: 'native-trail-resting',
      changeKey: 'native|delta=1000',
      detail: { trailingDelta: 1000, quantity: '1' },
    });
    expect(resting.nextState.exitBlocker?.detail).not.toHaveProperty('fallback');
  });

  // Guard: a rejected distance is small precisely because the symbol's minimum delta rejected it, and `toString` switches to exponential at 1e-7 — the operator reads this against a percentage, and a downstream parse reads it as a number.
  it('serialises a sub-1e-6 attempted distance as a plain decimal at both detail sites', () => {
    const tiny = config('native-trail', {
      profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.0000001' },
    });
    const armed = { currentPrice: '110', state: held({ profitHigh: '110' }) };

    const unplaced = momentum.tick(input({ config: tiny, ...armed }));
    expect(unplaced.nextState.exitBlocker).toMatchObject({
      reason: 'protective-stop-unplaced',
      detail: { nativeUnavailable: true, distancePct: '0.0000001' },
    });

    const fallbackResting = momentum.tick(
      input({ config: tiny, ...armed, openOrders: [pricedOrder()] }),
    );
    expect(fallbackResting.nextState.exitBlocker).toMatchObject({
      reason: 'native-trail-unavailable',
      detail: { distancePct: '0.0000001', fallback: 'priced' },
    });

    for (const blocker of [unplaced.nextState.exitBlocker, fallbackResting.nextState.exitBlocker]) {
      expect(String(blocker?.detail['distancePct'])).not.toMatch(/e[+-]/i);
    }
  });
});

describe('momentum native-trail exitBlocker and high-water state', () => {
  // Guard: additive blocker and nativeTrail state fields must default to null without a schema-version bump.
  it('defaults exitBlocker and nativeTrail to null in the flat state', () => {
    const parsed = MomentumConfigSchema.parse(baseConfig()) as unknown as {
      protectiveStop?: { mode?: string };
    };
    expect(parsed.protectiveStop?.mode).toBe('priced');
    expect(initialMomentumState()).toMatchObject({ exitBlocker: null, nativeTrail: null });
  });

  // Guard: flat and disabled positions must never publish a protective-stop exit blocker.
  it('keeps exitBlocker null while flat or when the stop is disabled', () => {
    const flatOut = momentum.tick(input({ state: initialMomentumState() }));
    expect(flatOut.nextState.exitBlocker).toBeNull();

    const disabledOut = momentum.tick(
      input({ config: config('native-trail', { protectiveStop: { enabled: false } }) }),
    );
    expect(disabledOut.nextState.exitBlocker).toBeNull();
  });

  // Guard: a resting native order must identify the native-trail blocker and its stable delta.
  it('reports native-trail-resting for a resting native stop', () => {
    const out = momentum.tick(input({ openOrders: [nativeOrder()] }));
    expect(out.nextState.exitBlocker).toMatchObject({
      reason: 'native-trail-resting',
      changeKey: 'native|delta=1000',
    });
  });

  // Guard: a profit-armed native stop must attribute the blocker to the profit leg.
  it('reports profit-leg-armed when the native stop protects an armed profit leg', () => {
    const out = momentum.tick(
      input({
        currentPrice: '110',
        state: held({ profitHigh: '110' }),
        openOrders: [nativeOrder()],
      }),
    );
    expect(out.nextState.exitBlocker?.reason).toBe('profit-leg-armed');
  });

  // Guard: a priced resting stop must use its stopPrice in the exit-blocker identity.
  it('reports priced-stop-resting for a priced protective stop', () => {
    const out = momentum.tick(
      input({ config: config('priced'), openOrders: [pricedOrder({ stopPrice: '95.00' })] }),
    );
    expect(out.nextState.exitBlocker).toMatchObject({
      reason: 'priced-stop-resting',
      changeKey: 'priced|stop=95.00',
    });
  });

  // Guard: a held position with no resting stop must report the transient unplaced state, under the plain identity — a symbol that simply has no stop yet must not be audited as one whose filter refused the trail.
  it('reports protective-stop-unplaced when nothing rests', () => {
    const out = momentum.tick(input());
    expect(out.nextState.exitBlocker).toMatchObject({
      reason: 'protective-stop-unplaced',
      changeKey: 'unplaced',
    });
    expect(out.nextState.exitBlocker?.detail).not.toHaveProperty('nativeUnavailable');
  });

  // Guard: nativeTrail must seed, advance, reset, and clear from exchange order identity and candle highs.
  it('tracks the native order high-water mark across order identity changes', () => {
    const first = momentum.tick(
      input({
        currentPrice: '110',
        openOrders: [nativeOrder({ orderId: 7001, transactTimeMs: 60_000 })],
        oneMinute: [
          candle({ openTimeMs: 0, high: '101' }),
          candle({ openTimeMs: 60_000, high: '105' }),
        ],
      }),
    );
    expect(first.nextState.nativeTrail).toEqual({ orderId: 7001, high: '110' });

    const raised = momentum.tick(
      input({
        currentPrice: '120',
        state: first.nextState,
        openOrders: [nativeOrder({ orderId: 7001, transactTimeMs: 60_000 })],
        oneMinute: [candle({ openTimeMs: 60_000, high: '105' })],
      }),
    );
    expect(raised.nextState.nativeTrail).toEqual({ orderId: 7001, high: '120' });

    const reset = momentum.tick(
      input({
        currentPrice: '115',
        state: raised.nextState,
        openOrders: [nativeOrder({ orderId: 7003, transactTimeMs: 60_000 })],
        oneMinute: [candle({ openTimeMs: 60_000, high: '106' })],
      }),
    );
    expect(reset.nextState.nativeTrail).toEqual({ orderId: 7003, high: '115' });

    const cleared = momentum.tick(input({ state: reset.nextState, openOrders: [], oneMinute: [] }));
    expect(cleared.nextState.nativeTrail).toBeNull();
  });

  // `MomentumStateSchema` types `nativeTrail.high` as a plain string, so a row carrying a value `Decimal` cannot parse is schema-valid. Constructing it bare would throw inside `computeTick` and abort every tick for this symbol until an operator edited the row, while dropping the reading costs only the persisted high: the mark and the candle highs still bound the reconstruction from beneath.
  it('survives a persisted high that is not a number', () => {
    const out = momentum.tick(
      input({
        currentPrice: '110',
        state: held({ nativeTrail: { orderId: 7005, high: 'not-a-number' } }),
        openOrders: [nativeOrder({ orderId: 7005, transactTimeMs: 60_000 })],
        oneMinute: [candle({ openTimeMs: 60_000, high: '105' })],
      }),
    );

    expect(out.nextState.nativeTrail).toEqual({ orderId: 7005, high: '110' });
  });

  it('includes the candle containing native order placement in its high-water mark', () => {
    const out = momentum.tick(
      input({
        currentPrice: '100',
        openOrders: [nativeOrder({ orderId: 7004, transactTimeMs: 90_000 })],
        oneMinute: [
          candle({ openTimeMs: 60_000, high: '130' }),
          candle({ openTimeMs: 120_000, high: '110' }),
        ],
      }),
    );

    expect(out.nextState.nativeTrail).toEqual({ orderId: 7004, high: '130' });
  });
});

describe('momentum priced mode compatibility', () => {
  // Guard: resolving a priced level must pin it above our own resting stop and re-arm only above the drift band.
  it('does not move below a resting priced stop, but replaces when the candidate clears it', () => {
    const below = momentum.tick(
      input({
        config: config('priced'),
        state: held({ highSinceEntry: '100' }),
        openOrders: [pricedOrder({ stopPrice: '95' })],
      }),
    );
    expect(below.decisions.some((decision) => decision.type === 'replace-order')).toBe(false);
    expect(below.decisions.some((decision) => decision.type === 'cancel-order')).toBe(false);

    const above = momentum.tick(
      input({
        config: config('priced'),
        state: held({ highSinceEntry: '110' }),
        openOrders: [pricedOrder({ stopPrice: '95' })],
      }),
    );
    expect(above.decisions).toHaveLength(1);
    expect(above.decisions[0]).toMatchObject({
      type: 'replace-order',
      params: { stopPrice: expect.any(String) },
    });
    if (above.decisions[0]?.type !== 'replace-order') throw new Error('expected replace-order');
    expect(new Decimal(above.decisions[0].params.stopPrice ?? '0').gt(new Decimal('95'))).toBe(
      true,
    );
  });

  // Guard: explicit priced mode must parse and replay identically to an absent mode.
  it('deep-equals the absent-mode held output for explicit priced mode', () => {
    const parsed = MomentumConfigSchema.parse({
      ...baseConfig(),
      protectiveStop: { ...baseConfig().protectiveStop, mode: 'priced' },
    });
    expect(parsed.protectiveStop.mode).toBe('priced');

    const { mode: _mode, ...withoutMode } = parsed.protectiveStop;
    const absent = momentum.tick(
      input({ config: { ...parsed, protectiveStop: withoutMode } as unknown as MomentumConfig }),
    );
    const explicit = momentum.tick(input({ config: parsed }));
    expect(explicit).toEqual(absent);
  });
});
