import { describe, expect, it } from 'vitest';

import { resolveEntryBlocker, type EntryBlockerContext } from '../src/entry-blocker.js';

// A context with every veto local cleared; each test sets only the field(s) it
// exercises so the priority ordering is unambiguous.
const empty = (): EntryBlockerContext => ({
  forceSellCooled: false,
  lossExitCooled: false,
  regimeEntryBlock: null,
  regimeRequireUptrend: false,
  regimeVeto: null,
  riskCapVeto: null,
  guardrailVeto: null,
  chaseGuardVeto: null,
  knifeGuardVeto: null,
  tvVeto: null,
  technicalsConfirming: null,
  indicatorVeto: null,
  awaitingTrigger: null,
  skipReason: null,
});

describe('resolveEntryBlocker — null path', () => {
  it('returns null when nothing is blocking', () => {
    expect(resolveEntryBlocker(empty())).toBeNull();
  });
});

describe('resolveEntryBlocker — each reason maps through', () => {
  it('force-sell cooldown', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      forceSellCooled: true,
      forceSellDetail: { cooldownUntilMs: 123 },
    });
    expect(out).toEqual({ reason: 'force-sell-cooldown', detail: { cooldownUntilMs: 123 } });
  });

  it('force-sell cooldown without detail omits detail', () => {
    expect(resolveEntryBlocker({ ...empty(), forceSellCooled: true })).toEqual({
      reason: 'force-sell-cooldown',
    });
  });

  it('loss cooldown with detail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      lossExitCooled: true,
      lossDetail: { minutesLeft: 30 },
    });
    expect(out).toEqual({ reason: 'loss-cooldown', detail: { minutesLeft: 30 } });
  });

  it('loss cooldown without detail omits detail', () => {
    expect(resolveEntryBlocker({ ...empty(), lossExitCooled: true })).toEqual({
      reason: 'loss-cooldown',
    });
  });

  it('technicals-confirming carries the reads/required detail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      technicalsConfirming: { detail: { reads: 1, required: 3 } },
    });
    expect(out).toEqual({ reason: 'technicals-confirming', detail: { reads: 1, required: 3 } });
  });

  it('regime-exit bear', () => {
    const out = resolveEntryBlocker({ ...empty(), regimeEntryBlock: { interval: '1d' } });
    expect(out).toEqual({ reason: 'regime-exit-bear', detail: { interval: '1d' } });
  });

  it('regime-not-uptrend (require-uptrend gate) is labelled apart from the bear block', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      regimeEntryBlock: { interval: '1d' },
      regimeRequireUptrend: true,
    });
    expect(out).toEqual({ reason: 'regime-not-uptrend', detail: { interval: '1d' } });
  });

  it('regime veto (downtrend)', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      regimeVeto: { reason: 'regime-downtrend', context: { ma: '100' } },
    });
    expect(out).toEqual({ reason: 'regime-downtrend', detail: { ma: '100' } });
  });

  it('risk cap (exposure)', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      riskCapVeto: { cap: 'exposure-cap', context: { capQuote: '500' } },
    });
    expect(out).toEqual({ reason: 'exposure-cap', detail: { capQuote: '500' } });
  });

  it('discovery guardrail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      guardrailVeto: { reason: 'discovery-no-stop', context: { stopLossPercentage: '' } },
    });
    expect(out).toEqual({ reason: 'discovery-no-stop', detail: { stopLossPercentage: '' } });
  });

  it('chase guard carries the high/price/distance detail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      chaseGuardVeto: { high24h: '100', currentPrice: '98', distancePct: '3' },
    });
    expect(out).toEqual({
      reason: 'chase-guard',
      detail: { high24h: '100', currentPrice: '98', distancePct: '3' },
    });
  });

  it('knife guard carries the drop/candles detail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      knifeGuardVeto: { dropPct: '6', candles: 3 },
    });
    expect(out).toEqual({ reason: 'knife-guard', detail: { dropPct: '6', candles: 3 } });
  });

  it('technicals veto with detail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      tvVeto: { reason: 'technicals-sell', detail: { interval: '1m', recommendation: 'SELL' } },
    });
    expect(out).toEqual({
      reason: 'technicals-sell',
      detail: { interval: '1m', recommendation: 'SELL' },
    });
  });

  it('indicator veto', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      indicatorVeto: { reason: 'indicator-rsi', context: { rsi: '80' } },
    });
    expect(out).toEqual({ reason: 'indicator-rsi', detail: { rsi: '80' } });
  });

  it('awaiting-trigger-price carries the sparse window detail', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      awaitingTrigger: { windowLow: '95', triggerPercentage: '1', currentPrice: '96' },
    });
    expect(out).toEqual({
      reason: 'awaiting-trigger-price',
      detail: { windowLow: '95', triggerPercentage: '1', currentPrice: '96' },
    });
  });

  it('qty skip (min-notional) carries no detail', () => {
    expect(resolveEntryBlocker({ ...empty(), skipReason: 'min-notional' })).toEqual({
      reason: 'min-notional',
    });
  });
});

