import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Logger } from 'pino';

import { dustSnapshotHandler, type DustSnapshotDeps } from '../../src/crons/dust-snapshot.cron.js';
import type { BinanceRestClient } from '@app/binance';
import {
  OVERRIDE_OUTCOME_WINDOW_MS,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;

const silentLogger = pino({ level: 'silent' });

const stubRest = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient => {
  const base = {
    getOpenOrders: vi.fn(async () => []),
    getAccount: vi.fn(async () => ({}) as never),
    placeOrder: vi.fn(async () => ({}) as never),
    cancelOrder: vi.fn(async () => ({}) as never),
    getOrder: vi.fn(async () => ({}) as never),
    getKlines: vi.fn(async () => []),
    getTicker24hr: vi.fn(async () => ({}) as never),
    getAllTickers24hr: vi.fn(async () => []),
    getPriceTickers: vi.fn(async () => []),
    getRecentTrades: vi.fn(async () => []),
    getMyTrades: vi.fn(async () => []),
    getDepth: vi.fn(async () => ({}) as never),
    getDustBtc: vi.fn(async () => ({
      totalTransferBtc: '0',
      totalTransferBNB: '0',
      dribbletPercentage: '0',
      details: [],
    })),
    convertDust: vi.fn(async () => ({}) as never),
    ctx: vi.fn(() => ({}) as never),
    signWsApiPayload: vi.fn(() => ({ id: '', method: '', params: {} })),
  } satisfies BinanceRestClient;
  return { ...base, ...overrides };
};

const buildDeps = (
  rest: BinanceRestClient,
  mode: 'live' | 'test',
  loggerOverride?: Logger,
): DustSnapshotDeps => ({
  logger: loggerOverride ?? silentLogger,
  listActive: () => [
    {
      userId: USER_ID,
      operatorId: USER_ID,
      accountId: ACCOUNT_ID,
      profileId: PROFILE_ID,
      candleInterval: '1h',
      symbols: [],
      technicalsIntervals: [],
    },
  ],
  resolveBinance: vi.fn<DustSnapshotDeps['resolveBinance']>(async () => ({ rest, mode })),
  persistDust: vi.fn<DustSnapshotDeps['persistDust']>(async () => undefined),
  listPendingDustTransfers: vi.fn<DustSnapshotDeps['listPendingDustTransfers']>(async () => []),
  claimAction: vi.fn<DustSnapshotDeps['claimAction']>(async () => true),
  finalize: vi.fn<DustSnapshotDeps['finalize']>(async () => true),
  releaseClaim: vi.fn<DustSnapshotDeps['releaseClaim']>(async () => undefined),
  reapStaleProcessing: vi.fn<DustSnapshotDeps['reapStaleProcessing']>(async () => 0),
  reapExpiredOverrides: vi.fn<DustSnapshotDeps['reapExpiredOverrides']>(async () => ({
    expired: 0,
    unresolved: [],
  })),
});

describe('dust-snapshot cron handler', () => {
  it('skips test-mode profiles with a single info log (no SAPI calls, no warn)', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { ...silentLogger, info, warn } as unknown as Logger;
    const rest = stubRest();
    const deps = buildDeps(rest, 'test', logger);

    const handler = dustSnapshotHandler(deps);
    await handler({} as never);

    // Mode gate must short-circuit BEFORE SAPI calls.
    expect(rest.getDustBtc).not.toHaveBeenCalled();
    expect(rest.convertDust).not.toHaveBeenCalled();
    expect(deps.persistDust).not.toHaveBeenCalled();
    // Exactly one info-level skip, never a warn for the testnet case. The stale-claim
    // reaper now runs above this gate, and its stub finds nothing to reset, so the
    // no-warn assertion still describes a quiet pass rather than a reap being skipped.
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatch(/SAPI dust endpoints are live-only/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reaps a stale claim on a test-mode profile, above the live-only gate', async () => {
    // The reaper is no longer only the dust flow's: the tick claims trade-override rows
    // too, and overrides are armed on testnet exactly as on live. Behind the gate, a
    // test-mode worker that died holding an override claim would leave a row no cancel
    // can delete and no tick can claim, with nothing anywhere to clear it.
    const warn = vi.fn();
    const logger = { ...silentLogger, info: vi.fn(), warn } as unknown as Logger;
    const rest = stubRest();
    const reapStaleProcessing = vi.fn<DustSnapshotDeps['reapStaleProcessing']>(async () => 1);
    const now = 1_700_000_000_000;
    const staleProcessingMs = 600_000;
    const deps = {
      ...buildDeps(rest, 'test', logger),
      reapStaleProcessing,
      staleProcessingMs,
      clock: { nowMs: () => now },
    };

    await dustSnapshotHandler(deps)({} as never);

    expect(reapStaleProcessing).toHaveBeenCalledTimes(1);
    expect(reapStaleProcessing.mock.calls[0]?.[3]).toEqual(new Date(now - staleProcessingMs));
    // Still no SAPI work: hoisting the reaper must not drag the dust path above the gate.
    expect(rest.getDustBtc).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some((c) => /reset stale override_actions claims/.test(String(c[1]))),
    ).toBe(true);
  });

  it('reaps a stale claim for a profile whose Binance client cannot be built', async () => {
    // The reaper is pure Postgres and needs no REST client. Below the credential gate, a
    // profile with a missing or broken Binance key would keep a stranded claim forever,
    // which is the same hole the live-only hoist closed on the other side.
    const rest = stubRest();
    const reapStaleProcessing = vi.fn<DustSnapshotDeps['reapStaleProcessing']>(async () => 1);
    const deps = {
      ...buildDeps(rest, 'live'),
      resolveBinance: vi.fn(async () => null),
      reapStaleProcessing,
    };

    await dustSnapshotHandler(deps)({} as never);

    expect(reapStaleProcessing).toHaveBeenCalledTimes(1);
    // The dust path still stops at the unresolved credential.
    expect(rest.getDustBtc).not.toHaveBeenCalled();
    expect(deps.persistDust).not.toHaveBeenCalled();
  });

  it('converts dust for every live profile across sibling accounts (continue, not return)', async () => {
    // Mixed account: two live profiles on different accounts. The per-profile
    // loop uses `continue`, so both siblings must resolve and refresh — a
    // regression to `return` would abort the loop and silently stop converting
    // real dust for the second profile.
    const rest = stubRest();
    const firstId = 'p-first' as unknown as ProfileId;
    const secondId = 'p-second' as unknown as ProfileId;
    const firstAccountId = 'a-first' as unknown as AccountId;
    const secondAccountId = 'a-second' as unknown as AccountId;
    const deps: DustSnapshotDeps = {
      ...buildDeps(rest, 'live'),
      listActive: () => [
        {
          userId: USER_ID,
          operatorId: USER_ID,
          accountId: firstAccountId,
          profileId: firstId,
          candleInterval: '1h',
          symbols: [],
          technicalsIntervals: [],
        },
        {
          userId: USER_ID,
          operatorId: USER_ID,
          accountId: secondAccountId,
          profileId: secondId,
          candleInterval: '1h',
          symbols: [],
          technicalsIntervals: [],
        },
      ],
    };

    const handler = dustSnapshotHandler(deps);
    await handler({} as never);

    // Both siblings resolved + refreshed.
    expect(deps.resolveBinance).toHaveBeenCalledTimes(2);
    expect(deps.resolveBinance).toHaveBeenCalledWith(USER_ID, firstAccountId);
    expect(deps.resolveBinance).toHaveBeenCalledWith(USER_ID, secondAccountId);
    expect(rest.getDustBtc).toHaveBeenCalledTimes(2);
  });

  it('runs the full dust refresh on live-mode profiles', async () => {
    const rest = stubRest();
    const deps = buildDeps(rest, 'live');

    const handler = dustSnapshotHandler(deps);
    await handler({} as never);

    expect(rest.getDustBtc).toHaveBeenCalledTimes(1);
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
  });

  it('converts a pending dust transfer, stores the result, and notifies the operator', async () => {
    const rest = stubRest({
      convertDust: vi.fn(async () => ({
        totalServiceCharge: '0.001',
        totalTransfered: '0.5',
        transferResult: [
          {
            amount: '1',
            fromAsset: 'XRP',
            operateTime: 1,
            serviceChargeAmount: '0',
            tranId: 1,
            transferedAmount: '0.3',
          },
          {
            amount: '2',
            fromAsset: 'ADA',
            operateTime: 1,
            serviceChargeAmount: '0',
            tranId: 2,
            transferedAmount: '0.2',
          },
        ],
      })),
    });
    const finalize = vi.fn<DustSnapshotDeps['finalize']>(async () => true);
    const notifyDustConversion = vi.fn<NonNullable<DustSnapshotDeps['notifyDustConversion']>>(
      async () => undefined,
    );
    const deps: DustSnapshotDeps = {
      ...buildDeps(rest, 'live'),
      listPendingDustTransfers: vi.fn(async () => [{ id: 'a1', assets: ['XRP', 'ADA'] }]),
      finalize,
      notifyDustConversion,
    };

    const handler = dustSnapshotHandler(deps);
    await handler({} as never);

    expect(rest.convertDust).toHaveBeenCalledWith(['XRP', 'ADA']);
    // The convertDust response is threaded into finalize as durable history.
    expect(finalize).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      PROFILE_ID,
      'a1',
      expect.objectContaining({ totalTransfered: '0.5' }),
    );
    // Money moved: the operator is notified with the converted assets + BNB.
    expect(notifyDustConversion).toHaveBeenCalledTimes(1);
    expect(notifyDustConversion.mock.calls[0]?.[0]).toMatchObject({
      converted: ['XRP', 'ADA'],
      requested: 2,
      bnbReceived: '0.5',
      partial: false,
    });
  });

  it('continues to the next profile when getDustBtc throws (warn-and-skip, not abort)', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn, info: vi.fn() } as unknown as Logger;
    const rest = stubRest({
      getDustBtc: vi.fn(async () => {
        throw new Error('Binance POST /sapi/v1/asset/dust-btc: response body was not JSON');
      }),
    });
    const deps = buildDeps(rest, 'live', logger);

    const handler = dustSnapshotHandler(deps);
    await handler({} as never);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/profile refresh failed/);
    expect(deps.persistDust).not.toHaveBeenCalled();
  });
});

