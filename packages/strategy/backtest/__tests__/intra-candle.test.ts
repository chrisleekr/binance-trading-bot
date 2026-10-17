import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  Candle,
  CandleInterval,
  PositionStateAdapter,
  Strategy,
  TickInput,
  TickOutput,
} from '@app/strategy-core';

import { runBacktest } from '../src/run.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { arrayMarketDataSource } from '../src/portfolio-source.js';
import { SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const HOUR = 3_600_000;
const QUARTER = 900_000;

function bar(
  openTimeMs: number,
  durMs: number,
  o: string,
  h: string,
  l: string,
  c: string,
): Candle {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + durMs - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: '1000',
    isClosed: true,
  };
}

type EmptyBundle = Readonly<Record<string, never>>;
interface TrailState {
  readonly avgEntryPrice: string | null;
  readonly heldQuantity: string | null;
  readonly bought: boolean;
  readonly peak: string | null;
}

/** What one tick saw, captured by the test strategy so the engine's feed can be asserted. */
interface SeenTick {
  readonly kind: string;
  readonly price: string;
  readonly windowEndMs: number | null;
  readonly barOpens: readonly number[];
  readonly held: boolean;
  readonly indicatorKeys: readonly string[];
  /** Whether the host yield was still mid-flight when this tick ran. */
  readonly yieldPending: boolean;
}

// Shared between the probe and an async yield hook: set while the hook awaits, so a tick that runs before the engine has awaited it records `true`.
const yieldState = { pending: false };

// A miniature profit trail: buys once at market on the first close, then tracks the highest 15m close it has been handed and sells on a 5% retrace from it. Its exit can only fire mid-candle when the engine ticks it on the 15m bars, which is the behaviour under test.
function trailProbe(seen: SeenTick[]): Strategy<Record<string, never>, TrailState, EmptyBundle> {
  const position: PositionStateAdapter<TrailState> = {
    readPosition: (s) => ({ avgEntryPrice: s.avgEntryPrice, heldQuantity: s.heldQuantity }),
    applyFill: (s, fill) => {
      switch (fill.kind) {
        case 'buy':
          return { ...s, avgEntryPrice: fill.avgEntryPrice, heldQuantity: fill.heldQuantity };
        case 'sell-reduce':
          return { ...s, heldQuantity: fill.heldQuantity };
        case 'empty':
          return { ...s, avgEntryPrice: null, heldQuantity: null, peak: null };
      }
    },
    setHeldQuantity: (s, heldQuantity) => ({ ...s, heldQuantity }),
    setAvgEntryPrice: (s, avgEntryPrice) => ({ ...s, avgEntryPrice }),
  };
  return {
    name: 'trail-probe',
    version: '1.0.0',
    displayName: 'Trail probe',
    description: 'test strategy',
    capabilities: {
      candleIntervals: ['1h'] as CandleInterval[],
      needsUserDataStream: false,
      needsMiniTicker: true,
      bundleProviders: [],
      operatorActions: [],
    },
    configSchema: z.object({}),
    overrideConfigSchema: z.object({}),
    stateSchema: z.object({
      avgEntryPrice: z.string().nullable(),
      heldQuantity: z.string().nullable(),
      bought: z.boolean(),
      peak: z.string().nullable(),
    }),
    bundleSchema: z.object({}),
    events: {},
    defaultConfig: {},
    position,
    initialState: () => ({ avgEntryPrice: null, heldQuantity: null, bought: false, peak: null }),
    tick: (
      input: TickInput<Record<string, never>, TrailState, EmptyBundle>,
    ): TickOutput<TrailState> => {
      const { state, market } = input;
      const window = market.candlesByInterval['1h'] ?? [];
      const bars = market.candlesByInterval['15m'] ?? [];
      const held = state.heldQuantity !== null && Number(state.heldQuantity) > 0;
      seen.push({
        kind: input.trigger.kind,
        price: market.currentPrice,
        windowEndMs: window.length > 0 ? (window[window.length - 1]?.closeTimeMs ?? null) : null,
        barOpens: bars.map((b) => b.openTimeMs),
        held,
        indicatorKeys: Object.keys(market.indicatorsByInterval ?? {}),
        yieldPending: yieldState.pending,
      });
      const empty = { logs: [], metrics: [] };
      if (!held) {
        if (state.bought) return { nextState: state, decisions: [], ...empty };
        return {
          nextState: { ...state, bought: true },
          decisions: [
            {
              type: 'place-order',
              intent: {
                symbol: market.symbol,
                side: 'BUY',
                reason: 'entry',
                clientOrderId: 'bt-in',
              },
              params: { type: 'MARKET', quantity: '1' },
            },
          ],
          ...empty,
        };
      }
      let peak = Number(state.peak ?? state.avgEntryPrice ?? '0');
      for (const b of bars) peak = Math.max(peak, Number(b.close));
      const next = { ...state, peak: String(peak) };
      if (Number(market.currentPrice) > peak * 0.95)
        return { nextState: next, decisions: [], ...empty };
      return {
        nextState: next,
        decisions: [
          {
            type: 'place-order',
            intent: {
              symbol: market.symbol,
              side: 'SELL',
              reason: 'exit',
              clientOrderId: 'bt-out',
            },
            params: { type: 'MARKET', quantity: state.heldQuantity ?? '0' },
          },
        ],
        ...empty,
      };
    },
  };
}

