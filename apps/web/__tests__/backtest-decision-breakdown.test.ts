import { describe, expect, it } from 'vitest';
import type { BacktestResult, ConfigSuggestion } from '@app/contracts';

import {
  applyRecommendations,
  attributeBlocker,
  configSuggestionsToRecommendations,
  recommendConfigChanges,
  summarizeDecisionBreakdown,
} from '@/features/backtest/lib/decision-breakdown';

type Breakdown = BacktestResult['decisionBreakdown'];

// The strategy now owns the reason-code gloss + kind (was hardcoded in apps/web);
// summarizeDecisionBreakdown reads them off this passed map. These entries
// byte-match trailing-trade's descriptor so labels and tints are unchanged.
const GLOSS_ATTR = {
  'technicals-sell': {
    setting: 'Technical-rating gate',
    gloss: 'Technical rating was bearish (Sell / Strong-Sell)',
    kind: 'market' as const,
  },
  'technicals-disallowed': {
    setting: 'Technicals-gate levels',
    paths: ['technicals.intervals'],
    gloss: 'Rating was bullish, but that level is not enabled in your technicals gate',
    kind: 'config' as const,
  },
  'indicator-rsi': {
    setting: 'RSI(14) buy ceiling',
    paths: ['buy.indicatorGate.rsiMaxBuy'],
    gloss: 'RSI(14) was above your buy ceiling',
    kind: 'config' as const,
  },
  'indicator-sma': {
    setting: 'SMA(20) bias gate',
    paths: ['buy.indicatorGate.smaBias'],
    gloss: 'Price was on the wrong side of SMA(20) for your bias',
    kind: 'config' as const,
  },
  'indicator-ema': {
    setting: 'EMA(20) bias gate',
    paths: ['buy.indicatorGate.emaBias'],
    gloss: 'Price was on the wrong side of EMA(20) for your bias',
    kind: 'config' as const,
  },
  'min-purchase': {
    setting: 'Minimum-purchase floor',
    paths: ['buy.gridLevels[0].minPurchaseAmount'],
    gloss: 'Order fell below your configured minimum-purchase floor',
    kind: 'sizing' as const,
  },
  tt_regime_filter_veto: {
    setting: 'Regime filter',
    gloss: 'Market-regime filter blocked the entry',
    kind: 'config' as const,
  },
};

