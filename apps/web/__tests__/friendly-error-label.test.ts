// friendlyErrorLabel — operator-facing mapping of raw worker fetch-status
// `error` strings. Shared by the dashboard health pill and the symbol panel
// empty-body diagnostic so both surfaces agree on what an outage means.

import { describe, expect, it } from 'vitest';

import { friendlyErrorLabel } from '../src/features/technicals/lib/friendly-error-label.js';

describe('friendlyErrorLabel', () => {
  it('strips the worker composite wrapper before mapping', () => {
    expect(friendlyErrorLabel('all 3 rows failed: Binance klines: HTTP 429')).toBe(
      'binance rate-limited',
    );
  });
  it('maps Binance 418 / 429 to rate-limited', () => {
    expect(friendlyErrorLabel('Binance klines: HTTP 429 for BTCUSDT @ 1m')).toBe(
      'binance rate-limited',
    );
    expect(friendlyErrorLabel('Binance klines: HTTP 418 for BTCUSDT @ 1m')).toBe(
      'binance rate-limited',
    );
  });
  it('maps non-rate-limit 4xx to rejected', () => {
    expect(friendlyErrorLabel('Binance klines: HTTP 400 for BAD @ 1m')).toBe('binance rejected');
    expect(friendlyErrorLabel('Binance klines: HTTP 404 for BAD @ 1m')).toBe('binance rejected');
  });
  it('maps Binance 5xx variants to upstream error', () => {
    expect(friendlyErrorLabel('Binance klines: HTTP 503 for BTCUSDT @ 1m')).toBe('binance error');
  });
  it('maps timeout / abort to binance timeout', () => {
    expect(friendlyErrorLabel('The operation timeout')).toBe('binance timeout');
    expect(friendlyErrorLabel('signal abort')).toBe('binance timeout');
  });
  it('maps kline parse errors', () => {
    expect(friendlyErrorLabel('Binance klines: row shape unexpected')).toBe('kline parse error');
    expect(friendlyErrorLabel('Binance klines: response not an array')).toBe('kline parse error');
  });
  it('maps a pipeline-commit failure', () => {
    expect(friendlyErrorLabel('pipeline: EXEC failed')).toBe('redis commit failed');
  });
  it('falls through to the stripped label when no rule matches', () => {
    expect(friendlyErrorLabel('all 1 rows failed: weird_new_label')).toBe('weird_new_label');
    expect(friendlyErrorLabel('totally unknown')).toBe('totally unknown');
  });
});
