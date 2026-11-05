import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import {
  weekendGapNeed,
  weekendGapReading,
  weekendGapSettings,
  weekendGapTarget,
} from '../src/weekend-gap.js';

const HOUR = 3_600_000;
const one = { candleInterval: '1h' };

const candleAt = (iso: string, close: string): Candle => {
  const openTimeMs = Date.parse(iso);
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + HOUR - 1,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  };
};

// Independent oracle: the weekday and hour come from the platform calendar (getUTCDay/getUTCHours), not the implementation's epoch arithmetic. Known dates: 2026-10-30 was a Friday, 2026-11-01 a Sunday.
const isSunday22 = (c: Candle): boolean => {
  const d = new Date(c.openTimeMs);
  return d.getUTCDay() === 0 && d.getUTCHours() === 22;
};

// Hourly closes from Friday 2026-10-30 20:00 UTC (the reference, 100) through Sunday 2026-11-01 22:00 UTC (the signal candle, `sundayClose`).
const week = (sundayClose: string, refClose = '100'): Candle[] => {
  const start = Date.parse('2026-10-30T20:00:00Z');
  return Array.from({ length: 51 }, (_, i) =>
    i === 0
      ? candleAt('2026-10-30T20:00:00Z', refClose)
      : {
          ...candleAt('2026-10-30T20:00:00Z', '100'),
          openTimeMs: start + i * HOUR,
          closeTimeMs: start + (i + 1) * HOUR - 1,
          close: i === 50 ? sundayClose : '100',
        },
  );
};

describe('weekendGapReading', () => {
  it('uses a signal candle the calendar oracle also calls Sunday 22:00 UTC', () => {
    expect(isSunday22(week('98').at(-1)!)).toBe(true);
    expect(new Date(week('98')[0]!.openTimeMs).getUTCDay()).toBe(5);
  });

  it('fires when the Sunday close is more than minGap under the Friday close', () => {
    const r = weekendGapReading(week('98'), one)!;
    expect(r).toEqual({ isEntryCandle: true, refClose: '100', gapPercent: '2', fired: true });
  });

  it('does not fire when the gap is smaller than minGap', () => {
    const r = weekendGapReading(week('99.5'), one)!;
    expect(r).toMatchObject({ isEntryCandle: true, gapPercent: '0.5', fired: false });
  });

  it('does not fire exactly at the threshold, and does just beyond it', () => {
    expect(weekendGapReading(week('99'), one)!.fired).toBe(false);
    expect(weekendGapReading(week('98.99'), one)!.fired).toBe(true);
  });

  it('scales the threshold by a configured minGap', () => {
    expect(weekendGapReading(week('98'), { ...one, weekendGap: { minGap: '0.03' } })!.fired).toBe(
      false,
    );
    expect(weekendGapReading(week('96'), { ...one, weekendGap: { minGap: '0.03' } })!.fired).toBe(
      true,
    );
  });

  it('does not fire on the wrong hour', () => {
    const w = week('98');
    const early = [...w.slice(0, -1), candleAt('2026-11-01T21:00:00Z', '98')];
    const r = weekendGapReading(early, one)!;
    expect(r).toEqual({ isEntryCandle: false, refClose: null, gapPercent: null, fired: false });
  });

  it('does not fire on the wrong weekday at 22:00 UTC', () => {
    // Saturday 2026-10-31 22:00 UTC and Monday 2026-11-02 22:00 UTC.
    for (const iso of ['2026-10-31T22:00:00Z', '2026-11-02T22:00:00Z']) {
      const w = [...week('98').slice(0, -1), candleAt(iso, '98')];
      expect(weekendGapReading(w, one)!.isEntryCandle).toBe(false);
    }
  });

  it('fails closed when the Friday candle is not in the window', () => {
    const r = weekendGapReading(week('98').slice(1), one)!;
    expect(r).toEqual({ isEntryCandle: true, refClose: null, gapPercent: null, fired: false });
  });

  it('is null off 1h candles and reads empty windows as no entry candle', () => {
    expect(weekendGapReading(week('98'), { candleInterval: '4h' })).toBeNull();
    expect(weekendGapReading([], one)!.isEntryCandle).toBe(false);
  });
});

describe('weekendGapTarget', () => {
  it('returns the Friday close for the stamp the entry tick writes', () => {
    const w = week('98', '101.5');
    const stamp = w.at(-1)!.closeTimeMs;
    expect(weekendGapTarget(w, stamp)!.toString()).toBe('101.5');
  });

  it('returns null once the Friday candle has left the window', () => {
    const w = week('98');
    expect(weekendGapTarget(w.slice(1), w.at(-1)!.closeTimeMs)).toBeNull();
  });
});

describe('weekendGapSettings and weekendGapNeed', () => {
  it('defaults and coerces', () => {
    expect(weekendGapSettings(undefined).minGap.toString()).toBe('0.01');
    expect(weekendGapSettings(undefined).maxHoldBars).toBe(72);
    const bad = weekendGapSettings({ minGap: '-1', maxHoldBars: 0 });
    expect(bad.maxHoldBars).toBe(72);
    expect(bad.minGap.toString()).toBe('0.01');
    expect(weekendGapSettings({ minGap: '0.02', maxHoldBars: 10 }).minGap.toString()).toBe('0.02');
  });

  it('needs the hold limit plus 52 candles', () => {
    expect(weekendGapNeed(undefined)).toBe(124);
    expect(weekendGapNeed({ maxHoldBars: 10 })).toBe(62);
  });
});
