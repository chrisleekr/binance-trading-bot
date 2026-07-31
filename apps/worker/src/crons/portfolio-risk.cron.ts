// portfolio-risk cron.
//
// Daily-loss circuit breaker. Every 30s run it computes each active profile's
// realised P/L since 00:00 UTC and, when the loss reaches the profile's
// configured `dailyLossLimitQuote`, sets a per-profile Redis flag that expires at
// the next UTC midnight. The tick handler drops new BUY orders while the flag is
// present (open positions and their protective stops are untouched — the breaker
// pauses new risk, it never force-sells). The TTL self-clears the flag at the day
// boundary, so a new UTC day always re-arms entries. Once tripped the flag is left
// in place for the rest of the day even if later exits recover the day's P/L: a
// circuit breaker does not silently re-close intraday.
//
// Cross-symbol by nature (a profile-wide P/L sum), so it lives worker-side, never
// in the pure per-(profile,symbol) strategy (invariant #1, tracker #267).

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { Decimal } from '@app/money';
import {
  RiskConfigSchema,
  startOfUtcDayMs,
  nextUtcMidnightMs,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { profileRepo, profileKey } from '@app/db';
import { fanOutBounded } from '@app/core/fan-out';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';

const PORTFOLIO_RISK_CONCURRENCY = 4;

/**
 * Whether the day's realised P/L has breached the loss limit. `limitQuote` of 0,
 * blank, or non-positive means the breaker is off. Breached when the realised
 * loss meets or exceeds the limit, i.e. `totalProfit <= -limit`. Malformed inputs
 * fail safe to "not breached" rather than throwing in the cron loop.
 */
export const isDailyLossBreached = (realisedPnlQuote: string, limitQuote: string): boolean => {
  let limit: Decimal;
  let pnl: Decimal;
  try {
    limit = new Decimal(limitQuote);
    pnl = new Decimal(realisedPnlQuote);
  } catch {
    return false;
  }
  if (!limit.isFinite() || limit.lte(0)) return false;
  if (!pnl.isFinite()) return false;
  return pnl.lte(limit.negated());
};

/** A profile's active loss limit and realised P/L for the day, or null when the
 *  breaker is off / unconfigured for that profile. */
export interface RiskAssessment {
  readonly limitQuote: string;
  readonly realisedPnl: string;
}

export interface PortfolioRiskDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /** Resolve the profile's daily loss limit + realised P/L in [sinceMs, untilMs);
   *  null when the breaker is off or the profile is gone. */
  readonly assess: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    sinceMs: number,
    untilMs: number,
  ) => Promise<RiskAssessment | null>;
  /** Set the per-profile entry-halt flag with a TTL (seconds) to the next UTC day. */
  readonly setEntryHalt: (
    accountId: AccountId,
    profileId: ProfileId,
    ttlSec: number,
    value: string,
  ) => Promise<void>;
  /** Whether the daily-loss halt flag is already set (edge-trigger the alert). */
  readonly wasHalted: (accountId: AccountId, profileId: ProfileId) => Promise<boolean>;
  /** Notify the operator (gated by the profile's notify_events subscription). */
  readonly notify: NotifyEvent;
  readonly clock?: { nowMs(): number };
}

export const portfolioRiskHandler = (deps: PortfolioRiskDeps) => {
  return async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const now = clock.nowMs();
    const sinceMs = startOfUtcDayMs(now);
    const { errors } = await fanOutBounded<ActiveProfile, 'ok' | 'halted'>(
      deps.listActive(),
      async (profile) => {
        const a = await deps.assess(
          profile.operatorId,
          profile.accountId,
          profile.profileId,
          sinceMs,
          now,
        );
        if (!a) return 'ok';
        if (!isDailyLossBreached(a.realisedPnl, a.limitQuote)) return 'ok';
        // The breaker re-sets the flag every cycle while breached (so the TTL
        // keeps tracking the day boundary), so notify only on the transition
        // into halt — otherwise the operator gets an alert every 30s all day.
        const already = await deps.wasHalted(profile.accountId, profile.profileId);
        const ttlSec = Math.max(1, Math.ceil((nextUtcMidnightMs(now) - now) / 1000));
        await deps.setEntryHalt(
          profile.accountId,
          profile.profileId,
          ttlSec,
          JSON.stringify({
            reason: 'daily-loss-limit',
            limitQuote: a.limitQuote,
            lossQuote: a.realisedPnl,
            trippedAtMs: now,
          }),
        );
        deps.logger.warn(
          { profileId: profile.profileId, limitQuote: a.limitQuote, realisedPnl: a.realisedPnl },
          'portfolio-risk: daily loss limit reached — new buys paused until next UTC day',
        );
        if (!already) {
          await deps.notify({
            category: 'daily-loss-halt',
            operatorId: profile.operatorId,
            accountId: profile.accountId,
            profileId: profile.profileId,
            body: "Today's loss reached your limit. New buys are paused until 00:00 UTC (next day). Sells and exits still run.",
            // a.realisedPnl is signed; show the magnitude so it reads "loss 50".
            fields: [
              { label: "Today's loss", value: new Decimal(a.realisedPnl).abs().toString() },
              { label: 'Limit', value: String(a.limitQuote) },
            ],
          });
        }
        return 'halted';
      },
      { concurrency: PORTFOLIO_RISK_CONCURRENCY, onError: 'collect' },
    );
    for (const { item, error } of errors) {
      deps.logger.warn(
        { profileId: item.profileId, err: error },
        'portfolio-risk: loss check failed (will retry next tick)',
      );
    }
  };
};

export const buildPortfolioRiskCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'portfolio-risk',
    queue: QUEUE_NAMES.portfolioRisk,
    pattern: '*/30 * * * * *',
    handler: portfolioRiskHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      assess: async (operatorId, accountId, profileId, sinceMs, untilMs) => {
        const repo = await profileRepo(ctx.db, operatorId, accountId, profileId);
        const row = await repo.profile.findById();
        if (!row) return null;
        // A stored value that fails validation disables the breaker (fail-open on
        // the breaker, never crash the loop); the API surfaces configInvalid.
        const parsed = RiskConfigSchema.safeParse(
          (row as { riskConfig?: unknown }).riskConfig ?? {},
        );
        const limitQuote = parsed.success ? parsed.data.dailyLossLimitQuote : '0';
        if (new Decimal(limitQuote || '0').lte(0)) return null;
        const { totalProfit } = await repo.tradeArchive.sumProfitInRange(
          new Date(sinceMs),
          new Date(untilMs),
        );
        return { limitQuote, realisedPnl: totalProfit };
      },
      setEntryHalt: async (accountId, profileId, ttlSec, value) => {
        await ctx.redis.set(
          profileKey({ accountId, profileId }, 'entryHaltDaily'),
          value,
          'EX',
          ttlSec,
        );
      },
      wasHalted: async (accountId, profileId) =>
        (await ctx.redis.exists(profileKey({ accountId, profileId }, 'entryHaltDaily'))) === 1,
      notify: ctx.notifyEvent,
    }),
  });
