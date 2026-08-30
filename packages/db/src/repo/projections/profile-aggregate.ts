import { asProfileId, DecimalString, isHeldPosition } from '@app/contracts';
import type {
  AccountId,
  DashboardAggregateResponse,
  DashboardPositionInput,
  ProfileId,
} from '@app/contracts';

import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import { accounts } from '../../schema/accounts.js';
import { apiKeys } from '../../schema/api-keys.js';
import { avgEntryPrices } from '../../schema/avg-entry-prices.js';
import { conditionStates } from '../../schema/condition-states.js';
import { orders } from '../../schema/orders.js';
import { profiles } from '../../schema/profiles.js';
import { profileSymbols } from '../../schema/profile-symbols.js';
import { tradeArchive } from '../../schema/trade-archive.js';
import { dashboardAggregateCacheKey, GLOBAL_KEYS, profileKey } from '../../redis.js';
import { POSITION_SEED_REFUSED } from '../condition-states.js';
import { type AccountScope } from '../_scoped.js';
import * as profilesMod from '../profiles.js';
import { tryParseJson } from './_json.js';
import type { ProjectionRedis } from './redis-port.js';

/**
 * Coerce an untrusted Redis ticker `price` to a `DecimalString`, or `null` when it is absent, non-string, or not a well-formed decimal. The ticker blob is operator-opaque JSON; a malformed `price` must degrade to "no price" rather than leak an invalid `DecimalString` that fails the `DashboardAggregateResponse` contract on the API boundary.
 *
 * The parsed `data` is returned, never the raw input. The schema normalises to plain notation, and this is precisely the surface that needs it: an externally-produced string, straight off Redis, that reaches the dashboard as a price. Keeping `value` here would consult the schema for a verdict and then discard its answer, so a ticker written as `9.9e-7` would render as an exponent in a price column.
 *
 * @param value - The `price` field lifted out of the ticker JSON, of unknown type and unknown provenance.
 * @returns The normalised, branded price, or `null` when the value is not a usable decimal.
 */
const toTickerPrice = (value: unknown): DecimalString | null => {
  if (typeof value !== 'string') return null;
  const parsed = DecimalString.safeParse(value);
  return parsed.success ? parsed.data : null;
};

interface ProfileRollup {
  openOrderCount: number;
  openPositionCount: number;
  positions: DashboardPositionInput[];
}

/**
 * Per-profile rollup for the whole account's home screen: resting-order counts,
 * held positions, and the P/L inputs for each position, keyed by profile id.
 *
 * Two account-scoped, set-based Postgres reads replace the old per-profile
 * fan-out (one profile-symbols read + two per-symbol reads, per profile): the
 * live-order count grouped by profile, and the held-position rows for the whole
 * account — both bounded to one account by the `profiles` join and restricted to
 * symbols the profile still manages via the `profile_symbols` join, so a symbol
 * discovery rotated out no longer counts, matching the per-symbol dashboard. A
 * single account-wide ticker MGET values every held position; decimal.js is
 * barred here, so the projection ships the raw `(avgEntryPrice, currentPrice,
 * quantity)` triple and the browser sums the unrealised P/L.
 *
 * A profile with no live orders and no held positions is simply absent from the
 * map; the aggregate defaults it to zero counts / no positions.
 */
