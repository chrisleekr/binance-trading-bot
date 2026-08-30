// Pipeline `dispose-profile` handler: delete a profile WITHOUT abandoning its
// exposure.
//
// WHY this is a worker job at all: the api has no Binance client, and a profile
// with resting orders cannot be deleted by a DB cascade — the orders survive on
// the exchange, holding the operator's coins, with nothing left in the system
// pointing at them. That is how a deleted profile's stop ended up locking a whole
// ENA position for days.
//
// Crash-only: every step is re-derivable from DB truth, so a kill mid-teardown
// resumes on the retry rather than leaving a half-deleted profile. The order is
// load-bearing:
//
//   1. disable + unsubscribe FIRST — a live tick would re-place what we cancel.
//   2. cancel every live order on Binance (there is no cancel-all endpoint).
//   3. handoff (optional): re-point the POSITION to the target profile. Not the
//      orders: a clientOrderId encodes the SOURCE profileId, so the target's
//      strategy could never recognise them — it would see a foreign resting SELL
//      and refuse to arm its own stop, which is the very bug being fixed.
//   4. re-read DB *and* the account's WHOLE open-order book: a cancel of ours still
//      resting means the cancel never landed (throw, retry); an untracked order the
//      strategy PROVES this profile emitted is cancelled here (a DB row is not what
//      makes an order ours); anything unattributable is announced, never cancelled.
//   5. only then wipe Redis and delete the row. (Wiping before the delete leaves a
//      live profile with no cached state if the process dies between them.)

import type { Logger } from 'pino';
import type {
  AccountId,
  ProfileDeleteDisposition,
  ProfileId,
  SymbolSource,
  UserId,
} from '@app/contracts';
import { asProfileId, isRestingStatus, unwrapId } from '@app/contracts';
import type { NotifyProviderRegistry } from '@app/notify';
import {
  profileRepo,
  profileRepoFromScope,
  profilePrefix,
  withTx,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
  type Database,
  type ProfileRepo,
} from '@app/db';
import { Decimal } from '@app/money';
import type { Redis } from 'ioredis';
import type { BinanceRestClient } from '@app/binance';
import { mergeConfig, type Clock, type StrategyRegistry } from '@app/strategy-core';
import { baseAssetOf } from 'executor/fundable.js';
import type { LiveExecutor } from 'executor/live-executor.js';
import { dispatchNotify } from 'notifiers/dispatch.js';
import { resolveNotifiersFromRows } from 'notifiers/lookup.js';

export interface DisposeProfileJobPayload {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly disposition: ProfileDeleteDisposition;
  /** Required for `handoff`: the profile that inherits the position. */
  readonly toProfileId?: ProfileId;
}

export interface DisposeProfileHandlerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly executor: LiveExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly resolveBinanceClient: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
  /** Stop the worker streaming for this profile. The pipeline worker's own unsubscribe. */
  readonly unsubscribe: (ids: ProfileIds) => Promise<void>;
  /**
   * The pipeline worker's own `reconfigure-profile`. Run against the HANDOFF TARGET
   * once the position is re-pointed: it re-reads the target's symbol set into
   * ProfileManager (without it the target never ticks the inherited symbol AT ALL)
   * and reconciles each symbol's strategy state from the cost-basis ledger + wallet
   * (without it the target believes it is FLAT while holding the coins — it would
   * arm no stop and open a SECOND position on the next entry signal).
   */
  readonly reconfigure: (ids: ProfileIds) => Promise<void>;
  /**
   * Strategy registry. The disposal reads the TARGET strategy's position adapter to
   * VERIFY the seeding actually landed — `reconfigure`'s reconcile is fail-soft by
   * design (other callers need that), so its success says nothing.
   */
  readonly strategies: StrategyRegistry;
  /** Notifier registry for the residual-orders alert. */
  readonly notifyRegistry: NotifyProviderRegistry;
  /** Public "Live demo" mode: suppresses the residual-orders alert dispatch. */
  readonly liveDemo?: boolean;
}

export interface ProfileIds {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
}

/** One live order the disposal must clear from the exchange. */
export interface DisposalOrder {
  readonly id: string;
  readonly symbol: string;
  readonly binanceOrderId: bigint;
}

