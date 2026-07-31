import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

// Bare ioredis keys the api's `/status` route reads (no scope prefix). Writing
// the identical literals keeps the api reading the same bytes this worker sets.
// The live and study workers write SEPARATE keys so the two prod services never
// clobber each other, and the api can report each process's liveness on its own.
export const WORKER_STATUS_KEY = 'worker:status';
export const WORKER_STUDY_STATUS_KEY = 'worker:study-status';
// Presence-only readiness flag for the backtest advisor. The api's start-advisor
// route 503s when this key is absent. Written ONLY while the study worker's
// selected AI provider is usable; re-evaluated each refresh from the live DB
// config, so disabling the provider in the UI clears the key within a TTL window
// without a restart. Same TTL/refresh as the liveness keys.
export const WORKER_ADVISOR_READY_KEY = 'advisor:ready';
// Heartbeat TTL outlives two refresh intervals so a single missed refresh does
// not flap the api's "down" verdict; an actually-dead worker expires within 2
// minutes. The study worker stays responsive during a replay via the engine's
// cooperative yield, so its refresh fires even mid-backtest.
const WORKER_STATUS_TTL_S = 120;
const WORKER_STATUS_REFRESH_MS = 60_000;

export interface HeartbeatDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly heartbeat: string;
  // The live trading worker writes WORKER_STATUS_KEY (the api's skew check reads
  // it). Only one process may write it, or the skew check reads whichever wrote
  // last (non-deterministic), so this gates that write.
  readonly runsLive: boolean;
  // The backtest worker writes WORKER_STUDY_STATUS_KEY so a dead study
  // process (backtests silently not running) is visible without polling the DB.
  readonly runsStudy: boolean;
  // Whether this process can currently generate advisor output. Evaluated on
  // each heartbeat (study role only) so the WORKER_ADVISOR_READY_KEY tracks the
  // live DB provider config; the api's start-advisor route 503s while it is
  // false. Best-effort: a throw leaves the key unchanged (no set, no del) and it
  // self-heals within one TTL if the throw persists — preferred over flapping the
  // key to absent on a transient DB blip.
  readonly advisorReady: () => Promise<boolean>;
}

/**
 * Write each enabled role's build-SHA/boot-time heartbeat and refresh it on an
 * interval. The live key feeds the api's api/worker code-skew check; the study
 * key is liveness-only; the advisor-ready key gates the start-advisor route.
 * Best-effort throughout, a Redis hiccup never aborts boot or a refresh loop.
 * Returns the refresh timers so the shutdown handler can clear them (empty when
 * this process writes no key).
 */
export const startWorkerHeartbeat = async (
  deps: HeartbeatDeps,
): Promise<ReturnType<typeof setInterval>[]> => {
  const { redis, logger, heartbeat, runsLive, runsStudy, advisorReady } = deps;
  const timers: ReturnType<typeof setInterval>[] = [];

  const beat = async (key: string): Promise<void> => {
    await redis
      .set(key, heartbeat, 'EX', WORKER_STATUS_TTL_S)
      .catch((err: unknown) => logger.warn({ err, key }, 'worker status heartbeat write failed'));
    const timer = setInterval(() => {
      redis.set(key, heartbeat, 'EX', WORKER_STATUS_TTL_S).catch(() => undefined);
    }, WORKER_STATUS_REFRESH_MS);
    timer.unref();
    timers.push(timer);
  };

  // Advisor readiness is not a fixed boolean: the operator can switch/clear the
  // AI provider at runtime, so re-check each refresh and set-or-delete the key.
  const refreshAdvisorReady = async (): Promise<void> => {
    try {
      if (await advisorReady()) {
        await redis.set(WORKER_ADVISOR_READY_KEY, heartbeat, 'EX', WORKER_STATUS_TTL_S);
      } else {
        await redis.del(WORKER_ADVISOR_READY_KEY);
      }
    } catch (err) {
      logger.warn({ err }, 'advisor readiness heartbeat failed');
    }
  };

  if (runsLive) await beat(WORKER_STATUS_KEY);
  if (runsStudy) await beat(WORKER_STUDY_STATUS_KEY);
  if (runsStudy) {
    await refreshAdvisorReady();
    const timer = setInterval(() => void refreshAdvisorReady(), WORKER_STATUS_REFRESH_MS);
    timer.unref();
    timers.push(timer);
  }
  return timers;
};
