import { describe, expect, it } from 'vitest';

import {
  evaluateBuyGateForInterval,
  evaluateForceSellForInterval,
} from '../src/features/symbol/lib/technicals-gate-display';

import type { TechnicalsIntervalConfig, TechnicalsSignal } from '@app/contracts';

const row = (over: Partial<TechnicalsIntervalConfig> = {}): TechnicalsIntervalConfig => ({
  interval: '1h',
  whenStrongBuy: false,
  whenBuy: false,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  ...over,
});

const signal = (
  over: Partial<TechnicalsSignal> & { recommendation: TechnicalsSignal['recommendation'] },
): TechnicalsSignal => ({
  symbol: 'BTCUSDT',
  recommendation: over.recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: 0,
  indicators: null,
  stale: false,
  ...over,
});

const NOW = 1_000_000;

describe('evaluateBuyGateForInterval', () => {
  it('returns inactive when no buy toggles are on', () => {
    const status = evaluateBuyGateForInterval(
      row(),
      signal({ recommendation: 'STRONG_BUY', receivedAtMs: NOW }),
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'inactive', reason: 'no-toggles' });
  });

  it('returns pending when no signal is available', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true }),
      null,
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'pending', reason: 'no-signal' });
  });

  it('blocks on stale signal with do-not-buy', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true }),
      signal({ recommendation: 'STRONG_BUY', receivedAtMs: NOW - 5 * 60_000 }),
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'block', reason: 'stale', recommendation: 'STRONG_BUY' });
  });

  it('passes a stale signal when allow-anyway and verdict matches', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true }),
      signal({ recommendation: 'STRONG_BUY', receivedAtMs: NOW - 5 * 60_000 }),
      2,
      'allow-anyway',
      NOW,
    );
    expect(status).toEqual({ kind: 'pass', recommendation: 'STRONG_BUY' });
  });

  it('NEUTRAL always passes regardless of toggles', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true }),
      signal({ recommendation: 'NEUTRAL', receivedAtMs: NOW }),
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'pass', recommendation: 'NEUTRAL' });
  });

  it('SELL always vetoes regardless of toggles', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true, whenBuy: true }),
      signal({ recommendation: 'SELL', receivedAtMs: NOW }),
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'block', reason: 'sell', recommendation: 'SELL' });
  });

  it('still blocks SELL on a stale signal with allow-anyway (ALWAYS_VETO trumps freshness)', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true, whenBuy: true }),
      signal({ recommendation: 'SELL', receivedAtMs: NOW - 10 * 60_000 }),
      2,
      'allow-anyway',
      NOW,
    );
    expect(status).toEqual({ kind: 'block', reason: 'sell', recommendation: 'SELL' });
  });

  it('treats a future-dated signal as fresh (clock-skew clamp)', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true }),
      signal({ recommendation: 'STRONG_BUY', receivedAtMs: NOW + 30_000 }),
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'pass', recommendation: 'STRONG_BUY' });
  });

  it('blocks BUY when only whenStrongBuy is on', () => {
    const status = evaluateBuyGateForInterval(
      row({ whenStrongBuy: true }),
      signal({ recommendation: 'BUY', receivedAtMs: NOW }),
      2,
      'do-not-buy',
      NOW,
    );
    expect(status).toEqual({ kind: 'block', reason: 'not-allowed', recommendation: 'BUY' });
  });
});

describe('evaluateForceSellForInterval', () => {
  it('returns inactive when no sell toggles are on', () => {
    const status = evaluateForceSellForInterval(
      row({ whenStrongBuy: true }),
      signal({ recommendation: 'SELL', receivedAtMs: NOW }),
      2,
      NOW,
    );
    expect(status).toEqual({ kind: 'inactive', reason: 'no-toggles' });
  });

  it('returns pending no-signal when null', () => {
    const status = evaluateForceSellForInterval(row({ whenSell: true }), null, 2, NOW);
    expect(status).toEqual({ kind: 'pending', reason: 'no-signal' });
  });

  it('returns pending stale on stale signal (ignores ifExpires)', () => {
    const status = evaluateForceSellForInterval(
      row({ whenSell: true }),
      signal({ recommendation: 'SELL', receivedAtMs: NOW - 5 * 60_000 }),
      2,
      NOW,
    );
    expect(status).toEqual({ kind: 'pending', reason: 'stale' });
  });

  it('arms when signal matches the row trigger set', () => {
    const status = evaluateForceSellForInterval(
      row({ whenStrongSell: true }),
      signal({ recommendation: 'STRONG_SELL', receivedAtMs: NOW }),
      2,
      NOW,
    );
    expect(status).toEqual({ kind: 'armed', recommendation: 'STRONG_SELL' });
  });

  it('idles when signal does not match the trigger set', () => {
    const status = evaluateForceSellForInterval(
      row({ whenSell: true }),
      signal({ recommendation: 'BUY', receivedAtMs: NOW }),
      2,
      NOW,
    );
    expect(status).toEqual({ kind: 'idle', recommendation: 'BUY' });
  });
});
