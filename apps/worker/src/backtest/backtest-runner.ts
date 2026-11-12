import type { Logger } from 'pino';
import type { BacktestParams, BacktestProgressUpdate, BacktestResult } from '@app/contracts';
import { repo, type Database } from '@app/db';
import type { BinanceRestClient } from '@app/binance';
import type { AnyStrategy, Candle, StrategyRegistry, SymbolInfo } from '@app/strategy-core';
import { canonicalSymbols } from '@app/strategy-backtest';
import { backfillCandles } from './candle-backfill.js';
import { replayIntervalMs, replayIntervals, replayPrepared, sharedQuoteAsset } from './replay.js';
import { TECHNICALS_SOURCE_CANDLE_LIMIT } from 'technicals/rating-window.js';

export interface BacktestRunnerDeps {
  readonly db: Database;
  /** Governor-wired, keyless klines fetch for candle backfill. */
  readonly getKlines: BinanceRestClient['getKlines'];
  readonly getSymbolInfo: (symbol: string) => Promise<SymbolInfo>;
  readonly strategies: StrategyRegistry;
  readonly clock: { nowMs(): number };
  readonly logger: Logger;
  /** Fraction of one core the replay may use, in (0, 1]. Under ROLE=all the replay shares the event loop with api and live trading, so a share below 1 makes it sleep at its yield points. Omitted means full speed. */
  readonly cpuShare?: number;
  /** The deployed build recorded on the result, or `unknown`. */
  readonly buildId: string;
}

export interface RunProfileBacktestArgs {
  readonly params: BacktestParams;
  readonly strategyName: string;
  /** The config frozen when the run was submitted; the profile is not read again. */
  readonly effectiveConfig: unknown;
  /** Throttled progress callback: percent plus phase/count detail. */
  readonly onProgress?: (update: BacktestProgressUpdate) => void;
  /** Cooperative-cancellation probe, checked on every replayed frame. When it returns true the replay rejects with `BacktestCancelledError`. */
  readonly shouldCancel?: () => boolean;
}

const rowToCandle = (r: {
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}): Candle => ({
  openTimeMs: r.openTime.getTime(),
  closeTimeMs: r.closeTime.getTime(),
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  isClosed: true,
});

/**
 * Ensure the candle store covers a run, load its series fresh from the store, and replay it. Every native window loads the same config-independent horizon, so changing an indicator period cannot change the data a run is fingerprinted over.
 *
 * @param deps - Candle store, exchange access and the strategy registry.
 * @param args - The run's parameters and its frozen config.
 * @returns The wire result and the fingerprint of the config it executed.
 */
export async function runProfileBacktest(
  deps: BacktestRunnerDeps,
  args: RunProfileBacktestArgs,
): Promise<{ result: BacktestResult; configFingerprint: string }> {
  const { params } = args;
  const strategy = deps.strategies.get(args.strategyName);
  if (!strategy) throw new Error(`unknown strategy: ${args.strategyName}`);
  const config = strategy.configSchema.parse(args.effectiveConfig);

  const symbols = canonicalSymbols(params.symbols);
  const symbolInfos = await Promise.all(symbols.map((s) => deps.getSymbolInfo(s)));
  sharedQuoteAsset(symbolInfos);

  const { nativeIntervals, detailInterval } = replayIntervals(config, params);
  const fromMsOf = new Map<string, number>([[detailInterval, params.fromMs]]);
  for (const interval of nativeIntervals) {
    fromMsOf.set(
      interval,
      params.fromMs - TECHNICALS_SOURCE_CANDLE_LIMIT * replayIntervalMs(interval),
    );
  }

  const candlesByKey = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    args.onProgress?.({ pct: 0, phase: 'backfill', symbol });
    for (const [interval, fromMs] of fromMsOf) {
      await backfillCandles(
        {
          getKlines: deps.getKlines,
          findGaps: (s, i, f, t) => repo.candles.findGaps(deps.db, s, i, f, t),
          insertCandles: (rows) => repo.candles.insertNew(deps.db, rows),
          clock: deps.clock,
          logger: deps.logger,
        },
        { symbol, interval, fromMs, toMs: params.toMs },
      );
      // `getRange` is inclusive at the top, and a bar opening at `toMs` is outside the run.
      const rows = await repo.candles.getRange(
        deps.db,
        symbol,
        interval,
        new Date(fromMs),
        new Date(params.toMs - 1),
      );
      candlesByKey.set(`${symbol}|${interval}`, rows.map(rowToCandle));
    }
  }

  return replayPrepared({
    strategy: strategy as AnyStrategy,
    config,
    params,
    symbolInfos,
    candlesByKey,
    buildId: deps.buildId,
    ...(deps.cpuShare !== undefined ? { cpuShare: deps.cpuShare } : {}),
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    ...(args.shouldCancel ? { shouldCancel: args.shouldCancel } : {}),
  });
}
