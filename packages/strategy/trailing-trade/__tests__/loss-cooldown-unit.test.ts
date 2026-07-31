// Unit coverage for the loss-cooldown helpers (issue #472). The tick-level
// behaviour is covered in loss-cooldown.test.ts; this pins the pure helpers'
// edge cases (null stamp, lapsed window, minutes rounding, log/metric shape).

import { describe, expect, it } from 'vitest';
import {
  lossCooldownBlock,
  lossCooldownMinutesLeft,
  lossExitCooldownActive,
} from '../src/loss-cooldown.js';
import { trailingTrade, TTConfigSchema, type TTConfig, type TTState } from '../src/index.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const cfg = (lossCooldownMinutes: number): TTConfig => {
  const base = TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });
  return { ...base, buy: { ...base.buy, lossCooldownMinutes } };
};

const stamped = (lastLossExitAt: number | null, reason: string | null): TTState => ({
  ...trailingTrade.initialState(cfg(60)),
  lastLossExitAt,
  lastLossExitReason: reason,
});

describe('lossExitCooldownActive', () => {
  it('is false when no loss exit is stamped', () => {
    expect(lossExitCooldownActive(stamped(null, null), cfg(60), NOW)).toBe(false);
  });

  it('is true inside the window and false after it', () => {
    const s = stamped(NOW - 30 * MIN, 'grid-stop-loss');
    expect(lossExitCooldownActive(s, cfg(60), NOW)).toBe(true);
    expect(lossExitCooldownActive(s, cfg(60), NOW + 31 * MIN)).toBe(false);
  });

  it('is false when the cooldown is 0', () => {
    expect(lossExitCooldownActive(stamped(NOW, 'grid-stop-loss'), cfg(0), NOW)).toBe(false);
  });
});

describe('lossCooldownMinutesLeft', () => {
  it('returns 0 when no stamp is present', () => {
    expect(lossCooldownMinutesLeft(stamped(null, null), cfg(60), NOW)).toBe(0);
  });

  it('returns 0 once the window has lapsed', () => {
    expect(lossCooldownMinutesLeft(stamped(NOW - 61 * MIN, 'regime-exit'), cfg(60), NOW)).toBe(0);
  });

  it('rounds a partial minute up', () => {
    // 29 minutes and 30 seconds remaining ⇒ 30 (ceil).
    const s = stamped(NOW - 30 * MIN - 30_000, 'grid-stop-loss');
    expect(lossCooldownMinutesLeft(s, cfg(60), NOW)).toBe(30);
  });
});

describe('lossCooldownBlock', () => {
  it('produces the paired log + metric', () => {
    const s = stamped(NOW, 'grid-stop-loss');
    const { log, metric } = lossCooldownBlock('BTCUSDT', s);
    expect(log.message).toBe('tt-loss-cooldown-blocked');
    expect(log.context).toMatchObject({ symbol: 'BTCUSDT', lastLossExitReason: 'grid-stop-loss' });
    expect(metric.name).toBe('tt_loss_cooldown_blocked');
    expect(metric.tags).toMatchObject({ symbol: 'BTCUSDT' });
  });
});
