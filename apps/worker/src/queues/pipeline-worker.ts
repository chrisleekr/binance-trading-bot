// Pipeline-queue dispatcher. The api enqueues control-plane events
// (subscribe-profile, unsubscribe-profile, verify-key, ...) into one
// shared queue named `pipeline`; this module registers a single Worker
// that dispatches on `job.name` and routes to the matching action.
//
// Without this worker, jobs accumulate in `bull:pipeline:wait` and the
// ProfileManager never learns about API-initiated enable/disable.
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { NotifyProviderRegistry } from '@app/notify';
import { BinanceApiError, type BinanceMode, type BinanceRestClient } from '@app/binance';
import {
  asAccountId,
  asProfileId,
  asUserId,
  ProfileDeleteDisposition,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { accountRepo, profileRepo, ProfileNotOwnedError, repo, type Database } from '@app/db';
import { Decimal } from '@app/money';
import type { Clock, StrategyRegistry } from '@app/strategy-core';
import type { LiveExecutor } from 'executor/live-executor.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { MetricsSink } from 'metrics/catalog.js';
import { reserveAdjustedBalance } from 'lib/reserve.js';
import type { StatePort } from 'state/state-port.js';
import { mutateSymbolState, type MutateSymbolStateDeps } from 'state/version-aware-mutate.js';
import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import { ensureCostBasisFromTrades, reconcileSymbol } from 'boot/reconcile-held-quantity.js';
import { buildBinanceClient } from 'profile-bindings/binance-client.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';
import { resolveTechnicalsIntervals } from 'profile-manager/technicals-intervals.js';
import type { QueueSet } from 'queues/queue-set.js';
import { handleCancelOrder } from 'queues/pipeline-handlers/cancel-order.js';
import { handleDisposeProfile } from 'queues/pipeline-handlers/dispose-profile.js';
import { handleArchiveGridTrade } from 'queues/pipeline-handlers/archive-grid-trade.js';
import { handleBackfillTradeArchive } from 'queues/pipeline-handlers/backfill-trade-archive.js';
import { handleReconcileFees } from 'queues/pipeline-handlers/reconcile-fees.js';
import { handleResetGridTrade } from 'queues/pipeline-handlers/reset-grid-trade.js';

export interface PipelineWorkerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly profileManager: ProfileManager;
  readonly strategies: StrategyRegistry;
  readonly executor: LiveExecutor;
  readonly clock: Clock;
  // The per-(profile, symbol) state boundary, shared with the tick handler.
  // `reset-grid-trade` clears the grid cycle through it so the write lands in
  // the same `symbol_states` store the tick reads.
  readonly statePort: StatePort;
  // Shared `chainByKey` instance with the tick handler. State-mutating
  // pipeline jobs (cancel-order, archive-grid-trade, reset-grid-trade)
  // run under the same `${profileId}:${symbol}` key as the tick (see
  // `tick-handler.ts` for the canonical key shape). `profiles.id` is
  // the PK across all tenants so userId scoping is redundant in the
  // chain key; a future migration to per-tenant id namespaces would
  // need to update both this site and the tick handler in lockstep. A
  // concurrent tick cannot interleave between this handler's read-
  // modify-write on the symbol_states slice (via StatePort) or on the
  // orders table.
  // Pipeline concurrency is 4 (queue-names.ts) so duplicate-click
  // archives and resets land in the same chain and serialise; the
  // second one observes the first's `latestArchivedAt` and short-
  // circuits, making the operation idempotent by construction.
  readonly chain: ChainByKey;
  readonly logger: Logger;
  /** Notifier registry, used by the disposal to announce a residual resting order. */
  readonly notifyRegistry: NotifyProviderRegistry;
  /** Public "Live demo" mode: suppresses the disposal's residual-orders alert. */
  readonly liveDemo?: boolean;
  // Per-profile signed REST client, threaded into the archive-grid-trade
  // handler so it can pull `myTrades` and sum the cycle's Binance commissions.
  readonly resolveBinanceClient: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
  // Drop the cross-tick profile-context cache for a profile on reconfigure so
  // an operator's config/symbol edit is visible on the next tick. Optional so
  // tests that don't exercise the cache can omit it.
  readonly evictProfileContext?: (profileId: ProfileId) => void;
  // Same `mutateSymbolState` deps the boot reconciler holds. Threaded so the
  // mid-run reconfigure path (an operator adopt newly subscribes a symbol with
  // no worker restart) can reconcile heldQuantity + revive avgEntryPrice for
  // each current symbol through the identical machinery, closing the gap where
  // a freshly-adopted held position reads as flat and triggers re-entry BUYs.
  readonly symbolStateDeps: MutateSymbolStateDeps;
  // Re-elect user-data stream ownership after a subscribe/unsubscribe changes
  // the active set. profileManager no longer opens the stream on enable, so
  // this converges it promptly instead of waiting for ownership's own interval
  // (#579). Optional: tests that don't exercise stream ownership omit it.
  readonly reconcileOwnership?: () => Promise<void>;
  // Retires the profile's own metric children on teardown. Optional like every
  // other sink injection point, so a stub deps object stays a no-op rather than
  // a throw.
  readonly metrics?: MetricsSink;
}

