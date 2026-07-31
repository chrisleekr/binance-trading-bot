import { describe, expect, it } from 'vitest';
import type { DlqJobData } from '../../src/queues/job-payloads.js';
import {
  createDlqNotifyAggregator,
  dlqErrorClassKey,
  type DlqGroup,
} from '../../src/queues/dlq-notify-aggregator.js';

// A Drizzle query failure: identical SQL, but the `\nparams:` tail carries the
// per-symbol id + symbol — the exact thing that fragmented the old dedup key.
const queryErr = (symbol: string): DlqJobData => ({
  fromQueue: 'tick',
  fromJobId: `tick:bbfd71de-c4b2-4a43-86c8-739850e3a8ca:${symbol}`,
  reason: 'failed',
  errorName: 'Error',
  errorMessage:
    'Failed query: select "profile_id", "symbol", "state" from "symbol_states" where ' +
    `("symbol_states"."profile_id" = $1 and "symbol_states"."symbol" = $2) limit $3\nparams: bbfd71de-c4b2-4a43-86c8-739850e3a8ca,${symbol},1`,
  originalData: {},
});

const redisErr = (symbol: string): DlqJobData => ({
  fromQueue: 'tick',
  fromJobId: `tick:bbfd71de-c4b2-4a43-86c8-739850e3a8ca:${symbol}`,
  reason: 'failed',
  errorName: 'RedisUnavailableError',
  errorMessage: 'WeightGovernor: Redis unavailable — bulk read skipped',
  originalData: {},
});

describe('dlqErrorClassKey', () => {
  it('maps the same query failure across every symbol to ONE key', () => {
    expect(dlqErrorClassKey(queryErr('WIFUSDT'))).toBe(dlqErrorClassKey(queryErr('EDENUSDT')));
    expect(dlqErrorClassKey(queryErr('SAGAUSDT'))).toBe(dlqErrorClassKey(queryErr('WIFUSDT')));
  });

  it('separates distinct error classes and queues', () => {
    expect(dlqErrorClassKey(queryErr('WIFUSDT'))).not.toBe(dlqErrorClassKey(redisErr('WIFUSDT')));
    expect(dlqErrorClassKey({ ...queryErr('WIFUSDT'), fromQueue: 'pipeline' })).not.toBe(
      dlqErrorClassKey(queryErr('WIFUSDT')),
    );
  });

  it('is bounded in length even for a huge error body', () => {
    const huge = { ...queryErr('WIFUSDT'), errorMessage: 'x'.repeat(5000) };
    expect(dlqErrorClassKey(huge).length).toBeLessThan(260);
  });
});

// Timing-aware fake scheduler: a timer fires only once the clock has advanced
// past its scheduled instant, so debounce (short) vs catch-up (remaining
// cooldown) delays are exercised distinctly rather than all firing at once.
const setup = () => {
  let now = 0;
  const timers: { at: number; fn: () => void; cleared: boolean; fired: boolean }[] = [];
  const emitted: DlqGroup[] = [];
  const agg = createDlqNotifyAggregator({
    debounceMs: 15_000,
    cooldownMs: 900_000,
    nowMs: () => now,
    setTimer: (fn, ms) => {
      const h = { at: now + ms, fn, cleared: false, fired: false };
      timers.push(h);
      return { clear: () => (h.cleared = true) };
    },
    emit: (g) => emitted.push(g),
  });
  const fireDue = () => {
    for (const t of timers) {
      if (!t.cleared && !t.fired && now >= t.at) {
        t.fired = true;
        t.fn();
      }
    }
  };
  return { agg, emitted, fireDue, advance: (ms: number) => (now += ms) };
};

describe('createDlqNotifyAggregator', () => {
  it('folds a burst of same-class failures into ONE alert carrying the count', () => {
    const { agg, emitted, fireDue, advance } = setup();
    for (const s of ['WIFUSDT', 'EDENUSDT', 'SAGAUSDT', 'THEUSDT', 'BELUSDT'])
      agg.record(queryErr(s));
    fireDue();
    expect(emitted).toHaveLength(0); // still inside the debounce window — nothing sent
    advance(15_000);
    fireDue();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.count).toBe(5);
    expect(emitted[0]?.sample.fromQueue).toBe('tick');
  });

  it('emits one alert per distinct class', () => {
    const { agg, emitted, fireDue, advance } = setup();
    agg.record(queryErr('WIFUSDT'));
    agg.record(redisErr('WIFUSDT'));
    agg.record(queryErr('EDENUSDT'));
    advance(15_000);
    fireDue();
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.count).sort()).toEqual([1, 2]); // redis:1, query:2
  });

  it('a burst that lands entirely during cooldown still drains at cooldown expiry (no silent miss)', () => {
    const { agg, emitted, fireDue, advance } = setup();
    agg.record(queryErr('A'));
    advance(15_000);
    fireDue();
    expect(emitted).toHaveLength(1); // first alert, enters cooldown

    // A second incident of the same class, entirely within the cooldown, then stops.
    agg.record(queryErr('B'));
    agg.record(queryErr('C'));
    fireDue(); // still inside cooldown — catch-up timer not yet due
    expect(emitted).toHaveLength(1);

    // At cooldown expiry the catch-up timer flushes the accumulated count — even
    // though no NEW failure arrived to re-arm it.
    advance(900_000);
    fireDue();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.count).toBe(2); // B + C surfaced, not stranded
  });

  it('re-alerts each cooldown for a persistent outage', () => {
    const { agg, emitted, fireDue, advance } = setup();
    agg.record(queryErr('A'));
    advance(15_000);
    fireDue();
    expect(emitted).toHaveLength(1);
    // Keep failing across the cooldown boundary.
    agg.record(queryErr('B'));
    advance(900_000);
    fireDue();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.count).toBe(1);
  });

  it('stop() cancels a pending flush so no alert fires', () => {
    const { agg, emitted, fireDue, advance } = setup();
    agg.record(queryErr('A'));
    agg.stop();
    advance(15_000);
    fireDue();
    expect(emitted).toHaveLength(0);
  });
});
