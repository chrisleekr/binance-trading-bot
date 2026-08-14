// One profile's discovery cycle: fetch the market, run the pure chain, apply the
// diff. All I/O is injected via `DiscoveryProfilePort` so the orchestration is
// unit-testable without a real Binance / Redis / DB. The downward imports
// (config → quote-price → apply) keep this the hub and the leaves dependency-free.

import type { Ticker24hrDto } from '@app/binance';
import {
  explainDiscovery,
  marketBreadthOk,
  projectFunnel,
  shortlistByTicker,
  tickerStageCounts,
  type CandidateExplain,
  type DiscoveryFunnel,
  type SiblingConflictDisposition,
} from '@app/discovery';
import type { DiscoveryUniverseSnapshotPayload } from '@app/db';
import { fanOutBounded } from '@app/core/fan-out';
import type { Candle } from '@app/strategy-core';
import type { StoredDiscoveryConfig } from '@app/contracts';
import type { Logger } from 'pino';
import type { SiblingConflict } from '../sibling-conflict.js';
import { toPureConfig } from './config.js';
import { resolveQuoteUsdPrice, toDiscoveryTickers, USD_REFERENCE_QUOTE } from './quote-price.js';
import type { SymbolAdmission } from './symbol-admission.js';
import type { DiscoveryAddOutcome } from './apply.js';
import type { DiscoveryNotifyAction } from './notify.js';

// Compile-time guard on the DiscoveryFunnel structural twin. @app/db redeclares
// the funnel shape locally so it need not depend on @app/discovery. The
// persistSnapshot call below already proves the funnel is assignable one way
// (@app/discovery -> @app/db); this arrow proves the reverse (@app/db ->
// @app/discovery), so a field added on one side but not the other fails typecheck
// here rather than silently drifting. No runtime effect (worker __tests__ are
// excluded from tsc, so this lives in src, next to the forward assignment).
const _funnelTwinReverse = (
  f: NonNullable<DiscoveryUniverseSnapshotPayload['funnel']>,
): DiscoveryFunnel => f;
void _funnelTwinReverse;

// Bounded concurrency for the per-symbol kline fetch. Each getKlines is weight 2
// under the shared per-IP weight governor, so 8 in flight is far under the
// ceiling; the governor stays the 429 backstop. Matches the technicals cron's
// constant.
const KLINE_CONCURRENCY = 8;

/**
 * Drop the trailing still-forming candle. `createBinanceRest.getKlines` returns
 * the current, not-yet-closed interval as the last row (unlike fetchClosedKlines,
 * which already trims it). Its partial volume sinks the trend-confirm
 * volume-participation check (a fraction of an hour measured against the
 * full-hour average) and skews EMA/ADX, so the indicators must read closed
 * candles only. Closed == the interval end is in the past.
 */
const dropFormingCandle = (window: readonly Candle[], nowMs: number): readonly Candle[] =>
  window.filter((c) => c.closeTimeMs < nowMs);

/**
 * Build the discovery entry-hint payload (#473; refreshed for every managed
 * symbol each cycle in #486). Carries the `enterOnAdd` flag (whether the buy
 * gate is relaxed on a discovery add) plus the current 24h high and the
 * anti-chase guard params, so the strategy's guards read a per-cycle-fresh
 * reference rather than an add-time snapshot. A symbol missing from the ticker
 * feed has no `high24h`; the chase guard then no-ops.
 */
const buildEntryHintValue = (
  at: number,
  enterOnAdd: boolean,
  high24h: string | undefined,
  entryGuard: StoredDiscoveryConfig['entryGuard'],
): string =>
  JSON.stringify({
    at,
    enterOnAdd,
    ...(high24h !== undefined ? { high24h } : {}),
    maxDistanceFrom24hHighPercent: entryGuard.maxDistanceFrom24hHighPercent,
    knifeCandles: entryGuard.knifeCandles,
    knifeDropPercent: entryGuard.knifeDropPercent,
  });