/**
 * Exported for the producer→worker payload-seam test: producers in other modules
 * (boot reconfigure-enqueue, discovery cron, api routes) build this payload by
 * hand, so a field dropped on the producer side parses to `null` here. See
 * {@link requirePayload} for what that does to the job.
 */
export const parseProfileJob = (
  data: unknown,
): { userId: UserId; accountId: AccountId; profileId: ProfileId } | null => {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { userId?: unknown; accountId?: unknown; profileId?: unknown };
  if (
    typeof d.userId !== 'string' ||
    typeof d.accountId !== 'string' ||
    typeof d.profileId !== 'string'
  )
    return null;
  return {
    userId: asUserId(d.userId),
    accountId: asAccountId(d.accountId),
    profileId: asProfileId(d.profileId),
  };
};

/**
 * Exported for the api→worker payload-seam test: the api enqueues this job from a
 * different package, and a rename on either side would otherwise leave a profile
 * that can never be deleted, with nothing failing.
 */
export const parseDisposeProfileJob = (
  data: unknown,
): {
  userId: UserId;
  accountId: AccountId;
  profileId: ProfileId;
  disposition: ProfileDeleteDisposition;
  toProfileId?: ProfileId;
} | null => {
  const base = parseProfileJob(data);
  if (base === null) return null;
  const d = data as { disposition?: unknown; toProfileId?: unknown };
  const parsed = ProfileDeleteDisposition.safeParse(d.disposition);
  if (!parsed.success) return null;
  return {
    ...base,
    disposition: parsed.data,
    ...(typeof d.toProfileId === 'string' ? { toProfileId: asProfileId(d.toProfileId) } : {}),
  };
};

/**
 * `verify-key` is an ACCOUNT-level surface: an api-key save has no profile, and
 * the producer accordingly sends `{ userId, accountId }` only. Reusing the
 * profile-scoped parser here rejected every real payload, which the old
 * warn-and-ack swallowed — so key verification never ran and the row sat
 * `pending` forever. Parsing what the producer actually sends is what makes the
 * job run at all.
 */
const parseAccountJob = (data: unknown): { userId: UserId; accountId: AccountId } | null => {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { userId?: unknown; accountId?: unknown };
  if (typeof d.userId !== 'string' || typeof d.accountId !== 'string') return null;
  return { userId: asUserId(d.userId), accountId: asAccountId(d.accountId) };
};

const parseProfileSymbolJob = (
  data: unknown,
): { userId: UserId; accountId: AccountId; profileId: ProfileId; symbol: string } | null => {
  const base = parseProfileJob(data);
  if (base === null) return null;
  const d = data as { symbol?: unknown };
  if (typeof d.symbol !== 'string') return null;
  return { ...base, symbol: d.symbol };
};

const parseBackfillJob = (
  data: unknown,
): {
  userId: UserId;
  accountId: AccountId;
  profileId: ProfileId;
  symbol: string;
  fromMs: number | null;
  toMs: number | null;
} | null => {
  const base = parseProfileSymbolJob(data);
  if (base === null) return null;
  const d = data as { fromMs?: unknown; toMs?: unknown };
  const fromMs = typeof d.fromMs === 'number' ? d.fromMs : null;
  const toMs = typeof d.toMs === 'number' ? d.toMs : null;
  return { ...base, fromMs, toMs };
};

const parseCancelOrderJob = (
  data: unknown,
): {
  userId: UserId;
  accountId: AccountId;
  profileId: ProfileId;
  symbol: string;
  orderId: string;
} | null => {
  const base = parseProfileSymbolJob(data);
  if (base === null) return null;
  const d = data as { orderId?: unknown };
  if (typeof d.orderId !== 'string') return null;
  return { ...base, orderId: d.orderId };
};

