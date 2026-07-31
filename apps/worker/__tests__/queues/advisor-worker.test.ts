import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job, Processor } from 'bullmq';
import pino from 'pino';
import { z } from 'zod';
import type { QueueSet } from '../../src/queues/queue-set.js';
import type { AdvisorJobData } from '../../src/queues/job-payloads.js';
import type { LlmAssist } from '@app/llm';

// DB: fake profileRepo whose bound methods the handler drives. Same shape as the
// backtest-worker test — no real Postgres.
const repoMocks = vi.hoisted(() => ({
  getVariant: vi.fn(async () => ({ status: 'running' }) as { status: string } | null),
  completeVariant: vi.fn(async () => undefined),
  runGet: vi.fn(
    async () =>
      ({ status: 'done', result: { params: {}, metrics: {} }, backtestSignature: 'sig1' }) as {
        status: string;
        result: unknown;
        backtestSignature: string | null;
      } | null,
  ),
  findById: vi.fn(async () => ({
    strategyName: 'trailing-trade',
    strategyVersion: '1.0.0',
    config: {},
    enablementPolicy: null as unknown,
  })),
  listForMarket: vi.fn(async () => [] as unknown[]),
  profileRepo: vi.fn(async () => ({
    backtestAdvisorResults: {
      getVariant: repoMocks.getVariant,
      completeVariant: repoMocks.completeVariant,
    },
    backtestRuns: { get: repoMocks.runGet },
    profile: { findById: repoMocks.findById },
    resultLedger: { listForMarket: repoMocks.listForMarket },
  })),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return { ...orig, profileRepo: repoMocks.profileRepo };
});

// LLM: the pure assembly + generation are @app/llm's own tested concern; the
// worker test stubs them so it exercises only the handler's control flow (the
// DB-row idempotency guard, the error branches, the rethrow). AdvisorConfigStaleError
// is kept real so the handler's `instanceof` guard works.
const llmMocks = vi.hoisted(() => ({
  buildImproveInput: vi.fn(() => ({ baseConfig: {}, input: { context: {} } })),
  runAdvisor: vi.fn(async () => ({ summary: 'ok', suggestions: [{ id: 's1' }] })),
  partitionSuggestions: vi.fn(() => ({ valid: [{ id: 's1' }], dropped: [] })),
}));

vi.mock('@app/llm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/llm')>();
  return {
    ...orig,
    buildImproveInput: llmMocks.buildImproveInput,
    runAdvisor: llmMocks.runAdvisor,
    partitionSuggestions: llmMocks.partitionSuggestions,
  };
});

const { registerAdvisorWorker } = await import('../../src/queues/advisor-worker.js');

const silentLogger = pino({ level: 'silent' });

// A registry whose `get` returns a plugin with a real zod schema so the handler's
// `z.toJSONSchema(plugin.configSchema)` call works; everything downstream is mocked.
const strategies = {
  get: () => ({ configSchema: z.object({}) }),
} as never;

const availableLlm = { available: true } as LlmAssist;

function harness() {
  let processor: Processor<AdvisorJobData> | undefined;
  const queueSet = {
    registerWorker: <T>(_name: string, p: Processor<T>) => {
      processor = p as unknown as Processor<AdvisorJobData>;
      return {} as never;
    },
  } as unknown as QueueSet;
  const invoke = (data: AdvisorJobData): Promise<unknown> => {
    if (!processor) throw new Error('worker not registered');
    return Promise.resolve(processor({ data } as unknown as Job<AdvisorJobData>, 'tok'));
  };
  return { queueSet, invoke };
}

const JOB: AdvisorJobData = { runId: 'r1', userId: 'u1', profileId: 'p1', variant: 'safe' };

