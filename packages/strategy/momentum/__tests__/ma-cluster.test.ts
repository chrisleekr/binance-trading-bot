import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import {
  atrPercentile,
  choppiness,
  maClusterConfirmBreak,
  maClusterMaxAtrPercentile,
  maClusterMaxChoppiness,
  maClusterMaxSpread,
  maClusterNeed,
  maClusterReading,
} from '../src/ma-cluster.js';

const candle = (i: number, close: string): Candle => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: (i + 1) * 3_600_000,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

// Flat closes at 10 put every average at exactly 10, so the cluster spread is 0 and the top is 10 until the tail moves.
const series = (tail: readonly string[], flatCount = 201 - tail.length): Candle[] => [
  ...Array.from({ length: flatCount }, (_, i) => candle(i, '10')),
  ...tail.map((c, k) => candle(flatCount + k, c)),
];

describe('maClusterReading', () => {
  // The judged close lifts the 20-candle average to 10.0025, the top; the spread is (10.0025 - 10.00025) / 10.05.
  it('fires on the close that crosses above every bunched average', () => {
    const r = maClusterReading(series(['10.05']), {});
    expect(r?.fired).toBe(true);
    expect(r?.top.toFixed()).toBe('10.0025');
    expect(r?.spread.toFixed(6)).toBe('0.000224');
  });

  it('does not fire when the averages are spread wider than maxSpread', () => {
    const r = maClusterReading(series(['10.05']), { maxSpread: '0.0002' });
    expect(r?.fired).toBe(false);
    expect(r?.bunched).toBe(false);
    expect(maClusterReading(series(['10.05']), {})?.bunched).toBe(true);
  });

  // The previous close 10.05 already sat above its top 10.0025, so 10.06 continues a break rather than starting one.
  it('does not fire again on the candle after the break', () => {
    expect(maClusterReading(series(['10.05', '10.06']), {})?.fired).toBe(false);
  });

  it('does not fire on a close equal to the top average', () => {
    expect(maClusterReading(series([]), {})?.fired).toBe(false);
  });

  it('reads null until the 200-candle average can be taken on the judged and the previous candle', () => {
    expect(maClusterNeed()).toBe(201);
    expect(maClusterReading(series(['10.05'], 199), {})).toBeNull();
  });
});

describe('maClusterMaxSpread', () => {
  it('defaults to 1% and falls back on an unparsable leaf', () => {
    expect(maClusterMaxSpread(undefined).toFixed()).toBe('0.01');
    expect(maClusterMaxSpread({ maxSpread: 'abc' }).toFixed()).toBe('0.01');
    expect(maClusterMaxSpread({ maxSpread: '0.02' }).toFixed()).toBe('0.02');
  });
});

// A tail that swings 9.99/10.01 and ends at 9.99, under the top average, before the break: the averages stay bunched but the last 14 candles reverse every hour. True ranges sum to 0.31 against a 0.06 range, so 100 x log(0.31/0.06)/log(14) = 62.2.
const zigzag = [...Array.from({ length: 13 }, (_, k) => (k % 2 ? '10.01' : '9.99')), '10.05'];

describe('choppiness', () => {
  it('reads 0 when the candles travel one way and 100 when nothing moves', () => {
    expect(choppiness(series(['10.05'])).toFixed()).toBe('0');
    expect(choppiness(series([])).toFixed()).toBe('100');
  });

  it('reads high when the candles keep reversing inside a band', () => {
    expect(choppiness(series(zigzag)).toFixed(1)).toBe('62.2');
  });
});

describe('maClusterReading with maxChoppiness', () => {
  it('refuses a break while choppiness is at or above the ceiling and says so', () => {
    const r = maClusterReading(series(zigzag), { maxChoppiness: '50' });
    expect(r?.fired).toBe(false);
    expect(r?.choppy).toBe(true);
    expect(maClusterReading(series(zigzag), {})?.fired).toBe(true);
  });

  it('refuses at exactly the ceiling', () => {
    expect(maClusterReading(series(zigzag), { maxChoppiness: '63' })?.fired).toBe(true);
    const at = choppiness(series(zigzag)).toFixed();
    expect(maClusterReading(series(zigzag), { maxChoppiness: at })?.fired).toBe(false);
  });

  it('lets a clean break through the gate', () => {
    const r = maClusterReading(series(['10.05']), { maxChoppiness: '50' });
    expect(r?.fired).toBe(true);
    expect(r?.choppy).toBe(false);
  });

  // The zigzag without its breaking candle is just as choppy, but ends at 9.99 under the top, so there is nothing to refuse.
  it('does not call a candle choppy when there was no break to refuse', () => {
    const r = maClusterReading(series(zigzag.slice(0, -1)), { maxChoppiness: '50' });
    expect(r?.choppiness.gt(50)).toBe(true);
    expect(r?.choppy).toBe(false);
  });
});

