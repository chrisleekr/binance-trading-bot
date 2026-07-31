import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import { asAccountId, asProfileId } from '@app/contracts';

import { createSymbolReconcileEnqueue } from '../../src/queues/symbol-reconcile-enqueue.js';

const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const REQUEST = {
  accountId: ACCOUNT,
  profileId: PROFILE,
  symbol: 'WLDUSDT',
  cause: 'place-2010-insufficient',
} as const;

describe('createSymbolReconcileEnqueue', () => {
  it('coalesces by a static jobId AND removes at terminal state, so the slot reopens', async () => {
    // Regression, and the whole mechanism rests on it. BullMQ rejects an .add()
    // whose jobId exists in ANY state, INCLUDING the retained completed/failed
    // sets. With a count- or age-based retention the terminal job keeps occupying
    // `reconcile-symbol:<pid>:<sym>` forever, so the FIRST reconcile for a
    // (profile, symbol) runs and every later one is silently dropped — BullMQ
    // returns the existing job id rather than throwing, so nothing upstream can
    // detect it. Boolean retention is what frees the slot.
    const queue = { add: vi.fn(async () => ({ id: 'j1' })) } as unknown as Queue;

    await createSymbolReconcileEnqueue(queue)(REQUEST);

    expect(queue.add).toHaveBeenCalledWith(
      'reconcile-symbol',
      {
        accountId: ACCOUNT,
        profileId: PROFILE,
        symbol: 'WLDUSDT',
        cause: 'place-2010-insufficient',
      },
      {
        jobId: `reconcile-symbol:${PROFILE}:WLDUSDT`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });

  it('a later enqueue for the same (profile, symbol) is a fresh add, not a swallowed one', async () => {
    // The producer never suppresses: coalescing is BullMQ's job (while waiting or
    // active) and the 60s window's job (in the throttle wrapper). Once the first
    // job reaches a terminal state and its slot is freed, the next discovery for
    // that pair MUST reach the queue — otherwise the targeted converge path fires
    // exactly once per (profile, symbol) per worker lifetime.
    const queue = { add: vi.fn(async () => ({ id: 'j1' })) } as unknown as Queue;
    const enqueue = createSymbolReconcileEnqueue(queue);

    await enqueue(REQUEST);
    await enqueue(REQUEST);

    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
