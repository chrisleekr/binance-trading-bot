// Lock the persistence boundary: each helper must call the matching
// scoped repo method on the bound `ProfileRepo`, then map the input
// row's fields without dropping or renaming anything the schema needs. A
// regression that swapped `BigInt(orderId)` for `orderId` (number) would
// silently miss every cancel lookup because the bigint column never
// matches a number; locking the call shape catches it here without a DB.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProfileId, UserId } from '@app/contracts';
import type { AccountRepo, ProfileRepo } from '@app/db';

import { buildPersistence } from '../../src/profile-bindings/persistence.js';

const userId = 'u-1' as UserId;
const profileId = 'p-1' as ProfileId;

const orderInsert = vi.fn().mockResolvedValue({ id: 'order-1' });
const orderInsertTracking = vi.fn().mockResolvedValue(undefined);
const orderUpsertLive = vi.fn().mockResolvedValue({ id: 'order-live-1' });
const findByBinanceOrderId = vi.fn();
const closeByBinanceOrderId = vi.fn().mockResolvedValue(1);
const actionLogAppend = vi.fn().mockResolvedValue(undefined);
const notifiersListForProfile = vi.fn().mockResolvedValue([]);

// Minimal `ProfileRepo` stub: only the surface `buildPersistence`
// touches plus `scope`, which the closure reads for warn-log identity.
const makeRepo = (): ProfileRepo =>
  ({
    scope: { db: { __marker: 'db' }, userId, profileId },
    orders: {
      insert: orderInsert,
      insertTracking: orderInsertTracking,
      upsertLive: orderUpsertLive,
    },
    actionLogs: { append: actionLogAppend },
    profileNotifiers: { listForProfile: notifiersListForProfile },
  }) as unknown as ProfileRepo;

// Seeking an order by its Binance id is ACCOUNT-domain (the id is unique per
// account, not per profile), so those two live on the account surface.
const makeAccountRepo = (): AccountRepo =>
  ({
    orders: { findByBinanceOrderId, closeByBinanceOrderId },
  }) as unknown as AccountRepo;

/** Every call site takes both surfaces now; `closePrevious` defaults to the safe-to-close case. */
const build = (deps?: Parameters<typeof buildPersistence>[2]) =>
  buildPersistence(makeRepo(), makeAccountRepo(), deps ?? {});

const CLOSE_PREV = { closePrevious: true } as const;

beforeEach(() => {
  orderInsert.mockClear();
  orderInsertTracking.mockClear();
  orderUpsertLive.mockClear();
  findByBinanceOrderId.mockReset();
  closeByBinanceOrderId.mockClear();
  actionLogAppend.mockClear();
  notifiersListForProfile.mockReset();
  notifiersListForProfile.mockResolvedValue([]);
});

