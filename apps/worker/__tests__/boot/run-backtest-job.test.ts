// The backtest run callback used to be an inline closure in the worker boot
// orchestrator, where its failure paths were unreachable from a test. Extracting
// it into `boot/run-backtest-job.ts` made them testable; these tests pin them.
//
// Each throw here routes the BullMQ job to the DLQ after the row is marked
// `error`, so a silent success on a missing row or a malformed params blob would
// be the worst outcome: a "completed" backtest that ran on nothing.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { profileRepoSpy, runProfileBacktestSpy, getRun, findProfile, findForSymbol } = vi.hoisted(
  () => ({
    profileRepoSpy: vi.fn(),
    runProfileBacktestSpy: vi.fn(),
    getRun: vi.fn(),
    findProfile: vi.fn(),
    findForSymbol: vi.fn(),
  }),
);

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return { ...orig, profileRepo: profileRepoSpy };
});

vi.mock('../../src/backtest/backtest-runner.js', () => ({
  runProfileBacktest: runProfileBacktestSpy,
}));

const { createRunBacktestJob } = await import('../../src/boot/run-backtest-job.js');

const VALID_PARAMS = {
  symbols: ['BTCUSDT'],
  strategyInterval: '1h',
  detailInterval: '1h',
  fromMs: 0,
  toMs: 250 * 3_600_000,
  fees: { makerBps: 0, takerBps: 0 },
  slippageBps: 0,
  initialQuoteBalance: '1000',
};

const RUN_ID = 'run-1';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';

const aProfile = (overrides: Record<string, unknown> = {}) => ({
  strategyName: 'trailing-trade',
  config: { tag: 'cfg' },
  ...overrides,
});

const strategy = {
  name: 'trailing-trade',
  configSchema: { parse: (c: unknown) => c },
};

const buildDeps = (overrides: Record<string, unknown> = {}) =>
  ({
    db: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    getKlines: vi.fn(),
    getSymbolInfo: vi.fn(),
    strategies: { get: vi.fn(() => strategy) },
    clock: { nowMs: () => 0 },
    signalCache: {},
    candleCache: {},
    cpuShare: 1,
    ...overrides,
  }) as never;

const invoke = (deps = buildDeps()) =>
  createRunBacktestJob(deps)(RUN_ID, USER_ID, PROFILE_ID, vi.fn(), () => false);

beforeEach(() => {
  getRun.mockReset();
  findProfile.mockReset();
  findForSymbol.mockReset().mockResolvedValue(null);
  runProfileBacktestSpy.mockReset();
  profileRepoSpy.mockReset().mockResolvedValue({
    backtestRuns: { get: getRun },
    profile: { findById: findProfile },
    profileSymbols: { findForSymbol },
  });
});

describe('createRunBacktestJob', () => {
  it('throws when the durable run row is gone', async () => {
    getRun.mockResolvedValue(null);

    await expect(invoke()).rejects.toThrow(`backtest run not found: ${RUN_ID}`);
    expect(runProfileBacktestSpy).not.toHaveBeenCalled();
  });

  it('throws when the profile was deleted between enqueue and run', async () => {
    getRun.mockResolvedValue({ params: VALID_PARAMS });
    findProfile.mockResolvedValue(null);

    await expect(invoke()).rejects.toThrow(`profile not found for backtest run: ${RUN_ID}`);
    expect(runProfileBacktestSpy).not.toHaveBeenCalled();
  });

  it('re-validates the stored params rather than trusting the jsonb', async () => {
    // The row was validated by the api minutes earlier; it is parsed again here
    // so a malformed blob fails cleanly instead of deref-ing deep in the engine.
    getRun.mockResolvedValue({ params: { ...VALID_PARAMS, symbols: [] } });
    findProfile.mockResolvedValue(aProfile());

    await expect(invoke()).rejects.toThrow();
    expect(runProfileBacktestSpy).not.toHaveBeenCalled();
  });

  it('throws when the profile names a strategy the registry does not know', async () => {
    getRun.mockResolvedValue({ params: VALID_PARAMS });
    findProfile.mockResolvedValue(aProfile({ strategyName: 'ghost' }));
    runProfileBacktestSpy.mockResolvedValue({
      result: { metrics: { netProfit: '0' } },
      configFingerprint: 'fp',
    });

    const deps = buildDeps({ strategies: { get: vi.fn(() => undefined) } });

    await expect(invoke(deps)).rejects.toThrow('unknown strategy: ghost');
  });

  it('builds the ledger entry from the run window and the engine metrics', async () => {
    getRun.mockResolvedValue({ params: VALID_PARAMS });
    findProfile.mockResolvedValue(aProfile());
    findForSymbol.mockResolvedValue({ reserveBaseQuantity: '0.5' });
    runProfileBacktestSpy.mockResolvedValue({
      result: { metrics: { netProfit: '12.5' } },
      configFingerprint: 'fp-1',
    });

    const out = await invoke();

    expect(out.configFingerprint).toBe('fp-1');
    expect(out.ledgerEntry).toMatchObject({
      configFingerprint: 'fp-1',
      strategyId: 'trailing-trade',
      symbols: ['BTCUSDT'],
      window: { fromMs: 0, toMs: 250 * 3_600_000, interval: '1h' },
      outcome: { netProfit: '12.5' },
    });
    expect(out.ledgerEntry.backtestSignature).toEqual(expect.any(String));

    // The per-symbol reserve overlay reaches the engine, so backtest sell-sizing
    // mirrors the live per-tick reserve.
    const args = runProfileBacktestSpy.mock.calls[0]?.[1] as {
      reserveBySymbol: Map<string, string | null>;
    };
    expect(args.reserveBySymbol.get('BTCUSDT')).toBe('0.5');
  });
});
