// orphan-orders-detect cron tests. Two surfaces: the pure account-wide diff
// (selectOrphans) and the handler's detect/dedup/alert/error paths. A
// getOpenOrders failure must warn and never crash the cron.
//
// The alert leaves through the account-notify chokepoint (an injected dep), not
// a hand-rolled safeNotify fan-out: the chokepoint owns the subscription gate,
// the mode-filtered notifier resolve, and the dedup. The cron only decides which
// orphans are worth alerting on and what to commit afterwards.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { OpenOrderDto } from '@app/binance';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import {
  createOrphanAlertStore,
  orphanOrdersDetectHandler,
  selectOrphans,
  type OrphanOrdersDetectDeps,
} from '../../src/crons/orphan-orders-detect.cron.js';
import type { AccountNotifyOutcome } from '../../src/notifiers/account-notify-event.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const mkLogger = () =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const job = { id: 'job-1', data: {} } as unknown as Job;

// An orphan belongs to the ACCOUNT whose key pair found it, so every fixture
// profile names one. The two accounts below sit on different environments.
const ACC_LIVE = asAccountId('acc-live-1');
const ACC_TEST = asAccountId('acc-test-1');

const profile = (profileId: string, accountId = ACC_LIVE): ActiveProfile => ({
  profileId: asProfileId(profileId),
  accountId,
  userId: asUserId('u1'),
  operatorId: asUserId('u1'),
  candleInterval: '1h',
  symbols: ['BTCUSDT'],
  technicalsIntervals: [],
});

const mkOrder = (orderId: number, over: Partial<OpenOrderDto> = {}): OpenOrderDto =>
  ({
    symbol: 'BTCUSDT',
    orderId,
    clientOrderId: `tt-abc${orderId}-b`,
    side: 'BUY',
    type: 'LIMIT',
    price: '60000',
    origQty: '0.001',
    executedQty: '0',
    status: 'NEW',
    stopPrice: '',
    time: 1,
    updateTime: 1,
    cummulativeQuoteQty: '0',
    ...over,
  }) as OpenOrderDto;

describe('selectOrphans', () => {
  it('keeps exchange orders with no live local row and drops tracked ones', () => {
    const open = [mkOrder(10), mkOrder(20), mkOrder(30)];
    const tracked = new Set<bigint>([20n]);
    expect(selectOrphans(open, tracked).map((o) => o.orderId)).toEqual([10, 30]);
  });

  it('returns nothing when every open order is tracked', () => {
    const open = [mkOrder(10), mkOrder(20)];
    expect(selectOrphans(open, new Set([10n, 20n]))).toEqual([]);
  });

  it('flags an order at the safe-integer boundary (never collides with the safe-integer tracked set)', () => {
    // Computed, not a literal: the boundary id cannot be written exactly as a
    // number literal (the lint rule rejects the precision loss).
    const bigId = Number.MAX_SAFE_INTEGER + 1;
    expect(selectOrphans([mkOrder(bigId)], new Set([10n])).map((o) => o.orderId)).toEqual([bigId]);
  });
});

// One env's client + its mode. The handler resolves one client per distinct
// mode; a single-mode default covers most tests (the mixed-mode test supplies
// a per-profile resolver).
const resolveOne =
  (getOpenOrders: () => Promise<readonly OpenOrderDto[]>, mode: 'test' | 'live' = 'live') =>
  async () => ({ rest: { getOpenOrders }, mode });

// The chokepoint is a BATCH seam: one call per account carries every orphan of
// that account, and answers with one outcome per event (in order).
type NotifyInput = Parameters<OrphanOrdersDetectDeps['accountNotify']>[0];
const notifyAll = (outcome: AccountNotifyOutcome) =>
  vi.fn<OrphanOrdersDetectDeps['accountNotify']>(async (input) => input.events.map(() => outcome));
const commitAlertedMock = () =>
  vi.fn<OrphanOrdersDetectDeps['commitAlerted']>(async () => undefined);
const writeSnapshotMock = () =>
  vi.fn<OrphanOrdersDetectDeps['writeSnapshot']>(async () => undefined);
const recordNotifyGapMock = () =>
  vi.fn<OrphanOrdersDetectDeps['recordNotifyGap']>(async () => undefined);

