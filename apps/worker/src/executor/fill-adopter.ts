// Fill-adopter: propagates Binance executionReport fills into TT state.
//
// Strategies are pure; they cannot mutate state in response to events
// they did not emit. A manual order (or any order whose lifecycle the
// strategy did not drive) fills on Binance, the wallet balance changes,
// but the strategy's `avgEntryPrice` / `quantity` stay frozen, and the
// next tick evaluates against a position that does not match reality.
//
// The adopter closes that gap. On a FILLED executionReport from the
// user stream it:
//
//   - BUY: weighted-averages the order's avg fill price into the
//     existing avg_entry_prices row (or seeds it), bumps quantity, and
//     resets `state.highSinceBuy` so the trailing-stop high-water mark
//     restarts at the new entry.
//   - SELL emptying the held position: removes the avg_entry_prices row
//     and clears `state.avgEntryPrice` / `state.highSinceBuy`, resetting
//     `state.currentGridTradeIndex` to 0 so the next cycle re-enters
//     from the entry rung.
//   - SELL not emptying the held position: reduces quantity only,
//     LBP and grid index stay intact for the remaining slug.
//
// Idempotency: Binance replays executionReport on reconnect. The
// adopter dedupes against `applied_fills` (PG, commit-durable), a
// `tryRecord` insert with ON CONFLICT DO NOTHING returns `false` on a
// replay and routes the adopter through a state-convergence path that
// reads the existing LBP row instead of recomputing the weighted
// average. PG is the sole dedupe primitive; the chain-lock already
// serialises per (profile, symbol) so the extra PG roundtrip on every
// fill is bounded.
//
// Two-phase atomicity. The fill applies in two stages:
//
//   1. In-tx: `applied_fills.tryRecord` + `avg_entry_prices` write
//      (upsert or remove) commit as one. If either throws the tx
//      rolls back, leaving the ledger row absent, the next retry
//      sees no audit row and runs as a fresh first-apply with
//      correct math.
//
//   2. Post-tx: `mutateSymbolState` converges the per-(profile,
//      symbol) strategy slice to the persisted LBP values. If this
//      fails, the ledger + LBP are durable and the next retry routes
//      through the replay path (tryRecord -> false), which reads the
//      LBP row and re-runs only the state mutation. The strategy
//      converges without double-counting the fill quantity.
//
// Concurrency: every mutation runs under the same `chainByKey` lock
// the tick handler uses, keyed on `(profileId, symbol)`. A fill
// applied mid-tick does not race the strategy's own state write, and
// two simultaneous fills on different symbols of the same profile no
// longer share a single state blob, each mutates only its own
// `symbol_states` row.

import type { Logger } from 'pino';
import type { Queue } from 'bullmq';
import { Decimal, isPlainDecimalString } from '@app/money';
import {
  accountRepoFromScope,
  scopeAccount,
  type Database,
  profileRepo,
  profileRepoFromScope,
  toAccountScope,
  withTx,
  ProfileNotOwnedError,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
} from '@app/db';
import { unwrapId, type AccountId, type ProfileId, type UserId } from '@app/contracts';
import { resolveFill, realizedPnlOnSell } from '@app/strategy-core';
import type {
  AdoptedFill,
  PositionStateAdapter,
  PositionView,
  RealizedPnl,
} from '@app/strategy-core';

import type { ChainByKey } from 'lib/chain-by-key.js';
import type { StatePort } from 'state/state-port.js';
import type { SymbolInfoCache } from 'tick/symbol-info-cache.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';

/**
 * Minimal registry view: resolves the position-mutation capability for a
 * profile's strategy. The adopter applies fills through the capability so
 * it never names the strategy's state fields (core invariant #1).
 */
export interface PositionStrategyLookup {
  get(name: string): { readonly position?: PositionStateAdapter } | undefined;
}

export interface FillEvent {
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly orderId: number;
  readonly tradeId: number;
  readonly orderStatus: string;
  readonly side: 'BUY' | 'SELL';
  readonly cumQty: string;
  readonly cumQuoteQty: string;
  /**
   * Total commission per asset across the whole order. The user stream reports
   * fees per trade, so the caller accumulates the partials; the REST backfiller
   * sums `myTrades` rows. Absent means unknown and folds the gross quantity.
   */
  readonly commissions?: Readonly<Record<string, string>>;
}

