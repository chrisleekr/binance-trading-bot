// Which statuses close a DETACHED order's ledger row.
//
// `reconcileDetachedFill` is the only thing that ever stamps `closed_at` on an order whose profile was deleted. A status it does not recognise as terminal leaves the row open forever: it keeps its `orders_one_live_per_intent` live slot and keeps counting toward the account's open exposure, which backs the delete-account guard. So the set of statuses it accepts is a contract, and it must be the SHARED one — the same predicate the open-orders cache eviction and the boot reaper read. `EXPIRED_IN_MATCH` is the status that proves it: Binance stamps it when self-trade prevention kills an order, which on a shared account wallet is exactly what a sibling profile's BUY crossing our resting SELL produces.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { Queue } from 'bullmq';

import { asAccountId, asUserId } from '@app/contracts';

import { createFillAdopter, type DetachedOrderEvent } from '../../src/executor/fill-adopter.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import type { StatePort } from '../../src/state/state-port.js';
import type { SymbolInfoCache } from '../../src/tick/symbol-info-cache.js';

const OPERATOR_ID = asUserId('00000000-0000-0000-0000-0000000705a1');
const ACCOUNT_ID = asAccountId('00000000-0000-0000-0000-0000000705c1');
const SYMBOL = 'XPLUSDT';
// Above 2^32 so a lossy number/bigint hop surfaces as a miss rather than a pass.
const ORDER_ID = 8_700_000_705;

const repoMocks = vi.hoisted(() => ({
  ordersFindByBinanceOrderId: vi.fn(),
  ordersCloseByBinanceOrderId: vi.fn(async () => 1),
  ordersMarkFilledByBinanceOrderId: vi.fn(async () => 1),
}));

const accountScope = { db: undefined as unknown, operatorId: OPERATOR_ID, accountId: ACCOUNT_ID };

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    scopeAccount: vi.fn(async () => accountScope),
    accountRepoFromScope: vi.fn(() => ({
      orders: {
        findByBinanceOrderId: repoMocks.ordersFindByBinanceOrderId,
        closeByBinanceOrderId: repoMocks.ordersCloseByBinanceOrderId,
        markFilledByBinanceOrderId: repoMocks.ordersMarkFilledByBinanceOrderId,
      },
    })),
  };
});

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

/**
 * The production adopter with its position-side deps rigged to THROW. The detached path is the ledger half of adoption with the strategy half deliberately absent, so a regression that starts seeding cost basis or strategy state here fails loudly instead of quietly handing a deleted profile's position to a stranger.
 */
const makeAdopter = () =>
  createFillAdopter({
    db: {} as never,
    chain: createChainByKey(),
    logger: noopLogger,
    statePort: {
      mutate: () => {
        throw new Error('detached reconcile must not touch strategy state');
      },
    } as unknown as StatePort,
    registry: {
      get: () => {
        throw new Error('detached reconcile must not resolve a strategy');
      },
    },
    pipelineQueue: {
      add: () => {
        throw new Error('detached reconcile must not enqueue an archive');
      },
    } as unknown as Queue,
    symbolInfo: {
      get: () => {
        throw new Error('detached reconcile must not read symbol info');
      },
    } as unknown as SymbolInfoCache,
  });

const eventWith = (orderStatus: string): DetachedOrderEvent => ({
  operatorId: OPERATOR_ID,
  accountId: ACCOUNT_ID,
  symbol: SYMBOL,
  orderId: ORDER_ID,
  orderStatus,
  cumQty: '0',
  cumQuoteQty: '0',
  eventTimeMs: 1_735_000_000_000,
});

