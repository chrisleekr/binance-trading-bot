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
import { Decimal } from '@app/money';
import type { NotifyProviderRegistry } from '@app/notify';
import { BinanceApiError, type BinanceMode, type BinanceRestClient } from '@app/binance';
import {
  asAccountId,
  asProfileId,
  asUserId,
  ProfileDeleteDisposition,
  unwrapId,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import {
  accountRepo,
  profileRepo,
  ProfileNotOwnedError,
  repo,
  NO_SELLABLE_POSITION,
  POSITION_SEED_REFUSED,
  type Database,
} from '@app/db';
import type { Clock, StrategyRegistry } from '@app/strategy-core';
import type { LiveExecutor } from 'executor/live-executor.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { MetricsSink } from 'metrics/catalog.js';
import type { StatePort } from 'state/state-port.js';
import { mutateSymbolState, type MutateSymbolStateDeps } from 'state/version-aware-mutate.js';
import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import {
  ensureCostBasisFromTrades,
  reconcileHeldQuantity,
  reconcileSymbol,
  resolveSweepPrices,
  resolveWalletFields,
  valueBoundDisarmReason,
  VALUE_BOUND_DISARM_REASONS,
  type ReconcileResult,
  type ValueBoundDisarmReason,
} from 'boot/reconcile-held-quantity.js';
import { isPhantomLedgerRow } from 'boot/revive-avg-entry-price.js';
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
  // this converges it promptly instead of waiting for ownership's own interval.
  // Optional: tests that don't exercise stream ownership omit it.
  readonly reconcileOwnership?: () => Promise<void>;
  // Retires the profile's own metric children on teardown, and carries the reconcile counters for the mid-run reconfigure sweep below. Required, not optional: those counters are the only record that a reconcile deleted a position, and an omittable sink drops them silently.
  readonly metrics: MetricsSink;
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
  // the stream. This is a latency optimisation, not the guarantee — if an
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
  await reconcileSymbolsAfterReconfigure(deps, ids, mode, profile.strategyName, symbolRows);

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
 * Mid-run per-symbol wallet reconcile for a reconfigured profile. Mirrors the boot orchestrator's inner loop (`ensureCostBasisFromTrades` then `reconcileSymbol`) for each current symbol, run under the tick handler's `${profileId}:${symbol}` chain key so the writes serialise with concurrent ticks and user-stream fills. `chainByKey` is per-key, so nesting this inside the caller's `profileId` lock does not deadlock.
 *
 * Best-effort throughout: skip entirely when no Binance client resolves (a test-mode profile without keys) or `getAccount` throws; a per-symbol failure logs at `warn` and continues so one bad symbol never aborts the reconfigure.
 *
 * @param deps - The pipeline worker's dep bag, supplying Redis, the chain, the strategy registry, and the metrics sink the reconcile counters record through.
 * @param ids - The owning operator, account, and profile this reconfigure belongs to.
 * @param mode - The account's Binance environment, selecting which cached exchangeInfo keyspace the symbol filters are read from.
 * @param strategyName - The profile's strategy, resolved to its position adapter; an unknown name skips the whole sweep.
 * @param symbolRows - The profile's current bindings, passed in rather than re-read because the caller has already loaded them in this same job.
 */
const reconcileSymbolsAfterReconfigure = async (
  deps: PipelineWorkerDeps,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId },
  mode: BinanceMode,
  strategyName: string,
  symbolRows: readonly { symbol: string }[],
): Promise<void> => {
  if (symbolRows.length === 0) return;
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
  // The same cache-first-then-REST resolver the boot sweep runs, and NOT optional here. This door reconciles BEFORE `setSymbols`, so a newly added symbol has never had a miniTicker subscription and its `ticker:<SYMBOL>` key is guaranteed absent — not merely cold. Without the batched fallback every value bound would stand down on exactly the pass that re-adopts a symbol, and an operator re-adding one that still carries sub-notional residue would have the seed gate re-create the unsellable strand. One weight-4 call per reconfigure covers the whole set.
  const priceBySymbol = await resolveSweepPrices(
    deps,
    client,
    symbolRows.map((r) => r.symbol),
  );
  for (const row of symbolRows) {
    const symbol = row.symbol;
    // Symbol filters differ per Binance mode, so read the keyspace matching this
    // profile's mode — a test-mode profile reconciling against production
    // stepSize records the wrong adopted quantity.
    const infoRaw = await deps.redis.get(buildSymbolInfoKey(symbol, mode));
    if (infoRaw === null) continue;
    let info: { baseAsset: string; filters: { stepSize: string; minNotional?: string } };
    try {
      info = JSON.parse(infoRaw) as typeof info;
    } catch {
      continue;
    }
    const target = {
      userId: ids.userId,
      profileId: ids.profileId,
      symbol,
      baseAsset: info.baseAsset,
      stepSize: info.filters.stepSize,
      minNotional: info.filters.minNotional ?? null,
      referencePrice: priceBySymbol.get(symbol) ?? null,
      // Through the same helper the boot sweep uses, so the same profile cannot reconcile to two different held quantities depending on which door it came through.
      ...resolveWalletFields(account.balances.find((b) => b.asset === info.baseAsset)),
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
 * Every input whose absence stands the apply-avg-entry-price seed gate down.
 *
 * A tuple rather than a bare union because the counter's children are seeded by iterating it, and the reason type is DERIVED from it below. A reason the gate can return but the loop never iterates would produce a labelled child born at its own first increment, which `increase()` reads as no change — a counter that is present, looks healthy, and can never alert. Deriving the type is what makes that state fail to compile instead.
 */
export const APPLY_SEED_GATE_STAND_DOWN_REASONS = [
  'no-client',
  'no-symbol-info',
  'bad-symbol-info',
  'getaccount-failed',
] as const;

/** The input the seed gate could not resolve, constrained to the reasons the counter actually seeds. */
export type ApplySeedGateStandDownReason = (typeof APPLY_SEED_GATE_STAND_DOWN_REASONS)[number];

/** What the seed rule decided at the apply-avg-entry-price door. `applied` carries the two answers that decide the write — `phantom` is the boot prune's verdict on whether this wallet may back a position at all, and `result` is the reconciler's verdict on how much of it to write — alongside `walletTotal`, the `free + locked` total the prune judged, which is what the caller sizes from when the reconciler names no quantity, and whichever dust value bound could not be evaluated. `stood-down` names the input that never resolved, and carries the cause where there was one, so an expired key, an IP-allowlist rejection and a socket timeout stay distinguishable. */
type ApplySeedGate =
  | {
      readonly kind: 'applied';
      readonly result: ReconcileResult;
      readonly phantom: boolean;
      readonly walletTotal: string | null;
      readonly disarmed: ValueBoundDisarmReason | null;
    }
  | {
      readonly kind: 'stood-down';
      readonly reason: ApplySeedGateStandDownReason;
      readonly err?: unknown;
    };

/**
 * Parse a `LOT_SIZE` increment into a usable bound, or report that it is not one.
 *
 * The increment is the only bound that never disarms, so it is the one input whose absence cannot be allowed to pass silently. A zero, negative, non-finite, or unparseable step makes both the reconciler and the prune return their "nothing to judge" answers, which are indistinguishable from a healthy verdict at the call site.
 *
 * @param raw - The `stepSize` string as it came out of the cached symbol-info blob, untrusted as to format and sign.
 * @returns The step when it is a finite positive number, or null when it cannot bound anything.
 */
const safeStep = (raw: unknown): Decimal | null => {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = new Decimal(raw);
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Total the two wallet legs into the single quantity the phantom bound reads, or report that they cannot be totalled.
 *
 * `resolveWalletFields` deliberately passes an unparseable leg through verbatim so the reconciler's own parse guard can stand the whole symbol down, which means the legs reaching here are not guaranteed to be numbers. Null and zero are opposite answers to `isPhantomLedgerRow` — zero is an empty wallet and arms the prune, null means the question was never answered — so an unparseable leg must not collapse to `'0'`.
 *
 * @param free - The spendable leg as `resolveWalletFields` left it, already normalised when it parsed and verbatim when it did not.
 * @param locked - The leg held against resting orders, on the same terms; it counts toward the position because a resting sell has not left the wallet.
 * @returns The `free + locked` total as a decimal string, or null when either leg is unparseable or the sum is not finite.
 */
const sumWalletLegs = (free: string, locked: string): string | null => {
  try {
    const total = new Decimal(free).plus(locked);
    return total.isFinite() ? total.toFixed() : null;
  } catch {
    return null;
  }
};

/**
 * Read an operator's recorded ledger quantity as the reconciler's CLAIM, or as no claim at all.
 *
 * Only a positive, parseable quantity is a durable statement that a position exists, and that statement is what earns the residue bar. Zero is how the rest of the repo spells "no position" — the flatten arm, the disarm reporter, and the api's own sizing all read it that way — and an unparseable body states no quantity either. Both must fall through to the cold-seed floor rather than present as a claim, because a claim of nothing would otherwise pin the wallet to `adopt-state-smaller` and write that nothing back as the position.
 *
 * @param quantity - The `avg_entry_prices.quantity` string exactly as the api recorded it, untrusted as to sign and format.
 * @returns The same string when it is a finite positive number, or null when it states no position for the rule to size. Only zero and a negative value change the outcome here — a negative claim would otherwise be written back verbatim as the position size. `NaN`, `Infinity` and an unparseable body are rejected to keep the contract honest rather than because this door can tell the difference: the reconciler's own parse rejects each of them downstream and the wallet fallback converges to the same quantity.
 */
const positiveClaim = (quantity: string): string | null => {
  try {
    const parsed = new Decimal(quantity);
    return parsed.isFinite() && parsed.gt(0) ? quantity : null;
  } catch {
    return null;
  }
};

/**
 * Ask the reconciler whether the wallet behind this symbol backs a position worth sizing.
 *
 * The third door onto one decision. Boot adoption and the reconfigure reconcile both refuse a balance under one LOT_SIZE step or worth less than one minimum order, because no sell could ever clear it and a position built on one can only sit on the dashboard forever. This door used to size straight off `free + locked`, so an operator correcting a cost basis rebuilt the exact position the other two had just written off. Calling the same pure function is what makes the three provably one rule rather than three that happen to agree today.
 *
 * Two questions, because sizing a position and deciding one may exist at all are different decisions with different bars, and this door is the only one that has to make both at once.
 *
 * SIZE comes from the reconciler, asked under the operator's recorded quantity as the claim. That quantity is a durable statement that the position exists, and handing it over is what routes a wallet smaller than the record to the rule's own "adopt the smaller" arm instead of letting the flatten arm delete a basis the api accepted seconds ago. A quantity that is absent, zero, or negative states no position, so it is normalised to no claim and the reconciler reads the wallet cold instead. That verdict may still name no quantity, and where the prune keeps the row anyway the wallet total is what gets written.
 *
 * EXISTENCE comes from `isPhantomLedgerRow`, the predicate the boot prune uses to decide whether to DELETE this very row, and asking that one rather than inventing a bar here is what makes the refusal durable. The bar has to match the prune's exactly: refuse anything the prune would keep and the row survives while the write does not, so the next boot revives the cost basis onto a position with no quantity and no pass can heal it; refuse less than the prune and this door writes a position the next boot deletes the basis out from under. The reconciler alone cannot supply this bar — on the ordinary path the api sized the ledger quantity from the same wallet, so claim and wallet agree, `diff.lte(step)` short-circuits, and a holding below one LOT_SIZE step is adopted as a position no sell can ever round up to.
 *
 * Every input is resolved the way the reconfigure door resolves it — the mode-scoped cached symbolInfo blob for the filters, `resolveSweepPrices` for the valuation — so no new dependency is threaded through the worker for this.
 *
 * @param deps - The worker dependency bag, for the Binance client factory, the symbolInfo/ticker cache, and the logger `resolveSweepPrices` reports a failed REST fallback through.
 * @param ctx - The operator, account, profile and symbol this job is applying, which together select both the credentials and the cache keys.
 * @param mode - The account's Binance environment, selecting which cached exchangeInfo keyspace the symbol filters come from; testnet filters live in their own keyspace and a mode-blind read would judge a test account against production increments.
 * @param heldQuantity - The operator's recorded ledger quantity as the rule's CLAIM, already normalised so that a non-positive or unparseable record arrives as null rather than as a claim of nothing. Being non-null is what selects the reconciler's claim branches over its cold-seed floor, so this argument decides how the wallet is SIZED; whether a position may exist at all is settled separately by the prune bound.
 * @param ledgerAvgEntryPrice - The cost basis the operator just recorded, which is what makes the row a claim the prune bound can be asked about at all; the bound answers "no position to prune" for a row that prices nothing.
 * @returns The sizing verdict, whether the row is one the prune would delete, and any disarmed bound, or the name of the input that could not be resolved.
 */
const resolveApplySeedGate = async (
  deps: PipelineWorkerDeps,
  ctx: { userId: UserId; accountId: AccountId; profileId: ProfileId; symbol: string },
  mode: BinanceMode,
  heldQuantity: string | null,
  ledgerAvgEntryPrice: string,
): Promise<ApplySeedGate> => {
  let client: BinanceRestClient | null;
  try {
    client = await deps.resolveBinanceClient(ctx.userId, ctx.accountId);
  } catch (err) {
    return { kind: 'stood-down', reason: 'no-client', err };
  }
  if (!client) return { kind: 'stood-down', reason: 'no-client' };
  let infoRaw: string | null;
  try {
    infoRaw = await deps.redis.get(buildSymbolInfoKey(ctx.symbol, mode));
  } catch (err) {
    // A cache read that throws is the filters being unavailable, which is what `no-symbol-info` already means. Letting it escape would dead-letter the operator's write over an unreachable Redis, and this whole gate exists to degrade instead of reject.
    return { kind: 'stood-down', reason: 'no-symbol-info', err };
  }
  if (infoRaw === null) return { kind: 'stood-down', reason: 'no-symbol-info' };
  // `minNotional` is normalised to null here rather than carried as optional: the reconciler and the disarm reporter both take `string | null`, and an absent floor and an explicit null mean the same thing to them.
  let info: { baseAsset: string; filters: { stepSize: string; minNotional: string | null } };
  try {
    const parsed = JSON.parse(infoRaw) as {
      baseAsset: string;
      filters: { stepSize: string; minNotional?: string };
    };
    // Parsed AND read under one try. `null`, `123` and `{}` are all valid JSON, so a shape-wrong blob parses cleanly and throws on the FIELD read instead — and a field read sitting outside the catch escapes the handler entirely, dead-lettering an operator's write where the whole point of this arm is to degrade to the recorded quantity.
    info = {
      baseAsset: parsed.baseAsset,
      filters: {
        stepSize: parsed.filters.stepSize,
        minNotional: parsed.filters.minNotional ?? null,
      },
    };
  } catch (err) {
    return { kind: 'stood-down', reason: 'bad-symbol-info', err };
  }
  // A cast is not validation. A blob whose fields are merely the wrong TYPE parses and reads without throwing, and an unparseable `stepSize` makes the reconciler return a no-op carrying the claim — the exact silent pass this gate exists to close, arrived at from a different direction.
  // A cast is not validation and neither is a `typeof`: the exchange-info refresh caches a zeroed filter set for an incomplete-filter pair, and a `stepSize` of `'0'` sends BOTH the increment bound and the prune down their own `step.lte(0)` stand-downs with nothing reporting it, so the door writes the recorded quantity as though the rule had judged it. Validate the value.
  const step = safeStep(info.filters.stepSize);
  if (typeof info.baseAsset !== 'string' || step === null) {
    return { kind: 'stood-down', reason: 'bad-symbol-info' };
  }
  let balance: { free: string; locked: string } | undefined;
  try {
    const account = await client.getAccount();
    // Read inside the same try because `getAccount` is an unvalidated cast over the REST payload: a response without `balances` is the call having failed to produce an account, not a separate kind of fault, and it belongs in the same arm.
    balance = account.balances.find((b) => b.asset === info.baseAsset);
  } catch (err) {
    return { kind: 'stood-down', reason: 'getaccount-failed', err };
  }
  let priceBySymbol: ReadonlyMap<string, string>;
  try {
    priceBySymbol = await resolveSweepPrices(deps, client, [ctx.symbol]);
  } catch (err) {
    // Valuation is the one input whose absence the rule already handles: a null `referencePrice` disarms the value bound and reports itself as `no-reference-price`. Degrading to that is strictly better than standing the whole gate down, because the increment bound is unaffected and still binds. The cause is carried because that one reason has two remedies that could not be further apart — a cold ticker cache heals itself on the next tick, an unreachable Redis does not — and the disarm counter alone cannot tell an operator which they are looking at.
    deps.logger.warn({ ...ctx, err }, 'pipeline_apply_avg_entry_price_price_unresolved');
    priceBySymbol = new Map();
  }
  const input = {
    ...resolveWalletFields(balance),
    heldQuantity,
    stepSize: info.filters.stepSize,
    minNotional: info.filters.minNotional,
    referencePrice: priceBySymbol.get(ctx.symbol) ?? null,
  };
  const walletTotal = sumWalletLegs(input.walletFree, input.walletLocked);
  const result = reconcileHeldQuantity(input);
  // The prune has to be asked about the claim the NEXT pass will judge, which is the quantity this door is about to write, NOT the one it read off the ledger. The prune's value arm needs the claim to be valueless too, so asking it under a larger recorded quantity disarms that arm for a wallet the very next reconcile pass flattens — and flatten DELETES the cost-basis row and pages `heldBefore="nonzero"`, both caused by this door's own write. Asking under the written quantity converges the two.
  const nextClaim = result.nextHeldQuantity ?? walletTotal;
  // Every answer comes off the SAME input object. A disarm reported against inputs other than the ones the verdicts were reached on would be worse than no signal at all, since its whole purpose is saying whether those verdicts were actually judged.
  return {
    kind: 'applied',
    result,
    // The bound that decides whether a position may exist at all, asked of the very door that will later re-read this row. A leg that would not parse leaves the wallet total unknown, and this bound stands down rather than reading that as an empty wallet — `isPhantomLedgerRow` treats a null total as "the operator holds none of this coin", which is a definitive answer this input cannot support.
    phantom:
      walletTotal !== null &&
      isPhantomLedgerRow({
        ledgerAvgEntryPrice,
        stateAvgEntryPrice: null,
        walletQuantity: walletTotal,
        stepSize: input.stepSize,
        minNotional: input.minNotional,
        referencePrice: input.referencePrice,
        preReconcileHeldQuantity: nextClaim,
      }),
    walletTotal,
    disarmed: valueBoundDisarmReason(input),
  };
};

/**
 * Open or close the "the cost basis you recorded is not backing a position" condition for one symbol.
 *
 * A refusal that is only logged is invisible to the operator: the api accepted the write, the row is still projected, and nothing on screen distinguishes it from a position the bot actually holds. This is the apply job's only writer for that condition, and every exit of the job that resolved a profile passes through it — the profile-missing return is the one exception, and it is not a strand because a profile that no longer exists takes its condition rows with it. Deleting the cost-basis row closes the refusal a second time, inside the repo, where all six deleters reach it and this job does not run at all. `recordCondition` compares against the stored row before writing, so an exit with nothing open costs one read.
 *
 * @param scope - The profile repo whose condition store owns the row.
 * @param symbol - The coin the refusal is about; conditions are per-symbol, and a profile-level row would name the wrong subject.
 * @param code - The reason the seed was refused, or null to record that it no longer applies.
 * @param now - The instant to stamp, injected from the worker clock so the span's start is not a wall-clock read inside the handler.
 * @param detail - Optional context stored beside the code, shown to whoever reads the condition rather than the worker log.
 * @returns Nothing; the write is fire-and-await, and a failure surfaces as a job error rather than a silent miss.
 */
const recordSeedRefusal = async (
  scope: Awaited<ReturnType<typeof profileRepo>>,
  symbol: string,
  code: string | null,
  now: Date,
  detail?: unknown,
): Promise<void> => {
  await scope.conditionStates.recordCondition({
    condition: POSITION_SEED_REFUSED,
    symbol,
    code,
    now,
    ...(detail === undefined ? {} : { detail }),
    msg:
      code === null
        ? `${symbol}: cost basis applied to the position`
        : `${symbol}: cost basis recorded but no sellable position backs it`,
  });
};

/**
 * Apply an operator's manual average-entry-price write to the running strategy.
 * The api writes the `avg_entry_prices` ledger row (the durable backing
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
 *   trailing high-water mark). Held qty is wallet truth put through the same
 *   seed rule boot adoption and the reconfigure reconcile apply, so a wallet
 *   that backs nothing sellable is refused here too; it falls back to the
 *   ledger quantity when the rule's own inputs can't be resolved.
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
    // A strategy with no position capability cannot be holding one, so an older refusal about this symbol is no longer a statement about anything. Left open it would strand: this job is the only writer, and it now returns here on every future run for the profile.
    await recordSeedRefusal(scope, ctx.symbol, null, new Date(deps.clock.nowMs()));
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
    // Kept even though `avgEntryPrices.remove` clears at every deleter: this branch is reached whenever the row is ABSENT, which is a superset of "this job's own api call deleted it", and it is what makes the claim above — every exit that resolved a profile writes this condition — true rather than nearly true.
    await recordSeedRefusal(scope, ctx.symbol, null, new Date(deps.clock.nowMs()));
    deps.logger.info(ctx, 'pipeline_apply_avg_entry_price_cleared');
    return;
  }

  // Size held qty from wallet truth, but only once the whole seed rule has been applied to it. The operator's correction is the PRICE, so a slightly stale quantity is healed by the next reconcile or tick anyway; a quantity no sell could ever clear is not, and writing one here rebuilt positions the boot and reconfigure doors had already written off.
  const mode =
    (await repo.accounts.binanceModeById(deps.db, ctx.accountId)) === 'live' ? 'live' : 'test';
  const gate = await resolveApplySeedGate(
    deps,
    ctx,
    mode,
    positiveClaim(ledger.quantity),
    ledger.avgEntryPrice,
  );

  let heldQuantity = ledger.quantity;
  let sizedFrom: 'rule' | 'wallet' | 'ledger' = 'ledger';
  const labels = { profileId: unwrapId(ctx.profileId), symbol: ctx.symbol };
  // Seeded on BOTH arms, unlike the value-bound seed below. That one is incremented on the applied arm, so seeding immediately before its own increment suffices. This one is incremented on the OTHER arm, so a profile whose gate always resolves cleanly would never have its children created at all, and every stand-down it ever reaches would be a series born at its own first write.
  //
  // What the hoist buys, precisely: ANY apply job for a `(profileId, symbol)` — clean or not — arms all four children at zero, so once a profile has run one, a later stand-down on those labels is an observable rise. It does not rescue the case where the very first job for those labels is itself the stand-down: the seed and the increment share one synchronous block with no await between them, so no scrape can land in the gap and that series is still born holding 1. A rule over this counter therefore has to subtract its own value at an offset, the way `ReconcileValueBoundDisarmed` does, rather than reach for `increase()`.
  for (const reason of APPLY_SEED_GATE_STAND_DOWN_REASONS) {
    deps.metrics.record('pipeline_apply_seed_gate_stood_down_total', 0, { ...labels, reason });
  }
  if (gate.kind === 'stood-down') {
    deps.metrics.record('pipeline_apply_seed_gate_stood_down_total', 1, {
      ...labels,
      reason: gate.reason,
    });
    // Falling back to the recorded quantity, not refusing. A bound that could not be evaluated must never be the thing that rejects an operator's write: the failure the gate exists to prevent is a position fabricated out of an untradeable balance, and applying what the operator actually recorded fabricates nothing.
    deps.logger.warn(
      { ...ctx, reason: gate.reason, err: gate.err },
      'pipeline_apply_avg_entry_price_gate_unavailable',
    );
  } else {
    // Zero-seed BEFORE any increment, and unconditionally. A prom-client child does not exist until its first write and is born holding that write's value, so an unseeded labelled counter's first incident appears as a series that has always read 1 — which `increase()` reads as no change, leaving every rule over it silent forever. Seeding in the same pass is enough, because the child only has to exist at 0 immediately before the increment lands on it.
    for (const reason of VALUE_BOUND_DISARM_REASONS) {
      deps.metrics.record('reconcile_value_bound_disarmed_total', 0, { ...labels, reason });
    }
    if (gate.disarmed !== null) {
      deps.metrics.record('reconcile_value_bound_disarmed_total', 1, {
        ...labels,
        reason: gate.disarmed,
      });
      deps.logger.warn(
        { ...labels, reason: gate.disarmed, action: gate.result.action },
        'pipeline_apply_avg_entry_price_value_bound_disarmed',
      );
    }
    // EXISTENCE is the prune's question alone. The reconciler's own null verdicts do not all agree with it: `adopt-wallet-smaller`'s null arm refuses through `isUnsellableDust`, which measures the wallet as a SHARE of the claim and then against the FULL minimum order, so a real holding worth half an order under a stale hundred-fold claim reads as a crumb there while the prune — which judges the wallet absolutely — keeps it. Refusing on that arm left the row alive with nothing written, which is the exact strand this gate exists to prevent, so only `phantom` may refuse.
    if (gate.phantom) {
      // Nothing sellable backs this symbol, so there is no position to hand the strategy — and nothing is written, not even a cleared body. The `avg_entry_prices` row stays exactly as the operator submitted it: deleting a record the api accepted seconds ago would leave the two surfaces contradicting each other. Leaving it is safe only because the refusal is at the residue bar, which is the same bar the phantom prune deletes at, so the row this door declines is the row that pass removes — refusing higher up would strand a priced row no pass can reach.
      deps.logger.warn(
        {
          ...ctx,
          action: gate.result.action,
          phantom: gate.phantom,
          ledgerQuantity: ledger.quantity,
        },
        'pipeline_apply_avg_entry_price_no_sellable_position',
      );
      // Durable, because the log line is not a surface the operator has any reason to be reading, and this refusal is the only thing that distinguishes the projected ledger row from a position the bot actually holds.
      await recordSeedRefusal(
        scope,
        ctx.symbol,
        NO_SELLABLE_POSITION,
        new Date(deps.clock.nowMs()),
        {
          ledgerQuantity: ledger.quantity,
          avgEntryPrice: ledger.avgEntryPrice,
        },
      );
      return;
    }
    // The reconciler now only SIZES. Where it declines to name a quantity but the prune keeps the row, the wallet is the size the prune just vouched for; where the wallet itself could not be totalled, nothing was judged at all and the operator's recorded quantity stands, which is the same stand-down the unresolvable-input arms take.
    heldQuantity = gate.result.nextHeldQuantity ?? gate.walletTotal ?? ledger.quantity;
    // Derived at the same expression that picks the quantity, because `action` alone is misleading once the ladder falls through: a reader seeing `adopt-wallet-smaller` beside a quantity would conclude the rule sized it, when that verdict is precisely the one that declined to name a number.
    sizedFrom =
      gate.result.nextHeldQuantity !== null
        ? 'rule'
        : gate.walletTotal !== null
          ? 'wallet'
          : 'ledger';
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
  await recordSeedRefusal(scope, ctx.symbol, null, new Date(deps.clock.nowMs()));
  deps.logger.info(
    {
      ...ctx,
      avgEntryPrice: ledger.avgEntryPrice,
      heldQuantity,
      // Null when the gate stood down, which is the difference between "the rule judged this quantity" and "the rule never ran", and the only place that distinction survives into the log.
      action: gate.kind === 'applied' ? gate.result.action : null,
      // Which of the three sources actually produced the number beside it. `action` cannot carry this: the verdict that declines to name a quantity is still an action, so it reads identically whether the rule sized the position or the ladder fell past it.
      sizedFrom,
    },
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
  deps.metrics.forget('binance_api_weight', { profileId: ids.profileId });
  // Drop the profile's cached tick context on teardown so a stale entry can
  // never outlive an active subscription (symmetric with the subscribe path).
  deps.evictProfileContext?.(ids.profileId);
  // Best-effort kick to close the account's user-data stream promptly: disable
  // dropped membership, so ownership re-elects to close the departed stream.
  // A no-op if an ownership pass is already in-flight; the periodic
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
    // sees why the key does not work instead of it silently looking bound.
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