/**
 * One symbol the disposal must move (handoff) or simply drop. Derived from the UNION
 * of the profile's symbol bindings and its cost-basis ledger, because either half can
 * exist without the other and BOTH mean "these coins belong to this profile":
 *
 *   - ledger row, no binding — a symbol un-bound while a position was open.
 *   - binding, no ledger row — a HELD BUT UNPRICED position: cost-basis reconstruction
 *     never succeeded (a failing `getMyTrades` is the plausible path).
 *
 * Dropping either from the plan hands those coins to nobody, and the delete then
 * cascades the last row pointing at them away — the original incident.
 * `avgEntryPrice`/`quantity` are null for the unpriced case; the target's own
 * reconcile prices it from trade history.
 */
export interface DisposalPosition {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly avgEntryPrice: string | null;
  readonly quantity: string | null;
  readonly overrideConfig: unknown;
  /** Provenance of the source binding, carried verbatim. A handoff moves a position between profiles; it does not re-author the binding, so re-stamping it `manual` would credit the operator with a coin discovery chose. */
  readonly source: SymbolSource;
  /** Whether the source binding was protected from discovery rotation, and when that was chosen. Both travel together: dropping the pin would let discovery reap a coin the operator ringfenced the moment it lands on the target, and dropping only the stamp would make a deliberate pin read as a backfilled one. */
  readonly pinned: boolean;
  readonly pinnedAt: Date | null;
}

export interface DisposalTargets {
  /** Every resting order, in cancel order. */
  readonly cancels: readonly DisposalOrder[];
  /**
   * Every symbol this profile touched. Scopes the residual announcement: the confirm
   * reads the account's whole book, so without it a sibling profile's resting order
   * would be reported to the operator as this profile's leftover.
   */
  readonly symbols: readonly string[];
  /** Positions to re-point; empty unless the disposition is `handoff`. */
  readonly handoffs: readonly DisposalPosition[];
}

/**
 * The whole disposal plan, derived from DB truth alone. Pure so the ordering and
 * the handoff rule can be tested with no database and no exchange.
 *
 * A handoff moves only a position with a real quantity; a flat binding is not
 * worth re-pointing (and a zero-quantity row would hand the target a phantom
 * position it would immediately try to protect).
 */
export const selectDisposalTargets = (
  liveOrders: readonly DisposalOrder[],
  positions: readonly DisposalPosition[],
  disposition: ProfileDeleteDisposition,
): DisposalTargets => {
  const symbols = [
    ...new Set([...liveOrders.map((o) => o.symbol), ...positions.map((p) => p.symbol)]),
  ].sort();
  // A null quantity is an UNPRICED position, not an empty one — its binding is the only
  // thing owning those coins, so it must move. A ledger row that reads zero IS flat and
  // is not worth re-pointing (handing the target a phantom position would have it try to
  // protect something it does not hold). `.gt(0)`, not `.isPositive()`:
  // Decimal.isPositive(0) is true.
  const handoffs =
    disposition === 'handoff'
      ? positions.filter((p) => p.quantity === null || new Decimal(p.quantity).gt(0))
      : [];
  return { cancels: liveOrders, symbols, handoffs };
};

/** One open order on the exchange, narrowed to what the confirm reads. */
export interface ConfirmOrder {
  readonly orderId: number;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: string;
  readonly status: string;
}

/**
 * Binance's own uniqueness unit for `orderId`: the SYMBOL, not the account ("uniquely
 * identifies the order on a symbol"). The old confirm asked per symbol, so a bare id
 * was safe; an account-wide book contains two different orders sharing one numeric id
 * on two symbols, and matching on the bare id would call a stranger's order "our
 * cancel that never landed" — throwing until the job DLQs, with the profile never
 * deleted and the ghost it was here to cancel still resting.
 */
const orderKey = (symbol: string, orderId: number | bigint): string => `${symbol}:${orderId}`;

/** What the exchange-side confirm found, split by what may be done about it. */
export interface ConfirmActions {
  /** Orders we cancelled that Binance still shows on the book: the cancel never landed. */
  readonly stillResting: readonly ConfirmOrder[];
  /** Untracked orders the strategy PROVES this profile emitted. Ours to cancel. */
  readonly cancels: readonly ConfirmOrder[];
  /** Unattributable resting orders on symbols this profile keeps, grouped by symbol. */
  readonly residualBySymbol: ReadonlyMap<string, readonly ConfirmOrder[]>;
}