// Resolve the active candle interval for a profile. The interval lives on the
// per-profile config, not the strategy capabilities (capabilities is the
// supported universe; the profile picks one). Validate the configured value
// against the strategy's declared capabilities so a stale or hand-edited
// config row can't drive the subscriber to an unsupported stream. Falls back
// to `'1h'` on miss so subscribe and tick-read agree (the strategy schema's
// default is '1h' too); the older `capabilities[0]` fallback diverged from the
// tick-handler default and caused split-brain interval selection on legacy
// rows.
const resolveCandleInterval = (
  config: unknown,
  plugin: NonNullable<ReturnType<StrategyRegistry['get']>>,
  logger: Logger,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId; strategyName: string },
): string => {
  const cfg = config as { candleInterval?: unknown };
  const configured =
    typeof cfg.candleInterval === 'string' &&
    plugin.capabilities.candleIntervals.includes(
      cfg.candleInterval as (typeof plugin.capabilities.candleIntervals)[number],
    )
      ? cfg.candleInterval
      : undefined;
  if (configured === undefined && typeof cfg.candleInterval === 'string') {
    logger.warn(
      {
        ...ids,
        configured: cfg.candleInterval,
        supported: plugin.capabilities.candleIntervals,
      },
      'pipeline_subscribe_unsupported_interval_falling_back_to_1h',
    );
  }
  return configured ?? '1h';
};

const handleSubscribe = async (
  deps: PipelineWorkerDeps,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId },
): Promise<void> => {
  const p = await profileRepo(deps.db, ids.userId, ids.accountId, ids.profileId);
  const profile = await p.profile.findById();
  if (!profile) {
    deps.logger.warn(ids, 'pipeline_subscribe_profile_missing');
    return;
  }
  if (!profile.enabled) {
    deps.logger.info(ids, 'pipeline_subscribe_skipped_disabled');
    return;
  }
  // An unknown strategyName means config drift between api and worker;
  // throw so BullMQ retries (in case of a deploy race) and then routes
  // to DLQ rather than silently acking. Otherwise the operator gets no
  // signal and the profile goes dark.
  const plugin = deps.strategies.get(profile.strategyName);
  if (!plugin) {
    throw new Error(
      `pipeline_subscribe_unknown_strategy: profile=${ids.profileId} strategyName=${profile.strategyName}`,
    );
  }
  const candleInterval = resolveCandleInterval(profile.config, plugin, deps.logger, {
    ...ids,
    strategyName: profile.strategyName,
  });
  const symbolRows = await p.profileSymbols.listForProfile();
  await deps.profileManager.enable({
    userId: ids.userId,
    operatorId: ids.userId,
    accountId: ids.accountId,
    profileId: ids.profileId,
    symbols: symbolRows.map((r) => r.symbol),
    candleInterval,
    technicalsIntervals: resolveTechnicalsIntervals(profile.config),
  });
  // Drop any cached tick context so the first tick after a (re)subscribe
  // reads the profile fresh. Closes a stop -> edit-while-disabled -> re-enable
  // window where a config/override edit made while the API's enabled-gate
  // suppressed the reconfigure signal could otherwise be served stale until
  // the cache TTL. A cache miss here is harmless.
  deps.evictProfileContext?.(ids.profileId);
  // Best-effort kick to open the account's user-data stream promptly: enable
  // only registers membership + market subs, so ownership must re-elect to open
  // the stream (#579). This is a latency optimisation, not the guarantee — if an
  // ownership pass is already in-flight the kick is a no-op, and the periodic
  // enabled-set reconciler opens the stream within one interval regardless (a
  // fill in that window is backfilled by the stream's onResync on open).
  // Best-effort: a kick failure must not DLQ a job whose membership mutation
  // already landed; the periodic reconciler converges regardless.
  await deps.reconcileOwnership?.().catch((err: unknown) => {
    deps.logger.warn({ ...ids, err: err }, 'pipeline_subscribe_ownership_kick_failed');
  });
  deps.logger.info({ ...ids, symbols: symbolRows.length }, 'pipeline_subscribed');
};

