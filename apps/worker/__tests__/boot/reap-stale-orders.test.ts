import { describe, expect, it, vi } from 'vitest';
import { BinanceApiError, type OpenOrderDto } from '@app/binance';
import { profileRepo } from '@app/db';

import {
  reconcileMissingOrder,
  runStaleOrderReaper,
  selectReapTargets,
} from '../../src/boot/reap-stale-orders.js';

// The reaper resolves a ProfileScope through `profileRepo`, which performs a
// live ownership check. Stub it so `runStaleOrderReaper`'s loop / tally /
// per-symbol isolation can be exercised without a DB.
// The reaper reconciles by Binance order id, which is account-domain: it widens
// its proven profile scope and reads the ACCOUNT orders surface. Collapse both
// helpers so the stub `scope.orders` below is still what gets called.
const accountRepoFromScope = vi.fn();
vi.mock('@app/db', () => ({
  profileRepo: vi.fn(),
  toAccountScope: vi.fn((scope: unknown) => scope),
  accountRepoFromScope: (scope: unknown) => accountRepoFromScope(scope),
}));

const exch = (orderId: number): OpenOrderDto =>
  ({
    symbol: 'BTCUSDT',
    orderId,
    clientOrderId: `co-${orderId}`,
    side: 'BUY',
    type: 'LIMIT',
    price: '0',
    origQty: '0',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    timeInForce: 'GTC',
    stopPrice: '0',
    icebergQty: '0',
    time: 0,
    updateTime: 0,
    isWorking: true,
    workingTime: 0,
    origQuoteOrderQty: '0',
    selfTradePreventionMode: 'NONE',
  }) as unknown as OpenOrderDto;

describe('selectReapTargets', () => {
  it('returns empty when every local live row has a matching exchange entry', () => {
    const targets = selectReapTargets(
      [
        { binanceOrderId: 100n, status: 'NEW' },
        { binanceOrderId: 200n, status: 'PARTIALLY_FILLED' },
      ],
      [exch(100), exch(200)],
    );
    expect(targets).toEqual([]);
  });

  it('returns local rows whose binanceOrderId is missing on the exchange', () => {
    const targets = selectReapTargets(
      [
        { binanceOrderId: 100n, status: 'NEW' },
        { binanceOrderId: 200n, status: 'NEW' },
      ],
      [exch(100)],
    );
    expect(targets).toEqual([200n]);
  });

  it('refuses to reap a row whose status is already FILLED — fill-adopter will close it', () => {
    const targets = selectReapTargets(
      [
        { binanceOrderId: 100n, status: 'FILLED' },
        { binanceOrderId: 200n, status: 'NEW' },
      ],
      [exch(300)],
    );
    expect(targets).toEqual([200n]);
  });

  it('refuses to reap a row whose status is already CANCELED — defence against double-close', () => {
    const targets = selectReapTargets([{ binanceOrderId: 100n, status: 'CANCELED' }], []);
    expect(targets).toEqual([]);
  });

  it('preserves terminal Binance statuses (REJECTED / EXPIRED / EXPIRED_IN_MATCH / PENDING_CANCEL) — fill-adopter owns those closes', () => {
    const terminal = [
      { binanceOrderId: 1n, status: 'REJECTED' },
      { binanceOrderId: 2n, status: 'EXPIRED' },
      { binanceOrderId: 3n, status: 'EXPIRED_IN_MATCH' },
      { binanceOrderId: 4n, status: 'PENDING_CANCEL' },
    ];
    const targets = selectReapTargets(terminal, []);
    expect(targets).toEqual([]);
  });

  it('reaps every stale row when the exchange list is empty', () => {
    const targets = selectReapTargets(
      [
        { binanceOrderId: 1n, status: 'NEW' },
        { binanceOrderId: 2n, status: 'PARTIALLY_FILLED' },
      ],
      [],
    );
    expect(targets).toEqual([1n, 2n]);
  });

  it('handles BigInt and numeric Binance orderIds equivalently', () => {
    // BinanceOrderIds in OpenOrderDto are `number`; our local rows use
    // bigint. Equality must hold for ids that exceed 2^32.
    const big = 9_000_000_005n;
    const targets = selectReapTargets(
      [{ binanceOrderId: big, status: 'NEW' }],
      [exch(Number(big))],
    );
    expect(targets).toEqual([]);
  });
});

