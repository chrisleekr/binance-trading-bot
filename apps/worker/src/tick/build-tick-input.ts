// TickInput assembler.
//
// Owns the read + assembly half of a tick: parse-or-cold-load account and
// open-orders (with write-through), reconcile + migrate the per-(profile,
// symbol) state slice through the StatePort, source the candle window and
// revive indicators, then build the market snapshot and the final TickInput.
//
// Returns a discriminated result so the kill-switch short-circuit stays
// explicit instead of riding a thrown control-flow exception. The handler
// keeps lifecycle (chain lock, DLQ-on-throw, commit, audit, metrics,
// tick-meta stamp); this module keeps "produce a TickInput or a kill-switch
// signal". A migration failure throws here and the handler annotates + DLQs.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MarketDataPort } from '@app/binance';
import type {
  AccountSnapshot,
  AnyStrategy,
  Candle,
  IndicatorSnapshot,
  OpenOrder,
  TickInput,
  TriggerEvent,
} from '@app/strategy-core';
import { resolveCandleWindow } from '@app/strategy-core';
import type {
  AccountId,
  ManualOverridePayload,
  ProfileId,
  TechnicalsBundleConfig,
  UserId,
} from '@app/contracts';
import { type ProfileScope, profileRepoFromScope } from '@app/db';
import { buildOpenOrdersKey } from 'executor/redis-namespace.js';
import { OPEN_ORDERS_TTL_S } from 'executor/open-orders-cache.js';
import { reserveAdjustedBalance } from 'lib/reserve.js';
import type { StateLoad, StatePort } from 'state/state-port.js';
import type { ProfileResolved } from 'profile-bindings/resolved-config.js';
import type { TickBundleResult } from './bundle-builder.js';
import type { OverrideTicket } from './override-ticket.js';
import type { SymbolInfoCache } from './symbol-info-cache.js';
import {
  apiLimitsFrom,
  buildMarketSnapshot,
  parseAccountSnapshot,
  parseIndicatorSnapshot,
  parseOpenOrders,
  type RawSnapshot,
  type SnapshotColdLoad,
} from './snapshot-loader.js';

export interface ProfileTickContext extends ProfileResolved {
  /** Operator (owner) of this profile's account. Threaded to Binance credential resolution and audit. */
  readonly operatorId: UserId;
  /** Binance account this profile runs under. Keys every Redis namespace and per-account read. */
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  /**
   * The owning account's proven scope, resolved once when this context is
   * built. Threaded into the StatePort read/commit so the per-tick state
   * I/O reuses the single ownership proof instead of re-running
   * `scopeProfile` (#397) and so every account-scoped write goes through
   * the typed `ProfileScope` repo (#396).
   */
  readonly scope: ProfileScope;
  readonly symbol: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly config: unknown;
  readonly bundleProvider: (
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
    tvConfig: TechnicalsBundleConfig,
    bundleProviders: readonly string[],
  ) => Promise<TickBundleResult>;
  readonly binanceMode: 'test' | 'live';
  // `quoteAsset` + `weightLimit1m` come from {@link ProfileResolved}. quoteAsset
  // also bounds the cross-profile deployed-quote aggregate to one quote unit
  // (pairs with binanceMode as the scope of `loadAccountDeployedQuote`).
  /**
   * Active candle interval for this profile. Derived from
   * `config.candleInterval` at context-build time so the tick handler
   * doesn't have to re-parse the strategy-specific config shape here.
   * Strategies that don't track this concept default to '1h' upstream.
   */
  readonly candleInterval: string;
  /**
   * Operator-owned Technicals freshness gate the bundle provider hands
   * to the strategy in `bundle.technicals.config`. Parsed off the
   * profile config at context-build time, same strategy-agnostic
   * pattern as {@link candleInterval}; strategies that ignore TV
   * receive the safe built-in defaults and never read this field.
   */
  readonly technicalsConfig: TechnicalsBundleConfig;
  /**
   * Whether this profile's resolved config arms the account-wide exposure
   * cap (`buy.maxAccountExposureQuote`). Computed at context-build time
   * (same strategy-agnostic config parse as {@link candleInterval}) so the
   * assembler stays plugin-boundary-clean. When false, the per-tick
   * cross-profile deployed-quote aggregate is skipped: its only consumer is
   * the cap, so a disarmed profile pays nothing for it.
   */
  readonly needsAccountDeployedQuote: boolean;
  /**
   * Per-symbol reserve floor in base units (decimal-string), or null when the
   * operator has set none. The assembler subtracts it from the bot-visible base
   * balance so sell-sizing trades only the surplus above it and never sells into
   * the reserve (#498). Sourced from the `profile_symbols` row in
   * {@link buildProfileTickContext}; the pure strategy never sees the reserve.
   */
  readonly reserveBaseQuantity: string | null;
}

