// Exchange-side protective STOP_LOSS_LIMIT SELL (default-off). When
// `config.sell.protectiveStop.enabled` and a position is open, tick() arms a
// resting STOP_LOSS_LIMIT SELL at `avgEntryPrice × stopLossPercentage` (full
// held quantity, intent reason `protective-stop`) so the holding stays defended
// while the bot is offline. The in-process MARKET stop-loss is the primary
// path; this is the backstop, cancelled ahead of any closing sell.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { PROTECTIVE_STOP_BLOCKER_REASONS } from '@app/strategy-core';
import type { Decision, OpenOrder, PercentPriceBySideFilter, TickInput } from '@app/strategy-core';

import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  TTStateSchema,
  type TTState,
  type TTBundle,
  type TTConfig,
} from '../src/index.js';
import {
  evaluateProtectiveStopArm,
  findRestingProtectiveStop,
  protectiveStopCancelDecisions,
} from '../src/branches/protective-stop.js';
import { buildSellDecision } from '../src/decisions.js';
import { reclaimableOwnSellBase, resolveHeldForSell } from '../src/branches/sell-gate.js';
import { protectiveStopClientOrderId } from '../src/client-order-id.js';

const NOW_MS = 1_700_000_000_000;
const PROFILE_ID = 'p1';
const SYMBOL = 'BTCUSDT';
const PROTECTIVE_ID = protectiveStopClientOrderId(PROFILE_ID, SYMBOL);

type TechnicalsConfig = TTConfig['technicals'];
type Signal = NonNullable<TTBundle['technicals']['signals'][number]['signal']>;

interface BuildOpts {
  readonly protectiveStop?: { enabled: boolean; limitOffsetPercentage?: string };
  readonly stopLossPercentage?: string;
  readonly trailingStopPercentage?: string;
  readonly avgEntryPrice?: string | null;
  readonly heldQuantity?: string | null;
  readonly highSinceBuy?: string | null;
  readonly currentPrice?: string;
  readonly openOrders?: readonly OpenOrder[];
  readonly tickSize?: string;
  readonly stepSize?: string;
  readonly percentPriceBySide?: PercentPriceBySideFilter;
  // Sell-side trigger / technicals / regime knobs needed to drive each closing
  // path to its terminal MARKET sell in the ordering tests below.
  readonly technicals?: TechnicalsConfig;
  readonly signals?: readonly { interval: string; signal: Signal | null }[];
  readonly regime?: TTConfig['regime'];
  readonly dailyCloses?: readonly string[];
  readonly override?: TTBundle['override'];
}

// A closed daily kline series; the regime MA reads `close`. isClosed=true so the
// regime evaluator counts each candle (a forming candle is excluded).
const dayCandles = (closes: readonly string[]): unknown[] =>
  closes.map((close, i) => ({
    openTimeMs: i * 86_400_000,
    closeTimeMs: i * 86_400_000 + 86_399_999,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  }));

const buildInput = (o: BuildOpts = {}): TickInput<TTConfig, TTState, TTBundle> => {
  const base = TTConfigSchema.parse({
    symbol: SYMBOL,
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: {
      enabled: true,
      stopLossPercentage: o.stopLossPercentage ?? '0.96',
      triggerPercentage: '1.05',
      ...(o.trailingStopPercentage ? { trailingStopPercentage: o.trailingStopPercentage } : {}),
    },
    ...(o.technicals ? { technicals: o.technicals } : {}),
    ...(o.regime ? { regime: o.regime } : {}),
  }) as TTConfig;

  const config = {
    ...base,
    sell: {
      ...base.sell,
      protectiveStop: o.protectiveStop ?? { enabled: true, limitOffsetPercentage: '0.995' },
    },
  } as unknown as TTConfig;

  const heldState: TTState = {
    ...trailingTrade.initialState(base),
    avgEntryPrice: o.avgEntryPrice === undefined ? '100' : o.avgEntryPrice,
    heldQuantity: o.heldQuantity === undefined ? '2' : o.heldQuantity,
    highSinceBuy: o.highSinceBuy ?? null,
    currentGridTradeIndex: 0,
  };

  const bundle = TTBundleSchema.parse({
    technicals: {
      config: o.technicals ?? { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
      signals: o.signals ?? [],
    },
    override: o.override ?? null,
  });

  return {
    clock: { nowMs: () => NOW_MS },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: PROFILE_ID,
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
    },
    config,
    state: heldState,
    market: {
      symbol: SYMBOL,
      // Above the 96 stop and below the 105 sell trigger: no terminal sell
      // fires, so only the protective stop can arm.
      currentPrice: o.currentPrice ?? '105.00',
      candlesByInterval: (o.dailyCloses ? { '1d': dayCandles(o.dailyCloses) } : {}) as TickInput<
        TTConfig,
        TTState,
        TTBundle
      >['market']['candlesByInterval'],
      symbolInfo: {
        symbol: SYMBOL,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          minNotional: '10',
          tickSize: o.tickSize ?? '0.01',
          stepSize: o.stepSize ?? '0.0001',
          minQty: '0.0001',
          maxQty: '9000',
          minPrice: '0.01',
          maxPrice: '1000000',
          ...(o.percentPriceBySide ? { percentPriceBySide: o.percentPriceBySide } : {}),
        },
      },
    },
    account: {
      balances: { BTC: { asset: 'BTC', free: new Decimal(2), locked: new Decimal(0) } },
      readable: true,
    },
    openOrders: o.openOrders ?? [],
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

const restingProtectiveStop = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 9001,
  clientOrderId: PROTECTIVE_ID,
  symbol: SYMBOL,
  side: 'SELL',
  type: 'STOP_LOSS_LIMIT',
  status: 'NEW',
  price: '95.52',
  origQty: '2',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  stopPrice: '96.00',
  timeInForce: 'GTC',
  transactTimeMs: NOW_MS - 60_000,
  updateTimeMs: NOW_MS - 60_000,
  ...over,
});