export interface FillAdopterDeps {
  readonly db: Database;
  readonly chain: ChainByKey;
  readonly logger: Logger;
  /**
   * Per-(profile, symbol) state boundary. The adopter only needs the
   * version-safe mutate path; load/commit are owned by other call sites
   * (tick-handler, future reset paths) that share the same port.
   */
  readonly statePort: StatePort;
  /**
   * Resolves a profile's strategy so the adopter can merge the fill onto
   * the body via the strategy's `position` capability rather than writing
   * concrete field names.
   */
  readonly registry: PositionStrategyLookup;
  /**
   * Pipeline queue. A SELL fill that empties the held position enqueues an
   * `archive-grid-trade` job so the just-closed cycle is snapshotted into
   * `trade_archive` automatically, instead of waiting for a manual operator
   * click. Best-effort: an enqueue failure is logged and swallowed so it
   * never fails the already-committed fill.
   */
  readonly pipelineQueue: Queue;
  /**
   * Symbol-info cache, read on SELL fills to resolve the LOT_SIZE stepSize so
   * `resolveFill` can flatten a sub-step fee residual (otherwise a phantom
   * position blocks re-entry). A lookup failure (delisted symbol) degrades to
   * the exact-zero residual behavior and never blocks the committed fill.
   */
  readonly symbolInfo: SymbolInfoCache;
  /**
   * Fires the profile's `order-filled` operator alert on a fresh fill. Optional
   * so unit tests can omit it; the notifier self-gates on the (default-off)
   * subscription and swallows provider failures, so a fill never fails on it.
   */
  readonly notifyEvent?: NotifyEvent;
}

export interface FillAdopter {
  /**
   * Adopts a single FILLED executionReport. Idempotent on (orderId,
   * tradeId). Non-FILLED statuses are silently skipped, PARTIALLY_FILLED
   * carries fill data too, but every PARTIAL is followed by either
   * another PARTIAL or a terminal FILLED that itself carries the full
   * cumulative qty, so adopting only at FILLED gives a single mutation
   * per order without losing data.
   */
  adopt(event: FillEvent): Promise<void>;
  /**
   * Close the ledger row of a DETACHED order (profile_id NULL — its profile was
   * deleted) that reached a terminal state on Binance.
   *
   * This is the ledger half of adoption, without the strategy half. The exchange
   * is the source of truth and it says the order is done, so the row MUST be
   * closed: left open it counts forever toward the account's open exposure (which
   * backs the delete-account guard) and stays forever in the tracked-live set
   * (which is what stops the orphan detector from ever surfacing it) — an
   * immortal, invisible row, i.e. exactly the stale-record class of bug the
   * account-detach model exists to prevent.
   *
   * It deliberately does NOT adopt: no cost basis, no strategy state, no
   * re-subscription. There is no profile left to adopt it into, and inventing one
   * would hand a deleted profile's position to whichever sibling happened to
   * receive the frame.
   *
   * Account-scoped and idempotent, so it is safe to call once per active profile
   * on the account (every profile's stream receives the whole account's reports).
   */
  reconcileDetachedFill(event: DetachedOrderEvent): Promise<void>;
}

/** A terminal executionReport for an order no profile owns any more. */
export interface DetachedOrderEvent {
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly symbol: string;
  readonly orderId: number;
  readonly orderStatus: string;
  readonly cumQty: string;
  readonly cumQuoteQty: string;
  readonly eventTimeMs: number;
}

// Binance states that mean the order has left the book for good. Only these close
// the row: a PARTIALLY_FILLED / NEW report says the order is still live.
const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