describe('maClusterMaxChoppiness', () => {
  it('is off when unset, empty or out of range, and parses a value in (0, 100]', () => {
    expect(maClusterMaxChoppiness(undefined)).toBeNull();
    expect(maClusterMaxChoppiness({ maxChoppiness: '' })).toBeNull();
    expect(maClusterMaxChoppiness({ maxChoppiness: null })).toBeNull();
    expect(maClusterMaxChoppiness({ maxChoppiness: 'abc' })).toBeNull();
    expect(maClusterMaxChoppiness({ maxChoppiness: '0' })).toBeNull();
    expect(maClusterMaxChoppiness({ maxChoppiness: '100.1' })).toBeNull();
    expect(maClusterMaxChoppiness({ maxChoppiness: '100' })?.toFixed()).toBe('100');
    expect(maClusterMaxChoppiness({ maxChoppiness: '50' })?.toFixed()).toBe('50');
  });
});

// Closes stay at 10, so every true range is just high minus low, the averages stay bunched at 10, and a judged close of 10.05 breaks above them with a true range of 0.05. 494 ranged candles plus the judged one is the 495 the gate needs.
const ranged = (high: string, low: string, judged: Candle = candle(494, '10.05')): Candle[] => [
  ...Array.from({ length: 494 }, (_, i) => ({ ...candle(i, '10'), high, low })),
  judged,
];
const calm = (): Candle[] => ranged('10.01', '9.99');
const wild = (): Candle[] => ranged('10.1', '9.9');

describe('atrPercentile', () => {
  it('reads 1 when the judged candle is more volatile than the whole lookback and 0 when calmer', () => {
    expect(atrPercentile(calm()).toFixed()).toBe('1');
    expect(atrPercentile(wild()).toFixed()).toBe('0');
  });

  // An independent oracle: rank each candle's ATR, computed from scratch by `@app/indicators` on its own prefix, as a share of its close. A one-pass shortcut that drifts from that, or ranks the wrong candles, shows up here.
  it('matches ranking per-candle ATRs from @app/indicators on an uneven walk', () => {
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let px = 100;
    const w: Candle[] = Array.from({ length: 495 }, (_, i) => {
      const prev = px;
      px = px * (1 + (rnd() - 0.5) * (i > 300 ? 0.06 : 0.02));
      const c = candle(i, px.toFixed(4));
      return {
        ...c,
        open: prev.toFixed(4),
        high: (Math.max(prev, px) * (1 + rnd() * 0.01)).toFixed(4),
        low: (Math.min(prev, px) * (1 - rnd() * 0.01)).toFixed(4),
      };
    });
    const rel = Array.from({ length: 481 }, (_, k) =>
      atr(w.slice(0, 15 + k), 14).div(w[14 + k]!.close),
    );
    const judged = rel[480]!;
    const want = new Decimal(rel.slice(0, 480).filter((x) => x.lt(judged)).length).div(480);
    expect(atrPercentile(w).toFixed()).toBe(want.toFixed());
    expect(want.gt(0) && want.lt(1)).toBe(true);
    // 481 full ATR passes in Decimal is the point of the oracle; under coverage on the CI runner it took 5.4s, past the 5s default.
  }, 30_000);
});