const handleReconfigureProfile = async (
  deps: PipelineWorkerDeps,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId },
): Promise<void> => {
  const p = await profileRepo(deps.db, ids.userId, ids.accountId, ids.profileId);
  const profile = await p.profile.findById();
  if (!profile) {
    deps.logger.warn(ids, 'pipeline_reconfigure_profile_missing');
    return;
  }
  // Drop the cached tick context so the edited config/symbol set is read
  // fresh on the next tick rather than after the cache TTL. Unconditional:
  // fires even when the profile isn't active in ProfileManager below (a
  // cache miss is harmless) so no config edit is ever served stale.
  deps.evictProfileContext?.(ids.profileId);
  // Resync ProfileManager's in-memory snapshot from the DB so the entity
  // crons (technicals-compute) and market subscriptions reflect the current
  // symbol set and technicals intervals without a worker reboot. Both are
  // read at enable-time otherwise, so a symbol added or removed after boot
  // would never be ticked or get technicals computed. The caller serializes
  // this per profile (deps.chain on profileId) so the read-then-apply below
  // is atomic across concurrent resyncs.
  const intervals = resolveTechnicalsIntervals(profile.config);

  // Wallet reconcile FIRST, before the ProfileManager membership gate below.
  //
  // Seeding a symbol's strategy state from the cost-basis ledger + wallet is a
  // DURABLE-DATA concern; being in ProfileManager's in-memory map is a RUNTIME one,
  // and a disabled profile is absent from that map. Gating the reconcile on
  // membership left a profile that had just been handed a position (the natural
  // operator move is to hand it to a fresh, not-yet-started profile) reading FLAT
  // while holding the coins: it would arm no protective stop and fire a fresh entry
  // BUY on top of the position it already owned. Enabling it later does not heal
  // that — `handleSubscribe` does not reconcile — so only a reboot did.
  const symbolRows = await p.profileSymbols.listForProfile();
  const symbols = symbolRows.map((r) => r.symbol);
  const mode: BinanceMode =
    (await repo.accounts.binanceModeById(deps.db, ids.accountId)) === 'live' ? 'live' : 'test';
  await reconcileSymbolsAfterReconfigure(deps, ids, mode, profile.strategyName, symbols);

  const active = deps.profileManager.setTechnicalsIntervals(ids.profileId, intervals);
  if (!active) {
    // Profile is not in ProfileManager (disabled, or this raced an
    // unsubscribe). The next subscribe re-reads symbols + config fresh;
    // no need to retry. `enabled` disambiguates which branch fired. The state is
    // already reconciled above, so the profile is safe to start whenever it is.
    deps.logger.info(
      { ...ids, enabled: profile.enabled },
      'pipeline_reconfigure_skipped_not_active',
    );
    return;
  }
  // Re-resolve the candle interval so a hot interval change applies without a
  // manual stop->start. A running profile should always have its plugin; if it
  // doesn't (config drift), fall back to undefined so setSymbols keeps the
  // current interval and the symbol diff still applies. Do NOT throw: a
  // reconfigure must not crash a live profile.
  const plugin = deps.strategies.get(profile.strategyName);
  let candleInterval: string | undefined;
  if (plugin) {
    candleInterval = resolveCandleInterval(profile.config, plugin, deps.logger, {
      ...ids,
      strategyName: profile.strategyName,
    });
  } else {
    deps.logger.warn(
      { ...ids, strategyName: profile.strategyName },
      'pipeline_reconfigure_unknown_strategy_keeping_interval',
    );
  }
  // The reconcile above ran before this subscribe, so the symbol is not yet tickable
  // when its state is priced: the first tick always reads the reconciled state and
  // there is no tick-vs-reconcile race. That ordering is why a mid-run adopt (a
  // symbol whose coins the wallet already holds, with empty state and no cost basis)
  // cannot be read as flat and answered with an erroneous re-entry BUY.
  await deps.profileManager.setSymbols(ids.profileId, symbols, candleInterval);
  deps.logger.info(
    { ...ids, symbols: symbolRows.length, technicalsIntervals: intervals, candleInterval },
    'pipeline_reconfigured',
  );
};

/**
 * Mid-run per-symbol wallet reconcile for a reconfigured profile. Mirrors the
 * boot orchestrator's inner loop (`ensureCostBasisFromTrades` then
 * `reconcileSymbol`) for each current symbol, run under the tick handler's
 * `${profileId}:${symbol}` chain key so the writes serialise with concurrent
 * ticks and user-stream fills. `chainByKey` is per-key, so nesting this inside
 * the caller's `profileId` lock does not deadlock.
 *
 * Best-effort throughout: skip entirely when no Binance client resolves (a
 * test-mode profile without keys) or `getAccount` throws; a per-symbol failure
 * logs at `warn` and continues so one bad symbol never aborts the reconfigure.
 */