/**
 * The symbols to fetch klines for this cycle: every held auto symbol (their
 * klines decide keep-vs-fade, so the cap must never drop them) plus the
 * top-ranked add candidates, capped at `3 × maxAutoSymbols`. A broad rally can
 * pass dozens-to-hundreds of symbols through the ticker stage but only
 * `maxAutoSymbols` can ever be admitted, so 3× the admit cap is ample headroom
 * for candidates that fail the age/trend filter; lower-ranked ones wait for a
 * future cycle. Held symbols keep their original shortlist order; the helper
 * preserves it (held-first, then candidates in rank order).
 */
const selectKlineTargets = (
  shortlist: readonly string[],
  autoSymbols: readonly string[],
  maxAutoSymbols: number,
): string[] => {
  const held = new Set(autoSymbols);
  const targeted = new Set<string>();
  const targets: string[] = [];
  for (const symbol of shortlist) {
    if (held.has(symbol)) {
      targets.push(symbol);
      targeted.add(symbol);
    }
  }
  const candidateCap = 3 * maxAutoSymbols;
  let nonHeldCount = 0;
  for (const symbol of shortlist) {
    if (targeted.has(symbol)) continue;
    if (nonHeldCount >= candidateCap) break;
    targets.push(symbol);
    nonHeldCount += 1;
  }
  return targets;
};

/**
 * All the I/O a single profile's discovery cycle needs, injected so the
 * orchestration in {@link runDiscoveryForProfile} is unit-testable without a
 * real Binance / Redis / DB.
 */
export interface DiscoveryProfilePort {
  /**
   * Carries the admission and permission cuts' fail-safe warns. Both cuts are
   * silent by construction, so without this the operator has no way to learn
   * why a symbol they expect stopped appearing.
   */
  readonly logger: Pick<Logger, 'warn'>;
  getAllTickers(): Promise<readonly Ticker24hrDto[]>;
  getKlines(symbol: string, limit: number): Promise<readonly Candle[]>;
  listAutoSymbols(): Promise<readonly string[]>;
  /** Symbols the operator pinned to `source='manual'`; discovery never re-adopts these. */
  listManualSymbols(): Promise<readonly string[]>;
  /** Effective last-flatten ms per symbol (Redis reaps + DB manual ejects, max). */
  lastFlattenBySymbol(symbols: readonly string[]): Promise<Record<string, number>>;
  addedAtBySymbol(): Promise<Record<string, number>>;
  /**
   * Bind the symbol to `source='auto'`, stamp added-at, and clear the flat
   * cooldown. The entry-hint hash is owned by `refreshEntryHint` (per-cycle, all
   * desired symbols), not this call.
   */
  addSymbol(symbol: string, nowMs: number): Promise<DiscoveryAddOutcome>;
  /**
   * Account-level exclusivity verdict for a candidate, or null when it is free to
   * admit. A SIBLING profile under the same Binance account shares one wallet, so
   * a base asset another profile already trades (`sibling-owns-base`) or settles
   * in (`sibling-quotes-base`) cannot be sized/stop-armed here. Discovery declines
   * such a candidate; the repo `upsert` enforces the owns-base half as a hard
   * backstop, and this pre-filter also surfaces the operator-visible reason.
   */
  siblingConflict(symbol: string): Promise<SiblingConflict>;
  /**
   * Re-stamp the discovery entry-hint for a desired symbol this cycle (#486):
   * the JSON payload from `buildEntryHintValue` (enterOnAdd flag + fresh 24h
   * high + anti-chase guard params). The strategy reads it via the entry-hint
   * bundle; arming it for every desired symbol keeps the 24h high current and
   * extends the guards to non-enterOnAdd entries.
   */
  refreshEntryHint(symbol: string, value: string): Promise<void>;
  /**
   * Whether the exchange wallet still holds a sellable amount of the symbol's
   * base asset (free + locked >= the symbol's `minQty` lot floor). The local
   * `avg_entry_prices` ledger is NOT authoritative: a real buy whose fill has
   * not yet been adopted leaves the ledger empty while the wallet holds coins,
   * and reaping then orphans a live position (#423 Decision 3, "never
   * unsubscribe a held symbol"). Returns `null` when the balance cannot be read
   * (missing credentials / API error); the caller then refuses to reap rather
   * than abandon a possibly-held position.
   */
  heldOnExchange(symbol: string): Promise<boolean | null>;
  /** Reap if flat + auto; returns true only when the row was actually removed. */
  reapSymbol(symbol: string, nowMs: number): Promise<boolean>;
  emit(symbol: string, action: 'add' | 'remove'): Promise<void>;
  /** Append the WARN re-add audit line carrying the prior added-at ms (#454). */
  emitReadd(symbol: string, prevAddedAt: number): Promise<void>;
  /**
   * Append the WARN membership-loss audit line for a symbol that left the auto
   * set without a flatten stamp (vanished without a reap, #454).
   */
  emitMembershipLost(symbol: string, prevAddedAt: number): Promise<void>;
  /** Drop the orphaned added-at + enter-on-add hash entries for a lost symbol (#454). */
  cleanupOrphanedAdded(symbol: string): Promise<void>;
  notify(action: DiscoveryNotifyAction, symbol: string): Promise<void>;
  enqueueResync(): Promise<void>;
  /** Persist the latest per-candidate universe breakdown for the operator dashboard. */
  persistExplain(candidates: readonly CandidateExplain[], nowMs: number): Promise<void>;
  /**
   * Durably append this cycle's point-in-time universe snapshot (#436). Pure
   * observability for a later net-edge backtest; a write failure must not churn
   * or abort the cycle (the implementation logs and swallows).
   */
  persistSnapshot(snapshot: DiscoveryUniverseSnapshotPayload): Promise<void>;
}

