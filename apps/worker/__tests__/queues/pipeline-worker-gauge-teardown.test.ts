// A per-profile gauge child outlives the profile that owned it. prom-client
// keeps exporting the last value it was given, so a stopped profile still
// reports a live-looking reading forever: the operator's dashboard shows a
// profile that no longer exists, and any alert reading that series can never
// resolve. Removing the child is what lets Prometheus mark the series stale.
//
// Both teardown paths have to do it. Disposal reaches the same teardown through
// the pipeline's `unsubscribe` callback, so a forget wired only into the
// unsubscribe JOB would leave every disposed profile's child behind.

import { describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { registerPipelineWorker } from '../../src/queues/pipeline-worker.js';
import type { PipelineWorkerDeps } from '../../src/queues/pipeline-worker.js';
import type { QueueSet } from '../../src/queues/queue-set.js';

const repoMocks = vi.hoisted(() => ({
  profilesFindById: vi.fn(),
}));

// The dispose handler is stubbed so this suite can reach the `unsubscribe`
// callback the pipeline hands it without standing up the whole disposal (order
// cancels, Binance reads, notifier). What is under test is that the callback
// funnels into the same teardown, not what the disposal does around it.
const disposeCalls = vi.hoisted(() => ({
  deps: null as { unsubscribe: (ids: unknown) => Promise<void> } | null,
}));
vi.mock('../../src/queues/pipeline-handlers/dispose-profile.js', () => ({
  handleDisposeProfile: async (deps: { unsubscribe: (ids: unknown) => Promise<void> }) => {
    disposeCalls.deps = deps;
  },
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(async () => ({
      scope: {},
      profile: { findById: repoMocks.profilesFindById },
    })),
  };
});

const ids = {
  userId: asUserId('11111111-1111-4111-8111-111111111111'),
  accountId: asAccountId('22222222-2222-4222-8222-222222222222'),
  profileId: asProfileId('33333333-3333-4333-8333-333333333333'),
};

const silentLogger = {
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

const buildHarness = (): {
  invoke: (name: string, data: unknown) => Promise<void>;
  forget: ReturnType<typeof vi.fn>;
} => {
  repoMocks.profilesFindById.mockReset();
  // Absent from the DB is the ordinary teardown case: the profile is gone.
  repoMocks.profilesFindById.mockResolvedValue(null);
  disposeCalls.deps = null;

  const forget = vi.fn();
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
    redis: { get: async () => null, set: async () => 'OK', del: async () => 1 } as unknown as Redis,
    profileManager: {
      disable: vi.fn(async () => undefined),
    } as unknown as PipelineWorkerDeps['profileManager'],
    strategies: { get: () => undefined } as unknown as PipelineWorkerDeps['strategies'],
    executor: { apply: vi.fn() } as unknown as PipelineWorkerDeps['executor'],
    statePort: { mutate: vi.fn() } as unknown as PipelineWorkerDeps['statePort'],
    clock: { nowMs: () => 1_700_000_000_000 },
    chain: {
      run: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
      size: () => 0,
    },
    logger: silentLogger,
    notifyRegistry: {} as PipelineWorkerDeps['notifyRegistry'],
    resolveBinanceClient: (async () => null) as PipelineWorkerDeps['resolveBinanceClient'],
    symbolStateDeps: {} as PipelineWorkerDeps['symbolStateDeps'],
    metrics: { record: vi.fn(), forget },
  } as unknown as PipelineWorkerDeps;

  registerPipelineWorker(queueSet, deps);
  if (captured === null) throw new Error('test setup: registerWorker did not capture handler');

  return {
    invoke: async (name, data) => {
      if (captured === null) throw new Error('handler not captured');
      await captured({ name, data, id: 'test-job' } as unknown as Job);
    },
    forget,
  };
};

describe('per-profile gauge teardown', () => {
  it('retires the profile gauge child when the profile is torn down', async () => {
    const h = buildHarness();
    await h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.forget).toHaveBeenCalledWith('binance_api_weight', { profileId: ids.profileId });
  });

  it('retires it on the disposal path too, through the same teardown', async () => {
    const h = buildHarness();
    await h.invoke('dispose-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      disposition: 'cancel-orders',
    });
    const disposeDeps = disposeCalls.deps;
    if (!disposeDeps) throw new Error('dispose handler was not reached');
    await disposeDeps.unsubscribe(ids);
    expect(h.forget).toHaveBeenCalledWith('binance_api_weight', { profileId: ids.profileId });
  });

  it('does not retire the child when the profile is still enabled', async () => {
    // The operator restarted it before the teardown job landed. Forgetting here
    // would blank a live profile's series until its next scrape.
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValueOnce({ id: ids.profileId, enabled: true });
    await h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.forget).not.toHaveBeenCalled();
  });
});
