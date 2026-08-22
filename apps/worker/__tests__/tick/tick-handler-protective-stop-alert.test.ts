// A protective stop the exchange band refuses is now DEFERRED, not attempted.
//
// That removed the only signal the operator had. Attempting it produced a -1013
// rejection, which raised the order-failed alert; deferring produces nothing to
// reject, so a position can sit with no working stop indefinitely and the
// operator's phone stays quiet. The blocker still has to reach them, but on the
// question that actually matters — is anything guarding the position — not on
// every tick that re-evaluates the band.
//
// Two escalation levels, because they carry opposite advice:
//   terminal   — no price in the band can ever arm this stop, so waiting cannot
//                fix it; the offset has to move. Raised on first sight.
//   persistent — the band could admit the stop again if the price returns, so a
//                brief excursion is noise; raised only once it has held.
// `guarded` outranks both: a working stop is still resting on the exchange, the
// re-arm is merely deferred, and alerting on it trains the operator to ignore
// the channel that carries the naked case.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

// The audit wrapper resolves its condition writer off the scope, and the span
// start it reports back is what the persistence window is measured from. Mock
// the binding so each test can hand the tick a span of a chosen age, or a
// swallowed write, without a real Postgres.
const recordSpy = vi.fn(async (_input: { condition: string }) => ({
  changed: true as const,
  previousCode: null,
  sinceMs: 0,
}));
vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return {
    ...actual,
    profileRepoFromScope: () => ({ conditionStates: { recordCondition: recordSpy } }),
  };
});

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import {
  createTickHandler,
  PROTECTIVE_STOP_BLOCKED_PERSISTENCE_MS,
  type TickHandlerDeps,
} from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';
import type { AuditEntry } from '../../src/audit-shipper/audit-shipper.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'LINKUSDT';
const NOW_MS = 1_770_000_000_000;
// Distinctive so an assertion proves the payload came from the state this tick
// computed, not from the stored condition row, whose `detail` freezes at the
// moment the span opened and would be stale by exactly the amount that matters.
const LIVE_PRICE = '11.3861';

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'LINK',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minQty: '0.01',
    stepSize: '0.01',
    minNotional: '10',
    tickSize: '0.001',
    maxQty: '1000000',
    minPrice: '0.00000001',
    maxPrice: '100000000',
  },
};

const blockerState = (detail: { terminal: boolean; guarded: boolean }) => ({
  schemaVersion: '1.0.0',
  protectiveStopBlocker: {
    reason: 'price-outside-exchange-band',
    detail: {
      symbol: SYMBOL,
      stopPrice: '11.5',
      price: LIVE_PRICE,
      reference: '12.7',
      floor: '11.43',
      ceiling: '25.4',
      bound: 'floor',
      terminal: detail.terminal,
      guarded: detail.guarded,
    },
  },
});

const buildStubStrategy = (nextState: unknown): Strategy =>
  ({
    name: 'stub-protective-stop',
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    // No decisions: the whole point is that nothing is placed, so nothing fails
    // and no existing alert path can fire.
    tick: () => ({ nextState, decisions: [], logs: [], metrics: [] }),
  }) as unknown as Strategy;

/** The payload the real dep declares, so an override can assert on it. */
type NotifyProtectiveStopBlockedInput = Parameters<
  NonNullable<TickHandlerDeps['notifyProtectiveStopBlocked']>
>[0];

interface RunOpts {
  readonly nextState: unknown;
  /** When the span this tick's blocker belongs to opened. `null` = the write was lost. */
  readonly sinceMs: number | null;
}

const run = async (opts: RunOpts) => {
  recordSpy.mockReset();
  recordSpy.mockImplementation(async (input: { condition: string }) =>
    input.condition === 'protective-stop-blocked' && opts.sinceMs === null
      ? Promise.reject(new Error('write timeout'))
      : { changed: true as const, previousCode: null, sinceMs: opts.sinceMs ?? 0 },
  );

  const audits: AuditEntry[] = [];
  // Not async: an async wrapper would turn a synchronous throw in the real dep
  // into a rejection, hiding the one shape the fire-and-forget guard must catch.
  const notifyProtectiveStopBlocked = vi.fn((_input: NotifyProtectiveStopBlockedInput) =>
    Promise.resolve(undefined),
  );

  const makeChain = (keys: string[]) => {
    const chain = {
      get(key: string) {
        keys.push(key);
        return chain;
      },
      exec: async () => keys.map(() => [null, null] as const),
    };
    return chain;
  };
  const redis = {
    pipeline: () => makeChain([]),
    exists: async () => 0,
    set: async () => 'OK',
    del: async () => 1,
  } as unknown as import('ioredis').Redis;

  const registry = createRegistry();
  registry.register(buildStubStrategy(opts.nextState));

  const profile = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-protective-stop',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: {} }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
  } as unknown as ProfileTickContext;

  const deps = {
    redis,
    registry,
    executor: { applyAll: async () => [] },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit: async () => undefined,
      }),
    },
    marketDataPort: { loadWindow: async () => [] } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: {
      publish: async (entry: AuditEntry) => {
        audits.push(entry);
      },
    },
    clock: { nowMs: () => NOW_MS },
    notifyProtectiveStopBlocked,
  } as unknown as TickHandlerDeps;

  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol: SYMBOL,
      event: 'resync',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  await createTickHandler(deps)(job);
  // The notify is fire-and-forget, so a bare `not.toHaveBeenCalled()` would pass
  // before the call it is meant to catch had a chance to land. Drain the
  // microtask+macrotask queues first and every assertion below reads a settled
  // state, whether it expects a call or the absence of one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { notifyProtectiveStopBlocked };
};

