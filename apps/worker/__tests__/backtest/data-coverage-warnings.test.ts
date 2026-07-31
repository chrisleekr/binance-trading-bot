import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { dataCoverageWarnings } from '../../src/backtest/backtest-runner.js';

const HOUR = 3_600_000;

function candle(openTimeMs: number): Candle {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + HOUR - 1,
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '1',
    isClosed: true,
  };
}

/** `n` hourly candles starting at `startMs`. */
function series(n: number, startMs = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(startMs + i * HOUR));
}

describe('dataCoverageWarnings', () => {
  const range = (hours: number) => ({ fromMs: 0, toMs: hours * HOUR });

  it('is silent when coverage spans the requested range', () => {
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(100)]]);
    const { fromMs, toMs } = range(100);
    expect(dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR)).toEqual([]);
  });

  it('warns when a symbol covers well under the range (delisting / halt proxy)', () => {
    // Only 40 of an expected 100 hourly candles present.
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(40)]]);
    const { fromMs, toMs } = range(100);
    const out = dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('BTCUSDT');
    expect(out[0]).toContain('40%');
  });

  it('tolerates a small boundary shortfall below the threshold', () => {
    // 96 of 100 → 96% ≥ 95% threshold, no warning.
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(96)]]);
    const { fromMs, toMs } = range(100);
    expect(dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR)).toEqual([]);
  });

  it('treats exactly the 95% threshold as silent (strict <) and 94% as a warning', () => {
    const { fromMs, toMs } = range(100);
    const at = new Map<string, Candle[]>([['BTCUSDT|1h', series(95)]]);
    expect(dataCoverageWarnings(['BTCUSDT'], at, '1h', fromMs, toMs, HOUR)).toEqual([]);
    const below = new Map<string, Candle[]>([['BTCUSDT|1h', series(94)]]);
    expect(dataCoverageWarnings(['BTCUSDT'], below, '1h', fromMs, toMs, HOUR)).toHaveLength(1);
  });

  it('warns at 0% when the symbol was never loaded (no candle key)', () => {
    // The delisting / never-backfilled case: the map has no entry for the symbol.
    const { fromMs, toMs } = range(100);
    const out = dataCoverageWarnings(['GHOSTUSDT'], new Map(), '1h', fromMs, toMs, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('0%');
  });

  it('does not false-warn on a full series when fromMs is not interval-aligned', () => {
    // Real candle opens align to the interval; an arbitrary (unaligned) fromMs
    // must not make a complete series look short. 100 hourly candles at 1h..100h,
    // window starting 30m in.
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(100, HOUR)]]);
    expect(dataCoverageWarnings(['BTCUSDT'], byKey, '1h', 30 * 60_000, 101 * HOUR, HOUR)).toEqual(
      [],
    );
  });

  it('excludes warm-up candles loaded before the window', () => {
    // 100 candles in-window plus 200 of warm-up before fromMs: only the in-window
    // ones count, so coverage is full and nothing warns.
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(300, -200 * HOUR)]]);
    const { fromMs, toMs } = range(100);
    expect(dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR)).toEqual([]);
  });

  it('flags only the thin symbol in a basket', () => {
    const byKey = new Map<string, Candle[]>([
      ['BTCUSDT|1h', series(100)],
      ['DEADUSDT|1h', series(10)],
    ]);
    const { fromMs, toMs } = range(100);
    const out = dataCoverageWarnings(['BTCUSDT', 'DEADUSDT'], byKey, '1h', fromMs, toMs, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('DEADUSDT');
  });

  it('flags a contiguous gap the aggregate ratio hides in a long window', () => {
    // 1000-hour window with only 12 contiguous candles missing → 98.8% coverage,
    // above the 95% aggregate floor, so the position-blind ratio stays silent.
    const all = series(1000).filter((c) => {
      const i = c.openTimeMs / HOUR;
      return i < 500 || i >= 512; // drop the 12 bars [500, 511]
    });
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', all]]);
    const { fromMs, toMs } = range(1000);
    const out = dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('contiguous gap of 12');
  });

  it('flags a contiguous TAIL gap (symbol stops trading before the window end)', () => {
    // 988 dense bars then nothing for the last 12 → 98.8% aggregate (passes), but
    // a 12-bar tail hole (a delisting at the end) must still be caught.
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(988)]]);
    const { fromMs, toMs } = range(1000);
    const out = dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('contiguous gap of 12');
  });

  it('flags a contiguous HEAD gap (symbol starts trading after the window opens)', () => {
    // First 12 bars missing, then dense to the end → 98.8% aggregate (passes).
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', series(988, 12 * HOUR)]]);
    const { fromMs, toMs } = range(1000);
    const out = dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('contiguous gap of 12');
  });

  it('does not flag a contiguous gap below the 12-bar threshold', () => {
    const all = series(1000).filter((c) => {
      const i = c.openTimeMs / HOUR;
      return i < 500 || i >= 511; // drop 11 bars [500, 510]
    });
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', all]]);
    const { fromMs, toMs } = range(1000);
    expect(dataCoverageWarnings(['BTCUSDT'], byKey, '1h', fromMs, toMs, HOUR)).toEqual([]);
  });

  it('returns nothing for a degenerate non-positive range', () => {
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', []]]);
    expect(dataCoverageWarnings(['BTCUSDT'], byKey, '1h', 0, 0, HOUR)).toEqual([]);
  });
});
