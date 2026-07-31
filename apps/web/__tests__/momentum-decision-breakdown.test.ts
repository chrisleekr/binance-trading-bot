import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';

import { summarizeDecisionBreakdown } from '@/features/backtest/lib/decision-breakdown';

// The web funnel glosses a blocker off the active strategy's descriptor map, not a
// hardcoded web copy (invariant #1). Momentum's map is reached through the same
// registry the backend registers, so this proves the web reads momentum's own
// reason gloss + kind rather than falling back to the raw code.
describe('momentum decision-breakdown gloss', () => {
  const attr = buildStrategyRegistry().get('momentum')?.reasonAttribution;

  it("glosses momentum's below-trend blocker to a non-raw market read", () => {
    const s = summarizeDecisionBreakdown(
      { metrics: [{ name: 'below-trend', tags: { symbol: 'BTCUSDT' }, count: 12 }], logs: [] },
      attr ?? {},
    );
    const blocker = s?.blockers.find((b) => b.code === 'below-trend');
    expect(blocker?.label).toBeDefined();
    // Glossed off momentum's map, not the raw code.
    expect(blocker?.label).not.toBe('below-trend');
    // A market read the operator must not relax — the tint the web shows.
    expect(blocker?.kind).toBe('market');
  });
});
