import { describe, expect, it } from 'vitest';
import { extractLivePrice, mapEventToTrigger } from '../../src/tick/tick-event.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const data = (event: TickJobData['event'], payload: Record<string, unknown> = {}): TickJobData => ({
  userId: 'u',
  profileId: 'p',
  symbol: 'BTCUSDT',
  event,
  enqueuedAtMs: 0,
  payload,
});

describe('mapEventToTrigger', () => {
  it('maps a valid kline-close interval through unchanged', () => {
    expect(
      mapEventToTrigger(data('kline-close', { interval: '1h', candle: { openTimeMs: 42 } })),
    ).toEqual({
      kind: 'candle-close',
      interval: '1h',
      openTimeMs: 42,
    });
  });

  it('defaults a missing interval to 1h and openTimeMs to 0', () => {
    expect(mapEventToTrigger(data('kline-close'))).toEqual({
      kind: 'candle-close',
      interval: '1h',
      openTimeMs: 0,
    });
  });

  it('throws loud on a present-but-out-of-range interval', () => {
    expect(() => mapEventToTrigger(data('kline-close', { interval: 'bogus' }))).toThrow(
      /out of range.*bogus/,
    );
  });

  it('maps non-kline events to their trigger kinds', () => {
    expect(mapEventToTrigger(data('execution-report', { orderId: 7 }))).toEqual({
      kind: 'order-update',
      orderId: 7,
    });
    expect(mapEventToTrigger(data('mini-ticker'))).toEqual({ kind: 'tick' });
    expect(mapEventToTrigger(data('balance-update'))).toEqual({ kind: 'tick' });
    expect(mapEventToTrigger(data('resync'))).toEqual({ kind: 'tick' });
  });
});

describe('extractLivePrice', () => {
  it('returns the mini-ticker closePrice', () => {
    expect(extractLivePrice(data('mini-ticker', { closePrice: '0.0868' }))).toBe('0.0868');
  });

  it('returns undefined for non-mini-ticker triggers (closed-candle fallback)', () => {
    expect(extractLivePrice(data('kline-close', { closePrice: '100' }))).toBeUndefined();
    expect(extractLivePrice(data('execution-report', { closePrice: '100' }))).toBeUndefined();
    expect(extractLivePrice(data('resync'))).toBeUndefined();
  });

  it('drops a missing, empty, non-string, non-positive, or malformed price', () => {
    expect(extractLivePrice(data('mini-ticker'))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: '' }))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: 100 }))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: '0' }))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: '-5' }))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: 'NaN' }))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: 'abc' }))).toBeUndefined();
    expect(extractLivePrice(data('mini-ticker', { closePrice: 'Infinity' }))).toBeUndefined();
  });
});