/**
 * Decide what the account-wide open-order list means for a disposal. Pure, so the
 * three-way split can be tested without an exchange.
 *
 * `isOurs` is the strategy's own id scheme (see `buildAttributor`) — the only
 * fingerprint that can claim an order the DB never recorded. Everything it cannot
 * claim is left alone: an operator's hand-placed order and a sibling profile's
 * resting stop are not this delete's to cancel.
 *
 * A resting BUY counts as a residual exactly as a resting SELL does: it locks the
 * operator's cash instead of their coins, and abandoning it silently is the same
 * fault. (Some ids are unclaimable by design — momentum folds a candle close time
 * into its hash — so an unattributable order of ours is a real case, not a
 * theoretical one.)
 *
 * `residualSymbols`, not "every symbol on the book": account-wide enumeration also
 * returns siblings' orders, and it must EXCLUDE the symbols a handoff just gave away
 * — the target's freshly armed stop is an order the bot placed seconds ago, so
 * announcing "the bot has no record of placing them" would be a lie.
 */
export const selectConfirmActions = (
  open: readonly ConfirmOrder[],
  cancelledKeys: ReadonlySet<string>,
  residualSymbols: ReadonlySet<string>,
  isOurs: (order: ConfirmOrder) => boolean,
): ConfirmActions => {
  const stillResting: ConfirmOrder[] = [];
  const cancels: ConfirmOrder[] = [];
  const residualBySymbol = new Map<string, ConfirmOrder[]>();
  for (const order of open) {
    if (cancelledKeys.has(orderKey(order.symbol, order.orderId))) {
      stillResting.push(order);
    } else if (isOurs(order)) {
      cancels.push(order);
    } else if (isRestingStatus(order.status) && residualSymbols.has(order.symbol)) {
      const group = residualBySymbol.get(order.symbol) ?? [];
      group.push(order);
      residualBySymbol.set(order.symbol, group);
    }
  }
  return { stillResting, cancels, residualBySymbol };
};

/**
 * "Did THIS profile emit this clientOrderId?" — asked of the strategy through the
 * registry, because the id scheme belongs to the plugin and the worker never imports
 * a strategy package.
 *
 * Attribution runs against the MERGED config, per symbol, because that is what the
 * order was MINTED from: a per-symbol override can widen the id space the strategy
 * enumerates (more grid levels, more pyramid adds), so asking with the bare profile
 * config would fail to claim precisely the orders the override created — and an
 * unclaimed order of ours is abandoned, which is the whole bug.
 *
 * Fails CLOSED: a strategy with no `attributeOrder`, or a config that no longer
 * parses, proves nothing — and an unproven order is never cancelled, so
 * under-claiming costs an announcement while over-claiming would cancel someone
 * else's order.
 */
const buildAttributor = (
  deps: DisposeProfileHandlerDeps,
  profileId: ProfileId,
  strategyName: string,
  config: unknown,
  overrideBySymbol: ReadonlyMap<string, unknown>,
): ((order: ConfirmOrder) => boolean) => {
  const strategy = deps.strategies.get(strategyName);
  if (!strategy?.attributeOrder) return () => false;
  // An unbound symbol (the ghost this job exists for) has no override row, so the
  // base config is exactly right for it.
  const parseFor = (symbol: string) => {
    const parsed = strategy.configSchema.safeParse(
      mergeConfig(config, overrideBySymbol.get(symbol) ?? null),
    );
    if (!parsed.success) {
      deps.logger.warn(
        { profileId, strategyName, symbol },
        'dispose_profile_config_unparseable_no_attribution',
      );
      return null;
    }
    return parsed.data;
  };
  // One parse per symbol, not per order.
  const cache = new Map<string, ReturnType<typeof parseFor>>();
  return (order) => {
    if (!cache.has(order.symbol)) cache.set(order.symbol, parseFor(order.symbol));
    const parsed = cache.get(order.symbol) ?? null;
    if (parsed === null) return false;
    return (
      strategy.attributeOrder?.({
        clientOrderId: order.clientOrderId,
        profileId: unwrapId(profileId),
        symbol: order.symbol,
        config: parsed,
      }) != null
    );
  };
};

