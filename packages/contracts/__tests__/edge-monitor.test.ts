import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EDGE_MONITOR_POLICY,
  EdgeMonitorPolicy,
  assessEdgeDecay,
  profitFactorFromGross,
  type EdgeMonitorPolicy as EdgeMonitorPolicyType,
} from '../src/edge-monitor.js';
import { summarizeClosedTrades } from '../src/archive.js';

const policy = (over: Partial<EdgeMonitorPolicyType> = {}): EdgeMonitorPolicyType =>
  EdgeMonitorPolicy.parse({ ...over });

describe('EdgeMonitorPolicy', () => {
  it('defaults to warn mode with sane factors', () => {
    expect(DEFAULT_EDGE_MONITOR_POLICY).toEqual({
      mode: 'warn',
      minTrades: 10,
      warnFactor: 0.85,
      breachFactor: 0.6,
    });
  });

  it('rejects a breachFactor above the warnFactor', () => {
    expect(EdgeMonitorPolicy.safeParse({ warnFactor: 0.5, breachFactor: 0.9 }).success).toBe(false);
    expect(EdgeMonitorPolicy.safeParse({ warnFactor: 0.9, breachFactor: 0.5 }).success).toBe(true);
  });
});

describe('profitFactorFromGross', () => {
  it('divides gross win by gross loss', () => {
    expect(profitFactorFromGross('30', '20')).toBe(1.5);
  });
  it('is null (infinite) when there are no losses', () => {
    expect(profitFactorFromGross('30', '0')).toBeNull();
  });
});

describe('summarizeClosedTrades', () => {
  it('collapses rows into one net-of-fee summary, classified on net', () => {
    const s = summarizeClosedTrades([
      {
        quoteAsset: 'USDT',
        source: 'discovery',
        profit: '10',
        feesQuote: '1',
        feeBasis: 'exact',
        orders: [],
      }, // net +9 win
      {
        quoteAsset: 'USDT',
        source: 'manual',
        profit: '2',
        feesQuote: '3',
        feeBasis: 'exact',
        orders: [],
      }, // net -1 loss
      {
        quoteAsset: 'USDT',
        source: 'manual',
        profit: '0',
        feesQuote: '0',
        feeBasis: 'exact',
        orders: [],
      }, // breakeven
    ]);
    expect(s.tradeCount).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.grossProfit).toBe('9');
    expect(s.grossLoss).toBe('1');
    expect(s.feeBasis).toBe('exact');
  });

  it('marks the summary incomplete when any row has incomplete fee accounting', () => {
    const summary = summarizeClosedTrades([
      {
        quoteAsset: 'USDT',
        source: 'manual',
        profit: '1',
        feesQuote: '0',
        feeBasis: 'unknown',
        orders: [],
      },
    ]);
    expect(summary.feeBasis).toBe('unknown');
  });

  it('returns an all-zero summary for no trades', () => {
    expect(summarizeClosedTrades([])).toMatchObject({
      tradeCount: 0,
      grossProfit: '0',
      grossLoss: '0',
    });
  });
});

describe('assessEdgeDecay', () => {
  const base = {
    hasBaseline: true,
    baselineProfitFactor: 2.0,
    liveProfitFactor: 2.0,
    liveTradeCount: 50,
  };

  it('reports monitor-off when the mode is off', () => {
    expect(assessEdgeDecay({ ...base, policy: policy({ mode: 'off' }) }).verdict).toBe(
      'monitor-off',
    );
  });

  it('reports no-baseline when no baseline is pinned', () => {
    expect(assessEdgeDecay({ ...base, hasBaseline: false, policy: policy() }).verdict).toBe(
      'no-baseline',
    );
  });

  it('reports insufficient-data below the sample floor', () => {
    expect(
      assessEdgeDecay({ ...base, liveTradeCount: 5, policy: policy({ minTrades: 10 }) }).verdict,
    ).toBe('insufficient-data');
  });

  it('breaches on the absolute floor when live PF < 1 regardless of baseline', () => {
    const a = assessEdgeDecay({
      ...base,
      baselineProfitFactor: 1.05,
      liveProfitFactor: 0.8,
      policy: policy(),
    });
    expect(a.verdict).toBe('breached');
    expect(a.reason).toContain('net-losing');
  });

  it('is healthy when live matches or beats the baseline', () => {
    expect(assessEdgeDecay({ ...base, liveProfitFactor: 2.2, policy: policy() }).verdict).toBe(
      'healthy',
    );
  });

  it('is healthy at exactly the warn threshold (the band edge is < not <=)', () => {
    // baseline 2.0 × 0.85 = 1.70; live exactly 1.70 is NOT a warning.
    const a = assessEdgeDecay({ ...base, liveProfitFactor: 1.7, policy: policy() });
    expect(a.verdict).toBe('healthy');
    expect(a.warnThreshold).toBeCloseTo(1.7);
  });

  it('breaches on the absolute floor even when the baseline PF is infinite (null)', () => {
    // No finite baseline ratio, but live PF < 1 is net-losing → breach regardless.
    expect(
      assessEdgeDecay({
        ...base,
        baselineProfitFactor: null,
        liveProfitFactor: 0.8,
        policy: policy(),
      }).verdict,
    ).toBe('breached');
  });

  it('warns when live PF is below baseline × warnFactor but above breachFactor', () => {
    // baseline 2.0, warn<1.7, breach<1.2 → live 1.5 is a warning.
    const a = assessEdgeDecay({ ...base, liveProfitFactor: 1.5, policy: policy() });
    expect(a.verdict).toBe('warning');
    expect(a.warnThreshold).toBeCloseTo(1.7);
    expect(a.breachThreshold).toBeCloseTo(1.2);
  });

  it('breaches when live PF is below baseline × breachFactor', () => {
    // baseline 2.0, breach<1.2 → live 1.1 is a breach (and >1 so not the absolute floor).
    expect(assessEdgeDecay({ ...base, liveProfitFactor: 1.1, policy: policy() }).verdict).toBe(
      'breached',
    );
  });

  it('is healthy when the baseline had no losses (infinite PF) and live is not net-losing', () => {
    expect(
      assessEdgeDecay({
        ...base,
        baselineProfitFactor: null,
        liveProfitFactor: 1.5,
        policy: policy(),
      }).verdict,
    ).toBe('healthy');
  });

  it('is healthy when live has no losses yet (null live PF)', () => {
    expect(assessEdgeDecay({ ...base, liveProfitFactor: null, policy: policy() }).verdict).toBe(
      'healthy',
    );
  });
});
