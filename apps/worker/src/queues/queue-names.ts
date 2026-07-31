// Queue catalogue. Names + concurrency + retry are the source of truth
// here; the boot wiring registers Workers off this table.

export const QUEUE_NAMES = {
  tick: 'tick',
  technicalsCompute: 'technicals-compute',
  alive: 'alive',
  auditDrain: 'audit-drain',
  dlq: 'dlq',
  dailyAth: 'daily-ath',
  exchangeInfoRefresh: 'exchange-info-refresh',
  accountSnapshotSafety: 'account-snapshot-safety',
  dustSnapshot: 'dust-snapshot',
  equitySnapshot: 'equity-snapshot',
  equitySnapshotPrune: 'equity-snapshot-prune',
  orphanOrdersDetect: 'orphan-orders-detect',
  detachedOrdersReconcile: 'detached-orders-reconcile',
  // Deferral seam for a fill discovered OUTSIDE the user stream — a -2011
  // cancel probe that came back FILLED, a -2010 SELL rejection that says the
  // wallet no longer holds what the state claims. The discovering code runs
  // inside the tick's per-(profile, symbol) `chainByKey` lock, which the
  // fill-adopter also takes, so it CANNOT adopt inline (it would self-await).
  // It enqueues here instead and the job adopts outside the lock.
  symbolReconcile: 'symbol-reconcile',
  // Periodic backstop for the same class of drift: pins every active
  // (profile, symbol)'s heldQuantity to wallet truth on a slow cadence, so a
  // missed fill heals within one window even when no code path noticed it.
  heldQuantityReconcile: 'held-quantity-reconcile',
  // The ORDER-side half of the same job: closes local order rows whose order has
  // left Binance's book. Ran only at boot, which on a healthy worker means never
  // — an order the operator cancelled ON BINANCE stayed `NEW` / `closed_at NULL`
  // in our table indefinitely, showing as an open order in the UI and counting
  // toward exposure. Deliberately a SEPARATE cron from the held-quantity sweep:
  // they converge different things against different Binance endpoints, and a
  // reaper fault must not delay the position convergence, which is the money-
  // critical one.
  staleOrderReap: 'stale-order-reap',
  actionLogPrune: 'action-log-prune',
  auditPrune: 'audit-prune',
  discoverySnapshotPrune: 'discovery-snapshot-prune',
  discoveryRun: 'discovery-run',
  discoveryHealth: 'discovery-health',
  marketTrend: 'market-trend',
  portfolioRisk: 'portfolio-risk',
  edgeDecayMonitor: 'edge-decay-monitor',
  dbBackup: 'db-backup',
  // Shared control-plane queue the api enqueues into for cross-process
  // notification of profile lifecycle changes (subscribe-profile,
  // unsubscribe-profile, verify-key, etc.). The worker dispatches on
  // `job.name`. Duplicate enqueues for the same logical action are
  // coalesced per-jobId (BullMQ behaviour); ordering across different
  // jobIds for the same profile is NOT guaranteed at `concurrency > 1`.
  // Concurrency stays at 4 because the consumer paths are idempotent
  // (enable/disable on `profileManager` and `client.getAccount()` on
  // verify-key); strict per-profile serialisation lives one layer down
  // in the `chainByKey` Promise chain.
  pipeline: 'pipeline',
  // One-shot, long-running backtest jobs. The api enqueues with
  // `jobId = backtest:<runId>` so a duplicate submit of the same run
  // coalesces. Concurrency 1 (a run is CPU-heavy and shares the per-IP
  // Binance weight budget with ticks during candle backfill).
  backtest: 'backtest',
  // Periodic reconciler that marks `queued`/`running` runs whose BullMQ job is
  // gone or terminal as `error`, so a run abandoned by a dead worker stops
  // showing as running and stops holding a per-profile in-flight slot.
  backtestSweep: 'backtest-sweep',
  // Background config-advisor generation. The api enqueues one job per
  // (run, variant) with NO jobId; the `backtest_advisor_result` row's
  // conditional transition to `running` is the single-flight guard. Runs only
  // under the study role (an Anthropic round-trip must never share the live
  // trading event loop).
  advisor: 'advisor',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface QueueSpec {
  readonly concurrency: number;
  readonly attempts: number;
  readonly backoffMs: number;
  /**
   * Override BullMQ's default 30 s `lockDuration` for handlers that can
   * legitimately exceed it. The lock auto-renews while the handler awaits
   * Redis/IO, but a single long REST call (Binance retry path can hold a
   * fetch for >30 s) outpaces renewal and the job is marked stalled —
   * the scheduler then enqueues a duplicate and active piles up.
   */
  readonly lockDurationMs?: number;
}

// The cron queues all run `concurrency: 1`. Each cron is an
// inline-enumeration producer — one payload-less job per tick that
// enumerates every active profile. A concurrency above 1 would let a
// slow tick overlap the next, re-enumerating the same profiles and
// duplicating REST calls against the per-account Binance rate budget.
// Single-flight makes a slow tick delay (not overlap) the next.
export const QUEUE_SPECS: Record<QueueName, QueueSpec> = {
  // 60 s lockDuration: a tick's slowest leg is a Binance REST call (bounded to
  // a few seconds) plus the CAS state commit; BullMQ auto-renews the lock while
  // the handler makes progress. The explicit 60 s (vs the 30 s default) widens
  // the margin before a genuinely stuck tick is re-delivered to another
  // consumer. Cross-pod re-delivery is now safe regardless — the symbol_states
  // version-CAS rejects a lost update and clientOrderId dedups order placement
  // — so this only trims spurious re-runs, it is not the safety mechanism.
  tick: { concurrency: 25, attempts: 3, backoffMs: 1_000, lockDurationMs: 60_000 },
  // 300 s lockDuration: a single cron tick fetches klines for every
  // (interval, symbol) pair serially. Each fetch is bounded at 10 s by
  // `AbortSignal.timeout(10_000)` plus one retry — worst-case ~22 s per
  // interval batch, and the operator's full 5-interval set fans out to
  // a ~110 s upper bound. A lock shorter than that fires false stalls. The
  // cron is self-rescheduling (no fixed scheduler), so a stall no longer
  // backlogs duplicates, but the generous lock keeps a healthy slow run from
  // false-stalling and discarding its work (#361).
  //
  // attempts 1: the self-rescheduling loop's next run IS the retry, so a
  // BullMQ-level retry is redundant and only re-runs the same fetch fan-out
  // sooner. The handler already catches per-interval failures and never throws,
  // so the only `failed` path is a stall, for which the next cycle recovers.
  'technicals-compute': {
    concurrency: 1,
    attempts: 1,
    backoffMs: 1_000,
    lockDurationMs: 300_000,
  },
  alive: { concurrency: 1, attempts: 3, backoffMs: 5_000 },
  'audit-drain': { concurrency: 1, attempts: 5, backoffMs: 1_000 },
  dlq: { concurrency: 1, attempts: 1, backoffMs: 0 },
  // Same retry-path failure mode as `technicals-compute`: a single
  // tick fan-outs `refreshAth` over every unique symbol with a 15 s
  // per-fetch timeout and concurrency 4, so the upper bound scales
  // with profile + symbol count. The 30 s default lock fires false
  // stalls past ~8 symbols; v1.x multi-account amplifies this.
  'daily-ath': { concurrency: 1, attempts: 3, backoffMs: 5_000, lockDurationMs: 120_000 },
  'exchange-info-refresh': { concurrency: 1, attempts: 3, backoffMs: 5_000 },
  'account-snapshot-safety': { concurrency: 1, attempts: 1, backoffMs: 0 },
  'dust-snapshot': { concurrency: 1, attempts: 1, backoffMs: 0 },
  // attempts 1: the handler swallows getOpenOrders failures (warn, no throw),
  // so the only failure is a stall, which the next 10-min tick recovers.
  // 60s lock: the account-wide getOpenOrders can hold a slow fetch past the
  // 30s default.
  'orphan-orders-detect': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 60_000 },
  // Closes DETACHED order rows (profile deleted) that have left the exchange's
  // book. attempts 1: the handler swallows per-row Binance failures, so the only
  // failure mode is a stall, which the next tick recovers. 60s lock: one getOrder
  // per detached row, and detached rows are normally zero (the query short-
  // circuits before any Binance call).
  'detached-orders-reconcile': {
    concurrency: 1,
    attempts: 1,
    backoffMs: 0,
    lockDurationMs: 60_000,
  },
  // concurrency 1: two reconciles of the same (profile, symbol) would contend
  // for the same chain key anyway, and the work is a couple of Binance reads.
  // attempts 3 with a 5s backoff because a transient Binance/DB fault here
  // leaves the position mis-stated until the 15-min backstop cron — worth
  // retrying promptly. The `jobId` coalesces duplicate enqueues while one is
  // still waiting.
  'symbol-reconcile': { concurrency: 1, attempts: 3, backoffMs: 5_000, lockDurationMs: 60_000 },
  // Fleet-wide sweep over every active (profile, symbol). attempts 1: the
  // self-rescheduling loop's next run IS the retry, and the orchestrator already
  // isolates per-profile/per-symbol failures. The generous lock covers the
  // per-profile getAccount + per-symbol trade-history fan-out.
  'held-quantity-reconcile': {
    concurrency: 1,
    attempts: 1,
    backoffMs: 0,
    lockDurationMs: 300_000,
  },
  // Same shape as the held-quantity sweep: self-rescheduling, non-overlapping,
  // per-target failures already isolated inside the reaper, so the next run is the
  // retry. The lock covers a per-order `getOrder` fan-out across every profile.
  'stale-order-reap': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 300_000 },
  'action-log-prune': { concurrency: 1, attempts: 3, backoffMs: 5_000 },
  'audit-prune': { concurrency: 1, attempts: 3, backoffMs: 5_000 },
  'discovery-snapshot-prune': { concurrency: 1, attempts: 3, backoffMs: 5_000 },
  // Self-rescheduling discovery scan. One tick fetches all-symbols ticker once
  // then klines for each profile's shortlist serially, so worst-case runtime
  // scales with profile + shortlist size; a generous lock prevents false stalls.
  // attempts 1: the self-reschedule loop's next run is the retry, and the
  // handler never throws (per-profile failures are caught, fail-safe no-churn).
  'discovery-run': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 300_000 },
  // Discovery-health monitor. One 5-min tick reads each enabled profile's recent
  // snapshot history (a scoped DB query + Redis throttle) and alerts on staleness
  // or a persistent breadth block. attempts 1: the next tick is the retry, and the
  // handler catches per-profile failures (a missed check just defers one tick).
  // 60s lock covers the per-profile snapshot read fan-out.
  'discovery-health': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 60_000 },
  // Self-rescheduling market-trend snapshot. One tick fetches two daily-kline
  // windows plus the all-tickers ticker, all weight-governed. attempts 1: the
  // loop's next run is the retry and the handler never throws (compute failures
  // are caught and logged). 60s lock covers the worst-case serial fetch path.
  'market-trend': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 60_000 },
  // Daily-loss circuit-breaker check. One tick sums each active profile's
  // realised P/L for the UTC day and sets a Redis halt flag on breach. attempts 1:
  // the next 30s tick is the retry, and the handler catches per-profile failures
  // (fail-safe — a missed check just defers the halt one tick).
  'portfolio-risk': { concurrency: 1, attempts: 1, backoffMs: 0 },
  // Live edge-decay check. One 15-min tick compares each live profile's realized
  // profit factor against its pinned baseline; on a breach it sends an advisory
  // alert and updates a non-suppressing latch (never pauses buys). attempts 1: the
  // next tick is the retry, and the handler catches per-profile failures (a missed
  // check just defers the alert one tick). 60s lock covers the per-profile archive
  // read + baseline fetch fan-out.
  'edge-decay-monitor': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 60_000 },
  // Net-P/L capture. One 15-min tick reads each profile's positions + realised
  // P/L + cached tickers and inserts one row. attempts 1: the next tick is the
  // retry; the handler catches per-profile failures (a missed point just leaves
  // a gap the next capture fills).
  'equity-snapshot': { concurrency: 1, attempts: 1, backoffMs: 0 },
  'equity-snapshot-prune': { concurrency: 1, attempts: 3, backoffMs: 5_000 },
  // Self-rescheduling DB-backup cron. attempts 1: a scheduled pg_dump must not
  // retry-storm; the next 5-min tick is the natural retry. 600s lock because a
  // full-database pg_dump can far exceed BullMQ's 30s default and would
  // otherwise false-stall + spawn a duplicate dump mid-run.
  'db-backup': { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 600_000 },
  pipeline: { concurrency: 4, attempts: 3, backoffMs: 1_000 },
  // A backtest runs for minutes (candle backfill + thousands of ticks), far
  // past BullMQ's default 30 s lock — a generous lockDurationMs prevents a
  // false stall + duplicate dispatch mid-run. attempts: 1 because a run is
  // long, non-idempotent compute; a single hard failure routes to the DLQ.
  // concurrency 1: one backtest at a time on a single low-end worker for the
  // least memory pressure and CPU contention (a long CPU-bound replay starves
  // the heartbeat / lock renewal when several share the process). Concurrent
  // backtest jobs therefore run serially; the engine is pure so each result is
  // unchanged, only wall-clock throughput trades down for reliability.
  backtest: { concurrency: 1, attempts: 1, backoffMs: 0, lockDurationMs: 1_800_000 },
  // Backtest stuck-run reconciler. One 15-min tick lists non-terminal runs and
  // reclaims those with no live queue job. attempts 1: the next tick is the
  // retry, and the handler catches per-run failures (a missed reconcile just
  // defers cleanup one tick).
  'backtest-sweep': { concurrency: 1, attempts: 1, backoffMs: 0 },
  // Config-advisor generation. concurrency 2 lets a couple of variant buttons
  // generate at once without saturating the study process. attempts 1: a failed
  // Claude call is expensive (billed per token) and non-idempotent, so it routes
  // straight to the DLQ rather than re-billing on a retry; the DB row records the
  // error and the operator regenerates explicitly. 300s lock covers the two
  // parallel Anthropic round-trips a multi-sample EXPLORE variant makes (each
  // ~30s streamed), well past BullMQ's 30s default.
  advisor: { concurrency: 2, attempts: 1, backoffMs: 0, lockDurationMs: 300_000 },
};

// Only the queues whose producers coalesce by jobId get a builder. The crons
// are payload-less self-rescheduling repeatable jobs whose fixed `name:` is
// their identity, so they never construct one. Add a builder when a producer
// genuinely needs duplicate-enqueue coalescing.

export const tickJobId = (profileId: string, symbol: string): string =>
  `tick:${profileId}:${symbol}`;

// A reconcile is a converge-to-truth pass, not an increment, so N enqueues for
// one (profile, symbol) are worth exactly one run. BullMQ rejects an `.add()`
// whose jobId already exists in ANY state, so this static id collapses a burst
// (a -2011 fill plus the -2010 SELL rejection it causes on the next tick) into a
// single pass while the job is waiting or active. The producer MUST pair it with
// `removeOnComplete: true` / `removeOnFail: true`: a retained terminal job still
// occupies the id, and the slot would never reopen.
export const symbolReconcileJobId = (profileId: string, symbol: string): string =>
  `reconcile-symbol:${profileId}:${symbol}`;

export const technicalsJobId = (interval: string, bucket30s: number): string =>
  `technicals-compute:${interval}:${bucket30s}`;

export const backtestJobId = (runId: string): string => `backtest:${runId}`;