export const createFillAdopter = (deps: FillAdopterDeps): FillAdopter => {
  const adopt = async (event: FillEvent): Promise<void> => {
    if (event.orderStatus !== 'FILLED') return;
    // Decimal compare, Binance has serialised qty as `'0'`, `'0.00'`,
    // and `'0.00000000'` in different stream branches; a string
    // equality on `'0'` would silently divide-by-zero on the others.
    if (new Decimal(event.cumQty).lte(0) || new Decimal(event.cumQuoteQty).lte(0)) return;
    if (event.tradeId === 0 || event.orderId === 0) {
      // Binance has shipped events with `t: 0` in canary windows
      // before. Refuse to dedupe on a zero trade id, the next replay
      // would re-mutate state with the same key.
      deps.logger.warn(
        { profileId: event.profileId, symbol: event.symbol, orderId: event.orderId },
        'fill-adopter: refusing to apply fill with zero orderId or tradeId',
      );
      return;
    }

    const chainKey = `${unwrapId(event.profileId)}:${event.symbol}`;
    await deps.chain.run(chainKey, async () => {
      let scope;
      try {
        scope = await profileRepo(deps.db, event.operatorId, event.accountId, event.profileId);
      } catch (err) {
        if (err instanceof ProfileNotOwnedError) {
          deps.logger.warn(
            { operatorId: event.operatorId, profileId: event.profileId, symbol: event.symbol },
            'fill-adopter: profile disappeared mid-fill; ignoring',
          );
          return;
        }
        throw err;
      }

      // Resolve the strategy's position capability before the tx. A
      // profile whose strategy lacks the capability (or that vanished
      // mid-fill) has no position model to converge — skip rather than
      // write a body the strategy can't parse.
      const profileRow = await scope.profile.findById();
      if (!profileRow) {
        deps.logger.warn(
          { operatorId: event.operatorId, profileId: event.profileId, symbol: event.symbol },
          'fill-adopter: profile not found mid-fill; ignoring',
        );
        return;
      }
      const positionAdapter = deps.registry.get(profileRow.strategyName)?.position;
      if (!positionAdapter) {
        deps.logger.warn(
          {
            profileId: event.profileId,
            symbol: event.symbol,
            strategyName: profileRow.strategyName,
          },
          'fill-adopter: strategy has no position capability; skipping fill adoption',
        );
        return;
      }

      // Origin gate: adopt ONLY orders THIS profile actually placed. Every bot
      // order — strategy (place-order → persistOrder) or manual (override →
      // place-order) — is recorded in `orders`/`manual_orders` keyed by
      // binanceOrderId, and that write commits inside the SAME (profile, symbol)
      // chain lock this adopt() re-acquires. The order does not exist on Binance
      // until placeOrder runs inside the lock, so an executionReport can never
      // reach this adopter before the placing tick has committed its row; the
      // adopter always queues behind that tick and sees the durable row. A fill
      // matching NO local order is therefore an external/manual Binance trade
      // made outside the bot; adopting it would silently start managing a coin
      // the operator never asked the profile to track. Skip it whole: no
      // cost-basis seed, no strategy-state seed, no re-subscription.
      //
      // Deliberate consequence: a bot order whose post-submit bookkeeping insert
      // failed leaves no `orders` row, so its fill is not adopted here. That
      // order is already a loudly-alerted orphan (order-bookkeeping-failed
      // emergency notify + recordBookkeepingFailure action log), so refusing
      // adoption is consistent, not a silent failure.
      //
      // A DETACHED order (profile_id NULL, its profile deleted) is a different
      // case and is NOT handled here: it belongs to no profile, so there is no
      // strategy state to adopt it into — but its row must still be CLOSED when it
      // fills, or it stays open forever and counts as phantom exposure. That
      // ledger-only close is account-domain work and lives in
      // `reconcileDetachedFill`; the router sends detached reports there instead
      // of here. Refusing it in BOTH places would be the silent failure.
      const binanceOrderId = BigInt(event.orderId);
      // Reconciliation by Binance id is account-domain, so this lookup spans the
      // account. Narrow it back to THIS profile explicitly: a sibling profile's
      // order (or a detached one) is not ours to adopt.
      const accountOrders = accountRepoFromScope(toAccountScope(scope.scope)).orders;
      const [strategyRow, ownManual] = await Promise.all([
        accountOrders.findByBinanceOrderId(binanceOrderId),
        scope.manualOrders.findByBinanceOrderId(binanceOrderId),
      ]);
      const ownStrategy =
        strategyRow && strategyRow.profileId === unwrapId(scope.scope.profileId)
          ? strategyRow
          : null;
      if (ownStrategy === null && ownManual === null) {
        // Three shapes reach here and none is adoptable by THIS profile, but they
        // are not the same event, so do not report them as one: no row at all is a
        // genuinely external trade; a row owned by a sibling is that sibling's to
        // adopt on its own stream; a DETACHED row is nobody's, and its ledger close
        // is `reconcileDetachedFill`'s job (the router already routed it there —
        // this path is only reached by the backfiller, which replays trades by
        // symbol and cannot pre-classify them).
        const origin =
          strategyRow === null
            ? 'external'
            : strategyRow.profileId === null
              ? 'detached'
              : 'sibling';
        deps.logger.info(
          {
            profileId: event.profileId,
            symbol: event.symbol,
            orderId: event.orderId,
            side: event.side,
            origin,
          },
          `fill-adopter: ${origin} fill; not adopting into this profile`,
        );
        return;
      }

      // Resolve the symbol's exchange metadata before the tx. Read outside the
      // tx (a cache read, not a ledger write) and degrade on any failure — a
      // delisted symbol must never block an already-final fill. Two consumers:
      //   - SELL: the LOT_SIZE stepSize, so resolveFill can flatten a sub-step
      //     fee residual.
      //   - BUY: the base asset, so a base-asset commission is netted out of
      //     the credited quantity.
      const commissions = parseCommissions(deps, event);
      let sellStepSize: Decimal | undefined;
      let sellMinNotional: Decimal | undefined;
      let baseAsset: string | undefined;
      let stepSizeUnknown = false;
      if (event.side === 'SELL' || commissions !== null) {
        try {
          const info = await deps.symbolInfo.get(event.symbol);
          baseAsset = info.baseAsset;
          if (event.side === 'SELL') {
            sellStepSize = new Decimal(info.filters.stepSize);
            // Parsed separately and never allowed to throw: `stepSizeUnknown` below drives an operator action log that names the LOT_SIZE lookup specifically, and the cache hands back an unvalidated `JSON.parse` cast, so an entry written before `minNotional` joined the projection would raise that alert for a non-incident. An absent floor just disarms the value bound.
            sellMinNotional = optionalDecimal(info.filters.minNotional);
          }
        } catch (err) {
          stepSizeUnknown = event.side === 'SELL';
          deps.logger.warn(
            { profileId: event.profileId, symbol: event.symbol, err: err },
            'fill-adopter: symbol-info lookup failed; folding without sub-step flatten or fee netting',
          );
        }
      }
      // The quantity the wallet was actually credited. Everything downstream
      // (cost basis, held quantity, the flat test on the eventual exit) is
      // measured against the wallet, so the fold has to start there.
      const buyQty =
        event.side === 'BUY'
          ? netBuyQuantity(deps, event, commissions, baseAsset)
          : new Decimal(event.cumQty);

      // PG-side dedupe gate. Wrap the `applied_fills` insert and the
      // `avg_entry_prices` write in a single transaction so they
      // commit or roll back together. If only the LBP write throws,
      // the ledger row also rolls back, the next retry sees no audit
      // row, runs `tryRecord` again as a first-apply, and the math
      // is correct. If both commit but `mutateSymbolState` (outside
      // the tx) then throws, the audit row stays and the next retry
      // routes through the replay-converge path that reads the
      // persisted LBP without recomputing the weighted average.
      const ownedScope = scope.scope;
      // Whether this executionReport is a fresh apply (not a Binance reconnect
      // replay). Captured out of the tx so the post-commit `order-filled`
      // notification fires exactly once per fill.
      let firstApply = false;
      const resolution = await deps.db.transaction(async (tx) => {
        const txScope = profileRepoFromScope(withTx(ownedScope, tx as Database));
        const isFirstApply = await txScope.appliedFills.tryRecord({
          symbol: event.symbol,
          orderId: event.orderId,
          tradeId: event.tradeId,
          side: event.side,
        });
        firstApply = isFirstApply;
        if (event.side === 'BUY') {
          return resolveBuy(txScope, event, isFirstApply, buyQty);
        }
        return resolveSell(txScope, event, isFirstApply, sellStepSize, sellMinNotional);
      });

      // Reconcile the orders-table row, and stamp realised P/L, BEFORE
      // applyResolution — applyResolution enqueues the archive job on a full
      // exit, and the archiver reads this row's `realized_pnl`.
      //
      // Two distinct writes, two distinct reasons:
      //   1. markFilled flips a resting LIMIT / STOP_LOSS_LIMIT row NEW→FILLED
      //      (it fills on the user-stream, not through place-order's insert);
      //      keyed on the Binance orderId so it reclaims a row a racing tick
      //      already CANCELED; idempotent on replay (status<>'FILLED'). A MARKET
      //      sell is already FILLED from place-order, so this is a no-op for it.
      //   2. stampRealizedPnl writes the cost-basis columns with NO status
      //      guard, so it stamps BOTH the resting fill AND the synchronous
      //      MARKET sell (the dominant exit) that markFilled cannot touch.
      //      Write-once (realized_pnl IS NULL), so a replay never overwrites.
      // Both best-effort: the orders row is tracking-only, so a failure must
      // never fail the already-committed position.
      const realized = 'realized' in resolution ? resolution.realized : undefined;
      try {
        const orders = accountRepoFromScope(toAccountScope(ownedScope)).orders;
        await orders.markFilledByBinanceOrderId(BigInt(event.orderId), {
          executedQty: event.cumQty,
          cummulativeQuoteQty: event.cumQuoteQty,
        });
        if (realized != null) {
          await orders.stampRealizedPnl(BigInt(event.orderId), realized);
        }
      } catch (err) {
        deps.logger.warn(
          {
            profileId: event.profileId,
            symbol: event.symbol,
            orderId: event.orderId,
            err: err,
          },
          'fill-adopter: orders-row FILLED reconciliation failed (position already applied)',
        );
      }

      await applyResolution(deps, scope, event, resolution, positionAdapter);

      // The LOT_SIZE lookup failed, so `resolveFill` ran without the sub-step
      // flatten and any leftover crumb is indistinguishable from a real
      // partial. The fill is final on Binance, so it is never blocked — but a
      // strand must not be silent: an un-flattened crumb keeps `avgEntryPrice`
      // set and blocks re-entry until the recovery sweep or a later fill
      // clears it, and a warn-only line is invisible to the operator.
      // Gated on the fresh apply for the same reason the alert below is: a
      // Binance reconnect replays the terminal report, `resolveSell` takes its
      // replay branch and still reports `set`, so an ungated write would hand
      // the operator a second row for one strand and imply a second incident.
      if (firstApply && stepSizeUnknown && resolution.kind === 'set') {
        deps.logger.error(
          {
            profileId: event.profileId,
            symbol: event.symbol,
            orderId: event.orderId,
            residualQty: resolution.qty,
          },
          'fill-adopter: SELL residual could not be checked against LOT_SIZE (symbol-info unavailable); position may be stranded on unsellable dust',
        );
        await appendFillActionLog(
          deps,
          scope,
          event,
          `Could not confirm ${event.symbol} was fully sold: ${resolution.qty} still tracked, and the exchange's trading rules were unavailable to check whether that amount is too small to sell`,
          { outcome: 'residual-unverified', remainingQuantity: resolution.qty },
        );
      }

      // Money moved on the exchange — fire the profile's `order-filled` alert on
      // a fresh apply only (a Binance replay is not a new fill). Best-effort and
      // self-gated on the (default-off) subscription; never fails the fill.
      if (firstApply && deps.notifyEvent) {
        const avgPrice = new Decimal(event.cumQuoteQty).div(event.cumQty).toFixed();
        await deps.notifyEvent({
          category: 'order-filled',
          operatorId: event.operatorId,
          accountId: event.accountId,
          profileId: event.profileId,
          symbol: event.symbol,
          body: `${event.side === 'BUY' ? 'Bought' : 'Sold'} ${event.symbol}: ${event.cumQty} at avg ${avgPrice}.`,
          fields: [
            { label: 'Side', value: event.side },
            { label: 'Quantity', value: event.cumQty },
            { label: 'Avg price', value: avgPrice },
            { label: 'Total', value: event.cumQuoteQty },
          ],
        });
      }
    });
  };

  const reconcileDetachedFill = async (event: DetachedOrderEvent): Promise<void> => {
    if (!TERMINAL_STATUSES.has(event.orderStatus)) return;
    // Account scope, not profile scope: a detached row is reachable only by
    // account, and `scopeAccount` proves the operator owns it.
    const orders = accountRepoFromScope(
      await scopeAccount(deps.db, event.operatorId, event.accountId),
    ).orders;

    // Detachment is a property of the ROW, not of the caller's belief about it, so
    // re-prove it here. Two callers reach this (the event-router's ownership gate
    // and the reconcile cron), and both read the row at a different instant than
    // this write commits. Closing a row that still has a profile would settle a
    // live order behind its strategy's back AND skip the cost-basis stamp that
    // `adopt()` owes it — a corrupt ledger, not just a missed one. An absent row
    // (an untracked external order) is likewise not ours to close.
    const row = await orders.findByBinanceOrderId(BigInt(event.orderId));
    if (!row || row.profileId !== null) return;

    const closed =
      event.orderStatus === 'FILLED'
        ? // FILLED gets the exchange's true totals merged into `raw` so the row's
          // executedQty is honest, exactly as an adopted fill would. Idempotent
          // (`status <> 'FILLED'`), so the N-active-profiles fan-out settles once.
          await orders.markFilledByBinanceOrderId(
            BigInt(event.orderId),
            { executedQty: event.cumQty, cummulativeQuoteQty: event.cumQuoteQty },
            event.eventTimeMs,
          )
        : await orders.closeByBinanceOrderId(
            BigInt(event.orderId),
            event.orderStatus,
            event.eventTimeMs,
          );

    // No realised-P/L stamp: the cost basis lived on the deleted profile's ledger,
    // and fabricating a number here would inflate the archive. The row closes with
    // realized_pnl NULL, which the archive already reads as "unknown cost basis".
    if (closed > 0) {
      deps.logger.warn(
        {
          accountId: event.accountId,
          symbol: event.symbol,
          orderId: event.orderId,
          status: event.orderStatus,
        },
        'fill-adopter: a detached order (its profile was deleted) reached a terminal state; closed its row without adopting',
      );
    }
  };

  return { adopt, reconcileDetachedFill };
};

