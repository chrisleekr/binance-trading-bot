// Maker entry timeout (execution.entryTimeoutBars): a passive LIMIT entry that
// rests unfilled for N closed candles is cancelled so the next tick re-prices it
// to the current market. Strategy-side and flat-only: the cancel flows through
// the same Decision path in backtest and live, so no engine change is needed.
// Default 0 = OFF (byte-identical to the prior maker behaviour), and the timeout
// is inert in market mode (a market entry never rests).

import { describe, expect, it } from 'vitest';
import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTState,
  type TTBundle,
  type TTConfig,
} from '../src/index.js';
import type { Decision, OpenOrder, TickInput } from '@app/strategy-core';
import { gridBuyClientOrderId } from '../src/client-order-id.js';

const NOW_MS = 1_700_000_000_000;
const PROFILE_ID = 'p1';
const SYMBOL = 'BTCUSDT';

interface BuildOpts {
  readonly entryMode?: 'market' | 'maker';
  readonly entryTimeoutBars?: number;
  readonly closedBars?: number;
  readonly avgEntryPrice?: string | null;
  readonly currentGridTradeIndex?: number | null;
  readonly gridLevels?: readonly { triggerPercentage: string; maxPurchaseAmount: string }[];
  readonly openOrders?: readonly OpenOrder[];
}

/** `n` closed 1h candles with closeTimeMs 1..n, all strictly after a t=0 order. */
const barsAfter = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: i,
    closeTimeMs: i + 1,
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '1',
    isClosed: true,
  }));

/** A resting passive entry: LIMIT BUY placed at t=0 (so the bars above close after it). */
const restingEntryBuy = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 7001,
  clientOrderId: 'tt-firstbuy-p1-BTCUSDT',
  symbol: SYMBOL,
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  price: '99.50',
  origQty: '0.5',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  timeInForce: 'GTC',
  transactTimeMs: 0,
  updateTimeMs: 0,
  ...over,
});

const buildInput = (o: BuildOpts = {}): TickInput<TTConfig, TTState, TTBundle> => {
  const config = TTConfigSchema.parse({
    symbol: SYMBOL,
    candleInterval: '1h',
    buy: {
      enabled: true,
      firstBuyTriggerBasis: 'immediate',
      entrySizing: { mode: 'fixed', amount: '50' },
      ...(o.gridLevels ? { gridLevels: o.gridLevels } : {}),
    },
    sell: { enabled: true, stopLossPercentage: '0.96', triggerPercentage: '1.05' },
    execution: {
      entryMode: o.entryMode ?? 'maker',
      ...(o.entryTimeoutBars !== undefined ? { entryTimeoutBars: o.entryTimeoutBars } : {}),
    },
  }) as TTConfig;

  const held = o.avgEntryPrice !== undefined && o.avgEntryPrice !== null;
  const state: TTState = {
    ...trailingTrade.initialState(config),
    avgEntryPrice: o.avgEntryPrice ?? null,
    ...(held ? { heldQuantity: '0.5', currentGridTradeIndex: 0 } : {}),
    ...(o.currentGridTradeIndex !== undefined
      ? { currentGridTradeIndex: o.currentGridTradeIndex }
      : {}),
  };

  const bundle = TTBundleSchema.parse({
    technicals: {
      config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
      signals: [],
    },
    override: null,
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
    state,
    market: {
      symbol: SYMBOL,
      currentPrice: '100.00',
      candlesByInterval: { '1h': barsAfter(o.closedBars ?? 0) } as TickInput<
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
          tickSize: '0.01',
          stepSize: '0.0001',
          minQty: '0.0001',
          maxQty: '9000',
          minPrice: '0.01',
          maxPrice: '1000000',
        },
      },
    },
    account: { balances: { USDT: { asset: 'USDT', free: '1000', locked: '0' } }, readable: true },
    openOrders: o.openOrders ?? [],
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  } as unknown as TickInput<TTConfig, TTState, TTBundle>;
};

const timeoutCancels = (
  decisions: readonly Decision[],
): Extract<Decision, { type: 'cancel-order' }>[] =>
  decisions.filter(
    (d): d is Extract<Decision, { type: 'cancel-order' }> =>
      d.type === 'cancel-order' && d.reason === 'tt-entry-timeout',
  );