/**
 * One profile's discovery cycle: fetch the market, run the pure chain, and
 * apply the diff. The fetch of klines is bounded to the shortlist so the cheap
 * ticker stage gates the expensive per-symbol fetch. Enqueues exactly one
 * resync when anything changed. Returns the applied add/remove counts.
 */
export const runDiscoveryForProfile = async (
  port: DiscoveryProfilePort,
  stored: StoredDiscoveryConfig,
  quoteAsset: string,
  nowMs: number,
  admissionBySymbol?: ReadonlyMap<string, SymbolAdmission>,
  accountPermissions?: readonly string[],
): Promise<{ added: number; removed: number }> => {
  const cfg = toPureConfig(stored, quoteAsset);
  const rawTickers = await port.getAllTickers();
  // Throw rather than degrade: with no USD reference the volume floors would
  // compare against an unknown scale and quietly reject the whole universe. The
  // caller's per-profile catch logs it and leaves the symbol set untouched.
  const quoteUsdPrice = resolveQuoteUsdPrice(rawTickers, cfg.quoteAsset);
  if (quoteUsdPrice === null) {
    throw new Error(
      `discovery: cannot price quote asset ${cfg.quoteAsset} in ${USD_REFERENCE_QUOTE} (no ${cfg.quoteAsset}${USD_REFERENCE_QUOTE} market)`,
    );
  }
  const tickers = toDiscoveryTickers(rawTickers, cfg.quoteAsset, quoteUsdPrice, {
    logger: port.logger,
    // Spread only when supplied: `exactOptionalPropertyTypes` rejects an
    // explicit `undefined` on an optional property.
    ...(admissionBySymbol === undefined ? {} : { admissionBySymbol }),
    ...(accountPermissions === undefined ? {} : { accountPermissions }),
  });
  // 24h high per symbol, captured for the enter-on-add anti-chase guard (#473).
  const highBySymbol: Record<string, string> = {};
  for (const t of rawTickers) highBySymbol[t.symbol] = t.highPrice;
  const shortlist = shortlistByTicker(tickers, cfg);
  const autoSymbols = await port.listAutoSymbols();
  const manualSymbols = await port.listManualSymbols();
  // Enough history to clear the age floor + feed ADX/EMA, capped at Binance's
  // 1000-candle limit. getKlines reserves the flat klines weight (2).
  const limit = Math.min(1000, cfg.minAgeDays * 24 + 50);
  // Bound the expensive per-symbol kline walk to held symbols + top candidates.
  const klineTargets = selectKlineTargets(shortlist, autoSymbols, cfg.maxAutoSymbols);
  // Fetch klines concurrently, bounded. `fail-fast` preserves the serial loop's
  // exact failure semantics: any fetch error rejects here and the caller's
  // per-profile catch leaves the symbol set untouched (no churn on bad data). A
  // missing held symbol would otherwise be read as faded and reaped, so partial
  // results (collect) are deliberately NOT used here.
  const klineResults = await fanOutBounded(
    klineTargets,
    async (symbol) => [symbol, await port.getKlines(symbol, limit)] as const,
    { concurrency: KLINE_CONCURRENCY, onError: 'fail-fast' },
  );
  const klinesBySymbol: Record<string, readonly Candle[]> = Object.fromEntries(
    klineResults.ok.map(([symbol, window]) => [symbol, dropFormingCandle(window, nowMs)]),
  );
  const addedAt = await port.addedAtBySymbol();
  // Include the added-at-hash symbols in the flatten lookup so the membership-loss
  // sweep can tell a legit reap (flatten stamp >= added-at) from a silent vanish.
  const lastFlatten = await port.lastFlattenBySymbol([
    ...new Set([...shortlist, ...autoSymbols, ...Object.keys(addedAt)]),
  ]);
  // A symbol with no recorded added-at (added before this cron, or Redis evicted)
  // falls back to epoch 0 = past any min-hold = immediately reapable. Conservative:
  // the repo flat-guard still refuses to drop a held/open-order symbol, so this only
  // skips the anti-churn delay for an already-flat, faded auto symbol.
  const currentAuto = autoSymbols.map((s) => ({ symbol: s, addedAtMs: addedAt[s] ?? 0 }));
  const explainInput = {
    tickers,
    klinesBySymbol,
    currentAuto,
    lastFlattenAtMsBySymbol: lastFlatten,
    manualMembers: manualSymbols,
    config: cfg,
    nowMs,
  };
  // Account-level exclusivity. Resolve sibling conflicts only for the symbols the
  // cycle would actually add, then re-derive the explain so the diff the add-loop
  // applies and the dispositions the dashboard shows stay one truth. The common
  // case (no conflict) reuses the first pass; the second pass is pure CPU and runs
  // only when a candidate collides with a sibling on the shared wallet.
  const raw = explainDiscovery(explainInput);
  const siblingConflictBySymbol = new Map<string, SiblingConflictDisposition>();
  for (const symbol of raw.diff.add) {
    const kind = await port.siblingConflict(symbol);
    if (kind !== null) siblingConflictBySymbol.set(symbol, kind);
  }
  const { diff, candidates } =
    siblingConflictBySymbol.size === 0
      ? raw
      : explainDiscovery(explainInput, siblingConflictBySymbol);
  // Persist the universe breakdown every cycle (even a no-op one) so the
  // dashboard always shows the latest scan, not just cycles that rotated.
  await port.persistExplain(candidates, nowMs);

  // Durably append this cycle's point-in-time universe snapshot (#436) so a
  // backtest window accumulates. Assembled from what the cycle already computed;
  // observability only — it never feeds the diff above.
  await port.persistSnapshot({
    universe: tickers.map((t) => ({
      symbol: t.symbol,
      priceChangePercent: t.priceChangePercent,
      quoteVolume: t.quoteVolume,
    })),
    shortlist,
    add: diff.add,
    remove: diff.remove,
    desired: diff.desired,
    // Per-cycle filter funnel (#629, #636): the ticker segment counts survivors
    // over the FULL quote-matched set; the candidate segment (age/trend/eligible)
    // counts the kline candidates. Drives the discovery-health monitor.
    funnel: projectFunnel(
      candidates,
      diff,
      marketBreadthOk(tickers, cfg),
      tickerStageCounts(tickers, cfg),
    ),
    configDigest: {
      quoteAsset: cfg.quoteAsset,
      maxAutoSymbols: cfg.maxAutoSymbols,
      changeMinPercent: cfg.changeMinPercent,
      rankTopPercent: cfg.rankTopPercent,
      rankExcludeTopPercent: cfg.rankExcludeTopPercent,
      marketBreadthMinPercent: cfg.marketBreadthMinPercent,
    },
  });

  // Membership-loss audit sweep (#454): a symbol still in the added-at hash that
  // is no longer a current auto member and never recorded a flatten stamp left
  // the set without a reap (orphaned / lost). Warn once and clean the orphaned
  // hash entry; the hdel makes it exactly-once across cycles.
  //
  // A symbol in `diff.add` is about to be re-added this same cycle, so it is NOT
  // a loss: the add loop's `applyDiscoveryAdd` finds the still-present added-at
  // hash entry and reports `readded`. Skip it here so the lost-then-re-added case
  // surfaces as a single `re-added`, not a contradictory `membership lost` (the
  // sweep would hdel the hash, then the add loop would misclassify it `created`).
  const autoSet = new Set(autoSymbols);
  const addSet = new Set(diff.add); // re-added this cycle -> heals as 'readded' in the add loop
  for (const [symbol, addedAtMs] of Object.entries(addedAt)) {
    if (autoSet.has(symbol)) continue;
    if (addSet.has(symbol)) continue; // let the add loop report 'readded'
    const flattenMs = lastFlatten[symbol];
    if (flattenMs !== undefined && flattenMs >= addedAtMs) continue; // legit reap
    await port.emitMembershipLost(symbol, addedAtMs);
    await port.cleanupOrphanedAdded(symbol);
  }

  let added = 0;
  let removed = 0;
  for (const symbol of diff.add) {
    // `diff.add` already excludes sibling-conflicted symbols (subtracted in the
    // explain above), so every symbol here is free to bind to this profile.
    const result = await port.addSymbol(symbol, nowMs);
    if (result.outcome === 'created') {
      await port.emit(symbol, 'add');
      await port.notify('added', symbol);
      added += 1;
    } else if (result.outcome === 'readded') {
      await port.emitReadd(symbol, result.prevAddedAt);
      await port.notify('re-added', symbol);
      added += 1;
    }
    // 'existing' → already bound; emit nothing, count nothing.
  }
  for (const symbol of diff.remove) {
    // Authoritative held check against the exchange wallet, not just the local
    // ledger. Fill adoption can lag a real buy (missed user-stream fill), so a
    // symbol the wallet still holds must never be unsubscribed — that orphans a
    // live, unmanaged position. `null` (balance unreadable) is treated as held:
    // refuse to abandon when we cannot prove the symbol is flat.
    const held = await port.heldOnExchange(symbol);
    if (held !== false) continue;
    if (await port.reapSymbol(symbol, nowMs)) {
      await port.emit(symbol, 'remove');
      await port.notify('removed', symbol);
      removed += 1;
    }
  }
  // Refresh the entry-hint for every desired symbol each cycle, not just on add
  // (#486). This re-stamps a FRESH 24h high so a long-held discovery symbol's
  // anti-chase reference does not freeze at its add time, and carries the
  // current `enterOnAdd` flag so the guards apply whether or not the profile
  // enters on add. Reaped symbols are excluded (not in `desired`) and keep their
  // reap-time hdel. A symbol missing from the ticker feed has no high24h. A
  // faded-but-still-held symbol (reap deferred by the held-guard) is also out of
  // `desired`, so its hint freezes until reap — inert, since a held position is
  // never a flat first entry and the guards only fire on one.
  // Each hint is an independent write to a distinct hash field; pipeline them so
  // the refresh pays one round-trip batch rather than one per desired symbol.
  await Promise.all(
    diff.desired.map((symbol) =>
      port.refreshEntryHint(
        symbol,
        buildEntryHintValue(nowMs, stored.enterOnAdd, highBySymbol[symbol], stored.entryGuard),
      ),
    ),
  );
  if (added > 0 || removed > 0) await port.enqueueResync();
  return { added, removed };
};