/** Cancel one resting order through the executor, tolerating an order already gone. */
const cancelOne = async (
  deps: DisposeProfileHandlerDeps,
  payload: DisposeProfileJobPayload,
  order: DisposalOrder,
): Promise<void> => {
  const numericOrderId = Number(order.binanceOrderId);
  if (!Number.isSafeInteger(numericOrderId) || numericOrderId < 0) {
    throw new Error(
      `dispose_profile: binance_order_id ${order.binanceOrderId} exceeds safe integer range`,
    );
  }
  const result = await deps.executor.apply(
    { userId: payload.userId, profileId: payload.profileId, clock: deps.clock },
    payload.accountId,
    {
      type: 'cancel-order',
      orderId: numericOrderId,
      reason: 'profile-disposal',
      symbol: order.symbol,
    },
  );
  if (result.ok === false) {
    // Retryable ⇒ throw: BullMQ retries and DLQs, and the profile survives until
    // the exchange is provably clear. Non-retryable ⇒ the executor's verdict is
    // that re-sending re-fails (the order is already gone from the book); the
    // Binance re-read below is the backstop that decides whether we may delete.
    if (result.retryable) {
      throw new Error(`dispose_profile: retryable cancel failure: ${result.reason}`);
    }
    deps.logger.warn(
      { profileId: payload.profileId, orderId: order.id, reason: result.reason },
      'dispose_profile_cancel_non_retryable',
    );
  }
};

/**
 * Move every position to the target profile — the cost-basis row AND the symbol
 * binding — in ONE transaction.
 *
 * The unbind must come before the bind (`profileSymbols.upsert` enforces base-asset
 * exclusivity per account, so the source is otherwise the conflicting owner), and
 * that ordering is precisely why this cannot be a sequence of independent writes: a
 * crash after the source is unbound destroys the very row the retry rebuilds its
 * plan from, so the retry would see NO position to hand off, confirm the exchange
 * clear, and delete the profile — cascading the cost basis away and leaving the
 * coins in the wallet owned by nobody. That is the original incident, re-created by
 * the feature meant to prevent it.
 *
 * Atomicity is the fix: the crash either rolls back to a fully intact source (the
 * retry re-derives the plan cleanly) or commits a fully seeded target. `withTx`
 * re-brands each already-proven scope onto the transaction handle, so both repos
 * ride the same transaction with their ownership proof intact.
 *
 * The unbind also tears the source's per-symbol state down, cost basis included,
 * so nothing here deletes it a second time. Safe because the values were read
 * into `positions` before this ran, and the target is seeded from that copy
 * inside the same transaction: the row is re-pointed, never lost.
 */
const handoffPositions = async (
  db: Database,
  source: ProfileRepo,
  target: ProfileRepo,
  positions: readonly DisposalPosition[],
): Promise<void> => {
  if (positions.length === 0) return;
  await db.transaction(async (tx) => {
    const src = profileRepoFromScope(withTx(source.scope, tx));
    const tgt = profileRepoFromScope(withTx(target.scope, tx));
    for (const position of positions) {
      await src.profileSymbols.remove(position.symbol);
      await tgt.profileSymbols.upsert(position.symbol, position.baseAsset, {
        source: position.source,
        pinned: position.pinned,
        pinnedAt: position.pinnedAt,
        ...(position.overrideConfig != null
          ? { overrideConfig: position.overrideConfig as Record<string, unknown> }
          : {}),
      });
      // A held-but-unpriced position has no ledger row to move; the target's reconcile
      // reconstructs the cost basis from trade history.
      if (position.avgEntryPrice !== null && position.quantity !== null) {
        await tgt.avgEntryPrices.upsert(position.symbol, {
          avgEntryPrice: position.avgEntryPrice,
          quantity: position.quantity,
        });
      }
    }
  });
};

/**
 * Tell the operator about resting orders on a symbol of the profile we are about to
 * delete that we did NOT cancel — orders Binance holds, our books never recorded, and
 * no strategy can prove are ours. They survive the delete still holding funds, so they
 * must leave a trace louder than a log line: the last incident WAS this, discovered
 * weeks later via a position that would not sell.
 *
 * A SELL locks coins and a BUY locks cash, so the copy names which — telling the
 * operator "they are holding those coins" about a resting BUY would send them looking
 * for the wrong thing.
 *
 * Best-effort: a notifier failure must never abort a disposal that has already
 * cancelled orders on the exchange.
 */
