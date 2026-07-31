import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

// Scope: this test proves the RUNNER WIRING only — that `runProfileBacktest`
// threads `params.discoveryMode` into `buildBundle`, which arms the
// `entryHint.enterOnAdd` seam (the same key the live worker's bundle-builder
// writes from the discovery Redis hash) on every tick when discoveryMode is
// true, and omits it otherwise. It mocks the engine to capture the runner's
// `buildBundle` callback and asserts the bundle shape across both modes.
// It does NOT replay strategy behavior: the downstream effect (an armed
// entryHint stamps `state.discoveryEntry`, which makes tick.ts skip the
// technicals force-sell) is golden-tested at the strategy layer in
// `packages/strategy/trailing-trade/__tests__/discovery-single-entry.test.ts`.

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

const { runProfileBacktest } = await import('../../src/backtest/backtest-runner.js');
const { trailingTrade } = await import('@app/strategy-trailing-trade');

const silentLogger = pino({ level: 'silent' });
const HOUR = 3_600_000;

// A flat candle row; 230 of them satisfy the runner's warm-up floor so it
// reaches runBacktest (where our mock captures the bundle callback).
const candleRow = (i: number) => ({
  openTime: new Date(i * HOUR),
  closeTime: new Date(i * HOUR + (HOUR - 1)),
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

// The live default TT config: schema-valid by construction (the runner parses
// it through the real configSchema) and it declares the technicals provider, so
// the bundle path the discoveryMode change rides on is exercised. We do not need
// a bespoke config — the discoveryMode seam is independent of the config fields.
const ttConfig = trailingTrade.defaultConfig;

function makeDeps() {
  return {
    db: {},
    getKlines: vi.fn(),
    getSymbolInfo: vi.fn(async (symbol: string) => ({
      symbol,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      // Minimal exchange filters the strategy reads; permissive so any qty/price passes.
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
  };
}

function paramsWith(discoveryMode: boolean) {
  return {
    symbols: ['BTCUSDT'],
    strategyInterval: '1h' as const,
    detailInterval: '1h' as const,
    fromMs: 0,
    toMs: 250 * HOUR,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
    initialQuoteBalance: '1000',
    discoveryMode,
  };
}

// Capture the buildBundle callback the runner hands to runBacktest, then call it.
async function capturedBundle(discoveryMode: boolean): Promise<Record<string, unknown>> {
  repoMocks.getRange.mockResolvedValue(Array.from({ length: 230 }, (_, i) => candleRow(i)));
  let captured: Record<string, unknown> | undefined;
  runBacktest.mockImplementation(
    async (opts: {
      buildBundle: (a: { symbol: string; window: unknown }) => Record<string, unknown>;
    }) => {
      // A non-empty window so the technicals provider has a last-close asOf.
      const window = Array.from({ length: 5 }, (_, i) => ({
        openTimeMs: i * HOUR,
        closeTimeMs: i * HOUR + (HOUR - 1),
        open: '100',
        high: '100',
        low: '100',
        close: '100',
        volume: '1',
        isClosed: true,
      }));
      captured = opts.buildBundle({ symbol: 'BTCUSDT', window });
      return EMPTY_REPORT;
    },
  );
  await runProfileBacktest(
    makeDeps() as never,
    {
      params: paramsWith(discoveryMode),
      strategyName: 'trailing-trade',
      profileConfig: ttConfig,
    } as never,
  );
  if (!captured) throw new Error('buildBundle was never invoked');
  return captured;
}

describe('runProfileBacktest discoveryMode', () => {
  it('marks every entry discovery-managed (entryHint.enterOnAdd) only when discoveryMode is true', async () => {
    const on = await capturedBundle(true);
    const off = await capturedBundle(false);

    // discoveryMode: true → the bundle carries the live entry-hint seam, armed.
    expect(on['entryHint']).toEqual({ enterOnAdd: true });
    // discoveryMode: false → byte-identical to the current path: no entryHint.
    expect(off).not.toHaveProperty('entryHint');
    // The two runs differ exactly at the seam the strategy reads to suppress
    // the technicals force-sell for discovery entries.
    expect(on['entryHint']).not.toEqual(off['entryHint']);
  });
});
