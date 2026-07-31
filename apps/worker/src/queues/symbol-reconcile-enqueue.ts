// The raw `symbol-reconcile` producer. Extracted from the boot wiring so the job
// options — which are load-bearing, not cosmetic — can be asserted in a unit test.

import type { Queue } from 'bullmq';
import type { AccountId, ProfileId } from '@app/contracts';
import { unwrapId } from '@app/contracts';

import type { SymbolReconcileCause, SymbolReconcileJobData } from 'queues/job-payloads.js';
import { symbolReconcileJobId } from 'queues/queue-names.js';

export interface SymbolReconcileRequest {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly cause: SymbolReconcileCause;
}

/**
 * Boolean retention is REQUIRED here, not a housekeeping preference.
 *
 * BullMQ rejects an `.add()` whose jobId already exists in ANY state — the
 * retained `completed` / `failed` sets included. The static jobId gives us
 * in-flight coalescing (N discoveries for one (profile, symbol) collapse into one
 * converge pass), but with a count- or age-based retention the terminal job keeps
 * occupying the id and the slot NEVER reopens: the first reconcile for a pair
 * would run and every later one would be silently dropped (BullMQ emits
 * `duplicated` and returns the existing id — it does not throw, so nothing
 * upstream can notice). Removing at terminal state is what reopens the slot.
 */
export const SYMBOL_RECONCILE_JOB_OPTS = {
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export const createSymbolReconcileEnqueue =
  (queue: Queue) =>
  async (input: SymbolReconcileRequest): Promise<void> => {
    const data: SymbolReconcileJobData = {
      accountId: unwrapId(input.accountId),
      profileId: unwrapId(input.profileId),
      symbol: input.symbol,
      cause: input.cause,
    };
    await queue.add('reconcile-symbol', data, {
      jobId: symbolReconcileJobId(data.profileId, data.symbol),
      ...SYMBOL_RECONCILE_JOB_OPTS,
    });
  };