describe('maker entry timeout — tick cancels a stale resting maker entry', () => {
  it('cancels the resting LIMIT entry once entryTimeoutBars closed candles elapse', () => {
    const out = trailingTrade.tick(
      buildInput({ entryTimeoutBars: 3, closedBars: 3, openOrders: [restingEntryBuy()] }),
    );
    const cancels = timeoutCancels(out.decisions);
    expect(cancels).toHaveLength(1);
    expect(cancels[0].orderId).toBe(7001);
    expect(cancels[0].symbol).toBe(SYMBOL);
  });

  it('does NOT cancel before enough closed candles elapse', () => {
    const out = trailingTrade.tick(
      buildInput({ entryTimeoutBars: 3, closedBars: 2, openOrders: [restingEntryBuy()] }),
    );
    expect(timeoutCancels(out.decisions)).toHaveLength(0);
  });

  it('is OFF by default (entryTimeoutBars 0) even after many candles', () => {
    const out = trailingTrade.tick(buildInput({ closedBars: 10, openOrders: [restingEntryBuy()] }));
    expect(timeoutCancels(out.decisions)).toHaveLength(0);
  });

  it('is inert in market mode (a market entry never rests)', () => {
    const out = trailingTrade.tick(
      buildInput({
        entryMode: 'market',
        entryTimeoutBars: 3,
        closedBars: 5,
        openOrders: [restingEntryBuy()],
      }),
    );
    expect(timeoutCancels(out.decisions)).toHaveLength(0);
  });

  it('leaves a STOP_LOSS_LIMIT breakout buy alone (it waits for the stop, not a timer)', () => {
    const out = trailingTrade.tick(
      buildInput({
        entryTimeoutBars: 3,
        closedBars: 5,
        openOrders: [restingEntryBuy({ type: 'STOP_LOSS_LIMIT', stopPrice: '101' })],
      }),
    );
    expect(timeoutCancels(out.decisions)).toHaveLength(0);
  });

  it('does NOT fire while holding a position (promotions are re-priced by the grid path)', () => {
    const out = trailingTrade.tick(
      buildInput({
        entryTimeoutBars: 3,
        closedBars: 5,
        avgEntryPrice: '100',
        openOrders: [restingEntryBuy()],
      }),
    );
    expect(timeoutCancels(out.decisions)).toHaveLength(0);
  });

  it('cancels each matching resting LIMIT entry when several are stale', () => {
    const out = trailingTrade.tick(
      buildInput({
        entryTimeoutBars: 3,
        closedBars: 3,
        openOrders: [
          restingEntryBuy({ orderId: 7001 }),
          restingEntryBuy({ orderId: 7002, clientOrderId: 'manual-xyz' }),
        ],
      }),
    );
    const ids = timeoutCancels(out.decisions)
      .map((c) => c.orderId)
      .sort((a, b) => a - b);
    expect(ids).toEqual([7001, 7002]);
  });

  it('ignores a resting SELL and a buy on another symbol (filter is symbol + BUY + LIMIT)', () => {
    const out = trailingTrade.tick(
      buildInput({
        entryTimeoutBars: 3,
        closedBars: 3,
        openOrders: [
          restingEntryBuy({ orderId: 7001 }),
          restingEntryBuy({ orderId: 7002, side: 'SELL' }),
          restingEntryBuy({ orderId: 7003, symbol: 'ETHUSDT' }),
        ],
      }),
    );
    const ids = timeoutCancels(out.decisions).map((c) => c.orderId);
    expect(ids).toEqual([7001]);
  });

  it('resets a flat grid index to null when it times out the level-0 entry, so level 0 re-fires', () => {
    // A grid maker level-0 entry rests as a plain LIMIT with currentGridTradeIndex
    // stamped 0 while flat. Cancelling it MUST clear the index, or the profile
    // wedges flat with no order (the level-0 re-entry needs the index null).
    const out = trailingTrade.tick(
      buildInput({
        entryTimeoutBars: 3,
        closedBars: 3,
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '50' }],
        currentGridTradeIndex: 0,
        openOrders: [
          restingEntryBuy({ clientOrderId: gridBuyClientOrderId(PROFILE_ID, SYMBOL, 0) }),
        ],
      }),
    );
    expect(timeoutCancels(out.decisions)).toHaveLength(1);
    expect(out.nextState.currentGridTradeIndex).toBeNull();
  });
});

describe('TTConfigSchema — entryTimeoutBars default', () => {
  it('defaults entryTimeoutBars to 0 (OFF) when the execution block omits it', () => {
    const parsed = TTConfigSchema.parse({
      symbol: SYMBOL,
      candleInterval: '1h',
      buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '50' } },
      sell: { enabled: true, stopLossPercentage: '0.96', triggerPercentage: '1.05' },
      execution: { entryMode: 'maker' },
    });
    expect(parsed.execution.entryTimeoutBars).toBe(0);
  });
});
