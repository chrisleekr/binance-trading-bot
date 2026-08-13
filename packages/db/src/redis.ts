import type { AccountId, ProfileId } from '@app/contracts';
import { Redis } from 'ioredis';

// =============================================================================
// Scopes
// =============================================================================

// Redis-side scope (a discriminated-union variant of `RedisScope`). Named
// distinctly from the projection-layer `ProfileScope` in
// `repo/_scoped.ts`: that one is a branded `(db, operatorId, accountId,
// profileId)` tuple proving ownership, this one is just a typed Redis key
// prefix. A top-level `import { ProfileScope } from '@app/db'` previously
// resolved to this structural variant and would defeat the brand for any
// consumer that did so; the rename closes that footgun.
export interface RedisProfileScope {
  readonly kind: 'profile';
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
}

export interface GlobalScope {
  readonly kind: 'global';
}

export type RedisScope = RedisProfileScope | GlobalScope;

/**
 * The fields the key builders actually read — a structural subset of
 * {@link RedisProfileScope}. Declared narrowly so callers that hold a different
 * scope shape (the projection layer's `_scoped.ts` `ProfileScope` carries
 * `db` instead of the `kind` discriminant) or a per-row `{accountId, profileId}`
 * literal can build keys without an adapter or a synthetic `kind` field.
 */
export interface ProfileKeyParts {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
}

// Cluster hash-tag wrapping (`{tenant:<a>}`) is documented for v1.x sharding;
// v1.0 ships single-instance Redis so the literal `tenant:` prefix is enough.
// Exported so wipe-by-prefix helpers build the same bytes as the key builders.
// Keyed by account (the tenant boundary): profiles under an account share its
// keys and stream, and cross-account isolation is the account, not the operator.
export const profilePrefix = (scope: ProfileKeyParts): string =>
  `tenant:${scope.accountId}:profile:${scope.profileId}:`;

/**
 * Compose the full prefixed Redis key for a profile-scoped catalogue entry.
 * Use this when the caller holds a raw ioredis handle (e.g., the worker
 * tick bundle-builder, which threads `Redis` directly through closures)
 * and cannot reach `ScopedRedis.forProfile().get/set/del`. Keeping the
 * prefix in one place — here — means the API's typed `forProfile` writes
 * and the worker's raw reads agree on the bytes that hit Redis.
 */
export const profileKey = <K extends ProfileScopedKeyName>(
  scope: ProfileKeyParts,
  name: K,
  ...params: ParamsOf<(typeof PROFILE_KEYS)[K]>
): string => profilePrefix(scope) + (PROFILE_KEYS[name] as (...a: unknown[]) => string)(...params);

/**
 * Account-scoped (no profile) cache key for the cross-profile dashboard
 * aggregate. The aggregate projection is account-scoped, so its read-through
 * cache lives under the tenant prefix without a profile segment — distinct from
 * the per-profile `dashboardCache` key.
 */
export const dashboardAggregateCacheKey = (accountId: AccountId): string =>
  `tenant:${accountId}:dashboard-aggregate:cache`;

/**
 * Account-scoped (no profile) open-orders snapshot key. An order book belongs to
 * one Binance key pair, which is the account, so every profile under the account
 * shares one WS-merged snapshot per symbol instead of each cold-loading its own.
 * Dropping the profile segment is what lets the executor and the user-data-stream
 * router mutate one list in place rather than each profile DELeting a private copy.
 */
export const openOrdersKey = (accountId: AccountId, symbol: string): string =>
  `tenant:${accountId}:open-orders:${symbol}`;

/**
 * Account-scoped (no profile) cache of the permission tags Binance reports for
 * the account's key pair, as a JSON string array. Permissions belong to the key
 * pair, which is the account, so every profile shares one entry.
 *
 * Deliberately TTL-less. Readers treat an absent list as "unknown" and fail
 * open, so an expiring key would silently restore the exact behaviour this
 * cache exists to prevent. Every `/account` fetch overwrites it, and the
 * account-snapshot safety cron guarantees a periodic fetch.
 */
