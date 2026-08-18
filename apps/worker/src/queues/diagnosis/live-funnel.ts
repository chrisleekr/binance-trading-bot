// Re-derive the discovery funnel against the exchange, right now.
//
// The stored snapshot answers "where did candidates die at the last scan",
// which can be a full refresh period old. This answers "where do they die
// now" — the difference between reading a report and taking a measurement.
//
// It drives the SAME pure chain the cron drives, from the same shortlist
// helper, so a disagreement between this and the stored funnel means the market
// moved, never that two implementations diverged. Nothing here writes: no
// symbol is bound or reaped, no snapshot is persisted, no cooldown is stamped.
//
// The cost is real and per-account: one all-symbols ticker plus a bounded kline
// walk, through the same weight governor the cron uses, so a probe queues
// behind live trading rather than competing with it.

import type { Logger } from 'pino';
import type { StoredDiscoveryConfig } from '@app/contracts';
import type { Candle } from '@app/strategy-core';
import type { BinanceMode, ParsedKline, Ticker24hrDto } from '@app/binance';
import {
  explainDiscovery,
  marketBreadthOk,
  projectFunnel,
  shortlistByTicker,
  tickerStageCounts,
  type DiscoveryFunnel,
} from '@app/discovery';
import { fanOutBounded } from '@app/core/fan-out';
import { toPureConfig } from 'crons/discovery/config.js';
import type { SymbolAdmission } from 'crons/discovery/symbol-admission.js';
import { validateAssetPolicy, type AssetPolicy } from 'crons/discovery/asset-policy.js';
import { dropFormingCandle, selectKlineTargets } from 'crons/discovery/run.js';
import {
  resolveQuoteUsdPrice,
  toDiscoveryTickers,
  USD_REFERENCE_QUOTE,
} from 'crons/discovery/quote-price.js';

// Half the cron's 8. Concurrency changes pacing, not the result, and a
// diagnostic must never be the thing that crowds live trading out of the shared
// per-IP weight budget.
const KLINE_CONCURRENCY = 4;

export interface LiveFunnelDeps {
  readonly getAllTickers: () => Promise<readonly Ticker24hrDto[]>;
  readonly getKlines: (symbol: string, limit: number) => Promise<readonly ParsedKline[]>;
  /** The account's Binance environment; testnet has its own, smaller universe. */
  readonly mode: BinanceMode;
  /** exchangeInfo admission facts per symbol, for the mode this profile trades in. */
  readonly symbolAdmission: () => Promise<ReadonlyMap<string, SymbolAdmission>>;
  /** The LIVE exchangeInfo map, which the asset classification is cross-checked against whatever mode the profile trades in. Identical to `symbolAdmission` for a live account. */
  readonly liveSymbolAdmission: () => Promise<ReadonlyMap<string, SymbolAdmission>>;
  /** Binance's stablecoin/fiat classification, from the same per-process snapshot the cron reads, so the probe and the cron cannot classify an asset differently. */
  readonly assetPolicy: () => Promise<AssetPolicy>;
  /**
   * Permission tags cached for the account. Empty means unknown, which keeps the
   * permission cut disabled, matching what the cron would have done.
   */
  readonly accountPermissions: () => Promise<readonly string[]>;
  /** Symbols discovery currently holds for this profile. */
  readonly autoSymbols: readonly string[];
  /** Symbols the operator pinned; discovery never re-adopts these. */
  readonly manualSymbols: readonly string[];
  readonly logger: Logger;
  readonly nowMs: number;
}

/**
 * Re-derive the funnel, or return null when the probe could not complete.
 *
 * Null rather than a throw or a partial funnel: a probe is an enhancement over
 * the stored scan, and losing it must downgrade the answer's freshness, never
 * fail the investigation the operator is waiting on.
 */
