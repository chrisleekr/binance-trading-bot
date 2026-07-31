import { bench, describe } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { sma, ema, rsi, atr, lowestLow, highestHigh } from '../src/index.js';

const mkWindow = (n: number): readonly Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const close = (100 + Math.sin(i / 7) * 5).toFixed(8);
    const high = (Number(close) + 0.5).toFixed(8);
    const low = (Number(close) - 0.5).toFixed(8);
    return {
      openTimeMs: i * 60_000,
      closeTimeMs: i * 60_000 + 60_000,
      open: close,
      high,
      low,
      close,
      volume: '1',
      isClosed: true,
    };
  });

const w100 = mkWindow(100);
const w20 = mkWindow(20);

describe('indicators p99 cold compute', () => {
  bench('sma(20) on 100-candle window', () => {
    sma(w100, 20);
  });

  bench('ema(100) cold seed', () => {
    ema(w100, 100);
  });

  bench('rsi(14) on 100-candle window', () => {
    rsi(w100, 14);
  });

  bench('atr(14) on 100-candle window', () => {
    atr(w100, 14);
  });

  bench('lowestLow on 20-candle window', () => {
    lowestLow(w20);
  });

  bench('highestHigh on 20-candle window', () => {
    highestHigh(w20);
  });
});
