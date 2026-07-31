import { describe, expect, it } from 'vitest';

import { percentToStored, storedToPercent, type PercentMode } from '../src/percent';

describe('percent converters', () => {
  describe('above (multiplier >= 1)', () => {
    const cases: readonly [percent: string, stored: string][] = [
      ['1', '1.01'],
      ['5', '1.05'],
      ['0', '1'],
      ['1.5', '1.015'],
      ['0.1', '1.001'],
    ];
    it.each(cases)('percent %s ⇄ stored %s', (percent, stored) => {
      expect(percentToStored(percent, 'above')).toBe(stored);
      expect(storedToPercent(stored, 'above')).toBe(percent);
    });
  });

  describe('below (multiplier in (0, 1])', () => {
    const cases: readonly [percent: string, stored: string][] = [
      ['3', '0.97'],
      ['2', '0.98'],
      ['0', '1'],
      ['10', '0.9'],
      ['2.5', '0.975'],
    ];
    it.each(cases)('percent %s ⇄ stored %s', (percent, stored) => {
      expect(percentToStored(percent, 'below')).toBe(stored);
      expect(storedToPercent(stored, 'below')).toBe(percent);
    });
  });

  describe('fraction (stored verbatim in (0, 1))', () => {
    const cases: readonly [percent: string, stored: string][] = [
      ['5', '0.05'],
      ['10', '0.1'],
      ['2.5', '0.025'],
    ];
    it.each(cases)('percent %s ⇄ stored %s', (percent, stored) => {
      expect(percentToStored(percent, 'fraction')).toBe(stored);
      expect(storedToPercent(stored, 'fraction')).toBe(percent);
    });
  });

  it('passes the empty sentinel through both ways', () => {
    for (const mode of ['above', 'below', 'fraction'] as PercentMode[]) {
      expect(percentToStored('', mode)).toBe('');
      expect(storedToPercent('', mode)).toBe('');
    }
  });

  it('is exact — no IEEE-754 drift on the classic failing case', () => {
    // Number((1.01 - 1) * 100) === 1.0000000000000009; decimal.js must give "1".
    expect(storedToPercent('1.01', 'above')).toBe('1');
    expect(percentToStored('3', 'below')).toBe('0.97');
    // Round-trip stability across the whole below range.
    for (let p = 0; p <= 99; p += 1) {
      const s = percentToStored(String(p), 'below');
      expect(storedToPercent(s, 'below')).toBe(String(p));
    }
  });
});