export const probeLiveFunnel = async (
  deps: LiveFunnelDeps,
  stored: StoredDiscoveryConfig,
  quoteAsset: string,
): Promise<DiscoveryFunnel | null> => {
  try {
    const cfg = toPureConfig(stored, quoteAsset);
    const rawTickers = await deps.getAllTickers();
    const quoteUsdPrice = resolveQuoteUsdPrice(rawTickers, cfg.quoteAsset);
    if (quoteUsdPrice === null) {
      deps.logger.warn(
        { quoteAsset: cfg.quoteAsset },
        `diagnosis: cannot price the quote asset in ${USD_REFERENCE_QUOTE}; using the stored funnel`,
      );
      return null;
    }
    const admission = await deps.symbolAdmission();
    // Same fail-closed rule the discovery cron applies, for the same reason: an empty admission map leaves the universe UNFILTERED, which is a confident second opinion about a universe the profile does not trade. The stored scan is the honest answer.
    if (admission.size === 0) {
      deps.logger.warn(
        { mode: deps.mode },
        'diagnosis: exchangeInfo not primed; using the stored funnel (fail closed)',
      );
      return null;
    }
    // Must mirror the cron's cuts exactly, permission filter and asset policy included: a probe that scored a symbol the cron never admits would report a candidate the operator can never get, and one that skipped the asset policy would report a funnel the cron never had.
    const assetPolicy = await deps.assetPolicy();
    // One keyspace read when the account is already live, mirroring the cron. Two scans of ~1400 keys are not just wasted round trips: `exchange-info-refresh` can land between them, and the probe would then validate against a different snapshot from the one it filtered the universe with.
    const live = deps.mode === 'live' ? admission : await deps.liveSymbolAdmission();
    const unclassifiedSymbols = validateAssetPolicy(assetPolicy, live);
    const tickers = toDiscoveryTickers(rawTickers, cfg.quoteAsset, quoteUsdPrice, {
      admissionBySymbol: admission,
      assetPolicy,
      unclassifiedSymbols,
      accountPermissions: await deps.accountPermissions(),
      logger: deps.logger,
    });
    const shortlist = shortlistByTicker(tickers, cfg);
    const limit = Math.min(1000, cfg.minAgeDays * 24 + 50);
    const targets = selectKlineTargets(shortlist, deps.autoSymbols, cfg.maxAutoSymbols);
    // `collect`, not `fail-fast`: the cron refuses partial klines because a
    // symbol missing its window would read as faded and be REAPED. This probe
    // reaps nothing, so a few missing windows cost accuracy in the candidate
    // ladder rather than risking a position, and answering with most of the
    // picture beats answering with none of it.
    const fetched = await fanOutBounded(
      targets,
      async (symbol) => [symbol, await deps.getKlines(symbol, limit)] as const,
      { concurrency: KLINE_CONCURRENCY, onError: 'collect' },
    );
    if (fetched.errors.length > 0) {
      deps.logger.warn(
        { failed: fetched.errors.length, of: targets.length },
        'diagnosis: some kline windows could not be fetched; candidate ladder is partial',
      );
    }
    // Partial is a cost; empty is a false reading. `oldEnough` answers false for
    // a symbol with no window, so losing EVERY window scores the whole shortlist
    // as failing the age cut: a candidate ladder of straight zeroes, labelled as
    // just checked against the exchange, blaming a filter that never ran. The
    // stored scan is the honest answer.
    if (targets.length > 0 && fetched.ok.length === 0) {
      deps.logger.warn(
        { of: targets.length },
        'diagnosis: no kline window could be fetched; using the stored funnel (fail closed)',
      );
      return null;
    }
    const klinesBySymbol: Record<string, readonly Candle[]> = Object.fromEntries(
      fetched.ok.map(([symbol, window]) => [
        symbol,
        dropFormingCandle(
          window.map((k): Candle => ({ ...k, isClosed: true })),
          deps.nowMs,
        ),
      ]),
    );
    const explained = explainDiscovery({
      tickers,
      klinesBySymbol,
      // Cooldowns are deliberately not read. They gate whether a symbol may be
      // re-added, not whether it clears a filter, so the only counts they move
      // are the diff-derived ones (`added`/`kept`/`removed`), and the diagnosis
      // builds its history strip from stored scans, never from a probe. The
      // ladder it reports is untouched by them.
      currentAuto: deps.autoSymbols.map((symbol) => ({ symbol, addedAtMs: 0 })),
      lastFlattenAtMsBySymbol: {},
      manualMembers: deps.manualSymbols,
      config: cfg,
      nowMs: deps.nowMs,
    });
    return projectFunnel(
      explained.candidates,
      explained.diff,
      marketBreadthOk(tickers, cfg),
      tickerStageCounts(tickers, cfg),
      // Only the candidates that actually got a window. A partial fetch leaves
      // the rest scored as failing the age cut, and counting them here would
      // report a Binance outage as a filter the operator should loosen.
      explained.candidates.filter((c) => Object.hasOwn(klinesBySymbol, c.symbol)).length,
    );
  } catch (err) {
    deps.logger.warn({ err: err }, 'diagnosis: live funnel probe failed; using the stored funnel');
    return null;
  }
};
