// A held position with no protective stop resting on Binance produces nothing to alert on: no order was rejected, no exit was refused, and the strategy reports it as an ordinary exit blocker on every tick.
//
// One tick of that is normal — the stop goes on next tick. The SAME span still open a quarter of an hour later means every arm has been refused since, and the position has been sitting with nothing under it that whole time. Only the duration separates the two, so only the duration can decide whether the operator's phone rings.
//
// The span start comes from the `exit-blocked` condition row, which keeps `since` while the code is unchanged and restarts it when the code changes. That makes it an exact persistence clock, and the only one the tick can read.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import {
  asAccountId,
  asProfileId,
  asUserId,
  PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS,
} from '@app/contracts';

// The audit wrapper resolves its condition writer off the scope, and the span start it reports back is what the persistence window is measured from. Mock the binding so each test can hand the tick a span of a chosen age, or a swallowed write, without a real Postgres.
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
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'LINKUSDT';
const NOW_MS = 1_770_000_000_000;
// How long a position may sit with no resting protective stop before the state stops being the tick after a fresh entry and becomes a naked position.
const UNPLACED_PERSIST_MS = PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS;
// Distinctive so an assertion proves the payload came from the state this tick computed. The stored condition row's `detail` froze at the moment the span opened, so on a span this old it names a stop price the strategy has long since moved past.
const WANTED_STOP = '11.5511';

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

const unplacedState = () => ({
  schemaVersion: '1.0.0',
  exitBlocker: {
    reason: 'protective-stop-unplaced',
    changeKey: 'unplaced',
    detail: { stop: WANTED_STOP },
  },
});

const buildStubStrategy = (nextState: unknown): Strategy =>
  ({
    name: 'stub-protective-stop-unplaced',
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
    // No decisions: the whole point is that nothing is placed, so nothing fails and no existing alert path can fire.
    tick: () => ({ nextState, decisions: [], logs: [], metrics: [] }),
  }) as unknown as Strategy;

// What the alert has to carry for the operator to act without opening the dashboard: which coin, how long it has been naked, and the stop the strategy wanted. Derived from the shipped dep rather than restated, because the whole deps object is cast to `TickHandlerDeps` and a hand-written copy is checked against nothing: this file exists to prove the alert never fires on an undated span, and a local `sinceMs: number | null` would quietly assert a wider contract than the one that ships.
type NotifyProtectiveStopUnplacedInput = Parameters<
  NonNullable<TickHandlerDeps['notifyProtectiveStopUnplaced']>
>[0];

interface RunOpts {
  readonly nextState: unknown;
  /** When the `exit-blocked` span this tick's blocker belongs to opened. `null` = the write was lost. */
  readonly sinceMs: number | null;
}

const run = async (opts: RunOpts) => {
  recordSpy.mockReset();
  // Keyed on the condition: the tick audits three blockers per pass, and only the `exit-blocked` row dates the span this alert measures.
  recordSpy.mockImplementation(async (input: { condition: string }) =>
    input.condition === 'exit-blocked' && opts.sinceMs === null
      ? Promise.reject(new Error('write timeout'))
      : { changed: true as const, previousCode: null, sinceMs: opts.sinceMs ?? 0 },
  );

  // Not async: an async wrapper would turn a synchronous throw in the real dep into a rejection, hiding the one shape the fire-and-forget guard must catch.
  const notifyProtectiveStopUnplaced = vi.fn((_input: NotifyProtectiveStopUnplacedInput) =>
    Promise.resolve(undefined),
  );
  // The sibling alert, wired on every run so the suppression cases can read whether it went out rather than inferring it from the state they passed in.
  const notifyProtectiveStopBlocked = vi.fn((_input: unknown) => Promise.resolve(undefined));

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
    strategyName: 'stub-protective-stop-unplaced',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: {} }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
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
    auditShipper: { publish: async () => undefined },
    clock: { nowMs: () => NOW_MS },
    notifyProtectiveStopUnplaced,
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
  // The notify is fire-and-forget, so a bare `not.toHaveBeenCalled()` would pass before the call it is meant to catch had a chance to land. Drain the microtask+macrotask queues first and every assertion below reads a settled state, whether it expects a call or the absence of one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { notifyProtectiveStopUnplaced, notifyProtectiveStopBlocked };
};