describe('reconcileDetachedFill — terminal-status vocabulary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A detached row: present, and `profileId` null is what makes it ours to close.
    repoMocks.ordersFindByBinanceOrderId.mockResolvedValue({ profileId: null });
    repoMocks.ordersCloseByBinanceOrderId.mockResolvedValue(1);
    repoMocks.ordersMarkFilledByBinanceOrderId.mockResolvedValue(1);
  });

  it('closes the row on EXPIRED_IN_MATCH, the self-trade-prevention terminator', async () => {
    await makeAdopter().reconcileDetachedFill(eventWith('EXPIRED_IN_MATCH'));

    expect(repoMocks.ordersCloseByBinanceOrderId).toHaveBeenCalledTimes(1);
    expect(repoMocks.ordersCloseByBinanceOrderId).toHaveBeenCalledWith(
      BigInt(ORDER_ID),
      'EXPIRED_IN_MATCH',
      1_735_000_000_000,
    );
    // The exchange's own status is what lands on the row, so the ledger records WHY the order left the book.
    expect(repoMocks.ordersMarkFilledByBinanceOrderId).not.toHaveBeenCalled();
  });

  it.each(['CANCELED', 'EXPIRED', 'REJECTED'])('closes the row on %s', async (status) => {
    await makeAdopter().reconcileDetachedFill(eventWith(status));

    expect(repoMocks.ordersCloseByBinanceOrderId).toHaveBeenCalledTimes(1);
    expect(repoMocks.ordersCloseByBinanceOrderId).toHaveBeenCalledWith(
      BigInt(ORDER_ID),
      status,
      1_735_000_000_000,
    );
  });

  it('routes FILLED to the totals-merging close, not the plain one', async () => {
    await makeAdopter().reconcileDetachedFill({
      ...eventWith('FILLED'),
      cumQty: '12',
      cumQuoteQty: '340',
    });

    expect(repoMocks.ordersMarkFilledByBinanceOrderId).toHaveBeenCalledTimes(1);
    expect(repoMocks.ordersMarkFilledByBinanceOrderId).toHaveBeenCalledWith(
      BigInt(ORDER_ID),
      { executedQty: '12', cummulativeQuoteQty: '340' },
      1_735_000_000_000,
    );
    expect(repoMocks.ordersCloseByBinanceOrderId).not.toHaveBeenCalled();
  });

  // The terminal gate case-folds and the FILLED routing test does not, so an off-case spelling used to pass the first and fail the second, taking the plain close: terminal, but with the execution totals never merged. Binance sends these upper, so this pins the two comparisons to one reading rather than a bug anyone has seen.
  it.each(['filled', 'Filled'])('routes %s the same way as FILLED, totals and all', async (raw) => {
    await makeAdopter().reconcileDetachedFill({
      ...eventWith(raw),
      cumQty: '12',
      cumQuoteQty: '340',
    });

    expect(repoMocks.ordersMarkFilledByBinanceOrderId).toHaveBeenCalledWith(
      BigInt(ORDER_ID),
      { executedQty: '12', cummulativeQuoteQty: '340' },
      1_735_000_000_000,
    );
    expect(repoMocks.ordersCloseByBinanceOrderId).not.toHaveBeenCalled();
  });

  it('still writes the exchange’s own spelling to the row it plainly closes', async () => {
    // The fold decides the ROUTE, never what is recorded: a row stamped `CANCELED` when Binance said `canceled` would misquote the exchange in the one place the operator goes to find out why the order left the book.
    await makeAdopter().reconcileDetachedFill(eventWith('canceled'));

    expect(repoMocks.ordersCloseByBinanceOrderId).toHaveBeenCalledWith(
      BigInt(ORDER_ID),
      'canceled',
      1_735_000_000_000,
    );
  });

  it.each(['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL', 'SOME_STATUS_BINANCE_ADDS_TOMORROW'])(
    'leaves the row open on %s — a still-live commitment SHOULD keep counting toward exposure',
    async (status) => {
      await makeAdopter().reconcileDetachedFill(eventWith(status));

      expect(repoMocks.ordersFindByBinanceOrderId).not.toHaveBeenCalled();
      expect(repoMocks.ordersCloseByBinanceOrderId).not.toHaveBeenCalled();
      expect(repoMocks.ordersMarkFilledByBinanceOrderId).not.toHaveBeenCalled();
    },
  );

  it('refuses to close a row that still has a profile, whatever the status says', async () => {
    repoMocks.ordersFindByBinanceOrderId.mockResolvedValue({ profileId: 'still-owned' });

    await makeAdopter().reconcileDetachedFill(eventWith('EXPIRED_IN_MATCH'));

    expect(repoMocks.ordersCloseByBinanceOrderId).not.toHaveBeenCalled();
  });
});
