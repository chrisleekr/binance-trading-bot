import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

type GetRange = typeof import('@app/db').repo.candles.getRange;

// Mock the engine so onProgress is driven without a real replay; the runner's
// wrapper probes shouldCancel first and throws on cancellation. Candle backfill
// and the Postgres reads are mocked away so the test exercises only the
// cancellation seam, not the heavy data path.
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
const { BacktestCancelledError } = await import('../../src/backtest/replay.js');

const silentLogger = pino({ level: 'silent' });

const candleRow = (i: number) => ({
  symbol: 'BTCUSDT',
  interval: '1h',
  openTime: new Date(i * 3_600_000),
  closeTime: new Date(i * 3_600_000 + 3_599_999),
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

// deps/args shaped to satisfy runProfileBacktest; the heavy data path is mocked,
// so only the fields the runner reads before runBacktest need to be present.
function makeCall(shouldCancel: () => boolean, onProgress?: (u: unknown) => void) {
  const deps = {
    db: {},
    getKlines: vi.fn(),
    getSymbolInfo: vi.fn(async (symbol: string) => ({
      symbol,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    })),
    strategies: {
      get: () => ({
        name: 'tt',
        version: '1.0.0',
        configSchema: { parse: (c: unknown) => c },
        capabilities: { bundleProviders: [] as string[] },
      }),
    },
    clock: { nowMs: () => 0 },
    logger: silentLogger,
    buildId: 'abc1234',
  };
  const args = {
    params: {
      symbols: ['BTCUSDT'],
      strategyInterval: '1h',
      decisionInterval: '1h',
      detailInterval: '1h',
      fromMs: 0,
      toMs: 250 * 3_600_000,
      fees: { makerBps: 0, takerBps: 0 },
      slippageBps: 0,
      initialQuoteBalance: '1000',
    },
    strategyName: 'tt',
    effectiveConfig: {},
    shouldCancel,
    ...(onProgress ? { onProgress } : {}),
  };
  // Casts: the test supplies only the fields the cancellation path reads.
  return runProfileBacktest(deps as never, args as never);
}

describe('runProfileBacktest cancellation', () => {
  it('aborts with BacktestCancelledError when shouldCancel returns true', async () => {
    repoMocks.getRange.mockResolvedValue(Array.from({ length: 230 }, (_, i) => candleRow(i)));
    runBacktest.mockImplementation(async (opts: { onProgress?: (n: number) => void }) => {
      // The engine drives onProgress synchronously inside its replay loop; the
      // runner's wrapper throws here, rejecting runBacktest's promise.
      opts.onProgress?.(1);
      return EMPTY_REPORT;
    });

    await expect(makeCall(() => true)).rejects.toBeInstanceOf(BacktestCancelledError);
  });

  it('completes normally when shouldCancel returns false', async () => {
    repoMocks.getRange.mockResolvedValue(Array.from({ length: 230 }, (_, i) => candleRow(i)));
    runBacktest.mockImplementation(async (opts: { onProgress?: (n: number) => void }) => {
      opts.onProgress?.(1);
      return EMPTY_REPORT;
    });

    await expect(makeCall(() => false)).resolves.toBeDefined();
  });

  it('emits backfill, replay and finalize phases via onProgress', async () => {
    // The total is the frames the range should hold, however many candles the store returned.
    repoMocks.getRange.mockResolvedValue(Array.from({ length: 230 }, (_, i) => candleRow(i)));
    runBacktest.mockImplementation(async (opts: { onProgress?: (n: number) => void }) => {
      opts.onProgress?.(1);
      return EMPTY_REPORT;
    });
    const phases: { phase: string; processed?: number; total?: number; symbol?: string }[] = [];
    await makeCall(
      () => false,
      (u) => phases.push(u as (typeof phases)[number]),
    );
    expect(phases.map((p) => p.phase)).toEqual(['backfill', 'replay', 'finalize']);
    expect(phases[0]).toMatchObject({ phase: 'backfill', symbol: 'BTCUSDT' });
    expect(phases[1]).toMatchObject({ phase: 'replay', processed: 1, total: 250 });
  });
});
