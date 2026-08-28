// technicals-compute cron.
//
// Fetches klines from Binance for every active (symbol, interval) and
// runs the Technical Ratings math in-process. The 10-min Redis TTL only
// bounds memory if the cron stops; the strategy's technicals gate
// enforces its own freshness window.
//
// Per-interval batches are awaited serially with a short jittered gap so
// back-to-back batches against the same IP don't land in the same
// Binance rate-limit bucket. The cron is self-rescheduling (its next run is
// enqueued only after the current one finishes) so a slow run delays the next
// rather than overlapping it.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { unwrapId } from '@app/contracts';
import { sleep as _defaultSleep } from '@app/core/sleep';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { buildTechnicalsJobs } from './technicals-batch.js';
import { createFetchAndCache } from './technicals-compute.js';

export interface TechnicalsComputeDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly fetchAndCache: (interval: string, symbols: readonly string[]) => Promise<void>;
  readonly clock?: { nowMs(): number };
  /**
   * Jittered delay between consecutive per-interval batches in a single
   * cron tick. The batches are awaited serially anyway, but Binance's
   * public klines endpoint applies per-IP rate-limits in a burst window —
   * back-to-back batches against the same IP can land in the same bucket.
   * A short randomised gap (default 200–600 ms) spreads the load profile
   * across a fraction of a second without meaningfully delaying the
   * strategy gate (still finishes well inside the 30 s cron cadence).
   * Injected so tests can pass a deterministic no-op gap.
   */
  readonly intervalGapMs?: () => number;
  /** Injected sleep; tests pass a no-op to keep determinism. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const _defaultIntervalGapMs = (): number => 200 + Math.floor(Math.random() * 400);

export const technicalsComputeHandler =
  (deps: TechnicalsComputeDeps) =>
  async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const intervalGapMs = deps.intervalGapMs ?? _defaultIntervalGapMs;
    const sleep = deps.sleep ?? _defaultSleep;
    // Each active profile contributes one (interval, symbols) pair per
    // configured Technicals row. buildTechnicalsJobs unions symbols per
    // interval so a colliding interval across profiles is one compute
    // call, not one per profile. An empty technicalsIntervals (operator
    // opted out) drops the profile from the compute pass entirely.
    const subscriptions = deps.listActive().map((p) => ({
      profileId: unwrapId(p.profileId),
      technicals: p.technicalsIntervals.map((interval) => ({
        interval,
        symbols: p.symbols,
      })),
    }));
    // buildTechnicalsJobs also mints a per-interval `jobId` from the 30s
    // bucket for BullMQ dedup; this inline producer calls fetchAndCache
    // directly and ignores `jobId` — the bucket arg only satisfies the
    // shared aggregator's signature.
    const jobs = buildTechnicalsJobs(subscriptions, Math.floor(clock.nowMs() / 30_000));
    let ok = 0;
    let failed = 0;
    for (const [i, job] of jobs.entries()) {
      if (i > 0) await sleep(intervalGapMs());
      try {
        await deps.fetchAndCache(job.interval, job.symbols);
        ok += 1;
      } catch (err) {
        failed += 1;
        deps.logger.warn(
          { interval: job.interval, err: err },
          'cron technicals-compute: interval batch failed',
        );
      }
    }
    // A total commit failure (every interval batch threw) means the technicals
    // buy-gate has no fresh signals to read — surface it loudly rather than
    // letting the dashboard pill be the only hint (no silent failures).
    if (jobs.length > 0 && ok === 0) {
      deps.logger.error(
        { intervals: jobs.length, failed },
        'cron technicals-compute: every interval batch failed; no signals committed',
      );
      return;
    }
    // debug, not info: this cron fires roughly every 30s — an info line per tick
    // is ~2.9k lines/day of noise. A genuine failure logs at warn/error above.
    deps.logger.debug({ intervals: jobs.length, ok, failed }, 'cron technicals-compute: complete');
  };

export const buildTechnicalsComputeCron = (ctx: BootContext): CronDef => {
  const fetchAndCache = createFetchAndCache({
    redis: ctx.redis,
    signalTtlSeconds: 600,
    logger: ctx.logger,
    weightGovernor: ctx.weightGovernor,
    klineConcurrency: ctx.workerEnv.KLINE_CONCURRENCY,
  });
  return defineCron({
    name: 'technicals-compute',
    queue: QUEUE_NAMES.technicalsCompute,
    // Self-rescheduling, not a fixed 30s scheduler: the handler serially fetches
    // klines for every (interval, symbol) and its worst-case runtime can approach
    // the cadence, so a fixed scheduler minted overlapping iterations that
    // backlogged and wedged the queue. The 30s start-to-start period holds
    // when runs are fast and collapses to back-to-back when a run overruns.
    selfReschedulePeriodMs: 30_000,
    handler: technicalsComputeHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      fetchAndCache,
    }),
  });
};
