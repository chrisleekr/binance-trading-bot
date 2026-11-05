// Runtime teardown for a profile that is going away (deleted directly, or taken
// by an account's delete cascade). Two effects, and the job convention behind the
// second one lives HERE, once: the queue name, the payload shape, and the
// coalescing `jobId` were duplicated at each delete site, which is how a rename
// silently half-lands.
//
// The profile delete no longer comes through here at all: it is a DISPOSAL now (the
// worker cancels on Binance, re-verifies, then wipes Redis and deletes the row, in
// that order). What remains is the ACCOUNT delete's cascade cleanup, which runs
// AFTER the cascade commits because it must enumerate the profiles the cascade is
// about to remove.

import { unsubscribeJobId } from '@app/core/queue';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Queue } from 'bullmq';
import type { ScopedRedis } from '@app/db';
import { wipeProfileRedis } from 'redis-helpers.js';

export interface ProfileTeardownTarget {
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
}

/**
 * Tell the worker to tear down this profile's in-memory subscription and its WebSocket streams. The handler re-reads DB truth — a deleted row maps to teardown, so a missed job self-heals on the next fleet reconcile rather than leaking a stream. The static `jobId` coalesces duplicate enqueues while one job is waiting or active, and the boolean retention frees the id at terminal state, otherwise a later teardown for the same id would be dropped.
 * @param queue - The pipeline queue the worker consumes `unsubscribe-profile` from.
 * @param target - Identifies the profile whose subscription the worker should tear down; the ids ride the job payload.
 */
const enqueueProfileUnsubscribe = async (
  queue: Queue,
  { operatorId, accountId, profileId }: ProfileTeardownTarget,
): Promise<void> => {
  await queue.add(
    'unsubscribe-profile',
    { userId: operatorId, accountId, profileId },
    { jobId: unsubscribeJobId(profileId), removeOnComplete: true, removeOnFail: true },
  );
};

/**
 * The full runtime teardown: drop the profile's cached Redis state, then stop the
 * worker from streaming for it. Stale per-profile keys outlive the DB rows unless
 * wiped, and a re-created profile would boot on another profile's cached state.
 * @param deps - The scoped Redis used for the wipe and the pipeline queue used for the unsubscribe job.
 * @param target - Identifies the profile being torn down; its account id scopes the Redis wipe.
 */
export const teardownProfileRuntime = async (
  deps: { readonly redis: ScopedRedis; readonly queue: Queue },
  target: ProfileTeardownTarget,
): Promise<void> => {
  await wipeProfileRedis(deps.redis, target.accountId, target.profileId);
  await enqueueProfileUnsubscribe(deps.queue, target);
};
