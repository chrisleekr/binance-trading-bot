// The `backtest` queue's run callback: load the durable run, replay its frozen config over the window, and build the ledger entry the caller persists.
//
// This is backtest DOMAIN logic, not boot wiring — it re-validates stored params, replays the window, and stamps the ledger signature. It lives here rather than inline in the worker entrypoint so `index.ts` stays the orchestrator it declares itself to be, and so a ledger-shape change edits a backtest module instead of the boot file.

import type { Logger } from 'pino';
import type { BinanceRestClient } from '@app/binance';
import {
  asAccountId,
  asProfileId,
  asUserId,
  BacktestStoredParamsSchema,
  marketOf,
  type BacktestProgressUpdate,
  type BacktestResult,
} from '@app/contracts';
import { profileRepo, type Database, type LedgerEntry } from '@app/db';
import {
  BACKTEST_ENGINE_REVISION,
  signatureForBacktest,
  type StrategyRegistry,
  type SymbolInfo,
} from '@app/strategy-core';

import { runProfileBacktest } from 'backtest/backtest-runner.js';

export interface RunBacktestJobDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Governor-wired, keyless klines fetch for candle backfill. */
  readonly getKlines: BinanceRestClient['getKlines'];
  readonly getSymbolInfo: (symbol: string) => Promise<SymbolInfo>;
  readonly strategies: StrategyRegistry;
  readonly clock: { nowMs(): number };
  /** Fraction of one core a replay may use; throttled under ROLE=all. */
  readonly cpuShare: number;
  /** The deployed build, or `unknown`. A queued run frozen on another build cannot be replayed. */
  readonly buildId: string;
}

export interface RunBacktestJobResult {
  readonly result: BacktestResult;
  readonly configFingerprint: string;
  readonly ledgerEntry: LedgerEntry;
}

const RESUBMIT_HINT = 'resubmit the backtest to run it on the current version';

// `unknown` on either side means the build cannot be told apart, so it executes and the result is simply never comparable.
const sameBuild = (a: string, b: string): boolean => a === 'unknown' || b === 'unknown' || a === b;

/**
 * Build the `run` callback `registerBacktestWorker` invokes per job. Throws on a missing run, a run that cannot be replayed faithfully, or an unknown strategy; the queue marks the row `error` and routes to the DLQ.
 *
 * @param deps - The candle store, exchange access, strategy registry and build id.
 * @returns The per-job callback.
 */
export const createRunBacktestJob =
  (deps: RunBacktestJobDeps) =>
  async (
    runId: string,
    operatorId: string,
    accountId: string,
    profileId: string,
    onProgress: (update: BacktestProgressUpdate) => void,
    shouldCancel: () => boolean,
  ): Promise<RunBacktestJobResult> => {
    const p = await profileRepo(
      deps.db,
      asUserId(operatorId),
      asAccountId(accountId),
      asProfileId(profileId),
    );
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new Error(`backtest run not found: ${runId}`);
    // Re-validate the stored row rather than trusting the jsonb: one queued before the snapshot existed cannot be executed, because its config was never frozen.
    const parsed = BacktestStoredParamsSchema.safeParse(run.params);
    if (!parsed.success) {
      throw new Error(`backtest run ${runId} predates frozen configs; ${RESUBMIT_HINT}`);
    }
    const { snapshot, ...params } = parsed.data;
    const strategy = deps.strategies.get(snapshot.strategyName);
    if (!strategy) throw new Error(`unknown strategy: ${snapshot.strategyName}`);
    if (
      snapshot.strategyVersion !== strategy.version ||
      snapshot.engineRevision !== BACKTEST_ENGINE_REVISION ||
      !sameBuild(snapshot.buildId, deps.buildId)
    ) {
      throw new Error(`backtest run ${runId} was queued on another version; ${RESUBMIT_HINT}`);
    }
    const { result, configFingerprint } = await runProfileBacktest(
      {
        db: deps.db,
        getKlines: deps.getKlines,
        getSymbolInfo: deps.getSymbolInfo,
        strategies: deps.strategies,
        clock: deps.clock,
        logger: deps.logger,
        cpuShare: deps.cpuShare,
        buildId: deps.buildId,
      },
      {
        params,
        strategyName: snapshot.strategyName,
        effectiveConfig: snapshot.effectiveConfig,
        onProgress,
        shouldCancel,
      },
    );
    const contextFingerprint = result.simulation?.contextFingerprint ?? null;
    // The frozen config already carries the override, so it is not applied twice.
    const { signature, config: effectiveConfig } = signatureForBacktest({
      strategyId: snapshot.strategyName,
      parseConfig: (c) => strategy.configSchema.parse(c),
      profileConfig: snapshot.effectiveConfig,
      override: null,
      market: { ...marketOf(params), contextFingerprint },
    });
    const ledgerEntry: LedgerEntry = {
      backtestSignature: signature,
      configFingerprint,
      strategyId: snapshot.strategyName,
      symbols: params.symbols,
      window: {
        fromMs: params.fromMs,
        toMs: params.toMs,
        interval: params.strategyInterval,
        contextFingerprint,
      },
      params: effectiveConfig,
      // The full metrics block (no heavy series) so a cached trial can be scored against any objective. `gatePassed` is objective-relative, so it is derived at read time, not stored.
      outcome: result.metrics,
    };
    return { result, configFingerprint, ledgerEntry };
  };
