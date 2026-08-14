// Declarative cron definition.
//
// Each cron is one `defineCron(...)` call that bundles its schedule
// metadata with the already-bound BullMQ handler. The boot phase
// constructs the per-cron deps at the def's call site (no central
// `RegisterCronsDeps` god-union) and passes the array to
// `registerCronsFromDefs`, which is a pure iterate-and-register loop.
//
// Adding a cron after this refactor: one new `defineCron` call + push
// into the array. No switch case to keep in sync, no per-cron `*Deps`
// field on a registry-wide interface to grow.

import type { Job } from 'bullmq';
import type { QueueName } from 'queues/queue-names.js';

/**
 * Closed set of cron names. Constrains `CronDef.name` so a typo here is a
 * tsc error instead of a "scheduler upserted under the wrong Redis key,
 * jobs never fire on this name" silent runtime failure (the only signal
 * would be a missing BullMQ scheduler — invisible until the next outage
 * investigation). Adding a cron = appending its name here.
 */
export type CronName =
  | 'alive'
  | 'technicals-compute'
  | 'daily-ath'
  | 'exchange-info-refresh'
  | 'account-snapshot-safety'
  | 'dust-snapshot'
  | 'equity-snapshot'
  | 'equity-snapshot-prune'
  | 'action-log-prune'
  | 'audit-prune'
  | 'discovery-snapshot-prune'
  | 'discovery-run'
  | 'discovery-health'
  | 'market-trend'
  | 'orphan-orders-detect'
  | 'detached-orders-reconcile'
  | 'held-quantity-reconcile'
  | 'archive-recovery-sweep'
  | 'stale-order-reap'
  | 'portfolio-risk'
  | 'edge-decay-monitor'
  | 'backtest-sweep'
  | 'db-backup';

/**
 * Schedule + handler bundle. `queue` is constrained to known queue names
 * so a typo here surfaces as a tsc error rather than a runtime "queue
 * not in QUEUE_NAMES" failure that the previous switch-dispatch path
 * could only catch by throwing at boot.
 */
export interface CronDef {
  readonly name: CronName;
  readonly queue: QueueName;
  /**
   * Cron pattern for a fixed-cadence BullMQ Job Scheduler. Mutually exclusive
   * with {@link selfReschedulePeriodMs}; exactly one must be set.
   */
  readonly pattern?: string;
  /**
   * Self-rescheduling cadence in ms (target start-to-start period). Use this
   * instead of {@link pattern} when the handler's worst-case runtime can
   * approach or exceed the cadence: a fixed-cadence scheduler mints a fresh
   * iteration regardless of whether the previous finished, so overlapping runs
   * backlog and the scheduler eventually wedges (#361). Self-rescheduling
   * enqueues the next run only on the current run's terminal state, so
   * iterations can never overlap. The next delay is `max(0, period - runtime)`,
   * so the cadence holds when runs are fast and collapses to back-to-back
   * (never overlapping) when a run overruns the period.
   */
  readonly selfReschedulePeriodMs?: number;
  /** Bound BullMQ handler — closes over its own deps at the def site. */
  readonly handler: (job: Job) => Promise<void>;
}

/** Identity helper so authors get IDE completion on the literal. */
export const defineCron = (d: CronDef): CronDef => d;