// Discriminated union the in-tx phase returns to the post-tx phase.
// `clear` empties the position state; `set` writes lbp+qty into state;
// `noop` records that the BUY replay's LBP row is gone (emptied by an
// interleaved SELL), nothing to converge.
type FillResolution =
  | {
      readonly kind: 'set';
      readonly side: 'BUY' | 'SELL';
      readonly lbp: string;
      readonly qty: string;
      // Cost-basis-matched realised P/L of a first-apply SELL fill, stamped onto
      // the order row so the archiver sums it. `null` ⇒ no known cost basis (do
      // not book profit); absent on BUYs and on replays (the row is already
      // FILLED, so a re-stamp would no-op anyway).
      readonly realized?: RealizedPnl | null;
    }
  | {
      readonly kind: 'clear';
      readonly side: 'BUY' | 'SELL';
      readonly realized?: RealizedPnl | null;
    }
  | { readonly kind: 'noop'; readonly reason: string };

/**
 * Parse every per-asset subtotal before using any one of them. A malformed
 * foreign-asset subtotal makes the whole record unknowable too, otherwise the
 * base subtotal could be partial while looking complete.
 */
const parseCommissions = (
  deps: FillAdopterDeps,
  event: FillEvent,
): ReadonlyMap<string, Decimal> | null => {
  if (!event.commissions) return null;
  const parsed = new Map<string, Decimal>();
  for (const [asset, raw] of Object.entries(event.commissions)) {
    if (!asset || !isPlainDecimalString(raw)) {
      deps.logger.warn(
        { profileId: event.profileId, symbol: event.symbol, commissions: event.commissions },
        'fill-adopter: invalid commission totals; folding gross quantity',
      );
      return null;
    }
    const charged = new Decimal(raw);
    if (!charged.isFinite() || charged.lt(0)) return null;
    parsed.set(asset, charged);
  }
  return parsed.size > 0 ? parsed : null;
};

