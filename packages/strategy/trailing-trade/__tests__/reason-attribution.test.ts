import { describe, expect, it } from 'vitest';
import { PROTECTIVE_STOP_BLOCKER_REASONS } from '@app/strategy-core';
import { EXIT_BLOCKER_REASONS, trailingTrade } from '../src/index.js';

// The reason-code → config-path attribution moves from apps/web's hardcoded
// CONFIG_ATTRIBUTION into the strategy plugin, so the web names the levers off
// the strategy's own declaration (invariant #1). These entries are the ones the
// web previously hardcoded; the strategy is now their source of truth.
describe('trailingTrade.reasonAttribution', () => {
  it('is exported on the plugin object', () => {
    expect(trailingTrade.reasonAttribution).toBeDefined();
  });

  it('pins the full attributed reason-code set', () => {
    expect(Object.keys(trailingTrade.reasonAttribution ?? {}).sort()).toEqual(
      [
        'indicator-ema',
        'indicator-mean-reversion',
        'indicator-rsi',
        'indicator-sma',
        'indicator-unavailable',
        'invalid-filters',
        'min-notional',
        'min-purchase',
        'min-qty',
        'technicals-disallowed',
        'technicals-no-signal',
        'technicals-sell',
        'technicals-stale',
        'tt_discovery_chase_guard_veto',
        'tt_discovery_guardrail_veto',
        'tt_discovery_knife_guard_veto',
        'tt_regime_exit_entry_block',
        'tt_regime_filter_veto',
        'tt_risk_cap_veto',
        // Exit rungs: the "held, and did not sell" half of the same table.
        'sell-disabled',
        'exit-order-open',
        'exit-unsellable',
        'exit-config-invalid',
        'trail-high-raised',
        'atr-trail-above-price',
        'trail-above-price',
        'awaiting-sell-arm',
        'break-even-floor-not-hit',
        'break-even-not-armed',
        'stop-loss-not-hit',
        'time-stop-pending',
        'no-exit-configured',
        // Protective-stop refusals: the "held, and has no safety net" half.
        'price-outside-exchange-band',
        'base-locked-by-foreign-order',
        'base-short-of-tracked-position',
        'base-below-exchange-minimum',
      ].sort(),
    );
  });

  it('explains every exit rung the state schema can record', () => {
    // A rung with no entry renders as a bare code in the UI, which is exactly
    // the unreadable exit side this table exists to fix.
    for (const reason of EXIT_BLOCKER_REASONS) {
      const a = trailingTrade.reasonAttribution?.[reason];
      expect(a?.gloss, reason).toBeDefined();
      expect(a?.kind, reason).toBeDefined();
    }
  });

  it('explains every protective-stop refusal strategy-core can classify', () => {
    // An unattributed refusal renders as a bare code on the one panel that says
    // the position is running without a stop, which is where legibility matters
    // most.
    for (const reason of PROTECTIVE_STOP_BLOCKER_REASONS) {
      const a = trailingTrade.reasonAttribution?.[reason];
      expect(a?.gloss, reason).toBeDefined();
      expect(a?.kind, reason).toBeDefined();
    }
  });

  it('names the limit offset as the lever for a banded protective stop', () => {
    // The terminal case is the operator's to fix: a wide limit offset prices the
    // stop under Binance's floor, and no amount of waiting clears that.
    const a = trailingTrade.reasonAttribution?.['price-outside-exchange-band'];
    expect(a?.paths).toEqual(['sell.protectiveStop.limitOffsetPercentage']);
  });

  it('points the unarmed-trail rung at the sell trigger, not the trailing stop', () => {
    // The reported defect: the operator was told a trailing stop existed while
    // the position had never reached the arm, so the lever to change is the arm.
    const a = trailingTrade.reasonAttribution?.['awaiting-sell-arm'];
    expect(a?.paths).toEqual(['sell.triggerPercentage']);
    expect(a?.note).toContain('does not exist until');
  });

  it('names the missing-downside-exit rung after the levers that would add one', () => {
    const a = trailingTrade.reasonAttribution?.['no-exit-configured'];
    expect(a?.paths).toEqual([
      'sell.stopLossPercentage',
      'sell.breakEven.enabled',
      'sell.atrTrailing.enabled',
    ]);
  });

  it('carries the plain-language gloss + kind that the web funnel used to hardcode', () => {
    const attr = trailingTrade.reasonAttribution ?? {};
    // A market read: the bearish-rating gate the operator must not relax.
    expect(attr['technicals-sell']?.gloss).toBe(
      'Technical rating was bearish (Sell / Strong-Sell)',
    );
    expect(attr['technicals-sell']?.kind).toBe('market');
    // A config lever: the RSI ceiling.
    expect(attr['indicator-rsi']?.gloss).toBe('RSI(14) was above your buy ceiling');
    expect(attr['indicator-rsi']?.kind).toBe('config');
    // A non-gate veto metric keyed by its metric name, tinted config.
    expect(attr['tt_regime_filter_veto']?.gloss).toBe('Market-regime filter blocked the entry');
    expect(attr['tt_regime_filter_veto']?.kind).toBe('config');
  });

  it('adds warm-up / invalid-data codes as gloss-only entries with no lever', () => {
    const attr = trailingTrade.reasonAttribution ?? {};
    for (const code of [
      'technicals-stale',
      'technicals-no-signal',
      'indicator-unavailable',
      'invalid-filters',
    ]) {
      const a = attr[code];
      expect(a?.gloss, code).toBeDefined();
      expect(a?.kind, code).toBe('data');
      expect(a?.setting, code).toBeUndefined();
      expect(a?.paths, code).toBeUndefined();
      expect(a?.note, code).toBeUndefined();
    }
    expect(attr['indicator-unavailable']?.gloss).toBe('Indicators were still warming up');
  });

  it('attributes the SMA / EMA / mean-reversion vetoes to their indicator-gate paths', () => {
    const attr = trailingTrade.reasonAttribution ?? {};
    expect(attr['indicator-sma']?.paths).toEqual(['buy.indicatorGate.smaBias']);
    expect(attr['indicator-ema']?.paths).toEqual(['buy.indicatorGate.emaBias']);
    expect(attr['indicator-mean-reversion']?.paths).toEqual([
      'buy.meanReversionGate.entryZScoreMax',
    ]);
  });

  it('attributes the technicals-disallowed veto to the technicals interval levels', () => {
    expect(trailingTrade.reasonAttribution?.['technicals-disallowed']?.paths).toEqual([
      'technicals.intervals',
    ]);
  });

  it('marks the exchange-minimum codes as notes with no editable path', () => {
    for (const code of ['min-notional', 'min-qty']) {
      const a = trailingTrade.reasonAttribution?.[code];
      expect(a?.note, code).toBeDefined();
      expect(a?.paths, code).toBeUndefined();
    }
  });

  it('marks the three auto-discovery guards as notes with no editable path', () => {
    for (const code of [
      'tt_discovery_guardrail_veto',
      'tt_discovery_chase_guard_veto',
      'tt_discovery_knife_guard_veto',
    ]) {
      const a = trailingTrade.reasonAttribution?.[code];
      expect(a?.note, code).toBeDefined();
      expect(a?.paths, code).toBeUndefined();
    }
  });

  it('attributes the risk-cap veto to the exposure-cap config paths', () => {
    const a = trailingTrade.reasonAttribution?.['tt_risk_cap_veto'];
    expect(a?.paths).toContain('buy.maxSymbolExposureQuote');
    expect(a?.paths).toContain('buy.accountCap');
  });

  it('attributes the RSI veto to the indicator-gate RSI ceiling path', () => {
    expect(trailingTrade.reasonAttribution?.['indicator-rsi']?.paths).toEqual([
      'buy.indicatorGate.rsiMaxBuy',
    ]);
  });

  it('marks the bearish-rating gate as a note with no editable path', () => {
    const a = trailingTrade.reasonAttribution?.['technicals-sell'];
    expect(a?.note).toBeDefined();
    expect(a?.paths).toBeUndefined();
  });

  it('attributes the min-purchase skip to the entry-level floor path', () => {
    expect(trailingTrade.reasonAttribution?.['min-purchase']?.paths).toContain(
      'buy.gridLevels[0].minPurchaseAmount',
    );
  });
});
