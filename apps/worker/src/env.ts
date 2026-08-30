import { z } from 'zod';

import { ROLES, type Role } from '@app/core/role';
import { booleanEnvFlag, parseEnvOrThrow, sharedEnvFields, type PgSslMode } from '@app/core/env';

export type { PgSslMode };

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

// Resolve the effective study CPU share: an explicit STUDY_CPU_SHARE wins;
// otherwise 0.5 under ROLE=all (study shares the loop with api + live, so
// throttle) and 1.0 for a dedicated worker/study process (full speed).
export const resolveStudyCpuShare = (role: Role, override: number | undefined): number =>
  override ?? (role === 'all' ? 0.5 : 1);

export interface WorkerEnv {
  /** Postgres connection string used by the worker's pg pool. */
  DATABASE_URL: string;
  /** Redis connection string used by ioredis (BullMQ-grade). */
  REDIS_URL: string;
  /**
   * pino log level. Defaults to `info` because the worker is the
   * loudest process in the stack and `debug` floods stdout when an
   * operator forgets to set it explicitly.
   */
  LOG_LEVEL: LogLevel;
  /**
   * Discovery universe-snapshot retention horizon for the
   * `discovery-snapshot-prune` cron. Rows with `captured_at < now - retention`
   * are deleted on each cron fire. Default 180 days is deliberately generous:
   * the series is MEANT to accumulate for a net-edge discovery backtest window,
   * so a short horizon would defeat its purpose.
   */
  DISCOVERY_SNAPSHOT_RETENTION_DAYS: number;
  /** Retention horizon for the per-profile net-P/L `equity_snapshots` series. */
  EQUITY_SNAPSHOT_RETENTION_DAYS: number;
  /**
   * Admin HTTP port for /healthz, /readyz, /metrics. Bound to
   * 127.0.0.1. Default 9101 to avoid colliding with the api's
   * ADMIN_PORT (9100) when both processes run on the host
   * (`bun run dev`); inside compose each container has its own
   * loopback so the two can share 9100, but the asymmetric default
   * keeps host dev working out of the box.
   */
  WORKER_ADMIN_PORT: number;
  /**
   * Interface the admin server binds. Defaults to `127.0.0.1` so the
   * unauthenticated /healthz, /readyz, /metrics stay off the LAN under compose
   * and host dev. k8s sets `0.0.0.0` because the kubelet's httpGet probes hit
   * the pod IP rather than loopback; restrict the exposed port with a
   * default-deny ingress NetworkPolicy (a Service is not a firewall, and pod
   * IPs are reachable cluster-wide by default).
   */
  WORKER_ADMIN_HOST: string;
  /**
   * Which consumers this process runs (see {@link Role}). The worker path only
   * cares about the live/study split: `worker` runs live trading, `study` runs
   * backtest + advisor, `all` runs both. `api` never boots the worker, but the
   * enum accepts it because api and worker read the same `ROLE` var. Defaults to
   * `all` so a single-box deploy keeps working; the scale topology splits into a
   * `worker` and a `study` process so backtests never share the live event loop.
   */
  ROLE: Role;
  /**
   * Max concurrent backtest replays on the `backtest` queue. The engine is
   * CPU-bound, so on a shared-core dev box (a live worker + a study worker on
   * one machine) lower this to 1-2 to leave the OS scheduler headroom for the
   * live process. Prod's dedicated study box keeps the default 4.
   */
  BACKTEST_CONCURRENCY: number;
  /**
   * Fraction of one CPU core a backtest replay may use, in (0, 1]. Under
   * ROLE=all the study consumer shares the single JS event loop with api + live
   * trading, so a full-speed replay would starve them; the runner sleeps
   * proportionally at its yield points to hold this share. Unset defaults to 0.5
   * under ROLE=all and 1.0 (full speed) for a dedicated worker/study process,
   * resolved in boot where the role is known.
   */
  STUDY_CPU_SHARE?: number | undefined;
  /**
   * Build SHA injected by the Docker build-arg. Written to the `worker:status`
   * heartbeat so the api's `/status` can flag api/worker skew.
   */
  GIT_SHA: string;
  /** libpq sslmode passed to pg_dump by the `db-backup` cron. */
  PGSSLMODE: PgSslMode;
  /** Directory the `db-backup` cron writes dump files into and prunes. */
  BACKUP_DIR: string;
  /**
   * Public base URL of the web app, used to build tap-through links in operator
   * notifications (backtest results, orphan orders). Optional: unset omits the
   * link and the notification still sends. No trailing slash.
   */
  PUBLIC_WEB_URL?: string | undefined;
  /**
   * Public "Live demo" mode. When true, the worker no-ops all notifier dispatch
   * so a seed snapshot carrying real webhooks can never leak from the demo box.
   * A separate deployment concern; the operator's real instance leaves it false.
   */
  LIVE_DEMO: boolean;
  /**
   * Per-tick budget (ms) for the durable `symbol_states` CAS write. On timeout
   * the tick abandons the wait and falls back to the degraded cache-refresh path
   * (read-your-writes stays intact via Redis). The 100ms default suits local SSD;
   * network-replicated block storage where a commit fsync is a cross-node
   * round-trip needs a higher budget so the degraded path stays a true fallback
   * rather than the steady state.
   */
  TICK_PERSIST_TIMEOUT_MS: number;
  /**
   * Max concurrent tick jobs on the `tick` queue. Under ROLE=all the tick loop
   * shares the single JS event loop with the api, so many concurrent ticks stack
   * their synchronous strategy-eval phases between I/O yields and tail-latency the
   * dashboard. Per-key ordering is enforced by chainByKey + jobId coalescing
   * regardless of this value, so lowering it only reduces throughput of distinct
   * (profile, symbol) keys, never correctness. Defaults to 25.
   */
  TICK_CONCURRENCY: number;
  /**
   * Max concurrent Binance kline fetches per interval in the technicals-compute
   * cron. Each fetched symbol then runs ~7.6ms of synchronous indicator math;
   * under ROLE=all several stacked bursts monopolize the shared event loop. The
   * cron yields between symbols, but lowering this bounds how many bursts stack
   * before a yield. Defaults to 8.
   */
  KLINE_CONCURRENCY: number;
}

