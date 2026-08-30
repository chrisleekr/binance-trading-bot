// The apply-avg-entry-price gate stands down whenever one of its inputs never resolved, and today that is a `warn` line in a worker nobody reads. A counter is the surface an operator can actually alert on — but only if its children exist before the incident that would increment them.
//
// A prom-client child does not exist until its first write and is born holding that write's value. An unseeded labelled counter's first incident therefore exports a series that has always read 1, which `increase()` sees as no change: the rule over it is structurally unable to fire and reads exactly like a rule that has simply not tripped. This suite asserts against a real registry rather than against `record()` call order, because call order looks identical in the working and the broken world — the seed and the increment share one synchronous block, so no scrape can land between them.

import { describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import { createMetricsRegistry } from '@app/observability';

import { createWorkerMetricsSink } from '../../src/boot/metrics-sink.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import {
  APPLY_SEED_GATE_STAND_DOWN_REASONS,
  registerPipelineWorker,
} from '../../src/queues/pipeline-worker.js';
import type { PipelineWorkerDeps } from '../../src/queues/pipeline-worker.js';
import type { QueueSet } from '../../src/queues/queue-set.js';

const NOW_MS = 1_700_000_000_000;
const METRIC = 'pipeline_apply_seed_gate_stood_down_total';

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

// Position-capable, schema-agnostic: the handler needs only enough of the contract to build a body it can persist.
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
  resolveBinanceClient: ReturnType<typeof vi.fn>;
}

/**
 * Boots the pipeline worker against a real metrics registry so the assertions read scrape output rather than mock calls.
 *
 * @param metrics - The sink the handler records through; supplied by the caller so it can be backed by a registry it also reads.
 * @returns The captured job dispatcher plus the two mocks each fixture reprograms.
 */
const buildHarness = (metrics: PipelineWorkerDeps['metrics']): Harness => {
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

  const redisGet = vi.fn(async () => null as string | null);
  const logger = {
    warn: () => undefined,
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

  const resolveBinanceClient = vi.fn(async () => ({
    getAccount: repoMocks.binanceGetAccount,
    getMyTrades: vi.fn(),
    getPriceTickers: vi.fn(async () => []),
  }));

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
    resolveBinanceClient:
      resolveBinanceClient as unknown as PipelineWorkerDeps['resolveBinanceClient'],
    evictProfileContext: vi.fn(),
    symbolStateDeps: {
      redis,
      logger,
      registry: { get: () => positionStrategy },
      persistSymbolState: vi.fn(async () => true),
    } as unknown as PipelineWorkerDeps['symbolStateDeps'],
    reconcileOwnership: vi.fn(async () => undefined),
    notifyRegistry: {} as PipelineWorkerDeps['notifyRegistry'],
    metrics,
  } satisfies PipelineWorkerDeps;

  registerPipelineWorker(queueSet, deps);
  if (captured === null) throw new Error('test setup: registerWorker did not capture handler');

  return {
    invoke: async (name, data) => {
      if (captured === null) throw new Error('handler not captured');
      await captured({ name, data, id: 'test-job' } as unknown as Job);
    },
    redisGet,
    resolveBinanceClient,
  };
};

/**
 * Programs a wallet and filter set the gate resolves cleanly, so the pass lands on the applied arm.
 *
 * @param h - The harness whose redis and Binance mocks are being programmed.
 * @returns Nothing; the mocks are mutated in place.
 */
const armAppliedArm = (h: Harness): void => {
  h.redisGet.mockImplementation(async (key: string) => {
    if (key === buildSymbolInfoKey('BTCUSDT', 'live')) {
      return JSON.stringify({
        baseAsset: 'BTC',
        filters: { stepSize: '0.0001', minNotional: '10' },
      });
    }
    if (key === GLOBAL_KEYS.ticker('BTCUSDT')) return JSON.stringify({ price: '10' });
    return null;
  });
  repoMocks.binanceGetAccount.mockResolvedValue({
    balances: [{ asset: 'BTC', free: '5', locked: '0' }],
  });
  repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
    symbol: 'BTCUSDT',
    avgEntryPrice: '50',
    quantity: '5',
  });
};

const apply = (h: Harness): Promise<void> =>
  h.invoke('apply-avg-entry-price', {
    userId: ids.userId,
    accountId: ids.accountId,
    profileId: ids.profileId,
    symbol: 'BTCUSDT',
  });

const samplesFor = (body: string, name: string): string[] =>
  body.split('\n').filter((line) => line.startsWith(`${name}{`));

const reasonOf = (line: string): string | undefined => /reason="([^"]+)"/.exec(line)?.[1];

describe('apply-avg-entry-price stand-down counter exists before it can move', () => {
  it('exports every reason at zero on a pass where the gate resolved cleanly', async () => {
    // The decisive shape. On a stood-down pass the reason that fired is born at its own increment whether or not the seed ran, so only a CLEAN pass can distinguish a hoisted seed from one folded into the stand-down arm — and a profile whose gate always resolves is exactly the one whose first real incident must read as a rise.
    const registry = createMetricsRegistry({ service: 'worker-test', version: 'test' });
    const h = buildHarness(createWorkerMetricsSink(registry));
    armAppliedArm(h);

    // Nothing pre-creates children: before the pass the metric has no series at all.
    expect(await registry.metrics()).not.toContain(`${METRIC}{`);

    await apply(h);

    const samples = samplesFor(await registry.metrics(), METRIC);
    expect(samples.map(reasonOf).sort()).toEqual([...APPLY_SEED_GATE_STAND_DOWN_REASONS].sort());
    expect(samples.every((line) => line.endsWith(' 0'))).toBe(true);
    expect(samples.every((line) => line.includes('symbol="BTCUSDT"'))).toBe(true);
  });

  it('exports the reason that fired at one and its siblings at zero', async () => {
    // The other half: an incident is a RISE off an existing zero, and the siblings stay armed for the next incident on the same symbol, which is usually a different reason with a different remedy.
    const registry = createMetricsRegistry({ service: 'worker-test', version: 'test' });
    const h = buildHarness(createWorkerMetricsSink(registry));
    armAppliedArm(h);
    h.resolveBinanceClient.mockResolvedValue(null);

    await apply(h);

    const samples = samplesFor(await registry.metrics(), METRIC);
    expect(samples.map(reasonOf).sort()).toEqual([...APPLY_SEED_GATE_STAND_DOWN_REASONS].sort());
    const fired = samples.filter((line) => reasonOf(line) === 'no-client');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.endsWith(' 1')).toBe(true);
    expect(
      samples.filter((line) => reasonOf(line) !== 'no-client').every((line) => line.endsWith(' 0')),
    ).toBe(true);
  });

  it('declares four reasons, which is what the seed loop iterates', () => {
    // A tuple that silently lost a member would seed fewer children and every assertion above would still pass, because both sides read the same tuple. The literal count is the one thing that cannot drift with it.
    expect(APPLY_SEED_GATE_STAND_DOWN_REASONS).toHaveLength(4);
    expect([...APPLY_SEED_GATE_STAND_DOWN_REASONS].sort()).toEqual([
      'bad-symbol-info',
      'getaccount-failed',
      'no-client',
      'no-symbol-info',
    ]);
  });
});
