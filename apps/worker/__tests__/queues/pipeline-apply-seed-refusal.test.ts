// The apply-avg-entry-price seed gate refuses when nothing sellable backs the symbol, and today that refusal persists nothing: it is one `warn` line, in a worker the operator has no reason to be reading. The api meanwhile accepted the write and kept the ledger row, so every read surface goes on rendering a position the strategy does not hold.
//
// A durable `condition_states` row is the seam that fixes it — the same store the tick's blockers already use, retention-immune (action_logs alone is pruned at one day) and readable by any projection without duplicating the decision at a second site.
//
// The gate's own arithmetic is pinned by the pipeline-worker suite against the boot prune's live verdict; these fixtures reuse two of its proven rows and assert only what the refusal RECORDS, so a rule change moves the verdict there rather than silently re-labelling the condition here.

import { describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';

import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { registerPipelineWorker } from '../../src/queues/pipeline-worker.js';
import type { PipelineWorkerDeps } from '../../src/queues/pipeline-worker.js';
import type { QueueSet } from '../../src/queues/queue-set.js';

const NOW_MS = 1_700_000_000_000;

const repoMocks = vi.hoisted(() => ({
  profilesFindById: vi.fn(),
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesRemove: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  conditionRecord: vi.fn(),
  binanceGetAccount: vi.fn(),
  binanceModeById: vi.fn(),
}));

vi.mock('../../src/profile-bindings/binance-client.js', () => ({
  buildBinanceClient: () => ({ getAccount: repoMocks.binanceGetAccount }),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(async () => ({
      scope: {},
      profile: { findById: repoMocks.profilesFindById },
      avgEntryPrices: {
        findBySymbol: repoMocks.avgEntryPricesFindBySymbol,
        remove: repoMocks.avgEntryPricesRemove,
      },
      symbolStates: { findBySymbol: repoMocks.symbolStatesFindBySymbol },
      conditionStates: { recordCondition: repoMocks.conditionRecord },
    })),
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: repoMocks.binanceModeById },
    },
  };
});

// A strategy carrying the position capability, schema-agnostic: the handler only needs `applyFill` and `clearPosition` to produce a body it can persist.
const positionStrategy = {
  name: 'trailing-trade',
  version: '1.0.0',
  capabilities: { candleIntervals: ['1h'] },
  initialState: () => ({ schemaVersion: '1.0.0', avgEntryPrice: null, heldQuantity: null }),
  migrateState: ({ state }: { state: unknown }) => state,
  position: {
    readPosition: (s: unknown) =>
      s && typeof s === 'object'
        ? {
            avgEntryPrice: (s as Record<string, unknown>)['avgEntryPrice'] ?? null,
            heldQuantity: (s as Record<string, unknown>)['heldQuantity'] ?? null,
          }
        : null,
    setHeldQuantity: (s: unknown, q: string | null) =>
      s && typeof s === 'object' ? { ...(s as Record<string, unknown>), heldQuantity: q } : null,
    setAvgEntryPrice: (s: unknown, p: string) =>
      s && typeof s === 'object' ? { ...(s as Record<string, unknown>), avgEntryPrice: p } : null,
    clearPosition: (s: unknown) =>
      s && typeof s === 'object'
        ? { ...(s as Record<string, unknown>), avgEntryPrice: null, heldQuantity: null }
        : null,
    applyFill: (
      s: unknown,
      fill: { kind: string; avgEntryPrice?: string; heldQuantity?: string | null },
    ) =>
      s && typeof s === 'object'
        ? {
            ...(s as Record<string, unknown>),
            avgEntryPrice: fill.avgEntryPrice ?? null,
            heldQuantity: fill.heldQuantity ?? null,
          }
        : null,
  },
};

const ids = {
  userId: asUserId('00000000-0000-0000-0000-00000000aaaa'),
  accountId: asAccountId('00000000-0000-0000-0000-00000000cccc'),
  profileId: asProfileId('00000000-0000-0000-0000-00000000bbbb'),
};

interface Harness {
  invoke: (name: string, data: unknown) => Promise<void>;
  redisGet: ReturnType<typeof vi.fn>;
  warnings: { ctx: unknown; msg: string }[];
  persistedSymbolStates: { symbol: string; state: unknown }[];
}

