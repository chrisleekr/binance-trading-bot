// Boot-time recovery for advisor rows left `running` by a background job that was
// lost or died before writing a terminal state (hard process kill, dropped job).
// Without this the polling UI watches a `running` row forever. The advisor runs
// under the study role, so this is a study-boot sweep, not a cron (crons run under
// the live role). Keys off `updated_at`: a row's age resets when it transitions
// into `running`, so a regenerated variant is timed from its current job.

import type { Logger } from 'pino';
import { repo, type Database } from '@app/db';

// A real advisor generation finishes in ~1-2 min (two ~30s Anthropic round-trips
// plus DB writes), so a row still `running` past this window has no live job.
// Generous to never touch one in progress.
const DEFAULT_STALE_MINUTES = 15;

// Cadence for the periodic study-role sweep below. Backtest runs get a periodic
// cron for this; the advisor runs under the study role, where crons do not, so a
// study worker hard-killed mid-generation would strand a `running` row until the
// next boot — the polling UI watches it forever and Regenerate no-ops. This
// interval reclaims it between boots.
const PERIODIC_SWEEP_MS = 5 * 60_000;

export interface SweepStaleAdvisorsDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Wall-clock source; tests inject a fixed clock for a deterministic cutoff. */
  readonly clock?: { nowMs(): number };
  /** Override the staleness horizon (minutes). Defaults to {@link DEFAULT_STALE_MINUTES}. */
  readonly staleMinutes?: number;
}

/**
 * Mark abandoned `running` advisor rows `error`/`failed`. Returns the count
 * recovered. Safe on every study-worker boot: the age threshold guarantees an
 * in-flight generation is never touched.
 */
export async function runStaleAdvisorSweep(deps: SweepStaleAdvisorsDeps): Promise<number> {
  const minutes = deps.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const nowMs = (deps.clock ?? { nowMs: () => Date.now() }).nowMs();
  const olderThan = new Date(nowMs - minutes * 60 * 1000);
  const recovered = await repo.backtestAdvisorResults.failStaleRunning(deps.db, olderThan);
  if (recovered > 0) {
    deps.logger.warn(
      { recovered, staleMinutes: minutes },
      'staleAdvisorSweep: recovered abandoned running advisors',
    );
  } else {
    deps.logger.info({ staleMinutes: minutes }, 'staleAdvisorSweep: no stale advisors to recover');
  }
  return recovered;
}

/**
 * Run {@link runStaleAdvisorSweep} on a repeating interval and return the timer.
 * Unref'd so it never keeps the process alive or blocks graceful shutdown; the
 * caller clears the returned timer on drain. Sweep failures log and continue,
 * never breaking the loop.
 */
export function startPeriodicAdvisorSweep(
  deps: SweepStaleAdvisorsDeps,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void runStaleAdvisorSweep(deps).catch((err: unknown) =>
      deps.logger.error({ err }, 'staleAdvisorSweep: periodic sweep failed; continuing'),
    );
  }, PERIODIC_SWEEP_MS);
  timer.unref();
  return timer;
}
