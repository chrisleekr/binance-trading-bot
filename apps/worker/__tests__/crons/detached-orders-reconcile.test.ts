// detached-orders-reconcile cron tests.
//
// Pure unit: every dep is injected, so this runs unconditionally (no Postgres, no
// Redis). The branches below are the ones that decide whether a real, still-resting
// order on Binance gets closed in our ledger — guessing a terminal status for an
// order that is actually live is how a position becomes invisible.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { BinanceApiError, type BinanceRestClient } from '@app/binance';

import {
  detachedOrdersReconcileHandler,
  type DetachedOrderRow,
  type DetachedOrdersReconcileDeps,
} from '../../src/crons/detached-orders-reconcile.cron.js';

const mkLogger = () =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const job = { id: 'job-1', data: {} } as unknown as Job;

const ACC_A = 'acc-a' as DetachedOrderRow['accountId'];
const ACC_B = 'acc-b' as DetachedOrderRow['accountId'];

const row = (over: Partial<DetachedOrderRow> = {}): DetachedOrderRow => ({
  binanceOrderId: 10n,
  accountId: ACC_A,
  operatorId: 'u1' as DetachedOrderRow['operatorId'],
  symbol: 'BTCUSDT',
  ...over,
});

const orderDto = (over: Record<string, unknown> = {}) =>
  ({
    symbol: 'BTCUSDT',
    orderId: 10,
    clientOrderId: 'c-10',
    side: 'BUY',
    type: 'LIMIT',
    price: '60000',
    origQty: '0.001',
    executedQty: '0.001',
    status: 'FILLED',
    stopPrice: '',
    time: 1,
    updateTime: 1_700_000_000_500,
    cummulativeQuoteQty: '60',
    ...over,
  }) as never;

const notExist = () =>
  new BinanceApiError(
    { status: 400, code: -2013, msg: 'Order does not exist.' } as never,
    false,
    'rejected',
  );

const mkDeps = (over: Partial<DetachedOrdersReconcileDeps> = {}): DetachedOrdersReconcileDeps => ({
  logger: mkLogger(),
  listLiveDetached: async () => [row()],
  resolveBinance: async () => ({ getOrder: vi.fn(async () => orderDto()) }),
  reconcileDetachedFill: vi.fn(async () => undefined),
  nowMs: () => 1_700_000_000_000,
  ...over,
});

describe('detachedOrdersReconcileHandler', () => {
  it('short-circuits before any Binance call when nothing is detached', async () => {
    const resolveBinance = vi.fn();
    await detachedOrdersReconcileHandler(
      mkDeps({ listLiveDetached: async () => [], resolveBinance }),
    )(job);
    expect(resolveBinance).not.toHaveBeenCalled();
  });

  it('settles a terminal order with the exchange’s own status and updateTime', async () => {
    const reconcileDetachedFill = vi.fn(async () => undefined);
    await detachedOrdersReconcileHandler(mkDeps({ reconcileDetachedFill }))(job);
    expect(reconcileDetachedFill).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 10,
        orderStatus: 'FILLED',
        cumQty: '0.001',
        cumQuoteQty: '60',
        // Binance's timestamp, not ours: the same row settled through the user-data
        // stream must land the same closed_at.
        eventTimeMs: 1_700_000_000_500,
      }),
    );
  });

  it('closes as CANCELED when Binance has never heard of the id (-2013)', async () => {
    // Not real money and never will be. Left open it counts toward the account's
    // exposure forever and holds the account delete hostage.
    const reconcileDetachedFill = vi.fn(async () => undefined);
    await detachedOrdersReconcileHandler(
      mkDeps({
        resolveBinance: async () => ({
          getOrder: vi.fn(async () => {
            throw notExist();
          }),
        }),
        reconcileDetachedFill,
      }),
    )(job);
    expect(reconcileDetachedFill).toHaveBeenCalledWith(
      expect.objectContaining({ orderStatus: 'CANCELED', cumQty: '0', cumQuoteQty: '0' }),
    );
  });

  it('leaves the row LIVE on any other getOrder failure — never guesses a terminal status', async () => {
    // A rate limit or a 5xx says nothing about the order. Closing it on a guess
    // would erase a real open commitment from the ledger.
    const reconcileDetachedFill = vi.fn(async () => undefined);
    const logger = mkLogger();
    await detachedOrdersReconcileHandler(
      mkDeps({
        logger,
        resolveBinance: async () => ({
          getOrder: vi.fn(async () => {
            throw new Error('429 too many requests');
          }),
        }),
        reconcileDetachedFill,
      }),
    )(job);
    expect(reconcileDetachedFill).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: expect.stringContaining('429') }),
      }),
      expect.stringContaining('leaving the row live'),
    );
  });

  it('skips a row whose account has no credentials left', async () => {
    const reconcileDetachedFill = vi.fn(async () => undefined);
    const logger = mkLogger();
    await detachedOrdersReconcileHandler(
      mkDeps({ resolveBinance: async () => null, reconcileDetachedFill, logger }),
    )(job);
    expect(reconcileDetachedFill).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('never reuses one account’s client for another account’s row', async () => {
    // The client cache is keyed by account precisely because a detached row can
    // only be settled with ITS OWN account's key pair — querying account B's order
    // with account A's credentials returns -2013 and would close a live order.
    const getOrderA = vi.fn<BinanceRestClient['getOrder']>(async () => orderDto({ orderId: 10 }));
    const getOrderB = vi.fn<BinanceRestClient['getOrder']>(async () => orderDto({ orderId: 20 }));
    const resolveBinance = vi.fn<DetachedOrdersReconcileDeps['resolveBinance']>(
      async (_operatorId, accountId) =>
        accountId === ACC_A ? { getOrder: getOrderA } : { getOrder: getOrderB },
    );
    await detachedOrdersReconcileHandler(
      mkDeps({
        listLiveDetached: async () => [
          row({ binanceOrderId: 10n, accountId: ACC_A }),
          row({ binanceOrderId: 11n, accountId: ACC_A }),
          row({ binanceOrderId: 20n, accountId: ACC_B, symbol: 'ETHUSDT' }),
        ],
        resolveBinance,
      }),
    )(job);
    // One resolve per DISTINCT account (the cache works)...
    expect(resolveBinance.mock.calls.map((c) => c[1])).toEqual([ACC_A, ACC_B]);
    // ...and each account's rows go to that account's client, never the other's.
    expect(getOrderA).toHaveBeenCalledTimes(2);
    expect(getOrderB).toHaveBeenCalledTimes(1);
    expect(getOrderB.mock.calls[0]?.[0]).toMatchObject({ symbol: 'ETHUSDT', orderId: 20 });
  });
});
