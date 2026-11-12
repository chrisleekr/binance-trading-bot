import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { BACKTEST_ENGINE_REVISION, type CandleInterval } from '@app/strategy-core';
import { intervalToMs } from '@app/db';

type GetRange = typeof import('@app/db').repo.candles.getRange;

// Real engine and real plugins; only the candle store and the exchange backfill are faked.

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

const ratingSpy = vi.hoisted(() => vi.fn());
vi.mock('@app/indicators/rating', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/indicators/rating')>();
  ratingSpy.mockImplementation(orig.computeTechnicalsRating);
  return { ...orig, computeTechnicalsRating: ratingSpy };
});

const { runProfileBacktest } = await import('../../src/backtest/backtest-runner.js');
const { trailingTrade } = await import('@app/strategy-trailing-trade');
const { buildStrategyRegistry } = await import('@app/strategy-registry');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Far enough from epoch that every native lookback the runner requests stays non-negative.
const FROM = 2_000 * DAY;
const BUILD = 'abc1234';
const HEX_64 = /^[0-9a-f]{64}$/;

interface CandleRow {
  readonly symbol: string;
  readonly interval: string;
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

// A deterministic wobble, since the Technicals rating needs prices that move.
const priceAt = (t: number): number => 100 + ((t / MIN) % 17) * 0.1;

function rowsFor(symbol: string, interval: string, from: Date, to: Date): CandleRow[] {
  const step = intervalToMs(interval);
  const rows: CandleRow[] = [];
  for (let t = Math.ceil(from.getTime() / step) * step; t + step <= to.getTime() + 1; t += step) {
    const price = priceAt(t);
    rows.push({
      symbol,
      interval,
      openTime: new Date(t),
      closeTime: new Date(t + step - 1),
      open: price.toFixed(2),
      high: (price + 0.5).toFixed(2),
      low: (price - 0.5).toFixed(2),
      close: price.toFixed(2),
      volume: '1000',
    });
  }
  return rows;
}

const symbolInfo = (symbol: string, tickSize = '0.01') => ({
  symbol,
  baseAsset: symbol.replace('USDT', ''),
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '0',
    tickSize,
    stepSize: '0.00000001',
    minQty: '0',
    maxQty: '1000000',
    minPrice: '0',
    maxPrice: '1000000',
  },
});

interface Plugin {
  readonly name: string;
  readonly version: string;
  readonly defaultConfig: unknown;
  readonly tick: (input: never) => unknown;
}

interface ProbeTick {
  readonly atMs: number;
  readonly kind: string;
  readonly lastClose: Readonly<Record<string, number>>;
}

interface TickView {
  readonly clock: { nowMs(): number };
  readonly trigger: { readonly kind: string };
  readonly state: unknown;
  readonly market: {
    readonly candlesByInterval: Partial<
      Record<string, readonly { readonly closeTimeMs: number }[]>
    >;
  };
}

function recordTick(seen: ProbeTick[], input: TickView): void {
  const lastClose: Record<string, number> = {};
  for (const [interval, window] of Object.entries(input.market.candlesByInterval)) {
    const last = window?.at(-1);
    if (last) lastClose[interval] = last.closeTimeMs;
  }
  seen.push({ atMs: input.clock.nowMs(), kind: input.trigger.kind, lastClose });
}

// Keeps the plugin's capabilities and schema, and replaces its decisions with none.
const silentProbe = (plugin: Plugin, seen: ProbeTick[]) => ({
  ...plugin,
  tick: (input: TickView) => {
    recordTick(seen, input);
    return { nextState: input.state, decisions: [], logs: [], metrics: [] };
  },
});

// Keeps the plugin's own decisions, so a real plugin replays through the scheduled trigger.
const realProbe = (plugin: Plugin, seen: ProbeTick[]) => ({
  ...plugin,
  tick: (input: TickView) => {
    recordTick(seen, input);
    return plugin.tick(input as never);
  },
});

