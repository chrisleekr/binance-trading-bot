import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
  asAccountId,
  asProfileId,
  asUserId,
  type BacktestProgressUpdate,
  type BacktestResult,
} from '@app/contracts';
import { profileRepo, repo, type Database } from '@app/db';
import type { LedgerEntry } from '@app/db';
import { BacktestCancelledError } from 'backtest/backtest-runner.js';
import { emitEvent } from 'executor/event-emitter.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';
import type { QueueSet } from './queue-set.js';
import type { BacktestJobData } from './job-payloads.js';

/**
 * Operator-facing one-liner for a finished backtest, in plain language. Profit
 * factor = gross profit / gross loss; it is null when the run took no losing
 * trades, shown as "n/a" then. Alpha vs hold = the strategy's return minus a
 * fee-free buy-and-hold of the same basket.
 */
function backtestCompleteText(symbols: readonly string[], m: BacktestResult['metrics']): string {
  const syms = symbols.join(', ');
  if (m.totalTrades === 0) {
    return `Backtest finished for ${syms}: no trades were taken over the window.`;
  }
  const pf = m.profitFactor === null ? 'n/a' : m.profitFactor.toFixed(2);
  const vsHold =
    m.alphaVsHoldPct >= 0
      ? `beat buy-and-hold by ${m.alphaVsHoldPct.toFixed(2)}%`
      : `lagged buy-and-hold by ${Math.abs(m.alphaVsHoldPct).toFixed(2)}%`;
  return `Backtest finished for ${syms}: ${m.totalTrades} trades, profit factor ${pf}, ${vsHold}.`;
}

export interface BacktestWorkerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly clock: { nowMs(): number };
  readonly logger: Logger;
  /**
   * Fan-out to the profile's Slack/Telegram/webhook notifiers on completion.
   * Gated by the profile's `backtest-complete` subscription; never throws.
   */
  readonly notifyEvent: NotifyEvent;
  /**
   * Public base URL (from `PUBLIC_WEB_URL`) used to build a tap-through link to
   * the finished run's results. Omitted when unset — the notification still
   * sends, just without the link.
   */
  readonly publicWebUrl?: string;
  /**
   * Max concurrent replays (from `BACKTEST_CONCURRENCY`). Overrides the queue
   * spec's default so a shared-core dev box can throttle CPU-bound replays.
   */
  readonly concurrency?: number;
  /**
   * Runs the backtest and returns the result, reporting progress (0-100) via
   * the callback. Injected so the worker handler — the queue/persist/progress
   * contract — is tested without the heavy engine; production wires
   * {@link runProfileBacktest}.
   */
  readonly run: (
    runId: string,
    userId: string,
    accountId: string,
    profileId: string,
    onProgress: (update: BacktestProgressUpdate) => void,
    shouldCancel: () => boolean,
  ) => Promise<{ result: BacktestResult; configFingerprint: string; ledgerEntry: LedgerEntry }>;
}

/**
 * Register the single-job `backtest` worker. The durable `backtest_runs` row
 * is the source of truth (markRunning → updateProgress → complete/fail); a WS
 * `backtest-progress`/`backtest-complete` event is the live overlay an open UI
 * uses without polling. On failure the row is marked `error` and the job
 * rethrows so the queue-set routes it to the DLQ.
 */