const mkDeps = (over: Partial<OrphanOrdersDetectDeps> = {}): OrphanOrdersDetectDeps => ({
  logger: mkLogger(),
  listActive: () => [profile('p1')],
  resolveBinance: resolveOne(async () => []),
  listTrackedLiveOrderIds: async () => [],
  confirmPersistedOrphans: async (_accountId, ids) => [...ids], // default: treat all as confirmed
  computeNewOrphans: async (_accountId, ids) => [...ids],
  commitAlerted: commitAlertedMock(),
  writeSnapshot: writeSnapshotMock(),
  nowMs: () => 1_700_000_000_000,
  accountNotify: notifyAll('delivered'),
  recordNotifyGap: recordNotifyGapMock(),
  ...over,
});

describe('orphanOrdersDetectHandler', () => {
  it('no-ops when no profiles are active (never calls Binance)', async () => {
    const resolveBinance = vi.fn();
    await orphanOrdersDetectHandler(mkDeps({ listActive: () => [], resolveBinance }))(job);
    expect(resolveBinance).not.toHaveBeenCalled();
  });

  it('warns and skips when no active profile has Binance credentials', async () => {
    const logger = mkLogger();
    await orphanOrdersDetectHandler(mkDeps({ logger, resolveBinance: async () => null }))(job);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('swallows a getOpenOrders failure (warns, does not throw)', async () => {
    const logger = mkLogger();
    const deps = mkDeps({
      logger,
      resolveBinance: resolveOne(async () => {
        throw new Error('binance down');
      }),
    });
    await expect(orphanOrdersDetectHandler(deps)(job)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('routes the orphan alert through the account-notify chokepoint', async () => {
    // The cron owns detection, not delivery. It must hand the alert to the
    // injected accountNotify dep (which owns the subscription gate + the
    // mode-filtered notifier resolve) rather than fanning out itself.
    const accountNotify = notifyAll('delivered');
    const commitAlerted = commitAlertedMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10), mkOrder(20)]),
      listTrackedLiveOrderIds: async () => [{ binanceOrderId: 20n, accountId: ACC_LIVE }], // 20 tracked; only 10 orphan
      accountNotify: accountNotify as never,
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    // ONE call for the one account, carrying its orphans — not one call (and two
    // DB reads) per orphan.
    expect(accountNotify).toHaveBeenCalledTimes(1);
    const input = accountNotify.mock.calls[0]?.[0] as NotifyInput;
    // The category is what the operator can mute; the accountId is what scopes
    // the notifier resolve to the account that owns the order book.
    expect(input.category).toBe('orphan-order');
    expect(input.accountId).toBe(ACC_LIVE);
    expect(input.events).toHaveLength(1);
    expect(input.events[0]?.symbol).toBe('BTCUSDT');
    expect(input.events[0]?.fields?.find((f) => f.label === 'Order ID')?.value).toBe('10');
    expect(commitAlerted).toHaveBeenCalledWith(ACC_LIVE, ['10']); // delivered orphan, on its own account's set
  });

  it('still marks the orphan alerted when the orphan-order category is muted', async () => {
    // Muting is a deliberate operator choice, not a delivery failure. Leaving
    // the orphan uncommitted would re-warn on every tick and then storm the
    // operator with the whole backlog the moment they re-enable the category.
    const accountNotify = notifyAll('muted');
    const commitAlerted = commitAlertedMock();
    const recordNotifyGap = recordNotifyGapMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [],
      accountNotify: accountNotify as never,
      recordNotifyGap,
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(commitAlerted).toHaveBeenCalledWith(ACC_LIVE, ['10']);
    // A mute is not a gap: the operator asked for silence, so no durable trace.
    expect(recordNotifyGap).not.toHaveBeenCalled();
  });

  it('records an action_log trace when no mode-matching notifier exists', async () => {
    // The orphan's own account has no notifier at all, so the alert reached
    // nobody. That is a gap the operator must be able to find after the fact —
    // unlike a mute, which they chose.
    const accountNotify = notifyAll('no-notifier');
    const recordNotifyGap = recordNotifyGapMock();
    const commitAlerted = commitAlertedMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [],
      accountNotify: accountNotify as never,
      recordNotifyGap,
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(recordNotifyGap).toHaveBeenCalledTimes(1);
    expect(recordNotifyGap.mock.calls[0]?.[0]).toMatchObject({ orderId: '10', mode: 'live' });
    // Still committed: the trace is the delivery channel, so re-warning every
    // tick would only spam the log.
    expect(commitAlerted).toHaveBeenCalledWith(ACC_LIVE, ['10']);
  });

  it('links the Review deep link at the owning account when PUBLIC_WEB_URL is set', async () => {
    // The adopt screen is account-scoped. An account-less link is not a route at
    // all, so the operator taps the alert and lands on a not-found page.
    const accountNotify = notifyAll('delivered');
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      accountNotify: accountNotify as never,
      publicWebUrl: 'http://localhost:5173',
    });
    await orphanOrdersDetectHandler(deps)(job);
    const input = accountNotify.mock.calls[0]?.[0] as NotifyInput;
    expect(input.events[0]?.link).toBe(`http://localhost:5173/accounts/${ACC_LIVE}/orphan-orders`);
  });

  it('links a testnet orphan at the TESTNET account, not the live one', async () => {
    // Both environments are scanned in one tick; the link must name the account
    // the orphan was actually found on, not whichever account was scanned first.
    const resolveBinance = (async (_operatorId: unknown, accountId: string) =>
      accountId === ACC_TEST
        ? { rest: { getOpenOrders: async () => [mkOrder(10)] }, mode: 'test' }
        : {
            rest: { getOpenOrders: async () => [mkOrder(20)] },
            mode: 'live',
          }) as unknown as OrphanOrdersDetectDeps['resolveBinance'];
    const accountNotify = notifyAll('delivered');
    const deps = mkDeps({
      listActive: () => [profile('pTest', ACC_TEST), profile('pLive', ACC_LIVE)],
      resolveBinance,
      listTrackedLiveOrderIds: async () => [],
      accountNotify: accountNotify as never,
      publicWebUrl: 'http://localhost:5173',
    });
    await orphanOrdersDetectHandler(deps)(job);
    // One batch per account, each resolved against ONLY its own account's
    // notifiers, each linking at its own account.
    const calls = accountNotify.mock.calls.map((c) => c[0] as NotifyInput);
    expect(calls.map((c) => c.accountId)).toEqual([ACC_TEST, ACC_LIVE]);
    expect(calls.map((c) => c.events[0]?.link)).toEqual([
      `http://localhost:5173/accounts/${ACC_TEST}/orphan-orders`,
      `http://localhost:5173/accounts/${ACC_LIVE}/orphan-orders`,
    ]);
  });

  it('does NOT alert an orphan on its first sighting — two-tick confirmation suppresses the reprice race', async () => {
    const accountNotify = notifyAll('delivered');
    const commitAlerted = commitAlertedMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [], // 10 untracked → candidate this tick
      confirmPersistedOrphans: async () => [], // but unseen last tick → not yet confirmed
      accountNotify: accountNotify as never,
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(accountNotify).not.toHaveBeenCalled(); // no push alert on a single-tick (transient) orphan
    expect(commitAlerted).not.toHaveBeenCalled(); // no confirmed orphans → early return, nothing committed
  });

  it('alerts ONLY the confirmed orphan when a second candidate is still on its first sighting', async () => {
    const accountNotify = notifyAll('delivered');
    const commitAlerted = commitAlertedMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10), mkOrder(11)]),
      listTrackedLiveOrderIds: async () => [], // both untracked → both candidates
      confirmPersistedOrphans: async () => ['10'], // only 10 seen on two ticks
      accountNotify: accountNotify as never,
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(accountNotify).toHaveBeenCalledTimes(1);
    const input = accountNotify.mock.calls[0]?.[0] as NotifyInput;
    expect(input.events).toHaveLength(1);
    expect(input.events[0]?.fields?.find((f) => f.label === 'Order ID')?.value).toBe('10');
    expect(commitAlerted).toHaveBeenCalledWith(ACC_LIVE, ['10']); // only the confirmed orphan
  });

  it('does NOT commit an orphan whose only notifier send failed (re-alerts next tick)', async () => {
    const commitAlerted = commitAlertedMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [],
      accountNotify: notifyAll('failed') as never, // every transport errored
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(commitAlerted).toHaveBeenCalledWith(ACC_LIVE, []); // nothing marked; retries next tick
  });

  it('writes the full current orphan set to the snapshot (string ids, computed-at stamp)', async () => {
    const writeSnapshot = writeSnapshotMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10), mkOrder(20)]),
      listTrackedLiveOrderIds: async () => [{ binanceOrderId: 20n, accountId: ACC_LIVE }], // 20 tracked; only 10 orphan
      writeSnapshot,
      nowMs: () => 1_700_000_000_000,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(writeSnapshot).toHaveBeenCalledOnce();
    // Per ACCOUNT: an order book belongs to exactly one key pair, so a shared
    // snapshot key would serve one account's untracked orders to another.
    expect(writeSnapshot.mock.calls[0]?.[0]).toBe(ACC_LIVE);
    const snap = writeSnapshot.mock.calls[0]?.[1] as {
      computedAtMs: number;
      orphans: Record<string, unknown>[];
    };
    expect(snap.computedAtMs).toBe(1_700_000_000_000);
    expect(snap.orphans).toHaveLength(1);
    // Assert the full projection, including the time -> timeMs rename, so a
    // dropped or transposed field is caught (not just orderId/symbol).
    expect(snap.orphans[0]).toEqual({
      orderId: '10',
      accountId: ACC_LIVE,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '60000',
      origQty: '0.001',
      status: 'NEW',
      clientOrderId: 'tt-abc10-b',
      timeMs: 1,
      mode: 'live',
    });
  });

  it('still writes an empty snapshot when nothing is orphaned (clears the adopt UI)', async () => {
    const writeSnapshot = writeSnapshotMock();
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [{ binanceOrderId: 10n, accountId: ACC_LIVE }], // everything tracked
      writeSnapshot,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(writeSnapshot).toHaveBeenCalledOnce();
    const snap = writeSnapshot.mock.calls[0]?.[1] as { orphans: unknown[] };
    expect(snap.orphans).toEqual([]);
  });

  it('alerts even when the snapshot write fails (warns, does not block)', async () => {
    const accountNotify = notifyAll('delivered');
    const logger = mkLogger();
    const deps = mkDeps({
      logger,
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [],
      writeSnapshot: async () => {
        throw new Error('redis down');
      },
      accountNotify: accountNotify as never,
    });
    await orphanOrdersDetectHandler(deps)(job);
    // The snapshot failure is warned (alongside the per-orphan untracked warn)…
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: expect.stringContaining('redis down') }),
      }),
      expect.stringContaining('snapshot write failed'),
    );
    expect(accountNotify).toHaveBeenCalledTimes(1); // …and the alert is still delivered
  });

  it('does not re-alert an orphan the dedup store reports as already seen', async () => {
    const accountNotify = notifyAll('delivered');
    const deps = mkDeps({
      resolveBinance: resolveOne(async () => [mkOrder(10)]),
      listTrackedLiveOrderIds: async () => [],
      computeNewOrphans: async () => [], // store says nothing new
      accountNotify: accountNotify as never,
    });
    await orphanOrdersDetectHandler(deps)(job);
    expect(accountNotify).not.toHaveBeenCalled(); // quiet tick: no notifier read, no send
  });

  it('scans each mode separately and diffs against that env only (a cross-env id collision is not masked)', async () => {
    // The SAME numeric order id 10 is open on BOTH the testnet and live
    // accounts. Testnet tracks 10 (not an orphan there); live does not (a real
    // orphan). A single global tracked set would wrongly hide the live orphan —
    // per-mode bucketing keeps it visible.
    const resolveBinance = (async (_operatorId: unknown, accountId: string) =>
      accountId === ACC_TEST
        ? { rest: { getOpenOrders: async () => [mkOrder(10)] }, mode: 'test' }
        : {
            rest: { getOpenOrders: async () => [mkOrder(10)] },
            mode: 'live',
          }) as unknown as OrphanOrdersDetectDeps['resolveBinance'];
    const writeSnapshot = writeSnapshotMock();
    const deps = mkDeps({
      listActive: () => [profile('pTest', ACC_TEST), profile('pLive', ACC_LIVE)],
      resolveBinance,
      listTrackedLiveOrderIds: async () => [{ binanceOrderId: 10n, accountId: ACC_TEST }],
      writeSnapshot,
    });
    await orphanOrdersDetectHandler(deps)(job);
    // One snapshot per account. The live account's is the one carrying the orphan.
    const live = writeSnapshot.mock.calls.find((c) => c[0] === ACC_LIVE)?.[1] as {
      orphans: { orderId: string; mode: string }[];
    };
    const test = writeSnapshot.mock.calls.find((c) => c[0] === ACC_TEST)?.[1] as {
      orphans: unknown[];
    };
    expect(live.orphans.map((o) => ({ orderId: o.orderId, mode: o.mode }))).toEqual([
      { orderId: '10', mode: 'live' },
    ]);
    expect(test.orphans).toEqual([]);
  });

  it('skips only the failing account when its getOpenOrders fails — a sibling account still detects', async () => {
    // The testnet scan succeeds, the live scan throws. Aborting the whole tick
    // would let one account's transient Binance fault suppress detection on every
    // other account, INCLUDING a real-money orphan on a healthy one. Only the
    // failing account is skipped; its last good snapshot rides its TTL.
    const resolveBinance = (async (_operatorId: unknown, accountId: string) =>
      accountId === ACC_TEST
        ? { rest: { getOpenOrders: async () => [mkOrder(10)] }, mode: 'test' }
        : {
            rest: {
              getOpenOrders: async () => {
                throw new Error('live down');
              },
            },
            mode: 'live',
          }) as unknown as OrphanOrdersDetectDeps['resolveBinance'];
    const writeSnapshot = writeSnapshotMock();
    const logger = mkLogger();
    const deps = mkDeps({
      logger,
      listActive: () => [profile('pTest', ACC_TEST), profile('pLive', ACC_LIVE)],
      resolveBinance,
      listTrackedLiveOrderIds: async () => [],
      writeSnapshot,
    });
    await expect(orphanOrdersDetectHandler(deps)(job)).resolves.toBeUndefined();
    // The healthy account still wrote its snapshot; the failing one wrote none.
    expect(writeSnapshot.mock.calls.map((c) => c[0])).toEqual([ACC_TEST]);
    const test = writeSnapshot.mock.calls[0]?.[1] as { orphans: { orderId: string }[] };
    expect(test.orphans.map((o) => o.orderId)).toEqual(['10']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACC_LIVE }),
      expect.stringContaining('getOpenOrders failed'),
    );
  });

  it('never touches the alert state of an account it could not scan', async () => {
    // The seen / alerted sets are REWRITTEN from what the caller passes. A skipped
    // account contributes nothing, so a shared set would prune its ids as "no
    // longer orphaned": it would re-alert on recovery (duplicate) and restart its
    // two-tick confirmation (delaying a genuine orphan). Per-account keys mean the
    // skipped account is simply not addressed at all.
    const resolveBinance = (async (_operatorId: unknown, accountId: string) =>
      accountId === ACC_TEST
        ? { rest: { getOpenOrders: async () => [mkOrder(10)] }, mode: 'test' }
        : {
            rest: {
              getOpenOrders: async () => {
                throw new Error('live down');
              },
            },
            mode: 'live',
          }) as unknown as OrphanOrdersDetectDeps['resolveBinance'];
    const confirmPersistedOrphans = vi.fn(async (_a: unknown, ids: readonly string[]) => [...ids]);
    const computeNewOrphans = vi.fn(async (_a: unknown, ids: readonly string[]) => [...ids]);
    const commitAlerted = commitAlertedMock();
    const deps = mkDeps({
      listActive: () => [profile('pTest', ACC_TEST), profile('pLive', ACC_LIVE)],
      resolveBinance,
      listTrackedLiveOrderIds: async () => [],
      confirmPersistedOrphans: confirmPersistedOrphans as never,
      computeNewOrphans: computeNewOrphans as never,
      commitAlerted,
    });
    await orphanOrdersDetectHandler(deps)(job);
    for (const spy of [confirmPersistedOrphans, computeNewOrphans, commitAlerted]) {
      expect(spy.mock.calls.map((c) => c[0])).toEqual([ACC_TEST]);
    }
  });
});

