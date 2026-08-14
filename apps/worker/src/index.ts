// Worker process entrypoint.
//
// Boot order:
//   1. Build the DI graph (`buildBootContext`).
//   2. Register crons (`buildCrons(ctx)` -> `registerCrons`).
//   3. Prime exchangeInfo so the first tick reads a warm cache.
//   4. Start lifecycle components.
//   5. Register tick + pipeline workers (only after step 4 — see #213).
//   6. Start admin server (readiness probe answers "ready" once everything
//      above is up).
//   7. Install SIGTERM/SIGINT graceful shutdown (≤10s drain).
//
// Construction logic lives in `boot/boot-context.ts`; per-cron wiring
// lives in `crons/*.cron.ts`. This file is the orchestrator, nothing else.

import { bootstrapEnv } from '@app/core/env';

bootstrapEnv(import.meta.url);

import type { Job } from 'bullmq';

import { buildBootContext, type BootEnv } from './boot/boot-context.js';
import { primeBeforeTicks } from './boot/prime-before-ticks.js';
import { startWorkerHeartbeat } from './boot/worker-heartbeat.js';
import { startRuntimeGauges } from './boot/runtime-gauges.js';
import { createMemberRegistry, workerMemberId } from './boot/member-registry.js';
import { runHeldQuantityReconciliation } from './boot/reconcile-held-quantity.js';
import { runStaleOrderReaper } from './boot/reap-stale-orders.js';
import { runAccountSnapshotSeed } from './boot/seed-account-snapshots.js';
import { runStaleAdvisorSweep, startPeriodicAdvisorSweep } from './boot/sweep-stale-advisors.js';
import { buildCrons } from './crons/index.js';
import { registerCrons } from './crons/register-crons.js';
import { QUEUE_NAMES } from './queues/queue-names.js';
import type { TickJobData } from './queues/job-payloads.js';
import { registerPipelineWorker } from './queues/pipeline-worker.js';
import { registerSymbolReconcileWorker } from './queues/symbol-reconcile-worker.js';
import { registerBacktestWorker } from './queues/backtest-worker.js';
import { registerAdvisorWorker } from './queues/advisor-worker.js';
import { createRunBacktestJob } from './boot/run-backtest-job.js';
import { LruCandleCache } from './backtest/candle-cache.js';
import { LruSignalCache } from './backtest/signal-cache.js';
import { createBinanceRest } from '@app/binance';
import { repo, toAiProviderConfig } from '@app/db';
import { createLlm, type LlmAssist } from '@app/llm';
import { startAll, stopAll } from './lib/component.js';
import { runTeardown } from './lib/shutdown-teardown.js';
import { startAdminServer } from './admin-server.js';
import { loadWorkerEnv, resolveStudyCpuShare } from './env.js';
import { toBootEnv } from './boot/to-boot-env.js';
import { resolveGitSha } from '@app/core/git-sha';
import { runsLive as roleRunsLive, runsStudy as roleRunsStudy } from '@app/core/role';
import { installGracefulShutdown } from '@app/core/shutdown';

export type { BootEnv } from './boot/boot-context.js';
export { loadWorkerEnv } from './env.js';
export { toBootEnv } from './boot/to-boot-env.js';

export interface WorkerHandle {
  shutdown(): Promise<void>;
}