/**
 * The subset of {@link TickHandlerDeps} the assembler needs. Declaring it
 * narrowly keeps the read seam honest about its dependencies; the full
 * handler deps satisfy it structurally.
 */
export interface TickInputDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly coldLoad: SnapshotColdLoad;
  readonly symbolInfoCache: SymbolInfoCache;
  readonly statePort: StatePort;
  readonly marketDataPort: MarketDataPort;
  readonly candleWindowSize?: number;
}

export interface BuildTickInputArgs {
  readonly profile: ProfileTickContext;
  readonly strategy: AnyStrategy;
  readonly raw: RawSnapshot;
  /**
   * The same interval list the caller passed to `readRawSnapshot` to build
   * `raw`. Threaded in (rather than re-derived from `raw`) so the candle and
   * indicator loops cannot drift from what the snapshot was actually read
   * for — the assembler stays decoupled from how the snapshot map is keyed.
   */
  readonly intervals: readonly string[];
  readonly clock: { nowMs(): number };
  readonly rng: { next(): number };
  readonly trigger: TriggerEvent;
  /**
   * The live last-trade price that fired this tick (a mini-ticker frame's
   * close), when present. It overrides the closed-candle `currentPrice` so
   * stops/exits/entries evaluate the price that actually just traded rather than
   * the freshest closed candle (≤60s stale). Absent for non-mini-ticker
   * triggers and for replay, which then fall back to the closed-candle price —
   * keeping golden fixtures byte-identical. Indicators are NOT affected; only
   * the `currentPrice` scalar.
   */
  readonly livePrice?: string | undefined;
  /**
   * The tick's paired release for the override the bundle-builder consumes
   * destructively. Passed IN rather than returned: on every path that throws
   * there is no return value, and those are exactly the paths that would
   * otherwise lose the operator's override.
   */
  readonly overrideTicket: OverrideTicket;
}

export type BuiltTick =
  | { readonly kind: 'kill-switch' }
  | { readonly kind: 'symbol-paused' }
  | {
      readonly kind: 'ready';
      readonly input: TickInput<unknown, unknown, Readonly<Record<string, unknown>>>;
      // Commits the strategy's next body stamped at the version the read
      // settled on, captured inside the closure. The handler calls this
      // after `strategy.tick`; it never sees or threads the version.
      readonly commit: StateLoad['commit'];
      /**
       * Remaining lifetime of the override key the bundle-builder consumed for
       * this tick, when it projected one. Rides on the worker-internal built tick
       * rather than on `input.bundle` because the bundle is passed to strategy
       * code as-is (nothing re-parses it), and this is the worker's own
       * bookkeeping for re-arming the key it deleted.
       */
      readonly overrideTtlMs?: number;
    };

// Open-orders cache TTL on the cold-load write-through. Freshness after a real
// order event is event-driven, not TTL-driven: the executor upserts/removes this
// key on place/cancel and the event-router patches/removes it on every
// `executionReport` (including partial fills), so the cached list tracks the book
// without a refetch. The TTL only governs a QUIET symbol with no events, plus a
// dropped WS signal, with the 10-min orphan-detect cron as the final backstop —
// so it matches that cadence. Shared with the mutation Lua so the cold-load and
// every in-place write refresh the SAME 10-min ceiling.
const OPEN_ORDERS_CACHE_TTL_S = OPEN_ORDERS_TTL_S;