const buildHarness = (): Harness => {
  for (const key of Object.keys(repoMocks) as (keyof typeof repoMocks)[]) {
    repoMocks[key].mockReset();
  }
  repoMocks.binanceModeById.mockResolvedValue('live');
  repoMocks.profilesFindById.mockResolvedValue({
    id: ids.profileId,
    enabled: true,
    binanceMode: 'live',
    strategyName: 'trailing-trade',
    strategyVersion: '1.0.0',
    config: {},
  });
  repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

  const warnings: { ctx: unknown; msg: string }[] = [];
  const persistedSymbolStates: { symbol: string; state: unknown }[] = [];
  const redisGet = vi.fn(async () => null as string | null);
  const logger = {
    warn: (ctx: unknown, msg: string) => {
      warnings.push({ ctx, msg });
    },
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child() {
      return this;
    },
  } as unknown as Logger;
  const redis = {
    get: redisGet,
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  } as unknown as Redis;

  let captured: ((job: Job) => Promise<void>) | null = null;
  const queueSet: QueueSet = {
    queues: {} as QueueSet['queues'],
    workers: [],
    enqueueDlq: vi.fn(async () => undefined),
    registerWorker: ((_name: string, handler: (job: Job) => Promise<void>) => {
      captured = handler;
      return {} as Worker;
    }) as unknown as QueueSet['registerWorker'],
    closeAll: vi.fn(async () => undefined),
  };

  const deps = {
    db: {} as PipelineWorkerDeps['db'],
    redis,
    profileManager: {
      enable: vi.fn(),
      disable: vi.fn(),
      setTechnicalsIntervals: vi.fn(),
      setSymbols: vi.fn(),
    } as unknown as PipelineWorkerDeps['profileManager'],
    strategies: { get: () => positionStrategy } as unknown as PipelineWorkerDeps['strategies'],
    executor: { apply: vi.fn() } as unknown as PipelineWorkerDeps['executor'],
    statePort: { mutate: vi.fn() } as unknown as PipelineWorkerDeps['statePort'],
    clock: { nowMs: () => NOW_MS },
    chain: {
      run: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
      size: () => 0,
    },
    logger,
    resolveBinanceClient: vi.fn(async () => ({
      getAccount: repoMocks.binanceGetAccount,
      getMyTrades: vi.fn(),
      getPriceTickers: vi.fn(async () => []),
    })) as unknown as PipelineWorkerDeps['resolveBinanceClient'],
    evictProfileContext: vi.fn(),
    symbolStateDeps: {
      redis,
      logger,
      registry: { get: () => positionStrategy },
      persistSymbolState: vi.fn(async (_scope: unknown, symbol: string, state: unknown) => {
        persistedSymbolStates.push({ symbol, state });
        return true;
      }),
    } as unknown as PipelineWorkerDeps['symbolStateDeps'],
    reconcileOwnership: vi.fn(async () => undefined),
    notifyRegistry: {} as PipelineWorkerDeps['notifyRegistry'],
    metrics: { record: vi.fn(), forget: vi.fn() },
  } satisfies PipelineWorkerDeps;

  registerPipelineWorker(queueSet, deps);
  if (captured === null) throw new Error('test setup: registerWorker did not capture handler');

  return {
    invoke: async (name, data) => {
      if (captured === null) throw new Error('handler not captured');
      await captured({ name, data, id: 'test-job' } as unknown as Job);
    },
    redisGet,
    warnings,
    persistedSymbolStates,
  };
};

// The wallet/filters fixture the gate reads. Values are the pipeline-worker suite's own proven rows: a 2-of-500 wallet whose fate turns entirely on the lot-size increment.
const armWallet = (h: Harness, stepSize: string): void => {
  h.redisGet.mockImplementation(async (key: string) => {
    if (key === buildSymbolInfoKey('BTCUSDT', 'live')) {
      return JSON.stringify({ baseAsset: 'BTC', filters: { stepSize, minNotional: '200' } });
    }
    if (key === GLOBAL_KEYS.ticker('BTCUSDT')) return JSON.stringify({ price: '50' });
    return null;
  });
  repoMocks.binanceGetAccount.mockResolvedValue({
    balances: [{ asset: 'BTC', free: '2', locked: '0' }],
  });
  repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
    symbol: 'BTCUSDT',
    avgEntryPrice: '50',
    quantity: '500',
  });
};

const apply = (h: Harness): Promise<void> =>
  h.invoke('apply-avg-entry-price', {
    userId: ids.userId,
    accountId: ids.accountId,
    profileId: ids.profileId,
    symbol: 'BTCUSDT',
  });

describe('apply-avg-entry-price: the refusal is recorded, not only logged', () => {
  it('opens a durable condition when nothing sellable backs the symbol', async () => {
    const h = buildHarness();
    // Step 10 over a 2-coin wallet: no sell could round it up to a fillable order, so the prune deletes the row and the gate refuses.
    armWallet(h, '10');

    await apply(h);

    expect(h.warnings.map((w) => w.msg)).toContain(
      'pipeline_apply_avg_entry_price_no_sellable_position',
    );
    expect(repoMocks.conditionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'position-seed-refused',
        symbol: 'BTCUSDT',
        code: 'no-sellable-position',
        now: expect.any(Date),
      }),
    );
  });

  it('leaves the operator ledger row and the symbol state exactly as it found them', async () => {
    const h = buildHarness();
    armWallet(h, '10');

    await apply(h);

    // Recording a refusal is not a licence to delete the record the api accepted seconds earlier, and not a licence to write a cleared body either: the operator's correction is the PRICE, and declining to apply it must leave the symbol untouched for the prune to resolve.
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
    expect(h.persistedSymbolStates).toHaveLength(0);
  });

  it('clears the condition on the pass that applies the seed', async () => {
    const h = buildHarness();
    // Same wallet, a step it can be rounded on: the prune keeps the row, so the seed applies.
    armWallet(h, '0.00001');

    await apply(h);

    expect(h.persistedSymbolStates.at(-1)?.symbol).toBe('BTCUSDT');
    // `code: null` is the clear. It is also why a success needs no read-back guard: `recordCondition` compares against the stored row and writes nothing when the condition was already absent.
    expect(repoMocks.conditionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'position-seed-refused',
        symbol: 'BTCUSDT',
        code: null,
      }),
    );
  });

  it('clears the condition when the ledger row is gone (the DELETE path)', async () => {
    const h = buildHarness();
    armWallet(h, '0.00001');
    // The api removed the row and enqueued this job to converge the strategy. Without a clear here the refusal outlives the row that caused it and the strip warns about a position nothing references.
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);

    await apply(h);

    expect(repoMocks.conditionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'position-seed-refused',
        symbol: 'BTCUSDT',
        code: null,
      }),
    );
  });
});
