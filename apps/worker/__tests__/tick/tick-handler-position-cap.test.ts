// The cap must hold when every symbol of a profile ticks at the same candle close. Each tick runs in its own per-(profile, symbol) chain, so without the per-profile lease two ticks both read "one slot left" and both enter. These tests drive the REAL `createTickHandler` over a shared chain and a held-set that grows only when the fake executor applies a BUY, which is how the real order row becomes visible to the next count.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey, type ChainByKey } from '../../src/lib/chain-by-key.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';
import { acquireLease, positionCapKey } from '../../src/tick/position-cap.js';

// Lets one test make the override claim fail without a real override, because a tick carrying a real override is exempt from the cap and so never holds the lease on that path.
const claimOverride = vi.hoisted(() => ({ result: true }));
vi.mock('../../src/tick/override-ticket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tick/override-ticket.js')>();
  return {
    ...actual,
    createOverrideTicket: (...args: Parameters<typeof actual.createOverrideTicket>) => ({
      ...actual.createOverrideTicket(...args),
      whenClaimed: async () => claimOverride.result,
    }),
  };
});

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SCOPE = { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE };
const OVERRIDE = {
  kind: 'trigger-buy' as const,
  overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567',
};

const symbolInfo = (symbol: string): SymbolInfo => ({
  symbol,
  baseAsset: symbol.replace('USDT', ''),
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minQty: '0.00001',
    stepSize: '0.00001',
    minNotional: '10',
    tickSize: '0.01',
    maxQty: '1000000',
    minPrice: '0.00000001',
    maxPrice: '100000000',
  },
});

const buildFakeRedis = (): import('ioredis').Redis => {
  const makeChain = (count: { n: number }) => {
    const chain = {
      get() {
        count.n += 1;
        return chain;
      },
      exec: async () => Array.from({ length: count.n }, () => [null, null] as const),
    };
    return chain;
  };
  return {
    pipeline: () => makeChain({ n: 0 }),
    exists: async () => 0,
    get: async () => null,
    set: async (): Promise<'OK'> => 'OK',
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const buyStrategy = (symbol: string): Strategy =>
  ({
    name: 'stub-position-cap',
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
    bundleSchema: z.object({}).passthrough(),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({
      nextState: { schemaVersion: '1.0.0' },
      decisions: [
        {
          type: 'place-order',
          intent: { symbol, side: 'BUY', reason: 'entry', clientOrderId: `entry-${symbol}` },
          params: { type: 'MARKET', quantity: '1' },
        },
      ],
      logs: [],
      metrics: [],
    }),
  }) as unknown as Strategy;

interface Shared {
  readonly chain: ChainByKey;
  /** Coins the profile holds; grows when a fake executor applies a BUY. */
  readonly held: Set<string>;
  readonly applied: string[];
  readonly warn: ReturnType<typeof vi.fn>;
}

const makeShared = (held: string[]): Shared => ({
  chain: createChainByKey(),
  held: new Set(held),
  applied: [],
  warn: vi.fn(),
});

interface HandlerOpts {
  readonly maxOpenPositions?: number;
  readonly withOverride?: boolean;
  readonly listHeldSymbols?: TickHandlerDeps['listHeldSymbols'];
  readonly applyAllThrows?: boolean;
}

type Decisions = readonly { type: string; intent?: { side: string } }[];

const makeHandler = (shared: Shared, symbol: string, opts: HandlerOpts = {}) => {
  const registry = createRegistry();
  registry.register(buyStrategy(symbol));
  const applyAll = vi.fn(async (_ctx: unknown, _acc: unknown, decisions: Decisions) => {
    // Widens the race window: a sibling tick that is not serialised reads the held-set before this BUY lands in it.
    await new Promise<void>((r) => setTimeout(r, 10));
    if (opts.applyAllThrows) throw new Error('boom');
    for (const d of decisions) {
      if (d.type === 'place-order' && d.intent?.side === 'BUY') {
        shared.applied.push(symbol);
        shared.held.add(symbol);
      }
    }
    return decisions.map((decision) => ({ decision, result: { ok: true } }));
  });
  const listHeldSymbols = vi.fn(async () => {
    const snapshot = [...shared.held];
    await new Promise<void>((r) => setTimeout(r, 10));
    return snapshot;
  });
  const profile = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: SCOPE,
    symbol,
    strategyName: 'stub-position-cap',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({
      bundle: opts.withOverride ? { override: OVERRIDE } : {},
    }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    maxOpenPositions: opts.maxOpenPositions ?? 2,
  } as unknown as ProfileTickContext;
  const deps = {
    redis: buildFakeRedis(),
    registry,
    executor: { applyAll },
    chain: shared.chain,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: shared.warn,
      error: () => undefined,
    },
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache: { get: async () => symbolInfo(symbol) },
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit: async () => undefined,
      }),
    },
    marketDataPort: { loadWindow: async () => [] } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    metrics: { record: vi.fn(), forget: vi.fn() },
    claimOverrideAction: async () => true,
    findActiveOverride: async () => ({ id: OVERRIDE.overrideActionId }),
    settleOverrideAction: async () => undefined,
    markOverridePickedUp: async () => undefined,
    listHeldSymbols: opts.listHeldSymbols ?? listHeldSymbols,
    clock: { nowMs: () => 1_700_000_000_000 },
  } as unknown as TickHandlerDeps;
  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol,
      event: 'resync',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;
  const handler = createTickHandler(deps);
  return { run: () => handler(job), applyAll, listHeldSymbols };
};