const reconcileSymbolsAfterReconfigure = async (
  deps: PipelineWorkerDeps,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId },
  mode: BinanceMode,
  strategyName: string,
  symbols: readonly string[],
): Promise<void> => {
  if (symbols.length === 0) return;
  const position = deps.strategies.get(strategyName)?.position;
  if (!position) return;

  const client = await deps.resolveBinanceClient(ids.userId, ids.accountId).catch(() => null);
  if (!client) return;

  let account;
  try {
    account = await client.getAccount();
  } catch (err) {
    deps.logger.warn({ ...ids, err }, 'pipeline_reconfigure_reconcile_getaccount_failed');
    return;
  }

  const scope = await profileRepo(deps.db, ids.userId, ids.accountId, ids.profileId);
  for (const symbol of symbols) {
    // Symbol filters differ per Binance mode, so read the keyspace matching this
    // profile's mode — a test-mode profile reconciling against production
    // stepSize records the wrong adopted quantity (#582).
    const infoRaw = await deps.redis.get(buildSymbolInfoKey(symbol, mode));
    if (infoRaw === null) continue;
    let info: { baseAsset: string; filters: { stepSize: string } };
    try {
      info = JSON.parse(infoRaw) as typeof info;
    } catch {
      continue;
    }
    const bal = account.balances.find((b) => b.asset === info.baseAsset);
    const target = {
      userId: ids.userId,
      profileId: ids.profileId,
      symbol,
      baseAsset: info.baseAsset,
      stepSize: info.filters.stepSize,
      walletFree: bal?.free ?? '0',
      walletLocked: bal?.locked ?? '0',
    };
    try {
      await deps.chain.run(`${ids.profileId}:${symbol}`, async () => {
        await ensureCostBasisFromTrades(deps, scope, position, client, target);
        await reconcileSymbol(deps, scope, position, target);
      });
    } catch (err) {
      deps.logger.warn({ ...ids, symbol, err }, 'pipeline_reconfigure_reconcile_symbol_failed');
    }
  }
};

/**
 * Apply an operator's manual average-entry-price write to the running strategy
 * (#496). The api writes the `avg_entry_prices` ledger row (the durable backing
 * boot-revive + the dashboard read from) and enqueues this job; a plain tick
 * never copies the ledger into `state.avgEntryPrice`, and the boot/reconfigure
 * revive deliberately refuses to overwrite a populated state, so neither path
 * makes an operator's "I bought this at X" reach the running strategy. This
 * authoritatively force-sets it.
 *
 * - Ledger present (PUT, or combined add-with-price): force-set the cost basis
 *   via the position capability's `applyFill('buy')` — the same primitive the
 *   fill-adopter and boot cost-basis seeding use, so the body is byte-shape
 *   identical to a real entry (sets avgEntryPrice + heldQuantity, resets the
 *   trailing high-water mark). Held qty is the reserve-adjusted wallet truth
 *   (#498), falling back to the ledger quantity when the wallet can't be read.
 * - Ledger absent (DELETE): clear the position so the strategy stops sizing
 *   sells against a basis the operator removed.
 *
 * The strategy re-evaluates on the next steady-state tick (the symbol is already
 * subscribed and ticking), the same convergence the reconfigure reconcile
 * relies on. Best-effort: a missing profile / strategy / position capability
 * logs at warn and returns; the chain lock serialises the state write with
 * concurrent ticks and user-stream fills.
 */
const handleApplyAvgEntryPrice = async (
  deps: PipelineWorkerDeps,
  ctx: { userId: UserId; accountId: AccountId; profileId: ProfileId; symbol: string },
): Promise<void> => {
  const scope = await profileRepo(deps.db, ctx.userId, ctx.accountId, ctx.profileId);
  const profile = await scope.profile.findById();
  if (!profile) {
    deps.logger.warn(ctx, 'pipeline_apply_avg_entry_price_profile_missing');
    return;
  }
  const position = deps.strategies.get(profile.strategyName)?.position;
  if (!position) {
    deps.logger.warn(
      { ...ctx, strategyName: profile.strategyName },
      'pipeline_apply_avg_entry_price_no_position',
    );
    return;
  }

  const key = `${ctx.profileId}:${ctx.symbol}`;
  const ledger = await scope.avgEntryPrices.findBySymbol(ctx.symbol);
  if (ledger === null) {
    // DELETE convergence: the ledger row is gone, so clear the strategy's cost
    // basis. Held qty is left to the wallet reconciler; the operator asked to
    // forget the basis, not the holding.
    await deps.chain.run(key, () =>
      mutateSymbolState(deps.symbolStateDeps, scope, ctx.symbol, (live) =>
        position.clearPosition(live),
      ),
    );
    deps.logger.info(ctx, 'pipeline_apply_avg_entry_price_cleared');
    return;
  }

  // Size held qty from reserve-adjusted wallet truth (matches boot adoption and
  // per-tick sell-sizing). The ledger quantity (written by the api) is the
  // fallback when the wallet can't be read; the operator's correction is the
  // PRICE, so a slightly stale qty is healed by the next reconcile/tick anyway.
  let heldQuantity = ledger.quantity;
  const client = await deps.resolveBinanceClient(ctx.userId, ctx.accountId).catch(() => null);
  // Mode-scoped, like every other symbol-info read: testnet's filters live in a
  // separate keyspace, so a mode-blind read resolves a test account's baseAsset
  // from production's snapshot.
  const mode =
    (await repo.accounts.binanceModeById(deps.db, ctx.accountId)) === 'live' ? 'live' : 'test';
  const infoRaw = client ? await deps.redis.get(buildSymbolInfoKey(ctx.symbol, mode)) : null;
  if (client && infoRaw !== null) {
    try {
      const info = JSON.parse(infoRaw) as { baseAsset: string };
      const account = await client.getAccount();
      const bal = account.balances.find((b) => b.asset === info.baseAsset);
      const reserve = (await scope.profileSymbols.findForSymbol(ctx.symbol))?.reserveBaseQuantity;
      const adjusted = reserveAdjustedBalance(
        new Decimal(bal?.free ?? '0'),
        new Decimal(bal?.locked ?? '0'),
        reserve ?? null,
      );
      heldQuantity = adjusted.free.plus(adjusted.locked).toFixed();
    } catch (err) {
      deps.logger.warn(
        { ...ctx, err },
        'pipeline_apply_avg_entry_price_wallet_read_failed_using_ledger_qty',
      );
    }
  }

  await deps.chain.run(key, () =>
    mutateSymbolState(deps.symbolStateDeps, scope, ctx.symbol, (live) =>
      position.applyFill(live, {
        kind: 'buy',
        avgEntryPrice: ledger.avgEntryPrice,
        heldQuantity,
      }),
    ),
  );
  deps.logger.info(
    { ...ctx, avgEntryPrice: ledger.avgEntryPrice, heldQuantity },
    'pipeline_apply_avg_entry_price_set',
  );
};

