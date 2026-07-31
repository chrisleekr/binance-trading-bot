// Pipeline `cancel-order` handler. The api posts an operator's cancel
// request as `{ userId, profileId, symbol, orderId }` where `orderId` is
// the local `orders.id` UUID. The Binance side is owned by the
// executor's `cancel-order` Decision handler; this module's job is to
// resolve UUID → binance_order_id, then drive the executor.

import type { Logger } from 'pino';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Database } from '@app/db';
import { profileRepo } from '@app/db';

import type { Clock } from '@app/strategy-core';
import type { LiveExecutor } from 'executor/live-executor.js';

export interface CancelOrderJobPayload {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly orderId: string;
}

export interface CancelOrderHandlerDeps {
  readonly db: Database;
  readonly executor: LiveExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
}

export const handleCancelOrder = async (
  deps: CancelOrderHandlerDeps,
  payload: CancelOrderJobPayload,
): Promise<void> => {
  const p = await profileRepo(deps.db, payload.userId, payload.accountId, payload.profileId);
  const row = await p.orders.findById(payload.orderId);
  if (!row) {
    // Missing row: either an already-cleaned-up cancel race or a stale
    // ui state. Warn and ack because retry would re-miss the same row.
    deps.logger.warn(
      { userId: payload.userId, profileId: payload.profileId, orderId: payload.orderId },
      'pipeline_cancel_order_row_missing',
    );
    return;
  }
  if (row.symbol !== payload.symbol) {
    // Defensive: payload.symbol is operator-supplied via the URL path.
    // A mismatch means UI bug or tenant cross-talk. Refuse rather than
    // cancel something on a different symbol than the operator clicked.
    deps.logger.warn(
      {
        userId: payload.userId,
        profileId: payload.profileId,
        orderId: payload.orderId,
        payloadSymbol: payload.symbol,
        rowSymbol: row.symbol,
      },
      'pipeline_cancel_order_symbol_mismatch',
    );
    return;
  }
  if (row.closedAt !== null) {
    // Already closed locally; nothing to cancel on Binance. Idempotent
    // ack so a duplicate enqueue from the api never throws.
    deps.logger.info(
      {
        userId: payload.userId,
        profileId: payload.profileId,
        orderId: payload.orderId,
        status: row.status,
      },
      'pipeline_cancel_order_already_closed',
    );
    return;
  }
  // Binance order IDs are unsigned 64-bit; the executor's persistence
  // boundary already rejects unsafe integers, but failing here gives a
  // cleaner stack and avoids partial Decision dispatch.
  const numericOrderId = Number(row.binanceOrderId);
  if (!Number.isSafeInteger(numericOrderId) || numericOrderId < 0) {
    throw new Error(
      `pipeline_cancel_order: binance_order_id ${row.binanceOrderId} exceeds safe integer range`,
    );
  }
  const result = await deps.executor.apply(
    {
      userId: payload.userId,
      profileId: payload.profileId,
      clock: deps.clock,
    },
    payload.accountId,
    {
      type: 'cancel-order',
      orderId: numericOrderId,
      reason: 'manual-cancel',
    },
  );
  if (result.ok === false) {
    // Non-ok results are already classified by the executor's handler.
    // Retryable failures throw so BullMQ's retry+DLQ pipeline kicks in;
    // non-retryable surfaces as a warn so the operator sees a clear
    // audit trail without a DLQ entry. A non-retryable failure is the
    // executor's verdict that retrying would re-fail (e.g. order
    // already gone from the local books), so silent-ack matches the
    // executor's intent here.
    if (result.retryable) {
      throw new Error(`pipeline_cancel_order: retryable failure: ${result.reason}`);
    }
    deps.logger.warn(
      {
        userId: payload.userId,
        profileId: payload.profileId,
        orderId: payload.orderId,
        reason: result.reason,
      },
      'pipeline_cancel_order_non_retryable',
    );
  }
};
