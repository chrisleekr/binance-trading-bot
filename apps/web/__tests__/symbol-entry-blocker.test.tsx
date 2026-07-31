// SymbolEntryBlocker — renders one glossed "not buying" line, hides when null,
// and every reason code maps to a non-empty sentence.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { glossEntryBlocker } from '../src/shared/lib/gloss-entry-blocker.js';
import { SymbolEntryBlocker } from '../src/features/symbol/components/symbol-entry-blocker.js';

const ALL_REASONS = [
  'awaiting-trigger-price',
  'regime-downtrend',
  'regime-unavailable',
  'regime-exit-bear',
  'regime-not-uptrend',
  'technicals-no-signal',
  'technicals-stale',
  'technicals-sell',
  'technicals-disallowed',
  'indicator-rsi',
  'indicator-sma',
  'indicator-ema',
  'indicator-unavailable',
  'exposure-cap',
  'account-exposure-cap',
  'loss-budget',
  'force-sell-cooldown',
  'loss-cooldown',
  'technicals-confirming',
  'discovery-no-stop',
  'chase-guard',
  'knife-guard',
  'min-qty',
  'min-notional',
  'min-purchase',
  'invalid-filters',
] as const;

describe('SymbolEntryBlocker', () => {
  it('renders nothing when entryBlocker is null', () => {
    const { container } = render(<SymbolEntryBlocker entryBlocker={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the status line for a given entryBlocker', () => {
    render(
      <SymbolEntryBlocker
        entryBlocker={{
          reason: 'awaiting-trigger-price',
          detail: { windowLow: '95', currentPrice: '96' },
        }}
      />,
    );
    expect(screen.getByTestId('symbol-entry-blocker')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the price to dip/)).toBeInTheDocument();
    // The detail numbers are folded into the sentence.
    expect(screen.getByText(/95/)).toBeInTheDocument();
    expect(screen.getByText(/96/)).toBeInTheDocument();
  });

  it('require-uptrend distinguishes too-little-history from a flat/falling trend', () => {
    const { rerender } = render(
      <SymbolEntryBlocker
        entryBlocker={{ reason: 'regime-not-uptrend', detail: { have: 12, need: 200 } }}
      />,
    );
    expect(screen.getByText(/not enough daily history/)).toBeInTheDocument();
    expect(screen.getByText(/12 of 200/)).toBeInTheDocument();

    rerender(<SymbolEntryBlocker entryBlocker={{ reason: 'regime-not-uptrend' }} />);
    expect(screen.getByText(/flat or falling/)).toBeInTheDocument();
  });
});

describe('glossEntryBlocker', () => {
  it('maps every known reason to a non-empty sentence', () => {
    for (const reason of ALL_REASONS) {
      const sentence = glossEntryBlocker({ reason });
      expect(sentence.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a generic sentence for an unknown reason', () => {
    expect(glossEntryBlocker({ reason: 'some-future-strategy-code' }).length).toBeGreaterThan(0);
  });

  it('renders the minutes remaining for loss-cooldown', () => {
    const sentence = glossEntryBlocker({ reason: 'loss-cooldown', detail: { minutesLeft: 30 } });
    expect(sentence).toMatch(/took a loss/);
    expect(sentence).toMatch(/30/);
  });

  it('explains technicals-disallowed as a bullish-but-unchecked level, not a sell', () => {
    const sentence = glossEntryBlocker({
      reason: 'technicals-disallowed',
      detail: { recommendation: 'STRONG_BUY', interval: '15m' },
    });
    expect(sentence).toMatch(/Strong Buy/);
    expect(sentence).toMatch(/15m/);
    expect(sentence).not.toMatch(/Sell/);
  });

  it('renders the confirm progress for technicals-confirming', () => {
    const sentence = glossEntryBlocker({
      reason: 'technicals-confirming',
      detail: { reads: 1, required: 3 },
    });
    expect(sentence).toMatch(/1 of 3/);
  });

  it('folds the high/price/distance into the chase-guard sentence', () => {
    const sentence = glossEntryBlocker({
      reason: 'chase-guard',
      detail: { high24h: '100', currentPrice: '98', distancePct: '3' },
    });
    expect(sentence).toMatch(/24h high/);
    expect(sentence).toMatch(/100/);
    expect(sentence).toMatch(/98/);
    expect(sentence).toMatch(/3%/);
  });

  it('folds the drop/candles into the knife-guard sentence', () => {
    const sentence = glossEntryBlocker({
      reason: 'knife-guard',
      detail: { dropPct: '6', candles: 3 },
    });
    expect(sentence).toMatch(/falling knife/);
    expect(sentence).toMatch(/6/);
    expect(sentence).toMatch(/3 candles/);
  });
});
