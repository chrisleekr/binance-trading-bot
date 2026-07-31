// edge-decay-monitor cron.
//
// The enablement gate proves an edge once, at enable-time. Nothing re-checked a
// profile AFTER it went live, so a config whose edge decayed kept deploying real
// capital until an operator happened to read the scorecard. This cron closes that
// hole with an ADVISORY heads-up: every 15 minutes it compares each live profile's
// realized net profit factor against the profit factor of its pinned baseline
// backtest (the same baseline the live-vs-backtest scorecard shows) and, on a
// breach, sends the operator a one-time Slack heads-up. It NEVER pauses buys — the
// bot's only auto-pause is the daily-loss breaker.
//
// De-dup via the per-profile `edgeDecayNotified` Redis latch: set when we alert on
// a breach, cleared when the edge recovers, so a single decay episode alerts once
// and a later re-decay re-alerts. The latch is NOT read by the tick handler and
// never suppresses buys — it only tracks "have we already alerted".
//
// Cross-symbol by nature (a profile-wide realized-edge judgement), so it lives
// worker-side, never in the pure per-(profile,symbol) strategy (invariant #1).

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  BacktestResultSchema,
  EnablementPolicy,
  assessEdgeDecay,
  profitFactorFromGross,
  summarizeClosedTrades,
  type EdgeDecayVerdict,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { profileRepo, profileKey, repo as dbRepo } from '@app/db';
import { fanOutBounded } from '@app/core/fan-out';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';

const EDGE_MONITOR_CONCURRENCY = 4;

/** One profile's edge evaluation: the verdict and the figures behind it. */
export interface EdgeAssessment {
  readonly verdict: EdgeDecayVerdict;
  readonly reason: string;
  readonly liveProfitFactor: number | null;
  readonly baselineProfitFactor: number | null;
  readonly liveTradeCount: number;
}

/**
 * Whether a decayed verdict warrants an advisory heads-up. BREACHED only — the
 * same threshold the old halt condition used, so a `warning` never pushes and the
 * operator hears at most one alert per decay episode. Pure for unit tests. This is
 * an ALERT decision only; it never pauses buys.
 */
export const shouldAlertOnDecay = (verdict: EdgeDecayVerdict): boolean => verdict === 'breached';

export interface EdgeDecayMonitorDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /** Evaluate a profile's live edge; null when the profile is not live or is gone. */
  readonly assess: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ) => Promise<EdgeAssessment | null>;
  /** Whether the advisory latch is set (we have already alerted for this episode). */
  readonly wasNotified: (accountId: AccountId, profileId: ProfileId) => Promise<boolean>;
  readonly markNotified: (
    accountId: AccountId,
    profileId: ProfileId,
    value: string,
  ) => Promise<void>;
  readonly clearNotified: (accountId: AccountId, profileId: ProfileId) => Promise<void>;
  /** Notify the operator (gated by the profile's notify_events subscription). */
  readonly notify: NotifyEvent;
  readonly clock?: { nowMs(): number };
}

export const edgeDecayMonitorHandler = (deps: EdgeDecayMonitorDeps) => {
  return async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const { errors } = await fanOutBounded<ActiveProfile, 'ok'>(
      deps.listActive(),
      async (profile) => {
        const a = await deps.assess(profile.operatorId, profile.accountId, profile.profileId);
        if (!a) return 'ok';
        const decayed = shouldAlertOnDecay(a.verdict);
        const already = await deps.wasNotified(profile.accountId, profile.profileId);
        if (decayed && !already) {
          await deps.markNotified(
            profile.accountId,
            profile.profileId,
            JSON.stringify({
              verdict: a.verdict,
              detail: a.reason,
              liveProfitFactor: a.liveProfitFactor,
              baselineProfitFactor: a.baselineProfitFactor,
              liveTradeCount: a.liveTradeCount,
              notifiedAtMs: clock.nowMs(),
            }),
          );
          deps.logger.warn(
            {
              profileId: profile.profileId,
              verdict: a.verdict,
              liveProfitFactor: a.liveProfitFactor,
              baselineProfitFactor: a.baselineProfitFactor,
              liveTradeCount: a.liveTradeCount,
            },
            'edge-decay monitor: live edge below baseline — heads-up sent, buys NOT paused',
          );
          await deps.notify({
            category: 'edge-decay-warning',
            operatorId: profile.operatorId,
            accountId: profile.accountId,
            profileId: profile.profileId,
            body: 'Live results are running below your saved backtest baseline. This is a heads-up; the bot has not paused buys.',
            fields: [
              { label: 'Live profit factor', value: String(a.liveProfitFactor ?? 'n/a') },
              { label: 'Baseline', value: String(a.baselineProfitFactor ?? 'n/a') },
              { label: 'Trades measured', value: String(a.liveTradeCount) },
            ],
          });
        } else if (!decayed && already) {
          await deps.clearNotified(profile.accountId, profile.profileId);
          deps.logger.info(
            { profileId: profile.profileId, verdict: a.verdict },
            'edge-decay monitor: live edge recovered — advisory latch cleared',
          );
        }
        return 'ok';
      },
      { concurrency: EDGE_MONITOR_CONCURRENCY, onError: 'collect' },
    );
    for (const { item, error } of errors) {
      deps.logger.warn(
        { profileId: item.profileId, err: error },
        'edge-decay monitor: check failed (will retry next tick)',
      );
    }
  };
};

export const buildEdgeDecayMonitorCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'edge-decay-monitor',
    queue: QUEUE_NAMES.edgeDecayMonitor,
    pattern: '0 */15 * * * *',
    handler: edgeDecayMonitorHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      assess: async (operatorId, accountId, profileId) => {
        const repo = await profileRepo(ctx.db, operatorId, accountId, profileId);
        const row = await repo.profile.findById();
        if (!row) return null;
        // Real money only: the monitor protects live capital, not testnet. Mode is
        // an account-level property now, read via the account id.
        const mode = await dbRepo.accounts.binanceModeById(ctx.db, accountId);
        if (mode !== 'live') return null;

        // A stored policy that fails validation falls back to defaults (never
        // crash the loop); the API surfaces an invalid policy elsewhere.
        const parsedPolicy = EnablementPolicy.safeParse(
          (row as { enablementPolicy?: unknown }).enablementPolicy ?? {},
        );
        const monitor = parsedPolicy.success
          ? parsedPolicy.data.monitor
          : EnablementPolicy.parse({}).monitor;
        const baselineId =
          (row as { baselineBacktestRunId?: string | null }).baselineBacktestRunId ?? null;

        // Live realized summary over all closed trades — the same window the
        // live-vs-backtest scorecard uses, so alert and display agree. `orders`
        // is unused by the collapsed summary, so an empty array avoids a cast.
        const rows = await repo.tradeArchive.listForProfileInRange(null);
        const summary = summarizeClosedTrades(
          rows.map((r) => ({
            quoteAsset: r.quoteAsset,
            source: r.source,
            profit: r.profit,
            feesQuote: r.feesQuote,
            orders: [],
          })),
        );
        const liveProfitFactor = profitFactorFromGross(summary.grossProfit, summary.grossLoss);

        // Baseline profit factor from the pinned backtest run, when present and readable.
        let hasBaseline = false;
        let baselineProfitFactor: number | null = null;
        if (baselineId !== null) {
          const runRow = await repo.backtestRuns.get(baselineId);
          if (runRow) {
            const parsed = BacktestResultSchema.safeParse(runRow.result);
            if (parsed.success) {
              hasBaseline = true;
              baselineProfitFactor = parsed.data.metrics.profitFactor;
            }
          }
        }

        const assessment = assessEdgeDecay({
          policy: monitor,
          hasBaseline,
          baselineProfitFactor,
          liveProfitFactor,
          liveTradeCount: summary.tradeCount,
        });
        return {
          verdict: assessment.verdict,
          reason: assessment.reason,
          liveProfitFactor,
          baselineProfitFactor,
          liveTradeCount: summary.tradeCount,
        };
      },
      wasNotified: async (accountId, profileId) =>
        (await ctx.redis.exists(profileKey({ accountId, profileId }, 'edgeDecayNotified'))) === 1,
      markNotified: async (accountId, profileId, value) => {
        await ctx.redis.set(profileKey({ accountId, profileId }, 'edgeDecayNotified'), value);
      },
      clearNotified: async (accountId, profileId) => {
        await ctx.redis.del(profileKey({ accountId, profileId }, 'edgeDecayNotified'));
      },
      notify: ctx.notifyEvent,
    }),
  });
