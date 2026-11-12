import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

type GetRange = typeof import('@app/db').repo.candles.getRange;

// Scope: proves the strategy's window comes from its own `config.candleInterval`, the field the live worker keys its feed off, and not `params.strategyInterval`. A disagreement between the two would hand the strategy an empty window with no error.

const runBacktest = vi.hoisted(() => vi.fn());
vi.mock('@app/strategy-backtest', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/strategy-backtest')>();
  return { ...orig, runBacktest };
});

vi.mock('../../src/backtest/candle-backfill.js', () => ({
  backfillCandles: vi.fn(async () => undefined),
}));

const repoMocks = vi.hoisted(() => ({
  findGaps: vi.fn(async () => []),
  insertNew: vi.fn(async () => undefined),
  getRange: vi.fn<GetRange>(async () => []),
}));
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    repo: {
      ...orig.repo,
      candles: {
        ...orig.repo.candles,
        findGaps: repoMocks.findGaps,
        insertNew: repoMocks.insertNew,
        getRange: repoMocks.getRange,
      },
    },
  };
});

const { runProfileBacktest } = await import('../../src/backtest/backtest-runner.js');
const { readConfigInterval } = await import('../../src/backtest/replay.js');
const { trailingTrade } = await import('@app/strategy-trailing-trade');

const silentLogger = pino({ level: 'silent' });
const FIVE_MIN = 300_000;

const candleRow = (i: number) => ({
  symbol: 'BTCUSDT',
  interval: '5m',
  openTime: new Date(i * FIVE_MIN),
  closeTime: new Date(i * FIVE_MIN + (FIVE_MIN - 1)),
  open: '100',
  high: '100',
  low: '100',
  close: '100',
  volume: '1',
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

function makeDeps() {
  return {
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
    clock: { nowMs: () => 0 },
    logger: silentLogger,
    buildId: 'abc1234',
  };
}

// The interval the engine is told to read each decision's strategy window from.
async function capturedStrategyWindow(args: {
  configCandleInterval: string;
  paramStrategyInterval: string;
}): Promise<string> {
  repoMocks.getRange.mockResolvedValue(Array.from({ length: 230 }, (_, i) => candleRow(i)));
  let strategyInterval: string | undefined;
  runBacktest.mockImplementation(async (opts: { decisionClock: { strategyInterval: string } }) => {
    strategyInterval = opts.decisionClock.strategyInterval;
    return EMPTY_REPORT;
  });
  await runProfileBacktest(
    makeDeps() as never,
    {
      params: {
        symbols: ['BTCUSDT'],
        strategyInterval: args.paramStrategyInterval,
        decisionInterval: '5m',
        detailInterval: '5m',
        fromMs: 0,
        toMs: 250 * FIVE_MIN,
        fees: { makerBps: 0, takerBps: 0 },
        slippageBps: 0,
        initialQuoteBalance: '1000',
        discoveryMode: false,
      },
      strategyName: 'trailing-trade',
      effectiveConfig: {
        ...trailingTrade.defaultConfig,
        candleInterval: args.configCandleInterval,
      },
    } as never,
  );
  if (!strategyInterval) throw new Error('runBacktest was never invoked');
  return strategyInterval;
}

describe('runProfileBacktest strategy window', () => {
  it('reads the config candleInterval even when params.strategyInterval disagrees', async () => {
    const streamed = await capturedStrategyWindow({
      configCandleInterval: '5m',
      paramStrategyInterval: '1h', // disagrees with the config on purpose
    });
    // The strategy reads candlesByInterval['5m'], so that is the window the engine must serve.
    expect(streamed).toBe('5m');
  });

  it('reads the config candleInterval when the two agree', async () => {
    const streamed = await capturedStrategyWindow({
      configCandleInterval: '1h',
      paramStrategyInterval: '1h',
    });
    expect(streamed).toBe('1h');
  });
});

describe('readConfigInterval', () => {
  it('returns the config candleInterval when present and backtest-supported', () => {
    expect(readConfigInterval({ candleInterval: '5m' })).toBe('5m');
  });

  it('returns null when the strategy declares no candleInterval (caller falls back to the param)', () => {
    // No real strategy lacks candleInterval today, so the engine's
    // `?? params.strategyInterval` fallback is proven here at the unit boundary.
    expect(readConfigInterval({})).toBeNull();
    expect(readConfigInterval({ candleInterval: 5 })).toBeNull();
    expect(readConfigInterval(null)).toBeNull();
  });

  it('rejects a candle interval the backtest cannot replay (e.g. calendar 1M)', () => {
    expect(() => readConfigInterval({ candleInterval: '1M' })).toThrow(/does not support/);
  });
});