/**
 * Quantity a BUY actually credited to the wallet. Binance charges the BUY fee
 * in the BASE asset unless a discount asset (BNB) is enabled, so folding the
 * gross `executedQty` tracks a position permanently larger than the balance.
 * The protective exit is sized from the real balance, so it can never bring
 * the tracked number to zero: the exit resolves as a partial, the cycle never
 * closes, and the completed trade never reaches the archive.
 *
 * Falls back to gross when there is no positive base-asset subtotal, the base
 * asset cannot be resolved, or the commission record is absent or invalid. An
 * unmeasured fee must not be guessed at.
 */
const netBuyQuantity = (
  deps: FillAdopterDeps,
  event: FillEvent,
  commissions: ReadonlyMap<string, Decimal> | null,
  baseAsset: string | undefined,
): Decimal => {
  const gross = new Decimal(event.cumQty);
  if (commissions === null || !baseAsset) return gross;
  const charged = commissions.get(baseAsset);
  if (!charged || charged.lte(0)) return gross;
  const net = gross.minus(charged);
  if (net.lte(0)) {
    // A fee at or above the whole fill is not a fee; trust the fill instead of
    // writing a zero/negative position that would divide-by-zero on the VWAP.
    deps.logger.error(
      {
        profileId: event.profileId,
        symbol: event.symbol,
        orderId: event.orderId,
        cumQty: event.cumQty,
        commission: charged.toString(),
      },
      'fill-adopter: base-asset commission >= filled quantity; folding gross quantity',
    );
    return gross;
  }
  return net;
};

