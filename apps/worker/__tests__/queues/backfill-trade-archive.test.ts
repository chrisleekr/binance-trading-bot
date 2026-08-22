// backfill-trade-archive handler: paginates myTrades, reconstructs round-trips,
// dedupes against already-backfilled trade ids, and inserts source='auto' rows
// pinned to the closing-fill time. Postgres is mocked via profileRepo; the
// Binance client and the Redis symbol-info snapshot are spies.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceRestClient, MyTradeDto } from '@app/binance';
import type { Database, ProfileRepo, RecoveryAttributionRow } from '@app/db';
import { coerceArchivedOrders, deriveExitIntent } from '@app/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { BackfillTradeArchiveHandlerDeps } from '../../src/queues/pipeline-handlers/backfill-trade-archive.js';

const { profileRepoSpy, binanceModeByIdSpy } = vi.hoisted(() => ({
  profileRepoSpy: vi.fn(),
  binanceModeByIdSpy: vi.fn(),
}));
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: profileRepoSpy,
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: binanceModeByIdSpy },
    },
  };
});

const { handleBackfillTradeArchive } =
  await import('../../src/queues/pipeline-handlers/backfill-trade-archive.js');
const { buildSymbolInfoKey } = await import('../../src/executor/redis-namespace.js');

const userId = 'u-1' as UserId;
const accountId = 'a-1' as AccountId;
const profileId = 'p-1' as ProfileId;

// Local "assert defined" to read mock call args without the non-null operator
// (project convention, avoids `!`).
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('expected a defined value');
  return v;
};

let seq = 0;
const trade = (o: {
  qty: string;
  quoteQty: string;
  isBuyer: boolean;
  time: number;
  id?: number;
  /** Defaults to the trade id; set explicitly to span several fills over one order. */
  orderId?: number;
}): MyTradeDto => {
  const id = o.id ?? ++seq;
  return {
    id,
    orderId: o.orderId ?? id,
    symbol: 'WLDUSDT',
    price: '0',
    qty: o.qty,
    quoteQty: o.quoteQty,
    commission: '0',
    commissionAsset: 'USDT',
    time: o.time,
    isBuyer: o.isBuyer,
    isMaker: false,
  };
};

type InsertInput = Parameters<ProfileRepo['tradeArchive']['insert']>[0];
type ListForSymbol = ProfileRepo['tradeArchive']['listForSymbol'];

const insert = vi.fn<(input: InsertInput) => Promise<{ id: string }>>(async () => ({ id: 'a-1' }));
const listForSymbol = vi.fn<(...args: Parameters<ListForSymbol>) => Promise<readonly unknown[]>>(
  async () => [],
);
const listRecoveryAttributionRows = vi.fn<ProfileRepo['orders']['listRecoveryAttributionRows']>(
  async () => [],
);
const terminalAttribution = (
  overrides: Partial<RecoveryAttributionRow> = {},
): RecoveryAttributionRow => ({
  binanceOrderId: 2n,
  intent: 'grid-sell',
  side: 'SELL',
  status: 'FILLED',
  closedAt: new Date('2026-08-20T00:00:00Z'),
  executedQty: '100',
  ...overrides,
});
const recordBackfillAttempt = vi.fn<ProfileRepo['tradeArchive']['recordBackfillAttempt']>(
  async () => undefined,
);
// Read before the myTrades walk, so the marker only claims the history this
// pass saw. Fixed here to keep the recorded value assertable.
const BOUNDARY = new Date('2026-08-01T00:00:00Z');
const attemptBoundary = vi.fn<ProfileRepo['tradeArchive']['attemptBoundary']>(async () => BOUNDARY);
const getMyTrades = vi.fn<BinanceRestClient['getMyTrades']>();