export const accountPermissionsKey = (accountId: AccountId): string =>
  `tenant:${accountId}:account-permissions`;

// =============================================================================
// Events / audit stream key catalogue (cross-process: worker writes, api reads)
// =============================================================================
//
// These keys cross a process boundary — the worker PUBLISH/XADD/INCRs them and
// the api SUBSCRIBE/XRANGEs them — so they live here as the single source both
// processes import, rather than as inline literals re-derived on each side.
// They use an `events:`/`audit:` prefix (not the `tenant:…:profile:…`
// `profileKey` prefix), so they are their own family.

/** Pub/Sub channel the worker publishes each WS envelope onto. */
export const eventsChannelKey = (accountId: AccountId, profileId: ProfileId): string =>
  `events:${accountId}:${profileId}`;

/** Bounded replay stream (XADD) backing `?since=<seq>` reconnect. */
export const eventsStreamKey = (accountId: AccountId, profileId: ProfileId): string =>
  `${eventsChannelKey(accountId, profileId)}:stream`;

/** Monotonic per-profile WS sequence counter (INCR before each emit). */
export const eventsSeqKey = (accountId: AccountId, profileId: ProfileId): string =>
  `${eventsChannelKey(accountId, profileId)}:seq`;

/** Bounded audit-event stream shipped by the worker's audit-shipper. */
export const auditStreamKey = (accountId: AccountId, profileId: ProfileId): string =>
  `audit:${accountId}:${profileId}:stream`;

/**
 * Glob pattern the api PSUBSCRIBEs to receive every profile's events channel.
 * Kept beside the builders so the pattern and the per-profile channel cannot
 * drift (a channel-prefix change must update both).
 */
export const EVENTS_CHANNEL_PATTERN = 'events:*:*';

// =============================================================================
// Profile-scoped key catalogue
// =============================================================================
//
// Every entry in the v1 profile-scoped key table.
// The functions below build the suffix; the wrapper prepends the tenant prefix.

export const PROFILE_KEYS = {
  configurations: (symbolOrGlobal: string): string => `configurations:${symbolOrGlobal}`,
  override: (symbolOrGlobal: string): string => `override:${symbolOrGlobal}`,
  disableAction: (symbol: string): string => `disable-action:${symbol}`,
  accountInfo: (): string => `account-info`,
  exchangeInfo: (): string => `exchange-info`,
  exchangeSymbols: (): string => `exchange-symbols`,
  // Per-(profile, symbol) strategy-state key: the hot copy reconciled against
  // the durable `symbol_states` PG row. Keyed per symbol so symbols on a shared
  // profile never clobber each other's strategy state.
  symbolState: (symbol: string): string => `symbol-state:${symbol}`,
  // Operational metadata stamped by the worker after every tick attempt:
  // {lastTickAt, lastTickLatencyMs, lastTickError}. Held in its own key so
  // writes do not collide with the strategy's `symbol-state` blob — strategies
  // are pure and own that key exclusively.
  profileTickMeta: (): string => `profile-tick-meta`,
  killSwitch: (): string => `kill-switch`,
  // Daily-loss circuit breaker flag. Set by the portfolio-risk cron with a TTL
  // sized so it expires at roughly the next UTC midnight, when the profile's
  // realised loss for the day breaches its configured limit; the tick handler
  // drops new BUY orders while it is present. Self-clearing via the TTL, so a new
  // UTC day always re-arms entries.
  entryHaltDaily: (): string => `entry-halt:daily`,
  // Edge-decay "already-alerted" latch. Set by the edge-decay-monitor cron when a
  // live profile's realized profit factor falls below its pinned backtest baseline,
  // solely to de-dupe the advisory Slack push to once per decay episode; the same
  // cron clears it when the live edge recovers so a later re-decay re-alerts. This
  // is NOT a buy-suppressing flag: the tick handler NEVER reads it and it NEVER
  // pauses buys. No TTL — the latch just tracks whether we have already alerted.
  edgeDecayNotified: (): string => `edge-decay:notified`,
  dashboardCache: (): string => `dashboard:cache`,
  dustEligible: (): string => `dust-eligible`,
  userStreamEvent: (): string => `user-stream:last-event`,
  binanceWeight: (minuteBucket: number): string => `binance:weight:${minuteBucket}`,
} as const satisfies Record<string, (...args: never[]) => string>;

