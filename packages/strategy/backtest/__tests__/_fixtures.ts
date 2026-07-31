import { z } from 'zod';
import type {
  Candle,
  CandleInterval,
  Strategy,
  SymbolInfo,
  TickInput,
  TickOutput,
} from '@app/strategy-core';
import type { MarketDataSource, MarketTick, StreamRequest } from '../src/types.js';

export const SYMBOL = 'BTCUSDT';
export const MIN_MS = 60_000;

export const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '0',
    tickSize: '0.01',
    stepSize: '0.00000001',
    minQty: '0',
    maxQty: '1000000',
    minPrice: '0',
    maxPrice: '1000000',
  },
};

/** A flat (constant-price) candle series of `n` 1-minute candles. */
export function flatCandles(n: number, price: string, startMs = 0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const openTimeMs = startMs + i * MIN_MS;
    out.push({
      openTimeMs,
      closeTimeMs: openTimeMs + MIN_MS - 1,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: '1',
      isClosed: true,
    });
  }
  return out;
}

/** A single flat candle (helper for executor tests). */
export function singleCandle(price: string, openMs = 0): Candle {
  return {
    openTimeMs: openMs,
    closeTimeMs: openMs + MIN_MS - 1,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: '1',
    isClosed: true,
  };
}

/** In-memory data source that yields the given candles as candle-close ticks. */
export function candleSource(
  candles: readonly Candle[],
  interval: CandleInterval = '1m',
  symbol = SYMBOL,
): MarketDataSource {
  return {
    stream(_req: StreamRequest): AsyncIterable<MarketTick> {
      async function* gen(): AsyncGenerator<MarketTick> {
        for (const candle of candles) {
          yield { kind: 'candle-close', symbol, interval, candle };
        }
      }
      return gen();
    },
  };
}

type EmptyBundle = Readonly<Record<string, never>>;

const emptyStrategy = {
  name: 'test',
  version: '1.0.0',
  displayName: 'Test',
  description: 'test strategy',
  capabilities: {
    candleIntervals: ['1m'] as CandleInterval[],
    needsUserDataStream: false,
    needsMiniTicker: false,
    bundleProviders: [],
    operatorActions: [],
  },
  configSchema: z.object({}),
  overrideConfigSchema: z.object({}),
  stateSchema: z.object({ bought: z.boolean() }),
  bundleSchema: z.object({}),
  events: {},
  defaultConfig: {},
} as const;

export interface TestState {
  readonly bought: boolean;
}

/** Never trades — used for the smoke test. */
export const idleStrategy: Strategy<Record<string, never>, TestState, EmptyBundle> = {
  ...emptyStrategy,
  initialState: () => ({ bought: false }),
  tick: (): TickOutput<TestState> => ({
    nextState: { bought: false },
    decisions: [],
    logs: [],
    metrics: [],
  }),
};

/**
 * Buys `qty` once at market on the first tick (per symbol), then holds.
 * Exercises the place-order → fill → balance-mutation path; the per-symbol
 * clientOrderId keeps a portfolio run's orders distinct.
 */
export function makeBuyOnceStrategy(
  qty: string,
): Strategy<Record<string, never>, TestState, EmptyBundle> {
  return {
    ...emptyStrategy,
    initialState: () => ({ bought: false }),
    tick: (
      input: TickInput<Record<string, never>, TestState, EmptyBundle>,
    ): TickOutput<TestState> => {
      if (input.state.bought) {
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      }
      return {
        nextState: { bought: true },
        decisions: [
          {
            type: 'place-order',
            intent: {
              symbol: input.market.symbol,
              side: 'BUY',
              reason: 'manual',
              clientOrderId: `bt-buy-${input.market.symbol}`,
            },
            params: { type: 'MARKET', quantity: qty },
          },
        ],
        logs: [],
        metrics: [],
      };
    },
  };
}

/** Buys 0.01 once per symbol — the default used by the single-symbol tests. */
export const buyOnceStrategy = makeBuyOnceStrategy('0.01');