beforeEach(() => {
  for (const m of Object.values(repoMocks)) m.mockClear();
  for (const m of Object.values(llmMocks)) m.mockClear();
  repoMocks.profileRepo.mockResolvedValue({
    backtestAdvisorResults: {
      getVariant: repoMocks.getVariant,
      completeVariant: repoMocks.completeVariant,
    },
    backtestRuns: { get: repoMocks.runGet },
    profile: { findById: repoMocks.findById },
    resultLedger: { listForMarket: repoMocks.listForMarket },
  });
  repoMocks.getVariant.mockResolvedValue({ status: 'running' });
  repoMocks.runGet.mockResolvedValue({
    status: 'done',
    result: { params: {}, metrics: {} },
    backtestSignature: 'sig1',
  });
  repoMocks.findById.mockResolvedValue({
    strategyName: 'trailing-trade',
    strategyVersion: '1.0.0',
    config: {},
    enablementPolicy: null,
  });
  repoMocks.listForMarket.mockResolvedValue([]);
  llmMocks.buildImproveInput.mockReturnValue({ baseConfig: {}, input: { context: {} } });
  llmMocks.runAdvisor.mockResolvedValue({ summary: 'ok', suggestions: [{ id: 's1' }] });
  llmMocks.partitionSuggestions.mockReturnValue({ valid: [{ id: 's1' }], dropped: [] });
});

const register = (llm: LlmAssist) => {
  const { queueSet, invoke } = harness();
  registerAdvisorWorker(queueSet, {
    db: {} as never,
    logger: silentLogger,
    resolveLlm: async () => llm,
    strategies,
  });
  return invoke;
};

describe('registerAdvisorWorker', () => {
  it('runs the advisor on a running row and writes the done result', async () => {
    const invoke = register(availableLlm);
    await invoke(JOB);
    expect(llmMocks.runAdvisor).toHaveBeenCalledOnce();
    expect(repoMocks.completeVariant).toHaveBeenCalledWith({
      runId: 'r1',
      variant: 'safe',
      status: 'done',
      summary: 'ok',
      suggestions: [{ id: 's1' }],
      dropped: [],
      errorReason: null,
    });
  });

  it('records error(failed) and rethrows (→ DLQ) when the advisor throws', async () => {
    llmMocks.runAdvisor.mockRejectedValueOnce(new Error('model boom'));
    const invoke = register(availableLlm);
    await expect(invoke(JOB)).rejects.toThrow('model boom');
    expect(repoMocks.completeVariant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorReason: 'failed' }),
    );
  });

  it('is idempotent: a row that is not running is a noop (no re-bill)', async () => {
    repoMocks.getVariant.mockResolvedValueOnce({ status: 'done' });
    const invoke = register(availableLlm);
    await expect(invoke(JOB)).resolves.toBeUndefined();
    expect(llmMocks.runAdvisor).not.toHaveBeenCalled();
    expect(repoMocks.completeVariant).not.toHaveBeenCalled();
  });

  it('is idempotent: a missing row is a noop', async () => {
    repoMocks.getVariant.mockResolvedValueOnce(null);
    const invoke = register(availableLlm);
    await expect(invoke(JOB)).resolves.toBeUndefined();
    expect(llmMocks.runAdvisor).not.toHaveBeenCalled();
    expect(repoMocks.completeVariant).not.toHaveBeenCalled();
  });

  it('records error(not-configured) without calling the model when the credential vanished', async () => {
    const invoke = register({ available: false } as LlmAssist);
    await invoke(JOB);
    expect(llmMocks.runAdvisor).not.toHaveBeenCalled();
    expect(repoMocks.completeVariant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorReason: 'not-configured' }),
    );
  });

  it('records error without rethrowing when the run is not done (nothing to retry)', async () => {
    repoMocks.runGet.mockResolvedValueOnce({
      status: 'queued',
      result: null,
      backtestSignature: null,
    });
    const invoke = register(availableLlm);
    await expect(invoke(JOB)).resolves.toBeUndefined();
    expect(llmMocks.runAdvisor).not.toHaveBeenCalled();
    expect(repoMocks.completeVariant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorReason: 'failed' }),
    );
  });
});