/**
 * The stranded-override sweep rides this cron. Without it, an override whose
 * re-arm failed — or whose worker died between the consuming Redis `DEL` and the
 * settle — sits "pending" on the symbol page forever, and the operator is left
 * watching an action that can never run.
 *
 * The sweep is account-tier and hoisted ABOVE the per-profile loop precisely so
 * it survives the loop's test-mode skip (an override is armed in test mode too)
 * and so it costs one statement per account rather than two Postgres round-trips
 * per profile every five minutes. Those are behaviours, not incidental
 * structure, so they are asserted here.
 */
describe('dust-snapshot cron — stranded-override sweep', () => {
  const PROFILE_ID_2 = 'p2' as unknown as ProfileId;
  const NOW_MS = 1_700_000_000_000;

  const twoProfileDeps = (overrides: Partial<DustSnapshotDeps> = {}): DustSnapshotDeps => ({
    ...buildDeps(stubRest(), 'test'),
    clock: { nowMs: () => NOW_MS },
    listActive: () => [
      {
        userId: USER_ID,
        operatorId: USER_ID,
        accountId: ACCOUNT_ID,
        profileId: PROFILE_ID,
        candleInterval: '1h',
        symbols: [],
        technicalsIntervals: [],
      },
      {
        userId: USER_ID,
        operatorId: USER_ID,
        accountId: ACCOUNT_ID,
        profileId: PROFILE_ID_2,
        candleInterval: '1h',
        symbols: [],
        technicalsIntervals: [],
      },
    ],
    ...overrides,
  });

  it('collapses both profiles of one account into a single sweep call', async () => {
    const reapExpiredOverrides = vi.fn<DustSnapshotDeps['reapExpiredOverrides']>(async () => ({
      expired: 0,
      unresolved: [],
    }));
    // test-mode, so the per-profile loop skips both profiles outright: the sweep
    // must still run, because an override is armed in test mode too.
    const deps = twoProfileDeps({ reapExpiredOverrides });

    await dustSnapshotHandler(deps)({} as never);

    expect(reapExpiredOverrides).toHaveBeenCalledTimes(1);
    expect(reapExpiredOverrides.mock.calls[0]).toEqual([
      USER_ID,
      ACCOUNT_ID,
      [PROFILE_ID, PROFILE_ID_2],
      // The staleness bound: a row older than the outcome window can no longer be
      // settled by any tick, because its Redis key has certainly expired.
      new Date(NOW_MS - OVERRIDE_OUTCOME_WINDOW_MS),
    ]);
  });

  it('isolates a throwing sweep from the dust snapshot', async () => {
    // The sweep's own try/catch is the load-bearing claim in its comment. A
    // stranded-row sweep that fails must not cost the operator their dust
    // snapshot — it is the lower-value half of this cron.
    const warn = vi.fn();
    const logger = { ...silentLogger, warn } as unknown as Logger;
    const rest = stubRest();
    const deps: DustSnapshotDeps = {
      ...twoProfileDeps({
        reapExpiredOverrides: vi.fn(async () => {
          throw new Error('pg exploded');
        }),
      }),
      logger,
      resolveBinance: vi.fn(async () => ({ rest, mode: 'live' as const })),
    };

    await dustSnapshotHandler(deps)({} as never);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/stranded-override sweep failed/);
    // The snapshot still ran for both profiles.
    expect(deps.persistDust).toHaveBeenCalledTimes(2);
  });

  it('warns with the count when the sweep actually settles stranded rows', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn } as unknown as Logger;
    const deps: DustSnapshotDeps = {
      ...twoProfileDeps({
        reapExpiredOverrides: vi.fn(async () => ({ expired: 3, unresolved: [] })),
      }),
      logger,
    };

    await dustSnapshotHandler(deps)({} as never);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ accountId: ACCOUNT_ID, expired: 3 });
  });

  it('escalates every unresolved row to the operator, naming its symbol', async () => {
    // A row the sweep can prove a tick picked up is the one case the bot cannot
    // resolve for itself: an order may be live on the exchange. A log line does
    // not reach a phone, and the operator has no reason to open the symbol page
    // for a force-sell they believe already settled — so it has to be pushed.
    const notifyOverrideUnresolved = vi.fn<
      NonNullable<DustSnapshotDeps['notifyOverrideUnresolved']>
    >(async () => undefined);
    const deps = twoProfileDeps({
      reapExpiredOverrides: vi.fn(async () => ({
        expired: 0,
        unresolved: [
          { id: 'oa-1', profileId: PROFILE_ID, symbol: 'BTCUSDT' },
          { id: 'oa-2', profileId: PROFILE_ID_2, symbol: 'ETHUSDT' },
        ],
      })),
      notifyOverrideUnresolved,
    });

    await dustSnapshotHandler(deps)({} as never);

    expect(notifyOverrideUnresolved).toHaveBeenCalledTimes(2);
    expect(notifyOverrideUnresolved.mock.calls[0]?.[0]).toEqual({
      operatorId: USER_ID,
      accountId: ACCOUNT_ID,
      profileId: PROFILE_ID,
      symbol: 'BTCUSDT',
      overrideActionId: 'oa-1',
    });
    expect(notifyOverrideUnresolved.mock.calls[1]?.[0]).toMatchObject({
      profileId: PROFILE_ID_2,
      symbol: 'ETHUSDT',
      overrideActionId: 'oa-2',
    });
  });

  it('logs every unresolved row even with no notifier wired', async () => {
    // The notification is the only surface that REACHES the operator, but it is
    // optional here and the category is operator-mutable — so if it were the sole
    // output, a possibly-live order could pass with no trace at all: the row is
    // outside the override read window and a muted category records nothing.
    const warn = vi.fn();
    const logger = { ...silentLogger, warn } as unknown as Logger;
    const deps: DustSnapshotDeps = {
      ...twoProfileDeps({
        reapExpiredOverrides: vi.fn(async () => ({
          expired: 0,
          unresolved: [{ id: 'oa-9', profileId: PROFILE_ID, symbol: 'SOLUSDT' }],
        })),
      }),
      logger,
    };

    await dustSnapshotHandler(deps)({} as never);

    const unresolvedWarns = warn.mock.calls.filter((argv) =>
      /an order may be live/i.test(String(argv[1])),
    );
    expect(unresolvedWarns).toHaveLength(1);
    expect(unresolvedWarns[0]?.[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      profileId: PROFILE_ID,
      symbol: 'SOLUSDT',
      overrideActionId: 'oa-9',
    });
  });

  it('keeps escalating the remaining rows when one notification throws', async () => {
    // The wired notifier swallows its own faults, so this pins that the cron does not
    // DEPEND on that: one symbol's alert failing must not silence its siblings'.
    const notifyOverrideUnresolved = vi.fn<
      NonNullable<DustSnapshotDeps['notifyOverrideUnresolved']>
    >(async (input) => {
      if (input.symbol === 'BTCUSDT') throw new Error('slack down');
    });
    const rest = stubRest();
    const deps: DustSnapshotDeps = {
      ...twoProfileDeps({
        reapExpiredOverrides: vi.fn(async () => ({
          expired: 0,
          unresolved: [
            { id: 'oa-1', profileId: PROFILE_ID, symbol: 'BTCUSDT' },
            { id: 'oa-2', profileId: PROFILE_ID_2, symbol: 'ETHUSDT' },
          ],
        })),
        notifyOverrideUnresolved,
      }),
      resolveBinance: vi.fn(async () => ({ rest, mode: 'live' as const })),
    };

    await dustSnapshotHandler(deps)({} as never);

    expect(notifyOverrideUnresolved).toHaveBeenCalledTimes(2);
    // The dust snapshot still ran for both profiles: the sweep's own catch, which
    // would have skipped the rest of the account, was never reached.
    expect(deps.persistDust).toHaveBeenCalledTimes(2);
  });

  it('stays silent when the sweep only settled rows no tick ever picked up', async () => {
    // These are the benign half: the window drained with no tick inside it, so
    // nothing was placed and there is nothing for a human to check. Alerting here
    // would train the operator to ignore the alert that matters.
    const notifyOverrideUnresolved = vi.fn<
      NonNullable<DustSnapshotDeps['notifyOverrideUnresolved']>
    >(async () => undefined);
    const deps = twoProfileDeps({
      reapExpiredOverrides: vi.fn(async () => ({ expired: 2, unresolved: [] })),
      notifyOverrideUnresolved,
    });

    await dustSnapshotHandler(deps)({} as never);

    expect(notifyOverrideUnresolved).not.toHaveBeenCalled();
  });
});