export const rollupAllProfilesForAccount = async (
  scope: AccountScope,
  redis: ProjectionRedis,
): Promise<Map<ProfileId, ProfileRollup>> => {
  const { db, accountId } = scope;
  const [orderCounts, lbpRows, refusalRows] = await Promise.all([
    db
      .select({ profileId: orders.profileId, count: sql<number>`count(*)::int` })
      .from(orders)
      .innerJoin(
        profileSymbols,
        and(
          eq(profileSymbols.profileId, orders.profileId),
          eq(profileSymbols.symbol, orders.symbol),
        ),
      )
      .innerJoin(profiles, eq(profiles.id, orders.profileId))
      .where(and(eq(profiles.accountId, accountId), isNull(orders.closedAt)))
      .groupBy(orders.profileId),
    db
      .select({
        profileId: avgEntryPrices.profileId,
        symbol: avgEntryPrices.symbol,
        avgEntryPrice: avgEntryPrices.avgEntryPrice,
        quantity: avgEntryPrices.quantity,
      })
      .from(avgEntryPrices)
      .innerJoin(
        profileSymbols,
        and(
          eq(profileSymbols.profileId, avgEntryPrices.profileId),
          eq(profileSymbols.symbol, avgEntryPrices.symbol),
        ),
      )
      .innerJoin(profiles, eq(profiles.id, avgEntryPrices.profileId))
      .where(eq(profiles.accountId, accountId)),
    db
      .select({ profileId: conditionStates.profileId, symbol: conditionStates.symbol })
      .from(conditionStates)
      .innerJoin(profiles, eq(profiles.id, conditionStates.profileId))
      .where(
        and(
          eq(profiles.accountId, accountId),
          eq(conditionStates.condition, POSITION_SEED_REFUSED),
        ),
      ),
  ]);
  // A row exists for exactly as long as the refusal stands, so presence IS the open state; this mirrors `listOpenByCondition`, whose predicate is the same pair.
  const refused = new Set(refusalRows.map((r) => `${r.profileId}:${r.symbol}`));

  // A position requires a recorded avg-entry price AND a strictly positive held
  // quantity — the shared predicate the profile-detail page and coin-grid use,
  // so the count here and the Unrealised P/L card cannot drift.
  // The refusal filter belongs HERE rather than at the count alone: `held` also seeds `positions`, which the web sums into the ticker's unrealised total, so dropping a refused row from the count while leaving it in the array would fix the number beside the coins and not the money.
  const held = lbpRows.filter(
    (r) =>
      isHeldPosition(r.avgEntryPrice, r.quantity) && !refused.has(`${r.profileId}:${r.symbol}`),
  );
  // One account-wide MGET for every held symbol (deduped): symbol-global keys, so
  // a symbol held by two profiles is fetched once. Absent key reads as `{}`.
  const heldSymbols = [...new Set(held.map((r) => r.symbol))];
  const tickerRaws =
    heldSymbols.length === 0
      ? []
      : await redis.mget(...heldSymbols.map((s) => GLOBAL_KEYS.ticker(s)));
  const tickerBySymbol = new Map(
    heldSymbols.map((s, i) => [s, tryParseJson<{ price?: unknown }>(tickerRaws[i] ?? null) ?? {}]),
  );

  const rollups = new Map<ProfileId, ProfileRollup>();
  const bucketFor = (rawProfileId: string): ProfileRollup => {
    const profileId = asProfileId(rawProfileId);
    let bucket = rollups.get(profileId);
    if (!bucket) {
      bucket = { openOrderCount: 0, openPositionCount: 0, positions: [] };
      rollups.set(profileId, bucket);
    }
    return bucket;
  };
  for (const row of orderCounts) {
    if (row.profileId == null) continue;
    bucketFor(row.profileId).openOrderCount = row.count;
  }
  for (const row of held) {
    const ticker = tickerBySymbol.get(row.symbol) ?? {};
    const bucket = bucketFor(row.profileId);
    bucket.openPositionCount += 1;
    bucket.positions.push({
      symbol: row.symbol,
      avgEntryPrice: DecimalString.parse(row.avgEntryPrice),
      currentPrice: toTickerPrice(ticker.price),
      quantity: DecimalString.parse(row.quantity),
    });
  }
  return rollups;
};

/** One profile's realised total for the window, in the currency it was summed in. */
export interface RealizedByProfile {
  /** The quote asset the figure is counted in, canonically upper-cased. The archive is keyed by the upper-cased asset while a profile row may hold any casing, so echoing the canonical form keeps the label and the figure from drifting apart. */
  readonly quoteAsset: string;
  /** GROSS realised profit over the window, fees NOT subtracted. `'0'` for a profile that closed nothing. */
  readonly totalProfit: string;
}