const announceResidual = async (
  deps: DisposeProfileHandlerDeps,
  p: ProfileRepo,
  profileId: ProfileId,
  symbol: string,
  orders: readonly ConfirmOrder[],
): Promise<void> => {
  const sells = orders.filter((o) => o.side.toUpperCase() === 'SELL').length;
  const buys = orders.length - sells;
  deps.logger.warn(
    { profileId, symbol, sells, buys },
    'dispose_profile_residual_resting_order_on_binance',
  );
  const held = [
    ...(sells > 0 ? [`${sells} sell order(s), which are holding your ${symbol} coins`] : []),
    ...(buys > 0 ? [`${buys} buy order(s), which are holding your cash`] : []),
  ].join(' and ');
  try {
    const rows = (await p.profileNotifiers.listForProfile()).filter((n) => n.enabled);
    await dispatchNotify(
      {
        registry: deps.notifyRegistry,
        logger: deps.logger,
        ...(deps.liveDemo ? { liveDemo: true } : {}),
      },
      resolveNotifiersFromRows(rows),
      {
        severity: 'warn',
        topic: 'profile-disposal-residual',
        title: 'An order was left on Binance',
        symbol,
        body:
          `The profile was deleted, but ${held} on ${symbol} are still resting on Binance. The ` +
          'bot has no record of placing them, so it did not cancel them. Cancel them on Binance ' +
          'if you want those funds back.',
      },
    );
  } catch (err: unknown) {
    deps.logger.warn({ profileId, symbol, err: err }, 'dispose_profile_residual_notify_failed');
  }
};

/**
 * Tell the operator a handoff was refused because the destination profile already draws
 * on the base asset's wallet line — either trading it directly
 * ({@link SymbolOwnershipConflictError}) or settling its buys in it
 * ({@link SiblingQuoteConflictError}). Base-asset exclusivity is per account, so two
 * profiles cannot share one wallet line and stay safe.
 *
 * Both are TERMINAL: no retry clears a shared-wallet collision, so rethrowing would
 * dead-letter the job and retry forever while the source can never be deleted. The
 * source is NOT deleted instead (the handoff tx rolled back, so it keeps its position
 * and its row) — but the disposal already disabled it and cancelled its resting orders,
 * so its position is now unprotected. The message says so plainly, names the profile
 * that actually owns the asset, and tells the operator how to restore protection or
 * pick another target.
 *
 * Same best-effort dispatch seam as `announceResidual`: a notifier outage must not turn
 * a clean block into a dead-lettered job.
 */
const announceHandoffBlocked = async (
  deps: DisposeProfileHandlerDeps,
  p: ProfileRepo,
  profileId: ProfileId,
  targetName: string,
  err: SymbolOwnershipConflictError | SiblingQuoteConflictError,
): Promise<void> => {
  const baseAsset = err.symbol;
  // The conflict is raised by the TARGET's own upsert, and the finders exclude the
  // target — so the profile that actually owns/settles-in the base asset is a THIRD
  // sibling, carried on the error. Name that owner, not the handoff target.
  const ownerName = err.conflictProfileName;
  const clash =
    err instanceof SiblingQuoteConflictError
      ? `funds its trades with ${baseAsset}`
      : `trades ${baseAsset}`;
  try {
    const rows = (await p.profileNotifiers.listForProfile()).filter((n) => n.enabled);
    await dispatchNotify(
      {
        registry: deps.notifyRegistry,
        logger: deps.logger,
        ...(deps.liveDemo ? { liveDemo: true } : {}),
      },
      resolveNotifiersFromRows(rows),
      {
        severity: 'warn',
        topic: 'profile-disposal-handoff-blocked',
        title: 'The profile could not be deleted',
        body:
          `This profile could not be handed off to "${targetName}" for deletion: another ` +
          `profile, "${ownerName}", already ${clash}, and one wallet line can be traded by ` +
          `only one profile per account. This profile was NOT deleted and still holds its ` +
          `${baseAsset} position — but it has been stopped and its resting orders on Binance ` +
          `were cancelled, so that position is currently unprotected. Re-start this profile to ` +
          `restore its protection, then either hand it to a different profile or free ` +
          `${baseAsset} on "${ownerName}" and delete it again.`,
      },
    );
  } catch (notifyErr: unknown) {
    deps.logger.warn(
      {
        profileId,
        targetName,
        baseAsset,
        err: notifyErr,
      },
      'dispose_profile_handoff_blocked_notify_failed',
    );
  }
};

/**
 * Every symbol the target now owns must carry a PRICED strategy-state body before the
 * source may be deleted. Read through the strategy's own position adapter — the state
 * body is opaque to everything outside the plugin, and `avgEntryPrice != null` is what
 * "the strategy knows it holds this" means (it is exactly what the entry gate reads to
 * decide the symbol is not flat).
 *
 * A strategy with no position adapter cannot hold a position at all, so there is
 * nothing to verify and nothing to lose.
 */