interface ReplayOptions {
  readonly strategy?: unknown;
  readonly config?: Record<string, unknown>;
  readonly candleInterval?: string;
  readonly symbols?: readonly string[];
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly decisionInterval?: string;
  readonly detailInterval?: string;
  readonly shouldCancel?: () => boolean;
  readonly deps?: Record<string, unknown>;
  readonly tickSize?: string;
  readonly onProgress?: (update: Progress) => void;
}

interface Progress {
  readonly phase: string;
  readonly total?: number;
}

interface Simulation {
  readonly engineRevision: number;
  readonly buildId: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly decisionInterval: string;
  readonly dataFingerprint: string;
  readonly contextFingerprint: string;
}

interface Replayed {
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly progress: readonly Progress[];
  readonly equity: readonly { readonly tsMs: number }[];
  readonly simulation: Simulation | undefined;
}

async function replay(options: ReplayOptions = {}): Promise<Replayed> {
  const fromMs = options.fromMs ?? FROM;
  const toMs = options.toMs ?? fromMs + DAY;
  const progress: Progress[] = [];
  const plugin = options.strategy ?? silentProbe(trailingTrade as unknown as Plugin, []);
  const config = options.config ?? {
    ...(trailingTrade.defaultConfig as unknown as Record<string, unknown>),
    candleInterval: options.candleInterval ?? '1h',
  };
  const { result } = await runProfileBacktest(
    {
      db: {},
      getKlines: vi.fn(),
      getSymbolInfo: vi.fn(async (symbol: string) => symbolInfo(symbol, options.tickSize)),
      strategies: { get: () => plugin },
      clock: { nowMs: () => toMs + DAY },
      logger: pino({ level: 'silent' }),
      buildId: BUILD,
      ...options.deps,
    } as never,
    {
      params: {
        symbols: options.symbols ?? ['BTCUSDT'],
        strategyInterval: (options.candleInterval ?? '1h') as CandleInterval,
        detailInterval: options.detailInterval ?? '1m',
        decisionInterval: options.decisionInterval ?? '5m',
        fromMs,
        toMs,
        fees: { makerBps: 0, takerBps: 0 },
        slippageBps: 0,
        spreadBps: 0,
        volumeCapPct: 10,
        initialQuoteBalance: '1000',
        discoveryMode: false,
      },
      strategyName: (plugin as Plugin).name,
      // Named twice because the runner stops merging profile config and reads only the frozen one.
      profileConfig: config,
      effectiveConfig: config,
      buildId: BUILD,
      onProgress: (update: Progress) => {
        progress.push(update);
        options.onProgress?.(update);
      },
      ...(options.shouldCancel ? { shouldCancel: options.shouldCancel } : {}),
    } as never,
  );
  const full = result as unknown as {
    readonly modelNotes: readonly string[];
    readonly dataWarnings: readonly string[];
    readonly equityCurve: readonly { readonly tsMs: number }[];
    readonly simulation?: Simulation;
  };
  return {
    notes: full.modelNotes,
    warnings: full.dataWarnings,
    progress,
    equity: full.equityCurve,
    simulation: full.simulation,
  };
}

// The newest close of an `interval` window at the instant `atMs`.
const closedAt = (interval: string, atMs: number): number => {
  const step = intervalToMs(interval);
  return Math.floor((atMs + 1) / step) * step - 1;
};

const boundaries = (fromMs: number, stepMs: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => fromMs + (i + 1) * stepMs - 1);

// Serves generated rows through `edit`, the seam a test uses to remove or repair stored candles.
function serveCandles(edit: (rows: CandleRow[], interval: string) => CandleRow[] = (r) => r): void {
  repoMocks.getRange.mockReset();
  repoMocks.getRange.mockImplementation(
    async (_db, symbol, interval, from, to) =>
      edit(rowsFor(symbol, interval, from, to), interval) as never,
  );
}

beforeEach(() => {
  serveCandles();
  ratingSpy.mockClear();
});