const WorkerEnvSchema = z.object({
  ...sharedEnvFields,
  LIVE_DEMO: booleanEnvFlag(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DISCOVERY_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  EQUITY_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  WORKER_ADMIN_PORT: z.coerce.number().int().positive().default(9101),
  WORKER_ADMIN_HOST: z.string().min(1).default('127.0.0.1'),
  ROLE: z.enum(ROLES).default('all'),
  BACKTEST_CONCURRENCY: z.coerce.number().int().positive().default(1),
  TICK_CONCURRENCY: z.coerce.number().int().positive().default(25),
  KLINE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  TICK_PERSIST_TIMEOUT_MS: z.coerce.number().int().positive().default(100),
  STUDY_CPU_SHARE: z.coerce.number().gt(0).lte(1).optional(),
  // Trim a trailing slash so link building can always append an absolute path.
  PUBLIC_WEB_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
});

/**
 * Worker-process env loader. Validates the connection-string + log-level
 * + retention triad in one pass. Runs once at worker startup, before
 * any subsystem (pg pool, ioredis, BullMQ, cron) reads its config, so
 * invalid values fail fast at boot rather than at the first tick.
 *
 * Failing here is loud and operator-actionable; a malformed
 * `DISCOVERY_SNAPSHOT_RETENTION_DAYS=foo` or a missing `DATABASE_URL` crashes
 * boot with a precise zod issue list rather than silently coercing to
 * `NaN` or falling back to `localhost`.
 */
export const loadWorkerEnv = (raw: NodeJS.ProcessEnv = process.env): WorkerEnv =>
  parseEnvOrThrow(WorkerEnvSchema, raw, 'worker');