describe('maClusterReading with maxAtrPercentile', () => {
  it('refuses a break while volatility ranks above the ceiling and says so', () => {
    const r = maClusterReading(calm(), { maxAtrPercentile: '0.4' });
    expect(r?.fired).toBe(false);
    expect(r?.volatile).toBe(true);
    expect(r?.atrPercentile?.toFixed()).toBe('1');
    expect(maClusterReading(calm(), {})?.fired).toBe(true);
  });

  it('buys a break out of a calmer market', () => {
    const r = maClusterReading(wild(), { maxAtrPercentile: '0.4' });
    expect(r?.fired).toBe(true);
    expect(r?.volatile).toBe(false);
  });

  it('buys at exactly the ceiling', () => {
    expect(maClusterReading(calm(), { maxAtrPercentile: '1' })?.fired).toBe(true);
  });

  // The judged candle swings 9.9 to 10.1, as volatile as can be, but closes at 10, under the top, so there is no break to refuse.
  it('does not call a candle volatile when there was no break to refuse', () => {
    const r = maClusterReading(
      ranged('10.01', '9.99', { ...candle(494, '10'), high: '10.1', low: '9.9' }),
      {
        maxAtrPercentile: '0.4',
      },
    );
    expect(r?.atrPercentile?.toFixed()).toBe('1');
    expect(r?.volatile).toBe(false);
  });

  it('waits for the longer window only while the gate is on', () => {
    expect(maClusterNeed({ maxAtrPercentile: '0.4' })).toBe(495);
    expect(maClusterNeed({ maxAtrPercentile: '' })).toBe(201);
    expect(maClusterReading(calm().slice(1), { maxAtrPercentile: '0.4' })).toBeNull();
    expect(maClusterReading(calm().slice(1), {})?.atrPercentile).toBeNull();
  });
});

describe('maClusterMaxAtrPercentile', () => {
  it('is off when unset, empty or out of range, and parses a value in (0, 1]', () => {
    expect(maClusterMaxAtrPercentile(undefined)).toBeNull();
    expect(maClusterMaxAtrPercentile({ maxAtrPercentile: '' })).toBeNull();
    expect(maClusterMaxAtrPercentile({ maxAtrPercentile: 'abc' })).toBeNull();
    expect(maClusterMaxAtrPercentile({ maxAtrPercentile: '0' })).toBeNull();
    expect(maClusterMaxAtrPercentile({ maxAtrPercentile: '1.01' })).toBeNull();
    expect(maClusterMaxAtrPercentile({ maxAtrPercentile: '1' })?.toFixed()).toBe('1');
    expect(maClusterMaxAtrPercentile({ maxAtrPercentile: '0.4' })?.toFixed()).toBe('0.4');
  });
});

describe('maClusterReading with confirmBreak', () => {
  const on = { confirmBreak: true };

  it('holds the break candle itself and marks it unconfirmed', () => {
    const r = maClusterReading(series(['10.05'], 201), on);
    expect(r?.fired).toBe(false);
    expect(r?.unconfirmed).toBe(true);
    expect(maClusterReading(series(['10.05'], 201), {})?.unconfirmed).toBe(false);
  });

  it('fires on the next candle when it also closes above the top', () => {
    const r = maClusterReading(series(['10.05', '10.06'], 200), on);
    expect(r?.fired).toBe(true);
    expect(r?.unconfirmed).toBe(false);
  });

  // 10 sits under the top (10.0025 lifted by the break), so the break fell back and is skipped.
  it('skips the break when the next close falls back under the top', () => {
    expect(maClusterReading(series(['10.05', '10'], 200), on)?.fired).toBe(false);
  });

  // The break candle failed maxSpread, so nothing was armed and holding above the top does not buy.
  it('does not confirm a break that a gate refused', () => {
    expect(
      maClusterReading(series(['10.05', '10.06'], 200), { ...on, maxSpread: '0.0002' })?.fired,
    ).toBe(false);
  });

  it('needs one more candle, so the break candle can be judged as well', () => {
    expect(maClusterNeed(on)).toBe(202);
    expect(maClusterNeed({ ...on, maxAtrPercentile: '0.4' })).toBe(496);
    expect(maClusterReading(series(['10.05']), on)).toBeNull();
  });
});

describe('maClusterConfirmBreak', () => {
  it('is on only for a literal true', () => {
    expect(maClusterConfirmBreak(undefined)).toBe(false);
    expect(maClusterConfirmBreak({ confirmBreak: 'true' })).toBe(false);
    expect(maClusterConfirmBreak({ confirmBreak: false })).toBe(false);
    expect(maClusterConfirmBreak({ confirmBreak: true })).toBe(true);
  });
});