describe('createOrphanAlertStore', () => {
  // Both sets are keyed per ACCOUNT and hold BARE order ids: an order id is unique
  // within one Binance account, and the per-account key is what lets a skipped
  // account (its getOpenOrders failed) keep its state instead of being pruned to
  // empty by a tick that never saw it.
  const ACC = ACC_LIVE as never;
  const SEEN = `orphan-detect:seen:${ACC_LIVE}`;
  const ALERTED = `orphan-detect:alerted:${ACC_LIVE}`;

  const mkRedis = (members: string[]) => {
    const smembers = vi.fn(async () => members);
    const srem = vi.fn(async () => 1);
    const sadd = vi.fn(async () => 1);
    const del = vi.fn(async () => 1);
    const expire = vi.fn(async () => 1);
    return {
      redis: { smembers, srem, sadd, del, expire } as unknown as Parameters<
        typeof createOrphanAlertStore
      >[0],
      smembers,
      srem,
      sadd,
      del,
      expire,
    };
  };

  it('confirmPersisted returns only candidates also seen on the previous tick, and REWRITES (not accumulates) the seen set', async () => {
    const { redis, sadd, del, expire } = mkRedis(['1']); // order 1 was a candidate last tick
    const store = createOrphanAlertStore(redis);
    const confirmed = await store.confirmPersisted(ACC, ['1', '2']); // 2 is new this tick
    expect(confirmed).toEqual(['1']); // only the twice-seen candidate is confirmed
    expect(del).toHaveBeenCalledWith(SEEN); // cleared first — rewrite, not append
    expect(sadd).toHaveBeenCalledWith(SEEN, '1', '2'); // seen ← current
    expect(expire).toHaveBeenCalledWith(SEEN, 1_500); // TTL refreshed
    // The clear MUST land before the rewrite, else the set grows unbounded.
    expect(del.mock.invocationCallOrder[0]).toBeLessThan(sadd.mock.invocationCallOrder[0] ?? 0);
  });

  it('confirmPersisted confirms nothing on the first sighting (empty seen set)', async () => {
    const { redis } = mkRedis([]); // no prior tick recorded
    const store = createOrphanAlertStore(redis);
    expect(await store.confirmPersisted(ACC, ['1'])).toEqual([]);
  });

  it('confirmPersisted clears the seen set and skips the (invalid) empty sadd when no candidates this tick', async () => {
    const { redis, sadd, del, expire } = mkRedis(['1']);
    const store = createOrphanAlertStore(redis);
    expect(await store.confirmPersisted(ACC, [])).toEqual([]); // nothing to confirm
    expect(del).toHaveBeenCalledWith(SEEN); // seen wiped so a recurrence restarts fresh
    expect(sadd).not.toHaveBeenCalled(); // sadd with zero members is an invalid Redis call
    expect(expire).not.toHaveBeenCalled();
  });

  it('computeNew returns ids not yet alerted and prunes ids no longer orphaned', async () => {
    const { redis, srem } = mkRedis(['20']); // 20 was alerted last run
    const store = createOrphanAlertStore(redis);
    const fresh = await store.computeNew(ACC, ['10', '20']); // 20 still orphaned, 10 is new
    expect(fresh).toEqual(['10']);
    expect(srem).not.toHaveBeenCalled(); // 20 still present, nothing to prune
  });

  it('computeNew prunes an alerted id that is no longer orphaned', async () => {
    const { redis, srem } = mkRedis(['20']); // 20 alerted, but no longer open
    const store = createOrphanAlertStore(redis);
    expect(await store.computeNew(ACC, ['10'])).toEqual(['10']);
    expect(srem).toHaveBeenCalledWith(ALERTED, '20');
  });

  it('commitAlerted SADDs delivered ids and no-ops on an empty list', async () => {
    const { redis, sadd } = mkRedis([]);
    const store = createOrphanAlertStore(redis);
    await store.commitAlerted(ACC, ['10', '30']);
    expect(sadd).toHaveBeenCalledWith(ALERTED, '10', '30');
    await store.commitAlerted(ACC, []);
    expect(sadd).toHaveBeenCalledTimes(1); // empty list issues no write
  });
});
