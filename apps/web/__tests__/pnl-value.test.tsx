// PnlValue / PnlPercent / UnavailablePnl — the shared signed/coloured PnL readouts.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PnlPercent, PnlValue, UnavailablePnl } from '../src/shared/components/pnl-value.js';
import { unavailablePnlGlyph } from '../src/features/profile/lib/archive-view-model.js';

describe('PnlValue', () => {
  it('renders a positive value with a + sign and the success colour', () => {
    render(<PnlValue value="12.34" testId="pnl" />);
    const el = screen.getByTestId('pnl');
    expect(el).toHaveTextContent('+12.34');
    expect(el).toHaveClass('text-success');
  });

  it('renders a negative value with its - sign and the danger colour', () => {
    render(<PnlValue value="-5" testId="pnl" />);
    const el = screen.getByTestId('pnl');
    expect(el).toHaveTextContent('-5');
    expect(el).toHaveClass('text-danger');
  });

  it('renders zero unsigned and muted', () => {
    render(<PnlValue value="0" testId="pnl" />);
    const el = screen.getByTestId('pnl');
    expect(el).toHaveTextContent('0');
    expect(el).toHaveClass('text-muted-fg');
  });

  it('renders an em dash and the muted colour when the value is null', () => {
    render(<PnlValue value={null} testId="pnl" />);
    const el = screen.getByTestId('pnl');
    expect(el).toHaveTextContent('—');
    expect(el).toHaveClass('text-muted-fg');
  });

  it('merges a passed className alongside the base and tone classes', () => {
    render(<PnlValue value="1" className="ml-2" testId="pnl" />);
    expect(screen.getByTestId('pnl')).toHaveClass('ml-2', 'font-mono', 'text-success');
  });

  it('appends the quote unit after a real value', () => {
    render(<PnlValue value="12.34" unit="USDT" testId="pnl" />);
    const el = screen.getByTestId('pnl');
    expect(el).toHaveTextContent('+12.34');
    expect(el).toHaveTextContent('USDT');
  });

  it('suppresses the unit when the value is null so the em-dash stays unitless', () => {
    render(<PnlValue value={null} unit="USDT" testId="pnl" />);
    const el = screen.getByTestId('pnl');
    expect(el).toHaveTextContent('—');
    expect(el).not.toHaveTextContent('USDT');
  });
});

describe('PnlPercent', () => {
  // No `testId` prop: the archive cell that hosts this already carries the testid, so the span is reached through the render root instead.
  const renderPercent = (value: string): HTMLElement => {
    const { container } = render(<PnlPercent value={value} />);
    return container.firstElementChild as HTMLElement;
  };

  it('renders a positive ratio at 2dp with a + sign and the success colour', () => {
    const el = renderPercent('18.542027119459995');
    expect(el.textContent).toBe('+18.54%');
    expect(el).toHaveClass('text-success');
  });

  it('renders a negative ratio at 2dp with the danger colour', () => {
    const el = renderPercent('-0.52246604');
    expect(el.textContent).toBe('-0.52%');
    expect(el).toHaveClass('text-danger');
  });

  it('merges a passed className alongside the base and tone classes', () => {
    // The three call sites this replaces each carried their own spacing (`ml-1`) on the span. Without a className the migration either loses the spacing or wraps the component in an extra element, and a wrapper is what let the tone drift in the first place.
    const { container } = render(<PnlPercent value="1" className="ml-1" />);
    expect(container.firstElementChild).toHaveClass('ml-1', 'font-mono', 'text-success');
  });

  it('lets a caller class WIN a Tailwind conflict, not merely sit beside the base classes', () => {
    // `ml-1` conflicts with nothing, so an additive case passes just as well with the arguments in the wrong order. Tone is the property that actually depends on `className` being merged LAST: a caller that needs to override the sign colour gets the base tone instead, silently, and a red number renders green.
    const { container } = render(<PnlPercent value="1" className="text-danger" />);
    expect(container.firstElementChild).toHaveClass('text-danger');
    expect(container.firstElementChild).not.toHaveClass('text-success');
  });

  it('exposes a passed testId as data-testid so one row can be asserted directly', () => {
    render(<PnlPercent value="-1" testId="realised-percent" />);
    expect(screen.getByTestId('realised-percent')).toHaveTextContent('-1.00%');
  });

  it('collapses a loss that rounds to zero into 0.00% while keeping the loss colour', () => {
    // A `-0.00%` reads as a rendering glitch rather than a loss, but the row really did lose money, so the colour must survive the sign being dropped.
    const el = renderPercent('-0.001');
    expect(el.textContent).toBe('0.00%');
    expect(el).toHaveClass('text-danger');
  });
});

describe('UnavailablePnl', () => {
  it('announces the description in place of the glyph rather than alongside it', () => {
    render(<UnavailablePnl testId="marker" glyph="n/a" description="P/L unavailable" />);
    // Queried by role, not by testid: "in place of" is a property of `role="img"`, whose children ARIA treats as presentational. The name computation this suite runs does not implement that pruning, so a testid lookup plus `toHaveAccessibleName` would pass just as happily on a bare labelled span and leave the role — the whole mechanism — unpinned. This is the ONLY assertion in the repo that pins the role: every archive-panel and e2e check resolves the marker by testid and reads its name, which `aria-label` alone satisfies. Do not retarget it to a testid.
    const el = screen.getByRole('img', { name: 'P/L unavailable' });
    expect(el).toHaveAttribute('data-testid', 'marker');
    expect(el.textContent).toBe('n/a');
  });

  it('distinguishes the two faults in the VISIBLE mark, not only in the accessible name', () => {
    // The archive's un-costed and incomplete-fee rows sit in the same column, and a sighted operator on a phone can reach neither the accessible name nor a tooltip. If both faults rendered the same characters, the difference between unrecoverable history and a Reconcile-fees-away retry would be invisible to the reader most likely to be looking. Driven through the real helper so the component and the wording cannot drift apart.
    const { rerender } = render(
      <UnavailablePnl
        testId="marker"
        glyph={unavailablePnlGlyph('fees')}
        description="Net P/L unavailable"
      />,
    );
    expect(screen.getByTestId('marker').textContent).toBe('net n/a');

    rerender(
      <UnavailablePnl
        testId="marker"
        glyph={unavailablePnlGlyph('cost-basis')}
        description="P/L unavailable"
      />,
    );
    expect(screen.getByTestId('marker').textContent).toBe('n/a');
  });

  it('never renders the em dash, which already means "empty" on the cells beside it', () => {
    // `PnlValue value={null}` and the archive's percent cell both render `—` for "there is nothing here". One mark cannot also mean "a number exists but nobody could work it out", so the two must stay visually distinct.
    render(<PnlValue value={null} testId="empty" />);
    expect(screen.getByTestId('empty')).toHaveTextContent('—');

    for (const reason of ['cost-basis', 'fees'] as const) {
      const { unmount } = render(
        <UnavailablePnl
          testId="marker"
          glyph={unavailablePnlGlyph(reason)}
          description="P/L unavailable"
        />,
      );
      expect(screen.getByTestId('marker').textContent).not.toContain('—');
      unmount();
    }
  });
});