const resolveBuy = async (
  scope: Awaited<ReturnType<typeof profileRepo>>,
  event: FillEvent,
  isFirstApply: boolean,
  fillQty: Decimal,
): Promise<FillResolution> => {
  const existing = await scope.avgEntryPrices.findBySymbol(event.symbol);
  if (isFirstApply) {
    // The whole order's VWAP folds onto the prior durable position via the
    // shared resolveFill (same fold the backtest uses). The durable upsert,
    // idempotency, and replay branch below stay owned here.
    //
    // The VWAP divides by the FEE-NET quantity, not the gross: the operator
    // paid `cumQuoteQty` and received `fillQty`, so that ratio is the real
    // per-unit cost. Dividing by gross would understate the entry price and
    // book the base-asset fee as profit on the exit.
    const fillAvgPrice = new Decimal(event.cumQuoteQty).div(fillQty);
    const prior: PositionView | null = existing
      ? { avgEntryPrice: existing.avgEntryPrice, heldQuantity: existing.quantity }
      : null;
    const adopted = resolveFill(prior, { side: 'BUY', price: fillAvgPrice, quantity: fillQty });
    await scope.avgEntryPrices.upsert(event.symbol, {
      avgEntryPrice: adopted.avgEntryPrice,
      quantity: adopted.heldQuantity,
    });
    return { kind: 'set', side: 'BUY', lbp: adopted.avgEntryPrice, qty: adopted.heldQuantity };
  }
  // Replay: the audit row exists, so the prior attempt committed the
  // LBP upsert. Read the persisted values and only re-run state
  // convergence; recomputing the weighted average would double-count
  // the fill.
  if (!existing) {
    // Audit row durable but LBP gone, only possible if an emptying
    // SELL ran between the original BUY and this replay. State is
    // already flat; nothing to converge.
    return { kind: 'noop', reason: 'BUY replay: LBP row cleared by interleaved SELL' };
  }
  return {
    kind: 'set',
    side: 'BUY',
    lbp: existing.avgEntryPrice,
    qty: existing.quantity,
  };
};

/**
 * Parses a decimal string that may be absent or malformed, without throwing.
 *
 * @param raw - Candidate decimal string from an unvalidated cache payload.
 * @returns The parsed Decimal, or undefined when the value is missing or unparseable.
 */
