// The `backtest` queue's run callback: load the durable run + profile, replay
// the strategy over the window, and build the ledger entry the caller persists.
//
// This is backtest DOMAIN logic, not boot wiring — it re-validates stored
// params, assembles the per-symbol reserve overlay, and stamps the ledger
// signature. It lives here rather than inline in the worker entrypoint so
// `index.ts` stays the orchestrator it declares itself to be, and so a
// ledger-shape change edits a backtest module instead of the boot file.

import type { Logger } from 'pino';
import type { BinanceRestClient } from '@app/binance';
import {
  asAccountId,
  asProfileId,
  asUserId,
  BacktestParamsSchema,
  marketOf,
  type BacktestProgressUpdate,
  type BacktestResult,
} from '@app/contracts';
import { profileRepo, type Database, type LedgerEntry } from '@app/db';
import { signatureForBacktest, type StrategyRegistry, type SymbolInfo } from '@app/strategy-core';

import { runProfileBacktest } from 'backtest/backtest-runner.js';
import type { LruCandleCache } from 'backtest/candle-cache.js';
import type { LruSignalCache } from 'backtest/signal-cache.js';

export interface RunBacktestJobDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Governor-wired, keyless klines fetch for candle backfill. */
  readonly getKlines: BinanceRestClient['getKlines'];
  readonly getSymbolInfo: (symbol: string) => Promise<SymbolInfo>;
  readonly strategies: StrategyRegistry;
  readonly clock: { nowMs(): number };
  /** Process-wide caches shared across runs over the same window. */
  readonly signalCache: LruSignalCache;
  readonly candleCache: LruCandleCache;
  /** Fraction of one core a replay may use; throttled under ROLE=all. */
  readonly cpuShare: number;
}

export interface RunBacktestJobResult {
  readonly result: BacktestResult;
  readonly configFingerprint: string;
  readonly ledgerEntry: LedgerEntry;
}

/**
 * Build the `run` callback `registerBacktestWorker` invokes per job. Throws on a
 * missing run, missing profile, malformed params, or unknown strategy — the
 * queue marks the row `error` and routes to the DLQ.
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
    const profile = await p.profile.findById();
    if (!profile) throw new Error(`profile not found for backtest run: ${runId}`);
    // Re-validate the stored params: the durable row is read minutes after the
    // API validated it, so parse defensively rather than trusting the jsonb — a
    // malformed row fails cleanly instead of deref-ing deep in the engine.
    const params = BacktestParamsSchema.parse(run.params);
    // Per-symbol base reserves (profile_symbols), so backtest sell-sizing
    // mirrors the live per-tick reserve overlay. Absent → null (no reserve).
    const reserveBySymbol = new Map(
      await Promise.all(
        params.symbols.map(
          async (s) =>
            [s, (await p.profileSymbols.findForSymbol(s))?.reserveBaseQuantity ?? null] as const,
        ),
      ),
    );
    const { result, configFingerprint } = await runProfileBacktest(
      {
        db: deps.db,
        getKlines: deps.getKlines,
        getSymbolInfo: deps.getSymbolInfo,
        strategies: deps.strategies,
        clock: deps.clock,
        logger: deps.logger,
        signalCache: deps.signalCache,
        candleCache: deps.candleCache,
        cpuShare: deps.cpuShare,
      },
      {
        params,
        strategyName: profile.strategyName,
        profileConfig: profile.config,
        reserveBySymbol,
        onProgress,
        shouldCancel,
      },
    );
    // Build the durable ledger entry through the shared signature seam so the
    // worker stamp and any later re-run dedup key off one identical signature.
    // runProfileBacktest already resolved this strategy (it throws on an unknown
    // one), so this lookup cannot miss; the guard is for the type.
    const strategy = deps.strategies.get(profile.strategyName);
    if (!strategy) throw new Error(`unknown strategy: ${profile.strategyName}`);
    const { signature, config: effectiveConfig } = signatureForBacktest({
      strategyId: profile.strategyName,
      parseConfig: (c) => strategy.configSchema.parse(c),
      profileConfig: profile.config,
      override: params.strategyConfigOverride ?? null,
      market: marketOf(params),
    });
    const ledgerEntry: LedgerEntry = {
      backtestSignature: signature,
      configFingerprint,
      strategyId: profile.strategyName,
      symbols: params.symbols,
      window: { fromMs: params.fromMs, toMs: params.toMs, interval: params.strategyInterval },
      params: effectiveConfig,
      // The full metrics block (no heavy series) so a cached trial can be scored
      // against ANY objective (sortino/calmar/sqn/...) and priors can read any
      // objective metric. `gatePassed` is objective-relative, so it is derived at
      // read time, not stored.
      outcome: result.metrics,
    };
    return { result, configFingerprint, ledgerEntry };
  };
