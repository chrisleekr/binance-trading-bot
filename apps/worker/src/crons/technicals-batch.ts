// Batch-cadence aggregator for the technicals-compute cron.
//
// Profiles each subscribe to one or more (interval, symbols[]) Technicals
// rows. The 30s cron walks every active profile and emits one job per
// distinct interval whose `symbols` field is the union across profiles.
// Per the trailing-trade plugin's contract, a 1m candle is the strategy's
// finest resolution, so colliding intervals across profiles need exactly
// one compute call each — not one per profile.
//
// Pure function. Worker code wires inputs from `repo.profiles.listForUser`
// and feeds outputs into BullMQ `add(jobId, data)`; the function itself
// has no I/O so it lives alongside `cron-config.ts` and is unit-tested
// in isolation.

import { technicalsJobId } from 'queues/queue-names.js';

/**
 * One Technicals subscription on a profile. Generic over the snapshot
 * shape: the trailing-trade plugin (and any future strategy plugin)
 * stores its Technicals subscriptions inside its strategy-config bundle,
 * but the aggregator only needs the (interval, symbols) tuple. Keeping
 * the input shape narrow here so a future schema change in the plugin
 * doesn't ripple into this module.
 */
export interface ProfileTechnicalsView {
  readonly interval: string;
  readonly symbols: readonly string[];
}

/**
 * The aggregator's input row. `profileId` is carried for downstream
 * tracing; the aggregator itself does not branch on it.
 */
export interface ProfileTechnicalsSubscription {
  readonly profileId: string;
  readonly technicals: readonly ProfileTechnicalsView[];
}

/**
 * One emitted job. `symbols` is the per-interval union of every
 * subscribing profile's symbols, sorted so the jobId-equivalent inputs
 * across replicas produce a byte-identical payload (and BullMQ's job
 * deduplication picks up).
 */
export interface TechnicalsBatchJob {
  readonly jobId: string;
  readonly interval: string;
  readonly symbols: readonly string[];
}

/**
 * Aggregate per-profile Technicals subscriptions into one job per
 * distinct interval, with the symbol set unioned across profiles.
 *
 * `bucket30s` is the 30-second tick counter (`floor(now / 30_000)`).
 * Including it in the jobId means BullMQ coalesces re-fires of the
 * same tick (e.g. cluster failover within a 30s window) onto a single
 * compute call. The jobId format comes from {@link technicalsJobId}
 * and intentionally excludes a per-minute fragment — that resolution
 * would split a compute call into 60× more jobs while the 30s tick
 * is the only cadence the cron actually drives.
 *
 * Sort orders are stable: intervals are emitted in first-seen order
 * (which matches the operator's subscription order), and symbols
 * inside each job are sorted lexicographically so cluster replicas
 * compute the same payload bytes for the same inputs.
 */
export const buildTechnicalsJobs = (
  profiles: readonly ProfileTechnicalsSubscription[],
  bucket30s: number,
): readonly TechnicalsBatchJob[] => {
  const byInterval = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const view of profile.technicals) {
      let bucket = byInterval.get(view.interval);
      if (bucket === undefined) {
        bucket = new Set<string>();
        byInterval.set(view.interval, bucket);
      }
      for (const symbol of view.symbols) {
        bucket.add(symbol);
      }
    }
  }
  const out: TechnicalsBatchJob[] = [];
  for (const [interval, symbols] of byInterval) {
    if (symbols.size === 0) continue;
    out.push({
      jobId: technicalsJobId(interval, bucket30s),
      interval,
      symbols: [...symbols].sort(),
    });
  }
  return out;
};
