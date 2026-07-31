import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import {
  createReconfigureEnqueue,
  RECONFIGURE_PROFILE_JOB_OPTS,
} from '../../src/queue/reconfigure-enqueue.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000cc');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const REQUEST = { userId: USER, accountId: ACCOUNT, profileId: PROFILE } as const;

describe('createReconfigureEnqueue', () => {
  it('enqueues reconfigure-profile with the full {userId, accountId, profileId} payload and resync opts', async () => {
    const queue = { add: vi.fn(async () => ({ id: 'j1' })) } as unknown as Queue;

    await createReconfigureEnqueue(queue)(REQUEST);

    expect(queue.add).toHaveBeenCalledWith(
      'reconfigure-profile',
      { userId: USER, accountId: ACCOUNT, profileId: PROFILE },
      RECONFIGURE_PROFILE_JOB_OPTS,
    );
  });

  it('omits a static jobId so successive resyncs are not deduped', () => {
    // A static id with retention would let the retained terminal job occupy the
    // slot and silently drop later resyncs, so every mutation must enqueue freshly.
    expect(RECONFIGURE_PROFILE_JOB_OPTS).not.toHaveProperty('jobId');
    expect(RECONFIGURE_PROFILE_JOB_OPTS).toEqual({
      removeOnComplete: true,
      removeOnFail: { count: 1_000 },
    });
  });
});
