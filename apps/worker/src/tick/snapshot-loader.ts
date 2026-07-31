// Tick snapshot loader.
//
// Reads everything strategy.tick() needs in ONE Redis pipeline. Cold-loads
// from Postgres (via injected repository functions) on miss, write-through
// to Redis for next time.

import type { Redis } from 'ioredis';
import type {
  AccountSnapshot,
  ApiLimits,
  Balance,
  Candle,
  IndicatorSnapshot,
  MarketSnapshot,
  OpenOrder,
  SymbolInfo,
} from '@app/strategy-core';
import { AccountInfoSnapshot, type AccountId, type ProfileId, type UserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';
import { reviveBalanceField, type BalanceParseWarn } from 'lib/balance-revive.js';
import {
  buildAccountInfoKey,
  buildDisableActionKey,
  buildOpenOrdersKey,
  buildKillSwitchKey,
  buildOrderRearmKey,
  buildSymbolStateKey,
  buildWeightKey,
} from 'executor/redis-namespace.js';
import { indicatorKey } from 'indicator-computer/indicator-computer.js';
import { minuteBucketOf } from 'executor/binance-error-taxonomy.js';
import { commitPipeline, type PipeReply } from 'lib/redis-pipeline.js';

export interface SnapshotInput {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly intervals: readonly string[];
  readonly nowMs: number;
}

export interface RawSnapshot {
  readonly state: string | null;
  readonly accountInfo: string | null;
  readonly openOrders: string | null;
  readonly killSwitch: string | null;
  // Per-symbol pause flag. Present (non-null) => freeze all new buy+sell
  // decisions for this symbol; the tick short-circuits to a noop. Scoped
  // narrower than killSwitch (which halts the whole profile).
  readonly symbolDisable: string | null;
  readonly weightUsed1m: number;
  // Set by the PREVIOUS tick when it failed an order and left state un-advanced.
  // Audit attribution only, never a decision input — which is why it rides this
  // pipeline instead of costing a separate deadline-wrapped GET after the
  // strategy runs. The only writer is the same tick handler, strictly later than
  // this read, so reading it here is equivalent to reading it post-strategy.
  readonly orderRearm: string | null;
  readonly indicatorsByInterval: Readonly<Record<string, string | null>>;
}

/**
 * Durable per-(profile, symbol) state row as the tick read path needs it:
 * the state body plus the row's `strategy_version` stamp. The stamp is
 * required so the read can reconcile against PG by schemaVersion the same
 * way `mutateSymbolState` does — returning only the body (as the prior
 * contract did) left the tick read unable to detect column-vs-body drift.
 */
export interface SymbolStateRowView {
  readonly state: unknown;
  readonly strategyVersion: string;
  /**
   * The row's optimistic-concurrency `version` at read. Threaded to the tick
   * commit so the durable write is `WHERE version = expected`, making the
   * read-modify-write cross-pod safe. `0` for a row written before the CAS
   * column existed (the migration default).
   */
  readonly version: number;
}

export interface SnapshotColdLoad {
  loadAccount(
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ): Promise<AccountSnapshot>;
  /**
   * Total quote-asset cost basis deployed across the account's profiles that
   * share the requesting profile's `quoteAsset`
   * (`SUM(avg_entry_price × quantity)` over the cost-basis ledger), as a
   * decimal-string. Feeds `AccountSnapshot.deployedQuoteAcrossProfiles` so the
   * account-wide exposure cap and percent-of-account sizing gate inside the
   * pure tick. Scoped by `(account_id, quote_asset)`; the account already pins
   * one Binance environment, so no separate mode arg is needed.
   */
  loadAccountDeployedQuote(accountId: AccountId, quoteAsset: string): Promise<string>;
  loadOpenOrders(
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
  ): Promise<readonly OpenOrder[]>;
  loadSymbolState(scope: ProfileScope, symbol: string): Promise<SymbolStateRowView | null>;
  /**
   * The profile's cross-symbol KV store (tracker #267) as a `{ key: value }`
   * snapshot, the shape passed to `TickInput.profileKv`. Read straight from PG
   * (the durable source of truth) only when the strategy opts in via
   * `capabilities.needsProfileKv`. Empty object when the profile has no KV rows.
   */
  loadProfileKv(scope: ProfileScope): Promise<Record<string, unknown>>;
}

export const readRawSnapshot = async (redis: Redis, input: SnapshotInput): Promise<RawSnapshot> => {
  const stateKey = buildSymbolStateKey(input.accountId, input.profileId, input.symbol);
  const accountKey = buildAccountInfoKey(input.accountId, input.profileId);
  const openOrdersKey = buildOpenOrdersKey(input.accountId, input.symbol);
  const killKey = buildKillSwitchKey(input.accountId, input.profileId);
  const disableKey = buildDisableActionKey(input.accountId, input.profileId, input.symbol);
  const weightKey = buildWeightKey(input.accountId, input.profileId, minuteBucketOf(input.nowMs));
  const rearmKey = buildOrderRearmKey(input.profileId, input.symbol);
  const indicatorKeys = input.intervals.map((iv) => indicatorKey(input.symbol, iv));

  const pipe = redis.pipeline();
  pipe.get(stateKey);
  pipe.get(accountKey);
  pipe.get(openOrdersKey);
  pipe.get(killKey);
  pipe.get(disableKey);
  pipe.get(weightKey);
  pipe.get(rearmKey);
  for (const k of indicatorKeys) pipe.get(k);

  const replies = (await commitPipeline(pipe)) as PipeReply[] | null;
  if (!replies) throw new Error('readRawSnapshot: pipeline returned null');

  // Per-slot scan, and it must stay per-slot: `grab` is fail-closed for the
  // decision-bearing slots, but the re-arm flag below is read softly on purpose.
  // `commitPipelineChecked` throws on ANY errored slot in the reply array, so it
  // is not a drop-in — swapping it in would dead-letter a tick over an
  // audit-only read.

  const grab = (idx: number): string | null => {
    const r = replies[idx];
    if (!r) return null;
    const [err, val] = r;
    if (err) throw err;
    return typeof val === 'string' ? val : null;
  };

  let cursor = 0;
  const state = grab(cursor++);
  const accountInfo = grab(cursor++);
  const openOrders = grab(cursor++);
  const killSwitch = grab(cursor++);
  const symbolDisable = grab(cursor++);
  const weightRaw = grab(cursor++);
  // Deliberately NOT `grab`: this slot is audit attribution, and `grab` is
  // fail-closed (it rethrows, dead-lettering the tick) because the state and
  // kill-switch slots beside it must never be guessed. An errored read of the
  // re-arm flag costs the audit flag, not the tick — the posture the standalone
  // deadline-wrapped read it replaced spelled out.
  const orderRearm = ((): string | null => {
    const r = replies[cursor++];
    return r && !r[0] && typeof r[1] === 'string' ? r[1] : null;
  })();
  const indicatorsByInterval: Record<string, string | null> = {};
  for (const iv of input.intervals) indicatorsByInterval[iv] = grab(cursor++);

  return {
    state,
    accountInfo,
    openOrders,
    killSwitch,
    symbolDisable,
    weightUsed1m: weightRaw === null ? 0 : Number.parseInt(weightRaw, 10) || 0,
    orderRearm,
    indicatorsByInterval,
  };
};

export { type BalanceParseWarn } from 'lib/balance-revive.js';

export const parseAccountSnapshot = (
  raw: string | null,
  onWarn?: BalanceParseWarn,
): AccountSnapshot => {
  if (!raw) return { balances: {}, readable: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { balances: {}, readable: false };
  }
  // Validate the `account-info` payload against the shared contract rather
  // than casting — a malformed key degrades to an empty snapshot (the tick
  // then cold-loads from Binance) instead of crashing downstream on a bad shape.
  const result = AccountInfoSnapshot.safeParse(json);
  if (!result.success) return { balances: {}, readable: false };
  // Strategy-boundary revival: the wire keeps decimal-strings (see
  // AccountInfoSnapshot in @app/contracts) but the strategy contract
  // exposes Decimal-typed `free` / `locked`. A malformed numeric string
  // degrades that asset to zero rather than throwing — the snapshot
  // already tolerates absent/empty wire data the same way; the optional
  // `onWarn` surfaces the degrade so it does not pass silently.
  const balances: Record<string, Balance> = {};
  for (const [asset, b] of Object.entries(result.data.balances)) {
    balances[asset] = {
      asset,
      free: reviveBalanceField(asset, 'free', b.free, onWarn),
      locked: reviveBalanceField(asset, 'locked', b.locked, onWarn),
    };
  }
  return { balances, readable: true };
};

export const parseOpenOrders = (raw: string | null): readonly OpenOrder[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as readonly OpenOrder[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Revives one `indicators:<symbol>:<interval>` JSON blob into the
// strategy-facing IndicatorSnapshot. The blob is whatever IndicatorComputer
// last wrote (an IndicatorBundle); only the snapshot subset is kept. A
// missing key, malformed JSON, or a shape mismatch yields `undefined` so a
// stale/corrupt indicator cache degrades the tick rather than throwing.
export const parseIndicatorSnapshot = (raw: string | null): IndicatorSnapshot | undefined => {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<IndicatorSnapshot>;
    if (
      typeof p.windowSize !== 'number' ||
      typeof p.lowestLow !== 'string' ||
      typeof p.highestHigh !== 'string' ||
      typeof p.lastCandleCloseTimeMs !== 'number'
    ) {
      return undefined;
    }
    return {
      windowSize: p.windowSize,
      lowestLow: p.lowestLow,
      highestHigh: p.highestHigh,
      sma20: typeof p.sma20 === 'string' ? p.sma20 : null,
      ema20: typeof p.ema20 === 'string' ? p.ema20 : null,
      rsi14: typeof p.rsi14 === 'string' ? p.rsi14 : null,
      lastCandleCloseTimeMs: p.lastCandleCloseTimeMs,
    };
  } catch {
    return undefined;
  }
};

export const apiLimitsFrom = (weightUsed1m: number, weightLimit1m: number): ApiLimits => {
  const headroom = Math.max(0, weightLimit1m - weightUsed1m);
  const headroomBps = weightLimit1m === 0 ? 0 : Math.floor((headroom / weightLimit1m) * 10_000);
  return { weightUsed1m, weightLimit1m, headroomBps };
};

/**
 * Pick the most recently closed candle's `close` across every interval.
 * Multi-interval strategies populate `candlesByInterval` out of insertion
 * order, so `.at(-1)` could return an hour-old 1h candle when a 30s-old 1m
 * candle is also present; reduce by `closeTimeMs` instead. Returns '0' when
 * no candle is available, e.g. cold start before any WS frame has landed —
 * every price-consuming decision then skips with `invalid-filters`.
 */
export const selectCurrentPrice = (
  candlesByInterval: Readonly<Record<string, readonly Candle[]>>,
): string =>
  Object.values(candlesByInterval)
    .flat()
    .reduce<Candle | null>(
      (best, c) => (best === null || c.closeTimeMs > best.closeTimeMs ? c : best),
      null,
    )?.close ?? '0';

export const buildMarketSnapshot = (
  symbol: string,
  symbolInfo: SymbolInfo,
  candlesByInterval: Readonly<Record<string, readonly Candle[]>>,
  indicatorsByInterval: Readonly<Record<string, IndicatorSnapshot>>,
  // The live last-trade price from the mini-ticker frame that fired this tick,
  // when present and valid. It supersedes the freshest CLOSED candle's close so
  // a stop/exit reacts to the price that just traded (~1s) instead of waiting
  // up to a full 1m candle. Absent → closed-candle fallback (cold start,
  // non-price triggers, replay), which keeps golden fixtures byte-identical.
  livePrice?: string,
): MarketSnapshot => ({
  symbol,
  currentPrice: livePrice ?? selectCurrentPrice(candlesByInterval),
  symbolInfo,
  candlesByInterval: candlesByInterval as MarketSnapshot['candlesByInterval'],
  indicatorsByInterval: indicatorsByInterval as NonNullable<MarketSnapshot['indicatorsByInterval']>,
});