/**
 * Read a strategy state's `entryBlocker.reason` defensively. The assembler is
 * strategy-agnostic, so it cannot import a strategy's state type; it reads the
 * well-known `entryBlocker` convention ({ reason, detail? } | null) off the raw
 * state object and ignores any state that does not adopt it. Returns the reason
 * code, or null when there is no blocker (or the field is absent / malformed).
 */
interface EntryBlockerShape {
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}
const readEntryBlocker = (state: unknown): EntryBlockerShape | null => {
  if (typeof state !== 'object' || state === null) return null;
  const raw = (state as Record<string, unknown>)['entryBlocker'];
  if (typeof raw !== 'object' || raw === null) return null;
  const reason = (raw as Record<string, unknown>)['reason'];
  if (typeof reason !== 'string') return null;
  const detail = (raw as Record<string, unknown>)['detail'];
  return {
    reason,
    ...(typeof detail === 'object' && detail !== null
      ? { detail: detail as Readonly<Record<string, unknown>> }
      : {}),
  };
};

/**
 * Wrap a {@link StateLoad}'s `commit` so an entry-blocker change (the strategy's
 * structured "why no buy this tick" reason) writes ONE action_log on transition.
 * Per-tick gate vetoes used to spam an action_log every tick; here only a CHANGE
 * of reason is recorded, so a steady "waiting for a dip" state logs once, not
 * 86k/day. Best-effort: the append is swallowed so it never throws into the tick
 * path — the state commit must still succeed even if the audit write fails.
 */
const wrapCommitWithEntryBlockerAudit = (
  load: StateLoad,
  ctx: {
    readonly scope: ProfileScope;
    readonly symbol: string;
    readonly profileId: ProfileId;
    readonly clock: { nowMs(): number };
    readonly logger: Logger;
  },
): StateLoad['commit'] => {
  const prevReason = readEntryBlocker(load.state)?.reason ?? null;
  return async (nextState, timeoutMs) => {
    await load.commit(nextState, timeoutMs);
    const next = readEntryBlocker(nextState);
    const nextReason = next?.reason ?? null;
    if (nextReason === prevReason) return;
    try {
      await profileRepoFromScope(ctx.scope).actionLogs.append({
        time: new Date(ctx.clock.nowMs()),
        symbol: ctx.symbol,
        level: 'info',
        msg:
          nextReason === null
            ? `${ctx.symbol}: entry no longer blocked`
            : `${ctx.symbol}: not buying (${nextReason})`,
        ctx:
          next === null
            ? { source: 'entry-blocker', reason: null, previousReason: prevReason }
            : {
                source: 'entry-blocker',
                reason: next.reason,
                ...(next.detail ? { detail: next.detail } : {}),
              },
      });
    } catch (err) {
      ctx.logger.warn(
        { profileId: ctx.profileId, symbol: ctx.symbol, err: err },
        'entry-blocker action_log append failed (state already committed)',
      );
    }
  };
};

/**
 * Cold-load open orders from Binance REST and write them through to Redis
 * with the safety TTL so the next tick reads cache instead of hammering REST.
 * Steady-state maintenance is event-driven: the executor upserts/removes this
 * key on place/cancel and the event-router patches/removes it on
 * `executionReport`; the TTL is the fail-safe ceiling if those signals drop.
 *
 * The write-through is `SET … NX`: it only seeds an ABSENT key. If this REST
 * call is in-flight while the executor's atomic mutation already established a
 * (fresher) list, NX declines the write rather than clobbering it with a
 * pre-place snapshot — so the cold-load can never overwrite a live mutation. In
 * the worst case a stale snapshot loses the race and a place is re-attempted;
 * Binance dedupes it under the same `clientOrderId`, so the consequence is one
 * rejected re-place, never a double-fill.
 */
const loadOpenOrdersFresh = async (
  deps: TickInputDeps,
  profile: ProfileTickContext,
): Promise<readonly OpenOrder[]> => {
  const { operatorId, accountId, profileId, symbol } = profile;
  const openOrders = await deps.coldLoad.loadOpenOrders(operatorId, accountId, profileId, symbol);
  try {
    await deps.redis.set(
      buildOpenOrdersKey(accountId, symbol),
      JSON.stringify(openOrders),
      'EX',
      OPEN_ORDERS_CACHE_TTL_S,
      'NX',
    );
  } catch (err) {
    deps.logger.warn(
      { profileId, symbol, err: err },
      'tick: open-orders write-through failed (next tick will REST again)',
    );
  }
  return openOrders;
};