// Hour 0 is flat at 100, where the probe buys on the close. Hour 1 runs to 120 on its second quarter, falls to 112 on its third (more than 5% off 120), and closes the hour at 108 with the last quarter opening at 111.
const COARSE: Candle[] = [
  bar(0, HOUR, '100', '100', '100', '100'),
  bar(HOUR, HOUR, '100', '121', '107', '108'),
];
const DETAIL: Candle[] = [
  bar(0, QUARTER, '100', '100', '100', '100'),
  bar(QUARTER, QUARTER, '100', '100', '100', '100'),
  bar(2 * QUARTER, QUARTER, '100', '100', '100', '100'),
  bar(3 * QUARTER, QUARTER, '100', '100', '100', '100'),
  bar(HOUR, QUARTER, '100', '101', '100', '100'),
  bar(HOUR + QUARTER, QUARTER, '100', '121', '100', '120'),
  bar(HOUR + 2 * QUARTER, QUARTER, '120', '120', '111', '112'),
  bar(HOUR + 3 * QUARTER, QUARTER, '111', '111', '107', '108'),
];

async function run(intraCandle: boolean, seen: SeenTick[]) {
  return runBacktest({
    strategy: trailProbe(seen),
    config: {},
    dataSource: arrayMarketDataSource([
      { symbol: SYMBOL, interval: '1h', candles: COARSE, detailCandles: DETAIL },
    ]),
    fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
    request: { symbols: [SYMBOL], intervals: ['1h'], fromMs: 0, toMs: 2 * HOUR },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    startupCandleCount: 0,
    ...(intraCandle ? { intraCandle: { interval: '15m' as CandleInterval } } : {}),
  });
}

