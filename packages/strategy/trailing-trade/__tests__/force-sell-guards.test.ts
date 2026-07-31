// Pure helper resolving the two force-sell guard defaults (issue #464).
//
// resolveForceSellGuards(technicals) derives non-zero confirm/cooldown
// defaults ONLY when a sub-1h force-sell trigger interval is enabled:
//   - confirmMinutes defaults to the SHORTEST enabled sub-1h force-sell
//     interval's period in minutes when forceSellConfirmMinutes is undefined.
//   - cooldownMinutes defaults to 60 when forceSellReentryCooldownMinutes is
//     undefined and any sub-1h force-sell trigger is enabled.
//   - An explicit number (including 0) is always preserved.
//   - With no sub-1h force-sell trigger enabled, an undefined field resolves
//     to 0 (behaviour unchanged).

import { describe, expect, it } from 'vitest';
import { resolveForceSellGuards } from '../src/force-sell-guards.js';

// Minimal interval row shape the helper reads. Buy-side toggles are irrelevant
// to force-sell guard resolution but kept so the literal matches the config
// interval shape.
const row = (o: {
  interval: string;
  whenSell?: boolean;
  whenStrongSell?: boolean;
  whenNeutral?: boolean;
}) => ({
  interval: o.interval,
  whenStrongBuy: false,
  whenBuy: false,
  whenSell: o.whenSell ?? false,
  whenStrongSell: o.whenStrongSell ?? false,
  whenNeutral: o.whenNeutral ?? false,
});

// Minimal technicals config literal the helper reads.
const tech = (o: {
  intervals: ReturnType<typeof row>[];
  forceSellConfirmMinutes?: number;
  forceSellReentryCooldownMinutes?: number;
}) => ({
  useOnlyWithinMin: 2,
  ifExpires: 'do-not-buy' as const,
  intervals: o.intervals,
  ...(o.forceSellConfirmMinutes !== undefined
    ? { forceSellConfirmMinutes: o.forceSellConfirmMinutes }
    : {}),
  ...(o.forceSellReentryCooldownMinutes !== undefined
    ? { forceSellReentryCooldownMinutes: o.forceSellReentryCooldownMinutes }
    : {}),
});

describe('@app/strategy-trailing-trade resolveForceSellGuards', () => {
  it('defaults confirm to the shortest enabled sub-1h force-sell interval (15m+30m -> 15)', () => {
    const out = resolveForceSellGuards(
      tech({
        intervals: [
          row({ interval: '15m', whenStrongSell: true }),
          row({ interval: '30m', whenStrongSell: true }),
        ],
      }),
    );
    expect(out.confirmMinutes).toBe(15);
  });

  it('defaults confirm to the shortest enabled sub-1h force-sell interval (5m+15m -> 5)', () => {
    const out = resolveForceSellGuards(
      tech({
        intervals: [
          row({ interval: '15m', whenStrongSell: true }),
          row({ interval: '5m', whenStrongSell: true }),
        ],
      }),
    );
    expect(out.confirmMinutes).toBe(5);
  });

  it('defaults cooldown to 60 when a sub-1h force-sell trigger is enabled and cooldown is undefined', () => {
    const out = resolveForceSellGuards(
      tech({ intervals: [row({ interval: '5m', whenStrongSell: true })] }),
    );
    expect(out.cooldownMinutes).toBe(60);
  });

  it('preserves an explicit forceSellConfirmMinutes of 0', () => {
    const out = resolveForceSellGuards(
      tech({
        intervals: [row({ interval: '5m', whenStrongSell: true })],
        forceSellConfirmMinutes: 0,
      }),
    );
    expect(out.confirmMinutes).toBe(0);
  });

  it('preserves an explicit forceSellReentryCooldownMinutes of 0', () => {
    const out = resolveForceSellGuards(
      tech({
        intervals: [row({ interval: '5m', whenStrongSell: true })],
        forceSellReentryCooldownMinutes: 0,
      }),
    );
    expect(out.cooldownMinutes).toBe(0);
  });

  it('resolves both undefined fields to 0 when only a 1h interval has a force-sell trigger', () => {
    const out = resolveForceSellGuards(
      tech({ intervals: [row({ interval: '1h', whenStrongSell: true })] }),
    );
    expect(out.confirmMinutes).toBe(0);
    expect(out.cooldownMinutes).toBe(0);
  });

  it('resolves both undefined fields to 0 when all sell toggles are off', () => {
    const out = resolveForceSellGuards(tech({ intervals: [row({ interval: '5m' })] }));
    expect(out.confirmMinutes).toBe(0);
    expect(out.cooldownMinutes).toBe(0);
  });

  it('treats a sell-toggled row with no interval as contributing nothing', () => {
    // A loose form-value row (web nudge) can have a sell toggle on with the
    // interval unselected. It passes the sell-trigger filter but misses the
    // sub-1h minute map, so it must not arm a confirm window or cooldown.
    const out = resolveForceSellGuards({
      intervals: [{ interval: undefined, whenSell: true }],
    });
    expect(out.confirmMinutes).toBe(0);
    expect(out.cooldownMinutes).toBe(0);
  });
});