const handleUnsubscribe = async (
  deps: PipelineWorkerDeps,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId },
): Promise<void> => {
  // Re-read DB truth: the operator's last action wins. With pipeline
  // concurrency this unsubscribe can land after a later /start re-enabled the
  // profile. Tearing down then would strand the symbol (DB enabled, streams
  // gone) until restart. Only tear down when the profile is actually meant to
  // be down: missing (deleted -> clean up) or enabled=false.
  //
  // `profileRepo` runs the ownership check and throws `ProfileNotOwnedError`
  // when the profiles row is gone (a deleted profile), so a plain `findById`
  // would never be reached on that path. Map the ownership miss to
  // `profile = null` so a deleted profile falls through to teardown (evicting
  // the in-memory subscription) instead of DLQ-ing and leaking the stream.
  let profile: Awaited<ReturnType<Awaited<ReturnType<typeof profileRepo>>['profile']['findById']>>;
  try {
    const p = await profileRepo(deps.db, ids.userId, ids.accountId, ids.profileId);
    profile = await p.profile.findById();
  } catch (err) {
    if (!(err instanceof ProfileNotOwnedError)) throw err;
    profile = null;
  }
  if (profile && profile.enabled) {
    deps.logger.info(ids, 'pipeline_unsubscribe_skipped_still_enabled');
    return;
  }
  await deps.profileManager.disable(ids.profileId);
  // Retire the profile's own gauge child. prom-client exports a child's last
  // value until it is removed, so a torn-down profile would keep reporting a
  // plausible weight reading and any alert over it could never resolve. Both
  // teardown routes reach this function, so the disposal path is covered by the
  // same line rather than by a second call that could drift from it.
  deps.metrics?.forget('binance_api_weight', { profileId: ids.profileId });
  // Drop the profile's cached tick context on teardown so a stale entry can
  // never outlive an active subscription (symmetric with the subscribe path).
  deps.evictProfileContext?.(ids.profileId);
  // Best-effort kick to close the account's user-data stream promptly: disable
  // dropped membership, so ownership re-elects to close the departed stream
  // (#579). A no-op if an ownership pass is already in-flight; the periodic
  // reconciler closes it within one interval regardless. Best-effort: a kick
  // failure must not DLQ the teardown job.
  await deps.reconcileOwnership?.().catch((err: unknown) => {
    deps.logger.warn({ ...ids, err: err }, 'pipeline_unsubscribe_ownership_kick_failed');
  });
  deps.logger.info(ids, 'pipeline_unsubscribed');
};

