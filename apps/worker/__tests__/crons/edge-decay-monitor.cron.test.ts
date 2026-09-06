import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { AccountId, EdgeDecayVerdict, ProfileId, UserId } from '@app/contracts';
import type { BootContext } from '../../src/boot/boot-context.js';

const dbMocks = vi.hoisted(() => ({
  profileRepo: vi.fn(),
  binanceModeById: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@app/db')>();
  return {
    ...original,
    profileRepo: dbMocks.profileRepo,
    repo: {
      ...original.repo,
      accounts: { ...original.repo.accounts, binanceModeById: dbMocks.binanceModeById },
    },
  };
});

import {
  buildEdgeDecayMonitorCron,
  edgeDecayMonitorHandler,
  shouldAlertOnDecay,
  tradesMeasured,
  type EdgeAssessment,
  type EdgeDecayMonitorDeps,
} from '../../src/crons/edge-decay-monitor.cron.js';

const silent = pino({ level: 'silent' });
const U = 'u1' as unknown as UserId;
const A = 'a1' as unknown as AccountId;
const P = 'p1' as unknown as ProfileId;
const job = {} as Job;

/** A pinned baseline run whose result parses, so the cron gets past `hasBaseline` and can reach a real verdict. Profit factor 1.8; every other figure is filler the monitor never reads. */
const baselineRun = {
  result: {
    params: {
      symbols: ['BTCUSDT'],
      fromMs: 0,
      toMs: 1,
      strategyInterval: '1h',
      detailInterval: '1m',
      initialQuoteBalance: '1000',
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 0,
    },
    metrics: {
      startingBalance: '1000',
      finalBalance: '1100',
      absoluteProfit: '100',
      totalReturnPct: 10,
      cagrPct: 10,
      marketChangePct: 5,
      dcaChangePct: 5,
      alphaVsHoldPct: 5,
      alphaVsDcaPct: 5,
      sharpe: 1,
      sortino: 1,
      calmar: 1,
      sqn: 1,
      maxDrawdownPct: 5,
      absoluteDrawdown: '50',
      drawdownStartMs: 0,
      drawdownEndMs: 1,
      totalTrades: 20,
      winRate: 0.6,
      wins: 12,
      losses: 8,
      expectancy: '5',
      bestTradePct: 10,
      worstTradePct: -5,
      avgTradePnl: '5',
      avgTradeDurationMs: 1000,
      profitFactor: 1.8,
    },
    equityCurve: [],
    drawdownSeries: [],
    trades: [],
    perSymbol: [],
  },
};

const assessment = (over: Partial<EdgeAssessment> = {}): EdgeAssessment => ({
  verdict: 'healthy',
  reason: 'ok',
  liveProfitFactor: 2,
  baselineProfitFactor: 2,
  liveTradeCount: 50,
  windowTradeCount: 50,
  ...over,
});

describe('tradesMeasured', () => {
  it('states the coverage when the window held rows the verdict could not use', () => {
    expect(tradesMeasured({ liveTradeCount: 6, windowTradeCount: 40 })).toBe('6 of 40 cycles');
  });

  it('states the count alone when the two agree', () => {
    expect(tradesMeasured({ liveTradeCount: 40, windowTradeCount: 40 })).toBe('40');
  });
});

describe('shouldAlertOnDecay', () => {
  it('alerts only on a breach', () => {
    expect(shouldAlertOnDecay('breached')).toBe(true);
  });

  it('never alerts on any non-breach verdict', () => {
    const nonBreach: EdgeDecayVerdict[] = [
      'warning',
      'healthy',
      'insufficient-data',
      'no-baseline',
      'monitor-off',
    ];
    for (const v of nonBreach) expect(shouldAlertOnDecay(v)).toBe(false);
  });
});

const deps = (over: Partial<EdgeDecayMonitorDeps> = {}): EdgeDecayMonitorDeps => ({
  logger: silent,
  listActive: () => [{ operatorId: U, accountId: A, profileId: P } as never],
  assess: vi.fn(async () => null),
  wasNotified: vi.fn(async () => false),
  markNotified: vi.fn(async () => undefined),
  clearNotified: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
  clock: { nowMs: () => 1_000 },
  ...over,
});

describe('edgeDecayMonitorHandler', () => {
  it('abstains before assessment and notification when fee evidence is incomplete', async () => {
    const backtestGet = vi.fn();
    const listForProfileInRange = vi.fn(async () => [
      {
        quoteAsset: 'USDT',
        source: 'manual',
        profit: '-40',
        feesQuote: '0',
        feeBasis: 'unknown',
      },
    ]);
    const wasNotified = vi.fn(async () => 0);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    dbMocks.binanceModeById.mockResolvedValueOnce('live');
    dbMocks.profileRepo.mockResolvedValueOnce({
      profile: {
        findById: async () => ({
          quoteAsset: 'USDT',
          enablementPolicy: {
            monitor: { mode: 'warn', minTrades: 10, warnFactor: 0.85, breachFactor: 0.6 },
          },
          baselineBacktestRunId: 'baseline-1',
        }),
      },
      tradeArchive: { listForProfileInRange },
      backtestRuns: { get: backtestGet },
    });
    const ctx = {
      db: {},
      logger: silent,
      listActive: () => [{ operatorId: U, accountId: A, profileId: P }],
      redis: { exists: wasNotified, set: vi.fn(), del: vi.fn() },
      notifyEvent: notify,
    } as unknown as BootContext;

    await buildEdgeDecayMonitorCron(ctx).handler(job);

    expect(listForProfileInRange).toHaveBeenCalledWith(null);
    expect(backtestGet).not.toHaveBeenCalled();
    expect(wasNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('assesses a reconstructed fee total rather than abstaining on it', async () => {
    // The middle tier is the one a two-state gate gets wrong, and the safe-looking direction is the wrong one. An account Binance bills in BNB has a commission reconstructed from the rate table on EVERY cycle, so requiring the strongest tier here does not make the alarm cautious, it deletes it: the monitor would go permanently silent on exactly the accounts it exists for. Only `unknown` abstains, because only `unknown` is missing a charge.
    //
    // Twelve rows, not one. `minTrades` is 10 and the count is checked inside `assessEdgeDecay`, so a single-row fixture abstains on insufficient data whatever the tier gate does and pins nothing. `backtestGet` is the probe because the cron reaches for the baseline only after the tier gate lets it through.
    const backtestGet = vi.fn(async () => null);
    const listForProfileInRange = vi.fn(async () =>
      Array.from({ length: 12 }, (_, n) => ({
        quoteAsset: 'USDT',
        source: 'manual',
        profit: n < 7 ? '10' : '-10',
        feesQuote: '0',
        feeBasis: 'estimated',
      })),
    );
    const wasNotified = vi.fn(async () => 0);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    dbMocks.binanceModeById.mockResolvedValueOnce('live');
    dbMocks.profileRepo.mockResolvedValueOnce({
      profile: {
        findById: async () => ({
          quoteAsset: 'USDT',
          enablementPolicy: {
            monitor: { mode: 'warn', minTrades: 10, warnFactor: 0.85, breachFactor: 0.6 },
          },
          baselineBacktestRunId: 'baseline-1',
        }),
      },
      tradeArchive: { listForProfileInRange },
      backtestRuns: { get: backtestGet },
    });
    const ctx = {
      db: {},
      logger: silent,
      listActive: () => [{ operatorId: U, accountId: A, profileId: P }],
      redis: { exists: wasNotified, set: vi.fn(), del: vi.fn() },
      notifyEvent: notify,
    } as unknown as BootContext;

    await buildEdgeDecayMonitorCron(ctx).handler(job);

    expect(backtestGet).toHaveBeenCalledTimes(1);
  });

  it("judges only the rows in the profile's own quote, as the on-screen verdict does", async () => {
    // Two failures in one, both invisible without a second currency in the fixture. The screen's `useEdgeVerdict` folds through `mergeRollupBuckets(…, quoteAsset)`, which drops every other currency BEFORE it folds the tier — so an unfiltered fold here reads the legacy BTC rows' `unknown` and abstains while the badge, seeing only USDT, issues a verdict. The operator gets a decay warning on screen that the alert channel would never send, with nothing anywhere saying why.
    //
    // And the sums are not currency-tagged: `grossProfit`/`grossLoss` would add BTC magnitudes to USDT ones, so the profit factor the alert is built on would be a ratio of two numbers denominated in nothing.
    const backtestGet = vi.fn(async () => null);
    const listForProfileInRange = vi.fn(async () => [
      ...Array.from({ length: 12 }, (_, n) => ({
        quoteAsset: 'USDT',
        source: 'manual',
        profit: n < 7 ? '10' : '-10',
        feesQuote: '0',
        feeBasis: 'exact',
      })),
      // The legacy row, in a quote this profile has since moved off.
      { quoteAsset: 'BTC', source: 'manual', profit: '-5', feesQuote: '0', feeBasis: 'unknown' },
    ]);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    dbMocks.binanceModeById.mockResolvedValueOnce('live');
    dbMocks.profileRepo.mockResolvedValueOnce({
      profile: {
        findById: async () => ({
          quoteAsset: 'USDT',
          enablementPolicy: {
            monitor: { mode: 'warn', minTrades: 10, warnFactor: 0.85, breachFactor: 0.6 },
          },
          baselineBacktestRunId: 'baseline-1',
        }),
      },
      tradeArchive: { listForProfileInRange },
      backtestRuns: { get: backtestGet },
    });
    const ctx = {
      db: {},
      logger: silent,
      listActive: () => [{ operatorId: U, accountId: A, profileId: P }],
      redis: { exists: vi.fn(async () => 0), set: vi.fn(), del: vi.fn() },
      notifyEvent: notify,
    } as unknown as BootContext;

    await buildEdgeDecayMonitorCron(ctx).handler(job);

    // Reached the baseline fetch, so the BTC row's `unknown` did not reach the tier gate.
    expect(backtestGet).toHaveBeenCalledTimes(1);
  });

  it('reports the fee-valued sample the verdict came from, not the window it was cut from', async () => {
    // The pin on the assess builder itself. Six of forty cycles carried fee evidence, so the profit factor is folded from six — and that is the sample size the alert has to name. Returning the window's forty told the operator a forty-cycle judgement that six cycles produced, in the Slack field, the notified-marker JSON and the warn log alike.
    const backtestGet = vi.fn(async () => baselineRun);
    const listForProfileInRange = vi.fn(async () => [
      // Six valued: one winner, five losers → live PF 0.2, under the absolute floor of 1.0, so the verdict is `breached` and the alert fires.
      ...Array.from({ length: 6 }, (_, n) => ({
        quoteAsset: 'USDT',
        source: 'manual',
        profit: n === 0 ? '10' : '-10',
        feesQuote: '0',
        feeBasis: 'exact',
      })),
      // Thirty-four cycles the window holds and the verdict could not use.
      ...Array.from({ length: 34 }, () => ({
        quoteAsset: 'USDT',
        source: 'manual',
        profit: '5',
        feesQuote: '0',
        feeBasis: 'unknown',
      })),
    ]);
    const set = vi.fn();
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    dbMocks.binanceModeById.mockResolvedValueOnce('live');
    dbMocks.profileRepo.mockResolvedValueOnce({
      profile: {
        findById: async () => ({
          quoteAsset: 'USDT',
          enablementPolicy: {
            monitor: { mode: 'warn', minTrades: 5, warnFactor: 0.85, breachFactor: 0.6 },
          },
          baselineBacktestRunId: 'baseline-1',
        }),
      },
      tradeArchive: { listForProfileInRange },
      backtestRuns: { get: backtestGet },
    });
    const ctx = {
      db: {},
      logger: silent,
      listActive: () => [{ operatorId: U, accountId: A, profileId: P }],
      redis: { exists: vi.fn(async () => 0), set, del: vi.fn() },
      notifyEvent: notify,
    } as unknown as BootContext;

    await buildEdgeDecayMonitorCron(ctx).handler(job);

    expect(notify).toHaveBeenCalledTimes(1);
    const fields = notify.mock.calls[0]?.[0].fields as { label: string; value: string }[];
    expect(fields.find((f) => f.label === 'Trades measured')?.value).toBe('6 of 40 cycles');
    const marker = JSON.parse((set.mock.calls[0] as unknown as [string, string])[1]) as {
      liveTradeCount: number;
      windowTradeCount: number;
    };
    expect(marker).toMatchObject({ liveTradeCount: 6, windowTradeCount: 40 });
  });

  it('abstains outright when the profile names no quote asset', async () => {
    // Fail-closed on the filter's own precondition. With no quote to match, every archive row is filtered away — and an EMPTY window folds to `exact` by identity, so the tier gate would wave through a summary of zero trades rather than decline to judge one. The visible cost of getting this wrong is small (no alert can fire on zero trades) but the shape is the fail-open one, and it is the shape that gets copied.
    const backtestGet = vi.fn(async () => null);
    const listForProfileInRange = vi.fn(async () => [
      { quoteAsset: 'USDT', source: 'manual', profit: '10', feesQuote: '0', feeBasis: 'exact' },
    ]);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    dbMocks.binanceModeById.mockResolvedValueOnce('live');
    dbMocks.profileRepo.mockResolvedValueOnce({
      profile: {
        findById: async () => ({
          enablementPolicy: {
            monitor: { mode: 'warn', minTrades: 10, warnFactor: 0.85, breachFactor: 0.6 },
          },
          baselineBacktestRunId: 'baseline-1',
        }),
      },
      tradeArchive: { listForProfileInRange },
      backtestRuns: { get: backtestGet },
    });
    const ctx = {
      db: {},
      logger: silent,
      listActive: () => [{ operatorId: U, accountId: A, profileId: P }],
      redis: { exists: vi.fn(async () => 0), set: vi.fn(), del: vi.fn() },
      notifyEvent: notify,
    } as unknown as BootContext;

    await buildEdgeDecayMonitorCron(ctx).handler(job);

    expect(backtestGet).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing when assess returns null (not live / gone)', async () => {
    const markNotified = vi.fn(async () => undefined);
    const clearNotified = vi.fn(async () => undefined);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({ assess: async () => null, markNotified, clearNotified, notify }),
    )(job);
    expect(markNotified).not.toHaveBeenCalled();
    expect(clearNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks the latch and notifies once on a fresh breach', async () => {
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'breached', liveProfitFactor: 0.8 }),
        wasNotified: async () => false,
        markNotified,
        notify,
      }),
    )(job);
    expect(markNotified).toHaveBeenCalledTimes(1);
    const call = markNotified.mock.calls[0] as unknown as [AccountId, ProfileId, string];
    expect(JSON.parse(call[2])).toMatchObject({ verdict: 'breached', notifiedAtMs: 1_000 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      category: 'edge-decay-warning',
      operatorId: U,
      accountId: A,
      profileId: P,
    });
  });

  it('prints the sample the verdict was taken over, with the window it came from', async () => {
    // The alert's "Trades measured" once printed the WINDOW's count while the profit factor beside it was folded from the fee-valued rows alone: an operator reading "40" was told a forty-cycle judgement that six cycles produced. The marker JSON and the warn log recorded the same wrong number.
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () =>
          assessment({ verdict: 'breached', liveTradeCount: 6, windowTradeCount: 40 }),
        wasNotified: async () => false,
        markNotified,
        notify,
      }),
    )(job);
    const fields = notify.mock.calls[0]?.[0].fields as { label: string; value: string }[];
    expect(fields.find((f) => f.label === 'Trades measured')?.value).toBe('6 of 40 cycles');
    const call = markNotified.mock.calls[0] as unknown as [AccountId, ProfileId, string];
    expect(JSON.parse(call[2])).toMatchObject({ liveTradeCount: 6, windowTradeCount: 40 });
  });

  it('prints a bare count when every cycle in the window was measured', async () => {
    // Anchors the case above: "50 of 50 cycles" is noise, and a formatter that always joins the pair would pass it.
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'breached' }),
        wasNotified: async () => false,
        notify,
      }),
    )(job);
    const fields = notify.mock.calls[0]?.[0].fields as { label: string; value: string }[];
    expect(fields.find((f) => f.label === 'Trades measured')?.value).toBe('50');
  });

  it('does not alert on a warning verdict', async () => {
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'warning' }),
        wasNotified: async () => false,
        markNotified,
        notify,
      }),
    )(job);
    expect(markNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not re-alert when already notified', async () => {
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn<EdgeDecayMonitorDeps['notify']>(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'breached' }),
        wasNotified: async () => true,
        markNotified,
        notify,
      }),
    )(job);
    expect(markNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('clears the latch when the edge recovers to healthy', async () => {
    const clearNotified = vi.fn(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'healthy' }),
        wasNotified: async () => true,
        clearNotified,
      }),
    )(job);
    expect(clearNotified).toHaveBeenCalledTimes(1);
  });

  it('collects per-profile assess failures without throwing', async () => {
    const assess = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(edgeDecayMonitorHandler(deps({ assess }))(job)).resolves.toBeUndefined();
  });
});
