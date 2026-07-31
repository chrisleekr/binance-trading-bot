import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

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
  getRange: vi.fn(async () => []),
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

const { runProfileBacktest, BacktestCancelledError } =
  await import('../../src/backtest/backtest-runner.js');

const silentLogger = pino({ level: 'silent' });

const candleRow = (i: number) => ({
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

interface CallOpts {
  nowMs?: () => number;
  candleCache?: { get: (k: string) => unknown; set: (k: string, v: unknown) => void };
}

// deps/args shaped to satisfy runProfileBacktest; the heavy data path is mocked,
// so only the fields the runner reads before runBacktest need to be present.
function makeCall(shouldCancel: () => boolean, onProgress?: (u: unknown) => void, opts?: CallOpts) {
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
        configSchema: { parse: (c: unknown) => c },
        capabilities: { bundleProviders: [] as string[] },
      }),
    },
    clock: { nowMs: opts?.nowMs ?? (() => 0) },
    logger: silentLogger,
    ...(opts?.candleCache ? { candleCache: opts.candleCache } : {}),
  };
  const args = {
    params: {
      symbols: ['BTCUSDT'],
      strategyInterval: '1h',
      detailInterval: '1h',
      fromMs: 0,
      toMs: 250 * 3_600_000,
      fees: { makerBps: 0, takerBps: 0 },
      slippageBps: 0,
      initialQuoteBalance: '1000',
    },
    strategyName: 'tt',
    profileConfig: {},
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

  it('emits backfill → warmup → replay → finalize phases via onProgress', async () => {
    // 230 candles − 200 warm-up = 30 tradeable ticks; the mocked engine fires one
    // replay tick so the runner reports a replay frame with processed/total.
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
    expect(phases.map((p) => p.phase)).toEqual(['backfill', 'warmup', 'replay', 'finalize']);
    expect(phases[0]).toMatchObject({ phase: 'backfill', symbol: 'BTCUSDT' });
    expect(phases[2]).toMatchObject({ phase: 'replay', processed: 1, total: 30 });
    // No count is carried on warm-up (the "candle X of Y" view is replay-only).
    expect(phases[1]).toEqual({ pct: 0, phase: 'warmup' });
  });
});

describe('runProfileBacktest candle-cache hygiene', () => {
  // now far past the 250h window so the last closed bar sits at the window end.
  const FAR_NOW = () => 1000 * 3_600_000;

  it('does not pin a window that stops short of the last closed bar, but still replays it', async () => {
    // 230 candles (newest opens 229h) over a window ending at 249h: a truncated
    // tail. The window must still feed the replay (runBacktest runs), but the
    // sparse fetch must not be pinned for later trials.
    repoMocks.getRange.mockResolvedValue(Array.from({ length: 230 }, (_, i) => candleRow(i)));
    runBacktest.mockResolvedValue(EMPTY_REPORT);
    const candleCache = { get: vi.fn(() => undefined), set: vi.fn() };

    await expect(
      makeCall(() => false, undefined, { nowMs: FAR_NOW, candleCache }),
    ).resolves.toBeDefined();

    expect(candleCache.set).not.toHaveBeenCalled();
    expect(runBacktest).toHaveBeenCalled();
  });

  it('pins a window that reaches the last closed bar', async () => {
    // 250 candles (newest opens 249h) reaches the last closed bar at 249h.
    repoMocks.getRange.mockResolvedValue(Array.from({ length: 250 }, (_, i) => candleRow(i)));
    runBacktest.mockResolvedValue(EMPTY_REPORT);
    const candleCache = { get: vi.fn(() => undefined), set: vi.fn() };

    await expect(
      makeCall(() => false, undefined, { nowMs: FAR_NOW, candleCache }),
    ).resolves.toBeDefined();

    expect(candleCache.set).toHaveBeenCalled();
  });
});