export type ProfileScopedKeyName = keyof typeof PROFILE_KEYS;

// =============================================================================
// Global key catalogue (no profile, market data)
// =============================================================================

export const GLOBAL_KEYS = {
  technicals: (symbol: string, interval: string): string => `technicals:${symbol}:${interval}`,
  // Per-interval Technicals compute-job fetch status: the worker's
  // `technicals-compute` cron writes one of these on every commit so the
  // operator API can surface "last compute outcome" without scraping
  // pino. Short TTL so a missing key is itself a useful signal ("cron
  // has not run lately").
  technicalsComputeStatus: (interval: string): string => `technicals:fetch-status:${interval}`,
  // Live current price per symbol, written by the worker on each miniTicker
  // WS event. Symbol-global: a price is identical for every profile.
  ticker: (symbol: string): string => `ticker:${symbol}`,
  // Per-symbol exchange filters (lot size, tick size, base/quote asset),
  // namespaced by Binance mode. Written by the worker's `exchange-info-refresh`
  // cron and read by cold-load, the worker tick, and the API.
  //
  // `live` keeps the canonical `binance:symbol-info:<S>` key every live consumer
  // reads. `test` uses a distinct `binance:symbol-info-test:<S>` keyspace because
  // testnet's tickSize / lot filters differ from production: a test-mode profile
  // must validate + arm orders against testnet's own filters or Binance rejects
  // them (-1013 PRICE_FILTER). The `-test` sits before the `:` so each mode's
  // stale-key cleanup glob (`binance:symbol-info:*` vs `binance:symbol-info-test:*`)
  // cannot match — and delete — the other mode's keys.
  // `mode` is REQUIRED, deliberately: a default of `live` makes forgetting it
  // read production filters for a testnet profile, which is silent and wrong.
  // An explicit argument turns that omission into a compile error.
  symbolInfo: (symbol: string, mode: 'test' | 'live'): string =>
    mode === 'test' ? `binance:symbol-info-test:${symbol}` : `binance:symbol-info:${symbol}`,
  // Per-prune-kind retention receipt. Written by the action-log-prune and
  // audit-prune crons on every run; consumed by `/api/retention-status`.
  // No TTL — the operator dashboard wants to render "last sweep N hours
  // ago" even when N is large.
  retentionReceipt: (kind: 'action-log-prune' | 'audit-prune'): string =>
    `retention:receipt:${kind}`,
  // Per-cron last-run health, a single hash field-keyed by cron name. Written by
  // the cron-status recorder wrapping every cron handler; consumed by
  // `/api/worker/crons` so the operator can see which crons last ran (and
  // whether they errored) without scraping pino. No TTL — the panel renders
  // "ran N hours ago" even when N is large, and a stale timestamp is itself the
  // "this cron has stalled" signal.
  cronStatus: (): string => 'worker:cron-status',
  // Per-(symbol, interval, indicatorId) serialised incremental-indicator
  // state. Written by the worker's IndicatorComputer after each fold;
  // consumed on cold-start to re-seed without re-walking the full window.
  // 24h TTL matches the indicator-bundle TTL — a profile silent for a
  // day re-seeds from the ZSET anyway.
  indicatorState: (symbol: string, interval: string, indicatorId: string): string =>
    `indicatorState:${symbol}:${interval}:${indicatorId}`,
  // Discovery-cron keys, per unwrapped profile id. The cron is the writer; the
  // api dashboard reads `discoveryExplain` and the tick bundle-builder reads
  // `discoveryEnterOnAdd`, so the grammar crosses the worker→api/tick boundary
  // and lives here as the single source rather than as inline literals.
  discoveryLastRun: (pid: string): string => `discovery:lastrun:${pid}`,
  discoveryAdded: (pid: string): string => `discovery:added:${pid}`,
  discoveryFlat: (pid: string): string => `discovery:flat:${pid}`,
  discoveryExplain: (pid: string): string => `discovery:explain:${pid}`,
  discoveryEnterOnAdd: (pid: string): string => `discovery:enter-on-add:${pid}`,
  // Current orphan-order set for ONE account, written by the worker's
  // `orphan-orders-detect` cron and read by the api's `/orphan-orders` route. Per
  // account, because an order book belongs to exactly one Binance key pair: a
  // shared key would serve one account's untracked orders to another. The api
  // cannot reach Binance, so this snapshot is its only view of orders open on the
  // exchange that no local row tracks.
  orphanSnapshot: (accountId: string): string => `orphan-detect:snapshot:${accountId}`,
  // Alert bookkeeping for the same cron: `alerted` dedups to one alert per
  // orphan, `seen` backs the two-tick confirmation gate. Members are bare order
  // ids (unique within an account, which the key now is).
  //
  // PER ACCOUNT, like the snapshot, because both sets are REWRITTEN from the
  // accounts the cron actually scanned this tick — and it skips an account whose
  // `getOpenOrders` failed rather than aborting the whole tick. A single global
  // set would therefore prune a skipped account's keys as "no longer orphaned":
  // its alerted keys drop (a duplicate alert on recovery) and its seen keys drop
  // (its two-tick confirmation restarts, delaying a genuine orphan).
  //
  // Exposed here rather than kept private to the cron because the adopt route
  // must evict an adopted order from both sets synchronously — otherwise the
  // stale membership keeps it out of the next alert cycle.
  orphanAlerted: (accountId: string): string => `orphan-detect:alerted:${accountId}`,
  orphanSeen: (accountId: string): string => `orphan-detect:seen:${accountId}`,
  // Market-trend snapshot: BTC/ETH daily regime + universe breadth, written by
  // the worker's `market-trend` cron and read by the api's `/market-trend`
  // route. Global market data (no profile), so a single key serves every
  // operator view. Written without a TTL so the dashboard always has a value;
  // each cycle overwrites it, and staleness is surfaced by the snapshot's
  // `computedAtMs` on the card, not by the key expiring.
  marketTrend: (): string => `market-trend:snapshot`,
  // Per-symbol last price map, written by the same `market-trend` cron from its
  // all-tickers fetch and read by the profile-dashboard projection to value each
  // held asset. Global market data (no profile). Written without a TTL so the
  // dashboard always has prices; each cycle overwrites it.
  usdPriceMap: (): string => `market-trend:usd-price-map`,
} as const satisfies Record<string, (...args: never[]) => string>;

