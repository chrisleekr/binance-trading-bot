// The two ends of one klines request, pinned against each other.
//
// `MAX_CANDLE_WINDOW` (strategy-core) is how many CLOSED candles the pipeline promises a strategy; `BINANCE_MAX_KLINE_LIMIT` is the largest `limit` Binance accepts. One response carries at most `limit` rows and at most `limit - 1` closed ones, so the promise is deliverable only while the window sits exactly one below the ceiling. strategy-core cannot import the Binance constant — `@app/binance` depends on strategy-core, so the edge would cycle — which is why the relationship is asserted here rather than expressed in code.

import { describe, expect, it, vi } from 'vitest';

import { MAX_CANDLE_WINDOW } from '@app/strategy-core';

import {
  BINANCE_MAX_KLINE_LIMIT,
  createKlineFetcher,
  type BinanceWs,
  type BinanceWsFactory,
  type ClosedKline,
} from '../src/index.js';

type KlineFetcherLogger = Parameters<typeof createKlineFetcher>[0]['logger'];

const silentLogger: KlineFetcherLogger = {
  info: vi.fn<KlineFetcherLogger['info']>(),
  warn: vi.fn<KlineFetcherLogger['warn']>(),
};

// `loadWindow` on an unsubscribed key opens no socket, so the factory is only here to satisfy the constructor.
const inertWsFactory: BinanceWsFactory = (): BinanceWs => ({
  send: () => undefined,
  close: () => undefined,
  onOpen: () => undefined,
  onMessage: () => undefined,
  onClose: () => undefined,
  onError: () => undefined,
});

const closedKline = (openMs: number): ClosedKline => ({
  openTimeMs: openMs,
  closeTimeMs: openMs + 59_999,
  open: '1',
  high: '1',
  low: '1',
  close: '1',
  volume: '1',
  isClosed: true,
});

describe('candle-window ceiling vs the Binance klines limit', () => {
  it('promises exactly the closed candles one request can supply', () => {
    expect(MAX_CANDLE_WINDOW).toBe(BINANCE_MAX_KLINE_LIMIT - 1);
  });

  it('spends the whole Binance limit to fill a ceiling-sized window', async () => {
    const rest = vi.fn(async () => [closedKline(1000)]);
    const fetcher = createKlineFetcher({
      wsUrl: 'wss://fake/ws',
      wsFactory: inertWsFactory,
      fetchRestKlines: rest,
      logger: silentLogger,
    });
    await fetcher.loadWindow('BTCUSDT', '1h', MAX_CANDLE_WINDOW);
    // One below and the newest row comes back still forming, leaving the window one candle short of what the strategy was promised.
    expect(rest).toHaveBeenCalledWith('BTCUSDT', '1h', BINANCE_MAX_KLINE_LIMIT);
  });
});
