import { EntryHaltKind, nextUtcMidnightMs, type AccountId, type ProfileId } from '@app/contracts';
import { entryHaltKeys } from '@app/db';
import type { DI } from 'di.js';

/**
 * Which of the profile's entry breakers are pausing new buys right now, and when each lifts.
 *
 * Each flag is a Redis key the portfolio-risk cron sets — the daily-loss breaker when the profile's realised loss for the UTC day hits its limit, the two guards when their rolling window trips — and each self-clears via its own TTL. Three api surfaces read them through this function (the risk card, the account-health bar, and the pre-flight on a BUY-side operator action), so the lift arithmetic lives here rather than being hand-rolled three times; the key names themselves come from `entryHaltKeys` in `@app/db`, which the worker's diagnosis gather reads directly for the same flags.
 *
 * Throws on a Redis fault, rather than answering "not halted" it cannot stand behind: a display surface that renders "not halted" when it does not know misstates the operator's risk. Each caller then picks its own degradation — the risk card surfaces the error, the account-health bar OMITS the profile from `halts` (it is not reported un-halted, but neither is the read failure surfaced in the response), and the BUY-side action pre-flight fails open via {@link firstEntryHaltFailOpen}.
 *
 * @param di - Request DI, for the raw Redis handle.
 * @param scope - The account and profile whose flags to read.
 * @param nowMs - The instant to measure lift times from; passed in so a caller can share one clock reading across several profiles.
 * @returns One entry per active breaker in `EntryHaltKind` order, each with the epoch ms at which that breaker stops pausing buys. Empty when nothing is halted.
 */
export const activeEntryHalts = async (
  di: DI,
  scope: { readonly accountId: AccountId; readonly profileId: ProfileId },
  nowMs: number,
): Promise<ReadonlyArray<{ kind: EntryHaltKind; liftsAtMs: number }>> => {
  const redis = di.redis.raw();
  const keys = entryHaltKeys(scope);
  const out: Array<{ kind: EntryHaltKind; liftsAtMs: number }> = [];
  for (const kind of EntryHaltKind.options) {
    const pttl = await redis.pttl(keys[kind]);
    // PTTL is -2 when the key is absent and -1 when it is present without an expiry. Every halt key is written with a TTL, so a -1 is a flag that has lost its expiry and is treated as "lifts now" rather than "never lifts": telling the operator buying resumes at the epoch is the worse lie.
    if (pttl === -2) continue;
    out.push({
      kind,
      // The daily flag's TTL only approximates the day boundary; the boundary itself is the truth about when it lifts.
      liftsAtMs: kind === 'daily-loss' ? nextUtcMidnightMs(nowMs) : nowMs + Math.max(0, pttl),
    });
  }
  return out;
};

/**
 * The breaker to name in a refusal, degraded to "none active" on a Redis fault.
 *
 * Only the BUY-side action pre-flight uses this. Be clear about what that costs: the entry breakers are FAIL-OPEN AT BOTH TIERS. The flags live in Redis, so a Redis fault blinds the api pre-flight here AND the worker's own tick-path filter (which returns the decisions unfiltered on a read error, precisely so a flag-read blip can never block an exit or a protective stop). On a Redis fault the breakers therefore hold nowhere, and a BUY the operator asks for goes out.
 *
 * That is accepted, not overlooked: there is no safer place to put the flags (they ARE Redis), the actor is the single authenticated operator, and the alternative — refusing every action while Redis is down — would also refuse the exits that matter far more than the breakers do. A display surface must NOT use this.
 *
 * @param di - Request DI, for the raw Redis handle and the warn log.
 * @param scope - The account and profile whose flags to read.
 * @returns The first active breaker kind in `EntryHaltKind` order, or null when nothing is active OR the read failed.
 */
export const firstEntryHaltFailOpen = async (
  di: DI,
  scope: { readonly accountId: AccountId; readonly profileId: ProfileId },
): Promise<EntryHaltKind | null> => {
  try {
    const halts = await activeEntryHalts(di, scope, Date.now());
    return halts[0]?.kind ?? null;
  } catch (err) {
    di.logger.warn(
      { profileId: scope.profileId, err: err },
      'entry breaker flag read failed — allowing the action; the tick still enforces the halt',
    );
    return null;
  }
};
