// StrategyView registry — resolution by name + the generic fallback render.
// Guards the S4 invariant: an unknown strategy never crashes and never shows
// grid-shaped UI; it gets the generic position/entry readout. Chart lines and
// the config preview are now generic (from each strategy's PreviewModel), so
// the completeness guard keys on the web preview map, not a GENERIC_ONLY list.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';

import { getStrategyView } from '../src/features/symbol/strategies/registry.js';
import { hasPreviewModule } from '../src/features/symbol/preview/preview-modules.js';

import type { SymbolStateResponse } from '@app/contracts';

const stateFor = (name: string, lbp: string | null): SymbolStateResponse =>
  ({
    strategy: { name, config: {}, state: {} },
    avgEntryPrice:
      lbp === null
        ? null
        : { avgEntryPrice: lbp, quantity: '1', updatedAt: '2026-05-31T00:00:00Z' },
    openOrders: [],
    disable: null,
  }) as unknown as SymbolStateResponse;

describe('getStrategyView', () => {
  it('resolves trailing-trade to its own view (grid SignalPanel + SidePanel)', () => {
    const view = getStrategyView('trailing-trade');
    expect(view.strategyName).toBe('trailing-trade');
    expect(view.SignalPanel).toBeDefined();
    expect(view.SidePanel).toBeDefined();
  });

  it('falls back to the generic view for an unknown strategy', () => {
    const view = getStrategyView('no-such-strategy');
    expect(view.strategyName).toBe('__generic__');
    expect(view.SidePanel).toBeUndefined();
  });

  it('every backend-registered strategy has a web preview module', () => {
    // The completeness guard: every strategy the backend registers must have a
    // lazy preview module in the web map, so its pre-trade projection renders on
    // the config / backtest pages. A future plugin added without one fails here
    // (and in scripts/ci/no-missing-preview-export.sh) instead of silently
    // showing an empty preview.
    const registered = buildStrategyRegistry()
      .list()
      .map((s) => s.name);
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) {
      expect(
        hasPreviewModule(name),
        `strategy "${name}" has no web preview module — add it to preview-modules.ts`,
      ).toBe(true);
    }
  });

  it('generic SignalPanel renders a holding position without grid concepts', () => {
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="BTCUSDT"
        state={stateFor('unknown', '100')}
        currentPrice="105"
      />,
    );
    expect(screen.getByTestId('symbol-signal-generic-holding')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-ladder-panel')).not.toBeInTheDocument();
  });

  it('generic SignalPanel renders a flat position', () => {
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="BTCUSDT"
        state={stateFor('unknown', null)}
        currentPrice={null}
      />,
    );
    expect(screen.getByTestId('symbol-signal-generic-flat')).toBeInTheDocument();
  });
});