describe('buildPersistence.persistOrder', () => {
  it('routes a still-live (NEW) row to the idempotent orders.upsertLive', async () => {
    const p = build();
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'grid-buy',
        binanceOrderId: 42n,
        clientOrderId: 'cid-1',
        status: 'NEW',
        raw: { server: 'response' },
      },
      CLOSE_PREV,
    );
    // A live LIMIT/stop row contends for the partial unique live slot, so it
    // goes through upsertLive (close-then-insert) rather than plain insert.
    expect(orderInsert).not.toHaveBeenCalled();
    expect(orderUpsertLive).toHaveBeenCalledWith(
      {
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'grid-buy',
        binanceOrderId: 42n,
        clientOrderId: 'cid-1',
        status: 'NEW',
        raw: { server: 'response' },
        closedAt: null,
        // Orders with no strategy metadata (no `meta` on the inbound row)
        // round-trip as meta = null so the jsonb column stays NULL on insert.
        meta: null,
      },
      CLOSE_PREV,
    );
  });

  it('forwards strategy meta to orders.upsertLive when present on a live row', async () => {
    const p = build();
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'grid-buy',
        binanceOrderId: 7n,
        clientOrderId: 'cid-g1',
        status: 'NEW',
        raw: { server: 'response' },
        meta: { gridTradeIndex: 2 },
      },
      CLOSE_PREV,
    );
    expect(orderUpsertLive).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { gridTradeIndex: 2 } }),
      CLOSE_PREV,
    );
  });

  it('sets closedAt for terminal statuses (FILLED) so the live-per-intent index does not block the next order', async () => {
    const clock = { nowMs: () => 1_700_000_000_000 };
    const p = build({ clock });
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'manual',
        binanceOrderId: 99n,
        clientOrderId: 'cid-99',
        status: 'FILLED',
        raw: { server: 'response' },
      },
      CLOSE_PREV,
    );
    expect(orderInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FILLED', closedAt: new Date(1_700_000_000_000) }),
    );
    // The instant-fill fast path stays on plain insert; upsertLive is only
    // for still-live rows that contend for the live slot.
    expect(orderUpsertLive).not.toHaveBeenCalled();
  });

  it('closes an EXPIRED_IN_MATCH row — the STP terminator ends the order, it does not rest', async () => {
    // The ledger reads the same terminal vocabulary as the open-orders cache.
    // While it kept its own list, a self-trade-prevented order was evicted from
    // the cache but written `closed_at`-NULL, so it occupied the live slot for
    // its (profile, symbol, intent) and counted toward open exposure forever.
    const clock = { nowMs: () => 1_700_000_000_000 };
    const p = build({ clock });
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'manual',
        binanceOrderId: 98n,
        clientOrderId: 'cid-98',
        status: 'EXPIRED_IN_MATCH',
        raw: { server: 'response' },
      },
      CLOSE_PREV,
    );
    expect(orderInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'EXPIRED_IN_MATCH',
        closedAt: new Date(1_700_000_000_000),
      }),
    );
    expect(orderUpsertLive).not.toHaveBeenCalled();
  });

  it('sources closedAt from raw.transactTime when present so it reflects the real fill time (issue #255)', async () => {
    const clock = { nowMs: () => 1_700_000_005_000 }; // 5s after the fill
    const p = build({ clock });
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'manual',
        binanceOrderId: 100n,
        clientOrderId: 'cid-100',
        status: 'FILLED',
        raw: { transactTime: 1_700_000_000_000, server: 'response' },
      },
      CLOSE_PREV,
    );
    expect(orderInsert).toHaveBeenCalledWith(
      expect.objectContaining({ closedAt: new Date(1_700_000_000_000) }),
    );
  });

  it('falls back to the worker clock when raw.transactTime is missing or malformed', async () => {
    const clock = { nowMs: () => 1_700_000_005_000 };
    const p = build({ clock });
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'manual',
        binanceOrderId: 101n,
        clientOrderId: 'cid-101',
        status: 'FILLED',
        raw: { transactTime: 'not-a-number' },
      },
      CLOSE_PREV,
    );
    expect(orderInsert).toHaveBeenCalledWith(
      expect.objectContaining({ closedAt: new Date(1_700_000_005_000) }),
    );
  });
});

describe('buildPersistence.recordBookkeepingFailure', () => {
  it('appends an error-level action_log row tagged with the orderId and error', async () => {
    const clock = { nowMs: () => 1_700_000_000_000 };
    const p = build({ clock });
    await p.recordBookkeepingFailure({ symbol: 'BTCUSDT', orderId: 42, err: 'disk full' });
    expect(actionLogAppend).toHaveBeenCalledWith({
      time: new Date(1_700_000_000_000),
      symbol: 'BTCUSDT',
      level: 'error',
      msg: 'order accepted but post-submit bookkeeping failed',
      ctx: { orderId: 42, err: 'disk full' },
    });
  });
});

describe('buildPersistence.listEnabledNotifiers', () => {
  it('returns only the enabled notifier rows', async () => {
    const enabled = { enabled: true, provider: 'slack', config: {}, secrets: {} };
    notifiersListForProfile.mockResolvedValueOnce([{ enabled: false }, enabled]);
    const p = build();
    expect(await p.listEnabledNotifiers()).toEqual([enabled]);
  });

  it('returns an empty array when every notifier row is disabled', async () => {
    notifiersListForProfile.mockResolvedValueOnce([{ enabled: false }]);
    const p = build();
    expect(await p.listEnabledNotifiers()).toEqual([]);
  });

  it('returns an empty array when the profile has no notifier rows at all (the common 0-notifier state)', async () => {
    notifiersListForProfile.mockResolvedValueOnce([]);
    const p = build();
    expect(await p.listEnabledNotifiers()).toEqual([]);
  });
});

describe('buildPersistence.recordNotifierGap', () => {
  it('appends a warn-level action_log naming the topic, with the symbol when present', async () => {
    const clock = { nowMs: () => 1_700_000_000_000 };
    const p = build({ clock });
    await p.recordNotifierGap({ topic: 'binance-emergency', symbol: 'BTCUSDT' });
    expect(actionLogAppend).toHaveBeenCalledWith({
      time: new Date(1_700_000_000_000),
      symbol: 'BTCUSDT',
      level: 'warn',
      msg: 'real-money binance-emergency fired but this profile has no enabled notifier — you were not alerted',
      ctx: { topic: 'binance-emergency' },
    });
  });

  it('passes symbol=null when the gap carries no symbol', async () => {
    const p = buildPersistence(makeRepo(), { clock: { nowMs: () => 0 } });
    await p.recordNotifierGap({ topic: 'binance-weight-throttle' });
    expect(actionLogAppend.mock.calls[0]?.[0]).toMatchObject({ symbol: null });
  });
});

