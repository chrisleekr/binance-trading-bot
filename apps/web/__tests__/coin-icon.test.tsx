// CoinIcon — bundled SVG for a mapped asset, neutral monogram chip otherwise.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CoinIcon } from '../src/features/profile/components/coin-icon.js';

describe('CoinIcon', () => {
  it('renders a bundled SVG image for a mapped asset', () => {
    render(<CoinIcon asset="ETH" />);
    const el = screen.getByTestId('coin-icon-ETH');
    expect(el.tagName).toBe('IMG');
    expect(el).toHaveAttribute('src');
  });

  it('renders a monogram chip for an unmapped asset (ENA is not in the icon pack)', () => {
    render(<CoinIcon asset="ENA" />);
    const el = screen.getByTestId('coin-icon-ENA');
    expect(el.tagName).toBe('SPAN');
    expect(el).toHaveTextContent('EN');
  });
});
