// Hot candle-interval change, end-to-end across the REAL subscriptions-manager.
//
// ProfileManager.setSymbols(profileId, symbols, newInterval) must add the new
// interval's WS streams and drop the old for the retained symbols, with the
// shared freshness streams (1m/1d) and ticker staying refcount-balanced across
// the swap (never flickering to zero and back, never leaking). This wires the
// manager's market hook to the actual createMarketSubscriptionsManager over a
// fake MarketDataPort and asserts the port-level subscriber counts.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createFakeMarketDataPort } from '@app/binance';
import { asProfileId, asUserId } from '@app/contracts';

import { createProfileManager } from '../../src/profile-manager/profile-manager.js';
import { createMarketSubscriptionsManager } from '../../src/market-data/subscriptions-manager.js';

const silentLogger = pino({ level: 'silent' });
const u = asUserId;
const p = asProfileId;

describe('ProfileManager interval change over the real subscriptions-manager', () => {
  it('swaps the trading interval while keeping 1m/1d/ticker refcount-balanced', async () => {
    const port = createFakeMarketDataPort();
    const subscribeSpy = vi.spyOn(port, 'subscribeKlines');
    const manager = createMarketSubscriptionsManager({
      port,
      onMarketEvent: async () => undefined,
      onResync: async () => undefined,
      logger: silentLogger,
    });
    await manager.start();

    const pm = createProfileManager({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '5m',
          technicalsIntervals: [],
        },
      ],
    });
    pm.setMarket({
      addSymbols: (symbols, interval) => manager.addSymbols(symbols, interval),
      removeSymbols: (symbols, interval) => manager.removeSymbols(symbols, interval),
    });

    await pm.start();
    expect(port.subscriberCount('BTCUSDT', '5m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);

    await pm.setSymbols(p('p1'), ['BTCUSDT'], '1h');
    // New trading interval is live; the old one is fully released.
    expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '5m')).toBe(0);
    // The shared freshness streams + ticker survive the swap (add-before-remove
    // ordering keeps their refcount from dipping to zero), with no leak.
    expect(port.subscriberCount('BTCUSDT', '1m')).toBe(1);
    expect(port.subscriberCount('BTCUSDT', '1d')).toBe(1);
    expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);

    // Ordering proof (not just final counts): the shared 1m stream is opened
    // exactly once, at enable, and never torn down + recreated across the swap.
    // A reversed remove-then-add order would drop 1m to refCount 0 and
    // re-subscribe it, producing a second subscribeKlines('BTCUSDT','1m') call.
    const oneMinSubscribes = subscribeSpy.mock.calls.filter(
      ([sym, iv]) => sym === 'BTCUSDT' && iv === '1m',
    ).length;
    expect(oneMinSubscribes).toBe(1);

    await manager.stop();
  });
});
