import { describe, expect, it } from 'vitest';
import { mergeConfig } from '../src/index.js';

describe('mergeConfig', () => {
  it('returns the base verbatim when the override is null or undefined', () => {
    const base = { buy: { enabled: true } };
    expect(mergeConfig(base, null)).toBe(base);
    expect(mergeConfig(base, undefined)).toBe(base);
  });

  it('deep-merges plain objects key by key', () => {
    const base = { buy: { enabled: true, maxPurchaseAmount: '10' }, sell: { enabled: true } };
    const merged = mergeConfig(base, { buy: { maxPurchaseAmount: '99' } });
    expect(merged).toEqual({
      buy: { enabled: true, maxPurchaseAmount: '99' },
      sell: { enabled: true },
    });
  });

  it('adds keys present only in the override', () => {
    expect(mergeConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('replaces arrays wholesale rather than merging element-wise', () => {
    const base = { buy: { gridLevels: [{ usdAmount: '10' }, { usdAmount: '20' }] } };
    const merged = mergeConfig(base, { buy: { gridLevels: [{ usdAmount: '5' }] } });
    expect(merged).toEqual({ buy: { gridLevels: [{ usdAmount: '5' }] } });
  });

  it('replaces scalars from the override', () => {
    expect(mergeConfig({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('stringifies a numeric override onto a decimal-string base (numeric override path)', () => {
    // A numeric override (e.g. an advisor patch) hits a decimal-string field.
    expect(
      mergeConfig({ sell: { triggerPercentage: '1.05' } }, { sell: { triggerPercentage: 1.07 } }),
    ).toEqual({ sell: { triggerPercentage: '1.07' } });
    // A string base + string override is untouched (live per-symbol merge).
    expect(mergeConfig({ x: '0.97' }, { x: '0.95' })).toEqual({ x: '0.95' });
    // A numeric base + numeric override stays numeric (genuine number field).
    expect(mergeConfig({ minutes: 20 }, { minutes: 30 })).toEqual({ minutes: 30 });
  });

  it('index-merges a numeric-keyed object onto an array base (index-override path)', () => {
    // Patch element 0's whenBuy, leaving its other fields and element 1 intact.
    const base = {
      technicals: {
        intervals: [
          { interval: '1h', whenBuy: false, mode: 'block' },
          { interval: '1d', whenBuy: true, mode: 'block' },
        ],
      },
    };
    const merged = mergeConfig(base, { technicals: { intervals: { 0: { whenBuy: true } } } });
    expect(merged).toEqual({
      technicals: {
        intervals: [
          { interval: '1h', whenBuy: true, mode: 'block' },
          { interval: '1d', whenBuy: true, mode: 'block' },
        ],
      },
    });
  });

  it('still replaces an array wholesale when the override is itself an array', () => {
    // Grid ladders are replace-not-merge; a numeric-keyed object is the only
    // shape that index-merges, so a plain array override is unaffected.
    const base = { buy: { gridLevels: [{ usdAmount: '10' }, { usdAmount: '20' }] } };
    const merged = mergeConfig(base, { buy: { gridLevels: [{ usdAmount: '5' }] } });
    expect(merged).toEqual({ buy: { gridLevels: [{ usdAmount: '5' }] } });
  });

  it('replaces the base outright when the override is a non-object', () => {
    expect(mergeConfig({ a: 1 }, 'scalar')).toBe('scalar');
    expect(mergeConfig({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });

  it('appends an out-of-range index-keyed override element to a shorter array base', () => {
    // An index-keyed override can address an element past the current array
    // length; that position takes the override value verbatim (no base to merge).
    const base = { technicals: { intervals: [{ interval: '1h', whenBuy: false }] } };
    const merged = mergeConfig(base, {
      technicals: { intervals: { 1: { interval: '1d', whenBuy: true } } },
    });
    expect(merged).toEqual({
      technicals: {
        intervals: [
          { interval: '1h', whenBuy: false },
          { interval: '1d', whenBuy: true },
        ],
      },
    });
  });

  it('does not mutate either argument', () => {
    const base = { buy: { enabled: true } };
    const override = { buy: { enabled: false } };
    mergeConfig(base, override);
    expect(base).toEqual({ buy: { enabled: true } });
    expect(override).toEqual({ buy: { enabled: false } });
  });

  it('skips prototype-chain keys in the override (no pollution)', () => {
    // JSON.parse makes __proto__ an own enumerable key, so Object.entries surfaces
    // it to the merge — the guard must drop it rather than walk the prototype.
    const override = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "ok": 2}',
    ) as Record<string, unknown>;
    const merged = mergeConfig({ ok: 1 }, override) as Record<string, unknown>;
    expect(merged).toEqual({ ok: 2 });
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
    expect(Object.hasOwn(merged, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
