import { describe, expect, it } from 'vitest';
import { QUEUE_SPECS } from '../../src/queues/queue-names.js';

// The technicals-compute cron tick can legitimately exceed BullMQ's
// default 30 s lockDuration when Binance's kline path hits the retry
// branch (10 s timeout + 1 retry per symbol × 5 intervals). Without an
// override the worker fires false stalls, the scheduler enqueues a
// duplicate, and `active` piles up. Pin the override so future edits
// can't silently drop it.
describe('QUEUE_SPECS lockDurationMs overrides', () => {
  it('technicals-compute outruns the kline retry path', () => {
    expect(QUEUE_SPECS['technicals-compute'].lockDurationMs).toBeGreaterThanOrEqual(60_000);
  });

  // Same fan-out shape as technicals-compute (per-symbol Binance kline
  // fetch with timeout + concurrency); the default 30 s lock false-stalls
  // past ~8 symbols at scale. Symmetric handler → symmetric override.
  it('daily-ath outruns the per-symbol fan-out', () => {
    expect(QUEUE_SPECS['daily-ath'].lockDurationMs).toBeGreaterThanOrEqual(60_000);
  });
});
