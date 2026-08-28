import { describe, expect, it } from 'vitest';
import {
  describeGateOutcome,
  evaluateBacktestGate,
  failedChecksDetail,
  gateThresholdChecks,
  toGateCandidates,
  type BacktestRunLike,
  type GateCandidate,
  type GatePolicyThresholds,
} from '../src/enablement-gate.js';

// Full-run gate tests keep the out-of-sample check OFF so they stay focused on
// freshness + the three full-run thresholds; a dedicated block below exercises
// requireOutOfSample.
const policy: GatePolicyThresholds = {
  minProfitFactor: 1.1,
  minTrades: 30,
  minAlphaVsHoldPct: 0,
  maxBacktestAgeDays: 14,
  requireOutOfSample: false,
  minOutOfSampleTrades: 20,
};
const FP = 'fingerprint-abc';
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const cand = (over: Partial<GateCandidate> = {}): GateCandidate => ({
  runId: 'r1',
  configFingerprint: FP,
  createdAtMs: NOW,
  metrics: { profitFactor: 2, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
  ...over,
});

const run = (candidates: readonly GateCandidate[], p: GatePolicyThresholds = policy) =>
  evaluateBacktestGate({ policy: p, currentFingerprint: FP, candidates, nowMs: NOW });

describe('evaluateBacktestGate', () => {
  it('passes when a fresh matching run clears every threshold', () => {
    const out = run([cand()]);
    expect(out).toEqual({ ok: true, runId: 'r1', matchedAtMs: NOW });
  });

  it('passes on the exact threshold boundaries (>= semantics)', () => {
    const out = run([
      cand({
        metrics: { profitFactor: 1.1, totalTrades: 30, alphaVsHoldPct: 0, outOfSample: null },
      }),
    ]);
    expect(out.ok).toBe(true);
  });

  it('fails no-matching-backtest when nothing matches the fingerprint', () => {
    expect(run([])).toEqual({ ok: false, failure: 'no-matching-backtest' });
    expect(run([cand({ configFingerprint: 'other' })])).toEqual({
      ok: false,
      failure: 'no-matching-backtest',
    });
    expect(run([cand({ configFingerprint: null })])).toEqual({
      ok: false,
      failure: 'no-matching-backtest',
    });
  });

  it('uses the newest matching run (candidates are newest-first)', () => {
    const out = run([
      cand({
        runId: 'newest',
        metrics: { profitFactor: 2, totalTrades: 40, alphaVsHoldPct: 1, outOfSample: null },
      }),
      cand({
        runId: 'older',
        metrics: { profitFactor: 9, totalTrades: 99, alphaVsHoldPct: 9, outOfSample: null },
      }),
    ]);
    expect(out).toMatchObject({ ok: true, runId: 'newest' });
  });

  it('fails stale when the matching run is older than the age limit', () => {
    const out = run([cand({ createdAtMs: NOW - 15 * DAY })]);
    expect(out).toMatchObject({ ok: false, failure: 'stale', runId: 'r1' });
    if (!out.ok && out.failure === 'stale') expect(out.ageDays).toBeCloseTo(15);
  });

  it('treats exactly the age limit as fresh (boundary)', () => {
    const out = run([cand({ createdAtMs: NOW - 14 * DAY })]);
    expect(out.ok).toBe(true);
  });

  it('staleness is checked before metrics (a stale unreadable run is stale)', () => {
    const out = run([cand({ createdAtMs: NOW - 20 * DAY, metrics: null })]);
    expect(out).toMatchObject({ ok: false, failure: 'stale' });
  });

  it('fails unreadable-result when the matching run has no parseable metrics', () => {
    expect(run([cand({ metrics: null })])).toEqual({
      ok: false,
      failure: 'unreadable-result',
      runId: 'r1',
    });
  });

  it('fails thresholds when profit factor is below the floor (or null)', () => {
    const low = run([
      cand({
        metrics: { profitFactor: 1.0, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
      }),
    ]);
    expect(low).toMatchObject({ ok: false, failure: 'thresholds' });
    if (!low.ok && low.failure === 'thresholds') {
      const pf = low.checks.find((c) => c.label === 'profit factor');
      expect(pf).toMatchObject({ ok: false, actual: '1.00', need: '>= 1.1' });
    }
    const nullPf = run([
      cand({
        metrics: { profitFactor: null, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
      }),
    ]);
    expect(nullPf).toMatchObject({ ok: false, failure: 'thresholds' });
    if (!nullPf.ok && nullPf.failure === 'thresholds') {
      expect(nullPf.checks.find((c) => c.label === 'profit factor')?.actual).toBe('n/a');
    }
  });

  it('fails thresholds when closed trades are below the minimum', () => {
    const out = run([
      cand({ metrics: { profitFactor: 2, totalTrades: 10, alphaVsHoldPct: 5, outOfSample: null } }),
    ]);
    expect(out).toMatchObject({ ok: false, failure: 'thresholds' });
    if (!out.ok && out.failure === 'thresholds') {
      expect(out.checks.find((c) => c.label === 'closed trades')).toMatchObject({
        ok: false,
        actual: '10',
        need: '>= 30',
      });
    }
  });

  it('fails thresholds when the run carried data-coverage warnings (blocks live)', () => {
    const out = run([
      cand({
        metrics: {
          profitFactor: 2,
          totalTrades: 50,
          alphaVsHoldPct: 5,
          dataCoverageOk: false,
          outOfSample: null,
        },
      }),
    ]);
    expect(out).toMatchObject({ ok: false, failure: 'thresholds' });
    if (!out.ok && out.failure === 'thresholds') {
      expect(out.checks.find((c) => c.label === 'data coverage')).toMatchObject({
        ok: false,
        actual: 'gaps',
      });
    }
  });

  it('fails thresholds when alpha vs hold is negative', () => {
    const out = run([
      cand({
        metrics: { profitFactor: 2, totalTrades: 50, alphaVsHoldPct: -3, outOfSample: null },
      }),
    ]);
    expect(out).toMatchObject({ ok: false, failure: 'thresholds' });
    if (!out.ok && out.failure === 'thresholds') {
      expect(out.checks.find((c) => c.label === 'alpha vs hold')).toMatchObject({
        ok: false,
        actual: '-3.00%',
        need: '>= 0%',
      });
    }
  });
});

describe('failedChecksDetail', () => {
  it('joins only the failed checks into the gate detail phrasing', () => {
    const out = run([
      cand({
        metrics: { profitFactor: 1.0, totalTrades: 10, alphaVsHoldPct: 5, outOfSample: null },
      }),
    ]);
    if (!out.ok && out.failure === 'thresholds') {
      expect(failedChecksDetail(out.checks)).toBe(
        'profit factor 1.00 (need >= 1.1); closed trades 10 (need >= 30)',
      );
    } else {
      throw new Error('expected thresholds failure');
    }
  });
});

describe('toGateCandidates', () => {
  // A minimal but schema-valid BacktestResult so the parse path extracts metrics.
  const validResult = {
    params: {
      symbols: ['BTCUSDT'],
      fromMs: 1,
      toMs: 2,
      strategyInterval: '1h',
      detailInterval: '5m',
      initialQuoteBalance: '1000',
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 5,
      discoveryMode: false,
    },
    metrics: {
      startingBalance: '1000',
      finalBalance: '1100',
      absoluteProfit: '100',
      totalReturnPct: 10,
      cagrPct: 0,
      marketChangePct: 5,
      dcaChangePct: 4,
      alphaVsHoldPct: 5,
      alphaVsDcaPct: 6,
      sharpe: 1,
      sortino: 1,
      calmar: 1,
      sqn: 1,
      maxDrawdownPct: -8,
      absoluteDrawdown: '80',
      drawdownStartMs: null,
      drawdownEndMs: null,
      totalTrades: 10,
      winRate: 60,
      wins: 6,
      losses: 4,
      profitFactor: 1.8,
      expectancy: '10',
      bestTradePct: 5,
      worstTradePct: -3,
      avgTradePnl: '10',
      avgTradeDurationMs: 3600000,
    },
    equityCurve: [],
    drawdownSeries: [],
    trades: [],
    perSymbol: [],
  };

  it('maps row fields and extracts the gate metrics from a parseable result', () => {
    const rows: BacktestRunLike[] = [
      { id: 'r1', configFingerprint: 'fp', createdAt: new Date(NOW), result: validResult },
    ];
    expect(toGateCandidates(rows)).toEqual([
      {
        runId: 'r1',
        configFingerprint: 'fp',
        createdAtMs: NOW,
        metrics: {
          profitFactor: 1.8,
          totalTrades: 10,
          alphaVsHoldPct: 5,
          dataCoverageOk: true,
          outOfSample: null,
        },
      },
    ]);
  });

  it('marks dataCoverageOk false when the run carried coverage warnings', () => {
    const warned = { ...validResult, dataWarnings: ['SOLUSDT: only 60% of the expected candles'] };
    const rows: BacktestRunLike[] = [
      { id: 'r4', configFingerprint: 'fp', createdAt: new Date(NOW), result: warned },
    ];
    expect(toGateCandidates(rows)[0]?.metrics?.dataCoverageOk).toBe(false);
  });

  it('extracts the holdout metrics when the result carries an out-of-sample slice', () => {
    const withHoldout = {
      ...validResult,
      outOfSample: {
        fraction: 0.3,
        fromMs: 1,
        toMs: 2,
        returnPct: 3,
        holdReturnPct: 1,
        alphaVsHoldPct: 2,
        trades: 25,
        winRate: 60,
        profitFactor: 1.4,
        expectancy: '5',
      },
    };
    const rows: BacktestRunLike[] = [
      { id: 'r3', configFingerprint: 'fp', createdAt: new Date(NOW), result: withHoldout },
    ];
    // trades → totalTrades; only the three gate figures are carried.
    expect(toGateCandidates(rows)[0]?.metrics?.outOfSample).toEqual({
      profitFactor: 1.4,
      totalTrades: 25,
      alphaVsHoldPct: 2,
    });
  });

  it('yields null metrics when the stored result is unreadable', () => {
    const rows: BacktestRunLike[] = [
      { id: 'r2', configFingerprint: null, createdAt: new Date(NOW), result: { junk: true } },
    ];
    expect(toGateCandidates(rows)).toEqual([
      { runId: 'r2', configFingerprint: null, createdAtMs: NOW, metrics: null },
    ]);
  });
});

describe('describeGateOutcome', () => {
  it('describes a pass', () => {
    expect(describeGateOutcome({ ok: true, runId: 'r1', matchedAtMs: NOW })).toMatch(/validated/);
  });
  it('describes each failure variant', () => {
    expect(describeGateOutcome({ ok: false, failure: 'no-matching-backtest' })).toMatch(
      /no recent backtest/,
    );
    expect(describeGateOutcome({ ok: false, failure: 'stale', runId: 'r1', ageDays: 20.7 })).toBe(
      'the matching backtest is 20 days old',
    );
    expect(describeGateOutcome({ ok: false, failure: 'unreadable-result', runId: 'r1' })).toMatch(
      /could not be read/,
    );
    const thresholds = run([
      cand({
        metrics: { profitFactor: 1.0, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
      }),
    ]);
    expect(describeGateOutcome(thresholds)).toMatch(/does not clear the gate — profit factor/);
  });
});

describe('gateThresholdChecks', () => {
  const t = {
    minProfitFactor: 1.1,
    minTrades: 30,
    minAlphaVsHoldPct: 0,
    requireOutOfSample: false,
    minOutOfSampleTrades: 20,
  };

  it('passes every check for clearing metrics', () => {
    const checks = gateThresholdChecks(
      { profitFactor: 2, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
      t,
    );
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.label)).toEqual([
      'data coverage',
      'profit factor',
      'closed trades',
      'alpha vs hold',
    ]);
  });

  it('fails the data-coverage check (closed) when the run had coverage gaps', () => {
    const checks = gateThresholdChecks(
      {
        profitFactor: 2,
        totalTrades: 50,
        alphaVsHoldPct: 5,
        dataCoverageOk: false,
        outOfSample: null,
      },
      t,
    );
    expect(checks.find((c) => c.label === 'data coverage')).toMatchObject({
      ok: false,
      actual: 'gaps',
    });
    expect(checks.every((c) => c.ok)).toBe(false);
  });

  it('marks each metric below its threshold, with actual + need strings', () => {
    const checks = gateThresholdChecks(
      { profitFactor: 1.0, totalTrades: 12, alphaVsHoldPct: -2, outOfSample: null },
      t,
    );
    expect(checks.find((c) => c.label === 'profit factor')).toMatchObject({
      ok: false,
      actual: '1.00',
      need: '>= 1.1',
    });
    expect(checks.find((c) => c.label === 'closed trades')?.ok).toBe(false);
    expect(checks.find((c) => c.label === 'alpha vs hold')).toMatchObject({
      ok: false,
      actual: '-2.00%',
    });
  });

  it('reports per-check ok flags on a mixed result (one fails, two pass)', () => {
    const checks = gateThresholdChecks(
      { profitFactor: 1.0, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
      t,
    );
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['data coverage', true],
      ['profit factor', false],
      ['closed trades', true],
      ['alpha vs hold', true],
    ]);
  });

  it('renders a null profit factor as n/a and fails it', () => {
    const pf = gateThresholdChecks(
      { profitFactor: null, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null },
      t,
    ).find((c) => c.label === 'profit factor');
    expect(pf).toMatchObject({ ok: false, actual: 'n/a' });
  });

  it('is the same check set evaluateBacktestGate emits (no drift)', () => {
    const metrics = { profitFactor: 1.0, totalTrades: 50, alphaVsHoldPct: 5, outOfSample: null };
    const direct = gateThresholdChecks(metrics, t);
    const viaGate = evaluateBacktestGate({
      policy: { ...t, maxBacktestAgeDays: 14 },
      currentFingerprint: 'fp',
      candidates: [{ runId: 'r', configFingerprint: 'fp', createdAtMs: NOW, metrics }],
      nowMs: NOW,
    });
    expect(viaGate.ok).toBe(false);
    if (viaGate.ok === false && viaGate.failure === 'thresholds') {
      expect(viaGate.checks).toEqual(direct);
    }
  });

  describe('out-of-sample enforcement', () => {
    const tOn = { ...t, requireOutOfSample: true };
    // Two roles, two objects. `holdout` is a `GateMetricsCore`, which declares no holdout of its own; `clearing` is the full `GateMetrics` wrapping it. Building the holdout from `clearing` would hand every one of them a nested `outOfSample` the core type never declares — inert, but it makes `oos({ outOfSample: … })` type-legal and meaningless.
    const holdout = { profitFactor: 2, totalTrades: 50, alphaVsHoldPct: 5 };
    const clearing = { ...holdout, outOfSample: null };
    const oos = (over: Partial<typeof holdout> = {}) => ({ ...holdout, ...over });

    it('adds three holdout checks that pass when the holdout clears the same bars', () => {
      const checks = gateThresholdChecks({ ...clearing, outOfSample: oos() }, tOn);
      expect(checks.map((c) => c.label)).toEqual([
        'data coverage',
        'profit factor',
        'closed trades',
        'alpha vs hold',
        'out-of-sample trades',
        'out-of-sample profit factor',
        'out-of-sample alpha vs hold',
      ]);
      expect(checks.every((c) => c.ok)).toBe(true);
    });

    it('fails the holdout profit-factor check when the edge collapses out-of-sample', () => {
      const checks = gateThresholdChecks(
        { ...clearing, outOfSample: oos({ profitFactor: 0.9 }) },
        tOn,
      );
      expect(checks.find((c) => c.label === 'out-of-sample profit factor')).toMatchObject({
        ok: false,
        actual: '0.90',
        need: '>= 1.1',
      });
      // The full-run profit factor still passes — the holdout is what catches it.
      expect(checks.find((c) => c.label === 'profit factor')?.ok).toBe(true);
    });

    it('renders a null holdout profit factor as n/a and fails it (a no-loss holdout is not a pass)', () => {
      const checks = gateThresholdChecks(
        { ...clearing, outOfSample: { profitFactor: null, totalTrades: 40, alphaVsHoldPct: 2 } },
        tOn,
      );
      expect(checks.find((c) => c.label === 'out-of-sample profit factor')).toMatchObject({
        ok: false,
        actual: 'n/a',
      });
    });

    it('fails the holdout alpha check when the holdout underperforms holding', () => {
      const checks = gateThresholdChecks(
        { ...clearing, outOfSample: oos({ alphaVsHoldPct: -1 }) },
        tOn,
      );
      expect(checks.find((c) => c.label === 'out-of-sample alpha vs hold')).toMatchObject({
        ok: false,
        actual: '-1.00%',
      });
    });

    it('fails the holdout trade-count check when the slice is too thin', () => {
      const checks = gateThresholdChecks(
        { ...clearing, outOfSample: oos({ totalTrades: 5 }) },
        tOn,
      );
      expect(checks.find((c) => c.label === 'out-of-sample trades')).toMatchObject({
        ok: false,
        actual: '5',
        need: '>= 20',
      });
    });

    it('fails with a single "missing" check when the run carries no holdout', () => {
      const checks = gateThresholdChecks({ ...clearing, outOfSample: null }, tOn);
      const oosChecks = checks.filter((c) => c.label.startsWith('out-of-sample'));
      expect(oosChecks).toEqual([
        {
          label: 'out-of-sample validation',
          ok: false,
          actual: 'missing',
          need: 're-run backtest',
        },
      ]);
    });

    it('skips the holdout checks entirely when requireOutOfSample is off', () => {
      const checks = gateThresholdChecks({ ...clearing, outOfSample: null }, t);
      expect(checks.some((c) => c.label.startsWith('out-of-sample'))).toBe(false);
    });

    it('blocks the gate end-to-end when only the holdout fails', () => {
      const failing = {
        ...clearing,
        outOfSample: { profitFactor: 0.8, totalTrades: 25, alphaVsHoldPct: 1 },
      };
      const out = evaluateBacktestGate({
        policy: { ...tOn, maxBacktestAgeDays: 14 },
        currentFingerprint: 'fp',
        candidates: [{ runId: 'r', configFingerprint: 'fp', createdAtMs: NOW, metrics: failing }],
        nowMs: NOW,
      });
      expect(out).toMatchObject({ ok: false, failure: 'thresholds' });
    });
  });
});