export type GlobalScopedKeyName = keyof typeof GLOBAL_KEYS;

/**
 * TTL of {@link GLOBAL_KEYS.orphanSnapshot}. Shared by the worker cron that writes
 * it and the api's adopt route that rewrites it, because the TTL is the ONLY thing
 * that stops a dead worker's stale orphan set from being served to an operator who
 * might act on it — a rewrite that dropped or "kept" a TTL the key no longer has
 * would make the snapshot immortal.
 */
export const ORPHAN_SNAPSHOT_TTL_S = 3_600;

// =============================================================================
// Typed wrapper
// =============================================================================

export interface ScopedRedis {
  raw(): Redis;
  forProfile(scope: RedisProfileScope): ProfileRedisOps;
  forGlobal(): GlobalRedisOps;
  quit(): Promise<'OK'>;
}

type ParamsOf<T> = T extends (...args: infer A) => string ? A : never;

export interface ProfileRedisOps {
  get<K extends ProfileScopedKeyName>(
    name: K,
    ...params: ParamsOf<(typeof PROFILE_KEYS)[K]>
  ): Promise<string | null>;
  set<K extends ProfileScopedKeyName>(
    name: K,
    value: string,
    options: { ttlSeconds?: number },
    ...params: ParamsOf<(typeof PROFILE_KEYS)[K]>
  ): Promise<'OK' | null>;
  del<K extends ProfileScopedKeyName>(
    name: K,
    ...params: ParamsOf<(typeof PROFILE_KEYS)[K]>
  ): Promise<number>;
  /**
   * Atomic read-and-delete. Used by the worker tick handler to consume a
   * single-shot operator-pushed value, like a manual-order override the
   * API wrote with a 300s TTL. The atomic primitive guarantees the value
   * is observed exactly once across replicas — without it, two concurrent
   * ticks racing on the same key would both act on the override.
   */
  getdel<K extends ProfileScopedKeyName>(
    name: K,
    ...params: ParamsOf<(typeof PROFILE_KEYS)[K]>
  ): Promise<string | null>;
}

