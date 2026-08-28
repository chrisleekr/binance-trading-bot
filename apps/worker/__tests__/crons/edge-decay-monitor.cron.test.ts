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
  type EdgeAssessment,
  type EdgeDecayMonitorDeps,
} from '../../src/crons/edge-decay-monitor.cron.js';

const silent = pino({ level: 'silent' });
const U = 'u1' as unknown as UserId;
const A = 'a1' as unknown as AccountId;
const P = 'p1' as unknown as ProfileId;
const job = {} as Job;

const assessment = (over: Partial<EdgeAssessment> = {}): EdgeAssessment => ({
  verdict: 'healthy',
  reason: 'ok',
  liveProfitFactor: 2,
  baselineProfitFactor: 2,
  liveTradeCount: 50,
  ...over,
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
