// The exit blocker is state, not a decision: a held tick that emits nothing must
// still leave a readable record of the rung it stopped at, and a flat position
// must not keep one. These drive the whole tick(), so they also pin the two
// gates the sell ladder never sees (sell disabled, an exit already resting).

import { Decimal } from '@app/money';
import type { OpenOrder, TickInput } from '@app/strategy-core';
import { describe, expect, it } from 'vitest';

import {
  trailingTrade,
  TTBundleSchema,
  TTConfigSchema,
  TTStateSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from '../src/index.js';

const NOW_MS = 1_700_000_000_000;

const cfg = (sell: Record<string, unknown> = {}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: false,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0', triggerPercentage: '1.05', ...sell },
  });

const state = (o: Partial<TTState> = {}): TTState =>
  TTStateSchema.parse({ schemaVersion: '2.0.0', triggers: { override: null }, ...o });

const restingSell = (): OpenOrder => ({
  orderId: 9,
  clientOrderId: 'resting-sell',
  symbol: 'BTCUSDT',
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  price: '52000',
  origQty: '0.001',
  executedQty: '0',
  timeMs: NOW_MS,
});

const input = (o: {
  config?: TTConfig;
  state: TTState;
  openOrders?: readonly OpenOrder[];
}): TickInput<TTConfig, TTState, TTBundle> => ({
  clock: { nowMs: () => NOW_MS },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: 'p1',
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '1.0.0',
  },
  config: o.config ?? cfg(),
  state: o.state,
  market: {
    symbol: 'BTCUSDT',
    currentPrice: '50000',
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
        minQty: '0.0001',
        maxQty: '9000',
        minPrice: '0.01',
        maxPrice: '1000000',
      },
    },
  },
  account: {
    balances: { BTC: { asset: 'BTC', free: new Decimal('0.001'), locked: new Decimal(0) } },
    readable: true,
  },
  openOrders: o.openOrders ?? [],
  bundle: TTBundleSchema.parse({
    technicals: {
      config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
      signals: [],
    },
    override: null,
  }),
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
});

const HELD = { avgEntryPrice: '50000', heldQuantity: '0.001' };

describe('trailingTrade.tick — exitBlocker', () => {
  it('records the rung a held position is waiting on when no exit fires', () => {
    const out = trailingTrade.tick(input({ state: state(HELD) }));
    // No order decision: the blocker is the ONLY trace this tick leaves.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.nextState.exitBlocker).toEqual({
      reason: 'awaiting-sell-arm',
      changeKey: 'awaiting-sell-arm|armPrice=52500',
      detail: { armPrice: '52500', currentPrice: '50000', hasDownsideExit: false },
    });
  });

  it('reports the switched-off sell side ahead of any rung', () => {
    const out = trailingTrade.tick(input({ config: cfg({ enabled: false }), state: state(HELD) }));
    expect(out.nextState.exitBlocker?.reason).toBe('sell-disabled');
  });

  it('reports an exit already resting on the book', () => {
    const out = trailingTrade.tick(input({ state: state(HELD), openOrders: [restingSell()] }));
    expect(out.nextState.exitBlocker?.reason).toBe('exit-order-open');
  });

  it('flags a held position that has no exit below the entry at all', () => {
    // No stop-loss, no break-even, no ATR trail, no time stop: the position can
    // only ever be closed by a profit exit or by the operator.
    const out = trailingTrade.tick(input({ state: state(HELD) }));
    expect(out.nextState.exitBlocker?.detail?.['hasDownsideExit']).toBe(false);
  });

  it('flags a held position whose only bar-count exit belongs to the other entry kind', () => {
    // The production shape: a discovery time stop configured on a position that
    // was NOT a discovery entry, so that rung never runs and the warning has to
    // reach the record the operator reads.
    const out = trailingTrade.tick(
      input({ config: cfg({ discoveryTimeStopBars: 24 }), state: state(HELD) }),
    );
    expect(out.nextState.exitBlocker?.detail?.['hasDownsideExit']).toBe(false);
  });

  it('does not flag the same config on an actual discovery entry', () => {
    const out = trailingTrade.tick(
      input({
        config: cfg({ discoveryTimeStopBars: 24 }),
        state: state({ ...HELD, discoveryEntry: true }),
      }),
    );
    expect(out.nextState.exitBlocker?.detail?.['hasDownsideExit']).toBe(true);
  });

  it('does not flag a position whose hard stop is configured', () => {
    const out = trailingTrade.tick(
      input({ config: cfg({ stopLossPercentage: '0.97' }), state: state(HELD) }),
    );
    expect(out.nextState.exitBlocker?.detail?.['hasDownsideExit']).toBe(true);
  });

  it('clears a stale blocker once the position is flat', () => {
    // "Why didn't it sell" is meaningless with nothing held; a frozen reason
    // would misreport the next entry from its very first tick.
    const out = trailingTrade.tick(
      input({
        state: state({ exitBlocker: { reason: 'awaiting-sell-arm', detail: { armPrice: '1' } } }),
      }),
    );
    expect(out.nextState.exitBlocker).toBeNull();
  });
});