// A daily series loads months of history, which outlasts the unit-test default.
const SLOW_MS = 60_000;

describe('daily run receives closed 1d, 1m and Technicals windows with nothing closing after the decision', () => {
  const registry = buildStrategyRegistry();
  const momentum = registry.get('momentum') as unknown as Plugin;
  const momentumConfig = {
    ...(momentum.defaultConfig as Record<string, unknown>),
    candleInterval: '1d',
  };
  const decisionAtOneHour = FROM + HOUR - 1;

  async function dailyMomentum(): Promise<ProbeTick[]> {
    const seen: ProbeTick[] = [];
    await replay({
      strategy: silentProbe(momentum, seen),
      config: momentumConfig,
      candleInterval: '1d',
      decisionInterval: '1h',
    });
    return seen;
  }

  it(
    'decides on the hourly clock of a daily strategy',
    async () => {
      const seen = await dailyMomentum();
      expect(seen.map((t) => t.atMs)).toEqual(boundaries(FROM, HOUR, 24));
    },
    SLOW_MS,
  );

  it(
    'hands the first decision the last closed daily candle',
    async () => {
      const seen = await dailyMomentum();
      const first = seen.find((t) => t.atMs === decisionAtOneHour);
      expect(first?.lastClose['1d']).toBe(FROM - 1);
    },
    SLOW_MS,
  );

  it(
    'hands the first decision a minute window ending at the decision',
    async () => {
      const seen = await dailyMomentum();
      const first = seen.find((t) => t.atMs === decisionAtOneHour);
      expect(first?.lastClose['1m']).toBe(decisionAtOneHour);
    },
    SLOW_MS,
  );

  it(
    'hands every configured Technicals interval a closed native window',
    async () => {
      const seen: ProbeTick[] = [];
      const plugin = silentProbe(trailingTrade as unknown as Plugin, seen);
      await replay({ strategy: plugin, candleInterval: '1d', decisionInterval: '1h' });
      const tvIntervals = (
        trailingTrade.defaultConfig as unknown as {
          technicals: { intervals: readonly { interval: string }[] };
        }
      ).technicals.intervals.map((row) => row.interval);
      const first = seen.find((t) => t.atMs === decisionAtOneHour);
      expect(tvIntervals.length).toBeGreaterThan(0);
      const expected = Object.fromEntries(
        tvIntervals.map((i) => [i, closedAt(i, decisionAtOneHour)]),
      );
      expect(first?.lastClose).toMatchObject(expected);
    },
    SLOW_MS,
  );

  it(
    'never hands a decision a candle closing after it',
    async () => {
      const seen = await dailyMomentum();
      expect(seen).toHaveLength(24);
      const lookahead = seen.flatMap((t) =>
        Object.entries(t.lastClose)
          .filter(([, close]) => close > t.atMs)
          .map(([interval]) => `${interval}@${String(t.atMs)}`),
      );
      expect(lookahead).toEqual([]);
    },
    SLOW_MS,
  );
});

describe('cancellation honoured between decisions', () => {
  it('stops on a frame with no decision due', async () => {
    const seen: ProbeTick[] = [];
    const progress: Progress[] = [];
    let polls = 0;
    const run = replay({
      onProgress: (update) => progress.push(update),
      strategy: silentProbe(trailingTrade as unknown as Plugin, seen),
      decisionInterval: '1h',
      toMs: FROM + 2 * DAY,
      shouldCancel: () => ++polls > 30,
    });
    await expect(run).rejects.toMatchObject({ name: 'BacktestCancelledError' });
    // Thirty frames pass with no hourly decision, then the thirty-first poll cancels.
    expect([seen.length, polls]).toEqual([0, 31]);
    // Polls during candle loading would reach the same count without replaying any frame.
    expect(progress.some((p) => p.phase === 'replay')).toBe(true);
  });
});