describe('resolveEntryBlocker — priority ordering', () => {
  it('force-sell cooldown beats every other blocker', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      forceSellCooled: true,
      regimeEntryBlock: { interval: '1d' },
      tvVeto: { reason: 'technicals-sell' },
      awaitingTrigger: { windowLow: '95', triggerPercentage: '1', currentPrice: '96' },
      skipReason: 'min-notional',
    });
    expect(out?.reason).toBe('force-sell-cooldown');
  });

  it('force-sell cooldown beats loss cooldown', () => {
    const out = resolveEntryBlocker({ ...empty(), forceSellCooled: true, lossExitCooled: true });
    expect(out?.reason).toBe('force-sell-cooldown');
  });

  it('loss cooldown beats regime-exit and every lower blocker', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      lossExitCooled: true,
      regimeEntryBlock: { interval: '1d' },
      tvVeto: { reason: 'technicals-sell' },
      skipReason: 'min-notional',
    });
    expect(out?.reason).toBe('loss-cooldown');
  });

  it('technicals veto beats technicals-confirming beats indicator', () => {
    expect(
      resolveEntryBlocker({
        ...empty(),
        tvVeto: { reason: 'technicals-sell' },
        technicalsConfirming: { detail: { reads: 1, required: 3 } },
        indicatorVeto: { reason: 'indicator-rsi', context: {} },
      })?.reason,
    ).toBe('technicals-sell');
    expect(
      resolveEntryBlocker({
        ...empty(),
        technicalsConfirming: { detail: { reads: 1, required: 3 } },
        indicatorVeto: { reason: 'indicator-rsi', context: {} },
      })?.reason,
    ).toBe('technicals-confirming');
  });

  it('regime-exit beats regime veto, caps, technicals', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      regimeEntryBlock: { interval: '1d' },
      regimeVeto: { reason: 'regime-downtrend', context: {} },
      riskCapVeto: { cap: 'exposure-cap', context: {} },
      tvVeto: { reason: 'technicals-sell' },
    });
    expect(out?.reason).toBe('regime-exit-bear');
  });

  it('risk cap beats guardrail and technicals', () => {
    const out = resolveEntryBlocker({
      ...empty(),
      riskCapVeto: { cap: 'loss-budget', context: {} },
      guardrailVeto: { reason: 'discovery-no-stop', context: {} },
      tvVeto: { reason: 'technicals-sell' },
    });
    expect(out?.reason).toBe('loss-budget');
  });

  it('guardrail beats chase beats knife beats technicals', () => {
    expect(
      resolveEntryBlocker({
        ...empty(),
        guardrailVeto: { reason: 'discovery-no-stop', context: {} },
        chaseGuardVeto: { high24h: '100', currentPrice: '98', distancePct: '3' },
        knifeGuardVeto: { dropPct: '6', candles: 3 },
        tvVeto: { reason: 'technicals-sell' },
      })?.reason,
    ).toBe('discovery-no-stop');
    expect(
      resolveEntryBlocker({
        ...empty(),
        chaseGuardVeto: { high24h: '100', currentPrice: '98', distancePct: '3' },
        knifeGuardVeto: { dropPct: '6', candles: 3 },
        tvVeto: { reason: 'technicals-sell' },
      })?.reason,
    ).toBe('chase-guard');
    expect(
      resolveEntryBlocker({
        ...empty(),
        knifeGuardVeto: { dropPct: '6', candles: 3 },
        tvVeto: { reason: 'technicals-sell' },
      })?.reason,
    ).toBe('knife-guard');
  });

  it('technicals beats indicator beats awaiting-trigger beats qty skip', () => {
    expect(
      resolveEntryBlocker({
        ...empty(),
        tvVeto: { reason: 'technicals-no-signal' },
        indicatorVeto: { reason: 'indicator-rsi', context: {} },
        awaitingTrigger: { windowLow: '1', triggerPercentage: '1', currentPrice: '1' },
        skipReason: 'min-qty',
      })?.reason,
    ).toBe('technicals-no-signal');
    expect(
      resolveEntryBlocker({
        ...empty(),
        indicatorVeto: { reason: 'indicator-rsi', context: {} },
        awaitingTrigger: { windowLow: '1', triggerPercentage: '1', currentPrice: '1' },
        skipReason: 'min-qty',
      })?.reason,
    ).toBe('indicator-rsi');
    expect(
      resolveEntryBlocker({
        ...empty(),
        awaitingTrigger: { windowLow: '1', triggerPercentage: '1', currentPrice: '1' },
        skipReason: 'min-qty',
      })?.reason,
    ).toBe('awaiting-trigger-price');
  });
});
