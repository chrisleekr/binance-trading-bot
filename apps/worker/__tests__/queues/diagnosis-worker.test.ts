import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job, Processor } from 'bullmq';
import pino from 'pino';
import { DIAGNOSIS_STEPS, type ProfileDiagnosisInput } from '@app/contracts';
import type { QueueSet } from '../../src/queues/queue-set.js';
import type { DiagnosisJobData } from '../../src/queues/job-payloads.js';

const repoMocks = vi.hoisted(() => ({
  findById: vi.fn(),
  patchSteps: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
  binanceModeById: vi.fn(async () => 'live' as 'live' | 'test' | null),
  profileRepo: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: repoMocks.profileRepo,
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: repoMocks.binanceModeById },
    },
  };
});

// The rest client is built at registration; nothing in these tests reaches the
// exchange because the probe itself is stubbed.
vi.mock('@app/binance', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/binance')>();
  return {
    ...orig,
    createBinanceRest: () => ({ getAllTickers24hr: vi.fn(), getKlines: vi.fn() }),
  };
});

const gatherMocks = vi.hoisted(() => ({ gatherDiagnosisInput: vi.fn() }));
vi.mock('../../src/queues/diagnosis/gather.js', () => gatherMocks);

const probeMocks = vi.hoisted(() => ({ probeLiveFunnel: vi.fn(async () => null) }));
vi.mock('../../src/queues/diagnosis/live-funnel.js', () => probeMocks);

const { registerDiagnosisWorker } = await import('../../src/queues/diagnosis-worker.js');

const silentLogger = pino({ level: 'silent' });

const NOW = 1_700_000_000_000;

// A profile with nothing wrong: every rung resolves without a finding, so any
// step that is NOT terminal in an assertion below is one the worker had not
// reached yet, never one that had nothing to say.
const healthyInput = (): ProfileDiagnosisInput => ({
  nowMs: NOW,
  profile: {
    enabled: true,
    quoteAsset: 'USDT',
    config: {},
    discoveryEnabled: true,
    maxAutoSymbols: 5,
    refreshPeriodMs: 900_000,
    autoSymbolCount: 1,
  },
  worker: { heartbeatPresent: true },
  halts: [],
  conditions: [],
  snapshots: [
    {
      capturedAtMs: NOW - 60_000,
      breadthOk: true,
      funnel: {
        universe: 400,
        quote: 400,
        assetPolicy: 400,
        blacklist: 400,
        liquidity: 200,
        activity: 100,
        spread: 100,
        changeBand: 50,
        age: 20,
        trend: 10,
        eligible: 4,
        added: 1,
        breadthOk: true,
      },
    },
  ],
  reasonAttribution: {},
  discoveryHealthWindow: 3,
  timeline: [],
});

const LIVE_FUNNEL = {
  universe: 401,
  quote: 401,
  assetPolicy: 401,
  blacklist: 401,
  liquidity: 201,
  activity: 101,
  spread: 101,
  changeBand: 51,
  age: 21,
  trend: 11,
  eligible: 5,
  added: 1,
  breadthOk: true,
};

const gathered = (over: Partial<ProfileDiagnosisInput> = {}) => ({
  input: { ...healthyInput(), ...over },
  discovery: {
    config: {} as never,
    quoteAsset: 'USDT',
    mode: 'live' as const,
    autoSymbols: ['BTCUSDT'],
    manualSymbols: [],
  },
});

const JOB: DiagnosisJobData = {
  runId: 'run-1',
  userId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  profileId: '33333333-3333-4333-8333-333333333333',
  liveProbe: true,
};

function harness(logger: typeof silentLogger = silentLogger) {
  let processor: Processor<DiagnosisJobData> | undefined;
  const queueSet = {
    registerWorker: <T>(_name: string, p: Processor<T>) => {
      processor = p as unknown as Processor<DiagnosisJobData>;
      return {} as never;
    },
  } as unknown as QueueSet;
  registerDiagnosisWorker(queueSet, {
    db: {} as never,
    redis: {} as never,
    logger,
    strategies: { get: () => undefined } as never,
    weightGovernor: {} as never,
    // The probe never gets far enough here to read it; the live-funnel suite owns the classification's own behaviour.
    getAssetPolicy: async () => ({
      stablecoinOrFiatBases: new Set(['RLUSD', 'ZWL']),
      taggedStablecoinBases: new Set(['RLUSD']),
      fiatQuoteAssets: new Set(['ZWL']),
      tradingSymbols: new Set(['BTCUSDT']),
    }),
    nowMs: () => NOW,
  });
  return (data: DiagnosisJobData = JOB): Promise<unknown> => {
    if (!processor) throw new Error('worker not registered');
    return Promise.resolve(processor({ data } as unknown as Job<DiagnosisJobData>, 'tok'));
  };
}