export interface DiagState {
  readonly n: number;
}

/**
 * Emits deterministic per-tick metrics and logs (no trades) so the engine's
 * decision-breakdown aggregation can be asserted: a constant skip counter, an
 * emit counter on even ticks, a varying-value gauge (must be excluded from the
 * breakdown), a reason-carrying veto log, and a reason-less note log. The tick
 * counter rides state, keeping the strategy pure.
 */
export const diagStrategy: Strategy<Record<string, never>, DiagState, EmptyBundle> = {
  ...emptyStrategy,
  stateSchema: z.object({ n: z.number() }),
  initialState: () => ({ n: 0 }),
  tick: (
    input: TickInput<Record<string, never>, DiagState, EmptyBundle>,
  ): TickOutput<DiagState> => {
    const n = input.state.n + 1;
    const symbol = input.market.symbol;
    return {
      nextState: { n },
      decisions: [],
      logs: [
        { level: 'info', message: 'diag-veto', context: { symbol, reason: 'gate-x' } },
        { level: 'debug', message: 'diag-note' },
      ],
      metrics: [
        { name: 'diag_skip', value: 1, tags: { symbol, reason: 'r1' } },
        // A gauge: value is the reading (n + 0.5), never 1, so the engine must
        // drop it from the breakdown rather than count occurrences.
        { name: 'diag_gauge', value: n + 0.5, tags: { symbol } },
        ...(n % 2 === 0 ? [{ name: 'diag_emit', value: 1, tags: { symbol } }] : []),
      ],
    };
  },
};

export interface PositionState {
  readonly avgEntryPrice: string | null;
  readonly heldQuantity: string | null;
}

/**
 * Minimal position-managing strategy: buys `qty` at market while flat
 * (`avgEntryPrice === null`) and holds once it has a position. It implements
 * the {@link PositionStateAdapter} but NEVER writes the position in `tick`'s
 * `nextState` — exactly like TT, the position is set only by the engine's
 * fill-adoption. So a single buy proves adoption fired; a re-buy every candle
 * proves it did not. The weighted-average on a second buy is asserted via the
 * adapter directly.
 */
export function makePositionStrategy(
  qty: string,
): Strategy<Record<string, never>, PositionState, EmptyBundle> {
  const position: import('@app/strategy-core').PositionStateAdapter<PositionState> = {
    readPosition: (s) => ({ avgEntryPrice: s.avgEntryPrice, heldQuantity: s.heldQuantity }),
    applyFill: (s, fill) => {
      switch (fill.kind) {
        case 'buy':
          return { avgEntryPrice: fill.avgEntryPrice, heldQuantity: fill.heldQuantity };
        case 'sell-reduce':
          return { ...s, heldQuantity: fill.heldQuantity };
        case 'empty':
          return { avgEntryPrice: null, heldQuantity: null };
      }
    },
    setHeldQuantity: (s, heldQuantity) => ({ ...s, heldQuantity }),
    setAvgEntryPrice: (s, avgEntryPrice) => ({ ...s, avgEntryPrice }),
  };
  return {
    ...emptyStrategy,
    stateSchema: z.object({
      avgEntryPrice: z.string().nullable(),
      heldQuantity: z.string().nullable(),
    }),
    position,
    initialState: () => ({ avgEntryPrice: null, heldQuantity: null }),
    tick: (
      input: TickInput<Record<string, never>, PositionState, EmptyBundle>,
    ): TickOutput<PositionState> => {
      if (input.state.avgEntryPrice !== null) {
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      }
      return {
        nextState: input.state, // position is set by adoption, not by tick
        decisions: [
          {
            type: 'place-order',
            intent: {
              symbol: input.market.symbol,
              side: 'BUY',
              reason: 'manual',
              clientOrderId: `bt-pos-${input.market.symbol}`,
            },
            params: { type: 'MARKET', quantity: qty },
          },
        ],
        logs: [],
        metrics: [],
      };
    },
  };
}