const isPlace = (d: Decision): d is Extract<Decision, { type: 'place-order' }> =>
  d.type === 'place-order';
const isCancel = (d: Decision): d is Extract<Decision, { type: 'cancel-order' }> =>
  d.type === 'cancel-order';

describe('trailingTrade tick — protective stop arms a resting STOP_LOSS_LIMIT SELL', () => {
  it('arms STOP_LOSS_LIMIT SELL at avgEntry x stopLoss when none resting', () => {
    const out = trailingTrade.tick(buildInput());

    const stop = out.decisions.find(
      (d) => d.type === 'place-order' && d.intent?.reason === 'protective-stop',
    );
    expect(stop).toBeDefined();
    if (stop === undefined || stop.type !== 'place-order') {
      throw new Error('expected a protective-stop place-order');
    }

    expect(stop.intent.side).toBe('SELL');
    expect(stop.intent.reason).toBe('protective-stop');
    expect(stop.params.type).toBe('STOP_LOSS_LIMIT');
    expect(stop.intent.clientOrderId).toBe(PROTECTIVE_ID);

    // stopPrice = avgEntry × stopLoss = 100 × 0.96 = 96.00 (tickSize 0.01).
    expect(new Decimal(stop.params.stopPrice as string).toNumber()).toBeCloseTo(96, 2);
    // limit price = stopPrice × limitOffsetPercentage = 96 × 0.995 = 95.52.
    expect(
      new Decimal(stop.params.price as string).lt(new Decimal(stop.params.stopPrice as string)),
    ).toBe(true);
  });

  it('preserves the position state on arm (arm is not a sell)', () => {
    const out = trailingTrade.tick(buildInput());
    expect(out.nextState.avgEntryPrice).toBe('100');
    expect(out.nextState.heldQuantity).toBe('2');
  });
});

