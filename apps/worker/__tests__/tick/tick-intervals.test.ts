import { describe, it, expect } from 'vitest';
import { tickIntervals } from '../../src/tick/tick-event.js';
import { feedIntervals } from '../../src/market-data/feed-intervals.js';

describe('tickIntervals', () => {
  it('is the feedIntervals helper — the per-tick load set cannot drift from the subscription set', () => {
    // The subscriptions-manager subscribes feedIntervals(candleInterval); the
    // tick loads tickIntervals(candleInterval). Sharing one reference is the
    // contract that keeps every loaded interval one the worker subscribes.
    expect(tickIntervals).toBe(feedIntervals);
  });

  it('loads the trading interval, the 1m freshness stream, then the daily for a sub-daily interval', () => {
    expect(tickIntervals('1h')).toEqual(['1h', '1m', '1d']);
    expect(tickIntervals('5m')).toEqual(['5m', '1m', '1d']);
    expect(tickIntervals('4h')).toEqual(['4h', '1m', '1d']);
  });

  it('does not duplicate 1m when the trading interval already is 1m', () => {
    expect(tickIntervals('1m')).toEqual(['1m', '1d']);
  });

  it('still adds the 1m freshness stream when trading on the daily interval', () => {
    expect(tickIntervals('1d')).toEqual(['1d', '1m']);
  });
});
