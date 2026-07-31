import { z } from 'zod';

/**
 * Build-and-liveness snapshot for the operator status bar. The api serves it
 * from `/status`; the panel renders the api/worker SHAs and warns on skew (the
 * two processes running different code) or a worker that booted before the
 * latest DB migration. SHAs and timestamps only — no account-scoped data — so
 * the route is unauthenticated.
 */
export const StatusResponse = z.object({
  api: z.object({
    sha: z.string(),
    bootedAt: z.string(),
  }),
  // Null when the worker heartbeat key is absent or unparseable — the worker
  // is down or has not written its status since the last restart.
  worker: z
    .object({
      sha: z.string(),
      bootedAt: z.string(),
    })
    .nullable(),
  // The backtest (study-role) worker's liveness. Split from `worker` in prod
  // and `bun run dev` (separate processes), so a dead study worker — backtests
  // silently not running — is visible even while the live worker is healthy.
  // Null when its heartbeat key is absent or unparseable.
  study: z
    .object({
      sha: z.string(),
      bootedAt: z.string(),
    })
    .nullable(),
  db: z.object({
    // Null when no migration has ever been applied (fresh DB).
    latestMigrationAppliedAt: z.string().nullable(),
  }),
  // Worker-fleet membership. `total` = live worker pods currently registered;
  // `ready` = those past their boot ready-gate. Both 0 when no worker has
  // published a fleet count (fleet down, or predates the registry) — distinct
  // from `worker`/`study`, which track the two role heartbeats.
  fleet: z.object({
    total: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
  }),
});

export type StatusResponse = z.infer<typeof StatusResponse>;
