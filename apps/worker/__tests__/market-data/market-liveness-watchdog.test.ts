// Market-liveness watchdog: it must be inert while the WS is healthy, and while
// the WS is down (a genuine disconnect OR a silently-stalled-but-open socket) it
// must REST-poll each subscribed symbol and feed a synthetic mini-ticker (the
// same shape a real frame produces) so stops keep evaluating. The stall case
// additionally forces a reconnect so the dead socket is rebuilt.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import {
  createKlineGapPriceFetcher,
  createMarketLivenessWatchdog,
  GAP_PRICE_KLINE_LIMIT,
} from '../../src/market-data/market-liveness-watchdog.js';
import type { ParsedMarketEvent } from '../../src/market-data/types.js';

const silentLogger = pino({ level: 'silent' });

// Fresh-feed defaults: a connected socket whose last frame was just now. The
// stall tests override msSinceLastFrame; the gap tests set isConnected false.
const freshDeps = () => ({
  msSinceLastFrame: () => 0,
  forceReconnect: vi.fn(),
});

describe('createMarketLivenessWatchdog', () => {
  it('is inert while the WS is connected and frames are fresh — no poll, no feed, no reconnect', async () => {
    const fetchPrice = vi.fn(async () => '100');
    const feed = vi.fn(async () => undefined);
    const forceReconnect = vi.fn();
    const wd = createMarketLivenessWatchdog({
      isConnected: () => true,
      msSinceLastFrame: () => 1_000,
      forceReconnect,
      subscribedSymbols: () => ['BTCUSDT'],
      fetchPrice,
      feed,
      clock: { nowMs: () => 1_000 },
      logger: silentLogger,
    });
    await wd.runOnce();
    expect(fetchPrice).not.toHaveBeenCalled();
    expect(feed).not.toHaveBeenCalled();
    expect(forceReconnect).not.toHaveBeenCalled();
  });

  it('forces a reconnect AND gap-fills in the same pass when the socket is open but the feed is stalled', async () => {
    // Stateful isConnected: forceReconnect flips it false, exactly as the fetcher
    // does synchronously, so the same runOnce falls through to the gap-fill. The
    // real fetcher's synchronous flip is verified in the @app/binance suite
    // (kline-fetcher.test.ts, "forceReconnect ... flips isConnected false ...").
    let connected = true;
    const feed = vi.fn(async () => undefined);
    const forceReconnect = vi.fn(() => {
      connected = false;
    });
    const wd = createMarketLivenessWatchdog({
      isConnected: () => connected,
      msSinceLastFrame: () => 30_000, // > the 20s default threshold
      forceReconnect,
      subscribedSymbols: () => ['BTCUSDT'],
      fetchPrice: async () => '64000',
      feed,
      clock: { nowMs: () => 1_700 },
      logger: silentLogger,
    });
    await wd.runOnce();
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    // Fell through to the REST gap-fill in the same pass.
    expect(feed).toHaveBeenCalledTimes(1);
    expect(feed.mock.calls[0]?.[0]).toEqual({
      kind: 'mini-ticker',
      symbol: 'BTCUSDT',
      closePrice: '64000',
      eventTimeMs: 1_700,
    });
  });

  it('does NOT force a reconnect when connected with no subscribed symbols (no frames expected)', async () => {
    const forceReconnect = vi.fn();
    const feed = vi.fn(async () => undefined);
    const wd = createMarketLivenessWatchdog({
      isConnected: () => true,
      msSinceLastFrame: () => 999_999, // very stale, but nothing is subscribed
      forceReconnect,
      subscribedSymbols: () => [],
      fetchPrice: async () => null,
      feed,
      clock: { nowMs: () => 1 },
      logger: silentLogger,
    });
    await wd.runOnce();
    expect(forceReconnect).not.toHaveBeenCalled();
    expect(feed).not.toHaveBeenCalled();
  });

  it('honours a custom staleThresholdMs (floored at 10s)', async () => {
    let connected = true;
    const forceReconnect = vi.fn(() => {
      connected = false;
    });
    // Request 1s; it floors to 10s. 5s idle is under the floor ⇒ not stale.
    const wd = createMarketLivenessWatchdog(
      {
        isConnected: () => connected,
        msSinceLastFrame: () => 5_000,
        forceReconnect,
        subscribedSymbols: () => ['BTCUSDT'],
        fetchPrice: async () => '1',
        feed: async () => undefined,
        clock: { nowMs: () => 1 },
        logger: silentLogger,
      },
      { staleThresholdMs: 1_000 },
    );
    await wd.runOnce();
    expect(forceReconnect).not.toHaveBeenCalled();
  });

  it('during a gap, feeds a synthetic mini-ticker per symbol carrying the polled price', async () => {
    const prices: Record<string, string> = { BTCUSDT: '64000', ETHUSDT: '3000' };
    const feed = vi.fn(async () => undefined);
    const wd = createMarketLivenessWatchdog({
      isConnected: () => false,
      ...freshDeps(),
      subscribedSymbols: () => ['BTCUSDT', 'ETHUSDT'],
      fetchPrice: async (s) => prices[s] ?? null,
      feed,
      clock: { nowMs: () => 1_700 },
      logger: silentLogger,
    });
    await wd.runOnce();
    expect(feed).toHaveBeenCalledTimes(2);
    const events = feed.mock.calls.map((c) => c[0] as ParsedMarketEvent);
    expect(events).toContainEqual({
      kind: 'mini-ticker',
      symbol: 'BTCUSDT',
      closePrice: '64000',
      eventTimeMs: 1_700,
    });
    expect(events).toContainEqual({
      kind: 'mini-ticker',
      symbol: 'ETHUSDT',
      closePrice: '3000',
      eventTimeMs: 1_700,
    });
  });

  it('skips a symbol whose price is unavailable (null) without feeding', async () => {
    const feed = vi.fn(async () => undefined);
    const wd = createMarketLivenessWatchdog({
      isConnected: () => false,
      ...freshDeps(),
      subscribedSymbols: () => ['BTCUSDT'],
      fetchPrice: async () => null,
      feed,
      clock: { nowMs: () => 1 },
      logger: silentLogger,
    });
    await wd.runOnce();
    expect(feed).not.toHaveBeenCalled();
  });

  it('swallows a per-symbol poll failure and still feeds the others', async () => {
    const feed = vi.fn(async () => undefined);
    const wd = createMarketLivenessWatchdog({
      isConnected: () => false,
      ...freshDeps(),
      subscribedSymbols: () => ['BADUSDT', 'BTCUSDT'],
      fetchPrice: async (s) => {
        if (s === 'BADUSDT') throw new Error('REST 500');
        return '64000';
      },
      feed,
      clock: { nowMs: () => 1 },
      logger: silentLogger,
    });
    await expect(wd.runOnce()).resolves.toBeUndefined();
    expect(feed).toHaveBeenCalledTimes(1);
    expect((feed.mock.calls[0]?.[0] as ParsedMarketEvent).symbol).toBe('BTCUSDT');
  });

  describe('createKlineGapPriceFetcher', () => {
    it('requests limit 2 (the latest 1m bar is still forming and dropped) and returns the last closed close', async () => {
      const reqs: { symbol: string; interval: string; limit: number }[] = [];
      const fetchPrice = createKlineGapPriceFetcher(async (req) => {
        reqs.push(req);
        // fetchClosedKlines drops the open bar, so it yields the last CLOSED 1m.
        return [{ close: '63990' }];
      });
      expect(await fetchPrice('BTCUSDT')).toBe('63990');
      expect(reqs[0]).toEqual({ symbol: 'BTCUSDT', interval: '1m', limit: GAP_PRICE_KLINE_LIMIT });
      expect(GAP_PRICE_KLINE_LIMIT).toBe(2);
    });

    it('returns null when no closed bar is available (the limit:1 bug: empty after the open-bar drop)', async () => {
      const fetchPrice = createKlineGapPriceFetcher(async () => []);
      expect(await fetchPrice('BTCUSDT')).toBeNull();
    });
  });

  it('start arms an idempotent timer and returns a stop; stop clears it', () => {
    const wd = createMarketLivenessWatchdog({
      isConnected: () => true,
      ...freshDeps(),
      subscribedSymbols: () => [],
      fetchPrice: async () => null,
      feed: async () => undefined,
      clock: { nowMs: () => 1 },
      logger: silentLogger,
    });
    const stop = wd.start();
    // A second start replaces rather than stacks (no throw, no leak).
    wd.start();
    expect(() => stop()).not.toThrow();
    expect(() => wd.stop()).not.toThrow();
  });
});
