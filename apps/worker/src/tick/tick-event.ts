// Tick trigger + interval mapping.
//
// Turns a raw `TickJobData` event into the strategy's `TriggerEvent` and the
// per-tick candle-load set, and extracts the live last-trade price a mini-ticker
// carries. Pure helpers, exported so each guard is unit-testable without the
// full handler.

import { isCandleInterval } from '@app/strategy-core';
import type { TriggerEvent } from '@app/strategy-core';
import { Decimal } from '@app/money';
import type { TickJobData } from 'queues/job-payloads.js';
import { feedIntervals } from 'market-data/feed-intervals.js';

/**
 * The per-tick candle-load set: the interval windows a tick reads. Identical to
 * the subscription set ({@link feedIntervals}) so every loaded interval is one
 * the worker already subscribes — an unsubscribed interval would trigger a
 * per-tick cold-load REST fallback. Sharing one helper keeps the two sets from
 * drifting.
 */
export const tickIntervals: (candleInterval: string) => readonly string[] = feedIntervals;

/**
 * The live last-trade price that fired this tick, for the worker to override
 * `currentPrice` so stops/exits react to the price that just traded (~1s)
 * instead of the freshest closed candle (≤60s stale). Only a mini-ticker job
 * carries one — its payload `closePrice` is the frame that triggered the tick;
 * every other trigger returns undefined → closed-candle fallback. A malformed
 * or non-positive value is dropped so the strategy never evaluates garbage.
 * Exported for unit testing the guard without the full handler.
 */
export const extractLivePrice = (data: TickJobData): string | undefined => {
  if (data.event !== 'mini-ticker') return undefined;
  const raw = data.payload['closePrice'];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const d = new Decimal(raw);
    // `Decimal('Infinity')` parses and is `.gt(0)`; require finite so a stop
    // never evaluates an infinite price. Binance only sends finite values, so
    // this is defensive.
    return d.isFinite() && d.gt(0) ? raw : undefined;
  } catch {
    return undefined;
  }
};

export const mapEventToTrigger = (data: TickJobData): TriggerEvent => {
  switch (data.event) {
    case 'kline-close': {
      // Default only on absence; a present-but-out-of-range interval must fail
      // loud (matching asBinanceMode) rather than cast silently into the union
      // and feed an empty candle window downstream.
      const raw = String(data.payload['interval'] ?? '1h');
      if (!isCandleInterval(raw)) {
        throw new Error(`tick: kline-close interval out of range: ${JSON.stringify(raw)}`);
      }
      const candle = data.payload['candle'] as { openTimeMs?: number } | undefined;
      return { kind: 'candle-close', interval: raw, openTimeMs: candle?.openTimeMs ?? 0 };
    }
    case 'execution-report':
      return { kind: 'order-update', orderId: Number(data.payload['orderId'] ?? 0) };
    case 'balance-update':
      return { kind: 'tick' };
    case 'resync':
      return { kind: 'tick' };
    case 'mini-ticker':
    default:
      return { kind: 'tick' };
  }
};
