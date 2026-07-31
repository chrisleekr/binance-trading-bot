// config-diff — diffConfig (incl. mergeConfig round-trip), overrideLeaves, paths.

import { mergeConfig } from '@app/strategy-core/merge-config';
import { describe, expect, it } from 'vitest';

import {
  deepEqual,
  diffConfig,
  overrideLeaves,
  valueAtPath,
} from '../src/shared/lib/config-diff.js';

describe('diffConfig', () => {
  it('returns null when current equals base', () => {
    expect(diffConfig({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBeNull();
  });

  it('keeps only the differing scalar leaf', () => {
    expect(diffConfig({ a: 1, b: 2 }, { a: 1, b: 9 })).toEqual({ b: 9 });
  });

  it('recurses into nested objects and keeps only the changed sub-leaf', () => {
    const base = { buy: { maxPurchaseAmount: '50', enabled: true }, sell: { enabled: false } };
    const current = { buy: { maxPurchaseAmount: '20', enabled: true }, sell: { enabled: false } };
    expect(diffConfig(base, current)).toEqual({ buy: { maxPurchaseAmount: '20' } });
  });

  it('replaces an array whole when any element differs', () => {
    const base = { grid: [{ usd: '10' }, { usd: '20' }] };
    const current = { grid: [{ usd: '10' }, { usd: '99' }] };
    expect(diffConfig(base, current)).toEqual({ grid: [{ usd: '10' }, { usd: '99' }] });
  });

  it('omits an array that is deep-equal to the base', () => {
    const base = { grid: [{ usd: '10' }] };
    const current = { grid: [{ usd: '10' }], other: 1 };
    expect(diffConfig(base, current)).toEqual({ other: 1 });
  });

  it('includes a key present in current but absent from base', () => {
    expect(diffConfig({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 });
  });
});

describe('diffConfig round-trip with mergeConfig', () => {
  // The editor diffs the form back to a minimal override, then the worker's
  // `mergeConfig` reconstitutes it. The diff is only correct if that round
  // trip is the identity — `mergeConfig(base, diffConfig(base, current))`
  // must equal `current`.
  it('mergeConfig(base, diffConfig(base, current)) === current', () => {
    const base = { buy: { maxPurchaseAmount: '50', enabled: true }, grid: [{ usd: '10' }] };
    const current = { buy: { maxPurchaseAmount: '20', enabled: true }, grid: [{ usd: '10' }] };
    expect(mergeConfig(base, diffConfig(base, current))).toEqual(current);
  });

  it('a null diff (current equals base) leaves base intact', () => {
    const base = { buy: { maxPurchaseAmount: '50', enabled: true } };
    expect(mergeConfig(base, diffConfig(base, { ...base }))).toEqual(base);
  });
});

describe('overrideLeaves', () => {
  it('returns an empty list for a null override', () => {
    expect(overrideLeaves({ a: 1 }, null)).toEqual([]);
  });

  it('flattens nested overrides to dot-path leaves with inherited values', () => {
    const base = { buy: { maxPurchaseAmount: '50', enabled: true } };
    const override = { buy: { maxPurchaseAmount: '20' } };
    expect(overrideLeaves(base, override)).toEqual([
      { path: 'buy.maxPurchaseAmount', override: '20', inherited: '50' },
    ]);
  });

  it('treats an array override as a single leaf', () => {
    const base = { grid: [{ usd: '10' }] };
    const override = { grid: [{ usd: '99' }] };
    expect(overrideLeaves(base, override)).toEqual([
      { path: 'grid', override: [{ usd: '99' }], inherited: [{ usd: '10' }] },
    ]);
  });
});

describe('deepEqual / valueAtPath', () => {
  it('compares nested structures structurally', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1] }, { a: [2] })).toBe(false);
  });

  it('reads a dot-path value and returns undefined for a missing path', () => {
    expect(valueAtPath({ buy: { maxPurchaseAmount: '50' } }, 'buy.maxPurchaseAmount')).toBe('50');
    expect(valueAtPath({ buy: {} }, 'buy.missing.deep')).toBeUndefined();
  });
});
