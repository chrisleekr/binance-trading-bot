// PnlValue — the shared signed/coloured PnL readout.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PnlValue } from '../src/shared/components/pnl-value.js';

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