describe('buildPersistence — an order whose predecessor may still be resting', () => {
  it('forwards closePrevious=false so the repo refuses to stamp a live order CANCELED', async () => {
    // The caller (place-order) says the cancel that should have cleared this slot
    // did not land. The old order is still on the book; closing its row would
    // record a live order as cancelled and mint an orphan.
    const p = build();
    await p.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        intent: 'stop-loss',
        binanceOrderId: 55n,
        clientOrderId: 'cid-55',
        status: 'NEW',
        raw: {},
      },
      { closePrevious: false },
    );
    expect(orderUpsertLive).toHaveBeenCalledWith(expect.objectContaining({ binanceOrderId: 55n }), {
      closePrevious: false,
    });
  });

  it('persistTrackingOrder inserts a live-open row (no closedAt) for an order the bot could not book', async () => {
    // The order IS on Binance. Its row must stay open or every live-order
    // reconciliation path — user stream, reaper, orphan sweep — would skip it.
    const p = build();
    await p.persistTrackingOrder({
      userId,
      profileId,
      symbol: 'ETHUSDT',
      side: 'BUY',
      intent: 'entry',
      binanceOrderId: 77n,
      clientOrderId: 'cid-77',
      status: 'NEW',
      raw: { probed: true },
    });
    expect(orderInsertTracking).toHaveBeenCalledWith({
      symbol: 'ETHUSDT',
      side: 'BUY',
      intent: 'entry',
      binanceOrderId: 77n,
      clientOrderId: 'cid-77',
      status: 'NEW',
      raw: { probed: true },
      closedAt: null,
      meta: null,
    });
    // Never upsertLive: the row already holding the slot may itself still be resting.
    expect(orderUpsertLive).not.toHaveBeenCalled();
  });

  it('persistTrackingOrder CLOSES a terminal recovery row, at the exchange’s transactTime', async () => {
    // Both callers can carry a terminal status: a probed MARKET order comes back
    // FILLED, and the bookkeeping-recovery path replays Binance's own `dto.status`.
    // A FILLED row left `closed_at` NULL would hold the partial unique live slot —
    // so the NEXT order's upsertLive stamps this genuinely-filled row CANCELED and
    // erases a real trade from the archive — while counting toward account exposure
    // forever. Same terminal computation as persistOrder, not a hardcoded null.
    const p = build();
    await p.persistTrackingOrder({
      userId,
      profileId,
      symbol: 'ETHUSDT',
      side: 'SELL',
      intent: 'exit',
      binanceOrderId: 78n,
      clientOrderId: 'cid-78',
      status: 'FILLED',
      raw: { probed: true, transactTime: 1_700_000_000_999 },
    });
    expect(orderInsertTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FILLED',
        closedAt: new Date(1_700_000_000_999),
      }),
    );
  });

  it('closes a PROBED order at its updateTime — a getOrder snapshot has no transactTime', async () => {
    // The lost-response probe returns `GET /api/v3/order`, whose shape carries
    // `time` / `updateTime` and NO `transactTime`. Reading only `transactTime` would
    // silently fall back to the worker's wall clock for exactly the orders whose
    // real fill instant we most need (they filled while we were disconnected).
    const p = build();
    await p.persistTrackingOrder({
      userId,
      profileId,
      symbol: 'ETHUSDT',
      side: 'SELL',
      intent: 'exit',
      binanceOrderId: 79n,
      clientOrderId: 'cid-79',
      status: 'FILLED',
      raw: {
        orderId: 79,
        status: 'FILLED',
        time: 1_700_000_000_100,
        updateTime: 1_700_000_000_500,
      },
    });
    expect(orderInsertTracking).toHaveBeenCalledWith(
      expect.objectContaining({ closedAt: new Date(1_700_000_000_500) }),
    );
  });
});

