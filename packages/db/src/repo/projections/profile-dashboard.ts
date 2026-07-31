import type { DecimalString, ProfileDashboardResponse } from '@app/contracts';
import { eq } from 'drizzle-orm';

import { accounts } from '../../schema/accounts.js';
import { GLOBAL_KEYS, profileKey } from '../../redis.js';
import { ProfileNotOwnedError } from '../_scoped.js';
import type { ProfileScope } from '../_scoped.js';
import * as avgEntryPrices from '../avg-entry-prices.js';
import * as orders from '../orders.js';
import * as profileSymbols from '../profile-symbols.js';
import * as profilesMod from '../profiles.js';
import { tryParseJson } from './_json.js';
import { orderToResponse } from './orders-view.js';
import type { ProjectionRedis } from './redis-port.js';

/** Redis TTL for the cached dashboard payload. Held strictly above the SPA's
 * 10s poll so the cache absorbs consecutive polls instead of expiring between
 * them and re-running the fan-in on nearly every request. */
export const PROFILE_DASHBOARD_TTL_S = 15;

/**
 * The cacheable slice of the dashboard. `enabledNotifierCount` is deliberately
 * excluded: it must be read fresh per request (a just-saved notifier should
 * clear the SPA's "no notifications" banner immediately), so it never enters
 * the 5s Redis cache. The route attaches it after this returns.
 */
export type CachedProfileDashboard = Omit<ProfileDashboardResponse, 'enabledNotifierCount'>;

/**
 * Composite dashboard view for one profile: account balances, per-symbol
 * state, and a cache stamp. Reads a 5s Redis cache first; on miss it fans
 * in over Postgres + Redis, then writes the cache back. The cache key
 * shape (`tenant:<u>:profile:<p>:dashboard:cache`) is load-bearing —
 * cache-warmers elsewhere depend on it.
 */
