// portfolio-risk cron.
//
// The three entry breakers, all of which pause only NEW BUYS: open positions and
// their protective stops are untouched, so a breaker never force-sells.
//
// - Daily loss: realised P/L since 00:00 UTC against `dailyLossLimitQuote`. Its
//   flag is re-set every cycle while breached, with a TTL to the next UTC
//   midnight, so a new UTC day always re-arms entries. Once tripped it stays for
//   the rest of the day even if later exits recover the day's P/L — a circuit
//   breaker does not silently re-close intraday.
// - Loss streak: losing closed cycles inside a rolling `lookbackHours` against
//   `maxLosingExits`. Rolling rather than calendar-day, which is the whole point:
//   a cluster of losses straddling midnight is invisible to the daily breaker.
// - Drawdown: realised peak-to-trough inside a rolling `lookbackHours` against
//   `maxDrawdownQuote`, which catches a slide of small losses that no single
//   day's limit would ever see.
//
// The two guards are written SET NX with a TTL of their `pauseHours`, so the
// pause runs from the trip and is not extended by the next cycle 30s later. When
// it expires the cron re-evaluates and may trip again, which is a real new pause.
//
// Cross-symbol by nature (profile-wide P/L over a window), so it lives worker-side,
// never in the pure per-(profile,symbol) strategy (invariant #1).

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { Decimal } from '@app/money';
import {
  RiskConfigSchema,
  startOfUtcDayMs,
  nextUtcMidnightMs,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { profileRepo, entryHaltKeys } from '@app/db';
import { fanOutBounded } from '@app/core/fan-out';
import type { BootContext } from 'boot/boot-context.js';
import type { MetricsSink } from 'metrics/catalog.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';

const PORTFOLIO_RISK_CONCURRENCY = 4;

const MS_PER_HOUR = 3_600_000;

// Largest base-10 exponent an alert amount is spelled out in full at. Two of the four amounts below are operator-typed config (`dailyLossLimitQuote`, `maxDrawdownQuote`) validated only for decimal shape, finiteness and `gte: 0` — nothing bounds their exponent — so a twelve-byte `1e-10000000` is a legal stored value, and `toFixed()` never uses exponential notation: it would write ten million characters synchronously on the single-replica worker's event loop, then POST them to the notifier and store them in notification history. 308 is the same decade the wire-decimal contract stops at, and 308 fraction digits is already far past any exchange's precision, so nothing real is pushed into the fallback spelling.
//
// Read off `Decimal#e`, which needs no expansion, and checked BEFORE anything formats the value. Deliberately not a max-length cap on the input: `toFixed()` output can be far longer than its input (`1e-308` is 6 characters in, 310 out), so a cap sized on what arrived would reject amounts this module itself produced.
const MAX_ALERT_EXPONENT = 308;

// The other axis of the same expansion, and the exponent gate does not cover it: `'1.' + '9'.repeat(2_000_000)` has an exponent of 0, so it passes the check above and `toFixed()` still writes two million characters. `decimalString` bounds neither the digit count nor the length, and the value lands in an unconstrained `jsonb` column, so an operator-typed limit reaches here with as many digits as it was saved with. Same decade as the exponent for the same reason: 308 significant digits is already far past any exchange's precision.
const MAX_ALERT_DIGITS = 308;

/**
 * A quote amount as the operator should read it in an alert.
 *
 * `numeric(38,18)` reaches the cron as `'15.388000000000000000'`, which sits in the alert directly beside a limit the operator typed as `15` and reads as a different number. `toFixed()` rather than `toString()` because decimal.js switches `toString` to exponential notation at small exponents, and `1.5e-7` in a currency field reads as corruption rather than as a very small amount. Presentation only — the value compared against the limit and the value stored in the flag payload both stay exact, so the exponential fallback below costs the operator legibility on a value that was never a real amount and costs the breaker nothing.
 *
 * Every money field on both halt alerts goes through here. Normalising one branch and not its neighbour is how two figures on one surface come to be formatted two different ways.
 *
 * @param quote - A finite amount in the profile's quote asset, as a decimal string or an already-built Decimal; parseability is proven by the trip predicate that gated the call.
 * @returns The same amount without the column's trailing scale and never in exponential form, except past {@link MAX_ALERT_EXPONENT} or {@link MAX_ALERT_DIGITS} where it is ROUNDED into exponential form precisely so that writing it cannot expand into a multi-megabyte string.
 */
const asAlertAmount = (quote: string | Decimal): string => {
  const d = new Decimal(quote);
  if (Math.abs(d.e) <= MAX_ALERT_EXPONENT && d.sd() <= MAX_ALERT_DIGITS) return d.toFixed();
  // Rounded, not merely re-spelled. A bare `toExponential()` writes every significant digit, so the long-mantissa case expands there too; the digit count is what has to be capped. Kept at the value's own precision when that is already short, so an extreme exponent with one digit still reads as `1e-10000000` rather than as that digit followed by 307 zeroes.
  return d.toExponential(Math.min(d.sd(), MAX_ALERT_DIGITS) - 1);
};

/**
 * A stored money string as a usable Decimal, or null when it is unparseable or non-finite.
 *
 * Both trip predicates below read an operator-typed limit alongside a SQL-derived total, and both must answer "not tripped" on a malformed one rather than throw: an exception raised here escapes into the cron's fan-out, and a risk control that crashes the loop is worse than one that declines to trip.
 *
 * @param quote - A decimal string from the stored risk config or a `numeric` column.
 * @returns The parsed amount, or null when decimal.js rejected it or it is Infinity/NaN.
 */
const finiteDecimal = (quote: string): Decimal | null => {
  try {
    const parsed = new Decimal(quote);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Whether the day's realised P/L has breached the loss limit. `limitQuote` of 0,
 * blank, or non-positive means the breaker is off. Breached when the realised
 * loss meets or exceeds the limit, i.e. `totalProfit <= -limit`. Malformed inputs
 * fail safe to "not breached" rather than throwing in the cron loop.
 */
export const isDailyLossBreached = (realisedPnlQuote: string, limitQuote: string): boolean => {
  const limit = finiteDecimal(limitQuote);
  const pnl = finiteDecimal(realisedPnlQuote);
  if (!limit || limit.lte(0) || !pnl) return false;
  return pnl.lte(limit.negated());
};

/** One breaker's half-open `[fromMs, toMs)` window over `trade_archive.archived_at`. */
export interface RiskWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** The daily breaker's configured limit and the window its realised P/L is summed over. */
export interface DailyWindow extends RiskWindow {
  readonly limitQuote: string;
}

/** The loss-streak guard's thresholds and the window its losing cycles are counted in. */
export interface LossStreakWindow extends RiskWindow {
  readonly maxLosingExits: number;
  readonly lookbackHours: number;
  readonly pauseHours: number;
}

/** The drawdown guard's thresholds and the window its peak-to-trough is measured over. */
export interface DrawdownWindow extends RiskWindow {
  readonly maxDrawdownQuote: string;
  readonly lookbackHours: number;
  readonly pauseHours: number;
}

/** What each breaker needs queried for one profile at one instant; a null block is a breaker the operator has left off. */
export interface RiskWindows {
  readonly daily: DailyWindow | null;
  readonly lossStreak: LossStreakWindow | null;
  readonly drawdown: DrawdownWindow | null;
}

/**
 * Turn a stored `risk_config` value into the windows each breaker must be measured over, or null per breaker when the operator has left it off.
 *
 * Pure and exported so the three window derivations are testable without a database: an off-by-a-day daily window or an hours-vs-ms slip in a lookback silently narrows a risk control to nothing, and that failure is invisible from the outside because a breaker that never trips looks exactly like a market that never lost money. A stored value that fails validation disables every breaker rather than throwing, which is fail-open on the breaker and never crashing the cron loop; the api surfaces that separately as `configInvalid`.
 *
 * @param storedRiskConfig - The raw `profiles.risk_config` jsonb value, unvalidated and possibly absent.
 * @param nowMs - The instant the cycle is evaluating at; the exclusive upper bound of all three windows.
 * @returns One entry per breaker, each null when that breaker's threshold is zero (off) or the stored config did not validate.
 */
export const resolveRiskWindows = (storedRiskConfig: unknown, nowMs: number): RiskWindows => {
  const parsed = RiskConfigSchema.safeParse(storedRiskConfig ?? {});
  if (!parsed.success) return { daily: null, lossStreak: null, drawdown: null };
  const cfg = parsed.data;

  const daily = new Decimal(cfg.dailyLossLimitQuote || '0').gt(0)
    ? { limitQuote: cfg.dailyLossLimitQuote, fromMs: startOfUtcDayMs(nowMs), toMs: nowMs }
    : null;

  const lossStreak =
    cfg.lossStreak.maxLosingExits > 0
      ? {
          ...cfg.lossStreak,
          fromMs: nowMs - cfg.lossStreak.lookbackHours * MS_PER_HOUR,
          toMs: nowMs,
        }
      : null;

  const drawdown = new Decimal(cfg.drawdown.maxDrawdownQuote || '0').gt(0)
    ? {
        ...cfg.drawdown,
        fromMs: nowMs - cfg.drawdown.lookbackHours * MS_PER_HOUR,
        toMs: nowMs,
      }
    : null;

  return { daily, lossStreak, drawdown };
};

/** The daily breaker's inputs, or null when it is off for this profile. */
export interface DailyAssessment {
  readonly limitQuote: string;
  readonly realisedPnl: string;
}

/** Loss-streak guard inputs, or null when `maxLosingExits` is 0. */
export interface LossStreakAssessment {
  readonly maxLosingExits: number;
  readonly losingExits: number;
  readonly lookbackHours: number;
  readonly pauseHours: number;
}

/** Drawdown guard inputs, or null when `maxDrawdownQuote` is 0. */
export interface DrawdownAssessment {
  readonly maxDrawdownQuote: string;
  readonly drawdownQuote: string;
  readonly lookbackHours: number;
  readonly pauseHours: number;
}

/** Everything one cron cycle needs for one profile; each breaker is null when off. */
export interface RiskAssessment {
  readonly daily: DailyAssessment | null;
  readonly lossStreak: LossStreakAssessment | null;
  readonly drawdown: DrawdownAssessment | null;
}

/**
 * Whether the loss-streak guard has tripped. `maxLosingExits <= 0` means off.
 *
 * @param a - The guard's configured threshold and the losing-cycle count from its window.
 * @returns True when the window holds at least `maxLosingExits` losing cycles, which is the point the guard pauses buys.
 */
export const isLossStreakTripped = (a: LossStreakAssessment): boolean =>
  a.maxLosingExits > 0 && a.losingExits >= a.maxLosingExits;

/**
 * Whether the drawdown guard has tripped. A non-positive or unparseable limit means off, and malformed inputs fail safe to "not tripped" for the same reason `isDailyLossBreached` does: a risk control must never throw inside the cron loop.
 *
 * @param a - The guard's configured limit and the realised peak-to-trough measured over its window, both non-negative decimal strings.
 * @returns True when the measured drawdown has reached the limit, equality included — the limit is the amount the operator said they would accept losing, so arriving at it is the trip.
 */
export const isDrawdownTripped = (a: DrawdownAssessment): boolean => {
  const limit = finiteDecimal(a.maxDrawdownQuote);
  const drawdown = finiteDecimal(a.drawdownQuote);
  if (!limit || limit.lte(0) || !drawdown) return false;
  return drawdown.gte(limit);
};

export interface PortfolioRiskDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /** Resolve every breaker's inputs for the profile as of `nowMs` (each breaker reads its own window off the stored config); null when the profile is gone. */
  readonly assess: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    nowMs: number,
  ) => Promise<RiskAssessment | null>;
  /** Set the per-profile daily entry-halt flag with a TTL (seconds) to the next UTC day. Re-set every cycle while breached, so the TTL keeps tracking the day boundary. */
  readonly setEntryHalt: (
    accountId: AccountId,
    profileId: ProfileId,
    ttlSec: number,
    value: string,
  ) => Promise<void>;
  /** Whether the daily-loss halt flag is already set (edge-trigger the alert). */
  readonly wasHalted: (accountId: AccountId, profileId: ProfileId) => Promise<boolean>;
  /** Set a guard flag ONLY if absent (SET NX EX). Resolves true when this call created it, false when a pause was already running; the pause is never extended. */
  readonly setGuardHalt: (
    accountId: AccountId,
    profileId: ProfileId,
    kind: 'loss-streak' | 'drawdown',
    ttlSec: number,
    value: string,
  ) => Promise<boolean>;
  /** Notify the operator (gated by the profile's notify_events subscription). */
  readonly notify: NotifyEvent;
  /** Optional so a test or a caller that wires no metrics still runs the cron. */
  readonly metrics?: MetricsSink;
  readonly clock?: { nowMs(): number };
}

/**
 * Claim a guard's entry-halt flag for the length of its pause, reporting whether THIS call is the one that started it.
 *
 * `NX` is what makes a pause one event rather than a repeating one. The cron re-evaluates every 30 seconds and a tripped guard is still tripped on the next cycle, so a plain `SET` would rewrite the key, answer "created" every time, and turn a 24 h pause into 2,880 operator alerts and 2,880 metric increments. It also anchors the TTL to the trip rather than letting each cycle push it forward, so the pause ends `ttlSec` after it began instead of running until the market recovers.
 *
 * Extracted from the cron's dependency wiring so both halves of that contract are reachable from a unit test: every handler test injects a stub for this, which leaves the argument list and the `'OK'` comparison — the only two things standing between one alert and thousands — with no coverage at all.
 *
 * @param redis - Redis handle narrowed to `set`, so a caller can hand in a fake without a server.
 * @param key - This guard kind's halt key for the profile, minted by `entryHaltKeys` so the tick path reads back the same name.
 * @param ttlSec - How long new buys stay paused, in seconds; the key expires with it and entries re-arm on their own.
 * @param value - The trip payload the tick path and the operator surfaces read off the flag.
 * @returns True when this call wrote the key, so the caller owns a NEW pause and should alert and count it; false when Redis declined because a pause was already running, which is the normal answer on every cycle after the first and not an error.
 */
export const claimGuardHalt = async (
  redis: Pick<Redis, 'set'>,
  key: string,
  ttlSec: number,
  value: string,
): Promise<boolean> => {
  // SET NX returns 'OK' when it wrote and null when the key already existed (a pause is already running). Null is the normal "a pause is in flight" answer, not an error.
  const res = await redis.set(key, value, 'EX', ttlSec, 'NX');
  return res === 'OK';
};

export const portfolioRiskHandler = (deps: PortfolioRiskDeps) => {
  return async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const now = clock.nowMs();
    const { errors } = await fanOutBounded<ActiveProfile, 'ok' | 'halted'>(
      deps.listActive(),
      async (profile) => {
        const a = await deps.assess(profile.operatorId, profile.accountId, profile.profileId, now);
        if (!a) return 'ok';
        let halted = false;

        if (a.daily && isDailyLossBreached(a.daily.realisedPnl, a.daily.limitQuote)) {
          const daily = a.daily;
          // The breaker re-sets the flag every cycle while breached (so the TTL
          // keeps tracking the day boundary), so notify only on the transition
          // into halt — otherwise the operator gets an alert every 30s all day.
          // Read BEFORE the write, or the write makes every cycle look like an
          // already-halted one and the operator is never told at all.
          const already = await deps.wasHalted(profile.accountId, profile.profileId);
          const ttlSec = Math.max(1, Math.ceil((nextUtcMidnightMs(now) - now) / 1000));
          await deps.setEntryHalt(
            profile.accountId,
            profile.profileId,
            ttlSec,
            JSON.stringify({
              reason: 'daily-loss-limit',
              limitQuote: daily.limitQuote,
              lossQuote: daily.realisedPnl,
              trippedAtMs: now,
            }),
          );
          deps.logger.warn(
            {
              profileId: profile.profileId,
              limitQuote: daily.limitQuote,
              realisedPnl: daily.realisedPnl,
            },
            'portfolio-risk: daily loss limit reached — new buys paused until next UTC day',
          );
          if (!already) {
            deps.metrics?.record('portfolio_risk_halt_total', 1, { kind: 'daily-loss' });
            await deps.notify({
              category: 'daily-loss-halt',
              operatorId: profile.operatorId,
              accountId: profile.accountId,
              profileId: profile.profileId,
              body: "Today's loss reached your limit. New buys are paused until 00:00 UTC (next day). Sells and exits still run.",
              // daily.realisedPnl is signed; show the magnitude so it reads "loss 50".
              fields: [
                {
                  label: "Today's loss",
                  value: asAlertAmount(new Decimal(daily.realisedPnl).abs()),
                },
                { label: 'Limit', value: asAlertAmount(daily.limitQuote) },
              ],
            });
          }
          halted = true;
        }

        if (a.lossStreak && isLossStreakTripped(a.lossStreak)) {
          const streak = a.lossStreak;
          const ttlSec = streak.pauseHours * 3600;
          const created = await deps.setGuardHalt(
            profile.accountId,
            profile.profileId,
            'loss-streak',
            ttlSec,
            JSON.stringify({
              reason: 'loss-streak',
              losingExits: streak.losingExits,
              maxLosingExits: streak.maxLosingExits,
              lookbackHours: streak.lookbackHours,
              trippedAtMs: now,
              resumesAtMs: now + ttlSec * 1000,
            }),
          );
          // Only the call that created the key is a new pause; a cycle that found one already running must stay silent, or a 24 h pause becomes 2,880 alerts.
          if (created) {
            deps.logger.warn(
              {
                profileId: profile.profileId,
                losingExits: streak.losingExits,
                maxLosingExits: streak.maxLosingExits,
                lookbackHours: streak.lookbackHours,
                pauseHours: streak.pauseHours,
              },
              'portfolio-risk: loss-streak guard tripped — new buys paused',
            );
            deps.metrics?.record('portfolio_risk_halt_total', 1, { kind: 'loss-streak' });
            await deps.notify({
              category: 'loss-guard-halt',
              operatorId: profile.operatorId,
              accountId: profile.accountId,
              profileId: profile.profileId,
              body: `${streak.losingExits} losing exits in the last ${streak.lookbackHours} h reached your limit of ${streak.maxLosingExits}. New buys are paused for ${streak.pauseHours} h. Sells and exits still run.`,
              fields: [
                { label: 'Losing exits', value: String(streak.losingExits) },
                { label: 'Limit', value: String(streak.maxLosingExits) },
                { label: 'Paused for', value: `${streak.pauseHours} h` },
              ],
            });
          }
          halted = true;
        }

        if (a.drawdown && isDrawdownTripped(a.drawdown)) {
          const drawdown = a.drawdown;
          const ttlSec = drawdown.pauseHours * 3600;
          const created = await deps.setGuardHalt(
            profile.accountId,
            profile.profileId,
            'drawdown',
            ttlSec,
            JSON.stringify({
              reason: 'drawdown',
              drawdownQuote: drawdown.drawdownQuote,
              maxDrawdownQuote: drawdown.maxDrawdownQuote,
              lookbackHours: drawdown.lookbackHours,
              trippedAtMs: now,
              resumesAtMs: now + ttlSec * 1000,
            }),
          );
          if (created) {
            deps.logger.warn(
              {
                profileId: profile.profileId,
                drawdownQuote: drawdown.drawdownQuote,
                maxDrawdownQuote: drawdown.maxDrawdownQuote,
                lookbackHours: drawdown.lookbackHours,
                pauseHours: drawdown.pauseHours,
              },
              'portfolio-risk: drawdown guard tripped — new buys paused',
            );
            deps.metrics?.record('portfolio_risk_halt_total', 1, { kind: 'drawdown' });
            await deps.notify({
              category: 'loss-guard-halt',
              operatorId: profile.operatorId,
              accountId: profile.accountId,
              profileId: profile.profileId,
              body: `Realised drawdown over the last ${drawdown.lookbackHours} h reached your limit. New buys are paused for ${drawdown.pauseHours} h. Sells and exits still run.`,
              fields: [
                { label: 'Drawdown', value: asAlertAmount(drawdown.drawdownQuote) },
                { label: 'Limit', value: asAlertAmount(drawdown.maxDrawdownQuote) },
                { label: 'Paused for', value: `${drawdown.pauseHours} h` },
              ],
            });
          }
          halted = true;
        }

        return halted ? 'halted' : 'ok';
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
      metrics: ctx.metrics,
      assess: async (operatorId, accountId, profileId, nowMs) => {
        const repo = await profileRepo(ctx.db, operatorId, accountId, profileId);
        const row = await repo.profile.findById();
        if (!row) return null;
        const windows = resolveRiskWindows((row as { riskConfig?: unknown }).riskConfig, nowMs);
        // Every figure is counted in the quote each limit is denominated in, or a breaker would compare a limit against a total in some other currency.
        const quote = row.quoteAsset;

        let daily: DailyAssessment | null = null;
        if (windows.daily) {
          const { totalProfit } = await repo.tradeArchive.sumProfitInRange(
            quote,
            new Date(windows.daily.fromMs),
            new Date(windows.daily.toMs),
          );
          daily = { limitQuote: windows.daily.limitQuote, realisedPnl: totalProfit };
        }

        let lossStreak: LossStreakAssessment | null = null;
        if (windows.lossStreak) {
          const w = windows.lossStreak;
          const losingExits = await repo.tradeArchive.countLosingCyclesInRange(
            quote,
            new Date(w.fromMs),
            new Date(w.toMs),
          );
          lossStreak = {
            maxLosingExits: w.maxLosingExits,
            lookbackHours: w.lookbackHours,
            pauseHours: w.pauseHours,
            losingExits,
          };
        }

        let drawdown: DrawdownAssessment | null = null;
        if (windows.drawdown) {
          const w = windows.drawdown;
          const drawdownQuote = await repo.tradeArchive.maxRealisedDrawdownInRange(
            quote,
            new Date(w.fromMs),
            new Date(w.toMs),
          );
          drawdown = {
            maxDrawdownQuote: w.maxDrawdownQuote,
            lookbackHours: w.lookbackHours,
            pauseHours: w.pauseHours,
            drawdownQuote,
          };
        }

        return { daily, lossStreak, drawdown };
      },
      setEntryHalt: async (accountId, profileId, ttlSec, value) => {
        await ctx.redis.set(
          entryHaltKeys({ accountId, profileId })['daily-loss'],
          value,
          'EX',
          ttlSec,
        );
      },
      wasHalted: async (accountId, profileId) =>
        (await ctx.redis.exists(entryHaltKeys({ accountId, profileId })['daily-loss'])) === 1,
      setGuardHalt: (accountId, profileId, kind, ttlSec, value) =>
        claimGuardHalt(ctx.redis, entryHaltKeys({ accountId, profileId })[kind], ttlSec, value),
      notify: ctx.notifyEvent,
    }),
  });