describe('evaluateProtectiveStopArm — arming logic', () => {
  it('places when none resting; full held qty floored to step', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ heldQuantity: '2.00009' }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: '2.00009',
    });
    expect(decisions).toHaveLength(1);
    const place = decisions[0];
    expect(isPlace(place)).toBe(true);
    if (!isPlace(place)) throw new Error('expected place');
    // 2.00009 floored to stepSize 0.0001 = 2.0000.
    expect(place.params.quantity).toBe('2.0000');
    expect(place.params.stopPrice).toBe('96.00');
    expect(place.params.price).toBe('95.52');
  });

  it('does not re-arm when the resting stop matches (drift below band)', () => {
    const input = buildInput({ openOrders: [restingProtectiveStop()] });
    const out = trailingTrade.tick(input);
    // No protective-stop place-order, no cancel: the resting order is left alone.
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'protective-stop')).toBe(
      false,
    );
    expect(out.decisions.some(isCancel)).toBe(false);
  });

  it('leaves its own resting stop in place even when that stop locks the whole free balance (no self-cancel churn)', () => {
    // Regression: a resting STOP_LOSS_LIMIT locks the base on Binance, so the
    // wallet `free` reads 0 while the held position is 2. Without reclaiming the
    // qty our own stop locks, the sizing skipped, `desired` went null, and the
    // arm cancelled its own stop — then re-placed it once unlocked, ~15x/min.
    // The reclaim makes the sizing succeed, so the matched stop is left in place.
    const base = buildInput({ openOrders: [restingProtectiveStop()] });
    const input = {
      ...base,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal(0), locked: new Decimal(2) } },
        readable: true,
      },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;
    const decisions = evaluateProtectiveStopArm(input, {
      ...trailingTrade.initialState(base.config),
      avgEntryPrice: '100',
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it('re-arms (cancel old + place new) when avgEntry drifts past the band', () => {
    // avgEntry 110 → stop 105.60; resting stop is 96.00, far past the 0.1% band.
    const decisions = evaluateProtectiveStopArm(
      buildInput({ avgEntryPrice: '110', openOrders: [restingProtectiveStop()] }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '110',
        heldQuantity: '2',
      },
    );
    expect(decisions).toHaveLength(2);
    expect(isCancel(decisions[0])).toBe(true);
    if (!isCancel(decisions[0])) throw new Error('expected cancel first');
    expect(decisions[0].orderId).toBe(9001);
    expect(decisions[0].reason).toBe('tt-protective-stop-superseded');
    expect(isPlace(decisions[1])).toBe(true);
    if (!isPlace(decisions[1])) throw new Error('expected place second');
    expect(decisions[1].params.stopPrice).toBe('105.60');
  });

  it('leaves a resting stop with no readable stopPrice in place (no cancel/replace churn)', () => {
    // Regression: some Binance open-orders snapshots return an empty/zero
    // stopPrice for a resting STOP_LOSS_LIMIT (seen on the cold-load REST path).
    // The resting order is still ours (matched by clientOrderId) and valid; if
    // we treated an unreadable readback as "drifted" we'd cancel + re-place an
    // identical stop every tick — an exchange-weight storm that never converges.
    const decisions = evaluateProtectiveStopArm(
      buildInput({ openOrders: [restingProtectiveStop({ stopPrice: undefined })] }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '100',
        heldQuantity: '2',
      },
    );
    expect(decisions).toHaveLength(0);
  });

  it('leaves a resting stop with an unparseable stopPrice in place (no churn)', () => {
    const decisions = evaluateProtectiveStopArm(
      buildInput({ openOrders: [restingProtectiveStop({ stopPrice: 'not-a-number' })] }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '100',
        heldQuantity: '2',
      },
    );
    expect(decisions).toHaveLength(0);
  });

  it('disabled ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(
      buildInput({ protectiveStop: { enabled: false } }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '100',
        heldQuantity: '2',
      },
    );
    expect(decisions).toEqual([]);
  });

  it('missing protectiveStop block (raw stored config) ⇒ no decisions', () => {
    const input = buildInput();
    // Simulate a pre-feature raw config row: drop the block entirely.
    const config = {
      ...input.config,
      sell: { ...input.config.sell, protectiveStop: undefined },
    } as unknown as TTConfig;
    const decisions = evaluateProtectiveStopArm(
      { ...input, config },
      { ...trailingTrade.initialState(input.config), avgEntryPrice: '100', heldQuantity: '2' },
    );
    expect(decisions).toEqual([]);
  });

  it('no position (avgEntryPrice null) ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ avgEntryPrice: null }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: null,
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it('zero held quantity ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ heldQuantity: '0' }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: '0',
    });
    expect(decisions).toEqual([]);
  });

  it('null held quantity ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ heldQuantity: null }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: null,
    });
    expect(decisions).toEqual([]);
  });

  it('position decayed below minNotional WHILE a stop is resting ⇒ cancels the stale stop', () => {
    // held 0.05 at stop 96 ⇒ notional 4.8 < minNotional 10 ⇒ finalise skips ⇒
    // desired null. A resting protective stop must then be CANCELLED, not left
    // to reject (-2010) against the shrunken position when it triggers.
    const input = buildInput({ heldQuantity: '0.05', openOrders: [restingProtectiveStop()] });
    const decisions = evaluateProtectiveStopArm(input, {
      ...trailingTrade.initialState(input.config),
      avgEntryPrice: '100',
      heldQuantity: '0.05',
    });
    expect(decisions).toHaveLength(1);
    expect(isCancel(decisions[0])).toBe(true);
    if (isCancel(decisions[0])) {
      expect(decisions[0].orderId).toBe(9001);
      expect(decisions[0].reason).toBe('tt-protective-stop-superseded');
    }
  });

  it('position decayed below minNotional with NO stop resting ⇒ no decisions', () => {
    // Same decay, but nothing resting: there is nothing to cancel and nothing to
    // arm, so the arm path is a no-op (no spurious cancel).
    const input = buildInput({ heldQuantity: '0.05' });
    const decisions = evaluateProtectiveStopArm(input, {
      ...trailingTrade.initialState(input.config),
      avgEntryPrice: '100',
      heldQuantity: '0.05',
    });
    expect(decisions).toEqual([]);
  });

  it('non-positive avgEntryPrice ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ avgEntryPrice: '0' }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '0',
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it.each(['', '0', '1'])('stopLossPercentage %s (no loss-side stop) ⇒ no decisions', (sl) => {
    const decisions = evaluateProtectiveStopArm(buildInput({ stopLossPercentage: sl }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it('unparseable limitOffsetPercentage ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(
      buildInput({ protectiveStop: { enabled: true, limitOffsetPercentage: 'bad' } }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '100',
        heldQuantity: '2',
      },
    );
    expect(decisions).toEqual([]);
  });

  it('non-positive tickSize ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ tickSize: '0' }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it('unparseable tickSize ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ tickSize: 'bad' }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it('non-positive stepSize ⇒ no decisions', () => {
    const decisions = evaluateProtectiveStopArm(buildInput({ stepSize: '0' }), {
      ...trailingTrade.initialState(buildInput().config),
      avgEntryPrice: '100',
      heldQuantity: '2',
    });
    expect(decisions).toEqual([]);
  });

  it('quantity floored below step ⇒ no decisions (degenerate sized qty)', () => {
    // held 0.00005 < stepSize 0.0001 floors to 0.
    const decisions = evaluateProtectiveStopArm(
      buildInput({ heldQuantity: '0.00005', stepSize: '0.0001' }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '100',
        heldQuantity: '0.00005',
      },
    );
    expect(decisions).toEqual([]);
  });

  it('stop floored below a tick ⇒ no decisions (degenerate stop level)', () => {
    // avgEntry 0.0001 × 0.96 = 0.000096 floors to 0 at tickSize 0.01.
    const decisions = evaluateProtectiveStopArm(
      buildInput({ avgEntryPrice: '0.0001', tickSize: '0.01' }),
      {
        ...trailingTrade.initialState(buildInput().config),
        avgEntryPrice: '0.0001',
        heldQuantity: '2',
      },
    );
    expect(decisions).toEqual([]);
  });
});

// A resting SELL that is NOT ours: an operator's manual order, or a ghost left
// behind by a deleted profile. It locks base we cannot release, so the stop is
// unfundable — the position is left undefended and today nothing says so.
const foreignRestingSell = (over: Partial<OpenOrder> = {}): OpenOrder =>
  restingProtectiveStop({
    orderId: 7777,
    clientOrderId: 'ghost-deleted-profile-stop',
    ...over,
  });

// The blocker is not on TTState yet; read it structurally so the test compiles
// today (RED on the assertion, not on the type).
const blockerOf = (
  state: unknown,
): { reason?: string; detail?: Record<string, unknown> } | null | undefined =>
  (
    state as {
      protectiveStopBlocker?: { reason?: string; detail?: Record<string, unknown> } | null;
    }
  ).protectiveStopBlocker;

describe('protective stop — a foreign resting SELL holding the base (#613)', () => {
  it('reports a blocker naming the foreign order instead of failing silently', () => {
    // Held 2, but a foreign SELL locks the whole position ⇒ free is 0 and the
    // reclaim (own-order only) is 0 ⇒ the stop cannot be sized. Today the tick
    // emits nothing at all: no order, no cancel, no signal. The operator's
    // position is unprotected and the dashboard cannot say why.
    const base = buildInput({ openOrders: [foreignRestingSell({ origQty: '2' })] });
    const input = {
      ...base,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal(0), locked: new Decimal(2) } },
        readable: true,
      },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;

    const out = trailingTrade.tick(input);

    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'protective-stop')).toBe(
      false,
    );
    const blocker = blockerOf(out.nextState);
    expect(blocker?.reason).toBe('base-locked-by-foreign-order');
    expect(blocker?.detail).toMatchObject({ foreignOrderId: 7777 });
  });
});