const makeDeps = (over?: {
  client?: unknown;
  symbolInfo?: string | null;
  primedKeys?: readonly string[];
}): BackfillTradeArchiveHandlerDeps & {
  redis: Redis & {
    get: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
  };
  logger: Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} => {
  const redis = {
    get: vi.fn(async () =>
      over?.symbolInfo === undefined
        ? JSON.stringify({ baseAsset: 'WLD', quoteAsset: 'USDT' })
        : over.symbolInfo,
    ),
    // Delisting is concluded from an ABSENT key only, so this must answer for
    // the real key rather than mirroring `get`: a present-but-corrupt value
    // takes the retry path instead of the terminating marker.
    exists: vi.fn(async () => (over?.symbolInfo === null ? 0 : 1)),
    // One full cursor pass, honouring the MATCH glob. The two modes' keyspaces
    // are disjoint ONLY by that glob, so a stub that ignores it would let a
    // cold TEST keyspace read as primed off LIVE keys — and stamp every
    // testnet symbol unavailable.
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return ['0', (over?.primedKeys ?? []).filter((k) => k.startsWith(prefix))];
    }),
  };
  const logger = {
    info: vi.fn((ctx: unknown, msg: unknown) => logs.push({ level: 'info', ctx, msg })),
    warn: vi.fn((ctx: unknown, msg: unknown) => logs.push({ level: 'warn', ctx, msg })),
    error: vi.fn(),
  };
  const resolveBinanceClient = vi.fn<BackfillTradeArchiveHandlerDeps['resolveBinanceClient']>(
    async () =>
      over?.client === undefined
        ? ({ getMyTrades } as unknown as BinanceRestClient)
        : (over.client as BinanceRestClient | null),
  );
  return {
    db: {} as Database,
    redis: redis as Redis & typeof redis,
    logger: logger as Logger & typeof logger,
    resolveBinanceClient,
  };
};

const payload = { userId, accountId, profileId, symbol: 'WLDUSDT', fromMs: null, toMs: null };

/** Pino calls recorded by `makeDeps`, so the attribution counters and the ambiguity warn are assertable rather than write-only. */
const logs: { level: string; ctx: unknown; msg: unknown }[] = [];

beforeEach(() => {
  seq = 0;
  logs.length = 0;
  insert.mockClear();
  listForSymbol.mockClear();
  listRecoveryAttributionRows.mockClear();
  recordBackfillAttempt.mockClear();
  attemptBoundary.mockClear();
  getMyTrades.mockReset();
  profileRepoSpy.mockReset();
  profileRepoSpy.mockResolvedValue({
    orders: { listRecoveryAttributionRows },
    tradeArchive: { insert, listForSymbol, recordBackfillAttempt, attemptBoundary },
  });
  binanceModeByIdSpy.mockReset();
  binanceModeByIdSpy.mockResolvedValue('live');
});

