import { type AccountId, type ProfileId } from '@app/contracts';
import { profileKey } from '@app/db';
import type { DI } from 'di.js';

/**
 * Is the profile's daily-loss breaker armed right now?
 *
 * The flag is a Redis key the portfolio-risk cron sets when the profile's
 * realised loss for the UTC day hits its limit; it self-clears at the next UTC
 * day. Three surfaces read it — the risk card, the account-health bar, and the
 * pre-flight on a BUY-side operator action — so the key name lives here rather
 * than being hand-rolled thrice.
 *
 * Throws on a Redis fault, rather than answering "not halted" it cannot stand
 * behind: a display surface that renders "not halted" when it does not know
 * misstates the operator's risk. Each caller then picks its own degradation —
 * the risk card surfaces the error, the account-health bar OMITS the profile
 * from `halts` (it is not reported un-halted, but neither is the read failure
 * surfaced in the response), and the BUY-side action pre-flight fails open via
 * {@link isEntryHaltedFailOpen}.
 */
export const isEntryHalted = async (
  di: DI,
  scope: { readonly accountId: AccountId; readonly profileId: ProfileId },
): Promise<boolean> => (await di.redis.raw().exists(profileKey(scope, 'entryHaltDaily'))) > 0;

/**
 * {@link isEntryHalted}, degraded to "not halted" on a Redis fault.
 *
 * Only the BUY-side action pre-flight uses this. Be clear about what that costs:
 * the daily-loss breaker is FAIL-OPEN AT BOTH TIERS. The flag lives in Redis, so
 * a Redis fault blinds the api pre-flight here AND the worker's own tick-path
 * filter (which returns the decisions unfiltered on a read error, precisely so a
 * flag-read blip can never block an exit or a protective stop). On a Redis fault
 * the breaker therefore holds nowhere, and a BUY the operator asks for goes out.
 *
 * That is accepted, not overlooked: there is no safer place to put the flag (it
 * IS Redis), the actor is the single authenticated operator, and the alternative
 * — refusing every action while Redis is down — would also refuse the exits that
 * matter far more than the breaker does. A display surface must NOT use this.
 */
export const isEntryHaltedFailOpen = async (
  di: DI,
  scope: { readonly accountId: AccountId; readonly profileId: ProfileId },
): Promise<boolean> => {
  try {
    return await isEntryHalted(di, scope);
  } catch (err) {
    di.logger.warn(
      { profileId: scope.profileId, err: err },
      'daily-loss breaker flag read failed — allowing the action; the tick still enforces the halt',
    );
    return false;
  }
};
