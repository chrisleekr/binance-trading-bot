import { z } from 'zod';
import { DecimalString } from './decimal.js';

/**
 * The worker's liveness, derived from its Redis heartbeat. The worker rewrites
 * `worker:status` every ~60s under a 120s TTL, so the key being present IS the
 * liveness signal: present and well-formed → `live`; absent or malformed →
 * `down` (the operator should restart the worker). `sha`/`bootedAt` describe the
 * running build for a deploy-mismatch check.
 */
export const AccountHealthWorker = z.object({
  status: z.enum(['live', 'down']),
  sha: z.string().nullable(),
  bootedAt: z.iso.datetime().nullable(),
});
export type AccountHealthWorker = z.infer<typeof AccountHealthWorker>;

/** One active halt on one profile — the "is the bot silently paused" detail. */
export const AccountHealthHalt = z.object({
  profileId: z.uuid(),
  name: z.string(),
  /** `daily-loss` = the daily-loss breaker (the only breaker that pauses buys). */
  kind: z.enum(['daily-loss']),
});
export type AccountHealthHalt = z.infer<typeof AccountHealthHalt>;

/**
 * Realized P/L since 00:00 UTC, summed per (quoteAsset, mode). This is the gross
 * realized sum (the daily-loss breaker keys off the same gross figure, so the
 * headline and the "about to trip" reading share one basis). Summed on the
 * server because the web has no decimal.js. `test` and `live` are kept apart so
 * practice P/L never lands in the real-money headline.
 */
export const AccountHealthTodayRealized = z.object({
  quoteAsset: z.string(),
  binanceMode: z.enum(['test', 'live']),
  realizedQuote: DecimalString,
});
export type AccountHealthTodayRealized = z.infer<typeof AccountHealthTodayRealized>;

/**
 * A live profile whose loss so far today has reached the warning band of its
 * daily-loss limit but has not tripped yet — the "about to trip the breaker"
 * signal. `lossQuote` is signed (negative).
 */
export const AccountHealthApproachingLimit = z.object({
  profileId: z.uuid(),
  name: z.string(),
  lossQuote: DecimalString,
  limitQuote: DecimalString,
});
export type AccountHealthApproachingLimit = z.infer<typeof AccountHealthApproachingLimit>;

/**
 * Response for `GET /account/health` — the always-visible "is my money OK right
 * now" surface: is the worker alive, is anything silently paused, how is today
 * going, and is any profile about to trip its breaker. Account-level (all the
 * operator's profiles), not profile-scoped. Display-ready: the server does the
 * money math.
 */
export const AccountHealthResponse = z.object({
  asOf: z.iso.datetime(),
  worker: AccountHealthWorker,
  halts: z.array(AccountHealthHalt),
  todayRealized: z.array(AccountHealthTodayRealized),
  approachingLimit: z.array(AccountHealthApproachingLimit),
});
export type AccountHealthResponse = z.infer<typeof AccountHealthResponse>;
