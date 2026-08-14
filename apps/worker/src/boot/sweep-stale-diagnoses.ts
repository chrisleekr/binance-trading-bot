// Recovery for diagnosis rows left `queued` or `running` by a job that was lost
// or died before writing a terminal state (hard process kill, a job BullMQ moved
// straight to `failed` as stalled without re-entering the handler).
//
// The queue runs with `attempts: 1`, so nothing retries such a row. The drawer
// polls a live run forever and keeps "Check again" hidden while one is in
// flight, which leaves the operator with no way back in — on the one screen they
// opened because something was already wrong. Same shape as the advisor sweep,
// which solves the same problem for the same reason under the same role.

import type { Logger } from 'pino';
import { repo, type Database } from '@app/db';

// A run is bounded by one 24h-ticker call plus a bounded kline fan-out, so it
// settles well inside a minute. Generous enough that an in-flight investigation
// on a slow link is never reclaimed out from under the operator watching it.
const DEFAULT_STALE_MINUTES = 10;

// Boot alone is not enough: a study worker killed mid-run strands a row too
// fresh for the next boot sweep to reclaim, and crons run in the live role.
const PERIODIC_SWEEP_MS = 5 * 60_000;

export interface SweepStaleDiagnosesDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Wall-clock source; tests inject a fixed clock for a deterministic cutoff. */
  readonly clock?: { nowMs(): number };
  /** Override the staleness horizon (minutes). Defaults to {@link DEFAULT_STALE_MINUTES}. */
  readonly staleMinutes?: number;
}

/**
 * Mark abandoned non-terminal diagnosis runs `error`. Returns the count
 * recovered. Safe on every study-worker boot: the age threshold guarantees an
 * in-flight run is never touched.
 */
export async function runStaleDiagnosisSweep(deps: SweepStaleDiagnosesDeps): Promise<number> {
  const minutes = deps.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const nowMs = (deps.clock ?? { nowMs: () => Date.now() }).nowMs();
  const olderThan = new Date(nowMs - minutes * 60 * 1000);
  const recovered = await repo.diagnosisRuns.failStaleNonTerminal(deps.db, olderThan);
  if (recovered > 0) {
    deps.logger.warn(
      { recovered, staleMinutes: minutes },
      'staleDiagnosisSweep: recovered abandoned diagnosis runs',
    );
  }
  return recovered;
}

/**
 * Run {@link runStaleDiagnosisSweep} on a repeating interval and return the
 * timer. Unref'd so it never keeps the process alive or blocks graceful
 * shutdown; the caller clears the returned timer on drain. Sweep failures log
 * and continue, never breaking the loop.
 */
export function startPeriodicDiagnosisSweep(
  deps: SweepStaleDiagnosesDeps,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void runStaleDiagnosisSweep(deps).catch((err: unknown) =>
      deps.logger.error({ err }, 'staleDiagnosisSweep: periodic sweep failed; continuing'),
    );
  }, PERIODIC_SWEEP_MS);
  timer.unref();
  return timer;
}
