// The raw `reconfigure-profile` producer. The job name, payload shape, and
// options are all load-bearing, so they are asserted in a co-located unit test.
// The pipeline worker's parseProfileJob REQUIRES userId, accountId, AND profileId;
// a payload missing any of them fails the job as `pipeline_invalid_payload` and
// dead-letters, so the resync never runs and the WS keeps feeding a symbol it
// should have dropped — loudly, rather than as a silent no-op.
//
// Lives in @app/core so both apps/worker (boot wiring, discovery.cron) and
// apps/api (the symbols/profiles/orphan-orders mutation routes) enqueue through
// one producer instead of hand-rolling `queue.add('reconfigure-profile', ...)`.
// The branded ReconfigureProfileRequest then makes a dropped accountId a
// compile error at every call site.

import type { Queue } from 'bullmq';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

export interface ReconfigureProfileRequest {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
}

// No static jobId: every symbol mutation enqueues its own resync and a static id
// would let BullMQ dedupe successive ones (the retained terminal job keeps the id,
// so later resyncs drop silently). Shared by the API producers and discovery.cron.
export const RECONFIGURE_PROFILE_JOB_OPTS = {
  removeOnComplete: true,
  removeOnFail: { count: 1_000 },
} as const;

export const createReconfigureEnqueue =
  (queue: Queue) =>
  async ({ userId, accountId, profileId }: ReconfigureProfileRequest): Promise<void> => {
    await queue.add(
      'reconfigure-profile',
      { userId, accountId, profileId },
      RECONFIGURE_PROFILE_JOB_OPTS,
    );
  };