// Finite-only, because `decimal.js` takes `Infinity` and `NaN` as values rather than throwing and this payload is unvalidated. An infinite `minNotional` is the direction that bites: every finite residual is below it, so the sub-notional flatten would clear live positions instead of standing down. Undefined is the safe answer, since an absent bound is a skipped bound.
const optionalDecimal = (raw: string | undefined): Decimal | undefined => {
  if (raw === undefined) return undefined;
  try {
    const parsed = new Decimal(raw);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const resolveSell = async (
  scope: Awaited<ReturnType<typeof profileRepo>>,
  event: FillEvent,
  isFirstApply: boolean,
  stepSize?: Decimal,
  minNotional?: Decimal,
): Promise<FillResolution> => {
  const existing = await scope.avgEntryPrices.findBySymbol(event.symbol);
  if (!existing) {
    // Sell with no held position, already cleared by an earlier
    // replay or the operator sold dust that was never tracked here.
    // The strategy state still needs a clearing pass in case it has
    // stale LBP from a pre-adopter era.
    return { kind: 'clear', side: 'SELL' };
  }

  // First apply: fold held - sold via the shared resolveFill (same fold the backtest uses), then persist. `stepSize`, the symbol's LOT_SIZE increment, flattens a sub-step residual: the base-asset trading-fee crumb left when a full exit's sold qty, sized to the fee-net wallet balance, falls a fee short of the tracked GROSS held qty, so avgEntryPrice clears and re-entry is not blocked. `minNotional` flattens the crumb that clears the step but is worth less than one minimum order, which LOT_SIZE alone leaves stranded forever. Either being absent, from the delisted-symbol lookup failure below, degrades to the exact-zero residual behaviour, never blocking the already-committed fill.
  if (isFirstApply) {
    // Price the realised gain against the cost basis BEFORE the fold mutates the
    // ledger. Computed from `existing` (the pre-sell position), so a full exit
    // that removes the ledger row still books the correct realised P/L.
    const realized = realizedPnlOnSell(
      { avgEntryPrice: existing.avgEntryPrice, heldQuantity: existing.quantity },
      { soldQty: new Decimal(event.cumQty), proceeds: new Decimal(event.cumQuoteQty) },
    );
    // This sell's own VWAP, the price the crumb would have fetched had it been sellable. Guarded against a zero `cumQty` so a degenerate report values the residual at zero and skips the notional flatten rather than emptying the position.
    const soldQty = new Decimal(event.cumQty);
    const sellVwap = soldQty.gt(0) ? new Decimal(event.cumQuoteQty).div(soldQty) : new Decimal(0);
    const adopted = resolveFill(
      { avgEntryPrice: existing.avgEntryPrice, heldQuantity: existing.quantity },
      { side: 'SELL', price: sellVwap, quantity: soldQty },
      stepSize,
      minNotional,
    );
    if (adopted.kind === 'empty') {
      await scope.avgEntryPrices.remove(event.symbol);
      return { kind: 'clear', side: 'SELL', realized };
    }
    await scope.avgEntryPrices.upsert(event.symbol, {
      avgEntryPrice: existing.avgEntryPrice,
      quantity: adopted.heldQuantity,
    });
    return {
      kind: 'set',
      side: 'SELL',
      lbp: existing.avgEntryPrice,
      qty: adopted.heldQuantity,
      realized,
    };
  }

  // Replay: the LBP row already reflects the reduction, so trust its persisted
  // quantity directly rather than subtracting the same `cumQty` a second time.
  const remaining = new Decimal(existing.quantity);
  if (remaining.lte(0)) {
    return { kind: 'clear', side: 'SELL' };
  }
  return { kind: 'set', side: 'SELL', lbp: existing.avgEntryPrice, qty: existing.quantity };
};

/**
 * Append one operator-visible row to `action_logs` for an adopted fill, so the
 * activity feed shows what the bot actually traded. Fills land via the
 * user-stream outside the tick, so the audit-drainer (which only sees tick
 * decisions) never records them — this is the only place a manual/async fill
 * becomes visible to the operator. Best-effort: a logging failure must never
 * fail an already-committed fill, so it is swallowed at warn.
 */
const appendFillActionLog = async (
  deps: FillAdopterDeps,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  event: FillEvent,
  msg: string,
  detail: Record<string, unknown>,
): Promise<void> => {
  try {
    await scope.actionLogs.append({
      time: new Date(),
      symbol: event.symbol,
      level: 'info',
      msg,
      ctx: { source: 'fill', side: event.side, orderId: event.orderId, ...detail },
    });
  } catch (err) {
    deps.logger.warn(
      { profileId: event.profileId, symbol: event.symbol, err: err },
      'fill-adopter: action_log append failed (fill already applied)',
    );
  }
};

/**
 * Re-create the `profile_symbols` binding when a fill leaves a live position on
 * a symbol the profile is no longer subscribed to. This is the orphan-recovery
 * safety net: discovery (or a manual delete) can drop a symbol whose buy fill
 * had not yet been adopted, and the late adoption would otherwise write a
 * position nothing manages. Re-subscribing as `manual` guarantees the next
 * reconfigure/boot resumes managing it AND keeps discovery from reaping it
 * again. No-op when the binding already exists.
 */
const ensureSubscribedForPosition = async (
  deps: FillAdopterDeps,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  event: FillEvent,
): Promise<void> => {
  const existing = await scope.profileSymbols.findForSymbol(event.symbol);
  if (existing) return;
  // Resolve the symbol's base asset (the shared wallet line) for the
  // exclusivity guard. A lookup failure (delisted symbol, cold cache) leaves the
  // position un-resubscribed rather than failing the already-committed fill.
  let baseAsset: string;
  try {
    ({ baseAsset } = await deps.symbolInfo.get(event.symbol));
  } catch (err) {
    deps.logger.error(
      { profileId: event.profileId, symbol: event.symbol, err: err },
      'fill-adopter: cannot resolve base asset to re-subscribe orphaned position; skipping',
    );
    return;
  }
  try {
    await scope.profileSymbols.upsert(event.symbol, baseAsset, { source: 'manual' });
  } catch (err) {
    if (err instanceof SymbolOwnershipConflictError || err instanceof SiblingQuoteConflictError) {
      // A sibling profile on this Binance account conflicts with the symbol's base
      // asset — either it already trades that base, or it settles in it (spends it
      // as a quote). Either way this profile must not re-subscribe (shared-wallet
      // exclusivity). The fill is already applied; surface the conflict loudly but
      // never fail the committed fill — re-subscription is a best-effort safety net.
      const conflictName = err.conflictProfileName;
      deps.logger.error(
        {
          profileId: event.profileId,
          symbol: event.symbol,
          orderId: event.orderId,
          sibling: conflictName,
        },
        'fill-adopter: cannot re-subscribe orphaned position — a sibling profile conflicts with this symbol',
      );
      await appendFillActionLog(
        deps,
        scope,
        event,
        `Could not re-subscribe ${event.symbol}: sibling profile "${conflictName}" conflicts with it on this account`,
        { action: 'orphan-resubscribe-conflict' },
      );
      return;
    }
    throw err;
  }
  deps.logger.warn(
    { profileId: event.profileId, symbol: event.symbol, orderId: event.orderId },
    'fill-adopter: re-subscribed orphaned symbol with a live position',
  );
  await appendFillActionLog(
    deps,
    scope,
    event,
    `Re-subscribed ${event.symbol} (recovered a position the bot was not tracking)`,
    { action: 'orphan-resubscribe' },
  );
};

/**
 * Enqueue the `archive-grid-trade` pipeline job for a just-closed cycle. The
 * `jobId` carries a per-fill timestamp so two distinct exits on the same
 * symbol each archive (a fixed id would coalesce them), while the handler's
 * own `latestArchivedAt` short-circuit makes a duplicate delivery idempotent.
 * Best-effort: a queue failure logs at warn and is swallowed so it never fails
 * the already-committed fill.
 */
const enqueueArchive = async (deps: FillAdopterDeps, event: FillEvent): Promise<void> => {
  try {
    await deps.pipelineQueue.add(
      'archive-grid-trade',
      {
        userId: event.operatorId,
        accountId: event.accountId,
        profileId: event.profileId,
        symbol: event.symbol,
      },
      { jobId: `archive-grid:${unwrapId(event.profileId)}:${event.symbol}:${Date.now()}` },
    );
  } catch (err) {
    deps.logger.warn(
      { profileId: event.profileId, symbol: event.symbol, err: err },
      'fill-adopter: archive-grid-trade enqueue failed (fill already applied)',
    );
  }
};

const applyResolution = async (
  deps: FillAdopterDeps,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  event: FillEvent,
  resolution: FillResolution,
  position: PositionStateAdapter,
): Promise<void> => {
  if (resolution.kind === 'noop') {
    deps.logger.warn(
      { profileId: event.profileId, symbol: event.symbol, orderId: event.orderId },
      `fill-adopter: ${resolution.reason}`,
    );
    return;
  }
  if (resolution.kind === 'clear') {
    // Full exit: the plugin flattens its own position body.
    await deps.statePort.mutate(scope, event.symbol, (state) =>
      position.applyFill(state, { kind: 'empty' }),
    );
    deps.logger.info(
      {
        profileId: event.profileId,
        symbol: event.symbol,
        orderId: event.orderId,
        side: resolution.side,
        outcome: 'position-emptied',
      },
      `fill-adopter: ${resolution.side} fill emptied position`,
    );
    await appendFillActionLog(deps, scope, event, `Closed ${event.symbol} position (sold out)`, {
      outcome: 'position-emptied',
    });
    // A SELL emptied the position, so the buy/sell cycle just closed. Enqueue
    // the archive job so the realised P/L lands in `trade_archive` without a
    // manual operator click. BUY can also reach `clear` (a stale pre-adopter
    // SELL replay folds through here), so gate on side to archive only on the
    // real exit.
    if (resolution.side === 'SELL') {
      await enqueueArchive(deps, event);
    }
    return;
  }
  // set: BUY writes entry price + qty (resetting the trailing high-water
  // mark); a partial SELL lowers held qty only. The plugin owns both
  // merges via its position capability.
  const fill: AdoptedFill =
    resolution.side === 'SELL'
      ? { kind: 'sell-reduce', heldQuantity: resolution.qty }
      : { kind: 'buy', avgEntryPrice: resolution.lbp, heldQuantity: resolution.qty };
  await deps.statePort.mutate(scope, event.symbol, (state) => position.applyFill(state, fill));
  // A live position remains (`set`), so the symbol must stay managed. Recover
  // the binding before logging so an orphaned position is never left untracked.
  await ensureSubscribedForPosition(deps, scope, event);
  if (resolution.side === 'BUY') {
    deps.logger.info(
      {
        profileId: event.profileId,
        symbol: event.symbol,
        orderId: event.orderId,
        side: 'BUY',
        lbp: resolution.lbp,
        qty: resolution.qty,
      },
      'fill-adopter: BUY fill applied',
    );
    await appendFillActionLog(deps, scope, event, `Bought ${event.symbol}`, {
      avgEntryPrice: resolution.lbp,
      heldQuantity: resolution.qty,
    });
  } else {
    deps.logger.info(
      {
        profileId: event.profileId,
        symbol: event.symbol,
        orderId: event.orderId,
        side: 'SELL',
        outcome: 'partial',
        remainingQty: resolution.qty,
      },
      'fill-adopter: SELL fill reduced held quantity',
    );
    await appendFillActionLog(deps, scope, event, `Sold part of ${event.symbol}`, {
      outcome: 'partial',
      remainingQuantity: resolution.qty,
    });
  }
};