describe('tick handler — an unplaceable protective stop reaches the operator', () => {
  it('C3: raises on first sight when no price can arm the stop and nothing is guarding', async () => {
    // Terminal and naked. Waiting cannot clear it and the position is exposed
    // right now, so there is no window to serve out first.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: blockerState({ terminal: true, guarded: false }),
      sinceMs: NOW_MS,
    });

    expect(notifyProtectiveStopBlocked).toHaveBeenCalledTimes(1);
    expect(notifyProtectiveStopBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: OPERATOR,
        accountId: ACCOUNT,
        profileId: PROFILE,
        symbol: SYMBOL,
        reason: 'price-outside-exchange-band',
        terminal: true,
        detail: expect.objectContaining({ price: LIVE_PRICE, bound: 'floor' }),
      }),
    );
  });

  it('C3: still raises the terminal case when the condition write was lost', async () => {
    // No span start means the age of the block is unknown. For the terminal case
    // that has to fail OPEN: suppressing on a failed audit write would make a
    // Postgres blip silence the alert for an unguarded position.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: blockerState({ terminal: true, guarded: false }),
      sinceMs: null,
    });

    expect(notifyProtectiveStopBlocked).toHaveBeenCalledTimes(1);
    expect(notifyProtectiveStopBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: true }),
    );
  });

  it('C4: stays silent while a recoverable block is younger than the persistence window', async () => {
    // The band moves with the reference price. A block that has held for less
    // than the window is an excursion the next few ticks may resolve on their
    // own, and paging on it would make the channel unreadable.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: blockerState({ terminal: false, guarded: false }),
      sinceMs: NOW_MS - (PROTECTIVE_STOP_BLOCKED_PERSISTENCE_MS - 1),
    });

    expect(notifyProtectiveStopBlocked).not.toHaveBeenCalled();
  });

  it('C4: raises once a recoverable block has held for the whole persistence window', async () => {
    // Measured from the span start, not counted in ticks: tick cadence is
    // configurable per profile, so a tick count would mean a different real
    // duration on every profile.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: blockerState({ terminal: false, guarded: false }),
      sinceMs: NOW_MS - PROTECTIVE_STOP_BLOCKED_PERSISTENCE_MS,
    });

    expect(PROTECTIVE_STOP_BLOCKED_PERSISTENCE_MS).toBe(900_000);
    expect(notifyProtectiveStopBlocked).toHaveBeenCalledTimes(1);
    expect(notifyProtectiveStopBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: false }),
    );
  });

  it('C4: stays silent on a recoverable block whose span start is unknown', async () => {
    // The mirror image of the terminal case above, and deliberately asymmetric.
    // Terminal fails OPEN on an unknown age because waiting cannot fix it and the
    // position is exposed now. Recoverable fails CLOSED: its whole premise is
    // that the block has already outlasted the window, and a lost condition write
    // is no evidence of that — firing anyway would page on a first-tick excursion
    // every time Postgres hiccups.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: blockerState({ terminal: false, guarded: false }),
      sinceMs: null,
    });

    expect(notifyProtectiveStopBlocked).not.toHaveBeenCalled();
  });

  it('stays silent for a refusal that is not the exchange band', async () => {
    // The three base-sizing reasons are classified elsewhere and publish NEITHER
    // `guarded` NOR `terminal`, so both read false here — yet that branch leaves
    // any resting stop untouched, so "not guarded" is unproven. The alert body
    // also tells the operator to widen the stop offset, which does nothing for a
    // foreign order holding the base. The condition row still records it; only
    // the notification, whose copy tells one story, is narrowed.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: {
        schemaVersion: '1.0.0',
        protectiveStopBlocker: {
          reason: 'base-locked-by-foreign-order',
          detail: { symbol: SYMBOL, required: '5', free: '0', available: '0' },
        },
      },
      sinceMs: NOW_MS - PROTECTIVE_STOP_BLOCKED_PERSISTENCE_MS * 10,
    });

    expect(notifyProtectiveStopBlocked).not.toHaveBeenCalled();
  });

  it('C5: stays silent while a working stop still guards the position, terminal or not', async () => {
    // Terminal AND guarded together, so the test fails if terminal is read
    // first: the re-arm is blocked, but an existing stop is resting on the
    // exchange and the position is covered. Nothing for the operator to do.
    const { notifyProtectiveStopBlocked } = await run({
      nextState: blockerState({ terminal: true, guarded: true }),
      sinceMs: NOW_MS - PROTECTIVE_STOP_BLOCKED_PERSISTENCE_MS * 10,
    });

    expect(notifyProtectiveStopBlocked).not.toHaveBeenCalled();
  });
});
