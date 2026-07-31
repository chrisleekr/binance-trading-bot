import { describe, expect, it } from 'vitest';
import { DEFAULT_ENABLEMENT_POLICY, type BacktestResult } from '@app/contracts';

import { buildDiagnosisSpine } from '@/features/backtest/lib/diagnosis-spine';

// The attribution map the strategy now provides (was hardcoded in apps/web).
type ReasonAttributionMap = Record<
  string,
  { setting: string; paths?: readonly string[]; note?: string }
>;

const TT_ATTR: ReasonAttributionMap = {
  tt_risk_cap_veto: {
    setting: 'Exposure cap',
    paths: ['buy.maxSymbolExposureQuote', 'buy.accountCap'],
  },
  'indicator-rsi': { setting: 'RSI(14) buy ceiling', paths: ['buy.indicatorGate.rsiMaxBuy'] },
  'technicals-sell': {
    setting: 'Technical-rating gate',
    note: 'reads the market, not a setting you tune',
  },
  'min-purchase': {
    setting: 'Minimum-purchase floor',
    paths: ['buy.gridLevels[0].minPurchaseAmount'],
  },
};

// A compact, mutable BacktestResult fixture for the pure spine builder. Casts via
// `as never` keep decimal-string fields legible without reviving Decimals — the
// builder reads display numbers and the decision breakdown, not the money fields.
const baseResult = (over: Partial<BacktestResult>): BacktestResult =>
  ({
    params: { symbols: ['BTCUSDT'], fromMs: 1, toMs: 2 },
    metrics: {
      totalReturnPct: 5,
      alphaVsHoldPct: 2,
      maxDrawdownPct: -3,
      winRate: 50,
      totalTrades: 4,
      profitFactor: 1.5,
    },
    equityCurve: [],
    drawdownSeries: [],
    trades: [],
    roundTrips: [],
    perSymbol: [],
    decisionBreakdown: { metrics: [], logs: [] },
    dataWarnings: [],
    regimeBreakdown: [],
    outOfSample: null,
    ...over,
  }) as unknown as BacktestResult;

const ALLOWED_KINDS = ['blocker', 'gate-fail', 'segment', 'none'];