export function registerBacktestWorker(queueSet: QueueSet, deps: BacktestWorkerDeps): void {
  const eventDeps = { redis: deps.redis, clock: deps.clock };

  const processor = async (job: Job<BacktestJobData>) => {
    const { runId } = job.data;
    const userId = asUserId(job.data.userId);
    const accountId = asAccountId(job.data.accountId);
    const profileId = asProfileId(job.data.profileId);

    // The whole body is inside the try so a failure BEFORE the run is scoped
    // (the `profileRepo` ownership lookup or `markRunning` throwing on a
    // transient DB blip) still marks the row `error` rather than stranding it
    // `queued` forever. The catch marks via the global `failById` because
    // a pre-scope failure has no `ProfileScope` to use.
    try {
      const p = await profileRepo(deps.db, userId, accountId, profileId);

      // Idempotency guard: a retry firing after the run already completed must
      // not re-run. markRunning leaves a `done` row untouched and reports false,
      // so we ack without reprocessing. An `error`/`running` row stays runnable,
      // so BullMQ's retry budget still re-drives transient failures and crashes.
      if (!(await p.backtestRuns.markRunning(runId))) {
        deps.logger.info({ runId }, 'backtest run already complete; skipping retry');
        return;
      }

      // Poll the run status so a cancel issued out-of-band (the abort endpoint
      // sets status='cancelled') is noticed mid-replay. unref so it never holds
      // the process open; the flag is read cheaply on each progress callback
      // inside the engine's replay loop.
      let cancelled = false;
      const cancelPoll = setInterval(() => {
        void p.backtestRuns
          .get(runId)
          .then((r) => {
            if (r?.status === 'cancelled') cancelled = true;
          })
          .catch(() => undefined);
      }, 2000);
      cancelPoll.unref?.();

      try {
        const { result, configFingerprint, ledgerEntry } = await deps.run(
          runId,
          job.data.userId,
          job.data.accountId,
          job.data.profileId,
          (update) => {
            // Fire-and-forget progress: a dropped update is recovered by the next
            // tick or the final complete, so never let it fail the run. `pct` is
            // the integer column; the rest is the phase/count detail.
            const { pct, ...detail } = update;
            void p.backtestRuns.updateProgress(runId, pct, detail).catch(() => undefined);
            void emitEvent(eventDeps, accountId, profileId, 'backtest-progress', {
              runId,
              ...update,
            }).catch(() => undefined);
          },
          () => cancelled,
        );

        // Stamp the signature of the config that actually ran (built from the
        // config read fresh at pickup), not the POST-time signature. This is the
        // dedup key a later identical re-run matches on.
        await p.backtestRuns.complete(
          runId,
          result,
          configFingerprint,
          ledgerEntry.backtestSignature,
        );
        // Durable results ledger: record the outcome keyed by full backtest
        // signature so a later identical re-run can reuse it even after the run
        // is deleted. Best-effort — the run is already complete, so a write
        // failure must never fail the run. A cancelled run takes the catch branch
        // above and never reaches here.
        await p.resultLedger
          .upsert(ledgerEntry)
          .catch((err: unknown) =>
            deps.logger.error(
              { runId, err: err },
              'result-ledger upsert failed; outcome not recorded for dedup',
            ),
          );
        await emitEvent(eventDeps, accountId, profileId, 'backtest-complete', { runId }).catch(
          () => undefined,
        );

        // Push to the operator's channels (Slack/Telegram/webhook) that a
        // backtest finished. Best-effort: notifyEvent gates on the profile's
        // subscription and swallows its own failures, so an already-complete run
        // never fails on a notify miss.
        const finished = await p.backtestRuns.get(runId).catch(() => null);
        if (finished) {
          const m = result.metrics;
          const fields =
            m.totalTrades === 0
              ? undefined
              : [
                  { label: 'Trades', value: String(m.totalTrades) },
                  {
                    label: 'Profit factor',
                    value: m.profitFactor === null ? 'n/a' : m.profitFactor.toFixed(2),
                  },
                  {
                    label: 'vs buy-and-hold',
                    value: `${m.alphaVsHoldPct >= 0 ? '+' : ''}${m.alphaVsHoldPct.toFixed(2)}%`,
                  },
                ];
          // Guard on the value (matching every other emit site) so the spread
          // narrows to `string`, not `string | undefined`.
          const symbol = finished.symbols.length === 1 ? finished.symbols[0] : undefined;
          await deps.notifyEvent({
            category: 'backtest-complete',
            operatorId: userId,
            accountId,
            profileId,
            body: backtestCompleteText(finished.symbols, result.metrics),
            ...(symbol ? { symbol } : {}),
            ...(fields ? { fields } : {}),
            ...(deps.publicWebUrl
              ? {
                  link: `${deps.publicWebUrl}/accounts/${accountId}/profiles/${profileId}/backtest?run=${runId}`,
                }
              : {}),
          });
        }
      } finally {
        clearInterval(cancelPoll);
      }
    } catch (err) {
      // The cancel endpoint already set status='cancelled'; do not failById
      // (would clobber cancelled→error) and do not rethrow (no DLQ/retry). Just
      // emit the complete event so an open UI stops showing the run as running.
      if (err instanceof BacktestCancelledError) {
        await emitEvent(eventDeps, accountId, profileId, 'backtest-complete', { runId }).catch(
          () => undefined,
        );
        deps.logger.warn({ runId }, 'backtest run cancelled mid-flight');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await repo.backtestRuns
        .failById(deps.db, runId, message)
        .catch((failErr: unknown) =>
          deps.logger.error(
            { runId, err: failErr },
            'backtest run: could not mark run errored; stale-run sweep will reconcile',
          ),
        );
      await emitEvent(eventDeps, accountId, profileId, 'backtest-complete', { runId }).catch(
        () => undefined,
      );
      deps.logger.warn({ runId, err }, 'backtest run failed');
      throw err; // surface to the queue-set failed handler → DLQ
    }
  };

  queueSet.registerWorker<BacktestJobData>('backtest', processor, deps.concurrency);
}