// The real SOLUSDT zero-trade run: technicals + indicator gates blocked 23,832
// ticks, 52 cleared the gates but fell below the min-purchase floor, 0 traded.
const SOL_BREAKDOWN: Breakdown = {
  metrics: [
    { name: 'tt_tick_pure_path', tags: { symbol: 'SOLUSDT' }, count: 23832 },
    {
      name: 'tt_first_buy_skipped',
      tags: { symbol: 'SOLUSDT', reason: 'min-purchase' },
      count: 52,
    },
  ],
  logs: [
    { level: 'info', message: 'tt-technicals-gate-veto', reason: 'technicals-sell', count: 13284 },
    { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 6760 },
    {
      level: 'info',
      message: 'tt-technicals-gate-veto',
      reason: 'technicals-disallowed',
      count: 3013,
    },
    { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-sma', count: 707 },
    { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-ema', count: 68 },
  ],
};

/** A TT config with the indicator gate and a disarmed BUY level, as SOL ran. */
const ARMED_CONFIG = (): Record<string, unknown> => ({
  buy: {
    indicatorGate: { rsiMaxBuy: '30', smaBias: 'price-below-sma', emaBias: 'price-above-ema' },
    meanReversionGate: { entryZScoreMax: '' },
  },
  technicals: {
    intervals: [
      { interval: '15m', whenStrongBuy: true, whenBuy: false, whenSell: false },
      { interval: '1h', whenStrongBuy: true, whenBuy: false, whenSell: false },
    ],
  },
});

describe('summarizeDecisionBreakdown', () => {
  it('rebuilds the gate funnel and ranks blockers (the SOLUSDT run)', () => {
    const s = summarizeDecisionBreakdown(SOL_BREAKDOWN, GLOSS_ATTR);
    expect(s).not.toBeNull();
    if (!s) return;
    // tt_tick_pure_path is NOT a blocker — it's the bucket the gate-veto logs
    // subdivide, so counting it would double-count. eligible = vetoes + sizing.
    expect(s.technicalsVetoed).toBe(16297); // 13284 + 3013
    expect(s.indicatorVetoed).toBe(7535); // 6760 + 707 + 68
    expect(s.sizingSkipped).toBe(52);
    expect(s.bought).toBe(0);
    expect(s.eligible).toBe(23884);
    expect(s.technicalsPassed).toBe(7587); // 7535 + 52
    // The sharp insight: RSI stopped 89% of the entries that passed the rating gate.
    expect(s.indicatorChoke?.count).toBe(6760);
    expect(s.indicatorChoke?.pctOfPassed).toBe(89);
    // Ranked by count desc; the dominant blocker is the bearish rating.
    expect(s.blockers[0]?.code).toBe('technicals-sell');
    expect(s.blockers[0]?.kind).toBe('market'); // the gate working, not a config error
    expect(s.blockers.find((b) => b.code === 'indicator-rsi')?.kind).toBe('config');
  });

  it('returns null when there is nothing to explain', () => {
    expect(summarizeDecisionBreakdown({ metrics: [], logs: [] }, GLOSS_ATTR)).toBeNull();
  });

  describe('attributeBlocker', () => {
    // The attribution map now comes from the strategy (its descriptor), not a
    // hardcoded web copy. This mirrors trailing-trade's reasonAttribution.
    const ATTR = {
      tt_regime_exit_entry_block: {
        setting: 'Regime entry-block',
        paths: ['regime.onBear.blockEntry', 'regime.onBear.exitToCash'],
        note: 'the bear-regime rule, defined by regime.ma / regime.period / regime.confirmBars',
      },
      'indicator-rsi': { setting: 'RSI(14) buy ceiling', paths: ['buy.indicatorGate.rsiMaxBuy'] },
      'min-notional': {
        setting: 'Binance minimum notional',
        note: "Binance's per-symbol minimum order value, not your setting — raise your per-trade budget to clear it",
      },
      'technicals-sell': {
        setting: 'Technical-rating gate',
        note: 'reads the market, not a setting you tune — relaxing it would buy into a downtrend',
      },
      'min-purchase': {
        setting: 'Minimum-purchase floor',
        paths: ['buy.gridLevels[0].minPurchaseAmount'],
        note: 'the entry-level order was smaller than this floor — raise the level budget (buy.gridLevels[0].maxPurchaseAmount) or lower the floor',
      },
    };

    it('picks the first armed regime toggle and reports the strategy note', () => {
      const config = { regime: { onBear: { blockEntry: true } } };
      const attr = attributeBlocker('tt_regime_exit_entry_block', ATTR, config);
      expect(attr?.path).toBe('regime.onBear.blockEntry');
      expect(attr?.value).toBe('on');
      expect(attr?.detail).toMatch(/bear-regime rule/);
    });

    it('falls back to exitToCash when blockEntry is off but exitToCash armed it', () => {
      const config = { regime: { onBear: { blockEntry: false, exitToCash: true } } };
      const attr = attributeBlocker('tt_regime_exit_entry_block', ATTR, config);
      expect(attr?.path).toBe('regime.onBear.exitToCash');
    });

    it('reads the indicator-gate path and its current value', () => {
      const attr = attributeBlocker('indicator-rsi', ATTR, ARMED_CONFIG());
      expect(attr?.path).toBe('buy.indicatorGate.rsiMaxBuy');
      expect(attr?.value).toBe('30');
    });

    it('names a setting with no editable lever (Binance minimum) without a path', () => {
      const attr = attributeBlocker('min-notional', ATTR, {});
      expect(attr?.path).toBeNull();
      expect(attr?.setting).toBe('Binance minimum notional');
      // The note explains it is an exchange minimum, not a tuning knob.
      expect(attr?.detail).toMatch(/Binance's per-symbol minimum order value/);
    });

    it('flags the bearish-rating gate as a market read, not a setting to tune', () => {
      const attr = attributeBlocker('technicals-sell', ATTR, {});
      expect(attr?.path).toBeNull();
      expect(attr?.setting).toBe('Technical-rating gate');
      expect(attr?.detail).toMatch(/reads the market, not a setting you tune/);
    });

    it('resolves the entry-level floor path and value for min-purchase', () => {
      const config = {
        buy: { gridLevels: [{ minPurchaseAmount: '20', maxPurchaseAmount: '15' }] },
      };
      const attr = attributeBlocker('min-purchase', ATTR, config);
      expect(attr?.path).toBe('buy.gridLevels[0].minPurchaseAmount');
      expect(attr?.value).toBe('20');
      expect(attr?.detail).toMatch(/smaller than this floor/);
    });

    it('returns null for a code absent from the attribution map', () => {
      expect(attributeBlocker('totally-unknown-code', ATTR, {})).toBeNull();
    });
  });

  it('counts non-gate veto metrics (regime) as blockers', () => {
    const s = summarizeDecisionBreakdown(
      {
        metrics: [{ name: 'tt_regime_filter_veto', tags: { symbol: 'BTCUSDT' }, count: 500 }],
        logs: [],
      },
      GLOSS_ATTR,
    );
    expect(s?.eligible).toBe(500);
    expect(s?.otherVetoed).toBe(500);
    expect(s?.blockers[0]?.code).toBe('tt_regime_filter_veto');
    expect(s?.blockers[0]?.label).toBe('Market-regime filter blocked the entry');
    expect(s?.blockers[0]?.kind).toBe('config');
  });

  it('keeps out-of-funnel vetoes out of the gate-chain numbers', () => {
    // A run mixing a rating veto with a regime veto: the regime block is in
    // `eligible` and `otherVetoed`, but never folded into the funnel stages.
    const s = summarizeDecisionBreakdown(
      {
        metrics: [{ name: 'tt_regime_filter_veto', tags: { symbol: 'BTCUSDT' }, count: 200 }],
        logs: [
          {
            level: 'info',
            message: 'tt-technicals-gate-veto',
            reason: 'technicals-sell',
            count: 800,
          },
        ],
      },
      GLOSS_ATTR,
    );
    expect(s?.eligible).toBe(1000);
    expect(s?.otherVetoed).toBe(200);
    expect(s?.technicalsVetoed).toBe(800);
    expect(s?.technicalsPassed).toBe(0); // a regime block is not "passed technicals"
  });
});

describe('recommendConfigChanges', () => {
  it('suggests removing each armed indicator gate and arming the BUY level', () => {
    const config = ARMED_CONFIG();
    const recs = recommendConfigChanges(SOL_BREAKDOWN, config);
    const ids = recs.map((r) => r.id);
    expect(ids).toEqual([
      'indicator-rsi', // 6760, biggest first
      'technicals-disallowed', // 3013
      'indicator-sma', // 707
      'indicator-ema', // 68
    ]);
  });

  it('produces a relaxed config without mutating the original', () => {
    const config = ARMED_CONFIG();
    const recs = recommendConfigChanges(SOL_BREAKDOWN, config);
    const rsi = recs.find((r) => r.id === 'indicator-rsi');
    const next = rsi?.apply(config) as { buy: { indicatorGate: { rsiMaxBuy: string } } };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe(''); // disabled
    // original is untouched
    expect(
      (config['buy'] as { indicatorGate: { rsiMaxBuy: string } }).indicatorGate.rsiMaxBuy,
    ).toBe('30');
  });

  it('arms both bullish levels on every interval row', () => {
    const config = ARMED_CONFIG();
    const recs = recommendConfigChanges(SOL_BREAKDOWN, config);
    const arm = recs.find((r) => r.id === 'technicals-disallowed');
    const rows = (arm?.apply(config) as { technicals: { intervals: Record<string, unknown>[] } })
      .technicals.intervals;
    expect(rows.every((r) => r['whenBuy'] === true && r['whenStrongBuy'] === true)).toBe(true);
  });

  it('composes several selected changes onto one config (multi-select)', () => {
    const config = ARMED_CONFIG();
    const recs = recommendConfigChanges(SOL_BREAKDOWN, config);
    const chosen = recs.filter((r) => r.id === 'indicator-rsi' || r.id === 'indicator-sma');
    const next = applyRecommendations(config, chosen) as {
      buy: { indicatorGate: { rsiMaxBuy: string; smaBias: string; emaBias: string } };
    };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe(''); // RSI removed
    expect(next.buy.indicatorGate.smaBias).toBe('off'); // SMA removed
    expect(next.buy.indicatorGate.emaBias).toBe('price-above-ema'); // unselected → untouched
    // original is untouched
    expect(
      (config['buy'] as { indicatorGate: { rsiMaxBuy: string } }).indicatorGate.rsiMaxBuy,
    ).toBe('30');
  });

  it('never suggests bypassing the bearish rating veto', () => {
    const config = ARMED_CONFIG();
    const recs = recommendConfigChanges(SOL_BREAKDOWN, config);
    expect(recs.some((r) => r.id.includes('sell'))).toBe(false);
    // and never touches forceBuyOverride (the technicals bypass)
    expect(recs.some((r) => JSON.stringify(r.apply(config)).includes('forceBuyOverride'))).toBe(
      false,
    );
  });

  it('suggests removing an armed mean-reversion ceiling', () => {
    const breakdown = {
      metrics: [{ name: 'tt_tick_pure_path', tags: { symbol: 'BTCUSDT' }, count: 40 }],
      logs: [
        {
          level: 'info' as const,
          message: 'tt-indicator-gate-veto',
          reason: 'indicator-mean-reversion',
          count: 40,
        },
      ],
    };
    const config = { buy: { meanReversionGate: { entryZScoreMax: '2' } } };
    const recs = recommendConfigChanges(breakdown, config);
    const mr = recs.find((r) => r.id === 'indicator-mean-reversion');
    expect(mr).toBeDefined();
    const next = mr?.apply(config) as { buy: { meanReversionGate: { entryZScoreMax: string } } };
    expect(next.buy.meanReversionGate.entryZScoreMax).toBe(''); // disabled
  });

  it('skips a gate that is not actually armed', () => {
    // indicator-rsi vetoes present, but the config has the ceiling disabled —
    // nothing to relax, so no RSI suggestion.
    const config = ARMED_CONFIG();
    (config['buy'] as { indicatorGate: { rsiMaxBuy: string } }).indicatorGate.rsiMaxBuy = '';
    const recs = recommendConfigChanges(SOL_BREAKDOWN, config);
    expect(recs.some((r) => r.id === 'indicator-rsi')).toBe(false);
  });

  it('returns nothing for a config with no relaxable gates (e.g. non-TT)', () => {
    expect(recommendConfigChanges(SOL_BREAKDOWN, { foo: 'bar' })).toEqual([]);
  });
});

describe('configSuggestionsToRecommendations', () => {
  const suggestions: ConfigSuggestion[] = [
    {
      id: 'a',
      title: 'Relax RSI',
      rationale: 'ra',
      changes: [{ path: 'buy.indicatorGate.rsiMaxBuy', value: '' }],
      expectedEffect: 'more entries',
      overfitRisk: 'low',
    },
    {
      id: 'b',
      title: 'Tighten stop + cooldown',
      rationale: 'rb',
      changes: [
        { path: 'sell.stopLoss', value: '0.9' },
        { path: 'buy.cooldownBars', value: 3 },
      ],
      expectedEffect: 'shallower drawdowns',
      overfitRisk: 'medium',
    },
  ];

  it("composes each suggestion's dotted path/value patches, creating missing branches", () => {
    const recs = configSuggestionsToRecommendations(suggestions);
    expect(recs.map((r) => r.id)).toEqual(['a', 'b']);

    const base = { buy: { indicatorGate: { rsiMaxBuy: '30' } } };
    const next = applyRecommendations(base, recs) as {
      buy: { indicatorGate: { rsiMaxBuy: string }; cooldownBars: number };
      sell: { stopLoss: string };
    };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe(''); // existing field overwritten
    expect(next.buy.cooldownBars).toBe(3); // numeric value preserved (not stringified)
    expect(next.sell.stopLoss).toBe('0.9'); // missing `sell` branch created
    // apply clones — the base is never mutated.
    expect((base as { sell?: unknown }).sell).toBeUndefined();
  });

  it('applies only the selected subset when composed through applyRecommendations', () => {
    const recs = configSuggestionsToRecommendations(suggestions).filter((r) => r.id === 'b');
    const next = applyRecommendations({ buy: { indicatorGate: { rsiMaxBuy: '30' } } }, recs) as {
      buy: { indicatorGate: { rsiMaxBuy: string } };
      sell: { stopLoss: string };
    };
    expect(next.sell.stopLoss).toBe('0.9');
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe('30'); // suggestion 'a' not selected
  });

  it('targets a real array element for a bracketed-index path, not a stray key', () => {
    const recs = configSuggestionsToRecommendations([
      {
        id: 'flip-neutral',
        title: 'Drop the 30m NEUTRAL force-sell',
        rationale: 'r',
        changes: [{ path: 'technicals.intervals[2].whenNeutral', value: false }],
        expectedEffect: 'e',
        overfitRisk: 'low',
      },
    ]);
    const base = {
      technicals: {
        intervals: [
          { interval: '5m', whenNeutral: false },
          { interval: '15m', whenNeutral: false },
          { interval: '30m', whenNeutral: true },
        ],
      },
    };
    const next = applyRecommendations(base, recs) as {
      technicals: { intervals: { interval: string; whenNeutral: boolean }[] };
    };
    expect(next.technicals.intervals[2]?.whenNeutral).toBe(false); // real row flipped
    // No stray `intervals[2]` literal key was created on `technicals`.
    expect(Object.keys(next.technicals)).toEqual(['intervals']);
    // apply clones — the base row is untouched.
    expect(base.technicals.intervals[2]?.whenNeutral).toBe(true);
  });

  it('refuses a prototype-polluting patch path instead of writing Object.prototype', () => {
    const recs = configSuggestionsToRecommendations([
      {
        id: 'pollute',
        title: 'Pollute',
        rationale: 'r',
        changes: [{ path: '__proto__.polluted', value: 'pwned' }],
        expectedEffect: 'e',
        overfitRisk: 'high',
      },
    ]);
    const next = applyRecommendations({ buy: {} }, recs);
    // The forbidden path is skipped: neither the result nor the global prototype carries it.
    expect((next as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
