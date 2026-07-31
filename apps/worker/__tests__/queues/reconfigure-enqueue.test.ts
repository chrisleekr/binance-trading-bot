import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import {
  createReconfigureEnqueue,
  RECONFIGURE_PROFILE_JOB_OPTS,
} from '../../src/queues/reconfigure-enqueue.js';
import { parseProfileJob } from '../../src/queues/pipeline-worker.js';

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

  it('produces a payload the pipeline worker accepts — a dropped field would no-op the resync', async () => {
    // The seam guard. parseProfileJob is the consumer contract; if this producer
    // ever drops accountId (or a field is added to the required set) the resync is
    // silently discarded as pipeline_invalid_payload and the WS keeps feeding a
    // symbol it should have dropped. Round-trip the exact payload through the real
    // parser so producer and consumer cannot drift apart unnoticed.
    let captured: unknown;
    const queue = {
      add: vi.fn(async (_name: string, data: unknown) => {
        captured = data;
        return { id: 'j1' };
      }),
    } as unknown as Queue;

    await createReconfigureEnqueue(queue)(REQUEST);

    expect(parseProfileJob(captured)).toEqual({
      userId: USER,
      accountId: ACCOUNT,
      profileId: PROFILE,
    });
  });

  it('omits a static jobId so successive resyncs are not deduped', () => {
    // No jobId in the opts: every symbol mutation must reach the queue. A static id
    // with count/age retention would let the retained terminal job occupy the slot
    // and silently drop later resyncs.
    expect(RECONFIGURE_PROFILE_JOB_OPTS).not.toHaveProperty('jobId');
    expect(RECONFIGURE_PROFILE_JOB_OPTS).toEqual({
      removeOnComplete: true,
      removeOnFail: { count: 1_000 },
    });
  });
});
