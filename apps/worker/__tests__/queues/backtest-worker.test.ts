import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job, Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import type { BacktestRunRow, ProfileRepo } from '@app/db';
import type { QueueSet } from '../../src/queues/queue-set.js';
import type { BacktestJobData } from '../../src/queues/job-payloads.js';
import type { BacktestWorkerDeps } from '../../src/queues/backtest-worker.js';
import type { NotifyEvent } from '../../src/notifiers/notify-event.js';

type RepoMethod<K extends keyof ProfileRepo['backtestRuns']> = ProfileRepo['backtestRuns'][K];

const repoMocks = vi.hoisted(() => ({
  markRunning: vi.fn<RepoMethod<'markRunning'>>(async () => true),
  updateProgress: vi.fn<RepoMethod<'updateProgress'>>(async () => undefined),
  complete: vi.fn<RepoMethod<'complete'>>(async () => undefined),
  fail: vi.fn<RepoMethod<'fail'>>(async () => undefined),
  get: vi.fn<RepoMethod<'get'>>(async () => null),
  failById: vi.fn(async () => true),
  ledgerUpsert: vi.fn(async () => undefined),
  profileRepo: vi.fn(async () => ({
    backtestRuns: {
      markRunning: repoMocks.markRunning,
      updateProgress: repoMocks.updateProgress,
      complete: repoMocks.complete,
      fail: repoMocks.fail,
      get: repoMocks.get,
    },
    resultLedger: { upsert: repoMocks.ledgerUpsert },
  })),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: repoMocks.profileRepo,
    repo: {
      ...orig.repo,
      backtestRuns: { ...orig.repo.backtestRuns, failById: repoMocks.failById },
    },
  };
});

// `get` returns a full `BacktestRunRow`, so the mock builds one rather than a two-field shape: narrowing the mock's return would let a column the worker reads disappear from the row type without failing here.
const runRow = (over: Partial<BacktestRunRow> = {}): BacktestRunRow => ({
  id: '00000000-0000-0000-0000-0000000000dd',
  profileId: '00000000-0000-0000-0000-0000000000bb',
  symbols: ['BTCUSDT'],
  params: {},
  status: 'done',
  progress: 100,
  progressDetail: null,
  result: null,
  error: null,
  configFingerprint: null,
  backtestSignature: null,
  parentRunId: null,
  createdAt: new Date(0),
  startedAt: null,
  finishedAt: null,
  ...over,
});

const emitEvent = vi.hoisted(() =>
  vi.fn<typeof import('../../src/executor/event-emitter.js').emitEvent>(async () => undefined),
);
vi.mock('../../src/executor/event-emitter.js', () => ({ emitEvent }));

// Import after mocks are registered.
const { registerBacktestWorker } = await import('../../src/queues/backtest-worker.js');
const { BacktestCancelledError } = await import('../../src/backtest/backtest-runner.js');

const silentLogger = pino({ level: 'silent' });

// Profile-event notifier stub (Slack/Telegram/webhook fan-out); the real one
// gates on the profile's subscription and never throws.
const notifyEvent = vi.fn<NotifyEvent>(async () => undefined);

function harness() {
  let processor: Processor<BacktestJobData> | undefined;
  const queueSet = {
    registerWorker: <T>(_name: string, p: Processor<T>) => {
      processor = p as unknown as Processor<BacktestJobData>;
      return {} as never;
    },
  } as unknown as QueueSet;
  const invoke = (data: BacktestJobData): Promise<unknown> => {
    if (!processor) throw new Error('worker not registered');
    return Promise.resolve(processor({ data } as unknown as Job<BacktestJobData>, 'tok'));
  };
  return { queueSet, invoke };
}

const JOB: BacktestJobData = { runId: 'r1', userId: 'u1', accountId: 'a1', profileId: 'p1' };
const RESULT = { metrics: { totalTrades: 12, profitFactor: 1.35, alphaVsHoldPct: 3.2 } } as never;
// deps.run resolves to { result, configFingerprint }; the handler threads the
// fingerprint into complete().
const FP = 'fp00000000000001';
const LEDGER_ENTRY = {
  backtestSignature: 'sig000000000001',
  configFingerprint: FP,
  strategyId: 'trailing-trade',
  symbols: ['BTCUSDT'],
  window: { fromMs: 0, toMs: 1000, interval: '1h' },
  params: {},
  outcome: { totalReturnPct: 7 },
};
const RUN_OUT = {
  result: RESULT,
  configFingerprint: FP,
  ledgerEntry: LEDGER_ENTRY,
} as Awaited<ReturnType<BacktestWorkerDeps['run']>>;