// No foreign order to blame: the wallet holds less base than the tracked position
// (drift, a withdrawal, or the operator's base reserve, which the worker subtracts
// from `free` before the strategy sees it). Silence here is the same defect as the
// foreign-lock silence, so it gets its own blocker — and the resting stop is LEFT
// alone: cancelling a live stop we merely cannot resize strips real protection.
describe('protective stop — nothing armable and no foreign order to name', () => {
  it('blocks (and keeps the resting stop) when the free base is below the exchange minimum', () => {
    // The wallet holds only what our own dust stop locks: 0.05 at stop 96 = 4.8,
    // below minNotional 10.
    const base = buildInput({
      openOrders: [restingProtectiveStop({ origQty: '0.05' })],
    });
    const input = {
      ...base,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal(0), locked: new Decimal('0.05') } },
        readable: true,
      },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;

    const out = trailingTrade.tick(input);
    expect(blockerOf(out.nextState)).toMatchObject({
      reason: 'base-below-exchange-minimum',
      detail: { required: '2.0000', free: '0', available: '0.05' },
    });
    expect(out.decisions.some(isCancel)).toBe(false);
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'protective-stop')).toBe(
      false,
    );
  });

  it('blocks with base-short-of-tracked-position when no base is free at all', () => {
    const base = buildInput();
    const input = {
      ...base,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal(0), locked: new Decimal(0) } },
        readable: true,
      },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;

    expect(blockerOf(trailingTrade.tick(input).nextState)?.reason).toBe(
      'base-short-of-tracked-position',
    );
  });
});