/** The band refusal the sibling alert covers, carried alongside the unplaced exit blocker: one coin, both records, which is the ordinary shape when the band is what keeps the stop from landing. */
const bandBlocker = (guarded: boolean) => ({
  reason: 'price-outside-exchange-band',
  detail: {
    symbol: SYMBOL,
    stopPrice: WANTED_STOP,
    price: '11.386',
    reference: '12.7',
    floor: '11.43',
    ceiling: '25.4',
    bound: 'floor',
    terminal: false,
    guarded,
  },
});

describe('tick handler — a position left with no protective stop reaches the operator', () => {
  it('raises once the coin has held the whole window with nothing resting under it', async () => {
    // Exactly at the boundary, because the gate is inclusive: the alternative is a strict comparison that a span landing on the window silently falls through.
    const { notifyProtectiveStopUnplaced } = await run({
      nextState: unplacedState(),
      sinceMs: NOW_MS - UNPLACED_PERSIST_MS,
    });

    // Pinned to the literal, not to the constant, so a shipped threshold that drifts fails here rather than silently moving every case in this file with it.
    expect(PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS).toBe(900_000);
    expect(notifyProtectiveStopUnplaced).toHaveBeenCalledTimes(1);
    expect(notifyProtectiveStopUnplaced).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: OPERATOR,
        accountId: ACCOUNT,
        profileId: PROFILE,
        symbol: SYMBOL,
        sinceMs: NOW_MS - UNPLACED_PERSIST_MS,
        detail: expect.objectContaining({ stop: WANTED_STOP }),
      }),
    );
  });

  it('stays silent on the tick right after an entry, before the window has run', async () => {
    // The noise guard. One millisecond short of the window is the ordinary case the strategy reports on every fresh entry, and paging on it would make the channel unreadable long before the naked case arrives.
    const { notifyProtectiveStopUnplaced } = await run({
      nextState: unplacedState(),
      sinceMs: NOW_MS - (UNPLACED_PERSIST_MS - 1),
    });

    expect(notifyProtectiveStopUnplaced).not.toHaveBeenCalled();
  });

  it('stays silent when the span start is unknown', async () => {
    // Fails CLOSED, unlike the terminal band refusal that fires on an unknown age. The whole premise here is that the state has already outlasted the window, and a lost condition write is no evidence of that: firing anyway would page on a first-tick entry every time Postgres hiccups.
    const { notifyProtectiveStopUnplaced } = await run({
      nextState: unplacedState(),
      sinceMs: null,
    });

    expect(notifyProtectiveStopUnplaced).not.toHaveBeenCalled();
  });

  it('stays silent on an exit blocker that is not the unplaced stop, however long it has held', async () => {
    // A resting priced stop is the healthy steady state and never ends, so a handler keyed on `exit-blocked` alone rather than on the code would alert forever on every guarded position.
    const { notifyProtectiveStopUnplaced } = await run({
      nextState: {
        schemaVersion: '1.0.0',
        exitBlocker: {
          reason: 'priced-stop-resting',
          changeKey: `priced|stop=${WANTED_STOP}`,
          detail: { stop: WANTED_STOP },
        },
      },
      sinceMs: NOW_MS - UNPLACED_PERSIST_MS * 10,
    });

    expect(notifyProtectiveStopUnplaced).not.toHaveBeenCalled();
  });

  it('pages once, not twice, when the band alert already went out this tick', async () => {
    // Both records describe one unguarded coin. The band alert names the cause and carries the more specific instruction, so it is the one that survives; a second alert about the same position would train the operator to skim the channel.
    const { notifyProtectiveStopUnplaced, notifyProtectiveStopBlocked } = await run({
      nextState: { ...unplacedState(), protectiveStopBlocker: bandBlocker(false) },
      sinceMs: NOW_MS - UNPLACED_PERSIST_MS,
    });

    expect(notifyProtectiveStopBlocked).toHaveBeenCalledTimes(1);
    expect(notifyProtectiveStopUnplaced).not.toHaveBeenCalled();
  });

  it('still raises when a band record exists but its own gate did not pass', async () => {
    // Suppression has to key on the band alert having FIRED, not on a band record existing. A guarded refusal is one the sibling alert deliberately stays silent on, and reading the record alone would let it mute this one on a coin nobody was ever told about.
    const { notifyProtectiveStopUnplaced, notifyProtectiveStopBlocked } = await run({
      nextState: { ...unplacedState(), protectiveStopBlocker: bandBlocker(true) },
      sinceMs: NOW_MS - UNPLACED_PERSIST_MS,
    });

    expect(notifyProtectiveStopBlocked).not.toHaveBeenCalled();
    expect(notifyProtectiveStopUnplaced).toHaveBeenCalledTimes(1);
  });
});