describe('handleBackfillTradeArchive', () => {
  it('inserts a source=auto row pinned to the closing-fill time', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    await handleBackfillTradeArchive(makeDeps(), payload);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = must(insert.mock.calls[0])[0];
    expect(row.source).toBe('auto');
    expect(row.baseAsset).toBe('WLD');
    expect(row.quoteAsset).toBe('USDT');
    expect(row.profit).toBe('10');
    expect((row.archivedAt as Date).getTime()).toBe(2000);
    // The attempt is marked so the recover-vs-note split knows it was checked,
    // and stamped with the pre-fetch boundary rather than the write time: a
    // fill adopted while `myTrades` was being walked is absent from this pass,
    // so a later stamp would claim history the pass never saw and the symbol
    // would never be swept again.
    expect(recordBackfillAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'WLDUSDT', roundTrips: 1, attemptedAt: BOUNDARY }),
    );
    expect(must(attemptBoundary.mock.invocationCallOrder[0])).toBeLessThan(
      must(getMyTrades.mock.invocationCallOrder[0]),
    );
  });

  it('restores a closing SELL intent from one exact local terminal order', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution({ executedQty: '100.00000000' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const row = must(insert.mock.calls[0])[0];
    const orders = row.orders as {
      readonly binanceOrderId: string;
      readonly intent: string;
      readonly side: 'BUY' | 'SELL';
    }[];
    const closingSell = orders.find(
      (order) => order.side === 'SELL' && order.binanceOrderId === '2',
    );
    expect(must(closingSell).intent).toBe('grid-sell');
  });

  it.each([null, 'malformed', '0', '-100', '99'])(
    'keeps backfill when the local executed quantity is %s',
    async (executedQty) => {
      getMyTrades.mockResolvedValueOnce([
        trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
        trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
      ]);
      listRecoveryAttributionRows.mockResolvedValueOnce([terminalAttribution({ executedQty })]);

      await handleBackfillTradeArchive(makeDeps(), payload);

      const row = must(insert.mock.calls[0])[0] as {
        orders: { readonly binanceOrderId: string; readonly intent: string }[];
      };
      expect(row.orders.find((order) => order.binanceOrderId === '2')?.intent).toBe('backfill');
    },
  );

  it.each([
    ['no candidate', []],
    ['wrong order id', [terminalAttribution({ binanceOrderId: 3n })]],
    [
      'ambiguous order id',
      [terminalAttribution(), terminalAttribution({ intent: 'protective-stop' })],
    ],
    ['blank intent', [terminalAttribution({ intent: ' ' })]],
  ] as const)('keeps backfill with %s', async (_name, candidates) => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([...candidates]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const row = must(insert.mock.calls[0])[0] as {
      orders: { readonly binanceOrderId: string; readonly intent: string }[];
    };
    expect(row.orders.find((order) => order.binanceOrderId === '2')?.intent).toBe('backfill');
  });

  it.each([
    ['a BUY identity', terminalAttribution({ side: 'BUY' })],
    ['a non-FILLED identity', terminalAttribution({ status: 'CANCELED' })],
    ['an open identity', terminalAttribution({ closedAt: null })],
  ] as const)('keeps backfill with %s', async (_name, candidate) => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([candidate]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const row = must(insert.mock.calls[0])[0] as {
      orders: { readonly binanceOrderId: string; readonly intent: string }[];
    };
    expect(row.orders.find((order) => order.binanceOrderId === '2')?.intent).toBe('backfill');
  });

  it('keeps backfill when an eligible row shares its identity with a canceled row', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution(),
      terminalAttribution({ intent: 'canceled-exit', status: 'CANCELED' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const row = must(insert.mock.calls[0])[0] as {
      orders: { readonly binanceOrderId: string; readonly intent: string }[];
    };
    expect(row.orders.find((order) => order.binanceOrderId === '2')?.intent).toBe('backfill');
  });

  it('preserves an untracked intent and changes only the closing SELL', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution({ intent: 'grid-sell:untracked:2' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const row = must(insert.mock.calls[0])[0] as {
      orders: { readonly binanceOrderId: string; readonly intent: string }[];
    };
    expect(row.orders).toEqual([
      expect.objectContaining({ binanceOrderId: '1', intent: 'backfill' }),
      expect.objectContaining({ binanceOrderId: '2', intent: 'grid-sell:untracked:2' }),
    ]);
  });

  it('loads attribution candidates once for every missing cycle in the batch', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
      trade({ id: 3, qty: '50', quoteQty: '25', isBuyer: true, time: 3000 }),
      trade({ id: 4, qty: '50', quoteQty: '30', isBuyer: false, time: 4000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution(),
      terminalAttribution({ binanceOrderId: 4n, intent: 'protective-stop', executedQty: '50' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    expect(listRecoveryAttributionRows).toHaveBeenCalledOnce();
    expect(listRecoveryAttributionRows).toHaveBeenCalledWith('WLDUSDT', [2n, 4n]);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('the restored intent survives deriveExitIntent when the closing order sits mid-array', async () => {
    // The joint contract. The handler emits Map-insertion order keyed on each order's FIRST fill, so a SELL that partially fills, yields to a second SELL, then flattens the position lands BEFORE that second SELL. Asserting on array position would pass while the operator still saw "unknown".
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, orderId: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, orderId: 2, qty: '40', quoteQty: '24', isBuyer: false, time: 2000 }),
      trade({ id: 3, orderId: 3, qty: '30', quoteQty: '18', isBuyer: false, time: 3000 }),
      trade({ id: 4, orderId: 2, qty: '30', quoteQty: '19', isBuyer: false, time: 4000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution({ binanceOrderId: 2n, intent: 'protective-stop', executedQty: '70' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const row = must(insert.mock.calls[0])[0] as { orders: unknown };
    expect(deriveExitIntent(coerceArchivedOrders(row.orders))).toBe('protective-stop');
  });

  it('drops a malformed closing order id instead of killing the job', async () => {
    // `orderId` reaches here from an unvalidated myTrades response, and BigInt() throws on anything that is not an integer literal. The job has already walked the entire history by this point, so a throw would re-walk it on every retry before dead-lettering.
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({
        id: 2,
        orderId: 1.5 as unknown as number,
        qty: '100',
        quoteQty: '60',
        isBuyer: false,
        time: 2000,
      }),
    ]);

    await expect(handleBackfillTradeArchive(makeDeps(), payload)).resolves.toBeUndefined();
    expect(listRecoveryAttributionRows).toHaveBeenCalledWith('WLDUSDT', []);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('reports per-outcome attribution counts and warns on an ambiguous identity', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution(),
      terminalAttribution({ intent: 'protective-stop' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const ok = must(logs.find((l) => l.msg === 'pipeline_backfill_trade_archive_ok')).ctx as {
      exitsAttributed: number;
      exitsUnattributed: Record<string, number>;
    };
    expect(ok.exitsAttributed).toBe(0);
    expect(ok.exitsUnattributed).toEqual({
      noCandidate: 0,
      ambiguousIdentity: 1,
      notTerminalSell: 0,
      blankIntent: 0,
      quantityUnproven: 0,
    });
    expect(
      logs.filter((l) => l.msg === 'pipeline_backfill_trade_archive_ambiguous_exit_identity'),
    ).toHaveLength(1);
  });

  it('counts a proven restoration under exitsAttributed', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listRecoveryAttributionRows.mockResolvedValueOnce([
      terminalAttribution({ executedQty: '100.00000000' }),
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    const ok = must(logs.find((l) => l.msg === 'pipeline_backfill_trade_archive_ok')).ctx as {
      exitsAttributed: number;
    };
    expect(ok.exitsAttributed).toBe(1);
  });

  it('skips a round-trip whose closing trade id is already backfilled (re-run no-op)', async () => {
    const fills = [
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ];
    getMyTrades.mockResolvedValueOnce(fills);
    // Existing rows include malformed shapes (null orders, an order with no
    // tradeIds) alongside the matching row; the dedup must tolerate them and
    // still skip on the matching closing trade id.
    listForSymbol.mockResolvedValueOnce([
      { orders: null },
      { orders: [{}] },
      { orders: [{ tradeIds: [1, 2] }] },
    ]);
    await handleBackfillTradeArchive(makeDeps(), payload);
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns early with a no_trades log when myTrades is empty', async () => {
    getMyTrades.mockResolvedValueOnce([]);
    const deps = makeDeps();
    await handleBackfillTradeArchive(deps, payload);
    expect(insert).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.anything(),
      'pipeline_backfill_trade_archive_no_trades',
    );
    // Marked as attempted-empty so the coin moves to the note, not the nudge.
    expect(recordBackfillAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'WLDUSDT', roundTrips: 0 }),
    );
  });

  it('warns with the uncosted-base counts when a cycle is dropped, still inserting the clean cycle', async () => {
    // A leading orphan SELL (no open position) plus a clean buy→sell cycle.
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '5', quoteQty: '3', isBuyer: false, time: 500 }),
      trade({ id: 2, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 3, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    const deps = makeDeps();
    await handleBackfillTradeArchive(deps, payload);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skippedOrphanSells: 1, droppedOvershootCycles: 0 }),
      'pipeline_backfill_trade_archive_uncosted_base',
    );
  });

  it('filters out round-trips whose closing fill is outside the window', async () => {
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 5000 }),
    ]);
    const deps = makeDeps();
    await handleBackfillTradeArchive(deps, { ...payload, fromMs: 1, toMs: 4000 });
    expect(insert).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.anything(),
      'pipeline_backfill_trade_archive_nothing_in_window',
    );
    expect(recordBackfillAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'WLDUSDT', roundTrips: 0 }),
    );
  });

  it('warns and inserts nothing when no Binance client resolves', async () => {
    const deps = makeDeps({ client: null });
    await handleBackfillTradeArchive(deps, payload);
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // No client = could not attempt; nothing recorded (a retry may yet succeed).
    expect(recordBackfillAttempt).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'pipeline_backfill_trade_archive_no_client',
    );
  });

  it('throws on a cold symbol-info cache so BullMQ retries', async () => {
    // Keyspace empty: the refresh cron has not populated it, so the missing key
    // proves nothing about the symbol and the job must be retried.
    await expect(
      handleBackfillTradeArchive(makeDeps({ symbolInfo: null }), payload),
    ).rejects.toThrow(/symbol-info missing/);
    expect(insert).not.toHaveBeenCalled();
    expect(recordBackfillAttempt).not.toHaveBeenCalled();
  });

  it('terminates instead of looping when the keyspace is primed and the symbol is gone', async () => {
    // Sibling keys exist, so the refresh cron ran and deliberately dropped this
    // one: a delisted coin would otherwise throw every 15 minutes forever.
    const deps = makeDeps({
      symbolInfo: null,
      primedKeys: [buildSymbolInfoKey('BTCUSDT', 'live')],
    });
    await expect(handleBackfillTradeArchive(deps, payload)).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(recordBackfillAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'WLDUSDT', roundTrips: 0, symbolUnavailable: true }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'pipeline_backfill_trade_archive_symbol_unlisted',
    );
  });

  it('throws instead of stamping symbol-unavailable when the cached value is corrupt', async () => {
    // The key EXISTS, so the symbol is listed — the value is just unreadable,
    // which the next exchange-info refresh repairs. Writing the terminating
    // marker here would strand the coin: a marker only re-opens when a LATER
    // fill makes it stale, and nothing re-reads a repaired value.
    const deps = makeDeps({
      symbolInfo: 'not-json',
      primedKeys: [buildSymbolInfoKey('BTCUSDT', 'live')],
    });
    await expect(handleBackfillTradeArchive(deps, payload)).rejects.toThrow(/symbol-info missing/);
    expect(recordBackfillAttempt).not.toHaveBeenCalled();
    expect(getMyTrades).not.toHaveBeenCalled();
  });

  it('scopes the primed-keyspace probe to the account mode, so a cold test keyspace retries', async () => {
    // Live keys primed, test keys cold. The two keyspaces differ only by their
    // glob, so a probe that scanned the live pattern would read "primed" and
    // stamp every recoverable testnet symbol unavailable.
    binanceModeByIdSpy.mockResolvedValueOnce('test');
    const deps = makeDeps({
      symbolInfo: null,
      primedKeys: [buildSymbolInfoKey('BTCUSDT', 'live')],
    });
    await expect(handleBackfillTradeArchive(deps, payload)).rejects.toThrow(/symbol-info missing/);
    expect(recordBackfillAttempt).not.toHaveBeenCalled();
    expect(deps.redis.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      buildSymbolInfoKey('*', 'test'),
      'COUNT',
      500,
    );
  });

  it('records the CUMULATIVE round-trip count when a re-sweep inserts nothing', async () => {
    // A re-sweep of an already-recovered coin dedupes every cycle by design.
    // Recording this pass's zero would make the coin claim it has no
    // reconstructable history while its cycles sit archived, and re-walk its
    // whole myTrades on every later staleness.
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listForSymbol.mockResolvedValueOnce([{ orders: [{ tradeIds: [1, 2] }] }]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    expect(insert).not.toHaveBeenCalled();
    expect(recordBackfillAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'WLDUSDT', roundTrips: 1 }),
    );
  });

  it('skips a round-trip whose orders were already archived live (no tradeIds recorded)', async () => {
    // The live archive path stores binanceOrderId but not tradeIds, so the
    // trade-id set alone cannot see it — without the order-id check the sweep
    // would re-insert the same cycle under a different cycle_end.
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ]);
    listForSymbol.mockResolvedValueOnce([
      { orders: [{ binanceOrderId: '1' }, { binanceOrderId: '2' }] },
    ]);
    await handleBackfillTradeArchive(makeDeps(), payload);
    expect(insert).not.toHaveBeenCalled();
  });

  it('still archives a later cycle that shares a straddling BUY order with an archived one', async () => {
    // Order 10 fills either side of a flat-out, so it belongs to both cycles.
    // Matching any shared order would read cycle 2 as a duplicate and drop a
    // real closed cycle — the exact silent loss this backstop exists to stop.
    getMyTrades.mockResolvedValueOnce([
      trade({ id: 1, orderId: 10, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, orderId: 20, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
      trade({ id: 3, orderId: 10, qty: '100', quoteQty: '55', isBuyer: true, time: 3000 }),
      trade({ id: 4, orderId: 30, qty: '100', quoteQty: '70', isBuyer: false, time: 4000 }),
    ]);
    listForSymbol.mockResolvedValueOnce([
      { orders: [{ binanceOrderId: '10' }, { binanceOrderId: '20' }] },
    ]);

    await handleBackfillTradeArchive(makeDeps(), payload);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ profit: '15' }));
  });

  it('paginates myTrades until a short page is returned', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) =>
      trade({ id: i + 1, qty: '1', quoteQty: '1', isBuyer: true, time: i + 1 }),
    );
    getMyTrades.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([]);
    await handleBackfillTradeArchive(makeDeps(), payload);
    expect(getMyTrades).toHaveBeenCalledTimes(2);
    expect(getMyTrades).toHaveBeenNthCalledWith(1, { symbol: 'WLDUSDT', fromId: 0, limit: 1000 });
    expect(getMyTrades).toHaveBeenNthCalledWith(2, {
      symbol: 'WLDUSDT',
      fromId: 1001,
      limit: 1000,
    });
  });

  it('reads the testnet symbol-info keyspace for a test-mode profile (#582)', async () => {
    binanceModeByIdSpy.mockResolvedValueOnce('test');
    getMyTrades.mockResolvedValueOnce([]); // empty history → returns after the symbol-info read
    const deps = makeDeps();
    await handleBackfillTradeArchive(deps, payload);
    expect(deps.redis.get).toHaveBeenCalledWith(buildSymbolInfoKey('WLDUSDT', 'test'));
    expect(deps.redis.get).not.toHaveBeenCalledWith(buildSymbolInfoKey('WLDUSDT', 'live'));
  });
});
