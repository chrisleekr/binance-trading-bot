// Contract for createDailyAthRefresh — the daily-ath cron's per-symbol
// recovery path. Fetches the public 1d klines window and rewrites
// `ath:<symbol>`; refuses to overwrite on a bad upstream response.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { KlineParseError } from '@app/binance';
import { createDailyAthRefresh } from '../../src/crons/daily-ath.js';
import { athKey } from '../../src/indicator-computer/indicator-computer.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// One Binance kline row: [openTime, open, high, low, close, volume, closeTime].
const kline = (openTime: number, high: string): unknown => [
  openTime,
  '100',
  high,
  '90',
  '95',
  '1.0',
  openTime + 86_400_000,
];

const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Service Unavailable',
    json: async () => body,
  }) as unknown as Response;

describe('createDailyAthRefresh', () => {
  it('writes ath:<symbol> as the highest high across the kline window', async () => {
    const set = vi.fn(async () => 'OK');
    const fetchImpl = vi.fn(async () =>
      jsonResponse([kline(1, '100'), kline(2, '250'), kline(3, '180')]),
    );
    const refresh = createDailyAthRefresh({
      redis: { set } as unknown as Redis,
      logger: stubLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await refresh('BTCUSDT');

    expect(set).toHaveBeenCalledTimes(1);
    const [key, value] = set.mock.calls[0] ?? [];
    expect(key).toBe(athKey('BTCUSDT'));
    expect(value).toBe('250');
  });

  it('requests the 1d interval for the given symbol', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([kline(1, '100')]));
    const refresh = createDailyAthRefresh({
      redis: { set: vi.fn(async () => 'OK') } as unknown as Redis,
      logger: stubLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await refresh('ETHUSDT');

    const url = String(fetchImpl.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('symbol=ETHUSDT');
    expect(url).toContain('interval=1d');
  });

  it('drops the in-progress day so ATH is computed over closed candles only', async () => {
    const set = vi.fn(async () => 'OK');
    // Three rows: the last has a closeTime in the future (the open day);
    // its high of 999 must NOT reach the ATH.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        [1, '100', '120', '90', '95', '1', 1_000],
        [2, '100', '150', '90', '95', '1', 2_000],
        [3, '100', '999', '90', '95', '1', 9_999],
      ]),
    );
    const refresh = createDailyAthRefresh({
      redis: { set } as unknown as Redis,
      logger: stubLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // now sits between candle 2's close (2_000) and candle 3's (9_999).
      clock: { nowMs: () => 5_000 },
    });

    await refresh('BTCUSDT');

    expect(set.mock.calls[0]?.[1]).toBe('150');
  });

  it('throws on a non-OK upstream response (leaves the existing key intact)', async () => {
    const set = vi.fn(async () => 'OK');
    const refresh = createDailyAthRefresh({
      redis: { set } as unknown as Redis,
      logger: stubLogger,
      fetchImpl: (async () => jsonResponse(null, false, 503)) as unknown as typeof fetch,
    });

    await expect(refresh('BTCUSDT')).rejects.toThrow(/upstream 503/);
    expect(set).not.toHaveBeenCalled();
  });

  it('throws on an empty kline array rather than overwriting with a bad value', async () => {
    const set = vi.fn(async () => 'OK');
    const refresh = createDailyAthRefresh({
      redis: { set } as unknown as Redis,
      logger: stubLogger,
      fetchImpl: (async () => jsonResponse([])) as unknown as typeof fetch,
    });

    await expect(refresh('BTCUSDT')).rejects.toThrow(/0 klines/);
    expect(set).not.toHaveBeenCalled();
  });

  it('throws on a malformed wire row (layout drift) rather than overwriting from bad data', async () => {
    const set = vi.fn(async () => 'OK');
    const refresh = createDailyAthRefresh({
      redis: { set } as unknown as Redis,
      logger: stubLogger,
      // The open slot holds a number where a decimal-string is expected — the
      // signature of a reordered/changed wire layout. parseKlines must reject
      // it so the good ath:<symbol> key is left intact (issue #408).
      fetchImpl: (async () =>
        jsonResponse([[1, 100, '120', '90', '95', '1', 1_000]])) as unknown as typeof fetch,
    });

    await expect(refresh('BTCUSDT')).rejects.toThrow(KlineParseError);
    expect(set).not.toHaveBeenCalled();
  });
});