const assertTargetSeeded = async (
  deps: DisposeProfileHandlerDeps,
  target: ProfileRepo,
  targetStrategyName: string,
): Promise<void> => {
  // The TARGET's adapter, not the source's: the two profiles can run different
  // strategies, and it is the target that has to recognise the position.
  const position = deps.strategies.get(targetStrategyName)?.position;
  if (!position) return;
  // Driven by the TARGET's cost-basis ledger, never by this run's plan: on a RETRY the
  // source is already stripped and the plan is empty, so a plan-driven check would
  // pass vacuously and delete the source with the target still unseeded — the exact
  // hole this exists to close. A ledger row is the durable statement "this profile
  // holds this position", so every one of them must be reflected in a priced state
  // body. A symbol with no ledger row is either held-but-unpriced (the target's own
  // reconcile prices it from trade history) or a phantom the reconcile pruned;
  // neither may block a delete, and the binding has moved either way, so the coins
  // are owned.
  for (const ledger of await target.avgEntryPrices.listForProfile()) {
    const row = await target.symbolStates.findBySymbol(ledger.symbol);
    const priced =
      row?.state == null ? null : (position.readPosition(row.state)?.avgEntryPrice ?? null);
    if (priced == null) {
      throw new Error(
        `dispose_profile: the handoff target has no priced position for ${ledger.symbol}; refusing to delete the source while the target would read FLAT while holding the coins`,
      );
    }
  }
};

/** Delete every Redis key under the profile's prefix. */
const wipeProfileRedis = async (
  redis: Redis,
  accountId: AccountId,
  profileId: ProfileId,
): Promise<void> => {
  const prefix = profilePrefix({ accountId, profileId });
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
};

