// The durable note that a profile's discovery cycle refused to rank, and every touch of it.
//
// Its own module rather than closures in the cron, because the guarantees here are the ones a test has to be able to state: the record keeps the START of a run of refusals across rewrites, and nothing here ever rejects. The second is load-bearing — the handler calls `record` from inside its per-profile catch, where a rejection would escape the catch and the loop, so a Redis blip would cost the whole wake instead of one diagnostic write.
//
// The reader lives here too, beside the writer whose format it has to agree with. Two readers of one plain Redis value drift the moment either side's parsing changes, and a diagnosis that disagrees with the monitor about whether a profile aborted is worse than either answer alone.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  assetPolicyAbortRecordSchema,
  type AssetPolicyAbortCause,
  type AssetPolicyAbortRecord,
} from '@app/contracts';
import { DISCOVERY_ASSET_POLICY_ABORT_TTL_S, GLOBAL_KEYS } from '@app/db';

/** The two writes the discovery handler makes against the parked refusal. */
export interface AssetPolicyAbortRecordStore {
  /**
   * Park a refusal, or extend the one already parked.
   *
   * Read-modify-write, so a run of refusals keeps the time it STARTED: an unchanged cause carries the existing `firstAtMs` forward, and a different cause starts a new run. Safe without a lock — the cron self-reschedules, its per-profile loop is sequential, and the atomic last-run gate admits at most one cycle per profile per refresh period, so two wakes cannot be inside this for the same profile at once.
   *
   * @param profileId - Unwrapped profile id, the subject of the refusal and the key's only variable.
   * @param cause - Which classification check refused; a change of cause is what ends one run and starts the next.
   * @param atMs - When this refusal happened, epoch ms, taken from the handler's clock rather than read here.
   */
  record(profileId: string, cause: AssetPolicyAbortCause, atMs: number): Promise<void>;
  /**
   * Drop the parked refusal because a cycle completed.
   *
   * @param profileId - Unwrapped profile id whose record is retired.
   */
  clear(profileId: string): Promise<void>;
}

/**
 * Read the parked record's start time when it belongs to the SAME run of refusals.
 *
 * Its own function so a value that does not parse cannot abort the write: a JSON throw inside the write's try/catch would be swallowed as a failed write, leaving the unreadable value in place until its TTL and the finding unrenderable for a day.
 *
 * @param raw - Whatever is currently at the key, or null when nothing is parked.
 * @param cause - The cause being written now; a different one ends the previous run rather than extending it.
 * @returns The start time to carry forward, or null when there is no run to continue.
 */
const carriedStart = (raw: string | null, cause: AssetPolicyAbortCause): number | null => {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = assetPolicyAbortRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.cause !== cause) return null;
  return parsed.data.firstAtMs ?? parsed.data.atMs;
};

/**
 * Read the parked refusal for one profile, or null when there is nothing trustworthy to read.
 *
 * Fail-soft on every arm, and a free function rather than a method on {@link AssetPolicyAbortRecordStore} because its two callers hold different halves of Redis: the diagnosis gather is typed for reads only, and the health monitor wants the answer without the writes. Both consequences of a null are safe — the diagnosis judges the profile on staleness alone, and the monitor alerts as it would have anyway — so an unreadable value must never become a rejection either caller has to handle.
 *
 * @param redis - Client for the record's GET; nothing else is touched.
 * @param logger - Where an unreadable or unparseable value is reported before it degrades to null.
 * @param profileId - Unwrapped profile id, the key's only variable.
 * @returns The parked refusal with its cause and times, or null when none is parked or the value could not be trusted.
 */
export const readAssetPolicyAbortRecord = async (
  redis: Pick<Redis, 'get'>,
  logger: Logger,
  profileId: string,
): Promise<AssetPolicyAbortRecord | null> => {
  try {
    const raw = await redis.get(GLOBAL_KEYS.discoveryAssetPolicyAbort(profileId));
    if (raw === null) return null;
    const parsed = assetPolicyAbortRecordSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger.warn(
      { profileId, err: parsed.error },
      'asset-policy abort record: value did not parse; it reads as absent',
    );
    return null;
  } catch (err) {
    logger.warn({ profileId, err }, 'asset-policy abort record: read failed; it reads as absent');
    return null;
  }
};

/**
 * Build the two ports over a Redis handle.
 *
 * @param redis - Client for the record's GET/SET/DEL. Nothing else in the store touches Redis.
 * @param logger - Where a failed write goes. A failure is logged and swallowed, because the alternative is a diagnostic write taking down a trading cron.
 * @returns The `record` / `clear` pair the discovery handler is wired with.
 */
export const createAssetPolicyAbortRecordStore = (
  redis: Pick<Redis, 'get' | 'set' | 'del'>,
  logger: Logger,
): AssetPolicyAbortRecordStore => ({
  record: async (profileId, cause, atMs) => {
    const key = GLOBAL_KEYS.discoveryAssetPolicyAbort(profileId);
    // The read has its own boundary, because the two commands cost different things when they fail. A failed read costs the run's start time and nothing else; sharing the write's try would jump past the SET and park no record at all, which is the silence this record exists to end. An unparseable or differently-caused record is likewise not this run's history, so it is replaced outright rather than mined for a start time it cannot vouch for.
    let existing: string | null = null;
    try {
      existing = await redis.get(key);
    } catch (err) {
      logger.warn(
        { profileId, cause, err },
        'cron discovery: asset-policy abort record read failed; the abort is parked, dated from this cycle',
      );
    }
    try {
      // A whole-value SET, which drops the previous TTL and starts a fresh one. That is the intent: the record must outlive the longest legal gap between cycles counted from the LAST refusal, not from the first one.
      await redis.set(
        key,
        JSON.stringify({ cause, atMs, firstAtMs: carriedStart(existing, cause) ?? atMs }),
        'EX',
        DISCOVERY_ASSET_POLICY_ABORT_TTL_S,
      );
    } catch (err) {
      logger.warn(
        { profileId, cause, err },
        'cron discovery: asset-policy abort record write failed; the abort stays metric-only',
      );
    }
  },
  clear: async (profileId) => {
    try {
      await redis.del(GLOBAL_KEYS.discoveryAssetPolicyAbort(profileId));
    } catch (err) {
      logger.warn(
        { profileId, err },
        'cron discovery: asset-policy abort record clear failed; the finding self-expires',
      );
    }
  },
});
