// The generic strategy preview panel renders any strategy's PreviewModel with
// no strategy-specific code: a momentum model (entry qty + a skip reason), a
// rebalance model (allocation table, no price rows, no chart lines), and a TT
// model (grid + sell rows). Also pins the PreviewTone -> semantic token map.
// The panel is a pure renderer, so a hand-built model exercises every cell.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PreviewModel } from '@app/strategy-core';

import { PreviewModelView } from '../src/features/symbol/preview/strategy-preview-panel.js';
import { deriveChartLines } from '../src/features/symbol/preview/preview-chart-lines.js';
import { PREVIEW_TONE_TOKEN } from '../src/features/symbol/preview/tone.js';

const momentumModel: PreviewModel = {
  sections: [
    {
      title: 'Entry',
      rows: [
        { code: 'entry', tone: 'entry', price: '100', quantity: '2.5', chartLine: true },
        { code: 'trail', tone: 'trail', price: '95', chartLine: true },
      ],
    },
    {
      title: 'Exit & guards',
      rows: [
        // Unfundable: the worker skip reason surfaces instead of a size.
        {
          code: 'protective-stop',
          tone: 'stop',
          price: '90',
          skip: 'min-notional',
          chartLine: true,
        },
        { code: 'trend', tone: 'neutral', price: '88' },
      ],
    },
  ],
};

const rebalanceModel: PreviewModel = {
  sections: [
    {
      title: 'Fixed-weight basket',
      rows: [
        { code: 'target', tone: 'neutral', symbol: 'BTCUSDT', weight: '0.6', drift: '0.05' },
        { code: 'target', tone: 'neutral', symbol: 'ETHUSDT', weight: '0.4', drift: '0.05' },
      ],
    },
  ],
};

const ttModel: PreviewModel = {
  sections: [
    {
      title: 'Grid ladder',
      rows: [
        { code: 'grid-buy', tone: 'buy', price: '100', quantity: '1', chartLine: true },
        { code: 'avg-cost', tone: 'neutral', price: '100' },
      ],
    },
    {
      title: 'Sell targets',
      rows: [
        { code: 'technicals-force-sell', tone: 'sell', price: '110', chartLine: true },
        { code: 'grid-stop-loss', tone: 'stop', price: '80', trigger: true, chartLine: true },
        { code: 'grid-sell', tone: 'trail', price: '104', chartLine: true },
      ],
    },
  ],
};

describe('PreviewModelView — momentum', () => {
  it('shows the entry quantity and the worker skip reason', () => {
    render(<PreviewModelView model={momentumModel} currentPrice="100" />);
    expect(screen.getByTestId('strategy-preview-panel')).toBeInTheDocument();
    expect(screen.getByText('ENTRY')).toBeInTheDocument();
    // Entry quantity is rendered (formatAmount('2.5')).
    expect(screen.getByText('2.5')).toBeInTheDocument();
    // The unfundable protective stop surfaces its typed skip reason.
    expect(screen.getByTestId('preview-row-skip')).toHaveTextContent('min-notional');
  });
});

describe('PreviewModelView — rebalance', () => {
  it('renders an allocation table with symbols/weights and no price rows or chart lines', () => {
    render(<PreviewModelView model={rebalanceModel} currentPrice={null} />);
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getByText('ETHUSDT')).toBeInTheDocument();
    // Weight rendered as a percent.
    expect(screen.getByText('60.00%')).toBeInTheDocument();
    // A price-less basket contributes zero chart lines.
    expect(deriveChartLines(rebalanceModel)).toEqual([]);
  });
});

describe('PreviewModelView — trailing-trade', () => {
  it('renders grid + sell sections and a "now" marker on the armed stop-loss', () => {
    render(<PreviewModelView model={ttModel} currentPrice="100" />);
    expect(screen.getByText('Grid ladder')).toBeInTheDocument();
    expect(screen.getByText('Sell targets')).toBeInTheDocument();
    expect(screen.getByText('GRID BUY')).toBeInTheDocument();
    // The triggered stop-loss row carries a "now" marker.
    expect(screen.getByText('now')).toBeInTheDocument();
    // Four priced chart lines (grid buy, force-sell, stop, trail).
    expect(deriveChartLines(ttModel)).toHaveLength(4);
  });
});

const ttRegimeModel: PreviewModel = {
  sections: [
    {
      title: 'Regime',
      rows: [
        {
          code: 'regime-verdict',
          label: 'Daily regime',
          tone: 'neutral',
          note: 'Bull — last 3 daily closes above the 200-day sma',
        },
        {
          code: 'regime-bull-hold',
          label: 'Bull hold',
          tone: 'neutral',
          note: 'Active now — room: loose',
        },
        { code: 'regime-pyramid-add', label: 'Add #1', tone: 'buy', price: '64365' },
      ],
    },
  ],
};

describe('PreviewModelView — trailing-trade regime', () => {
  it('renders the regime verdict, bull-hold, and pyramid ladder generically', () => {
    render(<PreviewModelView model={ttRegimeModel} currentPrice="60000" />);
    expect(screen.getByText('Regime')).toBeInTheDocument();
    expect(screen.getByText('Daily regime')).toBeInTheDocument();
    expect(screen.getByText(/last 3 daily closes above/i)).toBeInTheDocument();
    expect(screen.getByText(/active now/i)).toBeInTheDocument();
    expect(screen.getByText('Add #1')).toBeInTheDocument();
    // Pyramid rungs are projections, not chart lines (no chartLine flag).
    expect(deriveChartLines(ttRegimeModel)).toEqual([]);
  });
});

describe('PreviewModelView — empty state', () => {
  it('shows the empty state when the model has no sections', () => {
    render(<PreviewModelView model={{ sections: [] }} currentPrice={null} />);
    expect(screen.getByTestId('strategy-preview-empty')).toBeInTheDocument();
  });
});

describe('PreviewModelView — failure surfaces', () => {
  it('surfaces a load/compute error instead of the (empty) model', () => {
    render(
      <PreviewModelView model={{ sections: [] }} currentPrice={null} error={new Error('x')} />,
    );
    expect(screen.getByTestId('strategy-preview-error')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load the preview.")).toBeInTheDocument();
    // The error wins over both the empty and loading placeholders.
    expect(screen.queryByTestId('strategy-preview-empty')).not.toBeInTheDocument();
  });

  it('shows the loading placeholder while an empty model is still resolving', () => {
    render(<PreviewModelView model={{ sections: [] }} currentPrice={null} isLoading />);
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    expect(screen.queryByTestId('strategy-preview-empty')).not.toBeInTheDocument();
  });
});

describe('PreviewTone -> token map', () => {
  it('maps every tone to its semantic text token', () => {
    expect(PREVIEW_TONE_TOKEN).toEqual({
      entry: 'text-accent',
      buy: 'text-up',
      sell: 'text-down',
      trail: 'text-warning',
      stop: 'text-danger',
      neutral: 'text-muted-fg',
    });
  });

  it('tones a rendered label with its token', () => {
    render(<PreviewModelView model={ttModel} currentPrice="100" />);
    // The buy grid label wears the up token.
    const gridBuy = screen.getByText('GRID BUY');
    expect(gridBuy).toHaveClass('text-up');
    const section = within(
      screen
        .getByText('Sell targets')
        .closest('[data-testid="strategy-preview-section"]') as HTMLElement,
    );
    expect(section.getByText('GRID SELL')).toHaveClass('text-warning');
  });
});
