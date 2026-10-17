import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

type GetRange = typeof import('@app/db').repo.candles.getRange;

// Scope: proves the runner turns on within-candle ticking for a strategy that declares `exitsWithinCandle`, loads its 1-minute bars from one trading candle before the range rather than across the warm-up, and falls back to one tick per candle with a warning for a basket the engine cannot interleave.

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
const { trailingTrade } = await import('@app/strategy-trailing-trade');

const HOUR = 3_600_000;
const FROM = 300 * HOUR;
const TO = 400 * HOUR;

const DAY = 24 * HOUR;
const MIN = 60_000;
const STEP: Record<string, number> = { '1m': MIN, '5m': 5 * MIN, '1h': HOUR, '1d': DAY };

// Rows for whatever interval and window the runner asks for, so every window reaches its last closed bar and is eligible for the candle cache.
const rowsFor = (symbol: string, interval: string, from: Date, to: Date) => {
  const step = STEP[interval] ?? HOUR;
  const rows = [];
  for (let t = Math.ceil(from.getTime() / step) * step; t + step <= to.getTime(); t += step) {
    rows.push({
      symbol,
      interval,
      openTime: new Date(t),
      closeTime: new Date(t + step - 1),
      open: '100',
      high: '100',
      low: '100',
      close: '100',
      volume: '1',
    });
  }
  return rows;
};

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

// Any registered plugin works as the carrier; only the declared capability and the config's candle interval matter to the runner.
const withinCandle = {
  ...trailingTrade,
  capabilities: { ...trailingTrade.capabilities, exitsWithinCandle: true },
};

function deps(strategy: unknown, toMs: number, candleCache?: unknown) {
  return {
    db: {},
    ...(candleCache ? { candleCache } : {}),
    getKlines: vi.fn(),
    getSymbolInfo: vi.fn(async (symbol: string) => ({
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      stepSize: '0.00000001',
      tickSize: '0.00000001',
      minNotional: '0',
      minQty: '0',
      maxQty: '1000000',
      minPrice: '0',
      maxPrice: '1000000',
    })),
    strategies: { get: () => strategy },
    clock: { nowMs: () => toMs },
    logger: pino({ level: 'silent' }),
  };
}

interface Captured {
  readonly intraCandle?: { readonly interval: string };
  readonly onIntraCandleTick?: unknown;
  readonly request: { readonly intervals: readonly string[] };
}

async function run(
  strategy: unknown,
  symbols: readonly string[],
  opts: {
    readonly detailInterval?: string;
    readonly candleInterval?: string;
    readonly fromMs?: number;
    readonly toMs?: number;
    readonly candleCache?: unknown;
  } = {},
) {
  const fromMs = opts.fromMs ?? FROM;
  const toMs = opts.toMs ?? TO;
  let captured: Captured | undefined;
  runBacktest.mockImplementation(async (opts: Captured) => {
    captured = opts;
    return EMPTY_REPORT;
  });
  const { result } = await runProfileBacktest(
    deps(strategy, toMs, opts.candleCache) as never,
    {
      params: {
        symbols,
        strategyInterval: '1h',
        detailInterval: opts.detailInterval ?? '5m',
        fromMs,
        toMs,
        fees: { makerBps: 0, takerBps: 0 },
        slippageBps: 0,
        spreadBps: 0,
        volumeCapPct: 10,
        initialQuoteBalance: '1000',
        discoveryMode: false,
      },
      strategyName: 'trailing-trade',
      profileConfig: {
        ...trailingTrade.defaultConfig,
        candleInterval: opts.candleInterval ?? '1h',
      },
    } as never,
  );
  if (!captured) throw new Error('runBacktest was never invoked');
  return { captured, warnings: result.dataWarnings as readonly string[] };
}

