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
}

// A miniature profit trail: buys once at market on the first close, then tracks the highest 15m close it has been handed and sells on a 5% retrace from it. Its exit can only fire mid-candle on a decision clock finer than the hour.
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

const closedBy = (candles: readonly Candle[], asOfMs: number): readonly Candle[] =>
  candles.filter((c) => c.closeTimeMs <= asOfMs);

async function run(decisionMs: number, seen: SeenTick[]) {
  return runBacktest({
    strategy: trailProbe(seen),
    config: {},
    dataSource: arrayMarketDataSource([{ symbol: SYMBOL, interval: '15m', candles: DETAIL }]),
    fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
    request: { symbols: [SYMBOL], intervals: ['15m'], fromMs: 0, toMs: 2 * HOUR },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    auxiliaryWindows: ({ asOfMs }) => ({
      '1h': closedBy(COARSE, asOfMs),
      '15m': closedBy(DETAIL, asOfMs),
    }),
    decisionClock: { intervalMs: decisionMs, strategyInterval: '1h' },
  });
}

describe('runBacktest decision clock over detail bars', () => {
  it('exits mid-candle on a retrace that an hourly decision never sees', async () => {
    const report = await run(QUARTER, []);
    const sells = report.trades.filter((t) => t.side === 'SELL');
    expect(report.trades.find((t) => t.side === 'BUY')?.price).toBe('100');
    // The retrace tick is the 112 bar; the MARKET sell it places fills on the next bar's open, inside hour 1.
    expect(sells).toHaveLength(1);
    expect(sells[0]?.price).toBe('111');
    expect(sells[0]?.tsMs).toBeLessThan(2 * HOUR);
  });

  it('holds through the same candle on an hourly decision clock', async () => {
    const report = await run(HOUR, []);
    expect(report.trades.filter((t) => t.side === 'SELL')).toHaveLength(0);
  });

  it('hands every decision the closed hourly window and a rolling detail window', async () => {
    const seen: SeenTick[] = [];
    await run(QUARTER, seen);
    expect(seen.map((s) => s.kind)).toEqual(Array.from({ length: 8 }, () => 'tick'));
    // The in-progress hour never appears: its candle closes only at the last decision.
    expect(seen.map((s) => s.windowEndMs)).toEqual([
      null,
      null,
      null,
      HOUR - 1,
      HOUR - 1,
      HOUR - 1,
      HOUR - 1,
      2 * HOUR - 1,
    ]);
    expect(seen.at(-1)?.barOpens).toEqual(DETAIL.map((b) => b.openTimeMs));
  });

  it('computes indicators for every native window', async () => {
    const seen: SeenTick[] = [];
    await run(QUARTER, seen);
    expect(seen.at(-1)?.indicatorKeys.toSorted()).toEqual(['15m', '1h']);
  });
});
