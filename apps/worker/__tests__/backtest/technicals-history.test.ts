import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Candle, CandleInterval } from '@app/strategy-core';
import type { MarketDataSource } from '@app/strategy-backtest';

import {
  prepareTechnicalsRatingWindow,
  TECHNICALS_SOURCE_CANDLE_LIMIT,
} from '../../src/technicals/rating-window.js';

const runBacktest = vi.hoisted(() => vi.fn());
vi.mock('@app/strategy-backtest', async (importOriginal) => {
  const original = await importOriginal<typeof import('@app/strategy-backtest')>();
  return { ...original, runBacktest };
});

const backfillCandles = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/backtest/candle-backfill.js', () => ({ backfillCandles }));

const repoMocks = vi.hoisted(() => ({
  findGaps: vi.fn(async () => []),
  insertNew: vi.fn(async () => undefined),
  getRange: vi.fn(),
}));
vi.mock('@app/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@app/db')>();
  return {
    ...original,
    repo: {
      ...original.repo,
      candles: {
        ...original.repo.candles,
        findGaps: repoMocks.findGaps,
        insertNew: repoMocks.insertNew,
        getRange: repoMocks.getRange,
      },
    },
  };
});

const observedRatingWindow = vi.hoisted(() => vi.fn());
vi.mock('@app/indicators/rating', async (importOriginal) => {
  const original = await importOriginal<typeof import('@app/indicators/rating')>();
  return {
    ...original,
    computeTechnicalsRating: (window: Candle[]) => {
      observedRatingWindow(window);
      return original.computeTechnicalsRating(window);
    },
  };
});

const { runProfileBacktest } = await import('../../src/backtest/backtest-runner.js');
const { trailingTrade } = await import('@app/strategy-trailing-trade');

const MINUTE = 60_000;
const FIVE_MINUTES = 5 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM_MS = 1_000 * DAY;
const TO_MS = FROM_MS + 10 * FIVE_MINUTES;
const FIVE_MINUTE_TECHNICALS_FROM_MS = FROM_MS - TECHNICALS_SOURCE_CANDLE_LIMIT * FIVE_MINUTES;

const intervalMs = (interval: string): number => {
  if (interval === '1m') return MINUTE;
  if (interval === '5m') return FIVE_MINUTES;
  if (interval === '1h') return HOUR;
  if (interval === '1d') return DAY;
  throw new Error(`unexpected interval: ${interval}`);
};

let sparseFiveMinuteRows = false;

const candleRows = (interval: string, fromMs: number, toMs: number) => {
  const stepMs = intervalMs(interval);
  const rows = [];
  for (let openTimeMs = fromMs, index = 0; openTimeMs <= toMs; openTimeMs += stepMs, index++) {
    const close = (100 + (index % 40)).toString();
    rows.push({
      openTime: new Date(openTimeMs),
      closeTime: new Date(openTimeMs + stepMs - 1),
      open: close,
      high: close,
      low: close,
      close,
      volume: sparseFiveMinuteRows && interval === '5m' && index % 3 !== 0 ? '0' : '1',
    });
  }
  return rows;
};

const toCandle = (row: ReturnType<typeof candleRows>[number]): Candle => ({
  openTimeMs: row.openTime.getTime(),
  closeTimeMs: row.closeTime.getTime(),
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.close,
  volume: row.volume,
  isClosed: true,
});

const EMPTY_REPORT = {
  metrics: {},
  equityCurve: [],
  drawdownSeries: [],
  trades: [],
  roundTrips: [],
  perSymbol: [],
  decisionBreakdown: { metrics: [], logs: [] },
  regimeBreakdown: [],
};

const silentLogger = pino({ level: 'silent' });

const makeDeps = () => ({
  db: {},
  getKlines: vi.fn(),
  getSymbolInfo: vi.fn(async (symbol: string) => ({
    symbol,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    stepSize: '0.00000001',
    tickSize: '0.00000001',
    minNotional: '0',
    minQty: '0',
    maxQty: '1000000',
    minPrice: '0',
    maxPrice: '1000000',
  })),
  strategies: { get: () => trailingTrade },
  clock: { nowMs: () => TO_MS + DAY },
  logger: silentLogger,
  buildId: 'abc1234',
});

const profileConfig = (technicalsInterval: '5m' | '1h') => {
  const base = trailingTrade.defaultConfig;
  const row = base.technicals.intervals[0];
  if (!row) throw new Error('default Technicals interval is missing');
  return {
    ...base,
    candleInterval: '5m',
    technicals: {
      ...base.technicals,
      intervals: [{ ...row, interval: technicalsInterval }],
    },
  };
};

const progress: { phase: string; total?: number }[] = [];