export const getProfileDashboard = async (
  scope: ProfileScope,
  redis: ProjectionRedis,
): Promise<CachedProfileDashboard> => {
  const { operatorId, accountId, profileId } = scope;
  const cacheKey = profileKey(scope, 'dashboardCache');
  // A corrupt cache blob degrades to a miss (recompute) rather than a 500.
  const cached = tryParseJson<CachedProfileDashboard>(await redis.get(cacheKey));
  if (cached) {
    return cached;
  }

  // `scopeProfile` already proved ownership; a null here means the profile
  // was deleted between that check and this read — treat it as not-owned.
  const profile = await profilesMod.findById(scope);
  if (!profile) throw new ProfileNotOwnedError(operatorId, accountId, profileId);

  // The worker's `persistAccount` writes `balances` as a record keyed by
  // asset (`{ ASSET: { free, locked } }`), not an array. The market-trend cron
  // writes a global symbol→price map; read both together (one is profile-scoped,
  // one global) so each balance can carry its quote-asset price.
  const [accInfoRaw, priceMapRaw] = await Promise.all([
    redis.get(profileKey(scope, 'accountInfo')),
    redis.get(GLOBAL_KEYS.usdPriceMap()),
  ]);
  const accInfo =
    tryParseJson<{ balances?: Record<string, { free: string; locked: string }> }>(accInfoRaw) ?? {};
  // A missing or unparseable map degrades to "all unpriced" rather than failing
  // the read — dust valuation is best-effort.
  const usdPrices = tryParseJson<{ prices?: Record<string, string> }>(priceMapRaw)?.prices ?? {};
  const symbols = await profileSymbols.listForProfile(scope);
  const symbolNames = symbols.map((s) => s.symbol);
  // Two batched Postgres queries for the whole profile (last-buy prices +
  // live orders), grouped by symbol below, instead of two per symbol. The
  // per-symbol ticker / disable reads stay (Redis, symbol-keyed).
  const [lbps, liveOrders, deployedQuote, acctRows] = await Promise.all([
    avgEntryPrices.findBySymbols(scope, symbolNames),
    orders.listLiveForSymbols(scope, symbolNames),
    // Account-wide deployed cost-basis across the account's profiles that share
    // this profile's quote asset. The config form's percent-of-equity preview
    // needs the same equity the strategy resolves at tick time = quote cash +
    // this. The account fixes the trading environment; scoped to quoteAsset so a
    // different quote unit is never summed in.
    avgEntryPrices.sumDeployedQuoteForAccount(scope.db, accountId, profile.quoteAsset),
    // The account owns the trading environment (binance_mode); read it for the
    // dashboard header. Batched into the same fan-in.
    scope.db
      .select({ binanceMode: accounts.binanceMode })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
  ]);
  const binanceMode = (acctRows[0]?.binanceMode ?? 'test') as 'test' | 'live';
  const lbpBySymbol = new Map(lbps.map((l) => [l.symbol, l]));
  const ordersBySymbol = new Map<string, (typeof liveOrders)[number][]>();
  for (const o of liveOrders) {
    const arr = ordersBySymbol.get(o.symbol);
    if (arr) arr.push(o);
    else ordersBySymbol.set(o.symbol, [o]);
  }

  // Batch the per-symbol Redis reads into two MGETs (symbol-global ticker keys +
  // profile-scoped disable keys) instead of 2×N individual round-trips. Both
  // preserve the prior `get` semantics: a null slot ⇔ absent ⇔ (ticker) no
  // price / (disable) enabled. The worker writes the ticker key on each
  // miniTicker event; a `disable-action:<symbol>` key present ⇔ trading
  // disabled (stop-loss cooldown etc.) — the same key `orders-view` reads.
  const tickerKeys = symbols.map((s) => GLOBAL_KEYS.ticker(s.symbol));
  const disableKeys = symbols.map((s) => profileKey(scope, 'disableAction', s.symbol));
  const [tickerRaws, disableRaws] =
    symbols.length === 0
      ? [[] as (string | null)[], [] as (string | null)[]]
      : await Promise.all([redis.mget(...tickerKeys), redis.mget(...disableKeys)]);

  const symbolStates = symbols.map((s, i) => {
    const lbp = lbpBySymbol.get(s.symbol) ?? null;
    const openOrders = ordersBySymbol.get(s.symbol) ?? [];
    const disableRaw = disableRaws[i] ?? null;
    const ticker = tryParseJson<{ price?: string }>(tickerRaws[i] ?? null) ?? {};
    return {
      symbol: s.symbol,
      enabled: disableRaw == null,
      source: s.source,
      avgEntryPrice: (lbp?.avgEntryPrice ?? null) as DecimalString | null,
      currentPrice: (ticker.price ?? null) as DecimalString | null,
      // Held base quantity; the display layer derives unrealised P/L from
      // (currentPrice - avgEntryPrice) * quantity. The projection ships the
      // fact, not the money math — decimal.js is barred in this package.
      quantity: (lbp?.quantity ?? null) as DecimalString | null,
      openOrderCount: openOrders.length,
      // Ship the rows themselves so the profile dashboard can render a
      // profile-wide open-orders table without an extra per-symbol fetch.
      // Map repo `Date`/`bigint` fields to the wire shape via the same
      // `orderToResponse` pattern the symbol-detail orders-view uses.
      openOrders: openOrders.map(orderToResponse),
      // The dashboard route enriches both blockers from live symbol state after
      // the cache read; the cached snapshot carries null so it never serves a
      // stale blocker, and the route's value wins.
      entryBlocker: null,
      protectiveStopBlocker: null,
    };
  });

  const body: CachedProfileDashboard = {
    profileId,
    enabled: profile.enabled,
    binanceMode,
    quoteAsset: profile.quoteAsset,
    balances: Object.entries(accInfo.balances ?? {}).map(([asset, b]) => ({
      asset,
      free: b.free as DecimalString,
      locked: b.locked as DecimalString,
      // Quote-asset price: the `<asset><quoteAsset>` pair's last price, or 1 for
      // the quote asset itself, else null (no traded pair to value it). Shipped
      // as a decimal-string; decimal.js is barred here, so no math.
      usdPrice: (usdPrices[`${asset}${profile.quoteAsset}`] ??
        (asset === profile.quoteAsset ? '1' : null)) as DecimalString | null,
    })),
    totalProfit: '0' as DecimalString,
    deployedQuote: deployedQuote as DecimalString,
    symbols: symbolStates,
    cachedAt: new Date().toISOString(),
  };
  // Best-effort cache write: a transient Redis failure must not turn a
  // successful read into a 5xx. The next caller simply recomputes.
  await redis.set(cacheKey, JSON.stringify(body), 'EX', PROFILE_DASHBOARD_TTL_S).catch(() => {
    /* swallow — cache write is an optimisation, not a correctness path */
  });
  return body;
};

/**
 * Drop the cached dashboard payload so the next read recomputes immediately.
 * Call after a mutation that changes what the dashboard shows but is not
 * keyed by symbol — adding or removing a profile symbol changes the symbol
 * list, yet the cache key carries no symbol, so a symbol-scoped wipe misses
 * it and the stale list lingers for up to the TTL (the "added symbol does not
 * appear" flake). Best-effort: a transient Redis failure just means the read
 * waits out the TTL instead of refreshing now.
 */
export const invalidateProfileDashboard = async (
  scope: ProfileScope,
  redis: { del(key: string): Promise<unknown> },
): Promise<void> => {
  await redis.del(profileKey(scope, 'dashboardCache')).catch(() => {
    /* swallow — see above */
  });
};