export const boot = async (env: BootEnv): Promise<WorkerHandle> => {
  const ctx = await buildBootContext(env);
  const { logger, queueSet, pool, redis, lifecycles } = ctx;

  const gitSha = resolveGitSha(env.gitSha || undefined);
  const bootedAt = new Date().toISOString();
  const heartbeat = JSON.stringify({ sha: gitSha, bootedAt });

  // Role decides which consumers this process runs. `study` runs only the
  // backtest + advisor consumers so heavy historical replays never share the
  // live trading event loop; `worker` runs everything except those; `all`
  // (default) keeps the single-process behaviour.
  const role = ctx.workerEnv.ROLE;
  const runsLive = roleRunsLive(role);
  const runsStudy = roleRunsStudy(role);
  const studyCpuShare = resolveStudyCpuShare(role, ctx.workerEnv.STUDY_CPU_SHARE);
  logger.info({ role, studyCpuShare }, 'worker role selected');

  // The backtest advisor (study-role only). The provider is DB-configured and
  // operator-switchable at runtime, so resolve a fresh client per job/probe from
  // the singleton config row rather than binding one at boot. Construction is
  // cheap and the Anthropic SDK import is deferred to first use, so a live-only
  // worker never loads it. `available` is false when the selected provider has no
  // usable credential/config.
  const resolveLlm = async (): Promise<LlmAssist> =>
    createLlm(toAiProviderConfig(await repo.aiProviderConfig.get(ctx.db)));

  // Best-effort heartbeats the api's /status reads. The live worker writes the
  // skew-check key; the study worker writes its own liveness key (separate keys,
  // so the two prod services never clobber). Returns the refresh timers so
  // shutdown can clear them.
  const heartbeatTimers = await startWorkerHeartbeat({
    redis,
    logger,
    heartbeat,
    runsLive,
    runsStudy,
    // Advertise advisor readiness only while a study worker can actually generate.
    // Re-evaluated on each heartbeat from the live DB config, so toggling the
    // provider in the UI flips the api's start-advisor gate without a restart.
    advisorReady: async () => (await resolveLlm()).available,
  });

  // Fleet membership: register this pod under a short-TTL key so the fleet size
  // is observable and a future owner-election can pick subscription owners from
  // the live members. Independent of the role heartbeat above — one key per pod,
  // not per role. Starts not-ready; flipped ready once boot completes (below).
  const memberRegistry = createMemberRegistry({
    redis,
    logger,
    id: workerMemberId(),
    sha: gitSha,
    bootedAt,
    metrics: ctx.metricsRegistry,
  });
  await memberRegistry.start();

  // Queue depth and pool saturation, sampled in-process. Pushed onto the
  // heartbeat timers so one shutdown clear disposes every periodic sampler.
  heartbeatTimers.push(
    ...(await startRuntimeGauges({ queues: queueSet.queues, pool, metrics: ctx.metrics, logger })),
  );

  if (runsLive) await registerCrons({ queueSet, logger, redis, crons: buildCrons(ctx) });

  // Typed ordering gate: prime exchangeInfo BEFORE any tick worker is
  // registered. Without this, BullMQ can dequeue a tick job between
  // worker registration and the priming await, executing against an
  // unprimed cache. The cold-load handler has an inline-prime fallback,
  // but it adds ~500ms to the first tick.
  await primeBeforeTicks({ logger, exchangeInfoRefresh: ctx.exchangeInfoRefresh });

  // Live-trading consumers and their startup. Skipped entirely for the `study`
  // role, whose process runs only the backtest consumer below.
  if (runsLive) {
    // Lifecycles MUST start BEFORE the tick + pipeline workers are
    // registered. Pipeline jobs (subscribe-profile, verify-key) call into
    // `profileManager`; if a pipeline job dequeues in the window between
    // worker registration and `profileManager.start()`, the boot-time DB
    // rehydration races with the in-flight handler. Tick jobs face the
    // same race against `marketSubscriber.start()` (a tick that runs
    // before WS subscriptions land sees empty candles and noops, slow but
    // correct — still worth ordering tightly).
    await startAll(lifecycles, logger);

    // Start the audit drainer's background loop AFTER lifecycles so
    // `profileManager.listActive()` (its stream source) is populated. The loop
    // runs until `stop()` (called in shutdown); it never resolves, so it is
    // fire-and-forget with a terminal-error log rather than awaited.
    void ctx.auditDrainer.start().catch((err) => {
      logger.error({ err }, 'audit drainer loop exited unexpectedly');
    });

    // Reconcile `state.heldQuantity` against each profile's wallet snapshot
    // exactly once at boot, after the profile manager has loaded the
    // enabled set. Closes the gap left by fills that landed while the
    // worker was offline or by external base-asset movement (deposits,
    // withdrawals, BNB fees in the base asset). Per-target failures log
    // and skip — never aborts boot.
    try {
      // Same dep bag the backstop cron and the `symbol-reconcile` job hold, so
      // all three converge through one code path — including the shared
      // `chainByKey` that serialises their writes against a concurrent fill.
      const tally = await runHeldQuantityReconciliation(ctx.reconcileDeps);
      logger.info({ tally }, 'reconcileHeldQuantity: boot reconciliation complete');
    } catch (err) {
      logger.error({ err }, 'reconcileHeldQuantity: boot reconciliation failed; continuing');
    }

    // Reap local "live" order rows whose binanceOrderId is no longer on
    // the exchange. Closes the gap left by dev-seeded orders, mid-fill
    // crashes, and externally-cancelled orders the user-stream missed.
    // Per-target failures stay isolated; never aborts boot.
    try {
      const tally = await runStaleOrderReaper({
        db: ctx.db,
        logger,
        listActive: ctx.profileManager.listActive,
        resolveBinance: ctx.resolveBinanceClient,
      });
      logger.info({ tally }, 'reapStaleOrders: boot reap complete');
    } catch (err) {
      logger.error({ err }, 'reapStaleOrders: boot reap failed; continuing');
    }

    // Seed the `account-info` cache before the first WS frame or cron tick so
    // the dashboard never reads an empty snapshot in the cold-start window.
    // Per-profile failures stay isolated; the safety cron repopulates on its
    // next tick, so this never aborts boot.
    try {
      const tally = await runAccountSnapshotSeed({
        logger,
        listActive: ctx.profileManager.listActive,
        resolveBinance: ctx.resolveBinanceClient,
        persistAccount: ctx.accountSnapshotStore.persistAccount,
        persistAccountPermissions: ctx.accountSnapshotStore.persistAccountPermissions,
      });
      logger.info({ tally }, 'seedAccountSnapshots: boot seed complete');
    } catch (err) {
      logger.error({ err }, 'seedAccountSnapshots: boot seed failed; continuing');
    }

    // Tick + pipeline workers ONLY start dequeuing after the cache is
    // primed, crons are scheduled, AND lifecycles are started.
    queueSet.registerWorker<TickJobData>(
      QUEUE_NAMES.tick,
      (job: Job<TickJobData>) => ctx.tickHandler(job),
      ctx.workerEnv.TICK_CONCURRENCY,
    );

    // Pipeline-queue consumer. The api enqueues subscribe-profile,
    // unsubscribe-profile, and verify-key jobs here; without a registered
    // worker they pile up in `bull:pipeline:wait` and the ProfileManager
    // never learns about API-initiated lifecycle changes.
    registerPipelineWorker(queueSet, {
      db: ctx.db,
      redis,
      profileManager: ctx.profileManager,
      strategies: ctx.strategies,
      executor: ctx.liveExecutor,
      statePort: ctx.statePort,
      clock: { nowMs: () => Date.now() },
      // Same `chainByKey` instance the tick handler uses so state-mutating
      // pipeline jobs serialise with concurrent ticks on the same
      // (profile, symbol) key.
      chain: ctx.chain,
      logger,
      // Lets the archive-grid-trade handler pull `myTrades` to sum the
      // cycle's Binance commissions per asset.
      resolveBinanceClient: ctx.resolveBinanceClient,
      // The disposal alerts the operator when it finds a resting sell on Binance
      // that our books never recorded and it therefore cannot cancel.
      notifyRegistry: ctx.notifyProviders,
      // Suppress that alert (and every other dispatch) on a demo box.
      liveDemo: ctx.liveDemo,
      // Evict the cross-tick profile-context cache on reconfigure so an
      // operator config/symbol edit lands on the next tick.
      evictProfileContext: ctx.evictProfileContext,
      // Same mutate-symbol-state deps the boot reconciler holds; lets the
      // mid-run reconfigure path reconcile heldQuantity + revive avgEntryPrice
      // for a freshly-adopted symbol without a worker restart.
      symbolStateDeps: ctx.symbolStateDeps,
      // Re-elect stream ownership right after a subscribe/unsubscribe applies,
      // so the account's user-data stream opens/closes now instead of waiting
      // for ownership's own interval (profileManager no longer opens it). #579.
      reconcileOwnership: () => ctx.subscriptionOwnership.reconcile(),
      // Retires the profile's own metric children when a teardown lands, so a
      // stopped profile stops exporting a live-looking reading.
      metrics: ctx.metrics,
    });

    // Consumer for the deferred position-repair jobs the decision handlers and
    // the user-stream watchdog enqueue. Without it a discovered-but-unadopted
    // fill piles up in `bull:symbol-reconcile:wait` and the position stays
    // mis-stated until the backstop cron's next pass.
    registerSymbolReconcileWorker(queueSet, {
      logger,
      listActive: ctx.listActive,
      fillBackfiller: ctx.fillBackfiller,
      reconcileDeps: ctx.reconcileDeps,
    });
  }

  // Backtest + advisor consumers. On the `study` role these are the only
  // consumers this process runs, so heavy historical replays never share the
  // live trading event loop. Klines are public market data, so use a keyless
  // governor-wired client against live (real historical candles).
  if (runsStudy) {
    // Reclaim advisor rows stranded `running` by a lost/dead generation job
    // before any terminal write, so the polling UI stops watching them forever.
    // Per-failure isolated like the sweeps above.
    try {
      await runStaleAdvisorSweep({ db: ctx.db, logger });
    } catch (err) {
      logger.error({ err }, 'staleAdvisorSweep: boot sweep failed; continuing');
    }

    // The boot sweep only reclaims rows already stale AT boot. A study worker
    // hard-killed mid-generation leaves a `running` row too fresh for the NEXT
    // boot sweep to reclaim, so the UI polls it forever and Regenerate no-ops.
    // Crons run in the live role only, so this study-role interval is the seam
    // that reclaims it. Pushed onto the heartbeat timers so the same shutdown
    // clear disposes it (it is already unref'd).
    heartbeatTimers.push(startPeriodicAdvisorSweep({ db: ctx.db, logger }));

    const backtestKlines = createBinanceRest({
      mode: 'live',
      credentials: { apiKey: '', secretKey: '' },
      weightGovernor: ctx.weightGovernor,
    });
    // One cache for the whole process: the technicals signal (minus its read-time
    // timestamp) is config-independent, so separate backtest runs over the same
    // window share derived signals instead of each recomputing the series (the
    // dominant per-tick cost on low-power hosts).
    const signalCache = new LruSignalCache();
    // Same rationale for the source candles: separate runs over the same window
    // replay the same candles, so load + materialise them once for the process
    // instead of per run.
    const candleCache = new LruCandleCache();
    registerBacktestWorker(queueSet, {
      db: ctx.db,
      redis,
      clock: { nowMs: () => Date.now() },
      logger,
      notifyEvent: ctx.notifyEvent,
      ...(ctx.publicWebUrl ? { publicWebUrl: ctx.publicWebUrl } : {}),
      concurrency: ctx.workerEnv.BACKTEST_CONCURRENCY,
      run: createRunBacktestJob({
        db: ctx.db,
        logger,
        getKlines: backtestKlines.getKlines,
        getSymbolInfo: ctx.getSymbolInfo,
        strategies: ctx.strategies,
        clock: { nowMs: () => Date.now() },
        signalCache,
        candleCache,
        cpuShare: studyCpuShare,
      }),
    });

    // Background config-advisor consumer. Study-role only so an Anthropic
    // round-trip never shares the live trading event loop. Idempotency is the
    // durable advisor row (not a jobId); when no credential is configured the
    // handler completes rows `error`/`not-configured` rather than calling a
    // client that would reject.
    registerAdvisorWorker(queueSet, {
      db: ctx.db,
      logger,
      resolveLlm,
      strategies: ctx.strategies,
    });
  }

  // adminServer comes up AFTER lifecycles + workers so its readiness
  // probe answers "ready" the moment the worker is actually ready. It
  // is NOT a `Component`: it has to be up first for the readiness probe
  // to answer "starting", and stays up until last to keep the drain
  // debuggable — the lifecycle Component contract would invert that
  // ordering.
  // Same registry the tick + state-commit paths record onto (built in
  // buildBootContext), so /metrics serves the worker's domain series.
  const adminServer = startAdminServer(
    { logger, pool, redis, metrics: ctx.metricsRegistry },
    env.adminPort,
    env.adminHost,
  );
  // Boot is complete. Advertise ownership-eligibility for LIVE-role pods ONLY.
  // The study pod registers + heartbeats (so the fleet count still sees it) but
  // runs no userStreamPool (`subscriptionOwnership.start()` below is runsLive-
  // gated), so if it marked ready the HRW owner election could hand it an
  // account's user-data stream that nothing would ever open — an orphaned stream
  // whose fills are never adopted (#640). Owner election considers only READY
  // members, so leaving study un-ready excludes it from ownership by construction.
  if (runsLive) await memberRegistry.markReady();

  // Now that this pod is a ready member, elect subscription ownership: open the
  // user-data streams for accounts HRW hashes to this pod, close any it does not
  // own, and re-run on the heartbeat cadence so a membership change re-homes.
  // Live role only — the study role has no user-data streams.
  if (runsLive) await ctx.subscriptionOwnership.start();
  // Fleet-global enabled-set converge (#579): after ownership so its first
  // pass re-elects over the boot membership, then keep membership fleet-wide as
  // runtime subscribe/unsubscribe jobs land on individual pods.
  if (runsLive) await ctx.enabledSetReconciler.start();
  logger.info({ sha: gitSha }, 'worker boot complete');

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of heartbeatTimers) clearInterval(timer);
    adminServer.markShutdown();
    // Stop the enabled-set reconciler before ownership so its next pass can't
    // re-elect (reopen) a stream after ownership is torn down. Both sync (clear
    // a timer); safe if never started.
    ctx.enabledSetReconciler.stop();
    ctx.subscriptionOwnership.stop();
    // Leave the fleet immediately (delete the member key) so ownership re-homes
    // now, not after a TTL. Time-boxed: a hung del on a degraded Redis must not
    // block the drain — the member key's TTL is the backstop.
    await Promise.race([memberRegistry.stop(), new Promise((r) => setTimeout(r, 1_000))]);
    logger.info('worker draining');
    // Signal the audit drainer to stop looping; its current pass finishes
    // within the BLOCK timeout and is not awaited (best-effort observability).
    void ctx.auditDrainer.stop();
    const deadline = Date.now() + 10_000;
    // The lifecycle components + the BullMQ queueSet are independent at
    // shutdown — race them in parallel against the 10s budget so a stuck
    // subsystem can't starve the others. `stopAll` already swallows per-
    // component stop errors so one stuck component does not abort the rest of
    // the drain, and returns the names of components whose stop threw.
    //
    // The race yields a `drained` boolean: true when the drain completed within
    // the budget, false when it timed out. Teardown is GATED on it — a timed-out
    // drain may have a tick still in-flight against the pool, and closing the pool
    // out from under it poisons that tick's state commit into a BullMQ retry that
    // re-places (double-fills) a MARKET order. See lib/shutdown-teardown.
    let stopFailures: string[] = [];
    // `allSettled` never rejects, so a rejected `queueSet.closeAll()` would still
    // resolve the race to `true` and let destructive teardown proceed — the poison
    // path. Capture that rejection (no silent failure) and fold it into the drain
    // verdict: a close failure is a non-clean drain, so teardown is skipped.
    let closeFailed = false;
    const drained = await Promise.race([
      Promise.allSettled([
        stopAll(lifecycles, logger).then((f) => {
          stopFailures = [...f];
        }),
        queueSet.closeAll().catch((err) => {
          logger.error({ err: err }, 'worker drain: queueSet close failed');
          closeFailed = true;
        }),
      ]).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), Math.max(0, deadline - Date.now()))),
    ]);
    await runTeardown({
      drained: drained && !closeFailed,
      stopFailures,
      adminServer,
      pool,
      redis,
      auditDrainerRedis: ctx.auditDrainerRedis,
      logger,
      // A composed boot must NOT call process.exit itself: apps/server runs the
      // api and worker boots under ONE installGracefulShutdown, which exits once
      // honouring process.exitCode (never process.exit(0), so it can't clobber a
      // sibling boot's failure code). Record the code; the shared handler exits.
      exit: (code) => {
        if (code !== 0) process.exitCode = code;
      },
    });
  };

  return { shutdown };
};

if (import.meta.main) {
  const { shutdown } = await boot(toBootEnv(loadWorkerEnv()));
  installGracefulShutdown([shutdown]);
}
