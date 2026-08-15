import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import {
  prepareTechnicalsRatingWindow,
  TECHNICALS_KLINE_REQUEST_LIMIT,
  TECHNICALS_RATING_BAR_LIMIT,
  TECHNICALS_SOURCE_CANDLE_LIMIT,
} from '../../src/technicals/rating-window.js';

const MINUTE_MS = 60_000;

const candle = (index: number, volume = '1'): Candle => ({
  openTimeMs: index * MINUTE_MS,
  closeTimeMs: (index + 1) * MINUTE_MS - 1,
  open: String(index),
  high: String(index + 1),
  low: String(index - 1),
  close: String(index),
  volume,
  isClosed: true,
});

describe('prepareTechnicalsRatingWindow', () => {
  it('locks the Binance request, closed-source, and traded-rating limits', () => {
    expect(TECHNICALS_KLINE_REQUEST_LIMIT).toBe(1_000);
    expect(TECHNICALS_SOURCE_CANDLE_LIMIT).toBe(999);
    expect(TECHNICALS_RATING_BAR_LIMIT).toBe(250);
  });

  it('takes the raw 999-bar tail before selecting the latest 250 traded bars', () => {
    const source = Array.from({ length: 1_100 }, (_, index) =>
      candle(index, index === 1_099 || index % 10 === 0 ? '0.00000000' : '1'),
    );
    const expected = source
      .slice(-999)
      .filter((row) => row.volume !== '0.00000000')
      .slice(-250);

    const result = prepareTechnicalsRatingWindow(source);

    expect(result).toHaveLength(250);
    expect(result.map((row) => row.openTimeMs)).toEqual(expected.map((row) => row.openTimeMs));
    expect(result[0]?.openTimeMs).toBeGreaterThanOrEqual(101 * MINUTE_MS);
    expect(result.at(-1)?.openTimeMs).toBe(1_098 * MINUTE_MS);
  });

  it('removes decimal zero volumes without discarding a positive decimal volume', () => {
    const result = prepareTechnicalsRatingWindow([
      candle(1, '0'),
      candle(2, '0.00000000'),
      candle(3, '0.00000001'),
    ]);
    expect(result.map((row) => row.openTimeMs)).toEqual([3 * MINUTE_MS]);
  });
});