export const handleDisposeProfile = async (
  deps: DisposeProfileHandlerDeps,
  payload: DisposeProfileJobPayload,
): Promise<void> => {
  const { userId, accountId, profileId, disposition } = payload;
  const p = await profileRepo(deps.db, userId, accountId, profileId);
  const profile = await p.profile.findById();
  if (!profile) {
    // Already disposed (a retry of a job whose delete landed). Idempotent ack.
    deps.logger.info({ profileId }, 'dispose_profile_already_gone');
    return;
  }

  // 1. Stop the strategy BEFORE anything is cancelled. Pipeline concurrency is 4
  //    and a tick in flight would re-place the very stop we are about to cancel.
  await p.profile.setEnabled(false);
  await deps.unsubscribe({ userId, accountId, profileId });

  const [liveOrders, bindings, positions] = await Promise.all([
    p.orders.listLiveForProfile(),
    p.profileSymbols.listForProfile(),
    p.avgEntryPrices.listForProfile(),
  ]);
  // The UNION of both halves. A binding with no ledger row is a held-but-unpriced
  // position, and a ledger row with no binding is a position whose symbol was
  // un-bound while open; each is owned by this profile and each would otherwise be
  // dropped from the plan and cascaded away by the delete.
  const bindingBySymbol = new Map(bindings.map((b) => [b.symbol, b]));
  const ledgerBySymbol = new Map(positions.map((pos) => [pos.symbol, pos]));
  const ownedSymbols = [...new Set([...bindingBySymbol.keys(), ...ledgerBySymbol.keys()])].sort();

  const plan = selectDisposalTargets(
    liveOrders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      binanceOrderId: o.binanceOrderId,
    })),
    ownedSymbols.map((symbol) => {
      const binding = bindingBySymbol.get(symbol);
      const ledger = ledgerBySymbol.get(symbol);
      // The base asset is only needed to BIND the symbol to the target, so an
      // undecomposable symbol is fatal to a handoff and irrelevant to a
      // `cancel-orders` disposal — where abandoning the position to the wallet is
      // precisely what the operator asked for. Refusing there would permanently DLQ
      // a delete they explicitly chose, and protect nothing.
      const baseAsset = binding?.baseAsset ?? baseAssetOf(symbol, profile.quoteAsset);
      if (baseAsset === null && disposition === 'handoff') {
        throw new Error(
          `dispose_profile: cannot resolve the base asset of ${symbol}; refusing to hand off a position that would be left unowned`,
        );
      }
      return {
        symbol,
        baseAsset: baseAsset ?? '',
        avgEntryPrice: ledger?.avgEntryPrice ?? null,
        quantity: ledger?.quantity ?? null,
        overrideConfig: binding?.overrideConfig ?? null,
        // A position whose binding is already gone has no provenance left to read. `unknown` is the honest answer, and unpinned is the safe one: the target rotates it like any other coin rather than inheriting a protection nobody granted.
        source: binding?.source ?? 'unknown',
        pinned: binding?.pinned ?? false,
        pinnedAt: binding?.pinnedAt ?? null,
      };
    }),
    disposition,
  );

  // 2. Cancel each resting order. Binance has no cancel-all, so this is a loop.
  for (const order of plan.cancels) await cancelOne(deps, payload, order);

  // 3. Handoff: the POSITION moves, the orders never do.
  if (disposition === 'handoff') {
    if (payload.toProfileId === undefined) {
      // Non-retryable: no retry can invent a target. Refuse loudly and leave the
      // profile in place (disabled) rather than deleting exposure into the void.
      throw new Error('dispose_profile: handoff requires toProfileId');
    }
    // `profileRepo` proves the target belongs to the SAME operator and the SAME
    // account — and an account pins one Binance key pair and one environment, so
    // same-account IS same-mode. A foreign target throws ProfileNotOwnedError.
    const target = await profileRepo(deps.db, userId, accountId, asProfileId(payload.toProfileId));
    const targetRow = await target.profile.findById();
    if (!targetRow) {
      throw new Error('dispose_profile: handoff target no longer exists');
    }
    try {
      await handoffPositions(deps.db, p, target, plan.handoffs);
    } catch (err: unknown) {
      // A shared-wallet collision is TERMINAL: the base asset this position would bind to
      // is already owned by another sibling (traded, or spent as its quote), and no retry
      // clears that. The handoff tx rolled back, so the source keeps every position and
      // its row — but it was already disabled and its orders cancelled above, so the
      // operator notice below says so and ACKs the job (return). Rethrowing would
      // dead-letter and retry forever while the profile could never be deleted. Every
      // OTHER failure still propagates: it is transient or unknown, so BullMQ must retry.
      if (err instanceof SymbolOwnershipConflictError || err instanceof SiblingQuoteConflictError) {
        deps.logger.warn(
          {
            profileId,
            targetProfileId: asProfileId(payload.toProfileId),
            baseAsset: err.symbol,
          },
          'dispose_profile_blocked_wallet_conflict',
        );
        await announceHandoffBlocked(deps, p, profileId, targetRow.name, err);
        return;
      }
      throw err;
    }
    // UNCONDITIONAL, not `if (handoffs.length > 0)`: a retry after a crash between
    // the writes and here finds the source already stripped, so gating on the plan
    // would skip the one step that makes the target aware of what it now owns.
    // Idempotent by construction (it re-reads DB truth), so re-running is free.
    await deps.reconfigure({ userId, accountId, profileId: asProfileId(payload.toProfileId) });
    // ...and then PROVE it worked. The reconcile inside `reconfigure` is fail-soft on
    // purpose (a missing symbolInfo key, a `getAccount` blip, or a strategy without a
    // position adapter must never crash a live profile's reconfigure), so it can seed
    // nothing and still return. Every other step of this disposal is held to "throw
    // until provably clean"; this is the one whose failure is UNRECOVERABLE — delete
    // the source and the target is left holding the coins while reading FLAT, with no
    // row left for a retry to re-derive. So verify, and throw if the seeding is not
    // there: the retry re-runs `reconfigure` (the plan is empty by then, the source
    // being stripped already) and re-verifies.
    const targetProfile = await target.profile.findById();
    await assertTargetSeeded(deps, target, targetProfile?.strategyName ?? profile.strategyName);
  }

  // 4. Confirm the exchange is clear before the row goes. DB truth alone is not
  //    enough: a cancel that never reached Binance would leave the order resting
  //    with the local row already stamped closed. A still-open order throws, so
  //    BullMQ retries and the profile stays alive until it is provably clean.
  const stillLive = await p.orders.listLiveForProfile();
  if (stillLive.length > 0) {
    throw new Error(`dispose_profile: ${stillLive.length} order(s) still live locally`);
  }
  const binance = await deps.resolveBinanceClient(userId, accountId);
  if (binance === null) {
    if (plan.cancels.length > 0) {
      // We had orders to cancel and cannot ask the exchange whether they are gone.
      // "I could not ask" is not "it is clear": throw, and the retry asks again.
      throw new Error('dispose_profile: no Binance client to confirm the exchange is clear');
    }
    // Nothing was ever placed for this profile (an account with no api key), so
    // there is nothing on the exchange to confirm.
    deps.logger.warn({ profileId }, 'dispose_profile_no_binance_client_nothing_to_confirm');
  } else {
    // Enumerate the WHOLE account (no symbol argument), never the plan's symbols. The
    // plan is derived from DB truth, and the order this confirm exists to catch is
    // exactly the one our books never recorded: the bookkeeping-failure path leaves a
    // live order with no row, and a later unbind takes away the last symbol that would
    // have made a per-symbol probe ask about it. One account-wide call (weight 80 vs 6
    // per symbol) sees every symbol, including the ones we have forgotten.
    //
    // Ownership rests on TWO independent proofs, and either suffices. The strategy that
    // minted the clientOrderId can re-derive it, so `attributeOrder` is a fingerprint
    // that needs no DB row. But some ids are unenumerable by design (momentum folds a
    // candle close time into its hash), so a DB row this profile wrote is the second
    // proof, and it holds even after closePrevious stamped the row CLOSED while the
    // order still rests. An order EITHER proves is ours to cancel; abandoning it is how a
    // deleted profile's stop went on holding the operator's funds with nothing left in
    // the system pointing at it. An order neither can claim is never cancelled and never
    // blocks the delete.
    const open = await binance.getOpenOrders();
    // Ask which of the ids ACTUALLY on the book this profile recorded, closed or not
    // (listRecordedAmong is closed-blind by design). Key on symbol:orderId: a Binance
    // orderId is unique per symbol, not per account.
    const recorded = new Set(
      (await p.orders.listRecordedAmong(open.map((o) => BigInt(o.orderId)))).map((r) =>
        orderKey(r.symbol, r.binanceOrderId),
      ),
    );
    // A handed-off symbol is no longer ours to report on: `reconfigure` just had the
    // TARGET arm its own protective stop there, and that order attributes to the
    // target, so it would otherwise be announced as an order "the bot has no record of
    // placing" seconds after the bot placed it.
    const handedOff = new Set(plan.handoffs.map((h) => h.symbol));
    const attribute = buildAttributor(
      deps,
      profileId,
      profile.strategyName,
      profile.config,
      new Map(bindings.map((b) => [b.symbol, b.overrideConfig])),
    );
    const actions = selectConfirmActions(
      open,
      new Set(plan.cancels.map((o) => orderKey(o.symbol, o.binanceOrderId))),
      new Set(plan.symbols.filter((s) => !handedOff.has(s))),
      (o) => attribute(o) || recorded.has(orderKey(o.symbol, o.orderId)),
    );
    if (actions.stillResting.length > 0) {
      throw new Error(
        `dispose_profile: ${actions.stillResting.length} order(s) still resting on Binance: ${actions.stillResting.map((o) => orderKey(o.symbol, o.orderId)).join(', ')}`,
      );
    }
    // Announce BEFORE cancelling: a cancel that fails retryably throws, and the
    // residual alert must not be collateral damage of a transient Binance error — it
    // is a pure notification that depends on nothing the cancels produce.
    for (const [symbol, residual] of actions.residualBySymbol) {
      await announceResidual(deps, p, profileId, symbol, residual);
    }
    // A cancel that fails retryably throws, so the retry re-enumerates and finds the
    // order again; a non-retryable one is the executor's verdict that it has already
    // left the book. Either way the profile never outlives an order we proved is ours.
    for (const ours of actions.cancels) {
      deps.logger.warn(
        {
          profileId,
          symbol: ours.symbol,
          orderId: ours.orderId,
          clientOrderId: ours.clientOrderId,
        },
        'dispose_profile_cancelling_untracked_own_order',
      );
      await cancelOne(deps, payload, {
        id: `binance:${ours.orderId}`,
        symbol: ours.symbol,
        binanceOrderId: BigInt(ours.orderId),
      });
    }
  }

  // 5. Redis AFTER the confirmation, and the row LAST: a crash between them
  //    re-runs the job, which re-derives everything from the surviving row.
  await wipeProfileRedis(deps.redis, accountId, profileId);
  const deleted = await p.profile.deleteById();
  deps.logger.info(
    { profileId, disposition, cancelled: plan.cancels.length, handoffs: plan.handoffs.length },
    deleted ? 'dispose_profile_done' : 'dispose_profile_row_already_gone',
  );
};
