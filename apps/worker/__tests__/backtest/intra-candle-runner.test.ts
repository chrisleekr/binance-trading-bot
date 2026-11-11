import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

type GetRange = typeof import('@app/db').repo.candles.getRange;

// Scope: proves the runner hands the engine separate decision and detail clocks, loads each native window from its fixed horizon and a non-native detail series only from the range, and tells the operator when a within-candle strategy decides slower than the minute it exits on. Also proves modelling caveats land in `modelNotes`, never in the gate-failing `dataWarnings`.

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

// Rows for whatever interval and window the runner asks for.
const rowsFor = (symbol: string, interval: string, from: Date, to: Date) => {
  const step = STEP[interval] ?? HOUR;
  const rows = [];
  for (let t = Math.ceil(from.getTime() / step) * step; t + step <= to.getTime() + 1; t += step) {
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

function deps(strategy: unknown, toMs: number) {
  return {
    db: {},
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
    buildId: 'abc1234',
  };
}

interface Captured {
  readonly decisionClock: { readonly intervalMs: number; readonly strategyInterval: string };
  readonly dataSource: {
    stream(req: unknown): AsyncIterable<{ readonly interval: string }>;
  };
  readonly request: { readonly intervals: readonly string[] };
}

async function run(
  strategy: unknown,
  symbols: readonly string[],
  opts: {
    readonly detailInterval?: string;
    readonly decisionInterval?: string;
    readonly candleInterval?: string;
    readonly fromMs?: number;
    readonly toMs?: number;
    readonly spreadBps?: number | null;
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
    deps(strategy, toMs) as never,
    {
      params: {
        symbols,
        strategyInterval: '1h',
        detailInterval: opts.detailInterval ?? '5m',
        decisionInterval: opts.decisionInterval ?? '5m',
        fromMs,
        toMs,
        fees: { makerBps: 0, takerBps: 0 },
        slippageBps: 0,
        spreadBps: opts.spreadBps === undefined ? 0 : opts.spreadBps,
        volumeCapPct: 10,
        initialQuoteBalance: '1000',
        discoveryMode: false,
      },
      strategyName: 'trailing-trade',
      effectiveConfig: {
        ...trailingTrade.defaultConfig,
        candleInterval: opts.candleInterval ?? '1h',
      },
    } as never,
  );
  if (!captured) throw new Error('runBacktest was never invoked');
  return {
    captured,
    notes: result.modelNotes as readonly string[],
    dataWarnings: result.dataWarnings as readonly string[],
  };
}

beforeEach(() => {
  repoMocks.getRange.mockReset();
  repoMocks.getRange.mockImplementation(
    async (_db, symbol, interval, from, to) => rowsFor(symbol, interval, from, to) as never,
  );
});

const loadedFromMs = (interval: string): number | undefined =>
  (repoMocks.getRange.mock.calls.find((call) => call[2] === interval)?.[3] as Date)?.getTime();

describe('runProfileBacktest decision and detail clocks', () => {
  it('decides on the requested clock over the strategy window', async () => {
    const { captured } = await run(trailingTrade, ['BTCUSDT']);
    expect(captured.decisionClock).toEqual({ intervalMs: 5 * MIN, strategyInterval: '1h' });
  });

  it('streams the requested detail interval', async () => {
    const { captured } = await run(trailingTrade, ['BTCUSDT'], {
      detailInterval: '1m',
      decisionInterval: '5m',
    });
    const streamed = new Set<string>();
    for await (const tick of captured.dataSource.stream({})) streamed.add(tick.interval);
    expect([...streamed]).toEqual(['1m']);
  });

  it('loads a detail series the strategy does not read only from the range', async () => {
    await run(trailingTrade, ['BTCUSDT']);
    expect(loadedFromMs('5m')).toBe(FROM);
  });

  it('loads the live minute window from its own horizon', async () => {
    await run(trailingTrade, ['BTCUSDT']);
    expect(loadedFromMs('1m')).toBe(FROM - 999 * MIN);
  });

  it('never reads a candle opening at the end of the range', async () => {
    await run(trailingTrade, ['BTCUSDT']);
    const lastReads = repoMocks.getRange.mock.calls.map((call) => (call[4] as Date).getTime());
    expect(new Set(lastReads)).toEqual(new Set([TO - 1]));
  });

  it('refuses a range with no detail candles rather than reporting an empty run', async () => {
    repoMocks.getRange.mockReset();
    repoMocks.getRange.mockImplementation(async () => [] as never);
    await expect(run(trailingTrade, ['BTCUSDT'])).rejects.toThrow(/no 5m candles inside/);
  });
});

describe('runProfileBacktest within-candle exits', () => {
  it('notes a within-candle strategy deciding slower than a minute', async () => {
    const { notes, dataWarnings } = await run(withinCandle, ['BTCUSDT']);
    expect(notes.filter((w) => w.includes('exits within a candle'))).toHaveLength(1);
    // A coarser clock is not a data gap, and a data warning would fail the live gate's coverage check.
    expect(dataWarnings).toEqual([]);
  });

  it('applies the same note to a basket', async () => {
    const { notes } = await run(withinCandle, ['BTCUSDT', 'ETHUSDT']);
    expect(notes.filter((w) => w.includes('exits within a candle'))).toHaveLength(1);
  });

  it('adds no note when the run decides every minute', async () => {
    const { notes } = await run(withinCandle, ['BTCUSDT'], {
      detailInterval: '1m',
      decisionInterval: '1m',
    });
    expect(notes.some((w) => w.includes('exits within a candle'))).toBe(false);
  });

  it('adds no note for a strategy that does not declare the capability', async () => {
    const { notes } = await run(trailingTrade, ['BTCUSDT']);
    expect(notes.some((w) => w.includes('exits within a candle'))).toBe(false);
  });
});

describe('runProfileBacktest modelling notes', () => {
  it('warns when only the strategy series has a gap', async () => {
    repoMocks.getRange.mockImplementation(async (_db, symbol, interval, from, to) =>
      interval === '1h' ? ([] as never) : (rowsFor(symbol, interval, from, to) as never),
    );
    const { dataWarnings } = await run(trailingTrade, ['BTCUSDT']);
    expect(dataWarnings.some((w) => w.includes('BTCUSDT') && w.includes('0%'))).toBe(true);
  });

  it('keeps an unset spread in dataWarnings so the live gate refuses a run whose fills are free', async () => {
    const { notes, dataWarnings } = await run(trailingTrade, ['BTCUSDT'], { spreadBps: null });
    expect(dataWarnings.some((w) => w.startsWith('no spread haircut modeled'))).toBe(true);
    expect(notes.some((n) => n.startsWith('no spread haircut modeled'))).toBe(false);
  });
});
