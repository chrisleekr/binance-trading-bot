// Pipeline `reset-grid-trade` handler. Abandons a profile's grid cycle
// for `symbol`: cancels any open BUY orders that would re-enter the
// abandoned cycle, then clears the strategy's per-cycle state. The state
// clear runs through the strategy's position capability
// (`clearPosition({ resetGridIndex: true })`) so this handler never names a
// concrete strategy field (core invariant #1). A strategy that does not
// declare the `reset-grid` operator action has no grid cycle to abandon, so
// only the generic order/ledger cleanup runs.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Database } from '@app/db';
import { profileRepo } from '@app/db';
import type { Clock, StrategyRegistry } from '@app/strategy-core';

import type { LiveExecutor } from 'executor/live-executor.js';
import type { StatePort } from 'state/state-port.js';

export interface ResetGridTradeJobPayload {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
}

export interface ResetGridTradeHandlerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly executor: LiveExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Resolves the profile's strategy so the reset can clear the grid cycle
   * through its position capability (`clearPosition`) instead of naming the
   * strategy's state fields here, and so the gate reads the strategy's
   * `reset-grid` operator-action capability.
   */
  readonly strategies: StrategyRegistry;
  /**
   * The per-(profile, symbol) state boundary the tick reads and commits. The
   * grid reset routes through it so the cleared body lands in `symbol_states`
   * (what the next tick loads), not the dead pre-#267 `profiles.state` store.
   */
  readonly statePort: StatePort;
}

export const handleResetGridTrade = async (
  deps: ResetGridTradeHandlerDeps,
  payload: ResetGridTradeJobPayload,
): Promise<void> => {
  // Cancel open BUY orders first so the executor can't race the state
  // wipe with a fresh fill from a previously-placed but un-filled grid
  // BUY. Each cancel goes through the executor so Binance + DB + Redis
  // open-orders namespace stay consistent with the standard cancel
  // path.
  const p = await profileRepo(deps.db, payload.userId, payload.accountId, payload.profileId);
  const liveOrders = await p.orders.listLiveForSymbol(payload.symbol);
  const openGridBuys = liveOrders.filter((row) => row.side === 'BUY' && row.intent === 'grid-buy');
  for (const row of openGridBuys) {
    const numericOrderId = Number(row.binanceOrderId);
    if (!Number.isSafeInteger(numericOrderId) || numericOrderId < 0) {
      // Same precision guard as the cancel-order handler; an unsafe id
      // here means the executor would silently miss the row, leaving
      // the order live on Binance after we wipe local state.
      throw new Error(
        `pipeline_reset_grid_trade: binance_order_id ${row.binanceOrderId} exceeds safe integer range`,
      );
    }
    const result = await deps.executor.apply(
      { userId: payload.userId, profileId: payload.profileId, clock: deps.clock },
      payload.accountId,
      { type: 'cancel-order', orderId: numericOrderId, reason: 'reset-grid-trade' },
    );
    if (result.ok === false) {
      // The cancel-first invariant is load-bearing: clearing local
      // state while a grid-buy is still live on Binance would let a
      // subsequent fill resurrect the abandoned cycle with no local
      // record of it. Throw on BOTH retryable and non-retryable
      // failures. BullMQ retries the retryable case; the non-
      // retryable case stays on DLQ until an operator investigates,
      // which is the right outcome since the cancel won't succeed
      // without intervention anyway.
      deps.logger.warn(
        {
          userId: payload.userId,
          profileId: payload.profileId,
          symbol: payload.symbol,
          orderId: numericOrderId,
          retryable: result.retryable,
          reason: result.reason,
        },
        'pipeline_reset_grid_trade_cancel_failed',
      );
      throw new Error(
        `pipeline_reset_grid_trade: cancel failed for orderId=${numericOrderId} (retryable=${result.retryable}): ${result.reason}`,
      );
    }
  }

  // Wipe the per-symbol avg-entry-price row. The strategy state's entry
  // price is the source of truth for the tick handler, but this row drives
  // the API status display so they must agree.
  await p.avgEntryPrices.remove(payload.symbol);

  // Resolve the strategy's grid-reset capability. A strategy that doesn't
  // run an abandonable grid cycle (or an unknown strategyName from api/
  // worker config drift) has no per-cycle state to clear — the generic
  // cancel + avg-entry-price cleanup above is the whole reset for it.
  const profileRow = await p.profile.findById();
  if (!profileRow) {
    deps.logger.warn(
      { userId: payload.userId, profileId: payload.profileId, symbol: payload.symbol },
      'pipeline_reset_grid_trade_profile_missing',
    );
    return;
  }
  // Gate on the same authoritative capability the API enforces
  // (`capabilities.operatorActions` includes `reset-grid`) rather than a
  // dedicated state-adapter slot, so the worker and API cannot drift on which
  // strategies support a grid reset. The position capability is what actually
  // clears the per-cycle fields; a strategy missing either has no grid cycle
  // to abandon, so only the generic order/ledger cleanup above ran.
  const strategy = deps.strategies.get(profileRow.strategyName);
  if (!strategy?.position || !strategy.capabilities.operatorActions.includes('reset-grid')) {
    deps.logger.info(
      {
        userId: payload.userId,
        profileId: payload.profileId,
        symbol: payload.symbol,
        strategyName: profileRow.strategyName,
        cancelledOrders: openGridBuys.length,
      },
      'pipeline_reset_grid_trade_no_grid_capability',
    );
    return;
  }
  const position = strategy.position;

  // Clear the strategy's grid-cycle state through the same per-(profile,
  // symbol) StatePort the tick reads and commits, so the next tick loads the
  // reset row. This handler runs under the shared chainByKey lock for
  // `${profileId}:${symbol}` (see pipeline-worker), satisfying the port's
  // serialisation contract. `mutate` reconciles + migrates the symbol_states
  // body before applying the reset, so `clearPosition` runs on a
  // current-schema body and returns the cleared body (idempotent on BullMQ
  // retry); `mutate` then writes it two-column and refreshes the cache. The
  // dead pre-#267 profiles.state store the tick never read is gone.
  await deps.statePort.mutate(p, payload.symbol, (state) =>
    position.clearPosition(state, { resetGridIndex: true }),
  );

  deps.logger.info(
    {
      userId: payload.userId,
      profileId: payload.profileId,
      symbol: payload.symbol,
      cancelledOrders: openGridBuys.length,
    },
    'pipeline_reset_grid_trade_ok',
  );
};