describe('missing detail candles are reported without shortening elapsed time', () => {
  const TO = FROM + DAY;
  const removeMinutes = (fromMinute: number, count: number) => (rows: CandleRow[], iv: string) =>
    iv !== '1m'
      ? rows
      : rows.filter((r) => {
          const minute = (r.openTime.getTime() - FROM) / MIN;
          return minute < fromMinute || minute >= fromMinute + count;
        });

  it('reports progress against the whole detail range', async () => {
    serveCandles(removeMinutes(600, 3));
    const { progress } = await replay({ toMs: TO });
    expect(progress.find((p) => p.phase === 'replay')?.total).toBe(1440);
  });

  it('counts the sub-threshold gap per symbol in modelNotes', async () => {
    serveCandles(removeMinutes(600, 3));
    const { notes } = await replay({ toMs: TO });
    expect(
      notes.filter((n) => n.includes('BTCUSDT') && /\b3\b/.test(n) && /missing/i.test(n)),
    ).toHaveLength(1);
  });

  it('values every frame present up to the final close', async () => {
    serveCandles(removeMinutes(600, 3));
    const { equity } = await replay({ toMs: TO });
    expect([equity.length, equity.at(-1)?.tsMs]).toEqual([1437, TO - 1]);
  });

  it('warns when detail coverage is incomplete though strategy candles are whole', async () => {
    serveCandles(removeMinutes(600, 400));
    const { warnings } = await replay({ toMs: TO });
    expect(warnings.filter((w) => w.includes('only 72% of the expected 1m candles'))).toHaveLength(
      1,
    );
  });
});

describe('each registered plugin ticks with kind tick on boundaries', () => {
  const NAMES = ['trailing-trade', 'momentum', 'rebalance'] as const;

  async function replayPlugin(name: string): Promise<ProbeTick[]> {
    const plugin = buildStrategyRegistry().get(name) as unknown as Plugin;
    const seen: ProbeTick[] = [];
    await replay({
      strategy: realProbe(plugin, seen),
      config: { ...(plugin.defaultConfig as Record<string, unknown>), candleInterval: '1h' },
      toMs: FROM + HOUR,
    });
    return seen;
  }

  it.each(NAMES)(
    '%s receives the generic tick trigger',
    async (name) => {
      const kinds = (await replayPlugin(name)).map((t) => t.kind);
      expect(kinds).toEqual(Array.from({ length: 12 }, () => 'tick'));
    },
    SLOW_MS,
  );

  it.each(NAMES)(
    '%s ticks on the decision boundaries only',
    async (name) => {
      const times = (await replayPlugin(name)).map((t) => t.atMs);
      expect(times).toEqual(boundaries(FROM, 5 * MIN, 12));
    },
    SLOW_MS,
  );
});

describe('independent runs read source afresh; signal cache memoises within a run', () => {
  // A process-wide cache left wired would serve the second run without reading the store.
  const sharedCaches = () => {
    const candles = new Map<string, unknown>();
    const signals = new Map<string, unknown>();
    return { candleCache: candles, signalCache: signals };
  };

  it('reads the candle store again for a second run', async () => {
    const deps = sharedCaches();
    await replay({ deps });
    const firstReads = repoMocks.getRange.mock.calls.length;
    await replay({ deps });
    expect(firstReads).toBeGreaterThan(0);
    expect(repoMocks.getRange.mock.calls.length).toBe(firstReads * 2);
  });

  it('derives Technicals signals afresh for a second run', async () => {
    const deps = sharedCaches();
    await replay({ deps });
    const firstRatings = ratingSpy.mock.calls.length;
    await replay({ deps });
    expect(firstRatings).toBeGreaterThan(0);
    expect(ratingSpy.mock.calls.length).toBe(firstRatings * 2);
  });

  it('rates each closed Technicals window once within a run', async () => {
    const seen: ProbeTick[] = [];
    await replay({ strategy: silentProbe(trailingTrade as unknown as Plugin, seen) });
    const tvIntervals = (
      trailingTrade.defaultConfig as unknown as {
        technicals: { intervals: readonly { interval: string }[] };
      }
    ).technicals.intervals.map((row) => row.interval);
    const distinctWindows = tvIntervals.reduce(
      (total, interval) => total + new Set(seen.map((t) => closedAt(interval, t.atMs))).size,
      0,
    );
    expect(seen).toHaveLength(288);
    expect(distinctWindows).toBeGreaterThan(0);
    expect(ratingSpy.mock.calls.length).toBe(distinctWindows);
  });
});

