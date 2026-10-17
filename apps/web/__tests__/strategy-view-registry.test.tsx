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
import type { PreviewModel } from '@app/strategy-core';

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

  // The panel must say what the bot is waiting for, from the strategy's own preview rows and nothing strategy-specific.
  const model: PreviewModel = {
    sections: [
      {
        title: 'Entry',
        rows: [
          {
            code: 'entry',
            label: 'Breakout level',
            tone: 'entry',
            price: '114',
            chartLine: true,
            skip: 'min-qty',
          },
          {
            code: 'trail',
            label: 'Trailing stop',
            tone: 'trail',
            price: '95',
            triggerWhen: 'below',
          },
        ],
      },
      {
        title: 'Exit & guards',
        rows: [
          {
            code: 'protective-stop',
            label: 'Protective stop',
            tone: 'stop',
            price: '99',
            triggerWhen: 'below',
          },
        ],
      },
    ],
  };
  const withInterval = (lbp: string | null): SymbolStateResponse =>
    ({
      ...stateFor('momentum', lbp),
      strategy: { name: 'momentum', config: { candleInterval: '1h' }, state: {} },
    }) as unknown as SymbolStateResponse;

  it('generic SignalPanel says, while flat, where it buys and where a stop would start', () => {
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="SOLUSDT"
        state={withInterval(null)}
        currentPrice="100"
        previewModel={model}
      />,
    );
    const flat = screen.getByTestId('symbol-signal-generic-flat');
    expect(flat).toHaveTextContent('Next buy level: 114.00 (14.00% above now). (Breakout level)');
    expect(flat).toHaveTextContent('If it buys, the trailing stop would start near 95.00.');
    expect(flat).toHaveTextContent('It checks once each hourly candle closes.');
    // The preview here is built without the wallet, so a sizing skip is an artefact of that, not a reason it is not buying.
    expect(flat).not.toHaveTextContent('min-qty');
  });

  it('generic SignalPanel says, while held, where it sells, first-firing stop first', () => {
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="SOLUSDT"
        state={withInterval('98')}
        currentPrice="100"
        previewModel={model}
      />,
    );
    const held = screen.getByTestId('symbol-signal-generic-holding');
    expect(held).toHaveTextContent('Holding since entry 98.00.');
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      'Sells if price falls to 99.00 (1.00% below now). (Protective stop)',
      'Sells if price falls to 95.00 (5.00% below now). (Trailing stop)',
    ]);
  });

  it('generic SignalPanel words a rise-triggered exit and lists a note-only row last while held', () => {
    // A priceless row has no level to sort by, so it sinks below every priced one; an `above` trigger reads "rises", not the default "falls".
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="SOLUSDT"
        state={withInterval('98')}
        currentPrice="100"
        previewModel={{
          sections: [
            {
              title: 'Exit',
              rows: [
                {
                  code: 'protective-stop',
                  label: 'Protective stop (exchange trail)',
                  tone: 'stop',
                  note: 'Trails 3%.',
                },
                {
                  code: 'stop',
                  label: 'Hard stop',
                  tone: 'stop',
                  price: '99',
                  triggerWhen: 'below',
                },
                {
                  code: 'take-profit',
                  label: 'Take profit',
                  tone: 'sell',
                  price: '110',
                  triggerWhen: 'above',
                },
              ],
            },
          ],
        }}
      />,
    );
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      'Sells if price rises to 110.00 (10.00% above now). (Take profit)',
      'Sells if price falls to 99.00 (1.00% below now). (Hard stop)',
      'Protective stop (exchange trail): Trails 3%.',
    ]);
  });

  it('generic SignalPanel says an exit is due once price is past its level, not that it waits for it', () => {
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="SOLUSDT"
        state={withInterval('98')}
        currentPrice="97"
        previewModel={model}
      />,
    );
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      'Price is already past 99.00; this exit is due on the next check. (Protective stop)',
      'Sells if price falls to 95.00 (2.06% below now). (Trailing stop)',
    ]);
  });

  it('generic SignalPanel says an exchange stop-limit past its trigger has fired, not that it is due', () => {
    // A row with a limit price is a stop-limit resting on Binance: past the trigger it has already fired, and its limit may not fill.
    const stopLimit: PreviewModel = {
      sections: [
        {
          title: 'Exit & guards',
          rows: [
            {
              code: 'protective-stop',
              label: 'Protective stop',
              tone: 'stop',
              price: '99',
              limitPrice: '98.5',
              triggerWhen: 'below',
            },
          ],
        },
      ],
    };
    const view = getStrategyView('unknown');
    render(
      <view.SignalPanel
        profileId="p1"
        symbol="SOLUSDT"
        state={withInterval('98')}
        currentPrice="97"
        previewModel={stopLimit}
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Price is already past 99.00. If the exchange stop is resting it has fired, and its sell near 98.50 may not fill if price keeps falling; if not, the bot sells on its next check. (Protective stop)',
    ]);
  });
});