// Validate a newly-saved api-key against Binance by asking for the
// account snapshot — the lightest authenticated call. Failure logs at
// error level (caller's audit trail) and is rethrown so BullMQ retries
// + DLQ-routes if Binance is consistently rejecting the key.
const handleVerifyKey = async (
  deps: PipelineWorkerDeps,
  ids: { userId: UserId; accountId: AccountId },
): Promise<void> => {
  // Credentials + environment are per-account now, so verify against the
  // account's key + mode rather than a per-profile key.
  const a = await accountRepo(deps.db, ids.userId, ids.accountId);
  const account = await a.account.get();
  if (!account) {
    deps.logger.warn(ids, 'pipeline_verify_key_account_missing');
    return;
  }
  const key = await a.apiKeys.findForAccount();
  if (!key) {
    deps.logger.warn(ids, 'pipeline_verify_key_no_key');
    return;
  }
  const mode = account.binanceMode === 'live' ? 'live' : 'test';
  const client = buildBinanceClient({ mode, apiKey: key.key, secretKey: key.secret });
  try {
    await client.getAccount();
  } catch (err) {
    // Only a PERMANENT Binance verdict is the verify-key RESULT (bad secret,
    // missing permission, non-allowlisted IP): persist 'failed' so the operator
    // sees why the key does not work instead of it silently looking bound (#366).
    // A transient upstream (5xx/429/-1003/...) or a non-Binance error (network,
    // buildBinanceClient) is NOT a verdict: rethrow so BullMQ retries on its
    // budget instead of recording a false permanent failure that would survive
    // until the next key rotation.
    if (!(err instanceof BinanceApiError) || err.retryable) throw err;
    const message = err.message;
    await a.apiKeys.setVerification({ status: 'failed', error: message });
    deps.logger.warn({ ...ids, mode, err }, 'pipeline_verify_key_failed');
    return;
  }
  await a.apiKeys.setVerification({ status: 'ok', error: null });
  deps.logger.info({ ...ids, mode }, 'pipeline_verify_key_ok');
};

/**
 * Refuse a job whose payload did not parse.
 *
 * Producer/consumer PAYLOAD skew is the same class of defect as job-NAME skew
 * (see the dispatcher's `default` case) and gets the same treatment: throw, so
 * the job fails loudly and the queue-set watcher routes it to the DLQ. Producers
 * that set `attempts` burn those first; a malformed payload is deterministic, so
 * the retries only delay the same DLQ hop. Acking is the worst of both worlds —
 * the operator's request never runs, the job records `completed`, and the only
 * trace is one warn line. A `dispose-profile` that lost its `accountId` that way
 * leaves a profile permanently undeletable after the API already answered 202.
 */
const requirePayload = <T>(parsed: T | null, job: Job): T => {
  if (parsed === null) {
    throw new Error(`pipeline_invalid_payload: ${job.name} (jobId=${job.id ?? 'unknown'})`);
  }
  return parsed;
};