describe('buildPersistence.resolveOrderSlot', () => {
  it("returns the row's live slot (symbol AND intent) and what the order still HOLDS", async () => {
    // The intent is load-bearing: a failed cancel must mark the exact
    // (symbol, intent) slot it left holding a live order on the exchange. `side` +
    // `remainingQty` are the other direction: a SUCCESSFUL cancel gives that base
    // back, and the next order in the same batch (the exit SELL that follows the
    // cancel of our own stop) must be judged against the wallet that release
    // produces — the cached snapshot still shows it locked.
    findByBinanceOrderId.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      intent: 'stop-loss',
      side: 'SELL',
      raw: { origQty: '1.5', executedQty: '0.5' },
    });
    const p = build();
    expect(await p.resolveOrderSlot(99)).toEqual({
      symbol: 'BTCUSDT',
      intent: 'stop-loss',
      side: 'SELL',
      remainingQty: '1',
      // A MARKET/stop row's `price` is '0', which is not a price: null, not zero.
      price: null,
    });
    expect(findByBinanceOrderId).toHaveBeenCalledWith(99n);
  });

  it("surfaces a resting BUY's limit price — quote released is quantity x price", async () => {
    // A cancelled BUY hands back QUOTE, and the batch's next order (trailing-trade's
    // replacement grid BUY) must be judged against the cash that release produces.
    findByBinanceOrderId.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      intent: 'grid-buy',
      side: 'BUY',
      raw: { origQty: '2', executedQty: '0', price: '50' },
    });
    const p = build();
    expect(await p.resolveOrderSlot(99)).toMatchObject({
      side: 'BUY',
      remainingQty: '2',
      price: '50',
    });
  });

  it('reports an UNKNOWN remainder when the row carries no readable quantities', async () => {
    // An ACK-shape placement response. The order is holding SOMETHING; we cannot
    // size it. Null (not zero) is what makes the funding check decline to judge
    // rather than judge wrongly and veto the exit.
    findByBinanceOrderId.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      intent: 'stop-loss',
      side: 'SELL',
      raw: {},
    });
    const p = build();
    expect(await p.resolveOrderSlot(99)).toMatchObject({ remainingQty: null });
  });

  it('returns null when no row matches inside the bound scope', async () => {
    findByBinanceOrderId.mockResolvedValueOnce(null);
    const p = build();
    expect(await p.resolveOrderSlot(7)).toBeNull();
  });
});

describe('buildPersistence.closeOrder', () => {
  it('routes (orderId, status) to closeByBinanceOrderId with BigInt promotion', async () => {
    closeByBinanceOrderId.mockResolvedValueOnce(1);
    const p = build();
    await p.closeOrder(123, 'FILLED');
    expect(closeByBinanceOrderId).toHaveBeenCalledWith(123n, 'FILLED', undefined, undefined);
  });

  it('threads closedAtMs through to the repo so the cancel transactTime is preserved end-to-end', async () => {
    closeByBinanceOrderId.mockResolvedValueOnce(1);
    const p = build();
    await p.closeOrder(123, 'CANCELED', 1_700_000_000_000);
    expect(closeByBinanceOrderId).toHaveBeenCalledWith(
      123n,
      'CANCELED',
      1_700_000_000_000,
      undefined,
    );
  });

  it('threads a fresh raw snapshot through to the repo so executedQty is refreshed on reconcile', async () => {
    closeByBinanceOrderId.mockResolvedValueOnce(1);
    const p = build();
    const raw = { status: 'FILLED', executedQty: '30.9' };
    await p.closeOrder(123, 'FILLED', 1_700_000_000_000, raw);
    expect(closeByBinanceOrderId).toHaveBeenCalledWith(123n, 'FILLED', 1_700_000_000_000, raw);
  });

  it('logs a warn when the repo reports zero matching rows so the silent close cannot hide', async () => {
    closeByBinanceOrderId.mockResolvedValueOnce(0);
    const warn = vi.fn();
    const p = build({ logger: { warn } });
    await p.closeOrder(456, 'CANCELED');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/zero live rows/);
  });

  it('refuses an orderId above Number.MAX_SAFE_INTEGER so a precision-lost BigInt cannot hit the wrong row', async () => {
    const p = build();
    await expect(p.closeOrder(Number.MAX_SAFE_INTEGER + 1, 'FILLED')).rejects.toThrow(
      /safe integer/,
    );
    await expect(p.resolveOrderSlot(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/safe integer/);
    expect(closeByBinanceOrderId).not.toHaveBeenCalled();
    expect(findByBinanceOrderId).not.toHaveBeenCalled();
  });

  it('refuses a negative orderId because Binance order IDs are unsigned', async () => {
    const p = build();
    await expect(p.resolveOrderSlot(-1)).rejects.toThrow(/safe integer/);
  });
});