describe('protective stop — the blocker is position-scoped', () => {
  it('clears a stale blocker once the position is gone', () => {
    const base = buildInput({ avgEntryPrice: null, heldQuantity: null });
    const input = {
      ...base,
      state: { ...base.state, protectiveStopBlocker: { reason: 'base-locked-by-foreign-order' } },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;

    expect(blockerOf(trailingTrade.tick(input).nextState)).toBeNull();
  });
});

describe('protective stop — quantity drift on the resting stop (#613)', () => {
  it('re-arms at the full quantity when a foreign lock cleared and free grew back', () => {
    // Our stop was armed at 0.5 while a foreign order locked the rest of the
    // position. That lock has cleared: free is back to the full 2, so the desired
    // quantity is 2. The stopPrice is UNCHANGED (96.00 = avgEntry × stopLoss), so
    // the price-drift band does not fire — and quantity is never compared, so the
    // position stays 75% unprotected forever.
    const input = buildInput({
      openOrders: [restingProtectiveStop({ origQty: '0.5', stopPrice: '96.00' })],
    });

    const out = trailingTrade.tick(input);

    const cancel = out.decisions.find(isCancel);
    expect(cancel).toBeDefined();
    expect(cancel?.orderId).toBe(9001);
    const place = out.decisions.find((d) => isPlace(d) && d.intent.reason === 'protective-stop');
    expect(place).toBeDefined();
    if (place === undefined || !isPlace(place)) throw new Error('expected a protective-stop place');
    expect(place.params.quantity).toBe('2.0000');
    expect(place.params.stopPrice).toBe('96.00');
  });
});

describe('findRestingProtectiveStop — status + identity filter', () => {
  it('matches a NEW protective stop', () => {
    const found = findRestingProtectiveStop([restingProtectiveStop()], PROFILE_ID, SYMBOL);
    expect(found?.orderId).toBe(9001);
  });

  it('matches a PARTIALLY_FILLED protective stop', () => {
    const found = findRestingProtectiveStop(
      [restingProtectiveStop({ status: 'PARTIALLY_FILLED' })],
      PROFILE_ID,
      SYMBOL,
    );
    expect(found?.orderId).toBe(9001);
  });

  it.each(['FILLED', 'CANCELED'] as const)('does not match a %s protective stop', (status) => {
    const found = findRestingProtectiveStop(
      [restingProtectiveStop({ status })],
      PROFILE_ID,
      SYMBOL,
    );
    expect(found).toBeUndefined();
  });

  it('matches a PENDING_CANCEL protective stop so it cannot double-arm', () => {
    // A cancel in flight is not off-book: the stop still locks base and must
    // suppress a re-arm. The canonical isRestingSell denylist keeps it resting;
    // the old inline NEW/PARTIALLY_FILLED allowlist wrongly dropped it (fail-OPEN).
    const found = findRestingProtectiveStop(
      [restingProtectiveStop({ status: 'PENDING_CANCEL' })],
      PROFILE_ID,
      SYMBOL,
    );
    expect(found?.orderId).toBe(9001);
  });

  it('does not match a foreign clientOrderId', () => {
    const found = findRestingProtectiveStop(
      [restingProtectiveStop({ clientOrderId: 'tt-other-s' })],
      PROFILE_ID,
      SYMBOL,
    );
    expect(found).toBeUndefined();
  });

  it('does not match a BUY with the protective id', () => {
    const found = findRestingProtectiveStop(
      [restingProtectiveStop({ side: 'BUY' })],
      PROFILE_ID,
      SYMBOL,
    );
    expect(found).toBeUndefined();
  });
});

describe('protectiveStopCancelDecisions', () => {
  it('one cancel when a protective stop is resting', () => {
    const decisions = protectiveStopCancelDecisions(
      buildInput({ openOrders: [restingProtectiveStop()] }),
    );
    expect(decisions).toHaveLength(1);
    expect(isCancel(decisions[0])).toBe(true);
    if (!isCancel(decisions[0])) throw new Error('expected cancel');
    expect(decisions[0].orderId).toBe(9001);
    expect(decisions[0].symbol).toBe(SYMBOL);
  });

  it('empty when no protective stop is resting', () => {
    expect(protectiveStopCancelDecisions(buildInput())).toEqual([]);
  });
});

describe('reclaimableOwnSellBase — base locked by the bot’s own resting protective stop', () => {
  it('returns the resting protective stop’s origQty', () => {
    const input = buildInput({ openOrders: [restingProtectiveStop({ origQty: '2' })] });
    expect(reclaimableOwnSellBase(input).toFixed()).toBe('2');
  });

  it('is zero when no protective stop is resting', () => {
    expect(reclaimableOwnSellBase(buildInput()).toFixed()).toBe('0');
  });

  it('ignores a foreign clientOrderId (an operator’s own resting SELL)', () => {
    const input = buildInput({
      openOrders: [restingProtectiveStop({ clientOrderId: 'tt-someone-else-s' })],
    });
    expect(reclaimableOwnSellBase(input).toFixed()).toBe('0');
  });

  it('ignores a BUY carrying the protective id', () => {
    const input = buildInput({ openOrders: [restingProtectiveStop({ side: 'BUY' })] });
    expect(reclaimableOwnSellBase(input).toFixed()).toBe('0');
  });

  it.each(['FILLED', 'CANCELED'] as const)(
    'ignores a %s protective stop (not resting)',
    (status) => {
      const input = buildInput({ openOrders: [restingProtectiveStop({ status })] });
      expect(reclaimableOwnSellBase(input).toFixed()).toBe('0');
    },
  );

  it('ignores a non-positive / unparseable origQty', () => {
    const input = buildInput({
      openOrders: [
        restingProtectiveStop({ origQty: '0' }),
        restingProtectiveStop({ origQty: 'x' }),
      ],
    });
    expect(reclaimableOwnSellBase(input).toFixed()).toBe('0');
  });

  it('reclaims only the unfilled remainder of a partially-filled stop', () => {
    // origQty 2, executedQty 0.5 ⇒ only 1.5 is still locked on Binance.
    const input = buildInput({
      openOrders: [
        restingProtectiveStop({ status: 'PARTIALLY_FILLED', origQty: '2', executedQty: '0.5' }),
      ],
    });
    expect(reclaimableOwnSellBase(input).toFixed()).toBe('1.5');
  });

  it('treats an unparseable executedQty as zero filled (reclaims full origQty)', () => {
    const input = buildInput({
      openOrders: [restingProtectiveStop({ origQty: '2', executedQty: 'x' })],
    });
    expect(reclaimableOwnSellBase(input).toFixed()).toBe('2');
  });
});

describe('resolveHeldForSell — reclaimable adds back own-order-locked base', () => {
  const state = (heldQuantity: string | null): TTState => ({ heldQuantity }) as unknown as TTState;
  const balances = (free: string, locked: string) =>
    ({
      balances: { BTC: { asset: 'BTC', free: new Decimal(free), locked: new Decimal(locked) } },
      readable: true,
    }) as never;

  it('caps held against free + reclaimable (so a self-locked stop still sizes)', () => {
    // free 0, held 2, reclaim 2 ⇒ min(2, 0+2) = 2 (the prior cap of min(2,0)=0 churned).
    expect(resolveHeldForSell(state('2'), 'BTC', balances('0', '2'), new Decimal(2))).toBe('2');
  });

  it('still caps at held when free + reclaimable exceeds it', () => {
    expect(resolveHeldForSell(state('2'), 'BTC', balances('1', '2'), new Decimal(2))).toBe('2');
  });

  it('defaults reclaimable to zero (byte-identical to the prior signature)', () => {
    expect(resolveHeldForSell(state('2'), 'BTC', balances('0', '0'))).toBe('0');
  });

  it('null heldQuantity falls back to free + reclaimable (total wallet holdings)', () => {
    expect(resolveHeldForSell(state(null), 'BTC', balances('0', '2'), new Decimal(2))).toBe('2');
  });
});

describe('TTConfigSchema — protectiveStop defaults', () => {
  it('parses a minimal config to a disabled protective stop with the default offset', () => {
    const parsed = TTConfigSchema.parse({
      symbol: SYMBOL,
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.96', triggerPercentage: '1.05' },
    });
    expect(parsed.sell.protectiveStop.enabled).toBe(false);
    expect(parsed.sell.protectiveStop.limitOffsetPercentage).toBe('0.995');
  });
});

describe('buildSellDecision — MARKET shape unchanged when stopLimit omitted', () => {
  it('emits a plain MARKET SELL with the seed-hashed id', () => {
    const decision = buildSellDecision(buildInput(), 'grid-stop-loss', '2', 'stop-100');
    expect(decision.type).toBe('place-order');
    if (decision.type !== 'place-order') throw new Error('expected place');
    expect(decision.params).toEqual({ type: 'MARKET', quantity: '2' });
    expect(decision.intent.side).toBe('SELL');
    expect(decision.intent.reason).toBe('grid-stop-loss');
    // Seed-hashed id (not the protective-stop id).
    expect(decision.intent.clientOrderId).not.toBe(PROTECTIVE_ID);
    expect(decision.intent.clientOrderId.endsWith('-s')).toBe(true);
  });
});

// Ordering tests: for each position-closing sell path, with a protective stop
// resting, the cancel must precede the MARKET close (cancel index < sell index)
// and there must be exactly one MARKET SELL place-order (the close itself).
describe('closing-sell ordering — cancel precedes the MARKET sell', () => {
  const assertCancelBeforeMarketSell = (decisions: readonly Decision[]): void => {
    const cancelIdx = decisions.findIndex(isCancel);
    const placeMarketIdxs = decisions
      .map((d, i) =>
        isPlace(d) && d.params.type === 'MARKET' && d.intent.side === 'SELL' ? i : -1,
      )
      .filter((i) => i >= 0);
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(placeMarketIdxs).toHaveLength(1);
    expect(cancelIdx).toBeLessThan(placeMarketIdxs[0]);
    // The protective limit is retracted, not left resting.
    expect(decisions.filter((d) => isPlace(d) && d.params.type === 'STOP_LOSS_LIMIT')).toHaveLength(
      0,
    );
  };

  it('stop-loss close cancels the resting protective stop first', () => {
    const out = trailingTrade.tick(
      buildInput({
        // Below 96 stop ⇒ in-process MARKET stop-loss fires.
        currentPrice: '90.00',
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'grid-stop-loss')).toBe(
      true,
    );
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('sizes the in-process stop-loss off the real position when the resting stop locks the whole free balance', () => {
    // The exit path sizes via resolveHeldForSell too: a resting STOP_LOSS_LIMIT
    // locks the full position, so without reclaiming its qty `free` reads 0 and
    // the stop-loss would skip — the position could never close in-process while
    // its own protective stop rests. With the reclaim it sizes the full 2.
    const base = buildInput({ currentPrice: '90.00', openOrders: [restingProtectiveStop()] });
    const input = {
      ...base,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal(0), locked: new Decimal(2) } },
        readable: true,
      },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;
    const out = trailingTrade.tick(input);
    const sell = out.decisions.find(
      (d) => isPlace(d) && d.params.type === 'MARKET' && d.intent.side === 'SELL',
    );
    expect(sell).toBeDefined();
    if (sell === undefined || !isPlace(sell)) throw new Error('expected a MARKET SELL');
    expect(sell.intent.reason).toBe('grid-stop-loss');
    // Full position, floored to stepSize 0.0001 (not skipped to no-balance).
    expect(sell.params.quantity).toBe('2.0000');
    // The resting protective stop is still cancelled ahead of the close.
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('trailing-stop close cancels the resting protective stop first', () => {
    const out = trailingTrade.tick(
      buildInput({
        // highSinceBuy 110, trailingStop 0.98 ⇒ trailing sell at <= 107.8.
        // 100 is above the 96 stop (no stop-loss) and below 107.8 ⇒ trailing fires.
        avgEntryPrice: '100',
        highSinceBuy: '110',
        trailingStopPercentage: '0.98',
        currentPrice: '100.00',
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'grid-sell')).toBe(true);
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('technicals-force-sell close cancels the resting protective stop first', () => {
    const technicals: TTConfig['technicals'] = {
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
      // Opt out of the sub-1h confirm/cooldown defaults so the force-sell emits
      // on this single tick (a 1m row would otherwise arm a 1-minute window).
      forceSellConfirmMinutes: 0,
      forceSellReentryCooldownMinutes: 0,
    } as unknown as TTConfig['technicals'];
    const out = trailingTrade.tick(
      buildInput({
        // 102 is in profit (above 100), below the 105 trigger, above the 96 stop:
        // only the technicals force-sell branch can fire.
        avgEntryPrice: '100',
        currentPrice: '102.00',
        technicals,
        signals: [
          {
            interval: '1m',
            signal: {
              symbol: SYMBOL,
              recommendation: 'STRONG_SELL',
              maRecommendation: null,
              oscRecommendation: null,
              receivedAtMs: NOW_MS,
              indicators: null,
            },
          },
        ],
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(
      out.decisions.some((d) => isPlace(d) && d.intent.reason === 'technicals-force-sell'),
    ).toBe(true);
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('regime-exit close cancels the resting protective stop first', () => {
    const out = trailingTrade.tick(
      buildInput({
        // No stop-loss configured (so neither the in-process stop nor the
        // protective arm interferes); a confirmed daily bear drives the
        // cash-rotation exit. The resting protective stop in openOrders is
        // injected directly to exercise the cancel.
        stopLossPercentage: '',
        avgEntryPrice: '100',
        currentPrice: '95.00',
        regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { exitToCash: true } },
        dailyCloses: ['100', '100', '100', '90', '88'],
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'regime-exit')).toBe(true);
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('operator trigger-sell override cancels the resting protective stop first', () => {
    const out = trailingTrade.tick(
      buildInput({
        avgEntryPrice: '100',
        currentPrice: '105.00',
        override: {
          kind: 'trigger-sell',
          overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567',
        },
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'manual')).toBe(true);
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('manual-order SELL override cancels the resting protective stop first', () => {
    const out = trailingTrade.tick(
      buildInput({
        avgEntryPrice: '100',
        currentPrice: '105.00',
        override: {
          kind: 'manual-order',
          overrideActionId: '01234567-89ab-4cde-89ab-cdef01234568',
          payload: { side: 'SELL', type: 'MARKET', quantity: '2' },
        },
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'manual')).toBe(true);
    assertCancelBeforeMarketSell(out.decisions);
  });

  it('manual-order BUY override does NOT cancel the resting protective stop', () => {
    const out = trailingTrade.tick(
      buildInput({
        avgEntryPrice: '100',
        currentPrice: '105.00',
        override: {
          kind: 'manual-order',
          overrideActionId: '01234567-89ab-4cde-89ab-cdef01234569',
          payload: { side: 'BUY', type: 'MARKET', quoteAmount: '50' },
        },
        openOrders: [restingProtectiveStop()],
      }),
    );
    // A BUY adds exposure; the stop stays correctly in place ⇒ no cancel.
    expect(out.decisions.some(isCancel)).toBe(false);
    expect(out.decisions.some((d) => isPlace(d) && d.intent.side === 'BUY')).toBe(true);
  });
});

describe('protective stop — outside Binance’s PERCENT_PRICE_BY_SIDE band', () => {
  const BAND: PercentPriceBySideFilter = {
    bidMultiplierUp: '1.1',
    bidMultiplierDown: '0.5',
    askMultiplierUp: '2',
    askMultiplierDown: '0.95',
    avgPriceMins: 5,
  };

  it('emits neither the place nor the cancel and records the refusal', () => {
    // stop 96.00 / limit 95.52 against a floor of 105 × 0.95 = 99.75.
    const out = trailingTrade.tick(
      buildInput({
        percentPriceBySide: BAND,
        openOrders: [restingProtectiveStop({ stopPrice: '80.00' })],
      }),
    );
    expect(out.decisions.some(isCancel)).toBe(false);
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'protective-stop')).toBe(
      false,
    );
    expect(blockerOf(out.nextState)).toMatchObject({
      reason: 'price-outside-exchange-band',
      detail: { stopPrice: '96.00', price: '95.52', floor: '99.75', terminal: false },
    });
  });

  it('round-trips the new blocker through the persisted-state schema', () => {
    // The blocker is written to `symbol_states` and re-parsed on the next tick's
    // load: a reason the schema does not know reads back as a corrupt row.
    const blocked = trailingTrade.tick(
      buildInput({
        percentPriceBySide: BAND,
        openOrders: [restingProtectiveStop({ stopPrice: '80.00' })],
      }),
    ).nextState;

    const reloaded = TTStateSchema.parse(JSON.parse(JSON.stringify(blocked)));

    expect(reloaded.protectiveStopBlocker?.reason).toBe('price-outside-exchange-band');
  });

  it('accepts every reason the core vocabulary defines, not just this one', () => {
    // The schema's reason enum is a hand-copy of the core list. The round trip
    // above only ever feeds it the one reason this file is about, so it passes
    // with the other three missing. Drive the loop off the exported list and the
    // failure names the reason that went missing.
    const serialised: unknown = JSON.parse(
      JSON.stringify(
        trailingTrade.tick(
          buildInput({ openOrders: [restingProtectiveStop({ stopPrice: '80.00' })] }),
        ).nextState,
      ),
    );

    for (const reason of PROTECTIVE_STOP_BLOCKER_REASONS) {
      const parsed = TTStateSchema.parse({
        ...(serialised as object),
        protectiveStopBlocker: { reason },
      });
      expect(parsed.protectiveStopBlocker).toEqual({ reason });
    }
    // Without this the loop survives the enum being widened to z.string(),
    // which is a plausible repair when a parse blows up somewhere else.
    expect(() =>
      TTStateSchema.parse({
        ...(serialised as object),
        protectiveStopBlocker: { reason: 'not-a-real-reason' },
      }),
    ).toThrow();
  });

  it('arms unchanged on a symbol Binance publishes no band for', () => {
    const out = trailingTrade.tick(
      buildInput({ openOrders: [restingProtectiveStop({ stopPrice: '80.00' })] }),
    );
    expect(blockerOf(out.nextState)).toBeNull();
    expect(out.decisions.some((d) => isPlace(d) && d.intent.reason === 'protective-stop')).toBe(
      true,
    );
  });
});