const run = async (technicalsInterval: '5m' | '1h') =>
  runProfileBacktest(
    makeDeps() as never,
    {
      params: {
        symbols: ['BTCUSDT'],
        strategyInterval: '5m',
        decisionInterval: '5m',
        detailInterval: '5m',
        fromMs: FROM_MS,
        toMs: TO_MS,
        fees: { makerBps: 0, takerBps: 0 },
        slippageBps: 0,
        initialQuoteBalance: '1000',
        discoveryMode: false,
      },
      strategyName: 'trailing-trade',
      effectiveConfig: profileConfig(technicalsInterval),
      onProgress: (update: { phase: string; total?: number }) => progress.push(update),
    } as never,
  );

interface RunnerOptions {
  readonly request: Parameters<MarketDataSource['stream']>[0];
  readonly buildBundle: (args: { symbol: string; asOfMs: number }) => Record<string, unknown>;
  readonly auxiliaryWindows: (args: {
    symbol: string;
    asOfMs: number;
  }) => Partial<Record<string, readonly Candle[]>>;
  readonly onProgress: (processed: number) => void;
}

const requestedFromMs = (interval: CandleInterval): number | undefined => {
  const call = repoMocks.getRange.mock.calls.find((args) => args[2] === interval);
  return (call?.[3] as Date | undefined)?.getTime();
};

beforeEach(() => {
  vi.clearAllMocks();
  progress.length = 0;
  sparseFiveMinuteRows = false;
  repoMocks.getRange.mockImplementation(
    async (_db: unknown, _symbol: string, interval: string, from: Date, to: Date) =>
      candleRows(interval, from.getTime(), to.getTime()),
  );
});

describe('runProfileBacktest Technicals history', () => {
  it('loads the 999-bar horizon for the native strategy window', async () => {
    runBacktest.mockResolvedValue(EMPTY_REPORT);

    await run('5m');

    expect(requestedFromMs('5m')).toBe(FIVE_MINUTE_TECHNICALS_FROM_MS);
  });

  it('loads a coarser Technicals interval from its own 999-interval horizon', async () => {
    runBacktest.mockResolvedValue(EMPTY_REPORT);

    await run('1h');

    expect(requestedFromMs('5m')).toBe(FIVE_MINUTE_TECHNICALS_FROM_MS);
    expect(requestedFromMs('1h')).toBe(FROM_MS - TECHNICALS_SOURCE_CANDLE_LIMIT * HOUR);
  });

  it('long Technicals history leaves replay bounds, regime windows and progress total unchanged', async () => {
    const observe = async (technicalsInterval: '5m' | '1h') => {
      progress.length = 0;
      let seen: unknown;
      runBacktest.mockImplementation(async (options: RunnerOptions) => {
        options.onProgress(1);
        const asOfMs = FROM_MS + FIVE_MINUTES - 1;
        const daily = options.auxiliaryWindows({ symbol: 'BTCUSDT', asOfMs })['1d'];
        seen = {
          bounds: [options.request.fromMs, options.request.toMs],
          lastDailyClose: daily?.at(-1)?.closeTimeMs,
        };
        return EMPTY_REPORT;
      });
      await run(technicalsInterval);
      return { seen, total: progress.find((p) => p.phase === 'replay')?.total };
    };

    const short = await observe('5m');
    const long = await observe('1h');

    expect(short).toEqual({
      seen: { bounds: [FROM_MS, TO_MS], lastDailyClose: FROM_MS - 1 },
      total: 10,
    });
    expect(long).toEqual(short);
  });

  it('normalizes sparse raw history to 250 traded bars on the first decision', async () => {
    sparseFiveMinuteRows = true;
    let signal: unknown;
    runBacktest.mockImplementation(async (options: RunnerOptions) => {
      const bundle = options.buildBundle({
        symbol: 'BTCUSDT',
        asOfMs: FROM_MS + FIVE_MINUTES - 1,
      });
      signal = (bundle['technicals'] as { signals: { signal: unknown }[] }).signals[0]?.signal;
      return EMPTY_REPORT;
    });

    await run('5m');

    const observed = observedRatingWindow.mock.calls[0]?.[0] as Candle[] | undefined;
    const expected = prepareTechnicalsRatingWindow(
      candleRows('5m', FIVE_MINUTE_TECHNICALS_FROM_MS, FROM_MS).map(toCandle),
    );
    expect(observed).toEqual(expected);
    expect(observed).toHaveLength(250);
    expect(observed?.every((candle) => candle.volume !== '0')).toBe(true);
    // Positive shape, not `not.toBeNull()`: an empty signals array yields
    // `undefined`, which passes a null check and would hide the window never
    // having been rated at all.
    expect(signal).toMatchObject({ recommendation: expect.any(String) });
  });
});
