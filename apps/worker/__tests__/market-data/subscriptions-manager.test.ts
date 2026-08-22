// MarketSubscriptionsManager — translates port subscriptions into
// onMarketEvent callbacks. The asserts here are the contract that the
// rest of the worker (event-router) depends on:
//   - addSymbols opens kline (configured interval + 1m + 1d) + ticker subs.
//   - Closed klines pushed onto the port appear on onMarketEvent.
//   - Tickers pushed onto the port appear on onMarketEvent.
//   - removeSymbols decrements each interval's refcount and unsubscribes only
//     the intervals (and the ticker) whose last claimant leaves.
//   - stop drains everything.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createFakeMarketDataPort } from '@app/binance';

import {
  createMarketSubscriptionsManager,
  triggerResyncForAllSubscribed,
} from '../../src/market-data/subscriptions-manager.js';
import type { ParsedMarketEvent } from '../../src/market-data/types.js';

const silentLogger = pino({ level: 'silent' });

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const mkCandle = (openMs: number, close: string) => ({
  openTimeMs: openMs,
  closeTimeMs: openMs + 60_000 - 1,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true as const,
});

describe('createMarketSubscriptionsManager', () => {
  it('addSymbols opens kline (interval + 1m + 1d) + ticker subscriptions on the port', async () => {
    const port = createFakeMarketDataPort();
    const events: ParsedMarketEvent[] = [];
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async (e) => {
        events.push(e);
      },
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.start();
    await mgr.addSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);
    await mgr.stop();
  });

  it('dispatches a closed kline as a `kline` ParsedMarketEvent', async () => {
    const port = createFakeMarketDataPort();
    const events: ParsedMarketEvent[] = [];
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async (e) => {
        events.push(e);
      },
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1h');
    port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
    // Allow the async consumer loop to pick up the candle.
    await tick(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'kline',
      symbol: 'BTCUSDT',
      interval: '1h',
      close: '100',
      isClosed: true,
    });
    await mgr.stop();
  });

  it('dispatches a mini-ticker as a `mini-ticker` ParsedMarketEvent', async () => {
    const port = createFakeMarketDataPort();
    const events: ParsedMarketEvent[] = [];
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async (e) => {
        events.push(e);
      },
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1h');
    port.pushMiniTicker({ symbol: 'BTCUSDT', closePrice: '76800', eventTimeMs: 1_000 });
    await tick(10);
    const tickerEvents = events.filter((e) => e.kind === 'mini-ticker');
    expect(tickerEvents).toHaveLength(1);
    expect(tickerEvents[0]).toMatchObject({
      kind: 'mini-ticker',
      symbol: 'BTCUSDT',
      closePrice: '76800',
      eventTimeMs: 1_000,
    });
    await mgr.stop();
  });

  it('removeSymbols releases every subscription handle for the symbol', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);
    await mgr.removeSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(0);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    await mgr.stop();
  });

  it('clears indicator state for each interval whose last claim is released', async () => {
    const port = createFakeMarketDataPort();
    const cleared: string[] = [];
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      clearIndicatorState: async (s, iv) => {
        cleared.push(`${s}|${iv}`);
      },
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1h');
    await mgr.removeSymbols(['BTCUSDT'], '1h');
    // One clear per reaped interval (trading + 1m + 1d), once each.
    expect(cleared.sort()).toEqual(['BTCUSDT|1d', 'BTCUSDT|1h', 'BTCUSDT|1m']);
    await mgr.stop();
  });

  it('does not clear indicator state while another claim still holds the interval', async () => {
    const port = createFakeMarketDataPort();
    const cleared: string[] = [];
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      clearIndicatorState: async (s, iv) => {
        cleared.push(`${s}|${iv}`);
      },
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1h'); // claim 1
    await mgr.addSymbols(['BTCUSDT'], '1h'); // claim 2 (refcount 2)
    await mgr.removeSymbols(['BTCUSDT'], '1h'); // back to 1 — nothing reaped
    expect(cleared).toEqual([]);
    await mgr.removeSymbols(['BTCUSDT'], '1h'); // last claim — now reaped
    expect(cleared.sort()).toEqual(['BTCUSDT|1d', 'BTCUSDT|1h', 'BTCUSDT|1m']);
    await mgr.stop();
  });

  it('swallows a clearIndicatorState failure so teardown still completes', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      clearIndicatorState: async () => {
        throw new Error('redis down');
      },
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1h');
    await expect(mgr.removeSymbols(['BTCUSDT'], '1h')).resolves.toBeUndefined();
    // Subscriptions still released despite the clear throwing.
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    await mgr.stop();
  });

  it('a repeated claim on the same (symbol, interval) reuses one refcounted subscription', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    // Two profiles claim the same (symbol, interval): ONE port subscription,
    // refcounted to 2.
    await mgr.addSymbols(['BTCUSDT'], '1h');
    await mgr.addSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    // First remover drops the refcount but keeps the live sub for the other claim.
    await mgr.removeSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    // Second remover releases the last claim and the sub closes.
    await mgr.removeSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    await mgr.stop();
  });

  it('a 1m-trading profile opens exactly one 1m subscription (feedIntervals dedupes)', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '1m');
    // candleInterval '1m' collapses into the freshness '1m' — one sub, not two.
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    await mgr.removeSymbols(['BTCUSDT'], '1m');
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(0);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    await mgr.stop();
  });

  it('stop drains every subscription regardless of remaining stream state', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT', 'ETHUSDT'], '1h');
    await mgr.stop();
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    expect(port.subscriberCount('ETHUSDT', '1h')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(0);
    expect(port.subscriberCount('ETHUSDT', '1m')).toBe(0);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    expect(port.tickerSubscriberCount('ETHUSDT')).toBe(0);
    expect(mgr.subscribedSymbols()).toEqual([]);
  });

  it('a second profile trading the same symbol on a different interval opens that interval and keeps it until its own remover', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT'], '5m');
    await mgr.addSymbols(['BTCUSDT'], '1h');
    // Both trading intervals are live; 1m + 1d are shared (refcounted, not doubled).
    expect(port.subscriberCount('BTCUSDT', '5m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);

    // The 5m profile leaves: its trading interval closes, the 1h profile's stays,
    // and the shared 1m/1d/ticker live on under the remaining claim.
    await mgr.removeSymbols(['BTCUSDT'], '5m');
    expect(port.subscriberCount('BTCUSDT', '5m')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);

    // The 1h profile leaves: every stream closes and the symbol is dropped.
    await mgr.removeSymbols(['BTCUSDT'], '1h');
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(0);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(0);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    await mgr.stop();
  });

  it('triggerResyncForAllSubscribed calls onResync once per active symbol', async () => {
    const port = createFakeMarketDataPort();
    const mgr = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await mgr.addSymbols(['BTCUSDT', 'ETHUSDT'], '1h');
    const onResync = vi.fn<Parameters<typeof triggerResyncForAllSubscribed>[1]>(
      async () => undefined,
    );
    await triggerResyncForAllSubscribed(mgr, onResync);
    expect(onResync).toHaveBeenCalledTimes(2);
    const calls = onResync.mock.calls.map((c) => c[0]).sort();
    expect(calls).toEqual(['BTCUSDT', 'ETHUSDT']);
    await mgr.stop();
  });
});