export interface GlobalRedisOps {
  get<K extends GlobalScopedKeyName>(
    name: K,
    ...params: ParamsOf<(typeof GLOBAL_KEYS)[K]>
  ): Promise<string | null>;
  set<K extends GlobalScopedKeyName>(
    name: K,
    value: string,
    options: { ttlSeconds?: number },
    ...params: ParamsOf<(typeof GLOBAL_KEYS)[K]>
  ): Promise<'OK' | null>;
}

export const createRedis = (url: string): ScopedRedis => {
  const redis = new Redis(url);

  const forProfile = (scope: RedisProfileScope): ProfileRedisOps => {
    const prefix = profilePrefix(scope);
    const buildKey = <K extends ProfileScopedKeyName>(
      name: K,
      params: ParamsOf<(typeof PROFILE_KEYS)[K]>,
    ): string => prefix + (PROFILE_KEYS[name] as (...a: unknown[]) => string)(...params);
    return {
      async get(name, ...params) {
        return redis.get(buildKey(name, params));
      },
      async set(name, value, options, ...params) {
        const k = buildKey(name, params);
        if (options.ttlSeconds !== undefined) {
          return redis.set(k, value, 'EX', options.ttlSeconds);
        }
        return redis.set(k, value);
      },
      async del(name, ...params) {
        return redis.del(buildKey(name, params));
      },
      async getdel(name, ...params) {
        return redis.getdel(buildKey(name, params));
      },
    };
  };

  const forGlobal = (): GlobalRedisOps => {
    const buildKey = <K extends GlobalScopedKeyName>(
      name: K,
      params: ParamsOf<(typeof GLOBAL_KEYS)[K]>,
    ): string => (GLOBAL_KEYS[name] as (...a: unknown[]) => string)(...params);
    return {
      async get(name, ...params) {
        return redis.get(buildKey(name, params));
      },
      async set(name, value, options, ...params) {
        const k = buildKey(name, params);
        if (options.ttlSeconds !== undefined) {
          return redis.set(k, value, 'EX', options.ttlSeconds);
        }
        return redis.set(k, value);
      },
    };
  };

  return {
    raw: () => redis,
    forProfile,
    forGlobal,
    quit: () => redis.quit(),
  };
};

// =============================================================================
// BullMQ connection
// =============================================================================
//
// BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`.
// See https://docs.bullmq.io/guide/connections.

export interface BullMQConnectionOptions {
  url: string;
}

interface BullMQRedisConnection {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
  readonly maxRetriesPerRequest: null;
  readonly enableReadyCheck: false;
}

type ParsedRedisUrl = Omit<BullMQRedisConnection, 'maxRetriesPerRequest' | 'enableReadyCheck'>;

export const createBullMQConnection = (opts: BullMQConnectionOptions): BullMQRedisConnection => ({
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // ioredis accepts the URL via the `Redis` constructor, but BullMQ wants
  // an options object. Encode the URL into the connection options here so
  // callers pass a single object across worker, queue, and queueScheduler.
  ...parseRedisUrl(opts.url),
});

const parseRedisUrl = (url: string): ParsedRedisUrl => {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number.parseInt(parsed.pathname.slice(1), 10) : NaN;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(Number.isFinite(db) ? { db } : {}),
  };
};