/**
 * Apply the per-symbol reserve to the base-asset line of an account snapshot:
 * the bot then sees `wallet − reserve` base, so sell-sizing trades only the
 * surplus and never sells into the reserve (#498). Returns the snapshot
 * unchanged when no reserve is set or the base line is absent — strategy-
 * agnostic and inert by default. `reserveAdjustedBalance` (free-then-locked
 * drain) is the same primitive the boot reconciler uses for position adoption,
 * so adoption and sell-sizing stay consistent.
 */
const applyReserveToBase = (
  account: AccountSnapshot,
  baseAsset: string,
  reserve: string | null,
): AccountSnapshot => {
  const bal = account.balances[baseAsset];
  if (!bal || reserve === null || reserve === '') return account;
  const adjusted = reserveAdjustedBalance(bal.free, bal.locked, reserve);
  return {
    ...account,
    balances: { ...account.balances, [baseAsset]: { ...bal, ...adjusted } },
  };
};

export const buildTickInput = async (
  deps: TickInputDeps,
  args: BuildTickInputArgs,
): Promise<BuiltTick> => {
  const { profile, strategy, raw, intervals, clock, rng, trigger, livePrice } = args;
  const { operatorId, accountId, profileId, symbol } = profile;

  // Kill-switch short-circuit. No further reads; the handler emits a noop
  // throttled tick and the WS subscriptions stay open for a fast resume.
  if (raw.killSwitch !== null) return { kind: 'kill-switch' };

  // Per-symbol pause short-circuit. Checked after the kill-switch (which is
  // broader: it halts the whole profile) so a paused coin also emits a noop
  // throttled tick, freezing new buy+sell decisions while resting orders stay.
  if (raw.symbolDisable !== null) return { kind: 'symbol-paused' };

  // Mode-scoped: a test-mode profile reads testnet's filters (tickSize / lot),
  // which differ from production — arming an order off production filters gets
  // rejected on testnet (-1013 PRICE_FILTER).
  const symbolInfo = await deps.symbolInfoCache.get(symbol, profile.binanceMode);
  const accountBalances =
    raw.accountInfo !== null
      ? parseAccountSnapshot(raw.accountInfo, (info) =>
          deps.logger.warn(
            { operatorId, profileId, ...info },
            'parseAccountSnapshot: malformed wire balance, degraded to 0',
          ),
        )
      : await deps.coldLoad.loadAccount(operatorId, accountId, profileId);
  // Inject the account-wide deployed total (sum across this user's profiles in
  // the same mode + quote asset) ONLY when this profile arms the opt-in account
  // exposure cap or percent-of-account sizing. The
  // balance readers have no cross-profile view, so the assembler is the single
  // place this scalar is filled; the strategy reads it to enforce the cap while
  // staying per-(profile, symbol)-pure. The fill is a `SUM(avg×qty) JOIN
  // profiles` aggregate on the hottest path. Gating it on the
  // context-computed flag avoids one indexed query per tick for every profile
  // that has not opted in (the default). The field is optional on
  // AccountSnapshot, so omitting it leaves the cap check defaulting to '0'.
  const accountBeforeReserve: AccountSnapshot = profile.needsAccountDeployedQuote
    ? {
        ...accountBalances,
        // Scope the cross-profile deployed total to this profile's trading
        // environment so a live tick never folds in test-mode practice
        // positions or a different quote unit (equity = cash + deployed, and
        // cash is already per-(profile, mode)).
        deployedQuoteAcrossProfiles: await deps.coldLoad.loadAccountDeployedQuote(
          accountId,
          profile.quoteAsset,
        ),
      }
    : accountBalances;
  // Reserve overlay: subtract the operator's per-symbol reserve floor (base
  // units) from the bot-visible base balance so sell-sizing trades only the
  // surplus above it and never sells into the reserve (#498). Inert when unset.
  const account = applyReserveToBase(
    accountBeforeReserve,
    symbolInfo.baseAsset,
    profile.reserveBaseQuantity,
  );
  const openOrders: readonly OpenOrder[] =
    raw.openOrders !== null
      ? parseOpenOrders(raw.openOrders)
      : await loadOpenOrdersFresh(deps, profile);

  // Read the per-(profile, symbol) slice through the port: reconcile the
  // pipelined cache body against the durable PG row by schemaVersion,
  // cold-load + seed on miss, then migrate. The returned `commit` closure
  // has already captured the version the read settled on, so the handler
  // commits the strategy's next body without ever seeing or threading the
  // stamp. A migration failure throws; the specific line is logged here
  // before the handler stamps tick-meta and DLQs.
  const loadState = async (): Promise<StateLoad> => {
    try {
      return await deps.statePort.loadForTick(
        profile.scope,
        symbol,
        strategy,
        profile.config,
        raw.state,
      );
    } catch (err) {
      deps.logger.error(
        { profileId, symbol, toVersion: strategy.version, err: err },
        'state migration failed, DLQ + state untouched',
      );
      throw err;
    }
  };

  // Two independent round-trips (Postgres for the state slice, Redis for the
  // bundle), issued together instead of one after the other.
  //
  // `allSettled`, never `Promise.all`: the handler classifies a thrown tick by
  // pattern-matching the error (a delisted symbol self-heals, a governor-unavailable
  // Redis skips, anything else dead-letters), so WHICH of two simultaneous failures
  // surfaces has to be deterministic. `Promise.all` rejects with whichever lost the
  // race. Inspecting the settled results in a fixed order keeps the classification
  // identical to the serial version that ran the state load first. It also stops the
  // loser's rejection from going unhandled.
  //
  // Honour the strategy's declared bundle providers so the builder assembles
  // only what the strategy reads (momentum declares none → no Redis round-trip),
  // matching the backtest runner. The opaque boot-time provider can't see the
  // strategy, so the set is threaded here where `strategy` is in scope.
  //
  // Wrapped rather than called raw into the array: `bundleProvider` is an injected
  // dep, and one that threw SYNCHRONOUSLY would abandon the already-created
  // `loadState()` promise before `allSettled` could attach a handler — an unhandled
  // rejection, which Node terminates the worker for by default.
  const readBundle = async (): Promise<TickBundleResult> =>
    profile.bundleProvider(
      accountId,
      profileId,
      symbol,
      profile.technicalsConfig,
      strategy.capabilities.bundleProviders,
    );

  const [stateSettled, bundleSettled] = await Promise.allSettled([loadState(), readBundle()]);

  // Before the rejection checks and before any further await: a bundle read that
  // SUCCEEDED has already DEL'd the operator's override key, and it did so whether
  // or not the state load beside it blew up. Registering the ticket first is what
  // makes the concurrency safe.
  if (bundleSettled.status === 'fulfilled') {
    const consumed = (bundleSettled.value.bundle as { override?: ManualOverridePayload | null })
      .override;
    if (consumed?.overrideActionId) {
      args.overrideTicket.arm({
        scope: profile.scope,
        override: consumed,
        ...(bundleSettled.value.overrideTtlMs === undefined
          ? {}
          : { ttlMs: bundleSettled.value.overrideTtlMs }),
      });
    }
  }

  if (stateSettled.status === 'rejected') {
    // Only one error can be thrown, and the fixed precedence picks the state load.
    // Running the reads together is what created a second one, so log the loser
    // rather than let the parallelisation swallow it.
    if (bundleSettled.status === 'rejected') {
      deps.logger.warn(
        { profileId, symbol, err: bundleSettled.reason },
        'tick: bundle read also failed; the state-load failure is the one being thrown',
      );
    }
    throw stateSettled.reason;
  }
  if (bundleSettled.status === 'rejected') throw bundleSettled.reason;

  const finalState: unknown = stateSettled.value.state;
  const commit: StateLoad['commit'] = wrapCommitWithEntryBlockerAudit(stateSettled.value, {
    scope: profile.scope,
    symbol,
    profileId,
    clock,
    logger: deps.logger,
  });
  const { bundle, overrideTtlMs } = bundleSettled.value;
  const limits = apiLimitsFrom(raw.weightUsed1m, profile.weightLimit1m);

  // Source candles from the market-data port. Steady state: the
  // KlineFetcher's per-(symbol, interval) ring is populated by the WS
  // subscriber. Cold start takes the port's weight-governed REST fallback
  // inside `loadWindow`. The freshest-candle price selection lives in
  // `selectCurrentPrice`, called by `buildMarketSnapshot`.
  // Size the window from the strategy's config-derived lookback (floored at the
  // default, capped at the ceiling), the SAME policy the backtest engine uses, so
  // a config's lookback is honoured identically live and in backtest. `loadWindow`
  // REST-falls-back (weight-governed) when the request exceeds the kline ring.
  const candleWindowSize =
    deps.candleWindowSize ?? resolveCandleWindow(strategy.requiredWindow?.(profile.config));
  // Load each interval's window concurrently: the reads are independent, and on
  // a cold start every interval would otherwise stack a serial REST round-trip
  // through `loadWindow`'s weight-governed fallback. `Promise.all` preserves
  // index order, so the map is rebuilt deterministically.
  const windows = await Promise.all(
    intervals.map((iv) => deps.marketDataPort.loadWindow(symbol, iv, candleWindowSize)),
  );
  const candlesByInterval: Record<string, readonly Candle[]> = {};
  intervals.forEach((iv, i) => {
    candlesByInterval[iv] = windows[i] ?? [];
  });

  // Revive the per-interval indicator cache the IndicatorComputer wrote on
  // the last closed candle. A miss (cold worker, short window) leaves the
  // key absent; the strategy treats absent indicators as "not yet available".
  const indicatorsByInterval: Record<string, IndicatorSnapshot> = {};
  for (const iv of intervals) {
    const parsed = parseIndicatorSnapshot(raw.indicatorsByInterval[iv] ?? null);
    if (parsed) indicatorsByInterval[iv] = parsed;
  }
  // `livePrice` (the mini-ticker frame that fired this tick) overrides the
  // closed-candle currentPrice when present; absent → closed-candle fallback.
  // Only the price scalar is overridden — candle windows and indicators stay
  // closed-candle-sourced.
  const market = buildMarketSnapshot(
    symbol,
    symbolInfo,
    candlesByInterval,
    indicatorsByInterval,
    livePrice,
  );
  // debug, not info: this fires on every successful tick (~1/sec/symbol), so an
  // info line is pure per-tick noise (~86k lines/day per pair). The tick-meta
  // stamp + metrics carry the operational signal; failures log at warn/error.
  // Same rationale as the technicals-compute cron's downgraded completion line.
  deps.logger.debug(
    {
      symbol,
      currentPrice: market.currentPrice,
      candleCount: Object.values(candlesByInterval).flat().length,
    },
    'tick-handler: bundle ready',
  );

  // Cross-symbol KV snapshot (tracker #267), gated on the strategy opting in —
  // the same one-read-per-tick gating the account-deployed total uses. The
  // per-symbol strategies leave `needsProfileKv` false and pay nothing; a
  // cross-symbol strategy reads the merged store the worker folds from PG.
  const profileKv = strategy.capabilities.needsProfileKv
    ? await deps.coldLoad.loadProfileKv(profile.scope)
    : undefined;

  const input: TickInput<unknown, unknown, Readonly<Record<string, unknown>>> = {
    clock,
    rng,
    trigger,
    profile: {
      id: profileId,
      userId: operatorId,
      binanceMode: profile.binanceMode,
      status: 'running',
      strategyVersion: strategy.version,
    },
    config: profile.config,
    state: finalState,
    market,
    account,
    openOrders,
    bundle,
    limits,
    ...(profileKv ? { profileKv } : {}),
  };

  return {
    kind: 'ready',
    input,
    commit,
    ...(overrideTtlMs === undefined ? {} : { overrideTtlMs }),
  };
};
