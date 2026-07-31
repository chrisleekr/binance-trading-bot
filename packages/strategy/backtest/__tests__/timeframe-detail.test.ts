import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Candle, CandleInterval, Strategy, TickInput, TickOutput } from '@app/strategy-core';

import { runBacktest } from '../src/run.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { arrayMarketDataSource, mergeCandleTicks } from '../src/portfolio-source.js';
import { SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const HOUR = 3_600_000;
const HALF = 1_800_000;

function candle(
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
    volume: '1',
    isClosed: true,
  };
}

type EmptyBundle = Readonly<Record<string, never>>;
interface St {
  readonly placed: boolean;
}

// Places one resting LIMIT BUY at `limit` on the first tick, then holds. The
// order rests on the candle it is placed and is first evaluated on the next —
// where the detail bars decide whether it crosses.
function limitBuyOnce(limit: string): Strategy<Record<string, never>, St, EmptyBundle> {
  return {
    name: 'limit-buy-once',
    version: '1.0.0',
    displayName: 'Limit buy once',
    description: 'test strategy',
    capabilities: {
      candleIntervals: ['1h'] as CandleInterval[],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    configSchema: z.object({}),
    overrideConfigSchema: z.object({}),
    stateSchema: z.object({ placed: z.boolean() }),
    bundleSchema: z.object({}),
    events: {},
    defaultConfig: {},
    initialState: () => ({ placed: false }),
    tick: (input: TickInput<Record<string, never>, St, EmptyBundle>): TickOutput<St> => {
      if (input.state.placed) {
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      }
      return {
        nextState: { placed: true },
        decisions: [
          {
            type: 'place-order',
            intent: {
              symbol: input.market.symbol,
              side: 'BUY',
              reason: 'grid-buy',
              clientOrderId: 'bt-limit',
            },
            params: { type: 'LIMIT', price: limit, quantity: '1' },
          },
        ],
        logs: [],
        metrics: [],
      };
    },
  };
}

async function runWithDetail(detailCandles: readonly Candle[] | undefined) {
  // Two 1h candles: the strategy places a 95 LIMIT BUY on candle 0; candle 1's
  // COARSE low (94) crosses 95, but its detail bars (supplied by the caller)
  // decide the real outcome.
  const coarse: Candle[] = [
    candle(0, HOUR, '100', '101', '99', '100'),
    candle(HOUR, HOUR, '100', '100', '94', '96'),
  ];
  const series = [
    {
      symbol: SYMBOL,
      interval: '1h' as CandleInterval,
      candles: coarse,
      ...(detailCandles ? { detailCandles } : {}),
    },
  ];
  return runBacktest({
    strategy: limitBuyOnce('95'),
    config: {},
    dataSource: arrayMarketDataSource(series),
    fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
    request: { symbols: [SYMBOL], intervals: ['1h'], fromMs: 0, toMs: 2 * HOUR },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    startupCandleCount: 0,
  });
}

describe('mergeCandleTicks — detail-bar grouping', () => {
  it('attaches each symbol’s detail bars to the coarse candle whose span contains them', () => {
    const coarse = [
      candle(0, HOUR, '100', '101', '99', '100'),
      candle(HOUR, HOUR, '100', '102', '98', '101'),
    ];
    // Four 30m detail bars: two under each 1h candle.
    const detail = [
      candle(0, HALF, '100', '100', '99', '100'),
      candle(HALF, HALF, '100', '101', '100', '100'),
      candle(HOUR, HALF, '100', '102', '99', '100'),
      candle(HOUR + HALF, HALF, '100', '101', '98', '101'),
    ];
    const ticks = mergeCandleTicks([
      { symbol: SYMBOL, interval: '1h', candles: coarse, detailCandles: detail },
    ]);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]?.detailCandles?.map((b) => b.openTimeMs)).toEqual([0, HALF]);
    expect(ticks[1]?.detailCandles?.map((b) => b.openTimeMs)).toEqual([HOUR, HOUR + HALF]);
  });

  it('omits detailCandles when the series carries none', () => {
    const coarse = [candle(0, HOUR, '100', '101', '99', '100')];
    const ticks = mergeCandleTicks([{ symbol: SYMBOL, interval: '1h', candles: coarse }]);
    expect(ticks[0]?.detailCandles).toBeUndefined();
  });

  it('drops detail bars that fall outside every coarse span', () => {
    const coarse = [candle(0, HOUR, '100', '101', '99', '100')];
    const detail = [
      candle(0, HALF, '100', '100', '99', '100'), // inside
      candle(2 * HOUR, HALF, '100', '100', '99', '100'), // past the coarse candle — dropped
    ];
    const ticks = mergeCandleTicks([
      { symbol: SYMBOL, interval: '1h', candles: coarse, detailCandles: detail },
    ]);
    expect(ticks[0]?.detailCandles?.map((b) => b.openTimeMs)).toEqual([0]);
  });
});

describe('runBacktest — detail bars decide the fill, not the coarse candle', () => {
  it('does NOT fill when the detail bars never cross the limit, even though the coarse candle would', async () => {
    // Detail bars for candle 1 stay at/above 96 → the 95 LIMIT never crosses,
    // although the coarse candle 1 low is 94.
    const detail = [
      candle(HOUR, HALF, '100', '100', '97', '98'),
      candle(HOUR + HALF, HALF, '98', '98', '96', '96'),
    ];
    const report = await runWithDetail(detail);
    expect(report.summary.tradeCount).toBe(0);
  });

  it('fills when a detail bar crosses the limit', async () => {
    const detail = [
      candle(HOUR, HALF, '100', '100', '97', '98'),
      candle(HOUR + HALF, HALF, '98', '98', '94', '96'), // dips to 94 → crosses 95
    ];
    const report = await runWithDetail(detail);
    expect(report.summary.tradeCount).toBe(1);
    expect(report.trades[0]).toMatchObject({ side: 'BUY', price: '95' });
  });

  it('control: with no detail bars the coarse candle low (94) crosses and fills', async () => {
    const report = await runWithDetail(undefined);
    expect(report.summary.tradeCount).toBe(1);
    expect(report.trades[0]).toMatchObject({ side: 'BUY', price: '95' });
  });
});