describe('reconcileMissingOrder', () => {
  const order = (over: Partial<OpenOrderDto>): OpenOrderDto =>
    ({ ...exch(123), ...over }) as OpenOrderDto;

  const setup = (
    getOrderImpl: () => Promise<OpenOrderDto>,
    {
      markFilledReturns = 1,
      reapReturns = 1,
    }: { markFilledReturns?: number; reapReturns?: number } = {},
  ) => {
    const markFilledByBinanceOrderId = vi.fn(async () => markFilledReturns);
    const reapWithReason = vi.fn(async () => reapReturns);
    const getOrder = vi.fn(getOrderImpl);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const deps = { logger };
    const orders = { markFilledByBinanceOrderId, reapWithReason };
    const scope = { scope: {}, orders };
    accountRepoFromScope.mockReturnValue({ orders });
    const rest = { getOrder };
    const target = {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'ICPUSDT',
      binanceOrderId: 3478655619n,
    };
    const run = () =>
      // The real signatures carry the full repo / client / branded-id types;
      // these mocks only implement the slice reconcileMissingOrder touches.
      reconcileMissingOrder(deps as never, scope as never, rest as never, target as never);
    return { run, markFilledByBinanceOrderId, reapWithReason, getOrder, logger };
  };

  it('reclaims a FILLED order to FILLED with truthful totals — never CANCELED', async () => {
    const { run, markFilledByBinanceOrderId, reapWithReason } = setup(async () =>
      order({
        status: 'FILLED',
        executedQty: '6.26000000',
        cummulativeQuoteQty: '15.13668000',
        updateTime: 1781415800274,
      }),
    );
    await expect(run()).resolves.toBe('reclaimed');
    expect(markFilledByBinanceOrderId).toHaveBeenCalledWith(
      3478655619n,
      { executedQty: '6.26000000', cummulativeQuoteQty: '15.13668000' },
      1781415800274,
    );
    expect(reapWithReason).not.toHaveBeenCalled();
  });

  it('reaps a CANCELED order with its real terminal status', async () => {
    const { run, markFilledByBinanceOrderId, reapWithReason } = setup(async () =>
      order({ status: 'CANCELED' }),
    );
    await expect(run()).resolves.toBe('reaped');
    expect(reapWithReason).toHaveBeenCalledWith(3478655619n, 'CANCELED', 'reaped-not-on-exchange');
    expect(markFilledByBinanceOrderId).not.toHaveBeenCalled();
  });

  it('reaps an EXPIRED order with the EXPIRED status, not a hardcoded CANCELED', async () => {
    const { run, reapWithReason } = setup(async () => order({ status: 'EXPIRED' }));
    await expect(run()).resolves.toBe('reaped');
    expect(reapWithReason).toHaveBeenCalledWith(3478655619n, 'EXPIRED', 'reaped-not-on-exchange');
  });

  it('reaps an EXPIRED_IN_MATCH order — the STP terminator is terminal here too', async () => {
    // Self-Trade Prevention is routine with N profiles on one wallet. The status
    // was terminal for the open-orders cache only, so the reaper skipped it and
    // the row stayed `closed_at`-NULL forever, holding the live slot for its
    // (profile, symbol, intent) and inflating open exposure.
    const { run, reapWithReason, markFilledByBinanceOrderId } = setup(async () =>
      order({ status: 'EXPIRED_IN_MATCH' }),
    );
    await expect(run()).resolves.toBe('reaped');
    expect(reapWithReason).toHaveBeenCalledWith(
      3478655619n,
      'EXPIRED_IN_MATCH',
      'reaped-not-on-exchange',
    );
    expect(markFilledByBinanceOrderId).not.toHaveBeenCalled();
  });

  it('reaps as CANCELED when getOrder reports the order never existed (-2013)', async () => {
    const { run, reapWithReason } = setup(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2013, msg: 'Order does not exist.' },
        false,
        'rejected',
      );
    });
    await expect(run()).resolves.toBe('reaped');
    expect(reapWithReason).toHaveBeenCalledWith(3478655619n, 'CANCELED', 'reaped-not-on-exchange');
  });

  it('leaves the row live on a transient getOrder failure — never stamps CANCELED on a flaky read', async () => {
    const { run, markFilledByBinanceOrderId, reapWithReason } = setup(async () => {
      throw new BinanceApiError(
        { status: 500, code: -1001, msg: 'Internal error.' },
        true,
        'ambiguous',
      );
    });
    await expect(run()).resolves.toBe('skipped');
    expect(markFilledByBinanceOrderId).not.toHaveBeenCalled();
    expect(reapWithReason).not.toHaveBeenCalled();
  });

  it('leaves the row live when getOrder still reports a non-terminal status', async () => {
    const { run, markFilledByBinanceOrderId, reapWithReason } = setup(async () =>
      order({ status: 'NEW' }),
    );
    await expect(run()).resolves.toBe('skipped');
    expect(markFilledByBinanceOrderId).not.toHaveBeenCalled();
    expect(reapWithReason).not.toHaveBeenCalled();
  });

  // A concurrent path may have already closed/reclaimed the row, so the repo
  // update touches zero rows. The outcome is 'skipped' and nothing is logged.
  it('skips (no log) when a FILLED reclaim updates zero rows (already reclaimed)', async () => {
    const { run, logger } = setup(async () => order({ status: 'FILLED' }), {
      markFilledReturns: 0,
    });
    await expect(run()).resolves.toBe('skipped');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips (no log) when a CANCELED reap updates zero rows (already closed)', async () => {
    const { run, logger } = setup(async () => order({ status: 'CANCELED' }), { reapReturns: 0 });
    await expect(run()).resolves.toBe('skipped');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips (no log) when a -2013 reap updates zero rows (already closed)', async () => {
    const { run, logger } = setup(
      async () => {
        throw new BinanceApiError(
          { status: 400, code: -2013, msg: 'Order does not exist.' },
          false,
          'rejected',
        );
      },
      { reapReturns: 0 },
    );
    await expect(run()).resolves.toBe('skipped');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('runStaleOrderReaper', () => {
  const liveRow = (binanceOrderId: bigint) => ({ binanceOrderId, status: 'NEW' });
  const dto = (status: string): OpenOrderDto =>
    ({
      symbol: 'X',
      orderId: 0,
      executedQty: '1.00000000',
      cummulativeQuoteQty: '2.00000000',
      updateTime: 1781415800274,
      status,
    }) as OpenOrderDto;

  // `listLiveForSymbol` is profile-scoped; the reconcile writes are account-scoped.
  // One `orders` object backs both surfaces so the assertions stay on one set of spies.
  const makeScope = () => {
    const orders = {
      listLiveForSymbol: vi.fn(async (symbol: string) =>
        symbol === 'AAA' ? [liveRow(111n)] : [liveRow(222n)],
      ),
      markFilledByBinanceOrderId: vi.fn(async () => 1),
      reapWithReason: vi.fn(async () => 1),
    };
    accountRepoFromScope.mockReturnValue({ orders });
    return { scope: {}, orders };
  };

  const deps = (over: {
    listActive: () => readonly unknown[];
    resolveBinance: () => Promise<unknown>;
  }) =>
    ({
      db: {},
      logger: { warn: vi.fn(), info: vi.fn() },
      listActive: over.listActive,
      resolveBinance: over.resolveBinance,
    }) as never;

  it('counts reclaimed vs reaped separately and never counts skipped', async () => {
    vi.mocked(profileRepo).mockResolvedValue(makeScope() as never);
    const getOpenOrders = vi.fn(async () => []);
    // AAA filled -> reclaim; BBB canceled -> reap.
    const getOrder = vi.fn(async ({ symbol }: { symbol: string }) =>
      dto(symbol === 'AAA' ? 'FILLED' : 'CANCELED'),
    );
    const tally = await runStaleOrderReaper(
      deps({
        listActive: () => [{ userId: 'u', profileId: 'p', symbols: ['AAA', 'BBB'] }],
        resolveBinance: async () => ({ getOpenOrders, getOrder }),
      }),
    );
    expect(tally).toEqual({ checked: 2, reaped: 1, reclaimed: 1, failed: 0 });
  });

  it('isolates a per-symbol REST failure — the sibling symbol still reconciles', async () => {
    vi.mocked(profileRepo).mockResolvedValue(makeScope() as never);
    const getOpenOrders = vi.fn(async (symbol: string) => {
      if (symbol === 'AAA') throw new Error('rest down');
      return [];
    });
    const getOrder = vi.fn(async () => dto('CANCELED'));
    const tally = await runStaleOrderReaper(
      deps({
        listActive: () => [{ userId: 'u', profileId: 'p', symbols: ['AAA', 'BBB'] }],
        resolveBinance: async () => ({ getOpenOrders, getOrder }),
      }),
    );
    expect(tally).toEqual({ checked: 2, reaped: 1, reclaimed: 0, failed: 1 });
  });

  it('skips the whole profile (failed += 1) when profileRepo ownership resolution throws', async () => {
    vi.mocked(profileRepo).mockRejectedValue(new Error('owner check failed'));
    const tally = await runStaleOrderReaper(
      deps({
        listActive: () => [{ userId: 'u', profileId: 'p', symbols: ['AAA'] }],
        resolveBinance: async () => ({ getOpenOrders: vi.fn(), getOrder: vi.fn() }),
      }),
    );
    expect(tally).toEqual({ checked: 0, reaped: 0, reclaimed: 0, failed: 1 });
  });
});