/** The steps as of the Nth publish, keyed by step id. */
const publishedAt = (call: number): Record<string, { status: string }> => {
  const steps = repoMocks.patchSteps.mock.calls[call]?.[1] as
    readonly { id: string; status: string }[] | undefined;
  if (!steps) throw new Error(`no patchSteps call at index ${call}`);
  return Object.fromEntries(steps.map((s) => [s.id, s]));
};

beforeEach(() => {
  for (const m of Object.values(repoMocks)) m.mockClear();
  probeMocks.probeLiveFunnel.mockClear();
  gatherMocks.gatherDiagnosisInput.mockClear();
  repoMocks.profileRepo.mockResolvedValue({
    diagnosisRuns: {
      findById: repoMocks.findById,
      patchSteps: repoMocks.patchSteps,
      finish: repoMocks.finish,
      fail: repoMocks.fail,
    },
  });
  repoMocks.findById.mockResolvedValue({ id: 'run-1', status: 'queued' });
  repoMocks.binanceModeById.mockResolvedValue('live');
  gatherMocks.gatherDiagnosisInput.mockResolvedValue(gathered());
  probeMocks.probeLiveFunnel.mockResolvedValue(null);
});

describe('diagnosis worker', () => {
  it('logs the error a rung withheld from the operator line', async () => {
    // The rung runner takes the callback; nothing else proves THIS worker passes
    // one. Drop the third argument and the report still reads `unknown` while the
    // cause goes back to being invisible, which is the state the hand-off exists
    // to end.
    const lines: { stepId?: string; err?: unknown; msg?: string }[] = [];
    const recording = pino(
      { level: 'error' },
      { write: (line: string) => lines.push(JSON.parse(line)) },
    );
    const hostile = gathered();
    Object.defineProperty(hostile.input.profile, 'maxAutoSymbols', {
      get() {
        throw new Error('column missing');
      },
    });
    gatherMocks.gatherDiagnosisInput.mockResolvedValue(hostile);

    await harness(recording)();

    // The run still completes; one broken rung does not fail the ladder.
    expect(repoMocks.fail).not.toHaveBeenCalled();
    const report = repoMocks.finish.mock.calls[0]?.[1] as {
      steps: { id: string; status: string }[];
    };
    expect(report.steps.find((s) => s.id === 'symbol-slots')?.status).toBe('unknown');

    const logged = lines.find((l) => l.stepId === 'symbol-slots');
    expect(logged).toBeDefined();
    expect((logged?.err as { message?: string } | undefined)?.message).toBe('column missing');
  });

  it('walks every rung and stores the report', async () => {
    await harness()();
    expect(repoMocks.fail).not.toHaveBeenCalled();
    const report = repoMocks.finish.mock.calls[0]?.[1] as {
      steps: { id: string; status: string }[];
    };
    expect(report.steps).toHaveLength(DIAGNOSIS_STEPS.length);
    expect(report.steps.every((s) => s.status !== 'pending' && s.status !== 'running')).toBe(true);
    // Pins the fixture's stated premise. A field renamed out from under it
    // reads as `undefined` here, which the ladder scores as a blocking finding,
    // and every "is terminal" assertion above would still pass against it.
    expect(report.steps.find((s) => s.id === 'worker-alive')?.status).toBe('ok');
  });

  it('shows the probe rung running before it spends any request weight', async () => {
    let stepsWhenProbeStarted: Record<string, { status: string }> | null = null;
    probeMocks.probeLiveFunnel.mockImplementation(async () => {
      // Everything published so far is the worker's real position at the moment
      // the slow call begins. A client-side timer would have moved on by now.
      stepsWhenProbeStarted = publishedAt(repoMocks.patchSteps.mock.calls.length - 1);
      return null;
    });
    await harness()();

    const at = stepsWhenProbeStarted as unknown as Record<string, { status: string }>;
    expect(at['candidate-funnel']?.status).toBe('running');
    // Every rung before it has resolved.
    for (const id of [
      'worker-alive',
      'profile-active',
      'config-valid',
      'order-execution',
      'discovery-running',
      'market-breadth',
    ]) {
      expect(['ok', 'finding', 'skipped', 'unknown']).toContain(at[id]?.status);
    }
    // Nothing after it has started.
    for (const id of ['symbol-slots', 'entry-blockers', 'config-levers']) {
      expect(at[id]?.status).toBe('pending');
    }
  });

  it('does not advance the ladder while the probe is in flight', async () => {
    let release: (() => void) | undefined;
    const frozen = new Promise<void>((r) => (release = r));
    probeMocks.probeLiveFunnel.mockImplementation(async () => {
      await frozen;
      return null;
    });

    const running = harness()();
    await vi.waitFor(() => expect(probeMocks.probeLiveFunnel).toHaveBeenCalled());
    const publishesWhileFrozen = repoMocks.patchSteps.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(repoMocks.patchSteps.mock.calls.length).toBe(publishesWhileFrozen);
    expect(repoMocks.finish).not.toHaveBeenCalled();

    release?.();
    await running;
    expect(repoMocks.finish).toHaveBeenCalledOnce();
  });

  it('prefers the live funnel when the probe succeeds', async () => {
    probeMocks.probeLiveFunnel.mockResolvedValue(LIVE_FUNNEL);
    await harness()();
    const report = repoMocks.finish.mock.calls[0]?.[1] as { funnel: { source: string } | null };
    expect(report.funnel?.source).toBe('live');
  });

  it('falls back to the stored scan when the probe fails, and says so', async () => {
    probeMocks.probeLiveFunnel.mockResolvedValue(null);
    await harness()();
    const report = repoMocks.finish.mock.calls[0]?.[1] as { funnel: { source: string } | null };
    expect(report.funnel?.source).toBe('stored');
    expect(repoMocks.finish).toHaveBeenCalledOnce();
  });

  it('never touches the exchange when the operator declined the live probe', async () => {
    await harness()({ ...JOB, liveProbe: false });
    expect(probeMocks.probeLiveFunnel).not.toHaveBeenCalled();
    expect(repoMocks.finish).toHaveBeenCalledOnce();
  });

  it('skips a run that already reached a terminal state', async () => {
    repoMocks.findById.mockResolvedValue({ id: 'run-1', status: 'done' });
    await harness()();
    expect(repoMocks.patchSteps).not.toHaveBeenCalled();
    expect(repoMocks.finish).not.toHaveBeenCalled();
  });

  it('skips a run id that does not resolve under this profile scope', async () => {
    repoMocks.findById.mockResolvedValue(undefined);
    await harness()();
    expect(repoMocks.finish).not.toHaveBeenCalled();
    expect(repoMocks.fail).not.toHaveBeenCalled();
  });

  it('fails the run when the profile is gone rather than reporting on nothing', async () => {
    gatherMocks.gatherDiagnosisInput.mockRejectedValue(new Error('profile no longer exists'));
    await expect(harness()()).resolves.toBeUndefined();
    expect(repoMocks.fail).toHaveBeenCalledOnce();
    expect(repoMocks.finish).not.toHaveBeenCalled();
  });

  it('fails the run when the account has no resolvable Binance mode', async () => {
    repoMocks.binanceModeById.mockResolvedValue(null);
    await harness()();
    expect(repoMocks.fail).toHaveBeenCalledOnce();
    expect(gatherMocks.gatherDiagnosisInput).not.toHaveBeenCalled();
  });

  it('keeps walking the ladder when a progress write fails', async () => {
    // Progress is presentational and the rungs are held in memory until `finish`
    // writes them. Failing the run over a lost UPDATE would throw away an
    // investigation that had already answered every question it was asked.
    repoMocks.patchSteps.mockRejectedValueOnce(new Error('db gone'));

    await expect(harness()()).resolves.toBeUndefined();
    expect(repoMocks.finish).toHaveBeenCalledOnce();
    expect(repoMocks.fail).not.toHaveBeenCalled();
  });

  // The queue runs with `attempts: 1`, so a run left `running` is left there
  // forever: there is no retry coming to write a terminal status. The row has to
  // be marked on the way out, and the throw still has to reach the DLQ.
  it('marks the run errored and rethrows when the terminal write fails', async () => {
    repoMocks.finish.mockRejectedValueOnce(new Error('db gone'));

    await expect(harness()()).rejects.toThrow('db gone');
    expect(repoMocks.fail).toHaveBeenCalledOnce();
  });

  it('still surfaces the original failure when the error write itself fails', async () => {
    // Losing the row write is bad; swallowing the cause behind it is worse,
    // because the DLQ entry is then the only remaining record of what broke.
    repoMocks.finish.mockRejectedValueOnce(new Error('db gone'));
    repoMocks.fail.mockRejectedValueOnce(new Error('also gone'));

    await expect(harness()()).rejects.toThrow('db gone');
  });
});