beforeEach(() => {
  for (const m of Object.values(repoMocks)) m.mockClear();
  // Restore the default profileRepo (a test may override it to throw).
  repoMocks.profileRepo.mockResolvedValue({
    backtestRuns: {
      markRunning: repoMocks.markRunning,
      updateProgress: repoMocks.updateProgress,
      complete: repoMocks.complete,
      fail: repoMocks.fail,
      get: repoMocks.get,
    },
    resultLedger: { upsert: repoMocks.ledgerUpsert },
  });
  repoMocks.markRunning.mockResolvedValue(true);
  repoMocks.get.mockResolvedValue(null);
  repoMocks.failById.mockResolvedValue(true);
  emitEvent.mockClear();
  notifyEvent.mockClear();
});

describe('registerBacktestWorker', () => {
  it('drives markRunning → complete and emits backtest-complete on success', async () => {
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => RUN_OUT);
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await invoke(JOB);
    expect(repoMocks.markRunning).toHaveBeenCalledWith('r1');
    expect(run).toHaveBeenCalledOnce();
    expect(repoMocks.complete).toHaveBeenCalledWith(
      'r1',
      RESULT,
      FP,
      LEDGER_ENTRY.backtestSignature,
    );
    // The durable results ledger is written after a successful complete().
    expect(repoMocks.ledgerUpsert).toHaveBeenCalledWith(LEDGER_ENTRY);
    expect(repoMocks.fail).not.toHaveBeenCalled();
    const completeTopics = emitEvent.mock.calls.map((c) => c[3]);
    expect(completeTopics).toContain('backtest-complete');
  });

  it('notifies the operator channels when a run completes', async () => {
    // A completed run fans out to the profile's notifiers.
    repoMocks.get.mockResolvedValue(runRow());
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => RUN_OUT);
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await invoke(JOB);
    expect(notifyEvent).toHaveBeenCalledOnce();
    expect(notifyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'backtest-complete',
        operatorId: 'u1',
        accountId: 'a1',
        profileId: 'p1',
        symbol: 'BTCUSDT',
      }),
    );
    expect((notifyEvent.mock.calls[0]?.[0] as { body: string }).body).toContain(
      'Backtest finished',
    );
  });

  it('includes formatted fields and a results deep link when PUBLIC_WEB_URL is set', async () => {
    repoMocks.get.mockResolvedValue(runRow());
    const { queueSet, invoke } = harness();
    const metrics = { totalTrades: 8, profitFactor: 1.4, alphaVsHoldPct: 5 };
    const run = vi.fn(async () => ({ ...RUN_OUT, result: { metrics } }) as never);
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
      publicWebUrl: 'http://localhost:5173',
    });
    await invoke(JOB);
    const arg = notifyEvent.mock.calls[0]?.[0];
    expect(arg?.link).toBe('http://localhost:5173/accounts/a1/profiles/p1/backtest?run=r1');
    expect(arg?.fields).toEqual([
      { label: 'Trades', value: '8' },
      { label: 'Profit factor', value: '1.40' },
      { label: 'vs buy-and-hold', value: '+5.00%' },
    ]);
  });

  it('omits the link when PUBLIC_WEB_URL is unset', async () => {
    repoMocks.get.mockResolvedValue(runRow());
    const { queueSet, invoke } = harness();
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run: vi.fn(async () => RUN_OUT),
    });
    await invoke(JOB);
    expect((notifyEvent.mock.calls[0]?.[0] as { link?: string }).link).toBeUndefined();
  });

  // The notification one-liner has four output branches; assert each renders.
  it.each([
    [{ totalTrades: 0, profitFactor: 2.1, alphaVsHoldPct: 5 }, 'no trades were taken'],
    [{ totalTrades: 8, profitFactor: null, alphaVsHoldPct: 5 }, 'profit factor n/a'],
    [{ totalTrades: 8, profitFactor: 1.4, alphaVsHoldPct: -3.2 }, 'lagged buy-and-hold by 3.20%'],
  ])('renders the completion text for %o', async (metrics, expected) => {
    repoMocks.get.mockResolvedValue(runRow());
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => ({ ...RUN_OUT, result: { metrics } }) as never);
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await invoke(JOB);
    expect((notifyEvent.mock.calls[0]?.[0] as { body: string }).body).toContain(expected);
  });

  it('forwards progress to updateProgress (pct + detail) and backtest-progress', async () => {
    const { queueSet, invoke } = harness();
    const update = { pct: 42, phase: 'replay' as const, processed: 100, total: 200 };
    const run = vi.fn(async (_r, _u, _a, _p, onProgress: (u: typeof update) => void) => {
      onProgress(update);
      return RUN_OUT;
    });
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await invoke(JOB);
    // pct goes to the integer column; the rest is the persisted progress detail.
    expect(repoMocks.updateProgress).toHaveBeenCalledWith('r1', 42, {
      phase: 'replay',
      processed: 100,
      total: 200,
    });
    const progressCall = emitEvent.mock.calls.find((c) => c[3] === 'backtest-progress');
    expect(progressCall?.[4]).toEqual({
      runId: 'r1',
      pct: 42,
      phase: 'replay',
      processed: 100,
      total: 200,
    });
  });

  it('marks the run failed via failById and rethrows when the engine throws (→ DLQ)', async () => {
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    registerBacktestWorker(queueSet, {
      db: { tag: 'db' } as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await expect(invoke(JOB)).rejects.toThrow('boom');
    expect(repoMocks.failById).toHaveBeenCalledWith({ tag: 'db' }, 'r1', 'boom');
    expect(repoMocks.complete).not.toHaveBeenCalled();
  });

  it('on cancellation: does not failById, does not rethrow, emits backtest-complete', async () => {
    // The run was cancelled out-of-band (the cancel endpoint already set the row
    // to 'cancelled'). The worker must NOT failById (would clobber cancelled→
    // error) and must NOT rethrow (no DLQ/retry); it just emits complete.
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => {
      throw new BacktestCancelledError('r1');
    });
    registerBacktestWorker(queueSet, {
      db: { tag: 'db' } as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await expect(invoke(JOB)).resolves.toBeUndefined();
    expect(repoMocks.failById).not.toHaveBeenCalled();
    expect(repoMocks.complete).not.toHaveBeenCalled();
    expect(notifyEvent).not.toHaveBeenCalled();
    const completeTopics = emitEvent.mock.calls.map((c) => c[3]);
    expect(completeTopics).toContain('backtest-complete');
  });

  it('marks the run errored when profileRepo throws before the run is scoped (#363)', async () => {
    // The pre-scope ownership lookup failing (transient DB blip) must still mark
    // the run error rather than stranding it queued forever. There is no scope,
    // so the catch uses the global failById.
    repoMocks.profileRepo.mockRejectedValueOnce(new Error('Connection is closed'));
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => RUN_OUT);
    registerBacktestWorker(queueSet, {
      db: { tag: 'db' } as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await expect(invoke(JOB)).rejects.toThrow('Connection is closed');
    expect(run).not.toHaveBeenCalled();
    expect(repoMocks.failById).toHaveBeenCalledWith({ tag: 'db' }, 'r1', 'Connection is closed');
  });

  it('skips reprocessing when markRunning reports the run is already terminal', async () => {
    repoMocks.markRunning.mockResolvedValueOnce(false);
    const { queueSet, invoke } = harness();
    const run = vi.fn(async () => RUN_OUT);
    registerBacktestWorker(queueSet, {
      db: {} as never,
      redis: {} as unknown as Redis,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      notifyEvent,
      run,
    });
    await invoke(JOB);
    expect(repoMocks.markRunning).toHaveBeenCalledWith('r1');
    expect(run).not.toHaveBeenCalled();
    expect(repoMocks.complete).not.toHaveBeenCalled();
    expect(repoMocks.fail).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