describe('candle repair and filter change alter context', () => {
  const contextOf = (run: Replayed): string => String(run.simulation?.contextFingerprint);
  const repairOneMinute = (rows: CandleRow[], interval: string): CandleRow[] =>
    interval !== '1m'
      ? rows
      : rows.map((r) =>
          r.openTime.getTime() === FROM + 120 * MIN ? { ...r, close: '123.45' } : r,
        );

  it('stamps the run with its simulation metadata', async () => {
    const { simulation } = await replay();
    expect(simulation).toMatchObject({
      engineRevision: BACKTEST_ENGINE_REVISION,
      buildId: BUILD,
      strategyName: trailingTrade.name,
      strategyVersion: trailingTrade.version,
      decisionInterval: '5m',
    });
  });

  it('reproduces the context for identical inputs', async () => {
    const first = await replay();
    const second = await replay();
    expect(contextOf(first)).toMatch(HEX_64);
    expect(contextOf(second)).toBe(contextOf(first));
  });

  it('changes the data fingerprint when a stored candle is repaired', async () => {
    const base = await replay();
    serveCandles(repairOneMinute);
    const repaired = await replay();
    expect(String(base.simulation?.dataFingerprint)).toMatch(HEX_64);
    expect(repaired.simulation?.dataFingerprint).not.toBe(base.simulation?.dataFingerprint);
  });

  it('changes the context when a stored candle is repaired', async () => {
    const base = await replay();
    serveCandles(repairOneMinute);
    const repaired = await replay();
    expect(contextOf(base)).toMatch(HEX_64);
    expect(contextOf(repaired)).not.toBe(contextOf(base));
  });

  it('changes the context when an exchange filter changes', async () => {
    const base = await replay();
    const refiltered = await replay({ tickSize: '0.1' });
    expect(contextOf(base)).toMatch(HEX_64);
    expect(contextOf(refiltered)).not.toBe(contextOf(base));
  });

  it('keeps the context when only the experiment parameter changes', async () => {
    const defaults = trailingTrade.defaultConfig as unknown as {
      sell: { breakEven: Record<string, unknown> };
    };
    const armedAt = (armAtPercentage: string) => ({
      ...(trailingTrade.defaultConfig as unknown as Record<string, unknown>),
      candleInterval: '1h',
      sell: {
        ...defaults.sell,
        breakEven: { ...defaults.sell.breakEven, enabled: true, armAtPercentage },
      },
    });
    const incumbent = await replay({ config: armedAt('1.01') });
    const candidate = await replay({ config: armedAt('1.02') });
    expect(contextOf(incumbent)).toMatch(HEX_64);
    expect(contextOf(candidate)).toBe(contextOf(incumbent));
  });
});

describe('limitations go to modelNotes, not dataWarnings', () => {
  const FIXED_UNIVERSE = /fixed.*(universe|basket)/i;
  const WORKER_PAUSES = /pause/i;

  it.each([
    ['fixed universe', FIXED_UNIVERSE],
    ['unmodelled worker pauses', WORKER_PAUSES],
  ])('records the %s limitation in modelNotes', async (_name, pattern) => {
    const { notes } = await replay();
    expect(notes.filter((n) => pattern.test(n)).length).toBeGreaterThan(0);
  });

  it('keeps those limitations out of dataWarnings', async () => {
    const { warnings } = await replay();
    expect(warnings.filter((w) => FIXED_UNIVERSE.test(w) || WORKER_PAUSES.test(w))).toEqual([]);
  });
});
