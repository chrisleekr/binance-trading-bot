import { describe, it, expect } from 'vitest';

import {
  adx,
  adxCurrPrev,
  aoCurrPrevPrev2,
  cciCurrPrev,
  directionalIndicators,
  ema,
  emaCurrPrev,
  lastClose,
  macd,
  momentumCurrPrev,
  rsiCurrPrev,
  sma,
  stoch,
  stochRsi,
  vwma,
  williamsCurrPrev,
  wma,
} from '../../src/rating/adapter.js';
import { loadCanonicalBtc1h, mkCloseWindow } from './test-utils.js';

const seq = (n: number): string[] => Array.from({ length: n }, (_, i) => String(100 + i));

describe('adapter — boundary handling', () => {
  it('returns null when the window is shorter than required lookback', () => {
    const short = mkCloseWindow(['100', '101', '102']);
    expect(sma(short, 20)).toBeNull();
    expect(ema(short, 20)).toBeNull();
    expect(adx(short, 14)).toBeNull();
    expect(macd(short)).toBeNull();
    expect(vwma(short, 20)).toBeNull();
  });

  it('*CurrPrev: returns {null, null} when the window is shorter than the lookback', () => {
    const C2 = { curr: null, prev: null };
    expect(rsiCurrPrev(mkCloseWindow(seq(14)))).toEqual(C2); // needs period+1 = 15
    expect(cciCurrPrev(mkCloseWindow(seq(19)))).toEqual(C2); // needs 20
    expect(adxCurrPrev(mkCloseWindow(seq(27)))).toEqual(C2); // needs period*2 = 28
    expect(momentumCurrPrev(mkCloseWindow(seq(10)))).toEqual(C2); // needs period+1 = 11
    expect(williamsCurrPrev(mkCloseWindow(seq(13)))).toEqual(C2); // needs 14
    expect(emaCurrPrev(mkCloseWindow(seq(12)), 13)).toEqual(C2); // needs 13
    expect(aoCurrPrevPrev2(mkCloseWindow(seq(33)))).toEqual({
      curr: null,
      prev: null,
      prev2: null,
    });
  });

  it('*CurrPrev: prev warms up exactly one bar after curr (single-pass null edges)', () => {
    // The previous value is read off the same updates() series as the current
    // one, so it goes non-null exactly one candle after the current value does.
    // RSI(14): curr at 15 closes, prev at 16.
    expect(rsiCurrPrev(mkCloseWindow(seq(14)))).toEqual({ curr: null, prev: null });
    const rsiAt15 = rsiCurrPrev(mkCloseWindow(seq(15)));
    expect(rsiAt15.curr).not.toBeNull();
    expect(rsiAt15.prev).toBeNull();
    expect(rsiCurrPrev(mkCloseWindow(seq(16))).prev).not.toBeNull();

    // EMA(13): curr at 13, prev at 14.
    const emaAt13 = emaCurrPrev(mkCloseWindow(seq(13)), 13);
    expect(emaAt13.curr).not.toBeNull();
    expect(emaAt13.prev).toBeNull();

    // AO needs 34 candles (SMA-34): curr at 34, prev at 35, prev2 at 36.
    const aoAt34 = aoCurrPrevPrev2(mkCloseWindow(seq(34)));
    expect(aoAt34.curr).not.toBeNull();
    expect(aoAt34.prev).toBeNull();
    expect(aoAt34.prev2).toBeNull();
    expect(aoCurrPrevPrev2(mkCloseWindow(seq(36))).prev2).not.toBeNull();
  });

  it('lastClose returns the final candle close as Decimal', () => {
    const w = mkCloseWindow(['100', '101', '105.5']);
    expect(lastClose(w)?.toString()).toBe('105.5');
  });

  it('lastClose returns null on empty window', () => {
    expect(lastClose([])).toBeNull();
  });

  it('stochRsi returns null until %D is stable, then a {k,d} pair', () => {
    const cyc = (n: number) =>
      mkCloseWindow(Array.from({ length: n }, (_, i) => String(100 + (i % 7))));
    // 31 bars clears the length pre-check but %D (last to stabilise) is not ready.
    expect(stochRsi(cyc(31))).toBeNull();
    const out = stochRsi(cyc(40));
    expect(out).not.toBeNull();
    expect(out?.k.greaterThanOrEqualTo(0)).toBe(true);
    expect(out?.d.greaterThanOrEqualTo(0)).toBe(true);
  });
});

describe('adapter — projection memoisation is byte-identical and reference-safe', () => {
  // The per-call WeakMap memoisation keys on the window array reference, so it
  // must (1) return the same value when the same window is re-read, and (2)
  // never leak one window's projection to a distinct window with equal content.
  const data = Array.from({ length: 40 }, (_, i) => (100 + Math.sin(i) * 5).toFixed(4));

  it('repeated reads of one window reference agree', () => {
    const w = mkCloseWindow(data);
    expect(ema(w, 20)?.toString()).toBe(ema(w, 20)?.toString());
  });

  it('two distinct windows with identical content produce identical values', () => {
    const a = mkCloseWindow(data);
    const b = mkCloseWindow([...data]);
    expect(sma(a, 10)?.toString()).toBe(sma(b, 10)?.toString());
    expect(ema(a, 20)?.toString()).toBe(ema(b, 20)?.toString());
  });
});

describe('adapter — canonical BTC fixture (parity snapshot)', () => {
  const fixture = loadCanonicalBtc1h();
  const w = fixture.candles;

  // Snapshot values frozen on the canonical fixture: any regression in either
  // our adapter wiring or the vendored math will flip these to mismatch.
  it('produces stable values for every indicator', () => {
    const round = (d: ReturnType<typeof sma>, decimals = 4): string | null =>
      d == null ? null : d.toDecimalPlaces(decimals).toString();
    const out = {
      stochK: round(stoch(w)?.k ?? null),
      stochD: round(stoch(w)?.d ?? null),
      adx: round(adx(w)),
      diPlus: round(directionalIndicators(w)?.plus ?? null),
      diMinus: round(directionalIndicators(w)?.minus ?? null),
      macdLine: round(macd(w)?.macd ?? null),
      macdSignal: round(macd(w)?.signal ?? null),
      stochRsiK: round(stochRsi(w)?.k ?? null),
      stochRsiD: round(stochRsi(w)?.d ?? null),
      sma10: round(sma(w, 10), 2),
      ema10: round(ema(w, 10), 2),
      sma200: round(sma(w, 200), 2),
      ema200: round(ema(w, 200), 2),
      vwma20: round(vwma(w, 20), 2),
      wma9: round(wma(w, 9), 2),
    };
    expect(out).toMatchSnapshot();
  });
});