describe('runProfileBacktest within-candle exits', () => {
  beforeEach(() => {
    repoMocks.getRange.mockReset();
    repoMocks.getRange.mockImplementation(
      async (_db, symbol, interval, from, to) => rowsFor(symbol, interval, from, to) as never,
    );
  });

  it('ticks a single-symbol run on 1-minute bars and says the detail interval changed', async () => {
    const { captured, warnings } = await run(withinCandle, ['BTCUSDT']);
    expect(captured.intraCandle).toEqual({ interval: '1m' });
    // A yield hook is wired for the minute ticks; the shared budget itself is pinned by the cooperative-data-source tests.
    expect(typeof captured.onIntraCandleTick).toBe('function');
    expect(captured.request.intervals).toContain('1m');
    expect(captured.request.intervals).not.toContain('5m');
    expect(warnings.some((w) => w.startsWith('detail interval set to 1m instead of 5m'))).toBe(
      true,
    );
  });

  it('loads the minute bars of an hourly strategy from one candle before the range, not across the warm-up', async () => {
    await run(withinCandle, ['BTCUSDT']);
    const minuteLoads = repoMocks.getRange.mock.calls.filter((call) => call[2] === '1m');
    expect(minuteLoads).toHaveLength(1);
    expect((minuteLoads[0]?.[3] as Date).getTime()).toBe(FROM - HOUR);
    // The trading interval still loads at least its full warm-up (further when a technicals interval shares it), so the change is confined to the minute bars.
    const hourLoads = repoMocks.getRange.mock.calls.filter((call) => call[2] === '1h');
    expect((hourLoads[0]?.[3] as Date).getTime()).toBeLessThanOrEqual(FROM - 200 * HOUR);
  });

  it('starts the minute bars of a daily strategy where its trading starts, about 20 days before the range', async () => {
    // A daily series loads the 220-day regime warm-up and trades from candle 201, so trading begins 20 days before fromMs; the bars start one candle earlier still.
    const fromMs = 300 * DAY;
    await run(withinCandle, ['BTCUSDT'], { candleInterval: '1d', fromMs, toMs: fromMs + 30 * DAY });
    const minuteLoads = repoMocks.getRange.mock.calls.filter((call) => call[2] === '1m');
    expect((minuteLoads[0]?.[3] as Date).getTime()).toBe(fromMs - 21 * DAY);
  });

  it('falls back to one tick per candle with a warning when the minute bars would exceed the cap', async () => {
    const fromMs = 300 * DAY;
    const { captured, warnings } = await run(withinCandle, ['BTCUSDT'], {
      fromMs,
      toMs: fromMs + 401 * DAY,
    });
    expect(captured.intraCandle).toBeUndefined();
    expect(repoMocks.getRange.mock.calls.some((call) => call[2] === '1m')).toBe(false);
    expect(warnings.some((w) => w.includes('more than 400 days of 1-minute bars'))).toBe(true);
  });

  it('keeps the minute window out of the shared candle cache', async () => {
    const set = vi.fn();
    await run(withinCandle, ['BTCUSDT'], { candleCache: { get: () => undefined, set } });
    const keys = set.mock.calls.map((call) => String(call[0]));
    // The trading window is cached as before; only the minute bars are left out.
    expect(keys.some((k) => k.includes('|1h|'))).toBe(true);
    expect(keys.some((k) => k.includes('|1m|'))).toBe(false);
  });

  it('does not warn a basket whose strategy already trades on 1-minute candles', async () => {
    const { warnings } = await run(withinCandle, ['BTCUSDT', 'ETHUSDT'], { candleInterval: '1m' });
    expect(warnings.some((w) => w.includes('exits within a candle'))).toBe(false);
  });

  it('falls back to one tick per candle with a warning for a basket', async () => {
    const { captured, warnings } = await run(withinCandle, ['BTCUSDT', 'ETHUSDT']);
    expect(captured.intraCandle).toBeUndefined();
    expect(captured.request.intervals).toContain('5m');
    expect(warnings.some((w) => w.includes('a multi-symbol run ticks once per 1h candle'))).toBe(
      true,
    );
  });

  it('leaves a strategy that does not declare the capability on its requested detail interval', async () => {
    const { captured, warnings } = await run(trailingTrade, ['BTCUSDT']);
    expect(captured.intraCandle).toBeUndefined();
    expect(captured.request.intervals).toContain('5m');
    expect(captured.request.intervals).not.toContain('1m');
    expect(warnings.some((w) => w.includes('exits within a candle'))).toBe(false);
  });
});
