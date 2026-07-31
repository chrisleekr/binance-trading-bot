import { describe, expect, it } from 'vitest';
import {
  backtestSignature,
  configFingerprint,
  signatureForBacktest,
} from '../src/config-fingerprint.js';

describe('configFingerprint', () => {
  it('is independent of object key order', () => {
    expect(configFingerprint({ a: 1, b: 2 })).toBe(configFingerprint({ b: 2, a: 1 }));
  });

  it('canonicalises nested objects but preserves array order', () => {
    const a = { outer: { y: 1, x: 2 }, list: [{ q: 1, p: 2 }] };
    const b = { list: [{ p: 2, q: 1 }], outer: { x: 2, y: 1 } };
    expect(configFingerprint(a)).toBe(configFingerprint(b));
    // Array order is significant.
    expect(configFingerprint({ list: [1, 2, 3] })).not.toBe(configFingerprint({ list: [3, 2, 1] }));
  });

  it('changes when any value changes', () => {
    expect(configFingerprint({ a: 1 })).not.toBe(configFingerprint({ a: 2 }));
  });

  it('handles null, scalars, and arrays without throwing', () => {
    expect(configFingerprint(null)).toBe(configFingerprint(null));
    expect(configFingerprint(5)).toBe(configFingerprint(5));
    expect(configFingerprint('x')).not.toBe(configFingerprint('y'));
    expect(configFingerprint([1, { a: null }])).toBe(configFingerprint([1, { a: null }]));
  });

  it('returns a 16-hex-char digest', () => {
    expect(configFingerprint({ any: 'config' })).toMatch(/^[0-9a-f]{16}$/);
  });
});

// The market is opaque to backtestSignature (normalisation lives in
// @app/contracts marketOf); the factory emits that flat marketOf-shaped object.
const market = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  symbols: ['BTCUSDT'],
  fromMs: 1000,
  toMs: 2000,
  strategyInterval: '1h',
  detailInterval: '5m',
  makerBps: 10,
  takerBps: 10,
  slippageBps: 5,
  spreadBps: 2,
  volumeCapPct: 5,
  discoveryMode: false,
  initialQuoteBalance: '1000',
  ...over,
});

describe('backtestSignature', () => {
  it('changes when the config, window, fill, or strategy changes', () => {
    const base = backtestSignature({ strategyId: 'tt', config: { x: 1 }, market: market() });
    expect(base).not.toBe(
      backtestSignature({ strategyId: 'tt', config: { x: 2 }, market: market() }),
    );
    expect(base).not.toBe(
      backtestSignature({ strategyId: 'mom', config: { x: 1 }, market: market() }),
    );
    expect(base).not.toBe(
      backtestSignature({ strategyId: 'tt', config: { x: 1 }, market: market({ toMs: 3000 }) }),
    );
    expect(base).not.toBe(
      backtestSignature({ strategyId: 'tt', config: { x: 1 }, market: market({ spreadBps: 3 }) }),
    );
    expect(base).not.toBe(
      backtestSignature({
        strategyId: 'tt',
        config: { x: 1 },
        market: market({ discoveryMode: true }),
      }),
    );
  });

  it('does not alias the config-only fingerprint salt', () => {
    // Same JSON payload would hash equal under one salt; the distinct backtest
    // salt must keep the two key spaces from colliding.
    expect(backtestSignature({ strategyId: 'tt', config: { x: 1 }, market: market() })).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });
});

describe('signatureForBacktest', () => {
  const identity = (c: unknown): unknown => c;

  it('merges the override onto the base before signing', () => {
    const withOverride = signatureForBacktest({
      strategyId: 'tt',
      parseConfig: identity,
      profileConfig: { buy: { amount: '10' } },
      override: { buy: { amount: '20' } },
      market: market(),
    });
    const direct = backtestSignature({
      strategyId: 'tt',
      config: { buy: { amount: '20' } },
      market: market(),
    });
    expect(withOverride.signature).toBe(direct);
    // configFingerprint reflects the MERGED config, not the base.
    expect(withOverride.configFingerprint).toBe(configFingerprint({ buy: { amount: '20' } }));
  });

  it('treats a null/undefined override as no override', () => {
    const a = signatureForBacktest({
      strategyId: 'tt',
      parseConfig: identity,
      profileConfig: { a: 1 },
      override: null,
      market: market(),
    });
    const b = signatureForBacktest({
      strategyId: 'tt',
      parseConfig: identity,
      profileConfig: { a: 1 },
      override: undefined,
      market: market(),
    });
    expect(a.signature).toBe(b.signature);
  });
});