/**
 * Realised P/L over one window for EVERY profile of an account, as a single grouped read.
 *
 * Replaces a per-profile fan-out: the account-health bar summed each profile separately, and node-postgres takes one pooled connection per concurrent query, so the checkout burst grew with the profile count and an operator with a handful of profiles emptied the api's pool of ten on one poll of a bar that polls.
 *
 * A LEFT JOIN from `profiles`, not an inner one. A profile that closed nothing in the window still has to appear with a zero in its own currency — that is what the bar renders, and dropping the row would silently remove a live profile from the operator's view of the account rather than showing it flat.
 *
 * The quote match is case-folded in the join predicate only. `trade_archive.quote_asset` is written upper-cased while `profiles.quote_asset` may be lower or mixed by design, so the two sides genuinely differ in casing and the fold belongs where they meet. Neither column gets a CHECK constraint and no row is rewritten: normalising the stored data would be a migration in service of a join, and the profile casing is operator-facing.
 *
 * @param scope - Ownership-proven account scope; the `profiles` filter below is bounded by its `accountId`.
 * @param since - Inclusive lower bound on `archived_at`; the caller owns the day boundary, so the repo carries no timezone story.
 * @param until - Exclusive upper bound on `archived_at`.
 * @returns One entry per profile of the account, keyed by profile id, including profiles with nothing closed in the window.
 */
export const rollupRealizedByProfileForAccount = async (
  scope: AccountScope,
  since: Date,
  until: Date,
): Promise<Map<ProfileId, RealizedByProfile>> => {
  const { db, accountId } = scope;
  const canonicalQuote = sql<string>`upper(${profiles.quoteAsset})`;
  const rows = await db
    .select({
      profileId: profiles.id,
      quoteAsset: canonicalQuote,
      totalProfit: sql<string>`coalesce(sum(${tradeArchive.profit}), 0)::text`,
    })
    .from(profiles)
    .leftJoin(
      tradeArchive,
      and(
        eq(tradeArchive.profileId, profiles.id),
        eq(tradeArchive.quoteAsset, canonicalQuote),
        gte(tradeArchive.archivedAt, since),
        lt(tradeArchive.archivedAt, until),
      ),
    )
    .where(eq(profiles.accountId, accountId))
    .groupBy(profiles.id, profiles.quoteAsset);

  const out = new Map<ProfileId, RealizedByProfile>();
  for (const row of rows) {
    out.set(asProfileId(row.profileId), {
      quoteAsset: row.quoteAsset,
      totalProfit: row.totalProfit,
    });
  }
  return out;
};

/**
 * Cross-profile rollup for the operator's home screen. Lists every profile
 * the user owns with its at-a-glance liveness fields (last tick, kill
 * switch) read from the per-profile Redis state blob, plus the
 * profile's open-order and open-position counts plus the per-position P/L
 * inputs. This view is user-scoped rather than profile-scoped, so it takes
 * `(db, userId)` directly instead of a `ProfileScope`.
 */
/**
 * Redis TTL for the cached aggregate payload. Held strictly above the SPA's 10s
 * dashboard poll so the cache absorbs consecutive polls instead of expiring
 * between them and re-running the account-wide fan-in on nearly every request.
 * Mirrors `PROFILE_DASHBOARD_TTL_S` on the per-profile dashboard.
 */
export const DASHBOARD_AGGREGATE_TTL_S = 15;