/** Fails the test instead of hanging it when a lease is never released. */
const within = async <T>(p: Promise<T>, ms = 1000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

describe('tick handler position cap', () => {
  it('lets exactly one of two simultaneous entries through when one slot is left', async () => {
    const shared = makeShared(['XUSDT']);
    const a = makeHandler(shared, 'AUSDT');
    const b = makeHandler(shared, 'BUSDT');

    await within(Promise.all([a.run(), b.run()]));

    expect(shared.applied).toHaveLength(1);
    expect(shared.held.size).toBe(2);
    expect(shared.warn).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE, held: 2, max: 2 }),
      'position cap reached — new BUY suppressed',
    );
  });

  it('lets both through while two slots are left', async () => {
    const shared = makeShared([]);
    await within(
      Promise.all([makeHandler(shared, 'AUSDT').run(), makeHandler(shared, 'BUSDT').run()]),
    );
    expect([...shared.applied].sort()).toEqual(['AUSDT', 'BUSDT']);
  });

  it('does no held-set read and takes no lease when the cap is off', async () => {
    const shared = makeShared(['X', 'Y', 'Z']);
    const h = makeHandler(shared, 'AUSDT', { maxOpenPositions: 0 });
    // Holding the lease from outside would hang the tick if it tried to take it.
    const release = await acquireLease(shared.chain, positionCapKey(PROFILE));
    await within(h.run());
    release();
    expect(h.listHeldSymbols).not.toHaveBeenCalled();
    expect(shared.applied).toEqual(['AUSDT']);
  });

  it('exempts a tick carrying an operator override from the cap and the read', async () => {
    const shared = makeShared(['X', 'Y']);
    const h = makeHandler(shared, 'AUSDT', { withOverride: true });
    await within(h.run());
    expect(h.listHeldSymbols).not.toHaveBeenCalled();
    expect(shared.applied).toEqual(['AUSDT']);
  });

  it('fails open when the held-set read throws', async () => {
    const shared = makeShared(['X', 'Y']);
    const h = makeHandler(shared, 'AUSDT', {
      listHeldSymbols: async () => {
        throw new Error('db down');
      },
    });
    await within(h.run());
    expect(shared.applied).toEqual(['AUSDT']);
    expect(shared.warn).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE }),
      'position cap held-symbols read failed — proceeding without cap',
    );
  });

  it('releases the lease when applyAll throws', async () => {
    const shared = makeShared([]);
    const failing = makeHandler(shared, 'AUSDT', { applyAllThrows: true });
    await expect(within(failing.run())).rejects.toThrow('boom');
    await within(shared.chain.run(positionCapKey(PROFILE), async () => 'free'));
    await within(makeHandler(shared, 'BUSDT').run());
    expect(shared.applied).toEqual(['BUSDT']);
  });

  it('releases the lease on the early return when the override claim is lost', async () => {
    const shared = makeShared([]);
    claimOverride.result = false;
    try {
      const h = makeHandler(shared, 'AUSDT');
      await within(h.run());
      expect(h.applyAll).not.toHaveBeenCalled();
      expect(h.listHeldSymbols).toHaveBeenCalledTimes(1);
    } finally {
      claimOverride.result = true;
    }
    await within(shared.chain.run(positionCapKey(PROFILE), async () => 'free'));
  });
});