describe('buildDiagnosisSpine', () => {
  it('ranks funnel blockers by count desc and carries the strategy-provided lever', () => {
    const result = baseResult({
      metrics: { ...baseResult({}).metrics, totalTrades: 0, totalReturnPct: 0, alphaVsHoldPct: 0 },
      decisionBreakdown: {
        metrics: [],
        logs: [
          {
            level: 'info',
            message: 'tt-technicals-gate-veto',
            reason: 'technicals-sell',
            count: 8000,
          },
          { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 900 },
        ],
      },
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {
      buy: { indicatorGate: { rsiMaxBuy: '30' } },
    });
    const blockers = items.filter((i) => i.kind === 'blocker');
    // Ranked by count: the bigger blocker (technicals-sell, 8000) leads indicator-rsi (900).
    const sellIdx = blockers.findIndex((i) => i.id.includes('technicals-sell'));
    const rsiIdx = blockers.findIndex((i) => i.id.includes('indicator-rsi'));
    expect(sellIdx).toBeGreaterThanOrEqual(0);
    expect(rsiIdx).toBeGreaterThan(sellIdx);
    // The indicator-rsi blocker names the config path off the passed attribution map.
    expect(blockers[rsiIdx]?.lever?.path).toBe('buy.indicatorGate.rsiMaxBuy');
  });

  it('includes a gate-fail item when threshold checks fail against the policy', () => {
    const result = baseResult({
      metrics: { ...baseResult({}).metrics, alphaVsHoldPct: -4, profitFactor: 0.3 },
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {}, DEFAULT_ENABLEMENT_POLICY);
    expect(items.some((i) => i.kind === 'gate-fail')).toBe(true);
  });

  it('reads a zero-trade run as a factual segment item', () => {
    const result = baseResult({
      metrics: { ...baseResult({}).metrics, totalTrades: 0 },
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items.some((i) => i.kind === 'segment' && /trade/i.test(i.title))).toBe(true);
  });

  it('reads negative alpha-vs-hold as a factual segment item', () => {
    const result = baseResult({ metrics: { ...baseResult({}).metrics, alphaVsHoldPct: -6 } });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items.some((i) => i.kind === 'segment' && /alpha|hold/i.test(i.title))).toBe(true);
  });

  it('reads a regime segment with negative alpha as a factual segment item', () => {
    const result = baseResult({
      regimeBreakdown: [
        {
          regime: 'bull',
          returnPct: 10,
          holdReturnPct: 15,
          alphaVsHoldPct: -5,
          trades: 3,
          winRate: 33,
          profitFactor: 0.5,
          expectancy: '-1' as never,
        },
      ] as never,
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items.some((i) => i.kind === 'segment' && /regime|bull/i.test(i.title))).toBe(true);
  });

  it('reads an out-of-sample holdout that underperforms as a factual segment item', () => {
    const result = baseResult({
      outOfSample: {
        fraction: 0.3,
        fromMs: 1,
        toMs: 2,
        returnPct: -1,
        holdReturnPct: 4,
        alphaVsHoldPct: -5,
        trades: 6,
        winRate: 20,
        profitFactor: 0.4,
        expectancy: '-1' as never,
      } as never,
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items.some((i) => i.kind === 'segment' && /out-of-sample|holdout/i.test(i.title))).toBe(
      true,
    );
  });

  it('yields exactly one "no deterministic cause" item when a loss has no provable cause', () => {
    // Negative return, but it beat hold, traded, no blockers, no policy, no
    // failing segment — the only signal left is the PnL/drawdown heuristic, which
    // the spine refuses to surface.
    const result = baseResult({
      metrics: {
        ...baseResult({}).metrics,
        totalReturnPct: -5,
        alphaVsHoldPct: 1,
        maxDrawdownPct: -20,
        totalTrades: 3,
        profitFactor: 1.1,
      },
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('none');
  });

  it('never yields a drawdown/PnL heuristic item', () => {
    const result = baseResult({
      metrics: {
        ...baseResult({}).metrics,
        totalReturnPct: -30,
        alphaVsHoldPct: -10,
        maxDrawdownPct: -55,
        totalTrades: 7,
        profitFactor: 0.2,
      },
      decisionBreakdown: {
        metrics: [],
        logs: [
          { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 100 },
        ],
      },
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {
      buy: { indicatorGate: { rsiMaxBuy: '30' } },
    });
    expect(items.every((i) => ALLOWED_KINDS.includes(i.kind))).toBe(true);
    expect(items.every((i) => !/drawdown/i.test(i.title))).toBe(true);
  });

  it('reads an out-of-sample holdout that never traded as a too-short segment', () => {
    const result = baseResult({
      outOfSample: {
        fraction: 0.3,
        fromMs: 1,
        toMs: 2,
        returnPct: 0,
        holdReturnPct: 0,
        alphaVsHoldPct: 0,
        trades: 0,
        winRate: 0,
        profitFactor: null,
        expectancy: '0' as never,
      } as never,
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items.some((i) => i.id === 'segment:oos-short')).toBe(true);
  });

  it('yields an empty spine for a clean winning run with no provable issues', () => {
    // Positive return, beat hold, traded, no blockers, no policy, no segments —
    // not a loss, so the fallback does not fire and the spine is empty.
    const items = buildDiagnosisSpine(baseResult({}), TT_ATTR, {});
    expect(items).toHaveLength(0);
  });

  it('emits no gate-fail item when the run clears every threshold (failed.length === 0)', () => {
    // A winning run that passes the default gate end-to-end (incl. the required
    // out-of-sample slice), so the gate-fail branch is exercised but stays empty.
    const result = baseResult({
      metrics: {
        ...baseResult({}).metrics,
        totalReturnPct: 10,
        alphaVsHoldPct: 5,
        profitFactor: 1.8,
        totalTrades: 150,
      },
      outOfSample: {
        fraction: 0.3,
        fromMs: 1,
        toMs: 2,
        returnPct: 4,
        holdReturnPct: 1,
        alphaVsHoldPct: 3,
        trades: 40,
        winRate: 60,
        profitFactor: 1.5,
        expectancy: '1' as never,
      } as never,
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {}, DEFAULT_ENABLEMENT_POLICY);
    expect(items.some((i) => i.kind === 'gate-fail')).toBe(false);
  });

  it('emits no regime segment when a regime row has positive alpha (r.alphaVsHoldPct >= 0)', () => {
    const result = baseResult({
      regimeBreakdown: [
        {
          regime: 'bull',
          returnPct: 12,
          holdReturnPct: 7,
          alphaVsHoldPct: 5,
          trades: 4,
          winRate: 75,
          profitFactor: 2.1,
          expectancy: '1' as never,
        },
      ] as never,
    });
    const items = buildDiagnosisSpine(result, TT_ATTR, {});
    expect(items.some((i) => i.id.startsWith('segment:regime'))).toBe(false);
  });
});
