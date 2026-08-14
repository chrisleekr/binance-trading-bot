import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountId, UserId } from '@app/contracts';
import { parseOrderRateLimits } from '@app/binance';

import { buildBinanceResolver } from '../../../src/boot/builders/binance-resolver.js';
import { anyProxy, fakeDb, fakeRedis, silentLogger } from './fakes.js';

const OPERATOR = 'op-1' as UserId;
const ACCOUNT_A = 'acc-a' as AccountId;
const ACCOUNT_B = 'acc-b' as AccountId;

// Only the ownership resolve is stubbed; everything else in `@app/db` stays
// real so an import the builder relies on cannot silently vanish.
vi.mock('@app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@app/db')>()),
  accountRepo: () =>
    Promise.resolve({
      apiKeys: { findForAccount: () => Promise.resolve({ key: 'k', secret: 's' }) },
      account: { get: () => Promise.resolve({ binanceMode: 'test' }) },
    }),
}));

// The ORDERS rows a refresh publishes, controllable per test. Only the fetcher
// is stubbed — `combineExchangeInfoRefresh`, which decides whether a test-mode
// failure is fatal, stays real.
// Keyed by MODE: live and testnet publish genuinely different ORDERS limits, and
// one shared row set cannot express a refresh that changes only one of them.
const publishedRows = { live: [] as unknown[], test: [] as unknown[] };
const publishAll = (rows: unknown[]): void => {
  publishedRows.live = rows;
  publishedRows.test = rows;
};
// Both refresh closures are built inside the resolver and reachable nowhere
// else, so the deps they were handed are the only place the metrics forwarding
// is observable.
const refreshDeps: Record<string, unknown>[] = [];
vi.mock('../../../src/crons/exchange-info-refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/crons/exchange-info-refresh.js')>()),
  createExchangeInfoRefresh: (deps: { mode?: 'live' | 'test' } & Record<string, unknown>) => {
    refreshDeps.push(deps);
    return () =>
      Promise.resolve({
        fetched: 0,
        written: 0,
        skipped: 0,
        deleted: 0,
        orderRateLimits: parseOrderRateLimits(publishedRows[deps.mode ?? 'live']),
      });
  },
}));