export const registerPipelineWorker = (queueSet: QueueSet, deps: PipelineWorkerDeps): void => {
  queueSet.registerWorker('pipeline', async (job: Job) => {
    switch (job.name) {
      case 'subscribe-profile': {
        const ids = requirePayload(parseProfileJob(job.data), job);
        // Serialize per profile (keyed on profileId, same key as reconfigure
        // and unsubscribe) so an enable's converge cannot race a concurrent
        // disable's teardown mid-operation under pipeline concurrency.
        await deps.chain.run(ids.profileId, () => handleSubscribe(deps, ids));
        return;
      }
      case 'reconfigure-profile': {
        const ids = requirePayload(parseProfileJob(job.data), job);
        // Serialize per profile (keyed on profileId, distinct from the tick's
        // `${profileId}:${symbol}` keys) so the resync's DB-read and apply are
        // atomic. Every symbol mutation enqueues its own resync with a fresh
        // job id (no coalescing); under pipeline concurrency they could
        // otherwise interleave read-then-apply and leave the snapshot holding
        // a stale symbol set. With the chain, whichever job runs last reads the
        // fully-committed DB and applies the truth. Not for state protection —
        // handleReconfigureProfile mutates no per-(profile, symbol) store.
        await deps.chain.run(ids.profileId, () => handleReconfigureProfile(deps, ids));
        return;
      }
      case 'unsubscribe-profile': {
        const ids = requirePayload(parseProfileJob(job.data), job);
        // Same per-profile key as subscribe + reconfigure: a stale unsubscribe
        // serializes behind the live subscribe so it observes the post-/start
        // DB truth and skips teardown.
        await deps.chain.run(ids.profileId, () => handleUnsubscribe(deps, ids));
        return;
      }
      case 'verify-key': {
        const ids = requirePayload(parseAccountJob(job.data), job);
        await handleVerifyKey(deps, ids);
        return;
      }
      case 'dispose-profile': {
        const ctx = requirePayload(parseDisposeProfileJob(job.data), job);
        // Same per-profile key as subscribe/reconfigure/unsubscribe, so a disposal
        // cannot interleave with an enable's converge. It does NOT serialise against
        // the TICK: the tick chains on `${profileId}:${symbol}`, a different key. A
        // tick already queued (or holding a 30s-TTL profile context that
        // `setEnabled(false)` does not evict) can therefore still place an order
        // after the cancels have run. That race is what step 4 exists for: the
        // disposal re-reads DB *and* Binance truth, finds the new order, throws, and
        // the retry cancels it. The delete only ever follows a clean read.
        await deps.chain.run(ctx.profileId, () =>
          handleDisposeProfile(
            {
              db: deps.db,
              redis: deps.redis,
              executor: deps.executor,
              clock: deps.clock,
              logger: deps.logger,
              resolveBinanceClient: deps.resolveBinanceClient,
              notifyRegistry: deps.notifyRegistry,
              ...(deps.liveDemo ? { liveDemo: true } : {}),
              strategies: deps.strategies,
              unsubscribe: (ids) => handleUnsubscribe(deps, ids),
              // The TARGET's reconfigure: re-reads its symbol set into
              // ProfileManager (else the inherited symbol is never ticked) and
              // reconciles its strategy state from the cost-basis ledger + wallet
              // (else it believes it is flat and would re-enter on top of the
              // position it just inherited). Its own chain key — `chainByKey` is
              // per key, so nesting inside the source's does not deadlock.
              reconfigure: (targetIds) =>
                deps.chain.run(targetIds.profileId, () =>
                  handleReconfigureProfile(deps, targetIds),
                ),
            },
            ctx,
          ),
        );
        return;
      }
      case 'cancel-order': {
        const ctx = requirePayload(parseCancelOrderJob(job.data), job);
        await deps.chain.run(`${ctx.profileId}:${ctx.symbol}`, () =>
          handleCancelOrder(
            { db: deps.db, executor: deps.executor, clock: deps.clock, logger: deps.logger },
            ctx,
          ),
        );
        return;
      }
      case 'archive-grid-trade': {
        const ctx = requirePayload(parseProfileSymbolJob(job.data), job);
        await deps.chain.run(`${ctx.profileId}:${ctx.symbol}`, () =>
          handleArchiveGridTrade(
            {
              db: deps.db,
              redis: deps.redis,
              clock: deps.clock,
              logger: deps.logger,
              resolveBinanceClient: deps.resolveBinanceClient,
            },
            ctx,
          ),
        );
        return;
      }
      case 'reconcile-fees': {
        const ids = requirePayload(parseProfileJob(job.data), job);
        await deps.chain.run(ids.profileId, () =>
          handleReconcileFees(
            {
              db: deps.db,
              logger: deps.logger,
              resolveBinanceClient: deps.resolveBinanceClient,
            },
            ids,
          ),
        );
        return;
      }
      case 'backfill-trade-archive': {
        const ctx = requirePayload(parseBackfillJob(job.data), job);
        // Same per-(profile, symbol) chain as the forward archive so a backfill
        // and a concurrent archive of the same symbol serialise on the
        // trade_archive table rather than racing the idempotency read.
        await deps.chain.run(`${ctx.profileId}:${ctx.symbol}`, () =>
          handleBackfillTradeArchive(
            {
              db: deps.db,
              redis: deps.redis,
              logger: deps.logger,
              resolveBinanceClient: deps.resolveBinanceClient,
            },
            ctx,
          ),
        );
        return;
      }
      case 'reset-grid-trade': {
        const ctx = requirePayload(parseProfileSymbolJob(job.data), job);
        await deps.chain.run(`${ctx.profileId}:${ctx.symbol}`, () =>
          handleResetGridTrade(
            {
              db: deps.db,
              redis: deps.redis,
              executor: deps.executor,
              clock: deps.clock,
              logger: deps.logger,
              strategies: deps.strategies,
              statePort: deps.statePort,
            },
            ctx,
          ),
        );
        return;
      }
      case 'apply-avg-entry-price': {
        const ctx = requirePayload(parseProfileSymbolJob(job.data), job);
        // The handler owns the per-(profile, symbol) chain lock around the state
        // write (reads outside it), matching reconcileSymbolsAfterReconfigure.
        await handleApplyAvgEntryPrice(deps, ctx);
        return;
      }
      default:
        // Producer/consumer skew (api enqueued a name this worker
        // doesn't know how to dispatch). Throw so BullMQ retries +
        // DLQ-routes; silent-ack would hide the misconfiguration.
        throw new Error(`pipeline_unknown_job_name: ${job.name} (jobId=${job.id ?? 'unknown'})`);
    }
  });
};
