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
const publishedRows = { rows: [] as unknown[] };
vi.mock('../../../src/crons/exchange-info-refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/crons/exchange-info-refresh.js')>()),
  createExchangeInfoRefresh: () => () =>
    Promise.resolve({
      fetched: 0,
      written: 0,
      skipped: 0,
      deleted: 0,
      orderRateLimits: parseOrderRateLimits(publishedRows.rows),
    }),
}));

const ORDERS_ROWS = [
  { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
  { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160_000 },
];

beforeEach(() => {
  publishedRows.rows = [];
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

  // `resolveBinanceFull` builds a FRESH REST client per call, so a governor
  // built per call would forget its rolling window on every call and account
  // nothing. These two assertions are the whole reason it is memoised.
  it('reuses one order governor per account and never shares it across accounts', async () => {
    publishedRows.rows = ORDERS_ROWS;
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
    publishedRows.rows = ORDERS_ROWS;
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
    publishedRows.rows = ORDERS_ROWS;
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

    publishedRows.rows = ORDERS_ROWS;
    await r.exchangeInfoRefresh();

    // `parseOrderRateLimits` returns empty windows for a missing or malformed
    // `rateLimits` array rather than throwing, so an unconditional overwrite would
    // let ONE bad payload silently unmeter every account resolved afterwards. An
    // empty parse is a bad response, not a change of policy.
    publishedRows.rows = [];
    await r.exchangeInfoRefresh();

    // A fresh account, so the assertion reads the retained limits rather than
    // ACCOUNT_A's memoised governor.
    const resolved = await r.resolveBinanceFull(OPERATOR, ACCOUNT_B);
    expect(resolved?.orderGovernor.ceiling(10_000)).toBe(40);
  });

  it('rebuilds an account governor when a refresh publishes a CHANGED ceiling', async () => {
    // The memo is what makes the rolling window work, and it is also what stops
    // a new ceiling from ever reaching a live account. A lowered limit that
    // never lands is the dangerous direction: the governor keeps admitting
    // against the old allowance and Binance answers -1015 on orders the whole
    // mechanism exists to protect.
    publishedRows.rows = ORDERS_ROWS;
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();
    const before = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);
    expect(before?.orderGovernor.ceiling(10_000)).toBe(40);

    publishedRows.rows = [
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 5 },
      { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160_000 },
    ];
    await r.exchangeInfoRefresh();
    const after = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    // floor(5 * 0.8) = 4. A same-instance assertion would pass on the stale
    // governor too, so the ceiling is what proves the new rows landed.
    expect(after?.orderGovernor.ceiling(10_000)).toBe(4);
    expect(after?.orderGovernor).not.toBe(before?.orderGovernor);
  });

  it('keeps the memoised governor when a refresh republishes the SAME limits', async () => {
    // The refresh cron re-runs on a schedule and almost always republishes an
    // unchanged set. Rebuilding on every one of those would discard the rolling
    // window each time and account nothing, which is the exact failure the memo
    // was introduced to prevent.
    publishedRows.rows = ORDERS_ROWS;
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    await r.exchangeInfoRefresh();
    const before = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    publishedRows.rows = [...ORDERS_ROWS];
    await r.exchangeInfoRefresh();
    const after = await r.resolveBinanceFull(OPERATOR, ACCOUNT_A);

    expect(after?.orderGovernor).toBe(before?.orderGovernor);
  });
});