const ORDERS_ROWS = [
  { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
  { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160_000 },
];

beforeEach(() => {
  publishAll([]);
  refreshDeps.length = 0;
});

describe('buildBinanceResolver', () => {
  it('exposes the resolve + exchange-info surface', () => {
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    expect(Object.keys(r).sort()).toEqual([
      'exchangeInfoRefresh',
      'orderGovernorFor',
      'resolveBinanceClient',
      'resolveBinanceFull',
    ]);
    expect(typeof r.resolveBinanceFull).toBe('function');
    expect(typeof r.resolveBinanceClient).toBe('function');
    expect(typeof r.exchangeInfoRefresh).toBe('function');
    expect(typeof r.orderGovernorFor).toBe('function');
  });

  it('forwards the metrics sink into BOTH exchange-info refreshes', () => {
    // `metrics` is optional on the deps, so dropping the argument still
    // type-checks and both parse-health counters would read a flat zero
    // forever. Live and test are separate closures over separate Binance
    // environments, and a payload only one of them sees is exactly the one
    // nobody is watching.
    const metrics = { record: () => undefined, forget: () => undefined };
    buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
      metrics,
    });

    expect(refreshDeps).toHaveLength(2);
    expect(refreshDeps[0]?.['metrics']).toBe(metrics);
    expect(refreshDeps[1]?.['metrics']).toBe(metrics);
    // ...and they are the two environments, not the same one twice.
    expect(refreshDeps[0]?.['mode']).toBeUndefined();
    expect(refreshDeps[1]?.['mode']).toBe('test');
  });

  // `resolveBinanceFull` builds a FRESH REST client per call, so a governor
  // built per call would forget its rolling window on every call and account
  // nothing. These two assertions are the whole reason it is memoised.
  it('reuses one order governor per account and never shares it across accounts', async () => {
    publishAll(ORDERS_ROWS);
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();

    const first = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    const second = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    const other = await r.resolveBinanceFull(OPERATOR, ACCOUNT_B);

    expect(first?.rest).not.toBe(second?.rest);
    expect(first?.orderGovernor).toBe(second?.orderGovernor);
    // ORDERS is metered per Binance UID, so one bucket across accounts would
    // throttle each to a fraction of its real allowance.
    expect(first?.orderGovernor).not.toBe(other?.orderGovernor);
  });

  it('warns and builds an inert governor when exchangeInfo published no ORDERS rows', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as unknown as ReturnType<typeof silentLogger>;
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger,
      weightGovernor: anyProxy(),
    });

    const resolved = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    expect(warn).toHaveBeenCalledTimes(1);
    // Inert means "admits everything", not "admits nothing" — an unreadable
    // limit must never wedge order flow.
    expect(resolved?.orderGovernor.hasHeadroom(1000)).toBe(true);
    expect(resolved?.orderGovernor.ceiling(10_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it('builds a BOUNDED governor from the rows a successful refresh published', async () => {
    publishAll(ORDERS_ROWS);
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();

    const resolved = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    // floor(50 * 0.8) = 40, so the governor is metering rather than inert. An
    // inert governor would report Infinity here and silently account nothing.
    expect(resolved?.orderGovernor.ceiling(10_000)).toBe(40);
    expect(resolved?.orderGovernor.hasHeadroom(1000)).toBe(false);
  });

  it('does not pin an account to the inert governor once limits arrive', async () => {
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });

    // First refresh published nothing, so this resolve gets the inert governor.
    await r.exchangeInfoRefresh();
    const before = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    expect(before?.orderGovernor.ceiling(10_000)).toBe(Number.POSITIVE_INFINITY);

    // Memoising the inert one would leave the account unmetered for the life of
    // the process; it must pick up the real limits on the next resolve.
    publishAll(ORDERS_ROWS);
    await r.exchangeInfoRefresh();
    const after = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    expect(after?.orderGovernor.ceiling(10_000)).toBe(40);
  });

  it('keeps the previous limits when a later refresh publishes none', async () => {
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });

    publishAll(ORDERS_ROWS);
    await r.exchangeInfoRefresh();

    // `parseOrderRateLimits` returns empty windows for a missing or malformed
    // `rateLimits` array rather than throwing, so an unconditional overwrite would
    // let ONE bad payload silently unmeter every account resolved afterwards. An
    // empty parse is a bad response, not a change of policy.
    publishAll([]);
    await r.exchangeInfoRefresh();

    // A fresh account, so the assertion reads the retained limits rather than
    // ACCOUNT_A's memoised governor.
    const resolved = await r.resolveBinanceFull(OPERATOR, ACCOUNT_B);
    expect(resolved?.orderGovernor.ceiling(10_000)).toBe(40);
  });

  it('lands a LOWERED ceiling on the live governor without losing its tally', async () => {
    // The memo is what makes the rolling window work, and it is also what stops
    // a new ceiling from ever reaching a live account. A lowered limit that
    // never lands is the dangerous direction: the governor keeps admitting
    // against the old allowance and Binance answers -1015 on orders the whole
    // mechanism exists to protect.
    //
    // Replacing the memo entry would land the ceiling but discard the tally, and
    // an already-resolved client would keep the old instance regardless. Both
    // failures point the same way — admitting a burst over the NEW allowance at
    // the exact moment Binance tightened it — so the governor is reconfigured in
    // place and the identity assertion below is load-bearing.
    publishAll(ORDERS_ROWS);
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();
    const before = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    expect(before?.orderGovernor.ceiling(10_000)).toBe(40);

    // Three orders already spent in the 10s window before the limits change.
    await before?.orderGovernor.reserve(3);

    publishAll([
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 5 },
      { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160_000 },
    ]);
    await r.exchangeInfoRefresh();
    const after = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    // floor(5 * 0.8) = 4, so the new rows landed...
    expect(after?.orderGovernor.ceiling(10_000)).toBe(4);
    // ...on the SAME instance the already-resolved client is holding...
    expect(after?.orderGovernor).toBe(before?.orderGovernor);
    // ...and the three orders already spent still count against the new 4, so
    // only one more fits. A rebuilt governor would report 0 here and admit four.
    expect(after?.orderGovernor.used(10_000)).toBe(3);
    expect(after?.orderGovernor.hasHeadroom(1)).toBe(true);
    expect(after?.orderGovernor.hasHeadroom(2)).toBe(false);
  });

  it('keeps the memoised governor when a refresh republishes the SAME limits', async () => {
    // The refresh cron re-runs on a schedule and almost always republishes an
    // unchanged set. Discarding the rolling window on each of those would
    // account nothing, which is the exact failure the memo was introduced to
    // prevent.
    publishAll(ORDERS_ROWS);
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();
    const before = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    await before?.orderGovernor.reserve(2);

    publishAll([...ORDERS_ROWS]);
    await r.exchangeInfoRefresh();
    const after = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    expect(after?.orderGovernor).toBe(before?.orderGovernor);
    expect(after?.orderGovernor.used(10_000)).toBe(2);
  });

  it('leaves the OTHER environment’s governors alone', async () => {
    // Live and testnet publish genuinely different ORDERS limits, and both modes
    // share one memo map keyed `accountId:mode`. A capture that reconfigured
    // every entry would push testnet's allowance onto a live account, where it
    // is either a throttle on real order flow or an over-admit into -1015.
    // Only a set that DIFFERS per mode can tell the two apart: with the same
    // rows on both sides, a cross-mode reconfigure is indistinguishable from a
    // scoped one.
    publishedRows.live = [
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
    ];
    publishedRows.test = [
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 90 },
    ];
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();
    // The mocked account row is `binanceMode: 'test'`, so this resolve memoises
    // under `:test`; the live governor is requested directly.
    const testGovernor = (await r.resolveBinanceFull(OPERATOR, ACCOUNT_A))?.orderGovernor;
    const liveGovernor = r.orderGovernorFor(ACCOUNT_A, 'live');
    expect(liveGovernor.ceiling(10_000)).toBe(40);
    expect(testGovernor?.ceiling(10_000)).toBe(72);

    // Only testnet's limit moves. Live's rows are republished unchanged, so the
    // live ceiling holding at 40 is a claim about SCOPE, not about inertia.
    publishedRows.test = [
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 30 },
    ];
    await r.exchangeInfoRefresh();

    expect(testGovernor?.ceiling(10_000)).toBe(24);
    expect(liveGovernor.ceiling(10_000)).toBe(40);
  });
});