export const getAggregateForAccount = async (
  scope: AccountScope,
  redis: ProjectionRedis,
): Promise<DashboardAggregateResponse> => {
  const { db, accountId } = scope;
  // Read-through cache: the SPA polls this route every 10s from every open
  // dashboard/profile/symbol tab; without the cache each poll re-runs the
  // account-wide Postgres + Redis fan-in below. A corrupt blob degrades to a
  // miss (recompute) rather than a 500. Same discipline as
  // `getProfileDashboard`.
  const cacheKey = dashboardAggregateCacheKey(accountId);
  const cached = tryParseJson<DashboardAggregateResponse>(await redis.get(cacheKey));
  if (cached) return cached;

  // The profile list and the account-wide order/position rollup are independent
  // account-scoped reads; run them together. The rollup is two set-based queries
  // for the whole account, not the former per-profile x per-symbol fan-out.
  const [rows, rollups] = await Promise.all([
    profilesMod.listForAccount(scope),
    rollupAllProfilesForAccount(scope, redis),
  ]);
  // Keys are per-account now, so "api key configured" is one fact shared by
  // every profile under the account: a single existence check, not a per-profile
  // set. binance_mode is likewise an account attribute shared by all profiles.
  const [keyRow] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, accountId))
    .limit(1);
  const apiKeyConfigured = keyRow != null;
  const [acct] = await db
    .select({ binanceMode: accounts.binanceMode })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const binanceMode = (acct?.binanceMode ?? 'test') as 'test' | 'live';
  const profiles = await Promise.all(
    rows.map(async (row) => {
      // This view iterates raw profile rows, so it has no per-profile
      // `ProfileScope` to pass; it builds the `{accountId, profileId}` key parts
      // per row instead. `row.id` is an unbranded schema string.
      const profileId = asProfileId(row.id);
      // A corrupt tick-meta blob for one profile must not fail the whole
      // aggregate — fall back to defaults for just that row.
      // `profileTickMeta` is the worker-stamped operational record
      // (`lastTickAt` etc.) the dashboard reads to prove the strategy is
      // alive.
      // The tick-meta blob and the kill-switch presence are independent keys;
      // read them in one round-trip instead of awaiting the get before the
      // exists. killSwitch stays an `exists` (presence semantics) rather than
      // folding into an MGET — the round-trip saving is one op per profile and
      // exists keeps it independent of the key's stored value.
      const [tickMetaRaw, killSwitchCount] = await Promise.all([
        redis.get(profileKey({ accountId, profileId }, 'profileTickMeta')),
        redis.exists(profileKey({ accountId, profileId }, 'killSwitch')),
      ]);
      const tickMeta =
        tryParseJson<{
          lastTickAt?: string;
          lastTickLatencyMs?: number;
          lastTickError?: string | null;
        }>(tickMetaRaw) ?? {};
      const killSwitch = killSwitchCount > 0;
      // Order/position counts come from the account-wide rollup computed above.
      // A profile with no orders and no positions is simply absent from the map,
      // so it defaults to zero counts and no positions.
      const rollup = rollups.get(profileId) ?? {
        openOrderCount: 0,
        openPositionCount: 0,
        positions: [],
      };
      return {
        profileId,
        name: row.name,
        enabled: row.enabled,
        binanceMode,
        quoteAsset: row.quoteAsset,
        lastTickAt: tickMeta.lastTickAt ?? null,
        lastTickLatencyMs: tickMeta.lastTickLatencyMs ?? null,
        apiKeyConfigured,
        lastTickError: tickMeta.lastTickError ?? null,
        killSwitch,
        openOrderCount: rollup.openOrderCount,
        openPositionCount: rollup.openPositionCount,
        positions: rollup.positions,
      };
    }),
  );
  const result: DashboardAggregateResponse = { profiles };
  // Best-effort cache write: a transient Redis failure must not turn a
  // successful read into a 5xx. The next caller simply recomputes.
  await redis.set(cacheKey, JSON.stringify(result), 'EX', DASHBOARD_AGGREGATE_TTL_S).catch(() => {
    /* swallow — cache write is an optimisation, not a correctness path */
  });
  return result;
};

/**
 * Drop the dashboard read-through caches a write just invalidated so the
 * next poll recomputes immediately instead of replaying a stale blob for
 * up to the TTL. Always clears the per-account aggregate; also clears the
 * per-profile dashboard when a profile is named. Best-effort: a Redis
 * failure must not fail the write that triggered it.
 */
export const invalidateDashboardCaches = async (
  redis: { del(...keys: string[]): Promise<unknown> },
  accountId: AccountId,
  profileId?: ProfileId,
): Promise<void> => {
  const keys = [dashboardAggregateCacheKey(accountId)];
  if (profileId) keys.push(profileKey({ accountId, profileId }, 'dashboardCache'));
  await redis.del(...keys).catch(() => {
    /* swallow — cache invalidation is an optimisation, not a correctness path */
  });
};
