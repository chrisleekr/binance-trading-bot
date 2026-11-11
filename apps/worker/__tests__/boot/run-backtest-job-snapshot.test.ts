import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { BACKTEST_ENGINE_REVISION } from '@app/strategy-core';

const { profileRepoSpy, runProfileBacktestSpy, getRun, findProfile } = vi.hoisted(() => ({
  profileRepoSpy: vi.fn(),
  runProfileBacktestSpy: vi.fn(),
  getRun: vi.fn(),
  findProfile: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return { ...orig, profileRepo: profileRepoSpy };
});

vi.mock('../../src/backtest/backtest-runner.js', () => ({
  runProfileBacktest: runProfileBacktestSpy,
}));

const { createRunBacktestJob } = await import('../../src/boot/run-backtest-job.js');

const BUILD = 'abc1234';
const FROZEN = { tag: 'frozen' };
const EDITED = { tag: 'edited' };

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  strategyName: 'trailing-trade',
  strategyVersion: '1.0.0',
  engineRevision: BACKTEST_ENGINE_REVISION,
  buildId: BUILD,
  effectiveConfig: FROZEN,
  ...overrides,
});

const params = (overrides: Record<string, unknown> = {}) => ({
  symbols: ['BTCUSDT'],
  strategyInterval: '1h',
  decisionInterval: '1h',
  detailInterval: '1h',
  fromMs: 0,
  toMs: 250 * 3_600_000,
  fees: { makerBps: 0, takerBps: 0 },
  slippageBps: 0,
  initialQuoteBalance: '1000',
  snapshot: snapshot(),
  ...overrides,
});

const strategy = {
  name: 'trailing-trade',
  version: '1.0.0',
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
    cpuShare: 1,
    buildId: BUILD,
    ...overrides,
  }) as never;

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const PROFILE = '22222222-2222-4222-8222-222222222222';

interface JobOutcome {
  readonly configFingerprint: string;
  readonly ledgerEntry: {
    readonly backtestSignature: string;
    readonly params: unknown;
    readonly window: Record<string, unknown>;
  };
}

async function runJob(
  stored: unknown,
  profile: Record<string, unknown> = { strategyName: 'trailing-trade', config: EDITED },
  deps = buildDeps(),
): Promise<JobOutcome> {
  getRun.mockResolvedValue({ params: stored });
  findProfile.mockResolvedValue(profile);
  return (await createRunBacktestJob(deps)(
    'run-1',
    USER,
    ACCOUNT,
    PROFILE,
    vi.fn(),
    () => false,
  )) as unknown as JobOutcome;
}

const runnerArgs = () => runProfileBacktestSpy.mock.calls[0]?.[1] as Record<string, unknown>;

const replayedWithContext = (contextFingerprint: string) => ({
  result: { metrics: { netProfit: '0' }, simulation: { contextFingerprint } },
  configFingerprint: 'fp',
});

beforeEach(() => {
  getRun.mockReset();
  findProfile.mockReset();
  runProfileBacktestSpy.mockReset().mockResolvedValue(replayedWithContext('ctx-A'));
  profileRepoSpy.mockReset().mockResolvedValue({
    backtestRuns: { get: getRun },
    profile: { findById: findProfile },
  });
});

describe('profile edit after queueing does not change executed or signed config', () => {
  it('executes the frozen config', async () => {
    await runJob(params());
    expect(runnerArgs()['effectiveConfig']).toEqual(FROZEN);
  });

  it('never hands the runner the current profile config', async () => {
    await runJob(params());
    expect(runnerArgs()['profileConfig']).toBeUndefined();
  });

  it('runs the strategy named in the snapshot after the profile switches', async () => {
    await runJob(params(), { strategyName: 'momentum', config: EDITED });
    expect(runnerArgs()['strategyName']).toBe('trailing-trade');
  });

  it('records the frozen config on the ledger entry', async () => {
    const out = await runJob(params());
    expect(out.ledgerEntry.params).toEqual(FROZEN);
  });

  it('signs the same config whatever the profile became', async () => {
    const first = await runJob(params(), { strategyName: 'trailing-trade', config: EDITED });
    const second = await runJob(params(), {
      strategyName: 'trailing-trade',
      config: { tag: 'edited-again' },
    });
    expect(first.ledgerEntry.backtestSignature).toEqual(expect.any(String));
    expect(second.ledgerEntry.backtestSignature).toBe(first.ledgerEntry.backtestSignature);
  });
});

describe('absent snapshot, version, revision or sha mismatch fails with resubmit message; unknown sha executes', () => {
  const RESUBMIT = /resubmit/i;

  it.each([
    ['snapshot is absent', params({ snapshot: undefined })],
    ['decision interval is absent', params({ decisionInterval: undefined })],
    ['strategy version differs', params({ snapshot: snapshot({ strategyVersion: '0.9.0' }) })],
    [
      'engine revision differs',
      params({ snapshot: snapshot({ engineRevision: BACKTEST_ENGINE_REVISION - 1 }) }),
    ],
    ['build differs', params({ snapshot: snapshot({ buildId: 'def5678' }) })],
  ])('asks for a resubmission when the %s', async (_case, stored) => {
    await expect(runJob(stored)).rejects.toThrow(RESUBMIT);
    expect(runProfileBacktestSpy).not.toHaveBeenCalled();
  });

  it('executes the frozen config when the snapshot build is unknown', async () => {
    await runJob(params({ snapshot: snapshot({ buildId: 'unknown' }) }));
    expect(runnerArgs()['effectiveConfig']).toEqual(FROZEN);
  });

  it('executes the frozen config when the worker build is unknown', async () => {
    await runJob(params(), undefined, buildDeps({ buildId: 'unknown' }));
    expect(runnerArgs()['effectiveConfig']).toEqual(FROZEN);
  });
});

describe('reversed symbols give the same signature', () => {
  it('signs a basket as a set', async () => {
    const forward = await runJob(params({ symbols: ['AAAUSDT', 'BBBUSDT'] }));
    const reversed = await runJob(params({ symbols: ['BBBUSDT', 'AAAUSDT'] }));
    expect(forward.ledgerEntry.backtestSignature).toEqual(expect.any(String));
    expect(reversed.ledgerEntry.backtestSignature).toBe(forward.ledgerEntry.backtestSignature);
  });
});

describe('experiment-only change alters signature, not context', () => {
  const VARIANT = params({ snapshot: snapshot({ effectiveConfig: { tag: 'variant' } }) });

  it('changes the signature when only the frozen config changes', async () => {
    const base = await runJob(params());
    const variant = await runJob(VARIANT);
    expect(variant.ledgerEntry.backtestSignature).not.toBe(base.ledgerEntry.backtestSignature);
  });

  it('records the replay context on the ledger window of both', async () => {
    const base = await runJob(params());
    const variant = await runJob(VARIANT);
    expect(base.ledgerEntry.window['contextFingerprint']).toBe('ctx-A');
    expect(variant.ledgerEntry.window['contextFingerprint']).toBe('ctx-A');
  });

  it('changes the signature when the replay context changes', async () => {
    const first = await runJob(params());
    runProfileBacktestSpy.mockResolvedValue(replayedWithContext('ctx-B'));
    const second = await runJob(params());
    expect(second.ledgerEntry.backtestSignature).not.toBe(first.ledgerEntry.backtestSignature);
  });
});