describe('runBacktest — within-candle ticks (intraCandle)', () => {
  it('exits mid-candle on a retrace that one tick per candle never sees', async () => {
    const report = await run(true, []);
    const sells = report.trades.filter((t) => t.side === 'SELL');
    expect(report.trades.find((t) => t.side === 'BUY')?.price).toBe('100');
    // The retrace tick is the 112 bar; the MARKET sell it places fills on the next bar's open, inside hour 1.
    expect(sells).toHaveLength(1);
    expect(sells[0]?.price).toBe('111');
    expect(sells[0]?.tsMs).toBeLessThan(2 * HOUR);
  });

  it('holds through the same candle when within-candle ticking is off', async () => {
    const report = await run(false, []);
    expect(report.trades.filter((t) => t.side === 'SELL')).toHaveLength(0);
  });

  it('ticks only while holding, sees the trading window end at the previous close, and hands each bar over exactly once', async () => {
    const seen: SeenTick[] = [];
    await run(true, seen);
    // Hour 0 has no within-candle tick: nothing is held until the buy placed on its close fills.
    expect(seen.filter((s) => s.windowEndMs === null || s.windowEndMs < HOUR - 1)).toHaveLength(0);
    const intra = seen.filter((s) => s.kind === 'tick');
    expect(intra.map((s) => s.price)).toEqual(['100', '120', '112']);
    expect(intra.every((s) => s.held && s.windowEndMs === HOUR - 1)).toBe(true);
    // Every 15m bar reaches the strategy once, in order: hour 0's four on its close, then one per within-candle tick, then the last bar on hour 1's close.
    expect(seen.flatMap((s) => s.barOpens)).toEqual(DETAIL.map((b) => b.openTimeMs));
  });

  it('awaits the host yield after every within-candle tick', async () => {
    let yields = 0;
    const seen: SeenTick[] = [];
    await runBacktest({
      strategy: trailProbe(seen),
      config: {},
      dataSource: arrayMarketDataSource([
        { symbol: SYMBOL, interval: '1h', candles: COARSE, detailCandles: DETAIL },
      ]),
      fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
      request: { symbols: [SYMBOL], intervals: ['1h'], fromMs: 0, toMs: 2 * HOUR },
      initialBalances: { USDT: '1000' },
      quoteAsset: 'USDT',
      symbolInfos: [SYMBOL_INFO],
      startupCandleCount: 0,
      intraCandle: { interval: '15m' },
      onIntraCandleTick: async () => {
        yields += 1;
        yieldState.pending = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldState.pending = false;
      },
    });
    // Three within-candle ticks fire (the 100, 120 and 112 bars), each followed by one yield.
    expect(yields).toBe(3);
    // Every later tick ran after the yield before it had resolved, which only holds if the engine awaits it.
    expect(seen.every((s) => !s.yieldPending)).toBe(true);
  });

  it('drops warm-up bars instead of handing them to the first traded tick', async () => {
    const seen: SeenTick[] = [];
    const shift = (c: Candle): Candle => ({
      ...c,
      openTimeMs: c.openTimeMs + HOUR,
      closeTimeMs: c.closeTimeMs + HOUR,
    });
    // One warm-up hour, with its own 15m bars, before the scenario shifted one hour later.
    const warmDetail = [0, 1, 2, 3].map((q) =>
      bar(q * QUARTER, QUARTER, '100', '100', '100', '100'),
    );
    await runBacktest({
      strategy: trailProbe(seen),
      config: {},
      dataSource: arrayMarketDataSource([
        {
          symbol: SYMBOL,
          interval: '1h',
          candles: [bar(0, HOUR, '100', '100', '100', '100'), ...COARSE.map(shift)],
          detailCandles: [...warmDetail, ...DETAIL.map(shift)],
        },
      ]),
      fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
      request: { symbols: [SYMBOL], intervals: ['1h'], fromMs: 0, toMs: 3 * HOUR },
      initialBalances: { USDT: '1000' },
      quoteAsset: 'USDT',
      symbolInfos: [SYMBOL_INFO],
      startupCandleCount: 1,
      intraCandle: { interval: '15m' },
    });
    // The first traded tick is hour 1's close; it sees hour 1's four bars and none of the warm-up hour's.
    expect(seen[0]?.barOpens).toEqual([
      HOUR,
      HOUR + QUARTER,
      HOUR + 2 * QUARTER,
      HOUR + 3 * QUARTER,
    ]);
  });

  it('computes indicators for the trading window but never for the bar slice', async () => {
    const seen: SeenTick[] = [];
    await run(true, seen);
    // The slice is not a rolling window: feeding it to the snapshot computer would corrupt its one-candle-per-step state.
    expect(seen.every((s) => s.indicatorKeys.includes('1h'))).toBe(true);
    expect(seen.some((s) => s.indicatorKeys.includes('15m'))).toBe(false);
  });

  it('refuses a second symbol, whose bars would replay out of time order', async () => {
    const other = { ...SYMBOL_INFO, symbol: 'ETHUSDT', baseAsset: 'ETH' };
    await expect(
      runBacktest({
        strategy: trailProbe([]),
        config: {},
        dataSource: arrayMarketDataSource([
          { symbol: SYMBOL, interval: '1h', candles: COARSE, detailCandles: DETAIL },
          { symbol: 'ETHUSDT', interval: '1h', candles: COARSE, detailCandles: DETAIL },
        ]),
        fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
        request: { symbols: [SYMBOL, 'ETHUSDT'], intervals: ['1h'], fromMs: 0, toMs: 2 * HOUR },
        initialBalances: { USDT: '1000' },
        quoteAsset: 'USDT',
        symbolInfos: [SYMBOL_INFO, other],
        startupCandleCount: 0,
        intraCandle: { interval: '15m' },
      }),
    ).rejects.toThrow(/within-candle ticking replays one symbol/);
  });
});
